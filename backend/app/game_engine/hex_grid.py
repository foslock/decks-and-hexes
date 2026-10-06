"""Hex grid using axial coordinates (q, r).

Flat-top hexagons with the center hex at (0, 0).
Grid sizes: Small (61 tiles), Medium (91 tiles), Large (127 tiles), Mega (169 tiles), Ultra (217 tiles).
Each size has one preset map (map_presets).
"""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .map_presets import PRESETS, layout_preset


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

# radius = number of rings around center (0-indexed). Each size has one
# preset map (map_presets.PRESETS).
GRID_CONFIG: dict[GridSize, dict[str, Any]] = {
    GridSize.SMALL: {"radius": 4, "tiles": 61, "players": (2, 3)},
    GridSize.MEDIUM: {"radius": 5, "tiles": 91, "players": (3, 4)},
    GridSize.LARGE: {"radius": 6, "tiles": 127, "players": (4, 6)},
    GridSize.MEGA: {"radius": 7, "tiles": 169, "players": (5, 6)},
    GridSize.ULTRA: {"radius": 8, "tiles": 217, "players": (6, 6)},
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
    # Players whose ownership of this tile has ended (captured from them or
    # abandoned). Warden only counts a tile for its owner while the owner is
    # not in this list, i.e. they've held it continuously since first claiming it.
    lost_by: list[str] = field(default_factory=list)
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


def mark_tile_lost(tile: HexTile, player_id: Optional[str]) -> None:
    """Record that *player_id*'s ownership of *tile* ended (for Warden)."""
    if player_id and player_id not in tile.lost_by:
        tile.lost_by.append(player_id)


def tile_bridges_territory(grid: HexGrid, player_id: str, q: int, r: int) -> bool:
    """Return True if claiming tile (q, r) would connect two or more currently
    disconnected groups of *player_id*'s territory.

    Counts the distinct groups of the player's owned tiles that touch (q, r);
    two or more means the tile bridges them. Used by Road Builder's
    ``if_bridges_territory`` power condition (and the legacy
    ``adjacency_bridge`` targeting restriction).
    """
    tile = grid.get_tile(q, r)
    if not tile:
        return False

    owned_neighbors: list[tuple[int, int]] = []
    for nq, nr in tile.neighbors():
        n = grid.get_tile(nq, nr)
        if n and n.owner == player_id:
            owned_neighbors.append((nq, nr))
    if len(owned_neighbors) < 2:
        return False

    # BFS among ALL the player's owned tiles to count distinct groups touching
    # the target. If the target is already owned it joins its neighbours into
    # one group, so an owned tile never counts as a new bridge.
    all_owned = {
        (t.q, t.r) for t in grid.tiles.values()
        if t.owner == player_id
    }
    visited: set[tuple[int, int]] = set()
    groups_touching_target = 0
    for start in owned_neighbors:
        if start in visited:
            continue
        group: set[tuple[int, int]] = {start}
        queue = deque([start])
        while queue:
            cq, cr = queue.popleft()
            ct = grid.get_tile(cq, cr)
            if not ct:
                continue
            for nnq, nnr in ct.neighbors():
                if (nnq, nnr) in group or (nnq, nnr) not in all_owned:
                    continue
                group.add((nnq, nnr))
                queue.append((nnq, nnr))
        visited |= group
        groups_touching_target += 1
        if groups_touching_target >= 2:
            return True
    return False


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
    """Lay out the size's preset map (see map_presets) for `num_players`.

    The rng (from the map seed) only turns the board, so the island looks
    different from game to game; every seat always sees the same map.
    """
    if rng is None:
        rng = random.Random()

    radius = GRID_CONFIG[size]["radius"]
    grid = HexGrid(size=size)
    for q in range(-radius, radius + 1):
        for r in range(-radius, radius + 1):
            if abs(q + r) <= radius:
                tile = HexTile(q=q, r=r)
                grid.tiles[tile.key] = tile

    plan = layout_preset(radius, PRESETS[size.value], num_players, turns=rng.randrange(6))
    grid.starting_positions = plan.starting_positions

    for q, r in plan.blocked:
        grid.tiles[f"{q},{r}"].is_blocked = True
    for coords, value in ((plan.premium, 2), (plan.standard, 1)):
        for q, r in coords:
            tile = grid.tiles[f"{q},{r}"]
            tile.is_vp = True
            tile.vp_value = value

    # Intrinsic defense: premium VP 3 (and 1 on its other neighbors),
    # standard VP 2.
    for tile in grid.tiles.values():
        if tile.is_blocked:
            continue
        if tile.is_vp:
            defense = 3 if tile.vp_value == 2 else 2
        elif any((nq, nr) in plan.premium for nq, nr in tile.neighbors()):
            defense = 1
        else:
            continue
        tile.base_defense = defense
        tile.defense_power = defense

    return grid
