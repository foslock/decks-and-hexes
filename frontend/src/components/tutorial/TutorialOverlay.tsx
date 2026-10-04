import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Card, ResolutionStep } from '../../types/game';
import GameBoard, {
  type BoardControls, type BoardFx, type ClaimChevron, type GridTransform, type PlannedActionIcon, type VpPath,
} from '../GameBoard';
import ResolveOverlay from '../ResolveOverlay';
import CardFull from '../CardFull';
import CardBack from '../CardBack';
import FlightCard, { turnOver, type Flight } from '../hand/FlightCard';
import TargetArrow from '../hand/TargetArrow';
import CardPile from '../hand/CardPile';
import { TileCardStack, CardDetailOverlay, boardCardScale, type BoardCardEntry } from '../BoardCards';
import { CARD_H, CARD_W, flightKeyframes, poseTransform, runAnimation, type Pose } from '../hand/cardMotion';
import { PLAYER_COLORS } from '../../board3d/boardTypes';
import type { CameraShot } from '../../board3d/engine';
import { axialToPixel } from '../../utils/hexGeometry';
import { useAnimationSpeed } from '../SettingsContext';
import { useSound } from '../../audio/useSound';
import Icon from '../../icons/Icon';
import { SCENES, type Anchor, type TutorialCtx } from './tutorialScenes';
import {
  PLAYER_INFO, RIVAL, TUTORIAL_COLORS, VP_TARGET, YOU,
  connectedVp, parseKey, pathToBase, scoreVp, type World,
} from './tutorialWorld';

/**
 * How to Play: a guided tour of a game on a real 3D board. Each scene flies
 * the camera somewhere new and plays a short scripted moment with the game's
 * own pieces — cards dealt and played from a hand, face-down plays, the
 * reveal, the resolve animation (claims, clashes, defense, walls, a base
 * raid) — while a narration panel explains it. Next / Back jump between
 * scenes; every scene starts from its own fixed state.
 */

interface Props {
  onClose: () => void;
  /** "Play a game" on the last scene (create a lobby). */
  onPlay?: () => void;
  /** Open the full written rules. */
  onRules?: () => void;
  /** Something is open on top (the rules): ignore the keyboard. */
  covered?: boolean;
}

const CANCELLED = Symbol('tutorial-cancelled');

/** One scene's script run; cancelling rejects everything it's waiting on. */
class Run {
  cancelled = false;
  private hooks = new Set<() => void>();
  cancel() {
    this.cancelled = true;
    for (const h of this.hooks) h();
    this.hooks.clear();
  }
  guard<T>(p: Promise<T>): Promise<T> {
    if (this.cancelled) return Promise.reject(CANCELLED);
    return new Promise<T>((resolve, reject) => {
      const hook = () => reject(CANCELLED);
      this.hooks.add(hook);
      p.then(
        v => { this.hooks.delete(hook); if (this.cancelled) reject(CANCELLED); else resolve(v); },
        e => { this.hooks.delete(hook); reject(e); },
      );
    });
  }
}

// ── Layout ──────────────────────────────────────────────────────────────

interface Layout {
  w: number;
  h: number;
  mobile: boolean;
  panelW: number;
  panelH: number;
  panelTop: number;
  handScale: number;
  /** Bottom edge of the hand's cards (they tuck behind the panel). */
  handBottom: number;
  /** Bottom band the board keeps its framing clear of. */
  inset: number;
  pileZoom: number;
}

function layoutFor(w: number, h: number): Layout {
  const mobile = w < 640;
  const panelH = mobile ? 236 : 206;
  const panelBottom = mobile ? 10 : 18;
  const panelTop = h - panelBottom - panelH;
  const handScale = mobile ? 0.3 : h < 760 ? 0.4 : 0.46;
  const cardH = CARD_H * handScale;
  return {
    w, h, mobile,
    panelW: Math.min(700, w - (mobile ? 20 : 32)),
    panelH,
    panelTop,
    handScale,
    handBottom: panelTop + cardH * 0.3,
    // Frame the board over the panel; the hand can overlap its lower edge.
    inset: h - panelTop + cardH * 0.35,
    pileZoom: mobile ? 0.55 : 0.78,
  };
}

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

/** The hand's fan: card i of n (the lifted one rises and grows). */
function handPoses(n: number, L: Layout, lifted = -1): Pose[] {
  const s = L.handScale;
  const cw = CARD_W * s;
  const span = Math.min(L.w - (L.mobile ? 110 : 300), 540);
  const step = n > 1 ? Math.min(cw * 0.88, (span - cw) / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => {
    const o = i - (n - 1) / 2;
    const up = i === lifted;
    return {
      x: L.w / 2 + o * step,
      y: L.handBottom - (CARD_H * s) / 2 + o * o * 2.4 - (up ? CARD_H * s * 0.24 : 0),
      rot: up ? 0 : o * 4,
      scale: s * (up ? 1.12 : 1),
    };
  });
}

const pileX = (L: Layout, side: -1 | 1) => L.w / 2 + side * (L.mobile ? L.w / 2 - 34 : Math.min(L.panelW / 2 - 46, 310));

// ── Little pieces ───────────────────────────────────────────────────────

const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

function HudChip({ hud, icon, color, label, value, dim }: {
  hud: string; icon?: 'action' | 'resource'; color?: string; label?: string; value: React.ReactNode; dim?: boolean;
}) {
  return (
    <span className={`cc-tut-chip${dim ? ' is-dim' : ''}`} data-tut-hud={hud}>
      {color && <span className="cc-tut-chip-dot" style={{ background: color, color }} />}
      {icon && <Icon name={icon} size={13} decorative />}
      {label && <span className="cc-tut-chip-label">{label}</span>}
      <b key={String(value)} className="cc-tut-chip-value">{value}</b>
    </span>
  );
}

interface Pop { id: number; text: string; x: number; y: number; tone: string; down: boolean }
interface StarFlight { key: string; from: { x: number; y: number }; to: { x: number; y: number }; duration: number }

function StarMote({ f, onDone }: { f: StarFlight; onDone: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dx = f.to.x - f.from.x, dy = f.to.y - f.from.y;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lift = 90 * 4 * t * (1 - t);
      frames.push({
        offset: t,
        transform: `translate(${f.from.x + dx * e}px, ${f.from.y + dy * e - lift}px) translate(-50%, -50%) scale(${1 + Math.sin(Math.PI * t) * 0.6})`,
        opacity: t > 0.9 ? 1 - (t - 0.9) * 10 : 1,
      });
    }
    let live = true;
    void runAnimation(ref.current, frames, { duration: f.duration, easing: 'linear', fill: 'both' }).then(() => { if (live) onDone(f.key); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref} className="cc-tut-star"><Icon name="vp" size={26} decorative /></div>;
}

// ── The overlay ─────────────────────────────────────────────────────────

export default function TutorialOverlay({ onClose, onPlay, onRules, covered = false }: Props) {
  const speed = useAnimationSpeed();
  const pace = speed === 0 ? 0 : Math.max(0.65, speed);
  const vp = useViewport();
  const L = useMemo(() => layoutFor(vp.w, vp.h), [vp.w, vp.h]);

  // The tutorial's two players get fixed colors while it's open.
  useState(() => { Object.assign(PLAYER_COLORS, TUTORIAL_COLORS); return null; });
  useEffect(() => {
    Object.assign(PLAYER_COLORS, TUTORIAL_COLORS);
    return () => { delete PLAYER_COLORS[YOU]; delete PLAYER_COLORS[RIVAL]; };
  }, []);

  const [index, setIndex] = useState(0);
  const scene = SCENES[index];
  const [world, setWorld] = useState<World>(() => SCENES[0].start());
  const worldRef = useRef(world);
  const [done, setDone] = useState(false);
  const [build, setBuild] = useState(pace > 0 ? 0 : 1);
  const [flights, setFlights] = useState<Flight<'tut'>[]>([]);
  const [stars, setStars] = useState<StarFlight[]>([]);
  const [arrow, setArrow] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const [banner, setBanner] = useState<{ key: number; text: string; sub?: string; big?: boolean } | null>(null);
  const [pops, setPops] = useState<Pop[]>([]);
  const [resolving, setResolving] = useState<{ key: number; steps: ResolutionStep[] } | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [arriving, setArriving] = useState<Set<string>>(() => new Set());
  const [peek, setPeek] = useState<Card | null>(null);
  const [detail, setDetail] = useState<BoardCardEntry[] | null>(null);
  /** Rival cards lying face down on tiles until the reveal. */
  const [facedown, setFacedown] = useState<Record<string, { entry: BoardCardEntry; from: string }[]>>({});
  const facedownRef = useRef(facedown);

  const controlsRef = useRef<BoardControls | null>(null);
  const fxRef = useRef<BoardFx | null>(null);
  const transformRef = useRef<GridTransform | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef(L);
  layoutRef.current = L;
  const paceRef = useRef(pace);
  paceRef.current = pace;
  const sound = useSound();
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const landings = useRef(new Map<string, () => void>());
  const resolveHooks = useRef<{ apply(i: number): void; start(i: number): void; end(i: number): void; complete(): void } | null>(null);
  const seq = useRef(0);

  // The island rises out of the sea once, on open.
  useEffect(() => {
    if (pace === 0) { setBuild(1); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 1900);
      setBuild(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Script context ──
  const makeCtx = useCallback((run: Run): TutorialCtx => {
    const wait = (ms: number) => run.guard(new Promise<void>(r => setTimeout(r, ms * paceRef.current)));
    const sfx = (name: keyof typeof soundRef.current) => { if (!run.cancelled) soundRef.current[name](); };
    const get = () => worldRef.current;
    const set = (patch: Partial<World> | ((w: World) => Partial<World>)) => {
      if (run.cancelled) return;
      const cur = worldRef.current;
      const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
      worldRef.current = next;
      setWorld(next);
    };
    const setDown = (fn: (d: typeof facedownRef.current) => typeof facedownRef.current) => {
      if (run.cancelled) return;
      facedownRef.current = fn(facedownRef.current);
      setFacedown(facedownRef.current);
    };

    const tileCenter = (key: string) => {
      const t = transformRef.current;
      const rect = boardWrapRef.current?.getBoundingClientRect();
      if (!t?.project || !rect) return null;
      const [q, r] = parseKey(key);
      const p = axialToPixel(q, r);
      const s = t.project(p.x, p.y, 0.2);
      return { x: s.x + rect.left, y: s.y + rect.top };
    };
    const center = (sel: string) => {
      const el = rootRef.current?.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const point = (a: Anchor) => {
      if ('tile' in a) return tileCenter(a.tile);
      if ('hud' in a) return center(`[data-tut-hud="${a.hud}"]`);
      if ('pile' in a) return center(`[data-tut-pile="${a.pile}"]`);
      return center(`[data-tut-shop-card="${a.shop}"]`);
    };
    /** Pose of a card standing in a tile's card row (slot i of n). */
    const tileSlot = (key: string, i = 0, n = 1): Pose | null => {
      const a = controlsRef.current?.tileAnchor(key);
      if (!a) return null;
      const s = boardCardScale(a.zoom);
      const w = CARD_W * s;
      const total = n * w + (n - 1) * 8;
      return { x: a.x - total / 2 + w / 2 + i * (w + 8), y: a.below ? a.y + (CARD_H * s) / 2 : a.y - (CARD_H * s) / 2, rot: 0, scale: s };
    };

    const fly = (card: Card | null, from: Pose, to: Pose, opts: { duration?: number; arc?: number; flip?: boolean } = {}) => {
      if (paceRef.current === 0) return Promise.resolve();
      const key = `f${++seq.current}`;
      const flight: Flight<'tut'> = {
        key, kind: 'tut', card,
        frames: flightKeyframes(from, to, { arc: opts.arc ?? 60 }),
        delay: 0,
        duration: (opts.duration ?? 560) * paceRef.current,
        flipFrames: opts.flip ? turnOver(false, 0.1, 0.6) : undefined,
      };
      const landed = new Promise<void>(res => landings.current.set(key, res));
      setFlights(fs => [...fs, flight]);
      return run.guard(landed);
    };

    const pop = (text: string, at: Anchor, tone: 'gold' | 'blue' | 'green' | 'red' = 'gold') => {
      if (run.cancelled) return;
      const p = point(at);
      if (!p) return;
      const id = ++seq.current;
      // Off a HUD chip, the number drops below it (there's no room above).
      const down = 'hud' in at;
      setPops(ps => [...ps, { id, text, x: p.x, y: down ? p.y + 22 : p.y, tone, down }]);
      setTimeout(() => setPops(ps => ps.filter(x => x.id !== id)), 1600);
    };

    const banner = async (text: string, sub?: string, opts: { hold?: number; stay?: boolean; big?: boolean } = {}) => {
      if (run.cancelled) return;
      setBanner({ key: ++seq.current, text, sub, big: opts.big });
      if (opts.stay) return;
      await wait(opts.hold ?? 1050);
      setBanner(null);
    };

    /** A resolved tile's cards head home: yours to your discard pile, the
     *  rival's off toward their name. */
    const sendHome = (tile: string) => {
      const entries = worldRef.current.cards[tile] ?? [];
      const starts = entries.map(e => {
        const el = rootRef.current?.querySelector(`[data-board-card="${e.key}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, rot: 0, scale: r.width / CARD_W } as Pose;
      });
      set(w => {
        const cards = { ...w.cards };
        delete cards[tile];
        return { cards };
      });
      if (entries.length) sfx('cardDiscard');
      entries.forEach((e, i) => {
        const from = starts[i];
        const mine = e.playerId === YOU;
        const dest = point(mine ? { pile: 'discard' } : { hud: 'rivalVp' });
        if (!from || !dest) {
          if (mine) set(w => ({ discard: [...w.discard, e.card] }));
          return;
        }
        const to: Pose = { x: dest.x, y: dest.y, rot: mine ? 6 : 0, scale: mine ? 0.26 * layoutRef.current.pileZoom : 0.08, opacity: mine ? 1 : 0 };
        fly(e.card, from, to, { duration: 620, arc: 70 })
          .then(() => { if (mine) set(w => ({ discard: [...w.discard, e.card] })); })
          .catch(() => {});
      });
    };

    return {
      wait,
      get,
      set,
      fx: () => fxRef.current,
      sfx,
      pop,
      banner,

      fly: async (shot: CameraShot) => {
        const seconds = paceRef.current === 0 ? 0.01 : (shot.seconds ?? 1.6) * Math.max(0.75, paceRef.current);
        controlsRef.current?.flyTo({ ...shot, seconds });
        await run.guard(new Promise<void>(r => setTimeout(r, seconds * 1000)));
      },

      deal: async (cards) => {
        const before = worldRef.current.hand.length;
        set(w => ({ hand: [...w.hand, ...cards], drawCount: Math.max(0, w.drawCount - cards.length) }));
        if (paceRef.current === 0) return;
        setArriving(new Set(cards.map(c => c.id)));
        const L2 = layoutRef.current;
        const poses = handPoses(before + cards.length, L2);
        const src = point({ pile: 'draw' }) ?? { x: pileX(L2, -1), y: L2.panelTop - 30 };
        await Promise.all(cards.map((c, j) => wait(j * 150)
          .then(() => sfx('cardDraw'))
          .then(() => fly(c, { x: src.x, y: src.y, rot: -6, scale: 0.26 * L2.pileZoom }, poses[before + j], { duration: 560, arc: 70, flip: true }))
          .then(() => setArriving(a => { const n = new Set(a); n.delete(c.id); return n; }))));
      },

      play: async (cardId, tile, opts = {}) => {
        const hand = worldRef.current.hand;
        const i = hand.findIndex(c => c.id === cardId);
        if (i < 0) return;
        const card = hand[i];
        setLifted(cardId);
        await wait(420);
        const from = handPoses(hand.length, layoutRef.current, i)[i];
        if (tile && paceRef.current > 0) {
          const to = tileCenter(tile);
          if (to) {
            sfx('tileSelect');
            setArrow({ from: { x: from.x, y: from.y - (CARD_H * from.scale) / 2 + 8 }, to });
            await wait(800);
            setArrow(null);
          }
        }
        // Into play: out of the hand, its actions spent.
        sfx('cardPlay');
        set(w => ({ hand: w.hand.filter(c => c.id !== cardId), actions: w.actions - card.action_cost }));
        setLifted(null);
        if (opts.pay) {
          sfx('coinSpend');
          set(w => ({ resources: w.resources - opts.pay! }));
          pop(`-${opts.pay}`, { hud: 'resources' }, 'red');
        }
        if (tile) {
          const down = facedownRef.current[tile]?.length ?? 0;
          const mine = worldRef.current.cards[tile]?.length ?? 0;
          const to = tileSlot(tile, mine, mine + 1 + down) ?? { ...from, opacity: 0 };
          await fly(card, from, to, { duration: 580, arc: 80 });
          const [tq, tr] = parseKey(tile);
          const p = axialToPixel(tq, tr);
          fxRef.current?.dust(p.x, p.y, 10, 0.5);
          const type = opts.temp || opts.perm ? 'defense' : 'claim';
          set(w => ({
            cards: { ...w.cards, [tile]: [...(w.cards[tile] ?? []), { key: `${card.id}@${tile}`, card, playerId: YOU, playerName: 'You' }] },
            planned: { ...w.planned, [tile]: { card, power: card.power, type, temp: opts.temp, perm: opts.perm } },
            chevrons: opts.from ? [...w.chevrons, { from: opts.from, to: tile, pid: YOU }] : w.chevrons,
          }));
        } else {
          // An engine card does its thing at once, then goes to the discard pile.
          const dest = point({ pile: 'discard' });
          const to: Pose = dest
            ? { x: dest.x, y: dest.y, rot: 6, scale: 0.26 * layoutRef.current.pileZoom }
            : { ...from, opacity: 0 };
          await fly(card, from, { ...to, y: to.y }, { duration: 620, arc: 120 });
          set(w => ({ discard: [...w.discard, card] }));
        }
        if (card.resource_gain) {
          sfx('coinSpend');
          set(w => ({ resources: w.resources + card.resource_gain }));
          pop(`+${card.resource_gain}`, { hud: 'resources' }, 'green');
        }
        if (card.action_return) {
          set(w => ({ actions: w.actions + card.action_return }));
          pop(`+${card.action_return} action`, { hud: 'actions' }, 'blue');
        }
        await wait(280);
      },

      rivalPlay: async (card, tile, from) => {
        const src = tileCenter(from);
        const mine = worldRef.current.cards[tile]?.length ?? 0;
        const down = facedownRef.current[tile]?.length ?? 0;
        const to = tileSlot(tile, mine + down, mine + down + 1);
        sfx('cardPlay');
        if (src && to) await fly(null, { x: src.x, y: src.y, rot: 0, scale: to.scale * 0.5 }, to, { duration: 640, arc: 70 });
        setDown(d => ({ ...d, [tile]: [...(d[tile] ?? []), { entry: { key: `${card.id}@${tile}`, card, playerId: RIVAL, playerName: 'Rival' }, from }] }));
      },

      reveal: async () => {
        set({ phase: 'Reveal' });
        sfx('phaseChange');
        await banner('Reveal');
        const down = facedownRef.current;
        setDown(() => ({}));
        set(w => {
          const cards = { ...w.cards };
          const chevrons = [...w.chevrons];
          for (const [k, list] of Object.entries(down)) {
            cards[k] = [...(cards[k] ?? []), ...list.map(x => ({ ...x.entry, revealed: true }))];
            for (const x of list) chevrons.push({ from: x.from, to: k, pid: RIVAL });
          }
          return { cards, chevrons };
        });
        await wait(Object.keys(down).length ? 1100 : 300);
      },

      resolve: (steps) => {
        set({ planned: {}, chevrons: [] });
        const lastFor = new Map<string, number>();
        steps.forEach((s, i) => lastFor.set(s.tile_key, i));
        const finished = new Promise<void>(res => {
          resolveHooks.current = {
            apply: (i) => {
              const step = steps[i];
              set(w => {
                const t = w.tiles[step.tile_key];
                if (!t) return {};
                if ((step.outcome === 'claimed' || step.outcome === 'auto_claim') && step.winner_id && !t.is_base) {
                  return { tiles: { ...w.tiles, [step.tile_key]: { ...t, owner: step.winner_id, held_since_turn: w.round } } };
                }
                if (step.outcome === 'defense_applied') {
                  const perm = step.defense_permanent ?? 0;
                  const temp = step.defense_temporary ?? 0;
                  return { tiles: { ...w.tiles, [step.tile_key]: { ...t, permanent_defense_bonus: Math.max(0, perm - t.base_defense), defense_power: perm + temp } } };
                }
                return {};
              });
            },
            start: (i) => set({ focus: steps[i].tile_key }),
            end: (i) => {
              set({ focus: null });
              if (lastFor.get(steps[i].tile_key) === i) sendHome(steps[i].tile_key);
            },
            complete: () => { resolveHooks.current = null; setResolving(null); res(); },
          };
          setResolving({ key: ++seq.current, steps });
        });
        return run.guard(finished);
      },

      flyCard: async (card, fromA, toA, opts = {}) => {
        const a = point(fromA), b = point(toA);
        if (!a || !b) return;
        await fly(card,
          { x: a.x, y: a.y, rot: 0, scale: opts.fromScale ?? 0.3 },
          { x: b.x, y: b.y, rot: 0, scale: opts.toScale ?? 0.3, opacity: 0.2 },
          { duration: opts.duration ?? 700, arc: opts.arc ?? 80 });
      },

      flyStar: async (fromA, toA) => {
        const a = point(fromA), b = point(toA);
        if (!a || !b || paceRef.current === 0) return;
        const key = `s${++seq.current}`;
        const landed = new Promise<void>(res => landings.current.set(key, res));
        setStars(s => [...s, { key, from: a, to: b, duration: 900 * paceRef.current }]);
        await run.guard(landed);
        sfx('vpGain');
      },
    };
  }, []);

  // ── Scene runner ──
  useEffect(() => {
    const run = new Run();
    setFlights([]);
    setStars([]);
    setArrow(null);
    setBanner(null);
    setPops([]);
    setResolving(null);
    setLifted(null);
    setArriving(new Set());
    setPeek(null);
    setDetail(null);
    facedownRef.current = {};
    setFacedown({});
    landings.current.clear();
    resolveHooks.current = null;
    const start = SCENES[index].start();
    worldRef.current = start;
    setWorld(start);
    setDone(false);
    const ctx = makeCtx(run);
    const timer = setTimeout(() => {
      SCENES[index].run(ctx)
        .then(() => { if (!run.cancelled) setDone(true); })
        .catch((e) => { if (e !== CANCELLED) { console.error(e); setDone(true); } });
    }, 60);
    return () => { run.cancel(); clearTimeout(timer); };
  }, [index, makeCtx]);

  const last = index === SCENES.length - 1;
  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(SCENES.length - 1, i))), []);
  const next = useCallback(() => setIndex(i => Math.min(SCENES.length - 1, i + 1)), []);
  const back = useCallback(() => setIndex(i => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (detail || covered) return;
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, next, back, detail, covered]);

  // ── Derived board props ──
  const connected = useMemo(() => connectedVp(world.tiles), [world.tiles]);
  const highlight = useMemo(() => new Set(world.highlight), [world.highlight]);
  const pulse = useMemo(() => new Set(world.pulse), [world.pulse]);
  const planned = useMemo(() => {
    const m = new Map<string, PlannedActionIcon>();
    for (const [k, p] of Object.entries(world.planned)) {
      m.set(k, {
        type: p.type, power: p.power, name: p.card.name, card: p.card,
        allCards: [{ card: p.card, effectivePower: p.power }],
        permanentDefPower: p.perm ?? 0, tempDefPower: p.temp ?? 0,
      });
    }
    return m;
  }, [world.planned]);
  const chevrons = useMemo<ClaimChevron[]>(() => world.chevrons.map(c => {
    const [tq, tr] = parseKey(c.to), [sq, sr] = parseKey(c.from);
    return { targetQ: tq, targetR: tr, sourceQ: sq, sourceR: sr, color: PLAYER_COLORS[c.pid] ?? 0xffffff, alpha: 1 };
  }), [world.chevrons]);
  const paths = useMemo<VpPath[]>(() => world.paths.flatMap(k => {
    const owner = world.tiles[k]?.owner;
    const points = owner ? pathToBase(world.tiles, owner, k) : null;
    return points ? [{ points, color: PLAYER_COLORS[owner!] ?? 0xffffff, alpha: 1, playerId: owner! }] : [];
  }), [world.paths, world.tiles]);
  const tileKeys = useMemo(
    () => [...new Set([...Object.keys(world.cards), ...Object.keys(facedown)])],
    [world.cards, facedown],
  );
  const renderTileCards = useCallback((key: string, zoom: number) => {
    const s = boardCardScale(zoom);
    const entries = world.cards[key] ?? [];
    const down = facedown[key] ?? [];
    return (
      <div className="cc-tut-tilecards">
        {entries.length > 0 && (
          <TileCardStack entries={entries} scale={s} focus={world.focus === key} open onOpen={(es) => setDetail(es)} />
        )}
        {down.map(d => (
          <div key={d.entry.key} className="cc-tut-facedown" style={{ width: CARD_W * s, height: CARD_H * s, borderRadius: 14 * s }}>
            <div style={{ transform: `scale(${s})`, transformOrigin: 'top left' }}><CardBack /></div>
          </div>
        ))}
      </div>
    );
  }, [world.cards, world.focus, facedown]);

  const youVp = scoreVp(world.tiles, YOU, world.bonusVp).total;
  const rivalVp = scoreVp(world.tiles, RIVAL).total;
  const poses = handPoses(world.hand.length, L, world.hand.findIndex(c => c.id === lifted));
  const onFlightDone = useCallback((f: Flight<'tut'>) => {
    landings.current.get(f.key)?.();
    landings.current.delete(f.key);
    setFlights(fs => fs.filter(x => x.key !== f.key));
  }, []);
  const onStarDone = useCallback((key: string) => {
    landings.current.get(key)?.();
    landings.current.delete(key);
    setStars(s => s.filter(x => x.key !== key));
  }, []);
  const viewMid = (L.h - L.inset) / 2;

  return (
    <div ref={rootRef} className="cc-tut" role="dialog" aria-modal="true" aria-label="How to play">
      <div ref={boardWrapRef} className="cc-tut-board">
        <GameBoard
          tiles={world.tiles}
          onTileClick={() => {}}
          playerInfo={PLAYER_INFO}
          activePlayerId={YOU}
          connectedVpTiles={connected}
          highlightTiles={highlight}
          reviewPulseTiles={pulse}
          plannedActions={planned}
          claimChevrons={chevrons}
          vpPaths={paths}
          tileCardKeys={tileKeys}
          renderTileCards={renderTileCards}
          raisedTileKey={world.focus}
          transformRef={transformRef}
          fxRef={fxRef}
          controlsRef={controlsRef}
          viewInsetBottom={L.inset}
          buildProgress={build}
        />
      </div>
      <div className="cc-tut-vignette" aria-hidden />

      {/* Top: title, score and the turn's resources */}
      <div className="cc-tut-top">
        <div className="cc-tut-brand">
          <span className="cc-tut-brand-title">How to Play</span>
        </div>
        <div className="cc-tut-hud">
          <HudChip hud="vp" color={css(TUTORIAL_COLORS[YOU])} label="You" value={`${youVp} VP`} />
          <HudChip hud="rivalVp" color={css(TUTORIAL_COLORS[RIVAL])} label="Rival" value={`${rivalVp} VP`} />
          <span className="cc-tut-target">Target {VP_TARGET}</span>
          {world.showHand && (
            <>
              <HudChip hud="actions" icon="action" label={L.mobile ? undefined : 'Actions'} value={world.actions} />
              <HudChip hud="resources" icon="resource" label={L.mobile ? undefined : 'Resources'} value={world.resources} />
            </>
          )}
          {world.phase && !L.mobile && (
            <span key={world.phase} className="cc-tut-phase">{world.phase}</span>
          )}
        </div>
        <button type="button" className="cc-tut-skip" onClick={onClose}>
          {last ? 'Close' : 'Skip'}
          <Icon name="close" size={11} decorative />
        </button>
      </div>

      {/* Piles */}
      {world.showHand && (
        <>
          <div className="cc-tut-pile" data-tut-pile="draw" style={{ left: pileX(L, -1), top: L.panelTop + 4 }}>
            <CardPile kind="draw" count={world.drawCount} label="Draw pile" zoom={L.pileZoom} />
          </div>
          <div className="cc-tut-pile" data-tut-pile="discard" style={{ left: pileX(L, 1), top: L.panelTop + 4 }}>
            <CardPile kind="discard" count={world.discard.length} cards={world.discard} label="Discard pile" zoom={L.pileZoom} />
          </div>
        </>
      )}

      {/* Hand */}
      {world.showHand && world.hand.map((c, i) => (
        <div
          key={c.id}
          className={`cc-tut-handcard${lifted === c.id ? ' is-lifted' : ''}`}
          style={{
            transform: poseTransform(poses[i]),
            opacity: arriving.has(c.id) ? 0 : 1,
            zIndex: lifted === c.id ? 30 : 10 + i,
          }}
          onPointerEnter={() => setPeek(c)}
          onPointerLeave={() => setPeek(p => (p?.id === c.id ? null : p))}
        >
          <CardFull card={c} artZoom={false} />
        </div>
      ))}
      {peek && !lifted && !L.mobile && world.hand.some(c => c.id === peek.id) && (
        <div className="cc-tut-peek" style={{ left: L.w / 2, top: L.panelTop - CARD_H * L.handScale * 0.75 - 12 }}>
          <CardFull card={peek} artZoom={false} />
        </div>
      )}

      {/* Market (buy scene) */}
      {world.shop && (
        <div className="cc-tut-shop-wrap" style={{ top: viewMid }}>
          <div className="cc-ov-modal cc-tut-shop">
            <div className="cc-tut-shop-head">
              <span className="cc-tut-shop-title">Market</span>
              <span className="cc-tut-shop-res"><Icon name="resource" size={13} decorative /> {world.resources} resources</span>
            </div>
            <div className="cc-tut-shop-row">
              {world.shop.cards.map(c => {
                const bought = world.shop!.bought.includes(c.id);
                const hot = world.shop!.hot === c.id;
                const s = L.mobile ? 0.34 : 0.48;
                return (
                  <div key={c.id} className={`cc-tut-shop-card${hot ? ' is-hot' : ''}${bought ? ' is-bought' : ''}`}>
                    <div data-tut-shop-card={c.id} style={{ width: CARD_W * s, height: CARD_H * s }}>
                      <div style={{ transform: `scale(${s})`, transformOrigin: 'top left' }}><CardFull card={c} artZoom={false} /></div>
                    </div>
                    <span className="cc-tut-price"><Icon name="resource" size={11} decorative /> {c.buy_cost}</span>
                    {bought && <span className="cc-tut-bought">Bought</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Narration */}
      <div className="cc-ov-modal cc-tut-panel" style={{ width: L.panelW, height: L.panelH, top: L.panelTop }}>
        <div className="cc-tut-panel-head">
          <span className="cc-tut-eyebrow">{scene.eyebrow}</span>
          <span className="cc-tut-count">{index + 1} / {SCENES.length}</span>
        </div>
        <div key={scene.id} className="cc-tut-copy">
          <h2 className="cc-tut-title">{scene.title}</h2>
          <p className="cc-tut-body">{scene.body}</p>
          {scene.tip && !L.mobile && <p className="cc-tut-tip"><Icon name="passive" size={11} decorative /> {scene.tip}</p>}
        </div>
        <div className="cc-tut-foot">
          <div className="cc-tut-dots" role="tablist" aria-label="Steps" hidden={last && L.mobile}>
            {SCENES.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`Step ${i + 1}: ${s.title}`}
                className={`cc-tut-dot${i === index ? ' is-active' : i < index ? ' is-past' : ''}`}
                onClick={() => go(i)}
              />
            ))}
          </div>
          <div className="cc-tut-nav">
            {index > 0 && <button type="button" className="cc-btn-secondary cc-tut-btn" onClick={back}>Back</button>}
            {last ? (
              <>
                {onRules && <button type="button" className="cc-btn-secondary cc-tut-btn" onClick={onRules}>{L.mobile ? 'Rules' : 'Full rules'}</button>}
                <button type="button" className="cc-btn-primary cc-tut-btn is-ready" onClick={onPlay ?? onClose}>Play a game</button>
              </>
            ) : (
              <button type="button" className={`cc-btn-primary cc-tut-btn cc-tut-next${done ? ' is-ready' : ''}`} onClick={next}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Effects layer */}
      {banner && (
        <div key={banner.key} className={`cc-tut-banner${banner.big ? ' is-big' : ''}`} style={{ top: viewMid }}>
          <span className="cc-tut-banner-text">{banner.text}</span>
          {banner.sub && <span className="cc-tut-banner-sub">{banner.sub}</span>}
        </div>
      )}
      {pops.map(p => (
        <div key={p.id} className={`cc-tut-pop is-${p.tone}${p.down ? ' is-down' : ''}`} style={{ left: p.x, top: p.y }}>{p.text}</div>
      ))}
      {flights.map(f => <FlightCard key={f.key} flight={f} onDone={onFlightDone} />)}
      {stars.map(f => <StarMote key={f.key} f={f} onDone={onStarDone} />)}
      {arrow && <TargetArrow from={arrow.from} to={arrow.to} state="valid" />}

      {resolving && (
        <ResolveOverlay
          key={resolving.key}
          steps={resolving.steps}
          gridTransform={transformRef.current}
          gridRect={boardWrapRef.current?.getBoundingClientRect() ?? null}
          gridContainerRef={boardWrapRef}
          gridTransformRef={transformRef}
          fxRef={fxRef}
          onStepApply={(i) => resolveHooks.current?.apply(i)}
          onStepStart={(i) => resolveHooks.current?.start(i)}
          onStepEnd={(i) => resolveHooks.current?.end(i)}
          onComplete={() => resolveHooks.current?.complete()}
        />
      )}
      {detail && (
        <CardDetailOverlay
          entries={detail.map(e => ({ card: e.card, playerId: e.playerId, playerName: e.playerName }))}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
