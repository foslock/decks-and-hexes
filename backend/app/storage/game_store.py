"""GameStore — in-memory cache + DB persistence.

Drop-in replacement for the ``_games: dict[str, GameState]`` pattern.
Every route changes from:

    game = _games.get(game_id)       →  game = await store.get(game_id)
    # ... mutate ...                    # ... mutate ...
                                        await store.save(game)

The store maintains an in-memory cache for fast reads and writes through
to the database on every mutation.  Optimistic locking ensures multi-process
safety without distributed locks.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from app.game_engine.cards import Card
from app.game_engine.game_state import GameState, Phase
from app.storage.repository import GameRepository, OptimisticLockError
from app.storage.serializer import deserialize_game, serialize_game

logger = logging.getLogger(__name__)


class GameStore:
    """In-memory cache backed by DB persistence."""

    def __init__(
        self,
        repo: GameRepository,
        card_registry: dict[str, Card],
    ) -> None:
        self._repo = repo
        self._card_registry = card_registry
        # Cache: game_id → (GameState, db_version)
        self._cache: dict[str, tuple[GameState, int]] = {}

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    async def get(self, game_id: str) -> Optional[GameState]:
        """Get a game by ID. Cache-first, then DB."""
        # Check cache
        cached = self._cache.get(game_id)
        if cached is not None:
            return cached[0]

        # Fetch from DB
        result = await self._repo.get(game_id)
        if result is None:
            return None

        snapshot, version = result
        game = deserialize_game(snapshot, self._card_registry)
        self._cache[game_id] = (game, version)
        return game

    def get_cached(self, game_id: str) -> Optional[GameState]:
        """Get a game from cache only (sync, no DB). Returns None if not cached."""
        cached = self._cache.get(game_id)
        return cached[0] if cached else None

    # ------------------------------------------------------------------
    # Create
    # ------------------------------------------------------------------

    async def put(self, game: GameState) -> None:
        """Insert a new game into DB and cache."""
        snapshot = serialize_game(game)
        grid_size = game.grid.size.value if game.grid else "small"

        players = [
            {
                "id": pid,
                "name": p.name,
                "archetype": p.archetype.value,
                "is_cpu": p.is_cpu,
            }
            for pid, p in game.players.items()
        ]

        await self._repo.create(
            game_id=game.id,
            state_snapshot=snapshot,
            map_seed=game.map_seed,
            card_pack=game.card_pack,
            grid_size=grid_size,
            player_count=len(game.players),
            players=players,
        )
        self._cache[game.id] = (game, 1)

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    async def save(self, game: GameState) -> bool:
        """Persist current game state to DB with optimistic locking.

        Returns True on success, False on version conflict.
        On conflict, the caller should reload from DB (call get() again).
        """
        cached = self._cache.get(game.id)
        if cached is None:
            logger.warning("save() called for uncached game %s", game.id)
            return False

        _, current_version = cached
        snapshot = serialize_game(game)

        try:
            new_version = await self._repo.save(
                game.id, snapshot, expected_version=current_version
            )
            self._cache[game.id] = (game, new_version)
            return True
        except OptimisticLockError:
            logger.warning(
                "Optimistic lock conflict for game %s (version %d)",
                game.id,
                current_version,
            )
            # Evict stale cache entry so next get() reloads from DB
            self._cache.pop(game.id, None)
            return False

    async def finish(self, game: GameState) -> bool:
        """Mark a game as finished, persist final state and player results."""
        cached = self._cache.get(game.id)
        if cached is None:
            return False

        _, current_version = cached
        snapshot = serialize_game(game)

        # Build player results
        from app.game_engine.game_state import compute_player_vp
        player_results = [
            {
                "player_id": pid,
                "final_vp": compute_player_vp(game, pid),
                "is_winner": pid == game.winner,
            }
            for pid in game.player_order
        ]

        try:
            new_version = await self._repo.finish(
                game.id,
                snapshot,
                expected_version=current_version,
                winner_id=game.winner,
                player_results=player_results,
            )
            self._cache[game.id] = (game, new_version)
            return True
        except OptimisticLockError:
            self._cache.pop(game.id, None)
            return False

    # ------------------------------------------------------------------
    # Remove / Abandon
    # ------------------------------------------------------------------

    def evict(self, game_id: str) -> None:
        """Remove a game from the in-memory cache (e.g. after it ends)."""
        self._cache.pop(game_id, None)

    async def abandon(self, game_id: str) -> None:
        """Mark a game as abandoned in DB and evict from cache."""
        await self._repo.abandon(game_id)
        self._cache.pop(game_id, None)

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    def cached_game_ids(self) -> list[str]:
        """Return IDs of all games currently in cache."""
        return list(self._cache.keys())

    @property
    def repo(self) -> GameRepository:
        """Access the underlying repository (for analytics, etc.)."""
        return self._repo
