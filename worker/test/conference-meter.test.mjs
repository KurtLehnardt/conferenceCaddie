// How ConferenceDO (src/conference.js) wires the usage meter: the order of draining the metered
// cursors and reading the meter, the cron's reading, the meter restart route, and that nothing
// arms a timer. The object runs in Node on a real SQLite database (node:sqlite) behind a small
// stand-in for state.storage, with 'cloudflare:workers' and the JSON import resolved by module
// hooks. Run with: npm --prefix worker test
//
// module.registerHooks needs Node 22.15 or later; on older versions these tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const DURABLE_OBJECT_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const hooks = typeof nodeModule.registerHooks === 'function';
let ConferenceDO = null;
if (hooks) {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'cloudflare:workers') return { url: DURABLE_OBJECT_STUB, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      // Wrangler bundles JSON imports without an import attribute; Node needs one, so serve the
      // file as a module whose default export is the parsed JSON.
      if (url.startsWith('file:') && url.endsWith('.json')) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  ({ ConferenceDO } = await import('../src/conference.js'));
}
const skip = hooks ? false : 'module.registerHooks needs Node 22.15 or later';

// A stand-in for state.storage.sql.exec over node:sqlite. A call without bindings that holds
// several statements runs them all, as the real exec does. node:sqlite reports no row counts,
// so every cursor reports one row read, and one row written for a statement that writes.
function fakeState() {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...b) => {
    const multi = b.length === 0 && /;\s*\S/.test(q.trim().replace(/;\s*$/, ''));
    let rows = [];
    if (multi) db.exec(q);
    else rows = db.prepare(q).all(...b);
    const writes = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(q);
    return { toArray: () => rows, one: () => rows[0], rowsRead: 1, rowsWritten: writes ? 1 : 0, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };
  return {
    db,
    storage: { sql: { exec }, transactionSync: (fn) => fn() },
    blockConcurrencyWhile: (fn) => fn(),
    waitUntil: () => {},
  };
}

function newObject() {
  const state = fakeState();
  const obj = new ConferenceDO(state, {});
  const row = () => {
    const day = new Date().toISOString().slice(0, 10);
    return { ...state.db.prepare('SELECT requests, rows_read, rows_written FROM usage_days WHERE day = ?').get(day) };
  };
  return { obj, state, row };
}

// An admin request carries the nonce and timestamp the Worker forwards from a verified signature;
// the object refuses an /admin/* request without them.
const adminHeaders = (path) => (path.startsWith('/admin/')
  ? { 'x-caddie-admin-nonce': randomBytes(16).toString('base64url'), 'x-caddie-admin-ts': String(Math.floor(Date.now() / 1000)) }
  : {});
const jsonRequest = (method, path, body) => new Request(`https://do.internal${path}`, {
  method,
  headers: { 'content-type': 'application/json', 'x-caddie-slug': 'test-conf', ...adminHeaders(path) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// Runs fn with setTimeout and setInterval counted, so a test can show that nothing armed a timer
// (a pending timer keeps a Durable Object from hibernating, and its wait is billed as duration).
async function countingTimers(fn) {
  const saved = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
  let armed = 0;
  globalThis.setTimeout = (...args) => {
    armed += 1;
    return saved.setTimeout(...args);
  };
  globalThis.setInterval = (...args) => {
    armed += 1;
    return saved.setInterval(...args);
  };
  try {
    await fn();
  } finally {
    Object.assign(globalThis, saved);
  }
  return armed;
}

test('a request is counted and the first one writes, without arming a timer', { skip }, async () => {
  const { obj, row } = newObject();
  let res;
  const armed = await countingTimers(async () => {
    res = await obj.fetch(jsonRequest('GET', '/api/no-such-route'));
  });
  assert.equal(res.status, 404);
  assert.ok(res.headers.get('X-Caddie-Pace'));
  assert.equal(row().requests, 1, 'a new instance writes after its first request');
  assert.equal(armed, 0, 'the request path arms no timer');
});

test('usage() counts the rows of the request so far before it reads the meter', { skip }, () => {
  const { obj, row } = newObject();
  obj.meter.countRequest();
  obj.exec("INSERT INTO meta (k, v) VALUES ('x', '1')"); // a metered write not yet drained
  const usage = obj.usage();
  // One written row for the metered insert, plus the meter's own write.
  assert.equal(usage.rows_written, 2);
  assert.equal(usage.requests, 1);
  assert.deepEqual({ requests: usage.requests, rows_read: usage.rows_read, rows_written: usage.rows_written }, row());
  assert.equal(obj.cursors.length, 0);
});

test('GET /admin/stats reports a stored total, and a restarted meter never reports less', { skip }, async () => {
  const { obj, row } = newObject();
  // An object takes admin writes (the meter restart) only once it holds its conference document.
  const doc = { slug: 'test-conf', name: 'Fixture', status: 'searchable', start_date: '2099-06-01', end_date: '2099-06-02', time_zone: 'UTC' };
  assert.equal((await obj.fetch(jsonRequest('PUT', '/internal/conference', { doc, route_prefix: 'abcdef' }))).status, 200);
  const stats = async () => (await (await obj.fetch(jsonRequest('GET', '/admin/stats'))).json()).usage;
  const first = await stats();
  for (let i = 0; i < 3; i++) await obj.fetch(jsonRequest('GET', '/api/no-such-route'));
  const middle = await stats();
  assert.ok(middle.requests >= first.requests + 3);
  assert.equal((await obj.fetch(jsonRequest('POST', '/admin/test/meter-restart', {}))).status, 200);
  const after = await stats();
  for (const f of ['requests', 'rows_read', 'rows_written']) assert.ok(after[f] >= middle[f], `${f} ${middle[f]} then ${after[f]}`);
  assert.ok(row().requests >= after.requests);
});

test('the cron reads the meter last, so its totals hold every row of the call', { skip }, async () => {
  const { obj, row } = newObject();
  const day = new Date().toISOString().slice(0, 10);
  let res;
  const armed = await countingTimers(async () => {
    res = await obj.fetch(jsonRequest('POST', '/internal/cron', { day, others: { requests: 5, rows_read: 0, rows_written: 0 } }));
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const totals = { requests: body.requests, rows_read: body.rows_read, rows_written: body.rows_written };
  // Nothing the call read or wrote is left out of the totals it returned: they equal the stored
  // row, and the meter has no unwritten deltas left (the purge, the holds check over eight
  // tables and the sweep all ran before the reading).
  assert.deepEqual(totals, row());
  const { day: _day, ...current } = obj.meter.current();
  assert.deepEqual(current, totals);
  assert.ok(body.rows_read >= 8, `rows read ${body.rows_read}`);
  assert.equal(armed, 0, 'the cron arms no timer');
});
