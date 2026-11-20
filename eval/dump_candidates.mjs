// Weight tuning, step 1: save every candidate article's signal values for each test question (proposal Feature 3,
// "recency and U.S.-relevance signals added and weights tuned").
//
// The Worker scores each candidate chunk on four signals (similarity, keywords, recency, us; see
// worker/src/search.js) and only then adds them up with WEIGHTS. The signals do not depend on the weights, so saving
// them once lets eval/tune_weights.mjs try thousands of weight mixes offline, in seconds, without calling Cloudflare.
//
// Calls POST /api/rank { question, candidates: true } on a local `wrangler dev` Worker (same code and data as the
// site), so this runs on Juan's Mac. Usage, from the repo root, with `npx wrangler dev --name aler-dev` running in
// worker/:
//   node eval/dump_candidates.mjs eval/test_questions.csv eval/runs/<date> [http://127.0.0.1:8787]
// Writes candidates.json to that folder: per question, the current top 10 and every candidate chunk's
// { pmid, chunk_id, pub_year, signals }. About 3 minutes for 25 questions (the Worker allows ~10 a minute).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from './lib.mjs';
import { WEIGHTS } from '../worker/src/search.js';

// Same spacing as fetch_runs.mjs: the Worker's rate limiter allows about 10 questions a minute per visitor.
const RANK_GAP_MS = 6500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One question's ranking with every candidate's signals. Waits a minute and retries when rate limited.
async function rankWithCandidates(worker, question) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${worker}/api/rank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Source': 'automated' },
      body: JSON.stringify({ question, candidates: true }),
    });
    if (res.status === 429) { console.log('  rate limited, waiting a minute'); await sleep(60_000); continue; }
    if (!res.ok) throw new Error(`/api/rank ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (!Array.isArray(body.candidates)) {
      throw new Error('/api/rank sent no candidates: is wrangler dev running the code from this branch?');
    }
    return body;
  }
  throw new Error('/api/rank kept returning 429');
}

async function main() {
  const [questionsFile, outDir, worker = 'http://127.0.0.1:8787'] = process.argv.slice(2);
  if (!questionsFile || !outDir) {
    console.error('Usage: node eval/dump_candidates.mjs eval/test_questions.csv eval/runs/<date> [worker URL]');
    process.exit(1);
  }
  const questions = readCsv(questionsFile);
  mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const [n, q] of questions.entries()) {
    console.log(`${n + 1}/${questions.length} [${q.id}] ${q.question}`);
    const { articles, candidates, topSimilarity } = await rankWithCandidates(worker, q.question);
    const pmids = new Set(candidates.map((c) => c.pmid));
    console.log(`  ${candidates.length} chunks from ${pmids.size} articles`);
    out.push({
      qid: String(q.id), question: q.question, topSimilarity,
      top10: articles.map((a) => String(a.pmid)),
      candidates: candidates.map((c) => ({ ...c, pmid: String(c.pmid) })),
    });
    if (n < questions.length - 1) await sleep(RANK_GAP_MS);
  }
  const file = join(outDir, 'candidates.json');
  writeFileSync(file, JSON.stringify({ created: new Date().toISOString(), weights: WEIGHTS, questions: out }));
  console.log(`\nSaved ${file}. Next: node eval/tune_weights.mjs ${file} eval/judgments.csv`);
}

main().catch((err) => { console.error(err); process.exit(1); });
