import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card, SearchZoneTarget } from '../types/game';
import HandStyleCard, { HAND_CARD_WIDTH as COMPACT_CARD_WIDTH } from './HandStyleCard';
import { getCardDisplayColor } from '../constants/cardColors';

export interface SearchFlight {
  card: Card;
  sourceRect: DOMRect;
  targetKind: SearchZoneTarget;
  /**
   * Null for `trash` (tear in place) or when the target zone isn't in the DOM
   * for some reason. In the latter case the card fades out at its source.
   */
  targetRect: DOMRect | null;
}

export interface PileSearchFlyAnimationProps {
  flights: SearchFlight[];
  /** Multiplier applied to every duration. 0.5 matches fast mode. */
  speed?: number;
  /** Stagger between flights in ms (before speed multiplier). */
  staggerMs?: number;
  /** Fires after the final flight animation finishes. */
  onComplete: () => void;
}

const ARC_DUR_MS = 800;
const TRASH_DUR_MS = 500;

export default function PileSearchFlyAnimation({
  flights,
  speed = 1,
  staggerMs = 150,
  onComplete,
}: PileSearchFlyAnimationProps) {
  // Track which flights have kicked off their animation (controlled transition).
  const [activeMask, setActiveMask] = useState<boolean[]>(() => flights.map(() => false));
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const scaledStagger = Math.round(staggerMs * speed);
  const arcDur = Math.round(ARC_DUR_MS * speed);
  const trashDur = Math.round(TRASH_DUR_MS * speed);

  // Stagger kick-off: activate each flight at i * stagger ms
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < flights.length; i++) {
      const t = setTimeout(() => {
        setActiveMask((prev) => prev.map((v, j) => (j === i ? true : v)));
      }, i * scaledStagger);
      timers.push(t);
    }

    // Calculate total duration: last kick-off + its anim duration + buffer
    const lastKickoff = Math.max(0, (flights.length - 1) * scaledStagger);
    const longestDur = flights.some((f) => f.targetKind === 'trash') ? trashDur : arcDur;
    const lastFinish = lastKickoff + longestDur + 80;
    const doneTimer = setTimeout(() => onCompleteRef.current(), lastFinish);
    timers.push(doneTimer);

    return () => timers.forEach((t) => clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Precompute per-flight target center in viewport coordinates
  const flightTargets = useMemo(() => {
    return flights.map((f) => {
      if (!f.targetRect) return null;
      return {
        cx: f.targetRect.left + f.targetRect.width / 2,
        cy: f.targetRect.top + f.targetRect.height / 2,
      };
    });
  }, [flights]);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 31000,
      }}
    >
      {flights.map((flight, idx) => {
        const isActive = activeMask[idx];
        const { card, sourceRect, targetKind } = flight;
        const color = getCardDisplayColor(card);

        // Source center (where the card sits in the modal)
        const srcCx = sourceRect.left + sourceRect.width / 2;
        const srcCy = sourceRect.top + sourceRect.height / 2;

        // The compact card rendered in the modal may have been sized to the
        // source rect; we re-render at compact width and scale to match.
        const cardScale = sourceRect.width / COMPACT_CARD_WIDTH;

        if (targetKind === 'trash') {
          // Tear animation: card splits, halves rotate outward and rise, then fade
          const halfW = sourceRect.width / 2;
          const dy = isActive ? -120 : 0;
          const fadeDelay = Math.round(trashDur * 0.4);
          const fadeDur = trashDur - fadeDelay;
          return (
            <div key={`tear-${idx}`}>
              <div
                style={{
                  position: 'fixed',
                  left: sourceRect.left,
                  top: sourceRect.top,
                  width: halfW,
                  height: sourceRect.height,
                  overflow: 'hidden',
                  transform: isActive
                    ? `translate(-10px, ${dy}px) rotate(-10deg)`
                    : 'translate(0, 0) rotate(0deg)',
                  transformOrigin: 'right center',
                  opacity: isActive ? 0 : 1,
                  transition: isActive
                    ? `transform ${trashDur}ms ease-in, opacity ${fadeDur}ms ease-in ${fadeDelay}ms`
                    : 'none',
                  pointerEvents: 'none',
                  filter: `drop-shadow(0 4px 12px ${color}60)`,
                }}
              >
                <div
                  style={{
                    width: sourceRect.width,
                    transform: `scale(${cardScale})`,
                    transformOrigin: 'top left',
                  }}
                >
                  <HandStyleCard card={card} />
                </div>
              </div>
              <div
                style={{
                  position: 'fixed',
                  left: sourceRect.left + halfW,
                  top: sourceRect.top,
                  width: halfW,
                  height: sourceRect.height,
                  overflow: 'hidden',
                  transform: isActive
                    ? `translate(10px, ${dy}px) rotate(10deg)`
                    : 'translate(0, 0) rotate(0deg)',
                  transformOrigin: 'left center',
                  opacity: isActive ? 0 : 1,
                  transition: isActive
                    ? `transform ${trashDur}ms ease-in, opacity ${fadeDur}ms ease-in ${fadeDelay}ms`
                    : 'none',
                  pointerEvents: 'none',
                  filter: `drop-shadow(0 4px 12px ${color}60)`,
                }}
              >
                <div
                  style={{
                    width: sourceRect.width,
                    marginLeft: -halfW,
                    transform: `scale(${cardScale})`,
                    transformOrigin: 'top left',
                  }}
                >
                  <HandStyleCard card={card} />
                </div>
              </div>
            </div>
          );
        }

        // Arc animation toward target zone
        const target = flightTargets[idx];
        if (!target) {
          // No target — fade out in place
          return (
            <div
              key={`fade-${idx}`}
              style={{
                position: 'fixed',
                left: sourceRect.left,
                top: sourceRect.top,
                width: sourceRect.width,
                opacity: isActive ? 0 : 1,
                transition: isActive ? `opacity ${arcDur}ms ease-in` : 'none',
                filter: `drop-shadow(0 4px 12px ${color}60)`,
              }}
            >
              <div style={{ transform: `scale(${cardScale})`, transformOrigin: 'top left' }}>
                <HandStyleCard card={card} />
              </div>
            </div>
          );
        }

        const dx = target.cx - srcCx;
        const dy = target.cy - srcCy;
        // Target scale: shrink on landing (same as debt fly / discard arc)
        const targetScale = 0.55;
        const fadeDelay = Math.round(arcDur * 0.9);
        const fadeDur = arcDur - fadeDelay;

        let transform = 'translate(0, 0) scale(1) rotate(0deg)';
        let opacity = 1;
        let transition = 'none';

        if (isActive) {
          transform = `translate(${dx}px, ${dy}px) scale(${targetScale}) rotate(${
            dx > 0 ? 20 : -20
          }deg)`;
          opacity = 0;
          transition = `transform ${arcDur}ms cubic-bezier(0.4, 0.0, 0.2, 1), opacity ${fadeDur}ms ease-in ${fadeDelay}ms`;
        }

        return (
          <div
            key={`arc-${idx}`}
            style={{
              position: 'fixed',
              left: sourceRect.left,
              top: sourceRect.top,
              width: sourceRect.width,
              pointerEvents: 'none',
              transform,
              opacity,
              transition,
              transformOrigin: 'center',
              filter: `drop-shadow(0 4px 16px ${color}80)`,
              willChange: 'transform, opacity',
            }}
          >
            <div
              style={{
                transform: `scale(${cardScale})`,
                transformOrigin: 'top left',
                width: COMPACT_CARD_WIDTH,
              }}
            >
              <HandStyleCard card={card} />
            </div>
          </div>
        );
      })}
    </div>,
    document.body
  );
}
