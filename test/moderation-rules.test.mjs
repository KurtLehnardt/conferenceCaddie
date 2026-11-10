// scripts/moderation-rules.mjs --reload-rules, run as a child process against an in-memory stand-in
// for Elasticsearch.
//
// Run with `npm test`. Nothing here reaches the network: the child process loads a preload module
// that replaces fetch, answers every Elasticsearch call from memory and records each call in a
// file; a call to any other host fails. The keys and the URL below are dummy values.
//
// The tests check that
// - a reload refuses to run without ELASTISEARCH_API_KEY, even when the people key is set, and
//   names only the variables in its message;
// - the new rules are written before any old rule is deleted, and the index is never empty;
// - an empty wordlist, a failed write, a refused rule and a short or missing items list keep the old
//   rules and exit non-zero, and an empty index says so loudly;
// - a delete item that answers 409, 429 or 500, or has no delete result, exits 2 with the new rules live;
// - more than 500 stale rules are deleted in batches, and the round cap stops a run that cannot finish;
// - --test works with only the people key;
// - seed-people.mjs and moderation.mjs --unhide and --purge refuse to start with only the people key
//   and make no request;
// - the rule ids are stable, so a second reload leaves the same ids and removes nothing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/moderation-rules.mjs', import.meta.url));
const ES_HOST = 'es.caddie.test';
const INDEX = 'caddie-people-rules';
const ADMIN = 'dummy-admin-key';
const PEOPLE = 'dummy-people-key';

// Loaded in the child with --import. STATE_FILE holds { docs: [ids], log: [], failWrite, rejectItem }
// and is rewritten after every call.
const PRELOAD = `
import fs from 'node:fs';
const file = process.env.STUB_STATE;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host !== '${ES_HOST}') throw new Error('unexpected host ' + u.host);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  const method = init.method ?? 'GET';
  const reply = (status, json) => { fs.writeFileSync(file, JSON.stringify(st)); return new Response(JSON.stringify(json), { status }); };
  const entry = { method, path: u.pathname, search: u.search, auth: init.headers?.Authorization === 'ApiKey ${ADMIN}' ? 'admin' : 'other', before: [...st.docs] };
  st.log.push(entry);
  if (method === 'HEAD') return reply(200, {});
  if (u.pathname.endsWith('/_count')) return reply(200, { count: st.docs.length });
  if (u.pathname.endsWith('/_bulk')) {
    const lines = init.body.trim().split('\\n').map((l) => JSON.parse(l));
    if (st.failWrite && lines[0].index) return reply(503, { error: { type: 'unavailable' } });
    const items = [];
    if (st.shortItems && lines[0].index) return reply(200, { errors: false, items: [{ index: { _id: lines[0].index._id, status: 200 } }] });
    if (st.noItems && lines[0].index) return reply(200, { errors: false });
    for (let i = 0; i < lines.length; ) {
      if (lines[i].index) {
        const id = lines[i].index._id;
        if (st.rejectItem === id) { items.push({ index: { _id: id, status: 400, error: { type: 'mapper_parsing_exception' } } }); }
        else { if (!st.docs.includes(id)) st.docs.push(id); items.push({ index: { _id: id, status: 200 } }); }
        i += 2;
      } else {
        const id = lines[i].delete._id;
        if (st.deleteStatus) { items.push({ delete: { _id: id, status: st.deleteStatus } }); i += 1; continue; }
        if (st.noDeleteResult) { items.push({}); i += 1; continue; }
        st.docs = st.docs.filter((d) => d !== id);
        items.push({ delete: { _id: id, status: 200 } });
        i += 1;
      }
    }
    entry.items = lines.length;
    return reply(200, { errors: false, items });
  }
  if (u.pathname.endsWith('/_search')) {
    const body = JSON.parse(init.body);
    if (body.query.percolate) return reply(200, { hits: { hits: [] } });
    const keep = new Set(body.query.bool.must_not[0].ids.values);
    const hits = st.docs.filter((d) => !keep.has(d)).slice(0, body.size).map((_id) => ({ _id }));
    return reply(200, { hits: { hits } });
  }
  return reply(404, { error: { type: 'not_found' } });
};
`;

function reload({ words, docs = [], env = {}, state = {}, argv }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-rules-'));
  const stateFile = path.join(dir, 'state.json');
  const wordsFile = path.join(dir, 'words.json');
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(stateFile, JSON.stringify({ docs, log: [], ...state }));
  fs.writeFileSync(wordsFile, JSON.stringify({ source: 'test', words }));
  fs.writeFileSync(preload, PRELOAD);
  const childEnv = {
    PATH: process.env.PATH,
    ES_URL: `https://${ES_HOST}`,
    STUB_STATE: stateFile,
    MODERATION_WORDS_FILE: wordsFile,
    ...env,
  };
  const r = spawnSync(process.execPath, ['--import', preload, SCRIPT, ...(argv ?? ['--reload-rules'])], { env: childEnv, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, null, 'the child finished on its own');
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr, ...after };
}

const adminEnv = { ELASTISEARCH_API_KEY: ADMIN };
const WORDS = ['badword', 'two words', 're:fu+ck+'];

describe('moderation-rules --reload-rules', () => {
  test('refuses to run without the admin key, even with the people key set', () => {
    const r = reload({ words: WORDS, docs: ['old-1'], env: { ES_PEOPLE_API_KEY: PEOPLE } });
    assert.equal(r.code, 1);
    assert.match(r.err, /ELASTISEARCH_API_KEY/);
    assert.doesNotMatch(r.err + r.out, new RegExp(PEOPLE));
    assert.equal(r.log.length, 0, 'no request was sent');
    assert.deepEqual(r.docs, ['old-1']);
  });

  test('prefers the admin key over the people key when both are set', () => {
    const r = reload({ words: WORDS, env: { ...adminEnv, ES_PEOPLE_API_KEY: PEOPLE } });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.log.every((c) => c.auth === 'admin'));
  });

  test('writes the new rules before it deletes any old rule, and the index is never empty', () => {
    const r = reload({ words: WORDS, docs: ['old-1', 'old-2'], env: adminEnv });
    assert.equal(r.code, 0, r.err);
    const writeAt = r.log.findIndex((c) => c.path.endsWith('/_bulk') && c.search.includes('refresh=wait_for') && c.items === WORDS.length * 2);
    const deleteAt = r.log.findIndex((c, i) => i > writeAt && c.path.endsWith('/_bulk'));
    assert.ok(writeAt >= 0 && deleteAt > writeAt, 'the write comes first, a delete bulk after it');
    assert.ok(!r.log.some((c) => c.path.includes('_delete_by_query')), 'no delete_by_query');
    assert.ok(r.log.every((c) => c.before.length > 0), 'the index held rules at every call');
    assert.equal(r.docs.length, WORDS.length);
    assert.ok(!r.docs.includes('old-1') && !r.docs.includes('old-2'));
    assert.match(r.out, /removed 2 others/);
  });

  test('ids are stable, so a second reload writes the same ids and removes nothing', () => {
    const first = reload({ words: WORDS, env: adminEnv });
    const second = reload({ words: WORDS, docs: first.docs, env: adminEnv });
    assert.equal(second.code, 0, second.err);
    assert.deepEqual([...second.docs].sort(), [...first.docs].sort());
    assert.match(second.out, /removed 0 others/);
    assert.ok(first.docs.every((id) => /^(w|re)-[0-9a-f]{10}$/.test(id)));
  });

  test('an empty wordlist keeps the old rules and exits non-zero', () => {
    const r = reload({ words: ['', '   '], docs: ['old-1'], env: adminEnv });
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.docs, ['old-1']);
    assert.ok(!r.log.some((c) => c.path.endsWith('/_bulk')));
  });

  test('a failed write keeps the old rules and exits non-zero', () => {
    const r = reload({ words: WORDS, docs: ['old-1', 'old-2'], env: adminEnv, state: { failWrite: true } });
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.docs, ['old-1', 'old-2']);
    assert.ok(!r.log.some((c) => c.path.endsWith('/_search')), 'nothing was searched for deletion');
  });

  test('a rule Elasticsearch refuses deletes nothing and exits 2', () => {
    const probe = reload({ words: WORDS, env: adminEnv });
    const refused = probe.docs[0];
    const r = reload({ words: WORDS, docs: ['old-1'], env: adminEnv, state: { rejectItem: refused } });
    assert.equal(r.code, 2);
    assert.ok(r.docs.includes('old-1'));
  });

  test('a missing or short items list keeps the old rules and exits 2', () => {
    for (const state of [{ shortItems: true }, { noItems: true }]) {
      const r = reload({ words: WORDS, docs: ['old-1'], env: adminEnv, state });
      assert.equal(r.code, 2, JSON.stringify(state));
      assert.ok(r.docs.includes('old-1'));
      assert.ok(!r.log.some((c) => c.path.endsWith('/_search')), 'nothing was searched for deletion');
    }
  });

  test('a failed write into an empty index says that rule moderation is off', () => {
    const r = reload({ words: WORDS, env: adminEnv, state: { failWrite: true } });
    assert.equal(r.code, 2);
    assert.match(r.err, /WARNING/);
  });

  for (const status of [409, 429, 500]) {
    test(`a delete item answering ${status} exits 2 and the new rules stay live`, () => {
      const r = reload({ words: WORDS, docs: ['old-1'], env: adminEnv, state: { deleteStatus: status } });
      assert.equal(r.code, 2);
      assert.match(r.err, /new rules are live/);
      assert.equal(r.docs.length, WORDS.length + 1);
    });
  }

  test('a delete item without a delete result counts as a failure', () => {
    const r = reload({ words: WORDS, docs: ['old-1'], env: adminEnv, state: { noDeleteResult: true } });
    assert.equal(r.code, 2);
  });

  test('more than 500 stale rules are removed in several batches', () => {
    const stale = Array.from({ length: 1203 }, (_, i) => `old-${i}`);
    const r = reload({ words: WORDS, docs: stale, env: adminEnv });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.docs.length, WORDS.length);
    assert.match(r.out, /removed 1203 others/);
    assert.equal(r.log.filter((c) => c.path.endsWith('/_bulk')).length, 1 + 3);
  });

  test('the round cap stops a run that cannot finish and says the new rules are live', () => {
    const stale = Array.from({ length: 500 * 20 + 1 }, (_, i) => `old-${i}`);
    const r = reload({ words: WORDS, docs: stale, env: adminEnv });
    assert.equal(r.code, 2);
    assert.match(r.err, /Too many old rules/);
    assert.ok(WORDS.length <= r.docs.length);
  });

  test('--test works with only the people key', () => {
    const r = reload({ words: WORDS, env: { ES_PEOPLE_API_KEY: PEOPLE }, argv: ['--test', 'hello'] });
    assert.notEqual(r.code, 1, r.err);
    assert.ok(r.log.length > 0 && r.log.every((c) => c.auth === 'other'));
  });

  test('a words file override is named in the summary', () => {
    const r = reload({ words: WORDS, env: adminEnv });
    assert.match(r.out, /words\.json/);
  });
});

// seed-people.mjs and moderation.mjs, started with the people key only. Every fetch throws, so a
// request would show up as a crash with a different message; the scripts must stop first.
describe('scripts that need the admin key', () => {
  const NO_FETCH = 'globalThis.fetch = () => { throw new Error("a request was made"); };';
  const cases = [
    ['seed-people.mjs', ['--event', 'test-conf']],
    ['moderation.mjs', ['--event', 'test-conf', '--unhide', `profile:${'0'.repeat(16)}`]],
    ['moderation.mjs', ['--event', 'test-conf', '--purge']],
  ];
  for (const [script, args] of cases) {
    test(`${script} ${args.slice(2).join(' ')} refuses the people key alone`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-nofetch-'));
      const preload = path.join(dir, 'preload.mjs');
      fs.writeFileSync(preload, NO_FETCH);
      const r = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...args], {
        env: { PATH: process.env.PATH, ES_URL: `https://${ES_HOST}`, ES_PEOPLE_API_KEY: PEOPLE },
        encoding: 'utf8',
        timeout: 30_000,
      });
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(r.signal, null);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /ELASTISEARCH_API_KEY/);
      assert.doesNotMatch(r.stderr + r.stdout, /a request was made/);
      assert.doesNotMatch(r.stderr + r.stdout, new RegExp(PEOPLE));
    });
  }
});
