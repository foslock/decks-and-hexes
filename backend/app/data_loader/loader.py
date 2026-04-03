"""Load card, objective, and passive data from markdown files in /data/.

Data files use YAML embedded in .md files with # comments.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

import yaml

from app.game_engine.cards import Archetype, Card, CardType, Timing
from app.game_engine.effects import parse_effect


DATA_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data"


def load_all_cards() -> dict[str, Card]:
    """Load all cards from data files. Returns dict keyed by card ID."""
    registry: dict[str, Card] = {}

    files = {
        "cards_neutral.md": Archetype.NEUTRAL,
        "cards_vanguard.md": Archetype.VANGUARD,
        "cards_swarm.md": Archetype.SWARM,
        "cards_fortress.md": Archetype.FORTRESS,
    }

    for filename, archetype in files.items():
        filepath = DATA_DIR / filename
        if filepath.exists():
            cards = _parse_card_file(filepath, archetype)
            for card in cards:
                registry[card.id] = card

    return registry


def _parse_card_file(filepath: Path, archetype: Archetype) -> list[Card]:
    """Parse a YAML-in-markdown card data file."""
    text = filepath.read_text()

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return []

    if not isinstance(data, dict) or "cards" not in data:
        return []

    cards = []
    for entry in data["cards"]:
        if not isinstance(entry, dict):
            continue
        card = _entry_to_card(entry, archetype)
        if card:
            cards.append(card)

    return cards


def _entry_to_card(entry: dict[str, Any], archetype: Archetype) -> Optional[Card]:
    """Convert a YAML dict entry to a Card object."""
    card_id = entry.get("id")
    name = entry.get("name")
    if not card_id or not name:
        return None

    # Parse card type
    type_str = str(entry.get("type", "engine")).lower()
    if "claim" in type_str:
        card_type = CardType.CLAIM
    elif "defense" in type_str:
        card_type = CardType.DEFENSE
    elif "passive" in type_str:
        card_type = CardType.PASSIVE
    else:
        card_type = CardType.ENGINE

    # Parse timing from secondary_timing or timing field
    timing_str = str(entry.get("timing", entry.get("secondary_timing", "immediate") or "immediate")).lower()
    if "resolution" in timing_str:
        timing = Timing.ON_RESOLUTION
    elif "next" in timing_str:
        timing = Timing.NEXT_TURN
    else:
        timing = Timing.IMMEDIATE

    # Parse resource_gain from effect text if not explicit
    resource_gain = _safe_int(entry.get("resource_gain", 0))
    effect = str(entry.get("effect", ""))
    if resource_gain == 0 and "gain" in effect.lower() and "resource" in effect.lower():
        match = re.search(r'[Gg]ain\s+(\d+)\s+resource', effect)
        if match:
            resource_gain = int(match.group(1))

    # Parse draw_cards from effect text if not explicit
    draw_cards = _safe_int(entry.get("draw_cards", 0))
    if draw_cards == 0 and "draw" in effect.lower():
        match = re.search(r'[Dd]raw\s+(\d+)\s+card', effect)
        if match:
            draw_cards = int(match.group(1))

    # Parse defense_bonus from effect text
    defense_bonus = _safe_int(entry.get("defense_bonus", 0))
    if defense_bonus == 0 and "defense" in effect.lower():
        match = re.search(r'\+(\d+)\s+defense', effect)
        if match:
            defense_bonus = int(match.group(1))

    # Parse forced_discard from effect text
    forced_discard = _safe_int(entry.get("forced_discard", 0))
    if forced_discard == 0 and "discard" in effect.lower():
        match = re.search(r'[Dd]iscard\w*\s+(\d+)', effect)
        if match:
            forced_discard = int(match.group(1))

    # Parse adjacency and range from effect text (explicit YAML field takes priority)
    if "adjacency_required" in entry:
        adjacency_required = bool(entry["adjacency_required"])
    else:
        adjacency_required = True
    claim_range = _safe_int(entry.get("claim_range", 1)) or 1
    # "up to N steps" → extended range (still adjacency-checked via claim_range)
    range_match = re.search(r'up to\s+(\d+)\s+steps', effect.lower())
    if range_match:
        claim_range = int(range_match.group(1))
    elif "adjacency_required" not in entry and "any tile" in effect.lower() and "adjacent" not in effect.lower():
        # Truly unrestricted targeting (no adjacency at all) — auto-detected from text
        adjacency_required = False

    # Unoccupied only (e.g. Explore can only claim neutral tiles)
    unoccupied_only = bool(entry.get("unoccupied_only", False))
    upgraded_unoccupied_only = None
    if "upgraded_unoccupied_only" in entry:
        upgraded_unoccupied_only = bool(entry["upgraded_unoccupied_only"])

    # Multi-target (Surge: up to N extra targets beyond the first)
    multi_target_count = _safe_int(entry.get("multi_target_count", 0))
    upgraded_multi_target_count = _safe_optional_int(entry.get("upgraded_multi_target_count"))

    # Defense multi-target (e.g. Bulwark defends 2 tiles)
    defense_target_count = _safe_int(entry.get("defense_target_count", 1)) or 1
    upgraded_defense_target_count = _safe_optional_int(entry.get("upgraded_defense_target_count"))

    # Flood: target own tile, claim all adjacent at resolution
    flood = bool(entry.get("flood", False))
    target_own_tile = bool(entry.get("target_own_tile", False))

    # Starter flag
    starter = bool(entry.get("starter", False))

    # Unplayable flag (e.g. Land Grant — passive VP, can't be played from hand)
    unplayable = bool(entry.get("unplayable", False))
    passive_vp = _safe_int(entry.get("passive_vp", 0))
    vp_formula = str(entry.get("vp_formula", ""))

    # Parse structured effects list from YAML
    effects_data = entry.get("effects", [])
    effects = []
    if isinstance(effects_data, list):
        for eff_entry in effects_data:
            if isinstance(eff_entry, dict):
                eff = parse_effect(eff_entry)
                if eff is not None:
                    effects.append(eff)

    # Build full description from primary + secondary effect text
    secondary_effect = str(entry.get("secondary_effect", "") or "")
    description = effect
    if secondary_effect:
        description = f"{effect} {secondary_effect}".strip()

    # Parse upgraded fields
    name_upgraded = str(entry.get("name_upgraded", "") or "")
    effect_upgraded = str(entry.get("effect_upgraded", "") or "")
    upgrade_description = effect_upgraded

    # Parse upgraded stats from effect_upgraded text and/or explicit YAML fields
    upgraded_power = _safe_optional_int(entry.get("upgraded_power"))
    upgraded_resource_gain = _safe_optional_int(entry.get("upgraded_resource_gain"))
    upgraded_action_return = _safe_optional_int(entry.get("upgraded_action_return"))
    upgraded_draw_cards = _safe_optional_int(entry.get("upgraded_draw_cards"))
    upgraded_forced_discard = _safe_optional_int(entry.get("upgraded_forced_discard"))
    upgraded_defense_bonus = _safe_optional_int(entry.get("upgraded_defense_bonus"))

    if effect_upgraded:
        if upgraded_power is None and "power" in effect_upgraded.lower():
            m = re.search(r'[Pp]ower\s+(\d+)', effect_upgraded)
            if m:
                upgraded_power = int(m.group(1))

        if upgraded_resource_gain is None and "gain" in effect_upgraded.lower() and "resource" in effect_upgraded.lower():
            m = re.search(r'[Gg]ain\s+(\d+)\s+resource', effect_upgraded)
            if m:
                upgraded_resource_gain = int(m.group(1))

        if upgraded_draw_cards is None and "draw" in effect_upgraded.lower():
            m = re.search(r'[Dd]raw\s+(\d+)\s+card', effect_upgraded)
            if m:
                upgraded_draw_cards = int(m.group(1))

        if upgraded_defense_bonus is None and "defense" in effect_upgraded.lower():
            m = re.search(r'\+(\d+)\s+defense', effect_upgraded)
            if m:
                upgraded_defense_bonus = int(m.group(1))

        if upgraded_forced_discard is None and "discard" in effect_upgraded.lower():
            m = re.search(r'[Dd]iscard\w*\s+(\d+)', effect_upgraded)
            if m:
                upgraded_forced_discard = int(m.group(1))

    card = Card(
        id=card_id,
        name=name,
        archetype=archetype,
        card_type=card_type,
        power=_safe_int(entry.get("power", 0)),
        resource_gain=resource_gain,
        action_return=_safe_int(entry.get("action_return", 0)),
        timing=timing,
        buy_cost=_safe_optional_int(entry.get("buy_cost")),
        starter=starter,
        trash_on_use=bool(entry.get("trash_on_use", False)),
        stackable=bool(entry.get("stackable", False)),
        forced_discard=forced_discard,
        draw_cards=draw_cards,
        defense_bonus=defense_bonus,
        adjacency_required=adjacency_required,
        claim_range=claim_range,
        unoccupied_only=unoccupied_only,
        upgraded_unoccupied_only=upgraded_unoccupied_only,
        multi_target_count=multi_target_count,
        upgraded_multi_target_count=upgraded_multi_target_count,
        defense_target_count=defense_target_count,
        upgraded_defense_target_count=upgraded_defense_target_count,
        flood=flood,
        target_own_tile=target_own_tile,
        unplayable=unplayable,
        passive_vp=passive_vp,
        vp_formula=vp_formula,
        description=description,
        upgrade_description=upgrade_description,
        name_upgraded=name_upgraded,
        copies=_safe_optional_int(entry.get("copies")),
        effects=effects,
        upgraded_power=upgraded_power,
        upgraded_resource_gain=upgraded_resource_gain,
        upgraded_action_return=upgraded_action_return,
        upgraded_draw_cards=upgraded_draw_cards,
        upgraded_forced_discard=upgraded_forced_discard,
        upgraded_defense_bonus=upgraded_defense_bonus,
    )

    return card


def _safe_int(value: Any) -> int:
    if value is None:
        return 0
    try:
        return int(value)
    except (ValueError, TypeError):
        return 0


def _safe_optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def load_objectives() -> list[dict[str, Any]]:
    """Load objectives from data file."""
    filepath = DATA_DIR / "objectives.md"
    if not filepath.exists():
        return []

    text = filepath.read_text()
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return []

    if not isinstance(data, dict) or "objectives" not in data:
        return []

    objectives = []
    for entry in data["objectives"]:
        if not isinstance(entry, dict):
            continue
        objectives.append({
            "name": entry.get("name", ""),
            "pool": entry.get("pool", "wildcard"),
            "condition": entry.get("condition", ""),
            "vp_reward": 2,
        })

    return objectives


def load_passives() -> list[dict[str, Any]]:
    """Load passive abilities from data file."""
    filepath = DATA_DIR / "passives.md"
    if not filepath.exists():
        return []

    text = filepath.read_text()
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return []

    if not isinstance(data, dict) or "passives" not in data:
        return []

    passives = []
    for entry in data["passives"]:
        if not isinstance(entry, dict):
            continue
        passives.append({
            "name": entry.get("name", ""),
            "description": entry.get("effect", entry.get("description", "")),
        })

    return passives
