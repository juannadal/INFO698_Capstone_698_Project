# Worker: `POST /api/ask`

Serves the React build (`../web/dist`) and answers questions. The bindings in `wrangler.jsonc` point at the real
Cloudflare resources: D1 `pubmed-index`, Vectorize `pubmed-chunks` and Workers AI.

## Run it locally

```
cd worker && npm install             # once: the Anthropic SDK (@anthropic-ai/sdk) for the Claude option
cd worker && npx wrangler dev        # http://127.0.0.1:8787 (uses the real D1, Vectorize and Workers AI)
cd web && npm run dev                # http://localhost:5173, proxies /api to 8787
```

## How an answer is made

0. **Spelling** (`src/spelling.js`): a word that is not common in the article text (D1 table `vocab`, built by
   `scripts/build_vocab.py`) is replaced by the most common article word within 1 or 2 edits, counting edits both on
   the spelling and on how it sounds ("excersize" -> "exercise", "metformn" -> "metformin"). A real English word that
   never appears in the articles is replaced only by a very common article word ("presser" -> "pressure"), and a rare
   article word only by one at least 200 times more common ("excercise" -> "exercise"). Words with an apostrophe
   ("shouldn't") are never changed.
   The reply carries `correctedQuestion`; `{ "exact": true }` searches the question as typed.
1. **Search** (`src/search.js`): the question is embedded with `@cf/baai/bge-base-en-v1.5` (with bge's query prefix)
   and matched against Vectorize (top 100 chunks). In parallel, D1 FTS5 `bm25()` finds the top 100 chunks by keywords.
2. **Rank**: each candidate chunk gets `0.5 similarity + 0.25 keywords + 0.15 recency + 0.1 U.S.` (each signal scaled
   0 to 1; U.S. = author affiliation 0.8 + MeSH tag 0.2). An article's score is its best chunk's. Weights are in
   `WEIGHTS`; tune them on the test set.
3. **No strong match → live PubMed** (`src/pubmed.js`): if the best similarity is below `MIN_SIMILARITY` (0.62), or
   the model says the indexed articles do not answer the question, PubMed is searched live: ESearch (the question's
   content words, adults 40+ with the collection's topics, 2016 to today, with an abstract; top 10 by relevance),
   then EFetch. Each abstract is embedded with the same model, and articles below `LIVE_MIN_SIMILARITY` (0.70 exact
   cosine; Vectorize's own scores run about 0.08 lower, so this is the same bar) are dropped. The rest go to step 4,
   and the reply has `live: true` (source cards say "Found in a live PubMed search"). PubMed gets 4 seconds; if it is
   slow, fails or finds nothing similar enough, the page shows "no research found". The NCBI API key is the Worker
   secret `NCBI_API_KEY` (optional; 3 requests a second without it). `LIVE_PUBMED_SCOPE=adults40` drops the topic
   limit (all research on adults 40+). In `query_log` these answers have status `answered_live`.
4. **Write** (`src/answer.js`): the top 6 articles go to the answer model the visitor picked in the page's "Answer
   written by" menu (`model` in the request): `@cf/meta/llama-3.3-70b-instruct-fp8-fast` in JSON mode (the default),
   or Claude (`CLAUDE_MODEL` in `wrangler.jsonc`, now `claude-opus-5-5`) through the Anthropic API with structured
   outputs (`src/claude.js`). Both get the same plain-language rules and user message. Each sentence must end with `[n]`; sentences without a valid citation are dropped, and the
   cited articles are renumbered 1, 2, 3 in ranking order.
5. **Reading level** (`src/readability.js`): Flesch-Kincaid grade of the answer.

`POST /api/rank` returns the top 10 articles with each signal, for the precision@10 / nDCG@10 evaluation.

**Question log:** with `LOG_QUESTIONS` set to `"true"` in `wrangler.jsonc`, each question is saved to the D1 table
`query_log` (created by `migrations/0001_query_log.sql`) with the corrected question if any, its status, PMIDs, similarity, grade and latency.
Emails and phone numbers are removed first, a repeat within 30 seconds is skipped, and no IP or browser data is
saved. Questions never go to the console logs. Export: `python scripts/export_query_log.py` (writes a CSV), or
download one from the site (below).

**Research CSV (`/api/questions.csv`, `src/export.js`):** opening it shows a small form (key, who asked, since
date); submitting it downloads a fresh CSV of `query_log`, so Juan can review questions without Python or wrangler.
The key is the Worker secret `EXPORT_KEY`, sent in the POST body (or `Authorization: Bearer <key>` from a script),
never in the URL, so it stays out of browser history and request logs. No secret or a wrong key answers 404; an
invalid filter answers 400. Columns match the Python export, plus `asked_at_arizona`. Text starting with `=`, `+`,
`-` or `@` gets a leading `'` so spreadsheets never run a visitor's text as a formula.

## Public site

Deployed with `npx wrangler deploy` in `worker/` (after `npm run build` in `web/`):
https://capstone.juannadal.com. The site and `/api/*` share one address, so a
Cloudflare Access sign-in on it covers both.

- `LOG_QUESTIONS` is `"true"` in `wrangler.jsonc` since 2026-10-12 (every question is saved for the capstone
  research). `GET /api/config` tells the page, which shows its "we save questions" notice only when it is on.
- About 10 questions a minute per visitor (`ASK_LIMITER`, approximate) and a firm `DAILY_QUESTION_CAP` of 2,000 a
  day for the whole site (D1 table `daily_usage`, no visitor data), which bounds Workers AI cost at about $3 a day.

## Claude option (`src/claude.js`)

The menu offers Claude only when the Worker secret `ANTHROPIC_API_KEY` is set (`GET /api/config` lists the models).
The key lives in 1Password (vault "Claude", item "Anthropic API key") and is piped to Cloudflare without being shown:

```
op read "op://Claude/Anthropic API key/credential" | npx wrangler secret put ANTHROPIC_API_KEY
```

For `wrangler dev`, run it with the key in the environment instead of a file:
`ANTHROPIC_API_KEY=$(op read "op://Claude/Anthropic API key/credential") CLOUDFLARE_INCLUDE_PROCESS_ENV=true npx wrangler dev --name aler-dev`.

- Claude Opus 5.5 at low effort, with structured outputs (the reply must match the JSON schema) and Anthropic's
  server-side fallback (`fallbacks: "default"`), which re-runs a declined request on another Claude model.
- Cost: about $0.03 to $0.05 a question ($4 / $20 per million input / output tokens), roughly 30 times Llama.
  `CLAUDE_DAILY_CAP` (200) limits Claude answers per day on top of `DAILY_QUESTION_CAP`, so at most about $10 a day.
  The count is the `daily_usage` row named `claude:<date>`.
- `query_log.model` records which model answered (`migrations/0006_query_log_model.sql`; run it once with
  `npx wrangler d1 execute pubmed-index --remote --file migrations/0006_query_log_model.sql` before deploying).
- Tests: `node --test test/claude.test.js` checks the request with a fake API (no key, no network).

## Grok option (`src/grok.js`)

The menu offers Grok (xAI) only when the Worker secret `XAI_API_KEY` is set. xAI's API uses the OpenAI chat-completions
format, so the call is a plain `fetch` with a strict JSON schema (no SDK). The model is `GROK_MODEL` in
`wrangler.jsonc`; `GROK_DAILY_CAP` (200) is its own daily cap (`daily_usage` row `grok:<date>`). The key is in
1Password (vault "Claude", item "GROK API Key"); pipe it to Cloudflare without showing it (use `password` instead of
`credential` if the item is a Password item):

```
op read "op://Claude/GROK API Key/credential" | npx wrangler secret put XAI_API_KEY
```

`scripts/run_local.sh` adds it to `.dev.vars` for local runs (it finds the item whose name has "grok" or "xai").
No database change: `query_log.model` is text and simply records `grok`. Tests: `node --test test/grok.test.js`.

## Weekly refresh (`src/refresh.js`)

Every Sunday at 09:00 UTC (2:00 a.m. in Arizona) Cloudflare runs the Worker's `scheduled()` handler (the cron in
`wrangler.jsonc` under `triggers`). It runs on Cloudflare by itself; no computer needs to be on.

1. **Which days:** from the day after the last day a run finished (D1 table `refresh_log`,
   `migrations/0005_refresh_log.sql`) through yesterday (UTC). The first run starts at 2026-10-03, just before the
   harvest. At most 14 days and 3,000 new articles per run; the next run picks up anything left, including the
   rest of a day cut short.
2. **Find:** for each day, ESearch with the collection's own filter (`SCOPES.collection` in `src/pubmed.js`) and
   that day's **MeSH date** (`[mhda]`). The filter needs MeSH terms such as "Aged", which PubMed adds days or weeks
   after an article appears, so an article is collected on the day it starts matching. PMIDs already in D1 are
   skipped; the rest are downloaded with EFetch (200 at a time).
3. **Clean and chunk:** retractions, errata and articles without an abstract are dropped, as in the harvest. Abstracts
   are split with the harvest's rules, ported to JavaScript in `src/chunk.js` (450-token chunks).
   `worker/test/chunk.test.js` runs the Python harvest code and the port on the same XML and checks they match.
4. **Save:** embed with `@cf/baai/bge-base-en-v1.5` and upsert into Vectorize, then insert the articles and chunks
   into D1 (the FTS5 keyword index fills itself). Vectorize goes first because search only shows matches whose chunk
   is in D1, so a run that stops halfway never shows half an article; the next run redoes that day. Each
   article goes into D1 in one transaction with all its chunks.
5. **Retractions:** articles PubMed now marks "Retracted Publication" are removed from D1 and Vectorize. If more than
   50 turn up at once, nothing is removed and the run's status is `check`, for a person to look at.

Each run adds a row to `refresh_log` (days covered, articles found and added, chunks, removals, status `ok`, `check`
or `error` with a note) and writes a one-line summary to the Worker's logs. Check the latest runs with:

    npx wrangler d1 execute pubmed-index --remote --command "SELECT * FROM refresh_log ORDER BY id DESC LIMIT 5"

New articles get their abstract only; full-text passages (`scripts/fetch_fulltext.py`) are not added weekly. New
words are not added to the spelling vocabulary (`scripts/build_vocab.py`), which only matters for brand-new terms.

**Testing:** `node --test worker/test/*.test.js` from the repo root (needs Node 22+ and python3) runs the chunking
comparison and a full refresh against a local SQLite copy of the tables with a fake PubMed. To try it against real
PubMed without saving anything: put `REFRESH_DRY_RUN=true` in `worker/.dev.vars`, run
`npx wrangler dev --name aler-dev --test-scheduled` in `worker/`, then open `http://localhost:8787/cdn-cgi/handler/scheduled`; the
terminal shows what the run would have added.
