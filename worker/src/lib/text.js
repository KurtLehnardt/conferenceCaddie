// Text helpers for search, evidence and snippets.

// The control characters people text may not hold: C0 controls other than tab and newline, DEL,
// and the C1 controls U+0080 to U+009F (0x9B is a one-byte CSI). Bidirectional marks and isolates
// are not controls in this sense and stay, because right-to-left text needs them.
const CONTROLS_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// People text as it is stored (profile fields, a spot line, a meet note): CRLF and a lone CR
// become a newline, then every control character above is dropped. Stripped rather than refused,
// so a pasted line with a stray control still saves, and a terminal or a log that shows the text
// to the operator never gets an escape sequence. A value that is not a string is returned as it
// is, for the caller's own type check.
export function stripControls(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(CONTROLS_RE, '') : value;
}

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const unescapeHtml = (s) => String(s).replace(/<\/?mark>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Collapses whitespace, drops trailing punctuation, and cuts at a word boundary with an ellipsis.
export function cutText(raw, max) {
  let t = String(raw).replace(/\s+/g, ' ').trim().replace(/[.!?;:,\s]+$/, '');
  if (t.length > max) {
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(' ');
    t = `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
  }
  return t;
}

// Lucene's English stop words (the 33 of EnglishAnalyzer.ENGLISH_STOP_WORDS_SET).
export const STOPWORDS = new Set(
  'a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with'.split(' '),
);

const MAX_TERMS = 12;

// The query's search terms: lowercased, split on anything that is not a letter or a digit, stop
// words dropped, deduplicated in order, at most 12.
export function queryTerms(textValue) {
  const out = [];
  const seen = new Set();
  for (const w of String(textValue ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

// One term quoted for an FTS5 MATCH expression, so it is never read as an operator.
export const ftsTerm = (term) => `"${String(term).replace(/"/g, '""')}"`;

// Elasticsearch's minimum_should_match for n optional clauses. Supports an integer ("2"), a
// percentage ("60%", "-25%"), and conditional specs ("2<60%", "3<75%", "2<-25% 9<-3"): with
// "a<b", up to a clauses all are required, above a the spec b applies. The result is between 1
// and n when n > 0.
export function minimumShouldMatch(n, spec) {
  if (n <= 0) return 0;
  const one = (s) => {
    s = String(s).trim();
    if (s.endsWith('%')) {
      const pct = Number(s.slice(0, -1));
      const v = Math.floor((n * Math.abs(pct)) / 100);
      return pct < 0 ? n - v : v;
    }
    const v = Number(s);
    return v < 0 ? n + v : v;
  };
  let result = n;
  const s = String(spec ?? '').trim();
  if (s.includes('<')) {
    result = n;
    for (const part of s.split(/\s+/)) {
      const [lim, rest] = part.split('<');
      if (n > Number(lim)) result = one(rest);
    }
  } else if (s) {
    result = one(s);
  }
  return Math.min(n, Math.max(1, result));
}

// A snippet or highlight made with the sentinels \u0002 (start) and \u0003 (end): the text is
// HTML-escaped, then the sentinels become <mark> and </mark>.
export const marked = (snippet) => escapeHtml(String(snippet ?? '')).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');
