// Feature 3: find and rank articles for a question.
// Candidates come from two searches over the chunks: embedding similarity (Vectorize) and keywords (D1 FTS5 bm25).
// Each chunk gets one score from four signals, and an article is ranked by its best chunk. Its best few chunks
// (abstract or full text) are kept as passages for the answer.

export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
// bge v1.5 recommends this prefix on short retrieval queries (not on the passages, which were embedded without it).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Full text gives some articles many chunks, so search wide enough to still reach many different articles.
const VECTOR_TOP_K = 100;
const KEYWORD_TOP_K = 100;
// Up to 3 passages per article go to the answer model: enough for concrete numbers from the full text, while
// keeping the prompt (6 articles, see answer.js) short enough for an answer in a few seconds.
const PASSAGES_PER_ARTICLE = 3;

// How much each signal counts. They add up to 1. Tuned 2026-11-05 against Juan's 653 ratings of the 25 test
// questions (eval/tune_weights.mjs, eval/runs/2026-11-05/tuning_report.md): the most recency + U.S. weight within
// 0.01 nDCG@10 of the best mix. Was 0.5 / 0.25 / 0.15 / 0.10. Keywords get no weight in the score because they
// added nothing on top of similarity in the ratings; the keyword search still runs and adds candidates.
export const WEIGHTS = { similarity: 0.7, keywords: 0, recency: 0.25, us: 0.05 };
const FIRST_YEAR = 2016;
const LAST_YEAR = 2026;

// Below this cosine similarity the best match is too weak to answer from. Checked by hand on 2026-10-04:
// on-topic questions scored 0.69-0.75; off-topic ones (car brakes, stocks, a broken arm, a drug interaction)
// scored 0.45-0.61.
export const MIN_SIMILARITY = 0.62;

const STOPWORDS = new Set(`a about after again all am an and any are as at be been before being both but by can could
did do does doing down during each few for from further had has have having he her here hers him his how i if in into
is it its just me more most my no nor not now of off on once only or other our out over own same she should so some
such than that the their them then there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your yours older adult adults people person aged age help
helps good bad`.split(/\s+/));

// Run both searches, score each candidate chunk on the four signals, group the chunks by article, and return the
// top `limit` articles with their best passages. topSimilarity is the best meaning match; the caller compares it
// with MIN_SIMILARITY to decide whether to answer at all.
// With `candidates: true` (POST /api/rank for weight tuning, eval/dump_candidates.mjs) it also returns every
// candidate chunk's signal values, so eval/tune_weights.mjs can re-rank them offline with any WEIGHTS: the four
// signals do not depend on the weights, only the final score does.
export async function rankArticles(env, question, { limit = 10, candidates = false } = {}) {
  const [vectorHits, keywordHits] = await Promise.all([vectorSearch(env, question), keywordSearch(env, question)]);

  // Every chunk found by either search, once.
  const ids = [...new Set([...vectorHits.keys(), ...keywordHits.keys()])];
  if (!ids.length) return { articles: [], topSimilarity: 0, ...(candidates ? { candidates: [] } : {}) };
  const chunks = await loadChunks(env, ids);

  const sims = [...vectorHits.values()];
  const kws = [...keywordHits.values()];
  const simRange = range(sims);
  const kwRange = range(kws);

  const scoredChunks = chunks.map((c) => {
    const sim = vectorHits.get(c.chunk_id);
    const kw = keywordHits.get(c.chunk_id);
    const signals = {
      similarity: sim === undefined ? 0 : scale(sim, simRange),
      keywords: kw === undefined ? 0 : scale(kw, kwRange),
      recency: c.pub_year ? Math.max(0, Math.min(1, (c.pub_year - FIRST_YEAR) / (LAST_YEAR - FIRST_YEAR))) : 0,
      // U.S. author affiliation is the main signal; the MeSH tag is a small bonus.
      us: Math.min(1, (c.us_affiliation ? 0.8 : 0) + (c.us_mesh ? 0.2 : 0)),
    };
    return { ...c, score: combineSignals(signals), similarity: sim ?? null, signals };
  });

  const articles = bestChunkPerArticle(scoredChunks).sort((a, b) => b.score - a.score).slice(0, limit);
  for (const a of articles) {
    a.passages = a.passages.sort((x, y) => y.score - x.score).slice(0, PASSAGES_PER_ARTICLE)
      .map((p) => ({ section: p.section, text: p.text }));
  }
  const result = { articles, topSimilarity: sims.length ? Math.max(...sims) : 0 };
  if (candidates) {
    result.candidates = scoredChunks.map((c) => ({ pmid: c.pmid, chunk_id: c.chunk_id, pub_year: c.pub_year, signals: c.signals }));
  }
  return result;
}

// One chunk's score: the weighted sum of its signals. Shared with eval/tune_weights.mjs, so the offline re-ranking
// is exactly the Worker's.
export function combineSignals(signals, weights = WEIGHTS) {
  return Object.entries(weights).reduce((s, [k, w]) => s + w * signals[k], 0);
}

// Group scored chunks ({ pmid, score, ... }) by article. An article takes the score of its best chunk; all its
// chunks are kept as possible passages. Returns the articles in no particular order. Shared with
// eval/tune_weights.mjs.
export function bestChunkPerArticle(scoredChunks) {
  const byPmid = new Map();
  for (const scored of scoredChunks) {
    const best = byPmid.get(scored.pmid);
    if (!best) byPmid.set(scored.pmid, { ...scored, passages: [scored] });
    else {
      best.passages.push(scored);
      if (scored.score > best.score) byPmid.set(scored.pmid, { ...scored, passages: best.passages });
    }
  }
  return [...byPmid.values()];
}

// The question's embedding: bge's query prefix plus the question. Also used by the live PubMed fallback.
export async function embedQuery(env, question) {
  const { data } = await env.AI.run(EMBED_MODEL, { text: [QUERY_PREFIX + question] });
  return data[0];
}

// Meaning search: embed the question with the same model used for the passages, then ask Vectorize for the
// closest chunks. Returns chunk_id -> cosine similarity.
async function vectorSearch(env, question) {
  const res = await env.VECTORIZE.query(await embedQuery(env, question), { topK: VECTOR_TOP_K });
  return new Map(res.matches.map((m) => [m.id, m.score]));
}

// The question's content words: lower case, no stopwords or repeats, at most 12. Used for the keyword search here
// and for the live PubMed search.
export function contentWords(question) {
  const words = question.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, 12);
}

// FTS5 query: the question's content words, OR'ed, so bm25 rewards chunks that match more of them.
export function ftsQuery(question) {
  return contentWords(question).map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

// Keyword search with D1's FTS5 full-text index, ranked by bm25. Returns chunk_id -> keyword score.
// The top rows are picked inside the FTS index first (the inner SELECT), and only those 100 are joined to chunks for
// their chunk_id. Joining before the LIMIT made SQLite look up the chunks row of every match (often over a million
// for common words like "blood" or "type"): 9 to 32 seconds a question, against under 1 second this way, with the
// same results (measured on D1 2026-10-27).
async function keywordSearch(env, question) {
  const match = ftsQuery(question);
  if (!match) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT c.chunk_id, f.bm25
       FROM (SELECT rowid, bm25(chunks_fts) AS bm25 FROM chunks_fts
              WHERE chunks_fts MATCH ?1 ORDER BY bm25 LIMIT ?2) f
       JOIN chunks c ON c.rowid = f.rowid`,
  ).bind(match, KEYWORD_TOP_K).all();
  // bm25() is lower for better matches; flip it so higher is better like the other signals.
  return new Map(results.map((r) => [r.chunk_id, -r.bm25]));
}

// Fetch the text and article details of the candidate chunks from D1, in batches (see the 100-parameter limit).
async function loadChunks(env, ids) {
  const batches = [];
  for (let i = 0; i < ids.length; i += 90) batches.push(ids.slice(i, i + 90));   // D1: 100 bound parameters a query
  const found = await Promise.all(batches.map(async (part) => {
    const { results } = await env.DB.prepare(
      `SELECT c.chunk_id, c.pmid, c.section, c.text, a.title, a.journal, a.pub_date, a.pub_year,
              a.pub_types, a.us_affiliation, a.us_mesh
         FROM chunks c JOIN articles a ON a.pmid = c.pmid
        WHERE c.chunk_id IN (${part.map((_, j) => '?' + (j + 1)).join(',')})`,
    ).bind(...part).all();
    return results;
  }));            // the batches run in parallel
  return found.flat();
}

// Lowest and highest value, for scale().
function range(values) {
  return values.length ? [Math.min(...values), Math.max(...values)] : [0, 0];
}

// Rescale to 0..1 among this question's candidates, so cosine similarity and bm25 (very different scales) can be
// added with WEIGHTS. If all values are equal, each counts fully.
function scale(v, [lo, hi]) {
  return hi > lo ? (v - lo) / (hi - lo) : 1;
}
