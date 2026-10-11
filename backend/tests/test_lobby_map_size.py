"""The lobby suggests a map size for its player count (long enough games:
11+ rounds) until the host picks one."""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.api import lobby as lobby_module
from app.game_engine.game_state import SUGGESTED_GRID, suggested_grid_size
from app.game_engine.hex_grid import GridSize
from app.main import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def clear_lobbies() -> Iterator[None]:
    lobby_module._lobbies.clear()
    yield
    lobby_module._lobbies.clear()


def _create(client: TestClient) -> dict[str, Any]:
    res = client.post("/api/lobby/create", json={"name": "Hosty", "archetype": "vanguard"})
    assert res.status_code == 200
    data: dict[str, Any] = res.json()
    return data


def _config(client: TestClient, lob: dict[str, Any]) -> dict[str, Any]:
    return lobby_module._lobbies[lob["code"]].to_dict()["config"]  # type: ignore[no-any-return]


def _add_cpu(client: TestClient, lob: dict[str, Any]) -> None:
    res = client.post(f"/api/lobby/{lob['code']}/cpu", json={"archetype": "swarm", "token": lob["token"]})
    assert res.status_code == 200


def test_suggested_sizes():
    assert [suggested_grid_size(n) for n in range(1, 8)] == [
        GridSize.LARGE, GridSize.LARGE, GridSize.LARGE, GridSize.MEDIUM,
        GridSize.LARGE, GridSize.LARGE, GridSize.LARGE,
    ]
    assert set(SUGGESTED_GRID) == {2, 3, 4, 5, 6}


def test_lobby_map_follows_the_player_count(client: TestClient) -> None:
    lob = _create(client)
    assert _config(client, lob)["grid_size"] == "large"  # the host alone plays as 2
    for _ in range(3):
        _add_cpu(client, lob)
    cfg = _config(client, lob)
    assert (cfg["grid_size"], cfg["suggested_grid_size"], cfg["grid_size_auto"]) == ("medium", "medium", True)
    _add_cpu(client, lob)
    assert _config(client, lob)["grid_size"] == "large"


def test_a_size_the_host_picks_sticks_until_reset(client: TestClient) -> None:
    lob = _create(client)
    res = client.patch(f"/api/lobby/{lob['code']}/config", json={"grid_size": "small", "token": lob["token"]})
    assert res.status_code == 200
    for _ in range(3):
        _add_cpu(client, lob)
    cfg = _config(client, lob)
    assert (cfg["grid_size"], cfg["suggested_grid_size"], cfg["grid_size_auto"]) == ("small", "medium", False)
    client.patch(f"/api/lobby/{lob['code']}/config", json={"grid_size_auto": True, "token": lob["token"]})
    assert _config(client, lob)["grid_size"] == "medium"


def test_map_preview_uses_the_lobby_size(client: TestClient) -> None:
    lob = _create(client)
    _add_cpu(client, lob)
    res = client.get(f"/api/lobby/{lob['code']}/map-preview", params={"player_id": lob["player_id"], "token": lob["token"]})
    assert res.status_code == 200
    assert res.json()["grid_size"] == "large"
