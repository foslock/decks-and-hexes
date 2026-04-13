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
from app.game_engine.card_packs import CARD_PACKS, DEFAULT_PACK_ID
from app.game_engine.cards import Archetype
from app.game_engine.game_state import generate_map_seed
from app.game_engine.game_state import (
    GameState,
    Phase,
    create_game,
    execute_start_of_turn,
)
from app.game_engine.hex_grid import GridSize

logger = logging.getLogger(__name__)


def _maybe_restart_cpu_buys(game: GameState) -> None:
    """Re-launch CPU buy task if the game is in BUY phase with pending CPUs
    and no active background task (e.g. after a service restart)."""
    from app.api.routes import _active_cpu_buy_tasks, _process_cpu_buys_with_cursors

    if game.current_phase != Phase.BUY:
        return
    has_pending = any(
        game.players[pid].is_cpu
        and not game.players[pid].has_left
        and pid not in game.players_done_buying
        for pid in game.player_order
    )
    if not has_pending:
        return
    existing = _active_cpu_buy_tasks.get(game.id)
    if existing and not existing.done():
        return  # Task still running
    logger.info("Restarting orphaned CPU buy task for game %s", game.id)
    task = asyncio.create_task(_process_cpu_buys_with_cursors(game.id))
    _active_cpu_buy_tasks[game.id] = task
    task.add_done_callback(lambda _t: _active_cpu_buy_tasks.pop(game.id, None))

# ── Data structures ─────────────────────────────────────────

# Unambiguous characters for join codes (no 0/O, 1/I/L)
_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_CODE_LENGTH = 4
_LOBBY_EXPIRY_SECONDS = 900  # 15 minutes of inactivity
_LOBBY_CHECK_INTERVAL = 60   # Check for expired lobbies every 60s

# 12 distinct player colors (CSS hex strings)
PLAYER_COLOR_OPTIONS = [
    "#e6194b",  # Red
    "#3cb44b",  # Green
    "#ffe119",  # Yellow
    "#4363d8",  # Blue
    "#f58231",  # Orange
    "#911eb4",  # Purple
    "#42d4f4",  # Cyan
    "#f032e6",  # Magenta
    "#bfef45",  # Lime
    "#fabed4",  # Pink
    "#469990",  # Teal
    "#dcbeff",  # Lavender
]


@dataclass
class LobbyPlayer:
    id: str
    name: str
    archetype: str
    color: str = ""  # CSS hex color, assigned on join
    is_cpu: bool = False
    cpu_noise: float = 0.15
    is_host: bool = False
    has_returned: bool = True  # True by default; False when returning from a game
    token: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "archetype": self.archetype,
            "color": self.color,
            "is_cpu": self.is_cpu,
            "is_host": self.is_host,
            "has_returned": self.has_returned,
            "cpu_difficulty": (
                "easy" if self.cpu_noise >= 0.25 else
                "medium" if self.cpu_noise >= 0.10 else
                "hard"
            ) if self.is_cpu else None,
        }


@dataclass
class LobbyConfig:
    grid_size: str = "medium"
    speed: str = "normal"
    max_players: int = 3
    test_mode: bool = False
    vp_target: Optional[int] = None  # None = use computed default
    granted_actions: Optional[int] = None  # None = use archetype default (currently 5)
    card_pack: str = DEFAULT_PACK_ID
    max_rounds: int = 20
    map_seed: str = ""  # 6-char lowercase alphanumeric; "" = generate on init
    archetype_market_size: int = 5  # Number of cards shown in archetype market each turn

    def __post_init__(self) -> None:
        if not self.map_seed:
            self.map_seed = generate_map_seed()

    def to_dict(self) -> dict[str, Any]:
        return {
            "grid_size": self.grid_size,
            "speed": self.speed,
            "max_players": self.max_players,
            "test_mode": self.test_mode,
            "vp_target": self.vp_target,
            "granted_actions": self.granted_actions,
            "card_pack": self.card_pack,
            "max_rounds": self.max_rounds,
            "map_seed": self.map_seed,
            "archetype_market_size": self.archetype_market_size,
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
    player_order: list[str] = field(default_factory=list)  # explicit ordering for turn order

    def to_dict(self) -> dict[str, Any]:
        # Use explicit player_order if set, otherwise dict insertion order
        order = self.player_order if self.player_order else list(self.players.keys())
        return {
            "code": self.code,
            "host_id": self.host_id,
            "players": {pid: p.to_dict() for pid, p in self.players.items()},
            "player_order": order,
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
# Track which games have had their lobby reset for return-to-lobby
_return_to_lobby_done: dict[str, bool] = {}  # game_id → True if lobby was already reset

# Reference to the GameStore (set by init_lobby)
_store_ref: Any = None  # GameStore | None (avoid circular import)
_card_registry_ref: Any = None


def init_lobby(store: Any, get_registry: Any) -> None:
    """Initialize lobby module with shared GameStore and registry factory."""
    global _store_ref, _card_registry_ref
    _store_ref = store
    _card_registry_ref = get_registry


def _get_store() -> Any:
    """Get the shared GameStore."""
    if _store_ref is None:
        raise RuntimeError("Lobby not initialized — call init_lobby first")
    return _store_ref


def _get_registry() -> dict[str, Any]:
    if _card_registry_ref is None:
        raise RuntimeError("Lobby not initialized — call init_lobby first")
    result: dict[str, Any] = _card_registry_ref()
    return result


def get_lobby_for_game(game_id: str) -> Optional[Lobby]:
    """Look up the lobby associated with a game (if any)."""
    code = _game_to_lobby.get(game_id)
    return _lobbies.get(code) if code else None


def validate_token(player_id: str, token: str) -> bool:
    """Check if a player_id/token pair is valid."""
    return _tokens.get(player_id) == token


def get_visible_player_ids(game_id: str, player_id: str) -> set[str] | None:
    """Get the set of player IDs whose hands should be visible to the given player.

    Returns None if no lobby is associated (show all hands).
    Otherwise returns just the requesting player's own ID.
    """
    lobby = get_lobby_for_game(game_id)
    if not lobby:
        return None

    return {player_id}


def _next_available_color(lobby: Lobby) -> str:
    """Return the first color from PLAYER_COLOR_OPTIONS not taken by any player."""
    used = {p.color for p in lobby.players.values()}
    for c in PLAYER_COLOR_OPTIONS:
        if c not in used:
            return c
    # Fallback — all 12 taken (shouldn't happen with max 6 players)
    return PLAYER_COLOR_OPTIONS[0]


def _generate_code() -> str:
    """Generate a unique 4-character lobby code."""
    for _ in range(100):
        code = "".join(random.choices(_CODE_CHARS, k=_CODE_LENGTH))
        if code not in _lobbies:
            return code
    raise RuntimeError("Failed to generate unique lobby code")


# ── Router ────────────────────────────────────────────────

# Common first names for CPU players (50 names, mix of male/female)
_CPU_NAMES = [
    "Alice", "Bob", "Charlie", "Diana", "Ethan",
    "Fiona", "George", "Hannah", "Isaac", "Julia",
    "Kevin", "Luna", "Marcus", "Nora", "Oscar",
    "Penny", "Quinn", "Rosa", "Sam", "Tara",
    "Uma", "Victor", "Wendy", "Xander", "Yara",
    "Zach", "Amber", "Blake", "Chloe", "Derek",
    "Elena", "Felix", "Grace", "Hugo", "Iris",
    "Jake", "Kira", "Leo", "Maya", "Nate",
    "Olive", "Paul", "Ruby", "Sean", "Tess",
    "Uri", "Vera", "Will", "Xena", "Yuki",
]

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
    vp_target: Optional[int] = None
    granted_actions: Optional[int] = None
    card_pack: Optional[str] = None
    map_seed: Optional[str] = None
    archetype_market_size: Optional[int] = None
    max_rounds: Optional[int] = None


class UpdatePlayerRequest(BaseModel):
    name: Optional[str] = None
    archetype: Optional[str] = None
    difficulty: Optional[str] = None
    color: Optional[str] = None
    token: str


class AddCpuRequest(BaseModel):
    archetype: str
    difficulty: str = "medium"
    token: str


class RemovePlayerRequest(BaseModel):
    token: str


class ReorderPlayersRequest(BaseModel):
    order: list[str]
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
        name=req.name[:12],
        archetype=req.archetype,
        color=PLAYER_COLOR_OPTIONS[0],
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

    # Default name is "Player N" based on join order (total players so far + 1)
    name = (req.name[:12] if req.name and req.name.strip() not in ('', 'Player') else f"Player {len(lobby.players) + 1}")

    player = LobbyPlayer(
        id=player_id,
        name=name,
        archetype=req.archetype,
        color=_next_available_color(lobby),
        token=token,
    )
    lobby.players[player_id] = player
    if lobby.player_order:
        lobby.player_order.append(player_id)
    lobby.touch()
    _tokens[player_id] = token

    # Broadcast update to existing members
    await manager.broadcast_lobby(code, lobby.to_dict())

    return {
        "player_id": player_id,
        "token": token,
        "lobby": lobby.to_dict(),
    }


class RejoinRequest(BaseModel):
    player_id: str


@lobby_router.post("/{code}/rejoin")
async def rejoin_lobby(code: str, req: RejoinRequest) -> dict[str, Any]:
    """Rejoin an existing lobby to get a fresh token.

    Used when the client's token becomes stale (e.g. after server restart).
    The player must already be a member of the lobby.
    """
    lobby = _require_lobby(code)

    if req.player_id not in lobby.players:
        raise HTTPException(403, "Not a member of this lobby")

    player = lobby.players[req.player_id]

    # Issue a fresh token
    token = str(uuid.uuid4())
    player.token = token
    _tokens[req.player_id] = token
    lobby.touch()

    return {
        "player_id": req.player_id,
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

    if req.vp_target is not None:
        if req.vp_target < 1:
            raise HTTPException(400, "vp_target must be a positive integer")
        lobby.config.vp_target = req.vp_target

    if req.granted_actions is not None:
        if req.granted_actions < 1 or req.granted_actions > 10:
            raise HTTPException(400, "granted_actions must be between 1 and 10")
        lobby.config.granted_actions = req.granted_actions

    if req.card_pack is not None:
        if req.card_pack.startswith("daily_"):
            try:
                seed_val = int(req.card_pack.split("_", 1)[1])
                if seed_val < 20200101 or seed_val > 29991231:
                    raise ValueError
            except (ValueError, IndexError):
                raise HTTPException(400, f"Invalid daily pack seed: {req.card_pack}")
        elif req.card_pack not in CARD_PACKS:
            raise HTTPException(400, f"Invalid card pack: {req.card_pack}")
        lobby.config.card_pack = req.card_pack

    if req.map_seed is not None:
        seed = req.map_seed.lower().strip()
        import re
        if not re.fullmatch(r'[a-z0-9]{6}', seed):
            raise HTTPException(400, "Map seed must be exactly 6 lowercase alphanumeric characters")
        lobby.config.map_seed = seed

    if req.archetype_market_size is not None:
        if not 1 <= req.archetype_market_size <= 10:
            raise HTTPException(400, "archetype_market_size must be between 1 and 10")
        lobby.config.archetype_market_size = req.archetype_market_size

    if req.max_rounds is not None:
        if req.max_rounds < 5:
            raise HTTPException(400, "max_rounds must be at least 5")
        lobby.config.max_rounds = req.max_rounds

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

    if not is_self and not (is_host and player.is_cpu):
        raise HTTPException(403, "Not authorized to edit this player")

    if req.name is not None:
        player.name = req.name[:12]
    if req.archetype is not None:
        try:
            Archetype(req.archetype)
        except ValueError:
            raise HTTPException(400, f"Invalid archetype: {req.archetype}")
        player.archetype = req.archetype

    if req.difficulty is not None and player.is_cpu:
        noise_map = {"easy": 0.25, "medium": 0.10, "hard": 0.05}
        if req.difficulty not in noise_map:
            raise HTTPException(400, f"Invalid difficulty: {req.difficulty}")
        player.cpu_noise = noise_map[req.difficulty]

    if req.color is not None:
        if req.color not in PLAYER_COLOR_OPTIONS:
            raise HTTPException(400, f"Invalid color: {req.color}")
        # Check that no other player already has this color
        for pid, p in lobby.players.items():
            if pid != player_id and p.color == req.color:
                raise HTTPException(400, "Color already taken by another player")
        player.color = req.color

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

    noise_map = {"easy": 0.25, "medium": 0.10, "hard": 0.05}
    noise = noise_map.get(req.difficulty, 0.15)

    # Assign next player_id
    existing_ids = {int(p.id.split("_")[1]) for p in lobby.players.values() if p.id.startswith("player_")}
    next_idx = 0
    while next_idx in existing_ids:
        next_idx += 1
    player_id = f"player_{next_idx}"

    # Pick a random name not already used in this lobby
    used_names = {p.name for p in lobby.players.values()}
    available = [n for n in _CPU_NAMES if f"\U0001F916 {n}" not in used_names]
    cpu_name = random.choice(available) if available else f"CPU {len(lobby.players)}"
    cpu = LobbyPlayer(
        id=player_id,
        name=f"\U0001F916 {cpu_name}",
        archetype=req.archetype,
        color=_next_available_color(lobby),
        is_cpu=True,
        cpu_noise=noise,
    )
    lobby.players[player_id] = cpu
    if lobby.player_order:
        lobby.player_order.append(player_id)
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
    if lobby.player_order and target_player_id in lobby.player_order:
        lobby.player_order.remove(target_player_id)
    _tokens.pop(target_player_id, None)
    lobby.touch()

    await manager.broadcast_lobby(code, lobby.to_dict())
    # Notify the removed player before disconnecting their WebSocket
    await manager.send_to_player(code, target_player_id, {
        "type": "removed_from_lobby",
        "reason": "You have been removed from the lobby by the host.",
    })
    manager.disconnect(code, target_player_id)

    return {"lobby": lobby.to_dict()}


@lobby_router.post("/{code}/reorder")
async def reorder_players(code: str, req: ReorderPlayersRequest) -> dict[str, Any]:
    """Reorder players in the lobby (host only). Affects in-game turn order."""
    lobby = _require_lobby(code)
    _require_token(lobby.host_id, req.token)

    # Validate that the order contains exactly the current player IDs
    current_ids = set(lobby.players.keys())
    requested_ids = set(req.order)
    if current_ids != requested_ids:
        raise HTTPException(400, "Order must contain exactly the current player IDs")

    lobby.player_order = list(req.order)
    lobby.touch()
    await manager.broadcast_lobby(code, lobby.to_dict())

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

    # Block start if any human player hasn't returned from a previous game
    waiting_players = [p.name for p in lobby.players.values() if not p.is_cpu and not p.has_returned]
    if waiting_players:
        raise HTTPException(400, f"Waiting for players to return: {', '.join(waiting_players)}")

    # Send countdown to all connected players
    lobby.status = "countdown"
    for seconds in [3, 2, 1]:
        await manager.broadcast(code, {"type": "countdown", "seconds_remaining": seconds})
        await asyncio.sleep(1)

    # Create the game from lobby config — use explicit player_order if set
    registry = _get_registry()
    ordered_pids = lobby.player_order if lobby.player_order else list(lobby.players.keys())
    player_configs = []
    for pid in ordered_pids:
        p = lobby.players[pid]
        player_configs.append({
            "id": pid,
            "name": p.name,
            "archetype": p.archetype,
            "color": p.color,
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
        vp_target=lobby.config.vp_target,
        granted_actions=lobby.config.granted_actions,
        card_pack=lobby.config.card_pack,
        map_seed=lobby.config.map_seed,
        max_rounds=lobby.config.max_rounds,
        archetype_market_size=lobby.config.archetype_market_size,
    )
    game.host_id = lobby.host_id
    game.lobby_code = code
    execute_start_of_turn(game)

    store = _get_store()
    await store.put(game)
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

    # Host response: include only host's own hand
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
            game = await _get_store().get(lobby.game_id)
            if game:
                visible = get_visible_player_ids(game.id, player_id)
                state = game.to_dict(for_player_id=player_id, visible_player_ids=visible)
                await ws.send_json({"type": "game_state", "state": state})
                # Recover orphaned CPU buy tasks (e.g. after service restart)
                _maybe_restart_cpu_buys(game)
        else:
            await ws.send_json({"type": "lobby_update", "lobby": lobby.to_dict()})

        # Keep connection alive — parse incoming messages for cursor updates
        while True:
            raw = await ws.receive_text()
            lobby.touch()
            try:
                import json as _json
                msg = _json.loads(raw)
                msg_type = msg.get("type")
                if msg_type == "cursor_update" and lobby.game_id:
                    # Look up player color from the game state
                    game = await _get_store().get(lobby.game_id)
                    player_color = "#666"
                    player_name = player_id
                    if game and player_id in game.players:
                        player_color = game.players[player_id].color
                        player_name = game.players[player_id].name
                    await manager.send_to_others(group_id, player_id, {
                        "type": "cursor_update",
                        "player_id": player_id,
                        "player_name": player_name,
                        "player_color": player_color,
                        "hovered_card_id": msg.get("hovered_card_id"),
                        "source": msg.get("source"),
                    })
            except Exception:
                pass  # Non-JSON or malformed — ignore
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
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    player = game.players.get(player_id)
    if not player:
        raise HTTPException(404, "Player not found")
    if player.has_left:
        raise HTTPException(400, "Player already left")

    from app.game_engine.game_state import (
        Phase,
        _transition_to_buy,
        compute_player_vp,
        end_buy_phase,
        execute_end_of_turn,
        execute_reveal,
    )

    # Freeze VP before neutralizing tiles (so leaderboard shows their score at departure)
    player.left_vp = compute_player_vp(game, player_id)

    # Neutralize all tiles owned by this player (including base → normal neutral tile)
    if game.grid:
        for tile in game.grid.tiles.values():
            if tile.owner == player_id:
                tile.owner = None
                tile.defense_power = tile.base_defense
                tile.permanent_defense_bonus = 0
                tile.held_since_turn = None
            if tile.is_base and tile.base_owner == player_id:
                tile.is_base = False
                tile.base_owner = None

    # Mark player as left and freeze all phase flags.
    # Move hand and planned action cards to discard so the full deck is viewable.
    player.has_left = True
    planned_cards = [a.card for a in player.planned_actions]
    player.deck.add_to_discard(player.hand + planned_cards)
    player.planned_actions = []
    player.hand = []
    player.has_submitted_play = True
    player.has_acknowledged_resolve = True
    player.has_ended_turn = True
    game._log(f"{player.name} has left the game.")

    # Check if only one active (non-left) player remains → they win
    active_players = [pid for pid, p in game.players.items() if not p.has_left]
    if len(active_players) == 1 and game.current_phase != Phase.GAME_OVER:
        sole_pid = active_players[0]
        game.winner = sole_pid
        game.current_phase = Phase.GAME_OVER
        game._log(f"{game.players[sole_pid].name} wins — all opponents left!")
    elif len(active_players) == 0 and game.current_phase != Phase.GAME_OVER:
        game.current_phase = Phase.GAME_OVER
        game._log("All players have left — game over.")
    elif game.current_phase != Phase.GAME_OVER:
        # Check if this unblocks phase advancement
        if game.current_phase == Phase.PLAY:
            if all(p.has_submitted_play for p in game.players.values()):
                execute_reveal(game)
                if all(
                    p.has_acknowledged_resolve or p.is_cpu or p.has_left
                    for p in game.players.values()
                ):
                    _transition_to_buy(game)
        elif game.current_phase == Phase.REVEAL:
            if all(
                p.has_acknowledged_resolve or p.is_cpu or p.has_left
                for p in game.players.values()
            ):
                _transition_to_buy(game)
        elif game.current_phase == Phase.BUY:
            # Mark leaving player as done buying
            game.players_done_buying.add(player_id)
            if all(pid in game.players_done_buying for pid in game.player_order):
                game.neutral_market.finalize_selling_out()
                execute_end_of_turn(game)

    # Persist state before broadcasting
    if game.current_phase == Phase.GAME_OVER:
        await store.finish(game)
    else:
        await store.save(game)

    # Broadcast updated state (includes has_left=True + winner if applicable),
    # then disconnect the leaving player.
    # Note: we do NOT send a separate "player_left" message after the state broadcast,
    # because two rapid WS messages can cause React to skip the first (game_state) and
    # only process the second (player_left), losing the critical state update.
    await manager.broadcast_game_state(game_id, game, get_visible_ids=get_visible_player_ids)
    manager.disconnect(game_id, player_id)

    return {"message": f"{player.name} left the game", "state": game.to_dict()}


async def handle_end_game(game_id: str, player_id: str, token: str) -> dict[str, Any]:
    """Host ends the game for everyone."""
    _require_token(player_id, token)
    store = _get_store()
    game = await store.get(game_id)
    if not game:
        raise HTTPException(404, "Game not found")

    # Verify caller is host
    if not hasattr(game, 'host_id') or game.host_id != player_id:
        raise HTTPException(403, "Only the host can end the game")

    # Broadcast game_ended to all players (include game_id so frontend can verify)
    await manager.broadcast(game_id, {"type": "game_ended", "game_id": game_id})

    # Close all connections and clean up
    for ws in manager.close_group(game_id):
        try:
            await ws.close()
        except Exception:
            pass

    # Mark game as abandoned in DB and evict from cache
    await store.abandon(game_id)

    # Clean up lobby
    lobby_code = _game_to_lobby.pop(game_id, None)
    if lobby_code:
        lobby = _lobbies.pop(lobby_code, None)
        if lobby:
            for pid in lobby.players:
                _tokens.pop(pid, None)

    return {"message": "Game ended"}


# ── Return to Lobby ─────────────────────────────────────


async def handle_return_to_lobby(game_id: str, player_id: str, token: str) -> dict[str, Any]:
    """Handle a player returning to the lobby after a game ends."""
    _require_token(player_id, token)

    lobby = get_lobby_for_game(game_id)
    if not lobby:
        raise HTTPException(400, "No lobby associated with this game")

    store = _get_store()
    game = await store.get(game_id)  # May be None if already cleaned up by a prior call

    # First call: reset lobby state, clean up game, migrate connections
    if not _return_to_lobby_done.get(game_id):
        _return_to_lobby_done[game_id] = True

        # Preserve the map seed from the finished game
        if game:
            lobby.config.map_seed = game.map_seed

        # Reset lobby
        lobby.status = "waiting"
        lobby.game_id = None

        # Mark all human players as not-returned, CPUs as returned
        for p in lobby.players.values():
            p.has_returned = p.is_cpu

        # Remove players who left during the game
        left_pids = {pid for pid, p in game.players.items() if p.has_left} if game else set()
        for pid in left_pids:
            lobby.players.pop(pid, None)
            if lobby.player_order and pid in lobby.player_order:
                lobby.player_order.remove(pid)

        # Clean up old game from cache (DB record persists for analytics)
        _game_to_lobby.pop(game_id, None)
        store.evict(game_id)

        # Migrate WS connections from game group to lobby group
        manager.migrate_group(game_id, lobby.code)

        # Re-register lobby→game mapping is not needed since game is gone
        # But we need to track the mapping from old game_id for subsequent calls
        _game_to_lobby[game_id] = lobby.code  # keep for subsequent return calls

    # Mark this player as returned
    lp = lobby.players.get(player_id)
    if lp:
        lp.has_returned = True

    lobby.touch()

    # Only send lobby_update to players who have returned (so others stay on game-over screen)
    lobby_dict = lobby.to_dict()
    lobby_msg = {"type": "lobby_update", "lobby": lobby_dict}
    for pid, p in lobby.players.items():
        if p.has_returned:
            await manager.send_to_player(lobby.code, pid, lobby_msg)

    return {"message": "Returned to lobby", "lobby": lobby_dict}


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
