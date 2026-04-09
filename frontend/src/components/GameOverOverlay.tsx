import { useState, useEffect, useMemo } from 'react';
import type { GameState, Player, Card, HexTile } from '../types/game';
import { CardViewPopup } from './CardHand';
import { useSound } from '../audio/useSound';

const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const TILES_PER_VP = 3;

interface VpBreakdown {
  tileCount: number;   // VP from owning tiles (tiles // 3)
  bonusTiles: number;  // VP from connected VP hexes
  cards: number;       // VP from card effects (passive_vp + formula + bonus)
}

function computeVpBreakdown(
  gameState: GameState,
  playerId: string,
): VpBreakdown {
  const tiles = gameState.grid?.tiles ?? {};
  const player = gameState.players[playerId];
  if (!player || !gameState.grid) return { tileCount: 0, bonusTiles: 0, cards: 0 };

  // Tile VP: owned tiles // 3
  const ownedTiles = Object.values(tiles).filter(t => t.owner === playerId);
  const tileCount = Math.floor(ownedTiles.length / TILES_PER_VP);

  // Connected VP hexes: BFS from base tiles through owned territory
  const baseKeys: string[] = [];
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_base && tile.owner === playerId) baseKeys.push(key);
  }
  const reachable = new Set<string>(baseKeys);
  const queue = [...baseKeys];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const tile = tiles[key];
    if (!tile) continue;
    for (const [dq, dr] of HEX_DIRS) {
      const nk = `${tile.q + dq},${tile.r + dr}`;
      if (reachable.has(nk)) continue;
      const neighbor = tiles[nk];
      if (!neighbor || neighbor.owner !== playerId) continue;
      reachable.add(nk);
      queue.push(nk);
    }
  }
  const bonusTiles = ownedTiles
    .filter(t => t.is_vp && reachable.has(`${t.q},${t.r}`))
    .reduce((sum, t) => sum + t.vp_value, 0);

  // Cards VP: everything else (passive_vp, formula, bonus)
  const totalVp = player.vp;
  const cards = Math.max(0, totalVp - tileCount - bonusTiles);

  return { tileCount, bonusTiles, cards };
}

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
  const sound = useSound();

  const [returnedToLobby, setReturnedToLobby] = useState(false);

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

  const bannerColor = isVictory ? '#4a9eff' : '#ff4a4a';
  const bannerText = isVictory ? 'Victory' : 'Defeat';

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 40000,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.85)',
      opacity: bannerVisible ? 1 : 0,
      transition: 'opacity 0.6s ease',
    }}>
      <style>{`
        .go-row:hover { background: rgba(74, 158, 255, 0.1) !important; }
      `}</style>

      {/* Victory / Defeat banner */}
      <div style={{
        fontSize: 64,
        fontWeight: 900,
        fontFamily: "'Cinzel', serif",
        textTransform: 'uppercase',
        letterSpacing: 12,
        color: bannerColor,
        textShadow: `0 0 40px ${bannerColor}66, 0 4px 12px rgba(0,0,0,0.8)`,
        opacity: bannerVisible ? 1 : 0,
        transform: bannerVisible ? 'translateY(0)' : 'translateY(-20px)',
        transition: 'opacity 0.8s ease, transform 0.8s ease',
        marginBottom: 40,
      }}>
        {bannerText}
      </div>

      {/* Leaderboard table */}
      <div style={{
        width: 'min(680px, 92vw)',
        background: '#12122a',
        border: '1px solid #3a3a5a',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '40px 1fr 78px 78px 78px',
          gap: 10,
          padding: '13px 20px',
          background: '#1a1a3a',
          fontSize: 14,
          color: '#666',
          fontWeight: 'bold',
          textTransform: 'uppercase',
          letterSpacing: 1,
        }}>
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
          return (
            <div
              className="go-row"
              key={entry.playerId}
              onClick={() => visible && setViewingDeck(entry.playerId)}
              style={{
                display: 'grid',
                gridTemplateColumns: '40px 1fr 78px 78px 78px',
                gap: 10,
                padding: isFirst ? '18px 20px' : '13px 20px',
                borderTop: '1px solid #2a2a4a',
                background: isFirst ? '#111a30' : 'transparent',
                fontSize: isFirst ? 20 : 17,
                fontWeight: isFirst ? 'bold' : 'normal',
                color: visible ? '#fff' : 'transparent',
                opacity: visible ? 1 : 0,
                transform: visible ? 'translateY(0)' : 'translateY(10px)',
                transition: 'opacity 0.4s ease, transform 0.4s ease, background 0.15s ease',
                alignItems: 'center',
                cursor: visible ? 'pointer' : 'default',
              }}
            >
              {/* Crown / rank */}
              <div style={{ textAlign: 'center', fontSize: isFirst ? 24 : 16, color: isFirst ? '#ffd700' : '#555' }}>
                {isFirst ? '👑' : `#${i + 1}`}
              </div>
              {/* Name + archetype */}
              <div>
                <span style={{ color: entry.hasLeft ? '#666' : entry.color }}>{entry.name}</span>
                <span style={{ fontSize: 13, color: '#666', marginLeft: 8 }}>
                  {entry.archetype.charAt(0).toUpperCase() + entry.archetype.slice(1)}
                </span>
                {entry.hasLeft && (
                  <span style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 6,
                    background: '#333',
                    color: '#888',
                    fontWeight: 'bold',
                    marginLeft: 6,
                  }}>
                    Left
                  </span>
                )}
              </div>
              {/* VP */}
              <div
                style={{ textAlign: 'right', color: '#ffd700', fontWeight: 'bold', cursor: 'help' }}
                onPointerEnter={(e) => setVpTooltip({ pid: entry.playerId, x: e.clientX, y: e.clientY })}
                onPointerLeave={() => setVpTooltip(null)}
              >
                {entry.vp}
              </div>
              {/* Tiles */}
              <div style={{ textAlign: 'right', color: '#aaa' }}>
                {entry.tiles}
              </div>
              {/* Deck size */}
              <div style={{ textAlign: 'right', color: '#aaa' }}>
                {entry.deckSize}
              </div>
            </div>
          );
        })}
      </div>

      {/* Buttons */}
      <div style={{
        display: 'flex',
        gap: 12,
        marginTop: 32,
        opacity: buttonsVisible ? 1 : 0,
        transform: buttonsVisible ? 'translateY(0)' : 'translateY(10px)',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
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
              onClick={() => { if (!disabled) { setReturnedToLobby(true); onReturnToLobby(); } }}
              disabled={disabled}
              style={{
                padding: '12px 32px',
                fontSize: 16,
                fontWeight: 'bold',
                background: removedFromLobby ? '#3a2a2a' : disabled ? '#2a4a3e' : '#2a6e3e',
                border: `1px solid ${removedFromLobby ? '#5a3a3a' : disabled ? '#3a6a4e' : '#3a8e5e'}`,
                borderRadius: 8,
                color: removedFromLobby ? '#ff6666' : '#fff',
                cursor: disabled ? 'default' : 'pointer',
                opacity: removedFromLobby ? 0.8 : 1,
              }}
            >
              {label}
            </button>
          );
        })()}
        <button
          onClick={onExitGame}
          style={{
            padding: '12px 32px',
            fontSize: 16,
            fontWeight: 'bold',
            background: '#2a2a3e',
            border: '1px solid #555',
            borderRadius: 8,
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Exit Game
        </button>
      </div>

      {/* VP breakdown tooltip */}
      {vpTooltip && (() => {
        const bd = vpBreakdowns[vpTooltip.pid];
        if (!bd) return null;
        return (
          <div style={{
            position: 'fixed',
            left: vpTooltip.x + 12,
            top: vpTooltip.y - 8,
            background: '#1a1a3a',
            border: '1px solid #4a4a6a',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 13,
            color: '#ccc',
            pointerEvents: 'none',
            zIndex: 50000,
            whiteSpace: 'nowrap',
          }}>
            <div style={{ fontWeight: 'bold', color: '#ffd700', marginBottom: 4 }}>VP Breakdown</div>
            <div>Tiles: {bd.tileCount}</div>
            <div>Bonus Tiles: {bd.bonusTiles}</div>
            <div>Cards: {bd.cards}</div>
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
    </div>
  );
}
