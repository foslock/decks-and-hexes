import type { Card, MarketStack } from '../types/game';
import { CARD_TITLE_FONT, getCardDisplayColor, miniCardBackground } from '../constants/cardColors';
import { IrreversibleButton } from './Tooltip';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitle } from './SubtitlePartRenderer';
import { CostLabel } from '../icons/Num';
import Icon from '../icons/Icon';

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
  const raw = getCardDisplayColor(card);
  const typeColor = /^#[0-9a-f]{6}$/i.test(raw) ? raw : '#555555';
  const stateClass = !canAfford ? ' is-unaffordable' : disabled ? ' is-dim' : '';
  return (
    <div className={`cc-ov-shop-item${stateClass}`}>
      <div
        className="cc-ov-shop-card"
        style={{ ['--cc-type' as string]: typeColor, background: miniCardBackground(typeColor) }}
      >
        <div className="cc-ov-shop-name" style={{ fontFamily: CARD_TITLE_FONT, marginBottom: 2 }}>{card.name}</div>
        <div className="cc-ov-shop-sub">
          <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
            if (el) {
              const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
              el.style.setProperty('--sub-scale', String(scale));
            }
          }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {card.buy_cost !== null ? <CostLabel cost={card.buy_cost} size={12} /> : 'Free'}
            <span style={{ opacity: 0.65 }}>·</span>
            {renderSubtitle(buildCardSubtitle(card), { fontSize: 12, passiveVp: card.passive_vp })}
            {remaining !== null && <span style={{ opacity: 0.8 }}>· ×{remaining}</span>}
          </span>
          </span>
        </div>
      </div>
      <IrreversibleButton
        className="cc-ov-buy"
        onClick={onBuy}
        disabled={disabled || !canAfford}
        tooltip={`Purchasing ${card.name} spends ${card.buy_cost} resources and adds it to your discard pile.`}
      >
        Buy
      </IrreversibleButton>
    </div>
  );
}
