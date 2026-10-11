"""Game state consistency under concurrency, and freeing memory from old games.

Covers: per-game locking (no lost updates between routes and the CPU buy
task), save conflicts surfacing instead of being ignored, the CPU-buy
timeout ending stragglers, finished games recorded in the DB, idle games
evicted from the cache (and reloaded from the DB), and started lobbies
expiring.
"""

from __future__ import annotations

import asyncio
import gc
from typing import Any, AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api import lobby as lobby_module
from app.api import routes
from app.api.game_locks import game_lock, game_lock_in_use
from app.game_engine.cards import Card
from app.game_engine.game_state import (
    GameState,
    Phase,
    advance_resolve,
    auto_play_cpu_plays,
    create_game,
    execute_start_of_turn,
    execute_upkeep,
    submit_play,
)
from app.game_engine.hex_grid import GridSize
from app.models.game import Base
from app.storage.game_store import GameConflictError, GameStore
from app.storage.repository import GameRepository


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class SlowSaveRepo(GameRepository):
    """Saves yield to the event loop, so concurrent writers overlap.

    ``save_delay`` waits before the write, ``ack_delay`` after it commits
    (a slow round trip back from the DB).
    """

    save_delay = 0.0
    ack_delay = 0.0

    async def save(self, game_id: str, state_snapshot: str, expected_version: int) -> int:
        await asyncio.sleep(self.save_delay)
        version = await super().save(game_id, state_snapshot, expected_version)
        await asyncio.sleep(self.ack_delay)
        return version


@pytest_asyncio.fixture
async def repo() -> AsyncIterator[SlowSaveRepo]:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:", connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield SlowSaveRepo(async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False))
    await engine.dispose()


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest_asyncio.fixture
async def store(
    repo: SlowSaveRepo, card_registry: dict[str, Card], clock: FakeClock,
) -> AsyncIterator[GameStore]:
    s = GameStore(repo, card_registry, clock=clock)
    routes.init_routes(s)
    lobby_module.init_lobby(s, lambda: card_registry)
    yield s
    routes._active_cpu_buy_tasks.clear()


def _new_game(card_registry: dict[str, Card], players: list[dict[str, Any]]) -> GameState:
    game = create_game(GridSize.SMALL, players, card_registry, seed=7)
    execute_start_of_turn(game)
    execute_upkeep(game)
    return game


def _to_buy_phase(game: GameState) -> None:
    for pid, p in game.players.items():
        if not p.is_cpu:
            submit_play(game, pid)
    auto_play_cpu_plays(game)
    for pid, p in game.players.items():
        if not p.is_cpu:
            advance_resolve(game, pid)
    assert game.current_phase == Phase.BUY


TWO_HUMANS = [
    {"id": "p0", "name": "Alice", "archetype": "vanguard"},
    {"id": "p1", "name": "Bob", "archetype": "swarm"},
]
HUMAN_AND_CPU = [
    {"id": "p0", "name": "Alice", "archetype": "vanguard"},
    {"id": "c1", "name": "Bot", "archetype": "swarm", "is_cpu": True, "cpu_difficulty": "easy"},
]


async def _reload(store: GameStore, game_id: str) -> GameState:
    """The game as the DB has it."""
    store.evict(game_id)
    game = await store.get(game_id)
    assert game is not None
    return game


# ── Locking: no lost updates ─────────────────────────────────


class TestNoLostUpdates:
    @pytest.mark.asyncio
    async def test_concurrent_routes_both_persist(
        self, store: GameStore, repo: SlowSaveRepo, card_registry: dict[str, Card],
    ) -> None:
        """Two players ending their buy phase at once: both changes reach the DB.

        Before routes held the game lock, both read the same cached game, the
        second save lost the optimistic-lock race, and its change vanished.
        """
        game = _new_game(card_registry, TWO_HUMANS)
        _to_buy_phase(game)
        await store.put(game)
        repo.save_delay = 0.02

        await asyncio.gather(
            routes.end_buy_route(game_id=game.id, req=routes.EndBuyRequest(player_id="p0")),
            routes.end_buy_route(game_id=game.id, req=routes.EndBuyRequest(player_id="p1")),
        )

        saved = await _reload(store, game.id)
        assert saved.current_round == 2  # both ended → the round moved on

    @pytest.mark.asyncio
    async def test_route_waits_for_cpu_buy_task_holding_the_lock(
        self, store: GameStore, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        _to_buy_phase(game)
        await store.put(game)

        lock = game_lock(game.id)
        await lock.acquire()  # as the CPU buy task does around each purchase
        route = asyncio.create_task(
            routes.end_buy_route(game_id=game.id, req=routes.EndBuyRequest(player_id="p0")),
        )
        await asyncio.sleep(0.01)
        assert not route.done()
        lock.release()
        await route
        assert "p0" in (await _reload(store, game.id)).players_done_buying


class TestGameLocks:
    def test_lock_lives_while_referenced(self) -> None:
        lock = game_lock("g-lock")
        assert game_lock("g-lock") is lock
        assert game_lock_in_use("g-lock")
        del lock
        gc.collect()
        assert not game_lock_in_use("g-lock")


# ── Store: conflicts, cache-miss race, finishing ─────────────


class TestGameStore:
    @pytest.mark.asyncio
    async def test_conflicting_save_raises_and_reloads(
        self, store: GameStore, repo: SlowSaveRepo, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        # Another process moves the row on.
        from app.storage.serializer import serialize_game
        await repo.save(game.id, serialize_game(game), expected_version=1)

        game.players["p0"].resources = 99
        with pytest.raises(GameConflictError):
            await store.save(game)
        assert store.get_cached(game.id) is None  # stale entry evicted
        reloaded = await store.get(game.id)
        assert reloaded is not None and reloaded.players["p0"].resources != 99

    @pytest.mark.asyncio
    async def test_cache_miss_load_does_not_overwrite_newer_game(
        self, store: GameStore, repo: SlowSaveRepo, card_registry: dict[str, Card],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        store.evict(game.id)

        release = asyncio.Event()
        real_get = repo.get
        calls = 0

        async def slow_first_get(game_id: str) -> Any:
            nonlocal calls
            calls += 1
            snapshot = await real_get(game_id)
            if calls == 1:
                await release.wait()  # this reader's DB read lands late
            return snapshot

        monkeypatch.setattr(repo, "get", slow_first_get)
        slow_reader = asyncio.create_task(store.get(game.id))
        await asyncio.sleep(0)
        fresh = await store.get(game.id)
        assert fresh is not None
        fresh.players["p0"].resources = 42
        await store.save(fresh)  # version 2

        release.set()
        assert await slow_reader is fresh  # not the version-1 snapshot
        fresh.players["p0"].resources = 43
        await store.save(fresh)  # would conflict if the cache held version 1

    @pytest.mark.asyncio
    async def test_game_over_save_records_finished_game(
        self, store: GameStore, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        game.current_phase = Phase.GAME_OVER
        game.winner = "p1"
        game.winners = ["p1"]
        await store.save(game)

        record = await store.repo.get_record(game.id)
        assert record is not None
        assert record.status == "finished"
        assert record.finished_at is not None

        # Saving again (e.g. a player leaving the game-over screen) keeps it finished.
        await store.save(game)
        record = await store.repo.get_record(game.id)
        assert record is not None and record.status == "finished"

    @pytest.mark.asyncio
    async def test_abandon_keeps_finished_result(
        self, store: GameStore, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        game.current_phase = Phase.GAME_OVER
        await store.save(game)
        await store.abandon(game.id)
        record = await store.repo.get_record(game.id)
        assert record is not None and record.status == "finished"


# ── CPU buy timeout ──────────────────────────────────────────


class TestCpuBuyTimeout:
    @pytest.mark.asyncio
    async def test_timed_out_cpus_are_ended(
        self, store: GameStore, card_registry: dict[str, Card], monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        game = _new_game(card_registry, HUMAN_AND_CPU)
        _to_buy_phase(game)
        await store.put(game)

        async def stuck_buy(_game_id: str, _pid: str) -> None:
            await asyncio.sleep(3600)

        monkeypatch.setattr(routes, "_process_single_cpu_buy", stuck_buy)
        monkeypatch.setattr(routes, "CPU_BUY_TIMEOUT_SECONDS", 0.05)
        await routes._process_cpu_buys_with_cursors(game.id)

        saved = await _reload(store, game.id)
        assert "c1" in saved.players_done_buying

    @pytest.mark.asyncio
    async def test_step_cancelled_mid_save_finishes_and_keeps_cache_in_step(
        self, store: GameStore, repo: SlowSaveRepo, card_registry: dict[str, Card],
    ) -> None:
        """The timeout cancels CPU coroutines; one cancelled mid-save used to
        commit without updating the cached version, so the next save conflicted."""
        game = _new_game(card_registry, HUMAN_AND_CPU)
        _to_buy_phase(game)
        await store.put(game)
        repo.ack_delay = 0.05  # cancel lands after the commit, before the cache update

        async def give_resources(g: GameState) -> GameState:
            g.players["c1"].resources = 77
            await store.save(g)
            return g

        step = asyncio.create_task(routes._cpu_buy_step(game.id, give_resources))
        await asyncio.sleep(0.01)
        step.cancel()
        # The human's route waits for the step's lock, then saves cleanly.
        await routes.end_buy_route(game_id=game.id, req=routes.EndBuyRequest(player_id="p0"))

        saved = await _reload(store, game.id)
        assert saved.players["c1"].resources == 77
        assert "p0" in saved.players_done_buying

    @pytest.mark.asyncio
    async def test_crashed_cpus_are_ended(
        self, store: GameStore, card_registry: dict[str, Card], monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        game = _new_game(card_registry, HUMAN_AND_CPU)
        _to_buy_phase(game)
        await store.put(game)

        async def broken_buy(_game_id: str, _pid: str) -> None:
            raise RuntimeError("boom")

        monkeypatch.setattr(routes, "_process_single_cpu_buy", broken_buy)
        await routes._process_cpu_buys_with_cursors(game.id)
        assert "c1" in (await _reload(store, game.id)).players_done_buying


# ── Evicting idle games ──────────────────────────────────────


class TestEviction:
    @pytest.mark.asyncio
    async def test_finished_game_evicted_after_grace_and_kept_in_db(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        game.current_phase = Phase.GAME_OVER
        game.winner = "p0"
        await store.save(game)

        clock.t += routes.FINISHED_GAME_CACHE_SECONDS - 1
        assert routes.evict_idle_games() == []
        clock.t += 2
        assert routes.evict_idle_games() == [game.id]
        assert store.cached_game_ids() == []

        # Still in the DB: a late return-to-lobby / log download reloads it.
        reloaded = await store.get(game.id)
        assert reloaded is not None
        assert reloaded.current_phase == Phase.GAME_OVER and reloaded.winner == "p0"

    @pytest.mark.asyncio
    async def test_idle_game_in_progress_evicted_and_resumable(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        game.players["p0"].resources = 7
        await store.save(game)

        clock.t += routes.FINISHED_GAME_CACHE_SECONDS + 1
        assert routes.evict_idle_games() == []  # in-progress games get longer
        clock.t += routes.IDLE_GAME_CACHE_SECONDS
        assert routes.evict_idle_games() == [game.id]

        resumed = await store.get(game.id)
        assert resumed is not None and resumed.players["p0"].resources == 7
        record = await store.repo.get_record(game.id)
        assert record is not None and record.status == "active"

    @pytest.mark.asyncio
    async def test_access_resets_idle_time(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        clock.t += routes.IDLE_GAME_CACHE_SECONDS - 10
        await store.get(game.id)
        clock.t += 20
        assert routes.evict_idle_games() == []

    @pytest.mark.asyncio
    async def test_game_in_use_not_evicted(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        clock.t += routes.IDLE_GAME_CACHE_SECONDS + 1
        async with game_lock(game.id):
            assert routes.evict_idle_games() == []
        gc.collect()
        assert routes.evict_idle_games() == [game.id]

    @pytest.mark.asyncio
    async def test_browse_does_not_reload_evicted_games(
        self, store: GameStore, card_registry: dict[str, Card],
    ) -> None:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        store.evict(game.id)
        lobby = lobby_module.Lobby(code="EVIC", host_id="p0", game_id=game.id, status="started")
        lobby_module._lobbies["EVIC"] = lobby
        try:
            assert (await lobby_module.browse_lobbies())["in_progress"] == []
            assert store.cached_game_ids() == []
        finally:
            lobby_module._lobbies.pop("EVIC", None)


# ── Lobby expiry ─────────────────────────────────────────────


class TestLobbyExpiry:
    @pytest.fixture(autouse=True)
    def clean_lobbies(self) -> Any:
        yield
        lobby_module._lobbies.clear()
        lobby_module._tokens.clear()
        lobby_module._game_to_lobby.clear()
        lobby_module._return_to_lobby_done.clear()

    async def _started_lobby(self, store: GameStore, card_registry: dict[str, Card], code: str) -> tuple[lobby_module.Lobby, GameState]:
        game = _new_game(card_registry, TWO_HUMANS)
        await store.put(game)
        lobby = lobby_module.Lobby(
            code=code, host_id="p0", players={
                "p0": lobby_module.LobbyPlayer(id="p0", name="Alice", archetype="vanguard", token="t0"),
            },
            game_id=game.id, status="started", last_activity=0.0,
        )
        lobby_module._lobbies[code] = lobby
        lobby_module._tokens[(code, "p0")] = "t0"
        lobby_module._game_to_lobby[game.id] = code
        return lobby, game

    @pytest.mark.asyncio
    async def test_idle_started_lobby_expires_and_game_is_abandoned(
        self, store: GameStore, card_registry: dict[str, Card],
    ) -> None:
        lobby, game = await self._started_lobby(store, card_registry, "IDLE")
        now = lobby_module._STARTED_LOBBY_EXPIRY_SECONDS + 1
        assert await lobby_module.expire_lobbies(now=now) == ["IDLE"]

        assert "IDLE" not in lobby_module._lobbies
        assert ("IDLE", "p0") not in lobby_module._tokens
        assert game.id not in lobby_module._game_to_lobby
        assert store.cached_game_ids() == []
        record = await store.repo.get_record(game.id)
        assert record is not None and record.status == "abandoned"

    @pytest.mark.asyncio
    async def test_started_lobby_kept_while_recent_or_connected(
        self, store: GameStore, card_registry: dict[str, Card], monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        lobby, game = await self._started_lobby(store, card_registry, "LIVE")
        recent = lobby_module._STARTED_LOBBY_EXPIRY_SECONDS - 1
        assert await lobby_module.expire_lobbies(now=recent) == []

        monkeypatch.setattr(lobby_module.manager, "get_player_ids", lambda _gid: ["p0"])
        later = lobby_module._STARTED_LOBBY_EXPIRY_SECONDS + 1
        assert await lobby_module.expire_lobbies(now=later) == []
        assert "LIVE" in lobby_module._lobbies

    @pytest.mark.asyncio
    async def test_expired_waiting_lobby_drops_old_game_mappings(self, store: GameStore) -> None:
        lobby = lobby_module.Lobby(code="BACK", host_id="p0", status="waiting", last_activity=0.0)
        lobby_module._lobbies["BACK"] = lobby
        lobby_module._game_to_lobby["old-game"] = "BACK"
        lobby_module._return_to_lobby_done["old-game"] = True

        assert await lobby_module.expire_lobbies(now=lobby_module._LOBBY_EXPIRY_SECONDS + 1) == ["BACK"]
        assert "old-game" not in lobby_module._game_to_lobby
        assert "old-game" not in lobby_module._return_to_lobby_done


# ── Live game cap ────────────────────────────────────────────


class TestLiveGameCap:
    @pytest.fixture(autouse=True)
    def cap_of_two(self, monkeypatch: pytest.MonkeyPatch) -> Any:
        monkeypatch.setattr(routes, "MAX_LIVE_GAMES", 2)
        yield
        lobby_module._lobbies.clear()
        lobby_module._tokens.clear()
        lobby_module._game_to_lobby.clear()

    async def _fill(self, store: GameStore, card_registry: dict[str, Card], n: int = 2) -> list[GameState]:
        games = [_new_game(card_registry, TWO_HUMANS) for _ in range(n)]
        for g in games:
            await store.put(g)
        return games

    @pytest.mark.asyncio
    async def test_full_server_refuses_new_games(
        self, store: GameStore, card_registry: dict[str, Card],
    ) -> None:
        await self._fill(store, card_registry)
        assert not routes.reserve_game_slot()
        req = routes.CreateGameRequest(players=TWO_HUMANS)
        with pytest.raises(routes.HTTPException) as e:
            await routes.create_new_game(req)
        assert e.value.status_code == 503
        assert len(store.cached_game_ids()) == 2

    @pytest.mark.asyncio
    async def test_finished_games_make_room_first(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        active, finished = await self._fill(store, card_registry)
        finished.current_phase = Phase.GAME_OVER
        await store.save(finished)
        clock.t += routes.MAKE_ROOM_MIN_IDLE_SECONDS + 1  # both idle; finished goes first

        result = await routes.create_new_game(routes.CreateGameRequest(players=TWO_HUMANS))
        cached = store.cached_game_ids()
        assert finished.id not in cached and active.id in cached
        assert result["game_id"] in cached
        record = await store.repo.get_record(finished.id)
        assert record is not None and record.status == "finished"  # still in the DB

    @pytest.mark.asyncio
    async def test_idle_games_make_room_but_recent_ones_dont(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        older, newer = await self._fill(store, card_registry)
        clock.t += routes.MAKE_ROOM_MIN_IDLE_SECONDS - 1
        assert not routes.has_room_for_game()  # nobody idle long enough

        clock.t += 2
        await store.get(newer.id)  # newer was just played
        assert routes.reserve_game_slot()
        routes.release_game_slot()
        assert store.cached_game_ids() == [newer.id]

    @pytest.mark.asyncio
    async def test_games_in_use_are_never_dropped_to_make_room(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        a, b = await self._fill(store, card_registry)
        clock.t += routes.MAKE_ROOM_MIN_IDLE_SECONDS + 1
        async with game_lock(a.id), game_lock(b.id):
            assert not routes.has_room_for_game()

    @pytest.mark.asyncio
    async def test_reserved_slots_count(
        self, store: GameStore, card_registry: dict[str, Card],
    ) -> None:
        await self._fill(store, card_registry, 1)
        assert routes.reserve_game_slot()  # a game being created
        try:
            assert not routes.has_room_for_game()
        finally:
            routes.release_game_slot()
        assert routes.has_room_for_game()

    @pytest.mark.asyncio
    async def test_sweep_trims_back_under_the_cap(
        self, store: GameStore, clock: FakeClock, card_registry: dict[str, Card],
    ) -> None:
        games = await self._fill(store, card_registry, 3)  # e.g. players reloading evicted games
        clock.t += routes.MAKE_ROOM_MIN_IDLE_SECONDS + 1
        await store.get(games[2].id)
        routes.evict_idle_games()
        assert len(store.cached_game_ids()) == 2
        assert games[2].id in store.cached_game_ids()

    def _lobby(self, code: str) -> lobby_module.Lobby:
        import time as _time
        lobby = lobby_module.Lobby(
            code=code, host_id="p0", players={
                "p0": lobby_module.LobbyPlayer(id="p0", name="Alice", archetype="vanguard", is_host=True, token="t0"),
                "p1": lobby_module.LobbyPlayer(id="p1", name="Bot", archetype="swarm", is_cpu=True),
            },
            created_at=_time.time(), last_activity=_time.time(),
        )
        lobby.config.grid_size = "small"
        lobby.config.grid_size_auto = False
        lobby_module._lobbies[code] = lobby
        lobby_module._tokens[(code, "p0")] = "t0"
        return lobby

    @pytest.mark.asyncio
    async def test_lobby_start_refused_before_countdown_when_full(
        self, store: GameStore, card_registry: dict[str, Card], monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        await self._fill(store, card_registry)
        lobby = self._lobby("FULL")
        sent: list[dict[str, Any]] = []

        async def record(_code: str, msg: dict[str, Any]) -> None:
            sent.append(msg)

        monkeypatch.setattr(lobby_module.manager, "broadcast", record)
        with pytest.raises(lobby_module.HTTPException) as e:
            await lobby_module.start_lobby("FULL", lobby_module.StartLobbyRequest(token="t0"))
        assert e.value.status_code == 503
        assert lobby.status == "waiting"
        assert not any(m["type"] == "countdown" for m in sent)

    @pytest.mark.asyncio
    async def test_lobby_back_to_waiting_if_server_fills_during_countdown(
        self, store: GameStore, card_registry: dict[str, Card], monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        await self._fill(store, card_registry, 1)
        lobby = self._lobby("RACE")
        sent: list[dict[str, Any]] = []

        async def record(_code: str, msg: dict[str, Any]) -> None:
            sent.append(msg)

        async def another_game_starts(_seconds: float) -> None:
            if len(store.cached_game_ids()) < 2:
                await self._fill(store, card_registry, 1)

        monkeypatch.setattr(lobby_module.manager, "broadcast", record)
        monkeypatch.setattr(lobby_module.asyncio, "sleep", another_game_starts)
        with pytest.raises(lobby_module.HTTPException) as e:
            await lobby_module.start_lobby("RACE", lobby_module.StartLobbyRequest(token="t0"))
        assert e.value.status_code == 503
        assert lobby.status == "waiting" and lobby.game_id is None
        assert {"type": "error", "message": routes.SERVER_FULL_MESSAGE} in sent
        assert routes._reserved_game_slots == 0

    @pytest.mark.asyncio
    async def test_lobby_starts_when_there_is_room(
        self, store: GameStore, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        lobby = self._lobby("ROOM")

        async def instant(_seconds: float) -> None:
            return None

        monkeypatch.setattr(lobby_module.asyncio, "sleep", instant)
        result = await lobby_module.start_lobby("ROOM", lobby_module.StartLobbyRequest(token="t0"))
        assert lobby.status == "started" and result["game_id"] in store.cached_game_ids()
        assert routes._reserved_game_slots == 0


class TestUnstartedLobbyExpiry:
    @pytest.fixture(autouse=True)
    def clean_lobbies(self) -> Any:
        yield
        lobby_module._lobbies.clear()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["waiting", "countdown"])
    async def test_expires_after_15_idle_minutes(self, store: GameStore, status: str) -> None:
        lobby_module._lobbies["IDLE"] = lobby_module.Lobby(
            code="IDLE", host_id="p0", status=status, last_activity=0.0,
        )
        assert await lobby_module.expire_lobbies(now=14 * 60) == []
        assert await lobby_module.expire_lobbies(now=15 * 60 + 1) == ["IDLE"]
        assert "IDLE" not in lobby_module._lobbies

    @pytest.mark.asyncio
    async def test_activity_resets_the_clock(self, store: GameStore) -> None:
        lobby = lobby_module.Lobby(code="BUSY", host_id="p0", last_activity=0.0)
        lobby_module._lobbies["BUSY"] = lobby
        lobby.last_activity = 10 * 60  # e.g. a player joined at minute 10
        assert await lobby_module.expire_lobbies(now=20 * 60) == []
        assert await lobby_module.expire_lobbies(now=25 * 60 + 1) == ["BUSY"]
