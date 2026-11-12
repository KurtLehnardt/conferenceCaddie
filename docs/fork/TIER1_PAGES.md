# Tier 1: publish the talk bundles on GitHub Pages

Tier 1 is a static site on GitHub Pages that holds the public talk data: one content-hashed bundle per conference, an index called `conferences.json`, a `capabilities.json` that tells the apps this is a tier 1 backend, and a small landing page. It has no server, no people features and no cost. Every other tier builds on it, because the native apps and the Worker read the talk bundles from here.

This guide needs a GitHub account and a fork of the repository. It costs nothing when the fork is public. GitHub Pages from a private repository needs a paid GitHub plan, and a private fork has a monthly Actions allowance of about 2,000 Linux minutes (see [FORK.md](../FORK.md#what-each-thing-costs)). The bundle build downloads an embedding model of about 133 MB once and caches it between runs (`docs/BUNDLES.md`).

The web app itself is not served from GitHub Pages. The github.io origin is shared with your other Pages sites, which could read the app's device secrets from local storage there, so the app is served by the Cloudflare Worker of tier 2 (`DECISIONS.md`, entry of 2026-11-10). On tier 1 the landing page says that the app is not live yet until you set `CADDIE_APP_URL`.

## Order of steps

1. Fork the repository and enable its workflows.
2. Enable GitHub Pages with the source "GitHub Actions".
3. Set the repository variables.
4. Run the Pages workflow and check the result.
5. Add or retire conferences.

## 1. Fork and enable Actions

Fork the repository with the Fork button on GitHub, or with the GitHub CLI, then clone your fork:

```sh
gh repo fork <upstream-owner>/conferenceCaddie --clone
cd conferenceCaddie
gh repo set-default <owner>/conferenceCaddie       # your fork, not the original
```

The `set-default` line matters: after `gh repo fork --clone`, the GitHub CLI's default repository can still be the original project, and a GitHub CLI command that sets a variable or secret or starts or lists a workflow run, with no repository named, would then act on the wrong repository. Every `gh` command in these guides also carries an explicit `--repo <owner>/<repo>`, and the operator command line (`caddie-admin conferences add` on tier 2) uses the default repository, so set it once here. `<owner>` is your GitHub account; the guides use your name in lower case when they build an address from it (`https://<owner, lowercased>.github.io/...`).

If you want a private copy rather than a public fork, read [FORK.md](../FORK.md#private-copies-and-actions-minutes) first: a fork of a public repository cannot be made private, Pages on a private repository needs a paid plan, and there are Actions-minute and environment-secret limits.

### Tokens for the GitHub CLI

`gh auth login` gives the CLI your whole account's reach. For a fork you can instead use a fine-grained personal access token limited to your fork only, with the repository permissions Actions (read and write), Secrets (read and write), Variables (read and write), Pages (read and write), Administration (read and write, only for creating environments in [APPS.md](APPS.md)) and Contents (read); check GitHub's current list of fine-grained permissions for the exact names. Pass it in the shell as `GH_TOKEN`, which `gh` reads in preference to a stored login, and unset it afterwards:

```sh
read -rs GH_TOKEN && export GH_TOKEN     # paste the token; it is not echoed and not written to your shell history
```

GitHub switches workflows off in a new fork. Open the Actions tab of your fork and choose to enable them. The workflows are pinned to commit hashes, and Dependabot proposes updates (`.github/dependabot.yml`).

## 2. Enable Pages with the Actions source

Pages must be enabled once, with the build type "workflow". In the repository settings, open Pages and set the source to GitHub Actions, or run:

```sh
gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow \
  || gh api -X PUT repos/<owner>/<repo>/pages -f build_type=workflow   # on HTTP 409
```

Use your own account name and repository name for `<owner>` and `<repo>`. The second command updates a site that already exists.

## 3. Set the repository variables

The workflow `.github/workflows/pages.yml` works out its addresses from the repository it runs in. A normal project site lives at `https://<owner, lowercased>.github.io/<repository>/`, and the bundles are under `bundles/` there. You therefore need no variable for the common case. The variables are public addresses, not secrets. Set them under Settings, Secrets and variables, Actions, Variables, or with the GitHub CLI:

| Variable | When to set it | Meaning |
|---|---|---|
| `CADDIE_APP_URL` | After tier 2 is deployed | The address of the web app (the Worker's https address). The landing page links to it. While it is empty the landing page says the app is not live yet. |
| `CADDIE_SITE_URL` | Only for a user site or a custom domain | The Pages site address, https, ending in `/`. A repository named `<owner>.github.io` lives at the root, so set this to `https://<owner>.github.io/`. |
| `CADDIE_BUNDLE_BASE` | Only if the bundles are served from somewhere else | Where the talk bundles are served, https, ending in `/`. The default is the site address plus `bundles/`. |
| `CADDIE_TAKEDOWN_URL` | Recommended | Where a takedown request goes: an https address or a `mailto:` address. It is published inside every bundle. The default is your repository's issues page. |

```sh
gh variable set CADDIE_TAKEDOWN_URL --repo <owner>/<repo> --body "mailto:<an address you read>"
gh variable set CADDIE_APP_URL --repo <owner>/<repo> --body "<your app address>"      # after tier 2
```

The workflow stops with an error if a value is not an https address ending in `/` (or, for the takedown address, an https or `mailto:` address).

## 4. Run the workflow and check the result

The workflow runs on a push to `main` that changes the conference data, the bundle builder or the workflow itself, every Monday at 11:47 UTC for a full rebuild, when the ingest workflow calls it, and when you start it by hand:

```sh
gh workflow run pages.yml --repo <owner>/<repo>
gh run list --workflow pages.yml --repo <owner>/<repo>
```

The first run builds every bundle from the committed data and downloads the embedding model, so it takes a while. The workflow compares each build with the live site; on the very first deploy the live site does not exist yet, and a 404 there is fine. When the run has succeeded, check the site (replace the address with your bundle base):

```sh
curl -s "<bundle base>conferences.json" | head -c 400
curl -s "<site address>capabilities.json" | head -c 400
```

`conferences.json` lists every conference with its bundle path and content hash. `capabilities.json` is the tier 1 capabilities document. The site holds only public talk data and a landing page; `pages.yml` verifies that the page set contains nothing else and that the landing page has no script.

## 5. Add or retire conferences

On tier 1 the committed `data/` folder is the source of the bundles. There is no server to push to, so the conference data is fetched on your machine and committed:

```sh
node scripts/ingest.mjs --list                                   # upcoming Linux Foundation events and their platform
node scripts/ingest.mjs --event <slug> --dry-run --skip-topics   # fetch and write data/<slug>/ and data/raw/<slug>/, index nothing
git add data && git commit -m "Add <slug>" && git push
```

`--dry-run` fetches, builds and writes the files and indexes nothing, so it needs no Elasticsearch and no key. The ingest reads public pages, and it identifies itself with the `User-Agent` in `CADDIE_USER_AGENT`; set it to a string with your own contact (for example `my-caddie-ingest (+mailto:you@example.org)`), because the default names no one. A push that changes `data/` starts the Pages workflow. Only conferences whose `data/<slug>/conference.json` says `searchable` are published.

To retire a conference, do not delete its folder; a live bundle with no data is kept on purpose. Commit a `data/<slug>/conference.json` that says `"status": "unavailable"`, a `status_reason` other than `fetch_failed`, and a `raw_fetched_at` of the current time. The next build leaves it out of the index, and the carry-forward step keeps its bundle directory for one more day (`docs/BUNDLES.md`, "Which build publishes a conference"). On tiers 2 and 3 the operator command line does this for you: `caddie-admin conferences hide` and `conferences remove` rewrite that file and the operator file `data/conference-operator.json`, and print what to commit. See [ADMIN_CLI.md](../ADMIN_CLI.md#conferences).

If you want the tier 1 site and the tier 2 Worker to agree, keep the repository variable `CADDIE_BUNDLE_BASE` (or the address `pages.yml` derives) and the Worker's `TALKS_BUNDLE_BASE` set to the same bundle base.

### The data is not yours: takedowns

The schedules in `data/` are snapshots of public conference schedules, copyright their owners, and the licence of this repository does not cover them ([`NOTICE`](../../NOTICE)). When you republish them from your own Pages site you become a publisher of that data, and you are the one who receives takedown requests. [`DATA_NOTES.md`](../../DATA_NOTES.md) describes where the data comes from. Keep `CADDIE_TAKEDOWN_URL` pointing at an address you read, and honour requests by following [BUNDLES.md](../BUNDLES.md) (the takedown file `data/takedowns.json` and removing the content from `data/`).

## Where the native apps look

A native app that is pointed at a tier 1 site (Settings, then Server, or a `caddie://connect?url=` link) reads `capabilities.json` and the bundles from that site. The apps also compile in a fallback address for the talk features when their default backend cannot be reached; a fork changes it as [APPS.md](APPS.md#point-the-apps-at-your-backend) describes.

## Next

Run the free backend: [TIER2_CLOUDFLARE.md](TIER2_CLOUDFLARE.md). Or the paid one: [TIER3_GCP_ELASTIC.md](TIER3_GCP_ELASTIC.md).
