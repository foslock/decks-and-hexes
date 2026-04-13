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
  /** Ref to the grid container element — used for live rect measurement */
  gridContainerRef?: React.RefObject<HTMLDivElement | null>;
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
  isDefender: boolean;
}

type StepStage = 'numbers_move' | 'winner_grow' | 'done';

/**
 * Overlay rendered on top of the hex grid that animates resolution steps
 * one-by-one: power numbers fly in from source tiles, bounce at the center,
 * then the winner's number grows while losers fade.
 */
export default function ResolveOverlay({ steps, gridTransform, gridRect, gridContainerRef, onStepApply, onComplete }: ResolveOverlayProps) {
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

  // Convert hex coords to screen coords (uses live DOM measurement for accuracy)
  const toScreen = useCallback((q: number, r: number) => {
    if (!gridTransform) return { x: 0, y: 0 };
    // Prefer live DOM rect for accuracy; fall back to prop
    const rect = gridContainerRef?.current?.getBoundingClientRect() ?? gridRect;
    if (!rect) return { x: 0, y: 0 };
    const local = axialToPixel(q, r);
    // Rotation-aware: apply pivot-based transform
    const relX = (local.x - gridTransform.pivotX) * gridTransform.scale;
    const relY = (local.y - gridTransform.pivotY) * gridTransform.scale;
    const cos = Math.cos(gridTransform.rotation);
    const sin = Math.sin(gridTransform.rotation);
    return {
      x: relX * cos - relY * sin + rect.width / 2 + rect.left,
      y: relX * sin + relY * cos + rect.height / 2 + rect.top,
    };
  }, [gridTransform, gridRect, gridContainerRef]);

  // Build the numbers for current step
  const numbers: ActiveNumber[] = [];
  if (step && gridTransform && gridRect) {
    const target = toScreen(step.q, step.r);

    // Group claimants by player — stacked claims render one combined power number.
    // power_by_player is already the combined total, so we just deduplicate.
    const grouped = new Map<string, { power: number; sourceQ: number; sourceR: number }>();
    for (const claimant of step.claimants) {
      if (!grouped.has(claimant.player_id)) {
        grouped.set(claimant.player_id, {
          power: claimant.power,
          sourceQ: claimant.source_q ?? step.q,
          sourceR: claimant.source_r ?? step.r,
        });
      }
    }
    for (const [playerId, info] of grouped) {
      const src = toScreen(info.sourceQ, info.sourceR);
      numbers.push({
        playerId,
        power: info.power,
        startX: src.x,
        startY: src.y,
        endX: target.x,
        endY: target.y,
        isWinner: playerId === step.winner_id,
        isDefender: playerId === step.defender_id,
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
        isDefender: true,
      });
    }
  }

  const isConsecrate = step?.outcome === 'consecrate';
  const isDefenseApplied = step?.outcome === 'defense_applied';
  const isAutoClaim = step?.outcome === 'auto_claim';
  const isContested = !isConsecrate && !isDefenseApplied && !isAutoClaim && step?.contested && numbers.length > 1;

  // Timing
  const moveMs = isOff ? 0 : Math.round((isAutoClaim ? 600 : isDefenseApplied ? 300 : isConsecrate ? 600 : isContested ? 800 : 400) * animSpeed);
  const growMs = isOff ? 0 : Math.round((isAutoClaim ? 400 : isDefenseApplied ? 400 : isConsecrate ? 800 : isContested ? 1200 : 400) * animSpeed);
  const pauseMs = isOff ? 50 : Math.round((isDefenseApplied ? 100 : 200) * animSpeed);

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
      if (isDefenseApplied) {
        sound.resolveDefenseFortify();
      } else if (isContested) {
        sound.resolveContested();
      } else {
        sound.resolveTileOccupied();
      }
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
      {/* Defense applied animation — shield values grow/shrink */}
      {isDefenseApplied && step && (() => {
        const target = toScreen(step.q, step.r);
        const permDef = step.defense_permanent ?? 0;
        const tempDef = step.defense_temporary ?? 0;
        const color = step.winner_id ? playerColorStr(step.winner_id) : '#fff';
        let scale = 0;
        let opacity = 0;
        let transition: string;
        if (!numbersActive) {
          scale = 0.3;
          opacity = 0;
          transition = 'none';
        } else if (stage === 'numbers_move') {
          scale = 1.6;
          opacity = 1;
          transition = `all ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.2)`;
        } else if (stage === 'winner_grow') {
          scale = 1;
          opacity = 1;
          transition = `all ${growMs}ms cubic-bezier(0.3, 0, 0.2, 1)`;
        } else {
          scale = 1;
          opacity = 0;
          transition = `opacity ${pauseMs}ms ease`;
        }
        return (
          <div
            key="defense-shield"
            style={{
              position: 'fixed',
              left: target.x,
              top: target.y,
              transform: `translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              fontSize: 22,
              fontWeight: 'bold',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 502,
              textShadow: `0 0 8px ${color}, 0 2px 4px rgba(0,0,0,0.8)`,
            }}
          >
            <span style={{ color: '#fff' }}>🛡{permDef}</span>
            {step.defense_immunity
              ? <span style={{ color: '#66ccff' }}>+∞</span>
              : tempDef > 0 && <span style={{ color: '#66ccff' }}>+{tempDef}</span>}
          </div>
        );
      })()}

      {/* Consecrate star animation */}
      {isConsecrate && step && (() => {
        const target = toScreen(step.q, step.r);
        const color = step.winner_id ? playerColorStr(step.winner_id) : '#ffd700';
        // Star starts invisible, grows large during numbers_move, shrinks to rest during winner_grow
        let scale = 0;
        let opacity = 0;
        let transition: string;
        if (!numbersActive) {
          scale = 0;
          opacity = 0;
          transition = 'none';
        } else if (stage === 'numbers_move') {
          scale = 2.5;
          opacity = 1;
          transition = `all ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.1)`;
        } else if (stage === 'winner_grow') {
          scale = 1;
          opacity = 1;
          transition = `all ${growMs}ms cubic-bezier(0.3, 0, 0.2, 1)`;
        } else {
          scale = 1;
          opacity = 0;
          transition = `opacity ${pauseMs}ms ease`;
        }
        return (
          <div
            key="consecrate-star"
            style={{
              position: 'fixed',
              left: target.x,
              top: target.y,
              transform: `translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              fontSize: 28,
              color: '#ffd700',
              textShadow: `0 0 12px ${color}, 0 0 24px rgba(255, 215, 0, 0.6), 0 2px 4px rgba(0,0,0,0.8)`,
              zIndex: 502,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            ★
          </div>
        );
      })()}

      {/* Auto-claim animation — icon flies from source tile to auto-claimed tile */}
      {isAutoClaim && step && (() => {
        // Source is the Breakthrough target tile (where claim succeeded)
        const claimant = step.claimants[0];
        const srcQ = claimant?.source_q ?? step.q;
        const srcR = claimant?.source_r ?? step.r;
        const source = toScreen(srcQ, srcR);
        const target = toScreen(step.q, step.r);
        const color = step.winner_id ? playerColorStr(step.winner_id) : '#fff';

        let x = source.x;
        let y = source.y;
        let scale = 0.5;
        let opacity = 0;
        let transition: string;

        if (!numbersActive) {
          x = source.x;
          y = source.y;
          scale = 0.5;
          opacity = 0;
          transition = 'none';
        } else if (stage === 'numbers_move') {
          // Icon flies from source to target
          x = target.x;
          y = target.y;
          scale = 1.4;
          opacity = 1;
          transition = `all ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.1)`;
        } else if (stage === 'winner_grow') {
          // Settle at target
          x = target.x;
          y = target.y;
          scale = 1;
          opacity = 1;
          transition = `all ${growMs}ms cubic-bezier(0.3, 0, 0.2, 1)`;
        } else {
          x = target.x;
          y = target.y;
          scale = 1;
          opacity = 0;
          transition = `opacity ${pauseMs}ms ease`;
        }

        return (
          <div
            key="auto-claim-icon"
            style={{
              position: 'fixed',
              left: x,
              top: y,
              transform: `translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              fontSize: 24,
              fontWeight: 'bold',
              color: '#fff',
              textShadow: `0 0 10px ${color}, 0 0 20px ${color}, 0 2px 4px rgba(0,0,0,0.8)`,
              zIndex: 502,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            ⚔
          </div>
        );
      })()}

      {/* Power numbers (skip for Consecrate, Defense Applied, Auto-claim — custom animations handle them) */}
      {!isConsecrate && !isDefenseApplied && !isAutoClaim && numbers.map((num, i) => {
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
            {num.isDefender ? '🛡' : '⚔'} {num.power}
          </div>
        );
      })}

      {/* Tile highlight ring removed — chevrons provide directional context */}
    </div>
  );
}
