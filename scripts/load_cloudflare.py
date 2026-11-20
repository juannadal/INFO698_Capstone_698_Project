"""Load the harvested collection into Cloudflare: articles and chunks into D1, chunk embeddings into Vectorize.

This is the second step of the data pipeline, after harvest_and_chunk.py. D1 holds the article details and the
passage text (with FTS5 keyword search); Vectorize holds one embedding per passage for meaning-based search. The
Worker's /api/ask uses both. load_fulltext.py reuses this script for the full-text passages.

Input is the output of harvest_and_chunk.py (articles.jsonl, chunks.jsonl). Both steps can be stopped and re-run;
they skip work recorded in the progress file (d1_progress.txt, vectors_progress.txt) and the inserts are idempotent.

  d1       writes INSERT OR IGNORE batches to <data>/d1_sql/ and runs each with `wrangler d1 execute --remote`.
           The chunks_fts table is filled by the triggers in the D1 schema.
  vectors  posts chunks in batches of 500 to the loader Worker (scripts/vector_loader, run with `npx wrangler dev`),
           which embeds them with bge-base-en-v1.5 and upserts them into the pubmed-chunks index.

Usage (from the repo root):
  python scripts/load_cloudflare.py d1      --data <Drive>/Project/data/pubmed
  (cd scripts/vector_loader && npx wrangler dev --port 8790)      # in another terminal
  python scripts/load_cloudflare.py vectors --data <Drive>/Project/data/pubmed
"""
import argparse, json, os, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

DB = 'pubmed-index'
ROWS_PER_FILE = 5000        # INSERTs per SQL file, small enough for one `wrangler d1 execute` call
EMBED_BATCH = 500           # chunks per request to the loader Worker
LOADER_URL = 'http://127.0.0.1:8790/embed'   # the loader Worker: cd scripts/vector_loader && npx wrangler dev --port 8790
WORKERS = 2                 # batches sent to the loader Worker at the same time
# Inputs and bookkeeping, relative to --data. load_fulltext.py points these at the full-text chunks.
ARTICLES_FILE = 'articles.jsonl'     # None to load chunks only
CHUNKS_FILE = 'chunks.jsonl'
SQL_DIR = 'd1_sql'
PROGRESS_PREFIX = ''


def sql_str(v):
    """Write a Python value as a SQL literal: NULL, 1/0 for booleans, numbers as-is, text quoted with ' doubled."""
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return '1' if v else '0'
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def article_row(a):
    """One INSERT OR IGNORE statement for an article; list fields (types, MeSH, affiliations) are stored as JSON."""
    cols = ['pmid', 'title', 'journal', 'pub_date', 'pub_year', 'pub_types', 'mesh', 'affiliations',
            'us_affiliation', 'us_mesh', 'abstract_tokens']
    vals = [a['pmid'], a['title'], a['journal'], a['pub_date'], a['pub_year'], json.dumps(a['pub_types']),
            json.dumps(a['mesh']), json.dumps(a['affiliations']), a['us_affiliation'], a['us_mesh'],
            a['abstract_tokens']]
    return f"INSERT OR IGNORE INTO articles ({','.join(cols)}) VALUES ({','.join(map(sql_str, vals))});"


def chunk_row(c):
    """One INSERT OR IGNORE statement for a chunk (passage) row."""
    vals = [c['chunk_id'], c['pmid'], c['idx'], c['section'], c['text'], c['token_count']]
    return ("INSERT OR IGNORE INTO chunks (chunk_id,pmid,idx,section,text,token_count) "
            f"VALUES ({','.join(map(sql_str, vals))});")


def load_progress(path):
    """The set of finished items (one per line) in a progress file, or an empty set if it does not exist yet."""
    return set(open(path).read().split()) if os.path.exists(path) else set()


def d1(data, repo):
    """Load articles and chunks into D1 by writing SQL files and running each with wrangler.

    Each SQL file is run against the remote database with `wrangler d1 execute --file`. Each finished file is
    recorded in the progress file, so a stopped run picks up where it left off. Failed files are retried 4 times.
    """
    out = os.path.join(data, SQL_DIR)
    os.makedirs(out, exist_ok=True)
    progress = os.path.join(data, PROGRESS_PREFIX + 'd1_progress.txt')
    done = load_progress(progress)
    # articles first, so every chunk's pmid exists
    files = []
    inputs = [('articles', ARTICLES_FILE, article_row), ('chunks', CHUNKS_FILE, chunk_row)]
    for name, filename, to_sql in inputs:
        if not filename:
            continue
        with open(os.path.join(data, filename)) as f:
            batch, n = [], 0
            for line in f:
                batch.append(to_sql(json.loads(line)))
                if len(batch) == ROWS_PER_FILE:
                    files.append(write_batch(out, name, n, batch)); batch, n = [], n + 1
            if batch:
                files.append(write_batch(out, name, n, batch))
    for i, path in enumerate(files, 1):
        key = os.path.basename(path)
        if key in done:
            continue
        print(f'[{i}/{len(files)}] {key}', flush=True)
        for attempt in range(4):
            r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--yes', f'--file={path}'],
                               cwd=repo, capture_output=True, text=True)
            if r.returncode == 0:
                break
            print(f'  failed (attempt {attempt + 1}): {(r.stderr or r.stdout)[-400:]}', file=sys.stderr)
            time.sleep(5 * 2 ** attempt)
        else:
            sys.exit(f'giving up on {key}; re-run to continue')
        with open(progress, 'a') as f:
            f.write(key + '\n')


def write_batch(out, name, n, rows):
    """Write one SQL file (e.g. chunks_007.sql) and return its path.

    Always rewritten from the current JSONL, so re-chunked data never loads stale SQL from an earlier run.
    Which files were already loaded is tracked separately, in the progress file.
    """
    path = os.path.join(out, f'{name}_{n:03d}.sql')
    with open(path + '.tmp', 'w') as f:
        f.write('\n'.join(rows) + '\n')
    os.replace(path + '.tmp', path)
    return path


def post(batch):
    """Send one batch of chunks to the loader Worker and return how many vectors it upserted.

    Retries up to 8 times with pauses up to a minute, since Workers AI and Vectorize sometimes reject or time out.
    """
    body = json.dumps(batch).encode()
    for attempt in range(8):
        try:
            req = urllib.request.Request(LOADER_URL, data=body, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())['upserted']
        except Exception as e:
            print(f'  batch {batch[0]["chunk_id"]} failed ({e}); retrying', file=sys.stderr)
            time.sleep(min(60, 3 * 2 ** attempt))
    raise RuntimeError(f'batch starting {batch[0]["chunk_id"]} failed 8 times')


def vectors(data):
    """Embed every chunk and upsert it into Vectorize through the loader Worker, WORKERS batches at a time.

    Only the fields Vectorize needs are sent: the text to embed, plus pmid, pub_year and us_affiliation as metadata
    for filtering and ranking. A batch is recorded (by its first chunk_id) in the progress file once it succeeds.
    """
    progress = os.path.join(data, PROGRESS_PREFIX + 'vectors_progress.txt')
    done = load_progress(progress)
    batches, batch = [], []
    with open(os.path.join(data, CHUNKS_FILE)) as f:
        for line in f:
            c = json.loads(line)
            batch.append({k: c[k] for k in ('chunk_id', 'pmid', 'text', 'pub_year', 'us_affiliation')})
            if len(batch) == EMBED_BATCH:
                batches.append(batch); batch = []
    if batch:
        batches.append(batch)
    todo = [b for b in batches if b[0]['chunk_id'] not in done]
    print(f'{len(batches)} batches, {len(todo)} to do', flush=True)
    total, start = 0, time.time()
    with ThreadPoolExecutor(WORKERS) as pool, open(progress, 'a') as log:
        for i, (b, n) in enumerate(zip(todo, pool.map(post, todo)), 1):
            log.write(b[0]['chunk_id'] + '\n'); log.flush()
            total += n
            if i % 50 == 0 or i == len(todo):
                rate = total / (time.time() - start)
                print(f'{i}/{len(todo)} batches, {total} vectors, {rate:.0f}/s', flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['d1', 'vectors'])
    ap.add_argument('--data', required=True, help='folder with articles.jsonl and chunks.jsonl')
    args = ap.parse_args()
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))      # wrangler runs from the repo root
    d1(args.data, repo) if args.step == 'd1' else vectors(args.data)
