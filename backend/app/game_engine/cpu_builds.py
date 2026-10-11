"""How a CPU follows a build (see pack_builds.py).

- `fast_claim_purchase`: Card Clash's Big Money — the affordable Claim with
  the highest typical power (`typical_claim_power`: bonuses its usual play
  meets, Debt counted against it); it never saves. `FastClaimCPU` buys that way with
  baseline (Medium) play: the yardstick every tier is measured against —
  Easy should lose to it, Medium match it, Hard beat it.
- `plan_purchase`: the first card on the build's list the player still
  wants and can afford. `build_purchase` falls back to Fast Claim (how the
  acceptance test measures a build); a CPU tier falls back to its own
  judgment instead (CPUPlayer.pick_next_purchase).
- `choose_build`: which build a CPU tier follows. Easy picks Fast Claim or
  one of the weaker half of the builds; Medium a random build that beats Fast
  Claim; Hard the best-rated build for its archetype. Ratings are the
  builds' measured win rates against Fast Claim on the 2-player suggested map
  (`data/build_ratings.json`, written by `scripts/pack_builds.py --write-ratings`). The choice is seeded
  by the game and player, so a CPU keeps its build all game even though the
  live server makes a fresh CPUPlayer for every decision.
"""

from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from .cards import Card, CardType
from .effects import ConditionType, EffectType
from .cpu_player import MEDIUM, CPUPlayer
from .pack_builds import FAST_CLAIM, Build, builds_for

if TYPE_CHECKING:
    from .game_state import GameState, Player

FAST_CLAIM_MIN_POWER = 1
# A build "beats Fast Claim" at this win rate (the pack acceptance threshold).
VIABLE_RATING = 0.55
# Ratings are measured on 2 players' suggested map (11–12 round games); every
# game uses them — a 4-player Medium game runs about as long.
RATING_GRID = "large"
RATINGS_PATH = Path(__file__).resolve().parent.parent.parent.parent / "data" / "build_ratings.json"


@lru_cache(maxsize=1)
def load_ratings() -> dict[str, dict[str, dict[str, float]]]:
    """{pack: {build id: {grid size: win rate vs Fast Claim}}}"""
    try:
        return json.loads(RATINGS_PATH.read_text())  # type: ignore[no-any-return]
    except (OSError, ValueError):
        return {}


def build_rating(pack: str, build_id: str, grid: str) -> Optional[float]:
    return load_ratings().get(pack, {}).get(build_id, {}).get(grid)


def owned_copies(player: "Player", definition_id: str) -> int:
    cards = player.deck.cards + player.deck.discard + player.hand + [a.card for a in player.planned_actions]
    return sum(1 for c in cards if c.definition_id == definition_id)


def _market_options(game: "GameState", player: "Player") -> list[tuple[Card, int, dict[str, Any]]]:
    """(card, cost, purchase) for every card on offer to this player right now."""
    from .game_state import calculate_dynamic_buy_cost, player_owns_card_definition
    out: list[tuple[Card, int, dict[str, Any]]] = []
    for card in player.archetype_market:
        if card.unique and player_owns_card_definition(player, card.definition_id):
            continue
        out.append((card, calculate_dynamic_buy_cost(game, player, card),
                    {"source": "archetype", "card_id": card.id, "definition_id": card.definition_id}))
    bought = {p["card_id"] for p in game.buy_phase_purchases.get(player.id, []) if p["source"] == "shared"}
    for base_id, copies in game.shared_market.stacks.items():
        if not copies or base_id in bought:
            continue
        card = copies[0]
        if card.unique and player_owns_card_definition(player, card.definition_id):
            continue
        out.append((card, calculate_dynamic_buy_cost(game, player, card),
                    {"source": "shared", "card_id": base_id, "definition_id": card.definition_id}))
    return out


# How much of a conditional Claim bonus Fast Claim counts on: in full when
# its usual play meets the condition (it plays several Claims a round, mostly
# onto neutral land next to its own), half when it's situational.
_TYPICAL_BONUS: dict[ConditionType, float] = {
    ConditionType.IF_PLAYED_CLAIM_THIS_TURN: 1.0,  # Strike Team
    ConditionType.IF_TARGET_NEUTRAL: 1.0,          # Mountaineer
    ConditionType.IF_TARGET_HAS_DEFENSE: 0.5,      # Siege Engine
    ConditionType.IF_CONTESTED: 0.5,               # Ambush
}
TYPICAL_ADJACENT_OWNED = 2   # Overwhelm: +1 per owned tile next to the target
DEBT_POWER_COST = 1.5        # a Debt (and an extra action to play) costs this much power


def typical_claim_power(game: "GameState", player_id: str, card: Card) -> float:
    """A Claim's power as Fast Claim usually plays it: printed power, the
    bonuses its play usually meets, extra targets as extra tiles, less the
    cost of any Debt or extra action it brings."""
    power = float(card.effective_power)
    for effect in card.effects:
        value = effect.effective_value(card.is_upgraded)
        if effect.type == EffectType.POWER_PER_TILES_OWNED and game.grid is not None:
            bonus = len(game.grid.get_player_tiles(player_id)) // (value or 3)
            power = bonus if effect.metadata.get("replaces_base_power") else power + bonus
        elif effect.type == EffectType.POWER_MODIFIER and effect.condition is not None:
            if effect.condition == ConditionType.IF_ADJACENT_OWNED_GTE:
                power += value * TYPICAL_ADJACENT_OWNED
            else:
                power += value * _TYPICAL_BONUS.get(effect.condition, 0.0)
        elif effect.type == EffectType.GAIN_DEBT:
            power -= DEBT_POWER_COST * value
    power += 1.5 * card.effective_multi_target_count
    power -= DEBT_POWER_COST * max(0, card.action_cost - 1)
    return power


def fast_claim_purchase(game: "GameState", player: "Player") -> Optional[dict[str, Any]]:
    """The Claim with the highest typical power the player can afford
    (cheaper on a tie) — it never saves — or None when no Claim is affordable."""
    best: Optional[tuple[float, dict[str, Any]]] = None
    for card, cost, action in _market_options(game, player):
        if cost > player.resources or card.card_type != CardType.CLAIM or card.trash_on_use:
            continue
        if any(e.type == EffectType.ADJACENCY_BRIDGE for e in card.effects):
            continue
        power = typical_claim_power(game, player.id, card)
        if power < FAST_CLAIM_MIN_POWER:
            continue
        score = power * 10 - cost
        if best is None or score > best[0]:
            best = (score, action)
    return best[1] if best else None


def plan_purchase(game: "GameState", player: "Player", build: Build) -> Optional[dict[str, Any]]:
    """The first card on the build's list the player still wants and can
    afford (one copy of a card per round), or None."""
    if player.turn_modifiers.buy_locked:
        return None
    bought = {e.get("definition_id") for e in game.buy_phase_purchases.get(player.id, [])}
    options = _market_options(game, player)
    for cid, copies in build.plan:
        if cid in bought or owned_copies(player, cid) >= copies:
            continue
        for card, cost, action in options:
            if card.definition_id == cid and cost <= player.resources:
                return action
    return None


def build_purchase(game: "GameState", player: "Player", build: Build) -> Optional[dict[str, Any]]:
    """A build as the acceptance test plays it: its list, else Fast Claim."""
    return plan_purchase(game, player, build) or fast_claim_purchase(game, player)


def choose_build(game: "GameState", player_id: str, difficulty: str) -> Optional[Build]:
    """The build this CPU follows all game (see the module docstring), or
    None in a pack with no builds (the CPU buys as it always has)."""
    player = game.players[player_id]
    pack = game.card_pack
    grid = RATING_GRID
    options = builds_for(pack, player.archetype.value)
    rated = [(build_rating(pack, b.id, grid), b) for b in options]
    # Only packs whose builds have been measured (rated) follow them; until
    # then the CPU buys as it always has.
    if not options or all(r is None for r, _ in rated):
        return None
    rng = random.Random(f"{game.id}|{player_id}|build")
    if difficulty == "easy":
        # Plain Fast Claim or one of the weaker half of the builds: a
        # different, recognizable plan each game that still loses to Fast
        # Claim more often than not.
        known = sorted(((r, b) for r, b in rated if r is not None), key=lambda t: t[0])
        weaker = [b for _, b in known[:max(1, len(known) // 2)]]
        return rng.choice([FAST_CLAIM, *weaker])
    if difficulty == "medium":
        viable = [b for r, b in rated if r is not None and r >= VIABLE_RATING]
        return rng.choice(viable or options)
    known = [(r, b) for r, b in rated if r is not None]
    r, best = max(known, key=lambda t: t[0])
    return best if r > 0.5 else FAST_CLAIM


class FastClaimCPU(CPUPlayer):
    """The baseline bot: Fast Claim buying with `play`-tier tactics (Medium:
    sensible play, no obviously bad moves)."""

    def __init__(self, player_id: str, rng: Optional[random.Random] = None, play: str = MEDIUM):
        super().__init__(player_id, difficulty=play, rng=rng)

    def pick_next_purchase(self, game: Any) -> Optional[dict[str, Any]]:
        player = game.players[self.player_id]
        if player.turn_modifiers.buy_locked or player.resources <= 0:
            return None
        return fast_claim_purchase(game, player)

    def should_reroll_market(self, game: Any) -> bool:
        return False
