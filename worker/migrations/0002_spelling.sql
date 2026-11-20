-- Spelling correction: every word in the article text with how often it appears (freq), plus everyday English
-- words from the system dictionary (freq 0), so real words are never "corrected". Filled by scripts/build_vocab.py.
CREATE TABLE IF NOT EXISTS vocab (
  word  TEXT PRIMARY KEY,
  freq  INTEGER NOT NULL,
  first TEXT NOT NULL,      -- first letter, to narrow the candidates
  len   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vocab_lookup ON vocab(first, len, freq);

-- The question as corrected, when spelling correction changed it (question keeps what the person typed).
ALTER TABLE query_log ADD COLUMN corrected_question TEXT;
