# Google Play kit for the native Android app

Everything to enter in Play Console for the native Android app (`native/androidApp`, application id `app.conferencecaddie`, versionName 0.4.0, minSdk 26, targetSdk 36), ready to copy. The answers were derived from the code on 2026-11-12, from the same review as the privacy policy (`scripts/lib/privacy-page.mjs`). When the app or its default server changes what it sends or keeps, update this file, the privacy policy and the Data safety form together.

Addresses used below:

| What | Value |
|---|---|
| Privacy policy | `https://kurtlehnardt.github.io/conferenceCaddie/privacy.html` |
| Account and data deletion | `https://kurtlehnardt.github.io/conferenceCaddie/privacy.html#delete` |
| Website | `https://kurtlehnardt.github.io/conferenceCaddie/` |
| Support email | `<your support email>`: Play requires one and shows it publicly. Use an address you are willing to publish, and set it as the repository variable `CADDIE_PRIVACY_EMAIL` too, so that the privacy page names it as a contact (the Pages workflow reads it; without it the page names only the repository's public issues). A new value takes effect at the next Pages deploy: run the workflow "Deploy the talk bundles to GitHub Pages" by hand after setting it. |
| Developer name | The privacy policy says "we" is the maintainer of KurtLehnardt/conferenceCaddie, publishing under the developer name shown in Play. Nothing to change unless the developer account belongs to someone else. |
| The bundle to upload | The artifact `conference-caddie-native-<commit>-release.aab` of a `Native apps` run on `main` (see [Internal testing](#internal-testing)) |

A fork uses its own application id, Pages address and repository; see `docs/fork/APPS.md`, "Google Play".

## Store listing

Main store listing, language English (United States).

**App name** (30 characters at most; 17):

```
Conference Caddie
```

**Short description** (80 at most; 78):

```
Find the talks and the people worth your time at Linux Foundation conferences.
```

**Full description** (4,000 at most). It claims nothing that is off in the release build: no push notifications, no Bluetooth.

```
Conference Caddie helps you make the most of Linux Foundation conferences such as KubeCon + CloudNativeCon: find the talks you will want to see and the people you will want to talk to.

TALKS, ON YOUR PHONE
• Pick a conference and the app downloads its whole schedule once. After that, talk search works offline.
• Search by meaning, not only by keywords: "debugging slow cluster networking" finds the talks about it even when they use other words. The search model runs on your phone, and your search words never leave it.
• Narrow the results by day, track and level, ask for "day 2 after lunch", or see what is happening now.
• Open a talk to read its abstract, see its speakers and jump to related talks.
• For you suggests talks from the topics you want to learn and the talks you mark as Interested.
• My schedule shows your talks as a list or as a timeline of the day. Import a schedule you exported from a calendar or a spreadsheet to mark its talks in one go.

PEOPLE, IF YOU WANT
• Make a profile with a display name and, if you like, what you want to learn and what you could talk about. There is no account, and no email address or phone number is needed.
• See the other attendees who are also visible at the conference, matched to you by what you want to learn and what they know.
• Say which room or area you are in so that people nearby can find you. If you add your position, others see only a rough band such as "near", never your coordinates; someone you agree to meet sees how far away you are and in which direction.
• Ask someone to talk shop with a short note and a meeting point. Once you both agree, and if you both share your position, each of you sees how far away the other is and in which direction.
• Report or block anyone. Your profile is deleted when the conference ends, and "Delete my profile" removes it at once.

PRIVATE BY DESIGN
• No ads, no analytics, no tracking.
• Open source under the Apache 2.0 license: github.com/KurtLehnardt/conferenceCaddie

Conference Caddie is an independent open-source project. It is not affiliated with or endorsed by the Linux Foundation or the Cloud Native Computing Foundation.
```

**App category:** App, category **Events**. Tags (optional, Play suggests them): Events, Productivity.

**Contact details:** email `<your support email>`; website `https://kurtlehnardt.github.io/conferenceCaddie/`; phone empty.

**Graphics** (in `docs/store/graphics/`, generated from the app icon: the iOS 1024 icon and the glyph of `web/public/icons/icon-maskable-512.png`; the title is set in Liberation Sans, SIL Open Font License):

| Asset | File | Spec |
|---|---|---|
| App icon | `play-icon-512.png` | 512 x 512, 32-bit PNG, a full square (Play adds the rounded mask) |
| Feature graphic | `play-feature-1024x500.png` | 1024 x 500, 24-bit PNG |

**Phone screenshots** (2 to 8; JPEG or 24-bit PNG; each side 320 to 3840 px; the long side at most twice the short side, so 9:16 portrait fits). Captured from the R8 release build (Bluetooth off, as published) on a Pixel 2 emulator (1080 x 1920) at a clean state on KubeCon + CloudNativeCon North America 2026. Upload them in this order:

| # | File | Shows |
|---|---|---|
| 1 | `docs/store/screenshots/android/01-meaning-search.png` | Search by meaning: "debugging Kubernetes networking" finds the right talk, with the matching words highlighted. |
| 2 | `docs/store/screenshots/android/02-talk-detail.png` | A talk: speakers, time, room, track, how many people want to talk about it, and related talks. |
| 3 | `docs/store/screenshots/android/03-for-you.png` | For you suggests upcoming talks like the ones you marked. |
| 4 | `docs/store/screenshots/android/04-schedule.png` | The whole schedule, day by day, with one-tap marking. |
| 5 | `docs/store/screenshots/android/05-my-schedule-day.png` | My schedule's Day view: your talks on a timeline, with a Now line. |
| 6 | `docs/store/screenshots/android/06-filters.png` | Filters by day, morning or afternoon, and track, with live counts. |

All six are 1080 x 1920, 24-bit PNG with no alpha, 92 to 196 KB each. The emulator's clock was set to 09:41 on the conference's last day (12 November 2026), so the talks read as upcoming; the status bar is System UI demo mode. Five talks were marked on the device; no profile was created and nothing was written to the server. The "4 people want to talk about this" line is a count from the live server, with no names.

Tablet screenshots (7 and 10 inch) are optional; without them the app is not featured on tablets but still installs there.

## Privacy policy

App content, Privacy policy: `https://kurtlehnardt.github.io/conferenceCaddie/privacy.html`

It is published by the Pages workflow from `scripts/lib/privacy-page.mjs`. Check that it answers 200 before you submit.

## Ads

App content, Ads: **No, my app does not contain ads.**

The app has no ads SDK and no advertising identifier (`native/gradle/libs.versions.toml`; the merged manifest has no `AD_ID` permission). If Play also asks "Does your app use advertising ID?", answer **No**.

## App access

App content, App access: **All or some functionality is restricted**, with these instructions (no credentials are needed, but the people features need a profile and a current conference, which a reviewer might not find):

```
No login or account is needed. Every feature works without credentials.

Talks: open the app, pick a conference from the list and wait a few seconds while its schedule downloads. Search, Filters, For you and My schedule then work, also offline.

People features (optional): they are offered only for a conference that has not ended yet, so pick a current or upcoming conference from the list. Open People, tap "Create my profile", enter any display name, save, and tap "Make me visible"; no email, phone number or password is involved. The profile is visible only to other attendees who are also visible at that conference, and it is deleted automatically when the conference ends. To remove it at once: People, Profile, "Delete my profile".

Location is optional and only used while the app is open, after the person turns on "Use my position". Bluetooth is not used in this build.
```

## Content rating

App content, Content rating. Start the IARC questionnaire with your support email, category **All Other App Types** (it is a reference tool for conference talks, not a game, a social network or a store). Answers:

| Question | Answer | Why |
|---|---|---|
| Violence, blood, fear | No | Talk schedules only. |
| Sexuality, nudity | No | |
| Language (profanity, crude humour) | No | The app's own text has none. Profiles and notes are written by attendees; spot lines pass a word filter on the server, and two reports hide what was reported. |
| Controlled substances (drugs, alcohol, tobacco) | No | |
| Gambling, simulated gambling | No | |
| Does the app allow users to interact or exchange content with each other? | **Yes** | Visible attendees see each other's profiles and can send a request to talk shop with a short note. |
| Does the app share the user's current physical location with other users? | **Yes** | It never shows a position, but it shows a rough band (same area, near, around, at the venue) and, inside an agreed meeting, the distance and direction to the other person. Answering Yes is the cautious reading. |
| Can users purchase digital goods? | No | |
| Does the app contain unrestricted web access? | No | Links (a talk's official page, a LinkedIn profile) open in the phone's browser; the app has no browser of its own. |
| Is the app a web browser or search engine? | No | It searches its own talk data only. |

Expected result: the lowest age rating in every region (Everyone, PEGI 3, USK 0), with the interactive elements "Users Interact" and "Shares Location".

## Target audience and content

App content, Target audience:

- **Target age groups:** **18 and over** only.
- **Why:** the app is for people attending professional conferences, and its people features show strangers' profiles and let people arrange to meet in person. Choosing only 18 and over keeps the app out of Play's Families programme, whose rules (no precise location, extra review) it is not built for.
- **Could the store listing unintentionally appeal to children?** No.

## Data safety

App content, Data safety. These answers describe the release build on its default server, the tier 3 server named in the privacy policy (`Defaults.BACKEND`). Under Play's definitions:

- **Collected** means sent off the phone; data processed only on the phone is not collected. Talk search, For you and the topics and text given to For you run on the phone and never leave it; the profile's own learn and speak topics are separate and are sent with the profile. The ids of the talks on screen (an opened talk, talk search results, For you suggestions, the marked talks) go to the server for the circle counts without an identifier, and the marked talks go with every people search, with the profile identifier; both are ephemeral.
- **Shared** means given to a third party. Neither our service providers (Google Cloud, Elastic Cloud, GitHub) nor other attendees seeing what a person chose to make visible count as sharing, so nothing is shared.
- **Ephemeral** means held only in memory to answer the request. A schedule file, a people search and a talk's circle count are ephemeral; profiles, presence and positions are stored, if only for minutes to days.

### Overview questions

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | The optional people features send a profile, presence and an optional position to the server. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | HTTPS only; `usesCleartextTraffic="false"` in the release manifest. |
| Which methods of account creation does your app support? | **Other**, described as "An optional people profile, tied to the device by a random identifier and secret; no username, password or sign-in." | A profile is stored on the server under a display name, so it is treated as an account. |
| Delete account URL | `https://kurtlehnardt.github.io/conferenceCaddie/privacy.html#delete` | Explains Delete my profile in the app, automatic deletion after the conference, and how to ask without the app. |
| Do you provide a way for users to request that their data is deleted? | **Yes** | Delete my profile, and the request route on the privacy page. |

If you prefer to answer "My app does not allow users to create an account" (there is no sign-in at all), keep the deletion answers above anyway; the cautious answer is the one in the table.

### Data types

For every type marked collected: **not shared**; purposes **App functionality**, plus **Fraud prevention, security, and compliance** where noted; **optional** unless noted. Every type not listed here is **not collected**.

| Category | Data type | Collected | Ephemeral | Required or optional | Purposes | What and why |
|---|---|---|---|---|---|---|
| Location | Approximate location | No | | | | With only approximate permission the app sends no position. |
| Location | Precise location | **Yes** | No | Optional | App functionality | Only after "Use my position", with precise permission, while the app is open: latitude and longitude with accuracy, rounded to about 1 m and stored with its ~100 m cell until presence ends (60 minutes or the end of the conference day). The cell is still finer than Play's 3 km² threshold for approximate location, so it counts as precise. Never shown to others as coordinates: others see a band derived from the cell, and a meeting partner sees a distance in 10 m steps and a direction. |
| Personal info | Name | **Yes** | No | Optional | App functionality | The profile's display name (any name the person chooses), kept until the conference ends. |
| Personal info | Email address | No | | | | |
| Personal info | User IDs | **Yes** | No | Optional | App functionality; Fraud prevention, security, and compliance | The random profile identifier made on the phone for each server, and a hash of its secret. Reports and blocks store these identifiers. |
| Personal info | Other info | **Yes** | No | Optional | App functionality | The profile's LinkedIn profile address and its "How to reach me" note. |
| Personal info | Address, phone number, race, beliefs, orientation | No | | | | |
| Messages | Other in-app messages | **Yes** | No | Optional | App functionality | A request to talk shop: a note of up to 140 characters, a meeting point and a "how to spot me" line, seen only by the two people; erased when the request or meeting ends (15 or 20 minutes). |
| Messages | Emails, SMS or MMS | No | | | | |
| Photos and videos | | No | | | | |
| Audio | | No | | | | |
| Files and docs | Files and docs | **Yes** | **Yes** | Optional | App functionality | Import my schedule sends the text of a calendar or spreadsheet export the person picks; the server matches it to talks and keeps nothing. |
| Calendar | Calendar events | No | | | | The app never reads the phone's calendars; an imported export is a file the person picks (above). |
| Contacts | | No | | | | |
| App activity | App interactions | **Yes** | **Yes** | Required | App functionality | Circle counts: the ids of the talks on screen (an opened talk, talk search results, For you suggestions, the marked talks), up to 100 per request, with the conference and no identifier, whether or not the person has a profile. People searches and lists: the marked talks (up to 100) with the profile identifier. The server uses them for the answer and keeps nothing. |
| App activity | In-app search history | **Yes** | **Yes** | Optional | App functionality | A people search sends its words (up to 300 characters) with the profile's identifier; they are used for that answer only. Talk search never leaves the phone. |
| App activity | Installed apps | No | | | | |
| App activity | Other user-generated content | **Yes** | No | Optional | App functionality | The profile's free text (about, interests, expertise, topics to learn and speak about), the talks the person shares the profile for, and the presence's room or area and spot line; kept until the conference ends (presence for its 60 minutes or day). |
| App activity | Other actions | **Yes** | No | Optional | App functionality; Fraud prevention, security, and compliance | Blocks (kept until the conference ends), reports (kept until the maintainer has reviewed them, at the latest the cleanup after the conference), and asking, accepting and declining a request to talk shop (minutes; a declined request up to two days without its text). |
| Web browsing | | No | | | | |
| App info and performance | Crash logs, diagnostics, other performance data | No | | | | No crash reporting or analytics SDK; ONNX Runtime's telemetry is removed and switched off. |
| Device or other IDs | | No | | | | No advertising ID, Android ID, hardware identifier or push token. The only identifier is the random profile identifier, declared as User IDs. |
| Financial info, Health and fitness | | No | | | | |

Notes for the reviewer of these answers:

- Server request logs (Google Cloud Run) record IP addresses and user agents for 30 days, and the rate limiter counts recent requests per IP address in memory, dropping an address a few minutes after its last request. Play's form has no data type for IP addresses used only for operating the service; the privacy policy discloses them.
- Reports keep the two random identifiers until the maintainer reviews them; they are covered by User IDs.

### Security practices

- Data is encrypted in transit: **Yes**.
- You can request that data be deleted: **Yes**.
- Independent security review: No. Families policy: not applicable (18 and over).

## Other App content declarations

| Declaration | Answer |
|---|---|
| Government app | No |
| Financial features | My app doesn't provide any financial features |
| Health | My app does not have any health features |
| News app | No |
| COVID-19 contact tracing and status | My app is not a publicly available COVID-19 contact tracing or status app |
| Advertising ID | No |
| Foreground service permissions | Not asked: the release build declares no foreground service. The Bluetooth foreground service (`connectedDevice`) exists only in builds with `-Pcaddie.bleEnabled=true`, which are not published; one would need Play's foreground service declaration and a video. |
| Location permissions | Not asked: no background location (`ACCESS_BACKGROUND_LOCATION` is not declared). |
| Photo and video permissions, exact alarms, full-screen intents | Not used. |

## Permissions

The release build's merged manifest, read from the bundle with `bundletool dump manifest` on 2026-11-12. The Bluetooth permissions and service of `native/androidApp/src/ble/AndroidManifest.xml` are absent, as `checkReleaseBluetoothManifest` enforces on every assemble and bundle.

| Permission | Protection | Why the app has it |
|---|---|---|
| `android.permission.INTERNET` | normal | Downloads the conference list and talk data, and talks to the server for the optional people features. |
| `android.permission.ACCESS_FINE_LOCATION` | dangerous, asked at run time | "Use my position" for presence: the server turns a precise fix into rough bands, and into distance and direction inside an agreed meeting. Asked only when the person turns it on; used only while the app is in use. |
| `android.permission.ACCESS_COARSE_LOCATION` | dangerous, asked at run time | Android 12 and newer require it to be requested together with fine location, and the person may grant only approximate location; the app then sends no position. |
| `android.permission.POST_NOTIFICATIONS` | dangerous, asked at run time (Android 13 and newer) | A notification, made on the phone and naming nobody, when someone the person might want to meet is around while they are visible and present. |
| `app.conferencecaddie.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | signature | Added by AndroidX Core for receivers registered at run time; only the app itself holds it. Not a user-facing permission. |

Hardware: `android.hardware.location` is declared not required, so phones without location hardware can install the app. The manifest removes ONNX Runtime's telemetry provider and its `ACCESS_NETWORK_STATE` permission.

## Internal testing

1. **Create the app.** Play Console, Create app: name `Conference Caddie`, default language English (United States), App, Free, accept the declarations. The application id is fixed by the first upload: `app.conferencecaddie`.
2. **Fill in App content** (Policy and programs, App content) with the sections above: privacy policy, ads, app access, content rating, target audience, data safety and the other declarations. Play shows on the dashboard which of them it needs before a release; closed testing and production need all of them.
3. **Fill in the store listing** (Grow users, Store presence, Main store listing) with the texts, the icon, the feature graphic and the screenshots above.
4. **Get the signed bundle.** In GitHub Actions, open the latest successful `Native apps` run on `main` and download the artifact `conference-caddie-native-<commit>-release.aab` (kept 30 days), or with the GitHub CLI:

   ```sh
   run=$(gh run list --repo KurtLehnardt/conferenceCaddie --workflow native.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run download "$run" --repo KurtLehnardt/conferenceCaddie --pattern 'conference-caddie-native-*-release.aab'
   ```

   Either way the `.aab` arrives inside a zip (from the web page) or a directory named after the artifact (from `gh`); upload the `.aab` file inside it. The sign job's summary names the certificate the bundle was signed with; it must be the upload key, `ANDROID_RELEASE_CERT_SHA256`.
5. **Create the tester list.** Testing, Internal testing, Testers: create an email list and add the Google account email addresses of up to 100 testers. Save.
6. **Create the release.** Internal testing, Create new release. When Play asks about app signing, choose the Google-generated key (Play Console labels it "Use Google-generated key" or "Let Google create and manage my app signing key"; see `docs/fork/APPS.md`, "Play App Signing"). Upload the `.aab`. Play names the release after its version code (1000 plus the workflow run number) and version name 0.4.0; add short release notes, then Next, Save, and **Start rollout to Internal testing**.
7. **Share the opt-in link.** Internal testing, Testers, "How testers join your test": copy the link and send it to the testers. Each tester opens it on the Android phone signed in with a listed Google account, accepts the invitation, and installs Conference Caddie from the Play Store link on that page. Internal releases are usually available within minutes.
8. **Testers who sideloaded the GitHub APK must uninstall it first.** The Play build is signed with Google's app signing key and the GitHub APK with `release.jks`, so neither installs over the other. Uninstalling deletes the app's data on the phone; delete any profile in the app first.
9. **Every new build:** upload the bundle of a newer `main` run (its version code is higher) as a new release on the same track.

After the first upload, Setup, App signing shows the app signing key's certificate. Keep its SHA-256 fingerprint with the upload key's; nothing in the app needs it today.

## Before production

The apps link to the privacy policy from Settings, About, "Privacy policy" (`Strings.Settings.PRIVACY_URL`), as Play's User Data policy asks; the first build that has the link is the one built from this change onwards.

New personal developer accounts must run a **closed test with at least 12 testers who stay opted in for at least 14 consecutive days** before Play lets them apply for production access. Internal testing does not count. Plan a closed testing track (Testing, Closed testing) with 12 or more testers, keep them opted in for 14 days, then apply for production under Dashboard, and answer Play's questions about the test. Organisation accounts are exempt.
