"""Solo campaigns (data/solo_levels.yaml): check, draw, playtest.

  uv run python scripts/solo_levels.py                    # check the file, list the campaigns
  uv run python scripts/solo_levels.py map hill_country   # a level's map, features with "q,r" keys
  uv run python scripts/solo_levels.py play --games 30 [--campaign swarm] [LEVEL ...]
  uv run python scripts/solo_levels.py play --curve hill_country
  uv run python scripts/solo_levels.py play the_crown --without neutral_siege_tower
  uv run python scripts/solo_levels.py play raiders --focus
  uv run python scripts/solo_levels.py play --starters --tiers hard

`play` puts a CPU in your seat — each tier in --tiers, playing the level as
its campaign's archetype (a shared level once per campaign it's in) —
against the level's objective and bots, and reports how often it clears the
level, the round it does, how it fails, and the VP it ends on. Tune a level
so Easy usually clears the early ones and the later ones ask for Medium or
Hard play. `--curve` ignores the target and plays every game to the round
limit, printing each tier's progress on the objective (VP, tiles, VP hexes
held, bases raided, tiles taken; tiles lost for survive) at the end of each
round (the 10th / 50th / 90th percentile), and the leading rival's VP —
pick a level's numbers from it (a level with no time limit: `bot_vp` sets
how long it runs).
The CPUs play for VP and don't know the objective, so for other objectives
it's only a floor. `--without` takes cards out of the level's pool: a level
built around its spotlight cards should get much harder without them.

`--focus` gives your seat's CPU the objective in mind, roughly as a player
who read the briefing would: it buys the spotlight cards first (two of
each, then upgrades for them), plays Claims onto the objective's tiles when they can take them
(stacking on a base with Rally Cry or stackable Claims), otherwise expands
toward them, and puts permanent defense where a fortify objective needs it.
The CPU plays everything else.

`list` shows the most the starting deck alone can hold on each map (start
plus the open land joined to it: Explore takes nothing else) and whether
that could meet the objective — tests/test_solo.py fails if it could.
`--starters` checks a level can't be beaten with the starting deck: your
seat never buys a card, only upgrade credits (Explore+, Gather+ — the most
Explore and Gather alone can do), so it plays nothing but Explore and
Gather. `--starters turtle` plays only Gathers and sits tight (a hold-out
must not be won by staying small). Neither should clear anything: every
level wants some of its cards.
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor
from typing import Any, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.data_loader.loader import load_all_cards  # noqa: E402
from app.game_engine.cards import CardType  # noqa: E402
from app.game_engine.effects import EffectType  # noqa: E402
from app.game_engine.game_state import (  # noqa: E402
    GameState,
    Phase,
    advance_resolve,
    buy_card,
    end_buy_phase,
    play_card,
    spend_upgrade_credit,
    auto_play_cpu_buys,
    auto_play_cpu_plays,
    compute_player_vp,
    execute_start_of_turn,
    execute_upkeep,
)
from app.game_engine.solo import (  # noqa: E402
    SOLO_PLAYER_ID,
    objective_progress,
    SoloLevel,
    TileKind,
    create_solo_game,
    load_campaign,
    render_layout,
    starter_ceiling,
)

_registry: Optional[dict[str, Any]] = None
# --curve on a level with no time limit plays this many rounds (or --rounds).
UNTIMED_CURVE = 25


def _reg() -> dict[str, Any]:
    global _registry
    if _registry is None:
        _registry = load_all_cards()
    return _registry


def _char(kind: TileKind) -> str:
    if kind.base is not None:
        return "ABCDEF"[kind.base]
    if kind.start is not None:
        return "abcdef"[kind.start]
    if kind.blocked:
        return "#"
    if kind.vp:
        return "@" if kind.vp >= 2 else "*"
    if kind.effective_defense:
        return str(min(9, kind.effective_defense))
    return "."


def show_map(level: SoloLevel) -> None:
    print(f"{level.title} — {level.map_name} ({len(level.tiles)} tiles), as {level.archetype}\n")
    print(render_layout({c: _char(k) for c, k in level.tiles.items()}))
    print()
    for (q, r), k in sorted(level.tiles.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        bits = []
        if k.base is not None:
            bits.append("your base" if k.base == 0 else f"bot {k.base}'s base")
        if k.start is not None:
            bits.append("start" if k.start == 0 else f"bot {k.start}'s start")
        if k.blocked:
            bits.append("mountain")
        if k.vp:
            bits.append(f"{k.vp} VP")
        if k.effective_defense and not k.blocked:
            bits.append(f"defense {k.effective_defense}")
        if bits:
            print(f"  {q},{r}: {', '.join(bits)}")


# ── --focus: the objective in mind ───────────────────────────────

_DIRS = ((1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1))


def _owned_copies(player: Any, def_id: str) -> int:
    return sum(1 for c in player.deck.cards + player.deck.discard + player.hand if c.definition_id == def_id)


def _focus_buys(game: GameState, spotlight: list[str]) -> bool:
    """Buy two of each spotlight card before the CPU shops. Returns False to
    skip the CPU's shopping: saving up for a spotlight card you don't own."""
    me = game.players[SOLO_PLAYER_ID]
    for cid in spotlight:
        if _owned_copies(me, cid) >= 2:
            continue
        if game.shared_market.stacks.get(cid):
            buy_card(game, SOLO_PLAYER_ID, "shared", cid)
        else:
            card = next((c for c in me.archetype_market if c.definition_id == cid), None)
            if card is not None:
                buy_card(game, SOLO_PLAYER_ID, "archetype", card.id)
    # Still short of two copies of a card on sale to you: keep saving for it.
    on_sale = set(game.shared_market.stacks) | {c.definition_id for c in me.archetype_market}
    saving = any(
        cid in on_sale and _owned_copies(me, cid) < 2
        and (game.card_registry[cid].buy_cost or 0) > me.resources
        for cid in spotlight
    )
    # Then an upgrade credit for each spotlight card still unupgraded
    # (Proliferate+ reaches a walled town…), spent on them in the Play phase.
    # Only out of spare resources: an upgrade mustn't crowd out the next Claim.
    if not saving and me.resources >= 9 and len(_unupgraded(me, spotlight)) > me.upgrade_credits:
        buy_card(game, SOLO_PLAYER_ID, "upgrade", "")
    return not saving


def _unupgraded(me: Any, spotlight: list[str]) -> list[Any]:
    return [c for c in me.deck.cards + me.deck.discard + me.hand
            if c.definition_id in spotlight and not c.is_upgraded and c.name_upgraded]


def _focus_upgrades(game: GameState, spotlight: list[str]) -> None:
    """Spend upgrade credits on spotlight cards in hand first."""
    me = game.players[SOLO_PLAYER_ID]
    for _ in range(4):
        if me.upgrade_credits <= 0:
            return
        idx = next((i for i, c in enumerate(me.hand) if c in _unupgraded(me, spotlight)), None)
        if idx is None or not spend_upgrade_credit(game, SOLO_PLAYER_ID, idx)[0]:
            return


def _objective_tiles(game: GameState) -> list[str]:
    """Tiles the objective wants: VP hexes you don't hold, bases not yet
    raided, rivals' tiles to take."""
    assert game.grid and game.solo
    kind = game.solo["objective"]["type"]
    if kind == "capture":
        return [k for k, t in game.grid.tiles.items()
                if t.owner not in (None, SOLO_PLAYER_ID) and not t.is_base]
    if kind == "vp_hexes":
        return [k for k, t in game.grid.tiles.items() if t.is_vp and t.owner != SOLO_PLAYER_ID]
    if kind == "raid":
        raided = set(game.solo.get("raided") or [])
        return [k for k, t in game.grid.tiles.items()
                if t.is_base and t.base_owner not in raided and t.base_owner != SOLO_PLAYER_ID]
    return []


def _claims(me: Any) -> list[tuple[int, Any]]:
    return [(i, c) for i, c in enumerate(me.hand)
            if c.card_type == CardType.CLAIM and not c.defenseless_only]


def _hit(game: GameState, key: str) -> bool:
    """Play Claims onto `key` if together they can take it."""
    assert game.grid
    tile = game.grid.tiles[key]
    me = game.players[SOLO_PLAYER_ID]
    need = tile.defense_power + (1 if tile.owner else 0)
    claims = _claims(me)
    single = sorted((c.effective_power, i) for i, c in claims if c.effective_power >= need)
    if single:
        return play_card(game, SOLO_PLAYER_ID, single[0][1], tile.q, tile.r)[0]
    rally = next((i for i, c in enumerate(me.hand) if c.definition_id == "neutral_rally_cry"), None)
    stackers = [c for _, c in claims if c.stackable]
    total = sum(c.effective_power for _, c in claims) + len(stackers) * (len(claims) - 1)
    if len(claims) < 2 or total < need or (rally is None and len(stackers) < len(claims) - 1):
        return False
    if rally is not None and not play_card(game, SOLO_PLAYER_ID, rally)[0]:
        return False
    played = False
    for _ in range(len(claims)):
        # Non-stackable first: later ones must be stackable.
        order = sorted(_claims(me), key=lambda ic: (ic[1].stackable, -ic[1].effective_power))
        if not order or not play_card(game, SOLO_PLAYER_ID, order[0][0], tile.q, tile.r)[0]:
            break
        played = True
    return played


def _focus_fortify(game: GameState) -> None:
    """Permanent defense onto the tiles a fortify objective counts: the
    strongest of yours still short of the target."""
    assert game.grid and game.solo
    need = int(game.solo["objective"]["defense"])
    me = game.players[SOLO_PLAYER_ID]
    for _ in range(6):
        idx = next((i for i, c in enumerate(me.hand)
                    if any(e.type == EffectType.PERMANENT_DEFENSE for e in c.effects)), None)
        if idx is None:
            return
        mine = sorted(
            ((t.base_defense + t.permanent_defense_bonus, k) for k, t in game.grid.tiles.items()
             if t.owner == SOLO_PLAYER_ID and not t.is_base
             and t.base_defense + t.permanent_defense_bonus < need),
            reverse=True,
        )
        if not mine or not any(
            play_card(game, SOLO_PLAYER_ID, idx, game.grid.tiles[k].q, game.grid.tiles[k].r)[0]
            for _, k in mine[:3]
        ):
            return


def _focus_plays(game: GameState) -> None:
    """Claims onto the objective's tiles, else toward them; the CPU plays the rest."""
    assert game.grid and game.solo
    if game.solo["objective"]["type"] == "fortify":
        _focus_fortify(game)
    targets = _objective_tiles(game)
    if not targets:
        return
    grid = game.grid
    me = game.players[SOLO_PLAYER_ID]

    def mine_beside(q: int, r: int) -> bool:
        return any((n := grid.tiles.get(f"{q + dq},{r + dr}")) is not None and n.owner == SOLO_PLAYER_ID
                   for dq, dr in _DIRS)

    for key in targets:
        t = grid.tiles[key]
        if mine_beside(t.q, t.r):
            _hit(game, key)
        elif t.owner is None:
            # Claims that ignore adjacency (Proliferate) reach it anyway —
            # or, too weak for it, land beside it for next round's Claims.
            far = [i for i, c in enumerate(me.hand) if c.card_type == CardType.CLAIM and not c.adjacency_required]
            strong = next((i for i in far if me.hand[i].effective_power >= t.defense_power), None)
            if strong is not None:
                play_card(game, SOLO_PLAYER_ID, strong, t.q, t.r)
            elif far:
                seeds = [n for dq, dr in _DIRS
                         if (n := grid.tiles.get(f"{t.q + dq},{t.r + dr}")) is not None
                         and n.owner is None and not n.is_blocked and not n.is_base
                         and n.defense_power <= me.hand[far[0]].effective_power]
                if seeds:
                    play_card(game, SOLO_PLAYER_ID, far[0], seeds[0].q, seeds[0].r)
    goals = [grid.tiles[k] for k in _objective_tiles(game)]
    if not goals:
        return

    def to_goal(t: Any) -> int:
        return min(max(abs(t.q - g.q), abs(t.r - g.r), abs(t.q + t.r - g.q - g.r)) for g in goals)

    used: set[str] = set()
    for _ in range(12):
        moved = False
        for i, card in enumerate(me.hand):
            if card.card_type != CardType.CLAIM:
                continue
            reach = 0 if card.defenseless_only else card.effective_power

            def takes(t: Any) -> bool:
                if t.is_blocked or t.is_base or t.owner == SOLO_PLAYER_ID:
                    return False
                if t.owner is None:
                    return t.defense_power <= reach
                return not card.defenseless_only and t.defense_power < reach  # a rival's: beat it

            options = sorted(
                (to_goal(t), k) for k, t in grid.tiles.items()
                if k not in used and takes(t) and mine_beside(t.q, t.r)
            )
            for _, k in options[:4]:
                if play_card(game, SOLO_PLAYER_ID, i, grid.tiles[k].q, grid.tiles[k].r)[0]:
                    used.add(k)
                    moved = True
                    break
            if moved:
                break
        if not moved:
            return


def _without(level: SoloLevel, cards: list[str]) -> SoloLevel:
    if cards:
        level.pack_id = None
        level.shared_card_ids = [c for c in level.shared_card_ids if c not in cards]
        level.archetype_card_ids = {a: [c for c in ids if c not in cards] for a, ids in level.archetype_card_ids.items()}
    return level


def _starter_buys(game: GameState) -> None:
    """Your seat buys only upgrade credits (for its Explores and Gathers)."""
    for _ in range(10):
        if not buy_card(game, SOLO_PLAYER_ID, "upgrade", "")[0]:
            break
    end_buy_phase(game, SOLO_PLAYER_ID)


def _turtle(game: GameState) -> None:
    """Your seat sits tight: its Explores go unplayed."""
    me = game.players[SOLO_PLAYER_ID]
    explores = [c for c in me.hand if c.card_type == CardType.CLAIM]
    me.hand = [c for c in me.hand if c.card_type != CardType.CLAIM]
    me.deck.add_to_discard(explores)


def _play_one(args: tuple[str, str, str, int, bool, list[str], bool, int, str]) -> dict[str, Any]:
    archetype, level_id, tier, seed, curve, without, focus, rounds, starters = args
    level = load_campaign(_reg()).level(archetype, level_id)
    assert level is not None
    level = _without(level, without)
    if rounds:
        level.objective = dataclasses.replace(level.objective, rounds=rounds)
    game = create_solo_game(level, _reg(), seed=seed)
    me = game.players[SOLO_PLAYER_ID]
    me.is_cpu = True
    me.cpu_difficulty = tier
    obj = game.solo["objective"]
    if curve:
        # Nobody reaches these: play to the round limit.
        for key in ("vp", "tiles", "count", "bot_vp", "raids_allowed", "tiles_lost_max"):
            if obj.get(key) is not None:
                obj[key] = 999

    def measure() -> int:
        return _lost(game) if obj["type"] == "survive" else int(objective_progress(game)["value"])

    by_round: list[int] = []
    bot_by_round: list[int] = []

    def bot_vp() -> int:
        return max((compute_player_vp(game, p) for p in game.player_order if p != SOLO_PLAYER_ID), default=0)

    execute_start_of_turn(game)
    for _ in range(400):
        if game.current_phase == Phase.GAME_OVER:
            by_round.append(measure())
            bot_by_round.append(bot_vp())
            break
        if game.current_phase == Phase.UPKEEP:
            if game.current_round > 1:
                by_round.append(measure())
                bot_by_round.append(bot_vp())
            execute_upkeep(game)
        elif game.current_phase == Phase.PLAY:
            if focus:
                _focus_upgrades(game, level.spotlight)
                _focus_plays(game)
            if starters == "turtle" and not game.players[SOLO_PLAYER_ID].has_submitted_play:
                _turtle(game)
            auto_play_cpu_plays(game)
        elif game.current_phase == Phase.REVEAL:
            for pid in game.player_order:
                if not game.players[pid].has_acknowledged_resolve:
                    advance_resolve(game, pid)
        elif game.current_phase == Phase.BUY:
            if starters:
                _starter_buys(game)
            elif focus and not _focus_buys(game, level.spotlight):
                end_buy_phase(game, SOLO_PLAYER_ID)  # saving up
            auto_play_cpu_buys(game)
        else:
            break
    if curve:
        # A game that met its goal early holds that progress to the limit.
        by_round += by_round[-1:] * ((level.objective.rounds or UNTIMED_CURVE) - len(by_round))
        bot_by_round += bot_by_round[-1:] * ((level.objective.rounds or UNTIMED_CURVE) - len(bot_by_round))
    solo = game.solo or {}
    return {
        "campaign": archetype, "level": level_id, "tier": tier,
        "result": solo.get("result"), "round": solo.get("round", game.current_round),
        "reason": solo.get("reason") or "",
        "vp": compute_player_vp(game, SOLO_PLAYER_ID),
        "bot_vp": max((compute_player_vp(game, p) for p in game.player_order if p != SOLO_PLAYER_ID), default=0),
        "by_round": by_round,
        "bot_by_round": bot_by_round,
        "progress": objective_progress(game)["value"],
        "lost": _lost(game),
    }


def _lost(game: GameState) -> int:
    solo = game.solo or {}
    return int(solo.get("tiles_lost") or 0)


def _how_lost(reason: str) -> str:
    if reason.startswith("Your base was raided"):
        return "raided"
    if "tiles —" in reason:
        return "overrun"
    if "first" in reason:
        return "bot won"
    return "time"


def play(levels: list[SoloLevel], tiers: list[str], games: int, workers: int,
         curve: bool = False, without: Optional[list[str]] = None, focus: bool = False,
         rounds: int = 0, starters: str = "") -> None:
    jobs = [
        (lv.archetype, lv.id, tier, seed, curve, without or [], focus, rounds, starters)
        for lv in levels for tier in tiers for seed in range(games)
    ]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(_play_one, jobs, chunksize=4))
    for lv in levels:
        mine = [r for r in results if r["level"] == lv.id and r["campaign"] == lv.archetype]
        obj = lv.objective
        bots = f"  [vs {', '.join(f'{b.difficulty} {b.archetype}' for b in lv.bots)}]" if lv.bots else ""
        if curve:
            unit = {"vp": "VP", "territory": "tiles", "vp_hexes": "VP hexes held", "raid": "bases raided",
                    "capture": "tiles taken", "fortify": "fortified tiles", "survive": "tiles lost"}[obj.type]
            print(f"\n{lv.archetype} · {lv.title}: your {unit} at the end of each round "
                  f"(10th / 50th / 90th percentile){bots}")
            cols = [(t, "by_round") for t in tiers] + ([(t, "bot_by_round") for t in tiers] if lv.bots else [])
            print("  round  " + "  ".join(f"{(t if k == 'by_round' else 'rival ' + t):>12}" for t, k in cols))
            for rnd in range(1, (rounds or obj.rounds or UNTIMED_CURVE) + 1):
                cells = []
                for tier, key in cols:
                    vals = sorted(r[key][rnd - 1] for r in mine if r["tier"] == tier and len(r[key]) >= rnd)
                    if not vals:
                        cells.append(f"{'-':>12}")
                        continue
                    pick = lambda f: vals[min(len(vals) - 1, int(f * len(vals)))]  # noqa: E731
                    cells.append(f"{pick(0.1):>4}/{pick(0.5):>3}/{pick(0.9):>3}")
                print(f"  {rnd:>5}  " + "  ".join(cells))
            continue
        print(f"\n{lv.archetype} · {lv.title}: {obj.describe(bool(lv.bots))}{bots}")
        for tier in tiers:
            rs = [r for r in mine if r["tier"] == tier]
            wins = [r for r in rs if r["result"] == "won"]
            line = f"  {tier:6} cleared {100 * len(wins) / max(1, len(rs)):5.1f}%"
            line += f"  in round {statistics.mean(r['round'] for r in wins):4.1f}" if wins else " " * 15
            line += f"  VP {statistics.mean(r['vp'] for r in rs):4.1f}"
            if obj.type not in ("vp", "survive"):
                line += f"  {obj.type} {statistics.mean(r['progress'] for r in rs):4.1f}"
            if obj.type == "survive":
                line += f"  tiles lost {statistics.mean(r['lost'] for r in rs):4.1f}"
            if lv.bots:
                line += f"  bot VP {statistics.mean(r['bot_vp'] for r in rs):4.1f}"
            fails: dict[str, int] = {}
            for r in rs:
                if r["result"] != "won":
                    fails[_how_lost(r["reason"])] = fails.get(_how_lost(r["reason"]), 0) + 1
            if fails:
                line += "  lost: " + ", ".join(f"{k} {v}" for k, v in sorted(fails.items()))
            print(line)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", default="list", choices=["list", "map", "play"])
    ap.add_argument("levels", nargs="*", help="level ids (default: all)")
    ap.add_argument("--campaign", default="", help="only these campaigns (comma-separated archetypes)")
    ap.add_argument("--games", type=int, default=20, help="games per tier")
    ap.add_argument("--tiers", default="easy,medium,hard")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--curve", action="store_true", help="progress by round, ignoring the target")
    ap.add_argument("--without", default="", help="card ids to take out of the pool (comma-separated)")
    ap.add_argument("--focus", action="store_true", help="your seat plays toward the objective")
    ap.add_argument("--rounds", type=int, default=0, help="play this many rounds instead of the level's")
    ap.add_argument("--starters", nargs="?", const="explore", default="", choices=["explore", "turtle"],
                    help="your seat buys only upgrade credits: Explore and Gather alone (turtle: Gathers only)")
    args = ap.parse_args()

    campaign = load_campaign(_reg())
    only = [c.strip() for c in args.campaign.split(",") if c.strip()]
    levels = [
        lv for arch, camp in campaign.campaigns.items() if not only or arch in only
        for lv in camp.levels if not args.levels or lv.id in args.levels
    ]
    known = {lv.id for camp in campaign.campaigns.values() for lv in camp.levels}
    missing = [lid for lid in args.levels if lid not in known]
    if missing:
        sys.exit(f"unknown level(s) {missing}; have: {', '.join(sorted(known))}")

    if args.command == "list":
        for arch, camp in campaign.campaigns.items():
            print(f"{camp.title} ({arch}) — {camp.blurb}")
            for i, lv in enumerate(camp.levels):
                bots = ", ".join(f"{b.difficulty} {b.archetype}" for b in lv.bots) or "no bots"
                shared = f"; shared with {', '.join(lv.shared_with)}" if lv.shared_with else ""
                print(f"  {i + 1}. {lv.id:15} {lv.title}: {lv.objective.describe(bool(lv.bots))}  "
                      f"[{lv.map_name}, {len(lv.tiles)} tiles; {lv.pack_id or 'custom cards'}; {bots}{shared}]")
                ceiling = starter_ceiling(lv, _reg())
                verdict = {True: "CAN MEET IT", False: "short of it", None: "check with play --starters"}
                print(f"     {'':15} starters alone: at most {ceiling.tiles} tiles, {ceiling.vp} VP, "
                      f"{ceiling.vp_hexes} VP hexes — {verdict[ceiling.could_meet(lv.objective)]}")
            print()
    elif args.command == "map":
        for lv in levels:
            show_map(lv)
    else:
        without = [c.strip() for c in args.without.split(",") if c.strip()]
        play(levels, [t.strip() for t in args.tiers.split(",") if t.strip()], args.games, args.workers,
             args.curve, without, args.focus, args.rounds, args.starters)


if __name__ == "__main__":
    main()
