import { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import { useAnimationMode } from './SettingsContext';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import Icon from '../icons/Icon';
import type { IconName } from '../icons/glyphs';
import { useCardZoom } from './CardZoomContext';
import CompactCardFace from './CompactCardFace';

// ── Card Popup (deck viewer / discard viewer) ────────────────

function CardPopupItem({ card, full, shiftHeld, navList }: { card: Card; full: boolean; shiftHeld: boolean; navList?: Card[] }) {
  const animMode = useAnimationMode();
  const displayCard = shiftHeld ? getUpgradedPreview(card) : card;
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const { showZoom } = useCardZoom();
  const upgradeLabel = shiftHeld && hasUpgradePreview(card) ? (
    <div style={{ textAlign: 'center', marginTop: 5 }}>
      <span className="cc-ov-tag" style={{ color: 'var(--cc-gold-bright)', borderColor: 'rgba(232, 196, 106, 0.45)' }}>
        <Icon name="upgraded" size={10} decorative style={{ verticalAlign: '-0.1em', marginRight: 4 }} />Upgraded
      </span>
    </div>
  ) : null;
  if (!full) {
    return (
      <div
        onPointerEnter={(e) => setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onPointerLeave={() => setHoverRect(null)}
        onClick={() => showZoom(displayCard, navList)}
        style={{ flexShrink: 0, cursor: 'var(--cc-cursor-pointer)' }}
      >
        <CompactCardFace card={displayCard} width={154} />
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
    <div style={{ flexShrink: 0, cursor: 'var(--cc-cursor-pointer)' }} onClick={() => showZoom(displayCard, navList)}>
      <CardFull card={displayCard} style={{ flexShrink: 0 }} />
      {upgradeLabel}
    </div>
  );
}

// Persists view mode preference per popup title across opens (reset on page reload)
const viewModeMemory: Record<string, boolean> = {};

/** Section glyphs for the deck viewer's groups. */
const GROUP_ICONS: Record<string, IconName> = {
  'In Play': 'engine',
  'In Hand': 'hand',
  'Draw Pile': 'drawPile',
  'Discard Pile': 'discard',
  Trashed: 'trash',
};

export function CardViewPopup({
  title,
  icon = 'stack',
  cards,
  onClose,
  defaultFull = false,
  note,
  preserveOrder = false,
  allowUpgradePreview = false,
}: {
  title: string;
  /** Header glyph (the draw pile, discard pile, whole deck…). */
  icon?: IconName;
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
      className="cc-ov-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 45000,
        opacity: visible ? 1 : 0,
        transition: overlayTransition,
      }}
    >
      <div
        className="cc-ov-modal"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(92vw, 860px)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          opacity: visible ? 1 : 0,
          transform: visible ? 'none' : 'translateY(10px) scale(0.96)',
          transition: panelTransition,
        }}
      >
        <div className="cc-ov-header">
          <Icon name={icon} size={22} decorative style={{ color: 'var(--cc-gold)', flexShrink: 0, filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.6))' }} />
          <span className="cc-ov-title">{title}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
            {trashedCount > 0 && (
              <span className="cc-ov-tag" style={{ color: '#e07b7b', borderColor: 'rgba(224, 123, 123, 0.4)' }}>
                <Icon name="trash" size={10} decorative style={{ verticalAlign: '-0.1em', marginRight: 4 }} />{trashedCount} trashed
              </span>
            )}
            <span className="cc-ov-purse" title={`${deckCount} card${deckCount !== 1 ? 's' : ''}`}>
              <Icon name="card" size={18} decorative style={{ color: 'var(--cc-gold)', marginLeft: 4 }} />
              <span className="cc-ov-purse-value">{deckCount}</span>
              <span className="cc-ov-purse-label">card{deckCount !== 1 ? 's' : ''}</span>
            </span>
            <button className="cc-ov-close" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="close" size={14} decorative />
            </button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '16px 16px 18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {cards.map((group) => {
            const isTrashed = group.label === 'Trashed';
            const groupIcon = GROUP_ICONS[group.label];
            return (
              <section key={group.label}>
                {cards.length > 1 && (
                  <div className="cc-ov-section-head" style={{ marginBottom: 10 }}>
                    <div className="cc-ov-section-title" style={{ fontSize: 14, ...(isTrashed ? { color: '#e07b7b' } : {}) }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
                        {groupIcon && <Icon name={groupIcon} size={14} decorative />}
                        {group.label}
                        <span style={{ fontFamily: 'var(--cc-font-body)', fontSize: 12, letterSpacing: 0, color: 'var(--cc-text-faint)' }}>{group.items.length}</span>
                      </span>
                    </div>
                  </div>
                )}
                {group.items.length === 0 ? (
                  <div className="cc-ov-section-sub" style={{ textAlign: 'center' }}>Empty</div>
                ) : (
                  <div style={{
                    display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', alignItems: 'flex-start',
                    ...(isTrashed ? { opacity: 0.6, filter: 'saturate(0.4)' } : {}),
                  }}>
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
              </section>
            );
          })}
        </div>
        {note && <div className="cc-ov-footer">{note}</div>}
      </div>
    </div>
  );
}
