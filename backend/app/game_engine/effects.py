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
    GRANT_ACTIONS = "grant_actions"        # Forced March, Surge Protocol

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

    # Dynamic buy cost (resolved at purchase time, not play time)
    DYNAMIC_BUY_COST = "dynamic_buy_cost"

    # VP-generating effects (archetype-specific VP cards)
    VP_FROM_TILES = "vp_from_tiles"                    # Territorial Dominance
    VP_FROM_TILE_SACRIFICE = "vp_from_tile_sacrifice"  # Scorched Earth
    VP_FROM_DEFENSE = "vp_from_defense"                # Fortified Position
    VP_FOR_ALL = "vp_for_all"                          # Diplomacy
    VP_FROM_CONTESTED_WINS = "vp_from_contested_wins"  # Battle Glory
    VP_FROM_TRASH_CLAIMS = "vp_from_trash_claims"      # Sacrifice for Glory


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


@dataclass
class Effect:
    """A single effect/keyword on a card.

    Effects are composable — a card can have multiple effects that fire
    at different timings and under different conditions.
    """

    type: EffectType
    value: int = 0
    timing: Timing = Timing.IMMEDIATE
    condition: ConditionType = ConditionType.ALWAYS
    condition_threshold: int = 0
    target: str = "self"       # "self", "opponent", "all_others", "chosen_player"
    duration: int = 1          # for tile_immunity (1 or 2 rounds)
    requires_choice: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
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
    # Track cards with ignore_defense flag (tile_key set)
    ignore_defense_tiles: set[str] = field(default_factory=set)
    # Track claims that resolve immediately (tile_key set)
    immediate_resolve_tiles: set[str] = field(default_factory=set)
    # Cease Fire: pending bonus draws (granted if no opponent tiles claimed)
    cease_fire_bonus: int = 0

    def reset_for_new_turn(self) -> None:
        """Clear single-round modifiers. Decrement multi-round ones."""
        self.buy_locked = False
        self.cost_reductions.clear()
        self.ignore_defense_tiles.clear()
        self.immediate_resolve_tiles.clear()
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

    return Effect(
        type=effect_type,
        value=int(data.get("value", 0)),
        timing=timing,
        condition=condition,
        condition_threshold=int(data.get("condition_threshold", 0)),
        target=str(data.get("target", "self")),
        duration=int(data.get("duration", 1)),
        requires_choice=bool(data.get("requires_choice", False)),
        metadata=dict(data.get("metadata", {})),
    )
