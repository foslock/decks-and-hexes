import { useEffect, useMemo, useState } from 'react';
import type { LobbyState } from '../types/game';
import GameBoard, { PLAYER_COLORS, cssHexToNumber } from './GameBoard';
import type { PlayerInfo } from '../board3d/boardTypes';
import { useAnimationSpeed } from './SettingsContext';
import * as api from '../api/client';
import Icon from '../icons/Icon';

/**
 * Lobby map preview: the island the game will start on (the size's preset,
 * turned by the map seed), with every player's starting tiles in their
 * color and archetype. Follows the lobby live — size, seed, who's in and
 * the seat order (bases go round the board in the lobby's player order).
 */

const SIZE_NAMES: Record<string, string> = {
  small: 'Small', medium: 'Medium', large: 'Large', mega: 'Mega', ultra: 'Ultra',
};

interface MapPreviewProps {
  lobbyCode: string;
  playerId: string;
  token: string;
  lobby: LobbyState;
  onClose: () => void;
}

export default function MapPreview({ lobbyCode, playerId, token, lobby, onClose }: MapPreviewProps) {
  const [map, setMap] = useState<api.MapPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const speed = useAnimationSpeed();
  const [build, setBuild] = useState(speed === 0 ? 1 : 0);

  const { grid_size: gridSize, map_seed: mapSeed } = lobby.config;
  const seatKey = (lobby.player_order?.length ? lobby.player_order : Object.keys(lobby.players)).join(',');

  useEffect(() => {
    let live = true;
    api.getMapPreview(lobbyCode, playerId, token)
      .then(m => { if (live) { setMap(m); setError(null); } })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load the map.'); });
    return () => { live = false; };
  }, [lobbyCode, playerId, token, gridSize, mapSeed, seatKey]);

  // A new island rises out of the sea (on open, and when the size changes).
  const shownSize = map?.grid_size;
  useEffect(() => {
    if (!shownSize) return;
    if (speed === 0) { setBuild(1); return; }
    setBuild(0);
    let raf = 0;
    const t0 = performance.now();
    const ms = 2200 * Math.max(0.65, speed);
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setBuild(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shownSize, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const seats = useMemo(
    () => (map?.seats ?? []).map(pid => ({ pid, player: lobby.players[pid] })).filter(s => s.player),
    [map, lobby.players],
  );

  // The board reads seat colors from PLAYER_COLORS; a new playerInfo object
  // makes it rebuild in the new colors and camps.
  const looks = seats.map(s => `${s.pid}:${s.player.color}:${s.player.archetype}`).join('|');
  const playerInfo = useMemo<Record<string, PlayerInfo>>(() => {
    const out: Record<string, PlayerInfo> = {};
    for (const { pid, player } of seats) {
      if (player.color) PLAYER_COLORS[pid] = cssHexToNumber(player.color);
      out[pid] = { name: player.name, archetype: player.archetype };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looks]);

  const counts = useMemo(() => {
    const tiles = Object.values(map?.tiles ?? {});
    return {
      tiles: tiles.length,
      premium: tiles.filter(t => t.is_vp && t.vp_value === 2).length,
      standard: tiles.filter(t => t.is_vp && t.vp_value !== 2).length,
      mountains: tiles.filter(t => t.is_blocked).length,
    };
  }, [map]);

  const sizeName = SIZE_NAMES[map?.grid_size ?? gridSize] ?? gridSize;

  return (
    <div onClick={onClose} className="cc-scr-modal-backdrop" style={{ zIndex: 5000 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="cc-panel cc-scr-modal cc-scr-map"
        role="dialog"
        aria-label="Map preview"
      >
        <div className="cc-scr-modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="cc-scr-modal-title">{map ? `${sizeName} · ${map.map_name}` : sizeName}</div>
            {map && (
              <div className="cc-scr-modal-sub">
                {counts.tiles} tiles · {seats.length} {seats.length === 1 ? 'player' : 'players'}
              </div>
            )}
          </div>
          <button onClick={onClose} className="cc-scr-close" aria-label="Close" style={{ marginLeft: 'auto' }}>
            <Icon name="close" size={14} decorative />
          </button>
        </div>

        <div className="cc-scr-map-board">
          {map ? (
            <GameBoard
              tiles={map.tiles}
              onTileClick={() => {}}
              playerInfo={playerInfo}
              buildProgress={build}
            />
          ) : (
            <div className="cc-scr-map-status">{error ?? 'Loading the map…'}</div>
          )}
        </div>

        <div className="cc-scr-map-key">
          <div className="cc-scr-map-seats">
            {seats.map(({ pid, player }) => (
              <span key={pid} className="cc-scr-map-seat">
                <i style={{ background: player.color }} />
                {player.name}{pid === playerId ? ' (you)' : ''}
              </span>
            ))}
          </div>
          {map && (
            <div className="cc-scr-map-facts">
              {counts.premium > 0 && (
                <span className="cc-scr-map-fact">
                  {counts.premium} × <Icon name="vp" size={11} decorative /><Icon name="vp" size={11} decorative /> VP
                </span>
              )}
              {counts.standard > 0 && (
                <span className="cc-scr-map-fact">
                  {counts.standard} × <Icon name="vp" size={11} decorative /> VP
                </span>
              )}
              <span>{counts.mountains} mountains</span>
              <span className="cc-scr-map-hint">Bases go round the board in player order</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
