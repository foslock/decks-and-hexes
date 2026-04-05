"""Lobby system for real-time multiplayer games."""

from __future__ import annotations

import asyncio
import logging
import random
import string
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.api.ws_manager import manager
from app.data_loader.loader import load_all_cards
from app.game_engine.cards import Archetype
from app.game_engine.game_state import (
    GameState,
    create_game,
    execute_start_of_turn,
)
from app.game_engine.hex_grid import GridSize

logger = logging.getLogger(__name__)

# ── Data structures ─────────────────────────────────────────

# Unambiguous characters for join codes (no 0/O, 1/I/L)
_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_CODE_LENGTH = 4
_LOBBY_EXPIRY_SECONDS = 900  # 15 minutes of inactivity
_LOBBY_CHECK_INTERVAL = 60   # Check for expired lobbies every 60s


@dataclass
class LobbyPlayer:
    id: str
    name: str
    archetype: str
    is_cpu: bool = False
    cpu_noise: float = 0.15
    is_host: bool = False
    is_local: bool = False  # local human player (controlled by host's browser)
    token: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "archetype": self.archetype,
            "is_cpu": self.is_cpu,
            "is_host": self.is_host,
            "is_local": self.is_local,
            "cpu_difficulty": (
                "easy" if self.cpu_noise >= 0.25 else
                "medium" if self.cpu_noise >= 0.10 else
                "hard"
            ) if self.is_cpu else None,
        }


@dataclass
class LobbyConfig:
    grid_size: str = "small"
    speed: str = "normal"
    max_players: int = 3
    test_mode: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "grid_size": self.grid_size,
            "speed": self.speed,
            "max_players": self.max_players,
            "test_mode": self.test_mode,
        }


@dataclass
class Lobby:
    code: str
    host_id: str
    players: dict[str, LobbyPlayer] = field(default_factory=dict)
    config: LobbyConfig = field(default_factory=LobbyConfig)
    created_at: float = 0.0
    last_activity: float = 0.0
    game_id: Optional[str] = None
    status: str = "waiting"  # waiting | countdown | started | expired

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "host_id": self.host_id,
            "players": {pid: p.to_dict() for pid, p in self.players.items()},
            "config": self.config.to_dict(),
            "status": self.status,
            "game_id": self.game_id,
        }

    def touch(self) -> None:
        self.last_activity = time.time()


# ── Storage ────────────────────────────────────────────────

_lobbies: dict[str, Lobby] = {}     # code → Lobby
_tokens: dict[str, str] = {}        # player_id → token
_game_to_lobby: dict[str, str] = {} # game_id → lobby code (for auth lookups)
_replay_votes: dict[str, set[str]] = {}   # game_id → set of player_ids who voted
_replay_disabled: dict[str, bool] = {}    # game_id → True if someone exited

# Reference to the games dict from routes.py (set by init_lobby_games_ref)
_games_ref: dict[str, GameState] | None = None
_card_registry_ref: Any = None


def init_lobby(games: dict[str, GameState], get_registry: Any) -> None:
    """Initialize lobby module with references to shared game storage."""
    global _games_ref, _card_registry_ref
    _games_ref = games
    _card_registry_ref = get_registry


def _get_games() -> dict[str, GameState]:
    if _games_ref is None:
        raise RuntimeError("Lobby not initialized — call init_lobby first")
    return _games_ref


def _get_registry() -> dict[str, Any]:
    if _card_registry_ref is None:
        raise RuntimeError("Lobby not initialized — call init_lobby first")
    return _card_registry_ref()


def get_lobby_for_game(game_id: str) -> Optional[Lobby]:
    """Look up the lobby associated with a game (if any)."""
    code = _game_to_lobby.get(game_id)
    return _lobbies.get(code) if code else None


def validate_token(player_id: str, token: str) -> bool:
    """Check if a player_id/token pair is valid."""
    return _tokens.get(player_id) == token


def get_visible_player_ids(game_id: str, player_id: str) -> set[str] | None:
    """Get the set of player IDs whose hands should be visible to the given player.

    Returns None if no lobby is associated (legacy hotseat — show all hands).
    For the host, returns host + all local players.
    For remote players, returns just their own ID.
    """
    lobby = get_lobby_for_game(game_id)
    if not lobby:
        return None  # No lobby — hotseat/legacy, show all

    # Host sees self + all local players
    if player_id == lobby.host_id:
        visible = {player_id}
        for pid, p in lobby.players.items():
            if p.is_local:
                visible.add(pid)
        return visible

    # Remote player sees only self
    return {player_id}


def _generate_code() -> str:
    """Generate a unique 4-character lobby code."""
    for _ in range(100):
        code = "".join(random.choices(_CODE_CHARS, k=_CODE_LENGTH))
        if code not in _lobbies:
            return code
    raise RuntimeError("Failed to generate unique lobby code")


# ── Router ────────────────────────────────────────────────

lobby_router = APIRouter(prefix="/api/lobby")


def _require_token(player_id: str, token: str) -> None:
    if not validate_token(player_id, token):
        raise HTTPException(403, "Invalid token")


def _require_lobby(code: str) -> Lobby:
    lobby = _lobbies.get(code.upper())
    if not lobby or lobby.status == "expired":
        raise HTTPException(404, "Lobby not found or expired")
    return lobby


# ── Request models ─────────────────────────────────────────

class CreateLobbyRequest(BaseModel):
    name: str
    archetype: str


class JoinLobbyRequest(BaseModel):
    name: str
    archetype: str


class UpdateConfigRequest(BaseModel):
    grid_size: Optional[str] = None
    speed: Optional[str] = None
    max_players: Optional[int] = None
    test_mode: Optional[bool] = None


class UpdatePlayerRequest(BaseModel):
    name: Optional[str] = None
    archetype: Optional[str] = None
    token: str


class AddCpuRequest(BaseModel):
    archetype: str
    difficulty: str = "medium"
    token: str


class RemovePlayerRequest(BaseModel):
    token: str


class AddLocalPlayerRequest(BaseModel):
    name: str
    archetype: str
    token: str


class CloseLobbyRequest(BaseModel):
    token: str


class StartLobbyRequest(BaseModel):
    token: str


# ── Endpoints ────────────────────────────────────────────────


@lobby_router.post("/create")
async def create_lobby(req: CreateLobbyRequest) -> dict[str, Any]:
    """Create a new lobby. Returns lobby code and host credentials."""
    try:
        Archetype(req.archetype)
    except ValueError:
        raise HTTPException(400, f"Invalid archetype: {req.archetype}")

    code = _generate_code()
    player_id = f"player_0"
    token = str(uuid.uuid4())

    host = LobbyPlayer(
        id=player_id,
        name=req.name,
        archetype=req.archetype,
        is_host=True,
        token=token,
    )

    now = time.time()
    lobby = Lobby(
        code=code,
        host_id=player_id,
        players={player_id: host},
        created_at=now,
        last_activity=now,
    )
    _lobbies[code] = lobby
    _tokens[player_id] = token

    return {
        "code": code,
        "player_id": player_id,
        "token": token,
        "lobby": lobby.to_dict(),
    }


@lobby_router.post("/{code}/join")
async def join_lobby(code: str, req: JoinLobbyRequest) -> dict[str, Any]:
    """Join an existing lobby."""
    lobby = _require_lobby(code)

    if lobby.status != "waiting":
        raise HTTPException(400, "Lobby is not accepting players")

    try:
        Archetype(req.archetype)
    except ValueError:
        raise HTTPException(400, f"Invalid archetype: {req.archetype}")

    # Count current human players
    human_count = sum(1 for p in lobby.players.values() if not p.is_cpu)
    total_count = len(lobby.players)
    if total_count >= 6:
        raise HTTPException(400, "Lobby is full (max 6 players)")
    if human_count >= lobby.config.max_players:
        raise HTTPException(400, "Lobby is full")

    # Assign next player_id
    existing_ids = {int(p.id.split("_")[1]) for p in lobby.players.values() if p.id.startswith("player_")}
    next_idx = 0
    while next_idx in existing_ids:
        next_idx += 1
    player_id = f"player_{next_idx}"
    token = str(uuid.uuid4())

    player = LobbyPlayer(
        id=player_id,
        name=req.name,
        archetype=req.archetype,
        token=token,
    )
    lobby.players[player_id] = player
    lobby.touch()
    _tokens[player_id] = token

    # Broadcast update to existing members
    await manager.broadcast_lobby(code, lobby.to_dict())

    return {
        "player_id": player_id,
        "token": token,
        "lobby": lobby.to_dict(),
    }


@lobby_router.get("/{code}")
async def get_lobby(code: str, player_id: str, token: str) -> dict[str, Any]:
    """Get current lobby state."""
    lobby = _require_lobby(code)
    _require_token(player_id, token)

    if player_id not in lobby.players:
        raise HTTPException(403, "Not a member of this lobby")

    return {"lobby": lobby.to_dict()}


@lobby_router.patch("/{code}/config")
async def update_config(code: str, req: UpdateConfigRequest) -> dict[str, Any]:
    """Update lobby config (host only)."""
    lobby = _require_lobby(code)

    # Find who's making the request from the token
    host = lobby.players.get(lobby.host_id)
    if not host or not validate_token(lobby.host_id, req.token if hasattr(req, 'token') else ""):
        # Check token in header or body — we'll require it in the request
        pass

    # Validate and apply changes
    if req.grid_size is not None:
        try:
            GridSize(req.grid_size)
        except ValueError:
            raise HTTPException(400, f"Invalid grid size: {req.grid_size}")
        lobby.config.grid_size = req.grid_size

    if req.speed is not None:
        if req.speed not in ("fast", "normal", "slow"):
            raise HTTPException(400, f"Invalid speed: {req.speed}")
        lobby.config.speed = req.speed

    if req.max_players is not None:
        if not 2 <= req.max_players <= 6:
            raise HTTPException(400, "max_players must be 2-6")
        lobby.config.max_players = req.max_players

    if req.test_mode is not None:
        lobby.config.test_mode = req.test_mode

    lobby.touch()
    await manager.broadcast_lobby(code, lobby.to_dict())

    return {"lobby": lobby.to_dict()}


@lobby_router.patch("/{code}/player/{player_id}")
async def update_player(code: str, player_id: str, req: UpdatePlayerRequest) -> dict[str, Any]:
    """Update a player's name/archetype (self, or host editing local/CPU players)."""
    lobby = _require_lobby(code)

    # Allow self-edit OR host editing local/CPU players
    is_self = validate_token(player_id, req.token)
    is_host = validate_token(lobby.host_id, req.token)
    player = lobby.players.get(player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    if not is_self and not (is_host and (player.is_local or player.is_cpu)):
        raise HTTPException(403, "Not authorized to edit this player")

    if req.name is not None:
        player.name = req.name
    if req.archetype is not None:
        try:
            Archetype(req.archetype)
        except ValueError:
            raise HTTPException(400, f"Invalid archetype: {req.archetype}")
        player.archetype = req.archetype

    lobby.touch()
    await manager.broadcast_lobby(code, lobby.to_dict())

    return {"lobby": lobby.to_dict()}


@lobby_router.post("/{code}/cpu")
async def add_cpu(code: str, req: AddCpuRequest) -> dict[str, Any]:
    """Add a CPU player to the lobby (host only)."""
    lobby = _require_lobby(code)
    _require_token(lobby.host_id, req.token)

    try:
        Archetype(req.archetype)
    except ValueError:
        raise HTTPException(400, f"Invalid archetype: {req.archetype}")

    if len(lobby.players) >= 6:
        raise HTTPException(400, "Lobby is full (max 6 players)")

    noise_map = {"easy": 0.30, "medium": 0.15, "hard": 0.05}
    noise = noise_map.get(req.difficulty, 0.15)

    # Assign next player_id
    existing_ids = {int(p.id.split("_")[1]) for p in lobby.players.values() if p.id.startswith("player_")}
    next_idx = 0
    while next_idx in existing_ids:
        next_idx += 1
    player_id = f"player_{next_idx}"

    archetype_names = {"vanguard": "Vanguard", "swarm": "Swarm", "fortress": "Fortress"}
    cpu = LobbyPlayer(
        id=player_id,
        name=f"CPU {archetype_names.get(req.archetype, req.archetype)}",
        archetype=req.archetype,
        is_cpu=True,
        cpu_noise=noise,
    )
    lobby.players[player_id] = cpu
    lobby.touch()
    await manager.broadcast_lobby(code, lobby.to_dict())

    return {"lobby": lobby.to_dict()}


@lobby_router.post("/{code}/local-player")
async def add_local_player(code: str, req: AddLocalPlayerRequest) -> dict[str, Any]:
    """Add a local human player to the lobby (host only). Controlled by host's browser."""
    lobby = _require_lobby(code)
    _require_token(lobby.host_id, req.token)

    try:
        Archetype(req.archetype)
    except ValueError:
        raise HTTPException(400, f"Invalid archetype: {req.archetype}")

    if len(lobby.players) >= 6:
        raise HTTPException(400, "Lobby is full (max 6 players)")

    # Assign next player_id
    existing_ids = {int(p.id.split("_")[1]) for p in lobby.players.values() if p.id.startswith("player_")}
    next_idx = 0
    while next_idx in existing_ids:
        next_idx += 1
    player_id = f"player_{next_idx}"

    local_player = LobbyPlayer(
        id=player_id,
        name=req.name,
        archetype=req.archetype,
        is_local=True,
    )
    lobby.players[player_id] = local_player
    lobby.touch()
    await manager.broadcast_lobby(code, lobby.to_dict())

    return {"lobby": lobby.to_dict()}


@lobby_router.delete("/{code}/player/{target_player_id}")
async def remove_player(code: str, target_player_id: str, req: RemovePlayerRequest) -> dict[str, Any]:
    """Remove a player from the lobby (host kicks, or self leaves)."""
    lobby = _require_lobby(code)

    # Either host removing someone, or player removing themselves
    is_host = validate_token(lobby.host_id, req.token)
    is_self = validate_token(target_player_id, req.token)

    if not is_host and not is_self:
        raise HTTPException(403, "Not authorized to remove this player")

    player = lobby.players.get(target_player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    if player.is_host:
        raise HTTPException(400, "Host cannot be removed — use end game instead")

    del lobby.players[target_player_id]
    _tokens.pop(target_player_id, None)
    lobby.touch()

    await manager.broadcast_lobby(code, lobby.to_dict())
    # Disconnect the removed player's WebSocket
    manager.disconnect(code, target_player_id)

    return {"lobby": lobby.to_dict()}


@lobby_router.post("/{code}/close")
async def close_lobby(code: str, req: CloseLobbyRequest) -> dict[str, Any]:
    """Close/delete a lobby (host only). Disconnects all players."""
    lobby = _require_lobby(code)
    _require_token(lobby.host_id, req.token)

    # Broadcast a lobby_closed message so other clients return to home
    await manager.broadcast(code, {"type": "lobby_closed"})

    # Clean up all tokens and connections
    for pid in list(lobby.players):
        _tokens.pop(pid, None)
        manager.disconnect(code, pid)

    # Remove the lobby
    _lobbies.pop(code, None)

    return {"ok": True}


@lobby_router.post("/{code}/start")
async def start_lobby(code: str, req: StartLobbyRequest) -> dict[str, Any]:
    """Start the game from the lobby (host only). Triggers countdown then creates game."""
    lobby = _require_lobby(code)
    _require_token(lobby.host_id, req.token)

    if lobby.status != "waiting":
        raise HTTPException(400, "Lobby already started or expired")

    human_count = sum(1 for p in lobby.players.values() if not p.is_cpu)
    if len(lobby.players) < 2:
        raise HTTPException(400, "Need at least 2 players to start")

    # Send countdown to all connected players
    lobby.status = "countdown"
    for seconds in [3, 2, 1]:
        await manager.broadcast(code, {"type": "countdown", "seconds_remaining": seconds})
        await asyncio.sleep(1)

    # Create the game from lobby config
    registry = _get_registry()
    player_configs = []
    for pid, p in lobby.players.items():
        player_configs.append({
            "id": pid,
            "name": p.name,
            "archetype": p.archetype,
            "is_cpu": p.is_cpu,
            "cpu_noise": p.cpu_noise,
        })

    try:
        grid_size = GridSize(lobby.config.grid_size)
    except ValueError:
        raise HTTPException(400, f"Invalid grid size: {lobby.config.grid_size}")

    game = create_game(
        grid_size, player_configs, registry,
        test_mode=lobby.config.test_mode,
        speed=lobby.config.speed,
    )
    game.host_id = lobby.host_id
    game.lobby_code = code
    execute_start_of_turn(game)

    games = _get_games()
    games[game.id] = game
    lobby.game_id = game.id
    lobby.status = "started"
    _game_to_lobby[game.id] = code

    # Migrate WebSocket connections from lobby code to game ID
    manager.migrate_group(code, game.id)

    # Send game_start to each player with their per-player view
    group = manager.connections.get(game.id, {})
    for pid, ws in list(group.items()):
        try:
            visible = get_visible_player_ids(game.id, pid)
            state = game.to_dict(for_player_id=pid, visible_player_ids=visible)
            await ws.send_json({"type": "game_start", "game_id": game.id, "state": state})
        except Exception:
            manager.disconnect(game.id, pid)

    # Host response: include hands for host + all local players
    host_visible = get_visible_player_ids(game.id, lobby.host_id)
    return {
        "game_id": game.id,
        "state": game.to_dict(for_player_id=lobby.host_id, visible_player_ids=host_visible),
    }


# ── WebSocket endpoint ─────────────────────────────────────


@lobby_router.websocket("/ws/{code}")
async def lobby_websocket(ws: WebSocket, code: str, player_id: str, token: str) -> None:
    """WebSocket connection for real-time lobby and game updates."""
    # Validate
    if not validate_token(player_id, token):
        await ws.close(code=4003, reason="Invalid token")
        return

    lobby = _lobbies.get(code.upper())
    if not lobby:
        # Maybe this code maps to a game already — check if player is reconnecting
        await ws.close(code=4004, reason="Lobby not found")
        return

    if player_id not in lobby.players:
        await ws.close(code=4003, reason="Not a member of this lobby")
        return

    # If game already started, connect to the game group instead
    group_id = lobby.game_id if lobby.game_id else code
    await manager.connect(group_id, player_id, ws)

    try:
        # Send initial state
        if lobby.game_id:
            games = _get_games()
            game = games.get(lobby.game_id)
            if game:
                visible = get_visible_player_ids(game.id, player_id)
                state = game.to_dict(for_player_id=player_id, visible_player_ids=visible)
                await ws.send_json({"type": "game_state", "state": state})
        else:
            await ws.send_json({"type": "lobby_update", "lobby": lobby.to_dict()})

        # Keep connection alive — just read and discard client messages
        while True:
            await ws.receive_text()
            lobby.touch()
    except WebSocketDisconnect:
        manager.disconnect(group_id, player_id)
    except Exception:
        manager.disconnect(group_id, player_id)


# ── Leave / End Game ──────────────────────────────────────


class LeaveGameRequest(BaseModel):
    player_id: str
    token: str


class EndGameRequest(BaseModel):
    player_id: str
    token: str


# These are registered on the main game router, not lobby_router
# but defined here for organization. They'll be included via routes.py.


async def handle_leave_game(game_id: str, player_id: str, token: str) -> dict[str, Any]:
    """Handle a player leaving a game mid-play."""
    _require_token(player_id, token)
    games = _get_games()
    game = games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    player = game.players.get(player_id)
    if not player:
        raise HTTPException(404, "Player not found")

    # Neutralize all tiles owned by this player
    if game.grid:
        for tile in game.grid.tiles.values():
            if tile.owner == player_id:
                tile.owner = None
                tile.defense_power = 0
                tile.base_defense = 0
                tile.held_since_turn = None

    # Remove their planned actions
    player.planned_actions = []
    player.has_submitted_plan = True
    player.has_ended_turn = True
    player.is_cpu = True  # Mark as effectively CPU so they're skipped
    player.cpu_noise = 0.0
    game._log(f"{player.name} has left the game.")

    # Check if this unblocks phase advancement
    from app.game_engine.game_state import (
        Phase,
        _transition_to_buy,
        auto_play_cpu_buys,
        auto_play_cpu_plans,
        execute_reveal,
        submit_plan,
        end_buy_phase,
    )

    player.has_acknowledged_resolve = True  # pre-set in case we're in reveal

    if game.current_phase == Phase.PLAN:
        if all(p.has_submitted_plan for p in game.players.values()):
            execute_reveal(game)
            # Also auto-advance through resolve since leaving player is now CPU
            if all(p.has_acknowledged_resolve or p.is_cpu for p in game.players.values()):
                _transition_to_buy(game)
    elif game.current_phase == Phase.REVEAL:
        if all(p.has_acknowledged_resolve or p.is_cpu for p in game.players.values()):
            _transition_to_buy(game)
    elif game.current_phase == Phase.BUY:
        if all(p.has_ended_turn for p in game.players.values()):
            end_buy_phase(game, player_id)  # no-op, but triggers advance

    # Broadcast updated state
    await manager.broadcast_game_state(game_id, game, get_visible_ids=get_visible_player_ids)
    # Disconnect the player's WebSocket
    manager.disconnect(game_id, player_id)
    await manager.broadcast(game_id, {"type": "player_left", "player_id": player_id, "name": player.name})

    return {"message": f"{player.name} left the game", "state": game.to_dict()}


async def handle_end_game(game_id: str, player_id: str, token: str) -> dict[str, Any]:
    """Host ends the game for everyone."""
    _require_token(player_id, token)
    games = _get_games()
    game = games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    # Verify caller is host
    if not hasattr(game, 'host_id') or game.host_id != player_id:
        raise HTTPException(403, "Only the host can end the game")

    # Broadcast game_ended to all players
    await manager.broadcast(game_id, {"type": "game_ended"})

    # Close all connections and clean up
    for ws in manager.close_group(game_id):
        try:
            await ws.close()
        except Exception:
            pass

    # Clean up game and lobby
    lobby_code = _game_to_lobby.pop(game_id, None)
    if lobby_code:
        lobby = _lobbies.pop(lobby_code, None)
        if lobby:
            for pid in lobby.players:
                _tokens.pop(pid, None)
    games.pop(game_id, None)

    return {"message": "Game ended"}


# ── Replay Voting ────────────────────────────────────────


async def handle_replay_vote(game_id: str, player_id: str, token: str) -> dict[str, Any]:
    """Handle a player voting to replay."""
    _require_token(player_id, token)
    games = _get_games()
    game = games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    if _replay_disabled.get(game_id):
        raise HTTPException(400, "Replay has been disabled")

    # Add vote
    votes = _replay_votes.setdefault(game_id, set())
    votes.add(player_id)

    # Count human players
    human_ids = [pid for pid, p in game.players.items() if not p.is_cpu]
    all_voted = all(pid in votes for pid in human_ids)

    if all_voted:
        # Everyone voted — restart the game
        return await _restart_game(game_id, game)

    # Broadcast vote update to all players
    await manager.broadcast(game_id, {
        "type": "replay_vote",
        "votes": list(votes),
        "total_humans": len(human_ids),
    })

    return {"message": f"Vote recorded ({len(votes)}/{len(human_ids)})", "votes": list(votes)}


async def handle_replay_exit(game_id: str, player_id: str, token: str) -> dict[str, Any]:
    """Handle a player exiting, which disables replay for everyone."""
    _require_token(player_id, token)
    games = _get_games()
    game = games.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    _replay_disabled[game_id] = True

    # Broadcast that replay is disabled
    await manager.broadcast(game_id, {
        "type": "replay_disabled",
        "player_id": player_id,
    })

    return {"message": "Replay disabled"}


async def _restart_game(game_id: str, old_game: GameState) -> dict[str, Any]:
    """Create a new game with the same players and settings, then redirect everyone."""
    lobby = get_lobby_for_game(game_id)
    if not lobby:
        raise HTTPException(400, "Cannot restart — no lobby associated")

    # Reset lobby status so we can start again
    lobby.status = "waiting"
    lobby.game_id = None

    # Clean up old game replay state
    _replay_votes.pop(game_id, None)
    _replay_disabled.pop(game_id, None)

    # Migrate connections back from game to lobby
    manager.migrate_group(game_id, lobby.code)

    # Clean up old game
    games = _get_games()
    old_lobby_code = _game_to_lobby.pop(game_id, None)
    games.pop(game_id, None)

    # Create new game using the lobby (reuse start_lobby logic)
    registry = _get_registry()
    player_configs = []
    for pid, p in lobby.players.items():
        player_configs.append({
            "id": pid,
            "name": p.name,
            "archetype": p.archetype,
            "is_cpu": p.is_cpu,
            "cpu_noise": p.cpu_noise,
        })

    try:
        grid_size = GridSize(lobby.config.grid_size)
    except ValueError:
        raise HTTPException(400, f"Invalid grid size: {lobby.config.grid_size}")

    game = create_game(
        grid_size, player_configs, registry,
        test_mode=lobby.config.test_mode,
        speed=lobby.config.speed,
    )
    game.host_id = lobby.host_id
    game.lobby_code = lobby.code
    execute_start_of_turn(game)

    games[game.id] = game
    lobby.game_id = game.id
    lobby.status = "started"
    _game_to_lobby[game.id] = lobby.code

    # Migrate connections from lobby back to new game
    manager.migrate_group(lobby.code, game.id)

    # Broadcast game_start to each player
    group = manager.connections.get(game.id, {})
    for pid, ws in list(group.items()):
        try:
            visible = get_visible_player_ids(game.id, pid)
            state = game.to_dict(for_player_id=pid, visible_player_ids=visible)
            await ws.send_json({"type": "game_start", "game_id": game.id, "state": state})
        except Exception:
            manager.disconnect(game.id, pid)

    host_visible = get_visible_player_ids(game.id, lobby.host_id)
    return {
        "message": "Game restarted",
        "game_id": game.id,
        "state": game.to_dict(for_player_id=lobby.host_id, visible_player_ids=host_visible),
    }


# ── Lobby expiry background task ──────────────────────────


async def lobby_expiry_task() -> None:
    """Background task that removes expired lobbies every 60 seconds."""
    while True:
        await asyncio.sleep(_LOBBY_CHECK_INTERVAL)
        now = time.time()
        expired_codes = [
            code for code, lobby in _lobbies.items()
            if lobby.status == "waiting" and now - lobby.last_activity > _LOBBY_EXPIRY_SECONDS
        ]
        for code in expired_codes:
            lobby = _lobbies.pop(code, None)
            if lobby:
                lobby.status = "expired"
                await manager.broadcast(code, {"type": "error", "message": "Lobby expired due to inactivity"})
                for ws in manager.close_group(code):
                    try:
                        await ws.close()
                    except Exception:
                        pass
                for pid in lobby.players:
                    _tokens.pop(pid, None)
                logger.info("Expired lobby %s", code)
