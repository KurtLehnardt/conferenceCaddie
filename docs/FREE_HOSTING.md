# Free hosting: Conference Caddie on GitHub Pages and Cloudflare

This page describes the free version of Conference Caddie, which has no expiry and needs no Elasticsearch and no Google Cloud. The people features are the main feature: profiles, people matching, talk circles, asks, waves, meets, presence, block, report, moderation, nudges and push. Talk search, browse, schedule, For you, topics and schedule import come along.

## Status on 2026-11-10 (read this first)

The code is finished and tested locally, but **the Worker is not deployed yet**, so the free stack is not live.

- The Cloudflare API token in `CLOUDFLARE_API_TOKEN` is active and Workers AI works with it. Every call on a named Worker script (upload, secrets) answers HTTP 403 "No access to the specified resource", and so do `/workers/subdomain` and `/workers/durable_objects/namespaces`. The token therefore lacks the permission **Workers Scripts: Edit**, even though the brief said it had it. There is no wrangler login on the build machine to fall back on.
- GitHub Pages is enabled (source: GitHub Actions) but nothing has been published, so https://kurtlehnardt.github.io/conferenceCaddie/ shows GitHub's 404 page for now. The Pages and ingest workflows are on `main` and skip with a notice while the repository variable `CADDIE_API_BASE` (and, for the ingest, the secret `CADDIE_ADMIN_TOKEN`) is unset, so they do not fail.
- The last full local run of the ported smoke script (`scripts/smoke.mjs`) against a local Worker with real Workers AI embeddings gave 86 PASS, 0 FAIL.
- The Cloud Run and Elasticsearch stack is untouched and still serves https://conference-caddie-265846417372.us-west1.run.app.

To finish, follow [Go live](#go-live-about-10-minutes) below.

## Live URLs

| What | URL | State |
|---|---|---|
| Web app (GitHub Pages) | https://kurtlehnardt.github.io/conferenceCaddie/ | Enabled, not published yet |
| KubeCon NA 2026 deep link (the QR code) | https://kurtlehnardt.github.io/conferenceCaddie/e/kubecon-cloudnativecon-north-america-2026 | Works once the app is published |
| Worker API | `https://conference-caddie-api.<subdomain>.workers.dev` | Not deployed. `worker/scripts/deploy.sh` prints the real URL, and it is stored in the repository variable `CADDIE_API_BASE`. |
| Old app (Cloud Run) | https://conference-caddie-265846417372.us-west1.run.app | Live, unchanged, the rollback |

## Architecture

```
Phone browser ──HTTPS──> GitHub Pages (static Vite/Preact app, base path /conferenceCaddie/)
      │
      └──HTTPS + CORS, X-Caddie-Device header, no cookies──> Cloudflare Worker "conference-caddie-api"
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
```

- **One Worker.** `worker/src/index.js` routes the 31 API routes. All heavy work runs in Durable Objects, because the Free plan allows 10 ms of CPU per Worker request.
- **Storage: SQLite-backed Durable Objects only.** There is one `ConferenceDO` per conference slug and one `DirectoryDO` named `global`. D1, KV, Vectorize and Pages (Cloudflare's) are not used.
- **Keyword search:** SQLite FTS5 with the porter and unicode61 tokenizer.
- **Semantic search:** vectors from `@cf/baai/bge-small-en-v1.5` (384 dimensions), L2-normalised, stored as float32 BLOBs, with a brute-force dot product over vectors held in Durable Object memory. The model is set by the `EMBED_MODEL` variable. No generative LLM is called anywhere.
- **Ranking:** reciprocal rank fusion in code (rank constant 60). The old "Elasticsearch does all ranking" rule is lifted. People matching also applies a cosine floor of 0.55 to each semantic leg for bge-small, set by `PEOPLE_SEMANTIC_FLOOR`; lower it if recall feels low.
- **Auth:** the device header `X-Caddie-Device: {profile_id}.{secret}`. Only `sha256(secret)` is stored, and the compare is constant time. There are no cookies.
- **CORS:** the Worker allows only the origins in `ALLOWED_ORIGINS` (`https://kurtlehnardt.github.io` and the localhost dev ports) plus requests with no `Origin` header (Node, curl, the Android app).
- **Push:** VAPID Web Push is sent from the Worker with Web Crypto (RFC 8291 and 8292). The VAPID pair is stored as Worker secrets.
- **Privacy rules are unchanged:** reciprocity, circles gated by sharing, presence and zone visibility, symmetric block, silent decline, expiry, delete everywhere, device-secret ownership, and contact shown only to entitled viewers. The UI shows no raw IDs.
- **Schedule import:** the Pages build (`VITE_CLIENT_EXTRACT=1`) reads PDF, DOCX and ODT files in the browser, with pdf.js and fflate loaded on demand, and sends only text to the Worker. The Cloud Run build still sends files to Elasticsearch. This reverses the 2026-11-09 choice for the free stack only.
- **Web build:** `VITE_BASE` sets the path base and `VITE_API_BASE` sets the API address. The Cloud Run build uses neither (base `/`, same origin). The Pages build uses `/conferenceCaddie/`, copies `index.html` to `404.html` so deep links work, and adds a Content-Security-Policy tag naming the Worker.
- **Source layout:** the backend is `worker/` (`src/`, `ingest/`, `scripts/`, `wrangler.toml`). The Cloud Run server in `server/` is unchanged, and `worker/` is excluded from its image.

## How data stays fresh

- **Talks and conferences:** the workflow `.github/workflows/ingest.yml` runs every Monday at 09:17 UTC and on demand. It discovers upcoming Linux Foundation events and their Sessionize schedules with `scripts/ingest.mjs --dry-run`, then pushes them to the Worker with `worker/ingest/push-ingest.mjs`. The Worker embeds only talks whose text changed, so a rerun costs almost no writes and no neurons. Nothing is committed.
- **Cron Trigger** (`*/10 * * * *`): purges expired profiles, expires presence and meets, retries pending embeddings, and adds up the day's usage across conferences. This does not depend on GitHub.
- GitHub disables scheduled workflows after 60 days without repository activity. Run `gh workflow run ingest.yml` to enable it again. The people purge keeps running on Cloudflare in the meantime.

## Free limits and how the app degrades

| Limit (Free plan) | What the app does about it |
|---|---|
| 100,000 Worker requests and 100,000 Durable Object requests a day | Each conference object meters its own requests, rows read and rows written per UTC day, and the cron adds them up. Every response carries `X-Caddie-Pace`, and the web app stretches all its polling by that factor before the cap. Polling also slows when the tab is hidden. If the cap is hit anyway, the Worker answers `503 {error:"daily_limit"}` with CORS headers and `Retry-After` until 00:00 UTC; the app says when the people features come back, and the static app and the offline schedule keep working. |
| 10 ms CPU per Worker request | The Worker only routes. Heavy work runs in the Durable Object, where the limit is far higher. |
| 5,000,000 SQLite rows read a day | Keyword results are cached in memory, queries read row ids first, and near the soft cap (`ROWS_READ_SOFT_CAP`, 3,500,000) search falls back to an in-memory keyword match. |
| 100,000 SQLite rows written a day | Profile search rows are rewritten only when text changes, unchanged talks are not rewritten on ingest, and nudges stop near the soft cap (`ROWS_WRITTEN_SOFT_CAP`, 85,000). |
| 10,000 Workers AI neurons a day | When the quota runs out every route answers with keyword matching only and sets `degraded`. Stored profile and talk vectors are kept, embeddings are made only for changed text, and the cron retries pending ones. |
| Shared venue Wi-Fi IPs | The timer-driven "around now" check uses the larger poll limit, so about 100 people behind one address do not lock each other out. |

`DAILY_REQUEST_BUDGET` (70,000) is the request count after which the pace factor starts to rise. The sizing assumed about 2,000 attendees on one conference day. A conference much larger than that needs the paid Workers plan.

## Go live (about 10 minutes)

1. **Fix the token.** In the Cloudflare dashboard, create an account API token with Workers Scripts: Edit and Workers AI: Read (add Workers Tail: Read only if you want CPU readings). If the account has no `workers.dev` subdomain, create it under Workers & Pages, Overview. Put the new token in `CLOUDFLARE_API_TOKEN`.
2. From the repository root, in order (each step prints names and counts only):

   ```sh
   bash worker/scripts/deploy.sh                          # prints the subdomain and the Worker URL
   node worker/scripts/setup-secrets.mjs --only-missing   # ADMIN_TOKEN, REF_SALT, VAPID pair
   export CADDIE_API_BASE=https://conference-caddie-api.<subdomain>.workers.dev
   export ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token
   node worker/ingest/migrate-from-backup.mjs --backup data/exports/backup-2026-11-10T08-25-32 --api "$CADDIE_API_BASE"
   gh variable set CADDIE_API_BASE --body "$CADDIE_API_BASE"
   gh workflow run pages.yml
   gh workflow run ingest.yml -f events=kubecon-cloudnativecon-north-america-2026
   BASE_URL=https://kurtlehnardt.github.io/conferenceCaddie API_BASE="$CADDIE_API_BASE" \
     ADMIN_TOKEN_FILE="$ADMIN_TOKEN_FILE" node scripts/smoke.mjs
   ```

3. Check that the smoke ends with no FAIL, then open the Pages URL on a phone. Expected migration counts (from the last local run): 62 conferences, 717 talks, 114 topics, 898 facets, 132 of 136 people, 0 of 26 reports, 15 of 15 moderation rules.

## Operations runbook

**Redeploy the Worker.** From the repository root: `bash worker/scripts/deploy.sh`. It is safe to repeat and keeps secrets and data. Durable Object migrations are declared in `worker/wrangler.toml`; add a new `[[migrations]]` tag for any new class or schema change, and never edit the `v1` tag.

**Redeploy the web app.** Push to `main` (any change under `web/`) or run `gh workflow run pages.yml`. The build reads the repository variable `CADDIE_API_BASE`.

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

**Re-run the migration.** The migration is repeatable: `node worker/ingest/migrate-from-backup.mjs --backup <dir> --api "$CADDIE_API_BASE"`, with `--dry-run` first. Conferences, talks, topics and facets are upserted, sample profiles are copied and re-embedded, and presence, location and Bluetooth fields are never copied. Only sample profiles are copied by default; `--include-real` also copies real profiles, whose owners cannot edit them from the Pages origin, because their device secrets live on the old origin. The backup holds personal data and stays in the git-ignored `data/exports/`.

**Moderation.** `node worker/scripts/moderation.mjs --event <slug> --hidden` lists what two reports have hidden. See [worker/README.md](../worker/README.md) for undo, delete and purge. The word list is compiled into the Worker, so changing `config/moderation-words.json` needs a deploy.

**Logs and CPU.** The Worker writes one line per request and never a body, header value or query text. Run `wrangler tail` only through the filter described in `worker/README.md`, because raw output can show device secrets. `GET /admin/stats?event=<slug>` with the admin token returns row counts and the day's usage meter.

**Before every commit,** check the staged diff for secret values without printing them (the procedure is in `worker/README.md`), and make sure nothing under `data/exports/` and no `.dev.vars` file is staged.

## Known gaps

- **Not deployed yet.** See the status section above. No live smoke run, CPU reading on the deployed Worker or live usage meter exists yet.
- **Contracts v1 conformance is partial.** The Worker does not serve `GET /api/capabilities`, and its Bluetooth support is the legacy client-supplied token, not the derived `ble_key` and `token_w` scheme with co-location checks and caps. The Pages build does not publish `capabilities.json` or the talk bundles (`scripts/build-bundles.mjs`, [docs/BUNDLES.md](BUNDLES.md)), because the Pages workflow does not run the bundle step yet. Native apps that depend on the contracts need that work.
- **Shared github.io origin.** Every project site of the account shares `https://kurtlehnardt.github.io`. Another site there could read the device secret in `localStorage`, and the origin is an allowed CORS origin. A custom domain or a dedicated GitHub account removes the risk.
- **Four real profiles were not migrated.** The owners' device secrets live on the Cloud Run origin, so they make a new profile on Pages.
- **English-only embeddings.** bge-small is English-only. If non-English talks matter, set `EMBED_MODEL` to `@cf/baai/bge-m3`, clear the vectors and run the admin re-embed.
- **Ranking differs from Elasticsearch.** FTS5 BM25 and the 0.55 people floor order results a little differently from the E5 and Lucene setup, and the smoke is the only gate.
- **The Cache API does nothing on `workers.dev`.** Public routes are cached in memory and by browser and service-worker headers only.
- **GitHub import** can answer 429 often, because GitHub's anonymous limit is shared by Cloudflare's egress addresses. A `GITHUB_TOKEN` Worker secret would fix it.
- **Android APK.** `.github/workflows/android-apk.yml` still sets `VITE_API_ORIGIN` to the Cloud Run address. Change it to the Worker URL and rebuild before the paid stack is shut down, or installed APKs break.
- **The live Cloud Run service is behind `main`.** Against it the current smoke fails 7 checks (a1, p2, p3, q1, q2, q10, p11). They are existing failures of the old deployment and not caused by the free stack.
- **Free terms are discretionary.** Cloudflare and GitHub can change their free plans.

## Approvals needed (shutting down the paid stack)

Nothing below has been done, and none of it should be done until you approve each step. Several steps cannot be undone. Do them only after the free stack has passed the live smoke for a full day and the Android build points at the Worker. Replace nothing in the commands except where a placeholder is shown. The project is `project-9205d6eb-366e-4844-b77` in `us-west1`.

**0. Decide about the old URL first.** The old address https://conference-caddie-265846417372.us-west1.run.app dies with step 3. People who saved it, the Home Screen icon and old QR codes would break. Before deleting the service you can redeploy a tiny Cloud Run service (or a change to `server/`) that answers with a redirect to https://kurtlehnardt.github.io/conferenceCaddie/. That costs a few cents a month at most but keeps Cloud Run and billing alive. Your approval is needed to choose between a redirect and letting the old address end. A redirect cannot carry the old origin's local data (profile and device secret), so people there must make a new profile either way.

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
