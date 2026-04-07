"""GameRepository — CRUD operations with optimistic locking.

All database I/O for game records lives here.  The repository works
with raw JSON blobs (strings) — serialization is the caller's job.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import CursorResult, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.game import (
    AggregateStatRecord,
    GameEventRecord,
    GamePlayerRecord,
    GameRecord,
)


class OptimisticLockError(Exception):
    """Raised when an optimistic-lock UPDATE matches 0 rows."""
    pass


class GameRepository:
    """CRUD for card_clash_games with optimistic locking."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    async def get(self, game_id: str) -> Optional[tuple[str, int]]:
        """Fetch a game's (state_snapshot, version) or None."""
        async with self._session_factory() as session:
            row = await session.get(GameRecord, game_id)
            if row is None:
                return None
            return (row.state_snapshot, row.version)  # type: ignore[return-value]

    async def get_record(self, game_id: str) -> Optional[GameRecord]:
        """Fetch the full GameRecord row."""
        async with self._session_factory() as session:
            return await session.get(GameRecord, game_id)

    async def list_active(self, limit: int = 50) -> list[GameRecord]:
        """List active games, most recent first."""
        async with self._session_factory() as session:
            stmt = (
                select(GameRecord)
                .where(GameRecord.status == "active")
                .order_by(GameRecord.updated_at.desc())
                .limit(limit)
            )
            result = await session.execute(stmt)
            return list(result.scalars().all())

    # ------------------------------------------------------------------
    # Create
    # ------------------------------------------------------------------

    async def create(
        self,
        game_id: str,
        state_snapshot: str,
        *,
        map_seed: str = "",
        card_pack: str = "everything",
        grid_size: str = "small",
        player_count: int = 2,
        players: Optional[list[dict[str, Any]]] = None,
    ) -> GameRecord:
        """Insert a new game record. Returns the created row."""
        async with self._session_factory() as session:
            record = GameRecord(
                id=game_id,
                state_snapshot=state_snapshot,
                version=1,
                status="active",
                map_seed=map_seed,
                card_pack=card_pack,
                grid_size=grid_size,
                player_count=player_count,
            )
            session.add(record)

            # Insert player records
            if players:
                for p in players:
                    session.add(GamePlayerRecord(
                        game_id=game_id,
                        player_id=p["id"],
                        player_name=p.get("name", ""),
                        archetype=p.get("archetype", ""),
                        is_cpu=p.get("is_cpu", False),
                    ))

            await session.commit()
            return record

    # ------------------------------------------------------------------
    # Update (optimistic locking)
    # ------------------------------------------------------------------

    async def save(
        self,
        game_id: str,
        state_snapshot: str,
        expected_version: int,
    ) -> int:
        """Update game state with optimistic locking.

        Returns the new version number.
        Raises OptimisticLockError if the version doesn't match
        (another process modified the game).
        """
        new_version = expected_version + 1
        async with self._session_factory() as session:
            stmt = (
                update(GameRecord)
                .where(
                    GameRecord.id == game_id,
                    GameRecord.version == expected_version,
                )
                .values(
                    state_snapshot=state_snapshot,
                    version=new_version,
                    updated_at=datetime.now(timezone.utc),
                )
            )
            cursor_result: CursorResult[Any] = await session.execute(stmt)  # type: ignore[assignment]
            if cursor_result.rowcount == 0:
                await session.rollback()
                raise OptimisticLockError(
                    f"Game {game_id}: expected version {expected_version}, "
                    f"but row was modified by another process"
                )
            await session.commit()
            return new_version

    async def finish(
        self,
        game_id: str,
        state_snapshot: str,
        expected_version: int,
        winner_id: Optional[str] = None,
        player_results: Optional[list[dict[str, Any]]] = None,
    ) -> int:
        """Mark a game as finished, update final VP / winner info.

        Returns the new version number.
        """
        new_version = expected_version + 1
        now = datetime.now(timezone.utc)
        async with self._session_factory() as session:
            stmt = (
                update(GameRecord)
                .where(
                    GameRecord.id == game_id,
                    GameRecord.version == expected_version,
                )
                .values(
                    state_snapshot=state_snapshot,
                    version=new_version,
                    status="finished",
                    updated_at=now,
                    finished_at=now,
                )
            )
            cursor_result: CursorResult[Any] = await session.execute(stmt)  # type: ignore[assignment]
            if cursor_result.rowcount == 0:
                await session.rollback()
                raise OptimisticLockError(
                    f"Game {game_id}: version conflict on finish"
                )

            # Update player records with final results
            if player_results:
                for pr in player_results:
                    await session.execute(
                        update(GamePlayerRecord)
                        .where(
                            GamePlayerRecord.game_id == game_id,
                            GamePlayerRecord.player_id == pr["player_id"],
                        )
                        .values(
                            final_vp=pr.get("final_vp"),
                            is_winner=pr.get("is_winner", False),
                        )
                    )

            await session.commit()
            return new_version

    async def abandon(self, game_id: str) -> None:
        """Mark a game as abandoned (e.g. all players left)."""
        async with self._session_factory() as session:
            stmt = (
                update(GameRecord)
                .where(GameRecord.id == game_id)
                .values(
                    status="abandoned",
                    updated_at=datetime.now(timezone.utc),
                )
            )
            await session.execute(stmt)
            await session.commit()

    # ------------------------------------------------------------------
    # Analytics events
    # ------------------------------------------------------------------

    async def record_event(
        self,
        game_id: str,
        player_id: str,
        event_type: str,
        round_number: int,
        card_id: Optional[str] = None,
        card_name: Optional[str] = None,
        detail_json: Optional[str] = None,
    ) -> None:
        """Append an analytics event."""
        async with self._session_factory() as session:
            session.add(GameEventRecord(
                game_id=game_id,
                player_id=player_id,
                event_type=event_type,
                round_number=round_number,
                card_id=card_id,
                card_name=card_name,
                detail_json=detail_json,
            ))
            await session.commit()

    async def increment_stat(self, stat_key: str, amount: int = 1) -> None:
        """Increment an aggregate stat counter (upsert)."""
        async with self._session_factory() as session:
            # Try update first
            stmt = (
                update(AggregateStatRecord)
                .where(AggregateStatRecord.stat_key == stat_key)
                .values(
                    stat_value=AggregateStatRecord.stat_value + amount,
                    updated_at=datetime.now(timezone.utc),
                )
            )
            cursor_result: CursorResult[Any] = await session.execute(stmt)  # type: ignore[assignment]
            if cursor_result.rowcount == 0:
                # Insert new
                session.add(AggregateStatRecord(
                    stat_key=stat_key,
                    stat_value=amount,
                ))
            await session.commit()

    async def get_stats(self) -> dict[str, int]:
        """Fetch all aggregate stats as {key: value}."""
        async with self._session_factory() as session:
            stmt = select(AggregateStatRecord)
            result = await session.execute(stmt)
            rows = result.scalars().all()
            return {
                str(row.stat_key): int(row.stat_value)
                for row in rows
            }
