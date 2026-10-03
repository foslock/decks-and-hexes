"""Regression tests for the card balance pass (docs/card_balance_audit.md).

One focused test per audit bug (B1–B15), plus the Rubble-per-raid cap, the
VP-target tie-break, and the reworked cards whose mechanics changed in code.
All tests run against the real card registry loaded from data/*.yaml.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.game_engine.cards import CardType, _copy_card, make_land_grant_card
from app.game_engine.cpu_player import CPUPlayer, HARD, _projected_formula_vp
from app.game_engine.cpu_valuation import build_context, estimated_claim_power
from app.game_engine.effect_resolver import (
    _handle_vp_from_contested_wins,
    EffectContext,
    calculate_effective_power,
    check_condition,
)
from app.game_engine.effects import ConditionType, EffectType
from app.game_engine.game_state import (
    GameState,
    Phase,
    PlannedAction,
    RAID_RUBBLE_CAP,
    _compute_formula_vp,
    compute_player_vp,
    create_game,
    execute_end_of_turn,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_play,
)
from app.game_engine.hex_grid import GridSize, HexTile


# ── Helpers ────────────────────────────────────────────────────────


def _game(reg: dict[str, Any], a0: str = "vanguard", a1: str = "swarm", seed: int = 42) -> GameState:
    game = create_game(
        GridSize.SMALL,
        [
            {"id": "p0", "name": "Alice", "archetype": a0},
            {"id": "p1", "name": "Bob", "archetype": a1},
        ],
        reg,
        seed=seed,
    )
    execute_start_of_turn(game)
    execute_upkeep(game)
    return game


_uid = [0]


def _give(game: GameState, reg: dict[str, Any], pid: str, card_id: str, upgraded: bool = False):
    """Put a fresh copy of *card_id* at the front of *pid*'s hand."""
    _uid[0] += 1
    card = _copy_card(reg[card_id], f"bp{_uid[0]}")
    card.is_upgraded = upgraded
    game.players[pid].hand.insert(0, card)
    return card


def _plain(tile: HexTile) -> HexTile:
    tile.is_vp = False
    tile.vp_value = 1
    tile.base_defense = 0
    tile.defense_power = 0
    tile.permanent_defense_bonus = 0
    return tile


def _neutral_adjacent(game: GameState, pid: str, exclude: tuple[tuple[int, int], ...] = ()) -> HexTile:
    """A neutral, defenseless, non-VP tile adjacent to *pid*'s territory."""
    assert game.grid is not None
    for t in game.grid.get_player_tiles(pid):
        for a in game.grid.get_adjacent(t.q, t.r):
            if a.owner is None and not a.is_base and (a.q, a.r) not in exclude:
                return _plain(a)
    raise AssertionError("no neutral tile adjacent")


def _base(game: GameState, pid: str) -> HexTile:
    assert game.grid is not None
    return next(t for t in game.grid.tiles.values() if t.is_base and t.base_owner == pid)


def _reveal(game: GameState) -> None:
    for pid in game.player_order:
        if not game.players[pid].has_submitted_play:
            submit_play(game, pid)
    assert game.current_phase == Phase.REVEAL


def _contested_tile(game: GameState, owner: str, attacker: str) -> HexTile:
    """A defenseless tile owned by *owner* that *attacker* can claim."""
    tile = _neutral_adjacent(game, attacker)
    tile.owner = owner
    return tile


# ── B1: Juggernaut pays +2 only for a neutral target ───────────────


class TestB1Juggernaut:
    def test_neutral_target_pays_two(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        _give(game, card_registry, "p0", "fortress_overwhelming_force")
        tile = _neutral_adjacent(game, "p0")
        before = p0.resources
        ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok, msg
        assert p0.resources == before + 2
        _reveal(game)
        assert p0.resources == before + 2  # no second payout at resolution

    def test_enemy_target_pays_nothing(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        _give(game, card_registry, "p0", "fortress_overwhelming_force")
        tile = _contested_tile(game, owner="p1", attacker="p0")
        before = p0.resources
        ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok, msg
        _reveal(game)
        assert tile.owner == "p0"  # the claim won...
        assert p0.resources == before  # ...but an enemy tile pays nothing

    def test_upgraded_pays_three(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        _give(game, card_registry, "p0", "fortress_overwhelming_force", upgraded=True)
        tile = _neutral_adjacent(game, "p0")
        before = p0.resources
        ok, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        assert p0.resources == before + 3


# ── B2: Robin Hood / Pursuit count only real captures ──────────────


class TestB2TilesLost:
    def test_own_defense_cards_are_not_losses(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        extra = _neutral_adjacent(game, "p0")
        extra.owner = "p0"
        tiles = game.grid.get_player_tiles("p0")
        assert len(tiles) >= 3
        _give(game, card_registry, "p0", "fortress_bulwark", upgraded=True)
        ok, msg = play_card(
            game, "p0", 0, target_q=tiles[0].q, target_r=tiles[0].r,
            extra_targets=[(t.q, t.r) for t in tiles[1:3]],
        )
        assert ok, msg
        _reveal(game)
        assert p0.tiles_lost_last_round == 0

    def test_capture_counts_for_both_sides(self, card_registry):
        game = _game(card_registry)
        tile = _contested_tile(game, owner="p0", attacker="p1")
        _give(game, card_registry, "p1", "vanguard_blitz")
        ok, msg = play_card(game, "p1", 0, target_q=tile.q, target_r=tile.r)
        assert ok, msg
        _reveal(game)
        assert tile.owner == "p1"
        assert game.players["p0"].tiles_lost_last_round == 1
        assert game.players["p1"].tiles_captured_from_opponents_last_round == 1

    def test_failed_attack_is_not_a_loss(self, card_registry):
        game = _game(card_registry)
        tile = _contested_tile(game, owner="p0", attacker="p1")
        tile.defense_power = tile.base_defense = 5
        _give(game, card_registry, "p1", "vanguard_blitz")
        ok, _ = play_card(game, "p1", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        _reveal(game)
        assert tile.owner == "p0"
        assert game.players["p0"].tiles_lost_last_round == 0


# ── Rubble cap + base raids aren't captures ────────────────────────


class TestRaidRubbleCap:
    def test_big_raid_gives_one_rubble_and_one_spoils(self, card_registry):
        assert RAID_RUBBLE_CAP == 1
        game = _game(card_registry)
        base = _base(game, "p0")
        assert base.defense_power == 3
        perch = next(a for a in game.grid.get_adjacent(base.q, base.r) if a.owner is None)
        perch.owner = "p1"
        _give(game, card_registry, "p1", "vanguard_spearhead")  # power 8 vs defense 3
        ok, msg = play_card(game, "p1", 0, target_q=base.q, target_r=base.r)
        assert ok, msg
        _reveal(game)
        p0, p1 = game.players["p0"], game.players["p1"]
        assert base.owner == "p0"
        assert sum(1 for c in p0.deck.discard if c.name == "Rubble") == 1
        assert sum(1 for c in p1.deck.discard if c.name == "Spoils") == 1
        # B2: a raided base is not a captured tile
        assert p0.tiles_lost_last_round == 0
        assert p1.tiles_captured_from_opponents_last_round == 0


# ── B3: Cease Fire+ draws 3 ────────────────────────────────────────


def test_b3_cease_fire_upgraded_draws_three(card_registry):
    game = _game(card_registry)
    p0 = game.players["p0"]
    _give(game, card_registry, "p0", "neutral_cease_fire", upgraded=True)
    ok, _ = play_card(game, "p0", 0)
    assert ok
    _reveal(game)
    assert p0.turn_modifiers.extra_draws_next_turn == 3


# ── B4: Counterattack draws when an opponent's claim fails ─────────


class TestB4Counterattack:
    def _setup(self, card_registry):
        game = _game(card_registry)
        tile = _contested_tile(game, owner="p0", attacker="p1")
        card = _give(game, card_registry, "p0", "vanguard_counterattack")
        assert card.defense_bonus == 3
        ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok, msg
        return game, tile

    def test_failed_opponent_claim_draws_next_round(self, card_registry):
        game, tile = self._setup(card_registry)
        _give(game, card_registry, "p1", "vanguard_blitz")  # power 2 vs defense 3
        ok, _ = play_card(game, "p1", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        _reveal(game)
        assert tile.owner == "p0"
        assert game.players["p0"].turn_modifiers.extra_draws_next_turn == 1
        assert not any("[STUB]" in m for m in game.log)

    def test_no_attack_no_draw(self, card_registry):
        game, tile = self._setup(card_registry)
        _reveal(game)
        assert game.players["p0"].turn_modifiers.extra_draws_next_turn == 0

    def test_successful_attack_no_draw(self, card_registry):
        game, tile = self._setup(card_registry)
        _give(game, card_registry, "p1", "vanguard_spearhead")  # power 8
        ok, _ = play_card(game, "p1", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        _reveal(game)
        assert tile.owner == "p1"
        assert game.players["p0"].turn_modifiers.extra_draws_next_turn == 0


# ── B5 / B6: no double draws from card text ────────────────────────


def test_b5_dividends_upgraded_draws_exactly_one(card_registry):
    game = _game(card_registry)
    p0 = game.players["p0"]
    _give(game, card_registry, "p0", "neutral_dividends", upgraded=True)
    p0.resources = 4
    hand_before = len(p0.hand)
    ok, _ = play_card(game, "p0", 0)
    assert ok
    assert len(p0.hand) == hand_before  # played 1, drew 1
    assert p0.resources == 4 + 2  # 1 per 2 held


def test_b6_war_tithe_upgraded_draws_next_round_only(card_registry):
    game = _game(card_registry)
    p0 = game.players["p0"]
    p0.claims_won_last_round = 2
    _give(game, card_registry, "p0", "vanguard_war_tithe", upgraded=True)
    hand_before = len(p0.hand)
    res_before = p0.resources
    ok, _ = play_card(game, "p0", 0)
    assert ok
    assert len(p0.hand) == hand_before - 1  # no immediate draw
    assert p0.resources == res_before + 4
    assert p0.turn_modifiers.extra_draws_next_turn == 1
    assert "next round" in card_registry["vanguard_war_tithe"].upgrade_description


# ── B7: Ambush is power 4 against opponent-owned tiles (text matches) ─


def test_b7_ambush_vs_enemy_tile(card_registry):
    game = _game(card_registry)
    p0 = game.players["p0"]
    card = _give(game, card_registry, "p0", "neutral_ambush")
    tile = _contested_tile(game, owner="p1", attacker="p0")
    action = PlannedAction(card=card, target_q=tile.q, target_r=tile.r)
    assert calculate_effective_power(game, p0, card, action) == 4
    assert "owned by an opponent" in card.description


# ── B8: Rally Cry+ gives +1 power ──────────────────────────────────


class TestB8RallyCry:
    def test_upgraded_buffs_next_claims(self, card_registry):
        game = _game(card_registry)
        p0 = game.players["p0"]
        _give(game, card_registry, "p0", "neutral_rally_cry", upgraded=True)
        ok, _ = play_card(game, "p0", 0)
        assert ok
        blitz = _give(game, card_registry, "p0", "vanguard_blitz")
        tile = _neutral_adjacent(game, "p0")
        ok, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        action = p0.planned_actions[-1]
        assert action.card is blitz
        assert action.effective_power == blitz.power + 1

    def test_base_has_no_power_buff(self, card_registry):
        game = _game(card_registry)
        _give(game, card_registry, "p0", "neutral_rally_cry")
        ok, _ = play_card(game, "p0", 0)
        assert ok
        assert game.players["p0"].turn_modifiers.claim_buffs == []


# ── B9: generated Rabbles chain with each other ────────────────────


def test_b9_hatching_grounds_rabbles_chain(card_registry):
    game = _game(card_registry)
    p1 = game.players["p1"]
    _give(game, card_registry, "p1", "swarm_hatching_grounds")
    ok, _ = play_card(game, "p1", 0)
    assert ok
    rabbles = [c for c in p1.deck.discard if c.definition_id == "swarm_rabble"]
    assert len(rabbles) == 3
    assert len({c.id for c in rabbles}) == 3
    for r in rabbles[:2]:
        p1.deck.discard.remove(r)
        p1.hand.insert(0, r)
    t1 = _neutral_adjacent(game, "p1")
    t2 = _neutral_adjacent(game, "p1", exclude=((t1.q, t1.r),))
    ok, _ = play_card(game, "p1", 0, target_q=t1.q, target_r=t1.r)
    assert ok
    actions_after_first = p1.actions_available
    ok, _ = play_card(game, "p1", 0, target_q=t2.q, target_r=t2.r)
    assert ok
    assert p1.actions_available == actions_after_first + 1


# ── B10: Breakthrough only auto-claims defenseless tiles ───────────


class TestB10Breakthrough:
    def _setup(self, card_registry, leave_one_open: bool):
        game = _game(card_registry)
        target = _neutral_adjacent(game, "p0")
        neighbours = [a for a in game.grid.get_adjacent(target.q, target.r) if a.owner is None]
        assert neighbours
        for a in neighbours:
            a.base_defense = a.defense_power = 3  # e.g. a premium VP hex
        open_tile = None
        if leave_one_open:
            open_tile = _plain(neighbours[0])
        _give(game, card_registry, "p0", "vanguard_breakthrough")
        ok, msg = play_card(game, "p0", 0, target_q=target.q, target_r=target.r)
        assert ok, msg
        _reveal(game)
        assert target.owner == "p0"
        return neighbours, open_tile

    def test_defended_neighbours_are_not_auto_claimed(self, card_registry):
        neighbours, _ = self._setup(card_registry, leave_one_open=False)
        assert all(a.owner is None for a in neighbours)

    def test_defenseless_neighbour_is_auto_claimed(self, card_registry):
        neighbours, open_tile = self._setup(card_registry, leave_one_open=True)
        assert open_tile is not None and open_tile.owner == "p0"
        assert all(a.owner is None for a in neighbours if a is not open_tile)


# ── B11: VP-target ties don't go to the earlier seat ───────────────


class TestB11VpTargetTie:
    def _top_up(self, game: GameState, pid: str, vp: int) -> None:
        cur = compute_player_vp(game, pid)
        assert cur <= vp
        for _ in range(vp - cur):
            game.players[pid].deck.discard.append(make_land_grant_card())
        assert compute_player_vp(game, pid) == vp

    def _add_tiles(self, game: GameState, pid: str, n: int) -> None:
        for _ in range(n):
            _neutral_adjacent(game, pid).owner = pid

    def test_higher_vp_wins_over_earlier_seat(self, card_registry):
        game = _game(card_registry)
        game.vp_target = 5
        self._top_up(game, "p0", 5)
        self._top_up(game, "p1", 6)
        execute_end_of_turn(game)
        assert game.current_phase == Phase.GAME_OVER
        assert game.winner == "p1"
        assert game.winners == ["p1"]

    def test_vp_tie_broken_by_connected_vp_hexes(self, card_registry):
        game = _game(card_registry)
        game.vp_target = 6
        hex_tile = next(
            a for a in game.grid.get_adjacent(_base(game, "p1").q, _base(game, "p1").r)
            if a.owner is None
        )
        _plain(hex_tile).owner = "p1"
        hex_tile.is_vp = True
        self._add_tiles(game, "p0", 3)  # p0 has more tiles, p1 has the VP hex
        self._top_up(game, "p0", 6)
        self._top_up(game, "p1", 6)
        execute_end_of_turn(game)
        assert game.winners == ["p1"]

    def test_then_by_tiles(self, card_registry):
        game = _game(card_registry)
        game.vp_target = 6
        self._add_tiles(game, "p0", 1)  # 3 tiles
        self._add_tiles(game, "p1", 2)  # 4 tiles
        self._top_up(game, "p0", 6)
        self._top_up(game, "p1", 6)
        execute_end_of_turn(game)
        assert game.winners == ["p1"]
        assert game.winner == "p1"

    def test_full_tie_is_a_shared_victory(self, card_registry):
        game = _game(card_registry)
        game.vp_target = 6
        self._top_up(game, "p0", 6)
        self._top_up(game, "p1", 6)
        execute_end_of_turn(game)
        assert game.winners == ["p0", "p1"]
        assert game.winner in game.winners
        over = [e for e in game.game_log if e.event_type == "game_over"]
        assert over and over[-1].data["winners"] == ["p0", "p1"]

    def test_only_qualifiers_compete(self, card_registry):
        game = _game(card_registry)
        game.vp_target = 6
        self._top_up(game, "p0", 5)
        self._top_up(game, "p1", 6)
        execute_end_of_turn(game)
        assert game.winners == ["p1"]


# ── B12: Arms Dealer pays 1× printed power ─────────────────────────


def test_b12_arms_dealer_uses_printed_power(card_registry):
    game = _game(card_registry)
    p0 = game.players["p0"]
    # Another Claim is planned, so Strike Team's conditional +2 would be live —
    # Arms Dealer still pays only its printed power 3.
    _give(game, card_registry, "p0", "vanguard_blitz")
    tile = _neutral_adjacent(game, "p0")
    ok, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
    assert ok
    _give(game, card_registry, "p0", "vanguard_strike_team")
    _give(game, card_registry, "p0", "vanguard_arms_dealer")
    res, actions = p0.resources, p0.actions_available
    ok, msg = play_card(game, "p0", 0, trash_card_indices=[0])
    assert ok, msg
    assert p0.resources == res + 3
    assert p0.actions_available == actions + 1
    assert any(c.definition_id == "vanguard_strike_team" for c in p0.trash)


# ── B13: defense *bonuses* exclude intrinsic defense ───────────────


class TestB13DefenseBonus:
    def test_battering_ram_vs_bare_vp_hex_and_base(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        ram = _give(game, card_registry, "p0", "fortress_battering_ram")
        tile = _contested_tile(game, owner="p1", attacker="p0")
        tile.is_vp = True
        tile.base_defense = tile.defense_power = 2
        action = PlannedAction(card=ram, target_q=tile.q, target_r=tile.r)
        assert not check_condition(ConditionType.IF_TARGET_HAS_DEFENSE, game, p0, ram, action)
        assert calculate_effective_power(game, p0, ram, action) == 5
        base = _base(game, "p1")
        base_action = PlannedAction(card=ram, target_q=base.q, target_r=base.r)
        assert calculate_effective_power(game, p0, ram, base_action) == 5

    def test_battering_ram_vs_defense_card_or_fortification(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        ram = _give(game, card_registry, "p0", "fortress_battering_ram")
        tile = _contested_tile(game, owner="p1", attacker="p0")
        tile.base_defense = 2
        tile.defense_power = 4  # +2 from a Defense card this round
        action = PlannedAction(card=ram, target_q=tile.q, target_r=tile.r)
        assert calculate_effective_power(game, p0, ram, action) == 7
        tile.defense_power = 3
        tile.permanent_defense_bonus = 1  # Entrench
        assert calculate_effective_power(game, p0, ram, action) == 7

    def test_watchful_keep_ignores_intrinsic_defense(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        _give(game, card_registry, "p0", "fortress_watchful_keep")
        hand_before = len(p0.hand)
        ok, _ = play_card(game, "p0", 0)  # only the bare base (defense 3) is owned
        assert ok
        assert len(p0.hand) == hand_before - 1
        # A fortified tile does count
        game2 = _game(card_registry, a0="fortress")
        p0b = game2.players["p0"]
        non_base = next(t for t in game2.grid.get_player_tiles("p0") if not t.is_base)
        non_base.permanent_defense_bonus = 1
        non_base.defense_power += 1
        _give(game2, card_registry, "p0", "fortress_watchful_keep")
        hand_before = len(p0b.hand)
        ok, _ = play_card(game2, "p0", 0)
        assert ok
        assert len(p0b.hand) == hand_before  # played 1, drew 1


# ── B14: Warden counts captured tiles; lost-and-retaken don't ──────


class TestB14Warden:
    def test_capture_records_loser(self, card_registry):
        game = _game(card_registry)
        tile = _contested_tile(game, owner="p1", attacker="p0")
        _give(game, card_registry, "p0", "vanguard_blitz")
        ok, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        _reveal(game)
        assert tile.owner == "p0"
        assert tile.lost_by == ["p1"]

    def test_warden_formula(self, card_registry):
        game = _game(card_registry, a0="fortress")
        p0 = game.players["p0"]
        warden = _copy_card(card_registry["fortress_warden"], "bp_warden")
        for t in game.grid.tiles.values():
            if t.owner == "p0" and not t.is_base:
                t.owner = None
        mine = [t for t in game.grid.tiles.values() if t.owner is None and not t.is_blocked][:8]
        for t in mine:
            t.owner = "p0"
        mine[0].lost_by = ["p1"]  # taken from an opponent: still counts
        assert _compute_formula_vp(warden, p0, game) == 1
        mine[1].lost_by = ["p0"]  # we lost it once and retook it: doesn't count
        assert _compute_formula_vp(warden, p0, game) == 0


# ── B15: Battle Glory counts wins against opponent-owned tiles only ─


def test_b15_battle_glory_ignores_contested_neutral_wins(card_registry):
    game = _game(card_registry)
    p0 = game.players["p0"]
    glory = _copy_card(card_registry["vanguard_battle_glory"], "bp_glory")
    effect = next(e for e in glory.effects if e.type == EffectType.VP_FROM_CONTESTED_WINS)
    keys = ["9,9", "8,8"]
    results = {k: {"p0": True, "p1": False} for k in keys}

    def _run(prev_owner: Any) -> None:
        game.resolution_steps = [{"tile_key": k, "previous_owner": prev_owner} for k in keys]
        ctx = EffectContext(game=game, player=p0, card=glory,
                            action=PlannedAction(card=glory), claim_results=results)
        _handle_vp_from_contested_wins(effect, ctx)

    _run(None)  # two neutral tiles another player also claimed
    assert glory.passive_vp == 0
    _run("p1")  # two tiles taken from an opponent
    assert glory.passive_vp == 1
    assert "opponent-owned" in glory.description


# ── Reworked cards (code-level mechanics) ──────────────────────────


class TestReworkedCards:
    def test_coordinated_push_base_gains_action_when_stacked(self, card_registry):
        game = _game(card_registry)
        p0 = game.players["p0"]
        tile = _neutral_adjacent(game, "p0")
        _give(game, card_registry, "p0", "vanguard_blitz")
        ok, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        _give(game, card_registry, "p0", "vanguard_coordinated_push")
        before = p0.actions_available
        ok, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        assert p0.actions_available == before + 1

    def test_swarm_tactics_buffs_next_claim(self, card_registry):
        game = _game(card_registry)
        p1 = game.players["p1"]
        _give(game, card_registry, "p1", "swarm_swarm_tactics")
        ok, _ = play_card(game, "p1", 0)
        assert ok
        surge = _give(game, card_registry, "p1", "vanguard_blitz")
        tile = _neutral_adjacent(game, "p1")
        ok, _ = play_card(game, "p1", 0, target_q=tile.q, target_r=tile.r)
        assert ok
        assert p1.planned_actions[-1].effective_power == surge.power + 1

    def test_road_builder_power_on_bridge_and_off(self, card_registry):
        game = _game(card_registry)
        p0 = game.players["p0"]
        base = _base(game, "p0")
        for t in game.grid.tiles.values():
            if t.owner == "p0" and not t.is_base:
                t.owner = None
        # base - gap - far: claiming the gap joins the far tile to the base.
        gap = next(a for a in game.grid.get_adjacent(base.q, base.r) if a.owner is None)
        far = next(
            a for a in game.grid.get_adjacent(gap.q, gap.r)
            if a.owner is None and a.distance_to(base) == 2
        )
        _plain(gap)
        _plain(far).owner = "p0"
        rb = _give(game, card_registry, "p0", "neutral_road_builder")
        assert rb.power == 1
        ok, msg = play_card(game, "p0", 0, target_q=gap.q, target_r=gap.r)
        assert ok, msg
        assert p0.planned_actions[-1].effective_power == 5
        # A non-bridging tile: power 2, frozen at play time
        rb2 = _give(game, card_registry, "p0", "neutral_road_builder")
        other = next(
            a for a in game.grid.get_adjacent(far.q, far.r)
            if a.owner is None and (a.q, a.r) != (gap.q, gap.r)
            and not any(n.owner == "p0" and n.is_base for n in game.grid.get_adjacent(a.q, a.r))
        )
        _plain(other)
        ok, msg = play_card(game, "p0", 0, target_q=other.q, target_r=other.r)
        assert ok, msg
        assert p0.planned_actions[-1].card is rb2
        assert p0.planned_actions[-1].effective_power == 1

    def test_surveyor_rerolls_last_this_round_only(self, card_registry):
        game = _game(card_registry)
        p0 = game.players["p0"]
        _give(game, card_registry, "p0", "neutral_surveyor")
        before = p0.actions_available
        ok, _ = play_card(game, "p0", 0)
        assert ok
        assert p0.actions_available == before + 1
        _reveal(game)
        assert p0.turn_modifiers.free_rerolls == 2
        p0.turn_modifiers.reset_for_new_turn()
        assert p0.turn_modifiers.free_rerolls == 0

    @pytest.mark.parametrize("upgraded,mine,theirs", [(False, 2, 1), (True, 2, 0)])
    def test_diplomat_grants(self, card_registry, upgraded, mine, theirs):
        game = _game(card_registry)
        _give(game, card_registry, "p0", "neutral_diplomat", upgraded=upgraded)
        ok, _ = play_card(game, "p0", 0)
        assert ok
        _reveal(game)

        def grants(pid: str) -> int:
            return sum(1 for c in game.players[pid].deck.discard if c.name == "Land Grant")

        assert grants("p0") == mine
        assert grants("p1") == theirs

    def test_eminent_domain_is_one_shot(self, card_registry):
        game = _game(card_registry)
        p0 = game.players["p0"]
        ed = _give(game, card_registry, "p0", "neutral_eminent_domain")
        tile = next(
            t for t in game.grid.tiles.values()
            if t.owner is None and not t.is_blocked
            and all(n.owner is None for n in game.grid.get_adjacent(t.q, t.r))
        )
        _plain(tile)
        ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
        assert ok, msg
        _reveal(game)
        assert tile.owner == "p0"
        assert ed in p0.trash

    def test_second_wave_needs_a_claim_in_discard(self, card_registry):
        game = _game(card_registry)
        p1 = game.players["p1"]
        p1.deck.discard = [c for c in p1.deck.discard if c.card_type != CardType.CLAIM]
        p1.deck.discard.append(_copy_card(card_registry["neutral_gather"], "bp_g"))
        _give(game, card_registry, "p1", "swarm_second_wave")
        ok, msg = play_card(game, "p1", 0)
        assert not ok and "Claim" in msg
        p1.deck.discard.append(_copy_card(card_registry["swarm_rabble"], "bp_r"))
        ok, msg = play_card(game, "p1", 0)
        assert ok, msg

    def test_overwhelm_and_elite_vanguard_cost_one_action(self, card_registry):
        assert card_registry["swarm_overwhelm"].action_cost == 1
        assert card_registry["vanguard_elite_vanguard"].action_cost == 1
        assert card_registry["neutral_foresight"].action_cost == 1


# ── CPU understands the changed mechanics ──────────────────────────


class TestCpuSync:
    def test_arsenal_projection_uses_new_divisor(self, card_registry):
        game = _game(card_registry)
        p0 = game.players["p0"]
        arsenal = _copy_card(card_registry["vanguard_arsenal"], "bp_ars")
        total = len(p0.deck.cards) + len(p0.hand) + len(p0.deck.discard)
        assert total == 10
        # 10 cards now (0 VP) + ~6 projected buys → 16 // 12 = 1
        assert _projected_formula_vp(arsenal, p0, game) == 1.0

    def test_road_builder_estimates(self, card_registry):
        game = _game(card_registry)
        cpu = CPUPlayer("p0", difficulty=HARD)
        rb = _copy_card(card_registry["neutral_road_builder"], "bp_rb")
        tile = _neutral_adjacent(game, "p0")
        assert cpu._estimate_effective_power(game, game.players["p0"], tile, rb) == 1
        ctx = build_context(game, "p0")
        assert 1.0 < estimated_claim_power(rb, ctx) < 2.0

    def test_battering_ram_estimate_vs_bare_hex(self, card_registry):
        game = _game(card_registry, a0="fortress")
        cpu = CPUPlayer("p0", difficulty=HARD)
        ram = _copy_card(card_registry["fortress_battering_ram"], "bp_ram")
        tile = _contested_tile(game, owner="p1", attacker="p0")
        tile.is_vp = True
        tile.base_defense = tile.defense_power = 3
        assert cpu._estimate_effective_power(game, game.players["p0"], tile, ram) == 5
        tile.defense_power = 5
        assert cpu._estimate_effective_power(game, game.players["p0"], tile, ram) == 7

    def test_battle_cry_cpu_names_an_opponent(self, card_registry):
        game = _game(card_registry)
        cpu = CPUPlayer("p0", difficulty=HARD)
        card = _give(game, card_registry, "p0", "vanguard_surge_protocol")
        p0 = game.players["p0"]
        weights = cpu._get_weights(p0, game)
        scored = cpu._score_engine(game, p0, card, 0, weights)
        assert scored is not None
        assert scored[1].get("target_player_id") == "p1"


def test_warden_loss_history_survives_save_load():
    from app.storage.serializer import _deserialize_tile, _serialize_tile

    tile = HexTile(q=1, r=-1, owner="p0", lost_by=["p1"])
    restored = _deserialize_tile(_serialize_tile(tile))
    assert restored.lost_by == ["p1"]
    assert _deserialize_tile(_serialize_tile(HexTile(q=0, r=0))).lost_by == []
