import { useState, useCallback, useEffect, useRef } from 'react';
import type { Card, MarketStack } from '../types/game';
import { IrreversibleButton } from './Tooltip';
import { renderWithKeywords } from './Keywords';
import { useAnimationMode } from './SettingsContext';
import CardFull, { CARD_FULL_WIDTH } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';

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

// Persists shop view mode across opens (reset on page reload)
let shopViewMemory: boolean | null = null;

interface ShopOverlayProps {
  archetypeMarket: Card[];
  neutralMarket: MarketStack[];
  playerResources: number;
  playerArchetype: string;
  effectiveBuyCosts?: Record<string, number>;
  onBuyArchetype: (cardId: string) => void;
  onBuyNeutral: (cardId: string) => void;
  onBuyUpgrade: () => void;
  onReroll: () => void;
  disabled: boolean;
  onClose?: () => void;
  testMode?: boolean;
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
  effectiveCost,
  onBuy,
  onHover,
  onLeave,
  disabled,
  shiftHeld,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  effectiveCost?: number | null;
  onBuy: () => void;
  onHover: (e: React.MouseEvent, card: Card) => void;
  onLeave: () => void;
  disabled: boolean;
  shiftHeld: boolean;
}) {
  const displayCost = effectiveCost ?? card.buy_cost;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  return (
    <div
      data-card-id={card.id}
      onMouseEnter={(e) => onHover(e, card)}
      onMouseLeave={onLeave}
      style={{
        opacity: disabled || !canAfford ? 0.55 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <CardFull card={displayCard} effectiveCost={effectiveCost} remaining={remaining} />
      {shiftHeld && hasUpgradePreview(card) && (
        <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 'bold', color: '#4aff6a', marginBottom: 2 }}>
          Upgraded
        </div>
      )}
      <IrreversibleButton
        onClick={onBuy}
        disabled={disabled || !canAfford}
        tooltip={`Purchasing ${card.name} spends ${displayCost} resources and adds it to your discard pile.${isDiscounted ? ` (Reduced from ${card.buy_cost})` : ''}`}
        style={{
          width: CARD_FULL_WIDTH,
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
        Buy{displayCost !== null ? ` (${displayCost}${isDiscounted ? '*' : ''}💰)` : ''}
      </IrreversibleButton>
    </div>
  );
}

function CompactShopCard({
  card,
  remaining,
  canAfford,
  effectiveCost,
  onBuy,
  onHover,
  onLeave,
  disabled,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  effectiveCost?: number | null;
  onBuy: () => void;
  onHover: (e: React.MouseEvent, card: Card) => void;
  onLeave: () => void;
  disabled: boolean;
}) {
  const displayCost = effectiveCost ?? card.buy_cost;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;
  return (
    <div
      data-card-id={card.id}
      onMouseEnter={(e) => onHover(e, card)}
      onMouseLeave={onLeave}
      style={{
        width: 130,
        padding: 6,
        background: '#2a2a3e',
        border: `1px solid ${canAfford && !disabled ? TYPE_COLORS[card.card_type] || '#4a9eff' : '#333'}`,
        borderRadius: 6,
        color: '#fff',
        opacity: disabled || !canAfford ? 0.5 : 1,
      }}
    >
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontWeight: 'bold', fontSize: 12 }}>
          {CARD_EMOJI[card.card_type]} {card.name}
        </div>
        <div style={{ fontSize: 11, color: '#aaa' }} title={isDiscounted ? `Reduced from ${card.buy_cost} (dynamic discount)` : undefined}>
          {displayCost !== null ? `💰 ${displayCost}${isDiscounted ? '*' : ''}` : 'Free'}
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
  effectiveBuyCosts,
  onBuyArchetype,
  onBuyNeutral,
  onBuyUpgrade,
  onReroll,
  disabled,
  onClose,
  testMode,
}: ShopOverlayProps) {
  const [fullView, setFullViewRaw] = useState(() => shopViewMemory ?? false);
  const setFullView = useCallback((v: boolean) => { setFullViewRaw(v); shopViewMemory = v; }, []);
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const [hoverVisible, setHoverVisible] = useState(false);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const animMode = useAnimationMode();
  const shiftHeld = useShiftKey();

  const handleCardHover = useCallback((e: React.MouseEvent, card: Card) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHoverVisible(false);
    setHoverState({ card, rect });
  }, []);

  const handleCardLeave = useCallback(() => {
    setHoverState(null);
    setHoverVisible(false);
  }, []);

  // Trigger fade-in on hover
  useEffect(() => {
    if (hoverState && animMode === 'normal') {
      requestAnimationFrame(() => setHoverVisible(true));
    } else if (hoverState) {
      setHoverVisible(true);
    }
  }, [hoverState, animMode]);

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

  const [visible, setVisible] = useState(animMode === 'off');

  useEffect(() => {
    if (animMode !== 'off') {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [animMode]);

  const panelTransition = animMode === 'normal' ? 'opacity 0.25s ease, transform 0.25s ease'
    : animMode === 'simplified' ? 'opacity 0.1s ease, transform 0.1s ease'
    : 'none';

  return (
    <>
      {/* Shop panel — centered over the entire window with backdrop */}
      <div
        onClick={onClose}
        onMouseMove={handleMouseMove}
        style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5000,
        opacity: visible ? 1 : 0,
        transition: animMode === 'normal' ? 'opacity 0.25s ease' : animMode === 'simplified' ? 'opacity 0.1s ease' : 'none',
      }}>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
          width: 'min(92vw, 800px)',
          background: '#12122a',
          border: '2px solid #4a4a6a',
          borderRadius: 12,
          boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '70vh',
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1)' : 'scale(0.95)',
          transition: panelTransition,
        }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          background: '#1a1a40',
          borderRadius: '10px 10px 0 0',
          borderBottom: '1px solid #333',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 'bold', color: '#fff', fontSize: 14 }}>🛒 Shop</span>
          <span style={{ fontSize: 13, color: '#aaa' }}>· 💰 {playerResources} resources</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
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
            {onClose && (
              <button
                onClick={onClose}
                style={{
                  padding: '3px 8px',
                  background: '#2a2a3e',
                  border: '1px solid #555',
                  borderRadius: 4,
                  color: '#aaa',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Content */}
          <div style={{ overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Archetype Market */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 'bold', color: '#aaa' }}>{playerArchetype.charAt(0).toUpperCase() + playerArchetype.slice(1)} Market</span>
                <IrreversibleButton
                  onClick={onReroll}
                  disabled={disabled || (!testMode && playerResources < 2)}
                  tooltip="Re-rolling replaces your market cards and spends 2 resources."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    background: '#2a2a3e',
                    border: '1px solid #555',
                    borderRadius: 4,
                    color: (testMode || playerResources >= 2) && !disabled ? '#fff' : '#555',
                    cursor: disabled || (!testMode && playerResources < 2) ? 'not-allowed' : 'pointer',
                  }}
                >
                  Re-roll (2💰)
                </IrreversibleButton>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {archetypeMarket.length === 0 && (
                  <span style={{ color: '#666', fontSize: 12 }}>No cards available</span>
                )}
                {[...archetypeMarket].sort((a, b) => (a.buy_cost ?? 0) - (b.buy_cost ?? 0)).map((card) => {
                  const effCost = effectiveBuyCosts?.[card.id] ?? card.buy_cost;
                  const canAfford = testMode || (effCost !== null && playerResources >= (effCost ?? 0));
                  return fullView ? (
                    <FullShopCard
                      key={card.id}
                      card={card}
                      remaining={null}
                      canAfford={canAfford}
                      effectiveCost={effCost}
                      onBuy={() => onBuyArchetype(card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                      shiftHeld={shiftHeld}
                    />
                  ) : (
                    <CompactShopCard
                      key={card.id}
                      card={card}
                      remaining={null}
                      canAfford={canAfford}
                      effectiveCost={effCost}
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
                  disabled={disabled || (!testMode && playerResources < 5)}
                  tooltip="Buying an upgrade credit spends 5 resources."
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    background: '#2a2a3e',
                    border: '1px solid #555',
                    borderRadius: 4,
                    color: (testMode || playerResources >= 5) && !disabled ? '#fff' : '#555',
                    cursor: disabled || (!testMode && playerResources < 5) ? 'not-allowed' : 'pointer',
                  }}
                >
                  Buy Upgrade (5💰)
                </IrreversibleButton>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {[...neutralMarket].sort((a, b) => (a.card.buy_cost ?? 0) - (b.card.buy_cost ?? 0)).map((stack) => {
                  const effCost = effectiveBuyCosts?.[stack.card.id] ?? stack.card.buy_cost;
                  const canAfford = testMode || (effCost !== null && playerResources >= (effCost ?? 0));
                  return fullView ? (
                    <FullShopCard
                      key={stack.card.id}
                      card={stack.card}
                      remaining={stack.remaining}
                      canAfford={canAfford}
                      effectiveCost={effCost}
                      onBuy={() => onBuyNeutral(stack.card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                      shiftHeld={shiftHeld}
                    />
                  ) : (
                    <CompactShopCard
                      key={stack.card.id}
                      card={stack.card}
                      remaining={stack.remaining}
                      canAfford={canAfford}
                      effectiveCost={effCost}
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
        </div>
      </div>

      {/* Floating hover preview (fixed, viewport-relative) */}
      {hoverState && previewStyle && (
        <div style={{
          ...previewStyle,
          opacity: hoverVisible ? 1 : 0,
          transition: animMode === 'normal' ? 'opacity 0.15s ease' : 'none',
        }}>
          <CardFull card={shiftHeld ? getUpgradedPreview(hoverState.card) : hoverState.card} />
          {shiftHeld && hasUpgradePreview(hoverState.card) && (
            <div style={{
              textAlign: 'center',
              marginTop: 4,
              fontSize: 11,
              fontWeight: 'bold',
              color: '#4aff6a',
            }}>
              Upgraded
            </div>
          )}
        </div>
      )}
    </>
  );
}
