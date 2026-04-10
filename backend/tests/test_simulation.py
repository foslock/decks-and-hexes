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
