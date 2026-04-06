"""FastAPI application entry point."""

import asyncio
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router, _games, _get_card_registry
from app.api.lobby import lobby_router, init_lobby, lobby_expiry_task


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Startup
    task = asyncio.create_task(lobby_expiry_task())
    yield
    # Shutdown
    task.cancel()


app = FastAPI(title="Card Clash", version="0.1.2", lifespan=lifespan)

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

# Initialize lobby module with shared game storage
init_lobby(_games, _get_card_registry)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/version")
async def version() -> dict[str, str]:
    return {"version": app.version}
