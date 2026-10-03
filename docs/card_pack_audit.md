# Card Pack Audit

Run after the card balance pass. Covers the 9 curated packs in
`backend/app/game_engine/card_packs.py` and the daily pack generator. Packs only
choose the **shared market**; every archetype card is always available.

## Applied (2026-10-03)

The designer approved every proposal below. Applied: Iron & Coin (Mobilize →
Militia), Frontier Tactics (Supply Depot → Militia), Shock & Awe (Spyglass →
Watchtower), Grand Strategy (Forced March → Militia), Lean Machine (Recall →
Militia), Rapid Advance (Palisade → Watchtower), War Economy (Tax Collector →
Prospector), and Hold the Line kept as is but labelled.

Every pack also gained a player-facing `description`, shown in the lobby. The
daily generator now guarantees a reusable power-2+ Claim, a Defense card and a
resource card (`tests/test_card_packs.py` checks every day of 2026). All pack
comments match the card data.

**Re-measured after the swaps** (2p small, 400 games, before → after):

| Pack | vs rush | Fortress | Vanguard | Swarm |
|---|---|---|---|---|
| Iron & Coin | 56 → **70%** | 62 → 73% | 47 → 47% | 26 → 29% |
| Frontier Tactics | 63 → **70%** | 64 → 69% | 50 → 52% | 24 → 25% |
| Shock & Awe | 56 → 56% | 60 → 60% | 56 → 56% | 33 → 32% |
| Grand Strategy | 55 → 56% | 63 → 66% | 55 → 52% | 25 → 21% |
| Mini: Lean Machine | 53 → 56% | 58 → 66% | 57 → 62% | 22 → 20% |
| Mini: Rapid Advance | 54 → 57% | 63 → 67% | 58 → 53% | 23 → 27% |
| Mini: War Economy | 67 → 67% | 72 → 71% | 51 → 51% | 26 → 25% |

(Per-archetype buckets are about 130 games each, ±4–5 pp.)

**Outcome:**
- Rush resistance improved clearly in Iron & Coin and Frontier Tactics.
- Rapid Advance's theme is restored.
- Adding Militia did **not** lift Swarm, because Fortress profits from Militia's
  adjacency bonus just as much. Fortress edged up in several packs.

That confirms the Swarm/Fortress gap is an archetype-level problem (see the
closing section). It's the recommended next balance step.

The analysis below is the pre-swap audit, kept for reference.

## How to read the numbers

- **Archetype %** is from Hard vs Hard on a 2p small map: 400 games, seats
  rotated, opponent archetype random. Even is 50%. 3p (300 games, even 33%) is
  noted where it differs.
- **vs rush** is Hard's win rate against the strike-rush bot, which buys only the
  biggest Claims. Low numbers mean a simple "buy every big Claim" plan meets
  little counterplay in that pack.
- **Hex threshold:** a tie against a neutral tile's intrinsic defense goes to the
  attacker, so power 2 takes a standard VP hex (defense 2) and power 3 a premium
  one (defense 3).

```
cd backend && uv run python scripts/difficulty_benchmark.py hard:hard hard:rush --games 400 --grid small --pack <id>
```

## Summary

| Pack | Valid? | Fortress | Vanguard | Swarm | vs rush | Verdict |
|---|---|---|---|---|---|---|
| Everything | ✓ | 63% | 50% | 32% | 83% | Baseline |
| Iron & Coin | ✓ | 62% | 47% | 26% | 56% | Good theme; no defense, so rush-prone |
| Frontier Tactics | ✓ | 64% | 50% | **24%** (3p 17%) | 63% | Bridge combos now work; Swarm starved |
| Shock & Awe | ✓ | 60% | 56% | 33% | 56% | On-theme aggro; no counterplay |
| Grand Strategy | ✓ | 63% | 55% | 25% | 55% | No shared Claims or economy |
| Second Wind | ✓ | 63% | 51% | **37%** | **76%** | Healthiest pack, rich combos |
| Hold the Line | ✓ | 62% (3p 49%) | 59% | **22%** | 55% | Fortress-favored by design |
| Mini: Lean Machine | ✓ | 58% | 57% | **22%** | 53% | Pure engine; Swarm can't contest |
| Mini: Rapid Advance | ⚠ theme | 63% | 58% | 23% | 54% | Palisade broke the "everything gives actions" theme |
| Mini: War Economy | ✓ | **72%** | 51% | 26% | 67% | Tax Collector snowballs Fortress |

Takeaways:
1. **Every pack is technically valid.** All ids exist and are purchasable shared
   cards, and every archetype has a way to take VP hexes in every pack.
   - Swarm's access is narrow and situational: Dog Pile, Overwhelm, Strength in
     Numbers, Mob Rule.
   - Four packs have no shared Claim at all: Grand Strategy, Hold the Line, Lean
     Machine and Rapid Advance.
2. **Swarm is weakest in every pack (22–37%), and worst where the shared market
   has no Claims.** That is an archetype problem more than a pack problem; see
   the closing note. Packs that hand out a reusable power-2 Claim (Militia, Levy+)
   or recursion help Swarm the most.
3. **Fortress is strongest in every pack (58–72%).** Packs that reward holding VP
   hexes (Tax Collector, defense stacks) widen the gap.
4. **Narrow packs are rush-prone.** Hard beats the rush bot 83% with everything
   available, but only 53–56% in most curated packs. The exceptions are Second
   Wind (76%), War Economy (67%) and Frontier (63%). Shared defense, recursion or
   tempo answers give the counterplay.

## Per pack

### Iron & Coin — keep, one swap
- **Works:**
  - Tax Collector (+3💰 per connected VP hex) + Mercenary: the economy pays
    Mercenary's 2💰 play cost.
  - Dividends rewards banking.
  - Salvage recurs Mercenary.
  - Arms Dealer scraps a spare Mercenary for 3💰.
- **Weak:** Mobilize. With 5 actions and a 5-card hand, actions rarely bind, so
  "+1 action per card played" is dead without draw. This pack has almost no draw.
- **Proposed:** Mobilize → **Militia**. It gives Swarm a reusable claim that hits
  power 4 when surrounded, and it fits "economy fuels combat".

### Frontier Tactics — keep, one swap
- **Works (and improved by the balance pass):**
  - Eminent Domain drops a remote tile, then Road Builder bridges to it at power 5.
  - Proliferate or Flanking Strike leave gaps that Road Builder turns into power-5
    bridges.
  - Swarm Colony vs Road Builder becomes a real choice: keep groups apart for
    Colony VP, or join them for connected VP hexes.
- **Problem:** the only reusable shared Claim is Road Builder at power 1. There is
  no economy card, so Swarm sits at 24% (17% in 3p).
- **Proposed:** Supply Depot → **Militia**. It's territorial, so it fits "board
  position", and it gives everyone a reusable hex-capable Claim. Supply Depot's
  next-round value is generic and duplicated in three other packs.

### Shock & Awe — keep, one swap
- **Works:**
  - Rally Cry (+1 power to your next 5 Claims when upgraded) + Coordinated Push /
    Dog Pile / Militia stacks.
  - Ambush punishes pushes.
  - Conqueror vs Siege Tower, now one of each per player.
  - Forced March pays a finisher's 2-action cost.
- **Problem:** the pack has no shared defense, so 56% vs rush. Aggression is the
  theme, but it currently has no answer.
- **Proposed:** Spyglass → **Watchtower** (+2 defense, gains its action back).
  It's a tempo-neutral defense that fits the pace, and Spyglass is weak filler
  already in three other packs.

### Grand Strategy — keep, one swap
- **Works:**
  - Cull + Sift + Cartographer (all now gain an action) sculpt the deck.
  - Muster + Caravan (Caravan now draws) chain.
  - Foresight (now 1 action) tutors finishers.
- **Problem:** no shared Claims and no economy, so the long chains have nothing to
  cash in on the board. Swarm 25%, 55% vs rush.
- **Proposed:** Forced March → **Militia**. Caravan, Mobilize and Muster already
  make actions, and Forced March also gifts opponents an action. A reusable
  hex-capable Claim gives the engine turns a payoff.

### Second Wind — keep as is
- Best-balanced pack: Swarm 37%, 76% vs rush. The comments now list the combos
  the balance pass created:
  - Spearhead + Redemption: a second power-8 strike.
  - Consecrate + Redemption: raise a VP hex twice.
  - Hatching Grounds / Master Engineer + Redemption: a second batch of cards.
  - Mobilize + Redemption.
  - Salvage recurs a unique finisher.

### Hold the Line — keep the identity, label it
- Pure defense by design: no shared Claims. Fortress 62% (49% in 3p), Swarm 22%.
- Tax Collector (+3💰 per connected VP hex) snowballs whoever defends hexes, which
  is Fortress.
- **Option A (recommended):** keep it and describe it in the lobby as
  "slow, defensive, Fortress-favored".
- **Option B:** Surveyor → **Ambush** ("hold the line and strike back").
  Ambush hits power 4 against an opponent's tiles, which gives non-Fortress
  archetypes a way through. This breaks the "no neutral Claims" rule in the
  comment.

### Mini: Lean Machine — keep, optional swap
- **Works:**
  - Spoils Hoard (+1 VP per 5 trashed) with Cull / Reclaim / Thin the Herd.
  - Consolidate + Reclaim.
  - Arms Dealer.
  - Recall + Cartographer.
- **Problem:** five engine cards and no Claims, so Swarm 22%.
- **Optional:** Recall → **Militia**. A lean deck draws its best Claim more often.
  Skip it if the mini should stay pure deck-craft.

### Mini: Rapid Advance — fix the theme
- **Broken:** the pack is "every shared card pumps actions", but Palisade now
  draws a card instead of giving an action.
- **Proposed:** Palisade → **Watchtower** (+2 defense, gain 1 action). That
  restores the theme exactly.

### Mini: War Economy — one swap
- **Works:**
  - Levy → Militia → Mercenary claim curve.
  - War Tithe + Mercenary.
  - Robin Hood, which now pays only for real captures.
- **Problem:** Fortress 72%, the most lopsided pack. Tax Collector (+3💰 per
  connected VP hex) pays the player who holds hexes best.
- **Proposed:** Tax Collector → **Prospector** (+4💰 flat). It keeps the economy
  theme without the hold-hexes snowball.

## Daily pack generator — tighten constraints (proposal)

Across all 365 daily packs of 2026:
- **14%** have no reusable shared Claim of power 2 or more, so nothing in the
  shared market can take a hex.
- **23%** have no Defense card.
- **48%** have no card that gains resources.

The current guarantees are only "≥1 Claim, ≥1 Engine, ≥1 card costing 1–2, ≥1
costing 4+". The Claim guarantee can be met by Levy or Road Builder (power 1).

**Proposed constraints** in `generate_daily_pack`:
- ≥1 reusable Claim with power ≥ 2 (Militia, Mercenary, Ambush, Conqueror, Siege
  Tower).
- ≥1 Defense card.
- ≥1 resource-gaining card.

Keep the existing cost-band constraints. Changing the generator changes which
cards a given date produces. Games in progress keep their market, but a daily pack
id regenerated later would differ, so ship it with a version note.

## Not a pack problem: Swarm

Swarm trails in all ten configurations. Its archetype Claims are mostly power 1,
and its hex breakers are situational: Dog Pile needs a stack partner, and
Overwhelm and Militia need surrounding tiles. The pack swaps above add Militia in
four packs, which helps.

The structural fix is at the archetype level. Two candidates for the next balance
pass:
- Dog Pile cost 3 → 2.
- Overwhelm base power 1 → 2.

Re-measure with `hard:hard` after any change.
