-- Which model wrote the answer: 'llama' (Workers AI, the default) or 'claude' (Anthropic API). Rows saved before the
-- model menu existed were all Llama, so that is the default.
ALTER TABLE query_log ADD COLUMN model TEXT NOT NULL DEFAULT 'llama';
