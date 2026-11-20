// Tests for src/grok.js, the Grok option of the answer step. No network and no API key: global fetch is replaced by a
// fake xAI API that records the request and returns a canned reply.
// Run: node --test worker/test/*.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askGrok } from '../src/grok.js';
import { cleanModel } from '../src/answer.js';

const SCHEMA = { type: 'object', properties: { answerable: { type: 'boolean' } }, required: ['answerable'] };

// Replace fetch with a fake that answers every call with `reply` and `status`; returns the list of requests it saw.
function fakeApi(reply, status = 200) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  };
  return seen;
}

const completion = (content, finish_reason = 'stop') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason }] });

test('sends the shared prompt with a strict JSON schema to xAI and parses the JSON', async () => {
  const seen = fakeApi(completion('{"answerable":true,"paragraphs":["One [1]."]}'));
  const out = await askGrok({ XAI_API_KEY: 'test-key', GROK_MODEL: 'grok-test' }, 'SYSTEM', 'USER', SCHEMA);
  assert.deepEqual(out, { answerable: true, paragraphs: ['One [1].'] });
  const { url, headers, body } = seen[0];
  assert.equal(url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(headers.get('authorization'), 'Bearer test-key');
  assert.equal(body.model, 'grok-test');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'USER' }]);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
});

test('a failed request throws with the status only', async () => {
  fakeApi({ error: 'bad key' }, 401);
  await assert.rejects(askGrok({ XAI_API_KEY: 'x' }, 'S', 'U', SCHEMA), /status 401/);
});

test('a cut-off reply throws so answer.js can retry', async () => {
  fakeApi(completion('{"answerable":tr', 'length'));
  await assert.rejects(askGrok({ XAI_API_KEY: 'x' }, 'S', 'U', SCHEMA), /cut off/);
});

test('cleanModel accepts the three models and turns anything else into llama', () => {
  assert.equal(cleanModel('grok'), 'grok');
  assert.equal(cleanModel('claude'), 'claude');
  assert.equal(cleanModel('gpt'), 'llama');
  assert.equal(cleanModel(undefined), 'llama');
});
