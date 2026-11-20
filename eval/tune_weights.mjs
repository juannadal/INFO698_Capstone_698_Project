// Weight tuning, step 2: try every mix of the four ranking weights against Juan's ratings and pick one (proposal
// Feature 3, "recency and U.S.-relevance signals added and weights tuned").
//
// Input: candidates.json from eval/dump_candidates.mjs (every candidate chunk's four signal values per question) and
// eval/judgments.csv. For each weight mix on a grid (steps of 0.05, all four adding up to 1: 1,771 mixes), every
// question is re-ranked exactly as the Worker would (combineSignals and bestChunkPerArticle from
// worker/src/search.js), and the top 10 is measured:
//   - nDCG@10 and precision@10, as in eval/score.mjs (an unrated article counts as not relevant);
//   - condensed nDCG@10: the same, but unrated articles are skipped, so the top 10 rated ones are scored. Juan's
//     ratings came from the current weights' top 10, so a new mix that brings in unrated articles would otherwise
//     look worse just for being new (Sakai 2007, "Alternatives to Bpref"). Used to choose the weights;
//   - unrated: how many of the top 10 have no rating;
//   - recent_share: share of the top 10 published in the last 5 years (2022 or later);
//   - us_share: share of the top 10 with a U.S. author affiliation.
//
// Why not just take the mix with the best nDCG: Juan's ratings say whether an article is on topic, not whether it
// is recent or American. Topical ratings alone can only push recency and U.S. weight down. The proposal wants both
// signals in the ranking, so the rule is: among the mixes whose mean condensed nDCG@10 is within TOLERANCE of the
// best, take the one that gives recency + U.S. the most weight (ties: higher nDCG). "Keep as much recency and U.S.
// weight as the ratings allow without losing relevance."
//
// 25 questions is a small set, so the rule is also checked with leave-one-question-out cross-validation: choose the
// weights on 24 questions, score the 25th, repeat 25 times. If that held-out score is no worse than the current
// weights', the gain is not just overfitting to these questions.
//
// Usage (anywhere, no network):
//   node eval/tune_weights.mjs eval/runs/<date>/candidates.json eval/judgments.csv
// Writes grid.csv (every mix), tuning_report.md and to_rate.csv (unrated articles in the top 10 of the mixes that
// matter, for eval/make_pool.mjs and eval/rate.html) next to candidates.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv, writeCsv } from './lib.mjs';
import { precisionAt, ndcgAt, loadJudgments } from './score.mjs';
import { combineSignals, bestChunkPerArticle } from '../worker/src/search.js';

const K = 10;
// Grid step: 0.05 gives 1,771 mixes, fine enough to matter and coarse enough not to chase noise.
const STEPS = 20;
// How much mean condensed nDCG@10 the rule may give up for more recency + U.S. weight. 0.01 is about one article
// moving one place on a few questions; tuning_report.md also shows the picks for 0.005 and 0.02.
export const TOLERANCE = 0.01;
export const RECENT_FROM = 2022;
// signals.us is 0.8 for a U.S. author affiliation (+0.2 for a U.S. MeSH tag): see worker/src/search.js.
const US_AFFILIATION = 0.8;
const SIGNALS = ['similarity', 'keywords', 'recency', 'us'];

// Every weight mix on the grid: four non-negative multiples of 1/STEPS that add up to 1.
export function weightGrid(steps = STEPS) {
  const grid = [];
  for (let a = 0; a <= steps; a++) for (let b = 0; a + b <= steps; b++) for (let c = 0; a + b + c <= steps; c++) {
    const d = steps - a - b - c;
    grid.push({ similarity: a / steps, keywords: b / steps, recency: c / steps, us: d / steps });
  }
  return grid;
}

// The question's articles in the Worker's order for these weights: each chunk scored, each article by its best
// chunk, best first. Ties keep the candidates' order, like the Worker's stable sort.
export function rankQuestion(candidates, weights) {
  const scored = candidates.map((c) => ({ ...c, score: combineSignals(c.signals, weights) }));
  return bestChunkPerArticle(scored).sort((a, b) => b.score - a.score);
}

// The measures of one ranked list (see the top of the file). known: pmid -> rating for this question.
export function measure(ranked, known) {
  const top = ranked.slice(0, K);
  const all = [...known.values()];
  const ratings = top.map((a) => known.get(a.pmid) ?? 0);
  const condensed = ranked.filter((a) => known.has(a.pmid)).slice(0, K).map((a) => known.get(a.pmid));
  const share = (test) => (top.length ? top.filter(test).length / top.length : 0);
  return {
    ndcg: ndcgAt(ratings, all, K),
    condensed: ndcgAt(condensed, all, K),
    p10: precisionAt(ratings, K),
    unrated: top.filter((a) => !known.has(a.pmid)).length,
    recent_share: share((a) => (a.pub_year || 0) >= RECENT_FROM),
    us_share: share((a) => a.signals.us >= US_AFFILIATION),
  };
}

const MEASURES = ['ndcg', 'condensed', 'p10', 'unrated', 'recent_share', 'us_share'];
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const sameWeights = (a, b) => SIGNALS.every((k) => Math.abs(a[k] - b[k]) < 1e-9);

// Mean of each measure over the questions at the given positions, for one mix.
export function meansOver(perQuestion, positions) {
  return Object.fromEntries(MEASURES.map((m) => [m, mean(positions.map((i) => perQuestion[i][m]))]));
}

// The selection rule (see the top of the file), using only the questions at `positions`. results: [{ weights,
// perQuestion }]. Returns { best, chosen }: the mix with the best mean condensed nDCG@10, and the one the rule picks.
export function choose(results, positions, tolerance = TOLERANCE) {
  const scored = results.map((r) => ({ ...r, means: meansOver(r.perQuestion, positions) }));
  const best = scored.reduce((x, y) => (y.means.condensed > x.means.condensed ? y : x));
  const chosen = scored
    .filter((r) => r.means.condensed >= best.means.condensed - tolerance - 1e-12)
    .reduce((x, y) => {
      const wx = x.weights.recency + x.weights.us;
      const wy = y.weights.recency + y.weights.us;
      if (Math.abs(wy - wx) > 1e-9) return wy > wx ? y : x;
      return y.means.condensed > x.means.condensed ? y : x;
    });
  return { best, chosen };
}

const f3 = (v) => v.toFixed(3);
const w2 = (w) => SIGNALS.map((k) => w[k].toFixed(2)).join(' / ');
const pct = (v) => `${Math.round(v * 100)}%`;

function main() {
  const [candidatesFile, judgmentsFile] = process.argv.slice(2);
  if (!candidatesFile || !judgmentsFile) {
    console.error('Usage: node eval/tune_weights.mjs eval/runs/<date>/candidates.json eval/judgments.csv');
    process.exit(1);
  }
  const outDir = dirname(candidatesFile);
  const dump = JSON.parse(readFileSync(candidatesFile, 'utf8'));
  const questions = dump.questions;
  const judged = loadJudgments(readCsv(judgmentsFile));
  const knownOf = (q) => judged.get(q.qid) || new Map();
  const current = dump.weights;

  // Check: the current weights, re-ranked here, must give the Worker's own top 10.
  const mismatched = questions.filter((q) => rankQuestion(q.candidates, current).slice(0, K).map((a) => a.pmid).join() !== q.top10.join());
  if (mismatched.length) console.log(`Warning: offline top 10 differs from the Worker's for questions ${mismatched.map((q) => q.qid).join(', ')}`);

  const grid = weightGrid();
  if (!grid.some((w) => sameWeights(w, current))) grid.push(current);
  const results = grid.map((weights) => ({
    weights,
    perQuestion: questions.map((q) => measure(rankQuestion(q.candidates, weights), knownOf(q))),
  }));
  const all = questions.map((_, i) => i);
  const currentResult = results.find((r) => sameWeights(r.weights, current));
  const currentMeans = meansOver(currentResult.perQuestion, all);
  const { best, chosen } = choose(results, all);
  const byTolerance = [0.005, 0.01, 0.02].map((t) => ({ t, ...choose(results, all, t) }));

  // Leave one question out: choose on the other questions, score the held-out one.
  const folds = questions.map((q, i) => {
    const rest = all.filter((j) => j !== i);
    const pick = choose(results, rest);
    return {
      qid: q.qid,
      chosen: pick.chosen, best: pick.best,
      chosenScore: pick.chosen.perQuestion[i].condensed,
      bestScore: pick.best.perQuestion[i].condensed,
      currentScore: currentResult.perQuestion[i].condensed,
    };
  });
  const cv = {
    chosen: mean(folds.map((f) => f.chosenScore)),
    best: mean(folds.map((f) => f.bestScore)),
    current: mean(folds.map((f) => f.currentScore)),
    sameAsFull: folds.filter((f) => sameWeights(f.chosen.weights, chosen.weights)).length,
  };

  // Every mix, best condensed nDCG first.
  const rows = results.map((r) => ({ ...r.weights, ...meansOver(r.perQuestion, all) }))
    .sort((a, b) => b.condensed - a.condensed);
  writeCsv(join(outDir, 'grid.csv'), [...SIGNALS, ...MEASURES],
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'unrated' ? v.toFixed(2) : f3(v)]))));

  // Articles to rate: unrated ones in the top 10 of the current mix (a new dump can differ from the rated run), the
  // chosen mix, the relevance-only best, and every fold's picks, so the final scores (and the cross-validation) rest
  // on ratings, not on guesses.
  const toRate = new Map();
  const addUnrated = (weights) => questions.forEach((q) => {
    for (const a of rankQuestion(q.candidates, weights).slice(0, K)) {
      if (!knownOf(q).has(a.pmid)) toRate.set(`${q.qid}|${a.pmid}`, { qid: q.qid, pmid: a.pmid });
    }
  });
  for (const w of [current, chosen.weights, best.weights, ...byTolerance.map((b) => b.chosen.weights), ...folds.flatMap((f) => [f.chosen.weights, f.best.weights])]) addUnrated(w);
  const toRateRows = [...toRate.values()].sort((a, b) => Number(a.qid) - Number(b.qid) || Number(a.pmid) - Number(b.pmid));
  writeCsv(join(outDir, 'to_rate.csv'), ['qid', 'pmid'], toRateRows);

  const row = (name, w, m) => `| ${name} | ${w2(w)} | ${f3(m.ndcg)} | ${f3(m.condensed)} | ${f3(m.p10)} | ${m.unrated.toFixed(1)} | ${pct(m.recent_share)} | ${pct(m.us_share)} |`;
  const report = [
    `# Ranking weight tuning: ${outDir}`,
    '',
    `${questions.length} questions, ${grid.length} weight mixes (similarity / keywords / recency / U.S.). Judgments: \`${judgmentsFile}\`.`,
    `Rule: the most recency + U.S. weight whose mean condensed nDCG@10 is within ${TOLERANCE} of the best.`,
    mismatched.length ? `Warning: offline re-ranking differs from the Worker for questions ${mismatched.map((q) => q.qid).join(', ')}.` : 'Check: re-ranking offline with the current weights gives the Worker\'s top 10 for every question.',
    '',
    '| Mix | Weights | nDCG@10 | Condensed nDCG@10 | P@10 | Unrated in top 10 (mean) | Last 5 years | U.S. authors |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    row('Current', current, currentMeans),
    row('Best for relevance only', best.weights, best.means),
    row('Chosen by the rule', chosen.weights, chosen.means),
    '',
    'Sensitivity to the tolerance:',
    '',
    '| Tolerance | Chosen weights | Condensed nDCG@10 | Last 5 years | U.S. authors |',
    '| --- | --- | --- | --- | --- |',
    ...byTolerance.map((b) => `| ${b.t} | ${w2(b.chosen.weights)} | ${f3(b.chosen.means.condensed)} | ${pct(b.chosen.means.recent_share)} | ${pct(b.chosen.means.us_share)} |`),
    '',
    '## Leave-one-question-out check',
    '',
    `Weights chosen on 24 questions, scored on the 25th (condensed nDCG@10, mean over the ${questions.length} held-out questions):`,
    '',
    `- current weights: ${f3(cv.current)}`,
    `- the rule: ${f3(cv.chosen)} (picked the same mix as on all questions in ${cv.sameAsFull} of ${questions.length} folds)`,
    `- best for relevance only: ${f3(cv.best)}`,
    '',
    '| Held-out question | Rule\'s weights | Rule | Current |',
    '| --- | --- | --- | --- |',
    ...folds.map((f) => `| ${f.qid} | ${w2(f.chosen.weights)} | ${f3(f.chosenScore)} | ${f3(f.currentScore)} |`),
    '',
    `Unrated articles in the top 10 of these mixes: ${toRateRows.length} (to_rate.csv). Rate them, then run this again.`,
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'tuning_report.md'), report);
  console.log(report.split('\n').slice(0, 26).join('\n'));
  console.log(`\nWrote grid.csv, tuning_report.md and to_rate.csv to ${outDir}.`);
}

// Run main() only when called as a script, so the tests can import the functions above.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
