# Bluetooth derived tokens v1

Two opted-in people whose experience and interests match are told when they are within a few metres, phone in pocket. Each phone broadcasts a short token that changes every ten minutes, listens for the tokens of others, and asks the server which of the tokens it heard belong to strong matches. In v1 the phone derives each token itself from a key, so rotation needs no network call and keeps working while the app sleeps; this removes the rotate route whose failure in the background stopped discovery on Android on 2026-11-09. Reference implementation: `contracts/js/ble-token.mjs`. Golden vectors: `contracts/fixtures/ble/golden-vectors.v1.json` and `contracts/fixtures/ble/resolution-cases.v1.json`, with their shape in `contracts/schema/ble-fixtures.v1.schema.json`. A backend advertises this protocol with `ble.mode: derived-v1` ([capabilities.md](capabilities.md)).

The resolution rules and the Phase 4 mitigations below are normative for every implementation of v1 resolution, on every tier.

## Keys

The server never stores a per-person key. It derives one from a server secret and a per-session nonce, hands it to the device once, and derives it again whenever it needs it.

- **`ble_master_secret`**: a keyring of server secrets, each at least 32 random bytes with a short id (for example `2026-11`), exactly one of them current. It is held only by the server: Secret Manager on tier 3 (mounted as an environment variable, never logged and never written to a file), Worker secrets on tier 2. Tier 1 has no Bluetooth.
- **`presence_nonce`**: 16 random bytes, minted by the server on every `PUT /api/presence` with `ble: true` and stored on the person's document for that conference, together with **`ble_master_id`**, the id of the current master at that moment. Both are unindexed, never returned and never logged. They are cleared with presence: `DELETE /api/presence`, the expiry purge, visibility turned off, the profile deleted, and a presence write with `ble: false`. One nonce means one presence session.
- **`ble_key`** for a session, derived with the master named by `ble_master_id`:

  ```
  ble_key = HMAC-SHA256(ble_master_secret,
                        "caddie-ble-key-v1" || uint16be(byte length of profile_id_utf8) || profile_id_utf8 || presence_nonce)
  ```

  The label is the 17 ASCII bytes `caddie-ble-key-v1`. `profile_id_utf8` is the UTF-8 bytes of the device's `profile_id` (today always 22 characters, so the prefix is `0x00 0x16`); its byte length is written first as an unsigned 16-bit big-endian integer. The nonce is exactly 16 bytes and comes last. The length prefix and the fixed nonce length make the split between `profile_id` and nonce unambiguous. The key is the whole 32-byte HMAC output.
- **`ble_key_id`**: base64url (11 characters) of the first 8 bytes of `HMAC-SHA256(ble_key, "caddie-ble-key-id-v1")`. It names a key without revealing it.

The server returns `ble_key` (base64url without padding, 43 characters) and `ble_key_id` in the response to the presence write that minted the nonce, and never returns the key again (`PUT /api/presence`, [people-api.md](people-api.md)). Every derived-v1 sightings answer carries the `ble_key_id` of the requester's current session; a device whose stored key has another id (presence was written with `ble: true` from another tab, or the session was replaced) writes presence with `ble: true` again to get a fresh key. A sightings request whose session was issued under a master the server no longer holds is answered 403 `ble_required`, which also makes the device re-key. A device whose key response was lost does the same.

**On the device.** The key is valid while presence is live: the device stops advertising at the latest `presence_until` it has seen. It is kept with the backend base and conference it belongs to, and nowhere else:

- **iOS**: a Keychain item of class `kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a Bluetooth wake can derive tokens while the phone is locked, and the key is never restored to another device or backed up.
- **Android**: imported into the Android Keystore as a non-exportable HMAC-SHA256 key (`KeyStore.setEntry` with `KeyProtection` for `PURPOSE_SIGN`, no user authentication required, so the foreground service can use it while the screen is locked). Tokens are computed with `Mac` over the Keystore key. The base64url text from the response is dropped as soon as the import succeeds; no other copy is kept.

## Tokens

```
w        = floor(unix_seconds / window_s)          window_s = 600
token_w  = first 16 bytes of HMAC-SHA256(ble_key, "caddie-ble-v1" || uint64be(w))
```

- `unix_seconds` is the device's clock in seconds since 1970-01-01T00:00:00Z (UTC, no leap seconds), fractional seconds floored; `w` is an unsigned 64-bit integer. The message is 21 bytes: the 13 ASCII bytes `caddie-ble-v1`, then `w` as 8 bytes big-endian. Implementations on signed 64-bit integers (Kotlin `Long`) encode the same bit pattern; the vectors include `w = 2^64 - 1`.
- The token changes at every multiple of 600 seconds of Unix time, the same instant on every phone. A phone computes it at any moment, including inside an iOS Bluetooth background wake, with no network call.
- In the sightings API a token is base64url without padding, 22 characters, exactly as today, so the `POST /api/presence/sightings` request is unchanged.

## Resolution on the server

For a sightings report from a requester who is around with a live session (else 403 `ble_required`):

1. Keep the strongest RSSI per token and drop those weaker than `ble.near_rssi`.
2. Look each remaining token up in the conference's **token table**, which maps a token to `(profile_id, nonce_tag)`, where `nonce_tag` is the first 16 hex digits of `sha256(presence_nonce)`. For every stored session of the conference whose master is still held, the server derives `ble_key` and adds `token_{w-1}`, `token_w` and `token_{w+1}` for its current window `w`. The table holds no keys. A server may cache it per window: tier 2 in the conference's Durable Object memory, tier 3 in each instance. It rebuilds it at each window change, and also on a token it cannot find when the table is older than 30 seconds, so a session minted on another instance is picked up within half a minute.
3. **Check every hit against the store.** In one query for the at most 50 profile ids from step 2, read each person's current `presence_nonce` (as its tag), `presence_until`, zone, ~100 m cell, visibility, `open_to_meet` and report flags. Keep a hit only when the stored nonce tag equals the table's, presence is live, the person is visible conference-wide, `open_to_meet` and not hidden, and they are not the requester. This is what makes "a session stops resolving when presence ends or the nonce changes" true on every instance, whatever its cached table holds. It costs one small query per sightings request, as today's server already runs; a server that keeps no table can instead rebuild the table for the conference on every request, which costs three HMACs per live Bluetooth user per request.
4. Apply the **Phase 4 mitigations** below: the co-location rule and the per-device caps.
5. Drop anyone blocked in either direction, rank the rest with the same retriever as `POST /api/people/matches`, and keep only strong matches, as today (`server/ble.mjs`). The answer is `{ nearby, ble_key_id }`.

The reference `tokenTable()` and `resolveSightings()` do steps 1 to 4; `resolution-cases.v1.json` lists the expected outcomes.

**Why w - 1, w and w + 1.** A sighting reaches the server after a delay `d`: the scanner reports in batches at most every `ble.sightings_min_interval_s` (at most 300 seconds in v1, half a window) plus upload time. The advertiser's clock may also be off by `δ` from the server's. The token the server sees is from window `w` exactly when `d - δ` stays within one window, so accepting `w - 1` and `w + 1` covers a report up to about five minutes late with the advertiser's clock up to about four and a half minutes slow, or a prompt report from an advertiser whose clock is up to ten minutes fast. Phones that set their time automatically are within a second, so this is a wide margin; the cost of `w + 1` is one more HMAC per live person per window and a table half again as large (2,400 entries for 800 Bluetooth users), with no privacy cost because the server already holds the master secret. A token from `w - 2` or `w + 2` resolves to nobody. Capping the sightings interval at half a window is what keeps `w - 1` sufficient for late reports; a 600-second interval, considered for tier 2, would need `w - 2` and was dropped.

## Phase 4 mitigations

These rules are part of v1 resolution. They limit what a malicious client can learn by reporting tokens it did not hear itself (see Threat model).

1. **Co-location.** A sighted person resolves only when they are co-located with the requester at the time of the request: the same `presence_zone`, or both have a stored position and it falls in the same ~100 m cell (the proximity bands `same_zone` and `near` of [people-api.md](people-api.md)). The rule is on by default; an operator may turn it off for a single-room event, and the capabilities document says which (`ble.colocation_required`, default true). With it, a sniffer elsewhere in the venue cannot turn a captured token into a sighting unless the attacker also claims the target's zone, and then they learn nothing the zone did not already say.
2. **Caps per requesting device.** At most 10 distinct people resolve for one device per window and at most 30 per rolling hour. Someone already resolved for the device in the current window keeps resolving; anyone new beyond a cap is left out of the answer without an error. A tier may set lower caps, never higher ones.
3. **Zone only within the zone.** A `nearby` entry carries `zone` only when the person is in the requester's own zone, and null otherwise. (Today's server-rotate answer carries the zone whenever both are around.)
4. **Address rotation with the token (Android).** The advertiser stops and restarts each advertising set at every window change, with a random own address (`AdvertisingSetParameters.Builder.setOwnAddressType` with a random address type where the Android version offers it; otherwise the restart alone, which on most stacks draws a new random address), so the Bluetooth address and the token change together. Phase 0 measures how reliably the address changes and an observer cannot chain one window's token to the next through the address.

## Over the air

| Item | Value |
|---|---|
| Service UUID | `e52c391c-b926-4856-9a38-d46c3c10c733` (unchanged from the Android companion) |
| GATT characteristic `token` | `944ddf9a-6eea-4583-978f-9da68fc3f562`, inside that service; read only, no encryption or bonding |
| Payload v1 | 17 bytes: `0x01` (format), then the 16 token bytes |
| Legacy payload | 16 bytes: the server-minted token of `server-rotate` mode, no format byte |

The payload is the same in service data and in the characteristic's value. A scanner reads a 17-byte value starting with `0x01` as a v1 token, a bare 16-byte value as a legacy token, and ignores anything else, so a later format with a different first byte or length cannot be misread (`decodePayload()`). Both kinds of token are reported the same way. 17 bytes fit one ATT read at the default MTU of 23.

- **Android.** Keeps Bluetooth 5 extended advertising (non-connectable, non-scannable, no device name, no TX power) with the service UUID and the payload as service data, because a legacy advertisement cannot hold a 128-bit UUID plus the payload. It should also run a second, legacy, connectable advertising set with the service UUID only (18 bytes of UUID plus flags fit in 31) and serve the GATT `token` characteristic, so a phone that cannot receive extended advertisements can still connect and read. It restarts both sets at each window change (mitigation 4). It scans for the service UUID and, to find backgrounded iPhones, for Apple manufacturer data (company `0x004C`) at or above `near_rssi`, then connects, looks for the service and reads the characteristic. Negative results are cached per address for the rest of the window, and connections are capped per minute.
- **iOS.** In the foreground it advertises the service UUID; in the background iOS moves it to the overflow area, which only other iOS devices scanning for it can see. It cannot put service data in an advertisement, so it always serves the GATT `token` characteristic, and peers connect and read it. It scans for the service UUID, reads service data when present (Android) and otherwise connects and reads the characteristic. An app cannot choose its Bluetooth address on iOS; see the Threat model.
- **Both.** The value served is the payload for the current window of the phone's own clock, recomputed when the window changes. Sightings are batched natively (the Android foreground service, the iOS Bluetooth wake): a device sends at most one report per `ble.sightings_min_interval_s`, sends any pending sightings no later than that interval after the first of them was heard, drops a sighting older than 300 seconds instead of sending it, leaves out tokens already resolved in the current window, and puts at most 50 tokens in a report. It reports no sighting weaker than `ble.near_rssi`.

## Threat model

- **Nothing about the person goes over the air.** A token is 16 bytes indistinguishable from random to anyone without the key. Tokens of different windows cannot be linked to each other or to a person through the tokens alone, and the key changes with every presence session.
- **A database leak alone links nothing.** The store holds nonces and master ids, not keys; without the master secret a nonce gives no key and no token.
- **A master-secret leak does link tokens**, together with a copy of the store: whoever holds both can derive every live key and follow the tokens of every person who is around with Bluetooth on. The response is to add a new current master and retire the leaked one at once: every session issued under it stops resolving, the next sightings request of each affected device is answered 403 `ble_required`, and the device re-keys under the new master. Routine rotation keeps the previous master until the sessions it issued have ended (at most to the end of the conference day), so nobody notices it. Operators treat the keyring like the database credentials.
- **Sniffing with remote radios (the RSSI is client-claimed).** The RSSI in a sightings report is whatever the reporting client says, so `near_rssi` is a relevance threshold, not a security boundary. An attacker with a live profile that matches the target, Bluetooth on, and sniffers placed around a venue can report the tokens the sniffers capture, with any RSSI, and learn from the answers when the target was near each sniffer, together with the target's display name, the evidence passage and speak topics a match card shows. Phase 4 mitigation 1 (co-location) means the attacker must also be, or claim to be, in the target's zone or cell at that moment, and mitigation 2 (caps) bounds how many people one device can probe; reports and blocks, the rate limits and the requirement to be broadcasting a live session of one's own still apply. What remains is the same as what a person standing in the same zone learns from the app anyway.
- **Address linking.** The Bluetooth address a phone advertises from is not the token. iOS rotates its random address roughly every 15 minutes on its own schedule, not aligned with the 10-minute token window, and an app cannot change that; so a passive observer who keeps listening can see an address and a token change at different moments and chain address to token to address across windows, following one presence session for as long as it can listen. It cannot learn who the session belongs to from the radio alone, and a new presence session starts a new key. Android avoids this by restarting its advertising sets with the token (mitigation 4).
- **The server learns which tokens one phone reports**, for the length of one sightings request, and keeps none of it: no index holds sightings, and the log has only method, path, status and duration. This is unchanged from today.
- **Exports never include anything derived from the key, or the material it is derived from.** `npm run people:export` and any tier 2 export leave out `presence_nonce`, `ble_master_id`, keys, key ids and tokens; a nonce exported with the master secret available would let the key be rebuilt.
- **A replayed token** (someone re-broadcasting a token they overheard) can make phones near the replayer report the token's owner as nearby, but only until the window after the token's own has ended (at most about twenty minutes after it was first broadcast), only for phones co-located with the owner's stored zone or cell, and those phones learn no more than a nudge shows. It does not let anyone learn where the owner is.

## Golden vectors

`golden-vectors.v1.json` holds, with fake fixed values only:

- the constants above and window examples (`unix_seconds` → `w`) at 0, 599, 600, 2026-11-10T12:00:00Z (`w = 2990520`), the next window, and both sides of 2^32;
- token vectors for two fake keys, `00 01 … 1f` and `ff fe … e0`, at `w` = 0, 1, 2990520, 2990521, 2^32 - 1, 2^32 and 2^64 - 1: the message bytes, the full HMAC, the token in hex and base64url, and the 17-byte payload;
- key-derivation vectors: master secret `40 41 … 5f` (id `m1`), two fake `profile_id`s and nonces, the key message bytes, the `ble_key`, its `ble_key_id` (with the full HMAC it is cut from) and its tokens at three windows.

Every HMAC and key was computed by the reference implementation and, independently, by `openssl dgst -sha256 -mac HMAC -macopt hexkey:<key> <file holding the message bytes>` (LibreSSL 3.3.6, 2026-11-10), and the two agreed. `test/contracts-ble.test.mjs` checks every vector again three ways: the reference implementation; a SHA-256 and HMAC written in the test from FIPS 180-4 and RFC 2104 (checked against the FIPS and RFC 4231 test values) over message bytes built from this spec; and `openssl` when it is installed, with a few of its recorded outputs copied into the test.

`resolution-cases.v1.json` holds a two-master keyring, the store at request time (five sessions with zones and cells), the requester, and cases covering the current, previous and next windows, the windows two away, the RSSI threshold, the strongest-sighting rule, an unknown token, a cached table entry from a replaced nonce, a cached entry whose presence has ended, a person who is not co-located (and the same with the rule off), a session under a retired master (and the same while it is held), the requester's own token, and a window boundary. The caps are covered by the unit tests.
