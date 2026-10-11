"""Solo campaigns: level data, maps, one-player games, objectives and the API."""

from __future__ import annotations

from collections import deque
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.game_engine.cards import DEF_ID_DEBT, Card
from app.game_engine.game_state import (
    DEBT_START_ROUND,
    GameState,
    Phase,
    advance_resolve,
    archetype_market_fixed,
    auto_play_cpu_buys,
    auto_play_cpu_plays,
    compute_player_vp,
    create_game,
    execute_end_of_turn,
    execute_start_of_turn,
    execute_upkeep,
    reroll_market,
)
from app.game_engine.hex_grid import GridSize
from app.game_engine.solo import (
    BUILTIN_LEGEND,
    SOLO_PLAYER_ID,
    LevelError,
    Objective,
    SoloLevel,
    _parse_level,
    check_solo_objective,
    create_solo_game,
    load_campaign,
    needs_opponent,
    parse_layout,
    render_layout,
    starter_ceiling,
    UNTIMED_ROUND_GUARD,
)
from app.storage.serializer import deserialize_game, serialize_game

TINY = """\
    .
  .   .
.   *   .
  .   .
.   a   .
  .   .
    A
"""


def _level(registry: dict[str, Card], archetype: str = "vanguard", **over: Any) -> SoloLevel:
    data: dict[str, Any] = {
        "id": "test", "title": "Test",
        "objective": {"type": "vp", "vp": 3, "rounds": 4},
        "cards": {"pack": "first_clash"},
        "map": {"layout": TINY},
    }
    data.update(over)
    return _parse_level(data, registry, archetype)


def _all_levels(registry: dict[str, Card]) -> list[SoloLevel]:
    """Every level as each campaign plays it."""
    return [lv for camp in load_campaign(registry).campaigns.values() for lv in camp.levels]


def _play_to_end(game: GameState, max_steps: int = 400) -> None:
    """Every seat a CPU (yours too), round after round until game over."""
    for p in game.players.values():
        p.is_cpu = True
    for _ in range(max_steps):
        phase = game.current_phase
        if phase == Phase.GAME_OVER:
            return
        if phase == Phase.UPKEEP:
            execute_upkeep(game)
        elif phase == Phase.PLAY:
            auto_play_cpu_plays(game)
        elif phase == Phase.REVEAL:
            for pid in game.player_order:
                if not game.players[pid].has_acknowledged_resolve:
                    advance_resolve(game, pid)
        elif phase == Phase.BUY:
            auto_play_cpu_buys(game)
        else:
            raise AssertionError(f"stuck in {phase}")
    raise AssertionError("game never ended")


def _give_tiles(game: GameState, pid: str, count: int) -> None:
    """Hand `pid` up to `count` more plain tiles (no VP hexes)."""
    assert game.grid
    for tile in game.grid.tiles.values():
        if count <= 0:
            return
        if tile.owner is None and not tile.is_blocked and not tile.is_vp:
            tile.owner = pid
            count -= 1


# ── The data file ─────────────────────────────────────────────


class TestCampaignData:
    def test_loads(self, card_registry: dict[str, Card]) -> None:
        campaign = load_campaign(card_registry)
        assert set(campaign.campaigns) == {"vanguard", "swarm", "fortress"}
        castles = {camp.castle for camp in campaign.campaigns.values()}
        assert len(castles) == 3  # each starts in its own corner
        for camp in campaign.campaigns.values():
            assert len(camp.levels) >= 5
            assert all(lv.archetype == camp.archetype for lv in camp.levels)
            # The first levels are you alone; later ones bring rivals.
            assert not any(lv.bots for lv in camp.levels[:3]), camp.archetype
            assert any(lv.bots for lv in camp.levels)
            assert len(camp.segments) == len(camp.levels) + len(camp.soon)

    def test_every_campaign_runs_the_same_curve(self, card_registry: dict[str, Card]) -> None:
        """Ten levels: 1–3 alone, 8–10 with no time limit, and 10 against
        two hard rivals who start with more land than you."""
        for arch, camp in load_campaign(card_registry).campaigns.items():
            assert len(camp.levels) == 10, arch
            assert not any(lv.bots for lv in camp.levels[:3]), arch
            assert all(lv.objective.rounds is not None for lv in camp.levels[:7]), arch
            assert all(lv.objective.rounds is None and lv.bots for lv in camp.levels[7:]), arch
            final = camp.levels[-1]
            assert [b.difficulty for b in final.bots] == ["hard", "hard"], arch
            starts = {seat: sum(1 for k in final.tiles.values() if k.start == seat) for seat in range(3)}
            assert starts[1] > starts[0] and starts[2] > starts[0], arch

    def test_shared_levels_share_their_spot(self, card_registry: dict[str, Card]) -> None:
        campaign = load_campaign(card_registry)
        shared = [lv for lv in _all_levels(card_registry) if lv.shared_with]
        assert shared
        for lv in shared:
            for other_arch in lv.shared_with:
                other = campaign.level(other_arch, lv.id)
                assert other is not None and other.spot == lv.spot
                assert other.map_name == lv.map_name
                assert lv.archetype in other.shared_with

    def test_roads_join_up(self, card_registry: dict[str, Card]) -> None:
        campaign = load_campaign(card_registry)
        for camp in campaign.campaigns.values():
            here = camp.castle
            for lv, seg in zip(camp.levels, camp.segments):
                assert seg[-1] == lv.spot
                q, r = seg[0]
                assert max(abs(q - here[0]), abs(r - here[1]), abs(q + r - here[0] - here[1])) == 1
                assert all(not campaign.tiles[c] for c in seg)  # no mountains
                here = lv.spot

    def test_every_level_can_be_played_out(self, card_registry: dict[str, Card]) -> None:
        for level in _all_levels(card_registry):
            game = create_solo_game(level, card_registry, seed=1)
            assert len(game.players) == level.seats
            assert game.players[SOLO_PLAYER_ID].archetype.value == level.archetype
            execute_start_of_turn(game)
            _play_to_end(game)
            assert game.solo and game.solo["result"] in ("won", "lost"), level.id

    def test_maps_are_connected(self, card_registry: dict[str, Card]) -> None:
        """Every base and VP hex can be reached over land from yours, unless
        the level's cards claim across the water (Proliferate)."""
        for level in _all_levels(card_registry):
            land = {c for c, k in level.tiles.items() if not k.blocked}
            start = next(c for c, k in level.tiles.items() if k.base == 0)
            seen = {start}
            queue = deque([start])
            while queue:
                q, r = queue.popleft()
                for dq, dr in ((1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)):
                    n = (q + dq, r + dr)
                    if n in land and n not in seen:
                        seen.add(n)
                        queue.append(n)
            if "swarm_proliferate" in level.archetype_card_ids.get(level.archetype, []):
                continue
            assert all(c in seen for c, k in level.tiles.items() if k.base is not None), level.id
            assert all(c in seen for c, k in level.tiles.items() if k.vp), level.id

    def test_no_lonely_opponent_cards(self, card_registry: dict[str, Card]) -> None:
        for level in _all_levels(card_registry):
            if level.bots:
                continue
            ids = level.shared_card_ids + level.archetype_card_ids[level.archetype]
            assert not [c for c in ids if needs_opponent(card_registry[c])], level.id


# ── Maps ──────────────────────────────────────────────────────

    def test_no_level_falls_to_the_starting_deck(self, card_registry: dict[str, Card]) -> None:
        """Explore and Gather alone can never meet an objective: every map
        rings its start with land Explore can't take, and every hold-out
        asks for more tiles than that leaves."""
        for lv in _all_levels(card_registry):
            ceiling = starter_ceiling(lv, card_registry)
            assert ceiling.could_meet(lv.objective) is False, (
                f"{lv.archetype} {lv.id}: the starting deck can reach {ceiling} — "
                f"{lv.objective.describe(bool(lv.bots))}")


class TestStarterCeiling:
    WALLED = """\
    .
  .   .
.   *   .
  1   1
1   a   1
  .   .
    A
"""

    def test_open_land(self, card_registry: dict[str, Card]) -> None:
        # Everything but the VP hex (defense 2): 13 tiles, 4 VP.
        ceiling = starter_ceiling(_level(card_registry), card_registry)
        assert (ceiling.tiles, ceiling.vp, ceiling.vp_hexes) == (13, 4, 0)
        assert ceiling.could_meet(Objective(type="vp", rounds=4, vp=4)) is True

    def test_walled_in(self, card_registry: dict[str, Card]) -> None:
        level = _level(card_registry, map={"layout": self.WALLED})
        ceiling = starter_ceiling(level, card_registry)
        assert (ceiling.tiles, ceiling.vp) == (4, 1)  # base, start and the two below
        assert ceiling.could_meet(Objective(type="vp", rounds=4, vp=2)) is False
        assert ceiling.could_meet(Objective(type="territory", rounds=4, tiles=5)) is False
        assert ceiling.could_meet(Objective(type="territory", rounds=4, tiles=4)) is True
        # A hold-out is the map's to decide only with a tile count.
        assert ceiling.could_meet(Objective(type="survive", rounds=4)) is None
        assert ceiling.could_meet(Objective(type="survive", rounds=4, tiles=5)) is False
        assert ceiling.could_meet(Objective(type="raid", rounds=4)) is False

    def test_open_vp_hexes_count(self, card_registry: dict[str, Card]) -> None:
        level = _level(card_registry, map={"layout": TINY, "legend": {"*": {"vp": 1, "defense": 0}}})
        ceiling = starter_ceiling(level, card_registry)
        assert (ceiling.tiles, ceiling.vp, ceiling.vp_hexes) == (14, 5, 1)


class TestMaps:
    def test_layout_round_trips(self) -> None:
        tiles = parse_layout(TINY, dict(BUILTIN_LEGEND), "t")
        assert len(tiles) == 14
        base = next(c for c, k in tiles.items() if k.base == 0)
        start = next(c for c, k in tiles.items() if k.start == 0)
        # The starting tile sits right above the base.
        assert (start[0] - base[0], start[1] - base[1]) == (0, -1)
        chars = {c: ("A" if k.base == 0 else "a" if k.start == 0 else "*" if k.vp else ".") for c, k in tiles.items()}
        again = parse_layout(render_layout(chars), dict(BUILTIN_LEGEND), "t")
        assert {c: (k.base, k.start, k.vp) for c, k in again.items()} == {c: (k.base, k.start, k.vp) for c, k in tiles.items()}

    def test_shifted_picture_is_the_same_map(self) -> None:
        shifted = "\n" + "\n".join("   " + line for line in TINY.splitlines())
        a = parse_layout(TINY, dict(BUILTIN_LEGEND), "t")
        b = parse_layout(shifted, dict(BUILTIN_LEGEND), "t")
        assert sorted(a) == sorted(b)

    def test_off_grid_tile(self) -> None:
        with pytest.raises(LevelError, match="off the grid"):
            parse_layout(".   .\n .", dict(BUILTIN_LEGEND), "t")
        with pytest.raises(LevelError, match="off the grid"):
            parse_layout(".   .\n    .", dict(BUILTIN_LEGEND), "t")

    def test_unknown_character(self) -> None:
        with pytest.raises(LevelError, match="unknown tile"):
            parse_layout(".   ?", dict(BUILTIN_LEGEND), "t")

    def test_grid_from_layout(self, card_registry: dict[str, Card]) -> None:
        level = _level(card_registry, map={"layout": TINY, "legend": {"v": {"vp": 3, "defense": 4}}})
        grid = level.build_grid()
        vp = [t for t in grid.tiles.values() if t.is_vp]
        assert len(vp) == 1 and vp[0].vp_value == 1 and vp[0].base_defense == 2
        assert len(grid.starting_positions) == 1 and len(grid.starting_positions[0]) == 2

    def test_legend_and_overrides(self, card_registry: dict[str, Card]) -> None:
        art = TINY.replace("*", "v")
        plain = _level(card_registry, map={"layout": art, "legend": {"v": {"vp": 3, "defense": 4}}})
        vp = next(c for c, k in plain.tiles.items() if k.vp)
        assert plain.tiles[vp].vp == 3 and plain.tiles[vp].effective_defense == 4
        land = [c for c, k in plain.tiles.items() if not k.vp and k.base is None and k.start is None]
        level = _level(card_registry, map={
            "layout": art, "legend": {"v": {"vp": 3, "defense": 4}},
            "overrides": {f"{land[0][0]},{land[0][1]}": "#", f"{land[1][0]},{land[1][1]}": " ",
                          f"{vp[0]},{vp[1]}": {"vp": 2, "defense": 5}},
        })
        assert level.tiles[land[0]].blocked
        assert land[1] not in level.tiles
        assert level.tiles[vp].vp == 2 and level.tiles[vp].effective_defense == 5

    def test_preset_map_with_bots(self, card_registry: dict[str, Card]) -> None:
        level = _level(
            card_registry, map={"preset": "small", "overrides": {"0,0": {"vp": 3}}},
            bots=[{"archetype": "swarm", "difficulty": "easy"}],
        )
        grid = level.build_grid()
        assert len(grid.tiles) == 61
        assert grid.tiles["0,0"].vp_value == 3
        assert len(grid.starting_positions) == 2

    def test_missing_base(self, card_registry: dict[str, Card]) -> None:
        with pytest.raises(LevelError, match="no A"):
            _level(card_registry, map={"layout": TINY.replace("A", ".")})

    def test_bot_needs_a_base(self, card_registry: dict[str, Card]) -> None:
        with pytest.raises(LevelError, match="a base for bot 1"):
            _level(card_registry, bots=[{"archetype": "swarm"}])

    def test_seats(self, card_registry: dict[str, Card]) -> None:
        """You take your seat's base; bots fill the others in letter order;
        bases nobody takes are plain land."""
        art = TINY.replace("    .\n  .   .\n", "    C\n  c   B\n", 1)
        bot = [{"archetype": "swarm"}]
        mine = _level(card_registry, map={"layout": art}, bots=bot)              # you A, bot B
        theirs = _level(card_registry, map={"layout": art}, bots=bot, seat="C")  # you C, bot A

        def base(lv: SoloLevel, seat: int) -> tuple[int, int]:
            return next(c for c, k in lv.tiles.items() if k.base == seat)

        a, b, c = base(mine, 0), base(mine, 1), base(theirs, 0)
        assert len({a, b, c}) == 3
        assert base(theirs, 1) == a
        assert mine.tiles[c].base is None and theirs.tiles[b].base is None
        # Starting land follows its base: C's is yours, A's the bot's.
        assert [xy for xy, k in theirs.tiles.items() if k.start == 1] == [
            xy for xy, k in mine.tiles.items() if k.start == 0]
        assert not [k for k in mine.tiles.values() if k.start == 1]
        with pytest.raises(LevelError, match="no D"):
            _level(card_registry, map={"layout": art}, bots=bot, seat="D")

    def test_campaign_file(self, card_registry: dict[str, Card], tmp_path: Any) -> None:
        """A small campaigns file: castles, spots, variants, roads."""
        path = tmp_path / "solo.yaml"
        path.write_text("""
overworld:
  layout: |2
    .   .   .   .
      .   b   .
    .   #   .   .
      a   .   c
    .   V   .   S
      F   .   .
campaigns:
  vanguard: {title: V, levels: [one, both]}
  swarm: {title: S, levels: [both], soon: [c]}
  fortress: {title: F, levels: [one]}
levels:
  - id: one
    spot: a
    objective: {type: vp, vp: 3, rounds: 4}
    cards: {pack: first_clash}
    map:
      layout: |2
            .
          .   .
        .   a   .
          .   .
            A
  - id: both
    spot: b
    cards: {pack: first_clash}
    map:
      layout: |2
            B
          b   .
        .   .   .
          a   .
            A
    variants:
      vanguard:
        title: Attack
        objective: {type: raid, rounds: 6}
        bots: [{archetype: swarm}]
      swarm:
        title: Defend
        seat: B
        objective: {type: survive, rounds: 6}
        bots: [{archetype: vanguard, difficulty: hard}]
""")
        campaign = load_campaign(card_registry, path)
        v, s_ = campaign.campaigns["vanguard"], campaign.campaigns["swarm"]
        assert [lv.id for lv in v.levels] == ["one", "both"]
        attack, defend = v.level("both"), s_.level("both")
        assert attack and defend
        assert (attack.title, defend.title) == ("Attack", "Defend")
        assert attack.spot == defend.spot and attack.shared_with == ["swarm"]
        assert attack.archetype == "vanguard" and defend.archetype == "swarm"
        assert defend.objective.type == "survive"
        # Swarm sits on B: its base is the other end of the map.
        mine = next(c for c, k in attack.tiles.items() if k.base == 0)
        theirs = next(c for c, k in defend.tiles.items() if k.base == 0)
        assert mine != theirs
        assert len(s_.segments) == 2 and s_.segments[-1][-1] == s_.soon[0]
        assert "one" not in [lv.id for lv in s_.levels]
        assert campaign.level("fortress", "both") is None

        bad = path.read_text()
        for broken, message in [
            (bad.replace("swarm: {title: S, levels: [both], soon: [c]}", "swarm: {title: S, levels: [one]}"),
             "a swarm variant"),
            (bad.replace("levels: [one, both]}", "levels: [one]}").replace("levels: [both], soon: [c]}", "levels: [one]}"),
             "in no campaign"),
            (bad.replace("spot: b", "spot: a"), "another level is on spot"),
            (bad.replace("spot: b", "spot: z"), "isn't on the overworld"),
            (bad.replace("      vanguard:\n        title: Attack", "      vanguard:\n        map: {}\n        title: Attack"),
             "can't change"),
        ]:
            path.write_text(broken)
            with pytest.raises(LevelError, match=message):
                load_campaign(card_registry, path)


# ── Cards ─────────────────────────────────────────────────────


class TestCards:
    def test_pack_pool(self, card_registry: dict[str, Card]) -> None:
        level = _level(card_registry)
        game = create_solo_game(level, card_registry, seed=3)
        execute_start_of_turn(game)
        me = game.players[SOLO_PLAYER_ID]
        assert archetype_market_fixed(game)
        assert {c.definition_id for c in me.archetype_market} == set(level.archetype_card_ids["vanguard"])
        assert set(game.shared_market.stacks) == set(level.shared_card_ids)

    def test_custom_pool_with_set_aside_cards(self, card_registry: dict[str, Card]) -> None:
        aside = [c.id for c in card_registry.values()
                 if c.archetype.value == "vanguard" and c.card_set != "core" and not c.starter
                 and c.buy_cost is not None and not needs_opponent(c)][:3]
        assert aside
        level = _level(card_registry, cards={"pack": "first_clash", "vanguard": aside})
        assert level.pack_id is None
        game = create_solo_game(level, card_registry, seed=3)
        execute_start_of_turn(game)
        assert {c.definition_id for c in game.players[SOLO_PLAYER_ID].archetype_market} == set(aside)

    def test_random_market(self, card_registry: dict[str, Card]) -> None:
        level = _level(card_registry, "swarm", market="random", market_size=2,
                       cards={"pack": "first_clash", "swarm": "core"})
        game = create_solo_game(level, card_registry, seed=5)
        execute_start_of_turn(game)
        me = game.players[SOLO_PLAYER_ID]
        assert not archetype_market_fixed(game)
        assert len(me.archetype_market) == 2
        assert {c.definition_id for c in me.archetype_deck} == set(level.archetype_card_ids["swarm"])
        me.resources = 5
        execute_upkeep(game)
        game.current_phase = Phase.BUY
        ok, _ = reroll_market(game, SOLO_PLAYER_ID)
        assert ok

    def test_opponent_cards_need_bots(self, card_registry: dict[str, Card]) -> None:
        lonely = next(c.id for c in card_registry.values()
                      if c.archetype.value == "shared" and needs_opponent(c) and c.buy_cost is not None)
        with pytest.raises(LevelError, match="target an opponent"):
            _level(card_registry, cards={"pack": "first_clash", "shared": [lonely]})

    def test_unknown_card(self, card_registry: dict[str, Card]) -> None:
        with pytest.raises(LevelError, match="unknown card"):
            _level(card_registry, cards={"pack": "first_clash", "shared": ["neutral_nope"]})


# ── One-player games ──────────────────────────────────────────


class TestOnePlayer:
    def test_alone_never_gets_debt(self, card_registry: dict[str, Card]) -> None:
        level = _level(card_registry, "fortress", objective={"type": "vp", "vp": 999, "rounds": DEBT_START_ROUND + 2})
        game = create_solo_game(level, card_registry, seed=7)
        execute_start_of_turn(game)
        _play_to_end(game)
        me = game.players[SOLO_PLAYER_ID]
        cards = me.deck.cards + me.deck.discard + me.hand + me.trash
        assert game.current_round == DEBT_START_ROUND + 2
        assert not [c for c in cards if c.definition_id == DEF_ID_DEBT]

    def test_one_player_regular_game(self, card_registry: dict[str, Card]) -> None:
        """create_game with one player (no solo level) runs to its round limit."""
        game = create_game(GridSize.SMALL, [{"id": "p0", "archetype": "swarm"}], card_registry,
                           seed=2, max_rounds=6, vp_target=999)
        execute_start_of_turn(game)
        _play_to_end(game)
        assert game.winner == "p0"
        assert game.current_round == 6

    def test_debt_with_bots_follows_the_level(self, card_registry: dict[str, Card]) -> None:
        bot_map = TINY.replace("    .\n  .   .\n", "    B\n  b   .\n", 1)
        for debt, expect in ((True, True), (False, False)):
            level = _level(card_registry, map={"layout": bot_map}, debt=debt,
                           bots=[{"archetype": "swarm"}],
                           objective={"type": "vp", "vp": 999, "rounds": 9})
            game = create_solo_game(level, card_registry, seed=1)
            game.current_round = DEBT_START_ROUND
            execute_start_of_turn(game)
            got = any(
                c.definition_id == DEF_ID_DEBT
                for p in game.players.values() for c in p.deck.discard
            )
            assert got == expect


# ── Objectives ────────────────────────────────────────────────


def _bot_game(card_registry: dict[str, Card], **obj: Any) -> GameState:
    big = "\n".join([
        "    B   .   .   .",
        "  .   b   .   .",
        ".   .   .   .   .",
        "  .   .   .   .",
        ".   .   .   .   .",
        "  .   .   .   .",
        ".   .   .   .   .",
        "  .   .   .   .",
        ".   .   .   .   .",
        "  .   .   a   .",
        "    .   .   A",
    ])
    level = _level(card_registry, map={"layout": big}, bots=[{"archetype": "swarm", "name": "Rival"}],
                   objective={"type": "vp", "vp": 4, "rounds": 6, **obj})
    game = create_solo_game(level, card_registry, seed=11)
    execute_start_of_turn(game)
    return game


class TestObjectives:
    def test_win(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry)
        _give_tiles(game, SOLO_PLAYER_ID, 12)
        assert compute_player_vp(game, SOLO_PLAYER_ID) >= 4
        execute_end_of_turn(game)
        assert game.current_phase == Phase.GAME_OVER
        assert game.solo and game.solo["result"] == "won"
        assert game.winners == [SOLO_PLAYER_ID]
        over = [e for e in game.game_log if e.event_type == "game_over"]
        assert over and over[-1].data["reason"] == "solo_objective"
        assert game.to_dict()["solo"]["result"] == "won"

    def test_undecided_goes_on(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry)
        execute_end_of_turn(game)
        assert game.current_phase != Phase.GAME_OVER
        assert game.current_round == 2
        assert game.solo and game.solo["result"] is None

    def test_out_of_rounds(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry)
        game.current_round = 6
        execute_end_of_turn(game)
        assert game.current_phase == Phase.GAME_OVER
        assert game.solo and game.solo["result"] == "lost"
        assert "Round 6 ended" in game.solo["reason"]
        assert game.winners == []

    def test_bot_first(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry, bot_vp=5)
        bot = game.player_order[1]
        _give_tiles(game, bot, 14)
        assert compute_player_vp(game, bot) >= 5
        execute_end_of_turn(game)
        assert game.solo and game.solo["result"] == "lost"
        assert game.winners == [bot]
        assert "Rival reached 5 VP first" in game.solo["reason"]

    def test_bot_short_of_its_own_target(self, card_registry: dict[str, Card]) -> None:
        """A bot past your target but short of bot_vp doesn't end the game."""
        game = _bot_game(card_registry, bot_vp=9)
        _give_tiles(game, game.player_order[1], 14)
        assert check_solo_objective(game) is False
        execute_end_of_turn(game)
        assert game.current_phase != Phase.GAME_OVER

    def test_same_round_tie_break(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry)
        bot = game.player_order[1]
        _give_tiles(game, SOLO_PLAYER_ID, 12)
        _give_tiles(game, bot, 18)  # more VP than you
        execute_end_of_turn(game)
        assert game.solo and game.solo["result"] == "lost"
        assert game.winners == [bot]

    def test_survives_a_save(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry)
        again = deserialize_game(serialize_game(game), card_registry)
        assert again.solo == game.solo
        _give_tiles(again, SOLO_PLAYER_ID, 12)
        execute_end_of_turn(again)
        assert again.solo and again.solo["result"] == "won"

    def test_a_won_round_skips_its_buy_phase(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry)
        game.current_phase = Phase.REVEAL
        _give_tiles(game, SOLO_PLAYER_ID, 12)
        assert advance_resolve(game, SOLO_PLAYER_ID)[0]
        assert game.current_phase == Phase.GAME_OVER
        assert game.solo and game.solo["result"] == "won" and game.winners == [SOLO_PLAYER_ID]
        assert any("no buy phase" in e.message for e in game.game_log)

    def test_an_undecided_round_still_buys(self, card_registry: dict[str, Card]) -> None:
        game = _bot_game(card_registry)
        game.current_phase = Phase.REVEAL
        assert advance_resolve(game, SOLO_PLAYER_ID)[0]
        assert game.current_phase == Phase.BUY
        assert game.solo and game.solo["result"] is None

    def test_a_held_out_last_round_skips_its_buy_phase(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "survive", "rounds": 3}, bots=2)
        game.current_round = 2
        game.current_phase = Phase.REVEAL
        assert advance_resolve(game, SOLO_PLAYER_ID)[0]
        assert game.current_phase == Phase.BUY  # a round to go
        game.current_round = 3
        game.current_phase = Phase.REVEAL
        game.players[SOLO_PLAYER_ID].has_acknowledged_resolve = False
        assert advance_resolve(game, SOLO_PLAYER_ID)[0]
        assert game.solo and game.solo["result"] == "won"


# ── API ───────────────────────────────────────────────────────


@pytest.fixture
def client() -> Any:
    from app.main import app

    with TestClient(app) as c:
        yield c


class TestSoloApi:
    def test_list_campaigns(self, client: TestClient) -> None:
        data = client.get("/api/solo/levels").json()
        tiles = data["overworld"]["tiles"]
        camps = {c["archetype"]: c for c in data["campaigns"]}
        assert set(camps) == {"vanguard", "swarm", "fortress"}
        for camp in camps.values():
            assert camp["castle"] in tiles
            assert len(camp["segments"]) == len(camp["spots"]) + len(camp["soon"])
            assert [lv["spot"] for lv in camp["levels"]] == camp["spots"]
            assert all(lv["archetype"] == camp["archetype"] for lv in camp["levels"])
            assert camp["levels"][0]["objective"]["text"]

    def test_level_map(self, client: TestClient) -> None:
        camp = client.get("/api/solo/levels").json()["campaigns"][0]
        lv = next(lv for lv in camp["levels"] if lv["bots"])
        data = client.get(f"/api/solo/levels/{lv['id']}/map", params={"archetype": camp["archetype"]}).json()
        bases = [t for t in data["tiles"].values() if t["is_base"]]
        assert sorted(b["base_owner"] for b in bases) == data["seats"]
        assert data["players"][0] == {"id": SOLO_PLAYER_ID, "name": "You", "archetype": camp["archetype"],
                                      "color": data["players"][0]["color"]}
        assert len(data["players"]) == 1 + len(lv["bots"])
        assert client.get("/api/solo/levels/nope/map", params={"archetype": "swarm"}).status_code == 404
        assert client.get(f"/api/solo/levels/{lv['id']}/map").status_code == 422  # which campaign?

    def test_shared_level_from_both_sides(self, client: TestClient) -> None:
        camps = client.get("/api/solo/levels").json()["campaigns"]
        by = {c["archetype"]: {lv["id"]: lv for lv in c["levels"]} for c in camps}
        lid, arch = next((lid, a) for a, lvs in by.items() for lid, lv in lvs.items() if lv["shared_with"])
        other = by[arch][lid]["shared_with"][0]
        mine = client.get(f"/api/solo/levels/{lid}/map", params={"archetype": arch}).json()
        theirs = client.get(f"/api/solo/levels/{lid}/map", params={"archetype": other}).json()
        assert by[arch][lid]["spot"] == by[other][lid]["spot"]

        def my_base(m: dict[str, Any]) -> str:
            return next(k for k, t in m["tiles"].items() if t["is_base"] and t["base_owner"] == SOLO_PLAYER_ID)

        assert set(mine["tiles"]) == set(theirs["tiles"])  # the same map
        assert by[arch][lid]["objective"]["type"] != by[other][lid]["objective"]["type"] or my_base(mine) != my_base(theirs)

    def test_start_and_play_over_the_websocket(self, client: TestClient) -> None:
        camps = client.get("/api/solo/levels").json()["campaigns"]
        camp, with_bots = next((c, lv) for c in camps for lv in c["levels"] if lv["bots"])
        resp = client.post(f"/api/solo/levels/{with_bots['id']}/start",
                           json={"archetype": camp["archetype"], "name": "Tester"})
        assert resp.status_code == 200, resp.text
        start = resp.json()
        state = start["state"]
        assert state["solo"]["level_id"] == with_bots["id"]
        assert state["solo"]["campaign"] == camp["archetype"]
        assert state["players"][SOLO_PLAYER_ID]["archetype"] == camp["archetype"]
        assert len(state["players"]) == 1 + len(with_bots["bots"])
        # Bots' hands are hidden from you, as in a lobby game.
        bot = state["player_order"][1]
        assert state["players"][bot]["hand"] == [] or state["players"][bot].get("hand_hidden", True)
        # The game's WebSocket runs on the private lobby.
        url = f"/api/lobby/ws/{start['lobby_code']}?player_id={start['player_id']}&token={start['token']}"
        with client.websocket_connect(url) as ws:
            msg = ws.receive_json()
            assert msg["type"] == "game_state"
            assert msg["state"]["id"] == start["game_id"]
        # Not listed in the lobby browser.
        browse = client.get("/api/lobby/browse").json()
        assert all(g["code"] != start["lobby_code"] for g in browse["in_progress"] + browse["open"])
        # Play a turn through the ordinary routes.
        gid = start["game_id"]
        assert client.post(f"/api/games/{gid}/advance-upkeep").status_code == 200
        r = client.post(f"/api/games/{gid}/submit-play", json={"player_id": SOLO_PLAYER_ID})
        assert r.status_code == 200, r.text
        assert r.json()["state"]["current_phase"] in ("reveal", "buy")

    def test_start_needs_the_level_in_that_campaign(self, client: TestClient) -> None:
        camps = {c["archetype"]: c for c in client.get("/api/solo/levels").json()["campaigns"]}
        only_vanguard = next(lv["id"] for lv in camps["vanguard"]["levels"] if not lv["shared_with"])
        assert client.post(f"/api/solo/levels/{only_vanguard}/start", json={"archetype": "pirate"}).status_code == 400
        assert client.post(f"/api/solo/levels/{only_vanguard}/start", json={"archetype": "swarm"}).status_code == 404
        assert client.post("/api/solo/levels/nope/start", json={"archetype": "swarm"}).status_code == 404


# ── Other objectives ──────────────────────────────────────────


TWO_BOTS = "\n".join([
    "    B   .   C",
    "  b   .   c",
    ".   *   .   .",
    "  .   .   .",
    ".   .   *   .",
    "  .   a   .",
    "    .   A",
])


def _objective_game(card_registry: dict[str, Card], objective: dict[str, Any], bots: int = 0) -> GameState:
    layout = TWO_BOTS if bots else TINY
    if bots == 0:
        level = _level(card_registry, map={"layout": layout}, objective=objective)
    else:
        level = _level(card_registry, map={"layout": layout}, objective=objective,
                       bots=[{"archetype": "swarm", "name": "Left"}, {"archetype": "fortress", "name": "Right"}])
    game = create_solo_game(level, card_registry, seed=4)
    execute_start_of_turn(game)
    return game


def _raid(game: GameState, target: str) -> None:
    """What a successful raid on `target`'s base leaves in the round's effects."""
    game.player_effects.append({
        "source_player_id": SOLO_PLAYER_ID, "target_player_id": target,
        "effect_type": "base_raid_rubble", "card_name": "Raided",
    })


class TestObjectiveTypes:
    def test_territory_share(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "territory", "share": 0.5, "rounds": 5})
        assert game.solo
        obj = game.solo["objective"]
        land = 14
        assert obj["land"] == land and obj["tiles"] == land // 2 + 1
        assert "more than half" in obj["goal"]
        _give_tiles(game, SOLO_PLAYER_ID, obj["tiles"] - 3)  # you start with 2
        execute_end_of_turn(game)
        assert game.solo["result"] is None
        _give_tiles(game, SOLO_PLAYER_ID, 1)
        execute_end_of_turn(game)
        assert game.solo["result"] == "won"

    def test_territory_tiles(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "territory", "tiles": 5, "rounds": 1})
        assert game.to_dict()["solo"]["progress"] == {
            "value": 2, "target": 5, "unit": "tiles", "met": False, "failed": False, "detail": None}
        execute_end_of_turn(game)
        assert game.solo and game.solo["result"] == "lost"
        assert "2 of 5 tiles" in game.solo["reason"]

    def test_vp_hexes(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "vp_hexes", "rounds": 5}, bots=2)
        assert game.grid and game.solo
        towns = [t for t in game.grid.tiles.values() if t.is_vp]
        assert game.solo["objective"]["count"] == len(towns) == 2
        towns[0].owner = SOLO_PLAYER_ID
        execute_end_of_turn(game)
        assert game.solo["result"] is None
        towns[1].owner = SOLO_PLAYER_ID
        execute_end_of_turn(game)
        assert game.solo["result"] == "won"

    def test_vp_hexes_connected(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "vp_hexes", "connected": True, "rounds": 5})
        assert game.grid and game.solo
        town = next(t for t in game.grid.tiles.values() if t.is_vp)
        town.owner = SOLO_PLAYER_ID
        start = next(t for t in game.grid.tiles.values() if t.owner == SOLO_PLAYER_ID and not t.is_base and not t.is_vp)
        start.owner = None  # the town's only link to your base
        assert game.to_dict()["solo"]["progress"]["value"] == 0
        for t in game.grid.tiles.values():  # the whole island: linked
            if not t.is_blocked and t.owner is None:
                t.owner = SOLO_PLAYER_ID
        execute_end_of_turn(game)
        assert game.solo["result"] == "won"

    def test_raid_every_rival(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "raid", "rounds": 5}, bots=2)
        assert game.solo
        left, right = game.player_order[1:]
        assert game.solo["objective"]["goal"] == "Raid both rivals' bases"
        _raid(game, left)
        execute_end_of_turn(game)
        assert game.solo["result"] is None and game.solo["raided"] == [left]
        # Raids count across rounds (the round's effects are cleared at the next reveal).
        game.player_effects = []
        _raid(game, right)
        execute_end_of_turn(game)
        assert game.solo["result"] == "won"

    def test_a_raid_on_you_doesnt_count(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "raid", "rounds": 5}, bots=2)
        game.player_effects.append({
            "source_player_id": game.player_order[1], "target_player_id": SOLO_PLAYER_ID,
            "effect_type": "base_raid_rubble",
        })
        execute_end_of_turn(game)
        assert game.solo and game.solo["raided"] == []

    def _step(self, game: GameState, prev: str, winner: str) -> None:
        """What a tile changing hands leaves in the round's resolution steps."""
        game.resolution_steps.append({
            "previous_owner": prev, "winner_id": winner, "outcome": "claimed", "is_base_raid": False,
        })

    def test_capture(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "capture", "tiles": 3, "rounds": 5}, bots=2)
        assert game.solo
        left, right = game.player_order[1:]
        assert game.solo["objective"]["goal"] == "Take 3 tiles from your rivals"
        self._step(game, left, SOLO_PLAYER_ID)
        self._step(game, None, SOLO_PLAYER_ID)          # open land doesn't count  # type: ignore[arg-type]
        self._step(game, SOLO_PLAYER_ID, right)         # nor losing one
        game.current_phase = Phase.BUY                  # shows live once the reveal is done
        assert game.to_dict()["solo"]["progress"]["value"] == 1
        execute_end_of_turn(game)
        assert game.solo["captured"] == 1 and game.solo["result"] is None
        # Next round's play phase: last round's steps are still there, not counted twice.
        assert game.to_dict()["solo"]["progress"]["value"] == 1
        game.resolution_steps = []
        self._step(game, right, SOLO_PLAYER_ID)
        self._step(game, left, SOLO_PLAYER_ID)
        execute_end_of_turn(game)
        assert game.solo["result"] == "won"

    def test_fortify(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "fortify", "tiles": 2, "defense": 4, "rounds": 5})
        assert game.grid and game.solo
        mine = [t for t in game.grid.tiles.values() if t.owner == SOLO_PLAYER_ID and not t.is_base]
        town = next(t for t in game.grid.tiles.values() if t.is_vp)
        town.owner = SOLO_PLAYER_ID
        town.permanent_defense_bonus = 2       # 2 + 2
        mine[0].permanent_defense_bonus = 2    # 0 + 2: not enough
        execute_end_of_turn(game)
        assert game.solo["result"] is None
        mine[0].permanent_defense_bonus = 4
        execute_end_of_turn(game)
        assert game.solo["result"] == "won"
        assert "Fortify 2 tiles to defense 4" in game.solo["objective"]["goal"]

    def test_survive_to_the_end(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "survive", "rounds": 3, "tiles_lost_max": 1}, bots=2)
        assert game.solo
        assert game.to_dict()["solo"]["progress"]["value"] == 0
        execute_end_of_turn(game)
        assert game.solo["result"] is None and game.current_round == 2
        assert game.to_dict()["solo"]["progress"]["value"] == 1      # one round held
        self._step(game, SOLO_PLAYER_ID, game.player_order[1])       # one tile lost: allowed
        game.current_phase = Phase.BUY
        assert "1 of 1 tiles lost" in game.to_dict()["solo"]["progress"]["detail"]
        execute_end_of_turn(game)
        game.resolution_steps = []
        execute_end_of_turn(game)
        assert game.solo["result"] == "won" and game.winners == [SOLO_PLAYER_ID]

    def test_survive_raided(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "survive", "rounds": 5, "raids_allowed": 1}, bots=2)
        assert game.solo
        attacker = game.player_order[1]
        hit = {"source_player_id": attacker, "target_player_id": SOLO_PLAYER_ID, "effect_type": "base_raid_rubble"}
        game.player_effects.append(dict(hit))
        execute_end_of_turn(game)
        assert game.solo["result"] is None and game.solo["raids_taken"] == 1
        game.player_effects = [dict(hit)]
        execute_end_of_turn(game)
        assert game.solo["result"] == "lost" and "raided" in game.solo["reason"]

    def test_survive_overrun(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "survive", "rounds": 5, "tiles_lost_max": 1}, bots=2)
        assert game.solo
        for _ in range(2):
            self._step(game, SOLO_PLAYER_ID, game.player_order[2])
        execute_end_of_turn(game)
        assert game.solo["result"] == "lost" and "more than the 1" in game.solo["reason"]

    def test_survive_must_still_hold_tiles(self, card_registry: dict[str, Card]) -> None:
        game = _objective_game(card_registry, {"type": "survive", "rounds": 1, "tiles": 5}, bots=2)
        execute_end_of_turn(game)
        assert game.solo and game.solo["result"] == "lost" and "holding 2 of the 5" in game.solo["reason"]

    @pytest.mark.parametrize("objective, bots, message", [
        ({"type": "raid", "rounds": 5}, 0, "needs bots"),
        ({"type": "territory", "tiles": 3, "share": 0.5, "rounds": 5}, 0, "one of them"),
        ({"type": "territory", "tiles": 99, "rounds": 5}, 0, "only 14"),
        ({"type": "vp", "vp": 5, "rounds": 5, "bot_vp": 6}, 0, "no bots"),
        ({"type": "vp", "vp": 5, "rounds": 5, "tiles": 3}, 0, "doesn't take"),
        ({"type": "conquer", "rounds": 5}, 0, "unknown objective"),
        ({"type": "survive", "rounds": 5}, 0, "needs bots"),
        ({"type": "capture", "tiles": 3, "rounds": 5}, 0, "needs bots"),
        ({"type": "fortify", "tiles": 3, "rounds": 5}, 0, "whole number `defense`"),
        ({"type": "vp", "vp": 5}, 0, "no time limit"),
    ])
    def test_bad_objectives(self, card_registry: dict[str, Card], objective: dict[str, Any],
                            bots: int, message: str) -> None:
        with pytest.raises(LevelError, match=message):
            _level(card_registry, objective=objective)

    def test_no_time_limit(self, card_registry: dict[str, Card]) -> None:
        bots = [{"archetype": "swarm", "name": "Left"}, {"archetype": "fortress", "name": "Right"}]
        layout = {"layout": TWO_BOTS}
        with pytest.raises(LevelError, match="no time limit"):  # nothing would ever end it
            _level(card_registry, map=layout, bots=bots, objective={"type": "raid"})
        with pytest.raises(LevelError, match="survive"):
            _level(card_registry, map=layout, bots=bots, objective={"type": "survive", "bot_vp": 9})
        level = _level(card_registry, map=layout, bots=bots, objective={"type": "raid", "bot_vp": 4})
        assert level.objective.rounds is None
        assert level.objective.describe(True).endswith("before a rival reaches 4 VP. No time limit.")
        game = create_solo_game(level, card_registry, seed=1)
        execute_start_of_turn(game)
        assert game.solo and game.solo["objective"]["rounds"] is None
        game.current_round = 30
        execute_end_of_turn(game)  # well past any usual limit: still on
        assert game.solo["result"] is None
        _give_tiles(game, game.player_order[1], 10)  # a rival at 4 VP
        execute_end_of_turn(game)
        assert game.solo["result"] == "lost"
        # A stalemate still stops, eventually.
        game = create_solo_game(level, card_registry, seed=1)
        execute_start_of_turn(game)
        game.current_round = UNTIMED_ROUND_GUARD
        execute_end_of_turn(game)
        assert game.solo and game.solo["result"] == "lost"

    def test_water_and_scorched_earth(self, card_registry: dict[str, Card]) -> None:
        layout = """\
    .
  ~   %
.   *   &
  .   .
.   a   .
  .   .
    A
"""
        level = _level(card_registry, map={"layout": layout})
        game = create_solo_game(level, card_registry, seed=1)
        assert game.grid
        kinds = {(t.is_water, t.is_scorched, t.scorched_vp): t for t in game.grid.tiles.values() if t.is_blocked}
        assert set(kinds) == {(True, False, 0), (False, True, 0), (False, True, 1)}
        assert level.map_summary()["water"] == 1 and level.map_summary()["scorched"] == 2
        assert level.map_summary()["mountains"] == 0
        # Nobody's land — and they cut the top tile off (with the walled town).
        assert starter_ceiling(level, card_registry).tiles == 9
        again = deserialize_game(serialize_game(game), card_registry)
        assert again.grid and sum(t.is_water for t in again.grid.tiles.values()) == 1

    def test_spotlight_must_be_in_the_pool(self, card_registry: dict[str, Card]) -> None:
        level = _level(card_registry, spotlight=["neutral_siege_tower"])
        assert level.spotlight == ["neutral_siege_tower"]
        with pytest.raises(LevelError, match="spotlight"):
            _level(card_registry, spotlight=["neutral_road_builder"])
