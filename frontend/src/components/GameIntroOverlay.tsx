import { useState, useEffect, useRef } from 'react';
import { useAnimationOff } from './SettingsContext';
import type { GameState } from '../types/game';

interface GameIntroOverlayProps {
  gameState: GameState;
  onReady: () => void;
}

const ARCHETYPE_ICONS: Record<string, string> = {
  vanguard: '⚔️',
  swarm: '🐝',
  fortress: '🏰',
};

const ARCHETYPE_LABELS: Record<string, string> = {
  vanguard: 'Vanguard',
  swarm: 'Swarm',
  fortress: 'Fortress',
};

const PLAYER_COLORS: Record<string, string> = {
  player_0: '#2a6ecc',
  player_1: '#cc2a2a',
  player_2: '#2aaa4a',
  player_3: '#cc7a2a',
  player_4: '#7a2acc',
  player_5: '#cc2a7a',
};

const GRID_SIZE_LABELS: Record<string, string> = {
  small: 'Small (61 tiles)',
  medium: 'Medium (91 tiles)',
  large: 'Large (127 tiles)',
};

/**
 * Full-screen intro overlay shown when a new game starts.
 * Animates in: VP target → player rows → game settings → "I'm Ready" button.
 */
export default function GameIntroOverlay({ gameState, onReady }: GameIntroOverlayProps) {
  const animOff = useAnimationOff();
  const playerCount = gameState.player_order.length;

  // Animation stages: 'vp' → 'players' (one per player) → 'settings' → 'ready' → 'fadeout'
  const [vpVisible, setVpVisible] = useState(false);
  const [playersVisible, setPlayersVisible] = useState<boolean[]>(
    new Array(playerCount).fill(false)
  );
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [readyVisible, setReadyVisible] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);
  const [readyHovered, setReadyHovered] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Skip all animations if animations are off
  useEffect(() => {
    if (animOff) {
      setVpVisible(true);
      setPlayersVisible(new Array(playerCount).fill(true));
      setSettingsVisible(true);
      setReadyVisible(true);
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = 100; // initial delay

    // VP target slides in
    timers.push(setTimeout(() => setVpVisible(true), t));
    t += 1000 + 1000; // 1s animation + 1s pause

    // Each player row slides in
    const playerAnimMs = Math.min(500, 300); // faster with more players
    const perPlayerMs = playerCount > 3 ? 350 : 500;
    for (let i = 0; i < playerCount; i++) {
      const idx = i;
      timers.push(setTimeout(() => {
        setPlayersVisible(prev => {
          const next = [...prev];
          next[idx] = true;
          return next;
        });
      }, t));
      t += perPlayerMs;
    }
    t += 1000; // 1s pause after final player

    // Settings slide in
    timers.push(setTimeout(() => setSettingsVisible(true), t));
    t += 1000 + 500; // 1s animation + 500ms pause

    // Ready button appears
    timers.push(setTimeout(() => setReadyVisible(true), t));

    return () => timers.forEach(clearTimeout);
  }, [animOff, playerCount]);

  const handleReady = () => {
    if (animOff) {
      onReadyRef.current();
      return;
    }
    setFadingOut(true);
    setTimeout(() => onReadyRef.current(), 600);
  };

  const slideStyle = (visible: boolean, delayMs?: number): React.CSSProperties => ({
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0)' : 'translateY(30px)',
    transition: animOff ? 'none' : `opacity 0.8s ease, transform 0.8s ease`,
    transitionDelay: delayMs ? `${delayMs}ms` : undefined,
  });

  const vpTiles = Object.values(gameState.grid.tiles).filter(t => t.is_vp).length;
  const GRID_RADIUS: Record<string, number> = { small: 4, medium: 5, large: 6 };
  const tilesPerVp = (GRID_RADIUS[gameState.grid.size] ?? 4) - 1;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 40000,
      background: 'rgba(10, 10, 20, 0.95)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: fadingOut ? 0 : 1,
      transition: fadingOut ? 'opacity 0.6s ease' : 'none',
      pointerEvents: fadingOut ? 'none' : 'auto',
    }}>
      {/* VP Target — top area */}
      <div style={{
        ...slideStyle(vpVisible),
        marginBottom: 48,
      }}>
        <div style={{
          fontSize: 52,
          fontWeight: 'bold',
          color: '#fff',
          textAlign: 'center',
          textTransform: 'uppercase',
          letterSpacing: 6,
          textShadow: '0 0 30px rgba(74, 158, 255, 0.5), 0 2px 8px rgba(0,0,0,0.8)',
        }}>
          Collect {gameState.vp_target} VP
        </div>
        <div style={{
          fontSize: 14,
          color: '#888',
          textAlign: 'center',
          marginTop: 8,
          letterSpacing: 2,
        }}>
          First player to reach the target wins
        </div>
      </div>

      {/* Player Rows — center */}
      <div style={{ marginBottom: 48, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {gameState.player_order.map((pid, i) => {
          const player = gameState.players[pid];
          const color = PLAYER_COLORS[pid] || '#888';
          const archIcon = ARCHETYPE_ICONS[player.archetype] || '?';
          const archLabel = ARCHETYPE_LABELS[player.archetype] || player.archetype;
          return (
            <div
              key={pid}
              style={{
                ...slideStyle(playersVisible[i]),
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '12px 32px',
                background: 'rgba(30, 30, 50, 0.8)',
                borderRadius: 10,
                borderLeft: `4px solid ${color}`,
                minWidth: 360,
              }}
            >
              {/* Archetype icon */}
              <span style={{ fontSize: 28 }}>{archIcon}</span>

              {/* Name & archetype */}
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 18,
                  fontWeight: 'bold',
                  color,
                }}>
                  {player.name}
                </div>
                <div style={{ fontSize: 13, color: '#aaa' }}>
                  {archLabel}
                </div>
              </div>

            </div>
          );
        })}
      </div>

      {/* Game Settings — bottom area */}
      <div style={{
        ...slideStyle(settingsVisible),
        marginBottom: 40,
      }}>
        <div style={{
          fontSize: 13,
          color: '#666',
          textAlign: 'center',
          letterSpacing: 2,
          textTransform: 'uppercase',
          marginBottom: 6,
        }}>
          Game Settings
        </div>
        <div style={{
          display: 'flex',
          gap: 24,
          justifyContent: 'center',
          fontSize: 14,
          color: '#aaa',
        }}>
          <span>{GRID_SIZE_LABELS[gameState.grid.size] || gameState.grid.size}</span>
          <span>·</span>
          <span>{vpTiles} Bonus VP tiles</span>
          <span>·</span>
          <span>{tilesPerVp} tiles per VP</span>
        </div>
      </div>

      {/* Ready Button */}
      <div style={{
        opacity: readyVisible ? 1 : 0,
        transform: readyVisible ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.9)',
        transition: animOff ? 'none' : 'opacity 0.5s ease, transform 0.5s ease',
      }}>
        <button
          onClick={handleReady}
          disabled={!readyVisible}
          onMouseEnter={() => setReadyHovered(true)}
          onMouseLeave={() => setReadyHovered(false)}
          style={{
            padding: '14px 48px',
            fontSize: 20,
            fontWeight: 'bold',
            color: '#fff',
            background: '#2aaa4a',
            border: 'none',
            borderRadius: 10,
            cursor: readyVisible ? 'pointer' : 'default',
            boxShadow: readyHovered && readyVisible
              ? '0 4px 30px rgba(42, 170, 74, 0.7), 0 0 15px rgba(42, 170, 74, 0.4)'
              : '0 4px 20px rgba(42, 170, 74, 0.4)',
            letterSpacing: 2,
            transition: 'box-shadow 0.2s ease',
          }}
        >
          I'm Ready
        </button>
      </div>
    </div>
  );
}
