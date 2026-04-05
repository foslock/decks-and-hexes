import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { GameState, Card, ResolutionStep, PlayerEffect } from '../types/game';
import HexGrid, { type GridTransform, type PlannedActionIcon, type ClaimChevron, type VpPath, PLAYER_COLORS } from './HexGrid';
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
import { useAnimated, useAnimationMode, useAnimationOff, useAnimationSpeed } from './SettingsContext';
import { IrreversibleButton, HoldToSubmitButton, type HoldToSubmitHandle } from './Tooltip';
import * as api from '../api/client';
import CardFull from './CardFull';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';

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
  replayVotes?: Set<string>;
  replayDisabled?: boolean;
  onReplayVotesUpdate?: (votes: Set<string>) => void;
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
      const count = card.is_upgraded && effect.upgraded_value != null ? effect.upgraded_value : effect.value;
      // Discarding is required if there are cards in hand
      return {
        effectType: 'self_discard',
        minCards: count,
        maxCards: count,
        label: 'Discard',
      };
    }
  }
  return null;
}

const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

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

export default function GameScreen({ gameState, onStateUpdate, playerId: mpPlayerId, token: mpToken, isMultiplayer, localPlayerIds: localPlayerIdsProp, isHost: mpIsHost, onLeaveGame, skipIntro: skipIntroProp, replayVotes: replayVotesProp, replayDisabled: replayDisabledProp, onReplayVotesUpdate }: GameScreenProps) {
  const animated = useAnimated();
  const animationMode = useAnimationMode();
  const animationOff = useAnimationOff();
  const animSpeed = useAnimationSpeed();
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
  const [draggingCardIndex, setDraggingCardIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragHintHidden, setDragHintHidden] = useState(false);
  const [showUpgradePreview, setShowUpgradePreview] = useState(false);
  const [showFullLog, setShowFullLog] = useState(false);
  const [showDeckViewer, setShowDeckViewer] = useState(false);
  const [showShopOverlay, setShowShopOverlay] = useState(false);
  const [showCardBrowser, setShowCardBrowser] = useState(false);
  const [discardingAll, setDiscardingAll] = useState(false);
  const [lastPlayedTarget, setLastPlayedTarget] = useState<PlayTarget | null>(null);
  // Test mode state
  const [showTestPanel, setShowTestPanel] = useState(false);
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
  } | null>(null);
  const [trashSelectedIndices, setTrashSelectedIndices] = useState<Set<number>>(new Set());
  // Intro overlay state — skip on reconnection
  const [showIntro, setShowIntro] = useState(!skipIntroProp);
  // Intro sequence after overlay: 'overlay' → 'shuffle' → 'draw' → 'done'
  const [introSequence, setIntroSequence] = useState<'overlay' | 'shuffle' | 'draw' | 'done'>(skipIntroProp ? 'done' : 'overlay');
  // Game over state
  const [showGameOver, setShowGameOver] = useState(false);
  const [localReplayVotes, setLocalReplayVotes] = useState<Set<string>>(new Set());
  const replayVotes = replayVotesProp ?? localReplayVotes;
  const replayDisabled = replayDisabledProp ?? false;
  // Settings gear dropdown state
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  // Player panel expand-on-hover
  const [playerPanelExpanded, setPlayerPanelExpanded] = useState(false);
  // Phase banner state
  const [phaseBanner, setPhaseBanner] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState(0);
  const [interactionBlocked, setInteractionBlocked] = useState(false);
  const submitPlanRef = useRef<HoldToSubmitHandle>(null);
  const endTurnRef = useRef<HoldToSubmitHandle>(null);
  const prevPhaseRef = useRef<string>(gameState.current_phase);
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
  // Upkeep indicator tooltip
  const [upkeepTooltip, setUpkeepTooltip] = useState<{ x: number; y: number } | null>(null);

  // Auto-dismiss error toast after 4 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const activePlayerId = gameState.player_order[activePlayerIndex];
  const activePlayer = gameState.players[activePlayerId];
  const phase = gameState.current_phase;

  // Auto-dismiss drag hint after 2 seconds, reset on player/phase change
  useEffect(() => {
    setDragHintHidden(false);
    const timer = setTimeout(() => setDragHintHidden(true), 2000);
    return () => clearTimeout(timer);
  }, [activePlayerId, phase]);


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
  useEffect(() => {
    const prev = prevPhaseRef.current;
    const oldTiles = prevTilesRef.current;
    if (prev === phase) {
      // Phase unchanged — still update tiles snapshot for future diffs
      prevTilesRef.current = gameState.grid.tiles;
      return;
    }
    // Don't show banner during intro overlay
    if (showIntro) return;
    // Don't show banner if currently resolving (resolve has its own banner flow)
    if (resolving) return;
    // Don't trigger if a banner is already active (e.g. reveal→buy chain).
    // IMPORTANT: don't update prevPhaseRef or prevTilesRef here — we need
    // to re-detect this phase change once the current banner completes.
    if (phaseBanner) return;
    // Commit: we're handling this phase transition now
    prevPhaseRef.current = phase;
    prevTilesRef.current = gameState.grid.tiles;

    // plan → reveal: set up resolve animation (works for both hotseat and multiplayer)
    if (prev === 'plan' && phase === 'reveal') {
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
    const bannerPhases = ['upkeep', 'plan', 'buy'];
    if (bannerPhases.includes(phase)) {
      // Set subtitle per phase
      if (phase === 'upkeep') {
        // Show only the active player's upkeep result
        const ap = activePlayer;
        if (ap) {
          const tileCount = Object.values(gameState.grid.tiles).filter(t => t.owner === activePlayerId).length;
          if (ap.tiles_lost_to_upkeep > 0) {
            setBannerSubtitle(`Lost ${ap.tiles_lost_to_upkeep} tile(s) — couldn't pay ${ap.upkeep_cost} 💰`);
          } else if (ap.upkeep_cost > 0) {
            setBannerSubtitle(`${ap.last_upkeep_paid} 💰 paid for ${tileCount} tiles`);
          } else {
            setBannerSubtitle('No upkeep due');
          }
        } else {
          setBannerSubtitle('No upkeep due');
        }
      } else if (phase === 'plan') {
        setBannerSubtitle('Choose Wisely');
      } else if (phase === 'buy') {
        setBannerSubtitle('Grow Your Deck');
      } else {
        setBannerSubtitle(null);
      }
      setPhaseBanner(phase);
      setInteractionBlocked(true);
    }
  }, [phase, animationOff, resolving, phaseBanner, gameState, showIntro, activePlayerId, homePlayerIndex, onStateUpdate]);

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

  // Show pulsing VP paths for the active player during plan phase
  useEffect(() => {
    if (phase !== 'plan' || resolving) {
      // If we just left plan phase (not into resolve — resolve handles its own paths),
      // fade out plan-phase paths
      if (vpPathPhase !== 'off' && !resolving) {
        vpPathFadeStartAlphaRef.current = vpPaths[0]?.alpha ?? 1;
        setVpPathPhase('fading_out');
      }
      return;
    }
    const tiles = gameState.grid?.tiles;
    if (!tiles || !activePlayerId) return;
    const color = PLAYER_COLORS[activePlayerId] ?? 0xffffff;
    const paths = computePlayerVpPaths(tiles, activePlayerId, color);
    if (paths.length > 0) {
      setVpPaths(paths);
      setVpPathPhase('fading_in');
    } else {
      setVpPaths([]);
      setVpPathPhase('off');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activePlayerId, resolving]);

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
  // During normal flow, shop opening is handled by handleBannerComplete after the buy banner.
  // Use a ref to skip the first render after a phase change (the banner effect needs time to set up).
  const buyPhaseStableRef = useRef(phase === 'buy');
  useEffect(() => {
    if (phase === 'buy') {
      if (buyPhaseStableRef.current && !resolving && !phaseBanner && !interactionBlocked && activePlayerEffects.length === 0) {
        setShowShopOverlay(true);
      }
      // Mark as stable on next tick so subsequent renders can open the shop
      const timer = setTimeout(() => { buyPhaseStableRef.current = true; }, 0);
      return () => clearTimeout(timer);
    } else {
      buyPhaseStableRef.current = false;
    }
  }, [phase, resolving, phaseBanner, interactionBlocked, activePlayerEffects]);

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
    if (phase !== 'plan' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Compute screen position for card animation
    if (q != null && r != null) {
      const transform = gridTransformRef.current;
      const gRect = gridContainerRef.current?.getBoundingClientRect();
      if (transform && gRect) {
        const local = axialToPixel(q, r);
        const screenX = local.x * transform.scale + transform.offsetX + gRect.left;
        const screenY = local.y * transform.scale + transform.offsetY + gRect.top;
        setLastPlayedTarget({ cardId: card.id, screenX, screenY });
      }
    } else {
      setLastPlayedTarget({ cardId: card.id, screenX: null, screenY: null });
    }

    try {
      setError(null);
      const result = await api.playCard(
        gameState.id, activePlayerId, cardIndex,
        q, r, targetPlayerId, extraTargets,
        trashIndices, discardIndices,
      );
      onStateUpdate(result.state);
      // Auto-select the next card in hand (card to the right, or left if last)
      const newHand = result.state.players[activePlayerId]?.hand;
      if (newHand && newHand.length > 0) {
        setSelectedCardIndex(Math.min(cardIndex, newHand.length - 1));
      } else {
        setSelectedCardIndex(null);
      }
      setSurgeTargets([]);
      setSurgeCardIndex(null);
      setSurgePrimaryTarget(null);
      setTrashMode(null);
      setTrashSelectedIndices(new Set());
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
    if (phase !== 'plan' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Check if card needs trash/discard choice
    const choiceReq = getCardChoiceRequirement(card);
    if (choiceReq && maybeEnterTrashMode(cardIndex, choiceReq, q, r, extraTargets, targetPlayerId)) {
      return;
    }

    await executePlayCard(cardIndex, q, r, extraTargets, targetPlayerId);
  }, [phase, activePlayer, executePlayCard, maybeEnterTrashMode]);

  const playCardNoTarget = useCallback(async (cardIndex: number) => {
    if (phase !== 'plan' || !activePlayer) return;
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
  const handleDragPlay = useCallback((cardIndex: number, screenX: number, screenY: number) => {
    if (!gridContainerRef.current || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Player-targeting engine cards (e.g. Sabotage): must drop on an opponent's tile
    if (card.card_type === 'engine' && card.forced_discard > 0) {
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

    // Non-targeting cards (engine): just release anywhere on the board
    if (card.card_type === 'engine') {
      const rect = gridContainerRef.current.getBoundingClientRect();
      if (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom) {
        playCardNoTarget(cardIndex);
      }
      return;
    }

    // Targeting cards (claim/defense): convert screen → canvas → hex-local → axial
    const rect = gridContainerRef.current.getBoundingClientRect();
    const canvasX = screenX - rect.left;
    const canvasY = screenY - rect.top;
    const transform = gridTransformRef.current;
    if (!transform) return;
    const localX = (canvasX - transform.offsetX) / transform.scale;
    const localY = (canvasY - transform.offsetY) / transform.scale;
    const { q, r } = pixelToAxial(localX, localY);

    // Validate defense card restrictions — must target own tile
    if (card.card_type === 'defense') {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (tile && tile.owner !== activePlayerId) {
        setError(`${card.name} must target a tile you own`);
        return;
      }
    }

    // Validate claim card restrictions
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

  const handleTileClick = useCallback(async (q: number, r: number) => {
    tileClickedRef.current = true;

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

    if (phase !== 'plan' || !activePlayer) return;

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
      return;
    }

    if (selectedCardIndex === null) return;

    const card = activePlayer.hand[selectedCardIndex];
    if (!card) return;

    // Player-targeting engine cards (e.g. Sabotage): click an opponent's tile
    if (card.card_type === 'engine' && card.forced_discard > 0) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || !tile.owner || tile.owner === activePlayerId) {
        setError(`${card.name} must target an opponent's tile`);
        return;
      }
      await playCardAtTile(selectedCardIndex, q, r, undefined, tile.owner);
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

      await playCardAtTile(selectedCardIndex, q, r);
    }
  }, [phase, activePlayer, selectedCardIndex, gameState.grid, playCardAtTile, surgeCardIndex, surgePrimaryTarget, surgeTargets, activePlayerId, reviewing, gameState.players, actionTileKey]);

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
  }, [trashMode, trashSelectedIndices, activePlayer, executePlayCard]);

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
      } else if (next.size < trashMode.maxCards) {
        next.add(cardIndex);
      }
      return next;
    });
  }, [trashMode]);

  const handleSubmitPlan = useCallback(async () => {
    try {
      setError(null);
      const result = await api.submitPlan(gameState.id, activePlayerId);

      // Apply the state — if phase is now 'reveal', the phase change effect
      // will detect plan→reveal and set up the resolve animation automatically.
      onStateUpdate(result.state);

      if (result.state.current_phase !== 'reveal') {
        // Not all plans submitted yet — cycle to next local player
        if (shouldCycle) {
          const nextIndex = gameState.player_order.findIndex(
            (pid, i) => i !== activePlayerIndex && localPlayerIds.includes(pid) && !gameState.players[pid].has_submitted_plan && !gameState.players[pid].is_cpu,
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
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

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

  // Submit Plan button state
  const submitHasCardsLeft = activePlayer ? activePlayer.hand.length > 0 : false;
  const submitActionsLeft = activePlayer ? activePlayer.actions_available - activePlayer.actions_used : 0;
  const submitCanStillPlay = submitHasCardsLeft && submitActionsLeft > 0;

  // Keyboard shortcuts: Escape, C/D/S, 1-9, Enter (with hold support)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape: close the topmost overlay
      if (e.key === 'Escape') {
        if (showCardBrowser) { setShowCardBrowser(false); return; }
        if (showDeckViewer) { setShowDeckViewer(false); return; }
        if (showShopOverlay) { setShowShopOverlay(false); return; }
        if (showFullLog) { setShowFullLog(false); return; }
        if (selectedCardIndex !== null) { setSelectedCardIndex(null); return; }
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

        // Priority 1: Play selected engine card
        if (
          phase === 'plan' && activePlayer && !resolving &&
          selectedCardIndex !== null && surgeCardIndex === null && !trashMode
        ) {
          const card = activePlayer.hand[selectedCardIndex];
          if (card?.card_type === 'engine') {
            handlePlayEngine();
            return;
          }
        }

        // Priority 2: Submit Plan (only when no Play Card button is available)
        if (
          phase === 'plan' && activePlayer && !activePlayer.has_submitted_plan &&
          !resolving && activePlayerEffects.length === 0 &&
          surgeCardIndex === null && !trashMode
        ) {
          const hasPlayableEngine = selectedCardIndex !== null &&
            activePlayer.hand[selectedCardIndex]?.card_type === 'engine';
          if (!hasPlayableEngine) {
            if (submitCanStillPlay) {
              submitPlanRef.current?.startKeyboardHold();
            } else {
              handleSubmitPlan();
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
      } else if (phase === 'plan' && !activePlayer.has_submitted_plan && !interactionBlocked) {
        setSelectedCardIndex(prev => prev === cardIndex ? null : cardIndex);
        setDragHintHidden(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        submitPlanRef.current?.stopKeyboardHold();
        endTurnRef.current?.stopKeyboardHold();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [activePlayer, phase, interactionBlocked, trashMode, handleTrashToggle, selectedCardIndex, surgeCardIndex, resolving, reviewing, handlePlayEngine, showCardBrowser, showDeckViewer, showShopOverlay, showFullLog, activePlayerEffects, submitCanStillPlay, handleSubmitPlan, phaseBanner]);

  const handleDiscardAllComplete = useCallback(() => {
    setDiscardingAll(false);
    if (pendingStateRef.current) {
      onStateUpdate(pendingStateRef.current);
      pendingStateRef.current = null;
    }
    setActivePlayerIndex(homePlayerIndex);
    setSelectedCardIndex(null);
  }, [onStateUpdate, homePlayerIndex]);

  // Intro overlay dismissed — start shuffle → draw → plan banner sequence
  const handleIntroReady = useCallback(() => {
    setShowIntro(false);
    if (animationOff) {
      // No animations: skip straight to done
      setIntroSequence('done');
      return;
    }
    // Start shuffle animation on the draw pile
    setIntroSequence('shuffle');
    setInteractionBlocked(true);
  }, [animationOff]);

  // Intro sequence: shuffle → draw → plan banner
  useEffect(() => {
    if (introSequence === 'shuffle') {
      // Show shuffle animation scaled by speed
      const duration = Math.round(2000 * animSpeed) || 800;
      const timer = setTimeout(() => setIntroSequence('draw'), duration);
      return () => clearTimeout(timer);
    }
    if (introSequence === 'draw') {
      // Cards are now being passed to CardHand — entering animations will play.
      // Wait for all cards to finish their staggered draw animation, then show plan banner.
      const handSize = activePlayer?.hand.length ?? 0;
      // Each card takes 500ms stagger + ~500ms animation duration
      const drawDuration = handSize * 500 + 500;
      const timer = setTimeout(() => {
        setIntroSequence('done');
        // Now trigger the plan banner (round 1 has no upkeep)
        setBannerSubtitle('Choose Wisely');
        setPhaseBanner('plan');
        setBannerKey(k => k + 1);
      }, drawDuration);
      return () => clearTimeout(timer);
    }
  }, [introSequence, animated, activePlayer, gameState]);

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
    const bannerPhase = phaseBanner;

    // Upkeep banner finished → advance to PLAN via API, then show PLAN banner
    if (bannerPhase === 'upkeep') {
      api.advanceUpkeep(gameState.id).then(result => {
        onStateUpdate(result.state);
        // Chain into the plan banner — sync ref so phase effect doesn't re-trigger
        prevPhaseRef.current = result.state.current_phase;
        setBannerSubtitle('Choose Wisely');
        setPhaseBanner('plan');
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

    setPhaseBanner(null);
    // Sync phase ref so the phase change effect doesn't re-trigger for this phase
    prevPhaseRef.current = phase;
    // If resolving, don't unblock interactions yet — resolve overlay will do that
    if (!resolving) {
      setInteractionBlocked(false);
      // Auto-open shop after buy banner completes
      if (bannerPhase === 'buy') {
        setShowShopOverlay(true);
      }
    }
  }, [resolving, phaseBanner, phase, onStateUpdate, animationOff, enterReviewMode, homePlayerIndex, gameState, activePlayerId]);

  // Phase banner midpoint — start drawing cards if it's start_of_turn
  const handleBannerMidpoint = useCallback(() => {
    // Card drawing is handled by the state update, which has already been applied.
    // The banner just delays interaction, so nothing special at midpoint currently.
  }, []);

  // Resolve animation completed — advance resolve and move to buy phase
  const handleResolveComplete = useCallback(() => {
    setResolving(false);
    setResolutionSteps([]);
    setResolveDisplayState(null);
    setResolvedUpToStep(-1);
    setCurrentStepFade(1);
    resolveChevronCacheRef.current = [];
    setActivePlayerIndex(homePlayerIndex);
    // Fade out VP paths and clear resolve log
    if (vpPaths.length > 0) {
      vpPathFadeStartAlphaRef.current = vpPaths[0]?.alpha ?? 1;
      setVpPathPhase('fading_out');
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
      const result = await api.testTrashCard(gameState.id, activePlayerId, cardIndex);
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
  const humanPlayerCount = useMemo(
    () => gameState.player_order.filter(pid => {
      const p = gameState.players[pid];
      return p && !p.is_cpu && !p.has_left;
    }).length,
    [gameState.player_order, gameState.players],
  );

  const handleReplayVote = useCallback(async () => {
    if (!mpPlayerId || !mpToken) return;
    try {
      const result = await api.replayVote(gameState.id, mpPlayerId, mpToken);
      if (result.votes) {
        const votes = new Set(result.votes);
        onReplayVotesUpdate?.(votes);
        setLocalReplayVotes(votes);
      }
      // If game restarted, the game_start WS message will handle navigation
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, mpPlayerId, mpToken, onReplayVotesUpdate]);

  const handleExitGame = useCallback(async () => {
    if (isMultiplayer && mpPlayerId && mpToken) {
      try {
        await api.replayExit(gameState.id, mpPlayerId, mpToken);
      } catch { /* ignore — we're leaving anyway */ }
    }
    onLeaveGame?.();
  }, [gameState.id, mpPlayerId, mpToken, isMultiplayer, onLeaveGame]);

  const selectedCard = selectedCardIndex !== null ? activePlayer?.hand[selectedCardIndex] : null;

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
    const map = new Map<string, { playerId: string; playerName: string; card: import('../types/game').Card }[]>();
    for (const [pid, playerActions] of Object.entries(actions)) {
      const player = gameState.players[pid];
      const name = player?.name ?? pid;
      for (const action of playerActions) {
        const key = actionTileKey(action);
        if (key) {
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({ playerId: pid, playerName: name, card: action.card });
        }
      }
    }
    return map;
  }, [reviewing, gameState.players, actionTileKey]);

  // Submit Plan button state (used by keyboard handler and UI)
  // NOTE: declared here so it's available to the keyboard effect above

  // Upkeep indicator calculations — tiles_per_vp = grid radius - 1, used for both VP and upkeep
  const UPKEEP_FREE_TILES = 4;
  const GRID_RADIUS: Record<string, number> = { small: 4, medium: 5, large: 6 };
  const tilesPerVp = (GRID_RADIUS[gameState.grid.size] ?? 4) - 1;
  const playerTileCount = activePlayer
    ? Object.values(gameState.grid.tiles).filter(t => t.owner === activePlayerId).length
    : 0;
  const currentUpkeep = Math.max(0, Math.floor((playerTileCount - UPKEEP_FREE_TILES) / tilesPerVp));
  const upkeepBracketHigh = currentUpkeep === 0
    ? UPKEEP_FREE_TILES + tilesPerVp - 1
    : UPKEEP_FREE_TILES + (currentUpkeep + 1) * tilesPerVp - 1;
  const upkeepBracketLow = currentUpkeep === 0 ? 1 : UPKEEP_FREE_TILES + currentUpkeep * tilesPerVp;
  // Glow if pending claims might push past bracket boundary
  const pendingClaimCount = activePlayer
    ? activePlayer.planned_actions.filter(a => a.card.card_type === 'claim' && a.target_q !== null).length
    : 0;
  const upkeepMightIncrease = playerTileCount + pendingClaimCount > upkeepBracketHigh;

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

  // Build claim chevrons for the active player during plan phase
  const planChevrons = useMemo((): ClaimChevron[] => {
    if (phase !== 'plan' || !activePlayer?.planned_actions || resolving) return [];
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

  // Active chevrons: plan phase or resolve reveal
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
        const type = action.card.card_type;
        const power = type === 'defense' ? action.card.defense_bonus : action.card.power;
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
            addToMap(extraKey, type, action.card.power, action.card.name, action.card);
          }
        }
      }
    }
    return map.size > 0 ? map : undefined;
  }, [activePlayer?.planned_actions]);

  // Cards currently placed on the board during plan phase (shown as "In Play" in deck viewer)
  // After resolve, these cards move to discard, so only show during plan/reveal.
  const inPlayCards = useMemo(() => {
    if (phase !== 'plan' && phase !== 'reveal') return [];
    if (!activePlayer?.planned_actions) return [];
    return activePlayer.planned_actions
      .filter(a => a.target_q != null)
      .map(a => a.card);
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

  const totalDeckCount = useMemo(() => {
    if (!activePlayer) return 0;
    return inPlayCards.length + activePlayer.hand.length +
      (activePlayer.deck_cards?.length ?? 0) + (activePlayer.discard?.length ?? 0);
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
                if (phase !== 'plan') return undefined;
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
                const card = selectedCard?.card_type === 'claim' ? selectedCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'claim'
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (card) return getValidClaimTiles(card);
                // Defense card: highlight own tiles
                const defCard = selectedCard?.card_type === 'defense' ? selectedCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'defense'
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (defCard) {
                  const ownTiles = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner === activePlayerId) ownTiles.add(k);
                  }
                  return ownTiles;
                }
                // Player-targeting engine card (e.g. Sabotage): highlight opponent tiles
                const ptCard = selectedCard?.card_type === 'engine' && selectedCard?.forced_discard > 0 ? selectedCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'engine'
                    && activePlayer?.hand[draggingCardIndex]?.forced_discard > 0
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (ptCard) {
                  const opponentTiles = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner && t.owner !== activePlayerId) opponentTiles.add(k);
                  }
                  return opponentTiles;
                }
                return undefined;
              })()}
              surgeTargets={surgeCardIndex !== null ? [
                ...(surgePrimaryTarget ? [surgePrimaryTarget] : []),
                ...surgeTargets,
              ] : undefined}
              borderTiles={phase === 'plan' ? adjacentTiles : undefined}
              playerInfo={playerInfo}
              transformRef={gridTransformRef}
              activePlayerId={phase === 'plan' ? activePlayerId : undefined}
              plannedActions={phase === 'plan' ? plannedActions : undefined}
              previewCard={phase === 'plan' ? (
                selectedCard?.card_type === 'claim' || selectedCard?.card_type === 'defense' ? selectedCard
                : (selectedCard?.card_type === 'engine' && selectedCard?.forced_discard > 0) ? selectedCard
                : draggingCardIndex !== null ? activePlayer?.hand[draggingCardIndex] ?? null
                : null
              ) : null}
              previewValidTiles={(() => {
                if (phase !== 'plan') return undefined;
                const card = selectedCard?.card_type === 'claim' || selectedCard?.card_type === 'defense' ? selectedCard
                  : draggingCardIndex !== null ? activePlayer?.hand[draggingCardIndex] ?? null
                  : null;
                return card ? getAllValidPlayTiles(card) : undefined;
              })()}
              claimChevrons={activeChevrons.length > 0 ? activeChevrons : undefined}
              vpPaths={vpPaths.length > 0 ? vpPaths : undefined}
              connectedVpTiles={connectedVpTiles}
              disableHover={!!(showIntro || showFullLog || showDeckViewer || showCardBrowser || showShopOverlay || showUpgradePreview || phaseBanner)}
              reviewPulseTiles={reviewPulseTiles}
              onTileHover={reviewing ? (q, r, sx, sy) => {
                setReviewHoveredTile(`${q},${r}`);
                setReviewTilePopupPos({ x: sx, y: sy });
              } : undefined}
              onTileHoverEnd={reviewing ? () => setReviewHoveredTile(null) : undefined}
            />
          )}

          {/* ── Top-left overlay: round info + upkeep + expandable player panel ── */}
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 210, maxWidth: 280 }}>
            {/* Round / Phase / VP target */}
            <div style={{
              background: 'rgba(10, 10, 20, 0.85)',
              borderRadius: 8,
              padding: '8px 14px',
              marginBottom: 6,
              backdropFilter: 'blur(4px)',
              border: '1px solid #333',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 16, fontWeight: 'bold', color: '#fff' }}>
                  Round {gameState.current_round}
                </span>
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  background: phase === 'plan' ? '#2a6e3e' : phase === 'buy' ? '#2a4a6e' : phase === 'reveal' ? '#4a2a6e' : '#333',
                  color: '#fff', fontWeight: 'bold', textTransform: 'uppercase',
                }}>
                  {phase.replace(/_/g, ' ')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#aaa' }}>
                ★ {gameState.vp_target} VP to win
              </div>
              {gameState.winner && (
                <div style={{
                  marginTop: 4, padding: '4px 8px', background: '#4a9eff33', borderRadius: 6, fontWeight: 'bold',
                  fontSize: 13,
                }}>
                  ★ {gameState.players[gameState.winner]?.name} wins!
                </div>
              )}
            </div>

            {/* Upkeep indicator */}
            {(phase === 'plan' || phase === 'buy') && activePlayer && !resolving && gameState.current_round > 0 && (() => {
              const cantAfford = activePlayer.resources < currentUpkeep;
              const tooltipText = cantAfford
                ? `⚠ You can't afford ${currentUpkeep} 💰 upkeep! Tiles will be lost next round.`
                : `Upkeep: ${currentUpkeep} 💰 paid before each Plan phase for ${playerTileCount} tile${playerTileCount !== 1 ? 's' : ''}. If you can't pay, your most distant tiles are lost.`;
              return (
                <div
                  style={{ marginBottom: 6 }}
                  onPointerEnter={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setUpkeepTooltip({ x: rect.left, y: rect.bottom });
                  }}
                  onPointerLeave={() => setUpkeepTooltip(null)}
                >
                  <div style={{
                    fontSize: 12,
                    color: upkeepMightIncrease ? '#ffaa33' : '#aaa',
                    display: 'flex', alignItems: 'center', gap: 4,
                    cursor: 'help',
                    background: 'rgba(10, 10, 20, 0.85)',
                    padding: '5px 12px',
                    borderRadius: 6,
                    border: '1px solid #333',
                    backdropFilter: 'blur(4px)',
                  }}>
                    <span style={{ fontSize: 11, color: '#777' }}>Upkeep:</span>
                    <span style={{
                      fontWeight: upkeepMightIncrease ? 'bold' : 'normal',
                      color: upkeepMightIncrease ? '#ffaa33' : '#aaa',
                    }}>
                      💰 {currentUpkeep}
                    </span>
                    <span style={{ fontSize: 11, color: '#777' }}>
                      ({upkeepBracketLow}–{upkeepBracketHigh} tiles)
                    </span>
                    {upkeepMightIncrease && (
                      <span style={{ fontSize: 11, color: '#ffaa33', fontWeight: 'bold' }}>⚠</span>
                    )}
                  </div>
                  {upkeepTooltip && createPortal(
                    <div style={{
                      position: 'fixed',
                      left: upkeepTooltip.x,
                      top: upkeepTooltip.y + 8,
                      background: cantAfford ? '#332200' : '#111122',
                      border: `1px solid ${cantAfford ? '#aa7722' : '#555'}`,
                      borderRadius: 6,
                      padding: '6px 10px',
                      fontSize: 12,
                      lineHeight: 1.4,
                      color: cantAfford ? '#ffcc66' : '#ddd',
                      maxWidth: 260,
                      zIndex: 20000,
                      pointerEvents: 'none',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                      whiteSpace: 'normal',
                    }}>
                      {tooltipText}
                    </div>,
                    document.body
                  )}
                </div>
              );
            })()}

            {/* Expandable player panel */}
            <div
              onMouseEnter={() => setPlayerPanelExpanded(true)}
              onMouseLeave={() => setPlayerPanelExpanded(false)}
              style={{
                background: 'rgba(10, 10, 20, 0.85)',
                borderRadius: 8,
                border: '1px solid #333',
                backdropFilter: 'blur(4px)',
                overflow: 'hidden',
                transition: 'all 0.2s ease',
              }}
            >
              {(playerPanelExpanded || reviewing) ? (
                /* Expanded: all players */
                <div style={{ padding: 6 }}>
                  {gameState.player_order.map((pid, i) => {
                    const p = gameState.players[pid];
                    const pInPlay = phase === 'plan' ? (p.planned_actions?.filter(a => a.target_q != null).length ?? 0) : 0;
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
                          phase={phase}
                          totalCards={pTotal}
                          tileCount={pTiles}

                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* Collapsed: active player only */
                <div style={{ padding: 6 }}>
                  {activePlayer && (() => {
                    const pInPlay = phase === 'plan' ? (activePlayer.planned_actions?.filter(a => a.target_q != null).length ?? 0) : 0;
                    const pTotal = activePlayer.hand_count + activePlayer.deck_size + activePlayer.discard_count + pInPlay;
                    return (
                      <PlayerHud
                        player={activePlayer}
                        isActive={true}
                        isCurrent={true}
                        isFirstPlayer={activePlayerIndex === gameState.first_player_index}
                        phase={phase}
                        totalCards={pTotal}
                        tileCount={playerTileCount}

                      />
                    );
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* ── Top-right: action buttons + gear ── */}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 8, alignItems: 'flex-start', zIndex: 210 }}>
            <button
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
              📖 <span style={{ textDecoration: 'underline' }}>C</span>ards
            </button>
            <button
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
              <span style={{ textDecoration: 'underline' }}>D</span>eck ({totalDeckCount})
            </button>
            <button
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
                ...(phase === 'buy' && !phaseBanner && !showShopOverlay && !activePlayer?.has_ended_turn ? {
                  animation: animationMode !== 'off' ? 'shopPulse 2s ease-in-out infinite' : undefined,
                  boxShadow: '0 0 12px rgba(74, 158, 255, 0.6)',
                  borderColor: '#4a9eff',
                } : {}),
              }}
            >
              <span style={{ textDecoration: 'underline' }}>S</span>hop
            </button>

            {/* Gear icon dropdown */}
            <div ref={settingsRef} style={{ position: 'relative' }}>
              <button
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
                          <button
                            onClick={() => setShowGameOver(true)}
                            style={{ padding: '4px 8px', background: '#8844aa', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', marginTop: 4 }}
                          >
                            Trigger Game Over
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
              disabled={phase !== 'buy' || !!activePlayer?.has_ended_turn}
              onClose={() => setShowShopOverlay(false)}
              testMode={!!gameState.test_mode}
              effectiveBuyCosts={activePlayer?.effective_buy_costs}
              currentUpkeep={currentUpkeep}
              neutralBoughtThisTurn={!!activePlayer?.neutral_bought_this_turn}
              neutralPurchasesLastRound={gameState.neutral_purchases_last_round}
              currentPlayerId={activePlayerId}
            />
          )}

          {/* Toasts — floating above the hand panel */}
          <div style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, zIndex: 20, pointerEvents: 'none' }}>
            {phase === 'plan' && activePlayer && !activePlayer.has_submitted_plan && (
              <div style={{
                fontSize: 12,
                padding: '4px 14px',
                background: '#ffffff11',
                border: '1px solid #ffffff22',
                borderRadius: 6,
                color: '#888',
                whiteSpace: 'nowrap',
                opacity: dragHintHidden ? 0 : 1,
                transition: animationOff ? 'none' : 'opacity 0.4s ease',
              }}>
                {activePlayer.name}'s turn — drag a card onto the board, or select + click
              </div>
            )}
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

          {/* Bottom bar: action counter (left) + buttons (right) */}
          <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12, display: 'flex', alignItems: 'center', gap: 8, zIndex: 20, minHeight: 34 }}>
            {/* Action counter — left aligned */}
            {phase === 'plan' && activePlayer && !resolving && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <span style={{ fontSize: 16, fontWeight: 'bold', color: submitActionsLeft > 0 ? '#fff' : '#666', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                  ⚡ {submitActionsLeft}
                </span>
                <span style={{ fontSize: 12, color: '#aaa', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                  action{submitActionsLeft !== 1 ? 's' : ''} remaining
                </span>
              </div>
            )}
            <div style={{ flex: 1 }} />
            {/* Buttons — right aligned */}
            {/* Test-mode Discard & Trash buttons */}
            {gameState.test_mode && phase === 'plan' && activePlayer && !resolving &&
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
            {/* Upgrade button — shown when a card is selected during plan phase */}
            {phase === 'plan' && activePlayer && !resolving && selectedCard && selectedCardIndex !== null &&
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
            {phase === 'plan' && activePlayer && !resolving && selectedCard?.card_type === 'engine' && surgeCardIndex === null && !trashMode && (
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
            {phase === 'plan' && surgeCardIndex !== null && surgePrimaryTarget && (() => {
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
            {phase === 'plan' && trashMode && (() => {
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
            {phase === 'plan' && !resolving && !phaseBanner && activePlayer && !activePlayer.has_submitted_plan && activePlayerEffects.length === 0 && surgeCardIndex === null && !trashMode && (
              <HoldToSubmitButton
                ref={submitPlanRef}
                key={activePlayerId}
                onConfirm={handleSubmitPlan}
                requireHold={submitCanStillPlay}
                warning={`You still have ${activePlayer.hand.length} card(s) and ${submitActionsLeft} action(s) remaining.`}
                tooltip="Submitting locks your plan for this round. You cannot change it after."
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
                Submit Plan{submitCanStillPlay ? '' : ' ✓'}
              </HoldToSubmitButton>
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
            {phase === 'buy' && activePlayer && !resolving && !phaseBanner && activePlayerEffects.length === 0 && !activePlayer.has_ended_turn && (
              <HoldToSubmitButton
                ref={endTurnRef}
                onConfirm={handleEndTurn}
                requireHold={true}
                warning="Ending the turn advances to the next round. Any unspent resources carry over."
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
                End Turn →
              </HoldToSubmitButton>
            )}
            {phase === 'buy' && activePlayer && !resolving && !phaseBanner && activePlayerEffects.length === 0 && activePlayer.has_ended_turn && (
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
                ✓ Turn Ended
              </button>
            )}
            {/* Multiplayer: waiting for other players indicator */}
            {isMultiplayer && activePlayer && (
              (phase === 'plan' && activePlayer.has_submitted_plan && !resolving) ||
              (phase === 'reveal' && activePlayer.has_acknowledged_resolve && !resolving && !phaseBanner) ||
              (phase === 'buy' && activePlayer.has_ended_turn && !phaseBanner)
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
          </div>
        </div>

        {/* Bottom panel: hand */}
        <div style={{ padding: '8px 12px', flexShrink: 0, overflow: 'visible', position: 'relative', zIndex: 30 }}>
          {activePlayer && (
            <CardHand
              playerId={activePlayerId}
              cards={introSequence === 'overlay' || introSequence === 'shuffle' ? [] : activePlayer.hand}
              selectedIndex={selectedCardIndex}
              onSelect={(idx) => { setSelectedCardIndex(idx); setDragHintHidden(true); }}
              onDragPlay={handleDragPlay}
              onDoubleClick={(idx) => {
                const card = activePlayer?.hand[idx];
                if (card?.card_type === 'engine') playCardNoTarget(idx);
              }}
              onDragStart={setDraggingCardIndex}
              onDragEnd={() => setDraggingCardIndex(null)}
              disabled={phase !== 'plan' || activePlayer.has_submitted_plan || interactionBlocked}
              deckSize={activePlayer.deck_size}
              discardCount={activePlayer.discard_count}
              discardCards={activePlayer.discard}
              deckCards={activePlayer.deck_cards}
              inPlayCards={inPlayCards}
              discardAll={discardingAll}
              onDiscardAllComplete={handleDiscardAllComplete}
              lastPlayedTarget={lastPlayedTarget}
              forceShuffleAnim={introSequence === 'shuffle'}
              trashMode={trashMode ? {
                playedCardIndex: trashMode.cardIndex,
                selectedIndices: trashSelectedIndices,
                minCards: trashMode.minCards,
                maxCards: trashMode.maxCards,
                label: trashMode.label,
              } : null}
              onTrashToggle={handleTrashToggle}
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
      {showCardBrowser && (
        <CardBrowser onClose={() => setShowCardBrowser(false)} />
      )}

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
        const POPUP_W = 160;
        const left = Math.min(reviewTilePopupPos.x + 16, window.innerWidth - POPUP_W - 12);
        const top = Math.min(reviewTilePopupPos.y - 20, window.innerHeight - cards.length * 70 - 20);
        const REVIEW_TYPE_COLORS: Record<string, string> = { claim: '#4a9eff', defense: '#4aff6a', engine: '#ffaa4a', passive: '#aa88cc' };
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
              const c = entry.card;
              const statParts: string[] = [];
              if (c.card_type === 'defense') {
                const def = c.defense_bonus > 0 ? c.defense_bonus : c.power;
                if (def > 0) {
                  const dtc = c.defense_target_count || 1;
                  statParts.push(dtc >= 2 ? `Def ${def} · ${dtc} 🔷` : `Def ${def}`);
                }
              } else if (c.power > 0 || c.card_type === 'claim') {
                const mtc = 1 + (c.multi_target_count || 0);
                statParts.push(mtc >= 2 ? `Pow ${c.power} · ${mtc} 🔷` : `Pow ${c.power}`);
              }
              if (c.resource_gain > 0) statParts.push(`+${c.resource_gain} 💰`);
              if (c.draw_cards > 0) statParts.push(`+${c.draw_cards} 🃏`);
              if (c.action_return > 0) statParts.push(`+${c.action_return} ⚡`);
              if (c.forced_discard > 0) statParts.push(`🎯 -${c.forced_discard} 🃏`);
              if (c.effects) {
                for (const eff of c.effects) {
                  if (eff.type === 'self_trash' || eff.type === 'trash_gain_buy_cost') {
                    const val = c.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
                    statParts.push(`✂️ ${val}`);
                    if (eff.type === 'trash_gain_buy_cost') statParts.push('+ 💰');
                  }
                  if (eff.type === 'gain_resources' && eff.condition) {
                    const val = c.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
                    statParts.push(`+${val} 💰`);
                  }
                  if (eff.type === 'draw_next_turn' || eff.type === 'cease_fire') {
                    const val = c.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
                    statParts.push(`+${val} ⏰🃏`);
                  }
                  if (eff.type === 'enhance_vp_tile') statParts.push('🔷 +★');
                  if (eff.type === 'free_reroll' || eff.type === 'grant_stackable' || eff.type === 'grant_land_grants') statParts.push('⚙️');
                }
              }
              if (c.trash_on_use) statParts.push('🗑️');
              return (
                <div key={i} style={{ marginBottom: i < cards.length - 1 ? 6 : 0 }}>
                  <div style={{ fontSize: 10, color: playerColor, fontWeight: 'bold', marginBottom: 2 }}>
                    {entry.playerName}
                  </div>
                  <div style={{
                    width: 134,
                    padding: 6,
                    background: '#2a2a3e',
                    border: `1px solid ${typeColor}`,
                    borderRadius: 6,
                    color: '#fff',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <div style={{ fontWeight: 'bold', fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
                        {c.name}
                      </div>
                      <span style={{ fontSize: 11, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{c.buy_cost != null ? `${c.buy_cost}💰` : ''}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#aaa' }}>
                      {statParts.map((part, j) => <span key={j}>{j > 0 ? ' · ' : ''}{part}</span>)}
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
        const POPUP_W = 160;
        const REVIEW_TYPE_COLORS: Record<string, string> = { claim: '#4a9eff', defense: '#4aff6a', engine: '#ffaa4a', passive: '#aa88cc' };
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
              Cards Played
            </div>
            {actions.map((action, i) => {
              const typeColor = REVIEW_TYPE_COLORS[action.card.card_type] || '#555';
              const c = action.card;
              const statParts: string[] = [];
              if (c.card_type === 'defense') {
                const def = c.defense_bonus > 0 ? c.defense_bonus : c.power;
                if (def > 0) {
                  const dtc = c.defense_target_count || 1;
                  statParts.push(dtc >= 2 ? `Def ${def} · ${dtc} 🔷` : `Def ${def}`);
                }
              } else if (c.power > 0 || c.card_type === 'claim') {
                const mtc = 1 + (c.multi_target_count || 0);
                statParts.push(mtc >= 2 ? `Pow ${c.power} · ${mtc} 🔷` : `Pow ${c.power}`);
              }
              if (c.resource_gain > 0) statParts.push(`+${c.resource_gain} 💰`);
              if (c.draw_cards > 0) statParts.push(`+${c.draw_cards} 🃏`);
              if (c.action_return > 0) statParts.push(`+${c.action_return} ⚡`);
              if (c.forced_discard > 0) statParts.push(`🎯 -${c.forced_discard} 🃏`);
              if (c.effects) {
                for (const eff of c.effects) {
                  if (eff.type === 'self_trash' || eff.type === 'trash_gain_buy_cost') {
                    const val = c.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
                    statParts.push(`✂️ ${val}`);
                    if (eff.type === 'trash_gain_buy_cost') statParts.push('+ 💰');
                  }
                  if (eff.type === 'gain_resources' && eff.condition) {
                    const val = c.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
                    statParts.push(`+${val} 💰`);
                  }
                  if (eff.type === 'draw_next_turn' || eff.type === 'cease_fire') {
                    const val = c.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
                    statParts.push(`+${val} ⏰🃏`);
                  }
                  if (eff.type === 'enhance_vp_tile') statParts.push('🔷 +★');
                  if (eff.type === 'free_reroll' || eff.type === 'grant_stackable' || eff.type === 'grant_land_grants') statParts.push('⚙️');
                }
              }
              if (c.trash_on_use) statParts.push('🗑️');
              return (
                <div key={i} style={{
                  width: 134,
                  padding: 6,
                  background: '#2a2a3e',
                  border: `1px solid ${typeColor}`,
                  borderRadius: 6,
                  color: '#fff',
                  marginBottom: i < actions.length - 1 ? 4 : 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <div style={{ fontWeight: 'bold', fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
                      {c.name}
                    </div>
                    <span style={{ fontSize: 11, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{c.buy_cost != null ? `${c.buy_cost}💰` : ''}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#aaa' }}>
                    {statParts.map((part, j) => <span key={j}>{j > 0 ? ' · ' : ''}{part}</span>)}
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
        return activePlayerEffects.map((effect, i) => {
          const baseTile = Object.values(tiles).find(t => t.is_base && t.base_owner === effect.target_player_id);
          if (!baseTile) return null;
          const local = axialToPixel(baseTile.q, baseTile.r);
          const screenX = local.x * transform.scale + transform.offsetX + rect.left;
          const screenY = local.y * transform.scale + transform.offsetY + rect.top;
          const sourceColor = PLAYER_COLORS[effect.source_player_id];
          const colorStr = sourceColor !== undefined
            ? `#${sourceColor.toString(16).padStart(6, '0')}`
            : '#fff';
          const stackIdx = stackIndices[i];
          const yOffset = stackIdx * STACK_OFFSET;
          const delay = stackIdx * STAGGER_DELAY;
          return (
            <div
              key={i}
              style={{
                position: 'fixed',
                left: screenX,
                top: screenY - 40 - yOffset,
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
        });
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
          subtitle={bannerSubtitle ?? undefined}
          onMidpoint={handleBannerMidpoint}
          onComplete={handleBannerComplete}
        />
      )}

      {/* Game Over overlay */}
      {showGameOver && (
        <GameOverOverlay
          gameState={gameState}
          playerId={mpPlayerId || activePlayerId}
          isVictory={gameState.winner === (mpPlayerId || activePlayerId)}
          replayVotes={replayVotes}
          replayDisabled={replayDisabled}
          humanPlayerCount={humanPlayerCount}
          onReplayVote={handleReplayVote}
          onExitGame={handleExitGame}
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
