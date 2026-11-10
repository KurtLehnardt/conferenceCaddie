# Conference Caddie for Android

The Android companion is the web app, bundled into a Capacitor shell, plus one native plugin:
**Find people near me by Bluetooth**. Two people who both turned it on, whose expertise and
interests are a strong match, are told when they are within a few metres, with the phone in a
pocket. Everything else is the same app as the web, talking to the same server.

What is where:

| Path | What |
|---|---|
| `web/capacitor.config.ts` | App id `app.conferencecaddie`, name "Conference Caddie", `webDir: dist`, `CapacitorHttp` on. No `server.url`: the app is bundled. |
| `web/android/` | The Gradle project `npx cap add android` generated, with the manifest, Kotlin sources and SDK levels edited. Build outputs, the copied web assets and `local.properties` are git-ignored. |
| `web/android/app/src/main/java/app/conferencecaddie/ble/` | `CaddieBlePlugin.kt` (the Capacitor plugin), `BleService.kt` (the foreground service that advertises and scans), `BleConstants.kt` (the service UUID and limits). |
| `web/src/native.ts` | `isNative()` and the `/api` → `VITE_API_ORIGIN` rewrite, active only inside the app. |
| `web/src/people/ble.ts`, `BleControls.tsx`, `ble.css` | The switch under "I'm around", the token and sightings flow, the one notification, the tap that reveals the card. |
| `server/ble.mjs` | Tokens and `POST /api/presence/sightings`. Routes, fields and the privacy note are in `docs/CONTRACT.md`. |

## What works where

| | Web (browser, PWA) | Android app |
|---|---|---|
| Find people, zones, ask to talk shop, meet, blocks, reports, offline schedule | yes | yes |
| Offline shell (service worker) | yes | not registered; the pages come from the bundle, the saved schedule still works through Cache Storage |
| Find people near me by Bluetooth | no row shown | yes, Android 8.0+ with Bluetooth 5 extended advertising; the row is hidden on a phone without Bluetooth LE and the switch explains itself when the chip cannot send the code |
| Local "right near you" notification | no | yes, one per person per day |

## Build

You need Android Studio (Ladybug or newer, which bundles JDK 21), the Android SDK with platform
36 and build-tools 36 (Capacitor 8's compile SDK), and Node 22. The project targets SDK 34 and
runs on 26 and up; `web/android/variables.gradle` holds those numbers.

1. **Install and build the web app for the app.** The app needs to know where the API lives,
   because its pages are served from the bundle, not from the server:

   ```sh
   cd web
   npm ci
   VITE_API_ORIGIN=https://<your production host> npm run build
   ```

   Without `VITE_API_ORIGIN` the build is the normal web build and the app would call `/api`
   on its own bundle origin, which answers nothing. The variable changes nothing in a web deploy
   and is read only when the app runs natively.

2. **Copy the build into the Android project and refresh the plugin list:**

   ```sh
   npx cap sync android
   ```

   Run this after every web build. It fills `web/android/app/src/main/assets/public` (ignored
   by git) and writes `capacitor.config.json` from `capacitor.config.ts`.

3. **Open in Android Studio:** `npx cap open android`, or open the `web/android` folder. Let
   it sync Gradle; it downloads the Android Gradle Plugin 8.13, Kotlin 2.2.20 and the AndroidX
   libraries named in `variables.gradle`. If Android Studio asks for an SDK location it writes
   `local.properties` (ignored).

4. **Debug build on a phone:** Run ▶ in Android Studio, or from `web/android`:

   ```sh
   ./gradlew assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

   A debug build signs with the debug keystore and installs over USB with developer mode on.

5. **Release build and signing.** Create a keystore once (keep it out of the repo; `*.jks`,
   `*.keystore` and `keystore.properties` are ignored):

   ```sh
   keytool -genkeypair -v -keystore caddie-release.jks -alias caddie -keyalg RSA -keysize 4096 -validity 10000
   ```

   Then either use Android Studio's **Build → Generate Signed App Bundle** with that keystore,
   or add a `signingConfigs.release` block to `web/android/app/build.gradle` that reads a
   `keystore.properties` file (never commit the passwords; the file is ignored) and run
   `./gradlew bundleRelease`. The bundle lands in `app/build/outputs/bundle/release/`.

6. **Play internal testing.** In Play Console create the app with package `app.conferencecaddie`,
   upload the `.aab` to **Testing → Internal testing**, add testers by email or a Google group,
   and share the opt-in link. Fill the Data safety form from the facts in `docs/CONTRACT.md`
   (profile text the person typed and chose to make visible; a random Bluetooth token; no
   location; no advertising id). The declared foreground service type is `connectedDevice`;
   the policy declaration should say it keeps a Bluetooth advertisement and scan running while
   the person has said they are around and has turned the feature on. Google Play may require a
   target SDK above 34 for new uploads; if it does, raise `targetSdkVersion` in
   `web/android/variables.gradle`. Nothing in the plugin depends on 34 specifically.

Every later change to the web app is steps 1 and 2 again, then a new build; the native project
only changes when the plugin or the manifest does.

## Permissions the app asks for

All are requested from the switch, after the first-time notice, with the rationale strings in
`web/android/app/src/main/res/values/strings.xml`:

- Android 12 and later: **Nearby devices** (`BLUETOOTH_SCAN` declared `neverForLocation`,
  `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`).
- Android 8.0 to 11: the legacy Bluetooth permissions plus **Location**, because those versions
  will not scan for Bluetooth without it. No position is ever read.
- Android 13 and later: **Notifications**, for the persistent "Conference Caddie is finding people
  near you" notification (with Stop) and the one "right near you" nudge.
- `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_CONNECTED_DEVICE` are install-time.

## How the Bluetooth part behaves

- The switch is under "Around and up for a conversation" and is enabled only while that is on.
  Off by default; the first tap shows the notice.
- On: the presence write carries `ble: true` and returns a 16-byte token that lives ten minutes.
  The service advertises the fixed service UUID `e52c391c-b926-4856-9a38-d46c3c10c733` with the
  token as service data and scans for the same UUID. Every ten seconds the tokens heard (strongest
  signal each) go to `POST /api/presence/sightings`; the answer is the strong matches within a few
  metres, ranked for this person. The first one not nudged today becomes one notification,
  "Someone who's worked on {evidence} is right near you". Tapping it opens the People tab on
  "Around now" with that card highlighted.
- The app fetches a new token 20 seconds before the old one stops resolving. If the app is closed
  and cannot rotate, the service stops by itself after 11 minutes rather than advertise a dead
  code; it also stops when presence ends, when Bluetooth is turned off, and on Stop.
- Off, or presence off: the service stops and the token is cleared. Presence stays as it was when
  only the Bluetooth switch is turned off.
- The server stores no sightings and logs none. See `docs/CONTRACT.md` for the exact routes and
  the one privacy consequence (a report tells the server which tokens one phone heard, for the
  duration of that request).

## Testing on two phones

Both phones need a visible profile at the same conference, "I'm around" on, and the Bluetooth
switch on. Give one of them expertise text that matches the other's interests specifically (for
example "ran Postgres operators on bare metal for 3 years" against "Postgres operators on bare
metal"); a profile that shares only a top-10 topic such as Kubernetes is a broad match and is never
nudged. Put the phones within two metres: within about 30 seconds each shows the notification.
Move them to opposite ends of a large room: the signal falls below -75 dBm and nothing is said. The
threshold is the server's `BLE_NEAR_RSSI` and can be tuned at the venue without an app update.

## Not verified here

This project was generated and edited in a sandbox without the Android SDK (the download is
blocked), so `./gradlew assembleDebug` has not been run and the Kotlin has not been compiled.
The web build, the typecheck and the server flow against the Elasticsearch stand-in have. The
first Android Studio sync is the place to expect a small fix, most likely in Gradle plugin
versions.
