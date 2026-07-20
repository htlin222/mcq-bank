#!/usr/bin/env python3
"""
Generate frontend/public/icons/* — the PWA home-screen icon set, rendered
from frontend/public/favicon.svg so the installed app matches the browser
tab. Palette mirrors tailwind.config.js (ink-50 background, accent glyph).
Deterministic: re-running produces the same PNGs.

Run:
    uv run --with pillow --with cairosvg python3 scripts/gen-pwa-icons.py
"""

import os
import tomllib
from io import BytesIO
from pathlib import Path

# cairosvg binds libcairo through ctypes. On macOS the Homebrew dylib is not
# on the default dyld search path, so cairocffi's dlopen fails with
# "no library called cairo-2 was found" unless we point at it first. Must
# happen before `import cairosvg`. (`brew install cairo` is the only system
# prerequisite; on Linux the distro package is already on the loader path.)
for _libdir in ("/opt/homebrew/lib", "/usr/local/lib"):
    if os.path.isdir(_libdir):
        os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = ":".join(
            filter(None, [os.environ.get("DYLD_FALLBACK_LIBRARY_PATH"), _libdir])
        )

import cairosvg  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "public" / "favicon.svg"
OUT = ROOT / "frontend" / "public" / "icons"

with (ROOT / "config.toml").open("rb") as _f:
    CFG = tomllib.load(_f)

# Design palette mirrors tailwind.config.js (:9 ink-50, :21 accent.DEFAULT)
INK_50 = (247, 245, 242, 255)

# Glyph coverage as a fraction of the canvas edge.
#   plain      — normal launcher icon, browser applies its own rounding
#   maskable   — Android may crop to a circle inscribed in the 80% safe zone,
#                so the glyph has to stay well inside that.
COVERAGE_PLAIN = 0.62
COVERAGE_MASKABLE = 0.44


def render_glyph(px: int) -> Image.Image:
    """favicon.svg → RGBA bitmap of px × px."""
    png = cairosvg.svg2png(
        url=str(SRC), output_width=px, output_height=px, background_color=None
    )
    return Image.open(BytesIO(png)).convert("RGBA")


def compose(size: int, coverage: float) -> Image.Image:
    """Opaque ink-50 square with the accent droplet centred on it.

    Opaque on purpose — iOS ignores alpha on apple-touch-icon and composites
    it onto black, which would give the droplet a dark halo.
    """
    canvas = Image.new("RGBA", (size, size), INK_50)
    g = max(1, round(size * coverage))
    glyph = render_glyph(g)
    canvas.alpha_composite(glyph, ((size - g) // 2, (size - g) // 2))
    return canvas.convert("RGB")


TARGETS = [
    ("icon-192.png", 192, COVERAGE_PLAIN),
    ("icon-512.png", 512, COVERAGE_PLAIN),
    ("icon-512-maskable.png", 512, COVERAGE_MASKABLE),
    ("apple-touch-icon-180.png", 180, COVERAGE_PLAIN),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, coverage in TARGETS:
        img = compose(size, coverage)
        img.save(OUT / name, "PNG", optimize=True)
        print(f"  {name:28s} {img.size[0]}x{img.size[1]}  {(OUT / name).stat().st_size:>6} B")
    print(f"wrote {len(TARGETS)} icons for {CFG['brand']['short_name']} → {OUT}")


if __name__ == "__main__":
    main()
