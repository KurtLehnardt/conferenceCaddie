# Talk bundle v1

Every tier serves talk features from the same static, per-conference bundle, searched and ranked on the device: the schedule, keyword and semantic search, "For you", related talks, the topic picker and value matching. The bundle is built in CI from the committed raw data, so it needs no Elasticsearch. Schemas: `contracts/schema/talk-bundle.v1.schema.json` (`bundle.json`) and `contracts/schema/conferences-index.v1.schema.json` (`conferences.json`). Reference implementation: `contracts/js/bundle.mjs` and `contracts/js/canonical-json.mjs`. Fixture: `contracts/fixtures/bundle/`, built from `contracts/fixtures/bundle-inputs/` by `contracts/js/fixtures.mjs`.

## Files and layout

All paths are relative to `talks.bundle_base` from the capabilities document ([capabilities.md](capabilities.md)), which ends in `/`.

```
{bundle_base}conferences.json                         the index; the only file that changes in place
{bundle_base}{slug}/{content_hash[0:16]}/bundle.json  talks, topics, facets, model, vector layout, related talks
{bundle_base}{slug}/{content_hash[0:16]}/vectors.i8   the int8 talk vectors
```

A bundle directory is content-addressed: its name is the first 16 hex digits of the bundle's content hash, and its files never change once published. A new build of a conference gets a new directory, and `conferences.json` is updated to point at it. The publisher keeps the previous directory for at least a day so that clients mid-download can finish.

**Why a binary vector file.** The vectors are the bulk of a bundle (KubeCon: 560 talk and ambient items × 384 bytes ≈ 215 KB as int8, against about 290 KB as base64 inside JSON and about 860 KB as float32). A raw int8 file needs no decoding: a phone can memory-map it or read it into one byte array and score a query with integer arithmetic, and its integrity is one SHA-256 over the bytes. JSON would also make the parser hold the whole string before decoding it.

## `conferences.json`

```json
{
  "index_version": 1,
  "generated_at": "2026-11-10T00:00:00Z",
  "publisher": { "name": "Caddie fixture publisher", "takedown": "https://example.org/caddie-fixture/takedown" },
  "conferences": [
    { "slug": "caddie-fixture-2099", "name": "Caddie Fixture Conference", "start_date": "2099-03-02", "...": "...",
      "bundle": {
        "bundle_version": 1,
        "content_hash": "af85300cea6e89c95f44e71c5a2c5302ccd6cda0cdf35586e1c03cf8bc2f0cf9",
        "path": "caddie-fixture-2099/af85300cea6e89c9/",
        "model": "BAAI/bge-small-en-v1.5", "dims": 384, "talk_count": 3, "vector_count": 3,
        "files": { "bundle.json": { "bytes": 5655, "sha256": "2d779cce..." },
                   "vectors.i8":  { "bytes": 1152, "sha256": "e9a59e11..." } } } },
    { "slug": "caddie-unavailable-2099", "status": "unavailable", "...": "...", "bundle": null }
  ]
}
```

- `publisher` names who publishes the bundles and where to ask for content to be taken down (an https URL or a `mailto:` address). The apps show it with the attribution.
- Each entry has exactly the fields of a `GET /api/conferences` entry (`slug`, `name`, `start_date`, `end_date`, `time_zone`, `location`, `status`, `official_schedule_url`, `source`, `has_level`, `track_group`, `tag_groups`, `talk_count`) plus `bundle`. The file is therefore a superset of the `GET /api/conferences` response `{ conferences: [...] }`, and one parser reads both.
- `bundle` is null for an `unavailable` conference, and for a searchable one whose bundle has not been built yet.
- Entries are sorted by `start_date`, then `name`, as the API sorts them.

## `bundle.json`

The file is canonical JSON (below), so its keys appear in sorted order; they are listed here by meaning.

| Field | Content |
|---|---|
| `bundle_version` | `1`. |
| `conference` | The conference's `GET /api/conferences` entry. |
| `attribution` | `{ licensor, license, license_url, source_url, changes, takedown }` (below). |
| `model` | The embedding conventions (below): `{ id, onnx, dims, pooling, normalize, max_tokens, truncation, document_instruction, document_text, query_instruction }`. |
| `vectors` | `{ file: "vectors.i8", dtype: "int8", dims: 384, count, quantization: "int8-symmetric-row-maxabs", rows: [talk_id, ...] }`. |
| `talks` | Every schedule item of every kind, sorted by the instant `start` names, then `talk_id`. |
| `topics` | The conference topics (at most 150), sorted by `rank`: `{ topic_id, label, talk_count, rank, aliases }`. |
| `facets` | The value-matching names: `{ kind, value, label, group, keys, words, talks }` for each track, room, speaker and tag of the `kind: talk` items, sorted by kind (track, room, speaker, tag), then `value`, then `group`. Same rules as `scripts/build-facets.mjs` and `normalizeKey` in `server/facets.mjs`. |
| `related` | `{ talk_id: [talk_id, ...] }`: for every `kind: talk` item with a vector, up to 5 other `kind: talk` items, most similar first. |

**A talk** has `talk_id, kind, title, abstract, speakers, speaker_taglines, room, track, level, tags, sponsor, has_slides, slides_url, url, start, end, day, start_minutes, end_minutes, topics, text_hash`, with the meanings of `docs/CONTRACT.md` (Talks). `topics` holds `topic_id`s, whose labels are in `topics`. `text_hash` is `sha256(title + "\n" + abstract)` in hex, the same value as in `data/{slug}/talks.ndjson`. Left out on purpose: `session_id` (never exposed), `conference` (it is the part of `talk_id` before the colon), `tag_keys` (derived from `tags`), `content_hash`, `ingested_at` and `speaker_profiles`. Speaker data in a public bundle is trimmed to each speaker's name (`speakers`) and one-line tagline (`speaker_taglines`, normally their title and organisation, parallel to `speakers` with null for a speaker who gave none; `talks.ndjson` leaves empty taglines out, so the builder takes them from the index-aligned `speaker_profiles`), with no bios, photos or social links (`DECISIONS.md`, Native apps plan and Apache-2.0 license); `verifyBundle()` refuses a bundle whose talks carry `speaker_profiles`. Breaks and housekeeping items are included because the device needs them: lunch windows for the "before lunch" and "after lunch" time phrases come from the conference's own break items, as in `server/phrases.mjs`.

**There are no timestamps in a bundle**, so building the same inputs twice gives the same bytes and the same hash, and an unchanged conference is never republished. `generated_at` lives in `conferences.json`.

## Attribution

Linux Foundation schedule content is licensed CC BY 3.0, so every bundle carries what that licence needs, and the apps show it on the conference's About screen and with any shared or exported talk:

| Field | Content |
|---|---|
| `licensor` | Who licenses the content, for Linux Foundation events "The Linux Foundation". |
| `license`, `license_url` | `CC BY 3.0`, `https://creativecommons.org/licenses/by/3.0/`. |
| `source_url` | The conference's `official_schedule_url`. |
| `changes` | What was changed, for example "Reformatted; speaker data trimmed to names and taglines; talk text embedded for search." |
| `takedown` | The publisher's takedown contact, the same as `publisher.takedown` in `conferences.json`. |

Embedding the text for search is allowed; training a model on it is not (the Linux Foundation's `robots.txt` says `ai-train=no`), and nothing in a bundle is meant for training.

## Embedding conventions

The vectors in a bundle are only useful if every query is embedded the same way, and three different runtimes embed: the bundle builder in CI (transformers.js), the phones (ONNX Runtime) and, on tier 2, a Worker (Workers AI). They all follow the `model` block, which is the same in every v1 bundle:

| Field | Value | Meaning |
|---|---|---|
| `id` | `BAAI/bge-small-en-v1.5` | The model. 384 dimensions, English. |
| `onnx` | `Xenova/bge-small-en-v1.5` | The ONNX export the builder and the phones load, so they run the same weights. Workers AI runs the same model as `@cf/baai/bge-small-en-v1.5`. |
| `dims` | `384` | |
| `pooling` | `cls` | The last hidden state of the first token (`[CLS]`) is the embedding, as the model card says. Not mean pooling. Workers AI must be called with `pooling: "cls"`; its default is mean pooling. |
| `normalize` | `true` | Every vector is L2-normalised before it is quantised, compared or stored. An embedder that may already normalise normalises again (it is idempotent). |
| `max_tokens` | `512` | The model's limit, counted in its WordPiece tokens including `[CLS]` and `[SEP]`. |
| `truncation` | `end` | Longer input is cut at the end after tokenisation, keeping the first 512 tokens. |
| `document_instruction` | `""` | Talk text is embedded with no instruction. |
| `document_text` | `title + "
" + abstract` | A talk's input string: its title, one line feed, its abstract (empty when the feed has none), exactly the string `text_hash` covers. |
| `query_instruction` | `Represent this sentence for searching relevant passages: ` | A search query's input string is this instruction, verbatim from the model card (with its trailing space), followed by the query as the person typed it after time phrases were taken out. |

The talk text is title and abstract only. Today's tier 3 server copies the title and the abstract into its `semantic_text` field as two values, so Elasticsearch embeds them as separate chunks (`DECISIONS.md`, Search: "The title reaches the semantic field as its own chunk"); a bundle has one vector per talk over both, so its ranking is close to tier 3's but not identical. Topics are not added, because they are words of the title already.

`contracts/fixtures/embedding/reference.v1.json` holds reference embeddings under these conventions: the three fixture talks and two queries, each as the exact input string and its fp32 vector, the query-by-talk cosines from fp32 and from the int8-quantised ONNX export, and the Workers AI request body. An embedder conforms when every cosine it computes is within 0.02 of the fp32 value and the best talk for each query is the same. The bundle's int8 rows stay within that tolerance too (the test checks it).

## Vectors

- **Rows.** One row per `kind: talk` and `kind: ambient` item, in `talks` order; `vectors.rows` lists their `talk_id`s, and `vectors.count` equals its length. Breaks and housekeeping have no row.
- **File format.** `vectors.i8` is `count × 384` signed bytes, row-major: component `j` of row `i` is the byte at offset `i × 384 + j`, read as two's-complement int8. One byte per component means there is no byte order to get wrong. The file is exactly `count × 384` bytes.
- **Quantisation.** Each row is quantised on its own: `scale = 127 / max_j |v_j|`, `q_j = round_half_away_from_zero(v_j × scale)`, clamped to [-127, 127]. The value -128 never appears (a verifier refuses a file that holds it), and an all-zero vector stays all zeros. The scale is not stored, because nothing needs it.
- **Similarity.** Cosine over the int8 values, computed as `dot(a, b) / (sqrt(dot(a, a)) * sqrt(dot(b, b)))` in IEEE 754 double precision, where each `dot` of two int8 rows is an exact integer sum (it stays below 384 × 127 × 127 = 6,193,536, inside 32 bits) converted to a double, and the similarity is 0 when either vector is all zeros. A float query vector is compared with an int8 row by the same expression; cosine does not depend on either scale, so the query needs no quantisation. Row norms can be computed once at load. Brute force over every row is the intended search: KubeCon is about 215,000 multiply-adds per query.
- **Model compatibility.** `model.id` in the index entry and in the bundle names the model the vectors came from. An app compares its query vectors only with a bundle whose `model.id` and `dims` match the model it runs; otherwise it uses keyword search alone for that conference. A different model is a different `model.id`, never a silent swap.

## Related talks

For every `kind: talk` item with a row, the other `kind: talk` items with a row, ordered by the similarity above (int8 rows against int8 rows) from highest to lowest, ties broken by `talk_id` in ascending code-unit order, the first 5 kept. There is no similarity threshold. Ambient items are neither given nor used as related talks.

The bundle builder computes the lists and checks them again before publishing (`verifyBundle(entry, files, { producer: true })`); clients use them as published and do not recompute them, so a difference in the last bit of another platform's floating point can never make a good bundle fail. Parity with tier 3's `GET /api/related` is not promised: that route runs a kNN query on Elasticsearch's own embeddings of title and abstract chunks with a different model.

## Canonical JSON

`bundle.json` is the JSON Canonicalization Scheme (RFC 8785) restricted to strings, booleans, null, arrays, objects and safe integers: object keys sorted by UTF-16 code units, no whitespace, strings escaped as `JSON.stringify` escapes them, UTF-8 encoded. A bundle holds no non-integer numbers, because the shortest form of a binary float is the one part of RFC 8785 that differs between libraries. `canonicalJson()` refuses a float. Strings are not Unicode-normalised, by the builder or by RFC 8785: they keep the code points of the feed, so `text_hash` and the embedding input are computed over exactly the text a client shows.

## Content hash

```
content_hash = sha256_hex( "caddie-bundle-v1\n"
                           + for each file, in code-unit order of its name:
                               name + "\t" + sha256_hex(file bytes) + "\t" + byte length + "\n" )
```

ASCII, decimal byte lengths, lower-case hex. A v1 bundle has exactly two files, `bundle.json` and `vectors.i8`; the index entry lists exactly those two (the schema refuses any other name), and clients download those two and nothing else. The hash changes exactly when a file changes, and its first 16 hex digits name the bundle's directory.

## Download, verification and caching

1. Fetch `conferences.json` at app start and at most every 15 minutes while the app is in the foreground, with `If-None-Match` when the host gave an `ETag`.
2. For each conference the user follows, compare the entry's `content_hash` with the bundle stored on the device. Equal means nothing to do. A `bundle_version` the app does not implement means it keeps the bundle it has and shows that the app needs an update for that conference.
3. Otherwise download the files under `path`. They are immutable, so any cache may keep them forever.
4. Verify before use, as `verifyBundle()` does: an entry with a well-formed content hash that lists exactly the two files, each file's size and SHA-256 against the entry, the content hash over the listing, the path ending in the hash's first 16 digits, `bundle.json` parsing and being canonical, `vectors.i8` being `count × dims` bytes without -128, the rows being the talk and ambient items in `talks` order, every `topics` reference existing, every `text_hash` matching, `speakers` and `speaker_taglines` of the same length, the attribution naming the conference's schedule as its source, and no talk carrying speaker profiles. A malformed entry is a problem in the list, never an exception. The JSON Schema covers the shapes. The related-list recomputation is a producer check only (Related talks).
5. Swap the new bundle in atomically and delete the old one only after the swap. A bundle that fails verification is discarded and the download is retried later; the old bundle stays in use. A device with a verified bundle works offline indefinitely.
6. **Links.** `url`, `slides_url`, `official_schedule_url`, `source_url` and `license_url` are http(s) links (the schemas require the scheme, in any letter case, since the feed writes `Https://` at times), and clients open only http(s) links, whatever a bundle holds.

## Fixture

`contracts/fixtures/bundle/` holds a two-conference index and one bundle, `caddie-fixture-2099`, built from `contracts/fixtures/bundle-inputs/`: three talks and a lunch break. The source vectors are unit vectors chosen so everything can be checked by hand:

| Talk | Source vector (all other components 0) | int8 row |
|---|---|---|
| `1001` Securing MCP servers in production | `v0 = 1` | `q0 = 127` |
| `1002` Kubernetes for beginners | `v1 = 1` | `q1 = 127` |
| `1003` Energy-aware Kubernetes scheduling | `v0 = 0.6, v1 = -0.8` | `q0 = 95` (0.6 × 127 / 0.8 = 95.25), `q1 = -127` |

Cosines: 1001–1002 = 0, 1001–1003 = 95 / √(95² + 127²) = 0.5990, 1002–1003 = -0.8008. Related talks: 1001 → [1003, 1002], 1002 → [1001, 1003], 1003 → [1001, 1002]. In `vectors.i8`, byte 0 is `0x7f`, byte 385 is `0x7f`, and bytes 768 and 769 are `0x5f` and `0x81`. The lunch break has no row. The test rebuilds the fixture from its inputs and compares bytes, so the committed files are always the reference builder's output.

## Building bundles (Phase 1)

The GitHub Action runs `node scripts/ingest.mjs --no-fetch --dry-run` (or a fetch when the terms allow it), the Node port of the topics builder (diffed against `contracts/fixtures/topics-live/` first), embeds every talk and ambient item with transformers.js, then calls `buildBundle({ conference, talks, topics, vectors })` and `verifyBundle()` and validates the output against both schemas before publishing to Pages.
