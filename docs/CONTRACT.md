# Conference Caddie build contract

This file pins the decisions that every track builds against. A track may add to it in its own output, but must not change a field name or its meaning. The brief (`SPEC.md`) states the goals and the four non-negotiable rules; where the brief's "starting sketches" disagree with this contract, this contract wins.

## Facts established on 2026-11-09

- Elasticsearch 9.5.6 runs on Elastic Cloud Hosted (GCP us-west1) at `https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443`. The URL is not a secret.
- The admin credential is in env var `ELASTISEARCH_API_KEY`. It is already in the encoded form, so send it as the header `Authorization: ApiKey $ELASTISEARCH_API_KEY`. It is an API key with manage_security, manage_api_key, manage_inference, manage_ml and all privileges on `caddie-*`. No `caddie-*` index exists yet.
- An API key cannot create a derived API key that has privileges. To make the read-only key for the deployed service, the integrator creates a role (read and view_index_metadata on `caddie-*`) and a native user, authenticates as that user, and mints the API key as that user. The password is generated in-process and never printed or stored.
- Inference endpoints on the cluster include `.elser-2-elastic` (sparse, Elastic Inference Service), `.elser-2-elasticsearch`, `.multilingual-e5-small-elasticsearch` and `.jina-embeddings-v5-text-small`. The cluster also has chat, completion and rerank endpoints. **Never use any chat, completion or rerank endpoint.** The only model allowed is the embedding model behind `semantic_text`.
- The feed was fetched once and is committed at `data/raw/schedule.json`. It is a JSON object with `sessions` (600), `speakers` (712), `questions` (6), `categories` (5 groups) and `rooms` (37). All names resolve from this file. Never call the feed again, at build time or run time, and never scrape session pages.
- Google Cloud project id is `project-9205d6eb-366e-4844-b77` (project number 265846417372) and the region is `us-west1`. `GC_SERVICE_USER` holds a service-account email only, with no private key. `GC_API_KEY` holds a Google API key, which the Cloud Run, Cloud Build and Resource Manager APIs reject. The gcloud CLI is being installed with Homebrew and the user is being asked to run `gcloud auth login`. Before any Google Cloud call, run `gcloud auth list --filter=status:ACTIVE --format='value(account)'`. If no account is active, finish everything else and report the status `blocked_on_gcp_auth`.
- Local tools: Node 26, npm 11, Docker 29, jq, and gh (logged in as KurtLehnardt).

## Repository layout and ownership

| Path | Owner |
|---|---|
| `.gitignore`, root `package.json`, `README.md`, `docs/CONTRACT.md`, `data/raw/schedule.json` | bootstrap |
| `scripts/build-data.mjs`, `data/talks.ndjson`, `DATA_NOTES.md` | track A (data) |
| `scripts/es-setup.mjs`, `scripts/ingest.mjs`, `server/**` | track B (search and API) |
| `web/**` | track C (frontend) |
| `Dockerfile`, `.dockerignore`, `.gcloudignore`, `scripts/deploy.sh`, `deploy/hello/**` | track D (deploy) |
| `scripts/smoke.mjs`, `scripts/create-readonly-key.mjs`, `DECISIONS.md` | integrators |

Each track edits only its own paths. Only bootstrap and the integrators edit the root `package.json`. The repo root has no npm dependencies: scripts and the server use only Node built-ins (`node:http`, `node:fs`, global `fetch`). The `web/` app has its own `package.json` and lockfile.

Root `package.json` scripts:

```json
{
  "data": "node scripts/build-data.mjs",
  "es:setup": "node scripts/es-setup.mjs",
  "ingest": "node scripts/ingest.mjs",
  "start": "node server/index.mjs",
  "dev:web": "npm --prefix web run dev",
  "build": "npm --prefix web ci && npm --prefix web run build",
  "smoke": "node scripts/smoke.mjs",
  "deploy": "bash scripts/deploy.sh"
}
```

## Index document

`data/talks.ndjson` has one JSON object per line and includes every feed item of every kind. Fields:

| Field | Type | Notes |
|---|---|---|
| `talk_id` | string | Sessionize session id as a string. Never shown in the UI. |
| `kind` | `"talk"`, `"ambient"`, `"break"` or `"housekeeping"` | Simple rule per the brief, documented in `DATA_NOTES.md`. |
| `title` | string | |
| `abstract` | string | Empty string when the feed description is null. |
| `speakers` | string[] | Resolved full names, in feed order. |
| `speaker_taglines` | string[] | Resolved taglines; omit empty ones. |
| `room` | string or null | Resolved room name. |
| `track` | string | One value; `"Not specified"` when none. |
| `level` | string | Feed wording (for example `"Beginner"`, `"Advanced"`, `"Any Level"`); `"Not specified"` when none. |
| `flags` | string[] | For example `"End User Talk"`, `"Slides Attached"`, `"Learning Lounge"`. |
| `sponsor` | boolean | True for sponsor content (for example the Sponsor Demo Theater track and sponsored keynotes). Track A defines the rule. |
| `has_slides` | boolean | |
| `slides_url` | string or null | |
| `url` | string | `https://kubecon-cloudnativecon-north-america-2026.sessionize.com/session/{id}` |
| `start`, `end` | string | ISO 8601 with the America/Denver offset computed for that date, for example `"2026-11-10T09:00:00-07:00"`. Compute the offset with `Intl`; do not hardcode it. |
| `day` | string | Venue-local date, `"YYYY-MM-DD"`. |
| `start_minutes`, `end_minutes` | integer | Minutes since venue-local midnight. |

## Elasticsearch

- Index `caddie-talks-v1` behind alias `caddie-talks`. The server reads the alias name from `ES_INDEX` (default `caddie-talks`). Development indices must also match `caddie-*` and are deleted after integration.
- Mapping: the brief's sketch plus `talk_id` (keyword), `sponsor` (boolean), `start_minutes` and `end_minutes` (integer). `semantic` is a `semantic_text` field filled by `copy_to` from `title` and `abstract`.
- Search: an `rrf` retriever over a lexical `multi_match` and a `semantic` query. Every search filters on `kind: talk` in the MVP. If semantic search cannot work, use the pre-approved lexical-only fallback with the same filters.
- Saved-talk conflicts: the server looks up the saved talks' `start` and `end` in Elasticsearch by `talk_id`. For each one it adds a `must_not` clause that matches `kind: talk` documents with `start < saved.end` and `end > saved.start`. The saved talks therefore drop out of results too.
- Facets and `total` are computed over the same document set, so they agree with each other. Each facet group ignores its own selection, so that multi-select still shows sibling options; all other filters apply. Document the exact definition in your output.
- Ranking happens only in Elasticsearch. The server never reorders hits.

## API

`POST /api/search` with `Content-Type: application/json`.

Request (all keys optional except `query`; unknown keys are rejected):

```json
{ "query": "securing AI agents on kubernetes",
  "filters": { "day": null, "start_after": null, "start_before": null,
               "track": [], "level": [], "has_slides": null,
               "hide_sponsor": false },
  "saved_talk_ids": [], "size": 10 }
```

- `query`: string, at most 200 characters after trimming. An empty query means browse mode: talks that match the filters, sorted by `start` ascending by Elasticsearch.
- `filters.day`: null or one known `day` value.
- `filters.start_after`, `filters.start_before`: null or `"HH:MM"` in venue-local time. They filter on `start_minutes` (`>=` after, `<` before). The UI's Morning chip sends `start_before: "12:00"` and its Afternoon chip sends `start_after: "12:00"`.
- `filters.track`, `filters.level`: arrays of known values. Values within one group are ORed; groups are ANDed.
- `filters.has_slides`: null, true or false.
- `filters.hide_sponsor`: boolean. True excludes `sponsor: true`.
- `saved_talk_ids`: up to 100 strings matching `^[A-Za-z0-9_-]{1,64}$`.
- `size`: integer from 1 to 50; default 10.
- Known values for `day`, `track` and `level` come from an Elasticsearch terms aggregation over `kind: talk`, cached in memory by the server for 10 minutes. An unknown value gets a 400.
- Request bodies over 4 KB, other methods, other content types and malformed JSON get a 4xx with `{"error": "..."}`.

Response:

```json
{ "total": 123,
  "results": [ { "talk_id": "123456", "title": "", "speakers": [""], "room": "Room name or null",
                 "start": "2026-11-10T09:00:00-07:00", "end": "2026-11-10T09:30:00-07:00",
                 "track": "", "level": "", "flags": [], "slides_url": null,
                 "url": "https://kubecon-cloudnativecon-north-america-2026.sessionize.com/session/123456",
                 "evidence": "text with <mark>matched</mark> words" } ],
  "facets": { "day":        [ { "value": "2026-11-10", "count": 87 } ],
              "track":      [ { "value": "Security", "count": 40 } ],
              "level":      [ { "value": "Beginner", "count": 30 } ],
              "has_slides": [ { "value": true, "count": 12 }, { "value": false, "count": 111 } ] } }
```

- `facets.day` is sorted by value ascending; `track` and `level` by count descending.
- `evidence` is never empty. It comes from Elasticsearch highlighting with `encoder: "html"` and `<mark>`/`</mark>` tags, so everything except those tags is already HTML-escaped. Prefer a lexical highlight fragment from `abstract`, then from `title`, then the top semantic chunk (which has no marks). In browse mode, use the first part of the abstract returned by Elasticsearch.
- Errors: `{"error": "..."}` with 400 for invalid input and 502 when Elasticsearch fails. Never forward Elasticsearch error bodies to the client.
- `GET /api/health` returns `{"ok": true}` without calling Elasticsearch.

## Server

- `server/index.mjs` uses `node:http` only. Env: `PORT` (default 8080), `ES_URL`, `ES_API_KEY`, `ES_INDEX` (default `caddie-talks`), `STATIC_DIR` (default `web/dist`).
- It serves the built app from `STATIC_DIR`. Hashed files under `/assets/` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` and `manifest.webmanifest` get `no-cache`. Other GET requests that accept HTML fall back to `index.html`.
- Headers on every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- Calls to Elasticsearch use a timeout of 8 seconds.
- It logs one line per request: method, path, status and duration. It never logs headers, bodies, search text or credentials.
- Local runs set `ES_API_KEY` inline in the command, for example `ES_API_KEY="$ELASTISEARCH_API_KEY" PORT=8081 node server/index.mjs`. Never write a key to a file. Use the port your task assigns, so parallel tracks do not collide, and stop the servers you start.

## Frontend brief

Stack: Vite, Preact and TypeScript; plain CSS with custom properties and no CSS framework; `lucide-preact` for icons. No router library: the tab state lives in `location.hash` (`#/search`, `#/agenda`, `#/settings`) so the back button works.

Look and feel: clean and minimal, with light and dark themes, following platform conventions (Apple HIG and Material) for navigation, menus, settings and icon placement.

- **Navigation.** Phones (below 768px) get a top app bar with the screen title on the left and contextual actions on the right, plus a fixed bottom tab bar with three labeled tabs: Search (search icon), Agenda (calendar-check icon, with a badge showing the saved count) and Settings (gear icon). From 768px up, the tabs become a left navigation rail and content sits in a centered column at most 720px wide. Respect safe-area insets (`viewport-fit=cover`, `env(safe-area-inset-*)`).
- **Search screen.**
  - A sticky search field with a leading search icon, a trailing clear button when it has text, `type="search"` and `enterkeyhint="search"`. Placeholder: "Search talks, topics, speakers".
  - Search on Enter and after a 350 ms pause in typing. Abort the request that is in flight. Keep earlier results visible while loading and show a thin progress bar.
  - Below the field, a horizontally scrolling chip row:
    - A "Filters" chip (sliders icon, with a badge counting active filters) opens a bottom sheet holding every group.
    - Quick chips: Day, Time (Morning or Afternoon), Track and Level open the sheet at their section. "Has slides" and "Hide sponsor content" are toggles.
    - Active chips are tinted with the accent color and have a clear control. A "Clear all" action appears when any filter is active.
  - Filter options and counts come only from the response's `facets`. Hide zero-count options unless they are selected. Format day values as "Tue, Nov 10".
  - A results header shows "N talks" (or "All talks · N" in browse mode) on the left and a "Build my agenda" button (calendar-plus icon) on the right.
  - Result cards show:
    - The title, semibold and clamped to two lines.
    - The speakers in secondary text.
    - A meta line with a clock icon, for example "Tue, Nov 10 · 9:00–9:30 AM MT", and a map-pin icon with the room.
    - Small chips for track, level and flags.
    - The evidence in secondary text, with `<mark>` highlights.
    - Footer links "Session page" (external-link icon) and "Slides" (when `slides_url` exists). Both open in a new tab with `rel="noopener noreferrer"`.
    - A bookmark toggle button in the top-right corner of the card, with a 44×44 target and `aria-pressed`. It is filled when the talk is saved.
  - Render evidence safely: split the string on `<mark>` and `</mark>`, decode the HTML entities in the text pieces, and render them as text nodes and `<mark>` elements. Never use `dangerouslySetInnerHTML`.
  - An empty query shows browse mode. Other states: skeleton cards on the first load; an inline error with a Retry button; and an empty state, "No talks match. Try removing a filter."
- **Build my agenda.**
  1. Request the current query and filters with `size: 30` and the current `saved_talk_ids`.
  2. Walk the results in the order returned (that is, Elasticsearch rank order). Skip any talk that overlaps an already-saved talk or a talk picked earlier in this walk.
  3. Save the first five that fit; if fewer than three fit, save what fits.
  4. Show a toast: "Added N talks to your agenda", with Undo.
  5. Run the search again.
- **Agenda screen.**
  - Saved talks, grouped by day under sticky day headers and sorted by start time.
  - Each row shows the time range, title and room, plus a filled bookmark button to remove the talk. Removing shows an Undo toast.
  - Empty state: "No saved talks yet. Tap the bookmark on any talk to add it."
  - The app bar has an overflow menu (vertical dots) with "Clear agenda", which asks for confirmation first.
- **Settings screen.** A grouped list in the style of iOS and Android settings:
  - **Appearance:** Theme as a segmented control with System, Light and Dark.
  - **Agenda:** "Clear saved talks", in destructive red, behind a confirmation dialog.
  - **About:** "Times are shown in venue time (Mountain Time)."; "Schedule data comes from the KubeCon + CloudNativeCon North America 2026 Sessionize feed."; a link to the source code at https://github.com/KurtLehnardt/conferenceCaddie; and the app version.
- **Theming.**
  - Use CSS custom properties: neutral grays, one accent color, hairline borders and minimal shadows.
  - Dark mode follows `prefers-color-scheme` unless `html[data-theme]` is set to `light` or `dark`. Set `color-scheme: light dark`.
  - Include two `theme-color` meta tags with media queries.
  - Store the theme preference in localStorage under `caddie.theme`. A tiny external `public/theme-init.js`, loaded in `<head>`, applies it before first paint; the CSP forbids inline scripts.
  - Type and spacing: the system font stack; 16px base text; 17px semibold titles; 14px secondary text; an 8px spacing grid; 12px card radius; fully rounded chips.
  - Motion lasts 150 to 200 ms and is disabled under `prefers-reduced-motion`.
- **Accessibility.**
  - Every icon button has an `aria-label`.
  - Focus rings are visible.
  - Text contrast is at least 4.5:1 and tap targets are at least 44px.
  - The bottom sheet and dialogs trap focus and close on Escape or a backdrop tap.
- **Time.** Format every time in `America/Denver` with `Intl.DateTimeFormat` (label "MT"), whatever the phone's time zone.
- **Storage.**
  - Saved talks live in localStorage under `caddie.saved.v1` as an array of result objects without `evidence`.
  - Wrap every storage access in try/catch.
  - Search requests always send `saved_talk_ids`.
- **No raw IDs, no invented data.**
  - Never render `talk_id` or any room, speaker or category id.
  - Production builds contain no mock data. Mock mode loads only behind `import.meta.env.DEV && import.meta.env.VITE_MOCK === '1'` via a dynamic import, and the mock fixtures contain the marker string `MOCK_FIXTURE_DO_NOT_SHIP`, which must not appear in `web/dist`.
- **Manifest.**
  - `public/manifest.webmanifest`: name and short_name "Conference Caddie", `start_url` "/", `scope` "/", `display` "standalone", plus theme and background colors.
  - Icons: 192 and 512 PNG, a 512 maskable PNG and a 180 PNG `apple-touch-icon`, generated by a committed script and committed as files.
  - No service worker in the MVP.
- **Dev.** `web/vite.config.ts` proxies `/api` to `http://localhost:8080`.

## Secrets rules for every track

- Never print, echo, log, or write to any file the value of `ELASTISEARCH_API_KEY`, `GC_API_KEY`, the read-only key or any password. Refer to them only as `"$VAR"` inside commands or as `process.env.X` in code.
- Never use `set -x`, `curl -v`, `env`, `printenv` or anything else that dumps the environment.
- Before every commit, run `git diff --cached | grep -qF -- "$ELASTISEARCH_API_KEY" && echo LEAK`, and the same check for `"$GC_API_KEY"`. If either prints LEAK, unstage the change and fix it.
- The browser never holds a key and never calls Elasticsearch. Only the server does.
- The deployed service uses only the read-only key from Secret Manager (secret `caddie-es-readonly`). The admin key is never deployed.

## Git rules

- Track agents work in their own worktree branch, commit often, and never push or merge into main.
- Integrators merge track commits by SHA, then push to `origin main` and fast-forward the main checkout at `/Users/LenovoT440p/work/conference`. The user said "Commit often; no branch ceremony needed", which overrides the usual pull-request flow for this repo.
- End every commit message with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
