"""Tests for hex grid generation."""

from __future__ import annotations

import random

import pytest

from app.game_engine.hex_grid import (
    GRID_CONFIG,
    GridSize,
    HexGrid,
    HexTile,
    generate_hex_grid,
)
from app.game_engine.map_presets import PRESETS, layout_preset, ring, rotate


class TestHexTile:
    def test_key_format(self) -> None:
        tile = HexTile(q=2, r=-1)
        assert tile.key == "2,-1"

    def test_cube_coordinate_s(self) -> None:
        tile = HexTile(q=2, r=-1)
        assert tile.s == -1  # s = -q - r

    def test_cube_coordinate_sum_zero(self) -> None:
        tile = HexTile(q=3, r=-5)
        assert tile.q + tile.r + tile.s == 0

    def test_distance_same_tile(self) -> None:
        a = HexTile(q=0, r=0)
        assert a.distance_to(a) == 0

    def test_distance_adjacent(self) -> None:
        a = HexTile(q=0, r=0)
        b = HexTile(q=1, r=0)
        assert a.distance_to(b) == 1

    def test_distance_two_away(self) -> None:
        a = HexTile(q=0, r=0)
        b = HexTile(q=2, r=-1)
        assert a.distance_to(b) == 2

    def test_neighbors_count(self) -> None:
        tile = HexTile(q=0, r=0)
        assert len(tile.neighbors()) == 6

    def test_neighbors_are_adjacent(self) -> None:
        tile = HexTile(q=0, r=0)
        for nq, nr in tile.neighbors():
            neighbor = HexTile(q=nq, r=nr)
            assert tile.distance_to(neighbor) == 1


ALL_SIZES = list(GridSize)
PLAYER_COUNTS = [1, 2, 3, 4, 5, 6]


def _open_tiles(grid: HexGrid) -> set[str]:
    return {k for k, t in grid.tiles.items() if not t.is_blocked}


class TestHexGridGeneration:
    @pytest.mark.parametrize("size,expected_tiles", [
        (GridSize.SMALL, 61),
        (GridSize.MEDIUM, 91),
        (GridSize.LARGE, 127),
        (GridSize.MEGA, 169),
        (GridSize.ULTRA, 217),
    ])
    def test_grid_tile_count(self, size: GridSize, expected_tiles: int) -> None:
        grid = generate_hex_grid(size, GRID_CONFIG[size]["players"][0], random.Random(1))
        assert len(grid.tiles) == expected_tiles

    @pytest.mark.parametrize("size", ALL_SIZES)
    def test_center_is_a_vp_hex(self, size: GridSize) -> None:
        """A 2★ in the center — except Mega, whose 2★s sit between the bases
        around a 1★ center."""
        grid = generate_hex_grid(size, 4, random.Random(1))
        center = grid.get_tile(0, 0)
        assert center is not None and center.is_vp
        assert center.vp_value == (1 if size == GridSize.MEGA else 2)
        assert center.base_defense == (2 if size == GridSize.MEGA else 3)

    def test_premium_neighbors_have_defense_one(self) -> None:
        for size in ALL_SIZES:
            grid = generate_hex_grid(size, 6, random.Random(3))
            for t in grid.tiles.values():
                if t.is_vp and t.vp_value == 2:
                    for nq, nr in t.neighbors():
                        n = grid.get_tile(nq, nr)
                        if n and not n.is_vp and not n.is_blocked:
                            assert n.base_defense == 1, (size, n.key)

    def test_blocked_and_vp_dont_overlap(self) -> None:
        for size in ALL_SIZES:
            grid = generate_hex_grid(size, 4, random.Random(42))
            for tile in grid.tiles.values():
                assert not (tile.is_blocked and tile.is_vp)

    def test_starting_positions_count(self) -> None:
        for n in PLAYER_COUNTS:
            grid = generate_hex_grid(GridSize.LARGE, n, random.Random(1))
            assert len(grid.starting_positions) == n
            assert all(len(c) == 2 for c in grid.starting_positions)

    def test_tiles_next_to_starting_positions_are_open(self) -> None:
        """Every tile next to a spawn is claimable at once: not blocked, not a
        VP, no defense (a VP nearby would slow that player's start)."""
        for size in ALL_SIZES:
            for players in PLAYER_COUNTS:
                for seed in range(6):
                    grid = generate_hex_grid(size, players, random.Random(seed))
                    cluster_keys = {f"{q},{r}" for c in grid.starting_positions for q, r in c}
                    for cluster in grid.starting_positions:
                        for q, r in cluster:
                            tile = grid.get_tile(q, r)
                            assert tile is not None and not tile.is_blocked and not tile.is_vp
                            for nq, nr in tile.neighbors():
                                n = grid.get_tile(nq, nr)
                                if n is None or n.key in cluster_keys:
                                    continue
                                assert not n.is_blocked, (size, players, seed, n.key)
                                assert not n.is_vp, (size, players, seed, n.key)
                                assert n.base_defense == 0, (size, players, seed, n.key)

    def test_board_stays_connected(self) -> None:
        for size in ALL_SIZES:
            for players in PLAYER_COUNTS:
                grid = generate_hex_grid(size, players, random.Random(0))
                open_keys = _open_tiles(grid)
                start = next(iter(open_keys))
                seen = {start}
                stack = [start]
                while stack:
                    q, r = (int(v) for v in stack.pop().split(","))
                    for nq, nr in HexTile(q=q, r=r).neighbors():
                        k = f"{nq},{nr}"
                        if k in open_keys and k not in seen:
                            seen.add(k)
                            stack.append(k)
                assert seen == open_keys, (size, players)

    def test_corner_maps_are_fully_symmetric(self) -> None:
        """With bases on corners, every 60° turn gives the same map; and the
        mirror too (so 4 players' seats aren't mirror images) — except Mega,
        which is for 5–6 players."""
        for size in ALL_SIZES:
            radius = GRID_CONFIG[size]["radius"]
            plan = layout_preset(radius, PRESETS[size.value], 6)
            for features in (plan.premium, plan.standard, plan.blocked):
                assert {rotate(t, 1) for t in features} == features, size
                if size != GridSize.MEGA:
                    assert {(r, q) for q, r in features} == features, size

    def test_every_base_has_the_same_spacing_to_rivals(self) -> None:
        """No seat is squeezed: each base sees the same distances to its rivals
        on corner maps (four players take two opposite pairs of corners)."""
        for size in ALL_SIZES:
            for players in (2, 3, 4, 6):
                grid = generate_hex_grid(size, players, random.Random(5))
                bases = [grid.get_tile(*c[0]) for c in grid.starting_positions]
                spacings = {
                    tuple(sorted(a.distance_to(b) for b in bases if b is not a))  # type: ignore[union-attr,arg-type]
                    for a in bases
                }
                assert len(spacings) == 1, (size, players, spacings)

    def test_five_players_spread_evenly_round_the_coast(self) -> None:
        """Five bases can't share six corners fairly, so they spread evenly:
        neighboring bases are within one coast step of the same spacing."""
        for size in ALL_SIZES:
            radius = GRID_CONFIG[size]["radius"]
            coast = ring(radius)
            grid = generate_hex_grid(size, 5, random.Random(2))
            steps = sorted(coast.index(c[0]) for c in grid.starting_positions)
            gaps = [(steps[(i + 1) % 5] - steps[i]) % len(coast) for i in range(5)]
            assert max(gaps) - min(gaps) <= 1, (size, gaps)

    def test_deterministic_with_same_seed(self) -> None:
        g1 = generate_hex_grid(GridSize.SMALL, 2, random.Random(123))
        g2 = generate_hex_grid(GridSize.SMALL, 2, random.Random(123))
        assert g1.starting_positions == g2.starting_positions
        for key in g1.tiles:
            t1 = g1.tiles[key]
            t2 = g2.tiles[key]
            assert t1.is_blocked == t2.is_blocked
            assert t1.is_vp == t2.is_vp

    def test_seed_turns_the_board(self) -> None:
        """Different seeds turn the map: the same features (it's symmetric),
        with the bases on different corners."""
        grids = [generate_hex_grid(GridSize.MEDIUM, 3, random.Random(s)) for s in range(30)]
        assert len({frozenset(t.key for t in g.tiles.values() if t.is_blocked) for g in grids}) == 1
        assert len({tuple(map(tuple, g.starting_positions[0])) for g in grids}) > 1


class TestHexGridOperations:
    def test_get_tile_valid(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        tile = grid.get_tile(0, 0)
        assert tile is not None
        assert tile.q == 0 and tile.r == 0

    def test_get_tile_invalid(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        assert grid.get_tile(99, 99) is None

    def test_get_adjacent_center(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        adj = grid.get_adjacent(0, 0)
        # Center should have 6 neighbors (minus blocked ones)
        assert len(adj) <= 6
        assert len(adj) >= 1

    def test_get_adjacent_excludes_blocked(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        adj = grid.get_adjacent(0, 0)
        for tile in adj:
            assert not tile.is_blocked

    def test_get_player_tiles(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        # Assign some tiles
        tile = grid.get_tile(0, 0)
        assert tile is not None
        tile.owner = "player1"
        tiles = grid.get_player_tiles("player1")
        assert len(tiles) == 1
        assert tiles[0].q == 0

    def test_to_dict_structure(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        d = grid.to_dict()
        assert d["size"] == "small"
        assert "tiles" in d
        assert "starting_positions" in d
        assert len(d["tiles"]) == 61
