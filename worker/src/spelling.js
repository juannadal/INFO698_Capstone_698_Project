// Spelling correction, like "Showing results for ...": a word that is not in the article text (D1 table vocab) is
// replaced by the most common article word within 1 or 2 edits of it. A word that is only in the English dictionary
// is replaced only by a very common article word.
// Medical terms are corrected properly because the candidates come from the articles themselves.

const MIN_CANDIDATE_FREQ = 20;   // only suggest words that appear often in the articles
// A dictionary word that never appears in the articles ("presser", "hart") is usually a misspelling here, so it is
// corrected too, but only to a very common article word ("pressure", "heart").
const MIN_FREQ_FOR_DICTIONARY_WORD = 1000;
// A rare article word is often a typo in the abstracts themselves ("excercise" appears 4 times). It is corrected
// when a word 1 edit away is at least this many times more common ("exercise", 94,381 times).
const RARE_WORD_FREQ = 50;
const RARE_WORD_RATIO = 200;
// A word, including any apostrophe part ("shouldn't", "people's"). Words with an apostrophe are never corrected:
// splitting them would turn "shouldn" (rare in the articles) into "should" and "Shouldn't" into "Should't".
const WORD = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;

// Returns the question with misspellings fixed, or null when nothing needed fixing (then the page shows no
// "Showing results for"). Words under 3 letters are left alone. Lookups go in batches of 90 because D1 allows
// 100 bound parameters per query.
export async function correctSpelling(env, question) {
  const tokens = [...question.matchAll(WORD)];
  const words = [...new Set(tokens.map((m) => m[0].toLowerCase())
    .filter((w) => w.length >= 3 && /^[a-z]+$/.test(w)))];
  if (!words.length) return null;

  const freq = new Map();          // words in the vocab: article count, 0 for dictionary-only words
  const batches = [];
  for (let i = 0; i < words.length; i += 90) batches.push(words.slice(i, i + 90));
  const looked = await Promise.all(batches.map((part) => env.DB.prepare(
    `SELECT word, freq FROM vocab WHERE word IN (${part.map((_, j) => '?' + (j + 1)).join(',')})`,
  ).bind(...part).all()));
  for (const { results } of looked) for (const r of results) freq.set(r.word, r.freq);

  // Only unknown words and rare article words are checked; a common article word is taken as spelled right.
  // Their candidate lookups run in parallel.
  const suspects = words.filter((w) => !(freq.get(w) >= RARE_WORD_FREQ));
  const found = await Promise.all(suspects.map((w) => bestFix(env, w, freq)));
  const fixes = new Map();
  suspects.forEach((w, i) => found[i] && fixes.set(w, found[i]));
  if (!fixes.size) return null;

  // Rebuild the question, keeping the person's punctuation and capitals.
  return question.replace(WORD, (m) => {
    const fix = fixes.get(m.toLowerCase());
    if (!fix) return m;
    if (m === m.toUpperCase() && m.length > 1) return fix.toUpperCase();
    return m[0] === m[0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
  });
}

// The best replacement for one suspect word, or null if no candidate is close enough.
async function bestFix(env, w, freq) {
  const f = freq.get(w) || 0;
  const rare = f > 0;                // in the articles, but rarely
  const minFreq = rare ? f * RARE_WORD_RATIO : freq.has(w) ? MIN_FREQ_FOR_DICTIONARY_WORD : MIN_CANDIDATE_FREQ;
  const maxEdits = rare || w.length <= 4 ? 1 : 2;
  const { results } = await env.DB.prepare(
    // Candidates share the first letter and have about the same length, so the vocab index keeps this fast.
    'SELECT word, freq FROM vocab WHERE first = ?1 AND len BETWEEN ?2 AND ?3 AND freq >= ?4',
  ).bind(w[0], w.length - maxEdits - 1, w.length + maxEdits + 1, minFreq).all();
  const wSound = soundsLike(w);
  let best = null;
  for (const c of results) {
    // Count edits on the spelling and on how it sounds, and take the smaller ("excersize" is 3 edits from
    // "exercise" but 1 edit once both are written as they sound).
    const d = Math.min(editDistance(w, c.word, maxEdits), editDistance(wSound, soundsLike(c.word), maxEdits));
    if (d > maxEdits) continue;
    // Fewer edits wins; among equals, the more common word.
    if (!best || d < best.d || (d === best.d && c.freq > best.freq)) best = { word: c.word, freq: c.freq, d };
  }
  return best ? best.word : null;
}

// A rough spelling-by-sound: z -> s, soft c -> s, ph -> f, ck -> k, and doubled letters written once.
export function soundsLike(word) {
  return word.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');
}

// Damerau-Levenshtein distance (a swap of two neighbouring letters counts as one edit), stopping early past max.
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}
