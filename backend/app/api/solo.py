"""Solo campaign API: the campaigns and overworld, and starting a level.

A level's game runs through the ordinary game routes and WebSocket: starting
one registers a private, already-started lobby for it (the player plus the
level's bots), the same shape a multiplayer game has, so the frontend plays it
like any lobby game. The lobby never shows in the browser (not public).
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.api import lobby as lobbies
from app.api.name_filter import is_name_allowed
from app.game_engine.game_state import execute_start_of_turn
from app.game_engine.solo import (
    ARCHETYPES,
    BOT_COLORS,
    PLAYER_COLOR,
    SOLO_PLAYER_ID,
    Campaign,
    LevelError,
    SoloLevel,
    create_solo_game,
    get_campaign,
)

solo_router = APIRouter(prefix="/api/solo")


def _campaign() -> Campaign:
    from app.api.routes import _get_card_registry

    try:
        return get_campaign(_get_card_registry())
    except LevelError as e:  # a broken data file: say what's wrong
        raise HTTPException(500, f"Solo levels failed to load: {e}") from None


def _level(level_id: str, archetype: str) -> SoloLevel:
    """The level as `archetype`'s campaign plays it."""
    level = _campaign().level(archetype, level_id)
    if level is None:
        raise HTTPException(404, f"No solo level {level_id!r} in the {archetype} campaign")
    return level


@solo_router.get("/levels")
async def list_levels() -> dict[str, Any]:
    """The overworld and each archetype's campaign: castle, roads and levels
    in play order (a shared level appears in each of its campaigns, as that
    side plays it)."""
    return _campaign().to_dict()


@solo_router.get("/levels/{level_id}/map")
async def level_map(level_id: str, archetype: str) -> dict[str, Any]:
    """The level's board as the game starts it for `archetype` (tiles with
    each seat's starting land), for a preview."""
    level = _level(level_id, archetype)
    grid = level.build_grid()
    seats = [SOLO_PLAYER_ID] + [f"player_{i + 1}" for i in range(len(level.bots))]
    for pid, cluster in zip(seats, grid.starting_positions):
        for j, (q, r) in enumerate(cluster):
            tile = grid.tiles[f"{q},{r}"]
            tile.owner = pid
            if j == 0:
                tile.is_base = True
                tile.base_owner = pid
                tile.base_defense = tile.defense_power = 3
    return {
        "map_name": level.map_name,
        "seats": seats,
        "players": [
            {"id": SOLO_PLAYER_ID, "name": "You", "archetype": level.archetype, "color": PLAYER_COLOR},
            *({"id": pid, "name": b.name, "archetype": b.archetype, "color": BOT_COLORS[i % len(BOT_COLORS)]}
              for i, (pid, b) in enumerate(zip(seats[1:], level.bots))),
        ],
        "tiles": grid.to_dict()["tiles"],
    }


class StartLevelRequest(BaseModel):
    archetype: str  # the campaign: you play the level as it
    name: Optional[str] = None


def _register_lobby(game: Any) -> str:
    """Seat the game in a private, started lobby; returns the player's token."""
    code = lobbies._generate_code()
    game.host_id = SOLO_PLAYER_ID
    game.lobby_code = code
    token = str(uuid.uuid4())
    now = time.time()
    lobby = lobbies.Lobby(code=code, host_id=SOLO_PLAYER_ID, created_at=now, last_activity=now)
    lobby.config.open_to_public = False
    lobby.config.card_pack = game.card_pack
    lobby.config.max_rounds = game.max_rounds
    lobby.config.vp_target = game.vp_target
    for pid in game.player_order:
        p = game.players[pid]
        lobby.players[pid] = lobbies.LobbyPlayer(
            id=pid, name=p.name, archetype=p.archetype.value, color=p.color,
            is_cpu=p.is_cpu, cpu_difficulty=p.cpu_difficulty, is_host=pid == SOLO_PLAYER_ID,
            token=token if pid == SOLO_PLAYER_ID else "",
        )
    lobby.player_order = list(game.player_order)
    lobby.game_id = game.id
    lobby.status = "started"
    lobbies._lobbies[code] = lobby
    lobbies._tokens[(code, SOLO_PLAYER_ID)] = token
    lobbies._game_to_lobby[game.id] = code
    return token


def _unregister_lobby(game: Any) -> None:
    code = lobbies._game_to_lobby.pop(game.id, None)
    if code:
        lobbies._lobbies.pop(code, None)
        lobbies._tokens.pop((code, SOLO_PLAYER_ID), None)


@solo_router.post("/levels/{level_id}/start")
async def start_level(level_id: str, req: StartLevelRequest) -> dict[str, Any]:
    """Start a game of the level. Returns what joining a started lobby gives:
    the game, your player id and token, and the (private) lobby code the
    game's WebSocket runs on."""
    from app.api.routes import (
        SERVER_FULL_MESSAGE, _get_card_registry, _get_store, release_game_slot, reserve_game_slot,
    )

    if req.archetype not in ARCHETYPES:
        raise HTTPException(400, f"Unknown archetype {req.archetype!r}")
    level = _level(level_id, req.archetype)
    name = (req.name or "").strip()[:12]
    if not name or not is_name_allowed(name):
        name = "You"

    if not reserve_game_slot():
        raise HTTPException(503, SERVER_FULL_MESSAGE)
    try:
        game = create_solo_game(level, _get_card_registry(), player_name=name)
        execute_start_of_turn(game)
        # Register the lobby before the first await, so its code stays unique.
        token = _register_lobby(game)
        try:
            await _get_store().put(game)
        except Exception:
            _unregister_lobby(game)
            raise
    finally:
        release_game_slot()

    visible = lobbies.get_visible_player_ids(game.id, SOLO_PLAYER_ID)
    return {
        "game_id": game.id,
        "player_id": SOLO_PLAYER_ID,
        "token": token,
        "lobby_code": game.lobby_code,
        "level_id": level.id,
        "state": game.to_dict(for_player_id=SOLO_PLAYER_ID, visible_player_ids=visible),
    }
