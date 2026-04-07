"""Analytics recorder — fire-and-forget event recording + homepage stats.

All methods are designed to be called without awaiting in route handlers
(fire-and-forget via asyncio.create_task) so they don't slow down game
actions.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from app.storage.repository import GameRepository

logger = logging.getLogger(__name__)


class AnalyticsRecorder:
    """Records game events and maintains aggregate counters."""

    def __init__(self, repo: GameRepository) -> None:
        self._repo = repo

    # ------------------------------------------------------------------
    # Fire-and-forget helpers
    # ------------------------------------------------------------------

    def fire(self, coro: Any) -> None:
        """Schedule an async task without awaiting it."""
        try:
            loop = asyncio.get_running_loop()
            task = loop.create_task(coro)
            # Suppress "task exception was never retrieved" warnings
            task.add_done_callback(self._handle_task_error)
        except RuntimeError:
            # No running event loop (e.g. in tests) — skip silently
            pass

    @staticmethod
    def _handle_task_error(task: asyncio.Task[Any]) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logger.warning("Analytics task failed: %s", exc)

    # ------------------------------------------------------------------
    # Event recording (called from route handlers)
    # ------------------------------------------------------------------

    def record_card_played(
        self,
        game_id: str,
        player_id: str,
        round_number: int,
        card_id: str,
        card_name: str,
        target_q: Optional[int] = None,
        target_r: Optional[int] = None,
    ) -> None:
        """Record a card being played (fire-and-forget)."""
        detail: dict[str, int] = {}
        if target_q is not None:
            detail["target_q"] = target_q
            if target_r is not None:
                detail["target_r"] = target_r
        self.fire(self._repo.record_event(
            game_id, player_id, "card_played", round_number,
            card_id=card_id, card_name=card_name,
            detail_json=json.dumps(detail) if detail else None,
        ))
        self.fire(self._repo.increment_stat("total_cards_played"))

    def record_card_bought(
        self,
        game_id: str,
        player_id: str,
        round_number: int,
        card_id: str,
        card_name: str,
        source: str,
        cost: int,
    ) -> None:
        """Record a card purchase (fire-and-forget)."""
        detail = {"source": source, "cost": cost}
        self.fire(self._repo.record_event(
            game_id, player_id, "card_bought", round_number,
            card_id=card_id, card_name=card_name,
            detail_json=json.dumps(detail),
        ))
        self.fire(self._repo.increment_stat("total_cards_bought"))

    def record_tile_captured(
        self,
        game_id: str,
        player_id: str,
        round_number: int,
        tile_key: str,
        is_vp: bool = False,
    ) -> None:
        """Record a tile capture (fire-and-forget)."""
        detail = {"tile_key": tile_key, "is_vp": is_vp}
        self.fire(self._repo.record_event(
            game_id, player_id, "tile_captured", round_number,
            detail_json=json.dumps(detail),
        ))
        self.fire(self._repo.increment_stat("total_tiles_captured"))

    def record_game_finished(
        self,
        game_id: str,
        winner_id: Optional[str],
        round_number: int,
        player_count: int,
        player_vps: dict[str, int],
    ) -> None:
        """Record a game finishing (fire-and-forget)."""
        detail = {
            "winner_id": winner_id,
            "player_count": player_count,
            "final_vps": player_vps,
        }
        pid = winner_id or "system"
        self.fire(self._repo.record_event(
            game_id, pid, "game_finished", round_number,
            detail_json=json.dumps(detail),
        ))
        self.fire(self._repo.increment_stat("total_games_finished"))
        # Also record total VP earned across all players
        total_vp = sum(player_vps.values())
        self.fire(self._repo.increment_stat("total_vp_earned", total_vp))
        self.fire(self._repo.increment_stat("total_rounds_played", round_number))

    # ------------------------------------------------------------------
    # Query methods (for homepage stats widget)
    # ------------------------------------------------------------------

    async def get_homepage_stats(self) -> dict[str, int]:
        """Fetch all aggregate stats for the homepage widget."""
        return await self._repo.get_stats()
