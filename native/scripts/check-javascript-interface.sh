#!/usr/bin/env bash
# Fails unless R8 kept, under their own names, the methods the app marks @JavascriptInterface: a
# WebView calls them by name from JavaScript (CapacitorMigration), so a renamed or removed method
# would silently break the migration in release builds only. Run after the release build; CI runs
# it. Locally: bash native/scripts/check-javascript-interface.sh
set -euo pipefail
cd "$(dirname "$0")/.."

mapping=androidApp/build/outputs/mapping/release/mapping.txt
if [ ! -f "$mapping" ]; then
  echo "No R8 mapping at $mapping; build :androidApp:assembleRelease first." >&2
  exit 1
fi

# The name of every function that follows the annotation in the app's sources.
names=$(grep -rh -A1 '@JavascriptInterface' androidApp/src/main/kotlin | grep -oE 'fun [A-Za-z0-9_]+' | awk '{print $2}' | sort -u)
if [ -z "$names" ]; then
  echo "No @JavascriptInterface methods found; nothing to check."
  exit 0
fi

fail=0
for name in $names; do
  # A member line of the mapping: "    4:15:void result(java.lang.String):85 -> result".
  if grep -qE "^[[:space:]]+([0-9]+:[0-9]+:)?[^ ]+ ${name}\([^)]*\)(:[0-9]+)* -> ${name}\$" "$mapping"; then
    echo "R8 kept ${name}."
  else
    echo "R8 renamed or removed the JavaScript interface method ${name}; keep it in androidApp/proguard-rules.pro." >&2
    fail=1
  fi
done
exit $fail
