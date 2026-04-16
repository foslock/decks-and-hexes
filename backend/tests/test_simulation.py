"""Tests for CPU player, simulation driver, and balance report."""

import pytest

from app.game_engine.cards import Archetype
from app.game_engine.cpu_player import CPUPlayer, ARCHETYPE_WEIGHTS, StrategyWeights
from app.game_engine.hex_grid import GridSize
from app.game_engine.simulation import (
    BatchConfig,
    SimConfig,
    generate_archetype_combos,
    run_batch,
    run_game,
)
from app.game_engine.balance_report import generate_report
from app.data_loader.loader import load_all_cards


@pytest.fixture(scope="module")
def card_registry():
    return load_all_cards()


# ── CPU Player Tests ──────────────────────────────────────────────

class TestCPUPlayer:
    def test_pick_deterministic(self):
        """With noise=0, always picks highest score."""
        cpu = CPUPlayer("test", noise=0.0)
        scored = [(1.0, "a"), (5.0, "b"), (3.0, "c")]
        assert cpu._pick(scored) == "b"

    def test_pick_empty(self):
        """Returns None for empty scored list."""
        cpu = CPUPlayer("test", noise=0.0)
        assert cpu._pick([]) is None

    def test_pick_with_full_noise(self):
        """With noise=1.0, picks randomly (just verify it returns something)."""
        cpu = CPUPlayer("test", noise=1.0)
        scored = [(1.0, "a"), (5.0, "b"), (3.0, "c")]
        result = cpu._pick(scored)
        assert result in ("a", "b", "c")

    def test_pick_with_partial_noise(self):
        """With noise=0.5, picks something (weighted random)."""
        cpu = CPUPlayer("test", noise=0.5)
        scored = [(1.0, "a"), (100.0, "b"), (1.0, "c")]
        # Run many times — high-score option should win most
        results = [cpu._pick(scored) for _ in range(100)]
        assert results.count("b") > 50  # should strongly favor b

    def test_archetype_weights_exist(self):
        """All archetypes have strategy weights."""
        for arch in [Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS]:
            assert arch in ARCHETYPE_WEIGHTS

    def _make_game(self, card_registry, archetypes):
        from app.game_engine.game_state import create_game
        player_configs = [
            {"id": f"cpu_{i}", "name": f"CPU_{a.value}_{i}", "archetype": a.value}
            for i, a in enumerate(archetypes)
        ]
        return create_game(
            GridSize.SMALL, player_configs, card_registry,
            seed=1, vp_target=10, max_rounds=20,
        )

    def test_is_vp_leader_strict_rejects_ties(self, card_registry):
        """_is_vp_leader(strict=True) must return False when tied with an opponent.

        Regression: early-game every player is tied at 0 VP. With strict=False
        the check returned True for everyone, letting CPUs play Diplomat
        ("grant_land_grants") freely from the first round. This test locks
        in the strict behaviour.
        """
        from app.game_engine.cpu_player import _is_vp_leader

        game = self._make_game(
            card_registry,
            [Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS],
        )

        # Every player starts at 0 VP — none should be considered a strict leader.
        for pid in game.players:
            assert not _is_vp_leader(game, pid, strict=True), (
                f"{pid} is tied at 0 VP but _is_vp_leader(strict=True) returned True"
            )
            # Non-strict treats ties as leading — all three return True.
            assert _is_vp_leader(game, pid, strict=False)

        # Give the first player a VP bump and re-check: only they should be
        # the strict leader now.
        first = next(iter(game.players))
        game.players[first].vp = 3
        for pid in game.players:
            expected = (pid == first)
            assert _is_vp_leader(game, pid, strict=True) is expected

    def test_diplomat_veto_skips_card_when_not_leading(self, card_registry):
        """The Diplomat / grant_land_grants veto must drop the card from the
        scored pool entirely when the CPU isn't a strict VP leader."""
        import dataclasses
        from app.game_engine.cpu_player import CPUPlayer, ARCHETYPE_WEIGHTS, StrategyWeights

        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])

        # Find the Diplomat template card in the registry and put a copy
        # into the first player's hand.
        diplomat_tpl = card_registry.get("neutral_diplomat")
        assert diplomat_tpl is not None, "Diplomat card missing from registry"

        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        diplomat = dataclasses.replace(diplomat_tpl)
        player.hand = [diplomat]
        player.actions_used = 0
        player.actions_available = 3

        cpu = CPUPlayer(first_pid, noise=0.0)
        weights = ARCHETYPE_WEIGHTS.get(player.archetype, StrategyWeights())

        # Tied at 0 VP — Diplomat must NOT be scored.
        result = cpu._score_engine(game, player, diplomat, 0, weights)
        assert result is None, (
            "Diplomat was scored despite CPU being tied (not strictly leading)"
        )

        # Now give the CPU a clear VP lead — Diplomat should be scorable.
        player.vp = 5
        result2 = cpu._score_engine(game, player, diplomat, 0, weights)
        assert result2 is not None, (
            "Diplomat was vetoed even though CPU is the strict VP leader"
        )


# ── Single Game Tests ─────────────────────────────────────────────

class TestSingleGame:
    def test_game_completes(self, card_registry):
        """A single game runs to completion without errors."""
        config = SimConfig(
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            seed=42,
            max_rounds=50,
        )
        result = run_game(config, card_registry=card_registry)
        assert result.error is None
        assert result.rounds_played > 0
        assert len(result.player_results) == 2

    def test_game_has_winner_or_timeout(self, card_registry):
        """Game ends with a winner or timeout."""
        config = SimConfig(
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.FORTRESS],
            seed=100,
            max_rounds=50,
        )
        result = run_game(config, card_registry=card_registry)
        assert result.error is None
        assert result.winner_id is not None or result.timed_out

    def test_three_player_game(self, card_registry):
        """Three-player game completes."""
        config = SimConfig(
            grid_size=GridSize.MEDIUM,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS],
            seed=77,
            max_rounds=50,
        )
        result = run_game(config, card_registry=card_registry)
        assert result.error is None
        assert len(result.player_results) == 3

    def test_same_archetype_game(self, card_registry):
        """Two players with same archetype complete a game."""
        config = SimConfig(
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.SWARM, Archetype.SWARM],
            seed=55,
            max_rounds=50,
        )
        result = run_game(config, card_registry=card_registry)
        assert result.error is None

    def test_player_results_have_tracking_data(self, card_registry):
        """Player results include tracking metrics."""
        config = SimConfig(
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            seed=42,
            max_rounds=50,
        )
        result = run_game(config, card_registry=card_registry)
        for pr in result.player_results:
            assert pr.archetype in ("vanguard", "swarm")
            assert len(pr.actions_per_turn) > 0
            assert len(pr.vp_over_time) > 0
            assert len(pr.resources_over_time) > 0
            assert pr.total_claims_made >= 0

    def test_reproducible_with_seed(self, card_registry):
        """Same seed produces identical results."""
        config = SimConfig(
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            seed=999,
        )
        r1 = run_game(config, card_registry=card_registry)
        r2 = run_game(config, card_registry=card_registry)
        assert r1.winner_archetype == r2.winner_archetype
        assert r1.rounds_played == r2.rounds_played
        for pr1, pr2 in zip(r1.player_results, r2.player_results):
            assert pr1.final_vp == pr2.final_vp
            assert pr1.tiles_controlled == pr2.tiles_controlled

    def test_timeout_respected(self, card_registry):
        """Game respects max_rounds limit."""
        config = SimConfig(
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            seed=42,
            max_rounds=3,  # very short
        )
        result = run_game(config, card_registry=card_registry)
        assert result.error is None
        assert result.rounds_played <= 4  # may overshoot by 1 due to loop check timing


# ── Batch Tests ───────────────────────────────────────────────────

class TestBatch:
    def test_batch_runs(self, card_registry):
        """Batch of 5 games completes."""
        config = BatchConfig(
            num_games=5,
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            base_seed=100,
        )
        batch = run_batch(config, card_registry=card_registry)
        assert len(batch.results) == 5
        assert all(r.error is None for r in batch.results)

    def test_batch_with_noise(self, card_registry):
        """Batch with noise parameter completes."""
        config = BatchConfig(
            num_games=5,
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            cpu_noise=0.3,
            base_seed=200,
        )
        batch = run_batch(config, card_registry=card_registry)
        assert len(batch.results) == 5


# ── Balance Report Tests ──────────────────────────────────────────

class TestBalanceReport:
    def test_report_generation(self, card_registry):
        """Report generates all expected sections."""
        config = BatchConfig(
            num_games=10,
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            base_seed=300,
        )
        batch = run_batch(config, card_registry=card_registry)
        report = generate_report(batch)

        assert "summary" in report
        assert "archetype_win_rates" in report
        assert "card_purchase_stats" in report
        assert "game_length_stats" in report
        assert "action_economy" in report
        assert "vp_curves" in report
        assert "snowball_indicator" in report

    def test_archetype_stats_sum_correctly(self, card_registry):
        """Archetype game counts sum to total player appearances."""
        config = BatchConfig(
            num_games=10,
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            base_seed=400,
        )
        batch = run_batch(config, card_registry=card_registry)
        report = generate_report(batch)

        total_games_from_archetypes = sum(
            stats["games"] for stats in report["archetype_win_rates"].values()
        )
        # Each game has 2 players = 20 player-games
        assert total_games_from_archetypes == 20

    def test_action_economy_stats(self, card_registry):
        """Action economy stats include all expected fields."""
        config = BatchConfig(
            num_games=5,
            grid_size=GridSize.SMALL,
            player_archetypes=[Archetype.VANGUARD, Archetype.SWARM],
            base_seed=500,
        )
        batch = run_batch(config, card_registry=card_registry)
        report = generate_report(batch)

        ae = report["action_economy"]
        for arch in ["vanguard", "swarm"]:
            assert arch in ae
            assert "mean" in ae[arch]
            assert "median" in ae[arch]
            assert "max" in ae[arch]
            assert "p95" in ae[arch]
            assert "histogram" in ae[arch]


# ── Utility Tests ─────────────────────────────────────────────────

class TestUtilities:
    def test_generate_archetype_combos_2p(self):
        """2-player combos include all pairs."""
        combos = generate_archetype_combos(2)
        assert len(combos) == 6  # 3 archetypes, combinations_with_replacement(3, 2) = 6

    def test_generate_archetype_combos_3p(self):
        """3-player combos include all triples."""
        combos = generate_archetype_combos(3)
        assert len(combos) == 10  # combinations_with_replacement(3, 3) = 10


# ── Stress Test (multiple archetypes, all grid sizes) ─────────────

class TestSmoke:
    """Quick smoke tests across configurations. Each runs just 2 games."""

    @pytest.mark.parametrize("grid_size", [GridSize.SMALL, GridSize.MEDIUM])
    def test_all_archetype_pairs(self, card_registry, grid_size):
        """Every archetype pair completes games on small and medium grids."""
        for archetypes in generate_archetype_combos(2):
            config = SimConfig(
                grid_size=grid_size,
                player_archetypes=archetypes,
                seed=42,
                max_rounds=50,
            )
            result = run_game(config, card_registry=card_registry)
            assert result.error is None, (
                f"Error with {[a.value for a in archetypes]} on {grid_size.value}: "
                f"{result.error}"
            )


# ── VP-pursuit improvements ───────────────────────────────────────

class TestVPPursuit:
    """Verify the VP-pursuit improvements: passive-VP buying, resource saving,
    market denial, formula-VP scaling, reroll bias, and play-phase double-down."""

    def _make_game(self, card_registry, archetypes, seed=1):
        from app.game_engine.game_state import create_game
        player_configs = [
            {"id": f"cpu_{i}", "name": f"CPU_{a.value}_{i}", "archetype": a.value}
            for i, a in enumerate(archetypes)
        ]
        return create_game(
            GridSize.SMALL, player_configs, card_registry,
            seed=seed, vp_target=10, max_rounds=20,
        )

    def _force_market(self, player, card_registry, card_ids):
        """Replace a player's archetype market with specific cards by ID."""
        import dataclasses
        player.archetype_market = [
            dataclasses.replace(card_registry[cid]) for cid in card_ids
        ]

    def _clear_shared_market(self, game):
        """Empty the shared market so only the (controlled) archetype market
        affects buy decisions in unit tests."""
        for stack in game.shared_market.stacks.values():
            stack.clear()

    def _set_progress(self, game, fraction):
        """Advance current_round so _game_progress(game) ≈ fraction."""
        max_r = game.max_rounds or 20
        game.current_round = max(1, int(round(fraction * (max_r - 1) + 1)))

    # ── Helper-function unit tests ────────────────────────────────

    def test_is_vp_card_detects_passive_and_formula(self, card_registry):
        from app.game_engine.cpu_player import _is_vp_card
        assert _is_vp_card(card_registry["neutral_land_grant"])  # passive_vp
        assert _is_vp_card(card_registry["vanguard_arsenal"])    # vp_formula
        assert _is_vp_card(card_registry["swarm_colony"])        # vp_formula
        assert not _is_vp_card(card_registry["neutral_gather"])  # plain engine
        assert not _is_vp_card(card_registry["neutral_explore"]) # plain claim

    def test_difficulty_from_noise_mapping(self):
        from app.game_engine.cpu_player import (
            _difficulty_from_noise, EASY, MEDIUM, HARD,
        )
        # Exact lobby.py values
        assert _difficulty_from_noise(0.25) == EASY
        assert _difficulty_from_noise(0.10) == MEDIUM
        assert _difficulty_from_noise(0.05) == HARD
        # Boundary behavior
        assert _difficulty_from_noise(0.20) == EASY
        assert _difficulty_from_noise(0.08) == MEDIUM
        assert _difficulty_from_noise(0.07) == HARD
        assert _difficulty_from_noise(0.0) == HARD

    def test_cpu_difficulty_inferred_from_noise(self):
        from app.game_engine.cpu_player import CPUPlayer, EASY, MEDIUM, HARD
        assert CPUPlayer("p", noise=0.25).difficulty == EASY
        assert CPUPlayer("p", noise=0.10).difficulty == MEDIUM
        assert CPUPlayer("p", noise=0.05).difficulty == HARD

    def test_cpu_difficulty_explicit_overrides_noise(self):
        from app.game_engine.cpu_player import CPUPlayer, EASY
        cpu = CPUPlayer("p", noise=0.0, difficulty=EASY)
        assert cpu.difficulty == EASY
        assert cpu.profile.use_adaptive_weights is False

    # ── Buy-phase VP scoring ──────────────────────────────────────

    def test_hard_cpu_buys_land_grant_when_affordable(self, card_registry):
        from app.game_engine.cpu_player import CPUPlayer, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        self._set_progress(game, 0.5)
        self._clear_shared_market(game)
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        player.resources = 7
        # Stock the market with Land Grant + cheap filler so the choice is clear.
        self._force_market(player, card_registry, [
            "neutral_land_grant", "neutral_gather", "neutral_explore",
        ])
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
        action = cpu.pick_next_purchase(game)
        assert action is not None
        assert action["card_id"] == "neutral_land_grant"

    def test_easy_cpu_skips_land_grant_due_to_cost_penalty(self, card_registry):
        """Easy difficulty falls back to the original cost-penalty math, which
        crushes Land Grant's score relative to a cheap utility card."""
        from app.game_engine.cpu_player import CPUPlayer, EASY
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        self._set_progress(game, 0.5)
        self._clear_shared_market(game)
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        player.resources = 7
        self._force_market(player, card_registry, [
            "neutral_land_grant", "neutral_gather",
        ])
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=EASY)
        action = cpu.pick_next_purchase(game)
        assert action is not None
        # Easy CPU prefers the cheap utility card thanks to the unsoftened
        # cost penalty — exactly the regression we were trying to fix on Hard.
        assert action["card_id"] != "neutral_land_grant"

    def test_hard_cpu_saves_over_cheap_buy_when_vp_card_near(self, card_registry):
        from app.game_engine.cpu_player import CPUPlayer, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        self._set_progress(game, 0.5)
        self._clear_shared_market(game)
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        # 5 resources: Land Grant (7) is unaffordable but within +3.
        player.resources = 5
        self._force_market(player, card_registry, [
            "neutral_land_grant", "neutral_explore",
        ])
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
        action = cpu.pick_next_purchase(game)
        assert action is None, "Hard CPU should save resources for visible Land Grant"

    def test_easy_cpu_does_not_save_resources(self, card_registry):
        from app.game_engine.cpu_player import CPUPlayer, EASY
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        self._set_progress(game, 0.5)
        self._clear_shared_market(game)
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        player.resources = 5
        self._force_market(player, card_registry, [
            "neutral_land_grant", "neutral_gather",
        ])
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=EASY)
        action = cpu.pick_next_purchase(game)
        # Easy CPU spends rather than saves — buys something cheap.
        assert action is not None

    def test_medium_cpu_saves_only_late_game(self, card_registry):
        """Medium activates the saving gate only once progress >= 0.5."""
        from app.game_engine.cpu_player import CPUPlayer, MEDIUM
        first_pid = "cpu_0"

        def attempt_at(progress: float):
            game = self._make_game(
                card_registry, [Archetype.VANGUARD, Archetype.SWARM]
            )
            self._set_progress(game, progress)
            self._clear_shared_market(game)
            player = game.players[first_pid]
            player.resources = 5
            self._force_market(player, card_registry, [
                "neutral_land_grant", "neutral_explore",
            ])
            cpu = CPUPlayer(first_pid, noise=0.0, difficulty=MEDIUM)
            return cpu.pick_next_purchase(game)

        early = attempt_at(0.3)  # below medium threshold (0.5)
        late = attempt_at(0.7)   # above medium threshold
        assert early is not None, "Medium should buy normally before progress 0.5"
        assert late is None, "Medium should save once progress >= 0.5"

    def test_formula_vp_scales_with_deck_size(self, card_registry):
        """Arsenal (deck_div_10) scores higher with a fat deck than a thin one."""
        import dataclasses
        from app.game_engine.cpu_player import CPUPlayer, ARCHETYPE_WEIGHTS, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        weights = ARCHETYPE_WEIGHTS[player.archetype]
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
        arsenal = dataclasses.replace(card_registry["vanguard_arsenal"])

        # Thin deck (10 cards default at start)
        thin_score = cpu._score_card_for_purchase(
            arsenal, player, weights, cost=5, game=game,
        )
        # Pad the deck out to 40 cards
        filler = [
            dataclasses.replace(card_registry["neutral_gather"]) for _ in range(30)
        ]
        player.deck.discard.extend(filler)
        fat_score = cpu._score_card_for_purchase(
            arsenal, player, weights, cost=5, game=game,
        )
        assert fat_score > thin_score

    def test_market_denial_bumps_shared_vp_score(self, card_registry):
        """Shared-market VP cards score higher when an opponent could grab them."""
        import dataclasses
        from app.game_engine.cpu_player import CPUPlayer, ARCHETYPE_WEIGHTS, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        first_pid, second_pid = list(game.players.keys())
        player = game.players[first_pid]
        weights = ARCHETYPE_WEIGHTS[player.archetype]
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
        land_grant = dataclasses.replace(card_registry["neutral_land_grant"])

        game.players[second_pid].resources = 0
        score_no_threat = cpu._score_card_for_purchase(
            land_grant, player, weights, cost=7, game=game, from_shared=True,
        )
        game.players[second_pid].resources = 7
        score_with_threat = cpu._score_card_for_purchase(
            land_grant, player, weights, cost=7, game=game, from_shared=True,
        )
        assert score_with_threat > score_no_threat

    # ── Reroll bias ───────────────────────────────────────────────

    def test_hard_cpu_rerolls_when_no_vp_card_mid_game(self, card_registry):
        from app.game_engine.cpu_player import CPUPlayer, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        self._set_progress(game, 0.5)
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        player.resources = 5  # >= REROLL_COST + 2
        self._force_market(player, card_registry, [
            "neutral_gather", "neutral_explore", "neutral_explore",
        ])
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
        assert cpu.should_reroll_market(game) is True

    def test_cpu_keeps_market_when_vp_card_present(self, card_registry):
        from app.game_engine.cpu_player import CPUPlayer, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        self._set_progress(game, 0.5)
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        player.resources = 7
        self._force_market(player, card_registry, [
            "neutral_land_grant", "neutral_gather",
        ])
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
        assert cpu.should_reroll_market(game) is False

    def test_easy_cpu_does_not_reroll_for_vp(self, card_registry):
        """Easy CPUs stick with whatever rolled rather than hunting for VP."""
        from app.game_engine.cpu_player import CPUPlayer, EASY
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        self._set_progress(game, 0.5)
        first_pid = next(iter(game.players))
        player = game.players[first_pid]
        player.resources = 5
        # Force a market with all decent affordable cards (no VP, total_score
        # well above 3.0) so easy CPU won't fall through to the legacy reroll.
        self._force_market(player, card_registry, [
            "neutral_gather", "neutral_gather", "neutral_gather",
        ])
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=EASY)
        assert cpu.should_reroll_market(game) is False

    # ── Play-phase double-down ────────────────────────────────────

    def test_double_down_boosts_score_on_close_contested_vp_hex(self, card_registry):
        """A contested VP hex where the CPU's claim card is just shy of the
        defender's power should still score higher than a clearly-losing
        contest, signalling the action loop to follow up with a stack."""
        import dataclasses
        from app.game_engine.cpu_player import CPUPlayer, ARCHETYPE_WEIGHTS, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        first_pid, second_pid = list(game.players.keys())
        player = game.players[first_pid]
        weights = ARCHETYPE_WEIGHTS[player.archetype]
        cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)

        explore = dataclasses.replace(card_registry["neutral_explore"])  # power 1

        # Find a VP tile and assign it to opponent.
        vp_tile = next(
            t for t in game.grid.tiles.values() if t.is_vp
        )
        vp_tile.owner = second_pid

        # Close margin: defense 2 vs explore power 1 (margin -1, satisfies -2).
        vp_tile.defense_power = 2
        score_close = cpu._score_tile_for_claim(game, player, vp_tile, explore, weights)

        # Far margin: defense 6 vs explore power 1 (margin -5, fails -2 gate).
        vp_tile.defense_power = 6
        score_far = cpu._score_tile_for_claim(game, player, vp_tile, explore, weights)

        assert score_close > score_far

    def test_easy_cpu_does_not_double_down(self, card_registry):
        """Easy CPUs skip the double-down boost entirely."""
        import dataclasses
        from app.game_engine.cpu_player import CPUPlayer, ARCHETYPE_WEIGHTS, EASY, HARD
        game = self._make_game(card_registry, [Archetype.VANGUARD, Archetype.SWARM])
        first_pid, second_pid = list(game.players.keys())
        player = game.players[first_pid]
        weights = ARCHETYPE_WEIGHTS[player.archetype]
        explore = dataclasses.replace(card_registry["neutral_explore"])

        vp_tile = next(t for t in game.grid.tiles.values() if t.is_vp)
        vp_tile.owner = second_pid
        vp_tile.defense_power = 2  # close margin

        easy_cpu = CPUPlayer(first_pid, noise=0.0, difficulty=EASY)
        hard_cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
        easy_score = easy_cpu._score_tile_for_claim(game, player, vp_tile, explore, weights)
        hard_score = hard_cpu._score_tile_for_claim(game, player, vp_tile, explore, weights)
        assert hard_score > easy_score

    # ── Determinism ───────────────────────────────────────────────

    def test_purchase_decisions_are_deterministic(self, card_registry):
        """Same seed + Hard difficulty produces identical buy decisions across runs."""
        from app.game_engine.cpu_player import CPUPlayer, HARD

        def run_once():
            game = self._make_game(
                card_registry, [Archetype.VANGUARD, Archetype.SWARM], seed=42,
            )
            self._set_progress(game, 0.5)
            first_pid = next(iter(game.players))
            player = game.players[first_pid]
            player.resources = 7
            self._force_market(player, card_registry, [
                "neutral_land_grant", "neutral_gather", "neutral_explore",
            ])
            cpu = CPUPlayer(first_pid, noise=0.0, difficulty=HARD)
            return cpu.pick_next_purchase(game)

        first = run_once()
        second = run_once()
        assert first == second


# ── Head-to-head difficulty tier validation ───────────────────────

class TestDifficultyHeadToHead:
    """Validate tiered behavior in actual gameplay.

    The user's design intent is human-vs-CPU difficulty (Hard challenges
    optimal play, Easy is approachable). CPU-vs-CPU win rates are an
    unreliable signal because both tiers play tiles equally well — the
    delta is in buy-phase VP-card pursuit.

    These tests therefore measure the BEHAVIOR we shipped (Hard buys
    more VP cards, Hard saves resources for big buys, Hard is at least
    competitive with Easy in head-to-head) rather than chasing brittle
    win-rate margins.
    """

    @staticmethod
    def _run_match(card_registry, archs, diffs, seed):
        from app.game_engine.simulation import SimConfig, run_game
        cfg = SimConfig(
            grid_size=GridSize.SMALL,
            player_archetypes=archs,
            cpu_difficulties=diffs,
            cpu_noise=0.0,
            seed=seed,
            max_rounds=20,
        )
        return run_game(cfg, card_registry=card_registry)

    def test_hard_buys_more_vp_cards_than_easy(self, card_registry):
        """Hard's VP-pursuit heuristics should produce more VP-card buys
        across many games than Easy's baseline behavior."""
        from app.game_engine.cpu_player import _is_vp_card

        vp_card_names = {
            card.name for card in card_registry.values() if _is_vp_card(card)
        }
        pairings = [
            (Archetype.VANGUARD, Archetype.SWARM),
            (Archetype.SWARM, Archetype.FORTRESS),
            (Archetype.FORTRESS, Archetype.VANGUARD),
        ]
        hard_vp_buys = 0
        easy_vp_buys = 0
        for arch_a, arch_b in pairings:
            for seed in range(8):
                for swap in (False, True):
                    archs = [arch_b, arch_a] if swap else [arch_a, arch_b]
                    diffs = (["easy", "hard"] if swap else ["hard", "easy"])
                    hard_seat = "cpu_1" if swap else "cpu_0"
                    easy_seat = "cpu_0" if swap else "cpu_1"
                    result = self._run_match(card_registry, archs, diffs, seed)
                    assert result.error is None
                    for pr in result.player_results:
                        n = sum(
                            count for name, count in pr.cards_purchased.items()
                            if name in vp_card_names
                        )
                        if pr.player_id == hard_seat:
                            hard_vp_buys += n
                        elif pr.player_id == easy_seat:
                            easy_vp_buys += n
        assert hard_vp_buys > easy_vp_buys, (
            f"Hard CPUs bought {hard_vp_buys} VP cards vs Easy {easy_vp_buys}"
        )

    def test_hard_at_least_competitive_with_easy(self, card_registry):
        """Hard should never decisively lose to Easy across a seed pool.

        With noise=0 the result is fully deterministic; this asserts a soft
        floor (Hard wins at least as many decided games as Easy minus a
        small slack for archetype/seat asymmetries).
        """
        pairings = [
            (Archetype.VANGUARD, Archetype.SWARM),
            (Archetype.SWARM, Archetype.FORTRESS),
            (Archetype.FORTRESS, Archetype.VANGUARD),
        ]
        hard_wins = 0
        easy_wins = 0
        for arch_a, arch_b in pairings:
            for seed in range(8):
                for swap in (False, True):
                    archs = [arch_b, arch_a] if swap else [arch_a, arch_b]
                    diffs = (["easy", "hard"] if swap else ["hard", "easy"])
                    hard_seat = "cpu_1" if swap else "cpu_0"
                    easy_seat = "cpu_0" if swap else "cpu_1"
                    result = self._run_match(card_registry, archs, diffs, seed)
                    assert result.error is None
                    if result.winner_id == hard_seat:
                        hard_wins += 1
                    elif result.winner_id == easy_seat:
                        easy_wins += 1
        # Allow up to 4 games of slack (≈8% of 48-game pool).
        assert hard_wins + 4 >= easy_wins, (
            f"Hard {hard_wins} vs Easy {easy_wins} — Hard losing decisively"
        )
