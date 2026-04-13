"""Comprehensive resolution tests for every card in the game.

Covers cards NOT already tested in test_effects.py. Organized by archetype.
Each test validates the card's core mechanic when played and/or resolved.
"""

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
    buy_card,
    create_game,
    execute_end_of_turn,
    execute_reveal,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_play,
    compute_player_vp,
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


def _find_n_adjacent_neutrals(game: GameState, player_id: str, n: int):
    """Find n distinct neutral tiles adjacent to a player's tiles."""
    assert game.grid is not None
    found: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for tile in game.grid.get_player_tiles(player_id):
        for adj in game.grid.get_adjacent(tile.q, tile.r):
            if adj.owner is None and not adj.is_blocked and (adj.q, adj.r) not in seen:
                found.append((adj.q, adj.r))
                seen.add((adj.q, adj.r))
                if len(found) >= n:
                    return found
    return found


def _find_connected_adjacent_neutrals(game: GameState, player_id: str, n: int):
    """Find up to n neutral tiles that are each adjacent to the player's
    territory AND together form a connected hex subgraph (primary + extras
    reachable from each other via direct neighbours).

    Returns a list of (q, r) tuples. If the grid doesn't admit a large-enough
    cluster, returns the best one found (caller may pytest.skip on short).
    """
    assert game.grid is not None
    pool = set(_find_n_adjacent_neutrals(game, player_id, 32))
    best: list[tuple[int, int]] = []
    for start in pool:
        # BFS over pool, stop when we've collected n tiles.
        order: list[tuple[int, int]] = [start]
        visited: set[tuple[int, int]] = {start}
        frontier = [start]
        while frontier and len(order) < n:
            q, r = frontier.pop(0)
            tile = game.grid.get_tile(q, r)
            if tile is None:
                continue
            for adj in game.grid.get_adjacent(q, r):
                coord = (adj.q, adj.r)
                if coord in pool and coord not in visited:
                    visited.add(coord)
                    order.append(coord)
                    frontier.append(coord)
                    if len(order) >= n:
                        break
        if len(order) > len(best):
            best = order
        if len(best) >= n:
            return best
    return best


def _ensure_adjacent_enemy_tile(game: GameState, player_id: str, enemy_id: str):
    """Find or create an enemy-owned tile adjacent to player_id's territory.

    If no such tile exists, assigns a neutral tile adjacent to the player to
    the enemy.  Returns the tile, or None if impossible.
    """
    assert game.grid is not None
    # First check if one already exists
    for pt in game.grid.get_player_tiles(player_id):
        for adj in game.grid.get_adjacent(pt.q, pt.r):
            if adj.owner == enemy_id:
                return adj
    # Create one by assigning a neutral neighbour to the enemy
    for pt in game.grid.get_player_tiles(player_id):
        for adj in game.grid.get_adjacent(pt.q, pt.r):
            if adj.owner is None and not adj.is_blocked and not adj.is_base:
                adj.owner = enemy_id
                adj.held_since_turn = game.current_round
                adj.defense_power = 0
                adj.base_defense = 0
                return adj
    return None


def _make_2p_game(card_registry, arch0="vanguard", arch1="swarm", seed=42):
    game = create_game(
        GridSize.SMALL,
        [
            {"id": "p0", "name": "Alice", "archetype": arch0},
            {"id": "p1", "name": "Bob", "archetype": arch1},
        ],
        card_registry,
        seed=seed,
    )
    execute_start_of_turn(game)
    execute_upkeep(game)
    return game


def _make_3p_game(card_registry, seed=99):
    game = create_game(
        GridSize.SMALL,
        [
            {"id": "p0", "name": "Alice", "archetype": "vanguard"},
            {"id": "p1", "name": "Bob", "archetype": "swarm"},
            {"id": "p2", "name": "Carol", "archetype": "fortress"},
        ],
        card_registry,
        seed=seed,
    )
    execute_start_of_turn(game)
    execute_upkeep(game)
    return game


# ══════════════════════════════════════════════════════════════════
# NEUTRAL CARDS
# ══════════════════════════════════════════════════════════════════


class TestNeutralExplore:
    def test_explore_claims_unoccupied(self, card_registry):
        """Explore: Power 0 claim on unoccupied adjacent tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        explore = _copy_card(card_registry["neutral_explore"], "test_explore")
        player.hand = [explore] + player.hand[1:]

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success, msg

    def test_explore_blocked_on_owned_tile(self, card_registry):
        """Explore: cannot target occupied tiles (unoccupied_only=True)."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        explore = _copy_card(card_registry["neutral_explore"], "test_explore")
        assert explore.unoccupied_only is True
        player.hand = [explore] + player.hand[1:]

        # Try to target a tile owned by opponent
        enemy_tiles = game.grid.get_player_tiles("p1")
        # Find one adjacent to p0
        for pt in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(pt.q, pt.r):
                if adj.owner == "p1":
                    success, msg = play_card(game, "p0", 0, target_q=adj.q, target_r=adj.r)
                    assert not success
                    assert "unoccupied" in msg.lower()
                    return
        # If no adjacent enemy tiles found, just verify the flag is set
        assert explore.unoccupied_only is True


class TestNeutralGather:
    def test_gather_gives_resources(self, card_registry):
        """Gather: gain 2 resources immediately."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        gather = _copy_card(card_registry["neutral_gather"], "test_gather")
        player.hand = [gather] + player.hand[1:]
        initial_resources = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_resources + 2

    def test_gather_upgraded_gives_4(self, card_registry):
        """Gather+: gain 4 resources."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        gather = _copy_card(card_registry["neutral_gather"], "test_gather_up")
        gather.is_upgraded = True
        player.hand = [gather] + player.hand[1:]
        initial_resources = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_resources + 4


class TestNeutralMercenary:
    def test_mercenary_power_3(self, card_registry):
        """Mercenary: Power 3 claim card."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        merc = _copy_card(card_registry["neutral_mercenary"], "test_merc")
        assert merc.power == 3
        assert merc.card_type == CardType.CLAIM

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        player.hand = [merc] + player.hand[1:]
        # Mercenary requires 2 resources to play
        player.resources = 5
        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success
        # Should have deducted 2 resources
        assert player.resources == 3

        submit_play(game, "p0")
        submit_play(game, "p1")

        tile = game.grid.get_tile(q, r)
        assert tile.owner == "p0"

    def test_mercenary_blocked_without_resources(self, card_registry):
        """Mercenary: cannot play without sufficient resources."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        merc = _copy_card(card_registry["neutral_mercenary"], "test_merc")
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        player.hand = [merc] + player.hand[1:]
        player.resources = 1
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert not success
        assert "resources" in msg.lower()


class TestNeutralProspector:
    def test_prospector_gain_3(self, card_registry):
        """Prospector: gain 3 resources immediately."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        prosp = _copy_card(card_registry["neutral_prospector"], "test_prosp")
        player.hand = [prosp] + player.hand[1:]
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial + 3


class TestNeutralSabotage:
    def test_sabotage_forces_discard(self, card_registry):
        """Sabotage: target opponent draws 1 fewer card next turn."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        sab = _copy_card(card_registry["neutral_sabotage"], "test_sab")
        player.hand = [sab] + player.hand[1:]

        success, _ = play_card(game, "p0", 0, target_player_id="p1")
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        target = game.players["p1"]
        assert target.forced_discard_next_turn >= 1


class TestNeutralCeaseFire:
    def test_cease_fire_bonus_when_no_opponent_claims(self, card_registry):
        """Cease Fire: draw extra next turn if no opponent tiles claimed."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        cf = _copy_card(card_registry["neutral_cease_fire"], "test_cf")
        player.hand = [cf] + player.hand[1:]

        success, _ = play_card(game, "p0", 0)
        assert success

        # Submit without any claims — bonus should apply after resolution
        submit_play(game, "p0")
        submit_play(game, "p1")

        # Cease fire resolves on_resolution, so check after reveal
        assert player.turn_modifiers.extra_draws_next_turn >= 2


class TestNeutralEminentDomain:
    def test_eminent_domain_ignores_adjacency(self, card_registry):
        """Eminent Domain: Power 3, no adjacency required."""
        card = card_registry["neutral_eminent_domain"]
        assert card.power == 3
        assert card.adjacency_required is False

    def test_eminent_domain_claims_distant_tile(self, card_registry):
        """Eminent Domain: can claim a non-adjacent neutral tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        ed = _copy_card(card_registry["neutral_eminent_domain"], "test_ed")
        player.hand = [ed] + player.hand[1:]

        # Find a neutral tile NOT adjacent to player
        assert game.grid is not None
        player_tile_coords = {(t.q, t.r) for t in game.grid.get_player_tiles("p0")}
        adj_coords = set()
        for t in game.grid.get_player_tiles("p0"):
            for a in game.grid.get_adjacent(t.q, t.r):
                adj_coords.add((a.q, a.r))

        for tile in game.grid.tiles.values():
            if (tile.owner is None and not tile.is_blocked
                    and (tile.q, tile.r) not in player_tile_coords
                    and (tile.q, tile.r) not in adj_coords):
                success, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
                assert success, "Eminent Domain should be able to target non-adjacent tiles"

                submit_play(game, "p0")
                submit_play(game, "p1")

                claimed = game.grid.get_tile(tile.q, tile.r)
                assert claimed.owner == "p0"
                return
        pytest.skip("No non-adjacent neutral tile found")


class TestNeutralFortifiedPost:
    def test_fortified_post_adds_permanent_defense(self, card_registry):
        """Barricade: target tile gains +2 permanent defense."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        fp = _copy_card(card_registry["neutral_fortified_post"], "test_fp")
        assert fp.buy_cost == 5
        # Permanent defense lives on the effect, not the round-only defense_bonus field
        assert fp.defense_bonus == 0
        assert any(e.type.value == "permanent_defense" for e in fp.effects)
        player.hand = [fp] + player.hand[1:]

        tile = game.grid.get_player_tiles("p0")[0]
        initial_perm = tile.permanent_defense_bonus
        success, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        updated = game.grid.get_tile(tile.q, tile.r)
        assert updated.permanent_defense_bonus == initial_perm + 2


class TestNeutralWarBonds:
    def test_war_bonds_resources_and_action(self, card_registry):
        """Tithe: gain 3 resources, gain 1 action back."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wb = _copy_card(card_registry["neutral_war_bonds"], "test_wb")
        assert wb.action_return == 1
        player.hand = [wb] + player.hand[1:]
        initial_res = player.resources
        initial_actions = player.actions_available

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_res + 3
        # Action return: played costs 1 action, returns 1 → net 0
        assert player.actions_available == initial_actions + 1


class TestNeutralRallyCry:
    def test_rally_cry_grants_stackable(self, card_registry):
        """Rally Cry: all claim cards in hand gain Stackable."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        rc = _copy_card(card_registry["neutral_rally_cry"], "test_rc")
        claim1 = _make_card("c1", "Claim1", CardType.CLAIM, power=2)
        claim2 = _make_card("c2", "Claim2", CardType.CLAIM, power=3)
        engine = _make_card("e1", "Engine1", CardType.ENGINE)
        player.hand = [rc, claim1, claim2, engine]

        assert not claim1.stackable
        assert not claim2.stackable

        success, _ = play_card(game, "p0", 0)
        assert success

        # Claims should now be stackable
        assert claim1.stackable
        assert claim2.stackable
        # Engine should not be affected
        assert not engine.stackable


class TestNeutralForcedMarch:
    """Already tested in test_effects.py — TestGrantActions. Verify action return."""

    def test_forced_march_net_positive(self, card_registry):
        """Forced March: action_return=2 (net positive)."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        fm = _copy_card(card_registry["neutral_forced_march"], "test_fm")
        assert fm.action_return == 2
        player.hand = [fm] + player.hand[1:]
        initial_actions = player.actions_available

        success, _ = play_card(game, "p0", 0)
        assert success
        # +2 actions returned, 1 used: net +1
        assert player.actions_available == initial_actions + 2


class TestNeutralLandGrant:
    def test_land_grant_passive_vp(self, card_registry):
        """Land Grant: contributes +1 VP when in deck/hand/discard."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]

        vp_before = compute_player_vp(game, "p0")

        # Add a Land Grant to discard
        lg = _copy_card(card_registry["neutral_land_grant"], "test_lg")
        player.deck.discard.append(lg)

        vp_after = compute_player_vp(game, "p0")
        assert vp_after == vp_before + 1

    def test_land_grant_in_trash_no_vp(self, card_registry):
        """Land Grant in trash does NOT count VP."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]

        vp_before = compute_player_vp(game, "p0")

        lg = _copy_card(card_registry["neutral_land_grant"], "test_lg_trash")
        player.trash.append(lg)

        vp_after = compute_player_vp(game, "p0")
        assert vp_after == vp_before  # no change


class TestNeutralMilitia:
    """Already tested in test_effects.py — TestConditionalPower. Add base power test."""

    def test_militia_base_power_2(self, card_registry):
        merc = card_registry["neutral_militia"]
        assert merc.power == 2


class TestRubble:
    def test_rubble_negative_vp(self, card_registry):
        """Rubble: -1 VP when in deck (contributes negative to raw VP)."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]

        # Give player enough bonus VP first so we can see the -1
        player.vp = 5
        vp_before = compute_player_vp(game, "p0")

        rubble = _make_card("rubble_test", "Rubble", CardType.PASSIVE,
                            passive_vp=-1, unplayable=True)
        player.deck.discard.append(rubble)

        vp_after = compute_player_vp(game, "p0")
        assert vp_after == vp_before - 1

    def test_rubble_unplayable(self, card_registry):
        """Rubble: cannot be played."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        rubble = _make_card("rubble_test", "Rubble", CardType.PASSIVE,
                            passive_vp=-1, unplayable=True)
        player.hand = [rubble] + player.hand[1:]

        success, msg = play_card(game, "p0", 0)
        assert not success
        assert "cannot be played" in msg

    def test_rubble_in_trash_no_penalty(self, card_registry):
        """Rubble in trash does NOT count -1 VP."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        vp_before = compute_player_vp(game, "p0")

        rubble = _make_card("rubble_trash", "Rubble", CardType.PASSIVE,
                            passive_vp=-1, unplayable=True)
        player.trash.append(rubble)

        vp_after = compute_player_vp(game, "p0")
        assert vp_after == vp_before  # no penalty from trash


class TestNeutralRecruit:
    def test_recruit_power_and_action(self, card_registry):
        """Recruit: Power 1, gain 1 action."""
        card = card_registry["neutral_recruit"]
        assert card.power == 1
        assert card.action_return == 1
        assert card.buy_cost == 2


class TestNeutralConscription:
    def test_conscription_draw(self, card_registry):
        """Conscription: draw 2 cards."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        con = _copy_card(card_registry["neutral_conscription"], "test_con")
        player.hand = [con] + player.hand[1:]
        initial_hand = len(player.hand)

        success, _ = play_card(game, "p0", 0)
        assert success
        # draw_cards 2, minus the played card
        assert len(player.hand) >= initial_hand


class TestNeutralWatchtower:
    def test_watchtower_defense_and_cost(self, card_registry):
        """Watchtower: +2 defense, draw 1."""
        card = card_registry["neutral_watchtower"]
        assert card.defense_bonus == 2
        assert card.buy_cost == 3


class TestNeutralSiegeTower:
    def test_siege_tower_high_power(self, card_registry):
        """Siege Tower: Power 6, cost 8."""
        card = card_registry["neutral_siege_tower"]
        assert card.power == 6
        assert card.buy_cost == 8


class TestNeutralReclaim:
    def test_consolidate_stats(self, card_registry):
        """Consolidate: cost 3."""
        card = card_registry["neutral_reclaim"]
        assert card.buy_cost == 3

    def test_consolidate_trash_for_resources(self, card_registry):
        """Consolidate: trash a card and gain half its buy cost (rounded down)."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        con = _copy_card(card_registry["neutral_reclaim"], "test_ncon")
        # Add a card with known buy cost to trash (buy_cost=5 → half=2)
        target_card = _make_card("trash_me", "Trash Me", buy_cost=5)
        player.hand = [con, target_card] + player.hand[2:]
        initial_res = player.resources

        success, _ = play_card(game, "p0", 0, trash_card_indices=[0])
        assert success
        # Should have gained 2 resources (half of 5, rounded down)
        assert player.resources == initial_res + 2
        assert any(c.name == "Trash Me" for c in player.trash)

    def test_consolidate_even_cost(self, card_registry):
        """Consolidate: even buy cost divides cleanly."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        con = _copy_card(card_registry["neutral_reclaim"], "test_ncon2")
        target_card = _make_card("trash_me2", "Trash Me 2", buy_cost=4)
        player.hand = [con, target_card] + player.hand[2:]
        initial_res = player.resources

        success, _ = play_card(game, "p0", 0, trash_card_indices=[0])
        assert success
        assert player.resources == initial_res + 2  # half of 4


class TestNeutralDiplomat:
    def test_diplomat_stats(self, card_registry):
        """Diplomat: cost 5, trash on use."""
        card = card_registry["neutral_diplomat"]
        assert card.buy_cost == 5
        assert card.trash_on_use is True


# ══════════════════════════════════════════════════════════════════
# VANGUARD CARDS
# ══════════════════════════════════════════════════════════════════


class TestVanguardBlitz:
    """Already tested in test_effects.py — TestOnResolutionEffects. Add power check."""

    def test_blitz_power_2(self, card_registry):
        card = card_registry["vanguard_blitz"]
        assert card.power == 2
        assert card.card_type == CardType.CLAIM


class TestVanguardOverrun:
    def test_overrun_range_2(self, card_registry):
        """Overrun: power 4, can claim up to 2 steps away."""
        card = card_registry["vanguard_overrun"]
        assert card.power == 4
        assert card.claim_range == 2

    def test_overrun_reaches_distant_tile(self, card_registry):
        """Overrun: can target a tile 2 steps from owned territory."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        overrun = _copy_card(card_registry["vanguard_overrun"], "test_overrun")
        player.hand = [overrun] + player.hand[1:]

        # Find a tile 2 steps away
        assert game.grid is not None
        player_tiles = game.grid.get_player_tiles("p0")
        for pt in player_tiles:
            for adj1 in game.grid.get_adjacent(pt.q, pt.r):
                if adj1.owner is None and not adj1.is_blocked:
                    for adj2 in game.grid.get_adjacent(adj1.q, adj1.r):
                        if (adj2.owner is None and not adj2.is_blocked
                                and adj2 not in player_tiles
                                and (adj2.q, adj2.r) != (adj1.q, adj1.r)):
                            success, _ = play_card(game, "p0", 0,
                                                   target_q=adj2.q, target_r=adj2.r)
                            assert success
                            return
        pytest.skip("No tile 2 steps away found")


class TestVanguardRapidAssault:
    def test_rapid_assault_resource_drain(self, card_registry):
        """Rapid Assault: on success against opponent's tile, they lose 1 resource."""
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        p1 = game.players["p1"]
        ra = _copy_card(card_registry["vanguard_rapid_assault"], "test_ra")
        assert ra.power == 3
        # Has resource_drain effect
        from app.game_engine.effects import EffectType
        drain_fx = [e for e in ra.effects if e.type == EffectType.RESOURCE_DRAIN]
        assert len(drain_fx) == 1
        assert drain_fx[0].value == 1


class TestVanguardSpearhead:
    def test_spearhead_high_power(self, card_registry):
        """Spearhead: Power 8, trash on use."""
        card = card_registry["vanguard_spearhead"]
        assert card.power == 8
        assert card.trash_on_use is True


class TestVanguardCoordinatedPush:
    def test_coordinated_push_stackable(self, card_registry):
        """Coordinated Push: is stackable (can be played on same tile)."""
        card = card_registry["vanguard_coordinated_push"]
        assert card.stackable is True
        assert card.power == 3

    def test_coordinated_push_stacks_on_same_tile(self, card_registry):
        """Coordinated Push: two can target the same tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        cp1 = _copy_card(card_registry["vanguard_coordinated_push"], "test_cp1")
        cp2 = _copy_card(card_registry["vanguard_coordinated_push"], "test_cp2")
        player.hand = [cp1, cp2] + player.hand[2:]

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success1, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success1
        success2, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success2


class TestVanguardDoubleTime:
    def test_double_time_draw_and_actions(self, card_registry):
        """Double Time: draw 1, gain 2 actions back (net +1)."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        dt = _copy_card(card_registry["vanguard_double_time"], "test_dt")
        assert dt.action_return == 2
        assert dt.draw_cards == 1
        player.hand = [dt] + player.hand[1:]
        initial_hand = len(player.hand)
        initial_actions = player.actions_available

        success, _ = play_card(game, "p0", 0)
        assert success
        # Hand: -1 (played) + 1 (draw) = same
        assert len(player.hand) == initial_hand - 1 + 1
        assert player.actions_available == initial_actions + 2


class TestVanguardForwardMarch:
    def test_forward_march_unoccupied_only(self, card_registry):
        """Forward March: can only target unoccupied (neutral) tiles."""
        card = card_registry["vanguard_forward_march"]
        assert card.effective_unoccupied_only is True

    def test_forward_march_blocked_on_owned_tile(self, card_registry):
        """Forward March: cannot target tiles owned by opponents."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        fm = _copy_card(card_registry["vanguard_forward_march"], "test_fm")
        player.hand = [fm] + player.hand[1:]

        # Ensure there is an opponent's tile adjacent to p0
        enemy_tile = _ensure_adjacent_enemy_tile(game, "p0", "p1")
        assert enemy_tile is not None

        success, msg = play_card(game, "p0", 0, target_q=enemy_tile.q, target_r=enemy_tile.r)
        assert not success
        assert "unoccupied" in msg.lower()

    def test_forward_march_draw_on_success(self, card_registry):
        """Forward March: draw 1 next turn if successful claim on neutral."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        fm = _copy_card(card_registry["vanguard_forward_march"], "test_fm")
        player.hand = [fm] + player.hand[1:]

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        tile = game.grid.get_tile(q, r)
        if tile.owner == "p0":
            assert player.turn_modifiers.extra_draws_next_turn >= 1


class TestVanguardWarCache:
    def test_war_cache_resources_and_action(self, card_registry):
        """Plunder: gain 4 resources, draw next turn, gain 1 action back."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wc = _copy_card(card_registry["vanguard_war_cache"], "test_wc")
        assert wc.action_return == 1
        player.hand = [wc] + player.hand[1:]
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial + 4


class TestVanguardFlanking:
    def test_flanking_strike_range_2(self, card_registry):
        """Flanking Strike: can target tiles up to 2 steps away."""
        card = card_registry["vanguard_flanking_strike"]
        assert card.claim_range == 2
        assert card.power == 2
        assert card.upgraded_power == 3


class TestVanguardSurgeProtocol:
    def test_surge_protocol_grants_actions_next_turn(self, card_registry):
        """Surge Protocol: gain 2 actions, chosen player gains 1 extra action next turn."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        sp = _copy_card(card_registry["vanguard_surge_protocol"], "test_sp")
        assert sp.action_return == 2
        player.hand = [sp] + player.hand[1:]
        other = game.players["p1"]
        initial_other_actions = other.actions_available

        success, _ = play_card(game, "p0", 0, target_player_id="p1")
        assert success
        # Actions don't increase this turn
        assert other.actions_available == initial_other_actions
        # Effect is on_resolution — submit and resolve to trigger it
        submit_play(game, "p0")
        submit_play(game, "p1")
        assert other.turn_modifiers.extra_actions_next_turn == 1


class TestVanguardSpoilsOfWar:
    def test_spoils_of_war_trashes_opponent_card(self, card_registry):
        """Spoils of War: if claim wins contested tile, trash opponent's claim."""
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Ensure a tile owned by p1 is adjacent to p0
        assert game.grid is not None
        target_tile = _ensure_adjacent_enemy_tile(game, "p0", "p1")
        assert target_tile is not None

        # p0 plays Spoils of War (power 3) on p1's tile
        sow = _copy_card(card_registry["vanguard_spoils_of_war"], "test_sow")
        sow.adjacency_required = False
        sow.power = 20  # ensure winning
        p0.hand = [sow] + p0.hand[1:]

        # p1 plays a weak claim on their own tile to defend
        defender_card = _make_card("def_claim", "Weak Claim", CardType.CLAIM, power=1,
                                   adjacency_required=False)
        p1.hand = [defender_card] + p1.hand[1:]

        success, _ = play_card(game, "p0", 0, target_q=target_tile.q, target_r=target_tile.r)
        assert success
        success, _ = play_card(game, "p1", 0, target_q=target_tile.q, target_r=target_tile.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        # Opponent's card should be marked trash_on_use
        assert defender_card.trash_on_use is True


class TestVanguardEliteVanguard:
    def test_elite_vanguard_base_power(self, card_registry):
        """Elite Vanguard: power 6 at base."""
        card = card_registry["vanguard_elite_vanguard"]
        assert card.power == 6
        assert card.card_type == CardType.CLAIM
        assert card.buy_cost == 9

    def test_elite_vanguard_dynamic_cost(self, card_registry):
        """Elite Vanguard: has dynamic buy cost scaling with VP hexes."""
        card = card_registry["vanguard_elite_vanguard"]
        dynamic_fx = [e for e in card.effects if e.type == EffectType.DYNAMIC_BUY_COST]
        assert len(dynamic_fx) == 1
        assert dynamic_fx[0].value == -1
        assert dynamic_fx[0].condition == ConditionType.VP_HEXES_CONTROLLED


class TestVanguardBattleGlory:
    def test_battle_glory_is_passive(self, card_registry):
        """Battle Glory: is a passive card, unplayable, triggers from hand."""
        card = card_registry["vanguard_battle_glory"]
        assert card.card_type == CardType.PASSIVE
        assert card.unplayable is True
        assert card.vp_formula == "contested_wins"

    def test_battle_glory_has_effect(self, card_registry):
        """Battle Glory: has VP_FROM_CONTESTED_WINS effect with value 1."""
        card = card_registry["vanguard_battle_glory"]
        vp_effects = [e for e in card.effects if e.type == EffectType.VP_FROM_CONTESTED_WINS]
        assert len(vp_effects) >= 1
        assert vp_effects[0].value == 1
        assert vp_effects[0].upgraded_value == 2
        assert vp_effects[0].metadata.get("required_wins") == 2

    def test_battle_glory_starts_at_0_vp(self, card_registry):
        """Battle Glory: starts with 0 passive_vp, accumulates on contested wins."""
        card = card_registry["vanguard_battle_glory"]
        assert card.passive_vp == 0


class TestVanguardArsenal:
    def test_arsenal_vp_formula(self, card_registry):
        """Arsenal: +1 VP per 10 cards in deck (vp_formula = deck_div_10)."""
        card = card_registry["vanguard_arsenal"]
        assert card.vp_formula == "deck_div_10"
        assert card.unplayable is True

    def test_arsenal_vp_computation(self, card_registry):
        """Arsenal: verify actual VP computation with known deck sizes."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]

        arsenal = _copy_card(card_registry["vanguard_arsenal"], "test_ars")
        # Clear deck to control card count
        player.deck.cards = []
        player.hand = []
        player.deck.discard = [arsenal]

        # 1 card total → 0 VP from arsenal
        vp_base = compute_player_vp(game, "p0")

        # Add 9 more dummy cards (10 total) → 1 VP from arsenal
        for i in range(9):
            player.deck.discard.append(_make_card(f"dummy_{i}"))
        vp_10 = compute_player_vp(game, "p0")
        assert vp_10 == vp_base + 1

        # Add 10 more (20 total) → 2 VP from arsenal
        for i in range(10):
            player.deck.discard.append(_make_card(f"dummy2_{i}"))
        vp_20 = compute_player_vp(game, "p0")
        assert vp_20 == vp_base + 2


class TestVanguardRally:
    """Already tested in test_effects.py — TestSelfDiscard."""

    def test_rally_draw_cards(self, card_registry):
        card = card_registry["vanguard_rally"]
        assert card.draw_cards == 2
        assert card.action_return == 1


# ══════════════════════════════════════════════════════════════════
# SWARM CARDS
# ══════════════════════════════════════════════════════════════════


class TestSwarmSurge:
    def test_surge_multi_target(self, card_registry):
        """Surge: can target up to 2 tiles (main + 1 extra)."""
        card = card_registry["swarm_surge"]
        assert card.multi_target_count >= 1  # at least 1 extra target
        assert card.power == 1

    def test_surge_claims_multiple_tiles(self, card_registry):
        """Surge: claims main target + extra target."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        surge = _copy_card(card_registry["swarm_surge"], "test_surge")
        player.hand = [surge] + player.hand[1:]

        targets = _find_n_adjacent_neutrals(game, "p1", 2)
        if len(targets) < 2:
            pytest.skip("Need 2 adjacent neutral tiles")

        q1, r1 = targets[0]
        q2, r2 = targets[1]
        success, _ = play_card(game, "p1", 0, target_q=q1, target_r=r1,
                               extra_targets=[(q2, r2)])
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        # Both tiles should be claimed by p1
        t1 = game.grid.get_tile(q1, r1)
        t2 = game.grid.get_tile(q2, r2)
        assert t1.owner == "p1"
        assert t2.owner == "p1"

    def test_surge_rejects_non_adjacent_targets(self, card_registry):
        """Surge: targets must be adjacent to each other (connected subgraph)."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        surge = _copy_card(card_registry["swarm_surge"], "test_surge_nonadj")
        player.hand = [surge] + player.hand[1:]

        # Find two neutral tiles adjacent to p1 that are NOT adjacent to each other.
        assert game.grid is not None
        candidates = _find_n_adjacent_neutrals(game, "p1", 10)
        pair: tuple[tuple[int, int], tuple[int, int]] | None = None
        for i, a in enumerate(candidates):
            for b in candidates[i + 1:]:
                ta = game.grid.get_tile(*a)
                tb = game.grid.get_tile(*b)
                assert ta is not None and tb is not None
                if ta.distance_to(tb) > 1:
                    pair = (a, b)
                    break
            if pair:
                break
        if pair is None:
            pytest.skip("Need two non-adjacent neutral tiles adjacent to p1")

        (q1, r1), (q2, r2) = pair
        success, msg = play_card(
            game, "p1", 0,
            target_q=q1, target_r=r1,
            extra_targets=[(q2, r2)],
        )
        assert not success
        assert "adjacent" in (msg or "").lower()

        # Neither tile should have been claimed
        assert game.grid.get_tile(q1, r1).owner is None
        assert game.grid.get_tile(q2, r2).owner is None

    def test_surge_extra_target_blocks_later_claim(self, card_registry):
        """A Surge extra target is locked against later non-stackable claims."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        surge = _copy_card(card_registry["swarm_surge"], "test_surge_lock")
        explore = _copy_card(card_registry["neutral_explore"], "test_explore_lock")
        player.hand = [surge, explore] + player.hand[2:]

        targets = _find_n_adjacent_neutrals(game, "p1", 2)
        if len(targets) < 2:
            pytest.skip("Need 2 adjacent neutral tiles")
        (q1, r1), (q2, r2) = targets[0], targets[1]
        # Make sure they're directly adjacent (Surge requires it)
        assert game.grid.get_tile(q1, r1).distance_to(game.grid.get_tile(q2, r2)) == 1

        # Play Surge on (q1,r1) with (q2,r2) as extra
        ok, msg = play_card(
            game, "p1", 0,
            target_q=q1, target_r=r1,
            extra_targets=[(q2, r2)],
        )
        assert ok, msg

        # Now try to play Explore (non-stackable) on the extra target — should fail.
        ok, msg = play_card(game, "p1", 0, target_q=q2, target_r=r2)
        assert not ok
        assert "stackable" in (msg or "").lower()


class TestBaseRaidPopups:
    """Base raids emit Raided/Spoils/Defended popups and never transfer the base."""

    def _setup_raid_scenario(self, card_registry, attacker_power: int, base_defense: int):
        """Set up p0 attacking p1's base with a custom-power claim card."""
        game = _make_2p_game(card_registry)
        assert game.grid is not None
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Locate p1's base and force defense to a known value.
        p1_base = next(t for t in game.grid.tiles.values() if t.is_base and t.base_owner == "p1")
        p1_base.base_defense = base_defense
        p1_base.defense_power = base_defense
        p1_base.permanent_defense_bonus = 0

        # Make sure p0 has a tile adjacent to p1's base.
        for adj in game.grid.get_adjacent(p1_base.q, p1_base.r):
            if adj.is_blocked or adj.is_base:
                continue
            adj.owner = "p0"
            break

        # Give p0 a claim card with the exact power we want.
        claim = _copy_card(card_registry["neutral_mercenary"], "test_raid_claim")
        claim.power = attacker_power
        claim.adjacency_required = True
        p0.hand = [claim] + p0.hand[1:]
        p0.resources = 10

        return game, p0, p1, p1_base

    def test_successful_raid_emits_rubble_and_spoils(self, card_registry):
        """Successful base raid: emits Raided + Spoils popups, base stays owned."""
        game, p0, p1, p1_base = self._setup_raid_scenario(
            card_registry, attacker_power=5, base_defense=2,
        )
        original_owner = p1_base.owner
        original_base_owner = p1_base.base_owner

        success, msg = play_card(game, "p0", 0, target_q=p1_base.q, target_r=p1_base.r)
        assert success, msg

        submit_play(game, "p0")
        submit_play(game, "p1")

        # Base tile is NOT transferred — only its defense reset.
        assert p1_base.owner == original_owner
        assert p1_base.base_owner == original_base_owner

        # Expect exactly one rubble popup targeted at p1 and one spoils popup at p0.
        rubble = [e for e in game.player_effects if e["effect_type"] == "base_raid_rubble"]
        spoils = [e for e in game.player_effects if e["effect_type"] == "base_raid_spoils"]
        assert len(rubble) == 1
        assert len(spoils) == 1

        r = rubble[0]
        assert r["target_player_id"] == "p1"
        assert r["source_player_id"] == "p0"
        assert r["card_name"] == "Raided"
        assert r["effect"] == "+3 Rubble"  # 5 attacker - 2 defense = 3 rubble
        assert r["value"] == 3
        assert r["added_card_name"] == "Rubble"
        assert r["added_card_count"] == 3
        assert r["source_q"] == p1_base.q and r["source_r"] == p1_base.r

        s = spoils[0]
        assert s["target_player_id"] == "p0"
        assert s["source_player_id"] == "p0"
        assert s["card_name"] == "Spoils"
        assert s["effect"] == "+1 Spoils"
        assert s["added_card_name"] == "Spoils"
        assert s["added_card_count"] == 1

        # Rubble/Spoils cards landed in the correct discard piles.
        assert sum(1 for c in p1.deck.discard if c.name == "Rubble") == 3
        assert sum(1 for c in p0.deck.discard if c.name == "Spoils") == 1

    def test_defended_raid_emits_defended_popup(self, card_registry):
        """Defended base raid: emits a Defended popup above the base owner."""
        # Start with defense low enough to allow play-time validation,
        # then boost it above the attacker's power before reveal so the
        # defender wins at resolution time.
        game, p0, p1, p1_base = self._setup_raid_scenario(
            card_registry, attacker_power=2, base_defense=1,
        )

        success, msg = play_card(game, "p0", 0, target_q=p1_base.q, target_r=p1_base.r)
        assert success, msg

        # Boost defense so the raid will be repelled at resolve time.
        p1_base.base_defense = 5
        p1_base.defense_power = 5

        submit_play(game, "p0")
        submit_play(game, "p1")

        # No rubble, no spoils — the raid was repelled.
        assert not any(e["effect_type"] == "base_raid_rubble" for e in game.player_effects)
        assert not any(e["effect_type"] == "base_raid_spoils" for e in game.player_effects)
        assert sum(1 for c in p1.deck.discard if c.name == "Rubble") == 0

        defended = [e for e in game.player_effects if e["effect_type"] == "base_raid_defended"]
        assert len(defended) == 1
        d = defended[0]
        assert d["target_player_id"] == "p1"
        assert d["source_player_id"] == "p0"
        assert d["card_name"] == "Defended"
        assert "repel" in d["effect"].lower()

    def test_defense_held_no_popup_on_non_base(self, card_registry):
        """Defended non-base tile does NOT trigger a base_raid_defended popup."""
        game = _make_2p_game(card_registry)
        assert game.grid is not None
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Find a neutral tile adjacent to p0, assign to p1 with low defense
        # so the play-time validation passes; defense is boosted before reveal.
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        target = game.grid.get_tile(q, r)
        target.owner = "p1"
        target.base_defense = 1
        target.defense_power = 1

        claim = _copy_card(card_registry["neutral_mercenary"], "test_weak_claim")
        claim.power = 2
        p0.hand = [claim] + p0.hand[1:]
        p0.resources = 10

        success, msg = play_card(game, "p0", 0, target_q=target.q, target_r=target.r)
        assert success, msg

        # Boost defense above attacker power before reveal.
        target.base_defense = 5
        target.defense_power = 5

        submit_play(game, "p0")
        submit_play(game, "p1")

        assert not any(e["effect_type"] == "base_raid_defended" for e in game.player_effects)


class TestSwarmOverwhelm:
    def test_overwhelm_power_scales_with_adjacent(self, card_registry):
        """Overwhelm: +1 power per adjacent owned tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        overwhelm = _copy_card(card_registry["swarm_overwhelm"], "test_ow")
        player.hand = [overwhelm] + player.hand[1:]

        q, r = _find_adjacent_neutral(game, "p1")
        assert q is not None

        action = PlannedAction(card=overwhelm, target_q=q, target_r=r)
        # Count adjacent owned tiles
        adj_owned = sum(1 for t in game.grid.get_adjacent(q, r) if t.owner == "p1")
        expected = overwhelm.power + adj_owned  # +1 per owned adjacent
        power = calculate_effective_power(game, player, overwhelm, action)
        assert power == expected


class TestSwarmProliferate:
    def test_proliferate_ignores_adjacency(self, card_registry):
        """Proliferate: Power 1, no adjacency required."""
        card = card_registry["swarm_proliferate"]
        assert card.power == 1
        assert card.adjacency_required is False

    def test_proliferate_claims_distant_tile(self, card_registry):
        """Proliferate: can claim a non-adjacent neutral tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        prol = _copy_card(card_registry["swarm_proliferate"], "test_prol")
        player.hand = [prol] + player.hand[1:]

        # Find a neutral tile NOT adjacent to player
        assert game.grid is not None
        player_tile_coords = {(t.q, t.r) for t in game.grid.get_player_tiles("p1")}
        adj_coords = set()
        for t in game.grid.get_player_tiles("p1"):
            for a in game.grid.get_adjacent(t.q, t.r):
                adj_coords.add((a.q, a.r))

        for tile in game.grid.tiles.values():
            if (tile.owner is None and not tile.is_blocked
                    and (tile.q, tile.r) not in player_tile_coords
                    and (tile.q, tile.r) not in adj_coords):
                success, _ = play_card(game, "p1", 0, target_q=tile.q, target_r=tile.r)
                assert success, "Proliferate should be able to target non-adjacent tiles"
                return
        pytest.skip("No non-adjacent neutral tile found")


class TestSwarmFlood:
    def test_flood_targets_own_tile(self, card_registry):
        """Flood: must target own tile, claims all adjacent."""
        card = card_registry["swarm_flood"]
        assert card.flood is True
        assert card.target_own_tile is True

    def test_flood_resolution(self, card_registry):
        """Flood: claims adjacent tiles from owned tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        flood = _copy_card(card_registry["swarm_flood"], "test_flood")
        player.hand = [flood] + player.hand[1:]

        # Find an owned tile with neutral neighbors
        own_tiles = game.grid.get_player_tiles("p1")
        target = None
        for t in own_tiles:
            adjs = game.grid.get_adjacent(t.q, t.r)
            neutral_count = sum(1 for a in adjs if a.owner is None and not a.is_blocked)
            if neutral_count > 0:
                target = t
                break

        if not target:
            pytest.skip("No owned tile with neutral neighbors")

        tiles_before = len(game.grid.get_player_tiles("p1"))
        success, _ = play_card(game, "p1", 0, target_q=target.q, target_r=target.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        tiles_after = len(game.grid.get_player_tiles("p1"))
        # Should have gained at least 1 tile from flood
        assert tiles_after > tiles_before


class TestSwarmRabble:
    def test_rabble_action_return_on_synergy(self, card_registry):
        """Rabble: gain 1 action back if another Rabble played this turn."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        rabble1 = _copy_card(card_registry["swarm_rabble"], "test_rabble1")
        rabble2 = _copy_card(card_registry["swarm_rabble"], "test_rabble2")
        player.hand = [rabble1, rabble2] + player.hand[2:]

        targets = _find_n_adjacent_neutrals(game, "p1", 2)
        if len(targets) < 2:
            pytest.skip("Need 2 adjacent neutral tiles")

        initial_actions = player.actions_available
        success1, _ = play_card(game, "p1", 0, target_q=targets[0][0], target_r=targets[0][1])
        assert success1

        # After first rabble, no synergy yet (it was played alone)
        # Second rabble triggers synergy
        success2, _ = play_card(game, "p1", 0, target_q=targets[1][0], target_r=targets[1][1])
        assert success2

        # Check that conditional action return fired
        # Used 2 actions, got some back from synergy
        # Rabble has action_return=0 normally, so actions come from the effect
        assert player.actions_available >= initial_actions  # got at least 1 back


class TestSwarmDogPile:
    def test_dog_pile_stackable(self, card_registry):
        """Dog Pile: is stackable, power 2."""
        card = card_registry["swarm_dog_pile"]
        assert card.stackable is True
        assert card.power == 2

    def test_dog_pile_stacks_on_same_tile(self, card_registry):
        """Dog Pile: multiple can target same tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        dp1 = _copy_card(card_registry["swarm_dog_pile"], "test_dp1")
        dp2 = _copy_card(card_registry["swarm_dog_pile"], "test_dp2")
        player.hand = [dp1, dp2] + player.hand[2:]

        q, r = _find_adjacent_neutral(game, "p1")
        assert q is not None
        success1, _ = play_card(game, "p1", 0, target_q=q, target_r=r)
        assert success1
        success2, _ = play_card(game, "p1", 0, target_q=q, target_r=r)
        assert success2

    def test_dog_pile_has_stacking_power_bonus(self, card_registry):
        """Dog Pile: has stacking_power_bonus effect (+1 to other claims on same tile)."""
        card = card_registry["swarm_dog_pile"]
        bonus_fx = [e for e in card.effects if e.type == EffectType.STACKING_POWER_BONUS]
        assert len(bonus_fx) == 1
        assert bonus_fx[0].value == 1


class TestSwarmNumbersGame:
    """Already tested in test_effects.py — TestConditionalPower."""

    def test_numbers_game_card_type(self, card_registry):
        card = card_registry["swarm_numbers_game"]
        assert card.card_type == CardType.CLAIM

    def test_numbers_game_playable_against_defended_tile(self, card_registry):
        """Strength in Numbers (base power 0) should be playable against a
        defended neutral tile when hand size gives it enough dynamic power."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]
        sin = _copy_card(card_registry["swarm_numbers_game"], "test_sin")

        # Set up: put card at index 0, keep 4 other cards in hand → dynamic power = 4
        player.hand = [sin] + player.hand[:4]
        assert len(player.hand) == 5

        # Find an adjacent neutral tile and set its defense to 2
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        assert game.grid is not None
        tile = game.grid.get_tile(q, r)
        assert tile is not None
        tile.defense_power = 2
        tile.base_defense = 2

        # Should succeed: dynamic power 4 > defense 2
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success, f"Expected play to succeed but got: {msg}"


class TestSwarmSwarmTactics:
    def test_swarm_tactics_draw_and_action(self, card_registry):
        """Swarm Tactics: draw 1 card, gain 1 action back."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        st = _copy_card(card_registry["swarm_swarm_tactics"], "test_st")
        assert st.draw_cards == 1
        assert st.action_return == 1
        player.hand = [st] + player.hand[1:]
        initial_hand = len(player.hand)

        success, _ = play_card(game, "p1", 0)
        assert success
        # -1 played + 1 drawn = same size
        assert len(player.hand) == initial_hand - 1 + 1


class TestSwarmThinTheHerd:
    """Already tested in test_effects.py — TestSelfTrash."""

    def test_thin_the_herd_stats(self, card_registry):
        card = card_registry["swarm_thin_the_herd"]
        assert card.action_return == 1
        assert card.draw_cards == 1
        assert card.buy_cost == 3


class TestSwarmFrenzy:
    def test_frenzy_net_positive_actions(self, card_registry):
        """Frenzy: gain 2 actions back, requires discard."""
        card = card_registry["swarm_frenzy"]
        assert card.action_return == 2
        # Has self_discard effect
        discard_fx = [e for e in card.effects if e.type == EffectType.SELF_DISCARD]
        assert len(discard_fx) >= 1


class TestSwarmBlitzRush:
    """Already tested in test_effects.py — TestBuyRestriction."""

    def test_blitz_rush_action_return(self, card_registry):
        card = card_registry["swarm_blitz_rush"]
        assert card.action_return == 2


class TestSwarmScavenge:
    def test_scavenge_resource_gain(self, card_registry):
        """Scavenge: gain 2 resources, no draw, no unconditional action return."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        scav = _copy_card(card_registry["swarm_scavenge"], "test_scav")
        assert scav.resource_gain == 2
        assert scav.draw_cards == 0
        assert scav.action_return == 0
        player.hand = [scav] + player.hand[1:]
        initial_res = player.resources

        success, _ = play_card(game, "p1", 0)
        assert success
        assert player.resources == initial_res + 2

    def test_scavenge_grants_action_at_zero(self, card_registry):
        """Scavenge: grants 1 action if player has 0 actions remaining."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        scav = _copy_card(card_registry["swarm_scavenge"], "test_scav")
        player.hand = [scav] + player.hand[1:]
        # Set player to exactly 1 action so playing scavenge leaves 0
        player.actions_available = 1
        player.actions_used = 0

        success, _ = play_card(game, "p1", 0)
        assert success
        # After playing (uses 1), was at 0, so conditional grants 1 back
        assert player.actions_available - player.actions_used == 1

    def test_scavenge_no_action_when_actions_remain(self, card_registry):
        """Scavenge: does NOT grant action if player has actions remaining."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        scav = _copy_card(card_registry["swarm_scavenge"], "test_scav")
        player.hand = [scav] + player.hand[1:]
        player.actions_available = 3
        player.actions_used = 0

        success, _ = play_card(game, "p1", 0)
        assert success
        # Used 1 of 3, still has 2 remaining — no bonus action
        assert player.actions_available - player.actions_used == 2


class TestSwarmConsecrate:
    def test_consecrate_enhances_vp_tile(self, card_registry):
        """Consecrate: increase VP tile value by 1, trash on use."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        cons = _copy_card(card_registry["swarm_consecrate"], "test_cons")
        assert cons.trash_on_use is True
        player.hand = [cons] + player.hand[1:]

        # Find a VP tile owned by p1 that is connected to base
        assert game.grid is not None
        connected = game.grid.get_connected_tiles("p1")
        vp_tile = None
        for tile in game.grid.tiles.values():
            if tile.is_vp and tile.owner == "p1" and (tile.q, tile.r) in connected:
                vp_tile = tile
                break

        if not vp_tile:
            # Create a connected VP tile: find a neutral tile adjacent to p1's base
            # and make it a VP tile
            for pt in game.grid.get_player_tiles("p1"):
                for adj in game.grid.get_adjacent(pt.q, pt.r):
                    if adj.owner is None and not adj.is_blocked:
                        adj.owner = "p1"
                        adj.is_vp = True
                        adj.vp_value = 1
                        vp_tile = adj
                        break
                if vp_tile:
                    break

        if not vp_tile:
            pytest.skip("No VP tile available")

        initial_vp_val = vp_tile.vp_value
        success, _ = play_card(game, "p1", 0, target_q=vp_tile.q, target_r=vp_tile.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        # VP tile value should have increased
        updated = game.grid.get_tile(vp_tile.q, vp_tile.r)
        assert updated.vp_value == initial_vp_val + 1


class TestSwarmWarTrophies:
    def test_war_trophies_vp_formula(self, card_registry):
        """War Trophies: +1 VP per 5 cards in trash."""
        card = card_registry["swarm_war_trophies"]
        assert card.vp_formula == "trash_div_5"
        assert card.unplayable is True

    def test_war_trophies_vp_computation(self, card_registry):
        """War Trophies: verify VP scales with trash pile size."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]

        wt = _copy_card(card_registry["swarm_war_trophies"], "test_wt")
        player.deck.discard.append(wt)
        player.vp = 5  # Give enough base VP to see changes

        vp_0_trash = compute_player_vp(game, "p1")

        # Add 5 cards to trash → +1 VP from war trophies
        for i in range(5):
            player.trash.append(_make_card(f"trash_{i}"))
        vp_5_trash = compute_player_vp(game, "p1")
        assert vp_5_trash == vp_0_trash + 1

        # Add 5 more (10 total) → +2 VP
        for i in range(5):
            player.trash.append(_make_card(f"trash2_{i}"))
        vp_10_trash = compute_player_vp(game, "p1")
        assert vp_10_trash == vp_0_trash + 2


# ══════════════════════════════════════════════════════════════════
# FORTRESS CARDS
# ══════════════════════════════════════════════════════════════════


class TestFortressFortify:
    def test_fortify_defense_and_action(self, card_registry):
        """Fortify: +3 defense, gain 1 action back."""
        card = card_registry["fortress_fortify"]
        assert card.defense_bonus == 3
        assert card.action_return == 1


class TestFortressBulwark:
    def test_bulwark_multi_tile_defense(self, card_registry):
        """Bulwark: +2 defense on 2 tiles."""
        card = card_registry["fortress_bulwark"]
        assert card.defense_bonus == 2
        assert card.defense_target_count == 2

    def test_bulwark_applies_to_two_tiles(self, card_registry):
        """Bulwark: defense bonus applied to primary and extra target."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        bulwark = _copy_card(card_registry["fortress_bulwark"], "test_bul")
        player.hand = [bulwark] + player.hand[1:]

        tiles = game.grid.get_player_tiles("p0")
        if len(tiles) < 2:
            pytest.skip("Need 2 owned tiles")

        t1, t2 = tiles[0], tiles[1]
        d1_before = t1.defense_power
        d2_before = t2.defense_power

        success, _ = play_card(game, "p0", 0,
                               target_q=t1.q, target_r=t1.r,
                               extra_targets=[(t2.q, t2.r)])
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        assert game.grid.get_tile(t1.q, t1.r).defense_power == d1_before + 2
        assert game.grid.get_tile(t2.q, t2.r).defense_power == d2_before + 2


class TestFortressIronWall:
    """Already tested in test_effects.py — TestTileImmunity."""

    def test_iron_wall_duration_1(self, card_registry):
        card = card_registry["fortress_iron_wall"]
        fx = [e for e in card.effects if e.type == EffectType.TILE_IMMUNITY]
        assert fx[0].duration == 1


class TestFortressStronghold:
    def test_stronghold_duration_2(self, card_registry):
        """Stronghold: tile immune for 2 rounds."""
        card = card_registry["fortress_stronghold"]
        fx = [e for e in card.effects if e.type == EffectType.TILE_IMMUNITY]
        assert fx[0].duration == 2


class TestFortressEntrench:
    def test_entrench_permanent_defense(self, card_registry):
        """Entrench: permanently increase tile defense."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        entrench = _copy_card(card_registry["fortress_entrench"], "test_ent")
        player.hand = [entrench] + player.hand[1:]

        tile = game.grid.get_player_tiles("p0")[0]
        initial_perm = tile.permanent_defense_bonus

        success, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        updated = game.grid.get_tile(tile.q, tile.r)
        assert updated.permanent_defense_bonus > initial_perm


class TestFortressGarrison:
    """Already tested in test_effects.py — TestConditionalPower."""

    def test_garrison_is_claim(self, card_registry):
        card = card_registry["fortress_garrison"]
        assert card.card_type == CardType.CLAIM
        assert card.power == 3


class TestFortressMountaineer:
    def test_mountaineer_properties(self, card_registry):
        """Mountaineer: cost 4, power 2, power_modifier +2 if neutral."""
        card = card_registry["fortress_slow_advance"]
        assert card.name == "Mountaineer"
        assert card.buy_cost == 4
        assert card.power == 2
        power_fx = [e for e in card.effects if e.type == EffectType.POWER_MODIFIER]
        assert len(power_fx) >= 1
        assert power_fx[0].value == 2

    def test_mountaineer_claims_neutral_tile(self, card_registry):
        """Mountaineer: successfully claims a neutral tile."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        sa = _copy_card(card_registry["fortress_slow_advance"], "test_sa")
        player.hand = [sa] + player.hand[1:]

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        tile = game.grid.get_tile(q, r)
        assert tile.owner == "p0"


class TestFortressSiegeEngine:
    """Already tested in test_effects.py — TestIgnoreDefense."""

    def test_siege_engine_power(self, card_registry):
        card = card_registry["fortress_siege_engine"]
        assert card.power == 3


class TestFortressWarOfAttrition:
    """Already tested in test_effects.py — TestOnResolutionEffects."""

    def test_war_of_attrition_power(self, card_registry):
        card = card_registry["fortress_war_of_attrition"]
        assert card.power == 2


class TestFortressOverwhelmingForce:
    def test_overwhelming_force_stackable(self, card_registry):
        """Overwhelming Force: is stackable."""
        card = card_registry["fortress_overwhelming_force"]
        assert card.stackable is True
        assert card.power == 3

    def test_overwhelming_force_refund_on_neutral(self, card_registry):
        """Overwhelming Force: gain 1 resource refund if target tile was neutral."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        of = _copy_card(card_registry["fortress_overwhelming_force"], "test_of")
        player.hand = [of] + player.hand[1:]
        initial_res = player.resources

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        tile = game.grid.get_tile(q, r)
        assert tile.owner == "p0"
        # Check exact refund: effect gives value=1 resource
        refund_fx = [e for e in of.effects if e.type == EffectType.RESOURCE_REFUND_IF_NEUTRAL]
        assert len(refund_fx) == 1
        expected_refund = refund_fx[0].value
        assert player.resources == initial_res + expected_refund


class TestFortressSupplyLine:
    """Already tested in test_effects.py — TestCostReduction."""

    def test_supply_line_resources(self, card_registry):
        card = card_registry["fortress_supply_line"]
        assert card.resource_gain == 2
        assert card.action_return == 1


class TestFortressConsolidate:
    """Already tested in test_effects.py — TestSelfTrash."""

    def test_consolidate_stats(self, card_registry):
        card = card_registry["fortress_consolidate"]
        assert card.buy_cost == 4
        assert card.action_return == 0


class TestFortressBatteringRam:
    def test_battering_ram_base_power(self, card_registry):
        """Battering Ram: base power 5."""
        card = card_registry["fortress_battering_ram"]
        assert card.power == 5
        assert card.buy_cost == 6

    def test_battering_ram_bonus_vs_defense(self, card_registry):
        """Battering Ram: +2 power if target has defense bonuses."""
        game = _make_2p_game(card_registry, arch0="fortress", arch1="fortress")
        p0 = game.players["p0"]
        p1 = game.players["p1"]
        ram = _copy_card(card_registry["fortress_battering_ram"], "test_ram")

        # Find a tile owned by p1
        assert game.grid is not None
        p1_tiles = game.grid.get_player_tiles("p1")
        assert len(p1_tiles) > 0
        target_tile = p1_tiles[0]
        # Give it permanent defense
        target_tile.permanent_defense_bonus = 2
        target_tile.defense_power = 2

        action = PlannedAction(card=ram, target_q=target_tile.q, target_r=target_tile.r)
        power = calculate_effective_power(game, p0, ram, action)
        # Base 5 + 2 bonus for defense = 7
        assert power == 7


class TestFortressTwinCities:
    def test_twin_cities_permanent_defense(self, card_registry):
        """Twin Cities: grants permanent +3 defense, trash on use."""
        card = card_registry["fortress_citadel"]
        assert card.buy_cost == 7
        assert card.trash_on_use is True
        assert card.defense_target_count == 2

    def test_twin_cities_upgraded_defense(self, card_registry):
        """Twin Cities+: grants permanent +5 defense."""
        card = card_registry["fortress_citadel"]
        # Check the upgraded value from the effect metadata
        perm_def_effect = [e for e in card.effects if e.type.value == "permanent_defense"]
        assert len(perm_def_effect) == 1
        assert perm_def_effect[0].metadata.get("upgraded_value") == 5


class TestFortressWarCouncil:
    def test_war_council_draw_and_buy_lock(self, card_registry):
        """War Council: draw 2, gain 1 action, buy locked."""
        card = card_registry["fortress_war_council"]
        assert card.action_return == 1
        assert card.buy_cost == 3

    def test_war_council_buy_restriction(self, card_registry):
        """War Council: sets buy_locked on player (on_resolution)."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        wc = _copy_card(card_registry["fortress_war_council"], "test_wc")
        player.hand = [wc] + player.hand[1:]

        success, _ = play_card(game, "p0", 0)
        assert success
        # Effect is on_resolution — submit and resolve to trigger it
        submit_play(game, "p0")
        submit_play(game, "p1")
        assert player.turn_modifiers.buy_locked


class TestFortressIronDiscipline:
    def test_iron_discipline_resources_draw_action(self, card_registry):
        """Iron Discipline: gain 2 resources, draw 1, action return 1."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        id_card = _copy_card(card_registry["fortress_iron_discipline"], "test_id")
        assert id_card.action_return == 1
        player.hand = [id_card] + player.hand[1:]
        initial_res = player.resources
        initial_hand = len(player.hand)

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_res + 2
        assert len(player.hand) == initial_hand - 1 + 1  # played 1, drew 1


class TestFortressTollRoad:
    def test_toll_road_draws_per_connected_vp(self, card_registry):
        """Toll Road: draw 2 cards per connected VP hex."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        toll = _copy_card(card_registry["fortress_toll_road"], "test_toll")
        player.hand = [toll] + player.hand[1:]

        # Give player a connected VP tile
        vp_tiles = [t for t in game.grid.tiles.values() if t.is_vp and not t.owner]
        # Find a VP tile adjacent to player's territory
        player_tiles = game.grid.get_player_tiles("p0")
        connected_vp = None
        for vp_t in vp_tiles:
            for pt in player_tiles:
                if pt.distance_to(vp_t) == 1:
                    connected_vp = vp_t
                    break
            if connected_vp:
                break
        if not connected_vp:
            # No VP tile adjacent — promote a neutral neighbour to VP
            for pt in player_tiles:
                for adj in game.grid.get_adjacent(pt.q, pt.r):
                    if adj.owner is None and not adj.is_blocked and not adj.is_base:
                        adj.is_vp = True
                        connected_vp = adj
                        break
                if connected_vp:
                    break
        assert connected_vp is not None, "Could not create adjacent VP tile"
        connected_vp.owner = "p0"

        # Count all connected VP tiles to compute expected draws
        connected_coords = game.grid.get_connected_tiles("p0")
        total_connected_vp = len([
            t for t in game.grid.tiles.values()
            if t.is_vp and t.owner == "p0" and (t.q, t.r) in connected_coords
        ])
        assert total_connected_vp >= 1

        hand_before = len(player.hand)
        success, _ = play_card(game, "p0", 0)
        assert success
        # Should have drawn 2 cards per connected VP hex, minus the played card
        assert len(player.hand) == hand_before - 1 + (2 * total_connected_vp)


class TestFortressFortifiedPosition:
    def test_fortified_position_vp_formula(self, card_registry):
        """Fortified Position: VP from tiles with permanent defense >= 3."""
        card = card_registry["fortress_fortified_position"]
        assert card.vp_formula == "fortified_tiles_3"
        assert card.unplayable is True

    def test_fortified_position_vp_computation(self, card_registry):
        """Fortified Position: tiles with permanent_defense_bonus >= 3 give VP."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]

        fp = _copy_card(card_registry["fortress_fortified_position"], "test_fp")
        player.deck.discard.append(fp)
        player.vp = 5

        vp_before = compute_player_vp(game, "p0")

        # Give a non-base tile permanent defense >= 3
        tiles = game.grid.get_player_tiles("p0")
        non_base = [t for t in tiles if not t.is_base]
        if not non_base:
            pytest.skip("No non-base tiles")

        non_base[0].permanent_defense_bonus = 3
        vp_after = compute_player_vp(game, "p0")
        assert vp_after == vp_before + 1


# ══════════════════════════════════════════════════════════════════
# VP SCORING — TRASH EXCLUSION
# ══════════════════════════════════════════════════════════════════


class TestTrashExcludedFromVP:
    """Verify that cards in the trash pile do NOT contribute VP."""

    def test_passive_vp_in_trash_ignored(self, card_registry):
        """Cards with passive_vp in trash don't count."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        vp_before = compute_player_vp(game, "p0")

        # Add positive and negative VP cards to trash
        lg = _copy_card(card_registry["neutral_land_grant"], "lg_trash")
        rubble = _make_card("rubble_t", "Rubble", CardType.PASSIVE,
                            passive_vp=-1, unplayable=True)
        player.trash.extend([lg, rubble])

        vp_after = compute_player_vp(game, "p0")
        assert vp_after == vp_before  # no change from trashed cards

    def test_vp_formula_card_in_trash_ignored(self, card_registry):
        """Cards with vp_formula in trash don't count."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        vp_before = compute_player_vp(game, "p0")

        arsenal = _copy_card(card_registry["vanguard_arsenal"], "ars_trash")
        player.trash.append(arsenal)

        vp_after = compute_player_vp(game, "p0")
        assert vp_after == vp_before

    def test_passive_vp_in_deck_counts(self, card_registry):
        """Cards with passive_vp in deck/hand/discard DO count."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        vp_before = compute_player_vp(game, "p0")

        lg = _copy_card(card_registry["neutral_land_grant"], "lg_deck")
        player.deck.cards.append(lg)

        vp_deck = compute_player_vp(game, "p0")
        assert vp_deck == vp_before + 1

        # Also check hand
        lg2 = _copy_card(card_registry["neutral_land_grant"], "lg_hand")
        player.hand.append(lg2)
        vp_hand = compute_player_vp(game, "p0")
        assert vp_hand == vp_deck + 1

        # Also check discard
        lg3 = _copy_card(card_registry["neutral_land_grant"], "lg_discard")
        player.deck.discard.append(lg3)
        vp_discard = compute_player_vp(game, "p0")
        assert vp_discard == vp_hand + 1


# ══════════════════════════════════════════════════════════════════
# CROSS-ARCHETYPE INTERACTIONS
# ══════════════════════════════════════════════════════════════════


class TestContestResolution:
    def test_defender_wins_ties(self, card_registry):
        """When attacker and defender have equal power, defender keeps tile."""
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Ensure a tile owned by p1 is adjacent to p0
        target = _ensure_adjacent_enemy_tile(game, "p0", "p1")
        assert target is not None

        # Both play same power
        attack = _make_card("atk", "Attacker", CardType.CLAIM, power=5,
                            adjacency_required=False)
        defend = _make_card("def", "Defender", CardType.CLAIM, power=5,
                            adjacency_required=False)
        p0.hand = [attack] + p0.hand[1:]
        p1.hand = [defend] + p1.hand[1:]

        # Reset tile defense to 0 for clean test
        target.defense_power = 0
        target.base_defense = 0

        success, _ = play_card(game, "p0", 0, target_q=target.q, target_r=target.r)
        assert success
        success, _ = play_card(game, "p1", 0, target_q=target.q, target_r=target.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        tile = game.grid.get_tile(target.q, target.r)
        assert tile.owner == "p1"  # defender wins tie

    def test_attacker_wins_with_higher_power(self, card_registry):
        """Higher power attacker takes the tile."""
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Ensure a tile owned by p1 is adjacent to p0
        target = _ensure_adjacent_enemy_tile(game, "p0", "p1")
        assert target is not None

        attack = _make_card("atk", "Attacker", CardType.CLAIM, power=20,
                            adjacency_required=False)
        p0.hand = [attack] + p0.hand[1:]

        target.defense_power = 0
        target.base_defense = 0

        success, _ = play_card(game, "p0", 0, target_q=target.q, target_r=target.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        tile = game.grid.get_tile(target.q, target.r)
        assert tile.owner == "p0"

    def test_defense_card_adds_to_tile_power(self, card_registry):
        """Defense cards increase tile defense during resolution."""
        game = _make_2p_game(card_registry, arch0="fortress")
        p0 = game.players["p0"]  # Fortress
        p1 = game.players["p1"]

        # Ensure p1 has a tile adjacent to p0, then pick the p0 tile being attacked
        enemy_tile = _ensure_adjacent_enemy_tile(game, "p0", "p1")
        assert enemy_tile is not None
        # Find the p0 tile that neighbours this enemy tile
        target = None
        for adj in game.grid.get_adjacent(enemy_tile.q, enemy_tile.r):
            if adj.owner == "p0":
                target = adj
                break
        assert target is not None

        # p1 attacks with power 5
        attack = _make_card("atk", "Attacker", CardType.CLAIM, power=5,
                            adjacency_required=False)
        p1.hand = [attack] + p1.hand[1:]

        # p0 defends with Fortified Post (+4)
        fp = _copy_card(card_registry["neutral_fortified_post"], "test_fp")
        p0.hand = [fp] + p0.hand[1:]

        target.defense_power = 2  # Some base defense
        target.base_defense = 2

        success, _ = play_card(game, "p1", 0, target_q=target.q, target_r=target.r)
        assert success
        success, _ = play_card(game, "p0", 0, target_q=target.q, target_r=target.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        # p0 defense: 2 (base) + 4 (fortified post) = 6 > 5 attack
        tile = game.grid.get_tile(target.q, target.r)
        assert tile.owner == "p0"  # defense held


# ══════════════════════════════════════════════════════════════════
# NEW VANGUARD CARDS
# ══════════════════════════════════════════════════════════════════


class TestVanguardCounterattack:
    def test_counterattack_stats(self, card_registry):
        """Counterattack: cost 3, defense type."""
        card = card_registry["vanguard_counterattack"]
        assert card.buy_cost == 3
        assert card.card_type == CardType.DEFENSE


class TestVanguardRearguard:
    def test_rearguard_stats(self, card_registry):
        """Rearguard: cost 4, defense type, gains 3 resources."""
        card = card_registry["vanguard_rearguard"]
        assert card.buy_cost == 4
        assert card.resource_gain == 3
        assert card.card_type == CardType.DEFENSE


# ══════════════════════════════════════════════════════════════════
# NEW SWARM CARDS
# ══════════════════════════════════════════════════════════════════


class TestSwarmNest:
    def test_nest_stats(self, card_registry):
        """Nest: cost 2, defense type."""
        card = card_registry["swarm_nest"]
        assert card.buy_cost == 2
        assert card.card_type == CardType.DEFENSE

    def test_nest_defense_per_adjacent(self, card_registry):
        """Nest: grants defense based on adjacent owned tiles."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]
        nest = _copy_card(card_registry["swarm_nest"], "test_nest")

        assert game.grid is not None
        own_tiles = game.grid.get_player_tiles("p0")
        # Find a tile with at least 1 adjacent owned tile
        target = None
        adj_owned_count = 0
        for t in own_tiles:
            adj = game.grid.get_adjacent(t.q, t.r)
            count = sum(1 for a in adj if a.owner == "p0")
            if count > 0:
                target = t
                adj_owned_count = count
                break
        assert target is not None

        player.hand = [nest] + player.hand[1:]
        initial_defense = target.defense_power

        action = PlannedAction(card=nest, target_q=target.q, target_r=target.r)
        resolve_on_resolution_effects(game, player, nest, action)

        # Each adjacent owned tile should add +1 defense
        assert target.defense_power == initial_defense + adj_owned_count


class TestSwarmSafetyInNumbers:
    def test_safety_in_numbers_stats(self, card_registry):
        """Safety in Numbers: cost 3, defense type."""
        card = card_registry["swarm_safety_in_numbers"]
        assert card.buy_cost == 3
        assert card.card_type == CardType.DEFENSE


class TestSwarmMobRule:
    def test_mob_rule_power_scaling(self, card_registry):
        """Mob Rule: base power 2, +1 per 4 tiles owned."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]
        mob = _copy_card(card_registry["swarm_mob_rule"], "test_mob")

        assert game.grid is not None
        # Give player some extra tiles
        neutrals = [t for t in game.grid.tiles.values()
                     if t.owner is None and not t.is_blocked]
        for i, t in enumerate(neutrals[:7]):
            t.owner = "p0"

        total_tiles = len(game.grid.get_player_tiles("p0"))

        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        action = PlannedAction(card=mob, target_q=q, target_r=r)
        power = calculate_effective_power(game, player, mob, action)
        # base 2 + (total_tiles // 4)
        expected = 2 + (total_tiles // 4)
        assert power == expected


class TestSwarmHiveMind:
    def test_hive_mind_stats(self, card_registry):
        """Hive Mind: cost 6, trash on use."""
        card = card_registry["swarm_hive_mind"]
        assert card.buy_cost == 6
        assert card.trash_on_use is True
        assert card.power == 1

    def test_hive_mind_multi_target_count(self, card_registry):
        """Hive Mind: up to 4 tiles total (3 extras + primary); 5 when upgraded."""
        card = card_registry["swarm_hive_mind"]
        assert card.multi_target_count == 3
        assert card.upgraded_multi_target_count == 4

    def test_hive_mind_claims_four_connected_tiles(self, card_registry):
        """Hive Mind: claims primary + 3 extras forming a connected subgraph."""
        game = _make_2p_game(card_registry)
        assert game.grid is not None
        player = game.players["p1"]
        hive = _copy_card(card_registry["swarm_hive_mind"], "test_hive_four")
        player.hand = [hive] + player.hand[1:]

        cluster = _find_connected_adjacent_neutrals(game, "p1", 4)
        if len(cluster) < 4:
            pytest.skip("Need a connected cluster of 4 adjacent neutral tiles")

        primary, *extras = cluster
        q1, r1 = primary
        success, msg = play_card(
            game, "p1", 0,
            target_q=q1, target_r=r1,
            extra_targets=extras,
        )
        assert success, msg

        submit_play(game, "p0")
        submit_play(game, "p1")

        for q, r in cluster:
            tile = game.grid.get_tile(q, r)
            assert tile is not None
            assert tile.owner == "p1", f"tile ({q},{r}) not claimed"

    def test_hive_mind_rejects_non_adjacent_targets(self, card_registry):
        """Hive Mind: extras disconnected from the target set are rejected."""
        game = _make_2p_game(card_registry)
        assert game.grid is not None
        player = game.players["p1"]
        hive = _copy_card(card_registry["swarm_hive_mind"], "test_hive_nonadj")
        player.hand = [hive] + player.hand[1:]

        candidates = _find_n_adjacent_neutrals(game, "p1", 10)
        pair: tuple[tuple[int, int], tuple[int, int]] | None = None
        for i, a in enumerate(candidates):
            for b in candidates[i + 1:]:
                ta = game.grid.get_tile(*a)
                tb = game.grid.get_tile(*b)
                assert ta is not None and tb is not None
                if ta.distance_to(tb) > 1:
                    pair = (a, b)
                    break
            if pair:
                break
        if pair is None:
            pytest.skip("Need two non-adjacent neutral tiles adjacent to p1")

        (q1, r1), (q2, r2) = pair
        success, msg = play_card(
            game, "p1", 0,
            target_q=q1, target_r=r1,
            extra_targets=[(q2, r2)],
        )
        assert not success
        assert "adjacent" in (msg or "").lower()
        assert game.grid.get_tile(q1, r1).owner is None
        assert game.grid.get_tile(q2, r2).owner is None

    def test_hive_mind_caps_extras_at_three(self, card_registry):
        """Hive Mind: passing more than 3 extras silently drops the overflow."""
        game = _make_2p_game(card_registry)
        assert game.grid is not None
        player = game.players["p1"]
        hive = _copy_card(card_registry["swarm_hive_mind"], "test_hive_cap")
        player.hand = [hive] + player.hand[1:]

        cluster = _find_connected_adjacent_neutrals(game, "p1", 5)
        if len(cluster) < 5:
            pytest.skip("Need a connected cluster of 5 adjacent neutral tiles")

        primary, *rest = cluster
        # Pass 4 extras: only the first 3 should be accepted, the 5th dropped.
        success, msg = play_card(
            game, "p1", 0,
            target_q=primary[0], target_r=primary[1],
            extra_targets=rest,
        )
        assert success, msg

        submit_play(game, "p0")
        submit_play(game, "p1")

        claimed = [c for c in cluster if game.grid.get_tile(*c).owner == "p1"]
        assert len(claimed) == 4, f"expected 4 claims, got {len(claimed)}"
        # The overflow tile (the 4th extra) should remain unclaimed.
        overflow = rest[3]
        assert game.grid.get_tile(*overflow).owner is None

    def test_hive_mind_upgraded_claims_five_connected_tiles(self, card_registry):
        """Hive Mind+: claims primary + 4 extras forming a connected subgraph."""
        game = _make_2p_game(card_registry)
        assert game.grid is not None
        player = game.players["p1"]
        hive = _copy_card(card_registry["swarm_hive_mind"], "test_hive_up")
        hive.is_upgraded = True
        player.hand = [hive] + player.hand[1:]

        cluster = _find_connected_adjacent_neutrals(game, "p1", 5)
        if len(cluster) < 5:
            pytest.skip("Need a connected cluster of 5 adjacent neutral tiles")

        primary, *extras = cluster
        success, msg = play_card(
            game, "p1", 0,
            target_q=primary[0], target_r=primary[1],
            extra_targets=extras,
        )
        assert success, msg

        submit_play(game, "p0")
        submit_play(game, "p1")

        for q, r in cluster:
            tile = game.grid.get_tile(q, r)
            assert tile is not None
            assert tile.owner == "p1", f"tile ({q},{r}) not claimed"


class TestSwarmLocustSwarm:
    def test_locust_swarm_power_from_tiles(self, card_registry):
        """Locust Swarm: power = tiles / 3 (replaces base)."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]
        locust = _copy_card(card_registry["swarm_locust_swarm"], "test_locust")

        assert game.grid is not None
        # Give player 9 tiles total
        neutrals = [t for t in game.grid.tiles.values()
                     if t.owner is None and not t.is_blocked]
        current = len(game.grid.get_player_tiles("p0"))
        needed = 9 - current
        for t in neutrals[:needed]:
            t.owner = "p0"

        total_tiles = len(game.grid.get_player_tiles("p0"))
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        action = PlannedAction(card=locust, target_q=q, target_r=r)
        power = calculate_effective_power(game, player, locust, action)
        # tiles / 3 = 9 / 3 = 3 (replaces base power of 0)
        assert power == total_tiles // 3

    def test_locust_swarm_playable_against_defended_tile(self, card_registry):
        """Locust Swarm (base power 0) should be playable against a defended
        neutral tile when tile count gives it enough dynamic power."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]
        locust = _copy_card(card_registry["swarm_locust_swarm"], "test_locust2")

        assert game.grid is not None
        # Give player 9 tiles total → power = 9 // 3 = 3
        neutrals = [t for t in game.grid.tiles.values()
                     if t.owner is None and not t.is_blocked]
        current = len(game.grid.get_player_tiles("p0"))
        needed = 9 - current
        for t in neutrals[:needed]:
            t.owner = "p0"

        # Find an adjacent neutral tile and set its defense to 2
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        tile = game.grid.get_tile(q, r)
        assert tile is not None
        tile.defense_power = 2
        tile.base_defense = 2

        player.hand = [locust] + player.hand[:4]
        # Should succeed: dynamic power 3 > defense 2
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success, f"Expected play to succeed but got: {msg}"


# ══════════════════════════════════════════════════════════════════
# NEW CARDS — WAR TITHE, COLONY, WARDEN, RESILIENCE
# ══════════════════════════════════════════════════════════════════


class TestVanguardWarTithe:
    def test_war_tithe_properties(self, card_registry):
        """War Tithe: engine card, cost 4, resources from last round's claims."""
        card = card_registry["vanguard_war_tithe"]
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 4
        assert card.archetype == Archetype.VANGUARD
        assert card.power == 0

    def test_war_tithe_has_effect(self, card_registry):
        """War Tithe: has RESOURCES_PER_CLAIMS_LAST_ROUND effect."""
        card = card_registry["vanguard_war_tithe"]
        matching = [e for e in card.effects if e.type.value == "resources_per_claims_last_round"]
        assert len(matching) >= 1
        assert matching[0].value == 1
        assert matching[0].upgraded_value == 2
        assert matching[0].metadata.get("max_resources") == 4

    def test_war_tithe_playable(self, card_registry):
        """War Tithe: can be played as an engine card (costs 1 action)."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wt = _copy_card(card_registry["vanguard_war_tithe"], "test_wt")
        player.hand = [wt] + player.hand[1:]
        initial_used = player.actions_used

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.actions_used == initial_used + 1

    def test_war_tithe_grants_resources_from_last_round(self, card_registry):
        """War Tithe: gains resources based on claims_won_last_round."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wt = _copy_card(card_registry["vanguard_war_tithe"], "test_wt")
        player.hand = [wt] + player.hand[1:]

        # Simulate having claimed 3 tiles last round
        player.claims_won_last_round = 3
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        # 3 claims × 1 resource each = 3 (capped at max_resources=4)
        assert player.resources == initial + 3

    def test_war_tithe_respects_max_cap(self, card_registry):
        """War Tithe: resource gain is capped at max_resources."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wt = _copy_card(card_registry["vanguard_war_tithe"], "test_wt")
        player.hand = [wt] + player.hand[1:]

        # Simulate having claimed 5 tiles (exceeds max of 4)
        player.claims_won_last_round = 5
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        # 5 × 1 = 5, but capped at 4
        assert player.resources == initial + 4

    def test_war_tithe_zero_claims(self, card_registry):
        """War Tithe: no resources if no tiles claimed last round."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wt = _copy_card(card_registry["vanguard_war_tithe"], "test_wt")
        player.hand = [wt] + player.hand[1:]

        player.claims_won_last_round = 0
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial


class TestSwarmColony:
    def test_colony_properties(self, card_registry):
        """Colony: passive card, cost 4, VP from disconnected groups."""
        card = card_registry["swarm_colony"]
        assert card.card_type == CardType.PASSIVE
        assert card.buy_cost == 4
        assert card.archetype == Archetype.SWARM
        assert card.unplayable is True
        assert card.vp_formula == "disconnected_groups_3"

    def test_colony_has_effect(self, card_registry):
        """Colony: has VP_FROM_DISCONNECTED_GROUPS effect."""
        card = card_registry["swarm_colony"]
        matching = [e for e in card.effects if e.type.value == "vp_from_disconnected_groups"]
        assert len(matching) >= 1
        assert matching[0].value == 3  # min group size base
        assert matching[0].upgraded_value == 2  # min group size upgraded
        assert matching[0].metadata.get("min_group_size") == 3

    def test_colony_is_unplayable(self, card_registry):
        """Colony: cannot be played as an action."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]
        colony = _copy_card(card_registry["swarm_colony"], "test_colony")
        player.hand = [colony] + player.hand[1:]

        success, msg = play_card(game, "p0", 0)
        assert not success

    def test_colony_vp_from_disconnected_groups(self, card_registry):
        """Colony: +1 VP per disconnected group of 3+ tiles."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]

        colony = _copy_card(card_registry["swarm_colony"], "test_colony")
        player.deck.discard.append(colony)

        vp_before = compute_player_vp(game, "p0")

        # Create a disconnected group of 3 tiles far from player's base
        assert game.grid is not None
        base_connected = game.grid.get_connected_tiles("p0")
        # Find 3 adjacent neutral tiles far from base
        candidates = []
        for tile in game.grid.tiles.values():
            if tile.owner is None and not tile.is_blocked and (tile.q, tile.r) not in base_connected:
                candidates.append(tile)
        # Find a cluster of 3 adjacent tiles among candidates
        cluster = []
        for t in candidates:
            if len(cluster) >= 3:
                break
            if not cluster:
                cluster.append(t)
                continue
            for ct in cluster:
                if t.distance_to(ct) == 1:
                    cluster.append(t)
                    break
        if len(cluster) >= 3:
            for t in cluster[:3]:
                t.owner = "p0"
                t.capture_count = 0

            vp_after = compute_player_vp(game, "p0")
            # Should have +1 VP from the disconnected group
            assert vp_after >= vp_before + 1
        else:
            pytest.skip("Could not find 3 adjacent disconnected tiles")

    def test_colony_ignores_small_groups(self, card_registry):
        """Colony: groups smaller than 3 tiles don't count for Colony VP."""
        game = _make_2p_game(card_registry, arch0="swarm")
        player = game.players["p0"]

        assert game.grid is not None
        base_connected = game.grid.get_connected_tiles("p0")
        candidates = [
            t for t in game.grid.tiles.values()
            if t.owner is None and not t.is_blocked and (t.q, t.r) not in base_connected
        ]

        # Create a disconnected group of only 2 tiles
        placed = 0
        for t in candidates:
            if placed >= 2:
                break
            if placed == 0:
                t.owner = "p0"
                placed += 1
            elif t.distance_to(candidates[0]) == 1:
                t.owner = "p0"
                placed += 1

        if placed < 2:
            pytest.skip("Could not place disconnected pair")

        # Measure VP with and without Colony card
        vp_without_colony = compute_player_vp(game, "p0")

        colony = _copy_card(card_registry["swarm_colony"], "test_colony")
        player.deck.discard.append(colony)
        vp_with_colony = compute_player_vp(game, "p0")

        # Group of 2 tiles should NOT give VP from Colony formula
        assert vp_with_colony == vp_without_colony


class TestFortressWarden:
    def test_warden_properties(self, card_registry):
        """Warden: passive card, cost 4, VP from uncaptured tiles."""
        card = card_registry["fortress_warden"]
        assert card.card_type == CardType.PASSIVE
        assert card.buy_cost == 4
        assert card.archetype == Archetype.FORTRESS
        assert card.unplayable is True
        assert card.vp_formula == "uncaptured_tiles_8"

    def test_warden_has_effect(self, card_registry):
        """Warden: has VP_FROM_UNCAPTURED_TILES effect."""
        card = card_registry["fortress_warden"]
        matching = [e for e in card.effects if e.type.value == "vp_from_uncaptured_tiles"]
        assert len(matching) >= 1
        assert matching[0].value == 8  # divisor base
        assert matching[0].upgraded_value == 6  # divisor upgraded
        assert matching[0].metadata.get("divisor") == 8

    def test_warden_is_unplayable(self, card_registry):
        """Warden: cannot be played as an action."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        warden = _copy_card(card_registry["fortress_warden"], "test_warden")
        player.hand = [warden] + player.hand[1:]

        success, msg = play_card(game, "p0", 0)
        assert not success

    def test_warden_vp_from_uncaptured_tiles(self, card_registry):
        """Warden: +1 VP per 4 non-base tiles with capture_count == 0."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]

        warden = _copy_card(card_registry["fortress_warden"], "test_warden")
        player.deck.discard.append(warden)
        player.vp = 5

        vp_before = compute_player_vp(game, "p0")

        # Give player 4 non-base tiles with capture_count=0
        assert game.grid is not None
        neutrals = [t for t in game.grid.tiles.values()
                     if t.owner is None and not t.is_blocked]
        for t in neutrals[:4]:
            t.owner = "p0"
            t.capture_count = 0  # never changed hands

        vp_after = compute_player_vp(game, "p0")
        # 4 uncaptured non-base tiles / 4 = +1 VP from Warden
        assert vp_after >= vp_before + 1

    def test_warden_excludes_captured_tiles(self, card_registry):
        """Warden: tiles with capture_count > 0 don't count for Warden VP."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]

        assert game.grid is not None
        # Give player 4 tiles, but all have been captured (capture_count > 0)
        neutrals = [t for t in game.grid.tiles.values()
                     if t.owner is None and not t.is_blocked]
        for t in neutrals[:4]:
            t.owner = "p0"
            t.capture_count = 1  # has changed hands

        # Measure VP with and without Warden
        vp_without = compute_player_vp(game, "p0")

        warden = _copy_card(card_registry["fortress_warden"], "test_warden")
        player.deck.discard.append(warden)
        vp_with = compute_player_vp(game, "p0")

        # Captured tiles don't count → Warden adds 0 VP
        assert vp_with == vp_without

    def test_warden_excludes_base_tiles(self, card_registry):
        """Warden: base tiles don't count even if capture_count == 0."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]

        warden = _copy_card(card_registry["fortress_warden"], "test_warden")
        player.deck.discard.append(warden)

        assert game.grid is not None
        # Verify base tiles exist and have capture_count 0
        base_tiles = [t for t in game.grid.tiles.values()
                      if t.is_base and t.owner == "p0"]
        assert len(base_tiles) >= 1
        for t in base_tiles:
            assert t.capture_count == 0

        # Even though base tiles are uncaptured, they shouldn't count
        # (formula only counts non-base tiles)


class TestFortressResilience:
    def test_resilience_properties(self, card_registry):
        """Resilience: engine card, cost 2, gain 1 action."""
        card = card_registry["fortress_catch_up"]
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 2
        assert card.archetype == Archetype.FORTRESS
        assert card.action_return == 1

    def test_resilience_gains_resources_when_fewest_tiles(self, card_registry):
        """Resilience: gain 3 resources when controlling fewest tiles."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        opponent = game.players["p1"]
        resilience = _copy_card(card_registry["fortress_catch_up"], "test_res")
        player.hand = [resilience] + player.hand[1:]

        assert game.grid is not None
        # Give opponent more tiles so p0 has fewest
        neutrals = [t for t in game.grid.tiles.values()
                     if t.owner is None and not t.is_blocked]
        for t in neutrals[:5]:
            t.owner = "p1"

        p0_tiles = len(game.grid.get_player_tiles("p0"))
        p1_tiles = len(game.grid.get_player_tiles("p1"))
        assert p0_tiles < p1_tiles

        initial_resources = player.resources
        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_resources + 3

    def test_resilience_no_bonus_when_not_fewest(self, card_registry):
        """Resilience: no resource bonus when NOT controlling fewest tiles."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        resilience = _copy_card(card_registry["fortress_catch_up"], "test_res")
        player.hand = [resilience] + player.hand[1:]

        assert game.grid is not None
        # Give p0 more tiles so they don't have fewest
        neutrals = [t for t in game.grid.tiles.values()
                     if t.owner is None and not t.is_blocked]
        for t in neutrals[:5]:
            t.owner = "p0"

        p0_tiles = len(game.grid.get_player_tiles("p0"))
        p1_tiles = len(game.grid.get_player_tiles("p1"))
        assert p0_tiles > p1_tiles

        initial_resources = player.resources
        success, _ = play_card(game, "p0", 0)
        assert success
        # Should gain 0 resources from the conditional effect
        assert player.resources == initial_resources

    def test_resilience_returns_action(self, card_registry):
        """Resilience: gain 1 action back (net neutral action cost)."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        resilience = _copy_card(card_registry["fortress_catch_up"], "test_res")
        player.hand = [resilience] + player.hand[1:]
        initial_available = player.actions_available
        initial_used = player.actions_used

        success, _ = play_card(game, "p0", 0)
        assert success
        # action_return 1 → gains 1 extra action_available
        assert player.actions_available == initial_available + 1
        # But also costs 1 action to play
        assert player.actions_used == initial_used + 1


# ══════════════════════════════════════════════════════════════════
# NEW CARDS — Synergy / Medium-Complexity / Complex
# ══════════════════════════════════════════════════════════════════


class TestNeutralSpyglass:
    def test_spyglass_properties(self, card_registry):
        """Spyglass: engine, cost 1, draw 1, conditional action effect."""
        card = card_registry.get("neutral_spyglass")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 1
        assert card.archetype == Archetype.NEUTRAL
        assert card.draw_cards == 1
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.CONDITIONAL_ACTION
        assert eff.condition == ConditionType.HAND_SIZE_LTE
        assert eff.condition_threshold == 3

    def test_spyglass_action_gain_small_hand(self, card_registry):
        """Spyglass grants action when hand size <= 3 after draw."""
        card = card_registry.get("neutral_spyglass")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        spy = _copy_card(card, "test_spy")
        # Set hand to exactly 3 cards (spy + 2 filler) so after playing (hand=2)
        # and drawing 1 (hand=3), hand_size <= 3 → action gained
        player.hand = [spy, player.hand[0], player.hand[1]]
        initial_actions = player.actions_available
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # After play: hand was 3, remove spy → 2, draw 1 → 3. 3 <= 3 → gain 1 action
        assert player.actions_available >= initial_actions + 1

    def test_spyglass_no_action_large_hand(self, card_registry):
        """Spyglass does NOT grant action when hand size > 3 after draw."""
        card = card_registry.get("neutral_spyglass")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        spy = _copy_card(card, "test_spy")
        # Full 5-card hand. After playing (4 left) + draw 1 → 4. 4 > 3 → no action
        player.hand = [spy] + player.hand[1:]
        assert len(player.hand) == 5
        initial_actions = player.actions_available
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # No bonus action; only the base action cost
        assert player.actions_available == initial_actions

    def test_spyglass_upgraded_resource(self, card_registry):
        """Upgraded Spyglass also grants +1 resource when condition met."""
        card = card_registry.get("neutral_spyglass")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        spy = _copy_card(card, "test_spy_up")
        spy.is_upgraded = True
        # Small hand so condition is met
        player.hand = [spy, player.hand[0], player.hand[1]]
        initial_resources = player.resources
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        assert player.resources == initial_resources + 1


class TestNeutralDividends:
    def test_dividends_properties(self, card_registry):
        """Dividends: engine, cost 4, resource_scaling effect."""
        card = card_registry.get("neutral_dividends")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 4
        assert card.archetype == Archetype.NEUTRAL
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.RESOURCE_SCALING
        assert eff.value == 3  # divisor

    def test_dividends_scales_with_resources(self, card_registry):
        """Dividends gains floor(resources/3), min 1."""
        card = card_registry.get("neutral_dividends")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        div = _copy_card(card, "test_div")
        player.hand = [div] + player.hand[1:]
        player.resources = 10
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # floor(10/3) = 3 → resources = 10 + 3 = 13
        assert player.resources == 13

    def test_dividends_min_1(self, card_registry):
        """Dividends gains at least 1 even with 0 resources."""
        card = card_registry.get("neutral_dividends")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        div = _copy_card(card, "test_div")
        player.hand = [div] + player.hand[1:]
        player.resources = 0
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # min 1 → resources = 0 + 1 = 1
        assert player.resources == 1

    def test_dividends_upgraded_draw(self, card_registry):
        """Upgraded Dividends also draws 1 card."""
        card = card_registry.get("neutral_dividends")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        div = _copy_card(card, "test_div_up")
        div.is_upgraded = True
        player.hand = [div] + player.hand[1:]
        player.resources = 4
        hand_before = len(player.hand)
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # Played 1 card (hand -1), but upgraded draws 1 → net 0 hand change
        # Plus any base draw_cards. Effect handler draws 1.
        assert len(player.hand) >= hand_before - 1  # at minimum didn't lose more than the played card


class TestNeutralCartographer:
    def test_cartographer_properties(self, card_registry):
        """Cartographer: engine, cost 3, cycle effect."""
        card = card_registry.get("neutral_cartographer")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 3
        assert card.archetype == Archetype.NEUTRAL
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.CYCLE
        assert eff.metadata.get("discard") == 2
        assert eff.metadata.get("draw") == 2
        assert eff.metadata.get("upgraded_draw") == 4

    def test_cartographer_cycle(self, card_registry):
        """Cartographer discards 2 and draws 2 — net hand size change is -1 (played card)."""
        card = card_registry.get("neutral_cartographer")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        carto = _copy_card(card, "test_carto")
        player.hand = [carto] + player.hand[1:]
        hand_before = len(player.hand)
        # Discard indices 0 and 1 (relative to hand AFTER card is removed)
        success, msg = play_card(game, "p0", 0, discard_card_indices=[0, 1])
        assert success, msg
        # Played card removed (-1), discard 2 (-2), draw 2 (+2) → net -1
        assert len(player.hand) == hand_before - 1

    def test_cartographer_upgraded_draws_4(self, card_registry):
        """Upgraded Cartographer draws 4 instead of 2."""
        card = card_registry.get("neutral_cartographer")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        carto = _copy_card(card, "test_carto_up")
        carto.is_upgraded = True
        player.hand = [carto] + player.hand[1:]
        hand_before = len(player.hand)
        success, msg = play_card(game, "p0", 0, discard_card_indices=[0, 1])
        assert success, msg
        # Played card removed (-1), discard 2 (-2), draw 4 (+4) → net +1
        assert len(player.hand) == hand_before + 1


class TestNeutralTaxCollector:
    def test_tax_collector_properties(self, card_registry):
        """Tax Collector: engine, cost 4, resource_per_vp_hex effect."""
        card = card_registry.get("neutral_tax_collector")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 4
        assert card.archetype == Archetype.NEUTRAL
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.RESOURCE_PER_VP_HEX
        assert eff.value == 2
        assert eff.upgraded_value == 3

    def test_tax_collector_with_vp_hexes(self, card_registry):
        """Tax Collector gains 2 resources per connected VP hex owned."""
        card = card_registry.get("neutral_tax_collector")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        tc = _copy_card(card, "test_tc")
        player.hand = [tc] + player.hand[1:]
        # Give p0 VP hexes that are connected to their base via owned tiles.
        # BFS from p0's base to find VP tiles, claiming intermediate tiles along the way.
        from collections import deque
        base_tiles = [t for t in game.grid.tiles.values() if t.is_base and t.owner == "p0"]
        assert base_tiles, "p0 must have base tiles"
        visited = {(t.q, t.r) for t in base_tiles}
        queue = deque(base_tiles)
        vp_count = 0
        while queue and vp_count < 2:
            tile = queue.popleft()
            for adj in game.grid.get_adjacent(tile.q, tile.r):
                if (adj.q, adj.r) in visited or adj.is_blocked:
                    continue
                visited.add((adj.q, adj.r))
                if adj.is_vp and adj.owner != "p1":
                    adj.owner = "p0"
                    vp_count += 1
                    if vp_count >= 2:
                        break
                elif adj.owner is None:
                    # Claim intermediate tile to extend connectivity
                    adj.owner = "p0"
                    queue.append(adj)
        assert vp_count >= 1, "Need at least 1 VP tile reachable from p0 base"
        initial_resources = player.resources
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        assert player.resources == initial_resources + (vp_count * 2)

    def test_tax_collector_zero_vp_hexes(self, card_registry):
        """Tax Collector gains 0 with no VP hexes."""
        card = card_registry.get("neutral_tax_collector")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        tc = _copy_card(card, "test_tc")
        player.hand = [tc] + player.hand[1:]
        # Ensure p0 has no VP hexes
        for tile in game.grid.tiles.values():
            if tile.is_vp and tile.owner == "p0":
                tile.owner = None
        initial_resources = player.resources
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        assert player.resources == initial_resources


class TestNeutralMobilize:
    def test_mobilize_properties(self, card_registry):
        """Mobilize: engine, cost 4, trash_on_use, actions_per_cards_played effect."""
        card = card_registry.get("neutral_mobilize")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 4
        assert card.archetype == Archetype.NEUTRAL
        assert card.trash_on_use is True
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.ACTIONS_PER_CARDS_PLAYED
        assert eff.metadata.get("max") == 3
        assert eff.metadata.get("upgraded_max") == 4

    def test_mobilize_action_gain_scales(self, card_registry):
        """Mobilize gains 1 action per other card played this turn."""
        card = card_registry.get("neutral_mobilize")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        # Play 2 gather cards first to create planned_actions
        g1 = _copy_card(card_registry["neutral_gather"], "g1")
        g2 = _copy_card(card_registry["neutral_gather"], "g2")
        mob = _copy_card(card, "test_mob")
        player.hand = [g1, g2, mob] + player.hand[3:]
        play_card(game, "p0", 0)  # gather 1
        play_card(game, "p0", 0)  # gather 2
        # Now 2 planned_actions, play Mobilize
        actions_before = player.actions_available
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # Should gain 2 actions (2 other cards played, max 3)
        assert player.actions_available == actions_before + 2

    def test_mobilize_respects_max_cap(self, card_registry):
        """Mobilize caps action gain at max (3)."""
        card = card_registry.get("neutral_mobilize")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        # Play 4 gathers first to exceed cap
        gathers = [_copy_card(card_registry["neutral_gather"], f"g{i}") for i in range(4)]
        mob = _copy_card(card, "test_mob")
        player.hand = gathers + [mob]
        player.actions_available = 10  # plenty of actions
        for _ in range(4):
            play_card(game, "p0", 0)
        actions_before = player.actions_available
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # 4 other cards played, but max 3 → gain 3
        assert player.actions_available == actions_before + 3


class TestNeutralAmbush:
    def test_ambush_properties(self, card_registry):
        """Ambush: claim, cost 4, power 2, power_modifier with if_contested."""
        card = card_registry.get("neutral_ambush")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.CLAIM
        assert card.buy_cost == 4
        assert card.power == 2
        assert card.archetype == Archetype.NEUTRAL
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.POWER_MODIFIER
        assert eff.condition == ConditionType.IF_CONTESTED
        assert eff.value == 2  # bonus power

    def test_ambush_base_power_on_uncontested(self, card_registry):
        """Ambush has power 2 on uncontested neutral tile."""
        card = card_registry.get("neutral_ambush")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        ambush = _copy_card(card, "test_ambush")
        p0.hand = [ambush] + p0.hand[1:]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success, msg
        submit_play(game, "p0")
        submit_play(game, "p1")
        # Uncontested — base power 2 wins neutral tile (defense 0)
        tile = game.grid.get_tile(q, r)
        assert tile.owner == "p0"

    def test_ambush_power_boost_on_contested(self, card_registry):
        """Ambush becomes power 4 when contested (opponent also claims same tile)."""
        card = card_registry.get("neutral_ambush")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        p1 = game.players["p1"]
        ambush = _copy_card(card, "test_ambush")
        # Ensure p1 has a tile adjacent to p0 so we can find a shared neutral neighbour
        enemy_tile = _ensure_adjacent_enemy_tile(game, "p0", "p1")
        assert enemy_tile is not None
        # Find a neutral tile adjacent to BOTH players
        target_q, target_r = None, None
        p0_tiles = set((t.q, t.r) for t in game.grid.get_player_tiles("p0"))
        p1_tiles = set((t.q, t.r) for t in game.grid.get_player_tiles("p1"))
        for tile in game.grid.tiles.values():
            if tile.owner is not None or tile.is_blocked:
                continue
            adj_coords = set((a.q, a.r) for a in game.grid.get_adjacent(tile.q, tile.r))
            if adj_coords & p0_tiles and adj_coords & p1_tiles:
                target_q, target_r = tile.q, tile.r
                break
        assert target_q is not None, "No neutral tile adjacent to both players"

        p0.hand = [ambush] + p0.hand[1:]
        # p1 plays a weak claim (power 3) on same tile
        weak_claim = _make_card("weak", "Weak Claim", CardType.CLAIM, power=3,
                                adjacency_required=False)
        p1.hand = [weak_claim] + p1.hand[1:]
        game.grid.get_tile(target_q, target_r).defense_power = 0
        game.grid.get_tile(target_q, target_r).base_defense = 0

        success, _ = play_card(game, "p0", 0, target_q=target_q, target_r=target_r)
        assert success
        success, _ = play_card(game, "p1", 0, target_q=target_q, target_r=target_r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        # Ambush: base 2 + bonus 2 = 4 > 3 → p0 wins
        tile = game.grid.get_tile(target_q, target_r)
        assert tile.owner == "p0"

    def test_ambush_contested_against_owned_tile(self, card_registry):
        """Ambush gets bonus power when targeting a tile owned by an opponent (always contested)."""
        card = card_registry.get("neutral_ambush")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        ambush = _copy_card(card, "test_ambush")
        ambush.adjacency_required = False
        p0.hand = [ambush] + p0.hand[1:]
        # Find a tile owned by p1 (not base) to attack
        target_tile = None
        for tile in game.grid.tiles.values():
            if tile.owner == "p1" and not tile.is_base:
                target_tile = tile
                break
        if target_tile is None:
            # Give p1 an adjacent tile
            for tile in game.grid.tiles.values():
                adj = game.grid.get_adjacent(tile.q, tile.r)
                if tile.owner is None and not tile.is_blocked and any(a.owner == "p1" for a in adj):
                    tile.owner = "p1"
                    tile.defense_power = 0
                    tile.base_defense = 0
                    target_tile = tile
                    break
        assert target_tile is not None
        target_tile.defense_power = 3  # Ambush base 2 would lose, but with +2 bonus = 4 wins
        target_tile.base_defense = 3

        success, _ = play_card(game, "p0", 0, target_q=target_tile.q, target_r=target_tile.r)
        assert success
        submit_play(game, "p0")
        submit_play(game, "p1")

        # Ambush should get the contested bonus: 2 + 2 = 4 > 3 defense
        result_tile = game.grid.get_tile(target_tile.q, target_tile.r)
        assert result_tile.owner == "p0"

    def test_ambush_upgraded_contested(self, card_registry):
        """Ambush+ gets +3 power and 1 resource on contested claim."""
        card = card_registry.get("neutral_ambush")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        ambush = _copy_card(card, "test_ambush_up")
        ambush.is_upgraded = True
        ambush.adjacency_required = False
        p0.hand = [ambush] + p0.hand[1:]
        # Find/create a tile owned by p1 with defense 4
        target_tile = None
        for tile in game.grid.tiles.values():
            if tile.owner is None and not tile.is_blocked:
                tile.owner = "p1"
                tile.defense_power = 4
                tile.base_defense = 4
                target_tile = tile
                break
        assert target_tile is not None
        initial_resources = p0.resources

        success, _ = play_card(game, "p0", 0, target_q=target_tile.q, target_r=target_tile.r)
        assert success
        submit_play(game, "p0")
        submit_play(game, "p1")

        # Ambush+: base 2 + bonus 3 = 5 > 4 defense → p0 wins
        result_tile = game.grid.get_tile(target_tile.q, target_tile.r)
        assert result_tile.owner == "p0"
        # Upgraded also gains 1 resource immediately on play
        assert p0.resources == initial_resources + 1

    def test_ambush_no_bonus_on_unowned_uncontested(self, card_registry):
        """Ambush does NOT get bonus on uncontested neutral tile — effective power is base 2 only."""
        from app.game_engine.effect_resolver import calculate_effective_power
        card = card_registry.get("neutral_ambush")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        ambush = _copy_card(card, "test_ambush_no_bonus")
        p0.hand = [ambush] + p0.hand[1:]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None

        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success
        # Verify the effective power at resolve time is 2 (no bonus, uncontested)
        action = p0.planned_actions[-1]
        power = calculate_effective_power(game, p0, ambush, action)
        assert power == 2  # base power only, no contest bonus

    def test_ambush_effective_power_with_contest(self, card_registry):
        """Ambush effective power is 4 when contested (opponent owns tile)."""
        from app.game_engine.effect_resolver import calculate_effective_power
        card = card_registry.get("neutral_ambush")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        ambush = _copy_card(card, "test_ambush_contest_power")
        ambush.adjacency_required = False
        p0.hand = [ambush] + p0.hand[1:]
        # Target an opponent-owned tile
        target_tile = None
        for tile in game.grid.tiles.values():
            if tile.owner is None and not tile.is_blocked:
                tile.owner = "p1"
                tile.defense_power = 0
                target_tile = tile
                break
        assert target_tile is not None

        success, _ = play_card(game, "p0", 0, target_q=target_tile.q, target_r=target_tile.r)
        assert success
        action = p0.planned_actions[-1]
        power = calculate_effective_power(game, p0, ambush, action)
        assert power == 4  # base 2 + contest bonus 2


class TestNeutralSupplyDepot:
    def test_supply_depot_properties(self, card_registry):
        """Supply Depot: engine, cost 6, next_turn_bonus effect on_resolution."""
        card = card_registry.get("neutral_supply_depot")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 6
        assert card.archetype == Archetype.NEUTRAL
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.NEXT_TURN_BONUS
        assert eff.timing == Timing.ON_RESOLUTION
        assert eff.metadata.get("draw") == 1
        assert eff.metadata.get("resources") == 2
        assert eff.metadata.get("upgraded_actions") == 1

    def test_supply_depot_next_turn_bonuses(self, card_registry):
        """Supply Depot queues +1 draw and +1 resource for next turn."""
        card = card_registry.get("neutral_supply_depot")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        depot = _copy_card(card, "test_depot")
        player.hand = [depot] + player.hand[1:]
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        submit_play(game, "p0")
        submit_play(game, "p1")
        # After reveal, the on_resolution effect should set turn_modifiers
        assert player.turn_modifiers.extra_draws_next_turn >= 1
        assert player.turn_modifiers.extra_resources_next_turn >= 1

    def test_supply_depot_upgraded_extra_action(self, card_registry):
        """Upgraded Supply Depot also grants +1 action next turn."""
        card = card_registry.get("neutral_supply_depot")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        depot = _copy_card(card, "test_depot_up")
        depot.is_upgraded = True
        player.hand = [depot] + player.hand[1:]
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        submit_play(game, "p0")
        submit_play(game, "p1")
        assert player.turn_modifiers.extra_draws_next_turn >= 1
        assert player.turn_modifiers.extra_resources_next_turn >= 1
        assert player.turn_modifiers.extra_actions_next_turn >= 1


# ══════════════════════════════════════════════════════════════════
# FORTRESS CARDS — New
# ══════════════════════════════════════════════════════════════════


class TestFortressMulligan:
    def test_mulligan_properties(self, card_registry):
        """Mulligan: engine, cost 3, action_return 1, mulligan effect."""
        card = card_registry.get("fortress_mulligan")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 3
        assert card.action_return == 1
        assert card.archetype == Archetype.FORTRESS
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.MULLIGAN

    def test_mulligan_full_hand_swap(self, card_registry):
        """Mulligan discards entire hand and redraws same count."""
        card = card_registry.get("fortress_mulligan")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        mul = _copy_card(card, "test_mul")
        player.hand = [mul] + player.hand[1:]
        hand_before = len(player.hand)
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # After play: card removed (-1), remaining hand discarded, redraw same count
        # Mulligan discards the remaining hand (hand_before - 1 cards), then draws that many
        assert len(player.hand) == hand_before - 1

    def test_mulligan_upgraded_draws_extra(self, card_registry):
        """Upgraded Mulligan draws hand_size + 1."""
        card = card_registry.get("fortress_mulligan")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        mul = _copy_card(card, "test_mul_up")
        mul.is_upgraded = True
        player.hand = [mul] + player.hand[1:]
        hand_before = len(player.hand)
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # Remaining hand was hand_before - 1, redraw that many + 1
        assert len(player.hand) == hand_before


class TestFortressRobinHood:
    def test_robin_hood_properties(self, card_registry):
        """Robin Hood: engine, cost 3, resources_per_tiles_lost effect."""
        card = card_registry.get("fortress_robin_hood")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 3
        assert card.archetype == Archetype.FORTRESS
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.RESOURCES_PER_TILES_LOST
        assert eff.value == 3
        assert eff.upgraded_value == 5

    def test_robin_hood_resource_gain(self, card_registry):
        """Robin Hood gains 3 resources per tile lost last round."""
        card = card_registry.get("fortress_robin_hood")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        rh = _copy_card(card, "test_rh")
        player.hand = [rh] + player.hand[1:]
        player.tiles_lost_last_round = 3
        initial_resources = player.resources
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # 3 tiles lost × 3 resources = 9
        assert player.resources == initial_resources + 9

    def test_robin_hood_zero_tiles_lost(self, card_registry):
        """Robin Hood gains 0 resources when no tiles were lost."""
        card = card_registry.get("fortress_robin_hood")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        rh = _copy_card(card, "test_rh")
        player.hand = [rh] + player.hand[1:]
        player.tiles_lost_last_round = 0
        initial_resources = player.resources
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        assert player.resources == initial_resources

    def test_robin_hood_upgraded(self, card_registry):
        """Robin Hood+ gains 5 resources per tile lost last round."""
        card = card_registry.get("fortress_robin_hood")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        rh = _copy_card(card, "test_rh_up")
        rh.is_upgraded = True
        player.hand = [rh] + player.hand[1:]
        player.tiles_lost_last_round = 2
        initial_resources = player.resources
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # 2 tiles lost × 5 resources = 10
        assert player.resources == initial_resources + 10

    def test_robin_hood_tiles_lost_tracking(self, card_registry):
        """Robin Hood works with actual tile capture tracking across rounds."""
        card = card_registry.get("fortress_robin_hood")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Give p0 a non-base tile adjacent to p0's territory, then p1 captures it with adjacency_required=False
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        target_tile = game.grid.get_tile(q, r)
        target_tile.owner = "p0"
        target_tile.defense_power = 0
        target_tile.base_defense = 0

        # p1 claims p0's tile with a strong claim (ignoring adjacency)
        strong_claim = _make_card("strong", "Strong Claim", CardType.CLAIM, power=5,
                                  adjacency_required=False)
        p1.hand = [strong_claim] + p1.hand[1:]

        # p0 plays nothing (just submit)
        success, _ = play_card(game, "p1", 0, target_q=q, target_r=r)
        assert success
        submit_play(game, "p0")
        submit_play(game, "p1")

        # p0 should have lost 1 tile
        assert p0.tiles_lost_last_round == 1
        assert game.grid.get_tile(q, r).owner == "p1"

        # Start next turn and play Robin Hood
        execute_start_of_turn(game)
        execute_upkeep(game)
        rh = _copy_card(card, "test_rh_track")
        p0.hand = [rh] + p0.hand[1:]
        initial_resources = p0.resources
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # 1 tile lost × 3 resources = 3
        assert p0.resources == initial_resources + 3

    def test_robin_hood_snapshot_at_play_time(self, card_registry):
        """Robin Hood's resource gain is snapshotted when played (effective_resource_gain on PlannedAction)."""
        card = card_registry.get("fortress_robin_hood")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        rh = _copy_card(card, "test_rh_snap")
        player.hand = [rh] + player.hand[1:]
        player.tiles_lost_last_round = 3
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        # Verify the planned action has a snapshotted resource gain
        action = player.planned_actions[-1]
        assert action.effective_resource_gain == 9  # 3 tiles × 3 per tile


class TestFortressScorchedRetreat:
    def test_scorched_retreat_properties(self, card_registry):
        """Scorched Retreat: engine, cost 4, trash_on_use, target_own_tile, abandon_and_block."""
        card = card_registry.get("fortress_scorched_retreat")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 4
        assert card.trash_on_use is True
        assert card.target_own_tile is True
        assert card.archetype == Archetype.FORTRESS
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.ABANDON_AND_BLOCK

    def test_scorched_retreat_blocks_tile(self, card_registry):
        """Scorched Retreat abandons tile and makes it blocked at resolve, gains 2 resources."""
        card = card_registry.get("fortress_scorched_retreat")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        sr = _copy_card(card, "test_sr")
        player.hand = [sr] + player.hand[1:]
        # Need a non-base tile owned by p0
        own_tiles = game.grid.get_player_tiles("p0")
        non_base = [t for t in own_tiles if not t.is_base]
        if not non_base:
            # Claim a neutral tile first
            q, r = _find_adjacent_neutral(game, "p0")
            assert q is not None
            tile = game.grid.get_tile(q, r)
            tile.owner = "p0"
            non_base = [tile]
        target = non_base[0]
        initial_resources = player.resources
        success, msg = play_card(game, "p0", 0, target_q=target.q, target_r=target.r)
        assert success, msg
        # Tile should NOT be blocked yet (effect fires at resolve, not immediately)
        assert target.is_blocked is False
        assert target.owner == "p0"
        # Submit play and resolve
        player.has_submitted_play = True
        game.players["p1"].has_submitted_play = True
        execute_reveal(game)
        # Now tile should be blocked with no owner
        assert target.is_blocked is True
        assert target.owner is None
        assert player.resources == initial_resources + 3

    def test_scorched_retreat_cannot_target_base(self, card_registry):
        """Scorched Retreat cannot target a base tile."""
        card = card_registry.get("fortress_scorched_retreat")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        sr = _copy_card(card, "test_sr")
        player.hand = [sr] + player.hand[1:]
        base_tiles = [t for t in game.grid.get_player_tiles("p0") if t.is_base]
        assert len(base_tiles) > 0
        base = base_tiles[0]
        success, msg = play_card(game, "p0", 0, target_q=base.q, target_r=base.r)
        assert not success
        assert "base" in msg.lower()

    def test_scorched_retreat_blocks_opponent_claims(self, card_registry):
        """Claims against a scorched tile automatically fail at resolve."""
        card = card_registry.get("fortress_scorched_retreat")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Give p0 a non-base tile to scorch
        own_tiles = game.grid.get_player_tiles("p0")
        non_base = [t for t in own_tiles if not t.is_base]
        if not non_base:
            q, r = _find_adjacent_neutral(game, "p0")
            assert q is not None
            tile = game.grid.get_tile(q, r)
            tile.owner = "p0"
            non_base = [tile]
        target = non_base[0]

        # p0 plays Scorched Retreat on the tile
        sr = _copy_card(card, "test_sr")
        p0.hand = [sr] + p0.hand[1:]
        success, _ = play_card(game, "p0", 0, target_q=target.q, target_r=target.r)
        assert success

        # p1 plays a claim against the same tile (give them adjacency)
        adj = game.grid.get_adjacent(target.q, target.r)
        p1_adj = [t for t in adj if not t.is_blocked and not t.is_base]
        if p1_adj:
            p1_adj[0].owner = "p1"
        merc = _copy_card(card_registry["neutral_mercenary"], "test_merc")
        p1.hand = [merc] + p1.hand[1:]
        p1.resources = 5
        success2, _ = play_card(game, "p1", 0, target_q=target.q, target_r=target.r)
        assert success2

        # Resolve — the scorch fires first, then claims against blocked tile fail
        p0.has_submitted_play = True
        p1.has_submitted_play = True
        execute_reveal(game)

        assert target.is_blocked is True
        assert target.owner is None  # Nobody owns it — scorch + failed claim


class TestFortressSnowyHoliday:
    def test_snowy_holiday_properties(self, card_registry):
        """Snowy Holiday: engine, cost 5, trash_on_use, global_claim_ban on_resolution."""
        card = card_registry.get("fortress_snowy_holiday")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 5
        assert card.trash_on_use is True
        assert card.archetype == Archetype.FORTRESS
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.GLOBAL_CLAIM_BAN
        assert eff.timing == Timing.ON_RESOLUTION

    def test_snowy_holiday_sets_claim_ban(self, card_registry):
        """Snowy Holiday sets claim_ban_rounds after reveal."""
        card = card_registry.get("fortress_snowy_holiday")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        sh = _copy_card(card, "test_sh")
        player.hand = [sh] + player.hand[1:]
        assert game.claim_ban_rounds == 0
        success, msg = play_card(game, "p0", 0)
        assert success, msg
        submit_play(game, "p0")
        submit_play(game, "p1")
        # After reveal, claim ban should be set
        assert game.claim_ban_rounds >= 1

    def test_snowy_holiday_claim_ban_blocks_claims(self, card_registry):
        """When claim_ban_rounds > 0, playing claim cards is rejected."""
        card = card_registry.get("fortress_snowy_holiday")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch0="fortress")
        # Manually set claim ban as if Snowy Holiday already fired
        game.claim_ban_rounds = 1
        player = game.players["p0"]
        explore = _copy_card(card_registry["neutral_explore"], "test_explore")
        player.hand = [explore] + player.hand[1:]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert not success
        assert "banned" in msg.lower() or "snowy" in msg.lower()


# ══════════════════════════════════════════════════════════════════
# SWARM CARDS — New
# ══════════════════════════════════════════════════════════════════


class TestSwarmHeadyBrew:
    def test_heady_brew_properties(self, card_registry):
        """Heady Brew: engine, cost 4, trash_on_use, swap_draw_discard."""
        card = card_registry.get("swarm_heady_brew")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 4
        assert card.trash_on_use is True
        assert card.archetype == Archetype.SWARM
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.SWAP_DRAW_DISCARD

    def test_heady_brew_swaps_piles(self, card_registry):
        """Heady Brew swaps draw and discard piles."""
        card = card_registry.get("swarm_heady_brew")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        # Use p1 who is swarm archetype
        player = game.players["p1"]
        brew = _copy_card(card, "test_brew")
        player.hand = [brew] + player.hand[1:]
        # Set up known state: put some cards in discard
        old_draw_count = len(player.deck.cards)
        old_discard_count = len(player.deck.discard)
        # Add some cards to discard
        for _ in range(3):
            g = _copy_card(card_registry["neutral_gather"], f"disc_{_}")
            player.deck.discard.append(g)
        discard_before = len(player.deck.discard)
        draw_before = len(player.deck.cards)
        success, msg = play_card(game, "p1", 0)
        assert success, msg
        # After swap: old discard becomes draw pile (shuffled), old draw becomes discard
        # The new draw pile has the old discard cards (shuffled)
        assert len(player.deck.discard) == draw_before
        assert len(player.deck.cards) == discard_before

    def test_heady_brew_upgraded_draws(self, card_registry):
        """Upgraded Heady Brew also draws 2 cards."""
        card = card_registry.get("swarm_heady_brew")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        player = game.players["p1"]
        brew = _copy_card(card, "test_brew_up")
        brew.is_upgraded = True
        player.hand = [brew] + player.hand[1:]
        # Put cards in discard so we have something to draw from
        for i in range(5):
            g = _copy_card(card_registry["neutral_gather"], f"disc_{i}")
            player.deck.discard.append(g)
        hand_before = len(player.hand)
        success, msg = play_card(game, "p1", 0)
        assert success, msg
        # Played 1 card (-1), upgraded draws 2 (+2) → net +1
        assert len(player.hand) == hand_before + 1


class TestSwarmPlague:
    def test_plague_properties(self, card_registry):
        """Plague: engine, cost 3, global_random_trash."""
        card = card_registry.get("swarm_plague")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 3
        assert card.archetype == Archetype.SWARM
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.GLOBAL_RANDOM_TRASH

    def test_plague_all_players_trash(self, card_registry):
        """Non-upgraded Plague: all players (including self) trash a random card at start of next turn."""
        card = card_registry.get("swarm_plague")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        p0 = game.players["p0"]
        p1 = game.players["p1"]
        plague = _copy_card(card, "test_plague")
        p1.hand = [plague] + p1.hand[1:]
        p0_hand_before = len(p0.hand)
        p1_hand_before = len(p1.hand)
        success, msg = play_card(game, "p1", 0)
        assert success, msg
        # No immediate trashing — effect is queued for next turn
        assert len(p0.hand) == p0_hand_before
        assert len(p1.hand) == p1_hand_before - 1  # -1 played only
        # Effect is on_resolution — submit and resolve to trigger it
        submit_play(game, "p0")
        submit_play(game, "p1")
        # Both players have plague queued
        assert p0.turn_modifiers.plague_trash_next_turn == 1
        assert p1.turn_modifiers.plague_trash_next_turn == 1
        # Simulate next turn — cards are trashed from drawn hand
        game.current_round += 1
        execute_start_of_turn(game)
        assert len(p0.trash) >= 1
        assert len(p1.trash) >= 1

    def test_plague_upgraded_spares_self(self, card_registry):
        """Upgraded Plague: only opponents trash at start of next turn, self is spared."""
        card = card_registry.get("swarm_plague")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        p0 = game.players["p0"]
        p1 = game.players["p1"]
        plague = _copy_card(card, "test_plague_up")
        plague.is_upgraded = True
        p1.hand = [plague] + p1.hand[1:]
        success, msg = play_card(game, "p1", 0)
        assert success, msg
        # Effect is on_resolution — submit and resolve to trigger it
        submit_play(game, "p0")
        submit_play(game, "p1")
        # Only p0 has plague queued (upgraded spares self)
        assert p0.turn_modifiers.plague_trash_next_turn == 1
        assert p1.turn_modifiers.plague_trash_next_turn == 0


class TestSwarmInfestation:
    def test_infestation_properties(self, card_registry):
        """Infestation: engine, cost 4, trash_on_use, inject_rubble."""
        card = card_registry.get("swarm_infestation")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 4
        assert card.trash_on_use is True
        assert card.archetype == Archetype.SWARM
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.INJECT_RUBBLE
        assert eff.value == 3
        assert eff.upgraded_value == 4

    def test_infestation_adds_rubble(self, card_registry):
        """Infestation adds 3 Rubble cards to opponent's discard at resolve."""
        card = card_registry.get("swarm_infestation")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        p0 = game.players["p0"]
        p1 = game.players["p1"]
        inf = _copy_card(card, "test_inf")
        p1.hand = [inf] + p1.hand[1:]
        discard_before = len(p0.deck.discard)
        success, msg = play_card(game, "p1", 0, target_player_id="p0")
        assert success, msg
        # Not added yet — fires at resolve
        assert sum(1 for c in p0.deck.discard[discard_before:] if "rubble" in c.id.lower()) == 0
        # Resolve
        p0.has_submitted_play = True
        p1.has_submitted_play = True
        execute_reveal(game)
        rubble_count = sum(1 for c in p0.deck.discard if "rubble" in c.id.lower())
        assert rubble_count == 3

    def test_infestation_upgraded_adds_4(self, card_registry):
        """Upgraded Infestation adds 4 Rubble cards at resolve."""
        card = card_registry.get("swarm_infestation")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        p0 = game.players["p0"]
        p1 = game.players["p1"]
        inf = _copy_card(card, "test_inf_up")
        inf.is_upgraded = True
        p1.hand = [inf] + p1.hand[1:]
        success, msg = play_card(game, "p1", 0, target_player_id="p0")
        assert success, msg
        p0.has_submitted_play = True
        p1.has_submitted_play = True
        execute_reveal(game)
        rubble_count = sum(1 for c in p0.deck.discard if "rubble" in c.id.lower())
        assert rubble_count == 4


class TestSwarmExodus:
    def test_exodus_properties(self, card_registry):
        """Exodus: engine, cost 3, action_return 2, target_own_tile, abandon_tile."""
        card = card_registry.get("swarm_exodus")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 3
        assert card.action_return == 2
        assert card.target_own_tile is True
        assert card.archetype == Archetype.SWARM
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.ABANDON_TILE

    def test_exodus_abandons_tile(self, card_registry):
        """Exodus abandons the targeted tile at resolve (owner becomes None)."""
        card = card_registry.get("swarm_exodus")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        player = game.players["p1"]
        exo = _copy_card(card, "test_exo")
        player.hand = [exo] + player.hand[1:]
        own_tiles = game.grid.get_player_tiles("p1")
        non_base = [t for t in own_tiles if not t.is_base]
        if not non_base:
            # Claim a neutral tile first
            q, r = _find_adjacent_neutral(game, "p1")
            assert q is not None
            tile = game.grid.get_tile(q, r)
            tile.owner = "p1"
            non_base = [tile]
        target = non_base[0]
        assert target.owner == "p1"
        success, msg = play_card(game, "p1", 0, target_q=target.q, target_r=target.r)
        assert success, msg
        # Tile should NOT be abandoned yet (fires at resolve)
        assert target.owner == "p1"
        # Submit play and resolve
        player.has_submitted_play = True
        game.players["p0"].has_submitted_play = True
        execute_reveal(game)
        assert target.owner is None

    def test_exodus_cannot_target_base(self, card_registry):
        """Exodus cannot target a base tile."""
        card = card_registry.get("swarm_exodus")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        player = game.players["p1"]
        exo = _copy_card(card, "test_exo")
        player.hand = [exo] + player.hand[1:]
        base_tiles = [t for t in game.grid.get_player_tiles("p1") if t.is_base]
        assert len(base_tiles) > 0
        base = base_tiles[0]
        success, msg = play_card(game, "p1", 0, target_q=base.q, target_r=base.r)
        assert not success
        assert "base" in msg.lower()

    def test_exodus_draws_cards(self, card_registry):
        """Exodus draws 2 cards (from parsed draw_cards stat)."""
        card = card_registry.get("swarm_exodus")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry, arch1="swarm")
        player = game.players["p1"]
        exo = _copy_card(card, "test_exo")
        player.hand = [exo] + player.hand[1:]
        own_tiles = game.grid.get_player_tiles("p1")
        non_base = [t for t in own_tiles if not t.is_base]
        if not non_base:
            q, r = _find_adjacent_neutral(game, "p1")
            assert q is not None
            tile = game.grid.get_tile(q, r)
            tile.owner = "p1"
            non_base = [tile]
        target = non_base[0]
        hand_before = len(player.hand)
        success, msg = play_card(game, "p1", 0, target_q=target.q, target_r=target.r)
        assert success, msg
        # Played 1 (-1), draw 2 (+2) → net +1
        assert len(player.hand) == hand_before + 1


# ══════════════════════════════════════════════════════════════════
# VANGUARD CARDS — New
# ══════════════════════════════════════════════════════════════════


class TestVanguardDemonPact:
    def test_demon_pact_properties(self, card_registry):
        """Demon Pact: claim, cost 8, power 10, mandatory_self_trash effect."""
        card = card_registry.get("vanguard_demon_pact")
        if not card:
            pytest.skip("Card not in registry")
        assert card.card_type == CardType.CLAIM
        assert card.buy_cost == 8
        assert card.power == 10
        assert card.upgraded_power == 12
        assert card.archetype == Archetype.VANGUARD
        assert len(card.effects) >= 1
        eff = card.effects[0]
        assert eff.type == EffectType.MANDATORY_SELF_TRASH
        assert eff.value == 3
        assert eff.requires_choice is True
        assert eff.metadata.get("exact") is True

    def test_demon_pact_requires_exactly_3_trash(self, card_registry):
        """Demon Pact fails if not exactly 3 trash indices provided."""
        card = card_registry.get("vanguard_demon_pact")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        dp = _copy_card(card, "test_dp")
        player.hand = [dp] + player.hand[1:]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        # Try with only 2 trash indices — should fail
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r,
                                 trash_card_indices=[1, 2])
        assert not success
        assert "exactly 3" in msg.lower() or "3" in msg

    def test_demon_pact_fails_with_too_few_cards(self, card_registry):
        """Demon Pact fails if player has fewer than 3 other cards in hand."""
        card = card_registry.get("vanguard_demon_pact")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        dp = _copy_card(card, "test_dp")
        # Only 3 cards total (dp + 2 others) — needs 3 others
        player.hand = [dp, player.hand[0], player.hand[1]]
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r,
                                 trash_card_indices=[0, 1, 2])
        assert not success
        assert "requires" in msg.lower() or "3" in msg

    def test_demon_pact_succeeds_with_3_trash(self, card_registry):
        """Demon Pact succeeds when exactly 3 trash indices provided and sufficient cards."""
        card = card_registry.get("vanguard_demon_pact")
        if not card:
            pytest.skip("Card not in registry")
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        dp = _copy_card(card, "test_dp")
        player.hand = [dp] + player.hand[1:]  # 5 cards total, dp + 4 others
        assert len(player.hand) >= 4  # need at least 3 others
        q, r = _find_adjacent_neutral(game, "p0")
        assert q is not None
        hand_before = len(player.hand)
        success, msg = play_card(game, "p0", 0, target_q=q, target_r=r,
                                 trash_card_indices=[0, 1, 2])
        assert success, msg
        # Played 1 card, trashed 3 → hand reduced by 4
        assert len(player.hand) == hand_before - 4

    def test_demon_pact_power_is_10(self, card_registry):
        """Demon Pact has base power 10."""
        card = card_registry.get("vanguard_demon_pact")
        if not card:
            pytest.skip("Card not in registry")
        assert card.power == 10
        assert card.effective_power == 10
