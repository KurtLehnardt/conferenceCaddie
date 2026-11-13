# App Store kit for the iOS app (stub)

The iOS counterpart of [PLAY.md](PLAY.md), for use once a TestFlight build has been tested (`docs/fork/APPS.md`, "iOS: TestFlight setup"). The app is `native/iosApp` (bundle id `app.conferencecaddie`, version 0.4.0, iOS 16 or newer, iPhone and iPad). The answers were derived from the code on 2026-11-12, as for Google Play; the iOS app sends the same data to the same default server, with two differences noted below.

| What | Value |
|---|---|
| Privacy policy URL | `https://kurtlehnardt.github.io/conferenceCaddie/privacy.html` |
| Support URL | `https://github.com/KurtLehnardt/conferenceCaddie/issues` |
| Marketing URL (optional) | `https://kurtlehnardt.github.io/conferenceCaddie/` |
| Name, subtitle | `Conference Caddie`; subtitle (30 characters at most): `Find talks and people to meet` |
| Category | Primary: Productivity. Secondary (optional): Reference. The App Store has no Events category. |
| Description, keywords | Reuse the full description of [PLAY.md](PLAY.md), "Store listing". Keywords (100 characters at most; other parties' trademarks are left out, as App Review guideline 2.3.7 asks): `conference,schedule,talks,sessions,agenda,networking,open source,cloud native,speakers,events` |

## App Privacy (privacy nutrition labels)

App Store Connect, App Privacy. Apple counts data as collected when it leaves the phone and is kept longer than it takes to answer the request, so the schedule import, people searches and a talk's circle count (processed in memory only) are not collected, and nothing that stays on the phone is. These answers match the app's privacy manifest, `native/iosApp/iosApp/PrivacyInfo.xcprivacy`.

- **Do you or your third-party partners collect data from this app?** Yes.
- **Tracking:** No. The app does not track, has no advertising identifier and no third-party SDK, and `NSPrivacyTracking` is false.

All types below are **linked to the user** (they belong to the person's profile), **not used for tracking**, and used for **App Functionality** only.

| Category | Data type | What |
|---|---|---|
| Contact Info | Name | The profile's display name. |
| Contact Info | Other User Contact Info | The LinkedIn profile address and the "How to reach me" note. |
| Location | Precise Location | Only after "Use my position", while the app is in use (`NSLocationWhenInUseUsageDescription`; no background location). Stored with presence for 60 minutes or the conference day. The ~100 m cell derived from it is still finer than Apple's coarse location, so only Precise is declared. |
| User Content | Other User Content | The profile's free text and topics, the talks shared, the presence's room and spot line, and the notes of requests to talk shop. |
| Identifiers | User ID | The random profile identifier made on the phone for each server. |
| Identifiers | Device ID | The APNs device token. It is sent only when the server offers native push, which the default server does not today; it is declared because the app is built to send it. |

Not collected: Health and Fitness, Financial Info, Sensitive Info, Contacts, Emails or Text Messages, Photos or Videos, Audio, Gameplay Content, Customer Support, Browsing History, Search History, Purchases, Usage Data, Diagnostics, Coarse Location, Email Address, Phone Number, Physical Address, Advertising Data.

## Age rating

App Store Connect, Age Ratings. Answer **None** or **No** for every content item (violence, sexual content, profanity, drugs, alcohol and tobacco, gambling, horror, medical, mature themes, contests), and:

- Unrestricted web access: **No** (links open in Safari).
- User-generated content: **Yes** (profiles and notes, with reporting and blocking in the app).
- Messaging and chat: **Yes** (short notes in requests to talk shop between two attendees; there is no free chat).
- Advertising: **No**.

Apple computes the rating from these answers.

## App Review notes

App Store Connect, App Review Information. Sign-in required: **No**. Notes:

```
No login or account is needed.

Talks: pick a conference from the list and wait a few seconds while its schedule downloads. Search, Filters, For you and My schedule then work, also offline. Search runs on the device with a bundled model.

People features (optional) are offered only for a conference that has not ended yet, so pick a current or upcoming conference. Open People, tap "Create my profile", enter any display name, save, and tap "Make me visible". The profile is visible only to other attendees who are visible at the same conference, it is deleted automatically when the conference ends, and People, Profile, "Delete my profile" deletes it at once.

Location: used only while the app is in use, only after the person turns on "Use my position", to show other attendees a rough distance band. It is never shown as a position.

Notifications: the app may ask for permission to show notifications about people to meet. The default server does not send push notifications.

Bluetooth: the Bluetooth feature is switched off in this build; the app does not use Bluetooth.

Encryption: the app uses only HTTPS (ITSAppUsesNonExemptEncryption is false).
```

Contact information for App Review (name, phone, email) is required and is not public; fill it in yourself.

## Screenshots

App Store Connect needs screenshots for the largest iPhone size, and for the largest iPad size because the app runs on iPad (`TARGETED_DEVICE_FAMILY = "1,2"`); smaller sizes are scaled from them. PNG or JPEG, no transparency, 1 to 10 per size.

| Display | Device to capture on (simulator) | Portrait pixels |
|---|---|---|
| iPhone 6.9" (required) | iPhone 16 Pro Max or 17 Pro Max | 1320 x 2868 (also accepted: 1290 x 2796, 1260 x 2736) |
| iPhone 6.5" (needed only without 6.9") | iPhone 11 Pro Max or XS Max | 1242 x 2688 (also 1284 x 2778) |
| iPad 13" (required while the app supports iPad) | iPad Pro 13-inch (M4) | 2064 x 2752 (also 2048 x 2732) |

Use the same six screens as for Google Play ([PLAY.md](PLAY.md), "Store listing"), from a Release build on the simulator at a clean state on a current conference. TODO: capture them after the first TestFlight build.

## Before submitting

- The Release `Info.plist` still contains `NSBluetoothAlwaysUsageDescription` although Bluetooth is off in Release builds. App Review may ask about it; the review note above answers it, and removing the key from Release builds (as the background modes already are) avoids the question.
- Check the privacy policy URL answers 200, and that it still matches the build (`scripts/lib/privacy-page.mjs`). The app links to it from Settings, About, "Privacy policy", as guideline 5.1.1(i) asks.
