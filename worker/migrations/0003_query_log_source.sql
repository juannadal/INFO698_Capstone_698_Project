-- Who asked: 'app' for a person using the site, 'automated' for test runs (sent with the X-Test-Source header).
ALTER TABLE query_log ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
