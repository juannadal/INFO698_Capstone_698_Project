// Ranking evaluation, step 1: collect the two rankings to compare and the articles to rate (proposal Feature 3).
//
// For each test question this saves:
//   - ours:   the top 10 from our ranking (POST /api/rank on a local `wrangler dev` Worker, the same code as the site);
//   - pubmed: PubMed's own top 10 in its default "Best Match" order (ESearch sort=relevance), for the question's
//             content words limited to the collection's filter (SCOPES.collection, minus retractions and errata).
//             Both systems then choose from the same kind of eligible articles, so the comparison is about the
//             ordering, not the collection. All words must match first; when that finds fewer than 10, the rest
//             are filled from the any-word search (see pubmedRanking), so PubMed is not marked down for empty places.
//   - pool:   both lists merged per question, duplicates removed, in a shuffled order, with title, journal, year
//             and abstract from PubMed EFetch, for rating in eval/rate.html. The rater cannot tell which system
//             found an article.
//
// Real PubMed and the local Worker are reachable only from Juan's Mac, so this runs there. Usage, from the repo root,
// with `npx wrangler dev --name aler-dev` running in worker/:
//   node eval/fetch_runs.mjs eval/test_questions.csv eval/runs/<date> [http://127.0.0.1:8787]
// Writes ours.csv, pubmed.csv and pool.json to that folder. NCBI_API_KEY in the environment is used if set (never
// saved); without it the script stays under NCBI's 3 requests a second.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv, writeCsv, shuffle } from './lib.mjs';
import { SCOPES, parseArticles } from '../worker/src/pubmed.js';
import { contentWords } from '../worker/src/search.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const TOOL = 'aging-lifestyle-research-explorer-eval';
// The proposal's measures are precision@10 and nDCG@10, so 10 results per system.
const DEPTH = 10;
// The Worker allows about 10 questions a minute per visitor (ASK_LIMITER, also in wrangler dev), so space the
// /api/rank calls out, and wait a minute if it still says 429.
const RANK_GAP_MS = 6500;
// Retractions and errata: the harvest and the weekly refresh never put them in the index, so PubMed must not be
// allowed to rank them either (excluded in the query, so PubMed still fills 10 places).
const NOT_DROPPED = 'NOT ("Retracted Publication"[pt] OR "Retraction of Publication"[pt] OR "Published Erratum"[pt])';
// NCBI: at most 3 requests a second without a key.
const NCBI_GAP_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Our ranking: the top DEPTH articles from POST /api/rank, best first.
async function ourRanking(worker, question) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${worker}/api/rank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Source': 'automated' },
      body: JSON.stringify({ question }),
    });
    if (res.status === 429) { console.log('  rate limited, waiting a minute'); await sleep(60_000); continue; }
    if (!res.ok) throw new Error(`/api/rank ${res.status}: ${await res.text()}`);
    const { articles } = await res.json();
    return articles.slice(0, DEPTH).map((a) => ({ pmid: String(a.pmid), score: a.score }));
  }
  throw new Error('/api/rank kept returning 429');
}

// Shared E-utilities parameters, with the API key from the environment when there is one.
function ncbiParams(extra) {
  const p = new URLSearchParams({ db: 'pubmed', tool: TOOL, ...extra });
  if (process.env.NCBI_API_KEY) p.set('api_key', process.env.NCBI_API_KEY);
  return p;
}

// One ESearch: PMIDs in PubMed's Best Match order.
async function esearch(term) {
  await sleep(NCBI_GAP_MS);
  const res = await fetch(`${EUTILS}esearch.fcgi?${ncbiParams({ term, retmax: String(DEPTH), sort: 'relevance', retmode: 'json' })}`);
  if (!res.ok) throw new Error(`ESearch ${res.status}`);
  return (await res.json()).esearchresult?.idlist || [];
}

// PubMed's ranking for the question: all content words AND'ed with the collection filter (minus retractions and
// errata), in Best Match order. A question in everyday words often matches fewer than 10 articles that way (every
// word must appear, "every" and "day" included), so the empty places are then filled, in order, from the same
// search with the words OR'ed, also in Best Match order. PubMed so always gets 10 places, like our ranking.
// Returns the PMIDs and, per PMID, which query found it.
async function pubmedRanking(question) {
  const words = contentWords(question);
  const allWords = `(${words.join(' ')}) AND ${SCOPES.collection} ${NOT_DROPPED}`;
  const anyWord = `(${words.join(' OR ')}) AND ${SCOPES.collection} ${NOT_DROPPED}`;
  const found = (await esearch(allWords)).map((pmid) => ({ pmid, term: allWords, allWords: true }));
  if (found.length < DEPTH && words.length > 1) {
    const seen = new Set(found.map((a) => a.pmid));
    for (const pmid of await esearch(anyWord)) {
      if (found.length >= DEPTH) break;
      if (!seen.has(pmid)) found.push({ pmid, term: anyWord, allWords: false });
    }
  }
  return found;
}

// Title, journal, year and abstract for each PMID, from EFetch (POST keeps the URL short). Also used by
// eval/make_pool.mjs.
export async function fetchArticles(pmids) {
  if (!pmids.length) return new Map();
  await sleep(NCBI_GAP_MS);
  const res = await fetch(`${EUTILS}efetch.fcgi`, { method: 'POST', body: ncbiParams({ id: pmids.join(','), retmode: 'xml' }) });
  if (!res.ok) throw new Error(`EFetch ${res.status}`);
  return new Map(parseArticles(await res.text()).map((a) => [a.pmid, a]));
}

async function main() {
  const [questionsFile, outDir, worker = 'http://127.0.0.1:8787'] = process.argv.slice(2);
  if (!questionsFile || !outDir) {
    console.error('Usage: node eval/fetch_runs.mjs eval/test_questions.csv eval/runs/<date> [worker URL]');
    process.exit(1);
  }
  const questions = readCsv(questionsFile);
  mkdirSync(outDir, { recursive: true });
  const ours = [];
  const pubmed = [];
  const pool = [];
  for (const [n, q] of questions.entries()) {
    console.log(`${n + 1}/${questions.length} [${q.id}] ${q.question}`);
    const mine = await ourRanking(worker, q.question);
    const theirs = await pubmedRanking(q.question);
    mine.forEach((a, i) => ours.push({ qid: q.id, rank: i + 1, pmid: a.pmid, score: a.score }));
    // The query is written once, on the first row it found; the rows after it until the next query share it.
    theirs.forEach((a, i) => pubmed.push({ qid: q.id, rank: i + 1, pmid: a.pmid, term: i === 0 || theirs[i - 1].term !== a.term ? a.term : '' }));
    const allWordsFound = theirs.filter((a) => a.allWords).length;
    console.log(`  ours ${mine.length}, PubMed ${theirs.length} (${allWordsFound} with all words)`);

    // The pile to rate: every article either system put in its top 10, once, in a shuffled order seeded by the
    // question id so a re-run gives the same order.
    const pmids = [...new Set([...mine.map((a) => a.pmid), ...theirs.map((a) => a.pmid)])];
    const details = await fetchArticles(pmids);
    const articles = shuffle(pmids, 1000 + Number(q.id) || 42).map((pmid) => {
      const a = details.get(pmid) || {};
      return { pmid, title: a.title || '(not found in PubMed)', journal: a.journal || '', year: a.pub_year || '', abstract: a.abstract || '' };
    });
    pool.push({ qid: q.id, topic: q.topic, question: q.question, articles });
    if (n < questions.length - 1) await sleep(RANK_GAP_MS);
  }
  writeCsv(join(outDir, 'ours.csv'), ['qid', 'rank', 'pmid', 'score'], ours);
  writeCsv(join(outDir, 'pubmed.csv'), ['qid', 'rank', 'pmid', 'term'], pubmed);
  writeFileSync(join(outDir, 'pool.json'), JSON.stringify({ created: new Date().toISOString(), questions: pool }, null, 1));
  const total = pool.reduce((s, q) => s + q.articles.length, 0);
  console.log(`\nSaved to ${outDir}: ${pool.length} questions, ${total} articles to rate.`);
}

// Run main() only when called as a script, so eval/make_pool.mjs can import fetchArticles().
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err); process.exit(1); });
