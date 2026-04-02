"""Balance report generator for Monte Carlo simulation results.

Aggregates game results into actionable balance metrics:
1. Win rates by archetype
2. Win rates by passive
3. Card purchase frequency & win correlation
4. Game length, VP curves & action economy
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Optional

from .simulation import BatchResult, GameResult, PlayerResult


# ── Report data structures ────────────────────────────────────────

@dataclass
class ArchetypeStats:
    archetype: str
    wins: int = 0
    games: int = 0
    total_vp: int = 0
    total_tiles: int = 0
    total_vp_hexes: int = 0
    total_rounds_when_won: int = 0

    @property
    def win_rate(self) -> float:
        return self.wins / self.games if self.games > 0 else 0.0

    @property
    def avg_vp(self) -> float:
        return self.total_vp / self.games if self.games > 0 else 0.0

    @property
    def avg_tiles(self) -> float:
        return self.total_tiles / self.games if self.games > 0 else 0.0

    @property
    def avg_rounds_to_win(self) -> float:
        return self.total_rounds_when_won / self.wins if self.wins > 0 else 0.0


@dataclass
class PassiveStats:
    passive_name: str
    wins: int = 0
    games: int = 0

    @property
    def win_rate(self) -> float:
        return self.wins / self.games if self.games > 0 else 0.0


@dataclass
class CardStats:
    card_name: str
    times_purchased: int = 0
    games_purchased_in: int = 0
    total_games: int = 0
    wins_when_purchased: int = 0
    games_when_purchased: int = 0

    @property
    def purchase_rate(self) -> float:
        return self.games_purchased_in / self.total_games if self.total_games > 0 else 0.0

    @property
    def win_rate_when_purchased(self) -> float:
        return self.wins_when_purchased / self.games_when_purchased if self.games_when_purchased > 0 else 0.0

    @property
    def avg_copies_per_game(self) -> float:
        return self.times_purchased / self.total_games if self.total_games > 0 else 0.0


@dataclass
class ActionEconomyStats:
    archetype: str
    all_actions: list[int] = field(default_factory=list)

    @property
    def mean(self) -> float:
        return sum(self.all_actions) / len(self.all_actions) if self.all_actions else 0.0

    @property
    def median(self) -> float:
        if not self.all_actions:
            return 0.0
        s = sorted(self.all_actions)
        n = len(s)
        if n % 2 == 0:
            return (s[n // 2 - 1] + s[n // 2]) / 2
        return float(s[n // 2])

    @property
    def max_actions(self) -> int:
        return max(self.all_actions) if self.all_actions else 0

    @property
    def p95(self) -> int:
        """95th percentile of actions per turn."""
        if not self.all_actions:
            return 0
        s = sorted(self.all_actions)
        idx = int(math.ceil(0.95 * len(s))) - 1
        return s[max(0, idx)]

    def histogram(self, max_bins: int = 10) -> dict[str, int]:
        """Simple histogram of action counts."""
        if not self.all_actions:
            return {}
        counts: dict[int, int] = defaultdict(int)
        for a in self.all_actions:
            counts[a] += 1
        return {str(k): v for k, v in sorted(counts.items())}


# ── Report generation ─────────────────────────────────────────────

def generate_report(batch: BatchResult) -> dict[str, Any]:
    """Generate a complete balance report from batch results."""
    report: dict[str, Any] = {}

    valid_results = [r for r in batch.results if r.error is None]
    total_games = len(valid_results)

    report["summary"] = {
        "total_games": total_games,
        "timed_out": sum(1 for r in valid_results if r.timed_out),
        "errored": sum(1 for r in batch.results if r.error),
        "grid_size": batch.config.grid_size.value,
        "player_archetypes": [a.value for a in batch.config.player_archetypes],
        "cpu_noise": batch.config.cpu_noise,
        "total_duration_ms": batch.total_duration_ms,
    }

    report["archetype_win_rates"] = _archetype_win_rates(valid_results)
    report["passive_win_rates"] = _passive_win_rates(valid_results)
    report["card_purchase_stats"] = _card_purchase_stats(valid_results)
    report["game_length_stats"] = _game_length_stats(valid_results)
    report["action_economy"] = _action_economy_stats(valid_results)
    report["vp_curves"] = _vp_curves(valid_results)
    report["snowball_indicator"] = _snowball_indicator(valid_results)

    return report


def _archetype_win_rates(results: list[GameResult]) -> dict[str, Any]:
    """Compute win rates per archetype."""
    stats: dict[str, ArchetypeStats] = {}

    for game in results:
        for pr in game.player_results:
            if pr.archetype not in stats:
                stats[pr.archetype] = ArchetypeStats(archetype=pr.archetype)
            s = stats[pr.archetype]
            s.games += 1
            s.total_vp += pr.final_vp
            s.total_tiles += pr.tiles_controlled
            s.total_vp_hexes += pr.vp_hexes_controlled
            if pr.player_id == game.winner_id:
                s.wins += 1
                s.total_rounds_when_won += game.rounds_played

    output: dict[str, Any] = {}
    for arch, s in sorted(stats.items()):
        expected_wr = 1.0 / len(stats) if len(stats) > 0 else 0
        output[arch] = {
            "wins": s.wins,
            "games": s.games,
            "win_rate": round(s.win_rate, 4),
            "expected_win_rate": round(expected_wr, 4),
            "delta": round(s.win_rate - expected_wr, 4),
            "avg_vp": round(s.avg_vp, 1),
            "avg_tiles": round(s.avg_tiles, 1),
            "avg_vp_hexes": round(s.total_vp_hexes / s.games if s.games > 0 else 0, 1),
            "avg_rounds_to_win": round(s.avg_rounds_to_win, 1),
        }

    return output


def _passive_win_rates(results: list[GameResult]) -> list[dict[str, Any]]:
    """Compute win rates per passive ability."""
    stats: dict[str, PassiveStats] = {}

    for game in results:
        for pr in game.player_results:
            passive_name = pr.passive or "none"
            if passive_name not in stats:
                stats[passive_name] = PassiveStats(passive_name=passive_name)
            s = stats[passive_name]
            s.games += 1
            if pr.player_id == game.winner_id:
                s.wins += 1

    total_games = len(results)
    num_players = len(results[0].player_results) if results else 2
    expected_wr = 1.0 / num_players if num_players > 0 else 0

    output = []
    for name, s in sorted(stats.items(), key=lambda x: x[1].win_rate, reverse=True):
        output.append({
            "passive": name,
            "wins": s.wins,
            "games": s.games,
            "win_rate": round(s.win_rate, 4),
            "delta_from_expected": round(s.win_rate - expected_wr, 4),
            "sample_size_warning": s.games < 30,
        })

    return output


def _card_purchase_stats(results: list[GameResult]) -> list[dict[str, Any]]:
    """Compute purchase frequency and win correlation per card."""
    card_data: dict[str, CardStats] = {}
    total_games = len(results)

    for game in results:
        # Track which cards were purchased in this game by which players
        game_purchases: dict[str, set[str]] = defaultdict(set)  # card -> set of pids

        for pr in game.player_results:
            for card_name, count in pr.cards_purchased.items():
                if card_name not in card_data:
                    card_data[card_name] = CardStats(card_name=card_name)
                cs = card_data[card_name]
                cs.times_purchased += count
                cs.total_games = total_games
                game_purchases[card_name].add(pr.player_id)

                # Track if this purchaser won
                cs.games_when_purchased += 1
                if pr.player_id == game.winner_id:
                    cs.wins_when_purchased += 1

        # Count unique games each card appeared in
        for card_name, pids in game_purchases.items():
            card_data[card_name].games_purchased_in += 1

    # Ensure total_games is set for all cards
    for cs in card_data.values():
        cs.total_games = total_games

    output = []
    for name, cs in sorted(card_data.items(), key=lambda x: x[1].purchase_rate, reverse=True):
        entry: dict[str, Any] = {
            "card": name,
            "times_purchased": cs.times_purchased,
            "purchase_rate": round(cs.purchase_rate, 4),
            "avg_copies_per_game": round(cs.avg_copies_per_game, 2),
            "win_rate_when_purchased": round(cs.win_rate_when_purchased, 4),
        }

        # Flag must-buy and dead cards
        if cs.purchase_rate > 0.7 and cs.win_rate_when_purchased > 0.6:
            entry["flag"] = "must_buy"
        elif cs.purchase_rate < 0.05:
            entry["flag"] = "dead_card"

        output.append(entry)

    return output


def _game_length_stats(results: list[GameResult]) -> dict[str, Any]:
    """Compute game length statistics."""
    rounds = [r.rounds_played for r in results if not r.timed_out]
    timed_out_pct = round(sum(1 for r in results if r.timed_out) / len(results) * 100, 1) if results else 0.0
    if not rounds:
        return {"avg_rounds": 0, "min_rounds": 0, "max_rounds": 0, "median_rounds": 0, "timed_out_pct": timed_out_pct}

    rounds.sort()
    n = len(rounds)

    return {
        "avg_rounds": round(sum(rounds) / n, 1),
        "min_rounds": rounds[0],
        "max_rounds": rounds[-1],
        "median_rounds": rounds[n // 2],
        "timed_out_pct": round(sum(1 for r in results if r.timed_out) / len(results) * 100, 1),
    }


def _action_economy_stats(results: list[GameResult]) -> dict[str, Any]:
    """Compute actions-per-turn statistics by archetype."""
    by_archetype: dict[str, ActionEconomyStats] = {}

    for game in results:
        for pr in game.player_results:
            if pr.archetype not in by_archetype:
                by_archetype[pr.archetype] = ActionEconomyStats(archetype=pr.archetype)
            by_archetype[pr.archetype].all_actions.extend(pr.actions_per_turn)

    output: dict[str, Any] = {}
    high_action_games = 0
    total_turns = 0

    for arch, stats in sorted(by_archetype.items()):
        total_turns += len(stats.all_actions)
        high_action_turns = sum(1 for a in stats.all_actions if a >= 8)
        high_action_games += high_action_turns
        output[arch] = {
            "mean": round(stats.mean, 2),
            "median": round(stats.median, 1),
            "max": stats.max_actions,
            "p95": stats.p95,
            "histogram": stats.histogram(),
            "turns_with_8plus_actions": high_action_turns,
        }

    output["_total_high_action_turns"] = high_action_games
    output["_total_turns"] = total_turns

    return output


def _vp_curves(results: list[GameResult]) -> dict[str, list[float]]:
    """Compute average VP per round per archetype."""
    by_archetype: dict[str, list[list[int]]] = defaultdict(list)

    for game in results:
        for pr in game.player_results:
            by_archetype[pr.archetype].append(pr.vp_over_time)

    output: dict[str, list[float]] = {}
    for arch, curves in sorted(by_archetype.items()):
        if not curves:
            continue
        max_len = max(len(c) for c in curves)
        avg_curve = []
        for round_idx in range(max_len):
            values = [c[round_idx] for c in curves if round_idx < len(c)]
            avg_curve.append(round(sum(values) / len(values), 1) if values else 0.0)
        output[arch] = avg_curve

    return output


def _snowball_indicator(results: list[GameResult]) -> dict[str, Any]:
    """Detect snowball patterns: does early tile lead predict winning?"""
    early_round = 3  # check tile count at round 3
    leader_wins = 0
    total_checked = 0

    for game in results:
        if game.timed_out or not game.winner_id:
            continue

        # Find who had the most tiles at round 3 (approximated by VP curve length)
        # We don't have per-round tile counts, so use VP as a proxy
        round_3_vp: dict[str, int] = {}
        for pr in game.player_results:
            if len(pr.vp_over_time) > early_round:
                round_3_vp[pr.player_id] = pr.vp_over_time[early_round]
            elif pr.vp_over_time:
                round_3_vp[pr.player_id] = pr.vp_over_time[-1]
            else:
                round_3_vp[pr.player_id] = 0

        if not round_3_vp:
            continue

        max_vp = max(round_3_vp.values())
        leaders = [pid for pid, vp in round_3_vp.items() if vp == max_vp]

        total_checked += 1
        if game.winner_id in leaders:
            leader_wins += 1

    return {
        "round_3_leader_win_rate": round(leader_wins / total_checked, 4) if total_checked > 0 else 0.0,
        "games_checked": total_checked,
        "interpretation": "High values (>0.7) suggest snowball problem — early advantages compound too strongly."
    }


# ── Console output ────────────────────────────────────────────────

def print_report(report: dict[str, Any]) -> None:
    """Print a human-readable balance report to console."""
    summary = report["summary"]
    print("\n" + "=" * 60)
    print("HEXDRAFT BALANCE REPORT")
    print("=" * 60)
    print(f"Games: {summary['total_games']} | "
          f"Grid: {summary['grid_size']} | "
          f"Archetypes: {', '.join(summary['player_archetypes'])}")
    print(f"Timed out: {summary['timed_out']} | "
          f"Errors: {summary['errored']} | "
          f"Duration: {summary['total_duration_ms']:.0f}ms")

    # Archetype win rates
    print("\n--- ARCHETYPE WIN RATES ---")
    arch_stats = report["archetype_win_rates"]
    for arch, stats in arch_stats.items():
        bar = "#" * int(stats["win_rate"] * 40)
        delta_str = f"+{stats['delta']:.1%}" if stats['delta'] > 0 else f"{stats['delta']:.1%}"
        print(f"  {arch:10s} {stats['win_rate']:6.1%} ({delta_str}) "
              f"[{bar:40s}] "
              f"avg_vp={stats['avg_vp']:.0f} avg_tiles={stats['avg_tiles']:.0f}")

    # Passive win rates
    print("\n--- PASSIVE WIN RATES (top 10) ---")
    passives = report["passive_win_rates"][:10]
    for p in passives:
        warn = " *low sample" if p["sample_size_warning"] else ""
        delta_str = f"+{p['delta_from_expected']:.1%}" if p['delta_from_expected'] > 0 else f"{p['delta_from_expected']:.1%}"
        print(f"  {p['passive']:25s} {p['win_rate']:6.1%} ({delta_str}) "
              f"n={p['games']}{warn}")

    # Card purchase stats
    print("\n--- CARD PURCHASE STATS (top 15) ---")
    cards = report["card_purchase_stats"][:15]
    for c in cards:
        flag = f" [{c['flag']}]" if "flag" in c else ""
        print(f"  {c['card']:25s} bought={c['purchase_rate']:5.1%} "
              f"wr={c['win_rate_when_purchased']:5.1%} "
              f"avg_copies={c['avg_copies_per_game']:.1f}{flag}")

    # Dead cards
    dead = [c for c in report["card_purchase_stats"] if c.get("flag") == "dead_card"]
    if dead:
        print(f"\n  Dead cards (bought <5%): {', '.join(c['card'] for c in dead)}")

    # Game length
    print("\n--- GAME LENGTH ---")
    gl = report["game_length_stats"]
    print(f"  Avg rounds: {gl['avg_rounds']} | "
          f"Min: {gl['min_rounds']} | Max: {gl['max_rounds']} | "
          f"Median: {gl['median_rounds']} | "
          f"Timed out: {gl['timed_out_pct']}%")

    # Action economy
    print("\n--- ACTION ECONOMY (actions per turn) ---")
    ae = report["action_economy"]
    for key, stats in ae.items():
        if key.startswith("_"):
            continue
        print(f"  {key:10s} mean={stats['mean']:.1f} "
              f"median={stats['median']:.0f} "
              f"max={stats['max']} "
              f"p95={stats['p95']} "
              f"8+_turns={stats['turns_with_8plus_actions']}")

    # Snowball
    print("\n--- SNOWBALL INDICATOR ---")
    sb = report["snowball_indicator"]
    print(f"  Round 3 leader win rate: {sb['round_3_leader_win_rate']:.1%} "
          f"(n={sb['games_checked']})")
    print(f"  {sb['interpretation']}")

    print("\n" + "=" * 60)


def export_json(report: dict[str, Any], path: str) -> None:
    """Export report to JSON file."""
    with open(path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"Report exported to {path}")


def export_csv(report: dict[str, Any], path: str) -> None:
    """Export key metrics to CSV."""
    import csv

    with open(path, "w", newline="") as f:
        writer = csv.writer(f)

        # Archetype win rates
        writer.writerow(["=== Archetype Win Rates ==="])
        writer.writerow(["archetype", "wins", "games", "win_rate", "delta",
                         "avg_vp", "avg_tiles"])
        for arch, stats in report["archetype_win_rates"].items():
            writer.writerow([arch, stats["wins"], stats["games"],
                            stats["win_rate"], stats["delta"],
                            stats["avg_vp"], stats["avg_tiles"]])
        writer.writerow([])

        # Passive win rates
        writer.writerow(["=== Passive Win Rates ==="])
        writer.writerow(["passive", "wins", "games", "win_rate", "delta"])
        for p in report["passive_win_rates"]:
            writer.writerow([p["passive"], p["wins"], p["games"],
                            p["win_rate"], p["delta_from_expected"]])
        writer.writerow([])

        # Card stats
        writer.writerow(["=== Card Purchase Stats ==="])
        writer.writerow(["card", "purchase_rate", "win_rate_when_purchased",
                         "avg_copies", "flag"])
        for c in report["card_purchase_stats"]:
            writer.writerow([c["card"], c["purchase_rate"],
                            c["win_rate_when_purchased"],
                            c["avg_copies_per_game"],
                            c.get("flag", "")])

    print(f"CSV exported to {path}")
