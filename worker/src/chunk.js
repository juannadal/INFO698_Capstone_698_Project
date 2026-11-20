// Split an article's abstract into passages ("chunks") for D1 and Vectorize: the same rules as chunk_article() in
// scripts/harvest_and_chunk.py, ported to JavaScript so the weekly refresh (src/refresh.js) can chunk new articles
// inside the Worker. New articles must be split exactly like the 289,000 already loaded, so search treats them the
// same; worker/test/chunk.test.js checks this against the Python script's output.
//
// Rules (see the Python docstring for the reasons):
//   - one chunk per article: title + "\n" + abstract, when it fits in MAX_TOKENS (450)
//   - longer structured abstracts: adjacent labelled sections are packed into chunks of up to MAX_TOKENS, title first
//   - a section (or unstructured abstract) still too long: sentence windows of about WINDOW_TOKENS (300) with
//     OVERLAP_SENTENCES (1) of overlap
// Token counts are the Python script's estimate (words and punctuation marks x 1.3, plus 2), not the real tokenizer.

export const MAX_TOKENS = 450;
const WINDOW_TOKENS = 300;
const OVERLAP_SENTENCES = 1;

// Words and single punctuation marks. Python's \w matches letters and digits of any language, so this uses the
// Unicode classes (\p{L} letters, \p{N} digits) instead of JavaScript's \w, which only knows a-z and 0-9.
const TOKEN_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;
// A sentence break: an end mark, then spaces, then a capital, digit or bracket (the spaces are removed).
const SENT_RE = /(?<=[.!?])\s+(?=[A-Z0-9(\[])/;

// Estimate the bge-base-en-v1.5 token count of a string (+2 for the model's start and end tokens).
export function nTokens(s) {
  return Math.trunc((s.match(TOKEN_RE) || []).length * 1.3) + 2;
}

// Split text into windows of whole sentences, each at most `budget` estimated tokens. Each window starts with the
// last OVERLAP_SENTENCES sentence(s) of the previous one, so a finding split across a boundary keeps its context.
function sentenceWindows(text, budget) {
  const out = [];
  let cur = [];
  for (const s of text.split(SENT_RE)) {
    if (cur.length && nTokens([...cur, s].join(' ')) > budget) {
      out.push(cur.join(' '));
      cur = OVERLAP_SENTENCES ? cur.slice(-OVERLAP_SENTENCES) : [];
      if (nTokens([...cur, s].join(' ')) > budget) cur = [];     // the overlap alone would overflow
    }
    cur.push(s);
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

// Sections as text, each with its label first ("METHODS: ..."), joined by spaces.
function body(sections) {
  return sections.map((s) => (s.label ? `${s.label}: ` : '') + s.text).join(' ');
}

// Split one article into chunk objects, in the same shape as a line of chunks.jsonl. The article needs pmid, title,
// abstract_sections ([{ label, text }]), pub_year and us_affiliation. chunk_id is "<pmid>-<idx>"; section is FULL
// for a whole abstract, the labels joined by "+" for packed sections, or the label/WINDOW for sentence windows.
export function chunkArticle(a) {
  const { title } = a;
  const secs = a.abstract_sections;
  let pieces;
  if (nTokens(`${title}\n${body(secs)}`) <= MAX_TOKENS) {
    pieces = [['FULL', body(secs)]];
  } else {
    const budget = MAX_TOKENS - nTokens(title);
    pieces = [];
    let group = [];
    const flush = () => {
      if (group.length) pieces.push([group.map((g) => g.label).join('+'), body(group)]);
      group = [];
    };
    for (const s of secs) {
      if (s.label && nTokens(body([s])) <= budget) {
        if (group.length && nTokens(body([...group, s])) > budget) flush();
        group.push(s);
      } else {                                               // unlabelled, or too long on its own
        flush();
        for (const w of sentenceWindows(body([s]), Math.min(WINDOW_TOKENS, budget))) pieces.push([s.label || 'WINDOW', w]);
      }
    }
    flush();
  }
  return pieces.map(([section, text], idx) => {
    const t = `${title}\n${text}`;
    return {
      chunk_id: `${a.pmid}-${idx}`, pmid: a.pmid, idx, section, text: t, token_count: nTokens(t),
      pub_year: a.pub_year, us_affiliation: a.us_affiliation,
    };
  });
}

// The article's whole title + abstract size, stored in articles.abstract_tokens like the harvest does.
export function abstractTokens(a) {
  return nTokens(`${a.title}\n${a.abstract_sections.map((s) => s.text).join(' ')}`);
}
