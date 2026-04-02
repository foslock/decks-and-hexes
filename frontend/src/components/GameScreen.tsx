import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { GameState, Card, ResolutionStep } from '../types/game';
import HexGrid, { type GridTransform, type PlannedActionIcon, type ClaimChevron, PLAYER_COLORS } from './HexGrid';
import PlayerHud from './PlayerHud';
import CardHand, { CardViewPopup, type PlayTarget } from './CardHand';
import CardDetail from './CardDetail';
import ShopOverlay from './ShopOverlay';
import GameLog from './GameLog';
import FullGameLog from './FullGameLog';
import SettingsPanel from './SettingsPanel';
import PhaseBanner from './PhaseBanner';
import ResolveOverlay from './ResolveOverlay';
import { useAnimated, useAnimationMode, useAnimationOff } from './SettingsContext';
import { IrreversibleButton, HoldToSubmitButton } from './Tooltip';
import * as api from '../api/client';

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
  const [showFullLog, setShowFullLog] = useState(false);
  const [showDeckViewer, setShowDeckViewer] = useState(false);
  const [showShopOverlay, setShowShopOverlay] = useState(false);
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
    // Don't show banner if currently resolving (resolve has its own banner flow)
    if (resolving) return;
    // Don't trigger if a banner is already active (e.g. reveal→buy chain)
    if (phaseBanner) return;
    // Only show banners for main phases, and skip if animations are off
    const bannerPhases = ['plan', 'buy'];
    if (bannerPhases.includes(phase) && !animationOff) {
      setPhaseBanner(phase);
      setInteractionBlocked(true);
    }
  }, [phase, animationOff, resolving, phaseBanner]);

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

  const playCardAtTile = useCallback(async (cardIndex: number, q: number, r: number, extraTargets?: [number, number][]) => {
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
      const result = await api.playCard(gameState.id, activePlayerId, cardIndex, q, r, undefined, extraTargets);
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
        } else if (!animationOff) {
          // No claim steps but animations on — show reveal banner, then transition to buy
          setInteractionBlocked(true);
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

  // Phase banner completed
  const handleBannerComplete = useCallback(() => {
    const bannerPhase = phaseBanner;

    if (bannerPhase === 'reveal' && !resolving) {
      // Reveal banner finished but no resolution steps to animate —
      // apply the held-back state and immediately show the buy banner.
      if (resolveFinishedStateRef.current) {
        onStateUpdate(resolveFinishedStateRef.current);
        resolveFinishedStateRef.current = null;
      }
      setActivePlayerIndex(0);
      // Switch directly to buy banner (bump key to force remount)
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

  // Resolve animation completed — apply final state and move to buy phase
  const handleResolveComplete = useCallback(() => {
    setResolving(false);
    setResolutionSteps([]);
    setResolveDisplayState(null);
    setResolvedUpToStep(-1);
    setCurrentStepFade(1);
    resolveChevronCacheRef.current = [];
    if (resolveFinishedStateRef.current) {
      onStateUpdate(resolveFinishedStateRef.current);
      resolveFinishedStateRef.current = null;
    }
    setActivePlayerIndex(0);
    // Show the buy phase banner after resolution (which will open the shop when it completes)
    if (!animationOff) {
      setPhaseBanner('buy');
      setInteractionBlocked(true);
    } else {
      setInteractionBlocked(false);
      setShowShopOverlay(true);
    }
  }, [onStateUpdate, animationOff]);

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
      return { ...prev, grid: { ...prev.grid, tiles: newTiles } };
    });
  }, [resolutionSteps]);

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
  const inPlayCards = useMemo(() => {
    if (!activePlayer?.planned_actions) return [];
    return activePlayer.planned_actions
      .filter(a => a.target_q != null)
      .map(a => a.card);
  }, [activePlayer?.planned_actions]);

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
            Round {gameState.current_round} · Phase: {phase.replace(/_/g, ' ').toUpperCase()}
          </div>
          {gameState.winner && (
            <div style={{
              padding: 8, background: '#4a9eff33', borderRadius: 6, fontWeight: 'bold',
              transition: animated ? 'all 0.3s' : 'none',
            }}>
              🏆 {gameState.players[gameState.winner]?.name} wins!
            </div>
          )}
        </div>

        {/* Player tabs */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>PLAYERS (click to switch)</div>
          {gameState.player_order.map((pid, i) => {
            const p = gameState.players[pid];
            const pPlanned = p.planned_actions?.length ?? 0;
            const pTotal = p.hand_count + p.deck_size + p.discard_count + pPlanned;
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
          <GameLog entries={gameState.log} />
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

        <SettingsPanel />

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
            />
          )}

          {/* Top-right action buttons: Deck & Shop */}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 8, zIndex: 210 }}>
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
              cards={activePlayer.hand}
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

      {/* Phase banner — full-screen announcement */}
      {phaseBanner && (
        <PhaseBanner
          key={bannerKey}
          phase={phaseBanner}
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

      {/* Keyframes for shop pulse glow */}
      <style>{`
        @keyframes shopPulse {
          0%, 100% { box-shadow: 0 0 8px rgba(74, 158, 255, 0.4); }
          50% { box-shadow: 0 0 20px rgba(74, 158, 255, 0.8), 0 0 40px rgba(74, 158, 255, 0.3); }
        }
      `}</style>
    </div>
  );
}
