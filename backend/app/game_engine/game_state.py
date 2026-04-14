"""Core game state management and turn loop."""

from __future__ import annotations

import random
import string
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .cards import (
    ARCHETYPE_SLOTS,
    HAND_SIZE,
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
    build_starting_deck,
    make_debt_card,
    make_rubble_card,
    make_spoils_card,
    _copy_card,
)
from .effects import ConditionType, EffectType, TurnModifiers
from .effect_resolver import (
    calculate_effective_power,
    resolve_immediate_effects,
    resolve_on_resolution_effects,
)
from .card_packs import get_pack
from .hex_grid import BASE_DEFENSE, GRID_CONFIG, GridSize, HexGrid, generate_hex_grid


class Phase(str, Enum):
    SETUP = "setup"
    START_OF_TURN = "start_of_turn"
    UPKEEP = "upkeep"
    PLAY = "play"
    REVEAL = "reveal"
    BUY = "buy"
    END_OF_TURN = "end_of_turn"
    GAME_OVER = "game_over"


STARTING_RESOURCES = 0
VP_TARGET = 10  # legacy default; use compute_vp_target() for new games
DEFAULT_MAX_ROUNDS = 20
DEBT_START_ROUND = 5  # Debt cards start being distributed at this round
SPEED_MULTIPLIERS: dict[str, float] = {"fast": 0.66, "normal": 1.0, "slow": 1.33}
REROLL_COST = 1
RETAIN_COST = 2
UPGRADE_CREDIT_COST = 5

_SEED_CHARS = string.ascii_lowercase + string.digits  # a-z0-9
_SEED_LENGTH = 6


def generate_map_seed() -> str:
    """Generate a random 6-character lowercase alphanumeric seed."""
    return "".join(random.choices(_SEED_CHARS, k=_SEED_LENGTH))


def _seed_to_int(seed_str: str) -> int:
    """Convert a 6-char alphanumeric seed to an integer for RNG seeding."""
    return int(seed_str, 36)


def tiles_per_vp(grid_size: GridSize) -> int:
    """Tiles required per 1 VP — constant 3 for all grid sizes."""
    return 3


def compute_vp_target(grid_size: GridSize, player_count: int = 2, speed: str = "normal") -> int:
    """Compute the recommended VP target based on grid size and player count.

    Base targets for 2 players: Small=10, Medium=14, Large=18, Mega=22, Ultra=26.
    Subtract 1 VP per additional player beyond 2. Minimum 4.
    """
    _BASE: dict[GridSize, int] = {
        GridSize.SMALL: 10,
        GridSize.MEDIUM: 14,
        GridSize.LARGE: 18,
        GridSize.MEGA: 22,
        GridSize.ULTRA: 26,
    }
    base = _BASE.get(grid_size, 10)
    return max(4, base - max(0, player_count - 2))





def _draw_archetype_market(
    deck: list[Card], count: int, rng: random.Random,
    player: "Player | None" = None,
) -> list[Card]:
    """Draw up to `count` random purchasable cards from the archetype deck.

    All cards with a buy_cost are eligible regardless of the player's current
    resources — the player may gain resources during the Play phase before
    buying in the Buy phase.

    When *player* is provided, hidden heuristics improve roll quality:
      1. 3-roll exclusion — cards from either of the two previous rolls are
         excluded, so any given card appears at most once in every three
         consecutive rolls (natural rolls and player re-rolls combined).
      2. Affordability guarantee — if the player has >= 2 resources, at least
         one card in the result will be affordable.
      3. Type diversity correction — if the previous roll was mono-type, at
         most one card of that type appears in this roll.
      4. Cost spread — if the result is mono-cost (all same buy_cost),
         resample once.
    """
    eligible = [c for c in deck if c.buy_cost is not None]
    if len(eligible) <= count:
        result = list(eligible)
        rng.shuffle(result)
        if player is not None:
            player._prev_market_ids_prev = player._prev_market_ids
            player._prev_market_ids = [c.id for c in result]
            player._prev_market_types = [c.card_type.value for c in result]
        return result

    # --- Step 1: apply exclusion filters ---
    restricted = list(eligible)

    if player is not None:
        # Heuristic 1: exclude cards seen in either of the last two rolls so
        # any card appears at most once per 3-roll window.
        prev_ids = set(player._prev_market_ids) | set(player._prev_market_ids_prev)
        if prev_ids:
            filtered = [c for c in restricted if c.id not in prev_ids]
            if len(filtered) >= count:
                restricted = filtered

        # Heuristic 3: type diversity correction after mono-type roll
        prev_types = player._prev_market_types
        if len(prev_types) == count and len(set(prev_types)) == 1:
            oversaturated = prev_types[0]
            filtered = [c for c in restricted if c.card_type.value != oversaturated]
            if len(filtered) >= count:
                restricted = filtered
            elif len(filtered) >= count - 1:
                # Allow at most 1 of the oversaturated type
                others = filtered
                same = [c for c in restricted if c.card_type.value == oversaturated]
                restricted = others + same[:1]
                if len(restricted) < count:
                    restricted = list(eligible)  # fallback

    # --- Step 2: select with affordability guarantee ---
    result = _select_with_affordability(restricted, count, rng, player)

    # --- Step 3: cost spread check (bounded single retry) ---
    if len(result) == count and len(result) >= 2:
        costs = {c.buy_cost for c in result}
        pool_costs = {c.buy_cost for c in restricted}
        if len(costs) == 1 and len(pool_costs) >= 2:
            retry = _select_with_affordability(restricted, count, rng, player)
            retry_costs = {c.buy_cost for c in retry}
            if len(retry_costs) > 1:
                result = retry

    # --- Step 4: record state for next roll ---
    if player is not None:
        player._prev_market_ids_prev = player._prev_market_ids
        player._prev_market_ids = [c.id for c in result]
        player._prev_market_types = [c.card_type.value for c in result]

    return result


def _select_with_affordability(
    pool: list[Card], count: int, rng: random.Random,
    player: "Player | None",
) -> list[Card]:
    """Sample *count* cards from *pool*, guaranteeing at least one affordable
    card when the player has >= 2 resources and an affordable option exists."""
    if len(pool) <= count:
        result = list(pool)
        rng.shuffle(result)
        return result

    if player is not None and player.resources >= 2:
        affordable = [c for c in pool if c.buy_cost is not None and c.buy_cost <= player.resources]
        if affordable:
            pick = rng.choice(affordable)
            remainder = [c for c in pool if c.id != pick.id]
            rest = rng.sample(remainder, count - 1)
            result = [pick] + rest
            rng.shuffle(result)
            return result

    return rng.sample(pool, count)


@dataclass
class PlannedAction:
    """A card placed face-down during Play phase."""
    card: Card
    target_q: Optional[int] = None
    target_r: Optional[int] = None
    target_player_id: Optional[str] = None  # for forced discards
    extra_targets: list[tuple[int, int]] = field(default_factory=list)  # Surge multi-targets
    # Effective power computed once at play time — accounts for dynamic modifiers
    # (hand size, tile count, adjacency, etc.) frozen at the moment the card was
    # played.  Used for all display and for claim resolution.  None for non-claim
    # cards or cards without dynamic modifiers (they just use base card power).
    effective_power: Optional[int] = None
    # Dynamic resource gain snapshotted at play time (e.g. War Tithe).
    # None when the card has no dynamic resource effects.
    effective_resource_gain: Optional[int] = None
    # Dynamic draw count snapshotted at play time (e.g. Financier: draw per Debt).
    # None when the card has no dynamic draw effects.
    effective_draw_cards: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "card": self.card.to_dict(),
            "target_q": self.target_q,
            "target_r": self.target_r,
            "target_player_id": self.target_player_id,
        }
        if self.extra_targets:
            d["extra_targets"] = [[q, r] for q, r in self.extra_targets]
        if self.effective_power is not None:
            d["effective_power"] = self.effective_power
        if self.effective_resource_gain is not None:
            d["effective_resource_gain"] = self.effective_resource_gain
        if self.effective_draw_cards is not None:
            d["effective_draw_cards"] = self.effective_draw_cards
        return d


@dataclass
class PendingSearch:
    """Deferred tutor/search state.

    Set by SEARCH_ZONE effects to pause resolution until the player picks cards
    from a pile and chooses destinations for them. Resolved via
    submit_pending_search(). Mirrors the pending_discard deferred-choice pattern.
    """
    source: str                                # "discard" | "draw" | "trash"
    count: int                                 # max cards to pick (already clamped to pile size)
    min_count: int                             # minimum to pick (can be 0 for optional)
    allowed_targets: list[str] = field(default_factory=list)  # e.g. ["hand", "top_of_draw"]
    card_filter: Optional[dict[str, Any]] = None
    snapshot_card_ids: list[str] = field(default_factory=list)  # stable order for the modal
    # True when the snapshot covers the entire source pile (e.g. Foresight's
    # peek_all). Used by the frontend to decide whether revealing the modal
    # leaks new information — peeking the WHOLE draw pile gives the player
    # only the set, not the order, which they could already infer from
    # public game state, so cancellation is allowed. A partial peek leaks
    # specific upcoming-card knowledge and must commit.
    peek_all: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "count": self.count,
            "min_count": self.min_count,
            "allowed_targets": list(self.allowed_targets),
            "card_filter": self.card_filter,
            "snapshot_card_ids": list(self.snapshot_card_ids),
            "peek_all": self.peek_all,
        }


@dataclass
class Player:
    id: str
    name: str
    archetype: Archetype
    color: str = "#666666"  # CSS hex color, assigned from lobby
    deck: Deck = field(default_factory=Deck)
    hand: list[Card] = field(default_factory=list)
    resources: int = STARTING_RESOURCES
    vp: int = 0
    actions_used: int = 0
    actions_available: int = 0
    planned_actions: list[PlannedAction] = field(default_factory=list)
    archetype_market: list[Card] = field(default_factory=list)
    archetype_deck: list[Card] = field(default_factory=list)  # remaining buyable cards
    upgrade_credits: int = 0
    forced_discard_next_turn: int = 0
    has_submitted_play: bool = False
    has_acknowledged_resolve: bool = False
    has_ended_turn: bool = False
    turn_modifiers: TurnModifiers = field(default_factory=TurnModifiers)
    trash: list[Card] = field(default_factory=list)
    is_cpu: bool = False
    cpu_noise: float = 0.10  # default Medium difficulty
    has_left: bool = False  # player disconnected/left mid-game
    left_vp: int = 0  # frozen VP at time of leaving (for leaderboard)
    claims_won_last_round: int = 0  # tiles successfully claimed last round (for War Tithe)
    tiles_lost_last_round: int = 0  # tiles captured from this player last round (for Robin Hood)
    pending_discard: int = 0  # deferred discard count (e.g. Regroup: draw first, then discard)
    pending_search: Optional[PendingSearch] = None  # deferred tutor/search (SEARCH_ZONE effects)
    # Smart roll state — hidden heuristics for archetype market draws.
    # _prev_market_ids is the most recent roll; _prev_market_ids_prev is the
    # roll before that. Together they enforce the "no repeats within any
    # 3-roll window" rule across natural rolls and re-rolls.
    _prev_market_ids: list[str] = field(default_factory=list)
    _prev_market_ids_prev: list[str] = field(default_factory=list)
    _prev_market_types: list[str] = field(default_factory=list)

    @property
    def hand_size(self) -> int:
        return HAND_SIZE[self.archetype]

    @property
    def action_slots(self) -> int:
        return ARCHETYPE_SLOTS[self.archetype]

    @property
    def rubble_count(self) -> int:
        """Count Rubble cards across deck, hand, and discard."""
        return sum(
            1 for c in self.deck.cards + self.hand + self.deck.discard
            if c.name == "Rubble"
        )

    def to_dict(self, hide_hand: bool = False, game: Any = None) -> dict[str, Any]:
        # VP is derived — needs game context; falls back to stored vp if no game
        from . import game_state as _gs
        vp = _gs.compute_player_vp(game, self.id) if game else self.vp

        def _card_dict(card: Card) -> dict[str, Any]:
            """Serialize a card, enriching with current_vp when game context exists."""
            d = card.to_dict()
            if game and (card.passive_vp or card.vp_formula):
                if card.vp_formula:
                    d["current_vp"] = _gs._compute_formula_vp(card, self, game)
                else:
                    d["current_vp"] = card.passive_vp
            return d

        return {
            "id": self.id,
            "name": self.name,
            "archetype": self.archetype.value,
            "color": self.color,
            "hand": [] if hide_hand else [_card_dict(c) for c in self.hand],
            "hand_count": len(self.hand),
            "resources": self.resources,
            "vp": vp,
            "actions_used": self.actions_used,
            "actions_available": self.actions_available,
            "archetype_market": [c.to_dict() for c in self.archetype_market],
            "upgrade_credits": self.upgrade_credits,

            "deck_size": len(self.deck.cards),
            "discard_count": len(self.deck.discard),
            "discard": [_card_dict(c) for c in self.deck.discard],
            "deck_cards": [_card_dict(c) for c in self.deck.cards],
            "planned_action_count": len(self.planned_actions),
            "planned_actions": [] if hide_hand else [a.to_dict() for a in self.planned_actions],
            "has_submitted_play": self.has_submitted_play,
            "has_acknowledged_resolve": self.has_acknowledged_resolve,
            "has_ended_turn": self.has_ended_turn,
            "trash": [c.to_dict() for c in self.trash],
            "claims_won_last_round": self.claims_won_last_round,
            "tiles_lost_last_round": self.tiles_lost_last_round,
            "tile_count": len(game.grid.get_player_tiles(self.id)) if game and game.grid else 0,
            "rubble_count": self.rubble_count,
            "is_cpu": self.is_cpu,
            "cpu_difficulty": (
                "easy" if self.cpu_noise >= 0.25 else
                "medium" if self.cpu_noise >= 0.10 else
                "hard"
            ) if self.is_cpu else None,
            "has_left": self.has_left,
            "free_rerolls": self.turn_modifiers.free_rerolls,
            "buy_locked": self.turn_modifiers.buy_locked,
            "pending_discard": self.pending_discard,
            # pending_search reveals private info (deck contents for tutor effects)
            # so it's only serialized when the recipient is this player
            "pending_search": self.pending_search.to_dict() if self.pending_search and not hide_hand else None,
        }


@dataclass
class SharedMarket:
    """Shared market with fixed copy counts (the universal pool available to all players)."""
    stacks: dict[str, list[Card]] = field(default_factory=dict)
    # Template cards for each stack (so we can still serialize sold-out stacks)
    card_templates: dict[str, Card] = field(default_factory=dict)
    # Selling-out stacks: base_card_id -> set of player_ids who already bought.
    # When the last physical copy is purchased, the stack enters selling-out mode
    # and remains available to other players for the rest of this buy phase.
    selling_out: dict[str, set[str]] = field(default_factory=dict)

    def get_available(self) -> list[dict[str, Any]]:
        result = []
        seen_ids: set[str] = set()
        for card_id, copies in self.stacks.items():
            template = copies[0] if copies else self.card_templates.get(card_id)
            if template:
                card_dict = template.to_dict()
                card_dict["id"] = card_id  # Use base card ID for stable matching
                entry: dict[str, Any] = {
                    "card": card_dict,
                    "remaining": len(copies),
                }
                if card_id in self.selling_out:
                    entry["selling_out"] = True
                    entry["selling_out_bought_by"] = list(self.selling_out[card_id])
                result.append(entry)
                seen_ids.add(card_id)
        # Include selling-out stacks whose physical copies are gone
        for card_id, bought_by in self.selling_out.items():
            if card_id not in seen_ids:
                template = self.card_templates.get(card_id)
                if template:
                    card_dict = template.to_dict()
                    card_dict["id"] = card_id
                    result.append({
                        "card": card_dict,
                        "remaining": 0,
                        "selling_out": True,
                        "selling_out_bought_by": list(bought_by),
                    })
        return result

    def purchase(self, card_id: str, player_id: str) -> Optional[tuple[Card, str]]:
        """Purchase a card, returning (card, base_id) or None.

        When the last physical copy is bought, the stack enters selling-out
        mode. Subsequent buyers during the same buy phase get a clone from
        the template.
        """
        # Resolve base_id from the provided card_id
        resolved_base: Optional[str] = None
        for base_id in self.stacks:
            if base_id == card_id or card_id.startswith(base_id):
                resolved_base = base_id
                break
        if resolved_base is None:
            # Also check selling_out keys
            for base_id in self.selling_out:
                if base_id == card_id or card_id.startswith(base_id):
                    resolved_base = base_id
                    break
        if resolved_base is None:
            return None

        # Already in selling-out mode?
        if resolved_base in self.selling_out:
            if player_id in self.selling_out[resolved_base]:
                return None  # This player already bought during selling-out
            template = self.card_templates.get(resolved_base)
            if not template:
                return None
            # Clone from template for this buyer
            import copy as _copy
            clone = _copy.deepcopy(template)
            clone.id = f"{resolved_base}_sellingout_{player_id}"
            self.selling_out[resolved_base].add(player_id)
            return clone, resolved_base

        # Normal purchase from physical copies
        copies = self.stacks.get(resolved_base, [])
        if not copies:
            return None
        card = copies.pop(0)
        # If that was the last copy, enter selling-out mode
        if not copies:
            self.selling_out[resolved_base] = {player_id}
        return card, resolved_base

    def finalize_selling_out(self) -> None:
        """Called at end of buy phase. Selling-out stacks become truly sold out."""
        self.selling_out.clear()


@dataclass
class LogEntry:
    """A single game log entry with visibility rules."""
    message: str
    round: int
    phase: str
    # Which players can see this entry. Empty list = visible to all.
    visible_to: list[str] = field(default_factory=list)
    actor: Optional[str] = None  # player who caused this action

    def to_dict(self) -> dict[str, Any]:
        return {
            "message": self.message,
            "round": self.round,
            "phase": self.phase,
            "actor": self.actor,
        }


@dataclass
class GameState:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    grid: Optional[HexGrid] = None
    players: dict[str, Player] = field(default_factory=dict)
    player_order: list[str] = field(default_factory=list)
    current_phase: Phase = Phase.SETUP
    current_round: int = 0
    first_player_index: int = 0
    shared_market: SharedMarket = field(default_factory=SharedMarket)
    winner: Optional[str] = None
    rng: random.Random = field(default_factory=random.Random)
    card_registry: dict[str, Card] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)
    game_log: list[LogEntry] = field(default_factory=list)
    test_mode: bool = False
    vp_target: int = VP_TARGET
    granted_actions: Optional[int] = None  # None = use archetype default
    host_id: Optional[str] = None
    lobby_code: Optional[str] = None
    # Tracks shared market purchases: {card_id, card_name, player_id, player_name, round}
    shared_purchase_log: list[dict[str, Any]] = field(default_factory=list)
    # Concurrent buy phase: tracks which players have signaled "done buying"
    players_done_buying: set[str] = field(default_factory=set)
    # Cards purchased by each player this round: {player_id: [{card_id, card_name, source, cost}]}
    buy_phase_purchases: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    card_pack: str = "everything"
    map_seed: str = ""
    # Global claim ban (Snowy Holiday): rounds remaining where no player can play Claim cards
    claim_ban_rounds: int = 0
    max_rounds: int = DEFAULT_MAX_ROUNDS
    archetype_market_size: int = 5
    winners: list[str] = field(default_factory=list)  # all winners (for tied victories)

    def _log(self, msg: str, visible_to: Optional[list[str]] = None,
             actor: Optional[str] = None) -> None:
        self.log.append(msg)
        self.game_log.append(LogEntry(
            message=msg,
            round=self.current_round,
            phase=self.current_phase.value,
            visible_to=visible_to or [],
            actor=actor,
        ))

    def get_log_for_player(self, player_id: str) -> list[dict[str, Any]]:
        """Return log entries visible to a specific player."""
        return [
            entry.to_dict()
            for entry in self.game_log
            if not entry.visible_to or player_id in entry.visible_to
        ]

    def get_full_log(self) -> list[dict[str, Any]]:
        """Return all log entries."""
        return [entry.to_dict() for entry in self.game_log]

    # Structured resolution data for frontend animations (populated by execute_reveal)
    resolution_steps: list[dict[str, Any]] = field(default_factory=list)
    # Player-targeting effects resolved during reveal (e.g. Sabotage forced discards)
    player_effects: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self, for_player_id: Optional[str] = None,
                visible_player_ids: Optional[set[str]] = None) -> dict[str, Any]:
        players_dict: dict[str, Any] = {}
        game_over = self.current_phase == Phase.GAME_OVER
        for pid, p in self.players.items():
            if game_over:
                hide = False  # all hands visible at game over
            elif visible_player_ids is not None:
                hide = pid not in visible_player_ids
            elif for_player_id is not None:
                hide = pid != for_player_id
            else:
                hide = False
            pdata = p.to_dict(hide_hand=hide, game=self)
            # Add effective buy costs for all market cards visible to this player
            # Includes both dynamic buy cost (Elite Vanguard) and turn-based cost reductions (Supply Line)
            effective_costs: dict[str, int] = {}
            has_reductions = len(p.turn_modifiers.cost_reductions) > 0
            for card in p.archetype_market:
                dynamic = calculate_dynamic_buy_cost(self, p, card)
                effective_costs[card.id] = _preview_cost_reductions(p, card, base_cost_override=dynamic) if has_reductions else dynamic
            for base_id, stack in self.shared_market.stacks.items():
                if stack:
                    dynamic = calculate_dynamic_buy_cost(self, p, stack[0])
                    effective_costs[base_id] = _preview_cost_reductions(p, stack[0], base_cost_override=dynamic) if has_reductions else dynamic
            pdata["effective_buy_costs"] = effective_costs
            players_dict[pid] = pdata

        # Compute immune tiles from all players' turn modifiers
        grid_dict = self.grid.to_dict() if self.grid else None
        if grid_dict:
            for pid in self.player_order:
                for tile_key in self.players[pid].turn_modifiers.immune_tiles:
                    if tile_key in grid_dict["tiles"]:
                        grid_dict["tiles"][tile_key]["immune"] = True

        result: dict[str, Any] = {
            "id": self.id,
            "grid": grid_dict,
            "players": players_dict,
            "player_order": self.player_order,
            "current_phase": self.current_phase.value,
            "current_round": self.current_round,
            "first_player_index": self.first_player_index,
            "shared_market": self.shared_market.get_available(),
            "winner": self.winner,
            "vp_target": self.vp_target,
            "granted_actions": self.granted_actions,
            "log": self.log[-20:],  # last 20 for backward compat
            "test_mode": self.test_mode,
            "players_done_buying": list(self.players_done_buying),
            "buy_phase_purchases": self.buy_phase_purchases,
            "card_pack": self.card_pack,
            "map_seed": self.map_seed,
            "claim_ban_rounds": self.claim_ban_rounds,
            "max_rounds": self.max_rounds,
            "winners": self.winners,
        }
        if self.resolution_steps:
            result["resolution_steps"] = self.resolution_steps
        if self.player_effects:
            result["player_effects"] = self.player_effects
        # Neutral market purchases from last round (for purchase history indicators)
        result["shared_purchases_last_round"] = [
            entry for entry in self.shared_purchase_log
            if entry["round"] == self.current_round - 1
        ]
        # During REVEAL phase, expose all players' planned actions for review.
        # effective_power is already snapshotted on each PlannedAction at play time.
        if self.current_phase == Phase.REVEAL:
            result["revealed_actions"] = {
                pid: [a.to_dict() for a in p.planned_actions]
                for pid, p in self.players.items()
            }
        return result


def compute_player_vp(game: GameState, player_id: str) -> int:
    """Derive VP from current game state — tiles, connectivity, cards, and bonus VP.

    VP = (total_owned_tiles // tiles_per_vp(game.grid.size))
       + sum(vp_value for connected VP hexes)
       + sum(passive_vp for all cards in deck/hand/discard)
       + sum(dynamic VP from cards with vp_formula)
       + player.vp (bonus VP from card effects, etc.)
    """
    player = game.players[player_id]
    if player.has_left:
        return player.left_vp
    if not game.grid:
        return max(0, player.vp)

    player_tiles = [
        (t.q, t.r) for t in game.grid.tiles.values() if t.owner == player_id
    ]
    tile_vp = len(player_tiles) // tiles_per_vp(game.grid.size)

    # Connected VP hexes add their vp_value as a bonus
    connected = game.grid.get_connected_tiles(player_id)
    vp_hex_bonus = sum(
        game.grid.tiles[f"{q},{r}"].vp_value
        for q, r in player_tiles
        if game.grid.tiles[f"{q},{r}"].is_vp and (q, r) in connected
    )

    # Card VP: Land Grant (+1), Battle Glory (accumulated), etc.
    all_cards = player.deck.cards + player.hand + player.deck.discard
    card_vp = sum(c.passive_vp for c in all_cards)

    # Dynamic VP from cards with vp_formula
    formula_vp = 0
    for card in all_cards:
        if not card.vp_formula:
            continue
        formula_vp += _compute_formula_vp(card, player, game)

    # Bonus VP from card effects, etc.
    bonus_vp = player.vp

    return max(0, tile_vp + vp_hex_bonus + card_vp + formula_vp + bonus_vp)


def _compute_formula_vp(card: "Card", player: "Player", game: "GameState") -> int:
    """Compute dynamic VP for a card with a vp_formula."""
    formula = card.vp_formula
    is_upgraded = card.is_upgraded

    if formula == "trash_div_5":
        # Scorched Earth: 1 VP per 5 trashed cards (4 upgraded)
        divisor = 4 if is_upgraded else 5
        return len(player.trash) // divisor

    elif formula == "fortified_tiles_3":
        # Fortified Position: 1 VP per non-base tile with permanent defense >= 3 (>= 2 upgraded)
        if not game.grid:
            return 0
        threshold = 2 if is_upgraded else 3
        return sum(
            1 for t in game.grid.tiles.values()
            if t.owner == player.id and not t.is_base
            and t.permanent_defense_bonus >= threshold
        )

    elif formula == "deck_div_10":
        # Arsenal: 1 VP per 10 cards in deck (8 upgraded)
        all_cards = player.deck.cards + player.hand + player.deck.discard
        divisor = 8 if is_upgraded else 10
        return len(all_cards) // divisor

    elif formula == "disconnected_groups_3":
        # Colony: 1 VP per disconnected group of 3+ tiles (2+ upgraded)
        if not game.grid:
            return 0
        min_size = 2 if is_upgraded else 3
        connected = game.grid.get_connected_tiles(player.id)
        all_owned = {
            (t.q, t.r) for t in game.grid.tiles.values()
            if t.owner == player.id
        }
        disconnected = all_owned - connected
        if not disconnected:
            return 0
        # BFS to find groups among disconnected tiles
        remaining = set(disconnected)
        groups = 0
        while remaining:
            start = remaining.pop()
            group = {start}
            queue = [start]
            while queue:
                cq, cr = queue.pop()
                tile = game.grid.get_tile(cq, cr)
                if not tile:
                    continue
                for nq, nr in tile.neighbors():
                    if (nq, nr) in remaining:
                        remaining.discard((nq, nr))
                        group.add((nq, nr))
                        queue.append((nq, nr))
            if len(group) >= min_size:
                groups += 1
        return groups

    elif formula == "uncaptured_tiles_4":
        # Warden: 1 VP per 4 tiles (3 upgraded) that have never changed hands
        if not game.grid:
            return 0
        divisor = 3 if is_upgraded else 4
        count = sum(
            1 for t in game.grid.tiles.values()
            if t.owner == player.id and not t.is_base and t.capture_count == 0
        )
        return count // divisor

    return 0


def create_game(
    grid_size: GridSize,
    player_configs: list[dict[str, Any]],
    card_registry: dict[str, Card],
    seed: Optional[int] = None,
    test_mode: bool = False,
    vp_target: Optional[int] = None,
    speed: str = "normal",
    granted_actions: Optional[int] = None,
    card_pack: str = "everything",
    map_seed: Optional[str] = None,
    max_rounds: Optional[int] = None,
    archetype_market_size: Optional[int] = None,
) -> GameState:
    """Create a new game with the given configuration."""
    # Map seed: user-visible 6-char seed that controls grid layout only
    if not map_seed:
        if seed is not None:
            # Derive a deterministic map seed from the game seed (for simulations)
            _tmp = random.Random(seed)
            map_seed = "".join(_tmp.choices(_SEED_CHARS, k=_SEED_LENGTH))
        else:
            map_seed = generate_map_seed()
    grid_rng = random.Random(_seed_to_int(map_seed))

    # Game RNG: random each session, controls shuffling/draws/first-player/etc.
    rng = random.Random(seed)
    num_players = len(player_configs)

    game = GameState(rng=rng, card_registry=card_registry, test_mode=test_mode, card_pack=card_pack, map_seed=map_seed)
    pack = get_pack(card_pack, card_registry)
    game.grid = generate_hex_grid(grid_size, num_players, grid_rng)

    # Set VP target: explicit override > dynamic computation
    if vp_target is not None:
        game.vp_target = vp_target
    else:
        game.vp_target = compute_vp_target(grid_size, num_players, speed)

    # Set granted actions override (None = use archetype default)
    game.granted_actions = granted_actions

    # Set round limit
    if max_rounds is not None:
        game.max_rounds = max_rounds

    # Set archetype market size (default 3)
    if archetype_market_size is not None:
        game.archetype_market_size = archetype_market_size

    # Create players and assign starting positions
    for i, config in enumerate(player_configs):
        player_id = config.get("id", str(uuid.uuid4()))
        archetype = Archetype(config["archetype"])

        player = Player(
            id=player_id,
            name=config.get("name", f"Player {i + 1}"),
            archetype=archetype,
            color=config.get("color", "#666666"),
            is_cpu=bool(config.get("is_cpu", False)),
            cpu_noise=float(config.get("cpu_noise", 0.10)),
        )

        # Build starting deck
        player.deck = build_starting_deck(archetype, card_registry)
        player.deck.shuffle(rng)

        # Build archetype deck (purchasable cards, excluding starters)
        archetype_cards = [
            c for c in card_registry.values()
            if c.archetype == archetype and not c.starter and c.buy_cost is not None
        ]
        # Filter by pack if it restricts this archetype's cards
        if pack.archetype_card_ids is not None:
            arch_ids = pack.archetype_card_ids.get(archetype.value)
            if arch_ids is not None:
                arch_id_set = set(arch_ids)
                archetype_cards = [c for c in archetype_cards if c.id in arch_id_set]
        player.archetype_deck = [_copy_card(c, f"market_{j}") for j, c in enumerate(archetype_cards)]
        rng.shuffle(player.archetype_deck)

        game.players[player_id] = player
        game.player_order.append(player_id)

        # Assign starting tiles — first tile in each cluster is the base
        if i < len(game.grid.starting_positions):
            cluster = game.grid.starting_positions[i]
            for j, (q, r) in enumerate(cluster):
                tile = game.grid.get_tile(q, r)
                if tile:
                    tile.owner = player_id
                    tile.held_since_turn = 0
                    # First tile in the cluster is the base tile
                    if j == 0:
                        tile.is_base = True
                        tile.base_owner = player_id
                        base_def = BASE_DEFENSE.get(archetype.value, 3)
                        tile.base_defense = base_def
                        tile.defense_power = base_def

    # Random first player
    game.first_player_index = rng.randint(0, num_players - 1)

    # Set up shared market (N*2 copies per card, where N = player count)
    _setup_shared_market(game, card_registry, num_players, pack)

    game._log(f"Game created with {num_players} players on {grid_size.value} grid")
    game.current_phase = Phase.START_OF_TURN
    game.current_round = 1

    return game


def _setup_shared_market(
    game: GameState, card_registry: dict[str, Card], num_players: int,
    pack: Any = None,
) -> None:
    """Set up the shared market stacks.

    Each neutral card gets N*2 copies where N is the number of players.
    Filtered by the active card pack's shared_card_ids if specified.
    """
    neutral_cards = [
        c for c in card_registry.values()
        if c.archetype == Archetype.SHARED and not c.starter and c.buy_cost is not None
    ]

    # Filter by pack if it restricts neutral cards
    if pack is not None and pack.shared_card_ids is not None:
        allowed = set(pack.shared_card_ids)
        neutral_cards = [c for c in neutral_cards if c.id in allowed]

    copies_count = num_players * 2
    for card in neutral_cards:
        copies = [_copy_card(card, f"neutral_{i}") for i in range(copies_count)]
        game.shared_market.stacks[card.id] = copies
        game.shared_market.card_templates[card.id] = card


# ── Phase execution ─────────────────────────────────────────────


def execute_start_of_turn(game: GameState) -> GameState:
    """Phase 1: Start of Turn."""
    game.current_phase = Phase.START_OF_TURN
    game._log(f"=== Round {game.current_round}, Start of Turn ===")

    # Log global claim ban (Snowy Holiday) — decrement happens at end of turn
    if game.claim_ban_rounds > 0:
        game._log("⚠️ Claim cards are banned this round (Snowy Holiday)")

    for pid in game.player_order:
        player = game.players[pid]

        if player.has_left:
            # Left players are frozen — skip everything
            player.has_submitted_play = True
            player.has_acknowledged_resolve = True
            player.has_ended_turn = True
            continue

        # Draw hand (minus forced discards, plus extra draws from effects)
        extra_draws = player.turn_modifiers.extra_draws_next_turn
        draw_count = max(0, player.hand_size - player.forced_discard_next_turn + extra_draws)
        if player.forced_discard_next_turn > 0:
            game._log(f"{player.name} draws {draw_count} (reduced by {player.forced_discard_next_turn} forced discard)")
        if extra_draws > 0:
            game._log(f"{player.name} draws {extra_draws} extra card(s) from effects")
        player.forced_discard_next_turn = 0
        player.turn_modifiers.extra_draws_next_turn = 0
        player.hand = player.deck.draw(draw_count, game.rng)

        # Grant bonus resources from next-turn effects (Supply Depot)
        extra_resources = player.turn_modifiers.extra_resources_next_turn
        if extra_resources > 0:
            player.resources += extra_resources
            game._log(f"{player.name} gains {extra_resources} extra resource(s) from effects",
                      visible_to=[pid], actor=pid)
            player.turn_modifiers.extra_resources_next_turn = 0

        # Plague: trash random card(s) from newly drawn hand
        plague_count = player.turn_modifiers.plague_trash_next_turn
        if plague_count > 0:
            player.turn_modifiers.plague_trash_next_turn = 0
            trashed_names = []
            for _ in range(plague_count):
                if not player.hand:
                    break
                idx = game.rng.randrange(len(player.hand))
                trashed = player.hand.pop(idx)
                player.trash.append(trashed)
                trashed_names.append(trashed.name)
            if trashed_names:
                game._log(f"{player.name} trashes {', '.join(trashed_names)} from Plague",
                          actor=pid)
            else:
                game._log(f"{player.name} has no cards to trash from Plague",
                          visible_to=[pid], actor=pid)

        # Reset turn modifiers (decrement multi-round effects)
        player.turn_modifiers.reset_for_new_turn()

    # Reset all tile defense_power to base + permanent (round-based bonuses expire)
    if game.grid:
        for tile in game.grid.tiles.values():
            if not tile.is_blocked:
                tile.defense_power = tile.base_defense + tile.permanent_defense_bonus

    for pid in game.player_order:
        player = game.players[pid]

        # Reset action tracking
        player.actions_used = 0
        extra_actions = player.turn_modifiers.extra_actions_next_turn
        base_actions = game.granted_actions if game.granted_actions is not None else player.action_slots
        player.actions_available = base_actions + extra_actions
        if extra_actions > 0:
            game._log(f"{player.name} gains {extra_actions} extra action(s) from last turn",
                      visible_to=[pid], actor=pid)
            player.turn_modifiers.extra_actions_next_turn = 0
        player.planned_actions = []
        player.has_submitted_play = False
        player.has_acknowledged_resolve = False
        player.has_ended_turn = False

        # Reveal archetype market (N random cards from archetype deck)
        player.archetype_market = []
        if player.archetype_deck:
            player.archetype_market = _draw_archetype_market(
                player.archetype_deck, game.archetype_market_size, game.rng, player,
            )

    # Upkeep phase: distribute Debt cards (round 5+), then pause for frontend
    _apply_upkeep(game)
    game.current_phase = Phase.UPKEEP
    return game


def _apply_upkeep(game: GameState) -> None:
    """Internal: beginning-of-round phase.

    Distributes Debt cards to the VP leader starting at round 5.
    Called during execute_start_of_turn before transitioning to UPKEEP phase.
    """
    game._log("=== Upkeep ===")

    # Debt card distribution (round 5+)
    if game.current_round >= DEBT_START_ROUND:
        active_pids = [pid for pid in game.player_order if not game.players[pid].has_left]
        if active_pids:
            vp_scores = {pid: compute_player_vp(game, pid) for pid in active_pids}
            max_vp = max(vp_scores.values())
            leaders = [pid for pid, vp in vp_scores.items() if vp == max_vp]

            # Tiebreak: closest to first_player_index in turn order (clockwise)
            if len(leaders) > 1:
                n = len(game.player_order)
                leaders.sort(key=lambda pid: (game.player_order.index(pid) - game.first_player_index) % n)

            target_pid = leaders[0]
            debt = make_debt_card()
            game.players[target_pid].deck.add_to_discard([debt])
            game._log(f"{game.players[target_pid].name} receives a Debt card (VP leader with {max_vp} VP)")


def execute_upkeep(game: GameState) -> GameState:
    """Advance from UPKEEP phase to PLAN phase.

    Upkeep has already been computed and applied during execute_start_of_turn.
    This just transitions the phase so the frontend can move on.
    """
    game.current_phase = Phase.PLAY
    game._log("Play phase begins — place cards face-down on tiles")
    return game


def _tile_bridges_territory(grid: 'HexGrid', player_id: str, q: int, r: int) -> bool:
    """Return True if claiming tile (q, r) would connect two or more disconnected
    groups of the player's territory.

    Algorithm: find how many distinct groups of the player's owned tiles are
    adjacent to (q, r). If >= 2, the tile bridges them.
    """
    from collections import deque

    tile = grid.get_tile(q, r)
    if not tile:
        return False

    # Collect player-owned neighbors of the target tile
    owned_neighbors: list[tuple[int, int]] = []
    for nq, nr in tile.neighbors():
        n = grid.get_tile(nq, nr)
        if n and n.owner == player_id:
            owned_neighbors.append((nq, nr))

    if len(owned_neighbors) < 2:
        return False

    # BFS among ALL player-owned tiles (excluding the target, which isn't owned yet)
    # to see how many distinct groups touch the target tile.
    all_owned = {
        (t.q, t.r) for t in grid.tiles.values()
        if t.owner == player_id
    }

    visited: set[tuple[int, int]] = set()
    groups_touching_target = 0

    for start in owned_neighbors:
        if start in visited:
            continue
        # BFS from this neighbor through owned tiles
        group: set[tuple[int, int]] = set()
        queue = deque([start])
        group.add(start)
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

    return groups_touching_target >= 2


def play_card(game: GameState, player_id: str, card_index: int,
              target_q: Optional[int] = None, target_r: Optional[int] = None,
              target_player_id: Optional[str] = None,
              discard_card_indices: Optional[list[int]] = None,
              trash_card_indices: Optional[list[int]] = None,
              extra_targets: Optional[list[tuple[int, int]]] = None,
              search_selections: Optional[list[dict[str, Any]]] = None,
              ) -> tuple[bool, str]:
    """Play a card from hand during Play phase. Returns (success, message).

    `search_selections` is an optional list of {"card_id", "target"} entries
    for SEARCH_ZONE (tutor) effects. When provided, the search resolves inline
    and no `pending_search` state is set on the player. When omitted, a
    SEARCH_ZONE effect sets pending_search and waits for submit_pending_search.
    """
    if game.current_phase != Phase.PLAY:
        return False, "Not in Play phase"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    if player.has_submitted_play:
        return False, "Plan already submitted"

    if card_index < 0 or card_index >= len(player.hand):
        return False, "Invalid card index"

    card = player.hand[card_index]

    # Block unplayable cards (e.g. Land Grant — passive VP, takes up a slot)
    if card.unplayable:
        return False, f"{card.name} cannot be played"

    # Debt card: requires 3 resources to play (self-trash)
    if card.name == "Debt":
        if player.resources < 3:
            return False, "Need 3 resources to play Debt"

    # Play resource cost (e.g. Mercenary)
    play_cost_effect = next((e for e in card.effects if e.type == EffectType.PLAY_RESOURCE_COST), None)
    if play_cost_effect:
        cost = play_cost_effect.effective_value(card.is_upgraded)
        if player.resources < cost:
            return False, f"Need {cost} resources to play {card.name}"

    # Global claim ban (Snowy Holiday) — no player can play Claim cards this round
    if card.card_type == CardType.CLAIM and game.claim_ban_rounds > 0:
        return False, "Claim cards are banned this round (Snowy Holiday)"

    # Block card play while a deferred discard is pending
    if player.pending_discard > 0:
        return False, "Must discard before playing another card"

    # Block card play while a deferred search (tutor) is pending
    if player.pending_search is not None:
        return False, "Must resolve pending search before playing another card"

    # Check action availability
    actions_remaining = player.actions_available - player.actions_used
    net_cost = card.action_cost - card.effective_action_return
    if actions_remaining < card.action_cost and net_cost > 0:
        return False, f"Need {card.action_cost} actions to play {card.name}" if card.action_cost > 1 else "No action slots available"

    # Validate target for claim cards
    if card.card_type == CardType.CLAIM and target_q is not None:
        assert game.grid is not None
        _target_r = target_r if target_r is not None else 0
        tile = game.grid.get_tile(target_q, _target_r)
        if not tile:
            return False, "Invalid target tile"

        # Flood: must target own tile (the "center" of the flood)
        if card.target_own_tile:
            if tile.owner != player_id:
                return False, f"{card.name} must target a tile you own"
        else:
            if tile.is_blocked:
                return False, "Cannot claim blocked tile"

            # Check tile immunity — other players' immune tiles cannot be targeted
            if tile.owner and tile.owner != player_id:
                for pid_check in game.player_order:
                    if pid_check == player_id:
                        continue
                    if f"{target_q},{_target_r}" in game.players[pid_check].turn_modifiers.immune_tiles:
                        return False, "This tile is immune to claims this round"

            # Check range requirement (adjacency_required + claim_range)
            if card.adjacency_required:
                player_tiles = game.grid.get_player_tiles(player_id)
                max_range = card.claim_range  # 1 = adjacent, 2 = two steps, etc.
                if not any(pt.distance_to(tile) <= max_range for pt in player_tiles):
                    if max_range <= 1:
                        return False, "Must claim a tile adjacent to one you own"
                    return False, f"Must claim a tile within {max_range} steps of one you own"

            # Prevent unoccupied_only cards from targeting owned tiles
            if card.effective_unoccupied_only and tile.owner is not None:
                return False, f"{card.name} can only target unoccupied tiles"

            # Power-vs-defense is NOT checked here — players may target tiles
            # with higher defense (e.g. to stack multiple claims). Insufficient
            # power simply fails at resolution time.

            # Check stacking (only one claim per tile unless exception).
            # Multi-target claims (Surge) lock their extra targets too, so a
            # subsequent non-stackable claim on any of them is rejected.
            def _tile_is_claimed(q: int, r: int) -> bool:
                for a in player.planned_actions:
                    if a.card.card_type != CardType.CLAIM:
                        continue
                    if a.target_q == q and a.target_r == r:
                        return True
                    if a.extra_targets and (q, r) in a.extra_targets:
                        return True
                return False

            if not card.stackable and _tile_is_claimed(target_q, _target_r):
                return False, "This card is not Stackable"

            # Adjacency bridge: target must connect two disconnected territory groups
            if any(e.type == EffectType.ADJACENCY_BRIDGE for e in card.effects):
                if not _tile_bridges_territory(game.grid, player_id, target_q, _target_r):
                    return False, f"{card.name} must target a tile that connects two of your disconnected territory groups"

    # Validate target for defense cards — must target a tile the player owns
    if card.card_type == CardType.DEFENSE and target_q is not None:
        assert game.grid is not None
        _target_r = target_r if target_r is not None else 0
        tile = game.grid.get_tile(target_q, _target_r)
        if not tile:
            return False, "Invalid target tile"
        if tile.is_blocked:
            return False, "Cannot target blocked tile"
        if tile.owner != player_id:
            return False, "Defense cards must target a tile you own"

    # Validate target for engine cards that target own tiles (Exodus, Scorched Retreat)
    if card.card_type == CardType.ENGINE and card.target_own_tile and target_q is not None:
        assert game.grid is not None
        _target_r = target_r if target_r is not None else 0
        tile = game.grid.get_tile(target_q, _target_r)
        if not tile:
            return False, "Invalid target tile"
        if tile.owner != player_id:
            return False, f"{card.name} must target a tile you own"
        if tile.is_base:
            return False, f"{card.name} cannot target a base tile"

        # Consecrate: must target a VP tile connected to base
        if card.effects and any(e.type == EffectType.ENHANCE_VP_TILE for e in card.effects):
            if not tile.is_vp:
                return False, f"{card.name} must target a VP tile"
            connected = game.grid.get_connected_tiles(player_id)
            if (tile.q, tile.r) not in connected:
                return False, f"{card.name} must target a VP tile connected to your base"

    # Validate extra targets for multi-target cards (Surge, Hive Mind)
    validated_extra: list[tuple[int, int]] = []
    if (
        card.card_type == CardType.CLAIM
        and card.effective_multi_target_count > 0
        and extra_targets
        and target_q is not None
        and target_r is not None
    ):
        assert game.grid is not None
        max_extra = card.effective_multi_target_count
        player_tiles = game.grid.get_player_tiles(player_id)
        for et_q, et_r in extra_targets[:max_extra]:
            et_tile = game.grid.get_tile(et_q, et_r)
            if not et_tile or et_tile.is_blocked:
                continue
            if card.adjacency_required:
                if not any(pt.distance_to(et_tile) <= card.claim_range for pt in player_tiles):
                    continue
            if card.effective_unoccupied_only and et_tile.owner is not None:
                continue
            # Non-stackable claims can't land on a tile any prior planned
            # claim (primary or extra) already targets this round.
            if not card.stackable and _tile_is_claimed(et_q, et_r):
                continue
            validated_extra.append((et_q, et_r))

        # All targets (primary + extras) must form a connected subgraph via
        # direct hex adjacency — e.g. Surge/Hive Mind target "adjacent tiles".
        if validated_extra:
            primary: tuple[int, int] = (target_q, target_r)
            all_targets: set[tuple[int, int]] = {primary, *validated_extra}
            # BFS from primary through hex-neighbors restricted to target set
            reached: set[tuple[int, int]] = {primary}
            frontier: list[tuple[int, int]] = [primary]
            hex_dirs = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
            while frontier:
                cq, cr = frontier.pop()
                for dq, dr in hex_dirs:
                    nb = (cq + dq, cr + dr)
                    if nb in all_targets and nb not in reached:
                        reached.add(nb)
                        frontier.append(nb)
            if reached != all_targets:
                return False, f"{card.name} targets must be adjacent to each other"

    # Validate extra targets for multi-tile defense cards (Bulwark, etc.)
    if card.card_type == CardType.DEFENSE and card.effective_defense_target_count > 1 and extra_targets:
        assert game.grid is not None
        max_extra_defense = card.effective_defense_target_count - 1  # primary target is already one
        for et_q, et_r in extra_targets[:max_extra_defense]:
            et_tile = game.grid.get_tile(et_q, et_r)
            if not et_tile or et_tile.is_blocked:
                continue
            if et_tile.owner != player_id:
                continue
            # Don't duplicate primary target
            if et_q == target_q and et_r == target_r:
                continue
            validated_extra.append((et_q, et_r))

    # Validate required trash/discard choices
    # Trashing is always optional — player may decline to trash (but forfeits the bonus).
    # Discarding is required if the player has other cards in hand.
    from .effects import EffectType as _EffectType
    defer_discard = False
    for effect in card.effects:
        if not effect.requires_choice:
            continue
        if effect.type == _EffectType.MANDATORY_SELF_TRASH:
            # Demon Pact: must trash exactly N other cards from hand
            exact = bool(effect.metadata.get("exact", False))
            required = effect.effective_value(card.is_upgraded)
            available = len(player.hand) - 1  # exclude the card being played
            if available < required:
                return False, f"{card.name} requires {required} other card(s) in hand to trash"
            if exact and (not trash_card_indices or len(trash_card_indices) != required):
                return False, f"{card.name} requires trashing exactly {required} card(s)"
            elif not trash_card_indices or len(trash_card_indices) < required:
                return False, f"{card.name} requires trashing {required} card(s)"
        if effect.type == _EffectType.SELF_DISCARD:
            # If the card also draws, defer the discard until after the draw
            # so the player can choose from their expanded hand
            if card.effective_draw_cards > 0:
                defer_discard = True
                continue
            max_discardable = len(player.hand) - 1
            required = min(effect.effective_value(card.is_upgraded), max_discardable)
            if required > 0 and (not discard_card_indices or len(discard_card_indices) < required):
                return False, f"{card.name} requires discarding {required} card(s)"
        if effect.type == _EffectType.SEARCH_ZONE:
            # Cannot play tutor cards if the source zone is empty (or no cards
            # match the optional filter). Playing would be a wasted action.
            from .effect_resolver import get_search_zone_cards, matches_card_filter
            source = str(effect.metadata.get("source", "discard"))
            source_cards = get_search_zone_cards(player, source)
            card_filter = effect.metadata.get("filter") if isinstance(effect.metadata.get("filter"), dict) else None
            eligible_count = sum(1 for c in source_cards if matches_card_filter(c, card_filter))
            if eligible_count == 0:
                zone_name = {"discard": "discard pile", "draw": "draw pile", "trash": "trash"}.get(source, source)
                # Mention the filtered card type in the error so the player knows
                # WHY their otherwise-stocked pile doesn't qualify.
                if card_filter and card_filter.get("card_type"):
                    type_label = str(card_filter["card_type"]).title()
                    return False, f"{card.name} requires {type_label} cards in your {zone_name}"
                return False, f"{card.name} requires cards in your {zone_name}"

    # Remove card from hand and create planned action
    # Compute effective power BEFORE removing the card so dynamic modifiers
    # (hand size, tile count, adjacency) reflect the game state at play time.
    # This value is frozen for the rest of the turn.
    snapshotted_power: Optional[int] = None
    # Skip snapshotting for cards with IF_CONTESTED power modifiers (Ambush) —
    # contest status isn't known until reveal phase when all claims are visible.
    has_contested_modifier = any(
        e.type == EffectType.POWER_MODIFIER and e.condition == ConditionType.IF_CONTESTED
        for e in card.effects
    )
    if card.card_type in (CardType.CLAIM, CardType.DEFENSE) and card.effects and not has_contested_modifier:
        # Build a temporary action to pass to calculate_effective_power
        _tmp_action = PlannedAction(
            card=card,
            target_q=target_q,
            target_r=target_r,
            extra_targets=validated_extra if (
                card.card_type == CardType.CLAIM and target_q is not None and card.effective_multi_target_count > 0
            ) or (
                card.card_type == CardType.DEFENSE and card.effective_defense_target_count > 1
            ) else [],
        )
        computed = calculate_effective_power(game, player, card, _tmp_action)
        # Only store if it differs from the base power (i.e. a dynamic modifier applied)
        if computed != card.effective_power:
            snapshotted_power = computed

    # Snapshot dynamic resource gain (War Tithe, Dividends) before removing card from hand
    snapshotted_resource_gain: Optional[int] = None
    if card.effects:
        for eff in card.effects:
            if eff.type == EffectType.RESOURCES_PER_CLAIMS_LAST_ROUND:
                per_claim = eff.upgraded_value if card.is_upgraded and eff.upgraded_value else eff.value
                max_key = "upgraded_max_resources" if card.is_upgraded else "max_resources"
                max_res = eff.metadata.get(max_key, 999)
                snapshotted_resource_gain = min(player.claims_won_last_round * per_claim, max_res)
                break
            if eff.type == EffectType.RESOURCE_SCALING:
                divisor = eff.value or 2
                snapshotted_resource_gain = max(1, player.resources // divisor)
                break
            if eff.type == EffectType.RESOURCES_PER_TILES_LOST:
                per_tile = eff.upgraded_value if card.is_upgraded and eff.upgraded_value else eff.value
                snapshotted_resource_gain = player.tiles_lost_last_round * per_tile
                break
            if eff.type == EffectType.RESOURCE_PER_VP_HEX and game.grid is not None:
                per_hex = eff.upgraded_value if card.is_upgraded and eff.upgraded_value else eff.value
                connected_coords = game.grid.get_connected_tiles(player_id)
                vp_hex_count = len([t for t in game.grid.tiles.values() if t.is_vp and t.owner == player_id and (t.q, t.r) in connected_coords])
                snapshotted_resource_gain = vp_hex_count * per_hex
                break

    # Snapshot dynamic draw count (Financier: draw per Debt) before removing card from hand
    snapshotted_draw_cards: Optional[int] = None
    if card.effects:
        for eff in card.effects:
            if eff.type == EffectType.DRAW_PER_DEBT:
                debt_count = sum(
                    1 for c in player.hand + player.deck.cards + player.deck.discard
                    if c.name == "Debt"
                )
                snapshotted_draw_cards = debt_count * eff.value
                break

    player.hand.pop(card_index)
    has_extra = (
        (card.card_type == CardType.CLAIM and target_q is not None and card.effective_multi_target_count > 0)
        or (card.card_type == CardType.DEFENSE and card.effective_defense_target_count > 1)
    )
    action = PlannedAction(
        card=card,
        target_q=target_q,
        target_r=target_r,
        target_player_id=target_player_id,
        extra_targets=validated_extra if has_extra else [],
        effective_power=snapshotted_power,
        effective_resource_gain=snapshotted_resource_gain,
        effective_draw_cards=snapshotted_draw_cards,
    )
    player.planned_actions.append(action)
    player.actions_used += card.action_cost

    # Handle immediate effects (↺ and ↑ return actions)
    if card.effective_action_return > 0:
        player.actions_available += card.effective_action_return

    # Immediate resource gain (or cost for negative values like Debt)
    if card.timing == Timing.IMMEDIATE and card.effective_resource_gain != 0:
        player.resources += card.effective_resource_gain
        if card.effective_resource_gain > 0:
            game._log(f"{player.name} gains {card.effective_resource_gain} resources from {card.name}",
                      visible_to=[player_id], actor=player_id)
        else:
            game._log(f"{player.name} pays {-card.effective_resource_gain} resources for {card.name}",
                      visible_to=[player_id], actor=player_id)

    # Immediate card draw
    # Check if draw is gated behind a trash choice (e.g. Thin the Herd: "Trash 1. If you did, draw 1.")
    draw_gated = any(
        e.metadata.get("gates_draw") and e.requires_choice
        and e.type in (_EffectType.SELF_TRASH, _EffectType.TRASH_GAIN_BUY_COST)
        for e in card.effects
    )
    should_draw = not draw_gated or bool(trash_card_indices)
    if card.timing == Timing.IMMEDIATE and card.effective_draw_cards > 0 and should_draw:
        drawn = player.deck.draw(card.effective_draw_cards, game.rng)
        player.hand.extend(drawn)
        game._log(f"{player.name} draws {len(drawn)} cards from {card.name}",
                  visible_to=[player_id], actor=player_id)

    # Resolve structured effects (from effects list on card)
    if card.effects:
        resolve_immediate_effects(
            game, player, card, action,
            discard_card_indices=discard_card_indices,
            trash_card_indices=trash_card_indices,
            extra_targets=[(t[0], t[1]) for t in (extra_targets or [])],
            skip_discard=defer_discard,
        )

    # Inline SEARCH_ZONE resolution: if the effect set pending_search AND the
    # caller provided selections (human UI commits them with the play), resolve
    # the search immediately so the card doesn't visibly hang in a pending
    # state on the client. CPU and legacy callers omit search_selections and
    # get the deferred pending_search flow.
    if player.pending_search is not None and search_selections is not None:
        ok, msg = submit_pending_search(game, player_id, search_selections)
        if not ok:
            # Validation failed — clear pending state so the player isn't stuck,
            # then surface the error. The card has already been played at this
            # point (planned_actions + action spent); search fizzles.
            player.pending_search = None
            return False, f"Invalid search selections: {msg}"

    # Set pending discard if the discard was deferred (card draws first, then player picks)
    if defer_discard:
        discard_effect = next(
            (e for e in card.effects if e.type == _EffectType.SELF_DISCARD), None
        )
        if discard_effect:
            count = discard_effect.effective_value(card.is_upgraded)
            required = min(count, len(player.hand))
            if required > 0:
                player.pending_discard = required
                game._log(f"{player.name} must discard {required} card(s)",
                          visible_to=[player_id], actor=player_id)

    game._log(f"{player.name} plays {card.name} (actions: {player.actions_used}/{player.actions_available})",
              visible_to=[player_id], actor=player_id)
    return True, f"Played {card.name}"


def undo_planned_action(
    game: GameState, player_id: str, action_index: int,
) -> tuple[bool, str]:
    """Undo a planned action during the play phase, returning the card to hand.

    Only works for cards tagged ``reversible`` — those with no immediate side
    effects beyond consuming an action slot.
    """
    if game.current_phase != Phase.PLAY:
        return False, f"Not in Play phase (current: {game.current_phase.value})"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.has_submitted_play:
        return False, "Already submitted play"

    if action_index < 0 or action_index >= len(player.planned_actions):
        return False, "Invalid action index"

    action = player.planned_actions[action_index]
    card = action.card

    if not card.reversible:
        return False, f"{card.name} cannot be undone"

    # Reverse: give back the action cost
    player.actions_used -= card.action_cost

    # Return card to hand
    player.hand.append(card)

    # Remove planned action
    player.planned_actions.pop(action_index)

    game._log(f"{player.name} undoes {card.name} (actions: {player.actions_used}/{player.actions_available})",
              visible_to=[player_id], actor=player_id)
    return True, f"Undid {card.name}"


def submit_pending_discard(
    game: GameState, player_id: str, discard_card_indices: list[int],
) -> tuple[bool, str]:
    """Resolve a deferred discard (e.g. Regroup: draw first, then pick cards to discard)."""
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.pending_discard <= 0:
        return False, "No pending discard"

    required = min(player.pending_discard, len(player.hand))
    if required > 0 and len(discard_card_indices) < required:
        return False, f"Must discard {required} card(s)"

    # Validate and remove (process in reverse to preserve indices)
    discarded: list[Card] = []
    for idx in sorted(discard_card_indices[:required], reverse=True):
        if 0 <= idx < len(player.hand):
            discarded.append(player.hand.pop(idx))

    if discarded:
        player.deck.add_to_discard(discarded)
        names = ", ".join(c.name for c in discarded)
        game._log(f"{player.name} discards {names} from hand",
                  visible_to=[player_id], actor=player_id)

    player.pending_discard = 0
    return True, f"Discarded {len(discarded)} card(s)"


def submit_pending_search(
    game: GameState, player_id: str,
    selections: list[dict[str, Any]],
) -> tuple[bool, str]:
    """Resolve a deferred search: move each selected card from source → chosen target zone.

    Each selection is a dict {"card_id": str, "target": str}. Cards are moved
    in snapshot order so ordering is deterministic. If min_count == 0, empty
    selections are allowed (player declined).
    """
    from .effect_resolver import get_search_zone_cards

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    ps = player.pending_search
    if ps is None:
        return False, "No pending search"

    if not isinstance(selections, list):
        return False, "Invalid selections"

    if len(selections) < ps.min_count:
        return False, f"Must select at least {ps.min_count} card(s)"
    if len(selections) > ps.count:
        return False, f"Cannot select more than {ps.count} card(s)"

    # Validate targets
    for sel in selections:
        if not isinstance(sel, dict):
            return False, "Invalid selection entry"
        target = sel.get("target")
        if target not in ps.allowed_targets:
            return False, f"Target '{target}' not allowed (allowed: {ps.allowed_targets})"
        if target not in ("hand", "top_of_draw", "discard", "trash"):
            return False, f"Unknown target '{target}'"

    source_list = get_search_zone_cards(player, ps.source)

    # Validate card_ids are in the snapshot and still present, with unique-index matching
    # (duplicates of the same card id in the pile must each only be picked once).
    snapshot_counts: dict[str, int] = {}
    for cid in ps.snapshot_card_ids:
        snapshot_counts[cid] = snapshot_counts.get(cid, 0) + 1

    selected_counts: dict[str, int] = {}
    for sel in selections:
        raw_cid = sel.get("card_id")
        if not isinstance(raw_cid, str):
            return False, "Invalid card_id in selection"
        selected_counts[raw_cid] = selected_counts.get(raw_cid, 0) + 1
        if selected_counts[raw_cid] > snapshot_counts.get(raw_cid, 0):
            return False, f"Card {raw_cid} selected more times than available"

    # Resolve each selection: find the card instance in the source list by id,
    # remove it, and append to the target zone. We consume from the start of
    # the source list to pick stable matches when duplicates exist.
    moves: list[tuple[Card, str]] = []
    remaining = list(source_list)  # shallow copy for iteration
    for sel in selections:
        cid = sel["card_id"]
        target = sel["target"]
        # Find first match in `remaining`
        match_idx = None
        for i, c in enumerate(remaining):
            if c.id == cid:
                match_idx = i
                break
        if match_idx is None:
            player.pending_search = None
            return False, f"Card {cid} no longer available in {ps.source}"
        card_obj = remaining.pop(match_idx)
        moves.append((card_obj, str(target)))

    # Apply moves: first remove each moved card from the real source list,
    # then deposit into the target zone. We locate each card by identity (is).
    for card_obj, _target in moves:
        try:
            source_list.remove(card_obj)
        except ValueError:
            player.pending_search = None
            return False, f"Card {card_obj.id} vanished during resolution"

    # Deposit into target zones. `top_of_draw` inserts at front; apply in
    # reverse so the first-chosen card ends up on top.
    moved_counts_by_target: dict[str, int] = {}
    for card_obj, target in moves:
        if target == "hand":
            player.hand.append(card_obj)
        elif target == "top_of_draw":
            # Will apply in reverse below
            pass
        elif target == "discard":
            player.deck.add_to_discard([card_obj])
        elif target == "trash":
            player.trash.append(card_obj)
        if target != "top_of_draw":
            moved_counts_by_target[target] = moved_counts_by_target.get(target, 0) + 1

    # Apply top_of_draw in reverse so the first chosen card ends up on top
    top_of_draw_cards = [c for c, t in moves if t == "top_of_draw"]
    for card_obj in reversed(top_of_draw_cards):
        player.deck.add_to_top(card_obj)
    if top_of_draw_cards:
        moved_counts_by_target["top_of_draw"] = len(top_of_draw_cards)

    # Log the result. Translate internal zone keys to player-friendly phrases.
    from .effect_resolver import _SEARCH_ZONE_DISPLAY
    zone_name = _SEARCH_ZONE_DISPLAY.get(ps.source, ps.source)
    target_phrase = {
        "hand": "hand",
        "top_of_draw": "top of draw pile",
        "discard": "discard pile",
        "trash": "trash",
    }
    if moves:
        target_parts = [
            f"{cnt} to {target_phrase.get(t, t.replace('_', ' '))}"
            for t, cnt in moved_counts_by_target.items()
        ]
        names = ", ".join(c.name for c, _ in moves)
        game._log(
            f"{player.name} takes {names} from {zone_name} ({'; '.join(target_parts)})",
            visible_to=[player_id], actor=player_id,
        )
    else:
        game._log(
            f"{player.name} declines to take any cards from {zone_name}",
            visible_to=[player_id], actor=player_id,
        )

    player.pending_search = None
    return True, f"Moved {len(moves)} card(s)"


def submit_play(game: GameState, player_id: str) -> tuple[bool, str]:
    """Mark a player as done playing."""
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.pending_discard > 0:
        return False, "Must discard before submitting plan"
    if player.pending_search is not None:
        return False, "Must resolve pending search before submitting plan"
    player.has_submitted_play = True
    game._log(f"{player.name} submits plan ({len(player.planned_actions)} actions)",
              actor=player_id)

    # Check if all players have submitted
    if all(p.has_submitted_play for p in game.players.values()):
        execute_reveal(game)

    return True, "Plan submitted"


def _find_closest_owned_tile(
    game: GameState, player_id: str, target_q: int, target_r: int,
) -> tuple[int, int] | None:
    """Find the closest tile owned by player_id to the target tile."""
    assert game.grid is not None
    best: tuple[int, int] | None = None
    best_dist = float("inf")
    for key, tile in game.grid.tiles.items():
        if tile.owner == player_id:
            # Axial distance
            dq = tile.q - target_q
            dr = tile.r - target_r
            dist = (abs(dq) + abs(dq + dr) + abs(dr)) / 2
            if dist < best_dist:
                best_dist = dist
                best = (tile.q, tile.r)
    return best


def execute_reveal(game: GameState) -> GameState:
    """Phase 3: Reveal & Resolve — flip all cards and resolve claims."""
    game.current_phase = Phase.REVEAL
    game.resolution_steps = []
    game.player_effects = []
    game._log("=== Reveal & Resolve ===")

    # Log each player's played cards
    for pid in game.player_order:
        player = game.players[pid]
        if player.has_left:
            continue
        if player.planned_actions:
            card_names = [a.card.name for a in player.planned_actions]
            game._log(f"{player.name} played: {', '.join(card_names)}", actor=pid)
        else:
            game._log(f"{player.name} played no cards", actor=pid)

    assert game.grid is not None

    # Collect all claims by tile
    claims_by_tile: dict[str, list[tuple[str, PlannedAction]]] = {}
    other_actions: list[tuple[str, PlannedAction]] = []

    for pid in game.player_order:
        player = game.players[pid]
        for action in player.planned_actions:
            if (action.card.card_type == CardType.CLAIM
                    and action.target_q is not None):

                # Flood: target is an owned tile; expand to all adjacent tiles
                if action.card.flood:
                    _target_r = action.target_r if action.target_r is not None else 0
                    adj_tiles = game.grid.get_adjacent(action.target_q, _target_r)
                    for adj_tile in adj_tiles:
                        if not adj_tile.is_blocked:
                            adj_key = f"{adj_tile.q},{adj_tile.r}"
                            claims_by_tile.setdefault(adj_key, []).append((pid, action))
                    game._log(
                        f"{player.name} floods from {action.target_q},{_target_r} "
                        f"({len([t for t in adj_tiles if not t.is_blocked])} adjacent tiles)",
                        actor=pid)
                else:
                    tile_key = f"{action.target_q},{action.target_r}"
                    claims_by_tile.setdefault(tile_key, []).append((pid, action))

                    # Surge: add extra targets as additional claims on separate tiles
                    for et_q, et_r in action.extra_targets:
                        et_key = f"{et_q},{et_r}"
                        claims_by_tile.setdefault(et_key, []).append((pid, action))
            else:
                other_actions.append((pid, action))

    # Pre-resolve abandon effects (abandon_tile, abandon_and_block) before claims.
    # These transform tiles before claim resolution so claims against blocked tiles fail.
    abandon_actions: list[tuple[str, PlannedAction]] = []
    remaining_other: list[tuple[str, PlannedAction]] = []
    for pid, action in other_actions:
        has_abandon = action.card.effects and any(
            e.type in (EffectType.ABANDON_TILE, EffectType.ABANDON_AND_BLOCK)
            for e in action.card.effects
        )
        if has_abandon:
            abandon_actions.append((pid, action))
        else:
            remaining_other.append((pid, action))
    other_actions = remaining_other

    for pid, action in abandon_actions:
        player = game.players[pid]
        resolve_on_resolution_effects(game, player, action.card, action)

    # Remove claims targeting tiles that are now blocked (from Scorched Retreat)
    for tile_key in list(claims_by_tile.keys()):
        tile = game.grid.tiles.get(tile_key)
        if tile and tile.is_blocked:
            for cpid, _action in claims_by_tile[tile_key]:
                game._log(
                    f"{game.players[cpid].name}'s claim on {tile_key} fails — tile is now blocked terrain",
                    actor=cpid)
            del claims_by_tile[tile_key]

    # ── Pre-resolve defense cards BEFORE claims ──────────────────────
    # Defense cards are applied first so their bonuses count during claim resolution.
    defense_actions: list[tuple[str, PlannedAction]] = []
    non_defense_other: list[tuple[str, PlannedAction]] = []
    for pid, action in other_actions:
        if action.card.card_type == CardType.DEFENSE:
            defense_actions.append((pid, action))
        else:
            non_defense_other.append((pid, action))
    other_actions = non_defense_other

    for pid, action in defense_actions:
        player = game.players[pid]
        card = action.card

        # Resource / draw effects for ON_RESOLUTION defense cards
        if card.timing == Timing.ON_RESOLUTION:
            if card.effective_resource_gain > 0:
                player.resources += card.effective_resource_gain
            if card.effective_draw_cards > 0:
                drawn = player.deck.draw(card.effective_draw_cards, game.rng)
                player.hand.extend(drawn)

        # Apply defense bonus to target tile(s)
        has_perm_def = card.effects and any(
            e.type == EffectType.PERMANENT_DEFENSE for e in card.effects
        )
        if action.target_q is not None and not has_perm_def:
            _action_target_r = action.target_r if action.target_r is not None else 0
            tile = game.grid.get_tile(action.target_q, _action_target_r)
            if tile and tile.owner == pid:
                tile.defense_power += card.effective_defense_bonus
                game._log(f"{player.name} fortifies tile {action.target_q},{action.target_r} (+{card.effective_defense_bonus} defense)")
            for et_q, et_r in action.extra_targets:
                et_tile = game.grid.get_tile(et_q, et_r)
                if et_tile and et_tile.owner == pid:
                    et_tile.defense_power += card.effective_defense_bonus
                    game._log(f"{player.name} fortifies tile {et_q},{et_r} (+{card.effective_defense_bonus} defense)")

        # Resolve structured on_resolution effects (permanent_defense, defense_per_adjacent, etc.)
        if card.effects:
            resolve_on_resolution_effects(game, player, card, action)

        # Build defense resolution steps for frontend animation
        is_immunity = card.effects and any(e.type == EffectType.TILE_IMMUNITY for e in card.effects)
        all_target_keys: list[str] = []
        if action.target_q is not None:
            _tr = action.target_r if action.target_r is not None else 0
            all_target_keys.append(f"{action.target_q},{_tr}")
        for et_q, et_r in action.extra_targets:
            all_target_keys.append(f"{et_q},{et_r}")
        for tk in all_target_keys:
            t = game.grid.tiles.get(tk)
            if t and t.owner == pid:
                step_dict: dict[str, Any] = {
                    "tile_key": tk,
                    "q": t.q, "r": t.r,
                    "contested": False,
                    "claimants": [{"player_id": pid, "power": 0, "source_q": None, "source_r": None}],
                    "defender_id": pid,
                    "defender_power": t.defense_power,
                    "winner_id": pid,
                    "previous_owner": pid,
                    "outcome": "defense_applied",
                    "defense_permanent": t.base_defense + t.permanent_defense_bonus,
                    "defense_temporary": t.defense_power - t.base_defense - t.permanent_defense_bonus,
                }
                if is_immunity:
                    step_dict["defense_immunity"] = True
                game.resolution_steps.append(step_dict)

        # Trash on use
        if card.effective_trash_on_use:
            player.trash.append(card)
            game._log(f"{card.name} is trashed after use")
        else:
            player.deck.add_to_discard([card])

    # Check for tile immunity — remove immune tiles from claims
    for pid in game.player_order:
        player = game.players[pid]
        for tile_key, rounds in player.turn_modifiers.immune_tiles.items():
            if tile_key in claims_by_tile:
                # Remove claims from OTHER players on immune tiles
                claims_by_tile[tile_key] = [
                    (cpid, action) for cpid, action in claims_by_tile[tile_key]
                    if cpid == pid  # only owner's claims survive
                ]
                game._log(f"Tile {tile_key} is immune to claims this round")

    # Check for ignore_defense — collect affected tiles
    ignore_defense_tiles: set[str] = set()
    for pid in game.player_order:
        ignore_defense_tiles.update(game.players[pid].turn_modifiers.ignore_defense_tiles)

    # Track claim results for on_resolution effects
    claim_results: dict[str, dict[str, bool]] = {}  # tile_key -> {pid -> succeeded}

    # Resolve claims: highest power wins, ties to defender
    for tile_key, claims in claims_by_tile.items():
        tile = game.grid.tiles.get(tile_key)
        if not tile:
            continue

        if not claims:
            continue

        # Calculate total power per player for this tile using effect resolver
        power_by_player: dict[str, int] = {}
        for pid, action in claims:
            player = game.players[pid]
            power = calculate_effective_power(game, player, action.card, action)
            power_by_player[pid] = power_by_player.get(pid, 0) + power

        # Add existing defense (owned tile: credited to owner; unowned tile with intrinsic
        # defense: modeled as a neutral blocker that real players must beat)
        # ignore_defense (Siege Engine, Conqueror) only strips temporary round bonuses;
        # intrinsic terrain defense AND permanent defense (Entrench/Barricade/Twin Cities)
        # still count.
        if tile_key not in ignore_defense_tiles:
            current_defense = tile.defense_power
        else:
            current_defense = tile.base_defense + tile.permanent_defense_bonus
        if tile.owner:
            power_by_player.setdefault(tile.owner, 0)
            power_by_player[tile.owner] += current_defense
        elif current_defense > 0:
            power_by_player["_neutral"] = current_defense

        # Find winner — filter out the neutral pseudo-player first
        max_power = max(power_by_player.values())
        contenders = [pid for pid, pwr in power_by_player.items() if pwr == max_power]
        real_contenders = [pid for pid in contenders if pid != "_neutral"]

        if not real_contenders:
            # All attackers were beaten by intrinsic tile defense
            game._log(f"Tile {tile_key}: intrinsic defense held (def {current_defense})")
            for pid, _ in claims:
                claim_results.setdefault(tile_key, {})[pid] = False
            # Build resolution step for failed claims
            claimants = []
            for pid, _action in claims:
                src = _find_closest_owned_tile(game, pid, tile.q, tile.r)
                claimants.append({
                    "player_id": pid,
                    "power": power_by_player.get(pid, 0),
                    "source_q": src[0] if src else None,
                    "source_r": src[1] if src else None,
                })
            game.resolution_steps.append({
                "tile_key": tile_key,
                "q": tile.q, "r": tile.r,
                "contested": len(claims) > 1 or tile.owner is not None,
                "claimants": claimants,
                "defender_id": None,
                "defender_power": current_defense,
                "winner_id": None,
                "previous_owner": tile.owner,
                "outcome": "defense_held",
            })
            continue

        if len(real_contenders) == 1:
            winner_id = real_contenders[0]
        elif tile.owner in real_contenders:
            winner_id = tile.owner  # defender wins ties
        else:
            # Tie between attackers — nobody wins
            game._log(f"Tile {tile_key}: tie between attackers, no change")
            for pid, _ in claims:
                claim_results.setdefault(tile_key, {})[pid] = False
            claimants = []
            for pid, _action in claims:
                src = _find_closest_owned_tile(game, pid, tile.q, tile.r)
                claimants.append({
                    "player_id": pid,
                    "power": power_by_player.get(pid, 0),
                    "source_q": src[0] if src else None,
                    "source_r": src[1] if src else None,
                })
            game.resolution_steps.append({
                "tile_key": tile_key,
                "q": tile.q, "r": tile.r,
                "contested": True,
                "claimants": claimants,
                "defender_id": tile.owner,
                "defender_power": power_by_player.get(tile.owner, 0) if tile.owner else 0,
                "winner_id": None,
                "previous_owner": tile.owner,
                "outcome": "tie",
            })
            continue

        # Record results for all claimers
        for pid, _ in claims:
            claim_results.setdefault(tile_key, {})[pid] = (pid == winner_id)

        # Build resolution step data BEFORE mutating tile
        is_contested = len(claims) > 1 or (tile.owner is not None and tile.owner != winner_id)
        claimants = []
        for pid, _action in claims:
            src = _find_closest_owned_tile(game, pid, tile.q, tile.r)
            claimants.append({
                "player_id": pid,
                "power": power_by_player.get(pid, 0),
                "source_q": src[0] if src else None,
                "source_r": src[1] if src else None,
            })
        game.resolution_steps.append({
            "tile_key": tile_key,
            "q": tile.q, "r": tile.r,
            "contested": is_contested,
            "claimants": claimants,
            "defender_id": tile.owner if tile.owner and tile.owner != winner_id else None,
            "defender_power": power_by_player.get(tile.owner, 0) if tile.owner else 0,
            "winner_id": winner_id,
            "previous_owner": tile.owner,
            "outcome": "claimed" if winner_id != tile.owner else "defended",
        })

        if winner_id != tile.owner:
            if tile.is_base:
                # Base raid: generate Rubble cards for defender and Spoils for attacker
                base_owner_id = tile.base_owner or ""
                defender = game.players[base_owner_id]
                attacker = game.players[winner_id]
                attacker_power = power_by_player.get(winner_id, 0)
                total_defense = power_by_player.get(base_owner_id, 0) if base_owner_id in power_by_player else current_defense
                rubble_count = max(0, attacker_power - total_defense)
                if rubble_count > 0:
                    for _ in range(rubble_count):
                        defender.deck.discard.append(make_rubble_card())
                    attacker.deck.discard.append(make_spoils_card())
                    game._log(
                        f"{attacker.name} raids {defender.name}'s base! "
                        f"{rubble_count} Rubble added to {defender.name}'s deck, "
                        f"Spoils added to {attacker.name}'s deck."
                    )
                    # Record player effects for flying-card animations
                    game.player_effects.append({
                        "source_player_id": winner_id,
                        "target_player_id": base_owner_id,
                        "card_name": "Raided",
                        "effect": f"+{rubble_count} Rubble",
                        "effect_type": "base_raid_rubble",
                        "value": rubble_count,
                        "source_q": tile.q,
                        "source_r": tile.r,
                        "added_card_name": "Rubble",
                        "added_card_count": rubble_count,
                    })
                    game.player_effects.append({
                        "source_player_id": winner_id,
                        "target_player_id": winner_id,
                        "card_name": "Spoils",
                        "effect": "+1 Spoils",
                        "effect_type": "base_raid_spoils",
                        "value": 1,
                        "source_q": tile.q,
                        "source_r": tile.r,
                        "added_card_name": "Spoils",
                        "added_card_count": 1,
                    })
                else:
                    game._log(f"{game.players[winner_id].name} fails to raid {defender.name}'s base")
            else:
                old_owner = tile.owner
                if old_owner is not None:
                    tile.capture_count += 1  # tile changed hands between players
                tile.owner = winner_id
                tile.held_since_turn = game.current_round
                tile.defense_power = tile.base_defense  # reset to intrinsic defense, not 0
                tile.permanent_defense_bonus = 0  # Entrench bonuses lost on capture
                game._log(f"{game.players[winner_id].name} claims tile {tile_key} (power {max_power})")
        else:
            game._log(f"{tile.owner and game.players[tile.owner].name} defends tile {tile_key}")
            # Defended base raid: emit a "Defended" popup above the base owner
            # so the player sees their base held. Only fires if an opponent
            # actually tried to claim the base this round.
            if tile.is_base and tile.owner:
                base_owner_id = tile.owner
                attacker_ids = [pid for pid, _ in claims if pid != base_owner_id]
                if attacker_ids:
                    game.player_effects.append({
                        "source_player_id": attacker_ids[0],
                        "target_player_id": base_owner_id,
                        "card_name": "Defended",
                        "effect": "Raid repelled",
                        "effect_type": "base_raid_defended",
                        "value": 0,
                        "source_q": tile.q,
                        "source_r": tile.r,
                    })

    # Resolve on_resolution effects for claim cards
    for tile_key, claims in claims_by_tile.items():
        tile = game.grid.tiles.get(tile_key)
        for pid, action in claims:
            player = game.players[pid]
            succeeded = claim_results.get(tile_key, {}).get(pid, False)
            defender_id = tile.owner if tile and tile.owner != pid else None
            # Resolve structured effects
            if action.card.effects:
                resolve_on_resolution_effects(
                    game, player, action.card, action,
                    claim_succeeded=succeeded,
                    defender_id=defender_id,
                )

    # Resolve non-claim, non-defense actions (on_resolution effects)
    # (Defense cards were already resolved before claims above.)
    for pid, action in other_actions:
        player = game.players[pid]
        card = action.card

        if card.timing == Timing.ON_RESOLUTION:
            if card.effective_resource_gain > 0:
                player.resources += card.effective_resource_gain
            if card.effective_draw_cards > 0:
                drawn = player.deck.draw(card.effective_draw_cards, game.rng)
                player.hand.extend(drawn)

        # Forced discards
        if card.forced_discard > 0 and action.target_player_id:
            target = game.players.get(action.target_player_id)
            if target:
                target.forced_discard_next_turn += card.forced_discard
                game._log(f"{player.name} forces {target.name} to discard {card.forced_discard} next turn")
                game.player_effects.append({
                    "source_player_id": pid,
                    "target_player_id": action.target_player_id,
                    "card_name": card.name,
                    "effect": f"-{card.forced_discard} card{'s' if card.forced_discard > 1 else ''} next turn",
                    "effect_type": "forced_discard",
                    "value": card.forced_discard,
                })

        # Resolve structured on_resolution effects for non-claim cards
        if card.effects:
            resolve_on_resolution_effects(game, player, card, action,
                                          claim_results=claim_results)

        # Consecrate: add resolution step for VP tile enhancement animation
        if card.effects and any(e.type == EffectType.ENHANCE_VP_TILE for e in card.effects):
            if action.target_q is not None:
                _tr = action.target_r if action.target_r is not None else 0
                _cons_tile = game.grid.get_tile(action.target_q, _tr)
                _vp_bonus = 1
                if card.is_upgraded:
                    for eff in card.effects:
                        if eff.type == EffectType.ENHANCE_VP_TILE:
                            _vp_bonus = eff.metadata.get("upgraded_bonus", 2)
                            break
                game.resolution_steps.append({
                    "tile_key": f"{action.target_q},{_tr}",
                    "q": action.target_q, "r": _tr,
                    "contested": False,
                    "claimants": [{"player_id": pid, "power": 0, "source_q": None, "source_r": None}],
                    "defender_id": None,
                    "defender_power": 0,
                    "winner_id": pid,
                    "previous_owner": pid,
                    "outcome": "consecrate",
                    "vp_value": _cons_tile.vp_value if _cons_tile else _vp_bonus,
                })

        # Trash on use
        if card.effective_trash_on_use:
            player.trash.append(card)
            game._log(f"{card.name} is trashed after use")
        else:
            player.deck.add_to_discard([card])

    # Sort resolution steps by turn order starting from first player.
    # Each step is assigned to the first claimant that appears in turn order
    # (rotated so first_player_index leads), so that player's claims animate first.
    if game.resolution_steps:
        n = len(game.player_order)
        fpi = game.first_player_index % n if n > 0 else 0
        rotated_order = game.player_order[fpi:] + game.player_order[:fpi]
        pid_rank = {pid: i for i, pid in enumerate(rotated_order)}

        def step_sort_key(step: dict[str, Any]) -> tuple[int, int, int, int, int]:
            # Tier: defense_applied (0), regular claims (1), post-claim effects like auto_claim/consecrate (2)
            outcome = step.get("outcome")
            if outcome == "defense_applied":
                tier = 0
            elif outcome in ("auto_claim", "consecrate"):
                tier = 2
            else:
                tier = 1
            # Primary: rank of the earliest claimant in turn order
            claimant_ids = [c["player_id"] for c in step.get("claimants", [])]
            min_rank = min((pid_rank.get(pid, n) for pid in claimant_ids), default=n)
            # Secondary: uncontested before contested (so a player's clean claims
            # resolve before their fights)
            contested = 1 if step.get("contested") else 0
            # Tertiary: stable sort by tile position for determinism
            return (tier, min_rank, contested, step.get("q", 0) * 1000 + step.get("r", 0), 0)

        game.resolution_steps.sort(key=step_sort_key)

    # Cease Fire check: grant bonus draws if player didn't claim opponent tiles
    for pid in game.player_order:
        player = game.players[pid]
        bonus = player.turn_modifiers.cease_fire_bonus
        if bonus > 0:
            # Check if this player captured any tile that was owned by another player
            claimed_opponent_tile = False
            for tile_key, results in claim_results.items():
                if pid in results and results[pid]:  # player won this claim
                    step = next((s for s in game.resolution_steps
                                 if s["tile_key"] == tile_key), None)
                    if step and step.get("previous_owner") and step["previous_owner"] != pid:
                        claimed_opponent_tile = True
                        break
            if not claimed_opponent_tile:
                player.turn_modifiers.extra_draws_next_turn += bonus
                game._log(f"{player.name} draws {bonus} extra card(s) next turn (Cease Fire)")
                game.player_effects.append({
                    "source_player_id": pid,
                    "target_player_id": pid,
                    "card_name": "Cease Fire",
                    "effect": f"+{bonus} Cards next round",
                    "effect_type": "cease_fire",
                    "value": bonus,
                })
            else:
                game._log(f"{player.name}'s Cease Fire bonus forfeited — claimed an opponent tile")

    # Passive cards in hand: check for on_resolution effects (e.g. Battle Glory)
    for pid in game.player_order:
        player = game.players[pid]
        for card in player.hand:
            if not card.unplayable or not card.effects:
                continue
            for effect in card.effects:
                if effect.timing != Timing.ON_RESOLUTION:
                    continue
                # Create a dummy action for the effect context
                dummy_action = PlannedAction(card=card)
                resolve_on_resolution_effects(
                    game, player, card, dummy_action,
                    claim_succeeded=None,
                    defender_id=None,
                    claim_results=claim_results,
                )
                break  # Only trigger once per card

    # Track claims won this round (for War Tithe next round)
    for pid in game.player_order:
        won = sum(
            1 for results in claim_results.values()
            if pid in results and results[pid]
        )
        game.players[pid].claims_won_last_round = won

    # Track tiles lost this round (for Robin Hood next round)
    tiles_lost: dict[str, int] = {pid: 0 for pid in game.player_order}
    for step in game.resolution_steps:
        prev = step.get("previous_owner")
        if prev and prev in tiles_lost:
            tiles_lost[prev] += 1
    for pid in game.player_order:
        game.players[pid].tiles_lost_last_round = tiles_lost[pid]

    # Discard planned claim cards (or trash if trash_on_use)
    for pid in game.player_order:
        player = game.players[pid]
        for action in player.planned_actions:
            if action.card.card_type == CardType.CLAIM:
                if action.card.effective_trash_on_use:
                    player.trash.append(action.card)
                else:
                    player.deck.add_to_discard([action.card])

    # Stay in REVEAL phase — clients animate, then call advance_resolve to proceed to BUY
    return game


def advance_resolve(game: GameState, player_id: str) -> tuple[bool, str]:
    """Player acknowledges resolve phase is complete (animations done).

    Waits for all human players to acknowledge before advancing to BUY.
    """
    if game.current_phase != Phase.REVEAL:
        return False, "Not in Reveal phase"
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.has_acknowledged_resolve:
        return False, "Already acknowledged"

    player.has_acknowledged_resolve = True
    game._log(f"{player.name} ready to proceed", actor=player_id)

    # Check if all players have acknowledged (CPU auto-acknowledged)
    if all(
        p.has_acknowledged_resolve or p.is_cpu
        for p in game.players.values()
    ):
        _transition_to_buy(game)

    return True, "Resolve acknowledged"


def _transition_to_buy(game: GameState) -> None:
    """Transition from REVEAL to BUY phase (concurrent — all players buy simultaneously)."""
    game.current_phase = Phase.BUY
    game.buy_phase_purchases = {}
    game.shared_market.selling_out.clear()
    # Mark left players as already done
    game.players_done_buying = {
        pid for pid in game.player_order if game.players[pid].has_left
    }
    game._log("=== Buy Phase ===")


def player_owns_card_by_name(player: "Player", card_name: str) -> bool:
    """Return True if the player's deck (draw + hand + discard) already contains
    a card with the given name. Trashed cards are excluded — they have been
    removed from the deck.
    """
    for c in player.deck.cards:
        if c.name == card_name:
            return True
    for c in player.hand:
        if c.name == card_name:
            return True
    for c in player.deck.discard:
        if c.name == card_name:
            return True
    return False


def buy_card(game: GameState, player_id: str, source: str, card_id: str) -> tuple[bool, str]:
    """Buy a card during Buy phase.

    source: "archetype", "shared", or "upgrade"
    """
    if game.current_phase != Phase.BUY:
        return False, "Not in Buy phase"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    if player.has_ended_turn or player_id in game.players_done_buying:
        return False, "Already done buying"

    # Check buy restriction (Blitz Rush)
    if player.turn_modifiers.buy_locked:
        return False, "Cannot purchase cards this round (buy restriction active)"

    free = False  # resource costs always apply

    if source == "upgrade":
        if not free and player.resources < UPGRADE_CREDIT_COST:
            return False, f"Need {UPGRADE_CREDIT_COST} resources for upgrade credit"
        if not free:
            player.resources -= UPGRADE_CREDIT_COST
        player.upgrade_credits += 1
        game.buy_phase_purchases.setdefault(player_id, []).append({
            "card_id": "upgrade_credit", "card_name": "Upgrade Credit",
            "source": "upgrade", "cost": UPGRADE_CREDIT_COST if not free else 0,
        })
        game._log(f"{player.name} buys upgrade credit ({player.upgrade_credits} total)")
        return True, "Upgrade credit purchased"

    if source == "archetype":
        target = None
        for card in player.archetype_market:
            if card.id == card_id:
                target = card
                break
        if not target:
            return False, "Card not in archetype market"
        # Unique cards: cannot be purchased if already in the player's deck
        # (draw pile, hand, or discard). Trashed copies don't count.
        if target.unique and player_owns_card_by_name(player, target.name):
            return False, f"You already own a copy of {target.name} (Unique)"
        if not free:
            dynamic_cost = calculate_dynamic_buy_cost(game, player, target)
            effective_cost = _apply_cost_reductions(player, target, base_cost_override=dynamic_cost)
            if effective_cost > 0 and player.resources < effective_cost:
                return False, f"Need {effective_cost} resources"
            if effective_cost > 0:
                player.resources -= effective_cost
        player.archetype_market.remove(target)
        player.archetype_deck.remove(target)
        # Note: _prev_market_ids / _prev_market_ids_prev are intentionally
        # NOT cleared on purchase — they feed the 3-roll exclusion window,
        # which should span natural rolls, re-rolls, AND purchases.
        player.deck.add_to_discard([target])
        game.buy_phase_purchases.setdefault(player_id, []).append({
            "card_id": target.id, "card_name": target.name,
            "source": "archetype", "cost": effective_cost if not free else 0,
        })
        game._log(f"{player.name} buys {target.name} from archetype market")
        return True, f"Bought {target.name}"

    if source == "shared":
        # One copy per neutral card per round per player
        already_bought = game.buy_phase_purchases.get(player_id, [])
        if any(p["source"] == "shared" and p["card_id"] == card_id for p in already_bought):
            return False, "Already purchased this card this round (limit 1 per round)"

        # Peek at the card before committing the purchase so we can enforce
        # Unique without mutating the market on failure. Check both physical
        # copies and selling-out templates.
        peek_card: Optional[Card] = None
        for base_id, copies in game.shared_market.stacks.items():
            if copies and (base_id == card_id or card_id.startswith(base_id)):
                peek_card = copies[0]
                break
        if peek_card is None:
            # Check selling-out templates
            for base_id in game.shared_market.selling_out:
                if base_id == card_id or card_id.startswith(base_id):
                    peek_card = game.shared_market.card_templates.get(base_id)
                    break
        if peek_card is not None and peek_card.unique and player_owns_card_by_name(player, peek_card.name):
            return False, f"You already own a copy of {peek_card.name} (Unique)"

        result = game.shared_market.purchase(card_id, player_id)
        if not result:
            return False, "Card not available in shared market"
        purchased, base_card_id = result
        if not free:
            dynamic_cost = calculate_dynamic_buy_cost(game, player, purchased)
            effective_cost = _apply_cost_reductions(player, purchased, base_cost_override=dynamic_cost)
            if effective_cost > 0 and player.resources < effective_cost:
                # Put it back (only if not selling-out — selling-out clones are ephemeral)
                if base_card_id not in game.shared_market.selling_out or \
                        player_id not in game.shared_market.selling_out[base_card_id]:
                    game.shared_market.stacks.setdefault(base_card_id, []).insert(0, purchased)
                else:
                    # Undo selling-out record for this player
                    game.shared_market.selling_out[base_card_id].discard(player_id)
                return False, f"Need {effective_cost} resources"
            if effective_cost > 0:
                player.resources -= effective_cost
        player.deck.add_to_discard([purchased])
        game.buy_phase_purchases.setdefault(player_id, []).append({
            "card_id": base_card_id, "card_name": purchased.name,
            "source": "shared", "cost": effective_cost if not free else 0,
        })
        game.shared_purchase_log.append({
            "card_id": base_card_id,
            "card_name": purchased.name,
            "player_id": player_id,
            "player_name": player.name,
            "round": game.current_round,
        })
        # Note: passive_vp cards (e.g. Land Grant) contribute to derived VP automatically
        game._log(f"{player.name} buys {purchased.name} from shared market")
        return True, f"Bought {purchased.name}"

    return False, "Invalid source"


def spend_upgrade_credit(
    game: GameState, player_id: str, card_index: int
) -> tuple[bool, str]:
    """Spend an upgrade credit to permanently upgrade a card in hand.

    Can be done during the Play phase, multiple times per turn.
    """
    if game.current_phase != Phase.PLAY:
        return False, "Can only upgrade cards during the Play phase"
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.upgrade_credits <= 0 and not game.test_mode:
        return False, "No upgrade credits available"
    if card_index < 0 or card_index >= len(player.hand):
        return False, "Invalid card index"
    card = player.hand[card_index]
    if card.is_upgraded:
        return False, f"{card.name} is already upgraded"
    # Apply upgrade
    card.is_upgraded = True
    if card.name_upgraded:
        card.name = card.name_upgraded
    if card.upgrade_description:
        card.description = card.upgrade_description
    if not game.test_mode:
        player.upgrade_credits -= 1
    game._log(
        f"{player.name} upgrades {card.name} "
        f"({player.upgrade_credits} credits remaining)"
    )
    return True, f"Upgraded to {card.name}"


def calculate_dynamic_buy_cost(game: GameState, player: Player, card: Card) -> int:
    """Calculate the dynamic buy cost for a card based on its DYNAMIC_BUY_COST effects.

    Returns the adjusted base cost (before turn-based cost reductions).
    """
    base_cost = card.buy_cost if card.buy_cost is not None else 0
    discount = 0

    for effect in card.effects:
        if effect.type != EffectType.DYNAMIC_BUY_COST:
            continue

        if effect.condition == ConditionType.VP_HEXES_CONTROLLED:
            # Elite Vanguard: reduce cost by |value| per VP hex controlled
            if game.grid is not None:
                vp_hex_count = sum(
                    1 for t in game.grid.tiles.values()
                    if t.is_vp and t.owner == player.id
                )
                per_unit = effect.metadata.get("per_unit", False)
                if per_unit:
                    discount += abs(effect.value) * vp_hex_count
                else:
                    discount += abs(effect.value)

        elif effect.condition == ConditionType.TILES_MORE_THAN_DEFENDER:
            # Cheap Shot: reduce cost by 1 if the player controls the most
            # tiles (strictly more than every other player).
            if game.grid is not None:
                player_tile_count = len(game.grid.get_player_tiles(player.id))
                has_most = all(
                    player_tile_count > len(game.grid.get_player_tiles(pid))
                    for pid in game.players
                    if pid != player.id
                )
                if has_most:
                    discount += abs(effect.value)

    return max(0, base_cost - discount)


def _apply_cost_reductions(player: Player, card: Card, base_cost_override: Optional[int] = None) -> int:
    """Apply any active cost reductions to a card purchase. Returns effective cost."""
    base_cost = base_cost_override if base_cost_override is not None else (card.buy_cost if card.buy_cost is not None else 0)
    discount = 0

    reductions_to_remove = []
    for i, reduction in enumerate(player.turn_modifiers.cost_reductions):
        scope = reduction.get("scope", "any_one_card")
        remaining = reduction.get("remaining", 1)

        if remaining <= 0:
            continue

        applies = False
        if scope == "any_one_card":
            applies = True
        elif scope == "next_defense" and card.card_type == CardType.DEFENSE:
            applies = True

        if applies:
            amount = reduction.get("amount", 0)
            if amount == 0:
                # Free (cost becomes 0)
                discount = base_cost
            else:
                discount += amount
            reduction["remaining"] = remaining - 1
            if reduction["remaining"] <= 0:
                reductions_to_remove.append(i)

    # Remove consumed reductions
    for i in sorted(reductions_to_remove, reverse=True):
        player.turn_modifiers.cost_reductions.pop(i)

    return max(0, base_cost - discount)


def _preview_cost_reductions(player: Player, card: Card, base_cost_override: Optional[int] = None) -> int:
    """Preview the effective cost after reductions WITHOUT consuming them."""
    base_cost = base_cost_override if base_cost_override is not None else (card.buy_cost if card.buy_cost is not None else 0)
    discount = 0
    for reduction in player.turn_modifiers.cost_reductions:
        scope = reduction.get("scope", "any_one_card")
        remaining = reduction.get("remaining", 1)
        if remaining <= 0:
            continue
        applies = False
        if scope == "any_one_card":
            applies = True
        elif scope == "next_defense" and card.card_type == CardType.DEFENSE:
            applies = True
        if applies:
            amount = reduction.get("amount", 0)
            if amount == 0:
                discount = base_cost
            else:
                discount += amount
    return max(0, base_cost - discount)


def reroll_market(game: GameState, player_id: str) -> tuple[bool, str]:
    """Re-roll archetype market for 2 resources (once per turn)."""
    if game.current_phase != Phase.BUY:
        return False, "Not in Buy phase"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    if player.has_ended_turn or player_id in game.players_done_buying:
        return False, "Already done buying"

    # Use free rerolls first (from Surveyor), otherwise charge resources
    if player.turn_modifiers.free_rerolls > 0:
        player.turn_modifiers.free_rerolls -= 1
    else:
        if player.resources < REROLL_COST:
            return False, f"Need {REROLL_COST} resources"
        player.resources -= REROLL_COST

    # Shuffle current market back, draw affordable N
    remaining_deck = [c for c in player.archetype_deck if c not in player.archetype_market]
    all_available = remaining_deck + player.archetype_market
    game.rng.shuffle(all_available)
    player.archetype_deck = all_available
    player.archetype_market = _draw_archetype_market(
        all_available, game.archetype_market_size, game.rng, player,
    )

    game._log(f"{player.name} re-rolls archetype market")
    return True, "Market re-rolled"


def end_buy_phase(game: GameState, player_id: str) -> tuple[bool, str]:
    """Player signals they're done buying (concurrent)."""
    if game.current_phase != Phase.BUY:
        return False, "Not in Buy phase"
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.has_ended_turn or player_id in game.players_done_buying:
        return False, "Already done buying"

    player.has_ended_turn = True
    game.players_done_buying.add(player_id)
    game._log(f"{player.name} finishes buying", actor=player_id)

    # Check if all players are done
    all_done = all(
        pid in game.players_done_buying
        for pid in game.player_order
    )
    if all_done:
        game.shared_market.finalize_selling_out()
        execute_end_of_turn(game)

    return True, "Done buying"


def execute_end_of_turn(game: GameState) -> GameState:
    """Phase 5: End of Turn."""
    game.current_phase = Phase.END_OF_TURN
    game._log("=== End of Turn ===")

    for pid in game.player_order:
        player = game.players[pid]
        if player.has_left:
            continue
        # Reset granted_stackable on all cards (Rally Cry is one-turn only)
        for card in player.hand + player.deck.cards + player.deck.discard:
            if card.granted_stackable:
                card.stackable = False
                card.granted_stackable = False
        # Discard remaining hand
        player.deck.add_to_discard(player.hand)
        player.hand = []

    # Decrement global claim ban (Snowy Holiday) at end of turn,
    # after the play phase has enforced the ban for this round.
    if game.claim_ban_rounds > 0:
        game.claim_ban_rounds -= 1

    # Note: turn_modifiers.reset_for_new_turn() is called at START of next turn
    # so that multi-round effects (like Stronghold's 2-round immunity) persist
    # across the end-of-turn boundary.

    # --- VP target check (checked at end of round) ---
    for pid in game.player_order:
        player = game.players[pid]
        if player.has_left:
            continue
        current_vp = compute_player_vp(game, pid)
        if current_vp >= game.vp_target:
            game.winner = pid
            game.winners = [pid]
            game.current_phase = Phase.GAME_OVER
            game._log(f"{player.name} wins with {current_vp} VP!")
            return game

    # --- Round limit check ---
    if game.current_round >= game.max_rounds:
        active_pids = [pid for pid in game.player_order if not game.players[pid].has_left]
        vp_scores = {pid: compute_player_vp(game, pid) for pid in active_pids}
        max_vp = max(vp_scores.values()) if vp_scores else 0
        winners = [pid for pid, vp in vp_scores.items() if vp == max_vp]
        game.winner = winners[0] if winners else None
        game.winners = winners
        game.current_phase = Phase.GAME_OVER
        if len(winners) > 1:
            names = ", ".join(game.players[pid].name for pid in winners)
            game._log(f"Round limit reached ({game.max_rounds} rounds). Tied victory: {names} with {max_vp} VP!")
        elif winners:
            game._log(f"Round limit reached ({game.max_rounds} rounds). {game.players[winners[0]].name} wins with {max_vp} VP!")
        return game

    # Rotate first player (skip left players)
    n = len(game.player_order)
    for _ in range(n):
        game.first_player_index = (game.first_player_index + 1) % n
        fpi_pid = game.player_order[game.first_player_index]
        if not game.players[fpi_pid].has_left:
            break

    # Advance to next round
    game.current_round += 1
    game._log(f"Round {game.current_round} begins")

    # Start next turn
    return execute_start_of_turn(game)


# ── CPU Auto-Play Helpers ────────────────────────────────────────


def auto_play_cpu_plays(game: GameState) -> None:
    """Auto-play play phase for all CPU players who haven't submitted."""
    from .cpu_player import CPUPlayer

    for pid in game.player_order:
        player = game.players[pid]
        if not player.is_cpu or player.has_submitted_play:
            continue

        cpu = CPUPlayer(pid, noise=player.cpu_noise, rng=game.rng)

        # Play cards (same loop pattern as simulation._run_play_phase)
        for _ in range(20):  # safety limit
            action = cpu.pick_next_action(game)
            if action is None:
                break
            success, _msg = play_card(
                game, pid, action["card_index"],
                target_q=action.get("target_q"),
                target_r=action.get("target_r"),
                target_player_id=action.get("target_player_id"),
                discard_card_indices=action.get("discard_card_indices"),
                trash_card_indices=action.get("trash_card_indices"),
                extra_targets=action.get("extra_targets"),
            )
            if not success:
                break
            # Auto-resolve deferred discard for CPU players
            if player.pending_discard > 0:
                discard_indices = cpu._pick_cards_to_discard(player, player.pending_discard)
                submit_pending_discard(game, pid, discard_indices)
            # Auto-resolve deferred search (tutor) for CPU players
            if player.pending_search is not None:
                selections = cpu._pick_search_selections(player, player.pending_search)
                submit_pending_search(game, pid, selections)

        submit_play(game, pid)


def auto_play_cpu_buys(game: GameState) -> None:
    """Auto-play buy phase for all CPU players (concurrent buy mode)."""
    from .cpu_player import CPUPlayer

    if game.current_phase != Phase.BUY:
        return

    for pid in game.player_order:
        player = game.players[pid]
        if not player.is_cpu or player.has_left or pid in game.players_done_buying:
            continue

        cpu = CPUPlayer(pid, noise=player.cpu_noise, rng=game.rng)

        # Reroll market if desirable
        if cpu.should_reroll_market(game):
            reroll_market(game, pid)

        # Buy cards
        for _ in range(10):  # safety limit
            purchase = cpu.pick_next_purchase(game)
            if purchase is None:
                break
            success, _msg = buy_card(
                game, pid, purchase["source"], purchase.get("card_id", ""),
            )
            if not success:
                break

        end_buy_phase(game, pid)
