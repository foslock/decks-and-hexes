# HexDraft – Game Overview

## Summary
HexDraft is a 2–6 player simultaneous deck-building territory control game. Players start in corners of a hexagonal grid, grow their deck of cards over the course of the game, and compete to be the first player to reach **20 Victory Points (VP)**.

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
The **first player to reach 20 VP wins immediately.**

VP is earned by:
1. Controlling VP Hex tiles on the board (1 VP per tile per full turn held — earned at the start of each turn for tiles claimed in a previous turn, not the turn they were claimed)
2. Completing mid-game Objectives (2 VP each)
3. Purchasing Land Grant neutral cards (1 VP immediately, card trashed)

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
| Small | 37 | 8 | 2–3 | 20–30 min |
| Medium | 61 | 13 | 3–4 | 30–45 min |
| Large | 91 | 20 | 4–6 | 45–60 min |

VP hexes are distributed evenly across the board (not clustered at center), similar to double-word-score tiles in Scrabble.

A portion of non-VP, non-starting tiles are randomly designated as **Blocked Terrain** at game start, creating impassable obstacles that vary each game. Blocked tiles cannot be claimed unless a player has the **Pathfinder** passive.
