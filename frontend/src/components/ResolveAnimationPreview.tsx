import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { HexTile, PlayerEffect, ResolutionStep, ResolutionClaimant } from '../types/game';
import HexGrid, { type GridTransform, type PixiContainer, PLAYER_COLORS } from './HexGrid';
import ResolveOverlay from './ResolveOverlay';
import PlayerEffectPopups from './PlayerEffectPopups';
import { useSettings, useAnimationSpeed, type AnimationMode } from './SettingsContext';

/**
 * Iteration sandbox for tile-battle resolution animations.
 *
 * Reuses the production `HexGrid` + `ResolveOverlay` components so any tweaks
 * to the animation code paths are reflected here AND in the real game. Buttons
 * trigger scripted `ResolutionStep` payloads that match the backend shape.
 *
 * Route: `?preview=resolve-animations`
 */

// 6 players arranged along the 6 hex directions from (0,0)
const PLAYERS = ['player_0', 'player_1', 'player_2', 'player_3', 'player_4', 'player_5'];
const PLAYER_LABELS = ['Blue', 'Green', 'Yellow', 'Red', 'Orange', 'Purple'];

// Approach direction for each player's territory (one hex direction each)
const APPROACH_DIRS: [number, number][] = [
  [1, 0],    // E  → player_0
  [1, -1],   // NE → player_1
  [0, -1],   // N  → player_2
  [-1, 0],   // W  → player_3
  [-1, 1],   // SW → player_4
  [0, 1],    // S  → player_5
];

const RADIUS = 7;
const CONTESTED_KEY = '0,0';
// Base tiles live at the 6 corners of the radius-7 hex grid so the stack
// offset logic has room to breathe.
const BASE_STEP = RADIUS;
// Territory starts this many tiles inward from each corner base — gives a
// visible owned chain between the base and the contested center.
const TERRITORY_FIRST_STEP = 4;

function makeBlankTile(q: number, r: number): HexTile {
  return {
    q, r,
    is_blocked: false,
    is_vp: false,
    vp_value: 0,
    owner: null,
    defense_power: 0,
    base_defense: 0,
    permanent_defense_bonus: 0,
    held_since_turn: null,
    is_base: false,
    base_owner: null,
  };
}

function buildDemoTiles(centralOwner: string | null, centerIsBase: boolean = false): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  for (let q = -RADIUS; q <= RADIUS; q++) {
    for (let r = -RADIUS; r <= RADIUS; r++) {
      if (Math.abs(q + r) > RADIUS) continue;
      tiles[`${q},${r}`] = makeBlankTile(q, r);
    }
  }
  // Territory for each player: base at a corner (step BASE_STEP), chain inward
  // to TERRITORY_FIRST_STEP. Leaves the inner hexes neutral so claims still
  // need to travel across empty ground.
  for (let i = 0; i < PLAYERS.length; i++) {
    const pid = PLAYERS[i];
    const [dq, dr] = APPROACH_DIRS[i];
    for (let step = TERRITORY_FIRST_STEP; step <= BASE_STEP; step++) {
      const k = `${dq * step},${dr * step}`;
      if (tiles[k]) {
        tiles[k].owner = pid;
        if (step === BASE_STEP) {
          tiles[k].is_base = true;
          tiles[k].base_owner = pid;
        }
      }
    }
  }
  // Central contested tile — either a VP prize (default) or the defender's base (base-raid mode)
  const center = tiles[CONTESTED_KEY];
  if (center) {
    center.owner = centralOwner;
    if (centerIsBase && centralOwner) {
      center.is_base = true;
      center.base_owner = centralOwner;
      center.is_vp = false;
      center.vp_value = 0;
    } else {
      center.is_vp = true;
      center.vp_value = 1;
    }
  }
  return tiles;
}

interface Scenario {
  id: string;
  label: string;
  /** Number of attacker claimants (excludes defender). */
  numAttackers: number;
  /** If true, the central tile is owned by an additional player not in the attacker list. */
  hasDefender: boolean;
  /** Base raid: the central tile is the defender's base tile instead of a VP tile. */
  isBaseRaid?: boolean;
  /** Force the base-raid outcome: 'defended' = base holds, 'captured' = raid succeeds. */
  baseRaidOutcome?: 'defended' | 'captured';
  description: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'solo-neutral',   label: '1 → Neutral',   numAttackers: 1, hasDefender: false, description: '1 player capturing a neutral tile' },
  { id: 'solo-enemy',     label: '1 → Enemy',     numAttackers: 1, hasDefender: true,  description: '1 player capturing an enemy-owned tile' },
  { id: 'battle-2-n',     label: '2 ⚔ Neutral',   numAttackers: 2, hasDefender: false, description: '2 players battling over a neutral tile' },
  { id: 'battle-3-n',     label: '3 ⚔ Neutral',   numAttackers: 3, hasDefender: false, description: '3 players battling over a neutral tile' },
  { id: 'battle-4-n',     label: '4 ⚔ Neutral',   numAttackers: 4, hasDefender: false, description: '4 players battling over a neutral tile' },
  { id: 'battle-5-n',     label: '5 ⚔ Neutral',   numAttackers: 5, hasDefender: false, description: '5 players battling over a neutral tile' },
  { id: 'battle-6-n',     label: '6 ⚔ Neutral',   numAttackers: 6, hasDefender: false, description: '6 players battling over a neutral tile' },
  { id: 'battle-2-o',     label: '2 ⚔ Owned',     numAttackers: 1, hasDefender: true,  description: '2 players (1 attacker + defender) battling over an owned tile' },
  { id: 'battle-3-o',     label: '3 ⚔ Owned',     numAttackers: 2, hasDefender: true,  description: '3 players (2 attackers + defender) battling over an owned tile' },
  { id: 'battle-4-o',     label: '4 ⚔ Owned',     numAttackers: 3, hasDefender: true,  description: '4 players (3 attackers + defender) battling over an owned tile' },
  { id: 'battle-5-o',     label: '5 ⚔ Owned',     numAttackers: 4, hasDefender: true,  description: '5 players (4 attackers + defender) battling over an owned tile' },
  { id: 'battle-6-o',     label: '6 ⚔ Owned',     numAttackers: 5, hasDefender: true,  description: '6 players (5 attackers + defender) battling over an owned tile' },
  { id: 'base-raid-def',  label: '🏰 Base Raid: Defended', numAttackers: 1, hasDefender: true, isBaseRaid: true, baseRaidOutcome: 'defended', description: 'Base raid on an enemy base — defender holds' },
  { id: 'base-raid-cap',  label: '🏰 Base Raid: Captured', numAttackers: 1, hasDefender: true, isBaseRaid: true, baseRaidOutcome: 'captured', description: 'Base raid on an enemy base — raid succeeds' },
];

/** Build a ResolutionStep + the defender_id (for grid pre-setup) for a scenario.
 *  `forceDefended`: if true and the scenario has a defender, force the defender to win
 *  regardless of powers — useful for previewing the attacker-shrinks-back animation. */
function buildScenarioStep(s: Scenario, forceDefended: boolean): { step: ResolutionStep; defenderId: string | null } {
  // Attackers take the first `numAttackers` players
  const claimants: ResolutionClaimant[] = [];
  for (let i = 0; i < s.numAttackers; i++) {
    const pid = PLAYERS[i];
    const [dq, dr] = APPROACH_DIRS[i];
    // Deterministic but varied powers so you can tell numbers apart visually
    const power = 2 + (i % 4);
    claimants.push({
      player_id: pid,
      power,
      // Nearest owned tile to the center (step TERRITORY_FIRST_STEP along
      // the approach direction). Cards fly from here to the contested hex.
      source_q: dq * TERRITORY_FIRST_STEP,
      source_r: dr * TERRITORY_FIRST_STEP,
    });
  }

  let defenderId: string | null = null;
  let defenderPower = 0;
  let defenderSourceQ: number | undefined;
  let defenderSourceR: number | undefined;
  if (s.hasDefender) {
    defenderId = PLAYERS[s.numAttackers]; // next unused player
    if (s.isBaseRaid) {
      // Base raid: force the desired outcome directly via defender power.
      // 'defended' → defender > any attacker (max attacker power 5).
      // 'captured' → defender lower than the lone attacker (attacker has power 2).
      defenderPower = s.baseRaidOutcome === 'defended' ? 9 : 1;
    } else {
      // Normal mode: nominal 1 so there's a visible defense number. Forced-defended: 9 so the
      // defender wins outright against any attacker (max attacker power in demo is 5), while
      // staying a single digit so the centered number renders identically to normal play.
      defenderPower = forceDefended ? 9 : 1;
    }
    // Defender's nearest owned tile — used by the overlay to anchor the
    // defense number to the edge closest to the defender's territory.
    const [dq, dr] = APPROACH_DIRS[s.numAttackers];
    defenderSourceQ = dq * TERRITORY_FIRST_STEP;
    defenderSourceR = dr * TERRITORY_FIRST_STEP;
  }

  // Winner: strongest attacker if they beat defender outright; otherwise defender holds.
  // Ties between multiple top attackers also go to the defender (if any).
  const powers = claimants.map(c => c.power).sort((a, b) => b - a);
  const topPower = powers[0] ?? 0;
  const topCount = powers.filter(p => p === topPower).length;
  const topAttacker = claimants.find(c => c.power === topPower) ?? null;
  let winnerId: string | null;
  if (topAttacker && topPower > defenderPower && topCount === 1) {
    winnerId = topAttacker.player_id;
  } else if (defenderId) {
    winnerId = defenderId;
  } else if (topAttacker) {
    // Neutral tile, all-attacker tie → defender wins ties, but there's no
    // defender, so for the demo just pick the first top attacker.
    winnerId = topAttacker.player_id;
  } else {
    winnerId = null;
  }

  const outcome: ResolutionStep['outcome'] =
    winnerId && winnerId !== defenderId ? 'claimed' : 'defended';

  return {
    step: {
      tile_key: CONTESTED_KEY,
      q: 0, r: 0,
      contested: s.numAttackers > 1 || s.hasDefender,
      claimants,
      defender_id: defenderId,
      defender_power: defenderPower,
      defender_source_q: defenderSourceQ,
      defender_source_r: defenderSourceR,
      winner_id: winnerId,
      previous_owner: defenderId,
      outcome,
      is_base_raid: s.isBaseRaid === true,
    },
    defenderId,
  };
}

// ── Popup simulation scenarios ──────────────────────────────────────────────
// These build sample `PlayerEffect[]` payloads so you can iterate on the
// post-resolution popup animation (intro → stack → hover-expand) without
// playing a real game. Each scenario targets one or more player base tiles;
// the preview uses the same base-tile layout as the resolve scenarios above.

interface PopupScenario {
  id: string;
  label: string;
  build: () => PlayerEffect[];
  description: string;
}

function fx(
  sourceIdx: number,
  targetIdx: number,
  cardName: string,
  effectText: string,
  effectType: string,
  value: number = 1,
): PlayerEffect {
  return {
    source_player_id: PLAYERS[sourceIdx],
    target_player_id: PLAYERS[targetIdx],
    card_name: cardName,
    effect: effectText,
    effect_type: effectType,
    value,
  };
}

const POPUP_SCENARIOS: PopupScenario[] = [
  {
    id: 'single',
    label: 'Single popup',
    description: '1 effect on one base — simplest case',
    build: () => [fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2)],
  },
  {
    id: 'stack-3',
    label: '3-stack on one base',
    description: '3 effects stacked over a single base tile',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 0, 'Embargo', 'Cannot buy next turn', 'buy_restriction'),
      fx(3, 0, 'Raze', '-1 action next turn', 'action_loss', 1),
    ],
  },
  {
    id: 'multi-target',
    label: 'Multi-target (2×2)',
    description: '2 effects on player 0 + 2 on player 3 — two stacks side by side',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 0, 'Embargo', 'Cannot buy next turn', 'buy_restriction'),
      fx(4, 3, 'Raze', '-1 action next turn', 'action_loss', 1),
      fx(5, 3, 'Spoils', '+1 Land Grant', 'grant_land_grants', 1),
    ],
  },
  {
    id: 'stack-5',
    label: '5-stack (tall)',
    description: '5 effects on one base — tests offscreen-flip for small viewports',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 0, 'Embargo', 'Cannot buy next turn', 'buy_restriction'),
      fx(3, 0, 'Raze', '-1 action next turn', 'action_loss', 1),
      fx(4, 0, 'Cease Fire', '+1 free reroll', 'free_reroll', 1),
      fx(5, 0, 'Base Raid', 'Defended!', 'base_raid_defended', 1),
    ],
  },
  {
    id: 'all-six',
    label: '1 each on 6 bases',
    description: '1 effect on every base — tests all six hex directions',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 1, 'Embargo', 'Cannot buy', 'buy_restriction'),
      fx(3, 2, 'Raze', '-1 action', 'action_loss', 1),
      fx(4, 3, 'Cease Fire', '+1 free reroll', 'free_reroll', 1),
      fx(5, 4, 'Spoils', '+1 Land Grant', 'grant_land_grants', 1),
      fx(0, 5, 'Base Raid', 'Defended!', 'base_raid_defended', 1),
    ],
  },
  {
    id: 'stack-5-all',
    label: '5-stack on all bases',
    description: '5 effects on every base — stress-tests offscreen clamping and stacking at every corner',
    build: () => {
      const effects: PlayerEffect[] = [];
      const templates: Array<{ name: string; effect: string; type: string; value: number }> = [
        { name: 'Sabotage',  effect: '-2 resources',         type: 'resource_loss', value: 2 },
        { name: 'Embargo',   effect: 'Cannot buy next turn', type: 'buy_restriction', value: 1 },
        { name: 'Raze',      effect: '-1 action next turn',  type: 'action_loss',   value: 1 },
        { name: 'Cease Fire',effect: '+1 free reroll',       type: 'free_reroll',   value: 1 },
        { name: 'Base Raid', effect: 'Defended!',            type: 'base_raid_defended', value: 1 },
      ];
      for (let target = 0; target < PLAYERS.length; target++) {
        for (let i = 0; i < templates.length; i++) {
          const source = (target + i + 1) % PLAYERS.length; // don't target self
          const t = templates[i];
          effects.push(fx(source, target, t.name, t.effect, t.type, t.value));
        }
      }
      return effects;
    },
  },
];

export default function ResolveAnimationPreview() {
  const [tiles, setTiles] = useState<Record<string, HexTile>>(() => buildDemoTiles(null));
  const [resolving, setResolving] = useState(false);
  const [steps, setSteps] = useState<ResolutionStep[]>([]);
  const [snapshotTransform, setSnapshotTransform] = useState<GridTransform | null>(null);
  const [snapshotRect, setSnapshotRect] = useState<DOMRect | null>(null);
  const [runId, setRunId] = useState(0);
  const [lastScenario, setLastScenario] = useState<Scenario | null>(null);
  /** When on, owned-tile scenarios force the defender to win so the attacker-shrink-back plays. */
  const [forceDefended, setForceDefended] = useState(false);

  // Popup simulation state — keyed on `popupRunId` so re-triggering the same
  // scenario remounts the component and replays the intro animation.
  const [popupEffects, setPopupEffects] = useState<PlayerEffect[]>([]);
  const [popupRunId, setPopupRunId] = useState(0);
  const [lastPopupScenario, setLastPopupScenario] = useState<PopupScenario | null>(null);

  // Grid rotation — mirrors GameScreen's r / shift+r shortcuts so the preview
  // can exercise the same rotation animation that the real game uses.
  const [gridRotation, setGridRotation] = useState(0);

  const transformRef = useRef<GridTransform | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const resolveLayerRef = useRef<PixiContainer | null>(null);

  const { settings, setAnimationMode } = useSettings();
  const animSpeed = useAnimationSpeed();

  const playScenario = useCallback((s: Scenario) => {
    const { step, defenderId } = buildScenarioStep(s, forceDefended);
    // Reset the grid so the central tile matches this scenario's pre-battle state.
    // For base-raid scenarios the central tile is the defender's base (not a VP tile).
    setTiles(buildDemoTiles(defenderId, s.isBaseRaid === true));
    setSteps([step]);
    setLastScenario(s);
    setRunId(x => x + 1);
    // Snapshot transform — ResolveOverlay needs these to convert hex→screen coords
    setSnapshotTransform(transformRef.current);
    setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
    setResolving(true);
  }, [forceDefended]);

  /** Keep snapshotted transform fresh if the user resizes while idle. */
  useEffect(() => {
    if (resolving) return;
    const onResize = () => {
      setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [resolving]);

  /** r / shift+r to rotate the grid (matches GameScreen's shortcut).
   *  Ignored while a rotation-sensitive resolve animation is running or when
   *  an input element has focus. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (resolving) return;
      e.preventDefault();
      setGridRotation(prev => prev + (e.shiftKey ? -1 : 1) * (Math.PI / 6));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resolving]);

  /** Called by ResolveOverlay when each step begins — apply ownership change. */
  const applyStep = useCallback((idx: number) => {
    const step = steps[idx];
    if (!step) return;
    setTiles(prev => {
      const tile = prev[step.tile_key];
      if (!tile) return prev;
      if ((step.outcome === 'claimed' || step.outcome === 'auto_claim') && step.winner_id && !tile.is_base) {
        return { ...prev, [step.tile_key]: { ...tile, owner: step.winner_id } };
      }
      return prev;
    });
  }, [steps]);

  const handleComplete = useCallback(() => {
    setResolving(false);
    setSteps([]);
  }, []);

  const handleReset = useCallback(() => {
    setTiles(buildDemoTiles(null));
    setSteps([]);
    setResolving(false);
    setLastScenario(null);
  }, []);

  const handleTileClick = useCallback(() => {/* no-op */}, []);

  const playPopupScenario = useCallback((s: PopupScenario) => {
    // Make sure we have a fresh transform snapshot so popups position correctly
    // even if the user just resized or scrolled.
    setSnapshotTransform(transformRef.current);
    setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
    // Ensure the grid layout matches expectations (all 6 bases present, neutral center).
    setTiles(buildDemoTiles(null));
    setPopupEffects(s.build());
    setLastPopupScenario(s);
    setPopupRunId(x => x + 1);
  }, []);

  const clearPopups = useCallback(() => {
    setPopupEffects([]);
    setLastPopupScenario(null);
  }, []);

  const desc = lastScenario?.description
    ?? lastPopupScenario?.description
    ?? 'Click a scenario to play an animation';

  // Build a player-name map from the demo PLAYERS/PLAYER_LABELS arrays.
  const playerNames = useMemo(
    () => Object.fromEntries(PLAYERS.map((p, i) => [p, PLAYER_LABELS[i]])),
    [],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: '#1a1a2e', color: '#fff' }}>
      {/* Top bar — structured so height is stable regardless of state.
          Row 1: scenario buttons (may wrap; width-only dependent).
          Row 2: reset + animation toggle + status text (fixed-height row). */}
      <div style={{ padding: '12px 20px 10px', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16, marginRight: 8 }}>Resolve Animation Preview</h2>
          {SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => playScenario(s)}
              disabled={resolving}
              style={{
                ...btnStyle,
                background: resolving ? '#2a2a3e' : (lastScenario?.id === s.id ? '#6a8fff' : '#4a9eff'),
                opacity: resolving ? 0.5 : 1,
                cursor: resolving ? 'not-allowed' : 'pointer',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Row 2: popup-simulation scenarios. These trigger the PlayerEffectPopups
            component directly so you can iterate on the intro → stacked → hover-expand
            lifecycle without playing a full game. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#aaa', marginRight: 4 }}>Popups:</span>
          {POPUP_SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => playPopupScenario(s)}
              disabled={resolving}
              style={{
                ...btnStyle,
                background: resolving ? '#2a2a3e' : (lastPopupScenario?.id === s.id ? '#c77dff' : '#8a4fff'),
                opacity: resolving ? 0.5 : 1,
                cursor: resolving ? 'not-allowed' : 'pointer',
              }}
              title={s.description}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={clearPopups}
            disabled={popupEffects.length === 0}
            style={{
              ...btnStyle,
              background: popupEffects.length === 0 ? '#2a2a3e' : '#555',
              opacity: popupEffects.length === 0 ? 0.5 : 1,
              cursor: popupEffects.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Clear popups
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28 }}>
          <button onClick={handleReset} disabled={resolving} style={{ ...btnStyle, background: '#555', opacity: resolving ? 0.5 : 1, cursor: resolving ? 'not-allowed' : 'pointer' }}>
            Reset
          </button>

          <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #555' }}>
            <span style={{ padding: '6px 8px', fontSize: 11, color: '#aaa', background: '#2a2a3e' }}>Animations</span>
            {(['normal', 'fast', 'off'] as AnimationMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setAnimationMode(mode)}
                disabled={resolving}
                style={{
                  padding: '6px 10px',
                  background: settings.animationMode === mode ? '#4a9eff' : '#2a2a3e',
                  border: 'none',
                  borderLeft: '1px solid #555',
                  color: settings.animationMode === mode ? '#fff' : '#aaa',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: resolving ? 'not-allowed' : 'pointer',
                  opacity: resolving ? 0.5 : 1,
                  textTransform: 'capitalize',
                }}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* Force-defended toggle — forces owned-tile scenarios to resolve in the defender's favor
              so you can preview the attacker-shrink-back animation. No effect on neutral scenarios. */}
          <button
            onClick={() => setForceDefended(v => !v)}
            disabled={resolving}
            style={{
              ...btnStyle,
              background: forceDefended ? '#ff9a3c' : '#2a2a3e',
              border: '1px solid #555',
              color: forceDefended ? '#1a1a2e' : '#aaa',
              opacity: resolving ? 0.5 : 1,
              cursor: resolving ? 'not-allowed' : 'pointer',
            }}
            title="Force the defender to win on owned-tile scenarios"
          >
            Defended: {forceDefended ? 'ON' : 'off'}
          </button>

          {/* Status text: min-width: 0 + overflow: hidden + whiteSpace: nowrap so the
              bar height never changes when text grows/shrinks. */}
          <span style={{ fontSize: 12, color: '#888', marginLeft: 8, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {resolving ? 'Resolving…' : desc}
          </span>
        </div>
      </div>

      <div ref={gridContainerRef} style={{ flex: 1, position: 'relative' }}>
        <HexGrid
          tiles={tiles}
          onTileClick={handleTileClick}
          transformRef={transformRef}
          resolveLayerRef={resolveLayerRef}
          activePlayerId={lastScenario ? PLAYERS[0] : undefined}
          gridRotation={gridRotation}
        />
      </div>

      <div style={{ padding: '10px 20px', borderTop: '1px solid #333', fontSize: 12, color: '#aaa', lineHeight: 1.6 }}>
        Each player sits in one hex-direction from the central (0,0) tile. Attackers fly their power numbers in from their frontier tile;
        the defender (if any) appears at the target. Animation code is the production <code>ResolveOverlay</code> + <code>HexGrid</code> — tweaks here flow through to the real game.{' '}
        <span style={{ marginLeft: 8 }}>
          Players:{' '}
          {PLAYERS.map((p, i) => (
            <span key={p} style={{ color: `#${(PLAYER_COLORS[p] ?? 0xffffff).toString(16).padStart(6, '0')}`, marginRight: 10 }}>
              {PLAYER_LABELS[i]}
            </span>
          ))}
        </span>
      </div>

      {resolving && steps.length > 0 && (
        <ResolveOverlay
          key={runId}
          steps={steps}
          gridTransform={snapshotTransform}
          gridRect={snapshotRect}
          gridContainerRef={gridContainerRef}
          resolveLayerRef={resolveLayerRef}
          onStepApply={applyStep}
          onComplete={handleComplete}
        />
      )}

      {/* Keep the component mounted once a scenario has played so clearing
          popups triggers the built-in fade-out instead of instantly unmounting.
          The `key` resets the component when a new scenario is triggered. */}
      {popupRunId > 0 && (
        <PlayerEffectPopups
          key={popupRunId}
          effects={popupEffects}
          gridTransform={snapshotTransform}
          gridRect={snapshotRect}
          tiles={tiles}
          playerNames={playerNames}
          activePlayerId={PLAYERS[0]}
          animSpeed={animSpeed}
          gridTransformRef={transformRef}
          gridContainerRef={gridContainerRef}
        />
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: '#4a9eff',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
};
