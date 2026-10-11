#!/usr/bin/env python3
"""Card pack balance harness: Hard CPUs play many games inside each pack.

Reports per pack and table size: archetype win rates (and the 2-player
matchups), first-seat win rate, game length, and with --detail per card: buy
rate, copies, plays, and the win-rate delta of players who bought it vs.
players of that archetype who didn't.

  uv run python scripts/pack_balance.py --games 400 --tables 2:small,3:medium,4:medium
  uv run python scripts/pack_balance.py --packs deep_roots --detail

Paired card tests (same seeds with and without the card):
  --inject             every pack card in turn starts in one player's deck
  --force              that player is made to buy the card first
                       (TUNE_FORCE_ROUND=5 holds the forced buy until round 5)
  --cards a,b          limit the paired tests to these card ids

Try changes without editing data (environment variables):
  TUNE_SWAPS="pack:arch:old=new;..."   swap a pack card (arch "shared" for the shared market)
  TUNE_SET="card:field=value;..."      set an integer field on a loaded card (power, buy_cost, …)

Targets used for the shipped packs: archetype win rates 40–60% at 2 players,
23–43% at 3, 15–35% at 4.
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import os
import random
import sys
from collections import Counter, defaultdict
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHES = ["vanguard", "swarm", "fortress"]
_REG: dict[str, Any] = {}


def _init() -> None:
    import logging
    logging.disable(logging.WARNING)
    from app.data_loader.loader import load_all_cards
    global _REG
    _REG = load_all_cards()
    # TUNE_SWAPS="pack:arch:old=new;..." (arch "shared" for the shared market)
    from app.game_engine.card_packs import CARD_PACKS
    for sw in filter(None, os.environ.get("TUNE_SWAPS", "").split(";")):
        pack, arch, pair = sw.split(":")
        old_id, new_id = pair.split("=")
        ids = CARD_PACKS[pack].shared_card_ids if arch == "shared" else CARD_PACKS[pack].archetype_card_ids[arch]
        ids[ids.index(old_id)] = new_id
    # TUNE_SET="card:field=value;..." edits loaded cards (power, buy_cost, …)
    for st in filter(None, os.environ.get("TUNE_SET", "").split(";")):
        cid, kv = st.split(":")
        k, v = kv.split("=")
        setattr(_REG[cid], k, int(v))


def _forced_buyer(base):  # type: ignore[no-untyped-def]
    class Forced(base):  # type: ignore[misc, valid-type]
        force_id = ""

        def pick_next_purchase(self, game):  # type: ignore[no-untyped-def]
            from app.game_engine.game_state import calculate_dynamic_buy_cost
            p = game.players[self.player_id]
            owned = sum(1 for c in p.deck.cards + p.deck.discard + p.hand
                        if c.definition_id == self.force_id)
            bought_now = any(x.get("definition_id") == self.force_id
                             for x in game.buy_phase_purchases.get(self.player_id, []))
            from_round = int(os.environ.get("TUNE_FORCE_ROUND", "1"))
            if owned == 0 and not bought_now and not p.turn_modifiers.buy_locked and game.current_round >= from_round:
                for c in p.archetype_market:
                    if c.definition_id == self.force_id and calculate_dynamic_buy_cost(game, p, c) <= p.resources:
                        return {"source": "archetype", "card_id": c.id, "definition_id": c.definition_id}
                stack = game.shared_market.stacks.get(self.force_id)
                if stack and calculate_dynamic_buy_cost(game, p, stack[0]) <= p.resources:
                    return {"source": "shared", "card_id": self.force_id, "definition_id": self.force_id}
            return super().pick_next_purchase(game)
    return Forced


def run_one(job: tuple) -> dict[str, Any]:
    pack, players, grid, seed, max_rounds, difficulty = job[:6]
    inject, p0_arch = (job[6], job[7]) if len(job) > 6 else (None, None)
    force = job[8] if len(job) > 8 else None  # p0 buys this card once, first chance
    from app.game_engine.cpu_player import CPUPlayer
    from app.game_engine.game_state import (
        Phase, advance_resolve, compute_player_vp, create_game, execute_start_of_turn, execute_upkeep,
    )
    from app.game_engine.hex_grid import GridSize
    from app.game_engine.simulation import PlayerResult, _run_buy_phase, _run_play_phase

    rng = random.Random(seed)
    archs = [rng.choice(ARCHES) for _ in range(players)]
    if p0_arch:
        archs[0] = p0_arch
    cfg = [{"id": f"p{i}", "name": f"P{i}", "archetype": a} for i, a in enumerate(archs)]
    game = create_game(GridSize(grid), cfg, _REG, seed=seed, card_pack=pack, max_rounds=max_rounds)
    cpus = {pid: CPUPlayer(pid, difficulty=difficulty, rng=game.rng) for pid in game.player_order}
    if force:
        cpus["p0"] = _forced_buyer(CPUPlayer)("p0", difficulty=difficulty, rng=game.rng)
        cpus["p0"].force_id = force
    tracking = {pid: PlayerResult(player_id=pid, name=pid, archetype=game.players[pid].archetype.value)
                for pid in game.player_order}
    first = game.player_order[game.first_player_index]
    if inject:
        from app.game_engine.cards import _copy_card
        p0 = game.players["p0"]
        p0.deck.cards.append(_copy_card(_REG[inject], "inj"))
        random.Random(seed * 7 + 1).shuffle(p0.deck.cards)
    execute_start_of_turn(game)
    err = None
    try:
        while game.current_phase != Phase.GAME_OVER and game.current_round <= max_rounds + 3:
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
    except Exception as e:  # noqa: BLE001
        import traceback
        err = traceback.format_exc()[-600:]
    bought: dict[str, Counter] = defaultdict(Counter)
    played: dict[str, Counter] = defaultdict(Counter)
    for e in game.game_log:
        d = e.data or {}
        if e.event_type == "card_purchased" and e.actor:
            bought[e.actor][d.get("definition_id") or d.get("card_id")] += 1
        elif e.event_type == "card_played" and e.actor:
            played[e.actor][d.get("definition_id")] += 1
    shared_left = {k: len(v) for k, v in game.shared_market.stacks.items()}
    return {
        "pack": pack, "players": players, "grid": grid, "err": err, "inject": inject, "seed": seed,
        "archs": {pid: game.players[pid].archetype.value for pid in game.player_order},
        "winners": list(game.winners or ([game.winner] if game.winner else [])),
        "first": first, "rounds": game.current_round,
        "vp": {pid: compute_player_vp(game, pid) for pid in game.player_order},
        "bought": {k: dict(v) for k, v in bought.items()},
        "played": {k: dict(v) for k, v in played.items()},
        "shared_left": shared_left,
        "upgrades": {pid: game.players[pid].upgrade_credits for pid in game.player_order},
    }


def report(pack: str, players: int, grid: str, res: list[dict[str, Any]], card_names: dict[str, str],
           detail: bool) -> dict[str, Any]:
    from app.game_engine.card_packs import CARD_PACKS
    errs = [r for r in res if r["err"]]
    res = [r for r in res if not r["err"]]
    n = len(res)
    wins = Counter(); seats = Counter(); first_w = 0.0; rounds = 0
    for r in res:
        share = 1.0 / len(r["winners"]) if r["winners"] else 0
        for pid, a in r["archs"].items():
            seats[a] += 1
            if pid in r["winners"]:
                wins[a] += share
        if r["first"] in r["winners"]:
            first_w += share
        rounds += r["rounds"]
    par = 1.0 / players
    arch_wr = {a: wins[a] / seats[a] if seats[a] else 0 for a in ARCHES}
    line = (f"{pack:<12} {players}p {grid:<6} n={n:4d} rounds {rounds / max(n, 1):4.1f}  "
            f"first-seat {first_w / max(n, 1):.0%} (par {par:.0%})  "
            + "  ".join(f"{a[:3]} {arch_wr[a]:.0%}" for a in ARCHES)
            + (f"  ERRORS={len(errs)}" if errs else ""))
    if players == 2:
        mu: dict[tuple[str, str], list[float]] = defaultdict(lambda: [0.0, 0])
        for r in res:
            (pa, aa), (pb, ab) = list(r["archs"].items())
            if aa == ab:
                continue
            share = 1.0 / len(r["winners"]) if r["winners"] else 0
            for me, mine, them in ((pa, aa, ab), (pb, ab, aa)):
                rec = mu[(mine, them)]
                rec[0] += share if me in r["winners"] else 0
                rec[1] += 1
        line += "   | " + "  ".join(
            f"{x[:1].upper()}>{y[:1].upper()} {mu[(x, y)][0] / mu[(x, y)][1]:.0%}"
            for x, y in (("vanguard", "swarm"), ("vanguard", "fortress"), ("swarm", "fortress"))
            if mu[(x, y)][1])
    print(line)
    if errs:
        print(errs[0]["err"])
    out = {"arch_wr": arch_wr, "rounds": rounds / max(n, 1)}
    if not detail:
        return out
    p = CARD_PACKS[pack]
    rows = []
    groups = [("shared", p.shared_card_ids or [], None)] + [
        (a, (p.archetype_card_ids or {}).get(a, []), a) for a in ARCHES]
    for label, ids, arch in groups:
        for cid in ids:
            buyers = nonbuyers = bw = nw = 0.0
            copies = plays = 0
            for r in res:
                share = 1.0 / len(r["winners"]) if r["winners"] else 0
                for pid, a in r["archs"].items():
                    if arch and a != arch:
                        continue
                    got = r["bought"].get(pid, {}).get(cid, 0)
                    won = share if pid in r["winners"] else 0
                    if got:
                        buyers += 1; bw += won; copies += got
                        plays += r["played"].get(pid, {}).get(cid, 0)
                    else:
                        nonbuyers += 1; nw += won
            elig = buyers + nonbuyers
            rate = buyers / elig if elig else 0
            delta = (bw / buyers if buyers else 0) - (nw / nonbuyers if nonbuyers else 0)
            rows.append((label, card_names.get(cid, cid), rate, copies / buyers if buyers else 0,
                         plays / buyers if buyers else 0,
                         delta if buyers >= 15 and nonbuyers >= 15 else float("nan")))
    print(f"    {'':8} {'card':<20} {'buy%':>5} {'copies':>6} {'plays':>6} {'Δwin':>6}")
    for label, name, rate, cp, pl, d in rows:
        ds = "   n/a" if d != d else f"{d:+6.0%}"
        print(f"    {label:<8} {name:<20} {rate:5.0%} {cp:6.1f} {pl:6.1f} {ds}")
    ex = Counter(); tot = 0
    for r in res:
        for k, left in r["shared_left"].items():
            ex[k] += left == 0
        tot += 1
    print("    shared piles emptied: " + ", ".join(
        f"{card_names.get(k, k)} {v / tot:.0%}" for k, v in ex.items() if v))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--packs", default="first_clash,border_war,deep_roots,far_reaches")
    ap.add_argument("--tables", default="2:small,3:medium")
    ap.add_argument("--games", type=int, default=300)
    ap.add_argument("--seed", type=int, default=5000)
    ap.add_argument("--max-rounds", type=int, default=20)
    ap.add_argument("--difficulty", default="hard")
    ap.add_argument("--detail", action="store_true")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--inject", action="store_true", help="paired free-copy test for every pack card")
    ap.add_argument("--force", action="store_true", help="paired forced-first-buy test (with --inject's card list)")
    ap.add_argument("--cards", default="", help="limit --inject to these card ids")
    a = ap.parse_args()
    if a.inject:
        return inject_main(a)
    jobs = []
    for pack in a.packs.split(","):
        for t in a.tables.split(","):
            pl, grid = t.split(":")
            for i in range(a.games):
                jobs.append((pack, int(pl), grid, a.seed + i, a.max_rounds, a.difficulty))
    with mp.Pool(a.workers, initializer=_init) as pool:
        results = pool.map(run_one, jobs, chunksize=4)
    _init()
    names = {cid: c.name for cid, c in _REG.items()}
    by: dict[tuple, list] = defaultdict(list)
    for r in results:
        by[(r["pack"], r["players"], r["grid"])].append(r)
    for (pack, pl, grid), res in by.items():
        report(pack, pl, grid, res, names, a.detail)


def inject_main(a: argparse.Namespace) -> None:
    """For each card: p0 (of the card's archetype; any for shared cards) starts
    with a free copy. Compare p0's win rate with the same seeds without it."""
    _init()
    from app.game_engine.card_packs import CARD_PACKS
    pl, grid = a.tables.split(",")[0].split(":")
    pl = int(pl)
    cards: dict[str, tuple[str, str]] = {}  # card -> (pack, archetype or "")
    for pack in a.packs.split(","):
        pk = CARD_PACKS[pack]
        for cid in pk.shared_card_ids or []:
            cards.setdefault(cid, (pack, ""))
        for arch, ids in (pk.archetype_card_ids or {}).items():
            for cid in ids:
                cards.setdefault(cid, (pack, arch))
    if a.cards:
        keep = set(a.cards.split(","))
        cards = {k: v for k, v in cards.items() if k in keep}
    jobs = []
    for cid, (pack, arch) in cards.items():
        for i in range(a.games):
            seed = a.seed + i
            p0a = arch or ARCHES[i % 3]
            jobs.append((pack, pl, grid, seed, a.max_rounds, a.difficulty, None, p0a))
            if a.force:
                jobs.append((pack, pl, grid, seed, a.max_rounds, a.difficulty, None, p0a, cid))
            else:
                jobs.append((pack, pl, grid, seed, a.max_rounds, a.difficulty, cid, p0a))
    # Baselines repeat across cards of a pack/archetype: dedupe them.
    uniq = list(dict.fromkeys(jobs))
    with mp.Pool(a.workers, initializer=_init) as pool:
        out = pool.map(run_one, uniq, chunksize=4)
    res = dict(zip(uniq, out))
    names = {cid: c.name for cid, c in _REG.items()}
    rows = []
    for cid, (pack, arch) in cards.items():
        base = inj = 0.0
        n = 0
        for i in range(a.games):
            seed = a.seed + i
            p0a = arch or ARCHES[i % 3]
            b = res[(pack, pl, grid, seed, a.max_rounds, a.difficulty, None, p0a)]
            j = res[(pack, pl, grid, seed, a.max_rounds, a.difficulty, None, p0a, cid)] if a.force \
                else res[(pack, pl, grid, seed, a.max_rounds, a.difficulty, cid, p0a)]
            if b["err"] or j["err"]:
                continue
            n += 1
            base += (1 / len(b["winners"])) if "p0" in b["winners"] else 0
            inj += (1 / len(j["winners"])) if "p0" in j["winners"] else 0
        cost = _REG[cid].buy_cost
        rows.append((pack, arch or "shared", names[cid], cost, (inj - base) / max(n, 1), n))
    rows.sort(key=lambda r: (r[0], r[1], -r[4]))
    mode = "forced first buy" if a.force else "free copy at start"
    print(f"{'pack':<12} {'arch':<8} {'card':<20} {'cost':>4} {'Δwin':>6}  ({mode}, {pl}p {grid}, n per card)")
    for pack, arch, name, cost, d, n in rows:
        print(f"{pack:<12} {arch:<8} {name:<20} {cost:>4} {d:+6.1%}  n={n}")


if __name__ == "__main__":
    main()
