import { useState, useEffect, useRef } from 'react';
import { useAnimationOff, useAnimationSpeed } from './SettingsContext';
import type { GameState } from '../types/game';

interface GameIntroOverlayProps {
  gameState: GameState;
  onReady: () => void;
}

const ARCHETYPE_LABELS: Record<string, string> = {
  vanguard: 'Vanguard',
  swarm: 'Swarm',
  fortress: 'Fortress',
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
  const animSpeed = useAnimationSpeed();
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

    const s = animSpeed; // 1.0 normal, 0.5 fast
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = Math.round(100 * s); // initial delay

    // VP target slides in
    timers.push(setTimeout(() => setVpVisible(true), t));
    t += Math.round(600 * s); // pause after VP

    // Each player row slides in
    const perPlayerMs = Math.round((playerCount > 3 ? 250 : 350) * s);
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
    t += Math.round(400 * s); // pause after final player

    // Settings slide in
    timers.push(setTimeout(() => setSettingsVisible(true), t));
    t += Math.round(500 * s); // pause after settings

    // Ready button appears
    timers.push(setTimeout(() => setReadyVisible(true), t));

    return () => timers.forEach(clearTimeout);
  }, [animOff, playerCount, animSpeed]);

  const handleReady = () => {
    if (fadingOut) return; // already transitioning
    if (animOff) {
      onReadyRef.current();
      return;
    }
    setFadingOut(true);
    setTimeout(() => onReadyRef.current(), Math.round(600 * animSpeed));
  };

  // Allow Enter key to trigger "I'm Ready" once the button is visible
  useEffect(() => {
    if (!readyVisible || fadingOut) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleReady();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readyVisible, fadingOut]); // eslint-disable-line react-hooks/exhaustive-deps

  const slideDur = animOff ? 0 : 0.8 * animSpeed;
  const slideStyle = (visible: boolean, delayMs?: number): React.CSSProperties => ({
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0)' : 'translateY(30px)',
    transition: animOff ? 'none' : `opacity ${slideDur}s ease, transform ${slideDur}s ease`,
    transitionDelay: delayMs ? `${Math.round(delayMs * animSpeed)}ms` : undefined,
  });

  const vpTiles = Object.values(gameState.grid.tiles).filter(t => t.is_vp).length;
  const tilesPerVp = 3;

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
      transition: fadingOut ? `opacity ${0.6 * animSpeed}s ease` : 'none',
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
          if (!player) return null;
          const color = player.color || '#888';
          const archLabel = ARCHETYPE_LABELS[player.archetype] || player.archetype;
          return (
            <div
              key={pid}
              style={{
                ...slideStyle(playersVisible[i]),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 32px',
                background: 'rgba(30, 30, 50, 0.8)',
                borderRadius: 10,
                borderLeft: `4px solid ${color}`,
                minWidth: 360,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{
                  fontSize: 20,
                  fontWeight: 'bold',
                  color,
                }}>
                  {player.name}
                </span>
                {player.is_cpu && player.cpu_difficulty && (
                  <span style={{ fontSize: 13, color: '#555' }}>
                    ({player.cpu_difficulty})
                  </span>
                )}
              </div>
              <div style={{ fontSize: 14, color: '#aaa', textTransform: 'capitalize' }}>
                {archLabel}
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
          <span>{gameState.max_rounds} Rounds</span>
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
        transition: animOff ? 'none' : `opacity ${0.5 * animSpeed}s ease, transform ${0.5 * animSpeed}s ease`,
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
