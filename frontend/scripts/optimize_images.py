#!/usr/bin/env python3
"""Generate compressed WebP copies of the game's PNG art.

The PNGs in public/ stay the source of truth (drop new art there as before);
this writes a sibling .webp next to each one, which the app loads first and
falls back to the PNG if missing. Card art shrinks ~12x (≈500 KB → ≈40 KB),
which is what makes hover previews appear instantly instead of popping in.

Incremental: a .webp is only (re)written when its PNG is newer.

Usage (from the repo root):
    uv run --project backend --with pillow python frontend/scripts/optimize_images.py
    uv run --project backend --with pillow python frontend/scripts/optimize_images.py --force
"""

from __future__ import annotations

import argparse
import os
import sys

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")

# (directory under public/, WebP quality, max width or None)
TARGETS = [
    ("cards", 80, None),
    ("assets/howtoplay", 82, 320),
]


def convert(src: str, dst: str, quality: int, max_width: int | None) -> tuple[int, int]:
    with Image.open(src) as im:
        im.load()
        if max_width and im.width > max_width:
            h = round(im.height * max_width / im.width)
            im = im.resize((max_width, h), Image.LANCZOS)
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        im = im.convert("RGBA" if has_alpha else "RGB")
        im.save(dst, "WEBP", quality=quality, method=6)
    return os.path.getsize(src), os.path.getsize(dst)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="rewrite every .webp")
    args = parser.parse_args()

    total_src = total_dst = written = 0
    for rel, quality, max_width in TARGETS:
        folder = os.path.join(ROOT, rel)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith(".png"):
                continue
            src = os.path.join(folder, name)
            dst = os.path.splitext(src)[0] + ".webp"
            if (not args.force and os.path.exists(dst)
                    and os.path.getmtime(dst) >= os.path.getmtime(src)):
                total_src += os.path.getsize(src)
                total_dst += os.path.getsize(dst)
                continue
            s, d = convert(src, dst, quality, max_width)
            total_src += s
            total_dst += d
            written += 1
    mb = 1024 * 1024
    print(f"wrote {written} webp file(s); PNG {total_src / mb:.1f} MB -> WebP {total_dst / mb:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
