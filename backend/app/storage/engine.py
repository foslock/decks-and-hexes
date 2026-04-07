"""Database engine factory — detects SQLite vs PostgreSQL from DATABASE_URL.

Usage:
    engine, session_factory = create_db_engine()
    # or with explicit URL:
    engine, session_factory = create_db_engine("sqlite+aiosqlite:///./cardclash.db")
"""

from __future__ import annotations

import os

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Default: SQLite for local dev (file in backend dir)
_DEFAULT_URL = "sqlite+aiosqlite:///./card_clash.db"


def get_database_url() -> str:
    """Resolve the database URL from environment.

    Priority:
    1. DATABASE_URL env var (production — Render, Railway, etc.)
    2. Default SQLite file for local dev
    """
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        return _DEFAULT_URL

    # Render.com provides postgres:// but asyncpg needs postgresql+asyncpg://
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif url.startswith("postgresql://") and "+asyncpg" not in url:
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)

    return url


def is_sqlite(url: str) -> bool:
    """Check if a database URL points to SQLite."""
    return url.startswith("sqlite")


def create_db_engine(
    url: str | None = None,
) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """Create an async SQLAlchemy engine and session factory.

    Automatically configures for SQLite or PostgreSQL based on the URL.
    """
    if url is None:
        url = get_database_url()

    kwargs: dict[str, object] = {"echo": False}

    if is_sqlite(url):
        # SQLite needs check_same_thread=False for async
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        # PostgreSQL connection pool settings
        kwargs["pool_size"] = 5
        kwargs["max_overflow"] = 10

    engine = create_async_engine(url, **kwargs)
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    return engine, session_factory
