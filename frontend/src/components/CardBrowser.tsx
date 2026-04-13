import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import { BASE } from '../api/client';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { getUpgradedPreview } from '../hooks/upgradePreview';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitlePart } from './SubtitlePartRenderer';
import { useShiftKey } from '../hooks/useShiftKey';
import { CARD_TYPE_COLORS, CARD_TITLE_FONT, getCardDisplayColor } from '../constants/cardColors';
import { useCardZoom } from './CardZoomContext';

const CARD_EMOJI: Record<string, string> = {
  claim: '⚔️',
  defense: '🛡️',
  engine: '⚙️',
  passive: '📜',
};

const ARCHETYPE_ORDER = ['neutral', 'vanguard', 'swarm', 'fortress'];

const ARCHETYPE_LABELS: Record<string, string> = {
  neutral: '⬜ Neutral',
  vanguard: '🗡️ Vanguard',
  swarm: '🐝 Swarm',
  fortress: '🏰 Fortress',
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

function BrowserCardCompact({ card, shiftHeld, onShiftClick }: { card: Card; shiftHeld: boolean; onShiftClick?: (cardId: string) => void }) {
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
          showZoom(displayCard);
        }
      }}
      style={{
        width: 154,
        padding: 6,
        background: flashAdded ? '#2a4a2e' : '#2a2a3e',
        border: `1px solid ${flashAdded ? '#4a4' : color}`,
        borderRadius: 6,
        color: '#fff',
        flexShrink: 0,
        cursor: 'pointer',
        transition: 'background 0.2s, border-color 0.2s',
      }}
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
          <span style={{ fontSize: 15, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>{displayCard.buy_cost != null ? `${displayCard.buy_cost}💰` : '—'}</span>
        </div>
        <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
            if (el) {
              const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
              el.style.setProperty('--sub-scale', String(scale));
            }
          }}>
          {buildCardSubtitle(displayCard).map((part, i) => renderSubtitlePart(part, i, { passiveVp: displayCard.passive_vp }))}
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

function BrowserCardFull({ card, shiftHeld, onShiftClick }: { card: Card; shiftHeld: boolean; onShiftClick?: (cardId: string) => void }) {
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
          showZoom(displayCard);
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
  packNeutralIds?: string[] | null;
  /** Per-archetype card IDs to include; null/undefined = all */
  packArchetypeIds?: Record<string, string[]> | null;
  /** Pack name shown in the header */
  packName?: string;
  /** Callback when shift+clicking a card (test mode: add to hand) */
  onShiftClickCard?: (cardId: string) => void;
  /** Player's selected archetype — used for default collapse state */
  playerArchetype?: string;
}

export default function CardBrowser({ onClose, packNeutralIds, packArchetypeIds, packName, onShiftClickCard, playerArchetype }: CardBrowserProps) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullView, setFullViewRaw] = useState(() => browserViewMemory);
  const [sortMode, setSortModeRaw] = useState<SortMode>(() => browserSortMemory);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (browserCollapseMemory) return browserCollapseMemory;
    if (!playerArchetype) return {};  // home screen: all expanded
    // Lobby/game: only neutral + player's archetype expanded
    const init: Record<string, boolean> = {};
    for (const arch of ARCHETYPE_ORDER) {
      if (arch !== 'neutral' && arch !== playerArchetype) init[arch] = true;
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

  // Apply pack filtering: keep starters always, filter neutrals and archetype cards by pack
  const packFilteredCards = useMemo(() => {
    if (!cards) return [];
    return cards.filter(c => {
      // Starters are always shown
      if (c.starter) return true;
      // Filter neutral non-starters by pack
      if (c.archetype === 'neutral' && packNeutralIds != null) {
        return packNeutralIds.includes(c.id);
      }
      // Filter archetype non-starters by pack
      if (packArchetypeIds != null && c.archetype && c.archetype !== 'neutral') {
        const allowed = packArchetypeIds[c.archetype];
        if (allowed != null) {
          return allowed.includes(c.id);
        }
      }
      return true;
    });
  }, [cards, packNeutralIds, packArchetypeIds]);

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

  const totalCount = packFilteredCards.length;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 5000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(94vw, 900px)',
          maxHeight: '85vh',
          background: '#12122a',
          border: '2px solid #4a4a6a',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <style>{`
          @media (max-width: 480px) {
            .cb-hide-narrow { display: none !important; }
          }
        `}</style>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 16px',
          background: '#1a1a40',
          borderBottom: '1px solid #333',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 'bold', fontSize: 15, color: '#fff' }}>
            📖 Card Browser{packName ? ` — ${packName}` : ''}
          </span>
          {cards && (
            <span style={{ fontSize: 12, color: '#888' }}>
              ({searchQuery ? `${filteredCards.length}/` : ''}{totalCount} cards)
            </span>
          )}
          <span className="cb-hide-narrow" style={{ fontSize: 11, color: '#555', marginLeft: 4 }}>
            Hold shift to view upgrades
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 120, minWidth: 0, flexShrink: 1,
                padding: '3px 8px',
                background: '#2a2a3e',
                border: '1px solid #444',
                borderRadius: 6,
                color: '#fff',
                fontSize: 11,
                outline: 'none',
              }}
            />
            <div className="cb-hide-narrow" style={{ display: 'flex', border: '1px solid #444', borderRadius: 6, overflow: 'hidden' }}>
              <button
                onClick={() => setSortMode('cost')}
                style={{ padding: '3px 10px', background: sortMode === 'cost' ? '#4a4aff' : '#2a2a3e', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}
              >
                Cost
              </button>
              <button
                onClick={() => setSortMode('type')}
                style={{ padding: '3px 10px', background: sortMode === 'type' ? '#4a4aff' : '#2a2a3e', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}
              >
                Type
              </button>
            </div>
            {/* Click any card to view full details */}
            <button
              onClick={onClose}
              style={{ padding: '4px 10px', background: '#2a2a3e', border: '1px solid #555', borderRadius: 5, color: '#aaa', fontSize: 13, cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ overflowY: 'auto', padding: 16 }}>
          {error && (
            <div style={{ color: '#ff6666', fontSize: 13, marginBottom: 12 }}>
              Error: {error}. Make sure the backend is running.
            </div>
          )}
          {!cards && !error && (
            <div style={{ color: '#888', fontSize: 13 }}>Loading cards...</div>
          )}
          {groups.map((group) => (
            <div key={group.archetype} style={{ marginBottom: 16 }}>
              <button
                onClick={() => toggleCollapse(group.archetype)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 0',
                  marginBottom: 8,
                  width: '100%',
                  textAlign: 'left',
                }}
              >
                <span style={{
                  fontSize: 10,
                  color: '#666',
                  transition: 'transform 0.15s ease',
                  transform: collapsed[group.archetype] ? 'rotate(-90deg)' : 'rotate(0deg)',
                  display: 'inline-block',
                }}>
                  ▼
                </span>
                <span style={{ fontSize: 14, fontWeight: 'bold', color: '#ccc' }}>
                  {group.label}
                </span>
                <span style={{ fontSize: 12, color: '#666' }}>
                  ({group.cards.length})
                </span>
              </button>
              {!collapsed[group.archetype] && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                  {group.cards.map((card) => (
                    <BrowserCardCompact key={card.id} card={card} shiftHeld={shiftHeld} onShiftClick={onShiftClickCard} />
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
