"""Card Pack definitions for filtering available cards per game session."""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable, Optional

from app.game_engine.cards import Archetype, CardType, Card
from app.game_engine.effects import EffectType


@dataclass
class CardPack:
    """A named selection of cards available for a game session.

    - shared_card_ids: list of neutral card IDs to include, or None for all.
    - archetype_card_ids: per-archetype card ID lists, or None for all.
      Keys are archetype names (e.g. "vanguard"), values are lists of card IDs.
    - starter_overrides: reserved for future packs that change starting decks.
      None means use the default starter composition from cards.py.
    """
    id: str
    name: str
    shared_card_ids: Optional[list[str]] = None
    archetype_card_ids: Optional[dict[str, list[str]]] = None
    starter_overrides: Optional[dict[str, Any]] = None
    # One-line, player-facing summary shown in the lobby's pack picker.
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "shared_card_ids": self.shared_card_ids,
            "archetype_card_ids": self.archetype_card_ids,
        }


CARD_PACKS: dict[str, CardPack] = {
    "everything": CardPack(
        id="everything",
        name="Everything",
        description="Every shared market card.",
        shared_card_ids=None,
        archetype_card_ids=None,
    ),

    # ── Full packs (10 neutral market cards + all archetype cards) ──────
    # Comment costs/effects below mirror data/cards_neutral.yaml — keep them
    # in sync when card numbers change. Power 2 takes a standard VP hex and
    # power 3 a premium one (a tie against neutral intrinsic defense goes to
    # the attacker).

    "iron_and_coin": CardPack(
        id="iron_and_coin",
        name="Iron & Coin",
        description="Economy fuels combat: big money, bigger claims.",
        # Theme: Economy fuels combat. Resource generation + strong claims.
        # Synergies:
        #   1. Tax Collector + held VP hexes → 3 res per connected hex funds Siege Tower / Mercenary
        #   2. Dividends + Prospector/Tithe → bank resources, then Dividends pays 1 per 2 held
        #   3. Mercenary + Tax Collector / Tithe → the economy covers Mercenary's 2 res play cost every turn
        #   4. Vanguard War Tithe / Plunder + Mercenary → claims pay for themselves
        #   5. Salvage + Mercenary / Tax Collector → recur your best claim or money card
        #   6. Vanguard Arms Dealer + Mercenary → scrap a spare Mercenary for 3 res and an action
        #   7. Fortress Supply Line + Dividends → cheaper buys while the bank compounds
        #   8. Militia + wide territory → power 4 when surrounded; Swarm's way into VP hexes
        shared_card_ids=[
            "neutral_reduce",          # Cull: trash up to 1 card from hand (cost 2)
            "neutral_recruit",         # Levy: Claim P1 + 1 action (cost 2)
            "neutral_prospector",      # Prospector: +4 resources (cost 3)
            "neutral_war_bonds",       # Tithe: +2 resources, draw 1, +1 action (cost 3)
            "neutral_salvage",         # Salvage: discard → hand, 1 card (cost 3)
            "neutral_mercenary",       # Mercenary: Claim P3, pay 2 res to play (cost 3)
            "neutral_tax_collector",   # Tax Collector: +3 resources per connected VP hex (cost 3)
            "neutral_dividends",       # Dividends: +1 resource per 2 held (cost 4)
            "neutral_militia",         # Militia: Claim P2, P4 with 3+ adjacent owned (cost 3)
            "neutral_siege_tower",     # Siege Tower: Claim P6, 2 actions, unique (cost 9)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
    "frontier_tactics": CardPack(
        id="frontier_tactics",
        name="Frontier Tactics",
        description="Board position: bridge, surround, and seize territory.",
        # Theme: Board position and strategic territory control.
        # Synergies:
        #   1. Eminent Domain + Road Builder → drop a remote tile, then bridge to it at power 5
        #   2. Swarm Proliferate / Vanguard Flanking Strike + Road Builder → any gap you leave becomes a power-5 bridge
        #   3. Diplomat → you bank 2 Land Grants (opponents 1); pairs with Land Grant for a VP push
        #   4. Swarm Colony vs Road Builder → choose: keep groups apart for Colony VP or bridge them for connected VP hexes
        #   5. Militia + Road Builder → surround a hex for power 4, or bridge your groups for power 5
        #   6. Palisade + Barricade → round defense on top of permanent defense to hold a bridged VP hex
        #   7. Surveyor → 2 free re-rolls to dig for key archetype cards
        shared_card_ids=[
            "neutral_reduce",          # Cull: trash up to 1 card from hand (cost 2)
            "neutral_surveyor",        # Surveyor: 2 free archetype re-rolls + 1 action (cost 2)
            "neutral_road_builder",    # Road Builder: Claim P1, P5 if it bridges your groups (cost 3)
            "neutral_palisade",        # Palisade: +3 defense this round, draw 1 (cost 3)
            "neutral_cease_fire",      # Cease Fire: draw 2 next round if you captured no enemy tile (cost 3)
            "neutral_fortified_post",  # Barricade: +2 permanent defense (cost 5)
            "neutral_diplomat",        # Diplomat: you get 2 Land Grants, opponents 1, trashed (cost 5)
            "neutral_land_grant",      # Land Grant: worth 1 VP, dead card (cost 7)
            "neutral_eminent_domain",  # Eminent Domain: Claim P2 on any neutral tile, trashed (cost 5)
            "neutral_militia",         # Militia: Claim P2, P4 with 3+ adjacent owned (cost 3)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
    "shock_and_awe": CardPack(
        id="shock_and_awe",
        name="Shock & Awe",
        description="Aggressive tempo and overwhelming force.",
        # Theme: Aggressive tempo, disruption, and overwhelming force.
        # Synergies:
        #   1. Rally Cry + Coordinated Push / Dog Pile / Militia → stack every claim on one hex;
        #      Rally Cry+ adds +1 power to each of your next 5 claims
        #   2. Ambush → power 4 against any opponent-owned or contested tile; punishes their pushes
        #   3. Sabotage + Swarm Infestation / Plague → multi-axis disruption of the leader
        #   4. Forced March → covers the 2-action cost of Conqueror / Siege Tower on the same turn
        #   5. Conqueror (ignores round defense) vs Siege Tower (raw P6) → one of each per player (unique)
        #   6. Militia + wide territory → power 4 when you surround the target; Swarm's natural hex breaker
        #   7. Levy → cheap chaining claim; Levy+ is power 2, enough for a standard VP hex
        #   8. Watchtower → +2 defense that refunds its action; holds a hex without losing tempo
        shared_card_ids=[
            "neutral_reduce",          # Cull: trash up to 1 card from hand (cost 2)
            "neutral_watchtower",      # Watchtower: +2 defense this round, +1 action (cost 2)
            "neutral_recruit",         # Levy: Claim P1 + 1 action (cost 2)
            "neutral_militia",         # Militia: Claim P2, P4 with 3+ adjacent owned (cost 3)
            "neutral_forced_march",    # Forced March: +2 actions, others +1 next round (cost 3)
            "neutral_ambush",          # Ambush: Claim P2, P4 vs owned/contested tiles (cost 4)
            "neutral_conqueror",       # Conqueror: Claim P5, ignores round defense, 2 actions, unique (cost 7)
            "neutral_rally_cry",       # Rally Cry: claims in hand gain Stackable, trashed (cost 5)
            "neutral_sabotage",        # Sabotage: target draws 1 fewer next round (cost 4)
            "neutral_siege_tower",     # Siege Tower: Claim P6, 2 actions, unique (cost 9)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),

    "grand_strategy": CardPack(
        id="grand_strategy",
        name="Grand Strategy",
        description="Draw, cycle, and sculpt your deck into huge turns.",
        # Theme: Engine & sculpt. Draw, cycle, and manipulate your deck so
        # every round plays a long chain of archetype cards into the perfect
        # finish. The only pack anchored by Muster, Caravan, and Foresight.
        # Militia is the only shared Claim: the payoff for a long chained turn.
        # Synergies:
        #   1. Cull + Sift + Cartographer → thin, then stack the top of the deck for key draws
        #   2. Muster + Caravan → both draw and gain actions; chain them into huge turns
        #   3. Foresight → pull 2 key archetype cards (claims, finishers) straight into hand
        #   4. Mobilize last in a long chain → turns a big turn's card count into actions
        #   5. Supply Depot + sculpt tools → front-load next round with 2 extra draws
        #   6. Spyglass → cheap cantrip; gains an action once your hand is drawn down
        #   7. Fortress Grand Strategy / Swarm Chatter → archetype draw engines stack with the shared ones
        #   8. Long chain + Militia → cash a big turn in on the board (power 4 when surrounded)
        shared_card_ids=[
            "neutral_reduce",          # Cull: trash up to 1 card from hand (cost 2)
            "neutral_spyglass",        # Spyglass: draw 1, +1 action if hand ≤ 3 (cost 1)
            "neutral_cartographer",    # Cartographer: discard 2, draw 2, +1 action (cost 3)
            "neutral_sift",            # Sift: look at top 2, keep or discard, +1 action (cost 2)
            "neutral_militia",         # Militia: Claim P2, P4 with 3+ adjacent owned (cost 3)
            "neutral_conscription",    # Muster: draw 2, +1 action (cost 4)
            "neutral_caravan",         # Caravan: discard 1, draw 1, +2 actions (cost 4)
            "neutral_mobilize",        # Mobilize: +1 action per card played (max 3), trashed (cost 4)
            "neutral_supply_depot",    # Supply Depot: next round draw 2 + 3 resources (cost 6)
            "neutral_foresight",       # Foresight: take up to 2 cards from your draw pile (cost 7)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),

    "second_wind": CardPack(
        id="second_wind",
        name="Second Wind",
        description="Risk, recur, rebuild: bring your best cards back.",
        # Theme: Risk, recur, rebuild. Commit big cards, absorb losses, and
        # return your best plays from discard and trash. The only pack
        # anchored by Redemption alongside Salvage.
        # Synergies:
        #   1. Vanguard Spearhead + Redemption → a second P8 strike after Spearhead trashes itself
        #   2. Swarm Consecrate + Redemption → raise a VP hex's value twice
        #   3. Mobilize (trashed) + Redemption → sacrifice it for a big turn, then bring it back
        #   4. Siege Tower / Conqueror / Mercenary + Salvage → recur your premium claim (unique doesn't stop recursion)
        #   5. Ambush → lean into fights; power 4 against any opponent-owned or contested tile
        #   6. Swarm Hatching Grounds / Fortress Master Engineer + Redemption → seed a second batch of cards
        #   7. Watchtower → +2 defense for free (gains its action back) to hold what you recur into
        shared_card_ids=[
            "neutral_reduce",          # Cull: trash up to 1 card from hand (cost 2)
            "neutral_spyglass",        # Spyglass: draw 1, +1 action if hand ≤ 3 (cost 1)
            "neutral_salvage",         # Salvage: discard → hand, 1 card (cost 3)
            "neutral_watchtower",      # Watchtower: +2 defense this round, +1 action (cost 2)
            "neutral_ambush",          # Ambush: Claim P2, P4 vs owned/contested tiles (cost 4)
            "neutral_mobilize",        # Mobilize: +1 action per card played (max 3), trashed (cost 4)
            "neutral_mercenary",       # Mercenary: Claim P3, pay 2 res to play (cost 3)
            "neutral_redemption",      # Redemption: trash → hand, 1 card; trashes itself (cost 5)
            "neutral_conqueror",       # Conqueror: Claim P5, ignores round defense, 2 actions, unique (cost 7)
            "neutral_siege_tower",     # Siege Tower: Claim P6, 2 actions, unique (cost 9)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),

    "hold_the_line": CardPack(
        id="hold_the_line",
        name="Hold the Line",
        description="Slow and defensive, no shared claims. Favors Fortress.",
        # Theme: Pure defense — fortify, turtle, and out-tempo opponents through attrition.
        # No neutral Claim cards: rely on Explore (starter) and your archetype's claims to expand,
        # while the neutral market is dedicated to keeping what you take. Favors Fortress.
        # Synergies:
        #   1. Palisade + Watchtower + Moat → layered round defense across several tiles
        #   2. Barricade (permanent) + round defense → stacks that big claims can't break
        #   3. Cease Fire → steady card draw for a player who never attacks
        #   4. Tax Collector + held VP hexes → 3 res per connected hex; snowballs a defended lead
        #   5. Diplomat → you bank 2 Land Grants (opponents 1); rewards sitting on VP
        #   6. Supply Depot + slow play → invest an action now for a loaded next round
        #   7. Surveyor + archetype defense → dig for Fortify / Iron Wall / Stronghold
        #   8. Fortress Watchful Keep / Quartermaster → paid off by a hand full of defense
        shared_card_ids=[
            "neutral_reduce",          # Cull: trash up to 1 card from hand (cost 2)
            "neutral_palisade",        # Palisade: +3 defense this round, draw 1 (cost 3)
            "neutral_surveyor",        # Surveyor: 2 free archetype re-rolls + 1 action (cost 2)
            "neutral_watchtower",      # Watchtower: +2 defense this round, +1 action (cost 2)
            "neutral_cease_fire",      # Cease Fire: draw 2 next round if you captured no enemy tile (cost 3)
            "neutral_diplomat",        # Diplomat: you get 2 Land Grants, opponents 1, trashed (cost 5)
            "neutral_tax_collector",   # Tax Collector: +3 resources per connected VP hex (cost 3)
            "neutral_fortified_post",  # Barricade: +2 permanent defense (cost 5)
            "neutral_moat",            # Moat: +2 defense on 3 tiles this round, +1 action (cost 4)
            "neutral_supply_depot",    # Supply Depot: next round draw 2 + 3 resources (cost 6)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),

    # ── Mini packs (5 neutral market cards + all archetype cards) ───────

    "mini_lean_machine": CardPack(
        id="mini_lean_machine",
        name="Mini: Lean Machine",
        description="Thin and cycle your deck so your best cards come up more.",
        # Theme: Deck efficiency — thin, cycle, sculpt, and recur every card.
        # Synergies:
        #   1. Cull + Reclaim → trash starters, and Reclaim pays half the buy cost of what it trashes
        #   2. Sift + Cartographer → push junk to discard, then cycle into fresh draws (both gain an action)
        #   3. A thin deck + Militia → draw your hex-taking claim far more often
        #   4. Swarm Spoils Hoard + Cull / Reclaim / Thin the Herd → +1 VP per 5 trashed cards
        #   5. Fortress Consolidate + Reclaim → double trash-for-value engine
        #   6. Vanguard Arms Dealer → trash a spare Claim for resources equal to its power
        shared_card_ids=[
            "neutral_reduce",          # Cull: trash up to 1 card from hand (cost 2)
            "neutral_militia",         # Militia: Claim P2, P4 with 3+ adjacent owned (cost 3)
            "neutral_reclaim",         # Reclaim: trash 1, gain half its buy cost (cost 3)
            "neutral_sift",            # Sift: look at top 2, keep or discard, +1 action (cost 2)
            "neutral_cartographer",    # Cartographer: discard 2, draw 2, +1 action (cost 3)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
    "mini_rapid_advance": CardPack(
        id="mini_rapid_advance",
        name="Mini: Rapid Advance",
        description="Every shared card refunds actions: chain long turns.",
        # Theme: Chain a long turn out of the shared market — cards that draw
        # and refund actions. Pairs well with action-hungry archetypes.
        # Synergies:
        #   1. Muster + Caravan back-to-back → draw, gain actions, keep chaining
        #   2. Watchtower on a newly claimed tile → +2 defense that refunds its action
        #   3. Forced March → covers 2-action archetype finishers (Overrun, Mob Rule, Battering Ram)
        #   4. Spyglass on a drawn-down hand → +1 action keeps the chain going
        #   5. Vanguard Regroup+ / Fortress Iron Discipline+ → monster action rounds
        shared_card_ids=[
            "neutral_spyglass",        # Spyglass: draw 1, +1 action if hand ≤ 3 (cost 1)
            "neutral_watchtower",      # Watchtower: +2 defense this round, +1 action (cost 2)
            "neutral_forced_march",    # Forced March: +2 actions, others +1 next round (cost 3)
            "neutral_conscription",    # Muster: draw 2, +1 action (cost 4)
            "neutral_caravan",         # Caravan: discard 1, draw 1, +2 actions (cost 4)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
    "mini_war_economy": CardPack(
        id="mini_war_economy",
        name="Mini: War Economy",
        description="Resources through combat: every claim pays.",
        # Theme: Resources through combat — every claim pays dividends.
        # Synergies:
        #   1. Levy → cheap early claim + action chaining into Militia/Mercenary
        #   2. Prospector (+4 res flat) → funds Mercenary's 2 res play cost without needing to hold hexes first
        #   3. Militia + wide territory → power 4 when surrounded; Mercenary for the hexes it can't reach
        #   4. Vanguard War Tithe + Mercenary → claims generate resources to buy more claims
        #   5. Fortress Robin Hood → 3 res per tile actually captured from you; an economic comeback
        shared_card_ids=[
            "neutral_recruit",         # Levy: Claim P1 + 1 action (cost 2)
            "neutral_militia",         # Militia: Claim P2, P4 with 3+ adjacent owned (cost 3)
            "neutral_war_bonds",       # Tithe: +2 resources, draw 1, +1 action (cost 3)
            "neutral_mercenary",       # Mercenary: Claim P3, pay 2 res to play (cost 3)
            "neutral_prospector",      # Prospector: +4 resources (cost 3)
        ],
        archetype_card_ids=None,  # all archetype cards
    ),
}

DEFAULT_PACK_ID = "everything"


def _get_purchasable_neutrals(card_registry: dict[str, Card]) -> list[Card]:
    """Return all purchasable neutral market cards from the registry."""
    return [
        c for c in card_registry.values()
        if c.archetype == Archetype.SHARED and not c.starter and c.buy_cost is not None
    ]


def _gains_resources(card: Card) -> bool:
    """True for cards that put resources in your pool when played."""
    if card.effective_resource_gain > 0:
        return True
    return any(
        e.type in (EffectType.RESOURCE_SCALING, EffectType.RESOURCE_PER_VP_HEX)
        for e in card.effects
    )


def generate_daily_pack(seed: int, card_registry: dict[str, Card]) -> CardPack:
    """Generate a deterministic 10-card daily pack from a date seed (YYYYMMDD)."""
    neutrals = _get_purchasable_neutrals(card_registry)
    rng = random.Random(seed)
    rng.shuffle(neutrals)

    selected = neutrals[:9]
    remaining = neutrals[9:]

    # Coverage guarantees. Power 2 is the bar for a "hex-capable" Claim: a tie
    # against a neutral tile's intrinsic defense goes to the attacker, so it
    # takes a standard VP hex. Without these, ~14% of days had no reusable
    # hex-capable Claim, ~23% no Defense and ~48% no resource card.
    checks: list[Callable[[Card], bool]] = [
        lambda c: c.card_type == CardType.CLAIM,
        lambda c: c.card_type == CardType.ENGINE,
        lambda c: c.buy_cost is not None and c.buy_cost <= 2,
        lambda c: c.buy_cost is not None and c.buy_cost >= 4,
        lambda c: (c.card_type == CardType.CLAIM and c.effective_power >= 2
                   and not c.trash_on_use),
        lambda c: c.card_type == CardType.DEFENSE,
        _gains_resources,
    ]

    def covered(cards: list[Card], check: Callable[[Card], bool]) -> bool:
        return any(check(c) for c in cards)

    for check in checks:
        if covered(selected, check):
            continue
        candidates = [c for c in remaining if check(c)]
        if not candidates:
            continue
        replacement = candidates[0]
        # Swap out the last card whose removal keeps every guarantee that is
        # already met.
        already_met = [g for g in checks if covered(selected, g)]
        for i in range(len(selected) - 1, -1, -1):
            trial = selected[:i] + [replacement] + selected[i + 1:]
            if all(covered(trial, g) for g in already_met):
                remaining.remove(replacement)
                remaining.append(selected[i])
                selected = trial
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
        shared_card_ids=[c.id for c in selected],
        archetype_card_ids=None,
        description="A new random selection of 10 shared cards every day.",
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
