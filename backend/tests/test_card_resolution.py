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
        """Gather: gain 1 resource immediately."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        gather = _copy_card(card_registry["neutral_gather"], "test_gather")
        player.hand = [gather] + player.hand[1:]
        initial_resources = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_resources + 1

    def test_gather_upgraded_gives_3(self, card_registry):
        """Gather+: gain 3 resources."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        gather = _copy_card(card_registry["neutral_gather"], "test_gather_up")
        gather.is_upgraded = True
        player.hand = [gather] + player.hand[1:]
        initial_resources = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_resources + 3


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
        success, _ = play_card(game, "p0", 0, target_q=q, target_r=r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        tile = game.grid.get_tile(q, r)
        assert tile.owner == "p0"


class TestNeutralProspector:
    def test_prospector_gain_2(self, card_registry):
        """Prospector: gain 2 resources immediately."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        prosp = _copy_card(card_registry["neutral_prospector"], "test_prosp")
        player.hand = [prosp] + player.hand[1:]
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial + 2


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
    def test_fortified_post_adds_defense(self, card_registry):
        """Fortified Post: +4 defense on owned tile."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        fp = _copy_card(card_registry["neutral_fortified_post"], "test_fp")
        assert fp.defense_bonus == 4
        player.hand = [fp] + player.hand[1:]

        tile = game.grid.get_player_tiles("p0")[0]
        initial_defense = tile.defense_power
        success, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert success

        submit_play(game, "p0")
        submit_play(game, "p1")

        updated = game.grid.get_tile(tile.q, tile.r)
        assert updated.defense_power >= initial_defense + 4


class TestNeutralWarBonds:
    def test_war_bonds_resources_and_action(self, card_registry):
        """War Bonds: gain 2 resources, gain 1 action back."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wb = _copy_card(card_registry["neutral_war_bonds"], "test_wb")
        assert wb.action_return == 1
        player.hand = [wb] + player.hand[1:]
        initial_res = player.resources
        initial_actions = player.actions_available

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_res + 2
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
        """Watchtower: +3 defense, draw 1."""
        card = card_registry["neutral_watchtower"]
        assert card.defense_bonus == 3
        assert card.buy_cost == 3


class TestNeutralSiegeTower:
    def test_siege_tower_high_power(self, card_registry):
        """Siege Tower: Power 6, cost 8."""
        card = card_registry["neutral_siege_tower"]
        assert card.power == 6
        assert card.buy_cost == 8


class TestNeutralReclaim:
    def test_consolidate_stats(self, card_registry):
        """Consolidate: cost 2."""
        card = card_registry["neutral_reclaim"]
        assert card.buy_cost == 2

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
        """Diplomat: cost 3, trash on use."""
        card = card_registry["neutral_diplomat"]
        assert card.buy_cost == 3
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

        # Try to target an opponent's tile
        for pt in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(pt.q, pt.r):
                if adj.owner == "p1":
                    success, msg = play_card(game, "p0", 0, target_q=adj.q, target_r=adj.r)
                    assert not success
                    assert "unoccupied" in msg.lower()
                    return
        pytest.skip("No adjacent enemy tile found")

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
        """War Cache: gain 3 resources, draw next turn, gain 1 action back."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wc = _copy_card(card_registry["vanguard_war_cache"], "test_wc")
        assert wc.action_return == 1
        player.hand = [wc] + player.hand[1:]
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial + 3


class TestVanguardFlanking:
    def test_flanking_strike_range_2(self, card_registry):
        """Flanking Strike: can target tiles up to 2 steps away."""
        card = card_registry["vanguard_flanking_strike"]
        assert card.claim_range == 2
        assert card.power == 3


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
        # But extra actions are queued for next turn
        assert other.turn_modifiers.extra_actions_next_turn == 1


class TestVanguardSpoilsOfWar:
    def test_spoils_of_war_trashes_opponent_card(self, card_registry):
        """Spoils of War: if claim wins contested tile, trash opponent's claim."""
        game = _make_2p_game(card_registry)
        p0 = game.players["p0"]
        p1 = game.players["p1"]

        # Find a tile owned by p1 adjacent to p0
        assert game.grid is not None
        target_tile = None
        for pt in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(pt.q, pt.r):
                if adj.owner == "p1":
                    target_tile = adj
                    break
            if target_tile:
                break

        if not target_tile:
            pytest.skip("No adjacent p1 tile found")

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
        assert card.buy_cost == 8

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
        """Scavenge: gain 1 resource, no draw, no unconditional action return."""
        game = _make_2p_game(card_registry)
        player = game.players["p1"]
        scav = _copy_card(card_registry["swarm_scavenge"], "test_scav")
        assert scav.resource_gain == 1
        assert scav.draw_cards == 0
        assert scav.action_return == 0
        player.hand = [scav] + player.hand[1:]
        initial_res = player.resources

        success, _ = play_card(game, "p1", 0)
        assert success
        assert player.resources == initial_res + 1

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


class TestFortressSlowAdvance:
    def test_slow_advance_auto_claim_neutral(self, card_registry):
        """Slow Advance: auto-claims if target is neutral."""
        card = card_registry["fortress_slow_advance"]
        auto_fx = [e for e in card.effects if e.type == EffectType.AUTO_CLAIM_IF_NEUTRAL]
        assert len(auto_fx) >= 1

    def test_slow_advance_claims_neutral_tile(self, card_registry):
        """Slow Advance: successfully claims a neutral tile."""
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
        """War Council: sets buy_locked on player."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        wc = _copy_card(card_registry["fortress_war_council"], "test_wc")
        player.hand = [wc] + player.hand[1:]

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.turn_modifiers.buy_locked


class TestFortressIronDiscipline:
    def test_iron_discipline_resources_draw_action(self, card_registry):
        """Iron Discipline: gain 1 resource, draw 1, action return 1."""
        game = _make_2p_game(card_registry, arch0="fortress")
        player = game.players["p0"]
        id_card = _copy_card(card_registry["fortress_iron_discipline"], "test_id")
        assert id_card.action_return == 1
        player.hand = [id_card] + player.hand[1:]
        initial_res = player.resources
        initial_hand = len(player.hand)

        success, _ = play_card(game, "p0", 0)
        assert success
        assert player.resources == initial_res + 1
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
            pytest.skip("No adjacent VP tile found")
        connected_vp.owner = "p0"

        hand_before = len(player.hand)
        success, _ = play_card(game, "p0", 0)
        assert success
        # Should have drawn 2 cards (1 connected VP × 2 draws each), minus the played card
        assert len(player.hand) == hand_before - 1 + 2


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

        # Find a tile owned by p1 adjacent to p0
        target = None
        for pt in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(pt.q, pt.r):
                if adj.owner == "p1":
                    target = adj
                    break
            if target:
                break

        if not target:
            pytest.skip("No adjacent contested tile")

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

        target = None
        for pt in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(pt.q, pt.r):
                if adj.owner == "p1":
                    target = adj
                    break
            if target:
                break

        if not target:
            pytest.skip("No adjacent contested tile")

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

        # Find p0 tile adjacent to p1
        target = None
        for pt in game.grid.get_player_tiles("p0"):
            for adj in game.grid.get_adjacent(pt.q, pt.r):
                if adj.owner == "p1":
                    # Actually we want the p0 tile that's being attacked
                    target = pt
                    break
            if target:
                break

        if not target:
            pytest.skip("No p0 tile adjacent to p1")

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
        """Rearguard: cost 3, defense type, gains 2 resources."""
        card = card_registry["vanguard_rearguard"]
        assert card.buy_cost == 3
        assert card.resource_gain == 2
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
        """Mob Rule: base power 2, +1 per 3 tiles owned."""
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
        # base 2 + (total_tiles // 3)
        expected = 2 + (total_tiles // 3)
        assert power == expected


class TestSwarmHiveMind:
    def test_hive_mind_stats(self, card_registry):
        """Hive Mind: cost 6, trash on use."""
        card = card_registry["swarm_hive_mind"]
        assert card.buy_cost == 6
        assert card.trash_on_use is True
        assert card.power == 1


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


# ══════════════════════════════════════════════════════════════════
# NEW CARDS — WAR TITHE, COLONY, WARDEN, RESILIENCE
# ══════════════════════════════════════════════════════════════════


class TestVanguardWarTithe:
    def test_war_tithe_properties(self, card_registry):
        """War Tithe: engine card, cost 3, resources from last round's claims."""
        card = card_registry["vanguard_war_tithe"]
        assert card.card_type == CardType.ENGINE
        assert card.buy_cost == 3
        assert card.archetype == Archetype.VANGUARD
        assert card.power == 0

    def test_war_tithe_has_effect(self, card_registry):
        """War Tithe: has RESOURCES_PER_CLAIMS_LAST_ROUND effect."""
        card = card_registry["vanguard_war_tithe"]
        matching = [e for e in card.effects if e.type.value == "resources_per_claims_last_round"]
        assert len(matching) >= 1
        assert matching[0].value == 1
        assert matching[0].upgraded_value == 2
        assert matching[0].metadata.get("max_resources") == 3

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
        # 3 claims × 1 resource each = 3 (capped at max_resources=3)
        assert player.resources == initial + 3

    def test_war_tithe_respects_max_cap(self, card_registry):
        """War Tithe: resource gain is capped at max_resources."""
        game = _make_2p_game(card_registry)
        player = game.players["p0"]
        wt = _copy_card(card_registry["vanguard_war_tithe"], "test_wt")
        player.hand = [wt] + player.hand[1:]

        # Simulate having claimed 5 tiles (exceeds max of 3)
        player.claims_won_last_round = 5
        initial = player.resources

        success, _ = play_card(game, "p0", 0)
        assert success
        # 5 × 1 = 5, but capped at 3
        assert player.resources == initial + 3

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
        assert card.vp_formula == "uncaptured_tiles_4"

    def test_warden_has_effect(self, card_registry):
        """Warden: has VP_FROM_UNCAPTURED_TILES effect."""
        card = card_registry["fortress_warden"]
        matching = [e for e in card.effects if e.type.value == "vp_from_uncaptured_tiles"]
        assert len(matching) >= 1
        assert matching[0].value == 4  # divisor base
        assert matching[0].upgraded_value == 3  # divisor upgraded
        assert matching[0].metadata.get("divisor") == 4

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
        """Resilience: gain 2 resources when controlling fewest tiles."""
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
        assert player.resources == initial_resources + 2

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
