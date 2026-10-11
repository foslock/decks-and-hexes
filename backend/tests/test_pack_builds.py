"""Builds: the per-pack strategies the CPU knows (pack_builds.py), how a CPU
buys by one (cpu_builds.py), and which build each tier picks."""

from __future__ import annotations

import json

import pytest

from app.game_engine import cpu_builds
from app.game_engine.card_packs import CARD_PACKS
from app.game_engine.cpu_builds import (
    FAST_CLAIM,
    build_purchase,
    choose_build,
    fast_claim_purchase,
)
from app.game_engine.game_state import Phase, buy_card, create_game, execute_start_of_turn
from app.game_engine.hex_grid import GridSize
from app.game_engine.pack_builds import PACK_BUILDS, Build, builds_for, pack_builds

ARCHES = ["vanguard", "swarm", "fortress"]
REAL_PACKS = [p for p in CARD_PACKS.values() if not p.testing_only]


def _buy_phase_game(card_registry, pack="first_clash", archetype="vanguard", resources=0):
    game = create_game(GridSize.SMALL, [
        {"id": "p0", "name": "A", "archetype": archetype},
        {"id": "p1", "name": "B", "archetype": "swarm"},
    ], card_registry, seed=7, card_pack=pack)
    execute_start_of_turn(game)
    game.current_phase = Phase.BUY
    game.buy_phase_purchases = {}
    game.players["p0"].resources = resources
    return game


# ── The builds themselves ───────────────────────────────────────


@pytest.mark.parametrize("pack", REAL_PACKS, ids=lambda p: p.id)
def test_every_pack_has_builds_for_every_archetype(pack):
    builds = pack_builds(pack.id)
    assert len({b.id for b in builds}) == len(builds)
    for arch in ARCHES:
        own = [b for b in builds if b.archetype == arch]
        assert len(own) >= 2, f"{pack.id}: {arch} needs at least two builds of its own"


@pytest.mark.parametrize("pack", REAL_PACKS, ids=lambda p: p.id)
def test_builds_only_buy_cards_their_player_can_buy(card_registry, pack):
    for b in pack_builds(pack.id):
        allowed = set(pack.shared_card_ids or [])
        if b.archetype:
            allowed |= set((pack.archetype_card_ids or {})[b.archetype])
        assert b.plan, b.id
        for cid, copies in b.plan:
            assert cid in card_registry, (b.id, cid)
            assert cid in allowed, f"{pack.id}/{b.id}: {cid} isn't on offer to a {b.archetype or 'any'} player"
            assert copies >= 1
            if card_registry[cid].unique:
                assert copies == 1, f"{b.id}: {cid} is unique"


@pytest.mark.parametrize("pack", REAL_PACKS, ids=lambda p: p.id)
def test_builds_use_every_pack_card(pack):
    used = {cid for b in pack_builds(pack.id) for cid, _ in b.plan}
    every = set(pack.shared_card_ids or []) | {c for ids in (pack.archetype_card_ids or {}).values() for c in ids}
    assert every <= used, f"{pack.id}: no build uses {sorted(every - used)}"


def test_build_ratings_name_real_builds():
    ratings = cpu_builds.load_ratings()
    for pk, by_build in ratings.items():
        known = {b.id for b in PACK_BUILDS.get(pk, ())}
        assert set(by_build) <= known, f"{pk}: ratings for unknown builds {set(by_build) - known}"
        for grids in by_build.values():
            assert all(0.0 <= v <= 1.0 for v in grids.values())


# ── Buying by a build ───────────────────────────────────────────


def test_fast_claim_buys_the_claim_with_the_best_typical_power(card_registry):
    game = _buy_phase_game(card_registry, resources=9)
    p = game.players["p0"]
    assert fast_claim_purchase(game, p)["definition_id"] == "neutral_siege_tower"  # 6, less 1.5 for its Debt
    p.resources = 4
    # Rapid Assault (3) beats Blitz (2) and Mercenary (3, but it brings a Debt).
    assert fast_claim_purchase(game, p)["definition_id"] == "vanguard_rapid_assault"


def test_typical_power_counts_the_bonuses_fast_claim_usually_gets(card_registry):
    game = _buy_phase_game(card_registry, archetype="vanguard")
    typical = lambda cid: cpu_builds.typical_claim_power(game, "p0", card_registry[cid])  # noqa: E731
    assert typical("vanguard_strike_team") == 4      # +2: it plays more than one Claim
    assert typical("swarm_overwhelm") == 3           # +1 for each of ~2 owned neighbours
    assert typical("fortress_slow_advance") == 4     # +2 on neutral land
    assert typical("fortress_siege_engine") == 4     # +2 against defense, counted half
    assert typical("neutral_mercenary") == 1.5       # 3, less 1.5 for its Debt
    assert typical("swarm_surge") == 2.5             # a second tile


def test_fast_claim_never_saves(card_registry):
    game = _buy_phase_game(card_registry, resources=2)  # only Levy (power 1) is affordable
    assert fast_claim_purchase(game, game.players["p0"])["definition_id"] == "neutral_recruit"
    game.players["p0"].resources = 1
    assert fast_claim_purchase(game, game.players["p0"]) is None


def test_build_buys_its_list_in_order_up_to_its_copies(card_registry):
    game = _buy_phase_game(card_registry, resources=20)
    p = game.players["p0"]
    build = Build("t", "T", "vanguard", (("vanguard_double_time", 1), ("vanguard_strike_team", 2)))
    first = build_purchase(game, p, build)
    assert first["definition_id"] == "vanguard_double_time"
    assert buy_card(game, "p0", first["source"], first["card_id"])[0]
    # One copy of a card per round, and it already owns the 1 Double Time it wants.
    second = build_purchase(game, p, build)
    assert second["definition_id"] == "vanguard_strike_team"
    assert buy_card(game, "p0", second["source"], second["card_id"])[0]
    # Strike Team was bought this round; nothing else on the list: Fast Claim.
    third = build_purchase(game, p, build)
    assert third["definition_id"] == "neutral_siege_tower"


def test_build_skips_what_it_cant_afford_then_falls_back(card_registry):
    game = _buy_phase_game(card_registry, resources=4)
    build = Build("t", "T", "vanguard", (("vanguard_strike_team", 2),))  # costs 6
    assert build_purchase(game, game.players["p0"], build)["definition_id"] == "vanguard_rapid_assault"


def test_build_counts_copies_already_owned(card_registry):
    game = _buy_phase_game(card_registry, resources=20)
    p = game.players["p0"]
    p.deck.discard.append(card_registry["vanguard_double_time"])
    build = Build("t", "T", "vanguard", (("vanguard_double_time", 1), ("vanguard_blitz", 1)))
    assert build_purchase(game, p, build)["definition_id"] == "vanguard_blitz"


def test_build_buys_shared_cards(card_registry):
    game = _buy_phase_game(card_registry, resources=3)
    build = Build("t", "T", None, (("neutral_watchtower", 2),))
    pick = build_purchase(game, game.players["p0"], build)
    assert pick == {"source": "shared", "card_id": "neutral_watchtower", "definition_id": "neutral_watchtower"}


# ── Which build each tier follows ───────────────────────────────


@pytest.fixture
def fake_ratings(monkeypatch):
    def install(table):
        cpu_builds.load_ratings.cache_clear()
        monkeypatch.setattr(cpu_builds, "load_ratings", lambda: table)
    yield install


def test_hard_follows_the_best_rated_build_for_its_archetype(card_registry, fake_ratings):
    fake_ratings({"first_clash": {"shock_troops": {"large": 0.62}, "plunder": {"large": 0.71},
                                  "tidewatch": {"large": 0.95}}})  # Tidewatch is Swarm's
    game = _buy_phase_game(card_registry, archetype="vanguard")
    assert choose_build(game, "p0", "hard").id == "plunder"


def test_hard_plays_fast_claim_when_no_build_beats_it(card_registry, fake_ratings):
    fake_ratings({"first_clash": {b.id: {"large": 0.4} for b in pack_builds("first_clash")}})
    game = _buy_phase_game(card_registry, archetype="vanguard")
    assert choose_build(game, "p0", "hard") is FAST_CLAIM


def test_medium_picks_among_builds_that_beat_fast_claim(card_registry, fake_ratings):
    fake_ratings({"first_clash": {"shock_troops": {"large": 0.6}, "outpost_line": {"large": 0.3},
                                  "plunder": {"large": 0.56}}})
    picks = set()
    for seed in range(30):
        game = _buy_phase_game(card_registry, archetype="vanguard")
        game.id = f"g{seed}"
        picks.add(choose_build(game, "p0", "medium").id)
    assert picks == {"shock_troops", "plunder"}


def test_easy_plays_fast_claim_or_a_weaker_build(card_registry, fake_ratings):
    swarm = [b.id for b in builds_for("first_clash", "swarm")]
    ranked = {bid: 0.3 + 0.05 * i for i, bid in enumerate(swarm)}  # later = stronger
    fake_ratings({"first_clash": {bid: {"large": r} for bid, r in ranked.items()}})
    picks = set()
    for seed in range(60):
        game = _buy_phase_game(card_registry, archetype="swarm")
        game.id = f"g{seed}"
        picks.add(choose_build(game, "p0", "easy").id)
    weaker = set(swarm[:len(swarm) // 2])
    assert "fast_claim" in picks and len(picks) > 2
    assert picks <= {"fast_claim"} | weaker


def test_every_map_uses_the_2_player_large_ratings(card_registry, fake_ratings):
    fake_ratings({"first_clash": {"shock_troops": {"large": 0.7}, "plunder": {"large": 0.6}}})
    game = create_game(GridSize.MEDIUM, [
        {"id": f"p{i}", "name": str(i), "archetype": "vanguard"} for i in range(4)
    ], card_registry, seed=3, card_pack="first_clash")
    assert choose_build(game, "p0", "hard").id == "shock_troops"


def test_a_cpu_keeps_its_build_all_game(card_registry, fake_ratings):
    fake_ratings({"first_clash": {b.id: {"large": 0.6} for b in pack_builds("first_clash")}})
    game = _buy_phase_game(card_registry, archetype="fortress")
    first = choose_build(game, "p0", "medium")
    assert all(choose_build(game, "p0", "medium") is first for _ in range(5))


def test_packs_without_builds_buy_as_before(card_registry):
    game = _buy_phase_game(card_registry, pack="everything")
    assert choose_build(game, "p0", "hard") is None


def test_packs_without_ratings_buy_as_before(card_registry, fake_ratings):
    fake_ratings({"first_clash": {"shock_troops": {"large": 0.7}}})
    game = _buy_phase_game(card_registry, pack="border_war")
    assert all(choose_build(game, "p0", t) is None for t in ("easy", "medium", "hard"))


def test_ratings_file_is_json(tmp_path, monkeypatch):
    path = tmp_path / "r.json"
    path.write_text(json.dumps({"first_clash": {"tide": {"large": 0.5}}}))
    monkeypatch.setattr(cpu_builds, "RATINGS_PATH", path)
    cpu_builds.load_ratings.cache_clear()
    try:
        assert cpu_builds.build_rating("first_clash", "tide", "large") == 0.5
        assert cpu_builds.build_rating("first_clash", "tide", "medium") is None
    finally:
        cpu_builds.load_ratings.cache_clear()


def test_a_cpu_with_follow_builds_buys_by_its_build(card_registry, fake_ratings):
    import dataclasses
    from app.game_engine.cpu_player import CPUPlayer
    fake_ratings({"first_clash": {"shock_troops": {"large": 0.8}, "raiders": {"large": 0.6}}})
    game = _buy_phase_game(card_registry, archetype="vanguard", resources=4)
    cpu = CPUPlayer("p0", difficulty="hard")
    cpu.profile = dataclasses.replace(cpu.profile, follow_builds=True)
    pick = cpu.pick_next_purchase(game)
    assert pick["definition_id"] == "neutral_recruit"  # Shock Troops opens with Levies
    assert "ctx:build=shock_troops" in pick["cpu_reasoning"]["context"]


def test_every_tier_follows_builds():
    from app.game_engine.cpu_player import _profile_for
    assert all(_profile_for(t).follow_builds for t in ("easy", "medium", "hard"))
