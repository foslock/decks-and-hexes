"""FastAPI application entry point."""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router, _get_card_registry, game_cache_sweep_task, init_routes
from app.api.lobby import lobby_router, init_lobby, lobby_expiry_task
from app.api.solo import solo_router
from app.models.game import Base
from app.storage.engine import create_db_engine, is_sqlite
from app.storage.analytics import AnalyticsRecorder
from app.storage.game_store import GameConflictError, GameStore
from app.storage.repository import GameRepository

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Startup: initialize DB, run migrations, create GameStore
    engine, session_factory = create_db_engine()

    # Create tables directly for SQLite (avoids needing alembic for dev).
    # For PostgreSQL, use `alembic upgrade head` in deployment.
    if is_sqlite(str(engine.url)):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("SQLite tables created/verified")
    else:
        logger.info("PostgreSQL detected — ensure migrations are applied via `alembic upgrade head`")

    # Build card registry, GameStore, and AnalyticsRecorder
    registry = _get_card_registry()
    repo = GameRepository(session_factory)
    store = GameStore(repo, registry)
    analytics = AnalyticsRecorder(repo)

    # Wire store and analytics into routes and lobby
    init_routes(store, analytics)
    init_lobby(store, _get_card_registry)

    # Background tasks: expire idle lobbies, drop idle games from memory
    tasks = [
        asyncio.create_task(lobby_expiry_task()),
        asyncio.create_task(game_cache_sweep_task()),
    ]
    logger.info("Card Clash backend started (DB: %s)", engine.url)

    yield

    # Shutdown
    for task in tasks:
        task.cancel()
    await engine.dispose()


app = FastAPI(title="Card Clash", version="0.2.10", lifespan=lifespan)


@app.exception_handler(GameConflictError)
async def game_conflict_handler(_request: Request, exc: GameConflictError) -> JSONResponse:
    """A save lost a race with another writer: nothing was saved; refetch."""
    return JSONResponse(status_code=409, content={"detail": "Game changed — please refresh"})

# CORS — allow frontend origins (dev + Render)
origins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://cardclash.online",
    "https://card-clash-frontend.onrender.com",
]
# Allow additional frontend domains if configured
frontend_url = os.environ.get("FRONTEND_URL")
if frontend_url and frontend_url not in origins:
    origins.append(frontend_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(lobby_router)
app.include_router(solo_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/version")
async def version() -> dict[str, str]:
    return {"version": app.version}
