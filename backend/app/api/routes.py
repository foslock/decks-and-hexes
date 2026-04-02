"""REST API routes for hot-seat play."""

from __future__ import annotations

import json
import pickle
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.data_loader.loader import load_all_cards
from app.game_engine.cards import Archetype
from app.game_engine.game_state import (
    GameState,
    buy_card,
    create_game,
    end_buy_phase,
    execute_start_of_turn,
    play_card,
    reroll_market,
    submit_plan,
)
from app.game_engine.hex_grid import GridSize


router = APIRouter(prefix="/api")

# In-memory game store for Phase 1 (will move to Postgres later)
_games: dict[str, GameState] = {}
_card_registry = None


def _get_card_registry() -> dict[str, Any]:
    global _card_registry
    if _card_registry is None:
        _card_registry = load_all_cards()
    return _card_registry


# ── Request/Response models ──────────────────────────────────


class CreateGameRequest(BaseModel):
    grid_size: str = "small"
    players: list[dict[str, Any]]
    seed: Optional[int] = None
    test_mode: bool = False


class PlayCardRequest(BaseModel):
    player_id: str
    card_index: int
    target_q: Optional[int] = None
    target_r: Optional[int] = None
    target_player_id: Optional[str] = None
    discard_card_indices: Optional[list[int]] = None
    trash_card_indices: Optional[list[int]] = None
    extra_targets: Optional[list[list[int]]] = None


class SubmitPlanRequest(BaseModel):
    player_id: str


class BuyCardRequest(BaseModel):
    player_id: str
    source: str  # "archetype", "neutral", "upgrade"
    card_id: Optional[str] = None


class RerollRequest(BaseModel):
    player_id: str


class EndBuyRequest(BaseModel):
    player_id: str


class EndTurnRequest(BaseModel):
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
        })

    game = create_game(grid_size, player_configs, registry, seed=req.seed, test_mode=req.test_mode)
    # Auto-execute start of turn for round 1
    execute_start_of_turn(game)
    _games[game.id] = game

    return {"game_id": game.id, "state": game.to_dict()}


@router.get("/games/{game_id}")
async def get_game(game_id: str, player_id: Optional[str] = None) -> dict[str, Any]:
    """Get current game state."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    return game.to_dict(for_player_id=player_id)


@router.post("/games/{game_id}/play")
async def play_card_route(game_id: str, req: PlayCardRequest) -> dict[str, Any]:
    """Play a card during Plan phase."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    extra_targets = None
    if req.extra_targets:
        extra_targets = [(t[0], t[1]) for t in req.extra_targets if len(t) >= 2]

    success, msg = play_card(
        game, req.player_id, req.card_index,
        req.target_q, req.target_r, req.target_player_id,
        discard_card_indices=req.discard_card_indices,
        trash_card_indices=req.trash_card_indices,
        extra_targets=extra_targets,
    )
    if not success:
        raise HTTPException(400, msg)

    return {"message": msg, "state": game.to_dict()}


@router.post("/games/{game_id}/submit-plan")
async def submit_plan_route(game_id: str, req: SubmitPlanRequest) -> dict[str, Any]:
    """Submit plan for a player."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = submit_plan(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    return {"message": msg, "state": game.to_dict()}


@router.post("/games/{game_id}/buy")
async def buy_card_route(game_id: str, req: BuyCardRequest) -> dict[str, Any]:
    """Buy a card during Buy phase."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = buy_card(game, req.player_id, req.source, req.card_id or "")
    if not success:
        raise HTTPException(400, msg)

    return {"message": msg, "state": game.to_dict()}


@router.post("/games/{game_id}/reroll")
async def reroll_route(game_id: str, req: RerollRequest) -> dict[str, Any]:
    """Re-roll archetype market."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = reroll_market(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    return {"message": msg, "state": game.to_dict()}


@router.post("/games/{game_id}/end-buy")
async def end_buy_route(game_id: str, req: EndBuyRequest) -> dict[str, Any]:
    """End buy phase for a player."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = end_buy_phase(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    return {"message": msg, "state": game.to_dict()}


@router.post("/games/{game_id}/end-turn")
async def end_turn_route(game_id: str, req: EndTurnRequest) -> dict[str, Any]:
    """End the current turn for a player (delegates to end_buy_phase)."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = end_buy_phase(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    return {"message": msg, "state": game.to_dict()}


@router.get("/games/{game_id}/log")
async def get_game_log(game_id: str, player_id: Optional[str] = None) -> dict[str, Any]:
    """Get the full game log, filtered by player visibility."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    if player_id:
        entries = game.get_log_for_player(player_id)
    else:
        entries = game.get_full_log()

    return {"game_id": game_id, "entries": entries}


@router.get("/cards")
async def list_cards() -> dict[str, Any]:
    """List all available cards (for debugging/reference)."""
    registry = _get_card_registry()
    return {cid: c.to_dict() for cid, c in registry.items()}


# ── Test Mode Endpoints ────────────────────────────────────────


class TestGiveCardRequest(BaseModel):
    player_id: str
    card_id: str


class TestSetStatsRequest(BaseModel):
    player_id: str
    vp: Optional[int] = None
    resources: Optional[int] = None


@router.post("/games/{game_id}/test/give-card")
async def test_give_card(game_id: str, req: TestGiveCardRequest) -> dict[str, Any]:
    """Test mode: add a copy of any card from the registry to a player's hand."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

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

    return {"message": f"Gave {card.name} to {player.name}", "state": game.to_dict()}


@router.post("/games/{game_id}/test/set-stats")
async def test_set_stats(game_id: str, req: TestSetStatsRequest) -> dict[str, Any]:
    """Test mode: set VP and/or resources for a player."""
    game = _games.get(game_id)
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

    if changes:
        game._log(f"[TEST] {player.name}: {', '.join(changes)}", actor=req.player_id)

    return {"message": f"Updated {player.name}: {', '.join(changes)}", "state": game.to_dict()}
