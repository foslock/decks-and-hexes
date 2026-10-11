"""Card packs: four tuned 5 + 5 packs drawn from the Core set, Everything for
testing, and how a pack game's private archetype piles behave."""

from __future__ import annotations

from app.game_engine.card_packs import (
    ARCHETYPE_PER_PACK,
    CARD_PACKS,
    DEFAULT_PACK_ID,
    SHARED_PER_PACK,
)
from app.game_engine.cards import Archetype
from app.game_engine.game_state import (
    ARCHETYPE_PILE_SIZE,
    Phase,
    archetype_market_fixed,
    buy_card,
    create_game,
    execute_start_of_turn,
    reroll_market,
    shared_pile_size,
)
from app.game_engine.hex_grid import GridSize

REAL_PACKS = [p for p in CARD_PACKS.values() if not p.testing_only]

# Cards that do the same job. No player may see two from one group in a pack
# (their 5 archetype cards plus the 5 shared ones).
NEAR_DUPLICATES = {
    "one-tile defense": {"neutral_watchtower", "neutral_palisade", "fortress_fortify",
                         "vanguard_counterattack", "vanguard_rearguard", "swarm_nest"},
    "multi-tile defense": {"neutral_moat", "fortress_bulwark", "swarm_safety_in_numbers",
                           "fortress_aegis"},
    "permanent defense": {"neutral_fortified_post", "fortress_entrench", "fortress_citadel",
                          "fortress_master_engineer"},
    "immunity": {"fortress_iron_wall", "fortress_stronghold"},
    "resource cantrip": {"neutral_war_bonds", "fortress_supply_line", "fortress_iron_discipline",
                         "vanguard_war_cache", "swarm_scavenge"},
    "trash for value": {"neutral_reduce", "neutral_reclaim", "swarm_thin_the_herd",
                        "fortress_consolidate", "vanguard_arms_dealer"},
    "surround claim": {"neutral_militia", "swarm_overwhelm"},
    "claim anywhere": {"neutral_eminent_domain", "swarm_proliferate"},
    "multi-target claim": {"swarm_surge", "swarm_hive_mind"},
    "claim vs defense": {"fortress_siege_engine", "fortress_battering_ram", "neutral_conqueror"},
    "big claim": {"neutral_siege_tower", "vanguard_spearhead", "vanguard_elite_vanguard",
                  "vanguard_ultimatum"},
    "actions + a card": {"vanguard_double_time", "vanguard_surge_protocol",
                         "neutral_forced_march", "neutral_caravan"},
    "draw 2": {"neutral_conscription", "vanguard_rally", "fortress_war_council"},
    "search the discard": {"neutral_salvage", "neutral_recall", "fortress_stockroom",
                           "swarm_second_wave", "vanguard_mobilize_forces"},
}

ARCHETYPES = [a for a in Archetype if a != Archetype.SHARED]


def test_four_real_packs_first_clash_first_everything_last():
    ids = list(CARD_PACKS)
    assert len(REAL_PACKS) == 4
    assert ids[0] == "first_clash" == DEFAULT_PACK_ID
    assert ids[-1] == "everything" and CARD_PACKS["everything"].testing_only
    assert all(p.description for p in CARD_PACKS.values())


def test_each_pack_is_five_shared_and_five_per_archetype(card_registry):
    for pack in REAL_PACKS:
        shared = pack.shared_card_ids or []
        assert len(shared) == len(set(shared)) == SHARED_PER_PACK, pack.id
        for cid in shared:
            card = card_registry[cid]
            assert card.archetype == Archetype.SHARED and card.buy_cost is not None, (pack.id, cid)
            assert not card.starter, (pack.id, cid)
        assert pack.archetype_card_ids is not None
        assert set(pack.archetype_card_ids) == {a.value for a in ARCHETYPES}, pack.id
        for arch, ids in pack.archetype_card_ids.items():
            assert len(ids) == len(set(ids)) == ARCHETYPE_PER_PACK, (pack.id, arch)
            for cid in ids:
                card = card_registry[cid]
                assert card.archetype.value == arch and card.buy_cost is not None, (pack.id, cid)


def test_core_set_is_exactly_the_packs(card_registry):
    in_packs: set[str] = set()
    for pack in REAL_PACKS:
        in_packs.update(pack.shared_card_ids or [])
        for ids in (pack.archetype_card_ids or {}).values():
            in_packs.update(ids)
    core_buyable = {
        cid for cid, c in card_registry.items()
        if c.card_set == "core" and c.buy_cost is not None
    }
    assert core_buyable == in_packs
    assert {c.card_set for c in card_registry.values()} == {"core", "set_aside"}


def test_no_player_sees_two_near_duplicates_in_a_pack():
    for pack in REAL_PACKS:
        for arch, ids in (pack.archetype_card_ids or {}).items():
            seen = set(ids) | set(pack.shared_card_ids or [])
            for group, members in NEAR_DUPLICATES.items():
                hit = seen & members
                assert len(hit) <= 1, f"{pack.id} / {arch}: two {group} cards {sorted(hit)}"


def _pack_game(card_registry, players: int = 2):
    configs = [
        {"id": f"p{i}", "name": f"P{i}", "archetype": a.value}
        for i, a in zip(range(players), ARCHETYPES)
    ]
    game = create_game(GridSize.SMALL, configs, card_registry, seed=5, card_pack="first_clash")
    execute_start_of_turn(game)
    return game


def test_pack_game_shows_the_whole_archetype_supply(card_registry):
    game = _pack_game(card_registry)
    assert archetype_market_fixed(game)
    pack = CARD_PACKS["first_clash"]
    for p in game.players.values():
        ids = pack.archetype_card_ids[p.archetype.value]
        assert [c.definition_id for c in p.archetype_market] == ids
        assert len(p.archetype_deck) == ARCHETYPE_PILE_SIZE * len(ids)
    for stack in game.shared_market.stacks.values():
        assert len(stack) == shared_pile_size(2)


def test_pack_market_has_no_reroll_and_one_of_each_per_round(card_registry):
    game = _pack_game(card_registry)
    p = game.players["p0"]
    game.current_phase = Phase.BUY
    p.resources = 50
    ok, msg = reroll_market(game, "p0")
    assert not ok and p.resources == 50, msg
    card = p.archetype_market[0]
    ok, msg = buy_card(game, "p0", "archetype", card.id)
    assert ok, msg
    # The pile's next copy waits for next round.
    assert card.definition_id not in {c.definition_id for c in p.archetype_market}
    supply = {s["card"]["definition_id"]: s for s in game.to_dict(for_player_id="p0")["players"]["p0"]["archetype_supply"]}
    assert supply[card.definition_id]["remaining"] == ARCHETYPE_PILE_SIZE - 1
    assert supply[card.definition_id]["available"] is False
    assert all(s["available"] for d, s in supply.items() if d != card.definition_id)
    # Next round it's back.
    game.current_round += 1
    execute_start_of_turn(game)
    assert card.definition_id in {c.definition_id for c in p.archetype_market}


def test_everything_keeps_the_random_market(card_registry):
    configs = [{"id": "p0", "name": "A", "archetype": "vanguard"},
               {"id": "p1", "name": "B", "archetype": "swarm"}]
    game = create_game(GridSize.SMALL, configs, card_registry, seed=5, card_pack="everything")
    execute_start_of_turn(game)
    assert not archetype_market_fixed(game)
    assert len(game.players["p0"].archetype_market) == game.archetype_market_size
