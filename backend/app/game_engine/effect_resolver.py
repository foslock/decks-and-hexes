"""Effect resolution engine.

Dispatches card effects to handler functions based on EffectType.
New effects can be added by registering a handler via register_handler().
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional

from .cards import (
    Card,
    CardType,
    DEF_ID_DEBT,
    Timing,
    make_land_grant_card,
    make_rubble_card,
)
from .effects import ConditionType, Effect, EffectType

if TYPE_CHECKING:
    from .game_state import GameState, PlannedAction, Player

logger = logging.getLogger(__name__)


@dataclass
class EffectContext:
    """Context passed to effect handlers during resolution."""

    game: GameState
    player: Player
    card: Card
    action: PlannedAction
    # Player choices sent with play_card()
    discard_card_indices: list[int] = field(default_factory=list)
    trash_card_indices: list[int] = field(default_factory=list)
    extra_targets: list[tuple[int, int]] = field(default_factory=list)
    # Set during reveal phase
    claim_succeeded: Optional[bool] = None
    # The tile key for the target (if applicable)
    target_tile_key: Optional[str] = None
    # The defending player id (if applicable)
    defender_id: Optional[str] = None
    # Claim results from reveal phase (tile_key -> {pid -> succeeded})
    claim_results: Optional[dict[str, dict[str, bool]]] = None


# ── Handler registry ──────────────────────────────────────────────

HandlerFn = Callable[[Effect, EffectContext], None]
_HANDLERS: dict[EffectType, HandlerFn] = {}


def register_handler(effect_type: EffectType, handler: HandlerFn) -> None:
    """Register a handler function for an effect type."""
    _HANDLERS[effect_type] = handler


def _dispatch(effect: Effect, ctx: EffectContext) -> None:
    """Dispatch a single effect to its handler."""
    handler = _HANDLERS.get(effect.type)
    if handler is None:
        logger.warning("No handler for effect type %s", effect.type)
        ctx.game._log(f"[STUB] Effect {effect.type.value} not yet implemented")
        return
    handler(effect, ctx)


# ── Public API ────────────────────────────────────────────────────


def resolve_immediate_effects(
    game: GameState,
    player: Player,
    card: Card,
    action: PlannedAction,
    discard_card_indices: Optional[list[int]] = None,
    trash_card_indices: Optional[list[int]] = None,
    extra_targets: Optional[list[tuple[int, int]]] = None,
    skip_discard: bool = False,
) -> None:
    """Resolve all IMMEDIATE-timing effects on a card. Called from play_card()."""
    ctx = EffectContext(
        game=game,
        player=player,
        card=card,
        action=action,
        discard_card_indices=discard_card_indices or [],
        trash_card_indices=trash_card_indices or [],
        extra_targets=extra_targets or [],
    )
    if action.target_q is not None:
        target_r = action.target_r if action.target_r is not None else 0
        ctx.target_tile_key = f"{action.target_q},{target_r}"

    for effect in card.effects:
        if effect.timing == Timing.IMMEDIATE:
            # Skip self_discard when deferred (draw-then-discard cards like Regroup)
            if skip_discard and effect.type == EffectType.SELF_DISCARD:
                continue
            if effect.condition != ConditionType.ALWAYS:
                if not check_condition(effect.condition, game, player, card, action):
                    continue
            _dispatch(effect, ctx)


def calculate_effective_power(
    game: GameState,
    player: Player,
    card: Card,
    action: PlannedAction,
    include_stacking_bonus: bool = True,
) -> int:
    """Calculate total power for a claim card including conditional modifiers.

    If the action already has a snapshotted effective_power (computed at play
    time), that frozen intrinsic value is used as the base. Otherwise the
    intrinsic value is computed from the card's own effects against the
    current game state.

    STACKING_POWER_BONUS (Dog Pile) is applied on top and is *not*
    snapshotted — the tile may gain or lose stacking sources after this
    card is played, so the bonus must be recomputed from the player's
    current planned_actions at resolve time.

    Pass `include_stacking_bonus=False` when the caller is itself snapshotting
    this action's intrinsic power (to avoid double-counting at resolve).
    """
    # Intrinsic power: either the frozen snapshot (if a dynamic modifier
    # applied at play time) or computed fresh from the card's own effects.
    if action.effective_power is not None:
        intrinsic = action.effective_power
    else:
        intrinsic = _calculate_intrinsic_power(game, player, card, action)

    if not include_stacking_bonus or card.card_type != CardType.CLAIM or action.target_q is None:
        return intrinsic

    return intrinsic + _stacking_power_bonus(player, action)


def _stacking_power_bonus(player: Player, action: PlannedAction) -> int:
    """Sum of STACKING_POWER_BONUS values from OTHER claims by this player on
    the same tile as `action`. Dog Pile's +1 doesn't apply to itself.
    """
    if action.target_q is None:
        return 0
    tq = action.target_q
    tr = action.target_r if action.target_r is not None else 0
    bonus = 0
    for other in player.planned_actions:
        if other is action:
            continue
        if other.card.card_type != CardType.CLAIM:
            continue
        other_r = other.target_r if other.target_r is not None else 0
        if other.target_q != tq or other_r != tr:
            continue
        for eff in other.card.effects:
            if eff.type == EffectType.STACKING_POWER_BONUS:
                bonus += eff.effective_value(other.card.is_upgraded)
    return bonus


def _calculate_intrinsic_power(
    game: GameState,
    player: Player,
    card: Card,
    action: PlannedAction,
) -> int:
    """Compute power from this card's own effects only (no stacking bonus).
    This is the value that gets snapshotted at play time.
    """
    base_power = card.effective_power
    bonus = 0

    target_q = action.target_q
    target_r = action.target_r if action.target_r is not None else 0

    is_upgraded = card.is_upgraded

    for effect in card.effects:
        if effect.type == EffectType.POWER_PER_TILES_OWNED:
            # Mob Rule / Locust Swarm: power based on total tiles owned
            divisor = effect.effective_value(is_upgraded)
            if divisor <= 0:
                divisor = 3
            if game.grid:
                tile_count = len(game.grid.get_player_tiles(player.id))
                tile_bonus: int = tile_count // divisor
                if effect.metadata.get("replaces_base_power"):
                    # Locust Swarm: power = tiles / divisor (replaces base)
                    return tile_bonus
                else:
                    # Mob Rule: adds to base power
                    bonus += tile_bonus
            continue

        if effect.type == EffectType.POWER_PER_SAME_NAME:
            # Rabble+: +value power per same-name card played this round
            if effect.metadata.get("upgraded_only") and not is_upgraded:
                continue
            base_name = card.name.rstrip("+")
            same_count = sum(
                1 for a in player.planned_actions
                if a.card.name.rstrip("+") == base_name and a.card.id != card.id
            )
            bonus += effect.effective_value(is_upgraded) * same_count
            continue

        if effect.type != EffectType.POWER_MODIFIER:
            continue
        if not check_condition(effect.condition, game, player, card, action):
            continue

        ev = effect.effective_value(is_upgraded)

        if effect.condition == ConditionType.CARDS_IN_HAND:
            # Strength in Numbers: power = other cards in hand (not including this card)
            return int(max(0, len(player.hand) - 1) + ev)

        if effect.condition == ConditionType.IF_ADJACENT_OWNED_GTE:
            if effect.metadata.get("per_tile"):
                # Overwhelm: +value per adjacent owned tile
                if game.grid and target_q is not None:
                    adj_tiles = game.grid.get_adjacent(target_q, target_r)
                    owned_adj = sum(1 for t in adj_tiles if t.owner == player.id)
                    bonus += ev * owned_adj
            else:
                # Militia: flat bonus if threshold met
                bonus += ev
        else:
            # Generic conditional bonus (Strike Team, Garrison, Battering Ram, etc.)
            bonus += ev

    return base_power + bonus


def resolve_on_resolution_effects(
    game: GameState,
    player: Player,
    card: Card,
    action: PlannedAction,
    claim_succeeded: Optional[bool] = None,
    defender_id: Optional[str] = None,
    claim_results: Optional[dict[str, dict[str, bool]]] = None,
) -> None:
    """Resolve ON_RESOLUTION-timing effects. Called from execute_reveal()."""
    ctx = EffectContext(
        game=game,
        player=player,
        card=card,
        action=action,
        claim_succeeded=claim_succeeded,
        defender_id=defender_id,
        claim_results=claim_results,
    )
    if action.target_q is not None:
        target_r = action.target_r if action.target_r is not None else 0
        ctx.target_tile_key = f"{action.target_q},{target_r}"

    for effect in card.effects:
        if effect.timing != Timing.ON_RESOLUTION:
            continue
        # Skip power_modifier — already handled in calculate_effective_power
        if effect.type == EffectType.POWER_MODIFIER:
            continue
        if not check_condition(effect.condition, game, player, card, action,
                               claim_succeeded=claim_succeeded):
            continue
        _dispatch(effect, ctx)


# ── Condition evaluation ──────────────────────────────────────────


def check_condition(
    condition: ConditionType,
    game: GameState,
    player: Player,
    card: Card,
    action: PlannedAction,
    claim_succeeded: Optional[bool] = None,
) -> bool:
    """Evaluate whether a condition is met."""
    if condition == ConditionType.ALWAYS:
        return True

    if condition == ConditionType.IF_SUCCESSFUL:
        return claim_succeeded is True

    if condition == ConditionType.IF_DEFENDER_HOLDS:
        return claim_succeeded is False

    if condition == ConditionType.IF_PLAYED_CLAIM_THIS_TURN:
        # Check if player played another Claim card this turn
        other_claims = [
            a for a in player.planned_actions
            if a.card.card_type == CardType.CLAIM and a.card.id != card.id
        ]
        return len(other_claims) > 0

    if condition == ConditionType.IF_ADJACENT_OWNED_GTE:
        # Evaluated in calculate_effective_power with threshold
        # Here we just check if there are ANY adjacent owned tiles
        if game.grid and action.target_q is not None:
            target_r = action.target_r if action.target_r is not None else 0
            adj_tiles = game.grid.get_adjacent(action.target_q, target_r)
            owned_adj = sum(1 for t in adj_tiles if t.owner == player.id)
            # Find the effect to get the threshold
            for eff in card.effects:
                if (eff.type == EffectType.POWER_MODIFIER
                        and eff.condition == ConditionType.IF_ADJACENT_OWNED_GTE):
                    return bool(owned_adj >= eff.condition_threshold)
            return bool(owned_adj >= 1)
        return False

    if condition == ConditionType.CARDS_IN_HAND:
        return True  # Always applies (value computed in power calculation)

    if condition == ConditionType.IF_DEFENDING_OWNED:
        # True if the target tile is already owned by this player
        if game.grid and action.target_q is not None:
            target_r = action.target_r if action.target_r is not None else 0
            tile = game.grid.get_tile(action.target_q, target_r)
            return tile is not None and tile.owner == player.id
        return False

    if condition == ConditionType.IF_TARGET_NEUTRAL:
        if game.grid and action.target_q is not None:
            target_r = action.target_r if action.target_r is not None else 0
            tile = game.grid.get_tile(action.target_q, target_r)
            return tile is not None and tile.owner is None
        return False

    if condition == ConditionType.IF_PLAYED_SAME_NAME:
        # Rabble: check if another Rabble/Rabble+ was played this turn
        base_name = card.name.rstrip("+")
        same_name = [
            a for a in player.planned_actions
            if a.card.name.rstrip("+") == base_name and a.card.id != card.id
        ]
        return len(same_name) > 0

    if condition == ConditionType.TILES_MORE_THAN_DEFENDER:
        # Cheap Shot: check if player owns more tiles than target tile's controller
        if game.grid and action.target_q is not None:
            target_r = action.target_r if action.target_r is not None else 0
            tile = game.grid.get_tile(action.target_q, target_r)
            if tile and tile.owner and tile.owner != player.id:
                player_tiles = len(game.grid.get_player_tiles(player.id))
                defender_tiles = len(game.grid.get_player_tiles(tile.owner))
                return player_tiles > defender_tiles
        return False

    if condition == ConditionType.VP_HEXES_CONTROLLED:
        # Elite Vanguard: always true (value scaled by VP hex count)
        return True

    if condition == ConditionType.FEWEST_TILES:
        # Catch Up: true if player controls fewest (or tied for fewest) tiles
        if game.grid:
            player_count = len(game.grid.get_player_tiles(player.id))
            for pid, other in game.players.items():
                if pid != player.id:
                    other_count = len(game.grid.get_player_tiles(pid))
                    if other_count < player_count:
                        return False
            return True
        return False

    if condition == ConditionType.IF_TARGET_HAS_DEFENSE:
        # Battering Ram: true if target tile has any defense bonuses (permanent or round-based)
        if game.grid and action.target_q is not None:
            target_r = action.target_r if action.target_r is not None else 0
            tile = game.grid.get_tile(action.target_q, target_r)
            if tile:
                has_defense = tile.permanent_defense_bonus > 0 or tile.defense_power > 0
                return has_defense
        return False

    if condition == ConditionType.ZERO_ACTIONS:
        # Scavenge: true if player has 0 actions remaining after playing this card
        remaining = player.actions_available - player.actions_used
        return remaining <= 0

    if condition == ConditionType.HAND_SIZE_LTE:
        # Spyglass: condition evaluated inside handler (after draw resolves)
        return True

    if condition == ConditionType.IF_CONTESTED:
        # Ambush: true if the target tile is also claimed by another player this round.
        # At play time we don't know yet (other players haven't revealed), so return False.
        # This is evaluated during resolve phase when claim_results are available.
        if action.target_q is None:
            return False
        target_r = action.target_r if action.target_r is not None else 0
        tile_key = f"{action.target_q},{target_r}"
        # Check if any other player also has a claim on this tile
        for pid, other in game.players.items():
            if pid == player.id:
                continue
            for other_action in other.planned_actions:
                if other_action.card.card_type != CardType.CLAIM:
                    continue
                if other_action.target_q is None:
                    continue
                other_r = other_action.target_r if other_action.target_r is not None else 0
                if f"{other_action.target_q},{other_r}" == tile_key:
                    return True
        # Also contested if tile is already owned by another player
        if game.grid:
            tile = game.grid.get_tile(action.target_q, target_r)
            if tile and tile.owner is not None and tile.owner != player.id:
                return True
        return False

    return False


# ── Effect handlers ───────────────────────────────────────────────


def _handle_gain_resources(effect: Effect, ctx: EffectContext) -> None:
    """Catch Up: gain resources (conditionally)."""
    amount = effect.effective_value(ctx.card.is_upgraded)
    ctx.player.resources += amount
    ctx.game._log(
        f"{ctx.player.name} gains {amount} resource(s) from {ctx.card.name}",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_self_discard(effect: Effect, ctx: EffectContext) -> None:
    """Player chooses card(s) to discard from hand."""
    if not ctx.player.hand:
        ctx.game._log(f"{ctx.player.name}: no cards to discard, skipping",
                      visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    count = min(effect.value, len(ctx.player.hand))
    indices = ctx.discard_card_indices[:count]

    if not indices:
        # No indices provided — skip (player has no cards or didn't choose)
        if ctx.player.hand:
            ctx.game._log(
                f"{ctx.player.name}: no discard choice provided for {ctx.card.name}, skipping",
                visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    # Validate and remove (process in reverse order to preserve indices)
    discarded = []
    for idx in sorted(indices, reverse=True):
        if 0 <= idx < len(ctx.player.hand):
            discarded.append(ctx.player.hand.pop(idx))

    if discarded:
        ctx.player.deck.add_to_discard(discarded)
        names = ", ".join(c.name for c in discarded)
        ctx.game._log(f"{ctx.player.name} discards {names} from hand",
                      visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_self_trash(effect: Effect, ctx: EffectContext) -> None:
    """Player chooses card(s) to trash (permanently remove) from hand."""
    if not ctx.player.hand:
        ctx.game._log(f"{ctx.player.name}: no cards to trash, skipping",
                      visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    count = min(effect.value, len(ctx.player.hand))
    indices = ctx.trash_card_indices[:count]

    if not indices:
        if ctx.player.hand:
            ctx.game._log(
                f"{ctx.player.name}: no trash choice provided for {ctx.card.name}, skipping",
                visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    trashed = []
    for idx in sorted(indices, reverse=True):
        if 0 <= idx < len(ctx.player.hand):
            card_to_trash = ctx.player.hand[idx]
            if card_to_trash.trash_immune:
                ctx.game._log(
                    f"{ctx.player.name}: {card_to_trash.name} is immune to trashing, skipping",
                    visible_to=[ctx.player.id], actor=ctx.player.id)
                continue
            trashed.append(ctx.player.hand.pop(idx))

    if trashed:
        ctx.player.trash.extend(trashed)
        names = ", ".join(c.name for c in trashed)
        ctx.game._log(f"{ctx.player.name} trashes {names} from hand",
                      visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_trash_gain_buy_cost(effect: Effect, ctx: EffectContext) -> None:
    """Consolidate: trash a card from hand, gain resources equal to half its buy cost."""
    if not ctx.player.hand:
        ctx.game._log(f"{ctx.player.name}: no cards to trash, skipping",
                      visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    indices = ctx.trash_card_indices[:1]
    if not indices:
        if ctx.player.hand:
            ctx.game._log(
                f"{ctx.player.name}: no trash choice provided for {ctx.card.name}, skipping",
                visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    idx = indices[0]
    if 0 <= idx < len(ctx.player.hand):
        trashed_card = ctx.player.hand[idx]
        if trashed_card.trash_immune:
            ctx.game._log(
                f"{ctx.player.name}: {trashed_card.name} is immune to trashing, skipping",
                visible_to=[ctx.player.id], actor=ctx.player.id)
            return
        trashed_card = ctx.player.hand.pop(idx)
        ctx.player.trash.append(trashed_card)
        base_cost = trashed_card.buy_cost or 0
        refund = base_cost // 2  # half buy cost, rounded down
        # Upgraded bonus (e.g. Fortress Consolidate+ gives +2, Neutral Consolidate+ gives +1)
        if ctx.card.is_upgraded:
            upgrade_bonus = int(effect.metadata.get("upgrade_bonus", 0))
            refund += upgrade_bonus
        ctx.player.resources += refund
        ctx.game._log(
            f"{ctx.player.name} trashes {trashed_card.name} and gains {refund} resources",
            visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_gain_vp(effect: Effect, ctx: EffectContext) -> None:
    """Land Grant: gain VP immediately."""
    ctx.player.vp += effect.value
    ctx.game._log(f"{ctx.player.name} gains {effect.value} VP from {ctx.card.name}",
                  actor=ctx.player.id)


def _handle_tile_immunity(effect: Effect, ctx: EffectContext) -> None:
    """Iron Wall / Stronghold: make a tile immune to claims."""
    all_keys: list[str] = []
    if ctx.target_tile_key:
        all_keys.append(ctx.target_tile_key)
    for eq, er in ctx.action.extra_targets:
        all_keys.append(f"{eq},{er}")
    for tk in all_keys:
        ctx.player.turn_modifiers.immune_tiles[tk] = effect.duration
        ctx.game._log(
            f"{ctx.player.name} protects tile {tk} for {effect.duration} round(s)",
            actor=ctx.player.id)


def _handle_ignore_defense(effect: Effect, ctx: EffectContext) -> None:
    """Siege Engine: claims on this tile ignore defense cards."""
    if ctx.target_tile_key:
        ctx.player.turn_modifiers.ignore_defense_tiles.add(ctx.target_tile_key)
        ctx.game._log(f"{ctx.player.name}'s claim on {ctx.target_tile_key} ignores defense cards",
                      actor=ctx.player.id)


def _handle_buy_restriction(effect: Effect, ctx: EffectContext) -> None:
    """Grand Strategy / Stampede: player cannot buy cards this round."""
    ctx.player.turn_modifiers.buy_locked = True
    ctx.game._log(f"{ctx.player.name} cannot purchase cards this round",
                  actor=ctx.player.id)
    ctx.game.player_effects.append({
        "source_player_id": ctx.player.id,
        "target_player_id": ctx.player.id,
        "card_name": ctx.card.name,
        "effect": "Buy Forfeited",
        "effect_type": "buy_restriction",
        "value": 0,
    })


def _handle_cost_reduction(effect: Effect, ctx: EffectContext) -> None:
    """Supply Line / Tactical Reserve: reduce cost of future purchases."""
    reduction = {
        "scope": effect.metadata.get("scope", "any_one_card"),
        "amount": effect.value,
        "remaining": effect.metadata.get("remaining", 1),
    }
    ctx.player.turn_modifiers.cost_reductions.append(reduction)
    ctx.game._log(f"{ctx.player.name} gains a cost reduction from {ctx.card.name}",
                  visible_to=[ctx.player.id], actor=ctx.player.id)
    ctx.game.player_effects.append({
        "source_player_id": ctx.player.id,
        "target_player_id": ctx.player.id,
        "card_name": ctx.card.name,
        "effect_type": "cost_reduction",
        "effect": f"-{effect.value} Shop Discount",
    })


def _handle_grant_actions(effect: Effect, ctx: EffectContext) -> None:
    """Grant actions to self or other players this turn."""
    if effect.target == "self":
        ctx.player.actions_available += effect.value
        ctx.game._log(
            f"{ctx.player.name} gains {effect.value} action(s) from {ctx.card.name}",
            visible_to=[ctx.player.id], actor=ctx.player.id)
    elif effect.target == "all_others":
        for pid, other in ctx.game.players.items():
            if pid != ctx.player.id:
                other.actions_available += effect.value
        ctx.game._log(f"{ctx.player.name} grants {effect.value} action(s) to all other players",
                      actor=ctx.player.id)
    elif effect.target == "chosen_player" and ctx.action.target_player_id:
        other_player = ctx.game.players.get(ctx.action.target_player_id)
        if other_player:
            other_player.actions_available += effect.value
            ctx.game._log(
                f"{ctx.player.name} grants {effect.value} action(s) to {other_player.name}",
                actor=ctx.player.id)


def _handle_grant_actions_next_turn(effect: Effect, ctx: EffectContext) -> None:
    """Battle Cry / Forced March: give other players extra actions next turn."""
    ev = effect.effective_value(ctx.card.is_upgraded)
    if effect.target == "all_others":
        for pid, other in ctx.game.players.items():
            if pid != ctx.player.id:
                other.turn_modifiers.extra_actions_next_turn += ev
                ctx.game.player_effects.append({
                    "source_player_id": ctx.player.id,
                    "target_player_id": pid,
                    "card_name": ctx.card.name,
                    "effect": f"+{ev} Action{'s' if ev > 1 else ''} next round",
                    "effect_type": "grant_actions_next_turn",
                    "value": ev,
                })
        ctx.game._log(
            f"{ctx.player.name} grants {ev} extra action(s) to all other players next turn",
            actor=ctx.player.id)
    elif effect.target == "chosen_player" and ctx.action.target_player_id:
        other_player = ctx.game.players.get(ctx.action.target_player_id)
        if other_player:
            other_player.turn_modifiers.extra_actions_next_turn += ev
            ctx.game._log(
                f"{ctx.player.name} grants {ev} extra action(s) to {other_player.name} next turn",
                actor=ctx.player.id)
            ctx.game.player_effects.append({
                "source_player_id": ctx.player.id,
                "target_player_id": ctx.action.target_player_id,
                "card_name": ctx.card.name,
                "effect": f"+{ev} Action{'s' if ev > 1 else ''} next round",
                "effect_type": "grant_actions_next_turn",
                "value": ev,
            })


def _handle_draw_next_turn(effect: Effect, ctx: EffectContext) -> None:
    """Blitz / Forward March secondary: draw extra cards next turn."""
    ctx.player.turn_modifiers.extra_draws_next_turn += effect.value
    ctx.game._log(
        f"{ctx.player.name} will draw {effect.value} extra card(s) next turn from {ctx.card.name}",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_auto_claim_adjacent_neutral(effect: Effect, ctx: EffectContext) -> None:
    """Breakthrough: on success, randomly claim one adjacent neutral tile."""
    if not ctx.game.grid or ctx.action.target_q is None:
        return
    target_r = ctx.action.target_r if ctx.action.target_r is not None else 0
    adj_tiles = ctx.game.grid.get_adjacent(ctx.action.target_q, target_r)
    candidates = [t for t in adj_tiles if t.owner is None and not t.is_blocked]
    if candidates:
        tile = ctx.game.rng.choice(candidates)
        tile.owner = ctx.player.id
        tile.held_since_turn = ctx.game.current_round
        ctx.game._log(
            f"{ctx.player.name} auto-claims neutral tile {tile.key} from {ctx.card.name}",
            actor=ctx.player.id)
        # Emit a resolution step so the frontend can animate the auto-claim
        ctx.game.resolution_steps.append({
            "tile_key": tile.key,
            "q": tile.q,
            "r": tile.r,
            "contested": False,
            "claimants": [{
                "player_id": ctx.player.id,
                "power": 0,
                "source_q": ctx.action.target_q,
                "source_r": target_r,
            }],
            "defender_id": None,
            "defender_power": 0,
            "winner_id": ctx.player.id,
            "previous_owner": None,
            "outcome": "auto_claim",
            "card_name": ctx.card.name,
        })


def _handle_contest_cost(effect: Effect, ctx: EffectContext) -> None:
    """Rapid Assault: opponent must spend resources to contest tile next round."""
    if ctx.target_tile_key:
        # Store on the game level (all players' turn_modifiers would need to check)
        # We use the acting player's modifiers to track which tiles have contest costs
        ctx.player.turn_modifiers.contest_costs[ctx.target_tile_key] = effect.value
        ctx.game._log(
            f"Tile {ctx.target_tile_key} will cost opponents {effect.value} resource to contest next round",
            actor=ctx.player.id)


def _handle_on_defend_forced_discard(effect: Effect, ctx: EffectContext) -> None:
    """War of Attrition: if defender holds, they draw fewer cards next turn."""
    if ctx.defender_id:
        defender = ctx.game.players.get(ctx.defender_id)
        if defender:
            defender.forced_discard_next_turn += effect.value
            ctx.game._log(
                f"{defender.name} draws {effect.value} fewer card(s) next turn (War of Attrition)",
                actor=ctx.player.id)


def _handle_auto_claim_if_neutral(effect: Effect, ctx: EffectContext) -> None:
    """Slow Advance: if target is neutral, auto-claim (skip power comparison)."""
    # This is handled during claim resolution in game_state.py
    # by checking for this effect type before normal power comparison
    pass


def _handle_immediate_resolve(effect: Effect, ctx: EffectContext) -> None:
    """Spearhead: resolve this claim immediately during play phase."""
    if ctx.target_tile_key:
        ctx.player.turn_modifiers.immediate_resolve_tiles.add(ctx.target_tile_key)
        ctx.game._log(
            f"{ctx.player.name}'s claim on {ctx.target_tile_key} resolves immediately (Spearhead)",
            actor=ctx.player.id)


def _handle_resource_refund_if_neutral(effect: Effect, ctx: EffectContext) -> None:
    """Overwhelming Force: gain resource refund if target tile was neutral."""
    ev = effect.effective_value(ctx.card.is_upgraded)
    ctx.player.resources += ev
    ctx.game._log(
        f"{ctx.player.name} gains {ev} resource refund (neutral tile)",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_stacking_power_bonus(effect: Effect, ctx: EffectContext) -> None:
    """Dog Pile: the +1 bonus is applied to other claims on the same tile via
    calculate_effective_power (_stacking_power_bonus). Nothing to do here.
    """
    pass


def _handle_conditional_action_return(effect: Effect, ctx: EffectContext) -> None:
    """Rabble: gain action back if another Rabble was played."""
    ctx.player.actions_available += effect.value
    ctx.game._log(
        f"{ctx.player.name} gains {effect.value} action(s) back from {ctx.card.name} synergy",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_play_resource_cost(effect: Effect, ctx: EffectContext) -> None:
    """Mercenary: deduct resource cost when played."""
    cost = effect.effective_value(ctx.card.is_upgraded)
    ctx.player.resources -= cost
    ctx.game._log(
        f"{ctx.player.name} pays {cost} resources to play {ctx.card.name}",
        visible_to=[ctx.player.id], actor=ctx.player.id)


# Stub handlers for complex effects
def _handle_stub(effect: Effect, ctx: EffectContext) -> None:
    """Placeholder for not-yet-implemented effects."""
    ctx.game._log(f"[STUB] {effect.type.value} effect not yet implemented")


def _handle_noop(effect: Effect, ctx: EffectContext) -> None:
    """No-op handler for effects that are enforced elsewhere (e.g. targeting constraints)."""
    pass


# ── Register all handlers ─────────────────────────────────────────

register_handler(EffectType.GAIN_RESOURCES, _handle_gain_resources)
register_handler(EffectType.SELF_DISCARD, _handle_self_discard)
register_handler(EffectType.SELF_TRASH, _handle_self_trash)
register_handler(EffectType.TRASH_GAIN_BUY_COST, _handle_trash_gain_buy_cost)
register_handler(EffectType.GAIN_VP, _handle_gain_vp)
register_handler(EffectType.TILE_IMMUNITY, _handle_tile_immunity)
register_handler(EffectType.IGNORE_DEFENSE, _handle_ignore_defense)
register_handler(EffectType.BUY_RESTRICTION, _handle_buy_restriction)
register_handler(EffectType.COST_REDUCTION, _handle_cost_reduction)
register_handler(EffectType.GRANT_ACTIONS, _handle_grant_actions)
register_handler(EffectType.GRANT_ACTIONS_NEXT_TURN, _handle_grant_actions_next_turn)
register_handler(EffectType.DRAW_NEXT_TURN, _handle_draw_next_turn)
register_handler(EffectType.AUTO_CLAIM_ADJACENT_NEUTRAL, _handle_auto_claim_adjacent_neutral)
register_handler(EffectType.CONTEST_COST, _handle_contest_cost)
register_handler(EffectType.ON_DEFEND_FORCED_DISCARD, _handle_on_defend_forced_discard)
register_handler(EffectType.AUTO_CLAIM_IF_NEUTRAL, _handle_auto_claim_if_neutral)
register_handler(EffectType.IMMEDIATE_RESOLVE, _handle_immediate_resolve)
register_handler(EffectType.RESOURCE_REFUND_IF_NEUTRAL, _handle_resource_refund_if_neutral)
register_handler(EffectType.STACKING_POWER_BONUS, _handle_stacking_power_bonus)
register_handler(EffectType.CONDITIONAL_ACTION_RETURN, _handle_conditional_action_return)


def _handle_grant_stackable(effect: Effect, ctx: EffectContext) -> None:
    """Battle Cry / Grant Stackable: make non-stackable claim cards in hand stackable this turn."""
    count = 0
    for card in ctx.player.hand:
        if card.card_type == CardType.CLAIM and not card.stackable:
            card.stackable = True
            card.granted_stackable = True
            count += 1
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} grants Stackable to {count} claim card(s)",
        actor=ctx.player.id)


register_handler(EffectType.GRANT_STACKABLE, _handle_grant_stackable)
register_handler(EffectType.PLAY_RESOURCE_COST, _handle_play_resource_cost)

def _handle_trash_opponent_card(effect: Effect, ctx: EffectContext) -> None:
    """Spoils of War: if claim wins a contested tile, trash the opponent's claim card."""
    if not ctx.target_tile_key or not ctx.claim_succeeded:
        return

    # Find the losing opponent's claim card for the same tile
    for pid, other_player in ctx.game.players.items():
        if pid == ctx.player.id:
            continue
        for action in other_player.planned_actions:
            if action.card.card_type != CardType.CLAIM:
                continue
            if action.target_q is None:
                continue
            action_target_r = action.target_r if action.target_r is not None else 0
            action_tile_key = f"{action.target_q},{action_target_r}"
            if action_tile_key == ctx.target_tile_key:
                # Mark the opponent's card as trash_on_use so it won't go to discard
                action.card.trash_on_use = True
                ctx.game._log(
                    f"{ctx.player.name}'s {ctx.card.name} trashes {other_player.name}'s {action.card.name}!",
                    actor=ctx.player.id)
                return  # Only trash one opponent's card


def _handle_dynamic_buy_cost(effect: Effect, ctx: EffectContext) -> None:
    """Dynamic buy cost: evaluated at purchase time, no runtime action needed."""
    pass


def _handle_cease_fire(effect: Effect, ctx: EffectContext) -> None:
    """Cease Fire: mark pending bonus draws, resolved after all claims."""
    bonus = effect.value
    ctx.player.turn_modifiers.cease_fire_bonus += bonus
    ctx.game._log(
        f"{ctx.player.name} plays {ctx.card.name} — will draw {bonus} extra card(s) "
        f"next turn if no opponent tiles are claimed",
        visible_to=[ctx.player.id], actor=ctx.player.id)


# ── VP-related effect handlers (derived VP system) ──────────────


def _handle_enhance_vp_tile(effect: Effect, ctx: EffectContext) -> None:
    """Consecrate: increase a connected VP tile's vp_value by 1."""
    if not ctx.target_tile_key or not ctx.game.grid:
        return
    parts = ctx.target_tile_key.split(",")
    if len(parts) != 2:
        return
    tile = ctx.game.grid.get_tile(int(parts[0]), int(parts[1]))
    if not tile:
        return
    # Must be a VP tile owned by the player and connected to their base
    if not tile.is_vp or tile.owner != ctx.player.id:
        ctx.game._log(
            f"{ctx.player.name} cannot consecrate {ctx.target_tile_key} — "
            f"must be a VP tile you own",
            actor=ctx.player.id)
        return
    connected = ctx.game.grid.get_connected_tiles(ctx.player.id)
    if (tile.q, tile.r) not in connected:
        ctx.game._log(
            f"{ctx.player.name} cannot consecrate {ctx.target_tile_key} — "
            f"tile not connected to base",
            actor=ctx.player.id)
        return
    bonus = 1
    if ctx.card.is_upgraded:
        bonus = effect.metadata.get("upgraded_bonus", 2)
    tile.vp_value += bonus
    ctx.game._log(
        f"{ctx.player.name} consecrates VP tile {ctx.target_tile_key} "
        f"(+{bonus}, now worth {tile.vp_value} VP)",
        actor=ctx.player.id)


def _handle_grant_land_grants(effect: Effect, ctx: EffectContext) -> None:
    """Grant Land Grants. Supports two modes:
    - chosen_player (Fortress Diplomacy): self + target opponent
    - all_players (Neutral Diplomat): self first, then all others
    """
    # Self first (always)
    self_count = 2 if ctx.card.is_upgraded else 1
    for _ in range(self_count):
        grant = make_land_grant_card()
        ctx.player.deck.discard.append(grant)
    ctx.game._log(
        f"{ctx.player.name} receives {self_count} Land Grant(s) from {ctx.card.name}",
        actor=ctx.player.id)

    # Record self land grants as player effect for animation
    ctx.game.player_effects.append({
        "source_player_id": ctx.player.id,
        "target_player_id": ctx.player.id,
        "card_name": ctx.card.name,
        "effect": f"+{self_count} Land Grant{'s' if self_count > 1 else ''}",
        "effect_type": "grant_land_grants",
        "value": self_count,
        "source_q": ctx.action.target_q,
        "source_r": ctx.action.target_r,
        "added_card_name": "Land Grant",
        "added_card_count": self_count,
    })

    if effect.target == "chosen_player":
        # Fortress Diplomacy: target one opponent
        target_id = ctx.action.target_player_id
        if target_id:
            target_player = ctx.game.players.get(target_id)
            if target_player:
                target_grant = make_land_grant_card()
                target_player.deck.discard.append(target_grant)
                ctx.game._log(
                    f"{target_player.name} receives a Land Grant from {ctx.player.name}'s {ctx.card.name}",
                    actor=ctx.player.id)
                ctx.game.player_effects.append({
                    "source_player_id": ctx.player.id,
                    "target_player_id": target_id,
                    "card_name": ctx.card.name,
                    "effect": "+1 Land Grant",
                    "effect_type": "grant_land_grants",
                    "value": 1,
                    "source_q": ctx.action.target_q,
                    "source_r": ctx.action.target_r,
                    "added_card_name": "Land Grant",
                    "added_card_count": 1,
                })
    else:
        # Neutral Diplomat: all other players
        for pid, other in ctx.game.players.items():
            if pid == ctx.player.id:
                continue
            other_grant = make_land_grant_card()
            other.deck.discard.append(other_grant)
            ctx.game._log(
                f"{other.name} receives a Land Grant from {ctx.player.name}'s {ctx.card.name}",
                actor=ctx.player.id)
            ctx.game.player_effects.append({
                "source_player_id": ctx.player.id,
                "target_player_id": pid,
                "card_name": ctx.card.name,
                "effect": "+1 Land Grant",
                "effect_type": "grant_land_grants",
                "value": 1,
                "source_q": ctx.action.target_q,
                "source_r": ctx.action.target_r,
                "added_card_name": "Land Grant",
                "added_card_count": 1,
            })


def _handle_vp_from_contested_wins(effect: Effect, ctx: EffectContext) -> None:
    """Battle Glory: if won 2+ contested tiles this turn, increase card's passive_vp.

    Now a Passive card — triggers for all copies in the player's hand during
    resolve_on_resolution_effects, not played as an action.
    """
    if not ctx.claim_results or not ctx.game.grid:
        return
    required = effect.metadata.get("required_wins", 2)

    # Count contested wins (tiles where another player also had a claim or was the owner)
    contested_wins = 0
    for tile_key, results in ctx.claim_results.items():
        if ctx.player.id not in results:
            continue
        if not results[ctx.player.id]:
            continue  # didn't win this tile
        # Check if the tile was previously owned by another player (contested)
        for step in ctx.game.resolution_steps:
            if step.get("tile_key") == tile_key:
                prev = step.get("previous_owner")
                if prev is not None and prev != ctx.player.id:
                    contested_wins += 1
                break

    if contested_wins >= required:
        vp_gain = effect.effective_value(ctx.card.is_upgraded)
        ctx.card.passive_vp += vp_gain
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name} gains +{vp_gain} VP "
            f"({contested_wins} contested wins >= {required} required, "
            f"now worth {ctx.card.passive_vp} VP)",
            actor=ctx.player.id)


def _handle_permanent_defense(effect: Effect, ctx: EffectContext) -> None:
    """Entrench / Twin Cities: permanently increase a tile's defense (persists until captured)."""
    if not ctx.game.grid:
        return
    bonus = effect.value
    if ctx.card.is_upgraded:
        bonus = effect.metadata.get("upgraded_value", bonus)

    # Collect all target tiles: primary + extra targets
    tile_keys: list[str] = []
    if ctx.target_tile_key:
        tile_keys.append(ctx.target_tile_key)
    for eq, er in ctx.extra_targets:
        tile_keys.append(f"{eq},{er}")
    # Also check action.extra_targets (set during resolve, not play)
    if ctx.action.extra_targets:
        for eq, er in ctx.action.extra_targets:
            k = f"{eq},{er}"
            if k not in tile_keys:
                tile_keys.append(k)

    for tk in tile_keys:
        parts = tk.split(",")
        if len(parts) != 2:
            continue
        tile = ctx.game.grid.get_tile(int(parts[0]), int(parts[1]))
        if tile and tile.owner == ctx.player.id:
            tile.permanent_defense_bonus += bonus
            tile.defense_power += bonus  # also apply immediately this round
            ctx.game._log(
                f"{ctx.player.name} permanently fortifies tile {tk} "
                f"(+{bonus} defense, now {tile.defense_power})",
                actor=ctx.player.id)


register_handler(EffectType.PERMANENT_DEFENSE, _handle_permanent_defense)
register_handler(EffectType.ENHANCE_VP_TILE, _handle_enhance_vp_tile)
register_handler(EffectType.GRANT_LAND_GRANTS, _handle_grant_land_grants)
register_handler(EffectType.VP_FROM_CONTESTED_WINS, _handle_vp_from_contested_wins)


def _handle_free_reroll(effect: Effect, ctx: EffectContext) -> None:
    """Surveyor: grant free archetype market re-rolls this turn."""
    count = effect.effective_value(ctx.card.is_upgraded)
    ctx.player.turn_modifiers.free_rerolls += count
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} grants {count} free market re-roll(s)",
        actor=ctx.player.id)
    ctx.game.player_effects.append({
        "source_player_id": ctx.player.id,
        "target_player_id": ctx.player.id,
        "card_name": ctx.card.name,
        "effect": f"+{count} Free Re-roll{'s' if count > 1 else ''}",
        "effect_type": "free_reroll",
        "value": count,
    })


def _handle_resource_drain(effect: Effect, ctx: EffectContext) -> None:
    """Rapid Assault: if successful against an opponent's tile, they lose resources."""
    if not ctx.claim_succeeded or not ctx.defender_id:
        return
    defender = ctx.game.players.get(ctx.defender_id)
    if not defender:
        return
    drain = effect.effective_value(ctx.card.is_upgraded)
    actual = min(drain, defender.resources)
    if actual > 0:
        defender.resources -= actual
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name} drains {actual} resource(s) from {defender.name}",
            actor=ctx.player.id)


# Stubs for complex effects
def _handle_defense_per_adjacent(effect: Effect, ctx: EffectContext) -> None:
    """Nest: grant defense bonus per adjacent owned tile."""
    if not ctx.target_tile_key or not ctx.game.grid:
        return
    parts = ctx.target_tile_key.split(",")
    if len(parts) != 2:
        return
    tile = ctx.game.grid.get_tile(int(parts[0]), int(parts[1]))
    if not tile or tile.owner != ctx.player.id:
        return
    adj_tiles = ctx.game.grid.get_adjacent(tile.q, tile.r)
    owned_adj = sum(1 for t in adj_tiles if t.owner == ctx.player.id)
    bonus_per = effect.effective_value(ctx.card.is_upgraded)
    total_bonus = bonus_per * owned_adj
    if total_bonus > 0:
        tile.defense_power += total_bonus
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name} grants +{total_bonus} defense "
            f"to tile {ctx.target_tile_key} ({owned_adj} adjacent owned tiles)",
            actor=ctx.player.id)


def _handle_power_per_same_name(effect: Effect, ctx: EffectContext) -> None:
    """Rabble+: power calc handled in calculate_effective_power."""
    pass


def _handle_power_per_tiles_owned(effect: Effect, ctx: EffectContext) -> None:
    """Mob Rule / Locust Swarm: power calc handled in calculate_effective_power."""
    pass


def _handle_ignore_defense_override(effect: Effect, ctx: EffectContext) -> None:
    """Tile's defense cannot be ignored this round."""
    if ctx.target_tile_key:
        ctx.player.turn_modifiers.ignore_defense_override_tiles.add(ctx.target_tile_key)
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name} protects tile {ctx.target_tile_key} "
            f"from defense-ignoring effects",
            actor=ctx.player.id)


register_handler(EffectType.DEFENSE_PER_ADJACENT, _handle_defense_per_adjacent)
register_handler(EffectType.POWER_PER_SAME_NAME, _handle_power_per_same_name)
register_handler(EffectType.POWER_PER_TILES_OWNED, _handle_power_per_tiles_owned)
register_handler(EffectType.IGNORE_DEFENSE_OVERRIDE, _handle_ignore_defense_override)

register_handler(EffectType.CEASE_FIRE, _handle_cease_fire)
register_handler(EffectType.ADJACENCY_BRIDGE, _handle_noop)  # targeting-only constraint, resolved in play_card
register_handler(EffectType.FREE_REROLL, _handle_free_reroll)
register_handler(EffectType.RESOURCE_DRAIN, _handle_resource_drain)
register_handler(EffectType.DYNAMIC_BUY_COST, _handle_dynamic_buy_cost)
register_handler(EffectType.TRASH_OPPONENT_CARD, _handle_trash_opponent_card)


def _handle_resources_per_claims_last_round(effect: Effect, ctx: EffectContext) -> None:
    """War Tithe: gain resources based on tiles claimed last round."""
    claims = ctx.player.claims_won_last_round
    per_claim = effect.upgraded_value if ctx.card.is_upgraded and effect.upgraded_value else effect.value
    max_res = effect.metadata.get("upgraded_max_resources" if ctx.card.is_upgraded else "max_resources", 999)
    gained = min(claims * per_claim, max_res)
    if gained > 0:
        ctx.player.resources += gained
        ctx.game._log(f"{ctx.player.name} gains {gained} resources from War Tithe ({claims} tiles claimed last round)")
    # Upgraded: draw 1 card
    if ctx.card.is_upgraded and effect.metadata.get("upgraded_draw"):
        draw_count = effect.metadata["upgraded_draw"]
        ctx.player.turn_modifiers.extra_draws_next_turn += draw_count


register_handler(EffectType.RESOURCES_PER_CLAIMS_LAST_ROUND, _handle_resources_per_claims_last_round)


def _handle_draw_per_connected_vp(effect: Effect, ctx: EffectContext) -> None:
    """Toll Road: draw cards based on connected VP hexes."""
    draw_per = effect.effective_value(ctx.card.is_upgraded)
    connected_count = 0
    if ctx.game.grid:
        connected_coords = ctx.game.grid.get_connected_tiles(ctx.player.id)
        for tile in ctx.game.grid.tiles.values():
            if tile.is_vp and tile.owner == ctx.player.id and (tile.q, tile.r) in connected_coords:
                connected_count += 1
    total_draw = connected_count * draw_per
    if total_draw > 0:
        drawn = ctx.player.deck.draw(total_draw, ctx.game.rng)
        ctx.player.hand.extend(drawn)
        ctx.game._log(
            f"{ctx.player.name} draws {len(drawn)} card(s) from Toll Road ({connected_count} connected VP tile{'s' if connected_count != 1 else ''})",
            visible_to=[ctx.player.id], actor=ctx.player.id)


register_handler(EffectType.DRAW_PER_CONNECTED_VP, _handle_draw_per_connected_vp)


def _handle_draw_per_debt(effect: Effect, ctx: EffectContext) -> None:
    """Financier: draw 1 card for each Debt card in draw pile, hand, and discard."""
    debt_count = 0
    for c in ctx.player.hand:
        if c.definition_id == DEF_ID_DEBT:
            debt_count += 1
    for c in ctx.player.deck.cards:
        if c.definition_id == DEF_ID_DEBT:
            debt_count += 1
    for c in ctx.player.deck.discard:
        if c.definition_id == DEF_ID_DEBT:
            debt_count += 1
    draw_per = effect.effective_value(ctx.card.is_upgraded)
    total_draw = debt_count * draw_per
    if total_draw > 0:
        drawn = ctx.player.deck.draw(total_draw, ctx.game.rng)
        ctx.player.hand.extend(drawn)
        ctx.game._log(
            f"{ctx.player.name} draws {len(drawn)} card(s) from Financier ({debt_count} Debt card{'s' if debt_count != 1 else ''} in deck)",
            visible_to=[ctx.player.id], actor=ctx.player.id)
    else:
        ctx.game._log(
            f"{ctx.player.name} plays Financier but has no Debt cards",
            visible_to=[ctx.player.id], actor=ctx.player.id)


register_handler(EffectType.DRAW_PER_DEBT, _handle_draw_per_debt)


# VP formula passive effects — no handler needed (computed in _compute_formula_vp)
register_handler(EffectType.VP_FROM_DISCONNECTED_GROUPS, _handle_stub)
register_handler(EffectType.VP_FROM_UNCAPTURED_TILES, _handle_stub)


# ── Synergy card effect handlers ──────────────────────────────────


def _handle_conditional_action(effect: Effect, ctx: EffectContext) -> None:
    """Spyglass: gain action if hand size <= threshold after drawing."""
    threshold = effect.condition_threshold
    if len(ctx.player.hand) <= threshold:
        actions = effect.effective_value(ctx.card.is_upgraded)
        ctx.player.actions_available += actions
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name} grants {actions} action(s) "
            f"(hand size {len(ctx.player.hand)} <= {threshold})",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        # Upgraded Spyglass also grants 1 resource
        if ctx.card.is_upgraded:
            ctx.player.resources += 1
            ctx.game._log(
                f"{ctx.player.name} gains 1 resource from {ctx.card.name}+",
                visible_to=[ctx.player.id], actor=ctx.player.id)
    else:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: hand size {len(ctx.player.hand)} "
            f"> {threshold}, no bonus action",
            visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_resource_scaling(effect: Effect, ctx: EffectContext) -> None:
    """Dividends: gain 1 resource per N resources currently held (min 1)."""
    divisor = effect.value  # e.g. 2 = gain 1 per 2 held
    gained = max(1, ctx.player.resources // divisor)
    ctx.player.resources += gained
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} earns {gained} resource(s) "
        f"(had {ctx.player.resources - gained}, 1 per {divisor} held)",
        visible_to=[ctx.player.id], actor=ctx.player.id)
    # Upgraded Dividends: draw 1 card
    if ctx.card.is_upgraded:
        drawn = ctx.player.deck.draw(1, ctx.game.rng)
        ctx.player.hand.extend(drawn)
        if drawn:
            ctx.game._log(
                f"{ctx.player.name} draws {len(drawn)} card(s) from {ctx.card.name}+",
                visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_cycle(effect: Effect, ctx: EffectContext) -> None:
    """Cartographer: discard N cards, draw N cards."""
    discard_count = effect.metadata.get("discard", 2)
    draw_count = effect.metadata.get("draw", 2)
    if ctx.card.is_upgraded:
        draw_count = effect.metadata.get("upgraded_draw", draw_count)

    # Discard chosen cards (uses discard_card_indices from player choice)
    actual_discard = min(discard_count, len(ctx.discard_card_indices))
    discarded = []
    for idx in sorted(ctx.discard_card_indices[:actual_discard], reverse=True):
        if 0 <= idx < len(ctx.player.hand):
            discarded.append(ctx.player.hand.pop(idx))
    if discarded:
        ctx.player.deck.add_to_discard(discarded)
        names = ", ".join(c.name for c in discarded)
        ctx.game._log(
            f"{ctx.player.name} discards {names} for {ctx.card.name}",
            visible_to=[ctx.player.id], actor=ctx.player.id)

    # Draw cards
    drawn = ctx.player.deck.draw(draw_count, ctx.game.rng)
    ctx.player.hand.extend(drawn)
    if drawn:
        ctx.game._log(
            f"{ctx.player.name} draws {len(drawn)} card(s) from {ctx.card.name}",
            visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_resource_per_vp_hex(effect: Effect, ctx: EffectContext) -> None:
    """Tax Collector: gain resources per connected VP hex."""
    per_hex = effect.effective_value(ctx.card.is_upgraded)
    vp_hex_count = 0
    if ctx.game.grid:
        connected_coords = ctx.game.grid.get_connected_tiles(ctx.player.id)
        for tile in ctx.game.grid.tiles.values():
            if tile.is_vp and tile.owner == ctx.player.id and (tile.q, tile.r) in connected_coords:
                vp_hex_count += 1
    gained = vp_hex_count * per_hex
    if gained > 0:
        ctx.player.resources += gained
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} earns {gained} resource(s) "
        f"({vp_hex_count} connected VP tile{'s' if vp_hex_count != 1 else ''} × {per_hex})",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_resources_per_tiles_lost(effect: Effect, ctx: EffectContext) -> None:
    """Robin Hood: gain resources per tile captured from you last round."""
    tiles_lost = ctx.player.tiles_lost_last_round
    per_tile = effect.effective_value(ctx.card.is_upgraded)
    gained = tiles_lost * per_tile
    if gained > 0:
        ctx.player.resources += gained
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} earns {gained} resource(s) "
        f"({tiles_lost} tile(s) lost last round × {per_tile})",
        visible_to=[ctx.player.id], actor=ctx.player.id)


register_handler(EffectType.CONDITIONAL_ACTION, _handle_conditional_action)
register_handler(EffectType.RESOURCE_SCALING, _handle_resource_scaling)
register_handler(EffectType.CYCLE, _handle_cycle)
register_handler(EffectType.RESOURCE_PER_VP_HEX, _handle_resource_per_vp_hex)
register_handler(EffectType.RESOURCES_PER_TILES_LOST, _handle_resources_per_tiles_lost)


# ── Medium-complexity effect handlers ────────────────────────────


def _handle_actions_per_cards_played(effect: Effect, ctx: EffectContext) -> None:
    """Mobilize: gain 1 action per other card played this turn (max N)."""
    is_upgraded = ctx.card.is_upgraded
    max_actions = int(
        ctx.card.effects[0].metadata.get("upgraded_max", 3)
        if is_upgraded
        else ctx.card.effects[0].metadata.get("max", 3)
    ) if ctx.card.effects else 3
    # Find the actual metadata from THIS effect
    max_actions = int(effect.metadata.get("upgraded_max" if is_upgraded else "max", 3))
    # Count other cards played this turn (excluding Mobilize itself)
    other_cards = len([
        a for a in ctx.player.planned_actions
        if a.card.id != ctx.card.id
    ])
    actions_gained = min(other_cards * effect.value, max_actions)
    if actions_gained > 0:
        ctx.player.actions_available += actions_gained
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} grants {actions_gained} action(s) "
        f"({other_cards} other card(s) played, max {max_actions})",
        visible_to=[ctx.player.id], actor=ctx.player.id)
    # Upgraded Mobilize also draws 1 card
    if is_upgraded:
        drawn = ctx.player.deck.draw(1, ctx.game.rng)
        ctx.player.hand.extend(drawn)
        if drawn:
            ctx.game._log(
                f"{ctx.player.name} draws {len(drawn)} card(s) from {ctx.card.name}+",
                visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_next_turn_bonus(effect: Effect, ctx: EffectContext) -> None:
    """Supply Depot: grant bonuses at start of next turn."""
    is_upgraded = ctx.card.is_upgraded
    if is_upgraded and "upgraded_draw" in effect.metadata:
        extra_draw = int(effect.metadata.get("upgraded_draw", 0))
    else:
        extra_draw = int(effect.metadata.get("draw", 0))
    if is_upgraded and "upgraded_resources" in effect.metadata:
        extra_resources = int(effect.metadata.get("upgraded_resources", 0))
    else:
        extra_resources = int(effect.metadata.get("resources", 0))
    extra_actions = int(effect.metadata.get("upgraded_actions", 0)) if is_upgraded else 0

    if extra_draw > 0:
        ctx.player.turn_modifiers.extra_draws_next_turn += extra_draw
    if extra_resources > 0:
        ctx.player.turn_modifiers.extra_resources_next_turn += extra_resources
    if extra_actions > 0:
        ctx.player.turn_modifiers.extra_actions_next_turn += extra_actions

    parts = []
    if extra_draw > 0:
        parts.append(f"+{extra_draw} {'card' if extra_draw == 1 else 'cards'}")
    if extra_resources > 0:
        parts.append(f"+{extra_resources} {'resource' if extra_resources == 1 else 'resources'}")
    if extra_actions > 0:
        parts.append(f"+{extra_actions} {'action' if extra_actions == 1 else 'actions'}")
    effect_text = ", ".join(parts) + " next round"
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} queues next-turn bonus: {', '.join(parts)}",
        actor=ctx.player.id)
    ctx.game.player_effects.append({
        "source_player_id": ctx.player.id,
        "target_player_id": ctx.player.id,
        "card_name": ctx.card.name,
        "effect": effect_text,
        "effect_type": "next_turn_bonus",
        "value": 0,
    })


def _handle_mulligan(effect: Effect, ctx: EffectContext) -> None:
    """Mulligan: discard entire hand, draw that many cards (+1 if upgraded)."""
    hand_size = len(ctx.player.hand)
    if hand_size == 0:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: no cards in hand to mulligan",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    # Discard entire hand
    discarded = list(ctx.player.hand)
    ctx.player.deck.add_to_discard(discarded)
    ctx.player.hand.clear()
    names = ", ".join(c.name for c in discarded)
    ctx.game._log(
        f"{ctx.player.name} mulligans {hand_size} card(s): {names}",
        visible_to=[ctx.player.id], actor=ctx.player.id)

    # Draw that many (+1 if upgraded)
    draw_count = hand_size + (1 if ctx.card.is_upgraded else 0)
    drawn = ctx.player.deck.draw(draw_count, ctx.game.rng)
    ctx.player.hand.extend(drawn)
    ctx.game._log(
        f"{ctx.player.name} draws {len(drawn)} card(s) from {ctx.card.name}",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_inject_rubble(effect: Effect, ctx: EffectContext) -> None:
    """Infestation: add N Rubble cards to chosen opponent's discard pile."""
    target_id = ctx.action.target_player_id
    if not target_id:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: no target opponent selected",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return
    target_player = ctx.game.players.get(target_id)
    if not target_player:
        return

    count = effect.effective_value(ctx.card.is_upgraded)
    for _ in range(count):
        rubble = make_rubble_card()
        target_player.deck.discard.append(rubble)

    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} adds {count} Rubble card(s) "
        f"to {target_player.name}'s discard pile",
        actor=ctx.player.id)

    # Record player effect for flying-card animation
    ctx.game.player_effects.append({
        "source_player_id": ctx.player.id,
        "target_player_id": target_id,
        "card_name": ctx.card.name,
        "effect": f"+{count} Rubble",
        "effect_type": "inject_rubble",
        "value": count,
        "source_q": ctx.action.target_q,
        "source_r": ctx.action.target_r,
        "added_card_name": "Rubble",
        "added_card_count": count,
    })


register_handler(EffectType.ACTIONS_PER_CARDS_PLAYED, _handle_actions_per_cards_played)
register_handler(EffectType.NEXT_TURN_BONUS, _handle_next_turn_bonus)
register_handler(EffectType.MULLIGAN, _handle_mulligan)
register_handler(EffectType.INJECT_RUBBLE, _handle_inject_rubble)


# ── Complex effect handlers ──────────────────────────────────────


def _handle_global_claim_ban(effect: Effect, ctx: EffectContext) -> None:
    """Snowy Holiday: ban all Claim cards for the next round."""
    # Add duration + 1: the extra 1 accounts for the end-of-turn decrement
    # in the same round the ban is set (during reveal, after play phase).
    ctx.game.claim_ban_rounds += effect.duration + 1
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} bans all Claim cards next round!",
        actor=ctx.player.id)
    # Record player effects for resolve animation popup
    for pid in ctx.game.players:
        if ctx.game.players[pid].has_left:
            continue
        ctx.game.player_effects.append({
            "source_player_id": ctx.player.id,
            "target_player_id": pid,
            "card_name": ctx.card.name,
            "effect": "🚫 No claims next turn",
            "effect_type": "global_claim_ban",
            "value": effect.duration,
        })
    # Upgraded Snowy Holiday: draw 2 cards
    if ctx.card.is_upgraded:
        drawn = ctx.player.deck.draw(2, ctx.game.rng)
        ctx.player.hand.extend(drawn)
        if drawn:
            ctx.game._log(
                f"{ctx.player.name} draws {len(drawn)} card(s) from {ctx.card.name}+",
                visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_global_random_trash(effect: Effect, ctx: EffectContext) -> None:
    """Plague: queue random card trash for all affected players at start of next turn."""
    is_upgraded = ctx.card.is_upgraded
    for pid, player in ctx.game.players.items():
        if player.has_left:
            continue
        # Upgraded: skip self (opponents only)
        if is_upgraded and pid == ctx.player.id:
            continue
        player.turn_modifiers.plague_trash_next_turn += 1
        ctx.game.player_effects.append({
            "source_player_id": ctx.player.id,
            "target_player_id": pid,
            "card_name": ctx.card.name,
            "effect": "Trashes a random card next turn",
            "effect_type": "global_random_trash",
            "value": 1,
        })
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} — all {'opponents' if is_upgraded else 'players'} "
        f"will trash a random card at the start of next turn",
        actor=ctx.player.id)


def _handle_swap_draw_discard(effect: Effect, ctx: EffectContext) -> None:
    """Heady Brew: swap draw and discard piles, then shuffle draw pile."""
    old_draw = ctx.player.deck.cards
    ctx.player.deck.cards = ctx.player.deck.discard
    ctx.player.deck.discard = old_draw
    ctx.player.deck.shuffle(ctx.game.rng)
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} swaps draw/discard piles and shuffles "
        f"({len(ctx.player.deck.cards)} cards now in draw pile)",
        visible_to=[ctx.player.id], actor=ctx.player.id)
    # Upgraded Heady Brew: draw 2 cards
    if ctx.card.is_upgraded:
        drawn = ctx.player.deck.draw(2, ctx.game.rng)
        ctx.player.hand.extend(drawn)
        if drawn:
            ctx.game._log(
                f"{ctx.player.name} draws {len(drawn)} card(s) from {ctx.card.name}+",
                visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_abandon_tile(effect: Effect, ctx: EffectContext) -> None:
    """Exodus: abandon a tile you own (remove ownership)."""
    if ctx.action.target_q is None or not ctx.game.grid:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: no target tile",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return
    target_r = ctx.action.target_r if ctx.action.target_r is not None else 0
    tile = ctx.game.grid.get_tile(ctx.action.target_q, target_r)
    if not tile or tile.owner != ctx.player.id:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: tile not owned by player",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return
    if tile.is_base:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: cannot abandon a base tile",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return
    tile.owner = None
    tile.held_since_turn = None
    tile.defense_power = tile.base_defense
    tile.permanent_defense_bonus = 0
    ctx.game._log(
        f"{ctx.player.name} abandons tile {ctx.action.target_q},{target_r} ({ctx.card.name})",
        actor=ctx.player.id)


def _handle_abandon_and_block(effect: Effect, ctx: EffectContext) -> None:
    """Scorched Retreat: abandon a tile and convert it to blocked terrain."""
    if ctx.action.target_q is None or not ctx.game.grid:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: no target tile",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return
    target_r = ctx.action.target_r if ctx.action.target_r is not None else 0
    tile = ctx.game.grid.get_tile(ctx.action.target_q, target_r)
    if not tile or tile.owner != ctx.player.id:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: tile not owned by player",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return
    if tile.is_base:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: cannot scorch a base tile",
            visible_to=[ctx.player.id], actor=ctx.player.id)
        return
    tile.owner = None
    tile.held_since_turn = None
    tile.is_blocked = True
    tile.defense_power = 0
    tile.permanent_defense_bonus = 0
    tile.is_vp = False  # VP hexes lose their status when blocked
    tile.vp_value = 0
    # Gain resources (value/upgraded_value from effect entry — see card YAML)
    gained = effect.effective_value(ctx.card.is_upgraded)
    ctx.player.resources += gained
    ctx.game._log(
        f"{ctx.player.name} scorches tile {ctx.action.target_q},{target_r} "
        f"(now blocked terrain, +{gained} resources)",
        actor=ctx.player.id)


def _handle_mandatory_self_trash(effect: Effect, ctx: EffectContext) -> None:
    """Demon Pact: trash exactly N cards from hand (mandatory, validated in play_card)."""
    count = effect.effective_value(ctx.card.is_upgraded)
    indices = ctx.trash_card_indices[:count]

    trashed = []
    for idx in sorted(indices, reverse=True):
        if 0 <= idx < len(ctx.player.hand):
            card_to_trash = ctx.player.hand[idx]
            if card_to_trash.trash_immune:
                ctx.game._log(
                    f"{ctx.player.name}: {card_to_trash.name} is immune to trashing, skipping",
                    visible_to=[ctx.player.id], actor=ctx.player.id)
                continue
            trashed.append(ctx.player.hand.pop(idx))

    if trashed:
        ctx.player.trash.extend(trashed)
        names = ", ".join(c.name for c in trashed)
        ctx.game._log(
            f"{ctx.player.name} sacrifices {names} for {ctx.card.name}",
            actor=ctx.player.id)


register_handler(EffectType.GLOBAL_CLAIM_BAN, _handle_global_claim_ban)
register_handler(EffectType.GLOBAL_RANDOM_TRASH, _handle_global_random_trash)
register_handler(EffectType.SWAP_DRAW_DISCARD, _handle_swap_draw_discard)
register_handler(EffectType.ABANDON_TILE, _handle_abandon_tile)
register_handler(EffectType.ABANDON_AND_BLOCK, _handle_abandon_and_block)
register_handler(EffectType.MANDATORY_SELF_TRASH, _handle_mandatory_self_trash)


def _handle_trash_gain_power(effect: Effect, ctx: EffectContext) -> None:
    """Arms Dealer: trash 1 card from hand. If it was a Claim card, gain
    resources equal to double its effective power and gain action(s)."""
    if not ctx.player.hand:
        ctx.game._log(f"{ctx.player.name}: no cards to trash, skipping",
                      visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    indices = ctx.trash_card_indices[:1]
    if not indices:
        if ctx.player.hand:
            ctx.game._log(
                f"{ctx.player.name}: no trash choice provided for {ctx.card.name}, skipping",
                visible_to=[ctx.player.id], actor=ctx.player.id)
        return

    idx = indices[0]
    if 0 <= idx < len(ctx.player.hand):
        trashed_card = ctx.player.hand[idx]
        if trashed_card.trash_immune:
            ctx.game._log(
                f"{ctx.player.name}: {trashed_card.name} is immune to trashing, skipping",
                visible_to=[ctx.player.id], actor=ctx.player.id)
            return
        trashed_card = ctx.player.hand.pop(idx)
        ctx.player.trash.append(trashed_card)

        if trashed_card.card_type == CardType.CLAIM:
            # Use effective power (includes upgrades and printed modifiers)
            power = trashed_card.effective_power
            multiplier = int(effect.metadata.get("multiplier", 2))
            resources_gained = power * multiplier
            ctx.player.resources += resources_gained

            action_key = "upgraded_claim_action_return" if ctx.card.is_upgraded else "claim_action_return"
            actions_gained = int(effect.metadata.get(action_key, 1))
            ctx.player.actions_available += actions_gained

            ctx.game._log(
                f"{ctx.player.name} trashes {trashed_card.name} (Claim, power {power}) "
                f"and gains {resources_gained} resources and {actions_gained} action(s)",
                visible_to=[ctx.player.id], actor=ctx.player.id)
        else:
            ctx.game._log(
                f"{ctx.player.name} trashes {trashed_card.name} (not a Claim card — no bonus)",
                visible_to=[ctx.player.id], actor=ctx.player.id)


register_handler(EffectType.TRASH_GAIN_POWER, _handle_trash_gain_power)


def _handle_resources_per_tiles_owned(effect: Effect, ctx: EffectContext) -> None:
    """War Economy: gain 1 resource per N tiles owned."""
    if not ctx.game.grid:
        return
    tile_count = sum(
        1 for tile in ctx.game.grid.tiles.values()
        if tile.owner == ctx.player.id
    )
    divisor = effect.effective_value(ctx.card.is_upgraded)
    if divisor <= 0:
        divisor = 4
    gained = tile_count // divisor
    ctx.player.resources += gained
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} gains {gained} resources "
        f"({tile_count} tiles / {divisor})",
        visible_to=[ctx.player.id], actor=ctx.player.id)


register_handler(EffectType.RESOURCES_PER_TILES_OWNED, _handle_resources_per_tiles_owned)


# ── Search / tutor handler ────────────────────────────────────────

_SEARCH_ZONE_FIELDS = {
    "discard": lambda p: p.deck.discard,
    "draw": lambda p: p.deck.cards,
    "trash": lambda p: p.trash,
}

# User-facing zone names for log messages. "draw" is an internal key; players
# see it as "draw pile".
_SEARCH_ZONE_DISPLAY = {
    "discard": "discard pile",
    "draw": "draw pile",
    "trash": "trash",
}


def get_search_zone_cards(player: Any, source: str) -> list[Card]:
    """Return the live list of cards for a search source zone.

    Returns the same list object the Deck/Player stores, so callers can mutate
    it directly when moving cards out of the zone.
    """
    getter = _SEARCH_ZONE_FIELDS.get(source)
    if getter is None:
        return []
    result: list[Card] = getter(player)
    return result


def _handle_search_zone(effect: Effect, ctx: EffectContext) -> None:
    """Set pending_search state; resolution is deferred until the player submits selections."""
    from .game_state import PendingSearch

    source = str(effect.metadata.get("source", "discard"))
    targets = effect.metadata.get("targets") or ["hand"]
    if not isinstance(targets, list) or not targets:
        targets = ["hand"]

    count = effect.effective_value(ctx.card.is_upgraded)
    min_count_raw = effect.metadata.get("min")
    min_count = int(min_count_raw) if min_count_raw is not None else count

    source_list = get_search_zone_cards(ctx.player, source)

    # Apply filter to determine eligible card ids (kept for snapshot ordering)
    card_filter = effect.metadata.get("filter") if isinstance(effect.metadata.get("filter"), dict) else None
    eligible = [c for c in source_list if _matches_card_filter(c, card_filter)]

    # For draw-pile searches, the default card-text contract is "look at the
    # top N cards" — peeking the entire draw pile would leak information the
    # effect doesn't grant. Cap the snapshot to the top N (in natural draw
    # order; the frontend then shuffles for display). Two metadata overrides:
    #   peek_all: true   — see the entire pile (e.g. Foresight)
    #   peek: <int>      — see top X (e.g. "look at top 4, pick up to 2")
    # When neither is set, peek defaults to the pick count.
    peek_all = source == "draw" and bool(effect.metadata.get("peek_all", False))
    if source == "draw" and not peek_all:
        peek_raw = effect.metadata.get("peek")
        peek = int(peek_raw) if peek_raw is not None else count
        eligible = eligible[:peek]

    zone_name = _SEARCH_ZONE_DISPLAY.get(source, source)

    if not eligible:
        ctx.game._log(
            f"{ctx.player.name}'s {ctx.card.name}: no matching cards in {zone_name} — effect fizzles",
            visible_to=[ctx.player.id], actor=ctx.player.id,
        )
        return

    clamped_count = min(count, len(eligible))
    clamped_min = max(0, min(min_count, clamped_count))

    ctx.player.pending_search = PendingSearch(
        source=source,
        count=clamped_count,
        min_count=clamped_min,
        allowed_targets=[str(t) for t in targets],
        card_filter=card_filter,
        snapshot_card_ids=[c.id for c in eligible],
        peek_all=peek_all,
    )
    ctx.game._log(
        f"{ctx.player.name} searches {zone_name} with {ctx.card.name} "
        f"(pick {clamped_min}..{clamped_count})",
        visible_to=[ctx.player.id], actor=ctx.player.id,
    )


def matches_card_filter(card: Card, card_filter: Optional[dict[str, Any]]) -> bool:
    """Check whether a card satisfies the optional SEARCH_ZONE filter metadata."""
    if not card_filter:
        return True
    card_type_filter = card_filter.get("card_type")
    if card_type_filter:
        expected = str(card_type_filter).lower()
        if card.card_type.value.lower() != expected:
            return False
    name_filter = card_filter.get("name")
    if name_filter and card.name != name_filter:
        return False
    return True


# Backward-compat alias for existing internal callers.
_matches_card_filter = matches_card_filter


register_handler(EffectType.SEARCH_ZONE, _handle_search_zone)
