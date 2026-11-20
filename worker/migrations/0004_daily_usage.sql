-- Questions answered per day (UTC), for the daily cap that bounds Workers AI cost. No question text or visitor data.
CREATE TABLE IF NOT EXISTS daily_usage (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);
