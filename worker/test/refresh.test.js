// Runs the weekly refresh (src/refresh.js) end to end against stand-ins: a local SQLite database with the same
// tables as D1 (Node's built-in node:sqlite), and fake PubMed, Workers AI and Vectorize. Checks that it adds the new
// articles to both D1 and Vectorize, skips ones already there, drops retractions, removes newly retracted
// articles, records the run in refresh_log, continues from the right day, and writes nothing in a dry run.
// Run from the repo root with `node --test worker/test/*.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { refreshIndex, retry, limits } from '../src/refresh.js';

retry.pauseMs = 1;                   // no long waits between retries in tests

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const FIXTURE = readFileSync(here('fixture_pubmed.xml'), 'utf8');
const NEW_DAY = '2026/10/05';                  // the fake PubMed lists articles on this MeSH date only
const LISTED = ['1001', '1002', '1003', '1006', '1007', '9999'];   // 9999 is already in D1; 1006 retracted; 1007 no abstract

// The D1 tables the refresh touches, as in cloudflare/d1_schema.sql (in Drive) and worker/migrations/0005.
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE articles (pmid TEXT PRIMARY KEY, title TEXT NOT NULL, journal TEXT, pub_date TEXT, pub_year INTEGER,
      pub_types TEXT, mesh TEXT, affiliations TEXT, us_affiliation INTEGER NOT NULL DEFAULT 0,
      us_mesh INTEGER NOT NULL DEFAULT 0, abstract_tokens INTEGER, added_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE chunks (chunk_id TEXT PRIMARY KEY, pmid TEXT NOT NULL REFERENCES articles(pmid) ON DELETE CASCADE,
      idx INTEGER NOT NULL, section TEXT, text TEXT NOT NULL, token_count INTEGER, UNIQUE (pmid, idx));
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
    ${readFileSync(here('../migrations/0005_refresh_log.sql'), 'utf8')}
    INSERT INTO articles (pmid, title) VALUES ('9999', 'Already in the collection'), ('5555', 'Retracted later');
    INSERT INTO chunks (chunk_id, pmid, idx, text) VALUES ('9999-0', '9999', 0, 'old'), ('5555-0', '5555', 0, 'gone'),
      ('5555-100', '5555', 100, 'gone full text');
  `);
  return db;
}

// A small stand-in for the D1 binding (prepare/bind/first/all/run and batch) over node:sqlite. Some Node versions'
// node:sqlite cannot fill D1-style numbered placeholders (?1, ?2) from a list, so they become named ones ($p1, $p2)
// filled from an object.
function d1(db) {
  const named = (sql) => sql.replace(/\?(\d+)/g, '$$p$1');
  const values = (args) => Object.fromEntries(args.map((v, i) => [`p${i + 1}`, v]));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => db.prepare(named(sql)).get(values(args)) ?? null,
    all: async () => ({ results: db.prepare(named(sql)).all(values(args)) }),
    run: async () => db.prepare(named(sql)).run(values(args)),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { for (const s of stmts) await s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

// Fake env and PubMed. Returns { env, db, vectors, deleted, requests }.
function setup(extra = {}) {
  const db = makeDb();
  const vectors = new Map();
  const deleted = [];
  const requests = [];
  globalThis.fetch = async (url, { body }) => {
    const p = new URLSearchParams(body);
    requests.push(p.get('term') || `efetch ${p.get('id')}`);
    if (url.endsWith('esearch.fcgi')) {
      const term = p.get('term');
      const ids = term.includes('"Retracted Publication"[pt]') ? ['5555', '1234']
        : term.includes(`${NEW_DAY}[mhda]`) ? LISTED : [];
      return new Response(JSON.stringify({ esearchresult: { count: String(ids.length), idlist: ids } }));
    }
    return new Response(FIXTURE);        // EFetch: the whole fixture; the refresh keeps only what it asked for
  };
  const env = {
    NCBI_API_KEY: 'test',               // the shorter wait between PubMed requests
    DB: d1(db),
    AI: { run: async (model, { text }) => ({ data: text.map(() => new Array(768).fill(0.1)) }) },
    VECTORIZE: {
      upsert: async (vs) => vs.forEach((v) => vectors.set(v.id, v)),
      deleteByIds: async (ids) => deleted.push(...ids),
    },
    ...extra,
  };
  return { env, db, vectors, deleted, requests };
}

test('adds new articles to D1 and Vectorize and records the run', async () => {
  const { env, db, vectors, deleted } = setup();
  const s = await refreshIndex(env);
  assert.equal(s.status, 'ok', s.note);
  assert.equal(s.from, '2026-10-03');
  assert.equal(s.through, '2026-10-16');              // 14 days
  assert.equal(s.found, LISTED.length);
  assert.equal(s.added, 3);                           // 1001, 1002, 1003
  assert.equal(s.chunks, 10);
  const pmids = db.prepare('SELECT pmid FROM articles ORDER BY pmid').all().map((r) => r.pmid);
  assert.deepEqual(pmids, ['1001', '1002', '1003', '9999']);    // 5555 removed as retracted
  const a = db.prepare("SELECT * FROM articles WHERE pmid = '1002'").get();
  assert.equal(a.us_affiliation, 1);
  assert.equal(a.us_mesh, 1);
  assert.deepEqual(JSON.parse(a.mesh), ['Aged', 'United States']);
  // Every new chunk is in D1, the keyword index and Vectorize, with the loader's metadata.
  const chunkIds = db.prepare("SELECT chunk_id FROM chunks WHERE pmid != '9999' ORDER BY chunk_id").all().map((r) => r.chunk_id);
  assert.equal(chunkIds.length, 10);
  assert.deepEqual([...vectors.keys()].sort(), chunkIds);
  assert.deepEqual(vectors.get('1002-0').metadata, { pmid: '1002', pub_year: 2025, us_affiliation: true });
  assert.equal(db.prepare("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'walking'").get().n > 0, true);
  // The retracted article's chunks left Vectorize, D1 and the keyword index.
  assert.deepEqual(deleted.sort(), ['5555-0', '5555-100']);
  assert.equal(db.prepare("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'gone'").get().n, 0);
  assert.equal(s.removed, 1);
  const log = db.prepare('SELECT * FROM refresh_log').all();
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'ok');
  assert.equal(log[0].through_day, '2026-10-16');
  assert.equal(log[0].added, 3);
  assert.ok(log[0].finished_at);

  // The next run continues the day after, and finds nothing new to add.
  const next = await refreshIndex(env);
  assert.equal(next.from, '2026-10-17');
  assert.equal(next.added, 0);
});

test('a dry run writes nothing', async () => {
  const { env, db, vectors, deleted } = setup({ REFRESH_DRY_RUN: 'true' });
  const s = await refreshIndex(env);
  assert.equal(s.added, 3);
  assert.equal(s.removed, 1);
  assert.equal(vectors.size, 0);
  assert.equal(deleted.length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM articles').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM refresh_log').get().n, 0);
});

test('a PubMed failure keeps the finished days and is logged as an error', async () => {
  const { env, db } = setup();
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (...a) => (++calls > 3 ? new Response('busy', { status: 503 }) : real(...a));
  const s = await refreshIndex(env);
  assert.equal(s.status, 'error');
  // The searches for 10-03, 10-04 and 10-05 work; downloading 10-05's articles fails, so 10-04 is the last day done.
  assert.equal(s.through, '2026-10-04');
  const log = db.prepare('SELECT status, through_day, note FROM refresh_log').get();
  assert.equal(log.status, 'error');
  assert.equal(log.through_day, '2026-10-04');
  assert.equal(db.prepare('SELECT count(*) n FROM articles').get().n, 2);     // nothing half-saved
  assert.match(log.note, /503/);
});

test('the article limit stops partway through a day and the next run finishes it', async () => {
  const { env, db } = setup();
  limits.articlesPerRun = 2;
  try {
    const s = await refreshIndex(env);
    assert.equal(s.fetched, 2);                      // 1001 and 1002 of the five new PMIDs on 10-05
    assert.equal(s.added, 2);
    assert.equal(s.through, '2026-10-04');           // 10-05 is not marked done
    const next = await refreshIndex(env);            // 1003 and 1006 (dropped as retracted); 1007 still left
    assert.equal(next.from, '2026-10-05');
    assert.equal(next.added, 1);
    assert.equal(next.through, null);                // no day finished in this run
    assert.ok(db.prepare("SELECT 1 FROM articles WHERE pmid = '1003'").get());
  } finally {
    limits.articlesPerRun = 3000;
  }
  // With the normal limit, the next run fetches the two dropped ones again and finishes 10-05 and later days.
  const third = await refreshIndex(env);
  assert.equal(third.from, '2026-10-05');
  assert.equal(third.fetched, 2);
  assert.equal(third.added, 0);
  assert.equal(third.through, '2026-10-18');
});

test('an EFetch error message is an error, not an empty day', async () => {
  const { env, db } = setup();
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (url.endsWith('efetch.fcgi')
    ? new Response('<eFetchResult><ERROR>Unable to obtain query</ERROR></eFetchResult>') : real(url, init));
  const s = await refreshIndex(env);
  assert.equal(s.status, 'error');
  assert.equal(s.through, '2026-10-04');
  assert.match(s.note, /not a PubMed article set/);
  assert.equal(db.prepare('SELECT count(*) n FROM articles').get().n, 2);
});

test('an article PubMed lists but never returns is reported, not retried forever', async () => {
  const { env } = setup();
  const real = globalThis.fetch;
  // Every EFetch answer leaves out 1003.
  globalThis.fetch = async (url, init) => {
    const res = await real(url, init);
    if (!url.endsWith('efetch.fcgi')) return res;
    return new Response((await res.text()).replace(/<PubmedArticle>(?:(?!<\/PubmedArticle>)[\s\S])*?<PMID Version="1">1003<\/PMID>[\s\S]*?<\/PubmedArticle>/, ''));
  };
  const s = await refreshIndex(env);
  assert.equal(s.status, 'ok', s.note);
  assert.equal(s.added, 2);
  assert.deepEqual(s.unavailable, ['1003']);
  assert.match(s.note, /did not return 1 listed articles: 1003/);
  assert.equal(s.through, '2026-10-16');
});

test('a failed D1 batch never leaves an article without its chunks', async () => {
  const { env, db } = setup();
  const realBatch = env.DB.batch;
  let n = 0;
  env.DB.batch = async (stmts) => { if (++n === 2) throw new Error('D1 busy'); return realBatch(stmts); };
  limits.d1Batch = 5;                                // several batches for the three articles (13 statements)
  let s;
  try { s = await refreshIndex(env); } finally { limits.d1Batch = 100; }
  assert.equal(s.status, 'error');
  const orphans = db.prepare('SELECT count(*) n FROM articles a WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.pmid = a.pmid)').get().n;
  assert.equal(orphans, 0);
  assert.ok(db.prepare("SELECT 1 FROM articles WHERE pmid = '1001'").get());   // the first batch was saved
});
