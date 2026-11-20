// The Claude option for the answer-writing step (Feature 4). The page's "Answer written by" menu lets a visitor pick
// Llama on Workers AI (the default, src/answer.js) or Claude through the Anthropic API (this file). Only the writing
// step changes: spelling, search, ranking and the live PubMed fallback are the same for both, and so are the prompt,
// the JSON shape and the citation checks in answer.js, so the two models' answers can be compared fairly.
//
// Needs the Worker secret ANTHROPIC_API_KEY (from the 1Password item "Anthropic API key" in the Claude vault). With no
// key, /api/config says Claude is not available and the page hides the menu.
import Anthropic from '@anthropic-ai/sdk';

// The Claude model, set in wrangler.jsonc ("CLAUDE_MODEL") so it can be changed without a code change.
// Claude Opus 5.5 is Anthropic's current default model: $4 per million input tokens, $20 per million output tokens.
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

// One call to Claude with the same system prompt and question as the Llama call. Returns the parsed
// { answerable, paragraphs } object; throws when the reply is not usable, so answer.js retries once as it does for Llama.
export async function askClaude(env, systemPrompt, userContent, schema) {
  // Timeout 60 s, no SDK retries. A short answer takes 5 to 15 seconds, but a college-level answer (about 400 words,
  // plus Claude's thinking) can take 30 seconds or more, so the old 30 s limit cut off good answers while Llama, which
  // is faster, still answered. The SDK also retried a timed-out call by itself, so a slow answer could make the
  // visitor wait minutes before seeing an error. answer.js already retries once, so the SDK does not need to.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 60_000 });
  const res = await client.beta.messages.create({
    model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    output_config: {
      // Low effort: a short, sourced summary does not need long reasoning, and less thinking means a faster and
      // cheaper answer. (Opus 5.5 always thinks a little; effort is how to keep that small.)
      effort: 'low',
      // Structured outputs: Claude must return JSON that matches the schema, so no "cut-off JSON" retries are needed.
      format: { type: 'json_schema', schema: { ...schema, additionalProperties: false } },
    },
    // If Claude's safety checks decline a request (unlikely for health research), Anthropic re-runs it on its
    // recommended fallback model inside the same call instead of returning nothing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer');
  if (res.stop_reason === 'max_tokens') throw new Error('Claude reply was cut off');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}
