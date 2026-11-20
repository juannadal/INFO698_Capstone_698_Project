# Code guide

How the code fits together, where each decision lives, and a reading order for code review. Each source file also
starts with a comment saying what it is for.

## The two halves

The project has an **offline pipeline** (Python scripts run on a laptop, once or on a schedule) that builds a search
index in Cloudflare, and an **online app** (a Cloudflare Worker plus a React page) that answers questions from it.

```mermaid
flowchart LR
  subgraph Offline pipeline (scripts/)
    A[PubMed E-utilities] -->|harvest_and_chunk.py harvest| B[raw XML, Google Drive]
    B -->|harvest_and_chunk.py chunk| C[articles.jsonl + chunks.jsonl]
    P[PMC open-access copy on AWS] -->|fetch_fulltext.py| F[fulltext.jsonl]
    F -->|load_fulltext.py chunk| G[fulltext_chunks.jsonl]
    C -->|load_cloudflare.py d1| D1[(D1: articles, chunks, chunks_fts)]
    G -->|load_fulltext.py d1| D1
    C -->|load_cloudflare.py vectors + vector_loader| V[(Vectorize: pubmed-chunks)]
    G -->|load_fulltext.py vectors + vector_loader| V
    C -->|build_vocab.py| VOC[(D1: vocab)]
  end
  subgraph Online app
    U[Reader] --> W[web/ React page]
    W -->|POST /api/ask| K[worker/ Worker]
    K --> VOC
    K --> V
    K --> D1
    K --> AI[Workers AI: embeddings + Llama 3.3 70B]
  end
```

## What happens when someone asks a question

All of this is in `worker/src/`, starting at `index.js`.

1. **Guards** (`index.js`): only POST; about 10 questions a minute per visitor and a firm 2,000 a day for the whole
   site, so a stranger cannot run up the Workers AI bill. The visitor's IP is used only as the rate-limit key.
2. **Spelling** (`spelling.js`): a word that is not in the article text is replaced by the closest common article word
   ("excersize" -> "exercise"). The page shows "Showing results for ..." and a link to search the original words.
3. **Search** (`search.js`): two searches over all passages (abstracts and full text) at once: by meaning (the question
   is embedded with bge-base-en-v1.5 and matched in Vectorize) and by keywords (D1 FTS5 `bm25()`).
4. **Rank** (`search.js`): every candidate passage gets `0.5 similarity + 0.25 keywords + 0.15 recency + 0.1 U.S.`
   An article's score is its best passage's; its best 3 passages are kept for the answer.
5. **No answer**: if nothing is similar enough (`MIN_SIMILARITY`, 0.62), the page says "We did not find research that
   answers this" instead of guessing.
6. **Write** (`answer.js`): the top 6 articles go to Llama 3.3 70B with plain-language rules (grade 6-8, numbers in
   everyday units, never advise, cite every sentence as [n]). Sentences without a valid citation are dropped, and the
   cited articles are renumbered 1, 2, 3 in ranking order so the numbers match the source cards.
   **Follow-ups** (`followup.js`): below an answer the reader can ask a follow-up or press "Give me more detail". The
   page sends the last 3 questions and answers with the new question. A small model (Llama 3.1 8B) rewrites the
   follow-up so it makes sense alone ("How much?" -> "How much walking lowers blood pressure?"); that is searched
   (steps 3-5 again), and the answer model also sees the earlier answers, with rules to add new facts, not repeat
   them. The same citation rules and clean-up apply. "More detail" re-searches the same question and asks for 3-4
   paragraphs with study sizes, amounts and strength of evidence.
7. **Reading level** (`readability.js`): the Flesch-Kincaid grade shown under the answer.
8. **Log** (`index.js`, only if `LOG_QUESTIONS` is on): the question, with emails and phone numbers removed, and what
   came back, into D1 `query_log`. Off on the public site.

## File map

| Path | What it is | Read first if you review... |
|---|---|---|
| `worker/src/index.js` | Routes, guards, logging, response shape | the API |
| `worker/src/search.js` | Search and ranking (Feature 3) | ranking, weights, the no-answer cutoff |
| `worker/src/answer.js` | Prompt, JSON output, citation clean-up (Feature 4) | answer quality, citations |
| `worker/src/followup.js` | Follow-up questions and "More detail": history clean-up, query rewrite, extra prompt rules | follow-ups |
| `worker/src/spelling.js` | Spelling correction | |
| `worker/src/readability.js` | Flesch-Kincaid grade | |
| `worker/wrangler.jsonc` | Cloudflare bindings, settings, limits | deployment, privacy settings |
| `worker/migrations/*.sql` | D1 tables added after the first load | the database |
| `web/src/api.js` | Calls the API; documents the response shape | the front end |
| `web/src/pages/*.jsx` | Start, Ask (working / answer / no answer / error), About | |
| `web/src/Layout.jsx` | Header, footer, light/dark theme | |
| `web/src/design/` | The design system's components, copied unchanged from the design handoff | (not reviewed here) |
| `scripts/harvest_and_chunk.py` | PubMed harvest and abstract chunking | the data |
| `scripts/fetch_fulltext.py`, `load_fulltext.py` | Full text of open-access articles | |
| `scripts/load_cloudflare.py`, `vector_loader/` | Loading D1 and Vectorize | |
| `scripts/build_vocab.py` | Spelling word list | |
| `scripts/export_query_log.py` | Saved questions to CSV | evaluation |
| `eval/` | Test questions, Playwright test run, results | evaluation |
| `eval/fetch_runs.mjs`, `rate.html`, `score.mjs` | Ranking evaluation: our top 10 vs PubMed's Best Match, rated blind, precision@10 and nDCG@10 | evaluation, ranking |

## Suggested reading order for a review

1. `docs/CODE_GUIDE.md` (this file), then `worker/README.md`.
2. `worker/src/index.js` top to bottom: it calls everything else.
3. `worker/src/search.js`, then `answer.js`: the two parts that decide answer quality.
4. `web/src/api.js`, then `web/src/pages/ChatPage.jsx`: how the page uses the answer (each message is one `/api/ask` request).
5. `scripts/harvest_and_chunk.py`, then the load scripts: how the data got there.

## Things worth checking in a review

- **Citations:** every sentence in an answer must cite a source that is shown (`cleanAnswer` in `answer.js`).
- **Privacy:** no question text in console logs; IP used only for rate limiting; `LOG_QUESTIONS` on in production since 2026-10-12 (for the research), with the
  "we save questions" notice shown; `/api/questions.csv` (`export.js`) needs the `EXPORT_KEY` secret, sent in the
  request body, never the URL.
- **Cost limits:** `ASK_LIMITER` and `DAILY_QUESTION_CAP` in `wrangler.jsonc` and `index.js`.
- **Never advise:** the prompt rules in `answer.js` and the notice under every answer (`pages/shared.jsx`).
- **SQL:** D1 queries use bound parameters (`?1`), never string building with user input. (The offline load scripts
  build SQL files from harvested data, escaping quotes in `sql_str`.)
- **Model consistency:** passages and questions must be embedded with the same model (`EMBED_MODEL` in `search.js`
  and `scripts/vector_loader/worker.js`).

## Running it

- Front end only, with sample answers: `cd web && npm install && npm run dev` with `VITE_USE_SAMPLE_API=true` in
  `web/.env`.
- Whole app locally (real data): `cd worker && npx wrangler dev --name aler-dev`, then `cd web && npm run dev`.
- Deploy: `cd web && npm run build`, then `cd worker && npx wrangler deploy`.
- The data pipeline needs the Drive data folder; see the docstring at the top of each script.
