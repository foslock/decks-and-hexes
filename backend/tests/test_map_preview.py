"""Lobby map preview: the map the game will start on, with each seat's base."""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.api import lobby as lobby_module
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


@pytest.fixture
def no_countdown(monkeypatch: pytest.MonkeyPatch) -> None:
    async def instant(_seconds: float) -> None:
        return None
    monkeypatch.setattr(lobby_module.asyncio, "sleep", instant)


def _lobby_with_cpus(client: TestClient, cpus: int) -> dict[str, Any]:
    res = client.post("/api/lobby/create", json={"name": "Hosty", "archetype": "vanguard"})
    lob: dict[str, Any] = res.json()
    for _ in range(cpus):
        client.post(f"/api/lobby/{lob['code']}/cpu", json={"archetype": "swarm", "token": lob["token"]})
    return lob


def _preview(client: TestClient, lob: dict[str, Any]) -> dict[str, Any]:
    res = client.get(f"/api/lobby/{lob['code']}/map-preview",
                     params={"player_id": lob["player_id"], "token": lob["token"]})
    assert res.status_code == 200
    data: dict[str, Any] = res.json()
    return data


def _bases(tiles: dict[str, Any]) -> dict[str, str]:
    return {k: t["base_owner"] for k, t in tiles.items() if t["is_base"]}


def test_preview_has_a_base_per_player_in_seat_order(client: TestClient) -> None:
    lob = _lobby_with_cpus(client, 2)
    data = _preview(client, lob)
    assert data["grid_size"] == "large"  # suggested for 3 players
    assert data["map_name"] == "Rings"
    assert len(data["tiles"]) == 127
    assert data["seats"][0] == lob["player_id"]
    assert sorted(_bases(data["tiles"]).values()) == sorted(data["seats"])


def test_preview_follows_size_and_player_count(client: TestClient) -> None:
    lob = _lobby_with_cpus(client, 4)
    client.patch(f"/api/lobby/{lob['code']}/config", json={"grid_size": "large", "token": lob["token"]})
    data = _preview(client, lob)
    assert len(data["tiles"]) == 127
    assert len(_bases(data["tiles"])) == 5


def test_preview_matches_the_started_game(client: TestClient, no_countdown: None) -> None:
    lob = _lobby_with_cpus(client, 3)
    preview = _preview(client, lob)
    res = client.post(f"/api/lobby/{lob['code']}/start", json={"token": lob["token"]})
    tiles = res.json()["state"]["grid"]["tiles"]
    assert _bases(tiles) == _bases(preview["tiles"])
    for key, t in preview["tiles"].items():
        assert (t["is_blocked"], t["is_vp"], t["vp_value"]) == (tiles[key]["is_blocked"], tiles[key]["is_vp"], tiles[key]["vp_value"])


def test_preview_needs_a_member_token(client: TestClient) -> None:
    lob = _lobby_with_cpus(client, 1)
    res = client.get(f"/api/lobby/{lob['code']}/map-preview", params={"player_id": lob["player_id"], "token": "nope"})
    assert res.status_code in (401, 403)
