# Card Balance Audit

## Applied changes (2026-10-03)

The designer approved §4 and §5 with one change: **Rubble is capped at 1 per base raid** (not 2). Everything below is now in the YAML, engine, CPU, frontend previews and tests (`backend/tests/test_balance_pass.py` has one regression test per bug).

**Applied**
- **Systemic:** a successful raid gives the defender exactly 1 Rubble (`RAID_RUBBLE_CAP`) plus 1 Spoils to the attacker, whatever the margin. The CPU's raid scoring uses the same cap. With the cap in place, **Demon Pact is unchanged**.
- **Vanguard:** Strike Team cost 5 · Arms Dealer 1× power · Elite Vanguard power 5 (7), 1 action · Battle Cry also "Draw 1 card next round" · Coordinated Push base gets the stacked +1 action · Arsenal 1 VP per 12 cards (10 upgraded), cost 6 · Regroup cost 3 · War Banner cost 5 · Financier cost 5 · Counterattack defense 3 (4).
- **Swarm:** Overwhelm 1 action · Hive Mind and Locust Swarm reusable · Swarm Tactics "next Claim +1 power" · Second Wave fetches Claims only · Phalanx +1 on up to 4 tiles (+2 upgraded) · Consecrate cost 4 · Stampede cost 2.
- **Fortress:** Juggernaut pays +2/+3 only for a neutral target · Iron Discipline "Draw 1 card next round", cost 4.
- **Neutral:** Eminent Domain power 2 (3), trashed on use · Siege Tower unique, cost 9 · Conqueror unique · Palisade "+3 defense, draw 1" (no action) · Caravan draws 1 (2 upgraded) · Road Builder power 1 (2), or 5 (6) on a tile that bridges your groups (new `if_bridges_territory` condition, judged at play time; see the follow-up below) · Surveyor gains 1 action and 2 (3) free re-rolls, which now expire at round end as the text says · Diplomat gives you 2 Land Grants and each opponent 1 (upgraded: opponents get none) · Dividends 1 per 2 held · Cartographer and Sift gain 1 action, Sift cost 2 · Foresight 1 action · Sabotage cost 4 · Ambush text now says "owned by or also claimed by an opponent".
- **Bugs B1–B15 fixed** as in §5. The loader now only falls back to parsing stats from card text when the YAML field is absent, so text can't double an effect (B1/B5/B6).
- **B11:** when several players reach the target in the same round, the highest VP wins, then the most VP hexes connected to base, then the most tiles. A full tie is a shared victory (`game.winners`). Seat order no longer decides it.
- **B14:** Warden counts a tile while its owner has held it continuously since first claiming it. Each tile records who has lost it (`HexTile.lost_by`, saved with the game). A tile taken from an opponent counts; one you lost or abandoned and retook does not.
- **B16** was kept as deliberate behaviour. It is documented in `play_card`, in Strike Team's card note and in `rules/05`.
- **B17:** YAML headers, `rules/01–05` and the CLAUDE.md facts were corrected.

**Held or skipped**
- **Held (per the addendum):** the Bulwark "draw 1" buff and the Grand Strategy "draw 3/4" buff.
- **Skipped:** the optional Watchtower+ change, and every "no change" or watch-list item.
- **Breakthrough:** only the B10 fix is in. The "re-test; cost 7 if still the top card" follow-up is still open.

**Benchmarks after the changes** (900 games for 2p, 600 for 3p; seats rotated)

| Hard vs Hard | Fortress | Vanguard | Swarm |
|---|---|---|---|
| 2p small | 64% (was 61%) | 52% (56%) | 35% (29%) |
| 2p medium | 65% (61%) | 49% (54%) | 41% (39%) |
| 3p small | 41% (38%) | 31% (36%) | 28% (22%) |
| 3p medium | 43% (45%) | 35% (28%) | 30% (25%) |

| Matchup (400 games, small / medium) | Before | After |
|---|---|---|
| Seat 0 win share, identical Hard CPUs (2p) | 62% / 57% | **51% / 50%** |
| Hard vs strike-rush | 81% / 78% | **63% / 62.5%** |
| Hard vs Medium | 64% / 63% | 69.5% / 65.5% |
| Medium vs Easy | 89% / 89% | 91% / 91% |

What the numbers say:
- **The B11 fix removed the seat-0 edge.**
- **Swarm gained 2–6 pp in every configuration but is still the weakest archetype.** Fortress is still the strongest.
- **The drop in Hard vs strike-rush comes from the reworked Road Builder.** The rush bot buys about 3.5 copies a game: a reusable shared power-2 Claim for 3 resources, which takes standard VP hexes (attacker wins ties against neutral defense). When the rush bot isn't allowed Road Builder, Hard wins 81% / 78.5%, the same as before. **Road Builder at cost 3 likely needs cost 4 or power 1/4.** It needs a human playtest; the CPU wasn't tuned to compensate.
- The benchmark now counts a shared victory as a draw rather than a win for `winners[0]`.

**Follow-up applied (same day)**
- **Road Builder → power 1 (2), or 5 (6) when bridging.** At power 2 it was a near-copy of Militia (power 2, or 4 with 3+ adjacent tiles, also cost 3) and doubled the supply of cheap hex-taking Claims. At power 1 it's a distinct pathing card with a big payoff for reconnecting split territory.
- **CPU tie fix.** Medium/Hard assumed a claim had to *exceed* a neutral tile's intrinsic defense. The engine and UI let a tie win, so the CPU undervalued every power-2 claim against standard VP hexes. Fixed in `cpu_player._claim_beats_defense` and `cpu_valuation` (claim-value curve now steps up at power 2). Easy keeps its legacy logic.
- Result (400 games, small / medium): Hard vs strike-rush **83% / 85%** (was 63% / 62.5%; 81% / 78% before the balance pass). Hard vs Medium 64.5% / 64%.

> **Addendum — re-measured with the reworked CPU (same date).** The sims below
> ran against the *old* Hard CPU, whose purchasing over-bought 1–2 cost filler.
> With the new deck-aware CPU (`cpu_valuation.py`), the archetype order flips,
> so treat §3.1/§3.5 and the "help Fortress" items as superseded:
>
> | Hard vs Hard, seats rotated | Fortress | Vanguard | Swarm |
> |---|---|---|---|
> | 2p small (900 games, even = 50%) | **61%** | 56% | **29%** |
> | 2p medium (900) | **61%** | 54% | **39%** |
> | 3p small (600, even = 33%) | **38%** | 36% | **22%** |
> | 3p medium (600) | **45%** | 28% | **25%** |
>
> Command: `cd backend && uv run python scripts/difficulty_benchmark.py hard:hard --games 900 --grid small,medium`
> (add `--players 3` for 3p).
>
> - **Swarm is now the clear outlier.** Its archetype Claims top out at power 1–2,
>   and VP hexes defend at 2/3, so it can't contest hexes without neutral strikes.
>   §4.2's Swarm buffs (Overwhelm 1 action, Hive Mind / Locust Swarm reusable) move
>   up in priority. Hold off on the Fortress buffs (Bulwark draw, Grand Strategy
>   draw 3) until Swarm is fixed and this is re-measured.
> - **Seat 0 wins 62% of 2p small games and 57% of 2p medium games** between
>   identical Hard CPUs. That's B11: same-round target crossings go to the earlier
>   seat. Games are now faster (~7 rounds on small), so it happens more often. It
>   also favours the host (usually seat 0). Fixing B11 is now high priority.
> - The new CPU buys Mercenary rarely (0.1/game) and spends upgrade credits, so the
>   "Mercenary is a CPU trap" and "CPU never upgrades" caveats no longer apply.
>   Base raids are still rare.

Scope: every purchasable card in `data/cards_{vanguard,swarm,fortress,neutral}.yaml`, plus the starters, Rubble, Spoils and Debt. Data is from commit `d9afd57`. Passives and objectives are skipped: `data_loader/loader.py` says they aren't implemented in the engine yet.

**Recommendations only. I didn't edit any YAML or code.** Each change says whether it's **YAML-only** or needs **code**.

---

## 1. Summary: the most important changes

| # | Change | Why (one line) | Conf. |
|---|---|---|---|
| 1 | **Fix the bugs that skew balance first** (§5): Juggernaut gives +2R on every play, Robin Hood pays out for your own Defense cards, Breakthrough auto-claims VP hexes and ignores their defense, Ambush is always power 4 against owned tiles, and the VP-target tie goes to seat 0 | Each one inflates or deflates a card by a whole tier. They also skew every sim number | High |
| 2 | **Eminent Domain**: add `trash_on_use: true` and drop power 3 → 2 (upgraded 4 → 3) | It's the top buy for the "strike rush" policy (1.2 copies/game) and +37 pp in the opening test. It snipes premium VP hexes anywhere on the board from round 2 | Med-High |
| 3 | **Siege Tower**: `unique: true`, cost 8 → 9. **Conqueror**: `unique: true` | Every archetype can buy the big neutral strikes in multiples (+32/+33 pp). That flattens the archetypes and *is* the "buy the biggest strike" plan | Medium |
| 4 | **Strike Team**: cost 4 → 5 | Power 5 for 4 in practice (any other Claim counts, Explore included). Most-bought Vanguard card, +17 to +28 pp win-rate (WR) delta | High |
| 5 | **Arms Dealer**: 2× power → **1×** power | Turns Road Builder (cost 3) into 10R, Spearhead (7) into 16R and Demon Pact (8) into 20R | High |
| 6 | **Base-raid Rubble scaling** (systemic): cap Rubble per raid at 2. If you won't change rules: **Demon Pact** power 10 → 8 (upgraded 12 → 10) | Every point of power over the base's defense becomes a Rubble. Power 8–10 claims are worth far more than their curve, and no defense outside Fortress can stop them | Medium |
| 7 | **Arsenal**: +1 VP per 10 cards → per **12** (upgraded per 10), cost 5 → 6 | Your deck starts at 10 cards, so it's at least 1 VP on purchase: a strictly better Land Grant (7). +15 to +22 pp delta | Medium |
| 8 | **Remove duplicates**: Iron Discipline (= Tithe), Palisade (= Fortify), Caravan (= Frenzy), Elite Vanguard (≈ Siege Tower), Battle Cry (= Forced March in 2p), Swarm Tactics (⊂ Chatter), Second Wave (⊃ Salvage), Coordinated Push (≈ Juggernaut) | The game currently has functional copies. §4 gives a differentiating change for each | Medium |
| 9 | **Defense cards are below the curve as a class.** Make the cheap ones replace themselves: Palisade → "+3 def, draw 1"; Bulwark gets "draw 1"; Phalanx → +1 on 4 tiles | Every Defense card tests ≤ 0 pp in the opening test, even free ones, while every power ≥ 2 Claim tests +10 to +40 pp. They're the only counterplay to strikes | Medium |
| 10 | **Swarm's power-1 Claims**: Overwhelm 2 actions → 1; Hive Mind and Locust Swarm lose `trash_on_use` | Weakest Claims in the test (+1, −3, −10 pp). Power 1 can't take VP hexes, so "go wide" never decides a game | Med-Low |

**Diagnosis behind #2–#6.** A simple policy, "buy the highest-power playable Claim", beat the Hard CPU **86% of the time** (2p small, 600 games, seat randomised). That reproduces your playtest finding. Why it works:
- The starting deck has **zero claim power**: Explore is power 0 and unoccupied-only.
- VP hexes have intrinsic defense (2 standard / 3 premium), and a power tie against a neutral tile goes to the attacker.
- So the first player with a power-3 card owns the hex race. Hexes decided the games: the rusher averaged 3.4–3.9 hex VP vs 0.4–2.0 for its opponent, against a 10 VP target.
- The shared market sells those cards in multiples to every archetype.
- Defense cards are reactive and below the curve, so there's little counterplay.

What the proposed card changes do:
- They cut the rush edge from **86% → 73%** (§3.4).
- A systemic probe that lowers intrinsic hex defense by 1 brings it to **63%**.
- In normal Hard-vs-Hard play they also narrow the archetype gap: 2p small Fortress 33.6 → 37.0%, Vanguard 61.5 → 58.4%.

The rest of the gap is CPU purchasing, which is being reworked. The CPU also never base-raids or upgrades.

---

## 2. Method and value model

**Code read** for every card: YAML, `loader.py` (text-regex fallbacks), `effects.py`, `effect_resolver.py`, and `game_state.py` (play validation, reveal order, VP, buy).

**Bugs were verified with throwaway scripts** against the real engine, not by reading code alone.

**Engine facts that drive value** (several differ from CLAUDE.md or the YAML headers):
- Every archetype gets **5 actions and a 5-card hand**. Actions rarely bind.
- A card whose action return ≥ its action cost (e.g. "Gain 1 action") can be played even at 0 actions left (`game_state.py:1249-1251`). So **"Gain 1 action" ≈ "this card is free to play"**. The scarce resource is the **hand slot**, not the action.
- **Archetype cards are one copy each.** Buying one removes it from your archetype deck for good (`game_state.py:2722-2723`), so `unique` on archetype cards does nothing. Shared cards come in N×2 copies, max 1 per card per player per round.
- **VP is state-based**: tiles//3 + connected VP-hex value (premium 2, standard 1) + card VP. It's checked at end of round.
- **VP hexes have intrinsic defense** (standard 2, premium 3; premium neighbours 1). A tie against neutral intrinsic defense goes to the attacker.
- **Base raid**: power above the base's defense (3 + Defense cards) gives the attacker a **Spoils (+1 VP)** and the defender **(power − defense) Rubble**.
- Costs: re-roll 1, upgrade credit 5. Retain isn't implemented (`RETAIN_COST` is unused).

**Value model** (resource-equivalents, R):

| Unit | ≈ R | Basis |
|---|---|---|
| 1 VP | 7 | Land Grant price |
| 1 tile held | 2.3 | 1/3 VP. A capture is a 2/3 VP swing in 2p |
| Premium / standard VP hex | 16 / 9 | 2 VP + tile / 1 VP + tile |
| Draw 1 now / next round | 2 / 1.5 | Average card ≈ Gather |
| "Gain 1 action" on a non-draw card | ~0.5 | Actions rarely bind |
| Claim power thresholds | 0, 1, 2, 3, 4+ | 0 = uncontested neutral; 1 = undefended enemy tile or premium-neighbour; 2 = standard hex; 3 = premium hex; 4+ = base raid (+1 VP, + Rubble). Each enemy Defense card adds +2 to +5 to the bar |

**Fair reusable 1-action Claim** ≈ power = cost − 1 (Blitz 2/3, Siege Engine 3/4, Garrison 4/5). Adjust by about −1.5 power for 2 actions and about +3 power for trash-on-use. A reusable card bought mid-game gets played about 3–5 times.

The opening test (§3.3) showed the **power-3 threshold matters far more than the curve**. Several mid-cost Vanguard Claims that look under-curve on paper actually test strong, so I dropped the buffs I'd planned for them.

---

## 3. Simulation results

**Setup.** All CPUs are **Hard with noise 0**. Max 20 rounds. Seat order is randomised per game, because the stock CLI always seats the first-listed archetype first, which biases archetype win rates (see B11).

**Harness.** I used a throwaway harness in my scratchpad (not committed) built on the engine's own `CPUPlayer` and phase functions. Beyond the stock runner, it records three things:
- archetype-market offers, and whether each was affordable at buy time;
- final VP sources, Spoils/Rubble/Debt;
- optional card injection, policy swap or in-memory card edits.

Harness configs:

| Config | Games |
|---|---|
| 2p small | 300 per archetype combo × 6 = 1800 |
| 2p medium | 300 × 6 = 1800 |
| 3p small | 120 × 10 = 1200 |
| 3p medium | 150 × 10 = 1500 |

**Stock-CLI cross-check** (reproducible):

```
cd backend && uv run python scripts/run_simulation.py --games 200 --players 2 --grid small --seed 1 --max-rounds 20
```

Same direction, more extreme (fixed seats): Vanguard beat Swarm 75.5%, Vanguard beat Fortress 91.5%, Swarm beat Fortress 82%.

### 3.1 Archetype win rates (current cards)

| Config | Games | Vanguard | Swarm | Fortress | Avg rounds | Seat-0 WR | Simultaneous target crossings |
|---|---|---|---|---|---|---|---|
| 2p small | 1800 | **61.5%** | 54.9% | **33.6%** | 9.8 | 53.6% | 151 (8.4%) |
| 2p medium | 1800 | **60.8%** | 52.1% | **37.2%** | 13.0 | 55.6% | 125 (6.9%) |
| 3p small | 1200 | **48.5%** | 30.3% | **21.2%** | 10.2 | 34.8% | 56 |
| 3p medium | 1500 | **43.4%** | 33.4% | **23.2%** | 12.7 | 34.9% | 70 |

95% CI: ±2.7 pp in 2p, ±2.1–2.8 pp in 3p. Even WR is 50% for 2p and 33% for 3p.

2p head-to-head (small / medium):

| Matchup | Small | Medium |
|---|---|---|
| Fortress vs Swarm (Fortress win %) | 16.8% | 27.0% |
| Fortress vs Vanguard (Fortress win %) | 17.7% | 21.7% |
| Swarm vs Vanguard (Swarm win %) | 36.3% | 35.3% |

**The CPU never base-raided.** Zero Spoils across all logged games. It also almost never upgrades: 40 upgrade credits in 3,600 player-games in 2p small. So sims **understate** two of the strongest human levers: high-power Claims (raids) and upgrades.

### 3.2 Purchase data, controlled for affordability (3p small + medium, 2,700 games)

Delta = WR of players who bought the card − WR of players who could afford it (or had it offered) but didn't. Still confounded by game state; treat as directional.

**Most positive:**

| Card | Delta | Card | Delta |
|---|---|---|---|
| Arsenal | **+22 pp** | Juggernaut | +16 pp (bugged) |
| Warden | +21 pp | Dog Pile | +11 pp |
| Tithe | +17 pp | Mercenary | +10 pp |
| Strike Team | **+17 pp** (bought by 88% who could afford it) | Supply Line | +9 pp |

2p small shows the same pattern: Warden +37, Strike Team +28, Tithe +18, Juggernaut +16.

**Most negative:**

| Card | Delta | Note |
|---|---|---|
| Demon Pact | **−31 pp** | The CPU plays it ~3.6×/game and trashes 3 cards each time |
| Road Builder | −6 pp | Bought 23–49%, **played 0.01–0.02× per game** |
| Colony | −6 pp | |
| Swarm Tactics | −6 pp | |
| Spoils Hoard | −6 pp | |

**Mercenary is a CPU trap**: bought in about 95% of games but played only 0.5–0.8× per game, because the CPU can't fund the 2R play cost.

About 45% of cards are **never bought** by the Hard CPU, so the purchase data says nothing about them.

### 3.3 Opening-deck injection test (2p small mirrors)

I added one copy of card X to a random player's 10-card starting deck and measured that player's win share. The reference is an extra Gather or Explore: 51.0% (Vanguard mirror), 49.0% (Swarm), 53.8% (Fortress). dWR is relative to that reference.

Sample sizes: archetype cards 250 games each (±6 pp); shared cards 100 per mirror × 3 (±6 pp).

This **ignores buy cost** and favours early-game cards. Use it to rank within a cost band and to compare card *classes*.

| Card (cost) | dWR | Card (cost) | dWR | Card (cost) | dWR |
|---|---|---|---|---|---|
| Breakthrough (6) | **+41** | Strike Team (4) | +21 | Supply Line (2) | +7 |
| Eminent Domain (5) | **+37** | Coordinated Push (5) | +19 | Spearhead (7) | +6 |
| Battering Ram (6) | **+37** | Tithe (3) | +18 | Arsenal (5) | +6 |
| Conqueror (7) | +33 | Forward March (3) | +18 | Iron Discipline (3) | +6 |
| Siege Tower (8) | +32 | Flanking Strike (5) | +17 | Levy (2) | +5 |
| Overrun (7) | +32 | Ambush (4) | +17 | Surge (3) | +4 |
| Garrison (5) | +29 | Flood (4) | +17 | Chatter (2) | +3 |
| Siege Engine (4) | +29 | Attrition (3) | +15 | Overwhelm (4) | **+1** |
| Plunder (5) | +29 | Infestation (4) | +15 | Colony (4) | 0 |
| Spoils of War (7) | +28 | Dog Pile (3) | +14 | Muster (4) | −1 |
| Juggernaut (4, bugged) | +27 | Mountaineer (4) | +14 | Watchtower (2) | −3 |
| Ultimatum (10) | +25 | Strength in Numbers (5) | +10 | Rabble (2) | −3 |
| Elite Vanguard (9) | +25 | Militia (3) | +10 | Hive Mind (6) | −3 |
| Rapid Assault (5) | +25 | Prospector (3) | +8 | Land Grant (7) | −5 |
| Blitz (3) | +25 | Proliferate (3) | +6 | Palisade (3) | −6 |
| Mob Rule (6) | +22 | | | Fortify (2) | −6 |

Remaining low scores:

| Card (cost) | dWR | Note |
|---|---|---|
| Warden (4) | −7 | Late-game card; the test penalises it |
| Ironclad (3) | −7 | Same |
| Mercenary (3) | −7 | CPU can't fund it |
| War Banner (7) | −9 | |
| Consecrate (3) | −10 | Dead until you hold a connected hex |
| Road Builder (3) | −10 | Unplayable |
| Iron Wall (3) | −10 | |
| Locust Swarm (7) | −10 | |
| Arms Dealer (3) | −14 | CPU misplay |
| Demon Pact (8) | −29 | CPU misplay |

Takeaways:
1. **Every Claim with power ≥ 3 in the opening is worth +20 to +40 pp. Every Defense card and most VP cards are ≤ 0**, even free-to-play ones like Fortify and Watchtower. The game's value sits almost entirely on claim power, because the hex race is decided by power.
2. The mid-cost Vanguard Claims (Rapid Assault, Coordinated Push, Flanking Strike, Spoils of War, Overrun) test **strong**. No buffs for them.
3. Swarm's power-1 Claims and the Defense class are where the curve is weakest.

### 3.4 Strike-rush policy (reproduces the playtest)

`RusherCPU` uses Hard CPU play logic, but each buy is the highest-power playable Claim it can afford (power ≥ 3). It skips Mercenary and Road Builder, which the CPU can't use. It falls back to normal Hard buys otherwise. 2p small mirrors, 200 games each, rusher seat randomised.

| Variant | Vanguard mirror | Swarm mirror | Fortress mirror | **All (n=600)** | Rusher's top Claim buys / game |
|---|---|---|---|---|---|
| Current cards | 70.5% | 91.5% | 96.5% | **86.2%** | Eminent Domain 1.19, Siege Tower 0.34, Conqueror 0.25, Strike Team 0.17 |
| Proposed changes, partial (all YAML-expressible §4 items except the Eminent Domain power change) | 69.5% | 81.0% | 93.2% | **81.2%** | Eminent Domain 1.22, Conqueror 0.45 |
| **Proposed changes, full** (+ Eminent Domain power 2) | 58.5% | 74.5% | 85.0% | **72.7%** | Conqueror 0.49 |
| Full + systemic probe (VP hexes and premium neighbours −1 intrinsic defense) | 52.5% | 55.5% | 81.5% | **63.2%** | Conqueror 0.42 |

Hex VP for rusher vs opponent with current cards:

| Mirror | Rusher | Opponent |
|---|---|---|
| Vanguard | 3.40 | 2.00 |
| Swarm | 3.79 | 0.79 |
| Fortress | 3.85 | 0.42 |

Notes:
- My first rusher bought Mercenary, which the CPU can't play. It still won 56.7%.
- With Eminent Domain at power 2 the rusher stops buying it (below its power-3 threshold). That's the intended effect: no more cross-map premium-hex snipes.

### 3.5 Archetype balance with the proposed changes (normal Hard vs Hard)

YAML-expressible §4 items. These runs predate the Eminent Domain power change.

| Config | Vanguard | Swarm | Fortress | Fortress vs Swarm | Fortress vs Vanguard | Swarm vs Vanguard |
|---|---|---|---|---|---|---|
| 2p small, current (1800, same seeds) | 61.5% | 54.9% | 33.6% | 16.8% | 17.7% | 36.3% |
| 2p small, **proposed** (1800, same seeds) | **58.4%** | 54.7% | **37.0%** | 23.3% | 24.5% | 42.0% |
| 3p medium, current (1500) | 43.4% | 33.4% | 23.2% | — | — | — |
| 3p medium, **proposed** (1000, different seeds) | **39.3%** | 34.3% | **26.4%** | — | — | — |

Archetype spread narrows by about 6 pp in 2p. Fortress is still behind; most of that is CPU Fortress purchasing (§4.3 note).

**Caveats:**
- CPU-vs-CPU data reflects the current Hard heuristics, which are being reworked.
- The CPU never raids bases or upgrades, so high-power Claims and upgrades are under-valued here.
- Cards the CPU misplays (Demon Pact, Arms Dealer, War Banner, Mercenary, Road Builder, Consecrate) need human playtests.
- Code-level changes (Rubble cap, Robin Hood fix, Battering Ram / Breakthrough defense checks, Arsenal divisor, tie-break) were **not** included in the sims.

---

## 4. Findings and recommendations by archetype

"Dup check" lists the cards I compared to make sure the change doesn't create a copy.

### 4.1 Vanguard

| Card | Current | Proposed | Rationale | Conf. | Dup check |
|---|---|---|---|---|---|
| **Strike Team** (`vanguard_strike_team`) | Cost 4. Power 3, +2 if you played another Claim. Explore counts, and the bonus is recomputed at resolve even if the other Claim comes later, so it's ~always 5 | **Cost 5** | Power 5 for 4 beats every 4-cost Claim (Siege Engine / Juggernaut 3). Bought 64–90% when affordable; +17/+28 pp delta | High | Only card with a claim-count condition |
| **Arms Dealer** (`vanguard_arms_dealer`) | Trash a card; if Claim, gain 2× power R + 1 action | **1× power** (`metadata.multiplier: 1`). YAML-only | 2× pays 10R for a 3-cost Road Builder, 16R for Spearhead, 20R for Demon Pact (verified). 1× still pays for thinning (trashing Explore still gives +1 action) | High | Reclaim / Consolidate pay ½ buy cost; stays distinct |
| **Demon Pact** (`vanguard_demon_pact`) | Cost 8. Power 10 (upgraded 12), reusable; trash exactly 3 others from hand | With a Rubble cap: no change. Without one: **power 8 (upgraded 10)** | A reusable power-10 base raid = +1 VP + 7 Rubble per play. Max single-card temp defense outside Fortress is 5. The CPU self-destructs with it (−29 pp), so sims can't judge it | Med-Low | Spearhead: one-shot 8, no hand tax. Stays distinct by reuse vs 3-card tax |
| **Elite Vanguard** (`vanguard_elite_vanguard`) | Power 6, 2 actions, cost 9 − VP hexes (upgraded 8). Same stats as Siege Tower (6 / 2 actions / 8, upgraded 8) | **Power 5, 1 action (upgraded 7)** | Removes the duplicate. Fits "Vanguard = fast" without raising the power ceiling | Medium | Conqueror (5, 2 actions, ignore defense), Battering Ram (5/7, 2 actions), Overrun (4, 2 actions, range 2): none is a 1-action 5 |
| **Battle Cry** (`vanguard_surge_protocol`) | Cost 4. Gain 2 actions; one opponent gets +1 action next round. In 2p this equals Forced March (cost 3) | **Add "Draw 1 card next round"** (`draw_next_turn` 1, on_resolution) | Same card as a cheaper neutral in 2p | Medium | Double Time (immediate draw, no drawback, 5), Forced March (no draw) |
| **Coordinated Push** (`vanguard_coordinated_push`) | Power 3, Stackable, cost 5. The "+1 action if stacked" is upgrade-only. ≈ Juggernaut (3, Stackable, +R, 4) | **Move "+1 action if you already played a Claim on this tile" into the base card** (`grant_actions_if_stacked` value 1). Upgraded keeps power 4 | Gives each stackable a distinct rider: Dog Pile +power, Juggernaut +R, Push +action | Med-Low | Dog Pile, Juggernaut |
| **Arsenal** (`vanguard_arsenal`) | Cost 5, +1 VP per 10 cards in deck. Decks start at 10 | **Per 12 (upgraded per 10), cost 6.** Code: divisor in `game_state._compute_formula_vp` | ≥ 1 VP at purchase → strictly better than Land Grant (7). +15/+22 pp | Medium | Land Grant (flat 1 VP) |
| **Breakthrough** (`vanguard_breakthrough`) | Cost 6, power 3. On success auto-claims a random adjacent neutral tile, **ignoring intrinsic defense** (B10: takes premium VP hexes free) | **Auto-claim only tiles with 0 defense** (code). Re-test after; if still the top card, cost 7 | Highest opening score (+41 pp), partly from free hexes | Medium | — |
| Regroup (`vanguard_rally`) | Draw 2, discard 1, gain 1 action, cost 4. Strictly worse than Muster (draw 2, gain 1 action, 4) | **Cost 3** | Removes a dominated card at equal cost | Low | Cartographer (no action), Muster |
| War Banner (`vanguard_war_banner`) | Cost 7: next Claim +2 power (+draw on success) | **Cost 5** | −9 pp; never bought. A card + 7R for +2 power once is poor | Low | Swarm Tactics proposal is +1 power only |
| Financier (`vanguard_financier`) | Cost 8 (note says 7): draw 1 per Debt | **Cost 5; fix the note** | Only works for a long-time VP leader | Low | — |
| War Tithe (`vanguard_war_tithe`) | Upgraded double-draws (B6) | Bug fix only | — | — | — |
| Counterattack (`vanguard_counterattack`) | +2 defense, draw-on-hold never fires (B4). Dominated by Watchtower (+2, gain 1 action, 2) | Fix the bug. Then **defense 2 → 3 (upgraded 4)** | Below the curve even when fixed | Low | Palisade proposal (+3, draw now), Fortify (+3, gain 1 action) |

**Watch list (no change yet):**
- Plunder (+29 pp; 4R + gain 1 action + delayed draw at 5).
- Blitz (+25 pp at 3).
- Spearhead: fine once the Arms Dealer fix and Rubble cap land.

### 4.2 Swarm

| Card | Current | Proposed | Rationale | Conf. | Dup check |
|---|---|---|---|---|---|
| **Overwhelm** (`swarm_overwhelm`) | Cost 4, **2 actions**, power 1 + 1 per adjacent owned tile | **1 action** | Weakest Claim tested (+1 pp). Dominated by the neutral Militia (3 cost, 1 action, 2/4) | Medium | Militia (threshold), Mob Rule (per 4 tiles): scaling stays distinct |
| **Hive Mind** (`swarm_hive_mind`) | Cost 6, trash: power 1 on up to 4 tiles | **Remove `trash_on_use`** | −3 pp. A one-shot 4-tile power-1 spray at 6 loses to reusable Flood (4, +17) | Med-Low | Flood (all neighbours of one owned tile), Surge (2 tiles) |
| **Locust Swarm** (`swarm_locust_swarm`) | Cost 7, trash: power tiles/3 on 2 tiles | **Remove `trash_on_use`** | −10 pp | Low | Mob Rule (one tile, 2 actions) |
| **Swarm Tactics** (`swarm_swarm_tactics`) | Draw 1, gain 1 action, cost 2. Chatter has the same text plus a bonus draw | **Add "Your next Claim this round gets +1 power"** (`claim_buff_next_n`, power_bonus 1) | Currently strictly dominated | Med-Low | War Banner (+2, cost 7), Chatter (draw) |
| **Second Wave** (`swarm_second_wave`) | Discard → hand 1, gain 1 action, cost 2. = Salvage (3) + action, for 1 less | **Claim cards only** (`filter: {card_type: claim}`) | Removes a cross-pool near-duplicate; fits "second wave of attackers" | Low-Med | Mobilize Forces (2 Claims, 5), Salvage (any card) |
| **Phalanx** (`swarm_safety_in_numbers`) | +1 defense on 2 tiles, cost 3 | **+1 on up to 4 tiles (upgraded +2 on 4)** | Weakest Defense card. +1 on many tiles stops power-1 raids on a wide board | Low-Med | Moat (+2 ×3, gain 1 action), Bulwark |
| Consecrate (`swarm_consecrate`) | +1 VP-hex value (permanent), trash, cost 3 | **Cost 4** | 1 VP for 3R is cheap vs Land Grant (7). The CPU gets little from it (dead until you hold a connected hex) | Low | — |
| Stampede (`swarm_blitz_rush`) | Gain 3 actions, no buys, cost 4 | **Cost 2** | Actions rarely bind; the buy-lock is severe | Low | Grand Strategy (draw), Forced March |
| Hatching Grounds (`swarm_hatching_grounds`) | Generated Rabbles share one `id`, so they **never chain** (B9) | Bug fix; re-evaluate | — | — | — |
| Colony (`swarm_colony`) | +1 VP per disconnected group of 3+ | No change; needs a human playtest | The CPU can't build for it (0 pp / −6 pp) | — | — |

### 4.3 Fortress

| Card | Current | Proposed | Rationale | Conf. | Dup check |
|---|---|---|---|---|---|
| **Juggernaut** (`fortress_overwhelming_force`) | Text: +2R if the target is neutral. Actual: **+2R on every play** (B1) | **YAML-only fix:** replace the effect with `gain_resources` 2 / upgraded 3, timing immediate, `condition: if_target_neutral`. Verified: +2 neutral, +0 enemy | +27 pp opening / +16 pp delta are inflated by the bug | High | — |
| **Iron Discipline** (`fortress_iron_discipline`) | Gain 2R, draw 1, gain 1 action, cost 3: **identical to Tithe** (shared, 3) | **Add "Draw 1 card next round", cost 4** | Removes the duplicate. Same opening score as Tithe in the Fortress mirror (+6 vs +7) | Medium | Plunder (4R, delayed draw, gain 1 action, Vanguard 5) |
| **Robin Hood** (`fortress_robin_hood`) | Counts your own Defense plays as "tiles lost" (B2) | Code fix | — | High | — |
| **Bulwark** (`fortress_bulwark`) | +2 defense on 2 tiles, no action gain, cost 3. Dominated by Moat (+2 ×3, gain 1 action, 4) | **Add "Draw 1 card"** (upgraded: 3 tiles, draw 1, gain 1 action) | Defense must replace itself to be worth a hand slot | Med-Low | Moat (more tiles, gain 1 action, no draw) |
| **Grand Strategy** (`fortress_war_council`) | Draw 2, gain 1 action, **no buys**, cost 3. Worse than Muster (draw 2, gain 1 action, 4) | **Draw 3 (upgraded 4)** | The buy-lock needs a real payoff | Med-Low | Muster, Stampede |
| **Battering Ram** (`fortress_battering_ram`) | Power 5, +2 if the target "has any defense bonuses". The check counts **intrinsic** defense (B13), so it's power 7 vs every VP hex and base | **Count only Defense-card/permanent bonuses** (code, per its text) | +37 pp at cost 6, a human strike-rush card. Little impact on CPU win rates (bought 0.8%) | Low-Med | Conqueror, Siege Tower |

**Fortress note.** Fortress loses 63–83% of its 2p games. Its strongest cards in testing are its *Claims* (Battering Ram, Garrison, Siege Engine, Juggernaut: +27 to +37 pp). Its Defense cards and VP passives test ≤ 0 early (Fortify −6, Iron Wall −10, Warden / Ironclad −7). The CPU's Fortress buys mostly the latter, ending with the biggest deck (24–28 cards vs Vanguard's ~20).

What helps Fortress: the Defense-class buffs (Bulwark here; Palisade and Phalanx elsewhere), Grand Strategy, and a CPU purchasing fix.

**Warden is fine**: −7 pp in the opening test, but +21/+37 pp when bought at its usual time.

### 4.4 Neutral / shared (highest leverage: every archetype can buy multiples)

| Card | Current | Proposed | Rationale | Conf. | Dup check |
|---|---|---|---|---|---|
| **Eminent Domain** (`neutral_eminent_domain`) | Cost 5. Power 3 on **any** neutral tile, reusable, multi-copy | **`trash_on_use: true` and power 2 (upgraded 3)** | Top rusher buy (1.2 copies/game), +37 pp opening. Tie-to-attacker means power 3 takes premium hexes anywhere from round 2. Rush WR 81% → 73% with this change. Power 2 still takes standard hexes. One-shot keeps the "seizure" flavour | Med-High | Proliferate (power 1 reusable, Swarm). Proliferate+ is power 2 reusable, so one-shot keeps them distinct |
| **Siege Tower** (`neutral_siege_tower`) | Power 6, 2 actions, cost 8, 2N copies | **`unique: true`, cost 9** | +32 pp. Multi-copy power 6 for every archetype homogenises the archetypes. `unique` already works for shared cards (`buy_card` checks it) | Medium | Elite Vanguard now power 5 / 1 action; Battering Ram (Fortress) |
| **Conqueror** (`neutral_conqueror`) | Power 5, 2 actions, ignore temp defense, cost 7 | **`unique: true`** | +33 pp. It became the rusher's top buy once Eminent Domain was fixed | Med-Low | Siege Engine (3, Fortress) |
| **Palisade** (`neutral_palisade`) | +3 defense, gain 1 action, cost 3: **identical to Fortify** (Fortress, cost 2) | **"+3 defense. Draw 1 card."** No action gain (upgraded +5, draw 1) | Removes the duplicate and makes neutral defense replace itself (Defense tests ≤ 0). Fortress keeps the cheaper free-action Fortify | Medium | Watchtower+ (+3, draw 1, gain 1 action) overlaps an *upgraded* card. Optionally change Watchtower+ to "+3, +1R" |
| **Caravan** (`neutral_caravan`) | Discard 1, gain 2 actions, cost 4: **identical to Frenzy** (Swarm, 3) | **Base becomes "Discard 1, draw 1, gain 2 actions"** (today's upgrade); upgraded draws 2 | Removes the duplicate | Medium | Double Time (draw 1, gain 2 actions, no discard, 5) |
| **Road Builder** (`neutral_road_builder`) | Power 5, only on a tile that bridges your disconnected groups | **"Power 2. If this tile connects two of your disconnected groups, power 5"** (needs a new condition type) | Unplayable (0.01–0.02 plays/game when bought; −10 pp). A dead card for buyers, plus Arms Dealer fodder | Medium | Militia (adjacency count), Mountaineer (neutral) |
| **Ambush** (`neutral_ambush`) | Text: power 4 if an opponent also claims. Actual: also power 4 vs **any opponent-owned tile** (B7) | **Change the text to match the code**: "If the target is owned by or also claimed by an opponent, power 4" | +17 pp at 4 is fine as an anti-player tool | Low-Med | Attrition, Siege Engine |
| **Surveyor** (`neutral_surveyor`) | Cost 2: 1 free re-roll. Re-roll costs only 1R, so this is a worse Gather | **Gain 1 action; 2 free re-rolls (upgraded 3)** | Currently worthless | Low-Med | — |
| **Diplomat** (`neutral_diplomat`) | +1 Land Grant for you and +1 for each opponent: net 0 VP in 2p, negative in 3p+ | **Base: you get 2 (today's upgrade). Upgraded: 2 for you, opponents get none** (code: handler hardcodes counts) | Pure tempo when leading; otherwise a trap | Low | Land Grant |
| Rally Cry (`neutral_rally_cry`) | Upgraded's "+1 power" isn't implemented (B8) | YAML fix: add `claim_buff_next_n` value 0 / upgraded 5, power_bonus 1 (verified) | — | — | — |
| Cease Fire (`neutral_cease_fire`) | Upgraded draws 2, not 3 (B3) | Code fix | — | — | — |
| Dividends (`neutral_dividends`) | Weak (holdings are low when it's played); upgraded double-draws (B5) | **Divisor 3 → 2**; set `upgraded_draw_cards: 0` | — | Low | Prospector (flat) |
| Cartographer (`neutral_cartographer`) | Discard 2, draw 2, costs an action → net −1 card | **Add "Gain 1 action"** | Filtering shouldn't cost a card | Low | Mulligan (whole hand), Regroup |
| Sift (`neutral_sift`) | Look at 2, no card gain, cost 3 | **Cost 2, add "Gain 1 action"** | Same reason | Low | Forward Scout (to hand) |
| Foresight (`neutral_foresight`) | 2 actions, cost 7 | **1 action** | Pricey tutor | Low | Brood Memory |
| Sabotage (`neutral_sabotage`) | −1 card for one opponent, cost 5 | **Cost 4** | Card-for-card trade; overpriced | Low | Attrition |
| Mercenary (`neutral_mercenary`) | Power 3 (upgraded 4), cost 3, pay 2R to play | **No card change.** CPU fix: it buys it 95% of the time and can't fund it | Fair for humans (total cost ≈ 3 + 2R per play) | — | — |

### 4.5 Systemic levers (not card changes, but they drive card value)

- **Rubble per raid**: currently `power − defense`, uncapped (`game_state.py:2316-2318`). A cap of 2 makes power beyond ~5 a much smaller payoff. It also makes Demon Pact and Spearhead safe at current numbers.
- **VP-hex intrinsic defense / neutral tie rule** (`hex_grid.py:264-280`, `game_state.py:2216-2224`). Lowering hex defense by 1 cut the rush edge from 73% to 63%, because cheap power-1/2 Claims can contest hexes again. The opposite choice, defender wins ties vs neutral, *raises* the power you need and would make strikes stronger. Decide and document the tie rule either way.
- **Opening has 0 claim power** (Explore power 0). Any power-3 card decides the hex race. The levers above are the cleanest fix; changing Explore alone doesn't reach hex defense.

---

## 5. Text / implementation mismatches (bugs)

All of these were confirmed by running the engine unless marked "code read".

| ID | Card / system | What happens | Where | Fix |
|---|---|---|---|---|
| B1 | **Juggernaut** | `loader.py` regex parses "gain 2 resources" into an unconditional `resource_gain`, because `resource_refund_if_neutral` is missing from the skip list. Result: +2R on **every** play, including vs enemy tiles. The real refund is checked after ownership changes, so it only pays when the claim **fails** on a neutral tile (+4 total) | `backend/app/data_loader/loader.py:93-99`; `effect_resolver.py:832`; `game_state.py:2383` (claim on_resolution runs after the tile mutation) | YAML-only fix in §4.3. Also add the type to the loader skip list |
| B2 | **Robin Hood** | `tiles_lost_last_round` counts every resolution step whose previous owner is you, including your own `defense_applied` steps and successful defenses. Bulwark+ on 3 own tiles → 3 "lost" → next Robin Hood +9R (+15 upgraded) | `game_state.py:2569-2575` | Count only steps where `winner_id != previous_owner` |
| B3 | **Cease Fire+** | The handler uses `effect.value`, so upgraded draws 2 instead of 3. The YAML also has a duplicate `upgraded_value` key | `effect_resolver.py:952`; `cards_neutral.yaml` (cease_fire effects) | `effect.effective_value(is_upgraded)` |
| B4 | **Counterattack** | Defense cards resolve before claims, with `claim_succeeded=None`, so the `if_defender_holds` draw **never fires**. Its `defense_bonus` effect has no handler, so every play logs `[STUB]` (the defense still applies via the field) | `game_state.py:2116-2118`; `cards_vanguard.yaml:374-382` | Re-run the draw check after claims, or make the draw unconditional |
| B5 | **Dividends+** | The loader parses "Draw 1 card" **and** the handler draws 1, so it draws 2 | `loader.py:110-115` (resource_scaling not skipped); `effect_resolver.py:1368-1371` | YAML: `upgraded_draw_cards: 0` |
| B6 | **War Tithe+** | Draws 1 now (loader parse) **and** 1 next round (handler `upgraded_draw`). Text says "Draw 1 card" | `effect_resolver.py:1265-1268` + loader | YAML: `upgraded_draw_cards: 0`, and the text should say "next round" |
| B7 | **Ambush** | `IF_CONTESTED` is also true when the tile is owned by an opponent, so it's power 4 vs every enemy tile | `effect_resolver.py:449-453` | Update the text (recommended) or drop the owner clause |
| B8 | **Rally Cry+** | "+1 power" isn't implemented (only Stackable, plus a draw parsed from text) | `cards_neutral.yaml` (rally_cry effects) | YAML: `claim_buff_next_n` 0 / upgraded 5, power_bonus 1 |
| B9 | **Hatching Grounds / Master Engineer** | Generated copies are `deepcopy`'d without a new `id`. Rabble's "another Rabble" checks use `card.id !=`, so generated Rabbles never trigger each other: 2 played → +0 actions. Duplicate ids can also break frontend keys and undo | `effect_resolver.py:2105` | Assign a unique id per clone, e.g. with `_copy_card` |
| B10 | **Breakthrough** | Auto-claim picks any unowned, unblocked neighbour, ignoring intrinsic defense. Took a premium VP hex (defense 3) in 40/40 setups | `effect_resolver.py` `_handle_auto_claim_adjacent_neutral` | Only tiles with `defense_power == 0` |
| B11 | **VP-target tie** | When several players reach the target in the same round, the first in `player_order` wins regardless of VP. Happened in 7–8% of 2p games; seat 0 won 53.6–55.6% in 2p | `game_state.py:3138-3145` | Highest VP wins, then a tiebreaker |
| B12 | **Arms Dealer** | Uses `card.effective_power` (printed or upgraded), not "printed modifiers" as its note says (Strike Team counts as 3) | `effect_resolver.py:1797` | Fix the note |
| B13 | Battering Ram / Watchful Keep | "Defense bonus" checks treat intrinsic defense (base 3, hexes 2–3) as a bonus. Battering Ram is always 7 vs hexes and bases; Watchful Keep always draws ≥ 1 | `effect_resolver.py` `IF_TARGET_HAS_DEFENSE`, `_handle_draw_per_tiles_with_defense_bonus` | Compare against `base_defense` |
| B14 | Warden (code read) | Counts `capture_count == 0`. A tile you captured from an opponent never counts, even though it "never changed hands since you claimed it" | `game_state.py` `_compute_formula_vp` (uncaptured_tiles_8) | Track ownership since your claim |
| B15 | Battle Glory (code read) | Counts only captures from opponents, not contested neutral wins (text: "contested tiles") | `effect_resolver.py` `_handle_vp_from_contested_wins` | Clarify the text |
| B16 | Snapshot quirk (code read) | Conditional power is frozen at play only if it differs from base; otherwise it's recomputed at resolve. Strike Team gets +2 even if the other Claim comes *after* it, and Battering Ram sees the opponent's same-round Defense cards | `game_state.py` play_card snapshot block (~1440-1500) | Document, or always snapshot |
| B17 | Stale docs | Financier note says cost 7 (it's 8). YAML headers say 4/4/3 action slots (code: 5 for all). CLAUDE.md says Explore is power 1 (YAML: 0). `rules/01`, `rules/04` say Rubble = −1 VP and bases 2/3/4 defense (code: 0 VP, all 3; Spoils +1 VP undocumented). Retain cost is defined but there's no Retain action | various | Update docs |

---

## 6. Reviewed and considered fine (no change)

- **Neutral:** Gather, Explore (see §4.5), Levy, Militia, Mercenary (card OK; CPU issue), Prospector, Tithe (strong, but it's the archetype-neutral econ baseline), Muster, Spyglass, Cull, Reclaim, Watchtower, Moat, Barricade, Forced March, Tax Collector, Supply Depot, Salvage, Recall, Redemption, Mobilize (optionally `upgraded_trash_on_use: false`, since its upgrade is weak), Land Grant (anchor), Rubble, Spoils, Debt.
- **Vanguard:** Blitz, Overrun, Rapid Assault, Flanking Strike, Spoils of War, Forward March, Spearhead, Ultimatum, Double Time, Plunder (watch), Battle Glory (needs a human test), Rearguard, Mobilize Forces, Forward Scout, Commander, Pursuit, War Economy.
- **Swarm:** Surge, Proliferate, Flood, Rabble, Dog Pile, Thin the Herd, Strength in Numbers, Frenzy (Caravan changes instead), Scavenge (≈ Gather; low impact), Nest, Mob Rule, Spoils Hoard, Heady Brew, Plague, Infestation, Exodus, El Dorado, Brood Memory, Chatter, Drone Wave, Colony (needs a human test).
- **Fortress:** Warden, Fortify, Siege Engine, Iron Wall (the only hard counter to big strikes; keep it), Garrison, Mountaineer, Supply Line, Entrench, Attrition, Stronghold, Consolidate, Twin Cities, Ironclad, Toll Road, Resilience, Mulligan, Scorched Retreat (its upgrade, +4R on a one-shot, is worth less than the 5R credit), Snowy Holiday, Aegis, Stockroom, Reserve Forces, Quartermaster, Watchful Keep, Master Engineer (fix B9).
- **Weak upgrades on trash-on-use cards** (Mobilize+, Redemption+, Heady Brew+, Scorched Retreat+, Infestation+): the 5R credit is consumed after one use. Low priority. Consider `upgraded_trash_on_use: false` where that's safe.
