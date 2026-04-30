import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import CardFull, { CARD_FULL_WIDTH } from './CardFull';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';

/** Module-level cache of the iOS DeviceOrientation permission state so the
 *  request runs once and is shared across modal opens. iOS requires the
 *  request to happen synchronously inside a user gesture, so it's kicked off
 *  from `showZoom` (which runs in the click handler that opens the modal),
 *  not from the modal's effect — the gesture would already be over by then. */
type OrientationPermissionState = 'unknown' | 'pending' | 'granted' | 'denied' | 'unsupported';
let orientationPermission: OrientationPermissionState = 'unknown';
const orientationPermissionListeners = new Set<() => void>();
function notifyOrientationPermission() {
  for (const fn of orientationPermissionListeners) fn();
}
function ensureOrientationPermission() {
  if (typeof window === 'undefined') return;
  if (orientationPermission !== 'unknown') return;
  if (!('DeviceOrientationEvent' in window)) {
    orientationPermission = 'unsupported';
    return;
  }
  const DOE = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (typeof DOE.requestPermission !== 'function') {
    // Non-iOS platforms (Android Chrome, etc.) don't gate orientation events.
    orientationPermission = 'granted';
    notifyOrientationPermission();
    return;
  }
  orientationPermission = 'pending';
  DOE.requestPermission()
    .then(state => {
      orientationPermission = state === 'granted' ? 'granted' : 'denied';
      notifyOrientationPermission();
    })
    .catch(() => {
      orientationPermission = 'denied';
      notifyOrientationPermission();
    });
}

/** Wraps the zoomed CardFull with a 3D tilt + glare overlay so the card feels
 *  like a physical, slightly reflective object in the user's hand. On
 *  pointer-capable devices the tilt tracks the cursor over the card's bounds.
 *  On touch-primary devices it tracks the device's orientation (gyroscope /
 *  accelerometer) relative to the pose at which the modal was opened, so
 *  tilting the phone tips the card. */
function TiltingZoomedCard({ card }: { card: Card }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // tilt: -1..+1 normalized offset (cursor or device tilt) from card center
  const [tilt, setTilt] = useState({ x: 0, y: 0, glareX: 50, glareY: 50, active: false });

  useEffect(() => {
    const useOrientation =
      typeof window !== 'undefined' &&
      'DeviceOrientationEvent' in window &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches;

    if (useOrientation) {
      // Rest pose captured on first event so the card sits flat at the user's
      // natural hold angle and tilts in response to deltas from there.
      let rest: { beta: number; gamma: number } | null = null;
      // ~22 degrees of device tilt = full effect; clamped slightly past 1 so
      // the edges still feel responsive without snapping hard.
      const RANGE_DEG = 22;

      const onOrient = (e: DeviceOrientationEvent) => {
        if (e.beta == null || e.gamma == null) return;
        if (!rest) rest = { beta: e.beta, gamma: e.gamma };
        // beta: front-back tilt (-180..180), gamma: left-right tilt (-90..90)
        const dBeta = e.beta - rest.beta;
        const dGamma = e.gamma - rest.gamma;
        const nx = Math.max(-1.4, Math.min(1.4, dGamma / RANGE_DEG));
        const ny = Math.max(-1.4, Math.min(1.4, dBeta / RANGE_DEG));
        // Glare follows the tilt vector since there's no cursor to anchor it.
        const gx = Math.max(0, Math.min(100, 50 + nx * 50));
        const gy = Math.max(0, Math.min(100, 50 + ny * 50));
        setTilt({ x: nx, y: ny, glareX: gx, glareY: gy, active: true });
      };

      let attached = false;
      const attach = () => {
        if (attached) return;
        if (orientationPermission !== 'granted') return;
        attached = true;
        window.addEventListener('deviceorientation', onOrient);
      };
      // Permission is requested from `showZoom` (a real click gesture) so by
      // the time this effect runs the iOS prompt is usually resolved. If it's
      // still pending, attach as soon as the cached state flips.
      attach();
      orientationPermissionListeners.add(attach);

      return () => {
        orientationPermissionListeners.delete(attach);
        if (attached) window.removeEventListener('deviceorientation', onOrient);
      };
    }

    const onMove = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // normalize to -1..+1 across the card bounds, clamped slightly outside
      // so the effect is felt at edges without snapping back hard.
      const nx = Math.max(-1.4, Math.min(1.4, (e.clientX - cx) / (r.width / 2)));
      const ny = Math.max(-1.4, Math.min(1.4, (e.clientY - cy) / (r.height / 2)));
      // glare position in % within the card bounds (0..100)
      const gx = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      const gy = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
      setTilt({ x: nx, y: ny, glareX: gx, glareY: gy, active: true });
    };
    const onLeave = () => setTilt(t => ({ ...t, active: false }));
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  // Tilt amplitude — kept small so it reads as "subtle physical card", not
  // "wobbly UI element". Y axis tilts with cursor X (horizontal mouse moves
  // the right edge away/toward the user); X axis tilts with cursor Y.
  const MAX_TILT_DEG = 7;
  const rotateY = tilt.x * MAX_TILT_DEG;
  const rotateX = -tilt.y * MAX_TILT_DEG;

  return (
    <div
      ref={wrapRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        cursor: 'default',
        transform: 'scale(2)',
        transformOrigin: 'center center',
        perspective: '1400px',
      }}
    >
      <div
        style={{
          position: 'relative',
          transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`,
          transition: tilt.active
            ? 'transform 0.08s linear'
            : 'transform 0.4s cubic-bezier(.2,.7,.3,1)',
          transformStyle: 'preserve-3d',
          willChange: 'transform',
        }}
      >
        <CardFull card={card} />
        {/* Glare overlay — a soft elliptical highlight that follows the cursor,
            simulating a glossy laminate catching light. Pointer-events off so
            it never blocks clicks. Border radius matches CardFull's 12px so the
            glare clips to the card silhouette. */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 12,
            pointerEvents: 'none',
            background: `radial-gradient(circle at ${tilt.glareX}% ${tilt.glareY}%, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.025) 20%, rgba(255,255,255,0) 50%)`,
            mixBlendMode: 'screen',
            opacity: tilt.active ? 0.55 : 0.18,
            transition: 'opacity 0.25s ease',
          }}
        />
        {/* Edge sheen — a thin diagonal streak that drifts with the tilt,
            anchored opposite the glare for a "two reflection" feel. */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 12,
            pointerEvents: 'none',
            background: `linear-gradient(${135 + tilt.x * 25}deg, rgba(255,255,255,0) 30%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0) 70%)`,
            opacity: tilt.active ? 0.9 : 0.35,
            transition: 'opacity 0.25s ease',
          }}
        />
      </div>
    </div>
  );
}

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
    // Kick off the iOS DeviceOrientation permission prompt synchronously
    // inside the click gesture that opened the modal — by the time the
    // modal mounts, the gesture is over and iOS would reject the request.
    ensureOrientationPermission();
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

          <TiltingZoomedCard card={displayCard!} />

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
