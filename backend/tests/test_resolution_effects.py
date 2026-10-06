"""What card effects change at the reveal is recorded on the tile it happened
on (GameState.resolution_effects), so the reveal can show it there; claim
steps say what each card added to its claim's power."""

from __future__ import annotations

from typing import Any

from app.game_engine.cards import Card, _copy_card
from app.game_engine.game_state import GameState, play_card, submit_play
from app.game_engine.hex_grid import HexTile
from tests.test_abandon_steps import _own_plain_tile, _tile_next_to
from tests.test_card_resolution import _make_2p_game


def _play(game: GameState, pid: str, card: Card, tile: tuple[int, int] | None, **kw: Any) -> None:
    player = game.players[pid]
    player.hand = [card] + player.hand[1:]
    q, r = tile if tile else (None, None)
    ok, msg = play_card(game, pid, 0, target_q=q, target_r=r, **kw)
    assert ok, msg


def _reveal(game: GameState) -> None:
    for pid in game.player_order:
        submit_play(game, pid)


def _effects(game: GameState, kind: str) -> list[dict[str, Any]]:
    return [e for e in game.resolution_effects if e["type"] == kind]


def _rival_tile(game: GameState) -> HexTile:
    tile = _tile_next_to(game, "p0")
    tile.owner = "p1"
    return tile


def test_rapid_assault_drain_is_recorded_on_its_tile(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry)
    tile = _rival_tile(game)
    game.players["p1"].resources = 5
    _play(game, "p0", _copy_card(card_registry["vanguard_rapid_assault"], "ra"), (tile.q, tile.r))
    _reveal(game)
    assert tile.owner == "p0"
    drain = [e for e in _effects(game, "resources") if e["player_id"] == "p1"]
    assert drain == [{"type": "resources", "amount": -1, "player_id": "p1", "tile_key": tile.key,
                      "card_name": "Rapid Assault", "by_player_id": "p0"}]


def test_scorched_retreat_resources_come_off_the_burning_tile(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch0="fortress")
    q, r = _own_plain_tile(game, "p0")
    _play(game, "p0", _copy_card(card_registry["fortress_scorched_retreat"], "s"), (q, r))
    _reveal(game)
    gain = _effects(game, "resources")
    assert [(e["player_id"], e["amount"], e["tile_key"]) for e in gain] == [("p0", 8, f"{q},{r}")]


def test_a_mercenary_stopped_by_an_immune_tile_still_takes_its_debt(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch1="fortress")
    tile = _rival_tile(game)
    _play(game, "p1", _copy_card(card_registry["fortress_iron_wall"], "iw"), (tile.q, tile.r))
    _play(game, "p0", _copy_card(card_registry["neutral_mercenary"], "m"), (tile.q, tile.r))
    _reveal(game)
    assert tile.owner == "p1"
    assert any(c.name == "Debt" for c in game.players["p0"].deck.discard)
    debt = [e for e in _effects(game, "card") if e["card_name"] == "Debt"]
    assert len(debt) == 1 and debt[0]["player_id"] == "p0" and debt[0]["tile_key"] == tile.key
    assert debt[0]["source_card"] == "Mercenary" and debt[0]["card"]["name"] == "Debt"


def test_diplomat_land_grants_reach_every_player(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry)
    _play(game, "p0", _copy_card(card_registry["neutral_diplomat"], "d"), None)
    _reveal(game)
    grants = {e["player_id"]: e for e in _effects(game, "card") if e["card_name"] == "Land Grant"}
    assert grants["p0"]["count"] == 2 and grants["p1"]["count"] == 1
    assert grants["p0"]["tile_key"] is None and grants["p0"]["vp_each"] == 1
    # Their VP comes with the cards, not again as a separate gain.
    assert not _effects(game, "vp")


def test_spoils_of_war_records_the_card_it_trashes(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry)
    tile = _tile_next_to(game, "p0")
    staging = next(a for a in game.grid.get_adjacent(tile.q, tile.r)  # type: ignore[union-attr]
                   if a.owner is None and not a.is_vp and not a.is_base and not a.is_blocked)
    staging.owner = "p1"
    spoils = _copy_card(card_registry["vanguard_spoils_of_war"], "sw")
    rival = _copy_card(card_registry["neutral_militia"], "rv")
    rival.power = 1
    _play(game, "p0", spoils, (tile.q, tile.r))
    _play(game, "p1", rival, (tile.q, tile.r))
    _reveal(game)
    assert tile.owner == "p0"
    trash = _effects(game, "trash")
    assert [(e["player_id"], e["card_id"], e["source_card"]) for e in trash] == [("p1", rival.id, "Spoils of War")]
    assert any(e["effect_type"] == "trash_card" for e in game.player_effects)


def test_flood_records_where_the_water_spreads(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch0="swarm")
    q, r = _own_plain_tile(game, "p0")
    _play(game, "p0", _copy_card(card_registry["swarm_flood"], "f"), (q, r))
    _reveal(game)
    (flood,) = _effects(game, "flood")
    assert flood["tile_key"] == f"{q},{r}" and flood["player_id"] == "p0"
    open_around = [t.key for t in game.grid.get_adjacent(q, r) if not t.is_blocked]  # type: ignore[union-attr]
    assert sorted(flood["targets"]) == sorted(open_around)


def test_claim_steps_name_each_cards_reveal_bonus(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry)
    tile = _rival_tile(game)
    _play(game, "p0", _copy_card(card_registry["neutral_ambush"], "a"), (tile.q, tile.r))
    _reveal(game)
    step = next(s for s in game.resolution_steps if s["tile_key"] == tile.key)
    (me,) = [c for c in step["claimants"] if c["player_id"] == "p0"]
    (card,) = me["cards"]
    assert card["name"] == "Ambush" and card["power"] == 2
    assert card["bonuses"] == [{"source": "Ambush", "amount": 2}]
    assert me["power"] == 4
