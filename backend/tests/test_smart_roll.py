"""Tests for smart archetype market roll heuristics."""

import random
from dataclasses import dataclass, field

from app.game_engine.cards import Archetype, Card, CardType, Timing
from app.game_engine.game_state import Player, _draw_archetype_market


def _make_card(
    id: str,
    card_type: CardType = CardType.CLAIM,
    buy_cost: int | None = 3,
    archetype: Archetype = Archetype.VANGUARD,
) -> Card:
    return Card(
        id=id,
        name=id,
        archetype=archetype,
        card_type=card_type,
        buy_cost=buy_cost,
    )


def _make_player(**kwargs) -> Player:
    defaults = dict(id="p0", name="Test", archetype=Archetype.VANGUARD, resources=5)
    defaults.update(kwargs)
    return Player(**defaults)


# ---------------------------------------------------------------------------
# Heuristic 1: No consecutive repeats
# ---------------------------------------------------------------------------

class TestNoConsecutiveRepeats:
    def test_second_roll_excludes_previous_cards(self):
        """Cards from the first roll should not appear in the second roll."""
        cards = [_make_card(f"c{i}") for i in range(10)]
        player = _make_player()
        rng = random.Random(42)

        roll1 = _draw_archetype_market(cards, 3, rng, player)
        roll1_ids = {c.id for c in roll1}

        roll2 = _draw_archetype_market(cards, 3, rng, player)
        roll2_ids = {c.id for c in roll2}

        assert roll1_ids.isdisjoint(roll2_ids), (
            f"Roll 2 repeated cards from roll 1: {roll1_ids & roll2_ids}"
        )

    def test_no_repeats_across_many_rolls(self):
        """Consecutive rolls should never share cards (over many iterations)."""
        cards = [_make_card(f"c{i}") for i in range(12)]
        player = _make_player()
        rng = random.Random(123)

        prev_ids: set[str] = set()
        for _ in range(20):
            roll = _draw_archetype_market(cards, 3, rng, player)
            roll_ids = {c.id for c in roll}
            assert prev_ids.isdisjoint(roll_ids), (
                f"Consecutive repeat detected: {prev_ids & roll_ids}"
            )
            prev_ids = roll_ids

    def test_small_deck_relaxes_repeat_constraint(self):
        """With only 4 cards in the pool, some overlap is unavoidable — should not crash."""
        cards = [_make_card(f"c{i}") for i in range(4)]
        player = _make_player()
        rng = random.Random(99)

        roll1 = _draw_archetype_market(cards, 3, rng, player)
        assert len(roll1) == 3

        # Second roll must still return 3 cards even though overlap is forced
        roll2 = _draw_archetype_market(cards, 3, rng, player)
        assert len(roll2) == 3

    def test_deck_lte_count_returns_all(self):
        """If deck has <= 3 eligible cards, return all of them."""
        cards = [_make_card(f"c{i}") for i in range(2)]
        player = _make_player()
        rng = random.Random(1)

        roll = _draw_archetype_market(cards, 3, rng, player)
        assert len(roll) == 2
        assert {c.id for c in roll} == {"c0", "c1"}


# ---------------------------------------------------------------------------
# Heuristic 2: Affordability guarantee
# ---------------------------------------------------------------------------

class TestAffordabilityGuarantee:
    def test_player_with_resources_gets_affordable_card(self):
        """With resources >= 2, at least one card in the roll should be affordable."""
        # Mix of cheap and expensive cards
        cheap = [_make_card(f"cheap{i}", buy_cost=2) for i in range(3)]
        expensive = [_make_card(f"exp{i}", buy_cost=8) for i in range(9)]
        cards = cheap + expensive
        player = _make_player(resources=3)

        for seed in range(50):
            rng = random.Random(seed)
            player._prev_market_ids = []
            player._prev_market_types = []
            roll = _draw_archetype_market(cards, 3, rng, player)
            affordable = [c for c in roll if c.buy_cost is not None and c.buy_cost <= 3]
            assert len(affordable) >= 1, (
                f"Seed {seed}: no affordable card in roll {[c.id for c in roll]}"
            )

    def test_player_with_low_resources_no_guarantee(self):
        """With resources < 2, affordability guarantee does not apply."""
        expensive = [_make_card(f"exp{i}", buy_cost=5) for i in range(10)]
        player = _make_player(resources=1)
        rng = random.Random(42)

        # Should not crash — just returns random cards
        roll = _draw_archetype_market(expensive, 3, rng, player)
        assert len(roll) == 3

    def test_all_expensive_no_affordable_option(self):
        """If no card is affordable, still returns 3 cards without crashing."""
        expensive = [_make_card(f"exp{i}", buy_cost=10) for i in range(10)]
        player = _make_player(resources=3)
        rng = random.Random(42)

        roll = _draw_archetype_market(expensive, 3, rng, player)
        assert len(roll) == 3


# ---------------------------------------------------------------------------
# Heuristic 3: Type diversity correction after mono-type roll
# ---------------------------------------------------------------------------

class TestTypeDiversityCorrection:
    def test_after_monotype_next_roll_limits_that_type(self):
        """After a mono-type roll, the next roll should have at most 1 of that type."""
        claims = [_make_card(f"claim{i}", card_type=CardType.CLAIM) for i in range(6)]
        engines = [_make_card(f"eng{i}", card_type=CardType.ENGINE) for i in range(6)]
        cards = claims + engines
        player = _make_player()

        # Simulate a previous mono-type (all-claim) roll
        player._prev_market_ids = ["claim0", "claim1", "claim2"]
        player._prev_market_types = ["claim", "claim", "claim"]

        for seed in range(50):
            rng = random.Random(seed)
            # Reset prev IDs but keep prev types to test type correction
            player._prev_market_ids = ["claim0", "claim1", "claim2"]
            player._prev_market_types = ["claim", "claim", "claim"]
            roll = _draw_archetype_market(cards, 3, rng, player)
            claim_count = sum(1 for c in roll if c.card_type == CardType.CLAIM)
            assert claim_count <= 1, (
                f"Seed {seed}: {claim_count} claims after mono-claim roll"
            )

    def test_non_monotype_no_correction(self):
        """If previous roll was NOT mono-type, no type restriction applies."""
        claims = [_make_card(f"claim{i}", card_type=CardType.CLAIM) for i in range(8)]
        engines = [_make_card(f"eng{i}", card_type=CardType.ENGINE) for i in range(4)]
        cards = claims + engines
        player = _make_player()

        # Previous roll was mixed — no correction
        player._prev_market_ids = ["claim0", "eng0", "claim1"]
        player._prev_market_types = ["claim", "engine", "claim"]

        rng = random.Random(42)
        roll = _draw_archetype_market(cards, 3, rng, player)
        # Should return 3 cards without type restrictions
        assert len(roll) == 3

    def test_monotype_correction_with_limited_alternatives(self):
        """If there are very few non-oversaturated cards, allows up to 1 of that type."""
        claims = [_make_card(f"claim{i}", card_type=CardType.CLAIM) for i in range(8)]
        engines = [_make_card(f"eng{i}", card_type=CardType.ENGINE) for i in range(2)]
        cards = claims + engines
        player = _make_player()

        player._prev_market_ids = ["claim0", "claim1", "claim2"]
        player._prev_market_types = ["claim", "claim", "claim"]

        rng = random.Random(42)
        roll = _draw_archetype_market(cards, 3, rng, player)
        assert len(roll) == 3
        claim_count = sum(1 for c in roll if c.card_type == CardType.CLAIM)
        assert claim_count <= 1


# ---------------------------------------------------------------------------
# Heuristic 4 (was 5): Cost spread
# ---------------------------------------------------------------------------

class TestCostSpread:
    def test_monocost_resampled_when_variety_exists(self):
        """If all 3 cards have the same cost and variety exists, result should vary."""
        cost3 = [_make_card(f"c3_{i}", buy_cost=3) for i in range(5)]
        cost5 = [_make_card(f"c5_{i}", buy_cost=5) for i in range(5)]
        cards = cost3 + cost5
        player = _make_player()

        mono_cost_count = 0
        for seed in range(100):
            rng = random.Random(seed)
            player._prev_market_ids = []
            player._prev_market_types = []
            roll = _draw_archetype_market(cards, 3, rng, player)
            costs = {c.buy_cost for c in roll}
            if len(costs) == 1:
                mono_cost_count += 1

        # With the heuristic, mono-cost rolls should be rare (resample fixes most)
        # Without it, probability of mono-cost from a 50/50 pool is ~25%
        assert mono_cost_count < 15, (
            f"Too many mono-cost rolls: {mono_cost_count}/100"
        )

    def test_monocost_ok_when_only_one_cost_exists(self):
        """If all cards have the same cost, mono-cost is expected and fine."""
        cards = [_make_card(f"c{i}", buy_cost=3) for i in range(8)]
        player = _make_player()
        rng = random.Random(42)

        roll = _draw_archetype_market(cards, 3, rng, player)
        assert len(roll) == 3
        assert all(c.buy_cost == 3 for c in roll)


# ---------------------------------------------------------------------------
# General / edge cases
# ---------------------------------------------------------------------------

class TestSmartRollGeneral:
    def test_no_player_falls_back_to_pure_random(self):
        """Without a player, the function behaves like the original pure random."""
        cards = [_make_card(f"c{i}") for i in range(10)]
        rng = random.Random(42)

        roll = _draw_archetype_market(cards, 3, rng)
        assert len(roll) == 3

    def test_deterministic_with_same_seed(self):
        """Same seed and same state produce the same result."""
        cards = [_make_card(f"c{i}") for i in range(10)]

        for seed in [1, 42, 999]:
            p1 = _make_player()
            r1 = _draw_archetype_market(cards, 3, random.Random(seed), p1)

            p2 = _make_player()
            r2 = _draw_archetype_market(cards, 3, random.Random(seed), p2)

            assert [c.id for c in r1] == [c.id for c in r2], (
                f"Seed {seed}: non-deterministic results"
            )

    def test_excludes_non_buyable_cards(self):
        """Cards with buy_cost=None are never drawn."""
        buyable = [_make_card(f"buy{i}", buy_cost=3) for i in range(5)]
        unbuyable = [_make_card(f"free{i}", buy_cost=None) for i in range(5)]
        cards = buyable + unbuyable
        player = _make_player()
        rng = random.Random(42)

        roll = _draw_archetype_market(cards, 3, rng, player)
        for c in roll:
            assert c.buy_cost is not None

    def test_first_roll_no_constraints(self):
        """The very first roll (empty prev state) applies no constraints."""
        cards = [_make_card(f"c{i}") for i in range(10)]
        player = _make_player()
        assert player._prev_market_ids == []
        assert player._prev_market_types == []

        rng = random.Random(42)
        roll = _draw_archetype_market(cards, 3, rng, player)
        assert len(roll) == 3

        # After first roll, state should be populated
        assert len(player._prev_market_ids) == 3
        assert len(player._prev_market_types) == 3

    def test_state_cleared_allows_repeats(self):
        """After clearing prev state (simulating purchase), cards can repeat."""
        cards = [_make_card(f"c{i}") for i in range(6)]
        player = _make_player()
        rng = random.Random(42)

        roll1 = _draw_archetype_market(cards, 3, rng, player)
        roll1_ids = {c.id for c in roll1}

        # Clear state (simulates what happens after a purchase)
        player._prev_market_ids = []
        player._prev_market_types = []

        # Now cards from roll1 are eligible again
        roll2 = _draw_archetype_market(cards, 3, rng, player)
        assert len(roll2) == 3  # just verify it works; overlap is now allowed
