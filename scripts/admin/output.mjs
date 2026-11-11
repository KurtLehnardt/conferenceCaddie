// Output of the caddie-admin CLI. With --json, one JSON object on stdout. Otherwise one line per
// item and one summary line.
//
// Every printed value may be user text (a display name, with --text the profile text), and a
// terminal acts on control characters: an OSC 52 sequence in a display name writes the operator's
// clipboard, CSI 2J clears the screen, and a bidi override makes a line read backwards. So every
// value is escaped before it is written: C0 controls (except tab; a newline inside a cell too),
// DEL, C1 controls and the bidi controls are shown as \u{XX}. In JSON, JSON.stringify escapes C0
// already; DEL, C1 and the bidi controls become \uXXXX escapes, which leaves the JSON the same
// document. The audit log takes no free text at all (audit.mjs).

// U+0000-U+0008 and U+000A-U+001F (C0 but tab), U+007F (DEL), U+0080-U+009F (C1), U+061C (Arabic
// letter mark), U+200E and U+200F (LRM, RLM), U+202A-U+202E (embeddings and overrides), U+2066-U+2069
// (isolates).
const HUMAN_UNSAFE_RE = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;
const JSON_UNSAFE_RE = /[\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

// Human text: each control character shown as \u{XX}.
export function escapeControls(text) {
  return String(text).replace(HUMAN_UNSAFE_RE, (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`);
}

// A serialised JSON document: the characters JSON.stringify leaves in place become \uXXXX escapes
// inside their string literals (every match is a single UTF-16 unit inside a string, because the
// structural characters of JSON are ASCII).
export function escapeJsonControls(serialised) {
  return String(serialised).replace(JSON_UNSAFE_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function renderJson({ command, backend, tier, mode, result }) {
  return `${escapeJsonControls(JSON.stringify({ ok: true, command, backend, tier, result: { mode, ...(result ?? {}) } }))}\n`;
}

function cell(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return escapeControls(JSON.stringify(value));
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
