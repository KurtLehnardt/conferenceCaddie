# Conference Caddie native apps

This directory holds the native Android and iOS apps: a Kotlin Multiplatform core shared by both
platforms, with the UI written once in Compose Multiplatform. It is a skeleton. The tabs are
placeholders, and the app does not yet talk to a backend. The Capacitor app in `web/android` is
still the Android app people use today.

## Layout

| Path | What it is |
|---|---|
| `shared/` | Kotlin Multiplatform library with no UI. It holds the placeholder models (`Conference`, `Talk`), the `Capabilities` document, `ServerUrl` normalisation, and the platform interfaces `Embedder`, `BleRadio`, `Notifier` and `SecureStore`. Its tests in `commonTest` run on the JVM and on the iOS simulator. |
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
- For iOS: a Mac with Xcode 26 or newer. The first iOS build downloads Kotlin/Native and its dependencies (about 2 GB)
  into `~/.konan`.

## Build and run on Android

From `native/`:

```sh
./gradlew :shared:allTests              # shared tests on the JVM (and on the iOS simulator on a Mac)
./gradlew :androidApp:assembleDebug     # androidApp/build/outputs/apk/debug/androidApp-debug.apk
./gradlew :androidApp:installDebug      # installs on a connected phone or a running emulator
```

You can also open `native/` in Android Studio and run the `androidApp` configuration.

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

A release build is signed with the project's release key when these four environment variables are
all set. When any of them is missing, it falls back to the debug key and Gradle prints a warning.

| Variable | Meaning |
|---|---|
| `ANDROID_KEYSTORE_FILE` | Path to the keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias (`conference-caddie`) |
| `ANDROID_KEY_PASSWORD` | Key password |

Keep the keystore and its passwords out of the repository; `.gitignore` here excludes `*.jks`,
`*.keystore` and `keystore.properties`. Build signed releases with `--no-configuration-cache`, so
the passwords are not written into Gradle's configuration cache:

```sh
./gradlew --no-configuration-cache :androidApp:assembleRelease
```

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

GitHub Actions holds the same key in these repository secrets:

- `ANDROID_KEYSTORE_BASE64`: the keystore file, base64-encoded.
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The Capacitor workflow (`.github/workflows/android-apk.yml`) signs its release APK with the same
key. Both apps share the application id, so once every release is signed with this one key, the
native app can later be installed as an update over the Capacitor app.

Keep a backup of the keystore somewhere safe. If it is lost, no future build can update the
installed apps.

### iOS and TestFlight

The `testflight` job in `.github/workflows/native.yml` archives a Release build, signs it with
automatic signing, and uploads it to App Store Connect with `xcodebuild -exportArchive`
(`iosApp/ExportOptions.plist` sets the destination to upload). It runs only on pushes to `main` and
on manual runs, and only when all of these repository secrets exist:

- `ASC_KEY_ID`: the App Store Connect API key id.
- `ASC_ISSUER_ID`: the issuer id shown above the API keys list.
- `ASC_KEY_P8_BASE64`: the downloaded `AuthKey_<id>.p8` file, base64-encoded.
- `APPLE_TEAM_ID`: the Apple Developer team id.

Before the first upload:

1. Register the bundle id `app.conferencecaddie` in the Apple Developer account, and create the app
   in App Store Connect with that bundle id.
2. Create a team API key in App Store Connect (Users and Access, then Integrations). Automatic
   signing on a fresh CI machine creates its certificates through the API, which needs the Admin
   role.
3. Set the four secrets. The build number is the workflow run number, so each upload is new.

## Pointing the app at a backend

The Server URL field in Settings accepts an address and normalises it: it adds `https://` when no
scheme is given, lowercases the host and drops trailing slashes. Only `http` and `https` are
accepted. In the Android emulator, the host machine is `http://10.0.2.2:<port>`. Android blocks
cleartext `http` by default, so use `https` for anything but local testing; the skeleton does not
configure a cleartext exception.

The skeleton does not fetch anything yet. In Phase 1 the app will read
`GET {server}/api/capabilities` (or `capabilities.json` for the static demo tier) into
`Capabilities`, and a backend without that document will be treated as the legacy full feature set
(`Capabilities.Legacy`). Until then, the "Preview people features" switch in Settings swaps between
the demo and legacy capabilities, to show the People tab appearing and disappearing.

## Continuous integration

`.github/workflows/native.yml` runs on pull requests and on pushes to `main` that touch `native/` or
the workflow itself:

- **Shared tests and Android build** (Ubuntu): `:shared:allTests` and `:androidApp:assembleDebug`,
  with the debug APK kept as an artifact. On pushes to `main` it also builds the signed release APK
  and keeps it as an artifact. It skips that step with a notice when the signing secrets are
  missing.
- **iOS simulator build** (macOS): the shared tests on the iOS simulator and an unsigned simulator
  build of the Xcode project.
- **TestFlight upload** (macOS): described above. It is skipped when its secrets are missing.

Gradle's caches and Kotlin/Native's `~/.konan` are cached between runs.
