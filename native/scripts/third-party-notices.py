#!/usr/bin/env python3
"""Generates the third-party licence notices the native apps show in Settings, and checks they are current.

The notices are written to composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/licenses/ThirdPartyNotices.kt.
Each notice is one licence text (from native/licenses/) with the Android and iOS modules it covers.

Where the modules come from:

- Android: the resolved release runtime classpath of :androidApp, which is what ships in the APK or AAB.
- iOS: the resolved klibs of :composeApp for iosArm64, which the release framework links. Skiko is among
  them, and it statically bundles native code (Skia, HarfBuzz, ICU and others) that no Gradle report
  lists. Those components are the table NATIVE_COMPONENTS below, which was read from the symbols of the
  linked release framework with nm.

Every module group must be in LICENCE_TABLE, so a new dependency with an unknown licence fails the run
until somebody has read its licence and added it. In the broad groups of ARTIFACT_APPROVAL_GROUPS
(AndroidX, org.jetbrains, kotlinx) every artifact must also be in APPROVED_ARTIFACTS. A different Skiko version fails the run too, until the
bundled native components have been looked at again (see SKIKO_VERIFIED).

Usage, from the native/ directory (the iOS report only resolves on macOS, where Kotlin/Native is available):

    python3 scripts/third-party-notices.py            # regenerates ThirdPartyNotices.kt
    python3 scripts/third-party-notices.py --check    # exits 1 if the checked-in file is out of date

To run without Gradle, pass saved reports: --android-report FILE --ios-report FILE.
"""

import argparse
import difflib
import re
import subprocess
import sys
from pathlib import Path

NATIVE = Path(__file__).resolve().parents[1]
LICENCES = NATIVE / "licenses"
OUTPUT = NATIVE / "composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/licenses/ThirdPartyNotices.kt"

ANDROID_REPORT = [":androidApp:dependencies", "--configuration", "releaseRuntimeClasspath"]
IOS_REPORT = [":composeApp:dependencies", "--configuration", "iosArm64CompileKlibraries"]

# The Skiko version whose linked native components were checked with nm on the iOS release framework.
SKIKO_VERIFIED = "0.150.2"

# Licence id -> (title shown in the app, file in native/licenses/). The order is the order shown.
LICENCES_BY_ID = {
    "apache-2.0": ("Apache License 2.0", "apache-2.0.txt"),
    "skia": ("Skia and skcms (BSD 3-Clause)", "skia.txt"),
    "harfbuzz": ("HarfBuzz (Old MIT)", "harfbuzz.txt"),
    "icu": ("ICU and Unicode data (Unicode License v3)", "icu.txt"),
    "libpng": ("libpng (PNG Reference Library License)", "libpng.txt"),
    "libjpeg-turbo": ("libjpeg-turbo (IJG and BSD 3-Clause)", "libjpeg-turbo.txt"),
    "libwebp": ("libwebp (BSD 3-Clause)", "libwebp.txt"),
    "zlib": ("zlib", "zlib.txt"),
    "expat": ("Expat (MIT)", "expat.txt"),
    "wuffs": ("Wuffs (MIT or Apache License 2.0)", "wuffs.txt"),
    "dng-sdk": ("Adobe DNG SDK", "dng-sdk.txt"),
    "slf4j": ("SLF4J API (MIT)", "slf4j.txt"),
}

# Module group -> licence id. A pattern ending in ".*" matches that group and every group below it;
# any other pattern matches only that exact group, so a new unrelated group is never covered by accident.
# Each entry was checked against the POMs (or, for Guava's listenablefuture, which has none, upstream).
LICENCE_TABLE = [
    ("androidx.*", "apache-2.0"),
    ("com.google.guava", "apache-2.0"),
    ("com.squareup.okhttp3", "apache-2.0"),
    ("com.squareup.okio", "apache-2.0"),
    ("io.ktor", "apache-2.0"),
    ("org.jetbrains", "apache-2.0"),
    ("org.jetbrains.androidx.*", "apache-2.0"),
    ("org.jetbrains.compose.*", "apache-2.0"),
    ("org.jetbrains.kotlin", "apache-2.0"),
    ("org.jetbrains.kotlinx", "apache-2.0"),
    ("org.jetbrains.skiko", "apache-2.0"),
    ("org.jspecify", "apache-2.0"),
    # Ktor's logging facade; the POM names no licence, the jar carries the MIT text (licenses/slf4j.txt).
    ("org.slf4j", "slf4j"),
]

# Groups that publish, or could publish, artifacts under another licence than the one in LICENCE_TABLE
# (AndroidX alone has hundreds of artifacts). In these groups each artifact is approved by name, so a new
# one fails the run until its licence has been read and it has been added to APPROVED_ARTIFACTS.
ARTIFACT_APPROVAL_GROUPS = ["androidx.*", "org.jetbrains", "org.jetbrains.kotlinx"]

# Artifacts approved by name in ARTIFACT_APPROVAL_GROUPS; every one is under the Apache License 2.0.
APPROVED_ARTIFACTS = {
    "androidx.activity:activity",
    "androidx.activity:activity-compose",
    "androidx.activity:activity-ktx",
    "androidx.annotation:annotation",
    "androidx.annotation:annotation-experimental",
    "androidx.annotation:annotation-iosarm64",
    "androidx.annotation:annotation-jvm",
    "androidx.arch.core:core-common",
    "androidx.arch.core:core-runtime",
    "androidx.autofill:autofill",
    "androidx.collection:collection",
    "androidx.collection:collection-iosarm64",
    "androidx.collection:collection-jvm",
    "androidx.collection:collection-ktx",
    "androidx.compose.animation:animation",
    "androidx.compose.animation:animation-android",
    "androidx.compose.animation:animation-core",
    "androidx.compose.animation:animation-core-android",
    "androidx.compose.foundation:foundation",
    "androidx.compose.foundation:foundation-android",
    "androidx.compose.foundation:foundation-layout",
    "androidx.compose.foundation:foundation-layout-android",
    "androidx.compose.material3:material3",
    "androidx.compose.material3:material3-android",
    "androidx.compose.material:material-icons-core",
    "androidx.compose.material:material-icons-core-android",
    "androidx.compose.material:material-ripple",
    "androidx.compose.material:material-ripple-android",
    "androidx.compose.runtime:runtime",
    "androidx.compose.runtime:runtime-android",
    "androidx.compose.runtime:runtime-annotation",
    "androidx.compose.runtime:runtime-annotation-android",
    "androidx.compose.runtime:runtime-annotation-iosarm64",
    "androidx.compose.runtime:runtime-iosarm64",
    "androidx.compose.runtime:runtime-retain",
    "androidx.compose.runtime:runtime-retain-android",
    "androidx.compose.runtime:runtime-retain-iosarm64",
    "androidx.compose.runtime:runtime-saveable",
    "androidx.compose.runtime:runtime-saveable-android",
    "androidx.compose.runtime:runtime-saveable-iosarm64",
    "androidx.compose.ui:ui",
    "androidx.compose.ui:ui-android",
    "androidx.compose.ui:ui-geometry",
    "androidx.compose.ui:ui-geometry-android",
    "androidx.compose.ui:ui-graphics",
    "androidx.compose.ui:ui-graphics-android",
    "androidx.compose.ui:ui-text",
    "androidx.compose.ui:ui-text-android",
    "androidx.compose.ui:ui-tooling-preview",
    "androidx.compose.ui:ui-tooling-preview-android",
    "androidx.compose.ui:ui-unit",
    "androidx.compose.ui:ui-unit-android",
    "androidx.compose.ui:ui-util",
    "androidx.compose.ui:ui-util-android",
    "androidx.concurrent:concurrent-futures",
    "androidx.core:core",
    "androidx.core:core-ktx",
    "androidx.core:core-viewtree",
    "androidx.customview:customview-poolingcontainer",
    "androidx.emoji2:emoji2",
    "androidx.graphics:graphics-path",
    "androidx.graphics:graphics-shapes",
    "androidx.graphics:graphics-shapes-android",
    "androidx.graphics:graphics-shapes-iosarm64",
    "androidx.interpolator:interpolator",
    "androidx.lifecycle:lifecycle-common",
    "androidx.lifecycle:lifecycle-common-iosarm64",
    "androidx.lifecycle:lifecycle-common-java8",
    "androidx.lifecycle:lifecycle-common-jvm",
    "androidx.lifecycle:lifecycle-livedata-core",
    "androidx.lifecycle:lifecycle-process",
    "androidx.lifecycle:lifecycle-runtime",
    "androidx.lifecycle:lifecycle-runtime-android",
    "androidx.lifecycle:lifecycle-runtime-compose",
    "androidx.lifecycle:lifecycle-runtime-compose-android",
    "androidx.lifecycle:lifecycle-runtime-compose-iosarm64",
    "androidx.lifecycle:lifecycle-runtime-iosarm64",
    "androidx.lifecycle:lifecycle-runtime-ktx",
    "androidx.lifecycle:lifecycle-runtime-ktx-android",
    "androidx.lifecycle:lifecycle-viewmodel",
    "androidx.lifecycle:lifecycle-viewmodel-android",
    "androidx.lifecycle:lifecycle-viewmodel-compose",
    "androidx.lifecycle:lifecycle-viewmodel-compose-android",
    "androidx.lifecycle:lifecycle-viewmodel-compose-iosarm64",
    "androidx.lifecycle:lifecycle-viewmodel-iosarm64",
    "androidx.lifecycle:lifecycle-viewmodel-ktx",
    "androidx.lifecycle:lifecycle-viewmodel-savedstate",
    "androidx.lifecycle:lifecycle-viewmodel-savedstate-android",
    "androidx.lifecycle:lifecycle-viewmodel-savedstate-iosarm64",
    "androidx.navigationevent:navigationevent",
    "androidx.navigationevent:navigationevent-android",
    "androidx.navigationevent:navigationevent-compose",
    "androidx.navigationevent:navigationevent-compose-android",
    "androidx.navigationevent:navigationevent-compose-iosarm64",
    "androidx.navigationevent:navigationevent-iosarm64",
    "androidx.profileinstaller:profileinstaller",
    "androidx.savedstate:savedstate",
    "androidx.savedstate:savedstate-android",
    "androidx.savedstate:savedstate-compose",
    "androidx.savedstate:savedstate-compose-android",
    "androidx.savedstate:savedstate-compose-iosarm64",
    "androidx.savedstate:savedstate-iosarm64",
    "androidx.savedstate:savedstate-ktx",
    "androidx.sqlite:sqlite",
    "androidx.sqlite:sqlite-android",
    "androidx.sqlite:sqlite-bundled",
    "androidx.sqlite:sqlite-bundled-android",
    "androidx.sqlite:sqlite-bundled-iosarm64",
    "androidx.sqlite:sqlite-framework",
    "androidx.sqlite:sqlite-framework-iosarm64",
    "androidx.sqlite:sqlite-iosarm64",
    "androidx.startup:startup-runtime",
    "androidx.tracing:tracing",
    "androidx.versionedparcelable:versionedparcelable",
    "androidx.window:window",
    "androidx.window:window-core",
    "androidx.window:window-core-android",
    "org.jetbrains.kotlinx:atomicfu",
    "org.jetbrains.kotlinx:atomicfu-iosarm64",
    "org.jetbrains.kotlinx:kotlinx-coroutines-android",
    "org.jetbrains.kotlinx:kotlinx-coroutines-bom",
    "org.jetbrains.kotlinx:kotlinx-coroutines-core",
    "org.jetbrains.kotlinx:kotlinx-coroutines-core-iosarm64",
    "org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm",
    "org.jetbrains.kotlinx:kotlinx-coroutines-slf4j",
    "org.jetbrains.kotlinx:kotlinx-datetime",
    "org.jetbrains.kotlinx:kotlinx-datetime-iosarm64",
    "org.jetbrains.kotlinx:kotlinx-datetime-jvm",
    "org.jetbrains.kotlinx:kotlinx-io-bytestring",
    "org.jetbrains.kotlinx:kotlinx-io-bytestring-iosarm64",
    "org.jetbrains.kotlinx:kotlinx-io-bytestring-jvm",
    "org.jetbrains.kotlinx:kotlinx-io-core",
    "org.jetbrains.kotlinx:kotlinx-io-core-iosarm64",
    "org.jetbrains.kotlinx:kotlinx-io-core-jvm",
    "org.jetbrains.kotlinx:kotlinx-serialization-bom",
    "org.jetbrains.kotlinx:kotlinx-serialization-core",
    "org.jetbrains.kotlinx:kotlinx-serialization-core-iosarm64",
    "org.jetbrains.kotlinx:kotlinx-serialization-core-jvm",
    "org.jetbrains.kotlinx:kotlinx-serialization-json",
    "org.jetbrains.kotlinx:kotlinx-serialization-json-iosarm64",
    "org.jetbrains.kotlinx:kotlinx-serialization-json-jvm",
    "org.jetbrains:annotations",
}

# What Skiko bundles into the iOS binary: (name, licence id). Skia's bundled skcms is under Skia's licence.
NATIVE_COMPONENTS = [
    ("Skia (with skcms)", "skia"),
    ("HarfBuzz", "harfbuzz"),
    ("ICU", "icu"),
    ("libpng", "libpng"),
    ("libjpeg-turbo", "libjpeg-turbo"),
    ("libwebp", "libwebp"),
    ("zlib", "zlib"),
    ("Expat", "expat"),
    ("Wuffs", "wuffs"),
    ("Adobe DNG SDK", "dng-sdk"),
    ("piex", "apache-2.0"),
]

TREE_LINE = re.compile(r"^[| ]*[+\\]--- (.*)$")
MODULE = re.compile(r"^([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+)(?::(\{[^}]*\}|\S+))?(?: -> (\S+))?")


class NoticeError(Exception):
    pass


def run_report(args):
    result = subprocess.run(["./gradlew", "-q", *args], cwd=NATIVE, capture_output=True, text=True)
    if result.returncode != 0:
        raise NoticeError(f"./gradlew -q {' '.join(args)} failed:\n{result.stdout}{result.stderr}")
    return result.stdout


def parse_report(text, label):
    """The resolved (group:name, version) of every module in a Gradle dependency report."""
    modules = set()
    for raw in text.splitlines():
        tree = TREE_LINE.match(raw)
        if not tree:
            continue
        line = tree.group(1).strip()
        # Constraints and unresolvable (not requested) entries are not part of the classpath.
        if line.startswith("project ") or line.endswith("(c)") or line.endswith("(n)"):
            continue
        if "FAILED" in line:
            raise NoticeError(f"The {label} report has an unresolved module: {line}")
        found = MODULE.match(line)
        if not found:
            raise NoticeError(f"Cannot read this line of the {label} report: {line}")
        group, name, declared, resolved = found.groups()
        version = resolved
        if version is None and declared and not declared.startswith("{"):
            version = declared
        if version is None and declared:
            # {strictly 1.0}, {require 1.0} or {prefer 1.0} with nothing resolving it further.
            version = declared.strip("{}").split()[-1]
        if version is None:
            raise NoticeError(f"No version for {group}:{name} in the {label} report: {line}")
        modules.add((group, name, version))
    if not modules:
        raise NoticeError(f"The {label} report lists no modules; is it the right configuration?")
    return modules


def licence_for(group):
    best = None
    for pattern, licence in LICENCE_TABLE:
        if pattern.endswith(".*"):
            base = pattern[:-2]
            hit = group == base or group.startswith(base + ".")
        else:
            hit = group == pattern
        if hit and (best is None or len(pattern) > len(best[0])):
            best = (pattern, licence)
    return best[1] if best else None


def needs_approval(group):
    for pattern in ARTIFACT_APPROVAL_GROUPS:
        if pattern.endswith(".*"):
            base = pattern[:-2]
            if group == base or group.startswith(base + "."):
                return True
        elif group == pattern:
            return True
    return False


def licence_text(licence_id):
    text = (LICENCES / LICENCES_BY_ID[licence_id][1]).read_text(encoding="utf-8")
    return text.strip("\n")


def kotlin_string(text):
    """A Kotlin raw string literal for text, with the characters a raw string cannot hold escaped."""
    escaped = text.replace("$", "${'$'}").replace('"""', "${'\"'}${'\"'}${'\"'}")
    return f'"""{escaped}"""'


def const_name(licence_id):
    return re.sub(r"[^A-Z0-9]", "_", licence_id.upper())


def generate(android, ios):
    unknown = sorted({g for g, _, _ in android | ios if licence_for(g) is None})
    if unknown:
        lines = [f"  {g}: " + ", ".join(sorted({f"{n}:{v}" for gg, n, v in android | ios if gg == g})) for g in unknown]
        raise NoticeError(
            "These module groups have no licence in LICENCE_TABLE in scripts/third-party-notices.py.\n"
            "Read each one's licence, add its licence text to native/licenses/ if it is new, and add the group:\n"
            + "\n".join(lines)
        )

    unapproved = sorted({f"{g}:{n}" for g, n, _ in android | ios if needs_approval(g) and f"{g}:{n}" not in APPROVED_ARTIFACTS})
    if unapproved:
        raise NoticeError(
            "These artifacts are not in APPROVED_ARTIFACTS in scripts/third-party-notices.py.\n"
            "Read each one's licence; if it is the Apache License 2.0, add it to the list, otherwise give it its own entry:\n"
            + "\n".join(f"  {a}" for a in unapproved)
        )

    skiko = sorted({v for g, n, v in ios if g == "org.jetbrains.skiko" and n.startswith("skiko")})
    bundled = bool(skiko)
    if not bundled and any(g.startswith("org.jetbrains.compose") for g, _, _ in ios):
        raise NoticeError(
            "The iOS report has Compose Multiplatform but no Skiko, which Compose draws with on iOS.\n"
            "The report is probably of the wrong configuration; without Skiko the notices would leave out\n"
            "the native code it bundles (NATIVE_COMPONENTS)."
        )
    if bundled and skiko != [SKIKO_VERIFIED]:
        raise NoticeError(
            f"iOS links Skiko {', '.join(skiko)}, but the bundled native components were checked for {SKIKO_VERIFIED}.\n"
            "Run nm -gU on the iOS release framework, update NATIVE_COMPONENTS and licences if they changed,\n"
            "and set SKIKO_VERIFIED."
        )

    # Per licence: the Android and iOS modules. A native component is listed against iOS only.
    per_licence = {lid: {"android": set(), "ios": set()} for lid in LICENCES_BY_ID}
    for platform, modules in (("android", android), ("ios", ios)):
        for group, name, version in modules:
            per_licence[licence_for(group)][platform].add((f"{group}:{name}", version))
    if bundled:
        for name, lid in NATIVE_COMPONENTS:
            per_licence[lid]["ios"].add((name, f"bundled in Skiko {SKIKO_VERIFIED}"))

    def module_list(modules):
        if not modules:
            return "listOf()"
        rows = "".join(f'                Module("{c}", "{v}"),\n' for c, v in sorted(modules))
        return "listOf(\n" + rows + "            )"

    out = [
        "// Generated by native/scripts/third-party-notices.py. Do not edit by hand.",
        "// To regenerate it, run python3 scripts/third-party-notices.py from native/ (on macOS). The Android modules",
        "// come from the release runtime classpath and the iOS modules from the iosArm64 klibs, both from Gradle;",
        "// the licence texts come from native/licenses/. CI runs it with --check.",
        "package app.conferencecaddie.ui.licenses",
        "",
        "/** The third-party licences the apps ship, each with the modules it covers on each platform. */",
        "object ThirdPartyNotices {",
        "    /** A library as group:name (or a bundled component's name) and the version the apps ship. */",
        "    data class Module(val coordinate: String, val version: String)",
        "",
        "    /** One licence: its title, the modules under it on each platform, and its full text. */",
        "    data class Notice(val id: String, val title: String, val android: List<Module>, val ios: List<Module>, val text: String)",
        "",
    ]
    used = [lid for lid in LICENCES_BY_ID if per_licence[lid]["android"] or per_licence[lid]["ios"]]
    for lid in used:
        out.append(f"    private const val {const_name(lid)} = {kotlin_string(licence_text(lid))}")
        out.append("")
    out.append("    val NOTICES: List<Notice> = listOf(")
    for lid in used:
        title = LICENCES_BY_ID[lid][0]
        out += [
            "        Notice(",
            f'            id = "{lid}",',
            f'            title = "{title}",',
            f"            android = {module_list(per_licence[lid]['android'])},",
            f"            ios = {module_list(per_licence[lid]['ios'])},",
            f"            text = {const_name(lid)},",
            "        ),",
        ]
    out += ["    )", "}", ""]
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", action="store_true", help="fail if the checked-in Kotlin file is out of date")
    parser.add_argument("--android-report", type=Path, help="a saved Gradle report instead of running Gradle")
    parser.add_argument("--ios-report", type=Path, help="a saved Gradle report instead of running Gradle")
    parser.add_argument("--output", type=Path, default=OUTPUT, help="the Kotlin file to write or check")
    args = parser.parse_args()

    try:
        android_text = args.android_report.read_text() if args.android_report else run_report(ANDROID_REPORT)
        ios_text = args.ios_report.read_text() if args.ios_report else run_report(IOS_REPORT)
        generated = generate(parse_report(android_text, "Android"), parse_report(ios_text, "iOS"))
    except NoticeError as error:
        print(f"third-party-notices: {error}", file=sys.stderr)
        return 1

    if args.check:
        current = args.output.read_text(encoding="utf-8") if args.output.exists() else ""
        if current == generated:
            print(f"{args.output.name} is up to date.")
            return 0
        diff = list(difflib.unified_diff(current.splitlines(), generated.splitlines(), "checked in", "generated", lineterm="", n=0))
        print(f"third-party-notices: {args.output.name} is out of date ({len(diff)} diff lines). First changes:", file=sys.stderr)
        print("\n".join(diff[:40]), file=sys.stderr)
        print("Run python3 scripts/third-party-notices.py from native/ and commit the result.", file=sys.stderr)
        return 1

    args.output.write_text(generated, encoding="utf-8")
    print(f"Wrote {args.output} ({len(generated.encode('utf-8'))} bytes).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
