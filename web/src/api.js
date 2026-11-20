// Talks to the Worker's POST /api/ask (worker/). Set VITE_USE_SAMPLE_API=true in .env to use sample data instead.
//
// The response shape (worker/src/index.js returns it; change both sides together):
//   { status: 'answered',
//     paragraphs: [ { sentences: [ { text: 'One statement.', sources: [1, 2] } ] } ],
//     grade: 7.4,                       // Flesch-Kincaid grade of the answer, or null
//     (every source is cited in the answer, numbered in order of first citation)
//     sources: [ { n: 1, pmid: '12345678', title, journal, date: 'March 2024', us: true, studyType: null,
//                  live: false } ],
//     model: 'llama',                   // who wrote the answer: 'llama' (Workers AI), 'claude' (Anthropic) or 'grok' (xAI)
//     level: 'plain',                   // reading level: 'plain' (grade 6-8), 'detailed' (high school) or 'college'
//     live: false }                     // true: the saved collection had no strong match, so the sources come
//                                       // from a live PubMed search (worker/src/pubmed.js)
//   { status: 'no_answer' }
// Either may also carry correctedQuestion: the question with misspellings fixed, which is what was searched.
// Pass exact: true to search the question as typed, and model: 'claude' or 'grok' to have that model write the answer (the
// default is 'llama'; GET /api/config lists the models the site offers). Pass level: 'detailed' (high school) or
// 'college' for a longer, harder answer (worker/src/levels.js); the API's default is 'plain', grade 6-8.
// Follow-ups: pass history, the conversation so far as [{ question, answer }] (answer as plain text), and the
// question is treated as a follow-up; the reply then also carries searchedFor, the follow-up rewritten as a question
// that makes sense on its own, which is what was searched. Pass detail: true (with a history) for a longer answer to
// the same question ("More detail"). See worker/src/followup.js.
// Every number in a sentence's `sources` must match an `n` in `sources`.

const USE_SAMPLE = import.meta.env.VITE_USE_SAMPLE_API === 'true';

// Ask the Worker (or the sample data). The signal lets the page cancel a request when the question changes.
// On an error reply, throws an Error with the server's message and the HTTP status.
export async function ask(question, { signal, exact = false, model = 'llama', level = 'plain', history = [], detail = false, via } = {}) {
  if (USE_SAMPLE) return sampleAnswer(question, signal, model, history, level);
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // via: 'chat' marks a question asked on the chat page, so query_log can tell chat messages apart.
    body: JSON.stringify({ question, exact, model, level, history, detail, via }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || 'The server returned ' + res.status);
    err.status = res.status;       // 429: too many questions (the message says when to try again)
    throw err;
  }
  return res.json();
}

// The article's PubMed page, linked from each source card.
export function pubmedUrl(pmid) {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

// ---------- sample data ----------
// Placeholder text in [brackets], like the mockups: no health claim or article here is real.
// A question that mentions none of the collection's topics gets "no research found".

const TOPIC_WORDS = /exercis|walk|activ|strength|train|diet|eat|food|nutrition|sleep|lifestyle|habit|weight|blood pressure|heart|aging|ageing|older/i;

// Wait ms milliseconds, or stop early with an AbortError (like fetch) when the request is cancelled.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

// A made-up answer in the real response shape, after a delay like the real one, for working on the page
// without the Worker.
// A follow-up (history given) is always "answered", with a made-up searchedFor.
async function sampleAnswer(question, signal, model, history = [], level = 'plain') {
  await wait(3500, signal);
  if (!history.length && !TOPIC_WORDS.test(question)) return { status: 'no_answer' };
  const src = (n, us) => ({
    n,
    pmid: String(10000000 + n),
    title: `[Sample article ${n} title, exactly as PubMed gives it]`,
    journal: '[Journal name]',
    date: '[Month Year]',
    us,
    studyType: null,
  });
  return {
    status: 'answered',
    paragraphs: [
      {
        sentences: [
          { text: '[One plain sentence that answers the question directly.]', sources: [1] },
          { text: '[Two or three sentences that say what the studies found, in everyday words.]', sources: [1, 2] },
        ],
      },
      {
        sentences: [
          { text: '[A sentence on who was studied and for how long.]', sources: [3] },
          { text: '[A last sentence on what the research does not show, or where studies disagree.]', sources: [2] },
        ],
      },
    ],
    grade: 7,
    model,
    level,
    sources: [src(1, true), src(2, false), src(3, true), src(4, false), src(5, true)],
    ...(history.length ? { searchedFor: `[${question}, rewritten to make sense on its own]` } : {}),
  };
}
