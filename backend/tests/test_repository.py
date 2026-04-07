"""Tests for GameRepository — CRUD + optimistic locking with SQLite in-memory."""

from __future__ import annotations

import json

import pytest
import pytest_asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.game import Base
from app.storage.repository import GameRepository, OptimisticLockError


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def session_factory():
    """Create an in-memory SQLite database with all tables."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory

    await engine.dispose()


@pytest_asyncio.fixture
async def repo(session_factory: async_sessionmaker[AsyncSession]):
    return GameRepository(session_factory)


def _make_snapshot(game_id: str = "test-game", round_num: int = 1) -> str:
    """Create a minimal fake game state JSON blob."""
    return json.dumps({
        "_schema_version": 1,
        "id": game_id,
        "current_round": round_num,
        "current_phase": "play",
    })


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestCreate:
    @pytest.mark.asyncio
    async def test_create_game(self, repo: GameRepository) -> None:
        record = await repo.create(
            "game-1",
            _make_snapshot("game-1"),
            map_seed="abc123",
            card_pack="everything",
            grid_size="small",
            player_count=2,
            players=[
                {"id": "p0", "name": "Alice", "archetype": "vanguard", "is_cpu": False},
                {"id": "p1", "name": "Bob", "archetype": "swarm", "is_cpu": True},
            ],
        )
        assert record.id == "game-1"
        assert record.version == 1
        assert record.status == "active"

    @pytest.mark.asyncio
    async def test_create_and_get(self, repo: GameRepository) -> None:
        await repo.create("game-2", _make_snapshot("game-2"))
        result = await repo.get("game-2")
        assert result is not None
        snapshot, version = result
        assert version == 1
        parsed = json.loads(snapshot)
        assert parsed["id"] == "game-2"

    @pytest.mark.asyncio
    async def test_get_nonexistent(self, repo: GameRepository) -> None:
        result = await repo.get("no-such-game")
        assert result is None


class TestOptimisticLocking:
    @pytest.mark.asyncio
    async def test_save_increments_version(self, repo: GameRepository) -> None:
        await repo.create("game-3", _make_snapshot("game-3"))
        new_version = await repo.save(
            "game-3", _make_snapshot("game-3", round_num=2), expected_version=1
        )
        assert new_version == 2

        result = await repo.get("game-3")
        assert result is not None
        _, version = result
        assert version == 2

    @pytest.mark.asyncio
    async def test_save_wrong_version_raises(self, repo: GameRepository) -> None:
        await repo.create("game-4", _make_snapshot("game-4"))
        # First save succeeds (version 1 → 2)
        await repo.save("game-4", _make_snapshot("game-4", 2), expected_version=1)

        # Second save with stale version 1 fails
        with pytest.raises(OptimisticLockError):
            await repo.save("game-4", _make_snapshot("game-4", 3), expected_version=1)

    @pytest.mark.asyncio
    async def test_multiple_sequential_saves(self, repo: GameRepository) -> None:
        await repo.create("game-5", _make_snapshot("game-5"))
        v = 1
        for i in range(2, 12):
            v = await repo.save("game-5", _make_snapshot("game-5", i), expected_version=v)
            assert v == i

        result = await repo.get("game-5")
        assert result is not None
        _, version = result
        assert version == 11


class TestFinish:
    @pytest.mark.asyncio
    async def test_finish_marks_game_complete(self, repo: GameRepository) -> None:
        await repo.create(
            "game-6",
            _make_snapshot("game-6"),
            players=[
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
        )
        new_version = await repo.finish(
            "game-6",
            _make_snapshot("game-6"),
            expected_version=1,
            winner_id="p0",
            player_results=[
                {"player_id": "p0", "final_vp": 12, "is_winner": True},
                {"player_id": "p1", "final_vp": 8, "is_winner": False},
            ],
        )
        assert new_version == 2

        record = await repo.get_record("game-6")
        assert record is not None
        assert record.status == "finished"
        assert record.finished_at is not None


class TestAbandon:
    @pytest.mark.asyncio
    async def test_abandon_game(self, repo: GameRepository) -> None:
        await repo.create("game-7", _make_snapshot("game-7"))
        await repo.abandon("game-7")

        record = await repo.get_record("game-7")
        assert record is not None
        assert record.status == "abandoned"


class TestListActive:
    @pytest.mark.asyncio
    async def test_list_active_games(self, repo: GameRepository) -> None:
        await repo.create("game-a", _make_snapshot("game-a"))
        await repo.create("game-b", _make_snapshot("game-b"))
        await repo.create("game-c", _make_snapshot("game-c"))
        await repo.abandon("game-b")

        active = await repo.list_active()
        active_ids = {g.id for g in active}
        assert "game-a" in active_ids
        assert "game-c" in active_ids
        assert "game-b" not in active_ids


class TestAnalytics:
    @pytest.mark.asyncio
    async def test_record_event(self, repo: GameRepository) -> None:
        await repo.create("game-8", _make_snapshot("game-8"))
        await repo.record_event(
            "game-8", "p0", "card_played", round_number=1,
            card_id="vanguard_assault", card_name="Assault",
        )
        # No exception = success (we don't query events back yet)

    @pytest.mark.asyncio
    async def test_increment_and_get_stats(self, repo: GameRepository) -> None:
        await repo.increment_stat("total_cards_played", 5)
        await repo.increment_stat("total_games_finished", 1)
        await repo.increment_stat("total_cards_played", 3)

        stats = await repo.get_stats()
        assert stats["total_cards_played"] == 8
        assert stats["total_games_finished"] == 1

    @pytest.mark.asyncio
    async def test_increment_new_stat(self, repo: GameRepository) -> None:
        await repo.increment_stat("new_counter", 42)
        stats = await repo.get_stats()
        assert stats["new_counter"] == 42
