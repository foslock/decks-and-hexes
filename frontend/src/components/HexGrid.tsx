import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Application, Graphics, Text, TextStyle, Container } from 'pixi.js';
import type { HexTile, Card } from '../types/game';

// Flat-top hex geometry
const HEX_SIZE = 32;
const HEX_WIDTH = HEX_SIZE * 2;
const HEX_HEIGHT = Math.sqrt(3) * HEX_SIZE;

// Player colors
const PLAYER_COLORS: Record<string, number> = {
  player_0: 0x4a9eff,
  player_1: 0xff4a4a,
  player_2: 0x4aff6a,
  player_3: 0xffaa4a,
  player_4: 0xaa4aff,
  player_5: 0xff4aaa,
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

interface HexGridProps {
  tiles: Record<string, HexTile>;
  onTileClick: (q: number, r: number) => void;
  highlightTiles?: Set<string>;
  playerInfo?: Record<string, PlayerInfo>;
  transformRef?: React.MutableRefObject<GridTransform | null>;
  borderTiles?: Set<string>;
  activePlayerId?: string;
  plannedActions?: Map<string, PlannedActionIcon>;
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

export default function HexGrid({ tiles, onTileClick, highlightTiles, playerInfo, transformRef, borderTiles, activePlayerId, plannedActions }: HexGridProps) {
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
  const hexContainerRef = useRef<Container | null>(null);
  const hoveredTileRef = useRef<string | null>(null);
  const hoverEdgeGraphicsRef = useRef<Graphics | null>(null);
  const tileGraphicsRef = useRef<Map<string, { g: Graphics; baseColor: number; isBlocked: boolean; baseAlpha: number }>>(new Map());
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text?: string; card?: Card } | null>(null);

  tilesRef.current = tiles;
  highlightRef.current = highlightTiles;
  onClickRef.current = onTileClick;
  playerInfoRef.current = playerInfo;
  transformRefLocal.current = transformRef;
  borderTilesRef.current = borderTiles;
  activePlayerIdRef.current = activePlayerId;
  plannedActionsRef.current = plannedActions;

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
        if (!tile.is_blocked) {
          hoveredTileRef.current = key;
          const hoverEdgeG = hoverEdgeGraphicsRef.current;
          if (hoverEdgeG) {
            hoverEdgeG.clear();
            hoverEdgeG.setStrokeStyle({ width: 3, color: 0xffffff, alpha: 0.9 });
            for (const [, , vA, vB] of DIRECTIONS_WITH_EDGES) {
              const a = hexVertex(x, y, vA, HEX_SIZE);
              const b = hexVertex(x, y, vB, HEX_SIZE);
              hoverEdgeG.moveTo(a.x, a.y); hoverEdgeG.lineTo(b.x, b.y);
            }
            hoverEdgeG.stroke();
          }
        }
        // Planned action card tooltip (only active player's own actions)
        const plannedAction = plannedActionsRef.current?.get(key);
        if (plannedAction) {
          setTooltip({ x: e.global.x, y: e.global.y, card: plannedAction.card });
        } else if (tile.owner && playerInfoRef.current?.[tile.owner]) {
          const info = playerInfoRef.current[tile.owner];
          const label = ARCHETYPE_LABELS[info.archetype] || info.archetype;
          setTooltip({ x: e.global.x, y: e.global.y, text: `${info.name} (${label})` });
        }
      });
      g.on('pointermove', (e) => {
        setTooltip((prev) => prev ? { ...prev, x: e.global.x, y: e.global.y } : null);
      });
      g.on('pointerout', () => {
        if (!tile.is_blocked) {
          hoverEdgeGraphicsRef.current?.clear();
          hoveredTileRef.current = null;
        }
        setTooltip(null);
      });
      hexContainer.addChild(g);
    }

    // === PASS 3: Base grid edges — each edge drawn exactly once ===
    // Interior edges between same-owner tiles are skipped; solid fills tile seamlessly.
    const edgeG = new Graphics();
    edgeG.setStrokeStyle({ width: 1.5, color: 0x555577 });
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
      hlEdgeG.setStrokeStyle({ width: 2.5, color: 0xffff00 });
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
      outlineG.setStrokeStyle({ width: 3, color: 0xffffff, alpha: 0.8 });
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

    // === PASS 7: Hover edge overlay (updated dynamically on pointer events) ===
    const hoverEdgeG = new Graphics();
    hoverEdgeGraphicsRef.current = hoverEdgeG;
    hexContainer.addChild(hoverEdgeG);

    // === PASS 8: Text labels — rendered last so they are always on top ===
    for (const [key, tile] of Object.entries(tiles)) {
      const { x, y } = axialToPixel(tile.q, tile.r);

      if (tile.is_vp && !tile.is_blocked) {
        const isPremium = tile.vp_value >= 2;
        const star = new Text({
          text: isPremium ? '★★' : '★',
          style: new TextStyle({
            fontSize: isPremium ? 11 : 14,
            fill: isPremium ? 0xfff066 : 0xffd700,
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

      if (tile.is_blocked) {
        const mountain = new Text({
          text: '⛰️',
          style: new TextStyle({ fontSize: 22, fill: 0x888888 }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        mountain.anchor.set(0.5);
        mountain.position.set(x, y);
        hexContainer.addChild(mountain);
      }

      const inBorder = borders?.has(key);
      const plannedAction = planned?.get(key);

      if (plannedAction) {
        // Determine icon: shield if playing on own tile (defense/reinforce), sword if attacking
        const isDefensivePlay = plannedAction.type === 'defense' || tile.owner === activePlayer;
        const label = isDefensivePlay
          ? `🛡 +${plannedAction.power}`
          : `⚔ ${plannedAction.power}`;
        const labelColor = isDefensivePlay ? 0x66ff88 : 0xffaa00;
        const textY = tile.is_vp ? y + 8 : y;

        const actionLabel = new Text({
          text: label,
          style: new TextStyle({ fontSize: 13, fill: labelColor, fontWeight: 'bold' }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        actionLabel.anchor.set(0.5);
        actionLabel.position.set(x, textY);
        actionLabel.alpha = 1;
        hexContainer.addChild(actionLabel);
      } else if (tile.defense_power > 0 || inBorder) {
        const defColor = inBorder && tile.defense_power === 0 ? 0x888888 : 0xffffff;
        const def = new Text({
          text: `${tile.defense_power}`,
          style: new TextStyle({ fontSize: 14, fill: defColor, fontWeight: 'bold' }),
          resolution: Math.ceil(window.devicePixelRatio || 2),
        });
        def.anchor.set(0.5);
        // VP tiles: below the star. Non-VP tiles: vertically centered.
        def.position.set(x, tile.is_vp ? y + 8 : y);
        def.alpha = 1;
        hexContainer.addChild(def);
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
    }).then(() => {
      if (destroyed) { app.destroy(); return; }
      containerRef.current!.appendChild(app.canvas);
      appRef.current = app;

      const hexContainer = new Container();
      hexContainerRef.current = hexContainer;
      app.stage.addChild(hexContainer);

      renderTiles();

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
    };
  }, []);

  // Re-render tiles when data changes
  useEffect(() => {
    renderTiles();
  }, [tiles, highlightTiles, activePlayerId, plannedActions, renderTiles]);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 500, position: 'relative' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
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
          whiteSpace: 'nowrap',
          zIndex: 10,
          border: '1px solid #555',
        }}>
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
