"""Card pack integrity and daily-pack coverage guarantees."""

from __future__ import annotations

import datetime

from app.game_engine.card_packs import CARD_PACKS, generate_daily_pack, _gains_resources
from app.game_engine.cards import Archetype, CardType


def test_curated_packs_reference_purchasable_shared_cards(card_registry):
    for pack in CARD_PACKS.values():
        if pack.shared_card_ids is None:
            continue
        assert len(pack.shared_card_ids) == len(set(pack.shared_card_ids)), pack.id
        for cid in pack.shared_card_ids:
            card = card_registry.get(cid)
            assert card is not None, f"{pack.id}: unknown card {cid}"
            assert card.archetype == Archetype.SHARED and card.buy_cost is not None, (pack.id, cid)
            assert not card.starter, (pack.id, cid)


def test_every_pack_has_a_description():
    for pack in CARD_PACKS.values():
        assert pack.description, pack.id
        assert pack.to_dict()["description"] == pack.description


def test_rapid_advance_cards_all_refund_actions(card_registry):
    """The pack's theme: every shared card draws or refunds actions."""
    pack = CARD_PACKS["mini_rapid_advance"]
    for cid in pack.shared_card_ids or []:
        c = card_registry[cid]
        gives_action = c.effective_action_return > 0 or any(
            e.type.value in ("grant_actions", "conditional_action") for e in c.effects
        )
        assert gives_action, cid


def test_daily_packs_meet_coverage_guarantees(card_registry):
    start = datetime.date(2026, 1, 1)
    for offset in range(365):
        seed = int((start + datetime.timedelta(days=offset)).strftime("%Y%m%d"))
        pack = generate_daily_pack(seed, card_registry)
        cards = [card_registry[cid] for cid in pack.shared_card_ids or []]
        assert len(cards) == 10 and len({c.id for c in cards}) == 10, seed
        assert any(c.card_type == CardType.CLAIM and c.effective_power >= 2
                   and not c.trash_on_use for c in cards), seed
        assert any(c.card_type == CardType.DEFENSE for c in cards), seed
        assert any(_gains_resources(c) for c in cards), seed
        assert any(c.card_type == CardType.ENGINE for c in cards), seed
        assert any(c.buy_cost is not None and c.buy_cost <= 2 for c in cards), seed
        assert any(c.buy_cost is not None and c.buy_cost >= 4 for c in cards), seed


def test_daily_pack_is_deterministic(card_registry):
    a = generate_daily_pack(20261003, card_registry)
    b = generate_daily_pack(20261003, card_registry)
    assert a.shared_card_ids == b.shared_card_ids
