import { useEffect, useRef, useState, type RefObject } from 'react';
import type { HexTile } from '../types/game';
import { BoardEngine } from '../board3d/engine';
import { useVisualQuality } from './SettingsContext';
import { PLAYER_COLORS } from '../board3d/boardTypes';
import { axialToWorld } from '../board3d/layout';
import { waitForImages } from '../utils/appReady';
import type { Card } from '../types/game';
import CardFull, { CARD_FULL_HEIGHT, CARD_FULL_WIDTH } from './CardFull';
import { useCardCatalog } from '../cardCatalog';

// Generate all hex coords for a radius-r grid
function generateHexCoords(radius: number): { q: number; r: number }[] {
  const coords: { q: number; r: number }[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) <= radius) coords.push({ q, r });
    }
  }
  return coords;
}

// Easing functions
function easeInCubic(t: number): number { return t * t * t; }
function easeOutElastic(t: number): number {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}

const BLUE = 0x2f6fd0;
const RED = 0xc8323c;
const BLUE_ID = 'hero_blue';
const RED_ID = 'hero_red';

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

// --- Scene layout (internal canvas units; the canvas is CSS-scaled with
// object-fit: contain and the DOM cards follow the same transform) ---
const CANVAS_W = 400;
const CANVAS_H = 320;
const GRID_RADIUS = 3;
/** Legacy 2D hex radius the card layout was tuned against. */
const LAYOUT_HEX = 24;
const GRID_PIXEL_H = (GRID_RADIUS * 2) * Math.sqrt(3) * LAYOUT_HEX;
const CARD_H = GRID_PIXEL_H * 0.66;
const CARD_W = CARD_H * (CARD_FULL_WIDTH / CARD_FULL_HEIGHT);

// --- The two cards that clash in the hero. Real cards + their WebP art. ---
interface HeroCardDef {
  id: string;
  name: string;
  archetype: string;
  type: 'Claim' | 'Defense';
  cost: number;
  text: string;
}

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

/** A stand-in Card until the catalog (with the real stats) has loaded. */
function fallbackCard(def: HeroCardDef): Card {
  return {
    id: def.id, definition_id: def.id, name: def.name,
    archetype: def.archetype.toLowerCase(), card_type: def.type.toLowerCase(),
    power: 0, resource_gain: 0, action_return: 0, action_cost: 1, timing: 'immediate',
    buy_cost: def.cost, is_upgraded: false, trash_on_use: false, stackable: false,
    forced_discard: 0, draw_cards: 0, defense_bonus: 0, adjacency_required: true,
    claim_range: 1, unoccupied_only: false, multi_target_count: 0, defense_target_count: 1,
    flood: false, target_own_tile: false, passive_vp: 0, description: def.text, starter: false,
  };
}

function HeroCard({ card, cardRef }: { card: HeroCardDef; cardRef: RefObject<HTMLDivElement> }) {
  const catalog = useCardCatalog();
  const full = catalog.getCardByName(card.name) ?? fallbackCard(card);
  return (
    <div ref={cardRef} className="cc-scr-hero-card" style={{ width: CARD_W, height: CARD_H }}>
      <div className="cc-scr-hero-card-face">
        <CardFull card={full} />
      </div>
    </div>
  );
}

interface CardState {
  x: number;
  y: number;
  rotation: number;
  alpha: number;
}

interface HeroAnimationProps {
  /** Hold the intro at frame zero until this turns true. */
  start?: boolean;
  /** Fired once the diorama's shaders are compiled and the card art is decoded. */
  onReady?: () => void;
  /** Stop drawing while something covers the home screen (the tutorial). */
  paused?: boolean;
}

export default function HeroAnimation({ start = true, onReady, paused = false }: HeroAnimationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BoardEngine | null>(null);
  // Changing the visual quality rebuilds the diorama (its renderer's
  // antialiasing and pixel ratio are fixed at creation).
  const lowQuality = useVisualQuality() === 'low';
  /** The intro has played: a rebuild goes straight to the settled scene. */
  const introPlayedRef = useRef(false);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const blueCardRef = useRef<HTMLDivElement>(null);
  const redCardRef = useRef<HTMLDivElement>(null);
  const [cards] = useState(() => ({ blue: pick(DEFENDERS), red: pick(ATTACKERS) }));
  const startRef = useRef(start);
  startRef.current = start;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const container = containerRef.current;
    const canvasHost = canvasHostRef.current;
    if (!container || !canvasHost) return;
    let destroyed = false;

    // --- DOM card overlay: mirror an object-fit: contain box of the
    // 400x320 design space the card choreography is authored in ---
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
        el.style.setProperty('--hc-scale', String(layout.w / CARD_FULL_WIDTH));
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
    const restL = centerX - CARD_W * 0.55;
    const restR = centerX + CARD_W * 0.55;
    const restAngleL = -0.08;
    const restAngleR = 0.08;
    const showStaticCards = () => {
      placeCard(blueCardRef.current, { x: restL, y: centerY, rotation: restAngleL, alpha: 1 });
      placeCard(redCardRef.current, { x: restR, y: centerY, rotation: restAngleR, alpha: 1 });
    };

    const engine = new BoardEngine(canvasHost, lowQuality ? { hero: true, antialias: false, maxPixelRatio: 1 } : { hero: true });
    const rebuild = introPlayedRef.current;
    engineRef.current = engine;
    if (import.meta.env.DEV) (window as unknown as { __hero?: BoardEngine }).__hero = engine;
    let onLayoutChange: (() => void) | null = null;
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        applyLayout();
        onLayoutChange?.();
        engine.setPadding(Math.max(8, container.clientHeight * 0.06));
      })
      : null;
    ro?.observe(container);
    const art = waitForImages([`/cards/${cards.blue.id}.webp`, `/cards/${cards.red.id}.webp`]);
    if (!engine.ok) {
      // No WebGL: the two cards at rest over the empty backdrop.
      showStaticCards();
      void art.then(() => { if (!destroyed) onReadyRef.current?.(); });
      return () => { destroyed = true; ro?.disconnect(); engine.dispose(); };
    }

    // --- A small diorama: two castles, a walled temple, a pair of peaks ---
    PLAYER_COLORS[BLUE_ID] = BLUE;
    PLAYER_COLORS[RED_ID] = RED;
    const GRID_ROTATION = Math.PI / 6;
    const coords = generateHexCoords(GRID_RADIUS);
    const blocked = new Set(['0,-3', '-1,3', '2,1']);
    const tiles: Record<string, HexTile> = {};
    for (const { q, r } of coords) {
      const key = `${q},${r}`;
      const isBlueBase = key === '-3,2';
      const isRedBase = key === '3,-2';
      const isTemple = key === '0,0';
      tiles[key] = {
        q, r,
        is_blocked: blocked.has(key),
        is_vp: isTemple,
        vp_value: isTemple ? 2 : 1,
        owner: isBlueBase ? BLUE_ID : isRedBase ? RED_ID : null,
        defense_power: isTemple ? 3 : isBlueBase || isRedBase ? 3 : 0,
        base_defense: isTemple ? 3 : isBlueBase || isRedBase ? 3 : 0,
        permanent_defense_bonus: 0,
        held_since_turn: 0,
        is_base: isBlueBase || isRedBase,
        base_owner: isBlueBase ? BLUE_ID : isRedBase ? RED_ID : null,
      };
    }
    const info = {
      [BLUE_ID]: { name: 'Blue', archetype: 'fortress' },
      [RED_ID]: { name: 'Red', archetype: 'vanguard' },
    };
    // Screen-x ordering (after the 30° board rotation) decides each side's
    // fill order: blue sweeps in from the left, red from the right.
    const screenX = (q: number, r: number) => {
      const w = axialToWorld(q, r);
      return w.x * Math.cos(GRID_ROTATION) - w.z * Math.sin(GRID_ROTATION);
    };
    const claimable = coords.filter(({ q, r }) => {
      const t = tiles[`${q},${r}`];
      return !t.is_blocked && !t.is_vp && !t.is_base;
    });
    const blueTiles = claimable.filter(c => screenX(c.q, c.r) < -0.01).sort((a, b) => screenX(a.q, a.r) - screenX(b.q, b.r));
    const redTiles = claimable.filter(c => screenX(c.q, c.r) > 0.01).sort((a, b) => screenX(b.q, b.r) - screenX(a.q, a.r));
    const neutralMid = claimable.filter(c => Math.abs(screenX(c.q, c.r)) <= 0.01);

    engine.setBoard(tiles, info, new Set());
    engine.setRotation(GRID_ROTATION);
    engine.setTilt(0.62);
    engine.setPadding(Math.max(8, container.clientHeight * 0.06));
    engine.setSway(0.07);
    engine.setBuildProgress(rebuild ? 1 : 0);
    engine.setInputListener({
      onHover: (key) => engine.setHover(key && !tiles[key]?.is_blocked ? key : null),
      onLeave: () => engine.setHover(null),
    });

    // Compile the diorama's shaders and decode the card art before the intro
    // may begin, so its first frames are smooth.
    let warmed = false;
    void Promise.all([engine.warmUp(), art]).then(() => {
      if (destroyed) return;
      warmed = true;
      onReadyRef.current?.();
    });

    // --- Animation timeline (ms) ---
    const BUILD_DUR = 1900;
    const CARD_ENTER_START = 500;
    const CARD_ENTER_DUR = 1000;
    const COLLISION_TIME = CARD_ENTER_START + CARD_ENTER_DUR;
    const REBOUND_DUR = 600;
    const TILE_FILL_START = 900;
    const TILE_FILL_DUR = 1200;
    const TOTAL_ANIM = COLLISION_TIME + REBOUND_DUR;
    const BORDER_EVERY = 2300;

    const cardW = CARD_W;
    const blueCard = blueCardRef.current;
    const redCard = redCardRef.current;
    const offscreenL = -CANVAS_W / 2 - cardW;
    const offscreenR = CANVAS_W + CANVAS_W / 2 + cardW;
    const collisionX = centerX;

    const blueState: CardState = { x: offscreenL, y: centerY, rotation: 0, alpha: 0 };
    const redState: CardState = { x: offscreenR, y: centerY, rotation: 0, alpha: 0 };
    onLayoutChange = () => { placeCard(blueCard, blueState); placeCard(redCard, redState); };

    let filledBlue = 0;
    let filledRed = 0;
    // A rebuild has nothing left to introduce: no clash or build.
    let collided = rebuild;
    let built = rebuild;
    let nextBorder = TOTAL_ANIM + 1200;
    let startTime = 0;
    let raf = 0;
    let pausedSince = 0;
    // Cards wait offscreen until the intro starts.
    placeCard(blueCard, blueState);
    placeCard(redCard, redState);

    const commit = () => engine.setBoard({ ...tiles }, info, new Set());
    const setOwner = (key: string, owner: string | null) => {
      tiles[key] = { ...tiles[key], owner };
    };

    const tick = () => {
      if (destroyed) return;
      // Covered (the tutorial): the scene and its clock hold still, so the
      // paused board isn't fed tile changes it can't animate.
      if (pausedRef.current && startTime) {
        if (!pausedSince) pausedSince = performance.now();
        raf = requestAnimationFrame(tick);
        return;
      }
      if (pausedSince) {
        startTime += performance.now() - pausedSince;
        pausedSince = 0;
      }
      if (!startTime) {
        if (!startRef.current || !warmed) { raf = requestAnimationFrame(tick); return; }
        if (rebuild) {
          // Pick up where the intro leaves off: territories filled, cards at rest.
          startTime = performance.now() - TOTAL_ANIM;
        } else {
          startTime = performance.now();
          introPlayedRef.current = true;
          engine.playIntro();
        }
      }
      const elapsed = performance.now() - startTime;

      if (!built) {
        const b = Math.min(1, elapsed / BUILD_DUR);
        engine.setBuildProgress(b);
        built = b >= 1;
      }

      // Territories sweep in from opposite sides.
      if (elapsed >= TILE_FILL_START) {
        const p = Math.min(1, (elapsed - TILE_FILL_START) / TILE_FILL_DUR);
        const wantBlue = Math.round(p * blueTiles.length);
        const wantRed = Math.round(p * redTiles.length);
        let changed = false;
        while (filledBlue < wantBlue) { const c = blueTiles[filledBlue++]; setOwner(`${c.q},${c.r}`, BLUE_ID); changed = true; }
        while (filledRed < wantRed) { const c = redTiles[filledRed++]; setOwner(`${c.q},${c.r}`, RED_ID); changed = true; }
        if (changed) commit();
      }

      // Card entry (accelerating in) → collision → elastic rebound → idle breathing.
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
      } else if (elapsed >= COLLISION_TIME && elapsed < TOTAL_ANIM) {
        if (!collided) {
          collided = true;
          const fx = engine.fx;
          fx?.shockwave(0, 0, 0xffe2a0, 3.4, 900);
          fx?.sparks(0, 0, 0xffd27a, 46, 1.4);
          fx?.dust(0, 0, 16, 1.2);
          fx?.shake(0.9, 420);
          fx?.jolt(0, 0, 1.2);
        }
        const t = (elapsed - COLLISION_TIME) / REBOUND_DUR;
        const bounce = easeOutElastic(Math.min(1, t));
        blueState.x = lerp(collisionX - cardW / 3, restL, bounce);
        blueState.rotation = lerp(0, restAngleL, bounce);
        blueState.alpha = 1;
        redState.x = lerp(collisionX + cardW / 3, restR, bounce);
        redState.rotation = lerp(0, restAngleR, bounce);
        redState.alpha = 1;
      } else if (elapsed >= TOTAL_ANIM) {
        const idleT = (elapsed - TOTAL_ANIM) / 1000;
        const breatheRamp = Math.min(1, idleT / 0.5);
        blueState.x = restL;
        blueState.y = centerY + Math.sin(idleT * 1.2) * 2 * breatheRamp;
        blueState.rotation = restAngleL;
        blueState.alpha = 1;
        redState.x = restR;
        redState.y = centerY + Math.sin(idleT * 1.2 + 0.5) * 2 * breatheRamp;
        redState.rotation = restAngleR;
        redState.alpha = 1;

        // The front line keeps shifting: a border tile changes hands now and then.
        if (elapsed >= nextBorder) {
          nextBorder = elapsed + BORDER_EVERY * (0.7 + Math.random() * 0.6);
          const border = [...claimable, ...neutralMid].filter(({ q, r }) => {
            const t = tiles[`${q},${r}`];
            return [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]].some(([dq, dr]) => {
              const n = tiles[`${q + dq},${r + dr}`];
              return n && n.owner && n.owner !== t.owner;
            });
          });
          const pick = border[Math.floor(Math.random() * border.length)];
          if (pick) {
            const key = `${pick.q},${pick.r}`;
            const cur = tiles[key].owner;
            setOwner(key, cur === BLUE_ID ? RED_ID : cur === RED_ID ? BLUE_ID : (Math.random() < 0.5 ? BLUE_ID : RED_ID));
            commit();
          }
        }
      }

      placeCard(blueCard, blueState);
      placeCard(redCard, redState);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      destroyed = true;
      onLayoutChange = null;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      engine.dispose();
      engineRef.current = null;
      delete PLAYER_COLORS[BLUE_ID];
      delete PLAYER_COLORS[RED_ID];
    };
  }, [lowQuality]);

  useEffect(() => { engineRef.current?.setPaused(paused); }, [paused, lowQuality]);

  return (
    <div ref={containerRef} className="cc-scr-hero" aria-hidden="true">
      <div ref={canvasHostRef} className="cc-scr-hero-canvas" />
      <HeroCard card={cards.blue} cardRef={blueCardRef} />
      <HeroCard card={cards.red} cardRef={redCardRef} />
    </div>
  );
}
