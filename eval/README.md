# Evaluation

- `test_questions.csv`: the test set for Feature 3 (precision@10 and nDCG@10 of the ranking). 25 questions, reviewed
  with Juan on 2026-10-31: 21 of the 30 drafts
  kept, 4 added for the chronic conditions of the wider scope (ids 31 to 34; two from real visitor questions), and
  ids 2, 7, 13, 20, 21, 23, 24, 29, 30 dropped. Ids are never reused, so saved ratings always match their question.
- Questions asked in the app are saved to D1 (`query_log`). Export them with `python scripts/export_query_log.py`
  and copy good ones into `test_questions.csv`.

## Ranking evaluation: ours vs PubMed's Best Match

Three steps. Juan makes every relevance judgment himself (proposal: no AI judging his own results).

1. **Collect the rankings** (on the Mac: needs real PubMed and the local Worker). Start the Worker with
   `cd worker && npx wrangler dev --name aler-dev`, then from the repo root:

       node eval/fetch_runs.mjs eval/test_questions.csv eval/runs/<date>

   Saves `ours.csv` (our top 10 from `POST /api/rank`), `pubmed.csv` (PubMed's top 10 in its default Best Match
   order, for the question's words with the collection's own filter, plus the exact query; when PubMed finds
   fewer than 10 with all the words, the rest come from its any-word search) and `pool.json` (both
   lists merged per question, duplicates removed, shuffled, with titles and abstracts). Takes about 4 minutes for
   25 questions, because the Worker allows about 10 questions a minute.
2. **Rate** in `eval/rate.html` (double-click to open it in a browser). Choose the run's `pool.json`, and
   `eval/judgments.csv` if it exists, so earlier ratings are skipped. Rate each article 2 (answers the question
   directly), 1 (on topic, answers only part) or 0 (does not help); keys 2/1/0, arrows to go back or skip. The
   page does not show which system found an article. Progress stays in the browser; "Download judgments.csv" and
   save it as `eval/judgments.csv`.
3. **Score** (anywhere, no network):

       node eval/score.mjs eval/runs/<date> eval/judgments.csv

   Prints the means, wins/ties/losses and p-values and writes `scores.csv` and `report.md` to the run folder.
   precision@10 counts ratings 1 and 2 as relevant; nDCG@10 uses the ratings as gains, against the best order of
   every rated article for that question. Unrated articles count as not relevant and are reported.

After a ranking change (new weights in `worker/src/search.js`), run steps 1 to 3 again into a new run folder:
only articles not rated before need rating. Tests for the scoring: `node --test eval/test/*.test.mjs`.

## Tuning the ranking weights (recency and U.S. relevance)

`worker/src/search.js` scores each article as a weighted sum of four signals: similarity, keywords, recency and U.S.
authors (`WEIGHTS`). The signals do not depend on the weights, so they are saved once and every weight mix is tried
offline against `judgments.csv`.

1. **Save the candidates** (on the Mac, with the Worker from this branch running in `wrangler dev`):

       node eval/dump_candidates.mjs eval/test_questions.csv eval/runs/<date>

   Writes `candidates.json`: per question, every candidate chunk's four signal values (`POST /api/rank` with
   `candidates: true`).
2. **Try every mix** (anywhere, no network):

       node eval/tune_weights.mjs eval/runs/<date>/candidates.json eval/judgments.csv

   1,771 mixes (steps of 0.05). Picks the mix with the most recency + U.S. weight whose condensed nDCG@10 is within
   0.01 of the best, checks the rule with leave-one-question-out cross-validation, and writes `grid.csv`,
   `tuning_report.md` and `to_rate.csv`. Why that rule: the ratings say whether an article is on topic, not whether
   it is recent or American, so relevance alone would only push those two weights down. Condensed nDCG skips
   unrated articles, so new mixes are not marked down for finding articles nobody has rated yet.
3. **Rate the new articles** (on the Mac): `node eval/make_pool.mjs eval/test_questions.csv eval/runs/<date>/to_rate.csv`
   makes a `pool.json` of only those articles; rate them in `rate.html` with `eval/judgments.csv` loaded, save the
   download as `eval/judgments.csv`, and run step 2 again. Then put the chosen weights in `WEIGHTS` and score the
   new ranking with steps 1 to 3 of the evaluation above.

## Automated runs through the page
`ui_test_run.cjs` types each question in `ui_test_questions.csv` (in scope, with typos, and off topic) into the real
page with Playwright and saves what came back. These questions are saved in `query_log` with `source = 'automated'`.
Results: `results/ui_test_<date>.csv`.

    node eval/ui_test_run.cjs eval/ui_test_questions.csv eval/results/ui_test_<date>.csv
