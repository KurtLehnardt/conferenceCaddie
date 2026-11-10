#!/usr/bin/env bash
# Starts the release build (R8 code and resource shrinking on) on a connected device or emulator and
# checks that it runs: the app starts and stays up, nothing crashes, the shell's tab bar is on
# screen, and the Settings gear opens Settings. It catches code that R8 removed or renamed but that
# is still needed at run time, which the debug build's tests cannot see.
#
# Usage, from native/, after ./gradlew :androidApp:assembleRelease (signed with the debug key when
# no release key is set, so any device accepts it):
#   scripts/release-smoke.sh [path/to/release.apk]
# With several devices connected, pick one with ANDROID_SERIAL. The app is uninstalled first,
# because a debug build signed with another key cannot be replaced in place.
set -euo pipefail

APK="${1:-androidApp/build/outputs/apk/release/androidApp-release.apk}"
PKG=app.conferencecaddie
ADB="${ADB:-adb}"

fail() {
  echo "::error title=Release smoke test::$1"
  "$ADB" logcat -d -b crash,main -t 200 | grep -E "AndroidRuntime|$PKG" | tail -n 60 || true
  exit 1
}

# Prints the bounds centre ("x y") of the first node whose attribute $1 equals $2, from a UI dump.
centre_of() {
  "$ADB" shell uiautomator dump /sdcard/caddie-ui.xml >/dev/null
  "$ADB" shell cat /sdcard/caddie-ui.xml | tr '>' '\n' | grep -F "$1=\"$2\"" | head -n 1 |
    sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' |
    awk '{ printf "%d %d\n", ($1 + $3) / 2, ($2 + $4) / 2 }'
}

screen_has() {
  "$ADB" shell uiautomator dump /sdcard/caddie-ui.xml >/dev/null
  "$ADB" shell cat /sdcard/caddie-ui.xml | grep -qF "$1"
}

[ -f "$APK" ] || fail "No release APK at $APK."
"$ADB" uninstall "$PKG" >/dev/null 2>&1 || true
"$ADB" install "$APK" >/dev/null
"$ADB" logcat -c

"$ADB" shell am start -W -n "$PKG/.MainActivity" >/dev/null
sleep 5
[ -n "$("$ADB" shell pidof "$PKG" | tr -d '\r')" ] || fail "The release build is not running five seconds after it started."
screen_has 'text="Search"' || fail "The release build does not show the tab bar."

gear=$(centre_of content-desc Settings)
[ -n "$gear" ] || fail "The release build shows no Settings gear."
# shellcheck disable=SC2086
"$ADB" shell input tap $gear
sleep 2
screen_has 'text="APPEARANCE"' || fail "The Settings gear did not open Settings in the release build."
"$ADB" shell input keyevent KEYCODE_BACK
sleep 2
screen_has 'text="Search"' || fail "Back did not leave Settings in the release build."

[ -n "$("$ADB" shell pidof "$PKG" | tr -d '\r')" ] || fail "The release build stopped."
if "$ADB" logcat -d -b crash | grep -qF "$PKG"; then
  fail "The release build crashed."
fi
echo "Release smoke test passed: the R8 release build starts, shows the shell and opens Settings."
