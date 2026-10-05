import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AttackPlan, Beat, PlanCard, TilePlan } from '../utils/resolvePlan';
import { PLAYER_COLORS, type BoardFx, type FxFortifyRing } from '../board3d/boardTypes';
import type { CameraView } from '../board3d/engine';
import type { BoardControls } from './GameBoard';
import { axialToPixel } from '../utils/hexGeometry';
import { TEMP_DEF } from './BoardLabel';
import { BOARD_FLIP_ID, BOARD_FLIP_MS } from './BoardCards';
import { useResolveSpeed } from './SettingsContext';
import { useSound } from '../audio/useSound';
import Icon from '../icons/Icon';
import { Num } from '../icons/Num';

/** What the resolve asks of the game screen as it goes. */
export interface ResolverApi {
  /** Close in on a tile ('pass': only part way, for a tile that doesn't
   *  involve the player between two that do); null: back to the player's
   *  own view. Resolves on arrival. */
  focus(tileKey: string | null, shot?: CloseUp): Promise<void>;
  /** The tile now resolving: its cards come forward, its label steps aside
   *  and its claim arrows fade. */
  setActive(plan: TilePlan | null): void;
  /** These face-down cards leave their pile and line up (to turn over). */
  spread(keys: string[]): void;
  /** Turn these board cards face up. */
  flip(keys: string[]): void;
  /** These cards are done: off to their owners. */
  sendHome(keys: string[]): void;
  /** Apply a resolution step to the board (ownership, defense, VP). */
  applyStep(index: number): void;
}

interface Props {
  plans: TilePlan[];
  /** Resolve speed multiplier (1 normal, smaller = faster). */
  speed: number;
  fxRef: React.RefObject<BoardFx | null>;
  /** Screen point (client px) over a tile's center, or null. */
  project(q: number, r: number): { x: number; y: number } | null;
  api: ResolverApi;
  onComplete(): void;
}

/** How near the camera closes in on a resolving tile than the player's own
 *  view (capped at the board's maximum zoom): all the way for a tile that
 *  involves the player, part way for one passed on the way between two. */
const CLOSE_UP_ZOOM = { close: 1.8, pass: 1.3 } as const;
const CLOSE_UP_TILT = { close: 0.16, pass: 0.08 } as const;
export type CloseUp = keyof typeof CLOSE_UP_ZOOM;

/**
 * The resolve's camera: close in on a tile — nearer by CLOSE_UP_ZOOM, tipped down
 * a little, the tile low enough that its cards float in view above it —
 * remembering the player's own framing; or (null) glide back to it. Tile to
 * tile, the camera eases back a touch mid-flight rather than sliding flat.
 * Returns how long the move takes (ms).
 */
export function resolveCamera(
  controls: BoardControls | null,
  saved: { current: CameraView | null },
  key: string | null,
  speed: number,
  shot: CloseUp = 'close',
): number {
  const seconds = 0.7 * (speed || 1);
  if (key) {
    const hopping = !!saved.current;
    if (!saved.current) saved.current = controls?.getView() ?? null;
    const base = saved.current;
    if (controls && base) {
      controls.focusTile(key, {
        zoom: base.zoom * CLOSE_UP_ZOOM[shot], tilt: base.tilt + CLOSE_UP_TILT[shot],
        lower: 0.45, seconds, arc: hopping ? 0.12 : 0,
      });
    }
  } else {
    if (controls && saved.current) controls.setView(saved.current, seconds);
    saved.current = null;
  }
  return seconds * 1000;
}

/** How hard a claim hits, 0 (power 0) to 1 (power 8 and up). */
const MAX_HEFT = 8;
const heft = (power: number) => Math.max(0, Math.min(MAX_HEFT, power)) / MAX_HEFT;

type DefenseView =
  | { mode: 'defense'; perm: number; temp: number; immune: boolean; holder: string | null }
  /** A claim's number holding the tile for now (dashed: it can still be
   *  overtaken or tied); null player: claims tied at this value. Settled once
   *  the tile is decided. */
  | { mode: 'held'; value: number; playerId: string | null; settled?: boolean };

interface ClaimView { playerId: string; value: number; dx: number; dy: number }
interface Shard { id: number; dx: number; dy: number; rot: number; color: string }

const CANCELLED = Symbol('cancelled');
/** How far from the defense the claim number floats in (px). */
const CLAIM_R = 74;
/** How long a counted card stays on the tile before it leaves (ms). */
const LINGER_MS = 450;

const css = (n: number | undefined, fallback = '#ffffff') => (n != null ? `#${n.toString(16).padStart(6, '0')}` : fallback);
const colorOf = (pid: string | null) => (pid ? css(PLAYER_COLORS[pid]) : '#e8e4d8');
/** Light enough to read on the dark badge. */
function readable(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lift = (v: number) => Math.round(v + (255 - v) * 0.3);
  return `rgb(${lift((n >> 16) & 255)}, ${lift((n >> 8) & 255)}, ${lift(n & 255)})`;
}

/** Run one animation on a badge, replacing whatever it was doing (a held
 *  end state from an earlier move would otherwise snap back once this ends). */
function animate(el: Element | null, frames: Keyframe[], ms: number, easing = 'ease-out', fill: FillMode = 'none'): Promise<void> {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return Promise.resolve();
  for (const a of el.getAnimations()) a.cancel();
  if (ms <= 0) return Promise.resolve();
  return (el as HTMLElement).animate(frames, { duration: ms, easing, fill }).finished.then(() => undefined, () => undefined);
}

/**
 * The reveal, tile by tile (see utils/resolvePlan): the camera closes in on
 * tiles that involve the player, the defense builds up card by card, then
 * each attacker — weakest first — counts up their cards' power and smashes
 * into whatever holds the tile, breaking it or bouncing off. Tiles that
 * don't involve the player resolve quickly at the player's own view.
 */
export default function TileResolver({ plans, speed, fxRef, project, api, onComplete }: Props) {
  const sound = useSound();
  /** Board cards turn over at the resolve speed from the settings. */
  const flipSpeed = useResolveSpeed();
  const [tile, setTile] = useState<{ q: number; r: number } | null>(null);
  const [defense, setDefense] = useState<DefenseView | null>(null);
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [shards, setShards] = useState<Shard[]>([]);
  const anchorRef = useRef<HTMLDivElement>(null);
  const defRef = useRef<HTMLDivElement>(null);
  const claimRef = useRef<HTMLDivElement>(null);
  const live = useRef({ project, api, onComplete, sound, speed, flipSpeed });
  live.current = { project, api, onComplete, sound, speed, flipSpeed };

  // Keep the badges over the tile while the camera moves.
  useLayoutEffect(() => {
    if (!tile) return;
    let raf = 0;
    const place = () => {
      const p = live.current.project(tile.q, tile.r);
      if (p && anchorRef.current) anchorRef.current.style.transform = `translate(${p.x}px, ${p.y}px)`;
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [tile]);

  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const ms = (n: number) => Math.round(n * (live.current.speed || 1));
    const wait = (n: number) => new Promise<void>((res, rej) => {
      if (cancelled) { rej(CANCELLED); return; }
      setTimeout(() => (cancelled ? rej(CANCELLED) : res()), ms(n));
    });
    const guard = <T,>(p: Promise<T>) => p.then(v => { if (cancelled) throw CANCELLED; return v; });
    /** A counted card lingers over the tile a moment (time to read it) while
     *  the next one steps up, then heads home. */
    const leaveSoon = (card: PlanCard | null) => {
      if (!card) return;
      setTimeout(() => { if (!cancelled) live.current.api.sendHome([card.key]); }, ms(LINGER_MS));
    };
    const { api } = live.current;
    const fx = () => fxRef.current;
    const sfx = live.current.sound;

    const pulse = (el: Element | null, color?: string) => animate(el, [
      { transform: 'scale(1)', filter: 'brightness(1)' },
      { transform: 'scale(1.32)', filter: `brightness(1.6) drop-shadow(0 0 10px ${color ?? '#fff'})`, offset: 0.35 },
      { transform: 'scale(1)', filter: 'brightness(1)' },
    ], ms(300), 'ease-out');

    const burst = (color: string, count = 7, reach = 1) => {
      const id0 = ++seq * 100;
      setShards(s => [...s, ...Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
        const d = (34 + Math.random() * 26) * reach;
        return { id: id0 + i, dx: Math.cos(a) * d, dy: Math.sin(a) * d - 10, rot: (Math.random() - 0.5) * 220, color };
      })]);
      setTimeout(() => setShards(s => s.filter(x => x.id < id0 || x.id >= id0 + count)), ms(700));
    };

    /** A card steps up to count: a face-down one turns over; a face-up one
     *  waits the same beat, so every card keeps the same rhythm. */
    const reveal = async (cards: (PlanCard | null)[]) => {
      const real = cards.filter((c): c is PlanCard => !!c);
      if (!real.length) return;
      // As long as a board card takes to turn over (plus a frame for it to start).
      const beat = Math.round(BOARD_FLIP_MS * (live.current.flipSpeed || 1)) + 50;
      api.flip(real.map(c => c.key));
      // The power counts once the card is fully face up: wait for its
      // turn-over to finish (it starts once the board has the new state).
      const start = performance.now();
      const pause = (n: number) => new Promise<void>((res, rej) => setTimeout(() => (cancelled ? rej(CANCELLED) : res()), Math.max(0, n)));
      const down = real.filter(c => c.faceDown);
      let turns: Animation[] = [];
      for (let i = 0; down.length && !turns.length && i < 15; i++) {
        await pause(16);
        turns = down.flatMap(c => boardCard(c.key)?.querySelector('[data-board-card-body]')?.getAnimations().filter(a => a.id === BOARD_FLIP_ID) ?? []);
      }
      if (turns.length) {
        await Promise.race([Promise.all(turns.map(a => a.finished.catch(() => undefined))), pause(beat + 400)]);
        if (cancelled) throw CANCELLED;
      } else {
        await pause(beat - (performance.now() - start));
      }
    };
    /** A player's face-down cards wait in a pile: before they turn over,
     *  the pile spreads out into a row (a lone card has nothing to spread). */
    const spreadDone = new Set<string>();
    const spreadOut = async (cards: (PlanCard | null)[]) => {
      const down = cards.filter((c): c is PlanCard => !!c && !!c.faceDown && !spreadDone.has(c.key));
      if (!down.length) return;
      for (const c of down) spreadDone.add(c.key);
      api.spread(down.map(c => c.key));
      const byPlayer = new Map<string, number>();
      for (const c of down) byPlayer.set(c.playerId, (byPlayer.get(c.playerId) ?? 0) + 1);
      if (![...byPlayer.values()].some(n => n > 1)) return;
      sfx.cardPlay();
      // The row eases out over SIZE_EASE (0.25 s), then a breath.
      await new Promise<void>((res, rej) => setTimeout(() => (cancelled ? rej(CANCELLED) : res()), Math.max(ms(420), 320)));
    };
    const boardCard = (key: string) => document.querySelector(`[data-board-card="${CSS.escape(key)}"]`) as HTMLElement | null;
    /** The card counting toward a total glows gold while it counts (fading
     *  in as it turns over, out as it lingers). */
    const counting = (card: PlanCard | null, on: boolean) => {
      const el = card ? boardCard(card.key) : null;
      if (!el) return;
      if (on) el.dataset.counting = '';
      else delete el.dataset.counting;
    };
    /** The card gives a small pulse as its power goes in — the card face
     *  only, inside its player ring, so the ring's glow stays steady. */
    const bump = (card: PlanCard | null) => {
      if (!card) return;
      boardCard(card.key)?.querySelector<HTMLElement>('[data-board-card-face]')?.animate?.([
        { transform: 'scale(1)', filter: 'brightness(1)' },
        { transform: 'scale(1.04)', filter: 'brightness(1.25)', offset: 0.4 },
        { transform: 'scale(1)', filter: 'brightness(1)' },
      ], { duration: ms(240), easing: 'ease-out' });
    };

    /** The direction (screen unit vector) an attack comes in from. */
    /** Where an attack comes from: its spot beside the tile (a screen unit
     *  vector, kept out from under the floating cards) and, if on record,
     *  the screen offset of the claimer's closest tile. */
    const approach = (plan: TilePlan, a: AttackPlan): { dx: number; dy: number; from: { x: number; y: number } | null } => {
      const at = live.current.project(plan.q, plan.r);
      const src = a.sourceQ != null && a.sourceR != null ? live.current.project(a.sourceQ, a.sourceR) : null;
      let dx = -1, dy = 0;
      let from: { x: number; y: number } | null = null;
      if (at && src && (Math.abs(src.x - at.x) + Math.abs(src.y - at.y)) > 1) {
        const len = Math.hypot(src.x - at.x, src.y - at.y);
        dx = (src.x - at.x) / len;
        dy = (src.y - at.y) / len;
        // A far-off (or off-screen) tile: come in from the screen's edge.
        const reach = Math.min(len, 520);
        from = { x: dx * reach, y: dy * reach };
      }
      // Cards float above the tile: keep the number out from under them.
      if (dy < -0.35) {
        dy = -0.35;
        const len = Math.hypot(dx, dy) || 1;
        dx = (Math.abs(dx) < 0.05 ? -1 : dx) / len; dy /= len;
      }
      return { dx, dy, from };
    };

    const holderView = (plan: TilePlan, perm = plan.perm, temp = plan.temp): DefenseView =>
      ({ mode: 'defense', perm, temp, immune: plan.immune, holder: plan.holder });

    /** One attacker's claim: count it up, then smash into what holds the tile.
     *  `last`: no claim comes after it (a tie then hands the tile back). */
    const attack = async (plan: TilePlan, a: AttackPlan, countUp: boolean, ring: FxFortifyRing | null, holder: string | null, last: boolean) => {
      const { from, ...dir } = approach(plan, a);
      const color = colorOf(a.playerId);
      // Commit now so the badge's first frame is its entrance's first frame.
      flushSync(() => setClaim({ playerId: a.playerId, value: countUp ? 0 : a.total, ...dir }));
      if (from) {
        // It sets out from the claimer's closest tile and flies in beside this one.
        const sx = from.x - dir.dx * CLAIM_R, sy = from.y - dir.dy * CLAIM_R;
        await animate(claimRef.current, [
          { transform: `translate(${sx}px, ${sy}px) scale(0.55)`, opacity: 0 },
          { transform: `translate(${sx * 0.88}px, ${sy * 0.88}px) scale(0.7)`, opacity: 1, offset: 0.15 },
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        ], ms(520), 'cubic-bezier(0.3, 0.7, 0.35, 1)');
      } else {
        await animate(claimRef.current, [
          { transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 },
        ], ms(220), 'cubic-bezier(0.34, 1.56, 0.64, 1)');
      }
      if (countUp) {
        let value = 0;
        await spreadOut(a.beats.map(b => b.card));
        for (const b of a.beats) {
          counting(b.card, true);
          await reveal([b.card]);
          value += b.add;
          flushSync(() => setClaim(c => (c ? { ...c, value } : c)));
          sfx.hoverTick();
          bump(b.card);
          await guard(pulse(claimRef.current, color));
          counting(b.card, false);
          leaveSoon(b.card);
          await wait(110);
        }
      } else {
        await wait(260);
      }

      // The smash — the bigger the claim, the harder it hits (0 → 8+).
      const k = heft(a.total);
      const dist = CLAIM_R;
      const hit = { x: -dir.dx * dist * 0.72, y: -dir.dy * dist * 0.72 };
      const hitScale = 1.15 + 0.35 * k;
      const back = 10 + 24 * k;
      const wind = { x: dir.dx * back, y: dir.dy * back - 6 - 8 * k };
      // A heavy claim trembles at the top of its wind-up before it drops.
      const tremble = k > 0.4
        ? [0.5, 0.6, 0.7].map((offset, i) => ({
          transform: `translate(${wind.x + (i % 2 ? -1 : 1) * 3 * k}px, ${wind.y + (i % 2 ? 1 : -1) * 2 * k}px) scale(${1.1 + 0.3 * k})`, offset,
        }))
        : [];
      await animate(claimRef.current, [
        { transform: 'translate(0, 0) scale(1)' },
        { transform: `translate(${wind.x}px, ${wind.y}px) scale(${1.1 + 0.3 * k})`, offset: tremble.length ? 0.4 : 0.35 },
        ...tremble,
        { transform: `translate(${hit.x}px, ${hit.y}px) scale(${hitScale})` },
      ], ms(240 + 200 * k), 'cubic-bezier(0.5, 0, 0.9, 0.6)', 'forwards');
      const c = axialToPixel(plan.q, plan.r);
      const f = fx();
      const pc = PLAYER_COLORS[a.playerId] ?? 0xffffff;
      f?.sparks(c.x, c.y, pc, Math.round((a.clash === 'bounce' ? 10 + 16 * k : 16 + 44 * k)), 0.8 + 0.9 * k);
      if (k >= 0.5) {
        f?.shockwave(c.x, c.y, pc, 0.7 + 0.9 * k, ms(420 + 200 * k));
        f?.dust(c.x, c.y, Math.round(10 + 22 * k), 0.6 + 0.8 * k);
      }
      ring?.flash((a.clash === 'bounce' ? 1.2 : 0.8) * (0.8 + 0.5 * k));
      sfx.claimSmash(a.total);
      if (plan.baseRaid) sfx.resolveBaseRaidRam();
      // Hit-stop: a heavy blow holds the moment of impact.
      if (k > 0.25) await wait(Math.round(90 * k));

      if (a.clash === 'break' || a.clash === 'stalemate') {
        f?.shake((plan.baseRaid ? 0.6 : 0.2) + 0.9 * k, ms(260 + 240 * k));
        burst(colorOf(holder), 6 + Math.round(10 * k), 1 + 0.9 * k);
        animate(defRef.current, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: `scale(${1.6 + 0.9 * k})` }], ms(160), 'ease-out', 'forwards');
        if (plan.baseRaid && a.clash === 'break') { ring?.shatter(); sfx.resolveBaseRaidShatter(); }
        // A tie with the claim in the lead: neither takes it — both shatter.
        if (a.clash === 'stalemate') {
          burst(color, 6 + Math.round(10 * k), 1 + 0.9 * k);
          animate(claimRef.current, [
            { transform: `translate(${hit.x}px, ${hit.y}px) scale(${hitScale})`, opacity: 1 },
            { transform: `translate(${hit.x}px, ${hit.y}px) scale(${1.6 + 0.9 * k})`, opacity: 0 },
          ], ms(160), 'ease-out', 'forwards');
        }
        await wait(140);
        if (a.clash === 'stalemate') {
          // A beat with nothing holding the tile.
          await wait(160);
          // The tile stays as it was (its owner's, or neutral) — unless a claim
          // still to come has to beat the tied value first.
          flushSync(() => {
            setClaim(null);
            setDefense(last ? holderView(plan) : { mode: 'held', value: a.total, playerId: null });
          });
          await animate(defRef.current, [
            { transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 },
          ], ms(260), 'cubic-bezier(0.34, 1.56, 0.64, 1)');
        } else {
          // The claim takes the tile: its number now holds it.
          await animate(claimRef.current, [
            { transform: `translate(${hit.x}px, ${hit.y}px) scale(${hitScale})` },
            { transform: `translate(${-dir.dx * dist}px, ${-dir.dy * dist}px) scale(1.25)` },
          ], ms(160), 'ease-out', 'forwards');
          flushSync(() => {
            setClaim(null);
            setDefense({ mode: 'held', value: a.total, playerId: a.playerId });
          });
          // The holder's badge picks up exactly where the claim's left off —
          // same size, fully opaque — and settles with a glow.
          await animate(defRef.current, [
            { transform: 'scale(1.25)', opacity: 1, filter: 'brightness(1.5)' },
            { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
          ], ms(260), 'cubic-bezier(0.34, 1.56, 0.64, 1)');
        }
      } else {
        // Bounces off: the defense holds.
        f?.jolt(plan.q, plan.r, (plan.baseRaid ? 0.7 : 0.35) + 0.6 * k);
        if (k > 0.4) f?.shake(0.35 * k, ms(220));
        if (plan.baseRaid) sfx.resolveBaseRaidHold(); else sfx.resolveDefenseFortify();
        pulse(defRef.current, '#bfe4ff');
        // A big claim is thrown back further and spins harder.
        const fly = 1 + 0.8 * k, spin = (dir.dx > 0 ? 1 : -1) * (1 + 1.2 * k);
        await animate(claimRef.current, [
          { transform: `translate(${hit.x}px, ${hit.y}px) scale(${hitScale})`, opacity: 1 },
          { transform: `translate(${dir.dx * 30 * fly}px, ${dir.dy * 30 * fly - 18 * fly}px) scale(0.9) rotate(${18 * spin}deg)`, opacity: 0.9, offset: 0.55 },
          { transform: `translate(${dir.dx * 56 * fly}px, ${dir.dy * 56 * fly + 8}px) scale(0.7) rotate(${34 * spin}deg)`, opacity: 0 },
        ], ms(420 + 120 * k), 'ease-out', 'forwards');
        setClaim(null);
      }
      await wait(160);
    };


    const settle = async (plan: TilePlan) => {
      const f = fx();
      const c = axialToPixel(plan.q, plan.r);
      const win = plan.winner;
      if (plan.mainStep != null) api.applyStep(plan.mainStep);
      if (plan.captured && win) {
        const color = PLAYER_COLORS[win] ?? 0xffffff;
        if (!plan.baseRaid) f?.captureBurst(plan.q, plan.r, color, true);
        sfx.resolveTileOccupied();
        // The leading claim has it: its number turns solid.
        flushSync(() => setDefense(d => (d?.mode === 'held' ? { ...d, settled: true } : d)));
        pulse(defRef.current, colorOf(win));
      } else if (plan.attacks.length) {
        f?.shockwave(c.x, c.y, plan.holder ? (PLAYER_COLORS[plan.holder] ?? 0xffffff) : 0xd8e4ff, 1.0, ms(520));
      }
      const stalemate = plan.attacks.some(a => a.clash === 'stalemate') && !plan.captured;
      await wait(stalemate ? 560 : 420);
      await animate(anchorRef.current?.firstElementChild ?? null, [{ opacity: 1 }, { opacity: 0 }], ms(220), 'ease-in', 'forwards');
    };

    const keysOf = (plan: TilePlan) => [
      ...plan.defenseBeats.flatMap(b => (b.card ? [b.card] : [])),
      ...plan.attacks.flatMap(a => a.beats.flatMap(b => (b.card ? [b.card] : []))),
      ...plan.fizzles, ...plan.others,
    ];

    const buildDefense = async (plan: TilePlan, countUp: boolean) => {
      let perm = plan.startPerm, temp = plan.startTemp;
      flushSync(() => setDefense({ mode: 'defense', perm, temp, immune: false, holder: plan.holder }));
      await animate(defRef.current, [
        { transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 },
      ], ms(220), 'cubic-bezier(0.34, 1.56, 0.64, 1)');
      if (countUp) {
        await spreadOut(plan.defenseBeats.map(b => b.card));
        for (const b of plan.defenseBeats as Beat[]) {
          counting(b.card, true);
          await reveal([b.card]);
          if (b.add) {
            if (b.temp) temp += b.add; else perm += b.add;
            flushSync(() => setDefense({ mode: 'defense', perm, temp, immune: false, holder: plan.holder }));
            sfx.hoverTick();
            bump(b.card);
            await guard(pulse(defRef.current, b.temp ? TEMP_DEF : '#fff'));
          }
          counting(b.card, false);
          leaveSoon(b.card);
          await wait(110);
        }
      }
      // What the attackers face (immunity, or siege stripping bonuses).
      if (perm !== plan.perm || temp !== plan.temp || plan.immune) {
        flushSync(() => setDefense(holderView(plan)));
        await guard(pulse(defRef.current, plan.immune ? TEMP_DEF : '#fff'));
      }
      if (plan.immune) sfx.resolveDefenseFortify();
      for (const idx of plan.defenseSteps) api.applyStep(idx);
      if (!countUp) api.sendHome(plan.defenseBeats.flatMap(b => (b.card ? [b.card.key] : [])));
    };

    const resolveTile = async (plan: TilePlan, full: boolean) => {
      api.setActive(plan);
      setTile({ q: plan.q, r: plan.r });

      if (plan.kind === 'effect') {
        const f = fx();
        const c = axialToPixel(plan.q, plan.r);
        if (plan.outcome === 'consecrate') { f?.pillar(c.x, c.y, 0xffd24a, ms(900)); sfx.vpGain(); }
        if (plan.mainStep != null) api.applyStep(plan.mainStep);
        if (plan.outcome === 'auto_claim' && plan.winner) {
          f?.captureBurst(plan.q, plan.r, PLAYER_COLORS[plan.winner] ?? 0xffffff, false);
          sfx.resolveTileOccupied();
        }
        await spreadOut(plan.others);
        api.flip(plan.others.map(c => c.key));
        await wait(650);
        api.sendHome(plan.others.map(c => c.key));
        return;
      }

      let ring: FxFortifyRing | null = null;
      if (plan.baseRaid && plan.attacks.length) {
        ring = fx()?.createFortifyRing(plan.q, plan.r) ?? null;
        sfx.resolveBaseRaidFortify();
        const t0 = performance.now(), dur = ms(650);
        const rise = () => {
          const t = Math.min(1, (performance.now() - t0) / Math.max(1, dur));
          ring?.setProgress(t);
          if (t < 1 && !cancelled) requestAnimationFrame(rise);
        };
        requestAnimationFrame(rise);
      }
      try {
        if (!full) {
          await spreadOut(keysOf(plan));
          await reveal(keysOf(plan));
        }
        await buildDefense(plan, full);

        // Claims that had no say (an immune tile) turn over and go.
        if (plan.fizzles.length) {
          await spreadOut(plan.fizzles);
          await reveal(plan.fizzles);
          await wait(260);
          api.sendHome(plan.fizzles.map(c => c.key));
        }

        if (full) {
          // Whoever holds the tile as each claim lands (its shards' color).
          let holder = plan.holder;
          for (const [i, a] of plan.attacks.entries()) {
            await attack(plan, a, true, ring, holder, i === plan.attacks.length - 1);
            if (a.clash === 'break') holder = a.playerId;
            if (a.clash === 'stalemate') holder = null;
          }
        } else if (plan.attacks.length) {
          // Quick: only the claim that decides it.
          const decisive = [...plan.attacks].reverse().find(a => a.clash !== 'bounce') ?? plan.attacks[plan.attacks.length - 1];
          const shown: AttackPlan = decisive.clash === 'bounce' ? decisive : { ...decisive, clash: plan.captured ? 'break' : decisive.clash };
          await attack(plan, shown, false, ring, plan.holder, true);
          api.sendHome(plan.attacks.flatMap(a => a.beats.flatMap(b => (b.card ? [b.card.key] : []))));
        }
        await settle(plan);
      } finally {
        if (ring) {
          const r = ring;
          setTimeout(() => r.destroy(), ms(900));
        }
      }
      api.sendHome(plan.others.map(c => c.key));
    };

    (async () => {
      let zoomed = false;
      const isClose = (p: TilePlan) => p.focus && p.kind !== 'effect';
      // Stay in close until the last tile that involves the player: tiles
      // between are passed part way out, not with a full pull-back.
      let lastClose = -1;
      plans.forEach((p, i) => { if (isClose(p)) lastClose = i; });
      try {
        for (const [i, plan] of plans.entries()) {
          const close = isClose(plan);
          if (close) {
            await guard(api.focus(plan.tileKey, 'close'));
            zoomed = true;
          } else if (zoomed && i < lastClose && plan.kind !== 'effect') {
            await guard(api.focus(plan.tileKey, 'pass'));
          } else if (zoomed) {
            await guard(api.focus(null));
            zoomed = false;
          }
          await resolveTile(plan, close);
          setDefense(null);
          setClaim(null);
          setTile(null);
          api.setActive(null);
        }
        if (zoomed) await guard(api.focus(null));
        if (!cancelled) live.current.onComplete();
      } catch (e) {
        if (e !== CANCELLED) {
          console.error(e);
          live.current.onComplete();
        }
      }
    })();
    return () => { cancelled = true; };
  // The plan runs once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tile) return null;
  return (
    <div ref={anchorRef} className="cc-rs-anchor" aria-hidden>
      <div className="cc-rs-layer">
        {defense && (
          <div className="cc-rs-slot">
            <div ref={defRef} className={`cc-rs-badge is-defense${defense.mode === 'held' && !defense.settled ? ' is-leading' : ''}`} style={{
              ['--ring' as string]: defense.mode === 'held' ? colorOf(defense.playerId) : defense.holder ? colorOf(defense.holder) : 'rgba(232, 228, 216, 0.75)',
            }}>
              {defense.mode === 'defense' ? (
                defense.immune ? (
                  <><Icon name="immune" size={20} color={TEMP_DEF} decorative /><span className="cc-rs-word" style={{ color: TEMP_DEF }}>Immune</span></>
                ) : (
                  <>
                    <Icon name={defense.perm > 0 || defense.temp === 0 ? 'fortify' : 'defense'} size={20} color={defense.perm > 0 || defense.temp === 0 ? readable(colorOf(defense.holder)) : TEMP_DEF} decorative />
                    {(defense.perm > 0 || defense.temp === 0) && <Num value={defense.perm} size={21} color={readable(colorOf(defense.holder))} />}
                    {defense.temp > 0 && <Num value={`+${defense.temp}`} size={21} color={TEMP_DEF} />}
                  </>
                )
              ) : (
                <>
                  <Icon name="power" size={20} color={readable(colorOf(defense.playerId))} decorative />
                  <Num value={defense.value} size={21} color={readable(colorOf(defense.playerId))} />
                </>
              )}
            </div>
          </div>
        )}
        {claim && (
          <div className="cc-rs-slot" style={{ left: claim.dx * CLAIM_R, top: claim.dy * CLAIM_R }}>
            <div ref={claimRef} className="cc-rs-badge is-claim" style={{ ['--ring' as string]: colorOf(claim.playerId) }}>
              <Icon name="power" size={20} color={readable(colorOf(claim.playerId))} decorative />
              <Num value={claim.value} size={21} color={readable(colorOf(claim.playerId))} />
            </div>
          </div>
        )}
        {shards.map(s => (
          <div key={s.id} className="cc-rs-shard" style={{
            background: s.color,
            color: s.color,
            ['--dx' as string]: `${s.dx}px`, ['--dy' as string]: `${s.dy}px`, ['--rot' as string]: `${s.rot}deg`,
            animationDuration: `${Math.round(620 * (speed || 1))}ms`,
          }} />
        ))}
      </div>
    </div>
  );
}
