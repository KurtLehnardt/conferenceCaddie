# Free hosting: Conference Caddie on Cloudflare, with the talk bundles on GitHub Pages

This page describes the free version of Conference Caddie, which has no expiry and needs no Elasticsearch and no Google Cloud. The people features are the main feature: profiles, people matching, talk circles, asks, waves, meets, presence, block, report, moderation, nudges and push. Talk search, browse, schedule, For you, topics and schedule import come along.

## What you need to do next (read this first)

The free stack is **live** at https://conference-caddie.krlehnardt.workers.dev since 2026-11-11 (UTC). The web app and the API share that one origin; there is no separate API Worker. The deploy, the secrets, the migration, the repository variables, both workflows, the live checks and the new QR code are done (see [Status](#status-on-2026-11-11)). These things are left, and only you can do them:

1. **Delete any Cloudflare API token that is no longer used**, in the Cloudflare dashboard. Keep only the token the deploy uses, and make sure that is the one your shell exports as `CLOUDFLARE_API_TOKEN`.
2. **Open the app on a phone and scan the new QR code** (`docs/demo/qr-kubecon.png`) once this change is merged.
3. **Point the Android build at the Worker** (step 1 of [Approvals needed](#approvals-needed-shutting-down-the-paid-stack)). It is not irreversible, but installed APKs keep calling Cloud Run until it is done.

One decision is also yours:

- **The paid stack keeps running until you approve its shutdown.** Cloud Run, Artifact Registry, Secret Manager, Elastic and billing stay as they are until you approve, step by step, the shutdown steps already listed in [Approvals needed](#approvals-needed-shutting-down-the-paid-stack). Several steps are irreversible. None has been done, and none should happen until the free stack has passed the live smoke for a full day and the Android build points at the Worker.

The detailed findings and checks are in [REVIEW_NOTES_FREE.md](../REVIEW_NOTES_FREE.md).

## Status on 2026-11-11

The free stack is **live** at https://conference-caddie.krlehnardt.workers.dev. Everything below was run against the deployed Worker on 2026-11-11 (UTC).

- **Deploy.** The account's `workers.dev` subdomain is `krlehnardt`. `bash worker/scripts/deploy.sh`, with the new token, built the Worker-mode app and deployed the Worker `conference-caddie` with no change to the code. `GET /` and the deep link `/e/kubecon-cloudnativecon-north-america-2026` serve the app; `GET /api/health`, `/api/capabilities` and `/api/conferences` answer JSON on the same origin.
- **Secrets.** `node worker/scripts/setup-secrets.mjs --only-missing` set `ADMIN_TOKEN`, `REF_SALT`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` and `BLE_MASTER_KEYRING` on the Worker, the repository secret `CADDIE_ADMIN_TOKEN`, and the local file `~/.config/conference-caddie/admin-token` (mode 0600). They took effect without a redeploy: `/api/capabilities` reports `ble.mode` `derived-v1`.
- **Migration** from `data/exports/backup-2026-11-10T08-25-32`, exactly the expected counts: 62 conferences, 717 talks, 114 topics, 898 facets, 132 of 136 people (the labelled sample profiles, including the 100 dummy profiles; the 4 real profiles were not copied), 0 of 26 reports, and 15 of 15 moderation rules matched. All 717 talks and 132 profiles were embedded during the migration, with 0 pending. The first `POST /admin/embed-pending` afterwards re-embedded the 132 sample profiles once more, because the marker of the embedding conventions is only written on that first call (see [Known gaps](#known-gaps)); every conference now reports 0 pending.
- **GitHub.** The repository variables `CADDIE_APP_URL` and `CADDIE_API_BASE` are both `https://conference-caddie.krlehnardt.workers.dev`. GitHub Pages is enabled with the workflow source. The Pages workflow (run 42966673369) and the ingest workflow for `kubecon-cloudnativecon-north-america-2026` (run 42966676952) both succeeded. The ingest brought KubeCon to the current Sessionize schedule: 602 rows, 56 upserted, 546 unchanged, 14 embedded, 4 deleted, 0 pending.
- **Pages.** https://kurtlehnardt.github.io/conferenceCaddie/ serves the landing page, which links to https://conference-caddie.krlehnardt.workers.dev/ and to the KubeCon deep link. `conferences.json` (4 conferences with bundles), `capabilities.json` and the KubeCon bundle (`bundle.json` and `vectors.i8`, with a matching SHA-256) are served.
- **Live smoke** (`BASE_URL=https://conference-caddie.krlehnardt.workers.dev ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token node scripts/smoke.mjs`): 91 PASS, 0 FAIL, 2 SKIP. The two skips are `ble2`, which runs against a deployed Worker only with `SMOKE_BLE=1`, and `unav1`, which runs only against a local Worker. One run with `SMOKE_BLE=1`, while the Worker held only sample profiles, gave 92 PASS, 0 FAIL, 1 SKIP, with `ble1` and `ble2` passing under `derived-v1`. The first run, made while the ingest was still writing, gave 88 PASS and 3 FAIL (`x`, `o` and `sch1`): the ingest had just added a KubeCon talk that the committed `data/` file does not have yet. After the local talk file was refreshed with `node scripts/ingest.mjs --event kubecon-cloudnativecon-north-america-2026 --dry-run --skip-topics` (not committed), every check passed.
- **Bluetooth parity.** `node worker/scripts/ble-parity.mjs` gave 29 PASS, 0 FAIL. It runs the Worker's code against the contract fixtures and has no option to target a deployed Worker; the live Bluetooth behaviour is covered by `ble1` and `ble2` above.
- **Phone flow** at 390x844 in headless Chrome against the live app: 14 of 14 checks passed (deep link, CSP, People tab, every main tab, search, service worker at scope `/`, manifest scope, profile create, People to meet, deep link after reload, a new tab, profile delete, no CSP violation, no page errors). The offline check (a deep link reloaded offline boots from the service worker cache) also passed.
- **QR code.** `docs/demo/qr-kubecon.png` and `.svg` now open https://conference-caddie.krlehnardt.workers.dev/e/kubecon-cloudnativecon-north-america-2026. The PNG was decoded with OpenCV to confirm it.
- **Test data.** After the checks, KubeCon holds the 132 sample profiles and no presence, meets, blocks, reports, push subscriptions or nudges; the other conferences hold no people. The smoke used to leave its two reports behind; it now removes them at the end of a run with an admin token.
- The Cloud Run and Elasticsearch stack is untouched and still serves https://conference-caddie-265846417372.us-west1.run.app.

## Review (2026-11-10)

**Verdict.** The second review of the free stack found eight must-fix problems. Seven were fixed and checked locally in PR #24; the eighth, the shared origin, was fixed afterwards by moving the app to the Worker. With PR #24 merged, I found nothing else that blocks a deploy except the missing Cloudflare token permission. Without PR #24 the stack on `main` should not be deployed, because blocks can be escaped and native apps cannot discover the Worker's tier.

**How it ran.** The Worker was not deployed yet, so the review and the fix round ran locally: `wrangler dev --local` with real Workers AI embeddings, plus the web app built in Pages mode and served under `/conferenceCaddie/` by a GitHub Pages stand-in. There was no live smoke run and no reading of CPU use on the deployed Worker.

**Must-fix items.** The fixes are on branch `fix/free-review` (2759457 and 2f6d613, rebased onto `origin/main` at 110c513) and open as [PR #24](https://github.com/KurtLehnardt/conferenceCaddie/pull/24). I did not push the fixes to `main`: the project rules allow that only when you say "push to main", and nothing was deployed.

1. **Blocks (fixed).** A block now belongs to the person who made it. If the blocked person deletes and re-creates their profile, they are still blocked. The blocks list shows such a block with `display_name: null`, unblocking by ref still works, and blocks run out at the conference end.
2. **Bluetooth tokens v1 (fixed).** Ported from the tier 3 code of PR #23; it needs the `BLE_MASTER_KEYRING` Worker secret. Turning on Bluetooth returns `ble_key` and `ble_key_id` once. Sightings resolve the previous, current and next 10-minute windows, and the answer carries `ble_key_id`. A session under a retired master gets 403 `ble_rekey`. The protections now apply to old-style tokens too: only people in the same zone or nearby cells resolve, at most 10 new people per window and 30 per hour per device, and a zone is shown only when it is the requester's own.
3. **`GET /api/capabilities` (fixed).** It now serves a valid tier 2 document, publicly cached for 5 minutes.
4. **Embedding parity (fixed).** Embeddings now match the talk bundles: CLS pooling, each talk embedded as title plus newline plus abstract, and the query instruction on talk searches. The model settings are checked before every ingest push, and stored vectors are re-embedded when the settings change. I re-measured the people match threshold with real Workers AI and raised it from 0.55 to 0.61.
5. **Pages workflow (fixed).** `pages.yml` now builds the talk bundles into `dist-pages/`. The pinned embedding model is cached, bundle directories the live site still names are copied forward, every vector is rebuilt weekly, and pushes to `data/` and the bundle builder trigger a rebuild.
6. **Schedule import (fixed).** It accepts `filename` and `mime` alongside `text`, so PDF import in the build that reads documents in the browser (now the Worker build) works.
7. **Unavailable conferences (fixed).** When a conference turns unavailable, people can still delete their data, admin routes still reach it, and the 10-minute cleanup job keeps purging it until it is empty. The ingest push no longer takes a conference down after a one-off fetch failure.
8. **Shared origin (R18, fixed after the review).** The device secrets would have lived on the github.io origin shared with the account's seven other live sites. You chose to serve the app from the Cloudflare Worker instead; see [Where the app lives](#where-the-app-lives-and-why).

**Checks, all run locally.**

- The Worker builds (`wrangler deploy --dry-run`).
- The smoke script passed all 92 checks, with no failures or skips, using real Workers AI embeddings. It includes the new checks for these fixes (`cap1`, `im3b`, `q8c`, `ble1`, `ble2`, `unav1`).
- `node worker/scripts/ble-parity.mjs` passed 29 of 29 against the golden vectors and resolution cases in `contracts/fixtures/ble/`.

**Notes.**

- The review ran against `origin/main` at 6f55b8e, with fake embeddings; the fix round used real ones.
- Not exercised against a running Worker: the 403 `ble_rekey` answer itself (the parity run covers retired masters) and `pages.yml` on GitHub (its steps ran locally, in order).
- Set `BLE_MASTER_KEYRING` before the first live smoke run, or the capabilities document says `server-rotate`.
- Unchanged and mirroring `main`: reports are never purged automatically (the operator purges them), and the device header is a static bearer credential.
- The Worker's import body cap is 1 MB while the web app allows 5 MB, so files over about 750 KB get 413.
- Full findings, proofs and the list of what was not covered are in [REVIEW_NOTES_FREE.md](../REVIEW_NOTES_FREE.md).

## Where the app lives, and why

The web app is served by the Cloudflare Worker, on the Worker's own origin, together with the API: https://conference-caddie.krlehnardt.workers.dev. `worker/scripts/deploy.sh` prints this address on every deploy.

It used to be planned for GitHub Pages at `https://kurtlehnardt.github.io/conferenceCaddie/`. That origin is shared by seven other live Pages sites of the same account, and every page on an origin can read that origin's `localStorage`. Any of those sites, or a compromise of any of them, could have read Conference Caddie's device secrets and acted as its users (review finding R18). On 2026-11-10 you chose to serve the app from the Worker instead (`DECISIONS.md`).

GitHub Pages now publishes only public data, which holds no secrets: the talk bundles under `bundles/`, `conferences.json`, the tier 1 `capabilities.json` (its `talks.bundle_base` stays `https://kurtlehnardt.github.io/conferenceCaddie/bundles/`), and a landing page with no script and no storage access. The landing page links to the app (the repository variable `CADDIE_APP_URL`), or says the app is not live yet. It is also the site's 404 page, so old links still lead to the app.

## Live URLs

| What | URL | State |
|---|---|---|
| Web app and API, one origin (Cloudflare Worker `conference-caddie`) | https://conference-caddie.krlehnardt.workers.dev | Live since 2026-11-11. The API is under `/api` on the same origin. Stored in the repository variables `CADDIE_APP_URL` and `CADDIE_API_BASE`. |
| KubeCon NA 2026 deep link (the QR code) | https://conference-caddie.krlehnardt.workers.dev/e/kubecon-cloudnativecon-north-america-2026 | Live. `docs/demo/qr-kubecon.png` and `.svg` open it. |
| Talk bundles and landing page (GitHub Pages) | https://kurtlehnardt.github.io/conferenceCaddie/ | Published. The landing page links to the app. |
| Old app (Cloud Run) | https://conference-caddie-265846417372.us-west1.run.app | Live, unchanged, the rollback |

## Architecture

```
Phone browser ──HTTPS, one origin──> Cloudflare Worker "conference-caddie"
                                         ├─ static assets: the Vite/Preact app (free, never runs the Worker's code)
                                         └─ /api/*, /admin/*: the Worker's code, X-Caddie-Device header, no cookies
                                                              │
                                   ┌──────────────────────────┼───────────────────────────┐
                                   ▼                          ▼                           ▼
                        ConferenceDO (one per slug)     DirectoryDO ("global")      Workers AI
                        SQLite: talks, FTS5, vectors,   conference list, usage      bge-small-en-v1.5
                        people, presence, asks, meets,  totals                      embeddings
                        blocks, reports, push, rules
                                   ▲
                        Cron Trigger every 10 minutes (purge, expiry, pending embeddings, usage)
GitHub Actions: weekly ingest ──admin routes──> Worker
GitHub Pages: public talk bundles, conferences.json, capabilities.json and a landing page (no app)
```

- **One Worker, one origin.** The Worker serves the web app as Workers static assets (`[assets]` in `worker/wrangler.toml`, the directory `web/dist-worker/`). Only `/api`, `/admin` and their subpaths run the Worker's code (`run_worker_first`), so app files cost no Worker request and never count in the pace budget. Any other path with no file gets `index.html` (`not_found_handling = "single-page-application"`), so a deep link such as `/e/{slug}` boots the app. `worker/src/index.js` routes the 31 API routes. All heavy work runs in Durable Objects, because the Free plan allows 10 ms of CPU per Worker request.
- **Storage: SQLite-backed Durable Objects only.** There is one `ConferenceDO` per conference slug and one `DirectoryDO` named `global`. D1, KV, Vectorize and Pages (Cloudflare's) are not used.
- **Keyword search:** SQLite FTS5 with the porter and unicode61 tokenizer.
- **Semantic search:** vectors from `@cf/baai/bge-small-en-v1.5` (384 dimensions), called with CLS pooling, L2-normalised, stored as float32 BLOBs, with a brute-force dot product over vectors held in Durable Object memory. The model is set by the `EMBED_MODEL` variable. No generative LLM is called anywhere.
- **Ranking:** reciprocal rank fusion in code (rank constant 60). The old "Elasticsearch does all ranking" rule is lifted. People matching also applies a cosine floor of 0.61 to each semantic leg for bge-small with CLS pooling (re-measured on 2026-11-10, see `worker/src/people/rank.js`), set by `PEOPLE_SEMANTIC_FLOOR`; lower it if recall feels low.
- **Auth:** the device header `X-Caddie-Device: {profile_id}.{secret}`. Only `sha256(secret)` is stored, and the compare is constant time. There are no cookies.
- **CORS:** the app is on the Worker's own origin, so it needs no CORS. The Worker accepts its own origin (browsers send `Origin` on same-origin writes too), the localhost development origins in `ALLOWED_ORIGINS`, and requests with no `Origin` header (Node, curl, the native apps), which get no CORS headers. Any other origin gets 403 `cross-origin request`. The admin routes refuse every request with an `Origin` header.
- **Static file headers:** the Worker-mode build writes `web/dist-worker/_headers` with the Cloud Run server's Content-Security-Policy (`connect-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security` and `Permissions-Policy`. Each hashed file under `/assets/` is cached as immutable for a year; `index.html`, `sw.js` and the manifest are `no-cache`, so a deploy reaches every phone on its next load.
- **Push:** VAPID Web Push is sent from the Worker with Web Crypto (RFC 8291 and 8292). The VAPID pair is stored as Worker secrets.
- **Privacy rules are unchanged:** reciprocity, circles gated by sharing, presence and zone visibility, symmetric block, silent decline, expiry, delete everywhere, device-secret ownership, and contact shown only to entitled viewers. The UI shows no raw IDs.
- **Schedule import:** the Worker-mode build (`VITE_CLIENT_EXTRACT=1`) reads PDF, DOCX and ODT files in the browser, with pdf.js and fflate loaded on demand, and sends only text to the Worker. The Cloud Run build still sends files to Elasticsearch. This reverses the 2026-11-09 choice for the free stack only.
- **Web build:** `npm --prefix web run build:worker` (`vite build --mode worker`) builds the app for the Worker into `web/dist-worker/`: base `/`, the API on the same origin, the in-browser document reader, and the `_headers` file. `worker/scripts/deploy.sh` runs it before `wrangler deploy`. The Cloud Run build (`npm run build`) is unchanged (base `/`, same origin, `web/dist/`). The GitHub Pages app build is retired.
- **Embedding parity with the talk bundles.** The Worker embeds under the model block of the bundles ([contracts/talk-bundle.md](contracts/talk-bundle.md), Embedding conventions): CLS pooling, a talk as `title + "\n" + abstract` with no instruction, and talk search queries with the query instruction. Profile text and people queries are embedded as documents on both sides. `worker/ingest/push-ingest.mjs` refuses to push when the Worker's conventions differ from the bundle model block, and a change of conventions re-embeds every stored vector through the cron and `POST /admin/embed-pending`. Checked against `contracts/fixtures/embedding/reference.v1.json` through the Worker's own code: maximum cosine difference 0.0003 (tolerance 0.02).
- **Contracts v1.** `GET /api/capabilities` serves a tier 2 document (`worker/src/capabilities.js`, public, `max-age=300`). With the `BLE_MASTER_KEYRING` Worker secret, Bluetooth is `derived-v1`: presence with `ble: true` returns `ble_key` and `ble_key_id` once, sightings resolve windows w-1 to w+1 through the reference code in `contracts/js/ble-token.mjs`, answer with `ble_key_id`, and give 403 `ble_rekey` for a retired master. Without the secret it is `server-rotate`. The Phase 4 mitigations (co-location, 10 new people per window and 30 per hour per device, kept in the conference object's SQLite, and a zone only in the requester's own zone) apply to both kinds of token. `node worker/scripts/ble-parity.mjs` checks the Worker's code against the golden vectors and resolution cases in `contracts/fixtures/ble/`.
- **Blocks** belong to the blocker, as on Cloud Run: deleting the blocked profile does not lift a block, the blocks list shows it with `display_name: null`, unblocking by `ref` still works, and the purge removes a block at its `expires_at` (the latest end of the conference and of the two profiles).
- **Unavailable conferences.** When a conference turns unavailable (for example after a failed schedule fetch), its owners can still delete their profile, presence, push subscription and blocks, the admin routes still reach it, and the cron keeps purging its object until it holds no personal data. `push-ingest.mjs` keeps a searchable conference searchable when the weekly fetch of its schedule fails.
- **Source layout:** the backend is `worker/` (`src/`, `ingest/`, `scripts/`, `wrangler.toml`). The Cloud Run server in `server/` is unchanged, and `worker/` is excluded from its image.

## How data stays fresh

- **Talks and conferences:** the workflow `.github/workflows/ingest.yml` runs every Monday at 09:17 UTC and on demand. It discovers upcoming Linux Foundation events and their Sessionize schedules with `scripts/ingest.mjs --dry-run`, then pushes them to the Worker with `worker/ingest/push-ingest.mjs`. The Worker embeds only talks whose text changed, so a rerun costs almost no writes and no neurons. Nothing is committed.
- **Cron Trigger** (`*/10 * * * *`): purges expired profiles, expires presence and meets, retries pending embeddings, and adds up the day's usage across conferences. This does not depend on GitHub.
- GitHub disables scheduled workflows after 60 days without repository activity. Run `gh workflow run ingest.yml` to enable it again. The people purge keeps running on Cloudflare in the meantime.

## Free limits and how the app degrades

| Limit (Free plan) | What the app does about it |
|---|---|
| 100,000 Worker requests and 100,000 Durable Object requests a day | Each conference object meters its own requests, rows read and rows written per UTC day, writes the totals to its storage on its first request, then on the first request 15 seconds or more after the last write or after 100 requests, whichever comes first (so an object evicted from memory loses only about 15 seconds of counts), and the cron adds them up. Each write is one written row, so a conference object busy all day writes up to about 5,760 rows a day for its meter, and four searchable conferences write up to about 23,000 (27% of the 85,000 written-rows soft cap). These rows count toward that cap like any other write. Requests the Worker answers without a conference object (`/api/conferences`, `/api/capabilities`, `/api/health`, `/api/push/vapid` and requests it refuses itself) are not metered. Every conference API response carries `X-Caddie-Pace`; those Worker-level responses do not. A response without the header leaves the app's pace unchanged, and the pace falls back to 1 after 30 minutes without a reading. The web app stretches all its polling by that factor before the cap. Polling also slows when the tab is hidden. If the cap is hit anyway, the Worker answers `503 {error:"daily_limit"}` with `Retry-After` until 00:00 UTC; the app says when the people features come back, and the static app (served without running the Worker) and the offline schedule keep working. |
| 10 ms CPU per Worker request | The Worker only routes. Heavy work runs in the Durable Object, where the limit is far higher. |
| 5,000,000 SQLite rows read a day | Keyword results are cached in memory, queries read row ids first, and near the soft cap (`ROWS_READ_SOFT_CAP`, 3,500,000) search falls back to an in-memory keyword match. |
| 100,000 SQLite rows written a day | Profile search rows are rewritten only when text changes, unchanged talks are not rewritten on ingest, and nudges stop near the soft cap (`ROWS_WRITTEN_SOFT_CAP`, 85,000). |
| 10,000 Workers AI neurons a day | When the quota runs out every route answers with keyword matching only and sets `degraded`. Stored profile and talk vectors are kept, embeddings are made only for changed text, and the cron retries pending ones. |
| Shared venue Wi-Fi IPs | The timer-driven "around now" check uses the larger poll limit, so about 100 people behind one address do not lock each other out. |

`DAILY_REQUEST_BUDGET` (70,000) is the request count after which the pace factor starts to rise. The sizing assumed about 2,000 attendees on one conference day. A conference much larger than that needs the paid Workers plan.

## Go live (about 10 minutes)

These are the steps that took the stack live on 2026-11-11; repeat them only to rebuild it.

1. **The token.** In the Cloudflare dashboard, create an API token (a user token or an account token) with Workers Scripts: Edit, Workers AI: Read and Account Settings: Read (add Workers Tail: Read only if you want CPU readings). Static assets need no extra permission. If the account has no `workers.dev` subdomain, create it under Workers & Pages, Overview. Put the new token in `CLOUDFLARE_API_TOKEN` and keep `CLOUDFLARE_ACCOUNT_ID` set.
2. From the repository root, in order (each step prints names, counts and URLs only):

   ```sh
   bash worker/scripts/deploy.sh                          # builds the app, deploys, prints the app URL
   node worker/scripts/setup-secrets.mjs --only-missing   # ADMIN_TOKEN, REF_SALT, VAPID pair, first BLE_MASTER_KEYRING
   export CADDIE_APP_URL=https://conference-caddie.krlehnardt.workers.dev   # the URL deploy.sh printed
   export CADDIE_API_BASE="$CADDIE_APP_URL"                                 # the API is on the same origin
   export ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token
   node worker/ingest/migrate-from-backup.mjs --backup data/exports/backup-2026-11-10T08-25-32 --api "$CADDIE_API_BASE"
   gh variable set CADDIE_APP_URL --body "$CADDIE_APP_URL"
   gh variable set CADDIE_API_BASE --body "$CADDIE_API_BASE"
   gh workflow run pages.yml                              # talk bundles and the landing page only
   gh workflow run ingest.yml -f events=kubecon-cloudnativecon-north-america-2026
   BASE_URL="$CADDIE_APP_URL" ADMIN_TOKEN_FILE="$ADMIN_TOKEN_FILE" node scripts/smoke.mjs
   node worker/scripts/make-qr.mjs --app-url "$CADDIE_APP_URL"   # rewrites docs/demo/qr-kubecon.png and .svg
   ```

   The secrets live on the Worker, not in the app build, so a later `deploy.sh` keeps them. The smoke runs against the one origin: `BASE_URL` is the app, the API defaults to the same origin, and the admin token makes it a Worker run. Commit the two new QR files through a pull request.
3. Check that the smoke ends with no FAIL, then open the app URL on a phone and scan the new QR code. Migration counts of the live run on 2026-11-11, the same as the last local run: 62 conferences, 717 talks, 114 topics, 898 facets, 132 of 136 people, 0 of 26 reports, 15 of 15 moderation rules.

   The smoke compares the talks the Worker serves with the committed `data/<slug>/talks.ndjson`. The ingest workflow pushes the current Sessionize schedule and commits nothing, so after an ingest the checks `x`, `o` and `sch1` can fail on talks that were added or removed since the last commit. Refresh the local files first with `node scripts/ingest.mjs --event <slug> --dry-run --skip-topics` (no Elasticsearch is needed, and the refreshed files need not be committed).

## Operations runbook

**Redeploy the Worker and the web app.** From the repository root: `bash worker/scripts/deploy.sh`. It builds the app in Worker mode and deploys both together; it is safe to repeat and keeps secrets and data. A change under `web/` reaches phones only through this script. Durable Object migrations are declared in `worker/wrangler.toml`; add a new `[[migrations]]` tag for any new class or schema change, and never edit the `v1` tag.

**Republish the talk bundles.** Push to `main` (any change under `data/`, `config/`, `contracts/`, the bundle builder, the landing page script or `tools/bundles/`) or run `gh workflow run pages.yml`. It does not need the Worker, and the landing page links to `CADDIE_APP_URL` (or says the app is not live yet while that variable is empty). It builds the bundles into `dist-pages/` with `scripts/build-bundles.mjs` (the embedding model is cached by its pinned revision, and a cache miss downloads it once), carries forward the bundle directories the live `conferences.json` names (`scripts/carry-forward-bundles.mjs`), writes the landing page (`scripts/pages-landing.mjs`), checks that nothing else is in the site, and uploads `dist-pages/`. A weekly run on Mondays rebuilds every vector with `--reuse-from none`.

**Rotate the Bluetooth master keyring.** Follow the three steps of [contracts/ble-tokens.md](contracts/ble-tokens.md) (Keys): add the new key as not current, make it current, then retire the old one, each with `npx wrangler secret put BLE_MASTER_KEYRING` (value on standard input only, the JSON `{ "current": "<id>", "keys": { ... } }`). `setup-secrets.mjs` only creates the first keyring and never replaces one.

**Rotate `ADMIN_TOKEN`.** `setup-secrets.mjs` has no flag for rotating only this secret, and running it without `--only-missing` would also replace the VAPID pair, which ends every push subscription. Rotate the token by hand instead, from the repository root, with the value on standard input only:

```sh
umask 077
openssl rand -hex 32 > ~/.config/conference-caddie/admin-token.new
(cd worker && npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token.new)
gh secret set CADDIE_ADMIN_TOKEN --repo KurtLehnardt/conferenceCaddie < ~/.config/conference-caddie/admin-token.new
mv ~/.config/conference-caddie/admin-token.new ~/.config/conference-caddie/admin-token
```

Never print the file. The old token stops working as soon as the Worker secret is replaced. Do not rotate `REF_SALT` unless you accept that every person's `ref` changes (`setup-secrets.mjs --rotate-ref-salt`).

**Add a conference.** Conferences the discovery step knows are picked up by the weekly ingest. To add one now, run `gh workflow run ingest.yml -f events=<slug>`, or from a clone run `node scripts/ingest.mjs --event <slug> --dry-run --skip-topics` followed by `node worker/ingest/push-ingest.mjs --api "$CADDIE_API_BASE" --event <slug>` (with `ADMIN_TOKEN_FILE` set). A conference with a hand-made schedule needs its `data/<slug>/conference.json` and talk file committed first. The Worker refreshes its copy of the conference list every 5 minutes.

**Re-run the migration.** The migration is repeatable: `node worker/ingest/migrate-from-backup.mjs --backup <dir> --api "$CADDIE_API_BASE"`, with `--dry-run` first. Conferences, talks, topics and facets are upserted, sample profiles are copied and re-embedded, and presence, location and Bluetooth fields are never copied. Only sample profiles are copied by default; `--include-real` also copies real profiles, whose owners cannot edit them from the Worker's origin, because their device secrets live on the old origin. The backup holds personal data and stays in the git-ignored `data/exports/`.

**Moderation.** `node worker/scripts/moderation.mjs --event <slug> --hidden` lists what two reports have hidden. See [worker/README.md](../worker/README.md) for undo, delete and purge. The word list is compiled into the Worker, so changing `config/moderation-words.json` needs a deploy.

**Logs and CPU.** The Worker writes one line per request and never a body, header value or query text. Run `wrangler tail` only through the filter described in `worker/README.md`, because raw output can show device secrets. `GET /admin/stats?event=<slug>` with the admin token returns row counts and the day's usage meter.

**Before every commit,** check the staged diff for secret values without printing them (the procedure is in `worker/README.md`), and make sure nothing under `data/exports/` and no `.dev.vars` file is staged.

## Known gaps

- **No CPU reading yet.** The live smoke passed, but nobody has read the deployed Worker's CPU time or a full day of the usage meter yet.
- **The smoke follows the committed talk files.** After the weekly ingest the live schedule can differ from `data/`, and the checks `x`, `o` and `sch1` then fail until the local files are refreshed (see [Go live](#go-live-about-10-minutes), step 3).
- **The Pages talk bundles lag the Worker's schedule.** The bundles are built from the committed `data/`, and the ingest commits nothing, so after an ingest the bundles can hold old times, titles and cancellations until `data/` is refreshed and committed (`node scripts/ingest.mjs --event <slug> --dry-run --skip-topics`). The web app reads `/api/schedule` and is not affected. Native clients read their talks from the Pages bundles through `talks.bundle_base` in `/api/capabilities`, and both Cloud Run and the Worker point that at the same Pages bundles, so native clients are affected whichever backend they use. The released Android 0.3.0 app shows the stale times today: on 2026-11-10, during KubeCon North America 2026, its bundle differed from the Worker's schedule in the times of 11 talks and the titles of 2, and lacked 1 talk. See cor-4 in [REVIEW_NOTES_FREE.md](../REVIEW_NOTES_FREE.md).
- **The first re-embed after a migration repeats the profiles.** The marker of the embedding conventions is written by the first `POST /admin/embed-pending` or cron run, not by the migration, so that first run marks every profile with text as pending and embeds it again (132 profiles on 2026-11-11, about 25 per call or cron run). Talks are not repeated. It costs a little of the daily Workers AI allowance once per conference.
- **People vectors are server-side.** The capabilities document says `people.semantic: server` and `people.live: poll`: client-computed profile vectors and the WebSocket channel of the tier 2 fixture are not implemented.
- **The import body cap is 1 MB** in the Worker, while the web app allows files up to 5 MB. Text files between about 750 KB and 5 MB get 413.
- **Four real profiles were not migrated.** The owners' device secrets live on the Cloud Run origin, so they make a new profile on the Worker's app.
- **English-only embeddings.** bge-small is English-only. If non-English talks matter, set `EMBED_MODEL` to `@cf/baai/bge-m3`, clear the vectors and run the admin re-embed.
- **Ranking differs from Elasticsearch.** FTS5 BM25 and the 0.61 people floor order results a little differently from the E5 and Lucene setup, and the smoke is the only gate.
- **The Cache API does nothing on `workers.dev`.** Public routes are cached in memory and by browser and service-worker headers only.
- **GitHub import** can answer 429 often, because GitHub's anonymous limit is shared by Cloudflare's egress addresses. A `GITHUB_TOKEN` Worker secret would fix it.
- **Android APK.** `.github/workflows/android-apk.yml` still sets `VITE_API_ORIGIN` to the Cloud Run address. Change it to the Worker URL and rebuild before the paid stack is shut down, or installed APKs break.
- **The live Cloud Run service is behind `main`.** Against it the current smoke fails 7 checks (a1, p2, p3, q1, q2, q10, p11). They are existing failures of the old deployment and not caused by the free stack.
- **Free terms are discretionary.** Cloudflare and GitHub can change their free plans.

## Approvals needed (shutting down the paid stack)

Nothing below has been done, and none of it should be done until you approve each step. Several steps cannot be undone. Do them only after the free stack has passed the live smoke for a full day and the Android build points at the Worker. Replace nothing in the commands except where a placeholder is shown. The project is `project-9205d6eb-366e-4844-b77` in `us-west1`.

**0. Decide about the old URL first.** The old address https://conference-caddie-265846417372.us-west1.run.app dies with step 3. People who saved it, the Home Screen icon and old QR codes would break. Before deleting the service you can redeploy a tiny Cloud Run service (or a change to `server/`) that answers with a redirect to the Worker's app URL. That costs a few cents a month at most but keeps Cloud Run and billing alive. Your approval is needed to choose between a redirect and letting the old address end. A redirect cannot carry the old origin's local data (profile and device secret), so people there must make a new profile either way.

1. **Point the Android build at the Worker.** Edit `VITE_API_ORIGIN` in `.github/workflows/android-apk.yml` to the Worker URL, then rebuild the APK.
2. **Take a final Elasticsearch backup and re-run the migration** for any new people:

   ```sh
   ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" node scripts/export-people.mjs   # writes into the git-ignored data/exports/
   ```

3. **Delete the Cloud Run service** (irreversible):

   ```sh
   gcloud run services delete conference-caddie --region us-west1 --project project-9205d6eb-366e-4844-b77
   ```

4. **Delete the Artifact Registry images and the Cloud Build source bucket** (irreversible):

   ```sh
   gcloud artifacts repositories delete cloud-run-source-deploy --location us-west1 --project project-9205d6eb-366e-4844-b77
   gcloud storage ls --project project-9205d6eb-366e-4844-b77        # find the Cloud Build bucket, then:
   gcloud storage rm -r gs://<cloud-build-bucket>
   ```

5. **Delete the Secret Manager secrets** (irreversible, all versions):

   ```sh
   for s in caddie-es-readonly caddie-es-people caddie-vapid-private caddie-vapid-public caddie-github-token; do
     gcloud secrets delete "$s" --project project-9205d6eb-366e-4844-b77
   done
   ```

6. **Remove the runtime service account** and the extra role on the compute service account (list them first; do not change other IAM):

   ```sh
   gcloud iam service-accounts delete caddie-runtime@project-9205d6eb-366e-4844-b77.iam.gserviceaccount.com
   gcloud projects get-iam-policy project-9205d6eb-366e-4844-b77 --format=json     # review before removing anything
   ```

7. **If Elastic is kept for a short while,** delete the two stale indices first. `caddie-people-v1` holds personal data that the purge never reaches, and `caddie-talks-v2` is superseded:

   ```sh
   curl -s -X DELETE -H "Authorization: ApiKey $ELASTISEARCH_API_KEY" "$ES_URL/caddie-people-v1"
   curl -s -X DELETE -H "Authorization: ApiKey $ELASTISEARCH_API_KEY" "$ES_URL/caddie-talks-v2"
   ```

   Then revoke the scoped API keys and delete the native users created for them in Kibana (Stack Management, Security). You decided on 2026-11-09 to leave superseded keys alone, so this needs a fresh yes.
8. **Delete the Elastic Cloud deployment, including the machine-learning node,** in the Elastic Cloud console (Deployments, then Delete), or let the trial lapse. Elastic deletes the data 30 days after the trial ends.
9. **Close or downgrade the Google Cloud billing account,** or let the trial end.
10. **Delete the local backup** `data/exports/backup-2026-11-10T08-25-32/` when you no longer need it, because it holds personal data.
11. **Make the free stack the documented primary** in `DECISIONS.md` and the README's Cloud Run section.
