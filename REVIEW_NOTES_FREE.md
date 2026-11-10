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
