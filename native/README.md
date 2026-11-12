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
| `shared/` | Kotlin Multiplatform library with no UI: the capabilities client (`Capabilities`, `CapabilitiesDiscovery`, `ConnectLink`, `BackendUrl`), the talk bundle client (`bundle/`: the index reader, verification, SHA-256, canonical JSON, the bundle cache and the downloader), the SQLite store (`db/`), search (`search/`: FTS5 and meaning fused by reciprocal rank fusion, filters, facets, time phrases, suggestions, evidence, For you and the topic lists), the query embedder (`embed/`: the WordPiece tokenizer, `BgeEmbedder` and ONNX Runtime, through its Java API on Android and the JVM, `src/ortJava`, and its C API on iOS, `src/nativeInterop/cinterop/onnxruntime.def`), the schedule import (`importer/`: the Worker's parser and matcher ported to common Kotlin, and the client of a backend's import route), the `caddie://` link parser (`AppLink`), `core/CaddieCore`, which ties them together for the screens, the people features (`people/`: the People API v1 client, the device credential, the device-side records and `PeopleController`; see People features below), Bluetooth proximity (`ble/`: the derived-token protocol, the runtime that drives the radio, and the platform's `BleRadio` and `BleKeyStore`; see Bluetooth proximity below), the platform interfaces (`Embedder`, `Notifier`, `SecureStore`, the people features' `PlatformServices.kt` and `ble/BlePlatform.kt`), and their Android and iOS implementations (see People platform services). Its tests in `commonTest` run on the JVM and on the iOS simulator; `iosTest` adds the Keychain tests, `jvmTest` holds the live People API harness, `fixtures/` holds the reference query vectors and `scripts/` the generators of the test fixtures. |
| `composeApp/` | Compose Multiplatform UI: the theme, icons, components and copy of the design system, `App()`, the web app's shell (see Design system), and the talk screens in `ui/talks` (`CaddieApp`, For you, the topic picker, Search with Why this rank, the full schedule, the Filters sheet, the talk sheet, My schedule with its Day timeline, and Import my schedule). `ui/platform` holds what the hosts provide (the file picker and the share sheet, `PlatformActions`) and the hand-off of links and files from the platforms (`IncomingHandoff`). The query model and its vocabulary are its Compose resources. On iOS this module is built as the `ComposeApp` framework, which also exports `shared`. Its UI tests in `commonTest` run on the iOS simulator and on Android devices. |
| `androidApp/` | The Android application: `MainActivity` hosts `CaddieApp`, receives `caddie://` links and schedule files, opens the file picker and the share sheet, shows the permission prompts the platform services ask for and hands notification taps to the screens. Its instrumented tests (the smoke test, the secure store and the platform services) are in `src/androidTest`. |
| `iosApp/` | The Xcode project. A SwiftUI entry point hosts `App()` through `ComposeUIViewController` and hands the URLs the system opens it with to the shared code, its app delegate hands the APNs token and notification taps to Kotlin, and a build phase runs Gradle to build and embed the framework. |
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
./gradlew :androidApp:connectedDebugAndroidTest    # the app's instrumented tests
CADDIE_BACKEND=<server URL> CADDIE_BUNDLE_BASE=<bundles URL, ends in /> \
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
(it needs `CADDIE_BACKEND`, the server's base URL, and `CADDIE_BUNDLE_BASE`, the bundles' base URL ending in `/`; it has no defaults)
installs the release build of the device's ABI (signed with the debug key when no release key is
set), checks the installed package for ONNX Runtime's telemetry provider and the network-state
permission, starts it, opens Settings, and searches for letters that are in no talk, which only the
query model can answer, so the model must load and run under R8. The search uses the official server
and the published bundles, so the device needs a connection; that step is tried twice, and on a pull
request whose runner cannot reach the server or the bundles it is skipped with a warning. CI runs it
on the emulator.

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
| `components` | The web's components: `AppBar` (with `AppBarBack` and Profile's `AppBarLabeledBack`), `SwitcherButton`, `NavBar`, `CaddieButton`, `CaddieIconButton`, `CaddieChip` (toggle, dropdown and action chips), `FiltersChip`, `TimePhraseChip`, `SuggestionChip`, `ChipRow`, `SearchField`, `TalkCard`, `InterestedToggle`, `CaddieSheet`, `ConfirmDialog`, `Segmented`, `SwitchRow`, `OptionRow`, the settings rows, `StateView`, `ErrorBanner`, `Toast`, `OfflineBadge`, `NeedsConnection` and `SkeletonCard`. |
| `strings` | `Strings`: the web's copy word for word, grouped by the web file it comes from. Copy that only the native apps need is marked "native only". |
| `format` | `Format`: dates and times written as `web/src/lib/time.ts` writes them. |
| `shell` | `App()`'s parts: `ShellState`, `ShellActions` and `TabContent`, `ShellNavigation` (the tab and the pages over it), the Settings screen, the conference switcher and the server confirmation. `StandaloneShell` runs the shell without a backend until the talk features replace it. |
| `people` | The people screens on `PeopleController` (phase 3): the People tab, Profile, Requests, Meet up, the people groups of Settings, the talk circles, and their building blocks. See People screens below. |

`App(state, actions, content)` is the web's shell: the conference switcher in the app bar, the
Offline badge and the Settings gear on its right, and the tab bar People (only when the backend
serves people features), For you, Search and Interested. The caller owns the data (`ShellState`),
answers `ShellActions`, and supplies each tab's screen through `TabContent`; tab content reaches the
shell through `LocalShellNavigator`.

Settings, Profile, Requests and Meet up are pages of their own over the tabs, with Back, as the
web's non-tab routes are. `ShellNavigation` keeps them as a stack (`ShellPage.Settings` and
`PeoplePage.Profile`, `PeoplePage.Inbox`, `PeoplePage.Meet(id)`): `openPage()` puts one on top or
goes back to it when it is already open, `back()` leaves the top one (the system Back and the iOS
edge swipe do this), and `selectTab()` leaves them all. The app bar's Back follows the web: Settings,
Requests and Meet up lead to the tab screen, and Profile's labelled "‹ Settings" leads to Settings.
Requests and Meet up keep People selected in the tab bar. A caller that moves around the shell from
outside it (a notification tap) makes the navigation with `rememberShellNavigation()` and passes it
to `App()`.

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
`-caddie.connect https://example.org`, `-caddie.gallery 1` (the Search components drawn with the
web's sample talk) and `-caddie.people` (below); the talk screens add theirs (Trying the talk
features against local bundles), among them `-caddie.link <caddie:// link>`, which hands a link
over as the platform would. On iOS they are launch arguments
(`xcrun simctl launch <device> app.conferencecaddie -caddie.tab Search`); on Android they are intent
extras (`adb shell am start -n app.conferencecaddie/.MainActivity -e caddie.tab Search`). Release
builds ignore them. `-caddie.connect` follows the rules of a `caddie://connect` link: the address is
normalised, and anything a link could not name (not https, credentials, a query) is ignored.

On iOS a Light or Dark Theme setting is applied to the app's window, so the status bar, the SwiftUI
host and anything presented from it follow it too.

### People screens

`ui/people` draws the web's people screens (`web/src/people`) on the shared `PeopleController`:

- `PeopleTab.kt` puts them in the shell. `rememberPeopleUi()` collects the controller's state and
  gives `App()` the People tab, the people pages, the people groups of Settings and the Requests
  button with its badge, and the talk screens their slots (`TalkSheet`'s `peopleControls`,
  `InterestedScreen`'s `shareAll`). The People tab shows only when the backend's capabilities and
  the controller both have people features on. Offline, the People tab, Requests and Meet up show
  the web's NeedsConnection; Profile and Settings still work. It also shows the people route of
  the shell's `ShellRequest` once people features are on: every `caddie://` link, a tapped
  notification's (`caddie://people?around=1`, `caddie://inbox`, `caddie://meet/{id}`) included,
  goes through `IncomingHandoff` and `AppLink` in `CaddieApp`, and a people route
  (`AppLink.PeopleRoute`) opens People (with Around now), Requests, Meet up, Profile, or the
  presence setup on a zone, which turns presence on only when the person taps "I'm around". It
  shows the controller's notices as toasts, and draws the sheets several screens share (Ask to talk
  shop, Report, the block confirmation) once.
- Every screen takes the `PeopleUiState` it draws and a `PeopleHost`: the controller, moving
  around (`openProfile()`, `openInbox()`, `openMeet(id)`, `openPeople(request)`, `back()`), the
  shell's toast, those shared sheets, and opening talks and links. Nothing reaches the controller
  through a CompositionLocal.
- `PeopleComponents.kt` holds the building blocks with the web's sizes (people.css): `PeopleCard`,
  `PeoplePrompt`, `PeopleNotice`, `PeopleBanner`, `PeopleTextField`, `PeopleSelect`, `RadioRow`,
  `PeopleSwitchRow` (Settings, in-card and presence sizes), `BandPill`, `SamplePill`, `SampleNote`,
  `AroundLine`, `PersonFrame`, `OpenerBox`, the headings, `ActionsRow`, `RefreshBar`,
  `OverflowMenu`, and `EvidenceText`, which shows the server's evidence with its `<mark>`
  highlights and treats nothing else as markup. Its header lists the web's computed-style quirks
  that the screens keep, such as the danger-styled text buttons that render in the accent ink.
  Its controls reserve the platform's touch target (`minimumInteractiveComponentSize()`) and grow
  with large text, and `PeopleScreenColumn` ends above the keyboard (`imePadding()`), as Settings
  does; a screen built on a `LazyColumn` adds `imePadding()` itself.
- The people pages (Profile, Requests, Meet up) and the People tab draw in the shell's content
  column, so in a wide window they sit in its centred 720 dp column next to the rail, with the same
  insets as Settings.
- Copy shared by several screens is in `PeopleCommonStrings`; each group of screens has its own
  strings file, and the web's logic-file copy is the shared module's `PeopleText`.

`-caddie.people` opens a people screen once people features are on: `home`, `around` (Around now
on), `search:<text>`, `profile`, `inbox`, `meet:<id>` or `settings-people` (Settings, whose people
groups follow You), for example
`xcrun simctl launch <device> app.conferencecaddie -caddie.people search:kubernetes`.

The parity screenshots of the people screens (`PeopleParityShots` in composeApp's common tests)
draw every state with the web mock's people at 390 and 320 dp, light and dark, and save PNGs.
Normal test runs skip them. On Android, pass the instrumentation argument `caddieParity=1`
(optionally `caddieParityOnly=<state>,<state>`) and pull the PNGs from
`/data/local/tmp/caddie-parity` with `adb pull`; on iOS, set `SIMCTL_CHILD_CADDIE_PARITY_DIR` to a folder on this Mac (and optionally
`SIMCTL_CHILD_CADDIE_PARITY_ONLY`) for `:composeApp:iosSimulatorArm64Test`.
The states run at a fixed instant, 09:00 on the sample summit's second day (`ParitySample.pinnedNowMs`),
not on the wall clock, so they look the same on any day; `ParityClockTest` checks that with the
other UI tests.

On Android the shots change the device while they run: its display size and density, its text size,
and SystemUI's demo mode, which keeps the status bar's clock at the pinned 09:00. Use an AVD of
their own, not one you use for anything else. Each window writes the values it changes to
`/data/local/tmp/caddie-parity/.restore` first and puts them back when it ends; if a run is killed
in between, the next run puts them back from that file before it starts, so clear old PNGs with
`adb shell rm /data/local/tmp/caddie-parity/*.png` rather than removing the folder. To put an
emulator back by hand:
`adb shell am broadcast -a com.android.systemui.demo -e command exit; adb shell settings delete global sysui_demo_allowed; adb shell wm size reset; adb shell wm density reset`.
Some Android shots still show the status bar, part faded, where a window brought it back just
before the shot; two runs of a state can differ by that bar, never by the time on it.

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
| `IOS_APPSTORE_PROFILE_BASE64` | `ios-sign` | An App Store provisioning profile for `app.conferencecaddie` that includes Push Notifications, base64-encoded |
| `APPLE_TEAM_ID` | `ios-sign` | The Apple Developer team id |
| `ASC_KEY_ID` | `testflight-upload` | The App Store Connect API key id |
| `ASC_ISSUER_ID` | `testflight-upload` | The issuer id shown above the API keys list |
| `ASC_KEY_P8_BASE64` | `testflight-upload` | The downloaded `AuthKey_<id>.p8` file, base64-encoded |

The job `testflight-gate` reads whether all seven exist; when one is missing, the three jobs are
skipped with a notice.

Before the first upload, register the bundle id `app.conferencecaddie` with the Push
Notifications capability, create the distribution certificate and the App Store profile in the
Apple Developer account, create the app in App Store Connect, and create a team API key with the
App Manager role (Users and Access, then Integrations).

The app requests the Push Notifications capability (`iosApp/iosApp.entitlements`,
`aps-environment`), so a profile without it cannot sign the archive. If the App ID or the profile
was made before the capability was enabled, enable Push Notifications on the App ID
(Certificates, Identifiers & Profiles, then Identifiers), regenerate the App Store profile, and
upload it again as `IOS_APPSTORE_PROFILE_BASE64`. Xcode takes the entitlement's value from the
profile, so the signed app has `production`. The official server also needs an APNs
authentication key (`.p8`) to send pushes; that key belongs to the server, never to the app or
these secrets. Device builds with automatic signing need a paid team, because personal teams
cannot use Push Notifications. Upload the secrets with stdin, for example
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
  date are dropped. The people routes open the People tab with an `AppLink.PeopleRoute`:
  `#/people` the People home (`?around=1` with "Around now" on), `#/inbox` Requests,
  `#/meet/<meet_id>` Meet up, `#/profile` the profile and `#/here/<zone>` a zone, percent-decoded
  and at most 120 characters, that the screen matches against the conference's zones. A meet id
  or zone that does not fit is dropped and the People tab opens without it.
- `caddie://people?around=1`, `caddie://inbox` and `caddie://meet/<meet_id>`, the links of the
  app's own notifications (see People platform services), open the same screens on the selected
  conference. Only those exact shapes are taken on these hosts.
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
  package. `openEncoder` also refuses to start ONNX Runtime unless the variable is set. Keep all of
  this when ONNX Runtime is updated.
- **The model loads when it is needed.** The core loads the model on the first text search (or For
  you with learn text) whose embedding is not cached, tries again after a failure once a pause has
  passed, and closes it when the system asks for memory (a load still running is closed when it
  ends); the next such search loads it again.
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
  are marked on this device only. A file another app opens in or shares to the app waits on the
  sheet's first page until the person taps Find talks. Android reads only `content:` addresses that
  another app hands over, never a `file:` address, and at most 5 MB of them; iOS deletes the copy
  the system makes for the app once it is read. JSON is read with a bound on memory
  (`importer/BoundedJson`): at most 200,000 values are built, and nothing nested deeper than 512
  levels is read as JSON. `ScheduleImport`'s tests include every case of `test/import-bounds.test.mjs` and 28 files
  whose candidates and matches equal the Worker's (`shared/scripts/generate-import-fixtures.mjs`).
- **Updating from the Capacitor app.** The native Android app installs over the Capacitor app
  v0.3.0 (same application id and key). At its first start after that update it reads the old
  app's Interested lists from the old WebView's local storage (`CapacitorMigration`, through a
  hidden WebView at the old origin, `https://localhost`, made once the first frame is drawn; network
  loads blocked, every request answered by the app, Safe Browsing and WebView metrics off) and keeps
  them for the official server. The marks and the marker that stops it running again are written
  in one transaction; it tries at most three times. The old app's people profile and device secret are not moved yet (phase 3), so
  delete a profile in the old app before updating if you made one.
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

## People features

Phase 3 puts the people features of the web app (`web/src/people`) in `shared/people`. The screens
(`composeApp/.../ui/people`, under Design system) are built on `PeopleController` alone; its KDoc
is the reference for them.

| File | What it is |
|---|---|
| `PeopleApi.kt` | One suspend function per route of `contracts/routes/people-api.v1.json`, plus the native push route (`NativePush`). It sends `X-Caddie-Device` only to the backend the credential belongs to, puts the conference in the body or in `?event=`, never sends `Origin` or cookies, waits 20 s for profile writes and deletes and the presence delete (the web's `WRITE_TIMEOUT_MS`) and 30 s for the rest, retries a free-text 409 once where the route table says to, and reads `X-Caddie-Pace`. |
| `PeopleError.kt` | The contract's client rule for errors: a `Kind` per stable code, the status class otherwise, and the web's wording for each (`friendly()`, `explainBadRequest()`). |
| `PeopleModels.kt` | A kotlinx.serialization type per `$defs` entry of `contracts/schema/people-api.v1.schema.json`. A request sends exactly the keys it is given (`Opt`: absent, `null` or a value); answers are read leniently. |
| `DeviceCredential.kt` | `profile_id` (16 random bytes) and `secret` (32), base64url, generated once per backend base and kept in the `SecureStore` under `SecureStore.scopedKey(backend, "people.device.v1")`. Never printed. |
| `PeopleRecords.kt`, `PeopleStore.kt` | The device-side records of `web/src/people/storage.ts` (profile, visibility, presence, push, blocks, people met, the watch list, nudge records, unfinished deletes) as JSON in `PeopleDatabase`, a key-value file of their own that no backup carries (iOS `caddie/people/people.db`, excluded from backup; Android `no_backup/people/people.db`), under `people:v1:{backend base}#...`, so they last exactly as long as the device credential. A corrupt file is replaced; any other failure to open it keeps the launch's records in memory (`PeopleKeyValue.inMemory`). |
| `ProfileSync.kt` | `sync.ts`: profile writes one at a time under one write lock, the delete that is marked before it is sent and retried from 30 seconds doubling to 30 minutes, no write while a delete covers the conference, "Delete my profile", the degraded re-send after 70 s, retired topics. |
| `PresenceRuntime.kt` | `presence.ts`: zones, hour and day modes, expiry, five minutes in the background, "Still in {zone}?", and the position (precise access and `gps_bands` only, at most every 30 s stretched by the pace, accuracy in whole metres). |
| `ConnectRuntime.kt` | `connect.ts`, `nudges.ts` and `watch.ts`: the inbox poll (45 s, stretched by the pace, held back by Retry-After), asks, the blocks cache, nudges once per person per day with a local notification when the app is not in the foreground, and the watch list. |
| `PeopleText.kt`, `PeoplePrivacy.kt` | The web's wording that lives in its logic files, the zones, and the privacy helpers the screens must use for a zone, a band, a spot line or a distance. |
| `PeopleController.kt`, `PeopleState.kt` | The one object the screens use: `state` (a `PeopleUiState` per selected conference) and the actions. |

To build one, pass the app's `KtorHttp` (it is both `Http` and `ApiHttp`), the database and the
platform's `PeopleServices`, then bind it to the core:

```kotlin
val people = PeopleController.create(database, http, services, scope, allowLocalHttp)
people.bind(core.state)
// and from the platform's lifecycle: people.setForeground(true / false)
```

`AndroidCore.people()` and `IosCore.people()` build the app's one controller this way, bound to
the core, from the `PeopleServices` the host passes in. The people checks of
`scripts/smoke.mjs` run through `PeopleApi` against a live backend with:

```sh
./gradlew :shared:jvmTest --tests '*LivePeopleSmokeTest*' \
  -Pcaddie.liveBase=https://conference-caddie-265846417372.us-west1.run.app
```

Every test profile it makes is named "Caddie Native Test ...", uses the smoke's synthetic words, and
is deleted and checked to be gone at the end. Without `-Pcaddie.liveBase` the test does nothing.

## People platform services

The people features reach the phone through the interfaces in
`shared/src/commonMain/.../PlatformServices.kt` and `Platform.kt`, passed in once as
`PeopleServices`. Each platform has a factory. On Android the process's one controller, with its
services, comes from `CaddiePeople.controller(context)` in `androidApp`, which `MainActivity` and
the background nudge job share; on iOS `MainViewController` calls the factory once at start-up to
build the people controller.

| | Android (`shared/src/androidMain`) | iOS (`shared/src/iosMain`) |
|---|---|---|
| Factory | `AndroidPeopleServices.create(context, R.drawable.ic_stat_caddie)` | `IosPeopleServices.create()`, on the main thread |
| `SecureStore` | `AndroidSecureStore`: an AES-256-GCM key in the Android Keystore, values in the private file `caddie_secure_store` | `IosSecureStore`: Keychain items of the service `app.conferencecaddie.secure-store`, after first unlock, this device only, never in iCloud Keychain |
| `LocationProvider` | `AndroidLocationProvider`: the platform's LocationManager (no Play services), while in use only | `IosLocationProvider`: Core Location, "when in use" only |
| `Notifier` | `AndroidNotifier`: the "Nudges" channel; while a visible profile has presence on at a live conference, a periodic `JobScheduler` job (`BackgroundNudgeJobService`, every 15 minutes, not persisted across a reboot) runs the nudge check in the background | `IosNotifier`: UserNotifications |
| `PushRegistrar` | `NoPush` (no Firebase in the APK, see `DECISIONS.md`) | `IosPushRegistrar`: APNs, channel `apns` |
| `SystemSettings` | the app's page in Settings | the app's page in the Settings app |

- **Permission prompts.** On Android they need an activity: `MainActivity` registers an
  ActivityResult launcher and attaches it to `AndroidPermissions`, which the services use. On iOS
  the services ask the system directly. The screens show the web's explanation before asking.
- **Notification taps.** A notification carries a `caddie://` link (`caddie://people?around=1`,
  `caddie://inbox`, `caddie://meet/{meet_id}`). On Android it is the intent extra
  `AndroidNotifier.EXTRA_DEEP_LINK`, which `MainActivity` reads in `onCreate` and `onNewIntent`
  and takes only with this install's tap key; on iOS it is `deepLink` in the notification's
  `userInfo`, which the app delegate in `iOSApp.swift` passes to `openNotificationTap`
  (`IosIncoming.kt`, reading it with `IosNotificationTaps`). Both take only those exact links
  (`isNotificationDeepLink`) and hand them to `IncomingHandoff`, the same way every `caddie://`
  link goes: `AppLink.parse` reads them as the People tab with a `PeopleRoute`, which `CaddieApp`
  passes on in the shell's `ShellRequest`. A remote (APNs) notification must put its link at
  the top level of the payload under `deepLink`. iOS shows notifications as banners while the app
  is open too.
- **APNs.** `IosPushRegistrar.register()` asks for notification permission, registers with iOS and
  waits up to 20 seconds for the token, which the app delegate hands to `IosPush`. The token's
  environment is the one the app was signed for: `ApsEnvironment` reads `aps-environment` from the
  provisioning profile embedded in the app (`development` gives `sandbox`), and an App Store or
  TestFlight install, which has no embedded profile, always reports `production`.
- **Tests.** `androidApp/src/androidTest` checks the Keystore store (round trip, overwrite, remove,
  two backends kept apart, nothing readable in the file, a tampered or moved value, a lost key),
  the notification channel and the tap routing through `MainActivity`, and positions from a test
  location provider. The Keychain tests in `shared/src/iosTest` run under Gradle: the simulator
  test executable carries the entitlements of `src/iosTest/simulator-tests.entitlements` in its
  `__TEXT,__entitlements` section, as an Xcode simulator build does, and the simulator test tasks
  boot their simulator first (`simctl bootstatus -b`) and run in it, because a standalone
  simulator process has no Keychain (`errSecNotAvailable`, -25291). A missing Keychain fails them.
  Debug builds also run the same checks in the app, with a simulator build that carries the app's
  entitlements (an unsigned build gets `errSecMissingEntitlement`, -34018):

  ```sh
  xcodebuild -project iosApp/iosApp.xcodeproj -scheme iosApp -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
  xcrun simctl install <device> "<DerivedData>/Build/Products/Debug-iphonesimulator/Conference Caddie.app"
  xcrun simctl launch --console <device> app.conferencecaddie -caddie.selftest securestore
  xcrun simctl privacy <device> grant location app.conferencecaddie
  xcrun simctl location <device> set 37.7749,-122.4194
  xcrun simctl launch --console <device> app.conferencecaddie -caddie.selftest location
  ```

  Each prints one line, `caddie.selftest securestore: passed` or what failed, never a value or a
  position.

## Bluetooth proximity

Phase 4 brings "Find people near me by Bluetooth" to both apps on backends whose capabilities say
`ble.mode: derived-v1` ([`docs/contracts/ble-tokens.md`](../docs/contracts/ble-tokens.md)). It is
off by default, runs only while the person is around at the conference, and shows under the
presence card's push switch and as the Bluetooth group in Settings.

- **Tokens on the phone.** Turning it on writes presence again with `ble: true`; the answer's
  `ble_key` goes straight into the platform key store under an alias per backend and conference,
  and its text is dropped. The phone then derives each ten-minute token itself
  (`ble/BleProtocol.kt`), so rotation needs no network call and keeps working while the app sleeps,
  which is what stopped discovery on Android on 2026-11-09 (`docs/NATIVE_PLAN.md`, section 4.5).
- **Common runtime.** `ble/BleRuntime.kt` (owned by `PeopleController`) does the turn-on steps
  (presence, permission, Bluetooth state, notifications, the presence write, the key), hands the
  radio the payload of the current window whenever it asks, reports sightings in batches
  (`ble.sightings_min_interval_s`, at most 50, never older than five minutes, never the phone's own
  token or one already reported in the window, backing off on errors), re-keys at most once per
  window, and turns strong matches into at most one local notification per person per day and three
  an hour, shared with the in-app nudges. It resumes after the system restarted the process.
- **Android.** `AndroidBleRadio` runs `BleRadioService`, a foreground service of type
  `connectedDevice` with its own ongoing notification ("Conference Caddie is finding people near
  you", with Stop). It advertises an extended set with the payload as service data and, on Android
  14 and newer only, a non-discoverable legacy connectable set with the service UUID and a GATT
  server that serves the advertised payload (before Android 14 a connected peer could read the
  phone's name), restarts the sets at every window so the address changes with the token, scans for
  the service UUID and for the iOS overflow area, and connects to read the token from phones that do
  not send it in their advertisement (`ble/BleInterrogation.kt`: at most six reads a minute, one at
  a time, each address once per window), never serving its own token over a link it opened. It is `START_STICKY` and keeps running when the app is swiped from Recents.
  Keys are non-exportable HMAC keys in the Android Keystore (`AndroidBleKeyStore`).
- **iOS.** `IosBleRadio` uses Core Bluetooth from Kotlin, with state restoration and the
  `bluetooth-central` and `bluetooth-peripheral` background modes. It advertises the service UUID
  only (iOS cannot advertise service data, and moves the UUID to the overflow area in the
  background), always serves the token characteristic, and reads it from phones that do not send
  service data. When iOS relaunches the app for Bluetooth, `iOSApp.swift` calls
  `IosBle.restoreAfterLaunch`, which creates the people controller without any UI so the session
  resumes. Keys are Keychain items, after first unlock, this device only (`IosBleKeyStore`).
- **Tests.** The common tests check the protocol against the contract's golden vectors and drive
  the runtime with a fake radio on virtual time (turn-on paths, batching, back-off, re-keying,
  notifications, presence, restoring). `androidApp/src/androidTest` checks the Keystore key against
  the golden vectors and the service's lifecycle with a fake Bluetooth stack (foreground type,
  notification, refresh, GATT reads, Stop, the deadline, Bluetooth off, the system restart, the
  activity finishing). `shared/src/iosTest` checks the Keychain store's logic and the radio on the
  simulator, which has no Bluetooth; `-caddie.selftest blekeys` and `-caddie.selftest bleradio` run
  the Keychain and radio checks inside the app (see People platform services for how to launch
  one). `BleUiTest` covers the controls on both platforms.
- **Not checked without phones.** Emulators and simulators have no real radio: discovery between
  phones, two backgrounded iPhones, the overflow area seen from Android, the address change per
  window, Doze timing and battery are measured on real phones (`docs/NATIVE_PLAN.md`, Phase 4 exit
  criteria).
- **Release gate.** Release builds ship without native Bluetooth until the exit test below passes:
  `CADDIE_BLE_ENABLED` is on in Android debug builds and the iOS Debug configuration and off in
  release builds, which then declare no Bluetooth permission, service or background mode at all
  (DECISIONS.md, "Native apps phase 4", review rounds 1 and 2). Turning it on for release is a
  one-line change of each flag after the exit test.
- **Exit-test builds.** The exit test runs on optimised release builds with Bluetooth on, built only
  for it and never published: Android `./gradlew -Pcaddie.bleEnabled=true :androidApp:assembleRelease`
  (R8 on, `CADDIE_BLE_ENABLED` true, the Bluetooth manifest entries merged in); iOS
  `xcodebuild -project iosApp/iosApp.xcodeproj -scheme iosApp -configuration Release CADDIE_BLE_ENABLED=YES ...`
  (the Release configuration with the flag on and the Bluetooth background modes kept).
- **Exit test** (`docs/NATIVE_PLAN.md`, Phase 4), on those builds and real phones: two hours in a
  pocket with the screen off and the app swiped from Recents (discovery continues past ten minutes
  on Android; a strong match within 3 m notifies within one sightings interval plus 30 seconds);
  the iOS S1 matrix; the battery drain per hour (target 3 % or less); a brief encounter (two phones
  near each other for under a minute are reported); and the **name check**: from another phone,
  connect to each test phone over GATT while it runs Bluetooth proximity (and let it connect out
  to a phone advertising the service UUID) and record which Bluetooth device name, if any, the
  peer can read, for an Android 14 or newer phone, an Android 13 or older phone and an iPhone.
  Whether iPhones find an Android 14 phone's non-discoverable connectable set is recorded too; until
  then Android shows "iPhones may not find this phone, but it still finds them." on every version.

## Privacy

- ONNX Runtime's telemetry is switched off on both platforms (Talk features, No telemetry).
- Android: `allowBackup` is false, and `data_extraction_rules.xml` excludes every domain, the
  device-protected `device_*` domains included, from cloud backup and device-to-device transfer,
  because the app holds per-backend device secrets (the secure store's `caddie_secure_store` file
  and the `caddie_permissions` file are SharedPreferences, so the `sharedpref` rules cover them).
  The Capacitor app in `web/android` has the same settings, since its WebView storage holds the
  people features' device secret.
- Android permissions: `INTERNET`, and for the people features `ACCESS_COARSE_LOCATION` and
  `ACCESS_FINE_LOCATION` (asked together, only while the app is in use; no background location)
  and `POST_NOTIFICATIONS` (Android 13 and newer). `android.hardware.location` is not required.
  Bluetooth proximity adds `BLUETOOTH_SCAN` (declared `neverForLocation`: no position is derived
  from what the scan hears), `BLUETOOTH_ADVERTISE` and `BLUETOOTH_CONNECT` on Android 12 and newer,
  `BLUETOOTH` and `BLUETOOTH_ADMIN` up to Android 11 (where a scan also needs the location
  permission, asked only when the person turns Bluetooth on), `FOREGROUND_SERVICE` with
  `FOREGROUND_SERVICE_CONNECTED_DEVICE`, and `WAKE_LOCK` for the short wake around a report.
  `android.hardware.bluetooth_le` is not required. These come from `androidApp/src/ble/AndroidManifest.xml`,
  merged into debug builds and, with `-Pcaddie.bleEnabled=true`, into the exit-test release build
  only: a release build without the flag declares no Bluetooth at all.
- iOS: `Info.plist` has `NSLocationWhenInUseUsageDescription`, `NSBluetoothAlwaysUsageDescription`
  and the `bluetooth-central` and `bluetooth-peripheral` background modes (Bluetooth proximity
  only; there is still no background location; a build phase removes the two modes whenever
  `CADDIE_BLE_ENABLED` is not YES, as in the Release configuration); notifications need no usage text. `iosApp/iosApp.entitlements` requests Push Notifications.
- iOS: `iosApp/iosApp/PrivacyInfo.xcprivacy` declares no tracking and no tracking domains. Its
  collected data is what the people features send to the official backend, all linked to the
  profile, none for tracking, all for the app's function: name, other user contact info, other
  user content, precise location, user ID (the random per-backend profile id) and device ID (the
  APNs token); the comment in the file says what each covers. It declares the required-reason
  APIs that `nm -u` finds in the Release device framework: `stat` and `fstat` (FileTimestamp,
  `C617.1`, from Skia and ICU) and `mach_absolute_time` (SystemBootTime, `35F9.1`, from Skia).
  Phase 2a's bundled SQLite and file cache add `lstat` (FileTimestamp) and `statfs` and `fstatfs`
  (DiskSpace, declared with `E174.1`). Phase 3's Keychain, Core Location and UserNotifications
  code adds none (checked on 2026-11-10). No user-defaults API is linked. Check again when
  dependencies change:

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
  model (its numbers go to the job summary), the app's instrumented tests and
  `scripts/release-smoke.sh` on the R8 release build, on an API 34 emulator started by
  `reactivecircus/android-emulator-runner`. The emulator's booted state is cached as a snapshot.
  No secrets. The release APK is signed only after this job passes.
- **iOS simulator build** (macOS): the shared tests and the Compose UI tests on the iOS simulator,
  the third-party notices check, and an unsigned simulator build of the Xcode project. The
  TestFlight jobs write the Release app's size, installed and zipped, and the signed IPA's size to
  their job summaries.
- **iOS device Release link** (macOS): `:composeApp:linkReleaseFrameworkIosArm64`, a compile check of
  the device framework in Release. It takes 30 to 45 minutes on a contended runner, so it runs in
  parallel with the simulator job instead of inside it, which keeps that job under its time limit.
  The iOS Release framework job waits for it.
- **TestFlight upload** (macOS, environment `release`, `main` only): described under Signing. It is
  skipped when its secrets are missing.

Gradle's caches (the open-source basic provider of `setup-gradle`), Kotlin/Native's `~/.konan`, the
pinned downloads (keyed on `gradle/pinned-downloads.properties` and the runner's OS) and the bundle
builder's fp32 model (keyed on its revision) are cached. Pull requests only read the caches; `main` writes them. The `~/.konan` key is the hash
of the version catalog, with no fallback to older keys, so an old Kotlin/Native is never restored.
The simulator job and the device link job each save their own `~/.konan` key (the latter has
`-device-` in it), so they never race for one key. The simulator job is the only writer of the
Gradle cache, and it does not download the iosArm64 libraries, so the device link job (which reads
that cache without writing it) fetches those again on each run. `dependencies` only resolves the graph and does not download the
libraries, and a download-only step was not worth a custom task.

The artifacts of this public repository can be downloaded by anyone signed in to GitHub.

## Phase 2: align `Capabilities` with the contract

Done in phase 2a: version negotiation with the "update the app" outcome, conservative fallbacks for
unknown values and an unknown `tier` read as `unknown`, the dependency rules, `server-rotate`, the
fixed service UUID and clamped numbers, the https `bundle_base` rule, `Capabilities.Legacy` equal to
`legacy-effective.json`, discovery with the per-backend cache, the connect-link parser and its
confirmation screen, and the contract fixtures in `commonTest`. Done in phase 2c: routing
`caddie://connect` links and QR codes from the platforms to the confirmation screen (see Links).
