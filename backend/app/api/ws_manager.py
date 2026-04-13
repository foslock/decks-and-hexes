"""WebSocket connection manager for real-time lobby and game state broadcasts."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections grouped by lobby code or game ID."""

    def __init__(self) -> None:
        # group_id (lobby code or game_id) → {player_id → WebSocket}
        self.connections: dict[str, dict[str, WebSocket]] = {}

    async def connect(self, group_id: str, player_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self.connections.setdefault(group_id, {})[player_id] = ws

    def disconnect(self, group_id: str, player_id: str) -> None:
        group = self.connections.get(group_id)
        if group:
            group.pop(player_id, None)
            if not group:
                del self.connections[group_id]

    def migrate_group(self, old_id: str, new_id: str) -> None:
        """Move all connections from one group to another (lobby → game)."""
        group = self.connections.pop(old_id, None)
        if group:
            self.connections[new_id] = group

    async def send_to_player(
        self, group_id: str, player_id: str, message: dict[str, Any],
    ) -> None:
        group = self.connections.get(group_id, {})
        ws = group.get(player_id)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                logger.debug("Failed to send to %s in %s", player_id, group_id)
                self.disconnect(group_id, player_id)

    async def broadcast(self, group_id: str, message: dict[str, Any]) -> None:
        """Send the same message to all members of a group."""
        group = self.connections.get(group_id, {})
        dead: list[str] = []
        for pid, ws in group.items():
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(pid)
        for pid in dead:
            self.disconnect(group_id, pid)

    async def broadcast_lobby(self, code: str, lobby_dict: dict[str, Any]) -> None:
        """Send lobby state to all connected lobby members."""
        await self.broadcast(code, {"type": "lobby_update", "lobby": lobby_dict})

    async def broadcast_game_state(
        self, game_id: str, game: Any,
        get_visible_ids: Any = None,
    ) -> None:
        """Send per-player game state to each connected player.

        If get_visible_ids is provided, it should be a callable(game_id, player_id) -> set | None
        that returns the set of player IDs whose hands should be visible.
        """
        group = self.connections.get(game_id, {})
        dead: list[str] = []
        for pid, ws in group.items():
            try:
                visible = get_visible_ids(game_id, pid) if get_visible_ids else None
                state = game.to_dict(for_player_id=pid, visible_player_ids=visible)
                await ws.send_json({"type": "game_state", "state": state})
            except Exception:
                dead.append(pid)
        for pid in dead:
            self.disconnect(game_id, pid)

    def close_group(self, group_id: str) -> list[WebSocket]:
        """Remove a group and return its WebSocket objects for closing."""
        group = self.connections.pop(group_id, None)
        return list(group.values()) if group else []

    def get_player_ids(self, group_id: str) -> list[str]:
        """Get all connected player IDs in a group."""
        return list(self.connections.get(group_id, {}).keys())

    async def send_to_others(
        self, group_id: str, exclude_pid: str, message: dict[str, Any],
    ) -> None:
        """Send a message to all members of a group except the specified player."""
        group = self.connections.get(group_id, {})
        dead: list[str] = []
        for pid, ws in group.items():
            if pid == exclude_pid:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(pid)
        for pid in dead:
            self.disconnect(group_id, pid)


# Singleton instance
manager = ConnectionManager()
