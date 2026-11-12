# Conference Caddie

Conference Caddie finds the people at a conference whose experience overlaps what you're working on or want to learn, and tells you when they're nearby. Turn on "Around," and the app nudges you when a strong match is in the same hall, so a coffee line becomes a conversation; or ask someone to talk shop and agree where to meet. It also suggests talks that match your interests. It leaves schedules, attendee lists and messaging to Sched and the official conference tools.

It runs as a web app (PWA) on any phone, and as an Android app (.apk) that adds Bluetooth: **only the Android app uses Bluetooth**; the web app finds people nearby by zone and, optionally, GPS.

<p>
  <img src="docs/screenshots/find-by-experience.png" alt="Searching people for 'postgres bare metal' shows a sample attendee whose own words match, with the matching passage highlighted" width="200">
  <img src="docs/screenshots/nudge-nearby.png" alt="A nudge: someone who has rebuilt a 3,000-node cluster's etcd is in your room right now, with a See who button" width="200">
  <img src="docs/screenshots/meet-up.png" alt="The meet-up screen: you're both in the Expo hall, how to spot them, how to spot me, and the meeting point" width="200">
  <img src="docs/screenshots/talks-for-you.png" alt="For you: talks matched to your topics, with the reason shown" width="200">
</p>

## Install

**On your phone (web app).** Open https://conference-caddie.krlehnardt.workers.dev/, the free app served by the Cloudflare Worker (the API is on the same origin), or scan the QR code for KubeCon + CloudNativeCon North America 2026 (`docs/demo/qr-kubecon.png`), which opens https://conference-caddie.krlehnardt.workers.dev/e/kubecon-cloudnativecon-north-america-2026. See [docs/FREE_HOSTING.md](docs/FREE_HOSTING.md) for how it is hosted. To get nudges with the app closed, add it to your Home Screen (iPhone: Share, then Add to Home Screen; Android: the install prompt) and turn on "Nudge me even when the app is closed". No account is needed.

<img src="docs/demo/qr-kubecon.png" alt="QR code that opens Conference Caddie for KubeCon + CloudNativeCon North America 2026" width="160">

**On Android with Bluetooth (.apk).** Download the latest debug APK from the [Android APK workflow](https://github.com/KurtLehnardt/conferenceCaddie/actions/workflows/android-apk.yml) (open the newest successful run, then Artifacts; GitHub sign-in required), unzip it, open the `.apk` on the phone and allow installs from your browser. Or from a computer: `gh run download <run-id> --repo KurtLehnardt/conferenceCaddie && adb install -r */*.apk`. Bluetooth proximity needs Android 8.0 or later with Bluetooth 5 extended advertising; building it yourself is described in [docs/ANDROID.md](docs/ANDROID.md).

**Run it locally (no keys, sample data).**

```sh
npm --prefix web ci
VITE_MOCK=1 npm --prefix web run dev     # http://localhost:5173 with fixture conferences and sample people
```

The older Cloud Run address, https://conference-caddie-265846417372.us-west1.run.app, stays up until the paid stack is shut down; see [docs/FREE_HOSTING.md](docs/FREE_HOSTING.md) for the plan and the status of the move.

**Run it for free (no expiry).** The free stack is one Cloudflare Worker (`worker/`) that serves the web app as static assets and the API on the same origin, keeps everything in SQLite-backed Durable Objects and uses Workers AI for embeddings. GitHub Pages publishes only the public talk bundles. It needs no Elasticsearch and no Google Cloud. [docs/FREE_HOSTING.md](docs/FREE_HOSTING.md) describes the architecture, the free limits, how the app degrades and the operations runbook, and [worker/README.md](worker/README.md) has the deploy steps.

**Run your own server (Cloud Run and Elasticsearch).** Node 22 or later, an Elasticsearch deployment, and Google Cloud Run for the hosted service:

```sh
npm ci && npm --prefix web ci
export ES_URL="https://<your-deployment>.es.io:443"   # required, no default: the scripts and the server refuse to run without it
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run es:setup         # talks, conferences, topics
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run people:setup     # people, presence, meets, blocks
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run ingest -- --event kubecon-cloudnativecon-north-america-2026
npm run deploy                                                          # Cloud Run; see the checklist for every step
```

`ES_URL` has no default. A script that makes an Elasticsearch request exits with "Set ES_URL." when it is unset (`--dry-run`, `--no-fetch` and `--list` runs make no request and need neither it nor a key), and the server (`server/es-url.mjs`) does not start without it, so your API keys can never be sent to somebody else's cluster. `npm run deploy` (`scripts/deploy.sh`) reads its settings from the environment, or from an optional file of `KEY=VALUE` lines at `~/.config/conference-caddie/deploy.env` (override the path with `CADDIE_DEPLOY_ENV`; the environment wins over the file, and the script prints which one it used before it calls gcloud; it checks every value first):

| Variable | Meaning |
|---|---|
| `GC_PROJECT` | Google Cloud project id. Required. Also read by `scripts/create-es-keys.mjs`, `scripts/vapid-keys.mjs` and `scripts/ble-master.mjs`. |
| `GC_REGION` | Cloud Run region. Default `us-west1`. |
| `ES_URL` | The Elasticsearch address. Required. Passed to the service as `ES_URL`. |
| `CADDIE_BUNDLE_BASE` | The published talk bundles' base URL, an https URL ending in `/`. Required by `deploy.sh`. Passed to the service as `TALKS_BUNDLE_BASE` (the server's own built-in default stays for tests and local development). |
| `VAPID_SUBJECT` | The contact the push services receive: an `https:` URL or a `mailto:` address you control. Required, no default. |
| `SERVICE` | Cloud Run service name. Default `conference-caddie`. |

Other maintainer-specific addresses are read from the environment too: `CADDIE_APP_URL` (or `APP_URL`) for `scripts/make-dummy-people.mjs`, `CADDIE_BUNDLE_BASE`, `CADDIE_SITE_URL` and `CADDIE_SMOKE_CONFERENCE` for the bundle, landing-page and smoke scripts, and `CADDIE_BACKEND` plus `CADDIE_BUNDLE_BASE` for `native/scripts/release-smoke.sh`. `scripts/test/fork-values.test.mjs` fails when the maintainer's cluster id, project id, Cloud Run address or `workers.dev` host appears in code outside a short allow-list of documents and CI files.

[docs/OPERATOR_CHECKLIST.md](docs/OPERATOR_CHECKLIST.md) lists every setup step in order (reports, moderation rules, push keys, the smoke test), with the environment variables each one reads.

## Run your own

Anyone can fork this repository and run a complete deployment with their own accounts and keys. [docs/FORK.md](docs/FORK.md) is the guide: it compares the three tiers and what each costs (tiers 1 and 2 are free forever; tier 3, Cloud Run with Elastic Cloud, is paid; Apple's 99 USD membership is optional and needed only to distribute the iOS app), lists every value a fork must change, and links the step-by-step guides in [docs/fork/](docs/fork/). A public fork runs GitHub Actions for free; a private fork gets about 2,000 minutes a month, and macOS minutes count ten times.

Administration is command line only. `node scripts/caddie-admin.mjs -h` (or `npm run admin -- -h`) searches and deletes attendees, works the moderation queue, manages conferences and reads usage on either backend, with dry runs by default and a private audit log. See [docs/ADMIN_CLI.md](docs/ADMIN_CLI.md).

## How people find each other

| | Web app (PWA) | Android app (.apk) |
|---|---|---|
| Find people by what they've built or want to learn | yes | yes |
| "Around": pick a zone (a room, Expo hall, Registration, Food and coffee, Hallway, Outside) | yes | yes |
| GPS position as a ranking signal, shown to others only as a band (same zone, near, around) | yes, optional | yes, optional |
| Nudge when a strong match is in your zone | in the app; by push when installed to the Home Screen | yes |
| Bluetooth: a notification when an opted-in strong match is within a few metres, phone in pocket | **no** (browsers cannot advertise over Bluetooth) | **yes** |
| Ask to talk shop, Wave, meet-up with a meeting point and "how to spot me" | yes | yes |

Asks are now-only: you can ask someone who is around, they have 15 minutes to answer, and accepting means now. Someone who isn't around can be watched, and the app tells you when they turn up. Nothing is booked in advance.

What is shared, with whom, for how long: your profile text, to people visible at that conference, until its last day; your zone, only to people who are also around, only while you are; how to spot you and a rough distance, only to the one person you accepted, only until you meet; the Bluetooth code, to nobody but the server, for ten minutes at a time. Nothing about where you were is kept. Block is symmetric and silent; Report hides a profile after two reports; short texts pass a filter. There is no sign-in: a random device secret, stored only as a hash, protects your profile, and "Delete my profile" removes it at once.

## Everything else it does

- **For you**: talk suggestions from your topics and free text, with the matching passage shown.
- **Search**: hybrid keyword and semantic search over the conference's talks, with filters for day, time, track and the conference's own tags. **Schedule** shows the whole conference a day at a time.
- **Talk circles**: mark a talk "I'm interested" and, separately, share your profile with others interested in it.
- **My schedule**: the talks you marked, as a list or a day timeline, kept on your device. It is a view, not a planner.
- **Import my schedule** (Settings): a PDF, CSV, text, .ics or JSON schedule from anywhere, matched to the conference's real talks. The file is read once and never stored.
- **Import from GitHub** (Profile): proposes "things I've built" text and topics from your public repositories; nothing is stored until you accept it.
- **Offline**: after one visit, the schedule and keyword search work without a connection.

## How it works

- Conference schedules are committed snapshots of public Sessionize feeds. Nothing is fetched at runtime.
- Conferences are discovered from the Linux Foundation events list (`events.linuxfoundation.org`), which names each event's schedule page; the page carries the Sessionize feed to read. Only the operator runs ingestion, from the CLI.
- Elasticsearch is the only data store and does all matching, ranking and filtering: lexical plus `semantic_text` retrievers fused with reciprocal rank fusion for search, people and suggestions. No generative model is used.
- Embeddings come from the E5 small model running on the Elasticsearch deployment's own ML node (inference endpoint `caddie-e5-small`). If embedding fails for any reason, search, suggestions and people matching fall back to keyword matching for a minute and the app says so; profiles still save.
- Each conference's topic list is built from its talk titles at ingestion, with an Elasticsearch analyzer and aggregation.
- One Node.js service on Cloud Run serves the app and the API. It runs as the dedicated `caddie-runtime` service account, which can read only the secrets `scripts/deploy.sh` mounts and has no project-level roles. Those are two scoped Elasticsearch keys (a read-only key for talks, conferences and topics, and a people key that can only read and write the `caddie-people*` indices), the VAPID private key that signs push nudges, and optionally a read-only GitHub token for the profile import. The text classifier uses the service account's own token; no key. `docs/OPERATOR_CHECKLIST.md` lists the operator steps in order.

- The Android companion (`web/android/`, see `docs/ANDROID.md`) is the same web app in a Capacitor shell plus one Bluetooth plugin; the debug APK is built by the GitHub Actions workflow on `android/**` branches. The web app and the companion share one API, one server and one set of storage keys.

## Adding a conference

With `ELASTISEARCH_API_KEY` set to an admin-capable key:

```sh
npm run ingest -- --list                 # upcoming Linux Foundation events and their platform
npm run ingest -- --event <slug>         # ingest one event and build its topics
npm run ingest -- --all-upcoming         # every upcoming event whose schedule is on Sessionize
npm run topics -- --event <slug>         # rebuild one event's topic list, for example after editing its fix-up file
node scripts/build-facets.mjs [<slug> ...]  # rebuild the track, room, speaker and tag names used for suggested chips; run it after ingesting
```

Re-running is safe: unchanged talks are not re-embedded. Talks that left the schedule are deleted and leave the profiles that shared for them; a run that would delete more than 10 talks and more than 10% of a conference's talks is refused for that conference unless you pass `--allow-shrink`. Events on other platforms, or with no published schedule, appear in the switcher as "Schedule not available here yet". Per-conference topic fix-ups (rename, merge, remove) live in `data/topics/{slug}.json`; the shared stoplist is `config/topic-stoplist.txt`.

For the API and index shapes, see [docs/CONTRACT.md](docs/CONTRACT.md). Design choices are recorded in [DECISIONS.md](DECISIONS.md). The plan for native Android and iOS apps, with deployment tiers that cost nothing to run, is in [docs/NATIVE_PLAN.md](docs/NATIVE_PLAN.md).

The app began as an entry in the Elasticsearch "Find the Right Talk" track at a hackathon during KubeCon + CloudNativeCon North America 2026.

## License

Apache License 2.0. See [LICENSE](LICENSE).

The license covers the code and documentation written in this repository. It does not cover the schedule snapshots: `data/raw/**`, the talk and speaker text in `data/*/talks.ndjson`, and any other copied schedule content under `data/` are snapshots of public conference schedules, copyright their owners. Linux Foundation site content is available under CC BY 3.0 (https://www.linuxfoundation.org/legal/terms); session and speaker content is copyright the speakers and organizers. See [NOTICE](NOTICE) for these and for the third-party files `config/moderation-words.json` and `data/windows-zones.json`.
