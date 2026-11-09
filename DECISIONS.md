# Decisions

This file records decisions that depart from, or add detail to, `docs/CONTRACT.md`.

## Search integration (2026-11-09)

- **Index.** The real index is `caddie-talks-v1` behind the alias `caddie-talks`. It holds all 600 feed items: 484 talks, 76 ambient items, 21 breaks and 19 housekeeping items, which matches `DATA_NOTES.md`. Every search filters on `kind: talk`.
- **Embedding model.** The `semantic_text` field has no explicit `inference_id`, so it uses the cluster default, `.jina-embeddings-v5-text-small`. No chat, completion or rerank endpoint is used.
- **Semantic retriever.** The contract asks for a `semantic` query. The server instead runs a `knn` query on the `semantic_text` field with `k` 50 and `num_candidates` 200, and Elasticsearch builds the query vector from the field's own inference endpoint. A `semantic` query on a dense field sizes its neighbour set from the request size, so `total` would change when `size` changed; a fixed `k` avoids that. This is still hybrid search with the same model, combined with the lexical query by an `rrf` retriever (`rank_window_size` 50, default `rank_constant`).
- **kNN pre-filter.** The knn query is pre-filtered only by the base filters: talks only, the start-time window, sponsor hiding and saved-talk conflicts. Day, track, level and slides selections are applied afterwards by the `rrf` retriever's filter. This keeps the nearest-neighbour set the same whatever the user selects, so the count shown next to a facet value is exactly the total the user gets after selecting it.
- **Lexical matching.** The `multi_match` uses `minimum_should_match: "2<60%"`. Queries of one or two terms must match every term, and longer queries must match 60% of them. Without this, a long natural-language query such as "making my cluster greener and using less energy" matched hundreds of talks on a single common word, and that noise pushed the right talk (the Kepler lightning talk) down to rank 18. With it, the Kepler talk ranks first and no tested query got worse.
- **Facets and total.** Let M be the documents the main query matches: for a text query, the lexical matches plus the 50 nearest neighbours among documents that pass the base filters; in browse mode, every talk. Let B be the base filters and S(g) the selection in facet group g (day, track, level, has_slides). Then `total` = |M ∩ B ∩ every S(g)|, and the counts for group g are a terms aggregation over M ∩ B ∩ S(every other group). Because the start-time window is a base filter, the Morning and Afternoon totals of a text query need not add up to the unfiltered total; the time chips show no counts, so the UI shows no contradiction.
- **Evidence.** Evidence prefers a highlighted abstract fragment, then a highlighted title, then the best semantic chunk, then the start of the abstract, then the title. The title reaches the semantic field as its own chunk through `copy_to`, so a semantic chunk that only repeats the title is skipped in favour of the best abstract chunk.

## Smoke test

`scripts/smoke.mjs` uses five attendee-style queries. The first three have no useful words in common with their talk and pass only through semantic matching; lexical search alone does not return their talk at all.

| Query | Expected talk |
|---|---|
| making my cluster greener and using less energy | Monitoring Power at Planet Scale with Kepler |
| supporting autistic and ADHD colleagues on my team | Neurodivergent Minds with Wings: Engineering Independence at Work |
| a personal fitness trainer bot for marathon training | I Built an AI Running Coach: A Personal kagent Agent in Production |
| what does each LLM token cost me | Clueless About The Cost of AI Model Usage? OpenCost+llm-d = first of a kind inference cost tracking |
| how do I start contributing to the kubernetes project | Kubernetes 101: New Contributor Orientation |

Run it with `BASE_URL=http://localhost:8080 npm run smoke`. Set `SMOKE_SKIP_BUNDLE=1` when `web/dist` has not been built.
