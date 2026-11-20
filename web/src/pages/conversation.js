// Helpers for the chat page (src/pages/ChatPage.jsx): the link that opens a chat, and the context sent with each
// message. The Worker uses only the last 3 turns (MAX_TURNS in worker/src/followup.js), so only those are sent.

import { DEFAULT_LEVEL } from './shared.jsx';

const DEFAULT_MODEL = 'llama';

// The chat page's URL for a question. The menus are added only when they are not the defaults (Llama, high school),
// and the chat page reads a missing one as the default, so a shared link keeps the choices it was asked with.
// exact adds &exact=1 (search the words as typed, without spelling correction).
export function chatPath(question, model = DEFAULT_MODEL, level = DEFAULT_LEVEL, exact = false) {
  return '/chat?q=' + encodeURIComponent(question.trim()) + (model !== DEFAULT_MODEL ? '&model=' + model : '')
    + (level !== DEFAULT_LEVEL ? '&level=' + level : '') + (exact ? '&exact=1' : '');
}

export const HISTORY_SENT = 3;

// The answer's sentences as plain text, without citation numbers: the context sent with a follow-up.
export function answerText(result) {
  return (result?.paragraphs || []).map((p) => p.sentences.map((s) => s.text).join(' ')).join('\n');
}

// The history for a new question, from the turns before it. Each turn is sent as the question that was actually
// searched (a follow-up's standalone rewrite), so the topic is never lost, even if the first question has dropped out
// of the last 3. A turn that found no research is sent too, so a follow-up to it still knows the topic.
export function buildHistory(earlier) {
  return earlier.filter((t) => t.status === 'answered' || t.status === 'no_answer').slice(-HISTORY_SENT)
    .map((t) => ({
      question: t.result?.searchedFor || t.result?.correctedQuestion || t.question,
      answer: t.status === 'answered' ? answerText(t.result) : 'No research was found for this question.',
    }));
}
