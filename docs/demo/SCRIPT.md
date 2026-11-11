# Three-minute demo script

The demo shows one idea: find the right talk, and the right people around it. It runs on a phone, on KubeCon + CloudNativeCon North America 2026 (9 to 12 November, Salt Lake City), with labelled sample profiles standing in for other attendees: two demo profiles, 100 dummy profiles and 30 ordinary samples.

The QR code is `docs/demo/qr-kubecon.png` (1280 px, high error correction; a vector copy is `qr-kubecon.svg`). It opens https://conference-caddie.krlehnardt.workers.dev/e/kubecon-cloudnativecon-north-america-2026, the free app served by the Cloudflare Worker (see [docs/FREE_HOSTING.md](../FREE_HOSTING.md)). It was regenerated for that address on 2026-11-11 with `node worker/scripts/make-qr.mjs --app-url https://conference-caddie.krlehnardt.workers.dev` and decoded to check it. The old Cloud Run address `https://conference-caddie-265846417372.us-west1.run.app` keeps working until the paid stack is shut down, but the QR code does not point at it. The slug ends in `-2026`, which differs from the path in the original brief; the real slug is the one the app serves.

## Before you start

1. Open the app on the demo phone and clear its state. If a stray profile exists, open Settings with the gear at the top right, tap Profile, scroll to Delete, tap "Delete my profile" twice (the second tap confirms), and check for "Your profile was deleted from this phone and from our server."
2. Remove every test profile that is not a sample from the live people index for KubeCon. Test profiles show up in People to meet and in the talk circle next to the samples. On 9 November the operator deleted the ones named "test", "test1" and "test2" and the old "Smoke test" profiles, which leaves the owner's own profile. Anything created later, for example a new "test1" profile that appeared after that clean-up, should be deleted from the phone that made it, or by the operator.
3. The people index also holds 100 labelled dummy profiles ("Sample · <name>", seeded with `--label dummy`, see "The 100 dummy profiles" below), so a new user always has people to match with. To re-seed them, run `node scripts/seed-people.mjs --event kubecon-cloudnativecon-north-america-2026 --file data/samples/dummy-people.json --label dummy`; to remove only them, run `node scripts/seed-people.mjs --event kubecon-cloudnativecon-north-america-2026 --label dummy --remove`. Re-seed the two demo profiles too, so that they are present and fresh (see "The two demo profiles" below).
4. Open the QR link once while online and wait for People to load. The app saves the conference's schedule for offline use about two seconds after it opens, and the airplane-mode step relies on that.
5. Tap Search, type "Platform-First AI Agent Security" and tap "I'm interested" on the first result card, which is that talk. The Interested tab now shows a badge with 1. Do not switch on "Share my profile with others interested in this talk" yet; that is step 3. Then tap "Not now" on the card "Keep Conference Caddie on your home screen", which opens once on a device, right after the first talk is marked Interested. Then tap the X in the search box, so that the box is empty for the airplane-mode step.
6. Keep a second screen or printout with the QR code ready, and set the phone's brightness to maximum.
7. Do not create the profile yet. The audience should watch it being made in step 1.

If you made a profile while rehearsing, delete it again (step 1 above) so that the demo starts from "Create my profile".

## The script

Total time: 3:00. Times are the point at which each step should start.

### 1. A person scans the QR code and picks ten topics (0:00 to 0:50)

Say: "Everyone at a conference wants to meet the right people. Scan this and you are in."

- Show the QR code. Scan it with the phone's camera and tap the link. The audience sees the app open on People, headed "People to meet", with a card "Find people worth meeting".
- Tap "Create my profile". The audience sees the Profile screen with "About you".
- Tap Name and type "Sam". Leave About me empty.
- Under "I want to learn about", tap the search box "Find a topic" and type "ebpf"; tap the "eBPF" chip under it, then tap the X in the box to clear it. Do the same for "opentelemetry" (chip "OpenTelemetry") and "security" (chip "Security"). Then tap "Observability" and "Kubernetes" in "Common at this conference". The five chosen chips sit in a row above the search box, and the counter reads "5 of 30".
- Under "I can speak to", tap "Platform", "Open Source", "Cloud Native" and "AI" in "Common at this conference", then type "gitops" in that set's search box and tap "GitOps". That makes ten topics. The audience sees every tap turn a chip blue with a tick at once, with no modal. At a calm pace this whole step took about 17 seconds in the rehearsal run.
- Say: "No account, no sign-in. The profile lives on this phone."

### 2. People to meet shows a match, with the reason and the opener (0:50 to 1:20)

- Tap People at the bottom. The audience sees "Find people worth meeting" replaced by "Turn on visibility to see who to meet", with the short notice that says what is stored, who sees it and how to undo it. Read the notice's first sentence aloud.
- Tap "Make me visible". The audience sees "Finding people…" and then cards.
- Above the cards is the line "Profiles marked Sample are demo profiles, not real attendees." The first card is "Sample · Demo B", with the blue outlined "SAMPLE" badge. Point at the shaded line with the speech icon: "They can speak to eBPF, OpenTelemetry, Security, and Observability, which you want to learn about." That is the opener. Below it is a second reason, "They want to learn about Platform and GitOps, which you can speak to.", then the lines "Can speak to:" and "Wants to learn:", and under "How to reach me" the note "Sample profile, not a real person".
- Say: "The app matched what I want to learn against what they can speak to, and the reverse. The reason names the topic. No model wrote this sentence."
- Scroll once to show the other profiles below it, all of them dummy or ordinary samples, each with the "SAMPLE" badge. In the rehearsal run the next five were "Sample · Meera Kapoor", "Sample · Kofi Adeyemi", "Sample · Ethan Rowan", "Sample · Budi Tupou" and "Sample · Aarav Iyer", and the list held 20 people. A dummy profile has a "LinkedIn profile" link under "How to reach me", with the note "Sample profile for the demo". Do not tap the link: all 100 dummies point at the same address, which is the owner's own LinkedIn page.

### 3. A talk circle shows who else is interested (1:20 to 1:50)

- Tap Interested at the bottom. At the top is a card "Share with people interested in these talks"; leave it alone. Below it, under "Thursday, November 12", is the talk marked in the preparation: "Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes", by Carlos Santana, "Thu, Nov 12 · 3:30–4:00 PM MST", in "Salt Palace | Level 2 | 255 BC". Inside the card, under the filled-star "I'm interested" button, is the line "10 people want to talk about this": the two demo profiles and eight dummy profiles. Any other profile that shares for the talk adds to this count.
- In that card, tap the switch "Share my profile with others interested in this talk". Read the one-paragraph notice that opens under it, then tap "Share my profile". The count goes up by one, to 11, for you.
- Tap "See who's here". The audience sees "Speakers" with Carlos Santana and his public links, then "Others who shared" with the line about Sample profiles and ten cards, all badged "SAMPLE". People are ranked against your topics, so the order depends on them. In the rehearsal run it was Ethan Rowan, Hannah Brooks, Kofi Adeyemi, then "Sample · Demo B" fourth with the opener "They can speak to eBPF, OpenTelemetry, Security, and Observability, which you want to learn about.", then Noor Aziz, Chidi Mwangi, Karim Darwish, Connor Sullivan, Elena Popescu and "Sample · Demo A" last. Scroll to Demo B to show the strongest match. Every card lists the reason "You are both interested in Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes." and, under "How to reach me", the note "Sample profile for the demo" with a LinkedIn link for a dummy, or "Sample profile, not a real person" for a demo profile.
- Say: "Only people who chose to share for this talk can see this list. Everyone else gets the count. Sharing for a talk does not make me visible to the whole conference, and the reverse."

### 4. For you shows suggested talks and why (1:50 to 2:20)

- Tap "For you" at the bottom. The audience sees "Talks picked from what you want to learn. Ended talks and talks you marked are left out." and a list of 20 talks. The shared talk is not in it, because it is already marked.
- Point at the line "You want to learn:" on the first card, which names the learn topics it matched. In the rehearsal run the first card was "GPU Observability with eBPF: From Kernel Hooks to Kubernetes Metrics" with "You want to learn: eBPF, Observability, Kubernetes", then "You want to learn: OpenTelemetry, Observability", "You want to learn: Security, Kubernetes" and so on. Only the five learn topics count here; the speak topics are not used. Talks that match equally well can swap places between runs, so do not promise a particular first talk. This profile has no free text, so the cards show topics only; a highlighted passage appears when the profile has free text. Most cards now also show "N people want to talk about this", from the dummies' shared talks (1 to 11 in the rehearsal run); point at one.
- Say: "Ranking is hybrid search: keyword matches and meaning (embeddings) together, fused with reciprocal rank fusion. Talks that have ended, and talks I already marked, are left out."
- Tap "I'm interested" on the first suggestion. The button changes to "Interested", the message "Added to Interested" appears at the bottom, and the Interested badge goes to 2.

### 5. Airplane mode shows what still works (2:20 to 2:55)

- Swipe down and switch on airplane mode (and make sure Wi-Fi is off). The audience sees the phone's airplane icon, and an "Offline" pill appears in the app's top bar.
- Tap Search and type "ebpf" in the empty box. The audience sees "Offline: keyword search only" above "8 talks", in schedule order, each card with "eBPF" highlighted in its abstract. Say: "Offline there is no semantic search, only keywords over the schedule saved on the phone, and the app says so."
- Tap Interested. Both talks are still there: the shared talk and the one marked in step 4. Each card shows "Talk circles need a connection.", and the sharing card at the top is hidden.
- Tap the gear at the top right, then Profile. The name and the ten chosen topics are still there.
- Tap People. The audience sees "People to meet needs a connection" and "They will load when you're back online. Search, your Interested list and your profile still work on this phone." People matching is live data, so it does not pretend to work offline. For you shows "Suggestions need a connection" in the same way.
- Switch airplane mode off. The "Offline" pill goes away and People loads again.

### Closing line (2:55 to 3:00)

Say: "Everything you saw runs on a free Cloudflare Worker with embeddings and keyword search, and we chose not to build sign-in, messaging, push notifications, location or any scheduling, because the official schedule already does that."

## The two demo profiles

Both are samples. Both appear in the app with the "Sample" badge and a name that starts "Sample · Demo". Both are open to meet, both share for the same talk, and both carry the contact note "Sample profile, not a real person" and no LinkedIn link. They sit among 130 other samples, so nothing is pinned: they come first in People to meet only because their topics fit best. They are defined in `data/samples/demo-people.json`.

| | Sample · Demo A | Sample · Demo B |
|---|---|---|
| Wants to learn | eBPF, Observability, OpenTelemetry, Security | Platform, GitOps |
| Can speak to | Platform, GitOps | eBPF, Observability, OpenTelemetry, Security |
| Open to meet | yes | yes |
| Shares for | Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes | the same talk |

The shared talk is on Thursday 12 November, 15:30 to 16:00 (Mountain time), in 255 BC at the Salt Palace, so it has not ended at demo time. It spans the topics of both profiles (platform and security) and suits the story. If you demo after it has ended, choose another talk that ends on 12 November and re-seed with `--talk "<title>"`.

The demo profiles expire at the end of the conference (the app removes them after 12 November). To re-seed them, which first deletes the earlier profiles with the label `demo` for that event and touches no other sample, run this from the repository root with the admin key in `ELASTISEARCH_API_KEY` (required: the cleanup of the earlier samples deletes by query, which the people key cannot do; `ES_PEOPLE_API_KEY` and `ES_API_KEY`, when set, are still used to write and read):

```
node scripts/seed-people.mjs --event kubecon-cloudnativecon-north-america-2026 --file data/samples/demo-people.json --label demo
```

The command prints the shared talk, how many earlier demo profiles it deleted, and how many it wrote. A run without `--file` and `--label` re-seeds the ordinary samples and leaves the demo pair alone.

A fresh profile that wants to learn eBPF, Observability, OpenTelemetry and Security (plus Kubernetes) still gets "Sample · Demo B" first in People to meet, with the opener naming those topics, even with the 100 dummies present: the demo run was repeated three times against the live service on 9 November after the dummies were seeded and gave the same first card each time. Many dummies now speak to eBPF, Observability and the like, so if you change the demo topics, rehearse again and check who comes first.

## The 100 dummy profiles

At the owner's request, 100 invented profiles were seeded so that anyone who opens the app sees people to match with. They are samples: each has `sample: true` and a name that starts "Sample · ", and the UI shows the "SAMPLE" badge on them. They are defined in `data/samples/dummy-people.json`, written by `node scripts/make-dummy-people.mjs`.

- Every dummy links to `https://linkedin.com/in/kurtlehnardt` (the owner's choice) and has the contact note "Sample profile for the demo". All are open to meet.
- Names: 100 distinct names across ten regions, none of them a public figure.
- Topics: the conference has 96 topics. Each dummy learns exactly 10 and can speak to exactly 10, never the same topic in both sets. Every topic is learned by 10 or 11 dummies and spoken to by 10 or 11, so any topic a new user picks finds a match.
- Shared talks: each dummy shares for 10 upcoming talks that were ranked for its learn topics, from a different window of the top 50 per profile. Together they cover 323 distinct talks; one talk has 15 sharers at most, the median is 3.
- They disappear with the other samples at the end of the conference. Re-run the generator and then the seed command (see "Before you start") for fresh talk picks, for example if some of the shared talks have ended; the generator needs the admin key in `ELASTISEARCH_API_KEY`.
- Checked on 9 November against the live service: 20 throwaway visible profiles, each with 10 random topics, all got at least 3 people to meet (the list shows at most 20), and every reason named topics that really overlap; the circle counts of 10 shared talks matched the file; a profile that is not visible got no matches (403). The throwaway profiles were deleted afterwards.

## Rehearsal run

On 9 November the whole script ran against the live service in a scripted, fresh phone browser at 390 by 844 pixels, with a pause of 0.9 seconds before every tap. Every step behaved as written above, with the 100 dummy profiles in place (16 of 16 checks). Picking the ten topics took about 16 seconds, People to meet loaded in about 1.3 seconds, the circle in about 1.8 seconds and For you in under a second. The test profile was deleted afterwards. Screenshots from the run are in `docs/demo/shots/`: the ten chosen topics (`1-ten-topics.png`), the first match (`2-people-to-meet.png`), the talk circle (`3-talk-circle.png`), For you (`4-for-you.png`) and the offline search (`5-offline-search.png`). The only people in them are the labelled samples.
