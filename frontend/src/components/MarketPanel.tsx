import type { Card, MarketStack } from '../types/game';
import { IrreversibleButton } from './Tooltip';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitleText } from './SubtitlePartRenderer';

interface MarketPanelProps {
  archetypeMarket: Card[];
  neutralMarket: MarketStack[];
  playerResources: number;
  onBuyArchetype: (cardId: string) => void;
  onBuyNeutral: (cardId: string) => void;
  onBuyUpgrade: () => void;
  onReroll: () => void;
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
  disabled,
}: MarketPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Archetype Market */}
      <div>
        <h4 style={{ margin: '0 0 6px', color: '#aaa' }}>
          Archetype Market
          <IrreversibleButton
            onClick={onReroll}
            disabled={disabled || playerResources < 2}
            tooltip="Re-rolling replaces your market cards and spends 2 resources."
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
          </IrreversibleButton>
        </h4>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {archetypeMarket.map((card) => (
            <MarketCard
              key={card.id}
              card={card}
              remaining={null}
              canAfford={card.buy_cost !== null && playerResources >= card.buy_cost}
              onBuy={() => onBuyArchetype(card.id)}
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
          <IrreversibleButton
            onClick={onBuyUpgrade}
            disabled={disabled || playerResources < 5}
            tooltip="Buying an upgrade credit spends 5 resources."
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
          </IrreversibleButton>
        </h4>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {neutralMarket.map((stack) => (
            <MarketCard
              key={stack.card.id}
              card={stack.card}
              remaining={stack.remaining}
              canAfford={stack.card.buy_cost !== null && playerResources >= stack.card.buy_cost}
              onBuy={() => onBuyNeutral(stack.card.id)}
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
  disabled,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  onBuy: () => void;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        width: 154,
        padding: 6,
        background: '#2a2a3e',
        border: `1px solid ${canAfford && !disabled ? '#4a9eff' : '#333'}`,
        borderRadius: 6,
        color: '#fff',
        opacity: disabled || !canAfford ? 0.5 : 1,
      }}
    >
      <div>
        <div style={{ fontWeight: 'bold', fontSize: 16, marginBottom: 2 }}>{card.name}</div>
        <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
            if (el) {
              const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
              el.style.setProperty('--sub-scale', String(scale));
            }
          }}>
          {card.buy_cost !== null ? `💰 ${card.buy_cost}` : 'Free'}
          {buildCardSubtitle(card).map((part, i) => <span key={i}> · {renderSubtitleText(part.text)}</span>)}
          {remaining !== null && ` · ×${remaining}`}
          </span>
        </div>
      </div>
      <IrreversibleButton
        onClick={onBuy}
        disabled={disabled || !canAfford}
        tooltip={`Purchasing ${card.name} spends ${card.buy_cost} resources and adds it to your discard pile.`}
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
      </IrreversibleButton>
    </div>
  );
}
