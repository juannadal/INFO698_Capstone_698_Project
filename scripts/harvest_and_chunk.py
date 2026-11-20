"""Harvest the aging & lifestyle PubMed collection and split it into passages for D1 and Vectorize.

This is the first step of the data pipeline: harvest -> chunk (this script) -> load into Cloudflare D1 and
Vectorize (load_cloudflare.py). fetch_fulltext.py later reads the raw XML saved here to find PubMed Central IDs.

Follows Steps 1-2 of the PubMed RAG Pipeline Plan:
  harvest  ESearch one month at a time (each slice stays under the 10,000-ID cap), then EFetch
           XML in batches of 200 PMIDs, saved raw so chunking can be re-run without re-fetching.
  chunk    parse the raw XML into articles.jsonl and chunks.jsonl, plus a token-length report.

Chunking rules:
  - one chunk per article: title + "\\n" + abstract, when it fits in MAX_TOKENS (450)
  - longer structured abstracts: adjacent labelled sections (BACKGROUND, METHODS, ...) are packed
    into chunks of up to MAX_TOKENS, title prepended to each
  - a section (or unstructured abstract) still too long: sentence windows of ~WINDOW_TOKENS (300)
    with OVERLAP_SENTENCES (1) of overlap
  - nothing may exceed the embedding model's 512-token input (bge-base-en-v1.5)

Token counts are an estimate of the BERT WordPiece count (words and punctuation x 1.3), since
the real tokenizer is not installed. The report shows how many chunks land near the limit.

Outputs (in --out): raw/<YYYY-MM>.xml.gz and harvest_log.json from harvest; articles.jsonl (one article per line),
chunks.jsonl (one passage per line) and chunk_report.txt from chunk.

Usage:
  export NCBI_API_KEY=...  NCBI_EMAIL=you@example.com
  python harvest_and_chunk.py harvest --out data/pubmed
  python harvest_and_chunk.py chunk   --out data/pubmed
  python harvest_and_chunk.py harvest --out data/pubmed_expansion --query expansion   # the 2026-10-11 expansion
"""
import argparse, glob, gzip, json, os, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from datetime import date

AGE = '("Middle Aged"[MeSH] OR "Aged"[MeSH])'
LIFESTYLE = ('("Healthy Lifestyle"[MeSH] OR "Life Style"[MeSH] OR "Exercise"[MeSH] OR "Diet"[MeSH] '
             'OR "Sleep"[MeSH])')
# Added 2026-10-11 (Juan): internal and family medicine journals, and common chronic conditions of adults 40+.
PRIMARY_CARE_JOURNALS = (
    '("JAMA internal medicine"[ta] OR "Annals of internal medicine"[ta] OR "J Gen Intern Med"[ta] OR "Am J Med"[ta] '
    'OR "Arch Intern Med"[ta] OR "Intern Med J"[ta] OR "Eur J Intern Med"[ta] OR "Intern Med"[ta] '
    'OR "Am Fam Physician"[ta] OR "Ann Fam Med"[ta] OR "Br J Gen Pract"[ta] OR "Fam Pract"[ta] '
    'OR "J Am Board Fam Med"[ta] OR "BMC Prim Care"[ta] OR "BMC Fam Pract"[ta] OR "Can Fam Physician"[ta] '
    'OR "Scand J Prim Health Care"[ta] OR "J Fam Pract"[ta])')
CHRONIC_CONDITIONS = (
    '("Diabetes Mellitus, Type 2"[MeSH] OR "Hypertension"[MeSH] OR "Coronary Disease"[MeSH] '
    'OR "Pulmonary Disease, Chronic Obstructive"[MeSH] OR "Osteoarthritis"[MeSH] OR "Depression"[MeSH] '
    'OR "Obesity"[MeSH])')
QUERIES = {
    # The original collection (data/pubmed).
    'lifestyle': f'{AGE} AND {LIFESTYLE} AND hasabstract',
    # The expansion (data/pubmed_expansion): anything already in the lifestyle collection is left out.
    'expansion': f'{AGE} AND ({PRIMARY_CARE_JOURNALS} OR {CHRONIC_CONDITIONS}) NOT {LIFESTYLE} AND hasabstract',
}
QUERY = QUERIES['lifestyle']                   # replaced by --query at run time
FIRST_YEAR, LAST_YEAR = 2016, 2026
EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/'
BATCH = 200                 # PMIDs per EFetch request
ESEARCH_CAP = 9999          # ESearch returns at most 10,000 IDs per query, hence the monthly slices

MAX_TOKENS = 450          # split above this
HARD_LIMIT = 512          # bge-base-en-v1.5 input window
WINDOW_TOKENS = 300
OVERLAP_SENTENCES = 1

# Retracted papers and errata should never be cited in an answer.
DROP_TYPES = {'Retracted Publication', 'Retraction of Publication', 'Published Erratum'}
# A U.S. author affiliation: "USA"/"United States", or "City, ST 12345" with a U.S. state code and ZIP code.
US_RE = re.compile(r'\b(USA|U\.S\.A\.|United States)\b|\b[A-Z][a-z]+,\s*(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[DLNA]|'
                   r'K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]|DC)\s+\d{5}\b')


# ---------- harvest ----------

def eutils(endpoint, params, delay):
    """POST one NCBI E-utilities request and return the raw response bytes.

    Waits `delay` seconds first to stay under NCBI's rate limit, and retries up to 5 times with growing pauses,
    since long harvests always hit a few network errors or 429/5xx replies.
    """
    params = dict(params, tool='info698-harvest', email=os.environ.get('NCBI_EMAIL', ''))
    if os.environ.get('NCBI_API_KEY'):
        params['api_key'] = os.environ['NCBI_API_KEY']
    body = urllib.parse.urlencode(params).encode()
    for attempt in range(5):
        time.sleep(delay)
        try:
            with urllib.request.urlopen(EUTILS + endpoint, data=body, timeout=60) as r:
                return r.read()
        except Exception as e:                       # network errors, 429, 5xx
            wait = 2 ** attempt
            print(f'  {endpoint} failed ({e}); retrying in {wait}s', file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f'{endpoint} failed 5 times')


def months():
    """Yield (year, month) for every month from FIRST_YEAR to today: the slices that keep each search under the cap."""
    today = date.today()
    for y in range(FIRST_YEAR, LAST_YEAR + 1):
        for m in range(1, 13):
            if date(y, m, 1) <= today:
                yield y, m


def harvest(out):
    """Download every article matching QUERY into <out>/raw, one gzipped XML file per publication month.

    Resumable: months whose file already exists are not fetched again (the file is written to .tmp and renamed only
    when complete). Writes harvest_log.json with the per-month counts and any batches that failed.
    """
    raw = os.path.join(out, 'raw')
    os.makedirs(raw, exist_ok=True)
    delay = 0.11 if os.environ.get('NCBI_API_KEY') else 0.34     # 10/s with a key, 3/s without
    log, total, failed = [], 0, []
    for y, m in months():
        path = os.path.join(raw, f'{y}-{m:02d}.xml.gz')
        term = f'{QUERY} AND {y}/{m:02d}[dp]'
        res = json.loads(eutils('esearch.fcgi', {'db': 'pubmed', 'term': term, 'retmax': ESEARCH_CAP + 1,
                                                 'retmode': 'json'}, delay))['esearchresult']
        ids, count = res['idlist'], int(res['count'])
        total += count
        log.append({'slice': f'{y}-{m:02d}', 'count': count})
        if count > ESEARCH_CAP:
            print(f'WARNING {y}-{m:02d}: {count} hits exceeds the ESearch cap; slice is incomplete',
                  file=sys.stderr)
        if os.path.exists(path):
            print(f'{y}-{m:02d}: {count} hits, already fetched')
            continue
        print(f'{y}-{m:02d}: {count} hits')
        parts, month_failed = [], 0
        for i in range(0, len(ids), BATCH):
            try:
                xml = eutils('efetch.fcgi', {'db': 'pubmed', 'id': ','.join(ids[i:i + BATCH]),
                                             'retmode': 'xml'}, delay)
                parts.append(xml.decode())
            except RuntimeError:
                failed.append({'slice': f'{y}-{m:02d}', 'ids': ids[i:i + BATCH]})
                month_failed += 1
        # A month with failed batches is not saved, so a re-run fetches the whole month again instead of
        # skipping it with articles missing.
        if month_failed:
            print(f'WARNING {y}-{m:02d}: {month_failed} batches failed; not saved, re-run to retry', file=sys.stderr)
            continue
        # one file per month: concatenated PubmedArticleSet documents
        with gzip.open(path + '.tmp', 'wt', encoding='utf-8') as f:
            f.write('\n<!--BATCH-->\n'.join(parts))
        os.replace(path + '.tmp', path)
    # articles dated by year only may miss the monthly slices, so compare with one full-range count
    full = int(json.loads(eutils('esearch.fcgi', {'db': 'pubmed', 'retmax': 0, 'retmode': 'json',
        'term': f'{QUERY} AND {FIRST_YEAR}:{LAST_YEAR}[dp]'}, delay))['esearchresult']['count'])
    with open(os.path.join(out, 'harvest_log.json'), 'w') as f:
        json.dump({'query': QUERY, 'years': [FIRST_YEAR, LAST_YEAR], 'run_date': date.today().isoformat(),
                   'full_range_count': full, 'sum_of_slices': total, 'slices': log,
                   'failed_batches': failed}, f, indent=1)
    print(f'full-range count {full}, sum of monthly slices {total}; '
          f'{len(failed)} failed batches logged in harvest_log.json')
    if total < full * 0.99:
        print('WARNING: monthly slices miss more than 1% of the collection', file=sys.stderr)


# ---------- parse ----------

def text_of(el):
    """All text inside an XML element (including nested tags like <i>), with whitespace collapsed; '' if missing."""
    return re.sub(r'\s+', ' ', ''.join(el.itertext())).strip() if el is not None else ''


def pub_date(art):
    """Return (date string such as '2021 Mar 4', year as int or None) from an article's journal issue date.

    Some articles only have a free-text MedlineDate (e.g. '2020 Jan-Feb'), so the year is taken from its first
    4 digits.
    """
    d = art.find('.//Journal/JournalIssue/PubDate')
    if d is None:
        return '', None
    y = d.findtext('Year') or (re.findall(r'\d{4}', d.findtext('MedlineDate') or '') or [''])[0]
    return ' '.join(filter(None, [y, d.findtext('Month'), d.findtext('Day')])), int(y) if y else None


def parse_article(pa):
    """Turn one <PubmedArticle> element into the article dict saved in articles.jsonl.

    Abstract sections keep their label (BACKGROUND, METHODS, ...) for chunking. us_affiliation and us_mesh are the
    two U.S.-relevance signals used in ranking.
    """
    mc = pa.find('MedlineCitation')
    art = mc.find('Article')
    sections = []
    for at in art.findall('Abstract/AbstractText'):
        t = text_of(at)
        if t:
            sections.append({'label': (at.get('NlmCategory') or at.get('Label') or '').upper(), 'text': t})
    pub_types = [text_of(p) for p in art.findall('PublicationTypeList/PublicationType')]
    mesh = [text_of(h.find('DescriptorName')) for h in mc.findall('MeshHeadingList/MeshHeading')]
    affs = sorted({text_of(a) for a in art.findall('.//AffiliationInfo/Affiliation')})
    date_str, year = pub_date(art)
    return {
        'pmid': mc.findtext('PMID'),
        'title': text_of(art.find('ArticleTitle')),
        'abstract_sections': sections,
        'journal': text_of(art.find('Journal/Title')),
        'pub_date': date_str,
        'pub_year': year,
        'pub_types': pub_types,
        'mesh': mesh,
        'affiliations': affs,
        'us_affiliation': any(US_RE.search(a) for a in affs),
        'us_mesh': 'United States' in mesh,
    }


def read_raw(raw_dir):
    """Yield every <PubmedArticle> element from the raw monthly files.

    Each file holds several EFetch responses joined by <!--BATCH-->; each is parsed on its own after removing its
    XML declaration and DOCTYPE, which ElementTree would reject in the middle of a file.
    """
    for path in sorted(glob.glob(os.path.join(raw_dir, '*.xml*'))):
        opener = gzip.open if path.endswith('.gz') else open
        with opener(path, 'rt', encoding='utf-8') as f:
            for doc in f.read().split('<!--BATCH-->'):
                doc = re.sub(r'<\?xml[^>]*\?>|<!DOCTYPE[^>]*>', '', doc).strip()
                if doc:
                    yield from ET.fromstring(doc).iter('PubmedArticle')


# ---------- chunk ----------

TOKEN_RE = re.compile(r'\w+|[^\w\s]')                      # words and single punctuation marks
SENT_RE = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9(\[])')     # sentence break: end mark, space, capital/digit/bracket


def n_tokens(s):
    """Estimate the bge-base-en-v1.5 token count of a string (the real WordPiece tokenizer is not installed)."""
    return int(len(TOKEN_RE.findall(s)) * 1.3) + 2          # +2 for [CLS]/[SEP]


def sentence_windows(text, budget):
    """Split text into windows of whole sentences, each at most `budget` estimated tokens.

    Each window starts with the last OVERLAP_SENTENCES sentence(s) of the previous one, so a finding split across a
    boundary still has its context. A single sentence longer than the budget becomes its own (oversized) window.
    """
    sents = SENT_RE.split(text)
    out, cur = [], []
    for s in sents:
        if cur and n_tokens(' '.join(cur + [s])) > budget:
            out.append(' '.join(cur))
            cur = cur[-OVERLAP_SENTENCES:] if OVERLAP_SENTENCES else []
            if n_tokens(' '.join(cur + [s])) > budget:      # overlap alone would overflow
                cur = []
        cur.append(s)
    if cur:
        out.append(' '.join(cur))
    return out


def chunk_article(a):
    """Split one article into chunk dicts for chunks.jsonl, following the rules in the module docstring.

    Every chunk starts with the title, so a passage found on its own still says what study it comes from, and stays
    under the 512-token embedding limit. chunk_id is '<pmid>-<idx>' (idx 0, 1, ...); 'section' records where the
    text came from (FULL for a whole abstract, labels joined by '+' for packed sections, WINDOW for sentence windows).
    """
    title = a['title']
    secs = a['abstract_sections']
    # sections as text, each prefixed with its label ("METHODS: ...")
    body = lambda ss: ' '.join((f"{s['label']}: " if s['label'] else '') + s['text'] for s in ss)
    whole = title + '\n' + body(secs)
    if n_tokens(whole) <= MAX_TOKENS:
        pieces = [('FULL', body(secs))]
    else:
        budget = MAX_TOKENS - n_tokens(title)
        pieces, group = [], []
        for s in secs:
            if s['label'] and n_tokens(body([s])) <= budget:
                if group and n_tokens(body(group + [s])) > budget:
                    pieces.append(('+'.join(g['label'] for g in group), body(group)))
                    group = []
                group.append(s)
            else:                                         # unlabelled or too long on its own
                if group:
                    pieces.append(('+'.join(g['label'] for g in group), body(group)))
                    group = []
                wb = min(WINDOW_TOKENS, budget)
                for w in sentence_windows(body([s]), wb):
                    pieces.append((s['label'] or 'WINDOW', w))
        if group:
            pieces.append(('+'.join(g['label'] for g in group), body(group)))
    chunks = []
    for i, (section, text) in enumerate(pieces):
        t = title + '\n' + text
        chunks.append({'chunk_id': f"{a['pmid']}-{i}", 'pmid': a['pmid'], 'idx': i, 'section': section,
                       'text': t, 'token_count': n_tokens(t),
                       'pub_year': a['pub_year'], 'us_affiliation': a['us_affiliation']})
    return chunks


def histogram(values, edges):
    """Text histogram lines (range, count, bar of #) for the token report; the last bin is open-ended."""
    rows, lo = [], 0
    for hi in edges + [10 ** 9]:
        n = sum(lo <= v < hi for v in values)
        label = f'{lo}-{hi - 1}' if hi < 10 ** 9 else f'{lo}+'
        rows.append(f'  {label:>9}  {n:7d}  {"#" * round(50 * n / max(1, len(values)))}')
        lo = hi
    return rows


def chunk(out, raw_dir=None):
    """Parse the raw XML into articles.jsonl and chunks.jsonl, and write chunk_report.txt.

    Drops duplicates (an article can appear in two monthly slices), retractions and errata, and articles without an
    abstract. Needs no network, so it can be re-run with new chunking rules without harvesting again.
    """
    raw_dir = raw_dir or os.path.join(out, 'raw')
    seen, dropped, articles, chunks = set(), {'retracted/erratum': 0, 'no abstract': 0, 'duplicate': 0}, 0, []
    with open(os.path.join(out, 'articles.jsonl'), 'w') as fa, \
         open(os.path.join(out, 'chunks.jsonl'), 'w') as fc:
        for pa in read_raw(raw_dir):
            a = parse_article(pa)
            if a['pmid'] in seen:
                dropped['duplicate'] += 1; continue
            seen.add(a['pmid'])
            if DROP_TYPES & set(a['pub_types']):
                dropped['retracted/erratum'] += 1; continue
            if not a['abstract_sections']:
                dropped['no abstract'] += 1; continue
            a['abstract_tokens'] = n_tokens(a['title'] + '\n' + ' '.join(s['text'] for s in a['abstract_sections']))
            fa.write(json.dumps(a) + '\n')
            articles += 1
            for c in chunk_article(a):
                fc.write(json.dumps(c) + '\n')
                chunks.append((c['token_count'], a['abstract_tokens']))
    sizes = [c[0] for c in chunks]
    art_sizes = []
    with open(os.path.join(out, 'articles.jsonl')) as f:
        art_sizes = [json.loads(l)['abstract_tokens'] for l in f]
    over = sum(s > HARD_LIMIT for s in sizes)
    split = sum(s > MAX_TOKENS for s in art_sizes)
    report = [
        f'articles kept: {articles}   dropped: {dropped}',
        f'chunks: {len(sizes)}  ({len(sizes) / max(1, articles):.3f} per article)',
        f'articles split (title+abstract > {MAX_TOKENS} est. tokens): {split} ({100 * split / max(1, articles):.1f}%)',
        f'chunks over {HARD_LIMIT} est. tokens: {over}',
        '', 'title+abstract est. tokens per article:', *histogram(art_sizes, [100, 200, 300, 400, 450, 512, 700, 1000]),
        '', 'est. tokens per chunk:', *histogram(sizes, [100, 200, 300, 400, 450, 512]),
    ]
    with open(os.path.join(out, 'chunk_report.txt'), 'w') as f:
        f.write('\n'.join(report) + '\n')
    print('\n'.join(report))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['harvest', 'chunk'])
    ap.add_argument('--out', default='data/pubmed')
    ap.add_argument('--raw', help='chunk: read XML from this folder instead of OUT/raw')
    ap.add_argument('--query', choices=sorted(QUERIES), default='lifestyle', help='harvest: which collection')
    args = ap.parse_args()
    QUERY = QUERIES[args.query]
    os.makedirs(args.out, exist_ok=True)
    harvest(args.out) if args.step == 'harvest' else chunk(args.out, args.raw)
