import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import { BASE } from '../api/client';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { getUpgradedPreview } from '../hooks/upgradePreview';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitle } from './SubtitlePartRenderer';
import { CostLabel } from '../icons/Num';
import { useShiftKey } from '../hooks/useShiftKey';
import { CARD_TYPE_COLORS, CARD_TITLE_FONT, getCardDisplayColor } from '../constants/cardColors';
import { useCardZoom } from './CardZoomContext';
import Icon from '../icons/Icon';

const ARCHETYPE_ORDER = ['shared', 'vanguard', 'swarm', 'fortress'];

const ARCHETYPE_LABELS: Record<string, string> = {
  shared: 'Shared',
  vanguard: 'Vanguard',
  swarm: 'Swarm',
  fortress: 'Fortress',
};

/** Archetype emblem art shown beside each section heading. */
const ARCHETYPE_EMBLEMS: Record<string, string> = {
  vanguard: '/assets/howtoplay/vanguard.webp',
  swarm: '/assets/howtoplay/swarm.webp',
  fortress: '/assets/howtoplay/fortress.webp',
};

const TYPE_ORDER: Record<string, number> = {
  claim: 0,
  defense: 1,
  engine: 2,
};

type SortMode = 'cost' | 'type';

function sortCards(cards: Card[], mode: SortMode): Card[] {
  return [...cards].sort((a, b) => {
    if (mode === 'cost') {
      // Cost first (nulls/starters first), then type, then name
      const costA = a.buy_cost ?? -1;
      const costB = b.buy_cost ?? -1;
      if (costA !== costB) return costA - costB;
      const typeA = TYPE_ORDER[a.card_type] ?? 9;
      const typeB = TYPE_ORDER[b.card_type] ?? 9;
      if (typeA !== typeB) return typeA - typeB;
    } else {
      // Type first, then cost, then name
      const typeA = TYPE_ORDER[a.card_type] ?? 9;
      const typeB = TYPE_ORDER[b.card_type] ?? 9;
      if (typeA !== typeB) return typeA - typeB;
      const costA = a.buy_cost ?? -1;
      const costB = b.buy_cost ?? -1;
      if (costA !== costB) return costA - costB;
    }
    return a.name.localeCompare(b.name);
  });
}

// Persists view mode, sort mode, and collapse state across opens
let browserViewMemory: boolean = false;
let browserSortMemory: SortMode = 'cost';
let browserCollapseMemory: Record<string, boolean> | null = null;

export function clearBrowserCollapseMemory() {
  browserCollapseMemory = null;
}

function BrowserCardCompact({ card, shiftHeld, onShiftClick, cardList }: { card: Card; shiftHeld: boolean; onShiftClick?: (cardId: string) => void; cardList?: Card[] }) {
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  const color = getCardDisplayColor(displayCard);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [flashAdded, setFlashAdded] = useState(false);
  const { showZoom } = useCardZoom();
  return (
    <div
      onPointerEnter={(e) => setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
      onPointerLeave={() => setHoverRect(null)}
      onClick={(e) => {
        if (e.shiftKey && onShiftClick) {
          e.preventDefault();
          onShiftClick(card.id);
          setFlashAdded(true);
          setTimeout(() => setFlashAdded(false), 400);
        } else {
          showZoom(displayCard, cardList);
        }
      }}
      className={`cc-scr-cb-card${flashAdded ? ' is-flash' : ''}`}
      style={{ ['--cb-color' as string]: color }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 2 }}>
          <div style={{ fontWeight: 'bold', fontSize: 16, fontFamily: CARD_TITLE_FONT, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
            <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
              if (el) {
                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                el.style.setProperty('--title-scale', String(scale));
              }
            }}>
              {displayCard.name}
            </span>
          </div>
          <span style={{ fontSize: 15, flexShrink: 0, color: 'var(--cc-gold)', fontWeight: 700, whiteSpace: 'nowrap' }}><CostLabel cost={displayCard.buy_cost} size={15} /></span>
        </div>
        <div style={{ fontSize: 15, color: 'var(--cc-text-dim)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
            if (el) {
              const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
              el.style.setProperty('--sub-scale', String(scale));
            }
          }}>
          {renderSubtitle(buildCardSubtitle(displayCard), { fontSize: 15, passiveVp: displayCard.passive_vp })}
          </span>
        </div>
      </div>
      {hoverRect && createPortal(
        <div style={{
          position: 'fixed',
          left: Math.max(8, Math.min(hoverRect.left + hoverRect.width / 2 - CARD_FULL_WIDTH / 2, window.innerWidth - CARD_FULL_WIDTH - 8)),
          ...(hoverRect.top > CARD_FULL_MIN_HEIGHT + 16
            ? { bottom: window.innerHeight - hoverRect.top + 8 }
            : { top: hoverRect.bottom + 8 }),
          pointerEvents: 'none',
          zIndex: 20000,
        }}>
          <CardFull card={displayCard} showKeywordHints />
        </div>,
        document.body
      )}
    </div>
  );
}

function BrowserCardFull({ card, shiftHeld, onShiftClick, cardList }: { card: Card; shiftHeld: boolean; onShiftClick?: (cardId: string) => void; cardList?: Card[] }) {
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  const [flashAdded, setFlashAdded] = useState(false);
  const { showZoom } = useCardZoom();
  return (
    <div
      onClick={(e) => {
        if (e.shiftKey && onShiftClick) {
          e.preventDefault();
          onShiftClick(card.id);
          setFlashAdded(true);
          setTimeout(() => setFlashAdded(false), 400);
        } else {
          showZoom(displayCard, cardList);
        }
      }}
      style={{
        flexShrink: 0,
        cursor: 'pointer',
        borderRadius: 8,
        outline: flashAdded ? '2px solid #4a4' : 'none',
        transition: 'outline 0.2s',
      }}
    >
      <CardFull card={displayCard} style={{ flexShrink: 0 }} />
    </div>
  );
}

interface CardBrowserProps {
  onClose: () => void;
  /** Neutral card IDs to include; null/undefined = all */
  packSharedIds?: string[] | null;
  /** Per-archetype card IDs to include; null/undefined = all */
  packArchetypeIds?: Record<string, string[]> | null;
  /** Pack name shown in the header */
  packName?: string;
  /** Callback when shift+clicking a card (test mode: add to hand) */
  onShiftClickCard?: (cardId: string) => void;
  /** Player's selected archetype — used for default collapse state */
  playerArchetype?: string;
  /** When true, every archetype section starts collapsed and only the
   *  Neutral section is open. Overrides the default `playerArchetype`-based
   *  expansion. Used by the lobby card browser where the player wants to
   *  focus on the shared market first. */
  collapseArchetypes?: boolean;
  /** When true, hide non-purchasable cards (Rubble, Spoils, Debt) — they
   *  are generated by gameplay events, never bought, so showing them in a
   *  pre-game pack browser is misleading. The global browser (home screen,
   *  in-game) keeps them visible so players can read what they do. */
  hideNonPurchasable?: boolean;
}

export default function CardBrowser({ onClose, packSharedIds, packArchetypeIds, packName, onShiftClickCard, playerArchetype, collapseArchetypes, hideNonPurchasable }: CardBrowserProps) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullView, setFullViewRaw] = useState(() => browserViewMemory);
  const [sortMode, setSortModeRaw] = useState<SortMode>(() => browserSortMemory);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (browserCollapseMemory) return browserCollapseMemory;
    if (collapseArchetypes) {
      // Lobby browser: only Neutral expanded, every archetype collapsed.
      const init: Record<string, boolean> = {};
      for (const arch of ARCHETYPE_ORDER) {
        if (arch !== 'shared') init[arch] = true;
      }
      return init;
    }
    if (!playerArchetype) return {};  // home screen: all expanded
    // In-game: only neutral + player's archetype expanded
    const init: Record<string, boolean> = {};
    for (const arch of ARCHETYPE_ORDER) {
      if (arch !== 'shared' && arch !== playerArchetype) init[arch] = true;
    }
    return init;
  });
  const [searchQuery, setSearchQuery] = useState('');
  const shiftHeld = useShiftKey();

  const setFullView = useCallback((v: boolean) => {
    setFullViewRaw(v);
    browserViewMemory = v;
  }, []);

  const setSortMode = useCallback((v: SortMode) => {
    setSortModeRaw(v);
    browserSortMemory = v;
  }, []);

  useEffect(() => {
    fetch(`${BASE}/cards`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load cards');
        return res.json();
      })
      .then((data: Record<string, Card>) => {
        setCards(Object.values(data).filter(c => c.card_type !== 'token'));
      })
      .catch(err => setError(err.message));
  }, []);

  const toggleCollapse = (archetype: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [archetype]: !prev[archetype] };
      browserCollapseMemory = next;
      return next;
    });
  };

  // Apply pack filtering. When `hideNonPurchasable` is set (pre-game pack
  // browser), drop any card with no buy_cost — that covers both universal
  // starters (Explore, Gather — already in every player's deck) and
  // gameplay-generated cards (Rubble, Spoils — never bought). The global
  // browser (home screen, in-game) leaves them visible so players can look
  // up what each card does.
  const packFilteredCards = useMemo(() => {
    if (!cards) return [];
    return cards.filter(c => {
      if (hideNonPurchasable && c.buy_cost == null) return false;
      // Filter neutral cards by pack
      if (c.archetype === 'shared' && packSharedIds != null) {
        return packSharedIds.includes(c.id);
      }
      // Filter archetype cards by pack
      if (packArchetypeIds != null && c.archetype && c.archetype !== 'shared') {
        const allowed = packArchetypeIds[c.archetype];
        if (allowed != null) {
          return allowed.includes(c.id);
        }
      }
      return true;
    });
  }, [cards, packSharedIds, packArchetypeIds, hideNonPurchasable]);

  // Filter cards by search query (partial match on name or description)
  const filteredCards = useMemo(() => {
    if (!packFilteredCards.length) return [];
    if (!searchQuery.trim()) return packFilteredCards;
    const q = searchQuery.toLowerCase();
    return packFilteredCards.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.description && c.description.toLowerCase().includes(q))
    );
  }, [packFilteredCards, searchQuery]);

  // Group cards by archetype in display order
  const groups = ARCHETYPE_ORDER.map(arch => ({
    archetype: arch,
    label: ARCHETYPE_LABELS[arch] || arch,
    cards: sortCards(filteredCards.filter(c => c.archetype === arch), sortMode),
  })).filter(g => g.cards.length > 0);

  // Flat ordered list of all visible cards for zoom navigation
  const allVisibleCards = useMemo(() => groups.flatMap(g => g.cards), [groups]);

  const totalCount = packFilteredCards.length;

  return (
    <div
      onClick={onClose}
      className="cc-scr-modal-backdrop"
      style={{ zIndex: 5000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="cc-panel cc-scr-modal cc-scr-cb"
      >
        {/* Header */}
        <div className="cc-scr-modal-head cc-scr-cb-head">
          <span className="cc-scr-modal-title">
            Card Browser{packName ? ` — ${packName}` : ''}
          </span>
          {cards && (
            <span className="cc-scr-cb-count">
              ({searchQuery ? `${filteredCards.length}/` : ''}{totalCount} cards)
            </span>
          )}
          <span className="cc-scr-cb-hint cc-scr-cb-hide-narrow">
            Hold shift to view upgrades
          </span>
          <div className="cc-scr-cb-tools">
            <div className="cc-scr-cb-search">
              <input
                type="text"
                className="cc-scr-input"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            <div className="cc-scr-seg cc-scr-seg-sm cc-scr-cb-hide-narrow">
              <button
                onClick={() => setSortMode('cost')}
                className={`cc-scr-seg-btn${sortMode === 'cost' ? ' is-active' : ''}`}
              >
                Cost
              </button>
              <button
                onClick={() => setSortMode('type')}
                className={`cc-scr-seg-btn${sortMode === 'type' ? ' is-active' : ''}`}
              >
                Type
              </button>
            </div>
            {/* Click any card to view full details */}
            <button
              onClick={onClose}
              className="cc-scr-close"
              aria-label="Close"
            >
              <Icon name="close" size={14} decorative />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="cc-scr-modal-body cc-scr-cb-body">
          {error && (
            <div className="cc-scr-error" style={{ marginBottom: 12 }}>
              Error: {error}. Make sure the backend is running.
            </div>
          )}
          {!cards && !error && (
            <div className="cc-scr-cb-empty">Loading cards...</div>
          )}
          {groups.map((group) => (
            <div key={group.archetype} className="cc-scr-cb-group">
              <button
                onClick={() => toggleCollapse(group.archetype)}
                className="cc-scr-cb-group-btn"
              >
                <span
                  className="cc-scr-chevron"
                  style={{ transform: collapsed[group.archetype] ? 'rotate(0deg)' : 'rotate(90deg)' }}
                >
                  <Icon name="chevron" size={10} decorative />
                </span>
                {ARCHETYPE_EMBLEMS[group.archetype] && (
                  <img src={ARCHETYPE_EMBLEMS[group.archetype]} alt="" draggable={false} />
                )}
                <span className="cc-scr-cb-group-label">
                  {group.label}
                </span>
                <span className="cc-scr-cb-group-count">
                  ({group.cards.length})
                </span>
              </button>
              {!collapsed[group.archetype] && (
                <div className="cc-scr-cb-grid">
                  {group.cards.map((card) => (
                    <BrowserCardCompact key={card.id} card={card} shiftHeld={shiftHeld} onShiftClick={onShiftClickCard} cardList={allVisibleCards} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
