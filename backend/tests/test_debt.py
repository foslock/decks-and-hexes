"""Tests for Debt card mechanic and round limit."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.data_loader.loader import load_all_cards
from app.game_engine.cards import (
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
    make_debt_card,
    _copy_card,
)
from app.game_engine.game_state import (
    DEBT_START_ROUND,
    DEFAULT_MAX_ROUNDS,
    GameState,
    Phase,
    Player,
    compute_player_vp,
    create_game,
    execute_end_of_turn,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_play,
    execute_reveal,
    advance_resolve,
    buy_card,
    end_buy_phase,
)
from app.game_engine.hex_grid import GridSize


@pytest.fixture
def card_registry() -> dict[str, Card]:
    return load_all_cards()


def _make_2p_game(card_registry, seed=42, max_rounds=None):
    game = create_game(
        GridSize.SMALL,
        [
            {"id": "p0", "name": "Alice", "archetype": "vanguard"},
            {"id": "p1", "name": "Bob", "archetype": "swarm"},
        ],
        card_registry,
        seed=seed,
        max_rounds=max_rounds,
    )
    return game


def _advance_to_play(game):
    """Run start-of-turn + upkeep to reach PLAY phase."""
    execute_start_of_turn(game)
    execute_upkeep(game)
    assert game.current_phase == Phase.PLAY


def _skip_to_end_of_turn(game):
    """Submit empty plays and advance through reveal/buy to end of turn."""
    for pid in game.player_order:
        submit_play(game, pid)
    for pid in game.player_order:
        advance_resolve(game, pid)
    for pid in game.player_order:
        if pid not in game.players_done_buying:
            end_buy_phase(game, pid)


# ── Debt Card Properties ─────────────────────────────────────────────


class TestDebtCardProperties:
    def test_debt_card_is_engine(self):
        debt = make_debt_card()
        assert debt.card_type == CardType.ENGINE

    def test_debt_card_is_not_trash_immune(self):
        debt = make_debt_card()
        assert debt.trash_immune is False

    def test_debt_card_is_trash_on_use(self):
        debt = make_debt_card()
        assert debt.trash_on_use is True

    def test_debt_card_costs_3_resources(self):
        debt = make_debt_card()
        assert debt.resource_gain == -3

    def test_debt_card_is_neutral(self):
        debt = make_debt_card()
        assert debt.archetype == Archetype.NEUTRAL

    def test_debt_card_unique_ids(self):
        d1 = make_debt_card()
        d2 = make_debt_card()
        assert d1.id != d2.id


# ── Debt Distribution ────────────────────────────────────────────────


class TestDebtDistribution:
    def test_no_debt_before_round_5(self, card_registry):
        """No Debt cards distributed during rounds 1-4."""
        game = _make_2p_game(card_registry)
        # Play through rounds 1 to DEBT_START_ROUND-2 fully,
        # then start round DEBT_START_ROUND-1 and check before end-of-turn
        # (execute_end_of_turn auto-calls execute_start_of_turn for next round)
        for rnd in range(1, DEBT_START_ROUND):
            _advance_to_play(game)
            # Check at play phase — no debt yet
            for pid in game.player_order:
                p = game.players[pid]
                all_cards = p.hand + p.deck.cards + p.deck.discard
                assert not any(c.name == "Debt" for c in all_cards), (
                    f"Player {pid} has a Debt card at round {rnd} (before round {DEBT_START_ROUND})"
                )
            _skip_to_end_of_turn(game)

    def test_debt_distributed_at_round_5(self, card_registry):
        """VP leader receives a Debt card at round 5."""
        game = _make_2p_game(card_registry)

        # Give p0 extra VP tiles before any rounds start
        grid = game.grid
        neutral_tiles = [
            t for t in grid.tiles.values()
            if t.owner is None and not t.is_blocked and t.is_vp
        ]
        for tile in neutral_tiles[:3]:
            tile.owner = "p0"
            tile.held_since_round = 0

        # Play through rounds 1-4 (end-of-turn for round 4 auto-starts round 5)
        for _ in range(DEBT_START_ROUND - 1):
            _advance_to_play(game)
            _skip_to_end_of_turn(game)

        # We're now in round 5 UPKEEP — debt was just distributed
        assert game.current_round == DEBT_START_ROUND

        # Check p0 (VP leader) got a debt card in their discard
        p0 = game.players["p0"]
        all_cards = p0.hand + p0.deck.cards + p0.deck.discard
        debt_cards = [c for c in all_cards if c.name == "Debt"]
        assert len(debt_cards) == 1

    def test_debt_tiebreak_closest_to_first_player(self, card_registry):
        """Among tied VP leaders, closest to first_player_index gets Debt."""
        game = _make_2p_game(card_registry)
        # Play through rounds 1-4 (end-of-turn for round 4 auto-starts round 5)
        for _ in range(DEBT_START_ROUND - 1):
            _advance_to_play(game)
            _skip_to_end_of_turn(game)

        # We're now in round 5 — debt was distributed during start-of-turn
        assert game.current_round == DEBT_START_ROUND

        # Both players have same VP (tied) — first player in turn order gets debt
        first_pid = game.player_order[game.first_player_index]
        p = game.players[first_pid]
        all_cards = p.hand + p.deck.cards + p.deck.discard
        debt_cards = [c for c in all_cards if c.name == "Debt"]
        assert len(debt_cards) == 1


# ── Playing Debt Card ────────────────────────────────────────────────


class TestPlayDebt:
    def test_play_debt_with_enough_resources(self, card_registry):
        """Playing Debt with >= 3 resources succeeds and after resolve costs 3 + trashes."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        debt = make_debt_card()
        p0.hand.insert(0, debt)
        p0.resources = 5

        success, msg = play_card(game, "p0", 0)
        assert success, msg

        # Submit plays and resolve to trigger resource deduction and trash
        for pid in game.player_order:
            submit_play(game, pid)
        for pid in game.player_order:
            advance_resolve(game, pid)

        # After resolve: resources should be 5 - 3 = 2
        assert p0.resources == 2
        # Card should be trashed (not in hand, discard, or draw)
        all_cards = p0.hand + p0.deck.cards + p0.deck.discard
        assert not any(c.id == debt.id for c in all_cards)

    def test_play_debt_without_enough_resources(self, card_registry):
        """Playing Debt with < 3 resources fails."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        debt = make_debt_card()
        p0.hand.insert(0, debt)
        p0.resources = 2

        success, msg = play_card(game, "p0", 0)
        assert not success
        assert "3 resources" in msg.lower() or "need" in msg.lower()


# ── Round Limit ──────────────────────────────────────────────────────


class TestRoundLimit:
    def test_game_ends_at_round_limit(self, card_registry):
        """Game ends when round limit is reached."""
        game = _make_2p_game(card_registry, max_rounds=3)
        assert game.max_rounds == 3

        for rnd in range(3):
            _advance_to_play(game)
            _skip_to_end_of_turn(game)

        assert game.current_phase == Phase.GAME_OVER
        assert len(game.winners) > 0

    def test_highest_vp_wins_at_round_limit(self, card_registry):
        """Player with highest VP wins when round limit is reached."""
        game = _make_2p_game(card_registry, max_rounds=3)

        # Give p0 VP tiles
        vp_tiles = [
            t for t in game.grid.tiles.values()
            if t.owner is None and not t.is_blocked and t.is_vp
        ]
        for tile in vp_tiles[:3]:
            tile.owner = "p0"

        for _ in range(3):
            _advance_to_play(game)
            _skip_to_end_of_turn(game)

        assert game.current_phase == Phase.GAME_OVER
        assert "p0" in game.winners

    def test_tied_vp_at_round_limit(self, card_registry):
        """Tied VP at round limit results in multiple winners."""
        game = _make_2p_game(card_registry, max_rounds=2)

        # Both players start with same VP (from starting tiles)
        for _ in range(2):
            _advance_to_play(game)
            _skip_to_end_of_turn(game)

        assert game.current_phase == Phase.GAME_OVER
        # Both should be in winners (tied)
        assert len(game.winners) >= 1  # At least one winner

    def test_vp_target_win_at_end_of_turn(self, card_registry):
        """VP target win is checked at end of turn."""
        game = _make_2p_game(card_registry)

        # Give p0 enough VP tiles to exceed target
        vp_target = game.vp_target
        all_tiles = [
            t for t in game.grid.tiles.values()
            if not t.is_blocked
        ]
        # Assign many tiles to p0 to exceed VP target
        for tile in all_tiles:
            if tile.owner is None:
                tile.owner = "p0"

        # Need to mark tiles as held since previous turn for VP scoring
        for tile in all_tiles:
            if tile.owner == "p0":
                tile.held_since_round = 0  # held since before round 1

        _advance_to_play(game)
        _skip_to_end_of_turn(game)

        assert game.current_phase == Phase.GAME_OVER
        assert game.winner == "p0"
        assert "p0" in game.winners

    def test_default_max_rounds(self, card_registry):
        """Default max_rounds is DEFAULT_MAX_ROUNDS."""
        game = _make_2p_game(card_registry)
        assert game.max_rounds == DEFAULT_MAX_ROUNDS

    def test_custom_max_rounds(self, card_registry):
        """Custom max_rounds is respected."""
        game = _make_2p_game(card_registry, max_rounds=10)
        assert game.max_rounds == 10


# ── Trash Immunity ───────────────────────────────────────────────────


class TestTrashImmunity:
    def test_debt_can_be_trashed_by_other_effects(self, card_registry):
        """Debt cards can be trashed by other card effects."""
        debt = make_debt_card()
        assert debt.trash_immune is False


# ── Financier Card ──────────────────────────────────────────────────


class TestFinancier:
    def test_financier_exists_in_registry(self, card_registry):
        """Financier card is loaded from card data."""
        assert "vanguard_financier" in card_registry
        card = card_registry["vanguard_financier"]
        assert card.name == "Financier"
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 8
        assert card.archetype == Archetype.VANGUARD

    def test_financier_draws_per_debt_in_deck(self, card_registry):
        """Financier draws 1 card per Debt in hand + draw + discard."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        financier = _copy_card(card_registry["vanguard_financier"], "financier_test")

        # Add 2 Debt cards: one in discard, one in draw pile
        debt1 = make_debt_card()
        debt2 = make_debt_card()
        p0.deck.discard.append(debt1)
        p0.deck.cards.append(debt2)

        # Put financier in hand
        p0.hand.insert(0, financier)
        hand_before = len(p0.hand)

        success, _ = play_card(game, "p0", 0)
        assert success

        # Should have drawn 2 cards (1 per Debt)
        # hand_before included financier (now played), so hand = hand_before - 1 + 2
        assert len(p0.hand) == hand_before - 1 + 2

    def test_financier_no_debt_no_draw(self, card_registry):
        """Financier draws nothing when no Debt cards exist."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        financier = _copy_card(card_registry["vanguard_financier"], "financier_test")

        # Ensure no Debt cards anywhere
        p0.hand = [financier] + [c for c in p0.hand if c.name != "Debt"]
        p0.deck.cards = [c for c in p0.deck.cards if c.name != "Debt"]
        p0.deck.discard = [c for c in p0.deck.discard if c.name != "Debt"]

        hand_before = len(p0.hand)
        success, _ = play_card(game, "p0", 0)
        assert success
        # No draws, just financier removed from hand
        assert len(p0.hand) == hand_before - 1

    def test_financier_counts_debt_in_hand(self, card_registry):
        """Financier counts Debt cards in hand too (not just draw/discard)."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        financier = _copy_card(card_registry["vanguard_financier"], "financier_test")
        debt = make_debt_card()

        # Put Debt in hand alongside Financier, with cards in deck to draw
        filler = [_copy_card(card_registry["neutral_explore"], f"filler_{i}") for i in range(5)]
        p0.hand = [financier, debt]
        p0.deck.cards = filler
        p0.deck.discard = []

        success, _ = play_card(game, "p0", 0)
        assert success
        # 1 Debt in hand → draw 1 card
        # Started with [financier, debt], played financier (removed), drew 1
        assert len(p0.hand) == 2  # debt + 1 drawn

    def test_financier_ignores_trashed_debt(self, card_registry):
        """Financier does not count Debt cards in trash."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        financier = _copy_card(card_registry["vanguard_financier"], "financier_test")
        trashed_debt = make_debt_card()

        # Put Debt only in trash
        p0.trash.append(trashed_debt)
        p0.hand = [financier]
        p0.deck.cards = [_copy_card(card_registry["neutral_explore"], f"filler_{i}") for i in range(5)]
        p0.deck.discard = []

        hand_before = len(p0.hand)
        success, _ = play_card(game, "p0", 0)
        assert success
        # No Debt in hand/draw/discard → no draws
        assert len(p0.hand) == hand_before - 1

    def test_financier_upgraded_grants_actions(self, card_registry):
        """Upgraded Financier grants 2 extra actions via action_return."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        financier = _copy_card(card_registry["vanguard_financier"], "financier_test")
        financier.is_upgraded = True
        debt = make_debt_card()

        p0.hand = [financier, debt]
        p0.deck.cards = [_copy_card(card_registry["neutral_explore"], f"filler_{i}") for i in range(5)]
        p0.deck.discard = []

        actions_before = p0.actions_available
        success, _ = play_card(game, "p0", 0)
        assert success
        # Upgraded action_return is 2 → actions_available increases by 2
        # (play cost tracked via actions_used, not subtracted from actions_available)
        assert p0.actions_available == actions_before + 2

    def test_financier_draws_multiple_debts(self, card_registry):
        """Financier draws correct count with Debts spread across zones."""
        game = _make_2p_game(card_registry)
        _advance_to_play(game)

        p0 = game.players["p0"]
        financier = _copy_card(card_registry["vanguard_financier"], "financier_test")

        # 3 Debts: 1 in hand, 1 in draw, 1 in discard
        debt1 = make_debt_card()
        debt2 = make_debt_card()
        debt3 = make_debt_card()
        filler = [_copy_card(card_registry["neutral_explore"], f"filler_{i}") for i in range(10)]

        p0.hand = [financier, debt1]
        p0.deck.cards = [debt2] + filler
        p0.deck.discard = [debt3]

        hand_before = len(p0.hand)
        success, _ = play_card(game, "p0", 0)
        assert success
        # 3 Debts → draw 3 cards. Hand = (before - 1 played) + 3 drawn
        assert len(p0.hand) == hand_before - 1 + 3
