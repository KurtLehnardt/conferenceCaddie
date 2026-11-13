# Build the apps against your own backend

There are three ways to put Conference Caddie on a phone, and all of them can talk to your own backend instead of the maintainer's:

1. The web app, which needs nothing from you beyond a deployed backend.
2. The Capacitor Android app (`web/android/`), the web app in a native shell with a Bluetooth plugin.
3. The native apps in `native/` for Android and iOS (a Kotlin Multiplatform core with a Compose UI).

This guide needs your own backend ([tier 2](TIER2_CLOUDFLARE.md) or [tier 3](TIER3_GCP_ELASTIC.md), plus [tier 1](TIER1_PAGES.md) for the talk bundles) and a GitHub fork. Everything here is free except one optional item: the Apple Developer Program fee of 99 USD per membership year, which you need only to distribute the iOS app through TestFlight or the App Store. A free Apple ID is enough to run the iOS app from Xcode on your own device, for seven days at a time. Android needs no fee.

A private repository has a monthly GitHub Actions allowance of about 2,000 Linux minutes, and **macOS minutes count ten times as much**. The iOS jobs in `.github/workflows/native.yml` run on macOS, and that workflow also runs on a push to `main` that changes `data/**`, so a private copy can use up its allowance quickly. A public fork has no such limit. If you keep a private copy and do not build the native apps, switch the workflow off: `gh workflow disable native.yml --repo <owner>/<repo>`. See [FORK.md](../FORK.md#private-copies-and-actions-minutes).

## Order of steps

1. Decide which apps you need and how they will find your backend.
2. Point the build at your backend (this page, [Point the apps at your backend](#point-the-apps-at-your-backend)).
3. Android: create a signing key and set the CI secrets, or build locally.
4. iOS: set your team and bundle id, then set up TestFlight if you pay for the program.
5. Optionally configure native push.

## The web app

Tier 2: the Worker serves the app and the API on one origin, so there is nothing to configure. Tier 3: the Cloud Run service serves both. In both cases people open your address in a browser and can add the app to the Home Screen.

## Point the apps at your backend

The apps are built to find a backend in three ways, from least to most effort:

- **No rebuild: the person chooses.** In Settings, Server, a person can type your address, or open a link or QR code of the form `caddie://connect?url=<your backend address, percent-encoded>`. The app shows a confirmation that names the origin and warns that it is not the official server, and only then switches. The link must be https. Phones' camera apps open the link in a QR code, so the apps have no scanner of their own (`native/README.md`, "Links"). You can print such a QR code for your conference.
- **Rebuild with your defaults.** The official apps ship with the maintainer's backend compiled in. For your own builds, change the constants below so a fresh install starts on your backend.
- **Capacitor app: a build variable.** `VITE_API_ORIGIN` names the API origin at build time.

### Constants of the native apps

| What | Where | Value for your build |
|---|---|---|
| The default backend | `Defaults.BACKEND` in `native/shared/src/commonMain/kotlin/app/conferencecaddie/shared/core/CaddieCore.kt` and `BuildDefaults.OFFICIAL_SERVER` in `native/composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/shell/StandaloneShell.kt` | Your tier 2 or tier 3 address, https, no trailing slash. Set both to the same value. |
| The tier 1 fallback, used when the default backend cannot be reached | `Defaults.FALLBACK_BACKEND` | Your Pages site address, for example `https://<owner>.github.io/<repository>` |
| The bundle base for a backend that publishes none | `Defaults.FALLBACK_BUNDLE_BASE` | Your bundle base, ending in `/` |

The Server field accepts only https, with no user name, password, query or fragment; debug builds also accept plain http to localhost and to `10.0.2.2` (`native/README.md`, "Pointing the app at a backend"). After editing, run the shared tests from `native/` with `./gradlew :shared:allTests`.

The release smoke script `native/scripts/release-smoke.sh` checks a release build on a device. It needs `CADDIE_BACKEND` (your server's base URL) and `CADDIE_BUNDLE_BASE` (your bundle base, ending in `/`), and it stops if either is missing, because it must never test the maintainer's server by accident.

### The Capacitor Android app

The Capacitor app calls the API at the origin named by `VITE_API_ORIGIN` when the web app is built (`web/src/native.ts`). In the repository's workflow `.github/workflows/android-apk.yml` that value is set in the `env:` of the `apk` job and names the maintainer's older Cloud Run service. Edit it to your backend address in your fork. To build locally, follow `docs/ANDROID.md`: build the web app with `VITE_API_ORIGIN=https://<your host> npm run build` from `web/`, run `npx cap sync android` and open `web/android` in Android Studio. A push to a branch named `android/**` runs the workflow, and the debug APK is kept as a workflow artifact.

## The application id

Both Android apps and the iOS app use the id `app.conferencecaddie`. An application id is global:

- **iOS: you must change it** to distribute through TestFlight or the App Store, because a bundle id belongs to exactly one Apple team and the maintainer's team owns this one.
- **Android: change it** if you want your build to install beside the official one, or if you ever publish it. Two APKs with the same id but different signing keys cannot update one another, and a phone cannot have both installed.

Change it in every place, choosing an id in a domain you control (for example `org.example.caddie`):

| File | What to change |
|---|---|
| `native/androidApp/build.gradle.kts` | `applicationId` |
| `native/iosApp/Configuration/Config.xcconfig` | `BUNDLE_ID` |
| `.github/workflows/native.yml` | the key `provisioningProfiles:app.conferencecaddie` of the export options |
| `native/scripts/release-smoke.sh` | `PKG` |
| `web/android/app/build.gradle`, `web/capacitor.config.ts` (`appId`) and `web/android/app/src/main/res/values/strings.xml` (`package_name`, `custom_url_scheme`) | the Capacitor app's id |

Leave the Kotlin package names (`app.conferencecaddie...`) and the `namespace` alone. They are code, not the install id. For APNs, set `APNS_BUNDLE_ID` to your id when you deploy tier 3 (see below).

## Android signing

An unsigned or debug-signed build runs on your own phone. For a release APK that people can update in place, you sign every release with one key that you keep. If you lose the key, no future build can update the installed apps, so back the keystore up somewhere safe.

### Create the keystore

Create the keystore outside the repository, in a directory only you can enter, never in the repository root:

```sh
mkdir -m 700 -p ~/.config/conference-caddie
keytool -genkeypair -v -storetype PKCS12 -keystore ~/.config/conference-caddie/release.jks -alias <alias> \
  -keyalg RSA -keysize 4096 -validity 10000
chmod 600 ~/.config/conference-caddie/release.jks
```

`keytool` asks for the passwords and your details itself, so they never appear on a command line. A PKCS12 key uses the same password for the key and the keystore. Print the public certificate fingerprint, which is not secret:

```sh
keytool -list -v -keystore ~/.config/conference-caddie/release.jks -alias <alias> | grep 'SHA256:'
```

### A local signed build

A local release build is signed when all four variables are set; when none is set it falls back to the debug key, and when only some are set the build stops and names the missing ones. Read the passwords inside one shell without printing them. From `native/`:

```sh
(
  export ANDROID_KEYSTORE_FILE="$HOME/.config/conference-caddie/release.jks"
  read -rs ANDROID_KEYSTORE_PASSWORD && export ANDROID_KEYSTORE_PASSWORD     # type it; not shown, not in history
  export ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
  export ANDROID_KEY_ALIAS=<alias>
  ./gradlew --no-configuration-cache :androidApp:assembleRelease
)
```

Use `--no-configuration-cache` so the passwords are not written into Gradle's configuration cache.

### CI secrets, variables and the `release` environment

In CI, Gradle never sees the key. The build job makes an unsigned release APK and an unsigned Android App Bundle for Google Play, and a separate job in the GitHub environment `release` signs both files with the runner's own Android tools and JDK, without checking out or running project code. Create the environment, restrict it to `main`, and add the four secrets there:

**GitHub plan note.** Environments with their own secrets and branch rules are available for private repositories only on a paid GitHub plan (Pro, Team or Enterprise); a public repository has them on every plan. On a **private repository under GitHub Free**, `--env release` does not work. Set the same secrets at repository level (leave out `--env release`; the first run creates an empty `release` environment by itself), and understand the cost: a repository secret can be read by a workflow on any branch that someone with write access pushes, so the signing key is no longer limited to `main`. For that reason a public fork is the better home for signing keys, or keep the keys off GitHub and sign locally.

```sh
gh api -X PUT repos/<owner>/<repo>/environments/release --input - <<'EOT'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
EOT
gh api -X POST repos/<owner>/<repo>/environments/release/deployment-branch-policies -f name=main

base64 < ~/.config/conference-caddie/release.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --env release --repo <owner>/<repo>
gh secret set ANDROID_KEYSTORE_PASSWORD --env release --repo <owner>/<repo>     # prompts; type or paste the value, which is not echoed
gh secret set ANDROID_KEY_ALIAS --env release --repo <owner>/<repo>
gh secret set ANDROID_KEY_PASSWORD --env release --repo <owner>/<repo>
gh variable set ANDROID_RELEASE_CERT_SHA256 --repo <owner>/<repo> --body "<the SHA256 fingerprint>"
```

You can also create the environment and its branch rule in the repository settings, under Environments. The signing jobs fail unless the signed APK's certificate, and the bundle's, matches the repository variable `ANDROID_RELEASE_CERT_SHA256`, which is how a wrong key is caught. When the secrets are missing, the signing step is skipped with a notice and the debug and unsigned builds still work. Both workflows (`android-apk.yml` and `native.yml`) sign on `main` only, and a manual run of `android-apk.yml` on `main` produces a signed release APK.

Never print a secret in a log, never `echo` it and never store the keystore in the repository; both `.gitignore` files exclude `*.jks`, `*.keystore`, `*.p8` and `*.p12`.

## Google Play

Publishing on Google Play is optional; the signed APK from CI works without it. Google Play needs a developer account (a one-time fee of 25 USD), an application id of your own (see [The application id](#the-application-id); `app.conferencecaddie` belongs to the maintainer's Play account), and a privacy policy address. [docs/store/PLAY.md](../store/PLAY.md) has the store listing, the Data safety and content rating answers, and the steps for internal testing.

### The app bundle

Play takes an Android App Bundle, not an APK. Every run of `native.yml` builds one with `-Pcaddie.unsignedRelease=true :androidApp:bundleRelease`, and on `main` the sign job signs it with the same key as the APK and keeps it as the artifact `conference-caddie-native-<commit>-release.aab` for 30 days. To build one locally, from `native/`:

```sh
./gradlew :androidApp:bundleRelease     # signed with the debug key
```

To sign it with your key, run `./gradlew --no-configuration-cache :androidApp:bundleRelease` inside the subshell of [A local signed build](#a-local-signed-build), in place of `assembleRelease`, so the passwords are not written into Gradle's configuration cache. The bundle is `androidApp/build/outputs/bundle/release/androidApp-release.aab`.

- **Every ABI.** The APK holds only arm64-v8a, but the bundle holds all four ABIs that ONNX Runtime ships (arm64-v8a, armeabi-v7a, x86 and x86_64), because Play builds one APK per device from it and each device downloads only its own native libraries, about 38 to 42 MB in all. The bundle file itself is about 141 MB, half of it native debug symbols and the R8 mapping, which Play keeps for crash reports and never sends to phones.
- **Separate Gradle runs.** The Android Gradle plugin refuses to build a bundle while the APK's ABI splits are on, so a Gradle run that asks for a bundle task turns them off (`native/androidApp/build.gradle.kts`). Build APKs and the bundle in separate runs; in one run together, the APKs would not be split.
- **16 KB pages.** Play refuses an app that targets Android 15 or newer when its 64-bit native libraries are not aligned for 16 KB memory pages. CI checks every arm64-v8a and x86_64 library in the bundle.
- **Version codes.** The APK and the bundle of one run share the version code 1000 plus the run number. Play refuses a version code it has seen, so upload the bundle of a newer run each time.

### Play App Signing

Play signs the APKs it delivers with an **app signing key**, and checks every bundle you upload against an **upload key**. The recommended setup, and the one this project uses, is that Google generates and keeps the app signing key and your `release.jks` becomes the upload key. When you create the app in Play Console and upload the first bundle, accept "Let Google create and manage my app signing key". Then:

- If the upload key is lost or leaks, Google can register a new one after you ask in Play Console, and installed apps keep updating. A lost app signing key could never be replaced.
- **An app installed from Play and an APK from GitHub Releases cannot update each other.** Play's copy is signed with Google's app signing key and the GitHub APK with `release.jks`, so Android refuses to install one over the other. To switch, uninstall the app first, which deletes its data on the phone: the talks you marked, the people you met, and the device secret of a profile, which can then no longer be edited or deleted from the phone and stays on the server until its conference ends. Delete the profile in the app first if it should go at once.

The alternative, for one key everywhere: choose "Use existing app signing key from Java keystore" and upload `release.jks` as the app signing key with the PEPK tool that Play Console offers, which encrypts the key for Google. Play-installed and GitHub-installed apps can then update each other. The cost is that the key you share with every channel can no longer be replaced if it leaks. Play recommends a separate upload key in that case, but it accepts the app signing key as the upload key too. Keeping `release.jks` as both leaves the CI sign job as it is; a separate upload key would need the job to sign the bundle with that key and the APK with `release.jks`, which it does not do today. Decide before the first upload: Play fixes the app signing key then and afterwards offers only a limited key upgrade.

### The privacy policy

The Pages workflow publishes the apps' privacy policy at `https://<owner>.github.io/<repository>/privacy.html`, generated by `scripts/lib/privacy-page.mjs`. Its contacts are your repository's issues and, when you set the repository variable `CADDIE_PRIVACY_EMAIL`, that address. The rest describes the maintainer's deployment, including which providers host the server and where, and a test fails when the server it names differs from `Defaults.BACKEND`. Before you publish your own build, rewrite the service providers section for your hosting, check the retention it states against your deployment, and point `Strings.Settings.PRIVACY_URL` (`native/composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/strings/Strings.kt`), which Settings opens, at your page.

## iOS: your Apple team, bundle id and device builds

You need a Mac with Xcode 26 or newer. The first iOS build downloads Kotlin/Native and its dependencies, about 2 GB, into `~/.konan`.

1. Change the bundle id in `native/iosApp/Configuration/Config.xcconfig` as above.
2. Copy `native/iosApp/Configuration/Local.xcconfig.example` to `native/iosApp/Configuration/Local.xcconfig` and set `TEAM_ID` to your Apple team id, shown at https://developer.apple.com/account under Membership details. Git ignores that file, so no team id is ever committed.
3. Open `native/iosApp/iosApp.xcodeproj`, pick a simulator or your device and press Run. Simulator builds need no signing.

**With a free Apple ID (a personal team).** A free Apple ID can run the app on your own device for seven days at a time, but a personal team cannot use the Push Notifications capability. The app is built with the entitlement `aps-environment` (`native/iosApp/iosApp/iosApp.entitlements`), which Xcode then refuses to sign. Build without the entitlement, and do not commit that change. Either remove the Push Notifications capability in Xcode (target `iosApp`, Signing & Capabilities) on your own machine and leave the resulting changes to the entitlements file and project out of your commits (`git checkout` them afterwards), or override the setting on the command line:

```sh
xcodebuild -project native/iosApp/iosApp.xcodeproj -scheme iosApp -configuration Debug \
  -destination 'generic/platform=iOS' DEVELOPMENT_TEAM=<your team id> CODE_SIGN_ENTITLEMENTS= build
```

An app built this way runs and works, but it cannot receive native push. Push needs the paid program.

To build from the command line for a simulator:

```sh
xcodebuild -project native/iosApp/iosApp.xcodeproj -scheme iosApp \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

## iOS: TestFlight setup (paid Apple Developer Program)

TestFlight builds run on a push to `main` or a manual run on `main`, and only when all seven secrets below exist in the `release` environment. The job `testflight-gate` checks for them and skips the three TestFlight jobs with a notice when one is missing, so the workflow stays green without them. These jobs run on macOS runners (see the minutes warning above).

Do these once, in this order:

1. Enroll in the Apple Developer Program (99 USD a year, https://developer.apple.com/programs/enroll/).
2. In Certificates, Identifiers & Profiles, register your bundle id with the **Push Notifications** capability enabled. The app is signed with the `aps-environment` entitlement (`native/iosApp/iosApp/iosApp.entitlements`), so a profile without it cannot sign the archive.
3. Create an Apple Distribution certificate, and export it from Keychain Access as a `.p12` file with a password you choose.
4. Create an App Store provisioning profile for your bundle id with that certificate. If you made the App ID before enabling Push Notifications, enable it and regenerate the profile.
5. In App Store Connect, create the app, and create a team API key with the App Manager role (Users and Access, Integrations). Download the `AuthKey_<id>.p8` file; Apple lets you download it once.
6. Create the seven secrets in the environment `release`, passing each file through standard input:

| Secret | Used by | What it is |
|---|---|---|
| `IOS_DIST_CERT_P12_BASE64` | `ios-sign` | The distribution certificate and its private key as `.p12`, base64-encoded |
| `IOS_DIST_CERT_PASSWORD` | `ios-sign` | The password you chose for that `.p12` |
| `IOS_APPSTORE_PROFILE_BASE64` | `ios-sign` | The App Store provisioning profile for your bundle id, base64-encoded |
| `APPLE_TEAM_ID` | `ios-sign` | Your Apple team id |
| `ASC_KEY_ID` | `testflight-upload` | The App Store Connect API key id |
| `ASC_ISSUER_ID` | `testflight-upload` | The issuer id shown above the API keys list |
| `ASC_KEY_P8_BASE64` | `testflight-upload` | The `AuthKey_<id>.p8` file, base64-encoded |

```sh
base64 < dist.p12 | tr -d '\n' | gh secret set IOS_DIST_CERT_P12_BASE64 --env release --repo <owner>/<repo>
base64 < appstore.mobileprovision | tr -d '\n' | gh secret set IOS_APPSTORE_PROFILE_BASE64 --env release --repo <owner>/<repo>
base64 < AuthKey_<id>.p8 | tr -d '\n' | gh secret set ASC_KEY_P8_BASE64 --env release --repo <owner>/<repo>
gh secret set IOS_DIST_CERT_PASSWORD --env release --repo <owner>/<repo>
gh secret set APPLE_TEAM_ID --env release --repo <owner>/<repo>
gh secret set ASC_KEY_ID --env release --repo <owner>/<repo>
gh secret set ASC_ISSUER_ID --env release --repo <owner>/<repo>
```

7. Delete the downloaded `.p8` and `.p12` files, or move them into a password manager.

The next push to `main`, or a manual run of the `Native apps` workflow on `main`, then builds the Release framework with no secrets (`ios-release-build`), signs the app with the certificate and no Gradle (`ios-sign`), and uploads the signed file with the API key and no checkout (`testflight-upload`). The build appears in TestFlight once Apple has processed it. Build numbers are 1000 plus the workflow run number, and App Store Connect refuses a number it has seen, so a re-run of the same run fails at upload: start a new run instead. `native/README.md`, "iOS and TestFlight", has the troubleshooting notes, for example for `errSecInternalComponent`. These jobs have not been run end to end by the maintainer, so expect the first run to need attention.

## Optional: native push from your own backend

Native push is off by default and a fork does not need it. Web Push (the notifications of the web app) works on tier 2 and tier 3 without any of this.

- **Tier 2.** The Worker sends Web Push only. Native push to the iOS and Android apps is a tier 3 feature (`push.apns` and `push.fcm` in `GET /api/capabilities` are false on tier 2).
- **Tier 3, APNs.** In Apple Developer, Keys, create a key with the Apple Push Notifications service enabled, and download `AuthKey_<KEY ID>.p8` (once). Store the file as the secret `caddie-apns-key` and the string `<KEY ID> <TEAM ID>` as the secret `caddie-apns-ids` in your Google Cloud project, then deploy with `NATIVE_PUSH_APNS=1` and, if you changed the bundle id, `APNS_BUNDLE_ID=<your bundle id>`. The exact `gcloud secrets create` commands and the rotation steps are in step 7a of `docs/OPERATOR_CHECKLIST.md`; use your own project id there. The key serves both the sandbox and the production environment.
- **Tier 3, FCM.** There is no key to store. The service sends with the access token of the runtime service account `caddie-runtime`, which needs the role Firebase Cloud Messaging API Admin on your Firebase project (step 7a of the checklist). Set `FCM_PROJECT_ID` in `deploy.env` and deploy with `NATIVE_PUSH_FCM=1`. The native Android app has no Firebase and gets no native push by design (`DECISIONS.md`); FCM matters only for a Capacitor build that you give your own `google-services.json` (at `web/android/app/google-services.json`; `web/android/.gitignore` ignores that file name, and `git check-ignore -v web/android/app/google-services.json` confirms it before you commit anything).

## What an installed app does when the operator changes things

These behaviours are what an installed app shows after an operator action, checked against the code of this repository. The CLI guide refers to them.

- **A conference leaves `conferences.json`.** The apps keep the last good copy of `conferences.json` per backend address and use it offline, and they fetch a new one with an ETag (`BundleSync.kt`, the header comment of `native/shared/src/commonMain/kotlin/app/conferencecaddie/shared/bundle/BundleSync.kt`). A bundle that is already installed stays in use until a newer one replaces it; the previous bundle's folder is deleted only after a new one is installed. A review of the shared code found nothing that deletes an installed bundle because its conference left the list, so a person who already opened the conference can keep reading its schedule on that device. The conference disappears from the list when the app next refreshes the index. For the people features the server decides: see the next two points.
- **The operator deleted a person's profile.** Every people call that needs the profile then answers `403 profile_required` (tier 2: `profileRequired` in `worker/src/connect/common.js`; tier 3: `profileRequired` in `server/connect.mjs`, and the 404-to-403 mapping in `server/people.mjs`). The web app and the native apps treat that code as "no profile here any more": the web client empties its local inbox (`web/src/people/connect.ts`), the push code reports that a profile is needed (`web/src/people/push.ts`, `PeopleController.kt`), and the screens say "Make your profile visible first." (`native/shared/src/commonMain/kotlin/app/conferencecaddie/shared/people/PeopleText.kt`). The person can create a new profile. Whether an app also clears its own stored copy of the profile was not verified.
- **Tier 2 after a conference is removed.** The Worker caches its list of conferences for up to five minutes (`DIRECTORY_TTL_MS` in `worker/src/index.js`). During that time a request can still be routed to the conference's object, which has no document any more and answers `400 conference is not available` (`worker/src/conference.js`, the "conference is not available" answer for an object without a conference). After the cache expires, the Worker answers the same from the directory (`worker/src/index.js`, in the admin routing, where the directory is read fresh). Clients show the conference as unavailable.
- **Tier 3 after a conference is removed.** The server keeps its conference list for 60 seconds (`TTL_MS` in `server/conferences.mjs`). After that, `searchableConference` finds nothing and the people routes answer `conference is not available` (`server/people.mjs`, where the conference is looked up).

## Next

[ADMIN_CLI.md](../ADMIN_CLI.md) describes how to operate the backend your apps talk to.
