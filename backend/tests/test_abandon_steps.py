"""Exodus and Scorched Retreat leave resolution steps so the reveal can animate
the tile being given up (and burnt to a permanent wasteland)."""

from __future__ import annotations

from app.game_engine.cards import Card, _copy_card
from app.game_engine.game_state import GameState, play_card, submit_play
from app.storage.serializer import _deserialize_tile, _serialize_tile
from tests.test_card_resolution import _make_2p_game, _make_3p_game


def _own_plain_tile(game: GameState, pid: str) -> tuple[int, int]:
    tile = next(t for t in game.grid.get_player_tiles(pid) if not t.is_base)  # type: ignore[union-attr]
    return tile.q, tile.r


def _play_on_own_tile(game: GameState, card: Card) -> tuple[int, int]:
    q, r = _own_plain_tile(game, "p0")
    player = game.players["p0"]
    player.hand = [card] + player.hand[1:]
    ok, msg = play_card(game, "p0", 0, target_q=q, target_r=r)
    assert ok, msg
    submit_play(game, "p0")
    submit_play(game, "p1")
    return q, r


def test_exodus_leaves_an_abandon_step(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch0="swarm")
    q, r = _play_on_own_tile(game, _copy_card(card_registry["swarm_exodus"], "x"))
    tile = game.grid.get_tile(q, r)  # type: ignore[union-attr]
    assert tile is not None and tile.owner is None and not tile.is_scorched
    step = next(s for s in game.resolution_steps if s["outcome"] == "abandon")
    assert (step["q"], step["r"], step["previous_owner"]) == (q, r, "p0")


def test_scorched_retreat_burns_the_tile_for_good(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch0="fortress")
    q, r = _play_on_own_tile(game, _copy_card(card_registry["fortress_scorched_retreat"], "s"))
    tile = game.grid.get_tile(q, r)  # type: ignore[union-attr]
    assert tile is not None
    assert tile.owner is None and tile.is_blocked and tile.is_scorched and not tile.is_vp
    step = next(s for s in game.resolution_steps if s["outcome"] == "scorch")
    assert (step["q"], step["r"], step["previous_owner"]) == (q, r, "p0")
    # The flag survives a save and load.
    assert _deserialize_tile(_serialize_tile(tile)).is_scorched


def test_scorching_a_vp_tile_remembers_its_value(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch0="fortress")
    q, r = _own_plain_tile(game, "p0")
    tile = game.grid.get_tile(q, r)  # type: ignore[union-attr]
    assert tile is not None
    tile.is_vp, tile.vp_value = True, 2
    _play_on_own_tile(game, _copy_card(card_registry["fortress_scorched_retreat"], "s"))
    assert tile.is_scorched and tile.scorched_vp == 2 and not tile.is_vp
    step = next(s for s in game.resolution_steps if s["outcome"] == "scorch")
    assert step["vp_value"] == 2


def _tile_next_to(game: GameState, pid: str):  # type: ignore[no-untyped-def]
    for pt in game.grid.get_player_tiles(pid):  # type: ignore[union-attr]
        for a in game.grid.get_adjacent(pt.q, pt.r):  # type: ignore[union-attr]
            if a.owner is None and not a.is_vp and not a.is_base:
                return a
    raise AssertionError("no free neighbour")


def _siege_vs_temp_defense(card_registry: dict[str, Card], card_id: str):  # type: ignore[no-untyped-def]
    game = _make_2p_game(card_registry)
    tile = _tile_next_to(game, "p0")
    # A rival tile with 3 temporary defense (e.g. a Defense card played this round).
    tile.owner, tile.base_defense, tile.permanent_defense_bonus, tile.defense_power = "p1", 0, 0, 3
    card = _copy_card(card_registry[card_id], "x")
    card.power = 3
    player = game.players["p0"]
    player.hand = [card] + player.hand[1:]
    ok, msg = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
    assert ok, msg
    submit_play(game, "p0")
    submit_play(game, "p1")
    step = next(s for s in game.resolution_steps if s["tile_key"] == tile.key)
    return tile, step


def test_siege_engine_ignores_temporary_defense(card_registry: dict[str, Card]) -> None:
    tile, step = _siege_vs_temp_defense(card_registry, "fortress_siege_engine")
    assert tile.owner == "p0" and step["outcome"] == "claimed"
    assert step["defense_ignored"] == 3 and step["ignored_by"] == ["p0"]


def test_a_plain_claim_faces_the_temporary_defense(card_registry: dict[str, Card]) -> None:
    tile, step = _siege_vs_temp_defense(card_registry, "neutral_militia")
    assert tile.owner == "p1" and step["outcome"] == "defended"
    assert "defense_ignored" not in step


def _siege_and_rival(card_registry: dict[str, Card], siege_power: int, rival_power: int):  # type: ignore[no-untyped-def]
    """p0's Siege Engine and p2's plain claim both hit p1's tile (3 temporary defense)."""
    game = _make_3p_game(card_registry)
    tile = _tile_next_to(game, "p0")
    staging = next(a for a in game.grid.get_adjacent(tile.q, tile.r)  # type: ignore[union-attr]
                   if a.owner is None and not a.is_vp and not a.is_base and not a.is_blocked)
    staging.owner = "p2"  # p2 can reach the tile too
    tile.owner, tile.base_defense, tile.permanent_defense_bonus, tile.defense_power = "p1", 0, 0, 3
    for pid, card_id, power in (("p0", "fortress_siege_engine", siege_power), ("p2", "neutral_militia", rival_power)):
        card = _copy_card(card_registry[card_id], f"{pid}x")
        card.power = power
        player = game.players[pid]
        player.hand = [card] + player.hand[1:]
        ok, msg = play_card(game, pid, 0, target_q=tile.q, target_r=tile.r)
        assert ok, msg
    for pid in ("p0", "p1", "p2"):
        submit_play(game, pid)
    step = next(s for s in game.resolution_steps if s["tile_key"] == tile.key)
    return tile, step


def test_siege_engine_strips_defense_only_for_its_own_claim(card_registry: dict[str, Card]) -> None:
    # The rival's 3 can't beat the 3 defense (ties go to the owner); the
    # Siege Engine's 2 faces 0 and gets through, so it takes the tile.
    tile, step = _siege_and_rival(card_registry, siege_power=2, rival_power=3)
    assert tile.owner == "p0" and step["outcome"] == "claimed"
    assert step["defense_ignored"] == 3 and step["ignored_by"] == ["p0"]
    assert step["defender_power"] == 3  # the full defense, as the rival faced it


def test_a_rival_beating_the_full_defense_still_wins_on_power(card_registry: dict[str, Card]) -> None:
    tile, step = _siege_and_rival(card_registry, siege_power=2, rival_power=4)
    assert tile.owner == "p2" and step["winner_id"] == "p2"


def test_two_claims_through_at_equal_power_stalemate(card_registry: dict[str, Card]) -> None:
    # The rival beats the full defense at 4, the Siege Engine gets through at
    # 4 too: they tie, and the owner keeps the tile.
    tile, step = _siege_and_rival(card_registry, siege_power=4, rival_power=4)
    assert tile.owner == "p1" and step["outcome"] == "tie"


def _neutral_neighbours(game: GameState, pid: str, n: int) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for pt in game.grid.get_player_tiles(pid):  # type: ignore[union-attr]
        for a in game.grid.get_adjacent(pt.q, pt.r):  # type: ignore[union-attr]
            if a.owner is None and a.defense_power == 0 and (a.q, a.r) not in out:
                out.append((a.q, a.r))
    return out[:n]


def test_surge_plus_grants_an_action_per_tile_taken_once(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch0="swarm")
    surge = _copy_card(card_registry["swarm_surge"], "s")
    surge.is_upgraded = True
    free = _neutral_neighbours(game, "p0", 12)
    (q, r), b = next((a, b) for a in free for b in free if a != b and max(
        abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[0] + a[1] - b[0] - b[1])) == 1)
    extra = [b]
    player = game.players["p0"]
    player.hand = [surge] + player.hand[1:]
    ok, msg = play_card(game, "p0", 0, target_q=q, target_r=r, extra_targets=extra)
    assert ok, msg
    submit_play(game, "p0")
    submit_play(game, "p1")
    # Two tiles taken → two actions next round (not counted again per tile).
    assert player.turn_modifiers.extra_actions_next_turn == 2


def test_consecrate_on_a_lost_tile_leaves_no_step(card_registry: dict[str, Card]) -> None:
    game = _make_2p_game(card_registry, arch0="swarm")
    tile = next(t for t in game.grid.get_player_tiles("p0") if not t.is_base)  # type: ignore[union-attr]
    tile.owner = "p1"  # lost before the reveal: Consecrate fizzles
    player = game.players["p0"]
    player.hand = [_copy_card(card_registry["swarm_consecrate"], "c")] + player.hand[1:]
    ok, _ = play_card(game, "p0", 0, target_q=tile.q, target_r=tile.r)
    if ok:
        submit_play(game, "p0")
        submit_play(game, "p1")
        assert not any(s["outcome"] == "consecrate" for s in game.resolution_steps)
