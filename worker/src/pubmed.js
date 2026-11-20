// The live PubMed fallback (proposal Feature 2): when the saved index has no strong match for a question, search
// PubMed itself at question time and answer from what it finds.
//
// 1. ESearch: the question's content words, limited to the same kind of research the collection holds (adults 40+,
//    2016 on, with an abstract), sorted by PubMed's relevance. All words must match; if none do, any word may.
// 2. EFetch: the top articles' XML, parsed into the same fields the index stores (title, journal, date, abstract,
//    publication types, U.S. affiliation).
// 3. Each abstract is embedded with the same model as the index, and only articles at least LIVE_MIN_SIMILARITY
//    similar to the question are kept, so off-topic questions are still refused.
// The articles come back shaped like rankArticles() output, with one ABSTRACT passage each, for writeAnswer().
//
// NCBI allows 3 requests a second without an API key and 10 with one. The key, if set, is the Worker secret
// NCBI_API_KEY (never in a file). The whole PubMed part is bounded by TIMEOUT_MS so a slow PubMed cannot hang a
// question; any failure means "no live results" and the page shows "no research found" as before.
import { EMBED_MODEL, embedQuery, contentWords } from './search.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
// Sent with every request, as NCBI asks, so they can contact the app's owner about its traffic.
const TOOL = 'aging-lifestyle-research-explorer';
// How many PubMed results to fetch and embed. More finds more, but makes EFetch and the embedding slower.
const RETMAX = 10;
// Time allowed for ESearch + EFetch together.
const TIMEOUT_MS = 4000;
// The embedding model reads at most 512 tokens; about 2,000 characters of title and abstract stay under that.
const EMBED_CHARS = 2000;
// The most abstract text given to the answer model per article, to keep the prompt about as long as usual.
const PASSAGE_CHARS = 2500;

// Which PubMed research the live search may use. 'collection' is the saved collection's own filter (age 40+ and
// a lifestyle subject, a chronic condition, or an internal/family medicine journal), so live answers stay within the
// proposal's scope; its main gain is articles newer than the last harvest. 'adults40' drops the topic limit and
// reaches all research on adults 40+ (more questions answered, but also some the test set calls off-topic).
const AGE = '("Middle Aged"[MeSH] OR "Aged"[MeSH])';
const TOPICS =
  '("Healthy Lifestyle"[MeSH] OR "Life Style"[MeSH] OR "Exercise"[MeSH] OR "Diet"[MeSH] OR "Sleep"[MeSH] '
  + 'OR "Diabetes Mellitus, Type 2"[MeSH] OR "Hypertension"[MeSH] OR "Coronary Disease"[MeSH] '
  + 'OR "Pulmonary Disease, Chronic Obstructive"[MeSH] OR "Osteoarthritis"[MeSH] OR "Depression"[MeSH] '
  + 'OR "Obesity"[MeSH] OR "JAMA internal medicine"[ta] OR "Annals of internal medicine"[ta] '
  + 'OR "J Gen Intern Med"[ta] OR "Am J Med"[ta] OR "Arch Intern Med"[ta] OR "Intern Med J"[ta] '
  + 'OR "Eur J Intern Med"[ta] OR "Intern Med"[ta] OR "Am Fam Physician"[ta] OR "Ann Fam Med"[ta] '
  + 'OR "Br J Gen Pract"[ta] OR "Fam Pract"[ta] OR "J Am Board Fam Med"[ta] OR "BMC Prim Care"[ta] '
  + 'OR "BMC Fam Pract"[ta] OR "Can Fam Physician"[ta] OR "Scand J Prim Health Care"[ta] OR "J Fam Pract"[ta])';
// "2016:3000[dp]" means 2016 to today, so articles published after the last harvest are included.
export const SCOPES = {
  collection: `${AGE} AND ${TOPICS} AND hasabstract AND 2016:3000[dp]`,
  adults40: `${AGE} AND hasabstract AND 2016:3000[dp]`,
};
// The Worker variable LIVE_PUBMED_SCOPE ('collection' or 'adults40') can override the default for testing.
export const SCOPE = 'collection';

// The live cutoff, in exact cosine similarity. The index's MIN_SIMILARITY (0.62) is on Vectorize's scale, and
// Vectorize's query scores are approximate: on the 50 UI test questions (2026-10-11) the exact cosine of the same
// top match was 0.05-0.09 higher (mean 0.075). 0.62 + 0.08 = 0.70 keeps the same bar. Off-topic questions' best
// exact scores were 0.54-0.70 (amoxicillin side effects 0.70); in-scope ones 0.67-0.86.
export const LIVE_MIN_SIMILARITY = 0.70;

// Retracted papers and errata are never cited (the harvest and the weekly refresh drop them too).
export const DROP_TYPES = new Set(['Retracted Publication', 'Retraction of Publication', 'Published Erratum']);
// The harvest's U.S. affiliation test: "USA"/"United States", or "City, ST 12345" with a U.S. state code and ZIP.
const US_RE = /\b(USA|U\.S\.A\.|United States)\b|\b[A-Z][a-z]+,\s*(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]|DC)\s+\d{5}\b/;

// Search PubMed live for the question. Returns { articles, topSimilarity } like rankArticles(); articles is empty
// when PubMed finds nothing similar enough, is slow, or fails.
export async function livePubmedSearch(env, question) {
  const scope = SCOPES[env.LIVE_PUBMED_SCOPE] ? env.LIVE_PUBMED_SCOPE : SCOPE;
  const words = contentWords(question);
  if (!words.length) return { articles: [], topSimilarity: 0 };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let scored;
  try {
    // All words first (PubMed ANDs words separated by spaces); if that finds nothing, any of them.
    let pmids = await esearch(env, `(${words.join(' ')}) AND ${SCOPES[scope]}`, signal);
    if (!pmids.length && words.length > 1) pmids = await esearch(env, `(${words.join(' OR ')}) AND ${SCOPES[scope]}`, signal);
    if (!pmids.length) return { articles: [], topSimilarity: 0 };
    const fetched = (await efetch(env, pmids, signal))
      .filter((a) => a.abstract && !a.pub_types_list.some((t) => DROP_TYPES.has(t)));
    if (!fetched.length) return { articles: [], topSimilarity: 0 };
    // Same model and settings as the index: the question with bge's query prefix, each article as "title\nabstract".
    const [queryVec, { data }] = await Promise.all([
      embedQuery(env, question),
      env.AI.run(EMBED_MODEL, { text: fetched.map((a) => `${a.title}\n${a.abstract}`.slice(0, EMBED_CHARS)) }),
    ]);
    scored = fetched.map((a, i) => ({ ...a, similarity: cosine(queryVec, data[i]) }));
  } catch (err) {
    console.error('live PubMed search failed', err?.name, err?.message);   // never the question
    return { articles: [], topSimilarity: 0 };
  }
  const topSimilarity = Math.max(...scored.map((a) => a.similarity));
  // Most similar first, the same order the answer model sees for indexed articles (best first).
  const kept = scored.filter((a) => a.similarity >= LIVE_MIN_SIMILARITY).sort((x, y) => y.similarity - x.similarity);
  const articles = kept.map((a) => ({
    pmid: a.pmid,
    title: a.title,
    journal: a.journal,
    pub_date: a.pub_date,
    pub_year: a.pub_year,
    pub_types: JSON.stringify(a.pub_types_list),
    us_affiliation: a.us_affiliation,
    similarity: a.similarity,
    live: true,
    // writeAnswer drops each passage's first line (the title line every indexed chunk starts with).
    passages: [{ section: 'ABSTRACT', text: `${a.title}\n${a.abstract.slice(0, PASSAGE_CHARS)}` }],
  }));
  return { articles, topSimilarity };
}

// Shared E-utilities parameters: the tool name, and the API key when the Worker has one. Also used by refresh.js.
export function params(env, extra) {
  const p = new URLSearchParams({ db: 'pubmed', tool: TOOL, ...extra });
  if (env.NCBI_API_KEY) p.set('api_key', env.NCBI_API_KEY);
  return p;
}

// ESearch: PMIDs of the top RETMAX matches, most relevant first.
async function esearch(env, term, signal) {
  const res = await fetch(`${EUTILS}esearch.fcgi?${params(env, { term, retmax: String(RETMAX), sort: 'relevance', retmode: 'json' })}`, { signal });
  if (!res.ok) throw new Error(`ESearch ${res.status}`);
  return (await res.json()).esearchresult?.idlist || [];
}

// EFetch: the articles' PubMed XML, parsed. POST keeps the URL short; the order follows the PMID list.
async function efetch(env, pmids, signal) {
  const res = await fetch(`${EUTILS}efetch.fcgi`, {
    method: 'POST',
    body: params(env, { id: pmids.join(','), retmode: 'xml' }),
    signal,
  });
  if (!res.ok) throw new Error(`EFetch ${res.status}`);
  const byPmid = new Map(parseArticles(await res.text()).map((a) => [a.pmid, a]));
  return pmids.map((id) => byPmid.get(id)).filter(Boolean);
}

// One abstract section: <AbstractText attrs>text</AbstractText>, or an empty self-closing <AbstractText attrs/>,
// which is matched on its own (with no text) so it cannot swallow the next section. Callers skip the empty ones.
const ABSTRACT_TEXT_RE = /<AbstractText\b([^>]*[^/>])?>([\s\S]*?)<\/AbstractText>|<AbstractText\b[^>]*\/>/g;

// Parse PubMed EFetch XML. Workers have no DOM parser, so this reads the few tags needed with regular expressions,
// which is enough for PubMed's fixed, machine-written format.
// The live search uses abstract (one string); the weekly refresh (refresh.js) also needs the fields the harvest
// stores in D1: abstract_sections (for chunking), mesh, affiliations and us_mesh, read the same way as
// parse_article() in scripts/harvest_and_chunk.py.
export function parseArticles(xml) {
  return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(([, a]) => {
    const pmid = first(a, /<PMID[^>]*>(\d+)<\/PMID>/);
    // Structured abstracts keep their labels ("METHODS: ...") like the indexed abstracts do.
    const abstract = [...a.matchAll(ABSTRACT_TEXT_RE)].filter(([, , t]) => t !== undefined)
      .map(([, attrs = '', t]) => {
        const label = (attrs.match(/Label="([^"]*)"/) || [])[1];
        return (label ? `${label.toUpperCase()}: ` : '') + clean(t);
      })
      .filter(Boolean)
      .join(' ');
    const pubDate = first(a, /<PubDate>([\s\S]*?)<\/PubDate>/) || '';
    const year = first(pubDate, /<Year>(\d{4})<\/Year>/) || first(pubDate, /<MedlineDate>[^<]*?(\d{4})/) || '';
    const month = first(pubDate, /<Month>([^<]+)<\/Month>/);
    const day = first(pubDate, /<Day>([^<]+)<\/Day>/);
    const affiliations = [...a.matchAll(/<Affiliation>([\s\S]*?)<\/Affiliation>/g)].map(([, t]) => clean(t));
    // Like the harvest: the section's NlmCategory (BACKGROUND, METHODS, ...) if it has one, else its own label.
    // Only the article's own <Abstract>, not an <OtherAbstract> (such as a translation), as the harvest reads it.
    const abstractSections = [...(first(a, /<Abstract>([\s\S]*?)<\/Abstract>/) || '').matchAll(ABSTRACT_TEXT_RE)]
      .filter(([, , t]) => t !== undefined)
      .map(([, attrs = '', t]) => ({
        label: decodeEntities((attrs.match(/NlmCategory="([^"]*)"/) || attrs.match(/Label="([^"]*)"/) || [])[1] || '')
          .toUpperCase(),
        text: clean(t),
      }))
      .filter((s) => s.text);
    const mesh = [...a.matchAll(/<MeshHeading>[\s\S]*?<DescriptorName[^>]*>([\s\S]*?)<\/DescriptorName>/g)]
      .map(([, t]) => clean(t));
    return {
      pmid,
      title: clean(first(a, /<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/) || ''),
      journal: clean(first(a, /<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/) || ''),
      pub_date: [year, month, day].filter(Boolean).join(' '),
      pub_year: year ? Number(year) : null,
      pub_types_list: [...a.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g)].map(([, t]) => t.trim()),
      abstract,
      us_affiliation: affiliations.some((t) => US_RE.test(t)),
      abstract_sections: abstractSections,
      mesh,
      // Unique and sorted, as the harvest stores them.
      affiliations: [...new Set(affiliations)].sort(),
      us_mesh: mesh.includes('United States'),
    };
  });
}

// The first capture group of re in s, or null.
function first(s, re) {
  const m = s.match(re);
  return m ? m[1] : null;
}

// Strip inline tags (<i>, <sup>...) and decode the XML entities PubMed uses.
function clean(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// Decode the XML entities PubMed uses (also in attributes such as Label="PATIENTS &amp; METHODS").
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

// Cosine similarity, the same measure the Vectorize index uses.
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
