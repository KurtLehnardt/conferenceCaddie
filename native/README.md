# Conference Caddie native apps

This directory holds the native Android and iOS apps: a Kotlin Multiplatform core shared by both
platforms, with the UI written once in Compose Multiplatform. It is a skeleton. The tabs are
placeholders, and the app does not yet talk to a backend. The Capacitor app in `web/android` is
still the Android app people use today. The design and the phases these apps follow are in
[`docs/NATIVE_PLAN.md`](../docs/NATIVE_PLAN.md); this skeleton is spike S5 of Phase 0.

## Layout

| Path | What it is |
|---|---|
| `shared/` | Kotlin Multiplatform library with no UI. It holds the placeholder models (`Conference`, `Talk`), the `Capabilities` document, `BackendUrl` (the contract's backend URL rules), and the platform interfaces `Embedder`, `BleRadio`, `Notifier` and `SecureStore`. Its tests in `commonTest` run on the JVM and on the iOS simulator. |
| `composeApp/` | Compose Multiplatform UI. `App()` draws the bottom bar: For you, Search, Interested, People (shown only when `capabilities.people.enabled` is true) and Settings, which has the Server URL field. On iOS this module is built as the `ComposeApp` framework, which also exports `shared`. |
| `androidApp/` | The Android application: `MainActivity` hosts `App()`. |
| `iosApp/` | The Xcode project. A SwiftUI entry point hosts `App()` through `ComposeUIViewController`, and a build phase runs Gradle to build and embed the framework. |
| `gradle/libs.versions.toml` | Every dependency version, with the reasons for the choices. |

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
```

You can also open `native/` in Android Studio and run the `androidApp` configuration.

Release builds run R8 (code shrinking and resource shrinking). Compose, AndroidX and
kotlinx.serialization bring their own keep rules; app-specific rules go in
`androidApp/proguard-rules.pro`. Check a release build on a device after adding anything that uses
reflection.

The native app uses the same application id as the Capacitor app, `app.conferencecaddie`. A phone
cannot have both installed at once. Installing a debug build over a release build, or the other way
round, fails because the two are signed with different keys. Uninstall the other one first.

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
`-Pcaddie.unsignedRelease=true` and keeps the unsigned APK for one day. A separate job signs it.
That job checks out no code and runs no Gradle or npm; it decodes the keystore into the runner's
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

The `testflight` job in `.github/workflows/native.yml` runs on pushes to `main` and manual runs on
`main`, in the `release` environment, and only when all seven secrets below are set there. It:

1. installs an Apple Distribution certificate into a temporary keychain and an App Store
   provisioning profile for `app.conferencecaddie`;
2. archives the Release configuration with manual signing;
3. writes the App Store Connect API key with `umask 077`, exports and uploads the archive with
   `xcodebuild -exportArchive` (`iosApp/ExportOptions.plist` sets the destination to upload), and
   deletes the key;
4. removes the keychain and the profile, whatever happened.

| Secret (environment `release`) | What it is |
|---|---|
| `IOS_DIST_CERT_P12_BASE64` | The Apple Distribution certificate and its private key, exported from Keychain Access as `.p12`, base64-encoded |
| `IOS_DIST_CERT_PASSWORD` | The password chosen for that `.p12` |
| `IOS_APPSTORE_PROFILE_BASE64` | An App Store provisioning profile for `app.conferencecaddie`, base64-encoded |
| `ASC_KEY_ID` | The App Store Connect API key id |
| `ASC_ISSUER_ID` | The issuer id shown above the API keys list |
| `ASC_KEY_P8_BASE64` | The downloaded `AuthKey_<id>.p8` file, base64-encoded |
| `APPLE_TEAM_ID` | The Apple Developer team id |

Before the first upload, register the bundle id `app.conferencecaddie`, create the distribution
certificate and the App Store profile in the Apple Developer account, create the app in App Store
Connect, and create a team API key with the App Manager role (Users and Access, then
Integrations). Upload the secrets with stdin, for example
`base64 -i dist.p12 | gh secret set IOS_DIST_CERT_P12_BASE64 --env release`.

**This job has not run yet**, because the secrets do not exist. Expect the first run on `main` to
need attention; the signing settings it passes are `CODE_SIGN_STYLE=Manual`,
`CODE_SIGN_IDENTITY="Apple Distribution"` and the profile's UUID as
`PROVISIONING_PROFILE_SPECIFIER`.

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
  `SecureStore.scopedKey()` builds it) and an `origin` (shown to the user).
- The parser is stricter than the reference implementation in a few places, listed in
  `BackendUrl.kt`: it refuses backslashes, IPv4 shorthand and other inputs that a WHATWG parser
  quietly repairs.

The skeleton does not fetch anything yet. Until it does, the "Preview people features" switch in
Settings (debug builds only) swaps between the demo and legacy capabilities, to show the People tab
appearing and disappearing. Decision 6 in `docs/NATIVE_PLAN.md` makes the live tier 3 server the
default backend in builds; the skeleton leaves the field empty until the capabilities client
exists.

## Privacy

- Android: `allowBackup` is false, and `data_extraction_rules.xml` excludes every domain from
  cloud backup and device-to-device transfer, because the app will hold per-backend device secrets.
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
  :composeApp:linkReleaseFrameworkIosArm64 :composeApp:linkDebugFrameworkIosSimulatorArm64
```

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
- **iOS simulator build** (macOS): the shared tests on the iOS simulator, the Release device
  framework link, and an unsigned simulator build of the Xcode project.
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
