"""Export the questions saved by /api/ask (D1 table query_log) to a CSV file.

Used to review what people actually ask and to turn real questions into the evaluation test set. Questions are only
saved where LOG_QUESTIONS is on (locally by default). Needs wrangler logged in to the Cloudflare account.

Usage (from the repo root):
  python scripts/export_query_log.py                     # writes query_log.csv
  python scripts/export_query_log.py --out my_tests.csv --since 2026-10-04

Columns: id, asked_at (UTC), source (app = a person on the ask page, chat = a person on the chat page, automated = a test run), model (llama or claude: who wrote the answer), level (plain or detailed: the reading level chosen), question, corrected_question
(if spelling was fixed), status (answered / answered_live / no_answer / error;
answered_live = answered from a live PubMed search), pmids (cited sources in order, or the ranked
articles when there was no answer), top_similarity, grade, latency_ms.
"""
import argparse, csv, json, os, subprocess, sys

DB = 'pubmed-index'
COLUMNS = ['id', 'asked_at', 'source', 'model', 'level', 'question', 'corrected_question', 'status', 'pmids', 'top_similarity', 'grade', 'latency_ms']


def main():
    """Query query_log through wrangler (optionally filtered by date and source) and write the rows to a CSV."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default='query_log.csv')
    ap.add_argument('--source', choices=['app', 'chat', 'automated'], help='only questions from people (app: both pages), the chat page (chat) or test runs')
    ap.add_argument('--since', help='only questions asked on or after this date (YYYY-MM-DD)')
    args = ap.parse_args()

    where = ''
    if args.since:
        # checked because the date goes straight into the SQL text
        if not (len(args.since) == 10 and args.since[4] == '-' and args.since[7] == '-'):
            sys.exit('--since must look like 2026-10-04')
        where = f" WHERE asked_at >= '{args.since}'"
    if args.source:
        cond = "source IN ('app', 'chat')" if args.source == 'app' else f"source = '{args.source}'"
        where += (' AND' if where else ' WHERE') + ' ' + cond
    sql = f"SELECT {', '.join(COLUMNS)} FROM query_log{where} ORDER BY id"
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
                       cwd=repo, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(r.stderr or r.stdout)
    rows = json.loads(r.stdout)[0]['results']

    with open(args.out, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for row in rows:
            row['pmids'] = ' '.join(json.loads(row['pmids'] or '[]'))
            w.writerow(row)
    print(f'{len(rows)} questions written to {args.out}')


if __name__ == '__main__':
    main()
