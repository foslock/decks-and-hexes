"""Deck-aware card valuation for the CPU's buy and upgrade decisions.

The legacy purchase scorer divided every score by ``cost * 0.5 + 0.5``, which
made 1–2 cost filler look several times better than the high-power Claims
that actually win VP hexes (standard VP hexes carry intrinsic defense 2,
premium ones 3, and starter Explores have power 0). A human who simply bought
big Claims beat Hard most of the time.

This module replaces that with a small economic model:

* ``card_play_value`` estimates what one play of a card is worth, in
  resource-equivalents (RE). Gather (+2 resources) is worth 2.0.
* ``purchase_value`` turns that into the marginal value of adding the card to
  the deck: (play value - average value of the deck it dilutes) times the
  number of times it is expected to be drawn before the game ends, plus any
  one-time VP.

Everything here is pure (no game mutation) so it can be unit tested and used
for both buying and choosing upgrade targets.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from .cards import Archetype, Card, CardType, DEF_ID_DEBT, DEF_ID_RUBBLE
from .effects import ConditionType, EffectType

# Value of one VP in resource-equivalents. Land Grant (7 resources, a dead
# card) is the market's exchange rate; a VP scored is permanent, so it is worth
# a little more than its sticker price once the deck is mature.
VP_RE = 7.5

# Rough game length (rounds) by grid size used before the VP race gives a
# measurable pace.
_ROUND_PRIOR = {"small": 10, "medium": 13, "large": 16, "mega": 18, "ultra": 20}

# Static claim value by power (RE per play). Power thresholds track the board
# (a tie against a neutral tile's intrinsic defense goes to the attacker):
# 1 takes VP-adjacent tiles (defense 1) and beats Explore races, 2 takes
# standard VP hexes (defense 2), 3 takes premium VP hexes (defense 3) and
# undefended enemy standard hexes, 4+ breaks enemy premium / defended hexes.
_CLAIM_CURVE = [1.7, 2.6, 4.4, 5.9, 7.0, 7.9, 8.5]


def claim_curve(power: float) -> float:
    if power <= 0:
        return _CLAIM_CURVE[0]
    if power >= len(_CLAIM_CURVE) - 1:
        return _CLAIM_CURVE[-1] + 0.35 * (power - (len(_CLAIM_CURVE) - 1))
    lo = int(power)
    frac = power - lo
    return _CLAIM_CURVE[lo] + (_CLAIM_CURVE[lo + 1] - _CLAIM_CURVE[lo]) * frac


def active_cards(player: Any) -> list[Card]:
    cards: list[Card] = list(player.hand)
    deck = getattr(player, "deck", None)
    if deck is not None:
        cards.extend(deck.cards)
        cards.extend(deck.discard)
    cards.extend(a.card for a in getattr(player, "planned_actions", []) or [])
    return cards


def upgraded_copy(card: Card) -> Card:
    c = copy.copy(card)
    c.is_upgraded = True
    return c


@dataclass(frozen=True)
class ValuationTuning:
    """Per-difficulty weights on the valuation model (1.0 = neutral)."""

    claim_mult: float = 1.0      # scales claim play value
    defense_mult: float = 1.0    # scales defense play value
    engine_mult: float = 1.0     # scales special engine effects
    draw_mult: float = 1.0       # scales card-draw value
    vp_re: float = VP_RE         # resource-equivalent of one VP
    upgrade_mult: float = 1.0    # scales upgrade gains


DEFAULT_TUNING = ValuationTuning()


@dataclass
class ValuationContext:
    """Board + deck facts shared by every valuation in one decision."""

    player_id: str
    archetype: Archetype
    progress: float                 # 0..1 estimated progress through the game
    rounds_left: float              # estimated rounds until someone wins
    deck_size: int
    hand_size: int
    avg_value: float                # mean play value of the current deck
    income_per_hand: float          # expected resources per drawn hand
    draw_per_hand: float            # surplus draws per hand (beyond replacing itself)
    actions_per_hand: float         # surplus actions per hand
    high_power_claims: int          # claims with power >= 3 in deck
    claim_count: int
    neutral_frontier: int           # unowned, undefended tiles adjacent to us
    vp_target_defense: list[int]    # claim power needed to take each non-owned VP hex within 2 steps
    owned_vp_hexes: int
    opp_max_power: float            # best claim power seen in any opponent deck
    opp_has_power: bool             # any opponent owns a power >= 3 claim
    tiles_owned: int
    tuning: ValuationTuning = DEFAULT_TUNING
    opponents: int = 1              # active opponents (Diplomat's gifts scale with it)

    @property
    def actions_factor(self) -> float:
        """Chance an extra drawn card can actually be played (needs spare actions)."""
        return min(1.0, 0.35 + 0.5 * self.actions_per_hand)

    @property
    def cards_factor(self) -> float:
        """Chance an extra action finds a card to spend it on (needs spare cards)."""
        return min(1.0, 0.25 + 0.5 * self.draw_per_hand)


def _vp_pace_rounds_left(game: Any) -> float:
    from .game_state import compute_player_vp

    max_r = getattr(game, "max_rounds", 20) or 20
    hard_left = max(1, max_r - game.current_round + 1)
    grid = getattr(game, "grid", None)
    size = getattr(getattr(grid, "size", None), "value", "small")
    prior_total = _ROUND_PRIOR.get(size, 12)
    prior_left = max(2.0, prior_total - game.current_round + 1)
    target = getattr(game, "vp_target", 10) or 10
    leader = max((compute_player_vp(game, pid) for pid in game.players), default=0)
    if game.current_round >= 4 and leader > 0:
        rate = leader / max(1, game.current_round - 1)
        pace_left = max(1.0, (target - leader) / max(rate, 0.4))
        # Blend toward the measured pace as the game matures.
        w = min(1.0, (game.current_round - 3) / 4)
        est = (1 - w) * prior_left + w * pace_left
    else:
        est = prior_left
    return float(max(1.0, min(hard_left, est)))


def _base_value(card: Card) -> float:
    """Context-free play value used for the deck average (cheap, stable)."""
    if card.unplayable:
        return 0.0
    v = float(card.effective_resource_gain)
    if card.card_type == CardType.CLAIM:
        p = card.effective_power
        v += claim_curve(p) * (0.55 if card.effective_unoccupied_only else 1.0)
        for e in card.effects:
            if e.type == EffectType.PLAY_RESOURCE_COST:
                v -= e.effective_value(card.is_upgraded)
    elif card.card_type == CardType.DEFENSE:
        v += 0.8 + 0.6 * card.effective_defense_bonus
    elif card.card_type == CardType.ENGINE and v == 0:
        v += 1.4  # typical engine utility
    v += 1.0 * card.effective_draw_cards
    v -= 2.0 * debts_taken(card)
    if card.definition_id == DEF_ID_DEBT:
        v = -0.5
    return max(0.0, v)


def debts_taken(card: Card) -> int:
    """Debt cards a play of *card* adds to your deck (Mercenary, Garrison, …)."""
    return sum(e.effective_value(card.is_upgraded) for e in card.effects if e.type == EffectType.GAIN_DEBT)


def debt_cost(ctx: "ValuationContext") -> float:
    """Value (RE) one new Debt costs: when it's drawn it takes a hand slot,
    and clearing it takes 3 resources and an action. Late in the game it may
    never come round again."""
    return min(1.0, expected_plays(ctx)) * (3.0 + ctx.avg_value)


def build_context(game: Any, player_id: str, board_aware: bool = True,
                  tuning: ValuationTuning = DEFAULT_TUNING) -> ValuationContext:
    """Snapshot the facts valuation needs. With *board_aware* off the board
    readings are replaced by neutral defaults, so cards are valued on the
    static curve alone (used by the Medium tier)."""

    player = game.players[player_id]
    cards = active_cards(player)
    n = max(1, len(cards))
    hand_size = getattr(player, "hand_size", 5) or 5
    income = sum(c.effective_resource_gain for c in cards) / n * hand_size
    draws = sum(max(0, c.effective_draw_cards - 0) for c in cards) / n * hand_size
    actions = sum(max(0, c.effective_action_return) for c in cards) / n * hand_size
    avg = sum(_base_value(c) for c in cards) / n
    hp = sum(1 for c in cards if c.card_type == CardType.CLAIM and c.effective_power >= 3)
    claims = sum(1 for c in cards if c.card_type == CardType.CLAIM)

    neutral_frontier = 0
    vp_defs: list[int] = []
    owned_vp = 0
    tiles_owned = 0
    grid = game.grid
    if grid is not None:
        mine = grid.get_player_tiles(player_id)
        tiles_owned = len(mine)
        owned_vp = sum(1 for t in mine if t.is_vp)
        seen: set[tuple[int, int]] = set()
        ring1: list[Any] = []
        for t in mine:
            for a in grid.get_adjacent(t.q, t.r):
                k = (a.q, a.r)
                if k in seen or a.owner == player_id or a.is_blocked:
                    continue
                seen.add(k)
                ring1.append(a)
                if a.owner is None and a.defense_power == 0:
                    neutral_frontier += 1
        reach = list(ring1)
        for a in ring1:
            for b in grid.get_adjacent(a.q, a.r):
                k = (b.q, b.r)
                if k in seen or b.owner == player_id or b.is_blocked:
                    continue
                seen.add(k)
                reach.append(b)
        for t in reach:
            if t.is_vp:
                # Ties against neutral intrinsic defense go to the attacker;
                # an owner wins ties, so an owned hex needs one more.
                needed = int(t.base_defense + t.permanent_defense_bonus)
                vp_defs.append(needed if t.owner is None else needed + 1)

    opp_max = 0.0
    opponents = 0
    for pid, p in game.players.items():
        if pid == player_id or getattr(p, "has_left", False):
            continue
        opponents += 1
        for c in active_cards(p):
            if c.card_type == CardType.CLAIM:
                opp_max = max(opp_max, float(c.effective_power))

    from .cpu_player import _game_progress  # local import: avoid cycle at module load

    if not board_aware:
        neutral_frontier = 5
        vp_defs = []
        opp_max = 3.0

    return ValuationContext(
        player_id=player_id,
        archetype=player.archetype,
        progress=_game_progress(game),
        rounds_left=_vp_pace_rounds_left(game),
        deck_size=len(cards),
        hand_size=hand_size,
        avg_value=avg,
        income_per_hand=income,
        draw_per_hand=draws,
        actions_per_hand=actions,
        high_power_claims=hp,
        claim_count=claims,
        neutral_frontier=neutral_frontier,
        vp_target_defense=vp_defs,
        owned_vp_hexes=owned_vp,
        opp_max_power=opp_max,
        opp_has_power=opp_max >= 3,
        tiles_owned=tiles_owned,
        tuning=tuning,
        opponents=max(1, opponents),
    )


def estimated_claim_power(card: Card, ctx: ValuationContext) -> float:
    power = float(card.effective_power)
    for e in card.effects:
        if e.type == EffectType.POWER_PER_TILES_OWNED:
            divisor = e.effective_value(card.is_upgraded) or 3
            # Assume a couple more tiles over the card's life.
            bonus = (ctx.tiles_owned + 2) // divisor
            power = float(bonus) if e.metadata.get("replaces_base_power") else power + bonus
        elif e.type == EffectType.POWER_MODIFIER:
            ev = e.effective_value(card.is_upgraded)
            if e.condition == ConditionType.CARDS_IN_HAND:
                power = max(power, 3.0 + ev)
            elif e.metadata.get("per_tile"):
                power += ev * 1.5
            elif e.condition == ConditionType.IF_BRIDGES_TERRITORY:
                # Road Builder: a bridging target is uncommon; mostly base power.
                power += ev * 0.15
            else:
                power += ev * 0.5
        elif e.type == EffectType.STACKING_POWER_BONUS:
            power += e.effective_value(card.is_upgraded) * 0.5
    return power


def _claim_value(card: Card, ctx: ValuationContext) -> float:
    if any(e.type == EffectType.ADJACENCY_BRIDGE for e in card.effects):
        return 1.5  # Road Builder: rarely has a legal target
    power = estimated_claim_power(card, ctx)
    v = claim_curve(power)

    # Board modulation: a card that can break a reachable VP hex right now is
    # worth more; one that can only take neutral dirt is worth less once the
    # frontier dries up.
    if ctx.vp_target_defense:
        breakable = [d for d in ctx.vp_target_defense if power >= d]
        if breakable:
            v += 1.2 + 0.4 * min(3, len(breakable))
    if power < 1 and ctx.neutral_frontier <= 2:
        v *= 0.6

    if card.effective_unoccupied_only:
        v *= 0.55
    if card.stackable:
        v += 0.6
    if card.claim_range > 1 or not card.adjacency_required:
        v += 0.8
    if card.effective_multi_target_count > 0:
        v += card.effective_multi_target_count * 0.55 * claim_curve(power)
    if card.flood:
        v += 2.5 + 0.8 * power
    if card.action_cost >= 2:
        v -= max(1.2, ctx.avg_value) * (1.0 - 0.5 * ctx.cards_factor)

    for e in card.effects:
        val = e.effective_value(card.is_upgraded)
        t = e.type
        if t == EffectType.PLAY_RESOURCE_COST:
            v -= val
        elif t == EffectType.DRAW_NEXT_TURN:
            v += 0.7 * val * ctx.avg_value
        elif t in (EffectType.AUTO_CLAIM_ADJACENT_NEUTRAL, EffectType.AUTO_CLAIM_IF_NEUTRAL):
            v += 1.6
        elif t == EffectType.RESOURCE_REFUND_IF_NEUTRAL or (
            t == EffectType.GAIN_RESOURCES and e.condition == ConditionType.IF_TARGET_NEUTRAL
        ):
            # Juggernaut: +R when it targets a neutral tile
            v += 0.5 * max(1, val)
        elif t == EffectType.RESOURCE_DRAIN:
            v += 0.5 * max(1, val)
        elif t == EffectType.IGNORE_DEFENSE:
            v += 1.0
        elif t == EffectType.IMMEDIATE_RESOLVE:
            v += 0.8
        elif t == EffectType.TRASH_OPPONENT_CARD:
            v += 1.0
        elif t == EffectType.MANDATORY_SELF_TRASH:
            # Trashing weak starters is partly a benefit; cap the downside.
            v -= 0.6 * val
        elif t == EffectType.GRANT_ACTIONS_NEXT_TURN and e.target == "self":
            v += 0.6 * val
        elif t == EffectType.GRANT_ACTIONS_IF_STACKED:
            v += 0.4 * val
        elif t == EffectType.ON_DEFEND_FORCED_DISCARD:
            v += 0.5
        elif t == EffectType.CONDITIONAL_ACTION_RETURN:
            v += 0.5 * ctx.avg_value * ctx.cards_factor
    if card.forced_discard > 0:
        v += 0.9 * card.forced_discard
    return v


# Flat RE value of engine effects that are hard to model exactly. Values are
# deliberately modest: the explicit resource/draw/action stats carry most of
# an engine card's worth.
_ENGINE_EFFECT_RE: dict[EffectType, float] = {
    EffectType.CYCLE: 1.2,
    EffectType.CONDITIONAL_ACTION: 0.4,
    EffectType.RESOURCE_SCALING: 1.6,
    EffectType.RESOURCE_PER_VP_HEX: 1.5,
    EffectType.RESOURCES_PER_TILES_LOST: 0.8,
    EffectType.ACTIONS_PER_CARDS_PLAYED: 1.2,
    EffectType.NEXT_TURN_BONUS: 2.0,
    EffectType.MULLIGAN: 0.8,
    EffectType.SWAP_DRAW_DISCARD: 0.6,
    EffectType.GLOBAL_RANDOM_TRASH: 1.2,
    EffectType.INJECT_RUBBLE: 1.4,
    EffectType.GLOBAL_CLAIM_BAN: 1.0,
    EffectType.ABANDON_TILE: 0.6,
    EffectType.ABANDON_AND_BLOCK: 0.8,
    EffectType.CONDITIONAL_DRAW_NEXT_ROUND: 1.5,
    EffectType.RESOURCES_PER_TILES_CAPTURED_LAST_ROUND: 1.3,
    EffectType.RESOURCES_PER_CLAIMS_LAST_ROUND: 2.0,
    EffectType.CONDITIONAL_DRAW: 1.0,
    EffectType.DRAW_PER_TILES_OWNED: 1.8,
    EffectType.DRAW_PER_TILES_WITH_DEFENSE_BONUS: 1.2,
    EffectType.GAIN_RESOURCES_PER_CARD_IN_HAND: 1.0,
    EffectType.CREATE_CARDS_TO_DISCARD: 1.0,
    EffectType.GRANT_ACTIONS_NEXT_ROUND_PER_SUCCESSFUL_CLAIM: 1.2,
    EffectType.GRANT_STACKABLE: 1.0,
    EffectType.DECK_PEEK: 0.5,
    EffectType.FREE_REROLL: 0.6,
    EffectType.COST_REDUCTION: 1.2,
    EffectType.DRAW_PER_CONNECTED_VP: 1.6,
    EffectType.RESOURCES_PER_TILES_OWNED: 2.0,
    EffectType.SEARCH_ZONE: 1.4,
    EffectType.TRASH_GAIN_POWER: 1.0,
}


def thinning_value(card: Card, ctx: ValuationContext) -> float:
    """Per-play value of trashing weak cards from hand (Cull & co)."""
    n = 0
    for e in card.effects:
        if e.type in (EffectType.SELF_TRASH, EffectType.TRASH_GAIN_BUY_COST,
                      EffectType.TRASH_GAIN_POWER):
            n += max(1, e.effective_value(card.is_upgraded))
    if n == 0:
        return 0.0
    # Removing a below-average card raises every future draw a little. Only
    # pays off with enough game left for the deck to cycle a few times.
    weak_gap = max(0.0, ctx.avg_value - 1.2)
    cycles = ctx.rounds_left * ctx.hand_size / max(1, ctx.deck_size)
    return n * (0.6 + weak_gap * min(3.0, cycles) * 0.5)


def card_play_value(card: Card, ctx: ValuationContext,
                    weights: Optional[Any] = None) -> float:
    """Estimated value (RE) of playing *card* once in the current context."""
    if card.unplayable:
        return 0.0
    if card.definition_id in (DEF_ID_DEBT, DEF_ID_RUBBLE):
        return 0.0

    tn = ctx.tuning
    v = float(card.effective_resource_gain)
    draws = card.effective_draw_cards
    v += draws * ctx.avg_value * ctx.actions_factor * tn.draw_mult
    if card.effective_action_return >= 1:
        # A "free" card doesn't consume a slot; the slot it saves only matters
        # if there is a spare card to spend it on.
        v += card.effective_action_return * 0.8 * ctx.avg_value * ctx.cards_factor
        if draws >= 1:
            # Cantrip-with-action: the draw is fully usable.
            v += draws * ctx.avg_value * (1.0 - ctx.actions_factor)

    if card.card_type == CardType.CLAIM:
        v += _claim_value(card, ctx) * tn.claim_mult
    elif card.card_type == CardType.DEFENSE:
        threat = 0.6 + 0.35 * max(0.0, ctx.opp_max_power - 1)
        threat = max(0.6, min(2.2, threat))
        if ctx.owned_vp_hexes:
            threat *= 1.25
        d = card.effective_defense_bonus
        for e in card.effects:
            if e.type == EffectType.DEFENSE_PER_ADJACENT:
                d += 2
        dv = 0.55 * d * threat
        for e in card.effects:
            if e.type == EffectType.PERMANENT_DEFENSE:
                dv += 0.9 * e.effective_value(card.is_upgraded) * threat
            elif e.type == EffectType.TILE_IMMUNITY:
                dv += 1.8 * max(1, e.duration) * threat
            elif e.type == EffectType.IGNORE_DEFENSE_OVERRIDE:
                dv += 0.6
        if card.effective_defense_target_count > 1:
            dv *= 1.0 + 0.5 * (card.effective_defense_target_count - 1)
        v += dv * tn.defense_mult
    else:
        for e in card.effects:
            base = _ENGINE_EFFECT_RE.get(e.type)
            if base is not None:
                v += base * tn.engine_mult
            elif e.type == EffectType.GAIN_VP:
                v += e.effective_value(card.is_upgraded) * tn.vp_re
            elif e.type == EffectType.CLAIM_BUFF_NEXT_N:
                # War Banner (+2, draw on success), Swarm Tactics (+1),
                # Rally Cry+ (+1 on the next 5). Only ~3 Claims a round can use it.
                charges = min(3, e.effective_value(card.is_upgraded))
                bonus = float(e.metadata.get("power_bonus", 0))
                draw = float(e.metadata.get("draw_next_round_on_success", 0))
                v += charges * (1.0 * bonus + 0.4 * draw) * tn.engine_mult
            elif e.type == EffectType.DRAW_NEXT_TURN and e.condition == ConditionType.ALWAYS:
                # Plunder / Battle Cry / Iron Discipline: draw next round
                v += 0.7 * e.effective_value(card.is_upgraded) * ctx.avg_value * tn.draw_mult
            elif e.type == EffectType.GRANT_ACTIONS and e.target == "self":
                v += e.effective_value(card.is_upgraded) * 0.8 * ctx.avg_value * ctx.cards_factor
            elif e.type == EffectType.BUY_RESTRICTION:
                v -= 1.5
            elif e.type == EffectType.GRANT_ACTIONS_NEXT_TURN and e.target != "self":
                v -= 0.6 * e.effective_value(card.is_upgraded)
            elif e.type == EffectType.SELF_DISCARD:
                v -= 0.6 * e.effective_value(card.is_upgraded)
            elif e.type == EffectType.GRANT_LAND_GRANTS:
                # Diplomat: net VP over the table (Land Grants are dead cards,
                # so only half credit).
                from .effect_resolver import land_grant_counts
                mine, theirs = land_grant_counts(e, card.is_upgraded)
                net = mine - theirs * ctx.opponents
                v += max(0.5, 0.5 * net * tn.vp_re)
        if card.forced_discard > 0:
            v += 0.9 * card.forced_discard
        v += thinning_value(card, ctx)
        if weights is not None:
            # Archetype flavor: lean slightly toward the archetype's plan.
            v *= 0.85 + 0.15 * float(getattr(weights, "resource_value", 1.0))

    v -= debts_taken(card) * debt_cost(ctx)
    if card.effective_trash_on_use and card.card_type != CardType.CLAIM:
        v *= 0.9
    return v


def expected_plays(ctx: ValuationContext, extra_cards: int = 1) -> float:
    """Expected number of times a newly added card is drawn before game end."""
    deck_after = max(1, ctx.deck_size + extra_cards)
    # Card goes to the discard first; it needs a reshuffle before being drawn.
    effective_rounds = max(0.0, ctx.rounds_left - 0.5 * deck_after / ctx.hand_size)
    return max(0.0, effective_rounds * ctx.hand_size / deck_after)


def one_time_vp(card: Card, player: Any, game: Any) -> float:
    vp = float(max(0, getattr(card, "passive_vp", 0)))
    if getattr(card, "vp_formula", ""):
        from .cpu_player import _projected_formula_vp
        vp += _projected_formula_vp(card, player, game)
    return vp


def purchase_value(card: Card, player: Any, game: Any, ctx: ValuationContext,
                   weights: Optional[Any] = None) -> float:
    """Marginal value (RE) of adding *card* to the deck now."""
    vp_value = one_time_vp(card, player, game) * ctx.tuning.vp_re
    vp_value -= getattr(card, "buy_debt", 0) * debt_cost(ctx)  # Warden, Land Grant
    plays = expected_plays(ctx)
    if card.unplayable:
        # Dead card: every draw displaces an average card.
        return vp_value - plays * ctx.avg_value
    pv = card_play_value(card, ctx, weights)
    if card.effective_trash_on_use:
        return vp_value + min(1.0, plays) * pv - 0.3
    return vp_value + plays * (pv - ctx.avg_value)


def upgrade_gain(card: Card, player: Any, game: Any, ctx: ValuationContext,
                 weights: Optional[Any] = None) -> float:
    """Value (RE) of permanently upgrading *card* (one copy)."""
    if card.is_upgraded or card.unplayable:
        return 0.0
    if card.buy_cost is None and not card.starter:
        return 0.0
    up = upgraded_copy(card)
    gain = card_play_value(up, ctx, weights) - card_play_value(card, ctx, weights)
    if gain <= 0:
        return 0.0
    # Upgrade lands in the current hand: it is played this turn and again on
    # every later reshuffle.
    later = max(0.0, ctx.rounds_left - 1) * ctx.hand_size / max(1, ctx.deck_size)
    return gain * (1.0 + later) * ctx.tuning.upgrade_mult


def best_upgrade_gain(player: Any, game: Any, ctx: ValuationContext,
                      cards: Iterable[Card], weights: Optional[Any] = None) -> float:
    best = 0.0
    for c in cards:
        best = max(best, upgrade_gain(c, player, game, ctx, weights))
    return best
