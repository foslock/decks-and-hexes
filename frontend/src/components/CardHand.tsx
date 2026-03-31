import { useRef, useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Card } from '../types/game';
import { useAnimated } from './SettingsContext';

interface CardHandProps {
  cards: Card[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onDragPlay: (cardIndex: number, screenX: number, screenY: number) => void;
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

// Minimum distance (px) to consider a pointer movement a drag vs a tap
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

export default function CardHand({ cards, selectedIndex, onSelect, onDragPlay, disabled }: CardHandProps) {
  const animated = useAnimated();
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; index: number } | null>(null);
  const isDraggingRef = useRef(false);

  const handlePointerDown = useCallback((e: ReactPointerEvent, index: number) => {
    if (disabled) return;
    e.preventDefault();
    // Capture pointer for drag tracking
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
      // Drag release — emit drag play at release coordinates
      onDragPlay(index, e.clientX, e.clientY);
    } else {
      // Tap/click — select the card
      onSelect(index);
    }

    dragStartRef.current = null;
    isDraggingRef.current = false;
    setDraggingIndex(null);
    setDragPos(null);
  }, [onSelect, onDragPlay]);

  if (cards.length === 0) {
    return <div style={{ color: '#666', fontStyle: 'italic' }}>No cards in hand</div>;
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', touchAction: 'none' }}>
        {cards.map((card, i) => {
          const isBeingDragged = draggingIndex === i;
          return (
            <div
              key={`${card.id}-${i}`}
              onPointerDown={(e) => handlePointerDown(e, i)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              role="button"
              tabIndex={disabled ? -1 : 0}
              style={{
                width: 140,
                padding: 8,
                background: i === selectedIndex ? '#3a3a6e' : '#2a2a3e',
                border: `2px solid ${i === selectedIndex ? '#fff' : TYPE_COLORS[card.card_type] || '#555'}`,
                borderRadius: 8,
                color: '#fff',
                cursor: disabled ? 'not-allowed' : 'grab',
                textAlign: 'left' as const,
                opacity: disabled ? 0.5 : isBeingDragged ? 0.4 : 1,
                transition: animated ? 'transform 0.15s, opacity 0.15s' : 'none',
                transform: i === selectedIndex && !isBeingDragged ? 'translateY(-4px)' : 'none',
                userSelect: 'none' as const,
                WebkitUserSelect: 'none' as const,
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
              {card.description && (
                <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                  {card.description.slice(0, 60)}
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
