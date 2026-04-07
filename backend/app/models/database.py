"""Database configuration and session management.

Uses the storage engine factory for SQLite/PostgreSQL auto-detection.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.storage.engine import create_db_engine

# Module-level singletons — initialized by init_db()
engine: AsyncEngine | None = None
async_session: async_sessionmaker[AsyncSession] | None = None


def init_db(url: str | None = None) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """Initialize the database engine and session factory.

    Call once at application startup. Returns (engine, session_factory).
    """
    global engine, async_session
    engine, async_session = create_db_engine(url)
    return engine, async_session


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async session (for FastAPI dependency injection)."""
    if async_session is None:
        raise RuntimeError("Database not initialized — call init_db() first")
    async with async_session() as session:
        yield session
