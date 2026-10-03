import { useState, useEffect, useRef } from 'react';
import { useAnimationMode } from './SettingsContext';
import { useSound } from '../audio/useSound';

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
  /** When true, the banner holds at center until this prop becomes false. */
  holdUntilRelease?: boolean;
  /** Whether the banner blocks interaction with the page (default true). */
  blocking?: boolean;
  /** Extra milliseconds to add to the hold duration at center. */
  extraHoldMs?: number;
}

/** Accent glow behind the banner text, per phase. */
const PHASE_ACCENTS: Record<string, string> = {
  upkeep: '74, 158, 255',
  play: '232, 196, 106',
  reveal: '220, 70, 90',
  buy: '255, 170, 74',
};

const PHASE_LABELS: Record<string, string> = {
  upkeep: 'Upkeep',
  play: 'Play Cards',
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
export default function PhaseBanner({ phase, labelOverride, subtitle, onMidpoint, onComplete, holdUntilRelease, blocking = true, extraHoldMs = 0 }: PhaseBannerProps) {
  const animMode = useAnimationMode();
  // Stages: 'mount' (initial position, no transition) → 'enter' (slide/fade in)
  //       → 'hold' (pause at center) → 'exit' (slide/fade out) → done
  const [stage, setStage] = useState<'mount' | 'enter' | 'hold' | 'exit'>('mount');
  const midpointFiredRef = useRef(false);
  // Track whether hold was externally controlled (for shorter release delay)
  const wasHeldRef = useRef(false);

  const label = labelOverride || PHASE_LABELS[phase] || phase;
  const accent = PHASE_ACCENTS[phase] ?? PHASE_ACCENTS.play;

  // Stable refs for callbacks — prevents effect cleanup from cancelling
  // pending timeouts when parent re-renders (e.g. from WebSocket updates)
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onMidpointRef = useRef(onMidpoint);
  onMidpointRef.current = onMidpoint;

  const isOff = animMode === 'off';
  const speed = animMode === 'fast' ? 0.5 : 1;
  const enterMs = isOff ? 0 : Math.round(350 * speed);
  const holdMs = isOff ? 1400 : Math.round(700 * speed) + Math.round(extraHoldMs * speed);
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

  // Swell as the ribbon sweeps in. Banners with a custom label (e.g. the
  // match-start "Begin!") already have their own jingle.
  const sound = useSound();
  const soundRef = useRef(sound);
  soundRef.current = sound;
  useEffect(() => {
    if (stage === 'enter' && !labelOverride) soundRef.current.phaseChange();
  }, [stage, labelOverride]);

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

  // Track when hold is externally controlled
  useEffect(() => {
    if (stage === 'hold' && holdUntilRelease) {
      wasHeldRef.current = true;
    }
  }, [stage, holdUntilRelease]);

  // hold → exit (respects holdUntilRelease)
  useEffect(() => {
    if (stage !== 'hold') return;
    if (holdUntilRelease) return; // Don't advance while externally held
    // If released from external hold, use a shorter delay before exiting
    const delay = wasHeldRef.current ? Math.round(100 * speed) : holdMs;
    const t = setTimeout(() => setStage('exit'), delay);
    return () => clearTimeout(t);
  }, [stage, holdMs, holdUntilRelease, speed]);

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
    // Normal / Fast: fade in from small left offset, fade out to small right offset
    switch (stage) {
      case 'mount':
        transform = 'translate(calc(-50% - 30px), -50%) scale(1.06)';
        opacity = 0;
        transition = 'none';
        break;
      case 'enter':
        transform = 'translate(-50%, -50%)';
        opacity = 1;
        transition = `transform ${enterMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${enterMs}ms ease-out`;
        break;
      case 'hold':
        transform = 'translate(-50%, -50%)';
        opacity = 1;
        transition = 'none';
        break;
      case 'exit':
        transform = 'translate(calc(-50% + 30px), -50%) scale(0.98)';
        opacity = 0;
        transition = `transform ${exitMs}ms ease-in, opacity ${exitMs}ms ease-in`;
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
      pointerEvents: blocking ? 'auto' : 'none',
    }}>
      {/* Semi-transparent backdrop */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0.15), rgba(0,0,0,0.45))',
        opacity: backdropOpacity,
        transition: backdropTransition,
      }} />

      {/* Banner ribbon */}
      <div style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform,
        transition,
        opacity,
        width: 'min(960px, 100vw)',
        background:
          `radial-gradient(ellipse 45% 90% at 50% 50%, rgba(${accent}, 0.22), rgba(${accent}, 0) 70%),` +
          'linear-gradient(90deg, transparent, rgba(14, 14, 34, 0.9) 18%, rgba(14, 14, 34, 0.9) 82%, transparent)',
        padding: 'clamp(14px, 3vw, 22px) clamp(24px, 8vw, 120px)',
        whiteSpace: 'nowrap',
        textAlign: 'center',
      }}>
        {/* Gold hairlines framing the ribbon */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, background: 'linear-gradient(90deg, transparent, rgba(232,196,106,0.85) 50%, transparent)' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, background: 'linear-gradient(90deg, transparent, rgba(232,196,106,0.85) 50%, transparent)' }} />
        <div style={{
          display: 'inline-block',
          fontSize: 'clamp(26px, 6vw, 46px)',
          fontFamily: 'var(--cc-font-display)',
          fontWeight: 900,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          paddingLeft: '0.18em', // balance the trailing letter-spacing
          background: 'linear-gradient(180deg, #fff6d6 0%, #f3d27e 48%, #b8862e 100%)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          filter: `drop-shadow(0 2px 0 rgba(0,0,0,0.6)) drop-shadow(0 0 16px rgba(${accent}, 0.45))`,
        }}>
          {label}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 'clamp(12px, 2.4vw, 16px)',
            color: '#e9dcc0',
            marginTop: 6,
            letterSpacing: 3,
            textTransform: 'uppercase',
            textShadow: '0 1px 6px rgba(0,0,0,0.8)',
          }}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
