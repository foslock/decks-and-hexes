import { useState, useEffect, useRef } from 'react';
import { useAnimationMode } from './SettingsContext';

interface PhaseBannerProps {
  phase: string;
  /** Override the phase label text (e.g. "Begin!" instead of "Plan"). */
  labelOverride?: string;
  /** Optional smaller text shown below the phase label. */
  subtitle?: string;
  /** Called when the banner reaches its midpoint (50% through animation). */
  onMidpoint?: () => void;
  /** Called when the banner animation fully completes and is dismissed. */
  onComplete: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  upkeep: 'Upkeep',
  play: 'Play',
  reveal: 'Resolve',
  buy: 'Buy',
};

/**
 * Full-window translucent banner that slides in from left, holds at center,
 * then exits right. Used to announce phase transitions.
 *
 * Normal: full slide animation (~1.4s total).
 * Fast: same slide animation at 2x speed (~0.7s total).
 * Off: instant appear/disappear, no motion.
 */
export default function PhaseBanner({ phase, labelOverride, subtitle, onMidpoint, onComplete }: PhaseBannerProps) {
  const animMode = useAnimationMode();
  // Stages: 'mount' (initial position, no transition) → 'enter' (slide/fade in)
  //       → 'hold' (pause at center) → 'exit' (slide/fade out) → done
  const [stage, setStage] = useState<'mount' | 'enter' | 'hold' | 'exit'>('mount');
  const midpointFiredRef = useRef(false);

  const label = labelOverride || PHASE_LABELS[phase] || phase;

  // Stable refs for callbacks — prevents effect cleanup from cancelling
  // pending timeouts when parent re-renders (e.g. from WebSocket updates)
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onMidpointRef = useRef(onMidpoint);
  onMidpointRef.current = onMidpoint;

  const isOff = animMode === 'off';
  const speed = animMode === 'fast' ? 0.5 : 1;
  const enterMs = isOff ? 0 : Math.round(350 * speed);
  const holdMs = isOff ? 1400 : Math.round(700 * speed);
  const exitMs = isOff ? 0 : Math.round(350 * speed);

  // mount → enter: trigger the slide-in on the next frame so the browser
  // paints the start position first, then the CSS transition kicks in.
  useEffect(() => {
    if (stage !== 'mount') return;
    const raf = requestAnimationFrame(() => {
      // Double-rAF ensures the browser has actually painted the initial position
      requestAnimationFrame(() => setStage('enter'));
    });
    return () => cancelAnimationFrame(raf);
  }, [stage]);

  // enter → hold: wait for the slide-in transition to finish
  useEffect(() => {
    if (stage !== 'enter') return;
    const t = setTimeout(() => setStage('hold'), enterMs);
    return () => clearTimeout(t);
  }, [stage, enterMs]);

  // Fire midpoint callback when reaching hold
  useEffect(() => {
    if (stage === 'hold' && !midpointFiredRef.current) {
      midpointFiredRef.current = true;
      onMidpointRef.current?.();
    }
  }, [stage]);

  // hold → exit
  useEffect(() => {
    if (stage !== 'hold') return;
    const t = setTimeout(() => setStage('exit'), holdMs);
    return () => clearTimeout(t);
  }, [stage, holdMs]);

  // exit → complete
  useEffect(() => {
    if (stage !== 'exit') return;
    const t = setTimeout(() => onCompleteRef.current(), exitMs);
    return () => clearTimeout(t);
  }, [stage, exitMs]);

  // Compute visual properties per stage
  let transform: string;
  let opacity: number;
  let transition: string;

  if (isOff) {
    // Off: appear/disappear instantly at center, no motion
    transform = 'translate(-50%, -50%)';
    opacity = (stage === 'mount' || stage === 'exit') ? 0 : 1;
    transition = 'none';
  } else {
    // Normal / Fast: slide left → center → right (fast uses shorter durations)
    switch (stage) {
      case 'mount':
        transform = 'translate(-100%, -50%)';
        opacity = 1;
        transition = 'none';
        break;
      case 'enter':
        transform = 'translate(-50%, -50%)';
        opacity = 1;
        transition = `transform ${enterMs}ms cubic-bezier(0.0, 0.0, 0.15, 1.0)`;
        break;
      case 'hold':
        transform = 'translate(-50%, -50%)';
        opacity = 1;
        transition = 'none';
        break;
      case 'exit':
        transform = 'translate(0%, -50%)';
        opacity = 0;
        transition = `transform ${exitMs}ms cubic-bezier(0.85, 0.0, 1.0, 1.0), opacity ${exitMs}ms cubic-bezier(0.85, 0.0, 1.0, 1.0)`;
        break;
    }
  }

  // Backdrop fades in during enter, out during exit
  const backdropOpacity = (stage === 'enter' || stage === 'hold') ? 0.6 : 0;
  const backdropTransition = stage === 'mount' ? 'none' : `opacity ${stage === 'exit' ? exitMs : enterMs}ms ease`;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 30000,
      pointerEvents: 'auto',
    }}>
      {/* Semi-transparent backdrop */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        opacity: backdropOpacity,
        transition: backdropTransition,
      }} />

      {/* Banner text */}
      <div style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform,
        transition,
        opacity,
        background: 'linear-gradient(90deg, transparent, rgba(20, 20, 40, 0.85) 20%, rgba(20, 20, 40, 0.85) 80%, transparent)',
        padding: '20px 120px',
        whiteSpace: 'nowrap',
      }}>
        <div style={{
          fontSize: 42,
          fontWeight: 'bold',
          color: '#fff',
          textAlign: 'center',
          textTransform: 'uppercase',
          letterSpacing: 8,
          textShadow: '0 0 20px rgba(74, 158, 255, 0.6), 0 2px 8px rgba(0,0,0,0.8)',
        }}>
          {label}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 16,
            color: '#ffcc66',
            textAlign: 'center',
            marginTop: 6,
            letterSpacing: 2,
            textShadow: '0 1px 6px rgba(0,0,0,0.8)',
          }}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
