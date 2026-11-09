# Conference Caddie

A mobile-first web app for attendees of Linux Foundation conferences whose schedules are on Sessionize. It answers two questions: **who here should I talk to?** and **which talks would I like?** It is not a scheduling tool; each talk links to the conference's official schedule with "Add to my schedule on the official site".

Live: https://conference-caddie-265846417372.us-west1.run.app

## What it does

- **People** (the home tab): build a profile on your device with topics you want to learn about and topics you can speak to, then choose to be visible at that conference. People to meet are ranked by Elasticsearch, and each match shows why and an opener from fixed templates.
- **Talk circles**: mark a talk "I'm interested", and separately choose to share your profile with others interested in that talk. Everyone sees how many people want to talk about it; only people who shared can see who else did.
- **For you**: talk suggestions from your topics and free text, with the matching topics and passage shown.
- **Search**: hybrid lexical and semantic search over one conference's talks, with filters for day, time, track and the conference's own tag groups.
- **Interested**: a plain list of the talks you marked, in time order, kept on your device.

There is no sign-in. A profile is written to Elasticsearch only when you turn on a visibility choice; a random device secret, stored only as a hash on the server, protects every edit. Profiles expire after the conference's last day, and "Delete my profile" removes them at once. The sample profiles you may see are labelled "Sample" and are not real people.

## How it works

- Conference schedules are committed snapshots of public Sessionize feeds. Nothing is fetched at runtime.
- Elasticsearch is the only data store and does all matching, ranking and filtering: lexical plus `semantic_text` retrievers fused with reciprocal rank fusion for search, people and suggestions. No generative model is used.
- Each conference's topic list is built from its talk titles at ingestion, with an Elasticsearch analyzer and aggregation.
- One Node.js service on Cloud Run serves the app and the API. It holds two scoped keys from Secret Manager: a read-only key for talks, conferences and topics, and a people key that can only read and write the people index.

For the API and index shapes, see [docs/CONTRACT.md](docs/CONTRACT.md). Design choices are recorded in [DECISIONS.md](DECISIONS.md).
