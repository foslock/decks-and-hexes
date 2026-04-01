import { useState, useCallback, useEffect, useRef } from 'react';
import type { Card, MarketStack } from '../types/game';
import { IrreversibleButton } from './Tooltip';
import { renderWithKeywords } from './Keywords';

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

interface ShopOverlayProps {
  archetypeMarket: Card[];
  neutralMarket: MarketStack[];
  playerResources: number;
  playerArchetype: string;
  onBuyArchetype: (cardId: string) => void;
  onBuyNeutral: (cardId: string) => void;
  onBuyUpgrade: () => void;
  onReroll: () => void;
  disabled: boolean;
}

interface HoverState {
  card: Card;
  rect: DOMRect;
}

function StatChip({ value }: { value: string }) {
  return (
    <span style={{
      fontSize: 11,
      padding: '2px 6px',
      borderRadius: 6,
      background: '#252545',
      color: '#ccc',
    }}>
      {value}
    </span>
  );
}

function FullShopCard({
  card,
  remaining,
  canAfford,
  onBuy,
  onHover,
  onLeave,
  disabled,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  onBuy: () => void;
  onHover: (e: React.MouseEvent, card: Card) => void;
  onLeave: () => void;
  disabled: boolean;
}) {
  return (
    <div
      data-card-id={card.id}
      onMouseEnter={(e) => onHover(e, card)}
      onMouseLeave={onLeave}
      style={{
        width: 190,
        background: '#1e1e3a',
        border: `2px solid ${canAfford && !disabled ? TYPE_COLORS[card.card_type] || '#4a9eff' : '#333'}`,
        borderRadius: 10,
        padding: 12,
        color: '#fff',
        opacity: disabled || !canAfford ? 0.55 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 26 }}>{CARD_EMOJI[card.card_type] || '📄'}</div>
        <div style={{ fontSize: 9, color: '#888' }}>
          {ARCHETYPE_EMOJI[card.archetype]} {card.archetype.toUpperCase()}
        </div>
        <div style={{ fontWeight: 'bold', fontSize: 13 }}>
          {card.name}
          {card.is_upgraded && <span style={{ color: '#ffd700' }}> +</span>}
        </div>
        <div style={{
          display: 'inline-block',
          marginTop: 2,
          padding: '1px 8px',
          borderRadius: 10,
          background: TYPE_COLORS[card.card_type] || '#555',
          color: '#000',
          fontSize: 10,
          fontWeight: 'bold',
        }}>
          {card.card_type.toUpperCase()}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, justifyContent: 'center' }}>
        {card.buy_cost !== null && <StatChip value={`💰${card.buy_cost}`} />}
        {card.power > 0 && <StatChip value={`⚔️${card.power}`} />}
        {card.resource_gain > 0 && <StatChip value={`+${card.resource_gain}💰`} />}
        {card.draw_cards > 0 && <StatChip value={`+${card.draw_cards}🃏`} />}
        {card.defense_bonus > 0 && <StatChip value={`+${card.defense_bonus}🛡️`} />}
        {card.forced_discard > 0 && <StatChip value={`-${card.forced_discard}🃏`} />}
        {card.action_return > 0 && <StatChip value={card.action_return === 1 ? '↺' : '↑'} />}
        {remaining !== null && <StatChip value={`×${remaining}`} />}
      </div>

      {card.description && (
        <div style={{
          fontSize: 11,
          color: '#bbb',
          lineHeight: 1.4,
          background: '#151530',
          borderRadius: 6,
          padding: '5px 8px',
          flex: 1,
        }}>
          {renderWithKeywords(card.description)}
        </div>
      )}

      <IrreversibleButton
        onClick={onBuy}
        disabled={disabled || !canAfford}
        tooltip={`Purchasing ${card.name} spends ${card.buy_cost} resources and adds it to your discard pile.`}
        style={{
          width: '100%',
          padding: '4px 0',
          background: canAfford && !disabled ? '#4a9eff' : '#333',
          border: 'none',
          borderRadius: 5,
          color: '#fff',
          fontSize: 12,
          fontWeight: 'bold',
          cursor: disabled || !canAfford ? 'not-allowed' : 'pointer',
        }}
      >
        Buy{card.buy_cost !== null ? ` (${card.buy_cost}💰)` : ''}
      </IrreversibleButton>
    </div>
  );
}

function CompactShopCard({
  card,
  remaining,
  canAfford,
  onBuy,
  onHover,
  onLeave,
  disabled,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  onBuy: () => void;
  onHover: (e: React.MouseEvent, card: Card) => void;
  onLeave: () => void;
  disabled: boolean;
}) {
  return (
    <div
      data-card-id={card.id}
      onMouseEnter={(e) => onHover(e, card)}
      onMouseLeave={onLeave}
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
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontWeight: 'bold', fontSize: 12 }}>
          {CARD_EMOJI[card.card_type]} {card.name}
        </div>
        <div style={{ fontSize: 11, color: '#aaa' }}>
          {card.buy_cost !== null ? `💰 ${card.buy_cost}` : 'Free'}
          {card.power > 0 && ` · Pow ${card.power}`}
          {card.resource_gain > 0 && ` · +${card.resource_gain}`}
          {remaining !== null && ` · ×${remaining}`}
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

export default function ShopOverlay({
  archetypeMarket,
  neutralMarket,
  playerResources,
  playerArchetype,
  onBuyArchetype,
  onBuyNeutral,
  onBuyUpgrade,
  onReroll,
  disabled,
}: ShopOverlayProps) {
  const [fullView, setFullView] = useState(false);
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const [minimized, setMinimized] = useState(false);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);

  const handleCardHover = useCallback((e: React.MouseEvent, card: Card) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHoverState({ card, rect });
  }, []);

  const handleCardLeave = useCallback(() => {
    setHoverState(null);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    mousePosRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // When the market changes (buy / reroll), the hovered card element unmounts without
  // firing onMouseLeave. Clear any stale hover and re-detect what's now under the cursor.
  useEffect(() => {
    const allMarketCards = [
      ...archetypeMarket,
      ...neutralMarket.map(s => s.card),
    ];

    setHoverState(prev => {
      if (!prev) return null;
      // Card still present — no change needed
      if (allMarketCards.some(c => c.id === prev.card.id)) return prev;

      // Card is gone — find whatever is now under the cursor
      const pos = mousePosRef.current;
      if (!pos) return null;

      const el = document.elementFromPoint(pos.x, pos.y)?.closest?.('[data-card-id]');
      if (!el) return null;

      const cardId = el.getAttribute('data-card-id');
      const newCard = allMarketCards.find(c => c.id === cardId);
      if (!newCard) return null;

      return { card: newCard, rect: el.getBoundingClientRect() };
    });
  }, [archetypeMarket, neutralMarket]);

  // Position hover preview above the card (fixed, viewport-relative)
  const previewStyle = hoverState ? (() => {
    const { rect } = hoverState;
    const previewHeight = 300;
    const previewWidth = 220;
    const spaceAbove = rect.top;
    const useAbove = spaceAbove >= previewHeight + 12;
    return {
      position: 'fixed' as const,
      left: Math.min(rect.left + rect.width / 2 - previewWidth / 2, window.innerWidth - previewWidth - 8),
      top: useAbove ? rect.top - previewHeight - 8 : rect.bottom + 8,
      width: previewWidth,
      zIndex: 9999,
      pointerEvents: 'none' as const,
    };
  })() : null;

  return (
    <>
      {/* Shop panel — centered over the board area */}
      <div
        onMouseMove={handleMouseMove}
        style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 200,
        width: 'min(92vw, 800px)',
        background: '#12122a',
        border: '2px solid #4a4a6a',
        borderRadius: 12,
        boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: minimized ? 'auto' : '70vh',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          background: '#1a1a40',
          borderRadius: '10px 10px 0 0',
          borderBottom: minimized ? 'none' : '1px solid #333',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 'bold', color: '#fff', fontSize: 14 }}>🛒 Shop</span>
          <span style={{ fontSize: 13, color: '#aaa' }}>· 💰 {playerResources} resources</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {!minimized && (
              <div style={{
                display: 'flex',
                border: '1px solid #444',
                borderRadius: 6,
                overflow: 'hidden',
              }}>
                <button
                  onClick={() => setFullView(false)}
                  style={{
                    padding: '3px 10px',
                    background: !fullView ? '#4a4aff' : '#2a2a3e',
                    border: 'none',
                    color: '#fff',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Compact
                </button>
                <button
                  onClick={() => setFullView(true)}
                  style={{
                    padding: '3px 10px',
                    background: fullView ? '#4a4aff' : '#2a2a3e',
                    border: 'none',
                    color: '#fff',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Full
                </button>
              </div>
            )}
            <button
              onClick={() => setMinimized(m => !m)}
              style={{
                padding: '3px 8px',
                background: '#2a2a3e',
                border: '1px solid #444',
                borderRadius: 4,
                color: '#aaa',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {minimized ? '▲ Open' : '▼ Hide'}
            </button>
          </div>
        </div>

        {/* Content */}
        {!minimized && (
          <div style={{ overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Archetype Market */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 'bold', color: '#aaa' }}>{playerArchetype.charAt(0).toUpperCase() + playerArchetype.slice(1)} Market</span>
                <IrreversibleButton
                  onClick={onReroll}
                  disabled={disabled || playerResources < 2}
                  tooltip="Re-rolling replaces your market cards and spends 2 resources."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    background: '#2a2a3e',
                    border: '1px solid #555',
                    borderRadius: 4,
                    color: playerResources >= 2 && !disabled ? '#fff' : '#555',
                    cursor: disabled || playerResources < 2 ? 'not-allowed' : 'pointer',
                  }}
                >
                  Re-roll (2💰)
                </IrreversibleButton>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {archetypeMarket.length === 0 && (
                  <span style={{ color: '#666', fontSize: 12 }}>No cards available</span>
                )}
                {archetypeMarket.map((card) => {
                  const canAfford = card.buy_cost !== null && playerResources >= card.buy_cost;
                  return fullView ? (
                    <FullShopCard
                      key={card.id}
                      card={card}
                      remaining={null}
                      canAfford={canAfford}
                      onBuy={() => onBuyArchetype(card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                    />
                  ) : (
                    <CompactShopCard
                      key={card.id}
                      card={card}
                      remaining={null}
                      canAfford={canAfford}
                      onBuy={() => onBuyArchetype(card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                    />
                  );
                })}
              </div>
            </div>

            {/* Neutral Market */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 'bold', color: '#aaa' }}>Neutral Market</span>
                <IrreversibleButton
                  onClick={onBuyUpgrade}
                  disabled={disabled || playerResources < 5}
                  tooltip="Buying an upgrade credit spends 5 resources."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    background: '#2a2a3e',
                    border: '1px solid #555',
                    borderRadius: 4,
                    color: playerResources >= 5 && !disabled ? '#fff' : '#555',
                    cursor: disabled || playerResources < 5 ? 'not-allowed' : 'pointer',
                  }}
                >
                  Buy Upgrade (5💰)
                </IrreversibleButton>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {neutralMarket.map((stack) => {
                  const canAfford = stack.card.buy_cost !== null && playerResources >= stack.card.buy_cost;
                  return fullView ? (
                    <FullShopCard
                      key={stack.card.id}
                      card={stack.card}
                      remaining={stack.remaining}
                      canAfford={canAfford}
                      onBuy={() => onBuyNeutral(stack.card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                    />
                  ) : (
                    <CompactShopCard
                      key={stack.card.id}
                      card={stack.card}
                      remaining={stack.remaining}
                      canAfford={canAfford}
                      onBuy={() => onBuyNeutral(stack.card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating hover preview (fixed, viewport-relative) */}
      {hoverState && previewStyle && (
        <div style={previewStyle}>
          <div style={{
            background: '#1a1a38',
            border: `2px solid ${TYPE_COLORS[hoverState.card.card_type] || '#555'}`,
            borderRadius: 12,
            padding: 16,
            color: '#fff',
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
          }}>
            <div style={{ textAlign: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 36 }}>{CARD_EMOJI[hoverState.card.card_type] || '📄'}</div>
              <div style={{ fontSize: 9, color: '#888', marginBottom: 3 }}>
                {ARCHETYPE_EMOJI[hoverState.card.archetype]} {hoverState.card.archetype.toUpperCase()}
              </div>
              <div style={{ fontWeight: 'bold', fontSize: 16 }}>
                {hoverState.card.name}
                {hoverState.card.is_upgraded && <span style={{ color: '#ffd700' }}> +</span>}
              </div>
              <div style={{
                display: 'inline-block', marginTop: 4,
                padding: '2px 10px', borderRadius: 10,
                background: TYPE_COLORS[hoverState.card.card_type] || '#555',
                color: '#000', fontSize: 11, fontWeight: 'bold',
              }}>
                {hoverState.card.card_type.toUpperCase()}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10, justifyContent: 'center' }}>
              {hoverState.card.buy_cost !== null && <StatChip value={`💰 ${hoverState.card.buy_cost}`} />}
              {hoverState.card.power > 0 && <StatChip value={`⚔️ ${hoverState.card.power}`} />}
              {hoverState.card.resource_gain > 0 && <StatChip value={`+${hoverState.card.resource_gain} 💰`} />}
              {hoverState.card.draw_cards > 0 && <StatChip value={`+${hoverState.card.draw_cards} 🃏`} />}
              {hoverState.card.defense_bonus > 0 && <StatChip value={`+${hoverState.card.defense_bonus} 🛡️`} />}
              {hoverState.card.forced_discard > 0 && <StatChip value={`-${hoverState.card.forced_discard} 🃏`} />}
              {hoverState.card.action_return > 0 && <StatChip value={hoverState.card.action_return === 1 ? '↺ Returns 1' : '↑ Returns 2'} />}
            </div>
            {hoverState.card.description && (
              <div style={{
                fontSize: 12,
                color: '#bbb',
                lineHeight: 1.5,
                background: '#111130',
                borderRadius: 6,
                padding: '8px 10px',
              }}>
                {renderWithKeywords(hoverState.card.description)}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
