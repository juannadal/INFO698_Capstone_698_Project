# Code review, 2026-10-11

A review of `worker/`, `web/src/` (not the copied design system), `scripts/` and
`eval/ui_test_run.cjs`, after the code was documented. Each finding was fixed on the `review-fixes` branch; the
first one was confirmed on the running app before fixing.

| # | Where | Problem | What could go wrong | Fix |
|---|---|---|---|---|
| 1 | `worker/src/spelling.js` | Contractions were split at the apostrophe, and "shouldn" looks like a rare typo of "should" | "Shouldn't I walk more?" was searched as "Should't I walk more?" (confirmed) | Words with an apostrophe are never corrected |
| 2 | `scripts/harvest_and_chunk.py` | A month with failed download batches was still saved, so a re-run skipped it | Up to hundreds of articles silently missing per bad month | Months with failures are not saved, so a re-run fetches them again |
| 3 | `worker/src/answer.js` | Invalid or cut-off JSON from the model was not handled | A 500 error for an answerable question | One automatic retry; then the page offers "Try again" |
| 4 | `eval/ui_test_run.cjs` | The rate-limit notice was not one of the states the test waits for | Rate-limited questions recorded as 60-second timeouts, skewing timing results | Recorded as `rate_limited` |
| 5 | `worker/src/index.js` | The daily question counter was increased before the request was checked, and kept growing past the cap | Bad or empty requests could use up the 2,000-a-day limit | Counted only for valid questions, and not past the cap |
| 6 | `worker/src/answer.js` | Citation ranges like [1-3] were not recognized | Those sentences were dropped; an answer could become "no research found" | Ranges and mixed lists ([1, 3-4]) are understood |
| 7 | `scripts/load_cloudflare.py` | SQL batch files from an earlier run were reused | After re-chunking, D1 could load old text while Vectorize had new vectors | Batch files are always rewritten |
| 8 | `worker/src/spelling.js`, `search.js` | Database lookups ran one after another | Slower answers | Independent lookups run in parallel |
| 9 | `scripts/fetch_fulltext.py` | A lookup table was rebuilt for every paragraph | Very slow on long articles | Built once per section |
| 10 | `scripts/build_vocab.py`, `worker/README.md` | Docs said dictionary words are never corrected, and that search uses the top 50 | Misleading for anyone tuning or reviewing | Docs match the code |

Checked after fixing: Python scripts compile, Worker modules load, the front end builds, and on the running Worker
"Shouldn't ...", "Aren't ...", "excersize ... arthritus" and "blood presser" all behave correctly, while invalid and
empty requests get a 400 without touching the daily counter.
