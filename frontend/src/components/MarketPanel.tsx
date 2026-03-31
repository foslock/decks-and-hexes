import type { Card, MarketStack } from '../types/game';

interface MarketPanelProps {
  archetypeMarket: Card[];
  neutralMarket: MarketStack[];
  playerResources: number;
  onBuyArchetype: (cardId: string) => void;
  onBuyNeutral: (cardId: string) => void;
  onBuyUpgrade: () => void;
  onReroll: () => void;
  onCardDetail: (card: Card) => void;
  disabled: boolean;
}

export default function MarketPanel({
  archetypeMarket,
  neutralMarket,
  playerResources,
  onBuyArchetype,
  onBuyNeutral,
  onBuyUpgrade,
  onReroll,
  onCardDetail,
  disabled,
}: MarketPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Archetype Market */}
      <div>
        <h4 style={{ margin: '0 0 6px', color: '#aaa' }}>
          Archetype Market
          <button
            onClick={onReroll}
            disabled={disabled || playerResources < 2}
            style={{
              marginLeft: 8,
              fontSize: 11,
              padding: '2px 8px',
              background: '#2a2a3e',
              border: '1px solid #555',
              borderRadius: 4,
              color: '#fff',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            Re-roll (2💰)
          </button>
        </h4>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {archetypeMarket.map((card) => (
            <MarketCard
              key={card.id}
              card={card}
              remaining={null}
              canAfford={card.buy_cost !== null && playerResources >= card.buy_cost}
              onBuy={() => onBuyArchetype(card.id)}
              onDetail={() => onCardDetail(card)}
              disabled={disabled}
            />
          ))}
          {archetypeMarket.length === 0 && (
            <span style={{ color: '#666', fontSize: 12 }}>No cards available</span>
          )}
        </div>
      </div>

      {/* Neutral Market */}
      <div>
        <h4 style={{ margin: '0 0 6px', color: '#aaa' }}>
          Neutral Market
          <button
            onClick={onBuyUpgrade}
            disabled={disabled || playerResources < 5}
            style={{
              marginLeft: 8,
              fontSize: 11,
              padding: '2px 8px',
              background: '#2a2a3e',
              border: '1px solid #555',
              borderRadius: 4,
              color: '#fff',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            Buy Upgrade (5💰)
          </button>
        </h4>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {neutralMarket.map((stack) => (
            <MarketCard
              key={stack.card.id}
              card={stack.card}
              remaining={stack.remaining}
              canAfford={stack.card.buy_cost !== null && playerResources >= stack.card.buy_cost}
              onBuy={() => onBuyNeutral(stack.card.id)}
              onDetail={() => onCardDetail(stack.card)}
              disabled={disabled}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MarketCard({
  card,
  remaining,
  canAfford,
  onBuy,
  onDetail,
  disabled,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  onBuy: () => void;
  onDetail: () => void;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        width: 130,
        padding: 6,
        background: '#2a2a3e',
        border: `1px solid ${canAfford && !disabled ? '#4a9eff' : '#333'}`,
        borderRadius: 6,
        color: '#fff',
        opacity: disabled || !canAfford ? 0.5 : 1,
      }}
    >
      <div
        onClick={onDetail}
        style={{ cursor: 'pointer', marginBottom: 4 }}
        title="Click to view card details"
      >
        <div style={{ fontWeight: 'bold', fontSize: 12 }}>{card.name}</div>
        <div style={{ fontSize: 11, color: '#aaa' }}>
          {card.buy_cost !== null ? `💰 ${card.buy_cost}` : 'Free'}
          {card.power > 0 && ` · Pow ${card.power}`}
          {card.resource_gain > 0 && ` · +${card.resource_gain}`}
          {remaining !== null && ` · ×${remaining}`}
        </div>
      </div>
      <button
        onClick={onBuy}
        disabled={disabled || !canAfford}
        style={{
          width: '100%',
          padding: '3px 0',
          background: canAfford && !disabled ? '#4a9eff' : '#333',
          border: 'none',
          borderRadius: 4,
          color: '#fff',
          fontSize: 11,
          fontWeight: 'bold',
          cursor: disabled || !canAfford ? 'not-allowed' : 'pointer',
        }}
      >
        Buy
      </button>
    </div>
  );
}
