import type { Card } from '../types/game';
import CardFull from './CardFull';

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
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        cursor: 'pointer',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
        <CardFull
          card={card}
          style={{ width: 300, padding: '16px 18px 18px', borderWidth: 3, borderRadius: 16, boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
        />
      </div>

      {/* Close hint */}
      <div style={{
        marginTop: 12,
        fontSize: 12,
        color: '#666',
        textAlign: 'center',
        pointerEvents: 'none',
      }}>
        Click anywhere to close
      </div>
    </div>
  );
}
