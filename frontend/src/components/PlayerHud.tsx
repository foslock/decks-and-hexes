import { useRef, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Player } from '../types/game';
import type { VpBreakdown } from '../utils/vpBreakdown';

/** Renders text that shrinks (via transform scaleX) to fit a fixed max width. */
function ShrinkText({ text, maxWidth, style }: { text: string; maxWidth: number; style?: React.CSSProperties }) {
  const innerRef = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const natural = el.scrollWidth;
    setScale(natural > maxWidth ? maxWidth / natural : 1);
  }, [text, maxWidth]);

  return (
    <span style={{ display: 'inline-block', width: maxWidth, flexShrink: 0, overflow: 'hidden' }}>
      <span
        ref={innerRef}
        style={{
          display: 'inline-block',
          whiteSpace: 'nowrap',
          transformOrigin: 'left center',
          transform: scale < 1 ? `scaleX(${scale})` : undefined,
          ...style,
        }}
      >
        {text}
      </span>
    </span>
  );
}

/** Stat value with an instant-hover styled tooltip, portalled to body so it's never clipped. */
function StatTip({ label, children, color }: { label: string; children: ReactNode; color?: string }) {
  const [show, setShow] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!show || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      left: rect.left + rect.width / 2,
      top: rect.top,
    });
  }, [show]);

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', cursor: 'default', color }}
      onPointerEnter={() => setShow(true)}
      onPointerLeave={() => { setShow(false); setPos(null); }}
    >
      {children}
      {show && pos && createPortal(
        <span style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          transform: 'translate(-50%, calc(-100% - 6px))',
          whiteSpace: 'nowrap',
          background: '#111122',
          border: '1px solid #555',
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 11,
          color: '#ddd',
          fontWeight: 'bold',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          zIndex: 20000,
          pointerEvents: 'none',
        }}>
          {label}
        </span>,
        document.body
      )}
    </span>
  );
}

/** VP stat with detailed breakdown tooltip (Tiles / VP Hexes / Cards). */
function VpStatTip({ breakdown, children }: { breakdown: VpBreakdown; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!show || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      left: rect.left + rect.width / 2,
      top: rect.top,
    });
  }, [show]);

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', cursor: 'default' }}
      onPointerEnter={() => setShow(true)}
      onPointerLeave={() => { setShow(false); setPos(null); }}
    >
      {children}
      {show && pos && createPortal(
        <div ref={(el) => {
          // Clamp to viewport after first render
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.left < 4) el.style.left = `${pos.left - r.left + 4}px`;
          }
        }} style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          transform: 'translate(-50%, calc(-100% - 6px))',
          background: '#1a1a3a',
          border: '1px solid #4a4a6a',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 12,
          color: '#ccc',
          pointerEvents: 'none',
          zIndex: 20000,
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          <div style={{ fontWeight: 'bold', color: '#ffd700', marginBottom: 4, fontSize: 11 }}>VP Breakdown</div>
          <div>Tiles: {breakdown.tileCount}</div>
          <div>VP Hexes: {breakdown.bonusTiles}</div>
          <div>Cards: {breakdown.cards}</div>
        </div>,
        document.body
      )}
    </span>
  );
}

interface BuyPurchase {
  card_id: string;
  definition_id?: string;
  card_name: string;
  source: string;
  cost: number;
  card_type?: string;
}

import { CARD_TYPE_COLORS, DEBT_CARD_COLOR } from '../constants/cardColors';

interface PlayerHudProps {
  player: Player;
  isActive: boolean;
  isCurrent: boolean;
  isFirstPlayer?: boolean;
  isCurrentBuyer?: boolean;
  phase: string;
  totalCards: number;
  tileCount: number;
  purchases?: BuyPurchase[];
  onPurchaseHover?: (e: React.MouseEvent, cardId: string, definitionId?: string) => void;
  onPurchaseLeave?: () => void;
  vpTarget?: number;
  vpBreakdown?: VpBreakdown;
}

const ARCHETYPE_ICONS: Record<string, string> = {
  vanguard: '⚔️',
  swarm: '🐝',
  fortress: '🏰',
};

// Player colors are now dynamic — read from player.color field

function getStatus(player: Player, phase: string, isCurrentBuyer?: boolean): { label: string; color: string } {
  if (player.has_left) return { label: 'Left', color: '#666' };
  if (phase === 'play') {
    if (player.has_submitted_play) return { label: 'Ready', color: '#4aff6a' };
    return { label: 'Playing', color: '#ffaa4a' };
  }
  if (phase === 'buy') {
    if (isCurrentBuyer) return { label: 'Buying', color: '#ffaa4a' };
    if (player.has_ended_turn) return { label: 'Done', color: '#4aff6a' };
    return { label: 'Waiting', color: '#888' };
  }
  if (phase === 'reveal') return { label: 'Resolving', color: '#aa88ff' };
  const raw = phase.replace(/_/g, ' ');
  return { label: raw.charAt(0).toUpperCase() + raw.slice(1), color: '#888' };
}

export default function PlayerHud({ player, isActive, isCurrent, isFirstPlayer, isCurrentBuyer, phase, totalCards, tileCount, purchases, onPurchaseHover, onPurchaseLeave, vpTarget, vpBreakdown }: PlayerHudProps) {
  const status = getStatus(player, phase, isCurrentBuyer);
  const hasReachedVpTarget = vpTarget != null && player.vp >= vpTarget;
  const [showVpTooltip, setShowVpTooltip] = useState(false);
  const hudRef = useRef<HTMLDivElement>(null);

  const borderStyle = player.has_left
    ? '1px solid #2a2a2a'
    : hasReachedVpTarget
      ? '2px solid #ffd700'
      : isCurrentBuyer
        ? '2px solid #ffaa4a'
        : isCurrent
          ? '2px solid #4a9eff'
          : '1px solid #333';

  // Pick the right animation — VP target glow takes priority
  const animation = hasReachedVpTarget
    ? 'vpTargetGlow 2s ease-in-out infinite'
    : isCurrentBuyer
      ? 'pulse 2s ease-in-out infinite'
      : undefined;

  return (
    <>
    {hasReachedVpTarget && (
      <style>{`
        @keyframes vpTargetGlow {
          0%, 100% { box-shadow: 0 0 6px rgba(255, 215, 0, 0.3); }
          50% { box-shadow: 0 0 16px rgba(255, 215, 0, 0.7), 0 0 6px rgba(255, 215, 0, 0.4); }
        }
      `}</style>
    )}
    <div
      ref={hudRef}
      data-player-hud={player.id}
      onPointerEnter={hasReachedVpTarget ? () => setShowVpTooltip(true) : undefined}
      onPointerLeave={hasReachedVpTarget ? () => setShowVpTooltip(false) : undefined}
      style={{
        padding: '8px 10px',
        background: player.has_left ? '#111' : isActive ? '#2a2a4e' : '#1a1a2e',
        border: borderStyle,
        borderRadius: 8,
        opacity: player.has_left ? 0.45 : isActive ? 1 : 0.7,
        filter: player.has_left ? 'grayscale(0.8)' : undefined,
        animation,
        position: 'relative',
      }}
    >
      {/* VP target tooltip — portalled to body so it's never clipped */}
      {showVpTooltip && hasReachedVpTarget && hudRef.current && createPortal(
        <span style={{
          position: 'fixed',
          left: hudRef.current.getBoundingClientRect().right + 8,
          top: hudRef.current.getBoundingClientRect().top + hudRef.current.getBoundingClientRect().height / 2,
          transform: 'translateY(-50%)',
          whiteSpace: 'nowrap',
          background: '#111122',
          border: '1px solid #ffd700',
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 11,
          color: '#ffd700',
          fontWeight: 'bold',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          zIndex: 20000,
          pointerEvents: 'none',
        }}>
          ★ {player.name} has reached the VP target — game ends after this round
        </span>,
        document.body
      )}
      {/* Name row */}
      <div style={{ fontWeight: 'bold', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: player.color || '#666',
          flexShrink: 0,
        }} />
        <span style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden' }}>
          <span
            style={{
              display: 'inline-block',
              whiteSpace: 'nowrap',
              fontSize: 13,
              maxWidth: '100%',
              transformOrigin: 'left center',
              transform: 'scaleX(var(--name-scale, 1))',
            }}
            ref={(el) => {
              if (el) {
                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                el.style.setProperty('--name-scale', String(scale));
              }
            }}
          >
            {player.name}
          </span>
        </span>
        {/* Always reserve space for the 1st badge so width doesn't shift */}
        <span
          title={isFirstPlayer ? 'First player — resolves first this round' : undefined}
          style={{
            fontSize: 9,
            padding: '1px 5px',
            borderRadius: 6,
            background: isFirstPlayer ? '#ffd700' : 'transparent',
            color: isFirstPlayer ? '#000' : 'transparent',
            fontWeight: 'bold',
            letterSpacing: 0.5,
            lineHeight: 1.4,
            flexShrink: 0,
          }}
        >
          1st
        </span>
        {/* Status badge, right-aligned */}
        <span style={{
          marginLeft: 'auto',
          fontSize: 10,
          padding: '1px 6px',
          borderRadius: 6,
          background: `${status.color}22`,
          color: status.color,
          fontWeight: 'bold',
          whiteSpace: 'nowrap',
        }}>
          {status.label}
        </span>
      </div>

      {/* Stats row */}
      <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', color: '#bbb' }}>
        {vpBreakdown ? (
          <VpStatTip breakdown={vpBreakdown}>
            <span style={hasReachedVpTarget ? {
              color: '#ffd700',
              fontWeight: 'bold',
              textShadow: '0 0 6px rgba(255, 255, 255, 0.6)',
            } : undefined}>★ {player.vp}</span>
          </VpStatTip>
        ) : (
          <StatTip label="Victory Points">
            <span style={hasReachedVpTarget ? {
              color: '#ffd700',
              fontWeight: 'bold',
              textShadow: '0 0 6px rgba(255, 255, 255, 0.6)',
            } : undefined}>★ {player.vp}</span>
          </StatTip>
        )}
        <StatTip label="Resources">💰 {player.resources}</StatTip>
        <StatTip label="Tiles Occupied">🔷 {tileCount}</StatTip>
        <StatTip label="Total Deck Size">🃏 {totalCards}</StatTip>
      </div>

      {/* Purchases made this buy phase */}
      {purchases && purchases.length > 0 && (
        <div style={{ marginTop: 4, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {purchases.map((p, i) => (
            <span
              key={i}
              onMouseEnter={onPurchaseHover ? (e) => onPurchaseHover(e, p.card_id, p.definition_id) : undefined}
              onMouseLeave={onPurchaseLeave}
              style={{
                fontSize: 10,
                padding: '1px 5px',
                background: '#1a1a2e',
                border: `1px solid ${p.card_name === 'Debt' ? DEBT_CARD_COLOR : p.card_type ? (CARD_TYPE_COLORS[p.card_type] || '#555') : (p.source === 'upgrade' ? '#ffaa4a' : '#555')}`,
                borderRadius: 4,
                color: '#ccc',
                whiteSpace: 'nowrap',
                cursor: onPurchaseHover ? 'pointer' : undefined,
              }}
            >
              {p.card_name} ({p.cost}💰)
            </span>
          ))}
        </div>
      )}
    </div>
    </>
  );
}
