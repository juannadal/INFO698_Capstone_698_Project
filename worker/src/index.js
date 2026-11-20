// POST /api/ask   { question, exact, model, level, history, detail }  ->  the answer shape documented at the top of
//                 web/src/api.js. Misspelled words are corrected first (correctedQuestion in the reply) unless exact
//                 is true. model picks who writes the answer: 'llama' (Workers AI, the default), 'claude'
//                 (Anthropic API, src/claude.js) or 'grok' (xAI API, src/grok.js). history (optional) is the conversation so far, [{ question, answer }],
//                 which makes question a follow-up; detail: true asks for a longer answer to the same question
//                 (src/followup.js). level is 'plain' (grade 6-8, the API default), 'detailed' (high school,
//                 grade 10-12) or 'college' (src/levels.js).
// GET  /api/config               ->  { logQuestions, models }  (models: the choices for the page's menu)
// POST /api/rank  { question, candidates }  ->  the top 10 ranked articles with their signals, for the ranking
//                 evaluation; with candidates: true, also every candidate chunk's signals, for weight tuning
// GET  /api/questions.csv  ->  a key form; POST it  ->  every saved question as a CSV, for Juan only (src/export.js)
// Everything else is the React build (see "assets" in wrangler.jsonc).
// Weekly, on the schedule in wrangler.jsonc ("triggers"), scheduled() adds new PubMed articles (src/refresh.js).
//
// Privacy: when LOG_QUESTIONS is "true" (wrangler.jsonc), each question is saved to the D1 table query_log for
// testing and evaluation, with emails and phone numbers removed. No IP address, browser or account data is saved,
// and questions never go to the console logs.
import { rankArticles, MIN_SIMILARITY } from './search.js';
import { writeAnswer, MODELS, cleanModel } from './answer.js';
import { fleschKincaidGrade } from './readability.js';
import { correctSpelling } from './spelling.js';
import { livePubmedSearch } from './pubmed.js';
import { exportQuestions } from './export.js';
import { refreshIndex } from './refresh.js';
import { cleanHistory, standaloneQuery } from './followup.js';
import { cleanLevel } from './levels.js';

// Longer questions are cut to this many characters, which keeps the prompt small.
const MAX_QUESTION = 300;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

// The Worker's entry point: Cloudflare calls fetch() for each request that reaches the Worker.
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Tells the page whether questions are being saved, so its privacy notice is accurate.
    // Also lists the answer models this deployment can use, so the page only offers Claude when its key is set.
    if (pathname === '/api/config') return json({ logQuestions: env.LOG_QUESTIONS === 'true', models: availableModels(env) });
    // The research CSV of saved questions; needs the EXPORT_KEY secret (src/export.js).
    if (pathname === '/api/questions.csv') return exportQuestions(request, env);
    if (pathname === '/api/ask' || pathname === '/api/rank') {
      // For the Server-Timing "total": the whole request, including the rate limit and daily cap checks below.
      const requestStarted = Date.now();
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      // The visitor's IP address is only used as the rate-limit key here; it is never saved.
      if (env.ASK_LIMITER) {
        const { success } = await env.ASK_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
        if (!success) return json({ error: 'Too many questions. Please wait a minute and try again.' }, 429);
      }
      let question;
      let exact = false;
      let withCandidates = false;
      let history = [];
      let detail = false;
      let model = 'llama';
      let level = 'plain';
      let via = 'app';
      try {
        const body = await request.json();
        question = String(body.question || '').trim().slice(0, MAX_QUESTION);
        exact = body.exact === true;
        withCandidates = body.candidates === true;
        // A follow-up carries the conversation so far; anything malformed in it is dropped (src/followup.js).
        history = cleanHistory(body.history);
        // "More detail" only makes sense after an answer, so it needs a history.
        detail = body.detail === true && history.length > 0;
        if (MODELS.includes(body.model)) model = body.model;
        level = cleanLevel(body.level);
        // Where the question was asked: the chat page sends via: 'chat'; anything else counts as the ask page.
        if (body.via === 'chat') via = 'chat';
      } catch {
        return json({ error: 'Send JSON: { "question": "..." }' }, 400);
      }
      if (!question) return json({ error: 'The question is empty.' }, 400);
      if (pathname === '/api/rank') return json(await rank(env, question, withCandidates));
      // A model this site cannot use (e.g. a saved or shared &model=claude link after the Claude key was removed) falls
      // back to Llama, and the reply's model field says so, rather than failing the question.
      if (!availableModels(env).includes(model)) model = 'llama';
      // A second, smaller daily cap for each paid model (Claude, Grok), because their answers cost many times a Llama
      // one (see CLAUDE_DAILY_CAP and GROK_DAILY_CAP in wrangler.jsonc). Same table and same rule as the site cap
      // below, on a row named '<model>:<day>'. It is checked first, so a question turned away here never uses up the
      // site's allowance, which Llama answers still need.
      const paid = PAID_MODELS[model];
      if (paid && env[paid.cap]) {
        const counted = await env.DB.prepare(
          `INSERT INTO daily_usage (day, n) VALUES (?2 || ':' || date('now'), 1)
           ON CONFLICT(day) DO UPDATE SET n = n + 1 WHERE n < ?1 RETURNING n`,
        ).bind(Number(env[paid.cap]), model).first();
        if (!counted) {
          return json({ error: `${paid.name} has reached its limit for today. Please choose Llama, or try again tomorrow.` }, 429);
        }
      }
      // A daily cap on questions for the whole site. A follow-up or "More detail" is its own request, so it is
      // counted here (and by the per-visitor limiter above) like any other question. Cloudflare's per-visitor limiter is approximate, so this is
      // what actually bounds the Workers AI bill (about $0.0014 per question). It is counted only for valid
      // questions, and once the cap is reached the counter stops growing (no row comes back, so no write is made).
      if (env.DAILY_QUESTION_CAP) {
        const counted = await env.DB.prepare(
          `INSERT INTO daily_usage (day, n) VALUES (date('now'), 1)
           ON CONFLICT(day) DO UPDATE SET n = n + 1 WHERE n < ?1 RETURNING n`,
        ).bind(Number(env.DAILY_QUESTION_CAP)).first();
        if (!counted) {
          return json({ error: 'This tool has reached its limit for today. Please try again tomorrow.' }, 429);
        }
      }
      const started = Date.now();
      // How long each step took, in ms: sent back as a Server-Timing header (browser developer tools show it under
      // Network > Timing) and written to the Worker's logs, so slow steps can be found. Never includes the question.
      const timings = {};
      let result;
      let corrected = null;
      // What is searched: the question, or for a follow-up, the follow-up rewritten to make sense on its own.
      let searchQuery = question;
      try {
        // "More detail" re-sends a question that was already corrected and searched, so it skips both steps.
        if (!exact && !detail) corrected = await timed(timings, 'spelling', correctSpelling(env, question));
        if (history.length && !detail) {
          searchQuery = await timed(timings, 'rewrite', standaloneQuery(env, corrected || question, history));
        } else {
          searchQuery = corrected || question;
        }
        result = await ask(env, corrected || question, timings, { history, detail, searchQuery, model, level });
        if (corrected) result.correctedQuestion = corrected;
        // For a follow-up the page shows what was searched, so the reader can see how it was understood.
        if (history.length && !detail) result.searchedFor = searchQuery;
      } catch (err) {
        console.error('ask failed', err?.message);   // the error only, never the question
        result = { status: 'error' };
      }
      if (env.LOG_QUESTIONS === 'true') {
        // Automated test runs send X-Test-Source: automated so they stay separate from people's questions. Questions
        // from the chat page are saved with source 'chat', so chat use can be compared with the ask page's.
        const source = request.headers.get('X-Test-Source') === 'automated' ? 'automated' : via;
        // For a follow-up, corrected_question holds the rewritten question that was searched (it says what a short
        // follow-up like "How much?" meant), and "More detail" requests are saved as "More detail: <question>".
        const logged = detail ? `More detail: ${question}` : question;
        const searched = history.length && !detail && searchQuery !== question ? searchQuery : corrected;
        ctx.waitUntil(logQuestion(env, logged, searched, result, Date.now() - started, source, model, level));
      }
      // _log is only for query_log (similarity and PMIDs); it is left out of the reply to the page.
      const { _log, ...body } = result;
      timings.total = Date.now() - requestStarted;
      console.log('ask timings', JSON.stringify({ status: result.status, model, level, ...timings }));
      const headers = { 'Server-Timing': Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', ') };
      return result.status === 'error' ? json({ error: 'Something went wrong.' }, 500, headers) : json(body, 200, headers);
    }
    // Only /api/* runs the Worker first (run_worker_first in wrangler.jsonc); the React build is served without it.
    // So this is normally reached only by an unknown /api/ path, which gets a 404.
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },

  // Cloudflare calls scheduled() on the cron schedule in wrangler.jsonc: the weekly refresh of the index.
  // waitUntil keeps the Worker running until the refresh finishes.
  scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshIndex(env));
  },
};

// The paid answer models: the Worker secret each needs, its own daily cap setting, and its name for messages.
const PAID_MODELS = {
  claude: { key: 'ANTHROPIC_API_KEY', cap: 'CLAUDE_DAILY_CAP', name: 'Claude' },
  grok: { key: 'XAI_API_KEY', cap: 'GROK_DAILY_CAP', name: 'Grok' },
};

// The answer models this deployment can use: Llama always, each paid model only when its secret is set.
function availableModels(env) {
  return MODELS.filter((m) => m === 'llama' || (PAID_MODELS[m] && env[PAID_MODELS[m].key]));
}

// Search, then write the answer. When the saved index has no strong match, or the model says its articles do not
// answer the question, PubMed is searched live (src/pubmed.js) and the answer is written from what it finds.
// Returns no_answer when that fails too, so the page never shows a guess. _log carries data for query_log.
// timings collects each step's time in ms (see timed()). options is { model, level, history, detail, searchQuery }: model
// ('llama', 'claude' or 'grok') writes the answer; for a follow-up (src/followup.js) searchQuery is what gets searched, and
// the answer model also sees the conversation so far.
async function ask(env, question, timings = {}, options = {}) {
  const searchQuery = options.searchQuery || question;
  // The model that writes the answer, normalized as in writeAnswer(), so the reply can say which one it was.
  const model = cleanModel(options.model);
  const { articles, topSimilarity } = await timed(timings, 'search', rankArticles(env, searchQuery));
  let _log = { topSimilarity, pmids: articles.map((a) => a.pmid) };
  // Answer from the index when its best match is strong enough.
  let answer = null;
  if (articles.length && topSimilarity >= MIN_SIMILARITY) {
    answer = await timed(timings, 'answer', writeAnswer(env, question, articles, options));
  }

  // The fallback: a live PubMed search, with the same similarity cutoff.
  let live = false;
  if (!answer) {
    const found = await timed(timings, 'live_search', livePubmedSearch(env, searchQuery));
    _log = { ..._log, live: { topSimilarity: found.topSimilarity, pmids: found.articles.map((a) => a.pmid) } };
    if (found.articles.length) {
      answer = await timed(timings, 'live_answer', writeAnswer(env, question, found.articles, options));
      live = !!answer;
    }
  }
  if (!answer) return { status: 'no_answer', _log };

  return {
    _log: { topSimilarity: live ? _log.live.topSimilarity : topSimilarity, pmids: answer.sources.map((a) => a.pmid), live },
    status: 'answered',
    // Which model wrote the answer, so the page can say so.
    model,
    // The reading level it was written at, so the page compares the grade with that level's target.
    level: cleanLevel(options.level),
    // true when the sources came from the live PubMed search, not the saved collection (the page says so).
    live,
    paragraphs: answer.paragraphs,
    grade: fleschKincaidGrade(answer.paragraphs.flatMap((p) => p.sentences.map((s) => s.text))),
    sources: answer.sources.map((a) => ({
      n: a.n,
      pmid: a.pmid,
      title: a.title,
      journal: a.journal,
      date: formatDate(a.pub_date),
      us: !!a.us_affiliation,
      studyType: studyType(a.pub_types),
      live: !!a.live,
    })),
  };
}

// Remove emails and phone numbers before a question is saved.
export function redact(question) {
  return question
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]');
}

// The status saved in query_log: the reply's status, except that answers from the live PubMed search are saved as
// 'answered_live' so they can be counted (the page itself gets status 'answered' with live: true).
function logStatus(result) {
  return result.status === 'answered' && result.live ? 'answered_live' : result.status;
}

// Save one question to query_log (only when LOG_QUESTIONS is on). It runs after the reply is sent (ctx.waitUntil),
// so it never slows the answer, and a failure here never breaks it. The question is redacted first.
// model is the answer model the visitor chose ('llama', 'claude' or 'grok'; migrations/0006_query_log_model.sql), and level
// the reading level ('plain', 'detailed' or 'college'; migrations/0007_query_log_level.sql).
async function logQuestion(env, question, corrected, result, latencyMs, source, model, level = 'plain') {
  try {
    // Skip a repeat of the same question within 30 seconds (a page reload, or React re-running the request in
    // development), so each question asked is saved once. The same question with the other model or level, or from the
    // other page (ask or chat), is saved too.
    await env.DB.prepare(
      `INSERT INTO query_log (question, status, pmids, top_similarity, grade, latency_ms, corrected_question, source,
                              model, level)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
        WHERE NOT EXISTS (SELECT 1 FROM query_log WHERE question = ?1 AND model = ?9 AND level = ?10 AND source = ?8
                            AND asked_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 seconds'))`,
    ).bind(redact(question), logStatus(result), JSON.stringify(result._log?.pmids || []),
      result._log?.topSimilarity ?? null, result.grade ?? null, latencyMs, corrected ? redact(corrected) : null, source,
      model, level).run();
  } catch (err) {
    console.error('query log failed', err?.message);
  }
}

// For POST /api/rank: the ranked articles with each signal's value, so the ranking can be scored
// (precision@10, nDCG@10) and WEIGHTS tuned without paying for an answer each time. withCandidates adds every
// candidate chunk's signals (eval/dump_candidates.mjs), so eval/tune_weights.mjs can try weights offline.
async function rank(env, question, withCandidates = false) {
  const { articles, topSimilarity, candidates } = await rankArticles(env, question, { candidates: withCandidates });
  return {
    // Full precision (not rounded), so the offline re-ranking breaks near-ties exactly as the Worker does.
    ...(candidates ? { candidates } : {}),
    topSimilarity,
    articles: articles.map((a) => ({
      pmid: a.pmid, title: a.title, pub_year: a.pub_year, score: round(a.score), similarity: round(a.similarity),
      signals: Object.fromEntries(Object.entries(a.signals).map(([k, v]) => [k, round(v)])),
    })),
  };
}

// "2024 Mar 15", "2024 Mar", "2024" -> "March 2024", "March 2024", "2024"
export function formatDate(pubDate) {
  const [year, month] = String(pubDate || '').split(' ');
  if (!year) return '';
  const i = MONTHS.findIndex((m) => m.slice(0, 3).toLowerCase() === String(month || '').slice(0, 3).toLowerCase());
  const n = Number(month);
  if (i >= 0) return `${MONTHS[i]} ${year}`;
  if (n >= 1 && n <= 12) return `${MONTHS[n - 1]} ${year}`;
  return year;
}

// The most informative PubMed publication type, in a patient's words. Null when none applies.
export function studyType(pubTypes) {
  let types = [];
  try { types = JSON.parse(pubTypes || '[]'); } catch { /* leave empty */ }
  const has = (t) => types.includes(t);
  if (has('Meta-Analysis') || has('Systematic Review')) return 'Review of many studies';
  if (has('Randomized Controlled Trial')) return 'Clinical trial';
  if (has('Review')) return 'Review';
  return null;
}

// Three decimals, so /api/rank output is easy to read.
const round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

// Wait for one step of /api/ask and save how long it took (ms) under `name` in timings, even when it fails.
async function timed(timings, name, promise) {
  const t = Date.now();
  try {
    return await promise;
  } finally {
    timings[name] = Date.now() - t;
  }
}

// A JSON response. no-store so no browser or cache ever keeps an answer or an error.
function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
