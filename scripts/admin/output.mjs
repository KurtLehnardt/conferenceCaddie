// Output of the caddie-admin CLI. With --json, one JSON object on stdout. Otherwise one line per
// item and one summary line.
//
// Every printed value may be user text (a display name, with --text the profile text), and a
// terminal acts on control characters: an OSC 52 sequence in a display name writes the operator's
// clipboard, CSI 2J clears the screen, a bidi override makes a line read backwards, and invisible
// format characters make two names look alike or carry hidden text. So every value is escaped
// before it is written. The audit log takes no free text at all (audit.mjs).
//
// What is escaped: every control (\p{Cc}: C0, DEL and C1) but tab, every format character
// (\p{Cf}: the bidi controls, the zero-width space and joiners, the soft hyphen, the byte-order
// mark, the tag characters U+E0000-U+E007F and the rest), the line and paragraph separators
// (\p{Zl}, \p{Zp}) and, in human output, a lone surrogate and the backslash itself, so a name that
// holds the text "\u{1B}" cannot pass for an escaped ESC.
// - Human output shows each as \u{XX} (the code point in hex) and a backslash as \\. One exception,
//   for readable names: the zero-width joiner U+200D is kept inside an emoji ZWJ sequence (a
//   pictograph, optionally U+FE0F or a skin tone, the joiner, a pictograph), so a name that ends in
//   the "woman technologist" emoji prints as the person wrote it. A joiner anywhere else, between
//   letters for example, is escaped. The joiner moves no cursor and changes no direction; inside
//   such a sequence it only selects the combined glyph.
// - JSON: JSON.stringify escapes C0, the backslash and lone surrogates already; every other match
//   becomes \uXXXX escapes of its UTF-16 units (a surrogate pair for a code point above U+FFFF), so
//   the JSON parses to the same document. The joiner is escaped there too; its escape parses back
//   to the same text. An object inside a human line prints as its JSON, escaped the JSON way.
// Every pattern here is written with escapes, so this file holds no invisible character.

const HUMAN_UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\\]/gu;
const JSON_UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const PICTOGRAPH_RE = /^\p{Extended_Pictographic}$/u;
const EMOJI_TAIL_RE = /^[\u{FE0F}\u{1F3FB}-\u{1F3FF}]$/u;
const ZWJ = String.fromCharCode(0x200d);

// The code point that ends just before index i of text, or null.
function codePointBefore(text, i) {
  if (i <= 0) return null;
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}

// The joiner at index i of text sits inside an emoji ZWJ sequence.
function emojiJoiner(text, i) {
  const next = text.codePointAt(i + 1);
  if (next === undefined || !PICTOGRAPH_RE.test(String.fromCodePoint(next))) return false;
  let before = codePointBefore(text, i);
  if (before !== null && EMOJI_TAIL_RE.test(before)) before = codePointBefore(text, i - before.length);
  return before !== null && PICTOGRAPH_RE.test(before);
}

// Human text: each unsafe character shown as \u{XX}, a backslash as \\.
export function escapeControls(text) {
  return String(text).replace(HUMAN_UNSAFE_RE, (c, i, all) => {
    if (c === '\t') return c;
    if (c === '\\') return '\\\\';
    if (c === ZWJ && emojiJoiner(all, i)) return c;
    return `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`;
  });
}

// A serialised JSON document: the characters JSON.stringify leaves in place become \uXXXX escapes
// of their UTF-16 units inside their string literals (the structural characters of JSON are ASCII,
// so every match is inside a string).
export function escapeJsonControls(serialised) {
  return String(serialised).replace(JSON_UNSAFE_RE, (c) => {
    let out = '';
    for (let k = 0; k < c.length; k++) out += `\\u${c.charCodeAt(k).toString(16).padStart(4, '0')}`;
    return out;
  });
}

export function renderJson({ command, backend, tier, mode, result }) {
  return `${escapeJsonControls(JSON.stringify({ ok: true, command, backend, tier, result: { mode, ...(result ?? {}) } }))}\n`;
}

function cell(value) {
  if (value === null || value === undefined) return '-';
  // An object prints as its JSON, escaped as JSON (its backslashes are already JSON escapes).
  if (typeof value === 'object') return escapeJsonControls(JSON.stringify(value));
  return escapeControls(String(value));
}

function itemLine(item) {
  if (item === null || typeof item !== 'object') return cell(item);
  return Object.entries(item).map(([key, value]) => `${escapeControls(key)}=${cell(value)}`).join(' ');
}

export function renderHuman({ command, mode, result }) {
  const r = result ?? {};
  const lines = (Array.isArray(r.items) ? r.items : []).map(itemLine);
  const tail = mode === 'dry-run' ? ' (dry-run, nothing changed)' : '';
  lines.push(`${escapeControls(r.summary ?? `${command}: ok`)}${tail}`);
  return `${lines.join('\n')}\n`;
}
