"""Card packs: the cards a game is played with.

A pack is like a Dominion kingdom: 5 shared market cards plus 5 cards from
each archetype, so every player has exactly 10 cards to buy all game — the
same 10 every round. The packs draw on the Core set (cards marked
``set: core`` in data/cards_*.yaml; tests check the two match). Within a pack
no player sees two cards that do the same job (two one-tile defenses, two
permanent defenses, two resource cantrips…).

"Everything" puts every card on the table and is for testing only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from app.game_engine.cards import Card

SHARED_PER_PACK = 5
ARCHETYPE_PER_PACK = 5


@dataclass
class CardPack:
    """A named selection of cards available for a game session.

    - shared_card_ids: the pack's shared market cards, or None for all.
    - archetype_card_ids: per-archetype card ids (keys are archetype names,
      e.g. "vanguard"), or None for all.
    """
    id: str
    name: str
    shared_card_ids: Optional[list[str]] = None
    archetype_card_ids: Optional[dict[str, list[str]]] = None
    # One-line, player-facing summary shown in the lobby's pack picker.
    description: str = ""
    # Not a real way to play (Everything): listed last, labelled for testing.
    testing_only: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "testing_only": self.testing_only,
            "shared_card_ids": self.shared_card_ids,
            "archetype_card_ids": self.archetype_card_ids,
        }


# Listed in this order in the lobby.
CARD_PACKS: dict[str, CardPack] = {
    "first_clash": CardPack(
        id="first_clash",
        name="First Clash",
        description="Start here: the tutorial's cards and plain, simple archetype cards.",
        shared_card_ids=[
            "neutral_recruit",         # Levy
            "neutral_watchtower",      # Watchtower
            "neutral_fortified_post",  # Barricade
            "neutral_mercenary",       # Mercenary
            "neutral_siege_tower",     # Siege Tower
        ],
        archetype_card_ids={
            "vanguard": [
                "vanguard_blitz",
                "vanguard_strike_team",
                "vanguard_rapid_assault",
                "vanguard_war_cache",      # Plunder
                "vanguard_double_time",
            ],
            "swarm": [
                "swarm_surge",
                "swarm_overwhelm",
                "swarm_rabble",
                "swarm_swarm_tactics",
                "swarm_drone_wave",
            ],
            "fortress": [
                "fortress_slow_advance",   # Mountaineer
                "fortress_siege_engine",
                "fortress_garrison",
                "fortress_iron_wall",
                "fortress_iron_discipline",
            ],
        },
    ),
    "border_war": CardPack(
        id="border_war",
        name="Border War",
        description="Fight for the middle: ambushes, stacked assaults and payback.",
        shared_card_ids=[
            "neutral_ambush",
            "neutral_prospector",
            "neutral_conscription",    # Muster
            "neutral_rally_cry",
            "neutral_watchtower",
        ],
        archetype_card_ids={
            "vanguard": [
                "vanguard_strike_team",
                "vanguard_rapid_assault",
                "vanguard_blitz",
                "vanguard_battle_glory",
                "vanguard_spearhead",
            ],
            "swarm": [
                "swarm_dog_pile",
                "swarm_rabble",
                "swarm_hatching_grounds",
                "swarm_safety_in_numbers",  # Phalanx
                "swarm_scavenge",
            ],
            "fortress": [
                "fortress_garrison",
                "fortress_overwhelming_force",  # Juggernaut
                "fortress_war_of_attrition",    # Attrition
                "fortress_supply_line",
                "fortress_iron_wall",
            ],
        },
    ),
    "deep_roots": CardPack(
        id="deep_roots",
        name="Deep Roots",
        description="Grow an engine: thin your deck, draw deep and buy victory.",
        shared_card_ids=[
            "neutral_war_bonds",       # Tithe
            "neutral_reduce",          # Cull
            "neutral_salvage",
            "neutral_land_grant",
            "neutral_tax_collector",
        ],
        archetype_card_ids={
            "vanguard": [
                "vanguard_elite_vanguard",
                "vanguard_arsenal",
                "vanguard_strike_team",
                "vanguard_blitz",
                "vanguard_double_time",
            ],
            "swarm": [
                "swarm_dog_pile",
                "swarm_overwhelm",
                "swarm_surge",
                "swarm_drone_wave",
                "swarm_colony",
            ],
            "fortress": [
                "fortress_toll_road",
                "fortress_warden",
                "fortress_iron_wall",
                "fortress_garrison",
                "fortress_siege_engine",
            ],
        },
    ),
    "far_reaches": CardPack(
        id="far_reaches",
        name="Far Reaches",
        description="Spread out fast: strike from afar and link up your lands.",
        shared_card_ids=[
            "neutral_road_builder",
            "neutral_tax_collector",
            "neutral_fortified_post",  # Barricade
            "neutral_conscription",    # Muster
            "neutral_mercenary",
        ],
        archetype_card_ids={
            "vanguard": [
                "vanguard_overrun",
                "vanguard_breakthrough",
                "vanguard_war_cache",      # Plunder
                "vanguard_blitz",
                "vanguard_rearguard",
            ],
            "swarm": [
                "swarm_proliferate",
                "swarm_exodus",
                "swarm_overwhelm",
                "swarm_surge",
                "swarm_dog_pile",
            ],
            "fortress": [
                "fortress_scorched_retreat",
                "fortress_overwhelming_force",  # Juggernaut
                "fortress_slow_advance",        # Mountaineer
                "fortress_siege_engine",
                "fortress_supply_line",
            ],
        },
    ),
    "everything": CardPack(
        id="everything",
        name="Everything",
        description="Every card in the game at once — for testing, not a real way to play.",
        testing_only=True,
    ),
}

DEFAULT_PACK_ID = "first_clash"


def pack_display_name(pack_id: str) -> str:
    """Display name for a pack id."""
    pack = CARD_PACKS.get(pack_id)
    return pack.name if pack else pack_id


def get_pack(pack_id: str, card_registry: dict[str, Card] | None = None) -> CardPack:
    """Return the pack for the given ID; unknown ids (e.g. packs retired since
    a game was saved) play as Everything."""
    return CARD_PACKS.get(pack_id, CARD_PACKS["everything"])
