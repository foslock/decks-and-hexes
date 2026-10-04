import { useEffect, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../../types/game';
import CardFull from '../CardFull';
import { CARD_H, CARD_W, easeIn, easeOut, lerp, type Pose } from './cardMotion';

/** Noise contrast for the burn front: higher = a crisper edge. */
const BURN_K = 11;

/**
 * A trashed card rips in two down a jagged seam, the halves fall away from
 * each other, and both burn up from the inside out: an SVG filter dissolves
 * them along a noise field with a glowing ember front and a charred rim,
 * while sparks and smoke drift up.
 */
export default function TrashBurn({ card, pose, speed, onDone }: {
  card: Card;
  /** Screen pose of the card when it was trashed. */
  pose: Pose;
  /** Animation duration multiplier (1 normal, 0.5 fast). */
  speed: number;
  onDone: () => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const filterId = `cc-burn-${uid}`;
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const seamRef = useRef<SVGPolylineElement>(null);
  const keepRef = useRef<SVGFEFuncAElement>(null);
  const charRef = useRef<SVGFEFuncAElement>(null);
  const emberRef = useRef<SVGFEFuncAElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

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

  // Before it rips, the card rises clear of the hand to a readable size.
  const lift = useMemo<Pose>(() => {
    const scale = Math.max(pose.scale, Math.min(0.9, (window.innerHeight * 0.42) / CARD_H));
    return {
      x: pose.x,
      y: Math.min(pose.y, window.innerHeight - (CARD_H * scale) / 2 - 36),
      rot: 0,
      scale,
    };
  }, [pose]);
  const containerRef = useRef<HTMLDivElement>(null);

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
    const start = performance.now();
    let raf = 0;
    const setThreshold = (th: number) => {
      // alpha' = K·(noise − th): the card survives where the noise is above
      // the threshold; the char and ember bands sit just below it.
      keepRef.current?.setAttribute('intercept', String(-BURN_K * th));
      charRef.current?.setAttribute('intercept', String(-BURN_K * (th - 0.045)));
      emberRef.current?.setAttribute('intercept', String(-BURN_K * (th - 0.1)));
    };
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / total);
      // Rise (0–18%), a shudder and a bright seam (14–26%), then the halves
      // part and sag while they burn away.
      const rise = easeOut(Math.min(1, t / 0.18));
      const at = { x: lerp(pose.x, lift.x, rise), y: lerp(pose.y, lift.y, rise), rot: lerp(pose.rot, lift.rot, rise), scale: lerp(pose.scale, lift.scale, rise) };
      if (containerRef.current) {
        containerRef.current.style.transform = `translate(${at.x - CARD_W / 2}px, ${at.y - CARD_H / 2}px) rotate(${at.rot}deg) scale(${at.scale})`;
      }
      const rip = Math.max(0, Math.min(1, (t - 0.14) / 0.12));
      const part = t < 0.24 ? 0 : easeOut((t - 0.24) / 0.76);
      const shake = t > 0.12 && t < 0.26 ? Math.sin(t * 300) * 1.8 : 0;
      const sep = 1.5 * rip + 16 * part;
      const ang = 2 * rip + 9 * part;
      const fall = 34 * part * part;
      if (leftRef.current) leftRef.current.style.transform = `translate(${-sep + shake}px, ${fall}px) rotate(${-ang}deg)`;
      if (rightRef.current) rightRef.current.style.transform = `translate(${sep - shake}px, ${fall * 1.1}px) rotate(${ang}deg)`;
      if (seamRef.current) seamRef.current.style.opacity = String(t < 0.26 ? rip : Math.max(0, 1 - (t - 0.26) / 0.16));
      // Burn starts as the halves part and eats them by the end.
      const burn = t < 0.22 ? 0 : easeIn(Math.min(1, (t - 0.22) / 0.75) ** 0.7);
      setThreshold(lerp(0.12, 0.86, burn));
      if (t < 1) raf = requestAnimationFrame(tick);
      else doneRef.current();
    };
    setThreshold(0.12);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed, pose, lift]);

  const halfStyle = (clip: string): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    clipPath: clip,
    filter: `url(#${filterId})`,
    transformOrigin: `${pivotX}px ${CARD_H}px`,
    willChange: 'transform',
  });

  return createPortal(
    <>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          <filter id={filterId} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="3" seed={Math.floor(Math.random() * 100)} result="noise" />
            <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="n" />
            <feComponentTransfer in="n" result="keep"><feFuncA ref={keepRef} type="linear" slope={BURN_K} intercept="0" /></feComponentTransfer>
            <feComponentTransfer in="n" result="char"><feFuncA ref={charRef} type="linear" slope={BURN_K} intercept="0" /></feComponentTransfer>
            <feComponentTransfer in="n" result="ember"><feFuncA ref={emberRef} type="linear" slope={BURN_K} intercept="0" /></feComponentTransfer>
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
      }}>
        <div ref={leftRef} style={halfStyle(leftClip)}><CardFull card={card} artZoom={false} /></div>
        <div ref={rightRef} style={halfStyle(rightClip)}><CardFull card={card} artZoom={false} /></div>
        <svg width={CARD_W} height={CARD_H} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden>
          <polyline
            ref={seamRef}
            points={seam.map(p => p.join(',')).join(' ')}
            fill="none"
            stroke="#ffd27a"
            strokeWidth={3}
            strokeLinejoin="round"
            style={{ opacity: 0, filter: 'drop-shadow(0 0 4px #ff8a1c) drop-shadow(0 0 8px #ff5a00)' }}
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
            background: 'radial-gradient(closest-side, rgba(40, 34, 40, 0.55), rgba(40, 34, 40, 0))',
            filter: 'blur(4px)',
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
