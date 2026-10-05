import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import Icon from '../icons/Icon';
import { Num } from '../icons/Num';
import { runAnimation } from './hand/cardMotion';

/**
 * The bank counter beside the action counter: the resource glyph and how many
 * you hold ("7 resources" on hover / tap), with a +X / −X float whenever it
 * changes. Gains arrive as coins that fly in from where they came from — the
 * card you just played, the tile a card paid out on, or your ID card — and the
 * count ticks up as each coin lands.
 *
 * The number shown is the bank minus the coins still in the air, so the server
 * value can arrive at once while the counter catches up coin by coin. The
 * player's ID card reads the same number (useShownResources), so the two never
 * disagree.
 */

export interface Point { x: number; y: number }
export interface ResourceSource { point: Point; weight?: number }

export interface ResourceCounterHandle {
  /**
   * Say where the next bank change comes from, before the request that causes
   * it (the new state may arrive by socket before the response does). A gain
   * flies in as coins from `from`, taking off no sooner than `launchAt`
   * (performance.now() ms) — or just counts, with its +X, when `coins` is
   * false. A spend shows its −X. Lapses after `ttl` ms if nothing changes.
   */
  expect(opts: { from?: () => Point | null; launchAt?: number; coins?: boolean; ttl?: number }): void;
}

interface Expectation { from: () => Point | null; launchAt: number; coins: boolean; expires: number }

interface Props {
  /** The bank, as the rest of the HUD shows it (frozen while a resolve plays). */
  value: number;
  /** Whose bank: switching players resets without animating. */
  playerId: string;
  /** Animation speed (1 normal, 0.5 fast, 0 off). */
  speed: number;
  visible: boolean;
  /** Where gains nobody announced came from (resolution payouts, start-of-round bonuses…). */
  sourcesForGain: () => ResourceSource[];
}

// ── The number other HUD pieces show (the ID card) ─────────────────────────
const shownStore = new Map<string, number>();
const listeners = new Set<() => void>();
function publishShown(playerId: string, value: number | null) {
  if (value == null) shownStore.delete(playerId);
  else if (shownStore.get(playerId) === value) return;
  else shownStore.set(playerId, value);
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
/** A player's bank as the counter currently shows it (coins still in flight
 *  not yet counted), or `fallback` when no counter tracks that player. */
export function useShownResources(playerId: string, fallback: number): number {
  return useSyncExternalStore(subscribe, () => shownStore.get(playerId) ?? fallback, () => fallback);
}

// ── Coins ───────────────────────────────────────────────────────────────────
export interface Coin { id: number; from: Point; to: Point; value: number; delay: number; duration: number; batch: number }
interface Float { id: number; amount: number; offsetX: number }

const MAX_COINS = 10;

/** Split a gain into at most MAX_COINS coins that add up to it. */
export function splitCoins(amount: number): number[] {
  const n = Math.max(1, Math.min(MAX_COINS, amount));
  const base = Math.floor(amount / n);
  const out = Array.from({ length: n }, () => base);
  for (let i = 0; i < amount - base * n; i++) out[i] += 1;
  return out;
}

/** Share a gain between sources by weight (whole coins, nothing lost). */
export function shareGain(amount: number, sources: ResourceSource[]): number[] {
  if (sources.length === 0) return [];
  const total = sources.reduce((a, s) => a + (s.weight ?? 1), 0) || sources.length;
  const shares = sources.map(s => Math.floor((amount * (s.weight ?? 1)) / total));
  let left = amount - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % shares.length, left--) shares[i] += 1;
  return shares;
}

/** One coin arcing from `from` to `to` (position: fixed — inside `.cc-res-coins`). */
export function CoinFlight({ coin, onLand }: { coin: Coin; onLand: (c: Coin) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const { from, to } = coin;
    const lift = Math.min(140, 50 + Math.hypot(to.x - from.x, to.y - from.y) * 0.18);
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = from.x + (to.x - from.x) * e;
      const y = from.y + (to.y - from.y) * e - lift * 4 * t * (1 - t);
      const s = 0.7 + Math.sin(Math.PI * t) * 0.45 - t * 0.1;
      frames.push({ offset: t, transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${s}) rotate(${t * 540}deg)`, opacity: t < 0.08 ? t / 0.08 : 1 });
    }
    let live = true;
    void runAnimation(ref.current, frames, { duration: coin.duration, delay: coin.delay, easing: 'linear', fill: 'both' })
      .then(() => { if (live) onLand(coin); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className="cc-res-coin" style={{ opacity: 0 }}>
      <Icon name="resource" size={20} decorative />
    </div>
  );
}

const ResourceCounter = forwardRef<ResourceCounterHandle, Props>(function ResourceCounter(
  { value, playerId, speed, visible, sourcesForGain },
  ref,
) {
  const [inFlight, setInFlight] = useState(0);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [floats, setFloats] = useState<Float[]>([]);
  const [bump, setBump] = useState(0);
  const [labelOpen, setLabelOpen] = useState(false);
  const iconRef = useRef<HTMLSpanElement>(null);
  const pointerRef = useRef('mouse');
  const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const lastSeen = useRef(value);
  const lastPlayer = useRef(playerId);
  /** Where the next bank change comes from, if we were told. */
  const expected = useRef<Expectation | null>(null);
  /** Batches whose +X float waits for the first coin to land. */
  const batchFloat = useRef(new Map<number, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const liveRef = useRef({ speed, visible, sourcesForGain });
  liveRef.current = { speed, visible, sourcesForGain };

  const shown = Math.max(0, value - inFlight);

  const addFloat = useCallback((amount: number) => {
    const id = ++seq.current;
    setFloats(f => [...f, { id, amount, offsetX: (Math.random() - 0.5) * 18 }]);
    const t = setTimeout(() => { timers.current.delete(t); setFloats(f => f.filter(x => x.id !== id)); }, 950);
    timers.current.add(t);
  }, []);

  /** Fly `amount` in as coins from `from` (re-read when they launch). */
  const flyCoins = useCallback((amount: number, from: () => Point | null, delay: number) => {
    const { speed: sp } = liveRef.current;
    const batch = ++seq.current;
    batchFloat.current.set(batch, amount);
    setInFlight(f => f + amount);
    const launch = () => {
      const start = from();
      const r = iconRef.current?.getBoundingClientRect();
      if (!start || !r || r.width === 0) {
        // Nowhere to fly from / to: count it now.
        batchFloat.current.delete(batch);
        setInFlight(f => Math.max(0, f - amount));
        addFloat(amount);
        return;
      }
      const to = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const stagger = 85 * sp;
      setCoins(cs => [...cs, ...splitCoins(amount).map((v, i) => ({
        id: ++seq.current, from: start, to, value: v, batch,
        delay: i * stagger, duration: Math.max(320, 680 * sp),
      }))]);
    };
    if (delay > 0) {
      const t = setTimeout(() => { timers.current.delete(t); launch(); }, delay);
      timers.current.add(t);
    } else {
      launch();
    }
  }, [addFloat]);

  const onLand = useCallback((c: Coin) => {
    setCoins(cs => cs.filter(x => x.id !== c.id));
    setInFlight(f => Math.max(0, f - c.value));
    setBump(b => b + 1);
    const total = batchFloat.current.get(c.batch);
    if (total != null) {
      batchFloat.current.delete(c.batch);
      addFloat(total);
    }
  }, [addFloat]);

  const animated = () => liveRef.current.speed > 0 && liveRef.current.visible;

  useImperativeHandle(ref, () => ({
    expect({ from, launchAt, coins = true, ttl = 4000 }) {
      const now = performance.now();
      expected.current = { from: from ?? (() => null), launchAt: launchAt ?? now, coins, expires: now + ttl };
    },
  }), []);

  // The bank changed: spends show their −X; gains fly in as coins — from the
  // card we were told about, or from wherever the game says they came from.
  useLayoutEffect(() => {
    if (lastPlayer.current !== playerId) {
      lastPlayer.current = playerId;
      lastSeen.current = value;
      expected.current = null;
      return;
    }
    const delta = value - lastSeen.current;
    lastSeen.current = value;
    if (delta === 0) return;
    const now = performance.now();
    const exp = expected.current && expected.current.expires > now ? expected.current : null;
    expected.current = null;
    if (delta < 0 || !animated() || (exp && !exp.coins)) { addFloat(delta); return; }
    if (exp) { flyCoins(delta, exp.from, Math.max(0, exp.launchAt - now)); return; }
    const sources = liveRef.current.sourcesForGain();
    if (sources.length === 0) { addFloat(delta); return; }
    shareGain(delta, sources).forEach((amount, i) => {
      if (amount > 0) flyCoins(amount, () => sources[i].point, i * 120 * liveRef.current.speed);
    });
  }, [value, playerId, flyCoins, addFloat]);

  // A new player or turning animations off drops whatever was in the air.
  useEffect(() => {
    setCoins([]);
    setInFlight(0);
    batchFloat.current.clear();
  }, [playerId]);
  useEffect(() => {
    if (speed > 0) return;
    setCoins([]);
    setInFlight(0);
    batchFloat.current.clear();
  }, [speed]);

  useLayoutEffect(() => { publishShown(playerId, shown); }, [playerId, shown]);
  useEffect(() => () => {
    publishShown(lastPlayer.current, null);
    for (const t of timers.current) clearTimeout(t);
    if (labelTimer.current) clearTimeout(labelTimer.current);
  }, []);

  const toggleLabel = () => {
    if (labelTimer.current) clearTimeout(labelTimer.current);
    labelTimer.current = null;
    setLabelOpen(open => {
      if (!open) labelTimer.current = setTimeout(() => setLabelOpen(false), 3000);
      return !open;
    });
  };

  const has = shown > 0;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="cc-res-counter"
        aria-label={`${shown} resource${shown !== 1 ? 's' : ''}`}
        aria-expanded={labelOpen}
        data-resource-counter
        onPointerDown={(e) => { pointerRef.current = e.pointerType; }}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setLabelOpen(true); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setLabelOpen(false); }}
        onClick={() => { if (pointerRef.current !== 'mouse') toggleLabel(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLabel(); } }}
        style={{
          position: 'relative',
          pointerEvents: visible ? 'auto' : 'none',
          cursor: 'var(--cc-cursor-arrow)',
          boxSizing: 'border-box',
          height: 42,
          display: 'flex', alignItems: 'center',
          padding: '0 13px',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0) 60%), rgba(14, 14, 34, 0.85)',
          border: `1px solid ${has ? 'rgba(232, 196, 106, 0.35)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: 10,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 4px 12px rgba(0,0,0,0.4)',
          opacity: visible ? 1 : 0,
          transition: 'opacity 0.4s ease-in',
          outline: 'none',
        }}
      >
        <div style={{
          position: 'absolute', bottom: '100%', left: 0,
          paddingBottom: 8,
          opacity: labelOpen ? 1 : 0,
          transition: 'opacity 0.15s ease',
          pointerEvents: 'none',
        }}>
          <div style={{
            padding: '4px 10px',
            background: '#111122',
            border: '1px solid #555',
            borderRadius: 6,
            color: '#ccc',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}>
            Spend resources in the shop after each round.
          </div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center',
          fontSize: 22, lineHeight: 1, fontWeight: 900, fontFamily: 'var(--cc-font-display)',
          fontVariantNumeric: 'tabular-nums',
          color: has ? '#ffe7a8' : '#555',
          textShadow: has ? '0 0 10px rgba(232, 196, 106, 0.45), 0 1px 2px rgba(0,0,0,0.6)' : 'none',
          position: 'relative',
        }}>
          <span key={bump} className={bump ? 'cc-res-bump' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span ref={iconRef} style={{ display: 'inline-flex' }}><Icon name="resource" size={22} title="Resources" /></span>
            <Num value={shown} style={{ fontFamily: 'inherit', fontWeight: 900, top: 0 }} />
          </span>
          {floats.map(f => (
            <span key={f.id} className="cc-res-float" style={{ left: f.offsetX, color: f.amount > 0 ? '#4ade80' : '#ff6b6b' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {f.amount > 0 ? `+${f.amount}` : `−${-f.amount}`}
                <Icon name="resource" size={17} decorative />
              </span>
            </span>
          ))}
        </span>
        {/* "resources" folds away until hovered or tapped */}
        <span aria-hidden style={{
          display: 'inline-block',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          maxWidth: labelOpen ? 110 : 0,
          marginLeft: labelOpen ? 8 : 0,
          opacity: labelOpen ? 1 : 0,
          transition: 'max-width 0.2s ease, margin-left 0.2s ease, opacity 0.15s ease',
          fontSize: 13,
          lineHeight: 1,
          color: has ? '#aaa' : '#555',
        }}>
          resource{shown !== 1 ? 's' : ''}
        </span>
      </div>
      {coins.length > 0 && createPortal(
        <div className="cc-res-coins">
          {coins.map(c => <CoinFlight key={c.id} coin={c} onLand={onLand} />)}
        </div>,
        document.body,
      )}
    </>
  );
});

export default ResourceCounter;
