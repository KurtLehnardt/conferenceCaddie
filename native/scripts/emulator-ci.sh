#!/usr/bin/env bash
# The steps of "UI tests on an Android emulator" (.github/workflows/native.yml) that make the job
# survive failures of the machine and the emulator, without ever passing a failing test.
#
#   cache-name   Names the system image's cache: its directory and the key prefix (step outputs
#                `dir` and `prefix`).
#   install      Installs the emulator and the system image that the emulator steps use. Each
#                package is tried up to three times, with a pause, and the partial downloads are
#                deleted between tries. sdkmanager checks every download against its checksum and
#                nothing here turns that off. Writes the cache key of the installed system image's
#                revision (step output `key`).
#   run N        Attempt N, the script of reactivecircus/android-emulator-runner: checks that the
#                emulator answers, runs the UI tests, then the release smoke test, and records what
#                happened in $RUNNER_TEMP/emu-attempt-N for `triage`.
#   triage N     After attempt N failed, decides whether it is retried (step output `retry`) and
#                says why in the log, as an annotation and in the job summary.
#   cleanup      Before the retry's emulator starts: stops what is left of the first emulator.
#   discard-avd  After the step that makes the snapshot failed: stops its emulator and deletes the
#                AVD, so attempt 1 creates it again with the same settings and cold-boots it.
#
# Only an infrastructure failure is retried, once:
#   - the emulator step failed before the tests started (the SDK setup, or the emulator did not
#     boot), including the step that makes the snapshot, which is then neither saved nor used;
#   - the emulator booted but did not answer adb and its package manager within 120 seconds;
#   - Gradle failed, its output has adb's AdbCommandRejectedException "device offline" or "closed"
#     or the emulator process had died, and no test failed.
# "No test failed" means no failure or error in the JUnit XML, no "(N failed)" above 0, no
# "There was/were N failure(s)" above 0, no line with FAILED other than Gradle's own task and build
# lines, and no "Process crashed", "Instrumentation run failed" or "Test run failed to complete" in
# Gradle's output. A failing test is never retried, even when an infrastructure error came with it. A
# failure of the release smoke test is never retried. The retry runs every test and the smoke test
# again, on a cold-booted emulator with wiped data.
set -euo pipefail

# The system image of the emulator steps (api-level, target and arch in native.yml) and their
# channel ("stable", channel 0). Change them together.
API=34
TARGET=default
ARCH=x86_64
CHANNEL=0
SYSTEM_IMAGE="system-images;android-$API;$TARGET;$ARCH"
TRIES=3
HEALTH_SECONDS=120
SERIAL="${ANDROID_SERIAL:-emulator-5554}"
# The action's default AVD name, which the emulator steps keep.
AVD_NAME="test"
TMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
# The emulator's QEMU process (qemu-system-x86_64, or its -headless variant).
EMULATOR_PROCESS='qemu-system-'

sdk_root() { printf '%s' "${ANDROID_HOME:?ANDROID_HOME is not set}"; }
sysimg_dir() { printf '%s/system-images/android-%s/%s/%s' "$(sdk_root)" "$API" "$TARGET" "$ARCH"; }
key_prefix() { printf 'android-sysimg-%s-android-%s-%s-%s-r' "${RUNNER_OS:-local}" "$API" "$TARGET" "$ARCH"; }
attempt_dir() { printf '%s/emu-attempt-%s' "$TMP_ROOT" "$1"; }

# Step outputs and the job summary. Only fixed text and numbers are written to them, never a line
# of a tool's output.
output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi
  printf 'output %s=%s\n' "$1" "$2"
}
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi
}

check_attempt() {
  case "${1:-}" in
    1 | 2) ;;
    *) echo "Usage: $0 run|triage 1|2" >&2; exit 2 ;;
  esac
}

# --- install -------------------------------------------------------------------------------------

# The sdkmanager the emulator action runs (it puts cmdline-tools/latest first on the PATH), so both
# agree on what is up to date.
sdkmanager_bin() {
  local latest
  latest="$(sdk_root)/cmdline-tools/latest/bin/sdkmanager"
  if [ -x "$latest" ]; then
    printf '%s' "$latest"
  else
    command -v sdkmanager
  fi
}

# What a failed sdkmanager run can leave behind: its downloads under .temp (and
# .downloadIntermediates, where some versions keep partial downloads to resume them), and a system
# image directory without the package.xml that every installed package has (a partial restore).
delete_partial_downloads() {
  local root dir
  root=$(sdk_root)
  rm -rf "$root/.temp" "$root/.downloadIntermediates"
  dir=$(sysimg_dir)
  if [ -d "$dir" ] && [ ! -f "$dir/package.xml" ]; then
    echo "Deleting $dir, which has no package.xml."
    rm -rf "$dir"
  fi
}

install_package() {
  local pkg=$1 sdkmanager=$2 try log
  for try in $(seq 1 "$TRIES"); do
    log="$TMP_ROOT/emu-sdkmanager-$try.log"
    # SCRATCH (reverted before merge): try 1 of the system image leaves a partial download in .temp
    # and uses a bad package name.
    local name=$pkg
    if [ "$try" -eq 1 ] && [ "$pkg" = "$SYSTEM_IMAGE" ]; then
      mkdir -p "$(sdk_root)/.temp/PackageOperation99"; echo junk > "$(sdk_root)/.temp/PackageOperation99/partial.zip"
      name="$pkg-scratch-bad-name"
    fi
    if "$sdkmanager" --install "$name" --channel="$CHANNEL" < /dev/null > "$log" 2>&1; then
      echo "$pkg is installed and up to date (try $try of $TRIES)."
      if [ "$try" -gt 1 ]; then
        echo "::warning title=Android SDK download retried::$pkg was installed on try $try of $TRIES."
        summary "- Android SDK: \`$pkg\` was installed on try $try of $TRIES."
      fi
      return 0
    fi
    echo "sdkmanager could not install $pkg (try $try of $TRIES). Its last lines:"
    # Without the progress bars.
    tr '\r' '\n' < "$log" | grep -vE '^[[:space:]]*(\[[= ]*\].*)?$' | tail -n 15 || true
    delete_partial_downloads
    echo "SCRATCH: after the deletion, .temp is: $(ls -A "$(sdk_root)/.temp" 2>&1 || true)"
    if [ "$try" -lt "$TRIES" ]; then
      echo "Trying again in $((try * 30)) seconds."
      sleep $((try * 30))
    fi
  done
  echo "::error title=Android SDK download failed::sdkmanager could not install $pkg in $TRIES tries."
  return 1
}

cmd_cache_name() {
  output dir "$(sysimg_dir)"
  output prefix "$(key_prefix)"
}

cmd_install() {
  local sdkmanager dir rev
  sdkmanager=$(sdkmanager_bin)
  dir=$(sysimg_dir)
  # SCRATCH (reverted before merge): a system image directory without package.xml, as a partial
  # cache restore would leave.
  mkdir -p "$dir"; echo junk > "$dir/system.img"
  delete_partial_downloads
  if [ -f "$dir/package.xml" ]; then
    echo "The system image is here (restored from the cache); sdkmanager only checks for an update."
  fi
  install_package emulator "$sdkmanager"
  install_package "$SYSTEM_IMAGE" "$sdkmanager"
  rev=$(sed -n 's/^Pkg\.Revision=\([0-9][0-9.]*\)[[:space:]]*$/\1/p' "$dir/source.properties" 2> /dev/null | head -n 1 || true)
  if [ -z "$rev" ]; then
    echo "::warning title=System image not cached::The revision of $SYSTEM_IMAGE could not be read, so this run does not save it to the cache."
    output key ""
    return 0
  fi
  echo "$SYSTEM_IMAGE is at revision $rev."
  output key "$(key_prefix)$rev"
}

# --- run -----------------------------------------------------------------------------------------

adb_quiet() { timeout 15 adb -s "$SERIAL" "$@" 2> /dev/null | tr -d '\r' || true; }

emulator_alive() { pgrep -f "$EMULATOR_PROCESS" > /dev/null; }

# The emulator step already waited for sys.boot_completed. This also waits, for a bounded time, for
# adb to call the device online and for the package manager, which the test APKs' install needs.
wait_until_healthy() {
  local deadline=$((SECONDS + HEALTH_SECONDS)) state boot pm
  while [ "$SECONDS" -lt "$deadline" ]; do
    state=$(adb_quiet get-state)
    if [ "$state" = device ]; then
      boot=$(adb_quiet shell getprop sys.boot_completed)
      pm=$(adb_quiet shell pm path android)
      if [ "$boot" = 1 ] && [[ "$pm" == package:* ]]; then
        echo "The emulator is online, has booted, and its package manager answers."
        return 0
      fi
    fi
    sleep 3
  done
  return 1
}

record_device() {
  local dir=$1
  {
    echo "adb devices:"
    timeout 15 adb devices 2>&1 || true
    echo "adb get-state: $(adb_quiet get-state)"
  } > "$dir/device.txt"
  if emulator_alive; then echo alive > "$dir/emulator-process"; else echo gone > "$dir/emulator-process"; fi
  echo "After the failure: emulator process $(cat "$dir/emulator-process")."
  cat "$dir/device.txt"
}

# Attempt N's results, kept for triage and for the artifact: the retry overwrites the build's.
keep_results() {
  local dir=$1 module
  for module in composeApp androidApp; do
    mkdir -p "$dir/$module"
    if [ -d "$module/build/outputs/androidTest-results" ]; then
      cp -R "$module/build/outputs/androidTest-results" "$dir/$module/" || true
    fi
    if [ -d "$module/build/reports/androidTests" ]; then
      cp -R "$module/build/reports/androidTests" "$dir/$module/" || true
    fi
  done
}

cmd_run() {
  local attempt=$1 dir status
  check_attempt "$attempt"
  dir=$(attempt_dir "$attempt")
  rm -rf "$dir"
  mkdir -p "$dir"
  : > "$dir/started"
  if [ "$attempt" -gt 1 ]; then
    echo "Attempt $attempt, the infrastructure retry, on a cold-booted emulator with wiped data."
  fi

  if ! wait_until_healthy; then
    : > "$dir/unhealthy"
    record_device "$dir"
    echo "::error title=Emulator not ready (attempt $attempt)::The emulator did not come online with a working package manager within $HEALTH_SECONDS seconds."
    return 1
  fi

  set +e
  ./gradlew :composeApp:connectedAndroidDeviceTest :androidApp:connectedDebugAndroidTest 2>&1 | tee "$dir/gradle.log"
  status=${PIPESTATUS[0]}
  set -e
  echo "$status" > "$dir/gradle.exit"
  if [ "$status" -ne 0 ]; then
    # SCRATCH (reverted before merge): the emulator dies right after the failing test, so attempt 1
    # also has an infrastructure signal.
    if [ "$attempt" = 1 ]; then
      echo "SCRATCH: killing the emulator process"
      pkill -9 -f "$EMULATOR_PROCESS" || true
      sleep 2
    fi
    record_device "$dir"
    keep_results "$dir"
    return "$status"
  fi

  set +e
  bash scripts/release-smoke.sh
  status=$?
  set -e
  echo "$status" > "$dir/smoke.exit"
  if [ "$status" -ne 0 ]; then
    keep_results "$dir"
    return "$status"
  fi
  if [ "$attempt" -gt 1 ]; then
    summary "- Attempt $attempt (the infrastructure retry) passed: every UI test and the release smoke test ran again and passed."
  fi
}

# --- triage --------------------------------------------------------------------------------------

# How many signs of a failed test attempt N's results and Gradle output hold (0 when none).
count_failed_test_signs() {
  local dir=$1 esc plain xml marked counted summed crashed
  esc=$(printf '\033')
  plain=$(sed "s/${esc}\[[0-9;]*m//g" "$dir/gradle.log" 2> /dev/null || true)
  xml=$(find "$dir" -type f -name 'TEST-*.xml' -exec cat {} + 2> /dev/null | grep -oE '<(failure|error)[[:space:]/>]' | wc -l | tr -d ' ' || true)
  marked=$(grep -E 'FAILED' <<< "$plain" | grep -cvE '^> Task [^ ]+ FAILED[[:space:]]*$|^BUILD FAILED' || true)
  counted=$(grep -oE '\([0-9]+ failed\)' <<< "$plain" | tr -dc '0-9\n' | sort -n | tail -n 1 || true)
  # "Tests on <device> failed: There was 1 failure(s)." Not "There were failing tests", which Gradle
  # also prints when only the device failed.
  summed=$(grep -cE 'There (was|were) [1-9][0-9]* failure' <<< "$plain" || true)
  # The app or its instrumentation stopped: a crash, or an exception before any test ran.
  crashed=$(grep -cE 'Process crashed|Instrumentation run failed|Test run failed to complete' <<< "$plain" || true)
  echo $((${xml:-0} + ${marked:-0} + ${counted:-0} + ${summed:-0} + ${crashed:-0}))
}

# Prints "retry: <reason>" or "final: <reason>". Anything it cannot tell is final.
classify() {
  local dir=$1 failed signals=()
  if [ ! -f "$dir/started" ]; then
    echo "retry: the emulator step failed before the tests started (the SDK setup, or the emulator did not boot)"
    return
  fi
  if [ -f "$dir/unhealthy" ]; then
    echo "retry: the emulator booted but was not online with a working package manager within $HEALTH_SECONDS seconds"
    return
  fi
  if [ ! -f "$dir/gradle.exit" ] || [ ! -f "$dir/gradle.log" ]; then
    echo "final: the tests started but their result was not recorded"
    return
  fi
  if [ "$(cat "$dir/gradle.exit")" = 0 ]; then
    if [ -f "$dir/smoke.exit" ]; then
      echo "final: the UI tests passed and the release smoke test failed, which is never retried"
    else
      echo "final: the UI tests passed and the release smoke test's result was not recorded"
    fi
    return
  fi
  failed=$(count_failed_test_signs "$dir" || true)
  if ! [[ "$failed" =~ ^[0-9]+$ ]]; then
    echo "final: the results could not be read"
    return
  fi
  if [ "$failed" -gt 0 ]; then
    echo "final: the results show a failed test (signs of one: $failed), and a failed test is never retried"
    return
  fi
  if grep -qF 'AdbCommandRejectedException: device offline' "$dir/gradle.log"; then
    signals+=("adb reported the device offline")
  fi
  if grep -qF 'AdbCommandRejectedException: closed' "$dir/gradle.log"; then
    signals+=("adb closed the connection")
  fi
  if [ "$(cat "$dir/emulator-process" 2> /dev/null || true)" = gone ]; then
    signals+=("the emulator process had died")
  fi
  if [ "${#signals[@]}" -eq 0 ]; then
    echo "final: Gradle failed without a known infrastructure error"
    return
  fi
  local joined
  joined=$(printf '%s; ' "${signals[@]}")
  echo "retry: Gradle failed with no failed test, and ${joined%; }"
}

cmd_triage() {
  local attempt=$1 dir verdict reason
  check_attempt "$attempt"
  dir=$(attempt_dir "$attempt")
  verdict=$(classify "$dir")
  reason=${verdict#*: }
  if [ "${verdict%%:*}" = retry ] && [ "$attempt" -eq 1 ]; then
    output retry true
    echo "::warning title=Emulator infrastructure retry::Attempt 1 failed on infrastructure: $reason. The UI tests and the release smoke test run once more, on a cold-booted emulator."
    summary "### Android emulator: infrastructure retry" "" \
      "Attempt 1 failed on infrastructure: $reason. No test had failed." \
      "Every UI test and the release smoke test run once more, on a cold-booted emulator with wiped data (attempt 2)." \
      "Attempt 1's logs and reports are in the \`native-android-emulator-attempt-1\` artifact." ""
  else
    output retry false
    echo "Attempt $attempt failed and is not retried: $reason."
    summary "### Android emulator: attempt $attempt failed, not retried" "" "$reason." ""
  fi
}

# --- cleanup -------------------------------------------------------------------------------------

avd_home() { printf '%s' "${ANDROID_AVD_HOME:-$HOME/.android/avd}"; }

stop_emulator() {
  local deadline=$((SECONDS + 30))
  # The emulator step asked its emulator to quit (adb emu kill), which a hung emulator ignores.
  while emulator_alive && [ "$SECONDS" -lt "$deadline" ]; do sleep 2; done
  if emulator_alive; then
    echo "The previous emulator is still running; killing it."
    pkill -9 -f "$EMULATOR_PROCESS" || true
    sleep 2
  fi
  # A killed emulator leaves its locks, which stop the same AVD from starting again.
  rm -rf "$(avd_home)"/*.avd/*.lock
  timeout 20 adb kill-server || true
}

cmd_cleanup() {
  stop_emulator
  echo "What was left of the first emulator is stopped."
}

cmd_discard_avd() {
  stop_emulator
  rm -rf "$(avd_home)/$AVD_NAME.avd" "$(avd_home)/$AVD_NAME.ini"
  echo "::warning title=Emulator snapshot not made::The emulator that makes the snapshot failed, so the snapshot is neither saved nor used. Attempt 1 creates the AVD again and cold-boots it."
  summary "- The emulator that makes the snapshot failed; the snapshot was neither saved nor used, and attempt 1 cold-booted a new AVD with the same settings."
}

case "${1:-}" in
  cache-name) cmd_cache_name ;;
  install) cmd_install ;;
  run) cmd_run "${2:-}" ;;
  triage) cmd_triage "${2:-}" ;;
  cleanup) cmd_cleanup ;;
  discard-avd) cmd_discard_avd ;;
  *)
    echo "Usage: $0 cache-name|install|run N|triage N|cleanup|discard-avd" >&2
    exit 2
    ;;
esac
