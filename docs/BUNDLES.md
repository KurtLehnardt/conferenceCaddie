# Building the public talk bundles

`node scripts/build-bundles.mjs` turns the committed conference data under `data/` into the talk bundles of the GitHub Pages demo (tier 1). The format is defined in [contracts/talk-bundle.md](contracts/talk-bundle.md); this page describes the script. It needs no Elasticsearch and calls no live service. The only network access it makes is fetching the pinned embedding model once (and, unless `--offline` or `--reuse-from none`, the currently published bundles to reuse their vectors).

## What the Pages workflow must run

The embedding library lives in its own package, `tools/bundles/`, so the root `npm ci` stays light. The builder is still one command, and it fails with the install command below if the library is missing.

```
npm ci
mkdir -p dist-pages                                                  # bundles and a landing page only; the web app is served by the Worker
npm --prefix tools/bundles ci --ignore-scripts                       # the embedding library; no install script runs
node scripts/build-bundles.mjs --takedown <contact> --publisher-name <name>   # bundles/, conferences.json, capabilities.json
```

Cache `.cache/model` (or the directory named by `CADDIE_MODEL_CACHE`, resolved against the repository root) between runs, keyed on `ONNX_REVISION` in `scripts/lib/embedder.mjs`. A cold download is about 133 MB. With a warm cache add `--no-model-download`, so that a missing or altered model file fails the build instead of being downloaded. Do not use `--offline` for the normal Pages build: it also forbids reading the published bundles for vector reuse. `--offline` is for a run that must make no network request at all.

**Run a scheduled full rebuild.** Vector reuse trusts the published bundles only as far as a sample check can see (below). A second workflow trigger, for example weekly, should run `node scripts/build-bundles.mjs --reuse-from none ...` so that every vector is recomputed from the committed data and nothing that was ever published can persist unnoticed. Use `--reuse-from none` for any build whose input you do not trust. `pages.yml` does this every Monday, and the scheduled ingest run does it for the conferences it refreshes; a bundle that a `pages.yml` run keeps from the live site (see [Which build publishes a conference](#which-build-publishes-a-conference)) is re-embedded only when a scheduled ingest fetches that conference again, which never happens once the conference has ended and dropped off the upcoming list.

Pass `--takedown` and `--publisher-name` explicitly in CI. The defaults are the repository's issue tracker (`https://github.com/KurtLehnardt/conferenceCaddie/issues`) and "Conference Caddie (Kurt Lehnardt)", which are public; the maintainer may prefer a private contact such as a `mailto:` address, and it ends up in every published bundle and in the index.

If a cached model fails verification (the build fails closed with `--no-model-download`), delete the cache entry with `gh cache delete bundle-model-<rev>`, where `<rev>` is the `ONNX_REVISION`, and run the workflow again so it downloads and verifies the model afresh.

### Why `--ignore-scripts`

`@huggingface/transformers` runs on `onnxruntime-node`, whose `postinstall` (`script/install.js`, version 1.30.0) downloads the CUDA 12 provider from nuget.org on `linux/x64` when it is not a "local install" (`install-metadata.js` lists `cuda12` as a requirement of that platform). The CPU binaries ship inside the npm package (`bin/napi-v6/linux/x64/` holds `libonnxruntime.so.1` and `onnxruntime_binding.node`), and the builder runs on the CPU only, so the download is unneeded and unverified. `npm --prefix tools/bundles ci --ignore-scripts` runs no install script at all; it was checked here to give the same bundle bytes as an install with scripts. If a tool in your pipeline cannot pass `--ignore-scripts`, set `ONNXRUNTIME_NODE_INSTALL=skip` instead: the script reads that variable (also `npm_config_onnxruntime_node_install` and the flag `--onnxruntime-node-install=skip`) and the value `skip` makes it exit before doing anything.

## Flags

| Flag | Meaning |
|---|---|
| `--out <dir>` | Output directory. Default `dist-pages`. |
| `--only <slug,...>` | Build only these conferences. The index then lists only them. An unknown or unavailable slug is an error (exit 2) before any model is loaded. |
| `--base-url <url>` | The `talks.bundle_base` written to `capabilities.json`. An https URL ending in `/`. Default `https://kurtlehnardt.github.io/conferenceCaddie/bundles/`. |
| `--no-model-download` | Fail when a pinned model file is missing from the model directory instead of downloading it. Reading published bundles for reuse is still allowed. Use it in CI with a warm model cache. |
| `--offline` | No network at all: no model download and no `--reuse-from` URL. Implies `--no-model-download`. |
| `--check` | Rebuild in memory and compare with the files already under `--out`; print every difference and exit 1 if there is one. `conferences.json` is compared without `generated_at`, and with `--only` only for the conferences rebuilt. Vector reuse is off unless `--reuse-from` is given, so `--check` tests the embedder. |
| `--reuse-from <x>` | Where to take already computed vectors from: an https bundle base URL ending in `/`, a local directory (a bundle base, or a site root that holds `bundles/`), or `none`. Default: the `--base-url` bundles this build publishes to, and off for `--check`. |
| `--live <x>` | The live site to compare with before building: an https bundle base URL ending in `/`, a local directory (a bundle base, or a site root holding `bundles/`), or `none` (the default). See [Which build publishes a conference](#which-build-publishes-a-conference). A live index that cannot be read fails the build, except a 404 (the first deploy). Not with `--only`. `pages.yml` passes the bundle base it publishes to on every run, also when `ingest.yml` calls it. |
| `--live-since <iso>` | With an https `--live`: the time the latest successful Pages deployment was created. The live `conferences.json` and `sources.json` must carry a `Last-Modified` at least that new (Pages sets it to the deploy time), or they are read again every 30 seconds for up to 15 minutes, because the CDN can serve the previous deploy's files for up to ten; then the build fails. A sidecar whose `generated_at` differs from the index's is read again the same way. `pages.yml` reads the time from the Deployments API. |
| `--fresh <slugs>` | With `--live`: comma-separated conferences that an ingest run has just fetched and pushed to the Worker. They always follow `data/` (built when searchable there, left out otherwise), whatever the live record says. `pages.yml` passes the conferences the ingest run staged. |
| `--smoke` | Embed the five a-check queries of `scripts/smoke.mjs` and print where the expected KubeCon talk ranks. Informational only. |
| `--publisher-name`, `--takedown` | The publisher named in the index and the takedown contact (an https URL or a `mailto:` address) carried by every bundle. |

`SOURCE_DATE_EPOCH` fixes `generated_at`. Exit codes: 0 success, 1 build, verification or `--check` failure, 2 bad arguments.

## What it writes

```
dist-pages/bundles/{slug}/{content_hash[0:16]}/bundle.json
dist-pages/bundles/{slug}/{content_hash[0:16]}/vectors.i8
dist-pages/bundles/conferences.json     the index at {bundle_base}conferences.json, as the contract places it
dist-pages/bundles/build-info.json      the embedding identity, read by the next build to reuse vectors
dist-pages/bundles/sources.json         per conference: the bundle's content hash and the schedule fetch it came from
dist-pages/conferences.json             a byte-identical copy at the site root
dist-pages/capabilities.json            tier 1: people disabled, no Bluetooth, no push, server_search false
```

Only conferences whose `data/{slug}/conference.json` says `searchable` are built. The index lists them, plus, with `--live`, the live bundles the build keeps.

`sources.json` is not part of the v1 contract and clients never read it. It is the builder's sidecar, because the frozen `conferences.json` and `bundle.json` formats have no place for when a bundle's schedule was fetched:

```json
{ "sources_version": 1,
  "generated_at": "<the generated_at of the conferences.json written with it>",
  "conferences": { "<slug>": { "content_hash": "<the bundle's content_hash>",
                               "raw_fetched_at": "<raw_fetched_at of data/<slug>/conference.json>",
                               "source_sha256": "<SHA-256 of the public conference entry and talks.ndjson>" } } }
```

A record counts only for the bundle whose `content_hash` it names, and not at all when its `raw_fetched_at` lies more than ten minutes after the build's clock (`FUTURE_SKEW_MS`), so a bad deploy cannot pin a bundle with a fetch time no seed or ingest will ever pass.

### Which build publishes a conference

Two workflows publish the site. The ingest run (`.github/workflows/ingest.yml`) fetches the schedules, pushes the conferences it fetched to the Worker, and then calls `pages.yml`, which checks out the current `main` and lays the conference files the ingest pushed over its `data/`; `pages.yml` also runs on its own, from the committed `data/` alone, which is only a seed. With `--live`, each conference is decided by `planBuild` in `scripts/lib/bundle-sources.mjs`. A conference named by `--fresh` (one the ingest run has just pushed) is built when `data/` has it as searchable and left out otherwise, as the Worker now does. Every other conference is decided in this order:

1. The live bundle has a source record with a later `raw_fetched_at` than `data/` (or `data/` does not have the conference): the live bundle is kept. Its two files are read, verified against the live index entry, and written to `--out` unchanged, with its index entry and source record.
2. `data/` says the latest fetch failed (`status_reason: fetch_failed`) and a live bundle exists: the live bundle is kept, as `push-ingest.mjs` keeps the Worker's searchable document.
3. `data/` has the conference as searchable: it is built.
4. Otherwise the conference is left out of the index (unavailable in `data/` with a fetch at least as new, or a live bundle with no source record and nothing in `data/`).

A kept bundle that a takedown in `data/takedowns.json` still matches is rebuilt from `data/` instead (or left out when `data/` cannot build it), so a takedown always reaches the next deploy. A site built before `sources.json` existed has no records, so every searchable conference is built from `data/`, as before.

### Retiring a conference

Deleting `data/<slug>/` no longer removes a conference from the index: a live bundle with a source record and nothing in `data/` is kept (rule 1), and a takedown for a slug with no `data/<slug>/conference.json` fails the build. To retire one, commit a `data/<slug>/conference.json` that says `"status": "unavailable"` with a `status_reason` from `docs/CONTRACT.md` other than `fetch_failed` (`no_schedule_url` fits a conference that is gone) and a `raw_fetched_at` of the current time, which is later than the live record and not in the future. The next build leaves it out of the index (rule 4), and takedowns for that slug validate again. Keep the file for as long as the slug should stay retired; an ingest that fetches the conference again replaces it with what it finds.

### Carrying bundles forward (for the workflow)

Bundle directories are immutable and content-addressed, and a client that fetched `conferences.json` a moment ago may still be downloading the directory it named. A Pages deploy replaces the whole site, so the workflow must carry forward every bundle directory that the previously live `conferences.json` references and keep it for at least one day after the index stops naming it, as the contract says. Without that, a client mid-download gets a 404 and retries, and an app that cached an older index cannot fetch its bundle. `build-bundles.mjs` itself writes only the current directories.

## What goes into a bundle

1. **Speakers.** Only names and one short title and organization line per speaker are published, never bios, photos or links. The taglines come from the index-aligned `speaker_profiles` (the contract builder's `bundleTalk` does the alignment: `talks.ndjson` leaves empty taglines out of `speaker_taglines`, so reading that list by position would credit one speaker with another's job); when nothing lines up, a profile in the wrong place is matched by name, and when nothing lines up the taglines are null rather than guessed. A tagline is cut at its first ` | ` and capped at 100 characters with an ellipsis.
2. **Email addresses** in titles, abstracts and taglines are replaced with `[email removed]`. A domain must end in a letters-only label, so package pins such as `lodash@4.17.21` or `actions/checkout@v4.1.1` are left alone. The published title and abstract are the redacted ones, so the bundle's `text_hash`, which covers `title + "\n" + abstract` as published, differs from the `text_hash` in `data/{slug}/talks.ndjson` for those talks. It is the hash of what the bundle carries and of the text that was embedded.
3. **Takedowns.** `data/takedowns.json`, an optional list of `{ slug, talk_id?, speaker?, reason, date, purged? }`, is applied before anything else is computed. An entry with only `talk_id` removes that talk; an entry with `speaker` removes that name and its tagline from the named talk, or from every talk of the conference when no `talk_id` is given. The conference's `talk_count` follows. `reason` and `date` are for the maintainers and are not published, but `data/takedowns.json` is committed to a public repository, so `reason` must not identify anyone: write "request #12", not a name or an email address. Speaker names are compared with `normalizeKey`, so case, accents and punctuation do not matter. The build fails closed: an unknown key, a date that is not a real day, a slug that is not a conference folder under `data/`, or an entry for a conference being built that matches nothing stops it, so a typo can never leave content published.

Once the content has been removed from `data/` (next paragraph), the entry would match nothing and stop every build. Mark it `"purged": true` instead of deleting it: a purged entry may match nothing, and stays as a guard that keeps the content out if a later ingest brings it back (it applies again if it matches).

**A takedown also needs the content removed from the repository.** The file only keeps the content out of the published bundles. The talk or speaker still sits in the committed `data/{slug}/talks.ndjson`, in the raw snapshots under `data/raw/`, and in git history, all public. When a request is granted, also remove it from `data/{slug}/` and from `data/raw/{slug}/`, and decide with the maintainer whether history must be rewritten.
4. **Topics** are computed from the titles by `scripts/lib/topics.mjs`, a Node port of `scripts/topics.mjs` with a JavaScript tokenizer in place of the Elasticsearch analyzer. It reproduces the snapshot of the live lists in `contracts/fixtures/topics-live/` for all four conferences (a test holds it to that). Topic ids match `^[a-z0-9][a-z0-9-]{0,99}$`; a candidate that gives no such id (for example a katakana-only term) is dropped and logged. Han and Hiragana characters are separate tokens and a Katakana run is one token, as in the Elasticsearch tokenizer.
5. **Embedding.** Every talk and ambient item is embedded as `title + "\n" + abstract` with no instruction, exactly the contract's `document_text`.
6. `buildBundle` from `contracts/js/bundle.mjs` quantises the vectors, computes the related talks and facets and writes the canonical JSON. `verifyBundle` (producer mode) and the JSON Schemas then check every file before anything is written.

The attribution of each bundle says that the Linux Foundation's event information is licensed CC BY 3.0 and that session and speaker content is copyright the speakers and organizers. The contract fixes the attribution fields but not their wording; the sentence is in `licensor`.

## The model

| | |
|---|---|
| Model | `BAAI/bge-small-en-v1.5`, 384 dimensions |
| Weights run | `Xenova/bge-small-en-v1.5`, revision `ea104dacec62c0de699686887e3f920caeb4f3e3`, `onnx/model.onnx` in fp32 |
| Settings | the contract's `MODEL` block, asserted at start: CLS pooling, L2 normalisation, 512 tokens cut at the end, documents without an instruction |

**Pinned and verified.** The builder fetches `config.json`, `tokenizer.json`, `tokenizer_config.json` and `onnx/model.onnx` only from `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/<revision>/...` into a local model directory, and checks the size and SHA-256 of each against the values pinned in `scripts/lib/embedder.mjs` before loading; a mismatch deletes the file and fails the build. The pins were cross-checked on 2026-11-10 against what Hugging Face publishes for that revision: for `onnx/model.onnx` the LFS SHA-256 (`828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35`) in the tree listing, for the three small files the git blob id. `model.onnx` is also byte-identical to `onnx/model.onnx` of the official `BAAI/bge-small-en-v1.5` repository, and the Xenova `tokenizer.json`, `vocab.txt`, `special_tokens_map.json` and `tokenizer_config.json` are byte-identical to the official files.

The library is then pointed at that directory with remote models and its own file cache switched off (`env.allowRemoteModels = false`, `env.useFSCache = false`, `local_files_only: true`). transformers.js 4.3.2 would otherwise ask `huggingface.co/.../resolve/main` for some files whatever revision or offline option is set, which bypasses the pin. A run with `fetch`, sockets and DNS blocked made zero network attempts and produced the same vector bytes as an unblocked one.

## Determinism and vector reuse

Building the same data twice gives the same bytes, and so the same content hash and directory. Two things could break that:

- **Thread count and batch shape.** onnxruntime may sum floats in a different order with a different thread count or padding, which can flip an int8 value. The embedder runs on one intra-op and one inter-op thread and embeds one text per call, so a vector depends only on its text. The cost is time.
- **A different CPU.** Even so, another CPU or another onnxruntime build could differ in the last bit of a float. So the builder reuses what was published, and does not trust it blindly. Before embedding it loads the bundles at `--reuse-from` (by default the bundle base this build publishes to) and applies these checks, in this order:
  1. `bundles/build-info.json` there must name exactly the current embedding identity (bundle version, quantisation, model, revision, the four file hashes, settings, library version).
  2. Each index entry is read with `readConferenceIndex`, its `path` must be exactly `{slug}/{content_hash[0:16]}/`, only `bundle.json` and `vectors.i8` are fetched from it, without following redirects, and no file may exceed a byte cap.
  3. The bundle must verify against its entry (sizes, SHA-256, content hash, text hashes) and state the current bundle version, quantisation, dimensions and model.
  4. A sample check: 8 rows per conference, evenly spread (all rows when there are fewer), are embedded again and must have a cosine of at least 0.999 with the published row. Hashes prove integrity, not honesty, so this is what catches rows that were swapped or poisoned with their hashes recomputed. One bad sampled row discards the whole source with a loud log line.
  5. Only then is a row used, for every talk whose text hash (the SHA-256 of the published embedding text) is unchanged.

  Only new or changed texts are embedded. Unchanged conferences therefore keep their content hash whatever runner built them. If the source cannot be read, or any check fails, everything is embedded and the log says so. The sample check cannot see a row that was altered and not sampled; that residual risk is what the scheduled `--reuse-from none` rebuild above removes.

Nothing in a bundle is a timestamp. Only `conferences.json` has one, `generated_at`. `--check` rebuilds without reuse (unless `--reuse-from` is given) and compares byte for byte, which is the guard that the embedder itself is reproducible on the machine at hand.

## Quality smoke

`--smoke` ranks the KubeCon talks by cosine similarity between the int8 rows and a float query vector (with the instruction) for the five a-check queries of `scripts/smoke.mjs`. It does not fail the build; the numbers of the last run are in the pull request that added or changed this script.

## Tests

`test/build-bundles.test.mjs` needs no network, no model and no `tools/bundles` install. It runs the builder on `contracts/fixtures/bundle-inputs/` with an embedder stub and requires the committed fixture bundle and index byte for byte, and it covers the flags and exit codes, speaker alignment on the real data (including talk 1289969), email redaction, takedowns, vector reuse, the topics port and its aliases, id pattern and Japanese titles, the embedder's pinned constants against the contract, and a whole write, check and tamper run on a temporary data directory.

`scripts/test/bundle-publish.test.mjs` (also run by `npm test`) covers the publishing rule the same way: `planBuild` case by case, including future-dated records and `--fresh`, the `sources.json` round trip, takedowns against a kept bundle, a whole ingest build followed by a build from the older seed that keeps the ingest's bundle, a failed fetch and an unavailable conference, `--live` over https (a 404, a failure, a site without `sources.json`), `--live-since` against a CDN that still serves the previous deploy or a mix of two, an ended conference whose seed is neither pushed (`push-ingest.mjs` `selectSlugs`) nor staged while its newer live bundle stays, and `scripts/stage-ingest-data.mjs`.
