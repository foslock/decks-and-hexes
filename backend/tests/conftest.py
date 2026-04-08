"""Shared test fixtures."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure backend is importable
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.data_loader.loader import load_all_cards
from app.game_engine.cards import Archetype, Card, CardType, Deck, Timing
from app.game_engine.game_state import GameState, create_game, execute_start_of_turn, execute_upkeep
from app.game_engine.hex_grid import GridSize


@pytest.fixture
def card_registry() -> dict[str, Card]:
    return load_all_cards()


@pytest.fixture
def small_2p_game(card_registry: dict[str, Card]) -> GameState:
    """A 2-player small game after start-of-turn (in Play phase)."""
    game = create_game(
        GridSize.SMALL,
        [
            {"id": "p0", "name": "Alice", "archetype": "vanguard"},
            {"id": "p1", "name": "Bob", "archetype": "swarm"},
        ],
        card_registry,
        seed=42,
    )
    execute_start_of_turn(game)
    execute_upkeep(game)  # advance through upkeep to PLAY phase
    return game


@pytest.fixture
def medium_3p_game(card_registry: dict[str, Card]) -> GameState:
    """A 3-player medium game after start-of-turn."""
    game = create_game(
        GridSize.MEDIUM,
        [
            {"id": "p0", "name": "Alice", "archetype": "vanguard"},
            {"id": "p1", "name": "Bob", "archetype": "swarm"},
            {"id": "p2", "name": "Carol", "archetype": "fortress"},
        ],
        card_registry,
        seed=99,
    )
    execute_start_of_turn(game)
    execute_upkeep(game)  # advance through upkeep to PLAY phase
    return game
