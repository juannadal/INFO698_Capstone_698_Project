// Flesch-Kincaid grade level: 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59.
// Syllables are estimated from vowel groups, which is close enough to show a grade (Stretch feature 1).

// The grade of a list of sentences, to one decimal and never below 0. Null when there is no text.
export function fleschKincaidGrade(sentences) {
  const words = sentences.flatMap((s) => s.match(/[A-Za-z]+(?:'[a-z]+)?/g) || []);
  if (!words.length || !sentences.length) return null;
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;
  return Math.round(Math.max(0, grade) * 10) / 10;
}

// Estimate syllables as vowel groups, after dropping a usually silent ending (-es, -ed, -e). Short words count as 1.
export function countSyllables(word) {
  const w = word.toLowerCase().replace(/'s$/, '');
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}
