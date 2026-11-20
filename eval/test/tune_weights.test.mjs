// Tests for eval/tune_weights.mjs: the weight grid, the offline re-ranking, the measures and the selection rule.
// Run: node --test eval/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightGrid, rankQuestion, measure, choose } from '../tune_weights.mjs';

const chunk = (pmid, similarity, recency = 0, us = 0, pub_year = 2016) =>
  ({ pmid, chunk_id: `${pmid}-${similarity}`, pub_year, signals: { similarity, keywords: 0, recency, us } });

test('weightGrid: 1,771 mixes in steps of 0.05, each adding up to 1', () => {
  const grid = weightGrid();
  assert.equal(grid.length, 1771);
  for (const w of grid) assert.ok(Math.abs(w.similarity + w.keywords + w.recency + w.us - 1) < 1e-9);
});

test('rankQuestion: an article takes its best chunk, and weights change the order', () => {
  const candidates = [chunk('A', 0.9), chunk('A', 0.1), chunk('B', 0.5, 1, 0.8, 2026)];
  const bySimilarity = rankQuestion(candidates, { similarity: 1, keywords: 0, recency: 0, us: 0 });
  assert.deepEqual(bySimilarity.map((a) => a.pmid), ['A', 'B']);
  assert.equal(bySimilarity[0].score, 0.9);
  const byRecency = rankQuestion(candidates, { similarity: 0.5, keywords: 0, recency: 0.5, us: 0 });
  assert.deepEqual(byRecency.map((a) => a.pmid), ['B', 'A']);
});

test('measure: condensed nDCG skips unrated articles; shares count recent and U.S. articles', () => {
  const ranked = [chunk('X', 1, 1, 0.8, 2024), chunk('A', 0.9)];   // X is unrated
  const known = new Map([['A', 2]]);
  const m = measure(ranked, known);
  assert.equal(m.unrated, 1);
  assert.equal(m.condensed, 1);                       // A is the first rated article: perfect
  assert.ok(m.ndcg < 1);                              // A is second when X counts as not relevant
  assert.equal(m.recent_share, 0.5);
  assert.equal(m.us_share, 0.5);
});

test('choose: most recency + U.S. weight within the tolerance, else the best', () => {
  const r = (similarity, recency, condensed) => ({
    weights: { similarity, keywords: 0, recency, us: 0 },
    perQuestion: [{ ndcg: condensed, condensed, p10: 0, unrated: 0, recent_share: 0, us_share: 0 }],
  });
  const results = [r(1, 0, 0.90), r(0.8, 0.2, 0.895), r(0.5, 0.5, 0.80)];
  const { best, chosen } = choose(results, [0], 0.01);
  assert.equal(best.weights.similarity, 1);
  assert.equal(chosen.weights.recency, 0.2);
  assert.equal(choose(results, [0], 0).chosen.weights.similarity, 1);
});
