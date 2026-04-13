"""Round-trip serialization tests for GameState persistence."""

from __future__ import annotations

import json
import random

import pytest

from app.data_loader.loader import load_all_cards
from app.game_engine.cards import (
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
    make_land_grant_card,
    make_rubble_card,
    make_spoils_card,
)
from app.game_engine.effects import Effect, EffectType, TurnModifiers
from app.game_engine.game_state import (
    GameState,
    LogEntry,
    NeutralMarket,
    Phase,
    PlannedAction,
    Player,
    create_game,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_play,
    execute_reveal,
    advance_resolve,
    buy_card,
    end_buy_phase,
    execute_end_of_turn,
)
from app.game_engine.hex_grid import GridSize, HexGrid
from app.storage.serializer import (
    serialize_game,
    deserialize_game,
    _serialize_rng,
    _deserialize_rng,
    _serialize_turn_modifiers,
    _deserialize_turn_modifiers,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _assert_cards_equal(a: Card, b: Card, msg: str = "") -> None:
    """Assert two cards are identical in all important fields."""
    prefix = f"{msg}: " if msg else ""
    assert a.id == b.id, f"{prefix}id mismatch: {a.id} != {b.id}"
    assert a.name == b.name, f"{prefix}name mismatch"
    assert a.archetype == b.archetype, f"{prefix}archetype mismatch"
    assert a.card_type == b.card_type, f"{prefix}card_type mismatch"
    assert a.power == b.power, f"{prefix}power mismatch"
    assert a.resource_gain == b.resource_gain, f"{prefix}resource_gain mismatch"
    assert a.action_return == b.action_return, f"{prefix}action_return mismatch"
    assert a.is_upgraded == b.is_upgraded, f"{prefix}is_upgraded mismatch"
    assert a.passive_vp == b.passive_vp, f"{prefix}passive_vp mismatch"
    assert a.vp_formula == b.vp_formula, f"{prefix}vp_formula mismatch"
    assert a.unplayable == b.unplayable, f"{prefix}unplayable mismatch"
    assert a.trash_on_use == b.trash_on_use, f"{prefix}trash_on_use mismatch"
    assert a.stackable == b.stackable, f"{prefix}stackable mismatch"
    assert len(a.effects) == len(b.effects), f"{prefix}effects length mismatch"


def _assert_players_equal(a: Player, b: Player) -> None:
    """Assert two players have matching state."""
    assert a.id == b.id
    assert a.name == b.name
    assert a.archetype == b.archetype
    assert a.color == b.color
    assert a.resources == b.resources
    assert a.vp == b.vp
    assert a.actions_used == b.actions_used
    assert a.actions_available == b.actions_available
    assert a.upgrade_credits == b.upgrade_credits
    assert a.forced_discard_next_turn == b.forced_discard_next_turn
    assert a.has_submitted_play == b.has_submitted_play
    assert a.has_acknowledged_resolve == b.has_acknowledged_resolve
    assert a.has_ended_turn == b.has_ended_turn
    assert a.is_cpu == b.is_cpu
    assert a.cpu_noise == b.cpu_noise
    assert a.has_left == b.has_left
    assert a.left_vp == b.left_vp
    assert a.claims_won_last_round == b.claims_won_last_round
    assert a.pending_discard == b.pending_discard
    assert a._prev_market_ids == b._prev_market_ids
    assert a._prev_market_types == b._prev_market_types

    # Hand
    assert len(a.hand) == len(b.hand), f"Hand length: {len(a.hand)} != {len(b.hand)}"
    for i, (ca, cb) in enumerate(zip(a.hand, b.hand)):
        _assert_cards_equal(ca, cb, f"hand[{i}]")

    # Deck
    assert len(a.deck.cards) == len(b.deck.cards), "Deck draw pile length mismatch"
    for i, (ca, cb) in enumerate(zip(a.deck.cards, b.deck.cards)):
        _assert_cards_equal(ca, cb, f"deck.cards[{i}]")

    assert len(a.deck.discard) == len(b.deck.discard), "Deck discard pile length mismatch"
    for i, (ca, cb) in enumerate(zip(a.deck.discard, b.deck.discard)):
        _assert_cards_equal(ca, cb, f"deck.discard[{i}]")

    # Archetype market & deck
    assert len(a.archetype_market) == len(b.archetype_market)
    for i, (ca, cb) in enumerate(zip(a.archetype_market, b.archetype_market)):
        _assert_cards_equal(ca, cb, f"archetype_market[{i}]")

    assert len(a.archetype_deck) == len(b.archetype_deck)

    # Planned actions
    assert len(a.planned_actions) == len(b.planned_actions)
    for i, (pa, pb) in enumerate(zip(a.planned_actions, b.planned_actions)):
        _assert_cards_equal(pa.card, pb.card, f"planned_actions[{i}].card")
        assert pa.target_q == pb.target_q
        assert pa.target_r == pb.target_r
        assert pa.target_player_id == pb.target_player_id
        assert pa.extra_targets == pb.extra_targets
        assert pa.effective_power == pb.effective_power
        assert pa.effective_resource_gain == pb.effective_resource_gain

    # Trash
    assert len(a.trash) == len(b.trash)
    for i, (ca, cb) in enumerate(zip(a.trash, b.trash)):
        _assert_cards_equal(ca, cb, f"trash[{i}]")


def _assert_grids_equal(a: HexGrid, b: HexGrid) -> None:
    """Assert two grids match exactly."""
    assert a.size == b.size
    assert len(a.tiles) == len(b.tiles)
    for key, tile_a in a.tiles.items():
        tile_b = b.tiles.get(key)
        assert tile_b is not None, f"Missing tile {key}"
        assert tile_a.q == tile_b.q
        assert tile_a.r == tile_b.r
        assert tile_a.is_blocked == tile_b.is_blocked
        assert tile_a.is_vp == tile_b.is_vp
        assert tile_a.vp_value == tile_b.vp_value
        assert tile_a.owner == tile_b.owner
        assert tile_a.defense_power == tile_b.defense_power
        assert tile_a.base_defense == tile_b.base_defense
        assert tile_a.permanent_defense_bonus == tile_b.permanent_defense_bonus
        assert tile_a.held_since_turn == tile_b.held_since_turn
        assert tile_a.capture_count == tile_b.capture_count
        assert tile_a.is_base == tile_b.is_base
        assert tile_a.base_owner == tile_b.base_owner
    assert a.starting_positions == b.starting_positions


def _assert_games_equal(a: GameState, b: GameState) -> None:
    """Assert two game states match (excluding card_registry & ephemeral WS state)."""
    assert a.id == b.id
    assert a.current_phase == b.current_phase
    assert a.current_round == b.current_round
    assert a.first_player_index == b.first_player_index
    assert a.player_order == b.player_order
    assert a.winner == b.winner
    assert a.vp_target == b.vp_target
    assert a.granted_actions == b.granted_actions
    assert a.host_id == b.host_id
    assert a.lobby_code == b.lobby_code
    assert a.players_done_buying == b.players_done_buying
    assert a.card_pack == b.card_pack
    assert a.map_seed == b.map_seed
    assert a.test_mode == b.test_mode
    assert a.log == b.log
    assert a.neutral_purchase_log == b.neutral_purchase_log
    assert a.buy_phase_purchases == b.buy_phase_purchases
    assert a.resolution_steps == b.resolution_steps
    assert a.player_effects == b.player_effects

    # Grid
    if a.grid:
        assert b.grid is not None
        _assert_grids_equal(a.grid, b.grid)
    else:
        assert b.grid is None

    # Players
    assert set(a.players.keys()) == set(b.players.keys())
    for pid in a.players:
        _assert_players_equal(a.players[pid], b.players[pid])

    # Game log
    assert len(a.game_log) == len(b.game_log)
    for i, (la, lb) in enumerate(zip(a.game_log, b.game_log)):
        assert la.message == lb.message
        assert la.round == lb.round
        assert la.phase == lb.phase
        assert la.visible_to == lb.visible_to
        assert la.actor == lb.actor

    # Neutral market
    assert set(a.neutral_market.stacks.keys()) == set(b.neutral_market.stacks.keys())
    for base_id in a.neutral_market.stacks:
        stack_a = a.neutral_market.stacks[base_id]
        stack_b = b.neutral_market.stacks[base_id]
        assert len(stack_a) == len(stack_b), f"Neutral market '{base_id}' stack length mismatch"
        for j, (ca, cb) in enumerate(zip(stack_a, stack_b)):
            _assert_cards_equal(ca, cb, f"neutral_market[{base_id}][{j}]")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestRNGSerialization:
    def test_rng_round_trip(self) -> None:
        """RNG state is preserved exactly through serialize/deserialize."""
        rng = random.Random(12345)
        # Generate some numbers to advance state
        vals_before = [rng.random() for _ in range(10)]

        serialized = _serialize_rng(rng)
        restored = _deserialize_rng(serialized)

        # The NEXT values should match
        vals_original = [rng.random() for _ in range(20)]
        vals_restored = [restored.random() for _ in range(20)]
        assert vals_original == vals_restored

    def test_rng_json_serializable(self) -> None:
        """RNG state dict is JSON-serializable."""
        rng = random.Random(42)
        rng.random()
        serialized = _serialize_rng(rng)
        json_str = json.dumps(serialized)
        assert len(json_str) > 100  # ~2.5KB for the 625-int state


class TestTurnModifiersSerialization:
    def test_round_trip_empty(self) -> None:
        tm = TurnModifiers()
        data = _serialize_turn_modifiers(tm)
        restored = _deserialize_turn_modifiers(data)
        assert restored.buy_locked == False
        assert restored.free_rerolls == 0
        assert len(restored.ignore_defense_tiles) == 0

    def test_round_trip_populated(self) -> None:
        tm = TurnModifiers(
            buy_locked=True,
            cost_reductions=[{"scope": "archetype", "amount": 1}],
            immune_tiles={"0,1": 2, "2,3": 1},
            contest_costs={"1,0": 3},
            extra_draws_next_turn=2,
            extra_actions_next_turn=1,
            free_rerolls=3,
            ignore_defense_tiles={"0,0", "1,1"},
            immediate_resolve_tiles={"2,2"},
            cease_fire_bonus=2,
            ignore_defense_override_tiles={"3,3"},
        )
        data = _serialize_turn_modifiers(tm)
        restored = _deserialize_turn_modifiers(data)
        assert restored.buy_locked == True
        assert restored.cost_reductions == [{"scope": "archetype", "amount": 1}]
        assert restored.immune_tiles == {"0,1": 2, "2,3": 1}
        assert restored.contest_costs == {"1,0": 3}
        assert restored.extra_draws_next_turn == 2
        assert restored.extra_actions_next_turn == 1
        assert restored.free_rerolls == 3
        assert restored.ignore_defense_tiles == {"0,0", "1,1"}
        assert restored.immediate_resolve_tiles == {"2,2"}
        assert restored.cease_fire_bonus == 2
        assert restored.ignore_defense_override_tiles == {"3,3"}


class TestBasicRoundTrip:
    def test_fresh_game_round_trip(self, card_registry: dict[str, Card]) -> None:
        """A freshly created game survives serialize/deserialize."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)
        _assert_games_equal(game, restored)

    def test_after_start_of_turn(self, card_registry: dict[str, Card]) -> None:
        """Game after start-of-turn (hands drawn, market set up) round-trips."""
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
        assert game.current_phase == Phase.PLAY

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)
        _assert_games_equal(game, restored)

        # Verify hands are populated
        for pid in game.player_order:
            assert len(restored.players[pid].hand) == len(game.players[pid].hand)
            assert len(restored.players[pid].hand) > 0

    def test_json_output_is_valid(self, card_registry: dict[str, Card]) -> None:
        """Serialized output is valid JSON."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        blob = serialize_game(game)
        parsed = json.loads(blob)
        assert parsed["_schema_version"] == 1
        assert parsed["id"] == game.id

    def test_3_player_medium(self, card_registry: dict[str, Card]) -> None:
        """3-player medium game round-trips."""
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
        execute_upkeep(game)

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)
        _assert_games_equal(game, restored)


class TestRNGContinuity:
    def test_rng_produces_same_values_after_restore(
        self, card_registry: dict[str, Card]
    ) -> None:
        """After restoring, the RNG produces the same sequence as the original."""
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

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        # Generate numbers from both RNGs — they should match
        original_vals = [game.rng.random() for _ in range(50)]
        restored_vals = [restored.rng.random() for _ in range(50)]
        assert original_vals == restored_vals


class TestPlayPhaseRoundTrip:
    def test_after_playing_cards(self, card_registry: dict[str, Card]) -> None:
        """Game state with planned actions round-trips correctly."""
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

        p0 = game.players["p0"]
        # Play gather cards (resource-generating, no target needed)
        for i, card in enumerate(p0.hand):
            if card.card_type == CardType.ENGINE:
                play_card(game, "p0", i)
                break

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)
        _assert_games_equal(game, restored)

    def test_with_claim_on_tile(self, card_registry: dict[str, Card]) -> None:
        """Playing a claim card on a tile round-trips with target coordinates."""
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

        p0 = game.players["p0"]
        # Find a claim card and an adjacent empty tile
        claim_idx = None
        target_q, target_r = None, None
        for i, card in enumerate(p0.hand):
            if card.card_type == CardType.CLAIM:
                claim_idx = i
                break

        if claim_idx is not None:
            # Find an adjacent unclaimed tile
            owned_tiles = game.grid.get_player_tiles("p0") if game.grid else []
            for owned in owned_tiles:
                for nq, nr in owned.neighbors():
                    neighbor = game.grid.get_tile(nq, nr) if game.grid else None
                    if neighbor and not neighbor.is_blocked and neighbor.owner is None:
                        target_q, target_r = nq, nr
                        break
                if target_q is not None:
                    break

            if target_q is not None:
                ok, _ = play_card(game, "p0", claim_idx, target_q, target_r)
                assert ok, "Claim card should be playable"

                blob = serialize_game(game)
                restored = deserialize_game(blob, card_registry)
                _assert_games_equal(game, restored)

                # Verify planned action was preserved
                assert len(restored.players["p0"].planned_actions) == len(
                    game.players["p0"].planned_actions
                )


class TestGeneratedCards:
    def test_land_grant_round_trip(self, card_registry: dict[str, Card]) -> None:
        """Land Grant cards (generated, not in registry) round-trip correctly."""
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

        # Inject a Land Grant into p0's deck
        land_grant = make_land_grant_card()
        game.players["p0"].deck.discard.append(land_grant)

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)
        _assert_games_equal(game, restored)

        # Verify the Land Grant specifically
        restored_discard = restored.players["p0"].deck.discard
        lg = [c for c in restored_discard if c.name == "Land Grant"]
        assert len(lg) == 1
        assert lg[0].passive_vp == 1
        assert lg[0].unplayable == True

    def test_rubble_and_spoils_round_trip(self, card_registry: dict[str, Card]) -> None:
        """Rubble and Spoils cards round-trip correctly."""
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

        # Inject generated cards
        game.players["p0"].deck.discard.append(make_rubble_card())
        game.players["p1"].deck.discard.append(make_spoils_card())

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        rubble = [c for c in restored.players["p0"].deck.discard if c.name == "Rubble"]
        assert len(rubble) == 1
        assert rubble[0].passive_vp == 0

        spoils = [c for c in restored.players["p1"].deck.discard if c.name == "Spoils"]
        assert len(spoils) == 1
        assert spoils[0].passive_vp == 1


class TestUpgradedCards:
    def test_upgraded_card_round_trip(self, card_registry: dict[str, Card]) -> None:
        """An upgraded card preserves its is_upgraded flag through serialization."""
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

        # Upgrade a card in p0's hand
        p0 = game.players["p0"]
        if p0.hand:
            p0.hand[0].is_upgraded = True

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        if p0.hand:
            assert restored.players["p0"].hand[0].is_upgraded == True


def _play_engine_cards_and_submit(game: GameState) -> None:
    """Helper: play engine cards, submit, reveal, buy, completing the round."""
    for pid in game.player_order:
        p = game.players[pid]
        for i in range(len(p.hand) - 1, -1, -1):
            if p.hand[i].card_type == CardType.ENGINE:
                play_card(game, pid, i)

    for pid in game.player_order:
        submit_play(game, pid)

    execute_reveal(game)
    for pid in game.player_order:
        advance_resolve(game, pid)

    for pid in game.player_order:
        if pid not in game.players_done_buying:
            end_buy_phase(game, pid)


def _advance_to_play_phase(game: GameState) -> None:
    """Advance through start-of-turn/upkeep to reach PLAY phase."""
    if game.current_phase == Phase.START_OF_TURN:
        execute_start_of_turn(game)
    if game.current_phase == Phase.UPKEEP:
        execute_upkeep(game)


class TestMultiRoundRoundTrip:
    def test_play_full_round_then_serialize(
        self, card_registry: dict[str, Card]
    ) -> None:
        """A game that has gone through a full round serializes correctly."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
            test_mode=True,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)
        _play_engine_cards_and_submit(game)

        # Advance to round 2 play phase
        _advance_to_play_phase(game)
        assert game.current_round == 2
        assert game.current_phase == Phase.PLAY

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)
        _assert_games_equal(game, restored)
        assert restored.current_round == 2

    def test_two_full_rounds(self, card_registry: dict[str, Card]) -> None:
        """Two full rounds of play, then serialize and compare."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
            test_mode=True,
        )

        for _ in range(2):
            _advance_to_play_phase(game)
            _play_engine_cards_and_submit(game)

        _advance_to_play_phase(game)
        assert game.current_round == 3

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)
        _assert_games_equal(game, restored)


class TestNeutralMarket:
    def test_neutral_market_round_trip(self, card_registry: dict[str, Card]) -> None:
        """Neutral market with varied stack sizes round-trips."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )

        # Verify neutral market exists
        assert len(game.neutral_market.stacks) > 0

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        # Same stacks, same counts
        for base_id in game.neutral_market.stacks:
            assert base_id in restored.neutral_market.stacks
            assert len(restored.neutral_market.stacks[base_id]) == len(
                game.neutral_market.stacks[base_id]
            )


class TestGameLog:
    def test_game_log_round_trip(self, card_registry: dict[str, Card]) -> None:
        """Game log entries preserve all fields through serialization."""
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

        # Should have some log entries by now
        assert len(game.game_log) > 0

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        assert len(restored.game_log) == len(game.game_log)
        for orig, rest in zip(game.game_log, restored.game_log):
            assert orig.message == rest.message
            assert orig.round == rest.round
            assert orig.phase == rest.phase


class TestCPUPlayers:
    def test_cpu_player_round_trip(self, card_registry: dict[str, Card]) -> None:
        """CPU players preserve their CPU-specific fields."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "CPU Bot", "archetype": "swarm",
                 "is_cpu": True, "cpu_noise": 0.25},
            ],
            card_registry,
            seed=42,
        )
        execute_start_of_turn(game)
        execute_upkeep(game)

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        assert restored.players["p1"].is_cpu == True
        assert restored.players["p1"].cpu_noise == 0.25
        assert restored.players["p0"].is_cpu == False


class TestEdgeCases:
    def test_empty_hand_and_deck(self, card_registry: dict[str, Card]) -> None:
        """A player with empty hand and empty deck round-trips."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        # Artificially empty p0's deck and hand
        game.players["p0"].hand.clear()
        game.players["p0"].deck.cards.clear()
        game.players["p0"].deck.discard.clear()

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        assert len(restored.players["p0"].hand) == 0
        assert len(restored.players["p0"].deck.cards) == 0
        assert len(restored.players["p0"].deck.discard) == 0

    def test_serialize_deserialize_is_idempotent(
        self, card_registry: dict[str, Card]
    ) -> None:
        """Serialize → deserialize → serialize produces the same blob."""
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

        blob1 = serialize_game(game)
        restored = deserialize_game(blob1, card_registry)
        blob2 = serialize_game(restored)

        # Parse and compare (order may differ in dict keys)
        parsed1 = json.loads(blob1)
        parsed2 = json.loads(blob2)
        assert parsed1 == parsed2

    def test_game_with_winner(self, card_registry: dict[str, Card]) -> None:
        """A finished game with a winner round-trips."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        game.winner = "p0"
        game.current_phase = Phase.GAME_OVER

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        assert restored.winner == "p0"
        assert restored.current_phase == Phase.GAME_OVER

    def test_game_with_lobby_code(self, card_registry: dict[str, Card]) -> None:
        """Lobby-related fields round-trip."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        game.host_id = "p0"
        game.lobby_code = "ABCDEF"

        blob = serialize_game(game)
        restored = deserialize_game(blob, card_registry)

        assert restored.host_id == "p0"
        assert restored.lobby_code == "ABCDEF"

    def test_blob_size_reasonable(self, card_registry: dict[str, Card]) -> None:
        """Serialized blob is a reasonable size (under 500KB for a small game)."""
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

        blob = serialize_game(game)
        size_kb = len(blob) / 1024
        assert size_kb < 500, f"Blob too large: {size_kb:.1f} KB"

    def test_deserialize_from_dict(self, card_registry: dict[str, Card]) -> None:
        """deserialize_game accepts both str and dict input."""
        game = create_game(
            GridSize.SMALL,
            [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            card_registry,
            seed=42,
        )
        blob_str = serialize_game(game)
        blob_dict = json.loads(blob_str)

        restored = deserialize_game(blob_dict, card_registry)
        assert restored.id == game.id
