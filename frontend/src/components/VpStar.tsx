import { useLayoutEffect, useRef } from 'react';
import Icon from '../icons/Icon';
import { runAnimation } from './hand/cardMotion';

/** A VP star flying from where it was won (or lost) to a score. */
export interface VpStarFlight {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  duration: number;
  delay?: number;
  /** A VP lost: a red star, and the score counts down as it lands. */
  loss?: boolean;
}

/** One star: it arcs up and over, swelling mid-flight, and fades as it lands. */
export function VpStar({ f, onDone, zIndex }: { f: VpStarFlight; onDone: (f: VpStarFlight) => void; zIndex?: number }) {
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
    void runAnimation(ref.current, frames, { duration: f.duration, delay: f.delay ?? 0, easing: 'linear', fill: 'both' })
      .then(() => { if (live) onDone(f); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className={`cc-vp-star${f.loss ? ' is-loss' : ''}`} style={zIndex != null ? { zIndex } : undefined}>
      <Icon name="vp" size={26} decorative />
    </div>
  );
}

/** A score's VP icon gives a little jump as a star lands on it. */
export function bumpVpIcon(el: Element | null | undefined, loss = false) {
  (el as HTMLElement | null | undefined)?.animate?.([
    { transform: 'scale(1)', filter: 'brightness(1)' },
    { transform: 'scale(1.6)', filter: loss ? 'brightness(0.7) saturate(0.4)' : 'brightness(1.8) drop-shadow(0 0 6px #ffd24a)', offset: 0.35 },
    { transform: 'scale(1)', filter: 'brightness(1)' },
  ], { duration: 360, easing: 'ease-out' });
}
