import { useState, useEffect, useRef, useCallback } from 'react';
import type { ResolutionStep } from '../types/game';
import { type GridTransform, PLAYER_COLORS } from './HexGrid';
import { useAnimationMode, useAnimationSpeed } from './SettingsContext';
import { useSound } from '../audio/useSound';

// Must match HexGrid.tsx
const HEX_SIZE = 32;

function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, y };
}

/** Convert numeric PLAYER_COLORS entry to CSS hex string. */
function playerColorStr(playerId: string): string {
  const n = PLAYER_COLORS[playerId];
  return n != null ? `#${n.toString(16).padStart(6, '0')}` : '#fff';
}

interface ResolveOverlayProps {
  steps: ResolutionStep[];
  gridTransform: GridTransform | null;
  gridRect: DOMRect | null;
  /** Called when a step finishes its winner_grow phase (tile should change color). */
  onStepApply?: (stepIndex: number) => void;
  /** Called after all steps have been animated. */
  onComplete: () => void;
}

interface ActiveNumber {
  playerId: string;
  power: number;
  // Start position (source tile screen coords)
  startX: number;
  startY: number;
  // End position (contested tile screen coords)
  endX: number;
  endY: number;
  isWinner: boolean;
}

type StepStage = 'numbers_move' | 'winner_grow' | 'done';

/**
 * Overlay rendered on top of the hex grid that animates resolution steps
 * one-by-one: power numbers fly in from source tiles, bounce at the center,
 * then the winner's number grows while losers fade.
 */
export default function ResolveOverlay({ steps, gridTransform, gridRect, onStepApply, onComplete }: ResolveOverlayProps) {
  const animMode = useAnimationMode();
  const isOff = animMode === 'off';
  const animSpeed = useAnimationSpeed();
  const sound = useSound();

  const [currentIdx, setCurrentIdx] = useState(0);
  const [stage, setStage] = useState<StepStage>('numbers_move');
  const [numbersActive, setNumbersActive] = useState(false);
  const completedRef = useRef(false);
  const appliedStepsRef = useRef(new Set<number>());

  // Stable refs for callbacks — prevents effect cleanup from cancelling
  // pending timeouts when parent re-renders (e.g. from WebSocket updates)
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onStepApplyRef = useRef(onStepApply);
  onStepApplyRef.current = onStepApply;

  const step = steps[currentIdx] as ResolutionStep | undefined;

  // Convert hex coords to screen coords
  const toScreen = useCallback((q: number, r: number) => {
    if (!gridTransform || !gridRect) return { x: 0, y: 0 };
    const local = axialToPixel(q, r);
    return {
      x: local.x * gridTransform.scale + gridTransform.offsetX + gridRect.left,
      y: local.y * gridTransform.scale + gridTransform.offsetY + gridRect.top,
    };
  }, [gridTransform, gridRect]);

  // Build the numbers for current step
  const numbers: ActiveNumber[] = [];
  if (step && gridTransform && gridRect) {
    const target = toScreen(step.q, step.r);

    for (const claimant of step.claimants) {
      const srcQ = claimant.source_q ?? step.q;
      const srcR = claimant.source_r ?? step.r;
      const src = toScreen(srcQ, srcR);
      numbers.push({
        playerId: claimant.player_id,
        power: claimant.power,
        startX: src.x,
        startY: src.y,
        endX: target.x,
        endY: target.y,
        isWinner: claimant.player_id === step.winner_id,
      });
    }
    // If there's a defender who wasn't in claimants, add their number
    if (step.defender_id && step.defender_power > 0 && !step.claimants.some(c => c.player_id === step.defender_id)) {
      const defSrc = toScreen(step.q, step.r);
      numbers.push({
        playerId: step.defender_id,
        power: step.defender_power,
        startX: defSrc.x,
        startY: defSrc.y,
        endX: target.x,
        endY: target.y,
        isWinner: step.defender_id === step.winner_id,
      });
    }
  }

  const isContested = step?.contested && numbers.length > 1;

  // Timing
  const moveMs = isOff ? 0 : Math.round((isContested ? 800 : 400) * animSpeed);
  const growMs = isOff ? 0 : Math.round((isContested ? 1200 : 400) * animSpeed);
  const pauseMs = isOff ? 50 : Math.round(200 * animSpeed);

  const hasPositionData = !!(gridTransform && gridRect);

  const fireStepApply = useCallback((idx: number) => {
    if (appliedStepsRef.current.has(idx)) return;
    appliedStepsRef.current.add(idx);
    onStepApplyRef.current?.(idx);
  }, []);

  // Trigger number movement after mount (wait for position data before starting)
  useEffect(() => {
    if (!step) return;
    if (isOff) {
      // Off mode: apply tile change immediately, then advance
      fireStepApply(currentIdx);
      const t = setTimeout(() => setStage('done'), pauseMs);
      return () => clearTimeout(t);
    }
    if (!hasPositionData) return; // wait until grid transform is available
    // Activate numbers (triggers CSS transition)
    const raf = requestAnimationFrame(() => setNumbersActive(true));
    return () => cancelAnimationFrame(raf);
  }, [currentIdx, step, isOff, pauseMs, fireStepApply, hasPositionData]);

  // Stage transitions
  useEffect(() => {
    if (!step) return;
    if (isOff) return; // handled above
    if (!hasPositionData) return;

    if (stage === 'numbers_move' && numbersActive) {
      fireStepApply(currentIdx);
      if (isContested) sound.resolveContested(); else sound.resolveTileOccupied();
      const t = setTimeout(() => setStage('winner_grow'), moveMs);
      return () => clearTimeout(t);
    }
    if (stage === 'winner_grow') {
      const t = setTimeout(() => setStage('done'), growMs);
      return () => clearTimeout(t);
    }
  }, [stage, numbersActive, step, moveMs, growMs, isOff, currentIdx, fireStepApply, hasPositionData]);

  // Advance to next step or complete
  useEffect(() => {
    if (stage !== 'done') return;
    if (completedRef.current) return;

    const nextIdx = currentIdx + 1;
    if (nextIdx >= steps.length) {
      completedRef.current = true;
      const t = setTimeout(() => onCompleteRef.current(), pauseMs);
      return () => clearTimeout(t);
    }

    const t = setTimeout(() => {
      setCurrentIdx(nextIdx);
      setStage('numbers_move');
      setNumbersActive(false);
    }, pauseMs);
    return () => clearTimeout(t);
  }, [stage, currentIdx, steps.length, pauseMs]);

  // Nothing to render if off mode or no steps
  if (!step || isOff || !gridTransform || !gridRect) return null;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 500,
    }}>
      {/* Power numbers */}
      {numbers.map((num, i) => {
        const color = playerColorStr(num.playerId);
        const isWinStage = stage === 'winner_grow';

        // Position calculation
        let x: number, y: number;
        let opacity = 1;
        let scale = 1;
        let transition: string;

        {
          // Numbers fly from source tile to target (speed-scaled)
          if (!numbersActive) {
            x = num.startX;
            y = num.startY;
            opacity = 0;
            scale = 0.5;
          } else if (stage === 'numbers_move') {
            // Move toward target, spread around it
            const angle = (i / numbers.length) * Math.PI * 2 - Math.PI / 2;
            const radius = isContested ? 25 : 0;
            x = num.endX + Math.cos(angle) * radius;
            y = num.endY + Math.sin(angle) * radius;
            scale = 1;
          } else if (isWinStage) {
            if (num.isWinner) {
              x = num.endX;
              y = num.endY;
              scale = 1.8;
            } else {
              const angle = (i / numbers.length) * Math.PI * 2 - Math.PI / 2;
              x = num.endX + Math.cos(angle) * 25;
              y = num.endY + Math.sin(angle) * 25;
              opacity = 0;
              scale = 0.5;
            }
          } else {
            x = num.endX;
            y = num.endY;
          }
          transition = stage === 'numbers_move'
            ? `all ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.2)`
            : `all ${growMs}ms ease-out`;
        }

        return (
          <div
            key={`${num.playerId}-${i}`}
            style={{
              position: 'fixed',
              left: x,
              top: y,
              transform: `translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              fontSize: 18,
              fontWeight: 'bold',
              color,
              WebkitTextStroke: '2.5px rgba(255,255,255,0.9)',
              paintOrder: 'stroke fill',
              textShadow: `0 0 8px ${color}, 0 2px 4px rgba(0,0,0,0.8)`,
              zIndex: num.isWinner && isWinStage ? 502 : 501,
              whiteSpace: 'nowrap',
            }}
          >
            {num.power}
          </div>
        );
      })}

      {/* Tile highlight ring removed — chevrons provide directional context */}
    </div>
  );
}
