# Conference Caddie native apps

This directory holds the native Android and iOS apps: a Kotlin Multiplatform core shared by both
platforms, with the UI written once in Compose Multiplatform. The UI follows the web app's design
(see Design system below); the tabs hold placeholders until the talk features arrive, and the app
does not yet talk to a backend. The Capacitor app in `web/android` is
still the Android app people use today. The design and the phases these apps follow are in
[`docs/NATIVE_PLAN.md`](../docs/NATIVE_PLAN.md); this skeleton is spike S5 of Phase 0.

## Layout

| Path | What it is |
|---|---|
| `shared/` | Kotlin Multiplatform library with no UI. It holds the placeholder models (`Conference`, `Talk`), the `Capabilities` document, `BackendUrl` (the contract's backend URL rules), and the platform interfaces `Embedder`, `BleRadio`, `Notifier` and `SecureStore`. Its tests in `commonTest` run on the JVM and on the iOS simulator. |
| `composeApp/` | Compose Multiplatform UI: the theme, icons, components and copy of the design system, and `App()`, the web app's shell (see Design system). On iOS this module is built as the `ComposeApp` framework, which also exports `shared`. Its UI tests in `commonTest` run on the iOS simulator and on Android devices. |
| `androidApp/` | The Android application: `MainActivity` hosts the shell. Its instrumented smoke test is in `src/androidTest`. |
| `iosApp/` | The Xcode project. A SwiftUI entry point hosts `App()` through `ComposeUIViewController`, and a build phase runs Gradle to build and embed the framework. |
| `gradle/libs.versions.toml` | Every dependency version, with the reasons for the choices. |
| `scripts/generate-app-icons.py` | Makes the app icons and the iOS launch image from the web app's icons. |
| `licenses/` | Licence texts of third-party material the apps ship (the lucide icons). |

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
./gradlew :androidApp:assembleDebug     # androidApp/build/outputs/apk/debug/androidApp-debug.apk
./gradlew :androidApp:installDebug      # installs on a connected phone or a running emulator
./gradlew :composeApp:connectedAndroidDeviceTest   # the Compose UI tests on a phone or emulator
./gradlew :androidApp:connectedDebugAndroidTest    # the app's instrumented smoke test
```

With more than one device connected, pick one with `ANDROID_SERIAL=emulator-5554`.

You can also open `native/` in Android Studio and run the `androidApp` configuration.

Release builds run R8 (code shrinking and resource shrinking). Compose, AndroidX and
kotlinx.serialization bring their own keep rules; app-specific rules go in
`androidApp/proguard-rules.pro`. Check a release build on a device after adding anything that uses
reflection.

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

Every size of text is in sp, so the system font size setting scales it; controls are at least 44 dp
tall, icons that carry meaning have content descriptions, headings are marked as headings, and
controls have keyboard focus rings like the web's.

The web app sets no font of its own: its stack (`system-ui, -apple-system, ..., Roboto, ...`) is San
Francisco on iPhones and Roboto on Android phones, which is what Compose's default font family
draws, so no font is bundled. The lucide icons are ISC-licensed (MIT for those that came from
Feather); `licenses/lucide.txt` holds the text and Settings shows it under Open-source licences.

The app icons and the iOS launch image come from `web/public/icons` through
`scripts/generate-app-icons.py` (Pillow). Both apps open on the web's page colour, light or dark.

Debug builds take launch options that open a screen directly, for screenshots and manual checks:
`-caddie.tab Search`, `-caddie.open settings` (or `switcher`), `-caddie.theme dark`,
`-caddie.connect https://example.org` and `-caddie.gallery 1` (the Search components drawn with the
web's sample talk). On iOS they are launch arguments
(`xcrun simctl launch <device> app.conferencecaddie -caddie.tab Search`); on Android they are intent
extras (`adb shell am start -n app.conferencecaddie/.MainActivity -e caddie.tab Search`). Release
builds ignore them.

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
are checked before `main`. On `main` it keeps the unsigned APK for one day, and a separate job signs
it. That job checks out no code and runs no Gradle or npm; it refuses an APK whose name is not the
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
log names.

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

The app does not fetch anything yet. Decision 6 in `docs/NATIVE_PLAN.md` makes the live tier 3
server the default backend in builds, so the Server URL field starts with it. A server typed there,
like one from a `caddie://connect` link, is switched to only after a confirmation that names its base
URL exactly and warns when it is not the official server. Registering the `caddie://` link itself is
still to do. The People tab shows only when the capabilities enable people features; the Compose UI
tests check that gating.

## Privacy

- Android: `allowBackup` is false, and `data_extraction_rules.xml` excludes every domain, the
  device-protected `device_*` domains included, from cloud backup and device-to-device transfer,
  because the app will hold per-backend device secrets. The Capacitor app in `web/android` has the
  same settings, since its WebView storage holds the people features' device secret.
- iOS: `iosApp/iosApp/PrivacyInfo.xcprivacy` declares no tracking, no tracking domains and, for
  now, no collected data. It declares the required-reason APIs that `nm -u` finds in the Release
  device framework: `stat` and `fstat` (FileTimestamp, `C617.1`, from Skia and ICU) and
  `mach_absolute_time` (SystemBootTime, `35F9.1`, from Skia). No disk-space or user-defaults API is
  linked, so none is declared. Check again when dependencies change:

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

Some artifacts differ by operating system (AAPT2 for Linux and macOS), so the file also lists the
Linux variants that CI needs; when a Linux CI run fails verification, add the entry it names.
Sources and Javadoc jars, which IDEs download, are trusted without checksums.

## Continuous integration

`.github/workflows/native.yml` runs on pull requests and on pushes to `main` that touch `native/` or
the workflow itself. Every action is pinned to a commit SHA, checkouts keep no credentials, and
Dependabot (`.github/dependabot.yml`) proposes weekly updates for the actions and the Gradle
dependencies.

- **Shared tests and Android build** (Ubuntu): `:shared:allTests` and `:androidApp:assembleDebug`,
  with the debug APK kept as an artifact. On `main` it also builds the unsigned release APK.
- **Sign the release APK** (Ubuntu, environment `release`, `main` only): described under Signing.
  It is skipped with a notice when the signing secrets are missing.
- **UI tests on an Android emulator** (Ubuntu): the Compose UI tests and the instrumented smoke test
  on an API 34 emulator started by `reactivecircus/android-emulator-runner`. No secrets.
- **iOS simulator build** (macOS): the shared tests and the Compose UI tests on the iOS simulator,
  the Release device framework link, and an unsigned simulator build of the Xcode project.
- **TestFlight upload** (macOS, environment `release`, `main` only): described under Signing. It is
  skipped when its secrets are missing.

Gradle's caches (the open-source basic provider of `setup-gradle`) and Kotlin/Native's `~/.konan`
are cached. Pull requests only read the caches; `main` writes them. The `~/.konan` key is the hash
of the version catalog, with no fallback to older keys, so an old Kotlin/Native is never restored.

The artifacts of this public repository can be downloaded by anyone signed in to GitHub.

## Phase 2: align `Capabilities` with the contract

`Capabilities` still follows the sketch in `docs/NATIVE_PLAN.md`. Before the app fetches real
documents, bring it in line with `docs/contracts/capabilities.md` and the reference implementation
in `contracts/js/capabilities.mjs`:

- [ ] Add `min_api_version` and version negotiation (`negotiate()`), with the "This server needs a
      newer version of the app" outcome.
- [ ] Map unknown enum values to the conservative ones (`semantic` to `off`, `live` to `poll`,
      `ble.mode` to `none`, imports to `device`) and an unknown `tier` to the label `unknown`,
      instead of keeping raw strings or falling back to `demo`.
- [ ] Apply the dependency rules: no people features unless `enabled` and `reports` are both true;
      no presence, meets or GPS bands without presence; no Bluetooth without presence.
- [ ] Add `server-rotate` to `ble.mode`, make `service_uuid` the fixed v1 UUID, and clamp
      `near_rssi`, `window_s` and `sightings_min_interval_s` to the contract's ranges.
- [ ] Accept `talks.bundle_base` only as an https URL ending in `/`.
- [ ] Make `Capabilities.Legacy` equal `legacy-effective.json` (`server-rotate` Bluetooth with a
      10-second interval, `server_search` true, no bundle base).
- [ ] Implement discovery (`/api/capabilities`, then `/capabilities.json`, then `/api/health` only
      after a 404), the per-backend cache, and `caddie://connect` links with the confirmation
      prompt.
- [ ] Run the contract fixtures (`contracts/fixtures/capabilities/*.json`) in `commonTest`.
