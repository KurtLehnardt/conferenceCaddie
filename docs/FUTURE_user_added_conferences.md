> **Deferred, not implemented.** This design is for a separate project after the hackathon (user-added conferences with Google sign-in). Nothing in this repository implements it: there is no code, stub, route, feature flag, OAuth configuration or schema field for it.

# Phase 2: any conference (user direction, 2026-11-09)

## User decisions

1. Ship the KubeCon NA 2026 MVP first, then generalize. KubeCon becomes the first conference in the multi-conference model.
2. Creating a conference requires Google sign-in. Signed-out users are read-only: they can browse and search conferences and save talks on their device. The user will enable Google OAuth in the Google Cloud project and supply the credentials.
3. First import sources: Sessionize and Sched. Users either paste a link or upload the file exported from those tools.
4. Users are guided to find their conference's schedule link or export, and the importer collects the conference details (name, dates, time zone, venue, website). It pre-fills whatever the source provides and asks for the rest.

These decisions supersede three lines of the original brief, for conference import only: "Never build: accounts, login", "Ingestion runs from the repo and is not deployed", and "Never call the feed at run time". Searching still never calls a source feed. Record this in DECISIONS.md.

## Draft architecture (the phase-2 architect refines it)

- **Data.** Elasticsearch stays the only data store.
  - A `caddie-conferences` index holds one document per conference: slug, name, dates, IANA time zone, venue, website, source platform and URL, owner Google `sub` and email, created and updated times, counts per kind, the category-group mapping, and a `listed` flag.
  - `caddie-talks` gains a `conference` keyword field, and every query filters on it. Document `_id` is `<conference>:<talk_id>`.
  - The KubeCon talks are re-indexed with `conference: "kubecon-na-2026"`, under a system owner.
- **Keys.** The search path keeps the read-only key. A second key, used only by the import and delete endpoints, can write only to `caddie-talks*` and `caddie-conferences*`, with no manage privileges. Both keys live in Secret Manager.
- **Auth.** Google Identity Services (the "Sign in with Google" button) in redirect mode, which suits installed PWAs:
  - The server verifies the ID token itself: signature against Google's JWKS, `aud` equal to the client ID, `iss`, `exp` and the `g_csrf_token` double-submit check.
  - It then sets a signed, stateless session cookie (HttpOnly, Secure, SameSite=Lax). The signing secret lives in Secret Manager.
  - State-changing requests require a matching Origin header and a JSON content type.
  - Only the OAuth client ID is needed, and it is public. No client secret is used.
  - Admins come from an `ADMIN_EMAILS` env var on Cloud Run, never committed. An admin can delete any conference.
- **Import.**
  - A preview endpoint and a commit endpoint, with the commit requiring sign-in.
  - Link fetches are limited to `sessionize.com`, `*.sessionize.com` and `*.sched.com`, with no redirects to other hosts, at most 10 MB and a timeout. File upload accepts Sessionize JSON and Sched `.ics`.
  - At most 3,000 sessions per conference, and a per-user import rate limit.
  - Imports are synchronous, with the Cloud Run request timeout raised for this route.
  - The owner can refresh or delete a conference.
  - Classification is heuristic (talk, ambient, break, housekeeping). Category groups are mapped to track, level or flags by suggestion, and the user confirms.
- **Sessionize.** Accepts an organizer API link (`sessionize.com/api/v2/{id}/view/All`), a schedule-site link (`*.sessionize.com/api/schedule`), or an uploaded JSON export. The source carries no time zone, so the user picks one (an IANA list, pre-selected when it can be guessed).
- **Sched.**
  - The public calendar export at `https://{event}.sched.com/all.ics`, or an uploaded `.ics`.
  - Optionally, an organizer API key, used once on the server and never stored or logged.
  - Verify the formats against real public Sched events before relying on them.
- **UI.**
  - Conference routes at `/c/<slug>`.
  - The app bar title is the conference name with a chevron, and it opens a conference switcher.
  - "Add conference" asks the user to sign in first. It is a four-step wizard: Source (paste a link or upload a file, with help on where to find it on each platform), Details, Categories, and Review & import.
  - Settings gains an Account section (signed-in email and Sign out) and a My conferences section (refresh and delete).
  - Saved agendas are kept per conference.

## Order of work

1. The MVP goes live and the user gets the status message.
2. The three MVP reviews run in parallel with the phase-2 design.
3. The review fixes are applied.
4. Phase 2 is built in parallel worktrees: data model and migration; importers; auth; frontend; deploy.
5. The integrator merges everything and runs the smoke checks.
6. A critic reviews auth and import. A fix agent addresses the findings, and a fresh critic re-reviews.
7. Deploy.
8. The brief's stretch features, in the brief's order.
