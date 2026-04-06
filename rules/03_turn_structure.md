# Card Clash – Turn Structure

Each round consists of five phases executed by all players simultaneously where noted.

---

## Phase 1: Start of Turn

Performed individually, simultaneously by all players:

1. **Pay upkeep:** Lose 1 resource (minimum 0). **Upkeep is not paid on the first turn of the game.**
2. **Score VP hex tiles:** Earn 1 VP for each VP hex tile you already owned at the end of last turn. Tiles claimed last turn count; tiles claimed this turn do not yet count.
3. **Check win condition:** If any player has reached **20 VP**, the game ends immediately. That player wins.
4. **Draw hand:** Draw cards up to your hand size from your personal deck.
   - If your deck is empty, shuffle your discard pile to form a new deck, then draw.
   - Apply any **"draw X cards next turn"** bonuses earned last round now.
5. **Reveal archetype market:** Three cards are drawn face-up from your archetype deck. These are available for purchase this turn only.
6. **Apply upgrade credits:** If you hold any upgrade credit tokens, you may upgrade one card in your hand (see Upgrade Rules). Maximum one upgrade per turn. Upgrades happen before the Plan Phase.

---

## Phase 2: Plan Phase (Simultaneous, ~60 seconds)

All players simultaneously and secretly select cards from their hand to play this round.

- Place selected cards **face-down** on the table in front of you, grouped by which tile they target.
- Each card costs **1 action slot** to play. Players may not exceed their archetype's action slot limit (Vanguard/Swarm: 4, Fortress: 3).
- **Immediate effects** (action slot returns ↺ ↑ and card draws marked "draw immediately") resolve as each card is played during this phase, enabling chaining. For example, playing a ↑ Engine card grants 2 actions back immediately, which may then be spent on additional cards.
- The maximum total actions in a single turn is **6**, regardless of cards played or chained.
- Players may hold cards unplayed (they go to discard at end of turn).
- Players may hold cards unplayed (they go to discard at end of turn).

---

## Phase 3: Reveal & Resolve Phase (Simultaneous)

All players flip their played cards face-up simultaneously.

### Resolution Order
1. **Claim resolution** – all tiles with at least one Claim card played on them are resolved:
   - Each Claim card contributes its **power value** to that tile.
   - A player may only play **one Claim card per tile per round**, unless they have a **stacking exception card** (Coordinated Push, Dog Pile, Juggernaut).
   - The player with the **highest total power** on a tile wins it. Ties go to the **current owner** (defender wins ties). Neutral tiles (no owner) have a defense value of **0**.
   - Claimed tiles must be **adjacent to a tile the player already owns**, unless the card specifically states otherwise (e.g. Overrun, Proliferate, Eminent Domain).
   - Players cannot claim blocked terrain tiles unless they have the **Pathfinder** passive.
2. **Post-resolution effects** – conditional effects that depend on Claim success or failure resolve now (e.g. "if successful, draw 1 card next turn"). Any forced discards triggered here apply to the **targeted opponent's next turn hand draw** — the opponent does not discard from their current hand.
3. **Delayed draw effects** – any "draw X cards next turn" effects are noted for Phase 1 of next round.

---

## Phase 4: Buy Phase (Sequential)

Players take turns buying in **player order** (starting from the current first player). Each player gets an exclusive buy window — other players can browse the shop but cannot purchase until it is their turn.

### Archetype Market Options
Before purchasing, the active buyer may adjust their archetype market using these options:
- **Re-roll:** Pay 2 resources to discard your three archetype market cards and draw three new ones. May only be used once per turn.
- **Retain:** Pay 1 resource to hold one specific archetype market card over to next turn. That card is set aside and will be the first card available in your market next turn. May only retain one card per turn.

### Purchasing Cards
- **Archetype cards:** Buy from your personal three-card archetype market. Each card has a listed buy cost in resources. Purchased cards go to your **discard pile**.
- **Neutral cards:** Buy from the shared neutral market stacks. Costs are listed per card. Purchased cards go to your **discard pile**. When a neutral card stack is exhausted, it is gone for the game.
- A player may buy **multiple cards per turn** (archetype and neutral) if they have the resources. There is no limit on the number of neutral cards purchased.
- Resources not spent are **carried over** to next turn (minus upkeep at start of next turn).
- After each player finishes buying, their purchases are visible to all other players.

### Purchasing Upgrade Credits
- Upgrade credits are purchased from the shared pool at a cost of **5 resources** each.
- A player may hold multiple upgrade credits simultaneously.
- Upgrade credits are **not cards** — they are tokens held between turns.

### Archetype Market Cleanup
After the buy phase, any unpurchased archetype market cards are **discarded** (unless one was retained). Three new cards will be drawn at the start of next turn.

---

## Phase 5: End of Turn

1. Discard all played and unplayed cards from hand to your discard pile.
2. Check objective reveal: if the objective reveal threshold has been reached (see Objectives), reveal objectives now.
3. **Rotate the first player token** clockwise to the next active player.
4. Pass to next round.

> **First Player Rotation:** The first player token rotates every round. This affects conflict tie-breaking order and plan phase rhythm. Every player will act first an approximately equal number of times over the course of the game. The passive draft at setup uses reverse Round 1 order specifically to offset Round 1's first player advantage — after that, rotation handles fairness automatically.

---

## Action Slot Reference

| Symbol | Net Actions | Meaning |
|---|---|---|
| (none) | -1 | Standard card. Costs 1 action, returns 0. |
| ↺ | 0 | Net-neutral. Costs 1 action, returns 1. Effectively free in tempo. |
| ↑ | +1 | Net-positive. Costs 1 action, returns 2. Tempo gain. |

**Hard cap:** A player may never exceed **6 total actions in a single turn** regardless of how many ↑ cards are played.

---

## Upgrade Rules

- A player may spend **1 upgrade credit token** during Phase 1 (Start of Turn, before the Plan Phase) to upgrade any one card in their current hand.
- The upgraded version (marked with +) replaces the base card for this turn and all future turns.
- Physically mark the card (e.g. a sticker or marker) to indicate it is permanently upgraded.
- **Maximum one upgrade per turn.**
- Upgrade credits do not expire — they persist until used.
