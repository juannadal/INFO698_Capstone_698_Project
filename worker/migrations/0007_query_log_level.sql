-- The reading level the reader chose: 'plain' (grade 6-8), 'detailed' (high school, grade 10-12) or 'college'
-- (src/levels.js).
-- Rows saved before the "Answer style" menu existed were all plain, so that is the default.
ALTER TABLE query_log ADD COLUMN level TEXT NOT NULL DEFAULT 'plain';
