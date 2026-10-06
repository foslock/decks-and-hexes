import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AttackPlan, Beat, PlanCard, TilePlan } from '../utils/resolvePlan';
import { PLAYER_COLORS, type BoardFx, type FxFortifyRing } from '../board3d/boardTypes';
import type { CameraView } from '../board3d/engine';
import type { BoardControls } from './GameBoard';
import { axialToPixel } from '../utils/hexGeometry';
import { BOARD_FLIP_ID, BOARD_FLIP_MS } from './BoardCards';
import { useResolveSpeed } from './SettingsContext';
import { useSound } from '../audio/useSound';
import Icon from '../icons/Icon';
import type { IconName } from '../icons/glyphs';
import { Num } from '../icons/Num';
import type { Card, ResolutionEffect } from '../types/game';

export interface ScreenPoint { x: number; y: number }

/** What the resolve asks of the game screen as it goes. */
export interface ResolverApi {
  /** Close in on a tile ('pass': only part way, for a tile that doesn't
   *  involve the player between two that do); null with 'overview': the
   *  whole board; null alone: back to the player's own view. Resolves on
   *  arrival. */
  focus(tileKey: string | null, shot?: Shot): Promise<void>;
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
  /** A player's bank changes by `amount` at `at` (a screen point): a gain
   *  flies in from there as coins, a loss flies out of their bank to it. */
  bank(playerId: string, amount: number, at: ScreenPoint): void;
  /** A player's score goes up by `amount` VP from a card effect: it flies
   *  from `at` to their VP. */
  vp(playerId: string, amount: number, at: ScreenPoint): void;
  /** `count` copies of `card` join a player's deck (Debt, Land Grant,
   *  Spoils…): they fly from `at` to the player, each worth `vpEach` VP
   *  as it lands. */
  giveCard(playerId: string, card: Card, count: number, at: ScreenPoint, vpEach: number): void;
  /** These board cards are trashed: they burn where they are. */
  burn(keys: string[]): void;
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
  /** Zoom out to the whole board first (default). A single tile's replay
   *  goes straight to its close-up. */
  overview?: boolean;
}

/** How near the camera closes in on a resolving tile than the whole-board
 *  view (capped at the board's maximum zoom): all the way for a tile that
 *  involves the player, part way for one passed on the way between two. */
const CLOSE_UP_ZOOM = { close: 1.8, pass: 1.3 } as const;
const CLOSE_UP_TILT = { close: 0.16, pass: 0.08 } as const;
export type CloseUp = keyof typeof CLOSE_UP_ZOOM;
/** A resolve camera move: a close-up, or the whole board. */
export type Shot = CloseUp | 'overview';

/** Two framings close enough to skip a camera move between them. */
function sameView(a: CameraView, b: CameraView): boolean {
  return Math.abs(a.zoom - b.zoom) < 0.02 && Math.abs(a.tilt - b.tilt) < 0.01
    && Math.abs(a.rotation - b.rotation) < 0.01 && Math.hypot(a.panX - b.panX, a.panZ - b.panZ) < 0.05;
}

/**
 * The resolve's camera, remembering the player's own framing on its first
 * move:
 *  - a tile: close in on it — nearer by CLOSE_UP_ZOOM, tipped down a little,
 *    the tile low enough that its cards float in view above it (tile to
 *    tile, it eases back a touch mid-flight rather than sliding flat);
 *  - 'overview' (no tile): the whole board in the player's orientation, so
 *    nothing resolving between other players happens off screen;
 *  - null: glide back to the player's own view.
 * Returns how long the move takes (ms); 0 when the camera is already there.
 */
export function resolveCamera(
  controls: BoardControls | null,
  saved: { current: CameraView | null },
  key: string | null,
  speed: number,
  shot: Shot = 'close',
): number {
  const seconds = 0.7 * (speed || 1);
  // The player's framing is what the camera was headed for; whether a move
  // is needed goes by where it actually is (it may still be on its way).
  const now = controls?.getView() ?? null;
  const at = controls?.getView(true) ?? null;
  if (key || shot === 'overview') {
    if (!saved.current) saved.current = now;
    const base = saved.current;
    if (!controls || !base) return 0;
    if (!key || shot === 'overview') {
      const overview: CameraView = { ...base, zoom: 1, panX: 0, panZ: 0 };
      if (at && sameView(at, overview)) {
        controls.setView(overview, seconds);
        return 0;
      }
      controls.setView(overview, seconds);
      return seconds * 1000;
    }
    controls.focusTile(key, {
      zoom: CLOSE_UP_ZOOM[shot], tilt: base.tilt + CLOSE_UP_TILT[shot],
      lower: 0.45, seconds, arc: at && at.zoom > 1.2 ? 0.12 : 0,
    });
    return seconds * 1000;
  }
  const home = saved.current;
  saved.current = null;
  if (!controls || !home) return 0;
  if (at && sameView(at, home)) {
    controls.setView(home, seconds);
    return 0;
  }
  controls.setView(home, seconds);
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

/** A claim's badge: `value` stays null (just the claim glyph) until the
 *  first card counts — then it shows its power, even a 0. */
interface ClaimView { playerId: string; value: number | null; dx: number; dy: number }
interface Shard { id: number; dx: number; dy: number; rot: number; color: string }
/** A word or number that pops up over the tile and drifts away: a claim's
 *  bonus ("+2 Ambush") or what a card effect did ("+8", "−1", "+1 Debt"). */
interface Chip {
  id: number; x: number; y: number;
  text: string; icon?: IconName; caption?: string;
  color: string; tone: 'gain' | 'loss' | 'bonus' | 'name';
}

const CANCELLED = Symbol('cancelled');
/** How far from the defense the claim number floats in (px). */
const CLAIM_R = 74;
/** How long a counted card stays on the tile before it leaves (ms). */
const LINGER_MS = 450;
/** How long a tile's card row takes to close up after a card leaves it
 *  (SIZE_EASE, plus a frame or two for the board to catch up) (ms). */
const ROW_SETTLE_MS = 320;

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
export default function TileResolver({ plans, speed, fxRef, project, api, onComplete, overview = true }: Props) {
  const sound = useSound();
  /** Board cards turn over at the resolve speed from the settings. */
  const flipSpeed = useResolveSpeed();
  /** The tile resolving now (`run` counts tiles, so each gets a fresh layer). */
  const [tile, setTile] = useState<{ q: number; r: number; run: number } | null>(null);
  const [defense, setDefense] = useState<DefenseView | null>(null);
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [shards, setShards] = useState<Shard[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
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
      if (!card || burning.has(card.key)) return;
      setTimeout(() => { if (!cancelled) api.sendHome([card.key]); }, ms(LINGER_MS));
    };
    /** Cards that burn on this tile (Spoils of War) stay put until they do. */
    let burning = new Set<string>();
    /** A card turns over where it lies: the row closes up (over SIZE_EASE)
     *  when a card leaves it, so a card leaving waits for a turn-over to end,
     *  and a card about to turn over waits for the row to settle. */
    let flipUntil = 0;
    let rowSettles = 0;
    const { api: rawApi } = live.current;
    const sendHome = (keys: string[]) => {
      const leaving = keys.filter(k => !burning.has(k));
      if (!leaving.length) return;
      const hold = flipUntil - performance.now();
      if (hold > 0) {
        setTimeout(() => { if (!cancelled) sendHome(leaving); }, hold);
        return;
      }
      rawApi.sendHome(leaving);
      rowSettles = performance.now() + ROW_SETTLE_MS;
    };
    const api: ResolverApi = { ...rawApi, sendHome };
    const fx = () => fxRef.current;
    const sfx = live.current.sound;

    /** A badge's pulse as a number goes in (a card bumps in time with it). */
    const PULSE_MS = 300, PULSE_PEAK = 0.35;
    const pulse = (el: Element | null, color?: string) => animate(el, [
      { transform: 'scale(1)', filter: 'brightness(1)' },
      { transform: 'scale(1.32)', filter: `brightness(1.6) drop-shadow(0 0 10px ${color ?? '#fff'})`, offset: PULSE_PEAK },
      { transform: 'scale(1)', filter: 'brightness(1)' },
    ], ms(PULSE_MS), 'ease-out');

    const burst = (color: string, count = 7, reach = 1) => {
      const id0 = ++seq * 100;
      setShards(s => [...s, ...Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
        const d = (34 + Math.random() * 26) * reach;
        return { id: id0 + i, dx: Math.cos(a) * d, dy: Math.sin(a) * d - 10, rot: (Math.random() - 0.5) * 220, color };
      })]);
      setTimeout(() => setShards(s => s.filter(x => x.id < id0 || x.id >= id0 + count)), ms(700));
    };

    /** Pop a chip up over the tile (offset in px from its middle); it drifts
     *  up and fades on its own. */
    const chip = (c: Omit<Chip, 'id'>) => {
      const id = ++seq * 100 + 99;
      setChips(cs => [...cs, { ...c, id }]);
      setTimeout(() => setChips(cs => cs.filter(x => x.id !== id)), ms(1700));
    };

    /** A card steps up to count: a face-down one turns over; a face-up one
     *  waits the same beat, so every card keeps the same rhythm. */
    const reveal = async (cards: (PlanCard | null)[]) => {
      const real = cards.filter((c): c is PlanCard => !!c);
      if (!real.length) return;
      const down = real.filter(c => c.faceDown);
      // As long as a board card takes to turn over (plus a frame for it to
      // start); a face-up card holds the same beat at the resolve's pace.
      const beat = (down.length ? Math.round(BOARD_FLIP_MS * (live.current.flipSpeed || 1)) : ms(BOARD_FLIP_MS)) + 50;
      const pause = (n: number) => new Promise<void>((res, rej) => setTimeout(() => (cancelled ? rej(CANCELLED) : res()), Math.max(0, n)));
      if (down.length) {
        const settling = rowSettles - performance.now();
        if (settling > 0) await pause(settling);
        flipUntil = performance.now() + beat + 100;
      }
      api.flip(real.map(c => c.key));
      // The power counts once the card is fully face up: wait for its
      // turn-over to finish (it starts once the board has the new state).
      const start = performance.now();
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
      flipUntil = 0;
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
    /** The card gives a small pulse as its power goes in, with the badge's
     *  — the card face only, inside its player ring, so the ring's glow
     *  stays steady. */
    const bump = (card: PlanCard | null) => {
      if (!card) return;
      boardCard(card.key)?.querySelector<HTMLElement>('[data-board-card-face]')?.animate?.([
        { transform: 'scale(1)', filter: 'brightness(1)' },
        { transform: 'scale(1.04)', filter: 'brightness(1.25)', offset: PULSE_PEAK },
        { transform: 'scale(1)', filter: 'brightness(1)' },
      ], { duration: ms(PULSE_MS), easing: 'ease-out' });
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
    /** Whether this tile's defense badge has shown. A defense of 0 stays
     *  hidden — unless it showed more and was lowered (then the 0 shows). */
    let defShown = false;
    /** What holds the tile when no claim does: its owner's defense, or
     *  nothing to show (a plain 0). */
    const ownerView = (plan: TilePlan): DefenseView | null =>
      (plan.immune || plan.perm + plan.temp > 0 || defShown ? holderView(plan) : null);
    /** The defense badge pops in. */
    const popDefense = async (view: DefenseView) => {
      flushSync(() => setDefense(view));
      defShown = true;
      await animate(defRef.current, [
        { transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 },
      ], ms(220), 'cubic-bezier(0.34, 1.56, 0.64, 1)');
    };

    /** One attacker's claim: count it up, then smash into what holds the tile.
     *  `last`: no claim comes after it (a tie then hands the tile back). */
    const attack = async (plan: TilePlan, a: AttackPlan, countUp: boolean, ring: FxFortifyRing | null, holder: string | null, last: boolean) => {
      const { from, ...dir } = approach(plan, a);
      const color = colorOf(a.playerId);
      // Commit now so the badge's first frame is its entrance's first frame.
      flushSync(() => setClaim({ playerId: a.playerId, value: countUp && a.beats.length ? null : a.total, ...dir }));
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
        for (const [i, b] of a.beats.entries()) {
          const more = a.beats.slice(i + 1).some(n => n.card === b.card && n.label);
          counting(b.card, true);
          if (!b.label) await reveal([b.card]);
          value += b.add;
          flushSync(() => setClaim(c => (c ? { ...c, value } : c)));
          if (b.label) {
            // A bonus the card gets at the reveal: named, in gold, as it adds.
            chip({
              x: dir.dx * CLAIM_R, y: dir.dy * CLAIM_R - 40 - (i % 2) * 6,
              text: `${b.add > 0 ? '+' : '−'}${Math.abs(b.add)}`, caption: b.label, icon: 'power',
              color: '#ffd24a', tone: 'bonus',
            });
            sfx.powerBonus();
            bump(b.card);
            await guard(pulse(claimRef.current, '#ffd24a'));
            await wait(260);
          } else {
            sfx.hoverTick();
            bump(b.card);
            await guard(pulse(claimRef.current, color));
          }
          // A card with a bonus still to come stays to show it.
          if (!more) {
            counting(b.card, false);
            leaveSoon(b.card);
          }
          await wait(110);
        }
      } else {
        await wait(260);
      }

      // A claim that bounces needs something to bounce off: an unseen 0
      // defense (a 0-power claim tying the owner) shows itself first.
      if ((a.clash === 'bounce' || a.clash === 'dink') && !defRef.current) await popDefense(holderView(plan));
      const hadDefense = !!defRef.current;
      // Nothing defends the tile (an empty tile, no defense to show): no
      // smash — the claim glides to the middle, unopposed, and holds it.
      if (!hadDefense && a.clash === 'break') {
        await animate(claimRef.current, [
          { transform: 'translate(0, 0) scale(1)' },
          { transform: `translate(${-dir.dx * CLAIM_R}px, ${-dir.dy * CLAIM_R}px) scale(1.08)` },
        ], ms(480), 'cubic-bezier(0.45, 0, 0.25, 1)', 'forwards');
        flushSync(() => {
          setClaim(null);
          setDefense({ mode: 'held', value: a.total, playerId: a.playerId });
        });
        await animate(defRef.current, [
          { transform: 'scale(1.08)', filter: 'brightness(1.35)' },
          { transform: 'scale(1)', filter: 'brightness(1)' },
        ], ms(260), 'ease-out');
        await wait(160);
        return;
      }

      // The smash — the bigger the claim, the harder it hits (0 → 8+).
      // An immune tile turns any claim away with the same light "dink".
      const dink = a.clash === 'dink';
      const k = dink ? 0 : heft(a.total);
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
      // The smash is heard as it lands: cued for the end of the wind-up (so it
      // can start early through slow headphones). A dink is a light tap
      // whatever the claim's power.
      const windup = ms(240 + 200 * k);
      sfx.claimSmashIn(dink ? 1 : a.total, windup);
      if (plan.baseRaid && !dink) sfx.cue('resolveBaseRaidRam', windup);
      await animate(claimRef.current, [
        { transform: 'translate(0, 0) scale(1)' },
        { transform: `translate(${wind.x}px, ${wind.y}px) scale(${1.1 + 0.3 * k})`, offset: tremble.length ? 0.4 : 0.35 },
        ...tremble,
        { transform: `translate(${hit.x}px, ${hit.y}px) scale(${hitScale})` },
      ], windup, 'cubic-bezier(0.5, 0, 0.9, 0.6)', 'forwards');
      const c = axialToPixel(plan.q, plan.r);
      const f = fx();
      const pc = PLAYER_COLORS[a.playerId] ?? 0xffffff;
      const bounced = a.clash === 'bounce' || dink;
      f?.sparks(c.x, c.y, dink ? 0xd8ecff : pc, dink ? 5 : Math.round((bounced ? 10 + 16 * k : 16 + 44 * k)), dink ? 0.45 : 0.8 + 0.9 * k);
      if (k >= 0.5) {
        f?.shockwave(c.x, c.y, pc, 0.7 + 0.9 * k, ms(420 + 200 * k));
        f?.dust(c.x, c.y, Math.round(10 + 22 * k), 0.6 + 0.8 * k);
      }
      if (!dink) ring?.flash((bounced ? 1.2 : 0.8) * (0.8 + 0.5 * k));
      // Hit-stop: a heavy blow holds the moment of impact.
      if (k > 0.25) await wait(Math.round(90 * k));

      if (a.clash === 'break' || a.clash === 'stalemate') {
        f?.shake((plan.baseRaid ? 0.6 : 0.2) + 0.9 * k, ms(260 + 240 * k));
        if (hadDefense) {
          burst(colorOf(holder), 6 + Math.round(10 * k), 1 + 0.9 * k);
          animate(defRef.current, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: `scale(${1.6 + 0.9 * k})` }], ms(160), 'ease-out', 'forwards');
        }
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
            setDefense(last ? ownerView(plan) : { mode: 'held', value: a.total, playerId: null });
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
      } else if (dink) {
        // Dinks off: the immune tile doesn't budge, the claim hops away.
        pulse(defRef.current, colorOf(holder));
        const side = dir.dx > 0 ? 1 : -1;
        await animate(claimRef.current, [
          { transform: `translate(${hit.x}px, ${hit.y}px) scale(${hitScale})`, opacity: 1 },
          { transform: `translate(${hit.x * 0.4 + dir.dx * 12}px, ${hit.y * 0.4 + dir.dy * 12 - 14}px) scale(0.92) rotate(${10 * side}deg)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${dir.dx * 26}px, ${dir.dy * 26 + 4}px) scale(0.8) rotate(${18 * side}deg)`, opacity: 0 },
        ], ms(380), 'ease-out', 'forwards');
        setClaim(null);
      } else {
        // Bounces off: the defense holds.
        f?.jolt(plan.q, plan.r, (plan.baseRaid ? 0.7 : 0.35) + 0.6 * k);
        if (k > 0.4) f?.shake(0.35 * k, ms(220));
        if (plan.baseRaid) sfx.resolveBaseRaidHold(); else sfx.resolveDefenseFortify();
        pulse(defRef.current, colorOf(holder));
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


    /** Siege Engine / Conqueror: just before its claim lands, this round's
     *  defense bonuses crack off — for that claim alone (everyone else
     *  attacked first, into the whole defense). */
    const crackDefense = async (plan: TilePlan, by: string) => {
      if (!defShown || !defRef.current) await popDefense(holderView(plan));
      else flushSync(() => setDefense(holderView(plan)));
      sfx.cue('resolveBaseRaidShatter', ms(140));
      await wait(140);
      burst('#d6cfc0', 9, 1.1);
      burst(colorOf(by), 6, 0.8);
      const c = axialToPixel(plan.q, plan.r);
      fx()?.sparks(c.x, c.y, PLAYER_COLORS[by] ?? 0xffffff, 18, 0.8);
      await guard(animate(defRef.current, [
        { transform: 'translateX(0) rotate(0)' }, { transform: 'translateX(-5px) rotate(-5deg)', offset: 0.2 },
        { transform: 'translateX(5px) rotate(4deg)', offset: 0.45 }, { transform: 'translateX(-3px) rotate(-2deg)', offset: 0.7 },
        { transform: 'translateX(0) rotate(0)' },
      ], ms(360), 'ease-out'));
      // The bonuses come off the temporary part first.
      const temp = Math.max(0, plan.temp - plan.ignored);
      const perm = Math.max(0, plan.perm - Math.max(0, plan.ignored - plan.temp));
      flushSync(() => setDefense(holderView(plan, perm, temp)));
      await guard(pulse(defRef.current, colorOf(by)));
      await wait(200);
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
      const view = (): DefenseView => ({ mode: 'defense', perm, temp, immune: false, holder: plan.holder });
      // No defense, no badge: it appears once there's something to show.
      if (perm + temp > 0) await popDefense(view());
      if (countUp) {
        await spreadOut(plan.defenseBeats.map(b => b.card));
        for (const b of plan.defenseBeats as Beat[]) {
          counting(b.card, true);
          await reveal([b.card]);
          if (b.add) {
            if (b.temp) temp += b.add; else perm += b.add;
            sfx.hoverTick();
            bump(b.card);
            if (!defShown) {
              await popDefense(view());
            } else {
              flushSync(() => setDefense(view()));
              await guard(pulse(defRef.current, colorOf(plan.holder)));
            }
          }
          counting(b.card, false);
          leaveSoon(b.card);
          await wait(110);
        }
      }
      // What the attackers face (immunity, or less than the tile showed).
      if (perm !== plan.perm || temp !== plan.temp || plan.immune) {
        const faced = ownerView(plan);
        if (faced && !defShown) {
          await popDefense(faced);
        } else if (faced) {
          flushSync(() => setDefense(faced));
          await guard(pulse(defRef.current, colorOf(plan.holder)));
        }
      }
      if (plan.immune) sfx.resolveDefenseFortify();
      for (const idx of plan.defenseSteps) api.applyStep(idx);
      if (!countUp) api.sendHome(plan.defenseBeats.flatMap(b => (b.card ? [b.card.key] : [])));
    };

    /** What card effects did on this tile, once it has settled: coins in or
     *  out of a bank, VP, cards joining a deck, a card burnt — each popping
     *  up over the tile, named for the card that did it. */
    const playAfter = async (plan: TilePlan, full: boolean) => {
      setDefense(null);
      setClaim(null);
      // A fresh layer: the tile's badges faded out with the last one.
      setTile({ q: plan.q, r: plan.r, run: ++seq });
      // Effects with no tile of their own come once a round: full pace.
      const pace = full || plan.outcome === 'round' ? 1 : 0.75;
      const c = axialToPixel(plan.q, plan.r);
      // One card handed to several players (Diplomat's Land Grants) is one
      // beat: a single chip, the cards flying out together.
      const beats: ResolutionEffect[][] = [];
      for (const e of plan.after) {
        const prev = beats[beats.length - 1]?.[0];
        if (prev && e.type === 'card' && prev.type === 'card' && prev.card_name === e.card_name && prev.source_card === e.source_card) {
          beats[beats.length - 1].push(e);
        } else beats.push([e]);
      }
      for (const [i, group] of beats.entries()) {
        const e = group[0];
        const at = live.current.project(plan.q, plan.r);
        // Keep the chips on screen (a base can sit at the very edge).
        const nudge = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? hi - v : 0);
        const x = at ? nudge(at.x, 130, window.innerWidth - 130) : 0;
        const y = -46 - (i % 3) * 36 + (at ? nudge(at.y - 46 - (i % 3) * 36, 70, window.innerHeight - 40) : 0);
        const color = colorOf(e.player_id);
        if (e.type === 'resources' && e.amount) {
          const gain = e.amount > 0;
          chip({ x, y, text: `${gain ? '+' : '−'}${Math.abs(e.amount)}`, icon: 'resource', caption: e.card_name, color, tone: gain ? 'gain' : 'loss' });
          if (gain) sfx.coinGain(); else sfx.coinSpend();
          if (at) api.bank(e.player_id, e.amount, at);
        } else if (e.type === 'vp' && e.amount) {
          chip({ x, y, text: `+${e.amount}`, icon: 'vp', caption: e.card_name, color: '#ffd24a', tone: 'gain' });
          fx()?.pillar(c.x, c.y, 0xffd24a, ms(900));
          sfx.vpGain();
          if (at) api.vp(e.player_id, e.amount, at);
        } else if (e.type === 'card' && e.card && e.count) {
          const bad = e.card_name === 'Debt' || e.card_name === 'Rubble';
          const total = group.reduce((n, g) => n + (g.count ?? 0), 0);
          chip({
            x, y, text: `+${total} ${e.card_name}${group.length > 1 && total > 1 ? 's' : ''}`,
            icon: e.card_name === 'Debt' ? 'debt' : e.card_name === 'Rubble' ? 'rubble' : 'cardAdd',
            caption: e.source_card, color: group.length > 1 ? colorOf(e.by_player_id ?? e.player_id) : color, tone: bad ? 'loss' : 'gain',
          });
          sfx.cardDraw();
          if (at) for (const g of group) if (g.card && g.count) api.giveCard(g.player_id, g.card, g.count, at, g.vp_each ?? 0);
        } else if (e.type === 'trash') {
          // Below the tile: the burning card floats over it.
          chip({ x, y: 58, text: `${e.card_name} trashed`, icon: 'trash', caption: e.source_card, color, tone: 'loss' });
          const keys = plan.burn.filter(k => !!e.card_id && k.includes(e.card_id));
          for (const k of keys) burning.delete(k);
          sfx.cardTrash();
          fx()?.sparks(c.x, c.y, 0xff8a3a, 14, 0.6);
          rawApi.burn(keys);
        }
        await wait(700 * pace);
      }
      // Time to read the last of them before the next tile.
      await wait(800 * pace);
    };

    /** Breakthrough: the claim breaks through into a tile beside the one it
     *  took — it sets off from there and takes this one unopposed. */
    const breakthrough = async (plan: TilePlan, name: string | undefined) => {
      const win = plan.winner;
      if (!win) return;
      const at = live.current.project(plan.q, plan.r);
      const src = plan.source ? live.current.project(plan.source.q, plan.source.r) : null;
      let dx = -1, dy = 0;
      if (at && src && Math.hypot(src.x - at.x, src.y - at.y) > 1) {
        const len = Math.hypot(src.x - at.x, src.y - at.y);
        dx = (src.x - at.x) / len;
        dy = (src.y - at.y) / len;
      }
      if (name) chip({ x: 0, y: -52, text: name, icon: 'claim', color: colorOf(win), tone: 'name' });
      flushSync(() => setClaim({ playerId: win, value: null, dx, dy }));
      const sx = at && src ? src.x - at.x - dx * CLAIM_R : 0, sy = at && src ? src.y - at.y - dy * CLAIM_R : 0;
      sfx.cardPlay();
      await animate(claimRef.current, [
        { transform: `translate(${sx}px, ${sy}px) scale(0.7)`, opacity: 0 },
        { transform: `translate(${sx * 0.8}px, ${sy * 0.8}px) scale(0.85)`, opacity: 1, offset: 0.2 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0.6 },
        { transform: `translate(${-dx * CLAIM_R}px, ${-dy * CLAIM_R}px) scale(1.15)`, opacity: 1 },
      ], ms(760), 'cubic-bezier(0.4, 0, 0.3, 1)', 'forwards');
      await animate(claimRef.current, [
        { transform: `translate(${-dx * CLAIM_R}px, ${-dy * CLAIM_R}px) scale(1.15)`, opacity: 1 },
        { transform: `translate(${-dx * CLAIM_R}px, ${-dy * CLAIM_R}px) scale(1.7)`, opacity: 0 },
      ], ms(220), 'ease-out', 'forwards');
      setClaim(null);
    };

    const resolveTile = async (plan: TilePlan, full: boolean) => {
      burning = new Set(plan.burn);
      try {
        await resolveBody(plan, full);
        if (plan.after.length) await playAfter(plan, full);
      } finally {
        burning = new Set();
      }
    };

    const resolveBody = async (plan: TilePlan, full: boolean) => {
      defShown = false;
      api.setActive(plan);
      setTile({ q: plan.q, r: plan.r, run: ++seq });

      // Effects with no tile of their own (Diplomat, Battle Glory): played
      // from their player's base, after everything else.
      if (plan.outcome === 'round') return;

      if (plan.outcome === 'flood') {
        // Flood: the card turns over, then the water surges out of the tile
        // into every tile around it — where its claims land next.
        const by = plan.others[0]?.playerId ?? plan.holder;
        const color = PLAYER_COLORS[by ?? ''] ?? 0x7fd3ff;
        await spreadOut(plan.others);
        await reveal(plan.others);
        // Read the card, then it goes, so the water is in plain view.
        await wait(450);
        api.sendHome(plan.others.map(c => c.key));
        await wait(300);
        chip({ x: 0, y: -52, text: 'Flood', icon: 'claim', color: colorOf(by), tone: 'name' });
        sfx.floodWave();
        fx()?.flood(plan.q, plan.r, (plan.targets ?? []).map(k => k.split(',').map(Number) as [number, number]), color);
        await wait(1300);
        return;
      }

      if (plan.kind === 'effect' && (plan.outcome === 'abandon' || plan.outcome === 'scorch')) {
        // Exodus / Scorched Retreat: the card turns over, then the tile is
        // given up — its holder's color lifts away (the camp and markers
        // sink), or it goes up in flames and is left a burnt wasteland.
        const f = fx();
        await spreadOut(plan.others);
        await reveal(plan.others);
        // Read the card, then it goes (Scorched Retreat burns: it's trashed)
        // so the tile is in plain view.
        await wait(450);
        api.sendHome(plan.others.map(c => c.key));
        await wait(300);
        if (plan.outcome === 'abandon') {
          f?.abandon(plan.q, plan.r, PLAYER_COLORS[plan.holder ?? ''] ?? 0xe8e4d8);
          sfx.tileAbandon();
          await wait(250);
          if (plan.mainStep != null) api.applyStep(plan.mainStep);
          await wait(950);
        } else {
          f?.scorch(plan.q, plan.r);
          sfx.tileScorch();
          // The ground turns to ash under the roaring flames.
          await wait(700);
          if (plan.mainStep != null) api.applyStep(plan.mainStep);
          await wait(1500);
        }
        return;
      }

      if (plan.kind === 'effect') {
        const f = fx();
        const c = axialToPixel(plan.q, plan.r);
        if (plan.outcome === 'consecrate') { f?.pillar(c.x, c.y, 0xffd24a, ms(900)); sfx.vpGain(); }
        if (plan.outcome === 'auto_claim') await breakthrough(plan, plan.cardName);
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
            if (a.crack) await crackDefense(plan, a.playerId);
            await attack(plan, a, true, ring, holder, i === plan.attacks.length - 1);
            if (a.clash === 'break') holder = a.playerId;
            if (a.clash === 'stalemate') holder = null;
          }
        } else if (plan.attacks.length) {
          // Quick: only the claim that decides it.
          const decisive = [...plan.attacks].reverse().find(a => a.clash !== 'bounce') ?? plan.attacks[plan.attacks.length - 1];
          const shown: AttackPlan = decisive.clash === 'bounce' ? decisive : { ...decisive, clash: plan.captured ? 'break' : decisive.clash };
          // It ignores the bonuses, and they cracked before it: show that.
          const crack = decisive.ignores ? plan.attacks.find(a => a.crack) : undefined;
          if (crack && plan.attacks.indexOf(crack) <= plan.attacks.indexOf(decisive)) await crackDefense(plan, crack.playerId);
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
      const isClose = (p: TilePlan) => p.focus && (p.kind !== 'effect'
        || p.outcome === 'abandon' || p.outcome === 'scorch' || p.outcome === 'auto_claim' || p.outcome === 'flood');
      // Stay in close until the last tile that involves the player: tiles
      // between are passed part way out, not with a full pull-back.
      let lastClose = -1;
      plans.forEach((p, i) => { if (isClose(p)) lastClose = i; });
      try {
        // Zoom out first: what resolves between other players stays on screen.
        if (overview) await guard(api.focus(null, 'overview'));
        for (const [i, plan] of plans.entries()) {
          const close = isClose(plan);
          if (close) {
            await guard(api.focus(plan.tileKey, 'close'));
            zoomed = true;
          } else if (zoomed && i < lastClose && plan.kind !== 'effect') {
            await guard(api.focus(plan.tileKey, 'pass'));
          } else if (zoomed) {
            await guard(api.focus(null, 'overview'));
            zoomed = false;
          }
          await resolveTile(plan, close);
          setDefense(null);
          setClaim(null);
          setTile(null);
          setChips([]);
          api.setActive(null);
        }
        // Then back to the player's own view.
        await guard(api.focus(null));
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
      {/* A fresh layer per tile: the last tile's fade-out (held at the end)
          never carries over — even when the next tile follows in the same
          render, with no camera move in between. */}
      <div key={tile.run} className="cc-rs-layer">
        {defense && (
          <div className="cc-rs-slot">
            <div ref={defRef} className={`cc-rs-badge is-defense${defense.mode === 'held' && !defense.settled ? ' is-leading' : ''}`} style={{
              ['--ring' as string]: defense.mode === 'held' ? colorOf(defense.playerId) : defense.holder ? colorOf(defense.holder) : 'rgba(232, 228, 216, 0.75)',
            }}>
              {defense.mode === 'defense' ? (
                defense.immune ? (
                  <><Icon name="immune" size={20} color={readable(colorOf(defense.holder))} decorative /><span className="cc-rs-word" style={{ color: readable(colorOf(defense.holder)) }}>Immune</span></>
                ) : (
                  // One total that counts up card by card, like a claim's, in
                  // the holder's color (white when neutral). The grid's blue
                  // is for previewing this round's Defense cards, not this.
                  <>
                    <Icon name={defense.temp > 0 ? 'defense' : 'fortify'} size={20} color={readable(colorOf(defense.holder))} decorative />
                    <Num value={defense.perm + defense.temp} size={21} color={readable(colorOf(defense.holder))} />
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
              {claim.value != null && <Num value={claim.value} size={21} color={readable(colorOf(claim.playerId))} />}
            </div>
          </div>
        )}
        {chips.map(c => (
          <div key={c.id} className={`cc-rs-chip is-${c.tone}`} style={{
            left: c.x, top: c.y, ['--ring' as string]: c.color,
            animationDuration: `${Math.round(1700 * (speed || 1))}ms`,
          }}>
            <span className="cc-rs-chip-main">
              {c.icon && <Icon name={c.icon} size={16} color={c.tone === 'bonus' ? '#ffd24a' : readable(c.color)} decorative />}
              <span>{c.text}</span>
            </span>
            {c.caption && <span className="cc-rs-chip-caption">{c.caption}</span>}
          </div>
        ))}
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
