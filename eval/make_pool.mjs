// Weight tuning, step 3: turn to_rate.csv (from eval/tune_weights.mjs) into a pool.json for eval/rate.html, so Juan
// rates only the articles that new weight mixes brought into a top 10. Same format as fetch_runs.mjs's pool.json:
// titles and abstracts from PubMed EFetch, articles shuffled, no hint of which mix found them.
//
// Needs real PubMed, so it runs on Juan's Mac. Usage, from the repo root:
//   node eval/make_pool.mjs eval/test_questions.csv eval/runs/<date>/to_rate.csv
// Writes pool.json next to to_rate.csv. In rate.html, choose that pool.json and eval/judgments.csv, rate, then save
// the downloaded judgments.csv over eval/judgments.csv (it keeps all the earlier ratings too).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readCsv, shuffle } from './lib.mjs';
import { fetchArticles } from './fetch_runs.mjs';

async function main() {
  const [questionsFile, toRateFile] = process.argv.slice(2);
  if (!questionsFile || !toRateFile) {
    console.error('Usage: node eval/make_pool.mjs eval/test_questions.csv eval/runs/<date>/to_rate.csv');
    process.exit(1);
  }
  const wanted = readCsv(toRateFile);
  const pool = [];
  for (const q of readCsv(questionsFile)) {
    const pmids = wanted.filter((r) => r.qid === String(q.id)).map((r) => r.pmid);
    if (!pmids.length) continue;
    const details = await fetchArticles(pmids);
    const articles = shuffle(pmids, 2000 + Number(q.id) || 42).map((pmid) => {
      const a = details.get(pmid) || {};
      return { pmid, title: a.title || '(not found in PubMed)', journal: a.journal || '', year: a.pub_year || '', abstract: a.abstract || '' };
    });
    pool.push({ qid: String(q.id), topic: q.topic, question: q.question, articles });
    console.log(`[${q.id}] ${articles.length} to rate`);
  }
  const file = join(dirname(toRateFile), 'pool.json');
  writeFileSync(file, JSON.stringify({ created: new Date().toISOString(), questions: pool }, null, 1));
  console.log(`\nSaved ${file}: ${pool.reduce((s, q) => s + q.articles.length, 0)} articles in ${pool.length} questions.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
