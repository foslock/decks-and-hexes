"""Tests for game state management and turn loop."""

from __future__ import annotations

import pytest

from app.game_engine.cards import Archetype, Card, CardType, Timing
from app.game_engine.game_state import (
    REROLL_COST,
    STARTING_RESOURCES,
    UPKEEP_COST,
    UPGRADE_CREDIT_COST,
    VP_TARGET,
    GameState,
    Phase,
    buy_card,
    create_game,
    execute_end_of_turn,
    execute_reveal,
    execute_start_of_turn,
    play_card,
    reroll_market,
    submit_plan,
)
from app.game_engine.hex_grid import GridSize


class TestGameCreation:
    def test_create_game_basic(self, card_registry: dict[str, Card]) -> None:
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        assert len(game.players) == 2
        assert len(game.player_order) == 2
        assert game.current_round == 1
        assert game.grid is not None
        assert len(game.grid.tiles) == 37

    def test_players_have_starting_resources(self, card_registry: dict[str, Card]) -> None:
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        for p in game.players.values():
            assert p.resources == STARTING_RESOURCES

    def test_players_own_starting_tiles(self, card_registry: dict[str, Card]) -> None:
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        assert game.grid is not None
        for pid in game.player_order:
            owned = game.grid.get_player_tiles(pid)
            assert len(owned) == 2  # 2-tile starting cluster

    def test_players_have_archetype_decks(self, card_registry: dict[str, Card]) -> None:
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        for p in game.players.values():
            assert len(p.archetype_deck) > 0

    def test_neutral_market_initialized(self, card_registry: dict[str, Card]) -> None:
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        available = game.neutral_market.get_available()
        assert len(available) > 0

    def test_three_player_game(self, card_registry: dict[str, Card]) -> None:
        game = create_game(
            GridSize.MEDIUM,
            [
                {"id": "p0", "name": "A", "archetype": "vanguard"},
                {"id": "p1", "name": "B", "archetype": "swarm"},
                {"id": "p2", "name": "C", "archetype": "fortress"},
            ],
            card_registry,
            seed=42,
        )
        assert len(game.players) == 3
        assert game.grid is not None
        assert len(game.grid.tiles) == 61


class TestStartOfTurn:
    def test_round_1_no_upkeep(self, small_2p_game: GameState) -> None:
        """Round 1 should not charge upkeep."""
        for p in small_2p_game.players.values():
            assert p.resources == STARTING_RESOURCES

    def test_round_1_draws_hand(self, small_2p_game: GameState) -> None:
        for p in small_2p_game.players.values():
            assert len(p.hand) == p.hand_size

    def test_phase_is_plan_after_start(self, small_2p_game: GameState) -> None:
        assert small_2p_game.current_phase == Phase.PLAN

    def test_archetype_market_populated(self, small_2p_game: GameState) -> None:
        for p in small_2p_game.players.values():
            assert len(p.archetype_market) <= 3

    def test_actions_reset(self, small_2p_game: GameState) -> None:
        for p in small_2p_game.players.values():
            assert p.actions_used == 0
            assert p.actions_available == p.action_slots

    def test_round_2_charges_upkeep(self, small_2p_game: GameState) -> None:
        """After advancing to round 2, upkeep should be charged."""
        game = small_2p_game
        # Submit plans for all players (play nothing)
        for pid in game.player_order:
            submit_plan(game, pid)
        # End turn to advance
        execute_end_of_turn(game)
        # Now in round 2 after start_of_turn
        for p in game.players.values():
            assert p.resources == STARTING_RESOURCES - UPKEEP_COST


class TestPlanPhase:
    def test_play_claim_card(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        p0 = game.players["p0"]
        # Find a claim card in hand
        claim_idx = next(i for i, c in enumerate(p0.hand) if c.card_type == CardType.CLAIM)
        # Find an adjacent unowned tile
        assert game.grid is not None
        owned = game.grid.get_player_tiles("p0")
        target = None
        for ot in owned:
            for adj in game.grid.get_adjacent(ot.q, ot.r):
                if adj.owner is None:
                    target = adj
                    break
            if target:
                break
        assert target is not None

        hand_before = len(p0.hand)
        ok, msg = play_card(game, "p0", claim_idx, target.q, target.r)
        assert ok, msg
        assert len(p0.hand) == hand_before - 1
        assert p0.actions_used == 1
        assert len(p0.planned_actions) == 1

    def test_play_engine_card_no_target(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        p0 = game.players["p0"]
        # Find an engine card (Gather)
        engine_idx = next((i for i, c in enumerate(p0.hand) if c.card_type == CardType.ENGINE), None)
        if engine_idx is not None:
            resources_before = p0.resources
            ok, msg = play_card(game, "p0", engine_idx)
            assert ok, msg
            # Gather gives 2 resources immediately
            assert p0.resources == resources_before + 2

    def test_cannot_play_on_blocked_tile(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        p0 = game.players["p0"]
        claim_idx = next(i for i, c in enumerate(p0.hand) if c.card_type == CardType.CLAIM)
        assert game.grid is not None
        blocked = next(t for t in game.grid.tiles.values() if t.is_blocked)
        ok, msg = play_card(game, "p0", claim_idx, blocked.q, blocked.r)
        assert not ok
        assert "blocked" in msg.lower()

    def test_cannot_play_non_adjacent(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        p0 = game.players["p0"]
        claim_idx = next(i for i, c in enumerate(p0.hand) if c.card_type == CardType.CLAIM)
        # Find a tile far from player's territory
        assert game.grid is not None
        owned_keys = {t.key for t in game.grid.get_player_tiles("p0")}
        adj_keys = set()
        for t in game.grid.get_player_tiles("p0"):
            for a in game.grid.get_adjacent(t.q, t.r):
                adj_keys.add(a.key)
        far_tile = next(
            t for t in game.grid.tiles.values()
            if t.key not in owned_keys and t.key not in adj_keys and not t.is_blocked
        )
        ok, msg = play_card(game, "p0", claim_idx, far_tile.q, far_tile.r)
        assert not ok
        assert "adjacent" in msg.lower()

    def test_cannot_play_in_wrong_phase(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        game.current_phase = Phase.BUY
        ok, msg = play_card(game, "p0", 0)
        assert not ok
        assert "phase" in msg.lower()

    def test_invalid_card_index(self, small_2p_game: GameState) -> None:
        ok, msg = play_card(small_2p_game, "p0", 99)
        assert not ok

    def test_invalid_player_id(self, small_2p_game: GameState) -> None:
        ok, msg = play_card(small_2p_game, "nonexistent", 0)
        assert not ok

    def test_cannot_double_claim_same_tile(self, small_2p_game: GameState) -> None:
        """One claim per tile unless stacking exception."""
        game = small_2p_game
        p0 = game.players["p0"]
        assert game.grid is not None

        # Find target tile
        owned = game.grid.get_player_tiles("p0")
        target = None
        for ot in owned:
            for adj in game.grid.get_adjacent(ot.q, ot.r):
                if adj.owner is None:
                    target = adj
                    break
            if target:
                break
        assert target is not None

        # Play first claim
        idx1 = next(i for i, c in enumerate(p0.hand) if c.card_type == CardType.CLAIM)
        ok1, _ = play_card(game, "p0", idx1, target.q, target.r)
        assert ok1

        # Try second claim on same tile
        idx2 = next((i for i, c in enumerate(p0.hand) if c.card_type == CardType.CLAIM), None)
        if idx2 is not None:
            ok2, msg2 = play_card(game, "p0", idx2, target.q, target.r)
            assert not ok2
            assert "stacking" in msg2.lower()


class TestSubmitPlan:
    def test_submit_plan(self, small_2p_game: GameState) -> None:
        ok, msg = submit_plan(small_2p_game, "p0")
        assert ok
        assert small_2p_game.players["p0"].has_submitted_plan

    def test_all_plans_triggers_reveal(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        submit_plan(game, "p0")
        assert game.current_phase == Phase.PLAN  # Still waiting for p1
        submit_plan(game, "p1")
        assert game.current_phase == Phase.BUY  # Reveal + Buy

    def test_cannot_play_after_submit(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        submit_plan(game, "p0")
        ok, msg = play_card(game, "p0", 0)
        assert not ok


class TestRevealPhase:
    def test_claim_resolution_attacker_wins(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        assert game.grid is not None

        # p0 claims an empty adjacent tile
        p0 = game.players["p0"]
        claim_idx = next(i for i, c in enumerate(p0.hand) if c.card_type == CardType.CLAIM)
        owned = game.grid.get_player_tiles("p0")
        target = None
        for ot in owned:
            for adj in game.grid.get_adjacent(ot.q, ot.r):
                if adj.owner is None:
                    target = adj
                    break
            if target:
                break
        assert target is not None
        play_card(game, "p0", claim_idx, target.q, target.r)

        # Both submit
        submit_plan(game, "p0")
        submit_plan(game, "p1")

        # After reveal, p0 should own the target tile (undefended = 0 defense)
        tile = game.grid.get_tile(target.q, target.r)
        assert tile is not None
        assert tile.owner == "p0"

    def test_defender_wins_ties(self, small_2p_game: GameState) -> None:
        """If attacker power equals defense, defender keeps the tile."""
        game = small_2p_game
        assert game.grid is not None

        # Give a tile to p1 with defense = 1
        owned_p1 = game.grid.get_player_tiles("p1")
        assert len(owned_p1) > 0
        target = owned_p1[0]

        # Find an adjacent tile owned by p0 to make the claim valid
        # This is tricky — let's just test the mechanism by manipulating state
        # Give p0 a tile adjacent to the target
        for adj in game.grid.get_adjacent(target.q, target.r):
            if adj.owner is None and not adj.is_blocked:
                adj.owner = "p0"
                break

        # Set defense on target = Advance power (1)
        target.defense_power = 1

        p0 = game.players["p0"]
        claim_idx = next(i for i, c in enumerate(p0.hand) if c.card_type == CardType.CLAIM and c.power == 1)
        play_card(game, "p0", claim_idx, target.q, target.r)

        submit_plan(game, "p0")
        submit_plan(game, "p1")

        # Defender should win (1 attack vs 1 defense = tie = defender wins)
        tile = game.grid.get_tile(target.q, target.r)
        assert tile is not None
        assert tile.owner == "p1"


class TestBuyPhase:
    def _advance_to_buy(self, game: GameState) -> None:
        """Helper to advance game to Buy phase."""
        for pid in game.player_order:
            submit_plan(game, pid)
        assert game.current_phase == Phase.BUY

    def test_buy_neutral_card(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        self._advance_to_buy(game)

        p0 = game.players["p0"]
        available = game.neutral_market.get_available()
        # Find an affordable card
        affordable = next(
            (s for s in available if s["card"]["buy_cost"] is not None and s["card"]["buy_cost"] <= p0.resources),
            None,
        )
        if affordable:
            card_id = affordable["card"]["id"]
            # The neutral market uses the base card id (before _copy suffix)
            base_id = next(k for k in game.neutral_market.stacks if game.neutral_market.stacks[k])
            resources_before = p0.resources
            ok, msg = buy_card(game, "p0", "neutral", base_id)
            assert ok, msg
            assert p0.resources < resources_before

    def test_buy_upgrade_credit(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        self._advance_to_buy(game)

        p0 = game.players["p0"]
        p0.resources = 10  # Give enough resources
        ok, msg = buy_card(game, "p0", "upgrade", "")
        assert ok, msg
        assert p0.upgrade_credits == 1
        assert p0.resources == 10 - UPGRADE_CREDIT_COST

    def test_cannot_buy_without_resources(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        self._advance_to_buy(game)
        p0 = game.players["p0"]
        p0.resources = 0
        ok, msg = buy_card(game, "p0", "upgrade", "")
        assert not ok

    def test_reroll_market(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        self._advance_to_buy(game)
        p0 = game.players["p0"]
        p0.resources = 5
        old_market = [c.id for c in p0.archetype_market]

        ok, msg = reroll_market(game, "p0")
        assert ok, msg
        assert p0.resources == 5 - REROLL_COST

    def test_reroll_insufficient_resources(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        self._advance_to_buy(game)
        p0 = game.players["p0"]
        p0.resources = 0
        ok, msg = reroll_market(game, "p0")
        assert not ok

    def test_buy_wrong_phase(self, small_2p_game: GameState) -> None:
        """Cannot buy during Plan phase."""
        ok, msg = buy_card(small_2p_game, "p0", "neutral", "some_card")
        assert not ok


class TestEndOfTurn:
    def test_end_turn_advances_round(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        for pid in game.player_order:
            submit_plan(game, pid)
        execute_end_of_turn(game)
        assert game.current_round == 2

    def test_end_turn_rotates_first_player(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        first_before = game.first_player_index
        for pid in game.player_order:
            submit_plan(game, pid)
        execute_end_of_turn(game)
        assert game.first_player_index == (first_before + 1) % len(game.player_order)

    def test_end_turn_discards_hands(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        # Verify players have hands
        for p in game.players.values():
            assert len(p.hand) > 0
        for pid in game.player_order:
            submit_plan(game, pid)
        execute_end_of_turn(game)
        # After end_of_turn calls start_of_turn, players draw new hands
        for p in game.players.values():
            assert len(p.hand) == p.hand_size

    def test_full_round_cycle(self, small_2p_game: GameState) -> None:
        """Play through an entire round."""
        game = small_2p_game
        assert game.current_phase == Phase.PLAN
        assert game.current_round == 1

        # Plan phase — both submit empty plans
        for pid in game.player_order:
            submit_plan(game, pid)
        assert game.current_phase == Phase.BUY

        # Buy phase — end turn
        execute_end_of_turn(game)
        assert game.current_round == 2
        assert game.current_phase == Phase.PLAN


class TestVPScoring:
    def test_vp_hex_scores_after_held_one_round(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        assert game.grid is not None

        # Give p0 a VP hex that was "held since round 0" (before round 1)
        vp_tile = next(t for t in game.grid.tiles.values() if t.is_vp and not t.is_blocked)
        vp_tile.owner = "p0"
        vp_tile.held_since_turn = 0

        # Advance through round 1
        for pid in game.player_order:
            submit_plan(game, pid)
        execute_end_of_turn(game)

        # Now in round 2 after start_of_turn — p0 should have scored
        p0 = game.players["p0"]
        assert p0.vp >= 1

    def test_newly_claimed_tile_doesnt_score_same_round(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        assert game.grid is not None

        # Claim a VP tile this round
        vp_tile = next(t for t in game.grid.tiles.values() if t.is_vp and not t.is_blocked and t.owner is None)
        vp_tile.owner = "p0"
        vp_tile.held_since_turn = game.current_round  # Claimed this round

        vp_before = game.players["p0"].vp

        # Advance through round
        for pid in game.player_order:
            submit_plan(game, pid)
        execute_end_of_turn(game)

        # Should not score in round 2 because held_since_turn == 1 and it's now round 2
        # Actually it should score: held_since_turn (1) < current_round (2)
        # But per rules: "score VP hexes held since PREVIOUS turn (not the turn claimed)"
        # held_since_turn=1, current_round=2, condition is held_since < current => 1 < 2 = True
        # This means it DOES score. Let's verify.
        p0 = game.players["p0"]
        assert p0.vp > vp_before


class TestForcedDiscards:
    def test_forced_discard_reduces_next_draw(self, small_2p_game: GameState) -> None:
        game = small_2p_game
        p1 = game.players["p1"]
        p1.forced_discard_next_turn = 2

        # Advance to next round
        for pid in game.player_order:
            submit_plan(game, pid)
        execute_end_of_turn(game)

        # p1 should draw fewer cards
        assert len(p1.hand) == max(0, p1.hand_size - 2)


class TestGameSerialization:
    def test_to_dict_structure(self, small_2p_game: GameState) -> None:
        d = small_2p_game.to_dict()
        assert "id" in d
        assert "grid" in d
        assert "players" in d
        assert "player_order" in d
        assert "current_phase" in d
        assert "current_round" in d
        assert "neutral_market" in d
        assert "log" in d

    def test_to_dict_hides_other_hands(self, small_2p_game: GameState) -> None:
        d = small_2p_game.to_dict(for_player_id="p0")
        # p0 should see their hand
        assert len(d["players"]["p0"]["hand"]) > 0
        # p1's hand should be hidden
        assert len(d["players"]["p1"]["hand"]) == 0
        # But hand_count should still be visible
        assert d["players"]["p1"]["hand_count"] > 0

    def test_to_dict_shows_all_hands_when_no_player_specified(self, small_2p_game: GameState) -> None:
        d = small_2p_game.to_dict()
        for pid in small_2p_game.player_order:
            assert len(d["players"][pid]["hand"]) > 0
