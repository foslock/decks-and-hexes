import { useEffect, useRef, useCallback } from 'react';
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
  selected: 0x5a5a8e,
};

interface HexGridProps {
  tiles: Record<string, HexTile>;
  selectedTile: string | null;
  onTileClick: (q: number, r: number) => void;
  highlightTiles?: Set<string>;
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

export default function HexGrid({ tiles, selectedTile, onTileClick, highlightTiles }: HexGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const tilesRef = useRef(tiles);
  const selectedRef = useRef(selectedTile);
  const highlightRef = useRef(highlightTiles);
  const onClickRef = useRef(onTileClick);
  const hexContainerRef = useRef<Container | null>(null);

  tilesRef.current = tiles;
  selectedRef.current = selectedTile;
  highlightRef.current = highlightTiles;
  onClickRef.current = onTileClick;

  const renderTiles = useCallback(() => {
    const hexContainer = hexContainerRef.current;
    if (!hexContainer) return;

    hexContainer.removeChildren();

    const tiles = tilesRef.current;
    const selected = selectedRef.current;
    const highlights = highlightRef.current;

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

      if (key === selected) {
        fillColor = TILE_COLORS.selected;
      }

      // Draw hex
      let strokeColor = 0x555577;
      if (highlights?.has(key)) {
        strokeColor = 0xffff00;
      }

      g.setStrokeStyle({ width: 2, color: strokeColor });
      g.fill({ color: fillColor, alpha: tile.is_blocked ? 0.3 : 0.8 });
      drawHexagon(g, x, y, HEX_SIZE - 1);
      g.fill();
      g.stroke();

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

      // Defense power indicator
      if (tile.defense_power > 0) {
        const def = new Text({
          text: `🛡${tile.defense_power}`,
          style: new TextStyle({ fontSize: 10, fill: 0xffffff }),
        });
        def.anchor.set(0.5);
        def.position.set(x, y + 8);
        hexContainer.addChild(def);
      }

      // Coordinate label (small)
      const label = new Text({
        text: `${tile.q},${tile.r}`,
        style: new TextStyle({ fontSize: 8, fill: 0x888888 }),
      });
      label.anchor.set(0.5);
      label.position.set(x, y + (tile.is_vp ? 4 : 0));
      hexContainer.addChild(label);

      // Click handler
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

      hexContainer.addChild(g);
    }
  }, []);

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

      // Center the grid
      hexContainer.position.set(
        app.screen.width / 2,
        app.screen.height / 2,
      );

      renderTiles();
    });

    return () => {
      destroyed = true;
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
    };
  }, []);

  // Re-render tiles when data changes
  useEffect(() => {
    renderTiles();
  }, [tiles, selectedTile, highlightTiles, renderTiles]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: 500 }}
    />
  );
}
