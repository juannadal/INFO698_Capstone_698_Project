// Checks the ranking evaluation's measures (eval/score.mjs) against values worked out by hand, and that the CSV
// reader (eval/lib.mjs) handles quoted questions. Run from the repo root with `node --test eval/test/*.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { precisionAt, dcgAt, ndcgAt, signTest, permutationTest, loadRun, loadJudgments, scoreRuns, compare } from '../score.mjs';
import { readCsv, shuffle } from '../lib.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} is not ${b}`);

test('precision@10 counts ratings 1 and 2 as relevant, and empty places as not relevant', () => {
  close(precisionAt([2, 0, 1]), 0.2);              // 2 relevant of 10 places, though only 3 were returned
  close(precisionAt([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]), 1);   // only the first 10 count
});

test('DCG uses linear gain and a log2(rank + 1) discount', () => {
  close(dcgAt([2, 1]), 2 / 1 + 1 / Math.log2(3));  // 2.6309
  close(dcgAt([0, 0, 2]), 2 / 2);                   // rank 3: log2(4) = 2
});

test('nDCG divides by the best order of every rating known for the question', () => {
  close(ndcgAt([0, 2], [2, 0]), (2 / Math.log2(3)) / 2);   // 0.6309
  close(ndcgAt([2, 1], [1, 2, 0]), 1);                      // already the ideal order
  close(ndcgAt([1], [2, 1]), 1 / (2 + 1 / Math.log2(3)));   // missed the best article
  close(ndcgAt([0, 0], [0, 0]), 0);                         // nothing relevant anywhere
});

test('sign test is exact and two-sided', () => {
  close(signTest(5, 0), 2 / 32);
  close(signTest(3, 3), 1);
  close(signTest(0, 0), 1);
  close(signTest(9, 1), (2 * (1 + 10)) / 1024);
});

test('permutation test: a clear difference is rare, no difference is common', () => {
  assert.ok(permutationTest(Array(12).fill(0.3), 20000) < 0.001);
  assert.ok(permutationTest([0.2, -0.2, 0.1, -0.1], 20000) > 0.9);
});

test('scoring end to end: unrated articles count as 0 and are reported', () => {
  const ours = loadRun([{ qid: '1', rank: '2', pmid: 'b' }, { qid: '1', rank: '1', pmid: 'a' }]);
  const pubmed = loadRun([{ qid: '1', rank: '1', pmid: 'c' }, { qid: '1', rank: '2', pmid: 'a' }]);
  const judged = loadJudgments([
    { qid: '1', pmid: 'a', rating: '2' }, { qid: '1', pmid: 'b', rating: '0' },
    { qid: '1', pmid: 'b', rating: '1' },   // a later row for the same article wins
  ]);
  const [row] = scoreRuns(ours, pubmed, judged);
  assert.deepEqual(ours.get('1'), ['a', 'b']);
  close(row.ours_p10, 0.2);
  close(row.pubmed_p10, 0.1);
  close(row.ours_ndcg10, 1);                              // a(2), b(1) is the ideal order
  close(row.pubmed_ndcg10, (2 / Math.log2(3)) / (2 + 1 / Math.log2(3)));
  assert.equal(row.unrated, 1);                           // c
  const c = compare([row], 'ndcg10');
  assert.deepEqual([c.wins, c.ties, c.losses], [1, 0, 0]);
});

test('readCsv handles quoted values with commas and doubled quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-'));
  const path = join(dir, 'q.csv');
  writeFileSync(path, 'id,topic,question\r\n1,Diet,"Why do people gain weight after 40, and what helps?"\n2,Sleep,"Is ""too much"" sleep bad?"\n');
  assert.deepEqual(readCsv(path), [
    { id: '1', topic: 'Diet', question: 'Why do people gain weight after 40, and what helps?' },
    { id: '2', topic: 'Sleep', question: 'Is "too much" sleep bad?' },
  ]);
});

test('a question where neither system found anything still counts, with zero scores', () => {
  const ours = loadRun([{ qid: '1', rank: '1', pmid: 'a' }]);
  const pubmed = loadRun([]);
  const judged = loadJudgments([{ qid: '1', pmid: 'a', rating: '2' }]);
  const rows = scoreRuns(ours, pubmed, judged, ['1', '2']);
  assert.deepEqual(rows.map((r) => r.qid), ['1', '2']);
  close(rows[1].ours_ndcg10, 0);
  assert.deepEqual(Object.values(compare(rows, 'ndcg10')).slice(2, 5), [1, 1, 0]);   // wins, ties, losses
});

test('the seeded shuffle is repeatable and not stuck in one order', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(shuffle(items, 1001), shuffle(items, 1001));
  // Across the test set's seeds, the article first in the input must not always land in the same place.
  const places = new Set(Array.from({ length: 34 }, (_, k) => shuffle(items, 1001 + k).indexOf(0)));
  assert.ok(places.size > 10, `only ${places.size} different places`);
  // The last swap (positions 0 and 1) must go both ways.
  const firstTwo = new Set(Array.from({ length: 34 }, (_, k) => shuffle([0, 1], 1001 + k)[0]));
  assert.equal(firstTwo.size, 2);
});
