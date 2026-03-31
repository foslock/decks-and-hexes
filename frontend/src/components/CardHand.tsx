import { useRef, useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Card } from '../types/game';
import { useAnimated } from './SettingsContext';

interface CardHandProps {
  cards: Card[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onDragPlay: (cardIndex: number, screenX: number, screenY: number) => void;
  onCardDetail: (card: Card) => void;
  disabled: boolean;
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

function ActionReturnBadge({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span
      style={{
        fontSize: 10,
        padding: '1px 4px',
        borderRadius: 4,
        background: value === 2 ? '#4aff6a' : '#ffaa4a',
        color: '#000',
        fontWeight: 'bold',
      }}
    >
      {value === 1 ? '↺' : '↑'}
    </span>
  );
}

export default function CardHand({ cards, selectedIndex, onSelect, onDragPlay, onCardDetail, disabled }: CardHandProps) {
  const animated = useAnimated();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; index: number } | null>(null);
  const isDraggingRef = useRef(false);

  const handlePointerDown = useCallback((e: ReactPointerEvent, index: number) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragStartRef.current = { x: e.clientX, y: e.clientY, index };
    isDraggingRef.current = false;
  }, [disabled]);

  const handlePointerMove = useCallback((e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > DRAG_THRESHOLD) {
      isDraggingRef.current = true;
      setDraggingIndex(dragStartRef.current.index);
      setDragPos({ x: e.clientX, y: e.clientY });
    }
  }, []);

  const handlePointerUp = useCallback((e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    const index = dragStartRef.current.index;

    if (isDraggingRef.current) {
      onDragPlay(index, e.clientX, e.clientY);
    } else {
      // Tap/click: if already selected, open detail; otherwise select
      if (selectedIndex === index) {
        onCardDetail(cards[index]);
      } else {
        onSelect(index);
      }
    }

    dragStartRef.current = null;
    isDraggingRef.current = false;
    setDraggingIndex(null);
    setDragPos(null);
  }, [onSelect, onDragPlay, onCardDetail, selectedIndex, cards]);

  if (cards.length === 0) {
    return <div style={{ color: '#666', fontStyle: 'italic' }}>No cards in hand</div>;
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', touchAction: 'none', alignItems: 'flex-end' }}>
        {cards.map((card, i) => {
          const isBeingDragged = draggingIndex === i;
          const isHovered = hoveredIndex === i && !isBeingDragged;
          const isSelected = selectedIndex === i;

          return (
            <div
              key={`${card.id}-${i}`}
              onPointerDown={(e) => handlePointerDown(e, i)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerEnter={() => setHoveredIndex(i)}
              onPointerLeave={() => setHoveredIndex(null)}
              role="button"
              tabIndex={disabled ? -1 : 0}
              style={{
                width: isHovered ? 170 : 140,
                padding: isHovered ? 10 : 8,
                background: isSelected ? '#3a3a6e' : isHovered ? '#30304e' : '#2a2a3e',
                border: `2px solid ${isSelected ? '#fff' : isHovered ? '#aaa' : TYPE_COLORS[card.card_type] || '#555'}`,
                borderRadius: 8,
                color: '#fff',
                cursor: disabled ? 'not-allowed' : 'grab',
                textAlign: 'left' as const,
                opacity: disabled ? 0.5 : isBeingDragged ? 0.4 : 1,
                transition: animated ? 'all 0.15s ease-out' : 'none',
                transform: isSelected && !isBeingDragged
                  ? 'translateY(-8px)'
                  : isHovered
                    ? 'translateY(-12px) scale(1.05)'
                    : 'none',
                transformOrigin: 'bottom center',
                userSelect: 'none' as const,
                WebkitUserSelect: 'none' as const,
                zIndex: isHovered ? 10 : isSelected ? 5 : 1,
                position: 'relative' as const,
                boxShadow: isHovered ? '0 8px 20px rgba(0,0,0,0.4)' : 'none',
              }}
            >
              <div style={{ fontSize: 20, textAlign: 'center', marginBottom: 4 }}>
                {CARD_EMOJI[card.card_type] || '📄'}{' '}
                <span style={{ fontSize: 10 }}>{ARCHETYPE_EMOJI[card.archetype] || ''}</span>
              </div>
              <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 4 }}>
                {card.name} <ActionReturnBadge value={card.action_return} />
              </div>
              <div style={{ fontSize: 11, color: '#aaa' }}>
                {card.card_type.toUpperCase()}
                {card.power > 0 && ` · Power ${card.power}`}
                {card.resource_gain > 0 && ` · +${card.resource_gain} res`}
                {card.draw_cards > 0 && ` · Draw ${card.draw_cards}`}
                {card.defense_bonus > 0 && ` · +${card.defense_bonus} def`}
                {card.forced_discard > 0 && ` · -${card.forced_discard} cards`}
              </div>
              {/* Show full description on hover, truncated otherwise */}
              {card.description && (
                <div style={{
                  fontSize: isHovered ? 11 : 10,
                  color: isHovered ? '#bbb' : '#888',
                  marginTop: 4,
                  lineHeight: 1.4,
                }}>
                  {isHovered ? card.description : card.description.slice(0, 60)}
                  {!isHovered && card.description.length > 60 && '...'}
                </div>
              )}
              {/* Hint when selected */}
              {isSelected && !isHovered && (
                <div style={{ fontSize: 9, color: '#4a9eff', marginTop: 4 }}>
                  Click again for details
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Floating drag ghost */}
      {draggingIndex !== null && dragPos && (
        <div
          style={{
            position: 'fixed',
            left: dragPos.x - 70,
            top: dragPos.y - 60,
            width: 140,
            padding: 8,
            background: '#3a3a6ecc',
            border: `2px solid ${TYPE_COLORS[cards[draggingIndex].card_type] || '#fff'}`,
            borderRadius: 8,
            color: '#fff',
            pointerEvents: 'none',
            zIndex: 9999,
            transform: 'rotate(3deg) scale(1.05)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ fontSize: 20, textAlign: 'center' }}>
            {CARD_EMOJI[cards[draggingIndex].card_type] || '📄'}
          </div>
          <div style={{ fontWeight: 'bold', fontSize: 13, textAlign: 'center' }}>
            {cards[draggingIndex].name}
          </div>
        </div>
      )}
    </>
  );
}
