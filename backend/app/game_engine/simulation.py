"""Headless game simulation driver for Monte Carlo balance testing.

Runs complete games using CPU players with no API/UI dependency.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from itertools import combinations_with_replacement
from typing import Any, Optional

from .cards import Archetype
from .cpu_player import CPUPlayer
from .game_state import (
    GameState,
    Phase,
    create_game,
    execute_start_of_turn,
    play_card,
    submit_plan,
    buy_card,
    reroll_market,
    end_buy_phase,
)
from .hex_grid import GridSize

from ..data_loader.loader import load_all_cards


# ── Data classes ──────────────────────────────────────────────────

@dataclass
class SimConfig:
    grid_size: GridSize = GridSize.SMALL
    player_archetypes: list[Archetype] = field(default_factory=lambda: [Archetype.VANGUARD, Archetype.SWARM])
    cpu_noise: float = 0.0
    seed: Optional[int] = None
    max_rounds: int = 50
    verbose: bool = False
    vp_target: Optional[int] = None  # None = use game default


@dataclass
class PlayerResult:
    player_id: str
    name: str
    archetype: str
    passive: Optional[str] = None
    final_vp: int = 0
    final_resources: int = 0
    tiles_controlled: int = 0
    vp_hexes_controlled: int = 0
    cards_purchased: dict[str, int] = field(default_factory=dict)
    total_claims_made: int = 0
    total_claims_won: int = 0
    total_claims_lost: int = 0
    actions_per_turn: list[int] = field(default_factory=list)
    vp_over_time: list[int] = field(default_factory=list)
    resources_over_time: list[int] = field(default_factory=list)


@dataclass
class GameResult:
    seed: Optional[int] = None
    grid_size: str = ""
    winner_id: Optional[str] = None
    winner_archetype: Optional[str] = None
    winner_passive: Optional[str] = None
    rounds_played: int = 0
    player_results: list[PlayerResult] = field(default_factory=list)
    timed_out: bool = False
    error: Optional[str] = None
    duration_ms: float = 0.0


@dataclass
class BatchConfig:
    num_games: int = 100
    grid_size: GridSize = GridSize.SMALL
    player_archetypes: list[Archetype] = field(default_factory=lambda: [Archetype.VANGUARD, Archetype.SWARM])
    cpu_noise: float = 0.0
    base_seed: Optional[int] = None
    max_rounds: int = 50
    verbose: bool = False
    vp_target: Optional[int] = None


@dataclass
class BatchResult:
    config: BatchConfig = field(default_factory=BatchConfig)
    results: list[GameResult] = field(default_factory=list)
    total_duration_ms: float = 0.0


# ── Single game simulation ───────────────────────────────────────

def run_game(config: SimConfig, card_registry: Optional[dict[str, Any]] = None) -> GameResult:
    """Run a single complete game and return structured results."""
    start_time = time.monotonic()
    result = GameResult(seed=config.seed, grid_size=config.grid_size.value)

    # Load cards if not provided
    if card_registry is None:
        card_registry = load_all_cards()

    # Create player configs
    player_configs = []
    for i, archetype in enumerate(config.player_archetypes):
        player_configs.append({
            "id": f"cpu_{i}",
            "name": f"CPU_{archetype.value}_{i}",
            "archetype": archetype.value,
        })

    try:
        game = create_game(config.grid_size, player_configs, card_registry,
                           seed=config.seed, vp_target=config.vp_target)

        # Create CPU players
        cpus: dict[str, CPUPlayer] = {}
        for pid in game.player_order:
            cpus[pid] = CPUPlayer(pid, noise=config.cpu_noise, rng=game.rng)

        # Initialize per-player tracking
        tracking: dict[str, PlayerResult] = {}
        for pid in game.player_order:
            p = game.players[pid]
            tracking[pid] = PlayerResult(
                player_id=pid,
                name=p.name,
                archetype=p.archetype.value,
            )

        # Run start of turn for round 1
        execute_start_of_turn(game)

        # Main game loop
        while game.current_phase != Phase.GAME_OVER:
            if game.current_round > config.max_rounds:
                result.timed_out = True
                if config.verbose:
                    print(f"  Game timed out after {config.max_rounds} rounds")
                break

            if game.current_phase == Phase.PLAN:
                _run_plan_phase(game, cpus, tracking, config.verbose)
            elif game.current_phase == Phase.BUY:
                _run_buy_phase(game, cpus, tracking, config.verbose)
            elif game.current_phase == Phase.START_OF_TURN:
                # Record VP/resources at start of each turn
                for pid in game.player_order:
                    p = game.players[pid]
                    tracking[pid].vp_over_time.append(p.vp)
                    tracking[pid].resources_over_time.append(p.resources)
                # This shouldn't happen in normal flow since execute_end_of_turn
                # calls execute_start_of_turn, but handle it just in case
                execute_start_of_turn(game)
            else:
                # Shouldn't reach here — other phases are triggered by phase transitions
                break

        # Collect final results
        result.rounds_played = game.current_round
        result.winner_id = game.winner
        if game.winner:
            winner = game.players[game.winner]
            result.winner_archetype = winner.archetype.value
            result.winner_passive = winner.passive.get("name") if winner.passive else None

        for pid in game.player_order:
            p = game.players[pid]
            tr = tracking[pid]
            tr.final_vp = p.vp
            tr.final_resources = p.resources
            if game.grid:
                player_tiles = game.grid.get_player_tiles(pid)
                tr.tiles_controlled = len(player_tiles)
                tr.vp_hexes_controlled = sum(1 for t in player_tiles if t.is_vp)
            # Record final VP/resources
            tr.vp_over_time.append(p.vp)
            tr.resources_over_time.append(p.resources)
            result.player_results.append(tr)

    except Exception as e:
        result.error = str(e)
        if config.verbose:
            import traceback
            traceback.print_exc()

    result.duration_ms = (time.monotonic() - start_time) * 1000
    return result


def _run_plan_phase(game: GameState, cpus: dict[str, CPUPlayer],
                    tracking: dict[str, PlayerResult],
                    verbose: bool) -> None:
    """Run the plan phase for all CPU players."""
    for pid in game.player_order:
        player = game.players[pid]
        cpu = cpus[pid]

        if player.has_submitted_plan:
            continue

        actions_this_turn = 0

        # Keep playing cards until CPU decides to stop
        max_iterations = 20  # safety limit
        iterations = 0
        while iterations < max_iterations:
            iterations += 1
            action = cpu.pick_next_action(game)
            if action is None:
                break

            card_index = action["card_index"]
            success, msg = play_card(
                game, pid, card_index,
                target_q=action.get("target_q"),
                target_r=action.get("target_r"),
                target_player_id=action.get("target_player_id"),
                discard_card_indices=action.get("discard_card_indices"),
                trash_card_indices=action.get("trash_card_indices"),
                extra_targets=action.get("extra_targets"),
            )

            if success:
                actions_this_turn += 1
                card_name = msg.replace("Played ", "")
                if verbose:
                    print(f"  {player.name} plays {card_name}")

                # Track claims
                if action.get("target_q") is not None:
                    tracking[pid].total_claims_made += 1
            else:
                if verbose:
                    print(f"  {player.name} failed to play card: {msg}")
                break

        tracking[pid].actions_per_turn.append(actions_this_turn)

        # Submit plan
        submit_plan(game, pid)


def _run_buy_phase(game: GameState, cpus: dict[str, CPUPlayer],
                   tracking: dict[str, PlayerResult],
                   verbose: bool) -> None:
    """Run the buy phase for all CPU players."""
    for pid in game.player_order:
        player = game.players[pid]
        cpu = cpus[pid]

        if player.has_ended_turn:
            continue

        # Consider rerolling market first
        if cpu.should_reroll_market(game):
            success, _ = reroll_market(game, pid)
            if success and verbose:
                print(f"  {player.name} rerolls market")

        # Buy cards
        max_purchases = 10  # safety limit
        purchases = 0
        while purchases < max_purchases:
            purchase = cpu.pick_next_purchase(game)
            if purchase is None:
                break

            source = purchase["source"]
            card_id = purchase.get("card_id", "")

            success, msg = buy_card(game, pid, source, card_id or "")
            if success:
                purchases += 1
                if verbose:
                    print(f"  {player.name} buys: {msg}")

                # Track purchases
                bought_name = msg.replace("Bought ", "").replace("Upgrade credit purchased", "upgrade_credit")
                tracking[pid].cards_purchased[bought_name] = \
                    tracking[pid].cards_purchased.get(bought_name, 0) + 1
            else:
                break

        # End buy phase
        end_buy_phase(game, pid)

    # Track claim results from resolution steps
    if game.resolution_steps:
        for step in game.resolution_steps:
            winner_id = step.get("winner_id")
            for claimant in step.get("claimants", []):
                cpid = claimant["player_id"]
                if cpid in tracking:
                    if cpid == winner_id:
                        tracking[cpid].total_claims_won += 1
                    else:
                        tracking[cpid].total_claims_lost += 1


# ── Batch simulation ─────────────────────────────────────────────

def run_batch(config: BatchConfig,
              card_registry: Optional[dict[str, Any]] = None) -> BatchResult:
    """Run N games with the given configuration."""
    start_time = time.monotonic()

    if card_registry is None:
        card_registry = load_all_cards()

    batch_result = BatchResult(config=config)

    for i in range(config.num_games):
        seed = (config.base_seed + i) if config.base_seed is not None else None
        sim_config = SimConfig(
            grid_size=config.grid_size,
            player_archetypes=config.player_archetypes,
            cpu_noise=config.cpu_noise,
            seed=seed,
            max_rounds=config.max_rounds,
            verbose=config.verbose,
            vp_target=config.vp_target,
        )
        result = run_game(sim_config, card_registry=card_registry)
        batch_result.results.append(result)

        if config.verbose:
            winner_arch = result.winner_archetype or "timeout"
            print(f"Game {i+1}/{config.num_games}: winner={winner_arch}, "
                  f"rounds={result.rounds_played}, "
                  f"time={result.duration_ms:.0f}ms")

    batch_result.total_duration_ms = (time.monotonic() - start_time) * 1000
    return batch_result


def generate_archetype_combos(num_players: int) -> list[list[Archetype]]:
    """Generate all unique archetype combinations for a given player count."""
    archetypes = [Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS]
    return [list(combo) for combo in combinations_with_replacement(archetypes, num_players)]
