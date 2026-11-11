// The daily usage meter of PLAN section 1.14: API requests served, and SQLite rows read and
// written, per UTC day, for one conference object, plus the other conferences' totals from the
// last cron call.
//
// The meter stores additive deltas, never totals. It keeps in memory what it counted since its
// last write, per UTC day, and a write adds those deltas to the day's row in usage_days with one
// UPSERT per day (requests = requests + ?). The deltas are cleared only after the write succeeds.
// Stored totals therefore only grow, whichever instance of the object writes, and an instance
// that starts after an eviction or a deploy never overwrites what an earlier instance stored.
//
// What the meter can still lose: the deltas of an instance that is evicted between two writes
// (at most FLUSH_EVERY requests or FLUSH_INTERVAL_MS of counts). Those counts were never stored,
// so they never appear in a reading either: every reading that leaves the object (GET
// /admin/stats and the cron's totals) writes the deltas first and reports the stored total, so a
// later reading of the same day, from this instance or a later one, is never smaller. The pace
// and the soft caps read the stored total plus the deltas, the best estimate this instance has.

import { utcDay } from './time.js';
import { secondsUntilUtcMidnight } from './http.js';

// A write after FLUSH_EVERY requests or FLUSH_INTERVAL_MS, whichever comes first, and after the
// first request of a new instance. The object also writes on its own (a timer in conference.js)
// once FLUSH_INTERVAL_MS has passed with counts still unwritten, so an idle instance does not sit
// on its deltas until it is evicted.
export const FLUSH_EVERY = 100;
export const FLUSH_INTERVAL_MS = 15_000;
// The days of rows kept in usage_days: today and the day before. The cron deletes older rows.
const KEEP_DAYS = 2;
const WINDOW_MIN = 10;
const FIELDS = ['requests', 'rows_read', 'rows_written'];

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== null && v !== '' ? Number(v) : d);
const zero = (day) => ({ day, requests: 0, rows_read: 0, rows_written: 0 });
const isEmpty = (d) => FIELDS.every((f) => !d[f]);

// WITHOUT ROWID keeps each row in one b-tree, so the UPSERT writes one row.
const USAGE_TABLE = `CREATE TABLE IF NOT EXISTS usage_days (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID`;

const UPSERT = `INSERT INTO usage_days (day, requests, rows_read, rows_written) VALUES (?, ?, ?, ?)
ON CONFLICT(day) DO UPDATE SET
  requests = requests + excluded.requests,
  rows_read = rows_read + excluded.rows_read,
  rows_written = rows_written + excluded.rows_written
RETURNING requests, rows_read, rows_written`;

// Creates usage_days and moves the totals an earlier version kept in meta.usage (a JSON object
// that each write replaced) into it. MAX keeps the larger of the two, so a late write by an
// instance of the earlier version during a deploy is folded in by the next new instance and is
// never added twice. Runs unmetered, before the first request of each instance.
export function ensureUsageTable(sql) {
  sql(USAGE_TABLE);
  const legacy = sql("SELECT v FROM meta WHERE k = 'usage'").toArray()[0];
  if (!legacy) return;
  let old = null;
  try {
    old = JSON.parse(legacy.v);
  } catch {
    old = null;
  }
  if (old && typeof old.day === 'string') {
    sql(
      `INSERT INTO usage_days (day, requests, rows_read, rows_written) VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET requests = MAX(requests, excluded.requests),
         rows_read = MAX(rows_read, excluded.rows_read), rows_written = MAX(rows_written, excluded.rows_written)`,
      old.day, num(old.requests, 0), num(old.rows_read, 0), num(old.rows_written, 0),
    ).toArray();
  }
  sql("DELETE FROM meta WHERE k = 'usage'").toArray();
}

export class Meter {
  // sql: the unmetered storage.sql.exec. The meter's own writes go through it and add their own
  // cost to the deltas they write, so each write is counted in the totals it stores.
  // exec: the metered exec, for the cron's sweep, whose rows reach the meter like any other.
  // env: DAILY_REQUEST_BUDGET, ROWS_READ_SOFT_CAP and ROWS_WRITTEN_SOFT_CAP.
  constructor({ sql, exec, env = {}, now = Date.now() }) {
    this.sql = sql;
    this.exec = exec;
    this.env = env;
    const day = utcDay(now);
    this.stored = zero(day); // the day's stored totals, as last read or written by this instance
    try {
      ensureUsageTable(sql);
      const row = sql('SELECT requests, rows_read, rows_written FROM usage_days WHERE day = ?', day).toArray()[0];
      if (row) for (const f of FIELDS) this.stored[f] = num(row[f], 0);
    } catch (err) {
      // Every write fails too then, and the deltas stay in memory.
      console.error(`meter start failed: ${err?.name ?? 'Error'}`);
    }
    this.pending = new Map(); // UTC day -> deltas not yet written
    // Requests or rows were counted since the last write: what the idle timer waits for. The
    // correction a write leaves when it cost more than expected does not set it, so the timer
    // never chases the meter's own writes.
    this.dirty = false;
    // The rows one UPSERT reads and writes, as the last write measured them (cursor.rowsRead and
    // cursor.rowsWritten). Each write adds this to the deltas it stores.
    this.cost = { read: 1, written: 1 };
    this.others = zero(day);
    this.othersGrowth = 0; // growth of others.requests between the last two cron calls
    this.minutes = new Map(); // minute index -> requests
    this.sinceFlush = 0;
    // 0, so a fresh instance writes after its first request: instances can live well under
    // FLUSH_INTERVAL_MS.
    this.flushedAt = 0;
  }

  #roll(now) {
    const day = utcDay(now);
    if (this.stored.day !== day) {
      this.stored = zero(day);
      // The next request writes, and that write's RETURNING reads the new day's stored totals.
      this.flushedAt = 0;
    }
    if (this.others.day !== day) {
      this.others = zero(day);
      this.othersGrowth = 0;
    }
    return day;
  }

  #delta(day) {
    let d = this.pending.get(day);
    if (!d) {
      d = zero(day);
      this.pending.set(day, d);
    }
    return d;
  }

  countRequest(now = Date.now()) {
    const day = this.#roll(now);
    this.#delta(day).requests += 1;
    this.dirty = true;
    const m = Math.floor(now / 60_000);
    this.minutes.set(m, (this.minutes.get(m) ?? 0) + 1);
    for (const k of this.minutes.keys()) if (k <= m - WINDOW_MIN) this.minutes.delete(k);
    this.sinceFlush += 1;
  }

  addRows(read, written, now = Date.now()) {
    if (!read && !written) return;
    const d = this.#delta(this.#roll(now));
    d.rows_read += read;
    d.rows_written += written;
    this.dirty = true;
  }

  // Whether the idle timer should write: something was counted since the last write.
  needsFlush() {
    return this.dirty;
  }

  // Milliseconds until a write is due by time.
  dueIn(now = Date.now()) {
    return Math.max(0, FLUSH_INTERVAL_MS - (now - this.flushedAt));
  }

  // Writes when enough requests or enough time have gone by since the last write. Called after
  // each response is built, once its rows are counted.
  maybeFlush(now = Date.now()) {
    if (this.sinceFlush >= FLUSH_EVERY || (this.sinceFlush > 0 && now - this.flushedAt >= FLUSH_INTERVAL_MS)) this.flush(now);
  }

  // Adds one day's deltas, plus the write's own cost, to that day's row.
  #write(day, d) {
    const cost = this.cost;
    const cursor = this.sql(UPSERT, day, d.requests, d.rows_read + cost.read, d.rows_written + cost.written);
    const row = cursor.toArray()[0];
    this.pending.delete(day);
    const actual = { read: num(cursor.rowsRead, cost.read), written: num(cursor.rowsWritten, cost.written) };
    this.cost = actual;
    // A write that cost more than expected leaves the difference for the next write. One that
    // cost less leaves nothing, because a negative delta would make the stored total shrink.
    const more = { read: Math.max(0, actual.read - cost.read), written: Math.max(0, actual.written - cost.written) };
    if (more.read || more.written) {
      const next = this.#delta(day);
      next.rows_read += more.read;
      next.rows_written += more.written;
    }
    if (row && day === this.stored.day) {
      // The row only grows, so its value is never below what this instance saw before.
      for (const f of FIELDS) this.stored[f] = Math.max(this.stored[f], num(row[f], 0));
    }
  }

  // Adds each day's deltas to that day's row: one UPSERT, so one written row, per day with
  // deltas (only a write that straddles midnight has two days). With force, today's row is
  // written even without deltas, which refreshes this.stored from the row. A day's deltas are
  // cleared only after its write succeeds; a failure throws and leaves them in memory.
  flush(now = Date.now(), { force = false } = {}) {
    const today = this.#roll(now);
    if (force) this.#delta(today);
    for (const [day, d] of [...this.pending]) {
      if (isEmpty(d) && !(force && day === today)) {
        this.pending.delete(day);
        continue;
      }
      this.#write(day, d);
    }
    this.sinceFlush = 0;
    this.flushedAt = now;
    this.dirty = false;
  }

  // The day's stored totals plus this instance's deltas: what the pace and the soft caps read.
  current(now = Date.now()) {
    const day = this.#roll(now);
    const d = this.pending.get(day);
    const out = { ...this.stored };
    if (d) for (const f of FIELDS) out[f] += d[f];
    return out;
  }

  // The reading GET /admin/stats and the cron report. The deltas are written first and the
  // reading is the stored total that write returns, so a later reading of the same day, from
  // this instance or a later one, never shows less. If the write fails, the reading falls back
  // to the stored totals plus the deltas, which an eviction could still lose.
  report(now = Date.now()) {
    try {
      this.flush(now, { force: true });
      return { ...this.stored };
    } catch (err) {
      console.error(`meter flush failed: ${err?.name ?? 'Error'}`);
      return this.current(now);
    }
  }

  // Deletes the rows of days before yesterday. Called by the cron; usually deletes nothing.
  sweep(now = Date.now()) {
    const keep = utcDay(now - (KEEP_DAYS - 1) * 86_400_000);
    this.exec('DELETE FROM usage_days WHERE day < ?', keep).toArray();
  }

  setOthers(day, others, now = Date.now()) {
    this.#roll(now);
    if (day !== this.stored.day || !others) return;
    const next = { day, requests: num(others.requests, 0), rows_read: num(others.rows_read, 0), rows_written: num(others.rows_written, 0) };
    this.othersGrowth = Math.max(0, next.requests - this.others.requests);
    this.others = next;
  }

  global(now = Date.now()) {
    const own = this.current(now);
    return {
      requests: own.requests + this.others.requests,
      rows_read: own.rows_read + this.others.rows_read,
      rows_written: own.rows_written + this.others.rows_written,
    };
  }

  // The request pace clients multiply their poll intervals by: 1 (normal) to 10 (slowest).
  pace(now = Date.now()) {
    const budget = num(this.env.DAILY_REQUEST_BUDGET, 70_000);
    const left = budget - this.global(now).requests;
    if (left < 0.02 * budget) return 10;
    let recent = 0;
    const m = Math.floor(now / 60_000);
    for (const [k, n] of this.minutes) if (k > m - WINDOW_MIN) recent += n;
    const projected = ((recent + this.othersGrowth) * secondsUntilUtcMidnight(now)) / 600;
    const pace = Math.min(10, Math.max(1, projected / Math.max(left, 1)));
    return Math.round(pace * 10) / 10;
  }

  lexicalAllowed(now = Date.now()) {
    return this.global(now).rows_read < num(this.env.ROWS_READ_SOFT_CAP, 3_500_000);
  }

  writesAllowed(now = Date.now()) {
    return this.global(now).rows_written < num(this.env.ROWS_WRITTEN_SOFT_CAP, 85_000);
  }
}
