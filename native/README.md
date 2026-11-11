# Conference Caddie native apps

This directory holds the native Android and iOS apps: a Kotlin Multiplatform core shared by both
platforms, with the UI written once in Compose Multiplatform. The UI follows the web app's design
(see Design system below). Phase 2a gives the apps the talk features of the plan: they read a
backend's capabilities, download its talk bundles, and search, filter and keep talks on the device,
offline too (see Talk features below). Phase 2b adds meaning-based search, For you and the topic
picker, all on the device with the bge-small-en-v1.5 model through ONNX Runtime. Phase 2c adds the
web's schedule views (the full schedule on the Search tab and My schedule's Day timeline), the
Interested options, Import my schedule, and `caddie://` links. People appears only on backends that
serve people features (phase 3). The
Capacitor app in `web/android` is still the Android app people use today. The design and the phases
these apps follow are in [`docs/NATIVE_PLAN.md`](../docs/NATIVE_PLAN.md).

## Layout

| Path | What it is |
|---|---|
| `shared/` | Kotlin Multiplatform library with no UI: the capabilities client (`Capabilities`, `CapabilitiesDiscovery`, `ConnectLink`, `BackendUrl`), the talk bundle client (`bundle/`: the index reader, verification, SHA-256, canonical JSON, the bundle cache and the downloader), the SQLite store (`db/`), search (`search/`: FTS5 and meaning fused by reciprocal rank fusion, filters, facets, time phrases, suggestions, evidence, For you and the topic lists), the query embedder (`embed/`: the WordPiece tokenizer, `BgeEmbedder` and ONNX Runtime, through its Java API on Android and the JVM, `src/ortJava`, and its C API on iOS, `src/nativeInterop/cinterop/onnxruntime.def`), the schedule import (`importer/`: the Worker's parser and matcher ported to common Kotlin, and the client of a backend's import route), the `caddie://` link parser (`AppLink`), `core/CaddieCore`, which ties them together for the screens, and the platform interfaces `Embedder`, `BleRadio`, `Notifier` and `SecureStore`. Its tests in `commonTest` run on the JVM and on the iOS simulator; `fixtures/` holds the reference query vectors and `scripts/` the generators of the test fixtures. |
| `composeApp/` | Compose Multiplatform UI: the theme, icons, components and copy of the design system, `App()`, the web app's shell (see Design system), and the talk screens in `ui/talks` (`CaddieApp`, For you, the topic picker, Search with Why this rank, the full schedule, the Filters sheet, the talk sheet, My schedule with its Day timeline, and Import my schedule). `ui/platform` holds what the hosts provide (the file picker and the share sheet, `PlatformActions`) and the hand-off of links and files from the platforms (`IncomingHandoff`). The query model and its vocabulary are its Compose resources. On iOS this module is built as the `ComposeApp` framework, which also exports `shared`. Its UI tests in `commonTest` run on the iOS simulator and on Android devices. |
| `androidApp/` | The Android application: `MainActivity` hosts `CaddieApp`, receives `caddie://` links and schedule files, and opens the file picker and the share sheet. Its instrumented smoke test is in `src/androidTest`. |
| `iosApp/` | The Xcode project. A SwiftUI entry point hosts `App()` through `ComposeUIViewController` and hands the URLs the system opens it with to the shared code, and a build phase runs Gradle to build and embed the framework. |
| `gradle/libs.versions.toml` | Every dependency version, with the reasons for the choices. |
| `scripts/generate-app-icons.py` | Makes the app icons and the iOS launch image from the web app's icons. |
| `licenses/` | Licence texts of third-party material the apps ship: the lucide icons, the Apache 2.0 libraries, and the native code Skiko bundles into the iOS app (Skia, HarfBuzz, ICU and others). |
| `scripts/third-party-notices.py` | Generates the notices Settings shows from the dependency graph and `licenses/`, and checks them in CI. |
| `scripts/release-smoke.sh` | Starts the R8 release build on a device or emulator and checks it runs. |

The structure follows the official JetBrains template for Android Gradle Plugin 9, where the
Android application must be its own module and Kotlin Multiplatform modules use the
`com.android.kotlin.multiplatform.library` plugin.

## Versions

| Tool | Version |
|---|---|
| Kotlin | 2.4.21 |
| Compose Multiplatform | 1.12.2 (Material3 1.12.0-alpha03, Lifecycle 2.11.0) |
| Android Gradle Plugin | 9.3.3 |
| Gradle (wrapper) | 9.7.1 |
| kotlinx.serialization / kotlinx.coroutines | 1.12.0 / 1.11.0 |
| ONNX Runtime | 1.30.0 (Android, iOS and the JVM tests) |
| Android | minSdk 26, targetSdk 36, compileSdk 37 |
| iOS | deployment target 16.0; arm64 devices and arm64 simulators |

- AGP 9.5.1 is newer, but Kotlin 2.4.21 is documented as compatible with AGP only up to 9.3, so
  the build stays on 9.3.3.
- compileSdk is 37 because Compose 1.12 refuses to build against 36. targetSdk stays at 36.
- minSdk 26 (Android 8.0) is the first version with the Bluetooth 5 extended advertising API
  that the "near me" feature uses. The Capacitor app has the same floor.
- There is no `iosX64` target. Compose Multiplatform 1.12 publishes no x86_64 simulator
  libraries, and Xcode 27 runs only on Apple silicon.

## What you need

- JDK 17 or newer. The project is built with JDK 21.
- The Android SDK with platform 37 (`platforms;android-37.0`) and build-tools 36. Point Gradle at
  it with `ANDROID_HOME` or a `local.properties` file containing `sdk.dir=...`, which git ignores.
- For iOS: a Mac with Xcode 26 or newer. The first iOS build downloads Kotlin/Native and its
  dependencies (about 2 GB) into `~/.konan`.

## Build and run on Android

From `native/`:

```sh
./gradlew :shared:allTests              # shared tests on the JVM (and on the iOS simulator on a Mac)
./gradlew :androidApp:assembleDebug     # androidApp/build/outputs/apk/debug/androidApp-<abi>-debug.apk
./gradlew :androidApp:installDebug      # installs on a connected phone or a running emulator
./gradlew :composeApp:connectedAndroidDeviceTest   # the Compose UI tests and the model measurement on a phone or emulator
./gradlew :androidApp:connectedDebugAndroidTest    # the app's instrumented smoke test
./gradlew :androidApp:assembleRelease && scripts/release-smoke.sh   # the R8 release build, started on the device
./gradlew :shared:smokeTalks -Pcaddie.smokeSite=<dir>   # the talk checks of scripts/smoke.mjs (see Talk features)
```

With more than one device connected, pick one with `ANDROID_SERIAL=emulator-5554`. The iOS
simulator tests (`:shared:allTests` and `:composeApp:iosSimulatorArm64Test` on a Mac) run on the
Kotlin plugin's default simulator; `-Pcaddie.iosTestDevice=<name or UDID>` picks another one.

You can also open `native/` in Android Studio and run the `androidApp` configuration.

The build makes one APK per ABI, `androidApp-arm64-v8a-*.apk` for phones and `androidApp-x86_64-*.apk`
for emulators and Chromebooks, because ONNX Runtime's native library is 23 to 39 MB per ABI. With
the 34 MB query model the arm64-v8a release APK is about 40 MB; it is the one CI signs and the one
published on GitHub Releases. There is no universal APK and no 32-bit build. `installDebug` and the
connected tests pick the APK of the device's ABI.

Release builds run R8 (code shrinking and resource shrinking). Compose, AndroidX and
kotlinx.serialization bring their own keep rules; app-specific rules go in
`androidApp/proguard-rules.pro`, which keeps ONNX Runtime's Java API for its JNI code. Check a
release build on a device after adding anything that uses reflection: `scripts/release-smoke.sh`
installs the release build of the device's ABI (signed with the debug key when no release key is
set), checks the installed package for ONNX Runtime's telemetry provider and the network-state
permission, starts it, opens Settings, and searches for letters that are in no talk, which only the
query model can answer, so the model must load and run under R8. The search uses the official server
and the published bundles, so the device needs a connection. CI runs it on the emulator.

The native app uses the same application id as the Capacitor app, `app.conferencecaddie`. A phone
cannot have both installed at once. Installing a debug build over a release build, or the other way
round, fails because the two are signed with different keys. Uninstall the other one first.

## Design system

The native apps look like the web app (`web/src`): same colours, type, spacing, icons, components
and words. Everything lives in `composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/`:

| Package | What it holds |
|---|---|
| `theme` | `CaddieTheme`: the web's design tokens from `web/src/styles.css` (`CaddieColors` for light and dark, `CaddieDimens`, `CaddieType`), provided as `Caddie.colors`, `Caddie.dimens` and `Caddie.type` and mapped onto Material 3. Dark mode follows the system unless the Theme setting says Light or Dark, as on the web. |
| `icons` | `LucideIcon`: every lucide icon the web app uses, generated from the `lucide-preact` package by `composeApp/scripts/generate-lucide-icons.mjs`, drawn by `LucideIcon.vector()` with the web's stroke widths. |
| `components` | The web's components: `AppBar`, `SwitcherButton`, `NavBar`, `CaddieButton`, `CaddieIconButton`, `CaddieChip` (toggle, dropdown and action chips), `FiltersChip`, `TimePhraseChip`, `SuggestionChip`, `ChipRow`, `SearchField`, `TalkCard`, `InterestedToggle`, `CaddieSheet`, `ConfirmDialog`, `Segmented`, `SwitchRow`, `OptionRow`, the settings rows, `StateView`, `ErrorBanner`, `Toast`, `OfflineBadge`, `NeedsConnection` and `SkeletonCard`. |
| `strings` | `Strings`: the web's copy word for word, grouped by the web file it comes from. Copy that only the native apps need is marked "native only". |
| `format` | `Format`: dates and times written as `web/src/lib/time.ts` writes them. |
| `shell` | `App()`'s parts: `ShellState`, `ShellActions` and `TabContent`, the Settings screen, the conference switcher and the server confirmation. `StandaloneShell` runs the shell without a backend until the talk features replace it. |

`App(state, actions, content)` is the web's shell: the conference switcher in the app bar, the
Offline badge and the Settings gear on its right, and the tab bar People (only when the backend
serves people features), For you, Search and Interested. Settings is a screen of its own with Back,
as on the web. The caller owns the data (`ShellState`), answers `ShellActions`, and supplies each
tab's screen through `TabContent`; tab content reaches the shell through `LocalShellNavigator`.

In a window at least 768 dp wide (a tablet, or a phone in landscape) the shell takes the web's wide
layout: the tabs move to a rail on the left with the app icon on top, the app bar and the screen stay
in a column at most 720 dp wide, centred, and chip rows wrap instead of scrolling. Every part of the
shell keeps clear of the status bar, the navigation bar, the display cutout and, on screens with a
text field, the keyboard, in portrait and in landscape.

Every size of text is in sp, so the system font size setting scales it, and controls grow with it:
dialogs scroll their text and keep their buttons on screen, and tab labels shrink back towards their
default size rather than wrap or be cut off. Controls keep the web's visible sizes (buttons and icon
buttons 44 dp, chips 36 dp), and every control's touch target is at least the platform's minimum, 48
dp on Android and 44 pt on iOS, through Material's `minimumInteractiveComponentSize()`. Icons that
carry meaning have content descriptions, headings are marked as headings, and controls have keyboard
focus rings like the web's.

The web app sets no font of its own: its stack (`system-ui, -apple-system, ..., Roboto, ...`) is San
Francisco on iPhones and Roboto on Android phones, which is what Compose's default font family
draws, so no font is bundled. The lucide icons are ISC-licensed (MIT for those that came from
Feather); `licenses/lucide.txt` holds the text. Settings shows it under Open-source licences with
every third-party licence the apps ship: the Apache 2.0 libraries (Kotlin, Compose, AndroidX and
the rest), each listed with its version and platform, and the native code that Skiko links into the
iOS app (Skia, HarfBuzz, ICU, libpng, libjpeg-turbo, libwebp, zlib, Expat, Wuffs and the Adobe DNG
SDK). `scripts/third-party-notices.py` generates that list from the Android release classpath and
the iOS klibs; run it after changing dependencies. It fails on a dependency whose group is not in
its licence table, on a new artifact in the broad AndroidX, `org.jetbrains` and kotlinx groups, or on
a new Skiko version, until someone has checked the licence.

The app icons and the iOS launch image come from `web/public/icons` through
`scripts/generate-app-icons.py` (Pillow). Both apps open on the web's page colour, light or dark.

Debug builds take launch options that open a screen directly, for screenshots and manual checks:
`-caddie.tab Search`, `-caddie.open settings` (or `switcher`), `-caddie.theme dark`,
`-caddie.connect https://example.org` and `-caddie.gallery 1` (the Search components drawn with the
web's sample talk); the talk screens add theirs (Trying the talk features against local bundles),
among them `-caddie.link <caddie:// link>`, which hands a link over as the platform would. On iOS they are launch arguments
(`xcrun simctl launch <device> app.conferencecaddie -caddie.tab Search`); on Android they are intent
extras (`adb shell am start -n app.conferencecaddie/.MainActivity -e caddie.tab Search`). Release
builds ignore them. `-caddie.connect` follows the rules of a `caddie://connect` link: the address is
normalised, and anything a link could not name (not https, credentials, a query) is ignored.

On iOS a Light or Dark Theme setting is applied to the app's window, so the status bar, the SwiftUI
host and anything presented from it follow it too.

## Build and run on iOS

Open `native/iosApp/iosApp.xcodeproj` in Xcode, pick a simulator, and press Run. The "Compile
Kotlin Framework" build phase runs `./gradlew :composeApp:embedAndSignAppleFrameworkForXcode`, so
Gradle needs to find a JDK. From the command line:

```sh
xcodebuild -project native/iosApp/iosApp.xcodeproj -scheme iosApp \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Simulator builds need no signing. To run on a device, copy
`iosApp/Configuration/Local.xcconfig.example` to `iosApp/Configuration/Local.xcconfig` and set
`TEAM_ID` to your Apple team id. Git ignores that file, so no team id is ever committed. The bundle
id is `app.conferencecaddie`, set in `iosApp/Configuration/Config.xcconfig`.

## Signing

### Android

A local release build is signed with the project's release key when these four environment
variables are all set. When none is set, it falls back to the debug key and Gradle prints a
warning. When only some are set, the build stops and names the missing ones.

| Variable | Meaning |
|---|---|
| `ANDROID_KEYSTORE_FILE` | Path to the keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias (`conference-caddie`) |
| `ANDROID_KEY_PASSWORD` | Key password |

Keep the keystore and its passwords out of the repository; both `.gitignore` files exclude `*.jks`,
`*.keystore`, `*.p8` and `*.p12`. Build signed releases with `--no-configuration-cache`, so the
passwords are not written into Gradle's configuration cache.

The maintainer's keystore lives outside the repository, and its passwords are in the macOS
Keychain under the services `conference-caddie-android-keystore` and
`conference-caddie-android-key`. The key is PKCS12, so the key password is the same as the
keystore password. A local signed build reads them inside one shell, without printing them:

```sh
(
  export ANDROID_KEYSTORE_FILE="$HOME/.config/conference-caddie/release.jks"
  export ANDROID_KEYSTORE_PASSWORD="$(security find-generic-password -a conference-caddie -s conference-caddie-android-keystore -w)"
  export ANDROID_KEY_PASSWORD="$(security find-generic-password -a conference-caddie -s conference-caddie-android-key -w)"
  export ANDROID_KEY_ALIAS=conference-caddie
  ./gradlew --no-configuration-cache :androidApp:assembleRelease
)
```

**In CI, Gradle never sees the key.** The build job runs `assembleRelease` with
`-Pcaddie.unsignedRelease=true` on every run, pull requests included, so R8 and resource shrinking
are checked before `main`. On `main` it keeps the unsigned arm64-v8a APK for one day, named
`conference-caddie-native-<commit>-release.apk`, and a separate job signs it. That job checks out no code and runs no Gradle or npm; it refuses an APK whose name is not the
release APK of the commit being built, decodes the keystore into the runner's
temp directory with `umask 077`, runs `zipalign` and `apksigner` from the runner's Android SDK,
deletes the keystore, and fails unless the APK's certificate matches the repository variable
`ANDROID_RELEASE_CERT_SHA256` (the public fingerprint
`15:02:52:89:3C:0B:24:01:9C:1C:24:68:CD:BB:3A:CA:A7:FC:79:33:68:35:34:54:38:FD:09:47:E0:D5:7C:7B`).

The signing jobs use the GitHub environment `release`, which only `main` may deploy to, and the
secrets live in that environment, not in the repository:

- `ANDROID_KEYSTORE_BASE64`: the keystore file, base64-encoded.
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The Capacitor workflow (`.github/workflows/android-apk.yml`) signs its release APK the same way,
with the same key, on a manual run on `main`. Both apps share the application id, so once every
release is signed with this one key, the native app can later be installed as an update over the
Capacitor app.

Keep a backup of the keystore somewhere safe. If it is lost, no future build can update the
installed apps.

### iOS and TestFlight

TestFlight builds run on pushes to `main` and manual runs on `main`, and only when all seven
secrets below are set in the `release` environment. **The jobs are split so signing never runs
next to Gradle**: Gradle and its plugins never run in a job that holds a secret, and each secret is
on a runner only in the job that needs it. In `.github/workflows/native.yml`:

1. `ios-release-build` has no secrets. It archives the Release configuration without signing,
   which runs the "Compile Kotlin Framework" build phase and so Gradle with the archive's own Xcode
   settings, keeps the Release device framework and the Compose resources for one day, and stops
   the Gradle daemon.
2. `ios-sign` (environment `release`) sets up no Java, Gradle or Kotlin/Native and deletes the
   Gradle wrapper. It installs the Apple Distribution certificate into a temporary keychain, usable
   by `/usr/bin/codesign` only, and the App Store profile for `app.conferencecaddie`. It archives
   with manual signing and `OVERRIDE_KOTLIN_BUILD_IDE_SUPPORTED=YES`, which makes the build phase
   skip Gradle and copy the prebuilt Compose resources instead, links the prebuilt framework, and
   exports a signed IPA (`iosApp/ExportOptions.plist` sets the destination to export, so nothing is
   uploaded). It removes the keychain and the profile whatever happened and keeps the IPA for one
   day.
3. `testflight-upload` (environment `release`) checks out nothing. It writes the App Store Connect
   API key with `umask 077`, uploads the IPA with `xcrun altool --upload-package`, and deletes the key
   whatever happened.

| Secret (environment `release`) | Used by | What it is |
|---|---|---|
| `IOS_DIST_CERT_P12_BASE64` | `ios-sign` | The Apple Distribution certificate and its private key, exported from Keychain Access as `.p12`, base64-encoded |
| `IOS_DIST_CERT_PASSWORD` | `ios-sign` | The password chosen for that `.p12` |
| `IOS_APPSTORE_PROFILE_BASE64` | `ios-sign` | An App Store provisioning profile for `app.conferencecaddie`, base64-encoded |
| `APPLE_TEAM_ID` | `ios-sign` | The Apple Developer team id |
| `ASC_KEY_ID` | `testflight-upload` | The App Store Connect API key id |
| `ASC_ISSUER_ID` | `testflight-upload` | The issuer id shown above the API keys list |
| `ASC_KEY_P8_BASE64` | `testflight-upload` | The downloaded `AuthKey_<id>.p8` file, base64-encoded |

The job `testflight-gate` reads whether all seven exist; when one is missing, the three jobs are
skipped with a notice.

Before the first upload, register the bundle id `app.conferencecaddie`, create the distribution
certificate and the App Store profile in the Apple Developer account, create the app in App Store
Connect, and create a team API key with the App Manager role (Users and Access, then
Integrations). Upload the secrets with stdin, for example
`base64 -i dist.p12 | gh secret set IOS_DIST_CERT_P12_BASE64 --env release`.

**These jobs have not run yet**, because the secrets do not exist. Expect the first run on `main`
to need attention; the signing settings `ios-sign` passes are `CODE_SIGN_STYLE=Manual`,
`CODE_SIGN_IDENTITY="Apple Distribution"` and the profile's UUID as
`PROVISIONING_PROFILE_SPECIFIER`. If signing fails with `errSecInternalComponent`, the key's
partition list (`apple:`) or trusted tools (`/usr/bin/codesign`) are too narrow for the tool the
log names. The upload uses `xcrun altool --upload-package <ipa> --api-key --api-issuer`, which the
help of altool in Xcode 26.4 and 27.1 gives for an IPA; if the runner's Xcode refuses it, the older
form is `xcrun altool --upload-app -f <ipa> -t ios --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID"`.

What the maintainer adds before the first TestFlight build (checked against `native.yml` in phase
2c; the Android signing secrets and the variable `ANDROID_RELEASE_CERT_SHA256` already exist, since
the APK sign job runs on `main`):

1. In the Apple Developer account: the bundle id `app.conferencecaddie`, an Apple Distribution
   certificate, and an App Store provisioning profile for the bundle id with that certificate.
2. In App Store Connect: the app, and a team API key with the App Manager role.
3. In the GitHub environment `release`, these seven secrets, exactly so named:
   `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_APPSTORE_PROFILE_BASE64`,
   `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8_BASE64`.

The next push to `main` (or a manual run on `main`) then archives, signs and uploads.

The build path `ios-sign` uses can be tried locally without signing. Archive once the normal way,
which leaves the framework in `composeApp/build/xcode-frameworks/Release/iphoneos<version>/` and
the resources in the archived app's `compose-resources` folder:

```sh
xcodebuild -project iosApp/iosApp.xcodeproj -scheme iosApp -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /tmp/unsigned.xcarchive \
  CODE_SIGNING_ALLOWED=NO archive
```

Then, in a copy of `native/` without `gradlew` or any `build` folder, archive again with those two
folders; the log says the build phase skipped Gradle:

```sh
xcodebuild -project iosApp/iosApp.xcodeproj -scheme iosApp -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /tmp/prebuilt.xcarchive \
  OVERRIDE_KOTLIN_BUILD_IDE_SUPPORTED=YES FRAMEWORK_SEARCH_PATHS=<folder with ComposeApp.framework> \
  CADDIE_PREBUILT_COMPOSE_RESOURCES=<compose-resources folder> CODE_SIGNING_ALLOWED=NO archive
```

`Info.plist` declares `ITSAppUsesNonExemptEncryption` as false, which is true of the skeleton (it
uses only the system's HTTPS). Review it in Phase 4, when the Bluetooth tokens add HMAC-based token
derivation, before the first upload that includes it.

## Version numbers

CI builds get Android `versionCode` and iOS `CURRENT_PROJECT_VERSION` of 1000 plus the workflow run
number, which keeps every native build above the Capacitor app's `versionCode` (1). Local builds
use 1. Re-running a workflow run reuses its run number: the APK then has the same version code as
before, and App Store Connect refuses the upload as a duplicate build. To publish a new build,
start a new run instead of re-running an old one.

## Pointing the app at a backend

The Server URL field in Settings follows the backend URL rules of the capabilities contract
(`docs/contracts/capabilities.md`, `normaliseBackendUrl()` in `contracts/js/capabilities.mjs`),
implemented in `shared` as `BackendUrl.normalise()`:

- Only `https` is accepted, with no user name or password, query or fragment. The host is
  lowercased, the default port dropped, and the path kept without trailing slashes, because a
  tier 1 site lives under `/<repo>`.
- Debug builds also accept plain `http` to `localhost`, `127.0.0.1`, `[::1]` and `10.0.2.2` (the
  host machine as the Android emulator sees it). The Android debug build allows cleartext to those
  hosts in `androidApp/src/debug/res/xml/network_security_config.xml`; release builds set
  `usesCleartextTraffic="false"`. iOS has no exception yet, so App Transport Security still blocks
  plain `http` there.
- The result has a `base` (what the app calls, and the key for everything stored per backend, as
  `SecureStore.scopedKey()` builds it) and an `origin` (scheme, host and port).
- The parser is stricter than the reference implementation in a few places, listed in
  `BackendUrl.kt`: it refuses backslashes, IPv4 shorthand and other inputs that a WHATWG parser
  quietly repairs.

Decision 6 in `docs/NATIVE_PLAN.md` makes the live tier 3 server the default backend in builds, so
the Server URL field starts with it. When it cannot be reached and nothing is cached, the app falls
back to the tier 1 demo on GitHub Pages for talk features. A server typed in Settings, like one from a
`caddie://connect` link, is switched to only after a confirmation that names its base URL exactly
and warns when it is not the official server. The People tab shows only when the capabilities enable
people features; the Compose UI tests check that gating. Until the capabilities are known the shell
shows the first tab it has, and an untouched shell moves to People when it appears; a tab the person
picked stays picked.

## Links

Both apps register the `caddie` scheme (Android: an intent filter on `MainActivity`, which is
`singleTask` so a link reaches the running app; iOS: `CFBundleURLTypes`, handled by SwiftUI's
`onOpenURL`). `AppLink` in `shared` parses what arrives; everything in a link is untrusted:

- `caddie://connect?url=<backend, percent-encoded>`, an operator's link or the QR code that holds
  one, only ever opens the confirmation that names the server. It must be https, with no debug
  exception, and the switch it confirms never gets the local http exception a typed server has.
  The phones' camera apps open the link in a QR code, so the apps have no scanner of their own.
- `caddie://e/<slug>`, optionally with `#/<tab>` and `?view=<view>&day=<YYYY-MM-DD>` after the tab,
  is the web's route (`web/src/lib/route.ts`) with `caddie://` in place of the web's origin:
  `caddie://e/kubecon-cloudnativecon-north-america-2026#/search?view=schedule&day=2026-11-11` opens
  that day of the full schedule, and `#/interested?view=day` My schedule's Day view. The slug must
  be a bundle slug the backend lists (otherwise the app says the conference is not available here
  and changes nothing); an unknown tab, a view that does not fit its tab and a day that is not a
  date are dropped. The people routes (`here`, `inbox`, `meet`, `profile`) open the People tab.
- Anything else, and any link longer than 2,048 characters, is ignored.

There are no https App Links or Universal Links (`DECISIONS.md`, phase 2c): they need files at the
root of a domain the project serves the web app from, which no free host the project uses offers.

Try a link on a device or simulator:

```sh
adb shell am start -a android.intent.action.VIEW -d "'caddie://e/kubecon-cloudnativecon-north-america-2026#/search?view=schedule'"
xcrun simctl openurl booted "caddie://connect?url=https%3A%2F%2Fkurtlehnardt.github.io%2FconferenceCaddie"
```

## Talk features

- **Capabilities.** `CapabilitiesDiscovery` asks `{base}/api/capabilities`, then
  `{base}/capabilities.json`, and probes `/api/health` for the legacy server only after the exact
  404 answer and only for a backend that has never served a document. `Capabilities.effective()`
  applies the contract's consumer rules, and `forThisApp()` filters out what this app does not
  implement yet (`server-rotate` Bluetooth, client-side people vectors). The last good document and
  the "has served a document" mark are kept per backend base in the database.
- **Bundles.** `BundleSync` reads `{bundle_base}conferences.json` entry by entry (with
  `If-None-Match`), downloads exactly `bundle.json` and `vectors.i8` of the selected conference,
  verifies them as `verifyBundle()` does, decodes them strictly, stores them under
  `bundles/{backend key}/{content hash}/` in the app's files, and installs them in SQLite in one
  transaction; the previous bundle stays in use until the new one passes. Whatever is stored shows
  at once at start, before any request, and is fetched again behind it: the capabilities at every
  start and when older than their `max-age` (an hour without one), the conference list at most
  every 15 minutes in the foreground. With no network, the last good list and bundle are used, and
  the app shows the web's Offline badge. Settings shows the space the saved schedules take and can
  clear them; the Interested lists stay, each marked talk with a copy of its schedule fields, so
  My schedule still shows a talk a newer bundle drops.
- **Search.** Keyword search runs on SQLite FTS5 (Porter stemmer) with the server's filters, facet
  counts, time phrases ("tuesday afternoon", "after lunch day 2"), Happening now and "Did you mean"
  chips. `DECISIONS.md` (Native apps phase 2a) lists where it differs from the server.
- **Meaning.** A text search also embeds the query on the device and takes the 50 talks nearest to it
  by cosine over the bundle's int8 vectors, then fuses that list with the keyword list by reciprocal
  rank fusion (rank window 50, rank constant 60), as the server's rrf retriever does. Each result has
  Why this rank with its fused, keyword and meaning places and the filters applied. Until the model is
  loaded, and if it cannot be, search is keyword search alone; once it has failed, results say so.
- **For you and the topic picker.** For you ports the server's recommendations (learn topics and the
  learn text, fused; never ended or marked talks) and adds the talks nearest to the ones the person
  marked. What the person wants to learn is kept on the device, per conference, and edited in the
  web's topic picker in a sheet. Related talks are the bundle's lists, each with its official link.
- **The query model.** `BAAI/bge-small-en-v1.5`, the int8 `onnx/model_quantized.onnx` of the
  `Xenova/bge-small-en-v1.5` revision that `scripts/lib/embedder.mjs` pins, ships in the app with its
  `vocab.txt` (34 MB in all). The build downloads both, and ONNX Runtime's iOS archive, from the URLs
  in `gradle/pinned-downloads.properties` and refuses a file whose size or SHA-256 differs; the
  verified files are kept in Gradle's user home under `caches/caddie-pinned`. Queries follow the
  contract's embedding conventions (CLS pooling, L2 normalisation, the retrieval instruction), with a
  WordPiece tokenizer in common Kotlin that matches transformers.js. `DECISIONS.md` (Native apps phase
  2b) has the measurements and the reasons.
- **No telemetry from ONNX Runtime.** ONNX Runtime 1.30 would upload usage events to Microsoft on
  Android and iOS. The apps set `ORT_DISABLE_TELEMETRY` first thing at start, on the main thread
  (`CaddieApplication.onCreate`, `MainViewController`), and every session turns telemetry events off;
  the Android manifest also removes the AAR's telemetry provider and the network-state permission it
  adds. `openEncoder` is the only code that may call ONNX Runtime (`scripts/check-onnxruntime-entry.sh`
  fails on any other use), the `check<Variant>OnnxRuntimeManifest` task fails a build whose merged
  manifest has the provider or the permission, and the release smoke test checks the installed
  package. Keep all of this when ONNX Runtime is updated.
- **The model loads when it is needed.** The core loads the model on the first text search (or For
  you with learn text), tries again after a failure once a pause has passed, and closes it when the
  system asks for memory; the next text search loads it again.
- **The smoke checks.** `TalkSmokeTest` runs the talk checks of `scripts/smoke.mjs` against the shared
  search, For you and topic lists with the real model, over bundles built from `main`'s data, and
  prints a PASS, FAIL or N/A line per check (the report is also written to
  `shared/build/reports/smoke-talks.txt`):

  ```sh
  npm --prefix tools/bundles ci --ignore-scripts
  node scripts/build-bundles.mjs --out /tmp/site --base-url https://127.0.0.1:8701/bundles/ \
    --takedown https://github.com/KurtLehnardt/conferenceCaddie/issues --publisher-name "Conference Caddie"
  cd native && ./gradlew :shared:smokeTalks -Pcaddie.smokeSite=/tmp/site
  ```
- **The full schedule.** The Search tab's "Search | Schedule" switch shows the schedule one day at a
  time, from the bundle, in start order under each start time, with day chips (Today on today's,
  judged in the conference's time zone), the schedule's own filters (the time chips are left out, as
  on the web), events and showcases, a star on each talk, and Jump to now while the conference runs.
  The filters work offline too, since the bundle is on the device.
- **My schedule.** List or Day, kept on the device as the web keeps it; the Day timeline puts talks
  at the same time side by side in equal columns, with a Now line today, and nothing is flagged.
  The Interested options (the app bar's menu) clear the list after a question, with Undo, and share
  it as text through the system's share sheet (native only).
- **Import my schedule.** Settings → You → Import my schedule reads a CSV or TSV, calendar (.ics),
  JSON or text file from the system's picker, a file opened in or shared to the app, or pasted text,
  up to 5 MB or 200,000 characters. PDF and Word files are not read (decision 8). On a backend whose
  capabilities say `imports.schedule: device` (tier 1) the device parses and matches the file as the
  Worker does; on one that says `server` (tier 3) the app sends the file's text to
  `POST /api/import/schedule` with the file name and type as hints, and imports on the device when
  that backend cannot be reached. The review, the labels and the marking follow the web; the talks
  are marked on this device only. Android reads only `content:` addresses that another app hands
  over, never a `file:` address, and iOS deletes the copy the system makes for the app once it is
  read. `ScheduleImport`'s tests include every case of `test/import-bounds.test.mjs` and 28 files
  whose candidates and matches equal the Worker's (`shared/scripts/generate-import-fixtures.mjs`).
- **Storage.** SQLite through the bundled androidx.sqlite driver, in two files on one connection:
  the main database (settings and the marked talks) and a cache database attached as `cache` (the
  cached lists, the installed bundles and the search index, all of which can be downloaded again).
  Each is migrated by its `user_version` (`CaddieDatabase.MIGRATIONS` and `CACHE_MIGRATIONS`; add a
  migration at the end, never change a shipped one). Android keeps both in the app's database
  directory, excluded from backups like everything else; iOS keeps them in Application Support,
  with the cache database and the bundle directory excluded from backups. The apps open the
  database lazily off the main thread with `CaddieDatabase.openLazily()`, which never crashes: it
  sets a corrupt main database aside (`caddie.db.unreadable-{time}`, the newest three kept) and
  starts with an empty one, and runs in memory, leaving the file alone, when the database is from a
  newer version of the app.

### Trying the talk features against local bundles

Until the Pages workflow publishes the bundles, build them from `main` and serve them from your
machine (debug builds only):

```sh
npm --prefix tools/bundles ci --ignore-scripts
node scripts/build-bundles.mjs --out /tmp/site --only kubecon-cloudnativecon-north-america-2026
```

Then edit `/tmp/site/capabilities.json` so `talks.bundle_base` points at your server, and serve the
folder:

- **Android emulator:** serve it over http (`python3 -m http.server 8765 --directory /tmp/site`),
  set `bundle_base` to `http://127.0.0.1:8765/bundles/`, run `adb reverse tcp:8765 tcp:8765`, and
  start the app with `adb shell am start -n app.conferencecaddie/.MainActivity -e caddie.backend
  http://127.0.0.1:8765 -e caddie.query "kubernetes scheduler"`. Debug builds accept a plain http
  bundle base on the local hosts that `BackendUrl` accepts; release builds never do.
- **iOS simulator:** App Transport Security blocks plain http, so serve the folder over https with a
  certificate for `127.0.0.1` from a local test CA, trust the CA in the simulator with
  `xcrun simctl keychain booted add-root-cert ca.pem`, set `bundle_base` to
  `https://127.0.0.1:8766/bundles/`, and launch with `xcrun simctl launch booted app.conferencecaddie
  -caddie.backend https://127.0.0.1:8766 -caddie.query "tuesday afternoon"`.

`caddie.backend` and `caddie.query` are debug launch options next to the shell's (`caddie.tab`,
`caddie.theme` and the others under Design system); the backend you pass stays selected, like one
chosen in Settings. `caddie.sheet filters` opens the Filters sheet and `caddie.sheet topics` the topic
picker, `caddie.talk <talk id>` opens a talk, `caddie.mark <id>,<id>` marks talks, `caddie.learn
<topic id>,<topic id>` and `caddie.learnText <text>` set what For you suggests from, and `caddie.rank
first` opens the first search result's Why this rank, so screenshots need no taps. A value with a space
needs its own quotes inside `adb shell`, for example `-e caddie.query "'kubernetes security'"`.

## Privacy

- ONNX Runtime's telemetry is switched off on both platforms (Talk features, No telemetry).
- Android: `allowBackup` is false, and `data_extraction_rules.xml` excludes every domain, the
  device-protected `device_*` domains included, from cloud backup and device-to-device transfer,
  because the app will hold per-backend device secrets. The Capacitor app in `web/android` has the
  same settings, since its WebView storage holds the people features' device secret.
- iOS: `iosApp/iosApp/PrivacyInfo.xcprivacy` declares no tracking, no tracking domains and, for
  now, no collected data. It declares the required-reason APIs that `nm -u` finds in the Release
  device framework: `stat` and `fstat` (FileTimestamp, `C617.1`, from Skia and ICU) and
  `mach_absolute_time` (SystemBootTime, `35F9.1`, from Skia). Phase 2a's bundled SQLite and file
  cache add `lstat` (FileTimestamp) and `statfs` and `fstatfs` (DiskSpace, declared with `E174.1`).
  No user-defaults API is linked. Check again when dependencies change:

  ```sh
  ./gradlew :composeApp:linkReleaseFrameworkIosArm64
  nm -u composeApp/build/bin/iosArm64/releaseFramework/ComposeApp.framework/ComposeApp | sort -u
  ```

## Dependency verification

`gradle/verification-metadata.xml` holds the SHA-256 of every dependency and plugin the build
resolves, and Gradle refuses an artifact whose checksum is missing or different. After changing a
version in `gradle/libs.versions.toml` (Dependabot's Gradle updates included), regenerate it on a
Mac, so the iOS artifacts are covered, and review the diff:

```sh
./gradlew --write-verification-metadata sha256 --no-configuration-cache --rerun-tasks help \
  :shared:allTests :androidApp:assembleDebug :androidApp:assembleRelease \
  :androidApp:assembleDebugAndroidTest :composeApp:assembleAndroidDeviceTest \
  :composeApp:compileTestKotlinIosSimulatorArm64 :composeApp:linkReleaseFrameworkIosArm64 :composeApp:linkDebugFrameworkIosSimulatorArm64 \
  :composeApp:iosArm64ResolveResourcesFromDependencies \
  :composeApp:iosSimulatorArm64ResolveResourcesFromDependencies
```

Then build the iOS app once with `xcodebuild` (see above), since Xcode's build phase resolves a few
more artifacts; if it reports a missing checksum, add the task it names to the command.

Files that are not Maven artifacts (the query model, its vocabulary and ONNX Runtime's iOS archive)
are pinned in `gradle/pinned-downloads.properties` by URL, size and SHA-256 instead. When ONNX
Runtime's version changes in the version catalog, the iOS archive's pin must change with it, and so
must `licenses/onnxruntime.txt`; the build and the notices check stop when they disagree. When the
bundle builder's `ONNX_REVISION` changes, the model and vocabulary pins must name the same revision;
`:shared:checkEmbeddingRevision` fails until they do.

Some artifacts differ by operating system (AAPT2 for Linux and macOS), so the file also lists the
Linux variants that CI needs; when a Linux CI run fails verification, add the entry it names.
Sources and Javadoc jars, which IDEs download, are trusted without checksums.

## Continuous integration

`.github/workflows/native.yml` runs on pull requests and on pushes to `main` that touch `native/`,
the contracts, the bundle builder (`scripts/lib/embedder.mjs`, `scripts/build-bundles.mjs`), the
smoke test (`scripts/smoke.mjs`), `data/`, `tools/bundles/` or the workflow itself. Every action is pinned to a commit SHA, checkouts keep no credentials, and
Dependabot (`.github/dependabot.yml`) proposes weekly updates for the actions and the Gradle
dependencies.

- **Shared tests and Android build** (Ubuntu): the ONNX Runtime entry check,
  `:shared:allTests` (with `checkEmbeddingRevision` and `checkPinnedDownloads`) and
  `:androidApp:assembleDebug`, with the arm64-v8a debug APK kept as an artifact. It builds the
  unsigned release APKs on every run and writes their sizes to the job summary; on `main` it hands
  the arm64-v8a one to the sign job.
- **Talk checks against the on-device search** (Ubuntu): builds the bundles from the committed data
  with `scripts/build-bundles.mjs` and runs `:shared:smokeTalks`; the table goes to the job summary.
- **Sign the release APK** (Ubuntu, environment `release`, `main` only): described under Signing.
  It is skipped with a notice when the signing secrets are missing.
- **UI tests on an Android emulator** (Ubuntu): the Compose UI tests, the measurement of the shipped
  model (its numbers go to the job summary), the instrumented smoke test and
  `scripts/release-smoke.sh` on the R8 release build, on an API 34 emulator started by
  `reactivecircus/android-emulator-runner`. The emulator's booted state is cached as a snapshot.
  No secrets. The release APK is signed only after this job passes.
- **iOS simulator build** (macOS): the shared tests and the Compose UI tests on the iOS simulator,
  the third-party notices check, the Release device framework link, and an unsigned simulator build
  of the Xcode project. The TestFlight jobs write the Release app's size, installed and zipped, and
  the signed IPA's size to their job summaries.
- **TestFlight upload** (macOS, environment `release`, `main` only): described under Signing. It is
  skipped when its secrets are missing.

Gradle's caches (the open-source basic provider of `setup-gradle`), Kotlin/Native's `~/.konan`, the
pinned downloads (keyed on `gradle/pinned-downloads.properties` and the runner's OS) and the bundle
builder's fp32 model (keyed on its revision) are cached. Pull requests only read the caches; `main` writes them. The `~/.konan` key is the hash
of the version catalog, with no fallback to older keys, so an old Kotlin/Native is never restored.

The artifacts of this public repository can be downloaded by anyone signed in to GitHub.

## Phase 2: align `Capabilities` with the contract

Done in phase 2a: version negotiation with the "update the app" outcome, conservative fallbacks for
unknown values and an unknown `tier` read as `unknown`, the dependency rules, `server-rotate`, the
fixed service UUID and clamped numbers, the https `bundle_base` rule, `Capabilities.Legacy` equal to
`legacy-effective.json`, discovery with the per-backend cache, the connect-link parser and its
confirmation screen, and the contract fixtures in `commonTest`. Done in phase 2c: routing
`caddie://connect` links and QR codes from the platforms to the confirmation screen (see Links).
