# Conference Caddie

## Why this exists

The most valuable thing an attendee takes home is the people they met. Talks
are the shared context that starts those conversations. Every screen should
make it easier to find the right person and give the two of you something to
talk about. When a choice comes up, pick the option that leads to more good
conversations.

A mobile-first web app for attendees of any Linux Foundation conference whose schedule is on Sessionize. It answers two questions, in this order: **who here should I talk to?** and then **which talks give us something to talk about?** It is not a scheduling tool; each talk links to the conference's official schedule with "Add to my schedule on the official site".

Live: https://conference-caddie-265846417372.us-west1.run.app. The switcher at the top of the app lists every conference ingested so far, and links out to the official schedule for events that are not available here yet. Each conference has its own URL, `/e/{slug}`, for a QR code.

The app began as an entry in the Elasticsearch "Find the Right Talk" track at a hackathon during KubeCon + CloudNativeCon North America 2026. The pitch: "Find the right talk, and the right people around it." People-matching is a search problem, and the app treats it as one.

## What it does

- **People** (the home tab): build a profile on your device with topics you want to learn about and topics you can speak to, then choose to be visible at that conference. People to meet are ranked by Elasticsearch, and each match shows why and an opener from fixed templates.
- **Talk circles**: mark a talk "I'm interested", and separately choose to share your profile with others interested in that talk. Everyone sees how many people want to talk about it; only people who shared can see who else did.
- **For you**: talk suggestions from your topics and free text, with the matching topics and passage shown.
- **Search**: hybrid lexical and semantic search over one conference's talks, with filters for day, time, track and the conference's own tag groups.
- **Schedule** (Search tab, "Search | Schedule"): the whole conference, one day at a time. Day chips list the conference's days, and each day's talks come from Elasticsearch in start order, a page of 50 at a time, under sticky start-time headers. Each row shows the title, speakers, room, track and the Interested star, and opens the talk. The search filters (track, level, tags, slides, sponsor content, events and showcases) apply through the API. "Jump to now" appears only while the conference is running and scrolls to the current or next time slot. Offline, the same layout is drawn from the saved schedule and labelled "Offline".
- **My schedule** (the Interested tab): the talks you marked, kept on your device, in two views. List groups them by day in time order. Day shows one day as a timeline with an hour gutter: each talk is a card placed by its start and end, talks at the same time sit side by side, and a "now" line marks the current time today. The List or Day choice is remembered on the device. From here you can also share your profile for all of them at once, stop sharing for all, or let sharing follow the list as you mark and unmark talks. It is a view of what you marked, not a planner: nothing warns about or resolves talks at the same time.
- **Import my schedule**: in Settings (gear icon at the top right, then Import my schedule), upload or paste a schedule you exported from anywhere (PDF, CSV, plain text, calendar .ics or JSON). Elasticsearch extracts the text (PDFs through its Apache Tika attachment processor, in a simulated pipeline that indexes nothing) and finds the conference's real talks with named title, speaker and time queries. You review the matches and mark the ones you keep as Interested on your device; the sheet then offers "View my schedule", which opens My schedule's Day view on the first imported day. The file is read once and never stored.
- **Links**: views have their own addresses, such as `#/interested?view=day&day=2026-11-10` and `#/search?view=schedule&day=2026-11-11`, so Back and a reload keep the view.

- **Offline**: after one online visit, the app shell and the conference's schedule are kept on the phone. Without a connection, Search runs a keyword search over that saved schedule, labelled "Offline: keyword search only", and Interested and the profile still work. People, For you and talk circles say they need a connection.

There is no sign-in. A profile is written to Elasticsearch only when you turn on a visibility choice; a random device secret, stored only as a hash on the server, protects every edit. Profiles expire after the conference's last day, and "Delete my profile" removes them at once. The sample profiles you may see are labelled "Sample" and are not real people.

## Demo

The three-minute demo script is [docs/demo/SCRIPT.md](docs/demo/SCRIPT.md). It covers the preparation, the two labelled demo profiles and how to re-seed them, every tap in order, and a rehearsal run against the live service. Screenshots from that run are in [docs/demo/shots/](docs/demo/shots/).

Scan this QR code to open KubeCon + CloudNativeCon North America 2026 in the app (it links to `/e/kubecon-cloudnativecon-north-america-2026`):

<img src="docs/demo/qr-kubecon.png" alt="QR code that opens Conference Caddie for KubeCon + CloudNativeCon North America 2026" width="240">

## How it works

- Conference schedules are committed snapshots of public Sessionize feeds. Nothing is fetched at runtime.
- Conferences are discovered from the Linux Foundation events list (`events.linuxfoundation.org`), which names each event's schedule page; the page carries the Sessionize feed to read. Only the operator runs ingestion, from the CLI.
- Elasticsearch is the only data store and does all matching, ranking and filtering: lexical plus `semantic_text` retrievers fused with reciprocal rank fusion for search, people and suggestions. No generative model is used.
- Each conference's topic list is built from its talk titles at ingestion, with an Elasticsearch analyzer and aggregation.
- One Node.js service on Cloud Run serves the app and the API. It runs as the dedicated `caddie-runtime` service account, which can read only the two secrets below and has no project-level roles. It holds two scoped keys from Secret Manager: a read-only key for talks, conferences and topics, and a people key that can only read and write the people index.

## Adding a conference

With `ELASTISEARCH_API_KEY` set to an admin-capable key:

```sh
npm run ingest -- --list                 # upcoming Linux Foundation events and their platform
npm run ingest -- --event <slug>         # ingest one event and build its topics
npm run ingest -- --all-upcoming         # every upcoming event whose schedule is on Sessionize
npm run topics -- --event <slug>         # rebuild one event's topic list, for example after editing its fix-up file
node scripts/build-facets.mjs [<slug> ...]  # rebuild the track, room, speaker and tag names used for suggested chips; run it after ingesting
```

Re-running is safe: unchanged talks are not re-embedded. Events on other platforms, or with no published schedule, appear in the switcher as "Schedule not available here yet". Per-conference topic fix-ups (rename, merge, remove) live in `data/topics/{slug}.json`; the shared stoplist is `config/topic-stoplist.txt`.

For the API and index shapes, see [docs/CONTRACT.md](docs/CONTRACT.md). Design choices are recorded in [DECISIONS.md](DECISIONS.md).
