// The SQLite schema of a ConferenceDO (PLAN section 1.4). All times are integer milliseconds since
// the epoch (*_ms). JSON arrays and objects are stored as TEXT.
//
// FTS rowids: talks_fts.rowid equals talks.rowid and people_fts.rowid equals people.rowid. Both
// base tables are written with INSERT ... ON CONFLICT DO UPDATE (never INSERT OR REPLACE, which
// changes the rowid), so lexical queries can select rowid alone.
//
// There is no embed_cache table: query vectors are cached in memory only (lib/embed.js).
//
// Additions to the plan's schema, all of them needed by the purge or by existing data:
// - facets."group": the tag group of a tag facet (server/facets.mjs returns it).
// - indexes on the expiry columns, so the purge every 10 minutes reads only expired rows instead
//   of scanning whole tables (rows read are a daily cap).
// - a partial index on people.text_pending, so the embedding retry reads only pending rows.
//
// Not here: the usage_days table of the daily usage meter. lib/meter.js creates it (and folds in
// the totals older versions kept in meta.usage) when each instance's meter starts, outside
// SCHEMA_VERSION, so the meter's storage stays in one file with the code that writes it.

export const SCHEMA_VERSION = 2;

const V1 = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS talks (
  talk_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL DEFAULT '',
  speakers TEXT NOT NULL DEFAULT '[]',
  speaker_taglines TEXT NOT NULL DEFAULT '[]',
  speaker_profiles TEXT NOT NULL DEFAULT '[]',
  room TEXT, track TEXT, level TEXT,
  tag_keys TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  topics TEXT NOT NULL DEFAULT '[]',
  sponsor INTEGER NOT NULL DEFAULT 0,
  has_slides INTEGER NOT NULL DEFAULT 0,
  start TEXT, "end" TEXT,
  start_ms INTEGER, end_ms INTEGER,
  day TEXT, start_minutes INTEGER, end_minutes INTEGER,
  session_id TEXT, slides_url TEXT, url TEXT,
  content_hash TEXT, text_hash TEXT, ingested_at TEXT,
  generation INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS talks_start ON talks(start_ms, talk_id);

CREATE VIRTUAL TABLE IF NOT EXISTS talks_fts USING fts5(
  talk_id UNINDEXED, title, abstract, speakers, speaker_taglines,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS talk_vectors (
  talk_id TEXT NOT NULL,
  part TEXT NOT NULL,
  chunk TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (talk_id, part)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS topics (
  topic_id TEXT PRIMARY KEY, label TEXT NOT NULL, label_exact TEXT,
  aliases TEXT NOT NULL DEFAULT '[]', talk_count INTEGER NOT NULL, rank INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS facets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL DEFAULT '[]', words TEXT NOT NULL DEFAULT '',
  label TEXT, value TEXT, "group" TEXT, talks INTEGER NOT NULL DEFAULT 0, built_at TEXT
);

CREATE TABLE IF NOT EXISTS people (
  profile_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '', interests TEXT NOT NULL DEFAULT '', expertise TEXT NOT NULL DEFAULT '',
  learn_topics TEXT NOT NULL DEFAULT '[]', speak_topics TEXT NOT NULL DEFAULT '[]',
  linkedin_url TEXT, contact_note TEXT,
  open_to_meet INTEGER NOT NULL DEFAULT 0,
  sample INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  spot_hidden INTEGER NOT NULL DEFAULT 0,
  visible_until_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  text_hash TEXT,
  text_pending INTEGER NOT NULL DEFAULT 0,
  vec_about BLOB, vec_interests BLOB, vec_expertise BLOB
);
CREATE INDEX IF NOT EXISTS people_visible ON people(visible_until_ms);
CREATE INDEX IF NOT EXISTS people_pending ON people(profile_id) WHERE text_pending = 1;

CREATE TABLE IF NOT EXISTS shared_talks (
  profile_id TEXT NOT NULL, talk_id TEXT NOT NULL, PRIMARY KEY (profile_id, talk_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS shared_talks_talk ON shared_talks(talk_id);

CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(
  profile_id UNINDEXED, about, expertise, interests,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS presence (
  profile_id TEXT PRIMARY KEY,
  zone TEXT, spot TEXT, spot_pending INTEGER NOT NULL DEFAULT 0,
  since_ms INTEGER, until_ms INTEGER NOT NULL,
  ble_token TEXT, ble_token_until_ms INTEGER
);
CREATE INDEX IF NOT EXISTS presence_ble ON presence(ble_token);
CREATE INDEX IF NOT EXISTS presence_until ON presence(until_ms);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS meets (
  meet_id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
  topic_id TEXT, note TEXT, note_pending INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  same_zone INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, hidden_owner_id TEXT,
  requester_cancelled INTEGER NOT NULL DEFAULT 0,
  rendezvous TEXT,
  spot_me TEXT NOT NULL DEFAULT '{}',
  spot_me_pending TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL, active_since_ms INTEGER, expires_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS meets_recipient ON meets(recipient_id, created_at_ms);
CREATE INDEX IF NOT EXISTS meets_requester ON meets(requester_id, created_at_ms);
CREATE INDEX IF NOT EXISTS meets_expires ON meets(expires_at_ms);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL, target_profile_id TEXT,
  reporter_id TEXT NOT NULL, reason TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_target ON reports(target_kind, target_id);
CREATE INDEX IF NOT EXISTS reports_reporter ON reports(reporter_id, created_at_ms);

CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_profile ON push_subs(profile_id);
CREATE INDEX IF NOT EXISTS push_subs_expires ON push_subs(expires_at_ms);

CREATE TABLE IF NOT EXISTS nudges (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL, a_id TEXT NOT NULL, b_id TEXT NOT NULL, receivers TEXT NOT NULL DEFAULT '[]',
  created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nudges_expires ON nudges(expires_at_ms);
CREATE TABLE IF NOT EXISTS nudge_sends (
  receiver_id TEXT NOT NULL, sent_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nudge_sends_receiver ON nudge_sends(receiver_id, sent_at_ms);
CREATE INDEX IF NOT EXISTS nudge_sends_expires ON nudge_sends(expires_at_ms);
`;

// Version 2 (the free-stack review, 2026-11-10):
// - blocks.blocked_ref and blocks.expires_at_ms. A block belongs to its blocker and outlives the
//   blocked profile until the conference ends (server/connect.mjs, docs/contracts/people-api.md),
//   so it keeps the blocked person's ref, for the blocks list and for unblocking after that profile
//   is gone, and its own expiry, which the purge honours. Rows written before version 2 have both
//   null: the ref is computed when it is needed, and the purge gives them the conference's end.
// - presence.presence_nonce and presence.ble_master_id: the derived-token session of Bluetooth
//   tokens v1 (docs/contracts/ble-tokens.md). The nonce is 16 bytes as base64url; no key is stored.
//   presence.ble_rotated: the session's legacy token was rotated, which only the old Android app
//   does, so a session under a retired master is answered for it instead of 403 ble_rekey.
// - ble_caps: whom Bluetooth sightings answers returned to each requesting device, for the caps of
//   the Phase 4 mitigations (10 new people per token window, 30 per rolling hour). Pruned to the
//   last hour on every write, kept across presence sessions, and deleted with the profile.
const V2_COLUMNS = [
  ['blocks', 'blocked_ref', 'TEXT'],
  ['blocks', 'expires_at_ms', 'INTEGER'],
  ['presence', 'presence_nonce', 'TEXT'],
  ['presence', 'ble_master_id', 'TEXT'],
  ['presence', 'ble_rotated', 'INTEGER'],
];
const V2 = `
CREATE INDEX IF NOT EXISTS blocks_expires ON blocks(expires_at_ms);
CREATE TABLE IF NOT EXISTS ble_caps (
  profile_id TEXT NOT NULL, ref TEXT NOT NULL, at_ms INTEGER NOT NULL, w INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ble_caps_profile ON ble_caps(profile_id, at_ms);
`;

// Adds a column unless the table already has it, so a run interrupted after the ALTER is repaired
// by the next one (ALTER TABLE ADD COLUMN itself is not idempotent).
function addColumn(sql, table, column, type) {
  const have = sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column);
  if (!have) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Brings a ConferenceDO database up to SCHEMA_VERSION. Every step is idempotent, so a crash part
// way through is repaired by the next run.
export function migrate(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  const row = sql.exec("SELECT v FROM meta WHERE k = 'schema_version'").toArray()[0];
  const current = row ? Number(row.v) : 0;
  if (current >= SCHEMA_VERSION) return;
  if (current < 1) sql.exec(V1);
  for (const [table, column, type] of V2_COLUMNS) addColumn(sql, table, column, type);
  sql.exec(V2);
  sql.exec("INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(SCHEMA_VERSION));
}

// The DirectoryDO schema: the conference list, and a small key-value table for the cron's
// cross-conference usage totals.
const DIRECTORY_V1 = `
CREATE TABLE IF NOT EXISTS conferences (
  slug TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  status TEXT NOT NULL,
  start_date TEXT, end_date TEXT, name TEXT,
  route_prefix TEXT NOT NULL UNIQUE,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// has_object: the conference's ConferenceDO has been given its document (it was searchable once),
// so it may hold people, and owner deletes, the admin routes and the cron still reach it after its
// status turns unavailable. holds: what the last cron call found in it (people, presence, blocks,
// meets, push subscriptions and nudge records), so the cron keeps purging a conference that still
// holds personal data, whatever its status and end date.
export function migrateDirectory(sql) {
  sql.exec(DIRECTORY_V1);
  const cols = new Set(sql.exec('PRAGMA table_info(conferences)').toArray().map((c) => c.name));
  if (!cols.has('has_object')) {
    sql.exec('ALTER TABLE conferences ADD COLUMN has_object INTEGER NOT NULL DEFAULT 0');
    sql.exec("UPDATE conferences SET has_object = 1 WHERE status = 'searchable'");
  }
  // Until the cron has looked, an object is assumed to hold data, so it is visited at least once.
  if (!cols.has('holds')) {
    sql.exec('ALTER TABLE conferences ADD COLUMN holds INTEGER NOT NULL DEFAULT 0');
    sql.exec('UPDATE conferences SET holds = 1 WHERE has_object = 1');
  }
}
