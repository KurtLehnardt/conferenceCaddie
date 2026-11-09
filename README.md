# Conference Caddie

A mobile-first web app that helps KubeCon + CloudNativeCon North America 2026 attendees find the right talks with Elasticsearch hybrid search and build a clash-free agenda. Choose between Elasticsearch lexical and semantic search ranked together with reciprocal rank fusion, filter by track, level, time and more, save talks to your device, and automatically detect conflicts when building your schedule.

## How it works

- A committed snapshot of the public Sessionize schedule feed, fetched once and never called at runtime
- Elasticsearch lexical plus semantic_text search fused with reciprocal rank fusion (RRF) for relevant results
- One Node.js service running on Cloud Run that serves the app from `/` and the search API from `/api/search`

For complete build and API specifications, see [docs/CONTRACT.md](docs/CONTRACT.md).
