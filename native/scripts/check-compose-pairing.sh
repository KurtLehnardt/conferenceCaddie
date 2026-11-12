#!/usr/bin/env bash
# Fails when compose-material3 and compose-multiplatform in gradle/libs.versions.toml are not a pair.
# JetBrains releases Material3 as X.Y.0-<stage> alongside Compose Multiplatform X.Y.Z (DECISIONS.md:
# CMP 1.12.2 with Material3 1.12.0-alpha03), so the major.minor must match. Dependabot ignores the
# material3 artifact; this catches a hand bump that moves only one of them.
# CI runs this; locally: bash native/scripts/check-compose-pairing.sh
set -euo pipefail
cd "$(dirname "$0")/.."
toml=gradle/libs.versions.toml
get() { sed -n "s/^$1 *= *\"\\([^\"]*\\)\".*/\\1/p" "$toml" | head -1; }
m3=$(get compose-material3)
cmp=$(get compose-multiplatform)
if [ -z "$m3" ] || [ -z "$cmp" ]; then
  echo "::error::compose-material3 or compose-multiplatform not found in $toml"; exit 1
fi
if [ "$(echo "$m3" | cut -d. -f1,2)" != "$(echo "$cmp" | cut -d. -f1,2)" ]; then
  echo "::error::compose-material3 $m3 does not pair with compose-multiplatform $cmp (major.minor differ); see DECISIONS.md"
  exit 1
fi
echo "compose-material3 $m3 pairs with compose-multiplatform $cmp"
