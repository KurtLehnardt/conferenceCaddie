# Conference Caddie: Find & connect — quick build spec

*Find the people nearby you can talk shop with: unique experience that gets you unstuck, or a new topic you want to learn, in person.*

Orchestrator prompt. `docs/CONTRACT.md`, `DECISIONS.md` and the handoff rules apply in full: Elasticsearch is the only store and does all ranking; no generative LLM; never print, log or commit a key; the browser never holds a key; public repo; no tests, CI or abstractions beyond what is used; one code review when the MVP is live, not before. This reverses the deferred items "location" (now) and "messaging" (stretch); record that in DECISIONS.md. The safety rules below are the only part that is not negotiable for speed.

## Why

Twenty thousand people attend. Somewhere among them are the people who have done the specific thing you are stuck on, or know the topic you want to pick up next, and you will never meet them by chance. Sched already shows who attended a talk, has a my-code profile share, and lets attendees message, so Caddie builds none of that. Caddie does two things: **find them** (a search over everyone's own words about what they have built and want to build, where rare, specific experience outranks common topics, and nearby people rank first) and **sync up** (say you are around, ask to talk shop, agree where).

## Build order

**MVP (deploy this first, then review):** block → find people by text → zone-only presence → ask to talk shop → meet screen. **Then:** GPS bands, report, classifier, percolator. **Stretch:** chat. One worktree branch and PR for the MVP; another for "Then"; never push to main. The MVP review is the only review; "Then" and the stretch ship without one.

---

## MVP

### M1. Block (half a step, but nothing that connects strangers ships without it)

`POST|DELETE /api/people/block {event, ref}`, `GET /api/people/blocks?event=`. Index `caddie-people-blocks-v1` (`_id` `{event}:{blocker}:{blocked}`; fields `event_id, blocker_id, blocked_id, created_at`). Symmetric and silent: both people vanish from each other in matches, circles and meets; a meet attempt either way gets the same 403 `blocked`. Store `ref` (keyword) on people documents at write time so the server can resolve it (a `PUT _mapping` addition; existing documents get it on their next write, and a one-off `scripts/backfill-ref.mjs` fills the rest). UI: "Block" in an overflow menu on every person card; blocked people under Settings with "Unblock". Deleted with the profile.

### M2. Find people by text

- **Profile labels** (no schema change): the "I can speak to" free text becomes **"Things I've built, run or broken"** (`expertise`); the "I want to learn about" free text becomes **"What I'm trying to figure out next"** (`interests`). Specific placeholders ("ran Postgres operators on bare metal for 3 years"). Hint under each: "The more specific, the better the matches."
- `POST /api/people/matches` gains `query` (free text, 300 chars) and `when` (`anyone` | `around_now`). The existing `rrf` retriever gains two legs: `query` (or my `interests` when empty) against `expertise_semantic` and `about_semantic`, and `query` as a lexical `match` on `expertise` and `about` (already `text` fields; no mapping change). Keep the two topic legs. Filter: `event_id`, `open_to_meet`, `visible_until > now`, not me, not blocked either way; `around_now` adds `presence_until > now`. **Specificity rule**: a result whose only matching leg is topic overlap on the conference's 10 most common topics (counts from `caddie-topics`) is a **broad** match: dropped from text searches, kept only in the "Around now" view when both people are around and in the same zone, ranked below every specific match and labelled with the shared topic ("also interested in Kubernetes"). Everything else is a **specific** match and carries `evidence`. **No cap**: `from`/`size` pages of 20, best first; the client appends on scroll. Each result adds `evidence` (the highlighted passage that matched), `around` (boolean) and `zone` (only when both of us are around). Reasons add "They've worked on {evidence}." and "They're in {zone} right now."
- UI: a search box at the top of the People tab, **"What are you working on, or about to?"**, with a toggle "Around now"; "Find people who've done this" on a topic chip runs the search with that topic. Empty state: "Nobody's profile matches that yet. Try different words, or fewer."

### M3. Zone-only presence ("I'm around")

- Switch on the People tab: **"Around and up for a conversation (while the app is open)"**. On: pick a **zone** from the conference's room names + `Expo hall`, `Registration`, `Food and coffee`, `Hallway`, `Outside`; optional **spot** line (60 chars). First-time notice verbatim: "While this is on, people you can see can also see that you're around and which zone you're in. How to spot you is shared only with someone you accept, only until you meet, and never stored after. It turns off by itself in an hour."
- **Zone deep link**: opening `/e/{slug}#/here/{zone}` turns presence on in that zone (after the notice, the first time), so anyone can print a QR code for a booth or a table and a scan means "I'm around, here". `zone` must be one of the conference's zones (unknown values fall back to the picker). Nothing in the app depends on these codes existing; they are a shortcut. Print one for the hackathon table.
- Expires 60 min after it was turned on (shown; tap extends), cleared on off, on 5 min in background (`visibilitychange` timer), on profile delete, at day end; `presence_until` enforced server-side.
- `PUT /api/presence {event, zone, spot}` (needs a visible profile, else 403 `profile_required`); `DELETE /api/presence?event=`. Presence lives **on the people document**: add `presence_zone` (keyword), `presence_spot` (text), `presence_since`, `presence_until` (date) by `PUT _mapping`; writes are Bulk partial `update`s that never touch the text fields, so they make zero model calls. No coordinates in the MVP.
- Spot lines (and meet notes, spot-me lines) pass a **server-side wordlist**: `config/moderation-words.json` seeded from the LDNOOBW English list (CC-BY 4.0, cited; do not write slurs yourself), matched after lowercasing, `NFKC` and diacritic stripping, with leet substitutions (0→o 1→i 3→e 4→a 5→s 7→t @→a $→s). A hit rejects with "That was held back by the filter. Edit it and try again." No URLs except `linkedin.com`. That is the whole MVP filter.

### M4. Ask to talk shop

- From any result, around or not: `POST /api/meet {event, ref, topic_id|null, note}` (note 140 chars; prefilled "I'd like to compare notes on {evidence or topic}"). Index `caddie-people-meets-v1`: `event_id, meet_id, participants (2 keywords), requester_id, topic_id, note, rendezvous, spot_me (object, enabled:false), state (requested|accepted|declined|active|found|cancelled|expired), created_at, active_since, expires_at`. State `requested` waits in the recipient's inbox until **end of the conference day**; one open request per pair; 10 / device / hour; 3 "Not now" in a day pauses the requester until the next day.
- Recipient polls `GET /api/meet/inbox?event=` every 20 s while the app is open; inbox badge on the People tab. Card: "{name} would like to talk shop about {topic}." + note + **Accept** / **Not now** (silent; requester sees "No reply yet") / **Block**.
- `POST /api/meet/{id}/accept` → `accepted`; becomes `active` (20 min) once **both** have presence. Copy: "You'll both see where to meet once you're both around." Both fill a **how to spot me** line (60 chars); either sets a **rendezvous** from the zone list (default: whoever already has a zone).
- `GET /api/meet/{id}` (poll 10 s; participants only; 403 to others; 410 when over) returns the other person's zone, spot, spot-me line and the rendezvous. Ends on **We found each other**, **Cancel**, 20 min active, end of day, or either presence ending while active. Afterwards only participants, topic, state and times are kept. After "found", show the pair's opener once and offer **Save this person** (device-only list: name and about).

### M5. Meet screen

Rendezvous ("Meet at Registration") → their zone and spot → how to spot them → **We found each other** / **Cancel**. Caveat verbatim: "Head to the meeting point and look for them."

### MVP safety rules (not negotiable)

Spot-me lines leave the server only to the one accepted partner while the meet is active. Zone and spot only between two people who are both around. Search results carry no zone otherwise. Everything per device, per conference, default off, self-expiring, deleted with the profile (meets and blocks with `refresh=wait_for`; the Delete copy says so). Log only method, path, status, duration; never a body.

### MVP deploy, smoke, docs, review

- All new indices are `caddie-people-*` so the existing people key covers them; `dynamic: false`; setup in `scripts/es-setup-people.mjs`. Mock mode (`VITE_MOCK=1`) gains the text search with evidence, presence, one inbox request, one meet; `rejectme` is rejected by the mock filter. `MOCK_FIXTURE_DO_NOT_SHIP` stays out of `web/dist`.
- `scripts/smoke.mjs` adds: a specific query ranks the person with the matching passage first and returns it as evidence; a result sharing only "Kubernetes" is dropped; results carry no zone unless both are around; presence needs a profile; a third device gets 403 from a meet; 410 after found; presence expires; block is symmetric and refuses a meet either way with the same body; a listed word is rejected; delete removes everything.
- README: one paragraph on Find & connect saying what is shared with whom and for how long. CONTRACT.md: the new fields and routes. DECISIONS.md: search is open to all visible profiles and presence only decides when; specificity and why rare beats common; no cap; zone and rendezvous over GPS, and why; requests wait until end of day; Sched covers profile sharing and chat.
- Then **one reviewer agent, one pass**: auth on every presence and meet route; block symmetry; can any device obtain a zone for someone while either side is not around, or a spot-me line outside an active meet it belongs to; no key or body in logs; deletion completeness. Fix findings before starting "Then".

---

## Then (second PR)

- **GPS bands.** Optional geolocation on the presence switch (`watchPosition`, foreground only, ≤1 update / 15 s, stopped on `visibilitychange`). Add `presence_location` (`geo_point`) and `presence_accuracy`; round to 5 decimals; `accuracy > 200 m` is treated as zone-only; coordinates are used only for ranking (a `distance_feature`, 100 m pivot, as one more `rrf` leg) and returned to nobody except inside an active meet, where `GET /api/meet/{id}` adds distance rounded to 10 m and bearing when both have coordinates. Results gain `proximity` as a band only: `same_zone | near (<75 m) | around (<300 m) | venue`. Meet screen gains the band and a small arrow when orientation is granted on a tap (iOS `DeviceOrientationEvent.requestPermission()`); caveat becomes "Positions indoors are rough. Head to the meeting point and look for them." `Permissions-Policy: geolocation=(self)`. Notice text gains "Your exact position is shared only with someone you accept, only until you meet, and never stored after."
- **Report.** `POST /api/people/report {event, ref, context:{kind:'profile'|'meet'|'spot', id}, reason}` (`harassment|hate|sexual|spam|other`), one per reporter per target, index `caddie-people-reports-v1`; 2 distinct devices hide the target from everyone but its owner ("Hidden after reports"). CLI `scripts/moderation.mjs --event <slug> [--hidden] [--since] [--unhide id] [--delete id] [--purge]`, admin key.
- **Classifier.** Google Cloud Natural Language `moderateText` via ADC of `caddie-runtime` (enable `language.googleapis.com`; no new secret); categories at least Toxic, Insult, Profanity, Derogatory, Sexual, Violent; env `MOD_REJECT=0.8` rejects, `MOD_HOLD=0.5` stores hidden-pending with an auto report, `MOD_TIMEOUT_MS=3000`; **fail closed** to hidden-pending ("Waiting for the filter; it will appear shortly."). English-centric; note it in DECISIONS.md. Copy says "filtered", never "safe".
- **Percolator.** Move the wordlist into `caddie-people-rules-v1` (a `percolator` query field; analyzer with lowercase, `asciifolding` and the leet `char_filter`) so rules are Elasticsearch queries and `--reload-rules` reindexes them. Same behaviour, on-theme for the track.
- **Nudges, in-app only, zero-fatigue.** While presence is on, the client's existing poll checks for a new **specific** match (text or rare-topic evidence, never a broad one) in the **same zone**. If there is one, show a single in-app nudge: "Someone who's worked on {evidence} is in {zone} right now" with "See who" (their card and Ask to talk shop). Once per pair per day (`caddie.nudged.v1.{slug}` on the device; the server adds nothing), never a distance, never a name before the tap. Nothing else interrupts; broad matches live only in the "Who's around" list.
- Web Push for the same nudge stays deferred; it is the next unlock after this. When it lands, the nudge rule above becomes the push rule unchanged: same trigger, same cooldown, a new channel.

---

## Stretch: chat (only after "Then")

Talk rooms (read if interested, post if shared for the talk; `GET/POST /api/chat/rooms/talk/{talk_id}`, newest 50 then `after=seq`, 500 chars, poll 5 s) and request-style 1:1 (one message until they reply; 10 new conversations / device / day; "Message them" appears on a finished meet). Indices `caddie-people-messages-v1` and `caddie-people-conversations-v1`; same filter pipeline; hide at 2 reports; expire with the conference; die with the profile. Notice verbatim: "Messages here are visible to everyone interested in this talk, carry your profile name, and pass an automatic filter for abusive language. Be the colleague you'd want to meet. Report anything that crosses the line."
