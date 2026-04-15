import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import type { ResolutionStep } from '../types/game';
import { type GridTransform, PLAYER_COLORS } from './HexGrid';
import type { Container } from 'pixi.js';
import { Graphics } from 'pixi.js';
import { useAnimationMode, useAnimationSpeed } from './SettingsContext';
import { useSound } from '../audio/useSound';

// ---------------------------------------------------------------------------
// Pixi wedge animation helpers — wedge geometry lives in the hex grid's own
// Pixi coordinate space (axialToPixel, HEX_SIZE=32, unscaled), so there is
// no screen-coordinate conversion and no measurement-timing bugs.
// ---------------------------------------------------------------------------

/** Cubic-bezier easing solver matching CSS cubic-bezier(x1,y1,x2,y2). */
function solveCubicBezier(t: number, x1: number, y1: number, x2: number, y2: number): number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const xu = ((ax * u + bx) * u + cx) * u;
    const dxu = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(dxu) < 1e-6) break;
    u = Math.max(0, Math.min(1, u - (xu - t) / dxu));
  }
  return ((ay * u + by) * u + cy) * u;
}

function lerp2d(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

interface PixiWedge {
  playerId: string;
  isWinner: boolean;
  cornerA: { x: number; y: number };
  cornerB: { x: number; y: number };
  edgeMidPt: { x: number; y: number };
  hexCenter: { x: number; y: number };
  /** The 4 remaining hex corners (CCW from edgeK+2..edgeK+5) — used to expand winner to full hex. */
  otherCorners: { x: number; y: number }[];
  g: Graphics;
}

/** Build wedge geometry and Graphics objects for each attacker in the given step. */
function buildPixiWedges(step: ResolutionStep, container: Container): PixiWedge[] {
  const hexCenter = axialToPixel(step.q, step.r);
  const inscribedR = HEX_SIZE * Math.sqrt(3) / 2;

  const grouped = new Map<string, { sourceQ: number; sourceR: number }>();
  for (const c of step.claimants) {
    if (!grouped.has(c.player_id)) {
      grouped.set(c.player_id, { sourceQ: c.source_q ?? step.q, sourceR: c.source_r ?? step.r });
    }
  }

  const corner = (k: number) => ({
    x: hexCenter.x + HEX_SIZE * Math.cos(k * Math.PI / 3),
    y: hexCenter.y + HEX_SIZE * Math.sin(k * Math.PI / 3),
  });

  const usedEdges = new Set<number>();
  const wedges: PixiWedge[] = [];

  for (const [playerId, info] of grouped) {
    const local = axialToPixel(info.sourceQ - step.q, info.sourceR - step.r);
    const approachAngle = Math.atan2(local.y, local.x);

    const sorted = [0, 1, 2, 3, 4, 5].map(k => {
      const mid = Math.PI / 6 + k * Math.PI / 3;
      let d = Math.abs(approachAngle - mid) % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return { k, d };
    }).sort((a, b) => a.d - b.d);

    let edgeK = sorted[0].k;
    for (const c of sorted) {
      if (!usedEdges.has(c.k)) { edgeK = c.k; break; }
    }
    usedEdges.add(edgeK);

    const g = new Graphics();
    g.zIndex = 0;
    container.addChild(g);

    wedges.push({
      playerId,
      isWinner: playerId === step.winner_id,
      cornerA: corner(edgeK),
      cornerB: corner(edgeK + 1),
      edgeMidPt: {
        x: hexCenter.x + inscribedR * Math.cos((edgeK + 0.5) * Math.PI / 3),
        y: hexCenter.y + inscribedR * Math.sin((edgeK + 0.5) * Math.PI / 3),
      },
      hexCenter,
      otherCorners: [2, 3, 4, 5].map(off => corner(edgeK + off)),
      g,
    });
  }

  return wedges;
}

function fillWedge(w: PixiWedge, pts: { x: number; y: number }[]) {
  const color = PLAYER_COLORS[w.playerId] ?? 0xffffff;
  w.g.clear();
  w.g.fill({ color, alpha: 0.9 });
  w.g.poly(pts);
  w.g.fill();
}

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
  /** Pixi Container inside the hex grid — when provided, wedge animations are rendered in Pixi
   *  (no screen-coordinate conversion needed, eliminating the measurement-timing offset bug). */
  resolveLayerRef?: React.RefObject<Container | null>;
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
export default function ResolveOverlay({ steps, gridTransform: gridTransformProp, gridRect, gridContainerRef, gridTransformRef, onStepApply, onComplete, resolveLayerRef }: ResolveOverlayProps) {
  // Snapshot rect + transform measured in useLayoutEffect (fires after DOM
  // commit, before paint) so we always get post-layout values rather than
  // stale values captured during React's render phase.
  const measuredRectRef = useRef<DOMRect | null>(null);
  const measuredTransformRef = useRef<GridTransform | null>(null);
  const animMode = useAnimationMode();
  const isOff = animMode === 'off';
  const animSpeed = useAnimationSpeed();
  const sound = useSound();

  const [currentIdx, setCurrentIdx] = useState(0);
  const [stage, setStage] = useState<StepStage>('numbers_move');
  const [numbersActive, setNumbersActive] = useState(false);
  const completedRef = useRef(false);
  const appliedStepsRef = useRef(new Set<number>());

  // Pixi wedge state — Graphics objects live inside the resolve container provided by HexGrid
  const pixiWedgesRef = useRef<PixiWedge[] | null>(null);

  // Stable refs for callbacks — prevents effect cleanup from cancelling
  // pending timeouts when parent re-renders (e.g. from WebSocket updates)
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onStepApplyRef = useRef(onStepApply);
  onStepApplyRef.current = onStepApply;

  const step = steps[currentIdx] as ResolutionStep | undefined;

  // Re-measure rect + transform after every DOM commit (useLayoutEffect fires
  // synchronously post-commit, before paint). This is more reliable than
  // reading getBoundingClientRect() during render, where the DOM may not yet
  // reflect pending layout changes (e.g. the hand panel resizing as the phase
  // transitions, or the banner unmounting). Both values come from the same
  // post-layout snapshot so they are always mutually consistent.
  useLayoutEffect(() => {
    const container = gridContainerRef?.current;
    // Use the canvas element's rect when available — it exactly matches Pixi's
    // app.screen dimensions (the drawing surface), whereas the outer wrapper div
    // may be taller/wider due to flex layout. fitGrid positions the hexContainer
    // at (app.screen.width/2, app.screen.height/2), so we must use those same
    // dimensions as the coordinate origin for correct number placement.
    const canvas = container?.querySelector('canvas') ?? null;
    measuredRectRef.current = (canvas ?? container)?.getBoundingClientRect() ?? gridRect ?? null;
    measuredTransformRef.current = gridTransformRef?.current ?? gridTransformProp ?? null;
  });

  // Local aliases for the measured values — safe to read during render because
  // they're updated by the useLayoutEffect above (which fires before paint).
  // On the very first render these are null; hasPositionData guards usage.
  const gridTransform = measuredTransformRef.current;
  const measuredRect = measuredRectRef.current;

  // Convert hex coords to screen coords using the layout-effect snapshot.
  const toScreen = useCallback((q: number, r: number) => {
    const rect = measuredRectRef.current;
    const transform = measuredTransformRef.current;
    if (!rect || !transform) return { x: 0, y: 0 };
    const local = axialToPixel(q, r);
    // Rotation-aware: apply pivot-based transform
    const relX = (local.x - transform.pivotX) * transform.scale;
    const relY = (local.y - transform.pivotY) * transform.scale;
    const cos = Math.cos(transform.rotation);
    const sin = Math.sin(transform.rotation);
    return {
      x: relX * cos - relY * sin + rect.width / 2 + rect.left,
      y: relX * sin + relY * cos + rect.height / 2 + rect.top,
    };
  // Deps are stable refs — toScreen reads them via .current at call time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // hasPositionData: true when both transform and rect are available.
  // Falls back to snapshot props on the first render (before useLayoutEffect has fired),
  // because refs are null until after the first DOM commit.
  const hasPositionData = !!(
    (measuredTransformRef.current ?? gridTransformRef?.current ?? gridTransformProp) &&
    (measuredRectRef.current ?? gridRect));

  // Build the numbers for current step
  const numbers: ActiveNumber[] = [];
  if (step && hasPositionData) {
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
  const wedgeGeom = isWedgeBattle && step && gridTransform && measuredRect ? (() => {
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

  const fireStepApply = useCallback((idx: number) => {
    if (appliedStepsRef.current.has(idx)) return;
    appliedStepsRef.current.add(idx);
    onStepApplyRef.current?.(idx);
  }, []);

  // === PIXI WEDGE ANIMATION EFFECTS ===
  // Wedge shapes are drawn directly into the HexGrid's Pixi Container, so geometry
  // is in axial-pixel space with no screen-coordinate conversion needed.

  // Effect 1: create Pixi Graphics for the current step's wedges
  useEffect(() => {
    // Tear down any wedges from the previous step
    const prev = pixiWedgesRef.current;
    if (prev) {
      for (const w of prev) { if (!w.g.destroyed) w.g.destroy(); }
      pixiWedgesRef.current = null;
    }

    const container = resolveLayerRef?.current;
    if (!container || !step || !isWedgeBattle || isOff) return;

    const wedges = buildPixiWedges(step, container);
    pixiWedgesRef.current = wedges;

    // Initial state: collapsed triangle at the approach edge
    for (const w of wedges) fillWedge(w, [w.cornerA, w.cornerB, w.edgeMidPt]);

    return () => {
      for (const w of wedges) { if (!w.g.destroyed) w.g.destroy(); }
      pixiWedgesRef.current = null;
    };
  // isWedgeBattle is derived from step — step change covers both
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isWedgeBattle, isOff]);

  // Effect 2: numbers_move phase — apex flies from edgeMid → hexCenter
  useEffect(() => {
    if (!numbersActive || stage !== 'numbers_move' || !isWedgeBattle) return;
    const wedges = pixiWedgesRef.current;
    if (!wedges) return;

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / Math.max(moveMs, 1));
      const t = solveCubicBezier(raw, 0.2, 0.8, 0.3, 1.0);
      for (const w of wedges) {
        if (!w.g.destroyed) fillWedge(w, [w.cornerA, w.cornerB, lerp2d(w.edgeMidPt, w.hexCenter, t)]);
      }
      if (raw < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [numbersActive, stage, isWedgeBattle, moveMs]);

  // Effect 3: winner_grow phase — winner expands to full hex, losers shrink to edge
  useEffect(() => {
    if (stage !== 'winner_grow' || !isWedgeBattle) return;
    const wedges = pixiWedgesRef.current;
    if (!wedges) return;

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / Math.max(growMs, 1));
      const t = solveCubicBezier(raw, 0.4, 0, 0.2, 1);
      for (const w of wedges) {
        if (w.g.destroyed) continue;
        if (w.isWinner) {
          w.g.zIndex = 1; // draw above losers
          fillWedge(w, [w.cornerA, w.cornerB, ...w.otherCorners.map(c => lerp2d(w.hexCenter, c, t))]);
        } else {
          w.g.zIndex = 0;
          fillWedge(w, [w.cornerA, w.cornerB, lerp2d(w.hexCenter, w.edgeMidPt, t)]);
        }
      }
      if (raw < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage, isWedgeBattle, growMs]);

  // Effect 4: done phase — fade wedges out
  useEffect(() => {
    if (stage !== 'done' || !isWedgeBattle) return;
    const wedges = pixiWedgesRef.current;
    if (!wedges) return;

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / Math.max(pauseMs, 50));
      for (const w of wedges) {
        if (!w.g.destroyed) w.g.alpha = 1 - raw;
      }
      if (raw < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage, isWedgeBattle, pauseMs]);

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
  if (!step || isOff || !gridTransform || !measuredRect) return null;

  // Shine sweep timing: fires once on the winning number as it finishes growing.
  // Delay starts the sweep ~55% into the grow so the glint peaks right as the
  // number reaches full size. Parabolic motion: X bulges right while Y falls.
  const shineDurationMs = Math.round(500 * animSpeed);
  const shineDelayMs = Math.round(growMs * 0.55);

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 500,
    }}>
      <style>{`
        @keyframes winner-number-shine {
          0%   { background-position: 140% -40%; opacity: 0; }
          50%  { opacity: 1; }
          100% { background-position: -60% 140%; opacity: 0; }
        }
        @keyframes resolve-number-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes resolve-number-fade-out {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      `}</style>
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
          transition = `transform ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.2), opacity ${moveMs}ms ease-out`;
        } else if (stage === 'winner_grow') {
          scale = 1;
          opacity = 1;
          transition = `transform ${growMs}ms cubic-bezier(0.3, 0, 0.2, 1), opacity ${growMs}ms ease-out`;
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
              left: 0,
              top: 0,
              transform: `translate3d(${target.x}px, ${target.y}px, 0) translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              willChange: 'transform, opacity',
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
          transition = `transform ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.1), opacity ${moveMs}ms ease-out`;
        } else if (stage === 'winner_grow') {
          scale = 1;
          opacity = 1;
          transition = `transform ${growMs}ms cubic-bezier(0.3, 0, 0.2, 1), opacity ${growMs}ms ease-out`;
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
              left: 0,
              top: 0,
              transform: `translate3d(${target.x}px, ${target.y}px, 0) translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              willChange: 'transform, opacity',
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
          transition = `transform ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.1), opacity ${moveMs}ms ease-out`;
        } else if (stage === 'winner_grow') {
          // Settle at target
          x = target.x;
          y = target.y;
          scale = 1;
          opacity = 1;
          transition = `transform ${growMs}ms cubic-bezier(0.3, 0, 0.2, 1), opacity ${growMs}ms ease-out`;
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
              left: 0,
              top: 0,
              transform: `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              willChange: 'transform, opacity',
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

      {/* Wedge claim animations are rendered in Pixi (see Pixi effects above) — no HTML here */}

      {/* Power numbers (skip for Consecrate, Defense Applied, Auto-claim — custom animations handle them) */}
      {!isConsecrate && !isDefenseApplied && !isAutoClaim && numbers.map((num, i) => {
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
            // `done` stage — winner settles (scale 1.8→1, default opacity). For losers we
            // must explicitly preserve the faded-out opacity from winner_grow; otherwise the
            // lingering CSS transition animates opacity back to its default 1, visibly
            // fading defeated numbers back in during the brief pause.
            x = num.endX;
            y = num.endY;
            if (!num.isWinner) {
              if (edgeOffset && isWedgeBattle) {
                opacity = attackerWins ? 0 : 1;
              } else {
                opacity = 0;
              }
            }
          }
          // Split per-property: the bouncy overshoot bezier gives position/scale a nice
          // snap into place, but applied to opacity it hits ~1.0 by ~30% of the duration
          // (and overshoots past 1 → clamped), which reads as an instant pop rather than
          // a fade. Use a plain ease-out curve for opacity so the number visibly fades in
          // across the full moveMs as the wedge grows.
          //
          // Perf: animate `transform` (compositor-only, GPU-accelerated) — NOT `left`/`top`,
          // which trigger layout + paint every frame. Avoid `transition: all` so the browser
          // only tracks the two properties we actually change.
          transition = stage === 'numbers_move'
            ? `transform ${moveMs}ms cubic-bezier(0.2, 0.8, 0.3, 1.2), opacity ${moveMs}ms ease-out`
            : `transform ${growMs}ms ease-out, opacity ${growMs}ms ease-out`;
        }

        // During numbers_move we use a CSS keyframe animation for the opacity fade-in
        // instead of a transition. The transition approach depends on React committing
        // opacity:0 and the browser painting it BEFORE the next commit flips to opacity:1.
        // React 18's automatic batching can elide that intermediate paint, so the transition
        // never fires and the number pops. A keyframe animation runs on its own timeline
        // the moment it's applied, so the fade is guaranteed regardless of commit cadence.
        const inFadeIn = stage === 'numbers_move' && numbersActive;
        // Symmetric case on the way out: when a loser's opacity target is 0 during
        // winner_grow, use a keyframe fade-out. A plain CSS transition from an
        // animation-filled value (the fade-in held opacity:1 via `both`) to the new
        // inline opacity:0 often doesn't fire — the browser treats the animated value
        // as non-transitionable. The keyframe guarantees the fade is visible.
        const inFadeOut = isWinStage && !num.isWinner && opacity === 0;
        return (
          <div
            key={`${num.playerId}-${i}`}
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              // Fold position into the transform so the whole animation runs on the
              // compositor: translate(x,y) handles position, translate(-50%,-50%)
              // re-centers on the target, scale() handles growth. No layout-triggering
              // left/top updates per frame.
              transform: `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale})`,
              opacity,
              transition,
              animation: inFadeIn
                ? `resolve-number-fade-in ${moveMs}ms ease-out both`
                : inFadeOut
                ? `resolve-number-fade-out ${growMs}ms ease-out both`
                : undefined,
              willChange: 'transform, opacity',
              fontSize: 18,
              fontWeight: 'bold',
              color: playerColorDark(num.playerId),
              WebkitTextStroke: '2px rgba(255,255,255,0.95)',
              paintOrder: 'stroke fill',
              textShadow: 'none',
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
            {num.isWinner && isWinStage && (
              // Shine sweep — a white gradient stripe clipped to the glyph shape via
              // background-clip: text, sweeping monotonically from upper-right to
              // lower-left with an ease-in-out speed profile (slow fade-in, fast at
              // peak opacity, slow fade-out). Fires once as the winner reaches full size.
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  color: 'transparent',
                  WebkitTextStroke: 0,
                  textShadow: 'none',
                  backgroundImage:
                    'linear-gradient(115deg, rgba(255,255,255,0) 42%, rgba(255,255,255,1) 50%, rgba(255,255,255,0) 58%)',
                  backgroundSize: '260% 260%',
                  backgroundRepeat: 'no-repeat',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  pointerEvents: 'none',
                  opacity: 0,
                  animation: `winner-number-shine ${shineDurationMs}ms ease-in-out ${shineDelayMs}ms forwards`,
                }}
              >
                {num.power}
              </span>
            )}
          </div>
        );
      })}

      {/* Tile highlight ring removed — chevrons provide directional context */}
    </div>
  );
}
