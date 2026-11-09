# Three-minute demo script

The demo shows one idea: find the right talk, and the right people around it. It runs on a phone, on KubeCon + CloudNativeCon North America 2026 (9 to 12 November, Salt Lake City), with two labelled sample profiles standing in for other attendees.

The QR code is `docs/demo/qr-kubecon.png` (1280 px, high error correction; a vector copy is `qr-kubecon.svg`). It opens `https://conference-caddie-265846417372.us-west1.run.app/e/kubecon-cloudnativecon-north-america-2026`. The slug ends in `-2026`, which differs from the path in the original brief; the real slug is the one the app serves.

## Before you start

1. Open the app on the demo phone and clear its state. If a stray profile exists, open the profile icon at the top right, scroll to Delete, tap "Delete my profile" twice (the second tap confirms), and check that the Profile screen is empty. Also delete any stray test profile that may be on the server for this phone.
2. Re-seed the two demo profiles so that they are present and fresh (see "The two demo profiles" below).
3. Preload the app once while online: open the QR link, wait for People to load, open Search and run one search, open Interested, then open the Profile screen. This fills the cache that the airplane-mode step relies on.
4. Search for "Platform-First AI Agent Security", open the result and tap "I'm interested" so that the shared talk is on the Interested list. Do not switch on "Share my profile with others interested in this talk" yet; that is step 3.
5. Keep a second screen or printout with the QR code ready, and set the phone's brightness to maximum.
6. Do not create the profile yet. The audience should watch it being made in step 1.

If you made a profile while rehearsing, delete it again (step 1 above) so that the demo starts from "Create my profile".

## The script

Total time: 3:00. Times are the point at which each step should start.

### 1. A person scans the QR code and picks ten topics (0:00 to 0:50)

Say: "Everyone at a conference wants to meet the right people. Scan this and you are in."

- Show the QR code. Scan it with the phone's camera and tap the link. The audience sees the app open on People, headed "People to meet", with a card "Find people worth meeting".
- Tap "Create my profile". The audience sees the Profile screen with "About you".
- Tap Name and type "Sam". Leave About me empty.
- Under "I want to learn about", tap the search box "Find a topic" and type "ebpf"; tap the "eBPF" chip. Type "opentelemetry" and tap "OpenTelemetry". Type "security" and tap "Security". Then tap "Observability" and "Kubernetes" from "Common at this conference". Five chips appear pinned at the top of the set.
- Under "I can speak to", tap "Platform" and "Open Source" from "Common at this conference". Use the search box for "GitOps", then for "Cloud Native" and "AI". That makes ten topics in under a minute; the audience sees every tap add a chip at once, with no modal.
- Say: "No account, no sign-in. The profile lives on this phone."

### 2. People to meet shows a match, with the reason and the opener (0:50 to 1:20)

- Tap People at the bottom. The audience sees "Find people worth meeting" replaced by "Turn on visibility to see who to meet", with the short notice that says what is stored, who sees it and how to undo it. Read the notice's first sentence aloud.
- Tap "Make me visible". The audience sees "Finding people…" and then cards.
- The first card is "Sample · Demo B", with the grey "Sample" badge. Point at the line with the speech icon: "They can speak to eBPF, Observability, OpenTelemetry, and Security, which you want to learn about." That is the opener. Below it is a second reason, "They want to learn about Platform and GitOps, which you can speak to.", and the chips "Can speak to:" and "Wants to learn:".
- Say: "Elasticsearch matched what I want to learn against what they can speak to, and the reverse. The reason names the topic. No model wrote this sentence."
- Scroll once to show the other sample profiles below it, each with the "Sample" badge.

### 3. A talk circle shows who else is interested (1:20 to 1:50)

- Tap Interested at the bottom. The audience sees the one talk marked in the preparation: "Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes", Thursday 12 November, 15:30, Salt Palace, 255 BC. Above the card is a line "2 people want to talk about this".
- Tap the switch "Share my profile with others interested in this talk". Read the one-paragraph notice, then tap "Share my profile".
- Tap "See who's here". The audience sees "Speakers" with Carlos Santana, then "Others who shared": "Sample · Demo A" and "Sample · Demo B", both badged "Sample", each with the reason "You are both interested in Platform-First AI Agent Security: Zero-Trust Patterns for Kubernetes." and, under "How to reach me", the note "Sample profile, not a real person".
- Say: "Only people who chose to share for this talk can see this list. Everyone else gets the count. Sharing for a talk does not make me visible to the whole conference, and the reverse."

### 4. For you shows suggested talks and why (1:50 to 2:20)

- Tap "For you" at the bottom. The audience sees "Talks picked from your topics" and a list of talks.
- Point at the line "Matches:" on the first card, which names the topics it matched (for example eBPF or Observability), and at the highlighted passage under it. If a card shows "N people want to talk about this", point at that too.
- Say: "Ranking is Elasticsearch hybrid search: topic matches and meaning together, fused with reciprocal rank fusion. Talks that have ended, and talks I already marked, are left out."
- Tap "I'm interested" on one suggestion, to show that one tap adds it to the Interested list.

### 5. Airplane mode shows what still works (2:20 to 2:55)

- Swipe down and switch on airplane mode (and make sure Wi-Fi is off). The audience sees the phone's airplane icon.
- Tap Search and type "ebpf". The audience sees the results with the label "Offline: keyword search only". Say: "Offline there is no semantic search, only keywords over the cached schedule, and the app says so."
- Tap Interested. The list is still there, with the shared talk and the one marked in step 4.
- Tap the profile icon at the top right. The profile, with its ten topics, is still there.
- Tap People. The audience sees "Needs a connection": people matching is live data, so it does not pretend to work offline.
- Switch airplane mode off.

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
