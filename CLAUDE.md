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
- Standard suite: `cd backend && uv run python scripts/difficulty_benchmark.py --suite --games 300 --grid small,medium` (add `--pack first_clash,border_war,deep_roots,far_reaches` to play inside the real packs; the default is Everything)
- Specific matchups: `uv run python scripts/difficulty_benchmark.py hard:rush medium:hard@base --games 400`
- Archetype balance (Hard mirror): `uv run python scripts/difficulty_benchmark.py hard:hard --games 900 --grid small,medium` (add `--players 3`)
Re-run the suite after changing CPU logic **or** card balance — card changes shift
the tiers too. CPU buy/upgrade valuation lives in `backend/app/game_engine/cpu_valuation.py`;
per-tier feature flags and weights are the `DifficultyProfile`s in `cpu_player.py`.

### Card Packs & Balance
A game is played with one card pack (`backend/app/game_engine/card_packs.py`,
listed in lobby order): **5 shared cards + 5 cards per archetype**, so each
player has the same 10 cards to buy all game. First Clash (default, for
learning), Border War, Deep Roots, Far Reaches; Everything (`testing_only`) is
every card at once, listed last. Packs draw on the **Core set** (`set: core` in
the YAML → `Card.card_set`; `tests/test_card_packs.py` checks Core equals the
union of the packs and that no player gets two cards in a `NEAR_DUPLICATES`
group); other cards are `set: set_aside` for future sets.
- Supply: private archetype piles of `ARCHETYPE_PILE_SIZE` = 3 copies per card
  per player; the market shows the top of each pile (`archetype_supply`), so
  re-roll is refused; buy one of each card per round. Shared piles hold
  `shared_pile_size(n)` = 4 + 2n copies.
- Upgrades change **only numbers** (`tests/test_upgrades.py` normalizes the
  text and checks it); drawbacks stay. Exceptions: Diplomat, Plague.
- Balance harness: `cd backend && uv run python scripts/pack_balance.py --games 400 --tables 2:small,3:medium,4:medium`
  (Hard CPUs inside each pack; `--detail` per card, `--inject` / `--force`
  paired card tests, `TUNE_SWAPS` / `TUNE_SET` to try changes without editing
  data). Targets: archetype win rate 40–60% at 2p, 23–43% at 3p, 15–35% at 4p.
- Playtests for every reworked card: `tests/test_changed_cards.py` (the
  `Table` harness plays a card through play → reveal → next round).

### Builds & the Pack Acceptance Test
Packs should offer several strategies, measured the way Dominion measures
against Big Money. **Fast Claim** is Card Clash's Big Money and the yardstick
for every CPU tier: buy the Claim with the highest *typical* power you can
afford (`cpu_builds.typical_claim_power`: bonuses its usual play meets —
Strike Team's +2 in full, Overwhelm +2, Mountaineer's neutral bonus — less
1.5 per Debt or extra action), never save; it plays with Medium tactics
(`cpu_builds.FastClaimCPU`; the benchmark's `fastclaim` agent; `rush` is the
same buying with Hard play). A **build** is a named buy plan —
`(card id, copies)` in priority order — listed per pack in
`backend/app/game_engine/pack_builds.py` (never sent to players: finding
strategies is the game). A CPU buys its build's cards first, then as its
tier always would.
- Tiers (`DifficultyProfile.follow_builds`, on for all three;
  `cpu_builds.choose_build`, seeded by game + player so a CPU keeps its build):
  Easy plays Fast Claim or one of the weaker half of its builds, Medium a
  random build rated ≥55%, Hard the best-rated one. A pack with no builds
  (Everything) buys as before. Targets vs Fast Claim (2p, suggested map):
  Easy 25–40%, Medium ≥50%, Hard ≥70% — First Clash: 31 / 66 / 77.
- Find builds: `cd backend && uv run python scripts/build_search.py --pack first_clash`
  (hill-climbs buy plans per archetype for Hard play vs Fast Claim, finalists
  re-scored on fresh seeds; `--plans "card:n,card:n|..."` scores given
  builds; `TUNE_SWAPS="pack:arch:old=new"` tries a pack change).
- Acceptance test: `uv run python scripts/pack_builds.py` (each build, with
  Medium play like Fast Claim's, vs Fast Claim and a round-robin of builds;
  2p Large + Medium). A pack passes when ≥3 builds beat Fast Claim (≥55%,
  one per archetype), no build beats every other build, every card is in a
  winning build, and Fast Claim beats the Easy CPU. `--vp-plus N` lengthens
  games; `--tiers` adds Medium/Hard vs Fast Claim. `--write-ratings` stores
  each build's win rate vs Fast Claim in `data/build_ratings.json` — the
  Large-map rating is the one every game uses (`RATING_GRID`). Re-run it after
  changing a pack, a build or card balance.
- Card lesson from tuning: Fast Claim buys only Claims, so buffing non-Claim
  cards (engine, defense, synergy — Swarm Tactics, Drone Wave, Iron
  Discipline) strengthens strategies without strengthening the baseline;
  buffing Claims strengthens both.

### Solo Campaigns
Three campaigns of pre-made levels, one per archetype like StarCraft's races
(Home → **Solo** → pick Vanguard, Swarm or Fortress → that campaign's
overworld). You always play a campaign's levels as its archetype; to switch,
go back to the campaign choice. Levels are data: `data/solo_levels.yaml` (its
header documents the format), loaded and checked by
`backend/app/game_engine/solo.py` — any mistake raises `LevelError` and fails
`tests/test_solo.py`.
- **Campaigns** (`campaigns.<archetype>`: title, blurb, `levels` in order,
  `soon` spots): each starts from its own castle (`V` / `S` / `F` on the
  shared overworld), builds its own road from spot to spot, and leans on the
  archetype's strengths (Vanguard raids and takes, Swarm spreads, Fortress
  holds). All three run **ten levels on the same curve**
  (`test_every_campaign_runs_the_same_curve`): 1–3 easy and rival-free, 4–7
  medium, 8–10 hard with **no time limit** and showcase maps, and 10 the
  finale — two hard rivals with a head start on the map (more `b`/`c`
  starting land), not on their decks. Measured with `play --focus` (`play`
  for a VP race): easy ≈ 85%+, medium ≈ 55–80%, hard ≈ 25–50%.
- **A level** sits on one `spot` (an overworld letter) and has a title,
  intro, `objective`, `map`, `cards`, optional `bots` (archetype, difficulty,
  name), `market`, `debt`, `hints` and `spotlight` (the cards it introduces —
  design it so it's near impossible without them; `--without` checks). A
  level in two campaigns is a **shared level**: the same spot, map and tile,
  reached by each campaign's road and played from the other side —
  `variants.<archetype>` changes its title, intro, objective, bots, cards,
  hints, spotlight or `seat` (`seat: B` puts you on B's base; bots take the
  other bases in letter order, unused bases become land). `load_campaign`
  returns one `SoloLevel` per campaign it's in (`shared_with` names the
  others).
- **Maps** are hex art, one character per tile, two characters per column,
  each column half a row below the one to its left (a tile touches the tiles
  two lines up/down in its column and one line up/down beside it — a wall
  across the map takes two lines); draw your base `A` at the bottom (the
  game turns it there) and write `layout: |2`. Legend: `.` land, `#`
  mountain, `*`/`@` 1/2-VP hex, `1`–`9` defended land, `~` water (a lake or
  inlet: blocked, drawn as sea with beaches round it — the board engine
  leaves water out of its tiles and `BoardLayout.beach` slopes the land
  down to sand), `%` scorched earth (blocked, burnt), `&` a burnt town's
  ruins, `A`–`F` bases and `a`–`f` their starting land; a level's `legend`
  adds more (`X: {vp: 1, defense: 5}`, `{water: true}`). A space is sea.
  Or `preset: small`. `overrides` change single tiles by "q,r".
- **Objectives** (`Objective` in solo.py), judged at the end of every round
  up to `rounds`: `vp`, `territory` (tiles or a `share` of the land),
  `vp_hexes` (all at once, optionally `connected`), `raid` (every rival's
  base), `capture` (take N tiles from rivals), `fortify` (N tiles at
  permanent defense D), `survive` (hold out to round R; lost when your base
  is raided more than `raids_allowed` times or you lose more than
  `tiles_lost_max` tiles; optionally still hold `tiles`). Raids and captures
  are tallied from each round's `player_effects` / `resolution_steps`
  (`_round_tally`). With bots, one reaching `bot_vp` first loses the level.
  **No `rounds`: no time limit** — lost only when a rival reaches `bot_vp`
  (so it needs bots and one, and can't be a survive); set `debt: false`, or
  Debt keeps the leaders from ever getting there; `UNTIMED_ROUND_GUARD` (50)
  ends a stalemate as a loss. Bots only raid bases at Hard. Add a type in
  `Objective.from_data` / `goal` / `headline`, `objective_progress`, `_judge`
  and the frontend `SoloObjectiveType`.
- **No level falls to the starting deck.** Explore only takes open land
  next to yours, so the most Explore and Gather can ever hold is your start
  plus the open land joined to it (`starter_ceiling` in solo.py; `list`
  prints it). `test_no_level_falls_to_the_starting_deck` fails if that could
  meet an objective: ring each start with defended land the level's cards
  break through, keep VP hexes defended, and give every `survive` a `tiles`
  count above the ceiling (otherwise sitting tight with Gathers wins — Hard
  bots rarely get through a base's defense 3). `play --starters` (buys only
  upgrade credits: Explore+/Gather+) and `--starters turtle` (only Gathers)
  should clear nothing.
- **Engine**: a level plays as an ordinary game with `GameState.solo` set
  (`create_solo_game`): `create_game(grid=, pack=)` takes the level's board
  and cards (`game_pack(game)` reads the pool), `check_solo_objective` in
  `execute_end_of_turn` decides the game instead of the VP target and round
  limit (`solo.result` / `solo.reason`; `to_dict` adds live `solo.progress`;
  a reveal that wins the level skips that round's buy phase —
  `won_this_round` in `_transition_to_buy`), and Debt never goes to a player
  alone (nor with `debt: false`).
- **API** (`app/api/solo.py`): `GET /api/solo/levels` (overworld + each
  campaign's castle, roads and levels), `GET /api/solo/levels/{id}/map?archetype=`
  (the board as that side starts it — the briefing's **Preview map**),
  `POST /api/solo/levels/{id}/start` `{archetype}` — registers a private,
  already-started lobby for the game, so the frontend plays it like any
  lobby game (WebSocket, tokens, CPU buys).
- **Frontend** (`components/solo/`): `SoloCampaignSelect`, `SoloOverworld`
  (reuses GameBoard: one campaign's castle and spots as towns — drawn with
  crowns, `vpGlyph="crown"` — turned so its castle sits at the bottom like a
  game's base; your territory covers its road up to the next level and grows
  when you clear one; the overworld layout takes `~` water and `%` scorched
  land too), `SoloLevelPanel` (briefing) + `SoloMapPreview`,
  `SoloObjectiveHud` ("No time limit" for an untimed level; `roundLimit()`
  in GameScreen). Progress is per browser and per campaign in localStorage
  (`cardclash_solo_progress`, every access guarded); a level unlocks once
  every level before it in its campaign is cleared. `?preview=solo-maps`
  (`&level=<id>&campaign=<arch>`) shows any level's map, locked or not.
- **Tuning**: `cd backend && uv run python scripts/solo_levels.py` lists the
  campaigns; `... map <level>` prints a map with "q,r" keys; `... play
  [levels] [--campaign swarm] --games 20` puts a CPU of each tier in your
  seat; `--curve` (with `--rounds N` to look past the limit) prints progress
  by round and the leading rival's VP — rivals sharing a map level off, so
  pick an untimed level's `bot_vp` from it; `--focus` makes your seat play
  for the objective (buys spotlight cards and, out of spare resources,
  upgrades for them; claims objective tiles, seeds islands with Proliferate,
  stacks on bases, fortifies) — the CPUs otherwise play for VP and ignore
  other objectives; `--without card,...` checks a spotlight really matters.
  Keep runs small.

### Card Art
Card art lives in `frontend/public/cards/<definition_id>.png` (source). The app
loads a compressed `.webp` sibling first (≈40 KB vs ≈500 KB) and falls back to the
PNG. After adding or replacing art, regenerate the WebPs (incremental):
`uv run --project backend --with pillow python frontend/scripts/optimize_images.py`
Preloading is handled by `frontend/src/utils/cardImagePreload.ts` (hand/deck/markets
at high priority, the rest of the catalog during idle time).

### Tutorial Cards
The tutorial (`frontend/src/components/tutorial/`) embeds the cards it shows in
`tutorialCards.ts`, generated from the card data. After changing any of them
(Explore, Gather, Levy, Mercenary, Watchtower, Barricade, Siege Tower, Spoils,
Rubble, Debt), regenerate: `cd backend && uv run python scripts/build_tutorial_cards.py`
(`tests/test_tutorial_cards.py` fails until you do), then check the scenes'
narration in `tutorialScenes.tsx` still describes them.

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
  `controls.tileAnchor` gives a played card its landing spot). A stack never
  drops while it's up (`stackPerch`: it keeps above the tallest label it has
  sat over, easing up to a taller one) and keeps to its side of the tile
  (above, or hanging below near the top edge) while that side has room — so a
  card stays one card from play through reveal and resolve. Your planned
  cards stay on the board until the reveal's `revealCards` take over, and a
  card's player glow fades in once it lands. At the reveal
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
  with a full rebuild. Claims that ignore temporary defense (the engine's
  `IGNORE_DEFENSE` effect — no card uses it now; Siege Engine and Conqueror
  get +2 power against a defense bonus instead) skip it for their own player
  only — every other claim faces it in full (a claim must beat the defense it faces; the strongest that gets
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
  shows each bonus as its own beat ("+2 · Ambush"). A tile's cards line up left
  to right in the order they turn over (`revealOrder` / `sortByReveal`).
  VP won or lost during the resolve flies to the player's score as stars
  (`VpStar`, red for a loss), and the score counts as each lands: board VP
  (`boardVpChanges` in `utils/vpBreakdown.ts` — a VP hex connecting or cut off
  flies from the hex, the tile count crossing a multiple of 3 from the tile
  that changed hands) and card VP (Battle Glory, Spoils, Land Grant) from where
  it happened.
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
generated bar by bar on their own bus/volume, with quiet horn chords in G (the
bugle's key) from the ninth bar — two bars a chord through a few march
progressions (`PROGRESSIONS`), resting after two in a row, ending a run on G,
≈ 6–9 dB under the drums (`LEVELS.horn`). It's off until the player turns
Music on in the settings (saved as `music: 'on'`), then plays where a screen
turns it on — the lobby (`setMusicActive`) and the game — never on the home screen;
pauses while the tab is hidden, holds silent through the lobby countdown
(`holdMusic`) and starts over with each game (`restartMusic`). Nothing makes a
sound (no AudioContext is even created) until the page has had a click, tap
or key press. Music/Sounds settings reach the engine from `SettingsProvider`.
Bluetooth output (AirPods ≈ 170 ms) hears every sound late by a fixed amount;
`audio/outputDelay.ts` measures the output's delay (`outputLatency` /
`getOutputTimestamp`), and sounds that belong to a moment on screen we can see
coming are *cued* for it — `sfx.cue(name, inMs)` / `claimSmashIn` /
`soundEngine.playIn` start early by the delay beyond the usual (claim smashes
at the end of their wind-up, staggered draws, cards landing on the discard
pile, the board's tile pops). Sounds that start with what you just did can't
be early. Audition page: `?preview=sounds` (shows the output delay and has a
Sync check: a dot flashing with a cued tick).

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
- `data/cards_vanguard.yaml` — 30 Vanguard archetype cards + upgrades (12 Core)
- `data/cards_swarm.yaml` — 30 Swarm archetype cards + upgrades (12 Core)
- `data/cards_fortress.yaml` — 30 Fortress archetype cards + upgrades (10 Core)
- `data/cards_neutral.yaml` — Starter cards (Explore, Gather), Debt/Rubble/Spoils, and the shared market cards
- `data/objectives.yaml` — 28 objectives (Vanguard, Swarm, Fortress, Wildcard pools)
- `data/passives.yaml` — 37 passive abilities
- `data/solo_levels.yaml` — the solo campaigns: overworld, campaigns and levels (see Solo Campaigns)

---

## Key Design Rules (critical to get right in implementation)

### Turn Structure (5 phases)
1. **Start of Turn** — Distribute Debt card to VP leader (round 5+), draw hand, show the archetype market (the top of each of the player's 5 archetype piles). VP is derived from the board at any moment, not scored here
2. **Play Phase** (simultaneous) — Players simultaneously place cards face-down on target tiles. Immediate effects (action gains, "draw immediately" card draws) resolve AS EACH CARD IS PLAYED, enabling chaining.
3. **Reveal & Resolve** — Flip all cards. Resolve Claims (highest power wins tile, ties to defender). Post-resolution effects fire. Delayed draws noted.
4. **Buy Phase** (concurrent in the digital game) — Each player buys and signals when done. Purchase archetype cards and shared market cards (max 1 copy of each card per round), or upgrade credits (5 resources). Purchases are visible to all players.
5. **End of Turn** — Discard hand. Check the VP target (see VP Scoring). Rotate first player token clockwise.

### Action Slot System
- Most cards cost 1 action to play (`action_cost`; a few heavy cards cost 2–3)
- All archetypes: 5 starting actions per turn
- Some cards grant extra actions when played (e.g. "Gain 1 action" or "Gain 2 actions"); a card whose action return covers its cost can be played at 0 actions
- No hard cap on actions — chaining action-granting cards can exceed 5
- Immediate effects (action gains, card draws) resolve during Play Phase as cards are played

### Claiming Tiles
- All board interaction uses unified Claim cards — most neutral tiles have defense 0; VP hexes have intrinsic defense (standard 2, premium 3; premium neighbours 1), and a tie against a neutral tile's intrinsic defense goes to the attacker ("match a neutral tile's defense to take it; beat a rival to take theirs")
- A Claim's conditional power is settled at the reveal (`settle_claim_powers`: after abandons and Defense cards, before any tile changes hands); only hand-counting power (Strength in Numbers) is fixed at play time
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
- **Archetype market:** with a pack, private piles of 3 copies of each of the player's 5 archetype pack cards, all on show every round (no re-roll). Everything pack only: random cards drawn from the private archetype deck each turn (`archetype_market_size`), re-roll 1 resource. Retain is not implemented.
- **Shared market:** the pack's 5 shared cards, 4 + 2N copies each (N = player count). When exhausted, gone for the game.
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
- **Explore:** Claim 1 defenseless, unoccupied tile next to your land (`defenseless_only` — never an owned tile or one with defense; any rival claim beats it). Explore+: up to 2 such tiles
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

| Size | Tiles | Map | VP Hexes (premium + standard) | Mountains | Suggested for |
|---|---|---|---|---|---|
| Small | 61 | Crown | 1 + 6 | 6 | — (2–3 players finish in ~7 rounds) |
| Medium | 91 | Frontiers | 1 + 6 | 6 | 4 players |
| Large | 127 | Rings | 1 + 12 | 12 | 2, 3, 5, 6 players |
| Mega | 169 | Six Crowns | 6 + 7 | 12 | — |
| Ultra | 217 | Twin Rings | 7 + 6 | 18 | — |

- The suggested size (`suggested_grid_size` / `SUGGESTED_GRID` in game_state.py)
  is the smallest map where games run 11+ rounds — long enough for an early
  investment to pay off (Hard CPUs, First Clash: 2p Large 12.1 rounds, 3p
  Large 12.9, 4p Medium 15.5, 5–6p Large 19+). The lobby follows it as players
  join and leave (`LobbyConfig.grid_size_auto`) until the host picks a size;
  "Use suggested" goes back.

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
- Max live games per server process: **200** (`MAX_LIVE_GAMES` env var, `routes.py`) —
  games held in memory (≈2 MB each). When full, finished games and ones idle 5+ min
  are dropped from memory (they stay in the DB) before new games get a 503
- Memory: finished games leave the cache after **10 min** idle, in-progress ones after
  **30 min** (reloaded from the DB on return); unstarted lobbies expire after **15 min**
  without activity, started ones after **2 h** with nobody connected
- Objective VP reward: **2**
- Objective reveal rounds: **3 / 4 / 5 / 6 / 7** (Small / Medium / Large / Mega / Ultra)
