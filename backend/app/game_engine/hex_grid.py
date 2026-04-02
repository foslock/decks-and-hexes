"""Hex grid generation using axial coordinates (q, r).

Flat-top hexagons with the center hex at (0, 0).
Grid sizes: Small (37 tiles), Medium (61 tiles), Large (91 tiles).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class GridSize(str, Enum):
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"


# radius = number of rings around center (0-indexed)
GRID_CONFIG: dict[GridSize, dict[str, Any]] = {
    GridSize.SMALL: {"radius": 3, "tiles": 37, "vp_hexes": 4, "blocked": (3, 4), "players": (2, 3)},
    GridSize.MEDIUM: {"radius": 4, "tiles": 61, "vp_hexes": 6, "blocked": (5, 7), "players": (3, 4)},
    GridSize.LARGE: {"radius": 5, "tiles": 91, "vp_hexes": 10, "blocked": (8, 10), "players": (4, 6)},
}


@dataclass
class HexTile:
    q: int
    r: int
    is_blocked: bool = False
    is_vp: bool = False
    vp_value: int = 1  # 1 = standard VP tile, 2 = premium VP tile
    owner: Optional[str] = None  # player_id
    defense_power: int = 0
    base_defense: int = 0  # intrinsic defense set at generation; defense resets to this on capture
    permanent_defense_bonus: int = 0  # Entrench: persists until tile is captured
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

    def to_dict(self) -> dict[str, Any]:
        return {
            "size": self.size.value,
            "tiles": {k: _tile_to_dict(v) for k, v in self.tiles.items()},
            "starting_positions": self.starting_positions,
        }


def _tile_to_dict(tile: HexTile) -> dict[str, Any]:
    return {
        "q": tile.q,
        "r": tile.r,
        "is_blocked": tile.is_blocked,
        "is_vp": tile.is_vp,
        "vp_value": tile.vp_value,
        "owner": tile.owner,
        "defense_power": tile.defense_power,
        "base_defense": tile.base_defense,
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

    # Tiles adjacent to any starting cluster tile (VP cannot spawn next to spawn points)
    starting_adjacent: set[str] = set()
    directions = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
    for cluster in starting_clusters:
        for q, r in cluster:
            for dq, dr in directions:
                nk = f"{q + dq},{r + dr}"
                if nk not in reserved and nk in grid.tiles:
                    starting_adjacent.add(nk)

    # Place VP hexes - distributed evenly and balanced across player starting positions
    remaining = [
        t for t in grid.tiles.values()
        if not t.is_blocked and t.key not in reserved
        and t.key not in starting_adjacent and t.key != "0,0"
    ]
    num_vp = config["vp_hexes"]
    vp_tiles = _distribute_vp_hexes(remaining, num_vp, radius, rng,
                                    starting_clusters=starting_clusters)
    for tile in vp_tiles:
        tile.is_vp = True

    # Assign VP values: closest 1/3 (to center) become premium (vp_value=2), rest are standard (vp_value=1).
    # Sort by axial distance from (0, 0) ascending — tiebreak by key for stability.
    num_premium = max(1, round(num_vp / 3))
    sorted_vp = sorted(vp_tiles, key=lambda t: (max(abs(t.q), abs(t.r), abs(t.s)), t.key))
    for i, tile in enumerate(sorted_vp):
        tile.vp_value = 2 if i < num_premium else 1

    # Set intrinsic tile defense:
    #   Premium VP (vp_value=2): defense 3; their non-VP neighbors: defense 1
    #   Standard VP (vp_value=1): defense 2; their neighbors: no extra defense (0)
    premium_keys = {t.key for t in sorted_vp[:num_premium]}
    for tile in grid.tiles.values():
        if tile.is_blocked:
            continue
        if tile.is_vp:
            defense = 3 if tile.vp_value == 2 else 2
            tile.base_defense = defense
            tile.defense_power = defense
        elif any(
            f"{nq},{nr}" in premium_keys
            for nq, nr in tile.neighbors()
        ):
            # Adjacent to a premium VP tile: defense 1
            tile.base_defense = 1
            tile.defense_power = 1

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


def _hex_distance(q1: float, r1: float, q2: float, r2: float) -> float:
    """Axial hex distance between two points (supports float centroids)."""
    s1 = -q1 - r1
    s2 = -q2 - r2
    return max(abs(q1 - q2), abs(r1 - r2), abs(s1 - s2))


def _vp_fairness_score(
    vp_tiles: list[HexTile],
    starting_clusters: list[list[tuple[int, int]]],
) -> float:
    """Score a VP placement by how evenly VP tiles are distributed across players.

    Returns max(avg_dist) - min(avg_dist) across players; lower is fairer.
    Returns 0.0 if there are fewer than 2 players or no VP tiles.
    """
    if len(starting_clusters) < 2 or not vp_tiles:
        return 0.0

    avg_distances = []
    for cluster in starting_clusters:
        cx = sum(q for q, r in cluster) / len(cluster)
        cr = sum(r for q, r in cluster) / len(cluster)
        avg_dist = sum(
            _hex_distance(cx, cr, t.q, t.r) for t in vp_tiles
        ) / len(vp_tiles)
        avg_distances.append(avg_dist)

    return max(avg_distances) - min(avg_distances)


def _single_vp_placement(
    eligible: list[HexTile], count: int, radius: int, rng: random.Random
) -> list[HexTile]:
    """One random VP placement using ring-band distribution."""
    if count >= len(eligible):
        return list(eligible)

    inner = [t for t in eligible if max(abs(t.q), abs(t.r), abs(t.s)) <= radius // 3]
    mid = [t for t in eligible if radius // 3 < max(abs(t.q), abs(t.r), abs(t.s)) <= 2 * radius // 3]
    outer = [t for t in eligible if max(abs(t.q), abs(t.r), abs(t.s)) > 2 * radius // 3]

    bands = [inner, mid, outer]
    weights = [0.2, 0.4, 0.4]

    selected: list[HexTile] = []
    remaining_count = count

    for band, weight in zip(bands, weights):
        if not band or remaining_count <= 0:
            continue
        band_copy = list(band)
        rng.shuffle(band_copy)
        band_count = min(round(count * weight), len(band_copy), remaining_count)
        selected.extend(band_copy[:band_count])
        remaining_count -= band_count

    if remaining_count > 0:
        used = {t.key for t in selected}
        extras = [t for t in eligible if t.key not in used]
        rng.shuffle(extras)
        selected.extend(extras[:remaining_count])

    return selected[:count]


def _distribute_vp_hexes(
    eligible: list[HexTile],
    count: int,
    radius: int,
    rng: random.Random,
    starting_clusters: Optional[list[list[tuple[int, int]]]] = None,
    attempts: int = 50,
) -> list[HexTile]:
    """Distribute VP hexes evenly across the grid with player-fairness scoring.

    Runs `attempts` random ring-band placements and keeps the one with the
    most balanced average distance from each player's starting cluster.
    """
    best: list[HexTile] = []
    best_score = float("inf")

    for _ in range(attempts):
        placement = _single_vp_placement(eligible, count, radius, rng)
        score = _vp_fairness_score(placement, starting_clusters or [])
        if score < best_score:
            best_score = score
            best = placement

    return best
