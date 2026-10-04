import { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import { useAnimationMode } from './SettingsContext';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitle } from './SubtitlePartRenderer';
import Icon from '../icons/Icon';
import { CostLabel } from '../icons/Num';
import { useCardZoom } from './CardZoomContext';
import { CARD_TITLE_FONT, getCardDisplayColor } from '../constants/cardColors';
import CardName from './CardName';

// ── Card Popup (deck viewer / discard viewer) ────────────────

function CardPopupItem({ card, full, shiftHeld, navList }: { card: Card; full: boolean; shiftHeld: boolean; navList?: Card[] }) {
  const animMode = useAnimationMode();
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  const color = getCardDisplayColor(displayCard);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const { showZoom } = useCardZoom();
  const upgradeLabel = shiftHeld && hasUpgradePreview(card) ? (
    <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 'bold', color: '#4aff6a', marginTop: 4 }}>
      Upgraded
    </div>
  ) : null;
  if (!full) {
    return (
      <div
        onPointerEnter={(e) => setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onPointerLeave={() => setHoverRect(null)}
        onClick={() => showZoom(displayCard, navList)}
        style={{
          width: 154,
          padding: 6,
          background: '#2a2a3e',
          border: `1px solid ${color}`,
          borderRadius: 6,
          color: '#fff',
          flexShrink: 0,
          cursor: 'pointer',
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
                <CardName name={displayCard.name} upgraded={displayCard.is_upgraded} />
              </span>
            </div>
            <span style={{ fontSize: 15, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}><CostLabel cost={displayCard.buy_cost} size={15} /></span>
          </div>
          <div style={{ fontSize: 15, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
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
        {upgradeLabel}
        {hoverRect && createPortal(
          <div style={{
            position: 'fixed',
            left: Math.max(8, Math.min(hoverRect.left + hoverRect.width / 2 - CARD_FULL_WIDTH / 2, window.innerWidth - CARD_FULL_WIDTH - 8)),
            ...(hoverRect.top > CARD_FULL_MIN_HEIGHT + 16
              ? { bottom: window.innerHeight - hoverRect.top + 8 }
              : { top: hoverRect.bottom + 8 }),
            pointerEvents: 'none',
            zIndex: 50000,
            animation: animMode !== 'off' ? `cardPreviewIn ${animMode === 'fast' ? 0.06 : 0.12}s ease both` : 'none',
          }}>
            <CardFull card={displayCard} showKeywordHints />
          </div>,
          document.body
        )}
      </div>
    );
  }
  return (
    <div style={{ flexShrink: 0, cursor: 'pointer' }} onClick={() => showZoom(displayCard, navList)}>
      <CardFull card={displayCard} style={{ flexShrink: 0 }} />
      {upgradeLabel}
    </div>
  );
}

// Persists view mode preference per popup title across opens (reset on page reload)
const viewModeMemory: Record<string, boolean> = {};

export function CardViewPopup({
  title,
  cards,
  onClose,
  defaultFull = false,
  note,
  preserveOrder = false,
  allowUpgradePreview = false,
}: {
  title: string;
  cards: { label: string; items: Card[] }[];
  onClose: () => void;
  defaultFull?: boolean;
  note?: string;
  /** When true, display cards in the order given (no sorting). */
  preserveOrder?: boolean;
  /** When true, holding Shift shows upgraded card previews. */
  allowUpgradePreview?: boolean;
}) {
  const [fullView, setFullView] = useState(() => viewModeMemory[title] ?? defaultFull);
  const animMode = useAnimationMode();
  const rawShiftHeld = useShiftKey();
  const shiftHeld = (allowUpgradePreview ?? false) && rawShiftHeld;
  const [visible, setVisible] = useState(animMode === 'off');
  const totalCount = cards.reduce((s, g) => s + g.items.length, 0);
  const trashedGroup = cards.find(g => g.label === 'Trashed');
  const trashedCount = trashedGroup?.items.length ?? 0;
  const deckCount = totalCount - trashedCount;

  // Flat list of deck cards (excluding trash) in the same display order used
  // by the rendered groups. Passed to the zoom overlay so arrow keys page
  // through the deck. Trashed cards are intentionally excluded — clicking
  // one opens it without nav (it's not part of the active deck).
  const deckNavList = useMemo<Card[]>(() => {
    const out: Card[] = [];
    for (const group of cards) {
      if (group.label === 'Trashed') continue;
      const ordered = preserveOrder
        ? group.items
        : [...group.items].sort((a, b) => (a.buy_cost ?? -1) - (b.buy_cost ?? -1) || a.name.localeCompare(b.name));
      out.push(...ordered);
    }
    return out;
  }, [cards, preserveOrder]);

  const toggleView = useCallback((full: boolean) => {
    setFullView(full);
    viewModeMemory[title] = full;
  }, [title]);

  useEffect(() => {
    if (animMode !== 'off') {
      requestAnimationFrame(() => setVisible(true));
    }
  }, [animMode]);

  // Dismiss on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const speed = animMode === 'fast' ? 0.5 : 1;
  const overlayTransition = animMode === 'off' ? 'none' : `opacity ${0.25 * speed}s ease`;
  const panelTransition = animMode === 'off' ? 'none' : `opacity ${0.25 * speed}s ease, transform ${0.25 * speed}s ease`;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 45000,
        opacity: visible ? 1 : 0,
        transition: overlayTransition,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(92vw, 860px)',
          maxHeight: '80vh',
          background: '#12122a',
          border: '2px solid #4a4a6a',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1)' : 'scale(0.95)',
          transition: panelTransition,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 16px',
          background: '#1a1a40',
          borderBottom: '1px solid #333',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 'bold', fontSize: 15, color: '#fff' }}>{title}</span>
          <span style={{ fontSize: 12, color: '#888' }}>
            ({deckCount} card{deckCount !== 1 ? 's' : ''}{trashedCount > 0 && <>, <span style={{ color: '#aa4444' }}>{trashedCount} trashed</span></>})
          </span>
          {note && <span style={{ fontSize: 11, color: '#666', fontStyle: 'italic' }}>{note}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={onClose}
              style={{ padding: '4px 10px', background: '#2a2a3e', border: '1px solid #555', borderRadius: 5, color: '#aaa', fontSize: 13, cursor: 'pointer' }}
              aria-label="Close"
            >
              <Icon name="close" size={12} decorative style={{ verticalAlign: '-0.1em' }} />
            </button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: 16 }}>
          {cards.map((group) => {
            const isTrashed = group.label === 'Trashed';
            return (
            <div key={group.label} style={{ marginBottom: 16 }}>
              {cards.length > 1 && (
                <div style={{
                  fontSize: 12,
                  color: isTrashed ? '#aa4444' : '#888',
                  marginBottom: 8,
                  fontWeight: 'bold',
                }}>
                  {isTrashed && <Icon name="trash" size={13} decorative style={{ verticalAlign: '-0.15em', marginRight: 4 }} />}{group.label} ({group.items.length})
                </div>
              )}
              {group.items.length === 0 ? (
                <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic' }}>Empty</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, ...(isTrashed ? { opacity: 0.55 } : {}) }}>
                  {(preserveOrder
                    ? group.items
                    : [...group.items].sort((a, b) => (a.buy_cost ?? -1) - (b.buy_cost ?? -1) || a.name.localeCompare(b.name))
                  ).map((card, i) => (
                    <CardPopupItem
                      key={`${card.id}-${i}`}
                      card={card}
                      full={false}
                      shiftHeld={shiftHeld}
                      navList={isTrashed ? undefined : deckNavList}
                    />
                  ))}
                </div>
              )}
            </div>
          );
          })}
        </div>
      </div>
    </div>
  );
}
