import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import CardFull, { CARD_FULL_WIDTH } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';

interface CardZoomContextType {
  showZoom: (card: Card) => void;
}

const CardZoomContext = createContext<CardZoomContextType>({ showZoom: () => {} });

export function useCardZoom() {
  return useContext(CardZoomContext);
}

/** Wrap the app with this provider to enable card zoom overlay from anywhere. */
export function CardZoomProvider({ children }: { children: ReactNode }) {
  const [zoomedCard, setZoomedCard] = useState<Card | null>(null);
  const shiftHeld = useShiftKey();

  const showZoom = useCallback((card: Card) => {
    setZoomedCard(card);
  }, []);

  const closeZoom = useCallback(() => {
    setZoomedCard(null);
  }, []);

  const displayCard = zoomedCard && shiftHeld && hasUpgradePreview(zoomedCard)
    ? getUpgradedPreview(zoomedCard)
    : zoomedCard;

  // Escape key to close
  useEffect(() => {
    if (!zoomedCard) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeZoom();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [zoomedCard, closeZoom]);

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
