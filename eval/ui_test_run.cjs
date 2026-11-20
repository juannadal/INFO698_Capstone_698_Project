// Asks questions through the real page with Playwright, one at a time, and writes the results to a CSV.
// Each question is typed on the start page, which opens the chat page with it (since 2026-11-09 the chat is the only
// way to ask); the script waits for the reply bubble and reads it.
// The Worker saves these to query_log with source = 'automated' (sent as the X-Test-Source header).
//
// Needs the Worker (cd worker && npx wrangler dev) and the front end (cd web && npm run dev) running, and Playwright
// (npm install playwright). Usage:
//   node eval/ui_test_run.cjs eval/ui_test_questions.csv results.csv [http://127.0.0.1:5173]
const fs = require('fs');
const { chromium } = require('playwright');

const [inFile, outFile, base = 'http://127.0.0.1:5173'] = process.argv.slice(2);

// Read the two-column question file (kind,question). Splits each line at the first comma only, so a question
// may contain commas, but not quotes or line breaks.
function readCsv(path) {
  const [header, ...lines] = fs.readFileSync(path, 'utf8').trim().split('\n');
  const cols = header.split(',');
  return lines.map((l) => {
    const i = l.indexOf(',');
    return { [cols[0]]: l.slice(0, i), [cols[1]]: l.slice(i + 1) };
  });
}

// Same order every run (seeded), so results are comparable between runs.
function shuffle(items, seed = 42) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Quote a value for the output CSV when it contains a comma, quote or line break.
const csv = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

(async () => {
  const questions = shuffle(readCsv(inFile));
  const browser = await chromium.launch();
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Test-Source': 'automated' } });
  const page = await context.newPage();
  const rows = [];
  for (const [i, q] of questions.entries()) {
    // Start each question from the start page, the way a person would.
    await page.goto(base + '/');
    await page.fill('#hl-question', q.question);
    const t = Date.now();
    await page.click('button[type=submit]');
    let status = 'timeout';
    try {
      await page.waitForURL('**/chat**', { timeout: 10000 });
      // Wait for any final state of the reply bubble (class names set in web/src/pages/ChatPage.jsx): an answer,
      // "no research found", the error, or the rate-limit message (recorded as rate_limited, so it is not mixed up
      // with a slow answer).
      await page.waitForSelector('.chat-answer, .chat-no-answer, .chat-error, .chat-limited', { timeout: 60000 });
      status = (await page.$('.chat-answer')) ? 'answered' : (await page.$('.chat-no-answer')) ? 'no_answer'
        : (await page.$('.chat-limited')) ? 'rate_limited' : 'error';
    } catch { /* stays timeout */ }
    const seconds = ((Date.now() - t) / 1000).toFixed(1);
    const text = async (sel) => ((await page.$(sel)) ? (await page.textContent(sel)).trim() : '');
    const row = {
      n: i + 1, kind: q.kind, question: q.question, status, seconds,
      corrected: await text('.chat-corrected strong'),
      grade: (await text('.hl-level-value')).replace('grade ', ''),
      sources: (await page.$$('.hl-source')).length,
      // The first paragraph, without its citation numbers (the page puts an invisible word joiner before each).
      answer: (await text('.chat-answer-p')).replace(/⁠\d+/g, '').slice(0, 300),
    };
    rows.push(row);
    console.log(`${row.n}/${questions.length} ${status} ${seconds}s ${q.kind}: ${q.question}`);
  }
  await browser.close();
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(outFile, [cols.join(','), ...rows.map((r) => cols.map((c) => csv(r[c])).join(','))].join('\n') + '\n');
  console.log(`wrote ${outFile}`);
})();
