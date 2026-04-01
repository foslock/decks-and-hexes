"""Core game state management and turn loop."""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .cards import (
    ACTION_HARD_CAP,
    ARCHETYPE_SLOTS,
    HAND_SIZE,
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
    build_starting_deck,
    _copy_card,
)
from .hex_grid import GridSize, HexGrid, generate_hex_grid


class Phase(str, Enum):
    SETUP = "setup"
    START_OF_TURN = "start_of_turn"
    PLAN = "plan"
    REVEAL = "reveal"
    BUY = "buy"
    END_OF_TURN = "end_of_turn"
    GAME_OVER = "game_over"


STARTING_RESOURCES = 3
UPKEEP_COST = 1
VP_TARGET = 20
REROLL_COST = 2
RETAIN_COST = 1
UPGRADE_CREDIT_COST = 5


@dataclass
class PlannedAction:
    """A card placed face-down during Plan phase."""
    card: Card
    target_q: Optional[int] = None
    target_r: Optional[int] = None
    target_player_id: Optional[str] = None  # for forced discards

    def to_dict(self) -> dict[str, Any]:
        return {
            "card": self.card.to_dict(),
            "target_q": self.target_q,
            "target_r": self.target_r,
            "target_player_id": self.target_player_id,
        }


@dataclass
class Player:
    id: str
    name: str
    archetype: Archetype
    deck: Deck = field(default_factory=Deck)
    hand: list[Card] = field(default_factory=list)
    resources: int = STARTING_RESOURCES
    vp: int = 0
    actions_used: int = 0
    actions_available: int = 0
    planned_actions: list[PlannedAction] = field(default_factory=list)
    archetype_market: list[Card] = field(default_factory=list)
    archetype_deck: list[Card] = field(default_factory=list)  # remaining buyable cards
    upgrade_credits: int = 0
    passive: Optional[dict[str, Any]] = None
    forced_discard_next_turn: int = 0
    has_submitted_plan: bool = False

    @property
    def hand_size(self) -> int:
        return HAND_SIZE[self.archetype]

    @property
    def action_slots(self) -> int:
        return ARCHETYPE_SLOTS[self.archetype]

    def to_dict(self, hide_hand: bool = False) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "archetype": self.archetype.value,
            "hand": [] if hide_hand else [c.to_dict() for c in self.hand],
            "hand_count": len(self.hand),
            "resources": self.resources,
            "vp": self.vp,
            "actions_used": self.actions_used,
            "actions_available": self.actions_available,
            "archetype_market": [c.to_dict() for c in self.archetype_market],
            "upgrade_credits": self.upgrade_credits,
            "passive": self.passive,
            "deck_size": self.deck.total_cards + len(self.hand) + len(self.planned_actions),
            "planned_action_count": len(self.planned_actions),
            "planned_actions": [] if hide_hand else [a.to_dict() for a in self.planned_actions],
            "has_submitted_plan": self.has_submitted_plan,
        }


@dataclass
class NeutralMarket:
    """Shared neutral market with fixed copy counts."""
    stacks: dict[str, list[Card]] = field(default_factory=dict)

    def get_available(self) -> list[dict[str, Any]]:
        result = []
        for card_id, copies in self.stacks.items():
            if copies:
                result.append({
                    "card": copies[0].to_dict(),
                    "remaining": len(copies),
                })
        return result

    def purchase(self, card_id: str) -> Optional[Card]:
        # Match by base card ID (without instance suffix)
        for base_id, copies in self.stacks.items():
            if copies and base_id == card_id:
                return copies.pop(0)
        return None


@dataclass
class LogEntry:
    """A single game log entry with visibility rules."""
    message: str
    round: int
    phase: str
    # Which players can see this entry. Empty list = visible to all.
    visible_to: list[str] = field(default_factory=list)
    actor: Optional[str] = None  # player who caused this action

    def to_dict(self) -> dict[str, Any]:
        return {
            "message": self.message,
            "round": self.round,
            "phase": self.phase,
            "actor": self.actor,
        }


@dataclass
class GameState:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    grid: Optional[HexGrid] = None
    players: dict[str, Player] = field(default_factory=dict)
    player_order: list[str] = field(default_factory=list)
    current_phase: Phase = Phase.SETUP
    current_round: int = 0
    first_player_index: int = 0
    neutral_market: NeutralMarket = field(default_factory=NeutralMarket)
    winner: Optional[str] = None
    rng: random.Random = field(default_factory=random.Random)
    card_registry: dict[str, Card] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)
    game_log: list[LogEntry] = field(default_factory=list)

    def _log(self, msg: str, visible_to: Optional[list[str]] = None,
             actor: Optional[str] = None) -> None:
        self.log.append(msg)
        self.game_log.append(LogEntry(
            message=msg,
            round=self.current_round,
            phase=self.current_phase.value,
            visible_to=visible_to or [],
            actor=actor,
        ))

    def get_log_for_player(self, player_id: str) -> list[dict[str, Any]]:
        """Return log entries visible to a specific player."""
        return [
            entry.to_dict()
            for entry in self.game_log
            if not entry.visible_to or player_id in entry.visible_to
        ]

    def get_full_log(self) -> list[dict[str, Any]]:
        """Return all log entries (for spectators or hot-seat)."""
        return [entry.to_dict() for entry in self.game_log]

    def to_dict(self, for_player_id: Optional[str] = None) -> dict[str, Any]:
        return {
            "id": self.id,
            "grid": self.grid.to_dict() if self.grid else None,
            "players": {
                pid: p.to_dict(hide_hand=(for_player_id is not None and pid != for_player_id))
                for pid, p in self.players.items()
            },
            "player_order": self.player_order,
            "current_phase": self.current_phase.value,
            "current_round": self.current_round,
            "first_player_index": self.first_player_index,
            "neutral_market": self.neutral_market.get_available(),
            "winner": self.winner,
            "log": self.log[-20:],  # last 20 for backward compat
        }


def create_game(
    grid_size: GridSize,
    player_configs: list[dict[str, Any]],
    card_registry: dict[str, Card],
    seed: Optional[int] = None,
) -> GameState:
    """Create a new game with the given configuration."""
    rng = random.Random(seed)
    num_players = len(player_configs)

    game = GameState(rng=rng, card_registry=card_registry)
    game.grid = generate_hex_grid(grid_size, num_players, rng)

    # Create players and assign starting positions
    for i, config in enumerate(player_configs):
        player_id = config.get("id", str(uuid.uuid4()))
        archetype = Archetype(config["archetype"])

        player = Player(
            id=player_id,
            name=config.get("name", f"Player {i + 1}"),
            archetype=archetype,
        )

        # Build starting deck
        player.deck = build_starting_deck(archetype, card_registry)
        player.deck.shuffle(rng)

        # Build archetype deck (purchasable cards, excluding starters)
        archetype_cards = [
            c for c in card_registry.values()
            if c.archetype == archetype and not c.starter and c.buy_cost is not None
        ]
        player.archetype_deck = [_copy_card(c, f"market_{j}") for j, c in enumerate(archetype_cards)]
        rng.shuffle(player.archetype_deck)

        game.players[player_id] = player
        game.player_order.append(player_id)

        # Assign starting tiles
        if i < len(game.grid.starting_positions):
            cluster = game.grid.starting_positions[i]
            for q, r in cluster:
                tile = game.grid.get_tile(q, r)
                if tile:
                    tile.owner = player_id
                    tile.held_since_turn = 0

    # Random first player
    game.first_player_index = rng.randint(0, num_players - 1)

    # Set up neutral market
    _setup_neutral_market(game, card_registry)

    game._log(f"Game created with {num_players} players on {grid_size.value} grid")
    game.current_phase = Phase.START_OF_TURN
    game.current_round = 1

    return game


def _setup_neutral_market(game: GameState, card_registry: dict[str, Card]) -> None:
    """Set up the shared neutral market stacks."""
    neutral_cards = [
        c for c in card_registry.values()
        if c.archetype == Archetype.NEUTRAL and not c.starter and c.buy_cost is not None
    ]

    for card in neutral_cards:
        copies_count = card.copies or 6  # default 6 copies
        copies = [_copy_card(card, f"neutral_{i}") for i in range(copies_count)]
        game.neutral_market.stacks[card.id] = copies


# ── Phase execution ─────────────────────────────────────────────


def execute_start_of_turn(game: GameState) -> GameState:
    """Phase 1: Start of Turn."""
    game.current_phase = Phase.START_OF_TURN
    game._log(f"=== Round {game.current_round}, Start of Turn ===")

    for pid in game.player_order:
        player = game.players[pid]

        # Pay upkeep (skip round 1)
        if game.current_round > 1:
            player.resources = max(0, player.resources - UPKEEP_COST)
            game._log(f"{player.name} pays {UPKEEP_COST} upkeep ({player.resources} remaining)")

        # Score VP for hexes held since last turn
        if game.current_round > 1 and game.grid is not None:
            vp_scored = 0
            for tile in game.grid.tiles.values():
                if (tile.owner == pid and tile.is_vp
                        and tile.held_since_turn is not None
                        and tile.held_since_turn < game.current_round):
                    vp_scored += 1
            if vp_scored > 0:
                player.vp += vp_scored
                game._log(f"{player.name} scores {vp_scored} VP from held tiles (total: {player.vp})")

        # Check win condition
        if player.vp >= VP_TARGET:
            game.winner = pid
            game.current_phase = Phase.GAME_OVER
            game._log(f"{player.name} wins with {player.vp} VP!")
            return game

        # Draw hand (minus forced discards from last turn)
        draw_count = max(0, player.hand_size - player.forced_discard_next_turn)
        if player.forced_discard_next_turn > 0:
            game._log(f"{player.name} draws {draw_count} (reduced by {player.forced_discard_next_turn} forced discard)")
        player.forced_discard_next_turn = 0
        player.hand = player.deck.draw(draw_count, game.rng)

        # Reset action tracking
        player.actions_used = 0
        player.actions_available = player.action_slots
        player.planned_actions = []
        player.has_submitted_plan = False

        # Reveal archetype market (3 random cards from archetype deck)
        player.archetype_market = []
        if player.archetype_deck:
            market_draw = min(3, len(player.archetype_deck))
            player.archetype_market = player.archetype_deck[:market_draw]

    game.current_phase = Phase.PLAN
    game._log("Plan phase begins — place cards face-down on tiles")
    return game


def play_card(game: GameState, player_id: str, card_index: int,
              target_q: Optional[int] = None, target_r: Optional[int] = None,
              target_player_id: Optional[str] = None) -> tuple[bool, str]:
    """Play a card from hand during Plan phase. Returns (success, message)."""
    if game.current_phase != Phase.PLAN:
        return False, "Not in Plan phase"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    if player.has_submitted_plan:
        return False, "Plan already submitted"

    if card_index < 0 or card_index >= len(player.hand):
        return False, "Invalid card index"

    card = player.hand[card_index]

    # Check action availability
    net_cost = 1 - card.effective_action_return
    if player.actions_used + 1 > ACTION_HARD_CAP:
        return False, f"Action hard cap ({ACTION_HARD_CAP}) reached"

    if player.actions_used >= player.actions_available and net_cost > 0:
        return False, "No action slots available"

    # Validate target for claim cards
    if card.card_type == CardType.CLAIM and target_q is not None:
        assert game.grid is not None
        _target_r = target_r if target_r is not None else 0
        tile = game.grid.get_tile(target_q, _target_r)
        if not tile:
            return False, "Invalid target tile"
        if tile.is_blocked:
            return False, "Cannot claim blocked tile"

        # Check adjacency requirement
        if card.adjacency_required:
            player_tiles = game.grid.get_player_tiles(player_id)
            if not any(
                (target_q, _target_r) in [(n.q, n.r) for n in game.grid.get_adjacent(pt.q, pt.r)]
                for pt in player_tiles
            ):
                return False, "Must claim a tile adjacent to one you own"

        # Prevent unoccupied_only cards from targeting owned tiles
        if card.unoccupied_only and tile.owner is not None:
            return False, f"{card.name} can only target unoccupied tiles"

        # Prevent claiming neutral tiles with defense higher than card power
        if not tile.owner and tile.defense_power > card.effective_power:
            return False, f"Card power ({card.effective_power}) too low to overcome tile defense ({tile.defense_power})"

        # Check stacking (only one claim per tile unless exception)
        existing_claims = [
            a for a in player.planned_actions
            if a.target_q == target_q and a.target_r == target_r
            and a.card.card_type == CardType.CLAIM
        ]
        if existing_claims and not card.stacking_exception:
            return False, "Already have a claim on this tile (no stacking)"

    # Remove card from hand and create planned action
    player.hand.pop(card_index)
    action = PlannedAction(
        card=card,
        target_q=target_q,
        target_r=target_r,
        target_player_id=target_player_id,
    )
    player.planned_actions.append(action)
    player.actions_used += 1

    # Handle immediate effects (↺ and ↑ return actions)
    if card.effective_action_return > 0:
        player.actions_available = min(
            player.actions_available + card.effective_action_return,
            ACTION_HARD_CAP - player.actions_used + player.actions_available,
        )

    # Immediate resource gain
    if card.timing == Timing.IMMEDIATE and card.effective_resource_gain > 0:
        player.resources += card.effective_resource_gain
        game._log(f"{player.name} gains {card.effective_resource_gain} resources from {card.name}",
                  visible_to=[player_id], actor=player_id)

    # Immediate card draw
    if card.timing == Timing.IMMEDIATE and card.effective_draw_cards > 0:
        drawn = player.deck.draw(card.effective_draw_cards, game.rng)
        player.hand.extend(drawn)
        game._log(f"{player.name} draws {len(drawn)} cards from {card.name}",
                  visible_to=[player_id], actor=player_id)

    game._log(f"{player.name} plays {card.name} (actions: {player.actions_used}/{player.actions_available})",
              visible_to=[player_id], actor=player_id)
    return True, f"Played {card.name}"


def submit_plan(game: GameState, player_id: str) -> tuple[bool, str]:
    """Mark a player as done planning."""
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    player.has_submitted_plan = True
    game._log(f"{player.name} submits plan ({len(player.planned_actions)} actions)",
              actor=player_id)

    # Check if all players have submitted
    if all(p.has_submitted_plan for p in game.players.values()):
        execute_reveal(game)

    return True, "Plan submitted"


def execute_reveal(game: GameState) -> GameState:
    """Phase 3: Reveal & Resolve — flip all cards and resolve claims."""
    game.current_phase = Phase.REVEAL
    game._log("=== Reveal & Resolve ===")

    assert game.grid is not None

    # Collect all claims by tile
    claims_by_tile: dict[str, list[tuple[str, PlannedAction]]] = {}
    other_actions: list[tuple[str, PlannedAction]] = []

    for pid in game.player_order:
        player = game.players[pid]
        for action in player.planned_actions:
            if (action.card.card_type == CardType.CLAIM
                    and action.target_q is not None):
                tile_key = f"{action.target_q},{action.target_r}"
                claims_by_tile.setdefault(tile_key, []).append((pid, action))
            else:
                other_actions.append((pid, action))

    # Resolve claims: highest power wins, ties to defender
    for tile_key, claims in claims_by_tile.items():
        tile = game.grid.tiles.get(tile_key)
        if not tile:
            continue

        # Calculate total power per player for this tile
        power_by_player: dict[str, int] = {}
        for pid, action in claims:
            power_by_player[pid] = power_by_player.get(pid, 0) + action.card.effective_power

        # Add existing defense (owned tile: credited to owner; unowned tile with intrinsic
        # defense: modeled as a neutral blocker that real players must beat)
        current_defense = tile.defense_power
        if tile.owner:
            power_by_player.setdefault(tile.owner, 0)
            power_by_player[tile.owner] += current_defense
        elif current_defense > 0:
            power_by_player["_neutral"] = current_defense

        # Find winner — filter out the neutral pseudo-player first
        max_power = max(power_by_player.values())
        contenders = [pid for pid, pwr in power_by_player.items() if pwr == max_power]
        real_contenders = [pid for pid in contenders if pid != "_neutral"]

        if not real_contenders:
            # All attackers were beaten by intrinsic tile defense
            game._log(f"Tile {tile_key}: intrinsic defense held (def {current_defense})")
            continue

        if len(real_contenders) == 1:
            winner_id = real_contenders[0]
        elif tile.owner in real_contenders:
            winner_id = tile.owner  # defender wins ties
        else:
            # Tie between attackers — nobody wins
            game._log(f"Tile {tile_key}: tie between attackers, no change")
            continue

        if winner_id != tile.owner:
            old_owner = tile.owner
            tile.owner = winner_id
            tile.held_since_turn = game.current_round
            tile.defense_power = tile.base_defense  # reset to intrinsic defense, not 0
            game._log(f"{game.players[winner_id].name} claims tile {tile_key} (power {max_power})")
        else:
            game._log(f"{tile.owner and game.players[tile.owner].name} defends tile {tile_key}")

    # Resolve non-claim actions (on_resolution effects)
    for pid, action in other_actions:
        player = game.players[pid]
        card = action.card

        if card.timing == Timing.ON_RESOLUTION:
            if card.effective_resource_gain > 0:
                player.resources += card.effective_resource_gain
            if card.effective_draw_cards > 0:
                drawn = player.deck.draw(card.effective_draw_cards, game.rng)
                player.hand.extend(drawn)

        # Defense bonus applied to target tile
        if card.card_type == CardType.DEFENSE and action.target_q is not None:
            _action_target_r = action.target_r if action.target_r is not None else 0
            tile = game.grid.get_tile(action.target_q, _action_target_r)
            if tile and tile.owner == pid:
                tile.defense_power += card.effective_defense_bonus
                game._log(f"{player.name} fortifies tile {action.target_q},{action.target_r} (+{card.effective_defense_bonus} defense)")

        # Forced discards
        if card.forced_discard > 0 and action.target_player_id:
            target = game.players.get(action.target_player_id)
            if target:
                target.forced_discard_next_turn += card.forced_discard
                game._log(f"{player.name} forces {target.name} to discard {card.forced_discard} next turn")

        # Trash on use
        if card.trash_on_use:
            game._log(f"{card.name} is trashed after use")
        else:
            player.deck.add_to_discard([card])

    # Discard planned claim cards
    for pid in game.player_order:
        player = game.players[pid]
        for action in player.planned_actions:
            if action.card.card_type == CardType.CLAIM:
                if not action.card.trash_on_use:
                    player.deck.add_to_discard([action.card])

    game.current_phase = Phase.BUY
    game._log("=== Buy Phase ===")
    return game


def buy_card(game: GameState, player_id: str, source: str, card_id: str) -> tuple[bool, str]:
    """Buy a card during Buy phase.

    source: "archetype", "neutral", or "upgrade"
    """
    if game.current_phase != Phase.BUY:
        return False, "Not in Buy phase"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    if source == "upgrade":
        if player.resources < UPGRADE_CREDIT_COST:
            return False, f"Need {UPGRADE_CREDIT_COST} resources for upgrade credit"
        player.resources -= UPGRADE_CREDIT_COST
        player.upgrade_credits += 1
        game._log(f"{player.name} buys upgrade credit ({player.upgrade_credits} total)")
        return True, "Upgrade credit purchased"

    if source == "archetype":
        target = None
        for card in player.archetype_market:
            if card.id == card_id:
                target = card
                break
        if not target:
            return False, "Card not in archetype market"
        if target.buy_cost is not None and player.resources < target.buy_cost:
            return False, f"Need {target.buy_cost} resources"
        if target.buy_cost is not None:
            player.resources -= target.buy_cost
        player.archetype_market.remove(target)
        player.archetype_deck.remove(target)
        player.deck.add_to_discard([target])
        game._log(f"{player.name} buys {target.name} from archetype market")
        return True, f"Bought {target.name}"

    if source == "neutral":
        purchased = game.neutral_market.purchase(card_id)
        if not purchased:
            return False, "Card not available in neutral market"
        if purchased.buy_cost is not None and player.resources < purchased.buy_cost:
            # Put it back
            game.neutral_market.stacks.setdefault(card_id, []).insert(0, purchased)
            return False, f"Need {purchased.buy_cost} resources"
        if purchased.buy_cost is not None:
            player.resources -= purchased.buy_cost
        player.deck.add_to_discard([purchased])
        game._log(f"{player.name} buys {purchased.name} from neutral market")
        return True, f"Bought {purchased.name}"

    return False, "Invalid source"


def reroll_market(game: GameState, player_id: str) -> tuple[bool, str]:
    """Re-roll archetype market for 2 resources (once per turn)."""
    if game.current_phase != Phase.BUY:
        return False, "Not in Buy phase"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    if player.resources < REROLL_COST:
        return False, f"Need {REROLL_COST} resources"

    player.resources -= REROLL_COST

    # Shuffle current market back, draw new 3
    remaining_deck = [c for c in player.archetype_deck if c not in player.archetype_market]
    all_available = remaining_deck + player.archetype_market
    game.rng.shuffle(all_available)
    player.archetype_deck = all_available
    player.archetype_market = all_available[:min(3, len(all_available))]

    game._log(f"{player.name} re-rolls archetype market")
    return True, "Market re-rolled"


def end_buy_phase(game: GameState, player_id: str) -> tuple[bool, str]:
    """Player signals they're done buying."""
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    # For hot-seat, we just mark done. Could track per-player.
    return True, "Done buying"


def execute_end_of_turn(game: GameState) -> GameState:
    """Phase 5: End of Turn."""
    game.current_phase = Phase.END_OF_TURN
    game._log("=== End of Turn ===")

    for pid in game.player_order:
        player = game.players[pid]
        # Discard remaining hand
        player.deck.add_to_discard(player.hand)
        player.hand = []

    # Rotate first player
    game.first_player_index = (game.first_player_index + 1) % len(game.player_order)

    # Advance to next round
    game.current_round += 1
    game._log(f"Round {game.current_round} begins")

    # Start next turn
    return execute_start_of_turn(game)
