"""Effect resolution engine.

Dispatches card effects to handler functions based on EffectType.
New effects can be added by registering a handler via register_handler().
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional

from .cards import Card, CardType, Timing
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
            _dispatch(effect, ctx)


def calculate_effective_power(
    game: GameState,
    player: Player,
    card: Card,
    action: PlannedAction,
) -> int:
    """Calculate total power for a claim card including conditional modifiers."""
    base_power = card.effective_power
    bonus = 0

    target_q = action.target_q
    target_r = action.target_r if action.target_r is not None else 0

    for effect in card.effects:
        if effect.type != EffectType.POWER_MODIFIER:
            continue
        if not check_condition(effect.condition, game, player, card, action):
            continue

        if effect.condition == ConditionType.CARDS_IN_HAND:
            # Numbers Game: power = hand size (replaces base power)
            return int(len(player.hand) + effect.value)

        if effect.condition == ConditionType.IF_ADJACENT_OWNED_GTE:
            if effect.metadata.get("per_tile"):
                # Overwhelm: +value per adjacent owned tile
                if game.grid and target_q is not None:
                    adj_tiles = game.grid.get_adjacent(target_q, target_r)
                    owned_adj = sum(1 for t in adj_tiles if t.owner == player.id)
                    bonus += effect.value * owned_adj
            else:
                # Militia: flat bonus if threshold met
                bonus += effect.value
        else:
            # Generic conditional bonus (Strike Team, Garrison, etc.)
            bonus += effect.value

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
        # Rabble: check if another card with same name was played this turn
        same_name = [
            a for a in player.planned_actions
            if a.card.name == card.name and a.card.id != card.id
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

    return False


# ── Effect handlers ───────────────────────────────────────────────


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
            trashed.append(ctx.player.hand.pop(idx))

    if trashed:
        ctx.player.trash.extend(trashed)
        names = ", ".join(c.name for c in trashed)
        ctx.game._log(f"{ctx.player.name} trashes {names} from hand",
                      visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_trash_gain_buy_cost(effect: Effect, ctx: EffectContext) -> None:
    """Consolidate: trash a card from hand, gain resources equal to its buy cost."""
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
        trashed_card = ctx.player.hand.pop(idx)
        ctx.player.trash.append(trashed_card)
        refund = trashed_card.buy_cost or 0
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
    if ctx.target_tile_key:
        ctx.player.turn_modifiers.immune_tiles[ctx.target_tile_key] = effect.duration
        ctx.game._log(
            f"{ctx.player.name} protects tile {ctx.target_tile_key} for {effect.duration} round(s)",
            actor=ctx.player.id)


def _handle_ignore_defense(effect: Effect, ctx: EffectContext) -> None:
    """Siege Engine: claims on this tile ignore defense cards."""
    if ctx.target_tile_key:
        ctx.player.turn_modifiers.ignore_defense_tiles.add(ctx.target_tile_key)
        ctx.game._log(f"{ctx.player.name}'s claim on {ctx.target_tile_key} ignores defense cards",
                      actor=ctx.player.id)


def _handle_buy_restriction(effect: Effect, ctx: EffectContext) -> None:
    """Blitz Rush: player cannot buy cards this round."""
    ctx.player.turn_modifiers.buy_locked = True
    ctx.game._log(f"{ctx.player.name} cannot purchase cards this round",
                  visible_to=[ctx.player.id], actor=ctx.player.id)


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


def _handle_grant_actions(effect: Effect, ctx: EffectContext) -> None:
    """Forced March / Surge Protocol: give other players actions."""
    if effect.target == "all_others":
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


def _handle_draw_next_turn(effect: Effect, ctx: EffectContext) -> None:
    """Blitz / Forward March secondary: draw extra cards next turn."""
    ctx.player.turn_modifiers.extra_draws_next_turn += effect.value
    ctx.game._log(
        f"{ctx.player.name} will draw {effect.value} extra card(s) next turn from {ctx.card.name}",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_auto_claim_adjacent_neutral(effect: Effect, ctx: EffectContext) -> None:
    """Breakthrough: on success, claim one adjacent neutral tile."""
    if not ctx.game.grid or ctx.action.target_q is None:
        return
    target_r = ctx.action.target_r if ctx.action.target_r is not None else 0
    adj_tiles = ctx.game.grid.get_adjacent(ctx.action.target_q, target_r)
    for tile in adj_tiles:
        if tile.owner is None and not tile.is_blocked:
            tile.owner = ctx.player.id
            tile.held_since_turn = ctx.game.current_round
            ctx.game._log(
                f"{ctx.player.name} auto-claims neutral tile {tile.key} from {ctx.card.name}",
                actor=ctx.player.id)
            break


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
    """Spearhead: resolve this claim immediately during plan phase."""
    if ctx.target_tile_key:
        ctx.player.turn_modifiers.immediate_resolve_tiles.add(ctx.target_tile_key)
        ctx.game._log(
            f"{ctx.player.name}'s claim on {ctx.target_tile_key} resolves immediately (Spearhead)",
            actor=ctx.player.id)


def _handle_resource_refund_if_neutral(effect: Effect, ctx: EffectContext) -> None:
    """Overwhelming Force: gain resource refund if target tile was neutral."""
    ctx.player.resources += effect.value
    ctx.game._log(
        f"{ctx.player.name} gains {effect.value} resource refund (neutral tile)",
        visible_to=[ctx.player.id], actor=ctx.player.id)


def _handle_stacking_power_bonus(effect: Effect, ctx: EffectContext) -> None:
    """Dog Pile: handled in calculate_effective_power, no runtime action needed."""
    pass


def _handle_conditional_action_return(effect: Effect, ctx: EffectContext) -> None:
    """Rabble: gain action back if another Rabble was played."""
    ctx.player.actions_available += effect.value
    ctx.game._log(
        f"{ctx.player.name} gains {effect.value} action(s) back from {ctx.card.name} synergy",
        visible_to=[ctx.player.id], actor=ctx.player.id)


# Stub handlers for complex effects
def _handle_stub(effect: Effect, ctx: EffectContext) -> None:
    """Placeholder for not-yet-implemented effects."""
    ctx.game._log(f"[STUB] {effect.type.value} effect not yet implemented")


# ── Register all handlers ─────────────────────────────────────────

register_handler(EffectType.SELF_DISCARD, _handle_self_discard)
register_handler(EffectType.SELF_TRASH, _handle_self_trash)
register_handler(EffectType.TRASH_GAIN_BUY_COST, _handle_trash_gain_buy_cost)
register_handler(EffectType.GAIN_VP, _handle_gain_vp)
register_handler(EffectType.TILE_IMMUNITY, _handle_tile_immunity)
register_handler(EffectType.IGNORE_DEFENSE, _handle_ignore_defense)
register_handler(EffectType.BUY_RESTRICTION, _handle_buy_restriction)
register_handler(EffectType.COST_REDUCTION, _handle_cost_reduction)
register_handler(EffectType.GRANT_ACTIONS, _handle_grant_actions)
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
            count += 1
    ctx.game._log(
        f"{ctx.player.name}'s {ctx.card.name} grants Stackable to {count} claim card(s)",
        actor=ctx.player.id)


register_handler(EffectType.GRANT_STACKABLE, _handle_grant_stackable)

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


# ── VP-generating effect handlers ────────────────────────────────


def _handle_vp_from_tiles(effect: Effect, ctx: EffectContext) -> None:
    """Territorial Dominance: gain VP = tiles owned / divisor."""
    if not ctx.game.grid:
        return
    tiles_owned = len(ctx.game.grid.get_player_tiles(ctx.player.id))
    divisor = effect.metadata.get("divisor", 5)
    if ctx.card.is_upgraded:
        divisor = effect.metadata.get("upgraded_divisor", divisor)
    vp = tiles_owned // divisor
    if vp > 0:
        ctx.player.vp += vp
        ctx.game._log(
            f"{ctx.player.name} gains {vp} VP from {ctx.card.name} "
            f"({tiles_owned} tiles / {divisor})",
            actor=ctx.player.id)


def _handle_vp_from_tile_sacrifice(effect: Effect, ctx: EffectContext) -> None:
    """Scorched Earth: sacrifice non-VP tiles for VP."""
    if not ctx.game.grid:
        return
    tiles_per_vp = effect.metadata.get("tiles_per_vp", 3)
    if ctx.card.is_upgraded:
        tiles_per_vp = effect.metadata.get("upgraded_tiles_per_vp", tiles_per_vp)

    # Find all non-VP tiles owned by the player, sorted by strategic value (lowest first)
    sacrificeable = []
    for tile in ctx.game.grid.tiles.values():
        if tile.owner == ctx.player.id and not tile.is_vp:
            # Score: fewer enemy neighbors = less strategic = sacrifice first
            adj = ctx.game.grid.get_adjacent(tile.q, tile.r)
            enemy_adj = sum(1 for a in adj if a.owner and a.owner != ctx.player.id)
            vp_adj = sum(1 for a in adj if a.is_vp)
            score = enemy_adj + vp_adj * 2  # higher = more valuable = sacrifice last
            sacrificeable.append((score, tile))
    sacrificeable.sort(key=lambda x: x[0])

    # Sacrifice in multiples of tiles_per_vp to maximize VP
    max_sacrifice = (len(sacrificeable) // tiles_per_vp) * tiles_per_vp
    sacrificed = 0
    for _, tile in sacrificeable[:max_sacrifice]:
        tile.owner = None
        tile.held_since_turn = None
        tile.defense_power = tile.base_defense
        sacrificed += 1

    vp = sacrificed // tiles_per_vp
    if vp > 0:
        ctx.player.vp += vp
        ctx.game._log(
            f"{ctx.player.name} sacrifices {sacrificed} tiles for {vp} VP from {ctx.card.name}",
            actor=ctx.player.id)


def _handle_vp_from_defense(effect: Effect, ctx: EffectContext) -> None:
    """Fortified Position: gain VP for each tile with N+ defense."""
    if not ctx.game.grid:
        return
    min_defense = effect.metadata.get("min_defense", 3)
    if ctx.card.is_upgraded:
        min_defense = effect.metadata.get("upgraded_min_defense", min_defense)

    qualifying = sum(
        1 for tile in ctx.game.grid.tiles.values()
        if tile.owner == ctx.player.id and tile.defense_power >= min_defense
    )
    vp = qualifying * effect.value
    if vp > 0:
        ctx.player.vp += vp
        ctx.game._log(
            f"{ctx.player.name} gains {vp} VP from {ctx.card.name} "
            f"({qualifying} tiles with {min_defense}+ defense)",
            actor=ctx.player.id)


def _handle_vp_for_all(effect: Effect, ctx: EffectContext) -> None:
    """Diplomacy: all players (including self) gain VP."""
    base_vp = effect.value
    self_bonus = effect.metadata.get("self_bonus", 0)
    if ctx.card.is_upgraded:
        self_bonus = effect.metadata.get("self_bonus_upgraded", self_bonus)
    self_vp = base_vp + self_bonus

    ctx.player.vp += self_vp
    ctx.game._log(
        f"{ctx.player.name} gains {self_vp} VP from {ctx.card.name}",
        actor=ctx.player.id)

    for pid, other in ctx.game.players.items():
        if pid != ctx.player.id:
            other.vp += base_vp
            ctx.game._log(
                f"{other.name} gains {base_vp} VP from {ctx.player.name}'s {ctx.card.name}",
                actor=ctx.player.id)


def _handle_vp_from_contested_wins(effect: Effect, ctx: EffectContext) -> None:
    """Battle Glory: gain VP if player won N+ contested non-neutral tiles this turn."""
    if not ctx.claim_results or not ctx.game.grid:
        return
    required = effect.metadata.get("required_wins", 4)
    vp_award = effect.value
    if ctx.card.is_upgraded:
        vp_award = effect.metadata.get("upgraded_value", vp_award)

    # Count contested wins against non-neutral tiles
    contested_wins = 0
    for tile_key, results in ctx.claim_results.items():
        if ctx.player.id not in results:
            continue
        if not results[ctx.player.id]:
            continue  # didn't win this tile
        # Check if the tile was previously owned by another player (not neutral)
        # Look at resolution steps for previous_owner info
        for step in ctx.game.resolution_steps:
            if step.get("tile_key") == tile_key:
                prev = step.get("previous_owner")
                if prev is not None and prev != ctx.player.id:
                    contested_wins += 1
                break

    if contested_wins >= required:
        ctx.player.vp += vp_award
        ctx.game._log(
            f"{ctx.player.name} gains {vp_award} VP from {ctx.card.name} "
            f"({contested_wins} contested wins >= {required} required)",
            actor=ctx.player.id)


def _handle_vp_from_trash_claims(effect: Effect, ctx: EffectContext) -> None:
    """Sacrifice for Glory: trash claim cards from hand, gain VP = total power / divisor."""
    divisor = effect.metadata.get("divisor", 3)
    if ctx.card.is_upgraded:
        divisor = effect.metadata.get("upgraded_divisor", divisor)

    # Find all claim cards in hand at provided indices (or all claims if no indices)
    indices = ctx.trash_card_indices
    if not indices:
        # Default: trash all claim cards in hand
        indices = [i for i, c in enumerate(ctx.player.hand)
                   if c.card_type == CardType.CLAIM]

    # Validate indices and collect claim cards
    total_power = 0
    trashed_names = []
    trashed_cards = []
    for idx in sorted(indices, reverse=True):
        if 0 <= idx < len(ctx.player.hand):
            card = ctx.player.hand[idx]
            if card.card_type == CardType.CLAIM:
                total_power += card.effective_power
                trashed_names.append(card.name)
                trashed_cards.append(ctx.player.hand.pop(idx))

    if trashed_cards:
        ctx.player.trash.extend(trashed_cards)

    vp = total_power // divisor
    if vp > 0:
        ctx.player.vp += vp
    if trashed_names:
        ctx.game._log(
            f"{ctx.player.name} trashes {', '.join(trashed_names)} (power {total_power}) "
            f"for {vp} VP from {ctx.card.name}",
            actor=ctx.player.id)


def _handle_permanent_defense(effect: Effect, ctx: EffectContext) -> None:
    """Entrench: permanently increase a tile's defense (persists until captured)."""
    if not ctx.target_tile_key or not ctx.game.grid:
        return
    parts = ctx.target_tile_key.split(",")
    if len(parts) != 2:
        return
    tile = ctx.game.grid.get_tile(int(parts[0]), int(parts[1]))
    if tile and tile.owner == ctx.player.id:
        bonus = effect.value
        if ctx.card.is_upgraded:
            bonus = effect.metadata.get("upgraded_value", bonus)
        tile.permanent_defense_bonus += bonus
        tile.defense_power += bonus  # also apply immediately this round
        ctx.game._log(
            f"{ctx.player.name} permanently fortifies tile {ctx.target_tile_key} "
            f"(+{bonus} defense, now {tile.defense_power})",
            actor=ctx.player.id)


register_handler(EffectType.PERMANENT_DEFENSE, _handle_permanent_defense)
register_handler(EffectType.VP_FROM_TILES, _handle_vp_from_tiles)
register_handler(EffectType.VP_FROM_TILE_SACRIFICE, _handle_vp_from_tile_sacrifice)
register_handler(EffectType.VP_FROM_DEFENSE, _handle_vp_from_defense)
register_handler(EffectType.VP_FOR_ALL, _handle_vp_for_all)
register_handler(EffectType.VP_FROM_CONTESTED_WINS, _handle_vp_from_contested_wins)
register_handler(EffectType.VP_FROM_TRASH_CLAIMS, _handle_vp_from_trash_claims)


# Stubs for complex effects
register_handler(EffectType.CEASE_FIRE, _handle_cease_fire)
register_handler(EffectType.ADJACENCY_BRIDGE, _handle_stub)
register_handler(EffectType.DECK_PEEK, _handle_stub)
register_handler(EffectType.DYNAMIC_BUY_COST, _handle_dynamic_buy_cost)
register_handler(EffectType.TRASH_OPPONENT_CARD, _handle_trash_opponent_card)
