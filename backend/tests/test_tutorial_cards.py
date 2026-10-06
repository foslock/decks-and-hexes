"""The tutorial embeds its cards; they must match the card data."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "build_tutorial_cards.py"


def test_tutorial_cards_match_the_card_data() -> None:
    spec = importlib.util.spec_from_file_location("build_tutorial_cards", SCRIPT)
    assert spec and spec.loader
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    assert build.TARGET.read_text() == build.render(), (
        "The tutorial's cards are out of date — run: cd backend && uv run python scripts/build_tutorial_cards.py"
    )
