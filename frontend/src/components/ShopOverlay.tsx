import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Card, MarketStack } from '../types/game';
import Tooltip, { IrreversibleButton } from './Tooltip';
import { renderWithKeywords } from './Keywords';
import { useAnimationMode } from './SettingsContext';
import CardFull, { CARD_FULL_WIDTH } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { buildCardSubtitle } from './cardSubtitle';

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
  currentUpkeep: number;
  onBuyArchetype: (cardId: string) => void;
  onBuyNeutral: (cardId: string) => void;
  onBuyUpgrade: () => void;
  onReroll: () => void;
  disabled: boolean;
  onClose?: () => void;
  testMode?: boolean;
  /** Neutral market purchases from last round (by other players) */
  neutralPurchasesLastRound?: import('../types/game').NeutralPurchaseRecord[];
  /** Current player ID (to filter out own purchases from the history) */
  currentPlayerId?: string;
  /** Current-turn purchases by all players (from buy_phase_purchases) */
  buyPhasePurchases?: Record<string, Array<{ card_id: string; card_name: string; source: string; cost: number }>>;
  /** Player map for looking up names */
  players?: Record<string, { name: string }>;
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
  upkeepWarning,
  onBuy,
  onHover,
  onLeave,
  disabled,
  shiftHeld,
  disabledTooltip,
  purchaseHighlight,
  currentTurnPurchaseInfo,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  effectiveCost?: number | null;
  upkeepWarning: boolean;
  onBuy: () => void;
  onHover: (e: React.MouseEvent, card: Card) => void;
  onLeave: () => void;
  disabled: boolean;
  shiftHeld: boolean;
  disabledTooltip?: string;
  purchaseHighlight?: boolean;
  /** Tooltip text for current-turn purchases by other players */
  currentTurnPurchaseInfo?: Array<{ playerName: string; count: number }>;
}) {
  const displayCost = effectiveCost ?? card.buy_cost;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  const hasCurrentTurnPurchase = currentTurnPurchaseInfo && currentTurnPurchaseInfo.length > 0;
  const buyColor = !canAfford || disabled ? '#333' : upkeepWarning ? '#cc7a2a' : '#4a9eff';
  const purchaseLines = hasCurrentTurnPurchase
    ? currentTurnPurchaseInfo!.map(p => `${p.playerName} bought ${p.count} this turn`).join('\n')
    : '';
  const buyTooltip = disabledTooltip
    ? disabledTooltip
    : [
        upkeepWarning
          ? `⚠ Purchasing ${card.name} will not leave you with enough resources for your next upkeep.`
          : `Purchasing ${card.name} spends ${displayCost} resources and adds it to your discard pile.${isDiscounted ? ` (Reduced from ${card.buy_cost})` : ''}`,
        purchaseLines,
      ].filter(Boolean).join('\n');
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
        tooltip={buyTooltip}
        style={{
          width: CARD_FULL_WIDTH,
          padding: '4px 0',
          background: buyColor,
          border: 'none',
          borderRadius: 5,
          color: '#fff',
          fontSize: 12,
          fontWeight: 'bold',
          cursor: disabled || !canAfford ? 'not-allowed' : 'pointer',
          ...(purchaseHighlight || hasCurrentTurnPurchase ? { animation: 'shopPurchasePulse 2s ease-in-out infinite' } : {}),
        }}
      >
        Buy{displayCost !== null ? ` (${displayCost}${isDiscounted ? '*' : ''}💰)` : ''}
      </IrreversibleButton>
    </div>
  );
}

/** Compact card width — matches CardHand CARD_WIDTH */
const COMPACT_CARD_WIDTH = 154;
/** Compact card height — matches CardHand CARD_MIN_HEIGHT */

function CompactShopCard({
  card,
  remaining,
  canAfford,
  effectiveCost,
  upkeepWarning,
  onBuy,
  onHover,
  onLeave,
  disabled,
  disabledTooltip,
  purchaseHighlight,
  currentTurnPurchaseInfo,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  effectiveCost?: number | null;
  upkeepWarning: boolean;
  onBuy: () => void;
  onHover: (e: React.MouseEvent, card: Card) => void;
  onLeave: () => void;
  disabled: boolean;
  disabledTooltip?: string;
  purchaseHighlight?: boolean;
  /** Tooltip text for current-turn purchases by other players */
  currentTurnPurchaseInfo?: Array<{ playerName: string; count: number }>;
}) {
  const displayCost = effectiveCost ?? card.buy_cost;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;
  const typeColor = TYPE_COLORS[card.card_type] || '#4a9eff';
  const hasCurrentTurnPurchase = currentTurnPurchaseInfo && currentTurnPurchaseInfo.length > 0;
  const buyColor = !canAfford || disabled ? '#333' : upkeepWarning ? '#cc7a2a' : '#4a9eff';
  const purchaseLines = hasCurrentTurnPurchase
    ? currentTurnPurchaseInfo!.map(p => `${p.playerName} bought ${p.count} this turn`).join('\n')
    : '';
  const buyTooltip = disabledTooltip
    ? disabledTooltip
    : [
        upkeepWarning
          ? `⚠ Purchasing ${card.name} will not leave you with enough resources for your next upkeep.`
          : `Purchasing ${card.name} spends ${displayCost} resources and adds it to your discard pile.${isDiscounted ? ` (Reduced from ${card.buy_cost})` : ''}`,
        purchaseLines,
      ].filter(Boolean).join('\n');
  const buyLabel = remaining !== null ? `Buy (${remaining} left)` : 'Buy';
  return (
    <div
      data-card-id={card.id}
      onMouseEnter={(e) => onHover(e, card)}
      onMouseLeave={onLeave}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        opacity: disabled || !canAfford ? 0.5 : 1,
      }}
    >
      {/* Card element — same dimensions as CardHand compact cards */}
      <div style={{
        width: COMPACT_CARD_WIDTH,
        padding: 6,
        background: '#2a2a3e',
        border: `2px solid ${canAfford && !disabled ? typeColor : '#333'}`,
        borderRadius: 6,
        color: '#fff',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
          <div style={{ fontWeight: 'bold', fontSize: 16, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
            <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
              if (el) {
                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                el.style.setProperty('--title-scale', String(scale));
              }
            }}>
              {card.name}
            </span>
          </div>
          <span style={{ fontSize: 15, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{card.buy_cost != null ? `${card.buy_cost}💰` : ''}</span>
        </div>
        <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }} title={isDiscounted ? `Reduced from ${card.buy_cost} (dynamic discount)` : undefined}>
          <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
            if (el) {
              const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
              el.style.setProperty('--sub-scale', String(scale));
            }
          }}>
          {buildCardSubtitle(card).map((part, i) => {
            const isVp = part.endsWith('★');
            const vpColor = card.passive_vp !== undefined && card.passive_vp < 0 ? '#ff6666' : '#ffd700';
            return <span key={i} style={isVp ? { color: vpColor } : undefined}>{i > 0 ? ' · ' : ''}{part}</span>;
          })}
          </span>
        </div>
      </div>
      {/* Buy button below card */}
      <IrreversibleButton
        onClick={onBuy}
        disabled={disabled || !canAfford}
        tooltip={buyTooltip}
        style={{
          width: COMPACT_CARD_WIDTH,
          padding: '3px 0',
          background: buyColor,
          border: 'none',
          borderRadius: 4,
          color: '#fff',
          fontSize: 11,
          fontWeight: 'bold',
          cursor: disabled || !canAfford ? 'not-allowed' : 'pointer',
          ...(purchaseHighlight || hasCurrentTurnPurchase ? { animation: 'shopPurchasePulse 2s ease-in-out infinite' } : {}),
        }}
      >
        {buyLabel}
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
  currentUpkeep,
  onBuyArchetype,
  onBuyNeutral,
  onBuyUpgrade,
  onReroll,
  disabled,
  onClose,
  testMode,
  neutralPurchasesLastRound,
  currentPlayerId,
  buyPhasePurchases,
  players,
}: ShopOverlayProps) {
  const [fullView, setFullViewRaw] = useState(() => shopViewMemory ?? false);
  const setFullView = useCallback((v: boolean) => { setFullViewRaw(v); shopViewMemory = v; }, []);
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const [hoverVisible, setHoverVisible] = useState(false);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const animMode = useAnimationMode();
  const shiftHeld = useShiftKey();

  // Build lookup: neutral card_id → purchaser name (from other players last round)
  const neutralPurchaseMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!neutralPurchasesLastRound) return map;
    for (const entry of neutralPurchasesLastRound) {
      if (entry.player_id !== currentPlayerId) {
        map.set(entry.card_id, entry.player_name);
      }
    }
    return map;
  }, [neutralPurchasesLastRound, currentPlayerId]);

  // Build lookup: neutral card_id → [{ playerName, count }] for current-turn purchases by OTHER players
  const currentTurnNeutralPurchases = useMemo(() => {
    const map = new Map<string, Array<{ playerName: string; count: number }>>();
    if (!buyPhasePurchases) return map;
    for (const [pid, purchases] of Object.entries(buyPhasePurchases)) {
      if (pid === currentPlayerId) continue; // skip own purchases
      // Count neutral purchases per card_id
      const counts = new Map<string, number>();
      for (const p of purchases) {
        if (p.source === 'neutral') {
          counts.set(p.card_id, (counts.get(p.card_id) ?? 0) + 1);
        }
      }
      const playerName = players?.[pid]?.name ?? pid;
      for (const [cardId, count] of counts) {
        const existing = map.get(cardId) ?? [];
        existing.push({ playerName, count });
        map.set(cardId, existing);
      }
    }
    return map;
  }, [buyPhasePurchases, currentPlayerId, players]);

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

  const speed = animMode === 'fast' ? 0.5 : 1;
  const panelTransition = animMode !== 'off'
    ? `opacity ${0.25 * speed}s ease, transform ${0.25 * speed}s ease`
    : 'none';

  return (
    <>
      <style>{`
        @keyframes shopPurchasePulse {
          0%, 100% { box-shadow: 0 0 4px rgba(255, 170, 74, 0.3); outline: 2px solid rgba(255, 170, 74, 0.3); outline-offset: -1px; }
          50% { box-shadow: 0 0 12px rgba(255, 170, 74, 0.7), 0 0 4px rgba(255, 170, 74, 0.4); outline: 2px solid rgba(255, 170, 74, 0.85); outline-offset: -1px; }
        }
      `}</style>
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
        transition: animMode !== 'off' ? `opacity ${0.25 * speed}s ease` : 'none',
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
                <Tooltip content="Re-rolling replaces your market cards and spends 2 resources.">
                  <button
                    onClick={onReroll}
                    disabled={disabled || (!testMode && playerResources < 2)}
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
                  </button>
                </Tooltip>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {archetypeMarket.length === 0 && (
                  <span style={{ color: '#666', fontSize: 12 }}>No cards available</span>
                )}
                {[...archetypeMarket].sort((a, b) => (a.buy_cost ?? 0) - (b.buy_cost ?? 0)).map((card) => {
                  const effCost = effectiveBuyCosts?.[card.id] ?? card.buy_cost;
                  const canAfford = testMode || (effCost !== null && playerResources >= (effCost ?? 0));
                  const wouldDipBelowUpkeep = canAfford && effCost !== null && (playerResources - (effCost ?? 0)) < currentUpkeep;
                  return fullView ? (
                    <FullShopCard
                      key={card.id}
                      card={card}
                      remaining={null}
                      canAfford={canAfford}
                      effectiveCost={effCost}
                      upkeepWarning={wouldDipBelowUpkeep}
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
                      upkeepWarning={wouldDipBelowUpkeep}
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
                <Tooltip content="Upgrade credits can be spent during the Plan phase to upgrade a card in your hand.">
                  <button
                    onClick={onBuyUpgrade}
                    disabled={disabled || (!testMode && playerResources < 5)}
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
                  </button>
                </Tooltip>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {[...neutralMarket].sort((a, b) => (a.card.buy_cost ?? 0) - (b.card.buy_cost ?? 0)).map((stack) => {
                  const effCost = effectiveBuyCosts?.[stack.card.id] ?? stack.card.buy_cost;
                  const canAfford = testMode || (effCost !== null && playerResources >= (effCost ?? 0));
                  const wouldDipBelowUpkeep = canAfford && effCost !== null && (playerResources - (effCost ?? 0)) < currentUpkeep;
                  const purchasedBy = neutralPurchaseMap.get(stack.card.id);
                  const turnPurchases = currentTurnNeutralPurchases.get(stack.card.id);
                  return fullView ? (
                    <FullShopCard
                      key={stack.card.id}
                      card={stack.card}
                      remaining={stack.remaining}
                      canAfford={canAfford}
                      effectiveCost={effCost}
                      upkeepWarning={wouldDipBelowUpkeep}
                      onBuy={() => onBuyNeutral(stack.card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                      shiftHeld={shiftHeld}
                      purchaseHighlight={!!purchasedBy}
                      currentTurnPurchaseInfo={turnPurchases}
                    />
                  ) : (
                    <CompactShopCard
                      key={stack.card.id}
                      card={stack.card}
                      remaining={stack.remaining}
                      canAfford={canAfford}
                      effectiveCost={effCost}
                      upkeepWarning={wouldDipBelowUpkeep}
                      onBuy={() => onBuyNeutral(stack.card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled}
                      purchaseHighlight={!!purchasedBy}
                      currentTurnPurchaseInfo={turnPurchases}
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
          <CardFull card={shiftHeld ? getUpgradedPreview(hoverState.card) : hoverState.card} showKeywordHints />
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
          {(() => {
            const buyer = neutralPurchaseMap.get(hoverState.card.id);
            const turnPurchases = currentTurnNeutralPurchases.get(hoverState.card.id);
            if (!buyer && !turnPurchases) return null;
            return (
              <div style={{
                textAlign: 'center',
                marginTop: 6,
                background: '#111122',
                border: '1px solid #555',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 11,
                color: '#ffaa4a',
                fontWeight: 'bold',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}>
                {turnPurchases?.map((p, i) => (
                  <div key={i}>{p.playerName} bought {p.count} this turn</div>
                ))}
                {buyer && <div style={{ color: '#888' }}>{buyer} purchased this last round</div>}
              </div>
            );
          })()}
        </div>
      )}
    </>
  );
}
