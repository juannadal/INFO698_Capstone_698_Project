-- Questions asked through /api/ask, for testing and evaluation. No IP address, browser or account data is stored,
-- and emails and phone numbers are removed from the question before it is saved.
CREATE TABLE IF NOT EXISTS query_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  asked_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  question       TEXT NOT NULL,
  status         TEXT NOT NULL,     -- answered | no_answer | error
  pmids          TEXT,              -- JSON array: the cited sources in order, or the ranked articles if no answer
  top_similarity REAL,
  grade          REAL,
  latency_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_query_log_asked_at ON query_log(asked_at);
