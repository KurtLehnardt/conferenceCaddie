# Building the public talk bundles

`node scripts/build-bundles.mjs` turns the committed conference data under `data/` into the talk bundles of the GitHub Pages demo (tier 1). The format is defined in [contracts/talk-bundle.md](contracts/talk-bundle.md); this page describes the script. It needs no Elasticsearch and calls no live service. The only network access it ever makes is the one-time download of the embedding model, and `--offline` forbids even that.

## How the Pages workflow calls it

```
npm ci
npm run build                              # the web app, into dist-pages/ with base /conferenceCaddie/
node scripts/build-bundles.mjs             # adds bundles/, conferences.json and capabilities.json to dist-pages/
```

Cache the directory named by `TRANSFORMERS_CACHE` between runs (default `.cache/transformers`), keyed on the model revision in `scripts/lib/embedder.mjs`. With a warm cache, run with `--offline` so that a missing model fails the build instead of silently downloading it. A cold download is about 133 MB.

## Flags

| Flag | Meaning |
|---|---|
| `--out <dir>` | Output directory. Default `dist-pages`. |
| `--only <slug,...>` | Build only these conferences. The index then lists only them. An unknown or unavailable slug is an error. |
| `--base-url <url>` | The `talks.bundle_base` written to `capabilities.json`. An https URL ending in `/`. Default `https://kurtlehnardt.github.io/conferenceCaddie/bundles/`. |
| `--offline` | Never use the network. Fails when the model is not in the cache. |
| `--check` | Rebuild in memory and compare with the files already under `--out`. Prints every difference and exits 1 if there is one. `conferences.json` is compared without `generated_at`. |
| `--smoke` | After building, embed the five a-check queries of `scripts/smoke.mjs` and print where the expected KubeCon talk ranks. Informational only. |
| `--publisher-name`, `--takedown` | Override the publisher name and the takedown contact (an https URL or a `mailto:` address). |

`SOURCE_DATE_EPOCH` fixes `generated_at`. Exit codes: 0 success, 1 build, verification or `--check` failure, 2 bad arguments.

## What it writes

```
dist-pages/bundles/{slug}/{content_hash[0:16]}/bundle.json
dist-pages/bundles/{slug}/{content_hash[0:16]}/vectors.i8
dist-pages/bundles/conferences.json     the index at {bundle_base}conferences.json, as the contract places it
dist-pages/conferences.json             a byte-identical copy at the site root
dist-pages/capabilities.json            tier 1: people disabled, no Bluetooth, no push, server_search false
```

Only conferences whose `data/{slug}/conference.json` says `searchable` are built, and they are the only ones in the index. The index carries the publisher name and takedown contact, and each bundle carries the Linux Foundation's CC BY 3.0 attribution with the same takedown contact. The default contact is the repository's issue tracker, `https://github.com/KurtLehnardt/conferenceCaddie/issues`; change it with `--takedown` if the maintainer wants a mailbox.

## How a bundle is made

1. The talks of `data/{slug}/talks.ndjson` are trimmed to the contract's talk fields. Speakers become names and one-line taglines; `speaker_profiles` (bios, photos, links) is dropped.
2. The topics are computed from the talk titles by `scripts/lib/topics.mjs`, a Node port of `scripts/topics.mjs` that replaces the Elasticsearch analyzer with a tokenizer written in JavaScript. Its output equals the snapshot of the live lists in `contracts/fixtures/topics-live/` for all four conferences, and a test keeps it that way.
3. Every talk and ambient item is embedded as `title + "\n" + abstract` with no instruction.
4. `buildBundle` from `contracts/js/bundle.mjs` quantises the vectors, computes the related talks and facets, and writes the canonical JSON. `verifyBundle` and the JSON Schemas then check every file before anything is written.

## The model

| | |
|---|---|
| Model | `BAAI/bge-small-en-v1.5`, 384 dimensions |
| Weights run | `Xenova/bge-small-en-v1.5`, revision `ea104dacec62c0de699686887e3f920caeb4f3e3`, `onnx/model.onnx` in fp32 |
| Pooling | CLS, then L2 normalisation |
| Input | Truncated to 512 tokens; documents without an instruction, queries with `Represent this sentence for searching relevant passages: ` |

The Xenova repository is a third-party export, so it was checked against the official one on 2026-11-10. Its `onnx/model.onnx` has the same size (133,093,490 bytes) and the same SHA-256 (`828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35`) as `onnx/model.onnx` in the official `BAAI/bge-small-en-v1.5` repository, so the weights are the official ones. Its `tokenizer.json`, `vocab.txt`, `special_tokens_map.json` and `tokenizer_config.json` are byte-identical to the official files. The pooling is the official `1_Pooling/config.json` (CLS token only).

## Determinism

Building the same data twice gives the same bytes, and so the same content hash and directory. Two things could break that, and both are closed off:

- **Thread count.** onnxruntime may split a matrix product differently with a different number of threads, which changes the order of float additions. The embedder runs with one intra-op and one inter-op thread.
- **Batch shape.** Padding a text to the length of the longest text in its batch is masked out of the attention but changes the shape of the products, so the last bits can differ with the batch that a text happens to share. Texts are therefore embedded one at a time, and a vector depends only on its own text.

Measured on 2026-11-10 on the maintainer's Mac: a multi-threaded batch-1 run and two single-threaded runs produced identical `bundle.json` and `vectors.i8` bytes for all four conferences. The cost of one thread is time: about 80 seconds for all four bundles, against about 20 seconds with all cores. `--check` is the guard, and the workflow may run it after a build.

Nothing in a bundle is a timestamp. Only `conferences.json` has one, `generated_at`.

## Quality smoke

`--smoke` ranks the KubeCon talks by cosine similarity between the int8 rows and a float query vector (with the instruction) for the five a-check queries of `scripts/smoke.mjs`. The result is informational and does not fail the build; the numbers of the last run are in the pull request that added this script.

## Tests

`test/build-bundles.test.mjs` needs no network and no model. It runs the builder on `contracts/fixtures/bundle-inputs/` with an embedder stub and requires the committed fixture bundle and index byte for byte, and it covers the flags, speaker trimming, the capabilities document, the topics port and a whole write, check and tamper run on a temporary data directory.
