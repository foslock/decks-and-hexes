"""Tests for card system and deck management."""

from __future__ import annotations

import random

import pytest

from app.game_engine.cards import (
    ARCHETYPE_SLOTS,
    HAND_SIZE,
    Archetype,
    Card,
    CardType,
    Deck,
    Timing,
    build_starting_deck,
)


class TestCardProperties:
    def test_effective_power_base(self) -> None:
        card = Card(id="test", name="Test", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM, power=3)
        assert card.effective_power == 3

    def test_effective_power_upgraded(self) -> None:
        card = Card(
            id="test", name="Test", archetype=Archetype.NEUTRAL,
            card_type=CardType.CLAIM, power=3, is_upgraded=True, upgraded_power=5,
        )
        assert card.effective_power == 5

    def test_effective_power_upgraded_no_override(self) -> None:
        card = Card(
            id="test", name="Test", archetype=Archetype.NEUTRAL,
            card_type=CardType.CLAIM, power=3, is_upgraded=True,
        )
        assert card.effective_power == 3  # No upgraded_power set, falls back

    def test_effective_resource_gain_upgraded(self) -> None:
        card = Card(
            id="test", name="Test", archetype=Archetype.NEUTRAL,
            card_type=CardType.ENGINE, resource_gain=2,
            is_upgraded=True, upgraded_resource_gain=4,
        )
        assert card.effective_resource_gain == 4

    def test_to_dict_contains_required_fields(self) -> None:
        card = Card(
            id="test", name="Test", archetype=Archetype.VANGUARD,
            card_type=CardType.CLAIM, power=3, buy_cost=4,
        )
        d = card.to_dict()
        assert d["id"] == "test"
        assert d["name"] == "Test"
        assert d["archetype"] == "vanguard"
        assert d["card_type"] == "claim"
        assert d["power"] == 3
        assert d["buy_cost"] == 4

    def test_action_return_values(self) -> None:
        standard = Card(id="a", name="A", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM, action_return=0)
        net_neutral = Card(id="b", name="B", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM, action_return=1)
        net_positive = Card(id="c", name="C", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM, action_return=2)
        assert standard.effective_action_return == 0
        assert net_neutral.effective_action_return == 1
        assert net_positive.effective_action_return == 2


class TestDeck:
    def test_draw_from_full_deck(self) -> None:
        cards = [Card(id=f"c{i}", name=f"Card {i}", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM) for i in range(5)]
        deck = Deck(cards=cards)
        drawn = deck.draw(3)
        assert len(drawn) == 3
        assert len(deck.cards) == 2

    def test_draw_reshuffles_discard(self) -> None:
        rng = random.Random(42)
        cards = [Card(id="c0", name="Card 0", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM)]
        discard = [Card(id=f"d{i}", name=f"Discard {i}", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM) for i in range(3)]
        deck = Deck(cards=cards, discard=discard)

        drawn = deck.draw(4, rng)
        assert len(drawn) == 4  # 1 from deck + 3 from reshuffled discard
        assert len(deck.discard) == 0

    def test_draw_empty_deck_and_discard(self) -> None:
        deck = Deck()
        drawn = deck.draw(3)
        assert len(drawn) == 0

    def test_draw_partial_when_not_enough(self) -> None:
        cards = [Card(id="c0", name="Card 0", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM)]
        deck = Deck(cards=cards)
        drawn = deck.draw(5)
        assert len(drawn) == 1

    def test_add_to_discard(self) -> None:
        deck = Deck()
        cards = [Card(id="c0", name="Card 0", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM)]
        deck.add_to_discard(cards)
        assert len(deck.discard) == 1

    def test_add_to_top(self) -> None:
        existing = Card(id="existing", name="Existing", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM)
        new = Card(id="new", name="New", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM)
        deck = Deck(cards=[existing])
        deck.add_to_top(new)
        assert deck.cards[0].id == "new"
        assert len(deck.cards) == 2

    def test_total_cards(self) -> None:
        cards = [Card(id="c0", name="Card 0", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM)]
        discard = [Card(id="d0", name="Discard 0", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM)]
        deck = Deck(cards=cards, discard=discard)
        assert deck.total_cards == 2

    def test_shuffle_is_deterministic(self) -> None:
        cards = [Card(id=f"c{i}", name=f"Card {i}", archetype=Archetype.NEUTRAL, card_type=CardType.CLAIM) for i in range(10)]
        deck1 = Deck(cards=list(cards))
        deck2 = Deck(cards=list(cards))
        deck1.shuffle(random.Random(42))
        deck2.shuffle(random.Random(42))
        assert [c.id for c in deck1.cards] == [c.id for c in deck2.cards]


class TestStartingDecks:
    def test_all_archetypes_start_with_10_cards(self, card_registry: dict[str, Card]) -> None:
        """All archetypes start with 10 cards."""
        for archetype in [Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS]:
            deck = build_starting_deck(archetype, card_registry)
            assert deck.total_cards == 10, f"{archetype.value} has {deck.total_cards} cards"

    def test_starting_deck_has_correct_hand_size_ratio(self, card_registry: dict[str, Card]) -> None:
        """Starting decks should be 2x hand size (10 cards, hand size 5)."""
        for archetype in [Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS]:
            deck = build_starting_deck(archetype, card_registry)
            assert deck.total_cards == 2 * HAND_SIZE[archetype]

    def test_uniform_starter_composition(self, card_registry: dict[str, Card]) -> None:
        """All archetypes: 5× Explore, 5× Gather (uniform starting decks)."""
        for archetype in [Archetype.VANGUARD, Archetype.SWARM, Archetype.FORTRESS]:
            deck = build_starting_deck(archetype, card_registry)
            explores = [c for c in deck.cards if "explore" in c.id]
            gathers = [c for c in deck.cards if "gather" in c.id]
            assert len(explores) == 5, f"{archetype.value} has {len(explores)} explores"
            assert len(gathers) == 5, f"{archetype.value} has {len(gathers)} gathers"
            assert deck.total_cards == 10, f"{archetype.value} has {deck.total_cards} cards"


class TestArchetypeConstants:
    def test_action_slots(self) -> None:
        assert ARCHETYPE_SLOTS[Archetype.VANGUARD] == 5
        assert ARCHETYPE_SLOTS[Archetype.SWARM] == 5
        assert ARCHETYPE_SLOTS[Archetype.FORTRESS] == 5

    def test_hand_sizes(self) -> None:
        assert HAND_SIZE[Archetype.VANGUARD] == 5
        assert HAND_SIZE[Archetype.SWARM] == 5
        assert HAND_SIZE[Archetype.FORTRESS] == 5

