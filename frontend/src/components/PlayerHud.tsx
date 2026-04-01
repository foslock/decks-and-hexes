import type { Player } from '../types/game';

interface PlayerHudProps {
  player: Player;
  isActive: boolean;
  isCurrent: boolean;
}

const ARCHETYPE_ICONS: Record<string, string> = {
  vanguard: '⚔️',
  swarm: '🐝',
  fortress: '🏰',
};

const PLAYER_COLORS: Record<string, string> = {
  player_0: '#4a9eff',
  player_1: '#ff4a4a',
  player_2: '#4aff6a',
  player_3: '#ffaa4a',
  player_4: '#aa4aff',
  player_5: '#ff4aaa',
};

export default function PlayerHud({ player, isActive, isCurrent }: PlayerHudProps) {
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
      </div>
      <div style={{ fontSize: 13, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span title="Victory Points">🏆 {player.vp}</span>
        <span title="Resources">💰 {player.resources}</span>
        <span title="Cards in hand">🃏 {player.hand_count}</span>
        <span title="Cards in draw pile">🎴 {player.deck_size}</span>
        <span title="Cards in discard">🗑️ {player.discard_count}</span>
        <span title="Actions">⚡ {player.actions_used}/{player.actions_available}</span>
        {player.upgrade_credits > 0 && (
          <span title="Upgrade credits">⬆️ {player.upgrade_credits}</span>
        )}
      </div>
      {player.has_submitted_plan && (
        <div style={{ fontSize: 11, color: '#4aff6a', marginTop: 4 }}>
          ✓ Plan submitted ({player.planned_action_count} actions)
        </div>
      )}
    </div>
  );
}
