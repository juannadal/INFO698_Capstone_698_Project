"""Build the spelling-correction word list (D1 table vocab) from the chunk text and the system dictionary.

The Worker uses this table to fix misspelled words in a question before searching ("Showing results for ...").
Run it after loading new chunks (harvest_and_chunk.py, load_cloudflare.py) so new medical terms are known. The SQL
files are written to vocab_sql/ in the first --data folder and loaded with `wrangler d1 execute --remote`.

Words from the articles keep their counts; dictionary words not in the articles get freq 0, which marks them as
real words that are never suggested, and corrected only to a very common article word (see worker/src/spelling.js). Needs worker/migrations/0002_spelling.sql applied first.

Usage (from the repo root):
  python scripts/build_vocab.py --data <Drive>/Project/data/pubmed --data <Drive>/Project/data/pubmed_expansion
"""
import argparse, collections, json, os, re, subprocess, sys

DB = 'pubmed-index'
MIN_FREQ = 3            # rarer article words are often typos in the abstracts themselves
ROWS_PER_FILE = 20000
WORD = re.compile(r'[a-z]+')


def main():
    """Count the words in every chunks.jsonl, add the dictionary words, and load them all into the D1 vocab table.

    INSERT OR REPLACE makes re-runs safe. The 'first' letter and 'len' columns let the Worker look up only words
    that could be close to a misspelling.
    """
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data', required=True, action='append', help='a data folder with chunks.jsonl; repeat for more')
    ap.add_argument('--dict', default='/usr/share/dict/words')
    args = ap.parse_args()

    counts = collections.Counter()
    for data in args.data:
        with open(os.path.join(data, 'chunks.jsonl')) as f:
            for line in f:
                counts.update(WORD.findall(json.loads(line)['text'].lower()))
    words = {w: n for w, n in counts.items() if n >= MIN_FREQ and 3 <= len(w) <= 30}
    if os.path.exists(args.dict):
        for w in open(args.dict, encoding='utf-8', errors='ignore'):
            w = w.strip().lower()
            if w.isalpha() and w.isascii() and 3 <= len(w) <= 30:
                words.setdefault(w, 0)
    print(f'{len(words)} words ({sum(1 for n in words.values() if n)} from the articles)', flush=True)

    out = os.path.join(args.data[0], 'vocab_sql')
    os.makedirs(out, exist_ok=True)
    items = sorted(words.items())
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for i in range(0, len(items), ROWS_PER_FILE):
        path = os.path.join(out, f'vocab_{i // ROWS_PER_FILE:03d}.sql')
        with open(path, 'w') as f:
            for w, n in items[i:i + ROWS_PER_FILE]:
                f.write(f"INSERT OR REPLACE INTO vocab (word, freq, first, len) VALUES ('{w}', {n}, '{w[0]}', {len(w)});\n")
        print(f'loading {os.path.basename(path)}', flush=True)
        r = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--yes', f'--file={path}'],
                           cwd=repo, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(r.stderr or r.stdout)


if __name__ == '__main__':
    main()
