// The server-side wordlist filter for the short lines that reach other people: a presence spot
// line, a meet note and a how-to-spot-me line.
//
// The words and phrases come from config/moderation-words.json (see its source field). A line
// is checked after lowercasing, NFKC normalisation, diacritic stripping and the leet
// substitutions 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s; every list entry is normalised the same way and
// matches only as whole words, an entry with spaces as a phrase. A web address is held back as
// well, unless its host is linkedin.com. The filter never logs or stores the text it checks; the
// caller answers 400 with FILTERED.

import fs from 'node:fs';

const WORDS_FILE = new URL('../config/moderation-words.json', import.meta.url);
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const URL_RE = /(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|co|ai|app|me|ly|gg|xyz|info|us|uk|de|tv|link|to|sh|is|it|nl|fr|es|ca)\b(?:\/[^\s]*)?/gi;

export const FILTERED = { error: 'filtered', message: 'That was held back by the filter. Edit it and try again.' };

function normalize(s) {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[01345 7@$]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function loadPhrases() {
  const parsed = JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8'));
  if (!Array.isArray(parsed.words)) throw new Error('config/moderation-words.json must have a words array');
  return [...new Set(parsed.words.map(normalize).filter(Boolean))];
}

const PHRASES = loadPhrases();

function hostOf(match) {
  const bare = match.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
  return bare.replace(/^www\./, '');
}

// True when the line must be held back: it holds a listed word or phrase, or a web address that
// is not on linkedin.com.
export function isFiltered(line) {
  const padded = ` ${normalize(line)} `;
  if (PHRASES.some((p) => padded.includes(` ${p} `))) return true;
  for (const m of String(line).match(URL_RE) ?? []) {
    const host = hostOf(m);
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return true;
  }
  return false;
}
