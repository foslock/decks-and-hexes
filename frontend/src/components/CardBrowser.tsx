import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { useShiftKey } from '../hooks/useShiftKey';

const TYPE_COLORS: Record<string, string> = {
  claim: '#4a9eff',
  defense: '#4aff6a',
  engine: '#ffaa4a',
  passive: '#aa88cc',
};

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

function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => {
    // Cost (nulls/starters first)
    const costA = a.buy_cost ?? -1;
    const costB = b.buy_cost ?? -1;
    if (costA !== costB) return costA - costB;
    // Card type
    const typeA = TYPE_ORDER[a.card_type] ?? 9;
    const typeB = TYPE_ORDER[b.card_type] ?? 9;
    if (typeA !== typeB) return typeA - typeB;
    // Alphabetical
    return a.name.localeCompare(b.name);
  });
}

// Persists view mode across opens
let browserViewMemory: boolean = false;

function BrowserCardCompact({ card, shiftHeld }: { card: Card; shiftHeld: boolean }) {
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  const color = TYPE_COLORS[displayCard.card_type] || '#555';
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  return (
    <div
      onPointerEnter={(e) => setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
      onPointerLeave={() => setHoverRect(null)}
      style={{
        width: 134,
        padding: 6,
        background: '#2a2a3e',
        border: `1px solid ${color}`,
        borderRadius: 6,
        color: '#fff',
        flexShrink: 0,
      }}
    >
      <div style={{ marginBottom: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <div style={{ fontWeight: 'bold', fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
            <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--title-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
              if (el) {
                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                el.style.setProperty('--title-scale', String(scale));
              }
            }}>
              {displayCard.name}
              {displayCard.current_vp !== undefined && (
                <span style={{
                  fontSize: 10,
                  fontWeight: 'bold',
                  color: displayCard.current_vp > 0 ? '#ffd700' : displayCard.current_vp < 0 ? '#ff6666' : '#888',
                  marginLeft: 4,
                }}>
                  {displayCard.current_vp > 0 ? '+' : ''}{displayCard.current_vp}★
                </span>
              )}
            </span>
          </div>
          <span style={{ fontSize: 14, flexShrink: 0 }}>{CARD_EMOJI[displayCard.card_type]}</span>
        </div>
        <div style={{ fontSize: 11, color: '#aaa' }}>
          {(() => {
            const parts: React.ReactNode[] = [];
            if (displayCard.buy_cost !== null) {
              parts.push(`💰 ${displayCard.buy_cost}`);
            } else if (displayCard.starter) {
              parts.push('Starter');
            }
            if (displayCard.passive_vp !== 0) {
              parts.push(<span key="vp" style={{ color: displayCard.passive_vp > 0 ? '#ffd700' : '#ff6666' }}>{displayCard.passive_vp > 0 ? '+' : ''}{displayCard.passive_vp}★</span>);
            } else if (displayCard.vp_formula) {
              parts.push(<span key="vp" style={{ color: '#ffd700' }}>+★</span>);
            }
            if (displayCard.power > 0 || displayCard.card_type === 'claim') {
              parts.push(`Pow ${displayCard.power}`);
            }
            if (displayCard.resource_gain > 0) {
              parts.push(`+${displayCard.resource_gain}`);
            }
            return parts.map((part, i) => <span key={i}>{i > 0 ? ' · ' : ''}{part}</span>);
          })()}
        </div>
      </div>
      {shiftHeld && hasUpgradePreview(card) && (
        <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 'bold', color: '#4aff6a', marginTop: 2 }}>
          Upgraded
        </div>
      )}
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

function BrowserCardFull({ card, shiftHeld }: { card: Card; shiftHeld: boolean }) {
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  return (
    <div style={{ flexShrink: 0 }}>
      <CardFull card={displayCard} style={{ flexShrink: 0 }} />
      {shiftHeld && hasUpgradePreview(card) && (
        <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 'bold', color: '#4aff6a', marginTop: 4 }}>
          Upgraded
        </div>
      )}
    </div>
  );
}

interface CardBrowserProps {
  onClose: () => void;
}

export default function CardBrowser({ onClose }: CardBrowserProps) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullView, setFullViewRaw] = useState(() => browserViewMemory);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const shiftHeld = useShiftKey();

  const setFullView = useCallback((v: boolean) => {
    setFullViewRaw(v);
    browserViewMemory = v;
  }, []);

  useEffect(() => {
    fetch('/api/cards')
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
    setCollapsed(prev => ({ ...prev, [archetype]: !prev[archetype] }));
  };

  // Filter cards by search query (partial match on name or description)
  const filteredCards = useMemo(() => {
    if (!cards) return [];
    if (!searchQuery.trim()) return cards;
    const q = searchQuery.toLowerCase();
    return cards.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.description && c.description.toLowerCase().includes(q))
    );
  }, [cards, searchQuery]);

  // Group cards by archetype in display order
  const groups = ARCHETYPE_ORDER.map(arch => ({
    archetype: arch,
    label: ARCHETYPE_LABELS[arch] || arch,
    cards: sortCards(filteredCards.filter(c => c.archetype === arch)),
  })).filter(g => g.cards.length > 0);

  const totalCount = cards?.length ?? 0;

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
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 16px',
          background: '#1a1a40',
          borderBottom: '1px solid #333',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 'bold', fontSize: 15, color: '#fff' }}>
            📖 Card Browser
          </span>
          {cards && (
            <span style={{ fontSize: 12, color: '#888' }}>
              ({searchQuery ? `${filteredCards.length}/` : ''}{totalCount} cards)
            </span>
          )}
          <span style={{ fontSize: 11, color: '#555', marginLeft: 4 }}>
            Hold Shift for upgrades
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 120,
                padding: '3px 8px',
                background: '#2a2a3e',
                border: '1px solid #444',
                borderRadius: 6,
                color: '#fff',
                fontSize: 11,
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', border: '1px solid #444', borderRadius: 6, overflow: 'hidden' }}>
              <button
                onClick={() => setFullView(false)}
                style={{ padding: '3px 10px', background: !fullView ? '#4a4aff' : '#2a2a3e', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}
              >
                Compact
              </button>
              <button
                onClick={() => setFullView(true)}
                style={{ padding: '3px 10px', background: fullView ? '#4a4aff' : '#2a2a3e', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}
              >
                Full
              </button>
            </div>
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {group.cards.map((card) => (
                    fullView
                      ? <BrowserCardFull key={card.id} card={card} shiftHeld={shiftHeld} />
                      : <BrowserCardCompact key={card.id} card={card} shiftHeld={shiftHeld} />
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
