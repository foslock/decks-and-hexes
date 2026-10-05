import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import type { GameState, LobbyState } from '../types/game';
import { useWebSocket } from '../hooks/useWebSocket';
import LocalSettingsMenu from './LocalSettingsMenu';
import { soundEngine } from '../audio/SoundEngine';
import Tooltip from './Tooltip';
import * as api from '../api/client';
import { useSound } from '../audio/useSound';
import CardBrowser, { clearBrowserCollapseMemory } from './CardBrowser';
import { savePlayerName } from '../utils/playerName';
import Icon from '../icons/Icon';

interface CardPackDef {
  id: string;
  name: string;
  /** One-line, player-facing summary of the pack (from the backend). */
  description?: string;
  shared_card_ids: string[] | null;
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
  { id: 'vanguard', name: 'Vanguard', emblem: '/assets/howtoplay/vanguard.webp', desc: 'Vanguard — Aggressive, high-power claims. Excels at taking territory with brute force and punishing defenders.' },
  { id: 'swarm', name: 'Swarm', emblem: '/assets/howtoplay/swarm.webp', desc: 'Swarm — Wide expansion with many small claims. Strength grows from controlling adjacent tiles and spreading fast.' },
  { id: 'fortress', name: 'Fortress', emblem: '/assets/howtoplay/fortress.webp', desc: 'Fortress — Defensive and resilient. Specializes in holding territory with strong defenses and tile immunity.' },
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
  {
    id: 'easy',
    name: 'Easy',
    short: 'E',
    desc: 'Plays casually and often misses VP opportunities. Good for learning the game.',
  },
  {
    id: 'medium',
    name: 'Normal',
    short: 'N',
    desc: 'Pursues VP cards and contests VP hexes later in the game. A fair match if you play reasonably well.',
  },
  {
    id: 'hard',
    name: 'Hard',
    short: 'H',
    desc: 'Actively hunts VP cards, saves resources for big buys, and double-downs on contested VP hexes. Requires near-optimal play to beat.',
  },
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
  onGameStart: (gameId: string, state: GameState) => void;
  onLeave: () => void;
  onTokenRefresh?: (newToken: string) => void;
}

export default function LobbyScreen({
  lobbyCode, playerId, token, isHost, initialLobby, onGameStart, onLeave, onTokenRefresh,
}: LobbyScreenProps) {
  const [lobby, setLobby] = useState<LobbyState>(initialLobby);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [countdownStart, setCountdownStart] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [showCopied, setShowCopied] = useState(false);
  const [cardPacks, setCardPacks] = useState<CardPackDef[]>([]);
  const selectedPackId = lobby.config.card_pack || 'everything';
  const selectedPackDescription = cardPacks.find(p =>
    p.id === selectedPackId || (p.id.startsWith('daily_') && selectedPackId.startsWith('daily_')),
  )?.description;
  const [showPackBrowser, setShowPackBrowser] = useState(false);
  const [showSeedHistory, setShowSeedHistory] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const seedHistoryRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 480px)').matches);

  // Local name state for responsive typing — debounces API calls
  const selfPlayer = lobby.players[playerId];
  /** Seats the host has opened (bots included), 2–6. */
  const seatLimit = Math.max(2, Math.min(6, lobby.config.max_players ?? 6));
  const [localName, setLocalName] = useState(selfPlayer?.name ?? '');
  const localNameRef = useRef(localName);
  localNameRef.current = localName;
  const nameDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  /** The name the server last accepted (to restore after a rejected one). */
  const serverNameRef = useRef(selfPlayer?.name ?? '');
  serverNameRef.current = selfPlayer?.name ?? serverNameRef.current;
  // Sync from server when name changes externally (e.g. another tab)
  useEffect(() => {
    if (selfPlayer && selfPlayer.name !== localNameRef.current) {
      // Only sync if we don't have a pending debounce (user isn't actively typing)
      if (!nameDebounceRef.current) {
        setLocalName(selfPlayer.name);
      }
    }
  }, [selfPlayer?.name]);
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

  const gameStartRef = useRef(false);

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

  const { lastMessage, status } = useWebSocket(lobbyCode, playerId, token, onTokenRefresh);
  const sound = useSound();

  // The music starts in the lobby, and falls silent for the countdown (the
  // game starts it over).
  useEffect(() => { soundEngine.setMusicActive(true); }, []);
  const counting = countdown !== null;
  useEffect(() => { soundEngine.holdMusic(counting); }, [counting]);
  useEffect(() => () => { if (!gameStartRef.current) soundEngine.holdMusic(false); }, []);

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
        console.log('[Lobby] calling onGameStart with gameId:', lastMessage.game_id);
        // Defer the heavy lobby→game navigation by a frame so the audio
        // scheduler call above settles before React unmounts this screen and
        // mounts the (expensive) GameScreen — otherwise the production build's
        // longer mount time can preempt the still-queuing chime.
        const gameId = lastMessage.game_id as string;
        const state = lastMessage.state as unknown as GameState;
        setTimeout(() => onGameStart(gameId, state), 80);
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
        console.log('[Lobby] handleStart: calling onGameStart (HTTP path)');
        onGameStart(result.game_id, result.state);
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
      if (updates.name !== undefined) {
        savePlayerName(updates.name);
        setNameError(null);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (updates.name !== undefined) {
        // Rejected name: say so under the seat; once the field is left, put
        // the last accepted name back.
        setNameError(msg);
        if (document.activeElement !== nameInputRef.current) {
          setLocalName(serverNameRef.current);
          setTimeout(() => setNameError(null), 4000);
        }
      } else {
        setError(msg);
      }
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

  const statusClass = status === 'connected' ? 'is-connected' : status === 'connecting' ? 'is-connecting' : 'is-disconnected';
  const cardPackLabel = (lobby.config.card_pack || '').startsWith('daily_')
    ? "This pack changes every day — a fresh selection of 10 shared market cards generated from today's date."
    : "Decides which cards will be available in the game.";

  return (
    <div className="cc-scr-backdrop cc-scr-lobby">
      {/* Settings gear — top right */}
      <LocalSettingsMenu />

      <div className="cc-scr-lobby-inner">
        {/* Header with lobby code */}
        <header className="cc-scr-lobby-header cc-rise-in">
          <div className="cc-scr-eyebrow">Card Clash</div>
          <h1 className="cc-title cc-scr-lobby-title">Lobby</h1>
          <div className="cc-scr-joincode-wrap">
            <div className="cc-scr-joincode-label">Join Code</div>
            <div
              className="cc-scr-joincode"
              title="Click to copy"
              onClick={() => {
                navigator.clipboard.writeText(lobbyCode);
                setShowCopied(true);
                setTimeout(() => setShowCopied(false), 2000);
              }}
            >
              {lobbyCode.split('').map((ch, i) => (
                <span key={i} className="cc-scr-code-char">{ch}</span>
              ))}
              {showCopied && (
                <span className="cc-scr-copied">Copied!</span>
              )}
            </div>
            <div className="cc-scr-joincode-hint">
              Click code to copy &middot; Share with friends to join
            </div>
            <div className={`cc-scr-status ${statusClass}`}>
              {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Disconnected'}
            </div>
          </div>
        </header>

        {/* Players list */}
        <section className="cc-panel cc-scr-section" style={{ animationDelay: '60ms' }}>
          <div className="cc-scr-section-head">
            <h3 className="cc-scr-section-title">Players ({players.length})</h3>
            <span className="cc-scr-section-meta">{players.length} / {seatLimit} seats</span>
          </div>
          {players.map((p, playerIdx) => {
            const isSelf = p.id === playerId;
            const canEditArchetype = isSelf || (isHost && p.is_cpu);
            const canEditColor = isSelf || (isHost && p.is_cpu);
            const playerColor = p.color || '#888';
            const usedColors = new Set(players.map(pl => pl.color));
            const isDragging = dragIdx === playerIdx;
            const isDragOver = dragOverIdx === playerIdx;
            const draggable = isHost && players.length > 1;
            const seatClass = [
              'cc-scr-seat',
              isSelf ? 'is-self' : '',
              draggable ? 'is-draggable' : '',
              isDragging ? 'is-dragging' : '',
              isDragOver && dragIdx !== playerIdx ? 'is-dragover' : '',
              colorPickerFor === p.id ? 'has-popover' : '',
            ].filter(Boolean).join(' ');
            return (
              <Fragment key={p.id}>
              <div
                draggable={draggable}
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
                className={seatClass}
                style={{ ['--seat-color' as string]: playerColor, animationDelay: `${80 + playerIdx * 50}ms` }}
              >
                <div className="cc-scr-seat-main">
                  {draggable && (
                    <span className="cc-scr-seat-handle"><Icon name="grip" size={12} decorative /></span>
                  )}
                  <span className="cc-scr-seat-num">{playerIdx + 1}</span>
                  <span style={{ position: 'relative', flexShrink: 0, display: 'inline-flex' }}>
                    <span
                      onClick={canEditColor ? () => setColorPickerFor(colorPickerFor === p.id ? null : p.id) : undefined}
                      className={`cc-scr-color-chip${canEditColor ? ' is-editable' : ''}${colorPickerFor === p.id ? ' is-open' : ''}`}
                      title={canEditColor ? 'Change color' : undefined}
                    />
                    {colorPickerFor === p.id && (
                      <div ref={colorPickerRef} className="cc-panel cc-scr-color-pop">
                        {PLAYER_COLOR_OPTIONS.map((c) => {
                          const taken = usedColors.has(c) && c !== p.color;
                          return (
                            <span
                              key={c}
                              onClick={taken ? undefined : () => handleChangeColor(p.id, c)}
                              className={`cc-scr-swatch${c === p.color ? ' is-current' : ''}${taken ? ' is-taken' : ''}`}
                              style={{ background: c }}
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
                  {isSelf && !p.is_cpu ? (
                    <input
                      ref={nameInputRef}
                      className={`cc-scr-input cc-scr-seat-name-input${nameError ? ' is-invalid' : ''}`}
                      aria-invalid={!!nameError}
                      value={localName}
                      maxLength={12}
                      onChange={(e) => {
                        const val = e.target.value;
                        setLocalName(val);
                        if (nameDebounceRef.current) clearTimeout(nameDebounceRef.current);
                        nameDebounceRef.current = setTimeout(() => {
                          nameDebounceRef.current = null;
                          handleUpdateSelf({ name: val });
                        }, 300);
                      }}
                      onBlur={() => {
                        // Flush immediately on blur so the name is saved when clicking away
                        if (nameDebounceRef.current) {
                          clearTimeout(nameDebounceRef.current);
                          nameDebounceRef.current = null;
                          handleUpdateSelf({ name: localNameRef.current });
                        } else if (nameError) {
                          // Leaving a rejected name: restore the accepted one.
                          setLocalName(serverNameRef.current);
                          setTimeout(() => setNameError(null), 4000);
                        }
                      }}
                    />
                  ) : (
                    <span className="cc-scr-seat-name">
                      {p.name}
                      {p.is_cpu && p.cpu_difficulty && !isHost && (
                        <span className="cc-scr-seat-sub">
                          ({p.cpu_difficulty})
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="cc-scr-seat-controls">
                  {p.is_cpu && isHost && (
                    <>
                      {/* Wide screens: a segmented control. Phones: a small
                          dropdown, so a bot's seat fits on one line. */}
                      <div className="cc-scr-seg cc-scr-seg-sm cc-scr-diff-seg" style={{ flexShrink: 0 }}>
                        {DIFFICULTIES.map((d) => (
                          <Tooltip key={d.id} content={d.desc} wrapperStyle={{ display: 'flex' }}>
                            <button
                              onClick={() => handleUpdatePlayer(p.id, { difficulty: d.id })}
                              className={`cc-scr-seg-btn${p.cpu_difficulty === d.id ? ' is-active' : ''}`}
                            >
                              {d.name}
                            </button>
                          </Tooltip>
                        ))}
                      </div>
                      <select
                        className="cc-scr-select cc-scr-diff-select"
                        value={p.cpu_difficulty ?? 'medium'}
                        onChange={(e) => handleUpdatePlayer(p.id, { difficulty: e.target.value })}
                        aria-label={`${p.name} difficulty`}
                        title={DIFFICULTIES.find(d => d.id === p.cpu_difficulty)?.desc}
                      >
                        {DIFFICULTIES.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </>
                  )}
                  {canEditArchetype ? (
                    <div className="cc-scr-arch-pick">
                      {ARCHETYPES.map((arch) => (
                        <Tooltip key={arch.id} content={arch.desc} wrapperStyle={{ display: 'flex' }}>
                          <button
                            onClick={() => {
                              if (isSelf) handleUpdateSelf({ archetype: arch.id });
                              else if (isHost && p.is_cpu) handleUpdatePlayer(p.id, { archetype: arch.id });
                            }}
                            className={`cc-scr-arch-btn${p.archetype === arch.id ? ' is-active' : ''}`}
                          >
                            <img src={arch.emblem} alt={arch.name} draggable={false} />
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                  ) : (
                    (() => {
                      const arch = ARCHETYPES.find(a => a.id === p.archetype);
                      return arch ? (
                        <span className="cc-scr-arch-badge">
                          <img src={arch.emblem} alt="" draggable={false} /> {arch.name}
                        </span>
                      ) : null;
                    })()
                  )}
                  {p.is_host && (
                    <span className="cc-scr-badge cc-scr-badge-host">
                      HOST
                    </span>
                  )}
                  {!p.has_returned && !p.is_cpu && (
                    <span className="cc-scr-badge cc-scr-badge-waiting">
                      WAITING
                    </span>
                  )}
                  {isHost && !p.is_host && (
                    <button
                      onClick={() => handleRemovePlayer(p.id)}
                      className="cc-scr-remove"
                      aria-label={`Remove ${p.name}`}
                    >
                      <Icon name="close" size={11} decorative />
                    </button>
                  )}
                </div>
              </div>
              {/* A rejected name (hateful / vulgar) — right under the seat. */}
              {isSelf && nameError && (
                <div className="cc-scr-name-error" role="alert">{nameError}</div>
              )}
              </Fragment>
            );
          })}
          {isHost && players.length < seatLimit && (
            <button
              onClick={() => handleAddCpu('vanguard')}
              className="cc-scr-add-seat"
            >
              + Add Bot
            </button>
          )}
        </section>

        {/* Game Settings (host editable, non-host read-only) */}
        <section className="cc-panel cc-scr-section" style={{ animationDelay: '120ms' }}>
          <div className="cc-scr-section-head">
            <h3 className="cc-scr-section-title">Game Settings</h3>
            {!isHost && <span className="cc-scr-section-meta">Set by host</span>}
          </div>
          {/* Settings rows — consistent style */}
          <div className="cc-scr-rows">
            {/* Card Pack */}
            <div className="cc-scr-row">
              <div style={{ width: 'auto' }}>
                <Tooltip content={cardPackLabel}>
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>Card Pack</span>
                </Tooltip>
              </div>
              <div className="cc-scr-row-controls" style={{ flex: 1, flexWrap: 'nowrap' }}>
                {isHost && cardPacks.length > 0 ? (
                  <select
                    className="cc-scr-select"
                    value={(lobby.config.card_pack || 'everything').startsWith('daily_') ? 'daily' : (lobby.config.card_pack || 'everything')}
                    onChange={(e) => {
                      const val = e.target.value;
                      handleConfigChange('card_pack', val === 'daily' ? getDailyPackId() : val);
                    }}
                  >
                    {cardPacks.map(p => {
                      // Collapse all daily_* packs into a single "daily" option
                      if (p.id.startsWith('daily_')) {
                        return <option key="daily" value="daily" title={p.description}>{p.name}</option>;
                      }
                      return <option key={p.id} value={p.id} title={p.description}>{p.name}</option>;
                    })}
                  </select>
                ) : (
                  <strong className="cc-scr-row-value">
                    {cardPacks.find(p => p.id === (lobby.config.card_pack || 'everything') || (p.id.startsWith('daily_') && (lobby.config.card_pack || '').startsWith('daily_')))?.name || lobby.config.card_pack || 'Everything'}
                  </strong>
                )}
                <button
                  onClick={() => {
                    // Reset any prior collapse memory so the lobby browser opens
                    // in its canonical default (Neutral expanded, archetypes
                    // collapsed) regardless of in-game interactions earlier.
                    clearBrowserCollapseMemory();
                    setShowPackBrowser(true);
                  }}
                  className="cc-scr-chip-btn"
                  style={{ flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  Cards
                </button>
              </div>
            </div>
            {selectedPackDescription && (
              <div className="cc-scr-pack-desc">{selectedPackDescription}</div>
            )}

            {/* Map Size */}
            <div className="cc-scr-row">
              <div>
                <Tooltip content="The size of the hex grid.">
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>Map Size</span>
                </Tooltip>
              </div>
              <div className={`cc-scr-seg${isHost ? '' : ' is-readonly'}`} style={{ display: 'flex', flex: 1 }}>
                {GRID_SIZES.map((size) => (
                  <Tooltip key={size.id} content={`${size.name}: ${size.tiles} tiles, ${size.players} players`}
                    wrapperStyle={{ display: 'flex', flex: '1 1 0', minWidth: 0 }}>
                    <button
                      onClick={() => isHost && handleConfigChange('grid_size', size.id)}
                      className={`cc-scr-seg-btn${lobby.config.grid_size === size.id ? ' is-active' : ''}`}
                      style={{ width: '100%', padding: '0 4px' }}
                    >
                      {isNarrow ? size.short : size.name}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* VP Target */}
            <div className="cc-scr-row">
              <div>
                <Tooltip content="The number of Victory Points a player needs to win.">
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>VP Target</span>
                </Tooltip>
              </div>
              {isHost ? (
                <div className="cc-scr-row-controls">
                  <input
                    type="number"
                    min={1}
                    className="cc-scr-input cc-scr-input-num"
                    value={lobby.config.vp_target ?? computeRecommendedVp(lobby.config.grid_size, players.length)}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val > 0) {
                        handleConfigChange('vp_target', val);
                      }
                    }}
                  />
                  {lobby.config.vp_target !== null && lobby.config.vp_target !== computeRecommendedVp(lobby.config.grid_size, players.length) && (
                    <button
                      onClick={() => handleConfigChange('vp_target', computeRecommendedVp(lobby.config.grid_size, players.length))}
                      className="cc-scr-chip-btn"
                    >
                      Reset ({computeRecommendedVp(lobby.config.grid_size, players.length)})
                    </button>
                  )}
                </div>
              ) : (
                <strong className="cc-scr-row-value">
                  {lobby.config.vp_target ?? computeRecommendedVp(lobby.config.grid_size, players.length)}
                </strong>
              )}
            </div>

            {/* Player Limit — seats open, bots included */}
            <div className="cc-scr-row">
              <div>
                <Tooltip content="How many seats this lobby has, bots included. Once they're filled no one else can join. Can't go below the players already here.">
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>Player Limit</span>
                </Tooltip>
              </div>
              <div className={`cc-scr-seg${isHost ? '' : ' is-readonly'}`} style={{ display: 'flex', flex: 1 }}>
                {[2, 3, 4, 5, 6].map((n) => {
                  const tooFew = n < players.length;
                  return (
                    <button
                      key={n}
                      onClick={() => isHost && !tooFew && handleConfigChange('max_players', n)}
                      disabled={isHost && tooFew}
                      title={tooFew ? `${players.length} players are already here` : undefined}
                      className={`cc-scr-seg-btn${seatLimit === n ? ' is-active' : ''}`}
                      style={{ flex: '1 1 0', minWidth: 0, padding: '0 4px', opacity: isHost && tooFew ? 0.35 : undefined }}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Open to Public */}
            <div className="cc-scr-row">
              <div>
                <Tooltip content="List this lobby in the home page's Browse Games, and the game in its In Progress tab once it starts. Off: players need the join code.">
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>Open to Public</span>
                </Tooltip>
              </div>
              <div className={`cc-scr-seg${isHost ? '' : ' is-readonly'}`}>
                {([true, false] as const).map((on) => (
                  <button
                    key={String(on)}
                    onClick={() => isHost && handleConfigChange('open_to_public', on)}
                    className={`cc-scr-seg-btn${(lobby.config.open_to_public ?? true) === on ? ' is-active' : ''}`}
                  >
                    {on ? 'On' : 'Off'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Advanced settings (collapsible) */}
          <button
            onClick={() => setShowAdvanced(prev => !prev)}
            className={`cc-scr-advanced-toggle${showAdvanced ? ' is-open' : ''}`}
          >
            <span className="cc-scr-chevron"><Icon name="chevron" size={10} decorative /></span>
            Advanced
          </button>
          {showAdvanced && (
          <div className="cc-scr-rows is-advanced">
            {/* Map Seed */}
            <div ref={seedHistoryRef} className="cc-scr-row">
              <div>
                <Tooltip content="Determines the layout of the grid.">
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>Map Seed</span>
                </Tooltip>
              </div>
              {isHost ? (
                <div className="cc-scr-row-controls">
                  <input
                    type="text"
                    className="cc-scr-input cc-scr-input-mono"
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
                    style={{ width: 84, textAlign: 'center' }}
                  />
                  <button
                    onClick={() => handleConfigChange('map_seed', generateClientSeed())}
                    title="Random seed"
                    className="cc-scr-chip-btn"
                    style={{ padding: '0 8px', fontSize: 15 }}
                    aria-label="Random seed"
                  >
                    <Icon name="reroll" size={15} decorative />
                  </button>
                  {getRecentSeeds().length > 0 && (
                    <button
                      onClick={() => setShowSeedHistory(p => !p)}
                      title="Recent seeds"
                      className={`cc-scr-chip-btn${showSeedHistory ? ' is-active' : ''}`}
                    >
                      History<Icon name="chevron" size={9} decorative style={{ marginLeft: 4, transform: 'rotate(90deg)', verticalAlign: '-0.05em' }} />
                    </button>
                  )}
                  {showSeedHistory && (
                    <div className="cc-panel cc-scr-dropdown">
                      {getRecentSeeds().map((s, i) => (
                        <div
                          key={i}
                          onClick={() => {
                            handleConfigChange('map_seed', s.seed);
                            handleConfigChange('grid_size', s.gridSize);
                            setShowSeedHistory(false);
                          }}
                          className="cc-scr-dropdown-item"
                        >
                          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--cc-text)', fontWeight: 'bold' }}>{s.seed}</span>
                          <span style={{ color: 'var(--cc-text-faint)' }}>{s.gridSize} · {formatRelativeDate(s.date)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span className="cc-scr-row-value" style={{ fontFamily: 'ui-monospace, Menlo, monospace', letterSpacing: 1 }}>
                  {lobby.config.map_seed || '------'}
                </span>
              )}
            </div>

            {/* Round Limit */}
            <div className="cc-scr-row">
              <span className="cc-scr-row-label" style={{ cursor: 'var(--cc-cursor-arrow)' }}>Round Limit</span>
              {isHost ? (
                <div className="cc-scr-row-controls">
                  <input
                    type="number"
                    min={5}
                    className="cc-scr-input cc-scr-input-num"
                    value={lobby.config.max_rounds ?? 20}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 5) {
                        handleConfigChange('max_rounds', val);
                      }
                    }}
                  />
                  {lobby.config.max_rounds !== 20 && (
                    <button
                      onClick={() => handleConfigChange('max_rounds', 20)}
                      className="cc-scr-chip-btn"
                    >
                      Reset (20)
                    </button>
                  )}
                  <span className="cc-scr-row-hint">(recommended: 20)</span>
                </div>
              ) : (
                <strong className="cc-scr-row-value">
                  {lobby.config.max_rounds ?? 20}
                </strong>
              )}
            </div>

            {/* Actions */}
            <div className="cc-scr-row">
              <div>
                <Tooltip content="The number of actions each player starts their round with.">
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>Actions</span>
                </Tooltip>
              </div>
              {isHost ? (
                <div className="cc-scr-row-controls">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    className="cc-scr-input cc-scr-input-num"
                    value={lobby.config.granted_actions ?? 5}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 1 && val <= 10) {
                        handleConfigChange('granted_actions', val);
                      }
                    }}
                  />
                  {lobby.config.granted_actions !== null && lobby.config.granted_actions !== 5 && (
                    <button
                      onClick={() => handleConfigChange('granted_actions', 5)}
                      className="cc-scr-chip-btn"
                    >
                      Reset (5)
                    </button>
                  )}
                </div>
              ) : (
                <strong className="cc-scr-row-value">
                  {lobby.config.granted_actions ?? 5}
                </strong>
              )}
            </div>

            {/* Archetype Market Size */}
            <div className="cc-scr-row">
              <div>
                <Tooltip content="The number of archetype cards available to buy each round.">
                  <span className="cc-scr-row-label" style={{ display: 'block' }}>Market Size</span>
                </Tooltip>
              </div>
              {isHost ? (
                <div className="cc-scr-row-controls">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    className="cc-scr-input cc-scr-input-num"
                    value={lobby.config.archetype_market_size ?? 5}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 1 && val <= 10) {
                        handleConfigChange('archetype_market_size', val);
                      }
                    }}
                  />
                  {(lobby.config.archetype_market_size ?? 5) !== 5 && (
                    <button
                      onClick={() => handleConfigChange('archetype_market_size', 5)}
                      className="cc-scr-chip-btn"
                    >
                      Reset (5)
                    </button>
                  )}
                </div>
              ) : (
                <strong className="cc-scr-row-value">
                  {lobby.config.archetype_market_size ?? 5}
                </strong>
              )}
            </div>

            {/* Test Mode (host only) */}
            {isHost && (
              <div className="cc-scr-row">
                <div>
                  <Tooltip content="Enables game-breaking settings for testing.">
                    <span className={`cc-scr-row-label${lobby.config.test_mode ? ' is-warn' : ''}`} style={{ display: 'block' }}>Test Mode</span>
                  </Tooltip>
                </div>
                <div className="cc-scr-seg">
                  {([false, true] as const).map((on) => (
                    <button
                      key={String(on)}
                      onClick={() => handleConfigChange('test_mode', on)}
                      className={`cc-scr-seg-btn${on ? ' is-warn' : ''}${lobby.config.test_mode === on ? ' is-active' : ''}`}
                    >
                      {on ? 'On' : 'Off'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}
        </section>

        {/* Error display */}
        {error && (
          <div className="cc-scr-error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* Countdown overlay */}
        {countdown !== null && (
          <div className="cc-scr-countdown">
            <div key={countdown} className="cc-title cc-scr-countdown-num">
              {countdown}
            </div>
            <div className="cc-scr-countdown-bar">
              <div className="cc-scr-countdown-fill" style={{ width: `${progressAnim * 100}%` }} />
            </div>
            <div className="cc-scr-countdown-label">
              Game starting...
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="cc-scr-lobby-actions">
          <button
            onClick={handleLeave}
            className="cc-btn-secondary"
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
                className={`cc-btn-primary${lobby.config.test_mode ? ' cc-scr-btn-test' : ''}`}
              >
                {starting ? 'Starting...' : waitingForReturn ? 'Waiting for Players...' : lobby.config.test_mode ? 'Start Test Game' : 'Start Game'}
              </button>
            );
          })()}
        </div>

        {/* Non-host waiting message */}
        {!isHost && (
          <div className="cc-scr-waiting-note">
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
            packSharedIds={pack?.shared_card_ids}
            packArchetypeIds={pack?.archetype_card_ids}
            packName={pack?.name}
            playerArchetype={lobby.players[playerId]?.archetype}
            collapseArchetypes
            hideNonPurchasable
          />
        );
      })()}
    </div>
  );
}


// ── Helpers ─────────────────────────────────────────────────

