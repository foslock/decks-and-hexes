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

/** Darkened variant of a player's color — used for number fill so it's readable against the
 *  (same-colored) wedge background while still hinting at who the number belongs to. */
function playerColorDark(playerId: string, factor = 0.35): string {
  const n = PLAYER_COLORS[playerId];
  if (n == null) return '#000';
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}


interface ResolveOverlayProps {
  steps: ResolutionStep[];
  gridTransform: GridTransform | null;
  gridRect: DOMRect | null;
  /** Ref to the grid container element — used for live rect measurement */
  gridContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Optional ref to the *live* grid transform. When provided, the overlay reads the
   *  current transform on every render instead of using the snapshotted `gridTransform`
   *  prop — this keeps animations aligned with the hex grid even when the grid
   *  re-lays out (scale/pivot change) between resolve start and overlay render
   *  (e.g. after a banner dismiss resizes the container). */
  gridTransformRef?: React.RefObject<GridTransform | null>;
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
export default function ResolveOverlay({ steps, gridTransform: gridTransformProp, gridRect, gridContainerRef, gridTransformRef, onStepApply, onComplete }: ResolveOverlayProps) {
  // Prefer the live grid transform when available. The snapshot can go stale
  // if the grid container re-lays out between resolve start and when the
  // overlay actually renders (banner dismiss, chevron reveal finishing, window
  // resize). Live values match whatever pixi just rendered.
  const gridTransform = gridTransformRef?.current ?? gridTransformProp;
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
  /** Wedge battle: attackers animate triangular wedges from their approach edge inward.
   *  Covers neutral claims (no defender) AND contested/uncontested claims on owned tiles.
   *  The defender (if any) does not get a wedge — the tile is already their color. */
  const isWedgeBattle = !isConsecrate && !isDefenseApplied && !isAutoClaim
    && !!step && step.claimants.length > 0
    && (step.outcome === 'claimed' || step.outcome === 'defended' || step.outcome === 'tie' || step.outcome === 'defense_held');
  /** True when an attacker wins and the tile color will flip; false when the defender holds. */
  const attackerWins = !!step?.winner_id && step.winner_id !== step?.defender_id && step?.outcome === 'claimed';

  // Triangular wedges, one per attacker (defender gets no wedge). Each wedge is a triangle formed
  // by the two corners of the attacker's approach edge plus an apex that animates from the edge
  // midpoint to the hex center. Geometry is in the element's LOCAL pixel space (unrotated hex);
  // grid rotation is applied via CSS transform on each wedge element.
  const wedgeGeom = isWedgeBattle && step && gridTransform && gridRect ? (() => {
    // Group claimants by player (stackable claims combine to a single wedge)
    const grouped = new Map<string, { sourceQ: number; sourceR: number }>();
    for (const claimant of step.claimants) {
      if (!grouped.has(claimant.player_id)) {
        grouped.set(claimant.player_id, {
          sourceQ: claimant.source_q ?? step.q,
          sourceR: claimant.source_r ?? step.r,
        });
      }
    }

    const scale = gridTransform.scale;
    const hexRadius = HEX_SIZE * scale;              // center-to-corner
    const hexWidth = 2 * hexRadius;
    const hexHeight = Math.sqrt(3) * hexRadius;
    const cx = hexWidth / 2;
    const cy = hexHeight / 2;
    const inscribedR = hexRadius * Math.sqrt(3) / 2; // center-to-edge-midpoint

    // Flat-top hex corners at angles k*60°; edge midpoints at (k+0.5)*60° (k=0..5)
    const localCorner = (k: number) => {
      const a = (((k % 6) + 6) % 6) * Math.PI / 3;
      return { x: cx + hexRadius * Math.cos(a), y: cy + hexRadius * Math.sin(a) };
    };
    const localEdgeMid = (k: number) => {
      const a = ((((k % 6) + 6) % 6) + 0.5) * Math.PI / 3;
      return { x: cx + inscribedR * Math.cos(a), y: cy + inscribedR * Math.sin(a) };
    };

    // Assign each claimant to the hex edge closest to their approach direction. If two claimants
    // would map to the same edge (long-range claims), the second falls back to the next-closest.
    // Rotation — used to convert wedge local offsets to screen-space offsets for number positioning.
    const rot = gridTransform.rotation;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);

    const usedEdges = new Set<number>();
    const wedges: Array<{
      playerId: string;
      cornerA: { x: number; y: number };  // first corner of the attack edge (k*60°)
      cornerB: { x: number; y: number };  // second corner ((k+1)*60°)
      edgeMid: { x: number; y: number };  // midpoint of the attack edge (apex start)
      remaining: { x: number; y: number }[]; // 4 remaining hex corners, CCW from (k+2)..(k+5)
      /** Screen-space offset from hex center (target) to this wedge's edge midpoint, post-rotation. */
      edgeOffsetScreen: { dx: number; dy: number };
      isWinner: boolean;
    }> = [];

    for (const [playerId, info] of grouped) {
      const dq = info.sourceQ - step.q;
      const dr = info.sourceR - step.r;
      const local = axialToPixel(dq, dr);
      const approachAngle = Math.atan2(local.y, local.x);
      const candidates = [0, 1, 2, 3, 4, 5].map(k => {
        const mid = Math.PI / 6 + k * Math.PI / 3;
        // Circular distance: normalize to [0, 2π) before the [0, π] fold. Without the mod,
        // |approachAngle - mid| can exceed 2π and the fold produces a negative "distance"
        // that incorrectly wins as minimum — snapping the wrong edge.
        let d = Math.abs(approachAngle - mid) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        return { k, d };
      }).sort((a, b) => a.d - b.d);
      let edgeK = candidates[0].k;
      for (const c of candidates) {
        if (!usedEdges.has(c.k)) { edgeK = c.k; break; }
      }
      usedEdges.add(edgeK);

      const edgeMid = localEdgeMid(edgeK);
      // Local offset from element center → rotate into screen space
      const ox = edgeMid.x - cx;
      const oy = edgeMid.y - cy;

      wedges.push({
        playerId,
        cornerA: localCorner(edgeK),
        cornerB: localCorner(edgeK + 1),
        edgeMid,
        remaining: [2, 3, 4, 5].map(off => localCorner(edgeK + off)),
        edgeOffsetScreen: {
          dx: ox * cosR - oy * sinR,
          dy: ox * sinR + oy * cosR,
        },
        isWinner: playerId === step.winner_id,
      });
    }

    return { wedges, hexWidth, hexHeight, cx, cy };
  })() : null;

  // Defender phantom edge offset — the defender doesn't draw a wedge (the tile is already their
  // color), but we still need to know WHICH edge their wedge WOULD be on so the defense number
  // anchors to the side of the hex closest to the defender's territory.
  const defenderEdgeOffsetScreen = (() => {
    if (!step?.defender_id || !gridTransform) return null;
    if (step.defender_source_q == null || step.defender_source_r == null) return null;
    const dq = step.defender_source_q - step.q;
    const dr = step.defender_source_r - step.r;
    const local = axialToPixel(dq, dr);
    const approachAngle = Math.atan2(local.y, local.x);
    // Pick the hex edge nearest to the defender's approach direction (same snap logic as wedges).
    // Normalize to [0, 2π) before folding to [0, π]; see the wedge-snap comment for the why.
    let bestK = 0;
    let bestD = Infinity;
    for (let k = 0; k < 6; k++) {
      const mid = Math.PI / 6 + k * Math.PI / 3;
      let d = Math.abs(approachAngle - mid) % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < bestD) { bestD = d; bestK = k; }
    }
    const scale = gridTransform.scale;
    const inscribedR = HEX_SIZE * scale * Math.sqrt(3) / 2;
    const a = (bestK + 0.5) * Math.PI / 3;
    const ox = inscribedR * Math.cos(a);
    const oy = inscribedR * Math.sin(a);
    const rot = gridTransform.rotation;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    return { dx: ox * cosR - oy * sinR, dy: ox * sinR + oy * cosR };
  })();

  // Unified lookup for number positioning: each player (attacker or defender) maps to the
  // screen-space offset from hex center to the midpoint of their (real or phantom) wedge edge.
  const playerEdgeOffsets = new Map<string, { dx: number; dy: number }>();
  if (wedgeGeom) {
    for (const w of wedgeGeom.wedges) playerEdgeOffsets.set(w.playerId, w.edgeOffsetScreen);
  }
  if (defenderEdgeOffsetScreen && step?.defender_id) {
    playerEdgeOffsets.set(step.defender_id, defenderEdgeOffsetScreen);
  }

  // Timing
  // Contested claims get a per-extra-player delay boost so the audience has time to read the
  // incoming wedges before the winner grows (baseline tuned for 2 players; +120ms/player beyond that).
  const contestantCount = numbers.length;
  const contestedBoost = isContested ? Math.max(0, contestantCount - 2) * 120 : 0;
  const moveMs = isOff ? 0 : Math.round(((isAutoClaim ? 600 : isDefenseApplied ? 300 : isConsecrate ? 600 : isContested ? 800 : 400) + contestedBoost) * animSpeed);
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
      // Wedge battle: defer the tile-color flip until the winning wedge has fully engulfed the
      // hex (handled in the winner_grow branch below).
      if (!isWedgeBattle) fireStepApply(currentIdx);
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
      if (isWedgeBattle) {
        // Flip the tile background at the END of winner_grow — the instant the winning wedge
        // fully covers the hex. Defer the fade (stage='done') by two animation frames so React
        // commits the tile update BEFORE the overlay starts fading; otherwise the batched
        // commit + fade can race and flash the pre-battle color for a frame or two.
        let raf1 = 0, raf2 = 0;
        const applyT = setTimeout(() => {
          fireStepApply(currentIdx);
          raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => setStage('done'));
          });
        }, growMs);
        return () => { clearTimeout(applyT); cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
      }
      const t = setTimeout(() => setStage('done'), growMs);
      return () => clearTimeout(t);
    }
  }, [stage, numbersActive, step, moveMs, growMs, isOff, currentIdx, fireStepApply, hasPositionData, isWedgeBattle]);

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

      {/* Triangular-wedge claim animation — attackers only. Each wedge fills a triangle rooted on
          the attacker's approach edge; apex animates from edge midpoint → hex center simultaneously.
          Attacker-wins: winner's wedge expands to full hex, engulfing losers and flipping the tile.
          Defender-wins: all attacker wedges shrink back to their edges; tile color unchanged. */}
      {wedgeGeom && (() => {
        const target = toScreen(step.q, step.r);
        const rotationDeg = (gridTransform.rotation * 180) / Math.PI;
        const { wedges: ws, hexWidth, hexHeight, cx, cy } = wedgeGeom;
        const center = { x: cx, y: cy };
        // Each wedge's polygon is always expressed as 6 vertices so CSS can interpolate cleanly
        // between the keyframes: collapsed-to-edge → triangle-to-center → full-hex.
        const triangleCollapsed = (w: typeof ws[number]) => [w.cornerA, w.cornerB, w.edgeMid, w.edgeMid, w.edgeMid, w.edgeMid];
        const triangleToCenter  = (w: typeof ws[number]) => [w.cornerA, w.cornerB, center, center, center, center];
        const fullHex           = (w: typeof ws[number]) => [w.cornerA, w.cornerB, ...w.remaining];
        const polyStr = (pts: { x: number; y: number }[]) =>
          `polygon(${pts.map(p => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`).join(', ')})`;

        return ws.map((w, i) => {
          const color = playerColorStr(w.playerId);
          let clipPath: string;
          let transition: string;
          let opacity = 1;
          let zIndex = 499;

          if (!numbersActive) {
            clipPath = polyStr(triangleCollapsed(w));
            transition = 'none';
          } else if (stage === 'numbers_move') {
            clipPath = polyStr(triangleToCenter(w));
            transition = `clip-path ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1)`;
          } else if (stage === 'winner_grow') {
            if (w.isWinner) {
              // Winner grows triangle → full hex, painted above the losers so it engulfs them.
              clipPath = polyStr(fullHex(w));
              transition = `clip-path ${growMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
              zIndex = 500;
            } else {
              // All losers (attacker or defender outcome) — shrink the wedge back to its edge
              // in concert with the winner's expansion. Reads as the losers "retreating".
              clipPath = polyStr(triangleCollapsed(w));
              transition = `clip-path ${growMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
            }
          } else {
            // done: fade out overlay (tile has either been repainted to winner's color, or stayed as defender's).
            const finalShape = w.isWinner ? fullHex(w) : triangleCollapsed(w);
            clipPath = polyStr(finalShape);
            transition = `opacity ${pauseMs}ms ease`;
            opacity = 0;
            zIndex = w.isWinner ? 500 : 499;
          }

          return (
            <div
              key={`wedge-${w.playerId}-${i}`}
              style={{
                position: 'fixed',
                left: target.x,
                top: target.y,
                width: hexWidth,
                height: hexHeight,
                transform: `translate(-50%, -50%) rotate(${rotationDeg}deg)`,
                transformOrigin: 'center center',
                background: color,
                clipPath,
                opacity,
                transition,
                pointerEvents: 'none',
                zIndex,
              }}
            />
          );
        });
      })()}

      {/* Power numbers (skip for Consecrate, Defense Applied, Auto-claim — custom animations handle them) */}
      {!isConsecrate && !isDefenseApplied && !isAutoClaim && numbers.map((num, i) => {
        const haloColor = playerColorStr(num.playerId);
        const isWinStage = stage === 'winner_grow';

        // Position calculation
        let x: number, y: number;
        let opacity = 1;
        let scale = 1;
        let transition: string;

        // Wedge-anchored number placement: each player (attacker or defender) has an edge offset
        // indicating the hex edge nearest their territory. Numbers ride their wedge:
        //  - during numbers_move they sit at (2/3 · edgeOffset) from target — the wedge's centroid
        //    when the triangle has swept inward to the hex center.
        //  - during a defender-holds shrink-back they retreat to (1 · edgeOffset) — the edge midpoint.
        const edgeOffset = playerEdgeOffsets.get(num.playerId);
        const centroidAtCenter = edgeOffset
          ? { x: num.endX + edgeOffset.dx * (2 / 3), y: num.endY + edgeOffset.dy * (2 / 3) }
          : null;
        const centroidCollapsed = edgeOffset
          ? { x: num.endX + edgeOffset.dx, y: num.endY + edgeOffset.dy }
          : null;

        {
          if (!numbersActive) {
            x = num.startX;
            y = num.startY;
            opacity = 0;
            scale = 0.5;
          } else if (stage === 'numbers_move') {
            if (centroidAtCenter) {
              // Land on the wedge centroid (2/3 of the way from hex center toward the edge midpoint)
              x = centroidAtCenter.x;
              y = centroidAtCenter.y;
            } else if (isContested) {
              // Fallback for players without an edge offset — small radial spread.
              const angle = (i / numbers.length) * Math.PI * 2 - Math.PI / 2;
              x = num.endX + Math.cos(angle) * 25;
              y = num.endY + Math.sin(angle) * 25;
            } else {
              x = num.endX;
              y = num.endY;
            }
            scale = 1;
          } else if (isWinStage) {
            if (num.isWinner) {
              // Winner scales up at the hex center regardless (whether attacker or defender).
              x = num.endX;
              y = num.endY;
              scale = 1.8;
            } else if (edgeOffset && isWedgeBattle) {
              // All losers (attacker or defender) ride their wedge back to its edge midpoint
              // as the winner expands. Numbers fade along the way.
              x = centroidCollapsed!.x;
              y = centroidCollapsed!.y;
              opacity = attackerWins ? 0 : 1;
              scale = 1;
            } else {
              // No edge offset available — legacy spread + fade.
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
              color: playerColorDark(num.playerId),
              WebkitTextStroke: '2.5px rgba(255,255,255,0.95)',
              paintOrder: 'stroke fill',
              textShadow: `0 0 8px ${haloColor}, 0 2px 4px rgba(0,0,0,0.8)`,
              zIndex: num.isWinner && isWinStage ? 502 : 501,
              whiteSpace: 'nowrap',
            }}
          >
            {num.isDefender && (
              // Absolutely-positioned shield sits just to the left of the number so the digit
              // (not the "🛡 N" block) is what lands on the phantom-wedge centroid — otherwise
              // the emoji's width biases the whole block off-center toward the hex interior.
              <span style={{
                position: 'absolute',
                right: '100%',
                top: '50%',
                transform: 'translateY(-50%)',
                marginRight: 2,
                WebkitTextStroke: 0,
                textShadow: '0 2px 4px rgba(0,0,0,0.8)',
              }}>🛡</span>
            )}
            {num.power}
          </div>
        );
      })}

      {/* Tile highlight ring removed — chevrons provide directional context */}
    </div>
  );
}
