import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import CardFull, { CARD_FULL_WIDTH } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';

interface CardZoomContextType {
  showZoom: (card: Card, cardList?: Card[]) => void;
}

const CardZoomContext = createContext<CardZoomContextType>({ showZoom: () => {} });

export function useCardZoom() {
  return useContext(CardZoomContext);
}

/** Wrap the app with this provider to enable card zoom overlay from anywhere. */
export function CardZoomProvider({ children }: { children: ReactNode }) {
  const [zoomedCard, setZoomedCard] = useState<Card | null>(null);
  const [navList, setNavList] = useState<Card[] | null>(null);
  const shiftHeld = useShiftKey();

  const showZoom = useCallback((card: Card, cardList?: Card[]) => {
    setZoomedCard(card);
    setNavList(cardList ?? null);
  }, []);

  const closeZoom = useCallback(() => {
    setZoomedCard(null);
    setNavList(null);
  }, []);

  // Find current index in nav list
  const currentIndex = navList && zoomedCard
    ? navList.findIndex(c => c.id === zoomedCard.id)
    : -1;

  const navigate = useCallback((direction: -1 | 1) => {
    if (!navList || currentIndex < 0) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < navList.length) {
      setZoomedCard(navList[nextIndex]);
    }
  }, [navList, currentIndex]);

  const displayCard = zoomedCard && shiftHeld && hasUpgradePreview(zoomedCard)
    ? getUpgradedPreview(zoomedCard)
    : zoomedCard;

  // Keyboard handler: Escape to close, arrow keys to navigate
  useEffect(() => {
    if (!zoomedCard) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeZoom();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigate(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigate(1);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [zoomedCard, closeZoom, navigate]);

  const hasPrev = navList != null && currentIndex > 0;
  const hasNext = navList != null && currentIndex >= 0 && currentIndex < navList.length - 1;

  return (
    <CardZoomContext.Provider value={{ showZoom }}>
      {children}
      {zoomedCard && createPortal(
        <div
          onClick={closeZoom}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50000,
            cursor: 'pointer',
          }}
        >
          {/* Left arrow */}
          {hasPrev && (
            <div
              onClick={(e) => { e.stopPropagation(); navigate(-1); }}
              style={{
                position: 'fixed',
                left: 32,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 36,
                color: '#888',
                cursor: 'pointer',
                userSelect: 'none',
                padding: '16px',
                lineHeight: 1,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#888')}
            >
              ‹
            </div>
          )}

          {/* Right arrow */}
          {hasNext && (
            <div
              onClick={(e) => { e.stopPropagation(); navigate(1); }}
              style={{
                position: 'fixed',
                right: 32,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 36,
                color: '#888',
                cursor: 'pointer',
                userSelect: 'none',
                padding: '16px',
                lineHeight: 1,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#888')}
            >
              ›
            </div>
          )}

          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              cursor: 'default',
              transform: 'scale(2)',
              transformOrigin: 'center center',
            }}
          >
            <CardFull card={displayCard!} />
          </div>

          {/* Upgrade indicator — always reserve space to avoid layout shift */}
          {zoomedCard && hasUpgradePreview(zoomedCard) && (
            <div style={{
              marginTop: 24,
              fontSize: 14,
              fontWeight: 'bold',
              color: '#4aff6a',
              textAlign: 'center',
              pointerEvents: 'none',
              visibility: shiftHeld ? 'visible' : 'hidden',
            }}>
              ✦ Upgraded Preview
            </div>
          )}

          {/* Close hint */}
          <div style={{
            position: 'fixed',
            bottom: 24,
            left: 0,
            right: 0,
            fontSize: 14,
            color: '#666',
            textAlign: 'center',
            pointerEvents: 'none',
          }}>
            {navList && navList.length > 1 && (
              <span>← → to browse · </span>
            )}
            {zoomedCard && !zoomedCard.is_upgraded && hasUpgradePreview(zoomedCard)
              ? 'Hold Shift for upgrade preview · Click anywhere or Escape to close'
              : 'Click anywhere or press Escape to close'}
          </div>
        </div>,
        document.body
      )}
    </CardZoomContext.Provider>
  );
}
