#!/usr/bin/env bash
# Fails when composeApp holds a touch target's minimum with a modifier that rounds it to the nearest
# pixel: Material's minimumInteractiveComponentSize(), or a size modifier given PlatformTouchTarget.
# At a density at which the minimum is not a whole number of pixels, those come out up to half a pixel
# under it (48 dp is 122.4 px at 2.55 and became 122 px). minimumTouchTarget() and touchTargetIn()
# (composeApp, ui/theme/TouchTarget.kt) round it up. Comment lines are skipped.
# CI runs this; locally: bash native/scripts/check-touch-targets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

allowed=composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/theme/TouchTarget.kt
pattern='minimumInteractiveComponentSize|(defaultMinSize|sizeIn|widthIn|heightIn|requiredSizeIn|requiredSize|requiredWidth|requiredHeight|size|width|height)\([^)]*PlatformTouchTarget'

if [ ! -f "$allowed" ]; then
  echo "::error::$allowed is gone; update native/scripts/check-touch-targets.sh."
  exit 1
fi

found=0
while IFS= read -r -d '' file; do
  [ "$file" = "$allowed" ] && continue
  if hits=$(grep -nE "$pattern" "$file" | grep -vE '^[0-9]+:[[:space:]]*(\*|//|/\*)'); then
    echo "::error file=native/$file::Hold a touch target's minimum with minimumTouchTarget() or touchTargetIn() (composeApp, ui/theme/TouchTarget.kt), which round it up to whole pixels."
    printf '%s\n' "$hits" | sed "s|^|native/$file:|"
    found=1
  fi
done < <(git ls-files -z -co --exclude-standard -- 'composeApp/src/*Main/*.kt')

if [ "$found" = 1 ]; then exit 1; fi
echo "Touch targets round their minimum up to whole pixels."
