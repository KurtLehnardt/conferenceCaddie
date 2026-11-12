# People API v1

The People API is the plug every tier with people features implements: tier 3 (this server) as it is today, and tier 2 with the same routes and shapes, so an app cannot tell the tiers apart except through their capabilities ([capabilities.md](capabilities.md)). It is frozen from `docs/CONTRACT.md` (People and circles; Find & connect; Reports; Web Push; Bluetooth) and from the code in `server/`, which these contracts do not change. The native push registration routes were added later as optional routes of the same v1 (below). Schema: `contracts/schema/people-api.v1.schema.json`, one `$defs` entry per request and response body. Route table: `contracts/routes/people-api.v1.json`, with each route's method, path, authentication, body definitions, rate-limit buckets and errors. Examples: `contracts/fixtures/people-api/{route id}.json`; an example with `requires` (for example `"requires": "people.presence_keep_until"`) needs that capability flag, and a client that does not use the flag yet skips it.

Two tests hold the freeze in place. `test/contracts-people-api.test.mjs` checks the route table against the server's own route tables (removing or renaming a frozen route fails) and every example against the schema. `test/contracts-people-conformance.test.mjs` runs all 26 routes through the real handlers with an in-memory Elasticsearch stand-in that stores documents and evaluates the filters the server sends, and validates every answer in closed mode, with every list in the answers (people, members, inbox entries, blocks, nearby) non-empty at least once; a response field added or renamed in `server/` without a contract change fails. Ranking is not under test there, because the stand-in does not score.

## Conventions

- **Base.** Every path is relative to the backend's base URL. Every request names its conference, `event` in the JSON body or `?event={slug}` in the query for `GET` and `DELETE` routes without a body, except the routes under `/api/meet/{meet_id}`, which find the conference from the meet. The conference must be `searchable`; otherwise 400 `conference is not available`.
- **Device credential.** Routes marked `device` need `X-Caddie-Device: {profile_id}.{secret}`. The device generates `profile_id` (16 random bytes) and `secret` (32 random bytes) once per backend origin, both base64url without padding (22 and 43 characters), and keeps them in the Keystore or Keychain. The server stores only `sha256(secret)` in hex and compares in constant time. A missing, malformed or wrong credential is 403 `forbidden`. The first profile write creates the document with `op_type: create`, so an existing document can never be taken over by another device.
- **Bodies.** `Content-Type: application/json` (else 415), at most 8 KB (else 413), a JSON object (else 400), and **an unknown key is 400** (`Unknown key: {key}`), at every level the server checks. Request schemas are therefore closed. Text fields are trimmed and their caps apply after trimming.
- **Origin.** A request may carry no `Origin` (the native apps send none) or one naming the backend's own host; any other is 403 `cross-origin request`.
- **Responses.** JSON, `Cache-Control: no-store` unless a route says otherwise. Clients ignore response fields they do not know; response schemas are closed only in producer mode.
- **Errors.** Every error body is `{ "error": "...", ... }`. For the codes below, `error` is a stable machine code and the extra keys are listed. Elsewhere, mostly 400 validation errors, `error` is a human-readable English message that clients must not parse; they treat any such 400 as "the input was refused".
- **Privacy.** No response carries a `profile_id`, a secret, a hash, a coordinate or a Bluetooth token of another person. People are named by `ref`, the first 16 hex digits of `sha256(event_id:profile_id:REF_SALT)`.

### Stable error codes

| Status | `error` | Extra keys | Meaning |
|---|---|---|---|
| 400 | `filtered` | `message` | A line other people would read hit the filter (spot, note, spot-me). |
| 400 | `presence_not_active` | `message` | `PUT /api/presence` with `until: "keep"` while no presence is live (none stored, or it has run out). Nothing is written. The client treats presence as off: it stops Bluetooth and turns presence on again with `hour` or `day` only when the user asks. |
| 403 | `forbidden` | | Missing, malformed or wrong device credential; also a meet read or action by a non-participant, and accept or decline by the requester. |
| 403 | `cross-origin request` | | A foreign `Origin` header. |
| 403 | `profile_required` | | No live profile (with `open_to_meet: true` where the route needs it). |
| 403 | `visibility_required` | | Matches need `open_to_meet: true`. |
| 403 | `share_required` | `count` | Circle members need the requester to share for that talk; `count` is still given. |
| 403 | `presence_required` | `message` on asks and accept | The requester must be around. |
| 403 | `ble_required` | | Sightings need the requester to be around with Bluetooth on. The device stops Bluetooth. |
| 403 | `ble_rekey` | | derived-v1: the requester's session was issued under a retired master. The device gets a new key ([ble-tokens.md](ble-tokens.md), Re-keying). |
| 403 | `blocked` | | A block in either direction; the same body whichever side blocked. |
| 403 | `hidden` | | The requester's profile is hidden after reports. |
| 404 | `not_found` | | Unknown, expired or own `ref`; unknown meet. |
| 404 | `push_unavailable` | | A native push registration for a platform this backend does not push to (`push.apns` or `push.fcm` is false). Nothing is stored. |
| 405 | `Method not allowed` | | With an `Allow` header. |
| 409 | `not_around` | `message` | The person asked is not around. |
| 409 | `meet_open` | `meet_id` | An open ask between the two already exists. |
| 409 | `state` | `state` | The meet is open but in the wrong state for the action. |
| 410 | `over` | `state` | The meet is no longer open. |
| 413 | `Request body is too large` | | |
| 415 | `Content-Type must be application/json` | | |
| 429 | `paused` | `message`, `retry_at` | Three declines today; with `Retry-After` until the end of the conference day. |
| 429 | `Too many requests` | | Over a rate limit; with `Retry-After` in seconds. |
| 502 | `People are temporarily unavailable` | | The store failed. Its own error is never forwarded. |

Free-text 404 and 409 messages also exist: `talk not found` (circle members), and "The profile changed at the same time; try again" and "The meet changed at the same time; try again" when a concurrent write won; clients retry those once.

**Client rule for errors.** A client branches on the stable codes above and treats any other `error` by its status class: 400 means the input was refused (show the message only when it is `filtered`, treat `presence_not_active` as presence being off, and otherwise show a generic line), 403 and 404 mean the action is not possible now (refresh the view), 409 means a concurrent change (read again, retry at most once), 410 means the thing is over, 429 means wait for `Retry-After`, and 5xx means try again later. A new stable code is added to this table, never repurposed, so an old client always falls back to the class.

### Rate limits

In-memory buckets per instance, keyed by device and by client address, each answering 429 with `Retry-After`:

| Bucket | Per device | Per address | Routes |
|---|---|---|---|
| `people-write` | 20 a minute | 60 a minute | profile writes, blocks, presence, every meet write, push subscriptions and native push registrations, the legacy rotate |
| `people-read` | 30 a minute | 90 a minute | matches, circle members, the blocks list |
| `people-poll` | 30 a minute | 1,200 a minute | the meet inbox and meet reads (polled every 45 and 15 seconds, stretched by the API's pace; their own buckets so a venue's shared address does not starve searches) |
| `public` | | 60 a minute | circle counts, the VAPID key |
| `sightings` | 6 a minute | 300 a minute | Bluetooth sightings |
| `report` | 20 an hour | 60 a minute | reports |
| `meet-request` | 10 an hour | | asks, on top of `people-write` |

Tier 2 may set its own numbers; the capabilities flag `ble.sightings_min_interval_s` tells clients how often to report sightings.

## Routes

Request and response shapes are the named `$defs` entries; the route table lists each route's errors.

| Route | Auth | Request → response | Notes |
|---|---|---|---|
| `PUT /api/people/profile` | device | `ProfilePutRequest` → `ProfilePutResponse` | Create or update; `open_to_meet: false` with no shared talks deletes the profile and answers without `hidden_for_owner`. `degraded: { semantic: true }` when the text could not be embedded yet. |
| `DELETE /api/people/profile?event=` | device | → `Ok` | Deletes the profile, its blocks, meets, push subscriptions and nudge records. Answers 200 when there is nothing to delete. |
| `POST /api/people/matches` | device | `MatchesRequest` → `MatchesResponse` | People to meet, text search by what people have built, and `when: around_now`. Pages by `from + size`; a page can be shorter than `size` because of the specificity rule. |
| `POST /api/circles/counts` | none | `CircleCountsRequest` → `CircleCountsResponse` | Never who, only how many. |
| `POST /api/circles/members` | device | `CircleMembersRequest` → `CircleMembersResponse` | Only for a requester who shares for the talk. |
| `POST /api/people/block` | device | `BlockRequest` → `Ok` | Symmetric; ends any open meet between the two. |
| `DELETE /api/people/block` | device | `BlockRequest` → `Ok` | Works after the blocked profile is gone. |
| `GET /api/people/blocks?event=` | device | → `BlocksResponse` | Newest first. |
| `PUT /api/presence` | device | `PresencePutRequest` → `PresencePutResponse` | Zone, spot line, optional position, `hour` or `day`, or `keep` (below). `ble` starts or stops Bluetooth proximity (below). A 409 means a concurrent write to the profile won. |
| `DELETE /api/presence?event=` | device | → `Ok` | Clears presence, the position and the Bluetooth state; expires any active meet. |
| `POST /api/presence/ble/rotate` | device | `BleRotateRequest` → `BleRotateResponse` | **Legacy** (`ble.mode: server-rotate` only). |
| `POST /api/presence/sightings` | device | `SightingsRequest` → `SightingsResponse` | The request is the same in both Bluetooth modes; derived-v1 adds `ble_key_id` to the answer and resolves under the rules of [ble-tokens.md](ble-tokens.md). |
| `POST /api/meet` | device | `MeetRequest` → `MeetActionResponse` | Ask to talk shop, now. |
| `GET /api/meet/inbox?event=` | device | → `InboxResponse` | Open asks to and from the requester, newest first, at most 100. |
| `GET /api/meet/{meet_id}` | device | → `MeetReadResponse` | The only response with `other.distance_m` and `other.bearing_deg`. |
| `POST /api/meet/{meet_id}/accept` | device | `EmptyRequest` or no body → `MeetActionResponse` | The person asked, while around. |
| `POST /api/meet/{meet_id}/decline` | device | `EmptyRequest` or no body → `MeetActionResponse` | Silent: the requester keeps seeing a waiting ask until it runs out. |
| `POST /api/meet/{meet_id}/found` | device | `EmptyRequest` or no body → `MeetActionResponse` | Either participant, active meets. |
| `POST /api/meet/{meet_id}/cancel` | device | `EmptyRequest` or no body → `MeetActionResponse` | Either participant, any open state. |
| `PUT /api/meet/{meet_id}/details` | device | `MeetDetailsRequest` → `MeetActionResponse` | My spot-me line and the meeting point. |
| `POST /api/people/report` | device | `ReportRequest` → `ReportResponse` | Two reports hide a target from everyone but its owner. The server may also hold operator-filed reports (`reporter_id` `operator`) that count as the hide threshold on their own; nothing about them is returned to clients. |
| `GET /api/push/vapid` | none | → `PushVapidResponse` | `publicKey` null when Web Push is not configured. |
| `PUT /api/push/subscription` | device | `PushSubscriptionPutRequest` → `Ok` | A backend may refuse an endpoint that is not on a known browser push service with 400 `endpoint must be a push service URL`. Both the Worker and the tier 3 server do, with the same host list, so the fixture's endpoint is on `fcm.googleapis.com`. |
| `DELETE /api/push/subscription` | device | `PushSubscriptionDeleteRequest` → `Ok` | Answers 200 whether or not anything was removed. |
| `PUT /api/push/native` | device | `PushNativePutRequest` → `Ok` | **Optional**, gated by `push.apns` or `push.fcm` (below). |
| `DELETE /api/push/native` | device | `PushNativeDeleteRequest` → `Ok` | **Optional**. Answers 200 whether or not anything was removed, also when the backend no longer pushes to the platform. |

### Features built from these routes (no routes of their own)

- **Wave.** A one-tap ask to someone in my zone: `POST /api/meet` with a note the client writes, today "I'm in {zone} too — want to talk shop?" (cut to 140 characters).
- **In-app nudges and "Who's around".** `POST /api/people/matches` with `when: around_now`, polled while the app is open (every 45 seconds with the inbox, and every 120 seconds while the Around view is visible, each stretched by the pace the API reports) when `people.live` is `poll`. The client rule (a strong match in my zone, at most once per person per day, recorded on the device) is unchanged.
- **Push nudges.** The server runs the nudge rule after every successful `PUT /api/presence` and pushes through Web Push to the subscriptions above, and through APNs and FCM to the registrations of the optional native push routes (below), advertised by `push.apns` and `push.fcm`.
- **Watch list.** Device-only, from the matches above.

## Native push registration (optional)

`PUT /api/push/native` and `DELETE /api/push/native` let the official iOS and Android apps receive the push nudge while they are closed. They are optional routes of v1: a backend serves them when it can push to the official apps, which only the official deployment can (it holds the publisher's APNs key and Firebase project; [capabilities.md](capabilities.md), `push.apns` and `push.fcm`). Third-party backends advertise both flags false and need not serve the routes. Neither route changes any route above.

- **When to call.** The app registers with `platform: "apns"` only when `push.apns` is true and with `platform: "fcm"` only when `push.fcm` is true, after the user turned on push nudges and granted notification permission, and again whenever the platform hands it a new token. It needs the device credential and a live profile at that conference, like the Web Push routes. Turning the switch off, or deleting the profile from the device, calls the delete. The app sends its registration calls one at a time, each after the previous one was answered, and never sends a PUT for a token after a PUT for a newer one: the backend keeps whichever PUT reaches it last, because it cannot tell a late retry of an old registration from a new one.
- **Request.** `PUT` takes `{ "event", "platform": "apns" | "fcm", "token", "environment"? }`. An APNs `token` is the device token as hexadecimal digits, 64 to 200 of them (32 bytes today), in either case; the backend stores it lowercase. An FCM `token` is the registration token as the Firebase SDK gives it: 32 to 4096 characters of letters, digits, `_`, `-` and `:`. `environment` is for APNs only: `"sandbox"` for a development build, `"production"` (the default) otherwise; with `fcm` it is a 400. `DELETE` takes `{ "event", "platform", "token" }` and no `environment`. Bodies are closed (an unknown key is 400) and at most 8 KB, and both routes share the `people-write` buckets.
- **Answers.** 200 `{ "ok": true }`. A device keeps one registration per platform at each conference: `PUT` again overwrites it, with the same token (safe to repeat at every start) or with a new one, which replaces the old token when the platform rotates it. 400 with an English message for a malformed body, platform or token, or a conference that has ended. 403 `profile_required` without a live profile, including while the requester's profile delete is pending (as for Web Push, that is harmless: the delete removes the registration). 404 `push_unavailable` from `PUT` when this backend does not push to that platform; nothing is stored. A backend that does not serve the routes at all answers 404 `{ "error": "Not found" }`. A client treats either 404 as "native push is not available here", keeps its in-app nudges and does not retry until the capabilities change. `DELETE` removes the requester's registration for that platform at that conference only while it still holds the given token, so a stale client cannot remove the registration a newer token replaced it with; it answers 200 whether or not anything was removed, also when the backend no longer pushes to the platform, so a device can always remove its token.
- **What arrives.** A generic alert, the same for every push: title `Conference Caddie`, body `Someone whose experience matches yours is in your zone right now`, and the deep link `caddie://people?around=1`, which opens the People tab on "Around now" of the conference the app has open (the apps accept only links that start with `caddie://`). APNs and FCM payloads reach Apple and Google in plain text, unlike Web Push payloads, which are end-to-end encrypted to the browser, so a native push carries no zone, no passage of anyone's words, no name, no distance, no `ref`, no `profile_id`, no conference and no spot line; the app shows who through the authenticated API once it is open. APNs gets exactly `{"aps":{"alert":{"title":"Conference Caddie","body":"Someone whose experience matches yours is in your zone right now"},"sound":"default"},"deepLink":"caddie://people?around=1"}` as an alert push with `apns-priority` 5, `apns-expiration` 600 seconds ahead and `apns-collapse-id` `caddie-nudge`. FCM gets `{ "message": { "token", "notification": { "title", "body" }, "data": { "deepLink" }, "android": { "ttl": "600s", "priority": "normal", "notification": { "tag": "caddie-nudge" } } } }` with the same title, body and deep link. A newer nudge replaces an older one on the phone, as the web app's notification tag does.
- **Limits and lifetime.** The nudge's limits apply to all channels together: once per pair per conference day, and at most 3 pushes an hour per receiver, where one nudge to a receiver is one push to each of their Web Push subscriptions and native registrations and counts once. When both people of a pair get the nudge, they get it a random 0 to 3 seconds apart. A registration expires with its conference and is deleted with the profile, by the hourly purge, by `DELETE /api/push/native`, and when APNs answers 410 or 400 `BadDeviceToken`, or FCM answers 404 `UNREGISTERED` or 400 `INVALID_ARGUMENT` naming the token. Any other refusal (APNs 400 `DeviceTokenNotForTopic` included, which a wrong topic on the backend would give for every token) keeps it. Such a delete applies only while the registration still holds the token that was pushed to, so a token the app registered while the push was out stays. The app registers again with its current token on its next start.

## Keeping the end of presence (`until: "keep"`, optional)

`until` is a mode, not a time: `hour` (the default, also for `null`) sets `presence_until` to 60 minutes from now and `day` to the end of the conference day, so every write with either starts the end again. A write that only changes Bluetooth, the zone, the spot line or the position would therefore make the person visible for longer than they chose. A backend whose capabilities say `people.presence_keep_until: true` (tier 3) also takes `until: "keep"`:

- **It keeps the stored `presence_until`** exactly (never past the end of the conference), and `presence_since` with it. Everything else in the body applies as with `hour` or `day`: `zone`, `spot` and `location` replace the stored ones, and `ble: true` starts a new Bluetooth session that ends with the kept `presence_until` (a re-key, [ble-tokens.md](ble-tokens.md)), `ble: false` ends it, and no `ble` leaves it as it is.
- **It never starts presence.** With no presence stored, or one whose `presence_until` has passed, the answer is 400 `{ "error": "presence_not_active", "message": "until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'." }` and nothing is written.
- **It is judged against the guarded read.** The write is a guarded write of the device's own document (below), so a presence that a `DELETE /api/presence`, the purge or another write changed between the read and the write is read again and judged afresh; `keep` never brings back an end that is gone.
- **The answer echoes `until: "keep"`**, with the kept `presence_until`.
- A client sends `keep` only when the capabilities say `people.presence_keep_until`, and then with every write that only changes Bluetooth, the re-key included; a backend without it answers 400 with an English message, as for any unknown mode.

## Bluetooth in the People API

`PUT /api/presence` takes an optional boolean `ble`. `true` starts Bluetooth proximity, `false` stops it, and a write without `ble` leaves it as it is. What `true` returns depends on the backend's `ble.mode`:

- **`derived-v1` (new in v1, Phase 4).** The response adds `ble_key`: a fresh 32-byte key, base64url without padding (43 characters), for this presence session, and `ble_key_id`, its 11-character id (the `PresencePutResponseDerived` definition requires both). The key is returned only in the response to the write that minted it and never again; the device keeps it in the Keystore or Keychain and derives its tokens from it ([ble-tokens.md](ble-tokens.md)). The key is valid while presence is live, that is until the latest `presence_until` the device has seen; every presence write with `ble: true` replaces it. A sightings answer adds `ble_key_id`, the id of the requester's current key (`SightingsResponseDerived`). Sightings need the requester to be around with a live session (else 403 `ble_required`); a session issued under a retired master is 403 `ble_rekey`. A device whose stored key has another id, that gets a 200 sightings answer without `ble_key_id` (its session is not one the backend resolves as derived-v1, for example one started before the backend switched modes), or that gets `ble_rekey`, re-keys under the rules of [ble-tokens.md](ble-tokens.md) (Re-keying): only while its presence is live and the user has it on, at most once per window, with a presence write that repeats its current zone, spot, location and until, because a presence write replaces every presence field. In this mode a `nearby` entry resolves only for a person co-located with the requester (same zone, or the same or a neighbouring ~100 m cell, unless the backend's `ble.colocation_required` is false); the answer holds at most 10 new people per device per window and 30 per rolling hour, counted on the final list; and an entry's `zone` is set only when it is the requester's own zone.
- **`server-rotate` (legacy, today).** The response adds `ble: { token, rotate_at }`, a server-minted 16-byte token, and the device calls `POST /api/presence/ble/rotate` before `rotate_at` for the next one. Tokens die with presence.

A backend in transition may serve both: it answers `ble: true` with both fields, resolves sightings against both kinds of token, and old clients ignore `ble_key`. Since only old clients call the rotate route, such a backend may tell them apart by it: tier 3 answers a session under a retired master with 403 `ble_rekey` unless its legacy token is live and was rotated, so a new client is asked to re-key at once while an old client, which does not know `ble_rekey`, keeps its legacy token working until it runs out. The sightings request is the same in both modes: at most 50 `{ token, rssi }`, each token 22 base64url characters (16 bytes) and each RSSI an integer from -127 to 20.

## Where today's behaviour differs from `docs/CONTRACT.md`

The freeze follows the code where the two disagree, and these differences are now part of the contract:

- `PUT /api/presence` also answers `spot_hidden` (true after a spot line was hidden after reports; the spot is then not stored).
- The meet inbox and meet reads use the `people-poll` buckets (30 a minute per device, 1,200 per address), not the read buckets.
- `PUT /api/people/profile` answers `hidden_for_owner` only when the profile still exists after the write.
- `DELETE /api/people/profile` checks only that `event` looks like a slug, not that the conference is searchable, so a device can always delete its data.
- Speaker links in circle members keep the scheme's case as the feed wrote it (`Https://...` occurs in real data); a client must compare schemes case-insensitively.
- 400 validation errors carry English messages, not codes; only `filtered` and `presence_not_active` (an addition with `until: "keep"`) are stable 400 codes.
- Presence writes and the legacy token rotation are guarded writes of the device's own document (PR #15): after one internal retry, a write that lost a race answers 409 "The profile changed at the same time; try again", and one whose profile was hidden for deletion or deleted meanwhile answers 403 `profile_required`. `DELETE /api/presence` only clears and retries conflicts itself.
- A profile whose delete is unfinished counts as gone everywhere: its device gets 403 `profile_required` on blocks, asks, reports, push and presence until the delete finishes, and it is left out of other people's answers.
- Blocks belong to the blocker and outlive the blocked profile until the conference ends, so `GET /api/people/blocks` can list a block whose `display_name` is null (the blocked profile is gone or its delete is pending); unblocking by `ref` works either way.

## Not in People API v1

Talk search, related talks and recommendations (`talks.server_search`), the imports (`imports.*`), the conference list (its shape is part of `conferences.json`, [talk-bundle.md](talk-bundle.md)), the topics routes, the WebSocket channel of tier 2 (`people.live: websocket`), and client-computed people vectors (`people.semantic: client`). Each will be added as an optional, versioned addition without changing any route above, as native push registration was.
