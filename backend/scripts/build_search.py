#!/usr/bin/env python3
"""Search for strong builds (buy plans) in a card pack.

A build is a list of (card, copies) bought first-affordable-first; when
nothing on it fits, the bot buys as its tier normally would (or as Fast Claim,
with --fallback fast_claim). This hill-climbs over builds for one archetype:
each round it tries a handful of mutations of the best build so far (add,
drop, swap, re-count a card), scores them all on the same seeds against the
opponent, and keeps the best only if it beats the incumbent on those seeds.
The finalists are re-scored on fresh seeds at the end, so the search can't
fool itself with lucky seeds.

  uv run python scripts/build_search.py --pack first_clash --archetype swarm
  uv run python scripts/build_search.py --pack first_clash --grid large --play hard --vs fastclaim --rounds 15

Paste the winners into app/game_engine/pack_builds.py, then re-run
scripts/pack_builds.py --write-ratings. TUNE_SWAPS="pack:arch:old=new" tries a
pack change first; --plans scores given builds instead of searching.
"""
from __future__ import annotations

import argparse
import os
import random
import sys
from multiprocessing import Pool
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHES = ["vanguard", "swarm", "fortress"]
Plan = tuple[tuple[str, int], ...]
_REG: dict[str, Any] = {}


def _init() -> None:
    import logging
    logging.disable(logging.WARNING)
    from app.data_loader.loader import load_all_cards
    global _REG
    _REG = load_all_cards()
    # TUNE_SWAPS="pack:arch:old=new;..." tries a card swap without editing
    # card_packs.py (arch "shared" for the shared market), as in pack_balance.py.
    from app.game_engine.card_packs import CARD_PACKS
    for sw in filter(None, os.environ.get("TUNE_SWAPS", "").split(";")):
        pack, arch, pair = sw.split(":")
        old_id, new_id = pair.split("=")
        p = CARD_PACKS[pack]
        ids = p.shared_card_ids if arch == "shared" else (p.archetype_card_ids or {})[arch]
        assert ids is not None
        ids[ids.index(old_id)] = new_id


def _bot(kind: str, pid: str, rng: random.Random, plan: Optional[Plan], play: str, fallback: str) -> Any:
    from app.game_engine import cpu_builds
    from app.game_engine.cpu_player import CPUPlayer
    from app.game_engine.pack_builds import Build
    if plan is None:
        if kind == "fastclaim":
            return cpu_builds.FastClaimCPU(pid, rng=rng)
        if kind == "rush":
            return cpu_builds.FastClaimCPU(pid, rng=rng, play="hard")
        return CPUPlayer(pid, difficulty=kind, rng=rng)
    build = Build("search", "search", None, plan)

    class Searched(CPUPlayer):
        def pick_next_purchase(self, game: Any) -> Optional[dict[str, Any]]:
            player = game.players[self.player_id]
            if player.turn_modifiers.buy_locked or player.resources <= 0:
                return None
            pick = cpu_builds.plan_purchase(game, player, build)
            if pick is not None:
                return pick
            if fallback == "fast_claim":
                return cpu_builds.fast_claim_purchase(game, player)
            return super().pick_next_purchase(game)
    return Searched(pid, difficulty=play, rng=rng)


def run_one(job: tuple) -> float:
    pack, grid, arch, plan, play, fallback, vs, seed = job
    from app.game_engine.game_state import (
        Phase, advance_resolve, create_game, execute_start_of_turn, execute_upkeep,
    )
    from app.game_engine.hex_grid import GridSize
    from app.game_engine.simulation import PlayerResult, _run_buy_phase, _run_play_phase
    rng = random.Random(seed)
    cfg = [{"id": "p0", "name": "A", "archetype": arch}, {"id": "p1", "name": "B", "archetype": rng.choice(ARCHES)}]
    game = create_game(GridSize(grid), cfg, _REG, seed=seed, card_pack=pack, max_rounds=20)
    cpus = {"p0": _bot("", "p0", game.rng, plan, play, fallback), "p1": _bot(vs, "p1", game.rng, None, play, fallback)}
    tracking = {pid: PlayerResult(player_id=pid, name=pid, archetype="") for pid in game.player_order}
    execute_start_of_turn(game)
    while game.current_phase != Phase.GAME_OVER and game.current_round <= 23:
        ph = game.current_phase
        if ph == Phase.PLAY:
            _run_play_phase(game, cpus, tracking, False)
        elif ph == Phase.REVEAL:
            for pid in game.player_order:
                advance_resolve(game, pid)
        elif ph == Phase.BUY:
            _run_buy_phase(game, cpus, tracking, False)
        elif ph == Phase.UPKEEP:
            execute_upkeep(game)
        elif ph == Phase.START_OF_TURN:
            execute_start_of_turn(game)
        else:
            break
    winners = list(game.winners) if game.winners else ([game.winner] if game.winner else [])
    return 1.0 if winners == ["p0"] else 0.0 if winners == ["p1"] else 0.5


def show(plan: Plan) -> str:
    return ", ".join(f"{_REG[c].name} ×{n}" for c, n in plan) or "(tier's own buying)"


def mutate(plan: Plan, pool: list[str], rng: random.Random) -> Plan:
    p = list(plan)
    unused = [c for c in pool if c not in {x for x, _ in p}]

    def copies(cid: str) -> int:
        return 1 if _REG[cid].unique else rng.choice([1, 2, 2, 3])
    ops = ["add", "drop", "count", "swap", "replace"]
    while True:
        op = rng.choice(ops)
        if op == "add" and unused and len(p) < 5:
            c = rng.choice(unused)
            p.insert(rng.randrange(len(p) + 1), (c, copies(c)))
        elif op == "drop" and p:
            p.pop(rng.randrange(len(p)))
        elif op == "count" and p:
            i = rng.randrange(len(p))
            c, n = p[i]
            if _REG[c].unique:
                continue
            p[i] = (c, max(1, min(4, n + rng.choice([-1, 1]))))
        elif op == "swap" and len(p) >= 2:
            i = rng.randrange(len(p) - 1)
            p[i], p[i + 1] = p[i + 1], p[i]
        elif op == "replace" and p and unused:
            i = rng.randrange(len(p))
            c = rng.choice(unused)
            p[i] = (c, copies(c))
        else:
            continue
        if tuple(p) != plan:
            return tuple(p)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", default="first_clash")
    ap.add_argument("--archetype", default="all")
    ap.add_argument("--grid", default="large")
    ap.add_argument("--play", default="hard", help="tactics of the build bot (easy/medium/hard)")
    ap.add_argument("--vs", default="fastclaim", help="opponent: fastclaim, rush, easy, medium, hard")
    ap.add_argument("--fallback", default="tier", choices=["tier", "fast_claim"])
    ap.add_argument("--rounds", type=int, default=14)
    ap.add_argument("--mutants", type=int, default=6)
    ap.add_argument("--games", type=int, default=150, help="games per candidate per round")
    ap.add_argument("--final-games", type=int, default=500)
    ap.add_argument("--keep", type=int, default=4, help="distinct finalists to re-score")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--plans", default="", help='score these builds only: "card:n,card:n|card:n" (one | per build)')
    args = ap.parse_args()

    _init()
    from app.game_engine.card_packs import CARD_PACKS
    from app.game_engine.pack_builds import pack_builds
    pack = CARD_PACKS[args.pack]
    rng = random.Random(args.seed)
    arches = ARCHES if args.archetype == "all" else [args.archetype]

    with Pool(args.workers, initializer=_init) as workers:
        def score(arch: str, plans: list[Plan], seed0: int, n: int) -> list[float]:
            jobs = [(args.pack, args.grid, arch, plan, args.play, args.fallback, args.vs, seed0 + i)
                    for plan in plans for i in range(n)]
            res = workers.map(run_one, jobs, chunksize=8)
            return [sum(res[k * n:(k + 1) * n]) / n for k in range(len(plans))]

        if args.plans:
            plans: list[Plan] = [()]
            for spec in args.plans.split("|"):
                plans.append(tuple((c, int(n)) for c, n in (x.split(":") for x in spec.split(",") if x)))
            for arch in arches:
                res = score(arch, plans, 9_000_000 + args.seed, args.final_games)
                print(f"\n=== {pack.name} · {arch} · {args.grid} · {args.play} play vs {args.vs}, {args.final_games} games")
                for p, s in sorted(zip(plans, res), key=lambda t: -t[1]):
                    print(f"   {s * 100:5.1f}%  {show(p)}", flush=True)
            return

        for arch in arches:
            pool = list(pack.shared_card_ids or []) + list((pack.archetype_card_ids or {})[arch])
            starts: list[Plan] = [()] + [b.plan for b in pack_builds(args.pack) if b.archetype in (None, arch)]
            print(f"\n=== {pack.name} · {arch} · {args.grid} · {args.play} play vs {args.vs} "
                  f"(fallback: {args.fallback})", flush=True)
            seed = 1_000_000 * (1 + ARCHES.index(arch)) + args.seed * 10_000
            base = score(arch, starts, seed, args.games)
            seen: dict[Plan, list[float]] = {p: [s] for p, s in zip(starts, base)}
            for p, s in sorted(zip(starts, base), key=lambda t: -t[1]):
                print(f"   start {s * 100:5.1f}%  {show(p)}", flush=True)
            best = max(zip(starts, base), key=lambda t: t[1])[0]
            for r in range(args.rounds):
                seed += args.games
                mutants = []
                while len(mutants) < args.mutants:
                    m = mutate(best, pool, rng)
                    if m not in mutants:
                        mutants.append(m)
                scores = score(arch, [best] + mutants, seed, args.games)
                for p, s in zip([best] + mutants, scores):
                    seen.setdefault(p, []).append(s)
                top = max(range(len(mutants)), key=lambda k: scores[k + 1])
                if scores[top + 1] > scores[0]:
                    best = mutants[top]
                    print(f"   round {r + 1:2}: {scores[top + 1] * 100:5.1f}% (was {scores[0] * 100:.1f})  {show(best)}", flush=True)
                else:
                    print(f"   round {r + 1:2}: kept {scores[0] * 100:5.1f}%", flush=True)
            # Finalists: best average across the plans tried more than once, distinct key cards.
            ranked = sorted(seen.items(), key=lambda kv: -(sum(kv[1]) / len(kv[1])))
            finalists: list[Plan] = []
            for plan, _ in ranked:
                key = frozenset(c for c, _ in plan[:2])
                if all(frozenset(c for c, _ in f[:2]) != key for f in finalists):
                    finalists.append(plan)
                if len(finalists) >= args.keep:
                    break
            if () not in finalists:
                finalists.append(())
            final = score(arch, finalists, 9_000_000 + seed, args.final_games)
            print(f"   — finalists, {args.final_games} fresh games each:")
            for p, s in sorted(zip(finalists, final), key=lambda t: -t[1]):
                print(f"   {s * 100:5.1f}%  {show(p)}   {p}", flush=True)


if __name__ == "__main__":
    main()
