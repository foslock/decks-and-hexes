"""Guard: no emoji in backend strings or card data.

The frontend renders all game symbols with its own icon set, so text that
reaches the UI from the backend (log lines, player-effect labels, card
descriptions in data/*.yaml) must be plain words. This test fails if an
emoji / pictograph comes back anywhere in backend/app or data/ (comments
included, to keep the rule simple).
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BANNED = re.compile(
    "[\U0001F000-\U0001FAFF☀-➿⬀-⯿⌀-⏿️]"
)
# Escaped forms in Python source: "\U0001F916", "\u2694", "\N{...}" is not used.
ESCAPE = re.compile(r"\\U([0-9A-Fa-f]{8})|\\u([0-9A-Fa-f]{4})")
# Deliberate exceptions as "relative/path:line". Keep this empty.
ALLOWLIST: set[str] = set()


def _scan(paths: list[Path]) -> list[str]:
    hits: list[str] = []
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            where = f"{rel}:{i}"
            if where in ALLOWLIST:
                continue
            m = BANNED.search(line)
            if m:
                hits.append(f"{where}  {m.group(0)!r}  {line.strip()[:100]}")
            for e in ESCAPE.finditer(line):
                cp = int(e.group(1) or e.group(2), 16)
                if BANNED.match(chr(cp)):
                    hits.append(f"{where}  {e.group(0)}  {line.strip()[:100]}")
    return hits


def test_backend_app_has_no_emoji() -> None:
    files = sorted((ROOT / "backend" / "app").rglob("*.py"))
    assert files, "backend/app not found"
    hits = _scan(files)
    assert not hits, "Emoji found in backend code (use plain words):\n" + "\n".join(hits)


def test_card_data_has_no_emoji() -> None:
    files = sorted((ROOT / "data").glob("*.yaml"))
    assert files, "data/*.yaml not found"
    hits = _scan(files)
    assert not hits, "Emoji found in card data (use plain words):\n" + "\n".join(hits)
