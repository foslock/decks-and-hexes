"""Lobby browser (public lobbies + games in progress) and player-name filtering."""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.api import lobby as lobby_module
from app.api.name_filter import is_name_allowed
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
    """Skip the 3-second start countdown."""
    async def instant(_seconds: float) -> None:
        return None
    monkeypatch.setattr(lobby_module.asyncio, "sleep", instant)


def _create(client: TestClient, name: str = "Hosty") -> dict[str, Any]:
    res = client.post("/api/lobby/create", json={"name": name, "archetype": "vanguard"})
    assert res.status_code == 200
    data: dict[str, Any] = res.json()
    return data


def _browse(client: TestClient) -> dict[str, Any]:
    res = client.get("/api/lobby/browse")
    assert res.status_code == 200
    data: dict[str, Any] = res.json()
    return data


class TestBrowse:
    def test_lists_public_lobbies_with_host_map_pack_and_counts(self, client: TestClient) -> None:
        lob = _create(client)
        client.post(f"/api/lobby/{lob['code']}/cpu", json={"archetype": "swarm", "token": lob["token"]})
        open_ = _browse(client)["open"]
        assert len(open_) == 1
        entry = open_[0]
        assert entry["code"] == lob["code"]
        assert entry["host_name"] == "Hosty"
        assert entry["grid_size"] == "medium"
        assert entry["card_pack_name"]
        assert (entry["players"], entry["humans"], entry["cpus"]) == (2, 1, 1)
        assert entry["full"] is False

    def test_open_to_public_defaults_on_and_hides_when_off(self, client: TestClient) -> None:
        lob = _create(client)
        assert lob["lobby"]["config"]["open_to_public"] is True
        res = client.patch(f"/api/lobby/{lob['code']}/config", json={"open_to_public": False, "token": lob["token"]})
        assert res.json()["lobby"]["config"]["open_to_public"] is False
        assert _browse(client)["open"] == []
        client.patch(f"/api/lobby/{lob['code']}/config", json={"open_to_public": True, "token": lob["token"]})
        assert len(_browse(client)["open"]) == 1

    def test_started_game_moves_to_in_progress(self, client: TestClient, no_countdown: None) -> None:
        lob = _create(client)
        client.post(f"/api/lobby/{lob['code']}/cpu", json={"archetype": "swarm", "token": lob["token"]})
        res = client.post(f"/api/lobby/{lob['code']}/start", json={"token": lob["token"]})
        assert res.status_code == 200
        data = _browse(client)
        assert data["open"] == []
        assert len(data["in_progress"]) == 1
        game = data["in_progress"][0]
        assert game["host_name"] == "Hosty"
        assert game["round"] >= 1
        assert (game["players"], game["cpus"]) == (2, 1)
        assert game["leaders"] and all("vp" in l and "name" in l for l in game["leaders"])

    def test_private_game_in_progress_is_hidden(self, client: TestClient, no_countdown: None) -> None:
        lob = _create(client)
        client.post(f"/api/lobby/{lob['code']}/cpu", json={"archetype": "swarm", "token": lob["token"]})
        client.patch(f"/api/lobby/{lob['code']}/config", json={"open_to_public": False, "token": lob["token"]})
        client.post(f"/api/lobby/{lob['code']}/start", json={"token": lob["token"]})
        assert _browse(client) == {"open": [], "in_progress": []}


class TestNameFiltering:
    def test_create_replaces_a_vulgar_name(self, client: TestClient) -> None:
        lob = _create(client, name="sh1thead")
        host = lob["lobby"]["players"][lob["player_id"]]
        assert host["name"] == "Player 1"

    def test_join_replaces_a_hateful_name(self, client: TestClient) -> None:
        lob = _create(client)
        res = client.post(f"/api/lobby/{lob['code']}/join", json={"name": "Hitler", "archetype": "swarm"})
        joined = res.json()
        assert joined["lobby"]["players"][joined["player_id"]]["name"].startswith("Player ")

    def test_rename_rejects_and_keeps_the_old_name(self, client: TestClient) -> None:
        lob = _create(client)
        res = client.patch(
            f"/api/lobby/{lob['code']}/player/{lob['player_id']}",
            json={"name": "F U C K", "token": lob["token"]},
        )
        assert res.status_code == 400
        assert "name" in res.json()["detail"].lower()
        state = client.get(f"/api/lobby/{lob['code']}", params={"player_id": lob["player_id"], "token": lob["token"]})
        assert state.json()["lobby"]["players"][lob["player_id"]]["name"] == "Hosty"

    def test_rename_allows_a_clean_name(self, client: TestClient) -> None:
        lob = _create(client)
        res = client.patch(
            f"/api/lobby/{lob['code']}/player/{lob['player_id']}",
            json={"name": "Yamashita", "token": lob["token"]},
        )
        assert res.status_code == 200


@pytest.mark.parametrize("name", [
    "fuck", "f.u.c.k", "fuuuck", "sh1t", "a$$", "A S S", "BigDick", "cunt", "n1gger",
    "Faggot", "Hitler", "KKK", "1488", "nazi", "retard", "WhitePower", "b1tch", "Tits",
    "kys", "Rapist", "Wanker", "damn",
])
def test_filter_blocks(name: str) -> None:
    assert not is_name_allowed(name)


@pytest.mark.parametrize("name", [
    "Player 1", "Alice", "Cassidy", "Dickens", "Hancock", "Scunthorpe", "Therapist",
    "Shiitake", "Yamashita", "Fukuda", "Swank", "Spicy", "Spicer", "Thorny", "Sussex",
    "Bass", "Assassin", "Cumberland", "Titan", "Analyst", "Japan", "Nigel", "Homer",
    "Raccoon", "Chinese", "Hitchens", "",
])
def test_filter_allows(name: str) -> None:
    assert is_name_allowed(name)


class TestTokensPerLobby:
    """Player ids repeat across lobbies (every host is player_0): tokens must
    be scoped to their lobby."""

    def test_a_second_lobby_does_not_invalidate_the_first_hosts_token(self, client: TestClient) -> None:
        first = _create(client, name="First")
        _create(client, name="Second")
        res = client.post(f"/api/lobby/{first['code']}/cpu", json={"archetype": "swarm", "token": first["token"]})
        assert res.status_code == 200

    def test_one_lobbys_host_token_cannot_control_another(self, client: TestClient) -> None:
        first = _create(client, name="First")
        second = _create(client, name="Second")
        res = client.post(f"/api/lobby/{second['code']}/cpu", json={"archetype": "swarm", "token": first["token"]})
        assert res.status_code == 403
        res = client.post(f"/api/lobby/{second['code']}/close", json={"token": first["token"]})
        assert res.status_code == 403
