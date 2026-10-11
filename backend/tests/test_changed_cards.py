"""Playtests for every card changed by the Core-set rework — number-only
upgrades, Explore (defenseless tiles only), defense cards that draw and give
back an action, Siege Engine / Conqueror's bonus against defense, and the
pack-tuning changes to costs and numbers — and for the rule that a Claim's
conditions are judged at the reveal.

Each card is played through the real engine — play_card, the reveal, and the
next round where it matters — base and upgraded, and what it did is checked:
resources, cards drawn, actions, tiles won, defense, Debt and VP.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from app.game_engine.cards import Archetype, Card, CardType, _copy_card, make_debt_card
from app.game_engine.effect_resolver import calculate_effective_power
from app.game_engine.game_state import (
    GameState,
    Phase,
    advance_resolve,
    _compute_formula_vp,
    compute_player_vp,
    create_game,
    end_buy_phase,
    execute_start_of_turn,
    execute_upkeep,
    play_card,
    submit_play,
)
from app.game_engine.hex_grid import GridSize, HexTile

UP = [False, True]


class Table:
    """A 2-player small game in the Play phase. p0 holds the card under test
    and four Gathers; both draw piles are Gathers, so draws are countable."""

    def __init__(self, reg: dict[str, Card], card_id: str, upgraded: bool = False,
                 arch: Optional[str] = None, hand: int = 4) -> None:
        self.reg = reg
        template = reg[card_id]
        arch = arch or (template.archetype.value if template.archetype != Archetype.SHARED else "vanguard")
        opp = "swarm" if arch != "swarm" else "fortress"
        self.game: GameState = create_game(
            GridSize.SMALL,
            [{"id": "p0", "name": "Ann", "archetype": arch},
             {"id": "p1", "name": "Bo", "archetype": opp}],
            reg, seed=7,
        )
        execute_start_of_turn(self.game)
        execute_upkeep(self.game)
        self.p0 = self.game.players["p0"]
        self.p1 = self.game.players["p1"]
        self.card = self.make(card_id, upgraded, "test")
        for i, p in enumerate((self.p0, self.p1)):
            p.deck.cards = [self.make("neutral_gather", False, f"d{i}_{k}") for k in range(12)]
            p.deck.discard = []
        self.p0.hand = [self.card] + [self.make("neutral_gather", False, f"h{k}") for k in range(hand)]
        self.p0.resources = 0

    def make(self, card_id: str, upgraded: bool = False, tag: str = "x") -> Card:
        c = _copy_card(self.reg[card_id], tag)
        c.is_upgraded = upgraded
        return c

    # ── tiles ──
    @property
    def grid(self):  # type: ignore[no-untyped-def]
        assert self.game.grid is not None
        return self.game.grid

    def own(self, n: int = 0) -> HexTile:
        """A non-base tile p0 owns (the n-th)."""
        return [t for t in self.grid.get_player_tiles("p0") if not t.is_base][n]

    def base(self) -> HexTile:
        return next(t for t in self.grid.get_player_tiles("p0") if t.is_base)

    def free(self, n: int = 0, exclude: tuple[str, ...] = ()) -> HexTile:
        """A plain neutral tile next to p0's land (the n-th)."""
        out: list[HexTile] = []
        for pt in self.grid.get_player_tiles("p0"):
            for a in self.grid.get_adjacent(pt.q, pt.r):
                if (a.owner is None and not a.is_vp and not a.is_base and not a.is_blocked
                        and a.defense_power == 0 and a.key not in exclude and a not in out):
                    out.append(a)
        return out[n]

    def enemy(self, n: int = 0, defense: int = 0) -> HexTile:
        """A tile next to p0's land that p1 owns, with `defense` this round."""
        t = self.free(n)
        t.owner, t.base_defense, t.permanent_defense_bonus, t.defense_power = "p1", 0, 0, defense
        return t

    def far(self) -> HexTile:
        """A neutral tile 2 steps from p0's land (not adjacent to it)."""
        mine = self.grid.get_player_tiles("p0")
        for t in self.grid.tiles.values():
            if (t.owner is None and not t.is_blocked and not t.is_vp and not t.is_base
                    and t.defense_power == 0 and min(t.distance_to(m) for m in mine) == 2):
                return t
        raise AssertionError("no tile 2 steps away")

    # ── play ──
    def play(self, idx: int = 0, tile: Optional[HexTile] = None, **kw: Any) -> None:
        if tile is not None:
            kw.setdefault("target_q", tile.q)
            kw.setdefault("target_r", tile.r)
        ok, msg = play_card(self.game, "p0", idx, **kw)
        assert ok, msg

    def reveal(self) -> None:
        for pid in ("p0", "p1"):
            if not self.game.players[pid].has_submitted_play:
                submit_play(self.game, pid)

    def next_round(self) -> None:
        """Reveal (if needed), finish buying, and start the next round's Play."""
        self.reveal()
        for pid in ("p0", "p1"):
            if self.game.current_phase == Phase.REVEAL:
                advance_resolve(self.game, pid)
        for pid in ("p0", "p1"):
            if self.game.current_phase == Phase.BUY:
                end_buy_phase(self.game, pid)
        if self.game.current_phase == Phase.UPKEEP:
            execute_upkeep(self.game)
        assert self.game.current_phase == Phase.PLAY

    def power(self) -> int:
        a = self.p0.planned_actions[-1]
        return calculate_effective_power(self.game, self.p0, a.card, a)

    def settled(self) -> int:
        """The last planned Claim's power as settled at the reveal."""
        a = self.p0.planned_actions[-1]
        assert a.effective_power is not None
        return a.effective_power

    def step(self, tile: HexTile) -> dict[str, Any]:
        return next(s for s in self.game.resolution_steps if s["tile_key"] == tile.key)

    def debts(self) -> int:
        cards = self.p0.deck.cards + self.p0.deck.discard + self.p0.hand
        return sum(1 for c in cards if c.name == "Debt")


# ══ Starters ═══════════════════════════════════════════════════


@pytest.mark.parametrize("up", UP)
def test_gather(card_registry, up):
    t = Table(card_registry, "neutral_gather", up)
    actions = t.p0.actions_available
    t.play()
    assert t.p0.resources == (3 if up else 2)
    assert t.p0.actions_available == actions  # no action back, upgraded or not
    assert len(t.p0.hand) == 4


@pytest.mark.parametrize("up", UP)
def test_explore(card_registry, up):
    t = Table(card_registry, "neutral_explore", up)
    first = t.free(0)
    extra = [[t.free(i).q, t.free(i).r] for i in range(2, 3)] if up else []
    t.play(tile=first, extra_targets=extra)
    assert len(t.p0.hand) == 4  # never draws
    t.reveal()
    won = [first] + [t.grid.get_tile(q, r) for q, r in extra]
    assert all(w.owner == "p0" for w in won)  # Explore+ takes 2 (not necessarily touching)


def test_explore_only_takes_open_undefended_tiles(card_registry):
    t = Table(card_registry, "neutral_explore", True)
    defended = t.free(0)
    defended.base_defense = defended.defense_power = 1
    ok, msg = play_card(t.game, "p0", 0, target_q=defended.q, target_r=defended.r)
    assert not ok and "no defense" in msg
    owned = t.enemy(1)
    ok, _ = play_card(t.game, "p0", 0, target_q=owned.q, target_r=owned.r)
    assert not ok
    # Explore+'s second tile is dropped if it's defended.
    t.play(tile=t.free(2), extra_targets=[[defended.q, defended.r]])
    assert t.p0.planned_actions[-1].extra_targets == []


def test_explore_loses_to_any_rival_claim(card_registry):
    t = Table(card_registry, "neutral_explore", False)
    tile = t.free()
    t.p1.hand = [t.make("neutral_recruit", False, "lv")] + t.p1.hand
    staging = next(a for a in t.grid.get_adjacent(tile.q, tile.r) if a.owner is None and not a.is_blocked)
    staging.owner = "p1"
    t.play(tile=tile)
    ok, msg = play_card(t.game, "p1", 0, target_q=tile.q, target_r=tile.r)
    assert ok, msg
    t.reveal()
    assert tile.owner == "p1"


# ══ Shared ═════════════════════════════════════════════════════


@pytest.mark.parametrize("up", UP)
def test_watchtower(card_registry, up):
    t = Table(card_registry, "neutral_watchtower", up)
    tile, actions = t.own(), t.p0.actions_available
    before = tile.defense_power
    t.play(tile=tile)
    assert t.p0.actions_available == actions + 1
    assert len(t.p0.hand) == 5  # draws 1
    t.reveal()
    assert tile.defense_power == before + (3 if up else 2)
    assert card_registry["neutral_watchtower"].buy_cost == 3


@pytest.mark.parametrize("up", UP)
def test_ambush(card_registry, up):
    t = Table(card_registry, "neutral_ambush", up)
    tile = t.enemy(defense=4)
    t.play(tile=tile)
    t.reveal()
    assert t.settled() == (5 if up else 4)
    assert (tile.owner == "p0") is up  # 5 beats 4; 4 ties and the owner keeps it
    assert t.p0.resources == 0


def test_ambush_plain_power_on_an_uncontested_neutral(card_registry):
    t = Table(card_registry, "neutral_ambush", True)
    t.play(tile=t.free())
    t.reveal()
    assert t.settled() == 2


@pytest.mark.parametrize("up", UP)
def test_rally_cry(card_registry, up):
    t = Table(card_registry, "neutral_rally_cry", up)
    t.p0.hand.append(t.make("neutral_recruit", False, "levy"))
    t.play()
    levy = next(c for c in t.p0.hand if c.name == "Levy")
    assert levy.stackable or levy.granted_stackable
    assert len(t.p0.hand) == 5 + (2 if up else 1)  # 4 Gathers + Levy + draws
    assert t.card in t.p0.trash or any(a.card is t.card for a in t.p0.planned_actions)
    assert t.p0.turn_modifiers.claim_buffs == []


@pytest.mark.parametrize("up", UP)
def test_sabotage(card_registry, up):
    t = Table(card_registry, "neutral_sabotage", up)
    t.play(target_player_id="p1")
    t.next_round()
    assert len(t.p1.hand) == t.p1.hand_size - (2 if up else 1)


@pytest.mark.parametrize("up", UP)
def test_conqueror(card_registry, up):
    t = Table(card_registry, "neutral_conqueror", up)
    t.p0.actions_used = t.p0.actions_available - 2  # exactly 2 left: enough
    plain, walled = t.enemy(0), t.enemy(1, defense=7)
    walled.permanent_defense_bonus = 2  # 2 permanent + 5 this round
    t.play(tile=walled)
    t.reveal()
    assert t.settled() == (8 if up else 7)  # +2 against a defended tile
    assert (walled.owner == "p0") is up
    assert plain.owner == "p1"


@pytest.mark.parametrize("up", UP)
def test_forced_march(card_registry, up):
    t = Table(card_registry, "neutral_forced_march", up)
    actions = t.p0.actions_available
    t.play()
    assert t.p0.actions_available == actions + (3 if up else 2)
    t.next_round()
    # The drawback stays on the upgrade: the opponent gets an extra action.
    assert t.p1.actions_available == t.p0.actions_available + 1


@pytest.mark.parametrize("up", UP)
def test_reclaim(card_registry, up):
    t = Table(card_registry, "neutral_reclaim", up)
    t.p0.hand.append(t.make("neutral_mercenary", False, "m"))
    t.play(trash_card_indices=[len(t.p0.hand) - 2])
    assert t.p0.resources == card_registry["neutral_mercenary"].buy_cost // 2 + (2 if up else 1)
    assert any(c.name == "Mercenary" for c in t.p0.trash)


@pytest.mark.parametrize("up", UP)
def test_spyglass(card_registry, up):
    t = Table(card_registry, "neutral_spyglass", up, hand=3)
    actions = t.p0.actions_available
    t.play()  # 3 others + 1 drawn = 4 in hand
    assert len(t.p0.hand) == 4
    assert t.p0.actions_available == actions + (1 if up else 0)  # threshold 3 → 4
    assert t.p0.resources == 0


@pytest.mark.parametrize("up", UP)
def test_dividends(card_registry, up):
    t = Table(card_registry, "neutral_dividends", up)
    t.p0.resources = 2
    t.play()
    assert t.p0.resources == 2 + (3 if up else 1)  # 1 per 2 held, minimum 1 → 3
    assert len(t.p0.hand) == 4


@pytest.mark.parametrize("up", UP)
def test_mobilize(card_registry, up):
    t = Table(card_registry, "neutral_mobilize", up)
    for _ in range(4):
        t.play(idx=1)  # four Gathers first
    actions = t.p0.actions_available
    t.play(idx=0)
    assert t.p0.actions_available == actions + (4 if up else 3)
    assert len(t.p0.hand) == 0


@pytest.mark.parametrize("up", UP)
def test_supply_depot(card_registry, up):
    t = Table(card_registry, "neutral_supply_depot", up)
    t.play()
    t.next_round()
    assert len(t.p0.hand) == t.p0.hand_size + 2
    assert t.p0.resources == (4 if up else 3)
    assert t.p0.actions_available == t.p1.actions_available


@pytest.mark.parametrize("up", UP)
def test_redemption(card_registry, up):
    t = Table(card_registry, "neutral_redemption", up)
    gone = [t.make("neutral_mercenary", False, f"tr{i}") for i in range(2)]
    t.p0.trash.extend(gone)
    picks = [{"card_id": c.id, "target": "hand"} for c in gone[: (2 if up else 1)]]
    t.play(search_selections=picks)
    assert sum(1 for c in t.p0.hand if c.name == "Mercenary") == len(picks)
    assert len(t.p0.hand) == 4 + len(picks)  # no extra draw


# ══ Vanguard ═══════════════════════════════════════════════════


@pytest.mark.parametrize("up", UP)
def test_overrun(card_registry, up):
    t = Table(card_registry, "vanguard_overrun", up)
    tile, used = t.far(), t.p0.actions_used
    t.play(tile=tile)
    assert t.p0.actions_used == used + 2
    t.next_round()
    assert tile.owner == "p0"
    assert t.p0.actions_available == t.p1.actions_available  # no bonus action
    assert t.game.players["p0"].planned_actions == []


@pytest.mark.parametrize("up", UP)
def test_overrun_power(card_registry, up):
    t = Table(card_registry, "vanguard_overrun", up)
    t.play(tile=t.far())
    t.reveal()
    assert t.settled() == (6 if up else 4)


@pytest.mark.parametrize("up", UP)
def test_spearhead(card_registry, up):
    t = Table(card_registry, "vanguard_spearhead", up)
    tile = t.enemy(defense=8)
    t.play(tile=tile)
    t.reveal()
    assert t.settled() == (9 if up else 8)
    assert (tile.owner == "p0") is up
    assert t.card in t.p0.trash and t.p0.resources == 0


@pytest.mark.parametrize("up", UP)
def test_breakthrough(card_registry, up):
    t = Table(card_registry, "vanguard_breakthrough", up)
    tile = t.enemy(defense=4)
    tiles_before = len(t.grid.get_player_tiles("p0"))
    t.play(tile=tile)
    t.next_round()
    assert (tile.owner == "p0") is up  # power 5 beats 4, power 3 doesn't
    assert len(t.grid.get_player_tiles("p0")) == tiles_before + (2 if up else 0)
    assert len(t.p0.hand) == t.p0.hand_size  # no extra draw


@pytest.mark.parametrize("up", UP)
def test_war_banner(card_registry, up):
    t = Table(card_registry, "vanguard_war_banner", up)
    actions = t.p0.actions_available
    t.p0.hand += [t.make("neutral_recruit", False, f"b{i}") for i in range(2)]
    t.play()
    assert t.p0.actions_available == actions
    a, b = t.free(0), t.free(1)
    t.play(idx=len(t.p0.hand) - 1, tile=a)
    t.play(idx=len(t.p0.hand) - 1, tile=b)
    t.reveal()
    powers = [x.effective_power for x in t.p0.planned_actions if x.card.name == "Levy"]
    assert powers == ([3, 3] if up else [3, 1])
    t.next_round()
    assert len(t.p0.hand) == t.p0.hand_size + (2 if up else 1)  # a card per buffed claim won


@pytest.mark.parametrize("up", UP)
def test_arsenal(card_registry, up):
    t = Table(card_registry, "vanguard_arsenal", up)
    p = t.p0
    p.hand, p.deck.cards, p.deck.discard = [], [], [t.card]
    base_vp = compute_player_vp(t.game, "p0")
    p.deck.discard += [t.make("neutral_gather", False, f"a{i}") for i in range(11)]  # 12 cards
    assert compute_player_vp(t.game, "p0") == base_vp + (1 if up else 0)
    p.deck.discard += [t.make("neutral_gather", False, f"b{i}") for i in range(2)]   # 14 cards
    assert compute_player_vp(t.game, "p0") == base_vp + 1


@pytest.mark.parametrize("up", UP)
def test_war_tithe(card_registry, up):
    t = Table(card_registry, "vanguard_war_tithe", up)
    t.p0.claims_won_last_round = 3
    t.play()
    assert t.p0.resources == 3 * (2 if up else 1)
    t.next_round()
    assert len(t.p0.hand) == t.p0.hand_size


@pytest.mark.parametrize("up", UP)
def test_forward_march(card_registry, up):
    t = Table(card_registry, "vanguard_forward_march", up)
    tile = t.free()
    tile.base_defense = tile.defense_power = 2
    t.play(tile=tile)
    t.next_round()
    assert (tile.owner == "p0") is up  # power 2 matches a neutral 2
    assert len(t.p0.hand) == t.p0.hand_size + (2 if up else 0)


def test_forward_march_stays_neutral_only(card_registry):
    t = Table(card_registry, "vanguard_forward_march", True)
    ok, _ = play_card(t.game, "p0", 0, target_q=t.enemy().q, target_r=t.enemy().r)
    assert not ok


@pytest.mark.parametrize("up", UP)
def test_battle_cry(card_registry, up):
    t = Table(card_registry, "vanguard_surge_protocol", up)
    actions = t.p0.actions_available
    t.play(target_player_id="p1")
    assert t.p0.actions_available == actions + (3 if up else 2)
    t.next_round()
    assert len(t.p0.hand) == t.p0.hand_size + 1
    assert t.p1.actions_available == t.p0.actions_available + 1  # drawback kept


@pytest.mark.parametrize("up", UP)
def test_financier(card_registry, up):
    t = Table(card_registry, "vanguard_financier", up)
    t.p0.deck.discard = [make_debt_card(), make_debt_card()]
    actions = t.p0.actions_available
    t.play()
    assert len(t.p0.hand) == 4 + 2 * (2 if up else 1)
    assert t.p0.actions_available == actions


@pytest.mark.parametrize("up", UP)
def test_pursuit(card_registry, up):
    t = Table(card_registry, "vanguard_pursuit", up)
    t.p0.tiles_captured_from_opponents_last_round = 2
    actions = t.p0.actions_available
    t.play()
    assert t.p0.resources == 2 * (2 if up else 1)
    assert t.p0.actions_available == actions + 2
    assert len(t.p0.hand) == 4


# ══ Swarm ══════════════════════════════════════════════════════


@pytest.mark.parametrize("up", UP)
def test_surge(card_registry, up):
    t = Table(card_registry, "swarm_surge", up)
    frees = []
    for i in range(12):
        try:
            frees.append(t.free(i))
        except IndexError:
            break
    # A connected group of 2 (3 upgraded) open tiles next to our land.
    group = next(
        [a, b, c] for a in frees for b in frees for c in frees
        if len({a.key, b.key, c.key}) == 3 and a.distance_to(b) == 1
        and (c.distance_to(a) == 1 or c.distance_to(b) == 1)
    )[: (3 if up else 2)]
    first = group[0]
    extra = [(x.q, x.r) for x in group[1:]]
    t.play(tile=first, extra_targets=[list(e) for e in extra])
    t.next_round()
    won = [first] + [t.grid.get_tile(q, r) for q, r in extra]
    assert all(w.owner == "p0" for w in won)
    assert t.p0.actions_available == t.p1.actions_available  # no bonus actions


def test_surge_cannot_exceed_its_targets(card_registry):
    t = Table(card_registry, "swarm_surge", False)
    extra = [[t.free(i).q, t.free(i).r] for i in range(1, 3)]
    ok, _ = play_card(t.game, "p0", 0, target_q=t.free().q, target_r=t.free().r, extra_targets=extra)
    if ok:  # extra targets beyond the limit are dropped
        assert len(t.p0.planned_actions[-1].extra_targets) <= 1


@pytest.mark.parametrize("up", UP)
def test_proliferate(card_registry, up):
    t = Table(card_registry, "swarm_proliferate", up)
    mine = t.grid.get_player_tiles("p0")
    tile = max(
        (x for x in t.grid.tiles.values() if x.owner is None and not x.is_blocked and not x.is_vp
         and not x.is_base and x.defense_power == 0),
        key=lambda x: min(x.distance_to(m) for m in mine),
    )
    t.play(tile=tile)
    t.reveal()
    assert tile.owner == "p0"
    assert t.settled() == (2 if up else 1)
    assert t.p0.resources == 0


@pytest.mark.parametrize("up", UP)
def test_rabble(card_registry, up):
    t = Table(card_registry, "swarm_rabble", up)
    t.p0.hand += [t.make("swarm_rabble", up, "r2"), t.make("swarm_rabble", up, "r3")]
    left = lambda: t.p0.actions_available - t.p0.actions_used  # noqa: E731
    actions = left()
    t.play(tile=t.free(0))
    assert left() == actions  # every Rabble pays its action back
    t.play(idx=len(t.p0.hand) - 1, tile=t.free(1))
    t.play(idx=len(t.p0.hand) - 1, tile=t.free(2))
    assert left() == actions
    t.reveal()
    # +1 power for each other Rabble played this round (two others).
    assert [a.effective_power for a in t.p0.planned_actions] == ([4, 4, 4] if up else [3, 3, 3])


def test_a_lone_rabble_is_power_1(card_registry):
    t = Table(card_registry, "swarm_rabble", False)
    t.play(tile=t.free(0))
    t.reveal()
    assert t.settled() == 1


@pytest.mark.parametrize("up", UP)
def test_nest(card_registry, up):
    t = Table(card_registry, "swarm_nest", up)
    tile = t.own()
    neighbours = sum(1 for a in t.grid.get_adjacent(tile.q, tile.r) if a.owner == "p0")
    before = tile.defense_power
    t.play(tile=tile)
    assert len(t.p0.hand) == 5  # draws 1
    t.reveal()
    assert tile.defense_power == before + neighbours * (2 if up else 1)


@pytest.mark.parametrize("up", UP)
def test_hatching_grounds(card_registry, up):
    t = Table(card_registry, "swarm_hatching_grounds", up)
    actions = t.p0.actions_available
    t.play()
    assert sum(1 for c in t.p0.deck.discard if c.name == "Rabble") == (5 if up else 3)
    assert t.p0.actions_available == actions
    assert t.card in t.p0.trash or any(a.card is t.card for a in t.p0.planned_actions)


@pytest.mark.parametrize("up", UP)
def test_strength_in_numbers(card_registry, up):
    t = Table(card_registry, "swarm_numbers_game", up)
    t.play(tile=t.free())
    t.reveal()
    assert t.settled() == (2 if up else 1) + 4  # plus 1 per other card in hand when played


@pytest.mark.parametrize("up", UP)
def test_frenzy(card_registry, up):
    t = Table(card_registry, "swarm_frenzy", up)
    actions = t.p0.actions_available
    t.play(discard_card_indices=[0])
    assert t.p0.actions_available == actions + (3 if up else 2)
    assert len(t.p0.hand) == 3 and t.p0.resources == 0


@pytest.mark.parametrize("up", UP)
def test_heady_brew(card_registry, up):
    t = Table(card_registry, "swarm_heady_brew", up)
    t.p0.deck.discard = [t.make("neutral_mercenary", False, f"m{i}") for i in range(4)]
    t.play()
    drawn = 2 if up else 1
    assert sum(1 for c in t.p0.hand if c.name == "Mercenary") == drawn
    assert len(t.p0.deck.cards) == 4 - drawn
    assert len([c for c in t.p0.deck.discard if c.name == "Gather"]) == 12


@pytest.mark.parametrize("up", UP)
def test_second_wave(card_registry, up):
    t = Table(card_registry, "swarm_second_wave", up)
    claims = [t.make("swarm_surge", False, f"s{i}") for i in range(2)]
    t.p0.deck.discard = claims + [t.make("neutral_gather", False, "g")]
    picks = [{"card_id": c.id, "target": "hand"} for c in claims[: (2 if up else 1)]]
    actions = t.p0.actions_available
    t.play(search_selections=picks)
    assert sum(1 for c in t.p0.hand if c.name == "Surge") == len(picks)
    assert t.p0.actions_available == actions + 1 and t.p0.resources == 0


# ══ Fortress ═══════════════════════════════════════════════════


@pytest.mark.parametrize("up", UP)
def test_bulwark(card_registry, up):
    t = Table(card_registry, "fortress_bulwark", up)
    tiles = [t.base(), t.own(0)]
    t.p0.hand.append(t.make("neutral_gather", False, "x"))
    extra_tile = t.free()
    extra_tile.owner = "p0"  # a third tile of ours
    tiles.append(extra_tile)
    before = [x.defense_power for x in tiles]
    n = 3 if up else 2
    t.play(tile=tiles[0], extra_targets=[[x.q, x.r] for x in tiles[1:n]])
    assert len(t.p0.hand) == 5  # no draw
    t.reveal()
    gained = [x.defense_power - b for x, b in zip(tiles, before)]
    assert gained == [2] * n + [0] * (3 - n)


@pytest.mark.parametrize("up", UP)
def test_garrison(card_registry, up):
    t = Table(card_registry, "fortress_garrison", up)
    tile = t.enemy(defense=4)
    t.play(tile=tile)
    t.reveal()
    assert t.settled() == (5 if up else 4)
    assert (tile.owner == "p0") is up
    assert t.debts() == 1 and t.p0.resources == 0


@pytest.mark.parametrize("up", UP)
def test_garrison_defending(card_registry, up):
    t = Table(card_registry, "fortress_garrison", up)
    tile = t.own()
    t.play(tile=tile)
    t.reveal()
    assert t.settled() == (8 if up else 6)


@pytest.mark.parametrize("up", UP)
@pytest.mark.parametrize("neutral", [True, False])
def test_mountaineer(card_registry, up, neutral):
    t = Table(card_registry, "fortress_slow_advance", up)
    tile = t.free() if neutral else t.enemy()
    t.play(tile=tile)
    t.reveal()
    assert t.settled() == (3 if up else 2) + (2 if neutral else 0)


@pytest.mark.parametrize("up", UP)
def test_quartermaster(card_registry, up):
    t = Table(card_registry, "fortress_quartermaster", up)
    t.p0.hand += [t.make("fortress_bulwark", False, f"d{i}") for i in range(4)]
    actions = t.p0.actions_available
    t.play()
    assert t.p0.resources == 3 * (3 if up else 2)  # max 3 Defense counted
    assert t.p0.actions_available == actions + 1
    assert len(t.p0.hand) == 8  # no draw


@pytest.mark.parametrize("up", UP)
def test_siege_engine(card_registry, up):
    t = Table(card_registry, "fortress_siege_engine", up)
    tile = t.enemy(defense=5)  # e.g. a Watchtower+ this round on 2 permanent
    tile.permanent_defense_bonus = 2
    t.play(tile=tile)
    t.reveal()
    assert t.settled() == (6 if up else 5)
    assert (tile.owner == "p0") is up
    assert "defense_ignored" not in t.step(tile)


def test_siege_engine_no_bonus_on_an_undefended_tile(card_registry):
    t = Table(card_registry, "fortress_siege_engine", False)
    t.play(tile=t.enemy())
    t.reveal()
    assert t.settled() == 3


@pytest.mark.parametrize("up", UP)
def test_fortify(card_registry, up):
    t = Table(card_registry, "fortress_fortify", up)
    a, b = t.base(), t.own()
    before = (a.defense_power, b.defense_power)
    actions = t.p0.actions_available
    t.play(tile=a, extra_targets=[[b.q, b.r]] if up else [])
    assert t.p0.actions_available == actions + 1
    t.reveal()
    assert (a.defense_power - before[0], b.defense_power - before[1]) == ((3, 3) if up else (3, 0))


@pytest.mark.parametrize("up", UP)
def test_consolidate(card_registry, up):
    t = Table(card_registry, "fortress_consolidate", up)
    t.p0.hand.append(t.make("neutral_mercenary", False, "m"))
    t.play(trash_card_indices=[len(t.p0.hand) - 2])
    assert t.p0.resources == card_registry["neutral_mercenary"].buy_cost // 2 + (3 if up else 1)
    assert len(t.p0.hand) == 5  # 4 Gathers + 1 drawn


@pytest.mark.parametrize("up", UP)
def test_mulligan(card_registry, up):
    t = Table(card_registry, "fortress_mulligan", up)
    t.play()
    assert len(t.p0.hand) == 4 + (2 if up else 1)


@pytest.mark.parametrize("up", UP)
def test_snowy_holiday(card_registry, up):
    t = Table(card_registry, "fortress_snowy_holiday", up)
    t.play()
    t.reveal()
    assert len(t.p0.hand) == 4 + (2 if up else 1)
    t.next_round()
    t.p0.hand.insert(0, t.make("vanguard_blitz", False, "blz"))
    ok, _ = play_card(t.game, "p0", 0, target_q=t.free().q, target_r=t.free().r)
    assert not ok  # nobody can claim this round


@pytest.mark.parametrize("up", UP)
def test_watchful_keep(card_registry, up):
    t = Table(card_registry, "fortress_watchful_keep", up)
    walled = [t.free(i) for i in range(5)]
    for w in walled:
        w.owner, w.permanent_defense_bonus = "p0", 1
        w.defense_power = w.base_defense + 1
    actions = t.p0.actions_available
    t.play()
    assert len(t.p0.hand) == 4 + (4 if up else 3)  # 5 walled tiles, max 3 / 4
    assert t.p0.actions_available == actions
    t.next_round()
    assert len(t.p0.hand) == t.p0.hand_size + (2 if up else 1)


# ══ Pack tuning ════════════════════════════════════════════════


@pytest.mark.parametrize("up", UP)
def test_barricade(card_registry, up):
    t = Table(card_registry, "neutral_fortified_post", up)
    tile, actions = t.own(), t.p0.actions_available
    t.play(tile=tile)
    assert t.p0.actions_available == actions + 1 and len(t.p0.hand) == 5
    t.reveal()
    assert tile.permanent_defense_bonus == (3 if up else 2)
    t.next_round()
    assert tile.permanent_defense_bonus == (3 if up else 2)  # it lasts
    assert card_registry["neutral_fortified_post"].buy_cost == 5


@pytest.mark.parametrize("up", UP)
def test_iron_wall(card_registry, up):
    t = Table(card_registry, "fortress_iron_wall", up)
    a, b = t.own(), t.base()
    actions = t.p0.actions_available
    t.play(tile=a, extra_targets=[[b.q, b.r]] if up else [])
    assert t.p0.actions_available == actions + 1 and len(t.p0.hand) == 5
    t.reveal()
    assert set(t.p0.turn_modifiers.immune_tiles) == ({a.key, b.key} if up else {a.key})


def test_iron_wall_stops_a_huge_claim(card_registry):
    t = Table(card_registry, "fortress_iron_wall", False)
    tile = t.own()
    staging = next(x for x in t.grid.get_adjacent(tile.q, tile.r)
                   if x.owner is None and not x.is_blocked and not x.is_vp)
    staging.owner = "p1"
    t.play(tile=tile)
    t.p1.hand = [t.make("vanguard_spearhead", False, "sp")] + t.p1.hand
    ok, msg = play_card(t.game, "p1", 0, target_q=tile.q, target_r=tile.r)
    assert ok, msg
    t.reveal()
    assert tile.owner == "p0"


@pytest.mark.parametrize("up", UP)
def test_phalanx(card_registry, up):
    t = Table(card_registry, "swarm_safety_in_numbers", up)
    tiles = [t.base(), t.own()]
    before = [x.defense_power for x in tiles]
    actions = t.p0.actions_available
    t.play(tile=tiles[0], extra_targets=[[tiles[1].q, tiles[1].r]])
    assert t.p0.actions_available == actions + 1 and len(t.p0.hand) == 5
    t.reveal()
    assert [x.defense_power - b for x, b in zip(tiles, before)] == [2 if up else 1] * 2


@pytest.mark.parametrize("up", UP)
def test_rearguard(card_registry, up):
    t = Table(card_registry, "vanguard_rearguard", up)
    tile = t.own()
    before = tile.defense_power
    t.play(tile=tile)
    assert t.p0.resources == 2 and len(t.p0.hand) == 5
    t.reveal()
    assert tile.defense_power == before + (4 if up else 3)


@pytest.mark.parametrize("up", UP)
def test_scavenge(card_registry, up):
    t = Table(card_registry, "swarm_scavenge", up)
    actions = t.p0.actions_available
    t.play()
    assert t.p0.resources == (3 if up else 2)
    assert t.p0.actions_available == actions + 1


@pytest.mark.parametrize("up", UP)
def test_prospector(card_registry, up):
    t = Table(card_registry, "neutral_prospector", up)
    actions = t.p0.actions_available
    t.play()
    assert t.p0.resources == (7 if up else 6)
    assert t.p0.actions_available == actions + 1
    assert t.debts() == 1


@pytest.mark.parametrize("up", UP)
def test_supply_line(card_registry, up):
    t = Table(card_registry, "fortress_supply_line", up)
    actions = t.p0.actions_available
    t.play()
    assert t.p0.resources == (4 if up else 3) and t.p0.actions_available == actions + 1
    t.reveal()
    assert len(t.p0.turn_modifiers.cost_reductions) == 1  # next purchase costs 1 less
    assert card_registry["fortress_supply_line"].buy_cost == 2


@pytest.mark.parametrize("up", UP)
def test_mercenary(card_registry, up):
    t = Table(card_registry, "neutral_mercenary", up)
    tile = t.enemy(defense=3)
    t.play(tile=tile)
    t.reveal()
    assert t.settled() == (4 if up else 3)
    assert (tile.owner == "p0") is up
    assert t.debts() == 1
    assert card_registry["neutral_mercenary"].buy_cost == 3


@pytest.mark.parametrize("up", UP)
def test_blitz(card_registry, up):
    t = Table(card_registry, "vanguard_blitz", up)
    tile = t.enemy(defense=2)
    t.play(tile=tile)
    t.next_round()
    assert (tile.owner == "p0") is up  # 3 beats 2; 2 ties and the owner keeps it
    assert len(t.p0.hand) == t.p0.hand_size + (1 if up else 0)  # a card next round on success
    assert card_registry["vanguard_blitz"].buy_cost == 4


@pytest.mark.parametrize("up", UP)
def test_double_time(card_registry, up):
    t = Table(card_registry, "vanguard_double_time", up)
    actions = t.p0.actions_available
    t.play()
    assert t.p0.actions_available == actions + 2
    assert len(t.p0.hand) == 4 + (2 if up else 1)
    assert card_registry["vanguard_double_time"].buy_cost == 4


@pytest.mark.parametrize("up", UP)
@pytest.mark.parametrize("extra", [0, 3, 12])
def test_drone_wave(card_registry, up, extra):
    t = Table(card_registry, "swarm_drone_wave", up)
    for _ in range(extra):
        t.free(0).owner = "p0"
    owned = len(t.grid.get_player_tiles("p0"))
    actions = t.p0.actions_available
    t.play()
    per, cap = (2, 3) if up else (3, 2)
    assert len(t.p0.hand) == 4 + min(owned // per, cap)
    assert t.p0.actions_available == actions + 2
    if extra == 12:
        assert len(t.p0.hand) == 4 + cap  # the cap


@pytest.mark.parametrize("up", UP)
def test_battle_glory(card_registry, up):
    t = Table(card_registry, "vanguard_battle_glory", up)
    t.p0.hand += [t.make("vanguard_spearhead", False, f"s{i}") for i in range(2)]
    targets = [t.enemy(0), t.enemy(1)]
    for tile in targets:
        t.play(idx=len(t.p0.hand) - 1, tile=tile)
    t.reveal()
    assert all(x.owner == "p0" for x in targets)
    assert t.card.passive_vp == (2 if up else 1)  # 2 rival tiles beaten while it sat in hand
    assert card_registry["vanguard_battle_glory"].buy_cost == 3


def _open_near(t: Table, tile: HexTile) -> HexTile:
    return next(n for n in t.grid.get_adjacent(tile.q, tile.r)
                if n.owner is None and not n.is_blocked and not n.is_vp and not n.is_base)


@pytest.mark.parametrize("up", UP)
def test_colony(card_registry, up):
    t = Table(card_registry, "swarm_colony", up)
    t.p0.hand, t.p0.deck.cards = [], [t.card]
    vp = lambda: _compute_formula_vp(t.card, t.p0, t.game)  # noqa: E731
    assert vp() == 0
    mine = t.grid.get_player_tiles("p0")
    seed = next(x for x in t.grid.tiles.values()
                if x.owner is None and not x.is_blocked and not x.is_vp and not x.is_base
                and min(x.distance_to(m) for m in mine) >= 3)
    seed.owner = "p0"
    second = _open_near(t, seed)
    second.owner = "p0"  # a cut-off group of 2
    assert vp() == (1 if up else 0)
    _open_near(t, second).owner = "p0"  # now 3
    assert vp() == 1
    assert compute_player_vp(t.game, "p0") >= 1
    assert card_registry["swarm_colony"].buy_cost == 3


@pytest.mark.parametrize("up", UP)
def test_warden(card_registry, up):
    t = Table(card_registry, "fortress_warden", up)
    t.p0.hand, t.p0.deck.cards = [], [t.card]
    vp = lambda: _compute_formula_vp(t.card, t.p0, t.game)  # noqa: E731
    for x in t.grid.get_player_tiles("p0"):
        if not x.is_base:
            x.owner = None
    assert vp() == 0
    plain = [x for x in t.grid.tiles.values()
             if x.owner is None and not x.is_blocked and not x.is_vp and not x.is_base]
    for x in plain[:8]:
        x.owner = "p0"
    assert vp() == (1 if up else 0)  # +1 per 8 non-base tiles upgraded, per 10 base
    for x in plain[8:10]:
        x.owner = "p0"
    assert vp() == 1
    plain[0].lost_by.append("p0")  # lost once and retaken: it stops counting
    assert vp() == (1 if up else 0)
    assert card_registry["fortress_warden"].buy_debt == 1


# ══ A Claim's conditions are judged at the reveal ══════════════


def test_militia_is_judged_on_the_board_at_the_reveal(card_registry):
    t = Table(card_registry, "neutral_militia", False)
    tile = t.free()
    around = [a for a in t.grid.get_adjacent(tile.q, tile.r) if a.owner is None and not a.is_blocked]
    for a in around[:3]:
        a.owner = "p0"  # 3 owned around it at play time
    t.play(tile=tile)
    assert t.power() == 4  # the live preview
    around[0].owner = None  # lost before the reveal (e.g. abandoned)
    t.reveal()
    assert t.settled() == 2


def test_strike_team_counts_a_claim_played_after_it(card_registry):
    t = Table(card_registry, "vanguard_strike_team", False)
    t.p0.hand.append(t.make("neutral_explore", False, "e"))
    t.play(tile=t.free(0))
    t.play(idx=len(t.p0.hand) - 1, tile=t.free(1))
    t.reveal()
    st = next(a for a in t.p0.planned_actions if a.card.name == "Strike Team")
    assert st.effective_power == 4  # power 2, +2 with another Claim


def test_road_builder_bridge_is_judged_at_the_reveal(card_registry):
    t = Table(card_registry, "neutral_road_builder", False)
    for x in t.grid.get_player_tiles("p0"):
        if not x.is_base:
            x.owner = None
    base = t.base()
    gap = next(a for a in t.grid.get_adjacent(base.q, base.r)
               if a.owner is None and not a.is_blocked and not a.is_vp and a.defense_power == 0)
    far = next(a for a in t.grid.get_adjacent(gap.q, gap.r)
               if a.owner is None and not a.is_blocked and a.distance_to(base) == 2)
    far.owner = "p0"
    t.play(tile=gap)
    assert t.power() == 5  # it would bridge now
    far.owner = None  # the far group is gone by the reveal
    t.reveal()
    assert t.settled() == 1


def test_powers_settle_before_any_tile_changes_hands(card_registry):
    """Two Militias: taking tile A would give tile B its third neighbour of
    ours — but both are judged on the board before either lands."""
    t = Table(card_registry, "neutral_militia", False)
    t.p0.hand.append(t.make("neutral_militia", False, "m2"))
    grid, mine = t.grid, t.grid.get_player_tiles("p0")

    def open_(x: HexTile) -> bool:
        return x.owner is None and not x.is_blocked and not x.is_vp and not x.is_base and x.defense_power == 0

    # B: an open tile well away from our land, with open tiles all round it.
    b = next(x for x in grid.tiles.values() if open_(x) and min(x.distance_to(m) for m in mine) >= 3
             and sum(1 for n in grid.get_adjacent(x.q, x.r) if open_(n)) == 6)
    ring = grid.get_adjacent(b.q, b.r)
    r1 = ring[0]
    a = next(n for n in ring if n.distance_to(r1) == 1)
    r3 = next(n for n in ring if n.distance_to(a) == 1 and n is not r1)
    r1.owner = r3.owner = "p0"  # B has 2 of ours around it; A would make 3
    t.play(tile=a)
    t.play(idx=len(t.p0.hand) - 1, tile=b)
    t.reveal()
    assert a.owner == "p0" and b.owner == "p0"
    by_tile = {(x.target_q, x.target_r): x.effective_power for x in t.p0.planned_actions}
    assert by_tile[(b.q, b.r)] == 2
