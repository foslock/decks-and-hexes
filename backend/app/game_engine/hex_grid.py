"""Hex grid generation using axial coordinates (q, r).

Flat-top hexagons with the center hex at (0, 0).
Grid sizes: Small (61 tiles), Medium (91 tiles), Large (127 tiles), Mega (169 tiles), Ultra (217 tiles).
"""

from __future__ import annotations

import heapq
import random
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class GridSize(str, Enum):
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"
    MEGA = "mega"
    ULTRA = "ultra"


# Base tile defense per archetype (used when assigning starting tiles)
BASE_DEFENSE: dict[str, int] = {
    "vanguard": 3,
    "swarm": 3,
    "fortress": 3,
}

# radius = number of rings around center (0-indexed)
GRID_CONFIG: dict[GridSize, dict[str, Any]] = {
    GridSize.SMALL: {"radius": 4, "tiles": 61, "vp_hexes": 5, "blocked": (5, 7), "players": (2, 3)},
    GridSize.MEDIUM: {"radius": 5, "tiles": 91, "vp_hexes": 6, "blocked": (8, 10), "players": (3, 4)},
    GridSize.LARGE: {"radius": 6, "tiles": 127, "vp_hexes": 9, "blocked": (10, 14), "players": (4, 6)},
    GridSize.MEGA: {"radius": 7, "tiles": 169, "vp_hexes": 12, "blocked": (14, 18), "players": (5, 8)},
    GridSize.ULTRA: {"radius": 8, "tiles": 217, "vp_hexes": 15, "blocked": (18, 22), "players": (6, 10)},
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
    capture_count: int = 0  # number of times this tile has changed hands between players
    is_base: bool = False  # True for starting corner tiles (permanently owned)
    base_owner: Optional[str] = None  # player_id of the base's permanent owner

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

    def get_connected_tiles(self, player_id: str) -> set[tuple[int, int]]:
        """BFS from player's base tile across owned tiles.

        Returns the set of (q, r) coordinates reachable from the player's base
        via a continuous path of tiles owned by that player.
        """
        # Find the base tile for this player
        base_tile = None
        for tile in self.tiles.values():
            if tile.is_base and tile.base_owner == player_id:
                base_tile = tile
                break
        if not base_tile:
            return set()

        visited: set[tuple[int, int]] = set()
        queue = deque([(base_tile.q, base_tile.r)])
        visited.add((base_tile.q, base_tile.r))

        while queue:
            q, r = queue.popleft()
            current = self.get_tile(q, r)
            if not current:
                continue
            for nq, nr in current.neighbors():
                if (nq, nr) in visited:
                    continue
                neighbor = self.get_tile(nq, nr)
                if neighbor and not neighbor.is_blocked and neighbor.owner == player_id:
                    visited.add((nq, nr))
                    queue.append((nq, nr))

        return visited

    def get_tiles_by_bfs_depth(self, player_id: str) -> list[tuple[int, "HexTile"]]:
        """BFS from player's base, returning (depth, tile) pairs for owned tiles.

        Tiles are ordered by depth (farthest first), then by most recently
        acquired (highest held_since_turn first) for tie-breaking.
        """
        base_tile = None
        for tile in self.tiles.values():
            if tile.is_base and tile.base_owner == player_id:
                base_tile = tile
                break
        if not base_tile:
            return []

        result: list[tuple[int, HexTile]] = []
        visited: set[tuple[int, int]] = set()
        queue: deque[tuple[int, int, int]] = deque()  # (q, r, depth)
        queue.append((base_tile.q, base_tile.r, 0))
        visited.add((base_tile.q, base_tile.r))

        while queue:
            q, r, depth = queue.popleft()
            current = self.get_tile(q, r)
            if not current:
                continue
            result.append((depth, current))
            for nq, nr in current.neighbors():
                if (nq, nr) in visited:
                    continue
                neighbor = self.get_tile(nq, nr)
                if neighbor and not neighbor.is_blocked and neighbor.owner == player_id:
                    visited.add((nq, nr))
                    queue.append((nq, nr, depth + 1))

        # Sort: farthest first (descending depth), then most recently acquired first
        result.sort(key=lambda x: (-x[0], -(x[1].held_since_turn or 0)))
        return result

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
        "permanent_defense_bonus": tile.permanent_defense_bonus,
        "held_since_turn": tile.held_since_turn,
        "capture_count": tile.capture_count,
        "is_base": tile.is_base,
        "base_owner": tile.base_owner,
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
                                    starting_clusters=starting_clusters,
                                    tiles=grid.tiles)
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


def _dijkstra_distances_from(
    start_q: int, start_r: int,
    tiles: dict[str, HexTile],
    defense_overrides: Optional[dict[str, int]] = None,
) -> dict[str, float]:
    """Dijkstra from a single source, returning weighted distances to all reachable tiles.

    The cost to enter a tile is 1 + its defense_power (or override).  Tiles with
    higher defense are "harder" to reach, modelling the extra power a player needs
    to claim through defended territory.  Blocked tiles are impassable.

    Args:
        defense_overrides: optional {tile_key: defense} to apply instead of the
            tile's current defense_power (used to project anticipated VP-tile
            defense before it has been assigned on the grid).
    """
    start_key = f"{start_q},{start_r}"
    if start_key not in tiles:
        return {}

    directions = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
    distances: dict[str, float] = {start_key: 0.0}
    # (cost, q, r)
    heap: list[tuple[float, int, int]] = [(0.0, start_q, start_r)]

    while heap:
        cost, q, r = heapq.heappop(heap)
        current_key = f"{q},{r}"
        if cost > distances.get(current_key, float("inf")):
            continue
        for dq, dr in directions:
            nq, nr = q + dq, r + dr
            nk = f"{nq},{nr}"
            if nk not in tiles:
                continue
            tile = tiles[nk]
            if tile.is_blocked:
                continue
            defense = (defense_overrides or {}).get(nk, tile.defense_power)
            edge_cost = 1.0 + defense
            new_cost = cost + edge_cost
            if new_cost < distances.get(nk, float("inf")):
                distances[nk] = new_cost
                heapq.heappush(heap, (new_cost, nq, nr))

    return distances


def _compute_anticipated_defense(
    vp_tiles: list[HexTile],
    tiles: dict[str, HexTile],
) -> dict[str, int]:
    """Compute the defense values that would be assigned for a candidate VP placement.

    Mirrors the logic in generate_hex_grid:
      - Closest 1/3 of VP tiles (by distance to center) are premium (vp_value=2, defense=3)
      - Remaining VP tiles are standard (vp_value=1, defense=2)
      - Non-VP neighbors of premium tiles get defense=1
    """
    num_vp = len(vp_tiles)
    if num_vp == 0:
        return {}

    num_premium = max(1, round(num_vp / 3))
    sorted_vp = sorted(vp_tiles,
                        key=lambda t: (max(abs(t.q), abs(t.r), abs(t.s)), t.key))

    overrides: dict[str, int] = {}
    premium_keys: set[str] = set()

    for i, tile in enumerate(sorted_vp):
        if i < num_premium:
            overrides[tile.key] = 3  # premium VP
            premium_keys.add(tile.key)
        else:
            overrides[tile.key] = 2  # standard VP

    # Neighbors of premium tiles get defense 1 (if not already a VP tile)
    vp_keys = {t.key for t in vp_tiles}
    directions = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
    for tile in sorted_vp[:num_premium]:
        for dq, dr in directions:
            nk = f"{tile.q + dq},{tile.r + dr}"
            if nk not in tiles or nk in vp_keys:
                continue
            neighbor = tiles[nk]
            if neighbor.is_blocked:
                continue
            # Only set if not already overridden to something higher
            if nk not in overrides or overrides[nk] < 1:
                overrides[nk] = 1

    return overrides


def _vp_fairness_score(
    vp_tiles: list[HexTile],
    starting_clusters: list[list[tuple[int, int]]],
    tiles: dict[str, HexTile],
) -> float:
    """Score a VP placement by how evenly VP tiles are reachable across players.

    Uses Dijkstra pathfinding around blocked tiles with defense-weighted costs.
    Tiles with higher defense cost more to traverse, modelling the difficulty
    of claiming through defended territory.

    For each player, computes a VP potential as the sum of (vp_value / weighted_dist)
    for each VP tile.  Returns max(potential) - min(potential); lower is fairer.
    Returns 0.0 if there are fewer than 2 players or no VP tiles.
    """
    if len(starting_clusters) < 2 or not vp_tiles:
        return 0.0

    # Project what defense values these VP tiles (and their neighbors) would get
    defense_overrides = _compute_anticipated_defense(vp_tiles, tiles)

    # Determine anticipated vp_value for potential scoring
    num_vp = len(vp_tiles)
    num_premium = max(1, round(num_vp / 3))
    sorted_vp = sorted(vp_tiles,
                        key=lambda t: (max(abs(t.q), abs(t.r), abs(t.s)), t.key))
    vp_values: dict[str, int] = {}
    for i, tile in enumerate(sorted_vp):
        vp_values[tile.key] = 2 if i < num_premium else 1

    # Compute weighted distances from each player's starting cluster
    player_potentials: list[float] = []
    for cluster in starting_clusters:
        # Dijkstra from each tile in the cluster
        cluster_distances: dict[str, dict[str, float]] = {}
        for sq, sr in cluster:
            cluster_distances[f"{sq},{sr}"] = _dijkstra_distances_from(
                sq, sr, tiles, defense_overrides)

        potential = 0.0
        for vp_tile in vp_tiles:
            vp_key = vp_tile.key
            # Minimum weighted distance from any cluster tile to this VP tile
            min_dist = float("inf")
            for _start_key, dist_map in cluster_distances.items():
                d = dist_map.get(vp_key, float("inf"))
                if d < min_dist:
                    min_dist = d
            if min_dist == float("inf") or min_dist == 0:
                continue
            # VP potential: higher value tiles and closer tiles contribute more
            potential += vp_values.get(vp_key, 1) / min_dist

        player_potentials.append(potential)

    if not player_potentials:
        return 0.0

    return max(player_potentials) - min(player_potentials)


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
    tiles: Optional[dict[str, HexTile]] = None,
    attempts: int = 50,
) -> list[HexTile]:
    """Distribute VP hexes evenly across the grid with player-fairness scoring.

    Runs `attempts` random ring-band placements and keeps the one with the
    most balanced VP potential from each player's starting cluster, using
    BFS pathfinding around blocked tiles.
    """
    best: list[HexTile] = []
    best_score = float("inf")

    for _ in range(attempts):
        placement = _single_vp_placement(eligible, count, radius, rng)
        score = _vp_fairness_score(placement, starting_clusters or [],
                                   tiles or {})
        if score < best_score:
            best_score = score
            best = placement

    return best
