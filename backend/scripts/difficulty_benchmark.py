#!/usr/bin/env python3
"""Head-to-head CPU difficulty benchmark.

Pits two CPU "agents" against each other over many seeded games and reports
win rates. Besides the three shipped difficulty tiers it includes scripted
exploit bots that mimic strategies human playtesters have used to beat the
CPU, so difficulty tuning can be checked against them:

  easy / medium / hard   shipped CPUPlayer difficulty tiers
  fastclaim              the baseline: Fast Claim buying (the strongest Claim
                         it can afford, else save) with Medium play — Easy
                         should lose to it, Medium match it, Hard beat it
  rush                   Fast Claim buying with Hard play logic (the
                         "strike rush"); rerolls hunting for big Claims
  greedy                 buys the most expensive affordable card every turn
                         (a naive "big money" human)
  raider                 Hard economy with hyper-aggressive targeting of the
                         opponent's VP hexes, bridges and base
  <tier>@base            a shipped tier using cpu_player.py from git HEAD
                         (or --baseline-ref), to compare against the
                         pre-change CPU, e.g. hard:hard@base

Usage:
    cd backend
    uv run python scripts/difficulty_benchmark.py hard:rush medium:rush --games 200
    uv run python scripts/difficulty_benchmark.py --suite --games 150 --grid small,medium

Each matchup alternates seats and samples archetypes uniformly, so results are
seat- and archetype-balanced. Games run in parallel worker processes.
"""

from __future__ import annotations

import argparse
import multiprocessing as mp
import os
import random
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional

_backend_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, _backend_dir)

from app.data_loader.loader import load_all_cards  # noqa: E402
from app.game_engine.cards import Archetype, CardType  # noqa: E402
from app.game_engine.cpu_builds import FastClaimCPU, fast_claim_purchase  # noqa: E402
from app.game_engine.cpu_player import (  # noqa: E402
    EASY,
    HARD,
    MEDIUM,
    CPUPlayer,
)
from app.game_engine.effects import EffectType  # noqa: E402
from app.game_engine.game_state import (  # noqa: E402
    REROLL_COST,
    Phase,
    advance_resolve,
    calculate_dynamic_buy_cost,
    compute_player_vp,
    create_game,
    execute_start_of_turn,
    execute_upkeep,
    player_owns_card_definition,
)
from app.game_engine.hex_grid import GridSize  # noqa: E402
from app.game_engine.simulation import PlayerResult, _run_buy_phase, _run_play_phase  # noqa: E402

ARCHETYPES = [Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS]
GRIDS = {g.value: g for g in GridSize}


# ── Exploit bots ──────────────────────────────────────────────────


def _claim_power_estimate(cpu: CPUPlayer, game: Any, card: Any) -> float:
    power = float(card.effective_power)
    for effect in card.effects:
        if effect.type == EffectType.POWER_PER_TILES_OWNED and game.grid is not None:
            divisor = effect.effective_value(card.is_upgraded) or 3
            bonus = len(game.grid.get_player_tiles(cpu.player_id)) // divisor
            power = bonus if effect.metadata.get("replaces_base_power") else power + bonus
        elif effect.type == EffectType.POWER_MODIFIER:
            power += effect.effective_value(card.is_upgraded) * 0.5
    return power


class StrikeRushCPU(CPUPlayer):
    """Plays like Hard, but buys only big Claims (the 'strike card' rush) —
    the Fast Claim build, Card Clash's Big Money."""

    def _market_options(self, game: Any, player: Any) -> list[tuple[Any, int, dict[str, Any]]]:
        opts: list[tuple[Any, int, dict[str, Any]]] = []
        for card in player.archetype_market:
            if card.unique and player_owns_card_definition(player, card.definition_id):
                continue
            opts.append((card, calculate_dynamic_buy_cost(game, player, card),
                         {"source": "archetype", "card_id": card.id,
                          "definition_id": card.definition_id}))
        bought = {p["card_id"] for p in game.buy_phase_purchases.get(self.player_id, [])
                  if p["source"] == "shared"}
        for base_id, copies in game.shared_market.stacks.items():
            if not copies or base_id in bought:
                continue
            card = copies[0]
            if card.unique and player_owns_card_definition(player, card.definition_id):
                continue
            opts.append((card, calculate_dynamic_buy_cost(game, player, card),
                         {"source": "shared", "card_id": base_id,
                          "definition_id": card.definition_id}))
        return opts

    def _pick_best_purchase(self, game: Any, player: Any, weights: Any) -> Optional[dict[str, Any]]:
        # The in-app Fast Claim build (app/game_engine/cpu_builds.py) — the
        # baseline packs are measured against.
        return fast_claim_purchase(game, player)

    def should_reroll_market(self, game: Any) -> bool:
        player = game.players[self.player_id]
        if player.resources < REROLL_COST + 4:
            return False
        for card in player.archetype_market:
            if card.card_type == CardType.CLAIM and _claim_power_estimate(self, game, card) >= 4:
                return False
        return True


class RaiderCPU(CPUPlayer):
    """Hard economy, but hyper-aggressive targeting: goes after the
    opponent's VP hexes, bridges and base like an attacking human."""

    def _get_weights(self, player: Any, game: Any) -> Any:
        from app.game_engine.cpu_player import StrategyWeights
        return StrategyWeights(aggression=4.0, expansion=0.8, defense=0.3,
                               vp_hex_priority=3.0, card_draw_value=1.0, resource_value=0.8)


class GreedyCPU(CPUPlayer):
    """Buys the most expensive affordable card every time (naive big-money)."""

    def _pick_best_purchase(self, game: Any, player: Any, weights: Any) -> Optional[dict[str, Any]]:
        best: Optional[tuple[int, dict[str, Any]]] = None
        for card, cost, action in StrikeRushCPU._market_options(self, game, player):  # type: ignore[arg-type]
            if cost > player.resources or card.passive_vp < 0:
                continue
            if card.definition_id in ("neutral_diplomat",):
                continue
            if best is None or cost > best[0]:
                best = (cost, action)
        return best[1] if best else None

    def should_reroll_market(self, game: Any) -> bool:
        return False


_BASELINE_REF = os.environ.get("BENCH_BASELINE_REF", "HEAD")
_baseline_cls: Any = None


def _baseline_cpu_class() -> Any:
    """Load CPUPlayer from cpu_player.py at a git ref, as a sibling module of
    app.game_engine so its relative imports resolve against current code."""
    global _baseline_cls
    if _baseline_cls is not None:
        return _baseline_cls
    import importlib.util
    import subprocess
    import tempfile

    src = subprocess.run(
        ["git", "show", f"{_BASELINE_REF}:backend/app/game_engine/cpu_player.py"],
        cwd=_backend_dir, check=True, capture_output=True, text=True,
    ).stdout
    path = os.path.join(tempfile.gettempdir(), f"cpu_player_baseline_{os.getpid()}.py")
    with open(path, "w") as fh:
        fh.write(src)
    name = "app.game_engine._cpu_player_baseline"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)

    class BaselineCPU(module.CPUPlayer):  # type: ignore[name-defined, misc]
        def spend_upgrade_credits(self, game: Any) -> int:
            return 0  # the baseline never spent credits

    _baseline_cls = BaselineCPU
    return _baseline_cls


def make_agent(kind: str, pid: str, rng: random.Random) -> CPUPlayer:
    # Profile overrides: "hard~threat_modeling=0,purchase_saving=0,noise=0.1"
    if "~" in kind:
        import dataclasses
        base_kind, spec = kind.split("~", 1)
        agent = make_agent(base_kind, pid, rng)
        overrides: dict[str, Any] = {}
        for item in spec.split(","):
            field_name, raw = item.split("=")
            if field_name == "noise":
                agent.noise = float(raw)
                continue
            current = getattr(agent.profile, field_name)
            if isinstance(current, bool):
                overrides[field_name] = raw.lower() in ("1", "true", "yes", "on")
            else:
                overrides[field_name] = type(current)(raw)
        agent.profile = dataclasses.replace(agent.profile, **overrides)
        return agent
    if kind.endswith("@base"):
        return _baseline_cpu_class()(pid, difficulty=kind.split("@")[0], rng=rng)
    if kind in (EASY, MEDIUM, HARD):
        return CPUPlayer(pid, difficulty=kind, rng=rng)
    if kind == "fastclaim":
        return FastClaimCPU(pid, rng=rng)
    if kind == "rush":
        return StrikeRushCPU(pid, difficulty=HARD, rng=rng)
    if kind == "greedy":
        return GreedyCPU(pid, difficulty=HARD, rng=rng)
    if kind == "raider":
        return RaiderCPU(pid, difficulty=HARD, rng=rng)
    raise ValueError(f"unknown agent kind: {kind}")


# ── Game runner ───────────────────────────────────────────────────


@dataclass
class Job:
    seed: int
    grid: str
    kinds: tuple[str, ...]        # agent kind per seat
    archetypes: tuple[str, ...]   # archetype per seat
    max_rounds: int
    seat_a: int = 0               # seat of the agent whose win rate is reported
    pack: str = "everything"      # card pack id (shared-market selection)


def _run_job(job: Job) -> dict[str, Any]:
    registry = _REGISTRY
    configs = [
        {"id": f"p{i}", "name": f"{k}_{i}", "archetype": a, "is_cpu": True, "cpu_difficulty": HARD}
        for i, (k, a) in enumerate(zip(job.kinds, job.archetypes))
    ]
    game = create_game(GRIDS[job.grid], configs, registry, seed=job.seed,
                       max_rounds=job.max_rounds, card_pack=job.pack)
    agents = {pid: make_agent(job.kinds[i], pid, game.rng) for i, pid in enumerate(game.player_order)}
    tracking = {pid: PlayerResult(player_id=pid, name=pid, archetype="") for pid in game.player_order}
    execute_start_of_turn(game)
    error = None
    try:
        while game.current_phase != Phase.GAME_OVER and game.current_round <= job.max_rounds + 5:
            phase = game.current_phase
            if phase == Phase.PLAY:
                _run_play_phase(game, agents, tracking, False)
            elif phase == Phase.REVEAL:
                for pid in game.player_order:
                    if not game.players[pid].has_acknowledged_resolve:
                        advance_resolve(game, pid)
            elif phase == Phase.BUY:
                _run_buy_phase(game, agents, tracking, False)
            elif phase == Phase.UPKEEP:
                execute_upkeep(game)
            elif phase == Phase.START_OF_TURN:
                execute_start_of_turn(game)
            else:
                break
    except Exception as exc:  # pragma: no cover - surfaced in the report
        error = f"{type(exc).__name__}: {exc}"
    vps = [compute_player_vp(game, pid) for pid in game.player_order]
    winner_seat = game.player_order.index(game.winner) if game.winner in game.player_order else None
    if len(game.winners) > 1:
        winner_seat = None  # shared victory counts as a draw, not a win for winners[0]
    return {
        "kinds": job.kinds,
        "archetypes": job.archetypes,
        "grid": job.grid,
        "winner_seat": winner_seat,
        "seat_a": job.seat_a,
        "vps": vps,
        "rounds": game.current_round,
        "error": error,
    }


_REGISTRY: dict[str, Any] = {}


def _init_worker() -> None:
    global _REGISTRY, _BASELINE_REF
    _BASELINE_REF = os.environ.get("BENCH_BASELINE_REF", "HEAD")
    import logging
    logging.disable(logging.WARNING)
    _REGISTRY = load_all_cards()


def build_jobs(kind_a: str, kind_b: str, games: int, grid: str, base_seed: int,
               max_rounds: int, players: int, pack: str = "everything") -> list[Job]:
    rng = random.Random(base_seed)
    jobs: list[Job] = []
    for i in range(games):
        # Seat 0 alternates between A and B; extra seats (3p+) are filled with B.
        others = [kind_b] * (players - 1)
        seat_a = i % players  # rotate A through every seat
        kinds = others[:seat_a] + [kind_a] + others[seat_a:]
        archs = tuple(rng.choice(ARCHETYPES).value for _ in range(players))
        jobs.append(Job(seed=base_seed + i, grid=grid, kinds=tuple(kinds),
                        archetypes=archs, max_rounds=max_rounds, seat_a=seat_a, pack=pack))
    return jobs


def summarize(kind_a: str, results: list[dict[str, Any]]) -> dict[str, Any]:
    wins = losses = draws = errors = 0
    margin = 0.0
    rounds = 0
    by_arch: dict[str, list[int]] = {}
    for r in results:
        if r["error"]:
            errors += 1
            continue
        seat_a = r["seat_a"]
        arch = r["archetypes"][seat_a]
        rec = by_arch.setdefault(arch, [0, 0])
        rec[1] += 1
        if r["winner_seat"] is None:
            draws += 1
        elif r["winner_seat"] == seat_a:
            wins += 1
            rec[0] += 1
        else:
            losses += 1
        others = [v for i, v in enumerate(r["vps"]) if i != seat_a]
        margin += r["vps"][seat_a] - max(others)
        rounds += r["rounds"]
    n = max(1, len(results) - errors)
    return {
        "wins": wins, "losses": losses, "draws": draws, "errors": errors,
        "win_rate": wins / n, "avg_margin": margin / n, "avg_rounds": rounds / n,
        "by_arch": {a: (w / t if t else 0.0, t) for a, (w, t) in by_arch.items()},
        "error_samples": [r["error"] for r in results if r["error"]][:3],
    }


def run_matchup(pool: Any, kind_a: str, kind_b: str, games: int, grid: str,
                base_seed: int, max_rounds: int, players: int,
                pack: str = "everything") -> dict[str, Any]:
    jobs = build_jobs(kind_a, kind_b, games, grid, base_seed, max_rounds, players, pack)
    results = pool.map(_run_job, jobs, chunksize=max(1, games // 40))
    return summarize(kind_a, results)


def format_row(kind_a: str, kind_b: str, grid: str, players: int, s: dict[str, Any]) -> str:
    arch = " ".join(f"{a[:3]}={wr:.0%}" for a, (wr, _t) in sorted(s["by_arch"].items()))
    err = f" ERR={s['errors']}" if s["errors"] else ""
    return (f"{kind_a:>11} vs {kind_b:<11} {grid:<7}{players}p  "
            f"win {s['win_rate']:6.1%}  W/L/D {s['wins']}/{s['losses']}/{s['draws']}  "
            f"margin {s['avg_margin']:+5.1f}  rounds {s['avg_rounds']:4.1f}  [{arch}]{err}")


SUITE = [
    ("hard", "easy"), ("hard", "medium"), ("medium", "easy"),
    ("hard", "fastclaim"), ("medium", "fastclaim"), ("easy", "fastclaim"),
    ("hard", "rush"), ("medium", "rush"), ("easy", "rush"),
    ("hard", "greedy"), ("medium", "greedy"),
    ("hard", "raider"), ("medium", "raider"),
    ("hard", "hard@base"), ("medium", "hard@base"), ("easy", "easy@base"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("matchups", nargs="*", help="A:B pairs, e.g. hard:rush (win rate reported for A)")
    parser.add_argument("--suite", action="store_true", help="run the standard matchup suite")
    parser.add_argument("--games", type=int, default=100)
    parser.add_argument("--grid", default="small", help="comma-separated grid sizes")
    parser.add_argument("--players", type=int, default=2)
    parser.add_argument("--seed", type=int, default=1000)
    parser.add_argument("--max-rounds", type=int, default=20)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    parser.add_argument("--pack", default="everything",
                        help="comma-separated card pack ids (see app/game_engine/card_packs.py)")
    parser.add_argument("--baseline-ref", default="HEAD",
                        help="git ref whose cpu_player.py backs the <tier>@base agents")
    args = parser.parse_args()
    os.environ["BENCH_BASELINE_REF"] = args.baseline_ref

    pairs = list(SUITE) if args.suite else []
    for m in args.matchups:
        a, b = m.split(":")
        pairs.append((a, b))
    if not pairs:
        parser.error("give matchups or --suite")

    start = time.monotonic()
    with mp.get_context("spawn").Pool(args.workers, initializer=_init_worker) as pool:
        for pack in args.pack.split(","):
            if pack != "everything":
                print(f"== pack: {pack}", flush=True)
            for grid in args.grid.split(","):
                for a, b in pairs:
                    s = run_matchup(pool, a, b, args.games, grid, args.seed, args.max_rounds,
                                    args.players, pack)
                    print(format_row(a, b, grid, args.players, s), flush=True)
                for e in s["error_samples"]:
                    print(f"    error: {e}")
    print(f"done in {time.monotonic() - start:.0f}s")


if __name__ == "__main__":
    main()
