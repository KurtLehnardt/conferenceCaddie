// POST /api/import/schedule inside the ConferenceDO (PLAN section 1.7): finds the conference's
// talks in a personal schedule an attendee exported from anywhere, so the app can offer to mark
// them as Interested on the device.
//
// Body: { event, text } for pasted or browser-extracted text, or { event, filename?, mime?,
// content_base64 } for an iCalendar, CSV, JSON or plain-text file. The Worker accepts text only:
// a PDF, Word, OpenDocument or RTF file gets 415 { error: 'extract_in_browser' }, because the
// free stack's web app extracts their text in the browser and sends it as text. Anything that is
// neither a document nor UTF-8 text gets 415 with the server's "not supported" message.
// Response: { matched: [ { talk, confidence, matched_text_excerpt } ], unmatched_count,
// extracted_chars }, exactly as server/import.mjs.
//
// Matching runs in memory over an inverted token index of the conference's kind-talk titles and
// speakers (folded, English stop words removed, Porter-stemmed titles), reproducing the named
// queries of the Elasticsearch version:
//   exact_title  the candidate's words appear as a phrase in the title (three content words or more)
//   title_words  the title holds "3<75%" of the candidate's words
//   speaker      at least two words of the candidate's nearby speaker text are in the speakers
//   time         the talk starts within the minute the file gives
// A hit must match exact_title or title_words, and is scored with BM25 on the title plus the
// speaker and time clauses. The best hit per candidate is kept, then the best per talk, and the
// confidence label comes from every clause that matched for that talk.
//
// Privacy: the upload lives in memory for this one request. Nothing is stored, nothing is read
// from SQLite, and nothing of the content is logged.

import { HttpError, bad, isPlainObject } from '../lib/http.js';
import { escapeHtml, minimumShouldMatch } from '../lib/text.js';
import { memo, talkOnly } from './cache.js';
import { analyzed, words } from './analyze.js';
import { validEvent } from './recommend.js';
import { toResult } from './shape.js';
import { MAX_ENTRIES, buildCandidates, csvEntries, icsEntries, jsonEntries, textEntries, textFormat } from './import-parse.js';

const MAX_DECODED = 5 * 1024 * 1024;
const MAX_TEXT = 200_000;
const EXCERPT_MAX = 160;
const TITLE_MIN_MATCH = '3<75%';
const K1 = 1.2;
const B = 0.75;
export const KEYS = new Set(['event', 'filename', 'mime', 'content_base64', 'text']);

const TOO_LARGE = 'That file is larger than 5 MB. Export a shorter schedule, or paste its text instead.';
const UNSUPPORTED = 'That file type is not supported. Use a PDF, CSV, plain text, calendar (.ics) or JSON file.';
const UNREADABLE = 'No text could be read from that file. If it is a scanned or password-protected PDF, export the schedule as text or CSV instead.';
export const RATE_MESSAGE = 'Too many imports in a short time. Wait a minute and try again.';

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DOC_EXT_RE = /\.(pdf|docx?|odt|rtf)$/i;
const DOC_MIME_RE = /^(?:application\/(?:pdf|msword|rtf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.oasis\.opendocument\.text)|text\/rtf)\b/i;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const fail = (status, message) => new HttpError(status, { error: message });

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function validate(body) {
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  for (const k of Object.keys(body)) if (!KEYS.has(k)) throw bad(`Unknown key: ${k.slice(0, 40)}`);
  validEvent(body.event);
  const hasFile = body.content_base64 !== undefined;
  const hasText = body.text !== undefined;
  if (hasFile === hasText) throw bad('Send either content_base64 or text');
  if (hasText && (body.filename !== undefined || body.mime !== undefined)) throw bad('filename and mime go with content_base64 only');
  if (body.filename !== undefined && (typeof body.filename !== 'string' || body.filename.length > 255)) throw bad('filename must be a string of at most 255 characters');
  if (body.mime !== undefined && (typeof body.mime !== 'string' || body.mime.length > 127)) throw bad('mime must be a string of at most 127 characters');
  let bytes = null;
  let text = null;
  if (hasFile) {
    if (typeof body.content_base64 !== 'string') throw bad('content_base64 must be a string');
    const b64 = body.content_base64.replace(/\s+/g, '');
    if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) throw bad('content_base64 is not valid base64');
    if ((b64.length / 4) * 3 > MAX_DECODED + 2) throw fail(413, TOO_LARGE);
    bytes = decodeBase64(b64);
    if (bytes.length > MAX_DECODED) throw fail(413, TOO_LARGE);
    if (!bytes.length) throw fail(422, 'That file is empty.');
  } else {
    if (typeof body.text !== 'string') throw bad('text must be a string');
    if (body.text.length > MAX_TEXT) throw fail(413, 'That text is too long. Paste at most 200,000 characters.');
    if (!body.text.trim()) throw fail(422, 'Paste the text of your schedule first.');
    text = body.text;
  }
  return { bytes, text, filename: body.filename ?? '', mime: body.mime ?? '' };
}

const startsWith = (bytes, sig) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);

// A document that only the browser can turn into text, by its name, type or first bytes.
function isDocument(bytes, filename, mime) {
  if (DOC_EXT_RE.test(filename) || DOC_MIME_RE.test(mime)) return true;
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return true;
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return true;
  if (startsWith(bytes, OLE_MAGIC)) return true;
  return head.startsWith('{\\rtf');
}

function decodeText(bytes, filename, mime) {
  if (isDocument(bytes, filename, mime)) throw fail(415, 'extract_in_browser');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail(415, UNSUPPORTED);
  }
}

// ---------------------------------------------------------------------------------------------
// The in-memory index of the conference's kind-talk titles and speakers.

const importIndex = (store) => memo(store, 'importIndex', () => {
  const docs = talkOnly(store).map((t) => {
    const title = analyzed(t.title);
    const tf = new Map();
    for (const w of title) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { t, title, tf, speakers: new Set(t.speakers.flatMap((s) => words(s))) };
  });
  const titleIdx = new Map();
  const speakerIdx = new Map();
  let total = 0;
  docs.forEach((d, i) => {
    total += d.title.length;
    for (const w of d.tf.keys()) (titleIdx.get(w) ?? titleIdx.set(w, []).get(w)).push(i);
    for (const w of d.speakers) (speakerIdx.get(w) ?? speakerIdx.set(w, []).get(w)).push(i);
  });
  return { docs, titleIdx, speakerIdx, avg: docs.length ? total / docs.length : 1 };
});

const idf = (n, df) => Math.log(1 + (n - df + 0.5) / (df + 0.5));

function containsPhrase(seq, phrase) {
  if (!phrase.length || phrase.length > seq.length) return false;
  outer: for (let i = 0; i + phrase.length <= seq.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (seq[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

// The best talk for one candidate: { doc, score, names } or null.
function matchCandidate(index, c) {
  const { docs, titleIdx, speakerIdx, avg } = index;
  const n = docs.length;
  const phrase = analyzed(c.text);
  const terms = [...new Set(phrase)];
  if (!terms.length) return null;
  const need = minimumShouldMatch(terms.length, TITLE_MIN_MATCH);
  const acc = new Map(); // doc index -> { score, matched, idfSum }
  for (const term of terms) {
    const posting = titleIdx.get(term);
    if (!posting) continue;
    const w = idf(n, posting.length);
    for (const i of posting) {
      const d = docs[i];
      const tf = d.tf.get(term);
      const s = (w * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.title.length) / avg));
      const a = acc.get(i) ?? { score: 0, matched: 0, idfSum: 0 };
      a.score += s;
      a.matched += 1;
      a.idfSum += w;
      acc.set(i, a);
    }
  }
  const context = c.context ? [...new Set(words(c.context))] : [];
  const hint = c.hint ? Date.parse(c.hint) : NaN;
  let best = null;
  for (const [i, a] of acc) {
    const d = docs[i];
    const names = [];
    let score = 0;
    if (c.exact && containsPhrase(d.title, phrase)) {
      names.push('exact_title');
      score += a.idfSum;
    }
    if (a.matched >= need) {
      names.push('title_words');
      score += a.score;
    }
    if (!names.length) continue;
    if (context.length >= 2) {
      let hits = 0;
      let s = 0;
      for (const w of context) {
        if (!d.speakers.has(w)) continue;
        hits += 1;
        s += idf(n, speakerIdx.get(w)?.length ?? 1);
      }
      if (hits >= 2) {
        names.push('speaker');
        score += s;
      }
    }
    if (Number.isFinite(hint) && d.t.start_ms >= hint && d.t.start_ms < hint + 60_000) {
      names.push('time');
      score += 1;
    }
    if (!best || score > best.score || (score === best.score && i < best.i)) best = { i, doc: d, score, names };
  }
  return best;
}

function confidence(names) {
  if (names.has('exact_title')) return 'exact_title';
  if (names.has('speaker')) return 'title_and_speaker';
  if (names.has('time')) return 'title_and_time';
  return 'title_words';
}

function excerpt(textValue) {
  if (textValue.length <= EXCERPT_MAX) return textValue;
  const cut = textValue.slice(0, EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${space > EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut}…`;
}

export function runImport(ctx, { bytes, text, filename, mime }) {
  let content = bytes ? decodeText(bytes, filename, mime) : text;
  content = content.replace(/^﻿/, '');
  if (!content.trim()) throw fail(422, UNREADABLE);
  const conference = { slug: ctx.slug, start_date: ctx.conf?.start_date ?? null, time_zone: ctx.conf?.time_zone ?? null };
  const { format, value } = textFormat(content, filename, mime);
  let entries;
  if (format === 'ics') entries = icsEntries(content, conference);
  else if (format === 'json') entries = jsonEntries(value, conference);
  else if (format === 'csv') entries = csvEntries(content, conference, filename);
  else entries = textEntries(content, conference);

  const candidates = buildCandidates(entries.slice(0, MAX_ENTRIES));
  const index = importIndex(ctx.store);
  const best = new Map(); // talk_id -> { hit, candidate, names }
  const matchedEntries = new Set();
  const entriesWithCandidates = new Set();
  for (const c of candidates) {
    for (const e of c.entries) entriesWithCandidates.add(e);
    const hit = matchCandidate(index, c);
    if (!hit) continue;
    for (const e of c.entries) matchedEntries.add(e);
    const id = hit.doc.t.talk_id;
    const prev = best.get(id);
    if (!prev) best.set(id, { hit, candidate: c, names: new Set(hit.names) });
    else {
      for (const name of hit.names) prev.names.add(name);
      if (hit.score > prev.hit.score) {
        prev.hit = hit;
        prev.candidate = c;
      }
    }
  }
  const found = [...best.values()].sort((a, b) => Math.min(...a.candidate.entries) - Math.min(...b.candidate.entries));
  const labels = ctx.store.topics().labels;
  return {
    matched: found.map((f) => ({
      talk: toResult(f.hit.doc.t, labels, escapeHtml(f.hit.doc.t.title ?? '')),
      confidence: confidence(f.names),
      matched_text_excerpt: excerpt(f.candidate.text),
    })),
    unmatched_count: [...entriesWithCandidates].filter((e) => !matchedEntries.has(e)).length,
    extracted_chars: content.length,
  };
}
