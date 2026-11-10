# Building the public talk bundles

`node scripts/build-bundles.mjs` turns the committed conference data under `data/` into the talk bundles of the GitHub Pages demo (tier 1). The format is defined in [contracts/talk-bundle.md](contracts/talk-bundle.md); this page describes the script. It needs no Elasticsearch and calls no live service. The only network access it makes is fetching the pinned embedding model once (and, unless `--offline` or `--reuse-from none`, the currently published bundles to reuse their vectors).

## What the Pages workflow must run

The embedding library lives in its own package, `tools/bundles/`, so the root `npm ci` stays light. The builder is still one command, and it fails with the install command below if the library is missing.

```
npm ci
npm run build                                                        # the web app into dist-pages/ (base /conferenceCaddie/)
ONNXRUNTIME_NODE_INSTALL=skip npm --prefix tools/bundles ci          # the embedding library, without onnxruntime's CUDA download
node scripts/build-bundles.mjs --takedown <contact> --publisher-name <name>   # bundles/, conferences.json, capabilities.json
```

Cache `.cache/model` (or the directory named by `CADDIE_MODEL_CACHE`, resolved against the repository root) between runs, keyed on `ONNX_REVISION` in `scripts/lib/embedder.mjs`. A cold download is about 133 MB. With a warm cache add `--offline` so that a missing model fails the build instead of downloading it.

Pass `--takedown` and `--publisher-name` explicitly in CI. The defaults are the repository's issue tracker (`https://github.com/KurtLehnardt/conferenceCaddie/issues`) and "Conference Caddie (Kurt Lehnardt)", which are public; the maintainer may prefer a private contact such as a `mailto:` address, and it ends up in every published bundle and in the index.

### Why `ONNXRUNTIME_NODE_INSTALL=skip`

`@huggingface/transformers` runs on `onnxruntime-node`, whose `postinstall` (`script/install.js`, version 1.30.0) downloads the CUDA 12 provider from nuget.org on `linux/x64` when it is not a "local install" (`install-metadata.js` lists `cuda12` as a requirement of that platform). The CPU binaries are bundled in the npm package, and the builder runs on the CPU only, so the download is unneeded and unverified. The script reads the variable `ONNXRUNTIME_NODE_INSTALL` (also `npm_config_onnxruntime_node_install` or the flag `--onnxruntime-node-install=skip`); the value `skip` makes it exit before doing anything. Set it for every install of `tools/bundles`.

## Flags

| Flag | Meaning |
|---|---|
| `--out <dir>` | Output directory. Default `dist-pages`. |
| `--only <slug,...>` | Build only these conferences. The index then lists only them. An unknown or unavailable slug is an error (exit 2) before any model is loaded. |
| `--base-url <url>` | The `talks.bundle_base` written to `capabilities.json`. An https URL ending in `/`. Default `https://kurtlehnardt.github.io/conferenceCaddie/bundles/`. |
| `--offline` | No network at all: no model download, no `--reuse-from` URL. Fails when a pinned model file is missing from the model directory. |
| `--check` | Rebuild in memory and compare with the files already under `--out`; print every difference and exit 1 if there is one. `conferences.json` is compared without `generated_at`, and with `--only` only for the conferences rebuilt. Vector reuse is off unless `--reuse-from` is given, so `--check` tests the embedder. |
| `--reuse-from <x>` | Where to take already computed vectors from: an https bundle base URL ending in `/`, a local directory (a bundle base, or a site root that holds `bundles/`), or `none`. Default: the published demo, and off for `--check`. |
| `--smoke` | Embed the five a-check queries of `scripts/smoke.mjs` and print where the expected KubeCon talk ranks. Informational only. |
| `--publisher-name`, `--takedown` | The publisher named in the index and the takedown contact (an https URL or a `mailto:` address) carried by every bundle. |

`SOURCE_DATE_EPOCH` fixes `generated_at`. Exit codes: 0 success, 1 build, verification or `--check` failure, 2 bad arguments.

## What it writes

```
dist-pages/bundles/{slug}/{content_hash[0:16]}/bundle.json
dist-pages/bundles/{slug}/{content_hash[0:16]}/vectors.i8
dist-pages/bundles/conferences.json     the index at {bundle_base}conferences.json, as the contract places it
dist-pages/bundles/build-info.json      the embedding identity, read by the next build to reuse vectors
dist-pages/conferences.json             a byte-identical copy at the site root
dist-pages/capabilities.json            tier 1: people disabled, no Bluetooth, no push, server_search false
```

Only conferences whose `data/{slug}/conference.json` says `searchable` are built, and they are the only ones in the index.

### Carrying bundles forward (for the workflow)

Bundle directories are immutable and content-addressed, and a client that fetched `conferences.json` a moment ago may still be downloading the directory it named. A Pages deploy replaces the whole site, so the workflow must carry forward every bundle directory that the previously live `conferences.json` references and keep it for at least one day after the index stops naming it, as the contract says. Without that, a client mid-download gets a 404 and retries, and an app that cached an older index cannot fetch its bundle. `build-bundles.mjs` itself writes only the current directories.

## What goes into a bundle

1. **Speakers.** Only names and one short title and organization line per speaker are published, never bios, photos or links. The taglines come from the index-aligned `speaker_profiles` (the contract builder's `bundleTalk` does the alignment: `talks.ndjson` leaves empty taglines out of `speaker_taglines`, so reading that list by position would credit one speaker with another's job); when nothing lines up, the taglines are null rather than guessed. A tagline is cut at its first ` | ` and capped at 100 characters with an ellipsis.
2. **Email addresses** in abstracts are replaced with `[email removed]`. The published abstract is the redacted one, so the bundle's `text_hash`, which covers `title + "\n" + abstract` as published, differs from the `text_hash` in `data/{slug}/talks.ndjson` for those talks. It is the hash of what the bundle carries and of the text that was embedded.
3. **Takedowns.** `data/takedowns.json`, an optional list of `{ slug, talk_id?, speaker?, reason, date }`, is applied before anything else is computed. An entry with only `talk_id` removes that talk; an entry with `speaker` removes that name and its tagline from the named talk, or from every talk of the conference when no `talk_id` is given. The conference's `talk_count` follows. `reason` and `date` are for the maintainers and are not published. An entry that matches nothing is logged; a malformed file fails the build.
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
- **A different CPU.** Even so, another CPU or another onnxruntime build could differ in the last bit of a float. So the builder reuses what was published: before embedding it loads the bundles at `--reuse-from` (by default the live Pages site), checks that `bundles/build-info.json` there names exactly the current embedding identity (model, revision, the four file hashes, settings, library version), verifies each bundle against its index entry, and takes the int8 row of every talk whose text hash (the SHA-256 of the published embedding text) is unchanged. Only new or changed texts are embedded. Unchanged conferences therefore keep their content hash whatever runner built them, and nothing is republished for nothing. If the source cannot be read, or the identity differs, everything is embedded and the log says so.

Nothing in a bundle is a timestamp. Only `conferences.json` has one, `generated_at`. `--check` rebuilds without reuse and compares byte for byte, which is the guard that the embedder itself is reproducible on the machine at hand.

## Quality smoke

`--smoke` ranks the KubeCon talks by cosine similarity between the int8 rows and a float query vector (with the instruction) for the five a-check queries of `scripts/smoke.mjs`. It does not fail the build; the numbers of the last run are in the pull request that added or changed this script.

## Tests

`test/build-bundles.test.mjs` needs no network, no model and no `tools/bundles` install. It runs the builder on `contracts/fixtures/bundle-inputs/` with an embedder stub and requires the committed fixture bundle and index byte for byte, and it covers the flags and exit codes, speaker alignment on the real data (including talk 1289969), email redaction, takedowns, vector reuse, the topics port and its aliases, id pattern and Japanese titles, the embedder's pinned constants against the contract, and a whole write, check and tamper run on a temporary data directory.
