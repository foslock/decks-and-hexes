"""Builds: the strategies the CPU knows for each card pack.

A build is a buy plan, like a Dominion simulator bot ("Big Money + Smithy"):
an ordered list of (card id, copies). Each purchase walks the list and buys
the first card it still wants and can afford; when nothing on the list fits,
it falls back to Fast Claim — Card Clash's Big Money: buy the strongest
Claim you can afford, save otherwise. Play is the same for every build (the
CPU's usual tactics); only what goes into the deck changes.

Every pack should have several builds that beat Fast Claim, with none that
beats all the others — `scripts/pack_builds.py` measures that and writes
each build's win rate against Fast Claim to `data/build_ratings.json`, which
the CPU tiers use to choose a build. Builds are never sent to players:
finding them is the game.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Build:
    id: str
    name: str
    archetype: Optional[str]          # None: any archetype can play it
    plan: tuple[tuple[str, int], ...]  # (card definition id, copies), in priority order
    summary: str = ""


FAST_CLAIM = Build(
    "fast_claim", "Fast Claim", None, (),
    "Buy the Claim with the highest typical power you can afford; never save.",
)


def _b(id: str, name: str, archetype: Optional[str], plan: list[tuple[str, int]], summary: str) -> Build:
    return Build(id, name, archetype, tuple(plan), summary)


PACK_BUILDS: dict[str, tuple[Build, ...]] = {
    "first_clash": (
        # Found by scripts/build_search.py (Hard play vs Fast Claim, 2p Large;
        # their win rates there in the summaries' order of strength). Two or
        # three early Levies are a common opening — expand while the land is
        # open — then each line invests differently.
        _b("blitzkrieg", "Blitzkrieg", "vanguard",
           [("vanguard_war_cache", 2), ("vanguard_blitz", 2), ("vanguard_rapid_assault", 3), ("vanguard_strike_team", 3)],
           "Bank with Plunder, then an army of Vanguard Claims that draw and drain as they win."),
        _b("shock_troops", "Shock Troops", "vanguard",
           [("neutral_recruit", 2), ("vanguard_double_time", 1), ("vanguard_strike_team", 3)],
           "Play Claims in bunches: every Strike Team after the first hits at power 4."),
        _b("plunder", "Plunder", "vanguard",
           [("vanguard_war_cache", 2), ("neutral_recruit", 3)],
           "Bank early with Plunder, spread with Levies, cash in late."),
        _b("outpost_line", "Outpost Line", "vanguard",
           [("neutral_recruit", 2), ("neutral_watchtower", 3)],
           "Expand early, then guard every border with Watchtowers that pay for themselves."),
        _b("tidewatch", "Tidewatch", "swarm",
           [("swarm_surge", 3), ("swarm_drone_wave", 1), ("neutral_watchtower", 2)],
           "Two tiles a Surge, and Watchtowers on the border."),
        _b("drone_tide", "Drone Tide", "swarm",
           [("swarm_swarm_tactics", 1), ("swarm_drone_wave", 2), ("swarm_surge", 3)],
           "The wider you spread, the more Drone Wave draws."),
        _b("encircle", "Encircle", "swarm",
           [("neutral_watchtower", 1), ("swarm_swarm_tactics", 1), ("swarm_surge", 3), ("swarm_overwhelm", 3)],
           "Spread with Surge, then crush walled tiles you've surrounded with Overwhelm."),
        _b("horde", "Horde", "swarm",
           [("neutral_recruit", 2), ("swarm_rabble", 3), ("swarm_overwhelm", 3)],
           "Rabble in packs: each one hits harder for every other Rabble that round."),
        _b("siege_line", "Siege Line", "fortress",
           [("neutral_recruit", 2), ("fortress_iron_discipline", 1), ("fortress_siege_engine", 2), ("neutral_fortified_post", 1)],
           "Spread with Levies, wall one tile, break theirs with Siege Engines."),
        _b("discipline", "Discipline", "fortress",
           [("fortress_iron_discipline", 2), ("neutral_recruit", 3)],
           "Iron Discipline keeps the hand full and the bank growing; Levies spread."),
        _b("disciplined_climb", "Disciplined Climb", "fortress",
           [("fortress_iron_discipline", 2), ("fortress_slow_advance", 2), ("neutral_recruit", 2)],
           "Draw deep, then climb into open land at power 4."),
        _b("stronghold", "Stronghold", "fortress",
           [("neutral_recruit", 3), ("neutral_watchtower", 1), ("neutral_fortified_post", 2)],
           "Barricade the tiles that matter, expand with the rest."),
        _b("mountaineers", "Mountaineers", "fortress",
           [("neutral_recruit", 2), ("fortress_slow_advance", 2), ("neutral_fortified_post", 1)],
           "Climb into open land at power 4."),
        _b("bastion", "Bastion", "fortress",
           [("neutral_recruit", 3), ("fortress_iron_wall", 2), ("fortress_garrison", 1)],
           "Hold a line nobody can take."),
        _b("levy_flood", "Levy Flood", None,
           [("neutral_recruit", 6)],
           "Nothing but Levies: a Claim for every tile in reach."),
        _b("big_guns", "Big Guns", None,
           [("neutral_recruit", 2), ("neutral_mercenary", 2), ("neutral_siege_tower", 1)],
           "Hire Mercenaries and a Siege Tower; pay off the Debt later."),
    ),
    "border_war": (
        # Found by scripts/build_search.py (Hard play vs Fast Claim, 2p Large).
        _b("ambush_line", "Ambush Line", "vanguard",
           [("neutral_ambush", 3), ("vanguard_blitz", 2), ("neutral_watchtower", 4), ("neutral_conscription", 2)],
           "Meet every rival Claim with an Ambush; Watchtowers hold the rest."),
        _b("blitzkrieg", "Blitzkrieg", "vanguard",
           [("vanguard_strike_team", 2), ("vanguard_rapid_assault", 1), ("vanguard_blitz", 3),
            ("neutral_conscription", 2), ("neutral_watchtower", 3)],
           "Draw deep, Claim often, and draw again on every win."),
        _b("raiders", "Raiders", "vanguard",
           [("vanguard_rapid_assault", 2), ("neutral_ambush", 3), ("vanguard_blitz", 3),
            ("neutral_conscription", 2), ("neutral_watchtower", 3)],
           "Hit rival tiles: drain their bank, draw on every win."),
        _b("glory_raid", "Glory Raid", "vanguard",
           [("vanguard_battle_glory", 1), ("vanguard_rapid_assault", 3), ("vanguard_spearhead", 1)],
           "Beat two rival tiles a round for Battle Glory."),
        _b("hatchery", "Hatchery", "swarm",
           [("swarm_hatching_grounds", 3), ("swarm_rabble", 2), ("neutral_conscription", 2), ("neutral_ambush", 1)],
           "Hatch Rabble by the dozen; every Rabble hits harder with its kin."),
        _b("shield_wall", "Shield Wall", "swarm",
           [("swarm_hatching_grounds", 3), ("neutral_conscription", 2), ("swarm_safety_in_numbers", 2)],
           "A Rabble horde behind a Phalanx line."),
        _b("dog_pile", "Dog Pile", "swarm",
           [("swarm_dog_pile", 3), ("neutral_rally_cry", 1), ("swarm_rabble", 2), ("swarm_scavenge", 1)],
           "Stack Claims on the one tile that matters."),
        _b("juggernaut_wall", "Juggernaut Wall", "fortress",
           [("neutral_conscription", 2), ("fortress_overwhelming_force", 3), ("fortress_iron_wall", 3),
            ("neutral_ambush", 2), ("neutral_watchtower", 3)],
           "Roll over neutral land for resources; nobody takes it back."),
        _b("juggernaut", "Juggernaut", "fortress",
           [("fortress_overwhelming_force", 3), ("neutral_ambush", 2), ("fortress_iron_wall", 3), ("neutral_watchtower", 3)],
           "Juggernauts out front, Iron Walls behind."),
        _b("attrition", "Attrition", "fortress",
           [("fortress_overwhelming_force", 3), ("fortress_war_of_attrition", 2), ("neutral_ambush", 2)],
           "Grind: every failed defense costs them a card."),
        _b("garrison_wall", "Garrison Wall", "fortress",
           [("fortress_garrison", 2), ("fortress_supply_line", 2), ("neutral_prospector", 1), ("neutral_watchtower", 2)],
           "Hold what you take and bank as you go."),
    ),
    "deep_roots": (
        # Found by scripts/build_search.py (Hard play vs Fast Claim, 2p Large).
        # The thinning / VP-card lines (Cull, Salvage, Land Grant, Arsenal,
        # Colony, Warden, Toll Road) still lose badly — this pack needs rework.
        _b("war_bonds", "War Bonds", "vanguard",
           [("neutral_war_bonds", 2), ("vanguard_strike_team", 3)],
           "Tithe pays for an army of Strike Teams."),
        _b("strike_and_blitz", "Strike and Blitz", "vanguard",
           [("vanguard_strike_team", 3), ("vanguard_blitz", 3)],
           "Claims in bunches, and a card back for every win."),
        _b("elite", "Elite", "vanguard",
           [("neutral_tax_collector", 2), ("vanguard_elite_vanguard", 2), ("vanguard_strike_team", 2)],
           "VP hexes pay for Elite Vanguards."),
        _b("arsenal", "Arsenal", "vanguard",
           [("vanguard_arsenal", 1), ("vanguard_double_time", 2), ("vanguard_blitz", 2), ("neutral_war_bonds", 2)],
           "A big deck that's worth points."),
        _b("drone_bonds", "Drone Bonds", "swarm",
           [("swarm_drone_wave", 3), ("neutral_war_bonds", 1), ("swarm_overwhelm", 1)],
           "Drone Waves keep the hand full; spread wide and draw wider."),
        _b("drone_pile", "Drone Pile", "swarm",
           [("swarm_drone_wave", 3), ("swarm_dog_pile", 1), ("neutral_war_bonds", 1)],
           "A Drone engine with a Dog Pile to break the walls."),
        _b("drone_swarm", "Drone Swarm", "swarm",
           [("swarm_drone_wave", 3), ("swarm_overwhelm", 3), ("neutral_war_bonds", 1)],
           "Draw deep, surround, Overwhelm."),
        _b("colony", "Colony", "swarm",
           [("swarm_colony", 1), ("swarm_surge", 3), ("swarm_drone_wave", 2)],
           "Spread into islands of land."),
        _b("tithe", "Tithe", "fortress",
           [("neutral_war_bonds", 4)],
           "Tithe after Tithe: a full hand and a full bank."),
        _b("tax_and_tithe", "Tax and Tithe", "fortress",
           [("neutral_war_bonds", 2), ("neutral_tax_collector", 1)],
           "Tithe and tax the hexes you hold."),
        _b("garrison_tax", "Garrison Tax", "fortress",
           [("fortress_garrison", 1), ("neutral_tax_collector", 2)],
           "Hold the hexes, tax them, Garrison them."),
        _b("wardens", "Wardens", "fortress",
           [("fortress_warden", 1), ("fortress_iron_wall", 2), ("fortress_garrison", 2)],
           "Never lose a tile; Warden pays for it."),
        _b("toll_road", "Toll Road", "fortress",
           [("fortress_toll_road", 2), ("neutral_tax_collector", 2), ("fortress_siege_engine", 2)],
           "Connected hexes fuel the engine."),
        _b("cull", "Cull", None,
           [("neutral_reduce", 2), ("neutral_salvage", 1), ("neutral_tax_collector", 2)],
           "A thin deck of the best cards."),
        _b("tithe_green", "Tithe and Grant", None,
           [("neutral_war_bonds", 3), ("neutral_land_grant", 3), ("neutral_salvage", 1)],
           "Economy into Land Grants."),
    ),
    "far_reaches": (
        _b("overrun", "Overrun", "vanguard",
           [("vanguard_overrun", 2), ("vanguard_war_cache", 2), ("neutral_conscription", 1)],
           "Strike two steps out, wherever they're weak."),
        _b("breakthrough", "Breakthrough", "vanguard",
           [("vanguard_breakthrough", 3), ("vanguard_blitz", 2), ("neutral_mercenary", 1)],
           "Every win takes a tile more."),
        _b("rearguard", "Rearguard", "vanguard",
           [("vanguard_rearguard", 2), ("vanguard_blitz", 3), ("neutral_road_builder", 1)],
           "Advance and hold."),
        _b("scatter", "Scatter", "swarm",
           [("swarm_proliferate", 3), ("swarm_surge", 2), ("neutral_road_builder", 1)],
           "Seed land everywhere, then join it up."),
        _b("exodus", "Exodus", "swarm",
           [("swarm_exodus", 2), ("swarm_dog_pile", 3), ("neutral_conscription", 1)],
           "Give up the border to strike where it counts."),
        _b("encircle", "Encircle", "swarm",
           [("swarm_overwhelm", 3), ("swarm_surge", 2), ("neutral_mercenary", 1)],
           "Surround, then Overwhelm."),
        _b("juggernaut", "Juggernaut", "fortress",
           [("fortress_overwhelming_force", 3), ("fortress_supply_line", 2), ("neutral_fortified_post", 1)],
           "Roll over neutral land and bank as you go."),
        _b("scorched_earth", "Scorched Earth", "fortress",
           [("fortress_scorched_retreat", 1), ("fortress_siege_engine", 2), ("neutral_mercenary", 2)],
           "Burn a tile for a war chest."),
        _b("mountaineers", "Mountaineers", "fortress",
           [("fortress_slow_advance", 3), ("fortress_supply_line", 2), ("neutral_tax_collector", 1)],
           "Spread over open land."),
        _b("roads", "Roads", None,
           [("neutral_road_builder", 2), ("neutral_tax_collector", 2), ("neutral_mercenary", 2)],
           "Link the hexes up and tax them."),
    ),
}


def pack_builds(pack_id: str) -> tuple[Build, ...]:
    return PACK_BUILDS.get(pack_id, ())


def builds_for(pack_id: str, archetype: str) -> list[Build]:
    """The builds a player of this archetype can follow in this pack."""
    return [b for b in pack_builds(pack_id) if b.archetype in (None, archetype)]
