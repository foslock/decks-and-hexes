import { useEffect, useMemo, useRef, useState } from 'react';
import type { HexTile, PlayerEffect } from '../types/game';
import { PLAYER_COLORS, type GridTransform } from './HexGrid';
import { axialToPixel, localToScreen } from '../utils/hexGeometry';

/**
 * Effect callouts shown above target-player base tiles during review mode.
 *
 * Lifecycle:
 *   1. `intro` — popups fade in one by one at expanded (vertical-list) positions.
 *   2. `stacked` — after a brief settle, they animate into a tight stack above
 *      the base tile (like a small deck).
 *   3. On pointer-enter of the stack region → the stack re-expands into a
 *      vertical list. Auto-flips downward if the list would clip above the
 *      top of the viewport.
 *   4. On pointer-leave → collapses back to the tight stack.
 *
 * No auto fade-out: the parent controls dismissal (typically clearing the
 * `effects` prop when the player exits review mode). Flying-card effects
 * (spoils/rubble) still animate from source tile → HUD during intro.
 */

const STACK_SPACING = 78;      // px between popups in expanded mode — must exceed a popup's full height so the bottom line (player name) stays readable
const COLLAPSED_OFFSET = 7;    // px between popups in stacked mode — just enough to reveal each card's edge behind the one in front
const COLLAPSED_SCALE_STEP = 0.04;
const COLLAPSED_OPACITY_STEP = 0.08;
const INTRO_STAGGER = 640;     // ms between each popup's arrival
const INTRO_ENTRY_OFFSET = 34; // px the incoming card starts above/below the stack before sliding in
const SETTLE_DELAY = 260;      // ms after last arrival before enabling hover interaction
const DISMISS_DURATION = 400;  // ms for the fade-out when the parent clears effects (player confirms done reviewing)
// Push the stack outward from the grid center along the base→center axis.
// Elliptical (not circular): popups are short and wide, so a horizontal offset
// of 90px "reads" the same as a ~50px vertical offset — using the full 90px
// vertically would make top/bottom stacks look further from the grid than the
// side stacks.
const POPUP_RADIAL_OFFSET_X = 90;
const POPUP_RADIAL_OFFSET_Y = 50;
const POPUP_HALF_WIDTH = 110;   // half of the popup wrapper width (~220px) — used to clamp the anchor inside the viewport
const POPUP_CARD_HEIGHT = 78;   // rough rendered height of a single popup card (3 lines of text + padding)
const VIEWPORT_MARGIN = 8;      // min gap between the stack and any viewport edge

type Phase = 'intro' | 'stacked';

const SUCCESS_GREEN = '#4aff6a';
const WARNING_ORANGE = '#ffaa44';
const DANGER_RED = '#ff6666';

const POSITIVE_EFFECT_TYPES = new Set([
  'grant_actions_next_turn',
  'free_reroll',
  'grant_land_grants',
  'cease_fire',
  'next_turn_bonus',
  'cost_reduction',
  'base_raid_spoils',
  'base_raid_defended',
  'draw_next_turn',
  'gain_resources',
]);

function effectColor(effectType: string): string {
  if (POSITIVE_EFFECT_TYPES.has(effectType)) return SUCCESS_GREEN;
  if (effectType === 'buy_restriction') return WARNING_ORANGE;
  return DANGER_RED;
}

function colorStr(playerId: string): string {
  const c = PLAYER_COLORS[playerId];
  return c !== undefined ? `#${c.toString(16).padStart(6, '0')}` : '#fff';
}

interface Props {
  effects: PlayerEffect[];
  gridTransform: GridTransform | null;
  gridRect: DOMRect | null;
  tiles: Record<string, HexTile>;
  playerNames: Record<string, string>;
  /** Player whose POV we're rendering from (for flying-card destination). */
  activePlayerId?: string;
  /** Speed multiplier (1 = normal, <1 = faster). */
  animSpeed?: number;
  /**
   * Live refs — when provided, popup positions continuously track the grid
   * via rAF so they follow rotation/resize smoothly. The snapshot props
   * above are used as a fallback on first paint before the refs populate.
   */
  gridTransformRef?: React.RefObject<GridTransform | null>;
  gridContainerRef?: React.RefObject<HTMLDivElement | null>;
}

interface GroupPosition {
  // Anchor for the stack, offset outward from the grid center so the
  // collapsed stack sits beside (not on top of) the base tile.
  anchorX: number;
  anchorY: number;
  // Whether the expanded list should extend downward instead of upward. Based
  // on which half of the viewport the anchor sits in so the expanded list
  // always points toward the center of the screen.
  flipDown: boolean;
}

/**
 * Pure position computation — extracted so the rAF loop and initial render
 * share the same logic. Returns `{}` if inputs aren't ready.
 */
function computeGroupPositions(
  gridTransform: GridTransform | null,
  gridRect: DOMRect | null,
  grouped: Record<string, PlayerEffect[]>,
  tiles: Record<string, HexTile>,
): Record<string, GroupPosition> {
  if (!gridTransform || !gridRect) return {};
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const viewportMidY = vpH / 2;
  const center = localToScreen(0, 0, gridTransform, gridRect.width, gridRect.height, gridRect);
  const out: Record<string, GroupPosition> = {};
  for (const targetId of Object.keys(grouped)) {
    const baseTile = Object.values(tiles).find(
      t => t.is_base && t.base_owner === targetId,
    );
    if (!baseTile) continue;
    const local = axialToPixel(baseTile.q, baseTile.r);
    const pos = localToScreen(local.x, local.y, gridTransform, gridRect.width, gridRect.height, gridRect);
    const dx = pos.x - center.x;
    const dy = pos.y - center.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;

    const count = grouped[targetId].length;

    // Pick the flip direction based on the base position (not the offset
    // anchor) so direction is stable regardless of how much we end up
    // shrinking the offset.
    const flipDown = pos.y < viewportMidY;

    // The anchor marks the CENTER of the COLLAPSED stack (what the player
    // sees by default). Expanded stacks grow outward from there in the
    // flip direction and may extend beyond the anchor.
    const collapsedBand = (count - 1) * COLLAPSED_OFFSET;
    const collapsedHeight = collapsedBand + POPUP_CARD_HEIGHT;

    // Try the full (elliptical) offset; if the EXPANDED stack pushes
    // offscreen, shrink both axes uniformly by `scale`. The collapsed stack
    // straddles the anchor evenly; the expanded stack extends in the flip
    // direction by (expandedBand + card height).
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const ax = pos.x + nx * POPUP_RADIAL_OFFSET_X * scale;
      const ay = pos.y + ny * POPUP_RADIAL_OFFSET_Y * scale;
      const topEdge = flipDown
        ? ay - collapsedHeight / 2
        : ay - collapsedHeight / 2 - ((count - 1) * STACK_SPACING - collapsedBand);
      const bottomEdge = flipDown
        ? ay + collapsedHeight / 2 + ((count - 1) * STACK_SPACING - collapsedBand)
        : ay + collapsedHeight / 2;
      const leftEdge = ax - POPUP_HALF_WIDTH;
      const rightEdge = ax + POPUP_HALF_WIDTH;
      const fitsH = leftEdge >= VIEWPORT_MARGIN && rightEdge <= vpW - VIEWPORT_MARGIN;
      const fitsV = topEdge >= VIEWPORT_MARGIN && bottomEdge <= vpH - VIEWPORT_MARGIN;
      if (fitsH && fitsV) break;
      scale *= 0.6;
      if (scale < 0.1) { scale = 0; break; }
    }

    let anchorX = pos.x + nx * POPUP_RADIAL_OFFSET_X * scale;
    let anchorY = pos.y + ny * POPUP_RADIAL_OFFSET_Y * scale;

    // Final clamp: even after shrinking the offset, nudge the anchor inside
    // the viewport so the stack is never cut off.
    const minX = VIEWPORT_MARGIN + POPUP_HALF_WIDTH;
    const maxX = vpW - VIEWPORT_MARGIN - POPUP_HALF_WIDTH;
    if (anchorX < minX) anchorX = minX;
    else if (anchorX > maxX) anchorX = maxX;

    // Clamp so the EXPANDED extent stays on-screen. The stack's collapsed
    // center is at anchorY; it extends collapsedHeight/2 in one direction
    // and collapsedHeight/2 + (expandedBand - collapsedBand) in the flip
    // direction.
    const expandedDelta = (count - 1) * STACK_SPACING - collapsedBand;
    const minY = flipDown
      ? VIEWPORT_MARGIN + collapsedHeight / 2
      : VIEWPORT_MARGIN + collapsedHeight / 2 + expandedDelta;
    const maxY = flipDown
      ? vpH - VIEWPORT_MARGIN - collapsedHeight / 2 - expandedDelta
      : vpH - VIEWPORT_MARGIN - collapsedHeight / 2;
    if (anchorY < minY) anchorY = Math.min(minY, maxY);
    else if (anchorY > maxY) anchorY = Math.max(minY, maxY);

    out[targetId] = { anchorX, anchorY, flipDown };
  }
  return out;
}

export default function PlayerEffectPopups({
  effects,
  gridTransform,
  gridRect,
  tiles,
  playerNames,
  activePlayerId,
  animSpeed = 1,
  gridTransformRef,
  gridContainerRef,
}: Props) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [hoveredTarget, setHoveredTarget] = useState<string | null>(null);
  // How many cards have "arrived" on each target's stack so far. During intro,
  // each new arrival becomes the temporary top (stackIdx=0) and pushes the
  // earlier arrivals down into their final positions. The LAST card in each
  // group's array is the first to arrive, so the FIRST card ends up on top.
  const [arrivalCounts, setArrivalCounts] = useState<Record<string, number>>({});
  // Internal mirror of the effects prop so we can keep rendering during the
  // fade-out after the parent clears `effects`. `dismissing` flips to true at
  // the moment the prop goes empty; DISMISS_DURATION later, renderEffects
  // clears and the stacks unmount.
  const [renderEffects, setRenderEffects] = useState<PlayerEffect[]>(effects);
  const [dismissing, setDismissing] = useState(false);
  const prevPropLengthRef = useRef(effects.length);

  useEffect(() => {
    const hadEffects = prevPropLengthRef.current > 0;
    prevPropLengthRef.current = effects.length;
    if (effects.length > 0) {
      setRenderEffects(effects);
      setDismissing(false);
      return;
    }
    if (!hadEffects) return;
    setDismissing(true);
    const dur = DISMISS_DURATION * animSpeed;
    if (dur === 0) {
      setRenderEffects([]);
      setDismissing(false);
      return;
    }
    const t = window.setTimeout(() => {
      setRenderEffects([]);
      setDismissing(false);
    }, dur);
    return () => clearTimeout(t);
  }, [effects, animSpeed]);

  // Group effects by target player, preserving order within each group.
  const grouped = useMemo(() => {
    const out: Record<string, PlayerEffect[]> = {};
    for (const e of renderEffects) {
      if (!out[e.target_player_id]) out[e.target_player_id] = [];
      out[e.target_player_id].push(e);
    }
    return out;
  }, [renderEffects]);

  // Maximum stack depth across all groups — drives intro timeline length.
  const maxStackDepth = useMemo(() => {
    let m = 0;
    for (const g of Object.values(grouped)) m = Math.max(m, g.length);
    return m;
  }, [grouped]);

  // Schedule one-by-one arrivals per group, then flip to 'stacked' once
  // everyone has settled. Each arrival increments that group's count; the
  // per-card render logic uses (arrivalCount - 1 - arrivalOrder) to compute
  // the card's live stackIdx so the newest arrival always sits on top.
  useEffect(() => {
    if (renderEffects.length === 0) return;
    setPhase('intro');
    setHoveredTarget(null);
    const initial: Record<string, number> = {};
    for (const targetId of Object.keys(grouped)) initial[targetId] = 0;
    setArrivalCounts(initial);

    const timers: number[] = [];
    for (const [targetId, groupEffects] of Object.entries(grouped)) {
      for (let i = 1; i <= groupEffects.length; i++) {
        // First card arrives immediately (delay 0) — its entry animation
        // still plays because it transitions from the initial count=0 render.
        // Subsequent cards are staggered by INTRO_STAGGER.
        timers.push(window.setTimeout(() => {
          setArrivalCounts(prev => ({ ...prev, [targetId]: i }));
        }, (i - 1) * INTRO_STAGGER * animSpeed));
      }
    }
    timers.push(window.setTimeout(
      () => setPhase('stacked'),
      (Math.max(0, maxStackDepth - 1) * INTRO_STAGGER + SETTLE_DELAY) * animSpeed,
    ));
    return () => { timers.forEach(t => clearTimeout(t)); };
  }, [renderEffects, grouped, maxStackDepth, animSpeed]);

  // Compute per-group stack anchor positions + flip direction.
  // Anchor: start at the base tile's screen position, then push outward along
  // the grid-center→base vector by POPUP_RADIAL_OFFSET. The offset is
  // automatically shrunk (and then the whole anchor clamped) so the expanded
  // stack always fits inside the viewport — important near corner bases.
  // Flip: stacks on the top half of the viewport expand downward; stacks on
  // the bottom half expand upward — expanded lists always point toward the
  // screen center, maximizing vertical room.
  //
  // This runs in a rAF loop (not useMemo) so popups keep tracking their base
  // tiles when HexGrid animates rotation via its Pixi ticker or when the
  // window resizes — both of those mutate refs without re-rendering us.
  const [groupPositions, setGroupPositions] = useState<Record<string, GroupPosition>>(
    () => computeGroupPositions(gridTransform, gridRect, grouped, tiles),
  );
  useEffect(() => {
    let raf = 0;
    // Seed with an empty snapshot; the first rAF tick will diff against this
    // and populate state if non-empty. Re-runs of this effect (when grouped/
    // tiles/etc. change) re-seed the same way — a single duplicate setState
    // on the first frame is harmless.
    let prev: Record<string, GroupPosition> = {};

    const step = () => {
      const transform = gridTransformRef?.current ?? gridTransform;
      const rect = gridContainerRef?.current?.getBoundingClientRect() ?? gridRect;
      const next = computeGroupPositions(transform, rect, grouped, tiles);

      // Shallow diff to avoid setState storms every frame.
      let changed = false;
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length !== nextKeys.length) {
        changed = true;
      } else {
        for (const k of nextKeys) {
          const a = prev[k];
          const b = next[k];
          if (!a || a.anchorX !== b.anchorX || a.anchorY !== b.anchorY || a.flipDown !== b.flipDown) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        prev = next;
        setGroupPositions(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [grouped, tiles, gridTransform, gridRect, gridTransformRef, gridContainerRef]);

  // Flying-card elements (spoils / rubble cards flying to HUD/discard during intro)
  const flyingCards = useFlyingCards(renderEffects, gridTransform, gridRect, tiles, activePlayerId, animSpeed);

  if (!gridTransform || !gridRect) return null;

  return (
    <>
      {Object.entries(grouped).map(([targetId, groupEffects]) => {
        const groupPos = groupPositions[targetId];
        if (!groupPos) return null;
        const isHovered = hoveredTarget === targetId;
        const anotherHovered = hoveredTarget !== null && hoveredTarget !== targetId;
        // Intro never expands — cards always form a growing stack. Expansion
        // is reserved for the stacked phase + hover.
        const expanded = phase === 'stacked' && isHovered;
        const flip = groupPos.flipDown;
        const dirSign = flip ? 1 : -1; // +1 means stack grows downward
        const arrivalCount = arrivalCounts[targetId] ?? 0;

        // Wrapper is sized and positioned so its top/left are INDEPENDENT of
        // `flip`. If the wrapper itself moved when flip flipped (e.g. during a
        // grid rotation where a base crosses the viewport midline), the stack
        // would jump to a new CSS `top` instantly even though each card's
        // transform is still mid-transition — producing a visible jump followed
        // by a slide-back. By anchoring the wrapper to a symmetric extent
        // around the anchor, only the cards' `transform` animates, and CSS
        // transitions carry the flip smoothly.
        const count = groupEffects.length;
        const expandedBand = (count - 1) * STACK_SPACING;
        // Fits a full expansion in EITHER direction from the anchor.
        const wrapperHeight = 2 * expandedBand + POPUP_CARD_HEIGHT;
        // Top of the wrapper: the anchor sits at the wrapper's vertical center.
        const wrapperTop = groupPos.anchorY - expandedBand - POPUP_CARD_HEIGHT / 2;
        // Baseline offset used inside the card transforms. It's `expandedBand`
        // (so the anchor maps to the wrapper's center) minus `midCollapsed` —
        // the latter shifts the collapsed stack so its center lands exactly on
        // the anchor. `midCollapsed` flips sign with `flip` (via dirSignGeom);
        // since it's applied to each card's `translate` and the transform has a
        // CSS transition, the flip animates smoothly.
        const dirSignGeom = flip ? 1 : -1;
        const midCollapsed = ((count - 1) / 2) * COLLAPSED_OFFSET * dirSignGeom;
        const anchorWithinWrapper = expandedBand - midCollapsed;

        return (
          <div
            key={`stack_${targetId}`}
            data-testid="player-effect-stack"
            data-target={targetId}
            style={{
              position: 'fixed',
              left: groupPos.anchorX,
              top: wrapperTop,
              width: 220,
              height: wrapperHeight,
              transform: 'translateX(-50%)',
              // Wrapper itself never receives pointer events — hover is driven
              // by the top card only (see pointerEvents on stackIdx=0 below).
              pointerEvents: 'none',
              // Lift the hovered stack above siblings so its expanded list
              // never gets clipped by another stack's hover region.
              zIndex: isHovered ? 15100 : 15000,
              // Dismissing takes priority so every stack fades out together
              // when the player confirms done reviewing.
              opacity: dismissing ? 0 : (anotherHovered ? 0.15 : 1),
              transition: animSpeed > 0
                ? `opacity ${(dismissing ? DISMISS_DURATION : 200) * animSpeed}ms ease-out`
                : 'none',
            }}
          >
            {groupEffects.map((effect, idxInGroup) => {
              const globalIdx = renderEffects.indexOf(effect);
              // Arrival order within the group: effects[0] (earliest card
              // effect) arrives first, effects[count-1] arrives last and ends
              // up on top. Each arrival becomes the NEW top, pushing prior
              // arrivals back.
              const arrivalOrder = idxInGroup;
              const arrived = phase === 'stacked' || arrivalCount > arrivalOrder;
              // Current stackIdx during intro: the most recent arrival is at
              // stackIdx=0, each earlier arrival is one step deeper. In the
              // final stacked layout the last arrival (largest idxInGroup)
              // sits on top (stackIdx=0).
              const liveStackIdx = phase === 'stacked'
                ? count - 1 - idxInGroup
                : Math.max(0, arrivalCount - 1 - arrivalOrder);

              // Position within the stack region (localized to this wrapper).
              let targetY: number;
              let scale: number;
              let baseOpacity: number;
              if (!arrived) {
                // Pre-arrival: hover just outside the stack's entry edge, invisible.
                targetY = -INTRO_ENTRY_OFFSET * dirSign;
                scale = 0.85;
                baseOpacity = 0;
              } else if (expanded) {
                targetY = liveStackIdx * STACK_SPACING * dirSign;
                scale = 1;
                baseOpacity = 1;
              } else {
                targetY = liveStackIdx * COLLAPSED_OFFSET * dirSign;
                scale = Math.max(0.7, 1 - liveStackIdx * COLLAPSED_SCALE_STEP);
                baseOpacity = Math.max(0.35, 1 - liveStackIdx * COLLAPSED_OPACITY_STEP);
              }

              const sourceName = playerNames[effect.source_player_id] ?? effect.source_player_id;
              const sourceColor = colorStr(effect.source_player_id);
              const effColor = effectColor(effect.effect_type);

              // Only the final top card (the last to arrive, largest
              // idxInGroup) is interactive — it sits on top once all
              // arrivals have landed.
              const isTopCard = idxInGroup === count - 1;

              return (
                <div
                  key={`popup_${globalIdx}`}
                  onMouseEnter={isTopCard ? () => phase === 'stacked' && setHoveredTarget(targetId) : undefined}
                  onMouseLeave={isTopCard ? () => setHoveredTarget(prev => (prev === targetId ? null : prev)) : undefined}
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: 0,
                    transform: `translate(-50%, ${anchorWithinWrapper + targetY}px) scale(${scale})`,
                    transformOrigin: flip ? 'top center' : 'bottom center',
                    opacity: baseOpacity,
                    // zIndex: the live top card (smallest liveStackIdx) sits
                    // on top of the stack.
                    zIndex: 1000 - liveStackIdx,
                    // Transitions drive both the entrance (hidden → arrived)
                    // and the push-back (arrived → deeper stackIdx) animations
                    // smoothly off state changes. Durations scale with
                    // animSpeed (0 in "off" mode → no transition).
                    transition: animSpeed > 0
                      ? `transform ${320 * animSpeed}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${220 * animSpeed}ms ease-out`
                      : 'none',
                    pointerEvents: isTopCard && phase === 'stacked' && !anotherHovered && !dismissing ? 'auto' : 'none',
                  }}
                >
                  <div style={{
                    background: 'rgba(15, 15, 35, 0.95)',
                    border: `2px solid ${sourceColor}`,
                    borderRadius: 10,
                    padding: '8px 14px',
                    textAlign: 'center',
                    boxShadow: `0 0 20px ${sourceColor}44, 0 4px 16px rgba(0,0,0,0.6)`,
                    whiteSpace: 'nowrap',
                    minWidth: 140,
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 2 }}>
                      {effect.card_name}
                    </div>
                    <div style={{ fontSize: 12, color: effColor, fontWeight: 700, marginBottom: 3 }}>
                      {effect.effect}
                    </div>
                    <div style={{ fontSize: 10, color: sourceColor, fontWeight: 600, letterSpacing: 0.2, textTransform: 'uppercase' }}>
                      {sourceName}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {flyingCards}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Flying-card animation (spoils/rubble flying from source tile → HUD/discard).
 * Only runs during intro. Unchanged behavior from the original inline impl.
 * ────────────────────────────────────────────────────────────────────────── */

function useFlyingCards(
  effects: PlayerEffect[],
  gridTransform: GridTransform | null,
  gridRect: DOMRect | null,
  tiles: Record<string, HexTile>,
  activePlayerId: string | undefined,
  animSpeed: number,
): React.ReactNode[] {
  // Resolve HUD/discard destination elements once per burst.
  const startedRef = useRef(false);
  useEffect(() => { startedRef.current = false; }, [effects]);

  return useMemo(() => {
    if (!gridTransform || !gridRect) return [];

    const FLY_DURATION = Math.round(800 * animSpeed);
    const FLY_CARD_STAGGER = 120;
    const STAGGER_DELAY = INTRO_STAGGER;

    const out: React.ReactNode[] = [];
    const targetCounts: Record<string, number> = {};

    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      const idx = targetCounts[effect.target_player_id] ?? 0;
      targetCounts[effect.target_player_id] = idx + 1;

      if (!effect.added_card_name || !effect.added_card_count || effect.source_q == null || effect.source_r == null) continue;
      // Base raids use their own popup; skip the flying rubble/spoils card anim.
      if (effect.effect_type === 'base_raid_rubble' || effect.effect_type === 'base_raid_spoils') continue;

      const local = axialToPixel(effect.source_q, effect.source_r);
      const src = localToScreen(local.x, local.y, gridTransform, gridRect.width, gridRect.height, gridRect);

      const isHomePlayer = effect.target_player_id === activePlayerId;
      let destX: number, destY: number;
      if (isHomePlayer) {
        const discardEl = document.querySelector('[data-discard-pile]');
        if (discardEl) {
          const dr = discardEl.getBoundingClientRect();
          destX = dr.left + dr.width / 2;
          destY = dr.top + dr.height / 2;
        } else {
          destX = window.innerWidth - 60;
          destY = window.innerHeight - 60;
        }
      } else {
        const hudEl = document.querySelector(`[data-player-hud="${effect.target_player_id}"]`);
        if (hudEl) {
          const hr = hudEl.getBoundingClientRect();
          destX = hr.left + hr.width / 2;
          destY = hr.top + hr.height / 2;
        } else {
          const baseTile = Object.values(tiles).find(t => t.is_base && t.base_owner === effect.target_player_id);
          if (baseTile) {
            const baseLocal = axialToPixel(baseTile.q, baseTile.r);
            const bp = localToScreen(baseLocal.x, baseLocal.y, gridTransform, gridRect.width, gridRect.height, gridRect);
            destX = bp.x;
            destY = bp.y;
          } else {
            continue;
          }
        }
      }

      const isRubble = effect.added_card_name === 'Rubble';
      const cardColor = isRubble ? '#ff6666' : '#ffd700';
      const cardEmoji = isRubble ? '🪨' : '★';
      const effectDelay = idx * STAGGER_DELAY * animSpeed;

      for (let c = 0; c < effect.added_card_count; c++) {
        const cardDelay = effectDelay + c * FLY_CARD_STAGGER;
        const dx = destX - src.x;
        const dy = destY - src.y;
        const spreadX = (Math.random() - 0.5) * 20;
        const spreadY = (Math.random() - 0.5) * 20;
        const keyName = `flyCard_${i}_${c}`;

        out.push(
          <div key={keyName}>
            <style>{`
              @keyframes ${keyName} {
                0%   { transform: translate(0, 0) scale(1); opacity: 1; }
                20%  { transform: translate(0, -20px) scale(1.1); opacity: 1; }
                100% { transform: translate(${dx + spreadX}px, ${dy + spreadY}px) scale(0.3); opacity: 0.2; }
              }
            `}</style>
            <div style={{
              position: 'fixed',
              left: src.x,
              top: src.y,
              transform: 'translate(-50%, -50%)',
              zIndex: 16000,
              pointerEvents: 'none',
              opacity: 0,
              animation: `${keyName} ${FLY_DURATION}ms ease-in ${cardDelay}ms forwards`,
            }}>
              <div style={{
                background: 'rgba(15, 15, 35, 0.95)',
                border: `2px solid ${cardColor}`,
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 12,
                fontWeight: 'bold',
                color: cardColor,
                whiteSpace: 'nowrap',
                boxShadow: `0 0 12px ${cardColor}66`,
              }}>
                {cardEmoji} {effect.added_card_name}
              </div>
            </div>
          </div>
        );
      }
    }

    return out;
  }, [effects, gridTransform, gridRect, tiles, activePlayerId, animSpeed]);
}
