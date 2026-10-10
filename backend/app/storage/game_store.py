"""GameStore — in-memory cache + DB persistence.

Drop-in replacement for the ``_games: dict[str, GameState]`` pattern.
Every route changes from:

    game = _games.get(game_id)       →  game = await store.get(game_id)
    # ... mutate ...                    # ... mutate ...
                                        await store.save(game)

The store maintains an in-memory cache for fast reads and writes through
to the database on every mutation.  Optimistic locking ensures multi-process
safety without distributed locks; within a process, callers serialize a
game's read-mutate-save with its lock (``app.api.game_locks``).

The database is the record: a game evicted from the cache (finished, or
idle — see ``routes.evict_idle_games``) is reloaded from it on the next get.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Optional

from app.game_engine.cards import Card
from app.game_engine.game_state import GameState, Phase
from app.storage.repository import GameRepository, OptimisticLockError
from app.storage.serializer import deserialize_game, serialize_game

logger = logging.getLogger(__name__)


class GameConflictError(Exception):
    """A save lost an optimistic-lock race; the change was not persisted.

    The stale cache entry is evicted, so the next get() reloads the game
    from the database.
    """


class GameStore:
    """In-memory cache backed by DB persistence."""

    def __init__(
        self,
        repo: GameRepository,
        card_registry: dict[str, Card],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._repo = repo
        self._card_registry = card_registry
        self._clock = clock
        # Cache: game_id → (GameState, db_version)
        self._cache: dict[str, tuple[GameState, int]] = {}
        # game_id → clock time of the last get/put/save
        self._last_access: dict[str, float] = {}
        # Cached games already recorded as finished in the DB
        self._finished: set[str] = set()

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    async def get(self, game_id: str) -> Optional[GameState]:
        """Get a game by ID. Cache-first, then DB."""
        # Check cache
        cached = self._cache.get(game_id)
        if cached is not None:
            self._touch(game_id)
            return cached[0]

        # Fetch from DB
        result = await self._repo.get(game_id)
        if result is None:
            return None

        # Another caller may have loaded (and since saved) the game while we
        # awaited the DB — keep theirs rather than overwrite it with an older
        # snapshot.
        cached = self._cache.get(game_id)
        if cached is not None:
            self._touch(game_id)
            return cached[0]

        snapshot, version = result
        game = deserialize_game(snapshot, self._card_registry)
        self._cache[game_id] = (game, version)
        if game.current_phase == Phase.GAME_OVER:
            self._finished.add(game_id)
        self._touch(game_id)
        return game

    def get_cached(self, game_id: str) -> Optional[GameState]:
        """Get a game from cache only (sync, no DB). Returns None if not cached.

        Doesn't count as access, so it never keeps an idle game in memory.
        """
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
        self._touch(game.id)

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    async def save(self, game: GameState) -> None:
        """Persist current game state to DB with optimistic locking.

        The first save after the game reaches GAME_OVER records it as
        finished (status, winner, final VP). Raises GameConflictError if the
        DB row moved on without us.
        """
        if game.current_phase == Phase.GAME_OVER and game.id not in self._finished:
            await self.finish(game)
            return

        cached = self._cache.get(game.id)
        if cached is None:
            raise GameConflictError(f"save() called for uncached game {game.id}")

        _, current_version = cached
        snapshot = serialize_game(game)

        try:
            new_version = await self._repo.save(
                game.id, snapshot, expected_version=current_version
            )
        except OptimisticLockError as e:
            self._conflict(game.id, current_version)
            raise GameConflictError(str(e)) from e
        self._cache[game.id] = (game, new_version)
        self._touch(game.id)

    async def finish(self, game: GameState) -> None:
        """Mark a game as finished, persist final state and player results."""
        cached = self._cache.get(game.id)
        if cached is None:
            raise GameConflictError(f"finish() called for uncached game {game.id}")

        _, current_version = cached
        snapshot = serialize_game(game)

        # Build player results
        from app.game_engine.game_state import compute_player_vp
        winners = set(game.winners or ([game.winner] if game.winner else []))
        player_results = [
            {
                "player_id": pid,
                "final_vp": compute_player_vp(game, pid),
                "is_winner": pid in winners,
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
        except OptimisticLockError as e:
            self._conflict(game.id, current_version)
            raise GameConflictError(str(e)) from e
        self._cache[game.id] = (game, new_version)
        self._finished.add(game.id)
        self._touch(game.id)

    def _conflict(self, game_id: str, version: int) -> None:
        logger.warning(
            "Optimistic lock conflict for game %s (version %d)", game_id, version,
        )
        # Evict the stale entry so the next get() reloads from DB
        self.evict(game_id)

    # ------------------------------------------------------------------
    # Remove / Abandon
    # ------------------------------------------------------------------

    def evict(self, game_id: str) -> None:
        """Remove a game from the in-memory cache (it stays in the DB)."""
        self._cache.pop(game_id, None)
        self._last_access.pop(game_id, None)
        self._finished.discard(game_id)

    async def abandon(self, game_id: str) -> None:
        """Mark a game as abandoned in DB and evict from cache."""
        await self._repo.abandon(game_id)
        self.evict(game_id)

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    def _touch(self, game_id: str) -> None:
        self._last_access[game_id] = self._clock()

    def idle_seconds(self, game_id: str) -> float:
        """Seconds since the cached game was last read or written."""
        last = self._last_access.get(game_id)
        return 0.0 if last is None else self._clock() - last

    def cached_game_ids(self) -> list[str]:
        """Return IDs of all games currently in cache."""
        return list(self._cache.keys())

    @property
    def repo(self) -> GameRepository:
        """Access the underlying repository (for analytics, etc.)."""
        return self._repo
