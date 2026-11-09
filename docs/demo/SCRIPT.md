# Three-minute demo script

The demo shows one idea: find the right talk, and the right people around it. It runs on a phone, on KubeCon + CloudNativeCon North America 2026 (9 to 12 November, Salt Lake City), with two labelled sample profiles standing in for other attendees.

The QR code is `docs/demo/qr-kubecon.png` (1280 px, high error correction; a vector copy is `qr-kubecon.svg`). It opens `https://conference-caddie-265846417372.us-west1.run.app/e/kubecon-cloudnativecon-north-america-2026`. The slug ends in `-2026`, which differs from the path in the original brief; the real slug is the one the app serves.

## Before you start

1. Open the app on the demo phone and clear its state. If a stray profile exists, open the profile icon at the top right, scroll to Delete, tap "Delete my profile" twice (the second tap confirms), and check for "Your profile was deleted from this phone and from our server."
2. Remove every test profile that is not a sample from the live people index for KubeCon. On 9 November it held five, four of them open to meet and one sharing for the demo talk, and they show up in People to meet and in the talk circle next to the samples. Delete them from the phones that made them, or ask the operator to remove them.
3. Re-seed the two demo profiles so that they are present and fresh (see "The two demo profiles" below).
4. Open the QR link once while online and wait for People to load. The app saves the conference's schedule for offline use about two seconds after it opens, and the airplane-mode step relies on that.
5. Tap Search, type "Platform-First AI Agent Security" and tap "I'm interested" on the first result card, which is that talk. The Interested tab now shows a badge with 1. Do not switch on "Share my profile with others interested in this talk" yet; that is step 3. Then tap the X in the search box, so that the box is empty for the airplane-mode step.
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
- Say: "Elasticsearch matched what I want to learn against what they can speak to, and the reverse. The reason names the topic. No model wrote this sentence."
- Scroll once to show the other sample profiles below it, each with the "SAMPLE" badge.

### 3. A talk circle shows who else is interested (1:20 to 1:50)

- Tap Interested at the bottom. At the top is a card "Share with people interested in these talks"; leave it alone. Below it, under "Thursday, November 12", is the talk marked in the preparation: "Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes", by Carlos Santana, "Thu, Nov 12 · 3:30–4:00 PM MST", in "Salt Palace | Level 2 | 255 BC". Inside the card, under the filled-star "I'm interested" button, is the line "2 people want to talk about this", for the two demo profiles. Any other profile that shares for the talk adds to this count.
- In that card, tap the switch "Share my profile with others interested in this talk". Read the one-paragraph notice that opens under it, then tap "Share my profile". The count goes up by one, for you.
- Tap "See who's here". The audience sees "Speakers" with Carlos Santana and his public links, then "Others who shared" with the line about Sample profiles. "Sample · Demo B" comes first, with the same opener as before, and "Sample · Demo A" follows, both badged "SAMPLE". Each lists the reason "You are both interested in Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes." and, under "How to reach me", the note "Sample profile, not a real person".
- Say: "Only people who chose to share for this talk can see this list. Everyone else gets the count. Sharing for a talk does not make me visible to the whole conference, and the reverse."

### 4. For you shows suggested talks and why (1:50 to 2:20)

- Tap "For you" at the bottom. The audience sees "Talks picked from your topics. Ended talks and talks you marked are left out." and a list of 20 talks. The shared talk is not in it, because it is already marked.
- Point at the line "Matches:" on the first card, which names the topics it matched. In the rehearsal runs the top cards showed, for example, "Matches: Kubernetes, Cloud Native, AI" on "Two Newcomers, One Cloud Native Future: Learning Kubernetes In The AI Era" and "Matches: Observability, AI" on "Demo Theater: ClickHouse Observability". Talks that match equally well can swap places between runs, so do not promise a particular first talk. This profile has no free text, so the cards show topics only; a highlighted passage under "Matches:" appears when the profile has free text. If a card further down shows "N people want to talk about this", point at that too.
- Say: "Ranking is Elasticsearch hybrid search: topic matches and meaning together, fused with reciprocal rank fusion. Talks that have ended, and talks I already marked, are left out."
- Tap "I'm interested" on the first suggestion. The button changes to "Interested", the message "Added to Interested" appears at the bottom, and the Interested badge goes to 2.

### 5. Airplane mode shows what still works (2:20 to 2:55)

- Swipe down and switch on airplane mode (and make sure Wi-Fi is off). The audience sees the phone's airplane icon, and an "Offline" pill appears in the app's top bar.
- Tap Search and type "ebpf" in the empty box. The audience sees "Offline: keyword search only" above "8 talks", in schedule order, each card with "eBPF" highlighted in its abstract. Say: "Offline there is no semantic search, only keywords over the schedule saved on the phone, and the app says so."
- Tap Interested. Both talks are still there: the shared talk and the one marked in step 4. Each card shows "Talk circles need a connection.", and the sharing card at the top is hidden.
- Tap the profile icon at the top right. The name and the ten chosen topics are still there.
- Tap People. The audience sees "People to meet needs a connection" and "They will load when you're back online. Search, your Interested list and your profile still work on this phone." People matching is live data, so it does not pretend to work offline. For you shows "Suggestions need a connection" in the same way.
- Switch airplane mode off. The "Offline" pill goes away and People loads again.

### Closing line (2:55 to 3:00)

Say: "Everything you saw is in Elasticsearch, which holds the talks, the topics and the people and does all the matching and ranking with hybrid search, and we chose not to build sign-in, messaging, push notifications, location or any scheduling, because the official schedule already does that."

## The two demo profiles

Both are samples. Both appear in the app with the "Sample" badge and a name that starts "Sample · Demo". Both are open to meet, both share for the same talk, and both carry the contact note "Sample profile, not a real person" and no LinkedIn link. They are defined in `data/samples/demo-people.json`.

| | Sample · Demo A | Sample · Demo B |
|---|---|---|
| Wants to learn | eBPF, Observability, OpenTelemetry, Security | Platform, GitOps |
| Can speak to | Platform, GitOps | eBPF, Observability, OpenTelemetry, Security |
| Open to meet | yes | yes |
| Shares for | Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes | the same talk |

The shared talk is on Thursday 12 November, 15:30 to 16:00 (Mountain time), in 255 BC at the Salt Palace, so it has not ended at demo time. It spans the topics of both profiles (platform and security) and suits the story. If you demo after it has ended, choose another talk that ends on 12 November and re-seed with `--talk "<title>"`.

The demo profiles expire at the end of the conference (the app removes them after 12 November). To re-seed them, which first deletes the earlier profiles with the label `demo` for that event and touches no other sample, run this from the repository root with the admin key in `ELASTISEARCH_API_KEY` (or the people key in `ES_PEOPLE_API_KEY` and the read key in `ES_API_KEY`):

```
node scripts/seed-people.mjs --event kubecon-cloudnativecon-north-america-2026 --file data/samples/demo-people.json --label demo
```

The command prints the shared talk, how many earlier demo profiles it deleted, and how many it wrote. A run without `--file` and `--label` re-seeds the ordinary samples and leaves the demo pair alone.

A fresh profile that wants to learn eBPF, Observability, OpenTelemetry and Security gets "Sample · Demo B" first, with the opener naming those topics. This was checked against the live service on 9 November.

## Rehearsal run

On 9 November the whole script ran against the live service in a scripted, fresh phone browser at 390 by 844 pixels, with a pause of 0.9 seconds before every tap. Every step behaved as written above. Picking the ten topics took about 17 seconds, People to meet loaded in about 1.3 seconds, the circle in about 1.7 seconds and For you in under a second. The test profile was deleted afterwards. Screenshots of the steps are in `docs/demo/shots/`.
