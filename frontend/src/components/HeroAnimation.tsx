import { useEffect, useRef, useState, type RefObject } from 'react';
import { Application, Container, Graphics } from 'pixi.js';

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
  let rq = Math.round(q); let rr = Math.round(r); const rs = Math.round(s);
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
function easeOutElastic(t: number): number {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}

const BLUE = 0x2f6fd0;
const RED = 0xc8323c;
const GRID_LINE = 0x8c7a52; // warm hairline between tiles

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

// --- Scene layout (internal canvas units; the canvas is CSS-scaled with
// object-fit: contain and the DOM cards follow the same transform) ---
const CANVAS_W = 400;
const CANVAS_H = 320;
const GRID_RADIUS = 3;
const GRID_PIXEL_H = (GRID_RADIUS * 2) * Math.sqrt(3) * HEX_SIZE;
const CARD_H = GRID_PIXEL_H * 0.66;
const CARD_W = CARD_H * 0.68;
/** Root font size of a hero card in canvas units — card internals use em. */
const CARD_FONT = 10;

// --- The two cards that clash in the hero. Real cards + their WebP art. ---
interface HeroCardDef {
  id: string;
  name: string;
  archetype: string;
  type: 'Claim' | 'Defense';
  cost: number;
  text: string;
}

const CLAIM_COLOR = '#a83040';   // CARD_TYPE_COLORS.claim
const DEFENSE_COLOR = '#3a7abf'; // CARD_TYPE_COLORS.defense

/** Blue (left) side defends… */
const DEFENDERS: HeroCardDef[] = [
  { id: 'fortress_iron_wall', name: 'Iron Wall', archetype: 'Fortress', type: 'Defense', cost: 3, text: 'One tile you own cannot be claimed this round.' },
  { id: 'fortress_citadel', name: 'Twin Cities', archetype: 'Fortress', type: 'Defense', cost: 7, text: 'Two tiles you own each get +3 permanent defense until captured. Trash this card.' },
  { id: 'fortress_bulwark', name: 'Bulwark', archetype: 'Fortress', type: 'Defense', cost: 3, text: 'Two tiles you own each gain +2 defense this round.' },
];
/** …red (right) side attacks. */
const ATTACKERS: HeroCardDef[] = [
  { id: 'vanguard_spearhead', name: 'Spearhead', archetype: 'Vanguard', type: 'Claim', cost: 7, text: 'Claim: Power 8. Trash this card.' },
  { id: 'neutral_conqueror', name: 'Conqueror', archetype: 'Shared', type: 'Claim', cost: 7, text: 'Claim: Power 5. Ignores temporary defense bonuses on targeted tile.' },
  { id: 'vanguard_blitz', name: 'Blitz', archetype: 'Vanguard', type: 'Claim', cost: 3, text: 'Claim: Power 2. If successful, draw 1 card next round.' },
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** Bold the numbers that matter ("Power 8", "+2 defense"). */
function renderCardText(text: string) {
  return text.split(/(Power \d+|\+\d+(?: permanent)? defense)/).map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part,
  );
}

function HeroCard({ card, accent, cardRef }: { card: HeroCardDef; accent: string; cardRef: RefObject<HTMLDivElement> }) {
  return (
    <div
      ref={cardRef}
      className="cc-scr-hero-card"
      style={{ ['--hc-accent' as string]: accent, width: CARD_W, height: CARD_H, fontSize: CARD_FONT }}
    >
      <div className="cc-scr-hero-card-head">
        <span className="cc-scr-hero-card-name">{card.name}</span>
        <span className="cc-scr-hero-card-cost">{card.cost}</span>
      </div>
      <div className="cc-scr-hero-card-art">
        <img src={`/cards/${card.id}.webp`} alt="" draggable={false} decoding="async" />
      </div>
      <div className="cc-scr-hero-card-type">
        {card.archetype} <span style={{ opacity: 0.5 }}>—</span> <b>{card.type}</b>
      </div>
      <div className="cc-scr-hero-card-text">{renderCardText(card.text)}</div>
    </div>
  );
}

/**
 * Tear a Pixi app down without a white flash.
 *
 * Losing the WebGL context is slow (~40 ms) and React runs this effect's
 * cleanup in the same task as the commit that swaps the home screen for the
 * lobby. Destroying synchronously there blocks the main thread while the
 * compositor is still showing the previous frame, whose canvas layer now
 * points at a lost context — browsers paint that as a blank white rectangle
 * until the next frame lands. So: stop rendering and detach the canvas now,
 * and destroy once the next screen has actually painted.
 */
function disposeApp(app: Application) {
  try { app.ticker?.stop(); } catch { /* never initialised */ }
  try {
    const canvas = app.canvas as HTMLCanvasElement | undefined;
    if (canvas) {
      canvas.style.display = 'none';
      canvas.remove();
    }
  } catch { /* renderer never created */ }
  let done = false;
  const destroy = () => {
    if (done) return;
    done = true;
    try { app.destroy(true, { children: true }); } catch { /* already gone */ }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(destroy, 32));
  }
  // Fallback for hidden tabs, where rAF never fires.
  setTimeout(destroy, 1000);
}

interface CardState {
  x: number;
  y: number;
  rotation: number;
  alpha: number;
}

export default function HeroAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const blueCardRef = useRef<HTMLDivElement>(null);
  const redCardRef = useRef<HTMLDivElement>(null);
  const [cards] = useState(() => ({ blue: pick(DEFENDERS), red: pick(ATTACKERS) }));

  useEffect(() => {
    const container = containerRef.current;
    const canvasHost = canvasHostRef.current;
    if (!container || !canvasHost) return;
    let destroyed = false;
    let ready = false;

    const app = new Application();

    // Cap resolution on phones to avoid DPR-3 + 4x antialias blowing up the
    // WebGL backbuffer on iOS Safari. iPadOS (incl. its Macintosh UA) and
    // macOS get full DPR for crisp output. The canvas is CSS-scaled to fill
    // the hero area, so the backbuffer is also scaled by how much the
    // 400x320 scene is enlarged (otherwise it's upscaled and blurry on big
    // screens) — capped at 2 on phones and 3 elsewhere.
    const rawDpr = window.devicePixelRatio || 1;
    const ua = navigator.userAgent;
    const isPhone = /iPhone|iPod/.test(ua)
      || (/Android/.test(ua) && /Mobile/.test(ua))
      || /webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const computeResolution = () => {
      const fit = Math.min(container.clientWidth / CANVAS_W, container.clientHeight / CANVAS_H) || 1;
      const ideal = rawDpr * Math.max(1, fit);
      return Math.min(ideal, isPhone ? Math.min(rawDpr, 2) : Math.max(rawDpr, 3));
    };

    // --- DOM card overlay: mirror the canvas's object-fit: contain box ---
    const layout = { scale: 1, offX: 0, offY: 0, w: CARD_W, h: CARD_H };
    const applyLayout = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (!cw || !ch) return;
      const s = Math.min(cw / CANVAS_W, ch / CANVAS_H);
      layout.scale = s;
      layout.offX = (cw - CANVAS_W * s) / 2;
      layout.offY = (ch - CANVAS_H * s) / 2;
      layout.w = CARD_W * s;
      layout.h = CARD_H * s;
      for (const el of [blueCardRef.current, redCardRef.current]) {
        if (!el) continue;
        el.style.width = `${layout.w}px`;
        el.style.height = `${layout.h}px`;
        el.style.fontSize = `${CARD_FONT * s}px`;
      }
    };
    const placeCard = (el: HTMLDivElement | null, st: CardState) => {
      if (!el) return;
      const x = layout.offX + st.x * layout.scale - layout.w / 2;
      const y = layout.offY + st.y * layout.scale - layout.h / 2;
      el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${st.rotation.toFixed(4)}rad)`;
      el.style.opacity = st.alpha >= 1 ? '1' : st.alpha.toFixed(3);
    };
    applyLayout();

    const centerX = CANVAS_W / 2;
    const centerY = CANVAS_H / 2;
    // Card rest positions (also used by the no-WebGL fallback)
    const restL = centerX - CARD_W * 0.55;
    const restR = centerX + CARD_W * 0.55;
    const restAngleL = -0.08; // slight tilt left
    const restAngleR = 0.08;  // slight tilt right
    const showStaticCards = () => {
      placeCard(blueCardRef.current, { x: restL, y: centerY, rotation: restAngleL, alpha: 1 });
      placeCard(redCardRef.current, { x: restR, y: centerY, rotation: restAngleR, alpha: 1 });
    };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastResolution = computeResolution();
    let onLayoutChange: (() => void) | null = null;
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        applyLayout();
        onLayoutChange?.();
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (destroyed || !ready) return;
          const res = computeResolution();
          if (Math.abs(res - lastResolution) > 0.05) {
            lastResolution = res;
            app.renderer.resize(CANVAS_W, CANVAS_H, res);
          }
        }, 200);
      })
      : null;
    ro?.observe(container);

    app.init({
      backgroundAlpha: 0,
      width: CANVAS_W,
      height: CANVAS_H,
      antialias: true,
      resolution: lastResolution,
      autoDensity: false, // CSS size is controlled by the stylesheet (100%, contain)
    }).then(() => {
      if (destroyed) { disposeApp(app); return; }
      ready = true;
      canvasHost.appendChild(app.canvas);

      const stage = app.stage;

      // --- Generate grid data ---
      const radius = GRID_RADIUS;
      const allHexes = generateHexCoords(radius);
      // Sort by q for left-to-right fill
      const sortedByQ = [...allHexes].sort((a, b) => a.q - b.q || a.r - b.r);

      // Split into blue (left) and red (right) halves
      // Sort all hexes by x position, then assign first half blue, second half red
      const withPixel = sortedByQ.map(h => ({ ...h, ...axialToPixel(h.q, h.r) }));
      withPixel.sort((a, b) => a.x - b.x || a.y - b.y);
      const midIdx = Math.ceil(withPixel.length / 2);
      const blueHexes = new Set(withPixel.slice(0, midIdx).map(h => `${h.q},${h.r}`));

      // --- Create containers ---
      const gridContainer = new Container();
      gridContainer.x = centerX;
      gridContainer.y = centerY;
      gridContainer.rotation = Math.PI / 6; // 30 degrees
      stage.addChild(gridContainer);

      // Hover highlight layer (behind cards)
      const hoverG = new Graphics();
      gridContainer.addChild(hoverG);
      let prevHoverKey: string | null = null;

      // --- Cursor proximity tracking ---
      // Use native DOM events to avoid Pixi's coordinate mismatch with object-fit: contain
      let cursorHex: { q: number; r: number } | null = null;
      let cursorOnGrid = false;
      let cursorFade = 0;
      const CURSOR_FADE_MAX = 3; // max hex distance
      const CURSOR_FADE_SPEED = 0.08;
      const GRID_ROTATION = Math.PI / 6;

      const canvasEl = app.canvas as HTMLCanvasElement;
      const updateCursorHex = (clientX: number, clientY: number) => {
        const rect = canvasEl.getBoundingClientRect();
        // object-fit: contain scales uniformly — compute actual drawn area within the element
        const scaleX = rect.width / CANVAS_W;
        const scaleY = rect.height / CANVAS_H;
        const scale = Math.min(scaleX, scaleY);
        const drawnW = CANVAS_W * scale;
        const drawnH = CANVAS_H * scale;
        const offsetX = (rect.width - drawnW) / 2;
        const offsetY = (rect.height - drawnH) / 2;
        // Position in internal canvas coordinates
        const px = (clientX - rect.left - offsetX) / scale;
        const py = (clientY - rect.top - offsetY) / scale;
        // Undo grid container transform (translate to center, then inverse rotation)
        const dx = px - centerX;
        const dy = py - centerY;
        const cos = Math.cos(-GRID_ROTATION);
        const sin = Math.sin(-GRID_ROTATION);
        const localX = dx * cos - dy * sin;
        const localY = dx * sin + dy * cos;
        const frac = pixelToAxial(localX, localY);
        cursorHex = axialRound(frac.q, frac.r);
      };
      canvasEl.addEventListener('pointermove', (e) => updateCursorHex(e.clientX, e.clientY));
      canvasEl.addEventListener('pointerenter', () => { cursorOnGrid = true; });
      canvasEl.addEventListener('pointerleave', () => { cursorOnGrid = false; cursorHex = null; });

      // --- Draw base grid (per-tile outlines for ripple support) ---
      const gridOutlines: { g: Graphics; hexDist: number; px: number; py: number; q: number; r: number }[] = [];
      for (const hex of allHexes) {
        const { x, y } = axialToPixel(hex.q, hex.r);
        const g = new Graphics();
        g.setStrokeStyle({ width: 1, color: GRID_LINE, alpha: 0.55 });
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
        drawHexagon(gBlue, x, y, HEX_SIZE - 2);
        gBlue.fill({ color: BLUE, alpha: 1 });
        gBlue.alpha = 0;
        gridContainer.addChild(gBlue);

        // Red layer (on top)
        const gRed = new Graphics();
        drawHexagon(gRed, x, y, HEX_SIZE - 2);
        gRed.fill({ color: RED, alpha: 1 });
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

      // --- Cards (DOM elements laid over the canvas) ---
      const cardW = CARD_W;
      const blueCard = blueCardRef.current;
      const redCard = redCardRef.current;

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
      const RIPPLE_MAGNITUDE = 13; // px max outward push

      // Card positions
      const offscreenL = -CANVAS_W / 2 - cardW;
      const offscreenR = CANVAS_W + CANVAS_W / 2 + cardW;
      const collisionX = centerX; // meet at center

      // State
      let animDone = false;
      let startTime = 0;
      const blueState: CardState = { x: offscreenL, y: centerY, rotation: 0, alpha: 0 };
      const redState: CardState = { x: offscreenR, y: centerY, rotation: 0, alpha: 0 };
      // Re-place the cards immediately when the hero is resized
      onLayoutChange = () => { placeCard(blueCard, blueState); placeCard(redCard, redState); };

      const tickerFn = () => {
        if (!startTime) startTime = performance.now();
        const elapsed = performance.now() - startTime;

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

        // --- Hex hover highlight ---
        {
          const hoverKey = cursorHex && hexSet.has(`${cursorHex.q},${cursorHex.r}`)
            ? `${cursorHex.q},${cursorHex.r}` : null;
          if (hoverKey !== prevHoverKey) {
            prevHoverKey = hoverKey;
            hoverG.clear();
            if (cursorHex && hoverKey) {
              const { x: hx, y: hy } = axialToPixel(cursorHex.q, cursorHex.r);
              // Glow fill
              hoverG.setFillStyle({ color: 0xffffff, alpha: 0.1 });
              drawHexagon(hoverG, hx, hy, HEX_SIZE - 1);
              hoverG.fill();
              // Edge highlight
              hoverG.setStrokeStyle({ width: 2.5, color: 0xffe9b0, alpha: 0.65, cap: 'round' });
              drawHexagon(hoverG, hx, hy, HEX_SIZE - 1);
              hoverG.stroke();
              // Neighbor subtle glow
              for (const [dq, dr] of HEX_DIRS) {
                const nk = `${cursorHex.q + dq},${cursorHex.r + dr}`;
                if (!hexSet.has(nk)) continue;
                const { x: nx, y: ny } = axialToPixel(cursorHex.q + dq, cursorHex.r + dr);
                hoverG.setStrokeStyle({ width: 1.5, color: 0xffffff, alpha: 0.15, cap: 'round' });
                drawHexagon(hoverG, nx, ny, HEX_SIZE - 1);
                hoverG.stroke();
              }
            }
          }
        }

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
        const RIPPLE_START = COLLISION_TIME - 180;
        if (elapsed >= RIPPLE_START && !animDone) {
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

          blueState.x = restL;
          blueState.y = centerY + breathe;
          blueState.rotation = restAngleL;
          blueState.alpha = 1;

          redState.x = restR;
          redState.y = centerY + breathe2;
          redState.rotation = restAngleR;
          redState.alpha = 1;

          placeCard(blueCard, blueState);
          placeCard(redCard, redState);

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
        placeCard(blueCard, blueState);
        placeCard(redCard, redState);
      };

      app.ticker.add(tickerFn);
    }).catch(() => {
      // No WebGL (or init failed): show the two cards at rest over an empty board.
      if (!destroyed) showStaticCards();
    });

    return () => {
      destroyed = true;
      onLayoutChange = null;
      ro?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (ready) disposeApp(app);
    };
  }, []);

  return (
    <div ref={containerRef} className="cc-scr-hero" aria-hidden="true">
      <div ref={canvasHostRef} className="cc-scr-hero-canvas" />
      <HeroCard card={cards.blue} accent={DEFENSE_COLOR} cardRef={blueCardRef} />
      <HeroCard card={cards.red} accent={CLAIM_COLOR} cardRef={redCardRef} />
    </div>
  );
}
