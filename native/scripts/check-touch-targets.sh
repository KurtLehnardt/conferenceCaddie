#!/usr/bin/env bash
# Fails when composeApp holds a touch target's minimum with a modifier that rounds it to the nearest
# pixel. At a density at which the minimum is not a whole number of pixels, those come out up to half
# a pixel under it (48 dp is 122.4 px at 2.55 and became 122 px). minimumTouchTarget() and
# touchTargetIn() (composeApp, ui/theme/TouchTarget.kt) round it up. Flagged, outside the files that
# define the touch target:
#   - Material's minimumInteractiveComponentSize, an import of it under another name included;
#   - PlatformTouchTarget anywhere but in the arguments of touchTargetIn(...), so a copy of it in a
#     val, or an import of it under another name, is flagged too (CaddieTheme.kt may use it);
#   - heightIn, widthIn, sizeIn, requiredHeightIn, requiredWidthIn, requiredSizeIn or defaultMinSize
#     given 48.dp other than as a max.
# Strings and comments are skipped; calls may span lines. Not covered: a 48 dp minimum held in a
# constant or a token (heightIn(min = RowMin)), and fixed sizes such as height(48.dp).
# CI runs this; locally: bash native/scripts/check-touch-targets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

theme=composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/theme
allowed=(
  "$theme/TouchTarget.kt"
  composeApp/src/androidMain/kotlin/app/conferencecaddie/ui/theme/TouchTarget.android.kt
  composeApp/src/iosMain/kotlin/app/conferencecaddie/ui/theme/TouchTarget.ios.kt
)
# Provides PlatformTouchTarget as Material's minimum interactive size; the other rules still apply.
export PLATFORM_TOUCH_TARGET_ALLOWED="$theme/CaddieTheme.kt"
for a in "${allowed[@]}" "$PLATFORM_TOUCH_TARGET_ALLOWED"; do
  if [ ! -f "$a" ]; then
    echo "::error::$a is gone; update the allowed files in native/scripts/check-touch-targets.sh."
    exit 1
  fi
done

# A failing git ls-files fails the script here (set -e), rather than leaving nothing to check.
listed=$(git ls-files -co --exclude-standard -- 'composeApp/src/*Main/*.kt')
files=()
while IFS= read -r file; do
  skip=0
  for a in "${allowed[@]}"; do [ "$file" = "$a" ] && skip=1; done
  [ "$skip" = 0 ] && files+=("$file")
done <<< "$listed"
if [ "${#files[@]}" -lt 50 ]; then
  echo "::error::Only ${#files[@]} composeApp source files were found; native/scripts/check-touch-targets.sh no longer finds the sources."
  exit 1
fi

# Prints "file:line: what" for each hit. Everything blanked keeps its length and its newlines, so
# positions and line numbers stay those of the file.
hits=$(perl -0777 -ne '
  sub blank { my $m = shift; $m =~ s/[^\n]/ /g; $m }
  my $s = $_;
  # Strings and character literals, then comments (KDoc included).
  $s =~ s{"""(?s:.*?)"""}{blank($&)}ge;
  $s =~ s{'"'"'(?:[^'"'"'\\\n]|\\.)+'"'"'}{blank($&)}ge;
  $s =~ s{"(?:[^"\\\n]|\\.)*"}{blank($&)}ge;
  $s =~ s{/\*.*?\*/}{blank($&)}gse;
  $s =~ s{//[^\n]*}{blank($&)}ge;
  my @hits;
  while ($s =~ /^[ \t]*import[ \t]+\S*\b(minimumInteractiveComponentSize|PlatformTouchTarget)[ \t]+as\b/gm) {
    push @hits, [$-[0], "$1 imported under another name"];
  }
  $s =~ s{^[ \t]*import [^\n]*}{blank($&)}gme;
  while ($s =~ /\bminimumInteractiveComponentSize\b/g) { push @hits, [$-[0], "minimumInteractiveComponentSize"] }
  if ($ARGV ne $ENV{PLATFORM_TOUCH_TARGET_ALLOWED}) {
    (my $t = $s) =~ s{\btouchTargetIn\s*(\((?:[^()]++|(?1))*\))}{blank($&)}ge;
    while ($t =~ /\bPlatformTouchTarget\b/g) { push @hits, [$-[0], "PlatformTouchTarget outside touchTargetIn()"] }
  }
  while ($s =~ /\b(heightIn|widthIn|sizeIn|requiredHeightIn|requiredWidthIn|requiredSizeIn|defaultMinSize)\s*(\((?:[^()]++|(?2))*\))/g) {
    my ($name, $args, $at) = ($1, $2, $-[0]);
    $args =~ s/\bmax\w*\s*=\s*[^,)]*//g;
    push @hits, [$at, "$name with a 48.dp minimum"] if $args =~ /(?<![\w.])48\.dp\b/;
  }
  for my $h (sort { $a->[0] <=> $b->[0] } @hits) {
    my $line = 1 + (substr($s, 0, $h->[0]) =~ tr/\n//);
    print "$ARGV:$line: $h->[1]\n";
  }
' "${files[@]}")

if [ -n "$hits" ]; then
  while IFS= read -r hit; do
    file=${hit%%:*}
    rest=${hit#*:}
    line=${rest%%:*}
    echo "::error file=native/$file,line=$line::${rest#*: }: hold a touch target's minimum with minimumTouchTarget() or touchTargetIn() (composeApp, ui/theme/TouchTarget.kt), which round it up to whole pixels."
  done <<< "$hits"
  exit 1
fi
echo "Touch targets round their minimum up to whole pixels (${#files[@]} files checked)."
