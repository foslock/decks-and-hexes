import { useState, useEffect, useRef, Fragment } from 'react';
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
  small: 'Small (61 tiles, 5 VP)',
  medium: 'Medium (91 tiles, 6 VP)',
  large: 'Large (127 tiles, 9 VP)',
  mega: 'Mega (169 tiles, 12 VP)',
  ultra: 'Ultra (217 tiles, 15 VP)',
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

  const slideDur = animOff ? 0 : 0.45 * animSpeed;
  const slideStyle = (visible: boolean, delayMs?: number): React.CSSProperties => ({
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0) scale(1)' : 'translateY(24px) scale(0.96)',
    transition: animOff ? 'none' : `opacity ${slideDur}s ease-out, transform ${slideDur}s cubic-bezier(0.22, 1, 0.36, 1)`,
    transitionDelay: delayMs ? `${Math.round(delayMs * animSpeed)}ms` : undefined,
  });

  const vpTiles = Object.values(gameState.grid.tiles).filter(t => t.is_vp).length;
  const tilesPerVp = 3;
  // Head-to-head games get a "VS" between the two cards
  const showVs = playerCount === 2;

  return (
    <div className="cc-scr-intro" style={{
      opacity: fadingOut ? 0 : 1,
      transition: fadingOut ? `opacity ${0.6 * animSpeed}s ease` : 'none',
      pointerEvents: fadingOut ? 'none' : 'auto',
    }}>
      {/* VP Target — top area */}
      <div className="cc-scr-intro-vp" style={slideStyle(vpVisible)}>
        <div className="cc-scr-eyebrow" style={{ marginBottom: 10 }}>The battle begins</div>
        <div className="cc-title cc-scr-intro-title">
          Collect {gameState.vp_target} VP
        </div>
        <div className="cc-scr-ornament" aria-hidden="true"><i /></div>
        <div className="cc-scr-intro-sub">
          First player to reach the target wins
        </div>
      </div>

      {/* Player cards — center */}
      <div className="cc-scr-intro-players">
        {gameState.player_order.map((pid, i) => {
          const player = gameState.players[pid];
          if (!player) return null;
          const color = player.color || '#888';
          const archLabel = ARCHETYPE_LABELS[player.archetype] || player.archetype;
          return (
            <Fragment key={pid}>
              {showVs && i === 1 && (
                <div className="cc-scr-vs" style={slideStyle(playersVisible[i])}>VS</div>
              )}
              <div
                className="cc-scr-vs-card"
                style={{ ...slideStyle(playersVisible[i]), ['--pc' as string]: color }}
              >
                {ARCHETYPE_LABELS[player.archetype] && (
                  <img
                    className="cc-scr-vs-emblem"
                    src={`/assets/howtoplay/${player.archetype}.webp`}
                    alt=""
                    draggable={false}
                  />
                )}
                <div className="cc-scr-vs-name">
                  {player.name}
                </div>
                <div className="cc-scr-vs-arch">
                  {archLabel}
                </div>
                {player.is_cpu && player.cpu_difficulty && (
                  <div className="cc-scr-vs-cpu">
                    ({player.cpu_difficulty})
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* Game Settings — bottom area */}
      <div className="cc-scr-intro-settings" style={slideStyle(settingsVisible)}>
        <div className="cc-scr-eyebrow">
          Game Settings
        </div>
        <div className="cc-scr-chips">
          <span className="cc-scr-chip">{GRID_SIZE_LABELS[gameState.grid.size] || gameState.grid.size}</span>
          <span className="cc-scr-chip"><b>{gameState.max_rounds}</b> Rounds</span>
          <span className="cc-scr-chip"><b>{vpTiles}</b> Bonus VP tiles</span>
          <span className="cc-scr-chip"><b>{tilesPerVp}</b> tiles per VP</span>
        </div>
      </div>

      {/* Ready Button */}
      <div className="cc-scr-intro-ready-wrap" style={{
        opacity: readyVisible ? 1 : 0,
        transform: readyVisible ? 'translateY(0) scale(1)' : 'translateY(16px) scale(0.92)',
        transition: animOff ? 'none' : `opacity ${0.4 * animSpeed}s ease-out, transform ${0.4 * animSpeed}s cubic-bezier(0.34, 1.56, 0.64, 1)`,
      }}>
        <button
          className="cc-btn-primary cc-scr-intro-ready"
          onClick={handleReady}
          disabled={!readyVisible}
          style={{ cursor: readyVisible ? 'var(--cc-cursor-pointer)' : 'var(--cc-cursor-arrow)' }}
        >
          I'm Ready
        </button>
        <div className="cc-scr-intro-hint">Press Enter</div>
      </div>
    </div>
  );
}
