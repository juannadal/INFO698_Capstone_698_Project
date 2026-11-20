// Follow-up questions: lets a reader keep asking about an answer, like a chat, instead of starting over.
//
// A follow-up such as "How much is enough?" cannot be searched on its own: it only makes sense next to the question
// before it. So each follow-up goes through three steps (worker/src/index.js runs them):
//   1. cleanHistory() trims what the page sent about the earlier questions and answers to a safe, small size.
//   2. standaloneQuery() asks a small, fast model to rewrite the follow-up into a question that makes sense alone
//      ("How much walking a day lowers blood pressure?"). That rewritten question is what gets searched, so a
//      follow-up finds fresh articles about what the reader is asking now.
//   3. answerPrompt() gives the answer model the earlier questions and answers for context, with rules to add new
//      information rather than repeat it. The answer is still written ONLY from the numbered articles, every
//      sentence still needs a citation, and uncited sentences are still dropped (answer.js, cleanAnswer).
//
// "More detail" is a follow-up too: the page sends the previous (already searchable) question again with
// detail: true, so it is searched again without a rewrite, and the answer model is asked for a longer answer
// (DETAIL_RULES) with the specifics a short answer leaves out.
//
// The page keeps the conversation (web/src/pages/AskPage.jsx) and sends it with each request; the Worker keeps
// nothing between requests. Each follow-up is a separate request, so the per-visitor rate limit and the daily
// question cap count it as one question, like any other.

// A small model is enough to rewrite one question and is much faster than the answer model (well under a second).
export const REWRITE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
// Only the last few turns matter for a follow-up, and a short history keeps both prompts small and fast.
export const MAX_TURNS = 3;
const MAX_TURN_QUESTION = 300;     // the same limit as a question (MAX_QUESTION in index.js)
const MAX_TURN_ANSWER = 1200;      // about 200 words: a full detailed answer, cut if longer
// A detailed answer is about twice as long, so it gets more room.
export const DETAIL_MAX_TOKENS = 1500;
export const DETAIL_MAX_PARAGRAPHS = 4;

// Keep only well-formed turns ({ question, answer } strings), the last MAX_TURNS of them, each cut to a safe length.
// Anything else the page (or anyone calling the API) sends is ignored, so a bad history can never break a request.
export function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && typeof t.question === 'string' && typeof t.answer === 'string' && t.question.trim())
    .slice(-MAX_TURNS)
    .map((t) => ({
      question: t.question.trim().slice(0, MAX_TURN_QUESTION),
      answer: t.answer.trim().slice(0, MAX_TURN_ANSWER),
    }));
}

// The earlier turns as plain text, oldest first, for both prompts.
export function historyText(history) {
  return history.map((t, i) => `Question ${i + 1}: ${t.question}\nAnswer ${i + 1}: ${t.answer}`).join('\n\n');
}

const REWRITE_PROMPT = `You rewrite a follow-up question so it can be searched on its own.

You get an earlier conversation about health research and the reader's follow-up question. Rewrite the follow-up
as ONE short, complete question that makes sense without the conversation: replace words like "it", "that", "this"
or "they" with what they mean, and add the topic from the conversation when the follow-up leaves it out.
Keep the reader's meaning. Do not answer the question. Do not add new topics.
If the follow-up already makes sense on its own, return it unchanged.
Return JSON: {"query": "the rewritten question"}.`;

const REWRITE_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

// The follow-up rewritten as a question that can be searched alone. If the model fails or returns something odd,
// the follow-up is searched together with the previous question instead: less precise, but it always works.
export async function standaloneQuery(env, question, history) {
  if (!history.length) return question;
  // The new question is kept whole; the previous one is cut, if needed, to fit in front of it.
  const room = Math.max(0, MAX_TURN_QUESTION - question.length - 1);
  const fallback = `${history[history.length - 1].question.slice(0, room)} ${question}`.trim().slice(0, MAX_TURN_QUESTION);
  try {
    const res = await env.AI.run(REWRITE_MODEL, {
      messages: [
        { role: 'system', content: REWRITE_PROMPT },
        { role: 'user', content: `Conversation:\n\n${historyText(history)}\n\nFollow-up question: ${question}` },
      ],
      response_format: { type: 'json_schema', json_schema: REWRITE_SCHEMA },
      max_tokens: 120,
      temperature: 0,
    });
    const out = typeof res.response === 'string' ? JSON.parse(res.response) : res.response;
    const query = String(out?.query || '').trim().slice(0, MAX_TURN_QUESTION);
    // A rewrite much longer than a question means the model answered instead of rewriting.
    return query && query.length < MAX_TURN_QUESTION ? query : fallback;
  } catch {
    return fallback;
  }
}

// Added to the answer model's rules when the question is a follow-up.
const FOLLOW_UP_RULES = `
This question is a follow-up in a conversation. The earlier questions and answers are given only so you know what
the reader already knows. Do not cite them and do not repeat what they say. Answer the new question with new
information from the numbered articles. If the articles add nothing new, say what they do show about the new question.`;

// Added when the reader pressed "More detail". These rules win over the length rules above them.
const DETAIL_RULES = `
The reader read the earlier answer and asked for MORE DETAIL on the same question. Go deeper than that answer. Ignore the length limit above. Write 3 or 4 paragraphs with 3 to 5 sentences each
(about 200 to 250 words). Keep every other rule, including the reading level, and a citation on every sentence.
Give the specifics a short answer leaves out: the size and length of each study, the exact amounts or doses, how
big the changes were, which groups of people benefited more or less, and how strong the evidence is (a review of many
studies, a clinical trial, or one smaller study). Explain any medical term the first time you use it.
Return "paragraphs" as a list of 3 or 4 strings.`;

// The extra system-prompt text and the user message for one answer. articlesText is the numbered articles
// (built in answer.js). With no history and no detail this is exactly the original prompt, so a first question is
// answered just as before. For "More detail", question is the earlier question again (already searchable alone) and
// the earlier answer is in history, so the model knows what to go beyond.
export function answerPrompt(question, articlesText, { history = [], detail = false, searchQuery } = {}) {
  let extraRules = '';
  if (detail) extraRules = DETAIL_RULES;
  else if (history.length) extraRules = FOLLOW_UP_RULES;
  let user = `Articles:\n\n${articlesText}\n\n`;
  if (history.length) {
    user += `Earlier in this conversation (for context only, do not cite):\n\n${historyText(history)}\n\n`;
  }
  if (history.length && !detail) {
    user += `Follow-up question: ${question}`;
    // The rewritten question says what a short follow-up ("How much?") means.
    if (searchQuery && searchQuery !== question) user += `\n(In other words: ${searchQuery})`;
  } else {
    user += `Question: ${question}`;
  }
  return { extraRules, user };
}
