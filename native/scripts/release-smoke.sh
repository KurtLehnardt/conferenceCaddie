#!/usr/bin/env bash
# Starts the release build (R8 code and resource shrinking on) on a connected device or emulator and
# checks that it runs: the app starts and stays up, nothing crashes, the shell's tab bar is on
# screen, the Settings gear opens Settings, and a search that only meaning-based matching can answer
# finds talks, so the query model loads and runs under R8. It catches code that R8 removed or renamed
# but that is still needed at run time, which the debug build's tests cannot see. It also checks the
# installed package for ONNX Runtime's telemetry provider and the network-state permission, which
# the manifest removes.
#
# The search uses the official server and the published talk bundles, as a new install does, so the
# device needs a connection.
#
# Usage, from native/, after ./gradlew :androidApp:assembleRelease (signed with the debug key when
# no release key is set, so any device accepts it):
#   scripts/release-smoke.sh [path/to/release.apk]
# Without a path it takes the APK of the device's ABI. With several devices connected, pick one with
# ANDROID_SERIAL. The app is uninstalled first, because a debug build signed with another key cannot
# be replaced in place.
set -euo pipefail

PKG=app.conferencecaddie
ADB="${ADB:-adb}"
ABI=$("$ADB" shell getprop ro.product.cpu.abi | tr -d '\r')
APK="${1:-androidApp/build/outputs/apk/release/androidApp-$ABI-release.apk}"
# Letters that are in no talk, so keyword search finds nothing and every result comes from meaning.
MEANING_ONLY_QUERY="qzxv wplkj"

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

app_running() {
  local pid
  pid=$("$ADB" shell pidof "$PKG" | tr -d '\r') || true
  [ -n "$pid" ]
}

# Waits up to $1 seconds for the screen to show $2 (an extended regular expression on the UI dump).
wait_for() {
  local deadline=$((SECONDS + $1)) xml
  while [ "$SECONDS" -lt "$deadline" ]; do
    xml=$(ui_dump)
    if grep -qE "$2" <<<"$xml"; then return 0; fi
    sleep 2
  done
  return 1
}

[ -f "$APK" ] || fail "No release APK at $APK."
"$ADB" uninstall "$PKG" >/dev/null 2>&1 || true
"$ADB" install "$APK" >/dev/null
"$ADB" logcat -c

package=$("$ADB" shell dumpsys package "$PKG")
if grep -qF "android.permission.ACCESS_NETWORK_STATE" <<<"$package"; then
  fail "The release build requests ACCESS_NETWORK_STATE, which ONNX Runtime's AAR adds and the manifest must remove."
fi
if grep -qiF "onnxruntime" <<<"$package"; then
  fail "The release build registers an ONNX Runtime component (its telemetry provider), which the manifest must remove."
fi

"$ADB" shell am start -W -n "$PKG/.MainActivity" >/dev/null
sleep 5
app_running || fail "The release build is not running five seconds after it started."
screen_has 'text="Search"' || fail "The release build does not show the tab bar."

gear=$(centre_of content-desc Settings) || true
[ -n "$gear" ] || fail "The release build shows no Settings gear."
# shellcheck disable=SC2086
"$ADB" shell input tap $gear
sleep 2
# "APPEARANCE" is the first group heading of Settings, and nothing else shows it.
screen_has 'text="APPEARANCE"' || fail "The Settings gear did not open Settings in the release build."
"$ADB" shell input keyevent KEYCODE_BACK
sleep 2
if screen_has 'text="APPEARANCE"'; then
  fail "Back did not leave Settings in the release build."
fi
screen_has 'text="Search"' || fail "The release build does not show the tab bar after Back."

# The search tab, once the default conference's bundle is installed ("All talks · N").
tab=$(centre_of text Search) || true
[ -n "$tab" ] || fail "The release build shows no Search tab."
# shellcheck disable=SC2086
"$ADB" shell input tap $tab
wait_for 90 'text="All talks · [0-9]+"' || fail "The release build did not show a conference's talks within 90 seconds (it needs a connection)."
field=$(centre_of class android.widget.EditText) || true
[ -n "$field" ] || fail "The release build shows no search field."
# shellcheck disable=SC2086
"$ADB" shell input tap $field
"$ADB" shell input text "${MEANING_ONLY_QUERY// /%s}"
"$ADB" shell input keyevent KEYCODE_ENTER
# Keywords alone find nothing; once the model has loaded, the search runs again and finds talks.
if ! wait_for 60 'text="[1-9][0-9]* talks?"'; then
  if screen_has "Meaning-based matching is not available"; then
    fail "Meaning-based matching is not available in the release build: the query model did not load or run under R8."
  fi
  fail "A search that only meaning-based matching can answer found no talks in the release build."
fi

app_running || fail "The release build stopped."
crashes=$("$ADB" logcat -d -b crash) || true
if grep -qF "$PKG" <<<"$crashes"; then
  fail "The release build crashed."
fi
echo "Release smoke test passed: the R8 release build starts, shows the shell, opens and leaves Settings, and finds talks by meaning alone."
