"""Chunk the downloaded full text (fulltext.jsonl from fetch_fulltext.py) and load it into D1 and Vectorize next to
the abstract chunks.

Chunks follow the same rules as the abstracts (harvest_and_chunk.py): the article title, then up to 450 estimated
tokens, with paragraphs packed together and long ones split into sentence windows. Each chunk is labeled
"<SECTION> (full text)" and numbered from idx 100 (chunk_id <pmid>-100, -101, ...) so it never collides with the
abstract chunks (idx 0, 1, ...).

Pipeline: harvest_and_chunk.py and load_cloudflare.py first (abstracts), then fetch_fulltext.py (download), then this
script's three steps in order. Progress is kept in separate fulltext_* files, so the abstract load is not affected.

  chunk    writes <data>/fulltext_chunks.jsonl and prints a token report
  d1       loads those chunks into D1 (the FTS triggers index them for keyword search)
  vectors  embeds them through the loader Worker (scripts/vector_loader, `npx wrangler dev`) into Vectorize

Usage (from the repo root): python scripts/load_fulltext.py chunk|d1|vectors --data <Drive>/Project/data/pubmed
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harvest_and_chunk as h
import load_cloudflare as lc

FIRST_IDX = 100
# Some open-access full texts are not in English (the abstract usually is). The answers are in English, so those
# articles keep only their abstract. English text is about 20-30% these words; French or Spanish is under 5%.
ENGLISH_WORDS = set('the and of to in with was were for that is are by on as from this at be or'.split())
MIN_ENGLISH_SHARE = 0.12


def is_english(text):
    """True if common English words make up at least MIN_ENGLISH_SHARE of the text (a cheap language check)."""
    words = text.lower().split()
    return bool(words) and sum(w in ENGLISH_WORDS for w in words) / len(words) >= MIN_ENGLISH_SHARE


def chunk(data):
    """Turn fulltext.jsonl into fulltext_chunks.jsonl and print a token report.

    Takes the title, year and U.S. flag from articles.jsonl, so only articles already in the collection are chunked.
    Only the first 5,000 characters are checked for English, which is enough and keeps it fast.
    """
    articles = {}
    with open(os.path.join(data, 'articles.jsonl')) as f:
        for line in f:
            a = json.loads(line)
            articles[a['pmid']] = a
    sizes, n_articles, not_english = [], 0, 0
    with open(os.path.join(data, 'fulltext.jsonl')) as f, \
         open(os.path.join(data, 'fulltext_chunks.jsonl'), 'w') as out:
        for line in f:
            ft = json.loads(line)
            a = articles.get(ft['pmid'])
            if not a:
                continue
            if not is_english(' '.join(sec['text'] for sec in ft['sections'])[:5000]):
                not_english += 1
                continue
            n_articles += 1
            budget = h.MAX_TOKENS - h.n_tokens(a['title'])          # the title is prepended to every chunk
            idx = FIRST_IDX
            for sec in ft['sections']:
                for text in pack(sec['text'].split('\n'), budget):
                    t = a['title'] + '\n' + text
                    c = {'chunk_id': f"{a['pmid']}-{idx}", 'pmid': a['pmid'], 'idx': idx,
                         'section': f"{sec['section']} (full text)", 'text': t, 'token_count': h.n_tokens(t),
                         'pub_year': a['pub_year'], 'us_affiliation': a['us_affiliation']}
                    out.write(json.dumps(c) + '\n')
                    sizes.append(c['token_count'])
                    idx += 1
    print(f'{not_english} articles skipped as not English')
    print(f'{n_articles} articles -> {len(sizes)} full-text chunks '
          f'({len(sizes) / max(1, n_articles):.1f} per article), {sum(s > h.HARD_LIMIT for s in sizes)} over '
          f'{h.HARD_LIMIT} est. tokens, {sum(sizes) / 1e6:.1f}M est. tokens to embed')
    print('\n'.join(h.histogram(sizes, [100, 200, 300, 400, 450, 512])))


def pack(paragraphs, budget):
    """Join whole paragraphs up to the budget; split a paragraph that is too long on its own into sentence windows."""
    out, cur = [], []
    for p in paragraphs:
        if h.n_tokens(p) > budget:
            if cur:
                out.append(' '.join(cur)); cur = []
            out.extend(h.sentence_windows(p, min(h.WINDOW_TOKENS, budget)))
        elif cur and h.n_tokens(' '.join(cur + [p])) > budget:
            out.append(' '.join(cur)); cur = [p]
        else:
            cur.append(p)
    if cur:
        out.append(' '.join(cur))
    # Text with no sentence breaks (lists, run-together tables) can still be too long: cut it by words.
    fixed = []
    for piece in out:
        if h.n_tokens(piece) <= budget:
            fixed.append(piece)
            continue
        words, cur = piece.split(), []
        for w in words:
            if cur and h.n_tokens(' '.join(cur + [w])) > budget:
                fixed.append(' '.join(cur)); cur = []
            cur.append(w)
        if cur:
            fixed.append(' '.join(cur))
    return fixed


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['chunk', 'd1', 'vectors'])
    ap.add_argument('--data', required=True)
    args = ap.parse_args()
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if args.step == 'chunk':
        chunk(args.data)
    else:
        # Reuse the abstract loaders, pointed at the full-text chunks (their own SQL folder and progress files).
        lc.CHUNKS_FILE, lc.ARTICLES_FILE = 'fulltext_chunks.jsonl', None
        lc.SQL_DIR, lc.PROGRESS_PREFIX = 'd1_sql_fulltext', 'fulltext_'
        lc.d1(args.data, repo) if args.step == 'd1' else lc.vectors(args.data)
