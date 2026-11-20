-- One row per weekly refresh run (worker/src/refresh.js): which days of new PubMed articles it covered and what it
-- added. The next run starts the day after the latest through_day. status: running | ok | check (retractions
-- need a person to look) | error (note has the message; the next run retries from the last finished day).
CREATE TABLE IF NOT EXISTS refresh_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at TEXT,
  from_day    TEXT,              -- first day covered (YYYY-MM-DD, the day PubMed added MeSH terms)
  through_day TEXT,              -- last day fully done; NULL if no day finished
  found       INTEGER NOT NULL DEFAULT 0,   -- PMIDs PubMed listed for those days
  added       INTEGER NOT NULL DEFAULT 0,   -- new articles saved
  chunks      INTEGER NOT NULL DEFAULT 0,   -- their passages
  removed     INTEGER NOT NULL DEFAULT 0,   -- retracted articles removed
  status      TEXT NOT NULL,
  note        TEXT
);
