#!/usr/bin/env python3
"""Render the game's custom mouse cursors to PNG.

The cursors are drawn here as SVG (gilded metal on the game's deep indigo
ink) and rasterised with macOS `sips` into public/cursors/<name>.png (32 px)
and <name>@2x.png (64 px, for Retina via image-set). PNG rather than SVG
because Safari won't take SVG cursor images. Hotspots live in
src/utils/cursors.ts.

Usage (macOS, from the repo root):
    python3 frontend/scripts/build_cursors.py
"""

from __future__ import annotations

import os
import subprocess
import tempfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "cursors")

INK = "#120f26"
DEFS = """
<defs>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff3c4"/>
    <stop offset="0.42" stop-color="#e8bd5a"/>
    <stop offset="0.62" stop-color="#fff0c8"/>
    <stop offset="1" stop-color="#b4801f"/>
  </linearGradient>
  <linearGradient id="cuff" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#d9a945"/>
    <stop offset="1" stop-color="#8a6219"/>
  </linearGradient>
</defs>
"""


def layered(shapes: str, *, outline: float = 2.4, extra: str = "") -> str:
    """Drop shadow, dark outline, gold fill — the same shapes three times."""
    return f"""
<g transform="translate(0.8 1.4)" fill="#000" fill-opacity="0.32" stroke="#000" stroke-opacity="0.32"
   stroke-width="{outline}" stroke-linejoin="round">{shapes}</g>
<g fill="{INK}" stroke="{INK}" stroke-width="{outline}" stroke-linejoin="round">{shapes}</g>
<g fill="url(#gold)">{shapes}</g>
{extra}"""


ARROW = '<path d="M3 2 L3 23 L8.2 18.4 L11.8 26.6 L15.4 25 L11.9 17 L18.6 17 Z"/>'

HAND_OPEN = """
<rect x="10.2" y="6.5" width="3.7" height="12" rx="1.85"/>
<rect x="13.9" y="4.2" width="3.7" height="14.3" rx="1.85"/>
<rect x="17.6" y="5.4" width="3.7" height="13.1" rx="1.85"/>
<rect x="21.3" y="8.4" width="3.3" height="10.6" rx="1.65"/>
<path d="M10.4 16.4 L7.83 12.22 A1.9 1.9 0 0 0 4.57 14.18 L8.3 20.3 Q9.4 22.3 10.6 23.6
         Q12.6 25.8 15.2 25.8 L20.2 25.8 Q24.6 25.8 24.6 21.4 L24.6 15.6 L10.4 15.6 Z"/>
<rect x="11" y="24.6" width="12.8" height="4" rx="1.2"/>
"""

# The thumb is its own layer, drawn first so the curled fingers cover it.
FIST_THUMB = '<rect x="10.3" y="8.1" width="3.8" height="10.4" rx="1.9" transform="rotate(-41 12.2 16.6)"/>'

FIST = """
<rect x="9.6" y="11.6" width="15.2" height="13.6" rx="5"/>
<rect x="10" y="9.4" width="3.8" height="9" rx="1.9"/>
<rect x="13.7" y="8.8" width="3.8" height="9.4" rx="1.9"/>
<rect x="17.4" y="9.2" width="3.8" height="9.1" rx="1.9"/>
<rect x="21.1" y="10.2" width="3.5" height="8.2" rx="1.75"/>
<rect x="11" y="24.6" width="12.8" height="4" rx="1.2"/>
"""

CUFF = f'<rect x="11" y="24.6" width="12.8" height="4" rx="1.2" fill="url(#cuff)" stroke="{INK}" stroke-width="0.9"/>'


def hex_points(cx: float, cy: float, r: float) -> str:
    import math
    return " ".join(f"{cx + r * math.cos(math.radians(a)):.2f},{cy + r * math.sin(math.radians(a)):.2f}" for a in range(0, 360, 60))


TICKS = [((16, 2.6), (16, 6)), ((16, 26), (16, 29.4)), ((2.6, 16), (5.2, 16)), ((26.8, 16), (29.4, 16))]

CURSORS: dict[str, str] = {
    # The everyday pointer.
    "arrow": layered(ARROW),
    # Over a tile you can click for its details: the pointer with an info medallion.
    "inspect": layered(ARROW) + f"""
<circle cx="24.2" cy="24.2" r="7" fill="#000" fill-opacity="0.32" transform="translate(0.8 1.2)"/>
<circle cx="24.2" cy="24.2" r="6.9" fill="{INK}"/>
<circle cx="24.2" cy="24.2" r="5.9" fill="url(#gold)"/>
<circle cx="24.2" cy="24.2" r="4.5" fill="#1d1a44"/>
<circle cx="24.2" cy="21.7" r="1.05" fill="#ffe7a6"/>
<rect x="23.45" y="23.2" width="1.5" height="4.1" rx="0.6" fill="#ffe7a6"/>
""",
    # Aiming a card at a tile: a gilded hex reticle.
    "target": f"""
<polygon points="{hex_points(16, 16, 9)}" fill="#e8c46a" fill-opacity="0.14"/>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="{hex_points(16.6, 17, 9)}" stroke="#000" stroke-opacity="0.3" stroke-width="4"/>
  <polygon points="{hex_points(16, 16, 9)}" stroke="{INK}" stroke-width="4"/>
  {''.join(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="{INK}" stroke-width="3.6"/>' for a, b in TICKS)}
  <polygon points="{hex_points(16, 16, 9)}" stroke="url(#gold)" stroke-width="2"/>
  {''.join(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="#f3cf76" stroke-width="1.7"/>' for a, b in TICKS)}
</g>
<circle cx="16" cy="16" r="2.3" fill="{INK}"/>
<circle cx="16" cy="16" r="1.4" fill="#ffe7a6"/>
""",
    # Hovering a card in hand: an open gauntlet.
    "grab": layered(HAND_OPEN, extra=f"""
<g fill="none" stroke="{INK}" stroke-opacity="0.55" stroke-width="0.8" stroke-linecap="round">
  <line x1="13.95" y1="8.6" x2="13.95" y2="15.6"/>
  <line x1="17.65" y1="7.6" x2="17.65" y2="15.6"/>
  <line x1="21.35" y1="10.6" x2="21.35" y2="15.8"/>
  <path d="M10.6 17.6 Q10.5 20.4 12.2 22.4"/>
</g>
{CUFF}"""),
    # Holding a card (or the board): the gauntlet closed.
    "grabbing": layered(FIST_THUMB) + layered(FIST, extra=f"""
<g fill="none" stroke="{INK}" stroke-opacity="0.55" stroke-width="0.8" stroke-linecap="round">
  <line x1="13.75" y1="11.4" x2="13.75" y2="17.4"/>
  <line x1="17.45" y1="11.2" x2="17.45" y2="17.6"/>
  <line x1="21.15" y1="12" x2="21.15" y2="17.6"/>
  <path d="M10.6 18.6 Q17.3 20 24 18.6"/>
</g>
{CUFF}"""),
}


def svg(body: str, px: int) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" viewBox="0 0 32 32">{DEFS}{body}</svg>'


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for name, body in CURSORS.items():
            for px, suffix in ((32, ""), (64, "@2x")):
                src = os.path.join(tmp, f"{name}{suffix}.svg")
                with open(src, "w") as f:
                    f.write(svg(body, px))
                dst = os.path.join(OUT, f"{name}{suffix}.png")
                subprocess.run(["sips", "-s", "format", "png", src, "--out", dst], check=True, capture_output=True)
                print(f"wrote {os.path.relpath(dst)}")


if __name__ == "__main__":
    main()
