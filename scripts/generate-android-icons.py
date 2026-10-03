#!/usr/bin/env python3
"""Regenerate every app icon from one source image.

    python scripts/generate-android-icons.py [SOURCE]

SOURCE defaults to assets/icon/mono-hermes-icon.png (this repository, not upstream).

The source may be
  * a transparent PNG with the rounded plate on it (alpha is the mask), or
  * an opaque image where the plate sits inside a white "sticker" ring over black corners
    (the shipped artwork). The ring and the outside corners are detected and removed, and
    the area outside the plate's rounded corners becomes transparent.

Writes:
  mobile/android/app/src/main/res/mipmap-*/ic_launcher{,_round,_foreground}.png
  mobile/android/app/src/main/res/{drawable*,}/splash.png      (solid launch background)
  mobile/android/app/src/main/res/values/ic_launcher_background.xml
  mobile/src/assets/app-icon.png                               (connect screen, 180px)
  assets/icon/mono-hermes-icon-512.png                         (store-style, full bleed)
  assets/icon/mono-hermes-logo.png                             (README logo, rounded, 256px)

The generated files are committed; run this only when the artwork changes.
Requires Pillow and numpy:  pip install pillow numpy
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "assets/icon/mono-hermes-icon.png"
RES = ROOT / "mobile/android/app/src/main/res"
BACKGROUND = (10, 10, 10, 255)  # matches @color/hermes_background

DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}

# Adaptive icons: the launcher shows at least a 66dp circle of the 108dp canvas; circle masks
# show up to 72dp. Keep every bit of artwork inside a circle of this radius (dp from centre).
ADAPTIVE_ART_RADIUS_DP = 36.0
# Legacy round icon: artwork stays inside this fraction of the icon's half-size.
ROUND_ART_RADIUS = 0.97
# The "art radius" is this fraction of the plate's longer side, measured from its centre. 0.53 keeps
# the hands, phone and face inside the mask; only the far shoulder corner may be trimmed by a circle.
ART_RADIUS_FRACTION = 0.53


# --- plate detection -------------------------------------------------------------------------


def _first_edge(line: np.ndarray) -> int | None:
    """Index where a white run (ring) first turns dark again, scanning from the start."""
    seen_white = False
    for i, value in enumerate(line):
        if value >= 200:
            seen_white = True
        elif seen_white and value < 80:
            return i
    return None


def _scan_box(gray: np.ndarray) -> tuple[int, int, int, int] | None:
    h, w = gray.shape
    fractions = (0.3, 0.4, 0.5, 0.6, 0.7)
    lefts, rights, tops, bottoms = [], [], [], []
    for f in fractions:
        row, col = gray[int(h * f)], gray[:, int(w * f)]
        edges = (_first_edge(row), _first_edge(row[::-1]), _first_edge(col), _first_edge(col[::-1]))
        if None in edges:
            return None
        lefts.append(edges[0])
        rights.append(w - edges[1])
        tops.append(edges[2])
        bottoms.append(h - edges[3])
    med = lambda v: int(np.median(v))  # noqa: E731
    return med(lefts), med(tops), med(rights), med(bottoms)


def _plate_mask_by_flood(gray: np.ndarray, box: tuple[int, int, int, int]) -> Image.Image | None:
    """Exact plate silhouette: everything that is neither the ring nor the outer corners."""
    h, w = gray.shape
    # RGB, because ImageDraw.floodfill silently does nothing for arbitrary values on "L" images.
    binary = Image.fromarray(np.where(gray >= 128, 255, 0).astype(np.uint8)).convert("RGB")
    left, top, right, bottom = box
    # ring seed: a white pixel just inside the image edge, mid-height
    ring_seed = (max(1, left // 2), h // 2)
    if binary.getpixel(ring_seed) != (255, 255, 255):
        return None
    ImageDraw.floodfill(binary, ring_seed, (255, 0, 0))
    arr = np.array(binary)
    ring = (arr[..., 0] == 255) & (arr[..., 1] == 0)
    ys, xs = np.nonzero(ring)
    if len(xs) == 0:
        return None
    # The ring must stay in the border band; if it leaked into the artwork, give up.
    inner = (xs > left + 8) & (xs < right - 8) & (ys > top + 8) & (ys < bottom - 8)
    if inner.mean() > 0.02:
        return None
    # outer corners (dark, outside the ring)
    for corner in ((1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)):
        if binary.getpixel(corner) == (0, 0, 0):
            ImageDraw.floodfill(binary, corner, (0, 0, 255))
    arr = np.array(binary)
    marked = ((arr[..., 0] == 255) & (arr[..., 1] == 0)) | ((arr[..., 2] == 255) & (arr[..., 0] == 0))
    plate = ~marked
    return Image.fromarray((plate * 255).astype(np.uint8))


def _rounded_mask(size: tuple[int, int], radius: float, scale: int = 4) -> Image.Image:
    big = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size[0] * scale - 1, size[1] * scale - 1), radius=radius * scale, fill=255
    )
    return big.resize(size, Image.LANCZOS)


def extract_plate(source: Image.Image) -> Image.Image:
    """Return the artwork cropped to its rounded plate, RGBA, transparent outside the plate."""
    rgba = source.convert("RGBA")
    alpha = np.array(rgba.getchannel("A"))

    if (alpha < 250).any():  # transparent source: alpha already is the mask
        return rgba.crop(rgba.getchannel("A").getbbox())

    gray = np.array(rgba.convert("L"))
    box = _scan_box(gray)
    if box is None:
        print("note: no plate/ring detected, using the whole image")
        return rgba

    left, top, right, bottom = box
    mask = _plate_mask_by_flood(gray, box)
    if mask is None:
        # Fallback: rounded rectangle from the measured edges and the diagonal corner position.
        diag = _first_edge(np.array([gray[i, i] for i in range(min(gray.shape))]))
        radius = (diag - (left + top) / 2) / (1 - math.sqrt(0.5)) if diag else min(right - left, bottom - top) * 0.2
        mask = Image.new("L", rgba.size, 0)
        mask.paste(_rounded_mask((right - left, bottom - top), radius), (left, top))

    # Pull the edge in by 3px so no ring/anti-alias fringe survives, then soften it.
    mask = mask.filter(ImageFilter.MinFilter(7)).filter(ImageFilter.GaussianBlur(1.2))
    box_px = mask.point(lambda v: 255 if v > 128 else 0).getbbox()
    out = rgba.copy()
    out.putalpha(ImageChops.multiply(out.getchannel("A"), mask))
    return out.crop(box_px)


# --- composition -----------------------------------------------------------------------------


def art_radius_px(plate: Image.Image) -> float:
    """Radius (px from the plate centre) that must stay visible under circular masks."""
    return max(plate.size) * ART_RADIUS_FRACTION


def paste_centered(canvas: Image.Image, art: Image.Image, art_px: int) -> Image.Image:
    scaled = art.resize((art_px, round(art_px * art.height / art.width)), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((canvas.width - scaled.width) // 2, (canvas.height - scaled.height) // 2))
    return canvas


def fitted(plate: Image.Image, canvas_px: int, radius_px: float, fill=(0, 0, 0, 0)) -> Image.Image:
    """Canvas with the plate scaled so its artwork stays inside a circle of `radius_px`."""
    scale = radius_px / art_radius_px(plate)
    side = max(2, round(max(plate.size) * scale))
    return paste_centered(Image.new("RGBA", (canvas_px, canvas_px), fill), plate, side)


def write_android(plate: Image.Image) -> None:
    for name, scale in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        legacy, adaptive = round(48 * scale), round(108 * scale)

        # Legacy square launcher (API 24-25): the rounded plate fills the icon.
        legacy_icon = Image.new("RGBA", (legacy, legacy), (0, 0, 0, 0))
        paste_centered(legacy_icon, plate, legacy).save(folder / "ic_launcher.png")

        # Legacy round launcher: dark disc, artwork kept inside it so nothing is clipped.
        disc = fitted(plate, legacy, legacy / 2 * ROUND_ART_RADIUS, BACKGROUND)
        mask = Image.new("L", (legacy * 4,) * 2, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, legacy * 4 - 1, legacy * 4 - 1), fill=255)
        disc.putalpha(mask.resize((legacy, legacy), Image.LANCZOS))
        disc.save(folder / "ic_launcher_round.png")

        # Adaptive foreground: artwork inside the launcher-guaranteed circle.
        fitted(plate, adaptive, ADAPTIVE_ART_RADIUS_DP * scale).save(folder / "ic_launcher_foreground.png")

    (RES / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '    <color name="ic_launcher_background">#0A0A0A</color>\n</resources>\n',
        encoding="utf-8",
    )

    # Solid dark launch/splash background (the Android 12+ splash shows the adaptive foreground).
    splash = Image.new("RGBA", (64, 64), BACKGROUND)
    for folder in RES.glob("drawable*"):
        if (folder / "splash.png").exists():
            splash.save(folder / "splash.png")


def write_web_and_docs(plate: Image.Image) -> None:
    connect = ROOT / "mobile/src/assets/app-icon.png"
    connect.parent.mkdir(parents=True, exist_ok=True)
    paste_centered(Image.new("RGBA", (180, 180), (0, 0, 0, 0)), plate, 180).save(connect)

    out = ROOT / "assets/icon"
    out.mkdir(parents=True, exist_ok=True)
    # Store-style: full bleed square, no transparency (the store applies its own mask).
    store = Image.new("RGBA", (512, 512), BACKGROUND)
    paste_centered(store, plate, 512)
    store.convert("RGB").save(out / "mono-hermes-icon-512.png")
    paste_centered(Image.new("RGBA", (256, 256), (0, 0, 0, 0)), plate, 256).save(out / "mono-hermes-logo.png")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", nargs="?", type=Path, default=DEFAULT_SOURCE, help="source icon PNG")
    args = parser.parse_args()
    if not args.source.exists():
        raise SystemExit(f"Source icon not found: {args.source}")

    plate = extract_plate(Image.open(args.source))
    print(f"plate {plate.size[0]}x{plate.size[1]}, artwork radius {art_radius_px(plate):.0f}px")
    write_android(plate)
    write_web_and_docs(plate)
    try:
        shown = args.source.resolve().relative_to(ROOT)
    except ValueError:
        shown = args.source.name
    print("icons regenerated from", shown)


if __name__ == "__main__":
    main()
