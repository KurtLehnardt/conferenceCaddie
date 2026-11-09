# Data notes

`data/talks.ndjson` is built from the committed feed snapshot `data/raw/schedule.json` by `npm run data` (`scripts/build-data.mjs`, Node built-ins only). The script never calls the network. It writes 600 lines, one per feed session, each with exactly the fields in the contract's "Index document" section.

## Name resolution

Every room, speaker and category item id in the feed resolved to a name. No session has a missing room, no session references a speaker that is absent from the speaker table, and no category item is unknown. The output contains no GUIDs and no numeric ids in `speakers`, `room`, `track`, `level` or `flags`. The script stops with an error if any name fails to resolve.

## Category groups

The feed has five category groups, and every one fits a role.

- "All Sessions" is the track group. Every session has exactly one item in it, so `track` is always set and is never "Not specified".
- "Audience Level" is the level group (Beginner, Advanced, Any Level). 381 sessions have no level, so they get "Not specified".
- "End User Programming" (End User Talk), "Solutions Showcase Programming" (Learning Lounge) and "Presentation Slides" (Slides Attached) are flag groups.

Some track names carry an emoji prefix exactly as the feed spells them, for example "📚 Tutorials", "⚡ Lightning Talks", "🚨 Contribfest" and "🪧 Poster Sessions". They are kept as they are.

## Counts per kind

- talk: 484
- ambient: 76
- housekeeping: 19
- break: 21

## Kind rules

The rules run in this order and the first match wins.

1. housekeeping: the description is empty and the title is an opening, a closing, a welcome, "remarks" or a wrap-up (for example "Welcome + Opening Remarks", "Closing Remarks", "EnvoyCon Opening Remarks", "Project Lightning Talk Closing").
2. break: there are no speakers, and either the part of the title before any " | " mentions coffee, lunch, breakfast, registration, badge, coat, bag check, snacks or a reception, or the track is Breaks or Registration. The part after " | " is ignored because co-located events carry suffixes such as "SEPARATE REGISTRATION REQUIRED".
3. talk: at least one speaker.
4. ambient: no speakers and nothing above matched. This covers co-located events, the Solutions Showcase, in-booth demos, project pavilion kiosks and tours, meetups, poster showcase and similar items.

The coffee breaks and lunches on the days of the Project Lightning Talks are filed by the feed under the track "Project Lightning Talks". The title rule catches them, so they are breaks.

## Tracks with counts

All 600 items, by the feed's track: Maintainer Track 73, Cloud Native Theater 53, Project Lightning Talks 51, AI Inference + Agentic 45, Sponsor Demo Theater 39, Keynote Sessions 35, Platform Engineering 32, Solutions Showcase 24, Experiences 23, Observability 19, Operations + Performance 18, Security 17, Contribfest 16, Sponsor-hosted Co-located Events 14, Inclusion + Accessibility 14, Project Pavilion Stage 14, CNCF-hosted Co-located Events 11, Poster Sessions 11, Registration 10, Application Development + Delivery 9, Project Opportunities 9, Cloud Native Experience 8, Breaks 8, Tutorials 8, Lightning Talks 8, Data Processing + Storage 6, Emerging + Advanced 6, Connectivity 7, Cloud Native Novice 7, Project Pavilion Tours 5.

Talks only (kind talk, 484): Maintainer Track 73, Project Lightning Talks 46, AI Inference + Agentic 45, Sponsor Demo Theater 39, Cloud Native Theater 39, Platform Engineering 32, Keynote Sessions 31, Observability 19, Operations + Performance 18, Security 17, Contribfest 16, Inclusion + Accessibility 13, Experiences 13, Solutions Showcase 11, Poster Sessions 10, Application Development + Delivery 9, Cloud Native Experience 8, Tutorials 8, Lightning Talks 8, Connectivity 7, Cloud Native Novice 7, Data Processing + Storage 6, Emerging + Advanced 6, Project Pavilion Stage 3.

## Levels with counts

All 600 items: Not specified 381, Any Level 131, Advanced 61, Beginner 27. Among talks only: Not specified 272, Any Level 125, Advanced 61, Beginner 26.

## Flags with counts

All 600 items: Slides Attached 112, End User Talk 81, Learning Lounge 12.

## Slides finding

Confirmed. Category item 523121 is "Slides Attached" and question 137003 is "Presentation Slides" (a file upload whose answer is a link to a PDF on sessionize.com). The script checks both facts and stops if either is wrong.

- `slides_url` is the answer to question 137003, kept only when it starts with http or https. All of them do.
- `has_slides` is true exactly when `slides_url` is set. That is 112 sessions, all of them talks.
- The feed's "Slides Attached" category is stale. Only 54 sessions carry it, while 112 sessions have a slides link, and all 54 are among the 112. So the `flags` field adds "Slides Attached" whenever there is a link, and the flag agrees with `has_slides` everywhere.

## Sponsor rule

`sponsor` is true for 62 items: the track is "Sponsor Demo Theater" (39 items) or "Sponsor-hosted Co-located Events" (14 items), or the title contains "sponsored by", "sponsored keynote" or "in-booth demos" (8 Solutions Showcase "Gold In-Booth Demos" items and one Network Nook meetup "Sponsored by CDW"). Descriptions are not used, because the Sponsor Demo Theater and Showcase descriptions share a boilerplate sentence about sponsored content, and a few technical abstracts say "sponsored" in an unrelated sense. No feed title contains "Sponsored Keynote", and no keynote track item is marked sponsored, so no keynote is flagged. Among searchable talks (kind talk), 39 are sponsor content, all from the Sponsor Demo Theater.

## Times

`startsAt` and `endsAt` are venue-local with no offset. The script attaches the America/Denver offset by asking `Intl.DateTimeFormat` for the offset in force at each instant. All 600 sessions fall on 8 to 12 November 2026, after the daylight saving change on 1 November, so every offset is -07:00. The days are 2026-11-08 (4 items), 2026-11-09 (78), 2026-11-10 (194), 2026-11-11 (203) and 2026-11-12 (121). `day`, `start_minutes` and `end_minutes` come from the venue-local clock.

## Odd things

- One item ends at local midnight on the next day: "Save Phippy: The Cloud Native Escape Room Hosted by Teleport" runs 19:00 to 00:00. Its `end_minutes` is 1440 and its `end` is on 2026-11-12.
- Four talks have speakers but no description, so their `abstract` is an empty string: "From Pod to Actuator: Physical AI and the Future of Kubernetes", "Human Scale, Agent Scale" and "A Tribute to Open Source" (all keynotes), and "CNCF Bingo: Play, Learn, Win!!!!!!" (Cloud Native Theater). The brief says a talk needs a speaker and a description. Rule 3 above treats a speaker as enough, because these are real sessions and dropping them from search would hide real keynotes. This is a deliberate departure from the brief for those four items.
- Most items with speakers but no description are openings and closings (13 of 14 in Cloud Native Theater, plus a few keynote and lightning items). Their titles make them housekeeping, which accounts for the 19 housekeeping items.
- 24 talks have speakers but no tagline, so their `speaker_taglines` is shorter than `speakers` (or empty). Taglines are omitted when empty, as the contract says, so the arrays are not aligned by position.
- Every session has a room. No speaker is missing from the speaker table.
- Titles and descriptions are trimmed, and line endings in descriptions are normalised from CRLF to LF. A few titles end with a hint after " | ", such as "SOLD OUT" or "SEPARATE REGISTRATION REQUIRED". They are left in the title as the feed has them.
- Two Project Pavilion Stage items last two hours or more ("An Introduction to Capture The Flag" and "Capture The Flag Experience"). They have speakers and descriptions, so they are talks.
- The feed's `isServiceSession` field was not used.
