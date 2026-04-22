"""Behavioral tests for the 10 engine/buff cards added in the combo pass.

Each class targets one card and focuses on the unique effect-handler logic:
conditional draws, claim buffs, territory/hand counts, deck spawning, etc.
"""

from __future__ import annotations

import pytest

from app.game_engine.cards import Archetype, Card, CardType, Timing, _copy_card
from app.game_engine.effects import Effect, EffectType
from app.game_engine.game_state import (
    GameState,
    Phase,
    advance_resolve,
    create_game,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_play,
    undo_planned_action,
)
from app.game_engine.hex_grid import GridSize


# ── Helpers ───────────────────────────────────────────────────────


def _make_card(
    card_id: str = "test_card",
    name: str = "Test Card",
    card_type: CardType = CardType.ENGINE,
    archetype: Archetype = Archetype.SHARED,
    power: int = 0,
    timing: Timing = Timing.IMMEDIATE,
    effects: list[Effect] | None = None,
    **kwargs,
) -> Card:
    return Card(
        id=card_id,
        name=name,
        card_type=card_type,
        archetype=archetype,
        power=power,
        timing=timing,
        effects=effects or [],
        **kwargs,
    )


def _find_adjacent_neutral(game: GameState, player_id: str):
    assert game.grid is not None
    for tile in game.grid.get_player_tiles(player_id):
        for adj in game.grid.get_adjacent(tile.q, tile.r):
            if adj.owner is None and not adj.is_blocked:
                return adj.q, adj.r
    return None, None


# ── Vanguard: Commander ───────────────────────────────────────────


class TestCommander:
    """Conditional draw NEXT round if a Claim was played this round.
    Timing is on_resolution — queues extra_draws_next_turn on turn_modifiers."""

    def test_no_draw_without_claim(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        commander = _copy_card(card_registry["vanguard_commander"], "t_cmd")
        player.hand = [commander] + player.hand[1:]

        assert player.turn_modifiers.extra_draws_next_turn == 0
        ok, msg = play_card(game, "p0", 0)
        assert ok, msg

        # Force both players to submit so on_resolution fires
        submit_play(game, "p0")
        submit_play(game, "p1")
        # Commander evaluated its condition — no Claim played → no queued draws
        assert player.turn_modifiers.extra_draws_next_turn == 0

    def test_queues_draw_when_claim_played(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None

        commander = _copy_card(card_registry["vanguard_commander"], "t_cmd2")
        # Any starter Claim will do (Explore). Need to find an Explore in the starter hand.
        explore_idx = next(i for i, c in enumerate(player.hand) if c.card_type == CardType.CLAIM)
        explore = player.hand[explore_idx]
        player.hand = [commander, explore] + [c for i, c in enumerate(player.hand) if i != explore_idx]

        ok, _ = play_card(game, "p0", 0)  # Commander
        assert ok
        ok, _ = play_card(game, "p0", 0, target_q=q, target_r=r)  # Explore (now at idx 0)
        assert ok

        submit_play(game, "p0")
        submit_play(game, "p1")
        assert player.turn_modifiers.extra_draws_next_turn == 1

    def test_upgraded_draws_two(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None

        commander = _copy_card(card_registry["vanguard_commander"], "t_cmd3")
        commander.is_upgraded = True
        explore_idx = next(i for i, c in enumerate(player.hand) if c.card_type == CardType.CLAIM)
        explore = player.hand[explore_idx]
        player.hand = [commander, explore] + [c for i, c in enumerate(player.hand) if i != explore_idx]

        play_card(game, "p0", 0)
        play_card(game, "p0", 0, target_q=q, target_r=r)
        submit_play(game, "p0")
        submit_play(game, "p1")
        assert player.turn_modifiers.extra_draws_next_turn == 2


# ── Vanguard: Pursuit ─────────────────────────────────────────────


class TestPursuit:
    """Resources per tile captured from opponent last round.
    Timing is immediate — snapshot_resource_gain applies at play time."""

    def test_no_captures_no_resources(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        player.tiles_captured_from_opponents_last_round = 0
        pursuit = _copy_card(card_registry["vanguard_pursuit"], "t_pur0")
        player.hand = [pursuit] + player.hand[1:]

        initial_res = player.resources
        ok, _ = play_card(game, "p0", 0)
        assert ok
        assert player.resources == initial_res

    def test_base_scaling(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        player.tiles_captured_from_opponents_last_round = 10
        pursuit = _copy_card(card_registry["vanguard_pursuit"], "t_pur1")
        player.hand = [pursuit] + player.hand[1:]

        initial_res = player.resources
        ok, _ = play_card(game, "p0", 0)
        assert ok
        # Base: 1 per tile × 10 = 10 (no cap)
        assert player.resources == initial_res + 10

    def test_upgraded_scaling_and_draw(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        player.tiles_captured_from_opponents_last_round = 2
        pursuit = _copy_card(card_registry["vanguard_pursuit"], "t_pur2")
        pursuit.is_upgraded = True
        player.hand = [pursuit] + player.hand[1:]

        initial_res = player.resources
        initial_hand = len(player.hand)
        ok, _ = play_card(game, "p0", 0)
        assert ok
        # Upgraded: 2 per tile × 2 = 4
        assert player.resources == initial_res + 4
        # +1 draw: hand = initial - 1 (played) + 1 (draw) = initial
        assert len(player.hand) == initial_hand


# ── Vanguard: War Banner ──────────────────────────────────────────


class TestWarBanner:
    """Queues +power buffs onto turn_modifiers.claim_buffs for next Claim(s)."""

    def test_base_queues_one_buff(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        banner = _copy_card(card_registry["vanguard_war_banner"], "t_wb1")
        player.hand = [banner] + player.hand[1:]

        assert player.turn_modifiers.claim_buffs == []
        ok, _ = play_card(game, "p0", 0)
        assert ok

        assert len(player.turn_modifiers.claim_buffs) == 1
        buff = player.turn_modifiers.claim_buffs[0]
        assert buff["power_bonus"] == 2
        assert buff["draw_on_success"] == 1
        assert buff["source_card_id"] == banner.id

    def test_upgraded_queues_two_buffs(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        banner = _copy_card(card_registry["vanguard_war_banner"], "t_wb2")
        banner.is_upgraded = True
        player.hand = [banner] + player.hand[1:]

        ok, _ = play_card(game, "p0", 0)
        assert ok

        assert len(player.turn_modifiers.claim_buffs) == 2
        for b in player.turn_modifiers.claim_buffs:
            assert b["power_bonus"] == 2
            assert b["draw_on_success"] == 1

    def test_two_banners_stack_on_single_claim(self, small_2p_game, card_registry):
        """Two War Banners queued → next Claim consumes both (one charge each)."""
        game = small_2p_game
        player = game.players["p0"]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None

        b1 = _copy_card(card_registry["vanguard_war_banner"], "t_wb_s1")
        b2 = _copy_card(card_registry["vanguard_war_banner"], "t_wb_s2")
        explore_idx = next(i for i, c in enumerate(player.hand) if c.card_type == CardType.CLAIM)
        explore = player.hand[explore_idx]
        player.hand = [b1, b2, explore] + [c for i, c in enumerate(player.hand) if i != explore_idx]

        # Give enough actions to play 3 cards
        player.actions_available = 5

        play_card(game, "p0", 0)  # War Banner #1 → queues 1 buff
        play_card(game, "p0", 0)  # War Banner #2 → queues 1 more buff
        assert len(player.turn_modifiers.claim_buffs) == 2

        ok, _ = play_card(game, "p0", 0, target_q=q, target_r=r)  # Explore (Claim)
        assert ok

        # Both banners' buffs consumed on this one Claim.
        assert player.turn_modifiers.claim_buffs == []
        # The queued claim action should carry an aggregated buff of +4 power and 2 draws.
        claim_action = next(a for a in player.planned_actions if a.card.card_type == CardType.CLAIM)
        assert claim_action.consumed_claim_buff is not None
        assert claim_action.consumed_claim_buff["power_bonus"] == 4
        assert claim_action.consumed_claim_buff["draw_on_success"] == 2
        assert len(claim_action.consumed_claim_buff["source_card_ids"]) == 2

    def test_upgraded_banner_charges_split_across_two_claims(self, small_2p_game, card_registry):
        """War Banner+ (2 charges) → first Claim consumes 1, second Claim consumes the other."""
        game = small_2p_game
        player = game.players["p0"]

        # Need two adjacent neutral tiles for two Claims.
        assert game.grid is not None
        neutrals: list[tuple[int, int]] = []
        for tile in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(tile.q, tile.r):
                if adj.owner is None and not adj.is_blocked and (adj.q, adj.r) not in neutrals:
                    neutrals.append((adj.q, adj.r))
                    if len(neutrals) >= 2:
                        break
            if len(neutrals) >= 2:
                break
        assert len(neutrals) >= 2

        banner = _copy_card(card_registry["vanguard_war_banner"], "t_wbup")
        banner.is_upgraded = True
        claims = [i for i, c in enumerate(player.hand) if c.card_type == CardType.CLAIM]
        assert len(claims) >= 2
        c1 = player.hand[claims[0]]
        c2 = player.hand[claims[1]]
        rest = [c for i, c in enumerate(player.hand) if i not in (claims[0], claims[1])]
        player.hand = [banner, c1, c2] + rest

        player.actions_available = 5

        play_card(game, "p0", 0)  # Banner+ → queues 2 buffs
        assert len(player.turn_modifiers.claim_buffs) == 2

        q1, r1 = neutrals[0]
        q2, r2 = neutrals[1]
        play_card(game, "p0", 0, target_q=q1, target_r=r1)  # Claim 1 consumes 1 buff
        assert len(player.turn_modifiers.claim_buffs) == 1
        play_card(game, "p0", 0, target_q=q2, target_r=r2)  # Claim 2 consumes the other
        assert player.turn_modifiers.claim_buffs == []

        claim_actions = [a for a in player.planned_actions if a.card.card_type == CardType.CLAIM]
        assert len(claim_actions) == 2
        for ca in claim_actions:
            assert ca.consumed_claim_buff is not None
            assert ca.consumed_claim_buff["power_bonus"] == 2
            assert ca.consumed_claim_buff["draw_on_success"] == 1

    def test_undoing_claim_restores_consumed_buffs(self, small_2p_game, card_registry):
        """Undoing a Claim that consumed War Banner buffs returns every buff to the queue."""
        game = small_2p_game
        player = game.players["p0"]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None

        b1 = _copy_card(card_registry["vanguard_war_banner"], "t_wb_u1")
        b2 = _copy_card(card_registry["vanguard_war_banner"], "t_wb_u2")
        explore_idx = next(i for i, c in enumerate(player.hand) if c.card_type == CardType.CLAIM)
        explore = player.hand[explore_idx]
        player.hand = [b1, b2, explore] + [c for i, c in enumerate(player.hand) if i != explore_idx]
        player.actions_available = 5

        play_card(game, "p0", 0)  # War Banner #1
        play_card(game, "p0", 0)  # War Banner #2
        play_card(game, "p0", 0, target_q=q, target_r=r)  # Claim — consumes both buffs
        assert player.turn_modifiers.claim_buffs == []

        claim_idx = next(
            i for i, a in enumerate(player.planned_actions) if a.card.card_type == CardType.CLAIM
        )
        ok, _ = undo_planned_action(game, "p0", claim_idx)
        assert ok

        # Both buffs restored as independent entries, not merged.
        assert len(player.turn_modifiers.claim_buffs) == 2
        for b in player.turn_modifiers.claim_buffs:
            assert b["power_bonus"] == 2
            assert b["draw_on_success"] == 1
        sources = {b.get("source_card_id") for b in player.turn_modifiers.claim_buffs}
        assert sources == {b1.id, b2.id}


# ── Swarm: Chatter ────────────────────────────────────────────────


class TestChatter:
    """Draws base 1 always; bonus draw if ≥3 cards played (counting itself)."""

    def test_first_play_no_bonus(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p1"]
        chatter = _copy_card(card_registry["swarm_chatter"], "t_chat1")
        player.hand = [chatter] + player.hand[1:]

        initial_hand = len(player.hand)
        ok, _ = play_card(game, "p1", 0)
        assert ok
        # Only base draw (1 card drawn, 1 card played, net +0). No bonus.
        assert len(player.hand) == initial_hand

    def test_third_play_triggers_bonus(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p1"]
        chatter = _copy_card(card_registry["swarm_chatter"], "t_chat2")
        # Fill with throwaway engine cards so hand has plenty of non-Claim cards to play
        filler1 = _make_card("fil1", "Filler1", action_return=1)
        filler2 = _make_card("fil2", "Filler2", action_return=1)
        # Ensure the deck has at least 2 extra cards available to draw
        player.hand = [filler1, filler2, chatter] + player.hand[3:]

        play_card(game, "p1", 0)  # filler1 (1st)
        play_card(game, "p1", 0)  # filler2 (2nd) — chatter moves to idx 0
        hand_before = len(player.hand)
        ok, _ = play_card(game, "p1", 0)  # chatter (3rd) — should draw 1 + 1 bonus
        assert ok
        # played 1 card, drew 2 cards (1 base + 1 bonus) = net +1
        assert len(player.hand) == hand_before - 1 + 2

    def test_upgraded_bonus_is_two(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p1"]
        chatter = _copy_card(card_registry["swarm_chatter"], "t_chat3")
        chatter.is_upgraded = True
        filler1 = _make_card("fil1u", "Filler1", action_return=1)
        filler2 = _make_card("fil2u", "Filler2", action_return=1)
        player.hand = [filler1, filler2, chatter] + player.hand[3:]

        play_card(game, "p1", 0)
        play_card(game, "p1", 0)
        hand_before = len(player.hand)
        ok, _ = play_card(game, "p1", 0)
        assert ok
        # played 1, drew 1 base + 2 bonus = net +2
        assert len(player.hand) == hand_before - 1 + 3


# ── Swarm: Drone Wave ─────────────────────────────────────────────


class TestDroneWave:
    """Draws floor(tiles_owned / divisor), capped. Base: /3 max 3. Upgraded: /2 max 4."""

    def test_draws_from_tile_count(self, small_2p_game, card_registry):
        game = small_2p_game
        assert game.grid is not None
        player = game.players["p1"]
        # Give player a controlled number of tiles (owner them directly)
        # Start with however many the game grants, then add more via direct assignment
        existing = len(game.grid.get_player_tiles("p1"))
        # Aim for exactly 6 tiles (so divisor 3 → 2 draws)
        target_count = 6
        if existing < target_count:
            needed = target_count - existing
            added = 0
            for t in game.grid.tiles.values():
                if t.owner is None and not t.is_blocked:
                    t.owner = "p1"
                    added += 1
                    if added >= needed:
                        break

        wave = _copy_card(card_registry["swarm_drone_wave"], "t_dw1")
        player.hand = [wave] + player.hand[1:]

        initial_hand = len(player.hand)
        tile_count = len(game.grid.get_player_tiles("p1"))
        ok, _ = play_card(game, "p1", 0)
        assert ok

        expected_draws = min(tile_count // 3, 3)
        # Hand: initial - 1 (played) + expected_draws
        assert len(player.hand) == initial_hand - 1 + expected_draws

    def test_cap_applies(self, small_2p_game, card_registry):
        game = small_2p_game
        assert game.grid is not None
        player = game.players["p1"]
        # Give player MANY tiles so the cap kicks in
        for t in game.grid.tiles.values():
            if t.owner is None and not t.is_blocked:
                t.owner = "p1"

        wave = _copy_card(card_registry["swarm_drone_wave"], "t_dw2")
        player.hand = [wave] + player.hand[1:]

        initial_hand = len(player.hand)
        ok, _ = play_card(game, "p1", 0)
        assert ok
        # Capped at 3 draws regardless of tile count
        assert len(player.hand) == initial_hand - 1 + 3

    def test_upgraded_divisor_and_cap(self, small_2p_game, card_registry):
        game = small_2p_game
        assert game.grid is not None
        player = game.players["p1"]
        for t in game.grid.tiles.values():
            if t.owner is None and not t.is_blocked:
                t.owner = "p1"

        wave = _copy_card(card_registry["swarm_drone_wave"], "t_dw3")
        wave.is_upgraded = True
        player.hand = [wave] + player.hand[1:]

        initial_hand = len(player.hand)
        ok, _ = play_card(game, "p1", 0)
        assert ok
        # Upgraded cap = 4
        assert len(player.hand) == initial_hand - 1 + 4


# ── Swarm: Hatching Grounds ───────────────────────────────────────


class TestHatchingGrounds:
    """Adds N Rabble cards to discard pile. trash_on_use."""

    def _count_rabble_in_discard(self, player):
        return sum(1 for c in player.deck.discard if c.id == "swarm_rabble")

    def test_base_adds_three_rabble(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p1"]
        hg = _copy_card(card_registry["swarm_hatching_grounds"], "t_hg1")
        player.hand = [hg] + player.hand[1:]

        before = self._count_rabble_in_discard(player)
        ok, _ = play_card(game, "p1", 0)
        assert ok
        after = self._count_rabble_in_discard(player)
        assert after - before == 3

    def test_upgraded_adds_five_rabble(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p1"]
        hg = _copy_card(card_registry["swarm_hatching_grounds"], "t_hg2")
        hg.is_upgraded = True
        player.hand = [hg] + player.hand[1:]

        before = self._count_rabble_in_discard(player)
        ok, _ = play_card(game, "p1", 0)
        assert ok
        after = self._count_rabble_in_discard(player)
        assert after - before == 5

    def test_rabble_cards_are_independent_copies(self, small_2p_game, card_registry):
        """Each added Rabble must be its own Card instance (deepcopy)."""
        game = small_2p_game
        player = game.players["p1"]
        hg = _copy_card(card_registry["swarm_hatching_grounds"], "t_hg3")
        player.hand = [hg] + player.hand[1:]

        ok, _ = play_card(game, "p1", 0)
        assert ok
        rabble_instances = [c for c in player.deck.discard if c.id == "swarm_rabble"]
        assert len(rabble_instances) >= 3
        # Mutating one must not affect the others
        rabble_instances[0].passive_vp = 99
        for c in rabble_instances[1:]:
            assert c.passive_vp != 99


# ── Fortress: Quartermaster ───────────────────────────────────────


class TestQuartermaster:
    """Resources per Defense card in hand (capped). Snapshot at play time."""

    def test_no_defense_no_resources(self, small_2p_game, card_registry):
        game = small_2p_game
        # Fortress player needed for authentic context
        game_f = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "p1", "name": "Other", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game_f)
        execute_upkeep(game_f)
        player = game_f.players["f0"]

        qm = _copy_card(card_registry["fortress_quartermaster"], "t_qm0")
        # Strip all defense cards from hand
        player.hand = [qm] + [c for c in player.hand if c.card_type != CardType.DEFENSE]

        initial_res = player.resources
        ok, _ = play_card(game_f, "f0", 0)
        assert ok
        assert player.resources == initial_res

    def test_counts_defense_cards_with_cap(self, small_2p_game, card_registry):
        game_f = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "p1", "name": "Other", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game_f)
        execute_upkeep(game_f)
        player = game_f.players["f0"]

        qm = _copy_card(card_registry["fortress_quartermaster"], "t_qm1")
        # Create 5 defense cards in hand (exceeds base cap of 3)
        def_cards = [
            _make_card(f"d{i}", f"Def{i}", card_type=CardType.DEFENSE) for i in range(5)
        ]
        player.hand = [qm] + def_cards

        initial_res = player.resources
        ok, _ = play_card(game_f, "f0", 0)
        assert ok
        # Base: 2 per defense × min(5, 3) = 6
        assert player.resources == initial_res + 6

    def test_upgraded_scaling_and_draw(self, small_2p_game, card_registry):
        game_f = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "p1", "name": "Other", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game_f)
        execute_upkeep(game_f)
        player = game_f.players["f0"]

        qm = _copy_card(card_registry["fortress_quartermaster"], "t_qm2")
        qm.is_upgraded = True
        def_cards = [
            _make_card(f"du{i}", f"Def{i}", card_type=CardType.DEFENSE) for i in range(4)
        ]
        player.hand = [qm] + def_cards

        initial_res = player.resources
        initial_hand = len(player.hand)
        ok, _ = play_card(game_f, "f0", 0)
        assert ok
        # Upgraded: 3 per defense × min(4, 6) = 12
        assert player.resources == initial_res + 12
        # +1 draw from upgraded_draw; hand net: initial - 1 (played qm) + 1 (draw) = initial
        assert len(player.hand) == initial_hand


# ── Fortress: Watchful Keep ───────────────────────────────────────


class TestWatchfulKeep:
    """Draws per owned tile with any defense bonus (capped). On-resolution: queues next-turn draws."""

    def _setup_fortress_game(self, card_registry):
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "p1", "name": "Other", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)
        return game

    def test_no_defense_tiles_no_draws(self, card_registry):
        game = self._setup_fortress_game(card_registry)
        player = game.players["f0"]
        # Clear any defense bonuses from owned tiles
        assert game.grid is not None
        for t in game.grid.get_player_tiles("f0"):
            t.permanent_defense_bonus = 0
            t.defense_power = 0

        wk = _copy_card(card_registry["fortress_watchful_keep"], "t_wk0")
        player.hand = [wk] + player.hand[1:]

        initial_hand = len(player.hand)
        ok, _ = play_card(game, "f0", 0)
        assert ok
        # No defense tiles → no immediate draw. Played 1 card → hand shrinks by 1.
        assert len(player.hand) == initial_hand - 1

    def test_draws_per_defense_tile_with_cap(self, card_registry):
        game = self._setup_fortress_game(card_registry)
        player = game.players["f0"]
        assert game.grid is not None
        # Clear first, then set 5 tiles with defense
        for t in game.grid.get_player_tiles("f0"):
            t.permanent_defense_bonus = 0
            t.defense_power = 0
        count = 0
        for t in game.grid.get_player_tiles("f0"):
            t.permanent_defense_bonus = 1
            count += 1
            if count >= 5:
                break
        # If we don't own 5 tiles, grab some neutrals
        for t in game.grid.tiles.values():
            if count >= 5:
                break
            if t.owner is None and not t.is_blocked:
                t.owner = "f0"
                t.permanent_defense_bonus = 1
                count += 1

        wk = _copy_card(card_registry["fortress_watchful_keep"], "t_wk1")
        player.hand = [wk] + player.hand[1:]
        initial_hand = len(player.hand)
        ok, _ = play_card(game, "f0", 0)
        assert ok
        # Base cap = 3 draws, despite owning 5 defense tiles
        assert len(player.hand) == initial_hand - 1 + 3

    def test_on_resolution_queues_next_turn_draw(self, card_registry):
        game = self._setup_fortress_game(card_registry)
        player = game.players["f0"]
        assert player.turn_modifiers.extra_draws_next_turn == 0

        wk = _copy_card(card_registry["fortress_watchful_keep"], "t_wk2")
        player.hand = [wk] + player.hand[1:]
        ok, _ = play_card(game, "f0", 0)
        assert ok

        submit_play(game, "f0")
        submit_play(game, "p1")
        # Base: +1 draw next round
        assert player.turn_modifiers.extra_draws_next_turn == 1

    def test_upgraded_next_round_draw(self, card_registry):
        game = self._setup_fortress_game(card_registry)
        player = game.players["f0"]

        wk = _copy_card(card_registry["fortress_watchful_keep"], "t_wk3")
        wk.is_upgraded = True
        player.hand = [wk] + player.hand[1:]
        play_card(game, "f0", 0)
        submit_play(game, "f0")
        submit_play(game, "p1")
        assert player.turn_modifiers.extra_draws_next_turn == 2


# ── Fortress: Master Engineer ─────────────────────────────────────


class TestMasterEngineer:
    """Adds N Entrench cards to discard pile."""

    def _count_entrench(self, player):
        return sum(1 for c in player.deck.discard if c.id == "fortress_entrench")

    def _setup(self, card_registry):
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "p1", "name": "Other", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)
        return game

    def test_base_adds_three_entrench(self, card_registry):
        game = self._setup(card_registry)
        player = game.players["f0"]
        me = _copy_card(card_registry["fortress_master_engineer"], "t_me1")
        player.hand = [me] + player.hand[1:]

        before = self._count_entrench(player)
        ok, _ = play_card(game, "f0", 0)
        assert ok
        assert self._count_entrench(player) - before == 3

    def test_upgraded_adds_five_entrench(self, card_registry):
        game = self._setup(card_registry)
        player = game.players["f0"]
        me = _copy_card(card_registry["fortress_master_engineer"], "t_me2")
        me.is_upgraded = True
        player.hand = [me] + player.hand[1:]

        before = self._count_entrench(player)
        ok, _ = play_card(game, "f0", 0)
        assert ok
        assert self._count_entrench(player) - before == 5


# ── Neutral: Caravan ──────────────────────────────────────────────


class TestCaravan:
    """Discard-then-draw ordering for Caravan+."""

    def test_base_discards_one(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        caravan = _copy_card(card_registry["neutral_caravan"], "t_car1")
        player.hand = [caravan] + player.hand[1:]

        initial_hand = len(player.hand)
        ok, msg = play_card(game, "p0", 0, discard_card_indices=[0])
        assert ok, msg
        # Played 1, discarded 1 (no draw at base) → -2
        assert len(player.hand) == initial_hand - 2

    def test_upgraded_discards_before_drawing(self, small_2p_game, card_registry):
        """Caravan+: discard must resolve before the draw, so the discarded card
        can't be one the player just drew."""
        game = small_2p_game
        player = game.players["p0"]
        caravan = _copy_card(card_registry["neutral_caravan"], "t_car2")
        caravan.is_upgraded = True

        # Tag the only card that will be available to discard at play time.
        marker = _make_card("marker_card", "MARKER")
        player.hand = [caravan, marker] + player.hand[2:]

        ok, msg = play_card(game, "p0", 0, discard_card_indices=[0])
        assert ok, msg
        # Marker should be in the discard pile — player saw it before drawing
        assert any(c.id == "marker_card" for c in player.deck.discard), (
            "discard_first should send the marker to discard even if a newly-drawn card exists"
        )

    def test_upgraded_net_hand_size(self, small_2p_game, card_registry):
        game = small_2p_game
        player = game.players["p0"]
        caravan = _copy_card(card_registry["neutral_caravan"], "t_car3")
        caravan.is_upgraded = True
        player.hand = [caravan] + player.hand[1:]

        initial_hand = len(player.hand)
        ok, _ = play_card(game, "p0", 0, discard_card_indices=[0])
        assert ok
        # Played 1, discarded 1, drew 1 → -1
        assert len(player.hand) == initial_hand - 1
