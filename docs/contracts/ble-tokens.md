# Bluetooth derived tokens v1

Two opted-in people whose experience and interests match are told when they are within a few metres, phone in pocket. Each phone broadcasts a short token that changes every ten minutes, listens for the tokens of others, and asks the server which of the tokens it heard belong to strong matches. In v1 the phone derives each token itself from a key, so rotation needs no network call and keeps working while the app sleeps; this removes the rotate route whose failure in the background stopped discovery on Android on 2026-11-09. Reference implementation: `contracts/js/ble-token.mjs`. Golden vectors: `contracts/fixtures/ble/golden-vectors.v1.json` and `contracts/fixtures/ble/resolution-cases.v1.json`, with their shape in `contracts/schema/ble-fixtures.v1.schema.json`. A backend advertises this protocol with `ble.mode: derived-v1` ([capabilities.md](capabilities.md)).

## Keys

The server never stores a per-person key. It derives one from a server secret and a per-session nonce, hands it to the device once, and derives it again whenever it needs it.

- **`ble_master_secret`**: at least 32 random bytes, held only by the server: Secret Manager on tier 3 (mounted as an environment variable, never logged and never written to a file), a Worker secret on tier 2. Tier 1 has no Bluetooth.
- **`presence_nonce`**: 16 random bytes, minted by the server on every `PUT /api/presence` with `ble: true` and stored on the person's document for that conference (unindexed, never returned, never logged). It is cleared with presence: `DELETE /api/presence`, the expiry purge, visibility turned off, the profile deleted, and a presence write with `ble: false`. One nonce means one presence session.
- **`ble_key`** for a session:

  ```
  ble_key = HMAC-SHA256(ble_master_secret,
                        "caddie-ble-key-v1" || uint16be(len(profile_id_utf8)) || profile_id_utf8 || presence_nonce)
  ```

  The label is the 17 ASCII bytes `caddie-ble-key-v1`. `profile_id_utf8` is the UTF-8 bytes of the device's `profile_id` (today always 22 characters, so the prefix is `0x00 0x16`); its byte length is written first as an unsigned 16-bit big-endian integer. The nonce is exactly 16 bytes and comes last. The length prefix and the fixed nonce length make the split between `profile_id` and nonce unambiguous. The key is the whole 32-byte HMAC output.

The server returns `ble_key` (base64url without padding, 43 characters) in the response to the presence write that minted the nonce, and never again (`PUT /api/presence`, [people-api.md](people-api.md)). The device stores it in the Android Keystore or the iOS Keychain, with the backend origin and conference it belongs to. It is valid while presence is live: the device stops advertising at the latest `presence_until` it has seen, and the server stops resolving it when presence ends or the nonce changes. A device whose key response was lost writes presence with `ble: true` again and gets a new one.

## Tokens

```
w        = floor(unix_seconds / window_s)          window_s = 600
token_w  = first 16 bytes of HMAC-SHA256(ble_key, "caddie-ble-v1" || uint64be(w))
```

- `unix_seconds` is the device's clock in whole seconds since 1970-01-01T00:00:00Z (UTC, no leap seconds); `w` is an unsigned 64-bit integer. The message is 21 bytes: the 13 ASCII bytes `caddie-ble-v1`, then `w` as 8 bytes big-endian. Implementations on signed 64-bit integers (Kotlin `Long`) encode the same bit pattern; the vectors include `w = 2^64 - 1`.
- The token changes at every multiple of 600 seconds of Unix time, the same instant on every phone. A phone computes it at any moment, including inside an iOS Bluetooth background wake, with no network call.
- In the sightings API a token is base64url without padding, 22 characters, exactly as today, so `POST /api/presence/sightings` is unchanged.

## Resolution on the server

For a sightings report from a requester who is around with a live nonce (else 403 `ble_required`):

1. Keep the strongest RSSI per token and drop those weaker than `ble.near_rssi`.
2. Look each remaining token up in the conference's **token table**: for every person of that conference who is live, visible conference-wide, not hidden after reports, around and has a `presence_nonce`, derive `ble_key` from (master, `profile_id`, nonce) and add `token_{w-1}`, `token_w` and `token_{w+1}` for the server's current window `w`. The table maps a token to a `profile_id` and holds no keys. It is built once per window and updated when a nonce changes: tier 2 keeps it in the conference's Durable Object memory, tier 3 in each instance, from one query.
3. Drop the requester and anyone blocked in either direction, then rank the rest with the same retriever as `POST /api/people/matches` and keep only strong matches, as today (`server/ble.mjs`).

The reference `resolverForPeople()` and `resolveSightings()` do steps 1 and 2; `resolution-cases.v1.json` lists the expected outcomes.

**Why w - 1, w and w + 1.** A sighting reaches the server after a delay `d`: the scanner reports in batches at most every `ble.sightings_min_interval_s` (at most 300 seconds in v1, half a window) plus upload time. The advertiser's clock may also be off by `δ` from the server's. The token the server sees is from window `w` exactly when `d - δ` stays within one window, so accepting `w - 1` and `w + 1` covers a report up to about five minutes late with the advertiser's clock up to about four and a half minutes slow, or a prompt report from an advertiser whose clock is up to ten minutes fast. Phones that set their time automatically are within a second, so this is a wide margin; the cost of `w + 1` is one more HMAC per live person per window and a table half again as large (2,400 entries for 800 Bluetooth users), with no privacy cost because the server already holds the master secret. A token from `w - 2` or `w + 2` resolves to nobody. Capping the sightings interval at half a window is what keeps `w - 1` sufficient for late reports; a 600-second interval, considered for tier 2, would need `w - 2` and was dropped.

## Over the air

| Item | Value |
|---|---|
| Service UUID | `e52c391c-b926-4856-9a38-d46c3c10c733` (unchanged from the Android companion) |
| GATT characteristic `token` | `944ddf9a-6eea-4583-978f-9da68fc3f562`, inside that service; read only, no encryption or bonding |
| Payload v1 | 17 bytes: `0x01` (format), then the 16 token bytes |
| Legacy payload | 16 bytes: the server-minted token of `server-rotate` mode, no format byte |

The payload is the same in service data and in the characteristic's value. A scanner reads a 17-byte value starting with `0x01` as a v1 token, a bare 16-byte value as a legacy token, and ignores anything else, so a later format with a different first byte or length cannot be misread (`decodePayload()`). Both kinds of token are reported the same way. 17 bytes fit one ATT read at the default MTU of 23.

- **Android.** Keeps Bluetooth 5 extended advertising (non-connectable, non-scannable, no device name, no TX power) with the service UUID and the payload as service data, because a legacy advertisement cannot hold a 128-bit UUID plus the payload. It should also run a second, legacy, connectable advertising set with the service UUID only (18 bytes of UUID plus flags fit in 31) and serve the GATT `token` characteristic, so a phone that cannot receive extended advertisements can still connect and read. It restarts its advertising sets at each window change, so the advertiser address changes with the token where the platform allows it. It scans for the service UUID and, to find backgrounded iPhones, for Apple manufacturer data (company `0x004C`) at or above `near_rssi`, then connects, looks for the service and reads the characteristic. Negative results are cached per address for the rest of the window, and connections are capped per minute.
- **iOS.** In the foreground it advertises the service UUID; in the background iOS moves it to the overflow area, which only other iOS devices scanning for it can see. It cannot put service data in an advertisement, so it always serves the GATT `token` characteristic, and peers connect and read it. It scans for the service UUID, reads service data when present (Android) and otherwise connects and reads the characteristic.
- **Both.** The value served is the payload for the current window of the phone's own clock, recomputed when the window changes. Reports are batched natively (the Android foreground service, the iOS Bluetooth wake) at most every `ble.sightings_min_interval_s` seconds, with tokens already resolved in the current window left out, and at most 50 per report.

## Threat model

- **Nothing about the person goes over the air.** A token is 16 bytes indistinguishable from random to anyone without the key. Tokens of different windows cannot be linked to each other or to a person without the key, and the key changes with every presence session.
- **A database leak alone links nothing.** The store holds nonces, not keys; without the master secret a nonce gives no key and no token.
- **A master-secret leak does link tokens**, together with a copy of the store: whoever holds both can derive every live key and follow the tokens of every person who is around with Bluetooth on. Rotating the master secret changes every key derived after the rotation; keys issued before it stop resolving, and each device recovers at its next presence write with `ble: true` (the client writes presence again within the hour in the `hour` mode, and on reopening in the `day` mode). Operators rotate between conference days and treat the secret like the database credentials.
- **The server learns which tokens one phone heard**, for the length of one sightings request, and keeps none of it: no index holds sightings, and the log has only method, path, status and duration. This is unchanged from today.
- **Exports never include anything derived from the key, or the nonce it is derived from.** `npm run people:export` and any tier 2 export leave out `presence_nonce`, keys and tokens; a nonce exported with the master secret available would let the key be rebuilt.
- **A replayed token** (someone re-broadcasting a token they overheard) can make phones near the replayer report the token's owner as nearby, but only until the window after the token's own has ended (at most about twenty minutes after it was first broadcast), and those phones learn no more than a nudge shows. This is the same exposure as today's random tokens, and it does not let anyone learn where the owner is.

## Golden vectors

`golden-vectors.v1.json` holds, with fake fixed values only:

- the constants above and window examples (`unix_seconds` → `w`) at 0, 599, 600, 2026-11-10T12:00:00Z (`w = 2990520`), the next window, and both sides of 2^32;
- token vectors for two fake keys, `00 01 … 1f` and `ff fe … e0`, at `w` = 0, 1, 2990520, 2990521, 2^32 - 1, 2^32 and 2^64 - 1: the message bytes, the full HMAC, the token in hex and base64url, and the 17-byte payload;
- key-derivation vectors: master secret `40 41 … 5f`, two fake `profile_id`s and nonces, the key message bytes, the `ble_key` and its tokens at three windows.

Every HMAC and key was computed by the reference implementation and, independently, by `openssl dgst -sha256 -mac HMAC -macopt hexkey:<key> <file holding the message bytes>` (LibreSSL 3.3.6, 2026-11-10), and the two agreed. `test/contracts-ble.test.mjs` checks every vector again three ways: the reference implementation; a SHA-256 and HMAC written in the test from FIPS 180-4 and RFC 2104 (checked against the FIPS and RFC 4231 test values) over message bytes built from this spec; and `openssl` when it is installed, with a few of its recorded outputs copied into the test. `resolution-cases.v1.json` covers the current, previous and next windows, the windows two away, the RSSI threshold, the strongest-sighting rule, an unknown token, a key from a replaced nonce, the reporter left out, and a window boundary.
