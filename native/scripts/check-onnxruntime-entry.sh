#!/usr/bin/env bash
# Fails when any code but the encoder files uses ONNX Runtime. openEncoder (shared, embed/BgeEmbedder.kt)
# is the only way into ONNX Runtime, so that every session gets the app's settings: telemetry events
# off and idle threads not spinning. The encoder files are its two implementations and the C shim the
# iOS one calls. Comment lines are skipped. CI runs this; locally: bash native/scripts/check-onnxruntime-entry.sh
set -euo pipefail
cd "$(dirname "$0")/.."

allowed=(
  shared/src/ortJava/kotlin/app/conferencecaddie/shared/embed/OrtJavaEncoder.kt
  shared/src/iosMain/kotlin/app/conferencecaddie/shared/embed/IosOrtEncoder.kt
  shared/src/nativeInterop/cinterop/onnxruntime.def
)
# The Java API's package, the C API's entry point and types, the iOS bindings of the C shim, and the
# headers or modules of ONNX Runtime's C, C++ and Objective-C APIs.
pattern='ai\.onnxruntime|OrtGetApiBase|OrtApi|OrtEnv|OrtSession|embed\.ort\.|caddie_ort_|onnxruntime_(c_api|cxx_api|objc)|import[[:space:]]+onnxruntime'

found=0
while IFS= read -r -d '' file; do
  skip=0
  for a in "${allowed[@]}"; do [ "$file" = "$a" ] && skip=1; done
  # The licence texts the app shows, generated from native/licenses.
  [ "$file" = composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/licenses/ThirdPartyNotices.kt ] && skip=1
  [ "$skip" = 1 ] && continue
  if hits=$(grep -nE "$pattern" "$file" | grep -vE '^[0-9]+:[[:space:]]*(\*|//|/\*|#)'); then
    echo "::error file=native/$file::Only openEncoder may use ONNX Runtime (see shared/src/commonMain/kotlin/app/conferencecaddie/shared/embed/BgeEmbedder.kt)."
    printf '%s\n' "$hits" | sed "s|^|native/$file:|"
    found=1
  fi
done < <(git ls-files -z -co --exclude-standard -- '*.kt' '*.java' '*.swift' '*.m' '*.mm' '*.c' '*.cc' '*.cpp' '*.h' '*.def')

for a in "${allowed[@]}"; do
  if [ ! -f "$a" ]; then
    echo "::error::$a is gone; update the allowed files in native/scripts/check-onnxruntime-entry.sh."
    found=1
  fi
done

if [ "$found" = 1 ]; then exit 1; fi
echo "ONNX Runtime is used only through openEncoder."
