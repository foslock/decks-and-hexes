import { createPortal } from 'react-dom';

export type ArrowState = 'valid' | 'invalid' | 'neutral';

const COLORS: Record<ArrowState, { stroke: string; glow: string }> = {
  valid: { stroke: '#8dffb0', glow: 'rgba(80, 255, 140, 0.55)' },
  invalid: { stroke: '#ff7a7a', glow: 'rgba(255, 80, 80, 0.5)' },
  neutral: { stroke: '#ffe08a', glow: 'rgba(255, 210, 100, 0.5)' },
};

/**
 * The aiming line shown while a card is dragged out of the hand: a dashed
 * curve that rises from the card and bends over to the pointer, ending in
 * an arrowhead (and a pulsing reticle over a valid target). Dashes march
 * toward the target. Green over a legal target, red over an illegal one,
 * gold when the card doesn't need a target.
 */
export default function TargetArrow({ from, to, state }: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  state: ArrowState;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Rise straight up out of the card, then bend toward the target.
  const c1 = { x: from.x + dx * 0.05, y: from.y - Math.min(240, Math.max(60, dist * 0.55)) };
  const c2 = { x: to.x - dx * 0.25, y: to.y - Math.min(120, dist * 0.18) };
  // Stop the line a little short so the arrowhead caps it cleanly.
  const angle = Math.atan2(to.y - c2.y, to.x - c2.x);
  const headLen = 22;
  const end = { x: to.x - Math.cos(angle) * headLen * 0.55, y: to.y - Math.sin(angle) * headLen * 0.55 };
  const d = `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
  const { stroke, glow } = COLORS[state];
  const head = [
    [to.x, to.y],
    [to.x - Math.cos(angle - 0.48) * headLen, to.y - Math.sin(angle - 0.48) * headLen],
    [to.x - Math.cos(angle) * headLen * 0.62, to.y - Math.sin(angle) * headLen * 0.62],
    [to.x - Math.cos(angle + 0.48) * headLen, to.y - Math.sin(angle + 0.48) * headLen],
  ].map(p => p.join(',')).join(' ');

  return createPortal(
    <svg
      aria-hidden
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 9998, overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="cc-arrow-fade" gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
          <stop offset="0" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="0.35" stopColor={stroke} stopOpacity="0.9" />
          <stop offset="1" stopColor={stroke} stopOpacity="1" />
        </linearGradient>
        <filter id="cc-arrow-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      {/* Soft glow under the line */}
      <path d={d} fill="none" stroke={glow} strokeWidth={12} strokeLinecap="round" filter="url(#cc-arrow-glow)" opacity={0.7} />
      {/* Dark outline keeps the dashes legible over bright terrain */}
      <path d={d} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={9} strokeLinecap="round" strokeDasharray="14 10"
        style={{ animation: 'cc-arrow-march 0.55s linear infinite' }} />
      <path d={d} fill="none" stroke="url(#cc-arrow-fade)" strokeWidth={5.5} strokeLinecap="round" strokeDasharray="14 10"
        style={{ animation: 'cc-arrow-march 0.55s linear infinite' }} />
      {state === 'valid' && (
        <g style={{ transformOrigin: `${to.x}px ${to.y}px`, animation: 'cc-reticle-pulse 0.9s ease-in-out infinite' }}>
          <circle cx={to.x} cy={to.y} r={17} fill="none" stroke={stroke} strokeWidth={2.5} opacity={0.9} />
          <circle cx={to.x} cy={to.y} r={25} fill="none" stroke={stroke} strokeWidth={1.2} opacity={0.45} />
        </g>
      )}
      <polygon points={head} fill={stroke} stroke="rgba(0,0,0,0.6)" strokeWidth={2} strokeLinejoin="round" />
    </svg>,
    document.body,
  );
}
