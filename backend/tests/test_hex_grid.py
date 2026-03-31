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


class TestHexGridGeneration:
    @pytest.mark.parametrize("size,expected_tiles", [
        (GridSize.SMALL, 37),
        (GridSize.MEDIUM, 61),
        (GridSize.LARGE, 91),
    ])
    def test_grid_tile_count(self, size: GridSize, expected_tiles: int) -> None:
        config = GRID_CONFIG[size]
        min_players = config["players"][0]
        grid = generate_hex_grid(size, min_players, random.Random(1))
        # Total tiles = generated minus none (all valid positions)
        total = len(grid.tiles)
        assert total == expected_tiles

    def test_center_tile_exists(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        center = grid.get_tile(0, 0)
        assert center is not None
        assert not center.is_blocked
        assert not center.is_vp

    @pytest.mark.parametrize("size", [GridSize.SMALL, GridSize.MEDIUM, GridSize.LARGE])
    def test_blocked_terrain_count(self, size: GridSize) -> None:
        config = GRID_CONFIG[size]
        min_blocked, max_blocked = config["blocked"]
        min_players = config["players"][0]
        grid = generate_hex_grid(size, min_players, random.Random(42))
        blocked = sum(1 for t in grid.tiles.values() if t.is_blocked)
        assert min_blocked <= blocked <= max_blocked

    @pytest.mark.parametrize("size", [GridSize.SMALL, GridSize.MEDIUM, GridSize.LARGE])
    def test_vp_hex_count(self, size: GridSize) -> None:
        config = GRID_CONFIG[size]
        expected_vp = config["vp_hexes"]
        min_players = config["players"][0]
        grid = generate_hex_grid(size, min_players, random.Random(42))
        vp_count = sum(1 for t in grid.tiles.values() if t.is_vp)
        assert vp_count == expected_vp

    def test_blocked_and_vp_dont_overlap(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(42))
        for tile in grid.tiles.values():
            if tile.is_blocked:
                assert not tile.is_vp

    def test_starting_positions_count(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        assert len(grid.starting_positions) == 2

    def test_starting_positions_cluster_size(self) -> None:
        grid = generate_hex_grid(GridSize.SMALL, 3, random.Random(1))
        for cluster in grid.starting_positions:
            assert len(cluster) == 2

    def test_starting_positions_not_blocked(self) -> None:
        grid = generate_hex_grid(GridSize.MEDIUM, 3, random.Random(42))
        for cluster in grid.starting_positions:
            for q, r in cluster:
                tile = grid.get_tile(q, r)
                assert tile is not None
                assert not tile.is_blocked

    def test_starting_positions_not_vp(self) -> None:
        grid = generate_hex_grid(GridSize.MEDIUM, 3, random.Random(42))
        for cluster in grid.starting_positions:
            for q, r in cluster:
                tile = grid.get_tile(q, r)
                assert tile is not None
                assert not tile.is_vp

    def test_vp_not_center_clustered(self) -> None:
        """VP hexes should be distributed, not all near center."""
        grid = generate_hex_grid(GridSize.LARGE, 4, random.Random(42))
        radius = GRID_CONFIG[GridSize.LARGE]["radius"]
        vp_tiles = [t for t in grid.tiles.values() if t.is_vp]
        outer = [t for t in vp_tiles if max(abs(t.q), abs(t.r), abs(t.s)) > radius // 2]
        # At least some VP hexes should be in the outer half
        assert len(outer) > 0

    def test_deterministic_with_same_seed(self) -> None:
        g1 = generate_hex_grid(GridSize.SMALL, 2, random.Random(123))
        g2 = generate_hex_grid(GridSize.SMALL, 2, random.Random(123))
        for key in g1.tiles:
            t1 = g1.tiles[key]
            t2 = g2.tiles[key]
            assert t1.is_blocked == t2.is_blocked
            assert t1.is_vp == t2.is_vp

    def test_different_seeds_produce_different_grids(self) -> None:
        g1 = generate_hex_grid(GridSize.SMALL, 2, random.Random(1))
        g2 = generate_hex_grid(GridSize.SMALL, 2, random.Random(999))
        blocked1 = {t.key for t in g1.tiles.values() if t.is_blocked}
        blocked2 = {t.key for t in g2.tiles.values() if t.is_blocked}
        # Very unlikely to be identical with different seeds
        assert blocked1 != blocked2


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
        assert len(d["tiles"]) == 37
