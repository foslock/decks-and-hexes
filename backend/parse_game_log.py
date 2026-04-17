"""Offline analyzer for Card Clash structured game logs.

Loads a JSON file as emitted by GET /api/games/{game_id}/log (or the
in-app Download button) and surfaces summary statistics useful for
inspecting CPU behavior and spotting improvement opportunities.

Usage:
    uv run python parse_game_log.py path/to/log.json
    uv run python parse_game_log.py path/to/log.json --player cpu_0
    uv run python parse_game_log.py path/to/log.json --events card_played

The script prints human-readable summaries. For programmatic use, the
``load_log`` / ``iter_events`` helpers are safe to import.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


@dataclass
class ParsedLog:
    meta: dict[str, Any]
    entries: list[dict[str, Any]]

    @property
    def players(self) -> dict[str, dict[str, Any]]:
        return self.meta.get("players", {})

    def player_name(self, pid: str | None) -> str:
        if not pid:
            return "<none>"
        return self.players.get(pid, {}).get("name", pid)


def load_log(path: str | Path) -> ParsedLog:
    with open(path, "r") as f:
        blob = json.load(f)
    entries = blob.pop("entries", [])
    return ParsedLog(meta=blob, entries=entries)


def iter_events(
    log: ParsedLog,
    *,
    event_types: Iterable[str] | None = None,
    actor: str | None = None,
) -> list[dict[str, Any]]:
    wanted = set(event_types) if event_types else None
    out: list[dict[str, Any]] = []
    for e in log.entries:
        if wanted and e.get("event_type") not in wanted:
            continue
        if actor and e.get("actor") != actor:
            continue
        out.append(e)
    return out


def summarize_header(log: ParsedLog) -> None:
    meta = log.meta
    print(f"Game {meta.get('game_id')}")
    print(f"  phase={meta.get('phase')}  round={meta.get('round')}  "
          f"max_rounds={meta.get('max_rounds')}  vp_target={meta.get('vp_target')}")
    print(f"  grid={meta.get('grid_size')}  pack={meta.get('card_pack')}  "
          f"seed={meta.get('map_seed')!r}")
    winners = meta.get("winners") or []
    winner_names = ", ".join(log.player_name(w) for w in winners) or "none"
    print(f"  winner(s): {winner_names}")
    print()
    print("Players:")
    for pid in meta.get("player_order", []):
        p = log.players.get(pid, {})
        cpu_suffix = ""
        if p.get("is_cpu"):
            cpu_suffix = f"  [CPU/{p.get('cpu_difficulty')}]"
        tiles = p.get("tiles_owned", "-")
        vp_tiles = p.get("vp_tiles_owned", "-")
        res = p.get("resources", "-")
        print(f"  {pid:<12}  {p.get('name'):<16} {p.get('archetype')}"
              f"  VP={p.get('final_vp')}  tiles={tiles} (vp={vp_tiles})"
              f"  res={res}{cpu_suffix}")
    print()

    grid = meta.get("grid_state") or {}
    if grid:
        print(
            f"Grid: size={grid.get('size')}  tiles={grid.get('tile_count')}"
            f"  vp_tiles={grid.get('vp_tile_count')}"
            f"  blocked={grid.get('blocked_tile_count')}"
        )
        owner_counts: Counter[str] = Counter()
        vp_owner_counts: Counter[str] = Counter()
        for t in grid.get("tiles", []):
            owner = t.get("owner")
            if owner:
                owner_counts[owner] += 1
                if t.get("is_vp"):
                    vp_owner_counts[owner] += 1
        print("  tiles by owner:")
        for pid in log.meta.get("player_order", []):
            print(
                f"    {log.player_name(pid):<16} "
                f"{owner_counts.get(pid, 0):>3} tiles  "
                f"({vp_owner_counts.get(pid, 0)} VP)"
            )
        unclaimed = grid.get("tile_count", 0) - sum(owner_counts.values())
        if unclaimed:
            print(f"    <unclaimed>        {unclaimed:>3}")
        print()


def summarize_event_counts(log: ParsedLog) -> None:
    counter: Counter[str] = Counter()
    for e in log.entries:
        counter[e.get("event_type", "info")] += 1
    print("Event counts:")
    for ev, n in counter.most_common():
        print(f"  {ev:<20} {n}")
    print()


def summarize_per_player(log: ParsedLog) -> None:
    cards_played: dict[str, Counter[str]] = defaultdict(Counter)
    purchases: dict[str, Counter[str]] = defaultdict(Counter)
    for e in log.entries:
        actor = e.get("actor")
        if not actor:
            continue
        et = e.get("event_type")
        data = e.get("data") or {}
        if et == "card_played":
            cards_played[actor][data.get("card_name", "?")] += 1
        elif et == "card_purchased":
            purchases[actor][data.get("card_name", data.get("source", "?"))] += 1

    for pid in log.meta.get("player_order", []):
        pname = log.player_name(pid)
        print(f"── {pname} ({pid}) ──")
        total_plays = sum(cards_played[pid].values())
        total_buys = sum(purchases[pid].values())
        print(f"  plays: {total_plays}   purchases: {total_buys}")
        if cards_played[pid]:
            print("  top plays:")
            for name, n in cards_played[pid].most_common(6):
                print(f"    {n:>3}  {name}")
        if purchases[pid]:
            print("  purchases:")
            for name, n in purchases[pid].most_common(6):
                print(f"    {n:>3}  {name}")
        print()


def summarize_round_progress(log: ParsedLog) -> None:
    rounds = [
        e for e in log.entries if e.get("event_type") == "round_started"
    ]
    if not rounds:
        return
    print("Round VP trajectory:")
    print(f"  {'round':>5}  " + "  ".join(
        f"{log.player_name(pid):>12}" for pid in log.meta.get("player_order", [])
    ))
    for e in rounds:
        data = e.get("data") or {}
        standings = data.get("vp_standings", {})
        row = f"  {data.get('round'):>5}  "
        row += "  ".join(
            f"{standings.get(pid, 0):>12}"
            for pid in log.meta.get("player_order", [])
        )
        print(row)
    print()


def print_events_filtered(
    log: ParsedLog,
    event_types: list[str] | None,
    actor: str | None,
    limit: int,
) -> None:
    evs = iter_events(log, event_types=event_types, actor=actor)
    if limit > 0:
        evs = evs[:limit]
    for e in evs:
        r = e.get("round")
        ph = e.get("phase", "")
        et = e.get("event_type", "info")
        who = log.player_name(e.get("actor"))
        print(f"[r{r} {ph} {et}] {who}: {e.get('message')}")
        data = e.get("data") or {}
        if data:
            for k, v in data.items():
                print(f"    {k} = {v}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", help="Path to the JSON game log")
    ap.add_argument("--events", "-e", help="Comma-separated event_types to show",
                    default=None)
    ap.add_argument("--player", "-p", help="Filter to actor=player_id", default=None)
    ap.add_argument("--limit", "-n", type=int, default=50,
                    help="Max events to print in --events mode (0 = unlimited)")
    ap.add_argument("--no-summary", action="store_true",
                    help="Skip the header / summary blocks (only print filtered events)")
    args = ap.parse_args()

    log = load_log(args.path)

    if not args.no_summary:
        summarize_header(log)
        summarize_event_counts(log)
        summarize_per_player(log)
        summarize_round_progress(log)

    if args.events or args.player:
        event_types = [s.strip() for s in args.events.split(",")] if args.events else None
        print("── Filtered events ──")
        print_events_filtered(log, event_types, args.player, args.limit)

    return 0


if __name__ == "__main__":
    sys.exit(main())
