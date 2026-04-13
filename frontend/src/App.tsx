import { useState, useCallback, useEffect, useRef, Component, type ReactNode } from 'react';
import type { GameState, LobbyState } from './types/game';
import { SettingsProvider } from './components/SettingsContext';
import SetupScreen from './components/SetupScreen';
import GameScreen from './components/GameScreen';
import LobbyScreen from './components/LobbyScreen';
import VpPathPreview from './components/VpPathPreview';
import { useWebSocket } from './hooks/useWebSocket';
import * as api from './api/client';
import { CardZoomProvider } from './components/CardZoomContext';

/** Catches render-time crashes so the whole app doesn't white-screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught render crash:', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', maxWidth: 400 }}>
            <div style={{ fontSize: 20, marginBottom: 12 }}>Something went wrong</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>{this.state.error.message}</div>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              style={{ padding: '8px 20px', background: '#4a9eff', border: 'none', borderRadius: 6, color: '#fff', fontSize: 14, cursor: 'pointer' }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Check for ?preview= query parameter
const urlParams = new URLSearchParams(window.location.search);
const previewMode = urlParams.get('preview');

// Session storage keys
const SS_LOBBY = 'cardclash_lobby';

type AppScreen =
  | { type: 'home' }
  | { type: 'lobby'; code: string; playerId: string; token: string; isHost: boolean; lobby: LobbyState }
  | { type: 'game'; gameId: string; playerId: string; token: string; isMultiplayer: boolean; lobbyCode?: string; isHost?: boolean; localPlayerIds?: string[] };

function loadSession(): AppScreen | null {
  try {
    const raw = sessionStorage.getItem(SS_LOBBY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.type === 'lobby' || data.type === 'game') return data;
  } catch { /* ignore */ }
  return null;
}

function saveSession(screen: AppScreen | null) {
  if (screen && screen.type !== 'home') {
    sessionStorage.setItem(SS_LOBBY, JSON.stringify(screen));
  } else {
    sessionStorage.removeItem(SS_LOBBY);
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <CardZoomProvider>
        <AppInner />
      </CardZoomProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  const [error, setError] = useState<string | null>(null);

  // Multiplayer state machine — restore from session storage on mount
  const [screen, setScreen] = useState<AppScreen>(() => {
    const saved = loadSession();
    if (saved) {
      // Restore auth token if we have one
      if ('token' in saved && saved.token) {
        api.setAuthToken(saved.token);
      }
      return saved;
    }
    return { type: 'home' };
  });
  const [multiplayerGameState, setMultiplayerGameState] = useState<GameState | null>(null);
  // Track if this player was removed from lobby (e.g. kicked by host while viewing game over)
  const [removedFromLobby, setRemovedFromLobby] = useState(false);
  // Track if this session was restored from storage (skip intro on reconnect)
  const [isReconnect, setIsReconnect] = useState(() => !!loadSession());

  // WebSocket for multiplayer game (not lobby — lobby manages its own)
  const gameLobbyCode = screen.type === 'game' && screen.isMultiplayer ? (screen.lobbyCode ?? null) : null;
  const wsPlayerId = screen.type === 'game' && screen.isMultiplayer ? screen.playerId : null;
  const wsToken = screen.type === 'game' && screen.isMultiplayer ? screen.token : null;

  const { lastMessage: gameWsMessage } = useWebSocket(
    gameLobbyCode,
    wsPlayerId,
    wsToken,
  );

  // Handle WebSocket game state updates
  useEffect(() => {
    if (!gameWsMessage || screen.type !== 'game' || !screen.isMultiplayer) return;
    console.log('[App] game WS effect:', gameWsMessage.type, 'screen:', screen.type, 'gameId:', screen.gameId);

    if (gameWsMessage.type === 'game_state') {
      setMultiplayerGameState(gameWsMessage.state as unknown as GameState);
    } else if (gameWsMessage.type === 'game_ended') {
      // Verify this game_ended is for our current game by checking the game_id if present,
      // or at minimum that we're still in a game screen (guard against stale WS messages)
      const msgGameId = gameWsMessage.game_id as string | undefined;
      if (msgGameId && msgGameId !== screen.gameId) {
        console.warn('[App] game_ended IGNORED — stale message for', msgGameId, 'but current game is', screen.gameId);
        return;
      }
      console.log('[App] game_ended → going home');
      setScreen({ type: 'home' });
      setMultiplayerGameState(null);
      setRemovedFromLobby(false);
      saveSession(null);
    } else if (gameWsMessage.type === 'removed_from_lobby') {
      // Player was kicked from the lobby by the host (e.g. while still on game-over screen)
      console.log('[App] removed_from_lobby → disabling return-to-lobby');
      setRemovedFromLobby(true);
    } else if (gameWsMessage.type === 'lobby_update') {
      // Return-to-lobby: server sends lobby_update when lobby is reset
      const lobbyState = gameWsMessage.lobby as unknown as LobbyState;
      if (lobbyState && screen.type === 'game') {
        console.log('[App] lobby_update during game → returning to lobby');
        setMultiplayerGameState(null);
        setRemovedFromLobby(false);
        setIsReconnect(false);
        setScreen({
          type: 'lobby',
          code: screen.lobbyCode || lobbyState.code,
          playerId: screen.playerId,
          token: screen.token,
          isHost: screen.isHost || false,
          lobby: lobbyState,
        });
      }
    }
  }, [gameWsMessage, screen]);

  // Save screen to session storage
  useEffect(() => {
    saveSession(screen);
  }, [screen]);

  // Reconnection: if we restored a game screen from session but have no game state, fetch it
  const reconnectAttempted = useRef(false);
  useEffect(() => {
    if (reconnectAttempted.current) return;
    if (screen.type === 'game' && screen.isMultiplayer && !multiplayerGameState) {
      reconnectAttempted.current = true;
      console.log('[App] reconnect: fetching game state for', screen.gameId);
      api.getGame(screen.gameId, screen.playerId)
        .then((state) => setMultiplayerGameState(state))
        .catch(() => {
          // Game no longer exists — return to home
          console.log('[App] reconnect FAILED → going home');
          setScreen({ type: 'home' });
          api.setAuthToken(null);
          saveSession(null);
        });
    } else if (screen.type === 'lobby') {
      reconnectAttempted.current = true;
      // Lobby reconnection — WebSocket will reconnect automatically via LobbyScreen
      // Just verify the lobby still exists
      api.getLobby(screen.code, screen.playerId, screen.token)
        .catch(() => {
          setScreen({ type: 'home' });
          api.setAuthToken(null);
          saveSession(null);
        });
    }
  }, []); // Only run once on mount

  // ── Multiplayer flow ─────────────────────────────────────

  const handleCreateLobby = useCallback(async () => {
    try {
      setError(null);
      const result = await api.createLobby('Player 1', 'vanguard');  // First player is always #1
      api.setAuthToken(result.token);
      const lobbyScreen: AppScreen = {
        type: 'lobby',
        code: result.code,
        playerId: result.player_id,
        token: result.token,
        isHost: true,
        lobby: result.lobby,
      };
      setScreen(lobbyScreen);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleJoinLobby = useCallback(async (code: string) => {
    setError(null);
    const result = await api.joinLobby(code.toUpperCase(), 'Player', 'vanguard');
    api.setAuthToken(result.token);
    const lobbyScreen: AppScreen = {
      type: 'lobby',
      code: code.toUpperCase(),
      playerId: result.player_id,
      token: result.token,
      isHost: false,
      lobby: result.lobby,
    };
    setScreen(lobbyScreen);
  }, []);

  const handleGameStart = useCallback((gameId: string, state: GameState, localPlayerIds?: string[]) => {
    console.log('[App] handleGameStart called, screen.type:', screen.type, 'gameId:', gameId);
    if (screen.type !== 'lobby') {
      console.warn('[App] handleGameStart SKIPPED — screen is not lobby, it is:', screen.type);
      return;
    }
    setMultiplayerGameState(state);
    setIsReconnect(false); // New game from lobby — show intro
    const gameScreen: AppScreen = {
      type: 'game',
      gameId,
      playerId: screen.playerId,
      token: screen.token,
      isMultiplayer: true,
      lobbyCode: screen.code,
      isHost: screen.isHost,
      localPlayerIds,
    };
    setScreen(gameScreen);
  }, [screen]);

  const handleLeaveLobby = useCallback(() => {
    setScreen({ type: 'home' });
    api.setAuthToken(null);
    saveSession(null);
  }, []);

  const handleLeaveGame = useCallback(() => {
    console.log('[App] handleLeaveGame → going home');
    setScreen({ type: 'home' });
    setMultiplayerGameState(null);
    api.setAuthToken(null);
    saveSession(null);
  }, []);

  const handleMultiplayerStateUpdate = useCallback((state: GameState) => {
    setMultiplayerGameState(state);
  }, []);

  // Preview modes (accessible via ?preview=vp-paths)
  if (previewMode === 'vp-paths') {
    return (
      <SettingsProvider>
        <VpPathPreview />
      </SettingsProvider>
    );
  }

  // ── Render ───────────────────────────────────────────────
  console.log('[App] render — screen:', screen.type, 'hasGameState:', !!multiplayerGameState);

  // Lobby
  if (screen.type === 'lobby') {
    return (
      <SettingsProvider>
        <LobbyScreen
          lobbyCode={screen.code}
          playerId={screen.playerId}
          token={screen.token}
          isHost={screen.isHost}
          initialLobby={screen.lobby}
          onGameStart={handleGameStart}
          onLeave={handleLeaveLobby}
        />
      </SettingsProvider>
    );
  }

  // Game in progress
  if (screen.type === 'game' && screen.isMultiplayer) {
    if (!multiplayerGameState) {
      // Brief loading state while game state is being set — prevents flashing home screen
      return (
        <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ color: '#666', fontSize: 14 }}>Loading game…</div>
        </div>
      );
    }
    return (
      <SettingsProvider>
        <GameScreen
          gameState={multiplayerGameState}
          onStateUpdate={handleMultiplayerStateUpdate}
          playerId={screen.playerId}
          token={screen.token}
          isMultiplayer={true}
          localPlayerIds={screen.localPlayerIds}
          isHost={
            (() => { try { const s = JSON.parse(sessionStorage.getItem(SS_LOBBY) || '{}'); return s.isHost; } catch { return false; } })()
          }
          onLeaveGame={handleLeaveGame}
          skipIntro={isReconnect}
          removedFromLobby={removedFromLobby}
        />
      </SettingsProvider>
    );
  }

  // Home screen
  return (
    <SettingsProvider>
      <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100dvh' }}>
        <SetupScreen
          onCreateLobby={handleCreateLobby}
          onJoinLobby={handleJoinLobby}
        />
        {error && (
          <div style={{ textAlign: 'center', color: '#ff4a4a', padding: 12 }}>{error}</div>
        )}
      </div>
    </SettingsProvider>
  );
}
