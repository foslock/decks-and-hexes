import { useEffect, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../../types/game';
import CardFull from '../CardFull';
import { CARD_H, CARD_W, easeIn, easeOut, lerp, type Pose } from './cardMotion';

/** Noise contrast for the burn front: higher = a crisper edge. */
const BURN_K = 11;
/** The burn front redraws at most this often (ms). Everything that moves is
 *  a compositor animation and stays at full frame rate regardless. */
const BURN_STEP_MS = 33;

/**
 * Fractal value noise (0–1, in the colour channels) at half the card's
 * resolution, made on a canvas and fed to the burn filter as an image.
 * feTurbulence would recompute it for every pixel of every frame of the
 * burn — on the CPU in Safari — which is what made trashing stutter.
 */
function makeNoise(): string {
  const w = Math.ceil(CARD_W / 2);
  const h = Math.ceil(CARD_H / 2);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  // Three octaves, the coarsest ≈ feTurbulence baseFrequency 0.028 at full size.
  const octaves = [18, 9, 4.5].map((cell, i) => {
    const cols = Math.ceil(w / cell) + 2;
    const rows = Math.ceil(h / cell) + 2;
    return { cell, amp: 0.5 ** i, cols, grid: Float32Array.from({ length: cols * rows }, Math.random) };
  });
  const total = octaves.reduce((a, o) => a + o.amp, 0);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (const o of octaves) {
        const gx = x / o.cell, gy = y / o.cell;
        const ix = Math.floor(gx), iy = Math.floor(gy);
        const fx = smooth(gx - ix), fy = smooth(gy - iy);
        const g = o.grid, c = o.cols, i = iy * c + ix;
        const top = g[i] + (g[i + 1] - g[i]) * fx;
        const bot = g[i + c] + (g[i + c + 1] - g[i + c]) * fx;
        v += o.amp * (top + (bot - top) * fy);
      }
      const b = Math.round((v / total) * 255);
      const p = (y * w + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = b;
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

const noiseCache: string[] = [];
/** A noise field for one burn (a few are kept and reused). */
function burnNoise(): string {
  if (noiseCache.length < 4) {
    const n = makeNoise();
    if (n) noiseCache.push(n);
    return n;
  }
  return noiseCache[Math.floor(Math.random() * noiseCache.length)];
}

/**
 * A trashed card rips in two down a jagged seam, the halves fall away from
 * each other, and both burn up from the inside out: an SVG filter dissolves
 * them along a noise field with a glowing ember front and a charred rim,
 * while sparks and smoke drift up.
 */
export default function TrashBurn({ card, pose, speed, onDone, maxScale = 0.9 }: {
  card: Card;
  /** Screen pose of the card when it was trashed. */
  pose: Pose;
  /** Animation duration multiplier (1 normal, 0.5 fast). */
  speed: number;
  onDone: () => void;
  /** Largest size the card rises to before it rips. */
  maxScale?: number;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const filterId = `cc-burn-${uid}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const seamRef = useRef<SVGSVGElement>(null);
  /** Each half's keep / char / ember transfer nodes (left 0–2, right 3–5). */
  const funcRefs = useRef<SVGFEFuncAElement[]>([]);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const noise = useMemo(burnNoise, []);

  // A jagged seam from top to bottom, wandering around the middle.
  const seam = useMemo(() => {
    const pts: [number, number][] = [];
    const steps = 16;
    let x = CARD_W / 2 + (Math.random() - 0.5) * 16;
    for (let i = 0; i <= steps; i++) {
      const y = (i / steps) * CARD_H;
      pts.push([x, y]);
      x += (i % 2 ? 1 : -1) * (4 + Math.random() * 7) + (Math.random() - 0.5) * 4;
      x = Math.max(CARD_W * 0.38, Math.min(CARD_W * 0.62, x));
    }
    return pts;
  }, []);
  const pathPts = seam.map(([x, y]) => `${x}px ${y}px`).join(', ');
  const leftClip = `polygon(0 -20px, ${seam[0][0]}px -20px, ${pathPts}, ${seam[seam.length - 1][0]}px ${CARD_H + 20}px, 0 ${CARD_H + 20}px)`;
  const rightClip = `polygon(${seam[0][0]}px -20px, ${CARD_W + 20}px -20px, ${CARD_W + 20}px ${CARD_H + 20}px, ${seam[seam.length - 1][0]}px ${CARD_H + 20}px, ${[...seam].reverse().map(([x, y]) => `${x}px ${y}px`).join(', ')})`;
  const pivotX = seam[seam.length - 1][0];
  // Each half's filter only covers its own side of the seam (plus room for
  // the ember glow): half the pixels to filter.
  const seamMin = Math.min(...seam.map(p => p[0])) / CARD_W;
  const seamMax = Math.max(...seam.map(p => p[0])) / CARD_W;

  // Before it rips, the card rises clear of the hand to a readable size.
  const lift = useMemo<Pose>(() => {
    const scale = Math.max(pose.scale, Math.min(maxScale, (window.innerHeight * 0.42) / CARD_H));
    return {
      x: pose.x,
      y: Math.min(pose.y, window.innerHeight - (CARD_H * scale) / 2 - 36),
      rot: 0,
      scale,
    };
  }, [pose, maxScale]);

  const sparks = useMemo(() => Array.from({ length: 22 }, (_, i) => ({
    left: (Math.random() - 0.5) * CARD_W * lift.scale * 0.9,
    top: (Math.random() - 0.4) * CARD_H * lift.scale * 0.8,
    dx: (Math.random() - 0.5) * 70,
    dy: -(60 + Math.random() * 110),
    size: 2.5 + Math.random() * 3.5,
    delay: 0.4 + (i / 22) * 0.75 + Math.random() * 0.1,
    dur: 0.6 + Math.random() * 0.6,
  })), [lift.scale]);
  const smoke = useMemo(() => Array.from({ length: 5 }, (_, i) => ({
    left: (Math.random() - 0.5) * CARD_W * lift.scale * 0.6,
    dx: (Math.random() - 0.5) * 60,
    delay: 0.5 + i * 0.14,
    size: 60 + Math.random() * 50,
  })), [lift.scale]);

  useEffect(() => {
    const total = 1800 * speed;
    const timing: KeyframeAnimationOptions = { duration: total, easing: 'linear', fill: 'forwards' };
    const N = 36;
    const at = (i: number) => i / N;
    const box = (t: number) => {
      // Rise (0–18%): clear of the hand, to a readable size.
      const rise = easeOut(Math.min(1, t / 0.18));
      const x = lerp(pose.x, lift.x, rise), y = lerp(pose.y, lift.y, rise);
      const rot = lerp(pose.rot, lift.rot, rise), scale = lerp(pose.scale, lift.scale, rise);
      return `translate(${x - CARD_W / 2}px, ${y - CARD_H / 2}px) rotate(${rot}deg) scale(${scale})`;
    };
    // A shudder and a bright seam (14–26%), then the halves part and sag.
    const half = (t: number, side: -1 | 1) => {
      const rip = Math.max(0, Math.min(1, (t - 0.14) / 0.12));
      const part = t < 0.24 ? 0 : easeOut((t - 0.24) / 0.76);
      const shake = t > 0.12 && t < 0.26 ? Math.sin(t * 300) * 1.8 : 0;
      const sep = 1.5 * rip + 16 * part;
      const ang = 2 * rip + 9 * part;
      const fall = 34 * part * part * (side > 0 ? 1.1 : 1);
      return `translate(${side * (sep - shake)}px, ${fall}px) rotate(${side * ang}deg)`;
    };
    const anims: Animation[] = [];
    const run = (el: Element | null, frames: Keyframe[]) => {
      if (el && typeof (el as HTMLElement).animate === 'function') anims.push((el as HTMLElement).animate(frames, timing));
    };
    const samples = Array.from({ length: N + 1 }, (_, i) => at(i));
    run(containerRef.current, samples.map(t => ({ offset: t, transform: box(t) })));
    // The shudder needs finer steps than the rest.
    const fine = [...new Set([...samples, ...Array.from({ length: 29 }, (_, i) => 0.12 + (i / 28) * 0.14)])].sort((a, b) => a - b);
    run(leftRef.current, fine.map(t => ({ offset: t, transform: half(t, -1) })));
    run(rightRef.current, fine.map(t => ({ offset: t, transform: half(t, 1) })));
    run(seamRef.current, [
      { offset: 0, opacity: 0 }, { offset: 0.14, opacity: 0 }, { offset: 0.26, opacity: 1 }, { offset: 0.42, opacity: 0 }, { offset: 1, opacity: 0 },
    ]);

    // The burn front: alpha' = K·(noise − th) — the card survives where the
    // noise is above the threshold; the char and ember bands sit just below.
    const setThreshold = (th: number) => {
      const bands = [th, th - 0.045, th - 0.1];
      funcRefs.current.forEach((fn, i) => fn?.setAttribute('intercept', String(-BURN_K * bands[i % 3])));
    };
    const start = performance.now();
    let raf = 0;
    let lastStep = -Infinity;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / total);
      if (t >= 1) { doneRef.current(); return; }
      // Burn starts as the halves part and eats them by the end.
      if (t >= 0.22 && now - lastStep >= BURN_STEP_MS) {
        lastStep = now;
        setThreshold(lerp(0.12, 0.86, easeIn(Math.min(1, (t - 0.22) / 0.75) ** 0.7)));
      }
      raf = requestAnimationFrame(tick);
    };
    setThreshold(0.12);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      anims.forEach(a => a.cancel());
    };
  }, [speed, pose, lift]);

  const halfStyle = (clip: string, side: 'l' | 'r'): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    clipPath: clip,
    filter: `url(#${filterId}-${side})`,
    transformOrigin: `${pivotX}px ${CARD_H}px`,
    willChange: 'transform',
  });

  const filter = (side: 'l' | 'r') => {
    const x = side === 'l' ? -0.1 : seamMin - 0.06;
    const width = side === 'l' ? seamMax + 0.06 - x : 1.1 - x;
    const refFor = (i: number) => (el: SVGFEFuncAElement | null) => { if (el) funcRefs.current[(side === 'l' ? 0 : 3) + i] = el; };
    return (
      <filter id={`${filterId}-${side}`} x={x} y="-0.1" width={width} height="1.2" colorInterpolationFilters="sRGB">
        <feImage href={noise} x="0" y="0" width={CARD_W} height={CARD_H} preserveAspectRatio="none" result="noise" />
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="n" />
        <feComponentTransfer in="n" result="keep"><feFuncA ref={refFor(0)} type="linear" slope={BURN_K} intercept="0" /></feComponentTransfer>
        <feComponentTransfer in="n" result="char"><feFuncA ref={refFor(1)} type="linear" slope={BURN_K} intercept="0" /></feComponentTransfer>
        <feComponentTransfer in="n" result="ember"><feFuncA ref={refFor(2)} type="linear" slope={BURN_K} intercept="0" /></feComponentTransfer>
        <feComposite in="SourceGraphic" in2="keep" operator="in" result="kept" />
        <feFlood floodColor="#2a1206" result="charColor" />
        <feComposite in="charColor" in2="char" operator="in" result="charBand" />
        <feComposite in="charBand" in2="keep" operator="out" result="charRim" />
        <feFlood floodColor="#ff8a1c" result="fire" />
        <feComposite in="fire" in2="ember" operator="in" result="fireBand" />
        <feComposite in="fireBand" in2="char" operator="out" result="fireRim" />
        <feComposite in="fireRim" in2="SourceAlpha" operator="in" result="fireClip" />
        <feComposite in="charRim" in2="SourceAlpha" operator="in" result="charClip" />
        <feGaussianBlur in="fireClip" stdDeviation="2.2" result="fireGlow" />
        <feMerge>
          <feMergeNode in="fireGlow" />
          <feMergeNode in="fireClip" />
          <feMergeNode in="charClip" />
          <feMergeNode in="kept" />
        </feMerge>
      </filter>
    );
  };

  return createPortal(
    <>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          {filter('l')}
          {filter('r')}
        </defs>
      </svg>
      <div ref={containerRef} style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: CARD_W,
        height: CARD_H,
        transform: `translate(${pose.x - CARD_W / 2}px, ${pose.y - CARD_H / 2}px) rotate(${pose.rot}deg) scale(${pose.scale})`,
        pointerEvents: 'none',
        zIndex: 9995,
        willChange: 'transform',
      }}>
        <div ref={leftRef} style={halfStyle(leftClip, 'l')}><CardFull card={card} /></div>
        <div ref={rightRef} style={halfStyle(rightClip, 'r')}><CardFull card={card} /></div>
        <svg ref={seamRef} width={CARD_W} height={CARD_H} style={{ position: 'absolute', inset: 0, overflow: 'visible', opacity: 0 }} aria-hidden>
          <polyline
            points={seam.map(p => p.join(',')).join(' ')}
            fill="none"
            stroke="#ffd27a"
            strokeWidth={3}
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 4px #ff8a1c) drop-shadow(0 0 8px #ff5a00)' }}
          />
        </svg>
      </div>
      {/* Sparks and smoke, in screen space so they rise straight up */}
      <div style={{ position: 'fixed', left: lift.x, top: lift.y, width: 0, height: 0, pointerEvents: 'none', zIndex: 9996 }}>
        {smoke.map((s, i) => (
          <div key={`s${i}`} style={{
            position: 'absolute',
            left: s.left,
            top: -s.size / 2,
            width: s.size,
            height: s.size,
            borderRadius: '50%',
            // Soft enough on its own — a blur filter here cost more than it showed.
            background: 'radial-gradient(closest-side, rgba(40, 34, 40, 0.5), rgba(40, 34, 40, 0.22) 55%, rgba(40, 34, 40, 0))',
            ['--dx' as string]: `${s.dx}px`,
            animation: `cc-smoke-rise ${1.3 * speed}s ease-out ${s.delay * speed}s both`,
          }} />
        ))}
        {sparks.map((s, i) => (
          <div key={`e${i}`} style={{
            position: 'absolute',
            left: s.left,
            top: s.top,
            width: s.size,
            height: s.size,
            borderRadius: '50%',
            background: 'radial-gradient(circle, #fff6c8 0%, #ffb23a 45%, rgba(255, 90, 0, 0) 75%)',
            boxShadow: '0 0 6px 2px rgba(255, 140, 30, 0.6)',
            ['--dx' as string]: `${s.dx}px`,
            ['--dy' as string]: `${s.dy}px`,
            animation: `cc-ember-rise ${s.dur * speed * 1.4}s ease-out ${s.delay * speed}s both`,
          }} />
        ))}
      </div>
    </>,
    document.body,
  );
}
