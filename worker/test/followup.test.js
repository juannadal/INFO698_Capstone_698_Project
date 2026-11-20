// Checks the follow-up question helpers (src/followup.js) and how cleanAnswer groups paragraphs (src/answer.js),
// without calling any model: the model call is replaced by a fake env.AI.
// Run from the repo root with `node --test worker/test/*.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHistory, standaloneQuery, answerPrompt, MAX_TURNS } from '../src/followup.js';
import { cleanAnswer } from '../src/answer.js';

const turn = (n) => ({ question: `Question ${n}?`, answer: `Answer ${n}.` });

test('cleanHistory keeps only well-formed turns, the last few, cut to length', () => {
  assert.deepEqual(cleanHistory(undefined), []);
  assert.deepEqual(cleanHistory('nope'), []);
  const mixed = [turn(1), null, { question: 5, answer: 'x' }, { question: '  ', answer: 'x' }, turn(2)];
  assert.deepEqual(cleanHistory(mixed), [turn(1), turn(2)]);
  const many = Array.from({ length: 8 }, (_, i) => turn(i));
  assert.equal(cleanHistory(many).length, MAX_TURNS);
  assert.equal(cleanHistory(many)[0].question, `Question ${8 - MAX_TURNS}?`);
  const long = cleanHistory([{ question: 'q'.repeat(1000), answer: 'a'.repeat(5000) }])[0];
  assert.ok(long.question.length <= 300 && long.answer.length <= 1200);
});

// A fake Workers AI binding that returns `reply` (or throws when reply is an Error).
const fakeEnv = (reply) => ({ AI: { run: async () => { if (reply instanceof Error) throw reply; return { response: reply }; } } });

test('standaloneQuery uses the rewrite, or falls back to the previous question plus the follow-up', async () => {
  const history = [{ question: 'Does walking lower blood pressure?', answer: 'It may [1].' }];
  assert.equal(await standaloneQuery(fakeEnv('{"query":"How much walking lowers blood pressure?"}'), 'How much?', history),
    'How much walking lowers blood pressure?');
  assert.equal(await standaloneQuery(fakeEnv({ query: 'Parsed already?' }), 'x', history), 'Parsed already?');
  const fallback = 'Does walking lower blood pressure? How much?';
  assert.equal(await standaloneQuery(fakeEnv(new Error('down')), 'How much?', history), fallback);
  assert.equal(await standaloneQuery(fakeEnv('not json'), 'How much?', history), fallback);
  assert.equal(await standaloneQuery(fakeEnv('{"query":""}'), 'How much?', history), fallback);
  // A long previous question is cut so the new question still fits.
  const longPrev = [{ question: 'w'.repeat(300), answer: '' }];
  const cut = await standaloneQuery(fakeEnv(new Error('down')), 'What about swimming instead?', longPrev);
  assert.ok(cut.endsWith(' What about swimming instead?') && cut.length <= 300);
  // No history: nothing to rewrite, and no model call.
  assert.equal(await standaloneQuery(fakeEnv(new Error('should not be called')), 'Alone?', []), 'Alone?');
});

test('answerPrompt leaves a first question exactly as before', () => {
  const { extraRules, user } = answerPrompt('Is coffee safe?', '[1] A study');
  assert.equal(extraRules, '');
  assert.equal(user, 'Articles:\n\n[1] A study\n\nQuestion: Is coffee safe?');
});

test('answerPrompt adds the conversation for a follow-up, and detail rules for "More detail"', () => {
  const history = [turn(1)];
  const f = answerPrompt('How much?', '[1] A study', { history, searchQuery: 'How much coffee is safe?' });
  assert.match(f.extraRules, /follow-up/);
  assert.match(f.user, /Question 1: Question 1\?\nAnswer 1: Answer 1\./);
  assert.match(f.user, /Follow-up question: How much\?\n\(In other words: How much coffee is safe\?\)$/);
  const d = answerPrompt('Is coffee safe?', '[1] A study', { history, detail: true });
  assert.match(d.extraRules, /MORE DETAIL/);
  assert.doesNotMatch(d.extraRules, /follow-up in a conversation/);
  assert.match(d.user, /Question: Is coffee safe\?$/);
});

test('cleanAnswer regroups one-sentence paragraphs into 2, or up to 4 for a detailed answer', () => {
  const used = Array.from({ length: 6 }, (_, i) => ({ pmid: String(i + 1) }));
  const paragraphs = Array.from({ length: 8 }, (_, i) => `Sentence ${i + 1} here [${(i % 3) + 1}].`);
  const out = { answerable: true, paragraphs };
  assert.equal(cleanAnswer(out, used).paragraphs.length, 2);
  const detailed = cleanAnswer(out, used, 4);
  assert.equal(detailed.paragraphs.length, 4);
  assert.deepEqual(detailed.paragraphs.map((p) => p.sentences.length), [2, 2, 2, 2]);
  // Fewer paragraphs than the limit are left alone.
  assert.equal(cleanAnswer({ answerable: true, paragraphs: paragraphs.slice(0, 3) }, used, 4).paragraphs.length, 3);
});

test('reading levels: plain adds nothing, detailed replaces the grade 6-8 rules', async () => {
  const { cleanLevel, levelRules } = await import('../src/levels.js');
  assert.equal(cleanLevel(undefined), 'plain');
  assert.equal(cleanLevel('expert'), 'plain');
  assert.equal(cleanLevel('detailed'), 'detailed');
  assert.equal(levelRules('plain'), '');
  assert.match(levelRules('detailed'), /grade 10 to 12/);
  assert.match(levelRules('detailed'), /REPLACE/);
  assert.equal(cleanLevel('college'), 'college');
  assert.match(levelRules('college'), /READING LEVEL: COLLEGE/);
});
