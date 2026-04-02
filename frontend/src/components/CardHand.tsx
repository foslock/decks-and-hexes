import { useRef, useCallback, useState, useEffect, useLayoutEffect, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import { useAnimated, useAnimationOff, useAnimationMode } from './SettingsContext';
import { renderWithKeywords } from './Keywords';
import CardFull, { CARD_FULL_WIDTH } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';

export interface PlayTarget {
  cardId: string;
  /** Screen pixel position for the target tile, or null for non-targeting cards */
  screenX: number | null;
  screenY: number | null;
}

interface CardHandProps {
  playerId: string;
  cards: Card[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onDragPlay: (cardIndex: number, screenX: number, screenY: number) => void;
  onCardDetail: (card: Card) => void;
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
}

const TYPE_COLORS: Record<string, string> = {
  claim: '#4a9eff',
  defense: '#4aff6a',
  engine: '#ffaa4a',
};

const CARD_EMOJI: Record<string, string> = {
  claim: '⚔️',
  defense: '🛡️',
  engine: '⚙️',
};

const ARCHETYPE_EMOJI: Record<string, string> = {
  vanguard: '🗡️',
  swarm: '🐝',
  fortress: '🏰',
  neutral: '⬜',
};

const DRAG_THRESHOLD = 12;
const CARD_WIDTH = 150;
const CARD_GAP = 6;
// Approximate rendered height of a hand card (padding + border + content)
// so the hand area stays consistent when empty
const CARD_MIN_HEIGHT = 62;

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

function CardStats({ card }: { card: Card }) {
  const parts: string[] = [];
  if (card.power > 0) parts.push(`Power ${card.power}`);
  if (card.resource_gain > 0) parts.push(`+${card.resource_gain} Resource${card.resource_gain !== 1 ? 's' : ''}`);
  if (card.draw_cards > 0) parts.push(`+${card.draw_cards} Card${card.draw_cards !== 1 ? 's' : ''}`);
  if (card.defense_bonus > 0) parts.push(`+${card.defense_bonus} Defense`);
  if (card.forced_discard > 0) parts.push(`-${card.forced_discard} Card${card.forced_discard !== 1 ? 's' : ''}`);
  return <span>{parts.length > 0 ? parts.join(', ') : '\u00a0'}</span>;
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
      <CardFull card={card} />
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
  const color = TYPE_COLORS[displayCard.card_type] || '#555';
  const upgradeLabel = shiftHeld && hasUpgradePreview(card) ? (
    <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 'bold', color: '#4aff6a', marginTop: 4 }}>
      Upgraded
    </div>
  ) : null;
  if (!full) {
    return (
      <div style={{
        width: 130,
        padding: 6,
        background: '#2a2a3e',
        border: `1px solid ${color}`,
        borderRadius: 6,
        color: '#fff',
        flexShrink: 0,
      }}>
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontWeight: 'bold', fontSize: 12 }}>
            {CARD_EMOJI[displayCard.card_type]} {displayCard.name}
          </div>
          <div style={{ fontSize: 11, color: '#aaa' }}>
            {displayCard.buy_cost !== null ? `💰 ${displayCard.buy_cost}` : 'Starter'}
            {(displayCard.power > 0 || displayCard.card_type === 'claim') && ` · Pow ${displayCard.power}`}
            {displayCard.resource_gain > 0 && ` · +${displayCard.resource_gain}`}
          </div>
        </div>
        {upgradeLabel}
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

// Persists view mode preference per popup title across opens (reset on page reload)
const viewModeMemory: Record<string, boolean> = {};

export function CardViewPopup({
  title,
  cards,
  onClose,
  defaultFull = false,
}: {
  title: string;
  cards: { label: string; items: Card[] }[];
  onClose: () => void;
  defaultFull?: boolean;
}) {
  const [fullView, setFullView] = useState(() => viewModeMemory[title] ?? defaultFull);
  const animMode = useAnimationMode();
  const shiftHeld = useShiftKey();
  const [visible, setVisible] = useState(animMode === 'off');
  const totalCount = cards.reduce((s, g) => s + g.items.length, 0);

  const toggleView = useCallback((full: boolean) => {
    setFullView(full);
    viewModeMemory[title] = full;
  }, [title]);

  useEffect(() => {
    if (animMode !== 'off') {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [animMode]);

  const overlayTransition = animMode === 'normal' ? 'opacity 0.25s ease'
    : animMode === 'simplified' ? 'opacity 0.1s ease'
    : 'none';
  const panelTransition = animMode === 'normal' ? 'opacity 0.25s ease, transform 0.25s ease'
    : animMode === 'simplified' ? 'opacity 0.1s ease, transform 0.1s ease'
    : 'none';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 5000,
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
          <span style={{ fontSize: 12, color: '#888' }}>({totalCount} cards)</span>
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
          {cards.map((group) => (
            <div key={group.label} style={{ marginBottom: 16 }}>
              {cards.length > 1 && (
                <div style={{ fontSize: 12, color: '#888', marginBottom: 8, fontWeight: 'bold' }}>
                  {group.label} ({group.items.length})
                </div>
              )}
              {group.items.length === 0 ? (
                <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic' }}>Empty</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {[...group.items].sort((a, b) => (a.buy_cost ?? -1) - (b.buy_cost ?? -1) || a.name.localeCompare(b.name)).map((card, i) => (
                    <CardPopupItem key={`${card.id}-${i}`} card={card} full={fullView} shiftHeld={shiftHeld} />
                  ))}
                </div>
              )}
            </div>
          ))}
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
}

export default function CardHand({
  playerId,
  cards,
  selectedIndex,
  onSelect,
  onDragPlay,
  onCardDetail,
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
}: CardHandProps) {
  const animated = useAnimated();
  const animationOff = useAnimationOff();
  const animMode = useAnimationMode();

  // Local display order — indices into the `cards` prop array
  const [localOrder, setLocalOrder] = useState<number[]>(() => cards.map((_, i) => i));

  useEffect(() => {
    setLocalOrder(prev => {
      const prevOrder = prev.filter(i => i < cards.length);
      if (prevOrder.length === cards.length) return prevOrder;
      return cards.map((_, i) => i);
    });
  }, [cards]);

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [showDeckPopup, setShowDeckPopup] = useState(false);
  const [showDiscardPopup, setShowDiscardPopup] = useState(false);
  const [cardMarginLeft, setCardMarginLeft] = useState(CARD_GAP);

  const handContainerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; index: number } | null>(null);
  const isDraggingRef = useRef(false);

  // Animation refs
  const drawBtnRef = useRef<HTMLButtonElement>(null);
  const discardBtnRef = useRef<HTMLButtonElement>(null);
  const cardElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const cardPosSnapshot = useRef<Map<string, DOMRect>>(new Map());
  const prevCardsRef = useRef<Card[]>(cards);
  const prevPlayerIdRef = useRef(playerId);

  // Animation state
  const [enteringAnims, setEnteringAnims] = useState<Map<string, EnteringAnim>>(new Map());
  const [departingAnims, setDepartingAnims] = useState<Map<string, DepartingAnim>>(new Map());
  const [simplifiedHidden, setSimplifiedHidden] = useState<Set<string>>(new Set());
  const [shuffling, setShuffling] = useState(false);
  const prevDeckSizeRef = useRef(deckSize);
  const prevDiscardCountRef = useRef(discardCount);
  const discardAllFiredRef = useRef(false);

  // Force shuffle animation from parent (intro sequence)
  useEffect(() => {
    if (forceShuffleAnim) setShuffling(true);
    else if (forceShuffleAnim === false) setShuffling(false);
  }, [forceShuffleAnim]);

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

  // Snapshot card positions every render so departing cards know where they were
  useLayoutEffect(() => {
    for (const [id, el] of cardElRefs.current.entries()) {
      cardPosSnapshot.current.set(id, el.getBoundingClientRect());
    }
  });

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
      setSimplifiedHidden(new Set());
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
      if (animationOff) {
        // Off mode: no animations or delays at all
        return;
      }
      // Simplified mode: staggered instant reveal, no movement
      if (newCards.length > 0) {
        const ids = newCards.map(c => c.id);
        setSimplifiedHidden(p => new Set([...p, ...ids]));
        newCards.forEach((card, i) => {
          setTimeout(() => {
            setSimplifiedHidden(p => { const n = new Set(p); n.delete(card.id); return n; });
          }, i * 500);
        });
      }
      return;
    }

    // Register entering cards with placeholder offset — Phase 2 will compute the real offset
    if (newCards.length > 0) {
      const entries = new Map<string, EnteringAnim>();
      newCards.forEach((card, i) => {
        entries.set(card.id, {
          offset: { x: 0, y: 0 },
          delay: i * 500,
          active: false,
          offsetComputed: false,
        });
      });
      setEnteringAnims(p => new Map([...p, ...entries]));
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

          if (lastPlayedTarget && lastPlayedTarget.cardId === card.id) {
            if (lastPlayedTarget.screenX !== null && lastPlayedTarget.screenY !== null) {
              // Targeting card → animate to tile position
              toX = lastPlayedTarget.screenX - rect.width / 2;
              toY = lastPlayedTarget.screenY - rect.height / 2;
              shrink = true;
            } else {
              // Non-targeting card (engine) → animate upward toward the grid
              toX = rect.left;
              toY = rect.top - 200;
              shrink = true;
            }
          } else {
            // Default: animate to discard pile
            toX = discardCx - rect.width / 2;
            toY = discardCy - rect.height / 2;
          }

          departing.set(card.id, {
            card,
            startX: rect.left, startY: rect.top,
            toX, toY,
            width: rect.width, height: rect.height,
            active: false,
            shrink,
          });
        });

        if (departing.size > 0) {
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
    }
  }, [cards, animated, animationOff, playerId, lastPlayedTarget]);

  // Phase 2: Compute real draw-pile offsets once card elements are in the DOM.
  // This fires when localOrder updates (which flushes after localOrder's useEffect runs,
  // guaranteeing card divs exist) OR when enteringAnims gains new uncomputed entries.
  useLayoutEffect(() => {
    const uncomputed = [...enteringAnims.entries()].filter(([, a]) => !a.offsetComputed);
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

    // Next frame: activate transitions — cards slide from draw pile to their slots
    requestAnimationFrame(() => {
      setEnteringAnims(p => {
        const next = new Map(p);
        for (const [id] of resolved) {
          const a = next.get(id);
          if (a?.offsetComputed && !a.active) next.set(id, { ...a, active: true });
        }
        return next;
      });
    });

    // Clean up after all staggered animations finish
    const maxDelay = Math.max(...resolved.map(([, a]) => a.delay));
    setTimeout(() => {
      setEnteringAnims(p => {
        const next = new Map(p);
        for (const [id] of resolved) next.delete(id);
        return next;
      });
    }, maxDelay + 600);
  }, [localOrder, enteringAnims]);

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
      });
    });

    if (departing.size === 0) {
      onDiscardAllComplete?.();
      return;
    }

    const duration = animated ? 500 : 200; // shorter for simplified

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

  // Shuffle detection: discard pile was moved to draw pile during a draw
  useEffect(() => {
    const prevDeck = prevDeckSizeRef.current;
    const prevDiscard = prevDiscardCountRef.current;
    prevDeckSizeRef.current = deckSize;
    prevDiscardCountRef.current = discardCount;

    // A shuffle happened when:
    // - Draw pile was empty (or nearly so) and is now replenished
    // - Discard pile shrank (cards moved from discard → draw pile)
    // - New cards appeared in hand (a draw was attempted)
    const prev = prevCardsRef.current;
    const hasNewCards = cards.some(c => !prev.some(p => p.id === c.id));
    const discardMovedToDraw = prevDiscard > 0 && discardCount < prevDiscard;
    const deckReplenished = deckSize > prevDeck || (prevDeck === 0 && deckSize >= 0 && discardMovedToDraw);

    if (hasNewCards && discardMovedToDraw && deckReplenished && !animationOff) {
      setShuffling(true);
      const duration = animated ? 2000 : 800;
      setTimeout(() => setShuffling(false), duration);
    }
  }, [deckSize, discardCount, cards, animated, animationOff]);

  const resetDragState = useCallback(() => {
    dragStartRef.current = null;
    isDraggingRef.current = false;
    setDraggingIndex(null);
    setDragPos(null);
    setDropTargetIndex(null);
  }, []);

  const handlePointerDown = useCallback((e: ReactPointerEvent, localIdx: number) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragStartRef.current = { x: e.clientX, y: e.clientY, index: localIdx };
    isDraggingRef.current = false;
  }, [disabled]);

  const handlePointerMove = useCallback((e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      if (!isDraggingRef.current) {
        isDraggingRef.current = true;
        onDragStart?.(localOrder[dragStartRef.current.index]);
        setHoveredIndex(null);
        setHoveredRect(null);
      }
      setDraggingIndex(dragStartRef.current.index);
      setDragPos({ x: e.clientX, y: e.clientY });

      // Compute drop target index for reordering
      const container = handContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const isOverHand = e.clientY >= rect.top - 20 && e.clientY <= rect.bottom + 20;
        if (isOverHand) {
          const cardEls = container.querySelectorAll('[data-card-slot]');
          let best = localOrder.length;
          let bestDist = Infinity;
          cardEls.forEach((el, i) => {
            const r = el.getBoundingClientRect();
            const centerX = r.left + r.width / 2;
            const dist = Math.abs(e.clientX - centerX);
            if (dist < bestDist) {
              bestDist = dist;
              best = e.clientX < centerX ? i : i + 1;
            }
          });
          setDropTargetIndex(best);
        } else {
          setDropTargetIndex(null);
        }
      }
    }
  }, [onDragStart, localOrder]);

  const handlePointerUp = useCallback((e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    const localIdx = dragStartRef.current.index;

    if (isDraggingRef.current) {
      onDragEnd?.();
      const handRect = handContainerRef.current?.getBoundingClientRect();
      const isOverHand = handRect
        && e.clientX >= handRect.left && e.clientX <= handRect.right
        && e.clientY >= handRect.top - 20 && e.clientY <= handRect.bottom + 20;

      if (isOverHand && dropTargetIndex !== null) {
        setLocalOrder(prev => {
          const next = [...prev];
          const [moved] = next.splice(localIdx, 1);
          const insertAt = dropTargetIndex > localIdx ? dropTargetIndex - 1 : dropTargetIndex;
          next.splice(insertAt, 0, moved);
          return next;
        });
      } else {
        onDragPlay(localOrder[localIdx], e.clientX, e.clientY);
      }
    } else {
      const cardIdx = localOrder[localIdx];
      if (selectedIndex === cardIdx) {
        onCardDetail(cards[cardIdx]);
      } else {
        onSelect(cardIdx);
      }
    }
    resetDragState();
  }, [onSelect, onDragPlay, onDragEnd, onCardDetail, selectedIndex, cards, localOrder, dropTargetIndex, resetDragState]);

  // If pointer capture is lost (e.g. card removed from DOM mid-drag), clean up
  const handleLostPointerCapture = useCallback(() => {
    if (isDraggingRef.current) {
      onDragEnd?.();
    }
    resetDragState();
  }, [onDragEnd, resetDragState]);

  // Safety net: if a card is removed from the DOM mid-drag, clean up via window listener
  useEffect(() => {
    const cleanup = () => {
      if (dragStartRef.current) {
        if (isDraggingRef.current) onDragEnd?.();
        resetDragState();
      }
    };
    window.addEventListener('pointerup', cleanup);
    return () => window.removeEventListener('pointerup', cleanup);
  }, [onDragEnd, resetDragState]);

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
    gap: 3,
    padding: '6px 10px',
    background: '#2a2a3e',
    border: '1px solid #444',
    borderRadius: 8,
    color: '#fff',
    cursor: 'pointer',
    width: BTN_WIDTH,
    flexShrink: 0,
    userSelect: 'none',
    position: 'relative',
    zIndex: 200,
    alignSelf: 'stretch',
    boxSizing: 'border-box',
  };

  return (
    <>
      {/* Shuffle notification above hand */}
      {shuffling && (
        <div style={{
          textAlign: 'center',
          padding: '4px 0',
          fontSize: 12,
          color: '#4a9eff',
          fontStyle: 'italic',
        }}>
          {forceShuffleAnim ? 'Shuffling deck...' : 'Draw pile empty, shuffling discarded cards.'}
        </div>
      )}

      {/* Grid layout: [button | cards | button] — columns are fixed so buttons never shift */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `${BTN_WIDTH}px 1fr ${BTN_WIDTH}px`,
        gap: 8,
        touchAction: 'none',
        alignItems: 'stretch',
      }}>
        {/* Deck icon */}
        <button
          ref={drawBtnRef}
          onClick={() => setShowDeckPopup(true)}
          title="View cards in draw pile"
          style={{
            ...iconBtnStyle,
            ...(shuffling ? {
              animation: animated
                ? 'shufflePulse 0.4s ease-in-out infinite'
                : 'shufflePulse 0.25s ease-in-out infinite',
              boxShadow: '0 0 12px rgba(74, 158, 255, 0.6)',
              borderColor: '#4a9eff',
            } : {}),
          }}
        >
          {shuffling
            ? <span style={{ fontSize: 10, fontWeight: 'bold', color: '#4a9eff' }}>Shuffling...</span>
            : <>
                <span style={{ fontSize: 12, fontWeight: 'bold', color: '#4a9eff' }}>{deckSize}</span>
                <span style={{ fontSize: 9, color: '#888' }}>Draw</span>
              </>
          }
        </button>

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
            const typeColor = TYPE_COLORS[card.card_type] || '#555';
            const isDropBefore = dropTargetIndex === localIdx;
            const isDropAfter = dropTargetIndex === localOrder.length && localIdx === localOrder.length - 1;

            // Compute animation overrides
            const entering = enteringAnims.get(card.id);
            const isHiddenSimplified = simplifiedHidden.has(card.id);

            let cardTransform = isSelected && !isBeingDragged ? 'translateY(-6px)' : 'none';
            // Hide cards when discard-all animation is playing (portal ghosts are visible instead)
            const isDiscardingAll = discardAll && departingAnims.has(card.id);
            let cardOpacity: number = isDiscardingAll ? 0 : isBeingDragged ? 0.3 : 1;
            let cardTransition = animated
              ? 'border-color 0.1s, box-shadow 0.1s, transform 0.1s'
              : 'none';

            if (isHiddenSimplified) {
              cardOpacity = 0;
            } else if (entering) {
              if (!entering.active) {
                // Placed at draw pile position, no transition yet
                cardTransform = `translate(${entering.offset.x}px, ${entering.offset.y}px)`;
                cardOpacity = 0;
                cardTransition = 'none';
              } else {
                // Sliding to natural position with stagger delay
                cardTransition = [
                  `transform 500ms ease-out ${entering.delay}ms`,
                  `opacity 500ms ease-out ${entering.delay}ms`,
                  'border-color 0.1s',
                  'box-shadow 0.1s',
                ].join(', ');
              }
            }

            return (
              <div
                key={`${card.id}-${cardIdx}`}
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
                role="button"
                tabIndex={disabled ? -1 : 0}
                style={{
                  width: CARD_WIDTH,
                  flexShrink: 0,
                  marginLeft: localIdx === 0 ? 0 : cardMarginLeft,
                  padding: '6px 8px',
                  background: isSelected ? '#3a3a6e' : '#2a2a3e',
                  border: `2px solid ${isSelected ? '#fff' : typeColor}`,
                  borderRadius: 6,
                  color: '#fff',
                  cursor: disabled ? 'not-allowed' : 'grab',
                  textAlign: 'center' as const,
                  opacity: cardOpacity,
                  transition: cardTransition,
                  transform: cardTransform,
                  userSelect: 'none' as const,
                  WebkitUserSelect: 'none' as const,
                  position: 'relative' as const,
                  zIndex: hoveredIndex === localIdx ? 100 : isSelected ? 10 : localIdx + 1,
                  boxShadow: isDropBefore
                    ? '-3px 0 0 0 #fff, -6px 0 12px rgba(255,255,255,0.3)'
                    : isDropAfter
                      ? '3px 0 0 0 #fff, 6px 0 12px rgba(255,255,255,0.3)'
                      : 'none',
                }}
              >
                <div style={{ fontSize: 9, color: typeColor, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
                  {card.card_type}
                </div>
                <div style={{ fontWeight: 'bold', fontSize: 12, marginBottom: 2, lineHeight: 1.2 }}>
                  {card.name} <ActionReturnBadge value={card.action_return} />
                </div>
                <div style={{ fontSize: 9, color: '#aaa', lineHeight: 1.3 }}>
                  <CardStats card={card} />
                </div>
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(10, 10, 20, 0.55)',
                  borderRadius: 'inherit',
                  pointerEvents: 'none',
                  opacity: disabled && !isDiscardingAll ? 1 : 0,
                  transition: animated ? 'opacity 0.25s ease' : 'none',
                }} />
              </div>
            );
          })}
        </div>

        {/* Discard icon */}
        <button
          ref={discardBtnRef}
          onClick={() => setShowDiscardPopup(true)}
          title="View discard pile"
          style={{ ...iconBtnStyle, opacity: discardCount === 0 ? 0.4 : 1 }}
        >
          <span style={{ fontSize: 12, fontWeight: 'bold', color: '#ffaa4a' }}>{discardCount}</span>
          <span style={{ fontSize: 9, color: '#888' }}>Discard</span>
        </button>
      </div>

      {/* Hover preview — appears above the hovered card */}
      {hoveredIndex !== null && hoveredRect && draggingIndex === null && cards[localOrder[hoveredIndex]] && (
        <CardPreview card={cards[localOrder[hoveredIndex]]} anchorRect={hoveredRect} />
      )}

      {/* Drag ghost */}
      {draggingIndex !== null && dragPos && cards[localOrder[draggingIndex]] && (
        <div style={{
          position: 'fixed',
          left: dragPos.x - 75,
          top: dragPos.y - 40,
          width: CARD_WIDTH,
          padding: 6,
          background: '#3a3a6ecc',
          border: `2px solid ${TYPE_COLORS[cards[localOrder[draggingIndex]].card_type] || '#fff'}`,
          borderRadius: 6,
          color: '#fff',
          pointerEvents: 'none',
          zIndex: 9999,
          transform: 'rotate(3deg) scale(1.05)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 9, color: TYPE_COLORS[cards[localOrder[draggingIndex]].card_type] || '#aaa', textTransform: 'uppercase', letterSpacing: 1 }}>
            {cards[localOrder[draggingIndex]].card_type}
          </div>
          <div style={{ fontWeight: 'bold', fontSize: 11 }}>
            {cards[localOrder[draggingIndex]].name}
          </div>
        </div>
      )}

      {/* Draw pile viewer popup */}
      {showDeckPopup && (
        <CardViewPopup
          title="Draw Pile"
          cards={drawPileCards}
          onClose={() => setShowDeckPopup(false)}
          defaultFull
        />
      )}

      {/* Discard viewer popup */}
      {showDiscardPopup && (
        <CardViewPopup
          title="Discard Pile"
          cards={[{ label: 'Discard Pile', items: discardCards }]}
          onClose={() => setShowDiscardPopup(false)}
          defaultFull
        />
      )}

      {/* Departing card ghosts — animate from last position to target */}
      {departingAnims.size > 0 && createPortal(
        <>
          {[...departingAnims.values()].map(d => {
            const typeColor = TYPE_COLORS[d.card.card_type] || '#555';
            const dx = d.active ? d.toX - d.startX : 0;
            const dy = d.active ? d.toY - d.startY : 0;
            const scale = d.active && d.shrink ? 'scale(0.3)' : 'scale(1)';
            return (
              <div
                key={d.card.id}
                style={{
                  position: 'fixed',
                  left: d.startX,
                  top: d.startY,
                  width: d.width,
                  height: d.height,
                  transform: `translate(${dx}px, ${dy}px) ${scale}`,
                  transformOrigin: 'center center',
                  opacity: d.active ? 0 : 1,
                  transition: d.active
                    ? animated
                      ? 'transform 500ms ease-in, opacity 300ms ease-in'
                      : 'transform 200ms ease-in, opacity 150ms ease-in'
                    : 'none',
                  pointerEvents: 'none',
                  zIndex: 9990,
                  padding: '6px 8px',
                  background: '#2a2a3e',
                  border: `2px solid ${typeColor}`,
                  borderRadius: 6,
                  color: '#fff',
                  textAlign: 'center',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ fontSize: 9, color: typeColor, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
                  {d.card.card_type}
                </div>
                <div style={{ fontWeight: 'bold', fontSize: 12, lineHeight: 1.2 }}>
                  {d.card.name}
                </div>
              </div>
            );
          })}
        </>,
        document.body,
      )}

      {/* Keyframes for shuffle animation */}
      <style>{`
        @keyframes shufflePulse {
          0%, 100% { transform: rotate(0deg) scale(1); }
          25% { transform: rotate(-3deg) scale(1.05); }
          75% { transform: rotate(3deg) scale(1.05); }
        }
      `}</style>
    </>
  );
}
