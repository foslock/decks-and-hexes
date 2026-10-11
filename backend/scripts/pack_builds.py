#!/usr/bin/env python3
"""Pack acceptance test: does each card pack offer several strategies?

Like Dominion's Big Money benchmark. Every build in `pack_builds.py` plays
2-player games against Fast Claim (the baseline bot: buy the Claim with the
best typical power you can afford, Medium tactics — Card Clash's Big Money),
and optionally a round-robin against every other build. A build bot buys its
build's cards first, then as its tier would; it plays with the same tactics
as Fast Claim (Medium, unless --play), so only the buying differs.

A pack passes on a map size when:
  1. at least 3 builds beat Fast Claim (>= 55%), including one per archetype;
  2. no build beats every other build (needs the round-robin);
  3. every pack card is in at least one build that beats Fast Claim;
  4. Fast Claim beats the Easy CPU.

  uv run python scripts/pack_builds.py                      # all packs, large + medium
  uv run python scripts/pack_builds.py --packs first_clash --games 400 --rr-games 150
  uv run python scripts/pack_builds.py --write-ratings      # update data/build_ratings.json
  uv run python scripts/pack_builds.py --tiers              # also Easy/Medium/Hard vs Fast Claim
  uv run python scripts/pack_builds.py --vp-plus 4 --rr-games 0   # longer games: does investing pay off?

--write-ratings stores each build's win rate vs Fast Claim, which the CPU
tiers use to pick builds (see app/game_engine/cpu_builds.py).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import defaultdict
from multiprocessing import Pool
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHES = ["vanguard", "swarm", "fortress"]
PACKS = ["first_clash", "border_war", "deep_roots", "far_reaches"]
FAST = "fast_claim"
_REG: dict[str, Any] = {}


def _init() -> None:
    import logging
    logging.disable(logging.WARNING)
    from app.data_loader.loader import load_all_cards
    global _REG
    _REG = load_all_cards()


def _bot(kind: str, pid: str, pack: str, rng: random.Random, play: str, fallback: str) -> Any:
    from app.game_engine import cpu_builds
    from app.game_engine.cpu_player import CPUPlayer
    from app.game_engine.pack_builds import pack_builds
    if kind.startswith("@"):  # a shipped CPU tier, as players meet it
        return CPUPlayer(pid, difficulty=kind[1:], rng=rng)
    if kind == FAST:
        return cpu_builds.FastClaimCPU(pid, rng=rng)
    build = next(b for b in pack_builds(pack) if b.id == kind)

    class BuildCPU(CPUPlayer):
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

        def should_reroll_market(self, game: Any) -> bool:
            return False
    return BuildCPU(pid, difficulty=play, rng=rng)


def _arch(kind: str, pack: str, rng: random.Random) -> str:
    from app.game_engine.pack_builds import pack_builds
    for b in pack_builds(pack):
        if b.id == kind and b.archetype:
            return b.archetype
    return rng.choice(ARCHES)


def run_one(job: tuple) -> dict[str, Any]:
    pack, grid, a, b, seed, vp_plus, play, fallback = job
    from app.game_engine.game_state import (
        Phase, advance_resolve, create_game, execute_start_of_turn, execute_upkeep,
    )
    from app.game_engine.hex_grid import GridSize
    from app.game_engine.simulation import PlayerResult, _run_buy_phase, _run_play_phase
    rng = random.Random(seed)
    cfg = [{"id": "p0", "name": "A", "archetype": _arch(a, pack, rng)},
           {"id": "p1", "name": "B", "archetype": _arch(b, pack, rng)}]
    from app.game_engine.game_state import compute_vp_target
    target = compute_vp_target(GridSize(grid), 2) + vp_plus
    game = create_game(GridSize(grid), cfg, _REG, seed=seed, card_pack=pack, max_rounds=20, vp_target=target)
    for p, c in zip(game.players.values(), cfg):
        p.is_cpu = True
    cpus = {"p0": _bot(a, "p0", pack, game.rng, play, fallback), "p1": _bot(b, "p1", pack, game.rng, play, fallback)}
    tracking = {pid: PlayerResult(player_id=pid, name=pid, archetype="") for pid in game.player_order}
    execute_start_of_turn(game)
    err = None
    try:
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
    except Exception as e:  # noqa: BLE001 - surfaced in the report
        err = f"{type(e).__name__}: {e}"
    winners = list(game.winners) if game.winners else ([game.winner] if game.winner else [])
    score = 1.0 if winners == ["p0"] else 0.0 if winners == ["p1"] else 0.5
    return {"job": job, "score": score, "rounds": game.current_round, "err": err}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--packs", default=",".join(PACKS))
    ap.add_argument("--grids", default="large,medium", help="2 players' suggested map is Large")
    ap.add_argument("--games", type=int, default=300, help="games per build vs Fast Claim")
    ap.add_argument("--rr-games", type=int, default=100, help="games per build pairing (0: skip the round-robin)")
    ap.add_argument("--seed", type=int, default=31_000)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--tiers", action="store_true", help="also Medium and Hard CPUs vs Fast Claim")
    ap.add_argument("--vp-plus", type=int, default=0, help="raise the VP target by this much (longer games)")
    ap.add_argument("--play", default="medium", help="tactics of the build bots (Fast Claim's are Medium)")
    ap.add_argument("--fallback", default="tier", choices=["tier", "fast_claim"],
                    help="what a build bot buys when nothing on its list fits")
    ap.add_argument("--write-ratings", action="store_true")
    args = ap.parse_args()

    _init()
    from app.game_engine.card_packs import CARD_PACKS
    from app.game_engine.cpu_builds import RATINGS_PATH, VIABLE_RATING
    from app.game_engine.pack_builds import pack_builds

    packs, grids = args.packs.split(","), args.grids.split(",")
    tiers = ["@easy"] + (["@medium", "@hard"] if args.tiers else [])
    jobs: list[tuple] = []
    for pk in packs:
        ids = [b.id for b in pack_builds(pk)]
        for g in grids:
            for i in range(args.games):
                for kind in ids + tiers:
                    jobs.append((pk, g, kind, FAST, args.seed + i, args.vp_plus, args.play, args.fallback))
            if args.rr_games:
                for x in range(len(ids)):
                    for y in range(x + 1, len(ids)):
                        for i in range(args.rr_games):
                            # alternate who is p0 so seat order never favors one side
                            a, b = (ids[x], ids[y]) if i % 2 == 0 else (ids[y], ids[x])
                            jobs.append((pk, g, a, b, args.seed + 500_000 + i, args.vp_plus, args.play, args.fallback))
    print(f"{len(jobs)} games on {args.workers} workers…", flush=True)
    with Pool(args.workers, initializer=_init) as pool:
        results = pool.map(run_one, jobs, chunksize=16)

    errs = [r for r in results if r["err"]]
    if errs:
        print(f"{len(errs)} games raised errors, e.g. {errs[0]['job']}: {errs[0]['err']}")
    vs_fast: dict[tuple, list[float]] = defaultdict(list)
    rr: dict[tuple, list[float]] = defaultdict(list)  # (pack, grid, a, b) -> scores for a
    rounds: dict[tuple, list[int]] = defaultdict(list)
    for r in results:
        pk, g, a, b = r["job"][:4]
        if b == FAST:
            vs_fast[(pk, g, a)].append(r["score"])
            rounds[(pk, g)].append(r["rounds"])
        else:
            rr[(pk, g, a, b)].append(r["score"])
            rr[(pk, g, b, a)].append(1 - r["score"])

    def mean(xs: list[float]) -> float:
        return sum(xs) / len(xs) if xs else float("nan")

    ratings: dict[str, dict[str, dict[str, float]]] = {}
    if args.write_ratings and RATINGS_PATH.exists():
        ratings = json.loads(RATINGS_PATH.read_text())
        for pk in packs:  # forget builds a pack no longer has
            current = {b.id for b in pack_builds(pk)}
            ratings[pk] = {k: v for k, v in ratings.get(pk, {}).items() if k in current}
    verdicts: list[str] = []
    for pk in packs:
        pack = CARD_PACKS[pk]
        builds = list(pack_builds(pk))
        every = set(pack.shared_card_ids or []) | {c for ids in (pack.archetype_card_ids or {}).values() for c in ids}
        for g in grids:
            target = f", VP target +{args.vp_plus}" if args.vp_plus else ""
            print(f"\n== {pack.name} — {g} map{target} (≈{mean(rounds[(pk, g)]):.1f} rounds)")
            print(f"   {'build':18} {'arch':9} {'vs Fast':>7}  {'vs builds':>9}  beaten by")
            rate = {b.id: mean(vs_fast[(pk, g, b.id)]) for b in builds}
            dominant = []
            for b in sorted(builds, key=lambda b: -rate[b.id]):
                others = [o for o in builds if o.id != b.id]
                rr_rates = {o.id: mean(rr[(pk, g, b.id, o.id)]) for o in others if rr[(pk, g, b.id, o.id)]}
                rr_avg = mean(list(rr_rates.values())) if rr_rates else float("nan")
                losses = sorted((o for o in rr_rates if rr_rates[o] < 0.5), key=lambda o: rr_rates[o])
                if rr_rates and not losses:
                    dominant.append(b.name)
                mark = "✓" if rate[b.id] >= VIABLE_RATING else " "
                rr_txt = f"{rr_avg * 100:8.0f}%" if rr_rates else "        –"
                beaten = ", ".join(next(o.name for o in builds if o.id == x) for x in losses[:3]) if rr_rates else ""
                print(f" {mark} {b.name:18} {b.archetype or 'any':9} {rate[b.id] * 100:6.0f}%  {rr_txt}  {beaten}")
                if args.write_ratings:
                    ratings.setdefault(pk, {}).setdefault(b.id, {})[g] = round(rate[b.id], 3)
            for t in tiers:
                print(f"   {t[1:].capitalize() + ' CPU':18} {'':9} {mean(vs_fast[(pk, g, t)]) * 100:6.0f}%")
            viable = [b for b in builds if rate[b.id] >= VIABLE_RATING]
            arch_ok = all(any(b.archetype == a for b in viable) for a in ARCHES)
            covered = {cid for b in viable for cid, _ in b.plan}
            missing = sorted(_REG[c].name for c in every - covered)
            easy = mean(vs_fast[(pk, g, "@easy")])
            checks = [
                (len(viable) >= 3 and arch_ok,
                 f"{len(viable)} builds beat Fast Claim"
                 + ("" if arch_ok else " (missing: " + ", ".join(a for a in ARCHES if not any(b.archetype == a for b in viable)) + ")")),
                (None if not args.rr_games else not dominant,
                 "no dominant build" if not dominant else "dominant: " + ", ".join(dominant)),
                (not missing, "every card in a winning build" if not missing else "not in a winning build: " + ", ".join(missing)),
                (easy < 0.5, f"Fast Claim beats Easy ({(1 - easy) * 100:.0f}%)"),
            ]
            ok = all(c is not False for c, _ in checks)
            for c, text in checks:
                print(f"   [{'PASS' if c else 'n/a ' if c is None else 'FAIL'}] {text}")
            verdicts.append(f"{pack.name:12} {g:6} {'PASS' if ok else 'FAIL'}")
    print("\n" + "\n".join(verdicts))
    if args.write_ratings and args.vp_plus:
        print("not writing ratings: they're for the standard VP target")
    elif args.write_ratings:
        RATINGS_PATH.write_text(json.dumps(ratings, indent=1, sort_keys=True) + "\n")
        print(f"wrote {RATINGS_PATH}")


if __name__ == "__main__":
    main()
