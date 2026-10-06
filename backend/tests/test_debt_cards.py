"""Debt-cost cards: a Debt is the price of a strong effect.

Mercenary, Garrison and Siege Tower take a Debt when their claim resolves
(so a planned play can still be undone); Prospector takes one when played;
Warden and Land Grant add one when bought.
"""

from __future__ import annotations

from app.game_engine.cards import DEF_ID_DEBT, Card, _copy_card
from app.game_engine.game_state import (
    GameState,
    Phase,
    advance_resolve,
    buy_card,
    play_card,
    submit_play,
    undo_planned_action,
)
from tests.test_card_resolution import _find_adjacent_neutral, _make_2p_game


def _debts(game: GameState, pid: str) -> int:
    p = game.players[pid]
    return sum(1 for c in p.hand + p.deck.cards + p.deck.discard if c.definition_id == DEF_ID_DEBT)


def _play_claim(game: GameState, card: Card, target: tuple[int, int]) -> None:
    player = game.players["p0"]
    player.hand = [card] + player.hand[1:]
    ok, msg = play_card(game, "p0", 0, target_q=target[0], target_r=target[1])
    assert ok, msg


def _resolve(game: GameState) -> None:
    submit_play(game, "p0")
    submit_play(game, "p1")


def _to_buy(game: GameState) -> None:
    _resolve(game)
    for pid in game.player_order:
        advance_resolve(game, pid)
    assert game.current_phase == Phase.BUY


class TestDebtOnResolution:
    def test_mercenary_costs_a_debt_not_resources(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        player.resources = 0
        target = _find_adjacent_neutral(game, "p0")
        _play_claim(game, _copy_card(card_registry["neutral_mercenary"], "m"), target)  # type: ignore[arg-type]
        assert player.resources == 0
        assert _debts(game, "p0") == 0  # not until the claim resolves
        _resolve(game)
        assert game.grid.get_tile(*target).owner == "p0"  # type: ignore[union-attr,misc]
        assert _debts(game, "p0") == 1
        assert any(e.get("added_card_name") == "Debt" and e["target_player_id"] == "p0" for e in game.player_effects)

    def test_mercenary_play_can_be_undone_without_a_debt(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry)
        target = _find_adjacent_neutral(game, "p0")
        _play_claim(game, _copy_card(card_registry["neutral_mercenary"], "m"), target)  # type: ignore[arg-type]
        ok, msg = undo_planned_action(game, "p0", 0)
        assert ok, msg
        _resolve(game)
        assert _debts(game, "p0") == 0

    def test_garrison_takes_a_debt_attacking_and_defending(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry, arch0="fortress")
        target = _find_adjacent_neutral(game, "p0")
        _play_claim(game, _copy_card(card_registry["fortress_garrison"], "g1"), target)  # type: ignore[arg-type]
        _resolve(game)
        assert _debts(game, "p0") == 1

        game = _make_2p_game(card_registry, arch0="fortress")
        owned = next(t for t in game.grid.get_player_tiles("p0") if not t.is_base)  # type: ignore[union-attr]
        _play_claim(game, _copy_card(card_registry["fortress_garrison"], "g2"), (owned.q, owned.r))
        _resolve(game)
        assert _debts(game, "p0") == 1

    def test_siege_tower_costs_one_action_and_a_debt(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        used = player.actions_used
        target = _find_adjacent_neutral(game, "p0")
        _play_claim(game, _copy_card(card_registry["neutral_siege_tower"], "s"), target)  # type: ignore[arg-type]
        assert player.actions_used == used + 1
        _resolve(game)
        assert _debts(game, "p0") == 1


class TestDebtOnPlay:
    def test_prospector_gains_six_and_a_debt(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        player.hand = [_copy_card(card_registry["neutral_prospector"], "p")] + player.hand[1:]
        before = player.resources
        ok, msg = play_card(game, "p0", 0)
        assert ok, msg
        assert player.resources == before + 6
        assert _debts(game, "p0") == 1


class TestDebtOnBuy:
    def test_land_grant_adds_a_debt_when_bought(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry)
        _to_buy(game)
        player = game.players["p0"]
        player.resources = 20
        assert "neutral_land_grant" in game.shared_market.stacks
        ok, msg = buy_card(game, "p0", "shared", "neutral_land_grant")
        assert ok, msg
        assert _debts(game, "p0") == 1

    def test_warden_adds_a_debt_when_bought(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry, arch0="fortress")
        _to_buy(game)
        player = game.players["p0"]
        player.resources = 20
        warden = _copy_card(card_registry["fortress_warden"], "w")
        player.archetype_market.append(warden)
        player.archetype_deck.append(warden)
        ok, msg = buy_card(game, "p0", "archetype", warden.id)
        assert ok, msg
        assert _debts(game, "p0") == 1

    def test_other_cards_add_no_debt(self, card_registry: dict[str, Card]) -> None:
        game = _make_2p_game(card_registry)
        _to_buy(game)
        game.players["p0"].resources = 20
        base_id = next(k for k, v in game.shared_market.stacks.items() if v and not v[0].buy_debt)
        ok, msg = buy_card(game, "p0", "shared", base_id)
        assert ok, msg
        assert _debts(game, "p0") == 0
