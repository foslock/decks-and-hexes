# Card Clash

A 2-6 player simultaneous deck-building territory control game played on a hexagonal grid. Players choose asymmetric archetypes, build decks through markets, claim territory, and race to 20 VP.

## How It Works

Each round has five simultaneous phases:

1. **Start of Turn** -- Pay upkeep, score VP from held hexes, draw hand, reveal archetype market
2. **Plan** -- All players simultaneously place cards face-down on target tiles (action slot limited)
3. **Reveal & Resolve** -- Flip all cards; highest power wins each contested tile (ties to defender)
4. **Buy** -- Spend resources on archetype cards, neutral market cards, or upgrade credits
5. **End of Turn** -- Discard hands, rotate first player, advance round

Three asymmetric archetypes each play differently:

| Archetype | Identity | Slots | Hand | Deck |
|-----------|----------|-------|------|------|
| Vanguard  | Fast + Strong | 4 | 4 | 8 |
| Swarm     | Fast + Cheap  | 4 | 5 | 10 |
| Fortress  | Cheap + Strong | 3 | 3 | 6 |

Three grid sizes scale with player count:

| Size   | Tiles | VP Hexes | Blocked | Players |
|--------|-------|----------|---------|---------|
| Small  | 37    | 8        | 3-4     | 2-3     |
| Medium | 61    | 13       | 5-7     | 3-4     |
| Large  | 91    | 20       | 8-10    | 4-6     |

Complete rules are in the [`rules/`](rules/) directory and all card/objective/passive data lives in [`data/`](data/).

## Tech Stack

**Backend** -- Python 3.11, FastAPI, SQLAlchemy (async), PostgreSQL, managed with [uv](https://docs.astral.sh/uv/)

**Frontend** -- TypeScript, React 18, PixiJS 8 (WebGL hex rendering), Vite

**Deployment** -- Render.com blueprint (`render.yaml`) with a web service, static site, and Postgres database

## Project Structure

```
backend/
  app/
    api/routes.py            # REST endpoints for hot-seat play
    game_engine/
      hex_grid.py            # Axial-coordinate hex grid generation
      cards.py               # Card types, decks, starting deck construction
      game_state.py          # 5-phase turn loop, claim resolution, markets
    data_loader/loader.py    # Parses card/objective/passive YAML from data/
    models/                  # SQLAlchemy models (game persistence)
  tests/                     # 134 pytest tests
frontend/
  src/
    api/client.ts            # Typed API client
    types/game.ts            # Shared TypeScript interfaces
    components/
      HexGrid.tsx            # PixiJS hex renderer (flat-top, axial coords)
      CardHand.tsx           # Drag-and-drop card play (pointer events)
      CardDetail.tsx         # Full-screen card detail modal
      GameScreen.tsx         # Main game view with phase-aware UI
      MarketPanel.tsx        # Archetype + neutral market with buy/detail
      FullGameLog.tsx        # Persistent game log viewer with round filter
      SetupScreen.tsx        # Game creation (grid size, players, archetypes)
      SettingsContext.tsx     # Animation mode (normal/simplified), localStorage
      PlayerHud.tsx          # Per-player stats display
      GameLog.tsx            # Sidebar recent-events log
  test/                      # 50 vitest tests
data/                        # Game content (YAML-in-markdown)
  cards_vanguard.md          # 14 Vanguard cards + upgrades
  cards_swarm.md             # 14 Swarm cards + upgrades
  cards_fortress.md          # 14 Fortress cards + upgrades
  cards_neutral.md           # Starter cards + 12 market cards
  objectives.md              # 28 objectives across 4 pools
  passives.md                # 37 passive abilities
rules/                       # Human-readable game rules (5 files)
render.yaml                  # Render.com deployment blueprint
.github/workflows/ci.yml    # CI: pytest, mypy, vitest, tsc on PRs
```

## Getting Started

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Node.js 22+

### Run locally

```bash
# Backend
cd backend
uv sync --extra dev
uv run uvicorn app.main:app --reload

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

### Run tests

```bash
# Backend (134 tests)
cd backend
uv run pytest tests/ -v

# Backend type check
uv run mypy app/

# Frontend (50 tests)
cd frontend
npm test

# Frontend type check
npx tsc --noEmit
```

### Deploy to Render

1. Push to a GitHub repo
2. In Render, create a new **Blueprint** and point it at the repo
3. Render reads `render.yaml` and provisions the backend service, static frontend, and Postgres database

## Current Status (Phase 1)

What's implemented:

- Hex grid generation for all three sizes with randomized VP hex and blocked terrain placement
- Full 5-phase turn loop with server-authoritative game logic
- 57 cards loaded from YAML data files across all archetypes
- Claim resolution (power comparison, adjacency, defender-wins-ties, stacking exceptions)
- Resource system with upkeep, persistent carry-over, and buy phase spending
- VP scoring from held tiles and win condition check
- Archetype market (3-card draw, re-roll, retain) and neutral market with copy limits
- PixiJS hex grid renderer with player colors, VP indicators, and click/drag interaction
- Slay the Spire-style drag-and-drop card play (mouse and touch)
- Card hover-expand and full detail modal for any viewable card
- Configurable animation mode (normal or simplified) saved to localStorage
- Persistent game log with per-player visibility filtering
- Hot-seat multiplayer (sequential, same browser)
- CI pipeline: mypy strict, pytest, TypeScript strict, vitest, build verification

What's planned for Phase 2+:

- Upgrade credit system and card upgrading
- Objective reveal and completion tracking
- All individual card effects (conditional power, range overrides, etc.)
- CPU player AI
- Passive ability drafting and effects
- WebSocket multiplayer with lobby system
- Game state persistence to Postgres

## License

Not yet licensed. All rights reserved.
