// Constants and pure helpers that server/people.mjs shares with the operator scripts
// (scripts/purge-expired-people.mjs, scripts/export-people.mjs, scripts/es-setup-people.mjs).
// Importing this module has no side effects: unlike server/people.mjs, it reads no env, starts no
// purge and makes no request, so a script can use these without running the server's purge.

// The Bluetooth session (ble.mjs) rides along with presence: cleared with it, carried through a
// reindex. That is the legacy token (ble_token, ble_token_until) and the derived-token session
// (presence_nonce, the 16-byte nonce as base64url, and ble_master_id, the id of the master that
// issued it), both unindexed and never returned. The record of whom the Bluetooth answers returned
// to the device (ble_caps) is not here: it outlives a presence session, so that turning presence
// off and on does not reset the caps, and goes with the profile.
export const BLE_SESSION_OFF = { ble_token: null, ble_token_until: null, presence_nonce: null, ble_master_id: null };
export const PRESENCE_OFF = { presence_zone: null, presence_spot: null, presence_spot_pending: null, presence_since: null, presence_until: null, presence_location: null, presence_accuracy: null, presence_cell: null, presence_located_at: null, ...BLE_SESSION_OFF };
// A profile whose delete hid it (step 1 of deleteProfileAndConnections in people.mjs) and has not
// finished yet: not visible conference-wide and sharing for no talk. No other write leaves a
// document in that state, because a profile write with both choices off deletes the document
// instead, so the state itself marks a pending delete and needs no field of its own (and no
// mapping change). The purge finishes such deletes, the export leaves them out, and
// authenticated() and peopleByIds treat them as gone. An empty shared_talk_ids array indexes no
// value, so exists is false for it.
export const PENDING_DELETE_QUERY = { bool: { filter: [{ term: { open_to_meet: false } }], must_not: [{ exists: { field: 'shared_talk_ids' } }] } };
const noValue = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
export const isPendingDelete = (source) => source?.open_to_meet === false && noValue(source.shared_talk_ids);

// The offset of a time zone from UTC at an instant, in milliseconds, through Intl.
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

// The instant at which a wall clock reading (given as a UTC timestamp of the same digits) occurs
// in a time zone. A conference without a time zone uses UTC-12, the last place on earth where
// that day ends.
function wallToInstant(wall, timeZone) {
  if (!timeZone) return wall + 12 * 3600_000;
  let t = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(t, timeZone);
}

// 23:59:59 on the conference's last day in its own time zone, as an ISO instant.
export function visibleUntil(endDate, timeZone) {
  const [y, m, d] = String(endDate).split('-').map(Number);
  return new Date(wallToInstant(Date.UTC(y, m - 1, d, 23, 59, 59), timeZone)).toISOString();
}

// The start (00:00:00) and end (23:59:59) of the current conference day, in milliseconds. Meet
// requests wait until the end of the day, and "Not now" replies are counted per day.
export function dayBounds(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Etc/GMT+12', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const [y, m, d] = [get('year'), get('month'), get('day')];
  return { start: wallToInstant(Date.UTC(y, m - 1, d, 0, 0, 0), timeZone), end: wallToInstant(Date.UTC(y, m - 1, d, 23, 59, 59), timeZone) };
}
