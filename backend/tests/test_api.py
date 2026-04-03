"""Tests for FastAPI REST endpoints."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api.routes import _games


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def clear_games() -> None:
    """Clear in-memory game store between tests."""
    _games.clear()


class TestHealthEndpoint:
    def test_health(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestCreateGame:
    def test_create_game(self, client: TestClient) -> None:
        resp = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "game_id" in data
        assert "state" in data
        state = data["state"]
        assert state["current_phase"] == "plan"
        assert state["current_round"] == 1
        assert len(state["players"]) == 2

    def test_create_game_invalid_grid_size(self, client: TestClient) -> None:
        resp = client.post("/api/games", json={
            "grid_size": "tiny",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
        })
        assert resp.status_code == 400

    def test_create_game_invalid_archetype(self, client: TestClient) -> None:
        resp = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "wizard"},
            ],
        })
        assert resp.status_code == 400

    def test_create_medium_3p_game(self, client: TestClient) -> None:
        resp = client.post("/api/games", json={
            "grid_size": "medium",
            "players": [
                {"id": "p0", "name": "A", "archetype": "vanguard"},
                {"id": "p1", "name": "B", "archetype": "swarm"},
                {"id": "p2", "name": "C", "archetype": "fortress"},
            ],
        })
        assert resp.status_code == 200
        state = resp.json()["state"]
        assert len(state["players"]) == 3


class TestGetGame:
    def test_get_game(self, client: TestClient) -> None:
        create = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        game_id = create.json()["game_id"]
        resp = client.get(f"/api/games/{game_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == game_id

    def test_get_game_not_found(self, client: TestClient) -> None:
        resp = client.get("/api/games/nonexistent")
        assert resp.status_code == 404

    def test_get_game_hides_hand(self, client: TestClient) -> None:
        create = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        game_id = create.json()["game_id"]
        resp = client.get(f"/api/games/{game_id}?player_id=p0")
        data = resp.json()
        assert len(data["players"]["p0"]["hand"]) > 0
        assert len(data["players"]["p1"]["hand"]) == 0


class TestPlayCard:
    def _create_game(self, client: TestClient) -> str:
        resp = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        return resp.json()["game_id"]

    def test_play_card(self, client: TestClient) -> None:
        game_id = self._create_game(client)
        state = client.get(f"/api/games/{game_id}?player_id=p0").json()

        # Find a claim card and a compatible adjacent empty tile (defense <= card power)
        hand = state["players"]["p0"]["hand"]
        tiles = state["grid"]["tiles"]
        owned = [t for t in tiles.values() if t["owner"] == "p0"]
        directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]
        claim_idx = None
        target = None
        for card in hand:
            if card["card_type"] != "claim":
                continue
            for ot in owned:
                for dq, dr in directions:
                    nk = f"{ot['q'] + dq},{ot['r'] + dr}"
                    if (nk in tiles and not tiles[nk]["is_blocked"]
                            and tiles[nk]["owner"] is None
                            and tiles[nk]["defense_power"] <= card["power"]):
                        claim_idx = hand.index(card)
                        target = tiles[nk]
                        break
                if target:
                    break
            if target:
                break

        assert target is not None and claim_idx is not None
        resp = client.post(f"/api/games/{game_id}/play", json={
            "player_id": "p0",
            "card_index": claim_idx,
            "target_q": target["q"],
            "target_r": target["r"],
        })
        assert resp.status_code == 200

    def test_play_card_game_not_found(self, client: TestClient) -> None:
        resp = client.post("/api/games/bad/play", json={
            "player_id": "p0",
            "card_index": 0,
        })
        assert resp.status_code == 404


class TestSubmitPlan:
    def _create_game(self, client: TestClient) -> str:
        resp = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        return resp.json()["game_id"]

    def test_submit_plan(self, client: TestClient) -> None:
        game_id = self._create_game(client)
        resp = client.post(f"/api/games/{game_id}/submit-plan", json={
            "player_id": "p0",
        })
        assert resp.status_code == 200

    def test_both_submit_advances_phase(self, client: TestClient) -> None:
        game_id = self._create_game(client)
        client.post(f"/api/games/{game_id}/submit-plan", json={"player_id": "p0"})
        resp = client.post(f"/api/games/{game_id}/submit-plan", json={"player_id": "p1"})
        state = resp.json()["state"]
        assert state["current_phase"] == "buy"


class TestBuyAndEndTurn:
    def _create_and_advance_to_buy(self, client: TestClient) -> str:
        resp = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        game_id = resp.json()["game_id"]
        client.post(f"/api/games/{game_id}/submit-plan", json={"player_id": "p0"})
        client.post(f"/api/games/{game_id}/submit-plan", json={"player_id": "p1"})
        return game_id

    def test_end_turn(self, client: TestClient) -> None:
        game_id = self._create_and_advance_to_buy(client)
        # First player ends turn — still in buy phase
        resp = client.post(f"/api/games/{game_id}/end-turn", json={"player_id": "p0"})
        assert resp.status_code == 200
        state = resp.json()["state"]
        assert state["current_phase"] == "buy"
        assert state["players"]["p0"]["has_ended_turn"] is True
        assert state["players"]["p1"]["has_ended_turn"] is False
        # Second player ends turn — advances to next round
        resp = client.post(f"/api/games/{game_id}/end-turn", json={"player_id": "p1"})
        assert resp.status_code == 200
        state = resp.json()["state"]
        assert state["current_round"] == 2
        # Round 2+ enters UPKEEP phase (upkeep already applied, awaiting advance)
        assert state["current_phase"] == "upkeep"

    def test_end_turn_wrong_phase(self, client: TestClient) -> None:
        resp = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        game_id = resp.json()["game_id"]
        resp = client.post(f"/api/games/{game_id}/end-turn", json={"player_id": "p0"})
        assert resp.status_code == 400

    def test_buy_upgrade(self, client: TestClient) -> None:
        game_id = self._create_and_advance_to_buy(client)
        # Give p0 enough resources via direct state manipulation
        _games[game_id].players["p0"].resources = 10
        resp = client.post(f"/api/games/{game_id}/buy", json={
            "player_id": "p0",
            "source": "upgrade",
        })
        assert resp.status_code == 200

    def test_reroll(self, client: TestClient) -> None:
        game_id = self._create_and_advance_to_buy(client)
        _games[game_id].players["p0"].resources = 10
        resp = client.post(f"/api/games/{game_id}/reroll", json={
            "player_id": "p0",
        })
        assert resp.status_code == 200


class TestGameLog:
    def _create_game(self, client: TestClient) -> str:
        resp = client.post("/api/games", json={
            "grid_size": "small",
            "players": [
                {"id": "p0", "name": "Alice", "archetype": "vanguard"},
                {"id": "p1", "name": "Bob", "archetype": "swarm"},
            ],
            "seed": 42,
        })
        return resp.json()["game_id"]

    def test_get_full_log(self, client: TestClient) -> None:
        game_id = self._create_game(client)
        resp = client.get(f"/api/games/{game_id}/log")
        assert resp.status_code == 200
        data = resp.json()
        assert data["game_id"] == game_id
        assert len(data["entries"]) > 0

    def test_log_entries_have_structure(self, client: TestClient) -> None:
        game_id = self._create_game(client)
        resp = client.get(f"/api/games/{game_id}/log")
        entry = resp.json()["entries"][0]
        assert "message" in entry
        assert "round" in entry
        assert "phase" in entry

    def test_player_filtered_log(self, client: TestClient) -> None:
        game_id = self._create_game(client)
        # Play a card as p0 (creates private log entries)
        state = client.get(f"/api/games/{game_id}?player_id=p0").json()
        hand = state["players"]["p0"]["hand"]
        tiles = state["grid"]["tiles"]
        owned = [t for t in tiles.values() if t["owner"] == "p0"]
        directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]
        idx = None
        target = None
        for card in hand:
            if card["card_type"] != "claim":
                continue
            for ot in owned:
                for dq, dr in directions:
                    nk = f"{ot['q'] + dq},{ot['r'] + dr}"
                    if (nk in tiles and not tiles[nk]["is_blocked"]
                            and tiles[nk]["owner"] is None
                            and tiles[nk]["defense_power"] <= card["power"]):
                        idx = hand.index(card)
                        target = tiles[nk]
                        break
                if target:
                    break
            if target:
                break
        assert target is not None and idx is not None
        client.post(f"/api/games/{game_id}/play", json={
            "player_id": "p0",
            "card_index": idx,
            "target_q": target["q"],
            "target_r": target["r"],
        })

        # p0's log should contain the play action
        p0_log = client.get(f"/api/games/{game_id}/log?player_id=p0").json()
        p0_messages = [e["message"] for e in p0_log["entries"]]
        assert any("plays" in m for m in p0_messages)

        # p1's log should NOT contain p0's plan phase actions
        p1_log = client.get(f"/api/games/{game_id}/log?player_id=p1").json()
        p1_messages = [e["message"] for e in p1_log["entries"]]
        p0_play_msgs = [m for m in p1_messages if "plays" in m and "Alice" in m]
        assert len(p0_play_msgs) == 0

    def test_log_not_found(self, client: TestClient) -> None:
        resp = client.get("/api/games/nonexistent/log")
        assert resp.status_code == 404

    def test_log_persists_across_rounds(self, client: TestClient) -> None:
        game_id = self._create_game(client)
        # Play through a round
        client.post(f"/api/games/{game_id}/submit-plan", json={"player_id": "p0"})
        client.post(f"/api/games/{game_id}/submit-plan", json={"player_id": "p1"})
        client.post(f"/api/games/{game_id}/end-turn", json={"player_id": "p0"})
        client.post(f"/api/games/{game_id}/end-turn", json={"player_id": "p1"})

        resp = client.get(f"/api/games/{game_id}/log")
        entries = resp.json()["entries"]
        rounds = {e["round"] for e in entries}
        assert 1 in rounds
        assert 2 in rounds


class TestCardsEndpoint:
    def test_list_cards(self, client: TestClient) -> None:
        resp = client.get("/api/cards")
        assert resp.status_code == 200
        cards = resp.json()
        assert len(cards) > 0
        first_card = next(iter(cards.values()))
        assert "name" in first_card
        assert "card_type" in first_card
