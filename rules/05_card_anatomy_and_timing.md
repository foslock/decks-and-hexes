# Card Clash – Card Anatomy & Timing Rules

## Card Types

Every card in Card Clash is one of three types:

### Claim
Asserts power on a target tile. All board interaction — both expanding to neutral tiles and attacking opponent-owned tiles — uses Claim cards. The target tile must be adjacent to a tile the player already owns, unless the card states otherwise.

- Neutral tiles have an implicit defense of **0**. Any Claim card wins automatically.
- Opponent tiles have a defense value equal to the sum of all Defense cards played on them that round, plus any permanent defense bonuses (e.g. from Entrench).
- The player with the highest total Claim power on a tile wins it. Ties go to the current owner.

### Defense
Adds power to a tile the player already owns, increasing its resistance to Claim cards this round (or permanently, in some cases).

### Engine
Generates resources, draws cards, or grants action slots. Does not directly interact with the board.

---

## Card Anatomy

Each card has the following properties:

```
Name        – Card's display name
Type        – Claim / Defense / Engine
Buy Cost    – Resource cost to purchase from the market
Action Cost – Always 1 (flat for all cards)
Effect      – What the card does when played
Timing      – When the effect resolves (see below)
Upgraded    – The "+" version of this card (after spending an upgrade credit)
Archetype   – Vanguard / Swarm / Fortress / Neutral
```

---

## Effect Timing

All cards cost 1 action to play. Effects resolve at one of three moments:

### Immediate (During Plan Phase)
Resolves as the card is played during the Plan Phase, before the next card is selected. This enables chaining — a ↑ Engine card played first grants extra actions that can immediately be spent on additional cards.
- **Action slot returns (↺ ↑)** resolve immediately when the card is played, expanding the pool of actions available for the rest of that turn.
- **Immediate card draws** ("draw 1 card") resolve immediately, adding cards to your hand that may then be played in the same turn.

**Keyword:** No qualifier, or "immediately."

### On Resolution (After Reveal Phase)
Conditional effects that depend on whether a Claim succeeded or failed. These resolve after all cards are flipped and conflicts are settled.
- "If successful, [effect]" — triggers only if this card's Claim wins the tile.
- "If the defender holds, [effect]" — triggers only if this card's Claim fails.
- **Forced discards** from on-resolution effects always apply to the **targeted opponent's next turn** — the opponent draws one fewer card at the start of their following turn. The active player must designate the target opponent at the time the card is played. The opponent does not discard from their current hand.

**Keyword:** "If successful," "if the defender holds," or similar conditional language.

### Next Turn (Delayed)
Effects that carry forward to the start of the following round. Purchased cards entering the discard pile also fall into this category — they can only appear in hand next turn or later (after a shuffle).

**Keyword:** "Next turn," "at the start of your next turn."

---

## Stacking Exception Cards

Normally, a player may play **only one Claim card per tile per round.**

The following cards are exceptions and allow multiple Claim cards to be played on the same tile in a single round. Their powers are **added together**:

- **Vanguard:** Coordinated Push
- **Swarm:** Dog Pile
- **Fortress:** Juggernaut

These cards must be played in the same round as the additional Claim cards they stack with. The stacking exception card itself counts as the "unlock" — all combined power is resolved together at the Reveal Phase.

---

## Card Draw Clarity

To avoid ambiguity, Card Clash uses explicit timing language on all card draw effects:

| Card Text | Timing | Effect |
|---|---|---|
| "Draw 1 card" | Immediate (Plan Phase) | Draw now, as the card is played. The drawn card may be played this turn. |
| "Draw 1 card next turn" | Delayed | Note the bonus. Draw at the start of next turn's hand draw. |
| "If successful, draw 1 card next turn" | On Resolution + Delayed | Only if Claim wins. Feeds next turn's hand. |

---

## Purchasing & Discard Rules

- All purchased cards (archetype and neutral) go directly to the **discard pile**, never to hand.
- Cards in the discard pile are not accessible until the deck runs out and the discard is shuffled into a new deck.
- This means a card purchased this turn **may** appear in hand next turn if a reshuffle occurs, creating exciting variance.
- Upgrade credits are **tokens**, not cards. They persist in a player's possession between turns until spent.

---

## Resource Rules

- Resources are a persistent currency tracked individually per player.
- Resources are spent during the **Buy Phase** only (not during the Play Phase).
- Resources carry over between turns indefinitely.
- There is no maximum resource cap unless modified by a passive (e.g. Hoarder caps at 8).
