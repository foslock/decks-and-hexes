# Card Clash – Turn Structure

Each round consists of five phases executed by all players simultaneously where noted.

---

## Phase 1: Start of Turn

Performed individually, simultaneously by all players:

1. **Debt distribution:** Starting from round 5, the current VP leader receives a **Debt** card in their discard pile. Debt is a dead ENGINE card that costs 1 action + 3 resources to play, which trashes it. Other trash effects can also remove it. Among tied VP leaders, the one closest in turn order to the first player receives the Debt. Some strong cards carry a Debt as part of their price: Mercenary, Garrison and Siege Tower add one to your discard pile when their claim resolves, Prospector when played, and Warden and Land Grant when bought.
2. **VP is derived, not scored here:** VP is recomputed from the board and your cards at any moment (see `04_objectives_and_vp.md`); the win check happens at the **end** of each round.
3. **Draw hand:** Draw cards up to your hand size from your personal draw pile.
   - If your draw pile is empty, shuffle your discard pile into a new draw pile, then draw.
   - Apply any **"draw X cards next turn"** bonuses earned last round now.
4. **Show the archetype market:** your market shows the top copy of each of your 5 archetype piles — your whole market, every round. (Everything pack: a few random cards are drawn from your archetype deck instead.)
5. **Apply upgrade credits:** If you hold any upgrade credits, you may spend them during the Play Phase to upgrade cards in your hand (see Upgrade Rules).

---

## Phase 2: Play Phase (Simultaneous, ~60 seconds)

All players simultaneously and secretly select cards from their hand to play this round.

- Place selected cards **face-down** on the table in front of you, grouped by which tile they target.
- Most cards cost **1 action** to play (a few heavy cards cost 2 or 3). Every archetype starts the round with **5 actions**. A card whose action return covers its cost ("Gain 1 action") can be played even with 0 actions left.
- **Immediate effects** (action slot returns ↺ ↑ and card draws marked "draw immediately") resolve as each card is played during this phase, enabling chaining. For example, playing a ↑ Engine card grants 2 actions back immediately, which may then be spent on additional cards.
- There is no cap on total actions in a turn; chaining action-granting cards can exceed 5.
- Players may hold cards unplayed (they go to discard at end of turn).

---

## Phase 3: Reveal & Resolve Phase (Simultaneous)

All players flip their played cards face-up simultaneously.

### Resolution Order
1. **Abandons, then Defense cards** – tiles given up (Exodus, Scorched Retreat) are let go first, then Defense cards add their defense.
2. **Claim power is settled** – every Claim's conditional bonuses ("+2 if the tile has a defense bonus", "+2 if you played another Claim", Road Builder's bridge…) are judged now, on the same board for everyone, **before any tile changes hands** — so the order tiles resolve in never matters. The one exception is power counted from your hand (Strength in Numbers), which is fixed when you play the card, since your hand only exists while you play.
3. **Claim resolution** – all tiles with at least one Claim card played on them are resolved:
   - Each Claim card contributes its **power value** to that tile.
   - A player may only play **one Claim card per tile per round**, unless they have a **stacking exception card** (Coordinated Push, Dog Pile, Juggernaut).
   - In short: **match a neutral tile's defense to take it; beat a rival to take theirs.**
   - The player with the **highest total power** on a tile wins it. Ties go to the **current owner** (defender wins ties). Most neutral tiles have defense **0**; VP hexes have intrinsic defense (standard 2, premium 3) and tiles next to a premium hex have 1. Against a neutral tile's intrinsic defense, a tie goes to the **attacker**. A tie between two attackers on a tile nobody owns means nobody takes it.
   - Claimed tiles must be **adjacent to a tile the player already owns**, unless the card specifically states otherwise (e.g. Overrun, Proliferate, Eminent Domain).
   - Players cannot claim blocked terrain tiles unless they have the **Pathfinder** passive.
4. **Post-resolution effects** – conditional effects that depend on Claim success or failure resolve now (e.g. "if successful, draw 1 card next turn"). Any forced discards triggered here apply to the **targeted opponent's next turn hand draw** — the opponent does not discard from their current hand.
5. **Delayed draw effects** – any "draw X cards next turn" effects are noted for Phase 1 of next round.

---

## Phase 4: Buy Phase

In the digital game all players buy at the same time; each player signals when they're done.

### Archetype Market Options
- With a card pack your whole market is already on show, so there is nothing to re-roll.
- **Re-roll (Everything pack only):** Pay 1 resource to replace your archetype market cards with new ones (Surveyor grants free re-rolls for the round).
- **Retain:** not implemented in the digital game (the `RETAIN_COST` constant is reserved).

### Purchasing Cards
- **Archetype cards:** Buy from your private archetype piles — **one copy of each card per round**. A bought card's pile shows its next copy next round; an empty pile is sold out. Each card has a listed buy cost in resources. Purchased cards go to your **discard pile**.
- **Shared cards:** Buy from the shared piles — also **one copy of each card per round**. Costs are listed per card. Purchased cards go to your **discard pile**. When a pile is exhausted it is gone for the game (if several players buy its last copy in the same buy phase, each of them gets one).
- A player may buy **multiple different cards per turn** (archetype and shared) if they have the resources.
- Resources not spent are **carried over** to next turn.
- After each player finishes buying, their purchases are visible to all other players.

### Purchasing Upgrade Credits
- Upgrade credits cost **5 resources** each.
- A player may hold multiple upgrade credits simultaneously.
- Upgrade credits are **not cards** — they are tokens held between turns.

### Archetype Market Cleanup
With a card pack, unbought cards simply stay on top of their piles. (Everything pack: unpurchased archetype market cards are **discarded** and new ones drawn at the start of next turn.)

---

## Phase 5: End of Turn

1. Discard all played and unplayed cards from hand to your discard pile.
2. Check objective reveal: if the objective reveal threshold has been reached (see Objectives), reveal objectives now.
3. **Rotate the first player token** clockwise to the next active player.
4. Pass to next round.

> **First Player Rotation:** The first player token rotates every round. This affects conflict tie-breaking order and play phase rhythm. Every player will act first an approximately equal number of times over the course of the game. The passive draft at setup uses reverse Round 1 order specifically to offset Round 1's first player advantage — after that, rotation handles fairness automatically.

---

## Action Slot Reference

| Symbol | Net Actions | Meaning |
|---|---|---|
| (none) | -1 | Standard card. Costs 1 action, returns 0. |
| ↺ | 0 | Net-neutral. Costs 1 action, returns 1. Effectively free in tempo. |
| ↑ | +1 | Net-positive. Costs 1 action, returns 2. Tempo gain. |

There is no hard cap on total actions in a turn.

---

## Upgrade Rules

- A player may spend upgrade credits during the Play Phase to upgrade cards in their current hand (one credit per card).
- **One rule for every upgrade: an upgrade only changes the card's numbers** — more power, more resources, more cards, more tiles, a lower threshold. The words stay the same, so a card's drawbacks (an extra action cost, a Debt) stay too. The only upgrades that drop a drawback are Diplomat and Plague, whose base versions are deliberately clumsy.
- The upgraded version (marked with +) replaces the base card for this turn and all future turns.
- Physically mark the card (e.g. a sticker or marker) to indicate it is permanently upgraded.
- Upgrade credits do not expire — they persist until used.
