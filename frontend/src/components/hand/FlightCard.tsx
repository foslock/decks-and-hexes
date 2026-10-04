import { memo, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { Card } from '../../types/game';
import CardFull from '../CardFull';
import CardBack from '../CardBack';
import { CARD_H, CARD_W, runAnimation } from './cardMotion';

/** A card in the air between two places on screen. `K` tags what the flight
 *  is for, so the owner knows what to do when it lands. */
export interface Flight<K extends string = string> {
  key: string;
  kind: K;
  /** null → a card back. */
  card: Card | null;
  frames: Keyframe[];
  delay: number;
  duration: number;
  /** Turn the card over in flight: keyframes for a rotateY flipper (0deg =
   *  face up, 180deg = face down). */
  flipFrames?: Keyframe[];
  /** Where to flash when a played card lands on the board. */
  flashAt?: { x: number; y: number };
}

const FACE_STYLE: CSSProperties = { position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' };

/** Flipper keyframes turning a card over between `from` and `to` (0–1 of the flight). */
export function turnOver(faceUpAtStart: boolean, from = 0.25, to = 0.7): Keyframe[] {
  const a = faceUpAtStart ? 0 : 180;
  const b = faceUpAtStart ? 180 : 0;
  return [
    { offset: 0, transform: `perspective(900px) rotateY(${a}deg)` },
    { offset: from, transform: `perspective(900px) rotateY(${a}deg)` },
    { offset: to, transform: `perspective(900px) rotateY(${b}deg)` },
    { offset: 1, transform: `perspective(900px) rotateY(${b}deg)` },
  ];
}

/** Renders one flight (position: fixed — put it in a portal) and reports
 *  back when it lands. Its keyframes are fixed at launch. */
function FlightCardImpl<K extends string>({ flight, onDone }: { flight: Flight<K>; onDone: (f: Flight<K>) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const flipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let alive = true;
    const timing: KeyframeAnimationOptions = { duration: flight.duration, delay: flight.delay, easing: 'linear', fill: 'both' };
    const runs = [runAnimation(ref.current, flight.frames, timing)];
    if (flight.flipFrames) runs.push(runAnimation(flipRef.current, flight.flipFrames, { ...timing, easing: 'ease-in-out' }));
    Promise.all(runs).then(() => { if (alive) onDone(flight); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} style={{
      position: 'fixed',
      left: 0,
      top: 0,
      width: CARD_W,
      height: CARD_H,
      pointerEvents: 'none',
      zIndex: 9990,
      transform: String(flight.frames[0]?.transform ?? ''),
      opacity: Number(flight.frames[0]?.opacity ?? 1),
      willChange: 'transform, opacity',
    }}>
      {flight.flipFrames && flight.card ? (
        <div ref={flipRef} style={{ position: 'relative', width: '100%', height: '100%', transformStyle: 'preserve-3d', transform: String(flight.flipFrames[0].transform) }}>
          <div style={FACE_STYLE}><CardFull card={flight.card} artZoom={false} /></div>
          <div style={{ ...FACE_STYLE, transform: 'rotateY(180deg)' }}><CardBack /></div>
        </div>
      ) : flight.card ? <CardFull card={flight.card} artZoom={false} /> : <CardBack />}
    </div>
  );
}

const FlightCard = memo(FlightCardImpl) as typeof FlightCardImpl;
export default FlightCard;
