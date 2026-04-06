"""REST API routes for hot-seat and multiplayer play."""

from __future__ import annotations

import json
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
    auto_play_cpu_plans,
    buy_card,
    create_game,
    end_buy_phase,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    reroll_market,
    spend_upgrade_credit,
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


class SubmitPlanRequest(BaseModel):
    player_id: str


class BuyCardRequest(BaseModel):
    player_id: str
    source: str  # "archetype", "neutral", "upgrade"
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
    _games[game.id] = game

    return {"game_id": game.id, "state": game.to_dict()}


@router.get("/games/{game_id}")
async def get_game(game_id: str, player_id: Optional[str] = None) -> dict[str, Any]:
    """Get current game state."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if player_id and _is_multiplayer(game):
        visible = get_visible_player_ids(game.id, player_id)
        return game.to_dict(for_player_id=player_id, visible_player_ids=visible)
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

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/submit-plan")
async def submit_plan_route(game_id: str, req: SubmitPlanRequest) -> dict[str, Any]:
    """Submit plan for a player."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = submit_plan(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    # Auto-play CPU plans if any CPU players haven't submitted yet
    if any(p.is_cpu and not p.has_submitted_plan for p in game.players.values()):
        auto_play_cpu_plans(game)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/advance-resolve")
async def advance_resolve_route(game_id: str, req: AdvanceResolveRequest) -> dict[str, Any]:
    """Player acknowledges resolve phase (animations done), advance to buy."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = advance_resolve(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/buy")
async def buy_card_route(game_id: str, req: BuyCardRequest) -> dict[str, Any]:
    """Buy a card during Buy phase."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = buy_card(game, req.player_id, req.source, req.card_id or "")
    if not success:
        raise HTTPException(400, msg)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/upgrade-card")
async def upgrade_card_route(game_id: str, req: UpgradeCardRequest) -> dict[str, Any]:
    """Spend an upgrade credit to upgrade a card in hand during Plan phase."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = spend_upgrade_credit(game, req.player_id, req.card_index)
    if not success:
        raise HTTPException(400, msg)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/reroll")
async def reroll_route(game_id: str, req: RerollRequest) -> dict[str, Any]:
    """Re-roll archetype market."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = reroll_market(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/end-buy")
async def end_buy_route(game_id: str, req: EndBuyRequest) -> dict[str, Any]:
    """End buy phase for a player."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = end_buy_phase(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


@router.post("/games/{game_id}/process-cpu-buys")
async def process_cpu_buys_route(game_id: str) -> dict[str, Any]:
    """Process consecutive CPU buyers during the buy phase.

    Called by the frontend after a brief delay so the user can see
    the 'Buying...' indicator on CPU players before their purchases appear.
    """
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    if game.current_phase != Phase.BUY:
        raise HTTPException(400, f"Not in Buy phase (current: {game.current_phase.value})")

    # Check that the current buyer is actually a CPU
    pid = game.player_order[game.current_buyer_index]
    player = game.players[pid]
    if not player.is_cpu:
        raise HTTPException(400, "Current buyer is not a CPU player")

    auto_play_cpu_buys(game)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": "CPU buys processed", "state": game.to_dict()}


@router.post("/games/{game_id}/advance-upkeep")
async def advance_upkeep_route(game_id: str) -> dict[str, Any]:
    """Advance past the Upkeep phase to Plan phase."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    if game.current_phase != Phase.UPKEEP:
        raise HTTPException(400, f"Not in Upkeep phase (current: {game.current_phase.value})")

    execute_upkeep(game)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": "Upkeep complete", "state": game.to_dict()}


@router.post("/games/{game_id}/end-turn")
async def end_turn_route(game_id: str, req: EndTurnRequest) -> dict[str, Any]:
    """End the current turn for a player (delegates to end_buy_phase)."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    success, msg = end_buy_phase(game, req.player_id)
    if not success:
        raise HTTPException(400, msg)

    if _is_multiplayer(game):
        await _broadcast_state(game_id, game)

    return {"message": msg, "state": _game_state_for_player(game, req.player_id)}


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


@router.get("/card-packs")
async def list_card_packs() -> dict[str, Any]:
    """List all available card packs with their metadata."""
    return {"packs": [pack.to_dict() for pack in CARD_PACKS.values()]}


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


class TestTrashCardRequest(BaseModel):
    player_id: str
    card_index: int


@router.post("/games/{game_id}/test/trash-card")
async def test_trash_card(game_id: str, req: TestTrashCardRequest) -> dict[str, Any]:
    """Test mode: trash (permanently remove) a card from a player's hand."""
    game = _games.get(game_id)
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

    return {"message": f"Trashed {card.name}", "state": game.to_dict()}


class TestDiscardCardRequest(BaseModel):
    player_id: str
    card_index: int


class TestPlayerRequest(BaseModel):
    player_id: str


@router.post("/games/{game_id}/test/discard-card")
async def test_discard_card(game_id: str, req: TestDiscardCardRequest) -> dict[str, Any]:
    """Test mode: discard a card from a player's hand to their discard pile."""
    game = _games.get(game_id)
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

    return {"message": f"Discarded {card.name}", "state": game.to_dict()}


@router.post("/games/{game_id}/test/draw-card")
async def test_draw_card(game_id: str, req: TestPlayerRequest) -> dict[str, Any]:
    """Test mode: draw a card from the player's draw pile into their hand."""
    game = _games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")
    if not game.test_mode:
        raise HTTPException(403, "Test mode is not enabled")

    player = game.players.get(req.player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    drawn = player.deck.draw(1, game.rng)
    if drawn:
        player.hand.extend(drawn)
        game._log(f"[TEST] {player.name} draws {drawn[0].name}", actor=req.player_id)
        return {"message": f"Drew {drawn[0].name}", "state": game.to_dict()}
    else:
        return {"message": "No cards to draw", "state": game.to_dict()}


@router.post("/games/{game_id}/test/discard-hand")
async def test_discard_hand(game_id: str, req: TestPlayerRequest) -> dict[str, Any]:
    """Test mode: discard all cards in the player's hand to their discard pile."""
    game = _games.get(game_id)
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

    return {"message": f"Discarded {count} card(s)", "state": game.to_dict()}


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
