"""Hex grid generation using axial coordinates (q, r).

Flat-top hexagons with the center hex at (0, 0).
Grid sizes: Small (37 tiles), Medium (61 tiles), Large (91 tiles).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class GridSize(str, Enum):
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"


# radius = number of rings around center (0-indexed)
GRID_CONFIG = {
    GridSize.SMALL: {"radius": 3, "tiles": 37, "vp_hexes": 8, "blocked": (3, 4), "players": (2, 3)},
    GridSize.MEDIUM: {"radius": 4, "tiles": 61, "vp_hexes": 13, "blocked": (5, 7), "players": (3, 4)},
    GridSize.LARGE: {"radius": 5, "tiles": 91, "vp_hexes": 20, "blocked": (8, 10), "players": (4, 6)},
}


@dataclass
class HexTile:
    q: int
    r: int
    is_blocked: bool = False
    is_vp: bool = False
    owner: Optional[str] = None  # player_id
    defense_power: int = 0
    held_since_turn: Optional[int] = None  # track when ownership started

    @property
    def s(self) -> int:
        return -self.q - self.r

    @property
    def key(self) -> str:
        return f"{self.q},{self.r}"

    def distance_to(self, other: HexTile) -> int:
        return max(abs(self.q - other.q), abs(self.r - other.r), abs(self.s - other.s))

    def neighbors(self) -> list[tuple[int, int]]:
        directions = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
        return [(self.q + dq, self.r + dr) for dq, dr in directions]


@dataclass
class HexGrid:
    size: GridSize
    tiles: dict[str, HexTile] = field(default_factory=dict)
    starting_positions: list[list[tuple[int, int]]] = field(default_factory=list)

    def get_tile(self, q: int, r: int) -> Optional[HexTile]:
        return self.tiles.get(f"{q},{r}")

    def get_adjacent(self, q: int, r: int) -> list[HexTile]:
        tile = self.get_tile(q, r)
        if not tile:
            return []
        result = []
        for nq, nr in tile.neighbors():
            neighbor = self.get_tile(nq, nr)
            if neighbor and not neighbor.is_blocked:
                result.append(neighbor)
        return result

    def get_player_tiles(self, player_id: str) -> list[HexTile]:
        return [t for t in self.tiles.values() if t.owner == player_id]

    def to_dict(self) -> dict:
        return {
            "size": self.size.value,
            "tiles": {k: _tile_to_dict(v) for k, v in self.tiles.items()},
            "starting_positions": self.starting_positions,
        }


def _tile_to_dict(tile: HexTile) -> dict:
    return {
        "q": tile.q,
        "r": tile.r,
        "is_blocked": tile.is_blocked,
        "is_vp": tile.is_vp,
        "owner": tile.owner,
        "defense_power": tile.defense_power,
        "held_since_turn": tile.held_since_turn,
    }


def generate_hex_grid(size: GridSize, num_players: int, rng: Optional[random.Random] = None) -> HexGrid:
    """Generate a hex grid with VP hexes, blocked terrain, and starting positions."""
    if rng is None:
        rng = random.Random()

    config = GRID_CONFIG[size]
    radius = config["radius"]
    grid = HexGrid(size=size)

    # Generate all hex tiles in the grid
    for q in range(-radius, radius + 1):
        for r in range(-radius, radius + 1):
            s = -q - r
            if abs(s) <= radius:
                tile = HexTile(q=q, r=r)
                grid.tiles[tile.key] = tile

    # Place starting positions on the edges
    starting_clusters = _pick_starting_positions(radius, num_players, rng)
    grid.starting_positions = starting_clusters

    # Tiles in starting clusters are reserved (not eligible for VP/blocked)
    reserved = set()
    for cluster in starting_clusters:
        for q, r in cluster:
            reserved.add(f"{q},{r}")

    # Place blocked terrain
    blocked_min, blocked_max = config["blocked"]
    num_blocked = rng.randint(blocked_min, blocked_max)
    eligible = [
        t for t in grid.tiles.values()
        if t.key not in reserved and t.key != "0,0"
    ]
    rng.shuffle(eligible)
    blocked_tiles = eligible[:num_blocked]
    for tile in blocked_tiles:
        tile.is_blocked = True

    # Place VP hexes - distributed evenly (not center-clustered)
    remaining = [
        t for t in grid.tiles.values()
        if not t.is_blocked and t.key not in reserved and t.key != "0,0"
    ]
    num_vp = config["vp_hexes"]
    vp_tiles = _distribute_vp_hexes(remaining, num_vp, radius, rng)
    for tile in vp_tiles:
        tile.is_vp = True

    return grid


def _pick_starting_positions(
    radius: int, num_players: int, rng: random.Random
) -> list[list[tuple[int, int]]]:
    """Pick starting corner clusters (2 tiles each) on the edge of the grid.

    Uses the 6 corners of the hex grid and picks num_players of them,
    maximizing distance between players.
    """
    # The 6 corner positions of a hex grid with given radius
    corners = [
        (radius, 0),
        (0, radius),
        (-radius, radius),
        (-radius, 0),
        (0, -radius),
        (radius, -radius),
    ]

    # For balanced spacing, pick evenly spaced corners
    if num_players <= 6:
        step = 6 // num_players
        start = rng.randint(0, 5)
        chosen = []
        for i in range(num_players):
            idx = (start + i * step) % 6
            chosen.append(corners[idx])
    else:
        chosen = corners[:num_players]

    # For each chosen corner, create a 2-tile cluster (the corner + one neighbor toward center)
    clusters = []
    for q, r in chosen:
        cluster = [(q, r)]
        # Find the neighbor closest to center
        directions = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
        best = None
        best_dist = float("inf")
        for dq, dr in directions:
            nq, nr = q + dq, r + dr
            ns = -nq - nr
            if max(abs(nq), abs(nr), abs(ns)) <= radius:
                dist = max(abs(nq), abs(nr), abs(ns))
                if dist < best_dist:
                    best_dist = dist
                    best = (nq, nr)
        if best:
            cluster.append(best)
        clusters.append(cluster)

    return clusters


def _distribute_vp_hexes(
    eligible: list[HexTile], count: int, radius: int, rng: random.Random
) -> list[HexTile]:
    """Distribute VP hexes evenly across the grid (not center-clustered).

    Divides the grid into distance rings and distributes VP hexes
    proportionally across rings.
    """
    if count >= len(eligible):
        return eligible

    # Group tiles by distance from center into bands
    inner = [t for t in eligible if max(abs(t.q), abs(t.r), abs(t.s)) <= radius // 3]
    mid = [t for t in eligible if radius // 3 < max(abs(t.q), abs(t.r), abs(t.s)) <= 2 * radius // 3]
    outer = [t for t in eligible if max(abs(t.q), abs(t.r), abs(t.s)) > 2 * radius // 3]

    # Distribute proportionally but favor mid and outer
    bands = [inner, mid, outer]
    weights = [0.2, 0.4, 0.4]

    selected: list[HexTile] = []
    remaining_count = count

    for band, weight in zip(bands, weights):
        if not band or remaining_count <= 0:
            continue
        band_count = min(round(count * weight), len(band), remaining_count)
        rng.shuffle(band)
        selected.extend(band[:band_count])
        remaining_count -= band_count

    # Fill any remaining from all eligible
    if remaining_count > 0:
        used = {t.key for t in selected}
        extras = [t for t in eligible if t.key not in used]
        rng.shuffle(extras)
        selected.extend(extras[:remaining_count])

    return selected[:count]
