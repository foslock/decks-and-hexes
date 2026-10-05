import { useState, useEffect, useMemo, useCallback } from 'react';
import type { GameState, Player, Card, HexTile } from '../types/game';
import { CardViewPopup } from './CardHand';
import { useSound } from '../audio/useSound';
import { computeVpBreakdown, type VpBreakdown } from '../utils/vpBreakdown';
import { downloadGameLog } from '../utils/downloadGameLog';
import RoundBreakdownOverlay from './RoundBreakdownOverlay';

interface LeaderboardEntry {
  playerId: string;
  name: string;
  archetype: string;
  vp: number;
  tiles: number;
  deckSize: number;
  isWinner: boolean;
  hasLeft: boolean;
  color: string;
}

interface GameOverOverlayProps {
  gameState: GameState;
  playerId: string;
  isVictory: boolean;
  onReturnToLobby: () => void;
  onExitGame: () => void;
  isMultiplayer?: boolean;
  removedFromLobby?: boolean;
}

export default function GameOverOverlay({
  gameState,
  playerId,
  isVictory,
  onReturnToLobby,
  onExitGame,
  isMultiplayer,
  removedFromLobby,
}: GameOverOverlayProps) {
  const [bannerVisible, setBannerVisible] = useState(false);
  const [rowsVisible, setRowsVisible] = useState(0);
  const [buttonsVisible, setButtonsVisible] = useState(false);
  const [viewingDeck, setViewingDeck] = useState<string | null>(null);
  const [vpTooltip, setVpTooltip] = useState<{ pid: string; x: number; y: number } | null>(null);
  const [hidden, setHidden] = useState(false);
  const sound = useSound();

  const [returnedToLobby, setReturnedToLobby] = useState(false);
  const [downloadingLog, setDownloadingLog] = useState(false);
  const [showRoundBreakdown, setShowRoundBreakdown] = useState(false);

  // Toggle overlay visibility with Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && bannerVisible && !viewingDeck) {
      e.stopPropagation();
      setHidden(prev => !prev);
    }
  }, [bannerVisible, viewingDeck]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  const leaderboard: LeaderboardEntry[] = useMemo(() => {
    const tiles = gameState.grid.tiles;
    const tileCounts: Record<string, number> = {};
    for (const t of Object.values(tiles)) {
      if (t.owner) {
        tileCounts[t.owner] = (tileCounts[t.owner] || 0) + 1;
      }
    }

    return gameState.player_order.filter(pid => gameState.players[pid]).map((pid) => {
      const p: Player = gameState.players[pid];
      return {
        playerId: pid,
        name: p.name,
        archetype: p.archetype,
        vp: p.vp,
        tiles: tileCounts[pid] || 0,
        deckSize: p.deck_size + p.discard_count + p.hand_count,
        isWinner: gameState.winners ? gameState.winners.includes(pid) : pid === gameState.winner,
        hasLeft: p.has_left,
        color: p.color || '#888',
      };
    }).sort((a, b) => {
      if (a.isWinner) return -1;
      if (b.isWinner) return 1;
      if (b.vp !== a.vp) return b.vp - a.vp;
      return b.tiles - a.tiles;
    });
  }, [gameState]);

  const vpBreakdowns = useMemo(() => {
    const map: Record<string, VpBreakdown> = {};
    for (const pid of Object.keys(gameState.players)) {
      map[pid] = computeVpBreakdown(gameState, pid);
    }
    return map;
  }, [gameState]);

  // Get all cards for a player, grouped for display
  const getDeckGroups = (pid: string): { label: string; items: Card[] }[] => {
    const p = gameState.players[pid];
    if (!p) return [];
    const inDeck = [...p.hand, ...p.deck_cards, ...p.discard];
    const trashed = p.trash ?? [];
    const groups: { label: string; items: Card[] }[] = [
      { label: 'Deck', items: inDeck },
    ];
    if (trashed.length > 0) {
      groups.push({ label: 'Trashed', items: trashed });
    }
    return groups;
  };

  // Staggered animation + jingle
  useEffect(() => {
    const t1 = setTimeout(() => {
      setBannerVisible(true);
      if (isVictory) sound.victoryJingle(); else sound.defeatJingle();
    }, 100);
    return () => clearTimeout(t1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!bannerVisible) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < leaderboard.length; i++) {
      timers.push(setTimeout(() => setRowsVisible(i + 1), 600 + i * 250));
    }
    timers.push(setTimeout(() => setButtonsVisible(true), 600 + leaderboard.length * 250 + 200));
    return () => timers.forEach(clearTimeout);
  }, [bannerVisible, leaderboard.length]);

  const bannerText = isVictory ? 'Victory' : 'Defeat';

  // Winner(s) for the ribbon under the banner, in their player colors.
  const winnerEntries = leaderboard.filter(e => e.isWinner);

  // A handful of rising embers behind a victory banner. Deterministic
  // positions so re-renders don't reshuffle them.
  const embers = useMemo(() => Array.from({ length: 14 }, (_, i) => ({
    left: `${(i * 37 + 11) % 100}%`,
    delay: `${((i * 0.73) % 5).toFixed(2)}s`,
    duration: `${(6 + (i % 5) * 1.3).toFixed(1)}s`,
    drift: `${((i % 2 === 0 ? 1 : -1) * (14 + (i * 7) % 30))}px`,
    scale: 0.6 + ((i * 3) % 5) * 0.18,
  })), []);

  if (hidden) {
    return (
      <>
        {/* Transparent blocker to prevent game interaction */}
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 39999,
          pointerEvents: 'all',
          cursor: 'var(--cc-cursor-arrow)',
        }} />
        {/* Show Results button */}
        <button
          className="cc-btn-secondary cc-ov-btn-sm"
          onClick={() => setHidden(false)}
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 40000,
            padding: '7px 16px',
            borderRadius: 999,
            fontSize: 12,
          }}
        >
          Show Results (Esc)
        </button>
      </>
    );
  }

  return (
    <div
      className={`cc-ov-go-root ${isVictory ? 'is-victory' : 'is-defeat'}`}
      style={{
        opacity: bannerVisible ? 1 : 0,
        transition: 'opacity 0.6s ease',
      }}
    >
      {isVictory && bannerVisible && (
        <div className="cc-ov-go-embers" aria-hidden="true">
          {embers.map((e, i) => (
            <span
              key={i}
              className="cc-ov-ember"
              style={{
                left: e.left,
                animationDelay: e.delay,
                animationDuration: e.duration,
                ['--drift' as string]: e.drift,
                width: 6 * e.scale,
                height: 6 * e.scale,
              }}
            />
          ))}
        </div>
      )}

      <div className="cc-ov-go-stage">
      {/* Victory / Defeat banner */}
      <div className={`cc-ov-go-banner${bannerVisible ? ' is-in' : ''}`}>
        {isVictory && <div className="cc-ov-go-rays" aria-hidden="true" />}
        <div className="cc-ov-go-word">{bannerText}</div>
        <div className="cc-ov-go-sub">
          {winnerEntries.length > 0 ? (
            <span>
              {winnerEntries.map((w, i) => (
                <span key={w.playerId}>
                  {i > 0 && (i === winnerEntries.length - 1 ? ' & ' : ', ')}
                  <span className="cc-ov-go-winner" style={{ color: w.color }}>{w.name}</span>
                </span>
              ))}
              {winnerEntries.length > 1 ? ' share the victory' : ' claims victory'}
            </span>
          ) : (
            <span>The war is over</span>
          )}
        </div>
      </div>

      {/* Leaderboard table */}
      <div className="cc-ov-modal cc-ov-go-board">
        {/* Header */}
        <div className="cc-ov-go-grid cc-ov-go-head">
          <div />
          <div>Player</div>
          <div style={{ textAlign: 'right' }}>VP</div>
          <div style={{ textAlign: 'right' }}>Tiles</div>
          <div style={{ textAlign: 'right' }}>Deck</div>
        </div>

        {/* Rows */}
        {leaderboard.map((entry, i) => {
          const visible = i < rowsVisible;
          const isFirst = i === 0;
          const bd = vpBreakdowns[entry.playerId];
          return (
            <div
              className={`cc-ov-go-grid cc-ov-go-row${isFirst ? ' is-first' : ''}${visible ? ' is-shown' : ''}`}
              key={entry.playerId}
              onClick={() => visible && setViewingDeck(entry.playerId)}
              title={visible ? `View ${entry.name}'s deck` : undefined}
              style={{
                ['--cc-player' as string]: entry.color,
                ['--cc-player-soft' as string]: `${entry.color.length === 7 ? entry.color : '#888888'}33`,
                opacity: visible ? 1 : 0,
                transform: visible ? 'translateY(0)' : 'translateY(10px)',
                transition: 'opacity 0.4s ease, transform 0.45s var(--cc-ease-out), background-color 0.15s ease',
                cursor: visible ? 'var(--cc-cursor-pointer)' : 'var(--cc-cursor-arrow)',
              }}
            >
              {/* Crown / rank */}
              <div>
                <div className={`cc-ov-rank${i < 3 ? ` r${i + 1}` : ''}`}>
                  {isFirst ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-label="1st">
                      <path d="M3 8.5l4.2 3.3L12 5l4.8 6.8L21 8.5l-1.8 9.5H4.8L3 8.5z" />
                      <rect x="4.8" y="19" width="14.4" height="1.8" rx="0.6" />
                    </svg>
                  ) : `${i + 1}`}
                </div>
              </div>
              {/* Name + archetype */}
              <div className="cc-ov-go-name">
                <div className="cc-ov-go-name-line">
                  <span className="cc-ov-go-player" style={{ color: entry.hasLeft ? 'var(--cc-text-faint)' : entry.color }}>{entry.name}</span>
                  <span className="cc-ov-go-arch">
                    {entry.archetype.charAt(0).toUpperCase() + entry.archetype.slice(1)}
                  </span>
                  {entry.hasLeft && (
                    <span className="cc-ov-go-left">Left</span>
                  )}
                </div>
                {bd && (
                  <div className="cc-ov-go-bd">
                    Tiles <b>{bd.tileCount}</b> · Bonus <b>{bd.bonusTiles}</b> · Cards <b>{bd.cards}</b>
                  </div>
                )}
              </div>
              {/* VP */}
              <div
                className="cc-ov-go-vp"
                onPointerEnter={(e) => setVpTooltip({ pid: entry.playerId, x: e.clientX, y: e.clientY })}
                onPointerLeave={() => setVpTooltip(null)}
              >
                {entry.vp}
              </div>
              {/* Tiles */}
              <div className="cc-ov-go-stat">
                {entry.tiles}
              </div>
              {/* Deck size */}
              <div className="cc-ov-go-stat">
                {entry.deckSize}
              </div>
            </div>
          );
        })}
      </div>

      {/* Buttons */}
      <div className="cc-ov-go-actions" style={{
        opacity: buttonsVisible ? 1 : 0,
        transform: buttonsVisible ? 'translateY(0)' : 'translateY(10px)',
        transition: 'opacity 0.4s ease, transform 0.4s var(--cc-ease-out)',
      }}>
        {isMultiplayer && (() => {
          const disabled = returnedToLobby || removedFromLobby;
          const label = removedFromLobby
            ? 'Removed from Lobby'
            : returnedToLobby
              ? 'Returning...'
              : 'Return to Lobby';
          return (
            <button
              className={removedFromLobby ? 'cc-btn-secondary is-removed' : 'cc-btn-primary'}
              onClick={() => { if (!disabled) { setReturnedToLobby(true); onReturnToLobby(); } }}
              disabled={disabled}
              style={{ cursor: disabled ? 'var(--cc-cursor-arrow)' : 'var(--cc-cursor-pointer)' }}
            >
              {label}
            </button>
          );
        })()}
        <button
          className="cc-btn-secondary"
          onClick={() => setShowRoundBreakdown(true)}
          title="View per-round stats for each player"
        >
          Round Breakdown
        </button>
        <button
          className="cc-btn-secondary"
          onClick={async () => {
            if (downloadingLog) return;
            setDownloadingLog(true);
            try {
              await downloadGameLog(gameState.id);
            } catch (e) {
              console.warn('downloadGameLog failed:', e);
            } finally {
              setDownloadingLog(false);
            }
          }}
          disabled={downloadingLog}
          style={{ cursor: downloadingLog ? 'var(--cc-cursor-arrow)' : 'var(--cc-cursor-pointer)' }}
          title="Download the structured JSON log of this game"
        >
          {downloadingLog ? 'Preparing…' : 'Download Game Log'}
        </button>
        <button
          className={isMultiplayer ? 'cc-btn-secondary' : 'cc-btn-primary'}
          onClick={onExitGame}
        >
          Exit Game
        </button>
      </div>

      {/* Hint to view map */}
      <div className="cc-ov-go-hint" style={{
        opacity: buttonsVisible ? 1 : 0,
        transition: 'opacity 0.6s ease 0.3s',
      }}>
        Press <span className="cc-ov-kbd">Esc</span> to view the map
      </div>
      </div>

      {/* VP breakdown tooltip */}
      {vpTooltip && (() => {
        const bd = vpBreakdowns[vpTooltip.pid];
        if (!bd) return null;
        return (
          <div className="cc-ov-tooltip" style={{
            position: 'fixed',
            left: Math.min(vpTooltip.x + 12, window.innerWidth - 170),
            top: vpTooltip.y - 8,
            zIndex: 50000,
          }}>
            <div className="cc-ov-tooltip-title">VP Breakdown</div>
            <div className="cc-ov-tooltip-row"><span>Tiles</span><b>{bd.tileCount}</b></div>
            <div className="cc-ov-tooltip-row"><span>Bonus Tiles</span><b>{bd.bonusTiles}</b></div>
            <div className="cc-ov-tooltip-row"><span>Cards</span><b>{bd.cards}</b></div>
          </div>
        );
      })()}

      {/* Deck viewer modal — reuses the in-game CardViewPopup */}
      {viewingDeck && (() => {
        const player = gameState.players[viewingDeck];
        return (
          <CardViewPopup
            title={`${player?.name ?? viewingDeck}'s Deck`}
            cards={getDeckGroups(viewingDeck)}
            onClose={() => setViewingDeck(null)}
          />
        );
      })()}

      {/* Round Breakdown overlay */}
      {showRoundBreakdown && (
        <RoundBreakdownOverlay
          gameId={gameState.id}
          gameState={gameState}
          onClose={() => setShowRoundBreakdown(false)}
        />
      )}
    </div>
  );
}
