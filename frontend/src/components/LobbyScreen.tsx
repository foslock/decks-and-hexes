import { useState, useEffect, useCallback, useRef } from 'react';
import type { GameState, LobbyState } from '../types/game';
import { useWebSocket } from '../hooks/useWebSocket';
import { useSettings, type AnimationMode } from './SettingsContext';
import Tooltip from './Tooltip';
import * as api from '../api/client';
import { useSound } from '../audio/useSound';
import CardBrowser, { clearBrowserCollapseMemory } from './CardBrowser';

interface CardPackDef {
  id: string;
  name: string;
  neutral_card_ids: string[] | null;
  archetype_card_ids: Record<string, string[]> | null;
}

function getDailyPackId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `daily_${y}${m}${d}`;
}

const PLAYER_COLOR_OPTIONS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
];

const ARCHETYPES = [
  { id: 'vanguard', name: 'Vanguard', icon: '⚔️', desc: 'Vanguard — Aggressive, high-power claims. Excels at taking territory with brute force and punishing defenders.' },
  { id: 'swarm', name: 'Swarm', icon: '🐝', desc: 'Swarm — Wide expansion with many small claims. Strength grows from controlling adjacent tiles and spreading fast.' },
  { id: 'fortress', name: 'Fortress', icon: '🏰', desc: 'Fortress — Defensive and resilient. Specializes in holding territory with strong defenses and tile immunity.' },
];

const GRID_SIZES = [
  { id: 'small', name: 'Small', short: 'S', players: '2-3', tiles: 61, radius: 4 },
  { id: 'medium', name: 'Medium', short: 'M', players: '3-4', tiles: 91, radius: 5 },
  { id: 'large', name: 'Large', short: 'L', players: '4-6', tiles: 127, radius: 6 },
  { id: 'mega', name: 'Mega', short: 'Mg', players: '5-6', tiles: 169, radius: 7 },
  { id: 'ultra', name: 'Ultra', short: 'U', players: '6', tiles: 217, radius: 8 },
];

// Base VP targets for 2 players; subtract 1 VP per extra player
const BASE_VP: Record<string, number> = { small: 10, medium: 14, large: 18, mega: 22, ultra: 26 };

function computeRecommendedVp(gridSizeId: string, playerCount: number = 2): number {
  const base = BASE_VP[gridSizeId] ?? 10;
  return Math.max(4, base - Math.max(0, playerCount - 2));
}

const DIFFICULTIES = [
  { id: 'easy', name: 'Easy', short: 'E' },
  { id: 'medium', name: 'Normal', short: 'N' },
  { id: 'hard', name: 'Hard', short: 'H' },
];

// ── Recent seeds (localStorage) ────────────────────────────
const RECENT_SEEDS_KEY = 'cardclash_recent_seeds';
const MAX_RECENT_SEEDS = 10;

interface RecentSeed {
  seed: string;
  gridSize: string;
  date: string;
}

function getRecentSeeds(): RecentSeed[] {
  try {
    const raw = localStorage.getItem(RECENT_SEEDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function addRecentSeed(seed: string, gridSize: string) {
  const seeds = getRecentSeeds().filter(s => s.seed !== seed);
  seeds.unshift({ seed, gridSize, date: new Date().toISOString() });
  if (seeds.length > MAX_RECENT_SEEDS) seeds.length = MAX_RECENT_SEEDS;
  localStorage.setItem(RECENT_SEEDS_KEY, JSON.stringify(seeds));
}

function generateClientSeed(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

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
  const settingsRef = useRef<HTMLDivElement>(null);
  const [cardPacks, setCardPacks] = useState<CardPackDef[]>([]);
  const [showPackBrowser, setShowPackBrowser] = useState(false);
  const [showSeedHistory, setShowSeedHistory] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const seedHistoryRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 480px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 480px)');
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Close seed history dropdown on outside click
  useEffect(() => {
    if (!showSeedHistory) return;
    const handleClick = (e: MouseEvent) => {
      if (seedHistoryRef.current && !seedHistoryRef.current.contains(e.target as Node)) {
        setShowSeedHistory(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSeedHistory]);

  // Fetch card pack definitions on mount
  useEffect(() => {
    fetch(`${api.BASE}/card-packs`)
      .then(res => res.json())
      .then((data: { packs: CardPackDef[] }) => {
        setCardPacks(data.packs);
        // Auto-select today's daily pack for host if currently on default
        if (isHost && lobby.config.card_pack === 'everything') {
          const dailyId = getDailyPackId();
          if (data.packs.some(p => p.id.startsWith('daily_'))) {
            handleConfigChange('card_pack', dailyId);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsOpen]);
  const gameStartRef = useRef(false);

  // For "Add Local Player" inline form
  const [showAddLocal, setShowAddLocal] = useState(false);
  const [localName, setLocalName] = useState('');
  const [localArchetype, setLocalArchetype] = useState('swarm');

  // Color picker state
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // Close color picker on click outside
  useEffect(() => {
    if (!colorPickerFor) return;
    const handleClick = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerFor(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [colorPickerFor]);

  // Drag-and-drop reorder state (host only)
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const { lastMessage, status } = useWebSocket(lobbyCode, playerId, token);
  const sound = useSound();

  // Handle WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === 'lobby_update') {
      const lobbyData = lastMessage.lobby as unknown as LobbyState;
      setLobby(lobbyData);
      // Reset game start ref when returning to waiting state (e.g. return from game)
      if (lobbyData.status === 'waiting') {
        gameStartRef.current = false;
        setStarting(false);
        setCountdown(null);
        setCountdownStart(null);
      }
    } else if (lastMessage.type === 'countdown') {
      const secs = lastMessage.seconds_remaining as number;
      setCountdown(secs);
      if (secs === 3) setCountdownStart(Date.now());
      if (secs >= 1 && secs <= 3) sound.countdownTick();
    } else if (lastMessage.type === 'game_start') {
      sound.countdownGo();
      console.log('[Lobby] WS game_start received, gameStartRef:', gameStartRef.current);
      if (!gameStartRef.current) {
        gameStartRef.current = true;
        // Save map seed to recent seeds
        if (lobby.config.map_seed) {
          addRecentSeed(lobby.config.map_seed, lobby.config.grid_size);
        }
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

  // Use explicit player_order for rendering if available, else dict key order
  const orderedPlayerIds = lobby.player_order?.length
    ? lobby.player_order.filter(pid => pid in lobby.players)
    : Object.keys(lobby.players);
  const players = orderedPlayerIds.map(pid => lobby.players[pid]).filter(Boolean);

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
    if (updates.archetype) clearBrowserCollapseMemory();
    try {
      setError(null);
      await api.updateLobbyPlayer(lobbyCode, playerId, token, updates);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, playerId, token]);

  // Host edits local or CPU player (uses host's token)
  const handleUpdatePlayer = useCallback(async (targetId: string, updates: { name?: string; archetype?: string; difficulty?: string }) => {
    try {
      setError(null);
      await api.updateLobbyPlayer(lobbyCode, targetId, token, updates);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, token]);

  const handleChangeColor = useCallback(async (targetId: string, color: string) => {
    try {
      setError(null);
      const isSelf = targetId === playerId;
      if (isSelf) {
        await api.updateLobbyPlayer(lobbyCode, targetId, token, { color });
      } else if (isHost) {
        await api.updateLobbyPlayer(lobbyCode, targetId, token, { color });
      }
      setColorPickerFor(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, playerId, token, isHost]);

  const handleReorder = useCallback(async (fromIdx: number, toIdx: number) => {
    // Use player_order from lobby state, falling back to Object.keys
    const currentOrder = lobby.player_order?.length
      ? [...lobby.player_order]
      : Object.keys(lobby.players);
    const [moved] = currentOrder.splice(fromIdx, 1);
    currentOrder.splice(toIdx, 0, moved);
    try {
      setError(null);
      await api.reorderLobbyPlayers(lobbyCode, token, currentOrder);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [lobbyCode, token, lobby]);

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
    <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100dvh' }}>
      {/* Settings gear — top right */}
      <div ref={settingsRef} style={{ position: 'fixed', top: 16, right: 16, zIndex: 100 }}>
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
              cursor: 'pointer',
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
              @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
              }
              .diff-short { display: none; }
              @media (max-width: 480px) {
                .diff-full { display: none; }
                .diff-short { display: inline; }
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

        {/* Players list */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Players ({players.length})</h3>
          {players.map((p, playerIdx) => {
            const isSelf = p.id === playerId;
            const canEditArchetype = isSelf || (isHost && (p.is_cpu || p.is_local));
            const canEditColor = isSelf || (isHost && (p.is_cpu || p.is_local));
            const playerColor = p.color || '#888';
            const usedColors = new Set(players.map(pl => pl.color));
            const isDragging = dragIdx === playerIdx;
            const isDragOver = dragOverIdx === playerIdx;
            return (
              <div
                key={p.id}
                draggable={isHost && players.length > 1}
                onDragStart={(e) => {
                  if (!isHost) return;
                  setDragIdx(playerIdx);
                  e.dataTransfer.effectAllowed = 'move';
                  if (e.currentTarget instanceof HTMLElement) {
                    e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
                  }
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  setDragOverIdx(null);
                }}
                onDragOver={(e) => {
                  if (!isHost || dragIdx === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverIdx(playerIdx);
                }}
                onDragLeave={() => {
                  if (dragOverIdx === playerIdx) setDragOverIdx(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIdx !== null && dragIdx !== playerIdx) {
                    handleReorder(dragIdx, playerIdx);
                  }
                  setDragIdx(null);
                  setDragOverIdx(null);
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 8, padding: '8px 12px',
                  background: isSelf ? '#2a2a4e' : '#1e1e36',
                  border: isDragOver && dragIdx !== playerIdx
                    ? '2px solid #4a9eff'
                    : isSelf ? '1px solid #4a9eff' : '1px solid #333',
                  borderRadius: 8,
                  opacity: isDragging ? 0.4 : 1,
                  cursor: isHost && players.length > 1 ? 'grab' : 'default',
                  transition: 'border 0.15s ease, opacity 0.15s ease',
                }}
              >
                {isHost && players.length > 1 && (
                  <span style={{
                    color: '#555', fontSize: 14, cursor: 'grab',
                    flexShrink: 0, userSelect: 'none', lineHeight: 1,
                  }}>
                    ⠿
                  </span>
                )}
                <span style={{ position: 'relative', flexShrink: 0 }}>
                  <span
                    onClick={canEditColor ? () => setColorPickerFor(colorPickerFor === p.id ? null : p.id) : undefined}
                    style={{
                      display: 'inline-block',
                      width: 16, height: 16, borderRadius: '50%',
                      background: playerColor,
                      border: '2px solid rgba(255,255,255,0.3)',
                      cursor: canEditColor ? 'pointer' : 'default',
                      transition: 'transform 0.15s ease',
                      transform: colorPickerFor === p.id ? 'scale(1.2)' : undefined,
                    }}
                    title={canEditColor ? 'Change color' : undefined}
                  />
                  {colorPickerFor === p.id && (
                    <div
                      ref={colorPickerRef}
                      style={{
                        position: 'absolute',
                        top: 24, left: -4,
                        background: '#2a2a3e', border: '1px solid #555',
                        borderRadius: 8, padding: 8,
                        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 6, zIndex: 200,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                      }}
                    >
                      {PLAYER_COLOR_OPTIONS.map((c) => {
                        const taken = usedColors.has(c) && c !== p.color;
                        return (
                          <span
                            key={c}
                            onClick={taken ? undefined : () => handleChangeColor(p.id, c)}
                            style={{
                              position: 'relative',
                              width: 24, height: 24, borderRadius: '50%',
                              background: c,
                              border: c === p.color ? '2px solid #fff' : '2px solid transparent',
                              cursor: taken ? 'not-allowed' : 'pointer',
                              opacity: taken ? 0.25 : 1,
                              transition: 'transform 0.1s ease',
                              overflow: 'hidden',
                            }}
                            onMouseEnter={(e) => { if (!taken) (e.target as HTMLElement).style.transform = 'scale(1.2)'; }}
                            onMouseLeave={(e) => { (e.target as HTMLElement).style.transform = ''; }}
                          >
                            {taken && (
                              <svg viewBox="0 0 24 24" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                                <line x1="5" y1="5" x2="19" y2="19" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
                                <line x1="19" y1="5" x2="5" y2="19" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
                              </svg>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </span>
                {(isSelf || (isHost && p.is_local)) && !p.is_cpu ? (
                  <input
                    value={p.name}
                    maxLength={12}
                    onChange={(e) => {
                      if (isSelf) handleUpdateSelf({ name: e.target.value });
                      else if (isHost && p.is_local) handleUpdatePlayer(p.id, { name: e.target.value });
                    }}
                    style={{
                      flex: 1, minWidth: 0, padding: '6px 10px',
                      background: '#2a2a3e', border: '1px solid #444',
                      borderRadius: 6, color: '#fff', fontSize: 14,
                    }}
                  />
                ) : (
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                    {p.is_cpu && p.cpu_difficulty && !isHost && (
                      <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>
                        ({p.cpu_difficulty})
                      </span>
                    )}
                  </span>
                )}
                {p.is_cpu && isHost && (
                  <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                    {DIFFICULTIES.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => handleUpdatePlayer(p.id, { difficulty: d.id })}
                        style={{
                          padding: '2px 6px', fontSize: 10,
                          background: p.cpu_difficulty === d.id ? '#3a3a6e' : '#2a2a3e',
                          border: p.cpu_difficulty === d.id ? '1px solid #4a9eff' : '1px solid #444',
                          borderRadius: 4, color: p.cpu_difficulty === d.id ? '#fff' : '#888',
                          cursor: 'pointer',
                        }}
                      >
                        <span className="diff-full">{d.name}</span>
                        <span className="diff-short">{d.short}</span>
                      </button>
                    ))}
                  </div>
                )}
                {canEditArchetype ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {ARCHETYPES.map((arch) => (
                      <Tooltip key={arch.id} content={arch.desc}>
                        <button
                          onClick={() => {
                            if (isSelf) handleUpdateSelf({ archetype: arch.id });
                            else if (isHost && (p.is_local || p.is_cpu)) handleUpdatePlayer(p.id, { archetype: arch.id });
                          }}
                          style={{
                            padding: '4px 8px',
                            background: p.archetype === arch.id ? '#3a3a6e' : '#2a2a3e',
                            border: p.archetype === arch.id ? '2px solid #4a9eff' : '1px solid #444',
                            borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 14,
                          }}
                        >
                          {arch.icon}
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                ) : (
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
                {!p.has_returned && !p.is_cpu && (
                  <span style={{
                    fontSize: 9, padding: '2px 6px', borderRadius: 6,
                    background: '#555', color: '#ffaa4a', fontWeight: 'bold',
                    animation: 'pulse 2s ease-in-out infinite',
                  }}>
                    WAITING
                  </span>
                )}
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
          {isHost && players.length < 6 && (
            <div style={{ marginTop: 8 }}>
              {lobby.config.test_mode && (!showAddLocal ? (
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
              ))}
              <button
                onClick={() => handleAddCpu('vanguard')}
                style={{
                  width: '100%', padding: '8px', fontSize: 12,
                  background: '#2a2a3e', border: '1px solid #444',
                  borderRadius: 6, color: '#aaa', cursor: 'pointer',
                }}
              >
                + CPU Player
              </button>
            </div>
          )}
        </div>

        {/* Game Settings (host editable, non-host read-only) */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Game Settings</h3>
          {/* Settings rows — consistent style */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 1,
            background: '#333', borderRadius: 8,
          }}>
            {/* Card Pack */}
            <div style={{
              fontSize: 13, color: '#aaa',
              padding: '8px 12px', background: '#1e1e36',
              display: 'flex', alignItems: 'center', gap: 8,
              borderRadius: '8px 8px 0 0',
            }}>
              <div style={{ width: 90, flexShrink: 0 }}>
                <Tooltip content={(lobby.config.card_pack || '').startsWith('daily_')
                  ? "This pack changes every day — a fresh selection of 10 neutral market cards generated from today's date."
                  : "Decides which cards will be available in the game."}>
                  <span style={{ color: '#888', fontSize: 13, fontWeight: 'bold', cursor: 'help' }}>Card Pack</span>
                </Tooltip>
              </div>
              {isHost && cardPacks.length > 0 ? (
                <select
                  value={(lobby.config.card_pack || 'everything').startsWith('daily_') ? 'daily' : (lobby.config.card_pack || 'everything')}
                  onChange={(e) => {
                    const val = e.target.value;
                    handleConfigChange('card_pack', val === 'daily' ? getDailyPackId() : val);
                  }}
                  style={{
                    background: '#2a2a3e', color: '#fff', border: '1px solid #555',
                    borderRadius: 4, padding: '0 8px', height: 26, fontSize: 13, cursor: 'pointer',
                  }}
                >
                  {cardPacks.map(p => {
                    // Collapse all daily_* packs into a single "daily" option
                    if (p.id.startsWith('daily_')) {
                      return <option key="daily" value="daily">{p.name}</option>;
                    }
                    return <option key={p.id} value={p.id}>{p.name}</option>;
                  })}
                </select>
              ) : (
                <strong style={{ color: '#fff' }}>
                  {cardPacks.find(p => p.id === (lobby.config.card_pack || 'everything') || (p.id.startsWith('daily_') && (lobby.config.card_pack || '').startsWith('daily_')))?.name || lobby.config.card_pack || 'Everything'}
                </strong>
              )}
              <button
                onClick={() => setShowPackBrowser(true)}
                style={{
                  fontSize: 13, padding: '0 8px', height: 26,
                  background: '#2a2a3e', border: '1px solid #555',
                  borderRadius: 4, color: '#aaa', cursor: 'pointer',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flexShrink: 1, minWidth: 0,
                }}
              >
                Cards
              </button>
            </div>

            {/* Map Size */}
            <div style={{
              fontSize: 13, color: '#aaa',
              padding: '8px 12px', background: '#1e1e36',
              display: 'flex', alignItems: 'center', gap: 8,
              borderRadius: '0 0 8px 8px',
            }}>
              <div style={{ width: 90, flexShrink: 0 }}>
                <Tooltip content="The size of the hex grid.">
                  <span style={{ color: '#888', fontSize: 13, fontWeight: 'bold', cursor: 'help' }}>Map Size</span>
                </Tooltip>
              </div>
              <div style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0 }}>
                {GRID_SIZES.map((size) => (
                  <Tooltip key={size.id} content={`${size.name}: ${size.tiles} tiles, ${size.players} players`}
                    wrapperStyle={{ display: 'block', flex: '1 1 0', minWidth: 0 }}>
                    <button
                      onClick={() => isHost && handleConfigChange('grid_size', size.id)}
                      style={{
                        padding: '0 4px', height: 26, width: '100%',
                        fontSize: 13,
                        background: lobby.config.grid_size === size.id ? '#4a9eff' : '#2a2a3e',
                        border: '1px solid #555',
                        borderRadius: 4,
                        color: '#fff',
                        cursor: isHost ? 'pointer' : 'default',
                        fontWeight: lobby.config.grid_size === size.id ? 'bold' : 'normal',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {isNarrow ? size.short : size.name}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* VP Target */}
            <div style={{
              fontSize: 13, color: '#aaa',
              padding: '8px 12px', background: '#1e1e36',
              display: 'flex', alignItems: 'center', gap: 8,
              borderRadius: '0 0 8px 8px',
            }}>
              <div style={{ width: 90, flexShrink: 0 }}>
                <Tooltip content="The number of Victory Points a player needs to win.">
                  <span style={{ color: '#888', fontSize: 13, fontWeight: 'bold', cursor: 'help' }}>VP Target</span>
                </Tooltip>
              </div>
              {isHost ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={1}
                    value={lobby.config.vp_target ?? computeRecommendedVp(lobby.config.grid_size, players.length)}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val > 0) {
                        handleConfigChange('vp_target', val);
                      }
                    }}
                    style={{
                      width: 52, padding: '0 6px', height: 26,
                      background: '#2a2a3e', border: '1px solid #555',
                      borderRadius: 4, color: '#fff', fontSize: 13,
                      fontWeight: 'bold', textAlign: 'center',
                    }}
                  />
                  {lobby.config.vp_target !== null && lobby.config.vp_target !== computeRecommendedVp(lobby.config.grid_size, players.length) && (
                    <button
                      onClick={() => handleConfigChange('vp_target', computeRecommendedVp(lobby.config.grid_size, players.length))}
                      style={{
                        fontSize: 13, padding: '0 8px', height: 26,
                        background: '#2a2a3e', border: '1px solid #555',
                        borderRadius: 4, color: '#888', cursor: 'pointer',
                      }}
                    >
                      Reset ({computeRecommendedVp(lobby.config.grid_size, players.length)})
                    </button>
                  )}
                </div>
              ) : (
                <strong style={{ color: '#fff' }}>
                  {lobby.config.vp_target ?? computeRecommendedVp(lobby.config.grid_size, players.length)}
                </strong>
              )}
            </div>

          </div>

          {/* Advanced settings (collapsible) */}
          <button
            onClick={() => setShowAdvanced(prev => !prev)}
            style={{
              width: '100%', padding: '8px 12px', marginTop: 8,
              background: '#1e1e36', border: '1px solid #333',
              borderRadius: showAdvanced ? '8px 8px 0 0' : 8,
              color: '#888', fontSize: 13, fontWeight: 'bold',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              textAlign: 'left',
            }}
          >
            <span style={{ transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
            Advanced
          </button>
          {showAdvanced && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 1,
            background: '#333', borderRadius: '0 0 8px 8px',
          }}>
            {/* Map Seed */}
            <div ref={seedHistoryRef} style={{
              fontSize: 13, color: '#aaa',
              padding: '8px 12px', background: '#1e1e36',
              display: 'flex', alignItems: 'center', gap: 8,
              position: 'relative',
            }}>
              <div style={{ width: 90, flexShrink: 0 }}>
                <Tooltip content="Determines the layout of the grid.">
                  <span style={{ color: '#888', fontSize: 13, fontWeight: 'bold', cursor: 'help' }}>Map Seed</span>
                </Tooltip>
              </div>
              {isHost ? (
                <>
                  <input
                    type="text"
                    value={lobby.config.map_seed || ''}
                    onChange={(e) => {
                      const val = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
                      if (val.length === 6) handleConfigChange('map_seed', val);
                    }}
                    onBlur={(e) => {
                      const val = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '');
                      if (val.length !== 6) {
                        e.target.value = lobby.config.map_seed || '';
                      }
                    }}
                    maxLength={6}
                    style={{
                      width: 72, padding: '0 6px', height: 26,
                      background: '#2a2a3e', border: '1px solid #555',
                      borderRadius: 4, color: '#fff', fontSize: 13,
                      fontWeight: 'bold', textAlign: 'center',
                      fontFamily: 'monospace', letterSpacing: 1,
                    }}
                  />
                  <button
                    onClick={() => handleConfigChange('map_seed', generateClientSeed())}
                    title="Random seed"
                    style={{
                      fontSize: 14, padding: '0 6px', height: 26,
                      background: '#2a2a3e', border: '1px solid #555',
                      borderRadius: 4, cursor: 'pointer', lineHeight: 1,
                    }}
                  >
                    🎲
                  </button>
                  {getRecentSeeds().length > 0 && (
                    <button
                      onClick={() => setShowSeedHistory(p => !p)}
                      title="Recent seeds"
                      style={{
                        fontSize: 13, padding: '0 8px', height: 26,
                        background: showSeedHistory ? '#3a3a6e' : '#2a2a3e',
                        border: '1px solid #555',
                        borderRadius: 4, color: '#aaa', cursor: 'pointer',
                      }}
                    >
                      History ▾
                    </button>
                  )}
                  {showSeedHistory && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 80, zIndex: 100,
                      background: '#1a1a2e', border: '1px solid #555', borderRadius: 6,
                      padding: 4, minWidth: 200, marginTop: 4,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    }}>
                      {getRecentSeeds().map((s, i) => (
                        <div
                          key={i}
                          onClick={() => {
                            handleConfigChange('map_seed', s.seed);
                            handleConfigChange('grid_size', s.gridSize);
                            setShowSeedHistory(false);
                          }}
                          style={{
                            padding: '4px 8px', cursor: 'pointer', borderRadius: 4,
                            display: 'flex', justifyContent: 'space-between', gap: 12,
                            fontSize: 12,
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#2a2a4e')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <span style={{ fontFamily: 'monospace', color: '#fff', fontWeight: 'bold' }}>{s.seed}</span>
                          <span style={{ color: '#666' }}>{s.gridSize} · {formatRelativeDate(s.date)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <span style={{ fontFamily: 'monospace', color: '#fff', fontWeight: 'bold', letterSpacing: 1 }}>
                  {lobby.config.map_seed || '------'}
                </span>
              )}
            </div>

            {/* Round Limit */}
            <div style={{
              fontSize: 13, color: '#aaa',
              padding: '8px 12px', background: '#1e1e36',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span>⏱ Round Limit:</span>
              {isHost ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={5}
                    value={lobby.config.max_rounds ?? 20}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 5) {
                        handleConfigChange('max_rounds', val);
                      }
                    }}
                    style={{
                      width: 52, padding: '0 6px', height: 26,
                      background: '#2a2a3e', border: '1px solid #555',
                      borderRadius: 4, color: '#fff', fontSize: 13,
                      fontWeight: 'bold', textAlign: 'center',
                    }}
                  />
                  {lobby.config.max_rounds !== 20 && (
                    <button
                      onClick={() => handleConfigChange('max_rounds', 20)}
                      style={{
                        fontSize: 13, padding: '0 8px', height: 26,
                        background: '#2a2a3e', border: '1px solid #555',
                        borderRadius: 4, color: '#888', cursor: 'pointer',
                      }}
                    >
                      Reset (20)
                    </button>
                  )}
                  <span style={{ fontSize: 11, color: '#666' }}>(recommended: 20)</span>
                </div>
              ) : (
                <strong style={{ color: '#fff' }}>
                  {lobby.config.max_rounds ?? 20}
                </strong>
              )}
            </div>

            {/* Actions */}
            <div style={{
              fontSize: 13, color: '#aaa',
              padding: '8px 12px', background: '#1e1e36',
              display: 'flex', alignItems: 'center', gap: 8,
              borderRadius: !isHost ? '0 0 8px 8px' : undefined,
            }}>
              <div style={{ width: 90, flexShrink: 0 }}>
                <Tooltip content="The number of actions each player starts their round with.">
                  <span style={{ color: '#888', fontSize: 13, fontWeight: 'bold', cursor: 'help' }}>Actions</span>
                </Tooltip>
              </div>
              {isHost ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={lobby.config.granted_actions ?? 5}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 1 && val <= 10) {
                        handleConfigChange('granted_actions', val);
                      }
                    }}
                    style={{
                      width: 52, padding: '0 6px', height: 26,
                      background: '#2a2a3e', border: '1px solid #555',
                      borderRadius: 4, color: '#fff', fontSize: 13,
                      fontWeight: 'bold', textAlign: 'center',
                    }}
                  />
                  {lobby.config.granted_actions !== null && lobby.config.granted_actions !== 5 && (
                    <button
                      onClick={() => handleConfigChange('granted_actions', 5)}
                      style={{
                        fontSize: 13, padding: '0 8px', height: 26,
                        background: '#2a2a3e', border: '1px solid #555',
                        borderRadius: 4, color: '#888', cursor: 'pointer',
                      }}
                    >
                      Reset (5)
                    </button>
                  )}
                </div>
              ) : (
                <strong style={{ color: '#fff' }}>
                  {lobby.config.granted_actions ?? 5}
                </strong>
              )}
            </div>

            {/* Test Mode (host only) */}
            {isHost && (
              <div style={{
                fontSize: 13, color: '#aaa',
                padding: '8px 12px', background: '#1e1e36',
                display: 'flex', alignItems: 'center', gap: 8,
                borderRadius: '0 0 8px 8px',
              }}>
                <div style={{ width: 90, flexShrink: 0 }}>
                  <Tooltip content="Enables game-breaking settings for testing.">
                    <span style={{ color: lobby.config.test_mode ? '#ffaa4a' : '#888', fontSize: 13, fontWeight: 'bold', cursor: 'help' }}>Test Mode</span>
                  </Tooltip>
                </div>
                {([false, true] as const).map((on) => (
                  <button
                    key={String(on)}
                    onClick={() => handleConfigChange('test_mode', on)}
                    style={{
                      padding: '0 8px', height: 26,
                      fontSize: 13,
                      background: lobby.config.test_mode === on ? (on ? '#ffaa4a' : '#4a9eff') : '#2a2a3e',
                      border: '1px solid #555',
                      borderRadius: 4,
                      color: lobby.config.test_mode === on ? (on ? '#000' : '#fff') : '#fff',
                      cursor: 'pointer',
                      fontWeight: lobby.config.test_mode === on ? 'bold' : 'normal',
                    }}
                  >
                    {on ? 'On' : 'Off'}
                  </button>
                ))}
              </div>
            )}
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
          {isHost && (() => {
            const waitingForReturn = players.some(p => !p.is_cpu && !p.has_returned);
            const cantStart = players.length < 2 || starting || waitingForReturn;
            return (
              <button
                onClick={handleStart}
                disabled={cantStart}
                title={waitingForReturn ? 'Waiting for all players to return' : undefined}
                style={{
                  flex: 2, padding: 14,
                  background: cantStart ? '#333' : lobby.config.test_mode ? '#ffaa4a' : '#4a9eff',
                  border: 'none', borderRadius: 8,
                  color: '#fff', fontSize: 16, fontWeight: 'bold',
                  cursor: cantStart ? 'not-allowed' : 'pointer',
                }}
              >
                {starting ? 'Starting...' : waitingForReturn ? 'Waiting for Players...' : lobby.config.test_mode ? 'Start Test Game' : 'Start Game'}
              </button>
            );
          })()}
        </div>

        {/* Non-host waiting message */}
        {!isHost && (
          <div style={{ textAlign: 'center', color: '#666', fontSize: 13, marginTop: 12 }}>
            Waiting for host to start the game...
          </div>
        )}
      </div>
      {showPackBrowser && (() => {
        const packId = lobby.config.card_pack || 'everything';
        const pack = cardPacks.find(p => p.id === packId)
          || (packId.startsWith('daily_') ? cardPacks.find(p => p.id.startsWith('daily_')) : undefined);
        return (
          <CardBrowser
            onClose={() => setShowPackBrowser(false)}
            packNeutralIds={pack?.neutral_card_ids}
            packArchetypeIds={pack?.archetype_card_ids}
            packName={pack?.name}
            playerArchetype={lobby.players[playerId]?.archetype}
          />
        );
      })()}
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
