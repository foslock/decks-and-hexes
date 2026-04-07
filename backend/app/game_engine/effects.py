"""Effect system for card keywords and abilities.

Each card can have a list of Effect objects that describe its abilities.
Effects are resolved by the effect_resolver module at the appropriate timing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .cards import Timing


class EffectType(str, Enum):
    """All supported card effect keywords."""

    # Resource / card flow
    GAIN_RESOURCES = "gain_resources"
    DRAW_CARDS = "draw_cards"
    GAIN_VP = "gain_vp"

    # Self-targeting hand manipulation (player chooses)
    SELF_DISCARD = "self_discard"
    SELF_TRASH = "self_trash"
    TRASH_GAIN_BUY_COST = "trash_gain_buy_cost"  # Consolidate: trash + gain buy cost

    # Opponent-targeting
    FORCED_DISCARD = "forced_discard"

    # Conditional power modifiers
    POWER_MODIFIER = "power_modifier"

    # Defense / tile protection
    DEFENSE_BONUS = "defense_bonus"
    TILE_IMMUNITY = "tile_immunity"        # Iron Wall, Stronghold
    IGNORE_DEFENSE = "ignore_defense"      # Siege Engine

    # Action manipulation
    ACTION_RETURN = "action_return"
    GRANT_ACTIONS = "grant_actions"        # Surge Protocol
    GRANT_ACTIONS_NEXT_TURN = "grant_actions_next_turn"  # Forced March

    # On-success effects (after claim resolution)
    AUTO_CLAIM_ADJACENT_NEUTRAL = "auto_claim_adjacent_neutral"  # Breakthrough
    DRAW_NEXT_TURN = "draw_next_turn"      # Blitz secondary
    CONTEST_COST = "contest_cost"          # Rapid Assault
    RESOURCE_REFUND_IF_NEUTRAL = "resource_refund_if_neutral"  # Overwhelming Force

    # On-failure effects
    ON_DEFEND_FORCED_DISCARD = "on_defend_forced_discard"  # War of Attrition

    # Auto-claim
    AUTO_CLAIM_IF_NEUTRAL = "auto_claim_if_neutral"  # Slow Advance

    # Immediate resolve (skip reveal phase)
    IMMEDIATE_RESOLVE = "immediate_resolve"  # Spearhead

    # Buy phase modifiers
    BUY_RESTRICTION = "buy_restriction"    # Blitz Rush
    COST_REDUCTION = "cost_reduction"      # Supply Line, Tactical Reserve

    # Stacking / combo effects
    GRANT_STACKABLE = "grant_stackable"                # Rally Cry
    STACKING_POWER_BONUS = "stacking_power_bonus"      # Dog Pile
    CONDITIONAL_ACTION_RETURN = "conditional_action_return"  # Rabble

    # Conditional draw effects
    CEASE_FIRE = "cease_fire"
    ADJACENCY_BRIDGE = "adjacency_bridge"
    DECK_PEEK = "deck_peek"

    # Trash opponent's card on successful claim
    TRASH_OPPONENT_CARD = "trash_opponent_card"

    # Permanent defense (Entrench — persists until tile is captured)
    PERMANENT_DEFENSE = "permanent_defense"

    # Free archetype market re-rolls
    FREE_REROLL = "free_reroll"              # Surveyor: free market re-rolls this turn

    # Resource drain (opponent loses resources)
    RESOURCE_DRAIN = "resource_drain"        # Rapid Assault: opponent loses resources on success

    # Dynamic buy cost (resolved at purchase time, not play time)
    DYNAMIC_BUY_COST = "dynamic_buy_cost"

    # Defense scaled by adjacent owned tiles (Nest)
    DEFENSE_PER_ADJACENT = "defense_per_adjacent"

    # Power scaled by total tiles owned (Mob Rule, Locust Swarm)
    POWER_PER_TILES_OWNED = "power_per_tiles_owned"

    # Override ignore-defense effects on a tile
    IGNORE_DEFENSE_OVERRIDE = "ignore_defense_override"

    # VP-related effects (derived VP system)
    ENHANCE_VP_TILE = "enhance_vp_tile"                # Consecrate: +1 vp_value on a VP tile
    GRANT_LAND_GRANTS = "grant_land_grants"            # Diplomacy: all players get a Land Grant
    VP_FROM_CONTESTED_WINS = "vp_from_contested_wins"  # Battle Glory: +1 passive_vp on card per trigger
    VP_FROM_DISCONNECTED_GROUPS = "vp_from_disconnected_groups"  # Colony: VP per disconnected group
    VP_FROM_UNCAPTURED_TILES = "vp_from_uncaptured_tiles"        # Warden: VP per pristine tiles

    # Conditional resource gain
    RESOURCES_PER_CLAIMS_LAST_ROUND = "resources_per_claims_last_round"  # War Tithe

    # Draw based on connected VP hexes
    DRAW_PER_CONNECTED_VP = "draw_per_connected_vp"      # Toll Road: draw 2 per connected VP hex

    # ── New synergy card effects ──────────────────────────────────
    CONDITIONAL_ACTION = "conditional_action"          # Spyglass: gain action if hand_size <= threshold
    RESOURCE_SCALING = "resource_scaling"              # Dividends: gain res per N resources held
    CYCLE = "cycle"                                    # Cartographer: discard N, draw N
    RESOURCE_PER_VP_HEX = "resource_per_vp_hex"       # Tax Collector: gain res per VP hex controlled
    RESOURCES_PER_TILES_LOST = "resources_per_tiles_lost"  # Robin Hood: gain res per tile lost last turn

    # ── Medium-complexity effects ─────────────────────────────────
    ACTIONS_PER_CARDS_PLAYED = "actions_per_cards_played"  # Mobilize: gain 1 action per card played (max N)
    NEXT_TURN_BONUS = "next_turn_bonus"                    # Supply Depot: next turn +draw, +resource, (+action upgraded)
    MULLIGAN = "mulligan"                                  # Mulligan: discard entire hand, redraw same count (+1 upgraded)
    INJECT_RUBBLE = "inject_rubble"                        # Infestation: add N Rubble to opponent's discard

    # ── Complex effects ──────────────────────────────────────────
    GLOBAL_CLAIM_BAN = "global_claim_ban"                  # Snowy Holiday: no claims next round
    GLOBAL_RANDOM_TRASH = "global_random_trash"            # Plague: all players trash random card from hand
    SWAP_DRAW_DISCARD = "swap_draw_discard"                # Heady Brew: swap draw and discard piles
    ABANDON_TILE = "abandon_tile"                          # Exodus: give up a tile you own
    ABANDON_AND_BLOCK = "abandon_and_block"                # Scorched Retreat: give up tile, make it blocked
    MANDATORY_SELF_TRASH = "mandatory_self_trash"          # Demon Pact: trash exactly N cards (required)


class ConditionType(str, Enum):
    """Conditions that gate whether an effect fires."""

    ALWAYS = "always"
    IF_PLAYED_CLAIM_THIS_TURN = "if_played_claim_this_turn"
    IF_ADJACENT_OWNED_GTE = "if_adjacent_owned_gte"
    CARDS_IN_HAND = "cards_in_hand"
    IF_DEFENDING_OWNED = "if_defending_owned"
    IF_TARGET_NEUTRAL = "if_target_neutral"
    IF_SUCCESSFUL = "if_successful"
    IF_DEFENDER_HOLDS = "if_defender_holds"
    IF_PLAYED_SAME_NAME = "if_played_same_name"
    TILES_MORE_THAN_DEFENDER = "tiles_more_than_defender"
    VP_HEXES_CONTROLLED = "vp_hexes_controlled"
    FEWEST_TILES = "fewest_tiles"
    ZERO_ACTIONS = "zero_actions"
    IF_TARGET_HAS_DEFENSE = "if_target_has_defense"
    IF_CONTESTED = "if_contested"                    # Ambush: target tile also claimed by opponent
    HAND_SIZE_LTE = "hand_size_lte"                  # Spyglass: hand size <= threshold after draw


@dataclass
class Effect:
    """A single effect/keyword on a card.

    Effects are composable — a card can have multiple effects that fire
    at different timings and under different conditions.
    """

    type: EffectType
    value: int = 0
    upgraded_value: Optional[int] = None  # if set, used when card is upgraded
    timing: Timing = Timing.IMMEDIATE
    condition: ConditionType = ConditionType.ALWAYS
    condition_threshold: int = 0
    target: str = "self"       # "self", "opponent", "all_others", "chosen_player"
    duration: int = 1          # for tile_immunity (1 or 2 rounds)
    requires_choice: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def effective_value(self, is_upgraded: bool) -> int:
        """Return upgraded_value when card is upgraded and value is overridden."""
        if is_upgraded and self.upgraded_value is not None:
            return self.upgraded_value
        return self.value

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "type": self.type.value,
            "value": self.value,
            "timing": self.timing.value,
            "condition": self.condition.value,
            "condition_threshold": self.condition_threshold,
            "target": self.target,
            "duration": self.duration,
            "requires_choice": self.requires_choice,
            "metadata": self.metadata,
        }
        if self.upgraded_value is not None:
            d["upgraded_value"] = self.upgraded_value
        return d


@dataclass
class TurnModifiers:
    """Ephemeral per-turn state modifications from card effects.

    Cleared at end of turn (or decremented for multi-round effects).
    """

    buy_locked: bool = False
    cost_reductions: list[dict[str, Any]] = field(default_factory=list)
    # tile_key -> rounds remaining (1 = this round only, 2 = this + next)
    immune_tiles: dict[str, int] = field(default_factory=dict)
    # tile_key -> resource cost for opponents to contest next round
    contest_costs: dict[str, int] = field(default_factory=dict)
    extra_draws_next_turn: int = 0
    extra_actions_next_turn: int = 0
    extra_resources_next_turn: int = 0
    free_rerolls: int = 0
    # Track cards with ignore_defense flag (tile_key set)
    ignore_defense_tiles: set[str] = field(default_factory=set)
    # Track claims that resolve immediately (tile_key set)
    immediate_resolve_tiles: set[str] = field(default_factory=set)
    # Cease Fire: pending bonus draws (granted if no opponent tiles claimed)
    cease_fire_bonus: int = 0
    # Tiles where ignore-defense is overridden (tile_key set)
    ignore_defense_override_tiles: set[str] = field(default_factory=set)
    # Plague: number of random cards to trash from hand at start of next turn
    plague_trash_next_turn: int = 0

    def reset_for_new_turn(self) -> None:
        """Clear single-round modifiers. Decrement multi-round ones."""
        self.buy_locked = False
        self.cost_reductions.clear()
        self.ignore_defense_tiles.clear()
        self.immediate_resolve_tiles.clear()
        self.ignore_defense_override_tiles.clear()
        # Decrement immune tiles; remove expired
        expired = []
        for tile_key, rounds in self.immune_tiles.items():
            if rounds <= 1:
                expired.append(tile_key)
            else:
                self.immune_tiles[tile_key] = rounds - 1
        for key in expired:
            del self.immune_tiles[key]
        # Contest costs last only one round
        self.contest_costs.clear()
        # Cease fire bonus is resolved during reveal, reset after
        self.cease_fire_bonus = 0


def parse_effect(data: dict[str, Any]) -> Optional[Effect]:
    """Parse an effect dict from YAML into an Effect object."""
    type_str = data.get("type")
    if not type_str:
        return None

    try:
        effect_type = EffectType(type_str)
    except ValueError:
        return None

    timing_str = str(data.get("timing", "immediate")).lower()
    if "resolution" in timing_str:
        timing = Timing.ON_RESOLUTION
    elif "next" in timing_str:
        timing = Timing.NEXT_TURN
    else:
        timing = Timing.IMMEDIATE

    condition_str = str(data.get("condition", "always")).lower()
    try:
        condition = ConditionType(condition_str)
    except ValueError:
        condition = ConditionType.ALWAYS

    raw_upgraded = data.get("upgraded_value")
    upgraded_value = int(raw_upgraded) if raw_upgraded is not None else None

    return Effect(
        type=effect_type,
        value=int(data.get("value", 0)),
        upgraded_value=upgraded_value,
        timing=timing,
        condition=condition,
        condition_threshold=int(data.get("condition_threshold", 0)),
        target=str(data.get("target", "self")),
        duration=int(data.get("duration", 1)),
        requires_choice=bool(data.get("requires_choice", False)),
        metadata=dict(data.get("metadata", {})),
    )
