import { useRef, useLayoutEffect, useState, type ReactNode } from 'react';
import type { Player } from '../types/game';

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

/** Stat value with an instant-hover styled tooltip, clamped inside the player card. */
function StatTip({ label, children, color }: { label: string; children: ReactNode; color?: string }) {
  const [show, setShow] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const nudgeRef = useRef(0);
  const [, forceUpdate] = useState(0);

  useLayoutEffect(() => {
    if (!show) return;
    const tip = tipRef.current;
    const anchor = anchorRef.current;
    if (!tip || !anchor) return;
    const card = anchor.closest('[data-player-hud]') as HTMLElement | null;
    if (!card) { nudgeRef.current = 0; return; }
    // Measure with no nudge first
    const cardLeft = card.getBoundingClientRect().left;
    const tipLeft = tip.getBoundingClientRect().left;
    const prev = nudgeRef.current;
    // Undo current nudge to get the un-nudged position
    const rawLeft = tipLeft - prev;
    nudgeRef.current = rawLeft < cardLeft ? cardLeft - rawLeft + 4 : 0;
    if (nudgeRef.current !== prev) forceUpdate(n => n + 1);
  }, [show]);

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', cursor: 'default', color }}
      onPointerEnter={() => { nudgeRef.current = 0; setShow(true); }}
      onPointerLeave={() => { setShow(false); nudgeRef.current = 0; }}
    >
      {children}
      {show && (
        <span ref={tipRef} style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: `translateX(calc(-50% + ${nudgeRef.current}px))`,
          marginBottom: 6,
          whiteSpace: 'nowrap',
          background: '#111122',
          border: '1px solid #555',
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 11,
          color: '#ddd',
          fontWeight: 'bold',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          zIndex: 500,
          pointerEvents: 'none',
        }}>
          {label}
        </span>
      )}
    </span>
  );
}

interface PlayerHudProps {
  player: Player;
  isActive: boolean;
  isCurrent: boolean;
  isFirstPlayer?: boolean;
  phase: string;
  totalCards: number;
  tileCount: number;
}

const ARCHETYPE_ICONS: Record<string, string> = {
  vanguard: '⚔️',
  swarm: '🐝',
  fortress: '🏰',
};

const PLAYER_COLORS: Record<string, string> = {
  player_0: '#2a6ecc',
  player_1: '#cc2a2a',
  player_2: '#2aaa4a',
  player_3: '#cc7a2a',
  player_4: '#7a2acc',
  player_5: '#cc2a7a',
};

function getStatus(player: Player, phase: string): { label: string; color: string } {
  if (player.has_left) return { label: 'Left', color: '#666' };
  if (phase === 'plan') {
    if (player.has_submitted_plan) return { label: 'Ready', color: '#4aff6a' };
    return { label: 'Planning', color: '#ffaa4a' };
  }
  if (phase === 'buy') {
    if (player.has_ended_turn) return { label: 'Ready', color: '#4aff6a' };
    return { label: 'Buying', color: '#ffaa4a' };
  }
  if (phase === 'reveal') return { label: 'Resolving', color: '#aa88ff' };
  return { label: phase.replace(/_/g, ' '), color: '#888' };
}

export default function PlayerHud({ player, isActive, isCurrent, isFirstPlayer, phase, totalCards, tileCount }: PlayerHudProps) {
  const status = getStatus(player, phase);

  return (
    <div
      data-player-hud
      style={{
        padding: '8px 12px',
        background: player.has_left ? '#111' : isActive ? '#2a2a4e' : '#1a1a2e',
        border: player.has_left ? '1px solid #2a2a2a' : isCurrent ? '2px solid #4a9eff' : '1px solid #333',
        borderRadius: 8,
        opacity: player.has_left ? 0.45 : isActive ? 1 : 0.7,
        filter: player.has_left ? 'grayscale(0.8)' : undefined,
      }}
    >
      {/* Name row */}
      <div style={{ fontWeight: 'bold', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: PLAYER_COLORS[player.id] || '#666',
          flexShrink: 0,
        }} />
        <ShrinkText
          text={`${ARCHETYPE_ICONS[player.archetype] || ''} ${player.name}`}
          maxWidth={90}
          style={{ fontSize: 13 }}
        />
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
      <div style={{ fontSize: 12, display: 'flex', gap: 10, color: '#bbb' }}>
        <StatTip label="Victory Points">★ {player.vp}</StatTip>
        <StatTip label="Resources">💰 {player.resources}</StatTip>
        <StatTip label="Tiles Occupied">🔷 {tileCount}</StatTip>
        <StatTip label="Total Deck Size">🃏 {totalCards}</StatTip>
        {player.rubble_count > 0 && (
          <StatTip label={`${player.rubble_count} Rubble — each reduces VP by 1`} color="#ff6666">
            🪨 {player.rubble_count}
          </StatTip>
        )}
      </div>
    </div>
  );
}
