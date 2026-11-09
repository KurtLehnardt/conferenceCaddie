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
| `server/people.mjs`, `server/connect.mjs`, `server/moderation.mjs`, `server/device.mjs`, `server/ratelimit.mjs`, `config/moderation-words.json`, `scripts/es-setup-people.mjs`, `scripts/seed-people.mjs`, `scripts/export-people.mjs`, `scripts/backfill-ref.mjs`, `scripts/purge-expired-people.mjs`, `data/samples/**` | people, talk circles, blocks, presence and meets |
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

Every index is versioned behind an alias. The server reads alias names from env: `ES_INDEX` (default `caddie-talks`), `ES_CONFERENCES_INDEX` (default `caddie-conferences`), `ES_TOPICS_INDEX` (default `caddie-topics`), `ES_PEOPLE_INDEX` (default `caddie-people`), `ES_PEOPLE_BLOCKS_INDEX` (default `caddie-people-blocks`) and `ES_PEOPLE_MEETS_INDEX` (default `caddie-people-meets`). Every people-side index is named `caddie-people-*`, so the people key covers it. Development indices are named `caddie-dev-<task>*` and are deleted when the task ends. The topics command uses a temporary work index `caddie-topicwork-{slug}` and deletes it in all cases.

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
| `ref` | keyword. The result reference (see below), stored on every write so a block or a meet request can name a person by it. |
| `presence_zone` | keyword. The zone the person said they are in; absent or null while they are not around. |
| `presence_spot` | text. Their optional "how to spot me where I am" line, 60 characters, filtered. |
| `presence_since`, `presence_until` | date. Presence is live while `presence_until > now`. |

- A document exists only while `open_to_meet` is true or `shared_talk_ids` is not empty; otherwise the server deletes it, together with the person's blocks and meets.
- `visible_until` is 23:59:59 on the conference's `end_date` in its `time_zone` (UTC-12 when the zone is unknown). Every people query filters on `event_id` and `visible_until > now`.
- Expired documents are deleted, not only hidden: the server runs a delete-by-query on `visible_until < now` (and on documents without `visible_until`) when it starts and once an hour, and `npm run people:purge` runs the same delete from the CLI. The same pass clears the four presence fields where `presence_until < now` (a Bulk partial `update`) and deletes meets whose `expires_at < now`.
- `secret_hash` is `sha256(secret)` in hex. `text_hash` is `sha256(JSON [about, interests, expertise])`. Writes whose text is unchanged use a Bulk partial `update` without the text fields, so nothing is re-embedded. Presence writes are Bulk partial `update`s of the four presence fields only.
- `ref` and the presence fields were added to an existing index with an additive `PUT _mapping`; `npm run people:setup` does that idempotently, and `node scripts/backfill-ref.mjs` writes `ref` on documents from before the field existed (run it with the server's `REF_SALT`).

### Blocks: `caddie-people-blocks-v1` behind `caddie-people-blocks`

`_id` is `{event_id}:{blocker_id}:{blocked_id}`, one document per direction. Mapping (`dynamic: false`): `event_id`, `blocker_id`, `blocked_id`, `blocked_ref` keyword; `created_at` date. `blocked_ref` is the blocked person's `ref`, so a block can be lifted after they deleted their profile. Every people query (matches, circle members, the meet inbox) leaves out anyone the requester has blocked or who has blocked the requester. A block is deleted with either profile.

### Meets: `caddie-people-meets-v1` behind `caddie-people-meets`

`_id` is `meet_id`, 16 random bytes base64url. Mapping (`dynamic: false`):

| Field | Mapping |
|---|---|
| `event_id`, `meet_id`, `participants` (the two `profile_id`s), `requester_id`, `topic_id`, `state` | keyword |
| `note`, `rendezvous` | keyword, `index: false` |
| `spot_me` | object, `enabled: false`: `{ profile_id: line }` for each participant who set one |
| `created_at`, `active_since`, `expires_at`, `ended_at` | date |

- `state` is `requested`, `accepted`, `active`, `found`, `cancelled`, `declined` or `expired`. `requested`, `accepted` and `active` are the open states.
- `expires_at` is 23:59:59 of the conference day the request was made (in the conference's `time_zone`, never later than `visible_until`) while the meet is requested or accepted, and `active_since + 20 min` (or the earlier of the two) once active. `ended_at` is set when the meet leaves the open states.
- A meet becomes `active` the first time both participants have live presence, which the server applies when the meet is accepted or read. It becomes `expired` when `expires_at` passes or, while active, when either presence ends. When a meet ends, `note`, `rendezvous` and `spot_me` are cleared, so only participants, topic, state and times remain until the purge deletes the document.
- Meets are deleted with either participant's profile.

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
- `saved_talk_ids` holds up to 100 ids of the request's conference (`{conference}:{session id}`). It is validated and **never filters anything**. It is kept so older clients do not break.
- Body limit 4 KB.

Response: `{ total, conference, results, facets }`. Each result has `talk_id`, `conference`, `title`, `speakers`, `room`, `start`, `end`, `track`, `level`, `tags`, `topics: [{ topic_id, label }]`, `speaker_profiles`, `slides_url`, `url` and `evidence`. `facets` has `day`, `track`, `level` (only when the conference has a level group), `has_slides` and `tags: [{ group, values: [{ value, count }] }]` in `category_mapping.tag_groups` order. Each facet group, including each tag group, ignores its own selection. Ranking is an `rrf` retriever over a lexical `multi_match` and a `knn` query on `semantic`; `evidence` is never empty and contains only `<mark>` tags as markup.

### `GET /api/conferences`

Sorted by `start_date`, then `name`, with `Cache-Control: public, max-age=60`. Each entry has exactly `slug`, `name`, `start_date`, `end_date`, `time_zone`, `location: { city, region, country, virtual }`, `status` (`searchable` or `unavailable`), `official_schedule_url`, `source`, `has_level`, `track_group`, `tag_groups` and `talk_count`. API codes, LF ids, `status_reason` and the other counts are never returned. Methods other than GET or HEAD get 405.

### `GET /api/schedule?event={slug}` (offline mode)

The conference's `kind: talk` documents, read with the read-only key and sorted by `start`, then `talk_id`, for the app's offline keyword search. Returns `{ conference, talks }`; each talk has exactly `talk_id`, `conference`, `title`, `speakers`, `room`, `start`, `end`, `track`, `level`, `tags`, `topics: [{ topic_id, label }]`, `url`, `slides_url` and `abstract`, trimmed to about 400 characters. No people data and no other kinds. `Cache-Control: public, max-age=300`, gzip when the client accepts it, and 20 requests per minute per IP. The only accepted parameter is `event`; an unknown or unavailable slug gets 400, methods other than GET or HEAD get 405.

### `GET /api/topics?event={slug}&q={prefix}&size={n}`

With an empty `q`, the conference's topics sorted by `rank` (default size 150). Otherwise a `bool_prefix` multi_match on `label`, `aliases` and their subfields (default size 10). `size` is at most 150 and `q` at most 60 characters. Returns `{ topics: [{ topic_id, label, talk_count }] }`.

### `POST /api/topics/suggest`

Body `{ event, talk_ids, text }`. Returns at most 12 topics: first those on the given talks (a terms aggregation on `topics`), then those whose label matches the text.

### `POST /api/recommendations` (talks for you)

Body `{ event, learn_topics, speak_topics, interests, expertise, interested_talk_ids, size }`. It stores and logs nothing from the body.

- One `rrf` retriever over the conference's talks, filtered to `kind: talk`, `end > now` and not in `interested_talk_ids`. Retrievers, each skipped when its input is empty: `learn_topics` against `topics` (weight 1), `interests` against `semantic` (weight 1), `speak_topics` against `topics` (weight 0.5) and `expertise` against `semantic` (weight 0.5). Weights use the rrf per-retriever `weight` of Elasticsearch 9.5.
- No inputs at all gives `{ results: [], needs_profile: true }`.
- Results use the search result shape plus `why: { topics: [labels], passage }` and `circle_count`.

### People and circles

Every request may carry a same-origin `Origin` header or none. Writes and circle reads need the header `X-Caddie-Device: {profile_id}.{secret}`, where `profile_id` is 16 random bytes and `secret` 32 random bytes, both base64url, generated on the device. Bodies are JSON, at most 8 KB, and unknown keys get 400. The secret is compared with `crypto.timingSafeEqual` against `secret_hash`. The first write uses `op_type: create`, so an existing document can never be taken over.

- **`PUT /api/people/profile`**: body `{ event, profile: { display_name, about, interests, expertise, learn_topics, speak_topics, linkedin_url, contact_note }, open_to_meet, shared_talk_ids }`. Upserts with `refresh=wait_for`, or deletes the document when both choices are off. Returns `{ ok, open_to_meet, shared_talk_ids }`. Caps: `display_name` 1 to 60 characters, `about` 280, `interests` and `expertise` 500 each, `contact_note` 120; `linkedin_url` matches `^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_-]{3,100}/?$` or is null; at most 30 known topic ids per set; at most 50 `kind: talk` ids of that conference in `shared_talk_ids`. Writes that turn visibility on are refused after the conference ends.
- **`DELETE /api/people/profile?event={slug}`**: deletes at once with `refresh=wait_for`. Returns `{ ok }`.
- **`POST /api/people/matches`**: body `{ event, interested_talk_ids, query, when, from, size }`. `query` is free text of at most 300 characters (optional); `when` is `anyone` (default) or `around_now`; `from` is 0 to 1000 (default 0) and `size` 1 to 20 (default 20). The requester must have a live document with `open_to_meet: true`, else 403 `visibility_required`. One `rrf` retriever over: my `learn_topics` against their `speak_topics`; my `speak_topics` against their `learn_topics`; `query`, or my `interests` when there is none, against their `expertise_semantic`; with a `query`, the same text against their `about_semantic`; my `expertise` against their `interests_semantic`; with a `query`, a lexical `multi_match` on their `expertise` and `about`. Legs whose text is empty are skipped. Filter: `event_id`, `open_to_meet: true`, `visible_until > now`, not the requester, not anyone blocked in either direction; `around_now` adds `presence_until > now`. `rank_window_size` grows with `from + size`, so there is no cap. Returns `{ results, from, size, has_more }`; `has_more` is true when the page was full, and a page can hold fewer than `size` results because of the specificity rule, so the client pages by `from + size`. Each result has `ref, display_name, about, sample, learn_topics, speak_topics, reasons, opener, contact: { linkedin_url, contact_note }, evidence, around, zone, broad`.
  - `evidence` is the passage of their `expertise` or `about` that matched, with `<mark>` tags as the only markup (HTML-escaped otherwise): a lexical fragment when the query's words matched, else the best semantic chunk, else the first 160 characters of their `expertise` (or `about`); null for a profile with no text and for a broad match.
  - `around` is true while they have live presence. `zone` is their `presence_zone` only when both the requester and they are around; otherwise null. Their spot line is never in a result.
  - **Specificity rule.** A result found only by the topic legs whose every shared topic is one of the conference's 10 most common (by `talk_count` in `caddie-topics`, cached 10 minutes) is a **broad** match (`broad: true`). Broad matches are left out of a text search and of the `anyone` view; the `around_now` view keeps those who are around in the requester's own zone, after every specific match of the page, with `evidence: null` and the reason "Also interested in {topics}." Which legs found a hit is read from the rrf explanation (`explain: true`); when the cluster gives none, every hit counts as specific.
  - Reasons add "They've worked on {evidence}." (first, in a text search) and "They're in {zone} right now." (last, when `zone` is set) to the fixed templates.
- **`POST /api/circles/counts`**: no device header. Body `{ event, talk_ids }` (at most 100). Returns `{ counts: { talk_id: n } }` from a terms aggregation on `shared_talk_ids`. Never members.
- **`POST /api/circles/members`**: body `{ event, talk_id }`. Only a requester whose live document has `talk_id` in `shared_talk_ids` gets `{ talk: { title, start, end, url }, speakers, count, members }`; everyone else gets 403 `{ error: "share_required", count }`. Members are ranked by the same four retrievers plus a match-all retriever, filtered to the talk's sharers and leaving out blocked pairs; `open_to_meet` is not required. Members carry the same `evidence`, `around` and `zone` fields as matches.
- Reasons use fixed templates only: "They've worked on {evidence}.", "They can speak to {topics}, which you want to learn about.", "They want to learn about {topics}, which you can speak to.", "You are both interested in {talk title}.", "Ask them about {their passage}.", "Also interested in {topics}." (broad matches only) and "They're in {zone} right now." A talk is named only when the requester also shared for it. The opener is the first reason.
- `ref` is the first 16 hex characters of `sha256(event_id:profile_id:REF_SALT)`. It is the UI key of a result and the way a block or a meet request names a person; the server resolves it through the stored `ref` field. `profile_id`, `secret_hash`, `text_hash` and the hashes of others are never returned.

### Find & connect: blocks, presence and meets

Every route here needs the device header and a same-origin `Origin` header or none, like the people writes, and a live document of the requester at that conference: without one, 403 `{ error: "profile_required" }` (a wrong secret is 403 `forbidden`). Lines other people will read (`spot`, `note`, `spot_me`) pass the wordlist filter of `server/moderation.mjs` (`config/moderation-words.json`, LDNOOBW English list, CC-BY 4.0): lowercase, NFKC, diacritics stripped, leet substitutions 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s, then whole-word or phrase matches; any web address other than `linkedin.com` is refused too. A hit is 400 `{ error: "filtered", message: "That was held back by the filter. Edit it and try again." }`. Zones are the conference's room names (the `room` of its `kind: talk` documents, cached 10 minutes) plus `Expo hall`, `Registration`, `Food and coffee`, `Hallway` and `Outside`, matched exactly.

- **`POST /api/people/block`**: body `{ event, ref }`. Writes the block (idempotent, `refresh=wait_for`) and ends any open meet between the two: as `declined` when the blocker was the one asked, as `cancelled` when the blocker asked. An unknown or expired `ref` is 404 `not_found`. Returns `{ ok }`.
- **`DELETE /api/people/block`**: body `{ event, ref }`. Removes the requester's block of that `ref`, whether or not the blocked profile still exists. Returns `{ ok }`.
- **`GET /api/people/blocks?event={slug}`**: returns `{ refs: [ref], blocks: [{ ref, display_name, created_at }] }`, newest first; `display_name` is null when the blocked profile is gone.
- **`PUT /api/presence`**: body `{ event, zone, spot }`. Needs `open_to_meet: true`, else 403 `profile_required`. `zone` must be one of the conference's zones (else 400); `spot` is at most 60 characters, filtered, and may be empty. Sets `presence_until` to 60 minutes from now (never past `visible_until`); turning it on again while on extends it and keeps `presence_since`. Returns `{ ok, zone, spot, presence_since, presence_until }`.
- **`DELETE /api/presence?event={slug}`**: clears the four presence fields and ends (`expired`) any active meet of the requester. Returns `{ ok }`.
- **`POST /api/meet`**: body `{ event, ref, topic_id, note }`. `topic_id` is a topic of the conference or null; `note` at most 140 characters, filtered, may be empty. `ref` must point at a live person the requester could see (visible conference-wide, or sharing a talk the requester shares for), else 404 `not_found`; not themselves. A block in either direction is 403 `{ error: "blocked" }`, the same body whichever side blocked. An open meet between the two is 409 `{ error: "meet_open", meet_id }`. Three `declined` meets requested by this device since the start of the conference day are 429 `{ error: "paused", message, retry_at }` with `Retry-After` until the end of the day. Limited to 10 requests per device per hour (429). Creates the meet as `requested` and returns `{ ok, ...meet }` (the meet shape below).
- **`GET /api/meet/inbox?event={slug}`**: returns `{ incoming, outgoing }`. `incoming` holds the open meets someone else asked for, each the meet shape plus `from: { ref, display_name, about }`; `outgoing` the open meets the requester asked for, each the meet shape plus `to: { ref, display_name }`. Declined requests stay in `outgoing` as `requested` until they run out. Meets with blocked people are left out. Newest first, at most 100.
- **`GET /api/meet/{id}`**: participants only (403 `forbidden` for anyone else, 404 when there is no such meet). Applies the time and presence transitions first: an open meet past `expires_at`, or an active one with either presence gone, becomes `expired`; an accepted one becomes `active` when both are around. A meet that is no longer open is 410 `{ error: "over", state }`. Otherwise returns the meet shape.
- **`POST /api/meet/{id}/accept`** and **`/decline`**: the person asked only (403 for the requester); the meet must be `requested` (410 when over, else 409 `{ error: "state", state }`). Accept gives `accepted`, or `active` at once when both are around. Decline gives `declined`, which the requester never learns. **`POST /api/meet/{id}/found`**: either participant, `active` only, gives `found`. **`POST /api/meet/{id}/cancel`**: either participant, any open state, gives `cancelled`. Each takes an empty body (or none) and returns `{ ok, ...meet }` with the real new state.
- **`PUT /api/meet/{id}/details`**: body `{ spot_me, rendezvous }`, each optional; the meet must be `accepted` or `active`. `spot_me` (60 characters, filtered; empty or null clears) is stored under the requester's own id; `rendezvous` is one of the conference's zones, or null to clear. Returns `{ ok, ...meet }`.
- **Meet shape**: `{ meet_id, state, requested_by_me, topic: { topic_id, label } | null, topic_label, note, created_at, active_since, active_until, expires_at, rendezvous, mine: { spot_me, around }, other: { ref, display_name, about, around, zone, spot, spot_me } }`. `state` is as stored, except that a declined meet reads `requested` to its requester. `active_until` equals `expires_at` while active, else null. `other.zone` and `other.spot` are set only while the meet is active (which needs both around), `other.spot_me` only while active; otherwise null. Nobody outside the meet ever receives a zone, spot or spot-me line.
- Bodies are JSON of at most 8 KB and unknown keys get 400, as for people writes.

### Rate limits

In-memory token buckets per instance, keyed by device (`profile_id`) and by client IP: people writes 20 per minute per device and 60 per IP (blocks, presence and every meet write share these buckets); matches, circle members, the blocks list, the meet inbox and meet reads 30 per minute per device and 90 per IP; search, circle counts, recommendations, topics and suggestions 60 per minute per IP; schedule exports 20 per minute per IP. Meet requests also take 10 per device per hour, and three "Not now" replies in one conference day pause the requester until the next day (429 `paused`, counted in Elasticsearch, so it survives a restart). The client IP is the last `X-Forwarded-For` entry, which Google's front end appends, capped at 45 characters; without the header it is the socket address. Earlier entries are chosen by the client and are ignored.

### `GET /api/health`

Returns `{"ok": true}` without calling Elasticsearch.

## Server

- `server/index.mjs` uses `node:http` only and mounts search, conferences, people, circles, blocks, presence, meets (`server/connect.mjs`), recommendations and topics before the static handler. Env: `PORT` (default 8080), `ES_URL`, `ES_API_KEY`, `ES_PEOPLE_API_KEY`, `ES_INDEX`, `ES_CONFERENCES_INDEX`, `ES_TOPICS_INDEX`, `ES_PEOPLE_INDEX`, `ES_PEOPLE_BLOCKS_INDEX`, `ES_PEOPLE_MEETS_INDEX`, `REF_SALT` (optional, not a secret), `STATIC_DIR` (default `web/dist`). `server/moderation.mjs` reads `config/moderation-words.json` at start, so the runtime image must carry `config/`.
- It serves the built app from `STATIC_DIR`. Hashed files under `/assets/` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` and `manifest.webmanifest` get `no-cache`. Other GET requests that accept HTML fall back to `index.html`.
- Headers on every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- It logs one line per request: method, path without the query string, status and duration. It never logs headers, bodies, search text, profile fields, zones, spot lines, notes or credentials.
- Local runs set keys inline, for example `ES_API_KEY="$ELASTISEARCH_API_KEY" ES_PEOPLE_API_KEY="$ELASTISEARCH_API_KEY" PORT=8081 node server/index.mjs`. Never write a key to a file.

## Keys

- **Read-only key** (Secret Manager `caddie-es-readonly`, env `ES_API_KEY`): `read` and `view_index_metadata` on `caddie-talks*`, `caddie-conferences*` and `caddie-topics*`.
- **People key** (Secret Manager `caddie-es-people`, env `ES_PEOPLE_API_KEY`): `read`, `write` and `view_index_metadata` on `caddie-people*` only. The server uses it only for people, circles and the circle counts in recommendations.
- The admin key is used only by the operator's CLI commands and is never deployed.

## Frontend brief

Stack: Vite, Preact and TypeScript; plain CSS with custom properties; `lucide-preact` icons. Clean and minimal, light and dark themes, platform conventions, 44px tap targets.

- **Routes.** `/e/{slug}` with hash tabs `#/people` (default), `#/for-you`, `#/search`, `#/interested`, `#/profile` and `#/settings`. `/` redirects to the first searchable conference with `end_date >= today`, else the last searchable one.
- **Navigation.** A bottom tab bar with four tabs in this order: People (users icon, home), For you (sparkles), Search (search), Interested (star, with a count badge). From 768px up it becomes a rail. The app bar title is the conference switcher; unavailable conferences show "Schedule not available here yet" with a link to the official schedule. A person (avatar) button at the top right opens the profile, which ends with a Settings row.
- **People tab (home).** The ended-talk banner ("Want to keep talking about {title}? See who else was interested."), People to meet (or a prompt to create a profile or turn on visibility), and a For you row of up to 5 talks with "See all".
- **Talk cards.** "I'm interested" (after the talk's end: "I was there / wanted to be"), "N people want to talk about this" when N is above 0, the separate per-talk "Share my profile with others interested in this talk" toggle (off by default), "See who's here" for sharers, and the link "Add to my schedule on the official site" to the talk's `url`.
- **Interested tab.** A plain list of marked talks grouped by day and sorted by start time. There is no clash logic, no agenda building and no "Build my agenda".
- **Profile.** Display name, about, the two topic pickers ("I want to learn about", "I can speak to") with optional free text, "How to reach me", the conference-wide visibility toggle with a one-paragraph notice, "Delete my profile", and a disabled "Import from LinkedIn (coming soon)" button. `importProfile('linkedin')` returns `{ ok: false, error: "not implemented" }`.
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
