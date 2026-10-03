"""Undo must not let a player keep a card's immediate side effects.

Undo refunds the action cost and returns the card to hand. A card whose play
drew cards, gained resources or granted actions would otherwise be farmable
by play → undo → play (originally reported for Nest's immediate draw).
"""

from __future__ import annotations

from typing import Any

from app.game_engine.cards import _copy_card
from app.game_engine.game_state import (
    GameState,
    create_game,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    undo_planned_action,
)
from app.game_engine.hex_grid import GridSize

_uid = [0]


def _game(reg: dict[str, Any], archetype: str) -> GameState:
    game = create_game(
        GridSize.SMALL,
        [
            {"id": "p0", "name": "Alice", "archetype": archetype},
            {"id": "p1", "name": "Bob", "archetype": "vanguard"},
        ],
        reg,
        seed=7,
    )
    execute_start_of_turn(game)
    execute_upkeep(game)
    return game


def _give(game: GameState, reg: dict[str, Any], card_id: str, upgraded: bool = False):
    _uid[0] += 1
    card = _copy_card(reg[card_id], f"undo{_uid[0]}")
    card.is_upgraded = upgraded
    game.players["p0"].hand.insert(0, card)
    return card


def _own_tile(game: GameState):
    return next(t for t in game.grid.tiles.values() if t.owner == "p0")


def _neutral_adjacent(game: GameState):
    for t in game.grid.tiles.values():
        if t.owner != "p0":
            continue
        for a in game.grid.get_adjacent(t.q, t.r):
            if a.owner is None and not a.is_blocked and a.defense_power == 0:
                return a
    raise AssertionError("no neutral adjacent tile")


def test_nest_draw_cannot_be_undone(card_registry):
    game = _game(card_registry, "swarm")
    p0 = game.players["p0"]
    _give(game, card_registry, "swarm_nest")
    tile = _own_tile(game)
    hand_before = len(p0.hand)
    ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
    assert ok, msg
    assert len(p0.hand) == hand_before  # played 1, drew 1
    ok, msg = undo_planned_action(game, "p0", len(p0.planned_actions) - 1)
    assert not ok and "cannot be undone" in msg
    assert len(p0.hand) == hand_before  # no extra card gained


def test_entrench_action_refund_cannot_be_undone(card_registry):
    game = _game(card_registry, "fortress")
    p0 = game.players["p0"]
    _give(game, card_registry, "fortress_entrench")
    tile = _own_tile(game)
    ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
    assert ok, msg
    actions_after_play = p0.actions_available - p0.actions_used
    ok, _ = undo_planned_action(game, "p0", len(p0.planned_actions) - 1)
    assert not ok
    assert p0.actions_available - p0.actions_used == actions_after_play


def test_explore_undo_allowed_but_not_upgraded_draw(card_registry):
    game = _game(card_registry, "vanguard")
    p0 = game.players["p0"]

    # Base Explore has no immediate effect: undo still works.
    _give(game, card_registry, "neutral_explore")
    tile = _neutral_adjacent(game)
    ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
    assert ok, msg
    ok, msg = undo_planned_action(game, "p0", len(p0.planned_actions) - 1)
    assert ok, msg

    # Explore+ draws a card on play: undo is refused.
    _give(game, card_registry, "neutral_explore", upgraded=True)
    hand_before = len(p0.hand)
    ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
    assert ok, msg
    ok, _ = undo_planned_action(game, "p0", len(p0.planned_actions) - 1)
    assert not ok
    assert len(p0.hand) == hand_before


def test_serialized_reversible_flag_matches_undo_rule(card_registry):
    """The UI decides whether to offer undo from the serialized flag."""
    explore = _copy_card(card_registry["neutral_explore"], "ser1")
    assert explore.to_dict()["reversible"] is True
    explore.is_upgraded = True
    assert explore.to_dict()["reversible"] is False
    assert _copy_card(card_registry["swarm_nest"], "ser2").to_dict()["reversible"] is False
    assert _copy_card(card_registry["vanguard_coordinated_push"], "ser3").to_dict()["reversible"] is False


def test_no_reversible_card_has_immediate_side_effects(card_registry):
    """Guard: every card the engine lets you undo is side-effect free on play."""
    from app.game_engine.cards import Timing

    for card in card_registry.values():
        for upgraded in (False, True):
            card.is_upgraded = upgraded
            if card.effective_reversible:
                assert card.effective_action_return == 0, card.id
                if card.timing == Timing.IMMEDIATE:
                    assert card.effective_draw_cards == 0, card.id
                    assert card.effective_resource_gain == 0, card.id
        card.is_upgraded = False
