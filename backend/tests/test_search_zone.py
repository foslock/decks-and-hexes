"""Tests for SEARCH_ZONE tutor/search card effects."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.data_loader.loader import load_all_cards
from app.game_engine.cards import Card, _copy_card
from app.game_engine.cpu_player import CPUPlayer
from app.game_engine.game_state import (
    GameState,
    create_game,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_pending_search,
    submit_play,
)
from app.game_engine.hex_grid import GridSize


@pytest.fixture
def card_registry() -> dict[str, Card]:
    return load_all_cards()


def _make_2p_game(card_registry: dict[str, Card], seed: int = 42) -> GameState:
    game = create_game(
        GridSize.SMALL,
        [
            {"id": "p0", "name": "Alice", "archetype": "vanguard"},
            {"id": "p1", "name": "Bob", "archetype": "swarm"},
        ],
        card_registry,
        seed=seed,
    )
    execute_start_of_turn(game)
    execute_upkeep(game)
    return game


def _make_card(registry: dict[str, Card], card_id: str, suffix: str) -> Card:
    """Create a fresh instance of a card from the registry."""
    return _copy_card(registry[card_id], suffix)


def _stock_hand(player, registry: dict[str, Card], card_id: str, suffix: str = "test") -> tuple[int, Card]:
    """Append a copy of card_id to player's hand. Returns (hand index, card instance)."""
    card = _make_card(registry, card_id, suffix)
    player.hand.append(card)
    return len(player.hand) - 1, card


# ── Salvage: search discard → hand ─────────────────────────────────


def test_salvage_sets_pending_search(card_registry):
    """Playing Salvage should set a pending_search on the player."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    target = _make_card(card_registry, "neutral_mercenary", "merc_a")
    p0.deck.discard.append(target)

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "scav_a")
    success, msg = play_card(game, "p0", idx)
    assert success, msg

    ps = p0.pending_search
    assert ps is not None
    assert ps.source == "discard"
    assert ps.count == 1
    assert ps.min_count == 0
    assert ps.allowed_targets == ["hand"]
    assert target.id in ps.snapshot_card_ids


def test_salvage_moves_card_to_hand(card_registry):
    """submit_pending_search should move the chosen card into hand."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    target = _make_card(card_registry, "neutral_mercenary", "merc_b")
    p0.deck.discard.append(target)

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "scav_b")
    play_card(game, "p0", idx)

    hand_size_before = len(p0.hand)
    discard_size_before = len(p0.deck.discard)

    ok, msg = submit_pending_search(game, "p0", [
        {"card_id": target.id, "target": "hand"},
    ])
    assert ok, msg
    assert p0.pending_search is None
    assert len(p0.hand) == hand_size_before + 1
    assert len(p0.deck.discard) == discard_size_before - 1
    assert any(c.id == target.id for c in p0.hand)


def test_empty_discard_rejects_play(card_registry):
    """Salvage cannot be played when the discard is empty — the action would fizzle."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.clear()

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "scav_c")
    hand_before = len(p0.hand)
    actions_used_before = p0.actions_used
    ok, msg = play_card(game, "p0", idx)
    assert not ok
    assert "discard pile" in msg.lower()
    # Nothing mutated — card still in hand, no actions spent, no pending_search
    assert len(p0.hand) == hand_before
    assert p0.actions_used == actions_used_before
    assert p0.pending_search is None


def test_empty_draw_pile_rejects_foresight(card_registry):
    """Foresight cannot be played when the draw pile is empty."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.cards.clear()

    idx, _ = _stock_hand(p0, card_registry, "neutral_foresight", "fs_empty")
    ok, msg = play_card(game, "p0", idx)
    assert not ok
    assert "draw pile" in msg.lower()


def test_empty_trash_rejects_redemption(card_registry):
    """Redemption cannot be played when the trash is empty."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.trash.clear()

    idx, _ = _stock_hand(p0, card_registry, "neutral_redemption", "rd_empty")
    ok, msg = play_card(game, "p0", idx)
    assert not ok
    assert "trash" in msg.lower()


def test_filter_with_no_matches_rejects_play(card_registry):
    """Mobilize Forces (filter: claim) should reject when discard has no Claim cards."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.clear()
    p0.deck.discard.append(_make_card(card_registry, "neutral_prospector", "filt_engine"))

    idx, _ = _stock_hand(p0, card_registry, "vanguard_mobilize_forces", "filt_play")
    ok, msg = play_card(game, "p0", idx)
    assert not ok
    # Error mentions both the filtered type and the zone
    assert "claim" in msg.lower()
    assert "discard pile" in msg.lower()


def test_filter_with_match_allows_play(card_registry):
    """Filter-tutor succeeds when the discard contains at least one matching card."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.clear()
    p0.deck.discard.append(_make_card(card_registry, "neutral_prospector", "filt_engine2"))
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "filt_claim"))

    idx, _ = _stock_hand(p0, card_registry, "vanguard_mobilize_forces", "filt_play2")
    ok, msg = play_card(game, "p0", idx)
    assert ok, msg
    assert p0.pending_search is not None
    # Snapshot only contains the Claim, not the Engine
    assert len(p0.pending_search.snapshot_card_ids) == 1
    assert p0.pending_search.snapshot_card_ids[0].startswith("neutral_mercenary")


# ── Foresight: search draw → hand / top_of_draw (per-card target) ────


def test_foresight_per_card_targets(card_registry):
    """Foresight lets the player route each picked card to hand or top_of_draw."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]

    # Seed known cards on top of deck (top = index 0)
    a = _make_card(card_registry, "neutral_mercenary", "fore_a")
    b = _make_card(card_registry, "neutral_prospector", "fore_b")
    p0.deck.cards = [a, b] + p0.deck.cards

    idx, _ = _stock_hand(p0, card_registry, "neutral_foresight", "fore_c")
    play_card(game, "p0", idx)
    ps = p0.pending_search
    assert ps is not None
    assert ps.source == "draw"
    assert set(ps.allowed_targets) == {"hand", "top_of_draw"}

    hand_before = len(p0.hand)
    deck_before = len(p0.deck.cards)

    ok, msg = submit_pending_search(game, "p0", [
        {"card_id": a.id, "target": "hand"},
        {"card_id": b.id, "target": "top_of_draw"},
    ])
    assert ok, msg

    assert any(c.id == a.id for c in p0.hand)
    # top_of_draw places card at front (index 0)
    assert p0.deck.cards[0].id == b.id
    assert len(p0.hand) == hand_before + 1
    assert len(p0.deck.cards) == deck_before - 1  # one went to hand


# ── Redemption: search trash → hand (recursion) ──────────────────────


def test_redemption_recovers_from_trash(card_registry):
    """Redemption retrieves a card from trash. Card itself is trashed."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    recovered = _make_card(card_registry, "neutral_mercenary", "rdm_a")
    p0.trash.append(recovered)

    idx, redeem = _stock_hand(p0, card_registry, "neutral_redemption", "rdm_b")
    ok, _ = play_card(game, "p0", idx)
    assert ok
    ps = p0.pending_search
    assert ps is not None
    assert ps.source == "trash"

    ok, _ = submit_pending_search(game, "p0", [
        {"card_id": recovered.id, "target": "hand"},
    ])
    assert ok
    assert any(c.id == recovered.id for c in p0.hand)
    # Redemption itself is trash_on_use — it's held in planned_actions until
    # reveal phase trashes it. The search_zone feature isn't responsible for
    # that disposition; we just verify the search resolved correctly.
    assert p0.pending_search is None
    assert any(a.card.id == redeem.id for a in p0.planned_actions)


# ── Draw-pile peek limits ────────────────────────────────────────────


def test_foresight_sees_entire_draw_pile(card_registry):
    """Foresight is the special 'see everything' tutor (peek_all: true).
    It snapshots the whole draw pile, not just the top N."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]

    a = _make_card(card_registry, "neutral_mercenary", "fs_a")
    b = _make_card(card_registry, "neutral_prospector", "fs_b")
    deep = _make_card(card_registry, "neutral_siege_tower", "fs_deep")
    p0.deck.cards = [a, b, deep] + p0.deck.cards

    idx, _ = _stock_hand(p0, card_registry, "neutral_foresight", "fs_play")
    play_card(game, "p0", idx)
    ps = p0.pending_search
    assert ps is not None
    # All three seeded cards (and any pre-existing draw pile) are visible
    assert a.id in ps.snapshot_card_ids
    assert b.id in ps.snapshot_card_ids
    assert deep.id in ps.snapshot_card_ids
    # But pick count is still capped at 2 (or 3 upgraded) — only peek depth differs
    assert ps.count == 2


def test_forward_scout_only_sees_top_n_of_draw(card_registry):
    """Forward Scout (no peek_all) caps the snapshot to the top 2 cards."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]

    visible_a = _make_card(card_registry, "neutral_mercenary", "fws_top1")
    visible_b = _make_card(card_registry, "neutral_prospector", "fws_top2")
    hidden = _make_card(card_registry, "neutral_siege_tower", "fws_hidden")
    p0.deck.cards = [visible_a, visible_b, hidden] + p0.deck.cards

    idx, _ = _stock_hand(p0, card_registry, "vanguard_forward_scout", "fws_play")
    play_card(game, "p0", idx)
    ps = p0.pending_search
    assert ps is not None
    assert visible_a.id in ps.snapshot_card_ids
    assert visible_b.id in ps.snapshot_card_ids
    assert hidden.id not in ps.snapshot_card_ids
    assert len(ps.snapshot_card_ids) == 2


def test_brood_memory_top_3(card_registry):
    """Brood Memory (value=3, source=draw) should snapshot exactly the top 3."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]

    top = [_make_card(card_registry, "neutral_mercenary", f"bm_top{i}") for i in range(3)]
    hidden = _make_card(card_registry, "neutral_siege_tower", "bm_hidden")
    p0.deck.cards = top + [hidden] + p0.deck.cards

    idx, _ = _stock_hand(p0, card_registry, "swarm_brood_memory", "bm_play")
    play_card(game, "p0", idx)
    ps = p0.pending_search
    assert ps is not None
    assert len(ps.snapshot_card_ids) == 3
    assert hidden.id not in ps.snapshot_card_ids


# ── Validation / error cases ─────────────────────────────────────────


def test_min_zero_allows_empty_submission(card_registry):
    """With min=0 (default on Salvage), submitting an empty selection is allowed."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "min0_a"))

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "min0_b")
    play_card(game, "p0", idx)
    assert p0.pending_search is not None
    assert p0.pending_search.min_count == 0

    ok, msg = submit_pending_search(game, "p0", [])
    assert ok, msg
    assert p0.pending_search is None


def test_invalid_target_rejected(card_registry):
    """Targets not in allowed_targets should be rejected."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    target = _make_card(card_registry, "neutral_mercenary", "inv_a")
    p0.deck.discard.append(target)

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "inv_b")
    play_card(game, "p0", idx)

    ok, msg = submit_pending_search(game, "p0", [
        {"card_id": target.id, "target": "trash"},  # not allowed for Salvage
    ])
    assert not ok
    assert "not allowed" in msg.lower()


def test_invalid_card_id_rejected(card_registry):
    """Card ids not in the snapshot should be rejected."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "badid_a"))

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "badid_b")
    play_card(game, "p0", idx)

    ok, msg = submit_pending_search(game, "p0", [
        {"card_id": "neutral_prospector_phantom", "target": "hand"},  # not in discard
    ])
    assert not ok


def test_count_exceeded_rejected(card_registry):
    """Selecting more cards than allowed should fail."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    a = _make_card(card_registry, "neutral_mercenary", "ct_a")
    b = _make_card(card_registry, "neutral_prospector", "ct_b")
    p0.deck.discard.append(a)
    p0.deck.discard.append(b)

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "ct_c")  # count = 1
    play_card(game, "p0", idx)

    ok, msg = submit_pending_search(game, "p0", [
        {"card_id": a.id, "target": "hand"},
        {"card_id": b.id, "target": "hand"},
    ])
    assert not ok
    assert "more than" in msg.lower()


def test_submit_play_blocked_while_pending(card_registry):
    """submit_play cannot succeed while a search is pending."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "blk_a"))

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "blk_b")
    play_card(game, "p0", idx)
    assert p0.pending_search is not None

    ok, msg = submit_play(game, "p0")
    assert not ok
    assert "pending search" in msg.lower()


def test_play_card_blocked_while_pending_search(card_registry):
    """Playing another card while a search is pending should fail."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "blk2_a"))

    # Stock both cards before playing
    idx1, _ = _stock_hand(p0, card_registry, "neutral_salvage", "blk2_b")
    _stock_hand(p0, card_registry, "neutral_gather", "blk2_c")
    play_card(game, "p0", idx1)
    assert p0.pending_search is not None

    # After the play, salvage was popped from hand → new index for the gather is the last
    last_idx = len(p0.hand) - 1
    ok, msg = play_card(game, "p0", last_idx)
    assert not ok
    assert "pending search" in msg.lower()


# ── Inline search_selections (human UI path) ─────────────────────────


def test_inline_search_selections_resolves_without_pending(card_registry):
    """When play_card is called with search_selections, the search resolves
    inline and pending_search is never set (human UI commits atomically)."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    target = _make_card(card_registry, "neutral_mercenary", "inl_a")
    p0.deck.discard.append(target)

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "inl_b")
    ok, msg = play_card(game, "p0", idx, search_selections=[
        {"card_id": target.id, "target": "hand"},
    ])
    assert ok, msg
    # No pending_search left behind
    assert p0.pending_search is None
    # Card landed in hand
    assert any(c.id == target.id for c in p0.hand)


def test_inline_search_selections_empty_list(card_registry):
    """Passing an empty list (declined) also avoids pending_search."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "empty_a"))

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "empty_b")
    ok, msg = play_card(game, "p0", idx, search_selections=[])
    assert ok, msg
    assert p0.pending_search is None


def test_inline_search_selections_invalid_returns_error(card_registry):
    """Invalid selections with inline resolution returns False and clears state."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "inv_a"))

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "inv_b")
    ok, msg = play_card(game, "p0", idx, search_selections=[
        {"card_id": "nonexistent_card_id", "target": "hand"},
    ])
    assert not ok
    assert "invalid search selections" in msg.lower()
    assert p0.pending_search is None


# ── Upgraded values ──────────────────────────────────────────────────


def test_salvage_upgraded_count(card_registry):
    """Upgraded Salvage retrieves 2 cards instead of 1."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    p0.deck.discard.append(_make_card(card_registry, "neutral_mercenary", "up_a"))
    p0.deck.discard.append(_make_card(card_registry, "neutral_prospector", "up_b"))

    card = _make_card(card_registry, "neutral_salvage", "up_c")
    card.is_upgraded = True
    p0.hand.append(card)
    idx = len(p0.hand) - 1

    play_card(game, "p0", idx)
    assert p0.pending_search is not None
    assert p0.pending_search.count == 2


# ── CPU auto-resolve ─────────────────────────────────────────────────


def test_cpu_auto_resolve_picks_high_value(card_registry):
    """CPU should pick the highest-value card available when auto-resolving."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]

    good = _make_card(card_registry, "neutral_siege_tower", "cpu_good")
    bad = _make_card(card_registry, "neutral_gather", "cpu_bad")
    p0.deck.discard.append(bad)
    p0.deck.discard.append(good)

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "cpu_scav")
    play_card(game, "p0", idx)

    cpu = CPUPlayer("p0", noise=0.0, rng=game.rng)
    selections = cpu._pick_search_selections(p0, p0.pending_search)
    assert len(selections) == 1
    assert selections[0]["card_id"] == good.id
    assert selections[0]["target"] == "hand"

    ok, _ = submit_pending_search(game, "p0", selections)
    assert ok
    assert any(c.id == good.id for c in p0.hand)


def test_cpu_routes_debt_to_trash_if_allowed(card_registry):
    """When trash is an allowed target and min forces a pick, CPU routes Debt to trash."""
    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]

    from app.game_engine.cards import make_debt_card
    debt = make_debt_card()
    p0.deck.discard.append(debt)

    from app.game_engine.game_state import PendingSearch
    # min=0 first: CPU should decline to pick Debt
    p0.pending_search = PendingSearch(
        source="discard",
        count=1,
        min_count=0,
        allowed_targets=["hand", "trash"],
        card_filter=None,
        snapshot_card_ids=[debt.id],
    )

    cpu = CPUPlayer("p0", noise=0.0, rng=game.rng)
    selections = cpu._pick_search_selections(p0, p0.pending_search)
    assert selections == []

    # min=1: CPU is forced to pick Debt; should route to trash
    p0.pending_search = PendingSearch(
        source="discard",
        count=1,
        min_count=1,
        allowed_targets=["hand", "trash"],
        card_filter=None,
        snapshot_card_ids=[debt.id],
    )
    selections = cpu._pick_search_selections(p0, p0.pending_search)
    assert len(selections) == 1
    assert selections[0]["target"] == "trash"


# ── Serialization round-trip ─────────────────────────────────────────


def test_pending_search_survives_serialization(card_registry):
    """A game with a pending_search should round-trip through the serializer."""
    from app.storage.serializer import deserialize_game, serialize_game

    game = _make_2p_game(card_registry)
    p0 = game.players["p0"]
    target = _make_card(card_registry, "neutral_mercenary", "ser_a")
    p0.deck.discard.append(target)

    idx, _ = _stock_hand(p0, card_registry, "neutral_salvage", "ser_b")
    play_card(game, "p0", idx)
    assert p0.pending_search is not None

    blob = serialize_game(game)
    game2 = deserialize_game(blob, card_registry)
    ps2 = game2.players["p0"].pending_search
    assert ps2 is not None
    assert ps2.source == "discard"
    assert ps2.allowed_targets == ["hand"]
    assert target.id in ps2.snapshot_card_ids
