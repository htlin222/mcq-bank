#!/usr/bin/env python3
"""
Generate frontend/public/og-image.png — a 1200x630 OpenGraph card for the
public landing. Brand strings come from /config.toml so this stays in sync
with the React app. Deterministic: re-running produces the same PNG.

Run:
    uv run --with pillow python3 scripts/gen-og-image.py
"""

import tomllib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "public" / "og-image.png"

with (ROOT / "config.toml").open("rb") as _f:
    CFG = tomllib.load(_f)

# Design palette mirrors tailwind.config.js
INK_50 = (247, 245, 242)        # bg
INK_900 = (12, 10, 6)           # primary text
INK_500 = (122, 110, 85)        # muted text  (approx — from ink scale)
ACCENT = (168, 68, 42)          # brick red
ACCENT_LIGHT = (203, 104, 69)
AMBER = (180, 83, 9)            # amber-700-ish

W, H = 1200, 630

# Fonts. Noto Serif CJK TC for the Chinese title, Source Serif as English
# fallback if the CJK font isn't installed.
CJK_BOLD = "/Users/htlin/Library/Fonts/NotoSerifCJKtc-Bold.otf"
CJK_MEDIUM = "/Users/htlin/Library/Fonts/NotoSerifCJKtc-Medium.otf"
CJK_REGULAR = "/Users/htlin/Library/Fonts/NotoSerifCJKtc-Regular.otf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size=size)
    except OSError:
        # Fallback to default if the CJK font is missing
        return ImageFont.load_default()


def main() -> None:
    img = Image.new("RGB", (W, H), INK_50)
    d = ImageDraw.Draw(img)

    # Subtle paper-grain accent stripe on the left edge (4px brick red)
    d.rectangle([(0, 0), (8, H)], fill=ACCENT)

    # Title
    title = CFG["brand"]["short_name"]
    title_font = font(CJK_BOLD, 138)
    title_xy = (96, 168)
    d.text(title_xy, title, font=title_font, fill=INK_900)

    # Year tag inline with title baseline
    year = CFG["brand"]["year"]
    year_font = font(CJK_BOLD, 92)
    # Place to the right of the title with margin
    title_w = d.textlength(title, font=title_font)
    d.text(
        (title_xy[0] + title_w + 28, title_xy[1] + 38),
        year,
        font=year_font,
        fill=ACCENT,
    )

    # Tagline
    tagline = CFG["brand"]["subtitle"]
    tagline_font = font(CJK_REGULAR, 36)
    d.text((96, 348), tagline, font=tagline_font, fill=INK_500)

    # Feature row — three pills
    pills = [
        ("共筆詳解", ACCENT),
        ("全真模擬", AMBER),
        ("答案挑戰", (16, 122, 87)),  # emerald-700-ish (matches challenge promoted badge)
    ]
    pill_font = font(CJK_MEDIUM, 30)
    pill_h = 60
    pill_pad_x = 28
    pill_gap = 16
    pill_y = 450
    x = 96
    for label, color in pills:
        w = d.textlength(label, font=pill_font) + pill_pad_x * 2
        # rounded box
        d.rounded_rectangle(
            [(x, pill_y), (x + w, pill_y + pill_h)],
            radius=pill_h // 2,
            outline=color,
            width=3,
        )
        # text vertically centered
        d.text(
            (x + pill_pad_x, pill_y + (pill_h - 30) // 2 - 4),
            label,
            font=pill_font,
            fill=color,
        )
        x += w + pill_gap

    # Footer: domain on bottom-right
    footer = CFG["public"]["host"]
    footer_font = font(CJK_REGULAR, 26)
    fw = d.textlength(footer, font=footer_font)
    d.text((W - fw - 96, H - 64), footer, font=footer_font, fill=INK_500)

    # Footer: invite-only tag bottom-left, in muted small text
    invite = CFG["public"]["og_invite_line"]
    invite_font = font(CJK_REGULAR, 22)
    d.text((96, H - 60), invite, font=invite_font, fill=INK_500)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"✅ wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB, {W}x{H})")


if __name__ == "__main__":
    main()
