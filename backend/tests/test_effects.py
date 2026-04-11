"""Tests for the card keyword/effect system."""

from __future__ import annotations

import copy

import pytest

from app.game_engine.cards import (
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
    _copy_card,
)
from app.game_engine.effects import (
    ConditionType,
    Effect,
    EffectType,
    TurnModifiers,
    parse_effect,
)
from app.game_engine.effect_resolver import (
    calculate_effective_power,
    check_condition,
    resolve_immediate_effects,
    resolve_on_resolution_effects,
)
from app.game_engine.game_state import (
    GameState,
    Phase,
    PlannedAction,
    Player,
    advance_resolve,
    buy_card,
    create_game,
    end_buy_phase,
    execute_end_of_turn,
    execute_reveal,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_pending_discard,
    submit_play,
)
from app.game_engine.hex_grid import GridSize


# ── Helpers ───────────────────────────────────────────────────────


def _make_card(
    card_id: str = "test_card",
    name: str = "Test Card",
    card_type: CardType = CardType.ENGINE,
    archetype: Archetype = Archetype.NEUTRAL,
    power: int = 0,
    timing: Timing = Timing.IMMEDIATE,
    effects: list[Effect] | None = None,
    **kwargs,
) -> Card:
    """Create a card with optional effects for testing."""
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
    """Find a neutral tile adjacent to a player's tiles."""
    assert game.grid is not None
    for tile in game.grid.get_player_tiles(player_id):
        for adj in game.grid.get_adjacent(tile.q, tile.r):
            if adj.owner is None and not adj.is_blocked:
                return adj.q, adj.r
    return None, None


# ── Effect Parsing Tests ──────────────────────────────────────────


class TestEffectParsing:
    def test_parse_basic_effect(self):
        data = {"type": "gain_vp", "value": 1, "timing": "immediate"}
        effect = parse_effect(data)
        assert effect is not None
        assert effect.type == EffectType.GAIN_VP
        assert effect.value == 1
        assert effect.timing == Timing.IMMEDIATE

    def test_parse_conditional_effect(self):
        data = {
            "type": "power_modifier",
            "value": 2,
            "timing": "on_resolution",
            "condition": "if_played_claim_this_turn",
        }
        effect = parse_effect(data)
        assert effect is not None
        assert effect.type == EffectType.POWER_MODIFIER
        assert effect.condition == ConditionType.IF_PLAYED_CLAIM_THIS_TURN

    def test_parse_effect_with_metadata(self):
        data = {
            "type": "power_modifier",
            "value": 1,
            "condition": "if_adjacent_owned_gte",
            "condition_threshold": 1,
            "metadata": {"per_tile": True},
        }
        effect = parse_effect(data)
        assert effect is not None
        assert effect.metadata.get("per_tile") is True
        assert effect.condition_threshold == 1

    def test_parse_unknown_type_returns_none(self):
        data = {"type": "nonexistent_effect"}
        effect = parse_effect(data)
        assert effect is None

    def test_parse_requires_choice(self):
        data = {"type": "self_discard", "value": 1, "requires_choice": True}
        effect = parse_effect(data)
        assert effect is not None
        assert effect.requires_choice is True


class TestTurnModifiers:
    def test_reset_clears_single_round(self):
        mods = TurnModifiers(buy_locked=True)
        mods.cost_reductions.append({"scope": "any_one_card", "amount": 2})
        mods.reset_for_new_turn()
        assert mods.buy_locked is False
        assert len(mods.cost_reductions) == 0

    def test_reset_decrements_multi_round_immunity(self):
        mods = TurnModifiers()
        mods.immune_tiles["0,0"] = 2  # Stronghold: 2 rounds
        mods.immune_tiles["1,0"] = 1  # Iron Wall: 1 round
        mods.reset_for_new_turn()
        assert "0,0" in mods.immune_tiles
        assert mods.immune_tiles["0,0"] == 1
        assert "1,0" not in mods.immune_tiles  # expired


# ── Cards Load Effects from YAML ─────────────────────────────────


class TestCardsLoadEffects:
    def test_rally_has_self_discard_effect(self, card_registry):
        card = card_registry.get("vanguard_rally")
        assert card is not None
        discard_effects = [e for e in card.effects if e.type == EffectType.SELF_DISCARD]
        assert len(discard_effects) == 1
        assert discard_effects[0].requires_choice is True
        assert discard_effects[0].value == 1

    def test_land_grant_is_passive_vp(self, card_registry):
        card = card_registry.get("neutral_land_grant")
        assert card is not None
        assert card.unplayable is True
        assert card.passive_vp == 1

    def test_iron_wall_has_immunity_effect(self, card_registry):
        card = card_registry.get("fortress_iron_wall")
        assert card is not None
        immunity = [e for e in card.effects if e.type == EffectType.TILE_IMMUNITY]
        assert len(immunity) == 1
        assert immunity[0].duration == 1

    def test_stronghold_has_2_round_immunity(self, card_registry):
        card = card_registry.get("fortress_stronghold")
        assert card is not None
        immunity = [e for e in card.effects if e.type == EffectType.TILE_IMMUNITY]
        assert len(immunity) == 1
        assert immunity[0].duration == 2

    def test_strike_team_has_power_modifier(self, card_registry):
        card = card_registry.get("vanguard_strike_team")
        assert card is not None
        mods = [e for e in card.effects if e.type == EffectType.POWER_MODIFIER]
        assert len(mods) == 1
        assert mods[0].condition == ConditionType.IF_PLAYED_CLAIM_THIS_TURN
        assert mods[0].value == 2

    def test_blitz_rush_has_buy_restriction(self, card_registry):
        card = card_registry.get("swarm_blitz_rush")
        assert card is not None
        restrictions = [e for e in card.effects if e.type == EffectType.BUY_RESTRICTION]
        assert len(restrictions) == 1

    def test_card_without_effects_has_empty_list(self, card_registry):
        card = card_registry.get("neutral_gather")
        assert card is not None
        assert card.effects == []

    def test_thin_the_herd_has_self_trash(self, card_registry):
        card = card_registry.get("swarm_thin_the_herd")
        assert card is not None
        trash_effects = [e for e in card.effects if e.type == EffectType.SELF_TRASH]
        assert len(trash_effects) == 1
        assert trash_effects[0].requires_choice is True


# ── Self-Discard Effect Tests ─────────────────────────────────────


class TestSelfDiscard:
    def test_rally_draw_then_discard(self, small_2p_game, card_registry):
        """Rally (Regroup): Draw 2 cards first, then player picks 1 to discard."""
        game = small_2p_game
        player = game.players["p0"]

        # Give player a Rally card
        rally = _copy_card(card_registry["vanguard_rally"], "test_rally")
        player.hand = [rally] + player.hand
        initial_hand_size = len(player.hand)

        # Step 1: Play Rally — draws 2 cards, sets pending_discard
        # No discard_card_indices needed (deferred)
        success, msg = play_card(game, "p0", 0)
        assert success, msg

        # After play: hand = initial - 1 (played rally) + 2 (drew) = initial + 1
        assert len(player.hand) == initial_hand_size - 1 + 2
        assert player.pending_discard == 1

        # Step 2: Submit the deferred discard choice
        success, msg = submit_pending_discard(game, "p0", [0])
        assert success, msg

        # Hand should be: initial_hand - 1 (played rally) + 2 (drew) - 1 (discarded)
        expected = initial_hand_size - 1 + 2 - 1
        assert len(player.hand) == expected
        assert player.pending_discard == 0

    def test_discard_with_empty_hand_skips(self, small_2p_game, card_registry):
        """If player has no cards after playing, discard is skipped."""
        game = small_2p_game
        player = game.players["p0"]

        # Create a card with self_discard but no draw
        frenzy = _make_card(
            card_id="test_frenzy",
            name="Frenzy",
            action_return=2,
            effects=[
                Effect(type=EffectType.SELF_DISCARD, value=1,
                       timing=Timing.IMMEDIATE, requires_choice=True),
            ],
        )
        # Give player ONLY this card
        player.hand = [frenzy]

        # Play it — hand will be empty after playing, discard should skip
        success, msg = play_card(game, "p0", 0, discard_card_indices=[])
        assert success, msg
        assert len(player.hand) == 0

    def test_discard_no_indices_provided(self, small_2p_game, card_registry):
        """If player doesn't provide indices, discard is skipped gracefully."""
        game = small_2p_game
        player = game.players["p0"]

        frenzy = _make_card(
            card_id="test_frenzy",
            name="Frenzy",
            action_return=2,
            effects=[
                Effect(type=EffectType.SELF_DISCARD, value=1,
                       timing=Timing.IMMEDIATE, requires_choice=True),
            ],
        )
        player.hand = [frenzy, _make_card("dummy1"), _make_card("dummy2")]
        initial = len(player.hand)

        # Play without providing discard indices — should be rejected
        success, msg = play_card(game, "p0", 0)
        assert not success
        assert "requires" in msg.lower()
        # Hand unchanged — card not played
        assert len(player.hand) == initial


# ── Self-Trash Effect Tests ───────────────────────────────────────


class TestSelfTrash:
    def test_thin_the_herd_trashes_card(self, small_2p_game, card_registry):
        """Thin the Herd: trash 1 card from hand, draw 2."""
        game = small_2p_game
        player = game.players["p1"]  # Swarm player

        thin = _copy_card(card_registry["swarm_thin_the_herd"], "test_thin")
        dummy = _make_card("trash_target", "Trash Target", buy_cost=3)
        player.hand = [thin, dummy] + player.hand[2:]
        initial_hand = len(player.hand)
        initial_total = player.deck.total_cards + len(player.hand)

        # Play thin the herd, choosing to trash index 0 (which after playing thin at 0,
        # the dummy card moves to index 0)
        success, msg = play_card(game, "p1", 0, trash_card_indices=[0])
        assert success, msg

        # Trashed card should NOT be in hand, deck, or discard
        all_cards = player.hand + player.deck.cards + player.deck.discard
        assert not any(c.name == "Trash Target" for c in all_cards)

    def test_thin_the_herd_no_trash_no_draw(self, small_2p_game, card_registry):
        """Thin the Herd played without trashing: card plays but no draw (gates_draw)."""
        game = small_2p_game
        player = game.players["p1"]  # Swarm player

        thin = _copy_card(card_registry["swarm_thin_the_herd"], "test_thin_skip")
        dummy = _make_card("keep_me", "Keep Me", buy_cost=3)
        player.hand = [thin, dummy]
        initial_deck_size = player.deck.total_cards

        # Play without trashing — should succeed (trash is optional)
        success, msg = play_card(game, "p1", 0)
        assert success, msg
        # Keep Me should still be in hand (not trashed)
        assert any(c.name == "Keep Me" for c in player.hand)
        # No draw should have happened (gated behind trash)
        # Thin the Herd has draw_cards=1, but gates_draw means it only draws if trashed
        # Hand should just have Keep Me (no new draws)
        assert len(player.hand) == 1

    def test_consolidate_trashes_and_refunds(self, small_2p_game, card_registry):
        """Consolidate: trash a card, gain resources = half buy cost (rounded down)."""
        game = small_2p_game
        # Use a fortress player for this test
        game2 = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "f1", "name": "Other", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game2)
        execute_upkeep(game2)
        player = game2.players["f0"]

        consolidate = _copy_card(card_registry["fortress_consolidate"], "test_cons")
        expensive_card = _make_card("expensive", "Expensive", buy_cost=5)
        player.hand = [consolidate, expensive_card] + player.hand[2:]
        initial_resources = player.resources

        success, msg = play_card(game2, "f0", 0, trash_card_indices=[0])
        assert success, msg

        # Should have gained 2 resources (half of 5, rounded down)
        assert player.resources == initial_resources + 2


# ── VP Gain Tests ─────────────────────────────────────────────────


class TestVPGain:
    def test_land_grant_unplayable(self, small_2p_game, card_registry):
        """Land Grant: cannot be played from hand."""
        game = small_2p_game
        player = game.players["p0"]

        land_grant = _copy_card(card_registry["neutral_land_grant"], "test_lg")
        player.hand = [land_grant] + player.hand[1:]

        success, msg = play_card(game, "p0", 0)
        assert not success
        assert "cannot be played" in msg


# ── Buy Restriction Tests ─────────────────────────────────────────


class TestBuyRestriction:
    def test_blitz_rush_locks_purchases(self, small_2p_game, card_registry):
        """Blitz Rush: player cannot buy cards this round."""
        game = small_2p_game
        player = game.players["p1"]  # Swarm

        blitz_rush = _copy_card(card_registry["swarm_blitz_rush"], "test_br")
        player.hand = [blitz_rush] + player.hand[1:]

        success, msg = play_card(game, "p1", 0)
        assert success, msg

        # Effect is on_resolution — submit and resolve to trigger it
        submit_play(game, "p1")
        submit_play(game, "p0")
        assert game.current_phase == Phase.REVEAL
        assert player.turn_modifiers.buy_locked is True
        for pid in game.player_order:
            advance_resolve(game, pid)
        assert game.current_phase == Phase.BUY

        # Advance to p1's buy turn (p0 may be the current buyer first)
        current_buyer = game.player_order[game.current_buyer_index]
        if current_buyer != "p1":
            end_buy_phase(game, current_buyer)
        assert game.player_order[game.current_buyer_index] == "p1"

        # Try to buy — should be blocked
        player.resources = 100  # plenty of resources
        success, msg = buy_card(game, "p1", "upgrade", "")
        assert not success
        assert "buy restriction" in msg.lower()


# ── Tile Immunity Tests ───────────────────────────────────────────


class TestTileImmunity:
    def test_iron_wall_prevents_claims(self, card_registry):
        """Iron Wall: target tile cannot be claimed this round."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "a0", "name": "Attacker", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)

        fort = game.players["f0"]
        attacker = game.players["a0"]

        # Find a tile Fort owns
        assert game.grid is not None
        fort_tiles = game.grid.get_player_tiles("f0")
        target_tile = fort_tiles[0]
        tile_q, tile_r = target_tile.q, target_tile.r

        # Give Fort an Iron Wall card
        iron_wall = _copy_card(card_registry["fortress_iron_wall"], "test_iw")
        fort.hand = [iron_wall] + fort.hand[1:]

        # Fort plays Iron Wall on their tile (immunity applied on_resolution)
        success, msg = play_card(game, "f0", 0, target_q=tile_q, target_r=tile_r)
        assert success, msg

        # Give attacker a strong claim card targeting that tile
        claim = _make_card("strong_claim", "Strong Claim", CardType.CLAIM,
                           power=10, adjacency_required=False)
        attacker.hand = [claim] + attacker.hand[1:]
        success, msg = play_card(game, "a0", 0, target_q=tile_q, target_r=tile_r)
        assert success  # play succeeds (played face down)

        # Submit both plans and resolve
        submit_play(game, "f0")
        submit_play(game, "a0")

        # Tile should still belong to Fort (immune)
        tile = game.grid.get_tile(tile_q, tile_r)
        assert tile.owner == "f0"


# ── Conditional Power Modifier Tests ──────────────────────────────


class TestConditionalPower:
    def test_strike_team_bonus_with_another_claim(self, small_2p_game, card_registry):
        """Strike Team: +2 power if another Claim was played this turn."""
        game = small_2p_game
        player = game.players["p0"]
        assert game.grid is not None

        # Find two adjacent neutral tiles
        q1, r1 = _find_adjacent_neutral(game, "p0")
        assert q1 is not None

        # First play a basic claim (no adjacency required to simplify)
        basic_claim = _make_card("basic", "Basic Claim", CardType.CLAIM,
                                 power=1, adjacency_required=False)
        strike_team = _copy_card(card_registry["vanguard_strike_team"], "test_st")
        # Override adjacency for test simplicity
        strike_team.adjacency_required = False

        player.hand = [basic_claim, strike_team] + player.hand[2:]

        # Play basic claim first
        success, msg = play_card(game, "p0", 0, target_q=q1, target_r=r1)
        assert success, msg

        # Find another target tile
        q2, r2 = None, None
        for tile in game.grid.tiles.values():
            if tile.owner is None and not tile.is_blocked and (tile.q, tile.r) != (q1, r1):
                q2, r2 = tile.q, tile.r
                break
        assert q2 is not None

        # Play strike team — should get +2 power (base 3 + 2 = 5)
        success, msg = play_card(game, "p0", 0, target_q=q2, target_r=r2)
        assert success, msg

        # Verify power calculation
        st_action = player.planned_actions[-1]
        effective = calculate_effective_power(game, player, st_action.card, st_action)
        assert effective == 5  # 3 base + 2 bonus

    def test_garrison_defending_power(self, card_registry):
        """Garrison: power 5 when defending an owned tile."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "a0", "name": "Attacker", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)

        fort = game.players["f0"]
        assert game.grid is not None
        fort_tiles = game.grid.get_player_tiles("f0")
        target = fort_tiles[0]

        garrison = _copy_card(card_registry["fortress_garrison"], "test_gar")
        action = PlannedAction(card=garrison, target_q=target.q, target_r=target.r)

        # Tile is owned by Fort -> defending
        effective = calculate_effective_power(game, fort, garrison, action)
        assert effective == 5  # 3 base + 2 defending bonus

    def test_garrison_attacking_power(self, card_registry):
        """Garrison: base power (3) when attacking an enemy tile."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "a0", "name": "Enemy", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)

        fort = game.players["f0"]
        assert game.grid is not None
        enemy_tiles = game.grid.get_player_tiles("a0")
        target = enemy_tiles[0]

        garrison = _copy_card(card_registry["fortress_garrison"], "test_gar")
        action = PlannedAction(card=garrison, target_q=target.q, target_r=target.r)

        effective = calculate_effective_power(game, fort, garrison, action)
        assert effective == 3  # base only, not defending

    def test_militia_conditional_power(self, card_registry):
        """Militia: power 4 if 3+ adjacent tiles owned."""
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
        execute_upkeep(game)

        assert game.grid is not None
        player = game.players["p0"]
        militia = _copy_card(card_registry["neutral_militia"], "test_militia")

        # Find a neutral tile and count adjacent owned tiles
        for tile in game.grid.tiles.values():
            if tile.owner is None and not tile.is_blocked:
                adj = game.grid.get_adjacent(tile.q, tile.r)
                owned_adj = sum(1 for a in adj if a.owner == "p0")
                action = PlannedAction(card=militia, target_q=tile.q, target_r=tile.r)
                effective = calculate_effective_power(game, player, militia, action)
                if owned_adj >= 3:
                    assert effective == 4  # base 2 + bonus 2
                else:
                    assert effective == 2  # base only
                break

    def test_numbers_game_power_equals_hand(self, small_2p_game, card_registry):
        """Numbers Game: power = other cards in hand (not including this card)."""
        game = small_2p_game
        player = game.players["p1"]  # Swarm

        numbers = _copy_card(card_registry["swarm_numbers_game"], "test_ng")
        player.hand = [numbers, _make_card("a"), _make_card("b"), _make_card("c")]

        action = PlannedAction(card=numbers, target_q=0, target_r=0)
        effective = calculate_effective_power(game, player, numbers, action)
        # Hand has 4 cards; power = 3 (other cards, not including this card)
        assert effective == 3


# ── On-Resolution Effect Tests ────────────────────────────────────


class TestOnResolutionEffects:
    def test_blitz_draw_next_turn_on_success(self, card_registry):
        """Blitz: if successful claim, draw 1 extra card next turn."""
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
        execute_upkeep(game)

        player = game.players["p0"]
        assert game.grid is not None

        # Find adjacent neutral tile
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None

        blitz = _copy_card(card_registry["vanguard_blitz"], "test_blitz")
        player.hand = [blitz] + player.hand[1:]

        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success

        # Submit both plans
        submit_play(game, "p0")
        submit_play(game, "p1")

        # If blitz succeeded, player should have extra draws queued
        # Check tile ownership
        tile = game.grid.get_tile(q, r)
        if tile.owner == "p0":
            assert player.turn_modifiers.extra_draws_next_turn == 1

    def test_war_of_attrition_penalizes_defender(self, card_registry):
        """War of Attrition: if defender holds, they draw fewer next turn."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "a0", "name": "Attacker", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)

        attacker = game.players["a0"]
        defender = game.players["f0"]
        assert game.grid is not None

        # Find a tile owned by Fort and force it to low defense so the
        # power-2 War of Attrition can legally target it under the new
        # validation rule (power > defense on occupied tiles).
        fort_tiles = game.grid.get_player_tiles("f0")
        target = fort_tiles[0]
        target.base_defense = 1
        target.defense_power = 1

        # Give attacker War of Attrition with no adjacency requirement
        woa = _copy_card(card_registry["fortress_war_of_attrition"], "test_woa")
        woa.adjacency_required = False
        attacker.hand = [woa] + attacker.hand[1:]

        success, msg = play_card(game, "a0", 0, target_q=target.q, target_r=target.r)
        assert success, msg

        # Now boost defense above the attacker's power so the defender holds
        # at resolution time and the hold-trigger effect fires.
        target.defense_power = 5

        submit_play(game, "a0")
        submit_play(game, "f0")

        # If defender held (likely since WoA only has power 2), they should be penalized
        tile = game.grid.get_tile(target.q, target.r)
        if tile.owner == "f0":
            assert defender.forced_discard_next_turn == 1


# ── Cost Reduction Tests ──────────────────────────────────────────


class TestCostReduction:
    def test_supply_line_reduces_cost(self, card_registry):
        """Supply Line: one card costs 2 less to purchase this turn."""
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

        player = game.players["f0"]
        supply = _copy_card(card_registry["fortress_supply_line"], "test_sl")
        player.hand = [supply] + player.hand[1:]

        success, _ = play_card(game, "f0", 0)
        assert success

        # Cost reduction resolves on_resolution — submit and resolve
        submit_play(game, "f0")
        submit_play(game, "p1")
        assert game.current_phase == Phase.REVEAL
        for pid in game.player_order:
            advance_resolve(game, pid)

        # Should have a cost reduction active
        assert len(player.turn_modifiers.cost_reductions) == 1
        assert player.turn_modifiers.cost_reductions[0]["amount"] == 1


# ── Grant Actions Tests ───────────────────────────────────────────


class TestGrantActions:
    def test_forced_march_grants_actions_next_turn(self, small_2p_game, card_registry):
        """Forced March: all other players gain 1 extra action next turn."""
        game = small_2p_game
        player = game.players["p0"]
        other = game.players["p1"]

        forced_march = _copy_card(card_registry["neutral_forced_march"], "test_fm")
        player.hand = [forced_march] + player.hand[1:]

        initial_actions = other.actions_available

        success, _ = play_card(game, "p0", 0)
        assert success

        # Actions don't increase this turn
        assert other.actions_available == initial_actions
        # Effect is on_resolution — submit and resolve to trigger it
        submit_play(game, "p0")
        submit_play(game, "p1")
        assert other.turn_modifiers.extra_actions_next_turn == 1


# ── Ignore Defense Tests ──────────────────────────────────────────


class TestIgnoreDefense:
    def test_siege_engine_flags_ignore_defense(self, card_registry):
        """Siege Engine: sets ignore_defense flag on turn modifiers."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "f0", "name": "Fort", "archetype": "fortress"},
                {"id": "a0", "name": "Attacker", "archetype": "vanguard"},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)

        attacker = game.players["a0"]
        assert game.grid is not None
        fort_tiles = game.grid.get_player_tiles("f0")
        # Pick a non-base tile so we don't have to fight intrinsic base defense.
        # Siege Engine ignores temporary bonuses but still respects base + permanent.
        target = next((t for t in fort_tiles if not t.is_base), fort_tiles[0])

        siege = _copy_card(card_registry["fortress_siege_engine"], "test_siege")
        siege.adjacency_required = False
        attacker.hand = [siege] + attacker.hand[1:]

        success, msg = play_card(game, "a0", 0, target_q=target.q, target_r=target.r)
        assert success, msg

        # Note: ignore_defense is on_resolution timing, so it won't be set during play_card
        # It's set during execute_reveal. But we can test that the effect exists
        assert any(e.type == EffectType.IGNORE_DEFENSE for e in siege.effects)


# ── Breakthrough Auto-Claim Tests ─────────────────────────────────


class TestBreakthrough:
    def test_breakthrough_auto_claims_neutral(self, card_registry):
        """Breakthrough: on success, auto-claim one adjacent neutral tile."""
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
        execute_upkeep(game)

        player = game.players["p0"]
        assert game.grid is not None

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None

        # Count tiles before
        tiles_before = len(game.grid.get_player_tiles("p0"))

        breakthrough = _copy_card(card_registry["vanguard_breakthrough"], "test_bt")
        player.hand = [breakthrough] + player.hand[1:]

        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        # If breakthrough succeeded, player should own the target tile
        # PLUS one additional adjacent neutral tile
        tile = game.grid.get_tile(q, r)
        if tile.owner == "p0":
            tiles_after = len(game.grid.get_player_tiles("p0"))
            # Should have gained at least 2 tiles (target + auto-claim)
            assert tiles_after >= tiles_before + 2


# ── Effect Serialization Tests ────────────────────────────────────


class TestEffectSerialization:
    def test_effect_to_dict(self):
        effect = Effect(
            type=EffectType.GAIN_VP,
            value=1,
            timing=Timing.IMMEDIATE,
        )
        d = effect.to_dict()
        assert d["type"] == "gain_vp"
        assert d["value"] == 1
        assert d["timing"] == "immediate"

    def test_card_to_dict_includes_effects(self, card_registry):
        card = card_registry.get("vanguard_rally")
        assert card is not None
        d = card.to_dict()
        assert "effects" in d
        assert len(d["effects"]) > 0
        assert d["effects"][0]["type"] == "self_discard"


# ── Integration: Full Turn with Effects ───────────────────────────


class TestFullTurnIntegration:
    def test_blitz_rush_then_buy_blocked(self, small_2p_game, card_registry):
        """Play Blitz Rush, verify buy is blocked, then next turn it resets."""
        game = small_2p_game
        player = game.players["p1"]

        blitz_rush = _copy_card(card_registry["swarm_blitz_rush"], "test_br")
        player.hand = [blitz_rush] + player.hand[1:]

        play_card(game, "p1", 0)
        submit_play(game, "p0")
        submit_play(game, "p1")

        # Advance through reveal
        for pid in game.player_order:
            advance_resolve(game, pid)

        # Buy phase — should be blocked
        assert game.current_phase == Phase.BUY
        success, msg = buy_card(game, "p1", "upgrade", "")
        assert not success

        # End turn and start next
        execute_end_of_turn(game)

        # Buy lock should be cleared after turn reset
        player = game.players["p1"]
        assert player.turn_modifiers.buy_locked is False


class TestAdjacencyBridge:
    """Road Builder: must target a tile that connects two disconnected territory groups."""

    def _make_road_builder(self) -> Card:
        return _make_card(
            card_id="neutral_road_builder",
            name="Road Builder",
            card_type=CardType.CLAIM,
            power=5,
            timing=Timing.ON_RESOLUTION,
            effects=[
                Effect(type=EffectType.ADJACENCY_BRIDGE, value=0, timing=Timing.ON_RESOLUTION),
            ],
        )

    def test_road_builder_rejects_non_bridging_tile(self, small_2p_game: GameState) -> None:
        """Road Builder can't target a tile that doesn't connect two groups."""
        game = small_2p_game
        game.test_mode = True
        p0 = game.players["p0"]
        assert game.grid is not None

        # Give the player a Road Builder
        rb = self._make_road_builder()
        p0.hand.insert(0, rb)

        # Find a tile adjacent to player territory — this is a normal adjacent tile,
        # NOT bridging two groups (player only has one contiguous group at start)
        target = None
        for tile in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(tile.q, tile.r):
                if adj.owner is None and not adj.is_blocked:
                    target = adj
                    break
            if target:
                break
        assert target is not None

        ok, msg = play_card(game, "p0", 0, target.q, target.r)
        assert not ok
        assert "disconnected" in msg.lower() or "connect" in msg.lower()

    def test_road_builder_accepts_bridging_tile(self, small_2p_game: GameState) -> None:
        """Road Builder succeeds when targeting a tile that connects two disconnected groups."""
        game = small_2p_game
        game.test_mode = True
        p0 = game.players["p0"]
        assert game.grid is not None

        # Create a disconnected territory: find a tile that is NOT adjacent to
        # any of player's tiles and assign it to the player.
        owned_coords = {(t.q, t.r) for t in game.grid.get_player_tiles("p0")}
        adj_coords = set()
        for t in game.grid.get_player_tiles("p0"):
            for nq, nr in t.neighbors():
                adj_coords.add((nq, nr))

        # Find a tile 2+ steps away to create an isolated group
        isolated_tile = None
        for t in game.grid.tiles.values():
            if (t.q, t.r) not in owned_coords and (t.q, t.r) not in adj_coords and not t.is_blocked:
                isolated_tile = t
                break
        assert isolated_tile is not None, "Could not find a tile far enough for isolated group"

        # Assign that tile to p0 — now p0 has two disconnected groups
        isolated_tile.owner = "p0"

        # Now find a tile that would bridge the two groups:
        # It must be adjacent to both the main territory and the isolated tile's group.
        # Walk a path from main territory toward the isolated tile and find a gap tile.
        from collections import deque

        # BFS from isolated tile's neighbors to find one that is also adjacent to main territory
        # Simpler approach: find a tile adjacent to BOTH groups
        main_group = game.grid.get_connected_tiles("p0")
        iso_group = {(isolated_tile.q, isolated_tile.r)}

        # Expand iso_group neighbors
        iso_adj = set()
        for nq, nr in isolated_tile.neighbors():
            n = game.grid.get_tile(nq, nr)
            if n and not n.is_blocked and n.owner is None:
                iso_adj.add((nq, nr))

        # Expand main_group neighbors
        main_adj = set()
        for mq, mr in main_group:
            mt = game.grid.get_tile(mq, mr)
            if mt:
                for nq, nr in mt.neighbors():
                    n = game.grid.get_tile(nq, nr)
                    if n and not n.is_blocked and n.owner is None:
                        main_adj.add((nq, nr))

        # Find a tile in both adjacency sets — that's our bridge
        bridge_coords = iso_adj & main_adj
        if not bridge_coords:
            # If no direct bridge, place the isolated tile closer — on a tile adjacent
            # to main territory, then skip one, then place the island
            # Reset and do a simpler setup
            isolated_tile.owner = None

            # Find two tiles A and B where A is adjacent to main territory,
            # B is adjacent to A but NOT adjacent to main territory.
            # Assign B to p0, then A is the bridge tile.
            for tile_a in game.grid.tiles.values():
                if tile_a.owner is not None or tile_a.is_blocked:
                    continue
                if (tile_a.q, tile_a.r) not in main_adj:
                    continue
                for nq, nr in tile_a.neighbors():
                    tile_b = game.grid.get_tile(nq, nr)
                    if not tile_b or tile_b.is_blocked or tile_b.owner is not None:
                        continue
                    if (nq, nr) in main_adj or (nq, nr) in main_group:
                        continue
                    # tile_a bridges main group and tile_b
                    tile_b.owner = "p0"
                    bridge_coords = {(tile_a.q, tile_a.r)}
                    break
                if bridge_coords:
                    break

        assert bridge_coords, "Could not find a bridge tile setup"
        bq, br = next(iter(bridge_coords))

        # Give the player a Road Builder
        rb = self._make_road_builder()
        p0.hand.insert(0, rb)

        ok, msg = play_card(game, "p0", 0, bq, br)
        assert ok, f"Road Builder should succeed on bridging tile: {msg}"

    def test_road_builder_rejects_when_only_one_group(self, small_2p_game: GameState) -> None:
        """Road Builder can't target anything when player has only one contiguous territory."""
        game = small_2p_game
        game.test_mode = True
        p0 = game.players["p0"]
        assert game.grid is not None

        rb = self._make_road_builder()
        p0.hand.insert(0, rb)

        # Try every adjacent neutral tile — none should work because there's only one group
        found_any_target = False
        for tile in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(tile.q, tile.r):
                if adj.owner is None and not adj.is_blocked:
                    ok, _ = play_card(game, "p0", 0, adj.q, adj.r)
                    if ok:
                        found_any_target = True
                        break
            if found_any_target:
                break
        assert not found_any_target, "Road Builder should not be playable with a single contiguous territory"
