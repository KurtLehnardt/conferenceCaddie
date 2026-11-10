# Conference Caddie as native Android and iOS apps with pluggable $0 deployment tiers

**Status:** Plan adopted 2026-11-10; implementation tracked in pull requests.

Prepared 2026-11-10. When it was prepared this was planning only: no code in the repository was changed, nothing was pushed or deployed, and Elasticsearch was not queried.

Every repository citation is `path:line` relative to the repository root. They were read from a detached worktree of `origin/main` at commit `3a10fbc`, an ancestor of the current `main`; every citation is pinned to that commit and may have moved since. External facts carry a link; all links are collected again in section 17. Anything not verified is labelled ASSUMPTION and listed in section 16.

---

## 1. The answer in brief

- **Ship one pair of fully native apps** (Android and iOS) that read a capabilities document from whichever backend they are pointed at. The same apps then run against three deployment tiers:
  1. **Tier 1, a free-forever demo.** A static schedule bundle on GitHub Pages, with on-device search and talk recommendations. It has no people features.
  2. **Tier 2, a $0 Cloudflare free-plan backend.** Workers, a SQLite-backed Durable Object per conference, and D1 for people features.
  3. **Tier 3, the existing paid deployment.** Google Cloud Run plus Elastic Cloud, for operators who want to pay.
- **Tier 2 fits a KubeCon-sized conference** inside the free allowances, but only after three changes to how the client behaves:
  - Live updates move from polling to a hibernatable WebSocket.
  - Bluetooth tokens are derived on the phone from a key, so rotation needs no network call.
  - Bluetooth sightings are batched by an operator-set interval.

  Ported as it is, today's server would use 118% to 2,358% of the Workers free request allowance (section 7.5).
- **No free service promises to be free forever.** Only Neon states "permanent (not a trial)". Section 7.6 flags each service's permanence with its source. The precedent that matters: Firebase moved Cloud Storage off its free Spark plan in October 2024. Tier 2 is designed to degrade rather than break if an allowance disappears. Semantic matching falls back to keywords. Durable Objects can fall back to D1 with polling for small conferences.
- **The Bluetooth redesign also fixes the 2026-11-09 Android failure at its root.** Tokens become `HMAC(key, 10-minute window)`, computed natively by the phone. Nothing has to wake the JavaScript layer or call the server to rotate. Privacy stays as it is today: nothing about the person goes over the air, and only the server can resolve a token.
- **Distribution.** The Apple Developer Program is already paid, so TestFlight, the App Store, APNs and the background entitlements are all available. On Android, a directly downloaded APK costs $0. Google Play costs a one-time $25, which counts as a payment under the maintainer's definition of free. Global Android developer verification arrives in 2027 (section 9).
- **Stack recommendation:** a Kotlin Multiplatform shared core with Compose Multiplatform UI on both platforms, plus thin platform modules: Kotlin on Android, Swift on iOS for Core Bluetooth and notifications. For one developer who works in JavaScript and TypeScript, this means one new language for almost everything and one implementation of ranking and protocol logic. If iOS must use UIKit-native widgets, SwiftUI screens can sit over the same core (section 10).

---

## 2. Maintainer decisions incorporated (2026-11-10)

- The Apple Developer Program ($99 a year) is already paid, so App Store, TestFlight, APNs push and entitlements are available.
- "Free" means the maintainer pays nothing. Free tiers are acceptable only if free forever: no trial credits and no "free for 12 months". Any tier whose permanence is uncertain is flagged with its source (section 7.6).
- The repository is open source and meant for anyone. The design therefore has pluggable deployment tiers (1: free-forever demo without interest-based peer finding; 2: Cloudflare free plan; 3: existing paid Cloud Run + Elastic), and the same native apps work against any tier through a configurable backend URL and capability flags.
- The maintainer asked for "full native Android and iOS apps", so section 10 recommends between Kotlin + Compose with Swift + SwiftUI, and a Kotlin Multiplatform shared core.

---

## 3. How this was researched

- The repository was read in a detached worktree. Documents: `README.md`, `docs/CONTRACT.md`, `DECISIONS.md`, `docs/ANDROID.md`, `docs/OPERATOR_CHECKLIST.md`, `docs/FIND_AND_CONNECT_SPEC.md` and `DATA_NOTES.md`. Code: the server routes, the Android Bluetooth plugin, and the web client's Bluetooth and polling code.
- Data volumes come from the committed files under `data/` (lines and bytes were counted and statuses tallied with Node) and from figures recorded in the docs. No Elasticsearch query was made and no live API call.
- Pricing, free-tier limits, platform behaviour and model sizes come from web sources fetched on 2026-11-10.

---

## 4. What exists today

### 4.1 Architecture

- **Server.** One Node.js service serves both the app and every `/api/*` route, using `node:http` only (`docs/CONTRACT.md:368`). It is deployed to Cloud Run with `--min-instances 0 --max-instances 2 --cpu 1 --memory 512Mi` (`scripts/deploy.sh:105-114`). Routing is in `server/index.mjs:271-306`.
- **Elasticsearch.** Elastic Cloud Hosted 9.5.6 (`docs/CONTRACT.md:7`) is the only data store and does all matching, ranking and filtering (`README.md:73`).
  - Embeddings come from the multilingual E5 small model on the deployment's own ML node, which has 2 vCPU and about 1.2 GB of ML memory. The user accepted that cost (`DECISIONS.md:317`). This replaced the Elastic Inference Service trial, which had started answering 429 (`DECISIONS.md:317`).
  - When embeddings fail, search and matching fall back to keyword matching (`DECISIONS.md:311-312`).
- **Optional external services.**
  - The Google Cloud Natural Language classifier is off by default (`docs/OPERATOR_CHECKLIST.md:16`).
  - Web Push is on only when the VAPID secret exists (`docs/OPERATOR_CHECKLIST.md:15`, `docs/CONTRACT.md:352`).
  - The GitHub import calls `api.github.com`, which allows 60 requests an hour per IP without a token (`docs/CONTRACT.md:391`, `:431`).
- **Clients.**
  - The web app is Vite + Preact + TypeScript (`docs/CONTRACT.md:396`).
  - The Android app is the same web app in a Capacitor shell (`web/capacitor.config.ts:9`, app id `app.conferencecaddie`) plus one Kotlin plugin, `CaddieBle` (`docs/CONTRACT.md:356-364`).
  - The APK is a debug build from GitHub Actions with the Cloud Run URL baked in (`.github/workflows/android-apk.yml:26`, `:56`). The artifact is kept for 14 days (`:70`) and needs a GitHub sign-in to download (`README.md:20`).
  - iOS was not attempted, because of background advertising limits (`DECISIONS.md:292`).
- **Code size (measured).** About 6,540 lines in `server/*.mjs`, and about 14,700 lines of TS/TSX in `web/src`, of which 7,369 are the people screens in `web/src/people/`.
- **The repository was unlicensed when this plan was written.** It is licensed Apache-2.0 since 2026-11-10 (decision 1). The license covers the code and documentation authored here; the schedule snapshots under `data/` keep their owners' terms (see `NOTICE`).

### 4.2 Feature inventory

"Needs shared server" means the feature only works if several users' state meets in one place. "On-device" means it can run with no backend, given a static data bundle.

| # | User-facing feature | Server routes | Indices / inference / external | Needs shared server? | On-device feasible? |
|---|---|---|---|---|---|
| 1 | Conference switcher and list | `GET /api/conferences` (`server/index.mjs:286`) | `caddie-conferences` | No | Yes (static JSON) |
| 2 | Schedule, a day at a time | `POST /api/search` browse mode with `from` paging (`docs/CONTRACT.md:238`) | `caddie-talks` | No | Yes |
| 3 | Talk search: hybrid keyword and semantic, filters, time phrases, "Happening now", events toggle, value-matching chips, ranking drawer | `POST /api/search` (`server/index.mjs:280`) | `caddie-talks` (`semantic_text`, E5), `caddie-facets` | No | Yes. Local BM25 plus local embeddings; `server/phrases.mjs` is rule-based and portable |
| 4 | Offline keyword search | `GET /api/schedule` (`docs/CONTRACT.md:255`) | `caddie-talks` | No | Already on-device (`web/src/offline/OfflineSearch.tsx:56`) |
| 5 | Related talks | `GET /api/related` (`server/related.mjs:79`) | `caddie-talks` kNN | No | Yes; precompute the top 5 per talk in CI |
| 6 | For you (talk suggestions) | `POST /api/recommendations` (`server/recommend.mjs:431`) | `caddie-talks`, plus `circle_count` from `caddie-people` | Only for `circle_count` | Yes, except circle counts |
| 7 | Topic picker: list, type-ahead, suggestions | `GET /api/topics`, `POST /api/topics/suggest` (`server/topics-api.mjs:92`, `:105`) | `caddie-topics`, aggregations on `caddie-talks` | No | Yes; build topics in CI |
| 8 | Interested list ("My schedule") | none | device key `caddie.interested.v1.{slug}` (`docs/CONTRACT.md:406`) | No | Already on-device |
| 9 | Import my schedule (PDF, CSV, ICS, JSON, text) | `POST /api/import/schedule` (`server/import.mjs:755`) | Elasticsearch attachment processor (Tika) through `_ingest/pipeline/_simulate`, then `_msearch` on talks (`docs/CONTRACT.md:316-320`) | No | Yes for ICS, CSV, JSON and text. PDF needs PDFKit on iOS and a library on Android. Office formats would be dropped |
| 10 | Profile: create, update, delete, visibility | `PUT/DELETE /api/people/profile` (`server/people.mjs:1301`) | `caddie-people` (`semantic_text`) | Yes, so others can find it | Editing yes; being findable needs a backend |
| 11 | Import from GitHub | `POST /api/import/github` (`server/import-github.mjs:241`) | `api.github.com`, `caddie-topics` | No | Yes; the device calls GitHub. A venue's shared IP shares the 60-an-hour limit |
| 12 | People to meet, and finding people by what they have built (specificity rule, evidence, reasons) | `POST /api/people/matches` (`server/people.mjs:1302`); ranking in `peopleQuery` (`server/people.mjs:780`) | `caddie-people`, `caddie-people-blocks`, `caddie-topics` | Yes | Ranking could run on a device, but the set of profiles needs a shared store |
| 13 | Talk circles: share per talk, counts, members | `POST /api/circles/counts` and `/members` (`server/people.mjs:1303-1304`) | `caddie-people` | Yes | No |
| 14 | Presence "Around": zone, spot line, GPS bands, hour or day modes | `PUT/DELETE /api/presence` (`server/connect.mjs:734`) | presence fields on `caddie-people`; moderation | Yes | No |
| 15 | Who's around, in-app nudges | matches with `when: around_now`, polled (`docs/CONTRACT.md:400`, `web/src/people/nudges.ts:200`) | `caddie-people` | Yes | No |
| 16 | Ask to talk shop, Wave, meet screen (inbox, accept, decline, found, cancel, spot-me, rendezvous, distance and bearing) | `/api/meet*` (`server/connect.mjs:735-736`, `docs/CONTRACT.md:303-308`) | `caddie-people-meets` | Yes | No |
| 17 | Watch list ("tell me when they're around") | client plus matches | device key `caddie.watch.v1.{slug}` | Yes (presence) | No |
| 18 | Web Push nudges (currently off) | `/api/push/*` (`server/push.mjs:153-154`); the nudge rule runs after a presence write (`docs/CONTRACT.md:349`) | `caddie-people-push`, `caddie-people-nudges`, VAPID, `web-push` | Yes | No |
| 19 | Block, unblock, list blocks | `/api/people/block(s)` (`server/connect.mjs:732-733`) | `caddie-people-blocks` | Yes | No |
| 20 | Report, hide after two reports, held lines, operator CLI | `POST /api/people/report` (`server/report.mjs:164`, `docs/CONTRACT.md:336-340`) | `caddie-people-reports`, `caddie-people-rules` (percolator), classifier (off) | Yes | No |
| 21 | Filter on spot, note and spot-me lines | `server/moderation.mjs:117` (wordlist), `:272` (`moderate`) | `config/moderation-words.json`, percolator, classifier | Enforcement needs a server | A client-side check is possible but can be bypassed |
| 22 | Bluetooth "right near you" (Android only) | `PUT /api/presence` with `ble: true`, `POST /api/presence/ble/rotate`, `POST /api/presence/sightings` (`server/ble.mjs:175-176`) | `ble_token` on `caddie-people` | Yes; the server resolves tokens | Peer-to-peer is possible (section 6.1), but tier 1 excludes it by definition |
| 23 | People I met, settings, theme, install, zone QR deep link | device | device storage | No | Yes. The deep link only does its full job with presence |
| 24 | Sample and demo profiles (132) | seeded | `data/samples/*.json` | Yes (directory) | No |
| 25 | Expiry and purge | hourly server timer; `npm run people:purge` (`docs/CONTRACT.md:170`) | every `caddie-people*` index | Yes | Not applicable |

### 4.3 Data volumes (from committed files and docs; Elasticsearch not queried)

- **Conferences.** The Linux Foundation list held 62 upcoming events (`DATA_NOTES.md:9`). The committed `data/*/conference.json` files show 4 searchable conferences and 58 unavailable ones: 42 with `no_schedule_url`, 15 with `no_sched_config` and 1 with `time_zone_missing`.
- **Talks per searchable conference.**

  | Conference | Sessions | Talks (`kind: talk`) | Source |
  |---|---|---|---|
  | KubeCon North America 2026 | 600 | 484 | `DATA_NOTES.md:51` |
  | MCP Dev Summit Nairobi | 60 | 46 | `DATA_NOTES.md:52` |
  | PyTorch Day Japan | 19 | 13 | `DATA_NOTES.md:53` |
  | gRPConf India | 38 | 32 | measured |

  The talks index holds 717 documents in all (`DECISIONS.md:320`). KubeCon's `talks.ndjson` is 1,312,504 bytes. A talk's title plus abstract averages 952 characters on KubeCon and 822 to 1,120 characters elsewhere (measured).
- **Topics.** At most 150 per conference (`docs/CONTRACT.md:142`); KubeCon has 96 (`DECISIONS.md:256`).
- **People.**
  - 132 profiles are seeded: 30 samples, 100 dummies and 2 demo profiles (`data/samples/*.json`, measured).
  - Each profile is about 0.5 to 1.5 KB of JSON.
  - The number of real profiles was not queried. ASSUMPTION: tens.
  - KubeCon has about twenty thousand attendees (`docs/FIND_AND_CONNECT_SPEC.md:9`).
- **Talk embeddings.** 484 talks × 384 dimensions is 743 KB in float32 or 186 KB in int8.

### 4.4 Request profile of today's client

These rates decide whether a free tier can carry the people features.

| Activity | Rate | Source |
|---|---|---|
| Meet inbox poll while the app is open | every 20 s | `web/src/people/connect.ts:10` |
| Nudge check, piggy-backed on each inbox poll (one `around_now` request) | every 20 s | `web/src/people/nudges.ts:200` |
| "Who's around" refresh while visible | every 60 s | `docs/CONTRACT.md:400` |
| Meet screen poll | every 10 s | `web/src/people/MeetScreen.tsx:19` |
| Bluetooth sightings upload | up to every 10 s per device | `docs/CONTRACT.md:360`, `BleConstants.kt:18` |
| Bluetooth token rotation | every 10 min, one network call each | `docs/CONTRACT.md:359` |

`BleConstants.kt` and `BleService.kt` are in `web/android/app/src/main/java/app/conferencecaddie/ble/`.

### 4.5 The Android background Bluetooth failure observed on 2026-11-09

The symptom was: no token rotation in the background, tokens expire after 10 minutes, and discovery stops silently until the app is reopened. The code explains it. This was inferred from the code and was not verified on a device.

1. **Rotation lives in the web layer.** It is a `window.setTimeout` that fetches a new token 20 seconds before `rotate_at` (`web/src/people/ble.ts:34`, `:244-248`, `:251-280`). In a backgrounded WebView the JavaScript timers are throttled or suspended.
2. **The native side gives up first.** The native service stops itself after 11 minutes without a fresh token (`BleConstants.kt:24`, `BleService.kt:272-276`). The server stops resolving a token after 10 minutes (`docs/CONTRACT.md:359`).
3. **Fixing rotation alone would not be enough.** Uploading sightings and showing the notification are also JavaScript (`web/src/people/ble.ts:282-294`, `:310`). The native service only forwards sightings to the web layer (`BleService.kt:155`).
4. **Presence has the same weakness.** In hour mode, presence also turns itself off from a JavaScript timer (`web/src/people/presence.ts:25`, `:272`).

**Design consequence.** Every background step must run in native code: token rotation, scanning, sightings upload and notification. Deriving tokens on the phone (section 8.1) removes the network call from rotation entirely.

---

## 5. Platform facts that constrain the design

### 5.1 iOS Bluetooth in the background

- **What an iPhone can advertise at all.** `CBPeripheralManager.startAdvertising` accepts only the local-name and service-UUID keys, in 28 bytes in the foreground. There is no service data and no manufacturer data ([Apple: peripheral best practices](https://developer.apple.com/library/content/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/BestPracticesForSettingUpYourIOSDeviceAsAPeripheral/BestPracticesForSettingUpYourIOSDeviceAsAPeripheral.html)). An iPhone therefore cannot put a token in its advertisement. Other phones must read the token over a GATT connection.
- **What changes in the background** ([Apple Core Bluetooth background guide](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html)):
  - The local name is not advertised.
  - Service UUIDs move to an "overflow" area that "can be discovered only by an iOS device that is explicitly scanning for them".
  - Advertising and scanning become less frequent.
  - Repeated discoveries are coalesced.
  - A woken app has "around 10 seconds" to work.
  - State restoration relaunches an app that the system terminated.
- **Android cannot decode the overflow area.** Its "format … is not documented", and background advertising is "best effort" ([Apple forum 814450](https://developer.apple.com/forums/thread/814450)). Apple advises connecting and reading a characteristic instead ([Apple forum 837516](https://developer.apple.com/forums/thread/837516)).
- **Two backgrounded iPhones may not find each other** ([Apple forum 814450](https://developer.apple.com/forums/thread/814450), [Apple forum 773100](https://developer.apple.com/forums/thread/773100)). This is the largest technical risk. Phase 0 measures it.
- **Prior art.** The Herald protocol solved background iOS↔Android and iOS↔iOS detection by scanning first and then reading a GATT characteristic ("scan, then interrogate") ([Herald](https://theheraldproject.github.io/protocol)). ASSUMPTION: its license and maintenance status are unchecked.

### 5.2 Android Bluetooth in the background

- **Scanning and connecting** work while the app is not visible, as long as the process is alive. A `PendingIntent` scan can wake a dead process ([Android: BLE in the background](https://developer.android.com/develop/connectivity/bluetooth/ble/background)).
- **Advertising** has no `PendingIntent` form, so continuous advertising needs a foreground service. ASSUMPTION; this matches the current design.
- **Foreground service type.** `connectedDevice` requires a Bluetooth runtime permission and is documented as "Interactions with external devices…" ([service types](https://developer.android.com/develop/background-work/services/fgs/service-types)). Since Android 12 a foreground service cannot be started from the background, so it must start while the app is visible ([BLE background](https://developer.android.com/develop/connectivity/bluetooth/ble/background)). `specialUse` is the fallback type.
- **Google Play declaration.** Play requires a declaration of the foreground service type with a demonstration video ([Play help](https://support.google.com/googleplay/android-developer/answer/13392821)).
- **Reusable today.** The current service already uses Bluetooth 5 extended advertising, scanning filtered by UUID, and `connectedDevice` (`BleService.kt:287-292`, `:332`, `:348`, `:411`, `:417`; `web/android/app/src/main/AndroidManifest.xml:34`).

### 5.3 Cross-platform peer-to-peer frameworks

- **Google Nearby Connections is now cross-platform.** Google states it "is available for Android and iOS, and enables communication between the two platforms" ([Google Nearby](https://developers.google.com/nearby)); see also the [Swift guide](https://developers.google.com/nearby/connections/swift/get-started).
- **It is still not used here.** ASSUMPTION: it does not discover in the iOS background, and on Android it depends on Google Play services.
- **MultipeerConnectivity is Apple-only.** ASSUMPTION.
- **Conclusion: raw BLE**, meaning a fixed service UUID plus a GATT read.

### 5.4 On-device search and embeddings

- **Model choices** (ONNX files on Hugging Face):

  | Model | int8 size | Languages | Source |
  |---|---|---|---|
  | `multilingual-e5-small` (today's server model) | 118 MB (470 MB fp32) | multilingual | [files](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx) |
  | `bge-small-en-v1.5` | 34 MB | English | [files](https://huggingface.co/Xenova/bge-small-en-v1.5/tree/main/onnx) |
  | `all-MiniLM-L6-v2` | 23 MB | English | [files](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx) |

- **Latency data points.** EmbeddingGemma reports under 15 ms on EdgeTPU and under 200 MB of RAM ([Google](https://developers.googleblog.com/en/introducing-embeddinggemma/)). MediaPipe's Universal Sentence Encoder takes 18.21 ms on a Pixel 6 CPU and runs on Android and iOS ([MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/text/text_embedder)).
- **Runtimes.**
  - ONNX Runtime Mobile runs on Android and iOS ([ORT](https://onnxruntime.ai/docs/get-started/with-mobile.html)).
  - transformers.js runs the same ONNX models in Node with the `feature-extraction` pipeline ([docs](https://huggingface.co/docs/transformers.js/index)), so CI can embed talks with the model the phones use.
  - Cloudflare Workers AI hosts `@cf/baai/bge-small-en-v1.5` ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).
  - ASSUMPTION: a `bge-small` query takes 20 to 100 ms on a mid-range phone with native ORT.
- **Storage and search.**
  - The `androidx.sqlite` bundled driver compiles SQLite with FTS5 ([build file](https://android.googlesource.com/platform/frameworks/support/+/f66fa79d19e5874f0afaa6868363c69ecf851cf2/sqlite/sqlite-bundled/build.gradle)) and runs on Android and iOS from Kotlin Multiplatform ([androidx KMP SQLite](https://developer.android.com/kotlin/multiplatform/sqlite)).
  - `sqlite-vec` is pre-v1 ([repo](https://github.com/asg017/sqlite-vec)).
  - At these volumes, brute-force int8 cosine is enough: KubeCon needs about 186,000 multiply-adds per query. No vector extension is needed.

---

## 6. Architecture options considered

### 6.1 Option A: fully on-device and peer-to-peer (rejected as the default; kept as a possible later add-on)

**How it would work:**
- Static data and on-device search, as in tier 1.
- Bluetooth "badge cards" exchanged phone to phone over GATT. A card would carry a headline, topics and int8 vectors, and each phone would match cards locally.

**What it does well:** proximity works with no backend at all.

**Why it is not the default:**
- A card whose content is stable can be linked across token rotations, so any phone in radio range can harvest who was where. That breaks "Nothing about where you were is kept" (`README.md:57`).
- Without a server there are no symmetric blocks, and no reports that hide a person for everyone.
- Conference-wide people search, zones and asks across the venue are lost.
- The user has defined tier 1 as having no interest-based peer finding. Peer finding therefore belongs to the backend tiers.

### 6.2 Option B: today's server ported unchanged to a free tier (rejected)

Today's polling client and server-resolved tokens cost 118% to 2,358% of the Workers free request allowance at KubeCon scale (section 7.5).

Firebase Spark fits worse:
- It has no Cloud Functions, so there is no trusted code ([Firebase pricing](https://firebase.google.com/pricing)).
- Firestore allows 50,000 reads a day, against roughly 250,000 for a mid-adoption directory load.
- The Realtime Database allows only 100 simultaneous connections.

### 6.3 Option C, reshaped into tiers (recommended)

Static talks and on-device search everywhere. A backend only for the people features, and only in tiers 2 and 3. Bluetooth tokens are derived on the phone and resolved by the server. Section 7 describes the tiers.

---

## 7. Recommended architecture: pluggable deployment tiers

### 7.1 The three tiers

| Tier | What the operator runs | Recurring cost | Who it is for |
|---|---|---|---|
| **1. Demo** | A GitHub repository (a fork works) with GitHub Pages serving `capabilities.json`, `conferences.json` and one content-hashed bundle per conference. A scheduled GitHub Action builds them. Optionally the web app as a demo page. | $0 (GitHub Free) | Anyone trying the apps, and conferences with no operator |
| **2. Free backend** | Tier 1's static bundles, plus one Cloudflare Worker, one SQLite-backed Durable Object per conference, and D1 for the cross-conference registry and the moderation queue | $0 on the Workers Free plan, within the limits in section 7.5 | Operators who want the people features without paying |
| **3. Paid backend** | Today's Cloud Run service and Elastic Cloud deployment (`docs/OPERATOR_CHECKLIST.md`), plus three small additions: `GET /api/capabilities`, derived Bluetooth tokens, and native push | Elastic Cloud subscription, including the ML node; Cloud Run | Operators who want Elasticsearch ranking, the percolator, the classifier and no free-tier ceilings |

All tiers serve talk features from the same static bundle format, searched on the device. This keeps talk features identical across tiers and works offline. Tier 3 may still advertise server-side talk search as an optional capability.

### 7.2 How the apps find out what a backend can do

- **Backend URL.** The URL is baked in at build time; decision 6 in section 14 sets which default store builds ship with. It can be changed in Settings → Server, or with an operator deep link or QR code (`caddie://connect?url=…`). A link must use https. The app shows a confirmation screen naming the origin and warns when it is not the official backend, and it never switches backends automatically from a link. Device secrets (`profile_id`, `secret`, `docs/CONTRACT.md:279`) are stored per backend origin, so one backend's secret is never sent to another.
- **Capabilities document.** It is `GET {backend}/api/capabilities` in tiers 2 and 3, and the static file `capabilities.json` in tier 1. A backend without it (today's tier 3 server, before Phase 1) is treated as legacy with the full current feature set.
- **Illustrative shape.** This is not a final contract:

```json
{
  "api_version": 1,
  "tier": "demo | free | paid",
  "talks": { "bundle_base": "https://<owner>.github.io/<repo>/bundles/", "server_search": false },
  "people": { "enabled": true, "semantic": "server | client | off", "presence": true, "gps_bands": true,
              "meets": true, "circles": true, "reports": true, "live": "websocket | poll" },
  "ble": { "mode": "derived-v1 | none", "service_uuid": "e52c391c-b926-4856-9a38-d46c3c10c733",
           "near_rssi": -75, "window_s": 600, "sightings_min_interval_s": 60 },
  "push": { "apns": false, "fcm": false, "webpush": true },
  "imports": { "github": "device | server", "schedule": "device | server" }
}
```

- **Effect on the app.** Each flag shows or hides whole screens and controls. Tier 1 hides the People tab and opens on For you. `ble.near_rssi` and `sightings_min_interval_s` replace the server-side tuning knob `BLE_NEAR_RSSI` (`DECISIONS.md:295`), so operators can tune them without an app update.
- **Native push and the APNs and FCM keys.** Only a backend that holds the publisher's keys can push to the published apps. APNs authenticates with the key of the Apple team that signs the app, and FCM with the Firebase project the app is registered to. ASSUMPTION; this is standard platform behaviour. Third-party tier 2 or 3 operators using the official apps therefore get `push.apns: false` and `push.fcm: false`, and fall back to in-app nudges and Bluetooth local notifications. Decision 3 in section 14 is not to build a push gateway.

### 7.3 Shared contracts, defined once and implemented by every tier

1. **Talk bundle v1.** Each conference bundle holds talks, topics, facets, int8 `bge-small-en-v1.5` vectors, the top 5 related talks per talk, and a model id. It is built by a GitHub Action that:
   - runs `node scripts/ingest.mjs --dry-run`, which fetches, builds and writes files without indexing (`scripts/ingest.mjs:10`, `:324`);
   - runs a Node port of the topics builder (`docs/CONTRACT.md:141-143`), which today uses an Elasticsearch analyzer;
   - builds facets and embeds the talks with transformers.js.
2. **People API v1.** The routes and shapes of `docs/CONTRACT.md:277-360`, frozen as the plug. Tier 2 implements the same routes and shapes, so the apps cannot tell the tiers apart except through capabilities.
3. **Bluetooth derived-token protocol v1** (section 8.1).
4. **Golden fixtures.** Byte-exact token vectors, bundle samples and expected ranking outputs, run in the apps' common tests and in each backend's tests.

### 7.4 Capability matrix per tier

| Feature | Tier 1 Demo | Tier 2 Free (Cloudflare) | Tier 3 Paid (Cloud Run + Elastic) |
|---|---|---|---|
| Conference list, schedule, interested list | Yes | Yes | Yes |
| Talk keyword search with filters, time phrases, "Happening now", chips | Yes (on device) | Yes (on device) | Yes (on device; server search optional) |
| Talk semantic search, For you, related talks | Yes (on-device `bge-small`) | Yes | Yes |
| Topic picker and suggestions | Yes | Yes | Yes |
| Schedule import (ICS, CSV, JSON, text; PDF per decision 8) | Yes (on device) | Yes (on device) | Yes (device or server Tika) |
| GitHub import | Yes (device calls GitHub) | Yes (device) | Yes (server with token, or device) |
| Profile (stored locally; feeds For you) | Local only | Published to the backend | Published |
| People search by what they have built | No | Yes. Ranking is RRF over topics, cosine and FTS5; vectors per `people.semantic` | Yes (Elasticsearch RRF with E5) |
| Specificity rule, evidence passages, reasons | No | Yes | Yes |
| Talk circles and `circle_count` | No | Yes | Yes |
| Presence zones, "Who's around", watch list | No | Yes (live over WebSocket) | Yes (polling today; WebSocket optional) |
| GPS bands; distance and bearing inside a meet | No | Yes (computed in the Durable Object) | Yes |
| Ask, Wave, meet screen | No | Yes | Yes |
| Block (symmetric), report with hiding after 2, held lines | No | Block and report: yes. Hold: wordlist only, no classifier | Yes (percolator; classifier optional) |
| Text filter on lines others read | Not applicable | Wordlist (`config/moderation-words.json`) | Wordlist, percolator, optional classifier |
| Bluetooth "right near you" | No | Yes (derived-v1; sightings interval set by the operator) | Yes (derived-v1; 10 s interval possible) |
| Native push (asks, zone nudges with the app closed) | No | Official backend: yes via FCM (and APNs through FCM). Third-party: no | Official backend: yes (APNs over Node `http2` plus FCM). Third-party: no |
| Web Push for the web app | No | Yes (VAPID) | Yes (existing) |
| Sample profiles | Local demo cards (optional) | Seeded | Seeded |
| Works offline after the first sync | All features | Talk features | Talk features |

### 7.5 Does tier 2 fit one conference inside the free allowances?

Every input here is an ASSUMPTION chosen to bracket KubeCon:
- 20,000 attendees (`docs/FIND_AND_CONNECT_SPEC.md:9`).
- 100, 500 or 2,000 profiles (low, mid and high adoption).
- 45 minutes of foreground use per user per day.
- 40% of users run Bluetooth for 6 hours a day.

**Today's client on a lift-and-shift port.** Each user makes 315 foreground requests a day: 7 a minute (inbox 3, nudge check 3, Around refresh 1) for 45 minutes, per section 4.4. Each Bluetooth user makes 2,160 sightings requests a day: 6 a minute for 6 hours, since a busy venue's 10-second window is rarely empty (`BleService.kt:155`).

| Adoption | Requests per day | Share of Workers Free (100,000/day) |
|---|---|---|
| Low | 31,500 + 86,400 = 117,900 | 118% |
| Mid | 157,500 + 432,000 = 589,500 | 590% |
| High | 630,000 + 1,728,000 = 2,358,000 | 2,358% |

**The tier 2 design.**
- Live updates use one hibernatable WebSocket per foreground session. Incoming messages are billed 20:1 ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- Each user makes about 6 connects and 5 HTTP writes a day, which is about 11 Worker requests and about 12.5 Durable Object requests.
- Rotation needs no requests, because tokens are derived (section 8.1).
- Sightings are sent at most once per `sightings_min_interval_s`, and only for tokens not yet resolved in the current window.

| Adoption | 60 s interval (≤ 360 sightings a day per Bluetooth user) | 300 s interval (≤ 72 a day) | 600 s interval (≤ 36 a day) |
|---|---|---|---|
| Low (40 Bluetooth users) | 1,100 + 14,400 = 15,500 (16%) | 1,100 + 2,880 = 3,980 (4%) | 2,540 (3%) |
| Mid (200) | 5,500 + 72,000 = 77,500 (78%) | 5,500 + 14,400 = 19,900 (20%) | 12,700 (13%) |
| High (800) | 22,000 + 288,000 (over) | 22,000 + 57,600 = 79,600 (80%) | 50,800 (51%) |

The figures are Worker requests a day. Durable Object requests are about the same and have their own 100,000 a day allowance. Both reset at 00:00 UTC.

Reading the table:
- On the free tier, a Bluetooth nudge can arrive up to one interval after two people meet. The operator chooses the interval: 60 s for small events, 300 s for a KubeCon-sized one.
- Tier 3, which is paid, can keep today's 10 s.
- Other allowances have headroom at high adoption:
  - Durable Object rows written are dominated by presence changes, about 20,000 a day against 100,000.
  - Rows read stay low because the directory is held in memory after a wake.
  - Workers AI, when `people.semantic` is `server`, needs about 5,000 neurons for 2,000 profiles × 3 fields × 150 tokens × 3 edits, against 10,000 a day ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).
- **Vectorize is not used.** Queried dimensions count stored vectors on every query, which caps it at about 2,500 queries a day here ([Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)).
- **If Durable Objects left the free plan**, a D1-only fallback with 60-second polling would cost about 90 requests per user a day. That fits low and mid adoption (59% at mid with a 300 s sightings interval) but not high.

### 7.6 Free-forever check of every free service in the design

None of these services is contractually free forever. The table records what each source says and flags any uncertainty about permanence.

| Service | Used for | Free allowance | What the source says about permanence | Flag |
|---|---|---|---|---|
| GitHub Pages (public repository, GitHub Free) | Tier 1 bundles and demo web app | 1 GB site, 100 GB a month soft bandwidth ([limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)) | Included in GitHub Free for public repositories; no time limit stated ([GitHub plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)) | A plan feature, not a trial. Low risk |
| GitHub Actions, standard runners, public repository | Bundle builds; Android and iOS CI (macOS runners) | "free and unlimited" on public repositories ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) | Stated as free; no time limit | Low risk |
| GitHub Releases | APK and model downloads | No cap stated (ASSUMPTION) | Not stated | Verify |
| Cloudflare Workers Free | Tier 2 API | 100,000 requests a day; 10 ms CPU ([limits](https://developers.cloudflare.com/workers/platform/limits/)) | "By default, users have access to the Workers Free plan"; no end date and no "forever" wording ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | Uncertain: no permanence promise. A standing plan, not a trial |
| Durable Objects on Workers Free (SQLite only) | Tier 2 live state per conference | 100,000 requests a day; 13,000 GB-s; 5M rows read; 100,000 rows written; 5 GB ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)) | Free-plan access began 2025-04-07 ([changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/)); no permanence wording | **Uncertain and recent.** The D1-with-polling fallback is designed in |
| D1 Free | Tier 2 registry and moderation queue | 5M rows read and 100,000 written a day; 5 GB ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)) | No permanence wording | Uncertain: no permanence promise |
| Workers AI free allocation | Optional server-side people vectors | 10,000 neurons a day ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)) | Called a "free allocation"; no permanence wording | **Uncertain.** Tier 2 defaults to `people.semantic: client`, so this is optional |
| Firebase Spark: FCM only | Native push from the official tier 2 backend | FCM "No-cost"; Spark needs "No payment method" ([pricing](https://firebase.google.com/pricing)) | Firebase removed Cloud Storage from Spark for new projects from 2024-10-30 ([FAQ](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)), a precedent for Spark features changing | **Uncertain.** Push is a capability flag, and the app works without it |
| Android limited-distribution account | Optional free registration (20 devices) | 20 devices, email only ([Android blog](https://developer.android.com/blog/posts/android-developer-verification-rolling-out-to-all-developers-on-play-console-and-android-developer-console)) | Launched globally in August 2026; no permanence wording | New programme; may change |
| Neon Free (not used; noted because the maintainer's stack is Postgres) | none | 1 GB per project, 100 CU-hours a month ([pricing](https://neon.com/pricing)) | "permanent (not a trial); no credit card required" | The only explicit permanence statement found |
| Cloudflare sign-up without a card | Tier 2 account | not applicable | Reported by third parties ([freetier.co](https://freetier.co/directory/products/cloudflare-workers)) (ASSUMPTION) | Verify at sign-up |

Excluded because they are not free forever, or would cost the maintainer money:
- Elastic Cloud trials.
- Cloud Run's free tier, which needs a billing account. ASSUMPTION.
- Google Play's $25 one-time fee.

---

## 8. Bluetooth design (tiers 2 and 3)

### 8.1 Derived tokens (protocol v1)

1. **Key issue.** When a person turns Bluetooth on (`PUT /api/presence` with `ble: true`), the server generates a random `presence_nonce` and stores it on the profile, replacing the previous one, so a nonce is valid for one presence session only. The device key is derived, not stored: `ble_key = HMAC-SHA256(ble_master_secret, "caddie-ble-key-v1" ‖ profile_id ‖ presence_nonce)`. `ble_master_secret` is a server secret (Secret Manager on tier 3, a Worker secret on tier 2). The key is returned to the device once, kept in the Android Keystore or the iOS Keychain, and never stored by the server, which recomputes it to resolve tokens. Its expiry is `presence_until`.
   - **Threat model.** A leak of `ble_master_secret` lets an attacker who also has profile ids and nonces link tokens to people. A database leak alone does not, because the nonce is harmless without the master secret. Data export must never include material derived from `presence_nonce`.
2. **Token.** `token_w = first 16 bytes of HMAC-SHA256(ble_key, "caddie-ble-v1" ‖ uint64be(w))`, where `w = floor(unix_seconds / window_s)` and `window_s` is 600. The phone computes this natively at any moment, including inside an iOS background read wake, with no network call. The rotate route becomes unnecessary, and so does the 11-minute self-stop that caused the failure in section 4.5.
3. **Resolution.**
   - On a sightings request, the server matches the reported tokens against `token_{w-1}`, `token_w` and `token_{w+1}` (allowing for clock skew in both directions), recomputing each live user's key from the master secret and nonce of the conference's live Bluetooth users.
   - It caches that map once per window. Tier 2 caches it in Durable Object memory; tier 3 in each instance, built from one query.
   - It then applies the existing ranking and the strong-match rule (`server/ble.mjs:157`, `docs/CONTRACT.md:360`).
4. **Privacy.** Nothing about the person goes over the air. Tokens cannot be linked across windows without the key. The server stores no sightings. All of this is unchanged from today (`DECISIONS.md:294`).
5. **Over the air.**
   - Android keeps extended advertising with the token as service data, because a legacy advertisement cannot fit a 128-bit UUID plus 16 bytes (`DECISIONS.md:296`).
   - Every platform also serves a GATT `token` characteristic.
   - iPhones advertise only the service UUID, so peers connect and read the token.
   - Android finds backgrounded iPhones by filtering on Apple manufacturer data (company 0x004C) at or above the RSSI threshold, then connecting and checking for the service. Negative results are cached per address.
   - ASSUMPTION: iPhones can receive Android's extended advertisements; otherwise iPhones read the GATT characteristic.
6. **Sightings upload.** It is sent natively: from the Android foreground service, or within the iOS Bluetooth wake. A result becomes a local notification without the JavaScript layer. At most one notification per person per day and 3 an hour, as today (`docs/CONTRACT.md:349`).
7. **Compatibility.** Today's Capacitor APK uses the rotate route. Both modes are served until the old APKs are retired. The capabilities document advertises `ble.mode`.

### 8.2 Risks specific to Bluetooth

- **Two backgrounded iPhones.** Discovery may fail. Mitigations: an Android phone nearby helps (Herald's pattern); "keep the app open" guidance; Phase 0 measurement.
- **Crowd density.** Interrogating hundreds of Apple devices costs battery and connection slots. Mitigations: the RSSI gate, a per-address cache and a cap on connections per minute, with battery measured in Phase 3.
- **Scan permission side effect.** `neverForLocation` scanning may filter out some advertisement formats. ASSUMPTION: Apple's are delivered; Phase 0 tests it.
- **Play review (only if Play is reconsidered).** The `connectedDevice` declaration may not be accepted; `specialUse` is the fallback.

---

## 9. Distribution

### 9.1 iOS (the Apple Developer Program is already paid)

- **What membership unlocks.** Certificates, App Store Connect, TestFlight and Xcode Cloud are available only to members ([compare memberships](https://developer.apple.com/support/compare-memberships/)).
- **TestFlight limits.** 100 internal testers and 10,000 external testers. Each build is testable for 90 days ([TestFlight](https://developer.apple.com/testflight/)).
- **Capabilities.** Remote push (APNs) and the `bluetooth-central` and `bluetooth-peripheral` background modes are available. Push requires paid membership ([Apple forum 768748](https://developer.apple.com/forums/thread/768748)).
- **Review risk: background modes.** The Bluetooth modes need a justification in the review notes.
- **Review risk: user-generated content.** An app that connects to user-chosen servers carrying user-generated content relies on each operator's moderation. The app's report and block controls must work against every tier. ASSUMPTION: this falls under Apple's user-generated content rules in the [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
- **Fees for other operators.** The membership is 99 USD per year ([Apple](https://developer.apple.com/programs/enroll/)). Operators who want their own iOS build, or native push to their own build, need their own membership. With the official app they get tiers 1 to 3 without push (section 7.2).

### 9.2 Android

- **APK on GitHub Releases: $0.**
  - From 2026-09-30, apps must be registered by verified developers to install on certified devices in Brazil, Indonesia, Singapore and Thailand. Global rollout is planned for "2027 and beyond". Unregistered apps still install through ADB or the "advanced flow" ([Android blog, updated 2026-09-29](https://developer.android.com/blog/posts/android-developer-verification-rolling-out-to-all-developers-on-play-console-and-android-developer-console)).
  - The free limited-distribution account covers up to 20 devices.
  - Whether full verification outside Play carries a fee is unconfirmed. Third parties cite $25 ([Doply](https://www.doply.io/en/blog/android-developer-verification-explained)) (ASSUMPTION).
- **Google Play: 25 USD one time, so not free under the maintainer's definition** ([Play fee](https://support.google.com/googleplay/android-developer/answer/6112435)). New personal accounts must first run a closed test with 12 testers opted in for 14 consecutive days ([Play testing](https://support.google.com/googleplay/android-developer/answer/14151465)). A foreground-service declaration is also required.
- **F-Droid: $0.** It requires a FOSS license, builds from source, and does not allow Firebase or Google Play Services ([F-Droid policy](https://f-droid.org/docs/Inclusion_Policy/)). An F-Droid build therefore ships with `push.fcm` off. The repository is Apache-2.0 since 2026-11-10 (decision 1), which satisfies the FOSS requirement. The F-Droid build is a separate Gradle flavor with no Firebase or Google Play Services; it ignores `push.fcm` and uses in-app and local notifications only.
- **Release signing.** CI currently signs with a debug key on a fresh runner each time, and no keystore is cached (`.github/workflows/android-apk.yml:56`). ASSUMPTION: every build therefore has a different signature and cannot update the previous one. A stable release keystore stored as a GitHub secret fixes this at $0.

---

## 10. Native stack recommendation

### 10.1 The candidates

| | Kotlin Multiplatform core + Compose Multiplatform UI (recommended) | Kotlin Multiplatform core + Compose (Android) and SwiftUI (iOS) | Two native apps: Kotlin + Compose, Swift + SwiftUI |
|---|---|---|---|
| Shared code | Ranking, search, bundle reader, API client, capabilities, token derivation, sightings batching, storage, and UI | Everything except UI | None |
| Languages to learn | Kotlin, plus a little Swift for platform modules | Kotlin and SwiftUI | Kotlin and Swift, each in depth |
| iOS look and feel | Compose for iOS has been stable since 1.8.0, with UIKit and SwiftUI interop ([JetBrains](https://blog.jetbrains.com/kotlin/2025/05/compose-multiplatform-1-8-0-released-compose-multiplatform-for-ios-is-stable-and-production-ready/)). It draws its own widgets rather than UIKit's | Native SwiftUI widgets | Native |
| Ranking parity across platforms | One implementation and one test suite | One implementation | Two implementations that can drift |
| Bluetooth | Peripheral and central roles are platform code in both stacks; Kable is central-only ([Kable](https://github.com/JuulLabs/kable)). Token derivation, batching and the protocol are common code | Same | Everything twice |
| Storage | `BundledSQLiteDriver` with FTS5 on both platforms ([androidx](https://developer.android.com/kotlin/multiplatform/sqlite)) | Same | Room on Android; GRDB or system SQLite on iOS |
| Embeddings | An `Embedder` interface in common code. Android implements it with the ORT AAR; iOS implements it in Swift with ORT and injects it at start-up | Same | Separate code on each platform |
| Relative effort | L | XL | XL+ |

### 10.2 Why Kotlin Multiplatform with Compose Multiplatform, for one JavaScript/TypeScript developer

1. **One new language for almost all of the code.** Kotlin's coroutines, lambdas, data classes and null safety map onto the async/await and type-driven TypeScript the maintainer already writes. Swift is confined to about three platform modules: Core Bluetooth, notifications and APNs registration, and the ONNX Runtime bridge.
2. **Compose matches the maintainer's React/Preact experience.** Composable functions, state hoisting and recomposition correspond to components, props and state, and re-rendering. About 14,700 lines of TS/TSX UI have to be recreated in any native stack. With Compose Multiplatform they are recreated once rather than twice.
3. **Matching must behave identically on both platforms.** The specificity rule, reciprocal rank fusion, time phrases, the BM25 leg, token derivation and the sightings rules are product rules. One implementation with golden fixtures keeps an Android user and an iPhone user from seeing different matches for the same profile.
4. **The platform work is unavoidable and stays small.** The Bluetooth peripheral role, background modes and notifications need platform code in every stack. Kotlin Multiplatform does not add to that work; it removes the duplication around it.
5. **Risks.**
   - Kotlin/Native and Xcode build friction.
   - Swift-only APIs do not appear directly in Kotlin. The fix is to define interfaces in Kotlin and implement them in Swift.
   - On iOS the UI is drawn by Compose, not UIKit.

   If the maintainer wants UIKit-native screens on iOS, the fallback is the second column: SwiftUI over the same core, at the cost of a second UI codebase.
6. **Alternatives not recommended.**
   - **Two independent native apps:** every feature and every ranking rule written twice.
   - **React Native or Flutter:** not native UI toolkits, and every screen is rewritten anyway.
   - **Keeping the Capacitor shell:** cheapest, and it is what runs today. It is not what the maintainer asked for. It remains a fallback for tier 1 on the web.

### 10.3 Shape of the native code (illustrative)

- **`shared/commonMain`.**
  - Model types and the `kotlinx.serialization` contract.
  - Ktor client (HTTP and WebSocket) and the capabilities resolver.
  - Bundle downloader and FTS5 store.
  - WordPiece tokenizer for `bge-small`, checked against transformers.js tokens in tests.
  - BM25 + cosine + RRF search, port of `peopleQuery` for client-side checks, time phrases ported from `server/phrases.mjs`, and the wordlist ported from `server/moderation.mjs:117`.
  - Token derivation and sightings batching.
  - Interfaces for `Embedder`, `BleRadio`, `Notifier` and `SecureStore`.
- **`androidMain`.** `BleRadio` built from today's `BleService.kt` (foreground service, advertiser, scanner, GATT server and client), Keystore, notifications, ORT and FCM (official builds only).
- **`iosMain` plus Swift.** Core Bluetooth central and peripheral with state restoration, Keychain, `UNUserNotificationCenter`, APNs registration, and ORT through Swift.
- **`composeApp`.** The screens: conference switcher, People (capability-gated), For you, Search, Interested, Profile, Settings with Server.

---

## 11. Recommendation (summary)

1. **Adopt the three pluggable tiers**, with one capabilities document and three shared contracts: the talk bundle, People API v1 and derived Bluetooth tokens v1.
2. **Build the apps** with a Kotlin Multiplatform shared core and Compose Multiplatform UI, plus platform modules in Kotlin and Swift.
3. **Default to the live tier 3 server until the official tier 2 passes its exit criteria, then switch to tier 2; tier 1 is the fallback** (decision 6). Keep tier 3 working for operators who pay.
4. **Use `bge-small-en-v1.5`** (34 MB int8) for talk embeddings in CI and on devices. Tier 2 people vectors are computed on the client by default (`people.semantic: client`), with Workers AI as an optional upgrade, because the Workers AI allocation has no permanence wording.
5. **Fix the Android background failure** through the derived-token protocol and native sightings handling.

---

## 12. Phased plan

There are no dates or deadlines; each phase ends at its exit criteria. Phases 3 and 4 can run in parallel worktrees once Phase 1's contracts are frozen.

### Phase 0: decisions and spikes

**Deliverables:**
- The decisions in section 14, recorded on 2026-11-10.
- **S1, Bluetooth.** Two Android phones and two iPhones (the iPhones on TestFlight builds) run the derived-token loop: advertise or serve, scan, read over GATT, resolve against a stub server. Measured for Android↔Android, Android↔iPhone and iPhone↔iPhone, in the foreground, background and locked, at 1, 3 and 10 metres. Also tests whether iPhones receive Android's extended advertisements.
- **S2, embeddings.** `bge-small-en-v1.5` int8 through ORT on both platforms: median and p95 latency and memory, and ranking agreement with Elasticsearch on the queries in `scripts/smoke.mjs`.
- **S3, root cause.** Confirm the section 4.5 cause on a device with `adb logcat`.
- **S4, preconditions.**
  - License: done. Apache-2.0 since 2026-11-10 (decision 1), with a data carve-out recorded in `NOTICE`.
  - Terms review: done and recorded 2026-11-10. Linux Foundation site content is CC BY 3.0 ([terms](https://www.linuxfoundation.org/legal/terms)). Sessionize offers an API for read-only access to public schedules. The Linux Foundation `robots.txt` carries a Content-Signal of `ai-train=no`, so embeddings for search are fine and training on the content is not. Scheduled fetches are therefore acceptable.
  - Redistribution in public bundles: bundles carry the CC BY 3.0 attribution and a takedown contact, and speaker data in them is trimmed to name, title and organization, with no bios, photos or social links.
  - Create a release keystore as a GitHub secret.
- **S5, skeleton.** A Kotlin Multiplatform and Compose Multiplatform skeleton that builds for Android and iOS on GitHub Actions and uploads to TestFlight.

**Exit criteria:**
- **S1:** Android↔Android and Android↔iPhone (iPhone backgrounded) reach token read plus resolution within 60 s in at least 90% of 3-metre trials. The iPhone↔iPhone both-background result is recorded.
- **S2:** median query latency ≤ 150 ms on a mid-range Android phone (ASSUMPTION threshold), and top-5 overlap with Elasticsearch ≥ 60%.
- **S5:** the skeleton produces a TestFlight build and an APK from CI.

### Phase 1: contracts and tier 1

**Deliverables:**
- Written specifications with golden fixtures for: talk bundle v1, the capabilities document, People API v1 (frozen from `docs/CONTRACT.md`), and Bluetooth derived tokens v1.
- The GitHub Action pipeline: ingest dry-run, topics port, facets, embeddings, related talks, and publication to Pages.
- `capabilities.json` for tier 1.
- The web app (decision 9) reads `capabilities.json` and, on tier 1, searches the static bundle in the browser with no server. Tier 2 and 3 backends send CORS headers for the Pages origin if the web app calls them cross-origin.
- `GET /api/capabilities` added to the tier 3 server, pointing `talks.bundle_base` at the Pages bundles.

**Exit criteria:**
- The Action rebuilds the bundles from committed raw data with no Elasticsearch.
- The Node topics output is diffed against the live lists captured through `GET /api/topics?event=` before any decommissioning, with the differences reviewed.
- The bundle validates against the fixtures.

### Phase 2: native apps v1 against tier 1

**Deliverables:**
- Conference switcher, schedule, search (FTS5 plus cosine with RRF, filters, time phrases, "Happening now", chips), For you, related talks, topic picker, interested list, and schedule import (ICS, CSV, JSON, text; PDF per decision 8).
- Settings with the Server field and capabilities handling.
- Offline after the first sync.
- TestFlight and APK builds.

**Exit criteria:**
- Every talk-related check in `scripts/smoke.mjs` that applies to talks passes against the on-device search on both platforms.
- With the network off, every tier 1 feature works.
- Pointing the app at tier 3 changes nothing for talk features.

### Phase 3: people features against tier 3 (existing server)

**Deliverables:**
- Profile, people search, circles, presence (zones, GPS bands), "Who's around", asks and meets, blocks, reports, the watch list and in-app nudges, implemented in the apps against People API v1.
- Native push for the official tier 3 deployment: APNs through Node's `http2` and FCM, added beside `server/nudge.mjs`.

**Exit criteria:**
- The people checks of `scripts/smoke.mjs`, run through the app's API client, pass against tier 3.
- No screen shows a zone, spot line or distance outside the rules in `docs/CONTRACT.md:308`.

### Phase 4: Bluetooth derived tokens on both platforms and the tier 3 server

**Deliverables:**
- `server/ble.mjs` accepts `ble_key` issue and window resolution, alongside the legacy rotate route.
- The native `BleRadio` on Android (reusing `BleService.kt`) and on iOS (Core Bluetooth).
- Native sightings batching and local notifications.

**Exit criteria:**
- A 2-hour test with the phone in a pocket, screen off and the app swiped from recents: discovery continues past 10 minutes on Android, and a strong match within 3 m notifies within one sightings interval plus 30 s.
- iOS meets the S1 matrix.
- Battery drain is recorded. ASSUMPTION target: ≤ 3% an hour.

### Phase 5: tier 2 on Cloudflare's free plan

**Deliverables:**
- A Worker plus one Durable Object per conference (SQLite) implementing People API v1: directory, presence, meets, blocks, reports with hiding after 2, circles and the wordlist filter.
- D1 for the registry and the moderation queue, with an operator script.
- WebSocket live updates.
- Derived-token resolution.
- Web Push, and FCM for the official deployment.
- The D1 polling fallback behind a flag.
- `capabilities` reflecting all of the above.

**Exit criteria:**
- The same people test suite passes against tiers 2 and 3.
- A synthetic load test at mid and high adoption (section 7.5, with the chosen sightings interval) stays ≤ 70% of every daily free allowance: Workers requests, Durable Object requests, rows read and written, and neurons if used.
- The client keeps working, with talk features unaffected, when the Worker returns 1027 or 429.

### Phase 6: distribution, operator documentation and cutover

**Deliverables:**
- App Store release.
- Signed APK on GitHub Releases, plus F-Droid later (decision 4); no Google Play.
- Operator guides for each tier: tier 1 is "fork and enable Pages and the Action"; tier 2 is "`wrangler deploy` plus secrets"; tier 3 is the existing checklist plus the new steps.
- README, `docs/CONTRACT.md` and `DECISIONS.md` updated.
- Default builds point at the live tier 3 server until the official tier 2 passes its exit criteria, then switch to tier 2; tier 1 is the fallback (decision 6).

**Exit criteria:**
- A fresh fork reaches a working tier 1 by following the guide alone, and likewise for tier 2.
- The legacy Capacitor APK is retired after its users are told.
- Any deletion of the maintainer's Elastic deployment or Cloud Run service waits for the maintainer's explicit confirmation (decision 7), because it is irreversible.

---

## 13. Migration of existing users and data

- **Talks and conferences** are already committed under `data/`; no Elasticsearch export is needed. Topic lists exist only in Elasticsearch, so capture them through the public `GET /api/topics?event={slug}` before any shutdown, to diff against the Node builder.
- **Profiles are not migrated server to server.**
  - They expire at the end of their conference (`docs/CONTRACT.md:169-170`). KubeCon North America 2026 ends 2026-11-12 (`data/kubecon-cloudnativecon-north-america-2026/conference.json`, `end_date`).
  - The current apps keep the profile (`caddie.profile.v1`) and the device id and secret (`caddie.device.v1`) on the device (`docs/CONTRACT.md:406`). The native apps cannot read the Capacitor WebView's storage directly.
  - Options: a one-time "export my profile" link or QR code in the last Capacitor build, which the native app imports, or accepting re-entry. Profiles are per conference and short.
  - `scripts/export-people.mjs` should not be used for this; it would move personal data through the operator.
- **Blocks, meets, reports, push subscriptions and nudge records** expire with their conference and are not carried over.
- **Android package.** Moving from the Capacitor APK to the native APK under the same application id needs a matching signing key to update in place. CI debug keys differ per build (ASSUMPTION), so users uninstall once, and the release keystore prevents this from happening again.
- **Samples** (130 sample and dummy profiles) can be seeded into tier 2 or 3 with an adapted `scripts/seed-people.mjs`. Tier 1 can show a few local demo cards, clearly marked "Sample".

---

## 14. Decisions (2026-11-10)

These decisions were made by the maintainer's agent under a "free forever first, industry standard, low cost" instruction. They can be revisited; a change should be recorded in `DECISIONS.md`.

1. **License: Apache-2.0.** It is permissive, has an explicit patent grant, and is compatible with F-Droid and with operators who run paid deployments.
2. **iOS UI: Compose Multiplatform on iOS is accepted.** It keeps one UI codebase; SwiftUI is used only for platform pieces.
3. **Native push: no push gateway.** Only the official backend holds the APNs and FCM keys; other backends fall back to in-app and local notifications.
4. **Android channel: a signed APK on GitHub Releases, with F-Droid later.** There is no Google Play release, because its fee is a payment.
5. **Tier 2 people vectors: computed on the client by default.** Workers AI is optional.
6. **Default backend in builds: the existing live tier 3 server** until the official tier 2 is live and passes its exit criteria. Tier 1 is the fallback.
7. **Decommission: nothing is decommissioned.** Deleting the Elastic deployment or the Cloud Run service always needs the maintainer's explicit confirmation.
8. **PDF schedule import is dropped from native v1.** Tier 3 may keep server-side extraction behind a capability.
9. **Web app: kept** as the tier 1 demo page on GitHub Pages and for desktop users.
10. **Language: English-only semantic matching with `bge-small-en-v1.5` for v1.**
11. **Bluetooth on tier 2:** a "right near you" nudge may arrive up to the operator-set sightings interval late, which is up to 5 minutes at KubeCon scale.

---

## 15. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A free allowance is reduced or withdrawn (section 7.6) | Tier 2 people features degrade | Capability flags; D1 polling fallback; client vectors; talk features never depend on tier 2 |
| Discovery between two backgrounded iPhones fails | Fewer nudges in crowds of iPhones | S1 measurement; Android-assisted discovery; honest copy |
| Dense venue: many Apple devices to interrogate | Android battery drain and connection-slot exhaustion | RSSI gate, per-address cache, connection cap; Phase 4 measurement |
| Tier 2 near the daily cap at high adoption | 1027 errors at peak | Operator sightings interval; delta sync; fail-open client |
| Push is unavailable on third-party backends | Asks are not seen while the app is closed | In-app badges; Bluetooth local notifications (decision 3: no gateway) |
| Kotlin/Native and Xcode build friction for a new Kotlin developer | Slower start | S5 skeleton first; Swift only behind interfaces |
| Compose UI on iOS feels non-native | User complaints | SwiftUI interop for specific screens (decision 2) |
| Play rejects the `connectedDevice` foreground service (only if Play is reconsidered) | No Play listing | `specialUse`; GitHub Releases and F-Droid |
| Android verification goes global in 2027 | Sideloading friction | Register the app (free 20-device account or verified console account), or document ADB and the advanced flow |
| `bge-small-en` is English-only | Weaker matching for non-English text | Decision 10: English-only for v1; `multilingual-e5-small` (118 MB) is the later upgrade path |
| Sessionize or Linux Foundation terms forbid scheduled fetches | No automatic tier 1 refresh | S4 check; operator-run refresh as today |
| User-generated content on third-party servers at App Review | Rejection or removal | Report and block work against every tier; operator guide requires moderation |

---

## 16. Assumptions

- **A1.** The Android failure is caused by JavaScript timers in the backgrounded WebView (section 4.5). Inferred from code, not verified on a device.
- **A2.** iOS does not relaunch an app the user force-quits.
- **A3.** Continuous Android advertising needs a foreground service.
- **A4.** Nearby Connections does not discover in the iOS background, and on Android it needs Google Play services.
- **A5.** MultipeerConnectivity is Apple-only.
- **A6.** A `bge-small` query takes 20 to 100 ms through native ORT on a mid-range phone. int8 and fp32 vectors rank compatibly.
- **A7.** Cloudflare sign-up needs no payment card.
- **A8.** Durable Object CPU on the free plan is enough for the directory, the window token map and message handling.
- **A9.** The load-model inputs in section 7.5.
- **A10.** There are tens of real profiles in production (not queried).
- **A11.** CI debug signatures differ per run.
- **A12.** `neverForLocation` scans still deliver Apple manufacturer advertisements.
- **A13.** iPhones may or may not receive Android's extended advertisements; the GATT read covers both cases.
- **A14.** APNs and FCM pushes are bound to the publisher's keys, so third-party backends cannot push to the official apps.
- **A15.** Workers outbound requests can reach FCM's HTTP v1 endpoint. Direct APNs from a Worker is not assumed, because APNs requires HTTP/2.
- **A16.** Full Android verification outside Play may carry a fee.
- **A17.** GitHub Releases has no stated bandwidth cap.
- **A18.** Herald's license and maintenance status are unchecked.
- **A19.** Apple's user-generated content rules apply to an app that connects to user-chosen servers.
- **A20.** Cloud Run's free tier needs a billing account.

---

## 17. Sources

**Repository** (commit `3a10fbc`): `README.md`, `docs/CONTRACT.md`, `DECISIONS.md`, `docs/ANDROID.md`, `docs/OPERATOR_CHECKLIST.md`, `docs/FIND_AND_CONNECT_SPEC.md`, `DATA_NOTES.md`, `server/*.mjs`, `scripts/ingest.mjs`, `scripts/deploy.sh`, `.github/workflows/android-apk.yml`, `web/capacitor.config.ts`, `web/src/people/*`, `web/android/app/src/main/**`, `data/**`.

**Apple and iOS**
- [Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/)
- [Compare memberships](https://developer.apple.com/support/compare-memberships/)
- [Apple forum 768748: Personal Team and push](https://developer.apple.com/forums/thread/768748)
- [Expo: free vs paid Apple accounts](https://expo.dev/blog/apple-developer-program-explained-free-vs-paid)
- [TestFlight](https://developer.apple.com/testflight/)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Core Bluetooth background processing](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html)
- [Core Bluetooth peripheral best practices](https://developer.apple.com/library/content/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/BestPracticesForSettingUpYourIOSDeviceAsAPeripheral/BestPracticesForSettingUpYourIOSDeviceAsAPeripheral.html)
- [Apple forum 814450](https://developer.apple.com/forums/thread/814450)
- [Apple forum 773100](https://developer.apple.com/forums/thread/773100)
- [Apple forum 837516](https://developer.apple.com/forums/thread/837516)
- [WebKit: Web Push for web apps on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

**Google and Android**
- [Play registration fee](https://support.google.com/googleplay/android-developer/answer/6112435)
- [Play testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Android developer verification](https://developer.android.com/blog/posts/android-developer-verification-rolling-out-to-all-developers-on-play-console-and-android-developer-console)
- [Doply: verification explained](https://www.doply.io/en/blog/android-developer-verification-explained)
- [F-Droid inclusion policy](https://f-droid.org/docs/Inclusion_Policy/)
- [BLE in the background](https://developer.android.com/develop/connectivity/bluetooth/ble/background)
- [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Play foreground service requirements](https://support.google.com/googleplay/android-developer/answer/13392821)
- [Google Nearby](https://developers.google.com/nearby)
- [Nearby Connections for Swift](https://developers.google.com/nearby/connections/swift/get-started)
- [Herald protocol](https://theheraldproject.github.io/protocol)

**Cloudflare**
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 SQL (FTS5)](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Objects on Workers Free (2025-04-07)](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/)
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [freetier.co: Cloudflare Workers](https://freetier.co/directory/products/cloudflare-workers)

**Firebase, Neon and GitHub**
- [Firebase pricing](https://firebase.google.com/pricing)
- [Firebase Storage Spark change (2024)](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)
- [Neon pricing](https://neon.com/pricing)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [GitHub plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

**On-device ML, storage and frameworks**
- [multilingual-e5-small ONNX](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx)
- [bge-small-en-v1.5 ONNX](https://huggingface.co/Xenova/bge-small-en-v1.5/tree/main/onnx)
- [all-MiniLM-L6-v2 ONNX](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx)
- [EmbeddingGemma](https://developers.googleblog.com/en/introducing-embeddinggemma/)
- [MediaPipe text embedder](https://ai.google.dev/edge/mediapipe/solutions/text/text_embedder)
- [transformers.js](https://huggingface.co/docs/transformers.js/index)
- [ONNX Runtime Mobile](https://onnxruntime.ai/docs/get-started/with-mobile.html)
- [androidx sqlite-bundled (FTS5)](https://android.googlesource.com/platform/frameworks/support/+/f66fa79d19e5874f0afaa6868363c69ecf851cf2/sqlite/sqlite-bundled/build.gradle)
- [androidx SQLite for KMP](https://developer.android.com/kotlin/multiplatform/sqlite)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [Compose Multiplatform 1.8.0](https://blog.jetbrains.com/kotlin/2025/05/compose-multiplatform-1-8-0-released-compose-multiplatform-for-ios-is-stable-and-production-ready/)
- [Kable](https://github.com/JuulLabs/kable)
