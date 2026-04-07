import { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import { useAnimated, useAnimationOff, useAnimationMode, useAnimationSpeed } from './SettingsContext';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { buildCardSubtitle, type CardSubtitleContext } from './cardSubtitle';
import { renderSubtitlePart } from './SubtitlePartRenderer';
import { useSound } from '../audio/useSound';

export interface PlayTarget {
  cardId: string;
  /** Screen pixel position for the target tile, or null for non-targeting cards */
  screenX: number | null;
  screenY: number | null;
  /** Ghost card position at drag release (so animation starts from ghost, not hand) */
  dragX?: number;
  dragY?: number;
  /** Cursor velocity at release (px/ms) for thrown momentum on non-targeting cards */
  dragVelocityX?: number;
  dragVelocityY?: number;
}

/** Trash/discard selection mode state passed from GameScreen */
export interface TrashSelectionMode {
  /** Index of the card being played (grayed out, not selectable) */
  playedCardIndex: number;
  /** Indices currently selected for trashing/discarding */
  selectedIndices: Set<number>;
  /** Minimum cards that must be selected (0 for "up to") */
  minCards: number;
  /** Maximum cards that can be selected */
  maxCards: number;
  /** Display label: "Trash" or "Discard" */
  label: string;
}

interface CardHandProps {
  playerId: string;
  cards: Card[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onDragPlay: (cardIndex: number, screenX: number, screenY: number, dragVelocityX?: number, dragVelocityY?: number) => void;
  onDoubleClick?: (cardIndex: number) => void;
  onDragStart?: (cardIndex: number) => void;
  onDragEnd?: () => void;
  disabled: boolean;
  // Deck / discard data
  deckSize: number;
  discardCount: number;
  discardCards: Card[];
  deckCards: Card[];
  inPlayCards?: Card[];
  /** When set to true, all hand cards animate to discard pile. Fires onDiscardAllComplete when done. */
  discardAll?: boolean;
  /** Callback when the discard-all animation finishes (or immediately if animation is off). */
  onDiscardAllComplete?: () => void;
  /** Where the last played card should animate toward */
  lastPlayedTarget?: PlayTarget | null;
  /** Force the shuffle animation on the draw pile (used during intro sequence) */
  forceShuffleAnim?: boolean;
  /** Trash/discard selection mode */
  trashMode?: TrashSelectionMode | null;
  /** Toggle a card's trash selection (during trash mode) */
  onTrashToggle?: (cardIndex: number) => void;
  /** When true, close any open draw/discard popups */
  closePopups?: boolean;
  /** Card IDs that are being trashed (for tear animation instead of discard) */
  trashedCardIds?: Set<string>;
  /** Game context for resolving dynamic card subtitle values */
  subtitleContext?: CardSubtitleContext;
  /** When true, claim cards are banned (Snowy Holiday) — shown dimmed and unplayable */
  claimBanned?: boolean;
}

import { CARD_TYPE_COLORS } from '../constants/cardColors';

const CARD_EMOJI: Record<string, string> = {
  claim: '⚔️',
  defense: '🛡️',
  engine: '⚙️',
  passive: '📜',
};

const DRAG_THRESHOLD = 12;
const CARD_WIDTH = 134;
const CARD_GAP = 6;
// Approximate rendered height of a hand card (padding + border + content)
// so the hand area stays consistent when empty
const CARD_MIN_HEIGHT = 52;

function ActionReturnBadge({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span style={{
      fontSize: 10,
      padding: '1px 4px',
      borderRadius: 4,
      background: value === 2 ? '#4aff6a' : '#ffaa4a',
      color: '#000',
      fontWeight: 'bold',
    }}>
      {value === 1 ? '↺' : '↑'}
    </span>
  );
}

// Floating card preview shown above/below a hovered hand card
function CardPreview({ card, anchorRect }: { card: Card; anchorRect: DOMRect }) {
  const animMode = useAnimationMode();
  const [visible, setVisible] = useState(animMode !== 'normal');

  useEffect(() => {
    if (animMode === 'normal') {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [animMode]);

  return (
    <div style={{
      position: 'fixed',
      left: Math.max(8, Math.min(anchorRect.left + anchorRect.width / 2 - CARD_FULL_WIDTH / 2, window.innerWidth - CARD_FULL_WIDTH - 8)),
      bottom: window.innerHeight - anchorRect.top + 8,
      pointerEvents: 'none',
      zIndex: 9999,
      opacity: visible ? 1 : 0,
      transition: animMode === 'normal' ? 'opacity 0.15s ease' : 'none',
    }}>
      <CardFull card={card} showKeywordHints />
    </div>
  );
}

function Flag({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, border: `1px solid ${color}`, color }}>
      {text}
    </span>
  );
}

// ── Card Popup (deck viewer / discard viewer) ────────────────

function CardPopupItem({ card, full, shiftHeld }: { card: Card; full: boolean; shiftHeld: boolean }) {
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  const color = CARD_TYPE_COLORS[displayCard.card_type] || '#555';
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const upgradeLabel = shiftHeld && hasUpgradePreview(card) ? (
    <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 'bold', color: '#4aff6a', marginTop: 4 }}>
      Upgraded
    </div>
  ) : null;
  const vpBadge = displayCard.current_vp !== undefined ? (
    <span style={{
      fontSize: 14,
      fontWeight: 'bold',
      color: displayCard.current_vp > 0 ? '#ffd700' : displayCard.current_vp < 0 ? '#ff6666' : '#888',
      marginLeft: 4,
    }}>
      {displayCard.current_vp > 0 ? '+' : ''}{displayCard.current_vp}★
    </span>
  ) : null;
  if (!full) {
    return (
      <div
        onPointerEnter={(e) => setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onPointerLeave={() => setHoverRect(null)}
        style={{
          width: 154,
          padding: 6,
          background: '#2a2a3e',
          border: `1px solid ${color}`,
          borderRadius: 6,
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
            <div style={{ fontWeight: 'bold', fontSize: 16, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
              <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
                if (el) {
                  const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                  el.style.setProperty('--title-scale', String(scale));
                }
              }}>
                {displayCard.name}{vpBadge}
              </span>
            </div>
            <span style={{ fontSize: 15, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{displayCard.buy_cost != null ? `${displayCard.buy_cost}💰` : '—'}</span>
          </div>
          <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
              if (el) {
                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                el.style.setProperty('--sub-scale', String(scale));
              }
            }}>
            {buildCardSubtitle(displayCard).map((part, i) => renderSubtitlePart(part, i, { passiveVp: displayCard.passive_vp }))}
            </span>
          </div>
        </div>
        {upgradeLabel}
        {hoverRect && createPortal(
          <div style={{
            position: 'fixed',
            left: Math.max(8, Math.min(hoverRect.left + hoverRect.width / 2 - CARD_FULL_WIDTH / 2, window.innerWidth - CARD_FULL_WIDTH - 8)),
            ...(hoverRect.top > CARD_FULL_MIN_HEIGHT + 16
              ? { bottom: window.innerHeight - hoverRect.top + 8 }
              : { top: hoverRect.bottom + 8 }),
            pointerEvents: 'none',
            zIndex: 50000,
          }}>
            <CardFull card={displayCard} showKeywordHints />
          </div>,
          document.body
        )}
      </div>
    );
  }
  return (
    <div style={{ flexShrink: 0 }}>
      <CardFull card={displayCard} style={{ flexShrink: 0 }} />
      {upgradeLabel}
    </div>
  );
}

/** Compact card content (title + subtitle) — shared by card slots, drag ghost, and departing animations. */
function CompactCardContent({ card, titleSize = 14, subtitleSize = 13, subtitleCtx }: { card: Card; titleSize?: number; subtitleSize?: number; subtitleCtx?: CardSubtitleContext }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <div style={{ fontWeight: 'bold', fontSize: titleSize, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
          {card.name}
          {card.current_vp !== undefined && (
            <span style={{
              fontSize: 11,
              fontWeight: 'bold',
              color: card.current_vp > 0 ? '#ffd700' : card.current_vp < 0 ? '#ff6666' : '#888',
              marginLeft: 4,
            }}>
              {card.current_vp > 0 ? '+' : ''}{card.current_vp}★
            </span>
          )}
        </div>
        <span style={{ fontSize: subtitleSize - 1, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{card.buy_cost != null ? `${card.buy_cost}💰` : '—'}</span>
      </div>
      <div style={{ fontSize: subtitleSize, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {buildCardSubtitle(card, subtitleCtx).map((part, i) => renderSubtitlePart(part, i, { passiveVp: card.passive_vp, showDynamic: true }))}
      </div>
    </>
  );
}

// Persists view mode preference per popup title across opens (reset on page reload)
const viewModeMemory: Record<string, boolean> = {};

export function CardViewPopup({
  title,
  cards,
  onClose,
  defaultFull = false,
  note,
  preserveOrder = false,
  allowUpgradePreview = false,
}: {
  title: string;
  cards: { label: string; items: Card[] }[];
  onClose: () => void;
  defaultFull?: boolean;
  note?: string;
  /** When true, display cards in the order given (no sorting). */
  preserveOrder?: boolean;
  /** When true, holding Shift shows upgraded card previews. */
  allowUpgradePreview?: boolean;
}) {
  const [fullView, setFullView] = useState(() => viewModeMemory[title] ?? defaultFull);
  const animMode = useAnimationMode();
  const rawShiftHeld = useShiftKey();
  const shiftHeld = (allowUpgradePreview ?? false) && rawShiftHeld;
  const [visible, setVisible] = useState(animMode === 'off');
  const totalCount = cards.reduce((s, g) => s + g.items.length, 0);
  const trashedGroup = cards.find(g => g.label === 'Trashed');
  const trashedCount = trashedGroup?.items.length ?? 0;
  const deckCount = totalCount - trashedCount;

  const toggleView = useCallback((full: boolean) => {
    setFullView(full);
    viewModeMemory[title] = full;
  }, [title]);

  useEffect(() => {
    if (animMode !== 'off') {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [animMode]);

  // Dismiss on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const speed = animMode === 'fast' ? 0.5 : 1;
  const overlayTransition = animMode === 'off' ? 'none' : `opacity ${0.25 * speed}s ease`;
  const panelTransition = animMode === 'off' ? 'none' : `opacity ${0.25 * speed}s ease, transform ${0.25 * speed}s ease`;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 45000,
        opacity: visible ? 1 : 0,
        transition: overlayTransition,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(92vw, 860px)',
          maxHeight: '80vh',
          background: '#12122a',
          border: '2px solid #4a4a6a',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1)' : 'scale(0.95)',
          transition: panelTransition,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 16px',
          background: '#1a1a40',
          borderBottom: '1px solid #333',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 'bold', fontSize: 15, color: '#fff' }}>{title}</span>
          <span style={{ fontSize: 12, color: '#888' }}>
            ({deckCount} card{deckCount !== 1 ? 's' : ''}{trashedCount > 0 && <>, <span style={{ color: '#aa4444' }}>{trashedCount} trashed</span></>})
          </span>
          {note && <span style={{ fontSize: 11, color: '#666', fontStyle: 'italic' }}>{note}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', border: '1px solid #444', borderRadius: 6, overflow: 'hidden' }}>
              <button
                onClick={() => toggleView(false)}
                style={{ padding: '3px 10px', background: !fullView ? '#4a4aff' : '#2a2a3e', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}
              >
                Compact
              </button>
              <button
                onClick={() => toggleView(true)}
                style={{ padding: '3px 10px', background: fullView ? '#4a4aff' : '#2a2a3e', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}
              >
                Full
              </button>
            </div>
            <button
              onClick={onClose}
              style={{ padding: '4px 10px', background: '#2a2a3e', border: '1px solid #555', borderRadius: 5, color: '#aaa', fontSize: 13, cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: 16 }}>
          {cards.map((group) => {
            const isTrashed = group.label === 'Trashed';
            return (
            <div key={group.label} style={{ marginBottom: 16 }}>
              {cards.length > 1 && (
                <div style={{
                  fontSize: 12,
                  color: isTrashed ? '#aa4444' : '#888',
                  marginBottom: 8,
                  fontWeight: 'bold',
                }}>
                  {isTrashed ? '🗑 ' : ''}{group.label} ({group.items.length})
                </div>
              )}
              {group.items.length === 0 ? (
                <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic' }}>Empty</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, ...(isTrashed ? { opacity: 0.55 } : {}) }}>
                  {(preserveOrder
                    ? group.items
                    : [...group.items].sort((a, b) => (a.buy_cost ?? -1) - (b.buy_cost ?? -1) || a.name.localeCompare(b.name))
                  ).map((card, i) => (
                    <CardPopupItem key={`${card.id}-${i}`} card={card} full={fullView} shiftHeld={shiftHeld} />
                  ))}
                </div>
              )}
            </div>
          );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main CardHand Component ─────────────────────────────────

interface EnteringAnim {
  offset: { x: number; y: number };
  delay: number;
  active: boolean;
  /** false until the card element exists in the DOM and its real offset is computed */
  offsetComputed: boolean;
  /** Random rotation at draw pile origin (degrees), animates to 0 */
  startRotation: number;
  /** Random arc height (px upward) at midpoint of travel */
  arcHeight: number;
}

interface DepartingAnim {
  card: Card;
  startX: number;
  startY: number;
  toX: number;
  toY: number;
  width: number;
  height: number;
  active: boolean;
  /** Whether the card should shrink as it moves (played to tile) */
  shrink: boolean;
  /** Whether the card is being trashed (tear-apart animation) */
  trash: boolean;
  /** Random end rotation (degrees) for discard animations */
  endRotation: number;
}

export default function CardHand({
  playerId,
  cards,
  selectedIndex,
  onSelect,
  onDragPlay,
  onDoubleClick,
  onDragStart,
  onDragEnd,
  disabled,
  deckSize,
  discardCount,
  discardCards,
  deckCards,
  inPlayCards,
  discardAll,
  onDiscardAllComplete,
  lastPlayedTarget,
  forceShuffleAnim,
  trashMode,
  onTrashToggle,
  closePopups,
  trashedCardIds,
  subtitleContext,
  claimBanned,
}: CardHandProps) {
  const animated = useAnimated();
  const animationOff = useAnimationOff();
  const animMode = useAnimationMode();
  const animSpeed = useAnimationSpeed();
  const sound = useSound();
  const soundRef = useRef(sound);
  soundRef.current = sound;

  // Local display order — indices into the `cards` prop array
  const [localOrder, setLocalOrder] = useState<number[]>(() => cards.map((_, i) => i));

  const prevCardsForOrderRef = useRef(cards);
  useEffect(() => {
    const oldCards = prevCardsForOrderRef.current;
    prevCardsForOrderRef.current = cards;
    setLocalOrder(prev => {
      // Build a lookup from card ID → new index in updated cards array
      const idToNewIdx = new Map<string, number>();
      cards.forEach((c, i) => idToNewIdx.set(c.id, i));

      // Remap old indices through card IDs to preserve user-arranged order
      const remapped: number[] = [];
      for (const oldIdx of prev) {
        const card = oldCards[oldIdx];
        if (!card) continue;
        const newIdx = idToNewIdx.get(card.id);
        if (newIdx != null) {
          remapped.push(newIdx);
          idToNewIdx.delete(card.id); // prevent duplicates
        }
      }

      // Append any newly added cards that weren't in previous order
      for (const newIdx of idToNewIdx.values()) {
        remapped.push(newIdx);
      }

      // Sanity check: if sizes don't match, reset to natural order
      if (remapped.length !== cards.length) return cards.map((_, i) => i);
      return remapped;
    });
  }, [cards]);

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropTargetIndex, setDropTargetIndexState] = useState<number | null>(null);
  const dropTargetIndexRef = useRef<number | null>(null);
  const setDropTargetIndex = useCallback((v: number | null) => {
    dropTargetIndexRef.current = v;
    setDropTargetIndexState(v);
  }, []);
  const [showDeckPopup, setShowDeckPopup] = useState(false);
  const [showDiscardPopup, setShowDiscardPopup] = useState(false);
  // Card reflow animation is handled via direct DOM manipulation — see useLayoutEffect blocks.

  // Close draw/discard popups when parent signals (e.g. shop/browser opened)
  useEffect(() => {
    if (closePopups) {
      setShowDeckPopup(false);
      setShowDiscardPopup(false);
    }
  }, [closePopups]);
  const [cardMarginLeft, setCardMarginLeft] = useState(CARD_GAP);

  const handContainerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; index: number } | null>(null);
  const isDraggingRef = useRef(false);

  // Drag swing physics — simulates card hanging from cursor top-center
  const dragSwingRef = useRef({ angle: 0, velocity: 0, lastX: 0, lastTime: 0 });
  const [dragSwingAngle, setDragSwingAngle] = useState(0);
  const dragSwingRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (draggingIndex === null) {
      // Reset swing when drag ends
      if (dragSwingRafRef.current) cancelAnimationFrame(dragSwingRafRef.current);
      dragSwingRafRef.current = null;
      dragSwingRef.current = { angle: 0, velocity: 0, lastX: 0, lastTime: 0 };
      setDragSwingAngle(0);
      return;
    }
    // Spring physics loop
    const DAMPING = 0.92;       // velocity retention per frame
    const SPRING = 0.05;        // pull back toward center
    const VELOCITY_SCALE = 0.15; // cursor px/ms → degrees
    const MAX_ANGLE = 40;

    const tick = () => {
      const s = dragSwingRef.current;
      // Spring: pull angle back toward 0
      s.velocity -= s.angle * SPRING;
      // Damp
      s.velocity *= DAMPING;
      s.angle += s.velocity;
      // Clamp
      s.angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, s.angle));
      // Snap near-zero to avoid jitter
      if (Math.abs(s.angle) < 0.1 && Math.abs(s.velocity) < 0.01) {
        s.angle = 0;
        s.velocity = 0;
      }
      setDragSwingAngle(s.angle);
      dragSwingRafRef.current = requestAnimationFrame(tick);
    };

    dragSwingRef.current.lastX = dragPos?.x ?? 0;
    dragSwingRef.current.lastTime = performance.now();
    dragSwingRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (dragSwingRafRef.current) cancelAnimationFrame(dragSwingRafRef.current);
    };
  }, [draggingIndex !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animation refs
  const drawBtnRef = useRef<HTMLButtonElement>(null);
  const discardBtnRef = useRef<HTMLButtonElement>(null);
  const cardElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardPosSnapshot = useRef<Map<string, DOMRect>>(new Map());
  /** Pending FLIP old positions from rearrange — consumed by useLayoutEffect on localOrder change */
  const pendingReflowPositions = useRef<Map<string, number> | null>(null);
  const prevCardsRef = useRef<Card[]>(cards);
  const prevPlayerIdRef = useRef(playerId);

  // Animation state
  const [enteringAnims, setEnteringAnims] = useState<Map<string, EnteringAnim>>(new Map());
  const enteringAnimsRef = useRef(enteringAnims);
  enteringAnimsRef.current = enteringAnims;
  const [departingAnims, setDepartingAnims] = useState<Map<string, DepartingAnim>>(new Map());
  // (simplifiedHidden removed — fast mode uses normal animations at 2x speed)
  const [shuffling, setShuffling] = useState(false);
  const [shuffleDisplayCount, setShuffleDisplayCount] = useState(0);
  const shuffleAnimRef = useRef<{ target: number; startTime: number; duration: number } | null>(null);
  const prevDeckSizeRef = useRef(deckSize);
  const prevDiscardCountRef = useRef(discardCount);
  const prevDeckCardIdsRef = useRef<Set<string>>(new Set(deckCards.map(c => c.id)));
  const discardAllFiredRef = useRef(false);
  // Cards drawn during a shuffle — held back until shuffle animation finishes
  const deferredDrawnCardsRef = useRef<Set<string>>(new Set());
  // Bumped when deferred cards need Phase 2 re-computation after shuffle ends
  const [phase2Trigger, setPhase2Trigger] = useState(0);
  // Separate prev-cards tracking for shuffle detection (useLayoutEffect updates prevCardsRef before useEffect)
  const prevCardsForShuffleRef = useRef(cards);

  // Force shuffle animation from parent (intro sequence)
  useEffect(() => {
    if (forceShuffleAnim) {
      setShuffling(true);
      setShuffleDisplayCount(0);
      sound.deckShuffle();
      const duration = Math.round(2500 * (animSpeed || 0.5));
      shuffleAnimRef.current = { target: deckSize, startTime: performance.now(), duration };
    } else if (forceShuffleAnim === false) {
      setShuffling(false);
    }
  }, [forceShuffleAnim]); // eslint-disable-line react-hooks/exhaustive-deps

  // ResizeObserver for card overlap
  useEffect(() => {
    if (!handContainerRef.current || cards.length <= 1) {
      setCardMarginLeft(CARD_GAP);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const available = entry.contentRect.width;
      const naturalWidth = cards.length * CARD_WIDTH + (cards.length - 1) * CARD_GAP;
      if (naturalWidth <= available) {
        setCardMarginLeft(CARD_GAP);
      } else {
        const margin = Math.max(
          -CARD_WIDTH * 0.82,
          (available - cards.length * CARD_WIDTH) / (cards.length - 1),
        );
        setCardMarginLeft(margin);
      }
    });
    observer.observe(handContainerRef.current);
    return () => observer.disconnect();
  }, [cards.length]);

  // Shuffle detection: discard pile was moved to draw pile during a draw.
  // MUST be declared before Phase 1 so it runs first in the same commit,
  // setting deferredDrawnCardsRef before Phase 1 checks it.
  useLayoutEffect(() => {
    const prevDeck = prevDeckSizeRef.current;
    const prevDiscard = prevDiscardCountRef.current;
    const prevDeckIds = prevDeckCardIdsRef.current;
    prevDeckSizeRef.current = deckSize;
    prevDiscardCountRef.current = discardCount;
    const currDeckIds = new Set(deckCards.map(c => c.id));
    prevDeckCardIdsRef.current = currDeckIds;

    const prev = prevCardsForShuffleRef.current;
    prevCardsForShuffleRef.current = cards;

    // A shuffle happened when:
    // - Draw pile was empty (or nearly so) and is now replenished
    // - Discard pile shrank (cards moved from discard → draw pile)
    // - New cards appeared in hand (a draw was attempted)
    // - OR deck contents changed even if counts stayed the same (Heady Brew swap)
    const newCardIds = cards.filter(c => !prev.some(p => p.id === c.id)).map(c => c.id);
    const hasNewCards = newCardIds.length > 0;
    const discardMovedToDraw = prevDiscard > 0 && discardCount < prevDiscard;
    const deckReplenished = deckSize > prevDeck || (prevDeck === 0 && deckSize >= 0 && discardMovedToDraw);
    // Detect Heady Brew: deck contents changed even though counts may be equal (swap)
    const deckContentsChanged = currDeckIds.size > 0 && prevDeckIds.size > 0 &&
      [...currDeckIds].some(id => !prevDeckIds.has(id));
    const isSwapShuffle = deckContentsChanged && (prevDiscard > 0 || prevDeck > 0);

    if ((discardMovedToDraw && deckReplenished || isSwapShuffle) && !animationOff) {
      // Mark the newly drawn cards as deferred — they'll animate in after shuffle completes
      if (hasNewCards) {
        deferredDrawnCardsRef.current = new Set(newCardIds);
      }
      setShuffling(true);
      setShuffleDisplayCount(0);
      sound.deckShuffle();
      const duration = Math.round(2500 * (animSpeed || 0.5));
      shuffleAnimRef.current = { target: deckSize, startTime: performance.now(), duration };
    } else if (hasNewCards && shuffling && !animationOff) {
      // Cards drawn while shuffle is already in progress (e.g. test mode draw button)
      // — add them to the deferred set so they animate in after shuffle ends
      const existing = deferredDrawnCardsRef.current;
      deferredDrawnCardsRef.current = new Set([...existing, ...newCardIds]);
    }
  }, [deckSize, discardCount, cards, deckCards, animated, animationOff, shuffling]);

  // Phase 1: Detect hand changes.
  // New cards are registered immediately with a placeholder offset (offsetComputed: false).
  // Their real draw-pile offset is computed in Phase 2 once localOrder has been flushed and
  // their DOM elements actually exist.
  useLayoutEffect(() => {
    // On player switch: reset without animating
    const playerSwitched = prevPlayerIdRef.current !== playerId;
    prevPlayerIdRef.current = playerId;
    if (playerSwitched) {
      prevCardsRef.current = cards;
      setEnteringAnims(new Map());
      setDepartingAnims(new Map());
      return;
    }

    const prev = prevCardsRef.current;
    prevCardsRef.current = cards;

    const prevIds = new Set(prev.map(c => c.id));
    const currIds = new Set(cards.map(c => c.id));
    const newCards = cards.filter(c => !prevIds.has(c.id));
    const removedCards = prev.filter(c => !currIds.has(c.id));

    if (newCards.length === 0 && removedCards.length === 0) return;

    if (!animated) {
      // Off mode: no animations or delays at all
      return;
    }

    // Register entering cards with placeholder offset — Phase 2 will compute the real offset
    // Skip cards that are deferred (waiting for shuffle animation to complete)
    if (newCards.length > 0) {
      const deferred = deferredDrawnCardsRef.current;
      const immediateCards = deferred.size > 0 ? newCards.filter(c => !deferred.has(c.id)) : newCards;
      if (immediateCards.length > 0) {
        const entries = new Map<string, EnteringAnim>();
        immediateCards.forEach((card, i) => {
          entries.set(card.id, {
            offset: { x: 0, y: 0 },
            delay: Math.round(i * 500 * animSpeed),
            active: false,
            offsetComputed: false,
            startRotation: (Math.random() - 0.5) * 16, // ±8deg random tilt from draw pile
            arcHeight: CARD_MIN_HEIGHT + (Math.random() - 0.5) * 20, // ~card height ± jitter
          });
        });
        setEnteringAnims(p => new Map([...p, ...entries]));
      }
    }

    // FLIP reflow: snapshot old positions of surviving cards before processing departures
    // cardPosSnapshot has rects from the previous render (before removal)
    const survivingOldPositions = new Map<string, number>();
    if (removedCards.length > 0 && animated) {
      for (const card of cards) {
        const oldRect = cardPosSnapshot.current.get(card.id);
        if (oldRect) survivingOldPositions.set(card.id, oldRect.left);
      }
    }

    // Departing cards: snapshot position is available now (card was in DOM last render)
    if (removedCards.length > 0) {
      const discardRect = discardBtnRef.current?.getBoundingClientRect();
      if (discardRect) {
        const discardCx = discardRect.left + discardRect.width / 2;
        const discardCy = discardRect.top + discardRect.height / 2;

        const departing = new Map<string, DepartingAnim>();
        removedCards.forEach(card => {
          const rect = cardPosSnapshot.current.get(card.id);
          if (!rect) return;

          let toX: number;
          let toY: number;
          let shrink = false;
          const isTrashed = trashedCardIds?.has(card.id) ?? false;
          const isPlayed = lastPlayedTarget && lastPlayedTarget.cardId === card.id;
          const hasDrag = isPlayed && lastPlayedTarget.dragX != null && lastPlayedTarget.dragY != null;

          // Start position: from drag ghost if dragged, otherwise from hand
          const startX = hasDrag ? lastPlayedTarget.dragX! - rect.width / 2 : rect.left;
          const startY = hasDrag ? lastPlayedTarget.dragY! - 6 : rect.top;

          if (isTrashed) {
            // Trashed cards animate upward from current position
            toX = startX;
            toY = startY - 180;
          } else if (isPlayed) {
            if (lastPlayedTarget.screenX !== null && lastPlayedTarget.screenY !== null) {
              // Targeting card → animate to tile position
              toX = lastPlayedTarget.screenX - rect.width / 2;
              toY = lastPlayedTarget.screenY - rect.height / 2;
              shrink = true;
            } else {
              // Non-targeting card (engine) → "thrown" with momentum from drag velocity
              const vx = lastPlayedTarget.dragVelocityX ?? 0;
              const THROW_DISTANCE = 150; // base px to travel
              toX = startX + vx * THROW_DISTANCE;
              toY = startY - 80; // drift upward slightly
              shrink = true;
            }
          } else {
            // Default: animate to discard pile
            toX = discardCx - rect.width / 2;
            toY = discardCy - rect.height / 2;
          }

          // Random rotation for discard animations (cards "tossed" to pile)
          const endRotation = (Math.random() - 0.5) * 20; // ±10deg

          departing.set(card.id, {
            card,
            startX, startY,
            toX, toY,
            width: rect.width, height: rect.height,
            active: false,
            shrink,
            trash: isTrashed,
            endRotation,
          });
        });

        if (departing.size > 0) {
          // Sound: play vs discard
          const hasPlayTarget = [...departing.values()].some(d => d.shrink);
          if (hasPlayTarget) sound.cardPlay(); else sound.cardDiscard();
          setDepartingAnims(p => new Map([...p, ...departing]));
          requestAnimationFrame(() => {
            setDepartingAnims(p => {
              const next = new Map(p);
              for (const id of departing.keys()) {
                const d = next.get(id);
                if (d) next.set(id, { ...d, active: true });
              }
              return next;
            });
          });
          setTimeout(() => {
            setDepartingAnims(p => {
              const next = new Map(p);
              for (const id of departing.keys()) next.delete(id);
              return next;
            });
          }, 560);
        }
      }

      // Simple reflow: snap surviving cards to old positions, then smoothly
      // transition to new positions using a forced reflow (no rAF needed).
      if (survivingOldPositions.size > 0) {
        const flipEntries: { el: HTMLDivElement; dx: number }[] = [];
        for (const [id, oldLeft] of survivingOldPositions) {
          const el = cardElRefs.current.get(id);
          if (!el) continue;
          const newRect = el.getBoundingClientRect();
          const dx = oldLeft - newRect.left;
          if (Math.abs(dx) > 1) flipEntries.push({ el, dx });
        }
        if (flipEntries.length > 0) {
          // 1. Snap to old positions (no transition)
          for (const { el, dx } of flipEntries) {
            el.style.transition = 'none';
            el.style.transform = `translateX(${dx}px)`;
          }
          // 2. Force reflow so browser registers the snap
          void document.body.offsetHeight;
          // 3. Animate to new positions
          for (const { el } of flipEntries) {
            el.style.transition = 'transform 0.25s ease-out';
            el.style.transform = '';
          }
          // 4. Clean up inline styles after animation
          setTimeout(() => {
            for (const { el } of flipEntries) {
              el.style.transition = '';
              el.style.transform = '';
            }
          }, 300);
        }
      }
    }
  }, [cards, animated, animationOff, playerId, lastPlayedTarget]);

  // Phase 2: Compute real draw-pile offsets once card elements are in the DOM.
  // This fires when localOrder updates (which flushes after localOrder's useEffect runs,
  // guaranteeing card divs exist). Uses enteringAnimsRef to avoid re-triggering on anim state changes.
  useLayoutEffect(() => {
    const current = enteringAnimsRef.current;
    const uncomputed = [...current.entries()].filter(([, a]) => !a.offsetComputed);
    if (uncomputed.length === 0) return;

    const drawRect = drawBtnRef.current?.getBoundingClientRect();
    if (!drawRect) return;

    const drawCx = drawRect.left + drawRect.width / 2;
    const drawCy = drawRect.top + drawRect.height / 2;

    const resolved: [string, EnteringAnim][] = [];
    for (const [id, anim] of uncomputed) {
      const el = cardElRefs.current.get(id);
      if (!el) continue; // element not in DOM yet — will retry when localOrder updates
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      resolved.push([id, { ...anim, offset: { x: drawCx - cx, y: drawCy - cy }, offsetComputed: true }]);
    }

    if (resolved.length === 0) return;

    // Apply the real initial offsets (no transition: cards jump to draw-pile position invisibly)
    setEnteringAnims(p => {
      const next = new Map(p);
      for (const [id, anim] of resolved) next.set(id, anim);
      return next;
    });

    // Schedule a draw sound for each card, timed to its stagger delay
    // Skip cards that are deferred (waiting for shuffle) — they'll get sounds when shuffle ends
    const deferred = deferredDrawnCardsRef.current;
    const drawTimers: ReturnType<typeof setTimeout>[] = [];
    for (const [id, anim] of resolved) {
      if (deferred.has(id)) continue;
      if (anim.delay <= 0) {
        soundRef.current.cardDraw();
      } else {
        drawTimers.push(setTimeout(() => soundRef.current.cardDraw(), anim.delay));
      }
    }

    // Next frame: activate transitions — cards slide from draw pile to their slots
    // Skip deferred cards (waiting for shuffle to finish) — they'll be activated post-shuffle
    requestAnimationFrame(() => {
      const deferredNow = deferredDrawnCardsRef.current;
      setEnteringAnims(p => {
        const next = new Map(p);
        for (const [id] of resolved) {
          if (deferredNow.has(id)) continue; // don't activate during shuffle
          const a = next.get(id);
          if (a?.offsetComputed && !a.active) {
            next.set(id, { ...a, active: true });
          }
        }
        return next;
      });
    });

    // Clean up after all staggered animations finish
    // Only clean up non-deferred cards; deferred ones will be cleaned up post-shuffle
    const nonDeferred = resolved.filter(([id]) => !deferred.has(id));
    if (nonDeferred.length > 0) {
      const maxDelay = Math.max(...nonDeferred.map(([, a]) => a.delay));
      setTimeout(() => {
        setEnteringAnims(p => {
          const next = new Map(p);
          for (const [id] of nonDeferred) next.delete(id);
          return next;
        });
      }, maxDelay + 600);
    }
  }, [localOrder, phase2Trigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reflow for rearrange: when localOrder changes from a drag-reorder,
  // pendingReflowPositions has the pre-reorder positions.
  useLayoutEffect(() => {
    const oldPositions = pendingReflowPositions.current;
    if (!oldPositions) return;
    pendingReflowPositions.current = null;

    const flipEntries: { el: HTMLDivElement; dx: number }[] = [];
    for (const [id, oldLeft] of oldPositions) {
      const el = cardElRefs.current.get(id);
      if (!el) continue;
      const newRect = el.getBoundingClientRect();
      const dx = oldLeft - newRect.left;
      if (Math.abs(dx) > 1) flipEntries.push({ el, dx });
    }
    if (flipEntries.length > 0) {
      for (const { el, dx } of flipEntries) {
        el.style.transition = 'none';
        el.style.transform = `translateX(${dx}px)`;
      }
      void document.body.offsetHeight;
      for (const { el } of flipEntries) {
        el.style.transition = 'transform 0.25s ease-out';
        el.style.transform = '';
      }
      setTimeout(() => {
        for (const { el } of flipEntries) {
          el.style.transition = '';
          el.style.transform = '';
        }
      }, 300);
    }
  }, [localOrder]);

  // Snapshot card positions every render so departing cards and FLIP reflow
  // know where cards were. Must run AFTER Phase 1 (change detection) and
  // Phase 2 (offset computation) so it captures post-processing positions.
  useLayoutEffect(() => {
    for (const [id, el] of cardElRefs.current.entries()) {
      cardPosSnapshot.current.set(id, el.getBoundingClientRect());
    }
  });

  // Discard-all animation: triggered by parent when turn ends
  useEffect(() => {
    if (!discardAll || discardAllFiredRef.current) return;
    discardAllFiredRef.current = true;

    if (animationOff || cards.length === 0) {
      onDiscardAllComplete?.();
      return;
    }

    const discardRect = discardBtnRef.current?.getBoundingClientRect();
    if (!discardRect) {
      onDiscardAllComplete?.();
      return;
    }

    const discardCx = discardRect.left + discardRect.width / 2;
    const discardCy = discardRect.top + discardRect.height / 2;
    const departing = new Map<string, DepartingAnim>();

    cards.forEach(card => {
      const rect = cardPosSnapshot.current.get(card.id) ?? cardElRefs.current.get(card.id)?.getBoundingClientRect();
      if (!rect) return;
      departing.set(card.id, {
        card,
        startX: rect.left, startY: rect.top,
        toX: discardCx - rect.width / 2, toY: discardCy - rect.height / 2,
        width: rect.width, height: rect.height,
        active: false,
        shrink: false,
        trash: false,
        endRotation: (Math.random() - 0.5) * 20,
      });
    });

    if (departing.size === 0) {
      onDiscardAllComplete?.();
      return;
    }

    const duration = Math.round(500 * animSpeed);

    setDepartingAnims(p => new Map([...p, ...departing]));
    requestAnimationFrame(() => {
      setDepartingAnims(p => {
        const next = new Map(p);
        for (const id of departing.keys()) {
          const d = next.get(id);
          if (d) next.set(id, { ...d, active: true });
        }
        return next;
      });
    });

    setTimeout(() => {
      setDepartingAnims(p => {
        const next = new Map(p);
        for (const id of departing.keys()) next.delete(id);
        return next;
      });
      onDiscardAllComplete?.();
    }, duration + 60);
  }, [discardAll, cards, animated, animationOff, onDiscardAllComplete]);

  // Reset discard-all ref when discardAll goes back to false
  useEffect(() => {
    if (!discardAll) discardAllFiredRef.current = false;
  }, [discardAll]);

  // Animate shuffle count-up
  useEffect(() => {
    if (!shuffling || !shuffleAnimRef.current) return;
    const { target, duration } = shuffleAnimRef.current;
    const animStart = performance.now();
    let raf: number;
    const tick = () => {
      const elapsed = performance.now() - animStart;
      const progress = Math.min(1, elapsed / duration);
      setShuffleDisplayCount(Math.round(progress * target));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        // Count-up finished — end the shuffle in sync
        setShuffling(false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shuffling]);

  // When shuffle finishes, trigger entering animations for deferred drawn cards
  const prevShufflingRef = useRef(false);
  useEffect(() => {
    const wasShuffling = prevShufflingRef.current;
    prevShufflingRef.current = shuffling;
    if (wasShuffling && !shuffling && animated) {
      const deferred = deferredDrawnCardsRef.current;
      if (deferred.size > 0) {
        const deferredCards = cards.filter(c => deferred.has(c.id));
        if (deferredCards.length > 0) {
          const entries = new Map<string, EnteringAnim>();
          deferredCards.forEach((card, i) => {
            entries.set(card.id, {
              offset: { x: 0, y: 0 },
              delay: Math.round(i * 500 * animSpeed),
              active: false,
              offsetComputed: false,
              startRotation: (Math.random() - 0.5) * 16,
              arcHeight: CARD_MIN_HEIGHT + (Math.random() - 0.5) * 20,
            });
          });
          setEnteringAnims(p => new Map([...p, ...entries]));
          // Bump trigger so Phase 2 re-runs to compute offsets for these cards
          setPhase2Trigger(n => n + 1);
        }
        deferredDrawnCardsRef.current = new Set();
      }
    }
  }, [shuffling]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetDragState = useCallback(() => {
    dragStartRef.current = null;
    isDraggingRef.current = false;
    setDraggingIndex(null);
    setDragPos(null);
    setDropTargetIndex(null);
  }, [setDropTargetIndex]);

  /** Compute the drop target index from cursor position, or null if not over the hand. */
  const computeDropTarget = useCallback((clientX: number, clientY: number): { isOverHand: boolean; dropIdx: number | null } => {
    const container = handContainerRef.current;
    if (!container) return { isOverHand: false, dropIdx: null };
    const rect = container.getBoundingClientRect();
    const isOverHand = clientY >= rect.top - 20 && clientY <= rect.bottom + 20
      && clientX >= rect.left && clientX <= rect.right;
    if (!isOverHand) return { isOverHand: false, dropIdx: null };
    const cardEls = container.querySelectorAll('[data-card-slot]');
    let best = localOrder.length;
    let bestDist = Infinity;
    cardEls.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const centerX = r.left + r.width / 2;
      const dist = Math.abs(clientX - centerX);
      if (dist < bestDist) {
        bestDist = dist;
        best = clientX < centerX ? i : i + 1;
      }
    });
    return { isOverHand: true, dropIdx: best };
  }, [localOrder]);

  const handlePointerDown = useCallback((e: ReactPointerEvent, localIdx: number) => {
    if (disabled && !trashMode) return;
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, y: e.clientY, index: localIdx };
    isDraggingRef.current = false;
  }, [disabled, trashMode]);

  /** Core pointer-move logic, usable from both React and window events. */
  const processDragMove = useCallback((clientX: number, clientY: number) => {
    if (!dragStartRef.current) return;
    const dx = clientX - dragStartRef.current.x;
    const dy = clientY - dragStartRef.current.y;
    if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      if (!isDraggingRef.current) {
        isDraggingRef.current = true;
        onDragStart?.(localOrder[dragStartRef.current.index]);
        setHoveredIndex(null);
        setHoveredRect(null);
      }
      setDraggingIndex(dragStartRef.current.index);
      setDragPos({ x: clientX, y: clientY });

      // Feed horizontal cursor velocity into swing physics
      {
        const now = performance.now();
        const s = dragSwingRef.current;
        const dt = now - s.lastTime;
        if (dt > 0 && dt < 200) {
          const vx = (clientX - s.lastX) / dt; // px/ms
          s.velocity += vx * 0.25; // VELOCITY_SCALE
        }
        s.lastX = clientX;
        s.lastTime = now;
      }

      // Compute drop target index for reordering
      const { isOverHand, dropIdx } = computeDropTarget(clientX, clientY);
      setDropTargetIndex(isOverHand ? dropIdx : null);
    }
  }, [onDragStart, localOrder, computeDropTarget, setDropTargetIndex]);

  const handlePointerMove = useCallback((e: ReactPointerEvent) => {
    if (trashMode) return; // Disable dragging in trash selection mode
    processDragMove(e.clientX, e.clientY);
  }, [trashMode, processDragMove]);

  const handlePointerUp = useCallback((e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    const localIdx = dragStartRef.current.index;

    // In trash selection mode, clicks toggle trash selection
    if (trashMode && !isDraggingRef.current) {
      const cardIdx = localOrder[localIdx];
      if (cardIdx !== trashMode.playedCardIndex) {
        onTrashToggle?.(cardIdx);
      }
      resetDragState();
      return;
    }

    if (isDraggingRef.current) {
      onDragEnd?.();
      // Compute drop target fresh from cursor position to avoid stale React state
      const { isOverHand, dropIdx } = computeDropTarget(e.clientX, e.clientY);

      if (isOverHand && dropIdx !== null) {
        // FLIP reflow: snapshot old positions before reorder (consumed by useLayoutEffect)
        if (animated) {
          const oldPositions = new Map<string, number>();
          for (const card of cards) {
            const el = cardElRefs.current.get(card.id);
            if (el) oldPositions.set(card.id, el.getBoundingClientRect().left);
          }
          pendingReflowPositions.current = oldPositions;
        }
        setLocalOrder(prev => {
          const next = [...prev];
          const [moved] = next.splice(localIdx, 1);
          const insertAt = dropIdx > localIdx ? dropIdx - 1 : dropIdx;
          next.splice(insertAt, 0, moved);
          return next;
        });
      } else {
        // Compute cursor velocity for thrown momentum
        const s = dragSwingRef.current;
        const now = performance.now();
        const dt = now - s.lastTime;
        const vx = dt > 0 && dt < 200 ? (e.clientX - s.lastX) / dt : 0;
        onDragPlay(localOrder[localIdx], e.clientX, e.clientY, vx, 0);
      }
    } else {
      const cardIdx = localOrder[localIdx];
      onSelect(cardIdx);
    }
    resetDragState();
  }, [onSelect, onDragPlay, onDragEnd, selectedIndex, cards, localOrder, computeDropTarget, resetDragState, trashMode, onTrashToggle]);

  // If pointer capture is lost (e.g. card removed from DOM mid-drag) without
  // a preceding pointerup, reset drag state. The window pointerup listener will
  // handle the action if the user is still dragging and releases later.
  const handleLostPointerCapture = useCallback(() => {
    // Don't reset if the drag already completed (dragStartRef cleared by handlePointerUp)
    if (!dragStartRef.current) return;
    // Pointer capture lost mid-drag — the window pointerup listener will
    // handle the actual drop when the user releases. Nothing to do here.
  }, []);

  // Window-level pointer listeners: since we don't use setPointerCapture (it can be
  // lost during React re-renders), we track pointermove/pointerup on window during drags.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragStartRef.current) return;
      processDragMove(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragStartRef.current) return;
      if (isDraggingRef.current) {
        onDragEnd?.();
        const localIdx = dragStartRef.current.index;
        const { isOverHand, dropIdx } = computeDropTarget(e.clientX, e.clientY);
        if (isOverHand && dropIdx !== null) {
          // Reorder within hand
          if (animated) {
            const oldPositions = new Map<string, number>();
            for (const card of cards) {
              const el = cardElRefs.current.get(card.id);
              if (el) oldPositions.set(card.id, el.getBoundingClientRect().left);
            }
            pendingReflowPositions.current = oldPositions;
          }
          setLocalOrder(prev => {
            const next = [...prev];
            const [moved] = next.splice(localIdx, 1);
            const insertAt = dropIdx > localIdx ? dropIdx - 1 : dropIdx;
            next.splice(insertAt, 0, moved);
            return next;
          });
        } else {
          // Play to grid
          const s = dragSwingRef.current;
          const now = performance.now();
          const dt = now - s.lastTime;
          const vx = dt > 0 && dt < 200 ? (e.clientX - s.lastX) / dt : 0;
          onDragPlay(localOrder[localIdx], e.clientX, e.clientY, vx, 0);
        }
      }
      resetDragState();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onDragEnd, onDragPlay, localOrder, computeDropTarget, resetDragState, processDragMove, cards, animated]);

  const handlePointerEnter = useCallback((e: ReactPointerEvent, localIdx: number) => {
    if (!isDraggingRef.current) {
      setHoveredIndex(localIdx);
      setHoveredRect((e.currentTarget as HTMLElement).getBoundingClientRect());
    }
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!isDraggingRef.current) {
      setHoveredIndex(null);
      setHoveredRect(null);
    }
  }, []);

  const drawPileCards = [{ label: 'Draw Pile', items: deckCards }];

  // Fixed button width so cards never push buttons around
  const BTN_WIDTH = 62;

  const iconBtnStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: '4px 10px',
    background: '#2a2a3e',
    border: '1px solid #444',
    borderRadius: 8,
    color: '#fff',
    cursor: 'pointer',
    width: BTN_WIDTH,
    minHeight: CARD_MIN_HEIGHT,
    flexShrink: 0,
    userSelect: 'none',
    position: 'relative',
    zIndex: 200,
    alignSelf: 'stretch',
    boxSizing: 'border-box',
  };

  // Generate dynamic keyframes CSS for entering (draw) arc animations
  // Uses evenly spaced keyframes with smooth interpolation for natural card movement
  const enterKeyframesCss = useMemo(() => {
    const lines: string[] = [];
    for (const [id, anim] of enteringAnims) {
      if (!anim.active || !anim.offsetComputed) continue;
      const name = `cardEnter_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const ox = anim.offset.x, oy = anim.offset.y;
      const arc = anim.arcHeight;
      const rot = anim.startRotation;
      // Smooth arc: sample points along a parabolic path
      const p = (t: number) => ({
        x: ox * (1 - t),
        y: oy * (1 - t) - arc * 4 * t * (1 - t), // parabolic arc peaking at t=0.5
        r: rot * (1 - t),
        o: Math.min(1, t * 5), // fade in over first 20%
      });
      const k = [0, 0.25, 0.5, 0.75, 1].map(t => p(t));
      lines.push(`@keyframes ${name} {
  0%   { transform: translate(${k[0].x}px, ${k[0].y}px) rotate(${k[0].r}deg); opacity: ${k[0].o}; }
  25%  { transform: translate(${k[1].x}px, ${k[1].y}px) rotate(${k[1].r}deg); opacity: ${k[1].o}; }
  50%  { transform: translate(${k[2].x}px, ${k[2].y}px) rotate(${k[2].r}deg); opacity: ${k[2].o}; }
  75%  { transform: translate(${k[3].x}px, ${k[3].y}px) rotate(${k[3].r}deg); opacity: ${k[3].o}; }
  100% { transform: translate(0px, 0px) rotate(0deg); opacity: 1; }
}`);
    }
    return lines.join('\n');
  }, [enteringAnims]);

  // Generate dynamic keyframes CSS for departing (discard) arc animations
  const departKeyframesCss = useMemo(() => {
    const lines: string[] = [];
    for (const [, d] of departingAnims) {
      if (d.trash || d.shrink) continue; // only arc for discard-pile animations
      const name = `cardDepart_${d.card.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const dx = d.toX - d.startX;
      const dy = d.toY - d.startY;
      const arc = CARD_MIN_HEIGHT + (Math.abs(d.endRotation) / 10) * 15;
      const endRot = d.endRotation;
      // Smooth arc: sample points along a parabolic path
      const p = (t: number) => ({
        x: dx * t,
        y: dy * t - arc * 4 * t * (1 - t), // parabolic arc
        r: endRot * t,
        o: Math.max(0, 1 - t * t), // ease out opacity quadratically
      });
      const k = [0, 0.25, 0.5, 0.75, 1].map(t => p(t));
      lines.push(`@keyframes ${name} {
  0%   { transform: translate(0px, 0px) rotate(0deg); opacity: 1; }
  25%  { transform: translate(${k[1].x}px, ${k[1].y}px) rotate(${k[1].r}deg); opacity: ${k[1].o.toFixed(2)}; }
  50%  { transform: translate(${k[2].x}px, ${k[2].y}px) rotate(${k[2].r}deg); opacity: ${k[2].o.toFixed(2)}; }
  75%  { transform: translate(${k[3].x}px, ${k[3].y}px) rotate(${k[3].r}deg); opacity: ${k[3].o.toFixed(2)}; }
  100% { transform: translate(${dx}px, ${dy}px) rotate(${endRot}deg); opacity: 0; }
}`);
    }
    return lines.join('\n');
  }, [departingAnims]);

  return (
    <>
      {/* Grid layout: [button | cards | button] — columns are fixed so buttons never shift */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `${BTN_WIDTH}px 1fr ${BTN_WIDTH}px`,
        gap: 8,
        touchAction: 'none',
        alignItems: 'stretch',
      }}>
        {/* Deck icon + shuffle tooltip */}
        <div style={{ position: 'relative', alignSelf: 'stretch', zIndex: 201 }}>
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 10,
            whiteSpace: 'nowrap',
            background: '#111122',
            border: '2px solid #fff',
            borderRadius: 10,
            padding: '10px 20px',
            fontSize: 18,
            fontWeight: 'bold',
            boxShadow: '0 4px 20px rgba(255, 255, 255, 0.4)',
            zIndex: 10000,
            pointerEvents: 'none',
            letterSpacing: 1,
            opacity: shuffling ? 1 : 0,
            transition: 'opacity 0.3s ease',
            display: 'flex',
          }}>
            <style>{`
              @keyframes shuffleWave {
                0%, 100% { color: #888; }
                50% { color: #fff; }
              }
            `}</style>
            {'Shuffling...'.split('').map((ch, i) => (
              <span key={i} style={{
                animation: shuffling ? `shuffleWave 1.2s ease-in-out ${i * 0.08}s infinite` : 'none',
                color: '#888',
              }}>
                {ch}
              </span>
            ))}
          </div>
          <button
            className="hud-btn"
            ref={drawBtnRef}
            onClick={() => setShowDeckPopup(true)}
            title="View cards in draw pile"
            style={{
              ...iconBtnStyle,
              ...(shuffling ? {
                animation: animated
                  ? 'shufflePulse 0.4s ease-in-out infinite'
                  : 'shufflePulse 0.25s ease-in-out infinite',
                boxShadow: '0 0 12px rgba(255, 255, 255, 0.6)',
                borderColor: '#fff',
              } : {}),
            }}
          >
            <span style={{ fontSize: 24, fontWeight: 'bold', color: '#fff', lineHeight: 1 }}>
              {shuffling ? shuffleDisplayCount : deckSize}
            </span>
            <span style={{ fontSize: 9, color: '#888' }}>Draw</span>
          </button>
        </div>

        {/* Cards container */}
        <div
          ref={handContainerRef}
          style={{
            minWidth: 0,
            minHeight: CARD_MIN_HEIGHT,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          {cards.length === 0 && !shuffling && (
            <div style={{ color: '#555', fontStyle: 'italic', fontSize: 13, alignSelf: 'center' }}>
              No cards in hand
            </div>
          )}
          {localOrder.map((cardIdx, localIdx) => {
            const card = cards[cardIdx];
            if (!card) return null;
            const isBeingDragged = draggingIndex === localIdx;
            const isSelected = selectedIndex === cardIdx;
            const typeColor = CARD_TYPE_COLORS[card.card_type] || '#555';
            const isDropBefore = dropTargetIndex === localIdx;
            const isDropAfter = dropTargetIndex === localOrder.length && localIdx === localOrder.length - 1;

            // Trash mode states
            const isTrashPlayed = trashMode?.playedCardIndex === cardIdx;
            const isTrashSelected = trashMode?.selectedIndices.has(cardIdx) ?? false;
            const isTrashSelectable = trashMode != null && !isTrashPlayed;

            // Compute animation overrides
            const entering = enteringAnims.get(card.id);
            const isDeferredDuringShuffle = shuffling && deferredDrawnCardsRef.current.has(card.id);
            // Hide cards when discard-all animation is playing (portal ghosts are visible instead)
            const isDiscardingAll = discardAll && departingAnims.has(card.id);
            const isAnimating = (!!entering && !entering.active) || isDiscardingAll || isDeferredDuringShuffle;
            const isClaimBanned = claimBanned && card.card_type === 'claim';
            const isHovered = hoveredIndex === localIdx && !isBeingDragged && !trashMode && !isAnimating;
            // FLIP reflow transforms are applied directly to DOM elements (not via React state)
            const baseTransform = isSelected && !isBeingDragged ? 'translateY(-6px)' : isHovered ? 'translateY(-4px)' : 'translateY(0)';
            let cardTransform = baseTransform;
            let cardOpacity: number = isDeferredDuringShuffle ? 0 : isDiscardingAll ? 0 : isBeingDragged ? 0.3 : isClaimBanned ? 0.4 : 1;
            let cardTransition = animated
              ? 'border-color 0.1s, box-shadow 0.1s, transform 0.1s'
              : 'none';

            let cardAnimation: string | undefined;
            if (entering) {
              if (!entering.active) {
                // Placed at draw pile position with random rotation, no transition yet
                cardTransform = `translate(${entering.offset.x}px, ${entering.offset.y}px) rotate(${entering.startRotation}deg)`;
                cardOpacity = 0;
                cardTransition = 'none';
              } else {
                // Arc animation via @keyframes: draw pile → arc up → hand position
                const enterDur = Math.round(500 * animSpeed);
                const animName = `cardEnter_${card.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
                cardTransform = 'translate(0, 0) rotate(0deg)';
                cardOpacity = 1;
                cardTransition = 'none';
                cardAnimation = `${animName} ${enterDur}ms linear ${entering.delay}ms both`;
              }
            }

            return (
              <div
                key={card.id}
                ref={el => {
                  if (el) cardElRefs.current.set(card.id, el);
                  else cardElRefs.current.delete(card.id);
                }}
                data-card-slot={localIdx}
                onPointerDown={(e) => handlePointerDown(e, localIdx)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onLostPointerCapture={handleLostPointerCapture}
                onPointerEnter={(e) => handlePointerEnter(e, localIdx)}
                onPointerLeave={handlePointerLeave}
                onDoubleClick={() => {
                  if (!disabled && !trashMode && onDoubleClick) {
                    setHoveredIndex(null);
                    setHoveredRect(null);
                    onDoubleClick(localOrder[localIdx]);
                  }
                }}
                role="button"
                tabIndex={-1}
                style={{
                  width: CARD_WIDTH,
                  height: CARD_MIN_HEIGHT,
                  flexShrink: 0,
                  marginLeft: localIdx === 0 ? 0 : cardMarginLeft,
                  padding: 6,
                  background: isTrashSelected ? '#5a2020' : isTrashPlayed ? '#1a3a1a' : isSelected ? '#3a3a6e' : '#2a2a3e',
                  border: `2px solid ${isTrashSelected ? '#ff4444' : isTrashPlayed ? '#4aff6a' : isSelected ? '#fff' : typeColor}`,
                  borderRadius: 6,
                  color: '#fff',
                  pointerEvents: isAnimating ? 'none' as const : 'auto' as const,
                  cursor: trashMode ? (isTrashPlayed ? 'default' : 'pointer') : disabled ? 'not-allowed' : 'grab',
                  opacity: cardOpacity,
                  transition: cardTransition,
                  transform: isTrashSelected ? 'translateY(-8px)' : cardTransform,
                  animation: cardAnimation ?? 'none',
                  userSelect: 'none' as const,
                  WebkitUserSelect: 'none' as const,
                  overflow: 'hidden',
                  boxSizing: 'border-box' as const,
                  position: 'relative' as const,
                  zIndex: hoveredIndex === localIdx ? 100 : isSelected ? 10 : localIdx + 1,
                  boxShadow: isTrashSelected
                    ? '0 0 12px rgba(255, 68, 68, 0.5)'
                    : isDropBefore
                      ? '-3px 0 0 0 #fff, -6px 0 12px rgba(255,255,255,0.3)'
                      : isDropAfter
                        ? '3px 0 0 0 #fff, 6px 0 12px rgba(255,255,255,0.3)'
                        : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <div style={{ fontWeight: 'bold', fontSize: 14, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
                    <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
                      if (el) {
                        const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                        el.style.setProperty('--title-scale', String(scale));
                      }
                    }}>
                      {card.name}
                      {card.current_vp !== undefined && (
                        <span style={{
                          fontSize: 11,
                          fontWeight: 'bold',
                          color: card.current_vp > 0 ? '#ffd700' : card.current_vp < 0 ? '#ff6666' : '#888',
                          marginLeft: 4,
                        }}>
                          {card.current_vp > 0 ? '+' : ''}{card.current_vp}★
                        </span>
                      )}
                    </span>
                  </div>
                  <span style={{ fontSize: 13, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{card.buy_cost != null ? `${card.buy_cost}💰` : '—'}</span>
                </div>
                <div style={{ fontSize: 13, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
                    if (el) {
                      const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                      el.style.setProperty('--sub-scale', String(scale));
                    }
                  }}>
                  {buildCardSubtitle(card, subtitleContext).map((part, i) => renderSubtitlePart(part, i, { passiveVp: card.passive_vp, showDynamic: true }))}
                  </span>
                </div>
                {/* Icon overlay — shown when card is selected for trashing/discarding */}
                {isTrashSelected && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                    zIndex: 5,
                  }}>
                    <div style={{
                      fontSize: 28,
                      filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.8))',
                    }}>{trashMode?.label === 'Discard' ? '🃏↘' : '🗑️'}</div>
                  </div>
                )}
                {/* Dark overlay + "Playing" label on the card being played */}
                {isTrashPlayed && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(0, 0, 0, 0.55)',
                    borderRadius: 'inherit',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                    zIndex: 5,
                  }}>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 'bold',
                      color: '#4aff6a',
                      background: 'rgba(0,0,0,0.5)',
                      padding: '2px 6px',
                      borderRadius: 4,
                    }}>PLAYING</span>
                  </div>
                )}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(10, 10, 20, 0.55)',
                  borderRadius: 'inherit',
                  pointerEvents: 'none',
                  opacity: (disabled && !isDiscardingAll && !trashMode) ? 1 : 0,
                  transition: animated ? 'opacity 0.25s ease' : 'none',
                }} />
              </div>
            );
          })}
        </div>

        {/* Discard icon */}
        <button
          className="hud-btn"
          ref={discardBtnRef}
          data-discard-pile
          onClick={() => setShowDiscardPopup(true)}
          title="View discard pile"
          style={{ ...iconBtnStyle, opacity: discardCount === 0 ? 0.4 : 1 }}
        >
          <span style={{ fontSize: 24, fontWeight: 'bold', color: '#aaa', lineHeight: 1 }}>{discardCount}</span>
          <span style={{ fontSize: 9, color: '#888' }}>Discard</span>
        </button>
      </div>

      {/* Hover preview — appears above the hovered card */}
      {hoveredIndex !== null && hoveredRect && draggingIndex === null && cards[localOrder[hoveredIndex]] && (
        <CardPreview card={cards[localOrder[hoveredIndex]]} anchorRect={hoveredRect} />
      )}

      {/* Drag ghost */}
      {draggingIndex !== null && dragPos && cards[localOrder[draggingIndex]] && (() => {
        const dragCard = cards[localOrder[draggingIndex]];
        const dragColor = CARD_TYPE_COLORS[dragCard.card_type] || '#fff';
        return (
          <div style={{
            position: 'fixed',
            left: dragPos.x - CARD_WIDTH / 2,
            top: dragPos.y - 6,
            width: CARD_WIDTH,
            height: CARD_MIN_HEIGHT,
            padding: 6,
            background: '#3a3a6ecc',
            border: `2px solid ${dragColor}`,
            borderRadius: 6,
            color: '#fff',
            pointerEvents: 'none',
            zIndex: 9999,
            transformOrigin: 'top center',
            transform: `rotate(${dragSwingAngle}deg) scale(1.05)`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}>
            <CompactCardContent card={dragCard} titleSize={12} subtitleSize={12} subtitleCtx={subtitleContext} />
          </div>
        );
      })()}

      {/* Draw pile viewer popup */}
      {showDeckPopup && createPortal(
        <CardViewPopup
          title="Draw Pile"
          cards={drawPileCards}
          onClose={() => setShowDeckPopup(false)}
          note="Not shown in draw order"
        />,
        document.body,
      )}

      {/* Discard viewer popup */}
      {showDiscardPopup && createPortal(
        <CardViewPopup
          title="Discard Pile"
          cards={[{ label: 'Discard Pile', items: [...discardCards].reverse() }]}
          onClose={() => setShowDiscardPopup(false)}
          preserveOrder
          note="Shown in discard order, most recent first"
        />,
        document.body,
      )}

      {/* Departing card ghosts — animate from last position to target */}
      {departingAnims.size > 0 && createPortal(
        <>
          {[...departingAnims.values()].flatMap(d => {
            const typeColor = CARD_TYPE_COLORS[d.card.card_type] || '#555';
            const durMs = Math.round(500 * animSpeed);
            const fadeDurMs = Math.round(300 * animSpeed);

            if (d.trash) {
              // Trash tear animation: two halves split apart, rotate outward, rise up, fade out
              const dy = d.active ? d.toY - d.startY : 0;
              const halfW = d.width / 2;
              const cardContent = (
                <div style={{
                  width: d.width, padding: 6, background: '#2a2a3e',
                  border: `2px solid ${typeColor}`, borderRadius: 6,
                  color: '#fff', boxSizing: 'border-box',
                }}>
                  <CompactCardContent card={d.card} titleSize={12} subtitleSize={12} subtitleCtx={subtitleContext} />
                </div>
              );
              return [
                // Left half
                <div key={`${d.card.id}-L`} style={{
                  position: 'fixed', left: d.startX, top: d.startY,
                  width: halfW, height: d.height, overflow: 'hidden',
                  transform: d.active
                    ? `translate(${-12}px, ${dy}px) rotate(-8deg)`
                    : 'translate(0, 0) rotate(0deg)',
                  transformOrigin: 'right center',
                  opacity: d.active ? 0 : 1,
                  transition: d.active
                    ? `transform ${durMs}ms ease-in, opacity ${fadeDurMs}ms ease-in ${Math.round(durMs * 0.4)}ms`
                    : 'none',
                  pointerEvents: 'none', zIndex: 9990,
                }}>
                  <div style={{ width: d.width }}>{cardContent}</div>
                </div>,
                // Right half
                <div key={`${d.card.id}-R`} style={{
                  position: 'fixed', left: d.startX + halfW, top: d.startY,
                  width: halfW, height: d.height, overflow: 'hidden',
                  transform: d.active
                    ? `translate(${12}px, ${dy}px) rotate(8deg)`
                    : 'translate(0, 0) rotate(0deg)',
                  transformOrigin: 'left center',
                  opacity: d.active ? 0 : 1,
                  transition: d.active
                    ? `transform ${durMs}ms ease-in, opacity ${fadeDurMs}ms ease-in ${Math.round(durMs * 0.4)}ms`
                    : 'none',
                  pointerEvents: 'none', zIndex: 9990,
                }}>
                  <div style={{ width: d.width, marginLeft: -halfW }}>{cardContent}</div>
                </div>,
              ];
            }

            // Standard departing animation (play/discard)
            const isDiscardArc = !d.shrink; // discard-pile cards use arc animation
            const departAnimName = `cardDepart_${d.card.id.replace(/[^a-zA-Z0-9]/g, '_')}`;

            if (isDiscardArc) {
              // Discard pile: arc animation via @keyframes
              return (
                <div
                  key={d.card.id}
                  style={{
                    position: 'fixed',
                    left: d.startX,
                    top: d.startY,
                    width: d.width,
                    height: d.height,
                    animation: d.active ? `${departAnimName} ${durMs}ms linear forwards` : 'none',
                    pointerEvents: 'none',
                    zIndex: 9990,
                    padding: 6,
                    background: '#2a2a3e',
                    border: `2px solid ${typeColor}`,
                    borderRadius: 6,
                    color: '#fff',
                    boxSizing: 'border-box',
                  }}
                >
                <CompactCardContent card={d.card} titleSize={12} subtitleSize={12} subtitleCtx={subtitleContext} />
              </div>
              );
            }

            // Played cards (shrink toward tile): CSS transition, no arc
            const dx = d.active ? d.toX - d.startX : 0;
            const dy = d.active ? d.toY - d.startY : 0;
            const rot = d.active ? `rotate(${d.endRotation}deg)` : 'rotate(0deg)';
            return (
              <div
                key={d.card.id}
                style={{
                  position: 'fixed',
                  left: d.startX,
                  top: d.startY,
                  width: d.width,
                  height: d.height,
                  transform: `translate(${dx}px, ${dy}px) ${rot} scale(${d.active ? 0.3 : 1})`,
                  transformOrigin: 'center center',
                  opacity: d.active ? 0 : 1,
                  transition: d.active
                    ? `transform ${durMs}ms ease-in, opacity ${fadeDurMs}ms ease-in`
                    : 'none',
                  pointerEvents: 'none',
                  zIndex: 9990,
                  padding: 6,
                  background: '#2a2a3e',
                  border: `2px solid ${typeColor}`,
                  borderRadius: 6,
                  color: '#fff',
                  boxSizing: 'border-box',
                }}
              >
                <CompactCardContent card={d.card} titleSize={12} subtitleSize={12} subtitleCtx={subtitleContext} />
              </div>
            );
          })}
        </>,
        document.body,
      )}

      {/* Keyframes for draw/discard arc animations + shuffle */}
      <style>{`
        ${enterKeyframesCss}
        ${departKeyframesCss}
        @keyframes shufflePulse {
          0%, 100% { transform: rotate(0deg) scale(1); }
          25% { transform: rotate(-3deg) scale(1.05); }
          75% { transform: rotate(3deg) scale(1.05); }
        }
        @keyframes dynamicGlow {
          0%, 100% { text-shadow: 0 0 4px rgba(255,225,77,0.3); }
          50% { text-shadow: 0 0 8px rgba(255,225,77,0.8), 0 0 12px rgba(255,200,0,0.4); }
        }
        .dynamic-value {
          animation: dynamicGlow 2s ease-in-out infinite;
        }
      `}</style>
    </>
  );
}
