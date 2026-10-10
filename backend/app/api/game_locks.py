"""Per-game asyncio locks.

Every read-mutate-save of a game holds its lock. Routes, the background CPU
buy task and the lobby's leave/end handlers all mutate the same cached
GameState, and each save is an ``await`` — without the lock two of them
interleave, both save against the same version, and the loser's change is
dropped.
"""

from __future__ import annotations

import asyncio
import functools
import weakref
from typing import Any, Awaitable, Callable, TypeVar

# Weak values: a lock lives exactly as long as something holds or awaits it,
# so nothing has to drop locks by hand (dropping one while a coroutine holds
# it would let the next caller make a second lock for the same game), and
# finished games leave none behind.
_game_locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = weakref.WeakValueDictionary()

T = TypeVar("T")


def game_lock(game_id: str) -> asyncio.Lock:
    """The lock serializing mutations of *game_id*."""
    lock = _game_locks.get(game_id)
    if lock is None:
        lock = asyncio.Lock()
        _game_locks[game_id] = lock
    return lock


def game_lock_in_use(game_id: str) -> bool:
    """True while anything holds, awaits or keeps the game's lock."""
    return _game_locks.get(game_id) is not None


def locked_game_route(fn: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
    """Run a ``/games/{game_id}/...`` route holding that game's lock."""
    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> T:
        async with game_lock(kwargs["game_id"]):
            return await fn(*args, **kwargs)
    return wrapper
