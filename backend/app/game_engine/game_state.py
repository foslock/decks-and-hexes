"""Core game state management and turn loop."""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .cards import (
    ARCHETYPE_SLOTS,
    HAND_SIZE,
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
    build_starting_deck,
    make_rubble_card,
    make_spoils_card,
    _copy_card,
)
from .effects import ConditionType, EffectType, TurnModifiers
from .effect_resolver import (
    calculate_effective_power,
    resolve_immediate_effects,
    resolve_on_resolution_effects,
)
from .hex_grid import BASE_DEFENSE, GRID_CONFIG, GridSize, HexGrid, generate_hex_grid


class Phase(str, Enum):
    SETUP = "setup"
    START_OF_TURN = "start_of_turn"
    UPKEEP = "upkeep"
    PLAN = "plan"
    REVEAL = "reveal"
    BUY = "buy"
    END_OF_TURN = "end_of_turn"
    GAME_OVER = "game_over"


STARTING_RESOURCES = 3
UPKEEP_FREE_TILES = 4
VP_TARGET = 10  # legacy default; use compute_vp_target() for new games
SPEED_MULTIPLIERS: dict[str, float] = {"fast": 0.66, "normal": 1.0, "slow": 1.33}
REROLL_COST = 2
RETAIN_COST = 1
UPGRADE_CREDIT_COST = 5


def tiles_per_vp(grid_size: GridSize) -> int:
    """Tiles required per 1 VP — scales with grid radius (radius - 1).

    Small (r=4) → 3, Medium (r=5) → 4, Large (r=6) → 5.
    """
    return int(GRID_CONFIG[grid_size]["radius"]) - 1


def compute_vp_target(grid_size: GridSize, player_count: int, speed: str = "normal") -> int:
    """Compute the VP target based on grid size, player count, and game speed."""
    total_tiles: int = int(GRID_CONFIG[grid_size]["tiles"])
    tpv = tiles_per_vp(grid_size)
    divisor = int(tpv * player_count * 0.75)
    if divisor == 0:
        divisor = 1
    base = total_tiles // divisor
    return max(3, round(base * SPEED_MULTIPLIERS.get(speed, 1.25)))


def compute_upkeep_cost(tile_count: int, grid_size: GridSize = GridSize.SMALL) -> int:
    """Compute dynamic upkeep cost based on number of tiles controlled.

    Formula: max(0, (tiles - FREE_TILES) // tiles_per_vp)
    First 4 tiles are free; then 1 resource per tiles_per_vp additional tiles.
    tiles_per_vp scales with grid radius (Small=3, Medium=4, Large=5).
    """
    return max(0, (tile_count - UPKEEP_FREE_TILES) // tiles_per_vp(grid_size))




def _draw_archetype_market(
    deck: list[Card], count: int, rng: random.Random,
) -> list[Card]:
    """Draw up to `count` random purchasable cards from the archetype deck.

    All cards with a buy_cost are eligible regardless of the player's current
    resources — the player may gain resources during the Plan phase before
    buying in the Buy phase.
    """
    eligible = [c for c in deck if c.buy_cost is not None]
    if len(eligible) <= count:
        result = list(eligible)
        rng.shuffle(result)
        return result
    return rng.sample(eligible, count)


@dataclass
class PlannedAction:
    """A card placed face-down during Plan phase."""
    card: Card
    target_q: Optional[int] = None
    target_r: Optional[int] = None
    target_player_id: Optional[str] = None  # for forced discards
    extra_targets: list[tuple[int, int]] = field(default_factory=list)  # Surge multi-targets

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "card": self.card.to_dict(),
            "target_q": self.target_q,
            "target_r": self.target_r,
            "target_player_id": self.target_player_id,
        }
        if self.extra_targets:
            d["extra_targets"] = [[q, r] for q, r in self.extra_targets]
        return d


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
    forced_discard_next_turn: int = 0
    has_submitted_plan: bool = False
    has_ended_turn: bool = False
    neutral_bought_this_turn: bool = False
    turn_modifiers: TurnModifiers = field(default_factory=TurnModifiers)
    trash: list[Card] = field(default_factory=list)
    last_upkeep_paid: int = 0  # resources actually deducted at start of this turn
    upkeep_cost: int = 0  # computed upkeep for this turn (before payment)
    tiles_lost_to_upkeep: int = 0  # tiles forfeited this turn due to unpaid upkeep
    is_cpu: bool = False
    cpu_noise: float = 0.15  # default Medium difficulty

    @property
    def hand_size(self) -> int:
        return HAND_SIZE[self.archetype]

    @property
    def action_slots(self) -> int:
        return ARCHETYPE_SLOTS[self.archetype]

    @property
    def rubble_count(self) -> int:
        """Count Rubble cards across deck, hand, and discard."""
        return sum(
            1 for c in self.deck.cards + self.hand + self.deck.discard
            if c.name == "Rubble"
        )

    def to_dict(self, hide_hand: bool = False, game: Any = None) -> dict[str, Any]:
        # VP is derived — needs game context; falls back to stored vp if no game
        from . import game_state as _gs
        vp = _gs.compute_player_vp(game, self.id) if game else self.vp

        def _card_dict(card: Card) -> dict[str, Any]:
            """Serialize a card, enriching with current_vp when game context exists."""
            d = card.to_dict()
            if game and (card.passive_vp or card.vp_formula):
                if card.vp_formula:
                    d["current_vp"] = _gs._compute_formula_vp(card, self, game)
                else:
                    d["current_vp"] = card.passive_vp
            return d

        return {
            "id": self.id,
            "name": self.name,
            "archetype": self.archetype.value,
            "hand": [] if hide_hand else [_card_dict(c) for c in self.hand],
            "hand_count": len(self.hand),
            "resources": self.resources,
            "vp": vp,
            "actions_used": self.actions_used,
            "actions_available": self.actions_available,
            "archetype_market": [c.to_dict() for c in self.archetype_market],
            "upgrade_credits": self.upgrade_credits,

            "deck_size": len(self.deck.cards),
            "discard_count": len(self.deck.discard),
            "discard": [_card_dict(c) for c in self.deck.discard],
            "deck_cards": [_card_dict(c) for c in self.deck.cards],
            "planned_action_count": len(self.planned_actions),
            "planned_actions": [] if hide_hand else [a.to_dict() for a in self.planned_actions],
            "has_submitted_plan": self.has_submitted_plan,
            "has_ended_turn": self.has_ended_turn,
            "trash": [c.to_dict() for c in self.trash],
            "last_upkeep_paid": self.last_upkeep_paid,
            "upkeep_cost": self.upkeep_cost,
            "tiles_lost_to_upkeep": self.tiles_lost_to_upkeep,
            "rubble_count": self.rubble_count,
            "neutral_bought_this_turn": self.neutral_bought_this_turn,
            "is_cpu": self.is_cpu,
            "cpu_difficulty": (
                "easy" if self.cpu_noise >= 0.25 else
                "medium" if self.cpu_noise >= 0.10 else
                "hard"
            ) if self.is_cpu else None,
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
        # Match by base card ID (without instance suffix).
        # The frontend may pass an instance ID like "card_id_neutral_0",
        # so also try matching when card_id starts with the base ID.
        for base_id, copies in self.stacks.items():
            if copies and (base_id == card_id or card_id.startswith(base_id)):
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
    test_mode: bool = False
    vp_target: int = VP_TARGET

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

    # Structured resolution data for frontend animations (populated by execute_reveal)
    resolution_steps: list[dict[str, Any]] = field(default_factory=list)
    # Player-targeting effects resolved during reveal (e.g. Sabotage forced discards)
    player_effects: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self, for_player_id: Optional[str] = None) -> dict[str, Any]:
        players_dict: dict[str, Any] = {}
        for pid, p in self.players.items():
            pdata = p.to_dict(hide_hand=(for_player_id is not None and pid != for_player_id), game=self)
            # Add effective buy costs for all market cards visible to this player
            effective_costs: dict[str, int] = {}
            for card in p.archetype_market:
                effective_costs[card.id] = calculate_dynamic_buy_cost(self, p, card)
            for stack in self.neutral_market.stacks.values():
                if stack:
                    effective_costs[stack[0].id] = calculate_dynamic_buy_cost(self, p, stack[0])
            pdata["effective_buy_costs"] = effective_costs
            players_dict[pid] = pdata

        result: dict[str, Any] = {
            "id": self.id,
            "grid": self.grid.to_dict() if self.grid else None,
            "players": players_dict,
            "player_order": self.player_order,
            "current_phase": self.current_phase.value,
            "current_round": self.current_round,
            "first_player_index": self.first_player_index,
            "neutral_market": self.neutral_market.get_available(),
            "winner": self.winner,
            "vp_target": self.vp_target,
            "log": self.log[-20:],  # last 20 for backward compat
            "test_mode": self.test_mode,
        }
        if self.resolution_steps:
            result["resolution_steps"] = self.resolution_steps
        if self.player_effects:
            result["player_effects"] = self.player_effects
        return result


def compute_player_vp(game: GameState, player_id: str) -> int:
    """Derive VP from current game state — tiles, connectivity, cards, and bonus VP.

    VP = (total_owned_tiles // tiles_per_vp(game.grid.size))
       + sum(vp_value for connected VP hexes)
       + sum(passive_vp for all cards in deck/hand/discard)
       + sum(dynamic VP from cards with vp_formula)
       + player.vp (bonus VP from card effects, etc.)
    """
    player = game.players[player_id]
    if not game.grid:
        return max(0, player.vp)

    player_tiles = [
        (t.q, t.r) for t in game.grid.tiles.values() if t.owner == player_id
    ]
    tile_vp = len(player_tiles) // tiles_per_vp(game.grid.size)

    # Connected VP hexes add their vp_value as a bonus
    connected = game.grid.get_connected_tiles(player_id)
    vp_hex_bonus = sum(
        game.grid.tiles[f"{q},{r}"].vp_value
        for q, r in player_tiles
        if game.grid.tiles[f"{q},{r}"].is_vp and (q, r) in connected
    )

    # Card VP: Land Grant (+1), Rubble (-1), Battle Glory (accumulated), etc.
    all_cards = player.deck.cards + player.hand + player.deck.discard
    card_vp = sum(c.passive_vp for c in all_cards)

    # Dynamic VP from cards with vp_formula
    formula_vp = 0
    for card in all_cards:
        if not card.vp_formula:
            continue
        formula_vp += _compute_formula_vp(card, player, game)

    # Bonus VP from card effects, etc.
    bonus_vp = player.vp

    return max(0, tile_vp + vp_hex_bonus + card_vp + formula_vp + bonus_vp)


def _compute_formula_vp(card: "Card", player: "Player", game: "GameState") -> int:
    """Compute dynamic VP for a card with a vp_formula."""
    formula = card.vp_formula
    is_upgraded = card.is_upgraded

    if formula == "trash_div_5":
        # Scorched Earth: 1 VP per 5 trashed cards (4 upgraded)
        divisor = 4 if is_upgraded else 5
        return len(player.trash) // divisor

    elif formula == "fortified_tiles_3":
        # Fortified Position: 1 VP per non-base tile with permanent defense >= 3 (>= 2 upgraded)
        if not game.grid:
            return 0
        threshold = 2 if is_upgraded else 3
        return sum(
            1 for t in game.grid.tiles.values()
            if t.owner == player.id and not t.is_base
            and t.permanent_defense_bonus >= threshold
        )

    elif formula == "deck_div_10":
        # Arsenal: 1 VP per 10 cards in deck (8 upgraded)
        all_cards = player.deck.cards + player.hand + player.deck.discard
        divisor = 8 if is_upgraded else 10
        return len(all_cards) // divisor

    return 0


def create_game(
    grid_size: GridSize,
    player_configs: list[dict[str, Any]],
    card_registry: dict[str, Card],
    seed: Optional[int] = None,
    test_mode: bool = False,
    vp_target: Optional[int] = None,
    speed: str = "normal",
) -> GameState:
    """Create a new game with the given configuration."""
    rng = random.Random(seed)
    num_players = len(player_configs)

    game = GameState(rng=rng, card_registry=card_registry, test_mode=test_mode)
    game.grid = generate_hex_grid(grid_size, num_players, rng)

    # Set VP target: explicit override > dynamic computation
    if vp_target is not None:
        game.vp_target = vp_target
    else:
        game.vp_target = compute_vp_target(grid_size, num_players, speed)

    # Create players and assign starting positions
    for i, config in enumerate(player_configs):
        player_id = config.get("id", str(uuid.uuid4()))
        archetype = Archetype(config["archetype"])

        player = Player(
            id=player_id,
            name=config.get("name", f"Player {i + 1}"),
            archetype=archetype,
            is_cpu=bool(config.get("is_cpu", False)),
            cpu_noise=float(config.get("cpu_noise", 0.15)),
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

        # Assign starting tiles — first tile in each cluster is the base
        if i < len(game.grid.starting_positions):
            cluster = game.grid.starting_positions[i]
            for j, (q, r) in enumerate(cluster):
                tile = game.grid.get_tile(q, r)
                if tile:
                    tile.owner = player_id
                    tile.held_since_turn = 0
                    # First tile in the cluster is the base tile
                    if j == 0:
                        tile.is_base = True
                        tile.base_owner = player_id
                        base_def = BASE_DEFENSE.get(archetype.value, 3)
                        tile.base_defense = base_def
                        tile.defense_power = base_def

    # Random first player
    game.first_player_index = rng.randint(0, num_players - 1)

    # Set up neutral market (N*2 copies per card, where N = player count)
    _setup_neutral_market(game, card_registry, num_players)

    game._log(f"Game created with {num_players} players on {grid_size.value} grid")
    game.current_phase = Phase.START_OF_TURN
    game.current_round = 1

    return game


def _setup_neutral_market(
    game: GameState, card_registry: dict[str, Card], num_players: int,
) -> None:
    """Set up the shared neutral market stacks.

    Each neutral card gets N*2 copies where N is the number of players.
    """
    neutral_cards = [
        c for c in card_registry.values()
        if c.archetype == Archetype.NEUTRAL and not c.starter and c.buy_cost is not None
    ]

    copies_count = num_players * 2
    for card in neutral_cards:
        copies = [_copy_card(card, f"neutral_{i}") for i in range(copies_count)]
        game.neutral_market.stacks[card.id] = copies


# ── Phase execution ─────────────────────────────────────────────


def execute_start_of_turn(game: GameState) -> GameState:
    """Phase 1: Start of Turn."""
    game.current_phase = Phase.START_OF_TURN
    game._log(f"=== Round {game.current_round}, Start of Turn ===")

    for pid in game.player_order:
        player = game.players[pid]

        # Reset upkeep tracking (actual payment happens in UPKEEP phase)
        player.last_upkeep_paid = 0
        player.upkeep_cost = 0
        player.tiles_lost_to_upkeep = 0

        # Check win condition (VP is derived from territory + cards)
        current_vp = compute_player_vp(game, pid)
        if current_vp >= game.vp_target:
            game.winner = pid
            game.current_phase = Phase.GAME_OVER
            game._log(f"{player.name} wins with {current_vp} VP!")
            return game

        # Draw hand (minus forced discards, plus extra draws from effects)
        extra_draws = player.turn_modifiers.extra_draws_next_turn
        draw_count = max(0, player.hand_size - player.forced_discard_next_turn + extra_draws)
        if player.forced_discard_next_turn > 0:
            game._log(f"{player.name} draws {draw_count} (reduced by {player.forced_discard_next_turn} forced discard)")
        if extra_draws > 0:
            game._log(f"{player.name} draws {extra_draws} extra card(s) from effects")
        player.forced_discard_next_turn = 0
        player.turn_modifiers.extra_draws_next_turn = 0
        player.hand = player.deck.draw(draw_count, game.rng)

        # Reset turn modifiers (decrement multi-round effects)
        player.turn_modifiers.reset_for_new_turn()

    # Reset all tile defense_power to base + permanent (round-based bonuses expire)
    if game.grid:
        for tile in game.grid.tiles.values():
            if not tile.is_blocked:
                tile.defense_power = tile.base_defense + tile.permanent_defense_bonus

    for pid in game.player_order:
        player = game.players[pid]

        # Reset action tracking
        player.actions_used = 0
        extra_actions = player.turn_modifiers.extra_actions_next_turn
        player.actions_available = player.action_slots + extra_actions
        if extra_actions > 0:
            game._log(f"{player.name} gains {extra_actions} extra action(s) from last turn",
                      visible_to=[pid], actor=pid)
            player.turn_modifiers.extra_actions_next_turn = 0
        player.planned_actions = []
        player.has_submitted_plan = False
        player.has_ended_turn = False
        player.neutral_bought_this_turn = False

        # Reveal archetype market (3 random, or all in test mode)
        player.archetype_market = []
        if player.archetype_deck:
            if game.test_mode:
                player.archetype_market = list(player.archetype_deck)
            else:
                player.archetype_market = _draw_archetype_market(
                    player.archetype_deck, 3, game.rng,
                )

    # Round 1 skips upkeep; round 2+ computes and applies upkeep, then pauses
    # at UPKEEP phase so the frontend can display the banner before advancing to PLAN
    if game.current_round > 1:
        _apply_upkeep(game)
        game.current_phase = Phase.UPKEEP
    else:
        game.current_phase = Phase.PLAN
        game._log("Plan phase begins — place cards face-down on tiles")
    return game


def forfeit_tiles_for_unpaid_upkeep(
    game: GameState, player_id: str, deficit: int
) -> list[Any]:
    """Remove tiles from a player who can't pay upkeep.

    Priority: disconnected tiles first (farthest from base by hex distance),
    then connected tiles by BFS depth (farthest first, tie-break by most recent).
    Base tiles are immune.

    Returns list of forfeited HexTile objects.
    """
    assert game.grid is not None
    player_tiles = game.grid.get_player_tiles(player_id)
    connected_coords = game.grid.get_connected_tiles(player_id)

    # Find base tile for distance calculations
    base_tile = None
    for tile in player_tiles:
        if tile.is_base and tile.base_owner == player_id:
            base_tile = tile
            break
    if not base_tile:
        return []

    forfeited: list[Any] = []

    # 1. Disconnected tiles first (not in connected set, not base)
    disconnected = [
        t for t in player_tiles
        if (t.q, t.r) not in connected_coords and not t.is_base
    ]
    # Sort by hex distance from base, farthest first
    disconnected.sort(key=lambda t: -base_tile.distance_to(t))

    for tile in disconnected:
        if len(forfeited) >= deficit:
            break
        tile.owner = None
        tile.defense_power = tile.base_defense
        tile.permanent_defense_bonus = 0
        tile.held_since_turn = None
        forfeited.append(tile)

    # 2. Connected tiles by BFS depth (farthest first), excluding base
    if len(forfeited) < deficit:
        bfs_tiles = game.grid.get_tiles_by_bfs_depth(player_id)
        for _depth, tile in bfs_tiles:
            if len(forfeited) >= deficit:
                break
            if tile.is_base:
                continue
            tile.owner = None
            tile.defense_power = tile.base_defense
            tile.permanent_defense_bonus = 0
            tile.held_since_turn = None
            forfeited.append(tile)

    return forfeited


def _apply_upkeep(game: GameState) -> None:
    """Internal: compute and apply dynamic upkeep for all players.

    Called during execute_start_of_turn before transitioning to UPKEEP phase.
    Results are stored on player fields so the frontend can display them.
    """
    game._log("=== Upkeep ===")

    for pid in game.player_order:
        player = game.players[pid]
        assert game.grid is not None
        tile_count = len(game.grid.get_player_tiles(pid))
        upkeep = compute_upkeep_cost(tile_count, game.grid.size)
        player.upkeep_cost = upkeep

        if upkeep == 0:
            player.last_upkeep_paid = 0
            player.tiles_lost_to_upkeep = 0
            game._log(f"{player.name} owes no upkeep ({tile_count} tiles)")
            continue

        actual_cost = min(upkeep, player.resources)
        player.resources -= actual_cost
        player.last_upkeep_paid = actual_cost

        deficit = upkeep - actual_cost
        if deficit > 0:
            forfeited = forfeit_tiles_for_unpaid_upkeep(game, pid, deficit)
            player.tiles_lost_to_upkeep = len(forfeited)
            for tile in forfeited:
                game._log(
                    f"{player.name} loses tile ({tile.q},{tile.r}) — unpaid upkeep"
                )
            game._log(
                f"{player.name} paid {actual_cost}/{upkeep} upkeep, "
                f"lost {len(forfeited)} tile(s) ({player.resources} remaining)"
            )
        else:
            player.tiles_lost_to_upkeep = 0
            game._log(
                f"{player.name} pays {actual_cost} upkeep for {tile_count} tiles "
                f"({player.resources} remaining)"
            )


def execute_upkeep(game: GameState) -> GameState:
    """Advance from UPKEEP phase to PLAN phase.

    Upkeep has already been computed and applied during execute_start_of_turn.
    This just transitions the phase so the frontend can move on.
    """
    game.current_phase = Phase.PLAN
    game._log("Plan phase begins — place cards face-down on tiles")
    return game


def play_card(game: GameState, player_id: str, card_index: int,
              target_q: Optional[int] = None, target_r: Optional[int] = None,
              target_player_id: Optional[str] = None,
              discard_card_indices: Optional[list[int]] = None,
              trash_card_indices: Optional[list[int]] = None,
              extra_targets: Optional[list[tuple[int, int]]] = None,
              ) -> tuple[bool, str]:
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

    # Block unplayable cards (e.g. Land Grant — passive VP, takes up a slot)
    if card.unplayable:
        return False, f"{card.name} cannot be played"

    # Check action availability (skip in test mode)
    net_cost = 1 - card.effective_action_return
    if not game.test_mode:
        if player.actions_used >= player.actions_available and net_cost > 0:
            return False, "No action slots available"

    # Validate target for claim cards
    if card.card_type == CardType.CLAIM and target_q is not None:
        assert game.grid is not None
        _target_r = target_r if target_r is not None else 0
        tile = game.grid.get_tile(target_q, _target_r)
        if not tile:
            return False, "Invalid target tile"

        # Flood: must target own tile (the "center" of the flood)
        if card.target_own_tile:
            if tile.owner != player_id:
                return False, f"{card.name} must target a tile you own"
        else:
            if tile.is_blocked:
                return False, "Cannot claim blocked tile"

            # Check range requirement (adjacency_required + claim_range)
            if card.adjacency_required:
                player_tiles = game.grid.get_player_tiles(player_id)
                max_range = card.claim_range  # 1 = adjacent, 2 = two steps, etc.
                if not any(pt.distance_to(tile) <= max_range for pt in player_tiles):
                    if max_range <= 1:
                        return False, "Must claim a tile adjacent to one you own"
                    return False, f"Must claim a tile within {max_range} steps of one you own"

            # Prevent unoccupied_only cards from targeting owned tiles
            if card.effective_unoccupied_only and tile.owner is not None:
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
            if existing_claims and not card.stackable:
                return False, "This card is not Stackable"

    # Validate target for defense cards — must target a tile the player owns
    if card.card_type == CardType.DEFENSE and target_q is not None:
        assert game.grid is not None
        _target_r = target_r if target_r is not None else 0
        tile = game.grid.get_tile(target_q, _target_r)
        if not tile:
            return False, "Invalid target tile"
        if tile.is_blocked:
            return False, "Cannot target blocked tile"
        if tile.owner != player_id:
            return False, "Defense cards must target a tile you own"

    # Validate extra targets for multi-target cards (Surge)
    validated_extra: list[tuple[int, int]] = []
    if card.card_type == CardType.CLAIM and card.effective_multi_target_count > 0 and extra_targets:
        assert game.grid is not None
        max_extra = card.effective_multi_target_count
        player_tiles = game.grid.get_player_tiles(player_id)
        for et_q, et_r in extra_targets[:max_extra]:
            et_tile = game.grid.get_tile(et_q, et_r)
            if not et_tile or et_tile.is_blocked:
                continue
            if card.adjacency_required:
                if not any(pt.distance_to(et_tile) <= card.claim_range for pt in player_tiles):
                    continue
            if card.effective_unoccupied_only and et_tile.owner is not None:
                continue
            validated_extra.append((et_q, et_r))

    # Validate extra targets for multi-tile defense cards (Bulwark, etc.)
    if card.card_type == CardType.DEFENSE and card.effective_defense_target_count > 1 and extra_targets:
        assert game.grid is not None
        max_extra_defense = card.effective_defense_target_count - 1  # primary target is already one
        for et_q, et_r in extra_targets[:max_extra_defense]:
            et_tile = game.grid.get_tile(et_q, et_r)
            if not et_tile or et_tile.is_blocked:
                continue
            if et_tile.owner != player_id:
                continue
            # Don't duplicate primary target
            if et_q == target_q and et_r == target_r:
                continue
            validated_extra.append((et_q, et_r))

    # Validate required trash/discard choices
    # Trashing is always optional — player may decline to trash (but forfeits the bonus).
    # Discarding is required if the player has other cards in hand.
    from .effects import EffectType as _EffectType
    for effect in card.effects:
        if not effect.requires_choice:
            continue
        if effect.type == _EffectType.SELF_DISCARD:
            max_discardable = len(player.hand) - 1
            required = min(effect.effective_value(card.is_upgraded), max_discardable)
            if required > 0 and (not discard_card_indices or len(discard_card_indices) < required):
                return False, f"{card.name} requires discarding {required} card(s)"

    # Remove card from hand and create planned action
    player.hand.pop(card_index)
    has_extra = (
        (card.card_type == CardType.CLAIM and target_q is not None and card.effective_multi_target_count > 0)
        or (card.card_type == CardType.DEFENSE and card.effective_defense_target_count > 1)
    )
    action = PlannedAction(
        card=card,
        target_q=target_q,
        target_r=target_r,
        target_player_id=target_player_id,
        extra_targets=validated_extra if has_extra else [],
    )
    player.planned_actions.append(action)
    player.actions_used += 1

    # Handle immediate effects (↺ and ↑ return actions)
    if card.effective_action_return > 0:
        player.actions_available += card.effective_action_return

    # Immediate resource gain
    if card.timing == Timing.IMMEDIATE and card.effective_resource_gain > 0:
        player.resources += card.effective_resource_gain
        game._log(f"{player.name} gains {card.effective_resource_gain} resources from {card.name}",
                  visible_to=[player_id], actor=player_id)

    # Immediate card draw
    # Check if draw is gated behind a trash choice (e.g. Thin the Herd: "Trash 1. If you did, draw 1.")
    draw_gated = any(
        e.metadata.get("gates_draw") and e.requires_choice
        and e.type in (_EffectType.SELF_TRASH, _EffectType.TRASH_GAIN_BUY_COST)
        for e in card.effects
    )
    should_draw = not draw_gated or bool(trash_card_indices)
    if card.timing == Timing.IMMEDIATE and card.effective_draw_cards > 0 and should_draw:
        drawn = player.deck.draw(card.effective_draw_cards, game.rng)
        player.hand.extend(drawn)
        game._log(f"{player.name} draws {len(drawn)} cards from {card.name}",
                  visible_to=[player_id], actor=player_id)

    # Resolve structured effects (from effects list on card)
    if card.effects:
        resolve_immediate_effects(
            game, player, card, action,
            discard_card_indices=discard_card_indices,
            trash_card_indices=trash_card_indices,
            extra_targets=[(t[0], t[1]) for t in (extra_targets or [])],
        )

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


def _find_closest_owned_tile(
    game: GameState, player_id: str, target_q: int, target_r: int,
) -> tuple[int, int] | None:
    """Find the closest tile owned by player_id to the target tile."""
    assert game.grid is not None
    best: tuple[int, int] | None = None
    best_dist = float("inf")
    for key, tile in game.grid.tiles.items():
        if tile.owner == player_id:
            # Axial distance
            dq = tile.q - target_q
            dr = tile.r - target_r
            dist = (abs(dq) + abs(dq + dr) + abs(dr)) / 2
            if dist < best_dist:
                best_dist = dist
                best = (tile.q, tile.r)
    return best


def execute_reveal(game: GameState) -> GameState:
    """Phase 3: Reveal & Resolve — flip all cards and resolve claims."""
    game.current_phase = Phase.REVEAL
    game.resolution_steps = []
    game.player_effects = []
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

                # Flood: target is an owned tile; expand to all adjacent tiles
                if action.card.flood:
                    _target_r = action.target_r if action.target_r is not None else 0
                    adj_tiles = game.grid.get_adjacent(action.target_q, _target_r)
                    for adj_tile in adj_tiles:
                        if not adj_tile.is_blocked:
                            adj_key = f"{adj_tile.q},{adj_tile.r}"
                            claims_by_tile.setdefault(adj_key, []).append((pid, action))
                    game._log(
                        f"{player.name} floods from {action.target_q},{_target_r} "
                        f"({len([t for t in adj_tiles if not t.is_blocked])} adjacent tiles)",
                        actor=pid)
                else:
                    tile_key = f"{action.target_q},{action.target_r}"
                    claims_by_tile.setdefault(tile_key, []).append((pid, action))

                    # Surge: add extra targets as additional claims on separate tiles
                    for et_q, et_r in action.extra_targets:
                        et_key = f"{et_q},{et_r}"
                        claims_by_tile.setdefault(et_key, []).append((pid, action))
            else:
                other_actions.append((pid, action))

    # Check for tile immunity — remove immune tiles from claims
    for pid in game.player_order:
        player = game.players[pid]
        for tile_key, rounds in player.turn_modifiers.immune_tiles.items():
            if tile_key in claims_by_tile:
                # Remove claims from OTHER players on immune tiles
                claims_by_tile[tile_key] = [
                    (cpid, action) for cpid, action in claims_by_tile[tile_key]
                    if cpid == pid  # only owner's claims survive
                ]
                game._log(f"Tile {tile_key} is immune to claims this round")

    # Check for ignore_defense — collect affected tiles
    ignore_defense_tiles: set[str] = set()
    for pid in game.player_order:
        ignore_defense_tiles.update(game.players[pid].turn_modifiers.ignore_defense_tiles)

    # Track claim results for on_resolution effects
    claim_results: dict[str, dict[str, bool]] = {}  # tile_key -> {pid -> succeeded}

    # Resolve claims: highest power wins, ties to defender
    for tile_key, claims in claims_by_tile.items():
        tile = game.grid.tiles.get(tile_key)
        if not tile:
            continue

        if not claims:
            continue

        # Calculate total power per player for this tile using effect resolver
        power_by_player: dict[str, int] = {}
        for pid, action in claims:
            player = game.players[pid]
            power = calculate_effective_power(game, player, action.card, action)
            power_by_player[pid] = power_by_player.get(pid, 0) + power

        # Add existing defense (owned tile: credited to owner; unowned tile with intrinsic
        # defense: modeled as a neutral blocker that real players must beat)
        # Skip defense if ignore_defense is active for this tile
        if tile_key not in ignore_defense_tiles:
            current_defense = tile.defense_power
        else:
            current_defense = tile.base_defense  # only base, not bonus from defense cards
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
            for pid, _ in claims:
                claim_results.setdefault(tile_key, {})[pid] = False
            # Build resolution step for failed claims
            claimants = []
            for pid, _action in claims:
                src = _find_closest_owned_tile(game, pid, tile.q, tile.r)
                claimants.append({
                    "player_id": pid,
                    "power": power_by_player.get(pid, 0),
                    "source_q": src[0] if src else None,
                    "source_r": src[1] if src else None,
                })
            game.resolution_steps.append({
                "tile_key": tile_key,
                "q": tile.q, "r": tile.r,
                "contested": len(claims) > 1 or tile.owner is not None,
                "claimants": claimants,
                "defender_id": None,
                "defender_power": current_defense,
                "winner_id": None,
                "previous_owner": tile.owner,
                "outcome": "defense_held",
            })
            continue

        if len(real_contenders) == 1:
            winner_id = real_contenders[0]
        elif tile.owner in real_contenders:
            winner_id = tile.owner  # defender wins ties
        else:
            # Tie between attackers — nobody wins
            game._log(f"Tile {tile_key}: tie between attackers, no change")
            for pid, _ in claims:
                claim_results.setdefault(tile_key, {})[pid] = False
            claimants = []
            for pid, _action in claims:
                src = _find_closest_owned_tile(game, pid, tile.q, tile.r)
                claimants.append({
                    "player_id": pid,
                    "power": power_by_player.get(pid, 0),
                    "source_q": src[0] if src else None,
                    "source_r": src[1] if src else None,
                })
            game.resolution_steps.append({
                "tile_key": tile_key,
                "q": tile.q, "r": tile.r,
                "contested": True,
                "claimants": claimants,
                "defender_id": tile.owner,
                "defender_power": power_by_player.get(tile.owner, 0) if tile.owner else 0,
                "winner_id": None,
                "previous_owner": tile.owner,
                "outcome": "tie",
            })
            continue

        # Record results for all claimers
        for pid, _ in claims:
            claim_results.setdefault(tile_key, {})[pid] = (pid == winner_id)

        # Build resolution step data BEFORE mutating tile
        is_contested = len(claims) > 1 or (tile.owner is not None and tile.owner != winner_id)
        claimants = []
        for pid, _action in claims:
            src = _find_closest_owned_tile(game, pid, tile.q, tile.r)
            claimants.append({
                "player_id": pid,
                "power": power_by_player.get(pid, 0),
                "source_q": src[0] if src else None,
                "source_r": src[1] if src else None,
            })
        game.resolution_steps.append({
            "tile_key": tile_key,
            "q": tile.q, "r": tile.r,
            "contested": is_contested,
            "claimants": claimants,
            "defender_id": tile.owner if tile.owner and tile.owner != winner_id else None,
            "defender_power": power_by_player.get(tile.owner, 0) if tile.owner else 0,
            "winner_id": winner_id,
            "previous_owner": tile.owner,
            "outcome": "claimed" if winner_id != tile.owner else "defended",
        })

        if winner_id != tile.owner:
            if tile.is_base:
                # Base raid: generate Rubble cards for defender and Spoils for attacker
                base_owner_id = tile.base_owner or ""
                defender = game.players[base_owner_id]
                attacker = game.players[winner_id]
                attacker_power = power_by_player.get(winner_id, 0)
                total_defense = power_by_player.get(base_owner_id, 0) if base_owner_id in power_by_player else current_defense
                rubble_count = max(0, attacker_power - total_defense)
                if rubble_count > 0:
                    for _ in range(rubble_count):
                        defender.deck.discard.append(make_rubble_card())
                    attacker.deck.discard.append(make_spoils_card())
                    game._log(
                        f"{attacker.name} raids {defender.name}'s base! "
                        f"{rubble_count} Rubble added to {defender.name}'s deck, "
                        f"Spoils added to {attacker.name}'s deck."
                    )
                else:
                    game._log(f"{game.players[winner_id].name} fails to raid {defender.name}'s base")
            else:
                old_owner = tile.owner
                tile.owner = winner_id
                tile.held_since_turn = game.current_round
                tile.defense_power = tile.base_defense  # reset to intrinsic defense, not 0
                tile.permanent_defense_bonus = 0  # Entrench bonuses lost on capture
                game._log(f"{game.players[winner_id].name} claims tile {tile_key} (power {max_power})")
        else:
            game._log(f"{tile.owner and game.players[tile.owner].name} defends tile {tile_key}")

    # Resolve on_resolution effects for claim cards
    for tile_key, claims in claims_by_tile.items():
        tile = game.grid.tiles.get(tile_key)
        for pid, action in claims:
            player = game.players[pid]
            succeeded = claim_results.get(tile_key, {}).get(pid, False)
            defender_id = tile.owner if tile and tile.owner != pid else None
            # Resolve structured effects
            if action.card.effects:
                resolve_on_resolution_effects(
                    game, player, action.card, action,
                    claim_succeeded=succeeded,
                    defender_id=defender_id,
                )

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

        # Defense bonus applied to target tile(s)
        if card.card_type == CardType.DEFENSE and action.target_q is not None:
            _action_target_r = action.target_r if action.target_r is not None else 0
            tile = game.grid.get_tile(action.target_q, _action_target_r)
            if tile and tile.owner == pid:
                tile.defense_power += card.effective_defense_bonus
                game._log(f"{player.name} fortifies tile {action.target_q},{action.target_r} (+{card.effective_defense_bonus} defense)")
            # Apply defense bonus to extra targets (multi-tile defense cards like Bulwark)
            for et_q, et_r in action.extra_targets:
                et_tile = game.grid.get_tile(et_q, et_r)
                if et_tile and et_tile.owner == pid:
                    et_tile.defense_power += card.effective_defense_bonus
                    game._log(f"{player.name} fortifies tile {et_q},{et_r} (+{card.effective_defense_bonus} defense)")

        # Forced discards
        if card.forced_discard > 0 and action.target_player_id:
            target = game.players.get(action.target_player_id)
            if target:
                target.forced_discard_next_turn += card.forced_discard
                game._log(f"{player.name} forces {target.name} to discard {card.forced_discard} next turn")
                game.player_effects.append({
                    "source_player_id": pid,
                    "target_player_id": action.target_player_id,
                    "card_name": card.name,
                    "effect": f"-{card.forced_discard} card{'s' if card.forced_discard > 1 else ''} next turn",
                    "effect_type": "forced_discard",
                    "value": card.forced_discard,
                })

        # Resolve structured on_resolution effects for non-claim cards
        if card.effects:
            resolve_on_resolution_effects(game, player, card, action,
                                          claim_results=claim_results)

        # Trash on use
        if card.trash_on_use:
            player.trash.append(card)
            game._log(f"{card.name} is trashed after use")
        else:
            player.deck.add_to_discard([card])

    # Sort resolution steps by turn order starting from first player.
    # Each step is assigned to the first claimant that appears in turn order
    # (rotated so first_player_index leads), so that player's claims animate first.
    if game.resolution_steps:
        n = len(game.player_order)
        fpi = game.first_player_index % n if n > 0 else 0
        rotated_order = game.player_order[fpi:] + game.player_order[:fpi]
        pid_rank = {pid: i for i, pid in enumerate(rotated_order)}

        def step_sort_key(step: dict[str, Any]) -> tuple[int, int, int]:
            # Primary: rank of the earliest claimant in turn order
            claimant_ids = [c["player_id"] for c in step.get("claimants", [])]
            min_rank = min((pid_rank.get(pid, n) for pid in claimant_ids), default=n)
            # Secondary: uncontested before contested (so a player's clean claims
            # resolve before their fights)
            contested = 1 if step.get("contested") else 0
            # Tertiary: stable sort by tile position for determinism
            return (min_rank, contested, step.get("q", 0) * 1000 + step.get("r", 0))

        game.resolution_steps.sort(key=step_sort_key)

    # Cease Fire check: grant bonus draws if player didn't claim opponent tiles
    for pid in game.player_order:
        player = game.players[pid]
        bonus = player.turn_modifiers.cease_fire_bonus
        if bonus > 0:
            # Check if this player captured any tile that was owned by another player
            claimed_opponent_tile = False
            for tile_key, results in claim_results.items():
                if pid in results and results[pid]:  # player won this claim
                    step = next((s for s in game.resolution_steps
                                 if s["tile_key"] == tile_key), None)
                    if step and step.get("previous_owner") and step["previous_owner"] != pid:
                        claimed_opponent_tile = True
                        break
            if not claimed_opponent_tile:
                player.turn_modifiers.extra_draws_next_turn += bonus
                game._log(f"{player.name} draws {bonus} extra card(s) next turn (Cease Fire)")
            else:
                game._log(f"{player.name}'s Cease Fire bonus forfeited — claimed an opponent tile")

    # Passive cards in hand: check for on_resolution effects (e.g. Battle Glory)
    for pid in game.player_order:
        player = game.players[pid]
        for card in player.hand:
            if not card.unplayable or not card.effects:
                continue
            for effect in card.effects:
                if effect.timing != Timing.ON_RESOLUTION:
                    continue
                # Create a dummy action for the effect context
                dummy_action = PlannedAction(card=card)
                resolve_on_resolution_effects(
                    game, player, card, dummy_action,
                    claim_succeeded=None,
                    defender_id=None,
                    claim_results=claim_results,
                )
                break  # Only trigger once per card

    # Discard planned claim cards (or trash if trash_on_use)
    for pid in game.player_order:
        player = game.players[pid]
        for action in player.planned_actions:
            if action.card.card_type == CardType.CLAIM:
                if action.card.trash_on_use:
                    player.trash.append(action.card)
                else:
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

    if player.has_ended_turn:
        return False, "Already ended turn"

    # Check buy restriction (Blitz Rush)
    if player.turn_modifiers.buy_locked:
        return False, "Cannot purchase cards this round (buy restriction active)"

    free = game.test_mode  # skip resource costs in test mode

    if source == "upgrade":
        if not free and player.resources < UPGRADE_CREDIT_COST:
            return False, f"Need {UPGRADE_CREDIT_COST} resources for upgrade credit"
        if not free:
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
        if not free:
            dynamic_cost = calculate_dynamic_buy_cost(game, player, target)
            effective_cost = _apply_cost_reductions(player, target, base_cost_override=dynamic_cost)
            if effective_cost > 0 and player.resources < effective_cost:
                return False, f"Need {effective_cost} resources"
            if effective_cost > 0:
                player.resources -= effective_cost
        player.archetype_market.remove(target)
        player.archetype_deck.remove(target)
        player.deck.add_to_discard([target])
        game._log(f"{player.name} buys {target.name} from archetype market")
        return True, f"Bought {target.name}"

    if source == "neutral":
        if player.neutral_bought_this_turn and not game.test_mode:
            return False, "Already bought a neutral card this turn (limit 1)"
        purchased = game.neutral_market.purchase(card_id)
        if not purchased:
            return False, "Card not available in neutral market"
        if not free:
            dynamic_cost = calculate_dynamic_buy_cost(game, player, purchased)
            effective_cost = _apply_cost_reductions(player, purchased, base_cost_override=dynamic_cost)
            if effective_cost > 0 and player.resources < effective_cost:
                # Put it back
                game.neutral_market.stacks.setdefault(card_id, []).insert(0, purchased)
                return False, f"Need {effective_cost} resources"
            if effective_cost > 0:
                player.resources -= effective_cost
        player.deck.add_to_discard([purchased])
        player.neutral_bought_this_turn = True
        # Note: passive_vp cards (e.g. Land Grant) contribute to derived VP automatically
        game._log(f"{player.name} buys {purchased.name} from neutral market")
        return True, f"Bought {purchased.name}"

    return False, "Invalid source"


def spend_upgrade_credit(
    game: GameState, player_id: str, card_index: int
) -> tuple[bool, str]:
    """Spend an upgrade credit to permanently upgrade a card in hand.

    Can be done during the Plan phase, multiple times per turn.
    """
    if game.current_phase != Phase.PLAN:
        return False, "Can only upgrade cards during the Plan phase"
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.upgrade_credits <= 0 and not game.test_mode:
        return False, "No upgrade credits available"
    if card_index < 0 or card_index >= len(player.hand):
        return False, "Invalid card index"
    card = player.hand[card_index]
    if card.is_upgraded:
        return False, f"{card.name} is already upgraded"
    # Apply upgrade
    card.is_upgraded = True
    if card.name_upgraded:
        card.name = card.name_upgraded
    if card.upgrade_description:
        card.description = card.upgrade_description
    if not game.test_mode:
        player.upgrade_credits -= 1
    game._log(
        f"{player.name} upgrades {card.name} "
        f"({player.upgrade_credits} credits remaining)"
    )
    return True, f"Upgraded to {card.name}"


def calculate_dynamic_buy_cost(game: GameState, player: Player, card: Card) -> int:
    """Calculate the dynamic buy cost for a card based on its DYNAMIC_BUY_COST effects.

    Returns the adjusted base cost (before turn-based cost reductions).
    """
    base_cost = card.buy_cost if card.buy_cost is not None else 0
    discount = 0

    for effect in card.effects:
        if effect.type != EffectType.DYNAMIC_BUY_COST:
            continue

        if effect.condition == ConditionType.VP_HEXES_CONTROLLED:
            # Elite Vanguard: reduce cost by |value| per VP hex controlled
            if game.grid is not None:
                vp_hex_count = sum(
                    1 for t in game.grid.tiles.values()
                    if t.is_vp and t.owner == player.id
                )
                per_unit = effect.metadata.get("per_unit", False)
                if per_unit:
                    discount += abs(effect.value) * vp_hex_count
                else:
                    discount += abs(effect.value)

        elif effect.condition == ConditionType.TILES_MORE_THAN_DEFENDER:
            # Cheap Shot: reduce cost by 1 if the player controls the most
            # tiles (strictly more than every other player).
            if game.grid is not None:
                player_tile_count = len(game.grid.get_player_tiles(player.id))
                has_most = all(
                    player_tile_count > len(game.grid.get_player_tiles(pid))
                    for pid in game.players
                    if pid != player.id
                )
                if has_most:
                    discount += abs(effect.value)

    return max(0, base_cost - discount)


def _apply_cost_reductions(player: Player, card: Card, base_cost_override: Optional[int] = None) -> int:
    """Apply any active cost reductions to a card purchase. Returns effective cost."""
    base_cost = base_cost_override if base_cost_override is not None else (card.buy_cost if card.buy_cost is not None else 0)
    discount = 0

    reductions_to_remove = []
    for i, reduction in enumerate(player.turn_modifiers.cost_reductions):
        scope = reduction.get("scope", "any_one_card")
        remaining = reduction.get("remaining", 1)

        if remaining <= 0:
            continue

        applies = False
        if scope == "any_one_card":
            applies = True
        elif scope == "next_defense" and card.card_type == CardType.DEFENSE:
            applies = True

        if applies:
            amount = reduction.get("amount", 0)
            if amount == 0:
                # Free (cost becomes 0)
                discount = base_cost
            else:
                discount += amount
            reduction["remaining"] = remaining - 1
            if reduction["remaining"] <= 0:
                reductions_to_remove.append(i)
            break  # Only one reduction per purchase

    # Remove consumed reductions
    for i in sorted(reductions_to_remove, reverse=True):
        player.turn_modifiers.cost_reductions.pop(i)

    return max(0, base_cost - discount)


def reroll_market(game: GameState, player_id: str) -> tuple[bool, str]:
    """Re-roll archetype market for 2 resources (once per turn)."""
    if game.current_phase != Phase.BUY:
        return False, "Not in Buy phase"

    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"

    if player.has_ended_turn:
        return False, "Already ended turn"

    # Use free rerolls first (from Surveyor), otherwise charge resources
    if player.turn_modifiers.free_rerolls > 0:
        player.turn_modifiers.free_rerolls -= 1
    else:
        if player.resources < REROLL_COST:
            return False, f"Need {REROLL_COST} resources"
        player.resources -= REROLL_COST

    # Shuffle current market back, draw affordable 3
    remaining_deck = [c for c in player.archetype_deck if c not in player.archetype_market]
    all_available = remaining_deck + player.archetype_market
    game.rng.shuffle(all_available)
    player.archetype_deck = all_available
    player.archetype_market = _draw_archetype_market(
        all_available, 3, game.rng,
    )

    game._log(f"{player.name} re-rolls archetype market")
    return True, "Market re-rolled"


def end_buy_phase(game: GameState, player_id: str) -> tuple[bool, str]:
    """Player signals they're done buying."""
    if game.current_phase != Phase.BUY:
        return False, "Not in Buy phase"
    player = game.players.get(player_id)
    if not player:
        return False, "Player not found"
    if player.has_ended_turn:
        return False, "Already ended turn"
    player.has_ended_turn = True
    game._log(f"{player.name} ends their turn", actor=player_id)
    if all(p.has_ended_turn for p in game.players.values()):
        execute_end_of_turn(game)
    return True, "Turn ended"


def execute_end_of_turn(game: GameState) -> GameState:
    """Phase 5: End of Turn."""
    game.current_phase = Phase.END_OF_TURN
    game._log("=== End of Turn ===")

    for pid in game.player_order:
        player = game.players[pid]
        # Discard remaining hand
        player.deck.add_to_discard(player.hand)
        player.hand = []

    # Note: turn_modifiers.reset_for_new_turn() is called at START of next turn
    # so that multi-round effects (like Stronghold's 2-round immunity) persist
    # across the end-of-turn boundary.

    # Rotate first player
    game.first_player_index = (game.first_player_index + 1) % len(game.player_order)

    # Advance to next round
    game.current_round += 1
    game._log(f"Round {game.current_round} begins")

    # Start next turn
    return execute_start_of_turn(game)


# ── CPU Auto-Play Helpers ────────────────────────────────────────


def auto_play_cpu_plans(game: GameState) -> None:
    """Auto-play plan phase for all CPU players who haven't submitted."""
    from .cpu_player import CPUPlayer

    for pid in game.player_order:
        player = game.players[pid]
        if not player.is_cpu or player.has_submitted_plan:
            continue

        cpu = CPUPlayer(pid, noise=player.cpu_noise, rng=game.rng)

        # Play cards (same loop pattern as simulation._run_plan_phase)
        for _ in range(20):  # safety limit
            action = cpu.pick_next_action(game)
            if action is None:
                break
            success, _msg = play_card(
                game, pid, action["card_index"],
                target_q=action.get("target_q"),
                target_r=action.get("target_r"),
                target_player_id=action.get("target_player_id"),
                discard_card_indices=action.get("discard_card_indices"),
                trash_card_indices=action.get("trash_card_indices"),
                extra_targets=action.get("extra_targets"),
            )
            if not success:
                break

        submit_plan(game, pid)


def auto_play_cpu_buys(game: GameState) -> None:
    """Auto-play buy phase for all CPU players who haven't ended turn."""
    from .cpu_player import CPUPlayer

    for pid in game.player_order:
        player = game.players[pid]
        if not player.is_cpu or player.has_ended_turn:
            continue

        cpu = CPUPlayer(pid, noise=player.cpu_noise, rng=game.rng)

        # Reroll market if desirable
        if cpu.should_reroll_market(game):
            reroll_market(game, pid)

        # Buy cards
        for _ in range(10):  # safety limit
            purchase = cpu.pick_next_purchase(game)
            if purchase is None:
                break
            success, _msg = buy_card(
                game, pid, purchase["source"], purchase.get("card_id", ""),
            )
            if not success:
                break

        end_buy_phase(game, pid)
