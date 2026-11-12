# Run your own Conference Caddie

This repository is meant to be cloned. Anyone can fork it and run a complete deployment with their own accounts, their own keys and their own addresses, without any access to the maintainer's accounts. This page is the starting point: it explains the three deployment tiers, what each one costs, which one to choose, the order of the steps and every value that a fork has to change. The step-by-step guides are in `docs/fork/`, and the operator command line is described in [ADMIN_CLI.md](ADMIN_CLI.md).

Nothing in this guide needs a secret to be written into the repository. Keys live in your shell environment, in files under your home directory with mode 0600, in the secret stores of your hosting accounts and in GitHub secrets. Where a guide shows a value, it is a placeholder in angle brackets.

## The three tiers

| Tier | What you run | Who it is for | Recurring cost |
|---|---|---|---|
| 1. Static bundles | A GitHub repository with GitHub Pages serving the public talk bundles, `conferences.json` and `capabilities.json`, built by a GitHub Actions workflow. | Trying the apps, and conferences where the talk features are enough. There are no people features and no operator commands, because there is no server. | Free |
| 2. Free backend | Tier 1, plus one Cloudflare Worker that serves the web app and the API on one origin, with SQLite-backed Durable Objects for all storage (there is no D1 database) and Workers AI for embeddings. | Operators who want the people features (find people, nudges, meet-ups) without paying. | Free on the Cloudflare Workers Free plan, within the limits listed below |
| 3. Paid backend | Tier 1, plus a Node service on Google Cloud Run and an Elasticsearch deployment on Elastic Cloud. | Operators who want Elasticsearch ranking and no free-tier ceilings, and who accept a monthly bill. | **Paid.** Elastic Cloud has a trial and then a subscription, and Cloud Run needs a Google Cloud billing account. |

The older planning document `docs/NATIVE_PLAN.md` (section 7.1) lists tier 2 as using D1. That is out of date: the Worker stores everything in Durable Objects, and `worker/wrangler.toml` binds no D1 database. This page is the correct description.

Tier 3 is a paid option, and it is the only tier that cannot be run free forever. The application's search and people matching are written for Elasticsearch and are tied to Elastic Cloud by the inference endpoint `caddie-e5-small`, which runs the E5 embedding model on the Elastic deployment's own machine-learning node (`scripts/es-setup.mjs`, `docs/CONTRACT.md`). Elastic Cloud offers a time-limited trial and then a paid subscription; it has no free-forever tier (https://www.elastic.co/pricing). Choose tier 3 only if you want that stack.

## What each thing costs

| Item | Cost | Notes and source |
|---|---|---|
| GitHub Pages (tier 1) | Free | A site of up to 1 GB with a soft bandwidth limit of 100 GB a month (https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits). Pages from a private repository needs a paid GitHub plan, so the simplest free setup is a public fork. |
| GitHub Actions, public repository | Free | Standard runners are free in public repositories (https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions). |
| GitHub Actions, private repository | About 2,000 Linux minutes a month on GitHub Free | The allowance is a monthly amount of compute that equals about 2,000 minutes at the Linux rate. **macOS minutes count ten times as much as Linux minutes**, so a private repository that builds the iOS app uses its allowance about ten times faster. The iOS jobs in `.github/workflows/native.yml` run on macOS, and that workflow also runs on a push to `main` that changes `data/**`. Keep the repository public, or read [Private copies and Actions minutes](#private-copies-and-actions-minutes). |
| Cloudflare Workers Free (tier 2) | Free | 100,000 requests a day, 10 ms of CPU per request, and for Durable Objects 100,000 requests a day, 5 million rows read, 100,000 rows written and 5 GB of storage (https://developers.cloudflare.com/workers/platform/pricing/). The app slows its own polling and degrades to keyword search near these limits; see `docs/FREE_HOSTING.md`, "Free limits and how the app degrades". A conference much larger than about 2,000 attendees on one day needs the paid Workers plan. |
| Cloudflare Workers AI (tier 2) | Free up to 10,000 neurons a day | Used only to embed changed text (https://developers.cloudflare.com/workers-ai/platform/pricing/). |
| Cloudflare Zero Trust (optional) | A free plan exists, but Cloudflare may ask for a payment method before you can use it | Only for the optional Access layer in [TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md). The seat limit of the free plan is not confirmed by Cloudflare's own plans page (https://www.cloudflare.com/plans/zero-trust-services/), so check it before you rely on it. The app does not need Access. |
| Elastic Cloud (tier 3) | **Paid** | Trial, then subscription; the ML node that runs `caddie-e5-small` is part of the bill (https://www.elastic.co/pricing). |
| Google Cloud Run (tier 3) | **Needs a billing account** | Cloud Run has a free tier, but a project cannot use it without a billing account (https://cloud.google.com/run/pricing). |
| Apple Developer Program | 99 USD per membership year, **optional** | Needed only to distribute the iOS app through TestFlight or the App Store. A free Apple ID can run the app from Xcode on your own device for seven days at a time (https://developer.apple.com/programs/enroll/, https://developer.apple.com/support/compare-memberships/). Nothing else in this project needs it. The web app, the Android app and both free tiers cost nothing in Apple fees. |
| Google Play, Firebase | Not needed | The Android app is distributed as an APK from your own GitHub Actions run. Firebase Cloud Messaging is optional and has no charge for sending messages, but it is only wired into tier 3. |

Summary: tiers 1 and 2, the web app and the Android app cost nothing to run. The only optional fee is Apple's, and only for iOS distribution. Tier 3 costs money.

## Which tier should I run

- You only want to show the talk features, or you have no operator time: run tier 1 only.
- You want the people features and want to pay nothing: run tier 2. This is the recommended choice for almost every fork.
- You already run Elastic Cloud, or you need Elasticsearch ranking, the percolator rules and no daily ceilings: run tier 3, knowing it is a paid stack.
- You can run tier 1 and tier 2 together, and you should: tier 2 uses the tier 1 bundles for the talk features. Tier 3 also uses them.

## Order of the steps

1. Fork the repository on GitHub, clone your fork and run `gh repo set-default <owner>/<repo>` in it ([TIER1_PAGES.md](fork/TIER1_PAGES.md#1-fork-and-enable-actions) explains why). Keep the fork public unless you have a plan for Actions minutes (see below). Run `npm ci` now, before any key is in your shell.
2. Read the [fork-proofing table](#values-a-fork-must-change) below and note which values apply to the tier you chose.
3. Tier 1: follow [fork/TIER1_PAGES.md](fork/TIER1_PAGES.md). Every other tier builds on it.
4. Tier 2: follow [fork/TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md). Or tier 3: follow [fork/TIER3_GCP_ELASTIC.md](fork/TIER3_GCP_ELASTIC.md).
5. Install the operator command line and point it at your backend: [ADMIN_CLI.md](ADMIN_CLI.md). This is how you search and delete attendees, work the moderation queue, add and remove conferences and read usage.
6. Optionally build the apps against your own backend: [fork/APPS.md](fork/APPS.md).

## Values a fork must change

Everything that names the maintainer's deployment is listed here, with the file where it lives. Scripts, the server and the Worker take these values from the environment or from repository variables. The files marked "edit" hold a value that you change in your fork; the files marked "environment" need no edit because they read a variable.

The repository has a test, `scripts/test/fork-values.test.mjs`, that fails when four of the maintainer's identifiers (the Elastic Cloud cluster id, the Google Cloud project id, the Cloud Run address and the `workers.dev` host) appear in code outside a short list of documents, CI files and the official apps' compiled-in constants. It does not look for the maintainer's GitHub name, so a few other defaults that name the original repository remain, and the table lists them: the bundle-base fallback in the Worker and the server, the source link in the web app's Settings, and the dummy-data helper. They are harmless to a fork (a link, a sample value, or a fallback that `TALKS_BUNDLE_BASE` or `CADDIE_BUNDLE_BASE` overrides), but you may want to change them.

| Value | Where | What to do |
|---|---|---|
| Elasticsearch address (tier 3) | `ES_URL` in the environment or in `deploy.env`. Read by the scripts under `scripts/`, by `scripts/deploy.sh` and by `server/es-url.mjs`. | Environment. There is no default, so a fork can never send its keys to another cluster. A script that needs it stops with "Set ES_URL." |
| Google Cloud project and region (tier 3) | `GC_PROJECT` (required) and `GC_REGION` (default `us-west1`), read by `scripts/deploy.sh`, `scripts/create-es-keys.mjs`, `scripts/vapid-keys.mjs` and `scripts/ble-master.mjs`. | Environment or `deploy.env`. |
| Bundle base address | `CADDIE_BUNDLE_BASE` for `scripts/deploy.sh`, `scripts/build-bundles.mjs`, `scripts/carry-forward-bundles.mjs`, `scripts/smoke.mjs` (also `SMOKE_BUNDLE_BASE`) and `native/scripts/release-smoke.sh` (which also needs `CADDIE_BACKEND`); the repository variable `CADDIE_BUNDLE_BASE` for `.github/workflows/pages.yml`; `TALKS_BUNDLE_BASE` in `[vars]` of `worker/wrangler.toml` for the Worker. | Environment, repository variable, and one edit of `worker/wrangler.toml` (tier 2). |
| Site address of the Pages site | The repository variable `CADDIE_SITE_URL` (optional; derived from your repository by default), and `CADDIE_SITE_URL` for `scripts/pages-landing.mjs`. | Environment. |
| App address | The repository variable `CADDIE_APP_URL`, and `CADDIE_APP_URL` for `scripts/make-dummy-people.mjs`, `scripts/pages-landing.mjs` and `worker/scripts/make-qr.mjs`. | Environment. |
| Conference the smoke test uses | `CADDIE_SMOKE_CONFERENCE` (or `SMOKE_CONFERENCE`) for `scripts/smoke.mjs`; the default is a conference whose data is committed in `data/`. | Environment, if you want another conference. |
| Takedown contact | The repository variable `CADDIE_TAKEDOWN_URL` for `pages.yml`; `--takedown` and `--publisher-name` for `scripts/build-bundles.mjs`. | Set the variable to an https address or a `mailto:` address that you read. It is published inside every bundle. You are the publisher of the schedule data on your site and receive its takedown requests; see [DATA_NOTES.md](../DATA_NOTES.md) and [fork/TIER1_PAGES.md](fork/TIER1_PAGES.md#the-data-is-not-yours-takedowns). |
| Worker API base for the ingest workflow | The repository variable `CADDIE_API_BASE` (`.github/workflows/ingest.yml`) and the repository secret `CADDIE_ADMIN_TOKEN`. | Repository settings. |
| Admin signature rollback switch (removed) | Nothing reads it any more. The repository variable `CADDIE_ADMIN_SIG_VERSION` and the environment variable of the same name made the clients sign v1 until step e of "Admin signature v2" in `DECISIONS.md` removed them; every client now signs v2, and a client that still finds the variable set to a non-empty value prints one warning that it is ignored. The Worker still accepts v1 while its `ADMIN_SIG_MIN` is `"1"` (the rollback, which belongs in `[vars]` of `worker/wrangler.toml`, committed and deployed, and never in a secret). | Delete the repository variable if your fork has it, and unset the environment variable. When you bring a fork up to date and its Worker predates step b of "Admin signature v2" (the Worker that accepts v2), deploy the Worker first, or the ingest fails with 404 until you do; see [fork/TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#5-repository-variables-the-ingest-secret-and-the-first-conference). |
| Web Push contact (tier 3) | `VAPID_SUBJECT` for `scripts/deploy.sh`, from the environment or `deploy.env`. It is required and has no default. | Environment or `deploy.env`. Use an `https:` page or a `mailto:` address you control. |
| User-Agent of the schedule fetches | `CADDIE_USER_AGENT` for `scripts/ingest.mjs` (through `scripts/lib/http.mjs`), and the repository variable `CADDIE_USER_AGENT` for `.github/workflows/ingest.yml`. In CI the default is `ConferenceCaddie-ingest/0.2 (+https://github.com/<your repository>)`, so a fork's contact is its own repository; outside CI the default names no one. | Optional: set the variable to a string with your own contact, for example `my-caddie-ingest (+mailto:you@example.org)`, to override it. The value must be printable ASCII of at most 200 characters, or it is ignored with a warning. |
| Web Push contact (tier 2) | `VAPID_SUBJECT` in `[vars]` of `worker/wrangler.toml`. It names the maintainer's repository page. | Edit. Use your own `https:` page or a `mailto:` address. |
| Bundle address fallback in the Worker | `DEFAULT_BUNDLE_BASE` in `worker/src/capabilities.js` is used when `TALKS_BUNDLE_BASE` is not set. | Set `TALKS_BUNDLE_BASE` and leave the code alone. |
| Bundle address fallback in the server (tier 3) | `DEFAULT_BUNDLE_BASE` in `server/capabilities.mjs`, used only when `TALKS_BUNDLE_BASE` is not set. `scripts/deploy.sh` always sets it from `CADDIE_BUNDLE_BASE`. | Nothing to edit if you deploy with `deploy.sh`. |
| Emulator release smoke in CI | The repository variables `CADDIE_BACKEND` (your server's base address) and `CADDIE_BUNDLE_BASE` read by `.github/workflows/native.yml` for `native/scripts/release-smoke.sh`. Without them the workflow falls back to the official values. | Set both repository variables if you run the native workflow. |
| Source link in the web app | The link to the original repository in `web/src/components/settings.tsx` (Settings). | Optional edit; it is a link, not a credential. |
| Dummy profile data | The LinkedIn address in `scripts/make-dummy-people.mjs` that the sample profiles carry. | Harmless; change it if you generate sample people. |
| API address of the Capacitor Android app | `VITE_API_ORIGIN` in the `env:` of the `apk` job of `.github/workflows/android-apk.yml`, which names the maintainer's older Cloud Run service. | Edit, or build locally as `docs/ANDROID.md` describes. |
| Backends compiled into the native apps | `Defaults.BACKEND`, `Defaults.FALLBACK_BACKEND` and `Defaults.FALLBACK_BUNDLE_BASE` in `native/shared/src/commonMain/kotlin/app/conferencecaddie/shared/core/CaddieCore.kt` and `BuildDefaults.OFFICIAL_SERVER` in `native/composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/shell/StandaloneShell.kt`. | Edit. See [fork/APPS.md](fork/APPS.md). |
| Application id | `app.conferencecaddie` in `native/androidApp/build.gradle.kts`, `web/android/app/build.gradle`, `web/capacitor.config.ts`, `native/iosApp/Configuration/Config.xcconfig` (`BUNDLE_ID`), `.github/workflows/native.yml` (the provisioning profile key of the export options) and `native/scripts/release-smoke.sh` (`PKG`). | Edit for iOS distribution (an Apple bundle id belongs to one team) and whenever you want your Android build to install beside or instead of the official app. See [fork/APPS.md](fork/APPS.md). |
| Signing keys and certificates | Android keystore, Apple distribution certificate and profile, App Store Connect key: GitHub secrets in the `release` environment, and the repository variable `ANDROID_RELEASE_CERT_SHA256`. | Create your own; the maintainer's are never in the repository. See [fork/APPS.md](fork/APPS.md). |
| README links and QR code | `README.md` install links and `docs/demo/qr-kubecon.png`. | Regenerate the QR code with `node worker/scripts/make-qr.mjs --app-url "$CADDIE_APP_URL"` (it fetches a pinned QR code tool with `npx` on the fly, so it needs the network and runs third-party code once) and edit the links. |
| Documents that record the maintainer's deployment | `DECISIONS.md`, `docs/CONTRACT.md`, `docs/OPERATOR_CHECKLIST.md`, `docs/FREE_HOSTING.md`, `worker/README.md`, `native/README.md`, `REVIEW_NOTES.md` and `REVIEW_NOTES_FREE.md`. | No action. They record facts about the original deployment, and the fork-values test allows them. When you follow them, substitute your own values. |

## Private copies and Actions minutes

- **A fork of a public repository cannot be made private.** If you want a private copy, create a new private repository and push this one's history into it (GitHub calls it duplicating a repository): `git clone --bare <the public repository's address>`, then `git push --mirror <your new private repository's address>` from inside the bare clone. You lose the fork link, so run `gh repo set-default <owner>/<repo>` in your new clone.
- **GitHub Pages on a private repository needs a paid GitHub plan**, so tier 1 as described here is a public-repository feature on GitHub Free. Without Pages you would publish the bundles from some other static host and set `CADDIE_BUNDLE_BASE` to it.
- **Environment secrets need a paid plan on private repositories.** The signing jobs use the environment `release`. Under GitHub Free a private repository cannot have environment secrets or branch rules, so the keys would have to be repository secrets, readable by a workflow on any branch ([APPS.md](fork/APPS.md#ci-secrets-variables-and-the-release-environment)).
- **The native workflow runs macOS jobs on pushes that change `data/**`** as well as `native/**`. If you keep a private copy and do not build the native apps, turn it off with `gh workflow disable native.yml --repo <owner>/<repo>`, which stops those minutes (counted ten times) from being used.

## Accounts and tokens

Give each tool the least reach it needs and a short life.

- **GitHub CLI.** Instead of `gh auth login` with your whole account, use a fine-grained personal access token limited to your fork only, with Actions, Secrets, Variables and Environments (read and write), Pages and Contents, and Administration only for the step that creates the `release` environment. Put it in the shell as `GH_TOKEN` with `read -rs GH_TOKEN && export GH_TOKEN`, and unset it afterwards.
- **Cloudflare.** An API token with "Account Resources" set to only your account, the one permission "Workers Scripts: Edit" and an expiry date ([fork/TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#1-the-api-token-and-the-account-id)).
- **Elastic.** A setup key that expires after one day and is deleted when the setup is finished, and a limited operator key for the command line ([fork/TIER3_GCP_ELASTIC.md](fork/TIER3_GCP_ELASTIC.md#the-operator-key)).

## Secrets hygiene

These rules apply to every guide.

- Never put a key, a token, a password or a keystore in the repository, in an issue, in a pull request or in a chat transcript. Both `.gitignore` files exclude `*.jks`, `*.keystore`, `*.p8` and `*.p12`.
- Read a secret into the shell with `read -rs VAR && export VAR`, so it is not shown and not in your shell history, or with `VAR="$(cat <file of mode 0600>)"`. Never type a key as an argument of a command, where it lands in your history and in the process list; use a tool's standard input (`curl -K -`, `gh secret set NAME --repo <owner>/<repo>`, `wrangler secret put`) instead. Pass keys inline (`VAR="$OTHER_VAR" command`) or through the shell's environment. Do not use `set -x`, `curl -v`, `env` or `printenv` in a shell that holds a key, and never run `wrangler tail` without a filter (`worker/README.md`, "Logs and CPU").
- Keep credential files outside the repository with mode 0600, in a directory made with `mkdir -m 700`, and create them in a subshell with `umask 077` so that nothing is ever world readable, even for a moment. The operator command line refuses a credential file that other users can read.
- The scripts print names, counts and URLs, never a value. If you add a script, keep that rule.
- Rotate the admin token after anyone who held it leaves, after a leak, and from time to time. The procedure is in [fork/TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#rotating-the-admin-token).
- Use the GitHub environment `release` (only `main` may deploy to it) for signing secrets, as `native/README.md` describes, if your plan allows environment secrets.

## Where to go next

- [fork/TIER1_PAGES.md](fork/TIER1_PAGES.md): publish the talk bundles on GitHub Pages.
- [fork/TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md): deploy the free Worker backend.
- [fork/TIER3_GCP_ELASTIC.md](fork/TIER3_GCP_ELASTIC.md): deploy the paid Cloud Run and Elasticsearch backend.
- [fork/APPS.md](fork/APPS.md): build the Android and iOS apps against your backend.
- [ADMIN_CLI.md](ADMIN_CLI.md): the operator command line.
