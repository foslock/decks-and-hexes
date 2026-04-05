import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Application, Graphics, Text, TextStyle, Container } from 'pixi.js';
import type { HexTile, Card } from '../types/game';
import { useTooltips } from './SettingsContext';

// Flat-top hex geometry
const HEX_SIZE = 32;
const HEX_WIDTH = HEX_SIZE * 2;
const HEX_HEIGHT = Math.sqrt(3) * HEX_SIZE;

// Player colors (exported for use in GameScreen chevrons)
export const PLAYER_COLORS: Record<string, number> = {
  player_0: 0x2a6ecc,
  player_1: 0xcc2a2a,
  player_2: 0x2aaa4a,
  player_3: 0xcc7a2a,
  player_4: 0x7a2acc,
  player_5: 0xcc2a7a,
};

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
}

export interface PlannedActionIcon {
  type: string;  // 'claim' or 'defense'
  power: number;
  name: string;
  card: Card;
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
  onTileClick: (q: number, r: number) => void;
  highlightTiles?: Set<string>;
  surgeTargets?: [number, number][];
  playerInfo?: Record<string, PlayerInfo>;
  transformRef?: React.MutableRefObject<GridTransform | null>;
  borderTiles?: Set<string>;
  activePlayerId?: string;
  plannedActions?: Map<string, PlannedActionIcon>;
  /** Card currently selected or being dragged — used for hover preview on valid tiles */
  previewCard?: Card | null;
  /** All tiles the preview card can legally be played on (superset of highlightTiles — includes own tiles for defensive claims) */
  previewValidTiles?: Set<string>;
  /** Claim direction chevrons shown during plan/reveal phases */
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
}

function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, y };
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

const TYPE_COLORS: Record<string, string> = {
  claim: '#4a9eff',
  defense: '#4aff6a',
  engine: '#ffaa4a',
};

function PlannedCardTooltip({ card, x, y }: { card: Card; x: number; y: number }) {
  const typeColor = TYPE_COLORS[card.card_type] || '#888';
  const parts: string[] = [];
  if (card.power > 0) parts.push(`Power ${card.power}`);
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
      <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 4 }}>{card.name}</div>
      {parts.length > 0 && (
        <div style={{ fontSize: 10, color: '#aaa', marginBottom: card.description ? 5 : 0 }}>
          {parts.join(' · ')}
        </div>
      )}
      {card.description && (
        <div style={{ fontSize: 10, color: '#bbb', lineHeight: 1.4 }}>{card.description}</div>
      )}
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

export default function HexGrid({ tiles, onTileClick, highlightTiles, surgeTargets, playerInfo, transformRef, borderTiles, activePlayerId, plannedActions, previewCard, previewValidTiles, claimChevrons, vpPaths, connectedVpTiles, disableHover, reviewPulseTiles, onTileHover, onTileHoverEnd }: HexGridProps) {
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
  const surgeTargetsRef = useRef(surgeTargets);
  const previewCardRef = useRef(previewCard);
  const previewValidTilesRef = useRef(previewValidTiles);
  const claimChevronsRef = useRef(claimChevrons);
  const vpPathsRef = useRef(vpPaths);
  const connectedVpRef = useRef(connectedVpTiles);
  const hexContainerRef = useRef<Container | null>(null);
  const vpPathGraphicsRef = useRef<Graphics | null>(null);
  const hoveredTileRef = useRef<string | null>(null);
  const hoverEdgeGraphicsRef = useRef<Graphics | null>(null);
  const previewLabelRef = useRef<Text | null>(null);
  const tileLabelRef = useRef<Map<string, Text>>(new Map());
  const hiddenLabelKeyRef = useRef<string | null>(null);
  const tileGraphicsRef = useRef<Map<string, { g: Graphics; baseColor: number; isBlocked: boolean; baseAlpha: number }>>(new Map());
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text?: string; card?: Card } | null>(null);
  const tooltipsEnabled = useTooltips();
  const tooltipsEnabledRef = useRef(tooltipsEnabled);
  tooltipsEnabledRef.current = tooltipsEnabled;
  const disableHoverRef = useRef(disableHover);
  disableHoverRef.current = disableHover;
  const reviewPulseTilesRef = useRef(reviewPulseTiles);
  reviewPulseTilesRef.current = reviewPulseTiles;
  const onTileHoverRef = useRef(onTileHover);
  onTileHoverRef.current = onTileHover;
  const onTileHoverEndRef = useRef(onTileHoverEnd);
  onTileHoverEndRef.current = onTileHoverEnd;
  const reviewPulseGraphicsRef = useRef<Graphics | null>(null);

  tilesRef.current = tiles;
  highlightRef.current = highlightTiles;
  onClickRef.current = onTileClick;
  playerInfoRef.current = playerInfo;
  transformRefLocal.current = transformRef;
  borderTilesRef.current = borderTiles;
  activePlayerIdRef.current = activePlayerId;
  plannedActionsRef.current = plannedActions;
  surgeTargetsRef.current = surgeTargets;
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

    // Center based on actual bounding box midpoint
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const offsetX = app.screen.width / 2 - midX * scale;
    const offsetY = app.screen.height / 2 - midY * scale;
    hexContainer.position.set(offsetX, offsetY);

    // Expose transform so callers can invert screen→hex coordinates
    if (transformRefLocal.current) {
      transformRefLocal.current.current = { scale, offsetX, offsetY };
    }
  }, []);

  const renderTiles = useCallback(() => {
    const hexContainer = hexContainerRef.current;
    if (!hexContainer) return;

    hexContainer.removeChildren();
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

    // === PASS 1: Glow rings for highlighted tiles (behind fills) ===
    if (highlights && highlights.size > 0) {
      const glowG = new Graphics();
      for (const key of highlights) {
        const tile = tiles[key];
        if (!tile) continue;
        const { x, y } = axialToPixel(tile.q, tile.r);
        glowG.fill({ color: 0xffff00, alpha: 0.25 });
        drawHexagon(glowG, x, y, HEX_SIZE + 4);
        glowG.fill();
      }
      hexContainer.addChild(glowG);
    }

    // === PASS 2: Hex fills (no stroke) ===
    for (const [key, tile] of Object.entries(tiles)) {
      const { x, y } = axialToPixel(tile.q, tile.r);
      const g = new Graphics();

      let fillColor = TILE_COLORS.normal;
      if (tile.is_blocked) fillColor = TILE_COLORS.blocked;
      else if (tile.owner) fillColor = PLAYER_COLORS[tile.owner] ?? 0x666666;
      else if (tile.is_vp) fillColor = tile.vp_value >= 2 ? TILE_COLORS.vp_premium : TILE_COLORS.vp;

      const isHighlighted = highlights?.has(key) ?? false;
      const fillAlpha = tile.is_blocked ? 0.3 : (tile.owner ? 1.0 : (isHighlighted ? 0.95 : 0.8));

      g.fill({ color: fillColor, alpha: fillAlpha });
      drawHexagon(g, x, y, HEX_SIZE);
      g.fill();

      tileGraphicsRef.current.set(key, { g, baseColor: fillColor, isBlocked: tile.is_blocked, baseAlpha: fillAlpha });

      g.eventMode = 'static';
      g.cursor = tile.is_blocked ? 'not-allowed' : 'pointer';
      g.hitArea = { contains: (px: number, py: number) => {
        const dx = px - x; const dy = py - y;
        return Math.sqrt(dx * dx + dy * dy) < HEX_SIZE;
      }};
      g.on('pointerdown', () => { if (!tile.is_blocked) onClickRef.current(tile.q, tile.r); });
      g.on('pointerover', (e) => {
        if (disableHoverRef.current) return;
        if (!tile.is_blocked) {
          hoveredTileRef.current = key;
          const hoverEdgeG = hoverEdgeGraphicsRef.current;
          if (hoverEdgeG) {
            hoverEdgeG.clear();
            hoverEdgeG.setStrokeStyle({ width: 3, color: 0xffffff, alpha: 0.9, cap: 'round' });
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
        // Restore any previously hidden label
        if (hiddenLabelKeyRef.current) {
          const prev = tileLabelRef.current.get(hiddenLabelKeyRef.current);
          if (prev) prev.visible = true;
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
          const isPlayerTarget = pCard.card_type === 'engine' && pCard.forced_discard > 0;
          const isDefensive = !isPlayerTarget && (pCard.card_type === 'defense' || isOwnTile);
          let previewText: string;
          let previewColor: number;
          if (isPlayerTarget) {
            previewText = '🎯';
            previewColor = 0xff6666;
          } else {
            // Defense cards show their bonus; claim/other cards show their power
            let previewPower = pCard.card_type === 'defense' ? pCard.defense_bonus : pCard.power;
            // For stackable cards, add power from any already-planned action on this tile
            const existingPlanned = plannedActionsRef.current?.get(key);
            if (pCard.stackable && existingPlanned) {
              previewPower = existingPlanned.power + (pCard.card_type === 'defense' ? pCard.defense_bonus : pCard.power);
            }
            const icon = isDefensive ? '🛡' : '⚔';
            const prefix = isDefensive ? '+' : '';
            previewText = `${icon} ${prefix}${previewPower}`;
            previewColor = isDefensive ? 0x66ff88 : 0xffaa00;
          }
          const textY = tile.is_vp ? y + 8 : y;
          const lbl = new Text({
            text: previewText,
            style: new TextStyle({ fontSize: 13, fill: previewColor, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          lbl.anchor.set(0.5);
          lbl.position.set(x, textY);
          lbl.alpha = 0.7;
          hexC.addChild(lbl);
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
        if (plannedAction) {
          setTooltip({ x: e.global.x, y: e.global.y, card: plannedAction.card });
        } else if (tooltipsEnabledRef.current) {
          // Non-critical info tooltips (gated by Tooltips setting)
          const lines: string[] = [];
          if (tile.is_blocked) {
            lines.push('This tile cannot be claimed.');
          } else {
            if (tile.is_base) {
              lines.push(`Base tile — Defense ${tile.defense_power}. Cannot be captured, but can be raided for Rubble.`);
            } else if (tile.is_vp) {
              lines.push(`VP hex — adds ${tile.vp_value} bonus VP when connected to your base.`);
            }
            if (tile.defense_power > 0) {
              lines.push(`Claiming this tile requires at least ${tile.defense_power} power.`);
            }
            if (tile.owner && playerInfoRef.current?.[tile.owner]) {
              const info = playerInfoRef.current[tile.owner];
              const label = ARCHETYPE_LABELS[info.archetype] || info.archetype;
              lines.push(`${info.name} (${label})`);
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
          const prev = tileLabelRef.current.get(hiddenLabelKeyRef.current);
          if (prev) prev.visible = true;
          hiddenLabelKeyRef.current = null;
        }
        setTooltip(null);
        onTileHoverEndRef.current?.();
      });
      hexContainer.addChild(g);
    }

    // === PASS 3: Base grid edges — each edge drawn exactly once ===
    // Interior edges between same-owner tiles are skipped; solid fills tile seamlessly.
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

    // === PASS 4: Highlighted tile outlines ===
    if (highlights && highlights.size > 0) {
      const hlEdgeG = new Graphics();
      hlEdgeG.setStrokeStyle({ width: 2.5, color: 0xffff00, cap: 'round' });
      for (const key of highlights) {
        const tile = tiles[key];
        if (!tile) continue;
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);
        for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
          const neighborKey = `${tile.q + dq},${tile.r + dr}`;
          // Only outline edges facing non-highlighted tiles
          if (highlights.has(neighborKey)) continue;
          const a = hexVertex(cx, cy, vA, HEX_SIZE);
          const b = hexVertex(cx, cy, vB, HEX_SIZE);
          hlEdgeG.moveTo(a.x, a.y); hlEdgeG.lineTo(b.x, b.y);
        }
      }
      hlEdgeG.stroke();
      hexContainer.addChild(hlEdgeG);
    }

    // === PASS 5: Active player territory outline ===
    if (activePlayer) {
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

    // === PASS 7b: Surge target markers ===
    const sTargets = surgeTargetsRef.current;
    if (sTargets && sTargets.length > 0) {
      const surgeG = new Graphics();
      for (let i = 0; i < sTargets.length; i++) {
        const [sq, sr] = sTargets[i];
        const { x: sx, y: sy } = axialToPixel(sq, sr);
        // Pulsing ring to mark selected surge targets
        surgeG.setStrokeStyle({ width: 3, color: 0xffff00, alpha: 0.9 });
        drawHexagon(surgeG, sx, sy, HEX_SIZE - 2);
        surgeG.stroke();
        // Number label
        const numLabel = new Text({
          text: `${i + 1}`,
          style: new TextStyle({ fontSize: 16, fill: 0xffff00, fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        numLabel.anchor.set(0.5);
        numLabel.position.set(sx, sy);
        hexContainer.addChild(numLabel);
      }
      hexContainer.addChild(surgeG);
    }

    // === PASS 8: Text labels — rendered last so they are always on top ===
    tileLabelRef.current.clear();
    hiddenLabelKeyRef.current = null;
    for (const [key, tile] of Object.entries(tiles)) {
      const { x, y } = axialToPixel(tile.q, tile.r);

      if (tile.is_vp && !tile.is_blocked) {
        const isPremium = tile.vp_value >= 2;
        const connected = connectedVpRef.current?.has(key) ?? false;
        const starChar = connected ? '★' : '☆';
        const starColor = connected
          ? (isPremium ? 0xfff066 : 0xffd700)
          : 0x888888;
        const star = new Text({
          text: isPremium ? `${starChar}${starChar}` : starChar,
          style: new TextStyle({
            fontSize: isPremium ? 11 : 14,
            fill: starColor,
            letterSpacing: isPremium ? 1 : 0,
            fontWeight: 'bold',
          }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        star.anchor.set(0.5);
        star.position.set(x, y - 8);
        star.alpha = 1;
        hexContainer.addChild(star);
      }

      if (tile.is_base) {
        const castle = new Text({
          text: '🏰',
          style: new TextStyle({
            fontSize: 14,
          }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        castle.anchor.set(0.5);
        castle.position.set(x, y - 8);
        castle.alpha = 0.8;
        hexContainer.addChild(castle);

        // Defense value below the castle (same layout as VP tiles)
        if (tile.defense_power > 0) {
          const baseDef = new Text({
            text: `🛡${tile.defense_power}`,
            style: new TextStyle({
              fontSize: 13,
              fill: 0xffffff,
              fontWeight: 'bold',
              stroke: { color: 0x000000, width: 2 },
            }),
            resolution: Math.ceil(window.devicePixelRatio || 2),
          });
          baseDef.anchor.set(0.5);
          baseDef.position.set(x, y + 8);
          baseDef.alpha = 1;
          hexContainer.addChild(baseDef);
        }
      }

      if (tile.is_blocked) {
        // Deterministic pseudo-random flip based on tile coords for visual variety
        const flipHash = ((tile.q * 7 + tile.r * 13) & 1) === 0;
        const mountain = new Text({
          text: '⛰️',
          style: new TextStyle({ fontSize: 40, fill: 0x888888 }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        mountain.anchor.set(0.5);
        mountain.position.set(x, y - 4);
        if (flipHash) mountain.scale.x = -1;
        hexContainer.addChild(mountain);
      }

      const inBorder = borders?.has(key);
      const plannedAction = planned?.get(key);

      if (plannedAction) {
        // Determine icon: target for player-targeting, shield for defense, sword for attack
        const isPlayerTarget = plannedAction.type === 'engine' && plannedAction.card.forced_discard > 0;
        const isDefensivePlay = !isPlayerTarget && (plannedAction.type === 'defense' || tile.owner === activePlayer);
        const label = isPlayerTarget
          ? '🎯'
          : isDefensivePlay
            ? `🛡 +${plannedAction.power}`
            : `⚔ ${plannedAction.power}`;
        const labelColor = isPlayerTarget ? 0xff6666 : isDefensivePlay ? 0x66ff88 : 0xffaa00;
        const textY = tile.is_vp ? y + 8 : y;

        const actionLabel = new Text({
          text: label,
          style: new TextStyle({
            fontSize: 13,
            fill: labelColor,
            fontWeight: 'bold',
            stroke: { color: 0x000000, width: 2 },
          }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        actionLabel.anchor.set(0.5);
        actionLabel.position.set(x, textY);
        actionLabel.alpha = 1;
        hexContainer.addChild(actionLabel);
        tileLabelRef.current.set(key, actionLabel);
      } else if (tile.defense_power > 0 && !tile.is_base) {
        const defColor = 0xffffff;
        const def = new Text({
          text: `🛡${tile.defense_power}`,
          style: new TextStyle({
            fontSize: 13,
            fill: defColor,
            fontWeight: 'bold',
            stroke: { color: 0x000000, width: 2 },
          }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        def.anchor.set(0.5);
        // VP tiles: below the star. Non-VP tiles: vertically centered.
        def.position.set(x, tile.is_vp ? y + 8 : y);
        def.alpha = 1;
        hexContainer.addChild(def);
        tileLabelRef.current.set(key, def);
      }
    }

    fitGrid();
  }, [fitGrid]);

  useEffect(() => {
    if (!containerRef.current) return;

    const app = new Application();
    let destroyed = false;

    app.init({
      background: '#1a1a2e',
      resizeTo: containerRef.current,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
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

      // Create VP path graphics layer (managed outside renderTiles)
      const vpPathG = new Graphics();
      vpPathGraphicsRef.current = vpPathG;
      hexContainer.addChild(vpPathG);

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
          const pulseWidth = path.noPulse ? 3 : 2.5 + 1.5 * breathe;

          // Convert hex coords to pixel positions
          const pts = path.points.map(([q, r]) => axialToPixel(q, r));

          g.setStrokeStyle({ width: pulseWidth, color: lightColor, alpha: pulseAlpha, cap: 'round', join: 'round' });
          g.moveTo(pts[0].x, pts[0].y);

          if (pts.length === 2) {
            // Simple straight line
            g.lineTo(pts[1].x, pts[1].y);
          } else {
            // Smooth bezier curve with rounded corners at each intermediate point
            for (let i = 1; i < pts.length - 1; i++) {
              const prev = pts[i - 1];
              const curr = pts[i];
              const next = pts[i + 1];
              const bmX = (prev.x + curr.x) / 2;
              const bmY = (prev.y + curr.y) / 2;
              const amX = (curr.x + next.x) / 2;
              const amY = (curr.y + next.y) / 2;

              if (i === 1) {
                g.lineTo(bmX, bmY);
              }
              g.quadraticCurveTo(curr.x, curr.y, amX, amY);
            }
            g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
          }
          g.stroke();
        }
      };
      app.ticker.add(vpTickerFn);

      // Re-fit whenever the canvas is resized
      app.renderer.on('resize', fitGrid);
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

  // Re-render tiles when data changes
  useEffect(() => {
    renderTiles();
    // Re-add graphics layers removed by renderTiles → removeChildren
    const vpG = vpPathGraphicsRef.current;
    if (vpG && hexContainerRef.current) {
      hexContainerRef.current.addChild(vpG);
    }
    const pulseG = reviewPulseGraphicsRef.current;
    if (pulseG && hexContainerRef.current) {
      hexContainerRef.current.addChild(pulseG);
    }
  }, [tiles, highlightTiles, activePlayerId, plannedActions, surgeTargets, claimChevrons, connectedVpTiles, renderTiles]);

  // Review mode: pulsing outlines on tiles that had cards played
  useEffect(() => {
    const app = appRef.current;
    const container = hexContainerRef.current;
    if (!app || !container || !reviewPulseTiles || reviewPulseTiles.size === 0) {
      // Clean up if no review tiles
      if (reviewPulseGraphicsRef.current && container) {
        container.removeChild(reviewPulseGraphicsRef.current);
        reviewPulseGraphicsRef.current.destroy();
        reviewPulseGraphicsRef.current = null;
      }
      return;
    }

    let g = reviewPulseGraphicsRef.current;
    if (!g) {
      g = new Graphics();
      reviewPulseGraphicsRef.current = g;
    }
    container.addChild(g);

    const pulseTickerFn = () => {
      const pulseSet = reviewPulseTilesRef.current;
      if (!pulseSet || pulseSet.size === 0) { g!.clear(); return; }
      const t = performance.now() / 1000;
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
    app.ticker.add(pulseTickerFn);

    return () => {
      app.ticker.remove(pulseTickerFn);
      if (reviewPulseGraphicsRef.current && container) {
        container.removeChild(reviewPulseGraphicsRef.current);
        reviewPulseGraphicsRef.current.destroy();
        reviewPulseGraphicsRef.current = null;
      }
    };
  }, [reviewPulseTiles]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
      />
      {tooltip && tooltip.card && (
        <PlannedCardTooltip card={tooltip.card} x={tooltip.x} y={tooltip.y} />
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
