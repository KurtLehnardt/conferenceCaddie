# Free-stack review: findings and fixes

This file records the second review of the free stack (the Cloudflare Worker in `worker/`, the web app's GitHub Pages build, `.github/workflows/pages.yml` and `ingest.yml`, and the smoke script ported to the Worker), and what the fix round did about each finding.

- **The review** ran against `origin/main` at `6f55b8e`, on a local Worker with fake embeddings and a GitHub Pages stand-in.
- **The fixes** were made on `fix/free-review`, rebased onto `origin/main` at `110c513` (PR #23 merged).

Nothing is deployed. The Cloudflare token cannot edit Worker scripts, so every check below ran locally.

## How the fixes were checked

**The stack.**
- The Worker ran under `wrangler dev --local` on port 8797 with `--test-scheduled`.
- It used real Workers AI embeddings through `worker/scripts/dev-ai-proxy.mjs`, which now forwards CLS pooling.
- It had a development Bluetooth keyring from `node worker/scripts/dev-vars.mjs --ble --real-ai`.
- The local state was a throwaway one under the scratchpad.

**The data.** All 62 committed conferences were loaded with `worker/ingest/push-ingest.mjs`: 4 searchable, with 717 talks embedded under the new conventions, and 58 unavailable.

**The site.**
- The web app was built in Pages mode: `VITE_BASE=/conferenceCaddie/`, `VITE_API_BASE=http://127.0.0.1:8797` and `VITE_CLIENT_EXTRACT=1`.
- The Pages workflow's build steps then ran locally, in order, into `dist-pages/`:
  - the web app;
  - `npm --prefix tools/bundles ci --ignore-scripts`;
  - `scripts/build-bundles.mjs`, once cold with the model download and once with `--no-model-download` from the warm cache;
  - `scripts/carry-forward-bundles.mjs`.
- A GitHub Pages stand-in that answers unknown paths with `404.html` served the result on port 8798.

**Results.**
- `wrangler deploy --dry-run` builds the Worker (318 KiB, 85 KiB gzipped).
- The ported smoke passed every check: `BASE_URL=http://127.0.0.1:8798/conferenceCaddie API_BASE=http://127.0.0.1:8797 SMOKE_ORIGIN=http://127.0.0.1:8798 ADMIN_TOKEN_FILE=… SMOKE_UNAVAILABLE=pytorch-day-japan-2026 node scripts/smoke.mjs` gave 92 PASS, 0 FAIL, 0 SKIP and no NOTE. That includes the new checks:
  - `cap1` (capabilities);
  - `im3b` (import text with file hints);
  - `q8c` (block ownership);
  - `ble1` and `ble2` (Bluetooth sessions and mitigations);
  - `unav1` (owner deletes on an unavailable conference).
- `node worker/scripts/ble-parity.mjs` gave 29 PASS, 0 FAIL.
- The review's own probes, plus two new ones, were re-run against the fixed Worker. Results are below.

## Must-fix findings

### 1. A deleted-and-recreated blocked profile escaped the block: fixed

**What changed.**
- `#deleteRows` and the purge delete only the blocks a person made (`blocker_id`). The blocks others made of that person stay.
- The block cache keeps the blocked side when a profile is forgotten.
- Schema version 2 adds `blocks.blocked_ref` and `blocks.expires_at_ms`. The block route stores the blocked ref and an expiry, as `server/connect.mjs` does. The expiry is the latest of:
  - the conference's end;
  - the end of each of the two profiles.
- `GET /api/people/blocks` lists a block whose profile is gone or expired, with `display_name: null`.
- `DELETE /api/people/block` unblocks by the stored ref. Rows from before version 2 have their ref computed.
- The purge gives older rows the conference's end and deletes blocks whose expiry has passed.

**Proof.**
- `probe1`, the review's reproduction: A blocks D, then D deletes and re-creates the profile from the same device.
  - A's list holds one block with `display_name: null`.
  - D's matches do not list A.
  - D's ask to A answers 403 `blocked`.
  - The blocks response validates against `blocks.get`.
- `probe9`: unblocking by ref after the blocked profile is gone answers 200, and the list is then empty.
- The smoke's `q8c` covers the same.

### 2. Bluetooth tokens v1 were missing, and legacy sightings had no mitigations: fixed

**What changed.** `worker/src/lib/ble.js` ports the tier 3 code (`server/ble.mjs`, `ble-keyring.mjs` and `ble-config.mjs` from PR #23) to the Worker, importing the reference implementation `contracts/js/ble-token.mjs`. `wrangler.toml` turns on `nodejs_compat` for its `node:crypto`.

- **Keyring.** `BLE_MASTER_KEYRING` is a Worker secret, checked by the same rules as tier 3.
  - Unset: the Worker serves `server-rotate`.
  - Set but unusable: the Worker logs the rule that failed, never the value, and serves `server-rotate`. The capabilities document follows.
  - `worker/scripts/setup-secrets.mjs` creates the first keyring and never replaces one.
  - `dev-vars.mjs --ble` writes a development keyring.
- **Presence with `ble: true`.**
  - Mints a fresh 16-byte `presence_nonce` under the current master and stores `ble_master_id` with it (new presence columns).
  - Returns `ble_key` and `ble_key_id` once, next to the legacy token for the old Android app.
  - `ble: false`, presence delete, the purge and visibility off clear the session.
  - The rotate route mints a legacy token, leaves the derived session alone, and marks the session `ble_rotated`, as tier 3 does.
- **Sightings resolution.** It runs through one pure function, `resolveTokens`, shared with the parity script:
  - the threshold;
  - a per-window token table cached in the conference object, rebuilt on a miss older than 30 seconds, and updated as sessions are minted;
  - legacy tokens;
  - a re-check against the store (nonce tag, master held, live presence, visible, not hidden, not the requester);
  - co-location: the same zone, or the 3×3 cells around the requester's.
- **After resolution.**
  - Blocks, the matches ranking and the strong-match rule apply, as before.
  - `applyCaps` limits the answer to 10 new people per window and 30 per hour per device. The record is kept in the conference object's SQLite (`ble_caps`), with entries clamped to the read time, across presence sessions. It is pruned after an hour by the cron and deleted with the profile.
  - The zone is blanked outside the requester's zone.
  - The answer carries the requester's `ble_key_id`.
- **Errors.**
  - 403 `ble_required` when the requester is not around, or has no live session.
  - 403 `ble_rekey` for a session under a retired master, unless a live, rotated legacy token keeps an old app going.

**Proof.**
- `worker/scripts/ble-parity.mjs` runs the Worker's own code over the contract fixtures: 29 PASS, 0 FAIL.
  - `golden-vectors.v1.json`: every `ble_key`, `ble_key_id` and token.
  - `resolution-cases.v1.json`: all 18 cases, including the stale table, ended presence, retired master, the requester's own token, a neighbouring cell and two cells away.
- `probe1`, the review's reproduction: D in Registration reporting A's token while A is in the Expo hall resolves nobody, and the answer carries `ble_key_id`.
- `probe3`: 12 live legacy tokens give 10.
- `probe9`, derived tokens end to end:
  - the current window and w-1 resolve; w±2 and a weak RSSI do not;
  - the same ~100 m cell in another zone resolves, with zone null;
  - another zone with no position resolves nobody;
  - a replaced session stops resolving, and the new one resolves;
  - `ble: false` gives 403 `ble_required`;
  - the caps give 10 of 12, then the same 10 in the same window, and the same 10 after presence is turned off and on;
  - `presence.put` and `sightings` responses validate against the contract.
- The smoke's `ble1` and `ble2` cover the same against any Worker. `ble2` runs only on a local API or with `SMOKE_BLE=1`, because it puts specific-match test profiles around.

### 3. `GET /api/capabilities` was not served: fixed

**What changed.** `worker/src/capabilities.js` serves GET and HEAD `/api/capabilities`, rate-limited per address, with `Cache-Control: public, max-age=300` and `Access-Control-Allow-Origin: *`. The document is a truthful tier 2 one:
- `tier: free`;
- `bundle_base` from `TALKS_BUNDLE_BASE` (default `https://kurtlehnardt.github.io/conferenceCaddie/bundles/`), and `server_search: true`;
- people `semantic: server` and `live: poll`;
- the `ble` block of the configured mode, with `colocation_required: true` and a 60-second sightings interval;
- push `webpush: true`, with `apns` and `fcm` false;
- both imports `server`.

**Proof.**
- `curl localhost:8797/api/capabilities` answers 200.
- `validator('capabilities.v1')` passes in closed mode.
- `negotiate()` gives version 1.
- `probe2` passes, including the capabilities check that failed in the review.
- The smoke's `cap1` passes.

### 4. Embedding parity with the bundle model was broken: fixed

**What changed.** `worker/src/lib/embed.js`:
- calls Workers AI with `pooling: "cls"`, and `dev-ai-proxy.mjs` forwards it;
- checks every vector is 384 numbers;
- refuses any model other than `@cf/baai/bge-small-en-v1.5`;
- prefixes talk search and For you queries with the query instruction.

The store embeds each talk's document text, `title + "\n" + abstract`, as its `doc` vector, the bundle's input. It keeps the abstract chunks for the evidence passage. Profile text and people queries are embedded as documents on both sides.

`CONVENTIONS` mirrors the bundle `model` block, and `push-ingest.mjs` refuses to push when the two differ. A change of conventions marks every talk and profile pending, so the cron and `POST /admin/embed-pending` re-embed them (the stored talk vectors carry the conventions id). Fake local vectors carry their own id.

The people floor was re-measured with real Workers AI over the 30 sample profiles (812 interests-to-expertise pairs, plus off-topic queries):
- CLS raises every cosine by about 0.05;
- the unrelated median goes from 0.58 to 0.64;
- 0.61 keeps the same share of unrelated pairs as 0.55 did under mean pooling.

`PEOPLE_SEMANTIC_FLOOR` is now 0.61 (`worker/src/people/rank.js`).

**Proof.** A parity run through the Worker's own `embedPassages`, `embedQuery` and `documentText`, with `env.AI` backed by the Workers AI REST API:
- every request carried `pooling: cls`;
- `documentText` equals the fixture input for all 3 talks;
- the maximum difference from the reference similarities is 0.0003 (tolerance 0.02), and the best document per query matches;
- document and query vectors have cosine 1.0000 to the reference vectors.

With every talk re-embedded under the new conventions, the smoke's semantic checks pass on real vectors: `a1` (rank 5), `a3` (rank 2), and the people checks `p2` and `q1` (rank 1) at the new floor.

### 5. `pages.yml` had none of the bundle steps: fixed

**What changed.** The workflow now builds the web app (base `/conferenceCaddie/`) into `dist-pages/`, then:
1. `npm --prefix tools/bundles ci --ignore-scripts`;
2. reads `ONNX_REVISION` and caches `.cache/model` with `actions/cache` keyed on it;
3. `node scripts/build-bundles.mjs`, with `--no-model-download` on a cache hit and `--reuse-from none` on the weekly schedule, plus `--takedown https://github.com/KurtLehnardt/conferenceCaddie/issues --publisher-name "Conference Caddie"` (never `--offline`);
4. carries forward the bundle directories the live `conferences.json` names (new `scripts/carry-forward-bundles.mjs`). A 404 is ignored on the first deploy, and every file is checked against the size and SHA-256 the index gives;
5. uploads `dist-pages/`.

It also:
- triggers on `data/**`, `contracts/**`, the bundle builder and its libraries, and `tools/bundles/**`;
- adds a Monday schedule after the weekly ingest;
- keeps the `CADDIE_API_BASE` skip guard.

**Proof.** The steps ran locally in that order.
- The cold build verified the pinned model, built 4 bundles (654 vectors, 1.7 MB) and wrote `conferences.json` and `capabilities.json`.
- The warm rebuild with `--no-model-download` and the carry-forward ended "steps ok". The live site has no index yet, so nothing was carried.
- Carry-forward against a local copy of the fixture index fetched, verified and wrote both files, and a second run found them present.
- The review's grep now finds `build-bundles`, `tools/bundles`, `reuse-from` and `dist-pages` in `pages.yml`.
- The workflow has not run on GitHub.

### 6. PDF, DOCX and ODT import failed in the Pages build: fixed

**What changed.** `worker/src/talks/import.js` accepts `filename` and `mime` together with `text`, as format hints only: a `.csv` name or a `text/csv` type reads the text as CSV. `web/` is unchanged.

**Proof.**
- `pdfimport.mjs`, the review's reproduction (Settings, Import my schedule, a one-page PDF, 390×844): the request body still has the keys `event`, `filename`, `mime` and `text`, and the sheet now shows "Found 2 talks", both at exact title.
- The smoke's `im3b` (extracted PDF text with `filename: schedule.pdf`, `mime: text/plain`) finds 5 of 5 at exact title.

### 7. A conference flipped to unavailable blocked profile deletion and stopped the purge: fixed

**What changed.**
- **Directory.** The DirectoryDO records `has_object` (the conference's object was given its document, which happens once it is searchable) and `holds` (what the object still held at the last cron visit).
- **Owner routes.** The Worker forwards these for any conference with an object:
  - `DELETE /api/people/profile`;
  - `DELETE /api/presence`;
  - `DELETE /api/push/subscription`;
  - `DELETE /api/people/block`;
  - `GET /api/people/blocks`.
  The ConferenceDO serves only those while its conference is not searchable. Every other route still answers 400 `conference is not available`.
- **Admin.** The admin routes reach any conference the directory knows.
- **Status sync.** `PUT /admin/conferences` copies the document to every object, so an object learns its status.
- **Cron.** It visits every object whose end date is at most 3 days ago, or whose object still holds rows in `people`, `presence`, `blocks`, `meets`, `push_subs`, `nudges`, `nudge_sends` or `ble_caps`. That check reads one row per table. Visits continue until the object is empty, whatever the status. A new object counts as holding data until the cron has looked.
- **Ingest.** `push-ingest.mjs` leaves out the document of a conference whose schedule fetch failed (`status_reason: fetch_failed`) while the Worker lists it searchable, so a transient failure no longer takes the conference down.

**Proof.**
- `probe6`, the review's reproduction: with the conference flipped to unavailable, the owner's profile delete and presence delete answer 200, and `GET /admin/stats` answers 200.
- `probe10` (new) uses `--test-scheduled`:
  - an expired profile in a conference flipped to unavailable, with an end date weeks ago, is purged by the cron (people 1 → 0);
  - the cron visited 4 conferences, then 3 once that object held nothing.
- The smoke's `unav1` runs locally only, with `SMOKE_UNAVAILABLE=<slug>` and the admin token:
  - a profile write is refused;
  - presence and profile deletes and the admin stats are served;
  - the conference is restored.

### 8. Device secrets live on a github.io origin shared with 7 other live Pages sites: not fixed (needs the user's decision, R18)

This needs a separate origin for the app:
- a custom domain with a CNAME; or
- a dedicated GitHub organisation or account.

`ALLOWED_ORIGINS` should then name only that origin. The choice is the user's, and so is any cost (a domain), so nothing changed in this round. It stays in `docs/FREE_HOSTING.md` (Known gaps) and must be settled before go-live.

**Resolved later on 2026-11-10.** The user chose to serve the app from the Cloudflare Worker, on its own `workers.dev` origin and the same origin as the API. GitHub Pages keeps only the public talk bundles and a landing page with no script, and `ALLOWED_ORIGINS` no longer names the github.io origin (`DECISIONS.md`, "The web app moves to the Cloudflare Worker's origin").

None of the fixes needed `server/`, `web/src/people/sync.ts` or `web/src/people/storage.ts`, so nothing is left for session lenovot440p-6a.

## Notes from the review

- **Environment** (review): the scratch clone, ports 8795/8797/8798, and the throwaway state are as the review describes. This round used its own ports and state (above).
- **Orphaned processes of the stuck review.** Still running at the end of this round, and not this session's to stop:
  - PID 40907 runs `node scripts/dev-ai-proxy.mjs --port 8796`. It holds `CLOUDFLARE_API_TOKEN` in its environment and spends neurons when called.
  - PIDs 40909 and 40933 run `wrangler dev` on port 8799, from `.claude/worktrees/review-free-final`.

  The orchestrator should stop them by PID.
- **Reports never expire automatically:** unchanged. It mirrors main. The cron now keeps visiting an object while it holds people data, but the `reports` table is not part of that check and is still purged only by the operator. Consider a cron purge some days after a conference ends.
- **Rate-limit keys** (full IPv6 address, the unauthenticated profile id, bucket maps cleared at 10,000 keys): unchanged, and they mirror main. Keying IPv6 by /64 is still suggested.
- **The device header is a static bearer credential:** unchanged, same as main.
- **Misleading ingest output when Workers AI is down:** fixed. While embeddings are paused, `embedPending` now counts waiting talks as well as people, so `drainPending` and push-ingest no longer report "pending 0" for unembedded talks.
- **Keyword-fallback recall with Workers AI down:** unchanged, as designed. With real CLS vectors the semantic leg finds the expected talks (`a1` and `a3` pass).
- **Import body cap** (1 MB in the Worker, 5 MB advertised by the client): unchanged. It is now listed in `docs/FREE_HOSTING.md` (Known gaps).
- **Speaker and company email addresses in committed abstracts**, served unredacted by the Worker's search and schedule: unchanged. This predates the free stack, and the bundles redact them.
- **`REVIEW_NOTES.md:57` holds a service-account email**, not a credential: unchanged. This predates the free stack.
- **Doc nits:** fixed.
  - `worker/README.md` now names the `CADDIE_ADMIN_TOKEN` repository secret.
  - The `wrangler.toml` `[ai]` comment now describes the `EMBED_PROXY` path.
- **The "leading space in X-Caddie-Device" probe case:** not a bug. HTTP trims optional whitespace from header values, and it is still the only FAIL in `probe1`, for that reason.
- **Save/delete race** (probe8): not reproduced in the review, and not re-run.

## Verified OK

From the review, and still true on the fixed Worker (`probe1`, `probe2` and the smoke):

- **Device auth.**
  - A wrong secret, a truncated id or secret, a missing dot, an extra dot, padding or an empty header answers 403 `forbidden`.
  - IDOR attempts on profile PUT and DELETE, matches, the blocks list, and meet read or cancel by a non-participant answer 403.
- **Reciprocity.**
  - A profile that is not `open_to_meet` gets 403 `visibility_required` on matches.
  - Sharing a talk never leaks into conference-wide matches.
  - Turning visibility off removes the person from others' matches at once.
  - Contact details appear only in matches and circle members.
- **Circles.**
  - A non-sharer, or a caller with no profile, gets 403 `share_required` with the count only.
  - A sharer sees co-sharers and never themselves.
  - Counts are zero-filled and drop on delete.
- **Presence and zone.**
  - Presence and rotate need `open_to_meet` (403 `profile_required`); rotate when not around answers 403 `presence_required`.
  - Viewers who are not around see no zone, and spot lines never appear in matches.
  - Distance and bearing appear only inside an active meet, to its participants, rounded to 10 m. No coordinates leave the server.
- **Block symmetry while both profiles exist.**
  - The pair vanish from each other's matches and circles.
  - An ask answers 403 `blocked`, and blocking oneself answers 404.
  - Blocking from a circle card removes the pair both ways.
- **Silent decline.** The requester keeps seeing "requested" in the meet read and the outbox.
- **Delete and expiry.**
  - Delete removes meets (the other side gets 404) and drops circle counts.
  - An expired profile gets 403 at once, and the cron purge removes the row.
- **Conference isolation.**
  - Profiles are per conference, and cross-conference `shared_talk_ids` answer 400.
  - Search is scoped to the conference.
  - Meet ids route to their own conference object.
- **Admin and CORS** (`probe2`, 24 of 24).
  - Without a valid token, with a lower-case scheme, with an `Origin` header or on a path traversal, admin answers 404 with no CORS headers. With the token and no Origin it answers 200.
  - `/internal/*` is not forwarded.
  - A preflight from a foreign origin answers 403 with no CORS headers.
  - Foreign, `null`, suffix-spoofed and `http` origins get 403 `cross-origin request` on people routes.
  - Allowed origins get `Vary: Origin` and the exposed `Retry-After`.
  - Bodies over 8 KB give 413, and a `text/plain` body gives 415.
  - Security headers are on every response.

## Not covered in this round

- **No deploy, so no live smoke.** The Cloudflare token lacks "Workers Scripts: Edit". Run the smoke against the deployed Worker once it can be deployed. Set `BLE_MASTER_KEYRING` first, or the capabilities document will say `server-rotate`.
- **The 403 `ble_rekey` answer was not exercised against a running Worker.** A retired master's sessions not resolving is covered by the parity run. The rule itself (a retired session with no rotated legacy token answers `ble_rekey`) is the tier 3 rule, ported line for line.
- **`pages.yml` has not run on GitHub.** Its steps ran locally, in the same order and with the same arguments.

## Live review of the deployed Worker (2026-11-11): findings and fixes

An independent review ran against the live Worker at https://conference-caddie.krlehnardt.workers.dev, and a verifier reproduced each finding below. The fixes are in the pull request "Fix the live review findings on the free stack". Nothing was deployed by that change; the shipping step deploys from `main` after review.

**How the fixes were checked.** The web tests (66 of 66), the repository tests (`npm test`, 510 of 510), `node worker/scripts/ble-parity.mjs` (29 of 29) and the local smoke against `wrangler dev --local` with real Workers AI embeddings through the local proxy and `SMOKE_UNAVAILABLE=pytorch-day-japan-2026` (98 PASS, 0 FAIL, 0 SKIP). The count grew from 93 because `main` gained the native push checks `np1` to `np3`, and this change adds `push1` and `meter1`.

### sec-1. Push subscriptions accepted any https endpoint: fixed

`PUT /api/push/subscription` now accepts an endpoint only on a known browser push service host, on the default port, with no user name or password: `fcm.googleapis.com`, `android.googleapis.com`, `jmt17.google.com` (added in the follow-up below), any subdomain of `push.services.mozilla.com` or `notify.windows.com`, `web.push.apple.com` and any subdomain of `push.apple.com` (`PUSH_SERVICE_HOSTS` in `worker/src/push/webpush.js`). IP literals, `localhost` and other hosts get 400 "endpoint must be a push service URL". `DELETE` still accepts any well-formed https endpoint, so an owner can remove a row stored before the rule. `deliver()` in `worker/src/push/send.js` skips a stored row whose endpoint is not on the list instead of sending to it (it first deleted such rows; see the follow-up below), and every push request now times out after 10 seconds (`AbortSignal.timeout`). The new smoke check `push1` covers it.

**Follow-up: Chrome Beta, Dev, Canary and Chromium (regression from this fix).** The first version of the list lacked `jmt17.google.com`, the host Chromium uses for its push endpoint (`https://jmt17.google.com/fcm/send/`) on every channel except Stable, including unbranded Chromium. People on those browsers got a 400 when they subscribed, and rows already stored for them were deleted at send time while their nudge switch still showed On. The fix adds `jmt17.google.com` as an exact host (not a suffix, so `x.jmt17.google.com`, `jmt17.google.com.evil.com`, `google.com` and `jmt17.google.com:8443` are still refused). It also corrects the comment on the list: Chromium-based Edge delivers through WNS (`*.notify.windows.com`), not FCM, while Chrome Stable, Opera, Samsung Internet and other Chromium browsers use FCM and non-Stable Chromium channels use `jmt17.google.com`. Two changes keep a future gap in the list from doing the same damage. At send time `deliver()` now skips a stored row whose host is not allowed and logs the host only, instead of deleting it, so only the push service's own 404 or 410 deletes a row. And a browser with notification permission granted, the nudge switch On and a push subscription sends that subscription to the Worker again when the app starts (`resyncPush` in `web/src/people/push.ts`; the PUT is idempotent), which restores people whose rows were already deleted without any action on their part. It is throttled and bounded so it cannot crowd out people's own actions behind a shared venue IP address: each conference is sent at most once every 24 hours (`synced_at` in the device's push state), unless the browser's endpoint changed, which is sent at once; the first PUT waits a random 0 to 30 seconds so phones opened at the same break do not send together; and when the Worker answers that the conference has ended, is unknown, or has no profile for the device (400 or 403 `profile_required`), that conference's switch is turned off on the device and is never sent again. A switch turned Off while a re-sync PUT is in flight is honoured: the row that PUT made is deleted again. The steady cost is one small request per conference with nudges on per day, and nothing when nudges are off. Sending also no longer spends the 40-send budget or a person's hourly nudge cap on a stored row whose host is not allowed. Tests: `worker/test/push-hosts.test.mjs` (run by `npm --prefix worker test` and in CI), `web/test/push-resync.test.mjs`, and the smoke check `push1` now also covers `jmt17.google.com`.

For the other session: `server/push.mjs` (tier 3) has the same gap; its `endpointOf` checks only the https scheme. The same host list and a timeout on the push request would close it there.

### cor-1. The daily usage meter lost counts and went backwards: fixed

The conference object wrote its meter to storage only every 1,000 requests or at the cron call, and the live object is replaced far more often than that, so each new instance started again from an old total. The meter in `worker/src/conference.js` now writes after the first request of a new instance, then after 100 requests or 15 seconds, whichever comes first, in the response path after the request's rows are counted. A replaced instance therefore loses at most about 15 seconds of counts. The cost is about one written row per 15 seconds for each object that is busy all day (up to about 5,760 a day per object, and about 23,000 a day for four searchable conferences, which is 27% of the 85,000 written-rows soft cap). These rows count toward that cap, so a co-located event week with ten or more searchable conferences would use a large share of it; a longer interval is the lever if that happens. The new smoke check `meter1` is a sanity check only: it reads `/admin/stats` before and after five requests and fails if the day's counts did not grow by at least that much. It does not prove the fix, because one smoke run does not replace the object, and the old code passes it too. A failed meter write now leaves the write counters as they were, so the next request retries it.

Left as is: requests the Worker answers without a conference object (`/api/conferences`, `/api/capabilities`, `/api/health`, `/api/push/vapid` and the Worker's own 400s) are still not metered. They are cheap, and metering them would need a shared counter that costs a Durable Object request per call. `docs/FREE_HOSTING.md` now says so.

### cor-3. `X-Caddie-Pace` is missing on Worker-level responses: fixed in the docs

Every polled route goes through a conference object, which sets the header, and a response without the header leaves the web app's pace unchanged (`notePace` in `web/src/lib/pace.ts` ignores a missing or malformed header); the pace falls back to 1 after 30 minutes without a reading. `docs/FREE_HOSTING.md` now says that every conference API response carries the header and that the Worker-level responses do not.

### cor-4. The Pages talk bundles are older than the Worker's schedule: fixed

What was found: the bundles were built from the committed `data/` by design (`pages.yml`, `docs/BUNDLES.md`), and the ingest workflow commits nothing, so the bundles drifted from the Worker after each ingest. Native clients read their talks from the Pages bundles through `talks.bundle_base`, which both Cloud Run's and the Worker's `/api/capabilities` point at, so they were affected whichever backend they talk to; the released Android 0.3.0 app showed stale KubeCon times. On 2026-11-10 the live bundle for `kubecon-cloudnativecon-north-america-2026` differed from the Worker's `/api/schedule` in the times of 11 talks and the titles of 2, and lacked 1 talk; on 2026-11-11 it still held 484 talks against the Worker's 485. The web app reads `/api/schedule` and has no offline path that reads the bundles, so it was not affected.

The fix makes the ingest run the single publisher of fresh schedules, with nothing committed by a workflow:

- `ingest.yml`: `push-ingest.mjs --report` records which conferences reached the Worker (also when it fails part way), `scripts/stage-ingest-data.mjs` stages exactly those conference files (a conference whose talk push failed, or whose document was held back after a failed fetch, is not staged), and a `publish` job calls `pages.yml` (`workflow_call`) with the staged artifact. The run still fails when the push failed, after the conferences it did push are published.
- `pages.yml`: when called, it lays the staged files over the committed `data/` before building. Every build, called or not, passes `--live` with the live bundle base, and the workflow-level `pages` concurrency group, which the called run keeps (the ingest workflow's own group is `ingest`, so there is no deadlock), serialises every Pages deploy.
- `scripts/build-bundles.mjs --live` with `scripts/lib/bundle-sources.mjs`: every build writes `bundles/sources.json` (per conference, the bundle's content hash, the `raw_fetched_at` of its schedule and a hash of its inputs), a sidecar because the frozen v1 formats have no place for it. A conference whose live bundle came from a later fetch than `data/` holds is kept byte for byte (read and verified against the live index), and so is one whose latest fetch failed, so a run from the committed seed (a push to `main`, the weekly full rebuild) never replaces what an ingest published. A kept bundle that a takedown still matches is rebuilt from `data/` instead. A live site that cannot be read fails the build, except a 404.
- `scripts/smoke.mjs`: the checks that need a conference's own talks (`d`, `e1`, `e2`, `n1`, `n2`, `m2`, `x`, `o`, `sch1` and the import picks) take them from the published bundles against the Worker (`SMOKE_TALKS=bundle`, the default there; `data` reads the committed `data/` and stays the default against Cloud Run). A legitimate upstream change moves the Worker and the bundles together and passes; a Worker that serves other talks than the bundles fails. The new check `bun1` compares every searchable conference's talk count on the Worker with its bundle.

Checked: root `npm test` 516 of 516 (510 plus the 6 new tests in `scripts/test/bundle-publish.test.mjs`), web tests 76 of 76, `actionlint` clean on both workflows apart from the two existing SC2086 notes on the build command. The workflow logic was run locally with the commands the workflows run: `scripts/ingest.mjs --event ... --dry-run --skip-topics` against Sessionize for the four searchable conferences (KubeCon 485 talks), `stage-ingest-data.mjs`, the overlay, build, carry-forward, landing page, site check and artifact check steps of `pages.yml` extracted from the YAML and run with bash, with the real model and `--live` against the live Pages site (no `sources.json` yet, so all four were built; 643 vectors reused, 12 embedded), then a build from the committed seed with that output as the live site, which kept all four fresh bundles (the same build without `--live` put back the stale `b620f37ae3a5da19` KubeCon bundle that is live today). The live smoke against the Worker, with `SMOKE_BUNDLE_BASE` pointing at a local copy of the freshly built site, passed `x` (all three conferences), `o`, `sch1`, `d`, `e1`, `e2`, `n1`, `n2` and `m2`; its one failure was `bun1` for `grpconf-india-2026`, whose upstream schedule had dropped from 32 to 31 talks since the Worker's last push, a real difference that the next ingest run fixes in both places.

Still open, in `docs/FREE_HOSTING.md` (Known gaps): the live bundles stay stale until the first ingest run after this change is merged (`gh workflow run ingest.yml`); a smoke run in the few minutes between the push and the Pages deploy (plus up to ten minutes of Pages caching) can fail; GitHub cancels the older of two runs pending in the `pages` group; bundles kept by `pages.yml` runs get builder changes and the weekly re-embed only at the next ingest; and the Worker does not apply `data/takedowns.json`.

For the other session: the new tests live in `scripts/test/` and root `npm test` now runs `"test/*.test.mjs" "scripts/test/*.test.mjs"`, because `test/` is yours; move them into `test/` if you prefer. Draft PR #50 (a hand refresh of `data/`) is no longer needed to fix the bundles; it can still land as a newer seed, and a seed older than the live bundles is simply not used for them.

Fixed after the review of PR #53:

- **Ended events no longer go back to the seed (blocking).** With no events named, `ingest.mjs` fetches only the upcoming list, while `push-ingest.mjs` pushed every folder in `data/`, so an ended event got its committed seed pushed to the Worker while the bundle build kept the newer live bundle: the cor-4 drift inverted (KubeCon North America 2026 would have gone back to 484 talks on the Worker on 2026-11-16, with the bundle at 485). Now `ingest.mjs --report` lists the conferences the run fetched, `push-ingest.mjs --events-from` pushes only those (an empty list pushes nothing), and `stage-ingest-data.mjs --fetched` fails if a pushed conference was not fetched. This also ends the older problem of the Worker going back to the seed for every ended event.
- **An ingest publish builds from the current `main` (blocking, privacy).** The called `pages.yml` checked out the ingest's commit, up to 90 minutes old, so a takedown merged during the ingest could be published again by its deploy, and a pending `pages.yml` run for a newer commit could be cancelled in its favour. The called run now checks out `main`.
- **The live read waits for the CDN.** The Pages CDN serves a file for up to ten minutes after a deploy, and a query string does not get past it. GitHub sets `Last-Modified` to the deploy time (on 2026-11-11 the live `conferences.json` said 06:16:38, between the deployment's creation at 06:16:31 and its success at 06:16:44), so `pages.yml` reads the creation time of the latest successful `github-pages` deployment from the Deployments API and `build-bundles.mjs --live-since` reads the index and sidecar again until both are at least that new, for up to 15 minutes, then fails. `sources.json` now carries the index's `generated_at`, and a sidecar from another build than the index is read again the same way.
- **A future-dated record no longer pins a bundle, and staged conferences are always rebuilt.** A record more than ten minutes ahead of the build's clock counts for nothing, and the called build passes the staged conferences as `--fresh`, which always follow `data/`.
- **The local smoke reads `data/` again.** Against an API on `localhost`, `127.0.0.1` or `[::1]`, `SMOKE_TALKS` defaults to `data`, since a local Worker is loaded from the seed.
- **Retiring a conference is documented** in `docs/BUNDLES.md` (Retiring a conference): commit an unavailable `conference.json` with a current `raw_fetched_at`.

Still open: a bundle that a deploy altered while writing a plausible, not future-dated record stays kept until an ingest fetches that conference again, which never happens once the conference has ended. The weekly `--reuse-from none` rebuild cannot rebuild it, because the only data it has for an ended conference is the older seed. A check of the kept bundles' vectors against a fresh embedding of their text (as vector reuse samples them) would catch altered vectors but not altered text; comparing a kept bundle's `source_sha256` against a copy kept outside Pages (an Actions artifact or cache) would catch both. Neither is built.

### cor-6. People reasons ended in ".." after a title that ends a sentence: fixed

`reasonsFor` in `worker/src/people/view.js` now closes a reason with a period only when the inserted title, passage or evidence does not already end in `.`, `?`, `!` or an ellipsis (closing quotes, brackets and highlight tags after it are allowed). The template wording is unchanged.

For the other session: `server/people.mjs` builds the same reasons and has the same double period.

### ux-3. The install card covered the bottom of every screen: fixed

While the card is open, `web/src/components/install.tsx` measures it and marks the document, and `web/src/styles.css` adds the card's height (plus its offset above the nav and a gap) to the bottom padding of `.content`, on phones and on wide screens. "Delete my profile" and every other last control can now be scrolled clear of the card. The card still stays open across tabs until it is dismissed.

### ux-4. "N people want to talk about this" looked like a link: fixed

`.pp-count` in `web/src/people/people.css` now uses the secondary text colour and normal weight, so it reads as status text next to the accent-coloured links and toggles. It is used for the count line on talk cards and in the talk sheet, and for the shared summary on Interested.

### ux-5. "Around now" with an empty search box showed the search copy: fixed

`PeopleList` in `web/src/people/PeopleScreen.tsx` now shows the "Nobody else is around right now" copy when "Around now" is on and nothing is typed. With words typed it keeps the search copy.

### ux-6. The share card on Interested had no side gutter: fixed

`.pp-share-all` in `web/src/people/people.css` now has `margin: 0 var(--gutter) 16px`, the same gutter as the talk cards in `.results`.

### After the critic's review of the fixes

The critic found two false statements in these notes and in `docs/FREE_HOSTING.md`, both corrected above: the impact of cor-4 (native clients read the Pages bundles through `talks.bundle_base` whichever backend they use, so the released Android 0.3.0 app shows stale KubeCon times today) and the app's handling of a response without `X-Caddie-Pace` (it keeps its last pace, which falls back to 1 after 30 minutes). The same round also made these smaller changes:

- `flush()` in `worker/src/conference.js` resets its write counters only after the write succeeds, so a failed meter write is retried on the next request.
- `PUT /api/push/subscription` logs the host, never the endpoint, of each refused subscription, so a browser push service missing from the list shows up in the Worker's logs.
- Push requests no longer follow redirects (`redirect: 'manual'`), so a redirect from an allowed host cannot forward the VAPID-signed request elsewhere.
- `meter1` is described as the sanity check it is, and the meter's write cost is given for all searchable conferences together.
- `docs/contracts/people-api.md` says that a backend may refuse a push endpoint that is not on a known push service, which the Worker does with the frozen fixture's `push.example.org` endpoint. Tier 3 (`server/`) still accepts it; adopting the same rule there needs a fixture change in `contracts/` and edits to `test/contracts-people-conformance.test.mjs` and the `test/native-push-*.test.mjs` files, which belong to the session that owns those directories.

The checks were run again on this round: web tests 66 of 66, `npm test` 510 of 510, `ble-parity` 29 PASS and 0 FAIL, `tsc` clean, and the local smoke 98 PASS, 0 FAIL, 0 SKIP.
