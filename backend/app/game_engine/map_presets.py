"""Preset maps: one fixed map per grid size.

A map is a recipe of features placed relative to the starting bases, so
every seat sees the same map:

- the center hex,
- axis features, on each base's straight line to the center, a number of
  rings (the depth) out from the center,
- gap features, on the midline between two neighboring bases: one tile on
  the midline, or a pair either side of it.

Positions use ring fractions, the hex version of an angle: ring d has 6d
tiles, and the point a fraction f of the way round the board sits on tile
round(f * 6d) of that ring.

Two, three, four and six players start on corners, and the map is laid out
around all six corners — symmetric under every rotation and mirror, so any
set of corners is fair (four players take two opposite pairs, so nobody is
squeezed between rivals). Five players can't share six corners fairly — the
two beside the empty one win far more often — so their bases spread evenly
round the coast and the map is laid out around those five instead.

Every map keeps the tiles next to a base open (no mountain, VP hex or
defense), so no seat starts slow.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal, Optional

Coord = tuple[int, int]
Kind = Literal["premium", "standard", "blocked"]

# Walking the ring from (d, 0) round the board; tile k·d is corner k.
_RING_STEPS: list[Coord] = [(-1, 1), (-1, 0), (0, -1), (1, -1), (1, 0), (0, 1)]

# Corners (0–5 round the board) each player count starts on; five players
# spread round the coast instead (see layout_preset).
CORNER_SEATS: dict[int, tuple[int, ...]] = {
    1: (0,),
    2: (0, 3),
    3: (0, 2, 4),
    4: (0, 1, 3, 4),
    6: (0, 1, 2, 3, 4, 5),
}


@dataclass(frozen=True)
class GapFeature:
    """A feature on the midline between neighboring bases.

    spread 0 is one tile on the midline (or `offset` steps round from it);
    n is a pair n steps either side of that tile; n + 0.5 is a pair
    straddling the midline.
    """

    kind: Kind
    depth: int
    spread: float = 0
    offset: float = 0


@dataclass(frozen=True)
class MapRecipe:
    name: str
    center: Optional[Kind] = None
    axis: tuple[tuple[Kind, int], ...] = ()
    gaps: tuple[GapFeature, ...] = ()
    # Coast steps (0 = corner 0, counting round the board) of the five bases
    # in a five-player game: spread evenly, then picked by simulation for the
    # most even win rates (corner bases have less land within reach than
    # bases on a straight stretch of coast, so the mix matters).
    five_player_bases: tuple[int, ...] = ()
    # Gap features with five players, when the usual ones don't fit.
    five_player_gaps: Optional[tuple[GapFeature, ...]] = None


@dataclass
class MapLayout:
    premium: set[Coord] = field(default_factory=set)
    standard: set[Coord] = field(default_factory=set)
    blocked: set[Coord] = field(default_factory=set)
    # One [base, inner tile] cluster per player, in seat order round the board.
    starting_positions: list[list[Coord]] = field(default_factory=list)


PRESETS: dict[str, MapRecipe] = {
    # A premium (2-star) VP center ringed by six standard (1-star) VP hexes
    # between neighboring bases; mountains on the coast between bases funnel
    # everyone inward.
    "small": MapRecipe(
        name="Crown",
        center="premium",
        gaps=(GapFeature("standard", 2), GapFeature("blocked", 4)),
        # Too tight for the inner ring with five players: a standard VP on
        # the coast between each pair of neighbors instead.
        five_player_gaps=(GapFeature("standard", 4),),
        five_player_bases=(0, 5, 9, 14, 19),
    ),
    # A premium center behind a broken ring of mountains (a gap facing each
    # base); a standard VP halfway between each pair of neighbors.
    "medium": MapRecipe(
        name="Frontiers",
        center="premium",
        gaps=(GapFeature("standard", 4), GapFeature("blocked", 2)),
        five_player_bases=(0, 6, 12, 18, 24),
    ),
    # A premium center; standard VPs in an inner ring and on the coast
    # between bases, each coast one flanked by mountains.
    "large": MapRecipe(
        name="Rings",
        center="premium",
        gaps=(GapFeature("standard", 2), GapFeature("standard", 6), GapFeature("blocked", 6, 1)),
        five_player_bases=(5, 13, 20, 27, 34),
    ),
    # No single center: a premium VP (with its defense-1 ring) between each
    # pair of neighbors, a mountain in front of every base, a standard VP in
    # the middle and one on the coast beside each mountain pass. (Mega is
    # for five or six players, so its seats never sit as mirror images and
    # it needn't be mirror-symmetric.)
    "mega": MapRecipe(
        name="Six Crowns",
        center="standard",
        axis=(("blocked", 3),),
        gaps=(
            GapFeature("premium", 4),
            GapFeature("standard", 7, offset=-0.5),
            GapFeature("blocked", 7, offset=-1.5),
        ),
        five_player_bases=(8, 16, 25, 33, 41),
    ),
    # A premium center plus a premium VP out between each pair of
    # neighbors, backed by a ridge on the coast; a standard VP in front of
    # every base.
    "ultra": MapRecipe(
        name="Twin Rings",
        center="premium",
        axis=(("standard", 2),),
        gaps=(GapFeature("premium", 6), GapFeature("blocked", 8, 1), GapFeature("blocked", 8)),
        five_player_bases=(7, 17, 26, 36, 45),
    ),
}


def ring(depth: int) -> list[Coord]:
    """Tiles at `depth` from the center, round the board from (depth, 0)."""
    if depth == 0:
        return [(0, 0)]
    q, r = depth, 0
    out: list[Coord] = []
    for dq, dr in _RING_STEPS:
        for _ in range(depth):
            out.append((q, r))
            q, r = q + dq, r + dr
    return out


def _at(depth: int, x: float) -> Coord:
    tiles = ring(depth)
    return tiles[math.floor(x + 0.5) % len(tiles)]


def _pair(depth: int, x: float, spread: float) -> list[Coord]:
    tiles = ring(depth)
    n = len(tiles)
    if spread == int(spread):
        c = math.floor(x + 0.5)
        return [tiles[(c - int(spread)) % n], tiles[(c + int(spread)) % n]]
    lo = math.floor(x)
    k = int(spread - 0.5)
    return [tiles[(lo - k) % n], tiles[(lo + 1 + k) % n]]


def _distance(a: Coord, b: Coord) -> int:
    dq, dr = a[0] - b[0], a[1] - b[1]
    return (abs(dq) + abs(dr) + abs(dq + dr)) // 2


def rotate(c: Coord, turns: int) -> Coord:
    """Turn a coordinate by 60° steps round the center."""
    q, r = c
    for _ in range(turns % 6):
        q, r = -r, q + r
    return (q, r)


def layout_preset(radius: int, recipe: MapRecipe, num_players: int, turns: int = 0) -> MapLayout:
    """Lay the recipe out on a board of `radius` for `num_players`, turned by
    `turns` × 60° (the map seed picks the turn, so the island looks different
    from game to game while every seat stays the same)."""
    n = 6 * radius
    if num_players == 5:
        fracs = [s / n for s in sorted(recipe.five_player_bases)]
        gaps = recipe.five_player_gaps if recipe.five_player_gaps is not None else recipe.gaps
        seated = list(range(5))
    else:
        fracs = [k / 6 for k in range(6)]
        gaps = recipe.gaps
        seated = list(CORNER_SEATS.get(num_players, range(min(max(num_players, 0), 6))))

    out = MapLayout()
    kinds = {"premium": out.premium, "standard": out.standard, "blocked": out.blocked}
    if recipe.center:
        kinds[recipe.center].add((0, 0))
    for f in fracs:
        for kind, depth in recipe.axis:
            kinds[kind].add(_at(depth, f * 6 * depth))
    for i, f in enumerate(fracs):
        g = fracs[(i + 1) % len(fracs)]
        if g <= f:
            g += 1
        mid = (f + g) / 2
        for feat in gaps:
            x = mid * 6 * feat.depth
            for t in [_at(feat.depth, x + feat.offset)] if feat.spread == 0 else _pair(feat.depth, x, feat.spread):
                kinds[feat.kind].add(t)
    # A tile is one thing: premium outranks standard outranks a mountain.
    out.standard -= out.premium
    out.blocked -= out.premium | out.standard

    inner_ring = ring(radius - 1)
    for i in seated:
        f = fracs[i]
        base = _at(radius, f * n)
        inner = _at(radius - 1, f * 6 * (radius - 1))
        if _distance(base, inner) != 1:
            inner = min(
                (t for t in inner_ring if _distance(t, base) == 1),
                key=lambda t: abs(inner_ring.index(t) - f * 6 * (radius - 1)),
            )
        out.starting_positions.append([base, inner])

    if turns % 6:
        out.premium = {rotate(t, turns) for t in out.premium}
        out.standard = {rotate(t, turns) for t in out.standard}
        out.blocked = {rotate(t, turns) for t in out.blocked}
        out.starting_positions = [[rotate(t, turns) for t in c] for c in out.starting_positions]
    return out
