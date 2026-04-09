import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';

// --- Hex geometry (flat-top, same as HexGrid) ---
const HEX_SIZE = 24;

function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, y };
}

function pixelToAxial(px: number, py: number): { q: number; r: number } {
  const q = (2 / 3 * px) / HEX_SIZE;
  const r = (-1 / 3 * px + Math.sqrt(3) / 3 * py) / HEX_SIZE;
  return { q, r };
}

function axialRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r;
  let rq = Math.round(q); let rr = Math.round(r); let rs = Math.round(s);
  const dq = Math.abs(rq - q); const dr = Math.abs(rr - r); const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

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

// Generate all hex coords for radius r grid
function generateHexCoords(radius: number): { q: number; r: number }[] {
  const coords: { q: number; r: number }[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) <= radius) {
        coords.push({ q, r });
      }
    }
  }
  return coords;
}

// Easing functions
function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t: number): number { return t * t * t; }
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutElastic(t: number): number {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}

const BLUE = 0x2a6ecc;
const RED = 0xcc2a2a;
const CLAIM_EMOJIS = ['⚔️', '🗡️', '🛡️', '🏹', '💥', '🔥', '⚡', '🎯'];

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

interface CardState {
  x: number;
  y: number;
  rotation: number;
  alpha: number;
}

export default function HeroAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const startTimeRef = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    const app = new Application();
    const CANVAS_W = 400;
    const CANVAS_H = 320;

    app.init({
      backgroundAlpha: 0,
      width: CANVAS_W,
      height: CANVAS_H,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(() => {
      if (destroyed) { app.destroy(); return; }
      appRef.current = app;
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.objectFit = 'contain';
      containerRef.current!.appendChild(app.canvas);

      const stage = app.stage;
      const centerX = CANVAS_W / 2;
      const centerY = CANVAS_H / 2;

      // --- Generate grid data ---
      const radius = 3;
      const allHexes = generateHexCoords(radius);
      // Sort by q for left-to-right fill
      const sortedByQ = [...allHexes].sort((a, b) => a.q - b.q || a.r - b.r);

      // Split into blue (left) and red (right) halves
      // Sort all hexes by x position, then assign first half blue, second half red
      const withPixel = sortedByQ.map(h => ({ ...h, ...axialToPixel(h.q, h.r) }));
      withPixel.sort((a, b) => a.x - b.x || a.y - b.y);
      const midIdx = Math.ceil(withPixel.length / 2);
      const blueHexes = new Set(withPixel.slice(0, midIdx).map(h => `${h.q},${h.r}`));
      const redHexes = new Set(withPixel.slice(midIdx).map(h => `${h.q},${h.r}`));

      // --- Create containers ---
      const gridContainer = new Container();
      gridContainer.x = centerX;
      gridContainer.y = centerY;
      gridContainer.rotation = Math.PI / 6; // 30 degrees
      stage.addChild(gridContainer);

      const cardContainer = new Container();
      stage.addChild(cardContainer);

      // --- Cursor proximity tracking ---
      let cursorHex: { q: number; r: number } | null = null;
      let cursorOnGrid = false;
      let cursorFade = 0;
      const CURSOR_FADE_MAX = 3; // max hex distance
      const CURSOR_FADE_SPEED = 0.08;
      stage.eventMode = 'static';
      stage.hitArea = app.screen;
      stage.on('pointermove', (e) => {
        const local = gridContainer.toLocal(e.global);
        const frac = pixelToAxial(local.x, local.y);
        cursorHex = axialRound(frac.q, frac.r);
      });
      stage.on('pointerenter', () => { cursorOnGrid = true; });
      stage.on('pointerleave', () => { cursorOnGrid = false; cursorHex = null; });

      // --- Draw base grid (per-tile outlines for ripple support) ---
      const gridOutlines: { g: Graphics; hexDist: number; px: number; py: number; q: number; r: number }[] = [];
      for (const hex of allHexes) {
        const { x, y } = axialToPixel(hex.q, hex.r);
        const g = new Graphics();
        g.setStrokeStyle({ width: 1, color: 0x333355, alpha: 0.6 });
        drawHexagon(g, x, y, HEX_SIZE - 1);
        g.stroke();
        g.alpha = 0;
        gridContainer.addChild(g);
        const hexDist = (Math.abs(hex.q) + Math.abs(hex.r) + Math.abs(hex.q + hex.r)) / 2;
        gridOutlines.push({ g, hexDist, px: x, py: y, q: hex.q, r: hex.r });
      }

      // --- Hex neighbor lookup ---
      const HEX_DIRS = [[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
      const hexSet = new Set(allHexes.map(h => `${h.q},${h.r}`));

      function isBorderTile(q: number, r: number, isBlue: boolean): boolean {
        for (const [dq, dr] of HEX_DIRS) {
          const nk = `${q + dq},${r + dr}`;
          if (!hexSet.has(nk)) continue;
          const neighborIsBlue = blueHexes.has(nk);
          if (neighborIsBlue !== isBlue) return true;
        }
        return false;
      }

      // --- Tile fill graphics (one per hex for individual alpha control) ---
      const tileFills: { gBlue: Graphics; gRed: Graphics; key: string; isBlue: boolean; isBorder: boolean; targetAlpha: number; currentAlpha: number; px: number; py: number; hexDist: number }[] = [];
      for (const hex of allHexes) {
        const { x, y } = axialToPixel(hex.q, hex.r);
        const key = `${hex.q},${hex.r}`;
        const isBlue = blueHexes.has(key);
        const border = isBorderTile(hex.q, hex.r, isBlue);

        // Blue layer
        const gBlue = new Graphics();
        gBlue.beginFill(BLUE, 1);
        drawHexagon(gBlue, x, y, HEX_SIZE - 2);
        gBlue.fill();
        gBlue.alpha = 0;
        gridContainer.addChild(gBlue);

        // Red layer (on top)
        const gRed = new Graphics();
        gRed.beginFill(RED, 1);
        drawHexagon(gRed, x, y, HEX_SIZE - 2);
        gRed.fill();
        gRed.alpha = 0;
        gridContainer.addChild(gRed);

        const hexDist = (Math.abs(hex.q) + Math.abs(hex.r) + Math.abs(hex.q + hex.r)) / 2;
        tileFills.push({ gBlue, gRed, key, isBlue, isBorder: border, targetAlpha: 0, currentAlpha: 0, px: x, py: y, hexDist });
      }

      // Sort tile fills so blue fills from left and red from right
      const blueTiles = tileFills.filter(t => t.isBlue);
      const redTiles = tileFills.filter(t => !t.isBlue);
      // Blue: leftmost first, Red: rightmost first
      blueTiles.sort((a, b) => {
        const ap = axialToPixel(parseInt(a.key.split(',')[0]), parseInt(a.key.split(',')[1]));
        const bp = axialToPixel(parseInt(b.key.split(',')[0]), parseInt(b.key.split(',')[1]));
        return ap.x - bp.x || ap.y - bp.y;
      });
      redTiles.sort((a, b) => {
        const ap = axialToPixel(parseInt(a.key.split(',')[0]), parseInt(a.key.split(',')[1]));
        const bp = axialToPixel(parseInt(b.key.split(',')[0]), parseInt(b.key.split(',')[1]));
        return bp.x - ap.x || bp.y - ap.y;
      });

      // --- Card drawing ---
      const gridPixelH = (radius * 2) * Math.sqrt(3) * HEX_SIZE;
      const cardH = gridPixelH * 0.60;
      const cardW = cardH * 0.65;
      const cardR = 8; // corner radius

      const blueEmoji = CLAIM_EMOJIS[Math.floor(Math.random() * CLAIM_EMOJIS.length)];
      let redEmoji = CLAIM_EMOJIS[Math.floor(Math.random() * CLAIM_EMOJIS.length)];
      while (redEmoji === blueEmoji) redEmoji = CLAIM_EMOJIS[Math.floor(Math.random() * CLAIM_EMOJIS.length)];

      function drawCard(color: number, emoji: string): Container {
        const c = new Container();

        // Card background
        const bg = new Graphics();
        bg.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, cardR);
        bg.fill({ color: 0x181828, alpha: 0.9 });
        bg.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, cardR);
        bg.stroke({ width: 2.5, color, alpha: 0.9 });
        c.addChild(bg);

        // Emoji in upper area
        const emojiText = new Text({
          text: emoji,
          style: new TextStyle({ fontSize: 38 }),
        });
        emojiText.anchor.set(0.5);
        emojiText.y = -cardH / 2 + cardH * 0.3;
        c.addChild(emojiText);

        // Placeholder bars (grey rounded rects for "text")
        const barG = new Graphics();
        const barY1 = cardH * 0.12;
        const barY2 = barY1 + 14;
        const barY3 = barY2 + 12;
        const barW1 = cardW * 0.65;
        const barW2 = cardW * 0.5;
        const barW3 = cardW * 0.55;
        const barLeft = -cardW * 0.35; // left-aligned margin

        barG.roundRect(barLeft, barY1, barW1, 8, 4);
        barG.fill({ color: 0x555566, alpha: 0.6 });
        barG.roundRect(barLeft, barY2, barW2, 6, 3);
        barG.fill({ color: 0x444455, alpha: 0.5 });
        barG.roundRect(barLeft, barY3, barW3, 6, 3);
        barG.fill({ color: 0x444455, alpha: 0.4 });
        c.addChild(barG);

        return c;
      }

      const blueCard = drawCard(BLUE, blueEmoji);
      const redCard = drawCard(RED, redEmoji);
      cardContainer.addChild(blueCard);
      cardContainer.addChild(redCard);

      // --- Animation timeline ---
      // All times in ms
      const GRID_FADE_START = 0;
      const GRID_FADE_DUR = 600;
      const CARD_ENTER_START = 300;
      const CARD_ENTER_DUR = 1000;
      const COLLISION_TIME = CARD_ENTER_START + CARD_ENTER_DUR; // 900
      const REBOUND_DUR = 600;
      const TILE_FILL_START = 400;
      const TILE_FILL_DUR = 1200;
      const TOTAL_ANIM = COLLISION_TIME + REBOUND_DUR; // 1500
      const RIPPLE_WAVE_DELAY = 75; // ms delay per hex distance ring
      const RIPPLE_DURATION = 700; // ms per tile settle
      const RIPPLE_MAGNITUDE = 9; // px max outward push

      // Card positions
      const offscreenL = -CANVAS_W / 2 - cardW;
      const offscreenR = CANVAS_W + CANVAS_W / 2 + cardW;
      const collisionX = centerX; // meet at center
      const restL = centerX - cardW * 0.55;
      const restR = centerX + cardW * 0.55;
      const restAngleL = -0.08; // slight tilt left
      const restAngleR = 0.08;  // slight tilt right

      // State
      let animDone = false;
      startTimeRef.current = 0;
      const blueState: CardState = { x: offscreenL, y: centerY, rotation: 0, alpha: 0 };
      const redState: CardState = { x: offscreenR, y: centerY, rotation: 0, alpha: 0 };

      const tickerFn = () => {
        if (!startTimeRef.current) startTimeRef.current = performance.now();
        const elapsed = performance.now() - startTimeRef.current;

        // Cursor proximity fade
        const wantCursor = cursorOnGrid;
        const cursorTarget = wantCursor ? 1 : 0;
        cursorFade = cursorFade < cursorTarget
          ? Math.min(1, cursorFade + CURSOR_FADE_SPEED)
          : Math.max(0, cursorFade - CURSOR_FADE_SPEED);
        const proximityFactor = (q: number, r: number): number => {
          if (cursorFade <= 0 || !cursorHex) return 1;
          const dist = hexDistance(cursorHex.q, cursorHex.r, q, r);
          if (dist >= CURSOR_FADE_MAX) return 1;
          const fade = 1 - dist / CURSOR_FADE_MAX; // 1 at cursor, 0 at max dist
          return 1 - fade * 0.25 * cursorFade; // 25% max reduction
        };

        // --- Grid base fade in ---
        {
          const gridAlpha = elapsed < GRID_FADE_START + GRID_FADE_DUR
            ? easeOutCubic(Math.max(0, (elapsed - GRID_FADE_START) / GRID_FADE_DUR))
            : 1;
          for (const outline of gridOutlines) {
            outline.g.alpha = gridAlpha * proximityFactor(outline.q, outline.r);
          }
        }

        // --- Tile fills (staggered from opposing sides) ---
        if (elapsed >= TILE_FILL_START) {
          const tileProgress = Math.min(1, (elapsed - TILE_FILL_START) / TILE_FILL_DUR);

          // Each tile has a staggered start; the last tile starts at 60% progress
          // so it has 40% of the duration to fully fade in.
          const staggerEnd = 0.6;
          const fadePortion = 1 - staggerEnd; // each tile fades over this fraction

          // Blue tiles fill from left
          for (let i = 0; i < blueTiles.length; i++) {
            const staggerStart = (i / blueTiles.length) * staggerEnd;
            const localT = Math.min(1, Math.max(0, (tileProgress - staggerStart) / fadePortion));
            blueTiles[i].targetAlpha = 0.45 * easeOutCubic(localT);
          }
          // Red tiles fill from right
          for (let i = 0; i < redTiles.length; i++) {
            const staggerStart = (i / redTiles.length) * staggerEnd;
            const localT = Math.min(1, Math.max(0, (tileProgress - staggerStart) / fadePortion));
            redTiles[i].targetAlpha = 0.45 * easeOutCubic(localT);
          }
        }

        // Smooth tile alpha transitions (during enter animation, show base color)
        for (const tile of tileFills) {
          tile.currentAlpha = lerp(tile.currentAlpha, tile.targetAlpha, 0.15);
          const [tq, tr] = tile.key.split(',').map(Number);
          const pf = proximityFactor(tq, tr);
          if (tile.isBlue) {
            tile.gBlue.alpha = tile.currentAlpha * pf;
            tile.gRed.alpha = 0;
          } else {
            tile.gRed.alpha = tile.currentAlpha * pf;
            tile.gBlue.alpha = 0;
          }
        }

        // --- Ripple displacement from collision ---
        const RIPPLE_START = COLLISION_TIME - 100;
        if (elapsed >= RIPPLE_START) {
          const rippleElapsed = elapsed - RIPPLE_START;
          const applyRipple = (items: { g?: Graphics; gBlue?: Graphics; gRed?: Graphics; hexDist: number; px: number; py: number }[]) => {
            for (const item of items) {
              const delay = item.hexDist * RIPPLE_WAVE_DELAY;
              const localT = (rippleElapsed - delay) / RIPPLE_DURATION;
              const targets = item.g ? [item.g] : [item.gBlue!, item.gRed!];
              if (localT <= 0 || item.hexDist === 0 || localT >= 1) {
                for (const t of targets) { t.x = 0; t.y = 0; }
                continue;
              }
              const wave = Math.sin(localT * Math.PI) * Math.pow(1 - localT, 2);
              const mag = RIPPLE_MAGNITUDE * wave;
              const len = Math.sqrt(item.px * item.px + item.py * item.py) || 1;
              const dx = (item.px / len) * mag;
              const dy = (item.py / len) * mag;
              for (const t of targets) { t.x = dx; t.y = dy; }
            }
          };
          applyRipple(tileFills);
          applyRipple(gridOutlines);
        }

        // --- Card enter animation (accelerating in) ---
        if (elapsed >= CARD_ENTER_START && elapsed < COLLISION_TIME) {
          const t = easeInCubic((elapsed - CARD_ENTER_START) / CARD_ENTER_DUR);
          const enterTilt = 0.15;
          blueState.x = lerp(offscreenL, collisionX - cardW / 3, t);
          blueState.y = centerY;
          blueState.alpha = Math.min(1, t * 3);
          blueState.rotation = lerp(-enterTilt, 0, t);

          redState.x = lerp(offscreenR, collisionX + cardW / 3, t);
          redState.y = centerY;
          redState.alpha = Math.min(1, t * 3);
          redState.rotation = lerp(enterTilt, 0, t);
        }

        // --- Rebound to rest position ---
        if (elapsed >= COLLISION_TIME && elapsed < TOTAL_ANIM) {
          const t = (elapsed - COLLISION_TIME) / REBOUND_DUR;
          const bounce = easeOutElastic(Math.min(1, t));

          blueState.x = lerp(collisionX - cardW / 3, restL, bounce);
          blueState.rotation = lerp(0, restAngleL, bounce);
          blueState.alpha = 1;

          redState.x = lerp(collisionX + cardW / 3, restR, bounce);
          redState.rotation = lerp(0, restAngleR, bounce);
          redState.alpha = 1;
        }

        // --- Idle breathing ---
        if (elapsed >= TOTAL_ANIM) {
          if (!animDone) {
            animDone = true;
            blueState.x = restL;
            blueState.rotation = restAngleL;
            redState.x = restR;
            redState.rotation = restAngleR;
            // Snap tiles to full base color and clear any ripple displacement
            for (const tile of tileFills) {
              tile.currentAlpha = 0.45;
              tile.targetAlpha = 0.45;
              tile.gBlue.x = 0; tile.gBlue.y = 0;
              tile.gRed.x = 0; tile.gRed.y = 0;
            }
            for (const outline of gridOutlines) {
              outline.g.x = 0; outline.g.y = 0;
            }
          }

          const idleT = (elapsed - TOTAL_ANIM) / 1000;
          const breatheRamp = Math.min(1, idleT / 0.5);
          const breathe = Math.sin(idleT * 1.2) * 2 * breatheRamp;
          const breathe2 = Math.sin(idleT * 1.2 + 0.5) * 2 * breatheRamp;

          blueCard.x = restL;
          blueCard.y = centerY + breathe;
          blueCard.rotation = restAngleL;
          blueCard.alpha = 1;

          redCard.x = restR;
          redCard.y = centerY + breathe2;
          redCard.rotation = restAngleR;
          redCard.alpha = 1;

          // Tile breathing + border contest (ramps in over first 3s of idle)
          const contestRamp = Math.min(1, idleT / 3);
          for (const tile of tileFills) {
            const [q, r] = tile.key.split(',').map(Number);
            const pf = proximityFactor(q, r);
            const baseAlpha = 0.45 + Math.sin(idleT * 0.8) * 0.05;
            if (tile.isBorder && contestRamp > 0) {
              const phase = (q * 1.7 + r * 2.3);
              const contest = (Math.sin(idleT * 0.6 + phase) * 0.5 + 0.5) * contestRamp;
              if (tile.isBlue) {
                tile.gBlue.alpha = baseAlpha * (1 - contest * 0.7) * pf;
                tile.gRed.alpha = baseAlpha * contest * 0.7 * pf;
              } else {
                tile.gRed.alpha = baseAlpha * (1 - contest * 0.7) * pf;
                tile.gBlue.alpha = baseAlpha * contest * 0.7 * pf;
              }
            } else {
              if (tile.isBlue) {
                tile.gBlue.alpha = baseAlpha * pf;
                tile.gRed.alpha = 0;
              } else {
                tile.gRed.alpha = baseAlpha * pf;
                tile.gBlue.alpha = 0;
              }
            }
          }
          // Apply proximity to outlines during idle
          for (const outline of gridOutlines) {
            outline.g.alpha = proximityFactor(outline.q, outline.r);
          }
          return;
        }

        // Apply card state
        blueCard.x = blueState.x;
        blueCard.y = blueState.y;
        blueCard.rotation = blueState.rotation;
        blueCard.alpha = blueState.alpha;

        redCard.x = redState.x;
        redCard.y = redState.y;
        redCard.rotation = redState.rotation;
        redCard.alpha = redState.alpha;
      };

      app.ticker.add(tickerFn);
    });

    return () => {
      destroyed = true;
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    />
  );
}
