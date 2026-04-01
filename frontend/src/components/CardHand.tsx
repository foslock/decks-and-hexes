import { useRef, useCallback, useState, useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import type { Card } from '../types/game';
import { useAnimated } from './SettingsContext';
import { renderWithKeywords } from './Keywords';

interface CardHandProps {
  cards: Card[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onDragPlay: (cardIndex: number, screenX: number, screenY: number) => void;
  onCardDetail: (card: Card) => void;
  onDragStart?: (cardIndex: number) => void;
  onDragEnd?: () => void;
  disabled: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  claim: '#4a9eff',
  defense: '#4aff6a',
  engine: '#ffaa4a',
};

const DRAG_THRESHOLD = 12;

function ActionReturnBadge({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span style={{ fontSize: 10, padding: '1px 4px', borderRadius: 4, background: value === 2 ? '#4aff6a' : '#ffaa4a', color: '#000', fontWeight: 'bold' }}>
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

function CardPreview({ card, anchorRect }: { card: Card; anchorRect: DOMRect }) {
  return (
    <div style={{
      position: 'fixed',
      left: anchorRect.left,
      bottom: window.innerHeight - anchorRect.top + 8,
      width: 150,
      padding: '14px 10px',
      background: '#2a2a3e',
      border: `2px solid ${TYPE_COLORS[card.card_type] || '#555'}`,
      borderRadius: 10,
      color: '#fff',
      pointerEvents: 'none',
      zIndex: 9999,
      boxShadow: '0 -4px 24px rgba(0,0,0,0.6)',
    }}>
      <div style={{ fontSize: 9, color: TYPE_COLORS[card.card_type] || '#aaa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
        {card.card_type}
      </div>
      <div style={{ fontWeight: 'bold', fontSize: 13, lineHeight: 1.3, marginBottom: 8 }}>
        {card.name} <ActionReturnBadge value={card.action_return} />
      </div>
      <div style={{ fontSize: 11, color: '#aaa', marginBottom: 8 }}>
        {[
          card.power > 0 && `Power ${card.power}`,
          card.resource_gain > 0 && `+${card.resource_gain} Resource${card.resource_gain !== 1 ? 's' : ''}`,
          card.draw_cards > 0 && `+${card.draw_cards} Card${card.draw_cards !== 1 ? 's' : ''}`,
          card.defense_bonus > 0 && `+${card.defense_bonus} Defense`,
          card.forced_discard > 0 && `-${card.forced_discard} Card${card.forced_discard !== 1 ? 's' : ''}`,
        ].filter(Boolean).join(', ') || '\u00a0'}
      </div>
      {card.description && (
        <div style={{ fontSize: 11, color: '#ccc', lineHeight: 1.6 }}>
          {renderWithKeywords(card.description)}
        </div>
      )}
    </div>
  );
}

export default function CardHand({ cards, selectedIndex, onSelect, onDragPlay, onCardDetail, onDragStart, onDragEnd, disabled }: CardHandProps) {
  const animated = useAnimated();

  // Local display order — indices into the `cards` prop array
  const [localOrder, setLocalOrder] = useState<number[]>(() => cards.map((_, i) => i));

  // Reset order when the card set changes (card played, new hand drawn)
  // Preserve relative order of cards that remain
  useEffect(() => {
    setLocalOrder(prev => {
      const newIds = new Set(cards.map((_, i) => i));
      // Keep cards that still exist (by id match), add new ones at the end
      const cardIds = cards.map(c => c.id);
      const prevCardIds = prev.map(i => {
        // prev indices may be stale; map by card id instead
        return i;
      });
      // Rebuild: filter prev order for cards still present (by id), add any new indices
      const prevOrder = prev.filter(i => i < cards.length);
      // If lengths match, keep order; otherwise just reset
      if (prevOrder.length === cards.length) return prevOrder;
      void cardIds; void prevCardIds; void newIds;
      return cards.map((_, i) => i);
    });
  }, [cards]);

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);   // index in localOrder
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null); // index in localOrder
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null); // insert-before index in localOrder

  const handContainerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; index: number } | null>(null);
  const isDraggingRef = useRef(false);

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
        // Notify parent of drag start with the actual card index
        onDragStart?.(localOrder[dragStartRef.current.index]);
        setHoveredIndex(null);
        setHoveredRect(null);
      }
      setDraggingIndex(dragStartRef.current.index);
      setDragPos({ x: e.clientX, y: e.clientY });

      // Compute dropTargetIndex based on cursor X within hand container
      const container = handContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const isOverHand = e.clientY >= rect.top - 20 && e.clientY <= rect.bottom + 20;
        if (isOverHand) {
          // Find which slot the cursor is closest to
          const cards = container.querySelectorAll('[data-card-slot]');
          let best = localOrder.length; // default: append at end
          let bestDist = Infinity;
          cards.forEach((el, i) => {
            const r = el.getBoundingClientRect();
            const centerX = r.left + r.width / 2;
            const dist = Math.abs(e.clientX - centerX);
            if (dist < bestDist) {
              bestDist = dist;
              // Insert before or after based on which half of the card
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

      // Determine if released over the hand container
      const handRect = handContainerRef.current?.getBoundingClientRect();
      const isOverHand = handRect
        && e.clientX >= handRect.left && e.clientX <= handRect.right
        && e.clientY >= handRect.top - 20 && e.clientY <= handRect.bottom + 20;

      if (isOverHand && dropTargetIndex !== null) {
        // Reorder within hand
        setLocalOrder(prev => {
          const next = [...prev];
          const [moved] = next.splice(localIdx, 1);
          const insertAt = dropTargetIndex > localIdx ? dropTargetIndex - 1 : dropTargetIndex;
          next.splice(insertAt, 0, moved);
          return next;
        });
      } else {
        // Play card onto the board — pass the actual card index from the cards prop
        onDragPlay(localOrder[localIdx], e.clientX, e.clientY);
      }
    } else {
      // Click: select or open detail
      const cardIdx = localOrder[localIdx];
      if (selectedIndex === cardIdx) {
        onCardDetail(cards[cardIdx]);
      } else {
        onSelect(cardIdx);
      }
    }

    dragStartRef.current = null;
    isDraggingRef.current = false;
    setDraggingIndex(null);
    setDragPos(null);
    setDropTargetIndex(null);
  }, [onSelect, onDragPlay, onDragEnd, onCardDetail, selectedIndex, cards, localOrder, dropTargetIndex]);

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

  if (cards.length === 0) {
    return <div style={{ color: '#666', fontStyle: 'italic' }}>No cards in hand</div>;
  }

  return (
    <>
      <div
        ref={handContainerRef}
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', touchAction: 'none', alignItems: 'flex-end', justifyContent: 'center' }}
      >
        {localOrder.map((cardIdx, localIdx) => {
          const card = cards[cardIdx];
          if (!card) return null;
          const isBeingDragged = draggingIndex === localIdx;
          const isSelected = selectedIndex === cardIdx;
          const typeColor = TYPE_COLORS[card.card_type] || '#555';

          // Show insertion indicator: left border glow on the slot that would receive the drop
          const isDropBefore = dropTargetIndex === localIdx;
          const isDropAfter = dropTargetIndex === localOrder.length && localIdx === localOrder.length - 1;

          return (
            <div
              key={`${card.id}-${cardIdx}`}
              data-card-slot={localIdx}
              onPointerDown={(e) => handlePointerDown(e, localIdx)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerEnter={(e) => handlePointerEnter(e, localIdx)}
              onPointerLeave={handlePointerLeave}
              role="button"
              tabIndex={disabled ? -1 : 0}
              style={{
                width: 150,
                padding: '6px 8px',
                background: isSelected ? '#3a3a6e' : '#2a2a3e',
                border: `2px solid ${isSelected ? '#fff' : typeColor}`,
                borderRadius: 6,
                color: '#fff',
                cursor: disabled ? 'not-allowed' : 'grab',
                textAlign: 'center' as const,
                opacity: disabled ? 0.5 : isBeingDragged ? 0.3 : 1,
                transition: animated ? 'border-color 0.1s, box-shadow 0.1s' : 'none',
                transform: isSelected && !isBeingDragged ? 'translateY(-4px)' : 'none',
                userSelect: 'none' as const,
                WebkitUserSelect: 'none' as const,
                position: 'relative' as const,
                // Drop indicator: bright left or right border glow
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
            </div>
          );
        })}
      </div>

      {/* Hover preview */}
      {hoveredIndex !== null && hoveredRect && draggingIndex === null && cards[localOrder[hoveredIndex]] && (
        <CardPreview card={cards[localOrder[hoveredIndex]]} anchorRect={hoveredRect} />
      )}

      {/* Drag ghost */}
      {draggingIndex !== null && dragPos && cards[localOrder[draggingIndex]] && (
        <div style={{
          position: 'fixed',
          left: dragPos.x - 75,
          top: dragPos.y - 40,
          width: 150,
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
          <div style={{ fontSize: 9, color: TYPE_COLORS[cards[localOrder[draggingIndex]].card_type] || '#aaa', textTransform: 'uppercase', letterSpacing: 1 }}>{cards[localOrder[draggingIndex]].card_type}</div>
          <div style={{ fontWeight: 'bold', fontSize: 11 }}>{cards[localOrder[draggingIndex]].name}</div>
        </div>
      )}
    </>
  );
}
