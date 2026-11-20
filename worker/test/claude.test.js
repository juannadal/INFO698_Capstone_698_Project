// Tests for src/claude.js, the Claude option of the answer step. No network and no API key: global fetch is replaced
// by a fake Anthropic API that records the request and returns a canned reply.
// Run: node --test worker/test/*.test.js (needs `npm install` in worker/ for @anthropic-ai/sdk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askClaude } from '../src/claude.js';

const SCHEMA = { type: 'object', properties: { answerable: { type: 'boolean' } }, required: ['answerable'] };

// Replace fetch with a fake that answers every call with `reply`; returns the list of requests it saw.
function fakeApi(reply) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return seen;
}

const message = (text, stop_reason = 'end_turn') => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason,
  content: text == null ? [] : [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

test('sends the shared prompt with structured output, low effort and the fallback, and parses the JSON', async () => {
  const seen = fakeApi(message('{"answerable":true,"paragraphs":["One [1]."]}'));
  const out = await askClaude({ ANTHROPIC_API_KEY: 'test-key', CLAUDE_MODEL: 'claude-opus-5-5' }, 'SYSTEM', 'USER', SCHEMA);
  assert.deepEqual(out, { answerable: true, paragraphs: ['One [1].'] });
  const { body, headers } = seen[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.system, 'SYSTEM');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'USER' }]);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.fallbacks, 'default');
  assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.match(headers.get('x-api-key') || headers.get('authorization'), /test-key/);
  assert.equal(body.temperature, undefined);   // Opus 5.5 rejects sampling settings
});

test('throws on a refusal or a cut-off reply, so answer.js retries once', async () => {
  fakeApi(message(null, 'refusal'));
  await assert.rejects(askClaude({ ANTHROPIC_API_KEY: 'k' }, 'S', 'U', SCHEMA), /declined/);
  fakeApi(message('{"answ', 'max_tokens'));
  await assert.rejects(askClaude({ ANTHROPIC_API_KEY: 'k' }, 'S', 'U', SCHEMA), /cut off/);
});
