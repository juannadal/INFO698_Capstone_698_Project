// Reading levels: how hard and how long an answer is. Dr. Hu's feedback (2026-11-05) was that answers were too basic,
// while the proposal's original health-literacy target was grade 6 to 8, so both are offered and the reader picks
// (the page's "Reading level" menu). The page asks for 'detailed' by default; the API's default stays 'plain' so
// older callers (eval scripts, the UI test run) get the answers they were built for.
//   'plain':    the rules in answer.js's SYSTEM_PROMPT, grade 6 to 8, about 100 words.
//   'detailed': DETAILED_RULES below ("High school" on the page), about grade 10 to 12, 200 to 300 words, with
//               research terms explained and the study numbers (design, size, length, effect size, strength of evidence).
//   'college':  COLLEGE_RULES below ("College level"), about grade 13 to 16, 300 to 400 words, written like a short
//               research summary: statistics as reported, methods, and limitations.
// Each level's rules are added to the system prompt (the instructions the model gets before the question), so the
// model writes at the chosen level automatically. To change how a level reads, edit its rules here.
// Everything else stays the same at both levels: only the numbered articles, a citation on every sentence (sentences
// without one are dropped), never advice, and the not-medical-advice notice under the answer.

export const LEVELS = ['plain', 'detailed', 'college'];

// The reading grade each level aims for; the page's reading-level badge compares the answer with it.
export const LEVEL_TARGETS = { plain: [6, 8], detailed: [10, 12], college: [13, 16] };

// High school and college answers are two to four times longer, so they get more room and more paragraphs.
const MAX_TOKENS = { detailed: 1600, college: 2000 };
export const LONG_MAX_PARAGRAPHS = 4;

// The most tokens the model may write at a level, or null for the default (plain).
export function levelMaxTokens(level) {
  return MAX_TOKENS[level] || null;
}

// Added after the main rules for a detailed answer. It says which earlier rules it replaces, so the model is not left
// with two conflicting reading levels.
const DETAILED_RULES = `

READING LEVEL: DETAILED. This reader asked for a more advanced, more complete answer. The rules below REPLACE the
grade 6 to 8, sentence-length, word-choice, number-wording and length rules above. All other rules still apply.
- Write for an educated adult at about a grade 10 to 12 reading level. Sentences may be up to about 25 words.
- Use the correct medical and research terms (for example hypertension, randomized controlled trial, meta-analysis,
  hazard ratio, confidence interval). Explain each one in a few plain words the first time you use it.
- Give numbers as the articles report them, with units, rounded sensibly. You may report relative risks, odds ratios
  or hazard ratios, each with a short note on what it means ("a hazard ratio of 0.8, meaning about 20% lower risk").
- For each main finding, say the study design, how many people, for how long, and how big the effect was.
- Say how strong the evidence is overall, and name the limits: small studies, short follow-up, observational designs
  that cannot prove cause, or studies that disagree.
- Write 3 or 4 paragraphs with 3 to 5 sentences each (about 200 to 300 words):
  1. A direct answer that matches the strength of the evidence, then the main findings.
  2. The details of the key studies (design, size, length, effect size).
  3. Who was studied, how strong the evidence is, and its limits.
- Return "paragraphs" as a list of 3 or 4 strings.`;

// Added for a college-level answer. Like DETAILED_RULES, it says which earlier rules it replaces.
const COLLEGE_RULES = `

READING LEVEL: COLLEGE. This reader has a college education and wants a summary like one written for a university
health course. The rules below REPLACE the grade 6 to 8, sentence-length, word-choice, number-wording and length rules
above. All other rules still apply.
- Write at a college reading level (about grade 13 to 16). Sentences may be long and precise.
- Use standard medical and research terminology. Define only specialised terms a non-specialist graduate may not
  know, in a few words.
- Report statistics as the articles give them: effect sizes (mean differences, relative risks, odds ratios, hazard
  ratios) with their confidence intervals or p-values when reported, and the units.
- For each main finding, give the study design (for example randomized controlled trial, prospective cohort,
  cross-sectional study, meta-analysis), the population, the sample size, the follow-up time, and the result.
- Weigh the evidence: consistency across studies, risk of bias, confounding in observational designs, and how well the
  findings apply to adults 40 and older. Say clearly what the evidence does not show.
- Write 4 paragraphs with 3 to 5 sentences each (about 300 to 400 words):
  1. The bottom line, worded to match the strength of the evidence.
  2. The strongest evidence (trials and reviews), with numbers.
  3. Supporting or conflicting studies, with numbers.
  4. Quality of the evidence, limitations, and open questions.
- Return "paragraphs" as a list of 4 strings.`;

// The level a request asked for; anything unknown is 'plain'.
export function cleanLevel(level) {
  return LEVELS.includes(level) ? level : 'plain';
}

// The extra system-prompt text for a level ('' for plain, so plain answers use the original prompt unchanged).
export function levelRules(level) {
  if (level === 'college') return COLLEGE_RULES;
  return level === 'detailed' ? DETAILED_RULES : '';
}
