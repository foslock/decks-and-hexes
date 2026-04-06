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

        return power

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
            effective_power = self._estimate_effective_power(game, player, tile, card)
            if effective_power > defense:
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
            est_power = self._estimate_effective_power(game, player, tile, card)
            power_margin = est_power - tile.defense_power
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
            owned_neighbors = sum(
                1 for adj in adj_tiles if adj.owner == self.player_id
            )
            score += enemy_neighbors * 2.0

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

        action_dict: dict[str, Any] = {"card_index": card_index}

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
        discard_indices = None
        trash_indices = None
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

    def _pick_cards_to_trash_for_value(self, player: Any, count: int,
                                       exclude_index: int) -> list[int]:
        """Pick cards to trash for resource value (Consolidate). Prefer starters and cheap cards."""
        scored = []
        for i, card in enumerate(player.hand):
            if i == exclude_index:
                continue
            if card.buy_cost is None:
                continue  # can't gain resources from cards with no buy cost
            # Prefer trashing: starters > cheap cards > expensive cards
            score = 0.0
            if card.starter:
                score += 5.0 + (card.buy_cost or 0)  # starters are great trash targets
            elif card.unplayable and card.passive_vp <= 0:
                score += 4.0 + (card.buy_cost or 0)  # dead weight like Rubble
            else:
                score += (card.buy_cost or 0) * 0.3  # low priority for good cards
            scored.append((score, i))

        scored.sort(key=lambda x: x[0], reverse=True)
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
        from .game_state import compute_upkeep_cost
        player = game.players[self.player_id]
        if player.turn_modifiers.buy_locked or player.resources <= 0:
            return None

        # Reserve resources for next turn's upkeep
        if game.grid:
            tile_count = len(game.grid.get_player_tiles(self.player_id))
            anticipated_upkeep = compute_upkeep_cost(tile_count, game.grid.size)
            if player.resources <= anticipated_upkeep:
                return None  # save resources for upkeep

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
            score = self._score_card_for_purchase(card, player, weights, cost, game)
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
                    score = self._score_card_for_purchase(card_obj, player, weights, cost, game)
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
                                 cost: int, game: Any = None) -> float:
        """Score a card for purchase."""
        score = 0.0

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
            score += base_power * 1.5
            if card.archetype == player.archetype:
                score += 3.0  # synergy bonus
            score *= weights.aggression if base_power >= 3 else weights.expansion
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
