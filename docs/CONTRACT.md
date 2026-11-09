# Conference Caddie build contract

This file pins the decisions that every task builds against. A task may add to it in its own output, but must not change a field name or its meaning. The brief (`SPEC.md`) states the goals and the four non-negotiable rules. Phase 2 extended the MVP to any Linux Foundation conference whose schedule is on Sessionize, and the product direction of 2026-11-09 made it people first: "Who here should I talk to?" comes before "Which talks would I like?", and the app is not a scheduling tool. Where an older document disagrees with this contract, this contract wins.

## Facts

- Elasticsearch 9.5.6 runs on Elastic Cloud Hosted (GCP us-west1) at `https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443`. The URL is not a secret.
- The admin credential is in env var `ELASTISEARCH_API_KEY`, already encoded, sent as `Authorization: ApiKey $ELASTISEARCH_API_KEY`. It is never deployed.
- An API key cannot create a derived API key that has privileges. Scoped keys are minted by creating a role and a native user, authenticating as that user, and minting the API key as that user. The password is generated in-process and never printed or stored.
- The only model the app uses is the embedding model behind `semantic_text` (the cluster default, `.jina-embeddings-v5-text-small`). **Never call a chat, completion or rerank endpoint.** The Elastic trial limits model usage, so unchanged documents are never re-embedded.
- Schedule data comes from the Linux Foundation events list and each event's Sessionize feed, fetched only by the ingestion CLI on an operator's machine. Raw responses are committed under `data/raw/`. The deployed app never calls a feed.
- Google Cloud project id is `project-9205d6eb-366e-4844-b77` and the region is `us-west1`.

## Repository layout and ownership

| Path | Owner |
|---|---|
| `scripts/es-setup.mjs`, `server/search.mjs`, `server/conferences.mjs` | data model, search and conferences API |
| `scripts/ingest.mjs`, `scripts/lib/**`, `scripts/build-windows-zones.mjs`, `data/**` (except `data/topics/**` and `data/samples/**`), `DATA_NOTES.md` | discovery and Sessionize importer |
| `scripts/topics.mjs`, `config/topic-stoplist.txt`, `data/topics/**` | conference topics |
| `server/people.mjs`, `server/device.mjs`, `server/ratelimit.mjs`, `scripts/es-setup-people.mjs`, `scripts/seed-people.mjs`, `scripts/export-people.mjs`, `data/samples/**` | people and talk circles |
| `server/recommend.mjs`, `server/topics-api.mjs` | talks for you and the topics API |
| `web/**` except `web/src/people/**` | frontend shell |
| `web/src/people/**` | frontend people screens |
| Root `package.json`, `.gitignore`, `README.md`, `docs/CONTRACT.md`, `DECISIONS.md`, `scripts/smoke.mjs`, `server/index.mjs`, `Dockerfile`, `scripts/deploy.sh` | integrators |

The repo root has no npm dependencies: scripts and the server use only Node built-ins. The `web/` app has its own `package.json` and lockfile.

Root `package.json` scripts:

```json
{
  "es:setup": "node scripts/es-setup.mjs",
  "ingest": "node scripts/ingest.mjs",
  "zones": "node scripts/build-windows-zones.mjs",
  "topics": "node scripts/topics.mjs",
  "people:setup": "node scripts/es-setup-people.mjs",
  "people:seed": "node scripts/seed-people.mjs",
  "people:export": "node scripts/export-people.mjs",
  "start": "node server/index.mjs",
  "dev:web": "npm --prefix web run dev",
  "build": "npm --prefix web ci && npm --prefix web run build",
  "smoke": "node scripts/smoke.mjs",
  "deploy": "bash scripts/deploy.sh"
}
```

## Files under data/

```
data/
  raw/
    lf-events-upcoming.json        the LF list as fetched by the last run
    {slug}/
      lf-event.json                the LF list entry for this event
      schedule-page.html           cta_schedule_url as fetched
      sched-config.json            the parsed data-sched-config JSON
      view-all.json                https://sessionize.com/api/v2/{apiCode}/view/All
      api-data.json                https://{publicSlug}.sessionize.com/api/data
  {slug}/
    talks.ndjson                   one normalised talk document per line
    conference.json                the conference document as indexed
  topics/{slug}.json               optional topic fix-ups for one conference
  samples/people.json              the 30 sample profiles
  windows-zones.json               { "<Windows zone>": "<IANA zone>" }, from CLDR territory 001
  conference-overrides.json        { "<slug>": { "time_zone": "<IANA zone>" } }, operator-maintained
  exports/                         git-ignored output of export-people
```

Files for an unavailable event stop at the step that failed. `conference.json` is always written.

## Indices

Every index is versioned behind an alias. The server reads alias names from env: `ES_INDEX` (default `caddie-talks`), `ES_CONFERENCES_INDEX` (default `caddie-conferences`), `ES_TOPICS_INDEX` (default `caddie-topics`) and `ES_PEOPLE_INDEX` (default `caddie-people`). Development indices are named `caddie-dev-<task>*` and are deleted when the task ends. The topics command uses a temporary work index `caddie-topicwork-{slug}` and deletes it in all cases.

### Conferences: `caddie-conferences-v1` behind `caddie-conferences`

`_id` is the slug. Mapping (`dynamic: false`): `slug`, `name`, `status`, `status_reason`, `source`, `time_zone`, `parent_slug` as keyword; `start_date`, `end_date` as `strict_date`; `ingested_at`, `raw_fetched_at` as date; `time_zone_windows`, `sessionize_api_code`, `sessionize_public_slug`, `lf_url`, `official_schedule_url` as keyword with `index: false`; `sessionize_site_published` boolean and `lf_event_id` long, both `index: false`; `location`, `category_mapping` and `counts` as objects with `enabled: false`.

| Field | Rule |
|---|---|
| `slug` | `slugify(name)` plus `-{year}` from `start_date` unless already present; regex `^[a-z0-9][a-z0-9-]{0,119}$`. |
| `name` | LF `name`, trimmed. |
| `status` | `searchable` only when every talk document of the event was indexed in this run (or skipped as unchanged) and a time zone was resolved; else `unavailable`. |
| `status_reason` | `no_schedule_url`, `no_sched_config`, `shares_feed`, `time_zone_missing`, `time_zone_unmapped`, `fetch_failed`, `embedding_limit` or `partial_index`; null when searchable. |
| `source` | `sessionize`, the only value. It is kept so other sources can be added later. |
| `start_date`, `end_date` | `YYYY-MM-DD` from the LF list. |
| `time_zone` | From `data/windows-zones.json[api-data.timezone]`, else `data/conference-overrides.json[slug].time_zone`, else null. Must pass `Intl`. |
| `location` | `{ city, region, country, virtual }` from the LF list. |
| `sessionize_api_code`, `sessionize_public_slug` | From the page's `data-sched-config` only. Never guessed. |
| `sessionize_site_published` | True when `api-data.timezone` is a non-empty string. |
| `official_schedule_url` | LF `cta_schedule_url`, else the LF `url`. |
| `parent_slug` | Set on an entry whose apiCode duplicates an earlier entry's. |
| `category_mapping` | `{ track_group, level_group, tag_groups, hidden_groups, slides_question }`, names copied from the feed. |
| `counts` | `{ sessions, talk, ambient, break, housekeeping, with_slides, sponsor }`. |

### Talks: `caddie-talks-v2` behind `caddie-talks`

`_id` is `talk_id` = `{conference}:{session_id}`. One document per feed session of every kind. Mapping (`dynamic: false`):

| Field | Mapping | Rule |
|---|---|---|
| `talk_id`, `conference`, `kind`, `room`, `track`, `level`, `tag_keys`, `day`, `topics` | keyword | |
| `session_id`, `slides_url`, `url`, `content_hash`, `text_hash` | keyword, `index: false` | `session_id` is never returned by the API. |
| `title`, `abstract` | text (english), `copy_to: semantic` | Trimmed, CRLF to LF, null description to `""`. |
| `semantic` | `semantic_text`, default endpoint | |
| `speakers` | text | Resolved names, in session order. |
| `speaker_taglines` | text (english) | |
| `tags` | object, `enabled: false` | `[{ group, value }]` for every item in every non-track, non-level, non-hidden group. `tag_keys` is `group + "\u001f" + value`. |
| `speaker_profiles` | object, `enabled: false` | `[{ name, tagline, links: [{ title, url }] }]` from the feed's speakers, http(s) links only. Public feed data, used to list a circle's speakers. |
| `sponsor`, `has_slides` | boolean | |
| `start`, `end` | date | ISO 8601 with the event zone's offset at that instant, through `Intl`. |
| `start_minutes`, `end_minutes` | integer | Venue-local clock. |
| `ingested_at` | date, `index: false` | |

- `kind` is `housekeeping`, `break`, `talk` (at least one speaker) or `ambient`, first match wins; the rules are in `DATA_NOTES.md`.
- `track` is the first item of the group named by the config's `primaryFilterTitle` (else the first visible group), or `"Not specified"`. `level` is null when the conference has no group whose title contains "level".
- `url` is the session page on the public Sessionize site when it is published, else the conference's official schedule URL.
- `topics` holds the `topic_id`s found in the title. Only the topics command writes it, through a Bulk partial `update`.
- `text_hash` = `sha256(title + "\n" + abstract)`. `content_hash` = `sha256` of the canonical JSON of every built field except the hashes, `ingested_at` and `topics`.

### Topics: `caddie-topics-v1` behind `caddie-topics`

`_id` is `{conference}:{topic_id}`. Mapping (`dynamic: false`): `conference`, `topic_id`, `label_exact` keyword; `label`, `aliases` `search_as_you_type`; `talk_count`, `rank` integer.

- Built by `node scripts/topics.mjs --event <slug> [--talks-index name]` from that conference's `kind: talk` titles. Analysis in Elasticsearch: standard tokenizer, lowercase, stop (`_english_` plus `config/topic-stoplist.txt`), no stemming, unigrams and bigrams that never span a removed word, and no numbers or single characters.
- A terms aggregation counts talks per term. Terms in at least 3 talks are kept, at most 150, ranked by `talk_count` descending, then label. `topic_id` is the term with spaces replaced by `-`. The label is the most common original casing.
- `data/topics/{slug}.json` is `{ "rename": { id: label }, "merge": { alias_id: canonical_id }, "remove": [id] }`. A fix-up never adds a topic.
- The command replaces the conference's topic documents only when they differ, and updates `topics` on talks only where the value changed. The ingestion CLI runs it after every successful event.

### People: `caddie-people-v1` behind `caddie-people`

`_id` is `{event_id}:{profile_id}`. Mapping (`dynamic: false`):

| Field | Mapping |
|---|---|
| `event_id`, `profile_id`, `learn_topics`, `speak_topics`, `shared_talk_ids` | keyword |
| `display_name` | text with a `keyword` subfield |
| `about`, `interests`, `expertise` | text, each `copy_to` `about_semantic`, `interests_semantic` or `expertise_semantic` (`semantic_text`, default endpoint) |
| `open_to_meet`, `sample` | boolean |
| `visible_until`, `updated_at` | date |
| `linkedin_url`, `contact_note`, `secret_hash`, `text_hash` | keyword, `index: false` |

- A document exists only while `open_to_meet` is true or `shared_talk_ids` is not empty; otherwise the server deletes it.
- `visible_until` is 23:59:59 on the conference's `end_date` in its `time_zone` (UTC-12 when the zone is unknown). Every people query filters on `event_id` and `visible_until > now`.
- Expired documents are deleted, not only hidden: the server runs a delete-by-query on `visible_until < now` (and on documents without `visible_until`) when it starts and once an hour, and `npm run people:purge` runs the same delete from the CLI.
- `secret_hash` is `sha256(secret)` in hex. `text_hash` is `sha256(JSON [about, interests, expertise])`. Writes whose text is unchanged use a Bulk partial `update` without the text fields, so nothing is re-embedded.

## Indexing rules

- Before bulk operations for an event, the CLI reads the stored `content_hash` and `text_hash` of that conference (at most 10000) and aborts the event above that.
- Per document: absent gives bulk `index`; equal `content_hash` is skipped; equal `text_hash` only gives a bulk `update` without `title` and `abstract`; otherwise bulk `index`. Stored ids missing from the feed are deleted. The Update API is never used, because it re-runs inference.
- Batches of 50, exponential backoff on 429, and a stop at the embedding limit with the conference marked `embedding_limit`.
- A second run over unchanged raw files makes zero model calls. The CLI prints a `bulk ops:` line to prove it.

## Ingestion CLI

`node scripts/ingest.mjs <mode> [options]`. Modes: `--list`, `--event <slug>` (repeatable), `--all-upcoming`. Options: `--index`, `--conferences-index`, `--dry-run`, `--no-fetch` (build from the committed raw files with no network call), `--skip-topics`.

- User-Agent `ConferenceCaddie-ingest/0.2 (+https://github.com/KurtLehnardt/conferenceCaddie)`, one fetch per URL per run, a 1000 ms pause after each call and a 30 s timeout.
- Co-located events whose feed duplicates another event's apiCode become `unavailable` with `shares_feed`.
- Exit 0 when every event ended searchable or unavailable for a non-error reason; 1 on a fatal error; 2 on an embedding stop, `partial_index` or `fetch_failed`.

## API

Every search, aggregation and lookup the server runs filters on one conference. Errors are `{"error": "..."}`: 400 for invalid input, 403 for a missing or wrong device secret or a cross-origin write, 413 for a body that is too large, 415 for a wrong content type, 429 with `Retry-After` over a rate limit, and 502 with a fixed message when Elasticsearch fails. Elasticsearch error bodies are never forwarded.

### `POST /api/search`

```json
{ "conference": "mcp-dev-summit-nairobi-2026",
  "query": "securing MCP servers",
  "filters": { "day": null, "start_after": null, "start_before": null,
               "track": [], "level": [], "tags": [], "has_slides": null,
               "hide_sponsor": false },
  "saved_talk_ids": [], "size": 10 }
```

- `conference` is required and must be a `searchable` conference; otherwise 400 and no search runs.
- `query` is at most 200 characters. An empty query is browse mode, sorted by `start`.
- `filters.level` must be empty for a conference without a level group. `filters.tags` holds at most 50 `{ group, value }` pairs, each a known `tag_keys` value; pairs in one group are ORed and groups are ANDed. Known values come from one aggregation per conference, cached for 10 minutes.
- `filters.happening_now` is an optional boolean. When true, only talks in progress or starting within the next 60 minutes remain, judged by Elasticsearch against its own clock. Every response carries `happening_now: { available }`, true when the conference has a talk today in its own time zone; the app disables the chip when it is false (see `DECISIONS.md`, "Happening now").
- `filters.include_events` is an optional boolean, default false. When true, items of kind `ambient` (co-located events and showcases) are searched along with talks; breaks and housekeeping never are. Every result carries `kind`, `"talk"` or `"ambient"`, and the app draws an ambient result as an event card with no interest toggle, no talk circle and no related talks. Talks for you, people matches and circles read only kind `talk`, whatever this filter says.
- `saved_talk_ids` holds up to 100 ids of the request's conference (`{conference}:{session id}`). It is validated and **never filters anything**. It is kept so older clients do not break.
- `ignore_phrases` is optional: at most 20 strings of at most 30 characters, naming time phrases the person removed (see `DECISIONS.md`, "Time phrases in search"). Time phrases in `query` ("morning", "afternoon", "before lunch", "after lunch", "day N", weekday names) are removed from the text and applied as filters; the response then has `search_text` (the text the retrievers saw) and `time_phrases: [{ key, label, days, applied }]`, and a debug response's `ranking.filters` gains `time_phrases` (labels of the applied ones).
- `debug` is optional and must be a boolean. With `"debug": true` and a non-empty `query`, each result also has `ranking: { rank, keyword_rank, semantic_rank }` and the response has `ranking: { rank_window, semantic_k, filters }`, where `filters` echoes the validated filters every query applied (`kind`, `day`, `start_after`, `start_before`, `track`, `level`, `tags`, `has_slides`, `hide_sponsor`). `keyword_rank` and `semantic_rank` are the talk's positions in the rrf retriever's two child retrievers, each run on its own in the same `_msearch` with the filter rrf passes down to it; `null` means outside that child's window, which rrf also treats as not found. The main query does not change, and requests without `debug` carry none of these fields. Browse mode ignores `debug`.
- Body limit 4 KB.

Response: `{ total, conference, results, facets }`. Each result has `talk_id`, `conference`, `title`, `speakers`, `room`, `start`, `end`, `track`, `level`, `tags`, `topics: [{ topic_id, label }]`, `speaker_profiles`, `slides_url`, `url` and `evidence`. `facets` has `day`, `track`, `level` (only when the conference has a level group), `has_slides` and `tags: [{ group, values: [{ value, count }] }]` in `category_mapping.tag_groups` order. Each facet group, including each tag group, ignores its own selection. Ranking is an `rrf` retriever over a lexical `multi_match` and a `knn` query on `semantic`; `evidence` is never empty and contains only `<mark>` tags as markup.

### `GET /api/conferences`

Sorted by `start_date`, then `name`, with `Cache-Control: public, max-age=60`. Each entry has exactly `slug`, `name`, `start_date`, `end_date`, `time_zone`, `location: { city, region, country, virtual }`, `status` (`searchable` or `unavailable`), `official_schedule_url`, `source`, `has_level`, `track_group`, `tag_groups` and `talk_count`. API codes, LF ids, `status_reason` and the other counts are never returned. Methods other than GET or HEAD get 405.

### `GET /api/schedule?event={slug}` (offline mode)

The conference's `kind: talk` documents, read with the read-only key and sorted by `start`, then `talk_id`, for the app's offline keyword search. Returns `{ conference, talks }`; each talk has exactly `talk_id`, `conference`, `title`, `speakers`, `room`, `start`, `end`, `track`, `level`, `tags`, `topics: [{ topic_id, label }]`, `url`, `slides_url` and `abstract`, trimmed to about 400 characters. No people data and no other kinds. `Cache-Control: public, max-age=300`, gzip when the client accepts it, and 20 requests per minute per IP. The only accepted parameter is `event`; an unknown or unavailable slug gets 400, methods other than GET or HEAD get 405.

### `GET /api/related?event={slug}&talk_id={id}`

Up to five other talks of the same conference that are closest in meaning to one talk. Elasticsearch fetches the talk's title and abstract, then runs a knn query on the `semantic` field with that text as `model_text`, filtered to the conference and `kind: talk` and excluding the talk itself. No time or schedule filter applies. Returns `{ results: [{ talk_id, conference, title, speakers, room, start, end, track, level, tags, slides_url, url }] }` in the order Elasticsearch returned them. Only `event` and `talk_id` are accepted; an invalid value or an unknown parameter gets 400, an unknown talk 404, methods other than GET or HEAD 405, and more than 60 requests per minute per IP 429. `Cache-Control: private, max-age=300`.

### `GET /api/topics?event={slug}&q={prefix}&size={n}`

With an empty `q`, the conference's topics sorted by `rank` (default size 150). Otherwise a `bool_prefix` multi_match on `label`, `aliases` and their subfields (default size 10). `size` is at most 150 and `q` at most 60 characters. Returns `{ topics: [{ topic_id, label, talk_count }] }`.

### `POST /api/topics/suggest`

Body `{ event, talk_ids, text }`. Returns at most 12 topics: first those on the given talks (a terms aggregation on `topics`), then those whose label matches the text.

### `POST /api/recommendations` (talks for you)

Body `{ event, learn_topics, interests, interested_talk_ids, size }`. It stores and logs nothing from the body. `speak_topics` and `expertise` are still accepted, and are validated as before, so clients cached before 2026-11-09 keep working, but they are ignored: talks are recommended only from what the user wants to learn or the problems they face, never from what they can speak to. `interests` is the learn and problems free text.

- One `rrf` retriever over the conference's talks, filtered to `kind: talk`, `end > now` and not in `interested_talk_ids`. Two retrievers, each skipped when its input is empty: `learn_topics` against `topics` (weight 1) and `interests` against `semantic` (weight 1). There is no retriever for speak topics or expertise, and a talk that also matches a speak topic is not penalised. Weights use the rrf per-retriever `weight` of Elasticsearch 9.5.
- When both `learn_topics` and `interests` are empty the answer is `{ results: [], needs_profile: true }`, even if `speak_topics` or `expertise` are set.
- Results use the search result shape plus `why` and `circle_count`. `why` is `{ topics, learn_topics, passage }`. `learn_topics` holds the labels of the request's `learn_topics` that the talk has, so only topics sent in this request are named and a topic the user has removed never is. `topics` is kept equal to `learn_topics` for clients that predate the split. Speak topics are never returned in `why`. A client shows "You want to learn: ..." and the passage.

### People and circles

Every request may carry a same-origin `Origin` header or none. Writes and circle reads need the header `X-Caddie-Device: {profile_id}.{secret}`, where `profile_id` is 16 random bytes and `secret` 32 random bytes, both base64url, generated on the device. Bodies are JSON, at most 8 KB, and unknown keys get 400. The secret is compared with `crypto.timingSafeEqual` against `secret_hash`. The first write uses `op_type: create`, so an existing document can never be taken over.

- **`PUT /api/people/profile`**: body `{ event, profile: { display_name, about, interests, expertise, learn_topics, speak_topics, linkedin_url, contact_note }, open_to_meet, shared_talk_ids }`. Upserts with `refresh=wait_for`, or deletes the document when both choices are off. Returns `{ ok, open_to_meet, shared_talk_ids }`. Caps: `display_name` 1 to 60 characters, `about` 280, `interests` and `expertise` 500 each, `contact_note` 120; `linkedin_url` matches `^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_-]{3,100}/?$` or is null; at most 30 known topic ids per set; at most 50 `kind: talk` ids of that conference in `shared_talk_ids`. Writes that turn visibility on are refused after the conference ends.
- **`DELETE /api/people/profile?event={slug}`**: deletes at once with `refresh=wait_for`. Returns `{ ok }`.
- **`POST /api/people/matches`**: body `{ event, interested_talk_ids }`. The requester must have a live document with `open_to_meet: true`, else 403 `visibility_required`. One `rrf` retriever over: my `learn_topics` against their `speak_topics`; my `speak_topics` against their `learn_topics`; my `interests` against their `expertise_semantic`; my `expertise` against their `interests_semantic` (the last two skipped when the text is empty). Filter: `event_id`, `open_to_meet: true`, `visible_until > now`, not the requester. Returns `{ results: [{ ref, display_name, about, sample, learn_topics, speak_topics, reasons, opener, contact: { linkedin_url, contact_note } }] }`.
- **`POST /api/circles/counts`**: no device header. Body `{ event, talk_ids }` (at most 100). Returns `{ counts: { talk_id: n } }` from a terms aggregation on `shared_talk_ids`. Never members.
- **`POST /api/circles/members`**: body `{ event, talk_id }`. Only a requester whose live document has `talk_id` in `shared_talk_ids` gets `{ talk: { title, start, end, url }, speakers, count, members }`; everyone else gets 403 `{ error: "share_required", count }`. Members are ranked by the same four retrievers plus a match-all retriever, filtered to the talk's sharers; `open_to_meet` is not required.
- Reasons use fixed templates only: "They can speak to {topics}, which you want to learn about.", "They want to learn about {topics}, which you can speak to.", "You are both interested in {talk title}." and "Ask them about {their passage}." A talk is named only when the requester also shared for it. The opener is the first reason.
- `ref` is the first 16 hex characters of `sha256(event_id:profile_id:REF_SALT)`, used only as a UI key. `profile_id`, `secret_hash` and `text_hash` are never returned.

### `POST /api/import/schedule` (import my schedule)

Finds one conference's talks in a personal schedule the attendee exported from anywhere. It stores, indexes and logs nothing from the request; the upload lives in memory for that one request.

- Body `{ event, filename, mime, content_base64 }` for a file (`filename` and `mime` optional, at most 255 and 127 characters), or `{ event, text }` for pasted text (at most 200,000 characters). `event` must be a searchable conference. Unknown keys, both or neither of `content_base64` and `text`, and invalid base64 get 400. A file over 5 MB once decoded, or a body over about 7.2 MB, gets 413; the body limit applies to this route only.
- The type is sniffed from the content: `%PDF` in the first kilobyte, a zip or legacy Office header, or `{\rtf` is a document for Apache Tika; anything else must be UTF-8 (else 415). UTF-8 text that starts with `BEGIN:VCALENDAR` is iCalendar, text that parses as a JSON object or array is JSON, a `.csv`/`.tsv` name, a CSV type or a header row with a title-like column is CSV, and the rest is plain text.
- Documents go through the `attachment` ingest processor in `POST _ingest/pipeline/_simulate` with an inline pipeline (`indexed_chars` 200000, `remove_binary`), so nothing is indexed. No text gives 422 with a plain reason.
- iCalendar uses `SUMMARY`, with `DESCRIPTION` as speaker text and `DTSTART` (UTC, `TZID` or floating in the conference's zone) as a time hint. CSV uses a title-like column (`title`, `session`, `name`, `talk`, `summary`, `subject` and similar), a speaker column and a start, date or time column when present, else every cell. JSON reads Sessionize (`view/All`, `view/Sessions`) and Sched exports and generic arrays, taking each object's title-like field, speakers and start. Text and documents are split into items at blank lines, times and date headers; wrapped lines are merged; times, dates, rooms, URLs, "Add to calendar"-style lines and `Speakers:` labels are stripped or kept as speaker text.
- Candidates: each item offers its text, the part before a ` - ` speaker suffix and its single lines. A candidate needs three words with two content words (two words for the title of a structured entry or of an item that starts with a time). Candidates are de-duplicated and capped at 300.
- Matching is one `_msearch` over the conference's `kind: talk` documents, one search per candidate, size 1. Each is a bool of named queries: `must` one of `exact_title` (`match_phrase` on `title`, sent only with three content words) and `title_words` (`match` on `title`, `minimum_should_match` `3<75%`); `should` `speaker` (`match` on `speakers` with the item's speaker text, two words minimum) and `time` (a one-minute `start` range from the hint). The server keeps the best hit per talk by Elasticsearch score and never re-ranks.
- Returns `{ matched: [{ talk, confidence, matched_text_excerpt }], unmatched_count, extracted_chars }`, in the order the talks appear in the file. `talk` has the search result shape. `confidence` is read from `matched_queries` across every candidate that found the talk: `exact_title`, else `title_and_speaker`, else `title_and_time`, else `title_words`. `matched_text_excerpt` is at most 160 characters of the requester's own line. `unmatched_count` counts items that offered a candidate but matched no talk.
- 10 requests per minute per IP and at most 4 imports at once per instance (503 with `Retry-After` beyond that). Same-origin `Origin` or none, and `Content-Type: application/json`.

### Rate limits

In-memory token buckets per instance, keyed by device (`profile_id`) and by client IP: people writes 20 per minute per device and 60 per IP; matches and circle members 30 per minute per device and 90 per IP; search, circle counts, recommendations, topics and suggestions 60 per minute per IP; schedule exports 20 per minute per IP; schedule imports 10 per minute per IP; the conference list 120 per minute per IP; the health check 600 per minute per IP (generous for monitors, but not exempt); and unknown `/api/*` paths 60 per minute per IP. Every `/api/*` route is therefore limited, and each returns 429 with `Retry-After` over its limit. The client IP is the last `X-Forwarded-For` entry, which Google's front end appends, capped at 45 characters; without the header it is the socket address. Earlier entries are chosen by the client and are ignored.

### `GET /api/health`

Returns `{"ok": true}` without calling Elasticsearch.

## Server

- `server/index.mjs` uses `node:http` only and mounts search, conferences, schedule, people, circles, recommendations, topics, related talks and the schedule import before the static handler. Env: `PORT` (default 8080), `ES_URL`, `ES_API_KEY`, `ES_PEOPLE_API_KEY`, `ES_INDEX`, `ES_CONFERENCES_INDEX`, `ES_TOPICS_INDEX`, `ES_PEOPLE_INDEX`, `REF_SALT` (optional, not a secret), `STATIC_DIR` (default `web/dist`).
- It serves the built app from `STATIC_DIR`. Hashed files under `/assets/` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` and `manifest.webmanifest` get `no-cache`. Other GET requests that accept HTML fall back to `index.html`.
- Headers on every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- It logs one line per request: method, path without the query string, status and duration. It never logs headers, bodies, search text, profile fields or credentials.
- Local runs set keys inline, for example `ES_API_KEY="$ELASTISEARCH_API_KEY" ES_PEOPLE_API_KEY="$ELASTISEARCH_API_KEY" PORT=8081 node server/index.mjs`. Never write a key to a file.

## Keys

- **Read-only key** (Secret Manager `caddie-es-readonly`, env `ES_API_KEY`): `read` and `view_index_metadata` on `caddie-talks*`, `caddie-conferences*` and `caddie-topics*`, plus the single cluster action `cluster:admin/ingest/pipeline/simulate` for the schedule import's text extraction.
- **People key** (Secret Manager `caddie-es-people`, env `ES_PEOPLE_API_KEY`): `read`, `write` and `view_index_metadata` on `caddie-people*` only. The server uses it only for people, circles and the circle counts in recommendations.
- The admin key is used only by the operator's CLI commands and is never deployed.

## Frontend brief

Stack: Vite, Preact and TypeScript; plain CSS with custom properties; `lucide-preact` icons. Clean and minimal, light and dark themes, platform conventions, 44px tap targets.

- **Routes.** `/e/{slug}` with hash tabs `#/people` (default), `#/for-you`, `#/search`, `#/interested`, `#/profile` and `#/settings`. `/` redirects to the first searchable conference with `end_date >= today`, else the last searchable one.
- **Navigation.** A bottom tab bar with four tabs in this order: People (users icon, home), For you (sparkles), Search (search), Interested (star, with a count badge). From 768px up it becomes a rail. The app bar title is the conference switcher; unavailable conferences show "Schedule not available here yet" with a link to the official schedule. A person (avatar) button at the top right opens the profile, which ends with a Settings row.
- **People tab (home).** The ended-talk banner ("Want to keep talking about {title}? See who else was interested."), People to meet (or a prompt to create a profile or turn on visibility), and a For you row of up to 5 talks with "See all". For you uses only the learn topics and the learn free text; its cards show "You want to learn: ..." and the passage, and its prompts ask for what the user wants to learn or a problem they face.
- **Talk cards.** "I'm interested" (after the talk's end: "I was there / wanted to be"), "N people want to talk about this" when N is above 0, the separate per-talk "Share my profile with others interested in this talk" toggle (off by default), "See who's here" for sharers, and the link "Add to my schedule on the official site" to the talk's `url`.
- **Interested tab.** A plain list of marked talks grouped by day and sorted by start time. There is no clash logic, no agenda building and no "Build my agenda".
- **Profile.** Display name, about, the two topic pickers ("I want to learn about", "I can speak to") with optional free text (under the first, labelled "What do you want to learn, or what problem are you working on?", stored as `interests`; under the second, "Anything else?", stored as `expertise`), "How to reach me", the conference-wide visibility toggle with a one-paragraph notice, "Delete my profile", and a disabled "Import from LinkedIn (coming soon)" button. `importProfile('linkedin')` returns `{ ok: false, error: "not implemented" }`.
- **Topic picker.** Not a modal: the 12 most common topics, "Show more", type-ahead through `/api/topics`, "Suggested for you" through `/api/topics/suggest`, selected chips pinned on top, one tap to add or remove.
- **Samples.** Sample profiles show a "Sample" badge.
- **Storage.** `caddie.interested.v1.{slug}` (marked talks without `evidence`, plus `marked_at`), `caddie.conferences.v1`, `caddie.theme`, `caddie.device.v1` (`profile_id` and `secret`), `caddie.profile.v1` and `caddie.visibility.v1.{slug}`. Older `caddie.saved.*` data is ignored. Every storage access is wrapped in try/catch.
- **Time.** Every time is formatted in the conference's `time_zone` with `Intl`.
- **No raw IDs, no invented data.** Never render `talk_id`, `ref`, `topic_id` or any feed id. Production builds contain no mock data; the marker `MOCK_FIXTURE_DO_NOT_SHIP` must not appear in `web/dist`. No conference name is hard-coded in `web/`.

## Secrets rules

- Never print, echo, log, or write to any file the value of `ELASTISEARCH_API_KEY`, `GC_API_KEY`, the read-only key, the people key, any device secret or any password. Refer to them only as `"$VAR"` in commands or `process.env.X` in code.
- Never use `set -x`, `curl -v`, `env`, `printenv` or anything else that dumps the environment.
- Before every commit, write `git diff --cached` to a scratch file, check it with `grep -qF -- "$ELASTISEARCH_API_KEY"` and the same for `"$GC_API_KEY"`, then delete the file.
- The browser never holds a key and never calls Elasticsearch.

## Git rules

- Task agents work in their own worktree branch and never push to main.
- Integrators merge task commits by SHA and push to `origin main`. The user said "no branch ceremony", which overrides the usual pull-request flow for this repo.
- End every commit message with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
