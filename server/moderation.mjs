// The server-side filter for the short lines that reach other people: a presence spot line, a
// meet note and a how-to-spot-me line. Three layers, in this order:
//
// 1. In process: a web address other than linkedin.com is held back, and the line is normalised
//    (NFKC, lowercase, diacritics stripped, leet substitutions 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s).
// 2. Rules: the normalised line is percolated against the Elasticsearch index ES_RULES_INDEX
//    (default caddie-people-rules, created by scripts/es-setup-rules.mjs and filled from
//    config/moderation-words.json by scripts/moderation-rules.mjs --reload-rules). Any matching
//    rule rejects. The server reads it with the people key (ES_PEOPLE_API_KEY), which covers
//    caddie-people*, so the index must be named caddie-people-rules*. When the percolate call
//    fails or the index is missing, the in-process wordlist from config/moderation-words.json
//    decides instead, so the MVP behaviour is always there.
// 3. Classifier: Google Cloud Natural Language moderateText, a classification API (no generative
//    model), called with an access token from the Cloud Run metadata server (Application Default
//    Credentials of the runtime service account; no key, no secret). A watched category at or
//    above MOD_REJECT (0.8) rejects; at or above MOD_HOLD (0.5) holds, and so does any error or
//    timeout: the classifier fails closed, it never fails to accept. MOD_CLASSIFIER=off, or a
//    metadata server that cannot be reached when the server starts, turns it off ("classifier:
//    off" is logged once) and the rules alone decide.
//
// Exports:
//   isFiltered(line) → boolean      the MVP contract, unchanged: in-process URL rule and wordlist.
//   FILTERED                        the 400 body for a rejected line, unchanged.
//   moderate(line) → Promise<{ outcome: 'accept' | 'reject' | 'hold', body, category }>
//                                   the full filter; body is FILTERED or HELD, category the layer
//                                   or classifier category that tripped (null when accepted).
//   HELD                            the body for a held line.
//
// The filter never logs or stores the text it checks, nor the scores together with a device: it
// logs one line per checked text, "filter: accepted|rejected|held <category>".

import fs from 'node:fs';

const WORDS_FILE = new URL('../config/moderation-words.json', import.meta.url);
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

// Rules (percolator). ES_URL and the people key are the same values people.mjs uses.
const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const PEOPLE_KEY = process.env.ES_PEOPLE_API_KEY || '';
const RULES_INDEX = process.env.ES_RULES_INDEX || 'caddie-people-rules';
const RULES_TIMEOUT_MS = 3000;
const RULES_RETRY_MS = 60_000;

// Classifier.
const CLASSIFIER_MODE = (process.env.MOD_CLASSIFIER || 'off').toLowerCase(); // off (default) | auto | on
const CLASSIFIER_URL = process.env.MOD_CLASSIFIER_URL || 'https://language.googleapis.com/v1/documents:moderateText';
const METADATA_URL = process.env.MOD_METADATA_URL || 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const DEFAULT_CATEGORIES = ['Toxic', 'Insult', 'Profanity', 'Derogatory', 'Sexual', 'Violent'];
const CATEGORIES = new Set(
  (process.env.MOD_CATEGORIES ? process.env.MOD_CATEGORIES.split(',') : DEFAULT_CATEGORIES).map((c) => c.trim().toLowerCase()).filter(Boolean),
);
const REJECT_AT = numberEnv('MOD_REJECT', 0.8);
const HOLD_AT = numberEnv('MOD_HOLD', 0.5);
const TIMEOUT_MS = numberEnv('MOD_TIMEOUT_MS', 3000);
const PROBE_TIMEOUT_MS = 1500;
const TOKEN_MARGIN_MS = 60_000;

function numberEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// ---------------------------------------------------------------------------------------------
// In-process layer: normalisation, the URL rule and the wordlist (the MVP filter).

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
  // A "re:" entry is a regexp rule for the percolator only; the in-process list keeps plain words.
  return [...new Set(parsed.words.filter((w) => typeof w === 'string' && !w.startsWith('re:')).map(normalize).filter(Boolean))];
}

const PHRASES = loadPhrases();

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

const inWordlist = (normalized) => {
  const padded = ` ${normalized} `;
  return PHRASES.some((p) => padded.includes(` ${p} `));
};

// True when the line must be held back: it holds a listed word or phrase, or a web address that
// is not on linkedin.com. The MVP contract; it makes no network call.
export function isFiltered(line) {
  return inWordlist(normalize(line)) || hasForeignUrl(line);
}

// ---------------------------------------------------------------------------------------------
// Rules layer: the percolator index.

let rulesRetryAt = 0; // After a failure the wordlist decides until this time, then we try again.
let rulesState = 'unknown'; // For the transition log lines only.
let rulesKnownNonEmptyUntil = 0; // A recent count showed the index holds rules, so zero hits is a real "no match".

function noteRules(state, why) {
  if (state === rulesState) return;
  rulesState = state;
  console.log(state === 'percolator' ? `rules: percolator (${RULES_INDEX})` : `rules: wordlist (${why})`);
}

// One probe when the server starts, so the log says which layer decides. The outcome is not
// cached: every line tries the percolator unless a recent failure put it on hold.
(async () => {
  if (!PEOPLE_KEY) return noteRules('wordlist', 'ES_PEOPLE_API_KEY is not set');
  try {
    const res = await fetch(`${ES_URL}/${encodeURIComponent(RULES_INDEX)}`, { method: 'HEAD', headers: { Authorization: `ApiKey ${PEOPLE_KEY}` }, signal: AbortSignal.timeout(RULES_TIMEOUT_MS) });
    await res.body?.cancel();
    if (res.ok) noteRules('percolator');
    else noteRules('wordlist', res.status === 404 ? 'index missing' : `status ${res.status}`);
  } catch (err) {
    noteRules('wordlist', err?.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
})();

// Resolves to true (a rule matched), false (none did) or null (the index could not decide).
async function percolate(normalized) {
  if (!PEOPLE_KEY || Date.now() < rulesRetryAt) return null;
  let res;
  try {
    res = await fetch(`${ES_URL}/${encodeURIComponent(RULES_INDEX)}/_search`, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${PEOPLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 1, _source: false, query: { percolate: { field: 'query', document: { text: normalized } } } }),
      signal: AbortSignal.timeout(RULES_TIMEOUT_MS),
    });
  } catch (err) {
    rulesRetryAt = Date.now() + RULES_RETRY_MS;
    noteRules('wordlist', err?.name === 'TimeoutError' ? 'timeout' : 'network error');
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel();
    rulesRetryAt = Date.now() + RULES_RETRY_MS;
    noteRules('wordlist', res.status === 404 ? 'index missing' : `status ${res.status}`);
    return null;
  }
  let json;
  try {
    json = await res.json();
  } catch {
    rulesRetryAt = Date.now() + RULES_RETRY_MS;
    noteRules('wordlist', 'invalid response');
    return null;
  }
  const total = json.hits?.total;
  const count = typeof total === 'number' ? total : total?.value ?? json.hits?.hits?.length ?? 0;
  if (count > 0) {
    noteRules('percolator');
    return true;
  }
  // Zero hits means "no rule matched" only when the index holds rules. An index that exists but is
  // empty (a fresh setup, or a failed reload) would otherwise accept every line with the rules
  // layer silently off, so the wordlist decides until the index has rules again.
  if (Date.now() >= rulesKnownNonEmptyUntil) {
    try {
      const counted = await fetch(`${ES_URL}/${encodeURIComponent(RULES_INDEX)}/_count`, { headers: { Authorization: `ApiKey ${PEOPLE_KEY}` }, signal: AbortSignal.timeout(RULES_TIMEOUT_MS) });
      const body = counted.ok ? await counted.json() : null;
      if (!body || typeof body.count !== 'number') throw new Error('no count');
      if (body.count === 0) {
        rulesRetryAt = Date.now() + RULES_RETRY_MS;
        noteRules('wordlist', 'rules index is empty');
        return null;
      }
      rulesKnownNonEmptyUntil = Date.now() + RULES_RETRY_MS;
    } catch {
      rulesRetryAt = Date.now() + RULES_RETRY_MS;
      noteRules('wordlist', 'rules count failed');
      return null;
    }
  }
  noteRules('percolator');
  return false;
}

// ---------------------------------------------------------------------------------------------
// Classifier layer: Google Cloud Natural Language moderateText through the metadata server.

let classifierOn = false;
let token = null; // { value, expiresAt }; never logged.

async function fetchToken() {
  if (token && Date.now() < token.expiresAt - TOKEN_MARGIN_MS) return token.value;
  const res = await fetch(METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`metadata status ${res.status}`);
  }
  const json = await res.json();
  if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('metadata response without a token');
  const ttlMs = Number.isFinite(Number(json.expires_in)) ? Number(json.expires_in) * 1000 : 5 * 60_000;
  token = { value: json.access_token, expiresAt: Date.now() + ttlMs };
  return token.value;
}

// Decides once, when the server starts: MOD_CLASSIFIER=off turns it off, "on" keeps it on even
// when the metadata server cannot be reached (every line is then held), and "auto"
// turns it on only when the metadata server answers, so a local run skips it. Unset means off:
// the Natural Language API is billed and must be enabled on purpose.
const classifierReady = (async () => {
  if (CLASSIFIER_MODE === 'off') {
    classifierOn = false;
  } else if (CLASSIFIER_MODE === 'on') {
    classifierOn = true;
  } else {
    try {
      const res = await fetch(METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await res.body?.cancel();
      classifierOn = res.ok;
    } catch {
      classifierOn = false;
    }
  }
  if (classifierOn) console.log(`classifier: on (reject ${REJECT_AT}, hold ${HOLD_AT}, ${[...CATEGORIES].join(',')})`);
  else console.log('classifier: off');
  if (!RULES_INDEX.startsWith('caddie-people-')) console.warn(`ES_RULES_INDEX ${RULES_INDEX} is not caddie-people-*; the people key will not cover it and the wordlist will decide.`);
})();

// Returns { outcome, category } from the classifier: 'reject' or 'hold' with the category that
// tripped, 'accept' with null, or 'hold' with 'classifier_error' on any failure (fail closed).
async function classify(content) {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const bearer = await fetchToken();
    const res = await fetch(CLASSIFIER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ document: { type: 'PLAIN_TEXT', content } }),
      signal: deadline,
    });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) token = null; // A stale token: the next call fetches a fresh one.
      throw new Error(`status ${res.status}`);
    }
    const json = await res.json();
    const categories = Array.isArray(json.moderationCategories) ? json.moderationCategories : [];
    let top = null;
    for (const c of categories) {
      if (typeof c?.name !== 'string' || !CATEGORIES.has(c.name.toLowerCase())) continue;
      const confidence = Number(c.confidence);
      if (!Number.isFinite(confidence)) continue;
      if (!top || confidence > top.confidence) top = { name: c.name, confidence };
    }
    if (top && top.confidence >= REJECT_AT) return { outcome: 'reject', category: top.name };
    if (top && top.confidence >= HOLD_AT) return { outcome: 'hold', category: top.name };
    return { outcome: 'accept', category: null };
  } catch (err) {
    console.error(`classifier error: ${err?.name === 'TimeoutError' ? 'timeout' : err?.message ?? 'error'}`);
    return { outcome: 'hold', category: 'classifier_error' };
  }
}

// ---------------------------------------------------------------------------------------------

function result(outcome, category) {
  console.log(`filter: ${outcome === 'accept' ? 'accepted' : outcome === 'reject' ? 'rejected' : 'held'}${category ? ` ${category}` : ''}`);
  return { outcome, body: outcome === 'reject' ? FILTERED : outcome === 'hold' ? HELD : null, category };
}

// The full filter for a line other people will read. Never throws.
//   reject: answer 400 with body (FILTERED), as the MVP did.
//   hold:   store the line as pending, show it only to its author, answer with body (HELD).
//   accept: store and show it.
export async function moderate(line) {
  const text = String(line);
  if (hasForeignUrl(text)) return result('reject', 'url');
  if (!text.trim()) return result('accept', null);
  const normalized = normalize(text);
  if (normalized) {
    // A line of only symbols or emoji has no words for the rules; the classifier still sees it.
    const hit = await percolate(normalized);
    if (hit === true) return result('reject', 'rules');
    if (hit === null && inWordlist(normalized)) return result('reject', 'wordlist');
  }
  await classifierReady;
  if (!classifierOn) return result('accept', null);
  const verdict = await classify(text);
  return result(verdict.outcome, verdict.category);
}
