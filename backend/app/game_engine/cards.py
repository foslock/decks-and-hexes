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
    PASSIVE = "passive"  # Unplayable cards that sit in deck (Rubble, Spoils, Land Grant, etc.)


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
    Archetype.VANGUARD: 3,
    Archetype.SWARM: 3,
    Archetype.FORTRESS: 3,
}

HAND_SIZE = {
    Archetype.VANGUARD: 5,
    Archetype.SWARM: 5,
    Archetype.FORTRESS: 5,
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
    defense_target_count: int = 1  # Defense: number of tiles to apply defense to (default 1)
    flood: bool = False  # Flood: target own tile, claim all adjacent at resolution
    target_own_tile: bool = False  # Must target a tile you own (Flood)
    unplayable: bool = False  # Cannot be played from hand (e.g. Land Grant — dead weight)
    passive_vp: int = 0  # VP awarded on purchase (card stays in deck)
    vp_formula: str = ""  # Dynamic VP formula: "trash_div_5", "fortified_tiles_3", "deck_div_10"
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
    upgraded_defense_target_count: Optional[int] = None
    upgraded_unoccupied_only: Optional[bool] = None

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

    @property
    def effective_defense_target_count(self) -> int:
        if self.is_upgraded and self.upgraded_defense_target_count is not None:
            return self.upgraded_defense_target_count
        return self.defense_target_count

    @property
    def effective_unoccupied_only(self) -> bool:
        if self.is_upgraded and self.upgraded_unoccupied_only is not None:
            return self.upgraded_unoccupied_only
        return self.unoccupied_only

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
            "unoccupied_only": self.effective_unoccupied_only,
            "multi_target_count": self.effective_multi_target_count,
            "defense_target_count": self.effective_defense_target_count,
            "flood": self.flood,
            "target_own_tile": self.target_own_tile,
            "unplayable": self.unplayable,
            "passive_vp": self.passive_vp,
            "vp_formula": self.vp_formula,
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
        if self.upgraded_defense_target_count is not None:
            upgraded["defense_target_count"] = self.upgraded_defense_target_count
        if upgraded:
            return {"upgraded_stats": upgraded}
        return {}


_land_grant_counter = 0


def make_land_grant_card() -> Card:
    """Create a Land Grant card (generated by Diplomacy effect)."""
    global _land_grant_counter
    _land_grant_counter += 1
    return Card(
        id=f"land_grant_{_land_grant_counter}",
        name="Land Grant",
        archetype=Archetype.NEUTRAL,
        card_type=CardType.PASSIVE,
        passive_vp=1,
        unplayable=True,
        description="Worth 1 VP.",
    )


_rubble_counter = 0


def make_rubble_card() -> Card:
    """Create a Rubble card (generated when a base is raided)."""
    global _rubble_counter
    _rubble_counter += 1
    return Card(
        id=f"rubble_{_rubble_counter}",
        name="Rubble",
        archetype=Archetype.NEUTRAL,
        card_type=CardType.PASSIVE,
        passive_vp=-1,
        unplayable=True,
        description="Dead weight from a base raid. -1 VP per copy.",
    )


_spoils_counter = 0


def make_spoils_card() -> Card:
    """Create a Spoils card (awarded to attacker on successful base raid)."""
    global _spoils_counter
    _spoils_counter += 1
    return Card(
        id=f"spoils_{_spoils_counter}",
        name="Spoils",
        archetype=Archetype.NEUTRAL,
        card_type=CardType.PASSIVE,
        passive_vp=1,
        unplayable=True,
        description="Spoils of a successful base raid. +1 VP per copy.",
    )


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


STARTER_CARD_IDS = {
    Archetype.VANGUARD: "vanguard_war_chest",
    Archetype.SWARM: "swarm_scout",
    Archetype.FORTRESS: "fortress_bunker",
}


# Starting deck composition per archetype: (explores, gathers)
# All archetypes get 2× archetype starter, total = explores + gathers + 2 = 10
STARTER_DECK_COMPOSITION: dict[Archetype, tuple[int, int]] = {
    Archetype.VANGUARD: (4, 4),   # balanced
    Archetype.SWARM: (5, 3),      # more explores → faster expansion
    Archetype.FORTRESS: (3, 5),   # more gathers → more resources for defense
}


def build_starting_deck(archetype: Archetype, card_registry: dict[str, Card]) -> Deck:
    """Build a starting deck for the given archetype.

    Swarm:    5× Explore, 3× Gather, 2× Scout     = 10 cards
    Vanguard: 4× Explore, 4× Gather, 2× War Chest = 10 cards
    Fortress: 3× Explore, 5× Gather, 2× Bunker    = 10 cards
    """
    cards = []
    num_explores, num_gathers = STARTER_DECK_COMPOSITION.get(archetype, (4, 4))

    # 2× archetype-specific starter card
    starter_id = STARTER_CARD_IDS.get(archetype)
    if starter_id:
        starter = card_registry.get(starter_id)
        if starter:
            cards.extend([_copy_card(starter, f"start_{i}") for i in range(2)])

    # Explores
    explore = card_registry.get("neutral_explore")
    if explore:
        cards.extend([_copy_card(explore, f"start_adv_{i}") for i in range(num_explores)])

    # Gathers
    gather = card_registry.get("neutral_gather")
    if gather:
        cards.extend([_copy_card(gather, f"start_gat_{i}") for i in range(num_gathers)])

    deck = Deck(cards=cards)
    return deck


def _copy_card(card: Card, instance_id: str) -> Card:
    """Create a copy of a card with a unique instance ID."""
    import copy
    c = copy.deepcopy(card)
    c.id = f"{card.id}_{instance_id}"
    return c
