"""Card Pack definitions for filtering available cards per game session."""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from app.game_engine.cards import Archetype, CardType, Card


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

    # ── Full packs (10 neutral market cards + all archetype cards) ──────

    "iron_and_coin": CardPack(
        id="iron_and_coin",
        name="Iron & Coin",
        # Theme: Economy fuels combat. Resource generation + strong claims.
        # Synergies:
        #   1. Tax Collector + VP tile claims → snowball resources into Siege Tower / Mercenary
        #   2. Dividends + Prospector/Tithe → compound resource generation
        #   3. Mobilize + cheap cards (Levy, Cull) → action chaining into big plays
        #   4. Vanguard War Tithe / Plunder + Mercenary → claims pay for themselves
        #   5. Swarm Scavenge + Dividends → resource engine even at 0 actions
        #   6. Fortress Supply Line + Dividends → economy doubling
        neutral_card_ids=[
            "neutral_reduce",          # Cull: deck thinning (1💰)
            "neutral_recruit",         # Levy: cheap claim + action (2💰)
            "neutral_prospector",      # Prospector: 2 resources (2💰)
            "neutral_war_bonds",       # Tithe: 2 resources + 1 action (3💰)
            "neutral_conscription",    # Muster: draw 2 cards (4💰)
            "neutral_mercenary",       # Mercenary: power 3 claim (4💰)
            "neutral_tax_collector",   # Tax Collector: resources per connected VP tile (4💰)
            "neutral_dividends",       # Dividends: resources scale with wealth (4💰)
            "neutral_mobilize",        # Mobilize: actions per cards played, trash (4💰)
            "neutral_siege_tower",     # Siege Tower: power 6 finisher (8💰)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
    "frontier_tactics": CardPack(
        id="frontier_tactics",
        name="Frontier Tactics",
        # Theme: Board position and strategic territory control.
        # Synergies:
        #   1. Road Builder + Eminent Domain → claim disconnected tiles, bridge them together
        #   2. Diplomat + Land Grant → flood VP passives; Swarm Colony rewards disconnected groups
        #   3. Cease Fire + Fortress defensive play → draw cards while turtling
        #   4. Surveyor + archetype market → find key archetype cards faster
        #   5. Trench + Barricade → cheap action-neutral defense to hold newly bridged tiles
        #   6. Trench (action chain) → set up bigger plays while still fortifying
        #   7. Supply Depot + Cease Fire → stack next-turn value while playing defensively
        neutral_card_ids=[
            "neutral_reduce",          # Cull: deck thinning (2💰)
            "neutral_surveyor",        # Surveyor: free market re-roll (2💰)
            "neutral_road_builder",    # Road Builder: bridge territory (2💰)
            "neutral_trench",          # Trench: +1 def + 1 action (2💰)
            "neutral_cease_fire",      # Cease Fire: draw if peaceful (3💰)
            "neutral_fortified_post",  # Barricade: +2 permanent defense (5💰)
            "neutral_diplomat",        # Diplomat: land grants for all (3💰)
            "neutral_land_grant",      # Land Grant: +1 VP passive (5💰)
            "neutral_eminent_domain",  # Eminent Domain: claim any neutral (5💰)
            "neutral_supply_depot",    # Supply Depot: next-turn draw + resource (6💰)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
    "shock_and_awe": CardPack(
        id="shock_and_awe",
        name="Shock & Awe",
        # Theme: Aggressive tempo, disruption, and overwhelming force.
        # Synergies:
        #   1. Rally Cry (stackable all claims) + Coordinated Push / Dog Pile → massive tile stacks
        #   2. Ambush + aggressive claiming → punish contested tiles with bonus power
        #   3. Sabotage + Swarm Infestation/Plague → multi-axis opponent disruption
        #   4. Forced March + Militia → actions for big territorial claims
        #   5. Vanguard Spoils of War + aggression → trash opponent cards while claiming
        #   6. Spyglass + action-hungry archetypes → cheap draw when hand is low
        neutral_card_ids=[
            "neutral_reduce",          # Cull: deck thinning (1💰)
            "neutral_spyglass",        # Spyglass: draw + conditional action (1💰)
            "neutral_recruit",         # Levy: cheap claim + action (2💰)
            "neutral_militia",         # Militia: territorial power claim (3💰)
            "neutral_forced_march",    # Forced March: 2 actions (3💰)
            "neutral_ambush",          # Ambush: contested power boost (4💰)
            "neutral_mercenary",       # Mercenary: power 3 claim (4💰)
            "neutral_rally_cry",       # Rally Cry: all claims stackable (5💰)
            "neutral_sabotage",        # Sabotage: opponent draws fewer (5💰)
            "neutral_siege_tower",     # Siege Tower: power 6 finisher (8💰)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),

    "hold_the_line": CardPack(
        id="hold_the_line",
        name="Hold the Line",
        # Theme: Pure defense — fortify, turtle, and out-tempo opponents through attrition.
        # No neutral Claim cards: rely on Explore (starter) and your archetype's claims to expand,
        # while the neutral market is dedicated to keeping what you take.
        # Synergies:
        #   1. Trench + Watchtower + Moat → layered defense across multiple tiles, action-neutral
        #   2. Barricade (permanent) + Watchtower / Moat (round) → temporary stacks on top of permanent
        #   3. Cease Fire + defensive play → constant card draw without ever attacking
        #   4. Tax Collector + holding VP tiles → snowball economy from territory you defend
        #   5. Diplomat → seeds Land Grants, rewards turtle strategies that just sit on VP
        #   6. Supply Depot + slow play → invest an action now for a fully-loaded next round
        #   7. Surveyor + archetype defense cards → find Fortify / Iron Wall / Stronghold faster
        #   8. Cull → thin starter Explores for tighter draws of defense cards
        neutral_card_ids=[
            "neutral_reduce",          # Cull: deck thinning (2💰)
            "neutral_trench",          # Trench: +1 defense + 1 action (2💰)
            "neutral_surveyor",        # Surveyor: free market re-roll (2💰)
            "neutral_watchtower",      # Watchtower: +2 defense + draw (3💰)
            "neutral_cease_fire",      # Cease Fire: draw if peaceful (3💰)
            "neutral_diplomat",        # Diplomat: land grants for all (3💰)
            "neutral_tax_collector",   # Tax Collector: resources per connected VP tile (4💰)
            "neutral_fortified_post",  # Barricade: +2 permanent defense (5💰)
            "neutral_moat",            # Moat: +2 defense on 3 tiles + 1 action (5💰)
            "neutral_supply_depot",    # Supply Depot: next-turn draw + resource (6💰)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),

    # ── Mini packs (5 neutral market cards + all archetype cards) ───────

    "mini_lean_machine": CardPack(
        id="mini_lean_machine",
        name="Mini: Lean Machine",
        # Theme: Deck efficiency — thin, cycle, and optimize every draw.
        # Synergies:
        #   1. Cull + Reclaim → trash junk cards AND gain resources from their buy cost
        #   2. Cartographer + Spyglass → cycle through deck fast, refill hand cheaply
        #   3. Works great with Swarm Thin the Herd / Spoils Hoard (VP from trash pile)
        #   4. Fortress Consolidate + Reclaim → double trash-for-value engine
        neutral_card_ids=[
            "neutral_reduce",          # Cull: trash cards from hand (1💰)
            "neutral_spyglass",        # Spyglass: draw + conditional action (1💰)
            "neutral_reclaim",         # Reclaim: trash for resources (2💰)
            "neutral_prospector",      # Prospector: basic economy (2💰)
            "neutral_cartographer",    # Cartographer: discard 2, draw 2 (3💰)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
    "mini_war_economy": CardPack(
        id="mini_war_economy",
        name="Mini: War Economy",
        # Theme: Resources through combat — every claim pays dividends.
        # Synergies:
        #   1. Levy → cheap early claim + action chaining into Militia/Mercenary
        #   2. Tax Collector + VP tile control → snowball resources for Mercenary purchases
        #   3. Ambush + Militia → read opponents, punish contested tiles, reward territory
        #   4. Vanguard War Tithe + Mercenary → claims generate resources to buy more claims
        #   5. Fortress Robin Hood + losing tiles → economic comeback into Mercenary power
        neutral_card_ids=[
            "neutral_recruit",         # Levy: cheap claim + action (2💰)
            "neutral_militia",         # Militia: territorial power claim (3💰)
            "neutral_war_bonds",       # Tithe: 2 resources + 1 action (3💰)
            "neutral_mercenary",       # Mercenary: power 3 claim (4💰)
            "neutral_tax_collector",   # Tax Collector: resources per connected VP tile (4💰)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
}

DEFAULT_PACK_ID = "everything"


def _get_purchasable_neutrals(card_registry: dict[str, Card]) -> list[Card]:
    """Return all purchasable neutral market cards from the registry."""
    return [
        c for c in card_registry.values()
        if c.archetype == Archetype.NEUTRAL and not c.starter and c.buy_cost is not None
    ]


def generate_daily_pack(seed: int, card_registry: dict[str, Card]) -> CardPack:
    """Generate a deterministic 10-card daily pack from a date seed (YYYYMMDD)."""
    neutrals = _get_purchasable_neutrals(card_registry)
    rng = random.Random(seed)
    rng.shuffle(neutrals)

    selected = neutrals[:9]
    remaining = neutrals[9:]

    # Constraint check: at least 1 Claim, 1 Engine, 1 low-cost (1-2), 1 high-cost (4+)
    constraints: list[tuple[str, Any, Any]] = [
        ("type", CardType.CLAIM, lambda c: c.card_type == CardType.CLAIM),
        ("type", CardType.ENGINE, lambda c: c.card_type == CardType.ENGINE),
        ("cost_low", None, lambda c: c.buy_cost is not None and c.buy_cost <= 2),
        ("cost_high", None, lambda c: c.buy_cost is not None and c.buy_cost >= 4),
    ]

    for _label, _val, check_fn in constraints:
        if any(check_fn(c) for c in selected):
            continue
        # Find a replacement from remaining pool
        candidates = [c for c in remaining if check_fn(c)]
        if not candidates:
            continue
        replacement = candidates[0]
        # Swap out a card whose traits are redundantly represented
        for i in range(len(selected) - 1, -1, -1):
            card = selected[i]
            # Check this card's type and cost tier are still covered by others
            others = [c for j, c in enumerate(selected) if j != i]
            type_covered = any(c.card_type == card.card_type for c in others)
            if type_covered:
                selected[i] = replacement
                remaining.remove(replacement)
                remaining.append(card)
                break

    # Wildcard: 1 more card from remaining
    rng.shuffle(remaining)
    if remaining:
        selected.append(remaining[0])

    # Format display name from seed
    try:
        date_obj = datetime.strptime(str(seed), "%Y%m%d")
        name = f"The Daily — {date_obj.strftime('%b')} {date_obj.day}"
    except ValueError:
        name = "The Daily"

    return CardPack(
        id=f"daily_{seed}",
        name=name,
        neutral_card_ids=[c.id for c in selected],
        archetype_card_ids=None,
    )


def get_today_daily_pack(card_registry: dict[str, Card]) -> CardPack:
    """Generate the daily pack for today's UTC date."""
    today = date.today()
    seed = int(today.strftime("%Y%m%d"))
    return generate_daily_pack(seed, card_registry)


def get_pack(pack_id: str, card_registry: dict[str, Card] | None = None) -> CardPack:
    """Return the pack for the given ID, falling back to 'everything'."""
    if pack_id.startswith("daily_") and card_registry is not None:
        try:
            seed = int(pack_id.split("_", 1)[1])
            return generate_daily_pack(seed, card_registry)
        except (ValueError, IndexError):
            pass
    return CARD_PACKS.get(pack_id, CARD_PACKS[DEFAULT_PACK_ID])
