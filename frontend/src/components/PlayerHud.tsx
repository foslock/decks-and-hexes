import type { Player } from '../types/game';

interface PlayerHudProps {
  player: Player;
  isActive: boolean;
  isCurrent: boolean;
  isFirstPlayer?: boolean;
  phase: string;
  totalCards: number;
  tileCount: number;
  vpTarget: number;
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

export default function PlayerHud({ player, isActive, isCurrent, isFirstPlayer, phase, totalCards, tileCount, vpTarget }: PlayerHudProps) {
  const status = getStatus(player, phase);

  return (
    <div
      style={{
        padding: '8px 12px',
        background: isActive ? '#2a2a4e' : '#1a1a2e',
        border: isCurrent ? '2px solid #4a9eff' : '1px solid #333',
        borderRadius: 8,
        opacity: isActive ? 1 : 0.7,
      }}
    >
      {/* Name row */}
      <div style={{ fontWeight: 'bold', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: PLAYER_COLORS[player.id] || '#666',
          flexShrink: 0,
        }} />
        {ARCHETYPE_ICONS[player.archetype] || ''} {player.name}
        {isFirstPlayer && (
          <span
            title="First player — resolves first this round"
            style={{
              fontSize: 9,
              padding: '1px 5px',
              borderRadius: 6,
              background: '#ffd700',
              color: '#000',
              fontWeight: 'bold',
              letterSpacing: 0.5,
              marginLeft: 2,
              lineHeight: 1.4,
            }}
          >
            1st
          </span>
        )}
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
        <span title="Victory Points">★ {player.vp}/{vpTarget}</span>
        <span title="Unspent Resources">💰 {player.resources}</span>
        <span title="Tiles owned">🔷 {tileCount}</span>
        <span title="Total cards in deck (hand + draw + discard + in play)">🃏 {totalCards}</span>
        {player.rubble_count > 0 && (
          <span title={`${player.rubble_count} Rubble card(s) — each reduces VP by 1`} style={{ color: '#ff6666' }}>
            🪨 {player.rubble_count}
          </span>
        )}
      </div>
    </div>
  );
}
