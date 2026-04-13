# Card Clash

A 2–6 player simultaneous deck-building territory control game played on a hexagonal grid. Players choose asymmetric archetypes, build decks through markets, claim territory, and race to a dynamic VP target.

## How It Works

Each round has five simultaneous phases:

1. **Start of Turn** — Distribute Debt to VP leader (round 5+), score VP from held hexes, draw hand, reveal archetype market
2. **Plan** — All players simultaneously place cards face-down on target tiles (action-slot limited, with undo for reversible cards)
3. **Reveal & Resolve** — Flip all cards; highest power wins each contested tile (ties to defender)
4. **Buy** — Spend resources on archetype cards, neutral market cards, or upgrade credits
5. **End of Turn** — Discard hands, check objective reveals, rotate first player, advance round

Three asymmetric archetypes each play differently:

| Archetype | Identity |
|-----------|----------|
| Vanguard  | Fast + Strong — aggressive expansion with action-granting chains |
| Swarm     | Fast + Cheap — wide board presence through cheap, numerous cards |
| Fortress  | Cheap + Strong — defensive territory hold with high-power claims |

All archetypes start with 10 cards (5 Explore + 5 Gather), 5-card hand, and 5 action slots per turn.

Five grid sizes scale with player count:

| Size   | Tiles | VP Hexes | Blocked | Players |
|--------|-------|----------|---------|---------|
| Small  | 61    | 5        | 5–7     | 2–3     |
| Medium | 91    | 6        | 8–10    | 3–4     |
| Large  | 127   | 9        | 10–14   | 4–6     |
| Mega   | 169   | 12       | 14–18   | 5–6     |
| Ultra  | 217   | 15       | 18–22   | 6       |

Complete rules are in [`rules/`](rules/) and all card/objective/passive data lives in [`data/`](data/).

## Tech Stack

**Backend** — Python 3.11+, FastAPI, SQLAlchemy (async), PostgreSQL, WebSockets, managed with [uv](https://docs.astral.sh/uv/)

**Frontend** — TypeScript, React 18, PixiJS 8 (WebGL hex rendering), Vite

**Deployment** — Render.com blueprint (`render.yaml`) with API + static site (prod/staging) and PostgreSQL

## Project Structure

```
backend/
  app/
    api/
      routes.py              # REST endpoints (play, buy, undo, resolve, etc.)
      lobby.py               # Multiplayer lobby system with WebSocket connections
      ws_manager.py          # WebSocket connection manager for real-time broadcasts
    game_engine/
      hex_grid.py            # Axial-coordinate hex grid generation (5 sizes)
      cards.py               # Card types, decks, effects, upgrades
      game_state.py          # 5-phase turn loop, claim resolution, markets
      effect_resolver.py     # Card effect resolution pipeline
      effects.py             # Effect definitions and structured effect system
      cpu_player.py          # Heuristic CPU player with difficulty levels
      simulation.py          # Headless Monte Carlo balance testing
      card_packs.py          # Card pack filtering for custom game modes
      balance_report.py      # Balance analysis from simulation results
    data_loader/loader.py    # Parses card/objective/passive YAML from data/
    models/                  # SQLAlchemy models (game persistence)
    storage/                 # Game store, serializer, analytics
  tests/                     # 489 pytest tests
frontend/
  src/
    api/client.ts            # Typed API client
    types/game.ts            # Shared TypeScript interfaces
    hooks/useWebSocket.ts    # Real-time multiplayer WebSocket hook
    audio/                   # Sound engine and effect definitions
    components/
      HexGrid.tsx            # PixiJS hex renderer (flat-top, axial coords)
      CardHand.tsx           # Drag-and-drop card play with enter/exit animations
      GameScreen.tsx         # Main game view with phase-aware UI
      LobbyScreen.tsx        # Multiplayer lobby (create/join, settings, chat)
      SetupScreen.tsx        # Home screen with game creation and join
      MarketPanel.tsx        # Archetype + neutral market with buy UI
      ShopOverlay.tsx        # Full-screen shop during buy phase
      ResolveOverlay.tsx     # Animated claim resolution display
      GameOverOverlay.tsx    # End-of-game results screen
      CardDetail.tsx         # Card detail modal
      CardFull.tsx           # Full-size card renderer
      CompactCard.tsx        # Compact card for tooltips and previews
      CardBrowser.tsx        # Browse all cards outside of a game
      CardZoomContext.tsx     # Tap-to-zoom card inspection
      PlayerHud.tsx          # Per-player stats, VP breakdown, scoring
      GameLog.tsx            # Sidebar recent-events log
      FullGameLog.tsx        # Persistent game log with round filter
      VpPathPreview.tsx      # VP scoring path visualization
      PhaseBanner.tsx        # Animated phase transition banners
      GameIntroOverlay.tsx   # Game start intro animation
      HeroAnimation.tsx      # Home screen hero animation
      SettingsContext.tsx     # Settings (animations, tooltips, sound, backgrounds)
      SettingsPanel.tsx      # Settings UI panel
      HowToPlay.tsx          # Interactive rules tutorial
      Keywords.tsx           # Card keyword reference
      Tooltip.tsx            # Reusable tooltip component
  test/                      # 48 vitest tests
data/                        # Game content (YAML-in-markdown), 109 cards total
  cards_vanguard.md          # 25 Vanguard cards + upgrades
  cards_swarm.md             # 25 Swarm cards + upgrades
  cards_fortress.md          # 25 Fortress cards + upgrades
  cards_neutral.md           # Starter cards + 34 market cards
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
# Backend (489 tests)
cd backend
uv run pytest tests/ -x -q

# Backend type check
uv run mypy app/

# Frontend (48 tests)
cd frontend
npm install
npx vitest run

# Frontend type check
npx tsc --noEmit
```

### Deploy to Render

1. Push to a GitHub repo
2. In Render, create a new **Blueprint** and point it at the repo
3. Render reads `render.yaml` and provisions the backend API, static frontend, and Postgres database

## Features

### Implemented

**Core Game**
- Full 5-phase turn loop with server-authoritative game logic
- 109 cards across 3 archetypes + neutral market, loaded from YAML data files
- Hex grid generation for 5 sizes with randomized VP hex and blocked terrain placement
- Claim resolution with power comparison, adjacency rules, defender-wins-ties, and stacking exceptions
- Resource system with persistent carry-over and buy phase spending
- VP scoring from held tiles with dynamic VP target
- Archetype market (3-card draw, re-roll, retain) and neutral market with per-game copy limits
- Upgrade credit system with permanent card upgrades
- 28 objectives with reveal timing and first-to-complete scoring
- 37 passive abilities with draft system
- Debt mechanic for VP leader (round 5+)
- Card effect system with immediate, on-resolution, and next-turn timing
- Undo for reversible planned actions (long-press to retract)

**Multiplayer**
- Real-time WebSocket multiplayer with lobby system (create/join via 4-letter codes)
- Simultaneous play phase — all players plan concurrently
- Live cursor tracking showing other players' shop browsing
- Reconnection recovery (auto-rejoin on stale tokens, orphaned CPU task restart)

**CPU Players**
- Heuristic AI with configurable difficulty (easy/medium/hard via noise parameter)
- Archetype-specific strategy weights (aggression, expansion, defense, VP priority)
- VP denial, tempo-sensitive buying, adaptive play style based on game state
- Concurrent buying with realistic cursor simulation and time budgets

**Frontend**
- PixiJS WebGL hex grid with player colors, VP indicators, terrain, and animations
- Drag-and-drop card play with touch support
- Card zoom/inspect, full detail modal, and card browser
- Animated phase banners, claim resolution overlay, and game intro sequence
- Configurable settings: animation mode (normal/fast/off), tooltips, sound, background images
- Sound effects engine
- Persistent game log with per-round filtering
- VP breakdown tooltips and scoring path visualization
- Background image support for game screen (4 variations, seed-deterministic)

**Infrastructure**
- CI pipeline: mypy strict, pytest, TypeScript strict, vitest, build verification
- PostgreSQL persistence with async SQLAlchemy
- Render.com deployment with prod/staging environments

**Balance Testing**
- Headless Monte Carlo simulation framework (CPU vs CPU)
- Batch simulation with configurable archetype combos, grid sizes, and card packs
- Per-player tracking: VP over time, resource/tile trends, claim stats, purchases
- Balance report generation from simulation results

## License

Not yet licensed. All rights reserved.
