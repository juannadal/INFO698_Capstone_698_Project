// The weekly refresh (proposal: "update the index weekly with new PubMed articles", milestone 2026-11-20).
// Cloudflare runs it on the schedule in wrangler.jsonc ("triggers"), by itself: no computer needs to be on.
//
// Each run:
// 1. Picks the days to cover: from the day after the last day a run finished (table refresh_log) up to yesterday
//    (UTC). The first run starts at FIRST_DAY, when the collection was harvested. At most MAX_DAYS_PER_RUN days or
//    limits.articlesPerRun new articles per run; anything left (even the rest of a day) is picked up by the next run.
// 2. For each day, asks PubMed (ESearch) for the collection's articles whose MeSH terms were added that day
//    ([mhda], "MeSH date"; see below why not the publication or entry date), keeps the PMIDs not already in D1, and
//    downloads them (EFetch, 200 at a time).
// 3. Drops retractions, errata and articles without an abstract, as the harvest does, and splits each abstract into
//    chunks with the harvest's own rules (src/chunk.js).
// 4. Embeds the chunks with the same model as the rest of the index, saves them to Vectorize, then saves the
//    articles and chunks to D1 (the FTS5 keyword index fills itself through the triggers on chunks). Vectorize goes
//    first: search only shows a Vectorize match whose chunk is in D1, so a run that stops halfway never leaves a
//    half-saved article visible, and the next run simply redoes it. Each article is saved to D1 together with all
//    its chunks in one transaction, so D1 never holds an article without its chunks (which a retry would skip).
// 5. Removes articles PubMed now marks as retracted ("Retracted Publication"), so the site never cites them.
//
// Why the MeSH date: the collection's filter needs MeSH terms (e.g. "Aged"[MeSH]), and PubMed adds those days or
// weeks after an article first appears. Searching by the date an article entered PubMed would miss every article
// still waiting for its MeSH terms, and they would never be picked up later. An article matches the filter from the
// day its MeSH terms are added, so that is the day to collect it.
//
// Same filter as the collection and the live fallback (SCOPES.collection in src/pubmed.js): adults 40+, a
// lifestyle subject, a chronic condition or an internal/family medicine journal, with an abstract, 2016 onward.
// Full-text passages (scripts/fetch_fulltext.py) are not added here; new articles get their abstract only.
//
// Testing without changing anything: set REFRESH_DRY_RUN = "true" (in worker/.dev.vars), run
// `npx wrangler dev --name aler-dev --test-scheduled` in worker/, and open http://localhost:8787/cdn-cgi/handler/scheduled.
// The run does every step except the writes and logs what it would have added.
import { SCOPES, DROP_TYPES, params, parseArticles } from './pubmed.js';
import { EMBED_MODEL } from './search.js';
import { chunkArticle, abstractTokens } from './chunk.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
// The day before the first harvest (2026-10-04): articles indexed from then on may be missing from the collection.
// Articles that are already in D1 are skipped, so starting a little early costs nothing.
const FIRST_DAY = '2026-10-03';
// Limits per run, to stay well inside a scheduled Worker's limits (15 minutes, and a cap on outgoing requests).
// A normal week adds a few hundred articles; the limits only matter for the first run or after missed weeks.
const MAX_DAYS_PER_RUN = 14;
// articlesPerRun counts new PMIDs downloaded; d1Batch is statements per D1 batch. An object so the tests can lower them.
export const limits = { articlesPerRun: 3000, d1Batch: 100 };
// ESearch returns at most 10,000 PMIDs; one day of the collection is far below that (about 100).
const ESEARCH_MAX = 10000;
const EFETCH_BATCH = 200;          // PMIDs per EFetch request, as in the harvest
const EMBED_BATCH = 100;           // Workers AI embeds at most 100 texts per call
const UPSERT_BATCH = 500;          // vectors per Vectorize upsert, as in scripts/vector_loader
// More "Retracted Publication" articles than this at once looks like a broken search, not real retractions, so
// none are removed and the run is marked for a person to check.
const MAX_REMOVALS = 50;
// The first pause before retrying a failed PubMed request (then twice as long each time). The tests shorten it.
export const retry = { pauseMs: 2000 };

// Run one refresh. Called by the scheduled() handler in index.js. Returns a summary (also written to the Worker's
// logs and, unless it is a dry run, to the refresh_log table).
export async function refreshIndex(env) {
  const dryRun = env.REFRESH_DRY_RUN === 'true';
  const delayMs = env.NCBI_API_KEY ? 110 : 350;     // NCBI allows 10 requests a second with a key, 3 without
  const ncbi = (endpoint, extra) => eutils(env, endpoint, extra, delayMs);
  const days = daysToCover(await lastDayDone(env), yesterday());
  const summary = { dryRun, days: days.length, from: days[0] || null, through: null, found: 0, fetched: 0, added: 0,
    chunks: 0, removed: 0, unavailable: [], status: 'ok', note: null };
  let runId = null;
  if (!dryRun) {
    runId = (await env.DB.prepare(
      `INSERT INTO refresh_log (from_day, status) VALUES (?1, 'running') RETURNING id`,
    ).bind(summary.from).first()).id;
  }
  try {
    for (const day of days) {
      const result = await refreshDay(env, ncbi, day, dryRun, limits.articlesPerRun - summary.fetched);
      summary.found += result.found;
      summary.fetched += result.fetched;
      summary.added += result.added;
      summary.chunks += result.chunks;
      summary.unavailable.push(...result.unavailable);
      // A day cut short by the article limit is not marked done: the next run does it again and gets the rest
      // (the articles saved this time are skipped, as they are already in D1).
      if (!result.complete) break;
      summary.through = day;
      // Saved after every day, so a run that stops partway keeps the days it finished.
      if (runId) await saveProgress(env, runId, summary);
    }
    const removal = await removeRetracted(env, ncbi, dryRun);
    summary.removed = removal.removed;
    if (removal.note) { summary.note = removal.note; summary.status = 'check'; }
    if (summary.unavailable.length && !summary.note) {
      summary.note = `PubMed did not return ${summary.unavailable.length} listed articles: ${summary.unavailable.slice(0, 20).join(', ')}`;
    }
  } catch (err) {
    summary.status = 'error';
    summary.note = String(err?.message || err).slice(0, 500);
  }
  if (runId) await saveProgress(env, runId, summary, true);
  console.log('weekly refresh', JSON.stringify(summary));
  return summary;
}

// Add one day's newly indexed articles, downloading at most `budget` new PMIDs. Returns { found, fetched, added,
// chunks, unavailable, complete }: PMIDs PubMed listed, new PMIDs downloaded, articles added (or that would be, in a
// dry run), their chunks, PMIDs PubMed listed but would not return, and whether the whole day was done.
async function refreshDay(env, ncbi, day, dryRun, budget) {
  const term = `${SCOPES.collection} AND ${day.replaceAll('-', '/')}[mhda]`;
  const search = JSON.parse(await ncbi('esearch.fcgi', { term, retmax: String(ESEARCH_MAX), retmode: 'json' }))
    .esearchresult;
  if (Number(search.count) > ESEARCH_MAX) throw new Error(`${day}: ${search.count} results, more than ESearch returns`);
  const found = search.idlist || [];
  const allNew = await notInD1(env, found);
  const missing = allNew.slice(0, Math.max(0, budget));
  const articles = [];
  const unavailable = [];
  for (let i = 0; i < missing.length; i += EFETCH_BATCH) {
    const { got, notReturned } = await fetchArticles(ncbi, missing.slice(i, i + EFETCH_BATCH));
    unavailable.push(...notReturned);
    // The same articles the harvest keeps (chunk() in scripts/harvest_and_chunk.py).
    articles.push(...got.filter((a) => a.abstract_sections.length && !a.pub_types_list.some((t) => DROP_TYPES.has(t))));
  }
  const chunks = articles.flatMap(chunkArticle);
  if (!dryRun && articles.length) {
    await saveVectors(env, chunks);
    await saveToD1(env, articles, chunks);
  }
  return { found: found.length, fetched: missing.length, added: articles.length, chunks: chunks.length, unavailable,
    complete: missing.length === allNew.length };
}

// Download these PMIDs with EFetch. Returns { got: parsed articles, once each, notReturned: PMIDs still missing }.
// An answer that is not a PubMed article set (such as an error message sent with status 200) throws, so the day is
// retried.
// PMIDs missing from an otherwise good answer are asked for once more; any still missing (PubMed can list a record it
// no longer serves, e.g. a deleted duplicate) are reported in the run's note instead of blocking every later run.
async function fetchArticles(ncbi, pmids) {
  const byPmid = new Map();
  let wanted = pmids;
  for (let attempt = 0; attempt < 2 && wanted.length; attempt++) {
    const want = new Set(wanted);
    const xml = await ncbi('efetch.fcgi', { id: wanted.join(','), retmode: 'xml' });
    if (!xml.includes('<PubmedArticleSet')) throw new Error(`EFetch answer is not a PubMed article set: ${xml.slice(0, 100)}`);
    for (const a of parseArticles(xml)) if (want.has(a.pmid) && !byPmid.has(a.pmid)) byPmid.set(a.pmid, a);
    wanted = wanted.filter((id) => !byPmid.has(id));
  }
  return { got: [...byPmid.values()], notReturned: wanted };
}

// Embed the chunks and save them to Vectorize, with the same id and metadata as scripts/vector_loader/worker.js.
async function saveVectors(env, chunks) {
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const part = chunks.slice(i, i + EMBED_BATCH);
    const { data } = await env.AI.run(EMBED_MODEL, { text: part.map((c) => c.text) });
    part.forEach((c, j) => vectors.push({
      id: c.chunk_id,
      values: data[j],
      metadata: { pmid: c.pmid, pub_year: c.pub_year ?? 0, us_affiliation: !!c.us_affiliation },
    }));
  }
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH) await env.VECTORIZE.upsert(vectors.slice(i, i + UPSERT_BATCH));
}

// Save the articles and their chunks to D1, with the same columns as scripts/load_cloudflare.py. Each D1 batch runs
// as one transaction, and an article always goes in the same batch as all its chunks, so a failed batch leaves no
// article without its chunks. INSERT OR IGNORE makes a repeat harmless. added_at is filled in by D1 (the date the
// refresh added the article).
async function saveToD1(env, articles, chunks) {
  const articleSql = env.DB.prepare(
    `INSERT OR IGNORE INTO articles (pmid, title, journal, pub_date, pub_year, pub_types, mesh, affiliations,
       us_affiliation, us_mesh, abstract_tokens) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  );
  const chunkSql = env.DB.prepare(
    `INSERT OR IGNORE INTO chunks (chunk_id, pmid, idx, section, text, token_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  const chunksOf = Map.groupBy(chunks, (c) => c.pmid);
  let batch = [];
  for (const a of articles) {
    const group = [
      articleSql.bind(a.pmid, a.title, a.journal, a.pub_date, a.pub_year, JSON.stringify(a.pub_types_list),
        JSON.stringify(a.mesh), JSON.stringify(a.affiliations), a.us_affiliation ? 1 : 0, a.us_mesh ? 1 : 0,
        abstractTokens(a)),
      ...(chunksOf.get(a.pmid) || []).map((c) => chunkSql.bind(c.chunk_id, c.pmid, c.idx, c.section, c.text, c.token_count)),
    ];
    // Start a new batch rather than split an article across two (a batch may go over d1Batch for one huge article).
    if (batch.length && batch.length + group.length > limits.d1Batch) {
      await env.DB.batch(batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length) await env.DB.batch(batch);
}

// Remove articles that PubMed now marks as retracted. The harvest never loaded retracted articles, but an article
// can be retracted after it was loaded. Returns { removed, note }; note explains why nothing was removed, if so.
async function removeRetracted(env, ncbi, dryRun) {
  const term = `${SCOPES.collection} AND "Retracted Publication"[pt]`;
  const ids = JSON.parse(await ncbi('esearch.fcgi', { term, retmax: String(ESEARCH_MAX), retmode: 'json' }))
    .esearchresult.idlist || [];
  const inD1 = new Set(ids);
  for (const id of await notInD1(env, ids)) inD1.delete(id);
  const pmids = [...inD1];
  if (!pmids.length) return { removed: 0, note: null };
  if (pmids.length > MAX_REMOVALS) {
    return { removed: 0, note: `${pmids.length} retracted articles found; none removed (more than ${MAX_REMOVALS})` };
  }
  if (!dryRun) {
    const list = JSON.stringify(pmids);
    const { results } = await env.DB.prepare(
      'SELECT chunk_id FROM chunks WHERE pmid IN (SELECT value FROM json_each(?1))',
    ).bind(list).all();
    const chunkIds = results.map((r) => r.chunk_id);
    for (let i = 0; i < chunkIds.length; i += 100) await env.VECTORIZE.deleteByIds(chunkIds.slice(i, i + 100));
    // Chunks first (their delete trigger also removes them from the keyword index), then the articles.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM chunks WHERE pmid IN (SELECT value FROM json_each(?1))').bind(list),
      env.DB.prepare('DELETE FROM articles WHERE pmid IN (SELECT value FROM json_each(?1))').bind(list),
    ]);
  }
  console.log('weekly refresh: retracted', JSON.stringify(pmids));
  return { removed: pmids.length, note: null };
}

// The PMIDs in the list that D1 does not have yet. The list goes in as one JSON value (json_each), because D1
// allows only 100 bound values per query.
async function notInD1(env, pmids) {
  if (!pmids.length) return [];
  const { results } = await env.DB.prepare(
    'SELECT value AS pmid FROM json_each(?1) WHERE value NOT IN (SELECT pmid FROM articles)',
  ).bind(JSON.stringify(pmids)).all();
  return results.map((r) => r.pmid);
}

// One E-utilities request (POST, so long PMID lists fit) and its body as text. Waits delayMs first to respect NCBI's
// rate limit, and tries up to 4 times with growing pauses, since NCBI sometimes answers 429 or 5xx.
async function eutils(env, endpoint, extra, delayMs) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(delayMs + (attempt ? retry.pauseMs * 2 ** (attempt - 1) : 0));
    try {
      const res = await fetch(EUTILS + endpoint, { method: 'POST', body: params(env, extra) });
      if (res.ok) return await res.text();
      lastError = new Error(`${endpoint} ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// The last day a refresh finished, or null before the first refresh.
async function lastDayDone(env) {
  const row = await env.DB.prepare('SELECT max(through_day) AS day FROM refresh_log').first();
  return row?.day || null;
}

// Record a run's progress in refresh_log; done = true also records the end time and final status.
async function saveProgress(env, runId, s, done = false) {
  await env.DB.prepare(
    `UPDATE refresh_log SET through_day = ?2, found = ?3, added = ?4, chunks = ?5, removed = ?6, note = ?7,
       status = CASE WHEN ?8 THEN ?9 ELSE status END,
       finished_at = CASE WHEN ?8 THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') END
     WHERE id = ?1`,
  ).bind(runId, s.through, s.found, s.added, s.chunks, s.removed, s.note, done ? 1 : 0, s.status).run();
}

// The days ("YYYY-MM-DD") from the day after lastDone (or FIRST_DAY) through `through`, at most MAX_DAYS_PER_RUN.
export function daysToCover(lastDone, through) {
  const days = [];
  let d = lastDone ? addDays(lastDone, 1) : FIRST_DAY;
  while (d <= through && days.length < MAX_DAYS_PER_RUN) {
    days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

// Yesterday's date in UTC. Today is left for the next run, since PubMed is still adding to it.
function yesterday() {
  return addDays(new Date().toISOString().slice(0, 10), -1);
}

// "YYYY-MM-DD" plus n days.
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Wait ms milliseconds.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
