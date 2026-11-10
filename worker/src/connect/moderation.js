// The filter for the short lines that reach other people: a presence spot line, a meet note and a
// how-to-spot-me line. A port of the word-list path of server/moderation.mjs (PLAN section 1.9);
// the Elasticsearch percolator and the classifier do not exist on the free stack, so every line
// is decided here, synchronously, with no network call.
//
// 1. A web address other than linkedin.com rejects the line.
// 2. The line is normalised (NFKC, lowercase, diacritics stripped, leet substitutions 0→o 1→i
//    3→e 4→a 5→s 7→t @→a $→s, everything that is not a letter or digit becomes one space), and any
//    listed word or phrase from config/moderation-words.json, matched as whole words, rejects it.
// 3. An entry starting with "re:" is a regexp rule. The percolator matched those against single
//    analysed tokens; here each is compiled once as an anchored JavaScript regexp and tested
//    against every token of the normalised line. A rule that does not compile is skipped.
//
// Nothing is ever logged or stored about the text that was checked.

import wordsFile from '../../../config/moderation-words.json';

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
// A web address is one of two shapes. With a scheme or www., anything counts. A bare domain
// counts only when a '/' path follows it, for any listed top-level domain. A bare domain alone is
// not taken for an address, so normal tech text (node.js, v1.2, k8s.io, socket.io, install.sh,
// example.com) and a missed space after a full stop ("jacket.It is me") pass.
const URL_RES = [
  /(?:https?:\/\/|www\.)[^\s]+/gi,
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|co|ai|app|me|ly|gg|xyz|info|us|uk|de|tv|link|to|sh|is|it|nl|fr|es|ca)\/[^\s]*/gi,
];

export const FILTERED = { error: 'filtered', message: 'That was held back by the filter. Edit it and try again.' };
export const HELD = { error: 'held', message: 'Waiting for the filter; it will appear shortly.' };

export function normalize(s) {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[01345 7@$]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const entries = Array.isArray(wordsFile?.words) ? wordsFile.words.filter((w) => typeof w === 'string') : [];
const PHRASES = [...new Set(entries.filter((w) => !w.startsWith('re:')).map(normalize).filter(Boolean))];
const TOKEN_RULES = entries
  .filter((w) => w.startsWith('re:') && w.length > 3)
  .map((w) => {
    try {
      return new RegExp(`^(?:${w.slice(3)})$`, 'u');
    } catch {
      return null;
    }
  })
  .filter(Boolean);

function hostOf(match) {
  const bare = match.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
  return bare.replace(/^www\./, '');
}

function hasForeignUrl(line) {
  for (const m of URL_RES.flatMap((re) => String(line).match(re) ?? [])) {
    const host = hostOf(m);
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return true;
  }
  return false;
}

function inWordlist(normalized) {
  const padded = ` ${normalized} `;
  if (PHRASES.some((p) => padded.includes(` ${p} `))) return true;
  if (!TOKEN_RULES.length) return false;
  return normalized.split(' ').some((token) => TOKEN_RULES.some((re) => re.test(token)));
}

// True when the line must be held back: a listed word or phrase, a regexp rule on one of its
// words, or a web address that is not on linkedin.com.
export function isFiltered(line) {
  return hasForeignUrl(line) || inWordlist(normalize(line));
}

// The filter's verdict for a line other people will read: { outcome: 'accept' | 'reject', body }.
// body is FILTERED for a rejected line (answered with 400) and null otherwise. There is no
// classifier on the free stack, so nothing is ever held.
export function moderate(line) {
  return isFiltered(String(line)) ? { outcome: 'reject', body: FILTERED } : { outcome: 'accept', body: null };
}
