import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { GameState, Card, ResolutionStep, PlayerEffect } from '../types/game';
import HexGrid, { type GridTransform, type PlannedActionIcon, type ClaimChevron, type VpPath, PLAYER_COLORS } from './HexGrid';
import PlayerHud from './PlayerHud';
import CardHand, { CardViewPopup, type PlayTarget } from './CardHand';
import CardDetail from './CardDetail';
import CardBrowser from './CardBrowser';
import ShopOverlay from './ShopOverlay';
import GameLog from './GameLog';
import FullGameLog from './FullGameLog';
import SettingsPanel from './SettingsPanel';
import PhaseBanner from './PhaseBanner';
import ResolveOverlay from './ResolveOverlay';
import GameIntroOverlay from './GameIntroOverlay';
import { useAnimated, useAnimationMode, useAnimationOff } from './SettingsContext';
import Tooltip, { IrreversibleButton, HoldToSubmitButton } from './Tooltip';
import * as api from '../api/client';
import CardFull from './CardFull';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';

// Hex geometry constants (must match HexGrid.tsx)
const HEX_SIZE = 32;

interface GameScreenProps {
  gameState: GameState;
  onStateUpdate: (state: GameState) => void;
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

export default function GameScreen({ gameState, onStateUpdate }: GameScreenProps) {
  const animated = useAnimated();
  const animationMode = useAnimationMode();
  const animationOff = useAnimationOff();
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [draggingCardIndex, setDraggingCardIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragHintHidden, setDragHintHidden] = useState(false);
  const [detailCard, setDetailCard] = useState<Card | null>(null);
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
  // Intro overlay state
  const [showIntro, setShowIntro] = useState(true);
  // Intro sequence after overlay: 'overlay' → 'shuffle' → 'draw' → 'done'
  const [introSequence, setIntroSequence] = useState<'overlay' | 'shuffle' | 'draw' | 'done'>('overlay');
  // Settings collapse state
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  // Phase banner state
  const [phaseBanner, setPhaseBanner] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState(0);
  const [interactionBlocked, setInteractionBlocked] = useState(false);
  const prevPhaseRef = useRef<string>(gameState.current_phase);
  // Resolve animation state
  const [resolving, setResolving] = useState(false);
  const [resolutionSteps, setResolutionSteps] = useState<ResolutionStep[]>([]);
  const [resolveDisplayState, setResolveDisplayState] = useState<GameState | null>(null);
  const resolveFinishedStateRef = useRef<GameState | null>(null);
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

  // Auto-dismiss drag hint after 2 seconds, reset on player/phase change
  useEffect(() => {
    setDragHintHidden(false);
    const timer = setTimeout(() => setDragHintHidden(true), 2000);
    return () => clearTimeout(timer);
  }, [activePlayerId, phase]);


  // The state to feed to HexGrid during resolve animations (shows incremental tile changes)
  const displayState = resolveDisplayState ?? gameState;

  // Phase change detection → show phase banner
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === phase) return;
    // Don't show banner during intro overlay
    if (showIntro) return;
    // Don't show banner if currently resolving (resolve has its own banner flow)
    if (resolving) return;
    // Don't trigger if a banner is already active (e.g. reveal→buy chain)
    if (phaseBanner) return;
    // Only show banners for main phases, and skip if animations are off
    const bannerPhases = ['upkeep', 'plan', 'buy'];
    if (bannerPhases.includes(phase) && !animationOff) {
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
    // Auto-advance upkeep when animations are off
    if (phase === 'upkeep' && animationOff) {
      api.advanceUpkeep(gameState.id).then(result => {
        onStateUpdate(result.state);
      }).catch(() => {});
    }
  }, [phase, animationOff, resolving, phaseBanner, gameState, showIntro]);

  // Chevron reveal animation: fade in all claim chevrons before resolve overlay
  useEffect(() => {
    if (!chevronRevealPhase) return;
    const duration = animationMode === 'normal' ? 1500
      : animationMode === 'simplified' ? 500 : 0;

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
    const duration = animationMode === 'normal' ? 1000
      : animationMode === 'simplified' ? 400 : 0;

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
    const duration = animationMode === 'normal' ? 800
      : animationMode === 'simplified' ? 400 : 0;
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
    const duration = animationMode === 'normal' ? 500
      : animationMode === 'simplified' ? 250 : 0;
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

  // Auto-open shop when entering buy phase.
  // During resolve flow, shop opening is handled explicitly by handleBannerComplete.
  useEffect(() => {
    if (phase === 'buy' && !resolving && !phaseBanner) {
      setShowShopOverlay(true);
    }
  }, [phase, resolving, phaseBanner]);

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

  const playCardAtTile = useCallback(async (cardIndex: number, q: number, r: number, extraTargets?: [number, number][], targetPlayerId?: string) => {
    if (phase !== 'plan' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Compute screen position of the target tile for card animation
    const transform = gridTransformRef.current;
    const gridRect = gridContainerRef.current?.getBoundingClientRect();
    if (transform && gridRect) {
      const local = axialToPixel(q, r);
      const screenX = local.x * transform.scale + transform.offsetX + gridRect.left;
      const screenY = local.y * transform.scale + transform.offsetY + gridRect.top;
      setLastPlayedTarget({ cardId: card.id, screenX, screenY });
    }

    try {
      setError(null);
      const result = await api.playCard(gameState.id, activePlayerId, cardIndex, q, r, targetPlayerId, extraTargets);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
      // Clear surge state
      setSurgeTargets([]);
      setSurgeCardIndex(null);
      setSurgePrimaryTarget(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [phase, activePlayer, gameState.id, activePlayerId, onStateUpdate]);

  const playCardNoTarget = useCallback(async (cardIndex: number) => {
    if (phase !== 'plan' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (card) {
      setLastPlayedTarget({ cardId: card.id, screenX: null, screenY: null });
    }
    try {
      setError(null);
      const result = await api.playCard(gameState.id, activePlayerId, cardIndex);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [phase, activePlayer, gameState.id, activePlayerId, onStateUpdate]);

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

  const handleTileClick = useCallback(async (q: number, r: number) => {
    tileClickedRef.current = true;
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
  }, [phase, activePlayer, selectedCardIndex, gameState.grid, playCardAtTile, surgeCardIndex, surgePrimaryTarget, surgeTargets, activePlayerId]);

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

  const handleSubmitPlan = useCallback(async () => {
    try {
      setError(null);
      const result = await api.submitPlan(gameState.id, activePlayerId);
      const steps = result.state.resolution_steps;
      const revealHappened = result.state.current_phase === 'buy' || result.state.current_phase === 'reveal';

      if (revealHappened) {
        // All plans submitted — reveal phase happened server-side.
        // Hold back the final state and animate the resolution.
        const hasSteps = steps && steps.length > 0;
        resolveFinishedStateRef.current = result.state;
        setSelectedCardIndex(null);

        if (hasSteps && !animationOff) {
          // Build pre-resolve display state with old tile ownership for animation
          const preResolveState: GameState = {
            ...result.state,
            current_phase: 'reveal',
            grid: result.state.grid ? {
              ...result.state.grid,
              tiles: { ...gameState.grid.tiles },
            } : result.state.grid,
          };
          setResolveDisplayState(preResolveState);
          setResolutionSteps(steps);
          setGridTransformSnapshot(gridTransformRef.current);
          setResolving(true);
          setInteractionBlocked(true);
          setBannerSubtitle('Battle & Expand');
          setPhaseBanner('reveal');
          // Pre-compute chevron sources using pre-resolve tile state (before ownership changes)
          const preResolveTiles = gameState.grid.tiles;
          const cachedChevrons: typeof resolveChevronCacheRef.current = [];
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            for (const claimant of step.claimants) {
              const color = PLAYER_COLORS[claimant.player_id] ?? 0xffffff;
              const source = findClosestOwnedTile(step.q, step.r, preResolveTiles, claimant.player_id);
              if (!source) continue;
              cachedChevrons.push({
                targetQ: step.q, targetR: step.r,
                sourceQ: source.q, sourceR: source.r,
                color, stepIndex: i,
              });
            }
          }
          resolveChevronCacheRef.current = cachedChevrons;
          // Start chevron reveal animation (chevrons fade in before resolve overlay)
          setChevronAlpha(0);
          setChevronRevealPhase(true);
          // Initialize VP paths for all players (static/no pulse during resolve)
          setResolveLogEntries([]);
          const allVpPaths: VpPath[] = [];
          for (const pid of gameState.player_order) {
            const color = PLAYER_COLORS[pid] ?? 0xffffff;
            allVpPaths.push(...computePlayerVpPaths(preResolveTiles, pid, color).map(p => ({ ...p, noPulse: true })));
          }
          if (allVpPaths.length > 0) {
            setVpPaths(allVpPaths);
            setVpPathPhase('fading_in');
          }
        } else if (!animationOff) {
          // No claim steps but animations on — show reveal banner, then transition to buy
          setInteractionBlocked(true);
          setBannerSubtitle('Battle & Expand');
          setPhaseBanner('reveal');
        } else {
          // Animations off — apply final state immediately
          onStateUpdate(result.state);
          resolveFinishedStateRef.current = null;
          setActivePlayerIndex(0);
        }
      } else {
        // Not all plans submitted yet — just apply the updated state
        onStateUpdate(result.state);
        const nextIndex = gameState.player_order.findIndex(
          (pid, i) => i !== activePlayerIndex && !gameState.players[pid].has_submitted_plan,
        );
        if (nextIndex >= 0) setActivePlayerIndex(nextIndex);
        setSelectedCardIndex(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState, activePlayerId, activePlayerIndex, onStateUpdate, animationOff]);

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
          setActivePlayerIndex(0);
          setSelectedCardIndex(null);
        }
      } else {
        // Not all players done — switch to next unfinished player
        onStateUpdate(result.state);
        const nextIndex = gameState.player_order.findIndex(
          (pid, i) => i !== activePlayerIndex && !result.state.players[pid].has_ended_turn,
        );
        if (nextIndex >= 0) setActivePlayerIndex(nextIndex);
        setSelectedCardIndex(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState, activePlayerId, activePlayerIndex, onStateUpdate, animationMode, activePlayer]);

  const handleDiscardAllComplete = useCallback(() => {
    setDiscardingAll(false);
    if (pendingStateRef.current) {
      onStateUpdate(pendingStateRef.current);
      pendingStateRef.current = null;
    }
    setActivePlayerIndex(0);
    setSelectedCardIndex(null);
  }, [onStateUpdate]);

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
      // Show shuffle animation for 2s (normal) or 0.8s (simplified), then transition to draw
      const duration = animated ? 2000 : 800;
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

  // Phase banner completed
  const handleBannerComplete = useCallback(() => {
    const bannerPhase = phaseBanner;

    // Upkeep banner finished → advance to PLAN via API, then show PLAN banner
    if (bannerPhase === 'upkeep') {
      api.advanceUpkeep(gameState.id).then(result => {
        onStateUpdate(result.state);
        // Chain into the plan banner
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
      // apply the held-back state and immediately show the buy banner.
      if (resolveFinishedStateRef.current) {
        onStateUpdate(resolveFinishedStateRef.current);
        resolveFinishedStateRef.current = null;
      }
      setActivePlayerIndex(0);
      // Switch directly to buy banner (bump key to force remount)
      setBannerSubtitle('Grow Your Deck');
      setPhaseBanner('buy');
      setBannerKey(k => k + 1);
      // Keep interactionBlocked = true through the buy banner
      return;
    }

    setPhaseBanner(null);
    // If resolving, don't unblock interactions yet — resolve overlay will do that
    if (!resolving) {
      setInteractionBlocked(false);
      // Auto-open shop after buy banner completes
      if (bannerPhase === 'buy') {
        setShowShopOverlay(true);
      }
    }
  }, [resolving, phaseBanner, onStateUpdate]);

  // Phase banner midpoint — start drawing cards if it's start_of_turn
  const handleBannerMidpoint = useCallback(() => {
    // Card drawing is handled by the state update, which has already been applied.
    // The banner just delays interaction, so nothing special at midpoint currently.
  }, []);

  // Transition from resolve to buy phase (called after effects popup or directly)
  const finishResolveAndShowBuy = useCallback(() => {
    setActivePlayerEffects([]);
    if (!animationOff) {
      setBannerSubtitle('Grow Your Deck');
      setPhaseBanner('buy');
      setInteractionBlocked(true);
    } else {
      setInteractionBlocked(false);
      setShowShopOverlay(true);
    }
  }, [animationOff]);

  // Resolve animation completed — apply final state and move to buy phase
  const handleResolveComplete = useCallback(() => {
    setResolving(false);
    setResolutionSteps([]);
    setResolveDisplayState(null);
    setResolvedUpToStep(-1);
    setCurrentStepFade(1);
    resolveChevronCacheRef.current = [];
    const finishedState = resolveFinishedStateRef.current;
    if (finishedState) {
      onStateUpdate(finishedState);
      resolveFinishedStateRef.current = null;
    }
    setActivePlayerIndex(0);
    // Fade out VP paths and clear resolve log
    if (vpPaths.length > 0) {
      vpPathFadeStartAlphaRef.current = vpPaths[0]?.alpha ?? 1;
      setVpPathPhase('fading_out');
    }
    setResolveLogEntries([]);

    // Show player effect popups if any (e.g. Sabotage forced discards)
    const effects = finishedState?.player_effects;
    if (effects && effects.length > 0 && !animationOff) {
      setActivePlayerEffects(effects);
      // Auto-dismiss after 2.5 seconds, then show buy banner
      setTimeout(() => {
        finishResolveAndShowBuy();
      }, 2500);
    } else {
      finishResolveAndShowBuy();
    }
  }, [onStateUpdate, animationOff, vpPaths, finishResolveAndShowBuy]);

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

  const handleSwitchPlayer = useCallback((index: number) => {
    setActivePlayerIndex(index);
    setSelectedCardIndex(null);
    setError(null);
  }, []);

  const selectedCard = selectedCardIndex !== null ? activePlayer?.hand[selectedCardIndex] : null;

  // Submit Plan button state
  const submitHasCardsLeft = activePlayer ? activePlayer.hand.length > 0 : false;
  const submitActionsLeft = activePlayer ? activePlayer.actions_available - activePlayer.actions_used : 0;
  const submitAtCap = activePlayer ? activePlayer.actions_used >= 6 : false;
  const submitCanStillPlay = submitHasCardsLeft && submitActionsLeft > 0 && !submitAtCap;

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
    <div style={{ display: 'flex', height: '100vh', background: '#1a1a2e', color: '#fff' }}>
      {/* Left panel: players + log + settings */}
      <div style={{ width: 260, padding: 12, borderRight: '1px solid #333', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>
            Round {gameState.current_round} · {phase.replace(/_/g, ' ').toUpperCase()} · ★ {gameState.vp_target} VP
          </div>
          {gameState.winner && (
            <div style={{
              padding: 8, background: '#4a9eff33', borderRadius: 6, fontWeight: 'bold',
              transition: animated ? 'all 0.3s' : 'none',
            }}>
              ★ {gameState.players[gameState.winner]?.name} wins!
            </div>
          )}
        </div>

        {/* Player tabs */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>PLAYERS (click to switch)</div>
          {gameState.player_order.map((pid, i) => {
            const p = gameState.players[pid];
            // During plan phase, played cards leave the hand but aren't in discard yet —
            // they're in planned_actions, so add those. After resolve they move to discard,
            // but planned_actions isn't cleared until next turn, so don't double-count.
            const pInPlay = phase === 'plan' ? (p.planned_actions?.filter(a => a.target_q != null).length ?? 0) : 0;
            const pTotal = p.hand_count + p.deck_size + p.discard_count + pInPlay;
            const pTiles = Object.values(gameState.grid.tiles).filter(t => t.owner === pid).length;
            return (
              <div key={pid} onClick={() => handleSwitchPlayer(i)} style={{ cursor: 'pointer', marginBottom: 6 }}>
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

        <div style={{ flex: 1, minHeight: 0 }}>
          <GameLog entries={resolveLogEntries.length > 0 ? [...gameState.log, ...resolveLogEntries] : gameState.log} />
        </div>

        <button
          onClick={() => setShowFullLog(true)}
          style={{
            width: '100%',
            padding: '6px 0',
            margin: '8px 0',
            background: '#2a2a3e',
            border: '1px solid #444',
            borderRadius: 4,
            color: '#aaa',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Full Game Log
        </button>

        {/* Collapsible settings */}
        <div style={{ borderTop: '1px solid #333', paddingTop: 4 }}>
          <button
            onClick={() => setSettingsExpanded(e => !e)}
            style={{
              background: 'none',
              border: 'none',
              color: '#666',
              cursor: 'pointer',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 0',
            }}
          >
            <span style={{ fontSize: 15 }}>⚙️</span>
            <span>{settingsExpanded ? 'Hide Settings' : 'Settings'}</span>
          </button>
          {settingsExpanded && <SettingsPanel />}
        </div>

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
                {/* Give card to active player */}
                <div>
                  <div style={{ color: '#888', marginBottom: 2 }}>Give card to {activePlayer?.name}:</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      value={testCardId}
                      onChange={e => setTestCardId(e.target.value)}
                      placeholder="card_id"
                      style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }}
                    />
                    <button
                      onClick={() => { if (testCardId) handleTestGiveCard(testCardId); }}
                      style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                    >
                      Give
                    </button>
                  </div>
                </div>

                {/* Set VP */}
                <div>
                  <div style={{ color: '#888', marginBottom: 2 }}>Set {activePlayer?.name} VP:</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      type="number"
                      value={testVp}
                      onChange={e => setTestVp(e.target.value)}
                      placeholder={String(activePlayer?.vp ?? 0)}
                      style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }}
                    />
                    <button
                      onClick={() => { if (testVp !== '') handleTestSetStats(Number(testVp), undefined); }}
                      style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}
                    >
                      Set
                    </button>
                  </div>
                </div>

                {/* Set Resources */}
                <div>
                  <div style={{ color: '#888', marginBottom: 2 }}>Set {activePlayer?.name} Resources:</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      type="number"
                      value={testResources}
                      onChange={e => setTestResources(e.target.value)}
                      placeholder={String(activePlayer?.resources ?? 0)}
                      style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }}
                    />
                    <button
                      onClick={() => { if (testResources !== '') handleTestSetStats(undefined, Number(testResources)); }}
                      style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}
                    >
                      Set
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Center: hex grid + overlays */}
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
              disableHover={!!(showIntro || detailCard || showFullLog || showDeckViewer || showCardBrowser || showShopOverlay || showUpgradePreview || phaseBanner)}
            />
          )}

          {/* Top-right action buttons: Cards, Deck & Shop */}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 8, zIndex: 210 }}>
            <button
              onClick={() => { setShowCardBrowser(true); }}
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
              📖 Cards
            </button>
            <button
              onClick={() => { setShowDeckViewer(true); setShowShopOverlay(false); }}
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
              Deck ({totalDeckCount})
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
                ...(phase === 'buy' && !showShopOverlay && !activePlayer?.has_ended_turn ? {
                  animation: animationMode !== 'off' ? 'shopPulse 2s ease-in-out infinite' : undefined,
                  boxShadow: '0 0 12px rgba(74, 158, 255, 0.6)',
                  borderColor: '#4a9eff',
                } : {}),
              }}
            >
              Shop
            </button>
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

          {/* Upkeep indicator — top-left of grid view */}
          {(phase === 'plan' || phase === 'buy') && activePlayer && !resolving && gameState.current_round > 0 && (
            <div style={{ position: 'absolute', top: 10, left: 12, zIndex: 20 }}>
              <Tooltip content={`To maintain your ${playerTileCount} occupied tile${playerTileCount !== 1 ? 's' : ''}, you must pay ${currentUpkeep} resource${currentUpkeep !== 1 ? 's' : ''} before your next Plan phase.`}>
                <div
                  style={{
                    fontSize: 13,
                    color: upkeepMightIncrease ? '#ffaa33' : '#aaa',
                    textShadow: '0 1px 4px rgba(0,0,0,0.8)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: 'help',
                    background: 'rgba(10, 10, 20, 0.6)',
                    padding: '4px 10px',
                    borderRadius: 6,
                  }}>
                  <span style={{ fontSize: 11, color: '#777', marginRight: 2 }}>Upkeep:</span>
                  <span style={{
                    fontWeight: upkeepMightIncrease ? 'bold' : 'normal',
                    color: upkeepMightIncrease ? '#ffaa33' : '#aaa',
                    textShadow: upkeepMightIncrease
                      ? '0 0 8px rgba(255,170,51,0.6), 0 1px 4px rgba(0,0,0,0.8)'
                      : '0 1px 4px rgba(0,0,0,0.8)',
                  }}>
                    💰 {currentUpkeep}
                  </span>
                  <span style={{ fontSize: 11, color: '#777' }}>
                    ({upkeepBracketLow}–{upkeepBracketHigh} tiles)
                  </span>
                  {upkeepMightIncrease && (
                    <span style={{ fontSize: 11, color: '#ffaa33', fontWeight: 'bold' }}>
                      ⚠ may increase
                    </span>
                  )}
                </div>
              </Tooltip>
            </div>
          )}

          {/* Bottom bar: action counter (left) + buttons (right) */}
          <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12, display: 'flex', alignItems: 'center', gap: 8, zIndex: 20 }}>
            {/* Action counter — left aligned */}
            {phase === 'plan' && activePlayer && !resolving && (
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
              }}>
                <span style={{ fontSize: 16, fontWeight: 'bold', color: submitActionsLeft > 0 ? '#fff' : '#666', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                  ⚡ {submitActionsLeft}
                </span>
                <span style={{ fontSize: 12, color: '#aaa', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                  action{submitActionsLeft !== 1 ? 's' : ''} remaining
                </span>
                {submitAtCap && (
                  <span style={{ fontSize: 10, color: '#ff6666', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                    (cap reached)
                  </span>
                )}
              </div>
            )}
            <div style={{ flex: 1 }} />
            {/* Buttons — right aligned */}
            {/* Upgrade button — shown when a card is selected during plan phase */}
            {phase === 'plan' && activePlayer && !resolving && selectedCard && selectedCardIndex !== null &&
              !selectedCard.is_upgraded && hasUpgradePreview(selectedCard) &&
              (activePlayer.upgrade_credits > 0 || gameState.test_mode) && surgeCardIndex === null && (
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
                  style={{
                    padding: '6px 14px',
                    background: '#7a4acc',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 13,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  Upgrade ({activePlayer.upgrade_credits})
                </button>
              </div>
            )}
            {phase === 'plan' && activePlayer && !resolving && selectedCard?.card_type === 'engine' && surgeCardIndex === null && (
              <IrreversibleButton
                onClick={handlePlayEngine}
                tooltip="Playing a card uses an action and cannot be undone."
                style={{
                  padding: '6px 14px',
                  background: '#4a9eff',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
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
                      padding: '6px 12px',
                      background: '#555',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 13,
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
                      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    }}
                  >
                    Confirm {label}
                  </IrreversibleButton>
                </>
              );
            })()}
            {phase === 'plan' && activePlayer && !resolving && surgeCardIndex === null && (
              <HoldToSubmitButton
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
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                Resolving...
              </button>
            )}
            {phase === 'buy' && activePlayer && !resolving && !activePlayer.has_ended_turn && (
              <IrreversibleButton
                onClick={handleEndTurn}
                tooltip="Ending the turn advances to the next round. Any unspent resources carry over."
                style={{
                  padding: '6px 16px',
                  background: '#ff8844',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                End Turn →
              </IrreversibleButton>
            )}
            {phase === 'buy' && activePlayer && !resolving && activePlayer.has_ended_turn && (
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
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                ✓ Turn Ended
              </button>
            )}
          </div>
        </div>

        {/* Bottom panel: hand */}
        <div style={{ padding: '8px 12px', flexShrink: 0, overflow: 'hidden' }}>
          {activePlayer && (
            <CardHand
              playerId={activePlayerId}
              cards={introSequence === 'overlay' || introSequence === 'shuffle' ? [] : activePlayer.hand}
              selectedIndex={selectedCardIndex}
              onSelect={(idx) => { setSelectedCardIndex(idx); setDragHintHidden(true); }}
              onDragPlay={handleDragPlay}
              onCardDetail={setDetailCard}
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
            />
          )}
        </div>
      </div>

      {/* Card detail modal */}
      {detailCard && (
        <CardDetail card={detailCard} onClose={() => setDetailCard(null)} />
      )}

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

      {/* Player effect popups (e.g. Sabotage forced discard) — shown over target base tiles */}
      {activePlayerEffects.length > 0 && (() => {
        const transform = gridTransformRef.current;
        const rect = gridContainerRef.current?.getBoundingClientRect();
        if (!transform || !rect) return null;
        // Find base tiles for targets
        const tiles = gameState.grid?.tiles ?? {};
        return activePlayerEffects.map((effect, i) => {
          // Find target player's base tile
          const baseTile = Object.values(tiles).find(t => t.is_base && t.base_owner === effect.target_player_id);
          if (!baseTile) return null;
          const local = axialToPixel(baseTile.q, baseTile.r);
          const screenX = local.x * transform.scale + transform.offsetX + rect.left;
          const screenY = local.y * transform.scale + transform.offsetY + rect.top;
          const sourceColor = PLAYER_COLORS[effect.source_player_id];
          const colorStr = sourceColor !== undefined
            ? `#${sourceColor.toString(16).padStart(6, '0')}`
            : '#fff';
          return (
            <div
              key={i}
              style={{
                position: 'fixed',
                left: screenX,
                top: screenY - 40,
                transform: 'translateX(-50%)',
                zIndex: 15000,
                pointerEvents: 'none',
                animation: 'playerEffectPopup 2.5s ease-out forwards',
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
