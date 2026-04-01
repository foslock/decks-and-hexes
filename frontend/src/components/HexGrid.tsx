import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Application, Graphics, Text, TextStyle, Container } from 'pixi.js';
import type { HexTile } from '../types/game';

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

interface PlannedActionIcon {
  type: string;  // 'claim' or 'defense'
  power: number;
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
  const tileGraphicsRef = useRef<Map<string, { g: Graphics; baseColor: number; isBlocked: boolean; baseAlpha: number }>>(new Map());
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

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

    const hexSize = HEX_SIZE - 1; // drawn hex size (1px inset)

    for (const [key, tile] of Object.entries(tiles)) {
      const { x, y } = axialToPixel(tile.q, tile.r);

      const g = new Graphics();

      // Determine fill color
      let fillColor = TILE_COLORS.normal;
      if (tile.is_blocked) {
        fillColor = TILE_COLORS.blocked;
      } else if (tile.owner) {
        fillColor = PLAYER_COLORS[tile.owner] ?? 0x666666;
      } else if (tile.is_vp) {
        fillColor = TILE_COLORS.vp;
      }

      // Highlight: glow ring + thicker stroke + brighter fill
      const isHighlighted = highlights?.has(key) ?? false;

      if (isHighlighted) {
        // Draw glow ring behind the hex
        g.fill({ color: 0xffff00, alpha: 0.25 });
        drawHexagon(g, x, y, HEX_SIZE + 4);
        g.fill();
      }

      // Draw hex fill (no full-polygon stroke — edges drawn selectively below)
      const strokeWidth = isHighlighted ? 3 : 2;
      const strokeColor = isHighlighted ? 0xffff00 : 0x555577;
      const fillAlpha = tile.is_blocked ? 0.3 : (isHighlighted ? 0.95 : 0.8);

      // Use full HEX_SIZE for owned tiles so adjacent same-owner hexes overlap (no gap)
      const hasInternalEdge = tile.owner && DIRECTIONS_WITH_EDGES.some(([dq, dr]) => {
        const nk = `${tile.q + dq},${tile.r + dr}`;
        return tiles[nk]?.owner === tile.owner;
      });
      const fillSize = hasInternalEdge ? HEX_SIZE : hexSize;
      g.fill({ color: fillColor, alpha: fillAlpha });
      drawHexagon(g, x, y, fillSize);
      g.fill();

      // Draw edges selectively: skip edges between tiles owned by the same player
      g.setStrokeStyle({ width: strokeWidth, color: strokeColor });
      for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
        const nq = tile.q + dq;
        const nr = tile.r + dr;
        const neighborKey = `${nq},${nr}`;
        const neighbor = tiles[neighborKey];
        // Skip edge if both tiles are owned by the same player
        if (tile.owner && neighbor && neighbor.owner === tile.owner) continue;
        const a = hexVertex(x, y, vA, hexSize);
        const b = hexVertex(x, y, vB, hexSize);
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      }
      g.stroke();

      // Store for hover highlight updates
      tileGraphicsRef.current.set(key, { g, baseColor: fillColor, isBlocked: tile.is_blocked, baseAlpha: fillAlpha });

      // VP indicator
      if (tile.is_vp && !tile.is_blocked) {
        const star = new Text({
          text: '★',
          style: new TextStyle({ fontSize: 14, fill: 0xffd700 }),
        });
        star.anchor.set(0.5);
        star.position.set(x, y - 8);
        hexContainer.addChild(star);
      }

      // Defense power indicator — always shown on border tiles, otherwise only when > 0
      const inBorder = borders?.has(key);
      if (tile.defense_power > 0 || inBorder) {
        const defColor = inBorder && tile.defense_power === 0 ? 0x888888 : 0xffffff;
        const def = new Text({
          text: `${tile.defense_power}`,
          style: new TextStyle({ fontSize: 14, fill: defColor, fontWeight: 'bold' }),
        });
        def.anchor.set(0.5);
        def.position.set(x, y + 8);
        hexContainer.addChild(def);
      }

      // Mountain emoji on blocked tiles
      if (tile.is_blocked) {
        const mountain = new Text({
          text: '⛰️',
          style: new TextStyle({ fontSize: 22, fill: 0x888888 }),
        });
        mountain.anchor.set(0.5);
        mountain.position.set(x, y);
        hexContainer.addChild(mountain);
      }

      // Planned action icon
      if (planned?.has(key)) {
        const action = planned.get(key)!;
        const emoji = action.type === 'claim' ? '⚔️' : '🛡';
        const label = `${emoji}${action.power}`;
        const actionText = new Text({
          text: label,
          style: new TextStyle({ fontSize: 12, fill: 0xffffff }),
        });
        actionText.anchor.set(0.5);
        // Position: center if no VP star/defense, else offset
        actionText.position.set(x, y);
        hexContainer.addChild(actionText);
      }

      // Click handler + hover tooltip
      g.eventMode = 'static';
      g.cursor = tile.is_blocked ? 'not-allowed' : 'pointer';
      g.hitArea = { contains: (px: number, py: number) => {
        const dx = px - x;
        const dy = py - y;
        return Math.sqrt(dx * dx + dy * dy) < HEX_SIZE;
      }};
      g.on('pointerdown', () => {
        if (!tile.is_blocked) {
          onClickRef.current(tile.q, tile.r);
        }
      });
      g.on('pointerover', (e) => {
        // Hover highlight: make tile fully opaque
        if (!tile.is_blocked) {
          const prev = hoveredTileRef.current;
          if (prev && prev !== key) {
            const prevEntry = tileGraphicsRef.current.get(prev);
            if (prevEntry) {
              prevEntry.g.tint = 0xffffff;
              prevEntry.g.alpha = prevEntry.baseAlpha;
            }
          }
          hoveredTileRef.current = key;
          g.tint = 0xddddff;
          g.alpha = 1.0;
        }
        // Ownership tooltip
        if (tile.owner && playerInfoRef.current?.[tile.owner]) {
          const info = playerInfoRef.current[tile.owner];
          const label = ARCHETYPE_LABELS[info.archetype] || info.archetype;
          setTooltip({
            x: e.global.x,
            y: e.global.y,
            text: `${info.name} (${label})`,
          });
        }
      });
      g.on('pointermove', (e) => {
        if (tile.owner && playerInfoRef.current?.[tile.owner]) {
          setTooltip((prev) => prev ? { ...prev, x: e.global.x, y: e.global.y } : null);
        }
      });
      g.on('pointerout', () => {
        if (!tile.is_blocked) {
          g.tint = 0xffffff;
          const entry = tileGraphicsRef.current.get(key);
          if (entry) g.alpha = entry.baseAlpha;
          hoveredTileRef.current = null;
        }
        setTooltip(null);
      });

      hexContainer.addChild(g);
    }

    // --- Territory outline for active player ---
    if (activePlayer) {
      const outlineG = new Graphics();
      outlineG.setStrokeStyle({ width: 3, color: 0xffffff, alpha: 0.8 });

      for (const [key, tile] of Object.entries(tiles)) {
        if (tile.owner !== activePlayer) continue;
        const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);

        for (const [dq, dr, vA, vB] of DIRECTIONS_WITH_EDGES) {
          const nq = tile.q + dq;
          const nr = tile.r + dr;
          const neighborKey = `${nq},${nr}`;
          const neighbor = tiles[neighborKey];

          // Draw edge if neighbor doesn't exist or is not owned by the same player
          if (!neighbor || neighbor.owner !== activePlayer) {
            const a = hexVertex(cx, cy, vA, hexSize);
            const b = hexVertex(cx, cy, vB, hexSize);
            outlineG.moveTo(a.x, a.y);
            outlineG.lineTo(b.x, b.y);
          }
        }
      }
      outlineG.stroke();
      hexContainer.addChild(outlineG);
    }

    // --- Walls between different players' territories ---
    const wallG = new Graphics();
    wallG.setStrokeStyle({ width: 5, color: 0xcccccc, alpha: 0.85 });

    for (const [key, tile] of Object.entries(tiles)) {
      if (!tile.owner) continue;
      const { x: cx, y: cy } = axialToPixel(tile.q, tile.r);

      for (const [dq, dr, vA, vB] of CANONICAL_DIRECTIONS) {
        const nq = tile.q + dq;
        const nr = tile.r + dr;
        const neighborKey = `${nq},${nr}`;
        const neighbor = tiles[neighborKey];

        if (!neighbor || !neighbor.owner) continue;
        if (neighbor.owner === tile.owner) continue;

        // Different owners — draw wall
        const a = hexVertex(cx, cy, vA, hexSize);
        const b = hexVertex(cx, cy, vB, hexSize);
        wallG.moveTo(a.x, a.y);
        wallG.lineTo(b.x, b.y);
      }
    }
    wallG.stroke();
    hexContainer.addChild(wallG);

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
      {tooltip && (
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
