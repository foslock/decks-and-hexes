import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Vector3 } from 'three';
import type { Card, HexTile } from '../types/game';
import { useAnimationSpeed, useTooltips, useVisualQuality } from './SettingsContext';
import CompactCard, { COMPACT_CARD_WIDTH } from './CompactCard';
import type { IconName } from '../icons/glyphs';
import { ACTION_SIZE, BoardLabelRow, TILE_SIZE, defenseRow, ownerLabelColor, row, type LabelRow } from './BoardLabel';
import { cursor } from '../utils/cursors';
import { HEX_DIRS, type GridTransform } from '../utils/hexGeometry';
import { BoardEngine, type CameraShot, type CameraView } from '../board3d/engine';
import { CARD_FULL_HEIGHT } from './CardFull';
import { boardCardScale } from './BoardCards';
import { TOKEN_LABEL_LIFT, type TokenKind, type TokenSpec } from '../board3d/markers';
import { useSound } from '../audio/useSound';
import {
  PLAYER_COLORS, computeStackingPowerBonus,
  type BoardFx, type ClaimChevron, type PlannedActionIcon, type PlayerInfo, type VpPath,
} from '../board3d/boardTypes';

export {
  PLAYER_COLORS, cssHexToNumber, syncPlayerColors, computeStackingPowerBonus,
} from '../board3d/boardTypes';
export type {
  BoardFx, ClaimChevron, FxFortifyRing, PlannedActionIcon, VpPath,
} from '../board3d/boardTypes';
export type { GridTransform } from '../utils/hexGeometry';

/** Imperative camera controls exposed to the game screen (buttons + hotkeys). */
/** Where a tile's card stack sits: above a label this high (world units over
 *  the tile) with this many rows. */
interface Perch { lift: number; rows: number }

export interface BoardControls {
  rotate(dir: 1 | -1): void;
  toggleTilt(): void;
  resetView(): void;
  zoom(factor: number): void;
  /** Scripted camera glide (the tutorial). */
  flyTo(shot: CameraShot): void;
  /** The current framing, and a glide back to one. */
  getView(current?: boolean): CameraView | null;
  setView(view: CameraView, seconds?: number): void;
  /** Close in on a tile, keeping the board's orbit. */
  focusTile(key: string, shot: { zoom: number; tilt: number; lower?: number; seconds?: number; arc?: number }): void;
  /** Where a tile's card stack sits on screen — its bottom-center, or its
   *  top-center when it hangs below the tile (`below`, near the board's top
   *  edge) — and the board's label zoom. Lets a played card land right on it.
   *  `landing`: the card about to land there — the stack is placed as it will
   *  be once that card's planned power / defense readout shows under it. */
  tileAnchor(key: string, landing?: { card: Card; type?: string }): { x: number; y: number; zoom: number; below: boolean } | null;
}

interface GameBoardProps {
  tiles: Record<string, HexTile>;
  onTileClick: (q: number, r: number, shiftKey?: boolean) => void;
  /** Called on pointerdown on any tile. */
  onTilePointerDown?: () => void;
  /** A click / tap that landed on empty board space (no drag) — e.g. deselect. */
  onEmptyClick?: () => void;
  highlightTiles?: Set<string>;
  /** Tiles where claim power is insufficient — shown with orange outline */
  weakHighlightTiles?: Set<string>;
  multiTileTargets?: [number, number][];
  playerInfo?: Record<string, PlayerInfo>;
  transformRef?: React.MutableRefObject<GridTransform | null>;
  borderTiles?: Set<string>;
  activePlayerId?: string;
  plannedActions?: Map<string, PlannedActionIcon>;
  /** Tiles that have played cards floating above them. */
  tileCardKeys?: string[];
  /** Renders a tile's card stack; `zoom` follows the board's zoom (≈1 at fit). */
  renderTileCards?: (tileKey: string, zoom: number) => React.ReactNode;
  /** Card currently selected or being dragged — used for hover preview on valid tiles */
  previewCard?: Card | null;
  /** All tiles the preview card can legally be played on */
  previewValidTiles?: Set<string>;
  /** War Banner: +power the active player's next Claim will consume (preview only). */
  previewClaimBuffBonus?: number;
  /** A claim's power on a tile from its own effects (hand size, tiles owned,
   *  cards played, the tile itself…) — the hover preview's number. */
  claimPowerOn?: (card: Card, tileKey: string) => number;
  /** Claim direction chevrons shown during play/reveal phases */
  claimChevrons?: ClaimChevron[];
  /** VP connection paths shown during resolve phase */
  vpPaths?: VpPath[];
  /** VP tile keys that are owned AND connected to the owner's base (filled star) */
  connectedVpTiles?: Set<string>;
  /** When true, suppress hover effects (highlight, tooltips) */
  disableHover?: boolean;
  /** Suppress tile tooltips but keep the hover outline + preview label (card drag). */
  suppressTileTooltips?: boolean;
  /** Tile keys to show pulsing outline (review mode — tiles with played cards) */
  reviewPulseTiles?: Set<string>;
  onTileHover?: (q: number, r: number, screenX: number, screenY: number) => void;
  onTileHoverEnd?: () => void;
  /** Build-in progress (0 = hidden, 1 = fully visible). Omit for instant render. */
  buildProgress?: number;
  /** Seat-relative board rotation in radians (the user can orbit on top). */
  gridRotation?: number;
  /** Stop rendering while a full-screen overlay covers the board. */
  paused?: boolean;
  /** Called when a tile is long-pressed (~500ms hold) — used for undo */
  onLongPress?: (q: number, r: number) => void;
  /** Tile keys where long-press triggers undo */
  undoableTiles?: Set<string>;
  /** Populated with the board's effects API — read by the resolve (TileResolver). */
  fxRef?: React.MutableRefObject<BoardFx | null>;
  /** Populated with camera controls for buttons / hotkeys. */
  controlsRef?: React.MutableRefObject<BoardControls | null>;
  /** Show the on-board camera control cluster. */
  showCameraControls?: boolean;
  /** The player can't move the camera (no drag, wheel or pinch) — a guided
   *  camera is telling the story (the tutorial). */
  cameraLocked?: boolean;
  /** Effective drag-cursor position in client coords while a card is dragged. */
  dragHoverPosition?: { clientX: number; clientY: number } | null;
  /** Draw the scene this many px past the bottom of the board's box (under
   *  the hand), so the water runs to the screen edge. */
  extendBelow?: number;
  /** Keep the fitted board this many px clear of the canvas's bottom edge. */
  viewInsetBottom?: number;
  /** Tile whose card row draws above every other row (the one resolving). */
  raisedTileKey?: string | null;
  /** Ring this tile (the one resolving) with a fading gold outline. */
  focusTileKey?: string | null;
  /** Leave this tile's defense readout to the resolve (it draws its own). */
  hideDefenseLabelKey?: string | null;
}

// ── Labels ──────────────────────────────────────────────────────────────

/** A tile's card row height: the size it's growing to (a resolving card
 *  eases up to it), else its current box. */
function stackHeight(el: HTMLElement | undefined): number {
  if (!el) return 0;
  const target = Number(el.querySelector<HTMLElement>('[data-stack-h]')?.dataset.stackH);
  return target || el.offsetHeight;
}

interface TileLabel { key: string; lift: number; rows: LabelRow[]; prominent?: boolean }

function effVal(card: Card, eff: { value: number; upgraded_value?: number }): number {
  return card.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
}

/** Classify a played / previewed card against a tile. */
function classify(card: Card, tile: HexTile, activePlayer: string | undefined, type?: string) {
  const isRubble = card.card_type === 'engine' && !!card.effects?.some(e => e.type === 'inject_rubble');
  const isPlayerTarget = card.card_type === 'engine' && (card.forced_discard > 0 || isRubble);
  const isAbandon = type ? type === 'abandon' : (card.card_type === 'engine' && card.target_own_tile);
  const isConsecrate = !!card.effects?.some(e => e.type === 'enhance_vp_tile');
  const isBlock = isAbandon && !!card.effects?.some(e => e.type === 'abandon_and_block');
  const isDefensive = !isPlayerTarget && !isAbandon && ((type ? type === 'defense' : card.card_type === 'defense') || tile.owner === activePlayer);
  return { isRubble, isPlayerTarget, isAbandon, isConsecrate, isBlock, isDefensive };
}

// ── Tooltips ────────────────────────────────────────────────────────────

/** Multi-card hover preview for tiles with planned actions (max 4 per column). */
function PlannedCardsPreview({ cards, x, y, undoable }: { cards: { card: Card; effectivePower?: number }[]; x: number; y: number; undoable?: boolean }) {
  const maxPerCol = 4;
  const colGap = 6;
  const rowGap = 4;
  const cardW = COMPACT_CARD_WIDTH + 14;
  const cardH = 47;
  const numCols = Math.ceil(cards.length / maxPerCol);
  const totalW = numCols * cardW + (numCols - 1) * colGap;
  let undoTargetIdx = -1;
  if (undoable) {
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].card.reversible) { undoTargetIdx = i; break; }
    }
  }
  const undoTargetCol = undoTargetIdx >= 0 ? Math.floor(undoTargetIdx / maxPerCol) : -1;
  const hintH = 18;
  const colHeights = Array.from({ length: numCols }, (_, col) => {
    const n = Math.min(cards.length - col * maxPerCol, maxPerCol);
    const base = n * cardH + (n - 1) * rowGap;
    return col === undoTargetCol ? base + hintH : base;
  });
  const totalH = Math.max(...colHeights);
  const margin = 14;
  let left = x + margin;
  let top = y - 10;
  if (left + totalW > window.innerWidth - 8) left = x - margin - totalW;
  if (top + totalH > window.innerHeight - 8) top = window.innerHeight - 8 - totalH;
  if (top < 8) top = 8;
  return (
    <div style={{ position: 'fixed', left, top, display: 'flex', gap: colGap, pointerEvents: 'none', zIndex: 20000 }}>
      {Array.from({ length: numCols }, (_, col) => {
        const colCards = cards.slice(col * maxPerCol, (col + 1) * maxPerCol);
        const undoRowIdx = col === undoTargetCol ? undoTargetIdx - col * maxPerCol : -1;
        return (
          <div key={col} style={{ display: 'flex', flexDirection: 'column', gap: rowGap }}>
            {colCards.map((entry, i) => {
              const hasFrozenPower = entry.effectivePower != null;
              const c = hasFrozenPower ? { ...entry.card, power: entry.effectivePower! } : entry.card;
              return (
                <React.Fragment key={i}>
                  <CompactCard card={c} subtitleContext={hasFrozenPower ? { powerFrozen: true } : undefined} />
                  {i === undoRowIdx && (
                    <div style={{ fontSize: 10, color: '#aaa', textAlign: 'center', marginTop: -2 }}>Hold to undo</div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const ARCHETYPE_LABELS: Record<string, string> = { vanguard: 'Vanguard', swarm: 'Swarm', fortress: 'Fortress' };

interface TooltipState {
  x: number; y: number;
  /** Viewport coords for the card preview portal. */
  cx: number; cy: number;
  text?: string;
  allCards?: { card: Card; effectivePower?: number }[];
  undoable?: boolean;
}

// ── Component ───────────────────────────────────────────────────────────

/** The 3D board. Antialiasing is fixed when a WebGL context is created, so
 *  changing the Visual Quality setting rebuilds the board's renderer. Low
 *  turns antialiasing off and renders at a 1x pixel ratio. */
export default function GameBoard(props: GameBoardProps) {
  const quality = useVisualQuality();
  return <GameBoardView key={quality} {...props} lowQuality={quality === 'low'} />;
}

function GameBoardView(props: GameBoardProps & { lowQuality: boolean }) {
  const {
    tiles, highlightTiles, weakHighlightTiles, multiTileTargets, playerInfo, transformRef, activePlayerId,
    plannedActions, previewCard, previewValidTiles, previewClaimBuffBonus, claimPowerOn, claimChevrons, vpPaths,
    connectedVpTiles, disableHover, suppressTileTooltips, reviewPulseTiles, buildProgress, gridRotation,
    paused, undoableTiles, fxRef, controlsRef, showCameraControls, cameraLocked = false, dragHoverPosition,
    tileCardKeys, renderTileCards, extendBelow = 0, viewInsetBottom = 0, raisedTileKey, focusTileKey, hideDefenseLabelKey,
  } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BoardEngine | null>(null);
  const [noWebgl, setNoWebgl] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipsEnabled = useTooltips();
  const animSpeed = useAnimationSpeed();
  const sound = useSound();
  const soundRef = useRef(sound);
  soundRef.current = sound;

  // Latest props for the engine's input callbacks (registered once).
  const live = useRef(props);
  live.current = props;
  const tooltipsRef = useRef(tooltipsEnabled);
  tooltipsRef.current = tooltipsEnabled;
  const hoveredRef = useRef<string | null>(null);
  const dragHoverActive = useRef(false);
  const dragWasActive = useRef(false);
  const [ready, setReady] = useState(false);
  const press = useRef<{ key: string; x: number; y: number; start: number; raf: number; fired: boolean; touch: boolean; undo: boolean } | null>(null);

  // Stable BoardFx proxy so callers never hold a stale layer reference.
  const fxProxy = useMemo<BoardFx>(() => {
    const fx = () => engineRef.current?.fx ?? null;
    const noopRing = { setProgress() {}, flash() {}, shatter() {}, setAlpha() {}, destroy() {} };
    return {
      createFortifyRing: (q, r) => fx()?.createFortifyRing(q, r) ?? noopRing,
      sparks: (...a) => fx()?.sparks(...a),
      dust: (...a) => fx()?.dust(...a),
      shockwave: (...a) => fx()?.shockwave(...a),
      pillar: (...a) => fx()?.pillar(...a),
      shake: (...a) => fx()?.shake(...a),
      jolt: (...a) => fx()?.jolt(...a),
      captureBurst: (...a) => fx()?.captureBurst(...a),
      abandon: (...a) => fx()?.abandon(...a),
      scorch: (...a) => fx()?.scorch(...a),
      flood: (...a) => fx()?.flood(...a),
      setSpeed: (m) => engineRef.current?.setSpeed(m),
    };
  }, []);

  // ── Engine lifecycle ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new BoardEngine(host, props.lowQuality ? { antialias: false, maxPixelRatio: 1 } : {});
    if (!engine.ok) {
      setNoWebgl(true);
      return;
    }
    engineRef.current = engine;
    if (import.meta.env.DEV) (window as unknown as { __board?: BoardEngine }).__board = engine;
    engine.setOnFlagPlant((inMs) => soundRef.current.cue('flagPlant', inMs));
    if (transformRef) transformRef.current = engine.transform;
    if (fxRef) fxRef.current = fxProxy;
    if (controlsRef) {
      controlsRef.current = {
        rotate: (dir) => engine.rotateBy(dir * Math.PI / 6),
        toggleTilt: () => engine.toggleTilt(),
        resetView: () => engine.resetView(),
        zoom: (f) => engine.zoomBy(f),
        flyTo: (shot) => engine.flyTo(shot),
        getView: (current) => engine.getView(current),
        setView: (view, seconds) => engine.setView(view, seconds),
        focusTile: (key, shot) => engine.focusTile(key, shot),
        tileAnchor: (key, landing) => {
          const host = hostRef.current;
          const pt = { x: 0, y: 0 };
          if (!host) return null;
          const h = stackHeight(tileCardEls.current.get(key)) || CARD_FULL_HEIGHT * boardCardScale(labelScaleRef.current);
          const label = landing ? landingLabelRef.current(key, landing.card, landing.type) : undefined;
          const placed = placeStackRef.current(engine, key, h, pt, { ...perchTargetRef.current(key, label), below: stackPerch.current.get(key)?.below });
          if (placed === null) return null;
          const r = host.getBoundingClientRect();
          return { x: pt.x + r.left, y: pt.y + r.top, zoom: labelScaleRef.current, below: placed };
        },
      };
    }
    setReady(true);
    return () => {
      if (press.current?.raf) cancelAnimationFrame(press.current.raf);
      engine.dispose();
      engineRef.current = null;
      if (fxRef?.current === fxProxy) fxRef.current = null;
      if (controlsRef) controlsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) engineRef.current?.setInsetBottom(viewInsetBottom);
  }, [ready, viewInsetBottom]);

  useEffect(() => {
    if (ready) engineRef.current?.setFocusTile(focusTileKey ?? null);
  }, [ready, focusTileKey]);

  useEffect(() => {
    if (ready) engineRef.current?.setCameraInput(!cameraLocked);
  }, [ready, cameraLocked]);

  // ── State → engine ──
  useEffect(() => {
    engineRef.current?.setBoard(tiles, playerInfo, connectedVpTiles);
  }, [tiles, playerInfo, connectedVpTiles]);

  const multiKeys = useMemo(() => new Set((multiTileTargets ?? []).map(([q, r]) => `${q},${r}`)), [multiTileTargets]);
  useEffect(() => {
    engineRef.current?.setOverlay({
      highlight: highlightTiles, weak: weakHighlightTiles, multi: multiKeys,
      review: reviewPulseTiles, activePlayer: activePlayerId,
    });
  }, [highlightTiles, weakHighlightTiles, multiKeys, reviewPulseTiles, activePlayerId]);

  const tokens = useMemo<TokenSpec[]>(() => {
    if (!plannedActions || !activePlayerId) return [];
    const color = PLAYER_COLORS[activePlayerId] ?? 0xffffff;
    const out: TokenSpec[] = [];
    for (const [key, pa] of plannedActions) {
      const tile = tiles[key];
      if (!tile) continue;
      const c = classify(pa.card, tile, activePlayerId, pa.type);
      const kind: TokenKind = c.isConsecrate ? 'consecrate' : c.isAbandon ? 'abandon' : c.isPlayerTarget ? 'target' : c.isDefensive ? 'defense' : 'claim';
      out.push({ key, q: tile.q, r: tile.r, kind, color });
    }
    return out;
  }, [plannedActions, activePlayerId, tiles]);
  useEffect(() => { engineRef.current?.setTokens(tokens); }, [tokens]);
  useEffect(() => { engineRef.current?.setChevrons(claimChevrons); }, [claimChevrons]);
  useEffect(() => { engineRef.current?.setPaths(vpPaths); }, [vpPaths]);
  useEffect(() => { engineRef.current?.setRotation(gridRotation ?? 0); }, [gridRotation]);
  useEffect(() => { engineRef.current?.setBuildProgress(buildProgress); }, [buildProgress]);
  useEffect(() => { engineRef.current?.setPaused(!!paused); }, [paused]);
  useEffect(() => { engineRef.current?.setSpeed(animSpeed); }, [animSpeed]);

  // ── Hover / tooltip logic (ported 1:1 from the 2D grid) ──
  const hoverOut = useCallback(() => {
    if (!hoveredRef.current) return;
    hoveredRef.current = null;
    setHovered(null);
    engineRef.current?.setHover(null);
    setTooltip(null);
    live.current.onTileHoverEnd?.();
  }, []);

  const buildTooltip = useCallback((key: string, x: number, y: number, cx: number, cy: number): TooltipState | null => {
    const p = live.current;
    const tile = p.tiles[key];
    if (!tile) return null;
    if (p.suppressTileTooltips) return null;
    const planned = p.plannedActions?.get(key);
    const mtCard = p.previewCard;
    const isMulti = mtCard && p.multiTileTargets?.some(([sq, sr]) => `${sq},${sr}` === key);
    if (planned && p.undoableTiles?.has(key)) {
      return { x, y, cx, cy, text: 'Hold to undo' };
    }
    if (isMulti && mtCard) {
      const permDef = mtCard.effects?.find(e => e.type === 'permanent_defense');
      const defPow = permDef ? effVal(mtCard, permDef) : mtCard.defense_bonus;
      const power = mtCard.card_type === 'defense' ? defPow : mtCard.power;
      return { x, y, cx, cy, allCards: [{ card: mtCard, effectivePower: power }] };
    }
    if (!tooltipsRef.current) return null;
    const lines: string[] = [];
    if (tile.is_scorched) {
      lines.push('Scorched wasteland — burnt for the rest of the match. It cannot be claimed.');
    } else if (tile.is_blocked) {
      lines.push('This tile cannot be claimed.');
    } else {
      if (tile.is_base) {
        const basePersist = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
        const baseTemp = tile.defense_power - basePersist;
        const breakdown = baseTemp > 0 ? ` (${basePersist} persistent + ${baseTemp} temporary)` : '';
        lines.push(`Base tile — Defense ${tile.defense_power}${breakdown}. Can be raided for Spoils and Rubble.`);
      } else if (tile.is_vp) {
        lines.push(`VP Tile — worth ${tile.vp_value} VP when connected to your base.`);
      }
      if (tile.immune) {
        lines.push('Cannot be claimed by another player.');
      } else if (tile.defense_power > 0 && !tile.is_base) {
        const isNeutral = tile.owner == null;
        const persistDef = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
        const tmpDef = tile.defense_power - persistDef;
        const parts: string[] = [];
        if (persistDef > 0) parts.push(`${persistDef} persistent`);
        if (tmpDef > 0) parts.push(`${tmpDef} temporary`);
        const breakdown = parts.length > 1 ? ` (${parts.join(' + ')})` : '';
        lines.push(isNeutral
          ? `Neutral Defense: ${tile.defense_power}${breakdown}. Claiming requires at least ${tile.defense_power} power.`
          : `Defense: ${tile.defense_power}${breakdown}. Claiming requires at least ${tile.defense_power + 1} power.`);
      }
      if (tile.owner && p.playerInfo?.[tile.owner]) {
        const info = p.playerInfo[tile.owner];
        lines.push(`${info.name} (${ARCHETYPE_LABELS[info.archetype] || info.archetype})`);
        if (!tile.is_base && tile.held_since_turn != null) {
          lines.push(tile.held_since_turn === 0 ? `Occupied by ${info.name} since the start.` : `Occupied since Round ${tile.held_since_turn}`);
        }
      }
    }
    return lines.length ? { x, y, cx, cy, text: lines.join('\n') } : null;
  }, []);

  const hoverAt = useCallback((key: string | null, clientX: number, clientY: number) => {
    const p = live.current;
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (p.disableHover || !key || !p.tiles[key]) {
      hoverOut();
      return;
    }
    if (key === hoveredRef.current) {
      setTooltip(prev => prev ? { ...prev, x, y, cx: clientX, cy: clientY } : prev);
      return;
    }
    hoverOut();
    hoveredRef.current = key;
    setHovered(key);
    const tile = p.tiles[key];
    engineRef.current?.setHover(tile.is_blocked ? null : key);
    setTooltip(buildTooltip(key, x, y, clientX, clientY));
    const reviewing = (p.reviewPulseTiles?.size ?? 0) > 0;
    if (!reviewing || p.reviewPulseTiles?.has(key)) p.onTileHover?.(tile.q, tile.r, x, y);
  }, [buildTooltip, hoverOut]);

  const cancelPress = useCallback(() => {
    const pr = press.current;
    if (!pr) return;
    if (pr.raf) cancelAnimationFrame(pr.raf);
    press.current = null;
    engineRef.current?.setHold(0);
  }, []);

  // Engine input wiring (once).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setInputListener({
      onHover: (key, cx, cy, e) => {
        if (dragHoverActive.current && e.pointerType === 'touch') return;
        hoverAt(key, cx, cy);
      },
      onTileDown: (key, e) => {
        const p = live.current;
        const tile = p.tiles[key];
        if (!tile) return;
        p.onTilePointerDown?.();
        const undo = !!p.undoableTiles?.has(key);
        const touch = e.pointerType === 'touch';
        // Clicks fire on release (a drag orbits the camera instead).
        cancelPress();
        const pr = { key, x: e.clientX, y: e.clientY, start: performance.now(), raf: 0, fired: false, touch, undo };
        press.current = pr;
        if (undo) {
          const HOLD = 500;
          const tick = () => {
            if (press.current !== pr) return;
            const k = Math.min(1, (performance.now() - pr.start) / HOLD);
            engineRef.current?.setHold(k);
            if (k >= 1) {
              pr.fired = true;
              engineRef.current?.setHold(0);
              press.current = null;
              live.current.onLongPress?.(tile.q, tile.r);
              return;
            }
            pr.raf = requestAnimationFrame(tick);
          };
          pr.raf = requestAnimationFrame(tick);
        }
      },
      onTileUp: (key, e) => {
        const pr = press.current;
        if (!pr) return;
        cancelPress();
        if (pr.fired || key !== pr.key) return;
        const tile = live.current.tiles[key];
        if (tile) live.current.onTileClick(tile.q, tile.r, pr.touch ? false : e.shiftKey && !pr.undo);
      },
      onPointerMove: (e) => {
        const pr = press.current;
        if (!pr) return;
        const dx = e.clientX - pr.x, dy = e.clientY - pr.y;
        if (dx * dx + dy * dy > 100) cancelPress();
      },
      onLeave: (e) => {
        cancelPress();
        if (dragHoverActive.current && e.pointerType === 'touch') return;
        if (!dragHoverActive.current) hoverOut();
      },
      onGesture: () => {
        cancelPress();
        hoverOut();
      },
      onEmptyClick: () => {
        live.current.onEmptyClick?.();
      },
    });
  // engineRef is set in the lifecycle effect above (declared first).
  }, [hoverAt, hoverOut, cancelPress]);

  // Clear hover state when an overlay opens.
  useEffect(() => {
    if (disableHover) hoverOut();
  }, [disableHover, hoverOut]);

  useEffect(() => {
    if (suppressTileTooltips) setTooltip(null);
  }, [suppressTileTooltips]);

  // Drag-hover override: drive hover from the (finger-offset) drag cursor.
  useEffect(() => {
    dragHoverActive.current = dragHoverPosition != null;
    const engine = engineRef.current;
    const host = hostRef.current;
    if (!dragHoverPosition || !engine || !host) {
      if (!dragHoverPosition && hoveredRef.current && dragWasActive.current) hoverOut();
      dragWasActive.current = false;
      return;
    }
    dragWasActive.current = true;
    const rect = host.getBoundingClientRect();
    const x = dragHoverPosition.clientX - rect.left;
    const y = dragHoverPosition.clientY - rect.top;
    // The band drawn under the hand isn't a drop zone.
    if (x < 0 || y < 0 || x > rect.width || y > rect.height - extendBelow) {
      hoverOut();
      return;
    }
    hoverAt(engine.pickTile(x, y), dragHoverPosition.clientX, dragHoverPosition.clientY);
  });

  // Refresh a planned-action tooltip when the plan changes (e.g. after undo).
  useEffect(() => {
    const key = hoveredRef.current;
    if (!key) return;
    setTooltip(prev => {
      if (!prev || !prev.allCards) return prev;
      const pa = plannedActions?.get(key);
      if (!pa) return null;
      return { ...prev, allCards: pa.allCards, undoable: undoableTiles?.has(key) };
    });
  }, [plannedActions, undoableTiles]);

  // ── Labels ──
  const labels = useMemo<TileLabel[]>(() => {
    const out: TileLabel[] = [];
    const planned = plannedActions;
    const mtKeys = multiKeys;
    const mtCard = previewCard;
    for (const [key, tile] of Object.entries(tiles)) {
      if (tile.is_blocked) continue;
      const rows: LabelRow[] = [];
      let lift = tile.is_vp ? (tile.vp_value >= 2 ? 0.5 : 0.42) : tile.is_base ? 0.3 : 0.12;
      if (tile.is_vp) {
        const vpVal = tile.vp_value || 1;
        const connected = connectedVpTiles?.has(key) ?? false;
        const icon: IconName = connected ? 'vp' : 'vpOutline';
        const color = connected ? (vpVal >= 2 ? '#fff066' : '#ffd700') : '#9a9a9a';
        const size = vpVal === 1 ? 18 : vpVal <= 3 ? 15 : 13;
        rows.push(row(vpVal > 4 ? [{ text: `${vpVal}×` }, { icon }] : Array.from({ length: vpVal }, () => ({ icon })), size, color));
      }
      let main: LabelRow | null = null;
      // 1) Hover preview on a valid target
      const isHoverPreview = hovered === key && !!mtCard && !!previewValidTiles?.has(key);
      const isMulti = mtKeys.has(key) && !!mtCard;
      const pa = planned?.get(key);
      if (isHoverPreview && mtCard) {
        main = previewRow(mtCard, tile, key);
      } else if (isMulti && mtCard) {
        main = multiRow(mtCard, tile, key);
      } else if (pa) {
        main = plannedRow(pa, tile);
      } else if (tile.defense_power > 0 || tile.immune) {
        const persist = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
        // Tinted to the owner so whose defense it is reads at a glance.
        const color = ownerLabelColor(tile.owner ? PLAYER_COLORS[tile.owner] : undefined);
        main = defenseRow(persist, tile.defense_power - persist, !!tile.immune, TILE_SIZE, undefined, color);
      }
      if (pa && activePlayerId) {
        const c = classify(pa.card, tile, activePlayerId, pa.type);
        const kind: TokenKind = c.isConsecrate ? 'consecrate' : c.isAbandon ? 'abandon' : c.isPlayerTarget ? 'target' : c.isDefensive ? 'defense' : 'claim';
        lift = Math.max(lift, TOKEN_LABEL_LIFT[kind]);
      }
      if (main && key !== hideDefenseLabelKey) rows.push(main);
      if (rows.length) out.push({ key, lift, rows, prominent: !!pa || isHoverPreview || isMulti });
    }
    return out;

    function previewRow(card: Card, tile: HexTile, key: string): LabelRow {
      const c = classify(card, tile, activePlayerId);
      if (c.isConsecrate) return row([{ text: '+' }, { icon: 'vp' }], ACTION_SIZE, '#ffd700', 0.75);
      if (c.isAbandon) return row([{ icon: c.isBlock ? 'mountain' : 'abandon' }], 20, '#ff9944', 0.75);
      if (c.isRubble) return row([{ icon: 'rubble' }], ACTION_SIZE, '#ff6666', 0.75);
      if (c.isPlayerTarget) return row([{ icon: 'opponent' }], 16, '#ff6666', 0.75);
      const permDef = card.effects?.find(e => e.type === 'permanent_defense');
      const defPower = permDef ? effVal(card, permDef) : card.defense_bonus;
      const isImmunity = !!card.effects?.some(e => e.type === 'tile_immunity');
      const claimPower = card.card_type === 'claim' ? claimPowerOn : undefined;
      let base = card.card_type === 'defense' ? defPower : claimPower ? claimPower(card, key) : card.power;
      for (const eff of claimPower ? [] : card.effects ?? []) {
        if (eff.type !== 'power_modifier') continue;
        const mod = effVal(card, eff);
        if (eff.condition === 'if_defending_owned' && tile.owner === activePlayerId) base += mod;
        if (eff.condition === 'if_target_has_defense' && tile.defense_power > 0) base += mod;
        if (eff.condition === 'if_contested') base += mod;
        if (eff.condition === 'if_target_neutral' && !tile.owner) base += mod;
        if (eff.condition === 'if_adjacent_owned_gte') {
          const threshold = eff.condition_threshold ?? 3;
          let adj = 0;
          for (const [dq, dr] of HEX_DIRS) if (tiles[`${tile.q + dq},${tile.r + dr}`]?.owner === activePlayerId) adj++;
          if (eff.metadata?.per_tile) base += mod * adj;
          else if (adj >= threshold) base += mod;
        }
      }
      const buff = card.card_type === 'claim' ? (previewClaimBuffBonus ?? 0) : 0;
      let power = base + buff;
      let adds = false;
      const existing = plannedActions?.get(key);
      if (existing && card.card_type === 'claim') {
        const claims = existing.allCards.filter(ac => ac.card.card_type === 'claim').map(ac => ac.card);
        if (claims.length > 0) {
          // What this card adds to the stack: its own power plus any change
          // in Dog Pile-style stacking bonuses.
          adds = true;
          power = base + buff + computeStackingPowerBonus([...claims, card]) - computeStackingPowerBonus(claims);
        }
      }
      const persist = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
      if (isImmunity) return defenseRow(persist, 0, true, ACTION_SIZE, 0.75);
      if (!c.isDefensive) return row([{ icon: 'power' }, { text: adds ? `+${power}` : `${power}` }], ACTION_SIZE, '#fff', 0.75);
      if (permDef) return defenseRow(persist + power, 0, false, ACTION_SIZE, 0.75);
      return defenseRow(persist, power, false, ACTION_SIZE, 0.75);
    }

    function multiRow(card: Card, tile: HexTile, key: string): LabelRow {
      const isDefenseCard = card.card_type === 'defense';
      const permDef = card.effects?.find(e => e.type === 'permanent_defense');
      const isImmunity = !!card.effects?.some(e => e.type === 'tile_immunity');
      const defPower = permDef ? effVal(card, permDef) : card.defense_bonus;
      const cardPower = isDefenseCard ? defPower : card.card_type === 'claim' && claimPowerOn ? claimPowerOn(card, key) : card.power;
      const buff = card.card_type === 'claim' ? (previewClaimBuffBonus ?? 0) : 0;
      let power = cardPower + buff;
      const existing = plannedActions?.get(key);
      if (existing && card.card_type === 'claim') {
        const claims = existing.allCards.filter(ac => ac.card.card_type === 'claim').map(ac => ac.card);
        power = existing.power + cardPower + buff + computeStackingPowerBonus([...claims, card]) - computeStackingPowerBonus(claims);
      }
      const isDefensive = isDefenseCard || tile.owner === activePlayerId;
      const persist = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
      if (!isDefensive) return row([{ icon: 'power' }, { text: `${power}` }], ACTION_SIZE, '#fff', 0.75);
      if (isImmunity) return defenseRow(persist, 0, true, ACTION_SIZE, 0.75);
      if (permDef) return defenseRow(persist + power, 0, false, ACTION_SIZE, 0.75);
      return defenseRow(persist, power, false, ACTION_SIZE, 0.75);
    }

    function plannedRow(pa: PlannedActionIcon, tile: HexTile): LabelRow {
      const c = classify(pa.card, tile, activePlayerId, pa.type);
      if (c.isConsecrate) return row([{ text: '+' }, { icon: 'vp' }], ACTION_SIZE, '#ffd700');
      if (c.isAbandon) return row([{ icon: c.isBlock ? 'mountain' : 'abandon' }], 20, '#ff9944');
      if (c.isRubble) return row([{ icon: 'rubble' }], ACTION_SIZE, '#ff6666');
      if (c.isPlayerTarget) return row([{ icon: 'opponent' }], 16, '#ff6666');
      if (!c.isDefensive) {
        const claims = pa.allCards.filter(ac => ac.card.card_type === 'claim').map(ac => ac.card);
        return row([{ icon: 'power' }, { text: `${pa.power + computeStackingPowerBonus(claims)}` }], ACTION_SIZE);
      }
      const hasImmunity = pa.allCards.some(ac => ac.card.effects?.some(e => e.type === 'tile_immunity'));
      const persist = tile.base_defense + (tile.permanent_defense_bonus ?? 0) + pa.permanentDefPower;
      return defenseRow(persist, hasImmunity ? 0 : pa.tempDefPower, hasImmunity, ACTION_SIZE);
    }
  }, [tiles, plannedActions, multiKeys, previewCard, previewValidTiles, previewClaimBuffBonus, claimPowerOn, connectedVpTiles, hovered, activePlayerId, hideDefenseLabelKey]);

  // Position labels every rendered frame.
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const [labelScale, setLabelScale] = useState(1);
  const labelScaleRef = useRef(1);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const tmp = { x: 0, y: 0 };
    const foot = { x: 0, y: 0 };
    const center = new Vector3();
    return engine.onFrame(() => {
      const tf = engine.tiltFactor;
      const ppu = engine.pixelsPerUnitAt(center);
      const s = Math.max(0.6, Math.min(1.7, ppu / 40));
      if (Math.abs(s - labelScaleRef.current) > 0.04) {
        labelScaleRef.current = s;
        setLabelScale(Math.round(s * 20) / 20);
      }
      for (const l of labelsRef.current) {
        const el = labelEls.current.get(l.key);
        if (!el) continue;
        // Tilted views: labels float higher, pinned to their tile by a stem.
        const w = engine.tileWorld(l.key, l.lift + tf * 0.42);
        if (!w) continue;
        engine.projectWorld(w, tmp);
        el.style.transform = `translate3d(${tmp.x.toFixed(1)}px, ${tmp.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
        if (tf > 0.02) {
          const g = engine.tileWorld(l.key, 0.04);
          if (g) {
            engine.projectWorld(g, foot);
            el.style.setProperty('--stem', `${Math.max(0, foot.y - tmp.y).toFixed(1)}px`);
            el.style.setProperty('--stem-o', tf.toFixed(2));
          }
        } else if (el.style.getPropertyValue('--stem')) {
          el.style.removeProperty('--stem');
          el.style.removeProperty('--stem-o');
        }
        const a = engine.buildAlpha(l.key);
        el.style.opacity = a >= 1 ? '' : a.toFixed(3);
      }
      positionTileCards(engine);
    });
  }, [noWebgl]);

  // ── Played cards floating over tiles ──
  const tileCardEls = useRef(new Map<string, HTMLDivElement>());
  const tileCardKeysRef = useRef(tileCardKeys ?? []);
  tileCardKeysRef.current = tileCardKeys ?? [];
  const labelByKey = useMemo(() => new Map(labels.map(l => [l.key, l])), [labels]);
  const labelByKeyRef = useRef(labelByKey);
  labelByKeyRef.current = labelByKey;
  /** Where a tile's card stack sits (its bottom-center): above the tile's
   *  label when it has one (planned power / defense readout), and always clear
   *  of the hexagon itself — a resolving card grows upward from here without
   *  covering the tile it's resolving on. */
  /** The label a tile will have once `card` is planned on it: its VP row (if
   *  any) and the planned readout, at the planned token's lift. */
  const landingLabelRef = useRef<(key: string, card: Card, type?: string) => { lift: number; rows: unknown[] } | undefined>(() => undefined);
  landingLabelRef.current = (key, card, type) => {
    const tile = tiles[key];
    if (!tile) return undefined;
    const c = classify(card, tile, activePlayerId, type);
    const kind: TokenKind = c.isConsecrate ? 'consecrate' : c.isAbandon ? 'abandon' : c.isPlayerTarget ? 'target' : c.isDefensive ? 'defense' : 'claim';
    const base = tile.is_vp ? (tile.vp_value >= 2 ? 0.5 : 0.42) : tile.is_base ? 0.3 : 0.12;
    return { lift: Math.max(base, TOKEN_LABEL_LIFT[kind]), rows: tile.is_vp ? [0, 0] : [0] };
  };
  /** Each tile's card stack keeps above the tallest label it has sat over
   *  since it appeared, and eases up to a taller one: the readout changing
   *  under it — the planned power going at the reveal, the defense row hidden
   *  while its tile resolves — doesn't make the cards jump. */
  const stackPerch = useRef(new Map<string, Perch & { shown: Perch; at: number; below?: boolean }>());
  /** Where a tile's stack sits now (or, given `landing`, once that card is
   *  planned there): its label's lift and rows, never below the stack's perch. */
  const perchTargetRef = useRef((key: string, landing?: { lift: number; rows: unknown[] }): Perch => {
    const tile = live.current.tiles[key];
    const l = landing ?? labelByKeyRef.current.get(key);
    const base = !tile ? 0.12 : tile.is_vp ? (tile.vp_value >= 2 ? 0.5 : 0.42) : tile.is_base ? 0.3 : 0.12;
    const held = stackPerch.current.get(key);
    return { lift: Math.max(l ? l.lift : base, held?.lift ?? 0), rows: Math.max(l ? l.rows.length : 0, held?.rows ?? 0) };
  });
  const tileCardAnchorRef = useRef((engine: BoardEngine, key: string, out: { x: number; y: number }, perch: Perch): boolean => {
    if (!live.current.tiles[key]) return false;
    const w = engine.tileWorld(key, perch.lift + engine.tiltFactor * 0.42);
    if (!w) return false;
    engine.projectWorld(w, out);
    // Each label row is 21px (scaled), plus a 4px gap over a label at all.
    out.y -= perch.rows * 21 * labelScaleRef.current + Math.min(1, perch.rows) * 4;
    const span = engine.tileScreenSpan(key);
    if (span) out.y = Math.min(out.y, span.top - 4 * labelScaleRef.current);
    return true;
  });
  /** Place a stack `height` px tall: above the tile, or hanging below it
   *  when there's no room above. Returns whether it's below (null: no tile). */
  const placeStackRef = useRef((engine: BoardEngine, key: string, height: number, out: { x: number; y: number }, perch: Perch & { below?: boolean }): boolean | null => {
    if (!tileCardAnchorRef.current(engine, key, out, perch)) return null;
    const fitsAbove = out.y - height >= 6;
    // A stack keeps to the side of its tile it's on while that side has room
    // (no flipping over as the camera moves); a new one goes above if it fits.
    if (fitsAbove && perch.below !== true) return false;
    // Hang below the hexagon (still clear of the tile).
    const above = { ...out };
    const span = engine.tileScreenSpan(key);
    const g = engine.tileWorld(key, 0.04);
    if (!g) return false;
    engine.projectWorld(g, out);
    out.y = span ? span.bottom + 6 * labelScaleRef.current : out.y + 12 * labelScaleRef.current;
    const room = hostRef.current?.clientHeight ?? Infinity;
    if (perch.below === true && fitsAbove && out.y + height > room - 6) {
      // No room left below: back above.
      out.x = above.x;
      out.y = above.y;
      return false;
    }
    return true;
  });
  const positionTileCards = (engine: BoardEngine) => {
    const pt = { x: 0, y: 0 };
    const keys = tileCardKeysRef.current;
    const now = performance.now();
    // A stack gone (its cards went home) gives up its perch.
    for (const k of stackPerch.current.keys()) if (!keys.includes(k)) stackPerch.current.delete(k);
    // Read sizes first, then write transforms (no layout thrash).
    const heights = keys.map(k => stackHeight(tileCardEls.current.get(k)));
    keys.forEach((key, i) => {
      const el = tileCardEls.current.get(key);
      if (!el) return;
      const target = perchTargetRef.current(key);
      let p = stackPerch.current.get(key);
      if (!p) {
        p = { ...target, shown: { ...target }, at: now };
        stackPerch.current.set(key, p);
      } else {
        const k = Math.min(1, (now - p.at) / 90);
        p.lift = target.lift;
        p.rows = target.rows;
        p.shown.lift += (target.lift - p.shown.lift) * k;
        p.shown.rows += (target.rows - p.shown.rows) * k;
        p.at = now;
      }
      const below = placeStackRef.current(engine, key, heights[i], pt, { ...p.shown, below: p.below });
      if (below !== null) p.below = below;
      if (below === null) return;
      el.style.transform = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0) translate(-50%, ${below ? '0' : '-100%'})`;
      const flag = below ? '1' : '0';
      if (el.dataset.below !== flag) el.dataset.below = flag;
      const a = engine.buildAlpha(key);
      el.style.opacity = a >= 1 ? '' : a.toFixed(3);
    });
  };
  // Place stacks as soon as they mount, without waiting for the next frame.
  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (engine && tileCardKeys?.length) positionTileCards(engine);
  });

  const hasLabels = labels.length > 0;
  const engine = ready ? engineRef.current : null;
  // Aiming a card: the reticle over tiles it can go on. Otherwise the
  // inspect pointer wherever a tile has details to show.
  const boardCursor = !hovered || disableHover
    ? undefined
    : previewCard
      ? (previewValidTiles?.has(hovered) ? cursor('target') : undefined)
      : tooltip ? cursor('inspect') : undefined;

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        ref={hostRef}
        className="cc-board3d"
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: `calc(100% + ${extendBelow}px)`, overflow: 'hidden', cursor: boardCursor }}
      />
      {noWebgl && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--cc-text-dim)', fontSize: 14 }}>
          The 3D board needs WebGL 2, which this browser doesn't support.
        </div>
      )}
      {hasLabels && (
        <div className="cc-board-labels" aria-hidden="true">
          {labels.map(l => (
            <div
              key={l.key}
              ref={el => { if (el) labelEls.current.set(l.key, el); else labelEls.current.delete(l.key); }}
              className={`cc-board-label${l.prominent ? ' is-prominent' : ''}`}
            >
              {l.rows.map((r, i) => <BoardLabelRow key={i} r={r} scale={labelScale} />)}
            </div>
          ))}
        </div>
      )}
      {tileCardKeys && tileCardKeys.length > 0 && renderTileCards && (
        <div className="cc-board-tilecards">
          {tileCardKeys.map(key => (
            <div
              key={key}
              ref={el => { if (el) tileCardEls.current.set(key, el); else tileCardEls.current.delete(key); }}
              className={`cc-board-tilecard${key === raisedTileKey ? ' is-raised' : ''}`}
            >
              {renderTileCards(key, labelScale)}
            </div>
          ))}
        </div>
      )}
      {showCameraControls && engine && (
        <div className="cc-cam-controls" onPointerDown={e => e.stopPropagation()}>
          <button type="button" className="cc-cam-btn" title="Rotate left (Shift+R)" aria-label="Rotate board left" onClick={() => engine.rotateBy(-Math.PI / 6)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6.5A5 5 0 1 1 3 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M1.5 3.5 3.6 6.8 6.8 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" className="cc-cam-btn" title="Rotate right (R)" aria-label="Rotate board right" onClick={() => engine.rotateBy(Math.PI / 6)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ transform: 'scaleX(-1)' }}><path d="M3.5 6.5A5 5 0 1 1 3 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M1.5 3.5 3.6 6.8 6.8 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" className="cc-cam-btn" title="Tilt view (T)" aria-label="Toggle tilted view" onClick={() => engine.toggleTilt()}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 11.5 8 14l6-2.5L8 9z" fill="currentColor" opacity="0.45" /><path d="M2 7.5 8 10l6-2.5L8 5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 1.5V4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          <button type="button" className="cc-cam-btn" title="Reset view (V)" aria-label="Reset camera" onClick={() => engine.resetView()}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /><path d="M8 0.8v2.4M8 12.8v2.4M0.8 8h2.4M12.8 8h2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
      )}
      {tooltip && tooltip.allCards && tooltip.allCards.length > 0 && createPortal(
        <PlannedCardsPreview cards={tooltip.allCards} x={tooltip.cx} y={tooltip.cy} undoable={tooltip.undoable} />,
        document.body,
      )}
      {tooltip && tooltip.text && (
        <div className="cc-board-tooltip" style={{ left: tooltip.x + 12, top: tooltip.y - 28 }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
