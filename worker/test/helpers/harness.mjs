// The harness of the tests that run the Worker and its Durable Objects in Node, as
// conference-meter.test.mjs and finalize-dropped-talks.test.mjs do: 'cloudflare:workers' and the
// JSON imports resolved by module hooks, a stand-in for state.storage over node:sqlite, and
// crypto.subtle.timingSafeEqual, a Workers extension that Node does not have.
//
// module.registerHooks needs Node 22.15 or later; on older versions `skip` names the reason and the
// classes stay null.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';

const bytes = (x) => (ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x));
if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(bytes(a), bytes(b));
}

const DURABLE_OBJECT_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
export const hooks = typeof nodeModule.registerHooks === 'function';
export const skip = hooks ? false : 'module.registerHooks needs Node 22.15 or later';

export let ConferenceDO = null;
export let DirectoryDO = null;
export let worker = null;
export let adminRoutes = null;
export let CONFERENCE_ADMIN_PATHS = null;

if (hooks) {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'cloudflare:workers') return { url: DURABLE_OBJECT_STUB, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith('file:') && url.endsWith('.json')) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  ({ ConferenceDO } = await import('../../src/conference.js'));
  ({ DirectoryDO } = await import('../../src/directory.js'));
  ({ default: adminRoutes, CONFERENCE_ADMIN_PATHS } = await import('../../src/admin.js'));
  ({ default: worker } = await import('../../src/index.js'));
}

// A stand-in for state.storage.sql.exec over node:sqlite. A call without bindings that holds
// several statements runs them all, as the real exec does. node:sqlite reports no row counts, so
// every cursor reports one row read, and one row written for a statement that writes. `onExec`
// sees every statement's text.
export function fakeState({ onExec } = {}) {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...args) => {
    onExec?.(q);
    // Node 22's node:sqlite binds typed arrays but not an ArrayBuffer (a stored vector).
    const b = args.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
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

// A Durable Object namespace whose objects are made on first use by make(name) and kept, so a
// test can reach the same object through the Worker and directly. Every call the Worker makes is
// recorded with its name, as a Request.
export function namespace(make) {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    idFromName: (name) => ({ name }),
    get: ({ name }) => ({
      fetch: async (url, init) => {
        const req = new Request(url, init);
        calls.push({ name, req: req.clone() });
        if (!objects.has(name)) objects.set(name, make(name));
        return objects.get(name).fetch(req);
      },
    }),
  };
}

// Runs fn with Date.now() fixed at atMs until fn's argument sets another time, and restores it
// after, so a test at an exact second boundary cannot cross one.
export async function withFixedClock(atMs, fn) {
  const real = Date.now;
  let now = atMs;
  Date.now = () => now;
  try {
    return await fn((ms) => {
      now = ms;
    });
  } finally {
    Date.now = real;
  }
}

// Runs fn with Date.now() moved by the offset that fn's argument sets, and restores it after.
export async function withClock(fn) {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    return await fn((ms) => {
      offset = ms;
    });
  } finally {
    Date.now = real;
  }
}
