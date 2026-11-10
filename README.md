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
- **Find & connect**: type what you're working on, or about to, and the app finds everyone whose own words about what they've built match it, with the passage that matched shown as evidence; rare, specific experience outranks the conference's common topics. Flip "Around and up for a conversation" and pick a zone (a room, the expo hall, registration, food, hallway, outside) to be findable right now, for an hour or until you turn it off that day; in the day mode the app asks "Still in {zone}?" whenever you come back to it after a while. While it's on, the People tab opens on who's around, your zone first. Someone in your zone gets a one-tap Wave; anyone else who's around gets a short ask to talk shop. Asks are now-only: they run out in 15 minutes, accept means now, and the two of you agree a meeting point and each say how to spot you. Someone who isn't around is watched, not booked: the app tells you when they turn up. While you're around, a nudge says when someone with specific, matching experience is in your zone, once per person per day, never a name until you look; turn on "Nudge me even when the app is closed" (from your Home Screen on iPhone) and the same nudge arrives as a push notification, at most a few an hour. Optionally, your position too: it ranks people near you higher and shows others only a band (same zone, near, around, venue), while the one person you accepted sees a rough distance and direction until you meet. The Android app adds "Find people near me by Bluetooth": phones that opted in exchange a random code that changes every ten minutes, and you get a notification only for a strong match within a few metres. Block is symmetric and silent; Report hides a profile, spot line or ask after two reports; short texts pass a filter (a wordlist of rules in Elasticsearch, then a text classifier that holds a doubtful line until an operator looks). What is shared, with whom, for how long: your profile text, to everyone visible at that conference, until its last day; your zone, only to people who are also around, only while you are; your spot line, the same; how to spot you, only to the one person you accepted, only until you meet; your exact position, only to that person, rounded, only until you meet, and never stored after; the Bluetooth code, to nobody but this server, for ten minutes at a time; the push subscription, until you turn it off, delete your profile or the conference ends. Nothing about where you were is kept.
- **Talk circles**: mark a talk "I'm interested", and separately choose to share your profile with others interested in that talk. Everyone sees how many people want to talk about it; only people who shared can see who else did.
- **For you**: talk suggestions from your topics and free text, with the matching topics and passage shown.
- **Search**: hybrid lexical and semantic search over one conference's talks, with filters for day, time, track and the conference's own tag groups.
- **Interested**: a plain list of the talks you marked, in time order, kept on your device. From here you can share your profile for all of them at once, stop sharing for all, or let sharing follow the list as you mark and unmark talks.

There is no sign-in, no scheduling, no sponsor features and no chat: Sched covers attendee lists, profile sharing and messaging, so this app does not. A profile is written to Elasticsearch only when you turn on a visibility choice; a random device secret, stored only as a hash on the server, protects every edit. Profiles expire after the conference's last day, and "Delete my profile" removes them at once. The sample profiles you may see are labelled "Sample" and are not real people.

## How it works

- Conference schedules are committed snapshots of public Sessionize feeds. Nothing is fetched at runtime.
- Conferences are discovered from the Linux Foundation events list (`events.linuxfoundation.org`), which names each event's schedule page; the page carries the Sessionize feed to read. Only the operator runs ingestion, from the CLI.
- Elasticsearch is the only data store and does all matching, ranking and filtering: lexical plus `semantic_text` retrievers fused with reciprocal rank fusion for search, people and suggestions. No generative model is used.
- Each conference's topic list is built from its talk titles at ingestion, with an Elasticsearch analyzer and aggregation.
- One Node.js service on Cloud Run serves the app and the API. It runs as the dedicated `caddie-runtime` service account, which can read only the secrets `scripts/deploy.sh` mounts and has no project-level roles. Those are two scoped Elasticsearch keys (a read-only key for talks, conferences and topics, and a people key that can only read and write the `caddie-people*` indices), the VAPID private key that signs push nudges, and optionally a read-only GitHub token for the profile import. The text classifier uses the service account's own token; no key. `docs/OPERATOR_CHECKLIST.md` lists the operator steps in order.

- The Android companion (`web/android/`, see `docs/ANDROID.md`) is the same web app in a Capacitor shell plus one Bluetooth plugin; the debug APK is built by the GitHub Actions workflow on `android/**` branches. The web app and the companion share one API, one server and one set of storage keys.

## Adding a conference

With `ELASTISEARCH_API_KEY` set to an admin-capable key:

```sh
npm run ingest -- --list                 # upcoming Linux Foundation events and their platform
npm run ingest -- --event <slug>         # ingest one event and build its topics
npm run ingest -- --all-upcoming         # every upcoming event whose schedule is on Sessionize
npm run topics -- --event <slug>         # rebuild one event's topic list, for example after editing its fix-up file
```

Re-running is safe: unchanged talks are not re-embedded. Events on other platforms, or with no published schedule, appear in the switcher as "Schedule not available here yet". Per-conference topic fix-ups (rename, merge, remove) live in `data/topics/{slug}.json`; the shared stoplist is `config/topic-stoplist.txt`.

For the API and index shapes, see [docs/CONTRACT.md](docs/CONTRACT.md). Design choices are recorded in [DECISIONS.md](DECISIONS.md).
