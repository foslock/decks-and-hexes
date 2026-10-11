"""Tests for the CPU's deck-aware economy (cpu_valuation) and the
difficulty-rebalance behaviours: near-best move selection, upgrade-credit
spending, lethal VP buys and connectivity-cut detection."""

from __future__ import annotations

import dataclasses

import pytest

from app.game_engine.cards import Archetype
from app.game_engine.cpu_player import (
    EASY,
    HARD,
    MEDIUM,
    CPUPlayer,
    _connectivity_cut_values,
)
from app.game_engine.cpu_valuation import (
    build_context,
    card_play_value,
    claim_curve,
    purchase_value,
    upgrade_gain,
)
from app.game_engine.game_state import Phase, create_game, execute_start_of_turn, execute_upkeep
from app.game_engine.hex_grid import GridSize


def _game(card_registry, archetypes=("vanguard", "swarm"), seed=3):
    configs = [{"id": f"p{i}", "name": f"P{i}", "archetype": a} for i, a in enumerate(archetypes)]
    game = create_game(GridSize.SMALL, configs, card_registry, seed=seed, vp_target=10)
    execute_start_of_turn(game)
    execute_upkeep(game)
    return game


# ── Selection noise ─────────────────────────────────────────────────

def test_low_noise_picks_best_option_almost_always():
    """Regression: noise used to blend into score-proportional sampling, so
    Hard (0.05) picked an 8-point option over a 10-point one ~45% of the time."""
    cpu = CPUPlayer("p", difficulty=HARD, noise=0.05)
    picks = [cpu._pick([(10.0, "best"), (8.0, "second")]) for _ in range(2000)]
    assert picks.count("best") / len(picks) > 0.93


def test_noise_still_allows_mistakes():
    cpu = CPUPlayer("p", difficulty=EASY, noise=0.5)
    picks = {cpu._pick([(10.0, "best"), (8.0, "second")]) for _ in range(300)}
    assert picks == {"best", "second"}


# ── Valuation model ─────────────────────────────────────────────────

def test_claim_curve_is_monotonic():
    values = [claim_curve(p) for p in range(0, 11)]
    assert values == sorted(values)
    # Power 2 takes standard VP hexes (a tie against neutral intrinsic
    # defense goes to the attacker), so it is the biggest single step.
    steps = [claim_curve(p + 1) - claim_curve(p) for p in range(0, 6)]
    assert max(steps) == steps[1]


def test_power_claim_outvalues_cheap_filler(card_registry):
    """The 'buy big strike cards' exploit worked because Hard preferred 1-cost
    filler. A power-3 Claim must now be worth far more than Spyglass."""
    game = _game(card_registry)
    player = game.players["p0"]
    ctx = build_context(game, "p0")
    strike = card_registry["vanguard_strike_team"]
    spyglass = card_registry["neutral_spyglass"]
    assert purchase_value(strike, player, game, ctx) > 3 * max(0.5, purchase_value(spyglass, player, game, ctx))


def test_dead_card_value_is_vp_minus_clog(card_registry):
    game = _game(card_registry)
    player = game.players["p0"]
    ctx = build_context(game, "p0")
    land_grant = card_registry["neutral_land_grant"]
    assert card_play_value(land_grant, ctx) == 0.0
    pv = purchase_value(land_grant, player, game, ctx)
    assert pv < ctx.tuning.vp_re  # clogging the deck costs something


def test_explore_upgrade_has_positive_gain(card_registry):
    game = _game(card_registry)
    player = game.players["p0"]
    ctx = build_context(game, "p0")
    explore = next(c for c in player.hand + player.deck.cards if c.definition_id == "neutral_explore")
    assert upgrade_gain(explore, player, game, ctx) > 0


# ── Upgrade credits ─────────────────────────────────────────────────

def test_cpu_spends_upgrade_credits_on_hand_card(card_registry):
    """Regression: CPUs bought upgrade credits but never spent them."""
    game = _game(card_registry)
    assert game.current_phase == Phase.PLAY
    player = game.players["p0"]
    player.upgrade_credits = 1
    before = sum(1 for c in player.hand if c.is_upgraded)
    spent = CPUPlayer("p0", difficulty=HARD, noise=0.0).spend_upgrade_credits(game)
    assert spent == 1
    assert player.upgrade_credits == 0
    assert sum(1 for c in player.hand if c.is_upgraded) == before + 1


# ── Endgame ─────────────────────────────────────────────────────────

def test_hard_buys_lethal_land_grant(card_registry):
    """At target-1 VP, an affordable Land Grant wins on the spot (the target
    is checked at end of round, after buying)."""
    from app.game_engine.game_state import compute_player_vp

    game = _game(card_registry)
    game.current_phase = Phase.BUY
    player = game.players["p0"]
    player.resources = 7
    game.vp_target = compute_player_vp(game, "p0") + 1
    player.archetype_market = [dataclasses.replace(card_registry["vanguard_strike_team"])]
    for pid, stack in game.shared_market.stacks.items():
        if pid != "neutral_land_grant":
            stack.clear()
    action = CPUPlayer("p0", difficulty=HARD, noise=0.0).pick_next_purchase(game)
    assert action is not None and action["definition_id"] == "neutral_land_grant"


# ── Connectivity cuts ───────────────────────────────────────────────

def test_connectivity_cut_values_find_bridge(card_registry):
    """A plain tile on the only path from base to a VP hex is a bridge worth
    that hex's VP; the hex itself is excluded from its own value."""
    game = _game(card_registry)
    grid = game.grid
    base = next(t for t in grid.tiles.values() if t.is_base and t.base_owner == "p0")
    # Build a straight owned chain base -> a -> b, and make b a VP hex.
    for t in grid.tiles.values():
        if t.owner == "p0" and not t.is_base:
            t.owner = None
    a = next(n for n in grid.get_adjacent(base.q, base.r) if not n.is_vp)
    b = next(n for n in grid.get_adjacent(a.q, a.r)
             if (n.q, n.r) != (base.q, base.r) and base.distance_to(n) == 2)
    a.owner = b.owner = "p0"
    b.is_vp = True
    b.vp_value = 2
    cuts = _connectivity_cut_values(grid, "p0")
    assert cuts.get((a.q, a.r)) == 2
    assert (b.q, b.r) not in cuts


# ── Profiles ────────────────────────────────────────────────────────

@pytest.mark.parametrize("difficulty,expected", [(EASY, False), (MEDIUM, True), (HARD, True)])
def test_value_purchasing_by_tier(difficulty, expected):
    assert CPUPlayer("p", difficulty=difficulty).profile.value_purchasing is expected


def test_hard_has_full_tactical_suite():
    p = CPUPlayer("p", difficulty=HARD).profile
    assert p.threat_modeling and p.connectivity_cuts and p.endgame_awareness and p.purchase_saving
    # Medium shares Hard's play tactics; it differs in what it buys.
    m = CPUPlayer("p", difficulty=MEDIUM).profile
    assert m.threat_modeling and m.connectivity_cuts and m.claim_bonus_lookahead
    assert not (m.endgame_awareness or m.purchase_saving or m.board_aware_valuation)


# ── Live buy planning ───────────────────────────────────────────────

def test_plan_cpu_purchases_sees_prior_buys_and_leaves_game_untouched(card_registry):
    """Regression: the live server planned purchases on unchanged state, so
    every pick was the same card and only the first buy succeeded."""
    from app.game_engine.game_state import plan_cpu_purchases

    configs = [
        {"id": "p0", "name": "P0", "archetype": "vanguard", "is_cpu": True, "cpu_difficulty": HARD},
        {"id": "p1", "name": "P1", "archetype": "swarm"},
    ]
    game = create_game(GridSize.SMALL, configs, card_registry, seed=11, vp_target=10)
    execute_start_of_turn(game)
    execute_upkeep(game)
    game.current_phase = Phase.BUY
    player = game.players["p0"]
    player.resources = 20
    log_len = len(game.game_log)

    plan = plan_cpu_purchases(game, "p0")

    assert len(plan) >= 2
    keys = [(p["source"], p["card_id"]) for p in plan if p["source"] != "upgrade"]
    assert len(keys) == len(set(keys)), "planned the same card twice"
    assert player.resources == 20 and len(game.game_log) == log_len


def test_cpu_knows_ties_win_against_neutral_defense():
    """Regression: the CPU assumed a claim had to *exceed* a neutral tile's
    intrinsic defense, so it undervalued power-2 claims against standard VP
    hexes (the engine and UI let ties win against neutral defense)."""
    from types import SimpleNamespace
    from app.game_engine.cpu_player import _claim_beats_defense

    neutral_vp = SimpleNamespace(owner=None, defense_power=2)
    owned = SimpleNamespace(owner="p1", defense_power=2)
    assert _claim_beats_defense(neutral_vp, 2)
    assert not _claim_beats_defense(neutral_vp, 1)
    assert not _claim_beats_defense(owned, 2)
    assert _claim_beats_defense(owned, 3)


# ── Cards with a price ──────────────────────────────────────────────

def _hand(card_registry, game, pid, ids):
    from app.game_engine.cards import _copy_card
    player = game.players[pid]
    player.hand = [_copy_card(card_registry[cid], f"h{i}") for i, cid in enumerate(ids)]
    return player


def test_stampede_waits_for_a_hand_short_of_actions(card_registry):
    game = _game(card_registry, archetypes=("swarm", "vanguard"))
    cpu = CPUPlayer("p0", difficulty=HARD)
    player = _hand(card_registry, game, "p0", ["swarm_blitz_rush", "neutral_gather", "neutral_explore"])
    player.resources = 4
    # Two other cards and five actions: three more actions buy nothing, and
    # it would cost the Buy Phase.
    assert not cpu._drawback_pays(game, player, player.hand[0], 0)
    # Seven cards to play on five actions: now the actions are worth it.
    player = _hand(card_registry, game, "p0", ["swarm_blitz_rush"] + ["neutral_explore"] * 7)
    player.resources = 0
    assert cpu._drawback_pays(game, player, player.hand[0], 0)


def test_frenzy_only_discards_a_card_that_would_go_unplayed(card_registry):
    game = _game(card_registry, archetypes=("swarm", "vanguard"))
    cpu = CPUPlayer("p0", difficulty=HARD)
    player = _hand(card_registry, game, "p0", ["swarm_frenzy"] + ["neutral_explore"] * 4)
    assert not cpu._drawback_pays(game, player, player.hand[0], 0)
    player = _hand(card_registry, game, "p0", ["swarm_frenzy"] + ["neutral_explore"] * 7)
    assert cpu._drawback_pays(game, player, player.hand[0], 0)


def test_mulligan_keeps_a_good_hand(card_registry):
    game = _game(card_registry, archetypes=("fortress", "vanguard"))
    cpu = CPUPlayer("p0", difficulty=HARD)
    player = _hand(card_registry, game, "p0", ["fortress_mulligan"] + ["neutral_militia"] * 4)
    # The draw pile is all starters: a worse hand.
    assert not cpu._drawback_pays(game, player, player.hand[0], 0)


def test_demon_pact_never_thins_the_deck_below_two_hands(card_registry):
    from app.game_engine.cards import _copy_card
    game = _game(card_registry, archetypes=("vanguard", "swarm"))
    cpu = CPUPlayer("p0", difficulty=HARD)
    player = _hand(card_registry, game, "p0", ["vanguard_demon_pact"] + ["neutral_explore"] * 4)
    weights = cpu._get_weights(player, game)
    # A starting-size deck: burning 3 would leave too few cards.
    player.deck.cards = [_copy_card(card_registry["neutral_gather"], f"d{i}") for i in range(5)]
    player.deck.discard = []
    assert cpu._score_claim_targets(game, player, player.hand[0], 0, weights) == []
    # A big deck can afford it, and the cards it burns are priced in.
    player.deck.cards = [_copy_card(card_registry["neutral_gather"], f"d{i}") for i in range(12)]
    scored = cpu._score_claim_targets(game, player, player.hand[0], 0, weights)
    assert scored and len(scored[0][1]["trash_card_indices"]) == 3


def test_forced_march_waits_until_the_actions_are_needed(card_registry):
    game = _game(card_registry)
    cpu = CPUPlayer("p0", difficulty=HARD)
    player = _hand(card_registry, game, "p0", ["neutral_forced_march"] + ["neutral_explore"] * 3)
    # Rivals' extra action next round, for nothing.
    assert not cpu._drawback_pays(game, player, player.hand[0], 0)
    player = _hand(card_registry, game, "p0", ["neutral_forced_march"] + ["neutral_explore"] * 7)
    assert cpu._drawback_pays(game, player, player.hand[0], 0)


# ── Tier-specific valuation and play ───────────────────────────────

def test_stacking_extras_count_only_for_a_stacking_player(card_registry):
    """A tier that doesn't plan stacked claims (Easy) gets nothing from Dog
    Pile's stacking bonus: valued as a plain power-2 Claim."""
    from app.game_engine.cpu_valuation import ValuationTuning

    game = _game(card_registry, archetypes=("swarm", "vanguard"))
    assert CPUPlayer("p0", difficulty=HARD)._valuation_context(game).tuning.stack_aware
    assert not CPUPlayer("p0", difficulty=EASY)._valuation_context(game).tuning.stack_aware
    dog_pile = card_registry["swarm_dog_pile"]
    aware = build_context(game, "p0", board_aware=False)
    blind = build_context(game, "p0", board_aware=False, tuning=ValuationTuning(stack_aware=False))
    assert card_play_value(dog_pile, blind) == pytest.approx(claim_curve(2))
    assert card_play_value(dog_pile, aware) > card_play_value(dog_pile, blind)


def test_abandoning_a_tile_counts_against_exodus(card_registry):
    """Regression: giving up a tile was scored as a perk, so Medium Swarm
    bought Exodus over Claims."""
    from app.game_engine.effects import EffectType

    game = _game(card_registry, archetypes=("swarm", "vanguard"))
    ctx = build_context(game, "p0")
    exodus = card_registry["swarm_exodus"]
    keep_tile = dataclasses.replace(
        exodus, effects=[e for e in exodus.effects if e.type != EffectType.ABANDON_TILE])
    assert card_play_value(exodus, ctx) < card_play_value(keep_tile, ctx)


def test_hard_counts_strike_teams_bonus_from_a_claim_still_in_hand(card_registry):
    """Strike Team's +2 (another Claim this round) is settled at the reveal;
    Hard and Medium count a Claim still in hand, Easy only the ones placed."""
    game = _game(card_registry)
    player = _hand(card_registry, game, "p0", ["vanguard_strike_team", "neutral_explore"])
    strike = player.hand[0]
    tile = next(t for t in game.grid.tiles.values() if not t.is_blocked)
    assert CPUPlayer("p0", difficulty=HARD)._estimate_effective_power(game, player, tile, strike) == 4
    assert CPUPlayer("p0", difficulty=EASY)._estimate_effective_power(game, player, tile, strike) == 2
    player.hand = [strike]
    assert CPUPlayer("p0", difficulty=HARD)._estimate_effective_power(game, player, tile, strike) == 2


def test_hard_saves_for_an_archetype_pile_in_a_pack_game(card_registry):
    """A pack's archetype piles are on show every round, so a much better
    archetype card one income away is worth skipping filler for."""
    configs = [{"id": "p0", "name": "P0", "archetype": "vanguard"},
               {"id": "p1", "name": "P1", "archetype": "swarm"}]
    game = create_game(GridSize.SMALL, configs, card_registry, seed=3, vp_target=10,
                       card_pack="far_reaches")
    execute_start_of_turn(game)
    execute_upkeep(game)
    game.current_phase = Phase.BUY
    player = game.players["p0"]
    player.archetype_market = [c for c in player.archetype_market
                               if c.definition_id in ("vanguard_breakthrough", "vanguard_rearguard")]
    for base_id, stack in game.shared_market.stacks.items():
        if base_id != "neutral_conscription":
            stack.clear()
    cpu = CPUPlayer("p0", difficulty=HARD, noise=0.0)
    # This is about the valuation's saving rule, not the pack's builds.
    import dataclasses
    cpu.profile = dataclasses.replace(cpu.profile, follow_builds=False)
    player.resources = 5
    assert cpu.pick_next_purchase(game) is None
    player.resources = 6
    pick = cpu.pick_next_purchase(game)
    assert pick is not None and pick["definition_id"] == "vanguard_breakthrough"


def test_strike_team_valued_near_its_full_power(card_registry):
    """Strike Team's +2 needs another Claim this round — nearly every hand
    has one (Explore) — so it's valued close to power 4, not 3."""
    from app.game_engine.cpu_valuation import estimated_claim_power

    game = _game(card_registry)
    ctx = build_context(game, "p0")
    assert estimated_claim_power(card_registry["vanguard_strike_team"], ctx) >= 3.75


def test_easy_counts_the_debt_a_card_adds(card_registry):
    """Regression: Easy's cost-divided scorer read Prospector as pure +6
    income and filled its deck with Debts (it won 2% of Border War games)."""
    from app.game_engine.effects import EffectType

    game = _game(card_registry, archetypes=("fortress", "swarm"))
    player = game.players["p0"]
    cpu = CPUPlayer("p0", difficulty=EASY, noise=0.0)
    weights = cpu._get_weights(player, game)
    prospector = card_registry["neutral_prospector"]
    no_debt = dataclasses.replace(
        prospector, effects=[e for e in prospector.effects if e.type != EffectType.GAIN_DEBT])
    score = cpu._score_card_for_purchase(prospector, player, weights, 3, game)
    assert score < 0.75 * cpu._score_card_for_purchase(no_debt, player, weights, 3, game)
