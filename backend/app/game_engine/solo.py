"""Solo campaign: three archetype campaigns of pre-made levels on one overworld.

data/solo_levels.yaml holds the overworld, the campaigns and the levels.
Vanguard, Swarm and Fortress each have a campaign: an ordered list of levels
played from that archetype's own castle on the overworld, always as that
archetype. A level sits on one overworld spot. A level in two campaigns (a
shared level) is the same spot and map, reached by each campaign's own road
and usually played from the other side: its `variants` give each archetype
its own objective, rivals, seat (`seat: B` — you take B's base) and text.

A level plays as an ordinary game with ``GameState.solo`` set
(create_solo_game): create_game gets the level's grid and cards, Debt follows
the level (never for a player alone), and at the end of each round
check_solo_objective decides the game instead of the usual VP target and
round limit.

Maps are hex art: one character per tile, a tile on every other character
of a line, each column (q) half a row below the one to its left, like the
board unturned — so a column's tiles are two lines apart:

    . . . .            a tile's six neighbours: two lines up and down in
     . . . .           its column, and one line up and down in the columns
    . A . .            either side
     . a . .

(Shown with one character per column here; in the YAML each column takes
two characters: see the levels.) Put your base at the bottom: the game turns
the board so your base sits above your hand. The legend (BUILTIN_LEGEND, plus
a level's own `legend`) says what each character is. Overrides by "q,r" key
change single tiles of any map, including a preset one (`preset: small`);
`uv run python scripts/solo_levels.py map <level>` prints a level's map with
its coordinates.

Objectives: see Objective. New objective types go in Objective.from_data and
goal, objective_progress, _judge, and the frontend's SoloObjectiveType.
"""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

from .card_packs import CARD_PACKS, CardPack
from .cards import Archetype, Card, _copy_card
from .effects import EffectType
from .hex_grid import GRID_CONFIG, GridSize, HexGrid, HexTile, generate_hex_grid

DATA_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data"
SOLO_LEVELS_PATH = DATA_DIR / "solo_levels.yaml"

Coord = tuple[int, int]

ARCHETYPES = ("vanguard", "swarm", "fortress")
DIFFICULTIES = ("easy", "medium", "hard")
OBJECTIVE_TYPES = ("vp", "territory", "vp_hexes", "raid", "survive", "capture", "fortify")
MARKETS = ("fixed", "random")
SOLO_PLAYER_ID = "player_0"
# A level with no time limit still stops here (lost): a stalemate shouldn't
# run forever. Nobody should come near it.
UNTIMED_ROUND_GUARD = 50
PLAYER_COLOR = "#4363d8"
BOT_COLORS = ["#e6194b", "#f58231", "#911eb4", "#ffe119", "#42d4f4"]
BOT_NAMES = ["Rival", "Marauder", "Warlord", "Usurper", "Pretender"]
SEAT_LETTERS = "ABCDEF"
# Characters that are sea (no tile) in hex art.
SEA = frozenset(" ")
# The overworld's own characters: each campaign's castle, and level spots
# (a level names its spot by character).
CASTLE_CHARS = {"V": "vanguard", "S": "swarm", "F": "fortress"}
SPOT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"

_DIRS: tuple[Coord, ...] = ((1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1))


class LevelError(ValueError):
    """A level (or the overworld) in solo_levels.yaml is malformed."""


# ── Tiles and maps ─────────────────────────────────────────────


@dataclass(frozen=True)
class TileKind:
    """What a map character stands for."""

    blocked: bool = False
    vp: int = 0
    # None: the default — 2 for a 1-VP hex, 3 for a bigger one, else 0.
    defense: Optional[int] = None
    base: Optional[int] = None    # this seat's base
    start: Optional[int] = None   # this seat starts holding it
    # Scorched earth: burnt wasteland nobody can claim (blocked, drawn burnt);
    # `ruins` draws the ruins of a burnt town on it.
    scorched: bool = False
    ruins: bool = False
    # Water: a lake or inlet nobody can claim (blocked), with beaches round it.
    water: bool = False

    @property
    def effective_defense(self) -> int:
        if self.defense is not None:
            return self.defense
        if self.vp:
            return 2 if self.vp == 1 else 3
        return 0

    @staticmethod
    def from_data(data: Any, where: str) -> "TileKind":
        if not isinstance(data, dict):
            raise LevelError(f"{where}: a tile is a mapping like {{vp: 2, defense: 3}}")
        unknown = set(data) - {"blocked", "vp", "defense", "base", "start", "scorched", "ruins", "water"}
        if unknown:
            raise LevelError(f"{where}: unknown tile field(s) {sorted(unknown)}")
        scorched = bool(data.get("scorched", False)) or bool(data.get("ruins", False))
        water = bool(data.get("water", False))
        if scorched and water:
            raise LevelError(f"{where}: a tile can't be both scorched and water")
        return TileKind(
            blocked=bool(data.get("blocked", False)) or scorched or water,
            scorched=scorched,
            ruins=bool(data.get("ruins", False)),
            water=water,
            vp=int(data.get("vp", 0)),
            defense=None if data.get("defense") is None else int(data["defense"]),
            base=None if data.get("base") is None else int(data["base"]),
            start=None if data.get("start") is None else int(data["start"]),
        )


BUILTIN_LEGEND: dict[str, TileKind] = {
    ".": TileKind(),
    "#": TileKind(blocked=True),       # mountain
    "~": TileKind(blocked=True, water=True),                 # water (beaches round it)
    "%": TileKind(blocked=True, scorched=True),              # scorched earth
    "&": TileKind(blocked=True, scorched=True, ruins=True),  # a burnt town's ruins
    "*": TileKind(vp=1),               # VP hex (defense 2)
    "@": TileKind(vp=2),               # premium VP hex (defense 3)
    **{str(d): TileKind(defense=d) for d in range(1, 10)},  # land with defense
    **{c: TileKind(base=i) for i, c in enumerate(SEAT_LETTERS)},          # A = you, B… bots
    **{c: TileKind(start=i) for i, c in enumerate(SEAT_LETTERS.lower())},  # starting land
}


def parse_layout(text: str, legend: dict[str, Optional[TileKind]], where: str) -> dict[Coord, TileKind]:
    """Read hex art into tiles, centred near (0, 0). A legend entry of None
    is sea. The first tile sets the grid: every tile is an even number of
    characters across from it, on a line of matching parity (so the whole
    picture can shift without changing the map)."""
    raw: dict[Coord, TileKind] = {}
    grid: Optional[tuple[int, int]] = None  # (column parity, line parity)
    for line_no, line in enumerate(text.splitlines()):
        for col, ch in enumerate(line.rstrip()):
            if ch in SEA:
                continue
            if ch not in legend:
                raise LevelError(f"{where}: line {line_no + 1}, column {col + 1}: unknown tile {ch!r}")
            kind = legend[ch]
            if kind is None:
                continue
            if grid is None:
                grid = (col % 2, (line_no - col // 2) % 2)
            if col % 2 != grid[0]:
                raise LevelError(
                    f"{where}: line {line_no + 1}, column {col + 1}: off the grid — tiles are "
                    "two characters apart across a line")
            q = col // 2
            if (line_no - q) % 2 != grid[1]:
                raise LevelError(
                    f"{where}: line {line_no + 1}, column {col + 1}: off the grid — a column's "
                    "tiles are on every other line, half a row from the columns beside it")
            raw[(q, (line_no - q - grid[1]) // 2)] = kind
    if not raw:
        raise LevelError(f"{where}: the map has no tiles")
    cq = round(sum(q for q, _ in raw) / len(raw))
    cr = round(sum(r for _, r in raw) / len(raw))
    return {(q - cq, r - cr): k for (q, r), k in raw.items()}


def render_layout(tiles: dict[Coord, str]) -> str:
    """Hex art for tiles given as characters (the inverse of parse_layout)."""
    if not tiles:
        return ""
    q0 = min(q for q, _ in tiles)
    line_of = {c: 2 * c[1] + c[0] for c in tiles}
    l0 = min(line_of.values())
    rows: dict[int, dict[int, str]] = {}
    for c, ch in tiles.items():
        rows.setdefault(line_of[c] - l0, {})[2 * (c[0] - q0)] = ch
    out: list[str] = []
    for line in range(max(rows) + 1):
        row = rows.get(line, {})
        out.append("".join(row.get(i, " ") for i in range(max(row) + 1)) if row else "")
    return "\n".join(out)


def _neighbours(c: Coord) -> list[Coord]:
    return [(c[0] + dq, c[1] + dr) for dq, dr in _DIRS]


def _key(c: Coord) -> str:
    return f"{c[0]},{c[1]}"


def _coord(key: str, where: str) -> Coord:
    try:
        q, r = (int(v) for v in str(key).split(","))
    except ValueError:
        raise LevelError(f"{where}: {key!r} is not a \"q,r\" tile key") from None
    return (q, r)


def _grid_size_for(tile_count: int) -> GridSize:
    """The preset size closest in tile count (names the map's scale)."""
    for size in GridSize:
        if GRID_CONFIG[size]["tiles"] >= tile_count:
            return size
    return GridSize.ULTRA


def _preset_tiles(size_name: str, seats: int, where: str) -> dict[Coord, TileKind]:
    try:
        size = GridSize(size_name)
    except ValueError:
        raise LevelError(f"{where}: unknown preset map {size_name!r}") from None
    grid = generate_hex_grid(size, seats, random.Random(0))
    starts = {c: seat for seat, cluster in enumerate(grid.starting_positions) for c in cluster[1:]}
    bases = {cluster[0]: seat for seat, cluster in enumerate(grid.starting_positions)}
    out: dict[Coord, TileKind] = {}
    for t in grid.tiles.values():
        c = (t.q, t.r)
        out[c] = TileKind(
            blocked=t.is_blocked, vp=t.vp_value if t.is_vp else 0,
            defense=t.base_defense, base=bases.get(c), start=starts.get(c),
        )
    return out


# ── Levels ──────────────────────────────────────────────────────


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


@dataclass(frozen=True)
class Objective:
    """What clears a level, judged at the end of every round up to `rounds`
    (no `rounds`: no time limit — the level is lost only when a rival reaches
    `bot_vp` first, so it needs bots and a `bot_vp`; never a survive).

    vp        reach `vp` VP
    territory hold `tiles` tiles — or more than `share` (e.g. 0.5) of the
              map's claimable land
    vp_hexes  hold every VP hex at once (`connected`: each linked to your base)
    raid      raid every rival's base (a successful raid, each at least once)
    capture   take `tiles` tiles from your rivals (in all, over the game)
    fortify   hold `tiles` tiles with permanent defense `defense` or more at
              once (a tile's own defense plus Barricade-style bonuses)
    survive   hold out until the end of round `rounds`: lost as soon as your
              base has been raided more than `raids_allowed` times (default
              0) or you've lost more than `tiles_lost_max` tiles (if set); at
              the end you must still hold `tiles` tiles (if set)

    With bots, a bot reaching `bot_vp` first loses the level (a vp objective
    defaults it to `vp`; the others have none unless set).
    """

    type: str
    rounds: Optional[int]   # None: no time limit
    vp: int = 0
    tiles: int = 0
    share: Optional[float] = None
    land: int = 0          # the map's claimable tiles (territory)
    count: int = 0         # VP hexes (vp_hexes) or rivals (raid, capture)
    connected: bool = False
    defense: int = 0       # fortify
    raids_allowed: int = 0  # survive
    tiles_lost_max: Optional[int] = None  # survive
    bot_vp: Optional[int] = None

    @staticmethod
    def from_data(data: Any, where: str, land: int, vp_hexes: int, rivals: int) -> "Objective":
        if not isinstance(data, dict):
            raise LevelError(f"{where}: objective must be a mapping")
        kind = str(data.get("type", "vp"))
        if kind not in OBJECTIVE_TYPES:
            raise LevelError(f"{where}: unknown objective type {kind!r} (have: {', '.join(OBJECTIVE_TYPES)})")
        allowed = {"type", "rounds", "bot_vp", *{
            "vp": ["vp"], "territory": ["tiles", "share"], "vp_hexes": ["connected"], "raid": [],
            "capture": ["tiles"], "fortify": ["tiles", "defense"],
            "survive": ["raids_allowed", "tiles_lost_max", "tiles"],
        }[kind]}
        unknown = set(data) - allowed
        if unknown:
            raise LevelError(f"{where}: a {kind} objective doesn't take {sorted(unknown)}")

        def whole(key: str, least: int = 1) -> int:
            try:
                value = int(data[key])
            except (KeyError, TypeError, ValueError):
                raise LevelError(f"{where}: a {kind} objective needs a whole number `{key}`") from None
            if value < least:
                raise LevelError(f"{where}: `{key}` must be at least {least}")
            return value

        rounds = None if data.get("rounds") is None else whole("rounds")
        bot_vp = None if data.get("bot_vp") is None else int(data["bot_vp"])
        if bot_vp is not None and not rivals:
            raise LevelError(f"{where}: bot_vp, but the level has no bots")
        if rounds is None and (kind == "survive" or not rivals or (bot_vp is None and kind != "vp")):
            raise LevelError(
                f"{where}: an objective with no `rounds` (no time limit) needs bots and a `bot_vp` "
                "— a rival reaching it is the only way to lose — and can't be a survive")
        if kind in ("raid", "capture", "survive") and not rivals:
            raise LevelError(f"{where}: a {kind} objective needs bots")
        if kind == "vp":
            return Objective(kind, rounds, vp=whole("vp"), bot_vp=bot_vp)
        if kind == "territory":
            if ("tiles" in data) == ("share" in data):
                raise LevelError(f"{where}: a territory objective has `tiles` or `share` (one of them)")
            if "share" in data:
                share = float(data["share"])
                if not 0 < share < 1:
                    raise LevelError(f"{where}: share is a fraction between 0 and 1")
                tiles = int(share * land) + 1  # more than that share
            else:
                share, tiles = None, whole("tiles")
            if tiles > land:
                raise LevelError(f"{where}: {tiles} tiles, but the map has only {land} to claim")
            return Objective(kind, rounds, tiles=tiles, share=share, land=land, bot_vp=bot_vp)
        if kind == "vp_hexes":
            if not vp_hexes:
                raise LevelError(f"{where}: a vp_hexes objective needs VP hexes on the map")
            return Objective(kind, rounds, count=vp_hexes, connected=bool(data.get("connected", False)), bot_vp=bot_vp)
        if kind == "raid":
            return Objective(kind, rounds, count=rivals, bot_vp=bot_vp)
        if kind == "capture":
            return Objective(kind, rounds, tiles=whole("tiles"), count=rivals, bot_vp=bot_vp)
        if kind == "fortify":
            return Objective(kind, rounds, tiles=whole("tiles"), defense=whole("defense"), bot_vp=bot_vp)
        # survive
        lost = None if data.get("tiles_lost_max") is None else whole("tiles_lost_max", 0)
        tiles = whole("tiles") if "tiles" in data else 0
        if tiles > land:
            raise LevelError(f"{where}: {tiles} tiles, but the map has only {land} to claim")
        return Objective(kind, rounds, tiles=tiles, count=rivals,
                         raids_allowed=whole("raids_allowed", 0) if "raids_allowed" in data else 0,
                         tiles_lost_max=lost, bot_vp=bot_vp)

    @property
    def rival_vp(self) -> Optional[int]:
        if self.bot_vp is not None:
            return self.bot_vp
        return self.vp if self.type == "vp" else None

    def goal(self) -> str:
        """The goal alone (a survive goal includes its deadline)."""
        if self.type == "vp":
            return f"Reach {self.vp} VP"
        if self.type == "territory":
            if self.share is not None:
                part = "half" if self.share == 0.5 else f"{round(self.share * 100)}% of"
                return f"Hold more than {part} the land ({self.tiles} of {self.land} tiles)"
            return f"Hold {self.tiles} tiles"
        if self.type == "vp_hexes":
            each = ", each connected to your base" if self.connected else ""
            return f"Hold all {self.count} VP hexes at once{each}"
        if self.type == "raid":
            if self.count == 1:
                return "Raid your rival's base"
            return "Raid both rivals' bases" if self.count == 2 else f"Raid all {self.count} rivals' bases"
        if self.type == "capture":
            return f"Take {_plural(self.tiles, 'tile')} from {'your rival' if self.count == 1 else 'your rivals'}"
        if self.type == "fortify":
            return f"Fortify {_plural(self.tiles, 'tile')} to defense {self.defense} at once"
        parts = ["without your base being raided" if self.raids_allowed == 0
                 else "with your base raided at most once" if self.raids_allowed == 1
                 else f"with your base raided at most {self.raids_allowed} times"]
        if self.tiles_lost_max is not None:
            parts.append("without losing a tile" if self.tiles_lost_max == 0
                         else f"losing no more than {_plural(self.tiles_lost_max, 'tile')}")
        if self.tiles:
            parts.append(f"still holding {self.tiles} tiles at the end")
        joined = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
        return f"Hold out to the end of round {self.rounds} {joined}"

    def headline(self) -> str:
        """The goal in a few words, for titles (the intro, the HUD)."""
        if self.type == "survive":
            return f"Hold out for {self.rounds} rounds"
        if self.type == "territory":
            if self.share is not None:
                return "Hold more than half the land" if self.share == 0.5 else f"Hold {round(self.share * 100)}% of the land"
            return f"Hold {self.tiles} tiles"
        if self.type == "vp_hexes":
            return f"Hold all {self.count} VP hexes"
        if self.type in ("capture", "fortify"):
            return f"{'Take' if self.type == 'capture' else 'Fortify'} {_plural(self.tiles, 'tile')}"
        return self.goal()

    def describe(self, with_bots: bool = False) -> str:
        text = self.goal()
        if self.type != "survive" and self.rounds is not None:
            text += f" by the end of round {self.rounds}"
        if with_bots and self.rival_vp is not None:
            text += f" — before a rival reaches {self.rival_vp} VP"
        return text + ("." if self.rounds is not None else ". No time limit.")

    def to_dict(self, with_bots: bool = False) -> dict[str, Any]:
        return {
            "type": self.type, "rounds": self.rounds,
            "vp": self.vp or None, "tiles": self.tiles or None, "share": self.share,
            "land": self.land or None, "count": self.count or None, "connected": self.connected,
            "defense": self.defense or None, "raids_allowed": self.raids_allowed,
            "tiles_lost_max": self.tiles_lost_max,
            "bot_vp": self.rival_vp if with_bots else None,
            "goal": self.goal(),
            "headline": self.headline(),
            "text": self.describe(with_bots),
        }


@dataclass(frozen=True)
class SoloBot:
    archetype: str
    difficulty: str
    name: str


@dataclass
class SoloLevel:
    """A level as one campaign plays it (a shared level has one per campaign)."""

    id: str
    archetype: str          # the campaign: you always play as it
    spot: Coord             # where it sits on the overworld
    title: str
    intro: str
    objective: Objective
    map_name: str
    tiles: dict[Coord, TileKind]   # seat 0 is yours
    shared_card_ids: list[str]
    archetype_card_ids: dict[str, list[str]]
    pack_id: Optional[str] = None
    market: str = "fixed"
    market_size: int = 3
    bots: list[SoloBot] = field(default_factory=list)
    debt: bool = True
    hints: list[str] = field(default_factory=list)
    # Cards the level introduces (its objective is near impossible without
    # them); the briefing shows them first.
    spotlight: list[str] = field(default_factory=list)
    # The other campaigns this level is in (played from their side).
    shared_with: list[str] = field(default_factory=list)

    @property
    def seats(self) -> int:
        return 1 + len(self.bots)

    @property
    def card_pack_id(self) -> str:
        """GameState.card_pack for the level's games (names the pool)."""
        return self.pack_id or f"solo:{self.id}"

    def pool(self) -> dict[str, Any]:
        """The card pool as stored on GameState.solo (read by game_pack)."""
        return {
            "shared_card_ids": list(self.shared_card_ids),
            "archetype_card_ids": {a: list(ids) for a, ids in self.archetype_card_ids.items()},
            "fixed": self.market == "fixed",
        }

    def card_pack(self) -> CardPack:
        return CardPack(
            id=self.card_pack_id, name=self.title,
            shared_card_ids=list(self.shared_card_ids),
            archetype_card_ids=(
                {a: list(ids) for a, ids in self.archetype_card_ids.items()}
                if self.market == "fixed" else None
            ),
        )

    def build_grid(self) -> HexGrid:
        """The level's board; starting_positions seat you, then the bots."""
        grid = HexGrid(size=_grid_size_for(len(self.tiles)))
        bases: dict[int, Coord] = {}
        starts: dict[int, list[Coord]] = {}
        for (q, r), kind in sorted(self.tiles.items()):
            tile = HexTile(q=q, r=r, is_blocked=kind.blocked, is_vp=kind.vp > 0, vp_value=kind.vp or 1,
                           is_scorched=kind.scorched, scorched_vp=1 if kind.ruins else 0, is_water=kind.water)
            if not kind.blocked:
                tile.base_defense = tile.defense_power = kind.effective_defense
            grid.tiles[tile.key] = tile
            if kind.base is not None:
                bases[kind.base] = (q, r)
            if kind.start is not None:
                starts.setdefault(kind.start, []).append((q, r))
        grid.starting_positions = [[bases[s], *starts.get(s, [])] for s in range(self.seats)]
        return grid

    def map_summary(self) -> dict[str, Any]:
        tiles = list(self.tiles.values())
        return {
            "name": self.map_name,
            "tiles": len(tiles),
            "vp_hexes": sum(1 for t in tiles if t.vp),
            "vp_total": sum(t.vp for t in tiles),
            "mountains": sum(1 for t in tiles if t.blocked and not t.scorched and not t.water),
            "scorched": sum(1 for t in tiles if t.scorched),
            "water": sum(1 for t in tiles if t.water),
        }

    def to_dict(self) -> dict[str, Any]:
        """What the briefing shows (everything but the map's tiles)."""
        return {
            "id": self.id,
            "archetype": self.archetype,
            "spot": _key(self.spot),
            "title": self.title,
            "intro": self.intro,
            "objective": self.objective.to_dict(with_bots=bool(self.bots)),
            "map": self.map_summary(),
            "cards": {"shared": list(self.shared_card_ids), "archetype": {a: list(v) for a, v in self.archetype_card_ids.items()}},
            "pack_id": self.pack_id,
            "market": self.market,
            "market_size": self.market_size,
            "bots": [{"name": b.name, "archetype": b.archetype, "difficulty": b.difficulty} for b in self.bots],
            "debt": self.debt and bool(self.bots),
            "hints": list(self.hints),
            "spotlight": list(self.spotlight),
            "shared_with": list(self.shared_with),
        }


def needs_opponent(card: Card) -> bool:
    """The card targets another player (useless, or stuck, when alone)."""
    if card.forced_discard > 0 or (card.upgraded_forced_discard or 0) > 0:
        return True
    return any(
        e.type == EffectType.INJECT_RUBBLE or e.target in ("opponent", "chosen_player", "all_others")
        for e in card.effects
    )


def _buyable(registry: dict[str, Card], archetype: Archetype, core_only: bool) -> list[str]:
    return [
        c.id for c in registry.values()
        if c.archetype == archetype and not c.starter and c.buy_cost is not None
        and (c.card_set == "core" or not core_only)
    ]


def _card_list(value: Any, archetype: Archetype, registry: dict[str, Card], where: str) -> list[str]:
    """A level's card list: ids, or "all" (every buyable card of the
    archetype, set-aside ones too) or "core" (the Core set's)."""
    if value in ("all", "core"):
        return _buyable(registry, archetype, core_only=value == "core")
    if not isinstance(value, list) or not value:
        raise LevelError(f"{where}: give a list of card ids, \"all\" or \"core\"")
    ids = [str(v) for v in value]
    for cid in ids:
        card = registry.get(cid)
        if card is None:
            raise LevelError(f"{where}: unknown card {cid!r}")
        if card.archetype != archetype:
            raise LevelError(f"{where}: {cid} is a {card.archetype.value} card")
        if card.starter or card.buy_cost is None:
            raise LevelError(f"{where}: {cid} can't be bought")
    if len(set(ids)) != len(ids):
        raise LevelError(f"{where}: a card is listed twice")
    return ids


# Fields a level may have, and those a variant may replace.
LEVEL_FIELDS = {"id", "title", "intro", "spot", "objective", "map", "cards", "market", "market_size",
                "bots", "debt", "hints", "spotlight", "seat", "variants"}
VARIANT_FIELDS = {"title", "intro", "objective", "cards", "market", "market_size",
                  "bots", "debt", "hints", "spotlight", "seat"}


def _parse_level(
    data: dict[str, Any], registry: dict[str, Card], archetype: str,
    spot: Coord = (0, 0), shared_with: Optional[list[str]] = None,
) -> SoloLevel:
    """The level as `archetype`'s campaign plays it (its variant applied)."""
    lid = str(data["id"])
    where = f"level {lid} ({archetype})"
    variant = (data.get("variants") or {}).get(archetype) or {}
    merged = {**{k: v for k, v in data.items() if k != "variants"}, **variant}

    bots: list[SoloBot] = []
    for i, b in enumerate(merged.get("bots") or []):
        if not isinstance(b, dict):
            raise LevelError(f"{where}: bot {i + 1} must be a mapping")
        arch, diff = str(b.get("archetype", "")), str(b.get("difficulty", "easy"))
        if arch not in ARCHETYPES:
            raise LevelError(f"{where}: bot {i + 1} has unknown archetype {arch!r}")
        if diff not in DIFFICULTIES:
            raise LevelError(f"{where}: bot {i + 1} has unknown difficulty {diff!r}")
        bots.append(SoloBot(arch, diff, str(b.get("name") or BOT_NAMES[i % len(BOT_NAMES)])))
    if len(bots) > 5:
        raise LevelError(f"{where}: at most 5 bots")

    # Card pool: a pack, then per-list replacements.
    cards = merged.get("cards") or {}
    if not isinstance(cards, dict):
        raise LevelError(f"{where}: cards must be a mapping")
    unknown = set(cards) - {"pack", "shared", *ARCHETYPES}
    if unknown:
        raise LevelError(f"{where}: unknown cards field(s) {sorted(unknown)}")
    pack_id = cards.get("pack")
    shared: Optional[list[str]] = None
    arch_ids: dict[str, list[str]] = {}
    if pack_id is not None:
        pack = CARD_PACKS.get(str(pack_id))
        if pack is None or pack.shared_card_ids is None or pack.archetype_card_ids is None:
            raise LevelError(f"{where}: {pack_id!r} is not a 5 + 5 card pack")
        shared = list(pack.shared_card_ids)
        arch_ids = {a: list(v) for a, v in pack.archetype_card_ids.items()}
    if "shared" in cards:
        shared = [] if cards["shared"] == [] else _card_list(cards["shared"], Archetype.SHARED, registry, f"{where} shared cards")
    for arch in ARCHETYPES:
        if arch in cards:
            arch_ids[arch] = _card_list(cards[arch], Archetype(arch), registry, f"{where} {arch} cards")
    if shared is None:
        raise LevelError(f"{where}: cards needs a pack or a shared list")
    for arch in {archetype} | {b.archetype for b in bots}:
        if not arch_ids.get(arch):
            raise LevelError(f"{where}: no {arch} cards (a pack, or a {arch} list)")
    if not bots:
        lonely = [cid for cid in shared + arch_ids[archetype] if needs_opponent(registry[cid])]
        if lonely:
            raise LevelError(f"{where}: {', '.join(lonely)} target an opponent, and the level has no bots")

    market = str(merged.get("market", "fixed"))
    if market not in MARKETS:
        raise LevelError(f"{where}: market is fixed or random")
    market_size = int(merged.get("market_size", 3))
    if market_size < 1:
        raise LevelError(f"{where}: market_size must be at least 1")

    seat = str(merged.get("seat", "A"))
    if len(seat) != 1 or seat not in SEAT_LETTERS:
        raise LevelError(f"{where}: seat is a base letter, A to F")
    tiles, map_name = _parse_map(merged.get("map"), 1 + len(bots), where, SEAT_LETTERS.index(seat))
    objective = Objective.from_data(
        merged.get("objective"), where,
        land=sum(1 for k in tiles.values() if not k.blocked),
        vp_hexes=sum(1 for k in tiles.values() if k.vp),
        rivals=len(bots),
    )

    spotlight = [str(c) for c in (merged.get("spotlight") or [])]
    pool = set(shared) | {c for ids in arch_ids.values() for c in ids}
    missing = [c for c in spotlight if c not in pool]
    if missing:
        raise LevelError(f"{where}: spotlight card(s) {missing} aren't in the level's cards")

    hints = merged.get("hints") or []
    if not isinstance(hints, list) or not all(isinstance(h, str) for h in hints):
        raise LevelError(f"{where}: hints is a list of lines (quote a line that has a colon in it)")

    return SoloLevel(
        id=lid,
        archetype=archetype,
        spot=spot,
        title=str(merged.get("title") or lid),
        intro=" ".join(str(merged.get("intro") or "").split()),
        objective=objective,
        map_name=map_name,
        tiles=tiles,
        shared_card_ids=shared,
        archetype_card_ids={a: arch_ids[a] for a in ARCHETYPES if a in arch_ids},
        pack_id=str(pack_id) if pack_id is not None and "shared" not in cards
        and not any(a in cards for a in ARCHETYPES) else None,
        market=market,
        market_size=market_size,
        bots=bots,
        debt=bool(merged.get("debt", True)),
        hints=[" ".join(str(h).split()) for h in hints],
        spotlight=spotlight,
        shared_with=list(shared_with or []),
    )


def _parse_map(data: Any, seats: int, where: str, you: int = 0) -> tuple[dict[Coord, TileKind], str]:
    """The map's tiles with you in seat 0 (you take base letter `you`) and
    the bots in the other seats, in letter order; seats nobody takes are
    plain land."""
    if not isinstance(data, dict):
        raise LevelError(f"{where}: map must be a mapping (layout or preset)")
    unknown = set(data) - {"name", "layout", "preset", "legend", "overrides"}
    if unknown:
        raise LevelError(f"{where}: unknown map field(s) {sorted(unknown)}")
    legend: dict[str, Optional[TileKind]] = dict(BUILTIN_LEGEND)
    for ch, spec in (data.get("legend") or {}).items():
        if len(str(ch)) != 1 or str(ch) in SEA:
            raise LevelError(f"{where}: legend keys are single characters (not space or ~)")
        legend[str(ch)] = TileKind.from_data(spec, f"{where} legend {ch!r}")
    if ("layout" in data) == ("preset" in data):
        raise LevelError(f"{where}: a map has a layout or a preset (one of them)")
    if "layout" in data:
        tiles = parse_layout(str(data["layout"]), legend, f"{where} map")
        name = str(data.get("name") or "Uncharted")
    else:
        tiles = _preset_tiles(str(data["preset"]), max(seats, you + 1), where)
        name = str(data.get("name") or str(data["preset"]).title())
    for key, spec in (data.get("overrides") or {}).items():
        c = _coord(key, f"{where} overrides")
        if isinstance(spec, str):
            if spec in SEA:
                tiles.pop(c, None)
                continue
            kind = legend.get(spec)
            if kind is None:
                raise LevelError(f"{where} overrides {key}: unknown tile {spec!r}")
        else:
            kind = TileKind.from_data(spec, f"{where} overrides {key}")
        if kind.base is not None:
            # A seat's base moves: the old one becomes plain land.
            for other, k in list(tiles.items()):
                if k.base == kind.base:
                    tiles[other] = TileKind()
        tiles[c] = kind
    tiles = _seat(tiles, seats, you, where)
    _check_seats(tiles, seats, where)
    return tiles, name


def _seat(tiles: dict[Coord, TileKind], seats: int, you: int, where: str) -> dict[Coord, TileKind]:
    """Renumber the map's seats: `you` first, then the rest in letter order;
    seats past the level's players become plain land."""
    present = sorted({k.base for k in tiles.values() if k.base is not None})
    if you not in present:
        raise LevelError(f"{where}: your seat is {SEAT_LETTERS[you]}, but the map has no {SEAT_LETTERS[you]}")
    order = [you] + [s for s in present if s != you]
    renumber = {old: new for new, old in enumerate(order) if new < seats}
    out: dict[Coord, TileKind] = {}
    for c, k in tiles.items():
        if k.base is None and k.start is None:
            out[c] = k
            continue
        seat = k.base if k.base is not None else k.start
        new = renumber.get(seat) if seat is not None else None
        if new is None:
            out[c] = TileKind(defense=k.defense)
        elif k.base is not None:
            out[c] = TileKind(defense=k.defense, base=new)
        else:
            out[c] = TileKind(defense=k.defense, start=new)
    return out


def _check_seats(tiles: dict[Coord, TileKind], seats: int, where: str) -> None:
    for seat in range(seats):
        bases = [c for c, k in tiles.items() if k.base == seat]
        if len(bases) != 1:
            who = "your base" if seat == 0 else f"a base for bot {seat}"
            raise LevelError(f"{where}: the map needs {who} (one base letter per player); found {len(bases)}")
    for c, k in tiles.items():
        if (k.base is not None or k.start is not None) and (k.blocked or k.vp):
            raise LevelError(f"{where}: a starting tile at {_key(c)} can't be a mountain or VP hex")


# ── The overworld and the campaigns ─────────────────────────────


def _parse_overworld_map(
    data: Any,
) -> tuple[dict[Coord, bool], dict[str, Coord], dict[str, Coord], dict[Coord, str]]:
    """(tiles → blocked, castle per archetype, spot per character, scorched
    and water tiles)."""
    where = "overworld"
    if not isinstance(data, dict) or "layout" not in data:
        raise LevelError(f"{where}: needs a layout")
    archs = list(CASTLE_CHARS.values())
    legend: dict[str, Optional[TileKind]] = {
        ".": TileKind(), "#": TileKind(blocked=True),
        "%": TileKind(blocked=True, scorched=True), "~": TileKind(blocked=True, water=True),
        **{ch: TileKind(base=archs.index(a)) for ch, a in CASTLE_CHARS.items()},
        # A spot's character, by its place in SPOT_CHARS (vp holds index + 1).
        **{ch: TileKind(vp=i + 1) for i, ch in enumerate(SPOT_CHARS)},
    }
    text = str(data["layout"])
    for ch in set(text) - SEA - {"\n"}:
        if ch in SPOT_CHARS or ch in CASTLE_CHARS:
            if text.count(ch) > 1:
                raise LevelError(f"{where}: {ch!r} is on the map {text.count(ch)} times (once each)")
    kinds = parse_layout(text, legend, where)
    tiles = {c: k.blocked for c, k in kinds.items()}
    castles = {archs[k.base]: c for c, k in kinds.items() if k.base is not None}
    spots = {SPOT_CHARS[k.vp - 1]: c for c, k in kinds.items() if k.vp}
    marks = {c: ("scorched" if k.scorched else "water") for c, k in kinds.items() if k.scorched or k.water}
    return tiles, castles, spots, marks


def _roads(tiles: dict[Coord, bool], stops: list[Coord], avoid: set[Coord]) -> list[list[Coord]]:
    """The shortest land road between each stop and the next (each road ends
    on its stop), never through a tile in `avoid` other than its own stop."""
    def road(start: Coord, goal: Coord) -> Optional[list[Coord]]:
        prev: dict[Coord, Optional[Coord]] = {start: None}
        queue = deque([start])
        while queue:
            cur = queue.popleft()
            if cur == goal:
                path: list[Coord] = []
                c: Optional[Coord] = cur
                while c is not None and c != start:
                    path.append(c)
                    c = prev[c]
                return list(reversed(path))
            for n in _neighbours(cur):
                if n not in tiles or tiles[n] or n in prev or (n in avoid and n != goal):
                    continue
                prev[n] = cur
                queue.append(n)
        return None

    out: list[list[Coord]] = []
    for here, there in zip(stops, stops[1:]):
        seg = road(here, there)
        if seg is None:
            raise LevelError(f"overworld: no road over land from {_key(here)} to {_key(there)}")
        out.append(seg)
    return out


@dataclass
class ArchetypeCampaign:
    """One archetype's campaign: its castle, its levels in order, and the
    road it builds from level to level."""

    archetype: str
    title: str
    blurb: str
    castle: Coord
    levels: list[SoloLevel]
    # Spots past the last level, shown as coming soon.
    soon: list[Coord] = field(default_factory=list)
    # segments[i]: the road to stop i (the levels' spots, then the soon
    # spots), from the castle or the stop before; it ends on the stop.
    segments: list[list[Coord]] = field(default_factory=list)

    def level(self, level_id: str) -> Optional[SoloLevel]:
        return next((lv for lv in self.levels if lv.id == level_id), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "archetype": self.archetype,
            "title": self.title,
            "blurb": self.blurb,
            "castle": _key(self.castle),
            "spots": [_key(lv.spot) for lv in self.levels],
            "soon": [_key(c) for c in self.soon],
            "segments": [[_key(c) for c in seg] for seg in self.segments],
            "levels": [lv.to_dict() for lv in self.levels],
        }


@dataclass
class Campaign:
    """The whole solo mode: the overworld and the three campaigns."""

    tiles: dict[Coord, bool]   # overworld tile → blocked
    campaigns: dict[str, ArchetypeCampaign]
    # Blocked tiles drawn as burnt land ("scorched") or water ("water").
    terrain: dict[Coord, str] = field(default_factory=dict)

    def level(self, archetype: str, level_id: str) -> Optional[SoloLevel]:
        campaign = self.campaigns.get(archetype)
        return campaign.level(level_id) if campaign else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "overworld": {
                "tiles": {
                    _key(c): {"q": c[0], "r": c[1], "blocked": b, **({self.terrain[c]: True} if c in self.terrain else {})}
                    for c, b in sorted(self.tiles.items())
                },
            },
            "campaigns": [self.campaigns[a].to_dict() for a in ARCHETYPES if a in self.campaigns],
        }


def load_campaign(registry: dict[str, Card], path: Path = SOLO_LEVELS_PATH) -> Campaign:
    """Read and check solo_levels.yaml (raises LevelError on any mistake)."""
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict) or not isinstance(data.get("levels"), list):
        raise LevelError("solo_levels.yaml: needs a `levels` list")
    tiles, castles, spots, terrain = _parse_overworld_map(data.get("overworld"))

    raw: dict[str, dict[str, Any]] = {}
    for i, entry in enumerate(data["levels"]):
        if not isinstance(entry, dict) or not entry.get("id"):
            raise LevelError(f"level {i + 1}: needs an id")
        lid = str(entry["id"])
        if lid in raw:
            raise LevelError(f"two levels have the id {lid}")
        unknown = set(entry) - LEVEL_FIELDS
        if unknown:
            raise LevelError(f"level {lid}: unknown field(s) {sorted(unknown)}")
        spot = str(entry.get("spot", ""))
        if spot not in spots:
            raise LevelError(f"level {lid}: spot {spot!r} isn't on the overworld")
        if any(str(other.get("spot")) == spot for other in raw.values()):
            raise LevelError(f"level {lid}: another level is on spot {spot!r} (share a level with variants instead)")
        raw[lid] = entry

    plans = data.get("campaigns")
    if not isinstance(plans, dict) or not plans:
        raise LevelError("solo_levels.yaml: needs `campaigns` (vanguard, swarm, fortress)")
    unknown = set(plans) - set(ARCHETYPES)
    if unknown:
        raise LevelError(f"campaigns: unknown archetype(s) {sorted(unknown)}")
    member: dict[str, list[str]] = {lid: [] for lid in raw}
    for arch, plan in plans.items():
        if arch not in castles:
            raise LevelError(f"campaigns: {arch} has no castle on the overworld")
        ids = [str(i) for i in (plan or {}).get("levels") or []]
        if not ids:
            raise LevelError(f"campaigns: {arch} has no levels")
        for lid in ids:
            if lid not in raw:
                raise LevelError(f"campaigns: {arch} lists unknown level {lid!r}")
            if arch in member[lid]:
                raise LevelError(f"campaigns: {arch} lists {lid} twice")
            member[lid].append(arch)
    for lid, archs in member.items():
        if not archs:
            raise LevelError(f"level {lid} is in no campaign")
        variants = raw[lid].get("variants") or {}
        if not isinstance(variants, dict):
            raise LevelError(f"level {lid}: variants maps archetypes to their changes")
        for arch, variant in variants.items():
            if arch not in archs:
                raise LevelError(f"level {lid}: a {arch} variant, but it's not in the {arch} campaign")
            bad = set(variant or {}) - VARIANT_FIELDS
            if bad:
                raise LevelError(f"level {lid}: a variant can't change {sorted(bad)}")

    all_spots = set(spots.values()) | set(castles.values())
    campaigns: dict[str, ArchetypeCampaign] = {}
    for arch in ARCHETYPES:
        plan = plans.get(arch)
        if plan is None:
            continue
        levels = [
            _parse_level(raw[lid], registry, arch, spots[str(raw[lid]["spot"])],
                         [a for a in member[lid] if a != arch])
            for lid in (str(i) for i in plan["levels"])
        ]
        soon_chars = [str(s) for s in plan.get("soon") or []]
        for ch in soon_chars:
            if ch not in spots:
                raise LevelError(f"campaigns: {arch}'s soon spot {ch!r} isn't on the overworld")
        soon = [spots[ch] for ch in soon_chars]
        stops = [castles[arch]] + [lv.spot for lv in levels] + soon
        campaigns[arch] = ArchetypeCampaign(
            archetype=arch,
            title=str(plan.get("title") or arch.title()),
            blurb=" ".join(str(plan.get("blurb") or "").split()),
            castle=castles[arch],
            levels=levels,
            soon=soon,
            segments=_roads(tiles, stops, all_spots),
        )
    return Campaign(tiles=tiles, campaigns=campaigns, terrain=terrain)


_campaign_cache: dict[int, Campaign] = {}


def get_campaign(registry: dict[str, Card]) -> Campaign:
    """The campaigns, loaded once per card registry."""
    key = id(registry)
    if key not in _campaign_cache:
        _campaign_cache.clear()
        _campaign_cache[key] = load_campaign(registry)
    return _campaign_cache[key]


# ── Playing a level ─────────────────────────────────────────────


def create_solo_game(
    level: SoloLevel,
    registry: dict[str, Card],
    player_name: str = "You",
    seed: Optional[int] = None,
) -> Any:
    """A new game of the level, played as its campaign's archetype (in its
    Start of Turn; call execute_start_of_turn next, as for any game)."""
    from .game_state import create_game

    configs: list[dict[str, Any]] = [{
        "id": SOLO_PLAYER_ID, "name": player_name, "archetype": level.archetype,
        "color": PLAYER_COLOR, "is_cpu": False,
    }]
    for i, bot in enumerate(level.bots):
        configs.append({
            "id": f"player_{i + 1}", "name": bot.name, "archetype": bot.archetype,
            "color": BOT_COLORS[i % len(BOT_COLORS)], "is_cpu": True,
            "cpu_difficulty": bot.difficulty,
        })
    grid = level.build_grid()
    game = create_game(
        grid.size, configs, registry, seed=seed,
        vp_target=level.objective.vp or level.objective.rival_vp or 99,
        max_rounds=level.objective.rounds or UNTIMED_ROUND_GUARD,
        card_pack=level.card_pack_id, archetype_market_size=level.market_size,
        grid=grid, pack=level.card_pack(),
    )
    if level.market == "random":
        # One copy of each of the level's cards, drawn at random each round.
        for player in game.players.values():
            ids = level.archetype_card_ids.get(player.archetype.value, [])
            player.archetype_deck = [_copy_card(registry[cid], f"market_{j}") for j, cid in enumerate(ids)]
            game.rng.shuffle(player.archetype_deck)
    game.solo = {
        "level_id": level.id,
        "level_title": level.title,
        "campaign": level.archetype,
        "player_id": SOLO_PLAYER_ID,
        "objective": level.objective.to_dict(with_bots=bool(level.bots)),
        "debt": level.debt,
        "market": level.market,
        "pack": level.pool(),
        "result": None,
        "reason": None,
    }
    return game


@dataclass
class StarterCeiling:
    """The most the starting deck alone (Explore and Gather, upgraded or not)
    can ever hold on a level's map."""

    tiles: int
    vp: int
    vp_hexes: int
    fortified: int     # held tiles already at the fortify objective's defense

    def could_meet(self, obj: Objective) -> Optional[bool]:
        """Whether that could meet the objective; None when the map can't
        tell — a hold-out with no tile count depends on the bots
        (`scripts/solo_levels.py play --starters` checks those)."""
        if obj.type == "vp":
            return self.vp >= obj.vp
        if obj.type in ("territory", "survive"):
            return self.tiles >= obj.tiles if obj.tiles else None
        if obj.type == "vp_hexes":
            return self.vp_hexes >= obj.count
        if obj.type == "fortify":
            return self.fortified >= obj.tiles
        return False  # raid and capture take Claims


def starter_ceiling(level: SoloLevel, registry: dict[str, Card]) -> StarterCeiling:
    """Explore only takes defenseless land nobody holds, next to yours, and
    nothing in the starting deck adds defense or takes a rival's tile — so at
    best you hold your start plus all the open land joined to it (rivals only
    ever shrink that)."""
    from .game_state import tiles_per_vp

    game = create_solo_game(level, registry, seed=0)
    grid = game.grid
    held = {k for k, t in grid.tiles.items() if t.owner == SOLO_PLAYER_ID}
    todo = deque(held)
    while todo:
        tile = grid.tiles[todo.popleft()]
        for n in grid.get_adjacent(tile.q, tile.r):
            key = f"{n.q},{n.r}"
            if key not in held and n.owner is None and not n.is_base and n.defense_power == 0:
                held.add(key)
                todo.append(key)
    tiles = [grid.tiles[k] for k in held]
    towns = [t for t in tiles if t.is_vp]
    need = level.objective.defense or 0
    return StarterCeiling(
        tiles=len(tiles),
        vp=len(tiles) // tiles_per_vp(grid.size) + sum(t.vp_value for t in towns),
        vp_hexes=len(towns),
        fortified=sum(1 for t in tiles if not t.is_base and need and t.base_defense >= need),
    )


def _vp_hexes_held(game: Any, pid: str, connected_only: bool) -> tuple[int, int]:
    """(VP hexes `pid` holds — connected to their base if asked, total)."""
    vp_tiles = [t for t in game.grid.tiles.values() if t.is_vp]
    linked = game.grid.get_connected_tiles(pid) if connected_only else None
    held = sum(
        1 for t in vp_tiles
        if t.owner == pid and (linked is None or (t.q, t.r) in linked)
    )
    return held, len(vp_tiles)


def _round_tally(game: Any) -> dict[str, Any]:
    """What this round's reveal did to and for you: rivals raided, raids on
    your base, tiles taken from rivals, tiles lost (from the round's player
    effects and resolution steps, which last until the next reveal)."""
    me = game.solo["player_id"]
    raided: set[str] = set()
    raids_taken = 0
    for e in game.player_effects:
        if e.get("effect_type") != "base_raid_rubble":
            continue
        if e.get("source_player_id") == me and e.get("target_player_id"):
            raided.add(str(e["target_player_id"]))
        elif e.get("target_player_id") == me:
            raids_taken += 1
    captured = lost = 0
    for step in game.resolution_steps:
        if step.get("is_base_raid") or step.get("outcome") != "claimed":
            continue
        prev, winner = step.get("previous_owner"), step.get("winner_id")
        if winner == me and prev not in (None, me):
            captured += 1
        elif prev == me and winner not in (None, me):
            lost += 1
    return {"raided": raided, "raids_taken": raids_taken, "captured": captured, "tiles_lost": lost}


def _totals(game: Any) -> dict[str, Any]:
    """The game's running totals: those recorded at the end of each round,
    plus this round's once its reveal is done."""
    from .game_state import Phase

    solo = game.solo
    raided = set(solo.get("raided") or [])
    totals = {k: int(solo.get(k) or 0) for k in ("raids_taken", "captured", "tiles_lost")}
    live = game.current_phase in (Phase.REVEAL, Phase.BUY, Phase.END_OF_TURN)
    if live and solo.get("tallied_round") != game.current_round:
        tally = _round_tally(game)
        raided |= tally["raided"]
        for k in totals:
            totals[k] += tally[k]
    return {"raided": raided, **totals}


def _record_round(game: Any) -> None:
    """End of round: add this round's tally to the running totals (once)."""
    solo = game.solo
    if solo.get("tallied_round") == game.current_round:
        return
    tally = _round_tally(game)
    solo["raided"] = sorted(set(solo.get("raided") or []) | tally["raided"])
    for k in ("raids_taken", "captured", "tiles_lost"):
        solo[k] = int(solo.get(k) or 0) + tally[k]
    solo["tallied_round"] = game.current_round


def objective_progress(game: Any, round_over: bool = False) -> dict[str, Any]:
    """Where you stand on the level's objective: {value, target, unit, met,
    failed, detail}. `round_over`: judged at the end of the current round
    (a survive objective counts the round as held)."""
    from .game_state import compute_player_vp

    solo = game.solo
    obj = solo["objective"]
    me = solo["player_id"]
    kind = obj["type"]
    totals = _totals(game)
    held = sum(1 for t in game.grid.tiles.values() if t.owner == me)
    failed = False
    detail: list[str] = []
    if kind == "vp":
        value, target, unit = compute_player_vp(game, me), int(obj["vp"]), "VP"
    elif kind == "territory":
        value, target, unit = held, int(obj["tiles"]), "tiles"
    elif kind == "vp_hexes":
        value, target = _vp_hexes_held(game, me, bool(obj.get("connected")))
        unit = "VP hexes"
    elif kind == "raid":
        rivals = [pid for pid in game.player_order if pid != me]
        value = sum(1 for pid in rivals if pid in totals["raided"])
        target, unit = len(rivals), "bases raided"
    elif kind == "capture":
        value, target, unit = totals["captured"], int(obj["tiles"]), "tiles taken"
    elif kind == "fortify":
        need = int(obj["defense"])
        value = sum(
            1 for t in game.grid.tiles.values()
            if t.owner == me and not t.is_base and t.base_defense + t.permanent_defense_bonus >= need
        )
        target, unit = int(obj["tiles"]), "fortified tiles"
    else:  # survive
        target, unit = int(obj["rounds"]), "rounds held"
        value = min(target, game.current_round if round_over else game.current_round - 1)
        allowed = int(obj.get("raids_allowed") or 0)
        lost_max = obj.get("tiles_lost_max")
        if totals["raids_taken"] > allowed:
            failed = True
        if lost_max is not None and totals["tiles_lost"] > int(lost_max):
            failed = True
        detail.append(
            ("base raided" if totals["raids_taken"] else "base unraided") if allowed == 0
            else f"raided {totals['raids_taken']} of {allowed} allowed"
        )
        if lost_max is not None:
            detail.append(f"{totals['tiles_lost']} of {lost_max} tiles lost")
        if obj.get("tiles"):
            detail.append(f"holding {held} of {obj['tiles']}")
        met = (not failed and round_over and game.current_round >= target
               and held >= int(obj.get("tiles") or 0))
        return {"value": value, "target": target, "unit": unit, "met": met,
                "failed": failed, "detail": " · ".join(detail)}
    return {"value": value, "target": target, "unit": unit, "met": target > 0 and value >= target,
            "failed": False, "detail": None}


def _judge(game: Any) -> Optional[tuple[str, str, list[str]]]:
    """(result, reason, winners) once the level is decided, else None."""
    from .game_state import compute_player_vp, rank_vp_target_winners

    solo = game.solo
    obj = solo["objective"]
    me = solo["player_id"]
    progress = objective_progress(game, round_over=True)
    totals = _totals(game)
    if progress["failed"]:
        if totals["raids_taken"] > int(obj.get("raids_allowed") or 0):
            return "lost", "Your base was raided.", []
        return "lost", f"You lost {totals['tiles_lost']} tiles — more than the {obj['tiles_lost_max']} you could spare.", []
    rival_target = obj.get("bot_vp")
    rivals = [
        pid for pid in game.player_order
        if rival_target and pid != me and not game.players[pid].has_left
        and compute_player_vp(game, pid) >= int(rival_target)
    ]
    if progress["met"] and not game.players[me].has_left:
        # Racing a bot to the same VP target in the same round: the usual
        # tie-breaks (VP, connected VP hexes, tiles). Any other objective
        # met wins outright.
        best = rank_vp_target_winners(game, [me, *rivals]) if rivals and obj["type"] == "vp" else [me]
        if me in best:
            done = "Held out." if obj["type"] == "survive" else f"{obj['goal']} — done in round {game.current_round}."
            return "won", done, best
    if rivals:
        best = rank_vp_target_winners(game, rivals)
        return "lost", f"{game.players[best[0]].name} reached {rival_target} VP first.", best
    if obj["rounds"] is None:
        # No time limit — but a game that never ends helps nobody.
        if game.current_round >= UNTIMED_ROUND_GUARD:
            return "lost", f"{UNTIMED_ROUND_GUARD} rounds on, the war was no nearer won.", []
        return None
    if game.current_round >= int(obj["rounds"]):
        if obj["type"] == "survive":
            held = sum(1 for t in game.grid.tiles.values() if t.owner == me)
            return "lost", f"Round {obj['rounds']} ended with you holding {held} of the {obj['tiles']} tiles you needed.", []
        return (
            "lost",
            f"Round {obj['rounds']} ended with {progress['value']} of {progress['target']} {progress['unit']}.",
            [],
        )
    return None


def won_this_round(game: Any) -> bool:
    """After the reveal: the level is already won this round (judged as the
    end of the round would judge it), so its buy phase can be skipped."""
    if not game.solo or game.solo.get("result") or not game.grid:
        return False
    verdict = _judge(game)
    return verdict is not None and verdict[0] == "won"


def check_solo_objective(game: Any) -> bool:
    """End of round: if the level's objective is decided, end the game
    (GAME_OVER, winners, a game_over log entry) and return True."""
    from .game_state import Phase, compute_player_vp

    if not game.solo or game.solo.get("result"):
        return False
    _record_round(game)
    verdict = _judge(game)
    if verdict is None:
        return False
    result, reason, winners = verdict
    game.solo["result"] = result
    game.solo["reason"] = reason
    game.solo["round"] = game.current_round
    game.winners = list(winners)
    game.winner = winners[0] if winners else None
    game.current_phase = Phase.GAME_OVER
    game._log(
        f"{'Level cleared' if result == 'won' else 'Level failed'}: {reason}",
        event_type="game_over",
        data={
            "reason": "solo_objective",
            "result": result,
            "level_id": game.solo["level_id"],
            "campaign": game.solo.get("campaign"),
            "winner": game.winner,
            "winners": game.winners,
            "final_vp": {pid: compute_player_vp(game, pid) for pid in game.player_order},
            "round": game.current_round,
        },
    )
    return True


def solo_view(game: Any) -> Optional[dict[str, Any]]:
    """GameState.solo as the frontend gets it: plus live objective progress."""
    if not game.solo:
        return None
    view = dict(game.solo)
    if game.grid:
        progress = objective_progress(game)
        totals = _totals(game)
        view["progress"] = progress
        view["raided"] = sorted(totals["raided"])
    return view
