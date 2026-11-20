// Checks that the weekly refresh reads and chunks PubMed articles exactly like the harvest did, by running the Python
// harvest code (harvest_reference.py) and the Worker's JavaScript port on the same XML and comparing the results.
// Run from the repo root with `node --test worker/test/*.test.js` (needs python3). fixture_pubmed.xml holds made-up articles
// covering the cases that matter: short, structured, unstructured and very long abstracts, a translated abstract,
// a retraction, no abstract, inline tags and XML entities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArticles, DROP_TYPES } from '../src/pubmed.js';
import { chunkArticle, abstractTokens } from '../src/chunk.js';
import { daysToCover } from '../src/refresh.js';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const fixture = here('fixture_pubmed.xml');
const expected = JSON.parse(execFileSync('python3', [here('harvest_reference.py'), fixture], { encoding: 'utf8' }));
const actual = parseArticles(readFileSync(fixture, 'utf8'));

test('reads the same articles', () => {
  assert.deepEqual(actual.map((a) => a.pmid), expected.map((a) => a.pmid));
});

test('reads the same fields as the harvest', () => {
  for (const [i, e] of expected.entries()) {
    const a = actual[i];
    assert.equal(a.title, e.title, `title of ${e.pmid}`);
    assert.equal(a.journal, e.journal);
    assert.equal(a.pub_date, e.pub_date);
    assert.equal(a.pub_year, e.pub_year);
    assert.deepEqual(a.pub_types_list, e.pub_types);
    assert.deepEqual(a.abstract_sections, e.abstract_sections, `sections of ${e.pmid}`);
    assert.deepEqual(a.mesh, e.mesh);
    assert.deepEqual(a.affiliations, e.affiliations);
    assert.equal(a.us_affiliation, e.us_affiliation);
    assert.equal(a.us_mesh, e.us_mesh);
  }
});

test('keeps and chunks articles the same way', () => {
  for (const [i, e] of expected.entries()) {
    const a = actual[i];
    const kept = a.abstract_sections.length > 0 && !a.pub_types_list.some((t) => DROP_TYPES.has(t));
    assert.equal(kept, e.kept, `kept ${e.pmid}`);
    if (!kept) continue;
    assert.equal(abstractTokens(a), e.abstract_tokens, `abstract_tokens of ${e.pmid}`);
    assert.deepEqual(chunkArticle(a), e.chunks, `chunks of ${e.pmid}`);
  }
  // The fixture must exercise the splitting rules, not only whole-abstract chunks.
  const sections = new Set(expected.flatMap((e) => e.chunks.map((c) => c.section)));
  assert.ok(sections.has('FULL') && sections.has('WINDOW') && [...sections].some((s) => s.includes('+')));
});

test('covers the days after the last finished one, up to 14', () => {
  assert.deepEqual(daysToCover('2026-10-30', '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(daysToCover('2026-11-02', '2026-11-02'), []);
  const first = daysToCover(null, '2026-12-31');
  assert.equal(first.length, 14);
  assert.equal(first[0], '2026-10-03');
});
