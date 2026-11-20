// /api/questions.csv: download every question saved in the D1 table query_log as a CSV.
//   GET   ->  a small page with a key box and optional filters (bookmark this).
//   POST  ->  the CSV, when the key is right. The key comes from that page's form field, or from an
//             "Authorization: Bearer <key>" header for scripts.
//
// Why: Juan reviews the questions people ask for the capstone research (what older adults want to know, which
// questions go unanswered). The Worker cannot append to a file, so query_log stays the record and this builds an
// up-to-date CSV from it on each download, without Python or wrangler (scripts/export_query_log.py does the same
// from a terminal).
//
// Who can download: only someone with the Worker secret EXPORT_KEY (set with `npx wrangler secret put EXPORT_KEY`).
// The site will be open to everyone for the poster session, so the Cloudflare Access sign-in alone is not enough.
// The key is sent in the request body, never in the URL, so it stays out of browser history and request logs.
// Without the secret set, or with a wrong key, the answer is a plain 404 so it reveals nothing.
//
// Optional filters: source = app (people: the ask page and the chat page), chat (the chat page only) or automated
// (test runs); since = a UTC date like 2026-10-12.
// An invalid filter value is refused (400) rather than ignored, so a typo never downloads more than was asked for.

// Same columns as scripts/export_query_log.py, plus the time in Arizona (UTC-7 all year, no daylight saving).
const COLUMNS = ['id', 'asked_at', 'asked_at_arizona', 'source', 'model', 'level', 'question', 'corrected_question', 'status', 'pmids',
  'top_similarity', 'grade', 'latency_ms'];

// Handles both methods of /api/questions.csv.
export async function exportQuestions(request, env) {
  if (!env.EXPORT_KEY) return notFound();
  if (request.method === 'GET') return formPage();
  if (request.method !== 'POST') return new Response('Use GET or POST.', { status: 405 });

  // The key and filters come from the form (or the Authorization header, for scripts).
  const form = await readForm(request);
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await sameKey(form.get('key') || bearer, env.EXPORT_KEY))) return notFound();

  // Filters are bound as parameters, never pasted into the SQL text.
  const where = [];
  const params = [];
  const source = form.get('source') || '';
  if (source) {
    if (!['app', 'chat', 'automated'].includes(source)) return badRequest('source must be app, chat or automated.');
    // "People" covers both pages: questions from the chat page are saved with source 'chat'.
    if (source === 'app') {
      where.push("source IN ('app', 'chat')");
    } else {
      where.push('source = ?');
      params.push(source);
    }
  }
  const since = form.get('since') || '';
  if (since) {
    if (!isDate(since)) return badRequest('since must be a date like 2026-10-12.');
    where.push('asked_at >= ?');
    params.push(since);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, asked_at, strftime('%Y-%m-%d %H:%M:%S', asked_at, '-7 hours') AS asked_at_arizona, source, model, level, question,
            corrected_question, status, pmids, top_similarity, grade, latency_ms
       FROM query_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`,
  ).bind(...params).all();

  const lines = [COLUMNS.join(',')];
  for (const row of results) {
    row.pmids = parsePmids(row.pmids).join(' ');
    lines.push(COLUMNS.map((c) => csvCell(row[c])).join(','));
  }
  const day = new Date().toISOString().slice(0, 10);
  // The leading byte-order mark makes Excel read the file as UTF-8, so accented letters show correctly.
  return new Response(`﻿${lines.join('\r\n')}\r\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="questions_${day}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

// The form fields of a POST (empty when the body is not a form, e.g. a script using the Authorization header).
async function readForm(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data')) {
    return new URLSearchParams();
  }
  try { return await request.formData(); } catch { return new URLSearchParams(); }
}

// The download page: a password box (so a password manager can fill it) and the two filters. Submitting it POSTs
// back here and the browser saves the CSV. Plain HTML, no scripts.
function formPage() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Download questions</title>
<style>body{font:18px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
label{display:block;margin-top:1rem}input,select,button{font:inherit;padding:.4rem;width:100%;box-sizing:border-box}
button{margin-top:1.5rem;cursor:pointer}</style></head><body>
<h1>Download saved questions</h1>
<form method="post" action="/api/questions.csv">
<label>Key <input type="password" name="key" autocomplete="current-password" required></label>
<label>Who asked <select name="source"><option value="app">People using the site</option>
<option value="chat">People, chat page only</option>
<option value="automated">Automated test runs</option><option value="">Both</option></select></label>
<label>Asked on or after (optional) <input type="date" name="since"></label>
<button type="submit">Download CSV</button>
</form></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// A real calendar date in YYYY-MM-DD form: "2026-02-31" has the right shape but is refused, because it would not
// round-trip through Date and would silently cut the CSV at the wrong place.
function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

const notFound = () => new Response('Not found', { status: 404 });
const badRequest = (msg) => new Response(msg, { status: 400 });

// Compares the key sent with the secret in constant time, so the response time does not hint at how much of a
// guess was right. Both are hashed first because timingSafeEqual needs inputs of equal length.
async function sameKey(given, secret) {
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, secret].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

// query_log keeps PMIDs as a JSON array; the CSV shows them space-separated, like the Python export.
function parsePmids(value) {
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

// One CSV cell. Text that a visitor typed could start with = + - or @, which Excel and Google Sheets would run as a
// formula, so such text gets a leading apostrophe (shown as plain text). Cells with commas, quotes or line breaks
// are quoted, with inner quotes doubled.
export function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
