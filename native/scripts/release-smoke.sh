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
  local log
  log=$("$ADB" logcat -d -b crash,main -t 200) || true
  grep -E "AndroidRuntime|$PKG" <<<"$log" | tail -n 60 || true
  exit 1
}

# The current screen's UI dump. It is captured whole before anything greps it: with pipefail, a
# grep -q that stops reading early would make the producer fail with SIGPIPE.
ui_dump() {
  "$ADB" shell uiautomator dump /sdcard/caddie-ui.xml >/dev/null
  "$ADB" shell cat /sdcard/caddie-ui.xml
}

# Prints the bounds centre ("x y") of the first node whose attribute $1 equals $2, or nothing.
centre_of() {
  local xml line
  xml=$(ui_dump)
  line=$(tr '>' '\n' <<<"$xml" | grep -F "$1=\"$2\"") || return 0
  line=${line%%$'\n'*}
  sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p' <<<"$line" |
    awk '{ printf "%d %d\n", ($1 + $3) / 2, ($2 + $4) / 2 }'
}

screen_has() {
  local xml
  xml=$(ui_dump)
  grep -qF "$1" <<<"$xml"
}

# Whether Settings shows: its first group heading is on screen, "YOU" when the server offers people
# features and "APPEARANCE" without them, and nothing else shows either. On a small screen the
# people groups push Appearance below the fold.
settings_shown() {
  local xml
  xml=$(ui_dump)
  grep -qF 'text="YOU"' <<<"$xml" || grep -qF 'text="APPEARANCE"' <<<"$xml"
}

app_running() {
  local pid
  pid=$("$ADB" shell pidof "$PKG" | tr -d '\r') || true
  [ -n "$pid" ]
}

[ -f "$APK" ] || fail "No release APK at $APK."
"$ADB" uninstall "$PKG" >/dev/null 2>&1 || true
"$ADB" install "$APK" >/dev/null
"$ADB" logcat -c

"$ADB" shell am start -W -n "$PKG/.MainActivity" >/dev/null
sleep 5
app_running || fail "The release build is not running five seconds after it started."
screen_has 'text="Search"' || fail "The release build does not show the tab bar."

gear=$(centre_of content-desc Settings) || true
[ -n "$gear" ] || fail "The release build shows no Settings gear."
# shellcheck disable=SC2086
"$ADB" shell input tap $gear
sleep 2
settings_shown || fail "The Settings gear did not open Settings in the release build."
"$ADB" shell input keyevent KEYCODE_BACK
sleep 2
if settings_shown; then
  fail "Back did not leave Settings in the release build."
fi
screen_has 'text="Search"' || fail "The release build does not show the tab bar after Back."

app_running || fail "The release build stopped."
crashes=$("$ADB" logcat -d -b crash) || true
if grep -qF "$PKG" <<<"$crashes"; then
  fail "The release build crashed."
fi
echo "Release smoke test passed: the R8 release build starts, shows the shell, and opens and leaves Settings."
