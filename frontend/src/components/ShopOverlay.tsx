import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import type { Card, MarketStack, CursorPosition, SharedPurchaseEvent } from '../types/game';
import Tooltip, { IrreversibleButton } from './Tooltip';
import { renderWithKeywords } from './Keywords';
import { useAnimationMode } from './SettingsContext';
import CardFull from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitlePart } from './SubtitlePartRenderer';
import { useSound } from '../audio/useSound';
import { CARD_TYPE_COLORS, CARD_TITLE_FONT, getCardDisplayColor } from '../constants/cardColors';
import { useCardZoom } from './CardZoomContext';

const CARD_EMOJI: Record<string, string> = {
  claim: '⚔️',
  defense: '🛡️',
  engine: '⚙️',
};

const ARCHETYPE_EMOJI: Record<string, string> = {
  vanguard: '🗡️',
  swarm: '🐝',
  fortress: '🏰',
  shared: '⬜',
};



interface ShopOverlayProps {
  archetypeMarket: Card[];
  sharedMarket: MarketStack[];
  playerResources: number;
  playerArchetype: string;
  effectiveBuyCosts?: Record<string, number>;
  onBuyArchetype: (cardId: string) => void;
  onBuyShared: (cardId: string) => void;
  onBuyUpgrade: () => void;
  onReroll: () => void;
  disabled: boolean;
  /** Grand Strategy: player cannot buy any cards this round */
  buyLocked?: boolean;
  onClose?: () => void;
  testMode?: boolean;
  /** Neutral market purchases from last round (by other players) */
  neutralPurchasesLastRound?: import('../types/game').SharedPurchaseRecord[];
  /** Current player ID (to filter out own purchases from the history) */
  currentPlayerId?: string;
  /** Current-turn purchases by all players (from buy_phase_purchases) */
  buyPhasePurchases?: Record<string, Array<{ card_id: string; card_name: string; source: string; cost: number }>>;
  /** Player map for looking up names */
  players?: Record<string, { name: string }>;
  /** Number of free re-rolls remaining (from Surveyor) */
  freeRerolls?: number;
  /** Names of Unique cards the player already owns (draw pile + hand + discard). */
  ownedUniqueCardNames?: Set<string>;
  /** Other players' cursor positions (for live hover indicators) */
  otherPlayerCursors?: Record<string, CursorPosition>;
  /** Timestamps of cursor clicks (for pulse animation) */
  cursorClicks?: Record<string, number>;
  /** Called when the player hovers/leaves a card (for cursor broadcasting) */
  onCardHoverChange?: (cardId: string | null, source: string | null) => void;
}

interface HoverState {
  card: Card;
  rect: DOMRect;
  effectiveCost?: number | null;
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


/** Compact card width — matches CardHand CARD_WIDTH */
const COMPACT_CARD_WIDTH = 154;
/** Compact card height — matches CardHand CARD_MIN_HEIGHT */

function CompactShopCard({
  card,
  remaining,
  canAfford,
  effectiveCost,
  onBuy,
  onHover,
  onLeave,
  disabled,
  disabledTooltip,
  purchaseHighlight,
  currentTurnPurchaseInfo,
  sellingOut,
  cursors,
  cursorClicks,
  onCardHoverChange,
}: {
  card: Card;
  remaining: number | null;
  canAfford: boolean;
  effectiveCost?: number | null;
  onBuy: () => void;
  onHover: (e: React.MouseEvent, card: Card, effectiveCost?: number | null) => void;
  onLeave: () => void;
  disabled: boolean;
  disabledTooltip?: string;
  purchaseHighlight?: boolean;
  /** Tooltip text for current-turn purchases by other players */
  currentTurnPurchaseInfo?: Array<{ playerName: string; count: number }>;
  /** Whether this stack is in selling-out state */
  sellingOut?: boolean;
  /** Other players' cursors hovering on this card */
  cursors?: CursorPosition[];
  /** Click timestamps for cursor pulse animation */
  cursorClicks?: Record<string, number>;
  /** Called when hover state changes for cursor broadcasting */
  onCardHoverChange?: (hovering: boolean) => void;
}) {
  const { showZoom } = useCardZoom();
  const displayCost = effectiveCost ?? card.buy_cost;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;
  const typeColor = getCardDisplayColor(card);
  const hasCurrentTurnPurchase = currentTurnPurchaseInfo && currentTurnPurchaseInfo.length > 0;
  const soldOut = remaining === 0;

  // Refs + one-shot layout measurement for title / subtitle shrink-to-fit.
  // Previously this used inline ref callbacks that re-ran on every parent
  // render, forcing a synchronous layout read+write for every compact card
  // on every render burst (shop has up to ~18 cards — that's ~36 forced
  // layouts per parent render). We only need to measure once: the card
  // instance is stable for the lifetime of this React tree node (the
  // parent keys by card.id) and the card container width is a constant.
  const titleSpanRef = useRef<HTMLSpanElement>(null);
  const subtitleSpanRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const titleEl = titleSpanRef.current;
    if (titleEl?.parentElement) {
      const scale = Math.min(1, titleEl.parentElement.clientWidth / titleEl.scrollWidth);
      titleEl.style.setProperty('--title-scale', String(scale));
    }
    const subEl = subtitleSpanRef.current;
    if (subEl?.parentElement) {
      const scale = Math.min(1, subEl.parentElement.clientWidth / subEl.scrollWidth);
      subEl.style.setProperty('--sub-scale', String(scale));
    }
    // Re-measure if the card's visual content changes. card.id is stable
    // per slot so this effectively runs once on mount; including name and
    // current_vp guards against in-place mutations (e.g. VP updates).
  }, [card.id, card.name, card.current_vp, card.description]);
  const isTrulySoldOut = soldOut && !sellingOut;
  const buyColor = (isTrulySoldOut || !canAfford || disabled) ? '#333' : sellingOut ? '#cc8833' : '#4a9eff';
  const purchaseLines = hasCurrentTurnPurchase
    ? currentTurnPurchaseInfo!.map(p => `${p.playerName} bought ${p.count} this round`).join('\n')
    : '';
  const buyTooltip = isTrulySoldOut
    ? 'Sold out'
    : sellingOut
    ? 'Last copy was bought! Still available to all players this round only.'
    : disabledTooltip
    ? disabledTooltip
    : [
        `Purchasing ${card.name} spends ${displayCost} resources and adds it to your discard pile.${isDiscounted ? ` (Reduced from ${card.buy_cost})` : ''}`,
        purchaseLines,
      ].filter(Boolean).join('\n');
  const buyLabel = isTrulySoldOut ? 'Sold Out' : sellingOut ? 'Selling Out!' : remaining !== null ? `Buy (${remaining} left)` : 'Buy';
  return (
    <div
      data-card-id={card.id}
      onMouseEnter={(e) => { onHover(e, card, effectiveCost); onCardHoverChange?.(true); }}
      onMouseLeave={() => { onLeave(); onCardHoverChange?.(false); }}
      onClick={() => showZoom(card)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        opacity: isTrulySoldOut ? 0.35 : disabled || !canAfford ? 0.5 : 1,
        position: 'relative',
      }}
    >
      {/* Other players' cursor indicators */}
      {cursors && cursors.length > 0 && (
        <div style={{ display: 'flex', gap: 3, position: 'absolute', top: -14, left: 4, zIndex: 5 }}>
          {cursors.map(c => {
            const isClicking = cursorClicks?.[c.player_id] && (Date.now() - cursorClicks[c.player_id]) < 600;
            return (
              <Tooltip key={c.player_id} content={c.player_name}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: c.player_color,
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 'bold',
                  boxShadow: isClicking
                    ? `0 0 0 4px ${c.player_color}40, 0 0 12px ${c.player_color}80`
                    : `0 0 4px ${c.player_color}60`,
                  transition: 'box-shadow 0.3s ease',
                  animation: isClicking ? undefined : 'cursorPulse 2s ease-in-out infinite',
                }}>
                  {(c.player_name.match(/[a-zA-Z]/)?.[0] ?? c.player_name.charAt(0)).toUpperCase()}
                </span>
              </Tooltip>
            );
          })}
        </div>
      )}
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
          <div style={{ fontWeight: 'bold', fontSize: 16, fontFamily: CARD_TITLE_FONT, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
            <span ref={titleSpanRef} style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }}>
              {card.name}
            </span>
          </div>
          <span style={{ fontSize: 15, flexShrink: 0, color: isDiscounted ? '#ffd700' : '#aaa', fontWeight: isDiscounted ? 'bold' : undefined, textShadow: isDiscounted ? '0 0 6px rgba(255,215,0,0.6)' : undefined, whiteSpace: 'nowrap' }}>
            {displayCost != null ? `${displayCost} 💰` : '—'}
          </span>
        </div>
        <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }} title={isDiscounted ? `Reduced from ${card.buy_cost} (dynamic discount)` : undefined}>
          <span ref={subtitleSpanRef} style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }}>
          {buildCardSubtitle(card).map((part, i) => renderSubtitlePart(part, i, { passiveVp: card.passive_vp }))}
          </span>
        </div>
      </div>
      {/* Selling Out badge */}
      {sellingOut && (
        <div style={{
          position: 'absolute',
          top: 2,
          right: 2,
          background: '#cc8833',
          color: '#fff',
          fontSize: 9,
          fontWeight: 'bold',
          padding: '1px 5px',
          borderRadius: 4,
          zIndex: 5,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}>
          Selling Out
        </div>
      )}
      {/* Buy button below card */}
      <IrreversibleButton
        onClick={(e) => { e.stopPropagation(); onBuy(); }}
        disabled={disabled || !canAfford || isTrulySoldOut}
        tooltip={buyTooltip}
        tooltipDelay={undefined}
        style={{
          width: COMPACT_CARD_WIDTH,
          padding: '3px 0',
          background: buyColor,
          border: 'none',
          borderRadius: 4,
          color: '#fff',
          fontSize: 11,
          fontWeight: 'bold',
          cursor: disabled || !canAfford || isTrulySoldOut ? 'not-allowed' : 'pointer',
          ...(purchaseHighlight || hasCurrentTurnPurchase ? { animation: 'shopPurchasePulse 2s ease-in-out infinite' } : {}),
        }}
      >
        {buyLabel}
      </IrreversibleButton>
    </div>
  );
}

/** Animated card that flies from a neutral market card to a player's HUD. */
export function PurchaseFlyAnimation({ event, onDone }: { event: SharedPurchaseEvent; onDone: () => void }) {
  const [style, setStyle] = useState<React.CSSProperties>({ display: 'none' });

  const typeColor = getCardDisplayColor(event.card);
  const subtitle = buildCardSubtitle(event.card);
  const displayCost = event.card.buy_cost;

  useEffect(() => {
    // Find source card element in the shop
    const sourceEl = document.querySelector(`[data-card-id="${event.card_id}"]`);
    // Self-purchases fly to discard pile; others fly to player hud
    const destEl = event.isSelf
      ? document.querySelector('[data-discard-pile]')
      : document.querySelector(`[data-player-hud="${event.player_id}"]`);
    if (!sourceEl || !destEl) {
      onDone();
      return;
    }
    const sr = sourceEl.getBoundingClientRect();
    const dr = destEl.getBoundingClientRect();
    const dx = (dr.left + dr.width / 2) - (sr.left + sr.width / 2);
    const dy = (dr.top + dr.height / 2) - (sr.top + sr.height / 2);

    setStyle({
      position: 'fixed',
      left: sr.left,
      top: sr.top,
      width: sr.width,
      zIndex: 9999,
      pointerEvents: 'none' as const,
      ['--fly-dx' as string]: `${dx}px`,
      ['--fly-dy' as string]: `${dy}px`,
      animation: 'purchaseFly 800ms ease-in forwards',
    });

    const timer = setTimeout(onDone, 810);
    return () => clearTimeout(timer);
  }, [event, onDone]);

  return (
    <div style={style}>
      <div style={{
        width: COMPACT_CARD_WIDTH,
        padding: 6,
        background: '#2a2a3e',
        border: `2px solid ${typeColor}`,
        borderRadius: 6,
        color: '#fff',
        boxSizing: 'border-box',
        overflow: 'hidden',
        boxShadow: `0 0 12px ${event.player_color}80, 0 2px 8px rgba(0,0,0,0.5)`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
          <div style={{ fontWeight: 'bold', fontSize: 16, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
            {event.card.name}
          </div>
          <span style={{ fontSize: 15, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>
            {displayCost != null ? `${displayCost} 💰` : '—'}
          </span>
        </div>
        <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {subtitle.map((part, i) => renderSubtitlePart(part, i, { passiveVp: event.card.passive_vp }))}
        </div>
      </div>
    </div>
  );
}

export default function ShopOverlay({
  archetypeMarket,
  sharedMarket,
  playerResources,
  playerArchetype,
  effectiveBuyCosts,
  onBuyArchetype,
  onBuyShared,
  onBuyUpgrade,
  onReroll,
  disabled,
  buyLocked,
  onClose,
  testMode,
  neutralPurchasesLastRound,
  currentPlayerId,
  buyPhasePurchases,
  players,
  freeRerolls = 0,
  ownedUniqueCardNames,
  otherPlayerCursors,
  cursorClicks,
  onCardHoverChange,
}: ShopOverlayProps) {
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const [hoverVisible, setHoverVisible] = useState(false);
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const animMode = useAnimationMode();
  const shiftHeld = useShiftKey();
  const sound = useSound();

  // Track archetype market slots so purchased cards show a placeholder instead of disappearing
  const [archetypeSlots, setArchetypeSlots] = useState<Array<{ card: Card; purchased: boolean }>>([]);

  useEffect(() => {
    setArchetypeSlots(prev => {
      const currentIds = new Set(archetypeMarket.map(c => c.id));
      const prevIds = new Set(prev.map(s => s.card.id));

      // Check if current market is a subset of previous slots (a purchase happened,
      // or a re-render with the same reduced market — keep purchased placeholders)
      const isSubset = prev.length > 0 && archetypeMarket.every(c => prevIds.has(c.id));

      if (isSubset && archetypeMarket.length < prev.length) {
        return prev.map(s => ({
          ...s,
          purchased: s.purchased || !currentIds.has(s.card.id),
        }));
      }

      // New set (reroll, new turn, initial load) — reset
      return archetypeMarket.map(c => ({ card: c, purchased: false }));
    });
  }, [archetypeMarket]);

  const buyArchetypeWithSound = useCallback((cardId: string) => {
    sound.cardPurchase();
    onBuyArchetype(cardId);
  }, [onBuyArchetype, sound]);

  const buyNeutralWithSound = useCallback((cardId: string) => {
    sound.cardPurchase();
    onBuyShared(cardId);
  }, [onBuyShared, sound]);

  // Floating "+1 Credit" animation state
  const [showCreditFloat, setShowCreditFloat] = useState(false);
  const creditFloatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buyUpgradeWithSound = useCallback(() => {
    sound.cardPurchase();
    onBuyUpgrade();
    // Trigger floating "+1 Credit" animation
    setShowCreditFloat(true);
    if (creditFloatTimerRef.current) clearTimeout(creditFloatTimerRef.current);
    creditFloatTimerRef.current = setTimeout(() => setShowCreditFloat(false), 1000);
  }, [onBuyUpgrade, sound]);

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
  const currentTurnSharedPurchases = useMemo(() => {
    const map = new Map<string, Array<{ playerName: string; count: number }>>();
    if (!buyPhasePurchases) return map;
    for (const [pid, purchases] of Object.entries(buyPhasePurchases)) {
      if (pid === currentPlayerId) continue; // skip own purchases
      // Count neutral purchases per card_id
      const counts = new Map<string, number>();
      for (const p of purchases) {
        if (p.source === 'shared') {
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

  // Track which neutral cards the current player already bought this round (1 per round limit)
  const mySharedPurchasesThisRound = useMemo(() => {
    const set = new Set<string>();
    if (!buyPhasePurchases || !currentPlayerId) return set;
    const myPurchases = buyPhasePurchases[currentPlayerId];
    if (!myPurchases) return set;
    for (const p of myPurchases) {
      if (p.source === 'shared') {
        set.add(p.card_id);
      }
    }
    return set;
  }, [buyPhasePurchases, currentPlayerId]);

  const handleCardHover = useCallback((e: React.MouseEvent, card: Card, effectiveCost?: number | null) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHoverVisible(false);
    setHoverState({ card, rect, effectiveCost });
  }, []);

  // Keep a snapshot of the last hover state so we can animate out
  const [displayedHover, setDisplayedHover] = useState<HoverState | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCardLeave = useCallback(() => {
    setHoverState(null);
    setHoverVisible(false);
  }, []);

  // Trigger fade-in on hover; on leave, delay unmount for exit animation
  useEffect(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (hoverState) {
      setDisplayedHover(hoverState);
      if (animMode !== 'off') {
        requestAnimationFrame(() => setHoverVisible(true));
      } else {
        setHoverVisible(true);
      }
    } else {
      // Keep displayedHover alive during exit animation, then clear
      const duration = animMode === 'off' ? 0 : animMode === 'fast' ? 60 : 120;
      hoverTimeoutRef.current = setTimeout(() => setDisplayedHover(null), duration);
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
      ...sharedMarket.map(s => s.card),
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
  }, [archetypeMarket, sharedMarket]);

  // Position hover preview above the card (fixed, viewport-relative)
  const previewStyle = displayedHover ? (() => {
    const { rect } = displayedHover;
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
        @keyframes cursorPulse {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50% { transform: scale(1.15); opacity: 1; }
        }
        @keyframes purchaseFly {
          0% { transform: translate(0, 0) scale(1); opacity: 1; }
          20% { transform: translate(0, -12px) scale(1.1); opacity: 1; }
          90% { transform: translate(calc(var(--fly-dx) * 0.95), calc(var(--fly-dy) * 0.95)) scale(0.35); opacity: 1; }
          100% { transform: translate(var(--fly-dx), var(--fly-dy)) scale(0.3); opacity: 0; }
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
          width: 'min(92vw, 850px)',
          background: '#12122a',
          border: '2px solid #4a4a6a',
          borderRadius: 12,
          boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '85vh',
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
          <span style={{ fontSize: 16, fontWeight: 'bold', color: '#fff' }}>
            · You have <span style={{ color: '#ffcc00' }}>{playerResources}</span> resource{playerResources !== 1 ? 's' : ''}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
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
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <Tooltip content="These cards are unique to your archetype, randomly drawn from your deck pack pool and only available this round.">
                  <span style={{ fontSize: 20, fontWeight: 'bold', color: '#ccc', cursor: 'help' }}>{playerArchetype.charAt(0).toUpperCase() + playerArchetype.slice(1)} Market</span>
                </Tooltip>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>New card options every round</div>
              </div>
              {/* Archetype cards — full-width wrap row, centered */}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  justifyContent: 'center',
                  alignItems: 'flex-start',
                }}
              >
                  {archetypeSlots.length === 0 && (
                    <span style={{ color: '#666', fontSize: 12 }}>No cards available</span>
                  )}
                  {[...archetypeSlots].sort((a, b) => (a.card.buy_cost ?? 0) - (b.card.buy_cost ?? 0)).map(({ card, purchased }) => {
                    if (purchased) {
                      // Render the real card invisibly to preserve exact dimensions,
                      // with a "Purchased!" overlay on top
                      const cardW = COMPACT_CARD_WIDTH;
                      return (
                        <div key={card.id} data-card-id={card.id} style={{
                          width: cardW,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}>
                          <div style={{ position: 'relative', width: cardW }}>
                            {/* Invisible card — preserves height */}
                            <div style={{ visibility: 'hidden' }}>
                              <div style={{
                                    width: COMPACT_CARD_WIDTH,
                                    padding: 6,
                                    background: '#2a2a3e',
                                    border: '2px solid #333',
                                    borderRadius: 6,
                                    boxSizing: 'border-box',
                                    overflow: 'hidden',
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
                                      <div style={{ fontWeight: 'bold', fontSize: 16, fontFamily: CARD_TITLE_FONT }}>{card.name}</div>
                                    </div>
                                    <div style={{ fontSize: 15, color: '#aaa' }}>&nbsp;</div>
                                  </div>
                            </div>
                            {/* Overlay — exact same size */}
                            <div style={{
                              position: 'absolute',
                              inset: 0,
                              background: '#1a1a2e',
                              border: '2px dashed #333',
                              borderRadius: 6,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              boxSizing: 'border-box',
                            }}>
                              <span style={{ color: '#4a9eff', fontWeight: 'bold', fontSize: 13 }}>Purchased!</span>
                            </div>
                          </div>
                          <button
                            disabled
                            style={{
                              width: cardW,
                              padding: '3px 0',
                              background: '#333',
                              border: 'none',
                              borderRadius: 4,
                              color: '#fff',
                              fontSize: 11,
                              fontWeight: 'bold',
                              cursor: 'not-allowed',
                              opacity: 0.55,
                            }}
                          >
                            Buy
                          </button>
                        </div>
                      );
                    }
                    const effCost = effectiveBuyCosts?.[card.id] ?? card.buy_cost;
                    const canAfford = effCost !== null && playerResources >= (effCost ?? 0);
                    const alreadyOwnsUnique = !!card.unique && !!ownedUniqueCardNames?.has(card.name);
                    return (
                      <CompactShopCard
                        key={card.id}
                        card={card}
                        remaining={null}
                        canAfford={canAfford}
                        effectiveCost={effCost}
                        onBuy={() => buyArchetypeWithSound(card.id)}
                        onHover={handleCardHover}
                        onLeave={handleCardLeave}
                        disabled={disabled || !!buyLocked || alreadyOwnsUnique}
                        disabledTooltip={
                          buyLocked ? 'Cannot buy — Grand Strategy was played this round.'
                          : alreadyOwnsUnique ? 'You already own a copy of this Unique card.'
                          : undefined
                        }
                      />
                    );
                  })}
                </div>

              {/* Re-roll — below archetype cards, matching the upgrade-credit row style */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 12 }}>
                <div style={{ flexShrink: 0 }}>
                  {freeRerolls > 0 ? (
                    <Tooltip content={`You have ${freeRerolls} free re-roll${freeRerolls !== 1 ? 's' : ''} remaining (from Surveyor).`}>
                      <button
                        onClick={onReroll}
                        disabled={disabled || (freeRerolls <= 0 && playerResources < 1)}
                        style={{
                          fontSize: 14,
                          padding: '8px 16px',
                          background: '#2a5a2e',
                          border: '1px solid #4aff6a',
                          borderRadius: 6,
                          color: !disabled ? '#fff' : '#555',
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                          ...(disabled ? {} : { animation: 'shopPurchasePulse 2s ease-in-out infinite' }),
                        }}
                      >
                        {`Re-roll (${freeRerolls} free)`}
                      </button>
                    </Tooltip>
                  ) : (
                    <button
                      onClick={onReroll}
                      disabled={disabled || playerResources < 1}
                      style={{
                        fontSize: 14,
                        padding: '8px 16px',
                        background: playerResources >= 2 && !disabled ? '#cc7a2a' : '#333',
                        border: `1px solid ${playerResources >= 2 && !disabled ? '#cc7a2a' : '#555'}`,
                        borderRadius: 6,
                        color: playerResources >= 2 && !disabled ? '#fff' : '#555',
                        cursor: disabled || playerResources < 1 ? 'not-allowed' : 'pointer',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                    >
                      Re-roll · 1 💰
                    </button>
                  )}
                </div>
                <span style={{ fontSize: 11, color: '#888', maxWidth: 260 }}>
                  Cards given from a re-roll are guaranteed to be different from existing cards.
                </span>
              </div>
            </div>

            {/* Shared Market */}
            <div>
              <div style={{ textAlign: 'center', marginBottom: 12 }}>
                <Tooltip content="Purchases from the shared market are visible to all players. Each card has limited copies — once they're gone, they're gone for the game.">
                  <span style={{ fontSize: 20, fontWeight: 'bold', color: '#ccc', cursor: 'help' }}>Shared Market</span>
                </Tooltip>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>Limit 1 copy of each card per round</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'center' }}>
                {[...sharedMarket].sort((a, b) => (a.card.buy_cost ?? 0) - (b.card.buy_cost ?? 0)).map((stack) => {
                  const effCost = effectiveBuyCosts?.[stack.card.id] ?? stack.card.buy_cost;
                  const canAfford = effCost !== null && playerResources >= (effCost ?? 0);
                  const purchasedBy = neutralPurchaseMap.get(stack.card.id);
                  const turnPurchases = currentTurnSharedPurchases.get(stack.card.id);
                  const alreadyBoughtThisRound = mySharedPurchasesThisRound.has(stack.card.id);
                  const sellingOutBoughtByMe = stack.selling_out && stack.selling_out_bought_by?.includes(currentPlayerId ?? '');
                  const alreadyOwnsUnique = !!stack.card.unique && !!ownedUniqueCardNames?.has(stack.card.name);
                  // Gather cursors hovering on this card
                  const cardCursors = otherPlayerCursors
                    ? Object.values(otherPlayerCursors).filter(
                        c => c.hovered_card_id === stack.card.id && c.source === 'shared'
                      )
                    : [];
                  return (
                    <CompactShopCard
                      key={stack.card.id}
                      card={stack.card}
                      remaining={stack.remaining}
                      canAfford={canAfford}
                      effectiveCost={effCost}
                      onBuy={() => buyNeutralWithSound(stack.card.id)}
                      onHover={handleCardHover}
                      onLeave={handleCardLeave}
                      disabled={disabled || !!buyLocked || alreadyBoughtThisRound || !!sellingOutBoughtByMe || alreadyOwnsUnique}
                      disabledTooltip={
                        buyLocked ? 'Cannot buy — Grand Strategy was played this round.'
                        : alreadyOwnsUnique ? 'You already own a copy of this Unique card.'
                        : sellingOutBoughtByMe ? 'Already purchased (Selling Out).'
                        : alreadyBoughtThisRound ? 'Already purchased this round (limit 1 copy per round).'
                        : undefined
                      }
                      purchaseHighlight={!!purchasedBy}
                      currentTurnPurchaseInfo={turnPurchases}
                      sellingOut={stack.selling_out}
                      cursors={cardCursors}
                      cursorClicks={cursorClicks}
                      onCardHoverChange={onCardHoverChange ? (hovering) => onCardHoverChange(hovering ? stack.card.id : null, hovering ? 'shared' : null) : undefined}
                    />
                  );
                })}
              </div>
            </div>

            {/* Upgrade Credit — below shared market */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div
                style={{ position: 'relative', flexShrink: 0 }}
                onMouseEnter={() => onCardHoverChange?.('__upgrade_credit', 'shared')}
                onMouseLeave={() => onCardHoverChange?.(null, null)}
              >
                {/* Other players' cursor indicators */}
                {otherPlayerCursors && (() => {
                  const upgCursors = Object.values(otherPlayerCursors).filter(
                    c => c.hovered_card_id === '__upgrade_credit' && c.source === 'shared'
                  );
                  return upgCursors.length > 0 ? (
                    <div style={{ display: 'flex', gap: 3, position: 'absolute', top: -14, left: 4, zIndex: 5 }}>
                      {upgCursors.map(c => {
                        const isClicking = cursorClicks?.[c.player_id] && (Date.now() - cursorClicks[c.player_id]) < 600;
                        return (
                          <Tooltip key={c.player_id} content={c.player_name}>
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 16,
                              height: 16,
                              borderRadius: '50%',
                              background: c.player_color,
                              color: '#fff',
                              fontSize: 9,
                              fontWeight: 'bold',
                              boxShadow: isClicking
                                ? `0 0 0 4px ${c.player_color}40, 0 0 12px ${c.player_color}80`
                                : `0 0 4px ${c.player_color}60`,
                              transition: 'box-shadow 0.3s ease',
                              animation: isClicking ? undefined : 'cursorPulse 2s ease-in-out infinite',
                            }}>
                              {(c.player_name.match(/[a-zA-Z]/)?.[0] ?? c.player_name.charAt(0)).toUpperCase()}
                            </span>
                          </Tooltip>
                        );
                      })}
                    </div>
                  ) : null;
                })()}
                {showCreditFloat && (
                  <>
                    <style>{`
                      @keyframes creditFloatUp {
                        0% { opacity: 1; transform: translate(-50%, 0); }
                        100% { opacity: 0; transform: translate(-50%, -32px); }
                      }
                    `}</style>
                    <span style={{
                      position: 'absolute',
                      top: -4,
                      left: '50%',
                      color: '#4aff6a',
                      fontWeight: 'bold',
                      fontSize: 14,
                      pointerEvents: 'none',
                      animation: 'creditFloatUp 1s ease-out forwards',
                      zIndex: 10,
                      whiteSpace: 'nowrap',
                    }}>
                      +1 Credit
                    </span>
                  </>
                )}
              {(() => {
                const upgradeButton = (
                  <button
                    onClick={buyUpgradeWithSound}
                    disabled={disabled || !!buyLocked || playerResources < 5}
                    style={{
                      fontSize: 14,
                      padding: '8px 16px',
                      background: playerResources >= 5 && !disabled && !buyLocked ? '#cc7a2a' : '#333',
                      border: `1px solid ${playerResources >= 5 && !disabled && !buyLocked ? '#cc7a2a' : '#555'}`,
                      borderRadius: 6,
                      color: playerResources >= 5 && !disabled && !buyLocked ? '#fff' : '#555',
                      cursor: disabled || buyLocked || playerResources < 5 ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    Buy Upgrade Credit · 5 💰
                  </button>
                );
                return buyLocked ? (
                  <Tooltip content="Cannot buy — Grand Strategy was played this round.">
                    {upgradeButton}
                  </Tooltip>
                ) : upgradeButton;
              })()}
              </div>
              <span style={{ fontSize: 11, color: '#888', maxWidth: 260 }}>
                Upgrade credits can be spent during your play phase to upgrade any card in your hand.
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Floating hover preview (fixed, viewport-relative) */}
      {displayedHover && previewStyle && (
        <div style={{
          ...previewStyle,
          opacity: hoverVisible ? 1 : 0,
          transform: hoverVisible ? 'scale(1)' : 'scale(0.9)',
          transition: animMode !== 'off' ? `opacity ${animMode === 'fast' ? 0.06 : 0.12}s ease, transform ${animMode === 'fast' ? 0.06 : 0.12}s ease` : 'none',
        }}>
          <CardFull card={shiftHeld ? getUpgradedPreview(displayedHover.card) : displayedHover.card} effectiveCost={shiftHeld ? undefined : displayedHover.effectiveCost} showKeywordHints />
          {shiftHeld && hasUpgradePreview(displayedHover.card) && (
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
            const buyer = neutralPurchaseMap.get(displayedHover.card.id);
            const turnPurchases = currentTurnSharedPurchases.get(displayedHover.card.id);
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
                  <div key={i}>{p.playerName} bought {p.count} this round</div>
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
