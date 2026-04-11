import React, { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Application, Graphics, Text, TextStyle, Container } from 'pixi.js';
import type { HexTile, Card } from '../types/game';
import { useTooltips } from './SettingsContext';
import CompactCard, { COMPACT_CARD_WIDTH } from './CompactCard';

// Flat-top hex geometry
const HEX_SIZE = 32;
const HEX_WIDTH = HEX_SIZE * 2;
const HEX_HEIGHT = Math.sqrt(3) * HEX_SIZE;

// Player colors — mutable, populated from game state on game start.
// Fallback defaults used if game state hasn't been loaded yet.
export const PLAYER_COLORS: Record<string, number> = {
  player_0: 0xe6194b,
  player_1: 0x3cb44b,
  player_2: 0xffe119,
  player_3: 0x4363d8,
  player_4: 0xf58231,
  player_5: 0x911eb4,
};

/** Convert a CSS hex color string (#rrggbb) to a numeric 0xRRGGBB value. */
export function cssHexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

/** Update PLAYER_COLORS from the game state's player color assignments. */
export function syncPlayerColors(players: Record<string, { color?: string }>): void {
  for (const [pid, p] of Object.entries(players)) {
    if (p.color) {
      PLAYER_COLORS[pid] = cssHexToNumber(p.color);
    }
  }
}

const TILE_COLORS = {
  normal: 0x2a2a3e,
  blocked: 0x1a1a1a,
  vp: 0x4a3a2a,
  vp_premium: 0x5a3a10,
  hover: 0x3a3a5e,
};

interface PlayerInfo {
  name: string;
  archetype: string;
}

export interface GridTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  rotation: number;  // radians
  pivotX: number;
  pivotY: number;
}

export interface PlannedActionIcon {
  type: string;  // 'claim' or 'defense'
  power: number;
  name: string;
  card: Card;
  /** All individual cards played on this tile (for multi-card hover preview) */
  allCards: { card: Card; effectivePower?: number }[];
  /** Permanent defense power from cards with permanent_defense effects */
  permanentDefPower: number;
  /** Temporary defense power from other defense/claim cards */
  tempDefPower: number;
}

export interface ClaimChevron {
  targetQ: number;
  targetR: number;
  sourceQ: number;
  sourceR: number;
  color: number;
  alpha: number;
}

export interface VpPath {
  /** Hex coords from VP tile (index 0) to base tile (last index) */
  points: [number, number][];
  /** Player color (will be lightened for the line) */
  color: number;
  /** Overall opacity 0–1 (for fade in/out) */
  alpha: number;
  /** Player who owns this path */
  playerId: string;
  /** If true, this path's connection is broken and it's fading out quickly */
  breaking?: boolean;
  /** If true, render at steady alpha/width without breathing pulse */
  noPulse?: boolean;
}

interface HexGridProps {
  tiles: Record<string, HexTile>;
  onTileClick: (q: number, r: number, shiftKey?: boolean) => void;
  highlightTiles?: Set<string>;
  multiTileTargets?: [number, number][];
  playerInfo?: Record<string, PlayerInfo>;
  transformRef?: React.MutableRefObject<GridTransform | null>;
  borderTiles?: Set<string>;
  activePlayerId?: string;
  plannedActions?: Map<string, PlannedActionIcon>;
  /** Card currently selected or being dragged — used for hover preview on valid tiles */
  previewCard?: Card | null;
  /** All tiles the preview card can legally be played on (superset of highlightTiles — includes own tiles for defensive claims) */
  previewValidTiles?: Set<string>;
  /** Claim direction chevrons shown during play/reveal phases */
  claimChevrons?: ClaimChevron[];
  /** VP connection paths shown during resolve phase */
  vpPaths?: VpPath[];
  /** VP tile keys that are owned AND connected to the owner's base (filled star) */
  connectedVpTiles?: Set<string>;
  /** When true, suppress hover effects (highlight, tooltips) — e.g. when a full-screen overlay is open */
  disableHover?: boolean;
  /** Tile keys to show pulsing outline (review mode — tiles with played cards) */
  reviewPulseTiles?: Set<string>;
  /** Called when a tile is hovered during review (provides screen coords for popup positioning) */
  onTileHover?: (q: number, r: number, screenX: number, screenY: number) => void;
  /** Called when tile hover ends during review */
  onTileHoverEnd?: () => void;
  /** Build-from-center progress (0 = hidden, 1 = fully visible). Omit for instant render. */
  buildProgress?: number;
  /** Grid rotation in radians. Animated smoothly via Pixi ticker. */
  gridRotation?: number;
  /**
   * When true, stop the Pixi ticker (pauses VP pulse, highlight pulse,
   * rotation lerp, cursor-fade, and review-pulse animations). Used to
   * relieve iOS Safari memory/GPU pressure while a full-screen DOM
   * overlay (shop, card browser, deck viewer, upgrade preview) is
   * compositing on top of the WebGL canvas.
   */
  paused?: boolean;
}

function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, y };
}

/** Inverse of axialToPixel — convert local pixel position to fractional axial coords. */
function pixelToAxial(px: number, py: number): { q: number; r: number } {
  const q = (2 / 3 * px) / HEX_SIZE;
  const r = (-1 / 3 * px + Math.sqrt(3) / 3 * py) / HEX_SIZE;
  return { q, r };
}

/** Round fractional axial coords to nearest hex. */
function axialRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

/** Hex distance between two axial coordinates. */
function hexDistance(q1: number, r1: number, q2: number, r2: number): number {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

function drawHexagon(g: Graphics, x: number, y: number, size: number) {
  const points: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i);
    points.push(x + size * Math.cos(angle));
    points.push(y + size * Math.sin(angle));
  }
  g.poly(points, true);
}

/**
 * Clip a ray from hex center (cx, cy) toward (tx, ty) to the hex boundary.
 * Returns the point on the hex edge where the ray exits the hexagon.
 */
function clipToHexEdge(cx: number, cy: number, tx: number, ty: number, size: number): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  // Test intersection with each of the 6 hex edges
  let bestT = Infinity;
  for (let i = 0; i < 6; i++) {
    const a0 = (Math.PI / 180) * (60 * i);
    const a1 = (Math.PI / 180) * (60 * ((i + 1) % 6));
    const ex0 = cx + size * Math.cos(a0);
    const ey0 = cy + size * Math.sin(a0);
    const ex1 = cx + size * Math.cos(a1);
    const ey1 = cy + size * Math.sin(a1);

    // Ray: P = (cx, cy) + t * (dx, dy), t > 0
    // Edge: Q = (ex0, ey0) + s * (ex1 - ex0, ey1 - ey0), 0 <= s <= 1
    const edx = ex1 - ex0;
    const edy = ey1 - ey0;
    const denom = dx * edy - dy * edx;
    if (Math.abs(denom) < 1e-10) continue;
    const t = ((ex0 - cx) * edy - (ey0 - cy) * edx) / denom;
    const s = ((ex0 - cx) * dy - (ey0 - cy) * dx) / denom;
    if (t > 0 && s >= -0.001 && s <= 1.001 && t < bestT) {
      bestT = t;
    }
  }

  if (bestT === Infinity) return { x: cx, y: cy };
  // Extend 5px past the edge into the hex (back toward center)
  const edgeX = cx + dx * bestT;
  const edgeY = cy + dy * bestT;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x: edgeX, y: edgeY };
  const inset = 5;
  return { x: edgeX - (dx / len) * inset, y: edgeY - (dy / len) * inset };
}

function hexVertex(cx: number, cy: number, index: number, size: number): { x: number; y: number } {
  const angle = (Math.PI / 180) * (60 * index);
  return {
    x: cx + size * Math.cos(angle),
    y: cy + size * Math.sin(angle),
  };
}

// Flat-top hex: 6 neighbor directions with corresponding edge vertex pairs
// Direction [dq, dr] → edge is between vertex vA and vB
const DIRECTIONS_WITH_EDGES: [number, number, number, number][] = [
  [1, 0, 0, 1],    // right neighbor → edge 0-1
  [0, 1, 1, 2],    // bottom-right → edge 1-2
  [-1, 1, 2, 3],   // bottom-left → edge 2-3
  [-1, 0, 3, 4],   // left → edge 3-4
  [0, -1, 4, 5],   // top-left → edge 4-5
  [1, -1, 5, 0],   // top-right → edge 5-0
];

// Only 3 canonical directions for deduplication (avoid drawing shared edges twice)
const CANONICAL_DIRECTIONS: [number, number, number, number][] = [
  [1, 0, 0, 1],    // right
  [1, -1, 5, 0],   // top-right
  [0, -1, 4, 5],   // top-left
];

const ARCHETYPE_LABELS: Record<string, string> = {
  vanguard: 'Vanguard',
  swarm: 'Swarm',
  fortress: 'Fortress',
};

import { CARD_TYPE_COLORS, getCardDisplayColor } from '../constants/cardColors';

function PlannedCardTooltip({ card, x, y, totalPower, displayName }: { card: Card; x: number; y: number; totalPower?: number; displayName?: string }) {
  const typeColor = getCardDisplayColor(card);
  const parts: string[] = [];
  const displayPower = totalPower ?? card.power;
  if (displayPower > 0) parts.push(`Power ${displayPower}`);
  if (card.resource_gain > 0) parts.push(`+${card.resource_gain} Res`);
  if (card.draw_cards > 0) parts.push(`+${card.draw_cards} Card${card.draw_cards !== 1 ? 's' : ''}`);
  if (card.defense_bonus > 0) parts.push(`+${card.defense_bonus} Def`);

  return (
    <div style={{
      position: 'absolute',
      left: x + 14,
      top: y - 10,
      width: 170,
      background: '#1e1e3a',
      border: `2px solid ${typeColor}`,
      borderRadius: 8,
      padding: '8px 10px',
      pointerEvents: 'none',
      zIndex: 100,
      color: '#fff',
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
    }}>
      <div style={{ fontSize: 9, color: typeColor, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
        {card.card_type}
        {card.action_return > 0 && (
          <span style={{
            marginLeft: 5,
            padding: '1px 4px',
            borderRadius: 3,
            background: card.action_return === 2 ? '#4aff6a' : '#ffaa4a',
            color: '#000',
            fontWeight: 'bold',
          }}>
            {card.action_return === 1 ? '↺' : '↑'}
          </span>
        )}
      </div>
      <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
          if (el) {
            const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
            el.style.setProperty('--title-scale', String(scale));
          }
        }}>
          {displayName ?? card.name}
        </span>
      </div>
      {parts.length > 0 && (
        <div style={{ fontSize: 10, color: '#aaa', marginBottom: card.description ? 5 : 0, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
            if (el) {
              const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
              el.style.setProperty('--sub-scale', String(scale));
            }
          }}>
            {parts.join(' · ')}
          </span>
        </div>
      )}
      {card.description && (
        <div style={{ fontSize: 10, color: '#bbb', lineHeight: 1.4 }}>{card.description}</div>
      )}
    </div>
  );
}

/**
 * Multi-card hover preview using CardFull, shown when hovering over tiles
 * with planned actions. Max 4 cards per column, overflow into additional columns.
 */
function PlannedCardsPreview({ cards, x, y }: { cards: { card: Card; effectivePower?: number }[]; x: number; y: number }) {
  const maxPerCol = 4;
  const colGap = 6;
  const rowGap = 4;
  const cardW = COMPACT_CARD_WIDTH + 14; // card width + padding/border
  const cardH = 42; // approximate compact card height
  const numCols = Math.ceil(cards.length / maxPerCol);
  const totalW = numCols * cardW + (numCols - 1) * colGap;
  const rowsInFirstCol = Math.min(cards.length, maxPerCol);
  const totalH = rowsInFirstCol * cardH + (rowsInFirstCol - 1) * rowGap;

  // Position to the right of cursor, clamped to viewport
  const margin = 14;
  let left = x + margin;
  let top = y - 10;

  // Clamp right edge
  if (left + totalW > window.innerWidth - 8) {
    left = x - margin - totalW;
  }
  // Clamp bottom edge — push up if would overflow
  if (top + totalH > window.innerHeight - 8) {
    top = window.innerHeight - 8 - totalH;
  }
  // Clamp top edge
  if (top < 8) top = 8;

  return (
    <div style={{
      position: 'fixed',
      left,
      top,
      display: 'flex',
      gap: colGap,
      pointerEvents: 'none',
      zIndex: 20000,
    }}>
      {Array.from({ length: numCols }, (_, col) => {
        const colCards = cards.slice(col * maxPerCol, (col + 1) * maxPerCol);
        return (
          <div key={col} style={{ display: 'flex', flexDirection: 'column', gap: rowGap }}>
            {colCards.map((entry, i) => {
              const c = entry.effectivePower != null ? { ...entry.card, power: entry.effectivePower } : entry.card;
              return <CompactCard key={i} card={c} />;
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Blend a hex color toward white by `amount` (0=no change, 1=white). */
function lightenColor(color: number, amount: number): number {
  const r = (color >> 16) & 0xFF;
  const g = (color >> 8) & 0xFF;
  const b = color & 0xFF;
  return (
    (Math.min(255, Math.round(r + (255 - r) * amount)) << 16) |
    (Math.min(255, Math.round(g + (255 - g) * amount)) << 8) |
    Math.min(255, Math.round(b + (255 - b) * amount))
  );
}

export default function HexGrid({ tiles, onTileClick, highlightTiles, multiTileTargets, playerInfo, transformRef, borderTiles, activePlayerId, plannedActions, previewCard, previewValidTiles, claimChevrons, vpPaths, connectedVpTiles, disableHover, reviewPulseTiles, onTileHover, onTileHoverEnd, buildProgress, gridRotation, paused }: HexGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const tilesRef = useRef(tiles);
  const highlightRef = useRef(highlightTiles);
  const onClickRef = useRef(onTileClick);
  const playerInfoRef = useRef(playerInfo);
  const transformRefLocal = useRef(transformRef);
  const borderTilesRef = useRef(borderTiles);
  const activePlayerIdRef = useRef(activePlayerId);
  const plannedActionsRef = useRef(plannedActions);
  const multiTileTargetsRef = useRef(multiTileTargets);
  const previewCardRef = useRef(previewCard);
  const previewValidTilesRef = useRef(previewValidTiles);
  const claimChevronsRef = useRef(claimChevrons);
  const vpPathsRef = useRef(vpPaths);
  const connectedVpRef = useRef(connectedVpTiles);
  const hexContainerRef = useRef<Container | null>(null);
  const vpPathGraphicsRef = useRef<Graphics | null>(null);
  const vpInsertIndexRef = useRef<number>(0);
  const highlightGlowRef = useRef<Graphics | null>(null);
  const highlightEdgesRef = useRef<Graphics[]>([]);
  const hoveredTileRef = useRef<string | null>(null);
  const hoverEdgeGraphicsRef = useRef<Graphics | null>(null);
  const previewLabelRef = useRef<Text | Container | null>(null);
  const tileLabelRef = useRef<Map<string, Text | Container>>(new Map());
  const hiddenLabelKeyRef = useRef<string | null>(null);
  const tileGraphicsRef = useRef<Map<string, { g: Graphics; baseColor: number; isBlocked: boolean; baseAlpha: number }>>(new Map());
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text?: string; card?: Card; totalPower?: number; displayName?: string; allCards?: { card: Card; effectivePower?: number }[] } | null>(null);
  const tooltipsEnabled = useTooltips();
  const tooltipsEnabledRef = useRef(tooltipsEnabled);
  tooltipsEnabledRef.current = tooltipsEnabled;
  const disableHoverRef = useRef(disableHover);
  disableHoverRef.current = disableHover;
  // Cursor proximity fade on neutral tiles
  const cursorHexRef = useRef<{ q: number; r: number } | null>(null);
  const cursorOnGridRef = useRef(false);
  const cursorFadeRef = useRef(0); // 0 = no effect, 1 = full proximity fade
  const reviewPulseTilesRef = useRef(reviewPulseTiles);
  reviewPulseTilesRef.current = reviewPulseTiles;
  const onTileHoverRef = useRef(onTileHover);
  onTileHoverRef.current = onTileHover;
  const onTileHoverEndRef = useRef(onTileHoverEnd);
  onTileHoverEndRef.current = onTileHoverEnd;
  const reviewPulseGraphicsRef = useRef<Graphics | null>(null);
  const buildProgressRef = useRef(buildProgress);
  buildProgressRef.current = buildProgress;
  const gridRotationRef = useRef(gridRotation ?? 0);
  gridRotationRef.current = gridRotation ?? 0;
  const currentRotationRef = useRef(gridRotation ?? 0);
  // Mirror the `paused` prop so the async Pixi init path can honor it
  // if the prop was already `true` before init finished.
  const pausedRef = useRef(!!paused);
  pausedRef.current = !!paused;
  const gridMidRef = useRef({ x: 0, y: 0 });
  // Track all Text/Container children for counter-rotation during animation
  const textChildrenRef = useRef<(Text | Container)[]>([]);
  // Track VP tile indicator groups so hover preview labels can be parented inside them
  const vpGroupsRef = useRef<Map<string, Container>>(new Map());
  // Track base tile indicator groups so defense preview labels stack with the castle/defense indicator
  const baseGroupsRef = useRef<Map<string, Container>>(new Map());
  // Whether the current preview label is inside a VP/base group (skip individual counter-rotation)
  const previewInGroupRef = useRef(false);

  tilesRef.current = tiles;
  highlightRef.current = highlightTiles;
  onClickRef.current = onTileClick;
  playerInfoRef.current = playerInfo;
  transformRefLocal.current = transformRef;
  borderTilesRef.current = borderTiles;
  activePlayerIdRef.current = activePlayerId;
  plannedActionsRef.current = plannedActions;
  multiTileTargetsRef.current = multiTileTargets;
  previewCardRef.current = previewCard;
  previewValidTilesRef.current = previewValidTiles;
  claimChevronsRef.current = claimChevrons;
  vpPathsRef.current = vpPaths;
  connectedVpRef.current = connectedVpTiles;

  // Clear hover state when overlay opens
  useEffect(() => {
    if (disableHover) {
      hoverEdgeGraphicsRef.current?.clear();
      hoveredTileRef.current = null;
      setTooltip(null);
      if (previewLabelRef.current) {
        previewLabelRef.current.destroy();
        previewLabelRef.current = null;
      }
    }
  }, [disableHover]);

  // Compute bounding box of all tiles in unscaled pixel space, then fit to canvas.
  const fitGrid = useCallback(() => {
    const app = appRef.current;
    const hexContainer = hexContainerRef.current;
    if (!app || !hexContainer) return;

    const tileList = Object.values(tilesRef.current);
    if (tileList.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const tile of tileList) {
      const { x, y } = axialToPixel(tile.q, tile.r);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    // Add one hex radius of margin around the grid bounds
    const margin = HEX_SIZE;
    const gridW = (maxX - minX) + HEX_SIZE * 2 + margin * 2;
    const gridH = (maxY - minY) + HEX_HEIGHT + margin * 2;

    const PADDING = 16; // px of screen padding on each side
    const scale = Math.min(
      (app.screen.width - PADDING * 2) / gridW,
      (app.screen.height - PADDING * 2) / gridH,
    );

    hexContainer.scale.set(scale);

    // Center based on actual bounding box midpoint, using pivot for rotation
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    gridMidRef.current = { x: midX, y: midY };
    hexContainer.pivot.set(midX, midY);
    const screenCX = app.screen.width / 2;
    const screenCY = app.screen.height / 2;
    hexContainer.position.set(screenCX, screenCY);
    hexContainer.rotation = currentRotationRef.current;

    // Legacy offsetX/offsetY (non-rotated equivalent) for external callers
    const offsetX = screenCX - midX * scale;
    const offsetY = screenCY - midY * scale;

    // Expose transform so callers can invert screen→hex coordinates
    if (transformRefLocal.current) {
      transformRefLocal.current.current = { scale, offsetX, offsetY, rotation: currentRotationRef.current, pivotX: midX, pivotY: midY };
    }
  }, []);

  const renderTiles = useCallback(() => {
    const hexContainer = hexContainerRef.current;
    if (!hexContainer || hexContainer.destroyed) return;

    // Destroy orphaned children before re-rendering. `removeChildren()` alone
    // only detaches the display objects from the container — it does NOT free
    // their underlying GPU textures, geometry, or JS memory. Over a long game
    // this re-renders ~hundreds of times (once per tile/highlight/planned
    // action change), accumulating tens of thousands of dead Graphics/Text/
    // Container objects in the WebGL context and blowing up Safari's memory
    // budget after ~10 minutes.
    //
    // Preserve the ref-managed VP-path and review-pulse graphics: they are
    // re-added to the container by the caller effect after `renderTiles`
    // finishes, so destroying them here would invalidate those refs.
    const preservedVp = vpPathGraphicsRef.current;
    const preservedPulse = reviewPulseGraphicsRef.current;
    const oldChildren = hexContainer.removeChildren();
    for (const child of oldChildren) {
      if (child === preservedVp || child === preservedPulse) continue;
      // destroy({children: true}) recursively frees nested Containers/Text
      // (e.g. the multi-line labels pushed into textChildrenRef).
      child.destroy({ children: true });
    }
    tileGraphicsRef.current.clear();

    const tiles = tilesRef.current;
    const highlights = highlightRef.current;
    const borders = borderTilesRef.current;
    const activePlayer = activePlayerIdRef.current;
    const planned = plannedActionsRef.current;

    // Helper: is this hex the canonical owner of the edge to its neighbor?
    // Each interior edge is owned by the hex with smaller q, or if equal, smaller r.
    // Boundary edges (no neighbor) are always owned by this hex.
    const isCanonicalEdge = (tileQ: number, tileR: number, nq: number, nr: number, neighbor: HexTile | undefined) =>
      !neighbor || tileQ < nq || (tileQ === nq && tileR < nr);

    // === Build-from-center progress ===
    const bp = buildProgressRef.current;
    const building = bp !== undefined && bp < 1;
    let maxDist = 0;
    if (building) {
      for (const t of Object.values(tiles)) {
        const d = (Math.abs(t.q) + Math.abs(t.r) + Math.abs(t.q + t.r)) / 2;
        if (d > maxDist) maxDist = d;
      }
    }
    const staggerEnd = 0.6;
    const fadePortion = 1 - staggerEnd;

    const buildAlpha = (q: number, r: number): number => {
      if (bp === undefined) return 1;
      if (bp <= 0) return 0;
      if (bp >= 1) return 1;
      const dist = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
      const norm = maxDist > 0 ? dist / maxDist : 0;
      const tileStart = norm * staggerEnd;
      const tileT = Math.min(1, Math.max(0, (bp - tileStart) / fadePortion));
      return 1 - Math.pow(1 - tileT, 3);
    };

    // === PASS 1: Glow rings for highlighted tiles (behind fills) ===
    // Stored in ref so the Pixi ticker can pulse its alpha
    highlightGlowRef.current = null;
    if (highlights && highlights.size > 0) {
      const glowG = new Graphics();
      for (const key of highlights) {
        const tile = tiles[key];
        if (!tile) continue;
        const { x, y } = axialToPixel(tile.q, tile.r);
        glowG.fill({ color: 0xffff00, alpha: 0.25 * buildAlpha(tile.q, tile.r) });
        drawHexagon(glowG, x, y, HEX_SIZE + 4);
        glowG.fill();
      }
      hexContainer.addChild(glowG);
      highlightGlowRef.current = glowG;
    }

    // === PASS 2: Hex fills (no stroke) ===
    for (const [key, tile] of Object.entries(tiles)) {
      const { x, y } = axialToPixel(tile.q, tile.r);
      const g = new Graphics();

      let fillColor = TILE_COLORS.normal;
      if (tile.is_blocked) fillColor = TILE_COLORS.blocked;
      else if (tile.owner) fillColor = PLAYER_COLORS[tile.owner] ?? 0x666666;

      const isHighlighted = highlights?.has(key) ?? false;
      let fillAlpha = tile.is_blocked ? 0.3 : (tile.owner ? 1.0 : (isHighlighted ? 0.95 : 0.8));

      // Apply build-from-center stagger
      if (bp !== undefined && bp < 1) {
        fillAlpha *= buildAlpha(tile.q, tile.r);
      }

      g.fill({ color: fillColor, alpha: fillAlpha });
      drawHexagon(g, x, y, HEX_SIZE);
      g.fill();

      tileGraphicsRef.current.set(key, { g, baseColor: fillColor, isBlocked: tile.is_blocked, baseAlpha: fillAlpha });

      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = { contains: (px: number, py: number) => {
        const dx = px - x; const dy = py - y;
        return Math.sqrt(dx * dx + dy * dy) < HEX_SIZE;
      }};
      g.on('pointerdown', (e) => { onClickRef.current(tile.q, tile.r, e.shiftKey); });
      g.on('pointerover', (e) => {
        if (disableHoverRef.current) return;
        if (!tile.is_blocked) {
          hoveredTileRef.current = key;
          const hoverEdgeG = hoverEdgeGraphicsRef.current;
          if (hoverEdgeG) {
            hoverEdgeG.clear();
            hoverEdgeG.setStrokeStyle({ width: 3, color: 0xffffff, alpha: 0.8, cap: 'round' });
            for (const [, , vA, vB] of DIRECTIONS_WITH_EDGES) {
              const a = hexVertex(x, y, vA, HEX_SIZE);
              const b = hexVertex(x, y, vB, HEX_SIZE);
              hoverEdgeG.moveTo(a.x, a.y); hoverEdgeG.lineTo(b.x, b.y);
            }
            hoverEdgeG.stroke();
          }
        }

        // Preview card label on valid highlighted tiles
        const pCard = previewCardRef.current;
        const hexC = hexContainerRef.current;
        // Restore any previously hidden label — unless the tile is currently
        // a multi-tile target, whose label is intentionally kept hidden by
        // the multi-tile preview pass so the per-tile preview number can
        // take its slot.
        if (hiddenLabelKeyRef.current) {
          const hiddenKey = hiddenLabelKeyRef.current;
          const isPersistentlyHidden = multiTileTargetsRef.current?.some(
            ([sq, sr]) => `${sq},${sr}` === hiddenKey,
          ) ?? false;
          if (!isPersistentlyHidden) {
            const prev = tileLabelRef.current.get(hiddenKey);
            if (prev) prev.visible = true;
          }
          hiddenLabelKeyRef.current = null;
        }
        const isOwnTile = tile.owner === activePlayerIdRef.current;
        // Show preview on any tile the card can legally be played on
        const isValidTarget = previewValidTilesRef.current?.has(key);
        const showPreview = pCard && hexC && !tile.is_blocked && isValidTarget;
        if (showPreview) {
          // Remove previous preview label
          if (previewLabelRef.current) {
            previewLabelRef.current.destroy();
            previewLabelRef.current = null;
          }
          // Hide existing label on this tile
          const existingLabel = tileLabelRef.current.get(key);
          if (existingLabel) {
            existingLabel.visible = false;
            hiddenLabelKeyRef.current = key;
          }
          const isRubblePreview = pCard.card_type === 'engine' && pCard.effects?.some(e => e.type === 'inject_rubble');
          const isPlayerTarget = pCard.card_type === 'engine' && (pCard.forced_discard > 0 || isRubblePreview);
          const isAbandonEffect = pCard.card_type === 'engine' && pCard.target_own_tile;
          const isDefensive = !isPlayerTarget && !isAbandonEffect && (pCard.card_type === 'defense' || isOwnTile);
          let previewText: string;
          let previewColor: number;
          let previewPower = 0;
          const isConsecratePreview = pCard.effects?.some(e => e.type === 'enhance_vp_tile');
          if (isConsecratePreview) {
            previewText = '+ ★';
            previewColor = 0xffd700;
          } else if (isAbandonEffect) {
            // Scorched Retreat / Exodus: show abandon icon instead of claim/defense
            const isBlock = pCard.effects?.some(e => e.type === 'abandon_and_block');
            previewText = isBlock ? '🚧' : '↘';
            previewColor = 0xff9944;
          } else if (isRubblePreview) {
            previewText = '🪨';
            previewColor = 0xff6666;
          } else if (isPlayerTarget) {
            previewText = '🎯';
            previewColor = 0xff6666;
          } else {
            // Compute effective power (applies conditional modifiers like Garrison's if_defending_owned)
            const permDefEffect = pCard.effects?.find(e => e.type === 'permanent_defense');
            const defPower = permDefEffect
              ? (pCard.is_upgraded && permDefEffect.upgraded_value != null ? permDefEffect.upgraded_value : permDefEffect.value)
              : pCard.defense_bonus;
            const isPermanentDefense = !!permDefEffect;
            const isImmunityPreview = !!pCard.effects?.some(e => e.type === 'tile_immunity');
            let basePower = pCard.card_type === 'defense' ? defPower : pCard.power;
            if (pCard.effects) {
              for (const eff of pCard.effects) {
                if (eff.type !== 'power_modifier') continue;
                const mod = pCard.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
                if (eff.condition === 'if_defending_owned' && isOwnTile) basePower += mod;
                if (eff.condition === 'if_target_has_defense' && tile.defense_power > 0) basePower += mod;
                if (eff.condition === 'if_contested') basePower += mod;
                if (eff.condition === 'if_target_neutral' && !tile.owner) basePower += mod;
                if (eff.condition === 'if_adjacent_owned_gte') {
                  const threshold = eff.condition_threshold ?? 3;
                  const allTiles = tilesRef.current;
                  const pid = activePlayerIdRef.current;
                  let adjOwned = 0;
                  for (const [dq, dr] of DIRECTIONS_WITH_EDGES) {
                    const nKey = `${tile.q + dq},${tile.r + dr}`;
                    if (allTiles[nKey]?.owner === pid) adjOwned++;
                  }
                  if (eff.metadata?.per_tile) {
                    basePower += mod * adjOwned;
                  } else if (adjOwned >= threshold) {
                    basePower += mod;
                  }
                }
              }
            }
            previewPower = basePower;
            const existingPlanned = plannedActionsRef.current?.get(key);
            if (pCard.stackable && existingPlanned) {
              previewPower = existingPlanned.power + basePower;
            }

            if (isImmunityPreview) {
              const existingPersistent = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
              if (existingPersistent > 0) {
                previewText = '';  // handled by two-part label below
                previewColor = 0xffffff;
              } else {
                previewText = '🛡+∞';
                previewColor = 0x66ccff;
              }
            } else if (!isDefensive) {
              previewText = `⚔ ${previewPower}`;
              previewColor = 0xffffff;
            } else if (isPermanentDefense) {
              const existingPersistent = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
              previewText = `🛡${existingPersistent + previewPower}`;
              previewColor = 0xffffff;
            } else {
              const existingPersistent = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
              if (existingPersistent > 0) {
                previewText = '';
                previewColor = 0xffffff;
              } else {
                previewText = `🛡+${previewPower}`;
                previewColor = 0x66ccff;
              }
            }
          }
          const claimFontSize = 21;
          // Two-part label for temp defense on tile with existing persistent defense
          const existingPersistent = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
          const permDefEffect2 = pCard?.effects?.find(e => e.type === 'permanent_defense');
          const isPermanentDef2 = !!permDefEffect2;
          const isImmunityCard = !!pCard?.effects?.some(e => e.type === 'tile_immunity');
          const isTwoPartPreview = isDefensive && !isPermanentDef2 && existingPersistent > 0
            && !pCard?.effects?.some(e => e.type === 'enhance_vp_tile')
            && !(pCard?.card_type === 'engine' && pCard?.target_own_tile);
          let lbl: Text | Container;
          if (isTwoPartPreview || (isImmunityCard && existingPersistent > 0)) {
            const tmpLabel = isImmunityCard ? '+∞' : `+${previewPower}`;
            const container = new Container();
            const baseT = new Text({
              text: `🛡${existingPersistent}`,
              style: new TextStyle({ fontSize: claimFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            baseT.anchor.set(1, 0.5);
            container.addChild(baseT);
            const tmpT = new Text({
              text: tmpLabel,
              style: new TextStyle({ fontSize: claimFontSize, fill: 0x66ccff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            tmpT.anchor.set(0, 0.5);
            tmpT.position.set(1, 0);
            container.addChild(tmpT);
            lbl = container;
          } else {
            lbl = new Text({
              text: previewText,
              style: new TextStyle({ fontSize: claimFontSize, fill: previewColor, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            (lbl as Text).anchor.set(0.5);
          }
          lbl.alpha = 0.7;
          // If VP tile, add preview inside the VP group so it stays grouped with the star.
          // If base tile and this is a defensive preview, add inside the base group so it stacks
          // with the castle and replaces the static defense indicator (already hidden via tileLabelRef).
          const vpGroup = vpGroupsRef.current.get(key);
          const baseGroup = baseGroupsRef.current.get(key);
          if (vpGroup) {
            lbl.position.set(0, 8); // local offset below star within group
            vpGroup.addChild(lbl);
            previewInGroupRef.current = true;
          } else if (baseGroup && isDefensive) {
            lbl.position.set(0, 9); // local offset below castle within base group
            baseGroup.addChild(lbl);
            previewInGroupRef.current = true;
          } else {
            lbl.position.set(x, y);
            lbl.rotation = -currentRotationRef.current;
            hexC.addChild(lbl);
            previewInGroupRef.current = false;
          }
          lbl.eventMode = 'none';
          previewLabelRef.current = lbl;
        } else {
          // Not a valid target — clear any stale preview
          if (previewLabelRef.current) {
            previewLabelRef.current.destroy();
            previewLabelRef.current = null;
          }
        }

        // Planned action card tooltip (always shown — critical gameplay info)
        const plannedAction = plannedActionsRef.current?.get(key);
        // Also show card preview for multi-tile-selected tiles (not yet confirmed)
        const multiTileCard = previewCardRef.current;
        const isMultiTileTarget = multiTileCard && multiTileTargetsRef.current?.some(([sq, sr]) => `${sq},${sr}` === key);
        if (plannedAction) {
          setTooltip({ x: e.global.x, y: e.global.y, card: plannedAction.card, totalPower: plannedAction.power, displayName: plannedAction.name, allCards: plannedAction.allCards });
        } else if (isMultiTileTarget && multiTileCard) {
          const permDef = multiTileCard.effects?.find(e => e.type === 'permanent_defense');
          const defPow = permDef
            ? (multiTileCard.is_upgraded && permDef.upgraded_value != null ? permDef.upgraded_value : permDef.value)
            : multiTileCard.defense_bonus;
          const power = multiTileCard.card_type === 'defense' ? defPow : multiTileCard.power;
          setTooltip({ x: e.global.x, y: e.global.y, card: multiTileCard, totalPower: power, displayName: multiTileCard.name, allCards: [{ card: multiTileCard, effectivePower: power }] });
        } else if (tooltipsEnabledRef.current) {
          // Non-critical info tooltips (gated by Tooltips setting)
          const lines: string[] = [];
          if (tile.is_blocked) {
            lines.push('This tile cannot be claimed.');
          } else {
            if (tile.is_base) {
              const basePersist = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
              const baseTemp = tile.defense_power - basePersist;
              const baseBreakdown = baseTemp > 0 ? ` (${basePersist} persistent + ${baseTemp} temporary)` : '';
              lines.push(`Base tile — Defense ${tile.defense_power}${baseBreakdown}. Can be raided for Spoils and Rubble.`);
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
              if (isNeutral) {
                lines.push(`Neutral Defense: ${tile.defense_power}${breakdown}. Claiming requires at least ${tile.defense_power} power.`);
              } else {
                lines.push(`Defense: ${tile.defense_power}${breakdown}. Claiming requires at least ${tile.defense_power + 1} power.`);
              }
            }
            if (tile.owner && playerInfoRef.current?.[tile.owner]) {
              const info = playerInfoRef.current[tile.owner];
              const label = ARCHETYPE_LABELS[info.archetype] || info.archetype;
              lines.push(`${info.name} (${label})`);
              if (!tile.is_base && tile.held_since_turn != null) {
                if (tile.held_since_turn === 0) {
                  lines.push(`Occupied by ${info.name} since the start.`);
                } else {
                  lines.push(`Occupied since Round ${tile.held_since_turn}`);
                }
              }
            }
          }
          if (lines.length > 0) {
            setTooltip({ x: e.global.x, y: e.global.y, text: lines.join('\n') });
          }
        }

        // Review mode: notify parent of tile hover with screen coords
        if (reviewPulseTilesRef.current?.has(key)) {
          onTileHoverRef.current?.(tile.q, tile.r, e.global.x, e.global.y);
        }
      });
      g.on('pointermove', (e) => {
        if (disableHoverRef.current) return;
        setTooltip((prev) => prev ? { ...prev, x: e.global.x, y: e.global.y } : null);
      });
      g.on('pointerout', () => {
        if (!tile.is_blocked) {
          hoverEdgeGraphicsRef.current?.clear();
          hoveredTileRef.current = null;
        }
        // Clear preview label and restore hidden tile label
        if (previewLabelRef.current) {
          previewLabelRef.current.destroy();
          previewLabelRef.current = null;
        }
        if (hiddenLabelKeyRef.current) {
          const hiddenKey = hiddenLabelKeyRef.current;
          const isPersistentlyHidden = multiTileTargetsRef.current?.some(
            ([sq, sr]) => `${sq},${sr}` === hiddenKey,
          ) ?? false;
          if (!isPersistentlyHidden) {
            const prev = tileLabelRef.current.get(hiddenKey);
            if (prev) prev.visible = true;
          }
          hiddenLabelKeyRef.current = null;
        }
        setTooltip(null);
        onTileHoverEndRef.current?.();
      });
      hexContainer.addChild(g);
    }

    // === PASS 2b: Territory border shadows (embossed/3D effect) ===
    // For each owned tile, darken edges adjacent to tiles with a different owner (or neutral/blocked/absent).
    // Uses radial insets (toward center) for proper trapezoid strips. At vertices where two consecutive
    // border edges meet, the inset is extended so the perpendicular shadow depth reaches the full INSET distance.
    {
      const INSET = 8; // px inward from edge where shadow begins
      const MAX_ALPHA = 0.55; // darkest at the edge
      const STRIPS = 4; // number of gradient bands
      const STD_FRAC = INSET / HEX_SIZE; // radial inset fraction for single-border vertices
      const CORNER_FRAC = INSET / (HEX_SIZE * Math.sin(Math.PI / 3)); // extended inset at double-border corners

      for (const [, tile] of Object.entries(tiles)) {
        if (!tile.owner) continue;
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);

        let tileAlpha = 1.0;
        if (bp !== undefined && bp < 1) {
          tileAlpha = buildAlpha(tile.q, tile.r);
          if (tileAlpha <= 0) continue;
        }

        // Determine which edges need shadow
        const edgeNeedsShadow: boolean[] = [];
        for (const [dq, dr] of DIRECTIONS_WITH_EDGES) {
          const nKey = `${tile.q + dq},${tile.r + dr}`;
          const neighbor = tiles[nKey];
          edgeNeedsShadow.push(!(neighbor && neighbor.owner === tile.owner && !neighbor.is_blocked));
        }

        if (!edgeNeedsShadow.some(Boolean)) continue;

        const sg = new Graphics();

        for (let dirIdx = 0; dirIdx < 6; dirIdx++) {
          if (!edgeNeedsShadow[dirIdx]) continue;
          const [,, vA, vB] = DIRECTIONS_WITH_EDGES[dirIdx];
          const a = hexVertex(cx, cy, vA, HEX_SIZE);
          const b = hexVertex(cx, cy, vB, HEX_SIZE);

          const prevIdx = (dirIdx - 1 + 6) % 6;
          const nextIdx = (dirIdx + 1) % 6;

          // Compute inset target for vertex A:
          // If the adjacent edge (prevIdx) is also a border → inset radially toward center (extended for corner)
          // If the adjacent edge is friendly → inset along the friendly shared edge
          let aTargetX: number, aTargetY: number;
          if (edgeNeedsShadow[prevIdx]) {
            aTargetX = a.x + (cx - a.x) * CORNER_FRAC;
            aTargetY = a.y + (cy - a.y) * CORNER_FRAC;
          } else {
            // Move along the friendly edge from vA toward the other vertex of that edge
            const friendlyEnd = hexVertex(cx, cy, DIRECTIONS_WITH_EDGES[prevIdx][2], HEX_SIZE);
            aTargetX = a.x + (friendlyEnd.x - a.x) * CORNER_FRAC;
            aTargetY = a.y + (friendlyEnd.y - a.y) * CORNER_FRAC;
          }

          // Compute inset target for vertex B (same logic with nextIdx)
          let bTargetX: number, bTargetY: number;
          if (edgeNeedsShadow[nextIdx]) {
            bTargetX = b.x + (cx - b.x) * CORNER_FRAC;
            bTargetY = b.y + (cy - b.y) * CORNER_FRAC;
          } else {
            const friendlyEnd = hexVertex(cx, cy, DIRECTIONS_WITH_EDGES[nextIdx][3], HEX_SIZE);
            bTargetX = b.x + (friendlyEnd.x - b.x) * CORNER_FRAC;
            bTargetY = b.y + (friendlyEnd.y - b.y) * CORNER_FRAC;
          }

          for (let s = 0; s < STRIPS; s++) {
            const t0 = s / STRIPS;
            const t1 = (s + 1) / STRIPS;
            const edgeness = 1 - t0;
            const alpha = MAX_ALPHA * (edgeness * edgeness) * tileAlpha;
            // Interpolate between edge vertex and its inset target
            const a0x = a.x + (aTargetX - a.x) * t0, a0y = a.y + (aTargetY - a.y) * t0;
            const b0x = b.x + (bTargetX - b.x) * t0, b0y = b.y + (bTargetY - b.y) * t0;
            const a1x = a.x + (aTargetX - a.x) * t1, a1y = a.y + (aTargetY - a.y) * t1;
            const b1x = b.x + (bTargetX - b.x) * t1, b1y = b.y + (bTargetY - b.y) * t1;

            sg.fill({ color: 0x555577, alpha });
            sg.poly([a0x, a0y, b0x, b0y, b1x, b1y, a1x, a1y], true);
            sg.fill();
          }
        }

        hexContainer.addChild(sg);
      }
    }

    // === PASS 2c: Contested edge teeth — small triangles along borders between opposing players ===
    {
      const TEETH_COUNT = 4;
      const TOOTH_DEPTH = 5; // px inward from edge
      const TOOTH_ALPHA = 0.55;
      const teethG = new Graphics();

      for (const [, tile] of Object.entries(tiles)) {
        if (!tile.owner) continue;
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);

        let tileAlpha = 1.0;
        if (bp !== undefined && bp < 1) {
          tileAlpha = buildAlpha(tile.q, tile.r);
          if (tileAlpha <= 0) continue;
        }

        for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
          const nKey = `${tile.q + dq},${tile.r + dr}`;
          const neighbor = tiles[nKey];
          // Only draw on edges between two differently-owned player tiles
          if (!neighbor?.owner || neighbor.owner === tile.owner) continue;

          const a = hexVertex(cx, cy, vA, HEX_SIZE);
          const b = hexVertex(cx, cy, vB, HEX_SIZE);
          // Inward normal (toward tile center)
          const inX = cx - (a.x + b.x) / 2;
          const inY = cy - (a.y + b.y) / 2;
          const inLen = Math.sqrt(inX * inX + inY * inY);
          const nrmX = (inX / inLen) * TOOTH_DEPTH;
          const nrmY = (inY / inLen) * TOOTH_DEPTH;

          // Draw triangles along this edge, colored with the neighbor's (opposing) color
          const color = PLAYER_COLORS[neighbor.owner] ?? 0x666666;
          teethG.fill({ color, alpha: TOOTH_ALPHA * tileAlpha });
          for (let t = 0; t < TEETH_COUNT; t++) {
            const t0 = (t + 0.15) / TEETH_COUNT;
            const tMid = (t + 0.5) / TEETH_COUNT;
            const t1 = (t + 0.85) / TEETH_COUNT;
            // Base points on the edge
            const bx0 = a.x + (b.x - a.x) * t0;
            const by0 = a.y + (b.y - a.y) * t0;
            const bx1 = a.x + (b.x - a.x) * t1;
            const by1 = a.y + (b.y - a.y) * t1;
            // Apex point inward
            const apex_x = a.x + (b.x - a.x) * tMid + nrmX;
            const apex_y = a.y + (b.y - a.y) * tMid + nrmY;
            teethG.poly([bx0, by0, bx1, by1, apex_x, apex_y], true);
            teethG.fill();
          }
        }
      }
      hexContainer.addChild(teethG);
    }

    // === PASS 3: Base grid edges — each edge drawn exactly once ===
    // Interior edges between same-owner tiles are skipped; solid fills tile seamlessly.
    if (building) {
      // During build animation — per-tile edge Graphics so each fades with its tile
      const edgesByDist = new Map<number, Graphics>();
      for (const [, tile] of Object.entries(tiles)) {
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
        const dist = (Math.abs(tile.q) + Math.abs(tile.r) + Math.abs(tile.q + tile.r)) / 2;
        for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
          const nq = tile.q + dq; const nr = tile.r + dr;
          const neighbor = tiles[`${nq},${nr}`];
          if (!isCanonicalEdge(tile.q, tile.r, nq, nr, neighbor)) continue;
          if (tile.owner && neighbor?.owner === tile.owner) continue;
          // Use the closer tile's distance so the edge appears with the first tile that needs it
          const nDist = neighbor ? (Math.abs(nq) + Math.abs(nr) + Math.abs(nq + nr)) / 2 : dist;
          const edgeDist = Math.min(dist, nDist);
          let g = edgesByDist.get(edgeDist);
          if (!g) {
            g = new Graphics();
            g.setStrokeStyle({ width: 1.5, color: 0x555577, cap: 'round' });
            edgesByDist.set(edgeDist, g);
          }
          const a = hexVertex(cx, cy, vA, HEX_SIZE);
          const b = hexVertex(cx, cy, vB, HEX_SIZE);
          g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        }
      }
      for (const [dist, g] of edgesByDist) {
        g.stroke();
        // Compute alpha from distance (same logic as buildAlpha but with raw dist)
        const norm = maxDist > 0 ? dist / maxDist : 0;
        const tileStart = norm * staggerEnd;
        const tileT = Math.min(1, Math.max(0, (bp! - tileStart) / fadePortion));
        g.alpha = 1 - Math.pow(1 - tileT, 3);
        hexContainer.addChild(g);
      }
    } else {
      const edgeG = new Graphics();
      edgeG.setStrokeStyle({ width: 1.5, color: 0x555577, cap: 'round' });
      for (const [, tile] of Object.entries(tiles)) {
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
        for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
          const nq = tile.q + dq; const nr = tile.r + dr;
          const neighbor = tiles[`${nq},${nr}`];
          if (!isCanonicalEdge(tile.q, tile.r, nq, nr, neighbor)) continue;
          if (tile.owner && neighbor?.owner === tile.owner) continue;
          const a = hexVertex(cx, cy, vA, HEX_SIZE);
          const b = hexVertex(cx, cy, vB, HEX_SIZE);
          edgeG.moveTo(a.x, a.y); edgeG.lineTo(b.x, b.y);
        }
      }
      edgeG.stroke();
      hexContainer.addChild(edgeG);
    }

    // === PASS 3b: VP tile edge outlines (subtle dark orange) ===
    const VP_EDGE_COLOR = 0xcc7a2a;
    const VP_EDGE_ALPHA = 0.35;
    if (building) {
      for (const [, tile] of Object.entries(tiles)) {
        if (!tile.is_vp || tile.is_blocked || tile.owner) continue;
        const tAlpha = buildAlpha(tile.q, tile.r);
        if (tAlpha <= 0) continue;
        const g = new Graphics();
        g.setStrokeStyle({ width: 1.5, color: VP_EDGE_COLOR, cap: 'round' });
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
        for (const [, , vA, vB] of DIRECTIONS_WITH_EDGES) {
          const a = hexVertex(cx, cy, vA, HEX_SIZE);
          const b = hexVertex(cx, cy, vB, HEX_SIZE);
          g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        }
        g.stroke();
        g.alpha = tAlpha * VP_EDGE_ALPHA;
        hexContainer.addChild(g);
      }
    } else {
      const vpEdgeG = new Graphics();
      vpEdgeG.setStrokeStyle({ width: 1.5, color: VP_EDGE_COLOR, cap: 'round' });
      for (const [, tile] of Object.entries(tiles)) {
        if (!tile.is_vp || tile.is_blocked || tile.owner) continue;
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
        for (const [, , vA, vB] of DIRECTIONS_WITH_EDGES) {
          const a = hexVertex(cx, cy, vA, HEX_SIZE);
          const b = hexVertex(cx, cy, vB, HEX_SIZE);
          vpEdgeG.moveTo(a.x, a.y); vpEdgeG.lineTo(b.x, b.y);
        }
      }
      vpEdgeG.stroke();
      vpEdgeG.alpha = VP_EDGE_ALPHA;
      hexContainer.addChild(vpEdgeG);
    }

    // === PASS 4: Highlighted tile outlines (pulsed via ticker) ===
    highlightEdgesRef.current = [];
    if (highlights && highlights.size > 0) {
      if (building) {
        // Per-tile outlines during build animation
        for (const key of highlights) {
          const tile = tiles[key];
          if (!tile) continue;
          const tAlpha = buildAlpha(tile.q, tile.r);
          if (tAlpha <= 0) continue;
          const g = new Graphics();
          g.setStrokeStyle({ width: 2.5, color: 0xffff00, cap: 'round' });
          const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
          for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
            const neighborKey = `${tile.q + dq},${tile.r + dr}`;
            if (highlights.has(neighborKey)) continue;
            const a = hexVertex(cx, cy, vA, HEX_SIZE);
            const b = hexVertex(cx, cy, vB, HEX_SIZE);
            g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
          }
          g.stroke();
          g.alpha = tAlpha;
          hexContainer.addChild(g);
          highlightEdgesRef.current.push(g);
        }
      } else {
        const hlEdgeG = new Graphics();
        hlEdgeG.setStrokeStyle({ width: 2.5, color: 0xffff00, cap: 'round' });
        for (const key of highlights) {
          const tile = tiles[key];
          if (!tile) continue;
          const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
          for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
            const neighborKey = `${tile.q + dq},${tile.r + dr}`;
            if (highlights.has(neighborKey)) continue;
            const a = hexVertex(cx, cy, vA, HEX_SIZE);
            const b = hexVertex(cx, cy, vB, HEX_SIZE);
            hlEdgeG.moveTo(a.x, a.y); hlEdgeG.lineTo(b.x, b.y);
          }
        }
        hlEdgeG.stroke();
        hexContainer.addChild(hlEdgeG);
        highlightEdgesRef.current.push(hlEdgeG);
      }
    }

    // === PASS 5: Active player territory outline (hidden when target highlights active) ===
    if (activePlayer && (!highlights || highlights.size === 0)) {
      if (!building) {
        // No build animation — single Graphics for efficiency
        const outlineG = new Graphics();
        outlineG.setStrokeStyle({ width: 3, color: 0xccccdd, cap: 'round', join: 'round' });
        for (const [, tile] of Object.entries(tiles)) {
          if (tile.owner !== activePlayer) continue;
          const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
          for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
            const neighbor = tiles[`${tile.q + dq},${tile.r + dr}`];
            if (!neighbor || neighbor.owner !== activePlayer) {
              const a = hexVertex(cx, cy, vA, HEX_SIZE);
              const b = hexVertex(cx, cy, vB, HEX_SIZE);
              outlineG.moveTo(a.x, a.y); outlineG.lineTo(b.x, b.y);
            }
          }
        }
        outlineG.stroke();
        hexContainer.addChild(outlineG);
      } else {
        // Build animation — per-tile outlines so each fades with its tile
        for (const [, tile] of Object.entries(tiles)) {
          if (tile.owner !== activePlayer) continue;
          const tAlpha = buildAlpha(tile.q, tile.r);
          if (tAlpha <= 0) continue;
          const g = new Graphics();
          g.setStrokeStyle({ width: 3, color: 0xccccdd, cap: 'round', join: 'round' });
          const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
          for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
            const neighbor = tiles[`${tile.q + dq},${tile.r + dr}`];
            if (!neighbor || neighbor.owner !== activePlayer) {
              const a = hexVertex(cx, cy, vA, HEX_SIZE);
              const b = hexVertex(cx, cy, vB, HEX_SIZE);
              g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
            }
          }
          g.stroke();
          g.alpha = tAlpha;
          hexContainer.addChild(g);
        }
      }
    }

    // === PASS 6: Claim direction chevrons ===
    const chevrons = claimChevronsRef.current;
    if (chevrons && chevrons.length > 0) {
      // Flat-top hex: vertex i is at angle (60*i)° from center.
      // Edge i connects vertex i to vertex (i+1)%6.
      // The outward normal of edge i bisects vertices i and i+1, at angle (60*i + 30)°.
      // Edge 0 → vertices [0,1], normal 30° (lower-right in screen coords)
      // Edge 1 → vertices [1,2], normal 90° (bottom)
      // Edge 2 → vertices [2,3], normal 150° (lower-left)
      // Edge 3 → vertices [3,4], normal 210° (upper-left)
      // Edge 4 → vertices [4,5], normal 270° (top)
      // Edge 5 → vertices [5,0], normal 330° (upper-right)
      const edgeVertexPairs: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]];
      const edgeNormalAngles = [
        Math.PI / 6,       // 30°
        Math.PI / 2,       // 90°
        5 * Math.PI / 6,   // 150°
        7 * Math.PI / 6,   // 210°
        3 * Math.PI / 2,   // 270°
        11 * Math.PI / 6,  // 330°
      ];

      for (const chev of chevrons) {
        if (chev.alpha <= 0) continue;
        const target = axialToPixel(chev.targetQ, chev.targetR);
        const source = axialToPixel(chev.sourceQ, chev.sourceR);

        // Angle from target center toward source tile
        const dx = source.x - target.x;
        const dy = source.y - target.y;
        const angleToSource = Math.atan2(dy, dx);

        // Find edge whose outward normal best matches the direction to source
        let bestEdge = 0;
        let bestDot = -Infinity;
        for (let i = 0; i < 6; i++) {
          const dot = Math.cos(angleToSource - edgeNormalAngles[i]);
          if (dot > bestDot) {
            bestDot = dot;
            bestEdge = i;
          }
        }

        const [vA, vB] = edgeVertexPairs[bestEdge];
        const pA = hexVertex(target.x, target.y, vA, HEX_SIZE);
        const pB = hexVertex(target.x, target.y, vB, HEX_SIZE);

        // Edge midpoint (on the boundary of the target tile)
        const midX = (pA.x + pB.x) / 2;
        const midY = (pA.y + pB.y) / 2;

        // Inward direction (edge midpoint toward target hex center)
        const inX = target.x - midX;
        const inY = target.y - midY;
        const inLen = Math.sqrt(inX * inX + inY * inY);
        const inNx = inX / inLen;
        const inNy = inY / inLen;

        // Chevron straddles the edge: base is OUTSIDE (source side), tip is INSIDE (target side)
        const tipDepth = HEX_SIZE * 0.30;   // how far tip extends into target tile
        const baseDepth = HEX_SIZE * 0.25;  // how far base extends outside toward source
        const chevWidth = 0.70;             // fraction of edge length

        // Tip: offset inward from edge midpoint (into the target tile)
        const tipX = midX + inNx * tipDepth;
        const tipY = midY + inNy * tipDepth;

        // Base center: offset outward from edge midpoint (toward source/player tile)
        const baseCx = midX - inNx * baseDepth;
        const baseCy = midY - inNy * baseDepth;

        // Base corners: along the edge direction at the base center
        const edgeDx = pB.x - pA.x;
        const edgeDy = pB.y - pA.y;
        const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
        const eDirX = edgeDx / edgeLen;
        const eDirY = edgeDy / edgeLen;
        const halfW = edgeLen * chevWidth / 2;
        const baseAx = baseCx - eDirX * halfW;
        const baseAy = baseCy - eDirY * halfW;
        const baseBx = baseCx + eDirX * halfW;
        const baseBy = baseCy + eDirY * halfW;

        const g = new Graphics();

        // Gradient: 0% at base → 100% at edge center → 50% at tip
        // Split into strips for smooth gradient approximation
        const totalLen = baseDepth + tipDepth;
        const tEdge = baseDepth / totalLen; // parameter where edge midpoint is (~0.45)
        const numStrips = 8;

        for (let s = 0; s < numStrips; s++) {
          const t0 = s / numStrips;
          const t1 = (s + 1) / numStrips;
          const tMid = (t0 + t1) / 2;

          // Alpha: 0% at t=0 (base), 100% at t=tEdge (edge), 50% at t=1 (tip)
          let stripAlpha: number;
          if (tMid <= tEdge) {
            stripAlpha = tMid / tEdge; // 0 → 1
          } else {
            stripAlpha = 1.0 - 0.5 * ((tMid - tEdge) / (1 - tEdge)); // 1 → 0.5
          }

          // Trapezoid corners: lerp base corners and tip at t0 and t1
          const lx0 = baseAx + (tipX - baseAx) * t0;
          const ly0 = baseAy + (tipY - baseAy) * t0;
          const rx0 = baseBx + (tipX - baseBx) * t0;
          const ry0 = baseBy + (tipY - baseBy) * t0;
          const lx1 = baseAx + (tipX - baseAx) * t1;
          const ly1 = baseAy + (tipY - baseAy) * t1;
          const rx1 = baseBx + (tipX - baseBx) * t1;
          const ry1 = baseBy + (tipY - baseBy) * t1;

          g.moveTo(lx0, ly0);
          g.lineTo(rx0, ry0);
          g.lineTo(rx1, ry1);
          g.lineTo(lx1, ly1);
          g.closePath();
          g.fill({ color: chev.color, alpha: chev.alpha * stripAlpha });
        }

        hexContainer.addChild(g);
      }
    }

    // === PASS 7: Hover edge overlay (updated dynamically on pointer events) ===
    const hoverEdgeG = new Graphics();
    hoverEdgeGraphicsRef.current = hoverEdgeG;
    hexContainer.addChild(hoverEdgeG);

    // === PASS 7b: Multi-tile target markers ===
    const sTargets = multiTileTargetsRef.current;
    if (sTargets && sTargets.length > 0) {
      const multiTileG = new Graphics();
      for (let i = 0; i < sTargets.length; i++) {
        const [sq, sr] = sTargets[i];
        const { x: sx, y: sy } = axialToPixel(sq, sr);
        // Yellow ring to mark selected multi-tile targets
        multiTileG.setStrokeStyle({ width: 3, color: 0xffff00, alpha: 0.9 });
        drawHexagon(multiTileG, sx, sy, HEX_SIZE - 2);
        multiTileG.stroke();
      }
      hexContainer.addChild(multiTileG);
    }

    // Record child index before PASS 8 — VP path layer will be inserted here
    vpInsertIndexRef.current = hexContainer.children.length;

    // === PASS 8: Text labels — rendered last so they are always on top ===
    tileLabelRef.current.clear();
    hiddenLabelKeyRef.current = null;
    textChildrenRef.current = [];
    const counterRot = -currentRotationRef.current;
    const vpGroups = new Map<string, Container>(); // tile key → VP indicator group container
    vpGroupsRef.current = vpGroups;
    const baseGroups = new Map<string, Container>(); // tile key → base tile indicator group container
    baseGroupsRef.current = baseGroups;
    for (const [key, tile] of Object.entries(tiles)) {
      const { x, y } = axialToPixel(tile.q, tile.r);
      const labelAlpha = buildAlpha(tile.q, tile.r);

      // --- VP tile indicators (star + optional defense/action) grouped in a Container ---
      if (tile.is_vp && !tile.is_blocked) {
        const vpVal = tile.vp_value || 1;
        const connected = connectedVpRef.current?.has(key) ?? false;
        const starChar = connected ? '★' : '☆';
        const starColor = connected
          ? (vpVal >= 2 ? 0xfff066 : 0xffd700)
          : 0x888888;
        // Show individual stars up to 4, then "Nx★" for higher values
        const starText = vpVal > 4
          ? `${vpVal}×${starChar}`
          : starChar.repeat(vpVal);
        const starFontSize = vpVal === 1 ? 18 : vpVal <= 3 ? 14 : 12;

        const group = new Container();
        group.position.set(x, y);
        group.rotation = counterRot;
        group.alpha = labelAlpha;
        group.eventMode = 'none';
        group.interactiveChildren = false;

        const star = new Text({
          text: starText,
          style: new TextStyle({
            fontSize: starFontSize,
            fill: starColor,
            letterSpacing: vpVal > 1 && vpVal <= 4 ? 1 : 0,
            fontWeight: 'bold',
            ...(tile.owner ? { stroke: { color: 0x000000, width: 1 } } : {}),
          }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        star.anchor.set(0.5);
        star.position.set(0, -8);
        star.eventMode = 'none';
        group.addChild(star);

        hexContainer.addChild(group);
        textChildrenRef.current.push(group);
        vpGroups.set(key, group);
      }

      // --- Base tile indicators (castle + optional defense) grouped in a Container ---
      if (tile.is_base) {
        const group = new Container();
        group.position.set(x, y);
        group.rotation = counterRot;
        group.alpha = labelAlpha;
        group.eventMode = 'none';
        group.interactiveChildren = false;

        const castle = new Text({
          text: '🏰',
          style: new TextStyle({
            fontSize: 14,
          }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        castle.anchor.set(0.5);
        castle.position.set(1, -11);
        castle.alpha = 0.8;
        castle.eventMode = 'none';
        group.addChild(castle);

        // Register the base group so hover/planned-action defense labels can
        // be parented into it and replace the static defense indicator below.
        baseGroups.set(key, group);

        if (tile.defense_power > 0 || tile.immune) {
          const persistentDef = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
          const tempDef = tile.defense_power - persistentDef;
          const isImmune = !!tile.immune;
          const defContainer = new Container();
          defContainer.position.set(0, 9);

          if (persistentDef > 0) {
            const hasTmp = isImmune || tempDef > 0;
            const baseText = new Text({
              text: `🛡${persistentDef}`,
              style: new TextStyle({ fontSize: 16, fill: 0xffffff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            baseText.anchor.set(hasTmp ? 1 : 0.5, 0.5);
            defContainer.addChild(baseText);

            if (hasTmp) {
              const tmpText = new Text({
                text: isImmune ? '+∞' : `+${tempDef}`,
                style: new TextStyle({ fontSize: 16, fill: 0x66ccff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
                resolution: Math.ceil(window.devicePixelRatio || 2),
              });
              tmpText.anchor.set(0, 0.5);
              tmpText.position.set(1, 0);
              defContainer.addChild(tmpText);
            }
          } else {
            const tmpText = new Text({
              text: isImmune ? '🛡+∞' : `🛡+${tempDef}`,
              style: new TextStyle({ fontSize: 16, fill: 0x66ccff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            tmpText.anchor.set(0.5, 0.5);
            defContainer.addChild(tmpText);
          }

          group.addChild(defContainer);
          // Register the defense indicator so hover/planned-action defense
          // previews can hide it and parent themselves into the base group.
          tileLabelRef.current.set(key, defContainer);
        }

        hexContainer.addChild(group);
        textChildrenRef.current.push(group);
      }

      if (tile.is_blocked) {
        // Deterministic pseudo-random flip based on tile coords for visual variety
        const flipHash = ((tile.q * 7 + tile.r * 13) & 1) === 0;
        // Wrap in a Container at the tile center so counter-rotation keeps it centered
        const mtnGroup = new Container();
        mtnGroup.position.set(x, y);
        mtnGroup.rotation = counterRot;
        mtnGroup.alpha = labelAlpha;
        mtnGroup.eventMode = 'none';
        mtnGroup.interactiveChildren = false;
        const mountain = new Text({
          text: '⛰️',
          style: new TextStyle({ fontSize: 40, fill: 0x888888 }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        mountain.anchor.set(0.5);
        mountain.position.set(0, -4);
        mountain.eventMode = 'none';
        if (flipHash) mountain.scale.x = -1;
        mtnGroup.addChild(mountain);
        hexContainer.addChild(mtnGroup);
        textChildrenRef.current.push(mtnGroup);
      }

      const inBorder = borders?.has(key);
      const plannedAction = planned?.get(key);

      if (plannedAction) {
        // Determine icon: target for player-targeting, shield for defense, sword for attack, abandon for own-tile engine
        const isAbandon = plannedAction.type === 'abandon';
        const isConsecrate = plannedAction.card.effects?.some(e => e.type === 'enhance_vp_tile');
        const isBlock = isAbandon && plannedAction.card.effects?.some(e => e.type === 'abandon_and_block');
        const isRubbleEffect = plannedAction.type === 'engine' && plannedAction.card.effects?.some(e => e.type === 'inject_rubble');
        const isPlayerTarget = plannedAction.type === 'engine' && (plannedAction.card.forced_discard > 0 || isRubbleEffect);
        const isDefensivePlay = !isPlayerTarget && !isAbandon && (plannedAction.type === 'defense' || tile.owner === activePlayer);
        const claimFontSize = isAbandon ? 24 : isPlayerTarget ? 13 : 21;
        const actionStroke = { color: 0x000000, width: 2 };

        let actionLabel: Text | Container;
        if (isConsecrate) {
          actionLabel = new Text({ text: '+ ★', style: new TextStyle({ fontSize: claimFontSize, fill: 0xffd700, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
          (actionLabel as Text).anchor.set(0.5);
        } else if (isAbandon) {
          actionLabel = new Text({ text: isBlock ? '🚧' : '↘', style: new TextStyle({ fontSize: claimFontSize, fill: 0xff9944, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
          (actionLabel as Text).anchor.set(0.5);
        } else if (isRubbleEffect) {
          actionLabel = new Text({ text: '🪨', style: new TextStyle({ fontSize: claimFontSize, fill: 0xff6666, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
          (actionLabel as Text).anchor.set(0.5);
        } else if (isPlayerTarget) {
          actionLabel = new Text({ text: '🎯', style: new TextStyle({ fontSize: 13, fill: 0xff6666, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
          (actionLabel as Text).anchor.set(0.5);
        } else if (!isDefensivePlay) {
          actionLabel = new Text({ text: `⚔ ${plannedAction.power}`, style: new TextStyle({ fontSize: claimFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
          (actionLabel as Text).anchor.set(0.5);
        } else {
          // Check if any card on this tile grants immunity
          const hasImmunity = plannedAction.allCards.some(c => c.card.effects?.some(e => e.type === 'tile_immunity'));
          const tilePersist = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
          const totalPersist = tilePersist + plannedAction.permanentDefPower;
          const tmpLabel = hasImmunity ? '+∞' : `+${plannedAction.tempDefPower}`;
          const totalTemp = hasImmunity ? 1 : plannedAction.tempDefPower; // truthy check
          if (totalPersist > 0 && totalTemp > 0) {
            actionLabel = new Container();
            const bT = new Text({ text: `🛡${totalPersist}`, style: new TextStyle({ fontSize: claimFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
            bT.anchor.set(1, 0.5);
            actionLabel.addChild(bT);
            const tT = new Text({ text: tmpLabel, style: new TextStyle({ fontSize: claimFontSize, fill: 0x66ccff, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
            tT.anchor.set(0, 0.5);
            tT.position.set(1, 0);
            actionLabel.addChild(tT);
          } else if (totalPersist > 0 && !totalTemp) {
            actionLabel = new Text({ text: `🛡${totalPersist}`, style: new TextStyle({ fontSize: claimFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
            (actionLabel as Text).anchor.set(0.5);
          } else {
            actionLabel = new Text({ text: `🛡${tmpLabel}`, style: new TextStyle({ fontSize: claimFontSize, fill: 0x66ccff, fontWeight: 'bold', stroke: actionStroke }), resolution: Math.ceil(window.devicePixelRatio || 2) });
            (actionLabel as Text).anchor.set(0.5);
          }
        }

        // If this is a VP tile, add the action label into the VP group so it stays grouped with the star.
        // If this is a base tile, hide the static defense indicator — the planned action label
        // replaces it regardless of whether it's a defensive placement or an attack against the base,
        // so the existing (and now misleading) defense number doesn't compete for visual space.
        const vpGroup = vpGroups.get(key);
        const baseGroup = baseGroups.get(key);
        if (baseGroup) {
          const existing = tileLabelRef.current.get(key);
          if (existing) existing.visible = false;
        }
        if (vpGroup) {
          actionLabel.position.set(0, 8); // local offset below star
          vpGroup.addChild(actionLabel);
        } else if (baseGroup && isDefensivePlay) {
          // Defensive placement on a base: stack the label below the castle.
          actionLabel.position.set(0, 9); // local offset below castle
          baseGroup.addChild(actionLabel);
        } else {
          actionLabel.position.set(x, y);
          actionLabel.alpha = labelAlpha;
          actionLabel.rotation = counterRot;
          hexContainer.addChild(actionLabel);
          actionLabel.eventMode = 'none';
          textChildrenRef.current.push(actionLabel);
        }
        tileLabelRef.current.set(key, actionLabel);
      } else if ((tile.defense_power > 0 || tile.immune) && !tile.is_base) {
        const persistentDef = tile.base_defense + (tile.permanent_defense_bonus ?? 0);
        const tempDef = tile.defense_power - persistentDef;
        const isImmune = !!tile.immune;
        const vpGroup = vpGroups.get(key);

        const defGroup = new Container();
        if (vpGroup) {
          defGroup.position.set(0, 12);
        } else {
          defGroup.position.set(x, y);
          defGroup.rotation = counterRot;
          defGroup.alpha = labelAlpha;
        }

        if (persistentDef > 0) {
          const hasTmp = isImmune || tempDef > 0;
          const baseText = new Text({
            text: `🛡${persistentDef}`,
            style: new TextStyle({ fontSize: 16, fill: 0xffffff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          baseText.anchor.set(hasTmp ? 1 : 0.5, 0.5);
          defGroup.addChild(baseText);

          if (hasTmp) {
            const tmpText = new Text({
              text: isImmune ? '+∞' : `+${tempDef}`,
              style: new TextStyle({ fontSize: 16, fill: 0x66ccff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            tmpText.anchor.set(0, 0.5);
            tmpText.position.set(1, 0);
            defGroup.addChild(tmpText);
          }
        } else {
          const tmpText = new Text({
            text: isImmune ? '🛡+∞' : `🛡+${tempDef}`,
            style: new TextStyle({ fontSize: 16, fill: 0x66ccff, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          tmpText.anchor.set(0.5, 0.5);
          defGroup.addChild(tmpText);
        }

        if (vpGroup) {
          vpGroup.addChild(defGroup);
        } else {
          hexContainer.addChild(defGroup);
          defGroup.eventMode = 'none';
          textChildrenRef.current.push(defGroup);
        }
        tileLabelRef.current.set(key, defGroup);
      }
    }

    // Multi-tile target preview labels — show effective power on each selected tile
    const multiTilePreviewCard = previewCardRef.current;
    if (sTargets && sTargets.length > 0 && multiTilePreviewCard) {
      const isDefenseCard = multiTilePreviewCard.card_type === 'defense';
      const mtPermDefEffect = multiTilePreviewCard.effects?.find(e => e.type === 'permanent_defense');
      const isImmunityCard = multiTilePreviewCard.effects?.some(e => e.type === 'tile_immunity') ?? false;
      const isPermanentDef = !!mtPermDefEffect;
      const mtDefPower = mtPermDefEffect
        ? (multiTilePreviewCard.is_upgraded && mtPermDefEffect.upgraded_value != null ? mtPermDefEffect.upgraded_value : mtPermDefEffect.value)
        : multiTilePreviewCard.defense_bonus;
      const cardPower = isDefenseCard ? mtDefPower : multiTilePreviewCard.power;
      for (let i = 0; i < sTargets.length; i++) {
        const [sq, sr] = sTargets[i];
        const sKey = `${sq},${sr}`;
        const sTile = tiles[sKey];
        if (!sTile) continue;
        const { x: sx, y: sy } = axialToPixel(sq, sr);
        const sLabelAlpha = buildAlpha(sq, sr);

        // Combine with existing planned action power on this tile
        const existingPlanned = planned?.get(sKey);
        let previewPower = cardPower;
        if (existingPlanned && multiTilePreviewCard.stackable) {
          previewPower = existingPlanned.power + cardPower;
        }

        const isDefensivePlay = isDefenseCard || sTile.owner === activePlayer;

        // Hide existing label on this tile
        const existingLabel = tileLabelRef.current.get(sKey);
        if (existingLabel) existingLabel.visible = false;

        const mtFontSize = 21;
        const mtStroke = { color: 0x000000, width: 2 };
        let mtLabel: Text | Container;
        const tilePersist = sTile.base_defense + (sTile.permanent_defense_bonus ?? 0);

        if (!isDefensivePlay) {
          mtLabel = new Text({
            text: `⚔ ${previewPower}`,
            style: new TextStyle({ fontSize: mtFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: mtStroke }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          (mtLabel as Text).anchor.set(0.5);
        } else if (isImmunityCard) {
          // Immunity cards show +∞ as temporary defense
          if (tilePersist > 0) {
            mtLabel = new Container();
            const bT = new Text({
              text: `🛡${tilePersist}`,
              style: new TextStyle({ fontSize: mtFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: mtStroke }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            bT.anchor.set(1, 0.5);
            mtLabel.addChild(bT);
            const tT = new Text({
              text: `+∞`,
              style: new TextStyle({ fontSize: mtFontSize, fill: 0x66ccff, fontWeight: 'bold', stroke: mtStroke }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            tT.anchor.set(0, 0.5);
            tT.position.set(1, 0);
            mtLabel.addChild(tT);
          } else {
            mtLabel = new Text({
              text: `🛡+∞`,
              style: new TextStyle({ fontSize: mtFontSize, fill: 0x66ccff, fontWeight: 'bold', stroke: mtStroke }),
              resolution: Math.ceil(window.devicePixelRatio || 2),
            });
            (mtLabel as Text).anchor.set(0.5);
          }
        } else if (isPermanentDef) {
          mtLabel = new Text({
            text: `🛡${tilePersist + previewPower}`,
            style: new TextStyle({ fontSize: mtFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: mtStroke }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          (mtLabel as Text).anchor.set(0.5);
        } else if (tilePersist > 0) {
          // Two-part: persistent white + temp blue
          mtLabel = new Container();
          const bT = new Text({
            text: `🛡${tilePersist}`,
            style: new TextStyle({ fontSize: mtFontSize, fill: 0xffffff, fontWeight: 'bold', stroke: mtStroke }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          bT.anchor.set(1, 0.5);
          mtLabel.addChild(bT);
          const tT = new Text({
            text: `+${previewPower}`,
            style: new TextStyle({ fontSize: mtFontSize, fill: 0x66ccff, fontWeight: 'bold', stroke: mtStroke }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          tT.anchor.set(0, 0.5);
          tT.position.set(1, 0);
          mtLabel.addChild(tT);
        } else {
          mtLabel = new Text({
            text: `🛡+${previewPower}`,
            style: new TextStyle({ fontSize: mtFontSize, fill: 0x66ccff, fontWeight: 'bold', stroke: mtStroke }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          (mtLabel as Text).anchor.set(0.5);
        }
        mtLabel.alpha = 0.7;

        const vpGroup = vpGroups.get(sKey);
        const baseGroup = baseGroups.get(sKey);
        if (vpGroup) {
          mtLabel.position.set(0, 8);
          vpGroup.addChild(mtLabel);
        } else if (baseGroup && isDefensivePlay) {
          // existing defense indicator already hidden via tileLabelRef above
          mtLabel.position.set(0, 9);
          baseGroup.addChild(mtLabel);
        } else {
          mtLabel.position.set(sx, sy);
          mtLabel.alpha = sLabelAlpha * 0.7;
          mtLabel.rotation = counterRot;
          hexContainer.addChild(mtLabel);
          mtLabel.eventMode = 'none';
          textChildrenRef.current.push(mtLabel);
        }
      }
    }

    fitGrid();
  }, [fitGrid]);

  useEffect(() => {
    if (!containerRef.current) return;

    const app = new Application();
    let destroyed = false;

    // Cap resolution on mobile to keep the WebGL backbuffer from blowing up on
    // iPhones with devicePixelRatio 3 + antialias 4x. A raw DPR-3 full-screen
    // canvas can approach iOS Safari's texture memory budget; capping at 2
    // halves GPU memory with negligible visual difference on small screens.
    const rawDpr = window.devicePixelRatio || 1;
    const isMobileUA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || ('ontouchstart' in window && (navigator.maxTouchPoints ?? 0) > 0);
    const resolution = isMobileUA ? Math.min(rawDpr, 2) : rawDpr;

    app.init({
      background: '#1a1a2e',
      resizeTo: containerRef.current,
      antialias: true,
      resolution,
      autoDensity: true,
    }).then(() => {
      if (destroyed) { app.destroy(); return; }
      app.canvas.style.position = 'absolute';
      app.canvas.style.top = '0';
      app.canvas.style.left = '0';
      containerRef.current!.appendChild(app.canvas);
      appRef.current = app;

      const hexContainer = new Container();
      hexContainerRef.current = hexContainer;
      app.stage.addChild(hexContainer);

      renderTiles();

      // Track pointer over the stage for cursor proximity fade
      app.stage.eventMode = 'static';
      app.stage.hitArea = app.screen;
      app.stage.on('pointermove', (e) => {
        const local = hexContainer.toLocal(e.global);
        const frac = pixelToAxial(local.x, local.y);
        const snapped = axialRound(frac.q, frac.r);
        cursorHexRef.current = snapped;
      });
      app.stage.on('pointerenter', () => { cursorOnGridRef.current = true; });
      app.stage.on('pointerleave', () => {
        cursorOnGridRef.current = false;
        cursorHexRef.current = null;
      });

      // Create VP path graphics layer — inserted under tile icons/text but above hex fills
      const vpPathG = new Graphics();
      vpPathGraphicsRef.current = vpPathG;
      const idx = Math.min(vpInsertIndexRef.current, hexContainer.children.length);
      hexContainer.addChildAt(vpPathG, idx);

      // Pixi ticker for smooth VP path pulse animation
      const vpTickerFn = () => {
        const g = vpPathGraphicsRef.current;
        const paths = vpPathsRef.current;
        if (!g) return;
        g.clear();
        if (!paths || paths.length === 0) return;

        const time = performance.now();
        const PULSE_PERIOD = 2000; // ms per full breathing cycle

        for (const path of paths) {
          if (path.alpha <= 0 || path.points.length < 2) continue;
          const lightColor = lightenColor(path.color, 0.45);

          // Breathing pulse (or steady if noPulse)
          const breathe = path.noPulse ? 0.7 : 0.5 + 0.5 * Math.sin((time / PULSE_PERIOD) * Math.PI * 2);
          const pulseAlpha = path.noPulse ? path.alpha * 0.75 : path.alpha * (0.20 + 0.80 * breathe);
          const pulseWidth = path.noPulse ? 4.5 : 3.5 + 2 * breathe;

          // Convert hex coords to pixel positions
          const pts = path.points.map(([q, r]) => axialToPixel(q, r));

          // Clip first and last points to hex edges (stop at edge, not center)
          const first = pts[0];
          const last = pts[pts.length - 1];
          const clippedFirst = clipToHexEdge(first.x, first.y, pts[1].x, pts[1].y, HEX_SIZE);
          const clippedLast = clipToHexEdge(last.x, last.y, pts[pts.length - 2].x, pts[pts.length - 2].y, HEX_SIZE);

          g.setStrokeStyle({ width: pulseWidth, color: lightColor, alpha: pulseAlpha, cap: 'round', join: 'round' });
          g.moveTo(clippedFirst.x, clippedFirst.y);

          if (pts.length === 2) {
            // Simple straight line — both ends clipped
            g.lineTo(clippedLast.x, clippedLast.y);
          } else {
            // Smooth bezier curve with rounded corners at each intermediate point
            for (let i = 1; i < pts.length - 1; i++) {
              const prev = i === 1 ? clippedFirst : pts[i - 1];
              const curr = pts[i];
              const next = i === pts.length - 2 ? clippedLast : pts[i + 1];
              const bmX = (prev.x + curr.x) / 2;
              const bmY = (prev.y + curr.y) / 2;
              const amX = (curr.x + next.x) / 2;
              const amY = (curr.y + next.y) / 2;

              if (i === 1) {
                g.lineTo(bmX, bmY);
              }
              g.quadraticCurveTo(curr.x, curr.y, amX, amY);
            }
            g.lineTo(clippedLast.x, clippedLast.y);
          }
          g.stroke();
        }
      };
      app.ticker.add(vpTickerFn);

      // Highlight pulse ticker (yellow outlines + glow on selectable tiles)
      const highlightPulseFn = () => {
        const t = performance.now() / 1000;

        const glowG = highlightGlowRef.current;
        if (glowG) {
          glowG.alpha = 0.6 + 0.4 * Math.sin(t * 3);
        }

        const edges = highlightEdgesRef.current;
        if (edges.length > 0) {
          const edgeBreathe = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 4));
          for (const edgeG of edges) {
            edgeG.alpha = edgeBreathe;
          }
        }
      };
      app.ticker.add(highlightPulseFn);

      // Rotation animation ticker — smoothly lerps toward target rotation
      const rotationTickerFn = () => {
        const target = gridRotationRef.current;
        const current = currentRotationRef.current;
        const diff = target - current;
        if (Math.abs(diff) < 0.001) {
          if (current !== target) {
            currentRotationRef.current = target;
            hexContainer.rotation = target;
            // Final counter-rotation update
            for (const t of textChildrenRef.current) {
              if (!t.destroyed) t.rotation = -target;
            }
            if (previewLabelRef.current && !previewLabelRef.current.destroyed && !previewInGroupRef.current) {
              previewLabelRef.current.rotation = -target;
            }
            // Update transform ref
            if (transformRefLocal.current) {
              const prev = transformRefLocal.current.current;
              if (prev) transformRefLocal.current.current = { ...prev, rotation: target };
            }
          }
          return;
        }
        const next = current + diff * 0.12;
        currentRotationRef.current = next;
        hexContainer.rotation = next;
        // Counter-rotate all text to stay upright
        for (const t of textChildrenRef.current) {
          if (!t.destroyed) t.rotation = -next;
        }
        if (previewLabelRef.current && !previewLabelRef.current.destroyed && !previewInGroupRef.current) {
          previewLabelRef.current.rotation = -next;
        }
        // Update transform ref for coordinate inversion
        if (transformRefLocal.current) {
          const prev = transformRefLocal.current.current;
          if (prev) transformRefLocal.current.current = { ...prev, rotation: next };
        }
      };
      app.ticker.add(rotationTickerFn);

      // Cursor proximity fade ticker — dims neutral tile backgrounds near cursor
      const FADE_MAX_DIST = 3;
      const FADE_SPEED = 0.08; // per frame (~60fps → ~300ms transition)
      const cursorFadeTickerFn = () => {
        // Animate the effect multiplier in/out based on interactivity and cursor presence
        const wantFade = !disableHoverRef.current && cursorOnGridRef.current;
        const target = wantFade ? 1 : 0;
        const prev = cursorFadeRef.current;
        if (prev !== target) {
          cursorFadeRef.current = prev < target
            ? Math.min(1, prev + FADE_SPEED)
            : Math.max(0, prev - FADE_SPEED);
        }

        const fade = cursorFadeRef.current;
        const cursor = cursorHexRef.current;
        const tileMap = tileGraphicsRef.current;

        for (const [key, entry] of tileMap) {
          // Only affect neutral (unowned, non-blocked) tiles
          if (entry.isBlocked || entry.baseColor !== TILE_COLORS.normal) {
            entry.g.alpha = 1;
            continue;
          }
          if (fade <= 0 || !cursor) {
            entry.g.alpha = 1;
            continue;
          }
          const tile = tilesRef.current[key];
          if (!tile) { entry.g.alpha = 1; continue; }
          const dist = hexDistance(cursor.q, cursor.r, tile.q, tile.r);
          if (dist >= FADE_MAX_DIST) {
            entry.g.alpha = 1;
            continue;
          }
          // Closer tiles get lower opacity: near-0 at cursor, 1 at max distance
          const proximityAlpha = dist / FADE_MAX_DIST;
          // Blend between normal (1) and proximity alpha based on fade multiplier
          // Clamp to 0.01 minimum so PixiJS still delivers pointer events
          entry.g.alpha = Math.max(0.01, 1 - fade * (1 - proximityAlpha));
        }
      };
      app.ticker.add(cursorFadeTickerFn);

      // Re-fit whenever the canvas is resized
      app.renderer.on('resize', fitGrid);

      // If a full-screen overlay was opened before init finished, honor it
      // now so the ticker doesn't start running behind the overlay on iOS.
      if (pausedRef.current) {
        try { app.renderer.render(app.stage); } catch { /* noop */ }
        app.ticker.stop();
      }
    });

    return () => {
      destroyed = true;
      if (appRef.current) {
        appRef.current.renderer.off('resize', fitGrid);
        appRef.current.destroy(true);
        appRef.current = null;
      }
      vpPathGraphicsRef.current = null;
    };
  }, []);

  // Pause/resume the Pixi ticker in response to the `paused` prop.
  // Pausing relieves iOS Safari memory/GPU pressure when a full-screen DOM
  // overlay (shop, card browser, deck viewer, upgrade preview) is
  // compositing on top of the WebGL canvas. We do a single render before
  // stopping so the board's last frame is visible behind the overlay backdrop.
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    if (paused) {
      // Render one final frame with current state, then stop the ticker
      try { app.renderer.render(app.stage); } catch { /* renderer may be tearing down */ }
      app.ticker.stop();
    } else {
      app.ticker.start();
    }
  }, [paused]);

  // Re-render tiles when data changes
  useEffect(() => {
    if (!appRef.current) return;
    renderTiles();
    // Re-add VP path layer under tile icons/text (at the index saved before PASS 8)
    const vpG = vpPathGraphicsRef.current;
    if (vpG && hexContainerRef.current) {
      const idx = Math.min(vpInsertIndexRef.current, hexContainerRef.current.children.length);
      hexContainerRef.current.addChildAt(vpG, idx);
    }
    // Re-add review pulse layer on top
    const pulseG = reviewPulseGraphicsRef.current;
    if (pulseG && hexContainerRef.current) {
      hexContainerRef.current.addChild(pulseG);
    }
  }, [tiles, highlightTiles, activePlayerId, plannedActions, multiTileTargets, claimChevrons, connectedVpTiles, buildProgress, renderTiles]);

  // Review mode: pulsing outlines on tiles that had cards played
  useEffect(() => {
    const app = appRef.current;
    const container = hexContainerRef.current;

    // Helper: tear down the review pulse graphics and ticker fn safely.
    // The HexGrid unmount path runs multiple effect cleanups; by the time
    // this one runs the PIXI app may have already been destroyed by the
    // init-effect cleanup, in which case `app.ticker` is null and
    // `container.destroyed` is true. Guard every PIXI call so we don't
    // crash on the way out of a game.
    const teardown = (pulseFn?: () => void) => {
      if (pulseFn && app && app.ticker) {
        try { app.ticker.remove(pulseFn); } catch { /* already torn down */ }
      }
      const pulseG = reviewPulseGraphicsRef.current;
      if (pulseG) {
        if (container && !container.destroyed && pulseG.parent === container) {
          try { container.removeChild(pulseG); } catch { /* already detached */ }
        }
        if (!pulseG.destroyed) {
          try { pulseG.destroy(); } catch { /* already destroyed */ }
        }
        reviewPulseGraphicsRef.current = null;
      }
    };

    if (!app || !container || !reviewPulseTiles || reviewPulseTiles.size === 0) {
      // Nothing to render — make sure any previous graphics are cleaned up.
      teardown();
      return;
    }

    let g = reviewPulseGraphicsRef.current;
    if (!g) {
      g = new Graphics();
      reviewPulseGraphicsRef.current = g;
    }
    container.addChild(g);

    const reviewPulseFn = () => {
      const t = performance.now() / 1000;
      const pulseSet = reviewPulseTilesRef.current;
      if (!pulseSet || pulseSet.size === 0) { g!.clear(); return; }
      const alpha = 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.5));
      g!.clear();
      g!.setStrokeStyle({ width: 3, color: 0xffffff, alpha, cap: 'round' });
      for (const key of pulseSet) {
        const tile = tilesRef.current[key];
        if (!tile) continue;
        const { x, y } = axialToPixel(tile.q, tile.r);
        drawHexagon(g!, x, y, HEX_SIZE);
      }
      g!.stroke();
    };
    app.ticker.add(reviewPulseFn);

    return () => teardown(reviewPulseFn);
  }, [reviewPulseTiles]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
      />
      {tooltip && tooltip.allCards && tooltip.allCards.length > 0 && createPortal(
        <PlannedCardsPreview cards={tooltip.allCards} x={tooltip.x} y={tooltip.y} />,
        document.body,
      )}
      {tooltip && tooltip.text && (
        <div style={{
          position: 'absolute',
          left: tooltip.x + 12,
          top: tooltip.y - 28,
          background: '#222',
          color: '#fff',
          padding: '4px 8px',
          borderRadius: 4,
          fontSize: 12,
          pointerEvents: 'none',
          whiteSpace: 'pre-line',
          zIndex: 10,
          border: '1px solid #555',
        }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
