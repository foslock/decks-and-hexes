import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { GameState, Card, ResolutionStep, PlayerEffect } from '../types/game';
import HexGrid, { type GridTransform, type PlannedActionIcon, type ClaimChevron, type VpPath, PLAYER_COLORS, syncPlayerColors } from './HexGrid';
import PlayerHud from './PlayerHud';
import CardHand, { CardViewPopup, type PlayTarget } from './CardHand';
import CardBrowser from './CardBrowser';
import ShopOverlay from './ShopOverlay';
import FullGameLog from './FullGameLog';
import SettingsPanel from './SettingsPanel';
import PhaseBanner from './PhaseBanner';
import ResolveOverlay from './ResolveOverlay';
import GameIntroOverlay from './GameIntroOverlay';
import GameOverOverlay from './GameOverOverlay';
import { CARD_TYPE_COLORS, getCardDisplayColor } from '../constants/cardColors';
import { useAnimated, useAnimationMode, useAnimationOff, useAnimationSpeed } from './SettingsContext';
import Tooltip, { IrreversibleButton, HoldToSubmitButton, type HoldToSubmitHandle } from './Tooltip';
import * as api from '../api/client';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { buildCardSubtitle, type CardSubtitleContext } from './cardSubtitle';
import { renderSubtitlePart } from './SubtitlePartRenderer';
import { useSound } from '../audio/useSound';

/** Check if an engine card needs an opponent target (forced discard or inject rubble). */
function needsOpponentTarget(card: Card): boolean {
  return (card.forced_discard > 0) ||
    (card.effects?.some(e => e.type === 'inject_rubble') ?? false);
}

/**
 * Compute effective power for a card still in hand, accounting for dynamic
 * modifiers (hand-size scaling, tile-count scaling).  Returns a copy of the
 * card with `power` overridden if applicable.  Used only for the drag
 * preview — once a card is played, the backend snapshots effective_power on
 * the PlannedAction and the frontend uses that instead.
 */
function withEffectivePower(card: Card, handSize: number, tileCount: number): Card {
  if (!card.effects) return card;
  const isUpgraded = card.is_upgraded;

  for (const eff of card.effects) {
    if (eff.type === 'power_per_tiles_owned') {
      const divisor = (isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value) || 3;
      const scaledPow = Math.floor(tileCount / divisor);
      const totalPow = eff.metadata?.replaces_base_power ? scaledPow : card.power + scaledPow;
      return { ...card, power: totalPow };
    }
    if (eff.type === 'power_modifier' && eff.condition === 'cards_in_hand') {
      const ev = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
      return { ...card, power: Math.max(0, handSize - 1) + ev };
    }
  }

  return card;
}

// Hex geometry constants (must match HexGrid.tsx)
const HEX_SIZE = 32;

interface GameScreenProps {
  gameState: GameState;
  onStateUpdate: (state: GameState) => void;
  playerId?: string;       // multiplayer: this player's ID
  token?: string;          // multiplayer: auth token
  isMultiplayer?: boolean;
  localPlayerIds?: string[];  // IDs of players controlled by this browser (host + locals)
  isHost?: boolean;
  onLeaveGame?: () => void;
  skipIntro?: boolean;     // skip intro overlay + draw animation (e.g. reconnection)
  removedFromLobby?: boolean;  // player was kicked from lobby while viewing game over
}

function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, y };
}

function pixelToAxial(px: number, py: number): { q: number; r: number } {
  const q = ((2 / 3) * px) / HEX_SIZE;
  const r = ((-1 / 3) * px + (Math.sqrt(3) / 3) * py) / HEX_SIZE;
  // Round to nearest hex
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(-q - r);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - (-q - r));
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

/** Hex distance in axial coordinates (module-level for use in effects before hooks). */
function hexDist(q1: number, r1: number, q2: number, r2: number): number {
  return Math.max(Math.abs(q1 - q2), Math.abs(r1 - r2), Math.abs((q1 + r1) - (q2 + r2)));
}

/** Find closest tile owned by a player to a target position (module-level). */
function findNearestOwnedTile(
  targetQ: number, targetR: number,
  tiles: Record<string, import('../types/game').HexTile>,
  playerId: string,
): { q: number; r: number } | null {
  let closest: { q: number; r: number } | null = null;
  let minDist = Infinity;
  for (const tile of Object.values(tiles)) {
    if (tile.owner !== playerId) continue;
    const dist = hexDist(tile.q, tile.r, targetQ, targetR);
    if (dist < minDist) {
      minDist = dist;
      closest = { q: tile.q, r: tile.r };
    }
  }
  return closest;
}

/** Check if a card requires the player to choose cards to trash or discard from hand. */
function getCardChoiceRequirement(card: Card): {
  effectType: 'self_trash' | 'trash_gain_buy_cost' | 'self_discard';
  minCards: number;
  maxCards: number;
  label: string;
} | null {
  if (!card.effects) return null;
  for (const effect of card.effects) {
    if (effect.type === 'self_trash' || effect.type === 'trash_gain_buy_cost') {
      const count = card.is_upgraded && effect.upgraded_value != null ? effect.upgraded_value : effect.value;
      // Trashing is always optional — player can decline (but forfeits the bonus)
      return {
        effectType: effect.type as 'self_trash' | 'trash_gain_buy_cost',
        minCards: 0,
        maxCards: count,
        label: 'Trash',
      };
    }
    if (effect.type === 'self_discard') {
      // If the card also draws cards, discard is deferred (draw first, then pick discard)
      if (card.draw_cards > 0) return null;
      const count = card.is_upgraded && effect.upgraded_value != null ? effect.upgraded_value : effect.value;
      // Discarding is required if there are cards in hand
      return {
        effectType: 'self_discard',
        minCards: count,
        maxCards: count,
        label: 'Discard',
      };
    }
    if (effect.type === 'cycle') {
      const discardCount = (effect.metadata?.discard as number) ?? 2;
      return {
        effectType: 'self_discard' as const,
        minCards: discardCount,
        maxCards: discardCount,
        label: 'Discard',
      };
    }
    if (effect.type === 'mandatory_self_trash') {
      const count = card.is_upgraded && effect.upgraded_value != null ? effect.upgraded_value : effect.value;
      return {
        effectType: 'self_trash' as const,
        minCards: count,
        maxCards: count,
        label: 'Trash',
      };
    }
  }
  return null;
}

const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** Count VP tiles owned by a player that are connected to their base through owned territory. */
function countConnectedVpTiles(
  tiles: Record<string, import('../types/game').HexTile>,
  playerId: string,
): number {
  // BFS from base tiles through owned territory
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_base && tile.owner === playerId) {
      visited.add(key);
      queue.push(key);
    }
  }
  let count = 0;
  while (queue.length > 0) {
    const key = queue.shift()!;
    const tile = tiles[key];
    if (tile.is_vp) count++;
    for (const [dq, dr] of HEX_DIRS) {
      const nk = `${tile.q + dq},${tile.r + dr}`;
      if (visited.has(nk)) continue;
      const neighbor = tiles[nk];
      if (!neighbor || neighbor.owner !== playerId) continue;
      visited.add(nk);
      queue.push(nk);
    }
  }
  return count;
}

/** BFS from each VP tile owned by a player to their base, through owned territory.
 *  Deduplicates: if a VP tile is already a waypoint on a longer path, its standalone path is omitted. */
function computePlayerVpPaths(
  tiles: Record<string, import('../types/game').HexTile>,
  playerId: string,
  color: number,
): VpPath[] {
  // Find base tile keys
  const baseKeys = new Set<string>();
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_base && tile.owner === playerId) baseKeys.add(key);
  }
  if (baseKeys.size === 0) return [];

  // Find VP tiles owned by this player
  const vpTiles: { q: number; r: number; key: string }[] = [];
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_vp && tile.owner === playerId) {
      vpTiles.push({ q: tile.q, r: tile.r, key });
    }
  }
  if (vpTiles.length === 0) return [];

  // Compute path for each VP tile
  const allPaths: { vpKey: string; points: [number, number][] }[] = [];
  for (const vp of vpTiles) {
    const queue: { key: string; q: number; r: number; path: [number, number][] }[] = [
      { key: vp.key, q: vp.q, r: vp.r, path: [[vp.q, vp.r]] },
    ];
    const visited = new Set<string>([vp.key]);
    let foundPath: [number, number][] | null = null;

    while (queue.length > 0 && !foundPath) {
      const current = queue.shift()!;
      for (const [dq, dr] of HEX_DIRS) {
        const nq = current.q + dq;
        const nr = current.r + dr;
        const nk = `${nq},${nr}`;
        if (visited.has(nk)) continue;
        const neighbor = tiles[nk];
        if (!neighbor || neighbor.owner !== playerId) continue;
        visited.add(nk);
        const newPath: [number, number][] = [...current.path, [nq, nr]];
        if (baseKeys.has(nk)) {
          foundPath = newPath;
          break;
        }
        queue.push({ key: nk, q: nq, r: nr, path: newPath });
      }
    }

    if (foundPath) {
      allPaths.push({ vpKey: vp.key, points: foundPath });
    }
  }

  // Sort longest first, then remove paths whose VP tile is already a waypoint on a longer path
  allPaths.sort((a, b) => b.points.length - a.points.length);
  const coveredVpKeys = new Set<string>();
  const vpKeySet = new Set(vpTiles.map(v => v.key));
  const result: VpPath[] = [];

  for (const p of allPaths) {
    if (coveredVpKeys.has(p.vpKey)) continue; // already covered by a longer path
    result.push({ points: p.points, color, alpha: 0, playerId });
    // Mark any VP tiles that appear as waypoints in this path (excluding the start)
    for (let i = 1; i < p.points.length; i++) {
      const wk = `${p.points[i][0]},${p.points[i][1]}`;
      if (vpKeySet.has(wk)) coveredVpKeys.add(wk);
    }
  }

  return result;
}

const PHASE_PILL_ORDER = ['upkeep', 'play', 'reveal', 'buy'] as const;
const PHASE_PILL_COLORS: Record<string, string> = { upkeep: '#555', play: '#2a6e3e', reveal: '#4a2a6e', buy: '#2a4a6e' };
const PHASE_PILL_LABELS: Record<string, string> = { upkeep: 'Upkeep', play: 'Play', reveal: 'Resolve', buy: 'Buy' };

function PhaseIndicatorPill({ phase }: { phase: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  return (
    <>
      <span
        onPointerEnter={(e) => setRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onPointerLeave={() => setRect(null)}
        style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 4,
          background: PHASE_PILL_COLORS[phase] ?? '#333',
          color: '#fff', fontWeight: 'bold', textTransform: 'uppercase', cursor: 'help',
        }}
      >
        {phase.replace(/_/g, ' ')}
      </span>
      {rect && createPortal(
        <div style={{
          position: 'fixed',
          left: rect.left,
          top: rect.bottom + 6,
          display: 'flex', alignItems: 'center', gap: 4,
          background: '#111122', border: '1px solid #555', borderRadius: 6,
          padding: '6px 10px', whiteSpace: 'nowrap', zIndex: 20000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)', pointerEvents: 'none',
        }}>
          {PHASE_PILL_ORDER.map((p, i) => {
            const isCurrent = phase === p;
            return (
              <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <span style={{ color: '#555', fontSize: 10 }}>→</span>}
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  background: isCurrent ? (PHASE_PILL_COLORS[p] ?? '#333') : 'transparent',
                  border: isCurrent ? 'none' : '1px solid #444',
                  color: isCurrent ? '#fff' : '#777',
                  fontWeight: isCurrent ? 'bold' : 'normal',
                  textTransform: 'uppercase',
                }}>
                  {PHASE_PILL_LABELS[p]}
                </span>
              </span>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

/** Round at which Debt cards start being distributed. */
const DEBT_START_ROUND = 5;

/** Parse the game log to find who received a Debt card this round. */
function findDebtRecipientFromLog(gameState: GameState): { id: string; name: string } | null {
  const log = gameState.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const match = log[i].match(/^(.+) receives a Debt card/);
    if (match) {
      const name = match[1];
      const entry = Object.entries(gameState.players).find(([, p]) => p.name === name);
      if (entry) return { id: entry[0], name };
      return null;
    }
    // Stop at round boundary to avoid matching previous rounds
    if (log[i].startsWith('=== Round')) break;
  }
  return null;
}

/** Scale factor for the flying debt card (relative to CARD_FULL_WIDTH × CARD_FULL_MIN_HEIGHT). */
const DEBT_FLY_SCALE = 0.45;
const DEBT_FLY_CARD_W = CARD_FULL_WIDTH * DEBT_FLY_SCALE;
const DEBT_FLY_CARD_H = CARD_FULL_MIN_HEIGHT * DEBT_FLY_SCALE;

/** A representative Debt card object for rendering in CardFull. */
const DEBT_CARD_OBJ: Card = {
  id: 'debt_fly',
  name: 'Debt',
  archetype: 'neutral',
  card_type: 'engine',
  power: 0,
  resource_gain: -3,
  action_return: 0,
  timing: 'immediate',
  buy_cost: null,
  is_upgraded: false,
  trash_on_use: true,
  trash_immune: true,
  stackable: false,
  forced_discard: 0,
  draw_cards: 0,
  defense_bonus: 0,
  adjacency_required: false,
  claim_range: 0,
  unoccupied_only: false,
  multi_target_count: 0,
  defense_target_count: 0,
  flood: false,
  target_own_tile: false,
  passive_vp: 0,
  description: `Pay 3 resources to trash this card. One is given to the VP leader at the beginning of each round, starting round ${DEBT_START_ROUND}.`,
  starter: false,
  effects: [],
};

/** Animated Debt card that flies from screen center to a target element. */
function DebtCardFlyAnimation({
  targetRect,
  onComplete,
  speed = 1,
}: {
  targetRect: DOMRect;
  onComplete: () => void;
  speed?: number;
}) {
  const [stage, setStage] = useState<'mount' | 'grow' | 'fly'>('mount');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Random jitter values, stable for the lifetime of this animation instance
  const jitterRef = useRef({
    startRot: (Math.random() - 0.5) * 6,    // ±3° initial wobble
    growRot: (Math.random() - 0.5) * 10,     // ±5° during grow
    flyRot: (Math.random() - 0.5) * 30 + (Math.random() > 0.5 ? 15 : -15), // 15-30° spin during fly
  });

  const startX = window.innerWidth / 2 - DEBT_FLY_CARD_W / 2;
  const startY = window.innerHeight / 2 - DEBT_FLY_CARD_H - 60;

  const targetX = targetRect.left + targetRect.width / 2 - DEBT_FLY_CARD_W / 2;
  const targetY = targetRect.top + targetRect.height / 2 - DEBT_FLY_CARD_H / 2;

  const growMs = Math.round(350 * speed);
  const flyMs = Math.round(660 * speed);

  // mount → grow (double-rAF to ensure initial paint)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setStage('grow'));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // grow → fly
  useEffect(() => {
    if (stage !== 'grow') return;
    const t = setTimeout(() => setStage('fly'), growMs);
    return () => clearTimeout(t);
  }, [stage, growMs]);

  // fly → complete
  useEffect(() => {
    if (stage !== 'fly') return;
    const t = setTimeout(() => onCompleteRef.current(), flyMs);
    return () => clearTimeout(t);
  }, [stage, flyMs]);

  const j = jitterRef.current;
  let left: number, top: number, scale: number, rotate: number, opacity: number, transition: string;
  switch (stage) {
    case 'mount':
      left = startX; top = startY;
      scale = 1; rotate = j.startRot; opacity = 1;
      transition = 'none';
      break;
    case 'grow':
      left = startX; top = startY;
      scale = 1.15; rotate = j.growRot; opacity = 1;
      transition = `all ${growMs}ms ease-out`;
      break;
    case 'fly': {
      const fadeDelay = Math.round(flyMs * 0.95);
      const fadeDur = flyMs - fadeDelay;
      left = targetX; top = targetY;
      scale = 0.55; rotate = j.flyRot; opacity = 0;
      transition = `left ${flyMs}ms ease-in, top ${flyMs}ms ease-in, transform ${flyMs}ms ease-in, opacity ${fadeDur}ms ease-in ${fadeDelay}ms`;
      break;
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed',
      left, top,
      width: DEBT_FLY_CARD_W,
      height: DEBT_FLY_CARD_H,
      transform: `scale(${scale}) rotate(${rotate}deg)`,
      opacity,
      transition,
      zIndex: 31000,
      pointerEvents: 'none',
      filter: 'drop-shadow(0 4px 20px rgba(204, 102, 34, 0.5))',
    }}>
      <div style={{
        transform: `scale(${DEBT_FLY_SCALE})`,
        transformOrigin: 'top left',
      }}>
        <CardFull card={DEBT_CARD_OBJ} />
      </div>
    </div>,
    document.body
  );
}

export default function GameScreen({ gameState, onStateUpdate, playerId: mpPlayerId, token: mpToken, isMultiplayer, localPlayerIds: localPlayerIdsProp, isHost: mpIsHost, onLeaveGame, skipIntro: skipIntroProp, removedFromLobby }: GameScreenProps) {
  // Sync player colors from game state into the shared PLAYER_COLORS map
  syncPlayerColors(gameState.players);
  const animated = useAnimated();
  const animationMode = useAnimationMode();
  const animationOff = useAnimationOff();
  const animSpeed = useAnimationSpeed();
  const sound = useSound();
  // Local player IDs this browser controls (for hotseat cycling)
  const localPlayerIds = localPlayerIdsProp ?? [];
  const shouldCycle = localPlayerIds.length > 1;
  // Helper: find the first human player index
  const firstHumanIndex = gameState.player_order.findIndex(
    pid => !gameState.players[pid]?.is_cpu,
  );
  // In multiplayer, active player is always the local player
  const mpPlayerIndex = mpPlayerId ? gameState.player_order.indexOf(mpPlayerId) : -1;
  // The "home" player index: in multiplayer it's always the local player; in hotseat it's the first human
  const homePlayerIndex = isMultiplayer && mpPlayerIndex >= 0 ? mpPlayerIndex : Math.max(0, firstHumanIndex);
  const [activePlayerIndex, setActivePlayerIndex] = useState(homePlayerIndex);
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [hoveredCardIndex, setHoveredCardIndex] = useState<number | null>(null);
  const [draggingCardIndex, setDraggingCardIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUpgradePreview, setShowUpgradePreview] = useState(false);
  const [showFullLog, setShowFullLog] = useState(false);
  const [showDeckViewer, setShowDeckViewer] = useState(false);
  const [showShopOverlay, setShowShopOverlay] = useState(false);
  const [showCardBrowser, setShowCardBrowser] = useState(false);
  const [cardPackDefs, setCardPackDefs] = useState<{ id: string; name: string; neutral_card_ids: string[] | null; archetype_card_ids: Record<string, string[]> | null }[]>([]);
  const [discardingAll, setDiscardingAll] = useState(false);
  const [lastPlayedTarget, setLastPlayedTarget] = useState<PlayTarget | null>(null);
  /** Temporarily stores drag release position/velocity so executePlayCard can include it in lastPlayedTarget */
  const dragReleaseRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [trashedCardIds, setTrashedCardIds] = useState<Set<string>>(new Set());
  // Test mode state
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [testShuffleAnim, setTestShuffleAnim] = useState(false);
  const [testCardId, setTestCardId] = useState('');
  const [testVp, setTestVp] = useState('');
  const [testResources, setTestResources] = useState('');
  // Surge multi-target mode
  const [surgeTargets, setSurgeTargets] = useState<[number, number][]>([]);
  const [surgeCardIndex, setSurgeCardIndex] = useState<number | null>(null);
  const [surgePrimaryTarget, setSurgePrimaryTarget] = useState<[number, number] | null>(null);
  // Trash/discard selection mode (for cards like Thin the Herd, Consolidate, Reduce)
  const [trashMode, setTrashMode] = useState<{
    cardIndex: number;
    targetQ?: number;
    targetR?: number;
    targetPlayerId?: string;
    extraTargets?: [number, number][];
    effectType: 'self_trash' | 'trash_gain_buy_cost' | 'self_discard';
    minCards: number;
    maxCards: number;
    label: string;  // "Trash" or "Discard"
    pendingDiscard?: boolean;  // true when resolving a deferred discard (not during card play)
  } | null>(null);
  const [trashSelectedIndices, setTrashSelectedIndices] = useState<Set<number>>(new Set());
  // Intro overlay state — skip on reconnection or when animations are off
  const skipIntro = skipIntroProp || animationOff;
  const [showIntro, setShowIntro] = useState(!skipIntro);
  // Intro sequence after overlay: 'overlay' → 'hud_fadein' → 'grid_build' → 'shuffle' → 'draw' → 'done'
  const [introSequence, setIntroSequence] = useState<'overlay' | 'hud_fadein' | 'grid_build' | 'shuffle' | 'draw' | 'done'>(skipIntro ? 'done' : 'overlay');
  // HUD visibility (fades in during intro)
  const [hudVisible, setHudVisible] = useState(skipIntro ? true : false);
  // Grid build-from-center progress (0→1 during intro, undefined after)
  const [gridBuildProgress, setGridBuildProgress] = useState<number | undefined>(skipIntro ? undefined : 0);
  // Banner label override (for "Begin!" on first turn)
  const [bannerLabelOverride, setBannerLabelOverride] = useState<string | null>(null);
  // Game over state
  const [showGameOver, setShowGameOver] = useState(false);
  // Settings gear dropdown state
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  // Player panel expand-on-hover
  const [playerPanelExpanded, setPlayerPanelExpanded] = useState(false);
  // In-play card list hover preview
  const [inPlayHoverIndex, setInPlayHoverIndex] = useState<number | null>(null);
  const inPlayContainerRef = useRef<HTMLDivElement>(null);
  // Purchase pill hover preview
  const [purchaseHover, setPurchaseHover] = useState<{ card: import('../types/game').Card; rect: DOMRect } | null>(null);
  const [purchaseHoverVisible, setPurchaseHoverVisible] = useState(false);
  // Phase banner state
  const [phaseBanner, setPhaseBanner] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState(0);
  const [interactionBlocked, setInteractionBlocked] = useState(false);
  const [submitButtonVisible, setSubmitButtonVisible] = useState(false);
  const [buyButtonVisible, setBuyButtonVisible] = useState(false);
  // Debt card fly animation state
  const [bannerHoldUntilRelease, setBannerHoldUntilRelease] = useState(false);
  const [debtFlyTarget, setDebtFlyTarget] = useState<DOMRect | null>(null);
  const [forcePlayerPanelExpanded, setForcePlayerPanelExpanded] = useState(false);
  const debtFlyPendingRef = useRef<string | null>(null);
  // Test mode: override debt recipient for animation testing
  const testDebtRecipientRef = useRef<{ id: string; name: string } | null>(null);
  const testDebtBannerRef = useRef(false); // true when banner is from test "Give Debt" button
  const submitPlayRef = useRef<HoldToSubmitHandle>(null);
  const endTurnRef = useRef<HoldToSubmitHandle>(null);
  // Responsive: stack top-right buttons vertically when screen is narrow
  const [narrowTop, setNarrowTop] = useState(() => window.innerWidth < 700);
  useEffect(() => {
    const check = () => setNarrowTop(window.innerWidth < 700);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  // Fetch card pack definitions (once) for CardBrowser filtering
  useEffect(() => {
    fetch('/api/card-packs')
      .then(r => r.json())
      .then((d: { packs: typeof cardPackDefs }) => setCardPackDefs(d.packs))
      .catch(() => {});
  }, []);
  // Detect mobile browser — disable double-tap shortcuts
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  // Start empty so the first phase always triggers a banner (upkeep → play chain)
  const prevPhaseRef = useRef<string>('');
  // Track previous tiles for resolve animation (needed for multiplayer WebSocket updates)
  const prevTilesRef = useRef(gameState.grid.tiles);
  // Review phase state (between resolve animations and buy phase)
  const handleDoneReviewingRef = useRef<(() => void) | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const revealedActionsRef = useRef<Record<string, import('../types/game').PlannedAction[]> | null>(null);
  const [reviewHoveredTile, setReviewHoveredTile] = useState<string | null>(null);
  const [reviewTilePopupPos, setReviewTilePopupPos] = useState<{ x: number; y: number } | null>(null);
  const [reviewHoveredPlayer, setReviewHoveredPlayer] = useState<string | null>(null);
  const [reviewFullCards, setReviewFullCards] = useState<{ playerId: string; playerName: string; card: Card }[] | null>(null);
  const playerRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Resolve animation state
  const [resolving, setResolving] = useState(false);
  const [resolutionSteps, setResolutionSteps] = useState<ResolutionStep[]>([]);
  const [resolveDisplayState, setResolveDisplayState] = useState<GameState | null>(null);
  // (resolveFinishedStateRef removed — server holds state at REVEAL, client calls advanceResolve when done)
  const [gridRect, setGridRect] = useState<DOMRect | null>(null);
  const [gridTransformSnapshot, setGridTransformSnapshot] = useState<GridTransform | null>(null);
  const pendingStateRef = useRef<GameState | null>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const gridTransformRef = useRef<GridTransform | null>(null);
  const tileClickedRef = useRef(false);
  // Chevron reveal state (resolve phase pre-animation)
  const [chevronRevealPhase, setChevronRevealPhase] = useState(false);
  const [chevronAlpha, setChevronAlpha] = useState(0);
  // Chevron fade-out during resolution (per-step)
  const [resolvedUpToStep, setResolvedUpToStep] = useState(-1);
  const [currentStepFade, setCurrentStepFade] = useState(1);
  // Cache resolve chevron sources so they don't shift as tiles change owners
  const resolveChevronCacheRef = useRef<{ targetQ: number; targetR: number; sourceQ: number; sourceR: number; color: number; stepIndex: number }[]>([]);
  const [bannerSubtitle, setBannerSubtitle] = useState<string | null>(null);
  // VP path animation state
  const [vpPaths, setVpPaths] = useState<VpPath[]>([]);
  const [vpPathPhase, setVpPathPhase] = useState<'off' | 'fading_in' | 'visible' | 'fading_out'>('off');
  const vpPathFadeStartRef = useRef(0); // timestamp when current fade started
  const vpPathFadeStartAlphaRef = useRef(0); // alpha at start of fade-out
  // Client-side resolve log entries (VP path disruptions, etc.)
  const [resolveLogEntries, setResolveLogEntries] = useState<string[]>([]);
  // Player effect popups (shown over base tiles after resolve steps)
  const [activePlayerEffects, setActivePlayerEffects] = useState<PlayerEffect[]>([]);

  // Auto-dismiss error toast after 4 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const activePlayerId = gameState.player_order[activePlayerIndex];
  const activePlayer = gameState.players[activePlayerId];
  const phase = gameState.current_phase;

  // "Drag a card" hint — shown once per round if no card played after 5s in play phase
  const [showDragHint, setShowDragHint] = useState(false);
  const dragHintShownRoundRef = useRef<number>(-1);

  useEffect(() => {
    if (phase !== 'play' || !activePlayer || activePlayer.has_submitted_play || resolving || phaseBanner || showIntro || introSequence !== 'done') {
      setShowDragHint(false);
      return;
    }
    if (dragHintShownRoundRef.current === gameState.current_round) return;
    if (activePlayer.planned_actions.length > 0) {
      setShowDragHint(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowDragHint(true);
      dragHintShownRoundRef.current = gameState.current_round;
    }, 5000);
    return () => clearTimeout(timer);
  }, [phase, activePlayer, resolving, phaseBanner, showIntro, introSequence, gameState.current_round]);

  useEffect(() => {
    if (activePlayer && activePlayer.planned_actions.length > 0) {
      setShowDragHint(false);
    }
  }, [activePlayer?.planned_actions.length]);

  // Build subtitle context for dynamic card value resolution
  const subtitleContext: CardSubtitleContext = useMemo(() => {
    // Count Debt cards in hand + draw pile + discard (not trash)
    const debtCount = [...activePlayer.hand, ...activePlayer.deck_cards, ...activePlayer.discard]
      .filter(c => c.name === 'Debt').length;
    return {
      claimsWonLastRound: activePlayer.claims_won_last_round,
      tileCount: activePlayer.tile_count,
      handSize: activePlayer.hand.length,
      trashCount: activePlayer.trash?.length ?? 0,
      totalDeckCards: activePlayer.deck_size + activePlayer.hand.length + activePlayer.discard_count,
      resourcesHeld: activePlayer.resources,
      tilesLostLastRound: activePlayer.tiles_lost_last_round,
      vpHexCount: gameState.grid ? countConnectedVpTiles(gameState.grid.tiles, activePlayerId) : 0,
      debtCount,
    };
  }, [activePlayer.claims_won_last_round, activePlayer.tiles_lost_last_round, activePlayer.tile_count, activePlayer.hand, activePlayer.trash, activePlayer.deck_size, activePlayer.deck_cards, activePlayer.discard, activePlayer.discard_count, activePlayer.resources, gameState.grid?.tiles, activePlayerId]);

  // Context for played/revealed cards: power is already frozen on card.power, skip re-resolution
  const frozenSubtitleContext: CardSubtitleContext = useMemo(() => ({
    ...subtitleContext,
    powerFrozen: true,
  }), [subtitleContext]);

  // Restore discard mode on reconnect/refresh if player has a pending discard
  useEffect(() => {
    if (!activePlayer || activePlayer.pending_discard <= 0) return;
    if (trashMode) return;
    const required = Math.min(activePlayer.pending_discard, activePlayer.hand.length);
    if (required <= 0) return;
    setTrashMode({
      cardIndex: -1,
      effectType: 'self_discard',
      minCards: required,
      maxCards: required,
      label: 'Discard',
      pendingDiscard: true,
    });
    setTrashSelectedIndices(new Set());
    setSelectedCardIndex(null);
  }, [activePlayer?.pending_discard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Card lookup maps for purchase hover previews
  const { cardById, cardByName } = useMemo(() => {
    const byId = new Map<string, import('../types/game').Card>();
    const byName = new Map<string, import('../types/game').Card>();
    // Neutral market cards
    for (const stack of gameState.neutral_market) {
      byId.set(stack.card.id, stack.card);
      byName.set(stack.card.name, stack.card);
    }
    // All players' visible cards (hand, discard, deck, archetype market)
    for (const p of Object.values(gameState.players)) {
      for (const c of p.hand) { byId.set(c.id, c); byName.set(c.name, c); }
      for (const c of p.discard) { byId.set(c.id, c); byName.set(c.name, c); }
      for (const c of p.deck_cards) { byId.set(c.id, c); byName.set(c.name, c); }
      for (const c of p.archetype_market) { byId.set(c.id, c); byName.set(c.name, c); }
      for (const c of p.trash ?? []) { byId.set(c.id, c); byName.set(c.name, c); }
    }
    return { cardById: byId, cardByName: byName };
  }, [gameState.neutral_market, gameState.players]);

  // Enrich purchase records with card_type for pill border colors
  const enrichPurchases = useCallback((purchases?: Array<{ card_id: string; card_name: string; source: string; cost: number }>) => {
    if (!purchases) return undefined;
    return purchases.map(p => {
      const card = cardById.get(p.card_id) ?? cardByName.get(p.card_name);
      return { ...p, card_type: card?.card_type };
    });
  }, [cardById, cardByName]);

  const handlePurchaseHover = useCallback((e: React.MouseEvent, cardId: string, cardName?: string) => {
    const card = cardById.get(cardId) ?? (cardName ? cardByName.get(cardName) : undefined);
    if (!card) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPurchaseHoverVisible(false);
    setPurchaseHover({ card, rect });
  }, [cardById, cardByName]);

  const handlePurchaseLeave = useCallback(() => {
    setPurchaseHover(null);
    setPurchaseHoverVisible(false);
  }, []);

  // Delayed fade-in for purchase hover preview (matches shop behavior)
  useEffect(() => {
    if (!purchaseHover) return;
    const timer = setTimeout(() => setPurchaseHoverVisible(true), 150);
    return () => clearTimeout(timer);
  }, [purchaseHover]);


  // Close settings dropdown on outside click
  useEffect(() => {
    if (!settingsExpanded) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsExpanded(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsExpanded]);

  // Show game over overlay when winner is set
  useEffect(() => {
    if (gameState.winner && !showGameOver) {
      // Small delay so the final state update renders first
      const t = setTimeout(() => setShowGameOver(true), 500);
      return () => clearTimeout(t);
    }
  }, [gameState.winner, showGameOver]);

  // Replay restart: when game ID changes (new game), reset overlays and show intro
  const prevGameIdRef = useRef(gameState.id);
  useEffect(() => {
    if (gameState.id !== prevGameIdRef.current) {
      prevGameIdRef.current = gameState.id;
      setShowGameOver(false);
      setShowIntro(true);
      setIntroSequence('overlay');
    }
  }, [gameState.id]);

  // Capture revealed_actions when game state includes them (REVEAL phase)
  useEffect(() => {
    if (gameState.revealed_actions) {
      revealedActionsRef.current = gameState.revealed_actions;
    }
  }, [gameState.revealed_actions]);

  // The state to feed to HexGrid during resolve animations (shows incremental tile changes)
  const displayState = resolveDisplayState ?? gameState;

  // Phase change detection → show phase banner or trigger resolve animation
  // useLayoutEffect so resolveDisplayState is set before browser paint (avoids flash of post-resolve tiles)
  useLayoutEffect(() => {
    const prev = prevPhaseRef.current;
    const oldTiles = prevTilesRef.current;
    if (prev === phase) {
      // Phase unchanged — still update tiles snapshot for future diffs
      prevTilesRef.current = gameState.grid.tiles;
      return;
    }
    // Don't show banner during intro overlay or intro animation sequence
    if (showIntro || introSequence !== 'done') return;
    // Don't show banner if currently resolving (resolve has its own banner flow)
    if (resolving) return;
    // Don't trigger if a banner is already active (e.g. reveal→buy chain).
    // IMPORTANT: don't update prevPhaseRef or prevTilesRef here — we need
    // to re-detect this phase change once the current banner completes.
    if (phaseBanner) return;
    // Commit: we're handling this phase transition now
    prevPhaseRef.current = phase;
    prevTilesRef.current = gameState.grid.tiles;

    // play → reveal: set up resolve animation (works for both hotseat and multiplayer)
    if (prev === 'play' && phase === 'reveal') {
      const steps = gameState.resolution_steps;
      const hasSteps = steps && steps.length > 0;

      if (hasSteps && !animationOff) {
        setSelectedCardIndex(null);
        // Build pre-resolve display state with old tile ownership for animation
        const preResolveState: GameState = {
          ...gameState,
          grid: {
            ...gameState.grid,
            tiles: { ...oldTiles },
          },
        };
        setResolveDisplayState(preResolveState);
        setResolutionSteps(steps);
        setGridTransformSnapshot(gridTransformRef.current);
        setResolving(true);
        setInteractionBlocked(true);
        setBannerSubtitle('Battle & Expand');
        setPhaseBanner('reveal');
        // Pre-compute chevron sources using pre-resolve tile state
        const cachedChevrons: typeof resolveChevronCacheRef.current = [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          for (const claimant of step.claimants) {
            const color = PLAYER_COLORS[claimant.player_id] ?? 0xffffff;
            const source = findNearestOwnedTile(step.q, step.r, oldTiles, claimant.player_id);
            if (!source) continue;
            cachedChevrons.push({
              targetQ: step.q, targetR: step.r,
              sourceQ: source.q, sourceR: source.r,
              color, stepIndex: i,
            });
          }
        }
        resolveChevronCacheRef.current = cachedChevrons;
        setChevronAlpha(0);
        setChevronRevealPhase(true);
        // Initialize VP paths for all players
        setResolveLogEntries([]);
        const allVpPaths: VpPath[] = [];
        for (const pid of gameState.player_order) {
          const color = PLAYER_COLORS[pid] ?? 0xffffff;
          allVpPaths.push(...computePlayerVpPaths(oldTiles, pid, color).map(p => ({ ...p, noPulse: true })));
        }
        if (allVpPaths.length > 0) {
          setVpPaths(allVpPaths);
          setVpPathPhase('fading_in');
        }
      } else {
        // No claim steps — show reveal banner briefly, then transition to buy
        setInteractionBlocked(true);
        setBannerSubtitle('Battle & Expand');
        setPhaseBanner('reveal');
      }
      return;
    }

    // Show banners for main phases (all animation modes including off)
    const bannerPhases = ['upkeep', 'play', 'buy'];
    if (bannerPhases.includes(phase)) {
      // Set subtitle per phase
      if (phase === 'upkeep') {
        const maxRounds = gameState.max_rounds ?? 20;
        setBannerLabelOverride(`Round ${gameState.current_round} of ${maxRounds}`);
        if (gameState.current_round < DEBT_START_ROUND) {
          const roundsUntil = DEBT_START_ROUND - gameState.current_round;
          setBannerSubtitle(`${roundsUntil} round${roundsUntil > 1 ? 's' : ''} until Debt is given to leader`);
          setBannerHoldUntilRelease(false);
        } else {
          const recipient = findDebtRecipientFromLog(gameState);
          setBannerSubtitle(recipient ? `Debt given to ${recipient.name}` : 'Debt given to leader');
          // Hold banner for debt card fly animation (unless animations off)
          setBannerHoldUntilRelease(!animationOff);
        }
      } else if (phase === 'play') {
        setBannerSubtitle('Choose Wisely');
      } else if (phase === 'buy') {
        setBannerSubtitle('Grow Your Deck');
      } else {
        setBannerSubtitle(null);
      }
      setPhaseBanner(phase);
      setInteractionBlocked(true);
    }
  }, [phase, animationOff, resolving, phaseBanner, gameState, showIntro, introSequence, activePlayerId, homePlayerIndex, onStateUpdate]);

  // Submit button fade-in: hide when phase changes, fade in after banner clears
  useEffect(() => {
    if (phase === 'play' && !phaseBanner && !resolving && !showIntro) {
      // Banner just cleared — trigger fade-in after a brief delay
      const timer = setTimeout(() => setSubmitButtonVisible(true), 50);
      return () => clearTimeout(timer);
    }
    setSubmitButtonVisible(false);
  }, [phase, phaseBanner, resolving, showIntro]);

  // Buy button fade-in: hide when phase changes, fade in after banner clears
  useEffect(() => {
    if (phase === 'buy' && !phaseBanner && !resolving) {
      const timer = setTimeout(() => setBuyButtonVisible(true), 50);
      return () => clearTimeout(timer);
    }
    setBuyButtonVisible(false);
  }, [phase, phaseBanner, resolving]);

  // Chevron reveal animation: fade in all claim chevrons before resolve overlay
  useEffect(() => {
    if (!chevronRevealPhase) return;
    const duration = Math.round(1500 * animSpeed);

    if (duration === 0) {
      setChevronAlpha(1);
      setChevronRevealPhase(false);
      return;
    }

    const startTime = performance.now();
    const intervalId = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out for smooth fade-in
      const eased = 1 - Math.pow(1 - progress, 2);
      setChevronAlpha(eased);

      if (progress >= 1) {
        clearInterval(intervalId);
        // Brief pause at full visibility, then proceed to resolve animation
        setTimeout(() => setChevronRevealPhase(false), 300);
      }
    }, 50);

    return () => clearInterval(intervalId);
  }, [chevronRevealPhase, animationMode]);

  // Chevron fade-out during resolution step animation
  useEffect(() => {
    if (resolvedUpToStep < 0) return;
    const duration = Math.round(1000 * animSpeed);

    if (duration === 0) {
      setCurrentStepFade(0);
      return;
    }

    const startTime = performance.now();
    setCurrentStepFade(1);
    const intervalId = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      setCurrentStepFade(1 - progress);
      if (progress >= 1) clearInterval(intervalId);
    }, 50);

    return () => clearInterval(intervalId);
  }, [resolvedUpToStep, animationMode]);

  // VP path fade-in animation
  useEffect(() => {
    if (vpPathPhase !== 'fading_in') return;
    const duration = Math.round(800 * animSpeed);
    if (duration === 0) {
      setVpPaths(prev => prev.map(p => ({ ...p, alpha: 1 })));
      setVpPathPhase('visible');
      return;
    }
    vpPathFadeStartRef.current = performance.now();
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - vpPathFadeStartRef.current) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 2); // ease-out
      setVpPaths(prev => prev.map(p => ({ ...p, alpha: eased })));
      if (progress >= 1) {
        clearInterval(id);
        setVpPathPhase('visible');
      }
    }, 50);
    return () => clearInterval(id);
  }, [vpPathPhase, animationMode]);

  // VP path fade-out animation
  useEffect(() => {
    if (vpPathPhase !== 'fading_out') return;
    const duration = Math.round(500 * animSpeed);
    if (duration === 0) {
      setVpPaths([]);
      setVpPathPhase('off');
      return;
    }
    const startAlpha = vpPathFadeStartAlphaRef.current;
    vpPathFadeStartRef.current = performance.now();
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - vpPathFadeStartRef.current) / duration, 1);
      setVpPaths(prev => {
        if (progress >= 1) return [];
        return prev.map(p => ({ ...p, alpha: startAlpha * (1 - progress) }));
      });
      if (progress >= 1) {
        clearInterval(id);
        setVpPathPhase('off');
      }
    }, 50);
    return () => clearInterval(id);
  }, [vpPathPhase, animationMode]);

  // VP path breaking animation — quickly fade out individual broken paths
  const breakingCount = vpPaths.filter(p => p.breaking && p.alpha > 0).length;
  useEffect(() => {
    if (breakingCount === 0) return;
    const duration = 300;
    const startTime = performance.now();
    const startAlphas = vpPaths.map(p => p.alpha);
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - startTime) / duration, 1);
      setVpPaths(prev => prev.map((p, i) => {
        if (!p.breaking) return p;
        return { ...p, alpha: Math.max(0, startAlphas[i] * (1 - progress)) };
      }));
      if (progress >= 1) clearInterval(id);
    }, 30);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakingCount]);

  // Show VP paths for ALL players during all phases (except while resolve animation is active)
  useEffect(() => {
    if (resolving) return; // resolve animation manages its own VP paths
    const tiles = gameState.grid?.tiles;
    if (!tiles) return;
    const allPaths: VpPath[] = [];
    for (const pid of gameState.player_order) {
      const color = PLAYER_COLORS[pid] ?? 0xffffff;
      const playerPaths = computePlayerVpPaths(tiles, pid, color);
      allPaths.push(...playerPaths);
    }
    if (allPaths.length > 0) {
      setVpPaths(allPaths);
      setVpPathPhase('fading_in');
    } else {
      setVpPaths([]);
      setVpPathPhase('off');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameState.grid?.tiles, resolving]);

  // Compute which VP tiles are connected to their owner's base (for star rendering)
  const connectedVpTiles = useMemo(() => {
    const tiles = displayState.grid?.tiles;
    if (!tiles) return new Set<string>();

    const connected = new Set<string>();
    const playerIds = gameState.player_order;

    for (const pid of playerIds) {
      // Find base tiles for this player
      const baseKeys: string[] = [];
      for (const [key, tile] of Object.entries(tiles)) {
        if (tile.is_base && tile.owner === pid) baseKeys.push(key);
      }
      if (baseKeys.length === 0) continue;

      // BFS from base tiles through owned territory
      const reachable = new Set<string>(baseKeys);
      const queue = [...baseKeys];

      while (queue.length > 0) {
        const key = queue.shift()!;
        const tile = tiles[key];
        if (!tile) continue;
        for (const [dq, dr] of HEX_DIRS) {
          const nk = `${tile.q + dq},${tile.r + dr}`;
          if (reachable.has(nk)) continue;
          const neighbor = tiles[nk];
          if (!neighbor || neighbor.owner !== pid) continue;
          reachable.add(nk);
          queue.push(nk);
        }
      }

      // Mark reachable VP tiles as connected
      for (const [key, tile] of Object.entries(tiles)) {
        if (tile.is_vp && tile.owner === pid && reachable.has(key)) {
          connected.add(key);
        }
      }
    }

    return connected;
  }, [displayState.grid?.tiles, gameState.player_order]);

  // Ref tracking latest resolve display tiles (for VP path recomputation in applyResolveStep)
  const resolveDisplayTilesRef = useRef<Record<string, import('../types/game').HexTile> | null>(null);
  useEffect(() => {
    resolveDisplayTilesRef.current = resolveDisplayState?.grid?.tiles ?? null;
  }, [resolveDisplayState]);

  // Keep grid rect up to date for resolve overlay positioning
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const update = () => setGridRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-open shop when entering buy phase (only for reconnection or animations-off).
  // During normal flow, shop opening is handled by handleBannerComplete or the buyer-change effect.
  // Use a ref to skip the first render after a phase change (the banner effect needs time to set up).
  const buyPhaseStableRef = useRef(phase === 'buy');
  useEffect(() => {
    if (phase === 'buy') {
      if (buyPhaseStableRef.current && !resolving && !phaseBanner && !interactionBlocked && activePlayerEffects.length === 0
          && activePlayerId === gameState.current_buyer_id) {
        setShowShopOverlay(true);
      }
      // Mark as stable on next tick so subsequent renders can open the shop
      const timer = setTimeout(() => { buyPhaseStableRef.current = true; }, 0);
      return () => clearTimeout(timer);
    } else {
      buyPhaseStableRef.current = false;
    }
  }, [phase, resolving, phaseBanner, interactionBlocked, activePlayerEffects, activePlayerId, gameState.current_buyer_id]);

  // Auto-enter review mode when reconnecting into REVEAL phase (resolve animations already happened)
  const revealStableRef = useRef(phase === 'reveal');
  useEffect(() => {
    if (phase === 'reveal') {
      if (revealStableRef.current && !resolving && !reviewing && !phaseBanner && !showIntro) {
        setReviewing(true);
        setInteractionBlocked(false);
      }
      const timer = setTimeout(() => { revealStableRef.current = true; }, 0);
      return () => clearTimeout(timer);
    } else {
      revealStableRef.current = false;
      // Clear review mode when leaving reveal phase (e.g. WebSocket pushed buy phase)
      if (reviewing) setReviewing(false);
    }
  }, [phase, resolving, reviewing, phaseBanner, showIntro]);

  // Compute which tiles are adjacent to the active player's territory
  const adjacentTiles = useMemo(() => {
    const adj = new Set<string>();
    if (!activePlayer || !gameState.grid) return adj;

    const tiles = gameState.grid.tiles;
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

    for (const [, tile] of Object.entries(tiles)) {
      if (tile.owner === activePlayerId) {
        for (const [dq, dr] of directions) {
          const nk = `${tile.q + dq},${tile.r + dr}`;
          const neighbor = tiles[nk];
          if (neighbor && !neighbor.is_blocked && neighbor.owner !== activePlayerId) {
            adj.add(nk);
          }
        }
      }
    }
    return adj;
  }, [gameState.grid, activePlayerId, activePlayer]);

  /** Actually send the play-card API call (after any trash/discard selection is complete). */
  const executePlayCard = useCallback(async (
    cardIndex: number,
    q?: number, r?: number,
    extraTargets?: [number, number][],
    targetPlayerId?: string,
    trashIndices?: number[],
    discardIndices?: number[],
  ) => {
    if (phase !== 'play' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;
    setTrashedCardIds(new Set());

    // Track which cards are being trashed for tear animation
    const trashing = new Set<string>();
    if (card.trash_on_use) trashing.add(card.id);
    if (trashIndices) {
      // trashIndices are post-removal indices (after played card popped) — map back to hand
      for (const ti of trashIndices) {
        const adjustedIdx = ti >= cardIndex ? ti + 1 : ti;
        const tc = activePlayer.hand[adjustedIdx];
        if (tc) trashing.add(tc.id);
      }
    }
    if (trashing.size > 0) setTrashedCardIds(trashing);

    // Compute screen position for card animation
    const drag = dragReleaseRef.current;
    dragReleaseRef.current = null;
    if (q != null && r != null) {
      const transform = gridTransformRef.current;
      const gRect = gridContainerRef.current?.getBoundingClientRect();
      if (transform && gRect) {
        const local = axialToPixel(q, r);
        const screenX = local.x * transform.scale + transform.offsetX + gRect.left;
        const screenY = local.y * transform.scale + transform.offsetY + gRect.top;
        setLastPlayedTarget({
          cardId: card.id, screenX, screenY,
          ...(drag ? { dragX: drag.x, dragY: drag.y, dragVelocityX: drag.vx, dragVelocityY: drag.vy } : {}),
        });
      }
    } else {
      setLastPlayedTarget({
        cardId: card.id, screenX: null, screenY: null,
        ...(drag ? { dragX: drag.x, dragY: drag.y, dragVelocityX: drag.vx, dragVelocityY: drag.vy } : {}),
      });
    }

    try {
      setError(null);
      const result = await api.playCard(
        gameState.id, activePlayerId, cardIndex,
        q, r, targetPlayerId, extraTargets,
        trashIndices, discardIndices,
      );
      onStateUpdate(result.state);
      // Check for deferred discard (e.g. Regroup: draw first, then pick discard)
      const updatedPlayer = result.state.players[activePlayerId];
      if (updatedPlayer && updatedPlayer.pending_discard > 0) {
        setTrashMode({
          cardIndex: -1, // card already played — no card to exclude
          effectType: 'self_discard',
          minCards: Math.min(updatedPlayer.pending_discard, updatedPlayer.hand.length),
          maxCards: Math.min(updatedPlayer.pending_discard, updatedPlayer.hand.length),
          label: 'Discard',
          pendingDiscard: true,
        });
        setTrashSelectedIndices(new Set());
        setSelectedCardIndex(null);
      } else {
        // Auto-select the next card in hand (card to the right, or left if last)
        const newHand = updatedPlayer?.hand;
        if (newHand && newHand.length > 0) {
          setSelectedCardIndex(Math.min(cardIndex, newHand.length - 1));
        } else {
          setSelectedCardIndex(null);
        }
        setTrashMode(null);
        setTrashSelectedIndices(new Set());
      }
      setSurgeTargets([]);
      setSurgeCardIndex(null);
      setSurgePrimaryTarget(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [phase, activePlayer, gameState.id, activePlayerId, onStateUpdate]);

  /** Enter trash/discard selection mode if the card requires it, otherwise play immediately. */
  const maybeEnterTrashMode = useCallback((
    cardIndex: number,
    choiceReq: ReturnType<typeof getCardChoiceRequirement>,
    targetQ?: number, targetR?: number,
    extraTargets?: [number, number][],
    targetPlayerId?: string,
  ) => {
    if (!choiceReq || !activePlayer) return false;
    // Cap maxCards to number of other cards in hand (exclude the played card)
    const otherCardsCount = activePlayer.hand.length - 1;
    const maxCards = Math.min(choiceReq.maxCards, otherCardsCount);
    const minCards = Math.min(choiceReq.minCards, otherCardsCount);
    if (maxCards <= 0 && minCards <= 0) return false;  // no cards to choose from
    setTrashMode({
      cardIndex,
      targetQ, targetR,
      targetPlayerId,
      extraTargets,
      effectType: choiceReq.effectType,
      minCards,
      maxCards,
      label: choiceReq.label,
    });
    setTrashSelectedIndices(new Set());
    setSelectedCardIndex(null);
    return true;
  }, [activePlayer]);

  const playCardAtTile = useCallback(async (cardIndex: number, q: number, r: number, extraTargets?: [number, number][], targetPlayerId?: string) => {
    if (phase !== 'play' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Global claim ban (Snowy Holiday)
    if (card.card_type === 'claim' && gameState.claim_ban_rounds && gameState.claim_ban_rounds > 0) {
      setError('Claim cards are banned this round (Snowy Holiday)');
      return;
    }

    // Validate the tile is a legal target before entering any card choice UI (e.g. Demon Pact trash selection).
    // This prevents the player from selecting trash cards only to have the play rejected.
    const tileKey = `${q},${r}`;
    const tile = gameState.grid?.tiles[tileKey];
    if (!tile || tile.is_blocked) {
      setError(`${card.name} cannot target that tile`);
      return;
    }
    if (card.card_type === 'claim') {
      // Check adjacency requirement
      if (card.adjacency_required !== false) {
        const hasAdjacentOwned = HEX_DIRS.some(([dq, dr]) => {
          const nk = `${q + dq},${r + dr}`;
          const nt = gameState.grid?.tiles[nk];
          return nt && nt.owner === activePlayerId;
        });
        if (!hasAdjacentOwned) {
          setError(`${card.name} must target a tile adjacent to one you own`);
          return;
        }
      }
      // Check unoccupied_only
      if (card.unoccupied_only && tile.owner) {
        setError(`${card.name} can only target unoccupied tiles`);
        return;
      }
      // Check duplicate claim (non-stackable)
      if (!card.stackable && activePlayer.planned_actions?.some(
        a => a.card.card_type === 'claim' && a.target_q === q && a.target_r === r
      )) {
        setError(`You already have a claim on that tile this turn`);
        return;
      }
    }

    // Check if card needs trash/discard choice
    const choiceReq = getCardChoiceRequirement(card);
    if (choiceReq && maybeEnterTrashMode(cardIndex, choiceReq, q, r, extraTargets, targetPlayerId)) {
      return;
    }

    await executePlayCard(cardIndex, q, r, extraTargets, targetPlayerId);
  }, [phase, activePlayer, executePlayCard, maybeEnterTrashMode, gameState.grid?.tiles, activePlayerId]);

  const playCardNoTarget = useCallback(async (cardIndex: number) => {
    if (phase !== 'play' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Check if card needs trash/discard choice
    const choiceReq = getCardChoiceRequirement(card);
    if (choiceReq && maybeEnterTrashMode(cardIndex, choiceReq)) {
      return;
    }

    await executePlayCard(cardIndex);
  }, [phase, activePlayer, executePlayCard, maybeEnterTrashMode]);

  // Convert screen coords from card drag to hex grid coords
  const handleDragPlay = useCallback((cardIndex: number, screenX: number, screenY: number, dragVelocityX?: number, dragVelocityY?: number) => {
    if (!gridContainerRef.current || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Any drag attempt means the player understands the mechanic — dismiss the hint
    setShowDragHint(false);

    // Store drag release info so executePlayCard can pass it to the departing animation
    dragReleaseRef.current = { x: screenX, y: screenY, vx: dragVelocityX ?? 0, vy: dragVelocityY ?? 0 };

    // Player-targeting engine cards (e.g. Sabotage, Infestation): must drop on an opponent's tile
    if (card.card_type === 'engine' && needsOpponentTarget(card)) {
      const rect = gridContainerRef.current.getBoundingClientRect();
      const canvasX = screenX - rect.left;
      const canvasY = screenY - rect.top;
      const transform = gridTransformRef.current;
      if (!transform) return;
      const localX = (canvasX - transform.offsetX) / transform.scale;
      const localY = (canvasY - transform.offsetY) / transform.scale;
      const { q, r } = pixelToAxial(localX, localY);
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || !tile.owner || tile.owner === activePlayerId) {
        setError(`${card.name} must target an opponent's tile`);
        return;
      }
      playCardAtTile(cardIndex, q, r, undefined, tile.owner);
      return;
    }

    // Engine cards targeting own tiles (Exodus, Scorched Retreat): must drop on own non-base tile
    if (card.card_type === 'engine' && card.target_own_tile) {
      const rect = gridContainerRef.current.getBoundingClientRect();
      const canvasX = screenX - rect.left;
      const canvasY = screenY - rect.top;
      const transform = gridTransformRef.current;
      if (!transform) return;
      const localX = (canvasX - transform.offsetX) / transform.scale;
      const localY = (canvasY - transform.offsetY) / transform.scale;
      const { q, r } = pixelToAxial(localX, localY);
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.owner !== activePlayerId) {
        setError(`${card.name} must target a tile you own`);
        return;
      }
      if (tile.is_base) {
        setError(`${card.name} cannot target a base tile`);
        return;
      }
      playCardAtTile(cardIndex, q, r);
      return;
    }

    // Non-targeting cards (engine): release anywhere roughly over the board
    if (card.card_type === 'engine') {
      const rect = gridContainerRef.current.getBoundingClientRect();
      // Generous 60px tolerance so slight overshoots still register
      const tolerance = 60;
      if (screenX >= rect.left - tolerance && screenX <= rect.right + tolerance && screenY >= rect.top - tolerance && screenY <= rect.bottom + tolerance) {
        playCardNoTarget(cardIndex);
      }
      return;
    }

    // Targeting cards (claim/defense): convert screen → canvas → hex-local → axial
    const rect = gridContainerRef.current.getBoundingClientRect();
    // Generous tolerance — accept drops slightly outside the grid container
    const tolerance = 60;
    const clampedX = Math.max(rect.left, Math.min(rect.right, screenX));
    const clampedY = Math.max(rect.top, Math.min(rect.bottom, screenY));
    // Only clamp if within tolerance; if way outside, let it fall through
    const effectiveX = (screenX >= rect.left - tolerance && screenX <= rect.right + tolerance) ? clampedX : screenX;
    const effectiveY = (screenY >= rect.top - tolerance && screenY <= rect.bottom + tolerance) ? clampedY : screenY;
    const canvasX = effectiveX - rect.left;
    const canvasY = effectiveY - rect.top;
    const transform = gridTransformRef.current;
    if (!transform) return;
    const localX = (canvasX - transform.offsetX) / transform.scale;
    const localY = (canvasY - transform.offsetY) / transform.scale;
    const { q, r } = pixelToAxial(localX, localY);

    // Verify the resolved hex actually exists on the grid
    const resolvedKey = `${q},${r}`;
    if (!gameState.grid?.tiles[resolvedKey]) return;

    // Validate defense card restrictions — must target own tile
    if (card.card_type === 'defense') {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (tile && tile.owner !== activePlayerId) {
        setError(`${card.name} must target a tile you own`);
        return;
      }
    }

    // Validate claim card restrictions (more specific error messages)
    if (card.card_type === 'claim' && !card.target_own_tile) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (tile && !tile.owner && tile.base_defense > card.power) {
        setError(`${card.name} (power ${card.power}) is too weak to capture this tile (defense ${tile.base_defense})`);
        return;
      }
      if (tile && tile.owner && card.unoccupied_only) {
        setError(`${card.name} can only target unoccupied tiles`);
        return;
      }
    }

    // Multi-target card (Surge): enter multi-target selection mode on drag
    if (card.multi_target_count > 0) {
      setSurgeCardIndex(cardIndex);
      setSurgePrimaryTarget([q, r]);
      setSurgeTargets([]);
      setSelectedCardIndex(cardIndex);
      return;
    }

    // Multi-tile defense card (Bulwark, etc.): enter multi-target selection mode
    if (card.card_type === 'defense' && (card.defense_target_count ?? 1) > 1) {
      setSurgeCardIndex(cardIndex);
      setSurgePrimaryTarget([q, r]);
      setSurgeTargets([]);
      setSelectedCardIndex(cardIndex);
      return;
    }

    playCardAtTile(cardIndex, q, r);
  }, [activePlayer, gameState.grid, playCardAtTile, playCardNoTarget]);

  // Helper: find the tile key for a player's base tile
  const findBaseKey = useCallback((playerId: string): string | null => {
    for (const tile of Object.values(gameState.grid.tiles)) {
      if (tile.is_base && tile.base_owner === playerId) return `${tile.q},${tile.r}`;
    }
    return null;
  }, [gameState.grid.tiles]);

  // Helper: resolve an action's display tile key (tile target, or target player's base)
  const actionTileKey = useCallback((action: import('../types/game').PlannedAction): string | null => {
    if (action.target_q != null && action.target_r != null) return `${action.target_q},${action.target_r}`;
    if (action.target_player_id) return findBaseKey(action.target_player_id);
    return null;
  }, [findBaseKey]);

  const handleTileClick = useCallback(async (q: number, r: number, shiftKey?: boolean) => {
    tileClickedRef.current = true;

    // Test mode: shift+click cycles tile ownership (none → p0 → p1 → ... → none)
    if (shiftKey && gameState.test_mode) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.is_blocked || tile.is_base) return;
      const playerOrder = gameState.player_order;
      const currentOwnerIdx = tile.owner ? playerOrder.indexOf(tile.owner) : -1;
      const nextIdx = currentOwnerIdx + 1;
      const nextOwner = nextIdx < playerOrder.length ? playerOrder[nextIdx] : null;
      try {
        const resp = await api.testSetTileOwner(gameState.id, q, r, nextOwner);
        onStateUpdate(resp.state);
      } catch { /* ignore */ }
      return;
    }

    // Review mode: clicking a tile with revealed actions opens full-card overlay
    if (reviewing && revealedActionsRef.current) {
      const clickedKey = `${q},${r}`;
      const entries: { playerId: string; playerName: string; card: Card }[] = [];
      for (const [pid, playerActions] of Object.entries(revealedActionsRef.current)) {
        const name = gameState.players[pid]?.name ?? pid;
        for (const action of playerActions) {
          if (actionTileKey(action) === clickedKey) {
            entries.push({ playerId: pid, playerName: name, card: action.card });
          }
        }
      }
      if (entries.length > 0) {
        setReviewHoveredTile(null);
        setReviewFullCards(entries);
      }
      return;
    }

    if (phase !== 'play' || !activePlayer) return;

    // Multi-target mode (Surge or multi-tile Defense): adding extra targets
    if (surgeCardIndex !== null && surgePrimaryTarget) {
      const tileKey = `${q},${r}`;
      // Don't allow duplicate targets or the primary target
      if (surgeTargets.some(([tq, tr]) => tq === q && tr === r)) return;
      if (surgePrimaryTarget[0] === q && surgePrimaryTarget[1] === r) return;

      const surgeCard = activePlayer.hand[surgeCardIndex];
      const isDefenseMulti = surgeCard?.card_type === 'defense' && (surgeCard?.defense_target_count ?? 1) > 1;

      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.is_blocked) return;

      if (isDefenseMulti) {
        // Defense multi-target: must select own tiles
        if (tile.owner !== activePlayerId) return;
        const maxExtra = (surgeCard?.defense_target_count ?? 1) - 1;
        if (surgeTargets.length >= maxExtra) return;
      } else {
        // Claim multi-target (Surge): must select non-own tiles
        if (tile.owner === activePlayerId) return;
        const maxExtra = surgeCard?.multi_target_count ?? 0;
        if (surgeTargets.length >= maxExtra) return;
      }
      setSurgeTargets(prev => [...prev, [q, r]]);
      sound.tileSelect();
      return;
    }

    if (selectedCardIndex === null) return;

    const card = activePlayer.hand[selectedCardIndex];
    if (!card) return;

    // Any play attempt means the player understands the mechanic — dismiss the hint
    setShowDragHint(false);

    // Player-targeting engine cards (e.g. Sabotage, Infestation): click an opponent's tile
    if (card.card_type === 'engine' && needsOpponentTarget(card)) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || !tile.owner || tile.owner === activePlayerId) {
        setError(`${card.name} must target an opponent's tile`);
        return;
      }
      sound.tileSelect();
      await playCardAtTile(selectedCardIndex, q, r, undefined, tile.owner);
      return;
    }

    // Engine cards targeting own tiles (Exodus, Scorched Retreat): click own non-base tile
    if (card.card_type === 'engine' && card.target_own_tile) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.owner !== activePlayerId) {
        setError(`${card.name} must target a tile you own`);
        return;
      }
      if (tile.is_base) {
        setError(`${card.name} cannot target a base tile`);
        return;
      }
      sound.tileSelect();
      await playCardAtTile(selectedCardIndex, q, r);
      return;
    }

    if (card.card_type === 'claim' || card.card_type === 'defense') {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];

      // Validate defense card restrictions — must target own tile
      if (card.card_type === 'defense') {
        if (tile && tile.owner !== activePlayerId) {
          setError(`${card.name} must target a tile you own`);
          return;
        }
      }

      // Validate claim card restrictions
      if (card.card_type === 'claim') {
        if (!card.target_own_tile) {
          if (tile && !tile.owner && tile.base_defense > card.power) {
            setError(`${card.name} (power ${card.power}) is too weak to capture this tile (defense ${tile.base_defense})`);
            return;
          }
          if (tile && tile.owner && card.unoccupied_only) {
            setError(`${card.name} can only target unoccupied tiles`);
            return;
          }
        }

        // Multi-target card (Surge): enter multi-target selection mode
        if (card.multi_target_count > 0) {
          setSurgeCardIndex(selectedCardIndex);
          setSurgePrimaryTarget([q, r]);
          setSurgeTargets([]);
          return;
        }
      }

      // Multi-tile defense card: enter multi-target selection mode
      if (card.card_type === 'defense' && (card.defense_target_count ?? 1) > 1) {
        setSurgeCardIndex(selectedCardIndex);
        setSurgePrimaryTarget([q, r]);
        setSurgeTargets([]);
        return;
      }

      sound.tileSelect();
      await playCardAtTile(selectedCardIndex, q, r);
    }
  }, [phase, activePlayer, selectedCardIndex, gameState.grid, playCardAtTile, surgeCardIndex, surgePrimaryTarget, surgeTargets, activePlayerId, reviewing, gameState.players, actionTileKey, sound]);

  const handlePlayEngine = useCallback(async () => {
    if (selectedCardIndex === null) return;
    await playCardNoTarget(selectedCardIndex);
  }, [selectedCardIndex, playCardNoTarget]);

  // Confirm Surge multi-target selection
  const handleConfirmSurge = useCallback(async () => {
    if (surgeCardIndex === null || !surgePrimaryTarget) return;
    await playCardAtTile(surgeCardIndex, surgePrimaryTarget[0], surgePrimaryTarget[1], surgeTargets);
  }, [surgeCardIndex, surgePrimaryTarget, surgeTargets, playCardAtTile]);

  const handleCancelSurge = useCallback(() => {
    setSurgeCardIndex(null);
    setSurgePrimaryTarget(null);
    setSurgeTargets([]);
  }, []);

  // Confirm trash/discard selection
  const handleConfirmTrash = useCallback(async () => {
    if (!trashMode || !activePlayer) return;
    const { cardIndex, targetQ, targetR, extraTargets, targetPlayerId, effectType } = trashMode;

    // Pending discard (deferred from card play, e.g. Regroup) — use separate API
    if (trashMode.pendingDiscard) {
      const indices = [...trashSelectedIndices].sort((a, b) => a - b);
      try {
        setError(null);
        const result = await api.submitDiscard(gameState.id, activePlayerId, indices);
        onStateUpdate(result.state);
        setTrashMode(null);
        setTrashSelectedIndices(new Set());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // Convert selected hand indices to post-removal indices (after played card is popped)
    const adjustedIndices = [...trashSelectedIndices]
      .map(i => (i > cardIndex ? i - 1 : i))
      .sort((a, b) => a - b);

    const isDiscard = effectType === 'self_discard';
    await executePlayCard(
      cardIndex, targetQ, targetR, extraTargets, targetPlayerId,
      isDiscard ? undefined : adjustedIndices,
      isDiscard ? adjustedIndices : undefined,
    );
  }, [trashMode, trashSelectedIndices, activePlayer, executePlayCard, gameState.id, activePlayerId, onStateUpdate]);

  const handleCancelTrash = useCallback(() => {
    setTrashMode(null);
    setTrashSelectedIndices(new Set());
  }, []);

  const handleTrashToggle = useCallback((cardIndex: number) => {
    if (!trashMode) return;
    setTrashSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(cardIndex)) {
        next.delete(cardIndex);
      } else {
        // At capacity: evict the least recently selected card (first in Set insertion order)
        if (next.size >= trashMode.maxCards) {
          const oldest = next.values().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        next.add(cardIndex);
      }
      return next;
    });
  }, [trashMode]);

  const handleSubmitPlay = useCallback(async () => {
    try {
      setError(null);
      const result = await api.submitPlay(gameState.id, activePlayerId);

      // Apply the state — if phase is now 'reveal', the phase change effect
      // will detect play→reveal and set up the resolve animation automatically.
      onStateUpdate(result.state);

      if (result.state.current_phase !== 'reveal') {
        // Not all plans submitted yet — cycle to next local player
        if (shouldCycle) {
          const nextIndex = gameState.player_order.findIndex(
            (pid, i) => i !== activePlayerIndex && localPlayerIds.includes(pid) && !gameState.players[pid].has_submitted_play && !gameState.players[pid].is_cpu,
          );
          if (nextIndex >= 0) setActivePlayerIndex(nextIndex);
        }
      }
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState, activePlayerId, activePlayerIndex, onStateUpdate, homePlayerIndex, shouldCycle, localPlayerIds]);

  const handleBuyArchetype = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'archetype', cardId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleBuyNeutral = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'neutral', cardId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleBuyUpgrade = useCallback(async () => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'upgrade');
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleUpgradeCard = useCallback(async (cardIndex: number) => {
    try {
      setError(null);
      const result = await api.upgradeCard(gameState.id, activePlayerId, cardIndex);
      sound.upgradeCard();
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate, sound]);

  const handleReroll = useCallback(async () => {
    try {
      setError(null);
      const result = await api.rerollMarket(gameState.id, activePlayerId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleEndTurn = useCallback(async () => {
    try {
      setError(null);
      const result = await api.endTurn(gameState.id, activePlayerId);
      const allDone = result.state.current_phase !== 'buy';

      if (allDone) {
        // All players ended turn — game advanced to next round
        if (animationMode !== 'off' && activePlayer && activePlayer.hand.length > 0) {
          pendingStateRef.current = result.state;
          setDiscardingAll(true);
        } else {
          onStateUpdate(result.state);
          setActivePlayerIndex(homePlayerIndex);
          setSelectedCardIndex(null);
        }
      } else {
        // Not all players done
        onStateUpdate(result.state);
        if (shouldCycle) {
          // Cycle to next unfinished local player
          const nextIndex = gameState.player_order.findIndex(
            (pid, i) => i !== activePlayerIndex && localPlayerIds.includes(pid) && !result.state.players[pid].has_ended_turn && !result.state.players[pid].is_cpu,
          );
          if (nextIndex >= 0) setActivePlayerIndex(nextIndex);
        }
        // In multiplayer without cycling: stay on local player (waiting for others)
        setSelectedCardIndex(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState, activePlayerId, activePlayerIndex, onStateUpdate, animationMode, activePlayer, homePlayerIndex, shouldCycle, localPlayerIds]);

  // Hot-seat auto-switch: when the current buyer changes (e.g. after a CPU buys
  // or another player ends their buy turn), switch to the new buyer if they are
  // a local player controlled by this browser. Also auto-open the shop for them.
  const prevBuyerIdRef = useRef<string | null>(null);
  useEffect(() => {
    const buyerId = gameState.current_buyer_id;
    if (buyerId && buyerId !== prevBuyerIdRef.current && gameState.current_phase === 'buy') {
      // Auto-switch if the new buyer is a local (non-CPU) player
      if (localPlayerIds.includes(buyerId) && !gameState.players[buyerId]?.is_cpu) {
        const buyerIndex = gameState.player_order.indexOf(buyerId);
        if (buyerIndex >= 0) {
          setActivePlayerIndex(buyerIndex);
          setSelectedCardIndex(null);
        }
        // Auto-open shop when it becomes this player's turn to buy
        setShowShopOverlay(true);
      }
    }
    prevBuyerIdRef.current = buyerId;
  }, [gameState.current_buyer_id, gameState.current_phase, gameState.player_order, gameState.players, localPlayerIds]);

  // CPU buying delay: when the current buyer is a CPU, wait 1.5s so the user
  // can see the "Buying..." indicator, then trigger the backend to process
  // CPU purchases.
  useEffect(() => {
    const buyerId = gameState.current_buyer_id;
    if (!buyerId || gameState.current_phase !== 'buy') return;
    const buyer = gameState.players[buyerId];
    if (!buyer?.is_cpu) return;

    const timer = setTimeout(async () => {
      try {
        const result = await api.processCpuBuys(gameState.id);
        onStateUpdate(result.state);
      } catch {
        // CPU buy failed — ignore (state will be stale until next action)
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [gameState.current_buyer_id, gameState.current_phase, gameState.id, gameState.players, onStateUpdate]);

  // Submit Play button state
  const submitHasCardsLeft = activePlayer ? activePlayer.hand.length > 0 : false;
  const submitActionsLeft = activePlayer ? activePlayer.actions_available - activePlayer.actions_used : 0;
  const submitCanStillPlay = submitHasCardsLeft && submitActionsLeft > 0;

  // Keyboard shortcuts: Escape, C/D/S, 1-9, Enter (with hold support)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Disable shortcuts when intro sequence or game-over overlay is active
      if (showIntro || introSequence !== 'done' || showGameOver) return;

      // Escape: close the topmost overlay
      if (e.key === 'Escape') {
        if (showCardBrowser) { setShowCardBrowser(false); return; }
        if (showDeckViewer) { setShowDeckViewer(false); return; }
        if (showShopOverlay) { setShowShopOverlay(false); return; }
        if (showFullLog) { setShowFullLog(false); return; }
        if (selectedCardIndex !== null) { setSelectedCardIndex(null); return; }
        return;
      }

      // Tab: cycle through cards in hand during Play phase
      if (e.key === 'Tab') {
        e.preventDefault();
        if (
          phase === 'play' && activePlayer && !activePlayer.has_submitted_play &&
          !interactionBlocked && !resolving && activePlayer.hand.length > 0 &&
          surgeCardIndex === null && !trashMode
        ) {
          const len = activePlayer.hand.length;
          if (e.shiftKey) {
            // Shift+Tab: cycle backward
            setSelectedCardIndex(prev =>
              prev === null || prev === 0 ? len - 1 : prev - 1
            );
          } else {
            // Tab: cycle forward
            setSelectedCardIndex(prev =>
              prev === null || prev >= len - 1 ? 0 : prev + 1
            );
          }
        }
        return;
      }

      // Ignore remaining shortcuts if typing in an input or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // C/D/S: toggle Cards/Deck/Shop overlays
      const key = e.key.toLowerCase();
      if (key === 'c') { setShowCardBrowser(p => { if (!p) { setShowDeckViewer(false); setShowShopOverlay(false); } return !p; }); return; }
      if (key === 'd') { setShowDeckViewer(p => { if (!p) { setShowShopOverlay(false); setShowCardBrowser(false); } return !p; }); return; }
      if (key === 's' && !e.ctrlKey && !e.metaKey) { setShowShopOverlay(p => { if (!p) { setShowDeckViewer(false); setShowCardBrowser(false); } return !p; }); return; }

      // Enter key: play engine card, done reviewing, or hold-to-submit/end-turn
      if (e.key === 'Enter') {
        if (e.repeat) return; // prevent repeated keydown from re-triggering
        e.preventDefault();

        // Priority 0: Done reviewing
        if (reviewing && !resolving) {
          handleDoneReviewingRef.current?.();
          return;
        }

        // Priority 1: Play selected engine card (only non-targeting engines)
        if (
          phase === 'play' && activePlayer && !resolving &&
          selectedCardIndex !== null && surgeCardIndex === null && !trashMode
        ) {
          const card = activePlayer.hand[selectedCardIndex];
          if (card?.card_type === 'engine' && !needsOpponentTarget(card) && !card.target_own_tile) {
            handlePlayEngine();
            return;
          }
        }

        // Priority 2: Submit Play (only when no Play Card button is available)
        if (
          phase === 'play' && activePlayer && !activePlayer.has_submitted_play &&
          !resolving && activePlayerEffects.length === 0 &&
          surgeCardIndex === null && !trashMode
        ) {
          const hasPlayableEngine = selectedCardIndex !== null &&
            activePlayer.hand[selectedCardIndex]?.card_type === 'engine';
          if (!hasPlayableEngine) {
            if (submitCanStillPlay) {
              submitPlayRef.current?.startKeyboardHold();
            } else {
              handleSubmitPlay();
            }
            return;
          }
        }

        // Priority 3: End Turn (always requires hold)
        if (
          phase === 'buy' && activePlayer && !resolving &&
          !phaseBanner && activePlayerEffects.length === 0 &&
          !activePlayer.has_ended_turn
        ) {
          endTurnRef.current?.startKeyboardHold();
          return;
        }
        return;
      }

      // 1-9: select card by position
      const digit = parseInt(e.key, 10);
      if (digit < 1 || digit > 9 || isNaN(digit)) return;
      if (!activePlayer) return;
      const handLength = activePlayer.hand.length;
      if (handLength === 0) return;
      const cardIndex = digit - 1;
      if (cardIndex >= handLength) return;

      if (trashMode) {
        handleTrashToggle(cardIndex);
      } else if (phase === 'play' && !activePlayer.has_submitted_play && !interactionBlocked) {
        setSelectedCardIndex(prev => prev === cardIndex ? null : cardIndex);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        submitPlayRef.current?.stopKeyboardHold();
        endTurnRef.current?.stopKeyboardHold();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [activePlayer, phase, interactionBlocked, trashMode, handleTrashToggle, selectedCardIndex, surgeCardIndex, resolving, reviewing, handlePlayEngine, showCardBrowser, showDeckViewer, showShopOverlay, showFullLog, activePlayerEffects, submitCanStillPlay, handleSubmitPlay, phaseBanner, showIntro, introSequence, showGameOver]);

  const handleDiscardAllComplete = useCallback(() => {
    setDiscardingAll(false);
    if (pendingStateRef.current) {
      onStateUpdate(pendingStateRef.current);
      pendingStateRef.current = null;
    }
    setActivePlayerIndex(homePlayerIndex);
    setSelectedCardIndex(null);
  }, [onStateUpdate, homePlayerIndex]);

  // Intro overlay dismissed — start shuffle → draw → play banner sequence
  const handleIntroReady = useCallback(() => {
    setShowIntro(false);
    if (animationOff) {
      setIntroSequence('done');
      setHudVisible(true);
      setGridBuildProgress(undefined);
      return;
    }
    // Start HUD fade-in sequence
    setIntroSequence('hud_fadein');
    setInteractionBlocked(true);
  }, [animationOff]);

  // Intro sequence: hud_fadein → grid_build → shuffle → draw → "Begin!" banner
  useEffect(() => {
    if (introSequence === 'hud_fadein') {
      // Fade in HUD elements over 2.5s, then start grid build
      setHudVisible(true);
      const duration = Math.round(2500 * animSpeed) || 1000;
      const timer = setTimeout(() => setIntroSequence('grid_build'), duration);
      return () => clearTimeout(timer);
    }
    if (introSequence === 'grid_build') {
      // Animate grid build from center over ~1.5s, then start shuffle + draw concurrently
      const buildDuration = Math.round(1500 * animSpeed) || 600;
      const startTime = performance.now();
      let raf: number;
      const tick = () => {
        const elapsed = performance.now() - startTime;
        const p = Math.min(1, elapsed / buildDuration);
        setGridBuildProgress(p);
        if (p < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          setGridBuildProgress(undefined); // fully built, no more prop
          setIntroSequence('shuffle');
        }
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    if (introSequence === 'shuffle') {
      // Show shuffle animation scaled by speed
      const duration = Math.round(2000 * animSpeed) || 800;
      const timer = setTimeout(() => setIntroSequence('draw'), duration);
      return () => clearTimeout(timer);
    }
    if (introSequence === 'draw') {
      // Cards are now being passed to CardHand — entering animations will play.
      // Wait for all cards to finish their staggered draw animation, then
      // mark intro done. The phase effect will detect upkeep and show banners.
      const handSize = activePlayer?.hand.length ?? 0;
      const drawDuration = handSize * 500 + 500;
      const timer = setTimeout(() => {
        sound.beginJingle();
        setIntroSequence('done');
      }, drawDuration);
      return () => clearTimeout(timer);
    }
  }, [introSequence, animated, activePlayer, gameState, animSpeed]);

  // When intro sequence completes, unblock interaction
  useEffect(() => {
    if (introSequence === 'done') {
      setInteractionBlocked(false);
    }
  }, [introSequence]);

  // Transition from resolve to buy phase (called after effects popup or directly)
  // If deferredState is provided, apply it now (was held back during effects popup)
  // Enter review mode — player can hover tiles/players to see what was played
  const enterReviewMode = useCallback(() => {
    setReviewing(true);
    setPhaseBanner(null);
    setInteractionBlocked(false);
    setReviewHoveredTile(null);
    setReviewHoveredPlayer(null);
    setReviewFullCards(null);
  }, []);

  // Advance through resolve to buy phase, then show the buy banner
  const advanceAndShowBuy = useCallback(() => {
    setActivePlayerEffects([]);
    api.advanceResolve(gameState.id, activePlayerId).then(result => {
      onStateUpdate(result.state);
      prevPhaseRef.current = result.state.current_phase;
      if (result.state.current_phase === 'buy') {
        // Transitioned to BUY — show banner then open shop on completion
        setBannerSubtitle('Grow Your Deck');
        setPhaseBanner('buy');
        setBannerKey(k => k + 1);
        setInteractionBlocked(true);
      } else {
        // Still in REVEAL — waiting for other players in multiplayer.
        // Clear banner/interaction block; WebSocket will deliver BUY state
        // and the phase change effect will show the buy banner then.
        setPhaseBanner(null);
        setInteractionBlocked(false);
      }
    }).catch(() => {
      // Already acknowledged — clear state and let WebSocket handle transition
      setPhaseBanner(null);
      setInteractionBlocked(false);
    });
  }, [gameState.id, activePlayerId, animationOff, onStateUpdate]);

  // "Done Reviewing" clicked — acknowledge this player's resolve, then cycle or finish
  const handleDoneReviewing = useCallback(() => {
    setReviewHoveredTile(null);
    setReviewHoveredPlayer(null);

    // In local multiplayer, cycle to next local player who hasn't acknowledged yet
    if (shouldCycle) {
      // Acknowledge this player's resolve without clearing review mode
      api.advanceResolve(gameState.id, activePlayerId).then(result => {
        onStateUpdate(result.state);
        prevPhaseRef.current = result.state.current_phase;

        if (result.state.current_phase === 'buy') {
          // All players acknowledged — exit review and show buy banner
          setReviewing(false);
          revealedActionsRef.current = null;
          setActivePlayerIndex(homePlayerIndex);
          setBannerSubtitle('Grow Your Deck');
          setPhaseBanner('buy');
          setBannerKey(k => k + 1);
          setInteractionBlocked(true);
          return;
        }

        // Find next local player who hasn't acknowledged
        const nextIndex = gameState.player_order.findIndex(
          (pid, i) => i !== activePlayerIndex && localPlayerIds.includes(pid) &&
            !result.state.players[pid].has_acknowledged_resolve && !result.state.players[pid].is_cpu,
        );
        if (nextIndex >= 0) {
          setActivePlayerIndex(nextIndex);
          // Stay in review mode for the next player
        } else {
          // All local players done — exit review, wait for remote players
          setReviewing(false);
          revealedActionsRef.current = null;
          setActivePlayerIndex(homePlayerIndex);
          setPhaseBanner(null);
          setInteractionBlocked(false);
        }
      }).catch(() => {
        setPhaseBanner(null);
        setInteractionBlocked(false);
      });
      return;
    }

    // Single player or non-cycling: original behavior
    setReviewing(false);
    revealedActionsRef.current = null;
    advanceAndShowBuy();
  }, [advanceAndShowBuy, shouldCycle, gameState, activePlayerId, activePlayerIndex, homePlayerIndex, localPlayerIds, onStateUpdate]);
  handleDoneReviewingRef.current = handleDoneReviewing;

  // Phase banner completed
  const handleBannerComplete = useCallback(() => {
    setBannerLabelOverride(null);
    // Reset debt animation state
    setDebtFlyTarget(null);
    setForcePlayerPanelExpanded(false);
    setBannerHoldUntilRelease(false);
    debtFlyPendingRef.current = null;
    const bannerPhase = phaseBanner;

    // Upkeep banner finished → advance to PLAY via API, then show PLAY banner
    if (bannerPhase === 'upkeep') {
      // Test mode "Give Debt" button — just dismiss the banner, don't call API
      if (testDebtBannerRef.current) {
        testDebtBannerRef.current = false;
        setPhaseBanner(null);
        setInteractionBlocked(false);
        return;
      }
      api.advanceUpkeep(gameState.id).then(result => {
        onStateUpdate(result.state);
        // Chain into the play banner — sync ref so phase effect doesn't re-trigger
        prevPhaseRef.current = result.state.current_phase;
        setBannerSubtitle('Choose Wisely');
        setPhaseBanner('play');
        setBannerKey(k => k + 1);
      }).catch(() => {
        setPhaseBanner(null);
        setInteractionBlocked(false);
      });
      return;
    }

    if (bannerPhase === 'reveal' && !resolving) {
      // Reveal banner finished but no resolution steps to animate —
      // show player effects if any, then enter review mode.
      setActivePlayerIndex(homePlayerIndex);

      // Show player effect popups if any (e.g. Sabotage forced discards)
      const effects = gameState.player_effects;
      if (effects && effects.length > 0 && !animationOff) {
        // Show effects first, then enter review mode after they complete
        setPhaseBanner(null);
        setInteractionBlocked(true);
        setActivePlayerEffects(effects);
        const targetCounts: Record<string, number> = {};
        for (const e of effects) targetCounts[e.target_player_id] = (targetCounts[e.target_player_id] ?? 0) + 1;
        const maxStack = Math.max(...Object.values(targetCounts));
        const totalDuration = 2500 + (maxStack - 1) * 300;
        setTimeout(() => {
          enterReviewMode();
        }, totalDuration);
        return;
      }

      // No effects — enter review mode directly
      enterReviewMode();
      return;
    }

    // If the actual game phase is still upkeep (e.g. after intro "Begin!" banner),
    // auto-advance through upkeep to reach play phase
    if (phase === 'upkeep' && bannerPhase !== 'upkeep') {
      api.advanceUpkeep(gameState.id).then(result => {
        onStateUpdate(result.state);
        prevPhaseRef.current = result.state.current_phase;
        setBannerSubtitle('Choose Wisely');
        setPhaseBanner('play');
        setBannerKey(k => k + 1);
      }).catch(() => {
        setPhaseBanner(null);
        setInteractionBlocked(false);
      });
      return;
    }

    setPhaseBanner(null);
    // Sync phase ref so the phase change effect doesn't re-trigger for this phase
    prevPhaseRef.current = phase;
    // If resolving, don't unblock interactions yet — resolve overlay will do that
    if (!resolving) {
      setInteractionBlocked(false);
      // Auto-open shop after buy banner completes only if active player is the current buyer
      if (bannerPhase === 'buy' && activePlayerId === gameState.current_buyer_id) {
        setShowShopOverlay(true);
      }
    }
  }, [resolving, phaseBanner, phase, onStateUpdate, animationOff, enterReviewMode, homePlayerIndex, gameState, activePlayerId]);

  // Debt fly animation complete — release banner hold, collapse panel after short delay
  const handleDebtFlyComplete = useCallback(() => {
    setDebtFlyTarget(null);
    setBannerHoldUntilRelease(false);
    debtFlyPendingRef.current = null;
    // Collapse player panel after a brief delay so the user sees the target highlight
    setTimeout(() => setForcePlayerPanelExpanded(false), 400);
  }, []);

  // Effect: after panel expands, measure target player row and start flying
  useEffect(() => {
    const pid = debtFlyPendingRef.current;
    if (!pid || !forcePlayerPanelExpanded) return;
    // Wait for panel expansion CSS transition (200ms) + render buffer
    const t = setTimeout(() => {
      const row = playerRowRefs.current.get(pid);
      if (row?.isConnected) {
        setDebtFlyTarget(row.getBoundingClientRect());
      } else {
        // Fallback: release banner without animation
        setBannerHoldUntilRelease(false);
      }
      debtFlyPendingRef.current = null;
    }, 300);
    return () => clearTimeout(t);
  }, [forcePlayerPanelExpanded]);

  // Phase banner midpoint — start debt card fly animation if applicable
  const handleBannerMidpoint = useCallback(() => {
    if (phaseBanner !== 'upkeep') return;
    if (animationOff) return;

    // Use test override if available, otherwise parse game log
    const recipient = testDebtRecipientRef.current ?? (
      gameState.current_round >= DEBT_START_ROUND ? findDebtRecipientFromLog(gameState) : null
    );
    testDebtRecipientRef.current = null; // consume the override
    if (!recipient) return;

    const isActive = recipient.id === activePlayerId;

    if (isActive) {
      // Target discard pile button (always visible in CardHand)
      const discardEl = document.querySelector('[data-discard-pile]');
      if (discardEl) {
        setDebtFlyTarget(discardEl.getBoundingClientRect());
      } else {
        setBannerHoldUntilRelease(false);
      }
    } else {
      // Target player card in sidebar — may need to expand panel first
      // Check isConnected because stale refs linger in the Map after panel collapses
      const existingRow = playerRowRefs.current.get(recipient.id);
      if (existingRow?.isConnected) {
        setDebtFlyTarget(existingRow.getBoundingClientRect());
      } else {
        // Force-expand player panel, then an effect will start the animation
        setForcePlayerPanelExpanded(true);
        debtFlyPendingRef.current = recipient.id;
      }
    }
  }, [phaseBanner, gameState, activePlayerId, animationOff]);

  // Resolve animation completed — advance resolve and move to buy phase
  const handleResolveComplete = useCallback(() => {
    setResolving(false);
    setResolutionSteps([]);
    setResolveDisplayState(null);
    setResolvedUpToStep(-1);
    setCurrentStepFade(1);
    resolveChevronCacheRef.current = [];
    setActivePlayerIndex(homePlayerIndex);
    // Recompute VP paths for all players after resolve and clear resolve log
    const postResolveTiles = gameState.grid?.tiles;
    if (postResolveTiles) {
      const allPaths: VpPath[] = [];
      for (const pid of gameState.player_order) {
        const color = PLAYER_COLORS[pid] ?? 0xffffff;
        allPaths.push(...computePlayerVpPaths(postResolveTiles, pid, color));
      }
      if (allPaths.length > 0) {
        setVpPaths(allPaths);
        setVpPathPhase('fading_in');
      } else {
        setVpPaths([]);
        setVpPathPhase('off');
      }
    }
    setResolveLogEntries([]);

    // Show player effect popups if any (e.g. Sabotage forced discards)
    const effects = gameState.player_effects;
    if (effects && effects.length > 0 && !animationOff) {
      // Show effects first, then enter review mode after they complete
      setInteractionBlocked(true);
      setActivePlayerEffects(effects);
      const targetCounts: Record<string, number> = {};
      for (const e of effects) targetCounts[e.target_player_id] = (targetCounts[e.target_player_id] ?? 0) + 1;
      const maxStack = Math.max(...Object.values(targetCounts));
      const totalDuration = 2500 + (maxStack - 1) * 300;
      setTimeout(() => {
        enterReviewMode();
      }, totalDuration);
    } else {
      // No effects — enter review mode
      enterReviewMode();
    }
  }, [animationOff, vpPaths, enterReviewMode, homePlayerIndex, gameState]);

  // Called by ResolveOverlay as each step begins — update the displayed tile state & fade chevrons
  const applyResolveStep = useCallback((stepIdx: number) => {
    const step = resolutionSteps[stepIdx];
    if (!step) return;
    // Start fading chevrons for this step's tile
    setResolvedUpToStep(stepIdx);
    setCurrentStepFade(1);
    setResolveDisplayState(prev => {
      if (!prev?.grid) return prev;
      const newTiles = { ...prev.grid.tiles };
      const tile = newTiles[step.tile_key];
      if (tile && step.winner_id && step.outcome === 'claimed') {
        newTiles[step.tile_key] = {
          ...tile,
          owner: step.winner_id,
        };
      }

      // Move resolved claim cards from planned_actions → discard for each claimant
      const newPlayers = { ...prev.players };
      for (const claimant of step.claimants) {
        const player = newPlayers[claimant.player_id];
        if (!player) continue;
        const actionIdx = player.planned_actions.findIndex(a =>
          a.card.card_type === 'claim' && a.target_q === step.q && a.target_r === step.r
        );
        if (actionIdx >= 0) {
          const action = player.planned_actions[actionIdx];
          const newPlanned = [...player.planned_actions];
          newPlanned.splice(actionIdx, 1);
          const newDiscard = [...player.discard, action.card];
          newPlayers[claimant.player_id] = {
            ...player,
            planned_actions: newPlanned,
            discard: newDiscard,
            discard_count: player.discard_count + 1,
          };
        }
      }

      return { ...prev, grid: { ...prev.grid, tiles: newTiles }, players: newPlayers };
    });

    // Recompute VP paths affected by this tile change
    if (step.outcome === 'claimed' && step.winner_id && step.previous_owner) {
      const lostTileKey = step.tile_key;
      const loserId = step.previous_owner;

      // Build the post-step tile map for path recomputation
      const prevTiles = resolveDisplayTilesRef.current;
      let tilesAfterStep: Record<string, import('../types/game').HexTile> | null = null;
      if (prevTiles) {
        tilesAfterStep = { ...prevTiles };
        const t = tilesAfterStep[step.tile_key];
        if (t) {
          tilesAfterStep[step.tile_key] = { ...t, owner: step.winner_id };
        }
      }

      const winnerId = step.winner_id;
      const winnerName = gameState.players[winnerId]?.name ?? winnerId;
      const loserName = gameState.players[loserId]?.name ?? loserId;

      setVpPaths(prev => {
        let changed = false;
        const broken: string[] = [];
        const next = prev.map(p => {
          if (p.breaking || p.playerId !== loserId) return p;
          const onPath = p.points.some(([q, r]) => `${q},${r}` === lostTileKey);
          if (!onPath) return p;
          changed = true;

          // If the VP tile itself was captured, path is gone
          const vpQ = p.points[0][0];
          const vpR = p.points[0][1];
          const vpKey = `${vpQ},${vpR}`;
          if (tilesAfterStep && tilesAfterStep[vpKey]?.owner !== loserId) {
            broken.push(vpKey);
            return { ...p, breaking: true };
          }

          // Try to find an alternate route through updated tiles
          if (tilesAfterStep) {
            const color = PLAYER_COLORS[loserId] ?? 0xffffff;
            const newPaths = computePlayerVpPaths(tilesAfterStep, loserId, color);
            const replacement = newPaths.find(np =>
              np.points[0][0] === vpQ && np.points[0][1] === vpR
            );
            if (replacement) {
              // Reroute to the new shortest path (keep noPulse for resolve)
              return { ...p, points: replacement.points, noPulse: true };
            }
          }

          // No alternate path — connection is broken
          broken.push(vpKey);
          return { ...p, breaking: true };
        });

        // Log VP path disruptions
        if (broken.length > 0) {
          setResolveLogEntries(prev => [
            ...prev,
            `★ ${winnerName} disrupted ${loserName}'s VP bonus path${broken.length > 1 ? 's' : ''} at ${lostTileKey}`,
          ]);
        }

        return changed ? next : prev;
      });
    }
  }, [resolutionSteps, gameState.players]);

  // ── Test mode handlers ──────────────────────────────────────
  const handleTestGiveCard = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.testGiveCard(gameState.id, activePlayerId, cardId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestSetStats = useCallback(async (vp?: number, resources?: number) => {
    try {
      setError(null);
      const result = await api.testSetStats(gameState.id, activePlayerId, vp, resources);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestDiscardCard = useCallback(async (cardIndex: number) => {
    try {
      setError(null);
      const result = await api.testDiscardCard(gameState.id, activePlayerId, cardIndex);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestTrashCard = useCallback(async (cardIndex: number) => {
    try {
      setError(null);
      const card = activePlayer?.hand[cardIndex];
      if (card) setTrashedCardIds(new Set([card.id]));
      const result = await api.testTrashCard(gameState.id, activePlayerId, cardIndex);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate, activePlayer]);

  const handleTestDrawCard = useCallback(async () => {
    try {
      setError(null);
      const result = await api.testDrawCard(gameState.id, activePlayerId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestDiscardHand = useCallback(async () => {
    try {
      setError(null);
      const result = await api.testDiscardHand(gameState.id, activePlayerId);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleSwitchPlayer = useCallback((index: number) => {
    const pid = gameState.player_order[index];
    if (!pid) return;
    // Don't allow switching to CPU players
    if (gameState.players[pid]?.is_cpu) return;
    // Only allow switching to local players (host + locals controlled by this browser)
    if (localPlayerIds.length > 0 && !localPlayerIds.includes(pid)) return;
    setActivePlayerIndex(index);
    setSelectedCardIndex(null);
    setError(null);
  }, [gameState.player_order, gameState.players]);

  // ── Game Over handlers ─────────────────────────────────────

  const handleReturnToLobby = useCallback(async () => {
    if (!mpPlayerId || !mpToken) return;
    try {
      await api.returnToLobby(gameState.id, mpPlayerId, mpToken);
      // The lobby_update WS message will handle screen transition
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, mpPlayerId, mpToken]);

  const handleExitGame = useCallback(async () => {
    onLeaveGame?.();
  }, [onLeaveGame]);

  const selectedCard = selectedCardIndex !== null ? activePlayer?.hand[selectedCardIndex] : null;
  const hoveredCard = hoveredCardIndex !== null ? activePlayer?.hand[hoveredCardIndex] : null;
  // For grid highlighting, prefer hovered card over selected card
  const highlightCard = hoveredCard ?? selectedCard;

  // Review mode: compute tiles that had cards played on them
  const reviewPulseTiles = useMemo(() => {
    if (!reviewing) return undefined;
    const actions = revealedActionsRef.current;
    if (!actions) return undefined;
    const tiles = new Set<string>();
    for (const playerActions of Object.values(actions)) {
      for (const action of playerActions) {
        const key = actionTileKey(action);
        if (key) {
          tiles.add(key);
          // Include extra targets (e.g. Surge)
          if (action.extra_targets) {
            for (const [eq, er] of action.extra_targets) {
              tiles.add(`${eq},${er}`);
            }
          }
        }
      }
    }
    return tiles.size > 0 ? tiles : undefined;
  }, [reviewing, actionTileKey]);

  // Review mode: build lookup of cards played per tile (for hover popup)
  const reviewTileCards = useMemo(() => {
    if (!reviewing) return null;
    const actions = revealedActionsRef.current;
    if (!actions) return null;
    const map = new Map<string, { playerId: string; playerName: string; card: import('../types/game').Card; effectivePower?: number; effectiveResourceGain?: number; effectiveDrawCards?: number }[]>();
    for (const [pid, playerActions] of Object.entries(actions)) {
      const player = gameState.players[pid];
      const name = player?.name ?? pid;
      for (const action of playerActions) {
        const key = actionTileKey(action);
        if (key) {
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({ playerId: pid, playerName: name, card: action.card, effectivePower: action.effective_power, effectiveResourceGain: action.effective_resource_gain, effectiveDrawCards: action.effective_draw_cards });
        }
      }
    }
    return map;
  }, [reviewing, gameState.players, actionTileKey]);

  // Submit Play button state (used by keyboard handler and UI)
  // NOTE: declared here so it's available to the keyboard effect above

  // Player tile count and VP tracking
  const tilesPerVp = 3;
  const playerTileCount = activePlayer
    ? Object.values(gameState.grid.tiles).filter(t => t.owner === activePlayerId).length
    : 0;
  const anyPlayerReachedVp = Object.values(gameState.players).some(p => !p.has_left && p.vp >= gameState.vp_target);
  const pendingClaimCount = activePlayer
    ? activePlayer.planned_actions.filter(a => a.card.card_type === 'claim' && a.target_q !== null).length
    : 0;

  // Hex distance in axial coordinates
  const hexDistance = useCallback((q1: number, r1: number, q2: number, r2: number): number => {
    return Math.max(Math.abs(q1 - q2), Math.abs(r1 - r2), Math.abs((q1 + r1) - (q2 + r2)));
  }, []);

  // Filter tiles to only those a given claim card can actually be played on
  const getValidClaimTiles = useCallback((card: Card | null | undefined): Set<string> => {
    if (!card || card.card_type !== 'claim') return adjacentTiles;
    const valid = new Set<string>();
    const tiles = gameState.grid?.tiles;
    if (!tiles) return valid;

    // Flood / target_own_tile: highlight player's own tiles as valid targets
    if (card.target_own_tile) {
      for (const [key, tile] of Object.entries(tiles)) {
        if (tile.owner === activePlayerId) {
          valid.add(key);
        }
      }
      return valid;
    }

    // Tiles where the player already has a non-stacking claim this turn
    const alreadyClaimed = new Set<string>();
    if (!card.stackable && activePlayer?.planned_actions) {
      for (const action of activePlayer.planned_actions) {
        if (action.card.card_type === 'claim' && action.target_q != null) {
          alreadyClaimed.add(`${action.target_q},${action.target_r}`);
        }
      }
    }

    // Determine candidate tiles based on adjacency requirement + claim_range
    let candidates: Iterable<string>;
    if (!card.adjacency_required) {
      candidates = Object.keys(tiles);
    } else if (card.claim_range > 1) {
      // Extended range: find all tiles within N steps of any owned tile
      const rangedSet = new Set<string>();
      const ownedTiles = Object.values(tiles).filter(t => t.owner === activePlayerId);
      for (const key of Object.keys(tiles)) {
        const t = tiles[key];
        if (!t || t.is_blocked || t.owner === activePlayerId) continue;
        for (const owned of ownedTiles) {
          if (hexDistance(t.q, t.r, owned.q, owned.r) <= card.claim_range) {
            rangedSet.add(key);
            break;
          }
        }
      }
      candidates = rangedSet;
    } else {
      candidates = adjacentTiles;
    }

    for (const key of candidates) {
      const tile = tiles[key];
      if (!tile || tile.is_blocked) continue;
      // Skip own tiles (can't claim what you own)
      if (tile.owner === activePlayerId) continue;
      // Exclude neutral tiles too weak to capture
      if (!tile.owner && tile.base_defense > card.power) continue;
      // Exclude occupied tiles for unoccupied_only cards
      if (tile.owner && card.unoccupied_only) continue;
      // Exclude tiles already claimed this turn (no stacking)
      if (alreadyClaimed.has(key)) continue;
      valid.add(key);
    }
    return valid;
  }, [adjacentTiles, gameState.grid?.tiles, activePlayer?.planned_actions, activePlayerId, hexDistance]);

  // All tiles a card can legally be played on (includes own tiles for defensive claims)
  const getAllValidPlayTiles = useCallback((card: Card | null | undefined): Set<string> => {
    if (!card) return new Set();

    // Defense cards: only own tiles are valid targets
    if (card.card_type === 'defense') {
      const valid = new Set<string>();
      const tiles = gameState.grid?.tiles;
      if (tiles) {
        for (const [key, tile] of Object.entries(tiles)) {
          if (tile.owner === activePlayerId && !tile.is_blocked) {
            valid.add(key);
          }
        }
      }
      return valid;
    }

    // Engine cards targeting own tiles (Exodus, Scorched Retreat): own non-base, non-blocked tiles
    if (card.card_type === 'engine' && card.target_own_tile) {
      const valid = new Set<string>();
      const tiles = gameState.grid?.tiles;
      if (tiles) {
        for (const [key, tile] of Object.entries(tiles)) {
          if (tile.owner === activePlayerId && !tile.is_base && !tile.is_blocked) {
            valid.add(key);
          }
        }
      }
      return valid;
    }

    // Start with the highlighted expansion targets for claim cards
    const valid = new Set(getValidClaimTiles(card));
    // For claim cards (not unoccupied_only, not target_own_tile which is already handled),
    // also include own tiles as valid defensive placements
    if (card.card_type === 'claim' && !card.unoccupied_only && !card.target_own_tile) {
      const tiles = gameState.grid?.tiles;
      if (tiles) {
        const alreadyClaimed = new Set<string>();
        if (!card.stackable && activePlayer?.planned_actions) {
          for (const action of activePlayer.planned_actions) {
            if (action.card.card_type === 'claim' && action.target_q != null) {
              alreadyClaimed.add(`${action.target_q},${action.target_r}`);
            }
          }
        }
        for (const [key, tile] of Object.entries(tiles)) {
          if (tile.owner === activePlayerId && !tile.is_blocked && !alreadyClaimed.has(key)) {
            valid.add(key);
          }
        }
      }
    }
    return valid;
  }, [getValidClaimTiles, gameState.grid?.tiles, activePlayer?.planned_actions, activePlayerId]);

  // Helper: find closest tile owned by a player to a target position
  const findClosestOwnedTile = useCallback((
    targetQ: number, targetR: number,
    tiles: Record<string, import('../types/game').HexTile>,
    playerId: string,
  ): { q: number; r: number } | null => {
    let closest: { q: number; r: number } | null = null;
    let minDist = Infinity;
    for (const tile of Object.values(tiles)) {
      if (tile.owner !== playerId) continue;
      const dist = hexDistance(tile.q, tile.r, targetQ, targetR);
      if (dist < minDist) {
        minDist = dist;
        closest = { q: tile.q, r: tile.r };
      }
    }
    return closest;
  }, [hexDistance]);

  // Build claim chevrons for the active player during play phase
  const planChevrons = useMemo((): ClaimChevron[] => {
    if (phase !== 'play' || !activePlayer?.planned_actions || resolving) return [];
    const tiles = gameState.grid?.tiles;
    if (!tiles) return [];

    const color = PLAYER_COLORS[activePlayerId] ?? 0xffffff;
    const chevrons: ClaimChevron[] = [];

    for (const action of activePlayer.planned_actions) {
      if (action.card.card_type !== 'claim') continue;
      if (action.target_q == null || action.target_r == null) continue;

      const source = findClosestOwnedTile(action.target_q, action.target_r, tiles, activePlayerId);
      if (!source) continue;
      // Skip if claim is on own tile (defensive play, no directional chevron needed)
      const targetKey = `${action.target_q},${action.target_r}`;
      if (tiles[targetKey]?.owner === activePlayerId) continue;

      chevrons.push({
        targetQ: action.target_q, targetR: action.target_r,
        sourceQ: source.q, sourceR: source.r,
        color, alpha: 1,
      });

      // Extra targets (Surge)
      if (action.extra_targets) {
        for (const [eq, er] of action.extra_targets) {
          const es = findClosestOwnedTile(eq, er, tiles, activePlayerId);
          if (!es) continue;
          const ek = `${eq},${er}`;
          if (tiles[ek]?.owner === activePlayerId) continue;
          chevrons.push({
            targetQ: eq, targetR: er,
            sourceQ: es.q, sourceR: es.r,
            color, alpha: 1,
          });
        }
      }
    }
    return chevrons;
  }, [phase, activePlayer?.planned_actions, gameState.grid?.tiles, activePlayerId, findClosestOwnedTile, resolving]);

  // Build chevrons for ALL players' claims during resolve phase (from resolution_steps)
  const resolveChevrons = useMemo((): ClaimChevron[] => {
    if (!resolving || !resolutionSteps.length) return [];
    const cached = resolveChevronCacheRef.current;
    if (!cached.length) return [];

    const chevrons: ClaimChevron[] = [];
    for (const entry of cached) {
      // Per-step alpha: already resolved → 0, currently resolving → fading, pending → full
      let stepAlpha: number;
      if (entry.stepIndex < resolvedUpToStep) {
        stepAlpha = 0;
      } else if (entry.stepIndex === resolvedUpToStep) {
        stepAlpha = chevronAlpha * currentStepFade;
      } else {
        stepAlpha = chevronAlpha;
      }
      if (stepAlpha <= 0) continue;

      chevrons.push({
        targetQ: entry.targetQ, targetR: entry.targetR,
        sourceQ: entry.sourceQ, sourceR: entry.sourceR,
        color: entry.color, alpha: stepAlpha,
      });
    }
    return chevrons;
  }, [resolving, resolutionSteps, chevronAlpha, resolvedUpToStep, currentStepFade]);

  // Active chevrons: play phase or resolve reveal
  const activeChevrons = resolving ? resolveChevrons : planChevrons;

  const playerInfo = useMemo(() => {
    const info: Record<string, { name: string; archetype: string }> = {};
    for (const [pid, p] of Object.entries(gameState.players)) {
      info[pid] = { name: p.name, archetype: p.archetype };
    }
    return info;
  }, [gameState.players]);

  // Build planned action icons map for the active player
  const plannedActions = useMemo(() => {
    if (!activePlayer?.planned_actions) return undefined;
    const map = new Map<string, PlannedActionIcon>();

    const addToMap = (key: string, type: string, power: number, name: string, card: Card) => {
      const existing = map.get(key);
      if (existing) {
        // Stackable: accumulate power from multiple cards on the same tile
        existing.power += power;
        existing.name = `${existing.name} + ${name}`;
        existing.card = card;
      } else {
        map.set(key, { type, power, name, card });
      }
    };

    for (const action of activePlayer.planned_actions) {
      if (action.target_q != null && action.target_r != null) {
        const key = `${action.target_q},${action.target_r}`;
        // Engine cards targeting own tiles (Scorched Retreat, Exodus) get 'abandon' type
        const type = action.card.card_type === 'engine' && action.card.target_own_tile ? 'abandon' : action.card.card_type;
        const effectivePow = action.effective_power ?? action.card.power;
        const power = type === 'defense' ? action.card.defense_bonus : effectivePow;
        addToMap(key, type, power, action.card.name, action.card);

        // Also show defense overlay on extra targets (multi-tile defense like Bulwark)
        if (type === 'defense' && action.extra_targets) {
          for (const [eq, er] of action.extra_targets) {
            const extraKey = `${eq},${er}`;
            addToMap(extraKey, type, action.card.defense_bonus, action.card.name, action.card);
          }
        }
        // Also show claim overlay on extra targets (Surge)
        if (type === 'claim' && action.extra_targets) {
          for (const [eq, er] of action.extra_targets) {
            const extraKey = `${eq},${er}`;
            addToMap(extraKey, type, effectivePow, action.card.name, action.card);
          }
        }
      }
    }
    return map.size > 0 ? map : undefined;
  }, [activePlayer?.planned_actions]);

  // Cards currently placed on the board during play phase (shown as "In Play" in deck viewer)
  // After resolve, these cards move to discard, so only show during play/reveal.
  const inPlayCards = useMemo(() => {
    if (phase !== 'play' && phase !== 'reveal') return [];
    if (!activePlayer?.planned_actions) return [];
    return activePlayer.planned_actions.map(a => a.card);
  }, [activePlayer?.planned_actions, phase]);

  // Full deck breakdown for the Deck viewer button
  const allDeckCards = useMemo(() => {
    if (!activePlayer) return [];
    return [
      ...(inPlayCards.length > 0 ? [{ label: 'In Play', items: inPlayCards }] : []),
      { label: 'In Hand', items: activePlayer.hand },
      { label: 'Draw Pile', items: activePlayer.deck_cards },
      { label: 'Discard Pile', items: activePlayer.discard },
      ...(activePlayer.trash?.length > 0 ? [{ label: 'Trashed', items: activePlayer.trash }] : []),
    ];
  }, [activePlayer, inPlayCards]);


  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1a1a2e', color: '#fff' }}>
      {/* Full-width grid area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div
          ref={gridContainerRef}
          style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}
          onClick={() => {
            if (tileClickedRef.current) { tileClickedRef.current = false; return; }
            setSelectedCardIndex(null);
          }}
        >
          {displayState.grid && (
            <HexGrid
              tiles={displayState.grid.tiles}
              onTileClick={handleTileClick}
              highlightTiles={(() => {
                if (phase !== 'play') return undefined;
                if (surgeCardIndex !== null) {
                  const surgeCard = activePlayer?.hand[surgeCardIndex];
                  const isDefenseMulti = surgeCard?.card_type === 'defense' && (surgeCard?.defense_target_count ?? 1) > 1;
                  if (isDefenseMulti) {
                    const ownTiles = new Set<string>();
                    for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                      if (t.owner === activePlayerId) ownTiles.add(k);
                    }
                    return ownTiles;
                  }
                  return getValidClaimTiles(surgeCard);
                }
                const card = highlightCard?.card_type === 'claim' ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'claim'
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (card) return getValidClaimTiles(card);
                // Defense card: highlight own tiles
                const defCard = highlightCard?.card_type === 'defense' ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'defense'
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (defCard) {
                  const ownTiles = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner === activePlayerId) ownTiles.add(k);
                  }
                  return ownTiles;
                }
                // Player-targeting engine card (e.g. Sabotage, Infestation): highlight opponent tiles
                const ptCard = highlightCard?.card_type === 'engine' && needsOpponentTarget(highlightCard) ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'engine'
                    && needsOpponentTarget(activePlayer?.hand[draggingCardIndex]!)
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (ptCard) {
                  const opponentTiles = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner && t.owner !== activePlayerId) opponentTiles.add(k);
                  }
                  return opponentTiles;
                }
                // Engine cards targeting own tiles (Exodus, Scorched Retreat)
                const ownTileEngCard = highlightCard?.card_type === 'engine' && highlightCard?.target_own_tile ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'engine'
                    && activePlayer?.hand[draggingCardIndex]?.target_own_tile
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (ownTileEngCard) {
                  const ownNonBase = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner === activePlayerId && !t.is_base) ownNonBase.add(k);
                  }
                  return ownNonBase;
                }
                return undefined;
              })()}
              surgeTargets={surgeCardIndex !== null ? [
                ...(surgePrimaryTarget ? [surgePrimaryTarget] : []),
                ...surgeTargets,
              ] : undefined}
              borderTiles={phase === 'play' ? adjacentTiles : undefined}
              playerInfo={playerInfo}
              transformRef={gridTransformRef}
              activePlayerId={phase === 'play' ? activePlayerId : undefined}
              plannedActions={phase === 'play' ? plannedActions : undefined}
              previewCard={phase === 'play' ? (() => {
                const raw = highlightCard?.card_type === 'claim' || highlightCard?.card_type === 'defense' ? highlightCard
                  : (highlightCard?.card_type === 'engine' && (needsOpponentTarget(highlightCard) || highlightCard?.target_own_tile)) ? highlightCard
                  : draggingCardIndex !== null ? activePlayer?.hand[draggingCardIndex] ?? null
                  : null;
                return raw ? withEffectivePower(raw, activePlayer?.hand.length ?? 0, activePlayer?.tile_count ?? 0) : null;
              })() : null}
              previewValidTiles={(() => {
                if (phase !== 'play') return undefined;
                const card = highlightCard?.card_type === 'claim' || highlightCard?.card_type === 'defense' ? highlightCard
                  : (highlightCard?.card_type === 'engine' && (needsOpponentTarget(highlightCard) || highlightCard?.target_own_tile)) ? highlightCard
                  : draggingCardIndex !== null ? activePlayer?.hand[draggingCardIndex] ?? null
                  : null;
                return card ? getAllValidPlayTiles(card) : undefined;
              })()}
              claimChevrons={activeChevrons.length > 0 ? activeChevrons : undefined}
              vpPaths={vpPaths.length > 0 ? vpPaths : undefined}
              connectedVpTiles={connectedVpTiles}
              buildProgress={gridBuildProgress}
              disableHover={!!(showIntro || gridBuildProgress !== undefined || showFullLog || showDeckViewer || showCardBrowser || showShopOverlay || showUpgradePreview || (phaseBanner && !reviewing) || resolving || (draggingCardIndex !== null && (() => { const dc = activePlayer?.hand[draggingCardIndex]; return dc?.card_type === 'engine' && !needsOpponentTarget(dc!) && !dc?.target_own_tile; })()))}
              reviewPulseTiles={reviewPulseTiles}
              onTileHover={reviewing ? (q, r, sx, sy) => {
                setReviewHoveredTile(`${q},${r}`);
                setReviewTilePopupPos({ x: sx, y: sy });
              } : undefined}
              onTileHoverEnd={reviewing ? () => setReviewHoveredTile(null) : undefined}
            />
          )}

          {/* ── Top-left overlay: round info + upkeep + expandable player panel ── */}
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 210, width: 'fit-content', opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease', pointerEvents: hudVisible ? 'auto' : 'none' }}>
            {/* Round / Phase / VP target */}
            <div style={{
              background: 'rgba(10, 10, 20, 0.85)',
              borderRadius: 8,
              padding: '8px 14px',
              marginBottom: 6,
              backdropFilter: 'blur(4px)',
              border: '1px solid #333',
              width: 'fit-content',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: 16, fontWeight: 'bold', color: '#fff' }}>
                  Round {gameState.current_round}
                </span>
                <PhaseIndicatorPill phase={phase} />
              </div>
              <div style={{ fontSize: 12, color: '#aaa' }}>
                ★ {gameState.vp_target} VP to win
                {gameState.max_rounds && (
                  <Tooltip content={`Game ends after round ${gameState.max_rounds}. Starting on round 5, the leading player will receive a Debt card each round.`} position="below">
                    <span style={{ marginLeft: 8, cursor: 'help' }}>⏱ {gameState.current_round}/{gameState.max_rounds}</span>
                  </Tooltip>
                )}
              </div>
              {gameState.winner && (
                <div style={{
                  marginTop: 4, padding: '4px 8px', background: '#4a9eff33', borderRadius: 6, fontWeight: 'bold',
                  fontSize: 13,
                }}>
                  {gameState.winners && gameState.winners.length > 1
                    ? `★ Tied: ${gameState.winners.map(id => gameState.players[id]?.name).join(', ')}!`
                    : `★ ${gameState.players[gameState.winner]?.name} wins!`}
                </div>
              )}
            </div>

            {/* Expandable player panel */}
            <div
              onMouseEnter={() => setPlayerPanelExpanded(true)}
              onMouseLeave={() => setPlayerPanelExpanded(false)}
              style={{
                background: 'rgba(10, 10, 20, 0.85)',
                borderRadius: 8,
                border: '1px solid #333',
                backdropFilter: 'blur(4px)',
                transition: 'all 0.2s ease',
                width: 200,
                maxHeight: 'calc(100vh - 300px)',
                overflowY: 'auto',
              }}
            >
              {(playerPanelExpanded || forcePlayerPanelExpanded || reviewing || phase === 'buy' || anyPlayerReachedVp) ? (
                /* Expanded: all players */
                <div style={{ padding: 6 }}>
                  {gameState.player_order.map((pid, i) => {
                    const p = gameState.players[pid];
                    const pInPlay = phase === 'play' ? (p.planned_action_count ?? 0) : 0;
                    const pTotal = p.hand_count + p.deck_size + p.discard_count + pInPlay;
                    const pTiles = Object.values(gameState.grid.tiles).filter(t => t.owner === pid).length;
                    const isCpu = p.is_cpu;
                    const isClickable = !isCpu && (localPlayerIds.length === 0 || localPlayerIds.includes(pid));
                    return (
                      <div
                        key={pid}
                        ref={el => { if (el) playerRowRefs.current.set(pid, el); }}
                        onClick={() => {
                          if (reviewing && revealedActionsRef.current?.[pid]?.length) {
                            const actions = revealedActionsRef.current[pid];
                            const name = gameState.players[pid]?.name ?? pid;
                            setReviewHoveredPlayer(null);
                            setReviewFullCards(actions.map(a => ({ playerId: pid, playerName: name, card: a.card })));
                          } else if (isClickable) {
                            handleSwitchPlayer(i);
                          }
                        }}
                        onPointerEnter={reviewing ? () => setReviewHoveredPlayer(pid) : undefined}
                        onPointerLeave={reviewing ? () => setReviewHoveredPlayer(null) : undefined}
                        style={{ cursor: isClickable ? 'pointer' : 'default', marginBottom: i < gameState.player_order.length - 1 ? 4 : 0, opacity: isCpu ? 0.8 : 1, position: 'relative' }}
                      >
                        <PlayerHud
                          player={p}
                          isActive={i === activePlayerIndex}
                          isCurrent={i === activePlayerIndex}
                          isFirstPlayer={i === gameState.first_player_index}
                          isCurrentBuyer={phase === 'buy' && pid === gameState.current_buyer_id}
                          phase={phase}
                          totalCards={pTotal}
                          tileCount={pTiles}
                          purchases={phase === 'buy' ? enrichPurchases(gameState.buy_phase_purchases?.[pid]) : undefined}
                          onPurchaseHover={phase === 'buy' ? handlePurchaseHover : undefined}
                          onPurchaseLeave={phase === 'buy' ? handlePurchaseLeave : undefined}
                          vpTarget={gameState.vp_target}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* Collapsed: active player only */
                <div style={{ padding: 6 }}>
                  {activePlayer && (() => {
                    const pInPlay = phase === 'play' ? (activePlayer.planned_action_count ?? 0) : 0;
                    const pTotal = activePlayer.hand_count + activePlayer.deck_size + activePlayer.discard_count + pInPlay;
                    return (
                      <PlayerHud
                        player={activePlayer}
                        isActive={true}
                        isCurrent={true}
                        isFirstPlayer={activePlayerIndex === gameState.first_player_index}
                        isCurrentBuyer={phase === 'buy' && activePlayerId === gameState.current_buyer_id}
                        phase={phase}
                        totalCards={pTotal}
                        tileCount={playerTileCount}
                        purchases={phase === 'buy' ? enrichPurchases(gameState.buy_phase_purchases?.[activePlayerId]) : undefined}
                        onPurchaseHover={phase === 'buy' ? handlePurchaseHover : undefined}
                        onPurchaseLeave={phase === 'buy' ? handlePurchaseLeave : undefined}
                        vpTarget={gameState.vp_target}
                      />
                    );
                  })()}
                </div>
              )}
            </div>

            {/* In Play card list — shown during play phase when active player has played cards */}
            {phase === 'play' && activePlayer && activePlayer.planned_actions.length > 0 && !resolving && !showIntro && introSequence === 'done' && (() => {
              const COL_W = 134;
              const PAD = 6;
              const actions = activePlayer.planned_actions;
              const GAP = 4;
              return (
                <div
                  ref={inPlayContainerRef}
                  className="in-play-list"
                  style={{
                    marginTop: 6,
                    background: 'rgba(10, 10, 20, 0.85)',
                    borderRadius: 8,
                    border: '1px solid #333',
                    backdropFilter: 'blur(4px)',
                    padding: PAD,
                    width: COL_W + PAD * 2 + 2, // card width + padding + border
                    maxHeight: 'calc(100vh - 420px)',
                    overflowY: 'auto',
                    boxSizing: 'border-box',
                  }}
                >
                  <style>{`
                    .in-play-list::-webkit-scrollbar { width: 4px; }
                    .in-play-list::-webkit-scrollbar-track { background: transparent; }
                    .in-play-list::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
                    .in-play-list { scrollbar-width: thin; scrollbar-color: #555 transparent; }
                  `}</style>
                  <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                    In Play ({actions.length})
                  </div>
                  <div style={{
                    columnWidth: COL_W,
                    columnGap: GAP,
                  }}>
                    {actions.map((action, i) => {
                      const c = action.effective_power != null ? { ...action.card, power: action.effective_power } : action.card;
                      const typeColor = getCardDisplayColor(c);
                      const ctx: CardSubtitleContext = { ...frozenSubtitleContext, effectiveResourceGain: action.effective_resource_gain, effectiveDrawCards: action.effective_draw_cards };
                      const statParts = buildCardSubtitle(c, ctx);
                      return (
                        <div
                          key={i}
                          onPointerEnter={() => setInPlayHoverIndex(i)}
                          onPointerLeave={() => setInPlayHoverIndex(null)}
                          style={{
                            width: COL_W,
                            padding: '3px 6px',
                            background: '#2a2a3e',
                            border: `1px solid ${typeColor}`,
                            borderRadius: 5,
                            color: '#fff',
                            marginBottom: GAP,
                            breakInside: 'avoid' as const,
                            cursor: 'default',
                            transition: 'background 0.1s',
                            ...(inPlayHoverIndex === i ? { background: '#3a3a5e' } : {}),
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <div style={{ fontWeight: 'bold', fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {c.name}
                            </div>
                          </div>
                          <div style={{ fontSize: 11, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                            <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
                              if (el) {
                                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                                el.style.setProperty('--sub-scale', String(scale));
                              }
                            }}>
                              {statParts.map((part, j) => renderSubtitlePart(part, j))}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* In Play hover preview — CardFull popup to the right */}
            {inPlayHoverIndex !== null && activePlayer && activePlayer.planned_actions[inPlayHoverIndex] && inPlayContainerRef.current && (() => {
              const action = activePlayer.planned_actions[inPlayHoverIndex];
              const c = action.effective_power != null ? { ...action.card, power: action.effective_power } : action.card;
              const containerRect = inPlayContainerRef.current!.getBoundingClientRect();
              return createPortal(
                <div style={{
                  position: 'fixed',
                  left: containerRect.right + 12,
                  top: Math.min(containerRect.top, window.innerHeight - 320),
                  width: 220,
                  zIndex: 20000,
                  pointerEvents: 'none',
                }}>
                  <CardFull card={c} showKeywordHints />
                </div>,
                document.body
              );
            })()}
          </div>

          {/* Purchase pill hover preview (fixed, portal) */}
          {purchaseHover && createPortal(
            <div style={{
              position: 'fixed',
              left: purchaseHover.rect.right + 12,
              top: Math.min(
                purchaseHover.rect.top + purchaseHover.rect.height / 2 - 150,
                window.innerHeight - 320,
              ),
              width: 220,
              zIndex: 20000,
              pointerEvents: 'none',
              opacity: purchaseHoverVisible ? 1 : 0,
              transition: 'opacity 0.15s ease',
            }}>
              <CardFull card={purchaseHover.card} showKeywordHints />
            </div>,
            document.body
          )}

          {/* ── Top-right: action buttons + gear ── */}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: narrowTop ? 'column' : 'row', gap: 8, alignItems: narrowTop ? 'flex-end' : 'flex-start', zIndex: 210, opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease', pointerEvents: hudVisible ? 'auto' : 'none' }}>
            <button
              className="hud-btn"
              onClick={() => { setShowCardBrowser(true); setShowDeckViewer(false); setShowShopOverlay(false); }}
              style={{
                padding: '6px 14px',
                background: '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 6,
                color: '#fff',
                fontSize: 13,
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              <span style={{ textDecoration: 'underline' }}>C</span>ards
            </button>
            <button
              className="hud-btn"
              onClick={() => { setShowDeckViewer(s => !s); setShowShopOverlay(false); }}
              style={{
                padding: '6px 14px',
                background: '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 6,
                color: '#fff',
                fontSize: 13,
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              <span style={{ textDecoration: 'underline' }}>D</span>eck
            </button>
            <button
              className="hud-btn"
              onClick={() => { setShowShopOverlay(s => !s); setShowDeckViewer(false); }}
              style={{
                padding: '6px 14px',
                background: '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 6,
                color: '#fff',
                fontSize: 13,
                fontWeight: 'bold',
                cursor: 'pointer',
                borderColor: phase === 'buy' && !phaseBanner && !showShopOverlay && !activePlayer?.has_ended_turn ? '#4a9eff' : '#555',
                ...(phase === 'buy' && !phaseBanner && !showShopOverlay && !activePlayer?.has_ended_turn ? {
                  animation: animationMode !== 'off' ? 'shopPulse 2s ease-in-out infinite' : undefined,
                  boxShadow: '0 0 12px rgba(74, 158, 255, 0.6)',
                } : {}),
              }}
            >
              <span style={{ textDecoration: 'underline' }}>S</span>hop
            </button>

            {/* Gear icon dropdown */}
            <div ref={settingsRef} style={{ position: 'relative', order: narrowTop ? -1 : undefined }}>
              <button
                className="hud-btn"
                onClick={() => setSettingsExpanded(p => !p)}
                style={{
                  padding: '6px 14px', borderRadius: 6,
                  background: settingsExpanded ? '#3a3a6e' : '#2a2a3e',
                  border: '1px solid #555', color: '#aaa',
                  cursor: 'pointer', fontSize: 13, lineHeight: '1',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxSizing: 'border-box',
                }}
                title="Settings"
              >
                <span style={{ fontSize: 16, lineHeight: '1' }}>⚙</span>
              </button>
              {settingsExpanded && (
                <div style={{
                  position: 'absolute', top: 42, right: 0,
                  background: '#1e1e36', border: '1px solid #444',
                  borderRadius: 8, padding: 12, minWidth: 240,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
                }}>
                  <SettingsPanel
                    isMultiplayer={isMultiplayer}
                    isHost={mpIsHost}
                    mapSeed={gameState.map_seed}
                    onLeaveGame={isMultiplayer && onLeaveGame ? async () => {
                      if (mpPlayerId && mpToken) {
                        try { await import('../api/client').then(api => api.leaveGame(gameState.id, mpPlayerId, mpToken)); } catch (e) { console.warn('leaveGame failed:', e); }
                      }
                      onLeaveGame();
                    } : undefined}
                    onEndGame={isMultiplayer && mpIsHost && onLeaveGame ? async () => {
                      if (mpPlayerId && mpToken) {
                        try { await import('../api/client').then(api => api.endGame(gameState.id, mpPlayerId, mpToken)); } catch { /* ignore */ }
                      }
                      onLeaveGame();
                    } : undefined}
                  />
                  <button
                    onClick={() => { setShowFullLog(true); setSettingsExpanded(false); }}
                    style={{
                      width: '100%', padding: '6px 0', marginTop: 8,
                      background: '#2a2a3e', border: '1px solid #444',
                      borderRadius: 4, color: '#aaa', fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    Full Game Log
                  </button>

                  {/* Test Mode Panel */}
                  {gameState.test_mode && (
                    <div style={{ borderTop: '1px solid #ffaa4a44', marginTop: 8, paddingTop: 8 }}>
                      <div
                        onClick={() => setShowTestPanel(p => !p)}
                        style={{ fontSize: 12, color: '#ffaa4a', cursor: 'pointer', fontWeight: 'bold', marginBottom: 4 }}
                      >
                        {showTestPanel ? '▾' : '▸'} Test Mode
                      </div>
                      {showTestPanel && (
                        <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Give card to {activePlayer?.name}:</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input value={testCardId} onChange={e => setTestCardId(e.target.value)} placeholder="card_id"
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testCardId) handleTestGiveCard(testCardId); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>Give</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Set {activePlayer?.name} VP:</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="number" value={testVp} onChange={e => setTestVp(e.target.value)} placeholder={String(activePlayer?.vp ?? 0)}
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testVp !== '') handleTestSetStats(Number(testVp), undefined); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}>Set</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Set {activePlayer?.name} Resources:</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="number" value={testResources} onChange={e => setTestResources(e.target.value)} placeholder={String(activePlayer?.resources ?? 0)}
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testResources !== '') handleTestSetStats(undefined, Number(testResources)); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}>Set</button>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              onClick={handleTestDrawCard}
                              style={{ flex: 1, padding: '4px 8px', background: '#4488aa', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', marginTop: 4 }}
                            >
                              Draw Card
                            </button>
                            <button
                              onClick={handleTestDiscardHand}
                              style={{ flex: 1, padding: '4px 8px', background: '#aa6633', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', marginTop: 4 }}
                            >
                              Discard Hand
                            </button>
                          </div>
                          <button
                            onClick={() => setShowGameOver(true)}
                            style={{ padding: '4px 8px', background: '#8844aa', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', marginTop: 4 }}
                          >
                            Trigger Game Over
                          </button>
                          <button
                            onClick={() => {
                              setTestShuffleAnim(true);
                              setTimeout(() => setTestShuffleAnim(false), 2500);
                            }}
                            disabled={testShuffleAnim}
                            style={{ padding: '4px 8px', background: testShuffleAnim ? '#555' : '#4488aa', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: testShuffleAnim ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                          >
                            {testShuffleAnim ? 'Shuffling...' : 'Play Shuffling'}
                          </button>
                          <button
                            onClick={() => {
                              if (animationOff) return;
                              setShowIntro(true);
                              setIntroSequence('overlay');
                              setHudVisible(false);
                              setGridBuildProgress(0);
                              setBannerLabelOverride(null);
                              setPhaseBanner(null);
                              setInteractionBlocked(true);
                            }}
                            disabled={showIntro || animationOff}
                            style={{ padding: '4px 8px', background: (showIntro || animationOff) ? '#555' : '#44aa88', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: (showIntro || animationOff) ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                          >
                            Replay Intro
                          </button>
                          <button
                            onClick={() => {
                              if (animationOff || phaseBanner) return;
                              // Pick a random non-left player as the debt recipient
                              const candidates = gameState.player_order.filter(pid => !gameState.players[pid].has_left);
                              const recipientId = candidates[Math.floor(Math.random() * candidates.length)];
                              const recipientName = gameState.players[recipientId].name;
                              testDebtRecipientRef.current = { id: recipientId, name: recipientName };
                              testDebtBannerRef.current = true;
                              const maxRounds = gameState.max_rounds ?? 20;
                              setBannerLabelOverride(`Round ${gameState.current_round} of ${maxRounds}`);
                              setBannerSubtitle(`Debt given to ${recipientName}`);
                              setBannerHoldUntilRelease(true);
                              setPhaseBanner('upkeep');
                              setBannerKey(k => k + 1);
                              setInteractionBlocked(true);
                            }}
                            disabled={animationOff || !!phaseBanner}
                            style={{ padding: '4px 8px', background: (animationOff || phaseBanner) ? '#555' : '#cc6622', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: (animationOff || phaseBanner) ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                          >
                            Give Debt
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Shop overlay — available at any phase, purchasing disabled outside buy phase */}
          {showShopOverlay && activePlayer && (
            <ShopOverlay
              archetypeMarket={activePlayer.archetype_market}
              neutralMarket={gameState.neutral_market}
              playerResources={activePlayer.resources}
              playerArchetype={activePlayer.archetype}
              onBuyArchetype={handleBuyArchetype}
              onBuyNeutral={handleBuyNeutral}
              onBuyUpgrade={handleBuyUpgrade}
              onReroll={handleReroll}
              disabled={phase !== 'buy' || activePlayerId !== gameState.current_buyer_id}
              onClose={() => setShowShopOverlay(false)}
              testMode={!!gameState.test_mode}
              effectiveBuyCosts={activePlayer?.effective_buy_costs}
              neutralPurchasesLastRound={gameState.neutral_purchases_last_round}
              currentPlayerId={activePlayerId}
              buyPhasePurchases={gameState.buy_phase_purchases}
              players={gameState.players}
            />
          )}

          {/* Toasts — floating above the hand panel */}
          <div style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, zIndex: 20, pointerEvents: 'none' }}>
            {error && (
              <div style={{
                fontSize: 13,
                padding: '6px 16px',
                background: '#ff4a4a22',
                border: '1px solid #ff4a4a55',
                borderRadius: 6,
                color: '#ff4a4a',
                whiteSpace: 'nowrap',
              }}>
                {error}
              </div>
            )}
          </div>

          {/* Bottom bar: buttons (right) */}
          <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12, display: 'flex', alignItems: 'center', gap: 8, zIndex: 20, minHeight: 34, opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease' }}>
            <div style={{ flex: 1 }} />
            {/* Buttons — right aligned */}
            {/* Test-mode Discard & Trash buttons */}
            {gameState.test_mode && phase === 'play' && activePlayer && !resolving &&
              selectedCard && selectedCardIndex !== null && surgeCardIndex === null && (
              <>
                <button
                  onClick={() => handleTestDiscardCard(selectedCardIndex)}
                  style={{
                    padding: '6px 16px',
                    background: '#666',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                  title="Test mode: discard this card to your discard pile"
                >
                  Discard
                </button>
                <button
                  onClick={() => handleTestTrashCard(selectedCardIndex)}
                  style={{
                    padding: '6px 16px',
                    background: '#aa3333',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                  title="Test mode: permanently trash this card"
                >
                  🗑 Trash
                </button>
              </>
            )}
            {/* Upgrade button — shown when a card is selected during play phase */}
            {phase === 'play' && activePlayer && !resolving && selectedCard && selectedCardIndex !== null &&
              !selectedCard.is_upgraded && hasUpgradePreview(selectedCard) &&
              (activePlayer.upgrade_credits > 0 || gameState.test_mode) && surgeCardIndex === null && !trashMode && (
              <div
                style={{ position: 'relative', display: 'inline-block' }}
                onMouseEnter={() => setShowUpgradePreview(true)}
                onMouseLeave={() => setShowUpgradePreview(false)}
              >
                {showUpgradePreview && (
                  <div style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    marginBottom: 8,
                    zIndex: 100,
                    pointerEvents: 'none',
                  }}>
                    <CardFull card={getUpgradedPreview(selectedCard)} />
                  </div>
                )}
                <button
                  onClick={() => handleUpgradeCard(selectedCardIndex)}
                  disabled={activePlayer.upgrade_credits < 1 && !gameState.test_mode}
                  style={{
                    padding: '6px 16px',
                    background: (activePlayer.upgrade_credits > 0 || gameState.test_mode) ? '#7a4acc' : '#555',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: (activePlayer.upgrade_credits > 0 || gameState.test_mode) ? 'pointer' : 'not-allowed',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  Upgrade ({gameState.test_mode && activePlayer.upgrade_credits === 0 ? '∞' : activePlayer.upgrade_credits})
                </button>
              </div>
            )}
            {phase === 'play' && activePlayer && !resolving && selectedCard?.card_type === 'engine' && !needsOpponentTarget(selectedCard) && !selectedCard?.target_own_tile && surgeCardIndex === null && !trashMode && (
              <IrreversibleButton
                onClick={handlePlayEngine}
                tooltip="Playing a card uses an action and cannot be undone."
                style={{
                  padding: '6px 16px',
                  background: '#4a9eff',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  fontSize: 13,
                  lineHeight: '1.2',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                Play {selectedCard.name}
              </IrreversibleButton>
            )}
            {/* Multi-target confirm/cancel (Surge or Defense) */}
            {phase === 'play' && surgeCardIndex !== null && surgePrimaryTarget && (() => {
              const surgeCard = activePlayer?.hand[surgeCardIndex];
              const isDefenseMulti = surgeCard?.card_type === 'defense' && (surgeCard?.defense_target_count ?? 1) > 1;
              const maxTotal = isDefenseMulti
                ? (surgeCard?.defense_target_count ?? 1)
                : 1 + (surgeCard?.multi_target_count ?? 0);
              const label = isDefenseMulti ? 'Defend' : 'Surge';
              return (
                <>
                  <span style={{ fontSize: 12, color: '#aaa' }}>
                    {label}: {1 + surgeTargets.length}/{maxTotal} tiles selected
                  </span>
                  <button
                    onClick={handleCancelSurge}
                    style={{
                      padding: '6px 16px',
                      background: '#555',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: '1.2',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    }}
                  >
                    Cancel
                  </button>
                  <IrreversibleButton
                    onClick={handleConfirmSurge}
                    tooltip={`Confirm all selected tiles for this ${label} card.`}
                    style={{
                      padding: '6px 16px',
                      background: '#4a9eff',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: '1.2',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    }}
                  >
                    Confirm {label}
                  </IrreversibleButton>
                </>
              );
            })()}
            {/* Trash/Discard selection confirm/cancel */}
            {phase === 'play' && trashMode && (() => {
              const card = activePlayer?.hand[trashMode.cardIndex];
              const count = trashSelectedIndices.size;
              const canConfirm = count >= trashMode.minCards && count <= trashMode.maxCards;
              const isOptional = trashMode.minCards === 0;
              return (
                <>
                  <span style={{ fontSize: 12, color: '#aaa' }}>
                    {trashMode.label}: {count}/{trashMode.maxCards} card{trashMode.maxCards !== 1 ? 's' : ''} selected
                    {isOptional && <span style={{ color: '#888' }}> (optional)</span>}
                  </span>
                  {!trashMode.pendingDiscard && (
                  <button
                    onClick={handleCancelTrash}
                    style={{
                      padding: '6px 16px',
                      background: '#555',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: '1.2',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    }}
                  >
                    Cancel
                  </button>
                  )}
                  <IrreversibleButton
                    onClick={handleConfirmTrash}
                    disabled={!canConfirm}
                    tooltip={`Confirm ${trashMode.label.toLowerCase()} selection for ${card?.name ?? 'card'}.`}
                    style={{
                      padding: '6px 16px',
                      background: canConfirm ? '#ff4444' : '#555',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      fontWeight: 'bold',
                      cursor: canConfirm ? 'pointer' : 'not-allowed',
                      fontSize: 13,
                      lineHeight: '1.2',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                      opacity: canConfirm ? 1 : 0.5,
                    }}
                  >
                    Confirm {trashMode.label}
                  </IrreversibleButton>
                </>
              );
            })()}
            {phase === 'play' && !resolving && !phaseBanner && !showIntro && introSequence === 'done' && activePlayer && !activePlayer.has_submitted_play && activePlayerEffects.length === 0 && surgeCardIndex === null && !trashMode && (
              <div style={{
                opacity: submitButtonVisible ? 1 : 0,
                transition: 'opacity 0.4s ease-in',
              }}>
                <HoldToSubmitButton
                  ref={submitPlayRef}
                  key={activePlayerId}
                  onConfirm={handleSubmitPlay}
                  requireHold={submitCanStillPlay}
                  warning={`You still have ${activePlayer.hand.length} card(s) and ${submitActionsLeft} action(s) remaining.`}
                  tooltip="Submitting locks your play for this round. You cannot change it after."
                  style={{
                    padding: '6px 16px',
                    background: submitCanStillPlay ? '#ff8844' : '#2a9a3e',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  Submit Play{submitCanStillPlay ? ' →' : ' ✓'}
                </HoldToSubmitButton>
              </div>
            )}
            {resolving && (
              <button
                disabled
                style={{
                  padding: '6px 16px',
                  background: '#555',
                  border: 'none',
                  borderRadius: 6,
                  color: '#aaa',
                  fontWeight: 'bold',
                  cursor: 'not-allowed',
                  fontSize: 13,
                  lineHeight: '1.2',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                Resolving...
              </button>
            )}
            {reviewing && !resolving && (
              <button
                onClick={handleDoneReviewing}
                style={{
                  padding: '6px 16px',
                  background: '#2aaa4a',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  fontSize: 13,
                  lineHeight: '1.2',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                Done Reviewing ✓
              </button>
            )}
            {phase === 'buy' && activePlayer && !resolving && !phaseBanner && activePlayerEffects.length === 0 && activePlayerId === gameState.current_buyer_id && !activePlayer.has_ended_turn && (
              <div style={{ opacity: buyButtonVisible ? 1 : 0, transition: 'opacity 0.4s ease-in' }}>
                <HoldToSubmitButton
                  ref={endTurnRef}
                  onConfirm={handleEndTurn}
                  requireHold={true}
                  warning="Done buying passes the shop to the next player. Any unspent resources carry over."
                  style={{
                    padding: '6px 16px',
                    background: '#ff8844',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  Done Buying →
                </HoldToSubmitButton>
              </div>
            )}
            {phase === 'buy' && activePlayer && !resolving && !phaseBanner && activePlayerEffects.length === 0 && activePlayer.has_ended_turn && (
              <div style={{ opacity: buyButtonVisible ? 1 : 0, transition: 'opacity 0.4s ease-in' }}>
                <button
                  disabled
                  style={{
                    padding: '6px 16px',
                    background: '#555',
                    border: 'none',
                    borderRadius: 6,
                    color: '#aaa',
                    fontWeight: 'bold',
                    cursor: 'not-allowed',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  ✓ Done Buying
                </button>
              </div>
            )}
            {/* Multiplayer: waiting for other players indicator */}
            {isMultiplayer && activePlayer && (
              (phase === 'play' && activePlayer.has_submitted_play && !resolving) ||
              (phase === 'reveal' && activePlayer.has_acknowledged_resolve && !resolving && !phaseBanner)
            ) && (
              <div style={{
                padding: '4px 12px',
                background: 'rgba(74, 158, 255, 0.15)',
                border: '1px solid rgba(74, 158, 255, 0.3)',
                borderRadius: 6,
                color: '#4a9eff',
                fontSize: 12,
                fontWeight: 'bold',
                animation: 'pulse 2s ease-in-out infinite',
              }}>
                Waiting for other players...
              </div>
            )}
            {/* Sequential buy: waiting for current buyer */}
            {phase === 'buy' && activePlayer && activePlayer.has_ended_turn && activePlayerId !== gameState.current_buyer_id && !phaseBanner && (() => {
              const buyerId = gameState.current_buyer_id;
              const buyerName = buyerId ? gameState.players[buyerId]?.name : null;
              return buyerName ? (
                <div style={{ opacity: buyButtonVisible ? 1 : 0, transition: 'opacity 0.4s ease-in' }}>
                  <div style={{
                    padding: '4px 12px',
                    background: 'rgba(255, 170, 74, 0.15)',
                    border: '1px solid rgba(255, 170, 74, 0.3)',
                    borderRadius: 6,
                    color: '#ffaa4a',
                    fontSize: 12,
                    fontWeight: 'bold',
                    animation: 'pulse 2s ease-in-out infinite',
                  }}>
                    Waiting for {buyerName} to buy...
                  </div>
                </div>
              ) : null;
            })()}
          </div>
        </div>

        {/* Action counter — above hand panel (only when submit button is visible) */}
        {phase === 'play' && activePlayer && !resolving && !phaseBanner && !showIntro && !activePlayer.has_submitted_play && introSequence === 'done' && (
          <div style={{ position: 'relative', zIndex: 30 }}>
            <div
              className="action-counter-wrap"
              style={{
                position: 'absolute', bottom: 4, left: 12,
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 14px',
                background: 'rgba(26, 26, 46, 0.85)',
                border: `1px solid ${submitActionsLeft > 0 ? '#4a9eff44' : '#33333366'}`,
                borderRadius: 8,
              }}
            >
              <style>{`
                .action-counter-wrap .action-counter-tip {
                  opacity: 0;
                  transition: opacity 0.15s ease;
                  pointer-events: none;
                }
                .action-counter-wrap:hover .action-counter-tip {
                  opacity: 1;
                }
              `}</style>
              <div className="action-counter-tip" style={{
                position: 'absolute', bottom: '100%', left: 0,
                paddingBottom: 8,
              }}>
                <div style={{
                  padding: '4px 10px',
                  background: '#111122',
                  border: '1px solid #555',
                  borderRadius: 6,
                  color: '#ccc',
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                }}>
                  Playing a card costs 1 action.
                </div>
              </div>
              <span style={{
                fontSize: 22, fontWeight: 'bold',
                color: submitActionsLeft > 0 ? '#fff' : '#555',
                textShadow: submitActionsLeft > 0 ? '0 0 8px rgba(74, 158, 255, 0.4)' : 'none',
              }}>
                ⚡ {submitActionsLeft}
              </span>
              <span style={{ fontSize: 13, color: submitActionsLeft > 0 ? '#aaa' : '#555' }}>
                action{submitActionsLeft !== 1 ? 's' : ''} left
              </span>
            </div>
          </div>
        )}

        {/* Bottom panel: hand */}
        <div style={{ padding: '8px 12px', flexShrink: 0, overflow: 'visible', position: 'relative', zIndex: 30, opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease' }}>
          {/* Drag hint tooltip — right above the card hand */}
          {showDragHint && (
            <div style={{
              position: 'absolute',
              top: -24,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 35,
              pointerEvents: 'none',
              animation: 'dragHintFadeIn 0.6s ease-out both',
            }}>
              <style>{`
                @keyframes dragHintFadeIn {
                  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
                  to { opacity: 1; transform: translateX(-50%) translateY(0); }
                }
              `}</style>
              <span style={{
                background: 'rgba(10, 10, 30, 0.9)',
                border: '1px solid #555',
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 12,
                color: '#aaa',
                whiteSpace: 'nowrap',
              }}>
                Drag a card to the grid to play it.
              </span>
            </div>
          )}
          {activePlayer && introSequence !== 'overlay' && introSequence !== 'hud_fadein' && introSequence !== 'grid_build' && (
            <CardHand
              playerId={activePlayerId}
              cards={introSequence === 'shuffle' ? [] : activePlayer.hand}
              selectedIndex={selectedCardIndex}
              onSelect={(idx) => { setSelectedCardIndex(idx); }}
              onDragPlay={handleDragPlay}
              onDoubleClick={isMobile ? undefined : (idx) => {
                if (trashMode) return; // disable double-click during trash/discard selection
                const card = activePlayer?.hand[idx];
                if (card?.card_type === 'engine' && !needsOpponentTarget(card) && !card.target_own_tile) playCardNoTarget(idx);
              }}
              onDragStart={setDraggingCardIndex}
              onDragEnd={() => setDraggingCardIndex(null)}
              disabled={phase !== 'play' || activePlayer.has_submitted_play || interactionBlocked}
              deckSize={activePlayer.deck_size}
              discardCount={activePlayer.discard_count}
              discardCards={activePlayer.discard}
              deckCards={activePlayer.deck_cards}
              inPlayCards={inPlayCards}
              discardAll={discardingAll}
              onDiscardAllComplete={handleDiscardAllComplete}
              lastPlayedTarget={lastPlayedTarget}
              forceShuffleAnim={introSequence === 'shuffle' || testShuffleAnim}
              trashMode={trashMode ? {
                playedCardIndex: trashMode.cardIndex,
                selectedIndices: trashSelectedIndices,
                minCards: trashMode.minCards,
                maxCards: trashMode.maxCards,
                label: trashMode.label,
              } : null}
              onTrashToggle={handleTrashToggle}
              subtitleContext={subtitleContext}
              closePopups={showShopOverlay || showCardBrowser || showDeckViewer}
              trashedCardIds={trashedCardIds.size > 0 ? trashedCardIds : undefined}
              claimBanned={!!gameState.claim_ban_rounds && gameState.claim_ban_rounds > 0}
              onCardHover={setHoveredCardIndex}
            />
          )}
        </div>
      </div>

      {/* Full game log modal */}
      {showFullLog && (
        <FullGameLog
          gameId={gameState.id}
          playerId={activePlayerId}
          onClose={() => setShowFullLog(false)}
        />
      )}

      {/* Deck viewer modal */}
      {showDeckViewer && (
        <CardViewPopup
          title="Your Full Deck"
          cards={allDeckCards}
          onClose={() => setShowDeckViewer(false)}
        />
      )}
      {showCardBrowser && (() => {
        const pack = cardPackDefs.find(p => p.id === (gameState.card_pack || 'everything'));
        return (
          <CardBrowser
            onClose={() => setShowCardBrowser(false)}
            packNeutralIds={pack?.neutral_card_ids}
            packArchetypeIds={pack?.archetype_card_ids}
            packName={pack?.name}
            onShiftClickCard={gameState.test_mode ? handleTestGiveCard : undefined}
          />
        );
      })()}

      {/* Resolve overlay — power numbers over grid */}
      {resolving && resolutionSteps.length > 0 && !phaseBanner && !chevronRevealPhase && (
        <ResolveOverlay
          steps={resolutionSteps}
          gridTransform={gridTransformSnapshot}
          gridRect={gridRect}
          onStepApply={applyResolveStep}
          onComplete={handleResolveComplete}
        />
      )}

      {/* Review mode: tile hover popup showing cards played on this tile */}
      {reviewing && reviewHoveredTile && reviewTilePopupPos && reviewTileCards?.has(reviewHoveredTile) && (() => {
        const cards = reviewTileCards.get(reviewHoveredTile)!;
        const POPUP_W = 180;
        const left = Math.min(reviewTilePopupPos.x + 16, window.innerWidth - POPUP_W - 12);
        const top = Math.min(reviewTilePopupPos.y - 20, window.innerHeight - cards.length * 70 - 20);
        const REVIEW_TYPE_COLORS = CARD_TYPE_COLORS;
        const REVIEW_EMOJI: Record<string, string> = { claim: '⚔️', defense: '🛡️', engine: '⚙️', passive: '📜' };
        return (
          <div style={{
            position: 'fixed',
            left,
            top: Math.max(8, top),
            zIndex: 500,
            background: 'rgba(15, 15, 30, 0.95)',
            border: '1px solid #555',
            borderRadius: 8,
            padding: 8,
            width: POPUP_W,
            pointerEvents: 'none',
          }}>
            {cards.map((entry, i) => {
              const playerColor = (() => {
                const n = PLAYER_COLORS[entry.playerId];
                return n != null ? `#${n.toString(16).padStart(6, '0')}` : '#888';
              })();
              const typeColor = REVIEW_TYPE_COLORS[entry.card.card_type] || '#555';
              const c = entry.effectivePower != null ? { ...entry.card, power: entry.effectivePower } : entry.card;
              const ctx: CardSubtitleContext = { ...frozenSubtitleContext, effectiveResourceGain: entry.effectiveResourceGain, effectiveDrawCards: entry.effectiveDrawCards };
              const statParts = buildCardSubtitle(c, ctx);
              return (
                <div key={i} style={{ marginBottom: i < cards.length - 1 ? 6 : 0 }}>
                  <div style={{ fontSize: 10, color: playerColor, fontWeight: 'bold', marginBottom: 2 }}>
                    {entry.playerName}
                  </div>
                  <div style={{
                    width: 154,
                    padding: 6,
                    background: '#2a2a3e',
                    border: `1px solid ${typeColor}`,
                    borderRadius: 6,
                    color: '#fff',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
                      <div style={{ fontWeight: 'bold', fontSize: 16, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
                        {c.name}
                      </div>
                      <span style={{ fontSize: 15, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{c.buy_cost != null ? `${c.buy_cost}💰` : '—'}</span>
                    </div>
                    <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                      <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
                        if (el) {
                          const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                          el.style.setProperty('--sub-scale', String(scale));
                        }
                      }}>
                      {statParts.map((part, j) => renderSubtitlePart(part, j))}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Review mode: player hover popup showing all cards played this turn */}
      {reviewing && reviewHoveredPlayer && revealedActionsRef.current?.[reviewHoveredPlayer] && (() => {
        const actions = revealedActionsRef.current![reviewHoveredPlayer];
        if (actions.length === 0) return null;
        const rowEl = playerRowRefs.current.get(reviewHoveredPlayer);
        if (!rowEl) return null;
        const rect = rowEl.getBoundingClientRect();
        const POPUP_W = 180;
        const REVIEW_TYPE_COLORS = CARD_TYPE_COLORS;
        const REVIEW_EMOJI: Record<string, string> = { claim: '⚔️', defense: '🛡️', engine: '⚙️', passive: '📜' };
        return (
          <div style={{
            position: 'fixed',
            left: rect.right + 8,
            top: rect.top,
            zIndex: 500,
            background: 'rgba(15, 15, 30, 0.95)',
            border: '1px solid #555',
            borderRadius: 8,
            padding: 8,
            width: POPUP_W,
            pointerEvents: 'none',
            maxHeight: '80vh',
            overflowY: 'auto',
          }}>
            <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
              Cards Played ({actions.length})
            </div>
            {actions.map((action, i) => {
              const typeColor = REVIEW_TYPE_COLORS[action.card.card_type] || '#555';
              const c = action.effective_power != null ? { ...action.card, power: action.effective_power } : action.card;
              const ctx: CardSubtitleContext = { ...frozenSubtitleContext, effectiveResourceGain: action.effective_resource_gain, effectiveDrawCards: action.effective_draw_cards };
              const statParts = buildCardSubtitle(c, ctx);
              return (
                <div key={i} style={{
                  width: 154,
                  padding: 6,
                  background: '#2a2a3e',
                  border: `1px solid ${typeColor}`,
                  borderRadius: 6,
                  color: '#fff',
                  marginBottom: i < actions.length - 1 ? 4 : 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 16, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
                      {c.name}
                    </div>
                    <span style={{ fontSize: 15, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{c.buy_cost != null ? `${c.buy_cost}💰` : '—'}</span>
                  </div>
                  <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                    <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
                      if (el) {
                        const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                        el.style.setProperty('--sub-scale', String(scale));
                      }
                    }}>
                    {statParts.map((part, j) => renderSubtitlePart(part, j))}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Review mode: full-screen card overlay (tile click or player click) */}
      {reviewing && reviewFullCards && reviewFullCards.length > 0 && (
        <div
          onClick={() => setReviewFullCards(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 20,
            maxWidth: 4 * (220 + 20) + 20,
            padding: 24,
          }}>
            {reviewFullCards.map((entry, i) => {
              const numColor = PLAYER_COLORS[entry.playerId];
              const color = numColor != null ? `#${numColor.toString(16).padStart(6, '0')}` : '#888';
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  <CardFull card={entry.card} />
                  <div style={{ fontSize: 12, fontWeight: 'bold', color }}>
                    {entry.playerName}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, fontSize: 12, color: '#666' }}>
            Click anywhere to close
          </div>
        </div>
      )}

      {/* Player effect popups (e.g. Sabotage forced discard) — shown over target base tiles */}
      {activePlayerEffects.length > 0 && (() => {
        const transform = gridTransformRef.current;
        const rect = gridContainerRef.current?.getBoundingClientRect();
        if (!transform || !rect) return null;
        const tiles = gameState.grid?.tiles ?? {};
        // Compute per-target stacking index (how many effects already shown for this target)
        const targetCounts: Record<string, number> = {};
        const stackIndices = activePlayerEffects.map(e => {
          const idx = targetCounts[e.target_player_id] ?? 0;
          targetCounts[e.target_player_id] = idx + 1;
          return idx;
        });
        const STACK_OFFSET = 50; // px between stacked popups
        const STAGGER_DELAY = 300; // ms between each popup on same target

        // Helper: compute screen position from axial tile coords
        const tileToScreen = (q: number, r: number) => {
          const local = axialToPixel(q, r);
          return {
            x: local.x * transform.scale + transform.offsetX + rect.left,
            y: local.y * transform.scale + transform.offsetY + rect.top,
          };
        };

        // Collect flying card elements
        const flyingCards: React.ReactNode[] = [];
        const FLY_DURATION = Math.round(800 * animSpeed);
        const FLY_CARD_STAGGER = 120; // ms between each card in a batch

        for (let i = 0; i < activePlayerEffects.length; i++) {
          const effect = activePlayerEffects[i];
          if (!effect.added_card_name || !effect.added_card_count || effect.source_q == null || effect.source_r == null) continue;

          const stackIdx = stackIndices[i];
          const effectDelay = stackIdx * STAGGER_DELAY;
          const src = tileToScreen(effect.source_q, effect.source_r);

          // Determine destination: home player → discard pile, others → their HUD card
          const isHomePlayer = effect.target_player_id === activePlayerId;
          let destX: number, destY: number;
          if (isHomePlayer) {
            const discardEl = document.querySelector('[data-discard-pile]');
            if (discardEl) {
              const dr = discardEl.getBoundingClientRect();
              destX = dr.left + dr.width / 2;
              destY = dr.top + dr.height / 2;
            } else {
              destX = window.innerWidth - 60;
              destY = window.innerHeight - 60;
            }
          } else {
            const hudEl = document.querySelector(`[data-player-hud="${effect.target_player_id}"]`);
            if (hudEl) {
              const hr = hudEl.getBoundingClientRect();
              destX = hr.left + hr.width / 2;
              destY = hr.top + hr.height / 2;
            } else {
              // Fallback: target's base tile
              const baseTile = Object.values(tiles).find(t => t.is_base && t.base_owner === effect.target_player_id);
              if (baseTile) {
                const bp = tileToScreen(baseTile.q, baseTile.r);
                destX = bp.x;
                destY = bp.y;
              } else {
                continue;
              }
            }
          }

          const isRubble = effect.added_card_name === 'Rubble';
          const cardColor = isRubble ? '#ff6666' : '#ffd700';
          const cardEmoji = isRubble ? '🪨' : '★';

          for (let c = 0; c < effect.added_card_count; c++) {
            const cardDelay = effectDelay + c * FLY_CARD_STAGGER;
            const dx = destX - src.x;
            const dy = destY - src.y;
            // Slight random spread so multiple cards don't overlap exactly
            const spreadX = (Math.random() - 0.5) * 20;
            const spreadY = (Math.random() - 0.5) * 20;
            const keyName = `flyCard_${i}_${c}`;

            flyingCards.push(
              <div key={keyName}>
                <style>{`
                  @keyframes ${keyName} {
                    0% {
                      transform: translate(0, 0) scale(1);
                      opacity: 1;
                    }
                    20% {
                      transform: translate(0, -20px) scale(1.1);
                      opacity: 1;
                    }
                    100% {
                      transform: translate(${dx + spreadX}px, ${dy + spreadY}px) scale(0.3);
                      opacity: 0.2;
                    }
                  }
                `}</style>
                <div style={{
                  position: 'fixed',
                  left: src.x,
                  top: src.y,
                  transform: 'translate(-50%, -50%)',
                  zIndex: 16000,
                  pointerEvents: 'none',
                  opacity: 0,
                  animation: `${keyName} ${FLY_DURATION}ms ease-in ${cardDelay}ms forwards`,
                }}>
                  <div style={{
                    background: 'rgba(15, 15, 35, 0.95)',
                    border: `2px solid ${cardColor}`,
                    borderRadius: 6,
                    padding: '3px 8px',
                    fontSize: 12,
                    fontWeight: 'bold',
                    color: cardColor,
                    whiteSpace: 'nowrap',
                    boxShadow: `0 0 12px ${cardColor}66`,
                  }}>
                    {cardEmoji} {effect.added_card_name}
                  </div>
                </div>
              </div>
            );
          }
        }

        return (
          <>
            {activePlayerEffects.map((effect, i) => {
              const baseTile = Object.values(tiles).find(t => t.is_base && t.base_owner === effect.target_player_id);
              if (!baseTile) return null;
              const screenPos = tileToScreen(baseTile.q, baseTile.r);
              const sourceColor = PLAYER_COLORS[effect.source_player_id];
              const colorStr = sourceColor !== undefined
                ? `#${sourceColor.toString(16).padStart(6, '0')}`
                : '#fff';
              const stackIdx = stackIndices[i];
              const yOffset = stackIdx * STACK_OFFSET;
              const delay = stackIdx * STAGGER_DELAY;
              return (
                <div
                  key={`popup_${i}`}
                  style={{
                    position: 'fixed',
                    left: screenPos.x,
                    top: screenPos.y - 40 - yOffset,
                    transform: 'translateX(-50%)',
                    zIndex: 15000 + stackIdx,
                    pointerEvents: 'none',
                    opacity: 0,
                    animation: `playerEffectPopup 2.5s ease-out ${delay}ms forwards`,
                  }}
                >
                  <div style={{
                    background: 'rgba(15, 15, 35, 0.95)',
                    border: `2px solid ${colorStr}`,
                    borderRadius: 10,
                    padding: '8px 14px',
                    textAlign: 'center',
                    boxShadow: `0 0 20px ${colorStr}44, 0 4px 16px rgba(0,0,0,0.6)`,
                    whiteSpace: 'nowrap',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 'bold', color: '#fff', marginBottom: 2 }}>
                      {effect.card_name}
                    </div>
                    <div style={{ fontSize: 12, color: '#ff6666', fontWeight: 'bold' }}>
                      {effect.effect}
                    </div>
                  </div>
                </div>
              );
            })}
            {flyingCards}
          </>
        );
      })()}

      {/* Game intro overlay */}
      {showIntro && (
        <GameIntroOverlay gameState={gameState} onReady={handleIntroReady} />
      )}

      {/* Phase banner — full-screen announcement */}
      {phaseBanner && (
        <PhaseBanner
          key={bannerKey}
          phase={phaseBanner}
          labelOverride={bannerLabelOverride ?? undefined}
          subtitle={bannerSubtitle ?? undefined}
          onMidpoint={handleBannerMidpoint}
          onComplete={handleBannerComplete}
          holdUntilRelease={bannerHoldUntilRelease}
        />
      )}

      {/* Debt card fly animation — above phase banner */}
      {debtFlyTarget && (
        <DebtCardFlyAnimation
          targetRect={debtFlyTarget}
          onComplete={handleDebtFlyComplete}
          speed={animationMode === 'fast' ? 0.5 : 1}
        />
      )}

      {/* Game Over overlay */}
      {showGameOver && (
        <GameOverOverlay
          gameState={gameState}
          playerId={mpPlayerId || activePlayerId}
          isVictory={gameState.winners ? gameState.winners.includes(mpPlayerId || activePlayerId || '') : gameState.winner === (mpPlayerId || activePlayerId)}
          onReturnToLobby={handleReturnToLobby}
          onExitGame={handleExitGame}
          isMultiplayer={isMultiplayer}
          removedFromLobby={removedFromLobby}
        />
      )}

      {/* Interaction blocker overlay (invisible, blocks clicks during banner/resolve) */}
      {interactionBlocked && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 25000,
          cursor: 'not-allowed',
        }} />
      )}

      {/* Keyframes for shop pulse glow + player effect popup */}
      <style>{`
        @keyframes shopPulse {
          0%, 100% { box-shadow: 0 0 8px rgba(74, 158, 255, 0.4); }
          50% { box-shadow: 0 0 20px rgba(74, 158, 255, 0.8), 0 0 40px rgba(74, 158, 255, 0.3); }
        }
        .hud-btn { transition: box-shadow 0.2s ease; }
        .hud-btn:hover { box-shadow: 0 0 8px rgba(160, 170, 255, 0.45); }
        @keyframes playerEffectPopup {
          0% { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.8); }
          10% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1.05); }
          20% { transform: translateX(-50%) translateY(0) scale(1); }
          80% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) translateY(-20px) scale(0.9); }
        }
      `}</style>
    </div>
  );
}
