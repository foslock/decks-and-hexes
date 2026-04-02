"""CPU player logic for automated game simulation.

Provides heuristic-based decision-making for each game phase.
A `noise` parameter (0.0–1.0) controls randomness: 0.0 = always pick
the highest-scored option, 1.0 = pick uniformly among reasonable options.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Optional

from .cards import Archetype, Card, CardType, Timing
from .effects import EffectType
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
        vp_hex_priority=2.0, card_draw_value=1.0, resource_value=0.8,
    ),
    Archetype.SWARM: StrategyWeights(
        aggression=1.0, expansion=2.0, defense=0.3,
        vp_hex_priority=1.0, card_draw_value=1.5, resource_value=0.8,
    ),
    Archetype.FORTRESS: StrategyWeights(
        aggression=0.5, expansion=0.8, defense=2.5,
        vp_hex_priority=1.5, card_draw_value=1.0, resource_value=1.5,
    ),
}


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

    # ── Plan Phase ────────────────────────────────────────────────

    def plan_actions(self, game: Any) -> list[dict[str, Any]]:
        """Decide which cards to play and in what order during Plan phase.

        Returns a list of action dicts suitable for calling play_card():
            [{"card_index": int, "target_q": int|None, "target_r": int|None,
              "target_player_id": str|None, "discard_card_indices": list|None,
              "trash_card_indices": list|None, "extra_targets": list|None}, ...]
        """
        player = game.players[self.player_id]
        weights = ARCHETYPE_WEIGHTS.get(player.archetype, StrategyWeights())
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
        """Pick the single best card to play next. Returns None if done planning."""
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
                             weights: StrategyWeights) -> list[tuple[float, dict]]:
        """Score all valid target tiles for a claim card."""
        assert game.grid is not None
        results: list[tuple[float, dict]] = []
        player_tiles = game.grid.get_player_tiles(self.player_id)

        if not player_tiles and not card.flood:
            return results

        # Flood cards target own tiles
        if card.target_own_tile:
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
                        if card.unoccupied_only and tile.owner is not None:
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
                if card.unoccupied_only and tile.owner is not None:
                    continue
                if not tile.owner and tile.defense_power > card.effective_power:
                    continue
                candidates.append(tile)

        return candidates

    def _score_tile_for_claim(self, game: Any, player: Any, tile: HexTile,
                              card: Card, weights: StrategyWeights) -> float:
        """Score a tile as a claim target."""
        score = 1.0  # base score for any claim

        # VP hex bonus
        if tile.is_vp:
            score += tile.vp_value * 8.0 * weights.vp_hex_priority

        # Neutral vs enemy tile
        if tile.owner is None:
            score += 3.0 * weights.expansion
        elif tile.owner != self.player_id:
            # Enemy tile — factor in defense
            defense = tile.defense_power
            effective_power = card.effective_power
            if effective_power > defense:
                score += 5.0 * weights.aggression
            elif effective_power == defense:
                score += 1.0 * weights.aggression  # tie goes to defender, risky
            else:
                score -= 2.0  # likely to lose

        # Strategic position: tiles adjacent to VP hexes
        assert game.grid is not None
        adj_tiles = game.grid.get_adjacent(tile.q, tile.r)
        for adj in adj_tiles:
            if adj.is_vp and adj.owner != self.player_id:
                score += 1.5 * weights.vp_hex_priority

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
            power_margin = card.effective_power - tile.defense_power
            score += power_margin * 0.5

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
            if card.unoccupied_only and tile.owner is not None:
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
                               weights: StrategyWeights) -> list[tuple[float, dict]]:
        """Score all valid targets for a defense card."""
        assert game.grid is not None
        results: list[tuple[float, dict]] = []
        player_tiles = game.grid.get_player_tiles(self.player_id)

        # Score each tile for defense priority
        tile_scores: list[tuple[float, Any]] = []
        for tile in player_tiles:
            score = 2.0 * weights.defense  # base defense value

            # VP tiles get much higher defense priority
            if tile.is_vp:
                score += tile.vp_value * 6.0 * weights.vp_hex_priority

            # Tiles with enemy neighbors (frontier tiles) need defense more
            adj_tiles = game.grid.get_adjacent(tile.q, tile.r)
            enemy_neighbors = sum(
                1 for adj in adj_tiles
                if adj.owner is not None and adj.owner != self.player_id
            )
            score += enemy_neighbors * 2.0

            # Tiles with no enemy neighbors don't need defense as much
            if enemy_neighbors == 0:
                score *= 0.3

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

            action_dict: dict = {
                "card_index": card_index,
                "target_q": tile.q, "target_r": tile.r,
            }
            if extra_targets:
                action_dict["extra_targets"] = extra_targets
            results.append((score, action_dict))

        return results

    def _score_engine(self, game: Any, player: Any, card: Card,
                      card_index: int,
                      weights: StrategyWeights) -> Optional[tuple[float, dict]]:
        """Score an engine card."""
        score = 0.0

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

        # VP-generating archetype cards
        for effect in card.effects:
            if effect.type == EffectType.VP_FROM_TILES:
                # Territorial Dominance: estimate VP from current tile count
                if game.grid:
                    tiles = len(game.grid.get_player_tiles(self.player_id))
                    divisor = effect.metadata.get("divisor", 5)
                    if card.is_upgraded:
                        divisor = effect.metadata.get("upgraded_divisor", divisor)
                    estimated_vp = tiles // divisor
                    score += estimated_vp * 10.0

            elif effect.type == EffectType.VP_FROM_TILE_SACRIFICE:
                # Scorched Earth: estimate VP from sacrificeable tiles
                if game.grid:
                    non_vp_tiles = sum(
                        1 for t in game.grid.tiles.values()
                        if t.owner == self.player_id and not t.is_vp
                    )
                    tiles_per_vp = effect.metadata.get("tiles_per_vp", 3)
                    if card.is_upgraded:
                        tiles_per_vp = effect.metadata.get("upgraded_tiles_per_vp", tiles_per_vp)
                    estimated_vp = non_vp_tiles // tiles_per_vp
                    score += estimated_vp * 10.0

            elif effect.type == EffectType.VP_FROM_DEFENSE:
                # Fortified Position: count tiles meeting defense threshold
                if game.grid:
                    min_def = effect.metadata.get("min_defense", 3)
                    if card.is_upgraded:
                        min_def = effect.metadata.get("upgraded_min_defense", min_def)
                    qualifying = sum(
                        1 for t in game.grid.tiles.values()
                        if t.owner == self.player_id and t.defense_power >= min_def
                    )
                    score += qualifying * effect.value * 10.0

            elif effect.type == EffectType.VP_FOR_ALL:
                # Diplomacy: net VP = self_vp - (opponents * their_vp)
                # Play when behind in VP or when 1 VP matters
                self_vp = effect.value
                if card.is_upgraded:
                    self_vp += effect.metadata.get("self_bonus_upgraded", 0)
                num_opponents = len(game.players) - 1
                # Net advantage: we gain self_vp, each opponent gains base_vp
                net = self_vp - (effect.value * num_opponents * 0.5)  # discount opponent VP
                score += max(net, 0.5) * 10.0

            elif effect.type == EffectType.VP_FROM_CONTESTED_WINS:
                # Battle Glory: speculative — play if we have enough claims planned
                claim_count = sum(
                    1 for c in player.hand if c.card_type == CardType.CLAIM
                )
                already_planned = sum(
                    1 for a in player.planned_actions
                    if a.card.card_type == CardType.CLAIM
                )
                required = effect.metadata.get("required_wins", 4)
                if claim_count + already_planned >= required:
                    vp_award = effect.value
                    if card.is_upgraded:
                        vp_award = effect.metadata.get("upgraded_value", vp_award)
                    score += vp_award * 8.0  # slightly less than certain VP
                else:
                    score += 0.5  # unlikely to trigger

            elif effect.type == EffectType.VP_FROM_TRASH_CLAIMS:
                # Sacrifice for Glory: calculate VP from claim cards in hand
                total_power = sum(
                    c.effective_power for c in player.hand
                    if c.card_type == CardType.CLAIM
                )
                divisor = effect.metadata.get("divisor", 3)
                if card.is_upgraded:
                    divisor = effect.metadata.get("upgraded_divisor", divisor)
                estimated_vp = total_power // divisor
                score += estimated_vp * 10.0

        # Cost reduction
        for effect in card.effects:
            if effect.type == EffectType.COST_REDUCTION:
                score += abs(effect.value) * 1.5 * weights.resource_value

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

        action_dict: dict[str, Any] = {"card_index": card_index}

        # Engine cards that need targets
        if card.forced_discard > 0:
            target_pid = self._pick_forced_discard_target(game, player)
            if target_pid:
                action_dict["target_player_id"] = target_pid

        # Handle self-discard/trash choices
        discard_indices = None
        trash_indices = None
        for effect in card.effects:
            if effect.type == EffectType.SELF_DISCARD and effect.requires_choice:
                discard_indices = self._pick_cards_to_discard(player, effect.value)
                action_dict["discard_card_indices"] = discard_indices
            if effect.type == EffectType.SELF_TRASH and effect.requires_choice:
                trash_indices = self._pick_cards_to_trash(player, effect.value, card_index)
                action_dict["trash_card_indices"] = trash_indices
            if effect.type == EffectType.VP_FROM_TRASH_CLAIMS:
                # Sacrifice for Glory: select all claim cards in hand to trash
                claim_indices = [
                    j for j, c in enumerate(player.hand)
                    if c.card_type == CardType.CLAIM and j != card_index
                ]
                action_dict["trash_card_indices"] = claim_indices

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
            if card.card_type == CardType.CLAIM:
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

    def _pick_cards_to_trash(self, player: Any, count: int,
                             exclude_index: int) -> list[int]:
        """Pick the worst cards in hand to trash (permanent removal)."""
        scored = []
        for i, card in enumerate(player.hand):
            if i == exclude_index:
                continue
            score = 0.0
            if card.starter:
                score -= 3.0  # strongly prefer trashing starters
            if card.buy_cost is not None:
                score += card.buy_cost * 0.5  # expensive cards less trashable
            else:
                score -= 1.0  # cards with no buy cost are fine to trash
            scored.append((score, i))

        scored.sort(key=lambda x: x[0])
        return [idx for _, idx in scored[:count]]

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
        return self._pick_best_purchase(game, player, weights)

    def _pick_best_purchase(self, game: Any, player: Any,
                            weights: StrategyWeights) -> Optional[dict[str, Any]]:
        """Score all available purchases and pick one."""
        from .game_state import calculate_dynamic_buy_cost, UPGRADE_CREDIT_COST

        scored: list[tuple[float, dict[str, Any]]] = []

        # Score archetype market cards
        for card in player.archetype_market:
            cost = calculate_dynamic_buy_cost(game, player, card)
            if cost > player.resources:
                continue
            score = self._score_card_for_purchase(card, player, weights, cost)
            scored.append((score, {"source": "archetype", "card_id": card.id}))

        # Score neutral market cards
        for stack_info in game.neutral_market.get_available():
            card_dict = stack_info["card"]
            card_id = card_dict["id"]
            # Find the actual card object
            for base_id, copies in game.neutral_market.stacks.items():
                if copies and copies[0].id == card_id:
                    card_obj = copies[0]
                    cost = calculate_dynamic_buy_cost(game, player, card_obj)
                    if cost > player.resources:
                        break
                    score = self._score_card_for_purchase(card_obj, player, weights, cost)
                    scored.append((score, {"source": "neutral", "card_id": base_id}))
                    break

        # Score upgrade credits
        if player.resources >= UPGRADE_CREDIT_COST:
            # Value upgrade credits based on having good upgrade targets
            upgrade_score = 3.0
            scored.append((upgrade_score, {"source": "upgrade", "card_id": None}))

        return self._pick(scored)

    def _score_card_for_purchase(self, card: Card, player: Any,
                                 weights: StrategyWeights,
                                 cost: int) -> float:
        """Score a card for purchase."""
        score = 0.0

        # Base value by card type
        if card.card_type == CardType.CLAIM:
            score += card.effective_power * 1.5
            if card.archetype == player.archetype:
                score += 3.0  # synergy bonus
            score *= weights.aggression if card.effective_power >= 3 else weights.expansion
        elif card.card_type == CardType.DEFENSE:
            score += card.effective_defense_bonus * 2.0 * weights.defense
        elif card.card_type == CardType.ENGINE:
            score += card.effective_resource_gain * 1.5 * weights.resource_value
            score += card.effective_draw_cards * 2.0 * weights.card_draw_value

        # Action return bonus
        if card.effective_action_return >= 1:
            score += 2.0

        # Stackable claim cards are very valuable
        if card.stackable:
            score += 2.0

        # Range-breaking cards
        if card.claim_range > 1 or not card.adjacency_required:
            score += 2.0

        # VP gain effects
        for effect in card.effects:
            if effect.type == EffectType.GAIN_VP:
                score += effect.value * 8.0

        # Passive VP (Land Grant) — always valuable
        if card.passive_vp > 0:
            score += card.passive_vp * 8.0

        # VP-generating archetype cards
        for effect in card.effects:
            if effect.type in (EffectType.VP_FROM_TILES, EffectType.VP_FROM_TILE_SACRIFICE,
                               EffectType.VP_FROM_DEFENSE, EffectType.VP_FOR_ALL,
                               EffectType.VP_FROM_CONTESTED_WINS, EffectType.VP_FROM_TRASH_CLAIMS):
                score += 6.0  # VP cards are high priority purchases

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

        # Score current market offerings
        total_score = 0.0
        affordable_count = 0
        for card in player.archetype_market:
            from .game_state import calculate_dynamic_buy_cost
            cost = calculate_dynamic_buy_cost(game, player, card)
            if cost <= player.resources:
                total_score += self._score_card_for_purchase(card, player, weights, cost)
                affordable_count += 1

        # Reroll if nothing affordable or nothing worth buying
        if affordable_count == 0:
            return True
        if total_score < 3.0:
            # With noise, sometimes reroll anyway
            threshold = 3.0 - self.noise * 2.0
            return total_score < threshold

        return False

    # ── Passive Draft ─────────────────────────────────────────────

    def pick_passive(self, passives: list[dict[str, Any]],
                     archetype: Archetype) -> Optional[dict[str, Any]]:
        """Pick the best passive from available options."""
        scored: list[tuple[float, dict[str, Any]]] = []

        for passive in passives:
            score = 1.0  # base score

            best_for = passive.get("best_for", ["any"])
            if archetype.value in best_for:
                score += 5.0
            elif "any" in best_for:
                score += 2.0

            # Category-based scoring
            category = passive.get("category", "")
            weights = ARCHETYPE_WEIGHTS.get(archetype, StrategyWeights())

            if category == "territorial":
                score += 2.0 * weights.expansion
            elif category == "deck_hand":
                score += 2.0 * weights.card_draw_value
            elif category == "combat":
                score += 2.0 * weights.aggression
            elif category == "resource":
                score += 2.0 * weights.resource_value
            elif category == "objective_vp":
                score += 3.0  # VP passives are universally good

            scored.append((score, passive))

        return self._pick(scored)
