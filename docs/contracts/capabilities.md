# Capabilities v1

The capabilities document tells an app what one backend can do, so the same native apps run against any tier and show only the features that backend serves. Schema: `contracts/schema/capabilities.v1.schema.json`. Reference implementation: `contracts/js/capabilities.mjs`. Fixtures: `contracts/fixtures/capabilities/`.

## Where it lives

| Tier | Location | Notes |
|---|---|---|
| 1, demo (static site) | `{base}/capabilities.json` | For example `https://<owner>.github.io/<repo>/capabilities.json`. |
| 2, free (Worker) | `GET {base}/api/capabilities` | |
| 3, paid (this server) | `GET {base}/api/capabilities` | Added in Phase 1. Before that the route answers 404, which makes the server a legacy backend (below). |

The response is `application/json` and public. Backends should send `Cache-Control: public, max-age=300` and may send `Access-Control-Allow-Origin: *` on this one route, since it carries nothing private and the tier 1 web page may read it from another origin.

## The document

```json
{
  "api_version": 1,
  "tier": "free",
  "talks": { "bundle_base": "https://kurtlehnardt.github.io/conferenceCaddie/bundles/", "server_search": false },
  "people": { "enabled": true, "semantic": "client", "presence": true, "gps_bands": true,
              "meets": true, "circles": true, "reports": true, "live": "websocket" },
  "ble": { "mode": "derived-v1", "service_uuid": "e52c391c-b926-4856-9a38-d46c3c10c733",
           "near_rssi": -75, "window_s": 600, "sightings_min_interval_s": 300 },
  "push": { "apns": false, "fcm": true, "webpush": true },
  "imports": { "github": "device", "schedule": "device" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `api_version` | integer ≥ 1 | Major version of this document and of the People API the backend serves. |
| `min_api_version` | integer, optional | Oldest major whose clients this backend still serves correctly. Defaults to `api_version`. |
| `tier` | `demo`, `free` or `paid` | A label for people. Clients never gate a feature on it; only the flags below do. |
| `talks.bundle_base` | https URL ending in `/`, or null | Where `conferences.json` and the talk bundles live ([talk-bundle.md](talk-bundle.md)). Null when the backend publishes none. |
| `talks.server_search` | boolean | `POST /api/search`, `GET /api/related` and `POST /api/recommendations` are served as well. Optional on every tier; talk features run on the device from the bundle. |
| `people.enabled` | boolean | The People API v1 ([people-api.md](people-api.md)) is served. False hides the People tab. |
| `people.semantic` | `server`, `client` or `off` | Where meaning-based people matching runs. `client` is reserved for tier 2, where the app computes profile vectors; the request field that carries them is not part of People API v1 and will be added as an optional field. A client that does not implement `client` treats it as `off` (keyword and topic legs only). |
| `people.presence` | boolean | `PUT` and `DELETE /api/presence`, the "around now" view and the watch list. |
| `people.gps_bands` | boolean | The optional position with presence, the proximity bands and the distance inside an active meet. |
| `people.meets` | boolean | Ask to talk shop, Wave, the meet inbox and the meet screen. |
| `people.circles` | boolean | Per-talk sharing, circle counts and circle members. |
| `people.reports` | boolean | `POST /api/people/report`. It must be true whenever `people.enabled` is true: a backend that shows other people's text must let users report it, and block is part of every People API. |
| `people.live` | `websocket` or `poll` | How the app learns about inbox and presence changes. Polling always works, because every tier serves every People API v1 route; `websocket` is an optimisation whose protocol is specified separately with tier 2. |
| `ble.mode` | `derived-v1`, `server-rotate` or `none` | Bluetooth proximity: derived tokens ([ble-tokens.md](ble-tokens.md)), the legacy server-minted tokens with the rotate route, or none. |
| `ble.service_uuid` | UUID | Always `e52c391c-b926-4856-9a38-d46c3c10c733` in v1. |
| `ble.near_rssi` | integer dBm, -100 to -30 | The weakest signal that counts as right near. The server applies it; clients do not report weaker sightings. Replaces the server-only `BLE_NEAR_RSSI` as the value operators tune. It is a relevance threshold, not a security boundary: a report's RSSI is whatever the client claims ([ble-tokens.md](ble-tokens.md), Threat model). |
| `ble.colocation_required` | boolean | `derived-v1`: a sighted person resolves only when they share the requester's zone or ~100 m cell ([ble-tokens.md](ble-tokens.md), Phase 4 mitigations). Default true; an operator may set false for a single-room event. |
| `ble.window_s` | integer seconds | Token window. Exactly 600 in `derived-v1`. |
| `ble.sightings_min_interval_s` | integer seconds | The shortest interval between two sightings reports from one device. 10 to 300 in `derived-v1` (at most half a window, see [ble-tokens.md](ble-tokens.md), Resolution); tier 3 can use 10, tier 2 uses 60 for small events and 300 for a KubeCon-sized one. |
| `push.apns`, `push.fcm` | boolean | This backend can push to the official iOS or Android app, which needs the publisher's APNs key or Firebase project. Third-party tier 2 and 3 operators set both false. |
| `push.webpush` | boolean | The Web Push routes are served. `GET /api/push/vapid` still says whether keys are configured. |
| `imports.github` | `device` or `server` | `device`: the app calls `api.github.com` itself. `server`: `POST /api/import/github` is served. |
| `imports.schedule` | `device` or `server` | `device`: the app parses the file itself. `server`: `POST /api/import/schedule` is served. |

Schema rules beyond the table: `people` fields other than `enabled` are required when `enabled` is true; `ble.mode` must be `none` when `people.enabled` is false; `derived-v1` requires every `ble` field, `window_s: 600` and `sightings_min_interval_s` of at most 300; `talks.bundle_base` is an https URL without credentials, query or fragment; `server-rotate` requires `service_uuid`, `near_rssi` and `sightings_min_interval_s`.

## Reading the document (consumer rules)

A v1 client turns whatever it fetched into an effective feature set, `effectiveCapabilities()` in the reference implementation:

1. **Unknown fields are ignored**, at every level. A newer backend can add fields without breaking older apps (`forward-compatible-v2.json`).
2. **Unknown enum values fall back to the most conservative known value**: `people.semantic` to `off`, `people.live` to `poll`, `ble.mode` to `none`, `imports.*` to `device`, and an unknown `tier` to the label `unknown`.
3. **A missing field is off**: booleans false, `bundle_base` null, `ble.mode` none, imports on the device. The one exception is `ble.colocation_required`, which is a protection and is therefore on unless the document says false. `near_rssi` is clamped to [-100, -30] (-75 when it is not an integer); other numbers out of range take their defaults (`window_s` 600, `sightings_min_interval_s` 60, capped at 300 in `derived-v1`).
4. **Dependent features turn off with what they need.** No people features at all unless `people.enabled` and `people.reports` are both true. No presence, meets or GPS bands without `people.presence` (asks are now-only, so they need presence). No Bluetooth without presence.

These rules apply only to a document that exists. A backend without a document is the legacy case below.

## Version negotiation

`api_version` is the newest major the backend speaks and `min_api_version` (default `api_version`) the oldest. The client uses the highest major it implements within that range. When the range is entirely above what the client implements, it shows "This server needs a newer version of the app" and uses nothing from the document. A backend that changes the document incompatibly raises `api_version`; one that adds a v2 but stays readable by v1 clients keeps every v1 field and sets `min_api_version: 1`. The fixtures `forward-compatible-v2.json` (usable by v1) and `too-new-v2.json` (not usable) cover both cases.

## Discovery and the legacy backend

The app holds one configured backend URL, `base` (see Backend URLs below), and discovers its capabilities like this (`discoverCapabilities()`):

1. `GET {base}/api/capabilities`. A 200 JSON body the client can negotiate is used (tiers 2 and 3).
2. Otherwise `GET {base}/capabilities.json`, the same way (tier 1).
3. Only when step 1 answered **404 with exactly `{ "error": "Not found" }`** (the existing server's answer to an unknown `/api` path, `server/index.mjs`), and only for a backend that has never served a document to this device: `GET {base}/api/health`. If it answers 200 with exactly `{ "ok": true }` (no other keys), the backend is **legacy**: today's tier 3 server before Phase 1. Its effective feature set is the full current one, `LEGACY` in the reference implementation and `legacy-effective.json` as a fixture: people features on with server-side semantics and polling, Bluetooth in `server-rotate` mode with a 10-second sightings interval, Web Push, both imports on the server, `server_search` true and no talk bundles (`bundle_base` null; an app may fall back to a bundle base compiled into its build).
4. Otherwise the backend is unreachable or not a Caddie backend.

A failure is never read as legacy: a 5xx, a timeout, a network error or any other 404 body at step 1 leaves the app on its last good document for that backend, and with none it shows the backend as unreachable. The app records, per backend base, that the backend once served a document, and from then on skips the legacy probe for it entirely (`hadDocument` in `discoverCapabilities()`), so a backend that once had a document is never downgraded to legacy.

## Caching

The app keeps the last good document per backend base. It fetches again at every cold start and when the cached copy is older than the response's `max-age` (one hour when there is none), and it uses the cached copy, if any, while a fetch fails. A change of `ble.mode`, `people.enabled` or `talks.bundle_base` takes effect at the next screen change, not in the middle of a meet or a Bluetooth session.

## Backend URLs and switching backends

- The default backend URL is compiled into each build. The user can change it in Settings → Server, and an operator can hand one out as a deep link or QR code: `caddie://connect?url=<backend URL, percent-encoded>`.
- A backend URL must be `https`, without credentials, query or fragment; its path is kept, because a tier 1 site lives under `/<repo>`. Debug builds may also allow plain `http` to `localhost`, `127.0.0.1`, `[::1]` and `10.0.2.2` when the URL is typed in Settings, never from a link (`normaliseBackendUrl()`).
- **A deep link or QR code never switches the backend by itself.** It requires `https` with no exception, and the switch happens only after the user confirms a prompt that names the new backend's base URL exactly, origin and path (for example "Switch to the server at https://kurtlehnardt.github.io/conferenceCaddie?"). Declining leaves everything as it was (`parseConnectLink()`).
- Device credentials (`profile_id` and `secret`, [people-api.md](people-api.md)), the Bluetooth key, the cached capabilities, the "has served a document" mark and the per-conference device state are stored per normalised backend base (origin plus path), because two tier 1 sites can share an origin. One backend's secret is never sent to another, and switching back finds the old state.

## Fixtures

| File | What it is |
|---|---|
| `tier1-demo.json` | Tier 1: bundles, no people features, imports on the device. |
| `tier2-free.json` | Tier 2: people features with client vectors and a WebSocket, `derived-v1` with a 300-second sightings interval, FCM push from the official backend. |
| `tier3-paid.json` | Tier 3 after Phase 4: server semantics, polling, `derived-v1` with a 10-second interval, APNs and FCM from the official backend. |
| `tier3-transition.json` | Tier 3 between Phase 1 and Phase 4: the same with `server-rotate` Bluetooth and no native push. |
| `legacy-effective.json` | The effective feature set of a backend with no document. |
| `forward-compatible-v2.json` | A v2 document a v1 client can read: unknown fields and enum values. |
| `too-new-v2.json` | A v2 document a v1 client must refuse. |
| `invalid/*.json` | Documents a producer must never send: a 300-second window or a 600-second interval in `derived-v1`, people without reports, Bluetooth without people, an http bundle base, and an unknown field (valid for consumers, refused in closed mode). |
