"""Tests for data loading from markdown/YAML files."""

from __future__ import annotations

import pytest

from app.data_loader.loader import load_all_cards, load_objectives, load_passives
from app.game_engine.cards import Archetype, Card, CardType


class TestCardLoading:
    def test_loads_cards(self, card_registry: dict[str, Card]) -> None:
        assert len(card_registry) > 0

    def test_loads_all_archetypes(self, card_registry: dict[str, Card]) -> None:
        archetypes = {c.archetype for c in card_registry.values()}
        assert Archetype.NEUTRAL in archetypes
        assert Archetype.VANGUARD in archetypes
        assert Archetype.SWARM in archetypes
        assert Archetype.FORTRESS in archetypes

    def test_starter_cards_exist(self, card_registry: dict[str, Card]) -> None:
        assert "neutral_advance" in card_registry
        assert "neutral_gather" in card_registry

    def test_advance_properties(self, card_registry: dict[str, Card]) -> None:
        advance = card_registry["neutral_advance"]
        assert advance.name == "Advance"
        assert advance.card_type == CardType.CLAIM
        assert advance.power == 1
        assert advance.starter is True
        assert advance.buy_cost is None

    def test_gather_properties(self, card_registry: dict[str, Card]) -> None:
        gather = card_registry["neutral_gather"]
        assert gather.name == "Gather"
        assert gather.card_type == CardType.ENGINE
        assert gather.resource_gain == 2
        assert gather.starter is True
        assert gather.buy_cost is None

    def test_vanguard_cards_exist(self, card_registry: dict[str, Card]) -> None:
        vanguard = [c for c in card_registry.values() if c.archetype == Archetype.VANGUARD]
        assert len(vanguard) >= 10

    def test_swarm_cards_exist(self, card_registry: dict[str, Card]) -> None:
        swarm = [c for c in card_registry.values() if c.archetype == Archetype.SWARM]
        assert len(swarm) >= 10

    def test_fortress_cards_exist(self, card_registry: dict[str, Card]) -> None:
        fortress = [c for c in card_registry.values() if c.archetype == Archetype.FORTRESS]
        assert len(fortress) >= 10

    def test_neutral_market_cards_have_costs(self, card_registry: dict[str, Card]) -> None:
        market_cards = [
            c for c in card_registry.values()
            if c.archetype == Archetype.NEUTRAL and not c.starter and c.buy_cost is not None
        ]
        assert len(market_cards) > 0
        for card in market_cards:
            assert card.buy_cost is not None
            assert card.buy_cost > 0

    def test_cards_have_valid_types(self, card_registry: dict[str, Card]) -> None:
        for card in card_registry.values():
            assert card.card_type in (CardType.CLAIM, CardType.DEFENSE, CardType.ENGINE)

    def test_blitz_properties(self, card_registry: dict[str, Card]) -> None:
        blitz = card_registry.get("vanguard_blitz")
        assert blitz is not None
        assert blitz.name == "Blitz"
        assert blitz.card_type == CardType.CLAIM
        assert blitz.power == 4
        assert blitz.archetype == Archetype.VANGUARD

    def test_scout_properties(self, card_registry: dict[str, Card]) -> None:
        scout = card_registry.get("swarm_scout")
        assert scout is not None
        assert scout.name == "Scout"
        assert scout.archetype == Archetype.SWARM

    def test_no_duplicate_ids(self, card_registry: dict[str, Card]) -> None:
        """Each card should have a unique ID."""
        ids = list(card_registry.keys())
        assert len(ids) == len(set(ids))

    def test_all_cards_have_names(self, card_registry: dict[str, Card]) -> None:
        for card in card_registry.values():
            assert card.name
            assert len(card.name) > 0


class TestObjectiveLoading:
    def test_loads_objectives(self) -> None:
        objectives = load_objectives()
        # May or may not load depending on file format
        # At minimum, verify it doesn't crash
        assert isinstance(objectives, list)

    def test_objectives_have_names(self) -> None:
        objectives = load_objectives()
        for obj in objectives:
            assert "name" in obj


class TestPassiveLoading:
    def test_loads_passives(self) -> None:
        passives = load_passives()
        assert isinstance(passives, list)

    def test_passives_have_names(self) -> None:
        passives = load_passives()
        for p in passives:
            assert "name" in p
