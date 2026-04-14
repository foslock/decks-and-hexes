"""REST API routes for multiplayer play."""

from __future__ import annotations

import asyncio
import json
import logging
import pickle
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.api.ws_manager import manager
from app.api.lobby import get_visible_player_ids
from app.data_loader.loader import load_all_cards
from app.game_engine.card_packs import CARD_PACKS
from app.game_engine.cards import Archetype
from app.game_engine.game_state import (
    GameState,
    Phase,
    advance_resolve,
    auto_play_cpu_buys,
    auto_play_cpu_plays,
    buy_card,
    create_game,
    end_buy_phase,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    reroll_market,
    spend_upgrade_credit,
    submit_pending_discard,
    submit_pending_search,
    undo_planned_action,
    submit_play,
)
from app.game_engine.hex_grid import GridSize
from app.storage.analytics import AnalyticsRecorder
from app.storage.game_store import GameStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Game storage — backed by DB with in-memory cache
_store: GameStore | None = None
# Track active CPU buy background tasks per game to detect orphaned buys
_active_cpu_buy_tasks: dict[str, "asyncio.Task[None]"] = {}
# Per-game locks to serialize concurrent CPU buy mutations
_game_locks: dict[str, asyncio.Lock] = {}


def _get_game_lock(game_id: str) -> asyncio.Lock:
    """Get or create an asyncio lock for a game to serialize state mutations."""
    if game_id not in _game_locks:
        _game_locks[game_id] = asyncio.Lock()
    return _game_locks[game_id]
_analytics: AnalyticsRecorder | None = None
_card_registry: dict[str, Any] | None = None


def init_routes(store: GameStore, analytics: AnalyticsRecorder | None = None) -> None:
    """Initialize routes with the shared GameStore (called from main.py)."""
    global _store, _analytics
    _store = store
    _analytics = analytics


def _get_store() -> GameStore:
    if _store is None:
        raise RuntimeError("Routes not initialized — call init_routes() first")
    return _store


def _get_card_registry() -> dict[str, Any]:
    global _card_registry
    if _card_registry is None:
        _card_registry = load_all_cards()
    return _card_registry


def _is_multiplayer(game: GameState) -> bool:
    """Check if this game was created from a lobby (multiplayer)."""
    return bool(getattr(game, 'lobby_code', None))


def _game_state_for_player(game: GameState, player_id: str) -> dict[str, Any]:
    """Return game state dict with proper hand visibility for this player."""
    visible = get_visible_player_ids(game.id, player_id) if _is_multiplayer(game) else None
    return game.to_dict(for_player_id=player_id, visible_player_ids=visible)


async def _broadcast_state(game_id: str, game: GameState) -> None:
    """Broadcast game state to all connected players with proper visibility."""
    await manager.broadcast_game_state(game_id, game, get_visible_ids=get_visible_player_ids)


# ── Request/Response models ──────────────────────────────────


class CreateGameRequest(BaseModel):
    grid_size: str = "small"
    players: list[dict[str, Any]]
    seed: Optional[int] = None
    test_mode: bool = False
    speed: str = "normal"


class PlayCardRequest(BaseModel):
    player_id: str
    card_index: int
    target_q: Optional[int] = None
    target_r: Optional[int] = None
    target_player_id: Optional[str] = None
    discard_card_indices: Optional[list[int]] = None
    trash_card_indices: Optional[list[int]] = None
    extra_targets: Optional[list[list[int]]] = None
    # Tutor / SEARCH_ZONE resolution — when the human UI gates the play on
    # a selection modal, it bundles the selections here so the card + search
    # commit atomically.
    search_selections: Optional[list[dict[str, Any]]] = None


class SubmitDiscardRequest(BaseModel):
    player_id: str
    discard_card_indices: list[int]


class SubmitSearchRequest(BaseModel):
    player_id: str
    selections: list[dict[str, Any]]  # [{"card_id": "...", "target": "hand"}, ...]


class SubmitPlanRequest(BaseModel):
    player_id: str


class BuyCardRequest(BaseModel):
    player_id: str
    source: str  # "archetype", "shared", "upgrade"
    card_id: Optional[str] = None


class UpgradeCardRequest(BaseModel):
    player_id: str
    card_index: int


class RerollRequest(BaseModel):
    player_id: str


class EndBuyRequest(BaseModel):
    player_id: str


class EndTurnRequest(BaseModel):
    player_id: str


class AdvanceResolveRequest(BaseModel):
    player_id: str


# ── Endpoints ────────────────────────────────────────────────


@router.post("/games")
async def create_new_game(req: CreateGameRequest) -> dict[str, Any]:
    """Create a new game."""
    try:
        grid_size = GridSize(req.grid_size)
    except ValueError:
        raise HTTPException(400, f"Invalid grid size: {req.grid_size}")

    registry = _get_card_registry()

    player_configs = []
    for i, p in enumerate(req.players):
        try:
            archetype = Archetype(p["archetype"])
        except (KeyError, ValueError):
            raise HTTPException(400, f"Invalid archetype for player {i}")
        player_configs.append({
            "id": p.get("id", f"player_{i}"),
            "name": p.get("name", f"Player {i + 1}"),
            "archetype": p["archetype"],
            "is_cpu": p.get("is_cpu", False),
            "cpu_noise": p.get("cpu_noise", 0.15),
        })

    game = create_game(grid_size, player_configs, registry, seed=req.seed, test_mode=req.test_mode, speed=req.speed)
    # Auto-execute start of turn for round 1
    execute_start_of_turn(game)
    store = _get_store()
    await store.put(game)

    return {"game_id": game.id, "state": game.to_dict()}


@router.get("/games/{game_id}")
async def get_game(game_id: str, player_id: Optional[str] = None) -> dict[str, Any]:
    """Get current game state."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if player_id and _is_multiplayer(game):
        visible = get_visible_player_ids(game.id, player_id)
        return game.to_dict(for_player_id=player_id, visible_player_ids=visible)
    return game.to_dict(for_player_id=player_id)


@router.post("/games/{game_id}/play")
async def play_card_route(game_id: str, req: PlayCardRequest) -> dict[str, Any]:
    """Play a card during Play phase."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    extra_targets = None
    if req.extra_targets:
        extra_targets = [(t[0], t[1]) for t in req.extra_targets if len(t) >= 2]

    # Capture card info before play (play_card removes from hand)
    player = game.players.get(req.player_id)
    card_info = None
    if player and 0 <= req.card_index < len(player.hand):
        c = player.hand[req.card_index]
        card_info = (c.id, c.name)

    success, msg = play_card(
        game, req.player_id, req.card_index,
        req.target_q, req.target_r, req.target_player_id,
        discard_card_indices=req.discard_card_indices,
        trash_card_indices=req.trash_card_indices,
        extra_targets=extra_targets,
        search_selections=req.search_selections,
    )
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)

    # Analytics: record card played (fire-and-forget)
    if _analytics and card_info:
        _analytics.record_card_played(
            game_id, req.player_id, game.current_round,
            card_info[0], card_info[1],
            target_q=req.target_q, target_r=req.target_r,
        )
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


class UndoCardRequest(BaseModel):
    player_id: str
    action_index: int


@router.post("/games/{game_id}/undo-card")
async def undo_card_route(game_id: str, req: UndoCardRequest) -> dict[str, Any]:
    """Undo a reversible planned action during Play phase."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = undo_planned_action(game, req.player_id, req.action_index)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/submit-discard")
async def submit_discard_route(game_id: str, req: SubmitDiscardRequest) -> dict[str, Any]:
    """Submit deferred discard choices (e.g. Regroup: draw first, then discard)."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = submit_pending_discard(game, req.player_id, req.discard_card_indices)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/submit-search")
async def submit_search_route(game_id: str, req: SubmitSearchRequest) -> dict[str, Any]:
    """Submit deferred tutor/search selections (SEARCH_ZONE effects)."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = submit_pending_search(game, req.player_id, req.selections)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/submit-play")
async def submit_play_route(game_id: str, req: SubmitPlanRequest) -> dict[str, Any]:
    """Submit plan for a player."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = submit_play(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    # Auto-play CPU plays if any CPU players haven't submitted yet
    if any(p.is_cpu and not p.has_submitted_play for p in game.players.values()):
        auto_play_cpu_plays(game)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/advance-resolve")
async def advance_resolve_route(game_id: str, req: AdvanceResolveRequest) -> dict[str, Any]:
    """Player acknowledges resolve phase (animations done), advance to buy."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = advance_resolve(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/buy")
async def buy_card_route(game_id: str, req: BuyCardRequest) -> dict[str, Any]:
    """Buy a card during Buy phase."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = buy_card(game, req.player_id, req.source, req.card_id or "")
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)

    # Analytics: record card purchase (fire-and-forget)
    if _analytics and "Bought" in msg:
        # msg format: "Bought {card_name} for {cost} resources"
        _analytics.record_card_bought(
            game_id, req.player_id, game.current_round,
            req.card_id or "", msg.split("Bought ")[-1].split(" for ")[0],
            req.source, 0,  # cost is in the message but we don't parse it here
        )

    if _is_multiplayer(game):
        # Broadcast a lightweight purchase event before the full state update
        # so other players can trigger fly animations immediately
        if req.source == "shared":
            await manager.send_to_others(game_id, req.player_id, {
                "type": "shared_purchase",
                "player_id": req.player_id,
                "player_name": game.players[req.player_id].name,
                "player_color": game.players[req.player_id].color,
                "card_id": req.card_id or "",
                "card_name": msg.replace("Bought ", ""),
            })
        # Broadcast cursor_click so other players see the click pulse
        await manager.send_to_others(game_id, req.player_id, {
            "type": "cursor_click",
            "player_id": req.player_id,
        })
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/upgrade-card")
async def upgrade_card_route(game_id: str, req: UpgradeCardRequest) -> dict[str, Any]:
    """Spend an upgrade credit to upgrade a card in hand during Play phase."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = spend_upgrade_credit(game, req.player_id, req.card_index)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/reroll")
async def reroll_route(game_id: str, req: RerollRequest) -> dict[str, Any]:
    """Re-roll archetype market."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = reroll_market(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/end-buy")
async def end_buy_route(game_id: str, req: EndBuyRequest) -> dict[str, Any]:
    """End buy phase for a player."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = end_buy_phase(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/process-cpu-buys")
async def process_cpu_buys_route(game_id: str) -> dict[str, Any]:
    """Process CPU buyers during the buy phase.

    For multiplayer games, launches async cursor simulation so CPU cursors
    animate realistically.
    """
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    if game.current_phase != Phase.BUY:
        raise HTTPException(400, f"Not in Buy phase (current: {game.current_phase.value})")

    # Check that at least one CPU player has not yet finished buying
    has_pending_cpu = any(
        game.players[pid].is_cpu and pid not in game.players_done_buying
        for pid in game.player_order
        if not game.players[pid].has_left
    )
    if not has_pending_cpu:
        raise HTTPException(400, "No CPU players pending")

    if _is_multiplayer(game):
        # Launch async cursor simulation if not already running
        existing = _active_cpu_buy_tasks.get(game_id)
        if existing and not existing.done():
            return {"message": "CPU buys already in progress", "state": game.to_dict()}
        task = asyncio.create_task(_process_cpu_buys_with_cursors(game_id))
        _active_cpu_buy_tasks[game_id] = task
        def _cleanup(_t: asyncio.Task[None]) -> None:
            _active_cpu_buy_tasks.pop(game_id, None)
            _game_locks.pop(game_id, None)
        task.add_done_callback(_cleanup)
        return {"message": "CPU buys started (async)", "state": game.to_dict()}

    # Hot-seat: process instantly
    auto_play_cpu_buys(game)
    await store.save(game)
    return {"message": "CPU buys processed", "state": game.to_dict()}


async def _process_cpu_buys_with_cursors(game_id: str) -> None:
    """Process CPU buys with simulated cursor movement broadcast via WebSocket.

    All CPU players buy concurrently — each runs as an independent coroutine
    that re-fetches game state before every purchase to stay in sync.
    If the task crashes or is cancelled, a finally block ensures all pending
    CPU players get end_buy_phase() so the game doesn't get stuck.
    """
    from app.game_engine.cpu_player import CPUPlayer

    store = _get_store()
    game = await store.get(game_id)
    if not game or game.current_phase != Phase.BUY:
        return

    cpu_pids = [
        pid for pid in game.player_order
        if game.players[pid].is_cpu
        and not game.players[pid].has_left
        and pid not in game.players_done_buying
    ]
    if not cpu_pids:
        return

    try:
        # Hard timeout of 15s prevents infinite stalls
        await asyncio.wait_for(
            asyncio.gather(*[_process_single_cpu_buy(game_id, pid) for pid in cpu_pids]),
            timeout=15.0,
        )
    except asyncio.TimeoutError:
        logger.warning("CPU buy task timed out for game %s — forcing completion", game_id)
    except Exception:
        logger.exception("CPU buy task failed for game %s — forcing completion", game_id)
    else:
        return  # All CPUs finished normally
        # Force-complete any CPUs that didn't finish
        lock = _get_game_lock(game_id)
        async with lock:
            game = await store.get(game_id)
            if game and game.current_phase == Phase.BUY:
                for pid in cpu_pids:
                    if pid not in game.players_done_buying:
                        end_buy_phase(game, pid)
                await store.save(game)
                await _broadcast_state(game_id, game)


async def _process_single_cpu_buy(game_id: str, pid: str) -> None:
    """Run the full buy sequence for one CPU player."""
    import random
    import time
    from app.game_engine.cpu_player import CPUPlayer

    CPU_BUY_MAX_SECONDS = 8.0
    CPU_BUY_AVG_SECONDS = 5.0

    store = _get_store()
    game = await store.get(game_id)
    if not game or game.current_phase != Phase.BUY:
        return

    player = game.players[pid]
    cpu = CPUPlayer(pid, noise=player.cpu_noise, rng=game.rng)

    # Random time budget: uniform [2*avg - max, max] so the mean is ~avg
    budget = random.uniform(
        2 * CPU_BUY_AVG_SECONDS - CPU_BUY_MAX_SECONDS,
        CPU_BUY_MAX_SECONDS,
    )
    t_start = time.monotonic()

    def _all_humans_done(g: GameState) -> bool:
        for p_id in g.player_order:
            p = g.players[p_id]
            if p.is_cpu or p.has_left:
                continue
            if p_id not in g.players_done_buying:
                return False
        return True

    def _remaining() -> float:
        return max(0.0, budget - (time.monotonic() - t_start))

    async def _cpu_sleep(g: GameState, seconds: float) -> None:
        if not _all_humans_done(g):
            await asyncio.sleep(min(seconds, _remaining()))

    lock = _get_game_lock(game_id)

    # Reroll market if desirable — needs lock for state mutation
    if cpu.should_reroll_market(game):
        async with lock:
            game = await store.get(game_id)
            if not game or game.current_phase != Phase.BUY:
                return
            reroll_market(game, pid)
            await store.save(game)
            await _broadcast_state(game_id, game)
        await _cpu_sleep(game, 0.5)

    # Plan purchases under lock (reads shared state like shared market)
    async with lock:
        game = await store.get(game_id)
        if not game or game.current_phase != Phase.BUY:
            return
        purchases: list[dict[str, Any]] = []
        for _ in range(10):
            purchase = cpu.pick_next_purchase(game)
            if purchase is None:
                break
            purchases.append(purchase)

    # Simulate browsing for each purchase
    for purchase in purchases:
        async with lock:
            game = await store.get(game_id)
        if not game or game.current_phase != Phase.BUY:
            return
        player = game.players[pid]
        humans_waiting = not _all_humans_done(game)

        # Hover over 1-2 decoy cards before buying (skip if humans done or out of time)
        if humans_waiting and _remaining() > 0.5:
            decoys = _pick_cpu_decoy_hovers(game, pid, purchase)
            for decoy in decoys:
                if _remaining() < 0.5:
                    break
                await manager.send_to_others(game_id, pid, {
                    "type": "cursor_update",
                    "player_id": pid,
                    "player_name": player.name,
                    "player_color": player.color,
                    "hovered_card_id": decoy.get("card_id"),
                    "source": decoy.get("source"),
                })
                await asyncio.sleep(min(0.6 + random.random() * 0.8, _remaining()))

            # Hover on actual target
            if _remaining() > 0.2:
                await manager.send_to_others(game_id, pid, {
                    "type": "cursor_update",
                    "player_id": pid,
                    "player_name": player.name,
                    "player_color": player.color,
                    "hovered_card_id": purchase.get("card_id"),
                    "source": purchase["source"],
                })
                await asyncio.sleep(min(0.3 + random.random() * 0.4, _remaining()))

        # Execute purchase under lock — atomic read-mutate-save
        async with lock:
            game = await store.get(game_id)
            if not game or game.current_phase != Phase.BUY:
                return
            success, _msg = buy_card(
                game, pid, purchase["source"], purchase.get("card_id", ""),
            )
            if success:
                if purchase["source"] == "shared":
                    await manager.send_to_others(game_id, pid, {
                        "type": "shared_purchase",
                        "player_id": pid,
                        "player_name": player.name,
                        "player_color": player.color,
                        "card_id": purchase.get("card_id", ""),
                        "card_name": _msg.replace("Bought ", ""),
                    })
                await manager.send_to_others(game_id, pid, {
                    "type": "cursor_click",
                    "player_id": pid,
                })
                await store.save(game)
                await _broadcast_state(game_id, game)
        await _cpu_sleep(game, 0.3)

    # Clear cursor and signal done
    await manager.send_to_others(game_id, pid, {
        "type": "cursor_update",
        "player_id": pid,
        "player_name": player.name,
        "player_color": player.color,
        "hovered_card_id": None,
        "source": None,
    })

    async with lock:
        game = await store.get(game_id)
        if not game or game.current_phase != Phase.BUY:
            return
        end_buy_phase(game, pid)
        await store.save(game)
        await _broadcast_state(game_id, game)


def _pick_cpu_decoy_hovers(
    game: GameState, cpu_pid: str, actual_purchase: dict[str, Any],
) -> list[dict[str, str]]:
    """Pick 1-2 random market cards for CPU to 'consider' before buying."""
    import random

    decoys: list[dict[str, str]] = []
    # Gather available shared cards as potential decoys
    available = game.shared_market.get_available()
    shared_ids = [
        s["card"]["id"] for s in available
        if s["remaining"] > 0 or s.get("selling_out")
    ]
    # Gather archetype market cards
    cpu_player = game.players.get(cpu_pid)
    arch_ids = [c.id for c in (cpu_player.archetype_market if cpu_player else [])]

    all_candidates = (
        [{"card_id": cid, "source": "shared"} for cid in shared_ids]
        + [{"card_id": cid, "source": "archetype"} for cid in arch_ids]
    )
    # Exclude the actual target
    actual_id = actual_purchase.get("card_id", "")
    all_candidates = [c for c in all_candidates if c["card_id"] != actual_id]

    if all_candidates:
        count = min(len(all_candidates), random.randint(1, 2))
        decoys = random.sample(all_candidates, count)
    return decoys


@router.post("/games/{game_id}/advance-upkeep")
async def advance_upkeep_route(game_id: str) -> dict[str, Any]:
    """Advance past the Upkeep phase to Play phase."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    if game.current_phase != Phase.UPKEEP:
        raise HTTPException(400, f"Not in Upkeep phase (current: {game.current_phase.value})")

    execute_upkeep(game)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": "Upkeep complete", "state": game.to_dict()}


@router.post("/games/{game_id}/end-turn")
async def end_turn_route(game_id: str, req: EndTurnRequest) -> dict[str, Any]:
    """End the current turn for a player (delegates to end_buy_phase)."""
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = end_buy_phase(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    await store.save(game)
    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.get("/games/{game_id}/log")
async def get_game_log(game_id: str, player_id: Optional[str] = None) -> dict[str, Any]:
    """Get the full game log, filtered by player visibility."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    if player_id:
        entries = game.get_log_for_player(player_id)
    else:
        entries = game.get_full_log()

    return {"game_id": game_id, "entries": entries}


@router.get("/card-packs")
async def list_card_packs() -> dict[str, Any]:
    """List all available card packs with their metadata."""
    from app.game_engine.card_packs import get_today_daily_pack
    daily = get_today_daily_pack(_get_card_registry())
    packs = [daily.to_dict()] + [pack.to_dict() for pack in CARD_PACKS.values()]
    return {"packs": packs}


@router.get("/cards")
async def list_cards() -> dict[str, Any]:
    """List all available cards (for debugging/reference)."""
    from app.game_engine.cards import make_debt_card
    registry = _get_card_registry()
    result = {cid: c.to_dict() for cid, c in registry.items()}
    # Include a representative Debt card for the card browser
    debt = make_debt_card()
    debt_dict = debt.to_dict()
    debt_dict["id"] = "debt"  # Stable ID for display
    result["debt"] = debt_dict
    return result


@router.get("/stats")
async def get_stats() -> dict[str, Any]:
    """Get aggregate game stats for the homepage widget."""
    if _analytics:
        stats = await _analytics.get_homepage_stats()
        return {"stats": stats}
    return {"stats": {}}


# ── Test Mode Endpoints ────────────────────────────────────────


class TestGiveCardRequest(BaseModel):
    player_id: str
    card_id: str


class TestSetStatsRequest(BaseModel):
    player_id: str
    vp: Optional[int] = None
    resources: Optional[int] = None
    actions: Optional[int] = None


@router.post("/games/{game_id}/test/give-card")
async def test_give_card(game_id: str, req: TestGiveCardRequest) -> dict[str, Any]:
    """Test mode: add a copy of any card from the registry to a player's hand."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    # Handle Debt card specially (not in registry — created dynamically)
    if req.card_id == "debt":
        from app.game_engine.cards import make_debt_card
        card = make_debt_card()
        card.id = f"test_debt_{len(player.hand)}"
    else:
        registry = _get_card_registry()
        template = registry.get(req.card_id)
        if not template:
            raise HTTPException(404, f"Card '{req.card_id}' not found in registry")

        # Create a copy with a unique ID
        import copy as _copy
        card = _copy.deepcopy(template)
        card.id = f"test_{req.card_id}_{len(player.hand)}"
    player.hand.append(card)
    game._log(f"[TEST] {player.name} receives {card.name}", actor=req.player_id)
    await _get_store().save(game)

    return {"message": f"Gave {card.name} to {player.name}", "state": game.to_dict()}


@router.post("/games/{game_id}/test/set-stats")
async def test_set_stats(game_id: str, req: TestSetStatsRequest) -> dict[str, Any]:
    """Test mode: set VP and/or resources for a player."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    changes = []
    if req.vp is not None:
        player.vp = req.vp
        changes.append(f"VP={req.vp}")
    if req.resources is not None:
        player.resources = req.resources
        changes.append(f"Resources={req.resources}")
    if req.actions is not None:
        player.actions_available = req.actions
        changes.append(f"Actions={req.actions}")

    if changes:
        game._log(f"[TEST] {player.name}: {', '.join(changes)}", actor=req.player_id)
    await _get_store().save(game)

    return {"message": f"Updated {player.name}: {', '.join(changes)}", "state": game.to_dict()}


class TestTrashCardRequest(BaseModel):
    player_id: str
    card_index: int


@router.post("/games/{game_id}/test/trash-card")
async def test_trash_card(game_id: str, req: TestTrashCardRequest) -> dict[str, Any]:
    """Test mode: trash (permanently remove) a card from a player's hand."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    if req.card_index < 0 or req.card_index >= len(player.hand):
        raise HTTPException(400, "Invalid card index")

    card = player.hand.pop(req.card_index)
    player.trash.append(card)
    game._log(f"[TEST] {player.name} trashes {card.name}", actor=req.player_id)
    await _get_store().save(game)

    return {"message": f"Trashed {card.name}", "state": game.to_dict()}


class TestDiscardCardRequest(BaseModel):
    player_id: str
    card_index: int


class TestPlayerRequest(BaseModel):
    player_id: str
    count: int = 1


@router.post("/games/{game_id}/test/discard-card")
async def test_discard_card(game_id: str, req: TestDiscardCardRequest) -> dict[str, Any]:
    """Test mode: discard a card from a player's hand to their discard pile."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    if req.card_index < 0 or req.card_index >= len(player.hand):
        raise HTTPException(400, "Invalid card index")

    card = player.hand.pop(req.card_index)
    player.deck.add_to_discard([card])
    game._log(f"[TEST] {player.name} discards {card.name}", actor=req.player_id)
    await _get_store().save(game)

    return {"message": f"Discarded {card.name}", "state": game.to_dict()}


@router.post("/games/{game_id}/test/draw-card")
async def test_draw_card(game_id: str, req: TestPlayerRequest) -> dict[str, Any]:
    """Test mode: draw a card from the player's draw pile into their hand."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    count = max(1, min(req.count, 20))  # clamp to 1-20
    drawn = player.deck.draw(count, game.rng)
    if drawn:
        player.hand.extend(drawn)
        names = ", ".join(c.name for c in drawn)
        game._log(f"[TEST] {player.name} draws {len(drawn)} card(s): {names}", actor=req.player_id)
        await _get_store().save(game)
        return {"message": f"Drew {len(drawn)} card(s)", "state": game.to_dict()}
    else:
        return {"message": "No cards to draw", "state": game.to_dict()}


@router.post("/games/{game_id}/test/discard-hand")
async def test_discard_hand(game_id: str, req: TestPlayerRequest) -> dict[str, Any]:
    """Test mode: discard all cards in the player's hand to their discard pile."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    count = len(player.hand)
    if count > 0:
        player.deck.add_to_discard(player.hand)
        game._log(f"[TEST] {player.name} discards entire hand ({count} cards)", actor=req.player_id)
        player.hand = []
    await _get_store().save(game)

    return {"message": f"Discarded {count} card(s)", "state": game.to_dict()}


class TestSetRoundRequest(BaseModel):
    round: int


@router.post("/games/{game_id}/test/set-round")
async def test_set_round(game_id: str, req: TestSetRoundRequest) -> dict[str, Any]:
    """Test mode: set the current round number."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")
    if req.round < 1:
        raise HTTPException(400, "Round must be at least 1")

    old_round = game.current_round
    game.current_round = req.round
    game._log(f"[TEST] Round set: {old_round} → {req.round}")
    await _get_store().save(game)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": f"Round set to {req.round}", "state": game.to_dict()}


class TestSetTileOwnerRequest(BaseModel):
    q: int
    r: int
    owner: str | None = None  # player_id or null to clear


@router.post("/games/{game_id}/test/set-tile-owner")
async def test_set_tile_owner(game_id: str, req: TestSetTileOwnerRequest) -> dict[str, Any]:
    """Test mode: cycle tile ownership (shift+click from frontend)."""
    game = await _get_store().get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")
    if not game.grid:
        raise HTTPException(400, "No grid")

    tile = game.grid.get_tile(req.q, req.r)
    if not tile:
        raise HTTPException(404, "Tile not found")
    if tile.is_blocked or tile.is_base:
        raise HTTPException(400, "Cannot change ownership of blocked or base tiles")

    old_owner = tile.owner
    tile.owner = req.owner
    tile.held_since_turn = game.current_round if req.owner else None
    if req.owner is None:
        tile.defense_power = tile.base_defense
        tile.permanent_defense_bonus = 0

    old_name = game.players[old_owner].name if old_owner and old_owner in game.players else "none"
    new_name = game.players[req.owner].name if req.owner and req.owner in game.players else "none"
    game._log(f"[TEST] Tile {req.q},{req.r} owner: {old_name} → {new_name}")
    await _get_store().save(game)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": f"Tile owner set", "state": game.to_dict()}


# ── Multiplayer: Leave / End Game ──────────────────────────


class LeaveGameRequest(BaseModel):
    player_id: str
    token: str


class EndGameRequest(BaseModel):
    player_id: str
    token: str


@router.post("/games/{game_id}/leave")
async def leave_game_route(game_id: str, req: LeaveGameRequest) -> dict[str, Any]:
    """Player leaves the game mid-play."""
    from app.api.lobby import handle_leave_game
    return await handle_leave_game(game_id, req.player_id, req.token)


@router.post("/games/{game_id}/end")
async def end_game_route(game_id: str, req: EndGameRequest) -> dict[str, Any]:
    """Host ends the game for all players."""
    from app.api.lobby import handle_end_game
    return await handle_end_game(game_id, req.player_id, req.token)


# ── Return to Lobby ───────────────────────────────────────


class ReturnToLobbyRequest(BaseModel):
    player_id: str
    token: str


@router.post("/games/{game_id}/return-to-lobby")
async def return_to_lobby_route(game_id: str, req: ReturnToLobbyRequest) -> dict[str, Any]:
    """Return a player to the lobby after a game ends."""
    from app.api.lobby import handle_return_to_lobby
    return await handle_return_to_lobby(game_id, req.player_id, req.token)
