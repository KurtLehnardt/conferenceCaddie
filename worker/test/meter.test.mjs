// The daily usage meter (src/lib/meter.js) against a real SQLite database (node:sqlite), with
// several meter instances sharing one database the way successive or overlapping instances of a
// conference object share its storage. Run with: npm --prefix worker test
//
// The property under test: a reading that leaves the object (report) never goes down within a
// UTC day, whatever instances start, stop or lose their unwritten counts in between.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Meter, ensureUsageTable, FLUSH_EVERY, FLUSH_INTERVAL_MS } from '../src/lib/meter.js';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

// One object's storage. sql has the shape of storage.sql.exec: it returns a cursor with toArray,
// one, rowsRead and rowsWritten. node:sqlite reports no row counts, so a test that needs them
// passes its own.
function storage({ cost = null, failUpserts = 0 } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  let fails = failUpserts;
  const sql = (q, ...b) => {
    const upsert = q.startsWith('INSERT INTO usage_days') && q.includes('RETURNING');
    if (upsert && fails > 0) {
      fails -= 1;
      throw new Error('SQLITE_BUSY');
    }
    const rows = db.prepare(q).all(...b);
    const c = { toArray: () => rows, one: () => rows[0] };
    if (upsert && cost) Object.assign(c, { rowsRead: cost.read, rowsWritten: cost.written });
    return c;
  };
  const row = (day) => db.prepare('SELECT requests, rows_read, rows_written FROM usage_days WHERE day = ?').get(day);
  return { db, sql, row };
}

const start = (s, now = T0, env = {}) => new Meter({ sql: s.sql, exec: s.sql, env, now });

// A small deterministic random sequence, so a failure is reproducible.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

test('a restarted instance never reports less than an earlier reading of the same day', () => {
  const s = storage();
  const a = start(s);
  let now = T0;
  for (let i = 0; i < 5; i++) a.countRequest((now += 100));
  const first = a.report(now);
  assert.equal(first.requests, 5);
  // Counted but never written: an eviction loses these, and no reading ever showed them.
  for (let i = 0; i < 7; i++) a.countRequest((now += 100));
  a.addRows(40, 3, now);
  const b = start(s, now); // the new instance after the eviction
  b.countRequest((now += 100));
  const second = b.report(now);
  assert.ok(second.requests >= first.requests + 1, `requests ${first.requests} then ${second.requests}`);
  assert.ok(second.rows_read >= first.rows_read && second.rows_written >= first.rows_written);
});

test('two overlapping instances add their counts instead of overwriting each other', () => {
  const s = storage();
  let now = T0;
  const a = start(s, now);
  for (let i = 0; i < 30; i++) a.countRequest((now += 10));
  a.flush(now);
  const b = start(s, now); // starts from the 30 that a stored
  for (let i = 0; i < 20; i++) a.countRequest((now += 10));
  for (let i = 0; i < 10; i++) b.countRequest((now += 10));
  b.flush(now);
  a.flush(now);
  // A totals write would leave 50 (a's view) or 40 (b's view); deltas leave all 60.
  assert.equal(s.row('2026-11-11').requests, 60);
  assert.equal(a.report(now).requests, 60);
  assert.equal(b.report(now).requests, 60);
});

test('random interleavings of instances, restarts and writes never make a reading go down', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = rng(seed);
    const s = storage();
    let now = T0;
    let live = [start(s, now)];
    let last = { requests: 0, rows_read: 0, rows_written: 0 };
    let counted = 0;
    let lost = 0;
    for (let step = 0; step < 400; step++) {
      now += Math.floor(rand() * 2000);
      const m = live[Math.floor(rand() * live.length)];
      const r = rand();
      if (r < 0.6) {
        m.countRequest(now);
        m.addRows(Math.floor(rand() * 50), Math.floor(rand() * 3), now);
        counted += 1;
        m.maybeFlush(now);
      } else if (r < 0.7) {
        // An eviction: the instance's unwritten requests are gone.
        lost += [...m.pending.values()].reduce((n, d) => n + d.requests, 0);
        live = live.filter((x) => x !== m);
        if (live.length === 0) live.push(start(s, now));
      } else if (r < 0.78 && live.length < 3) {
        live.push(start(s, now)); // an overlapping instance, as during a deploy
      } else {
        const reading = m.report(now);
        for (const f of ['requests', 'rows_read', 'rows_written']) {
          assert.ok(reading[f] >= last[f], `seed ${seed} step ${step}: ${f} ${last[f]} then ${reading[f]}`);
        }
        last = reading;
      }
    }
    for (const m of live) m.flush(now);
    // Every request is stored exactly once, except those of evicted instances.
    assert.equal(s.row('2026-11-11').requests, counted - lost, `seed ${seed}`);
  }
});

test('the write cadence is unchanged: first request, then every 100 requests or 15 seconds', () => {
  const s = storage();
  const m = start(s);
  let writes = 0;
  const flush = m.flush.bind(m);
  m.flush = (...args) => {
    writes += 1;
    return flush(...args);
  };
  let now = T0;
  m.countRequest(now);
  m.maybeFlush(now);
  assert.equal(writes, 1, 'a new instance writes after its first request');
  for (let i = 0; i < FLUSH_EVERY - 1; i++) {
    m.countRequest((now += 10));
    m.maybeFlush(now);
  }
  assert.equal(writes, 1);
  m.countRequest((now += 10));
  m.maybeFlush(now);
  assert.equal(writes, 2, 'a write after 100 requests');
  m.countRequest((now += 10));
  m.maybeFlush(now);
  assert.equal(writes, 2);
  assert.ok(m.needsFlush());
  assert.equal(m.dueIn(now), FLUSH_INTERVAL_MS - 10);
  now += FLUSH_INTERVAL_MS;
  assert.equal(m.dueIn(now), 0);
  m.countRequest(now);
  m.maybeFlush(now);
  assert.equal(writes, 3, 'a write once 15 seconds have passed');
  assert.equal(m.needsFlush(), false);
});

test('a write adds its own cost, and a costlier write than expected is carried to the next', () => {
  const s = storage({ cost: { read: 1, written: 2 } });
  const m = start(s);
  m.countRequest(T0);
  m.addRows(10, 0, T0);
  m.flush(T0);
  // The write assumed one written row, measured two, and carries the difference.
  assert.deepEqual({ ...s.row('2026-11-11') }, { requests: 1, rows_read: 11, rows_written: 1 });
  assert.equal(m.current(T0).rows_written, 2);
  assert.equal(m.needsFlush(), false, 'a carried correction alone does not wake the idle timer');
  m.flush(T0 + 1);
  // Second write: the carried row plus its own measured cost of two.
  assert.deepEqual({ ...s.row('2026-11-11') }, { requests: 1, rows_read: 12, rows_written: 4 });
});

test('deltas counted before midnight go to that day, and the new day starts from its own row', () => {
  const s = storage();
  const late = Date.UTC(2026, 10, 11, 23, 59, 59, 500);
  const m = start(s, late);
  m.countRequest(late);
  m.countRequest(late + 100);
  m.addRows(5, 1, late + 100);
  const next = late + 1_000; // 00:00:00.500 on 2026-11-12
  m.countRequest(next);
  assert.equal(m.current(next).requests, 1, 'the new day counts only its own requests');
  m.flush(next);
  assert.equal(s.row('2026-11-11').requests, 2);
  assert.equal(s.row('2026-11-11').rows_read, 5 + 1); // plus the write's own read
  assert.equal(s.row('2026-11-12').requests, 1);
  assert.equal(m.report(next).requests, 1);
  // The cron's sweep keeps today and yesterday, and deletes older days.
  s.sql("INSERT INTO usage_days (day, requests) VALUES ('2026-11-10', 9)");
  m.sweep(next);
  assert.equal(s.row('2026-11-10'), undefined);
  assert.ok(s.row('2026-11-11'));
});

test('a failed write keeps the deltas, and the next write stores them', () => {
  const s = storage({ failUpserts: 1 });
  const m = start(s);
  for (let i = 0; i < 4; i++) m.countRequest(T0 + i);
  assert.throws(() => m.flush(T0 + 10));
  assert.equal(m.current(T0 + 10).requests, 4);
  assert.equal(m.needsFlush(), true);
  assert.equal(m.report(T0 + 20).requests, 4);
  assert.equal(s.row('2026-11-11').requests, 4);
});

test('a reading falls back to stored totals plus deltas when the write fails', () => {
  const s = storage();
  const m = start(s);
  m.countRequest(T0);
  m.report(T0);
  m.countRequest(T0 + 1);
  m.countRequest(T0 + 2);
  m.sql = () => {
    throw new Error('SQLITE_FULL');
  };
  const reading = m.report(T0 + 3);
  assert.equal(reading.requests, 3);
});

test('the pace and the soft caps read the stored totals plus the unwritten deltas', () => {
  const s = storage();
  const env = { ROWS_WRITTEN_SOFT_CAP: '10', ROWS_READ_SOFT_CAP: '100', DAILY_REQUEST_BUDGET: '1000' };
  const a = start(s, T0, env);
  a.addRows(0, 8, T0);
  a.flush(T0); // stores 8 + 1 written
  const b = start(s, T0, env);
  assert.equal(b.writesAllowed(T0), true);
  b.addRows(98, 1, T0); // 9 + 1 written, 1 + 98 read
  assert.equal(b.writesAllowed(T0), false);
  assert.equal(b.lexicalAllowed(T0), true);
  b.addRows(1, 0, T0);
  assert.equal(b.lexicalAllowed(T0), false);
  for (let i = 0; i < 990; i++) b.countRequest(T0);
  assert.equal(b.pace(T0), 10, 'a budget almost spent, in memory only, still slows clients');
});

test('the totals an earlier version kept in meta.usage move into usage_days once', () => {
  const s = storage();
  s.sql("INSERT INTO meta (k, v) VALUES ('usage', ?)", JSON.stringify({ day: '2026-11-11', requests: 1192, rows_read: 5000, rows_written: 70 }));
  const m = start(s);
  assert.equal(m.current(T0).requests, 1192);
  assert.equal(s.sql("SELECT v FROM meta WHERE k = 'usage'").toArray().length, 0);
  m.countRequest(T0);
  m.flush(T0);
  // A late totals write by an instance of the earlier version, folded in with MAX, not added.
  s.sql("INSERT INTO meta (k, v) VALUES ('usage', ?)", JSON.stringify({ day: '2026-11-11', requests: 1195, rows_read: 10, rows_written: 1 }));
  ensureUsageTable(s.sql);
  assert.deepEqual({ ...s.row('2026-11-11') }, { requests: 1195, rows_read: 5001, rows_written: 71 });
  // A malformed old value is dropped.
  s.sql("INSERT INTO meta (k, v) VALUES ('usage', 'not json')");
  ensureUsageTable(s.sql);
  assert.equal(s.sql("SELECT v FROM meta WHERE k = 'usage'").toArray().length, 0);
  assert.equal(s.row('2026-11-11').requests, 1195);
});

test('a new day after a long idle stretch starts from that day\'s row, not from zero', () => {
  const s = storage();
  const a = start(s, T0);
  const b = start(s, T0);
  const tomorrow = T0 + DAY_MS;
  a.countRequest(tomorrow);
  a.flush(tomorrow);
  b.countRequest(tomorrow + 1);
  assert.equal(b.report(tomorrow + 1).requests, 2);
});
