import type { Card, MarketStack } from '../types/game';
import { IrreversibleButton } from './Tooltip';
import Icon from '../icons/Icon';
import { plainCardName } from './CardName';
import CompactCardFace from './CompactCardFace';

interface MarketPanelProps {
  archetypeMarket: Card[];
  sharedMarket: MarketStack[];
  playerResources: number;
  onBuyArchetype: (cardId: string) => void;
  onBuyShared: (cardId: string) => void;
  onBuyUpgrade: () => void;
  onReroll: () => void;
  disabled: boolean;
}

export default function MarketPanel({
  archetypeMarket,
  sharedMarket,
  playerResources,
  onBuyArchetype,
  onBuyShared,
  onBuyUpgrade,
  onReroll,
  disabled,
}: MarketPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Archetype Market */}
      <div>
        <h4 className="cc-ov-market-title">
          Archetype Market
          <IrreversibleButton
            className="cc-ov-action"
            onClick={onReroll}
            disabled={disabled || playerResources < 2}
            tooltip="Re-rolling replaces your market cards and spends 2 resources."
          >
            Re-roll (2<Icon name="resource" size={12} trim decorative style={{ verticalAlign: '-0.15em' }} />)
          </IrreversibleButton>
        </h4>
        <div className="cc-ov-shop-grid" style={{ justifyContent: 'flex-start', gap: 8 }}>
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
            <span style={{ color: 'var(--cc-text-faint)', fontSize: 12 }}>No cards available</span>
          )}
        </div>
      </div>

      {/* Shared Market */}
      <div>
        <h4 className="cc-ov-market-title">
          Shared Market
          <IrreversibleButton
            className="cc-ov-action"
            onClick={onBuyUpgrade}
            disabled={disabled || playerResources < 4}
            tooltip="Buying an upgrade credit spends 4 resources."
          >
            Buy Upgrade (4<Icon name="resource" size={12} trim decorative style={{ verticalAlign: '-0.15em' }} />)
          </IrreversibleButton>
        </h4>
        <div className="cc-ov-shop-grid" style={{ justifyContent: 'flex-start', gap: 8 }}>
          {sharedMarket.map((stack) => (
            <MarketCard
              key={stack.card.id}
              card={stack.card}
              remaining={stack.remaining}
              canAfford={stack.card.buy_cost !== null && playerResources >= stack.card.buy_cost}
              onBuy={() => onBuyShared(stack.card.id)}
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
  const stateClass = !canAfford ? ' is-unaffordable' : disabled ? ' is-dim' : '';
  return (
    <div className={`cc-ov-shop-item${stateClass}`}>
      <CompactCardFace className="cc-ov-shop-card" card={card} width={154}>
        {remaining !== null && (
          <span style={{ position: 'absolute', right: 6, bottom: -7, fontSize: 10, padding: '0 5px', borderRadius: 999, background: 'rgba(12,12,30,0.92)', border: '1px solid rgba(232,196,106,0.35)', color: '#d8d6e8' }}>×{remaining}</span>
        )}
      </CompactCardFace>
      <IrreversibleButton
        className="cc-ov-buy"
        onClick={onBuy}
        disabled={disabled || !canAfford}
        tooltip={`Purchasing ${plainCardName(card.name)} spends ${card.buy_cost} resources and adds it to your discard pile.`}
      >
        Buy
      </IrreversibleButton>
    </div>
  );
}
