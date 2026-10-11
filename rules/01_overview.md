# Card Clash – Game Overview

## Summary
Card Clash is a 2–6 player simultaneous deck-building territory control game. Players start in corners of a hexagonal grid, grow their deck of cards over the course of the game, and compete to be the first player to reach the **VP target** (determined by grid size, player count, and game speed).

## Core Design Pillars
- **Simultaneous play** – all players plan and reveal actions at the same time to keep turns fast
- **Deck building** – players purchase cards each round to improve their deck
- **Territory control** – players expand across a hex grid by claiming tiles
- **Asymmetric archetypes** – three starting deck archetypes with distinct identities

## Player Count & CPU Players
- Supports **2–6 active players**
- Empty starting corners are left unoccupied by default. The host may optionally add **CPU players** to fill empty corners, which increases territorial pressure and keeps the board feeling contested in lower player count games
- CPU players count toward archetype weighting for objective selection and **will attempt to complete objectives**, competing with human players for the 2 VP reward

## Win Condition
The **first player whose derived VP reaches the VP target wins.** VP is checked at the end of each round. If several players reach the target in the same round, the one with the **most VP** wins; remaining ties go to the most VP hexes connected to base, then the most tiles owned, and are otherwise a shared victory. Seat order never breaks a tie. The game also ends when the round limit is reached — the player with the most VP wins (ties share victory).

VP is derived instantaneously from the game state:
1. **Territory:** +1 VP for every 3 tiles owned
2. **Connected VP hexes:** VP hex tiles connected back to your base via owned tiles add their bonus VP (+1 or +2)
3. **Card VP:** Land Grant and Spoils cards in deck add +1 VP each; formula cards (Arsenal, Warden, Colony, …) add their current value. Rubble is worth 0 VP — it only clogs your hand
4. **Card effects:** Some cards grant or remove bonus VP

(Objectives and passives are design candidates kept in `data/` but are not part of the current digital game.)

### Base Tiles
Each player's starting corner tile is their **base** — permanently owned, with passive defense **3** for every archetype. Bases cannot be captured but can be **raided**: a successful raid gives the defender **1 Rubble** (a dead card; at most 1 per raid, however much the claim beat the defense) and the attacker **1 Spoils** (+1 VP).

### Dynamic VP Target
The VP target scales with grid size and player count (`compute_vp_target`): 2-player base targets are Small 10, Medium 14, Large 18, Mega 22, Ultra 26, minus 1 per player beyond 2, minimum 4. `tiles_per_vp` = 3 (constant across all grid sizes).

---

## Archetype Identities

Each archetype is defined by two of three traits: **Fast**, **Cheap**, **Strong**.

| Archetype | Traits | Identity | Action Slots |
|---|---|---|---|
| **Vanguard** | Fast + Strong | High power, expensive, aggressive | 5 |
| **Swarm** | Fast + Cheap | Low power, cheap, floods the board | 5 |
| **Fortress** | Cheap + Strong | High power, slow cycle, defensive | 5 |

---

## Grid Sizes

| Size | Hex Count | Map | VP Hexes | Suggested For | Target Length |
|---|---|---|---|---|---|
| Small | 61 | Crown | 7 | quick games (2–3 players finish in ~7 rounds) | 20–30 min |
| Medium | 91 | Frontiers | 7 | 4 players | 30–45 min |
| Large | 127 | Rings | 13 | 2, 3, 5 or 6 players | 45–60 min |
| Mega | 169 | Six Crowns | 13 | larger 5–6 player games | 60–90 min |
| Ultra | 217 | Twin Rings | 13 | the longest 6 player games | 90–120 min |

A game defaults to the size suggested for its player count: the smallest map where games last 11 or more rounds, so an early investment in economy has time to pay off. Players can pick any size.

Each size has one fixed map, built so every seat sees the same board: a premium (2-star) VP hex in the center — on Mega, several spread evenly between the bases instead — and standard VP hexes at the same distance from every base. Every tile next to a base is open (no mountain, VP hex or defense), so nobody starts slow. With five players the bases spread evenly round the coast instead of sitting on five of the six corners, and the map is laid out around them.

Some tiles are **Blocked Terrain** (mountains): impassable obstacles. Blocked tiles cannot be claimed unless a player has the **Pathfinder** passive.
