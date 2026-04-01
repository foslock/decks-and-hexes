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


DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"


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

    # Parse adjacency from effect
    adjacency_required = True
    if "any tile" in effect.lower() and "adjacent" not in effect.lower():
        adjacency_required = False
    if "up to" in effect.lower() and "steps" in effect.lower():
        adjacency_required = False

    # Unoccupied only (e.g. Explore can only claim neutral tiles)
    unoccupied_only = bool(entry.get("unoccupied_only", False))

    # Starter flag
    starter = bool(entry.get("starter", False))

    # Parse structured effects list from YAML
    effects_data = entry.get("effects", [])
    effects = []
    if isinstance(effects_data, list):
        for eff_entry in effects_data:
            if isinstance(eff_entry, dict):
                eff = parse_effect(eff_entry)
                if eff is not None:
                    effects.append(eff)

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
        stacking_exception=bool(entry.get("stacking_exception", False)),
        forced_discard=forced_discard,
        draw_cards=draw_cards,
        defense_bonus=defense_bonus,
        adjacency_required=adjacency_required,
        unoccupied_only=unoccupied_only,
        description=effect,
        copies=_safe_optional_int(entry.get("copies")),
        effects=effects,
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
