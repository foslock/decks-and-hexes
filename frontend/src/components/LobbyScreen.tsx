import { useState, useEffect, useCallback, useRef } from 'react';
import type { GameState, LobbyState } from '../types/game';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSettings, type AnimationMode } from './SettingsContext';
import * as api from '../api/client';

const ARCHETYPES = [
  { id: 'vanguard', name: 'Vanguard', icon: '⚔️' },
  { id: 'swarm', name: 'Swarm', icon: '🐝' },
  { id: 'fortress', name: 'Fortress', icon: '🏰' },
];

const GRID_SIZES = [
  { id: 'small', name: 'Small (61)', players: '2-3', tiles: 61, radius: 4 },
  { id: 'medium', name: 'Medium (91)', players: '3-4', tiles: 91, radius: 5 },
  { id: 'large', name: 'Large (127)', players: '4-6', tiles: 127, radius: 6 },
];

const SPEED_MULTIPLIERS: Record<string, number> = { fast: 0.66, normal: 1.0, slow: 1.33 };

function computeVpTarget(gridSizeId: string, playerCount: number, speed: string): number {
  const grid = GRID_SIZES.find(g => g.id === gridSizeId) ?? GRID_SIZES[0];
  const tilesPerVp = grid.radius - 1;
  const divisor = Math.floor(tilesPerVp * playerCount * 0.75) || 1;
  const base = Math.floor(grid.tiles / divisor);
  return Math.max(3, Math.round(base * (SPEED_MULTIPLIERS[speed] ?? 1.0)));
}

const SPEEDS = [
  { id: 'fast', name: 'Fast' },
  { id: 'normal', name: 'Normal' },
  { id: 'slow', name: 'Slow' },
];

const DIFFICULTIES = [
  { id: 'easy', name: 'Easy' },
  { id: 'medium', name: 'Medium' },
  { id: 'hard', name: 'Hard' },
];

interface LobbyScreenProps {
  lobbyCode: string;
  playerId: string;
  token: string;
  isHost: boolean;
  initialLobby: LobbyState;
  onGameStart: (gameId: string, state: GameState, localPlayerIds?: string[]) => void;
  onLeave: () => void;
}

export default function LobbyScreen({
  lobbyCode, playerId, token, isHost, initialLobby, onGameStart, onLeave,
}: LobbyScreenProps) {
  const { settings, setAnimationMode, setTooltips } = useSettings();
  const [lobby, setLobby] = useState<LobbyState>(initialLobby);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownStart, setCountdownStart] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [showCopied, setShowCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const gameStartRef = useRef(false);

  // For "Add Local Player" inline form
  const [showAddLocal, setShowAddLocal] = useState(false);
  const [localName, setLocalName] = useState('');
  const [localArchetype, setLocalArchetype] = useState('swarm');

  const { lastMessage, status } = useWebSocket(lobbyCode, playerId, token);

  // Handle WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === 'lobby_update') {
      setLobby(lastMessage.lobby as unknown as LobbyState);
    } else if (lastMessage.type === 'countdown') {
      const secs = lastMessage.seconds_remaining as number;
      setCountdown(secs);
      if (secs === 3) setCountdownStart(Date.now());
    } else if (lastMessage.type === 'game_start') {
      console.log('[Lobby] WS game_start received, gameStartRef:', gameStartRef.current);
      if (!gameStartRef.current) {
        gameStartRef.current = true;
        // Compute local player IDs from lobby state
        const localIds = computeLocalPlayerIds(lobby, playerId, isHost);
        console.log('[Lobby] calling onGameStart with gameId:', lastMessage.game_id);
        onGameStart(
          lastMessage.game_id as string,
          lastMessage.state as unknown as GameState,
          localIds,
        );
      }
    } else if (lastMessage.type === 'lobby_closed') {
      console.log('[Lobby] lobby_closed received → onLeave');
      onLeave();
    } else if (lastMessage.type === 'error') {
      setError(lastMessage.message as string);
    }
  }, [lastMessage, onGameStart, onLeave, lobby, playerId, isHost]);

  const players = Object.values(lobby.players);

  // ── Host actions ─────────────────────────────────────────

  const handleConfigChange = useCallback(async (
    field: string, value: string | number | boolean,
  ) => {
    try {
      setError(null);
      await api.updateLobbyConfig(lobbyCode, token, { [field]: value });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, token]);

  const handleAddCpu = useCallback(async (archetype: string, difficulty: string = 'medium') => {
    try {
      setError(null);
      await api.addCpuToLobby(lobbyCode, token, archetype, difficulty);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, token]);

  const handleAddLocal = useCallback(async () => {
    const name = localName.trim() || `Player ${players.length + 1}`;
    try {
      setError(null);
      await api.addLocalPlayer(lobbyCode, token, name, localArchetype);
      setShowAddLocal(false);
      setLocalName('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, token, localName, localArchetype, players.length]);

  const handleRemovePlayer = useCallback(async (targetId: string) => {
    try {
      setError(null);
      await api.removeLobbyPlayer(lobbyCode, token, targetId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, token]);

  const handleStart = useCallback(async () => {
    try {
      setError(null);
      setStarting(true);
      console.log('[Lobby] handleStart: calling api.startLobby...');
      const result = await api.startLobby(lobbyCode, token);
      console.log('[Lobby] handleStart: HTTP response received, gameStartRef:', gameStartRef.current);
      // Host also gets the response directly
      if (!gameStartRef.current) {
        gameStartRef.current = true;
        const localIds = computeLocalPlayerIds(lobby, playerId, isHost);
        console.log('[Lobby] handleStart: calling onGameStart (HTTP path)');
        onGameStart(result.game_id, result.state, localIds);
      } else {
        console.log('[Lobby] handleStart: skipped — WS already handled game_start');
      }
    } catch (e: unknown) {
      console.error('[Lobby] handleStart FAILED:', e);
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  }, [lobbyCode, token, onGameStart, lobby, playerId, isHost]);

  // ── Player self-edit ─────────────────────────────────────

  const handleUpdateSelf = useCallback(async (updates: { name?: string; archetype?: string }) => {
    try {
      setError(null);
      await api.updateLobbyPlayer(lobbyCode, playerId, token, updates);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, playerId, token]);

  // Host edits local or CPU player (uses host's token)
  const handleUpdatePlayer = useCallback(async (targetId: string, updates: { name?: string; archetype?: string }) => {
    try {
      setError(null);
      await api.updateLobbyPlayer(lobbyCode, targetId, token, updates);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, token]);

  const handleLeave = useCallback(async () => {
    try {
      if (isHost) {
        await api.closeLobby(lobbyCode, token);
      } else {
        await api.removeLobbyPlayer(lobbyCode, token, playerId);
      }
      onLeave();
    } catch {
      onLeave();
    }
  }, [lobbyCode, token, playerId, isHost, onLeave]);

  // ── Countdown progress bar ───────────────────────────────

  const [progressAnim, setProgressAnim] = useState(1);
  useEffect(() => {
    if (countdownStart === null) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - countdownStart;
      setProgressAnim(Math.max(0, 1 - elapsed / 3000));
      if (elapsed >= 3000) clearInterval(interval);
    }, 30);
    return () => clearInterval(interval);
  }, [countdownStart]);

  // ── Render ───────────────────────────────────────────────

  return (
    <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100vh' }}>
      {/* Settings gear — top right */}
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 100 }}>
        <button
          onClick={() => setSettingsOpen(p => !p)}
          style={{
            padding: '6px 14px', borderRadius: 6,
            background: settingsOpen ? '#3a3a6e' : '#2a2a3e',
            border: '1px solid #555', color: '#aaa',
            cursor: 'pointer', fontSize: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          title="Settings"
        >
          <span style={{ fontSize: 20 }}>⚙</span>
        </button>
        {settingsOpen && (
          <div style={{
            position: 'absolute', top: 42, right: 0,
            background: '#2a2a3e', border: '1px solid #555',
            borderRadius: 8, padding: 12, minWidth: 220,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>LOCAL SETTINGS</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#aaa', minWidth: 75 }}>Animations:</span>
              {(['normal', 'fast', 'off'] as AnimationMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setAnimationMode(mode)}
                  style={{
                    padding: '2px 8px', fontSize: 11,
                    background: settings.animationMode === mode ? '#4a9eff' : '#1e1e36',
                    border: '1px solid #555', borderRadius: 4,
                    color: '#fff', cursor: 'pointer',
                  }}
                >
                  {mode === 'normal' ? 'Normal' : mode === 'fast' ? 'Fast' : 'Off'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: '#aaa', minWidth: 75 }}>Tooltips:</span>
              {([true, false] as const).map((on) => (
                <button
                  key={String(on)}
                  onClick={() => setTooltips(on)}
                  style={{
                    padding: '2px 8px', fontSize: 11,
                    background: settings.tooltips === on ? '#4a9eff' : '#1e1e36',
                    border: '1px solid #555', borderRadius: 4,
                    color: '#fff', cursor: 'pointer',
                  }}
                >
                  {on ? 'On' : 'Off'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
        {/* Header with lobby code */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ marginBottom: 8 }}>Card Clash Lobby</h1>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <div style={{
              fontSize: 48, fontWeight: 'bold', letterSpacing: 12,
              fontFamily: 'monospace', color: '#4a9eff',
              userSelect: 'all', cursor: 'pointer',
            }}
              title="Click to copy"
              onClick={() => {
                navigator.clipboard.writeText(lobbyCode);
                setShowCopied(true);
                setTimeout(() => setShowCopied(false), 2000);
              }}
            >
              {lobbyCode}
              {showCopied && (
                <span style={{
                  position: 'absolute',
                  right: -60,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: 13,
                  color: '#4aff6a',
                  fontFamily: 'sans-serif',
                  letterSpacing: 0,
                  fontWeight: 'normal',
                  animation: 'copiedFade 2s ease-out forwards',
                }}>
                  Copied!
                </span>
              )}
            </div>
            <style>{`
              @keyframes copiedFade {
                0%, 50% { opacity: 1; }
                100% { opacity: 0; }
              }
            `}</style>
          </div>
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            Click code to copy &middot; Share with friends to join
          </div>
          <div style={{ fontSize: 11, color: status === 'connected' ? '#4aff6a' : '#ff6666', marginTop: 4 }}>
            {status === 'connected' ? '● Connected' : status === 'connecting' ? '◌ Connecting...' : '○ Disconnected'}
          </div>
        </div>

        {/* Game Settings (host editable, non-host read-only) */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Game Settings</h3>
          {/* Grid size */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {GRID_SIZES.map((size) => (
              <button
                key={size.id}
                onClick={() => isHost && handleConfigChange('grid_size', size.id)}
                style={{
                  flex: 1, padding: '10px 8px',
                  background: lobby.config.grid_size === size.id ? '#3a3a6e' : '#2a2a3e',
                  border: lobby.config.grid_size === size.id ? '2px solid #4a9eff' : '1px solid #444',
                  borderRadius: 8, color: '#fff',
                  cursor: isHost ? 'pointer' : 'default',
                  opacity: isHost ? 1 : 0.8,
                }}
              >
                <div style={{ fontWeight: 'bold', fontSize: 13 }}>{size.name}</div>
                <div style={{ fontSize: 11, color: '#aaa' }}>{size.players} players</div>
              </button>
            ))}
          </div>
          {/* Speed */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {SPEEDS.map((s) => (
              <button
                key={s.id}
                onClick={() => isHost && handleConfigChange('speed', s.id)}
                style={{
                  flex: 1, padding: '8px',
                  background: lobby.config.speed === s.id ? '#3a3a6e' : '#2a2a3e',
                  border: lobby.config.speed === s.id ? '2px solid #4a9eff' : '1px solid #444',
                  borderRadius: 8, color: '#fff', fontSize: 13,
                  cursor: isHost ? 'pointer' : 'default',
                  opacity: isHost ? 1 : 0.8,
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
          {/* VP Target display */}
          <div style={{
            fontSize: 13, color: '#aaa', marginBottom: 12,
            padding: '8px 12px', background: '#1e1e36',
            borderRadius: 8, border: '1px solid #333',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{ color: '#ffcc00', fontWeight: 'bold' }}>🏆</span>
            <span>VP Target: <strong style={{ color: '#fff' }}>{computeVpTarget(lobby.config.grid_size, players.length, lobby.config.speed)}</strong></span>
          </div>
          {/* Test mode (host only) */}
          {isHost && (
            <label style={{
              fontSize: 12,
              color: lobby.config.test_mode ? '#ffaa4a' : '#666',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <input
                type="checkbox"
                checked={lobby.config.test_mode}
                onChange={(e) => handleConfigChange('test_mode', e.target.checked)}
                style={{ accentColor: '#ffaa4a' }}
              />
              Test Mode
            </label>
          )}
        </div>

        {/* Players list */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Players ({players.length})</h3>
          {players.map((p) => {
            const isSelf = p.id === playerId;
            const canEditArchetype = isSelf || (isHost && (p.is_cpu || p.is_local));
            return (
              <div
                key={p.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 8, padding: '8px 12px',
                  background: isSelf ? '#2a2a4e' : '#1e1e36',
                  border: isSelf ? '1px solid #4a9eff' : '1px solid #333',
                  borderRadius: 8,
                }}
              >
                {/* Player type icon */}
                <span style={{ fontSize: 16 }}>
                  {p.is_cpu ? '🤖' : '🧑'}
                </span>

                {/* Name — editable for self and host-controlled local players */}
                {(isSelf || (isHost && p.is_local)) && !p.is_cpu ? (
                  <input
                    value={p.name}
                    maxLength={12}
                    onChange={(e) => {
                      if (isSelf) handleUpdateSelf({ name: e.target.value });
                      else if (isHost && p.is_local) handleUpdatePlayer(p.id, { name: e.target.value });
                    }}
                    style={{
                      flex: 1, padding: '6px 10px',
                      background: '#2a2a3e', border: '1px solid #444',
                      borderRadius: 6, color: '#fff', fontSize: 14,
                    }}
                  />
                ) : (
                  <span style={{ flex: 1, fontSize: 14 }}>
                    {p.name}
                    {p.is_cpu && p.cpu_difficulty && (
                      <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>
                        ({p.cpu_difficulty})
                      </span>
                    )}
                  </span>
                )}

                {/* Archetype selector */}
                {canEditArchetype ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {ARCHETYPES.map((arch) => (
                      <button
                        key={arch.id}
                        onClick={() => {
                          if (isSelf) handleUpdateSelf({ archetype: arch.id });
                          else if (isHost && (p.is_local || p.is_cpu)) handleUpdatePlayer(p.id, { archetype: arch.id });
                        }}
                        title={arch.name}
                        style={{
                          padding: '4px 8px',
                          background: p.archetype === arch.id ? '#3a3a6e' : '#2a2a3e',
                          border: p.archetype === arch.id ? '2px solid #4a9eff' : '1px solid #444',
                          borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 14,
                        }}
                      >
                        {arch.icon}
                      </button>
                    ))}
                  </div>
                ) : (
                  /* Read-only archetype badge */
                  (() => {
                    const arch = ARCHETYPES.find(a => a.id === p.archetype);
                    return arch ? (
                      <span style={{
                        padding: '4px 8px',
                        background: '#3a3a6e',
                        border: '1px solid #555',
                        borderRadius: 6, fontSize: 13, color: '#ccc',
                      }}>
                        {arch.icon} {arch.name}
                      </span>
                    ) : null;
                  })()
                )}

                {/* Badges */}
                {p.is_host && (
                  <span style={{
                    fontSize: 9, padding: '2px 6px', borderRadius: 6,
                    background: '#ffd700', color: '#000', fontWeight: 'bold',
                  }}>
                    HOST
                  </span>
                )}
                {p.is_local && (
                  <span style={{
                    fontSize: 9, padding: '2px 6px', borderRadius: 6,
                    background: '#4a9eff', color: '#fff', fontWeight: 'bold',
                  }}>
                    LOCAL
                  </span>
                )}

                {/* Remove button (host can remove non-self) */}
                {isHost && !p.is_host && (
                  <button
                    onClick={() => handleRemovePlayer(p.id)}
                    style={{
                      padding: '4px 8px', background: 'transparent',
                      border: '1px solid #555', borderRadius: 4,
                      color: '#ff6666', cursor: 'pointer', fontSize: 11,
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}

          {/* Add player buttons (host only) */}
          {isHost && players.length < 6 && (
            <div style={{ marginTop: 8 }}>
              {/* Add Local Player */}
              {!showAddLocal ? (
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <button
                    onClick={() => setShowAddLocal(true)}
                    style={{
                      flex: 1, padding: '8px', fontSize: 12,
                      background: '#2a3a4e', border: '1px solid #4a6a8e',
                      borderRadius: 6, color: '#8ab4ff', cursor: 'pointer',
                    }}
                  >
                    + Local Player
                  </button>
                </div>
              ) : (
                <div style={{
                  display: 'flex', gap: 4, marginBottom: 8,
                  padding: '8px', background: '#2a3a4e', border: '1px solid #4a6a8e', borderRadius: 6,
                  alignItems: 'center',
                }}>
                  <input
                    value={localName}
                    maxLength={12}
                    onChange={(e) => setLocalName(e.target.value)}
                    placeholder={`Player ${players.length + 1}`}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddLocal();
                      if (e.key === 'Escape') { setShowAddLocal(false); setLocalName(''); }
                    }}
                    style={{
                      flex: 1, padding: '6px 8px', fontSize: 12,
                      background: '#1a2a3e', border: '1px solid #444',
                      borderRadius: 4, color: '#fff',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 2 }}>
                    {ARCHETYPES.map((arch) => (
                      <button
                        key={arch.id}
                        onClick={() => setLocalArchetype(arch.id)}
                        title={arch.name}
                        style={{
                          padding: '3px 6px', fontSize: 13,
                          background: localArchetype === arch.id ? '#3a3a6e' : '#2a2a3e',
                          border: localArchetype === arch.id ? '1px solid #4a9eff' : '1px solid #444',
                          borderRadius: 4, color: '#fff', cursor: 'pointer',
                        }}
                      >
                        {arch.icon}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={handleAddLocal}
                    style={{
                      padding: '6px 10px', fontSize: 12,
                      background: '#4a9eff', border: 'none',
                      borderRadius: 4, color: '#fff', cursor: 'pointer',
                      fontWeight: 'bold',
                    }}
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setShowAddLocal(false); setLocalName(''); }}
                    style={{
                      padding: '6px', background: 'transparent',
                      border: 'none', color: '#888', cursor: 'pointer', fontSize: 12,
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Add CPU buttons */}
              <div style={{ display: 'flex', gap: 8 }}>
                {ARCHETYPES.map((arch) => (
                  <button
                    key={arch.id}
                    onClick={() => handleAddCpu(arch.id)}
                    title={`Add ${arch.name} CPU`}
                    style={{
                      flex: 1, padding: '8px', fontSize: 12,
                      background: '#2a2a3e', border: '1px solid #444',
                      borderRadius: 6, color: '#aaa', cursor: 'pointer',
                    }}
                  >
                    + CPU {arch.icon}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div style={{ textAlign: 'center', color: '#ff4a4a', padding: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* Countdown overlay */}
        {countdown !== null && (
          <div style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}>
            <div style={{ fontSize: 72, fontWeight: 'bold', color: '#4a9eff' }}>
              {countdown}
            </div>
            <div style={{
              width: 300, height: 8, background: '#333',
              borderRadius: 4, overflow: 'hidden', marginTop: 16,
            }}>
              <div style={{
                width: `${progressAnim * 100}%`, height: '100%',
                background: '#4a9eff', borderRadius: 4,
                transition: 'width 30ms linear',
              }} />
            </div>
            <div style={{ fontSize: 14, color: '#aaa', marginTop: 12 }}>
              Game starting...
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleLeave}
            style={{
              flex: 1, padding: 14, background: '#2a2a3e',
              border: '1px solid #555', borderRadius: 8,
              color: '#fff', fontSize: 14, cursor: 'pointer',
            }}
          >
            {isHost ? 'Close Lobby' : 'Leave Lobby'}
          </button>
          {isHost && (
            <button
              onClick={handleStart}
              disabled={players.length < 2 || starting}
              style={{
                flex: 2, padding: 14,
                background: players.length < 2 || starting ? '#333' : lobby.config.test_mode ? '#ffaa4a' : '#4a9eff',
                border: 'none', borderRadius: 8,
                color: '#fff', fontSize: 16, fontWeight: 'bold',
                cursor: players.length < 2 || starting ? 'not-allowed' : 'pointer',
              }}
            >
              {starting ? 'Starting...' : lobby.config.test_mode ? 'Start Test Game' : 'Start Game'}
            </button>
          )}
        </div>

        {/* Non-host waiting message */}
        {!isHost && (
          <div style={{ textAlign: 'center', color: '#666', fontSize: 13, marginTop: 12 }}>
            Waiting for host to start the game...
          </div>
        )}
      </div>
    </div>
  );
}


// ── Helpers ─────────────────────────────────────────────────

function computeLocalPlayerIds(lobby: LobbyState, playerId: string, isHost: boolean): string[] {
  if (!isHost) return [playerId];
  // Host controls themselves + all local players
  const ids = [playerId];
  for (const p of Object.values(lobby.players)) {
    if (p.is_local && p.id !== playerId) {
      ids.push(p.id);
    }
  }
  return ids;
}
