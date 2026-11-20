// Small helpers shared by the ranking evaluation scripts (fetch_runs.mjs, score.mjs): reading and writing CSV files,
// and a seeded shuffle. No packages needed, so the scripts run with plain Node 18+.
import { readFileSync, writeFileSync } from 'node:fs';

// Read a CSV file into an array of objects keyed by the header row. Handles quoted values, so a question may contain
// commas, quotes ("") or line breaks.
export function readCsv(path) {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');   // a spreadsheet may save a byte-order mark
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(value); value = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += c;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// Quote a value for a CSV file when it contains a comma, quote or line break.
export const csvValue = (v) => (v == null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// Write an array of objects as a CSV file, with the given columns in order.
export function writeCsv(path, columns, rows) {
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => csvValue(r[c])).join(','))];
  writeFileSync(path, lines.join('\n') + '\n');
}

// A seeded random number generator (mulberry32): the same seed always gives the same numbers in [0, 1).
// Integer-only arithmetic (Math.imul), so no precision is lost, and a period of 2^32, long enough for the
// permutation test's 100,000 rounds. (A plain "seed * 1103515245" loses digits once the product passes 2^53,
// which biased the shuffle; the PR #13 review caught it.)
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shuffle a copy of items (Fisher-Yates) in the same order every run for the same seed, so the rating order is
// repeatable.
export function shuffle(items, seed = 42) {
  const random = seededRandom(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
