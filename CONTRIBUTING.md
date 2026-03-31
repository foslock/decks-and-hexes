# Contributing to HexDraft

## Overview

HexDraft is split into two packages:

- **`backend/`** -- Python 3.11 FastAPI server (game engine, REST API)
- **`frontend/`** -- TypeScript React + PixiJS client (game UI)

Game rules live in `rules/` and card/objective/passive data lives in `data/` as YAML-in-markdown files. The backend loads these at runtime -- you don't need to change code to rebalance cards.

## Setup

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Python | 3.11+ | Backend runtime |
| [uv](https://docs.astral.sh/uv/) | latest | Python dependency management |
| Node.js | 22+ | Frontend runtime |
| npm | 10+ | Frontend dependency management |

### Install

```bash
# Backend
cd backend
uv sync --extra dev

# Frontend
cd frontend
npm install
```

### Run

```bash
# Start backend (port 8000)
cd backend
uv run uvicorn app.main:app --reload

# Start frontend (port 5173, proxies /api to backend)
cd frontend
npm run dev
```

## Development Workflow

### Branches

- `main` is the stable branch. All changes go through pull requests.
- Name feature branches descriptively: `feat/upgrade-system`, `fix/claim-adjacency`, `refactor/market-logic`.

### Before submitting a PR

All of these must pass -- CI will check them automatically:

```bash
# Backend
cd backend
uv run mypy app/          # Strict type checking (zero errors required)
uv run pytest tests/ -v   # 134+ tests must pass

# Frontend
cd frontend
npx tsc --noEmit          # Strict TypeScript checking
npm test                  # 50+ vitest tests must pass
npm run build             # Production build must succeed
```

### CI Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every PR to `main`:

1. **Backend job** -- uv sync, mypy strict, pytest
2. **Frontend job** -- npm ci, tsc, vitest, vite build

Both jobs must pass before merging.

## Code Structure

### Backend

The game engine is the core of the project. All game logic runs server-side.

```
backend/app/
  game_engine/
    hex_grid.py       # Hex grid generation (axial coordinates)
    cards.py          # Card/deck data structures
    game_state.py     # Turn loop, phase logic, claim resolution
  data_loader/
    loader.py         # Parses YAML from data/ files into Card objects
  api/
    routes.py         # FastAPI REST endpoints
  models/
    database.py       # SQLAlchemy async setup
    game.py           # Game persistence model
  main.py             # App entry point, CORS, router
```

Key design decisions:

- **Server-authoritative**: The client sends actions, the server validates and returns updated state. Never trust the client.
- **In-memory game store** (Phase 1): Games live in a dict (`_games`). Postgres persistence is prepared but not yet wired.
- **Deterministic with seed**: Pass a `seed` to `create_game()` for reproducible games. Tests use fixed seeds.

### Frontend

```
frontend/src/
  components/
    HexGrid.tsx           # PixiJS canvas renderer
    CardHand.tsx          # Card display with drag-and-drop
    CardDetail.tsx        # Card detail modal
    GameScreen.tsx        # Main game orchestrator
    MarketPanel.tsx       # Buy phase market UI
    FullGameLog.tsx       # Full game log modal
    SetupScreen.tsx       # Pre-game configuration
    SettingsContext.tsx    # Settings (animation mode)
  api/client.ts           # Typed fetch wrapper for all endpoints
  types/game.ts           # Shared interfaces matching backend to_dict()
```

Key conventions:

- **Pointer Events** for all interaction (mouse + touch unified). No separate touch handlers.
- **No CSS files** -- all styling is inline via `style` props. This keeps components self-contained.
- **SettingsContext** wraps the app and persists to `localStorage`.

### Data Files

Card data lives in `data/cards_*.md` as YAML with `#` comments:

```yaml
cards:
  - id: vanguard_blitz
    name: Blitz
    type: Claim
    buy_cost: 4
    power: 4
    action_return: 0
    effect: "Claim: Power 4."
```

The loader (`data_loader/loader.py`) parses these with PyYAML. To add or rebalance a card, edit the YAML -- no code changes needed. The loader infers some fields from effect text (resource gain, draw count, defense bonus, forced discard) so keep effect descriptions consistent.

## Writing Tests

### Backend (pytest)

Tests are in `backend/tests/`. Fixtures are in `conftest.py`:

- `card_registry` -- All cards loaded from data files
- `small_2p_game` -- A 2-player small game in Plan phase (seed 42)
- `medium_3p_game` -- A 3-player medium game in Plan phase (seed 99)

```python
def test_my_feature(small_2p_game: GameState) -> None:
    game = small_2p_game
    # game is in Plan phase, round 1, with hands drawn
    ok, msg = play_card(game, "p0", 0, target_q, target_r)
    assert ok, msg
```

API tests use FastAPI's `TestClient`:

```python
def test_endpoint(client: TestClient) -> None:
    resp = client.post("/api/games", json={...})
    assert resp.status_code == 200
```

### Frontend (vitest)

Tests are in `frontend/src/test/`. Test fixtures are in `fixtures.ts` with helpers:

- `makeCard()`, `makePlayer()`, `makeTile()`, `makeGameState()` -- factory functions with sensible defaults and override support

Components that use `SettingsContext` need to be wrapped:

```tsx
import { SettingsProvider } from '../components/SettingsContext';

render(
  <SettingsProvider>
    <MyComponent {...props} />
  </SettingsProvider>
);
```

API tests mock `globalThis.fetch`:

```typescript
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;
```

## Game Rules Reference

The full rules are in `rules/` (5 markdown files). Key points for implementers:

- **Simultaneity**: All players plan at the same time. The hot-seat mode is sequential but the engine supports true simultaneous when multiplayer is added.
- **Defender wins ties**: When claim power is equal, the current tile owner keeps it.
- **Adjacency**: Claims must target tiles adjacent to one the player already owns (unless the card overrides this).
- **Action hard cap**: 6 total actions per turn regardless of chaining.
- **VP hexes score at start of turn**: Only for tiles held since the *previous* turn, not the turn they were claimed.
- **Forced discards**: Apply to the target's *next* turn draw, not their current hand.

## Game Log Visibility

The game log (`game_state.py: LogEntry`) supports per-player visibility:

- `visible_to: []` -- Entry is public (everyone sees it)
- `visible_to: ["p0"]` -- Only player p0 sees it

Plan phase card plays are private to the acting player. Phase transitions, claim resolutions, and buy actions are public. The `GET /api/games/{id}/log?player_id=X` endpoint filters accordingly.

## Deployment

The `render.yaml` blueprint defines three services:

1. **hexdraft-api** (web service, starter plan) -- FastAPI backend
2. **hexdraft-frontend** (static site, starter plan) -- Vite build with API rewrites
3. **hexdraft-db** (Postgres 16, starter plan) -- Database

To deploy: create a Render Blueprint pointing at the repo. Render provisions everything automatically.

## Questions

If something in the codebase is unclear, check `CLAUDE.md` first -- it contains the complete game design specification that drives all implementation decisions.
