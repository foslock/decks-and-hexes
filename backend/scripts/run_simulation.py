#!/usr/bin/env python3
"""CLI entry point for Card Clash Monte Carlo balance testing.

Usage examples:
    # Run 100 games, 2-player small map, default archetypes
    uv run python scripts/run_simulation.py --games 100 --grid small --players 2

    # Run with specific archetypes
    uv run python scripts/run_simulation.py --games 500 --archetypes vanguard,swarm,fortress

    # Full sweep across all configurations
    uv run python scripts/run_simulation.py --sweep --games 50

    # Reproduce a specific game with verbose output
    uv run python scripts/run_simulation.py --games 1 --seed 42 --verbose
"""

import argparse
import sys
import os

# Add backend to path so we can import app modules
_backend_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, _backend_dir)

from app.game_engine.cards import Archetype
from app.game_engine.hex_grid import GridSize
from app.game_engine.simulation import (
    BatchConfig,
    SimConfig,
    generate_archetype_combos,
    run_batch,
    run_game,
)
from app.game_engine.balance_report import (
    generate_report,
    print_report,
    export_json,
    export_csv,
)
from app.data_loader.loader import load_all_cards


ARCHETYPE_MAP = {
    "vanguard": Archetype.VANGUARD,
    "swarm": Archetype.SWARM,
    "fortress": Archetype.FORTRESS,
}

GRID_MAP = {
    "small": GridSize.SMALL,
    "medium": GridSize.MEDIUM,
    "large": GridSize.LARGE,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Card Clash Monte Carlo Balance Simulator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--games", type=int, default=100,
                        help="Number of games per configuration (default: 100)")
    parser.add_argument("--grid", choices=["small", "medium", "large", "all"],
                        default="small", help="Grid size (default: small)")
    parser.add_argument("--players", type=int, default=None,
                        help="Number of players (default: from archetype count)")
    parser.add_argument("--archetypes", type=str, default=None,
                        help="Comma-separated archetypes (e.g. vanguard,swarm)")
    parser.add_argument("--noise", type=float, default=0.0,
                        help="CPU noise parameter 0.0-1.0 (default: 0.0)")
    parser.add_argument("--sweep", action="store_true",
                        help="Run all grid/player/archetype combinations")
    parser.add_argument("--seed", type=int, default=None,
                        help="Base RNG seed for reproducibility")
    parser.add_argument("--max-rounds", type=int, default=50,
                        help="Max rounds per game (default: 50)")
    parser.add_argument("--vp-target", type=int, default=None,
                        help="VP target to win (default: 10)")
    parser.add_argument("--pack", type=str, default="everything",
                        help="Card pack ID (default: everything)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print per-game details")
    parser.add_argument("--output", type=str, default=None,
                        help="Write JSON results to file")
    parser.add_argument("--csv", type=str, default=None,
                        help="Write CSV summary to file")
    return parser.parse_args()


def run_single_config(archetypes: list[Archetype], grid_size: GridSize,
                      args: argparse.Namespace,
                      card_registry: dict) -> dict:
    """Run a batch for a single configuration and return the report."""
    config = BatchConfig(
        num_games=args.games,
        grid_size=grid_size,
        player_archetypes=archetypes,
        cpu_noise=args.noise,
        base_seed=args.seed,
        max_rounds=args.max_rounds,
        verbose=args.verbose,
        vp_target=args.vp_target,
        card_pack=args.pack,
    )

    arch_str = "+".join(a.value for a in archetypes)
    pack_str = f" [pack: {args.pack}]" if args.pack != "everything" else ""
    print(f"\nRunning {args.games} games: {arch_str} on {grid_size.value}{pack_str}...")

    batch_result = run_batch(config, card_registry=card_registry)
    report = generate_report(batch_result)
    print_report(report)

    return report


def main() -> None:
    args = parse_args()

    print("Loading card data...")
    card_registry = load_all_cards()
    print(f"Loaded {len(card_registry)} cards")

    all_reports: list[dict] = []

    if args.sweep:
        # Run all combinations
        grids = [GridSize.SMALL, GridSize.MEDIUM, GridSize.LARGE]
        player_counts = [2, 3, 4]

        for grid_size in grids:
            for num_players in player_counts:
                combos = generate_archetype_combos(num_players)
                for combo in combos:
                    report = run_single_config(combo, grid_size, args, card_registry)
                    all_reports.append(report)

    elif args.archetypes:
        # Parse specific archetypes
        arch_names = [a.strip().lower() for a in args.archetypes.split(",")]
        archetypes = []
        for name in arch_names:
            if name not in ARCHETYPE_MAP:
                print(f"Unknown archetype: {name}. Use: {', '.join(ARCHETYPE_MAP.keys())}")
                sys.exit(1)
            archetypes.append(ARCHETYPE_MAP[name])

        grid_size = GRID_MAP[args.grid] if args.grid != "all" else GridSize.SMALL
        if args.grid == "all":
            for gs in [GridSize.SMALL, GridSize.MEDIUM, GridSize.LARGE]:
                report = run_single_config(archetypes, gs, args, card_registry)
                all_reports.append(report)
        else:
            report = run_single_config(archetypes, grid_size, args, card_registry)
            all_reports.append(report)

    else:
        # Default: use player count to generate combos
        num_players = args.players or 2
        grid_size = GRID_MAP[args.grid] if args.grid != "all" else GridSize.SMALL

        if args.grid == "all":
            grids = [GridSize.SMALL, GridSize.MEDIUM, GridSize.LARGE]
        else:
            grids = [grid_size]

        combos = generate_archetype_combos(num_players)

        for gs in grids:
            for combo in combos:
                report = run_single_config(combo, gs, args, card_registry)
                all_reports.append(report)

    # Export results
    if args.output and all_reports:
        combined = all_reports[0] if len(all_reports) == 1 else {"configurations": all_reports}
        export_json(combined, args.output)

    if args.csv and all_reports:
        combined = all_reports[0] if len(all_reports) == 1 else all_reports[0]
        export_csv(combined, args.csv)


if __name__ == "__main__":
    main()
