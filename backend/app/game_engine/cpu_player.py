"""CPU player logic for automated game simulation.

Provides heuristic-based decision-making for each game phase.
A `noise` parameter (0.0–1.0) controls randomness: 0.0 = always pick
the highest-scored option, 1.0 = pick uniformly among reasonable options.

Difficulty levels: easy=0.25, medium=0.10, hard=0.05 noise.

Strategic features:
- VP denial: prioritizes contesting opponent VP hexes about to score
- Tempo-sensitive buying: favors cheap/thinning early, finishers/VP late
- Adaptive play style: shifts aggression/defense based on VP standing
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Optional

from .cards import Archetype, Card, CardType, Timing
from .effects import ConditionType, EffectType
from .hex_grid import HexGrid, HexTile


# ── Archetype strategy weights ───────────────────────────────────

@dataclass
class StrategyWeights:
    aggression: float = 1.0       # take enemy tiles
    expansion: float = 1.0        # take neutral tiles
    defense: float = 1.0          # protect owned tiles
    vp_hex_priority: float = 1.0  # prioritize VP hexes
    card_draw_value: float = 1.0  # value of draw effects
    resource_value: float = 1.0   # value of resource gain


ARCHETYPE_WEIGHTS: dict[Archetype, StrategyWeights] = {
    Archetype.VANGUARD: StrategyWeights(
        aggression=2.0, expansion=1.2, defense=0.5,
        vp_hex_priority=3.0, card_draw_value=1.0, resource_value=0.8,
    ),
    Archetype.SWARM: StrategyWeights(
        aggression=1.0, expansion=2.0, defense=0.3,
        vp_hex_priority=1.5, card_draw_value=1.5, resource_value=0.8,
    ),
    Archetype.FORTRESS: StrategyWeights(
        aggression=0.5, expansion=0.8, defense=2.5,
        vp_hex_priority=2.25, card_draw_value=1.0, resource_value=1.5,
    ),
}


def _game_progress(game: Any) -> float:
    """Return game progress as 0.0 (start) to 1.0 (end).

    Uses current round relative to max rounds.
    """
    max_r = getattr(game, "max_rounds", 20) or 20
    progress = (game.current_round - 1) / max(1, max_r - 1)
    return min(1.0, max(0.0, float(progress)))


def _is_vp_leader(game: Any, player_id: str, strict: bool = True) -> bool:
    """Return True if *player_id* is the VP leader.

    When *strict* is True, ties do not count as leading. Uses derived VP
    (compute_player_vp) so passive-VP cards and held VP hexes are counted.
    """
    from .game_state import compute_player_vp
    my_vp = compute_player_vp(game, player_id)
    for pid in game.players:
        if pid == player_id:
            continue
        other_vp = compute_player_vp(game, pid)
        if strict and other_vp >= my_vp:
            return False
        if (not strict) and other_vp > my_vp:
            return False
    return True


def _iter_all_player_cards(player: Any) -> list[Card]:
    """All cards currently in a player's active deck (hand + draw + discard).

    Trashed cards and planned_actions are intentionally excluded — the former
    are gone, the latter are already accounted for in hand when considering
    deck composition for buy decisions at the start of the buy phase.
    """
    cards: list[Card] = list(player.hand)
    deck = getattr(player, "deck", None)
    if deck is not None:
        cards.extend(deck.cards)
        cards.extend(deck.discard)
    return cards


def _deck_composition(player: Any) -> dict[str, float]:
    """Return ratios describing the player's active deck.

    Keys:
      - total: total card count (int, cast to float for arithmetic)
      - high_power_claim_ratio: fraction of deck that is a claim with base
        power >= 3 (after upgrades)
      - resource_gain_ratio: fraction of deck that grants at least 1 resource
        when played (Gather, most engine cards)
      - claim_count: absolute count of claim cards (int) — used as a floor
        when deciding whether to trash Explore.
    """
    cards = _iter_all_player_cards(player)
    total = len(cards)
    if total == 0:
        return {
            "total": 0.0,
            "high_power_claim_ratio": 0.0,
            "resource_gain_ratio": 0.0,
            "claim_count": 0,
        }
    high_power_claims = sum(
        1 for c in cards
        if c.card_type == CardType.CLAIM
        and c.effective_power >= 3
        and not _is_limited_use_claim(c)
    )
    resource_gain = sum(
        1 for c in cards if c.effective_resource_gain > 0
    )
    claim_count = sum(1 for c in cards if c.card_type == CardType.CLAIM)
    return {
        "total": float(total),
        "high_power_claim_ratio": high_power_claims / total,
        "resource_gain_ratio": resource_gain / total,
        "claim_count": claim_count,
    }


def _is_limited_use_claim(card: Card) -> bool:
    """True if a claim card has a targeting constraint so narrow that its
    raw power overstates its real value.

    Currently flags adjacency-bridge claims (Road Builder): the card can only
    target tiles that connect two disconnected territory groups, so it is
    unplayable most turns regardless of its printed power.
    """
    if card.card_type != CardType.CLAIM:
        return False
    return any(e.type == EffectType.ADJACENCY_BRIDGE for e in card.effects)


def _owns_passive_vp(player: Any) -> bool:
    """True if the player's active deck contains any passive-VP card
    (e.g. Land Grant). The CPU should lean harder into VP-generating plays
    when this is the case."""
    for c in _iter_all_player_cards(player):
        if getattr(c, "passive_vp", 0) and c.passive_vp > 0:
            return True
    return False


def _adapt_weights(weights: StrategyWeights, game: Any, player_id: str) -> StrategyWeights:
    """Adjust strategy weights based on VP standing (adaptive play style).

    When behind: boost aggression and VP hex priority (catch-up mode).
    When ahead: boost defense, reduce aggression (protect lead).
    """
    from .game_state import compute_player_vp

    players = game.players
    if len(players) < 2:
        return weights

    my_vp = compute_player_vp(game, player_id)
    vp_values = [compute_player_vp(game, pid) for pid in players if pid != player_id]
    max_opponent_vp = max(vp_values) if vp_values else 0
    vp_target = getattr(game, "vp_target", 10)

    # How far ahead/behind as fraction of vp_target (-1.0 to +1.0 range)
    vp_diff = (my_vp - max_opponent_vp) / max(1, vp_target)
    # Clamp to reasonable range
    vp_diff = max(-1.0, min(1.0, vp_diff))

    # Scale adjustments — bigger delta = stronger adaptation
    # Behind: vp_diff is negative, so aggression_boost is positive
    aggression_mod = 1.0 - vp_diff * 0.4   # behind → up to +40%, ahead → down to -40%
    defense_mod = 1.0 + vp_diff * 0.4      # ahead → up to +40%, behind → down to -40%
    vp_hex_mod = 1.0 - vp_diff * 0.3       # behind → prioritize VP hexes more

    return StrategyWeights(
        aggression=weights.aggression * aggression_mod,
        expansion=weights.expansion,
        defense=weights.defense * defense_mod,
        vp_hex_priority=weights.vp_hex_priority * vp_hex_mod,
        card_draw_value=weights.card_draw_value,
        resource_value=weights.resource_value,
    )


# ── CPU Player ────────────────────────────────────────────────────

class CPUPlayer:
    """Heuristic CPU player that makes decisions for all game phases."""

    def __init__(self, player_id: str, noise: float = 0.0,
                 rng: Optional[random.Random] = None):
        self.player_id = player_id
        self.noise = max(0.0, min(1.0, noise))
        self.rng = rng or random.Random()

    # ── Selection helper ──────────────────────────────────────────

    def _pick(self, scored: list[tuple[float, Any]]) -> Optional[Any]:
        """Pick from scored options using noise-controlled selection.

        scored: list of (score, item) — higher score = better.
        Returns the selected item, or None if list is empty.
        """
        if not scored:
            return None

        if self.noise <= 0.0:
            # Deterministic: pick the highest scored
            return max(scored, key=lambda x: x[0])[1]

        if self.noise >= 1.0:
            # Fully random among all options
            return self.rng.choice(scored)[1]

        # Weighted random: blend between deterministic and uniform
        # Shift scores to be positive, then apply softmax-like weighting
        min_score = min(s for s, _ in scored)
        shifted = [(s - min_score + 0.1, item) for s, item in scored]
        total = sum(s for s, _ in shifted)

        # Blend: (1-noise) * score_weight + noise * uniform
        weights = []
        uniform = 1.0 / len(shifted)
        for s, _ in shifted:
            score_weight = s / total if total > 0 else uniform
            w = (1.0 - self.noise) * score_weight + self.noise * uniform
            weights.append(w)

        # Weighted random selection
        r = self.rng.random() * sum(weights)
        cumulative = 0.0
        for i, w in enumerate(weights):
            cumulative += w
            if r <= cumulative:
                return shifted[i][1]
        return shifted[-1][1]

    # ── Play Phase ────────────────────────────────────────────────

    def plan_actions(self, game: Any) -> list[dict[str, Any]]:
        """Decide which cards to play and in what order during Play phase.

        Returns a list of action dicts suitable for calling play_card():
            [{"card_index": int, "target_q": int|None, "target_r": int|None,
              "target_player_id": str|None, "discard_card_indices": list|None,
              "trash_card_indices": list|None, "extra_targets": list|None}, ...]
        """
        player = game.players[self.player_id]
        weights = ARCHETYPE_WEIGHTS.get(player.archetype, StrategyWeights())
        weights = _adapt_weights(weights, game, self.player_id)
        actions: list[dict[str, Any]] = []

        # Keep playing cards while we have actions and cards
        while player.hand and player.actions_used < player.actions_available:
            best = self._pick_best_card(game, player, weights)
            if best is None:
                break
            actions.append(best)
            # Simulate the card being played (the actual play_card call will
            # mutate state, so we just track what we want to do)
            # We return the full list and let the simulation driver call play_card
            # one at a time, re-evaluating after each play.
            # Actually, since play_card mutates hand/actions, we should return
            # one action at a time. Let the caller loop.
            return actions

        return actions

    def pick_next_action(self, game: Any) -> Optional[dict[str, Any]]:
        """Pick the single best card to play next. Returns None if done playing."""
        player = game.players[self.player_id]
        if not player.hand:
            return None
        if player.actions_used >= player.actions_available:
            # Check if any remaining card has action_return > 0 (net neutral/positive)
            has_free = any(
                c.effective_action_return > 0
                for c in player.hand
            )
            if not has_free:
                return None

        weights = ARCHETYPE_WEIGHTS.get(player.archetype, StrategyWeights())
        weights = _adapt_weights(weights, game, self.player_id)
        return self._pick_best_card(game, player, weights)

    def _pick_best_card(self, game: Any, player: Any,
                        weights: StrategyWeights) -> Optional[dict[str, Any]]:
        """Score all playable cards and pick one."""
        scored: list[tuple[float, dict[str, Any]]] = []

        for i, card in enumerate(player.hand):
            # Skip unplayable cards (e.g. Land Grant)
            if card.unplayable:
                continue

            # Skip cards we can't afford action-wise
            net_cost = 1 - card.effective_action_return
            if net_cost > 0 and player.actions_used >= player.actions_available:
                continue

            if card.card_type == CardType.CLAIM:
                # Skip claim cards when a global claim ban is active
                if hasattr(game, "claim_ban_rounds") and game.claim_ban_rounds > 0:
                    continue
                tile_actions = self._score_claim_targets(game, player, card, i, weights)
                scored.extend(tile_actions)
            elif card.card_type == CardType.DEFENSE:
                defense_actions = self._score_defense_targets(game, player, card, i, weights)
                scored.extend(defense_actions)
            elif card.card_type == CardType.ENGINE:
                engine_score = self._score_engine(game, player, card, i, weights)
                if engine_score is not None:
                    scored.append(engine_score)

        return self._pick(scored)

    def _score_claim_targets(self, game: Any, player: Any, card: Card,
                             card_index: int,
                             weights: StrategyWeights) -> list[tuple[float, dict[str, Any]]]:
        """Score all valid target tiles for a claim card."""
        assert game.grid is not None
        results: list[tuple[float, dict[str, Any]]] = []
        player_tiles = game.grid.get_player_tiles(self.player_id)

        if not player_tiles and not card.flood:
            return results

        # Cards that target own tiles (Flood, Consecrate, etc.)
        if card.target_own_tile:
            # Consecrate: specifically target connected VP tiles
            has_enhance = any(
                hasattr(e, 'type') and e.type == EffectType.ENHANCE_VP_TILE
                for e in card.effects
            )
            if has_enhance:
                connected = game.grid.get_connected_tiles(self.player_id)
                for pt in player_tiles:
                    if pt.is_vp and (pt.q, pt.r) in connected:
                        score = 10.0  # high priority — permanent board improvement
                        results.append((score, {
                            "card_index": card_index,
                            "target_q": pt.q, "target_r": pt.r,
                        }))
                return results

            # Flood cards: target own tiles with many claimable adjacent
            for pt in player_tiles:
                adj = game.grid.get_adjacent(pt.q, pt.r)
                claimable_adj = [t for t in adj if not t.is_blocked and t.owner != self.player_id]
                if not claimable_adj:
                    continue
                score = len(claimable_adj) * 2.0  # more adjacent = better flood
                vp_adj = sum(1 for t in claimable_adj if t.is_vp)
                score += vp_adj * 5.0 * weights.vp_hex_priority
                results.append((score, {
                    "card_index": card_index,
                    "target_q": pt.q, "target_r": pt.r,
                }))
            return results

        # Get all tiles in range
        candidate_tiles = self._get_claimable_tiles(game, player, card, player_tiles)

        for tile in candidate_tiles:
            # Check stacking
            existing_claims = [
                a for a in player.planned_actions
                if a.target_q == tile.q and a.target_r == tile.r
                and a.card.card_type == CardType.CLAIM
            ]
            if existing_claims and not card.stackable:
                continue

            score = self._score_tile_for_claim(game, player, tile, card, weights)

            action_dict: dict[str, Any] = {
                "card_index": card_index,
                "target_q": tile.q, "target_r": tile.r,
            }

            # Ambush (if_contested power modifier): prefer enemy-owned tiles
            has_contested_bonus = any(
                e.type == EffectType.POWER_MODIFIER
                and e.condition == ConditionType.IF_CONTESTED
                for e in card.effects
            )
            if has_contested_bonus and tile.owner is not None and tile.owner != self.player_id:
                score += 4.0 * weights.aggression  # strongly prefer contested tiles

            # Demon Pact (mandatory_self_trash): require enough trash targets
            has_mandatory_trash = any(
                e.type == EffectType.MANDATORY_SELF_TRASH for e in card.effects
            )
            if has_mandatory_trash:
                for effect in card.effects:
                    if effect.type == EffectType.MANDATORY_SELF_TRASH:
                        trash_count = effect.effective_value(card.is_upgraded)
                        other_cards = [j for j in range(len(player.hand)) if j != card_index]
                        if len(other_cards) < trash_count:
                            continue  # skip — not enough cards to trash
                        trash_indices = self._pick_cards_to_trash(player, trash_count, card_index)
                        action_dict["trash_card_indices"] = trash_indices
                        # Bonus for very high power card when we can afford the trash cost
                        score += 3.0
                        break

            # For cards with forced_discard, target the leading opponent
            if card.forced_discard > 0:
                target_pid = self._pick_forced_discard_target(game, player)
                if target_pid:
                    action_dict["target_player_id"] = target_pid

            # Multi-target (Surge): pick adjacent tiles
            if card.effective_multi_target_count > 0:
                extra = self._pick_extra_targets(game, player, card, tile, weights)
                if extra:
                    action_dict["extra_targets"] = extra

            results.append((score, action_dict))

        return results

    def _get_claimable_tiles(self, game: Any, player: Any, card: Card,
                             player_tiles: list[HexTile]) -> list[HexTile]:
        """Get all tiles this card could legally target."""
        assert game.grid is not None
        candidates: list[HexTile] = []

        if card.adjacency_required:
            # Tiles within claim_range of any owned tile
            seen: set[str] = set()
            for pt in player_tiles:
                for tile in game.grid.tiles.values():
                    if tile.key in seen or tile.is_blocked:
                        continue
                    if pt.distance_to(tile) <= card.claim_range:
                        if card.effective_unoccupied_only and tile.owner is not None:
                            continue
                        # Don't target tiles with defense higher than our power (for neutral)
                        if not tile.owner and tile.defense_power > card.effective_power:
                            continue
                        seen.add(tile.key)
                        candidates.append(tile)
        else:
            # No adjacency requirement — any non-blocked tile
            for tile in game.grid.tiles.values():
                if tile.is_blocked:
                    continue
                if card.effective_unoccupied_only and tile.owner is not None:
                    continue
                if not tile.owner and tile.defense_power > card.effective_power:
                    continue
                candidates.append(tile)

        return candidates

    def _estimate_effective_power(self, game: Any, player: Any, tile: HexTile,
                                  card: Card) -> int:
        """Estimate effective power for a card on a target tile, accounting for effects."""
        power = card.effective_power
        assert game.grid is not None

        for effect in card.effects:
            if effect.type == EffectType.POWER_PER_TILES_OWNED:
                # Mob Rule / Locust Swarm: power based on tiles owned
                divisor = effect.effective_value(card.is_upgraded)
                if divisor <= 0:
                    divisor = 3
                tile_count = len(game.grid.get_player_tiles(self.player_id))
                tile_bonus = tile_count // divisor
                if effect.metadata.get("replaces_base_power"):
                    power = tile_bonus
                else:
                    power += tile_bonus

            elif effect.type == EffectType.POWER_MODIFIER:
                ev = effect.effective_value(card.is_upgraded)
                if effect.condition.value == "if_adjacent_owned_gte":
                    if effect.metadata.get("per_tile"):
                        adj = game.grid.get_adjacent(tile.q, tile.r)
                        owned_adj = sum(1 for t in adj if t.owner == self.player_id)
                        power += ev * owned_adj
                    else:
                        adj = game.grid.get_adjacent(tile.q, tile.r)
                        owned_adj = sum(1 for t in adj if t.owner == self.player_id)
                        if owned_adj >= effect.condition_threshold:
                            power += ev
                elif effect.condition.value == "if_played_claim_this_turn":
                    if any(a.card.card_type == CardType.CLAIM for a in player.planned_actions):
                        power += ev
                elif effect.condition.value == "if_defending_owned":
                    if tile.owner == self.player_id:
                        power += ev
                elif effect.condition.value == "if_target_has_defense":
                    if tile.defense_power > 0 or tile.permanent_defense_bonus > 0:
                        power += ev
                elif effect.condition.value == "cards_in_hand":
                    power = max(0, len(player.hand) - 1) + ev
                elif effect.condition.value == "if_contested":
                    # Ambush: bonus power when targeting an opponent-owned tile
                    if tile.owner is not None and tile.owner != self.player_id:
                        power += ev

        return power

    def _score_tile_for_claim(self, game: Any, player: Any, tile: HexTile,
                              card: Card, weights: StrategyWeights) -> float:
        """Score a tile as a claim target."""
        score = 1.0  # base score for any claim
        passive_vp_mult = 1.3 if _owns_passive_vp(player) else 1.0

        # VP hex bonus — strongly prioritize claiming VP tiles.
        # Pre-compute power vs defense for VP-specific bonuses.
        effective_power = self._estimate_effective_power(game, player, tile, card)
        can_win = effective_power > tile.defense_power

        if tile.is_vp:
            score += tile.vp_value * 12.0 * weights.vp_hex_priority * passive_vp_mult
            # Massive bonus when we can actually capture this VP tile
            if can_win:
                score += tile.vp_value * 15.0 * weights.vp_hex_priority

        # VP denial: any opponent-held VP hex is a high-priority contest target,
        # regardless of how long they've held it. Even a freshly captured VP tile
        # will start scoring next round if left alone.
        if tile.is_vp and tile.owner is not None and tile.owner != self.player_id:
            score += tile.vp_value * 10.0 * weights.vp_hex_priority * passive_vp_mult
            # Even higher bonus when we have the power to actually take it
            if can_win:
                score += tile.vp_value * 20.0 * weights.vp_hex_priority
            # Extra bonus when the tile is about to score (held since a prior round).
            held_since = getattr(tile, "held_since_turn", None)
            if held_since is not None and held_since < game.current_round:
                score += tile.vp_value * 4.0 * weights.vp_hex_priority

        # Neutral vs enemy tile
        if tile.owner is None:
            score += 3.0 * weights.expansion
        elif tile.owner != self.player_id:
            # Enemy tile — factor in defense
            defense = tile.defense_power
            if can_win:
                score += 5.0 * weights.aggression
                # Base raid bonus: raiding generates Rubble (-1 VP each) in opponent's deck
                if tile.is_base:
                    rubble_count = effective_power - defense
                    score += rubble_count * 3.0 * weights.aggression
            elif effective_power == defense:
                score += 1.0 * weights.aggression  # tie goes to defender, risky
            else:
                score -= 2.0  # likely to lose

        # Strategic position: tiles adjacent to VP hexes
        assert game.grid is not None
        adj_tiles = game.grid.get_adjacent(tile.q, tile.r)
        for adj in adj_tiles:
            if adj.is_vp and adj.owner != self.player_id:
                score += 2.5 * weights.vp_hex_priority * passive_vp_mult

        # Connectivity: prefer tiles that connect territory
        owned_neighbors = sum(1 for adj in adj_tiles if adj.owner == self.player_id)
        score += owned_neighbors * 0.5

        # Enemy neighbors: attacking near enemy territory
        enemy_neighbors = sum(
            1 for adj in adj_tiles
            if adj.owner is not None and adj.owner != self.player_id
        )
        score += enemy_neighbors * 0.3 * weights.aggression

        # Card power bonus (prefer using high power cards on contested tiles)
        if tile.owner and tile.owner != self.player_id:
            est_power = self._estimate_effective_power(game, player, tile, card)
            power_margin = est_power - tile.defense_power
            score += power_margin * 0.5

        # Card-power preference: apply a flat bonus proportional to the card's
        # effective power so the CPU gravitates toward playing its strongest
        # claim cards rather than burning weak Explores while high-power cards
        # sit in hand. Uses estimated effective power so Mob Rule / Ambush /
        # flank bonuses are rewarded appropriately on the selected tile.
        est_power_flat = self._estimate_effective_power(game, player, tile, card)
        score += est_power_flat * 1.2

        return score

    def _pick_extra_targets(self, game: Any, player: Any, card: Card,
                            primary_tile: HexTile,
                            weights: StrategyWeights) -> list[tuple[int, int]]:
        """Pick extra targets for multi-target cards (Surge)."""
        assert game.grid is not None
        player_tiles = game.grid.get_player_tiles(self.player_id)
        extras: list[tuple[float, tuple[int, int]]] = []

        adj_tiles = game.grid.get_adjacent(primary_tile.q, primary_tile.r)
        for tile in adj_tiles:
            if tile.is_blocked:
                continue
            if card.effective_unoccupied_only and tile.owner is not None:
                continue
            if tile.q == primary_tile.q and tile.r == primary_tile.r:
                continue
            if card.adjacency_required and not any(
                pt.distance_to(tile) <= card.claim_range for pt in player_tiles
            ):
                continue
            score = self._score_tile_for_claim(game, player, tile, card, weights)
            extras.append((score, (tile.q, tile.r)))

        # Sort by score descending, take up to multi_target_count
        extras.sort(key=lambda x: x[0], reverse=True)
        return [coord for _, coord in extras[:card.effective_multi_target_count]]

    def _score_defense_targets(self, game: Any, player: Any, card: Card,
                               card_index: int,
                               weights: StrategyWeights) -> list[tuple[float, dict[str, Any]]]:
        """Score all valid targets for a defense card."""
        assert game.grid is not None
        results: list[tuple[float, dict[str, Any]]] = []
        player_tiles = game.grid.get_player_tiles(self.player_id)

        # Check for special defense effect types
        has_defense_per_adjacent = any(
            e.type == EffectType.DEFENSE_PER_ADJACENT for e in card.effects
        )
        has_ignore_defense_override = any(
            e.type == EffectType.IGNORE_DEFENSE_OVERRIDE for e in card.effects
        )
        has_permanent_defense = any(
            e.type == EffectType.PERMANENT_DEFENSE for e in card.effects
        )

        # Score each tile for defense priority
        tile_scores: list[tuple[float, Any]] = []
        passive_vp_mult = 1.3 if _owns_passive_vp(player) else 1.0
        # Typical enemy claim power baseline — used to decide whether the tile
        # is at real risk of being captured next round. ~3 matches most mid-tier
        # claim cards in the shared market.
        ENEMY_CLAIM_BASELINE = 3
        for tile in player_tiles:
            score = 2.0 * weights.defense  # base defense value

            # VP tiles get much higher defense priority
            if tile.is_vp:
                score += tile.vp_value * 8.0 * weights.vp_hex_priority * passive_vp_mult

            # Tiles with enemy neighbors (frontier tiles) need defense more
            adj_tiles = game.grid.get_adjacent(tile.q, tile.r)
            enemy_neighbors = sum(
                1 for adj in adj_tiles
                if adj.owner is not None and adj.owner != self.player_id
            )
            owned_neighbors = sum(
                1 for adj in adj_tiles if adj.owner == self.player_id
            )
            score += enemy_neighbors * 3.5

            # Risk-of-loss: if our current defense on this tile is below the
            # typical enemy claim power and we have at least one enemy
            # neighbor, the tile is actively at risk of being taken next
            # round. Bump the score so the CPU shores it up.
            current_defense = tile.defense_power + getattr(tile, "permanent_defense_bonus", 0)
            if enemy_neighbors >= 1 and current_defense < ENEMY_CLAIM_BASELINE:
                shortfall = ENEMY_CLAIM_BASELINE - current_defense
                risk_bonus = shortfall * 2.0 * weights.defense
                if tile.is_vp:
                    risk_bonus *= 2.0  # losing a VP tile is catastrophic
                if tile.is_base:
                    risk_bonus *= 1.5  # losing base spawns rubble
                score += risk_bonus

            # Tiles with no enemy neighbors don't need defense as much
            if enemy_neighbors == 0:
                score *= 0.3

            # Nest (DEFENSE_PER_ADJACENT): bonus scales with adjacent owned tiles
            if has_defense_per_adjacent:
                score += owned_neighbors * 2.5  # more adjacent owned = much stronger defense

            # IGNORE_DEFENSE_OVERRIDE: prioritize high-value tiles
            if has_ignore_defense_override:
                score += 3.0  # extra value for the "cannot be ignored" protection
                if tile.is_vp:
                    score += 4.0  # strongly prefer VP tiles for this premium effect

            # Permanent defense (Entrench, Twin Cities): prefer tiles you expect to hold long-term
            if has_permanent_defense:
                score += 2.0  # permanent effects are intrinsically valuable
                # Prefer tiles deeper in own territory (more owned neighbors = safer)
                score += owned_neighbors * 1.0
                # Less value on frontier tiles that might be lost
                if enemy_neighbors > owned_neighbors:
                    score -= 2.0

            tile_scores.append((score, tile))

        # For multi-tile defense cards, pick the best primary target
        # and include extra targets in the action
        defense_target_count = card.effective_defense_target_count
        tile_scores.sort(key=lambda x: x[0], reverse=True)

        for i, (score, tile) in enumerate(tile_scores):
            extra_targets: list[tuple[int, int]] = []
            if defense_target_count > 1:
                # Pick next-best tiles as extra targets (excluding this primary)
                for j, (_, other_tile) in enumerate(tile_scores):
                    if j == i:
                        continue
                    extra_targets.append((other_tile.q, other_tile.r))
                    if len(extra_targets) >= defense_target_count - 1:
                        break
                # Boost score when we can actually use all target slots
                score += len(extra_targets) * 1.5

            action_dict: dict[str, Any] = {
                "card_index": card_index,
                "target_q": tile.q, "target_r": tile.r,
            }
            if extra_targets:
                action_dict["extra_targets"] = extra_targets
            results.append((score, action_dict))

        return results

    def _score_engine(self, game: Any, player: Any, card: Card,
                      card_index: int,
                      weights: StrategyWeights) -> Optional[tuple[float, dict[str, Any]]]:
        """Score an engine card."""
        score = 0.0

        # Debt card: high priority to play if we can afford it (removes dead weight)
        if card.name == "Debt":
            action = {"type": "play_card", "card_index": card_index}
            if player.resources >= 3:
                return (15.0, action)  # Always play Debt if affordable
            else:
                return None  # Can't afford — skip

        # Hard veto: never play a Land-Grant-granting card (Diplomat / Diplomacy)
        # unless we are STRICTLY ahead of every opponent. Handing free VP to
        # opponents from behind — or while tied — just helps them catch up. In
        # particular, at game start everyone is tied at 0 VP, and a non-strict
        # check would treat every CPU as a "leader" and let them play Diplomat
        # freely. We skip the card entirely here rather than penalising its
        # score, because _pick() shifts negative scores back into the positive
        # range and would still let noise pick it.
        if any(e.type == EffectType.GRANT_LAND_GRANTS for e in card.effects):
            if not _is_vp_leader(game, self.player_id, strict=True):
                return None

        # Resource gain
        if card.effective_resource_gain > 0:
            score += card.effective_resource_gain * 1.5 * weights.resource_value

        # Card draw
        if card.effective_draw_cards > 0:
            score += card.effective_draw_cards * 2.0 * weights.card_draw_value

        # Action return makes the card "free" — big bonus
        if card.effective_action_return >= 1:
            score += 3.0  # net-neutral or better is very valuable

        # VP gain (Land Grant, etc.)
        for effect in card.effects:
            if effect.type == EffectType.GAIN_VP:
                score += effect.value * 10.0

        # VP-related effect cards
        for effect in card.effects:
            if effect.type == EffectType.ENHANCE_VP_TILE:
                # Consecrate: play on a connected VP tile to increase its value
                if game.grid:
                    connected = game.grid.get_connected_tiles(self.player_id)
                    vp_tiles = [
                        t for t in game.grid.tiles.values()
                        if t.is_vp and t.owner == self.player_id
                        and (t.q, t.r) in connected
                    ]
                    if vp_tiles:
                        score += 8.0  # permanent board improvement
                    else:
                        score -= 5.0  # can't use it — no valid targets

            elif effect.type == EffectType.GRANT_LAND_GRANTS:
                # We only get here when _is_vp_leader is True (see the hard veto
                # at the top of this function). Score the grant based on its
                # net VP advantage to us vs opponents.
                if effect.target == "chosen_player":
                    # Fortress Diplomacy: you get 1/2, target opponent gets 1
                    self_grants = 2 if card.is_upgraded else 1
                    net_advantage = self_grants - 1  # 0 base, +1 upgraded
                    score += (net_advantage + 1.5) * 5.0
                else:
                    # Neutral Diplomat: you get 1/2, ALL opponents get 1
                    num_opponents = len(game.players) - 1
                    self_grants = 2 if card.is_upgraded else 1
                    # Net is worse with more opponents
                    net_advantage = self_grants - num_opponents
                    score += max(net_advantage + 2.0, 1.0) * 4.0

            elif effect.type == EffectType.VP_FROM_CONTESTED_WINS:
                # Battle Glory: play when we have claims planned against enemies
                claim_count = sum(
                    1 for c in player.hand if c.card_type == CardType.CLAIM
                )
                already_planned = sum(
                    1 for a in player.planned_actions
                    if a.card.card_type == CardType.CLAIM
                )
                required = effect.metadata.get("required_wins", 2)
                if claim_count + already_planned >= required:
                    score += 8.0  # good chance to trigger
                else:
                    score += 1.0  # unlikely but still has long-term value

        # Initialize action_dict early so new effects can attach data to it
        action_dict: dict[str, Any] = {"card_index": card_index}

        # ── New synergy / medium / complex engine effects ────────────
        for effect in card.effects:
            if effect.type == EffectType.CONDITIONAL_ACTION:
                # Spyglass: gain action if hand_size <= threshold
                threshold = effect.condition_threshold or 3
                # Hand shrinks as we play cards; estimate post-play hand size
                current_hand = len(player.hand) - 1  # minus this card being played
                if current_hand <= threshold:
                    score += 3.0  # free action — very valuable
                else:
                    score += 0.5  # unlikely to trigger but still draws/resources

            elif effect.type == EffectType.RESOURCE_SCALING:
                # Dividends: gain resources based on current resources held
                divisor = effect.effective_value(card.is_upgraded)
                if divisor > 0:
                    bonus_res = player.resources // divisor
                    score += bonus_res * 1.5 * weights.resource_value
                else:
                    score += 1.0

            elif effect.type == EffectType.CYCLE:
                # Cartographer: discard N, draw N — hand improvement
                score += 2.5 * weights.card_draw_value
                if effect.requires_choice:
                    discard_count = effect.effective_value(card.is_upgraded)
                    cycle_discard = self._pick_cards_to_discard(player, discard_count)
                    action_dict["discard_card_indices"] = cycle_discard

            elif effect.type == EffectType.RESOURCE_PER_VP_HEX:
                # Tax Collector: gain resources per VP hex controlled
                if game.grid:
                    vp_hexes = [
                        t for t in game.grid.get_player_tiles(self.player_id)
                        if t.is_vp
                    ]
                    res_per_hex = effect.effective_value(card.is_upgraded)
                    score += len(vp_hexes) * res_per_hex * 1.5 * weights.resource_value
                else:
                    score += 1.0

            elif effect.type == EffectType.RESOURCES_PER_TILES_LOST:
                # Robin Hood: gain resources per tile lost last round
                tiles_lost = getattr(player, "tiles_lost_last_round", 0)
                per_tile = effect.effective_value(card.is_upgraded)
                score += tiles_lost * per_tile * 1.5 * weights.resource_value
                if tiles_lost == 0:
                    score += 0.3  # minimal value if no tiles lost

            elif effect.type == EffectType.ACTIONS_PER_CARDS_PLAYED:
                # Mobilize: gain actions based on cards already played
                cards_played = len(player.planned_actions)
                max_actions = effect.effective_value(card.is_upgraded)
                actions_gained = min(cards_played, max_actions)
                score += actions_gained * 3.0
                # Big bonus: this should be played LAST among engine cards
                score += cards_played * 1.5

            elif effect.type == EffectType.NEXT_TURN_BONUS:
                # Supply Depot: invest action now for future benefit
                score += 3.5  # moderate — delayed payoff
                # Check metadata for what bonuses are granted
                bonus_draws = effect.metadata.get("draws", 0)
                bonus_res = effect.metadata.get("resources", 0)
                bonus_actions = effect.metadata.get("actions", 0)
                if card.is_upgraded:
                    bonus_draws = effect.metadata.get("upgraded_draws", bonus_draws)
                    bonus_res = effect.metadata.get("upgraded_resources", bonus_res)
                    bonus_actions = effect.metadata.get("upgraded_actions", bonus_actions)
                score += bonus_draws * 1.5 * weights.card_draw_value
                score += bonus_res * 1.0 * weights.resource_value
                score += bonus_actions * 2.0

            elif effect.type == EffectType.MULLIGAN:
                # Mulligan: discard hand and redraw — value based on hand quality
                starter_count = sum(1 for c in player.hand if c.starter)
                rubble_count = sum(1 for c in player.hand if c.unplayable and c.passive_vp <= 0)
                bad_cards = starter_count + rubble_count
                hand_size = len(player.hand)
                if hand_size > 0 and bad_cards / hand_size >= 0.5:
                    score += 5.0  # bad hand, mulligan is great
                elif bad_cards >= 2:
                    score += 3.0
                else:
                    score += 0.5  # good hand, mulligan wastes time

            elif effect.type == EffectType.SWAP_DRAW_DISCARD:
                # Heady Brew: swap draw and discard piles
                discard_size = len(player.deck.discard)
                draw_size = len(player.deck.cards)
                if discard_size > draw_size + 3:
                    score += 4.0  # discard is much bigger — good swap
                elif discard_size > draw_size:
                    score += 2.0
                else:
                    score += 0.5  # not beneficial

            elif effect.type == EffectType.GLOBAL_RANDOM_TRASH:
                # Plague: all players trash a random card
                num_opponents = len(game.players) - 1
                score += num_opponents * 2.5  # hurts opponents more than us in aggregate
                if card.is_upgraded:
                    score += 2.0  # upgraded version doesn't cost us a card

            elif effect.type == EffectType.INJECT_RUBBLE:
                # Infestation: add Rubble to opponent's discard
                rubble_count = effect.effective_value(card.is_upgraded)
                score += rubble_count * 2.0
                # Pick highest-VP opponent as target
                target_pid = self._pick_forced_discard_target(game, player)
                if target_pid:
                    action_dict["target_player_id"] = target_pid

            elif effect.type == EffectType.ABANDON_TILE:
                # Exodus: give up an owned non-base tile for resources/cards
                tile_result = self._pick_tile_to_abandon(game, player, weights, allow_vp=False)
                if tile_result:
                    score += 3.0 + tile_result[0]
                    action_dict["target_q"] = tile_result[1]
                    action_dict["target_r"] = tile_result[2]
                else:
                    return None  # no valid tiles to abandon

            elif effect.type == EffectType.ABANDON_AND_BLOCK:
                # Scorched Retreat: abandon tile + block it
                # Willing to abandon VP tiles if they're about to be lost
                tile_result = self._pick_tile_to_abandon(game, player, weights, allow_vp=True)
                if tile_result:
                    score += 4.0 + tile_result[0]
                    action_dict["target_q"] = tile_result[1]
                    action_dict["target_r"] = tile_result[2]
                else:
                    return None  # no valid tiles to abandon

            elif effect.type == EffectType.GLOBAL_CLAIM_BAN:
                # Snowy Holiday: no claims next round for anyone
                if game.grid:
                    my_tiles = len(game.grid.get_player_tiles(self.player_id))
                    # Good when behind or defensive; bad when ahead and expanding
                    max_tiles = max(
                        len(game.grid.get_player_tiles(pid))
                        for pid in game.players if pid != self.player_id
                    ) if len(game.players) > 1 else 0
                    if my_tiles <= max_tiles:
                        score += 5.0 * weights.defense  # defensive play — slow opponents
                    else:
                        score += 1.0  # ahead — slows us too

        # Cost reduction
        for effect in card.effects:
            if effect.type == EffectType.COST_REDUCTION:
                score += abs(effect.value) * 1.5 * weights.resource_value

        # Buy restriction (War Council) — penalize if we have resources to spend
        for effect in card.effects:
            if effect.type == EffectType.BUY_RESTRICTION:
                if player.resources >= 3:
                    score -= 3.0  # significant penalty — we'll miss buying
                else:
                    score += 1.0  # no resources anyway, free draw is great

        # Trash for buy cost (Consolidate) — value based on trashable cards
        for effect in card.effects:
            if effect.type == EffectType.TRASH_GAIN_BUY_COST:
                # Score based on having cards worth trashing for resources
                best_trash_value = 0
                for j, c in enumerate(player.hand):
                    if c.buy_cost is not None and c.starter:
                        best_trash_value = max(best_trash_value, c.buy_cost)
                    elif c.buy_cost is not None and c.buy_cost <= 2:
                        best_trash_value = max(best_trash_value, c.buy_cost)
                if best_trash_value > 0:
                    score += best_trash_value * 1.0 * weights.resource_value + 2.0  # deck thinning bonus
                else:
                    score -= 1.0  # nothing good to trash

        # Granting actions to opponents (Forced March) — penalty
        for effect in card.effects:
            if effect.type == EffectType.GRANT_ACTIONS_NEXT_TURN:
                num_opponents = len(game.players) - 1
                penalty = effect.effective_value(card.is_upgraded) * num_opponents * 0.8
                score -= penalty

        # Cards requiring self-discard/trash — lower priority unless deck thinning is valuable
        for effect in card.effects:
            if effect.type in (EffectType.SELF_DISCARD, EffectType.SELF_TRASH):
                # Still play these, but they cost us cards
                score -= 1.0

        # Forced discard on opponents
        if card.forced_discard > 0:
            score += card.forced_discard * 2.0

        if score <= 0:
            score = 0.5  # always slightly positive — engine cards are playable

        # Engine cards that need targets (e.g. Sabotage — pick opponent tile for visual)
        if card.forced_discard > 0:
            target_pid = self._pick_forced_discard_target(game, player)
            if target_pid and game.grid:
                action_dict["target_player_id"] = target_pid
                # Pick any tile owned by target for visual targeting
                target_tiles = game.grid.get_player_tiles(target_pid)
                if target_tiles:
                    # Prefer base tile if available
                    base = next((t for t in target_tiles if t.is_base), target_tiles[0])
                    action_dict["target_q"] = base.q
                    action_dict["target_r"] = base.r

        # Handle Diplomacy/Diplomat target selection
        for effect in card.effects:
            if effect.type == EffectType.GRANT_LAND_GRANTS and effect.target == "chosen_player":
                # Fortress Diplomacy: pick the opponent with the lowest VP (help least threatening)
                target_pid = self._pick_diplomacy_target(game, player)
                if target_pid:
                    action_dict["target_player_id"] = target_pid

        # Handle self-discard/trash choices (including Consolidate trash-for-value)
        discard_indices: Optional[list[int]] = None
        trash_indices: Optional[list[int]] = None
        for effect in card.effects:
            if effect.type == EffectType.SELF_DISCARD and effect.requires_choice:
                discard_indices = self._pick_cards_to_discard(player, effect.value)
                action_dict["discard_card_indices"] = discard_indices
            if effect.type == EffectType.SELF_TRASH and effect.requires_choice:
                trash_indices = self._pick_cards_to_trash(player, effect.value, card_index)
                action_dict["trash_card_indices"] = trash_indices
            if effect.type == EffectType.TRASH_GAIN_BUY_COST and effect.requires_choice:
                trash_indices = self._pick_cards_to_trash_for_value(player, effect.value, card_index)
                action_dict["trash_card_indices"] = trash_indices
        return (score, action_dict)

    def _pick_forced_discard_target(self, game: Any, player: Any) -> Optional[str]:
        """Pick the opponent to target with forced discard (highest VP)."""
        best_pid = None
        best_vp = -1
        for pid, p in game.players.items():
            if pid == self.player_id:
                continue
            if p.vp > best_vp:
                best_vp = p.vp
                best_pid = pid
        return best_pid

    def _pick_cards_to_discard(self, player: Any, count: int) -> list[int]:
        """Pick the worst cards in hand to discard."""
        # Score each card — lower score = discard first
        scored = []
        for i, card in enumerate(player.hand):
            score = 0.0
            # Debt and Rubble are always worst — discard first
            if card.name in ("Debt", "Rubble"):
                score = -10.0
            elif card.card_type == CardType.CLAIM:
                score = card.effective_power + 2.0
            elif card.card_type == CardType.DEFENSE:
                score = card.effective_defense_bonus + 1.0
            elif card.card_type == CardType.ENGINE:
                score = card.effective_resource_gain + card.effective_draw_cards + 1.0
            if card.starter:
                score -= 2.0  # prefer discarding starters
            scored.append((score, i))

        scored.sort(key=lambda x: x[0])
        return [idx for _, idx in scored[:count]]

    def _pick_diplomacy_target(self, game: Any, player: Any) -> Optional[str]:
        """Pick the opponent to target with Diplomacy (lowest VP — least threatening)."""
        best_pid = None
        best_vp = float("inf")
        for pid, p in game.players.items():
            if pid == self.player_id:
                continue
            if p.vp < best_vp:
                best_vp = p.vp
                best_pid = pid
        return best_pid

    # Minimum number of claim cards the CPU wants to keep in the active deck
    # before it will consider trashing Explore cards. Below this floor, Gather
    # is trashed instead (or nothing) so the CPU still has a way to take tiles.
    _MIN_CLAIMS_TO_KEEP_EXPLORE = 4

    def _pick_cards_to_trash_for_value(self, player: Any, count: int,
                                       exclude_index: int) -> list[int]:
        """Pick cards to trash for resource value (Consolidate). Prefer
        starters and cheap cards. Explore is preferred over Gather as long as
        trashing it would leave at least _MIN_CLAIMS_TO_KEEP_EXPLORE claim
        cards in the deck. Debt and Rubble are always top priority."""
        total_claims = sum(
            1 for c in _iter_all_player_cards(player)
            if c.card_type == CardType.CLAIM
        )
        scored = []
        for i, card in enumerate(player.hand):
            if i == exclude_index:
                continue
            if card.buy_cost is None:
                continue  # can't gain resources from cards with no buy cost
            # Prefer trashing: Debt/Rubble > Explore > Gather > starters > cheap > expensive.
            score = 0.0
            is_explore = card.starter and card.name == "Explore"
            is_gather = card.starter and card.name == "Gather"
            if card.name == "Debt":
                score += 20.0  # always trash Debt first — dead weight with -3 resources
            elif card.name == "Rubble":
                score += 18.0  # always trash Rubble — pure dead weight
            elif is_explore:
                # Only favor trashing Explore while we have a claim surplus.
                if total_claims - 1 >= self._MIN_CLAIMS_TO_KEEP_EXPLORE:
                    score += 7.0 + (card.buy_cost or 0)
                else:
                    score += 1.0  # keep Explore — we need the claim pressure
            elif is_gather:
                score += 5.5 + (card.buy_cost or 0)  # still a fine trash target
            elif card.starter:
                score += 5.0 + (card.buy_cost or 0)
            elif card.unplayable and card.passive_vp <= 0:
                score += 4.0 + (card.buy_cost or 0)  # dead weight
            else:
                score += (card.buy_cost or 0) * 0.3  # low priority for good cards
            scored.append((score, i))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [idx for _, idx in scored[:count]]

    def _pick_cards_to_trash(self, player: Any, count: int,
                             exclude_index: int) -> list[int]:
        """Pick the worst cards in hand to trash (permanent removal).

        Debt and Rubble are always top priority for trashing. Then prefers
        Explore over Gather so the CPU thins its starter claim cards first,
        but only as long as the resulting deck still has at least
        _MIN_CLAIMS_TO_KEEP_EXPLORE claim cards — below that floor Gather
        (which is not a claim) is preferred instead."""
        total_claims = sum(
            1 for c in _iter_all_player_cards(player)
            if c.card_type == CardType.CLAIM
        )
        scored = []
        for i, card in enumerate(player.hand):
            if i == exclude_index:
                continue
            score = 0.0
            if card.name == "Debt":
                score -= 10.0  # always trash Debt first
            elif card.name == "Rubble":
                score -= 8.0  # always trash Rubble
            else:
                is_explore = card.starter and card.name == "Explore"
                is_gather = card.starter and card.name == "Gather"
                if is_explore:
                    if total_claims - 1 >= self._MIN_CLAIMS_TO_KEEP_EXPLORE:
                        score -= 5.0  # strongly prefer trashing Explore
                    else:
                        score += 1.0  # keep Explore to maintain claim pressure
                elif is_gather:
                    score -= 3.5  # gather is the next best starter to trash
                elif card.starter:
                    score -= 3.0  # any other starter
                if card.buy_cost is not None:
                    score += card.buy_cost * 0.5  # expensive cards less trashable
                else:
                    score -= 1.0  # cards with no buy cost are fine to trash
            scored.append((score, i))

        scored.sort(key=lambda x: x[0])
        return [idx for _, idx in scored[:count]]

    def _pick_tile_to_abandon(self, game: Any, player: Any,
                              weights: StrategyWeights,
                              allow_vp: bool = False) -> Optional[tuple[float, int, int]]:
        """Pick the best owned non-base tile to abandon.

        Returns (score_bonus, q, r) or None if no valid tile exists.
        Higher score_bonus = better tile to abandon (i.e. less valuable to us).
        """
        if not game.grid:
            return None

        player_tiles = game.grid.get_player_tiles(self.player_id)
        candidates: list[tuple[float, int, int]] = []

        for tile in player_tiles:
            if tile.is_base:
                continue  # never abandon base tiles
            if tile.is_vp and not allow_vp:
                continue  # don't abandon VP tiles unless explicitly allowed

            # Score: lower value tiles are better abandon candidates
            abandon_score = 0.0
            adj_tiles = game.grid.get_adjacent(tile.q, tile.r)
            owned_neighbors = sum(1 for adj in adj_tiles if adj.owner == self.player_id)
            enemy_neighbors = sum(
                1 for adj in adj_tiles
                if adj.owner is not None and adj.owner != self.player_id
            )

            # Frontier tiles (many enemy neighbors, few friendly) are good abandon targets
            abandon_score += enemy_neighbors * 1.0
            abandon_score -= owned_neighbors * 0.5

            # VP tiles are bad to abandon (penalize)
            if tile.is_vp:
                # Only reach here if allow_vp=True (Scorched Retreat)
                # Worth it if tile is heavily threatened
                if enemy_neighbors >= 2:
                    abandon_score += 2.0  # about to lose it anyway — deny it
                else:
                    abandon_score -= 3.0  # don't abandon safe VP tiles

            # Disconnected tiles (no owned neighbors) are easy to abandon
            if owned_neighbors == 0:
                abandon_score += 2.0

            candidates.append((abandon_score, tile.q, tile.r))

        if not candidates:
            return None

        # Pick the best candidate (highest abandon score)
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0]

    # ── Buy Phase ─────────────────────────────────────────────────

    def pick_purchases(self, game: Any) -> list[dict[str, Any]]:
        """Decide what to buy during Buy phase.

        Returns list of purchase actions:
            [{"source": "archetype"|"neutral"|"upgrade", "card_id": str|None}, ...]
        """
        player = game.players[self.player_id]
        if player.turn_modifiers.buy_locked:
            return []

        weights = ARCHETYPE_WEIGHTS.get(player.archetype, StrategyWeights())
        weights = _adapt_weights(weights, game, self.player_id)
        purchases: list[dict[str, Any]] = []

        # Keep buying while we have resources and good options
        while player.resources > 0:
            best = self._pick_best_purchase(game, player, weights)
            if best is None:
                break
            purchases.append(best)
            # The simulation driver will call buy_card() which mutates state,
            # so return one at a time for the driver to loop.
            return purchases

        return purchases

    def pick_next_purchase(self, game: Any) -> Optional[dict[str, Any]]:
        """Pick the single best purchase to make. Returns None if done buying."""
        player = game.players[self.player_id]
        if player.turn_modifiers.buy_locked or player.resources <= 0:
            return None

        weights = ARCHETYPE_WEIGHTS.get(player.archetype, StrategyWeights())
        weights = _adapt_weights(weights, game, self.player_id)
        return self._pick_best_purchase(game, player, weights)

    def _pick_best_purchase(self, game: Any, player: Any,
                            weights: StrategyWeights) -> Optional[dict[str, Any]]:
        """Score all available purchases and pick one."""
        from .game_state import calculate_dynamic_buy_cost, UPGRADE_CREDIT_COST, player_owns_card_by_name

        scored: list[tuple[float, dict[str, Any]]] = []
        # Compute deck composition once so per-card scoring can apply
        # rebalancing multipliers (keep claims >= ~10% high-power, resource
        # gain >= ~33% of deck).
        composition = _deck_composition(player)

        # Score archetype market cards
        for card in player.archetype_market:
            # Skip Unique cards the player already owns — buy_card() would reject them.
            if card.unique and player_owns_card_by_name(player, card.name):
                continue
            cost = calculate_dynamic_buy_cost(game, player, card)
            if cost > player.resources:
                continue
            score = self._score_card_for_purchase(card, player, weights, cost, game, composition)
            scored.append((score, {"source": "archetype", "card_id": card.id}))

        # Score neutral market cards (limit 1 copy per card per round)
        already_bought_neutral = {
            p["card_id"] for p in game.buy_phase_purchases.get(self.player_id, [])
            if p["source"] == "neutral"
        }
        for base_id, copies in game.neutral_market.stacks.items():
            if not copies:
                continue
            if base_id in already_bought_neutral:
                continue
            card_obj = copies[0]
            if card_obj.unique and player_owns_card_by_name(player, card_obj.name):
                continue
            cost = calculate_dynamic_buy_cost(game, player, card_obj)
            if cost > player.resources:
                continue
            score = self._score_card_for_purchase(card_obj, player, weights, cost, game, composition)
            scored.append((score, {"source": "neutral", "card_id": base_id}))

        # Score upgrade credits
        if player.resources >= UPGRADE_CREDIT_COST:
            # Value upgrade credits based on having good upgrade targets
            upgrade_score = 3.0
            scored.append((upgrade_score, {"source": "upgrade", "card_id": None}))

        return self._pick(scored)

    def _score_card_for_purchase(self, card: Card, player: Any,
                                 weights: StrategyWeights,
                                 cost: int, game: Any = None,
                                 composition: Optional[dict[str, float]] = None) -> float:
        """Score a card for purchase.

        Tempo-sensitive: early game favors cheap cards and deck thinning,
        late game favors high-power finishers and VP effects.

        If *composition* is provided, under-represented archetypes get a
        multiplier boost: decks with less than ~10% high-power claims favor
        high-power claim purchases, and decks with less than ~33% resource
        gain cards favor resource-gain engine purchases.
        """
        score = 0.0
        progress = _game_progress(game) if game else 0.5

        # Base value by card type
        if card.card_type == CardType.CLAIM:
            base_power = card.effective_power
            # Account for tile-scaling power (Mob Rule, Locust Swarm)
            for effect in card.effects:
                if effect.type == EffectType.POWER_PER_TILES_OWNED and game and game.grid:
                    divisor = effect.effective_value(card.is_upgraded)
                    if divisor <= 0:
                        divisor = 3
                    tile_count = len(game.grid.get_player_tiles(self.player_id))
                    tile_bonus = tile_count // divisor
                    if effect.metadata.get("replaces_base_power"):
                        base_power = tile_bonus
                    else:
                        base_power += tile_bonus
                elif effect.type == EffectType.POWER_MODIFIER:
                    # Assume conditional power fires ~50% of the time
                    base_power += effect.effective_value(card.is_upgraded) * 0.5
            # Limited-use claims (Road Builder's adjacency-bridge constraint)
            # are rarely playable on any given turn, so their printed power
            # overstates their real contribution. Treat them as low-power for
            # scoring purposes.
            effective_base_power = 1.0 if _is_limited_use_claim(card) else base_power
            score += effective_base_power * 1.5
            if card.archetype == player.archetype:
                score += 3.0  # synergy bonus
            score *= weights.aggression if effective_base_power >= 3 else weights.expansion
        elif card.card_type == CardType.DEFENSE:
            defense_val = card.effective_defense_bonus
            # Account for dynamic defense (Nest)
            for effect in card.effects:
                if effect.type == EffectType.DEFENSE_PER_ADJACENT:
                    defense_val += 2  # estimate ~2 adjacent owned tiles on average
            score += defense_val * 2.0 * weights.defense
            # Tile immunity cards are premium
            for effect in card.effects:
                if effect.type == EffectType.TILE_IMMUNITY:
                    score += effect.duration * 3.0 * weights.defense
            # Permanent defense is extra valuable
            for effect in card.effects:
                if effect.type == EffectType.PERMANENT_DEFENSE:
                    score += effect.effective_value(card.is_upgraded) * 2.0 * weights.defense
            # Ignore defense override
            for effect in card.effects:
                if effect.type == EffectType.IGNORE_DEFENSE_OVERRIDE:
                    score += 3.0 * weights.defense
        elif card.card_type == CardType.ENGINE:
            score += card.effective_resource_gain * 1.5 * weights.resource_value
            score += card.effective_draw_cards * 2.0 * weights.card_draw_value
            # Trash-for-value (Consolidate) — deck thinning + resources
            for effect in card.effects:
                if effect.type == EffectType.TRASH_GAIN_BUY_COST:
                    score += 3.0  # deck thinning is always valuable
            # Buy restriction penalty
            for effect in card.effects:
                if effect.type == EffectType.BUY_RESTRICTION:
                    score -= 1.5  # trade-off for the draw

            # ── New engine effect purchase scoring ──
            for effect in card.effects:
                if effect.type == EffectType.CONDITIONAL_ACTION:
                    score += 2.0  # conditional free action
                elif effect.type == EffectType.RESOURCE_SCALING:
                    score += 2.0 * weights.resource_value  # scales with economy
                elif effect.type == EffectType.CYCLE:
                    score += 2.5 * weights.card_draw_value  # hand quality
                elif effect.type == EffectType.RESOURCE_PER_VP_HEX:
                    score += 2.5 * weights.resource_value  # scales with VP hexes
                elif effect.type == EffectType.RESOURCES_PER_TILES_LOST:
                    score += 1.5  # situational
                elif effect.type == EffectType.ACTIONS_PER_CARDS_PLAYED:
                    score += 3.0  # combo potential
                elif effect.type == EffectType.NEXT_TURN_BONUS:
                    score += 2.5  # investment card
                elif effect.type == EffectType.MULLIGAN:
                    score += 2.0 * weights.defense  # hand quality, Fortress likes it
                elif effect.type == EffectType.SWAP_DRAW_DISCARD:
                    score += 2.0 * weights.card_draw_value  # deck cycling, Swarm likes it
                elif effect.type == EffectType.GLOBAL_RANDOM_TRASH:
                    score += 2.5  # disruption
                elif effect.type == EffectType.INJECT_RUBBLE:
                    score += 2.5 * weights.aggression  # disruption, Swarm likes it
                elif effect.type == EffectType.GLOBAL_CLAIM_BAN:
                    score += 3.0 * weights.defense  # high defense value, Fortress
                elif effect.type == EffectType.ABANDON_TILE:
                    score += 1.0  # niche
                elif effect.type == EffectType.ABANDON_AND_BLOCK:
                    score += 1.5  # niche but denial is good
                elif effect.type == EffectType.MANDATORY_SELF_TRASH:
                    score += 3.0  # high power ceiling, conditional

        # VP-tile awareness: boost claim cards whose power could capture
        # adjacent VP hexes (especially enemy-owned ones).
        if card.card_type == CardType.CLAIM and game and game.grid:
            base_power = card.effective_power
            # Rough estimate for scaling effects
            for effect in card.effects:
                if effect.type == EffectType.POWER_PER_TILES_OWNED:
                    divisor = effect.effective_value(card.is_upgraded) or 3
                    base_power += len(game.grid.get_player_tiles(self.player_id)) // divisor
                elif effect.type == EffectType.POWER_MODIFIER:
                    base_power += effect.effective_value(card.is_upgraded) * 0.5
            player_tiles = game.grid.get_player_tiles(self.player_id)
            has_adjacent_vp = False
            has_adjacent_enemy_vp = False
            for pt in player_tiles:
                for adj in game.grid.get_adjacent(pt.q, pt.r):
                    if adj.is_vp and adj.owner != self.player_id and base_power > adj.defense_power:
                        has_adjacent_vp = True
                        if adj.owner is not None:
                            has_adjacent_enemy_vp = True
            if has_adjacent_enemy_vp:
                score += 8.0 * weights.vp_hex_priority
            elif has_adjacent_vp:
                score += 4.0 * weights.vp_hex_priority

        # Action return bonus
        if card.effective_action_return >= 1:
            score += 2.0

        # Stackable claim cards are very valuable
        if card.stackable:
            score += 2.0

        # Range-breaking cards
        if card.claim_range > 1 or not card.adjacency_required:
            score += 2.0

        # Multi-target claims
        if card.effective_multi_target_count > 0:
            score += card.effective_multi_target_count * 2.5

        # Trash-on-use penalty (one-shot cards)
        if card.trash_on_use:
            score *= 0.7

        # VP gain effects
        for effect in card.effects:
            if effect.type == EffectType.GAIN_VP:
                score += effect.value * 8.0

        # Passive VP (Land Grant) — always valuable
        if card.passive_vp > 0:
            score += card.passive_vp * 8.0

        # VP-related cards are high priority purchases
        for effect in card.effects:
            if effect.type in (EffectType.ENHANCE_VP_TILE, EffectType.GRANT_LAND_GRANTS,
                               EffectType.VP_FROM_CONTESTED_WINS):
                score += 6.0

        # Dynamic VP formula cards (passive VP generators)
        if card.vp_formula:
            score += 5.0

        # Tempo-sensitive adjustments based on game progress
        if cost <= 2:
            # Cheap cards and deck thinning: more valuable early
            score *= 1.0 + 0.5 * (1.0 - progress)  # up to +50% early
        if cost >= 5:
            # Expensive finishers: more valuable late
            score *= 1.0 + 0.4 * progress  # up to +40% late
        # Deck thinning (Cull, Reclaim, Consolidate) is best early
        has_thinning = any(
            e.type in (EffectType.TRASH_GAIN_BUY_COST, EffectType.SELF_TRASH)
            for e in card.effects
        ) or card.name == "Cull"
        if has_thinning:
            score *= 1.0 + 0.6 * (1.0 - progress)  # up to +60% early
        # VP effects get stronger as game progresses
        has_vp_effect = card.passive_vp > 0 or card.vp_formula or any(
            e.type in (EffectType.GAIN_VP, EffectType.ENHANCE_VP_TILE,
                       EffectType.GRANT_LAND_GRANTS, EffectType.VP_FROM_CONTESTED_WINS)
            for e in card.effects
        )
        if has_vp_effect:
            score *= 1.0 + 0.5 * progress  # up to +50% late

        # ── Deck composition rebalancing ────────────────────────────
        if composition is not None and composition["total"] > 0:
            # Keep at least ~10% of the deck as high-power claim cards. When
            # under that floor, strongly favor buying high-power claims.
            is_high_power_claim = (
                card.card_type == CardType.CLAIM
                and card.effective_power >= 3
                and not _is_limited_use_claim(card)
            )
            if is_high_power_claim and composition["high_power_claim_ratio"] < 0.10:
                score *= 1.7
            # Keep at least ~33% of the deck as resource-gain cards. When
            # under that floor, boost resource-gain purchases.
            is_resource_gain = card.effective_resource_gain > 0
            if is_resource_gain and composition["resource_gain_ratio"] < 0.33:
                score *= 1.5

        # Passive-VP feedback loop: once we own at least one passive-VP card
        # (e.g. Land Grant), lean harder into VP-generating purchases — the
        # endgame plan becomes "finish the VP race", not "out-tempo the table".
        if _owns_passive_vp(player):
            has_vp_any = card.passive_vp > 0 or card.vp_formula or any(
                e.type in (EffectType.GAIN_VP, EffectType.ENHANCE_VP_TILE,
                           EffectType.GRANT_LAND_GRANTS,
                           EffectType.VP_FROM_CONTESTED_WINS)
                for e in card.effects
            )
            if has_vp_any:
                score *= 1.25

        # Cost efficiency: penalize expensive cards
        if cost > 0:
            score = score / (cost * 0.5 + 0.5)  # diminishing cost penalty

        # Don't buy cards that are much worse than what's in our deck
        # (simple heuristic: penalize if cost is very low relative to our average)
        if score < 1.0:
            return 0.0  # not worth buying

        return score

    def should_reroll_market(self, game: Any) -> bool:
        """Decide whether to reroll the archetype market."""
        from .game_state import REROLL_COST
        player = game.players[self.player_id]

        if player.resources < REROLL_COST:
            return False

        weights = ARCHETYPE_WEIGHTS.get(player.archetype, StrategyWeights())
        weights = _adapt_weights(weights, game, self.player_id)

        # Score current market offerings
        total_score = 0.0
        affordable_count = 0
        for card in player.archetype_market:
            from .game_state import calculate_dynamic_buy_cost
            cost = calculate_dynamic_buy_cost(game, player, card)
            if cost <= player.resources:
                total_score += self._score_card_for_purchase(card, player, weights, cost, game)
                affordable_count += 1

        # Reroll if nothing affordable or nothing worth buying
        if affordable_count == 0:
            return True
        if total_score < 3.0:
            # With noise, sometimes reroll anyway
            threshold = 3.0 - self.noise * 2.0
            return total_score < threshold

        return False

    # NOTE: Passive draft (pick_passive) was removed — passives are a candidate
    # feature preserved in data/passives.md but not currently in the game.
