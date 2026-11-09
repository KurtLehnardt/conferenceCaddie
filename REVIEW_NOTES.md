# Review notes (2026-11-09)

One reviewer (opus, highest effort, who wrote none of the code) reviewed the deployed service, revision `conference-caddie-00003-znn`. Its verdict was "Not ready to share yet" with 4 must-fix findings. This file lists every finding, what the fixer did about it, and what the reviewer verified as working. There was no second review round, as the master brief asks.

The fixes are in commit `9f8ac6d` on `main`, deployed as revision `conference-caddie-00004-mwl`, which runs as `caddie-runtime@project-9205d6eb-366e-4844-b77.iam.gserviceaccount.com`. The smoke test passed 35 of 35 checks locally (with the admin key in both key variables, and again with the two newly minted scoped keys) and 35 of 35 against the public URL, both before and after `caddie-talks-v1` was deleted.

## Findings

### 1. Rate limits used the client-sent X-Forwarded-For value (area 1, must fix): fixed in `9f8ac6d`

- What changed: one shared `clientIp` in `server/ratelimit.mjs` takes the last `X-Forwarded-For` entry, which Google's front end appends on a direct `run.app` request, caps it at 45 characters and falls back to the socket address. `server/people.mjs` and `server/recommend.mjs` (recommendations, topics and suggest) both use it; the two old copies that took the first entry are gone.
- Proof against the live service, with the reviewer's probe: 90 profile writes, each with a new random device and a new spoofed `X-Forwarded-For`, now give 60 × 400 and 30 × 429 (before: 90 × 400). 130 parallel `GET /api/topics` with a new spoofed value each give 60 × 200 and 70 × 429 (before: 130 × 200).
- Proof locally: with a rotating first entry and a fixed appended last entry, the write burst gives 60 × 400 and 30 × 429. 2000 requests with unique 14 KB `X-Forwarded-For` values grew the server's resident memory by about 11 MB, which is ordinary heap churn, because every value is capped to the same 45-character key.
- Not verified: that the last entry differs per client on Cloud Run. Only one client address was available, since this machine has no IPv6 route. This follows Google's documented behaviour and the reviewer's own observation.

### 2. Both deployed keys held monitor_inference (area 1, must fix): fixed in `9f8ac6d`

- Test first: a throw-away role, native user, API key and two-document `caddie-dev-inftest` index, all deleted afterwards. A key with no cluster privileges could still index into `semantic_text` (single document and Bulk), run `knn` with a `query_vector_builder` and run a `semantic` query. `GET /_inference/_all` and a direct inference call returned 403.
- Then both keys were re-minted without `monitor_inference` (`scripts/create-es-keys.mjs`), stored as new versions of `caddie-es-readonly` and `caddie-es-people`, and the two old keys were invalidated after the new revision was serving. The script's verify step now also checks that both keys get 403 on `GET /_inference/_all` and `false` from `_has_privileges` for `monitor_inference`, `cluster:monitor/xpack/inference/post` and `cluster:monitor/xpack/inference/unified`. All 14 checks pass.
- Proof: the full smoke test, including semantic search, For you and profile writes that embed text, passed locally with the new keys and against the deployed revision. The residual risk the reviewer allowed for is not needed.

### 3. Expired profiles were never deleted (area 1, must fix): fixed in `9f8ac6d`

- What changed: the server runs a people-key `_delete_by_query` on `visible_until < now` (and on documents without `visible_until`, which are never live) when it starts, which covers every cold start, and then once an hour on an unref'd timer. `npm run people:purge` (`scripts/purge-expired-people.mjs`) runs the same delete as an operator step after a conference.
- The first version asked for `refresh=true`, which the people key may not do (no `maintenance` privilege). The delete still happened but the request returned 403. The refresh was removed, because every query already hides expired documents.
- Proof: an expired, text-free test document was written with the admin key; a server started with the deployed people key logged "Deleted 1 expired people profiles." and the document then returned 404. The notices' promise ("until the conference ends") is now true.

### 4. Switching conference kept the previous conference's state (area 3, must fix): fixed in `9f8ac6d`

- What changed: `PeopleScreen`, `ForYouScreen` and `ProfileScreen` are keyed by the conference slug in `web/src/app.tsx`, so each conference starts with fresh state. The ended-talk banner ignores a pinned talk whose id does not start with the current conference's slug.
- Proof, with the reviewer's phone scripts pointed at a local build at 390×844: after "See who else was interested" on a KubeCon banner and a switch to MCP Dev Summit Nairobi, no banner shows (before: the KubeCon talk, and its share switch failed with 400). No KubeCon people appear under the MCP title at any 25 ms sample (before: up to 50 ms). No KubeCon talk appears on MCP's For you at any sample (before: up to 546 ms). No 4xx or 5xx responses and no page errors.

### 5. Text search always matches at least 50 talks (area 2, note): not fixed

This is a recorded design trade-off (`DECISIONS.md`, Search): the fixed `k` keeps `total` independent of `size`. Ranking is unaffected. A similarity threshold would need tuning per embedding model and was out of scope.

### 6. Topic lists contain filler words and fragments, and "Service Mesh" is missing (area 2, note): covered by the topic quality pass

A topic quality pass (stoplist, fix-ups, and collapsing unigrams that occur mostly inside a kept bigram) landed on `main` from pull request #1 while this fix was running. It removes "Us", "Who", "Through", "Use", "Minutes", "Time", "Smarter" and "Theater: Agent", merges "Multicluster" into "Multi-Cluster", and collapses "Cloud", "Native" and "Source". The fixer applied it to the live index with `npm run topics` for all three searchable conferences, because the smoke test checks the live list against the new stoplist (KubeCon now has 96 topics; the other two were unchanged). "Service Mesh" is still not a topic: fix-ups never add one, and it does not reach the three-talk threshold as a bigram.

That re-run removed topics that stored profiles already held (for example "open", "native" and "scale" in the 3 live non-sample profiles, none created by the fixer, and "agentic", "cost" and "data" in some sample profiles). So that those people can still save, commit `9f8ac6d` makes a save drop a topic the stored profile already holds but the conference no longer lists, while a new unknown topic still gets 400. This was proved locally: a stale stored topic was dropped with 200, and a new unknown topic got 400.

### 7. The visibility switch gives no feedback for 1 to 2 seconds (area 3, note): fixed in `9f8ac6d`

The switch now shows the requested state at once, and a "Saving…" line appears beside it while the save runs. On failure it returns to the stored state and the error message shows. The reviewer's probe now reads the switch as on after 23 ms (before: 1182 ms).

### 8. Topic chips move under the finger (area 3, note): not fixed

It is optional in the report and is a layout change to `TopicPicker.tsx` that pull request #1 also touched. The fixed-point tap probe still hits a chip only on the first tap. It is left for the stretch work.

### 9. The conference switcher stays open when the route changes (area 3, note): fixed in `9f8ac6d`

Any `popstate`, `hashchange` or in-app route change now closes the switcher and the talk sheet. In the reviewer's phone flow, "Delete my profile" after navigating with the switcher open now succeeds (before: the tap timed out behind the scrim).

### 10. The old runtime account keeps roles/admin and access to both secrets (area 1, note): partly fixed

The `secretAccessor` bindings for `caddie@project-9205d6eb-366e-4844-b77.iam.gserviceaccount.com` on `caddie-es-readonly` and `caddie-es-people` were removed; only `caddie-runtime@` remains on each. The account's project-level `roles/admin` was left unchanged: the reviewer marked it as the user's decision.

### 11. /api/search has no rate limit (area 1, note): fixed in `9f8ac6d`

`POST /api/search` now has the same per-address limit (60 per minute) as the other public endpoints, using the fixed `clientIp`. Live: 70 parallel searches with a new spoofed `X-Forwarded-For` each were limited (53 × 400 and 17 × 429; the smoke test had just used 7 tokens).

### 12. Cloud Run request logs keep topic type-ahead text (area 1, note): not fixed

The platform request log records the full URL, including `q`. The text is low-sensitivity, and moving type-ahead to a POST body would change the API contract, the client and the smoke test. Accepted as is.

### 13. The demo QR path in the master brief is not a known slug (area 3, note): not fixed in code

The QR code is not built yet. When the demo preparation builds it, it should point at `/e/kubecon-cloudnativecon-north-america-2026`, the live slug. No redirect was added.

### 14. A non-sample profile named "test" is live at KubeCon (area 2, note): not touched

It is probably the user's own phone test. Delete it from that phone (Profile, then "Delete my profile") before the demo. The fixer did not touch it.

## What the reviewer verified as working

- Runtime identity: the serving revision `conference-caddie-00003-znn` runs as `caddie-runtime@…`. That account has no project roles, no service-account IAM and no user-managed keys, and holds `secretAccessor` only on `caddie-es-readonly` and `caddie-es-people`. Cloud Run env holds only `ES_URL` and `ES_INDEX` as literals; both keys are mounted from Secret Manager.
- The admin key appears nowhere it should not. Its value, its secret part and the GC key were searched for, without printing, in the full git history (all refs, 35 commits), every file under the repo including all 16 worktrees, the scratchpad, the live bundle and 3000 lines of Cloud Run logs. None was found. Neither deployed key equals the admin key.
- The two scoped keys were not found in git history, the repo, the bundle or the logs.
- People key index scope: 403 on `caddie-talks`, `caddie-topics` and `caddie-conferences`, 403 on writing to `caddie-talks`, 403 on creating indices, 403 on cluster settings, 403 on creating API keys. It reads and writes `caddie-people` only.
- Read-only key: 403 on `caddie-people` and `caddie-people-v1`, 403 on deleting a talk, 403 on creating API keys.
- Entitlement on matches: no header gives 403; a truncated header, an id-only header and an over-long secret give 403; a forged unknown device gives 403 `visibility_required`; another profile's id with your own secret gives 403 `forbidden`; a device that shares but is not visible gives 403 `visibility_required`; a device visible at KubeCon gives 403 at MCP Dev Summit.
- Entitlement on circles: no header gives 403 with no count. A forged device and a device that did not share for the talk get 403 `share_required` with only `{error, count}`. Another id with your own secret gives 403 `forbidden`. A device sharing for T1 cannot read T2.
- Contact details: a non-visible sharer's contact never appears in matches, and is shown only to fellow sharers of that talk, by design. Turning visibility off removes the person and their contact from others' matches at once, and the person loses their own matches (reciprocity). Sharing and visibility stay independent.
- Another profile cannot be edited or deleted: PUT, DELETE and PUT with both choices off (the delete path), each with A's id and B's secret, all give 403, and A stayed intact. In a race of two parallel creates with the same `profile_id` and different secrets, exactly one wins (200 and 403); the winner's secret works and the loser's is rejected.
- No responses leak `secret_hash`, `text_hash`, `profile_id`, `*_semantic`, `visible_until`, or any device id or secret, across 60+ responses. Result keys are `ref`, `display_name`, `about`, `sample`, `learn_topics`, `speak_topics`, `reasons`, `opener` and `contact`.
- Delete takes effect at once: the profile disappears from the circle, the public count drops by one (10 to 9), and the deleted device gets 403.
- Expired profiles: an admin-inserted expired document was absent from matches, circles and counts.
- Cross-conference isolation: a KubeCon talk shared under MCP gives 400, a KubeCon topic under MCP gives 400, KubeCon talk ids under MCP count 0, and suggest ignores another conference's talks.
- Validation and caps: 51 shared talks, an unknown talk, 31 topics, an unknown topic, a 61-character name, an empty name, a 281-character about, a 121-character note, `javascript:` and foreign-host LinkedIn URLs, unknown top-level and profile keys, a non-boolean `open_to_meet`, an unavailable conference and a `__proto__` key all give 400. A 9 KB people body and a 5 KB search body give 413. Cross-origin gives 403, `text/plain` gives 415, and a header over 80 characters gives 403. Search size over 50 gives 400.
- Static serving: encoded traversal, `/server/*.mjs`, `/package.json`, `/.env`, source maps and `%00` all give 404 or 400. OPTIONS gives 405, and no CORS headers are sent.
- Security headers on HTML and API responses: CSP (`default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`; `style-src` allows `'unsafe-inline'` for Preact style attributes), `nosniff`, HSTS, `Referrer-Policy` and `Permissions-Policy`. The theme script is external, with no inline script.
- Live bundle: no `ApiKey`, `.es.io`, `AIza`, private key, `MOCK_FIXTURE`, `secret_hash`, `text_hash`, source map, or clash, conflict, agenda or overlap wording. `innerHTML` occurs only inside the Preact runtime.
- Logs: app lines are only method, path, status and duration. No profile text, sample text, real profile text, contact strings, `X-Caddie-Device` or key values appear in 3000 log lines. Real non-sample profile text is not in git history, the logs or the bundle.
- Search correctness: browse and text search on all three searchable conferences return only that conference's talks. Topics, type-ahead and suggest are per conference. An unavailable conference gives 400 on search.
- For you (API): never returns ended talks or marked talks, never returns another conference's talks, and returns `needs_profile` for an empty profile. Every why topic is a real topic of that talk. Text-only requests return a real abstract passage.
- Matches reasons name the real intersecting topics ("They can speak to eBPF and Security…"). The passage reason comes from the other person's own text, and the shared-talk reason names the real talk title.
- No clash or agenda logic or wording remains in server, web, README or API responses. It appears only in `DECISIONS.md` history and raw feed data.
- Runtime rate limiting works when the `X-Forwarded-For` value is held constant: topics 25 × 200 then 429 in a parallel burst; writes 60 then 429.
- Phone flow at 390×844, light and dark: landing on `/` redirects to `/e/kubecon…-2026#/people` in 868 ms. 10 learn topics, type-ahead ("ebp" finds eBPF), 3 speak topics, visibility, People to meet with Sample badges and reasons, marking a talk, sharing with notice, "See who's here" circle (2 speakers, 8 members), Interested list with badge, the For you row and screen with reasons, ended-talk banner, conference switch with MCP times in GMT+3, and the unavailable conference linking out all work. No page errors, no horizontal page overflow, no visible targets under 44 px. API medians are 100 to 200 ms; only the first profile create (embedding) exceeds 1 s, at 1.2 to 2.1 s.
- Cleanup: every reviewer test profile (API probes, the expired document and 4 UI profiles) was deleted. `caddie-people` again holds the 30 samples plus 2 pre-existing non-sample profiles, which were not touched. No `caddie-dev-review*` index exists. The local server on 8150 is stopped, no review processes are running, and the scratch file with profile data was deleted.

## After the fixes

- `caddie-talks-v1` was deleted with the admin key, as the user approved once the review passed. Before that, the alias `caddie-talks` pointed only at `caddie-talks-v2`, `caddie-talks-v1` had no alias, and nothing in the repository's code or configuration or in the deployed environment (`ES_INDEX=caddie-talks`) named it; only `DECISIONS.md` history did. The remote smoke test passed 35 of 35 again afterwards.
- The fixer's test profiles, test documents, throw-away role, user, key and `caddie-dev-inftest` index were all removed. No `caddie-dev-*` or `caddie-topicwork-*` index remains.
