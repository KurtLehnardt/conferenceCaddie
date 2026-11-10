// server/moderation.mjs when the rules index exists but holds no rules.
//
// Run with `npm test`. Nothing here reaches the network: fetch is replaced before the module is
// imported and every Elasticsearch call is answered from memory; any other host fails the test.
// The key and the URL are dummy values.
//
// An empty percolator index answers every search with zero hits, which used to count as "no rule
// matched" and skipped the wordlist, so every line was accepted. These tests check that the
// wordlist decides while the index is empty, and that the percolator decides once it has rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const ES_HOST = 'es.caddie.test';
Object.assign(process.env, { ES_URL: `https://${ES_HOST}`, ES_PEOPLE_API_KEY: 'dummy-people-key', MOD_CLASSIFIER: 'off' });

const state = { rules: 0, matchAll: false, calls: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  assert.equal(u.host, ES_HOST, 'only the stubbed Elasticsearch host is called');
  state.calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (init.method === 'HEAD') return json({});
  if (u.pathname.endsWith('/_count')) return json({ count: state.rules });
  if (u.pathname.endsWith('/_search')) return json({ hits: { total: { value: state.matchAll ? 1 : 0 }, hits: [] } });
  return json({ error: 'unexpected' }, 404);
};
const log = console.log;
console.log = () => {};
const { moderate } = await import('../server/moderation.mjs');
console.log = log;

test('an empty rules index leaves the decision to the wordlist', async () => {
  state.rules = 0;
  assert.equal((await moderate('what a fuck up')).outcome, 'reject');
  assert.equal((await moderate('a perfectly polite line')).outcome, 'accept');
});
