"""Full round-trip serialization of GameState for persistence.

This is SEPARATE from GameState.to_dict() which is frontend-oriented
(per-player visibility, computed fields).  This serializer captures
**complete internal state** so a game can be saved to DB and restored
exactly as it was.

Card references are stored as {base_id, inst_id, is_upgraded} tuples
so that card stat changes from YAML updates are picked up on deserialize.
Generated cards (Rubble, Spoils, Land Grant) are inlined since they
aren't in the registry.
"""

from __future__ import annotations

import json
import random
from typing import Any, Optional

from app.game_engine.cards import (
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
)
from app.game_engine.effects import (
    ConditionType,
    Effect,
    EffectType,
    TurnModifiers,
    parse_effect,
)
from app.game_engine.game_state import (
    GameState,
    LogEntry,
    NeutralMarket,
    Phase,
    PlannedAction,
    Player,
)
from app.game_engine.hex_grid import GridSize, HexGrid, HexTile

# Schema version — bump when the blob format changes.
# deserialize_game() should handle migrations for older versions.
_SCHEMA_VERSION = 1

# Cards that are generated at runtime (not in the card registry).
_GENERATED_CARD_NAMES = frozenset({"Land Grant", "Rubble", "Spoils"})


# ---------------------------------------------------------------------------
# Helpers: extract base_id from an instance id
# ---------------------------------------------------------------------------

def _base_id_from_instance(inst_id: str, card: Card) -> str:
    """Derive the base (registry) card ID from an instance card.

    Instance IDs are formatted as ``{base_id}_{suffix}`` where suffix was
    provided by ``_copy_card``.  For generated cards the entire id *is* the
    base id (e.g. "land_grant_3").
    """
    if card.name in _GENERATED_CARD_NAMES:
        # Generated cards are not in the registry — return inst_id as-is
        return inst_id

    # Registry card IDs are like "neutral_explore", "vanguard_assault", etc.
    # Instance IDs append a suffix: "neutral_explore_start_adv_0"
    # We need to figure out the base_id.  The safest approach is to try
    # progressively shorter prefixes until we find one that matches a known
    # pattern.  But since we don't have access to the registry here, we
    # store the base_id explicitly in the card ref.  The caller must provide
    # it via _serialize_card_ref.
    return inst_id  # fallback — overridden by _serialize_card_ref


def _find_base_id(inst_id: str, registry: dict[str, Card]) -> str:
    """Find the registry base_id for an instance card ID.

    Tries progressively shorter prefixes of the instance ID to find
    a match in the registry.
    """
    # Direct match (the inst_id IS the base_id — unlikely for player cards)
    if inst_id in registry:
        return inst_id

    # Try stripping suffixes from the right, splitting on '_'
    parts = inst_id.split("_")
    for i in range(len(parts) - 1, 0, -1):
        candidate = "_".join(parts[:i])
        if candidate in registry:
            return candidate

    # Fallback: return the full inst_id (for generated cards)
    return inst_id


# ---------------------------------------------------------------------------
# Card serialization
# ---------------------------------------------------------------------------

def _serialize_card_ref(card: Card, registry: dict[str, Card]) -> dict[str, Any]:
    """Serialize a card as a compact reference.

    Registry cards are stored as {base_id, inst_id, is_upgraded}.
    Generated cards are stored with full inline data.
    """
    if card.name in _GENERATED_CARD_NAMES:
        return _serialize_card_inline(card)

    base_id = _find_base_id(card.id, registry)
    ref: dict[str, Any] = {
        "base_id": base_id,
        "inst_id": card.id,
        "is_upgraded": card.is_upgraded,
    }
    # Store passive_vp if it was mutated at runtime (e.g. Battle Glory)
    template = registry.get(base_id)
    if template and card.passive_vp != template.passive_vp:
        ref["passive_vp_override"] = card.passive_vp
    return ref


def _serialize_card_inline(card: Card) -> dict[str, Any]:
    """Serialize a generated card with full data (not in registry)."""
    return {
        "inline": True,
        "inst_id": card.id,
        "name": card.name,
        "archetype": card.archetype.value,
        "card_type": card.card_type.value,
        "power": card.power,
        "resource_gain": card.resource_gain,
        "action_return": card.action_return,
        "timing": card.timing.value,
        "buy_cost": card.buy_cost,
        "is_upgraded": card.is_upgraded,
        "starter": card.starter,
        "trash_on_use": card.trash_on_use,
        "stackable": card.stackable,
        "forced_discard": card.forced_discard,
        "draw_cards": card.draw_cards,
        "defense_bonus": card.defense_bonus,
        "adjacency_required": card.adjacency_required,
        "claim_range": card.claim_range,
        "unoccupied_only": card.unoccupied_only,
        "multi_target_count": card.multi_target_count,
        "defense_target_count": card.defense_target_count,
        "flood": card.flood,
        "target_own_tile": card.target_own_tile,
        "unplayable": card.unplayable,
        "passive_vp": card.passive_vp,
        "vp_formula": card.vp_formula,
        "description": card.description,
        "effects": [_serialize_effect(e) for e in card.effects],
    }


def _deserialize_card_ref(
    ref: dict[str, Any],
    registry: dict[str, Card],
) -> Card:
    """Reconstruct a Card from a serialized reference."""
    import copy

    if ref.get("inline"):
        return _deserialize_card_inline(ref)

    base_id = ref["base_id"]
    inst_id = ref["inst_id"]
    is_upgraded = ref.get("is_upgraded", False)

    template = registry.get(base_id)
    if template is None:
        raise ValueError(
            f"Card '{base_id}' not found in registry. "
            f"Was the card removed from the data files?"
        )

    card = copy.deepcopy(template)
    card.id = inst_id
    card.is_upgraded = is_upgraded

    # Restore runtime overrides
    if "passive_vp_override" in ref:
        card.passive_vp = ref["passive_vp_override"]

    return card


def _deserialize_card_inline(ref: dict[str, Any]) -> Card:
    """Reconstruct a generated card from inline data."""
    effects = [_deserialize_effect(e) for e in ref.get("effects", [])]
    return Card(
        id=ref["inst_id"],
        name=ref["name"],
        archetype=Archetype(ref["archetype"]),
        card_type=CardType(ref["card_type"]),
        power=ref.get("power", 0),
        resource_gain=ref.get("resource_gain", 0),
        action_return=ref.get("action_return", 0),
        timing=Timing(ref.get("timing", "immediate")),
        buy_cost=ref.get("buy_cost"),
        is_upgraded=ref.get("is_upgraded", False),
        starter=ref.get("starter", False),
        trash_on_use=ref.get("trash_on_use", False),
        stackable=ref.get("stackable", False),
        forced_discard=ref.get("forced_discard", 0),
        draw_cards=ref.get("draw_cards", 0),
        defense_bonus=ref.get("defense_bonus", 0),
        adjacency_required=ref.get("adjacency_required", True),
        claim_range=ref.get("claim_range", 1),
        unoccupied_only=ref.get("unoccupied_only", False),
        multi_target_count=ref.get("multi_target_count", 0),
        defense_target_count=ref.get("defense_target_count", 1),
        flood=ref.get("flood", False),
        target_own_tile=ref.get("target_own_tile", False),
        unplayable=ref.get("unplayable", False),
        passive_vp=ref.get("passive_vp", 0),
        vp_formula=ref.get("vp_formula", ""),
        description=ref.get("description", ""),
        effects=effects,
    )


# ---------------------------------------------------------------------------
# Effect serialization
# ---------------------------------------------------------------------------

def _serialize_effect(effect: Effect) -> dict[str, Any]:
    """Serialize an Effect to a dict."""
    d: dict[str, Any] = {
        "type": effect.type.value,
        "value": effect.value,
        "timing": effect.timing.value,
        "condition": effect.condition.value,
        "condition_threshold": effect.condition_threshold,
        "target": effect.target,
        "duration": effect.duration,
        "requires_choice": effect.requires_choice,
    }
    if effect.upgraded_value is not None:
        d["upgraded_value"] = effect.upgraded_value
    if effect.metadata:
        d["metadata"] = effect.metadata
    return d


def _deserialize_effect(data: dict[str, Any]) -> Effect:
    """Reconstruct an Effect from a dict."""
    return Effect(
        type=EffectType(data["type"]),
        value=data.get("value", 0),
        upgraded_value=data.get("upgraded_value"),
        timing=Timing(data.get("timing", "immediate")),
        condition=ConditionType(data.get("condition", "always")),
        condition_threshold=data.get("condition_threshold", 0),
        target=data.get("target", "self"),
        duration=data.get("duration", 1),
        requires_choice=data.get("requires_choice", False),
        metadata=data.get("metadata", {}),
    )


# ---------------------------------------------------------------------------
# TurnModifiers serialization
# ---------------------------------------------------------------------------

def _serialize_turn_modifiers(tm: TurnModifiers) -> dict[str, Any]:
    return {
        "buy_locked": tm.buy_locked,
        "cost_reductions": tm.cost_reductions,
        "immune_tiles": tm.immune_tiles,
        "contest_costs": tm.contest_costs,
        "extra_draws_next_turn": tm.extra_draws_next_turn,
        "extra_actions_next_turn": tm.extra_actions_next_turn,
        "extra_resources_next_turn": tm.extra_resources_next_turn,
        "free_rerolls": tm.free_rerolls,
        "ignore_defense_tiles": list(tm.ignore_defense_tiles),
        "immediate_resolve_tiles": list(tm.immediate_resolve_tiles),
        "cease_fire_bonus": tm.cease_fire_bonus,
        "ignore_defense_override_tiles": list(tm.ignore_defense_override_tiles),
        "plague_trash_next_turn": tm.plague_trash_next_turn,
    }


def _deserialize_turn_modifiers(data: dict[str, Any]) -> TurnModifiers:
    return TurnModifiers(
        buy_locked=data.get("buy_locked", False),
        cost_reductions=data.get("cost_reductions", []),
        immune_tiles=data.get("immune_tiles", {}),
        contest_costs=data.get("contest_costs", {}),
        extra_draws_next_turn=data.get("extra_draws_next_turn", 0),
        extra_actions_next_turn=data.get("extra_actions_next_turn", 0),
        extra_resources_next_turn=data.get("extra_resources_next_turn", 0),
        free_rerolls=data.get("free_rerolls", 0),
        ignore_defense_tiles=set(data.get("ignore_defense_tiles", [])),
        immediate_resolve_tiles=set(data.get("immediate_resolve_tiles", [])),
        cease_fire_bonus=data.get("cease_fire_bonus", 0),
        ignore_defense_override_tiles=set(data.get("ignore_defense_override_tiles", [])),
        plague_trash_next_turn=data.get("plague_trash_next_turn", 0),
    )


# ---------------------------------------------------------------------------
# PlannedAction serialization
# ---------------------------------------------------------------------------

def _serialize_planned_action(
    action: PlannedAction, registry: dict[str, Card]
) -> dict[str, Any]:
    d: dict[str, Any] = {
        "card": _serialize_card_ref(action.card, registry),
        "target_q": action.target_q,
        "target_r": action.target_r,
        "target_player_id": action.target_player_id,
        "extra_targets": [[q, r] for q, r in action.extra_targets],
        "effective_power": action.effective_power,
        "effective_resource_gain": action.effective_resource_gain,
    }
    return d


def _deserialize_planned_action(
    data: dict[str, Any], registry: dict[str, Card]
) -> PlannedAction:
    card = _deserialize_card_ref(data["card"], registry)
    return PlannedAction(
        card=card,
        target_q=data.get("target_q"),
        target_r=data.get("target_r"),
        target_player_id=data.get("target_player_id"),
        extra_targets=[tuple(t) for t in data.get("extra_targets", [])],
        effective_power=data.get("effective_power"),
        effective_resource_gain=data.get("effective_resource_gain"),
    )


# ---------------------------------------------------------------------------
# Player serialization
# ---------------------------------------------------------------------------

def _serialize_card_list(
    cards: list[Card], registry: dict[str, Card]
) -> list[dict[str, Any]]:
    return [_serialize_card_ref(c, registry) for c in cards]


def _serialize_player(player: Player, registry: dict[str, Card]) -> dict[str, Any]:
    return {
        "id": player.id,
        "name": player.name,
        "archetype": player.archetype.value,
        "color": player.color,
        "deck_cards": _serialize_card_list(player.deck.cards, registry),
        "deck_discard": _serialize_card_list(player.deck.discard, registry),
        "hand": _serialize_card_list(player.hand, registry),
        "resources": player.resources,
        "vp": player.vp,
        "actions_used": player.actions_used,
        "actions_available": player.actions_available,
        "planned_actions": [
            _serialize_planned_action(a, registry) for a in player.planned_actions
        ],
        "archetype_market": _serialize_card_list(player.archetype_market, registry),
        "archetype_deck": _serialize_card_list(player.archetype_deck, registry),
        "upgrade_credits": player.upgrade_credits,
        "forced_discard_next_turn": player.forced_discard_next_turn,
        "has_submitted_play": player.has_submitted_play,
        "has_acknowledged_resolve": player.has_acknowledged_resolve,
        "has_ended_turn": player.has_ended_turn,
        "turn_modifiers": _serialize_turn_modifiers(player.turn_modifiers),
        "trash": _serialize_card_list(player.trash, registry),
        "last_upkeep_paid": player.last_upkeep_paid,
        "upkeep_cost": player.upkeep_cost,
        "tiles_lost_to_upkeep": player.tiles_lost_to_upkeep,
        "is_cpu": player.is_cpu,
        "cpu_noise": player.cpu_noise,
        "has_left": player.has_left,
        "left_vp": player.left_vp,
        "claims_won_last_round": player.claims_won_last_round,
        "tiles_lost_last_round": player.tiles_lost_last_round,
        "pending_discard": player.pending_discard,
        "_prev_market_ids": player._prev_market_ids,
        "_prev_market_types": player._prev_market_types,
    }


def _deserialize_card_list(
    data: list[dict[str, Any]], registry: dict[str, Card]
) -> list[Card]:
    return [_deserialize_card_ref(ref, registry) for ref in data]


def _deserialize_player(data: dict[str, Any], registry: dict[str, Card]) -> Player:
    deck = Deck(
        cards=_deserialize_card_list(data.get("deck_cards", []), registry),
        discard=_deserialize_card_list(data.get("deck_discard", []), registry),
    )
    hand = _deserialize_card_list(data.get("hand", []), registry)
    planned_actions = [
        _deserialize_planned_action(a, registry)
        for a in data.get("planned_actions", [])
    ]
    archetype_market = _deserialize_card_list(
        data.get("archetype_market", []), registry
    )
    archetype_deck = _deserialize_card_list(
        data.get("archetype_deck", []), registry
    )
    trash = _deserialize_card_list(data.get("trash", []), registry)
    turn_modifiers = _deserialize_turn_modifiers(
        data.get("turn_modifiers", {})
    )

    player = Player(
        id=data["id"],
        name=data["name"],
        archetype=Archetype(data["archetype"]),
        color=data.get("color", "#666666"),
        deck=deck,
        hand=hand,
        resources=data.get("resources", 0),
        vp=data.get("vp", 0),
        actions_used=data.get("actions_used", 0),
        actions_available=data.get("actions_available", 0),
        planned_actions=planned_actions,
        archetype_market=archetype_market,
        archetype_deck=archetype_deck,
        upgrade_credits=data.get("upgrade_credits", 0),
        forced_discard_next_turn=data.get("forced_discard_next_turn", 0),
        has_submitted_play=data.get("has_submitted_play", False),
        has_acknowledged_resolve=data.get("has_acknowledged_resolve", False),
        has_ended_turn=data.get("has_ended_turn", False),
        turn_modifiers=turn_modifiers,
        trash=trash,
        last_upkeep_paid=data.get("last_upkeep_paid", 0),
        upkeep_cost=data.get("upkeep_cost", 0),
        tiles_lost_to_upkeep=data.get("tiles_lost_to_upkeep", 0),
        is_cpu=data.get("is_cpu", False),
        cpu_noise=data.get("cpu_noise", 0.15),
        has_left=data.get("has_left", False),
        left_vp=data.get("left_vp", 0),
        claims_won_last_round=data.get("claims_won_last_round", 0),
        tiles_lost_last_round=data.get("tiles_lost_last_round", 0),
        pending_discard=data.get("pending_discard", 0),
    )
    player._prev_market_ids = data.get("_prev_market_ids", [])
    player._prev_market_types = data.get("_prev_market_types", [])
    return player


# ---------------------------------------------------------------------------
# HexGrid serialization
# ---------------------------------------------------------------------------

def _serialize_tile(tile: HexTile) -> dict[str, Any]:
    d: dict[str, Any] = {
        "q": tile.q,
        "r": tile.r,
    }
    # Only include non-default values to keep the blob compact
    if tile.is_blocked:
        d["is_blocked"] = True
    if tile.is_vp:
        d["is_vp"] = True
    if tile.vp_value != 1:
        d["vp_value"] = tile.vp_value
    if tile.owner is not None:
        d["owner"] = tile.owner
    if tile.defense_power != 0:
        d["defense_power"] = tile.defense_power
    if tile.base_defense != 0:
        d["base_defense"] = tile.base_defense
    if tile.permanent_defense_bonus != 0:
        d["permanent_defense_bonus"] = tile.permanent_defense_bonus
    if tile.held_since_turn is not None:
        d["held_since_turn"] = tile.held_since_turn
    if tile.capture_count != 0:
        d["capture_count"] = tile.capture_count
    if tile.is_base:
        d["is_base"] = True
    if tile.base_owner is not None:
        d["base_owner"] = tile.base_owner
    return d


def _deserialize_tile(data: dict[str, Any]) -> HexTile:
    return HexTile(
        q=data["q"],
        r=data["r"],
        is_blocked=data.get("is_blocked", False),
        is_vp=data.get("is_vp", False),
        vp_value=data.get("vp_value", 1),
        owner=data.get("owner"),
        defense_power=data.get("defense_power", 0),
        base_defense=data.get("base_defense", 0),
        permanent_defense_bonus=data.get("permanent_defense_bonus", 0),
        held_since_turn=data.get("held_since_turn"),
        capture_count=data.get("capture_count", 0),
        is_base=data.get("is_base", False),
        base_owner=data.get("base_owner"),
    )


def _serialize_grid(grid: HexGrid) -> dict[str, Any]:
    return {
        "size": grid.size.value,
        "tiles": [_serialize_tile(t) for t in grid.tiles.values()],
        "starting_positions": grid.starting_positions,
    }


def _deserialize_grid(data: dict[str, Any]) -> HexGrid:
    grid = HexGrid(size=GridSize(data["size"]))
    for tile_data in data.get("tiles", []):
        tile = _deserialize_tile(tile_data)
        grid.tiles[tile.key] = tile
    # JSON turns tuples into lists; convert back to list[list[tuple[int, int]]]
    raw_positions = data.get("starting_positions", [])
    grid.starting_positions = [
        [tuple(coord) for coord in cluster] for cluster in raw_positions
    ]
    return grid


# ---------------------------------------------------------------------------
# NeutralMarket serialization
# ---------------------------------------------------------------------------

def _serialize_neutral_market(
    market: NeutralMarket, registry: dict[str, Card]
) -> dict[str, Any]:
    stacks: dict[str, list[dict[str, Any]]] = {}
    for base_id, copies in market.stacks.items():
        stacks[base_id] = _serialize_card_list(copies, registry)
    return {"stacks": stacks}


def _deserialize_neutral_market(
    data: dict[str, Any], registry: dict[str, Card]
) -> NeutralMarket:
    market = NeutralMarket()
    for base_id, copies_data in data.get("stacks", {}).items():
        market.stacks[base_id] = _deserialize_card_list(copies_data, registry)
    return market


# ---------------------------------------------------------------------------
# LogEntry serialization
# ---------------------------------------------------------------------------

def _serialize_log_entry(entry: LogEntry) -> dict[str, Any]:
    d: dict[str, Any] = {
        "message": entry.message,
        "round": entry.round,
        "phase": entry.phase,
    }
    if entry.visible_to:
        d["visible_to"] = entry.visible_to
    if entry.actor:
        d["actor"] = entry.actor
    return d


def _deserialize_log_entry(data: dict[str, Any]) -> LogEntry:
    return LogEntry(
        message=data["message"],
        round=data.get("round", 0),
        phase=data.get("phase", ""),
        visible_to=data.get("visible_to", []),
        actor=data.get("actor"),
    )


# ---------------------------------------------------------------------------
# RNG serialization
# ---------------------------------------------------------------------------

def _serialize_rng(rng: random.Random) -> Any:
    """Serialize RNG state via getstate().

    Returns a JSON-compatible representation of the state tuple.
    random.Random.getstate() returns (version, internalstate, gauss_next)
    where internalstate is a tuple of 625 ints.
    """
    state = rng.getstate()
    return {
        "version": state[0],
        "internalstate": list(state[1]),
        "gauss_next": state[2],
    }


def _deserialize_rng(data: Any) -> random.Random:
    """Reconstruct a random.Random with exact state."""
    rng = random.Random()
    state = (
        data["version"],
        tuple(data["internalstate"]),
        data["gauss_next"],
    )
    rng.setstate(state)
    return rng


# ---------------------------------------------------------------------------
# Top-level: serialize / deserialize GameState
# ---------------------------------------------------------------------------

def serialize_game(game: GameState) -> str:
    """Serialize a GameState to a JSON string for DB storage.

    Uses the game's own card_registry to produce compact card references.
    """
    registry = game.card_registry

    blob: dict[str, Any] = {
        "_schema_version": _SCHEMA_VERSION,
        "id": game.id,
        "current_phase": game.current_phase.value,
        "current_round": game.current_round,
        "first_player_index": game.first_player_index,
        "player_order": game.player_order,
        "winner": game.winner,
        "vp_target": game.vp_target,
        "granted_actions": game.granted_actions,
        "host_id": game.host_id,
        "lobby_code": game.lobby_code,
        "current_buyer_index": game.current_buyer_index,
        "card_pack": game.card_pack,
        "map_seed": game.map_seed,
        "claim_ban_rounds": game.claim_ban_rounds,
        "test_mode": game.test_mode,
        # Grid
        "grid": _serialize_grid(game.grid) if game.grid else None,
        # Players
        "players": {
            pid: _serialize_player(p, registry)
            for pid, p in game.players.items()
        },
        # Markets
        "neutral_market": _serialize_neutral_market(game.neutral_market, registry),
        "neutral_purchase_log": game.neutral_purchase_log,
        "buy_phase_purchases": game.buy_phase_purchases,
        # Logs
        "log": game.log,
        "game_log": [_serialize_log_entry(e) for e in game.game_log],
        # RNG
        "rng": _serialize_rng(game.rng),
        # Resolution state (ephemeral but needed for mid-reveal saves)
        "resolution_steps": game.resolution_steps,
        "player_effects": game.player_effects,
    }

    return json.dumps(blob, separators=(",", ":"))


def deserialize_game(
    data: str | dict[str, Any],
    card_registry: dict[str, Card],
) -> GameState:
    """Reconstruct a GameState from a serialized JSON blob.

    The card_registry is built at startup from YAML data files and passed
    in — it is NOT stored in the blob.
    """
    if isinstance(data, str):
        blob: dict[str, Any] = json.loads(data)
    else:
        blob = data

    schema_version = blob.get("_schema_version", 1)
    # Future: apply migrations for older schema versions here
    _migrate(blob, schema_version)

    # Grid
    grid = _deserialize_grid(blob["grid"]) if blob.get("grid") else None

    # Players
    players: dict[str, Player] = {}
    for pid, pdata in blob.get("players", {}).items():
        players[pid] = _deserialize_player(pdata, card_registry)

    # Markets
    neutral_market = _deserialize_neutral_market(
        blob.get("neutral_market", {}), card_registry
    )

    # Logs
    game_log = [
        _deserialize_log_entry(e) for e in blob.get("game_log", [])
    ]

    # RNG
    rng = _deserialize_rng(blob["rng"]) if blob.get("rng") else random.Random()

    game = GameState(
        id=blob["id"],
        grid=grid,
        players=players,
        player_order=blob.get("player_order", []),
        current_phase=Phase(blob["current_phase"]),
        current_round=blob.get("current_round", 0),
        first_player_index=blob.get("first_player_index", 0),
        neutral_market=neutral_market,
        winner=blob.get("winner"),
        rng=rng,
        card_registry=card_registry,
        log=blob.get("log", []),
        game_log=game_log,
        test_mode=blob.get("test_mode", False),
        vp_target=blob.get("vp_target", 10),
        granted_actions=blob.get("granted_actions"),
        host_id=blob.get("host_id"),
        lobby_code=blob.get("lobby_code"),
        neutral_purchase_log=blob.get("neutral_purchase_log", []),
        current_buyer_index=blob.get("current_buyer_index", 0),
        buy_phase_purchases=blob.get("buy_phase_purchases", {}),
        card_pack=blob.get("card_pack", "everything"),
        map_seed=blob.get("map_seed", ""),
        claim_ban_rounds=blob.get("claim_ban_rounds", 0),
        resolution_steps=blob.get("resolution_steps", []),
        player_effects=blob.get("player_effects", []),
    )

    return game


def _migrate(blob: dict[str, Any], from_version: int) -> None:
    """Apply schema migrations from from_version to _SCHEMA_VERSION."""
    # Currently at version 1 — no migrations needed yet.
    # Future example:
    # if from_version < 2:
    #     blob.setdefault("new_field", default_value)
    pass
