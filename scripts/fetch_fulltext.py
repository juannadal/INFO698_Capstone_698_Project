"""Download the full text of the open-access articles in the collection (PubMed Central), keeping only the sections
the answers need: Methods (who was studied, for how long), Results (what was found) and Conclusions.

Introduction and Discussion are skipped on purpose: they mostly describe other studies, and the answer model could
cite those findings to the wrong article. Articles with a custom (non Creative Commons) license are skipped too.

Sources:
  s3    (default) the PMC Open Access dataset on AWS (https://registry.opendata.aws/ncbi-pmc/): JATS XML per article,
        public, no rate limit. Sections are found by their sec-type or title.
  bioc  NCBI's BioC API (https://www.ncbi.nlm.nih.gov/research/bionlp/APIs/BioC-PMC/), at most 3 requests a second.
Resumable: articles already in fulltext.jsonl (or recorded as unavailable) are skipped.

Pipeline: runs after harvest_and_chunk.py (it needs <data>/articles.jsonl and the raw XML in <data>/raw, which holds
each article's PMC ID). Its output is chunked and loaded by load_fulltext.py.

Usage (from the repo root):
  python scripts/fetch_fulltext.py --data <Drive>/Project/data/pubmed [--source s3|bioc]
Writes <data>/fulltext.jsonl: one line per article {pmid, pmc, license, sections: [{section, text}]}.
Articles with no usable full text are listed with the reason in <data>/fulltext_unavailable.txt.
"""
import argparse, glob, json, os, re, subprocess, sys, threading, time, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harvest_and_chunk as h

BIOC = 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/{}/unicode'
# BioC section_type -> the section name we store. Everything else (INTRO, DISCUSS, REF, ...) is dropped.
KEEP = {'METHODS': 'METHODS', 'RESULTS': 'RESULTS', 'CONCL': 'CONCLUSIONS'}
SKIP_LICENSES = {'NO-CC CODE'}
RATE = 3            # requests per second, NCBI's limit without an API key
WORKERS = 8           # requests take ~2 s each, so 8 in flight keep the rate near 3 a second


def pmc_ids(data):
    """Map PMID -> PMC ID for the kept articles that are in PubMed Central (only those can have open full text).

    articles.jsonl does not store the PMC ID, so it is read from the ArticleIdList in the raw harvest XML.
    """
    kept = {json.loads(l)['pmid'] for l in open(os.path.join(data, 'articles.jsonl'))}
    out = {}
    for pa in h.read_raw(os.path.join(data, 'raw')):
        pmid = pa.findtext('MedlineCitation/PMID')
        if pmid in kept and pmid not in out:
            ids = {a.get('IdType'): (a.text or '').strip() for a in pa.findall('PubmedData/ArticleIdList/ArticleId')}
            if ids.get('pmc'):
                out[pmid] = ids['pmc']
    return out


class Throttle:
    """Spaces out requests from several threads so that together they stay under `per_second` (NCBI's limit)."""

    def __init__(self, per_second):
        """Set the minimum gap between requests; `next` is the time the next request slot opens."""
        self.gap, self.next, self.lock = 1 / per_second, 0.0, threading.Lock()

    def wait(self):
        """Reserve the next free time slot and sleep until it starts (the sleep happens outside the lock)."""
        with self.lock:
            now = time.time()
            self.next = max(self.next, now) + self.gap
            delay = self.next - self.gap - now
        if delay > 0:
            time.sleep(delay)


def fetch(pmc, throttle):
    """Get one article from the BioC API: its BioC document, None if it is not open access, or 'error' after 4 tries."""
    for attempt in range(4):
        throttle.wait()
        r = subprocess.run(['curl', '-s', '-m', '60', BIOC.format(pmc)], capture_output=True, text=True)
        body = r.stdout.strip()
        if body.startswith('['):
            try:
                return json.loads(body)[0]['documents'][0]
            except (ValueError, KeyError, IndexError):
                pass
        elif r.returncode == 0 and body and 'No result' in body:
            return None                      # not in the open-access set
        time.sleep(2 ** attempt)
    return 'error'


S3 = 'https://pmc-oa-opendata.s3.amazonaws.com/'
S3_WORKERS = 16
SECTION_BY_TITLE = [('METHODS', re.compile(r'method|material|participant|subject|design|population|setting|procedure', re.I)),
                    ('RESULTS', re.compile(r'result|finding|outcome', re.I)),
                    ('CONCLUSIONS', re.compile(r'conclu', re.I))]
SKIP_TITLE = re.compile(r'discussion|introduction|background', re.I)


def get(url, attempts=4):
    """Download a URL from the S3 bucket; None on 404 (not there), RuntimeError after `attempts` failed tries."""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except Exception:
            pass
        time.sleep(2 ** attempt)
    raise RuntimeError(url)


def fetch_s3(pmc):
    """(license, sections) from the newest version of the article in the AWS bucket; None if it is not there."""
    try:
        listing = get(f'{S3}?list-type=2&prefix={pmc}.')
        if listing is None:
            return None
        versions = sorted({int(v) for v in re.findall(rf'<Key>{pmc}\.(\d+)/', listing.decode())})
        if not versions:
            return None
        base = f'{S3}{pmc}.{versions[-1]}/{pmc}.{versions[-1]}'
        meta = json.loads(get(base + '.json') or b'{}')
        xml = get(base + '.xml')
        if not xml:
            return None
        return meta.get('license_code') or '', jats_sections(xml)
    except Exception:
        return 'error'


def jats_sections(xml):
    """Pull the kept sections (Methods, Results, Conclusions) out of a JATS XML article as [{section, text}].

    Only top-level <sec> elements of the body are classified; their paragraphs (minus tables, figures and boxes) are
    joined with newlines, and neighbouring sections of the same kind are merged.
    """
    root = ET.fromstring(xml)
    body = root.find('.//body')
    out = []
    if body is None:
        return out
    for sec in body.findall('sec'):                          # top-level sections only
        name = classify(sec)
        if not name:
            continue
        parents = {c: parent for parent in sec.iter() for c in parent}   # built once per section
        paras = [re.sub(r'\s+', ' ', ''.join(p.itertext())).strip()
                 for p in sec.iter('p') if not is_in_table_or_figure(p, parents)]
        paras = [p for p in paras if p]
        if paras:
            if out and out[-1]['section'] == name:
                out[-1]['text'] += '\n' + '\n'.join(paras)
            else:
                out.append({'section': name, 'text': '\n'.join(paras)})
    return out


def classify(sec):
    """Return METHODS, RESULTS or CONCLUSIONS for a JATS <sec>, or None to skip it.

    The sec-type attribute is trusted first; many articles lack it, so the section title is matched next.
    Supplementary material is always skipped.
    """
    kind = (sec.get('sec-type') or '').lower()
    title = ''.join(sec.find('title').itertext()) if sec.find('title') is not None else ''
    if 'supplementary' in kind:
        return None
    for name, pattern in SECTION_BY_TITLE:
        if pattern.search(kind):
            return name
    # "Results and discussion" counts as Results; "Discussion and conclusion", Discussion and Introduction are
    # skipped, since they mostly describe other studies.
    if SKIP_TITLE.search(title) and not re.search(r'result', title, re.I):
        return None
    for name, pattern in SECTION_BY_TITLE:
        if pattern.search(title):
            return name
    return None


def is_in_table_or_figure(p, parents):
    """True if paragraph p sits inside a table, figure or text box; those captions read badly as answer passages.

    ElementTree has no parent links, so the caller passes a child -> parent map of the section (built once per
    section, not once per paragraph, which was slow on long sections).
    """
    node = p
    while node in parents:
        node = parents[node]
        if node.tag in ('table-wrap', 'fig', 'boxed-text'):
            return True
    return False


def sections(doc):
    """Paragraphs of the kept sections, joined per section in reading order."""
    out = []
    for p in doc['passages']:
        st, kind = p['infons'].get('section_type', ''), p['infons'].get('type', '')
        if st in KEEP and kind == 'paragraph' and p.get('text', '').strip():
            text = re.sub(r'\s+', ' ', p['text']).strip()
            if out and out[-1]['section'] == KEEP[st]:
                out[-1]['text'] += '\n' + text
            else:
                out.append({'section': KEEP[st], 'text': text})
    return out


def main():
    """Fetch the full text of every article not yet done, in parallel, appending results as they arrive."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', required=True)
    ap.add_argument('--source', choices=['s3', 'bioc'], default='s3')
    args = ap.parse_args()
    out_path = os.path.join(args.data, 'fulltext.jsonl')
    skip_path = os.path.join(args.data, 'fulltext_unavailable.txt')
    done = set()
    for path in (out_path, skip_path):
        if os.path.exists(path):
            # fulltext.jsonl lines are JSON; fulltext_unavailable.txt lines start with the PMID
            done |= {json.loads(l)['pmid'] if l.startswith('{') else l.split()[0] for l in open(path) if l.strip()}

    ids = pmc_ids(args.data)
    todo = [(pmid, pmc) for pmid, pmc in ids.items() if pmid not in done]
    print(f'{len(ids)} articles with a PMC ID, {len(todo)} to fetch', flush=True)
    throttle, lock, counts = Throttle(RATE), threading.Lock(), {'ok': 0, 'none': 0, 'license': 0, 'error': 0}

    def work(item):
        """Fetch one (pmid, pmc) article and append it to fulltext.jsonl or fulltext_unavailable.txt.

        Both sources are turned into the same shape (a BioC-like dict); the S3 one carries ready-made '_sections'.
        File writes and counters are under a lock because several threads run this at once.
        """
        pmid, pmc = item
        if args.source == 's3':
            got = fetch_s3(pmc)
            doc = got if got in (None, 'error') else {'infons': {'license': got[0]}, '_sections': got[1]}
        else:
            doc = fetch(pmc, throttle)
        with lock:
            if doc == 'error':
                counts['error'] += 1             # not recorded, so a re-run tries again
            elif doc is None:
                counts['none'] += 1
                open(skip_path, 'a').write(f'{pmid} not_open_access\n')
            elif doc['infons'].get('license', '') in SKIP_LICENSES:
                counts['license'] += 1
                open(skip_path, 'a').write(f"{pmid} license:{doc['infons'].get('license')}\n")
            else:
                secs = doc['_sections'] if '_sections' in doc else sections(doc)
                if secs:
                    counts['ok'] += 1
                    open(out_path, 'a').write(json.dumps({'pmid': pmid, 'pmc': pmc,
                                                          'license': doc['infons'].get('license', ''),
                                                          'sections': secs}) + '\n')
                else:
                    counts['none'] += 1
                    open(skip_path, 'a').write(f'{pmid} no_kept_sections\n')
            n = sum(counts.values())
            if n % 500 == 0:
                print(f'{n}/{len(todo)} {counts}', flush=True)

    with ThreadPoolExecutor(S3_WORKERS if args.source == 's3' else WORKERS) as pool:
        list(pool.map(work, todo))
    print(f'done {counts}', flush=True)


if __name__ == '__main__':
    main()
