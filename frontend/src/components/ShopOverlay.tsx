import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import CardName, { plainCardName } from './CardName';
import type { Card, MarketStack, CursorPosition, SharedPurchaseEvent } from '../types/game';
import Tooltip, { IrreversibleButton } from './Tooltip';
import { useAnimationMode } from './SettingsContext';
import CardFull from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitle } from './SubtitlePartRenderer';
import Icon from '../icons/Icon';
import { useSound } from '../audio/useSound';
import { CARD_TITLE_FONT, getCardDisplayColor, miniCardBackground } from '../constants/cardColors';
import { useCardZoom } from './CardZoomContext';

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
  buyPhasePurchases?: Record<string, Array<{ card_id: string; definition_id?: string; card_name: string; source: string; cost: number }>>;
  /** Player map for looking up names */
  players?: Record<string, { name: string }>;
  /** Number of free re-rolls remaining (from Surveyor) */
  freeRerolls?: number;
  /** Effective re-roll cost after active cost reductions (e.g. Supply Line). */
  effectiveRerollCost?: number;
  /** Effective upgrade-credit cost after active cost reductions. */
  effectiveUpgradeCreditCost?: number;
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

/** Normalise a card display color to 6-digit hex (miniCardBackground appends alpha). */
function hex6(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : '#555555';
}

/** Gold coin glyph used for prices inside the shop. */
function Coin() {
  return <Icon name="resource" size="1em" trim decorative style={{ color: 'var(--cc-gold)' }} />;
}

function ChestIcon() {
  return (
    <svg className="cc-ov-shop-head-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5C3 7.2 5.4 5 8 5h8c2.6 0 5 2.2 5 5.5H3z" fill="currentColor" fillOpacity="0.2" />
      <path d="M3 10.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-7.5" />
      <path d="M3 13.5h7.5M13.5 13.5H21" />
      <rect x="10.5" y="11.5" width="3" height="4.2" rx="0.7" fill="currentColor" />
    </svg>
  );
}

function RerollIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 3v5h5" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 21v-5h-5" />
    </svg>
  );
}

function UpgradeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 12l6-6 6 6" />
      <path d="M6 18l6-6 6 6" />
    </svg>
  );
}

/** Small colored initials for other players hovering a market item. */
function CursorBadges({ cursors, cursorClicks }: { cursors: CursorPosition[]; cursorClicks?: Record<string, number> }) {
  return (
    <div style={{ display: 'flex', gap: 3, position: 'absolute', top: -14, left: 4, zIndex: 5 }}>
      {cursors.map(c => {
        const isClicking = cursorClicks?.[c.player_id] && (Date.now() - cursorClicks[c.player_id]) < 600;
        return (
          <Tooltip key={c.player_id} content={c.player_name}>
            <span
              className="cc-ov-cursor"
              style={{
                background: c.player_color,
                boxShadow: isClicking
                  ? `0 0 0 4px ${c.player_color}40, 0 0 12px ${c.player_color}80`
                  : `0 0 4px ${c.player_color}60`,
                transition: 'box-shadow 0.3s ease',
                animation: isClicking ? undefined : 'cursorPulse 2s ease-in-out infinite',
              }}
            >
              {(c.player_name.match(/[a-zA-Z]/)?.[0] ?? c.player_name.charAt(0)).toUpperCase()}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Compact card width — matches CardHand CARD_WIDTH */
const COMPACT_CARD_WIDTH = 154;

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
  viewOnly,
  animate,
  animIndex = 0,
  justBought,
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
  /** Shop is browse-only (outside the buy phase / done buying): keep affordable
   *  tiles at full strength so the market still reads at a glance. */
  viewOnly?: boolean;
  /** Play the staggered entrance animation. */
  animate?: boolean;
  /** Position in the stagger sequence. */
  animIndex?: number;
  /** This card was just bought — play the purchase pop. */
  justBought?: boolean;
}) {
  const { showZoom } = useCardZoom();
  const displayCost = effectiveCost ?? card.buy_cost;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;
  const typeColor = hex6(getCardDisplayColor(card));
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
        `Purchasing ${plainCardName(card.name)} spends ${displayCost} resources and adds it to your discard pile.${isDiscounted ? ` (Reduced from ${card.buy_cost})` : ''}`,
        purchaseLines,
      ].filter(Boolean).join('\n');
  // Visual state: sold out > can't afford > blocked (per-card reason, or any
  // disabled reason while the shop is purchasable).
  const stateClass = isTrulySoldOut
    ? ' is-soldout'
    : !canAfford
    ? ' is-unaffordable'
    : disabled && (!viewOnly || !!disabledTooltip)
    ? ' is-dim'
    : '';
  const costClass = isDiscounted ? ' is-discount' : !canAfford && !isTrulySoldOut ? ' is-short' : '';
  return (
    <div
      data-card-id={card.id}
      className={`cc-ov-shop-item${stateClass}${animate ? ' cc-ov-anim' : ''}${justBought ? ' is-bought' : ''}`}
      onMouseEnter={(e) => { onHover(e, card, effectiveCost); onCardHoverChange?.(true); }}
      onMouseLeave={() => { onLeave(); onCardHoverChange?.(false); }}
      onClick={() => showZoom(card)}
      style={animate ? { ['--i' as string]: Math.min(animIndex, 16) } : undefined}
    >
      {/* Other players' cursor indicators */}
      {cursors && cursors.length > 0 && (
        <CursorBadges cursors={cursors} cursorClicks={cursorClicks} />
      )}
      {/* Card element — same dimensions as CardHand compact cards */}
      <div
        className="cc-ov-shop-card"
        style={{
          ['--cc-type' as string]: typeColor,
          background: miniCardBackground(typeColor),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
          <div className="cc-ov-shop-name" style={{ fontFamily: CARD_TITLE_FONT }}>
            <span ref={titleSpanRef} style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }}>
              <CardName name={card.name} upgraded={card.is_upgraded} />
            </span>
          </div>
          <span className={`cc-ov-cost${costClass}`}>
            {displayCost != null ? <>{displayCost}<Coin /></> : '—'}
          </span>
        </div>
        <div className="cc-ov-shop-sub" title={isDiscounted ? `Reduced from ${card.buy_cost} (dynamic discount)` : undefined}>
          <span ref={subtitleSpanRef} style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }}>
          {renderSubtitle(buildCardSubtitle(card), { fontSize: 15, passiveVp: card.passive_vp })}
          </span>
        </div>
      </div>
      {/* Selling Out ribbon */}
      {sellingOut && (
        <div className="cc-ov-ribbon">Selling Out</div>
      )}
      {/* Buy button below card */}
      <IrreversibleButton
        onClick={(e) => { e.stopPropagation(); onBuy(); }}
        disabled={disabled || !canAfford || isTrulySoldOut}
        tooltip={buyTooltip}
        tooltipDelay={undefined}
        className={`cc-ov-buy${sellingOut ? ' is-selling-out' : ''}`}
        style={purchaseHighlight || hasCurrentTurnPurchase ? { animation: 'shopPurchasePulse 2s ease-in-out infinite' } : undefined}
      >
        {isTrulySoldOut ? 'Sold Out' : sellingOut ? 'Selling Out!' : (
          <>
            Buy
            {remaining !== null && <span className="cc-ov-buy-stock">{remaining} left</span>}
          </>
        )}
      </IrreversibleButton>
    </div>
  );
}

/** Animated card that flies from a neutral market card to a player's HUD. */
export function PurchaseFlyAnimation({ event, onDone }: { event: SharedPurchaseEvent; onDone: () => void }) {
  const [style, setStyle] = useState<React.CSSProperties>({ display: 'none' });

  const typeColor = hex6(getCardDisplayColor(event.card));
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
      <div
        className="cc-ov-shop-card"
        style={{
          ['--cc-type' as string]: typeColor,
          background: miniCardBackground(typeColor),
          boxShadow: `0 0 14px ${event.player_color}90, 0 4px 12px rgba(0,0,0,0.55)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
          <div className="cc-ov-shop-name" style={{ fontFamily: CARD_TITLE_FONT }}>
            <CardName name={event.card.name} upgraded={event.card.is_upgraded} />
          </div>
          <span className="cc-ov-cost">
            {displayCost != null ? <>{displayCost}<Coin /></> : '—'}
          </span>
        </div>
        <div className="cc-ov-shop-sub">
          {renderSubtitle(subtitle, { fontSize: 15, passiveVp: event.card.passive_vp })}
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
  effectiveRerollCost = 1,
  effectiveUpgradeCreditCost = 5,
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

  // Purely visual: remember the card just bought so its tile (or the
  // "Purchased!" placeholder that replaces it) can play a quick pop.
  const [recentBuy, setRecentBuy] = useState<string | null>(null);
  const recentBuyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagRecentBuy = useCallback((cardId: string) => {
    setRecentBuy(cardId);
    if (recentBuyTimerRef.current) clearTimeout(recentBuyTimerRef.current);
    recentBuyTimerRef.current = setTimeout(() => setRecentBuy(null), 1200);
  }, []);

  const buyArchetypeWithSound = useCallback((cardId: string) => {
    sound.cardPurchase();
    flagRecentBuy(cardId);
    onBuyArchetype(cardId);
  }, [onBuyArchetype, sound, flagRecentBuy]);

  const buyNeutralWithSound = useCallback((cardId: string) => {
    sound.cardPurchase();
    flagRecentBuy(cardId);
    onBuyShared(cardId);
  }, [onBuyShared, sound, flagRecentBuy]);

  // Floating "+1 Credit" animation state
  const [showCreditFloat, setShowCreditFloat] = useState(false);
  const creditFloatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (recentBuyTimerRef.current) clearTimeout(recentBuyTimerRef.current);
    if (creditFloatTimerRef.current) clearTimeout(creditFloatTimerRef.current);
  }, []);

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
  const animate = animMode !== 'off';
  const panelTransition = animate
    ? `opacity ${0.3 * speed}s var(--cc-ease-out), transform ${0.3 * speed}s var(--cc-ease-out)`
    : 'none';

  const sortedArchetypeSlots = [...archetypeSlots].sort((a, b) => (a.card.buy_cost ?? 0) - (b.card.buy_cost ?? 0));
  const sortedShared = [...sharedMarket].sort((a, b) => (a.card.buy_cost ?? 0) - (b.card.buy_cost ?? 0));

  return (
    <>
      {/* Shop panel — centered over the entire window with backdrop */}
      <div
        className="cc-ov-backdrop"
        onClick={onClose}
        onMouseMove={handleMouseMove}
        style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5000,
        opacity: visible ? 1 : 0,
        transition: animate ? `opacity ${0.25 * speed}s ease` : 'none',
      }}>
        <div
          className="cc-ov-modal cc-ov-shop"
          onClick={(e) => e.stopPropagation()}
          style={{
          ['--cc-ov-speed' as string]: speed,
          opacity: visible ? 1 : 0,
          transform: visible ? 'none' : 'translateY(10px) scale(0.96)',
          transition: panelTransition,
        }}>
        {/* Header */}
        <div className="cc-ov-header">
          <ChestIcon />
          <span className="cc-ov-title">Shop</span>
          {disabled && <span className="cc-ov-tag">View only</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
            <span className="cc-ov-purse" title={`You have ${playerResources} resource${playerResources !== 1 ? 's' : ''}`}>
              <Coin />
              <span key={playerResources} className={`cc-ov-purse-value${animate ? ' cc-ov-anim' : ''}`}>{playerResources}</span>
              <span className="cc-ov-purse-label">resource{playerResources !== 1 ? 's' : ''}</span>
            </span>
            {onClose && (
              <button className="cc-ov-close" onClick={onClose} title="Close" aria-label="Close">
                <Icon name="close" size={14} decorative />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
          <div className="cc-ov-shop-body">
            {/* Archetype Market */}
            <section>
              <div className="cc-ov-section-head">
                <div className="cc-ov-section-title">
                  <Tooltip content="These cards are unique to your archetype, randomly drawn from your deck pack pool and only available this round.">
                    <span style={{ cursor: 'help' }}>{playerArchetype.charAt(0).toUpperCase() + playerArchetype.slice(1)} Market</span>
                  </Tooltip>
                </div>
                <div className="cc-ov-section-sub">New card options every round</div>
              </div>
              {/* Archetype cards — full-width wrap row, centered */}
              <div className="cc-ov-shop-grid">
                  {archetypeSlots.length === 0 && (
                    <span style={{ color: 'var(--cc-text-faint)', fontSize: 12 }}>No cards available</span>
                  )}
                  {sortedArchetypeSlots.map(({ card, purchased }, idx) => {
                    if (purchased) {
                      // Render the real card invisibly to preserve exact dimensions,
                      // with a "Purchased!" overlay on top
                      const cardW = COMPACT_CARD_WIDTH;
                      return (
                        <div key={card.id} data-card-id={card.id} style={{
                          width: cardW,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 5,
                        }}>
                          <div style={{ position: 'relative', width: cardW }}>
                            {/* Invisible card — preserves height */}
                            <div style={{ visibility: 'hidden' }}>
                              <div className="cc-ov-shop-card">
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
                                      <div style={{ fontWeight: 'bold', fontSize: 16, fontFamily: CARD_TITLE_FONT }}><CardName name={card.name} upgraded={card.is_upgraded} /></div>
                                    </div>
                                    <div style={{ fontSize: 15 }}>&nbsp;</div>
                                  </div>
                            </div>
                            {/* Overlay — exact same size */}
                            <div className={`cc-ov-purchased${animate && recentBuy === card.id ? ' cc-ov-anim' : ''}`}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                              <span>Purchased!</span>
                            </div>
                          </div>
                          <button disabled className="cc-ov-buy" style={{ opacity: 0.55 }}>
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
                        viewOnly={disabled}
                        animate={animate}
                        animIndex={idx}
                        justBought={animate && recentBuy === card.id}
                      />
                    );
                  })}
                </div>

              {/* Re-roll — below archetype cards, matching the upgrade-credit row style */}
              <div className="cc-ov-action-row" style={{ marginTop: 14 }}>
                <div style={{ flexShrink: 0 }}>
                  {freeRerolls > 0 ? (
                    <Tooltip content={`You have ${freeRerolls} free re-roll${freeRerolls !== 1 ? 's' : ''} remaining (from Surveyor).`}>
                      <button
                        className="cc-ov-action is-deal"
                        onClick={onReroll}
                        disabled={disabled || (freeRerolls <= 0 && playerResources < 1)}
                        style={disabled ? undefined : { animation: 'shopPurchasePulse 2s ease-in-out infinite' }}
                      >
                        <RerollIcon />
                        Re-roll
                        <span className="cc-ov-action-cost">{freeRerolls} free</span>
                      </button>
                    </Tooltip>
                  ) : (() => {
                    const rerollDiscounted = effectiveRerollCost < 1;
                    const canAffordReroll = playerResources >= effectiveRerollCost;
                    const rerollButton = (
                      <button
                        className={`cc-ov-action${rerollDiscounted ? ' is-deal' : ''}`}
                        onClick={onReroll}
                        disabled={disabled || !canAffordReroll}
                        style={rerollDiscounted && !disabled ? { animation: 'shopPurchasePulse 2s ease-in-out infinite' } : undefined}
                      >
                        <RerollIcon />
                        Re-roll
                        <span className="cc-ov-action-cost">
                          {rerollDiscounted && <span className="cc-ov-strike">1</span>}
                          {effectiveRerollCost}<Coin />
                        </span>
                      </button>
                    );
                    return rerollDiscounted ? (
                      <Tooltip content={`Discounted from 1 resource to ${effectiveRerollCost} by an active cost reduction.`}>
                        {rerollButton}
                      </Tooltip>
                    ) : rerollButton;
                  })()}
                </div>
                <span className="cc-ov-hint">
                  Cards given from a re-roll are guaranteed to be different from existing cards.
                </span>
              </div>
            </section>

            {/* Shared Market */}
            <section>
              <div className="cc-ov-section-head">
                <div className="cc-ov-section-title">
                  <Tooltip content="Purchases from the shared market are visible to all players. Each card has limited copies — once they're gone, they're gone for the game.">
                    <span style={{ cursor: 'help' }}>Shared Market</span>
                  </Tooltip>
                </div>
                <div className="cc-ov-section-sub">Limit 1 copy of each card per round</div>
              </div>
              <div className="cc-ov-shop-grid">
                {sortedShared.map((stack, idx) => {
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
                      viewOnly={disabled}
                      animate={animate}
                      animIndex={sortedArchetypeSlots.length + idx}
                      justBought={animate && recentBuy === stack.card.id}
                    />
                  );
                })}
              </div>
            </section>

            {/* Upgrade Credit — below shared market */}
            <div className="cc-ov-action-row">
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
                    <CursorBadges cursors={upgCursors} cursorClicks={cursorClicks} />
                  ) : null;
                })()}
                {showCreditFloat && (
                  <span className="cc-ov-credit-float">+1 Credit</span>
                )}
              {(() => {
                const upgDiscounted = effectiveUpgradeCreditCost < 5;
                const canAffordUpg = playerResources >= effectiveUpgradeCreditCost;
                const isDeal = upgDiscounted && canAffordUpg && !disabled && !buyLocked;
                const upgradeButton = (
                  <button
                    className={`cc-ov-action${isDeal ? ' is-deal' : ''}`}
                    onClick={buyUpgradeWithSound}
                    disabled={disabled || !!buyLocked || !canAffordUpg}
                    style={isDeal ? { animation: 'shopPurchasePulse 2s ease-in-out infinite' } : undefined}
                  >
                    <UpgradeIcon />
                    Buy Upgrade Credit
                    <span className="cc-ov-action-cost">
                      {upgDiscounted && <span className="cc-ov-strike">5</span>}
                      {effectiveUpgradeCreditCost}<Coin />
                    </span>
                  </button>
                );
                if (buyLocked) {
                  return (
                    <Tooltip content="Cannot buy — Grand Strategy was played this round.">
                      {upgradeButton}
                    </Tooltip>
                  );
                }
                if (upgDiscounted) {
                  return (
                    <Tooltip content={`Discounted from 5 resources to ${effectiveUpgradeCreditCost} by an active cost reduction.`}>
                      {upgradeButton}
                    </Tooltip>
                  );
                }
                return upgradeButton;
              })()}
              </div>
              <span className="cc-ov-hint">
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
              textShadow: '0 1px 2px rgba(0,0,0,0.8)',
            }}>
              Upgraded
            </div>
          )}
          {(() => {
            const buyer = neutralPurchaseMap.get(displayedHover.card.id);
            const turnPurchases = currentTurnSharedPurchases.get(displayedHover.card.id);
            if (!buyer && !turnPurchases) return null;
            return (
              <div className="cc-ov-preview-note">
                {turnPurchases?.map((p, i) => (
                  <div key={i}>{p.playerName} bought {p.count} this round</div>
                ))}
                {buyer && <div style={{ color: 'var(--cc-text-dim)' }}>{buyer} purchased this last round</div>}
              </div>
            );
          })()}
        </div>
      )}
    </>
  );
}
