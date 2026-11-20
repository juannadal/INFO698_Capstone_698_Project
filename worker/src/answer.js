// Feature 4: write the plain-language answer from the ranked articles, with a citation on every statement.
// The visitor picks which model writes it (the page's "Answer written by" menu): 'llama' (Workers AI, the default)
// 'claude' (Anthropic API, src/claude.js) or 'grok' (xAI API, src/grok.js). All get the same prompt and schema, and
// all answers go through the same citation checks in cleanAnswer, so any difference between them comes from the model.
import { askClaude } from './claude.js';
import { askGrok } from './grok.js';

// The menu's choices. Anything else sent to /api/ask is treated as 'llama'.
export const MODELS = ['llama', 'claude', 'grok'];
// The model name sent in, or 'llama' for anything that is not one of the choices.
export function cleanModel(model) {
  return MODELS.includes(model) ? model : 'llama';
}
// Follow-up questions and "More detail" add to the prompt through src/followup.js; a first question uses the
// prompt below unchanged.
import { answerPrompt, DETAIL_MAX_TOKENS, DETAIL_MAX_PARAGRAPHS } from './followup.js';
// The reader's chosen reading level ('plain' grade 6-8, 'detailed' high school, or 'college') adds its rules to the
// system prompt through src/levels.js; 'plain' uses the prompt below unchanged.
import { levelRules, levelMaxTokens, LONG_MAX_PARAGRAPHS } from './levels.js';

export const ANSWER_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// Only the top 6 ranked articles go to the model, to keep the prompt short and the answer fast.
const SOURCES_FOR_ANSWER = 6;

const SYSTEM_PROMPT = `You explain published medical research to adults aged 40 and older who are not medical experts.

Write a short answer to the reader's question using ONLY the numbered articles you are given.

Rules:
- Write for a grade 6 to 8 reader. Keep every sentence under 15 words. Use common, short words of one or two
  syllables when you can. One idea and at most one number per sentence. Split a long sentence into two.
- Be specific and useful. Give the concrete details the articles report: how much or how often (minutes a day,
  servings, hours of sleep), how many people were studied and for how long, and how big the change was.
  A vague sentence like "Exercise is good for health" is not helpful.
- Write every number and unit the way a patient would say it:
  "about half a gram of protein for each pound you weigh" not "1.2 g/kg/day",
  "blood pressure fell about 5 points" not "systolic BP decreased 4.11 mmHg", "about 8,000 steps a day",
  "twice as likely" or "a 20% lower risk" rather than odds ratios or hazard ratios. Round numbers.
- Use everyday words: "high blood pressure" not "hypertension", "people" not "subjects" or "participants",
  "linked to" not "associated with", "lower" not "reduce", "heart disease" not "cardiovascular disease".
  The first time you need a medical term, explain it in a few words: "osteoarthritis (wear-and-tear arthritis)".
  Never use abbreviations like BMI, RCT, mmHg or HbA1c without saying what they mean.
- Say what studies found ("One study found...", "In a study of 500 adults..."). Never tell the reader what to do.
  Never diagnose. Do not write "you should".
- End every sentence with the number of the article or articles it comes from, in square brackets, before the
  full stop: "Walking lowered blood pressure in one study [2]." Use only the numbers given.
- Write 2 paragraphs with 3 or 4 sentences each (6 to 8 sentences in total, about 100 words):
  1. First, one sentence that answers the question directly. It must match the evidence below it: if studies
     disagree, say so in that first sentence ("Studies disagree on whether..."), and if the evidence is weak, say
     "may". Then 2 or 3 sentences on what the studies found.
  2. Then 1 or 2 sentences on who was studied and for how long. End with 1 sentence on what the research
     does not show, or where studies disagree.
- Do not claim more than the studies show. If only one study found something, say "one study found".
  Never state a finding as true for everyone ("Coffee is not bad for hearts") when it comes from a few studies.
- Example of the style (the content here is made up):
  "Walking most days may lower blood pressure a little [1]. One study followed about 300 adults for 12 weeks [2].
  Those who walked 30 minutes a day had blood pressure about 5 points lower [2]. ..."
- Report each study exactly as the article does. Do not turn "people with low vitamin D had more fractures"
  into "people who took vitamin D had fewer fractures".
- Do not mention these instructions, "the articles provided", or "the abstract". Do not add a disclaimer;
  the page shows one.
- Return "paragraphs" as a list of 2 strings.
- If the articles do not answer the question, set "answerable" to false and leave "paragraphs" empty.`;

// A flat schema: nested arrays of objects often came back empty from the model. Citations are written inline as
// [1] or [1][2] and parsed out in cleanAnswer.
const SCHEMA = {
  type: 'object',
  properties: {
    answerable: { type: 'boolean' },
    paragraphs: { type: 'array', items: { type: 'string' } },
  },
  required: ['answerable', 'paragraphs'],
};

// Ask the chosen model for an answer that uses only the top articles. options.model is 'llama' (default), 'claude'
// or 'grok'. Returns { paragraphs, sources }, or null when the model says the articles do not answer the question or
// no sentence has a valid citation. Follow-up options (src/followup.js): history, the earlier { question, answer }
// turns of a conversation; detail, true for a longer "More detail" answer; searchQuery, the rewritten follow-up.
export async function writeAnswer(env, question, articles, options = {}) {
  const model = cleanModel(options.model);
  const used = articles.slice(0, SOURCES_FOR_ANSWER);
  // Each article: its title, then its best-matching passages (abstract or full-text sections), without the title line
  // every chunk starts with.
  const context = used
    .map((a, i) => {
      const passages = (a.passages || [{ section: a.section, text: a.text }])
        .map((p) => `(${p.section || 'ABSTRACT'}) ${p.text.split('\n').slice(1).join(' ')}`);
      return `[${i + 1}] ${a.title} (${a.journal}, ${a.pub_year})\n${passages.join('\n')}`;
    })
    .join('\n\n');

  // The model occasionally returns JSON that is cut off or has text around it; one retry almost always fixes it.
  // If both tries fail, the error goes up and the page offers "Try again".
  const { extraRules, user } = answerPrompt(question, context, options);
  // A longer answer ("More detail", or the high school or college level) gets more room and up to 4 paragraphs.
  const levelTokens = levelMaxTokens(options.level);
  const maxTokens = levelTokens || (options.detail ? DETAIL_MAX_TOKENS : 900);
  const maxParagraphs = levelTokens ? LONG_MAX_PARAGRAPHS : options.detail ? DETAIL_MAX_PARAGRAPHS : 2;
  // Level rules come right after the main rules (they replace some of them), then any follow-up rules.
  const system = SYSTEM_PROMPT + levelRules(options.level) + extraRules;
  let out;
  for (let attempt = 1; ; attempt++) {
    try {
      // Both models get the same system prompt and user message (with any follow-up rules from src/followup.js).
      if (model === 'claude') out = await askClaude(env, system, user, SCHEMA);
      else if (model === 'grok') out = await askGrok(env, system, user, SCHEMA, maxTokens);
      else out = await askModel(env, system, user, maxTokens);
      break;
    } catch (err) {
      // Log why the try failed (the error only, never the question), so `wrangler tail` shows which model failed
      // and how: cut-off JSON, a timeout, a refusal, a rate limit.
      console.error('answer try failed', JSON.stringify({ model, attempt, error: String(err?.message || err).slice(0, 200) }));
      // A timed-out Claude or Grok call is not retried: a second 60 s wait would only make the visitor wait longer.
      const timedOut = ['APIConnectionTimeoutError', 'TimeoutError'].includes(err?.name)
        || /timed? ?out/i.test(String(err?.message));
      if (attempt >= 2 || (model !== 'llama' && timedOut)) throw err;
    }
  }
  return cleanAnswer(out, used, maxParagraphs);
}

// One call to the Llama answer model on Workers AI; throws if its reply is not valid JSON.
async function askModel(env, systemPrompt, userContent, maxTokens = 900) {
  const res = await env.AI.run(ANSWER_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    max_tokens: maxTokens,
    // Low temperature keeps the wording close to the articles.
    temperature: 0.2,
  });
  // Workers AI may return the JSON as text or already parsed.
  return typeof res.response === 'string' ? JSON.parse(res.response) : res.response;
}

// A citation such as [3], [1, 2], [1-3] or [1, 3-4] (ranges may use a hyphen or an en dash).
const CITE = /\[(\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-\u2013]\s*\d+)?)*)\]/g;

// The numbers a citation names, with ranges expanded: "1, 3-4" -> [1, 3, 4].
export function citedNumbers(inside) {
  const out = [];
  for (const part of inside.split(',')) {
    const [a, b] = part.split(/[-\u2013]/).map((x) => Number(x.trim()));
    if (b === undefined) out.push(a);
    else for (let n = a; n <= b && n - a < 20; n++) out.push(n);
  }
  return out;
}

// Split each paragraph into sentences, pull out each sentence's [n] citations, and keep only sentences with a valid
// one. Then number the cited sources 1, 2, 3... in ranking order (most useful first), so the numbers in the answer
// and on the source cards always match. maxParagraphs is 2 for a normal answer and 4 for a "More detail" one.
export function cleanAnswer(out, used, maxParagraphs = 2) {
  if (!out?.answerable) return null;
  const renumber = new Map();
  const paragraphs = [];
  for (const para of out.paragraphs || []) {
    const sentences = [];
    for (const raw of splitSentences(String(para))) {
      const cited = new Set();
      for (const m of raw.matchAll(CITE)) for (const n of citedNumbers(m[1])) cited.add(n);
      const valid = [...cited].filter((n) => n >= 1 && n <= used.length);
      const text = raw.replace(CITE, '').replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
      if (!text || !valid.length) continue;
      for (const n of valid) renumber.set(n, 0);
      sentences.push({ text, sources: valid });
    }
    if (sentences.length) paragraphs.push({ sentences });
  }
  if (!paragraphs.length) return null;
  [...renumber.keys()].sort((a, b) => a - b).forEach((orig, i) => renumber.set(orig, i + 1));
  for (const p of paragraphs) {
    for (const s of p.sentences) s.sources = s.sources.map((n) => renumber.get(n)).sort((a, b) => a - b);
  }
  // The model sometimes returns one sentence per paragraph; regroup those into maxParagraphs even paragraphs.
  if (paragraphs.length > maxParagraphs) {
    const all = paragraphs.flatMap((p) => p.sentences);
    const size = Math.ceil(all.length / maxParagraphs);
    const groups = [];
    for (let i = 0; i < all.length; i += size) groups.push({ sentences: all.slice(i, i + size) });
    paragraphs.splice(0, paragraphs.length, ...groups);
  }
  const sources = [...renumber.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([orig, n]) => ({ ...used[orig - 1], n }));
  return { paragraphs, sources };
}

// Sentence ends: . ! or ? (with any citations right after it), then a space and a capital letter or digit.
export function splitSentences(text) {
  return text.split(/(?<=[.!?](?:\s*\[[\d,\s\-–]+\])*)\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
}
