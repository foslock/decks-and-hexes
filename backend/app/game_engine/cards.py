"""Card definitions and deck management."""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from .effects import Effect


class CardType(str, Enum):
    CLAIM = "claim"
    DEFENSE = "defense"
    ENGINE = "engine"


class Timing(str, Enum):
    IMMEDIATE = "immediate"
    ON_RESOLUTION = "on_resolution"
    NEXT_TURN = "next_turn"


class Archetype(str, Enum):
    VANGUARD = "vanguard"
    SWARM = "swarm"
    FORTRESS = "fortress"
    NEUTRAL = "neutral"


# Action slots per archetype
ARCHETYPE_SLOTS = {
    Archetype.VANGUARD: 4,
    Archetype.SWARM: 4,
    Archetype.FORTRESS: 3,
}

HAND_SIZE = {
    Archetype.VANGUARD: 4,
    Archetype.SWARM: 5,
    Archetype.FORTRESS: 3,
}

ACTION_HARD_CAP = 6


@dataclass
class Card:
    id: str
    name: str
    archetype: Archetype
    card_type: CardType
    power: int = 0
    resource_gain: int = 0
    action_return: int = 0  # 0=standard, 1=net-neutral(↺), 2=net-positive(↑)
    timing: Timing = Timing.IMMEDIATE
    buy_cost: Optional[int] = None
    upgrade_cost: Optional[int] = None
    is_upgraded: bool = False
    starter: bool = False
    trash_on_use: bool = False
    stackable: bool = False
    forced_discard: int = 0
    draw_cards: int = 0
    defense_bonus: int = 0
    adjacency_required: bool = True
    claim_range: int = 1  # max hex distance from owned tiles (1=adjacent, 2=two steps, etc.)
    unoccupied_only: bool = False
    multi_target_count: int = 0  # Surge: max extra targets (0=single, 1=up to 2 total, 2=up to 3)
    flood: bool = False  # Flood: target own tile, claim all adjacent at resolution
    target_own_tile: bool = False  # Must target a tile you own (Flood)
    description: str = ""
    upgrade_description: str = ""
    # Structured effects list (parsed from YAML)
    effects: list[Any] = field(default_factory=list)  # list[Effect]
    # Neutral market copy count
    copies: Optional[int] = None
    # Upgraded stats (applied when is_upgraded=True)
    upgraded_power: Optional[int] = None
    upgraded_resource_gain: Optional[int] = None
    upgraded_action_return: Optional[int] = None
    upgraded_draw_cards: Optional[int] = None
    upgraded_forced_discard: Optional[int] = None
    upgraded_defense_bonus: Optional[int] = None
    upgraded_multi_target_count: Optional[int] = None

    name_upgraded: str = ""

    @property
    def effective_power(self) -> int:
        if self.is_upgraded and self.upgraded_power is not None:
            return self.upgraded_power
        return self.power

    @property
    def effective_resource_gain(self) -> int:
        if self.is_upgraded and self.upgraded_resource_gain is not None:
            return self.upgraded_resource_gain
        return self.resource_gain

    @property
    def effective_action_return(self) -> int:
        if self.is_upgraded and self.upgraded_action_return is not None:
            return self.upgraded_action_return
        return self.action_return

    @property
    def effective_draw_cards(self) -> int:
        if self.is_upgraded and self.upgraded_draw_cards is not None:
            return self.upgraded_draw_cards
        return self.draw_cards

    @property
    def effective_defense_bonus(self) -> int:
        if self.is_upgraded and self.upgraded_defense_bonus is not None:
            return self.upgraded_defense_bonus
        return self.defense_bonus

    @property
    def effective_multi_target_count(self) -> int:
        if self.is_upgraded and self.upgraded_multi_target_count is not None:
            return self.upgraded_multi_target_count
        return self.multi_target_count

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "archetype": self.archetype.value,
            "card_type": self.card_type.value,
            "power": self.effective_power,
            "resource_gain": self.effective_resource_gain,
            "action_return": self.effective_action_return,
            "timing": self.timing.value,
            "buy_cost": self.buy_cost,
            "is_upgraded": self.is_upgraded,
            "trash_on_use": self.trash_on_use,
            "stackable": self.stackable,
            "forced_discard": self.forced_discard,
            "draw_cards": self.effective_draw_cards,
            "defense_bonus": self.effective_defense_bonus,
            "adjacency_required": self.adjacency_required,
            "claim_range": self.claim_range,
            "unoccupied_only": self.unoccupied_only,
            "multi_target_count": self.effective_multi_target_count,
            "flood": self.flood,
            "target_own_tile": self.target_own_tile,
            "description": self.description,
            "upgrade_description": self.upgrade_description,
            "name_upgraded": self.name_upgraded,
            "starter": self.starter,
            "effects": [e.to_dict() for e in self.effects if hasattr(e, 'to_dict')],
            **self._upgraded_stats_dict(),
        }

    def _upgraded_stats_dict(self) -> dict[str, Any]:
        """Return upgraded_stats for frontend preview (only when not already upgraded)."""
        if self.is_upgraded:
            return {}
        upgraded: dict[str, Any] = {}
        if self.upgraded_power is not None:
            upgraded["power"] = self.upgraded_power
        if self.upgraded_resource_gain is not None:
            upgraded["resource_gain"] = self.upgraded_resource_gain
        if self.upgraded_action_return is not None:
            upgraded["action_return"] = self.upgraded_action_return
        if self.upgraded_draw_cards is not None:
            upgraded["draw_cards"] = self.upgraded_draw_cards
        if self.upgraded_forced_discard is not None:
            upgraded["forced_discard"] = self.upgraded_forced_discard
        if self.upgraded_defense_bonus is not None:
            upgraded["defense_bonus"] = self.upgraded_defense_bonus
        if self.upgraded_multi_target_count is not None:
            upgraded["multi_target_count"] = self.upgraded_multi_target_count
        if upgraded:
            return {"upgraded_stats": upgraded}
        return {}


@dataclass
class Deck:
    cards: list[Card] = field(default_factory=list)
    discard: list[Card] = field(default_factory=list)

    def shuffle(self, rng: Optional[random.Random] = None) -> None:
        r = rng or random.Random()
        r.shuffle(self.cards)

    def draw(self, count: int, rng: Optional[random.Random] = None) -> list[Card]:
        drawn = []
        for _ in range(count):
            if not self.cards:
                if not self.discard:
                    break
                self.cards = self.discard
                self.discard = []
                self.shuffle(rng)
            if self.cards:
                drawn.append(self.cards.pop(0))
        return drawn

    def add_to_discard(self, cards: list[Card]) -> None:
        self.discard.extend(cards)

    def add_to_top(self, card: Card) -> None:
        self.cards.insert(0, card)

    @property
    def total_cards(self) -> int:
        return len(self.cards) + len(self.discard)


def build_starting_deck(archetype: Archetype, card_registry: dict[str, Card]) -> Deck:
    """Build a starting deck for the given archetype."""
    cards = []

    if archetype == Archetype.VANGUARD:
        # 2× Blitz, 4× Explore, 2× Gather = 8 cards
        blitz = card_registry.get("vanguard_blitz")
        if blitz:
            cards.extend([_copy_card(blitz, f"start_{i}") for i in range(2)])
        advance = card_registry.get("neutral_explore")
        if advance:
            cards.extend([_copy_card(advance, f"start_adv_{i}") for i in range(4)])
        gather = card_registry.get("neutral_gather")
        if gather:
            cards.extend([_copy_card(gather, f"start_gat_{i}") for i in range(2)])

    elif archetype == Archetype.SWARM:
        # 2× Scout, 1× Swarm Tactics, 5× Explore, 2× Gather = 10 cards
        scout = card_registry.get("swarm_scout")
        if scout:
            cards.extend([_copy_card(scout, f"start_{i}") for i in range(2)])
        tactics = card_registry.get("swarm_swarm_tactics")
        if tactics:
            cards.append(_copy_card(tactics, "start_tac"))
        advance = card_registry.get("neutral_explore")
        if advance:
            cards.extend([_copy_card(advance, f"start_adv_{i}") for i in range(5)])
        gather = card_registry.get("neutral_gather")
        if gather:
            cards.extend([_copy_card(gather, f"start_gat_{i}") for i in range(2)])

    elif archetype == Archetype.FORTRESS:
        # 1× Garrison, 1× Fortify, 2× Explore, 2× Gather = 6 cards
        garrison = card_registry.get("fortress_garrison")
        if garrison:
            cards.append(_copy_card(garrison, "start_gar"))
        fortify = card_registry.get("fortress_fortify")
        if fortify:
            cards.append(_copy_card(fortify, "start_fort"))
        advance = card_registry.get("neutral_explore")
        if advance:
            cards.extend([_copy_card(advance, f"start_adv_{i}") for i in range(2)])
        gather = card_registry.get("neutral_gather")
        if gather:
            cards.extend([_copy_card(gather, f"start_gat_{i}") for i in range(2)])

    deck = Deck(cards=cards)
    return deck


def _copy_card(card: Card, instance_id: str) -> Card:
    """Create a copy of a card with a unique instance ID."""
    import copy
    c = copy.deepcopy(card)
    c.id = f"{card.id}_{instance_id}"
    return c
