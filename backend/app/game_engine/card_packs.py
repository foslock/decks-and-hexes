"""Card Pack definitions for filtering available cards per game session."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class CardPack:
    """A named selection of cards available for a game session.

    - neutral_card_ids: list of neutral card IDs to include, or None for all.
    - archetype_card_ids: per-archetype card ID lists, or None for all.
      Keys are archetype names (e.g. "vanguard"), values are lists of card IDs.
    - starter_overrides: reserved for future packs that change starting decks.
      None means use the default starter composition from cards.py.
    """
    id: str
    name: str
    neutral_card_ids: Optional[list[str]] = None
    archetype_card_ids: Optional[dict[str, list[str]]] = None
    starter_overrides: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "neutral_card_ids": self.neutral_card_ids,
            "archetype_card_ids": self.archetype_card_ids,
        }


CARD_PACKS: dict[str, CardPack] = {
    "everything": CardPack(
        id="everything",
        name="Everything",
        neutral_card_ids=None,
        archetype_card_ids=None,
    ),
    "iron_and_coin": CardPack(
        id="iron_and_coin",
        name="Iron & Coin",
        neutral_card_ids=[
            "neutral_reduce",
            "neutral_prospector",
            "neutral_war_bonds",
            "neutral_recruit",
            "neutral_conscription",
            "neutral_mercenary",
            "neutral_militia",
            "neutral_forced_march",
            "neutral_siege_tower",
            "neutral_rally_cry",
        ],
        archetype_card_ids={
            # Military aggression + economic power
            "vanguard": [
                "vanguard_blitz",              # cheap aggression, draws on success
                "vanguard_overrun",            # high power, extended range
                "vanguard_strike_team",        # combo power scaling
                "vanguard_rapid_assault",      # resource drain on opponent
                "vanguard_spearhead",          # high-power nuke
                "vanguard_coordinated_push",   # stackable aggression
                "vanguard_elite_vanguard",     # expensive powerhouse
                "vanguard_spoils_of_war",      # trashes opponent's card
                "vanguard_war_cache",          # economy + action engine
                "vanguard_counterattack",      # defensive draw engine
                "vanguard_war_tithe",          # resources from last round's claims
            ],
            "swarm": [
                "swarm_surge",                 # multi-target aggression
                "swarm_overwhelm",             # adjacency power scaling
                "swarm_dog_pile",              # stackable, buffs other claims
                "swarm_mob_rule",              # power from tile count
                "swarm_rabble",                # cheap spam
                "swarm_numbers_game",          # hand-size power
                "swarm_locust_swarm",          # tile-count nuke
                "swarm_frenzy",                # actions engine
                "swarm_scavenge",              # economy fallback
                "swarm_swarm_tactics",         # draw + action engine
            ],
            "fortress": [
                "fortress_siege_engine",       # ignores defense
                "fortress_garrison",           # defensive power boost
                "fortress_battering_ram",      # anti-defense powerhouse
                "fortress_overwhelming_force", # stackable, resource gain
                "fortress_war_of_attrition",   # forced discard on defend
                "fortress_supply_line",        # economy + action
                "fortress_iron_discipline",    # economy + draw
                "fortress_consolidate",        # trash for resources
                "fortress_fortify",            # defense + action
                "fortress_iron_wall",          # tile immunity
            ],
        },
    ),
    "frontier_tactics": CardPack(
        id="frontier_tactics",
        name="Frontier Tactics",
        neutral_card_ids=[
            "neutral_reduce",
            "neutral_road_builder",
            "neutral_surveyor",
            "neutral_reclaim",
            "neutral_fortified_post",
            "neutral_watchtower",
            "neutral_diplomat",
            "neutral_cease_fire",
            "neutral_land_grant",
            "neutral_eminent_domain",
        ],
        archetype_card_ids={
            # Territorial expansion + infrastructure building
            "vanguard": [
                "vanguard_forward_march",      # neutral tile expansion
                "vanguard_breakthrough",       # auto-claims adjacent neutral
                "vanguard_blitz",              # cheap expansion, draws
                "vanguard_flanking_strike",    # extended range reach
                "vanguard_double_time",        # draw + actions engine
                "vanguard_rally",              # draw cycling engine
                "vanguard_war_cache",          # economy + future draw
                "vanguard_rearguard",          # defense + economy
                "vanguard_battle_glory",       # VP from contested wins
                "vanguard_arsenal",            # VP from deck size
                "vanguard_war_tithe",          # resources from last round's claims
            ],
            "swarm": [
                "swarm_surge",                 # multi-target expansion
                "swarm_proliferate",           # any neutral tile, ignores adjacency
                "swarm_flood",                 # claims all adjacent
                "swarm_hive_mind",             # mass multi-target expansion
                "swarm_overwhelm",             # adjacency power scaling
                "swarm_swarm_tactics",         # draw + action engine
                "swarm_thin_the_herd",         # deck thinning
                "swarm_consecrate",            # enhance VP tile value
                "swarm_nest",                  # adjacency defense
                "swarm_war_trophies",          # VP from trashed cards
                "swarm_colony",               # VP from disconnected groups
            ],
            "fortress": [
                "fortress_slow_advance",       # auto-claim neutrals
                "fortress_garrison",           # defensive power
                "fortress_entrench",           # permanent defense
                "fortress_fortify",            # defense + action
                "fortress_bulwark",            # multi-tile defense
                "fortress_stronghold",         # tile immunity 2 rounds
                "fortress_twin_cities",        # massive permanent defense
                "fortress_supply_line",        # economy engine
                "fortress_toll_road",          # draw per connected VP hex
                "fortress_fortified_position", # VP from defense stacking
                "fortress_warden",            # VP from uncaptured tiles
            ],
        },
    ),
    "shock_and_awe": CardPack(
        id="shock_and_awe",
        name="Shock & Awe",
        neutral_card_ids=[
            "neutral_reduce",
            "neutral_recruit",
            "neutral_road_builder",
            "neutral_militia",
            "neutral_forced_march",
            "neutral_watchtower",
            "neutral_sabotage",
            "neutral_rally_cry",
            "neutral_mercenary",
            "neutral_siege_tower",
        ],
        archetype_card_ids={
            # Fast aggressive expansion + overwhelming force
            "vanguard": [
                "vanguard_blitz",              # cheap aggression
                "vanguard_overrun",            # extended range power
                "vanguard_strike_team",        # combo power scaling
                "vanguard_rapid_assault",      # resource drain
                "vanguard_spearhead",          # high-power nuke
                "vanguard_breakthrough",       # auto-claims adjacent
                "vanguard_flanking_strike",    # extended range reach
                "vanguard_coordinated_push",   # stackable aggression
                "vanguard_double_time",        # actions engine
                "vanguard_battle_glory",       # VP from contested wins
            ],
            "swarm": [
                "swarm_surge",                 # multi-target flood
                "swarm_flood",                 # claims all adjacent
                "swarm_hive_mind",             # mass multi-target nuke
                "swarm_locust_swarm",          # tile-count power nuke
                "swarm_rabble",                # cheap spam
                "swarm_dog_pile",              # stackable, buffs claims
                "swarm_overwhelm",             # adjacency power
                "swarm_mob_rule",              # power from tile count
                "swarm_frenzy",                # actions engine
                "swarm_blitz_rush",            # mass actions burst
            ],
            "fortress": [
                "fortress_siege_engine",       # ignores defense
                "fortress_battering_ram",      # anti-defense powerhouse
                "fortress_overwhelming_force", # stackable claims
                "fortress_garrison",           # defensive power
                "fortress_war_of_attrition",   # forced discard
                "fortress_slow_advance",       # auto-claim neutrals
                "fortress_war_council",        # draw + action burst
                "fortress_catch_up",           # comeback mechanic
                "fortress_iron_wall",          # tile immunity
                "fortress_fortify",            # defense + action
            ],
        },
    ),
}

DEFAULT_PACK_ID = "everything"


def get_pack(pack_id: str) -> CardPack:
    """Return the pack for the given ID, falling back to 'everything'."""
    return CARD_PACKS.get(pack_id, CARD_PACKS[DEFAULT_PACK_ID])
