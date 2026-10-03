# CPU Difficulty Rebalance

Goal: make Medium and Hard more challenging, especially Hard. Playtest signal:
Hard was easy to beat by "just getting high value strike cards".

All numbers come from `backend/scripts/difficulty_benchmark.py`:
2-player games, seats rotated, archetypes randomized, 300–400 games per row.
The "rush" bot uses Hard's play logic but buys only the highest-power Claim it can
afford (saving otherwise), which reproduces the strike-card strategy.

## Results

| Matchup (win % for the first agent) | Before (small) | After (small) | After (medium) |
|---|---|---|---|
| Hard vs Easy | 58% | **98%** | 96% |
| Hard vs Medium | 54% | **64%** | 63% |
| Medium vs Easy | 56% | 89% | 89% |
| Hard vs strike-rush | 18% | **81%** | 78% |
| Medium vs strike-rush | 17% | 64% | 68% |
| Easy vs strike-rush | 15% | 13% | 13% |
| Hard vs greedy ("buy the priciest card") | 34% | 88% | 86% |
| New Hard vs old Hard | — | **94%** | 95% |
| New Medium vs old Hard | — | 87% | 86% |
| New Easy vs old Easy | — | 47% | 51% |

Easy plays at the same strength as before, as intended. Medium now beats the old
Hard nearly 9 times in 10. Hard beats Medium about 2 games in 3.

## What was wrong

1. **Purchasing favoured cheap filler.** Every purchase score was divided by
   `cost × 0.5 + 0.5`, so a 1-cost card looked about 4× better than a 7-cost one.
   - Hard bought Spyglass (cost 1) 3.3 times per game.
   - It almost never bought the power-3/4 Claims that matter. VP hexes defend at
     2 (standard) or 3 (premium), and starter Explores are power 0, so whoever buys
     power first wins the hex race.
2. **"Noise" was score-proportional sampling.** Even Hard (noise 0.05) picked an
   8-point option over a 10-point one about 45% of the time. That flattened the
   three tiers into nearly the same player.
3. **Upgrade credits were bought but never spent.** No CPU code path ever called
   `spend_upgrade_credit`.
4. **Endgame logic was mistimed.** "Progress" was `round / 20`, but games end
   around round 7 on small maps and around round 10 on medium. Panic mode,
   endgame buying and saving thresholds almost never triggered.
5. **The live server bought at most one card per round** (not visible in sims).
   `_process_single_cpu_buy` planned up to 10 purchases on unchanged state, so it
   got the same top pick every time and every later buy failed.

## What changed

- **`cpu_valuation.py`** (new): a deck-aware value model in resource-equivalents.
  - Purchase value = (the card's per-play value − the average card value of the
    deck it dilutes) × the expected number of draws left this game, plus any VP.
  - Claim value follows a power curve built around the board's defense thresholds,
    adjusted for drawbacks: play cost, 2-action cards, unoccupied-only, one-shot.
  - Engines and defense are valued on resources, draws and actions, with draws and
    actions discounted when the deck can't use them.
  - The same model picks upgrade targets.
- **`_pick`**: takes the best option with probability (1 − noise); otherwise it
  makes a "plausible mistake".
- **Upgrade credits** are spent at the start of each play phase, on the hand card
  with the biggest gain (all tiers).
- **Rerolls** happen when the private market is weak relative to the shared one.
- **Hard-only tactics** (flags on `DifficultyProfile`):
  - `purchase_saving`: skip a mediocre buy when a clearly better shared card is
    one turn away.
  - `board_aware_valuation`: value cards against the reachable VP hexes' defense,
    the frontier size, and opponents' claim power.
  - `threat_modeling`: opponents' purchases are public. From their deck
    composition it estimates the chance they hold a claim that can take each tile.
    That chance drives defense-card and own-tile claim placement, and scales capture
    bonuses by the odds the claim actually lands (owner reinforcement, rival
    claimants, attacker ties).
  - `connectivity_cuts`: VP hexes only score while connected to base. Hard targets
    opponents' bridge tiles and guards its own.
  - `endgame_awareness`: progress is measured by the VP race. It buys the
    passive-VP card that wins on the spot, and goes all-in on denial when an
    opponent can close the game this round.
- **Medium** uses the new economy, but values cards only on the static curve and
  under-weights claim power (`val_claim_mult = 0.7`, the over-economic
  intermediate habit). It never saves and doesn't model threats, bridges or the
  endgame.
- **Easy** keeps the legacy buy heuristics, plus the noise fix and upgrade spending.
  Its strength is unchanged.
- **Live server**: `plan_cpu_purchases()` plans the whole buy phase on a scratch
  copy of the game. Each pick sees the previous buys. The server then replays the
  plan with its browsing animation.

## Notes for tuning

- The valuation weights (`val_*` on `DifficultyProfile`) were swept against the
  current Hard, and every variant scored ≤ 50%, so the defaults sit at a local
  optimum. The one strong lever is `val_claim_mult` (claim power vs. economy).
- In CPU-vs-CPU play, threat modeling and connectivity cuts are roughly neutral,
  because CPUs rarely attack each other. They exist for human opponents, who do.
- Archetype balance shifted with the new CPU: Fortress > Vanguard >> Swarm.
  See the addendum in `card_balance_audit.md`.
- Seat 0 wins about 60% of identical-CPU games because of the same-round target
  tie-break (audit bug B11). Fixing that rule would also help fairness against
  humans, who usually sit in seat 0.
