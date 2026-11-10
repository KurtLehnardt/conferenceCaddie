#!/usr/bin/env python3
"""Generates the native apps' icons and launch images from the web app's icons (web/public/icons).

The web app's maskable icon is a white calendar-with-a-check glyph on the accent blue (#2457D6),
inside the maskable safe zone. This script separates the glyph from the blue and writes:

- Android: the adaptive icon's foreground (and monochrome layer) as PNGs for every density; the
  background is a solid colour in res/drawable/ic_launcher_background.xml.
- iOS: the 1024 by 1024 App Store icon (opaque, as Apple requires) and the launch screen image.

Usage, from the repository root (needs Pillow): python3 native/scripts/generate-app-icons.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web/public/icons"
ANDROID_RES = ROOT / "native/androidApp/src/main/res"
IOS_ASSETS = ROOT / "native/iosApp/iosApp/Assets.xcassets"
ACCENT = (0x24, 0x57, 0xD6)


def glyph_alpha(src: Image.Image) -> Image.Image:
    """The glyph as an alpha mask: 255 where the icon is white, 0 where it is the accent blue."""
    rgb = src.convert("RGB")
    mask = Image.new("L", rgb.size)
    px, out = rgb.load(), mask.load()
    for y in range(rgb.size[1]):
        for x in range(rgb.size[0]):
            r, g, b = px[x, y]
            # Distance from the blue towards white, measured on the red channel, which differs most.
            t = (r - ACCENT[0]) / (255 - ACCENT[0])
            out[x, y] = max(0, min(255, round(t * 255)))
    return mask


def white_glyph(mask: Image.Image, size: int) -> Image.Image:
    layer = Image.new("RGBA", mask.size, (255, 255, 255, 0))
    layer.putalpha(mask)
    return layer.resize((size, size), Image.LANCZOS)


def main() -> None:
    maskable = Image.open(WEB / "icon-maskable-512.png")
    mask = glyph_alpha(maskable)

    # Android adaptive icons: a 108 dp layer; the maskable icon's glyph already sits inside the
    # 66 dp safe zone at the same proportions.
    for density, px in {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}.items():
        folder = ANDROID_RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        white_glyph(mask, px).save(folder / "ic_launcher_foreground.png", optimize=True)

    # iOS: one opaque 1024 icon; iOS rounds the corners itself.
    icon = Image.new("RGB", (1024, 1024), ACCENT)
    glyph = white_glyph(mask, 1024)
    icon.paste(glyph, (0, 0), glyph)
    icon.save(IOS_ASSETS / "AppIcon.appiconset/app-icon-1024.png", optimize=True)

    # Launch screen: the web's rounded icon at 96 pt.
    launch = Image.open(WEB / "icon-512.png").convert("RGBA")
    folder = IOS_ASSETS / "LaunchIcon.imageset"
    folder.mkdir(parents=True, exist_ok=True)
    for scale in (1, 2, 3):
        launch.resize((96 * scale, 96 * scale), Image.LANCZOS).save(folder / f"launch-icon@{scale}x.png", optimize=True)
    print("wrote Android foregrounds, the iOS app icon and the launch icon")


if __name__ == "__main__":
    main()
