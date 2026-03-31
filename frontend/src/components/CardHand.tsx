import type { Card } from '../types/game';

interface CardHandProps {
  cards: Card[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  disabled: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  claim: '#4a9eff',
  defense: '#4aff6a',
  engine: '#ffaa4a',
};

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

export default function CardHand({ cards, selectedIndex, onSelect, disabled }: CardHandProps) {
  if (cards.length === 0) {
    return <div style={{ color: '#666', fontStyle: 'italic' }}>No cards in hand</div>;
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {cards.map((card, i) => (
        <button
          key={`${card.id}-${i}`}
          onClick={() => onSelect(i)}
          disabled={disabled}
          style={{
            width: 140,
            padding: 8,
            background: i === selectedIndex ? '#3a3a6e' : '#2a2a3e',
            border: `2px solid ${i === selectedIndex ? '#fff' : TYPE_COLORS[card.card_type] || '#555'}`,
            borderRadius: 8,
            color: '#fff',
            cursor: disabled ? 'not-allowed' : 'pointer',
            textAlign: 'left',
            opacity: disabled ? 0.5 : 1,
          }}
        >
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
        </button>
      ))}
    </div>
  );
}
