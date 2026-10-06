# Card Clash – Game Setup

## Step 1: Choose Grid Size
Players collectively agree on a grid size (Small / Medium / Large / Mega / Ultra). Each size has one fixed map, which sets:
- Total hex count
- The VP hexes and blocked terrain (mountains)
- Where the starting bases go

## Step 2: Set Up the Board
1. Lay out the size's map. It is symmetric around the bases: VP hexes sit at the same distance from every base, and every tile next to a base is open (no mountain, VP hex or defense).
2. Assign **starting clusters** (2 tiles each: the base and the tile toward the center) round the board in seat order:
   - 2, 3 or 6 players: evenly spaced corners.
   - 4 players: two opposite pairs of corners, so everyone has one rival beside them and one empty corner.
   - 5 players: bases spread evenly round the coast (five of six corners would leave the two players beside the empty corner with a big edge); the map is laid out around them.

## Step 3: Determine Initial Turn Order
Roll or randomly determine the **first player** for Round 1. Seat order is fixed for the entire game, but the **first player token rotates clockwise each round** — every player will eventually act first.

> **Why this matters:** Being first player affects tie-breaking in conflict resolution and sets the rhythm of the play phase. Rotating it ensures no player holds a sustained advantage.

## Step 4: Passive Draft

> **Not in the current digital game.** Passives are a design candidate kept in `data/passives.yaml`.
1. Randomly draw **n+2 passives** from the passive pool (where n = number of active players).
2. Display all drawn passives face-up.
3. Players draft in **reverse Round 1 turn order** (the Round 1 last player picks first, the Round 1 first player picks last).
4. Each player selects **1 passive**. Undrafted passives are discarded for this game.

> **Note:** The reverse draft order offsets the Round 1 first player's advantage only. From Round 2 onward, the first player token rotates and no further passive compensation is needed.

## Step 5: Choose Starting Deck
Each player chooses one of the three starting archetypes:
- **Vanguard** (Fast + Strong)
- **Swarm** (Fast + Cheap)
- **Fortress** (Cheap + Strong)

Multiple players may choose the same archetype.

### Starting Deck Composition

All archetypes start with the same 10-card deck:

| Explore | Gather | Total | Hand Size | Action Slots |
|---|---|---|---|---|
| 5 | 5 | 10 | 5 | 5 |

Explore (Claim: Power 0 on an adjacent unoccupied tile) and Gather (Gain 2 resources) are shared starter cards present in every archetype's starting deck. They establish a common baseline before archetype identity takes over via market purchases. The deck is sized at exactly 2 × hand size so it cycles once before any purchased card can appear.

## Step 6: Prepare the Markets

### Archetype Market
Each archetype pool is shuffled separately. These are private per player — each player draws from their own archetype deck only.

### Shared Market
Lay out all shared cards in separate face-up stacks with their copy counts visible. These are shared by all players.

### Upgrade Credits
Upgrade credits are bought during the Buy Phase for 5 resources each (no supply limit in the digital game).

## Step 7: Prepare Resources
Each player starts with **0 resources**. Resources are tracked individually and carry over between turns.

## Step 8: Deal Starting Hands
Each player draws their starting hand (per archetype hand size above). The game begins.
