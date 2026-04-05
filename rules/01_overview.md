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
The **first player whose derived VP reaches the VP target wins.** VP is checked at the start of each turn after upkeep.

VP is derived instantaneously from the game state:
1. **Territory:** +1 VP for every N tiles owned (N = grid radius - 1: Small=3, Medium=4, Large=5)
2. **Connected VP hexes:** VP hex tiles connected back to your base via owned tiles add their bonus VP (+1 or +2)
3. **Card VP:** Land Grant cards in deck add +1 VP each; Rubble cards subtract -1 VP each
4. **Objectives:** Completing mid-game objectives awards +2 VP each
5. **Card effects:** Some cards grant or remove bonus VP

### Base Tiles
Each player's starting corner tile is their **base** — permanently owned, with passive defense (Swarm: 2, Vanguard: 3, Fortress: 4). Bases cannot be captured but can be **raided** to inflict Rubble cards on the defender.

### Dynamic VP Target
The VP target scales with grid size, player count, and game speed (Fast/Normal/Slow). Default speed is Normal (1.0× multiplier). Formula: `total_tiles // (tiles_per_vp × player_count × 0.75) × speed_multiplier`, minimum 3. `tiles_per_vp` = grid radius - 1 (Small=3, Medium=4, Large=5).

---

## Archetype Identities

Each archetype is defined by two of three traits: **Fast**, **Cheap**, **Strong**.

| Archetype | Traits | Identity | Action Slots |
|---|---|---|---|
| **Vanguard** | Fast + Strong | High power, expensive, aggressive | 4 |
| **Swarm** | Fast + Cheap | Low power, cheap, floods the board | 4 |
| **Fortress** | Cheap + Strong | High power, slow cycle, defensive | 3 |

---

## Grid Sizes

| Size | Hex Count | VP Hexes | Recommended Players | Target Length |
|---|---|---|---|---|
| Small | 61 | 6 | 2–3 | 20–30 min |
| Medium | 91 | 8 | 3–4 | 30–45 min |
| Large | 127 | 12 | 4–6 | 45–60 min |

VP hexes are distributed evenly across the board (not clustered at center), similar to double-word-score tiles in Scrabble.

A portion of non-VP, non-starting tiles are randomly designated as **Blocked Terrain** at game start, creating impassable obstacles that vary each game. Blocked tiles cannot be claimed unless a player has the **Pathfinder** passive.
