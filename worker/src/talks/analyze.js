// Word analysis for the in-memory text paths of the talks module: the lexical fallback used when
// the rows-read soft cap is reached, schedule-import matching and topic matching. SQLite's FTS5
// index uses the porter tokenizer over unicode61 with diacritics removed, so the in-memory paths
// fold accents and apply the same Porter stemmer to both sides of every comparison.

import { STOPWORDS } from '../lib/text.js';

// Lowercase, accents folded, split on anything that is not a letter or a digit.
export function words(textValue) {
  return String(textValue ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// The normaliser of the facet keys (server/facets.mjs normalizeKey): lowercase, accents folded,
// anything that is not a letter or digit turned into one space.
export function normalizeKey(textValue) {
  return String(textValue ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// The Porter stemmer (M. F. Porter, 1980), the algorithm behind FTS5's porter tokenizer and
// Elasticsearch's porter_stem filter. Only plain ASCII words are stemmed; others pass unchanged.

const STEP2 = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble', alli: 'al', entli: 'ent', eli: 'e',
  ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous',
  aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log',
};
const STEP3 = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };
const CONS = '[^aeiou]';
const VOW = '[aeiouy]';
const CS = `${CONS}[^aeiouy]*`;
const VS = `${VOW}[aeiou]*`;
const MGR0 = new RegExp(`^(${CS})?${VS}${CS}`);
const MEQ1 = new RegExp(`^(${CS})?${VS}${CS}(${VS})?$`);
const MGR1 = new RegExp(`^(${CS})?${VS}${CS}${VS}${CS}`);
const S_V = new RegExp(`^(${CS})?${VOW}`);
const CVC = new RegExp(`^${CS}${VOW}[^aeiouwxy]$`);
const DOUBLE = /([^aeiouylsz])\1$/;
const STEP2_RE = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const STEP3_RE = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const STEP4_RE = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
const STEP4_ION = /^(.+?)(s|t)(ion)$/;

const stemCache = new Map();

export function stem(word) {
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;
  const hit = stemCache.get(word);
  if (hit !== undefined) return hit;
  let w = word;
  const firstY = w[0] === 'y';
  if (firstY) w = `Y${w.slice(1)}`;
  let m;
  // Step 1a.
  if ((m = /^(.+?)(ss|i)es$/.exec(w))) w = m[1] + m[2];
  else if ((m = /^(.+?)([^s])s$/.exec(w))) w = m[1] + m[2];
  // Step 1b.
  if ((m = /^(.+?)eed$/.exec(w))) {
    if (MGR0.test(m[1])) w = w.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(w))) {
    if (S_V.test(m[1])) {
      w = m[1];
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (DOUBLE.test(w)) w = w.slice(0, -1);
      else if (CVC.test(w)) w += 'e';
    }
  }
  // Step 1c.
  if ((m = /^(.+?)y$/.exec(w)) && S_V.test(m[1])) w = `${m[1]}i`;
  // Step 2.
  if ((m = STEP2_RE.exec(w)) && MGR0.test(m[1])) w = m[1] + STEP2[m[2]];
  // Step 3.
  if ((m = STEP3_RE.exec(w)) && MGR0.test(m[1])) w = m[1] + STEP3[m[2]];
  // Step 4.
  if ((m = STEP4_RE.exec(w))) {
    if (MGR1.test(m[1])) w = m[1];
  } else if ((m = STEP4_ION.exec(w))) {
    const s = m[1] + m[2];
    if (MGR1.test(s)) w = s;
  }
  // Step 5.
  if ((m = /^(.+?)e$/.exec(w))) {
    const s = m[1];
    if (MGR1.test(s) || (MEQ1.test(s) && !CVC.test(s))) w = s;
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);
  if (firstY) w = `y${w.slice(1)}`;
  if (stemCache.size > 20_000) stemCache.clear();
  stemCache.set(word, w);
  return w;
}

// The analysed terms of a text in order: folded words, English stop words removed, stemmed.
export function analyzed(textValue) {
  const out = [];
  for (const w of words(textValue)) if (!STOPWORDS.has(w)) out.push(stem(w));
  return out;
}

// The distinct analysed terms of a text, as a Set.
export const termSet = (textValue) => new Set(analyzed(textValue));
