// Ranking evaluation, step 3: score both rankings against Juan's relevance ratings (proposal Feature 3).
//
// Measures, per question, for our ranking (ours.csv) and PubMed's Best Match order (pubmed.csv):
//   - precision@10: the share of the top 10 places holding a relevant article (rated 1 or 2). An empty place, when a
//     system returned fewer than 10, counts as not relevant.
//   - nDCG@10: rewards putting the most relevant articles first. Gain = the rating (0, 1 or 2, "linear gain" as in
//     trec_eval), discounted by log2(rank + 1), divided by the best possible score for that question: its rated
//     articles from BOTH systems sorted best first ("pooled" judgments, the usual TREC practice).
// Then the mean of each over all questions, wins/ties/losses per question, and two paired significance tests:
// a sign test on the wins and losses, and a randomization (permutation) test on the mean difference.
// An article with no rating counts as not relevant, and the report says how many there were.
//
// Usage, from the repo root (no network needed, so this also runs in the cloud):
//   node eval/score.mjs eval/runs/<date> eval/judgments.csv
// Prints the summary and writes scores.csv (one row per question) and report.md to the run folder.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { readCsv, writeCsv, seededRandom } from './lib.mjs';

const K = 10;
// Two scores closer than this count as a tie.
const TIE = 1e-9;
const PERMUTATIONS = 100_000;

// Precision@k: relevant articles (rating >= 1) in the first k places, divided by k.
export function precisionAt(ratings, k = K) {
  return ratings.slice(0, k).filter((r) => r >= 1).length / k;
}

// DCG@k with linear gain: sum of rating / log2(rank + 1), rank counted from 1.
export function dcgAt(ratings, k = K) {
  return ratings.slice(0, k).reduce((sum, r, i) => sum + r / Math.log2(i + 2), 0);
}

// nDCG@k: DCG of the ranking divided by the DCG of the ideal order of all ratings known for the question.
// 0 when the question has no relevant article at all (neither system can do better than nothing).
export function ndcgAt(ratings, allRatings, k = K) {
  const ideal = dcgAt([...allRatings].sort((a, b) => b - a), k);
  return ideal > 0 ? dcgAt(ratings, k) / ideal : 0;
}

// Two-sided exact sign test: the chance of a win/loss split at least this uneven if both systems were equally good.
export function signTest(wins, losses) {
  const n = wins + losses;
  if (!n) return 1;
  const tail = Math.min(wins, losses);
  let p = 0;
  for (let i = 0; i <= tail; i++) p += binomial(n, i);
  return Math.min(1, (2 * p) / 2 ** n);
}

function binomial(n, k) {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

// Two-sided paired randomization test: how often randomly swapping each question's two scores gives a mean
// difference at least as large as the real one. Seeded, so the same data always gives the same p-value.
export function permutationTest(diffs, rounds = PERMUTATIONS, seed = 42) {
  const n = diffs.length;
  if (!n) return 1;
  const observed = Math.abs(diffs.reduce((a, b) => a + b, 0));
  const random = seededRandom(seed);
  let extreme = 0;
  for (let r = 0; r < rounds; r++) {
    let sum = 0;
    for (const d of diffs) sum += random() < 0.5 ? d : -d;
    if (Math.abs(sum) >= observed - TIE) extreme++;
  }
  return (extreme + 1) / (rounds + 1);
}

// Read a ranking file (qid, rank, pmid, ...) into qid -> PMIDs in rank order.
export function loadRun(rows) {
  const run = new Map();
  for (const r of [...rows].sort((a, b) => Number(a.rank) - Number(b.rank))) {
    if (!run.has(r.qid)) run.set(r.qid, []);
    run.get(r.qid).push(r.pmid);
  }
  return run;
}

// Read judgments (qid, pmid, rating) into qid -> (pmid -> rating). A later row for the same article wins, so a
// changed mind can simply be appended.
export function loadJudgments(rows) {
  const judged = new Map();
  for (const r of rows) {
    if (r.rating === '' || r.rating == null) continue;
    if (!judged.has(r.qid)) judged.set(r.qid, new Map());
    judged.get(r.qid).set(r.pmid, Number(r.rating));
  }
  return judged;
}

// Score every question. qids = every question in the run (from pool.json), so a question where a system found
// nothing still counts, with a score of 0, instead of quietly dropping out of the means. Without it, the questions
// that appear in either ranking file.
export function scoreRuns(ours, pubmed, judged, qids = null) {
  qids = [...new Set(qids || [...ours.keys(), ...pubmed.keys()])].sort((a, b) => Number(a) - Number(b));
  return qids.map((qid) => {
    const known = judged.get(qid) || new Map();
    const unrated = new Set();
    const ratingsOf = (pmids) => pmids.map((p) => {
      if (!known.has(p)) { unrated.add(p); return 0; }
      return known.get(p);
    });
    const a = ratingsOf(ours.get(qid) || []);
    const b = ratingsOf(pubmed.get(qid) || []);
    const all = [...known.values()];
    return {
      qid,
      ours_p10: precisionAt(a), pubmed_p10: precisionAt(b),
      ours_ndcg10: ndcgAt(a, all), pubmed_ndcg10: ndcgAt(b, all),
      ours_found: a.length, pubmed_found: b.length,
      unrated: unrated.size,
    };
  });
}

// Mean, wins/ties/losses and both tests for one measure ('p10' or 'ndcg10').
export function compare(rows, measure) {
  const diffs = rows.map((r) => r[`ours_${measure}`] - r[`pubmed_${measure}`]);
  const wins = diffs.filter((d) => d > TIE).length;
  const losses = diffs.filter((d) => d < -TIE).length;
  const mean = (key) => rows.reduce((s, r) => s + r[key], 0) / (rows.length || 1);
  return {
    ours: mean(`ours_${measure}`), pubmed: mean(`pubmed_${measure}`),
    wins, ties: rows.length - wins - losses, losses,
    signP: signTest(wins, losses), permutationP: permutationTest(diffs),
  };
}

const f3 = (v) => v.toFixed(3);
const pval = (p) => (p < 0.001 ? '< 0.001' : p.toFixed(3));

function main() {
  const [runDir, judgmentsFile] = process.argv.slice(2);
  if (!runDir || !judgmentsFile) {
    console.error('Usage: node eval/score.mjs eval/runs/<date> eval/judgments.csv');
    process.exit(1);
  }
  const ours = loadRun(readCsv(join(runDir, 'ours.csv')));
  const pubmed = loadRun(readCsv(join(runDir, 'pubmed.csv')));
  const poolFile = join(runDir, 'pool.json');
  const qids = existsSync(poolFile) ? JSON.parse(readFileSync(poolFile, 'utf8')).questions.map((q) => String(q.qid)) : null;
  const rows = scoreRuns(ours, pubmed, loadJudgments(readCsv(judgmentsFile)), qids);
  const p10 = compare(rows, 'p10');
  const ndcg = compare(rows, 'ndcg10');
  const unrated = rows.reduce((s, r) => s + r.unrated, 0);

  writeCsv(join(runDir, 'scores.csv'),
    ['qid', 'ours_p10', 'pubmed_p10', 'ours_ndcg10', 'pubmed_ndcg10', 'ours_found', 'pubmed_found', 'unrated'],
    rows.map((r) => ({ ...r, ours_p10: f3(r.ours_p10), pubmed_p10: f3(r.pubmed_p10), ours_ndcg10: f3(r.ours_ndcg10), pubmed_ndcg10: f3(r.pubmed_ndcg10) })));

  const line = (name, c) => `| ${name} | ${f3(c.ours)} | ${f3(c.pubmed)} | ${c.wins} / ${c.ties} / ${c.losses} | ${pval(c.signP)} | ${pval(c.permutationP)} |`;
  const report = [
    `# Ranking evaluation: ${runDir}`,
    '',
    `${rows.length} questions. Judgments: \`${judgmentsFile}\`. Unrated articles (counted as not relevant): ${unrated}.`,
    '',
    '| Measure | Ours (mean) | PubMed Best Match (mean) | Ours wins / ties / losses | Sign test p | Permutation test p |',
    '| --- | --- | --- | --- | --- | --- |',
    line('precision@10', p10),
    line('nDCG@10', ndcg),
    '',
    `Proposal target (nDCG@10 beats PubMed's default order): ${ndcg.ours > ndcg.pubmed ? 'met' : 'not met'}.`,
    '',
    '| Question | Ours P@10 | PubMed P@10 | Ours nDCG@10 | PubMed nDCG@10 | PubMed found | Unrated |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.qid} | ${f3(r.ours_p10)} | ${f3(r.pubmed_p10)} | ${f3(r.ours_ndcg10)} | ${f3(r.pubmed_ndcg10)} | ${r.pubmed_found} | ${r.unrated} |`),
    '',
  ].join('\n');
  writeFileSync(join(runDir, 'report.md'), report);
  console.log(report.split('\n').slice(0, 11).join('\n'));
  console.log(`\nWrote ${join(runDir, 'scores.csv')} and ${join(runDir, 'report.md')}.`);
  if (unrated) console.log(`Note: ${unrated} articles have no rating yet. Rate them in eval/rate.html for a final score.`);
}

// Run main() only when called as a script, so the tests can import the functions above.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
