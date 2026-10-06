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

### CPU Difficulty Benchmark
`backend/scripts/difficulty_benchmark.py` pits CPU agents head-to-head (parallel,
seeded, seats rotated, archetypes randomized) and reports win rates. Agents:
`easy` / `medium` / `hard`, exploit bots `rush` (buys only the biggest Claims —
the "strike rush" that used to beat Hard), `greedy`, `raider`, `<tier>@base`
(the tier from `cpu_player.py` at git HEAD, for before/after comparisons), and
profile overrides like `hard~threat_modeling=0,noise=0.1`.
- Standard suite: `cd backend && uv run python scripts/difficulty_benchmark.py --suite --games 300 --grid small,medium`
- Specific matchups: `uv run python scripts/difficulty_benchmark.py hard:rush medium:hard@base --games 400`
- Archetype balance (Hard mirror): `uv run python scripts/difficulty_benchmark.py hard:hard --games 900 --grid small,medium` (add `--players 3`)
Re-run the suite after changing CPU logic **or** card balance — card changes shift
the tiers too. CPU buy/upgrade valuation lives in `backend/app/game_engine/cpu_valuation.py`;
per-tier feature flags and weights are the `DifficultyProfile`s in `cpu_player.py`.

### Card Art
Card art lives in `frontend/public/cards/<definition_id>.png` (source). The app
loads a compressed `.webp` sibling first (≈40 KB vs ≈500 KB) and falls back to the
PNG. After adding or replacing art, regenerate the WebPs (incremental):
`uv run --project backend --with pillow python frontend/scripts/optimize_images.py`
Preloading is handled by `frontend/src/utils/cardImagePreload.ts` (hand/deck/markets
at high priority, the rest of the catalog during idle time).

### Cards, Hand & Piles (frontend)
- `CardFull` is the one full card face (fixed 220 × 308, metallic trim tiered by
  cost via `constants/cardTrim.ts`, ability text auto-fitted). Tight spots use
  `CompactCardFace` (name, cost coin, glyph shorthand in the same trim/theme) —
  `CompactCard`, `HandStyleCard`, shop tiles, deck viewers and the card browser
  all render it.
- Upgraded names: the engine names them "Blitz+"; render names through
  `CardName` (gold arrow glyph first, no "+"), `plainCardName()` for text.
- `CardHand` owns the hand fan, the 3D draw/discard piles and every card
  animation; helpers live in `components/hand/` (`handLayout`, `cardMotion`,
  `CardPile`, `TargetArrow`, `TrashBurn`).
- Played cards live on the board: `BoardCards.tsx` (`TileCardStack` over
  tiles, `EngineQueue` under the ID card, hover zoom, `CardDetailOverlay`).
  GameBoard positions stacks each frame (`tileCardKeys` / `renderTileCards`;
  `controls.tileAnchor` gives a played card its landing spot). At the reveal
  GameScreen turns every player's plays into `revealCards` (opponents' face
  down, each player's cards on a tile in one pile — `stacked`, `tileSlots`).
  `utils/resolvePlan.ts` turns the resolution steps into a per-tile plan
  (defense build-up, then attackers weakest-first: break / bounce / stalemate)
  and `TileResolver` plays it: camera close-ups on tiles that involve you
  (`resolveCamera`; tiles between them are passed half-zoomed), defense + claim
  badges, piles spreading then cards turning over as they count, a smash that
  hits harder with the claim's power (`heft` and the `claimSmash0`–`8` sounds,
  0–8+), and cards flying home (your discard pile, an opponent's ID card, or a
  burn if trashed). Rivals' earnings fly in as coins (`setShownResources`).
  Tiles given up resolve first (`abandon` / `scorch` steps → 'effect' plans):
  Exodus lifts the holder's color away (`fx.abandon`); Scorched Retreat sets
  the tile on fire (`fx.scorch`) and leaves a permanent burnt wasteland
  (`is_scorched` → the `scorched` biome: char ground, dead trees, ruins of a
  burnt town via `scorched_vp`, smoldering `embers` spots). The engine burns
  a tile in place (`scorchTiles`: terrain patch + per-tile decor ranges), not
  with a full rebuild. Claims that ignore temporary defense (Siege Engine,
  Conqueror) skip it for their own player only — every other claim faces it in
  full (a claim must beat the defense it faces; the strongest that gets
  through wins). Steps carry `defense_ignored` / `ignored_by`; those claims
  attack last and the badge cracks down for them just before they land.
  What card effects do at the reveal is recorded server-side on the tile it
  happened on (`GameState.resolution_effects`, via `_EffectWatch` in
  game_state.py: bank changes, card VP, cards gained, Spoils of War's trash,
  Flood's targets); resolvePlan attaches each to that tile's plan (`after`,
  played once it settles through the resolver api's `bank` / `vp` /
  `giveCard` / `burn`, with a chip naming the card), plays Flood's spread
  (`fx.flood`: hex-shaped water filling its tile, then each tile around from
  the shared edge) right before the tiles it reaches, and plays tile-less ones
  (Diplomat, Battle Glory) last from the player's base ('round' plans).
  Claimants carry `cards` (printed power + named reveal bonuses), so the count
  shows each bonus as its own beat ("+2 · Ambush").
  Preview: `?preview=resolve-animations` (the "Card effects" row too).
- The board canvas runs on under the hand panel (`GameBoard` `extendBelow`);
  `viewInsetBottom` → `CameraRig.insetBottom` frames the island above the
  resting hand via a camera view offset.
- Dev pages: `?preview=cards` (every card face, base/upgraded) and
  `?preview=hand` (a sandbox for draw, play, undo, discard, trash, shuffles,
  purchases and end of turn).
- Occupied territory is themed by the holder's archetype
  (`board3d/territory.ts`): a camp on each held plain tile (Vanguard war
  camp, Fortress watch post, Swarm hive cluster) in the most open corner —
  `buildDecor` records decor footprints; a camp clears trees through the
  roads' decor mask only when there's no room — plus outline markers on
  edges facing other land. Walls (`wallEdges` / `buildWallEdge`) and roads
  (`ROAD_STYLES` in `roads.ts`) take the holder's style too; pieces rise and
  sink per piece like walls. Preview: `?preview=territory`.
- Cursors: gilded PNGs in `frontend/public/cursors/` (arrow, pointer, inspect,
  target, grab, grabbing), drawn as SVG in `frontend/scripts/build_cursors.py`
  (`python3 frontend/scripts/build_cursors.py`, macOS `sips`). Use them via
  `cursor('target')` from `utils/cursors.ts` (CSS `var(--cc-cursor-target)`).
  Clickables use the pointing gauntlet: `var(--cc-cursor-pointer)` (never the
  bare `pointer` keyword); global.css gives it to buttons, links and
  `[role="button"]` by default.

### Audio (frontend)
All sound is synthesized live with Web Audio (no files): recipes in
`frontend/src/audio/sounds.ts` (levels in `LEVELS`, calibrated with
`offlineRender.ts`), instruments (incl. the natural `bugle`) in `instruments.ts`,
the engine in `SoundEngine.ts`. Phase banners (`PhaseBanner`) sound a bugle
call that climbs through the round: 1 → 3 Play, 1 → 4 Resolve, 1 → 5 Buy
(`phaseCall3`–`5`). Background music is `audio/music.ts`: distant march drums
generated bar by bar on their own bus/volume. It plays where a screen turns
it on — the lobby (`setMusicActive`) and the game — never on the home screen;
pauses while the tab is hidden, holds silent through the lobby countdown
(`holdMusic`) and starts over with each game (`restartMusic`). Nothing makes a
sound (no AudioContext is even created) until the page has had a click, tap
or key press. Music/Sounds settings reach the engine from `SettingsProvider`.
Audition page: `?preview=sounds`.

### Game Log Analysis
When the user refers to a "game log" they mean a JSON file produced by
`GET /api/games/{game_id}/log` or the in-app **Download Log** button — typically
found at `~/Downloads/card-clash-game-<uuid>.json`. Use the
`backend/parse_game_log.py` script to parse these structured logs instead of
writing ad-hoc JSON readers.

- Header + full summary (header, event counts, per-player plays/buys, per-round VP):
  `cd backend && uv run python parse_game_log.py <path>`
- Filter to specific event types (comma-separated — e.g. `card_played`,
  `card_purchased`, `round_started`, `game_over`):
  `uv run python parse_game_log.py <path> --events card_played,card_purchased`
- Filter to one actor (player id like `player_0` / `cpu_0`):
  `uv run python parse_game_log.py <path> --player player_1`
- Combine filters, raise the event cap, or drop the summary blocks:
  `uv run python parse_game_log.py <path> --events card_played --player player_1 --limit 0 --no-summary`

For programmatic analysis, import `load_log(path)` / `iter_events(log, event_types=..., actor=...)`
from `parse_game_log` — `ParsedLog.meta` holds the top-level fields (`map_seed`,
`vp_target`, `grid_state`, `players`, `winners`, …) and `ParsedLog.entries` is the
ordered event list. Each CPU `card_played` / `card_purchased` event's `data`
carries a `cpu_reasoning` payload (`flags`, `context`, `score`) that exposes
which `DifficultyProfile` flags drove the decision.

To rebuild the exact hex grid for a given log (VP tile locations, blocked
terrain, bases), pass the log's `map_seed`, `grid_size`, `card_pack`, and
`vp_target` to `create_game(...)` from `app.game_engine.game_state`. VP tiles
are the ones with `tile.is_vp == True` — do **not** filter by `vp_value > 0`
since `vp_value` defaults to 1 for every tile.

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
- `data/cards_vanguard.yaml` — 14 Vanguard archetype cards + upgrades
- `data/cards_swarm.yaml` — 14 Swarm archetype cards + upgrades
- `data/cards_fortress.yaml` — 14 Fortress archetype cards + upgrades
- `data/cards_neutral.yaml` — Starter cards (Explore, Gather) + 12 market cards
- `data/objectives.yaml` — 28 objectives (Vanguard, Swarm, Fortress, Wildcard pools)
- `data/passives.yaml` — 37 passive abilities

---

## Key Design Rules (critical to get right in implementation)

### Turn Structure (5 phases)
1. **Start of Turn** — Distribute Debt card to VP leader (round 5+), draw hand, reveal archetype market (random cards from player's archetype deck). VP is derived from the board at any moment, not scored here
2. **Play Phase** (simultaneous) — Players simultaneously place cards face-down on target tiles. Immediate effects (action gains, "draw immediately" card draws) resolve AS EACH CARD IS PLAYED, enabling chaining.
3. **Reveal & Resolve** — Flip all cards. Resolve Claims (highest power wins tile, ties to defender). Post-resolution effects fire. Delayed draws noted.
4. **Buy Phase** (concurrent in the digital game) — Each player buys and signals when done. Spend resources to re-roll the archetype market (1 resource; there is no Retain action). Purchase archetype cards, shared market cards (max 1 copy of each shared card per round), or upgrade credits (5 resources). Purchases are visible to all players.
5. **End of Turn** — Discard hand. Check the VP target (see VP Scoring). Rotate first player token clockwise.

### Action Slot System
- Most cards cost 1 action to play (`action_cost`; a few heavy cards cost 2–3)
- All archetypes: 5 starting actions per turn
- Some cards grant extra actions when played (e.g. "Gain 1 action" or "Gain 2 actions"); a card whose action return covers its cost can be played at 0 actions
- No hard cap on actions — chaining action-granting cards can exceed 5
- Immediate effects (action gains, card draws) resolve during Play Phase as cards are played

### Claiming Tiles
- All board interaction uses unified Claim cards — most neutral tiles have defense 0; VP hexes have intrinsic defense (standard 2, premium 3; premium neighbours 1), and a tie against a neutral tile's intrinsic defense goes to the attacker
- Claims must target tiles adjacent to one the player already owns, unless card says otherwise
- One Claim per tile per round — except stacking exception cards (Coordinated Push, Dog Pile, Juggernaut)
- Ties go to current owner (defender wins)
- Blocked terrain cannot be claimed without Pathfinder passive

### Resources
- Persistent between turns
- Spent only during Buy Phase
- No cap unless Hoarder passive (caps at 8)

### VP Scoring
- VP is derived (`compute_player_vp`): owned tiles // 3 + connected VP hexes (1 or 2 each) + card VP (Land Grant / Spoils +1 each, formula cards) + bonus VP
- Win condition checked at the end of each round. If several players reach the target together: highest VP, then most connected VP hexes, then most tiles, else a shared victory (`game.winners`)
- Land Grant is an unplayable card worth 1 VP while in your deck
- Bases have defense 3 (all archetypes). A successful base raid gives the defender 1 Rubble (capped at 1 per raid; Rubble is worth 0 VP) and the attacker 1 Spoils (+1 VP)

### Markets
- **Archetype market:** random cards drawn from player's private archetype deck each turn (`archetype_market_size`). Private per player. Re-roll (1 resource) during Buy Phase; Retain is not implemented.
- **Shared market:** Shared stacks with N×2 copies per card (N = player count). When exhausted, gone for the game.
- **Upgrade credits:** Tokens, 5 resources each. Spent during the Play phase to upgrade a card in hand (one credit per card; several per turn allowed). Permanent.

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
- **Explore:** Claim: Power 0 on an adjacent unoccupied tile
- **Gather:** Gain 2 resources

### Objectives
- Not implemented in the digital game yet (data kept in `data/objectives.yaml`)
- Revealed at end of round 3 (Small), 4 (Medium), or 5 (Large)
- 3 objectives revealed: weighted toward archetypes in play
- First player (human or CPU) to meet condition claims it for 2 VP
- CPU players actively pursue objectives

### Passives
- Not implemented in the digital game yet (data kept in `data/passives.yaml`)
- n+2 drawn randomly per game (n = active players)
- Drafted in reverse Round 1 turn order
- Each player picks 1, remainder discarded

### Grid Sizes
One preset map per size (`backend/app/game_engine/map_presets.py`). A map is a
recipe laid out around the bases — features on each base's line to the center
(axis) and on the midline between neighboring bases (gaps) — so every seat
sees the same map.

| Size | Tiles | Map | VP Hexes (premium + standard) | Mountains | Players |
|---|---|---|---|---|---|
| Small | 61 | Crown | 1 + 6 | 6 | 2–3 |
| Medium | 91 | Frontiers | 1 + 6 | 6 | 3–4 |
| Large | 127 | Rings | 1 + 12 | 12 | 4–6 |
| Mega | 169 | Six Crowns | 6 + 7 | 12 | 5–6 |
| Ultra | 217 | Twin Rings | 7 + 6 | 18 | 6 |

- Bases are 2-tile clusters. 2, 3, 4 and 6 players start on corners (four take
  two opposite pairs, so nobody is squeezed between rivals); corner maps are
  symmetric under every rotation and mirror. Five players can't share six
  corners fairly, so their bases spread evenly round the coast and the map is
  laid out around them (`five_player_start`, `five_player_gaps`).
- Every tile next to a base is open: no mountain, VP hex or defense.
- The map seed only turns the board (which corners hold bases).
- The lobby's **Preview Map** (`MapPreview.tsx`, `GET /api/lobby/{code}/map-preview`)
  shows the island with each player's starting tiles in their color.
- CPU players: optional, added by host only

### First Player
- Randomly determined for Round 1
- Rotates clockwise each round
- Passive draft uses reverse Round 1 order to offset Round 1 first-player advantage

---

## Implementation Priority (suggested order)

### Phase 1 — Core Playable Prototype
1. Hex grid generation (one preset map per size)
2. Player setup (archetype selection, passive draft, starting decks)
3. Turn loop with all 5 phases
4. Card playing with action slot tracking and immediate effect chaining
5. Claim resolution (power comparison, adjacency checking, tie-breaking)
6. Resource system (carry-over, buy phase spending)
7. VP scoring and win condition
8. Archetype market (3-card draw, re-roll, retain)
9. Shared market (shared stacks, exhaustion)

### Phase 2 — Full Feature Set
10. Upgrade credit system
11. Objective reveal and tracking
12. All card effects implemented
13. CPU player behavior (expansion, purchasing, objective pursuit)
14. Passive ability system

### Phase 3 — Polish
15. UI for simultaneous play phase
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
- Round limit: **20** (configurable)
- Debt start round: **5**
- Debt trash cost: **3 resources**
- Debt-cost cards: Mercenary, Garrison, Siege Tower (on resolve — even when an immune or scorched tile cancels the claim), Prospector (on play) — `gain_debt` effect; Warden, Land Grant (on buy) — `buy_debt` field
- Re-roll cost: **1 resource**
- Retain cost: **2 resources** (constant only — no Retain action exists)
- Upgrade credit cost: **5 resources**
- Starting resources: **0**
- Action slot hard cap: **none** (5 starting actions)
- Base raid Rubble: **1 per raid** (`RAID_RUBBLE_CAP`)
- Objective VP reward: **2**
- Objective reveal rounds: **3 / 4 / 5 / 6 / 7** (Small / Medium / Large / Mega / Ultra)
