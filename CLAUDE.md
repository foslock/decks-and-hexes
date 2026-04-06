# Card Clash – Claude Code Project Brief

## What This Is
Card Clash is a 2–6 player simultaneous deck-building territory control game. This repository contains the full game rules, card data, and will house the digital prototype implementation.

## Versioning
When committing changes, bump the patch version in the relevant file(s):
- **Frontend**: `frontend/package.json` → `"version"` field
- **Backend**: `backend/app/main.py` → `FastAPI(... version="X.Y.Z")`

Bump frontend version when frontend files change, backend version when backend files change, both when both change. Use semver patch bumps (e.g. 0.1.0 → 0.1.1).

## Safety Rules
- **NEVER run `git checkout` on files without explicit manual approval from the user.** This is a destructive operation that discards uncommitted work.

## Development Commands

### Backend (Python)
- Use `uv` to run Python commands and manage dependencies: `uv run python ...`, `uv run pytest ...`
- Backend tests: `cd backend && uv run pytest tests/ -x -q`
- Backend typecheck: `cd backend && uv run mypy app/`
- Start backend: `cd backend && uv run uvicorn app.main:app --reload`

### Frontend (Node/React)
- Always run `npm install` before running frontend tests or builds
- Frontend tests: `cd frontend && npm install && npx vitest run`
- Frontend typecheck: `cd frontend && npx tsc --noEmit`
- Start frontend: `cd frontend && npm run dev`

## Repository Structure
```
/rules/          # Core game rules (machine-readable markdown)
/data/           # Editable game data — cards, objectives, passives
/src/            # Game implementation (to be built)
```

## Rules Files (read these first)
- `rules/01_overview.md` — Summary, archetypes, grid sizes, win condition
- `rules/02_setup.md` — Step-by-step setup sequence
- `rules/03_turn_structure.md` — All five phases with precise rules
- `rules/04_objectives_and_vp.md` — Scoring, reveal timing, selection logic
- `rules/05_card_anatomy_and_timing.md` — Card types, timing rules, resource rules

## Data Files (game content — balance will change frequently)
- `data/cards_vanguard.md` — 14 Vanguard archetype cards + upgrades
- `data/cards_swarm.md` — 14 Swarm archetype cards + upgrades
- `data/cards_fortress.md` — 14 Fortress archetype cards + upgrades
- `data/cards_neutral.md` — Starter cards (Advance, Gather) + 12 market cards
- `data/objectives.md` — 28 objectives (Vanguard, Swarm, Fortress, Wildcard pools)
- `data/passives.md` — 37 passive abilities

---

## Key Design Rules (critical to get right in implementation)

### Turn Structure (5 phases)
1. **Start of Turn** — Pay upkeep (skip round 1), score VP hexes held since last turn, check win (20 VP), draw hand, reveal archetype market (3 random cards from player's archetype deck)
2. **Plan Phase** (simultaneous) — Players simultaneously place cards face-down on target tiles. Immediate effects (action gains, "draw immediately" card draws) resolve AS EACH CARD IS PLAYED, enabling chaining.
3. **Reveal & Resolve** — Flip all cards. Resolve Claims (highest power wins tile, ties to defender). Post-resolution effects fire. Delayed draws noted.
4. **Buy Phase** (sequential) — Players take turns buying in player order (from first player). Each player gets an exclusive buy window. Spend resources to re-roll (2 resources, once per turn) or retain (1 resource, once per turn) archetype market. Purchase archetype cards, neutral market cards (unlimited per turn), or upgrade credits (5 resources). Purchases are visible to all players.
5. **End of Turn** — Discard hand. Check objective reveal threshold. Rotate first player token clockwise.

### Action Slot System
- Every card costs exactly 1 action to play
- All archetypes: 3 starting actions per turn
- Some cards grant extra actions when played (e.g. "Gain 1 action" or "Gain 2 actions")
- No hard cap on actions — chaining action-granting cards can exceed 3
- Immediate effects (action gains, card draws) resolve during Plan Phase as cards are played

### Claiming Tiles
- All board interaction uses unified Claim cards — neutral tiles have implicit defense 0
- Claims must target tiles adjacent to one the player already owns, unless card says otherwise
- One Claim per tile per round — except stacking exception cards (Coordinated Push, Dog Pile, Juggernaut)
- Ties go to current owner (defender wins)
- Blocked terrain cannot be claimed without Pathfinder passive

### Resources
- Persistent between turns
- Upkeep: lose 1 per turn (NOT on turn 1)
- Spent only during Buy Phase
- No cap unless Hoarder passive (caps at 8)

### VP Scoring
- VP hex tiles score at START of turn for tiles held since previous turn (not the turn claimed)
- Win condition checked immediately after VP scoring in Phase 1
- Objectives award 2 VP on completion (first to complete wins it)
- Land Grant card awards 1 VP immediately when played

### Markets
- **Archetype market:** 3 random cards drawn from player's private archetype deck each turn. Private per player. Re-roll (2 res) or Retain one card (1 res) during Buy Phase.
- **Neutral market:** Shared stacks with fixed copy counts. When exhausted, gone for the game.
- **Upgrade credits:** Tokens, 5 resources each. Spent at start of Phase 1 to upgrade one card in hand. Max one upgrade per turn. Permanent.

### Forced Discards
- Always apply to targeted opponent's NEXT turn (they draw fewer cards)
- Active player must name target opponent when card is played
- Never from current hand

### Starting Decks (10 cards each, uniform across all archetypes)
| Archetype | Explore | Gather | Total | Hand Size | Action Slots |
|---|---|---|---|---|---|
| Vanguard | 5 | 5 | 10 | 5 | 5 |
| Swarm | 5 | 5 | 10 | 5 | 5 |
| Fortress | 5 | 5 | 10 | 5 | 5 |

### Explore & Gather (starter cards — NOT purchasable from market)
- **Explore:** Claim: Power 1 on any adjacent tile
- **Gather:** Gain 1 resource

### Objectives
- Revealed at end of round 3 (Small), 4 (Medium), or 5 (Large)
- 3 objectives revealed: weighted toward archetypes in play
- First player (human or CPU) to meet condition claims it for 2 VP
- CPU players actively pursue objectives

### Passives
- n+2 drawn randomly per game (n = active players)
- Drafted in reverse Round 1 turn order
- Each player picks 1, remainder discarded

### Grid Sizes
| Size | Tiles | VP Hexes | Blocked Terrain | Players |
|---|---|---|---|---|
| Small | 61 | 6 | 5–7 | 2–3 |
| Medium | 91 | 8 | 8–10 | 3–4 |
| Large | 127 | 12 | 10–14 | 4–6 |

- VP hexes distributed evenly (not center-clustered)
- Blocked terrain placed randomly at setup
- Starting corner clusters: 2 tiles each
- CPU players: optional, added by host only

### First Player
- Randomly determined for Round 1
- Rotates clockwise each round
- Passive draft uses reverse Round 1 order to offset Round 1 first-player advantage

---

## Implementation Priority (suggested order)

### Phase 1 — Core Playable Prototype
1. Hex grid generation (3 sizes, random blocked terrain, VP hex placement)
2. Player setup (archetype selection, passive draft, starting decks)
3. Turn loop with all 5 phases
4. Card playing with action slot tracking and immediate effect chaining
5. Claim resolution (power comparison, adjacency checking, tie-breaking)
6. Resource system (upkeep, carry-over, buy phase spending)
7. VP scoring and win condition
8. Archetype market (3-card draw, re-roll, retain)
9. Neutral market (shared stacks, exhaustion)

### Phase 2 — Full Feature Set
10. Upgrade credit system
11. Objective reveal and tracking
12. All card effects implemented
13. CPU player behavior (expansion, purchasing, objective pursuit)
14. Passive ability system

### Phase 3 — Polish
15. UI for simultaneous plan phase
16. Animations and visual feedback
17. Game state persistence
18. Multiplayer networking (if desired)

---

## Data Format Notes
Card data files use YAML-style fields within markdown. Key fields:
- `action_return: 0/1/2` — 0=standard, 1=gain 1 action (net neutral), 2=gain 2 actions (net +1)
- `timing: immediate/on_resolution/next_turn`
- `stackable: true` — card can be played on a tile where you already have a claim this turn
- `starter: true` — starting deck card, not in market
- `buy_cost: null` — not purchasable
- `trash_on_use: true` — remove from game after playing

---

## Frequently Changing Values (expect these to shift during playtesting)
- VP target: **dynamic** (see `compute_vp_target`)
- Tiles per VP: **3** (constant across all grid sizes)
- Upkeep cost: **dynamic** — 1 resource per 3 tiles beyond first 4
- Re-roll cost: **2 resources**
- Retain cost: **1 resource**
- Upgrade credit cost: **5 resources**
- Starting resources: **0**
- Action slot hard cap: **6**
- Objective VP reward: **2**
- Objective reveal rounds: **3 / 4 / 5** (Small / Medium / Large)
