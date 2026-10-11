"""Upgrades follow one rule: an upgraded card is the same card with bigger
numbers. Its text is the base text with only numbers changed, and it really
plays stronger. A couple of upgrades instead remove a drawback (never one that
gives opponents actions)."""

from __future__ import annotations

import re

from app.game_engine.cards import _copy_card

# Upgrades that remove a drawback instead of raising a number.
DRAWBACK_REMOVED = {
    "neutral_diplomat",  # opponents receive no Land Grants
    "swarm_plague",      # only opponents trash a card
}

_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6"}


def _shape(text: str) -> str:
    """Text with every number blanked and plural/singular wording evened out."""
    s = text.lower()
    for word, digit in _WORDS.items():
        s = re.sub(rf"\b{word}\b", digit, s)
    s = s.replace("up to ", "")
    s = re.sub(r"\d+", "N", s)
    s = re.sub(r"\b(card|resource|action|claim|tile|land grant)s\b", r"\1", s)
    for plural, singular in ((" them ", " it "), (" each get ", " get "), (" gets ", " get "),
                             (" each gain ", " gain "), (" gains ", " gain "),
                             ("the next claim", "the next N claim")):
        s = s.replace(plural, singular)
    return s


def _numbers(card) -> tuple:
    """Everything an upgrade may raise, as played."""
    return (
        card.effective_power, card.effective_resource_gain, card.effective_action_return,
        card.effective_draw_cards, card.effective_defense_bonus, card.effective_forced_discard,
        card.effective_multi_target_count, card.effective_defense_target_count,
        tuple(e.effective_value(card.is_upgraded) for e in card.effects),
        tuple(sorted(
            (k, v) for e in card.effects for k, v in e.metadata.items()
            if isinstance(v, int) and not k.startswith("upgraded_")
        )),
        tuple(sorted(
            (k[len("upgraded_"):], v) for e in card.effects for k, v in e.metadata.items()
            if card.is_upgraded and k.startswith("upgraded_")
        )),
    )


def test_upgraded_text_only_changes_numbers(card_registry):
    for cid, card in card_registry.items():
        if not card.upgrade_description or cid in DRAWBACK_REMOVED:
            continue
        assert _shape(card.description) == _shape(card.upgrade_description), (
            f"{cid}: '{card.description}' → '{card.upgrade_description}'")


def test_every_upgrade_plays_stronger(card_registry):
    for cid, card in card_registry.items():
        if not card.upgrade_description:
            continue
        upgraded = _copy_card(card, "up")
        upgraded.is_upgraded = True
        if cid in DRAWBACK_REMOVED or card.vp_formula:
            continue  # VP-formula numbers live in _compute_formula_vp
        base_meta = _numbers(card)[:-1]
        up_meta = _numbers(upgraded)
        changed = base_meta != up_meta[:-1] or bool(up_meta[-1])
        assert changed, f"{cid}: the upgrade changes no number"


def test_no_upgrade_only_effects(card_registry):
    for cid, card in card_registry.items():
        for e in card.effects:
            assert not e.metadata.get("upgraded_only"), cid
            # An effect worth nothing until upgraded is a new clause, not a bigger number.
            if e.upgraded_value is not None and cid not in DRAWBACK_REMOVED:
                assert e.value != 0 or e.upgraded_value == 0, f"{cid}: {e.type.value} only works upgraded"
