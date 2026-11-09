# Decisions

This file records the decisions and fallbacks taken while building Conference Caddie, especially where they depart from, or add detail to, `docs/CONTRACT.md`. It is grouped by area.

## Data

- The five category groups in the feed are assigned by title. "All Sessions" is the track group, and every session has exactly one item in it. "Audience Level" is the level group. "End User Programming", "Solutions Showcase Programming" and "Presentation Slides" are flag groups. `scripts/build-data.mjs` exits with an error if a group ever fits none of these roles.
- Slides are confirmed. Category item 523121 is "Slides Attached" and question 137003 is "Presentation Slides". `slides_url` is the answer to question 137003 when it starts with http or https, and `has_slides` is true exactly when `slides_url` is set. That gives 112 sessions with slides, all of them talks.
- The feed's "Slides Attached" category is stale: only 54 sessions carry it, but 112 have a slides link. The `flags` array therefore includes "Slides Attached" whenever a slides link exists, so the flag always agrees with `has_slides`.
- The America/Denver offset is computed per instant with `Intl.DateTimeFormat` (`timeZoneName: "longOffset"`), not hardcoded. All sessions fall on 8 to 12 November 2026, so every offset is -07:00. `day`, `start_minutes` and `end_minutes` come from the venue-local clock.
- Kind rules, where the first match wins: an item is `housekeeping` when its description is empty and its title is an opening, closing, welcome, remarks or wrap-up; `break` when it has no speakers and its title (the part before any " | ") names coffee, lunch, breakfast, registration, a badge, a coat or bag check, snacks or a reception, or its track is Breaks or Registration; `talk` when it has at least one speaker; and `ambient` otherwise.
- The brief's talk rule needs both a speaker and a description, but four real sessions have speakers and no description (three keynotes and CNCF Bingo). They are kept as talks with an empty abstract, because dropping real keynotes from search is worse. This is a deliberate departure from the brief.
- Only the title before " | " is tested for break words. Without this, co-located events with the suffix "SEPARATE REGISTRATION REQUIRED" were wrongly classified as breaks.
- An item is sponsor content when its track is "Sponsor Demo Theater" or "Sponsor-hosted Co-located Events", or its title contains "sponsored by", "sponsored keynote" or "in-booth demos". Descriptions are not used, because a boilerplate sentence about sponsored content appears in many unrelated descriptions. That gives 62 sponsor items, of which 39 are talks. No keynote is flagged as sponsored.
- Titles and descriptions are trimmed, line endings are normalised to LF, and an empty description becomes an empty string. Track names keep the feed's emoji prefixes, for example "📚 Tutorials".
- The counts are 484 talks, 76 ambient items, 21 breaks and 19 housekeeping items, 600 in total. `DATA_NOTES.md` has the details.

## Search

- **Index.** In the MVP the real index was `caddie-talks-v1` behind the alias `caddie-talks`. Phase 2 moved the alias to `caddie-talks-v2`, which holds every feed item of every searchable conference; every search filters on `conference` and `kind: talk`.
- **Mapping.** The mapping uses `dynamic: false` instead of `strict`, so an extra field in `talks.ndjson` is stored in `_source` but never blocks ingestion. `title`, `abstract` and `speaker_taglines` use the english analyzer and `speakers` uses the standard analyzer.
- **Embedding model.** The `semantic_text` field has no explicit `inference_id`, so it uses the cluster default, `.jina-embeddings-v5-text-small`, a dense embedding model. No chat, completion or rerank endpoint is used anywhere.
- **No fallback was needed.** Semantic search, `copy_to` into `semantic_text`, an `rrf` retriever with a filter, aggregations with `rrf` and highlighting with `rrf` all work in one request on Elasticsearch 9.5.6. The lexical-only fallback was not taken.
- **Semantic retriever.** The contract asks for a `semantic` query. The server instead runs a `knn` query on the `semantic_text` field with `k` 50 and `num_candidates` 200, and Elasticsearch builds the query vector from the field's own inference endpoint. A `semantic` query on a dense field sizes its neighbour set from the request size, so `total` would change when `size` changed; a fixed `k` avoids that. This is still hybrid search with the same model, combined with the lexical query by an `rrf` retriever (`rank_window_size` 50, default `rank_constant`).
- **kNN pre-filter.** The knn query is pre-filtered only by the base filters: talks only, the conference, the start-time window and sponsor hiding. Day, track, level and slides selections are applied afterwards by the `rrf` retriever's filter. This keeps the nearest-neighbour set the same whatever the user selects, so the count shown next to a facet value is exactly the total the user gets after selecting it. The cost is some semantic recall under a narrow selection.
- **Lexical matching.** The `multi_match` over `title^2`, `abstract`, `speakers` and `speaker_taglines` uses `minimum_should_match: "2<60%"`. Queries of one or two terms must match every term, and longer queries must match 60% of them. Without this, a long natural-language query such as "making my cluster greener and using less energy" matched hundreds of talks on a single common word, and the right talk (the Kepler lightning talk) fell to rank 18. With it, the Kepler talk ranks first and no tested query got worse.
- **Facets and total.** Let M be the documents the main query matches: for a text query, the lexical matches plus the 50 nearest neighbours among documents that pass the base filters; in browse mode, every talk. Let B be the base filters and S(g) the selection in facet group g (day, track, level, has_slides). Then `total` = |M ∩ B ∩ every S(g)|, and the counts for group g are a terms aggregation over M ∩ B ∩ S(every other group). They are computed in one `_msearch`: the main query plus one size-0 query for each facet group that has a selection. `post_filter` is not used, because it would run after the neighbour search and lose recall. Because the start-time window is a base filter, the Morning and Afternoon totals of a text query need not add up to the unfiltered total; the time chips show no counts, so the UI shows no contradiction.
- **Text-query totals.** A text query's total is the lexical matches plus up to 50 semantic neighbours, so typical totals are about 50 to 120 even for a narrow query.
- **Saved talks.** The MVP removed saved talks and every talk overlapping them in time. The direction change of 2026-11-09 removed that filter: `saved_talk_ids` is still validated but never filters anything.
- **Browse mode.** An empty query is a bool filter query sorted by `start` ascending, then `talk_id`, by Elasticsearch.
- **Evidence.** Evidence prefers a highlighted abstract fragment, then a highlighted title, then the best semantic chunk, then the start of the abstract (`no_match_size` 200), then the title. The title reaches the semantic field as its own chunk through `copy_to`, so a semantic chunk that only repeats the title is skipped in favour of the best abstract chunk. The semantic highlighter ignores `encoder: html`, so the server HTML-escapes the semantic chunk itself, collapses its whitespace and cuts it to 300 characters at a word boundary. This only chooses the evidence text and never changes ranking.
- **Ranking.** All ranking happens in Elasticsearch. The server never reorders hits, and the browser never filters or reorders results.

## API

- Known values for `day`, `track` and `level` come from terms aggregations over `kind: talk` and are cached in memory for 10 minutes. A failed fetch is not cached. Track or level values that appear on no talk (for example "Breaks") get a 400, so the UI only offers values taken from the response facets.
- A selected day, track or level value with no matching documents is still listed in its facet with count 0, so the UI can show it as selected. `has_slides` always returns both true and false. Day is sorted by value ascending; track and level keep Elasticsearch's count-descending order.
- Every Elasticsearch failure returns `{"error":"Search is temporarily unavailable"}` with status 502. The Elasticsearch error body is never forwarded, and the log line holds only the status and a short cause such as "timeout".
- Each text query runs one embedding inference per `_msearch` item: one, plus one for each facet group that has a selection, so at most five.
- The request log has one line per request with the method, path, status and duration. It never holds search text, headers, bodies or keys. This was checked on the local run log.

## Frontend

- The app uses Vite 8, Preact, TypeScript and `lucide-preact`. JSX is compiled with Vite's built-in oxc option instead of `@preact/preset-vite`, so the only runtime dependencies are `preact` and `lucide-preact`.
- The search state lives in the App component, so results survive tab switches. Saving or removing a talk does not re-run the search, so a card never vanishes under the user's finger. Instead, cards that overlap a saved talk show "Overlaps a talk in your agenda"; this compares times in the browser as a display hint only. The search re-runs when the user returns to the Search tab after the saved set changed, after Build my agenda, and on any query or filter change.
- Build my agenda requests 30 results with the current query, filters and `saved_talk_ids`, walks them in the order returned, skips clashes with saved talks and earlier picks, saves up to five, shows "Added N talks to your agenda" with Undo, and re-runs the search. If nothing fits, a toast says so.
- Normal searches request 20 results. Track and level chips equal to "Not specified" are hidden on result cards. Facet options with a zero count are hidden unless selected, and a selected value missing from the facets is shown with a count of 0.
- The accent color is #2457D6 in light mode and #85A8FF in dark mode. The `theme-color` metas are #f5f6f8 and #0f1115, and the app rewrites both when the user forces a theme.
- The app version comes from `web/package.json` through a Vite define.
- Plain headless Chrome could not render a 390px-wide viewport, so the frontend was screenshotted with `playwright-core` driving the installed Chrome at 390x844 in light and dark mode and at 1280 wide. No browser was downloaded.
- The production bundle has no mock data: `grep -r MOCK_FIXTURE_DO_NOT_SHIP web/dist` finds nothing, and the smoke bundle check confirms it.

## Deploy

- Both Dockerfiles use `node:26-slim`, which matches the local Node 26. If 26 is not the current LTS line, the `FROM` lines can change to `node:24-slim`.
- The root Dockerfile builds `web/` with `npm ci` against the committed `web/package-lock.json`, then copies only `package.json`, `server/` and the built `web/dist` into the runtime image. `data/` and env files are never copied. The image was built and run locally on port 8084, where `/api/health`, the app and a search all worked.
- `.dockerignore` and `.gcloudignore` are identical and exclude `data/`, `docs/`, `.claude/`, env files, logs, `node_modules`, `web/dist` and credential patterns.
- `scripts/deploy.sh` uses the service account named by `GC_SERVICE_USER` as the runtime identity when it exists, and otherwise the default compute service account. It prints only which of the two it chose. The service runs with `--min-instances 0`, `--max-instances 2`, 1 CPU and 512 MiB, so it scales to zero when idle.
- **Blocked on Google Cloud authentication.** No gcloud account is active on this machine, so no Google Cloud call has been made: the APIs are not enabled, the hello-world service and the real service are not deployed, and the read-only key has not been created. After `gcloud auth login`, the remaining steps are to enable the Run, Cloud Build, Artifact Registry and Secret Manager APIs, create the read-only key into Secret Manager, grant the runtime service account `roles/secretmanager.secretAccessor` on that secret, run `npm run deploy`, and run the smoke test against the public URL.
- Colima was started during the deploy track so that Docker could run. It also started an existing, unrelated container. It was left running.

## Security

- The admin key in `ELASTISEARCH_API_KEY` is used only for index setup, ingestion and local runs, where it is passed inline in the command or through a child process's environment. It is never written to a file, printed or deployed.
- The deployed service will use only a read-only key read from the Secret Manager secret `caddie-es-readonly`. Because an API key cannot mint a derived key with privileges, the plan is to create a role with `read` and `view_index_metadata` on `caddie-*`, a native user with that role and `manage_own_api_key`, and to mint the key as that user. The user's password is generated in memory and replaced with a discarded random value afterwards. This step waits on Google Cloud authentication.
- The browser never holds a key and never calls Elasticsearch. The server sets the contract's Content-Security-Policy and the other security headers on every response, and the built app has no inline scripts and no external origins.
- Every commit was checked with `git diff --cached` against the values of `ELASTISEARCH_API_KEY` and `GC_API_KEY` before it was made. The smoke test scans `web/dist` for those values and for key-shaped strings.

## Smoke test

`scripts/smoke.mjs` uses five attendee-style queries. The first three have no useful words in common with their talk and pass only through semantic matching; lexical search alone does not return their talk at all.

| Query | Expected talk |
|---|---|
| making my cluster greener and using less energy | Monitoring Power at Planet Scale with Kepler |
| supporting autistic and ADHD colleagues on my team | Neurodivergent Minds with Wings: Engineering Independence at Work |
| a personal fitness trainer bot for marathon training | I Built an AI Running Coach: A Personal kagent Agent in Production |
| what does each LLM token cost me | Clueless About The Cost of AI Model Usage? OpenCost+llm-d = first of a kind inference cost tracking |
| how do I start contributing to the kubernetes project | Kubernetes 101: New Contributor Orientation |

Run it with `BASE_URL=http://localhost:8080 npm run smoke`. Set `SMOKE_SKIP_BUNDLE=1` when `web/dist` has not been built. It retries a request once on a 5xx or network error, because connections to Elastic Cloud were sometimes slow. The full smoke test, including the bundle check, passed against the merged build on 2026-11-09.

## Direction change: people first, no scheduling (2026-11-09)

- The user changed the product's purpose. Conference Caddie now answers "Who here should I talk to?" first and "Which talks would I like?" second. It is not a scheduling tool, because each conference's official schedule already handles calendars and clashes.
- Removed: "Build my agenda", the saved-talk `must_not` time-overlap filter in `server/search.mjs`, its effect on facets, the "Overlaps a talk in your agenda" hint, every clash warning and every "conflict-free" or agenda-building wording. The stretch items "shareable agenda" and anything about agenda building are dropped.
- "Saved agenda" becomes "Interested": a plain list of marked talks in time order, on the device only. `POST /api/search` still accepts `saved_talk_ids` so older clients keep working, but no longer filters on it.
- Every talk links to its official session page with the label "Add to my schedule on the official site".
- Navigation order is People, For you, Search, Interested, and the home screen leads with people and suggested talks.
- New parts: conference topics built from talk titles, profiles with topic chips, People to meet, talk circles and Talks for you, all described in `docs/CONTRACT.md`.

## Phase 2: any Linux Foundation conference on Sessionize

- Phase 2 means "works for any Linux Foundation conference whose schedule is on Sessionize". Letting people sign in and add their own conferences is deferred to a separate project, saved in `docs/FUTURE_user_added_conferences.md`. The conference document keeps a `source` field, with `sessionize` as the only value, so that project is not blocked.
- Conferences are discovered from the LF events list and each schedule page's `data-sched-config`. The API code is never guessed. Events without a Sessionize config or without a schedule are listed as "Schedule not available here yet" with a link to the official schedule.
- The slug is derived from the event name plus the start year, because the LF list has no slug.
- The time zone comes from Sessionize's `api/data` Windows zone, mapped to IANA through the CLDR table in `data/windows-zones.json`, else from the operator file `data/conference-overrides.json`. It is never guessed. PyTorch Day Japan's Sessionize site is unpublished and gives no zone, so the override maps it to Asia/Tokyo.
- Track is the group named by `primaryFilterTitle`, level is a group whose title contains "level", and every other visible group becomes generic tags stored as a U+001F-separated keyword plus a display object. No KubeCon-specific category name or id remains in code.
- Sponsor detection was generalised to any category item or group named "sponsor", which now also flags sponsored keynotes (72 sponsor items on KubeCon).
- `presentationSlidesQuestionId` in the config is a question title, so it is matched as a title.
- Talk ids are `{conference}:{session_id}`. The old `caddie.saved.v1` data is not migrated.
- Ingestion is safe to re-run: unchanged sessions are skipped by `content_hash`, metadata-only changes use a Bulk partial `update` that omits `title` and `abstract`, and the Update API is never used because it re-runs inference.
- `filters.level` may be an empty array for a conference without a level group, so the frontend can always send the full filters object. `saved_talk_ids` must carry the request's conference prefix.

## Topics

- Topics are analysed in Elasticsearch in a temporary work index per conference: a curly-apostrophe fix, the standard tokenizer, lowercase, stop (`_english_` plus `config/topic-stoplist.txt`), a possessive strip, a filter that drops numbers and single characters, and shingles. The stop and length filters leave position gaps, so a bigram never spans a removed word. Counting uses a terms aggregation on the analysed title with `fielddata`, so neither the `_analyze` nor the script-counting fallback was needed.
- Labels come from `_mtermvectors` offsets on the original titles; the most common casing wins.
- Lucene's English stopword list is short, so words such as "from", "what" and "when" passed the analyser. Per-conference fix-up files in `data/topics/` remove them and merge plurals and synonyms as aliases (for example k8s into Kubernetes). Fix-ups exist for KubeCon, MCP Dev Summit Nairobi and PyTorch Day Japan. A fix-up never adds a topic.
- Talks get their `topics` through a Bulk partial update, so tagging never re-embeds anything. Topic documents are rewritten only when they differ, so a re-run writes nothing.

## People and talk circles

- There is no sign-in. On first opt-in the device generates a random `profile_id` and secret; the server stores only `sha256(secret)` and requires the secret for every write and every circle read. The first write uses `op_type: create`, so an existing profile can never be taken over.
- Conference-wide matches are reciprocal: a person sees matches only while they are visible conference-wide themselves. Sharing for one talk and conference-wide visibility are independent; sharing never puts a profile in conference-wide matches.
- A match reason names a shared talk only when the requester has also shared for it, so matches never reveal a circle the requester has not joined.
- The semantic people retrievers use a `knn` query on the `semantic_text` fields, as talk search does. Circles add a match-all retriever so every sharer is listed, below everyone who shares something with the requester.
- Profile writes whose text is unchanged use a Bulk partial update without the text fields, so toggling visibility or sharing never re-embeds anything.
- Profiles expire at 23:59:59 on the conference's last day in its own time zone, and every people query filters on that.
- The 30 seeded sample profiles for KubeCon are labelled "Sample · ..." with the contact note "Sample profile, not a real person". Several share for the same three talks. Sample topics that are not topics of the conference are skipped with a warning.
- Rate limits: people writes 20 per minute per device and 60 per IP; matches and circle members 30 per device and 90 per IP, because many attendees share a conference NAT; counts, recommendations and topics 60 per IP.

## Talks for you

- Elasticsearch 9.5.6 supports per-retriever `weight` in `rrf` in the wrapped form `{ "retriever": ..., "weight": n }`. Learn topics and interests have weight 1; speak topics and expertise have weight 0.5.
- Suggestions exclude ended talks (`end > now`) and talks the user already marked. Nothing in the request is stored or logged.
- `circle_count` uses the people key. If the people index cannot be read, every count is 0 and the suggestions still return.

## Integration of phase 2 and people first

- The talks index was rebuilt as `caddie-talks-v2` from the committed raw files with `--no-fetch`. The first ingest embedded 600 KubeCon, 60 MCP Dev Summit Nairobi and 19 PyTorch Day Japan documents. A second run of all three reported 0 index and 0 update operations, so it made no model calls. The alias `caddie-talks` was then switched to `caddie-talks-v2` in one atomic call.
- Open Source Summit Japan (a Sched page, no Sessionize config) and Yocto Project Virtual Summit (no schedule URL) are indexed as unavailable conferences. `--all-upcoming` was not run.
- In the saved-ids check, the smoke test compares text queries only by their totals and compares the browse listing in exact order, because two identical text requests can order tied semantic scores differently.
- `caddie-talks-v1`, the MVP index, was kept after the smoke test passed instead of being deleted. The deployed MVP service still reads the `caddie-talks` alias, and keeping v1 allows switching the alias back until the new server is deployed. Deleting it is irreversible, so it waits for the user's confirmation.
- The smoke test creates its own test profiles with random secrets and deletes them at the end. It writes one expired profile straight to Elasticsearch, because the API can never create one, and removes it afterwards.
