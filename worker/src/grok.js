// The Grok option for the answer-writing step: a third choice in the page's "Answer written by" menu, next to Llama
// (Workers AI, the default, src/answer.js) and Claude (src/claude.js). As with Claude, only the writing step changes:
// the search, the ranking, the prompt, the JSON shape and the citation checks in answer.js are the same, so the three
// models' answers can be compared fairly.
//
// Grok is xAI's model. xAI's API speaks the same format as OpenAI's chat completions, so a plain fetch() is enough
// and no SDK is added to the Worker. Needs the Worker secret XAI_API_KEY (from 1Password, Claude vault); with no key,
// /api/config does not list Grok and the page leaves it out of the menu.

// The Grok model, set in wrangler.jsonc ("GROK_MODEL") so it can be changed without a code change.
export const DEFAULT_GROK_MODEL = 'grok-4.20-0309-non-reasoning';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
// Same limit as Claude: long enough for a college-level answer, short enough that a stuck call ends.
const TIMEOUT_MS = 60_000;

// One call to Grok with the same system prompt and question as the Llama call. Returns the parsed
// { answerable, paragraphs } object; throws when the reply is not usable, so answer.js retries once as for Llama.
export async function askGrok(env, systemPrompt, userContent, schema, maxTokens = 2000) {
  const res = await fetch(XAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.XAI_API_KEY}` },
    body: JSON.stringify({
      model: env.GROK_MODEL || DEFAULT_GROK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      // Structured outputs: the reply must be JSON that matches the schema (strict), like Claude's.
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: { ...schema, additionalProperties: false } },
      },
      // Reasoning models count their thinking in this budget too, so it gets more room than Llama's.
      max_tokens: Math.max(maxTokens, 4000),
      // Low temperature keeps the wording close to the articles, as for Llama. (A model that does not take a
      // temperature ignores it.)
      temperature: 0.2,
    }),
    // A timed-out call throws an error named TimeoutError; answer.js does not retry it.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // The status only (e.g. 401 bad key, 429 rate limit), never the body, which can echo the request.
    throw new Error(`Grok request failed with status ${res.status}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Grok reply was cut off');
  return JSON.parse(choice?.message?.content || '');
}
