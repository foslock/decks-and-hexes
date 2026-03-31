import type { Card } from '../types/game';

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

interface CardDetailProps {
  card: Card;
  onClose: () => void;
}

export default function CardDetail({ card, onClose }: CardDetailProps) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        cursor: 'pointer',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          background: '#1e1e3a',
          border: `3px solid ${TYPE_COLORS[card.card_type] || '#555'}`,
          borderRadius: 16,
          padding: 24,
          color: '#fff',
          cursor: 'default',
          boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>
            {CARD_EMOJI[card.card_type] || '📄'}
          </div>
          <div style={{ fontSize: 10, marginBottom: 4 }}>
            {ARCHETYPE_EMOJI[card.archetype] || ''}{' '}
            <span style={{ color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
              {card.archetype}
            </span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 'bold' }}>
            {card.name}
            {card.is_upgraded && <span style={{ color: '#ffd700' }}> +</span>}
          </div>
          <div style={{
            display: 'inline-block',
            marginTop: 4,
            padding: '2px 10px',
            borderRadius: 12,
            background: TYPE_COLORS[card.card_type] || '#555',
            color: '#000',
            fontSize: 12,
            fontWeight: 'bold',
          }}>
            {card.card_type.toUpperCase()}
          </div>
        </div>

        {/* Stats */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 8,
          marginBottom: 16,
        }}>
          {card.power > 0 && (
            <Stat label="Power" value={String(card.power)} icon="⚔️" />
          )}
          {card.resource_gain > 0 && (
            <Stat label="Resources" value={`+${card.resource_gain}`} icon="💰" />
          )}
          {card.draw_cards > 0 && (
            <Stat label="Draw" value={`+${card.draw_cards}`} icon="🃏" />
          )}
          {card.defense_bonus > 0 && (
            <Stat label="Defense" value={`+${card.defense_bonus}`} icon="🛡️" />
          )}
          {card.forced_discard > 0 && (
            <Stat label="Discard" value={`-${card.forced_discard}`} icon="🗑️" />
          )}
          {card.action_return > 0 && (
            <Stat
              label="Action"
              value={card.action_return === 1 ? 'Returns 1 (↺)' : 'Returns 2 (↑)'}
              icon="⚡"
            />
          )}
          {card.buy_cost !== null && (
            <Stat label="Cost" value={String(card.buy_cost)} icon="💰" />
          )}
        </div>

        {/* Description */}
        {card.description && (
          <div style={{
            background: '#151530',
            borderRadius: 8,
            padding: 12,
            fontSize: 14,
            lineHeight: 1.5,
            color: '#ccc',
            marginBottom: 16,
          }}>
            {card.description}
          </div>
        )}

        {/* Flags */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {card.trash_on_use && <Flag text="Trashed after use" color="#ff6666" />}
          {card.stacking_exception && <Flag text="Stacking allowed" color="#66ff66" />}
          {!card.adjacency_required && <Flag text="No adjacency needed" color="#66aaff" />}
          {card.starter && <Flag text="Starter card" color="#888" />}
          {card.is_upgraded && <Flag text="Upgraded" color="#ffd700" />}
        </div>

        {/* Close hint */}
        <div style={{ textAlign: 'center', fontSize: 12, color: '#666' }}>
          Click anywhere to close
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div style={{
      background: '#151530',
      borderRadius: 6,
      padding: '6px 10px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 16 }}>{icon}</div>
      <div style={{ fontSize: 14, fontWeight: 'bold' }}>{value}</div>
      <div style={{ fontSize: 10, color: '#888' }}>{label}</div>
    </div>
  );
}

function Flag({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      fontSize: 10,
      padding: '2px 8px',
      borderRadius: 10,
      border: `1px solid ${color}`,
      color,
    }}>
      {text}
    </span>
  );
}
