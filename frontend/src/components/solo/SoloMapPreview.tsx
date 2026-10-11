import { useEffect, useMemo, useState } from 'react';
import GameBoard, { PLAYER_COLORS, cssHexToNumber } from '../GameBoard';
import type { PlayerInfo } from '../../board3d/boardTypes';
import { useAnimationSpeed } from '../SettingsContext';
import * as api from '../../api/client';
import Icon from '../../icons/Icon';
import { axialToPixel } from '../../utils/hexGeometry';
import type { HexTile, SoloLevel } from '../../types/game';

/** Turn the board so `playerId`'s base sits at the bottom (as the game does),
 *  in 30° steps. */
export function baseRotation(tiles: Record<string, HexTile>, playerId: string): number {
  const list = Object.values(tiles);
  const base = list.find(t => t.is_base && t.base_owner === playerId);
  if (!base || !list.length) return 0;
  let cx = 0, cy = 0;
  for (const t of list) {
    const p = axialToPixel(t.q, t.r);
    cx += p.x;
    cy += p.y;
  }
  const b = axialToPixel(base.q, base.r);
  const angle = Math.atan2(b.y - cy / list.length, b.x - cx / list.length);
  const step = Math.PI / 6;
  return Math.round((Math.PI / 2 - angle) / step) * step;
}

interface SoloMapPreviewProps {
  level: SoloLevel;
  onClose: () => void;
}

/**
 * A level's board as your game will start it — your base, the rivals'
 * bases, walls, towns — seated for this campaign's side (a shared level
 * looks different from each side).
 */
export default function SoloMapPreview({ level, onClose }: SoloMapPreviewProps) {
  const [map, setMap] = useState<api.SoloLevelMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const speed = useAnimationSpeed();
  const [build, setBuild] = useState(speed === 0 ? 1 : 0);

  useEffect(() => {
    let live = true;
    api.getSoloLevelMap(level.id, level.archetype)
      .then(m => { if (live) setMap(m); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load the map.'); });
    return () => { live = false; };
  }, [level.id, level.archetype]);

  useEffect(() => {
    if (!map) return;
    if (speed === 0) { setBuild(1); return; }
    let raf = 0;
    const t0 = performance.now();
    const ms = 1600 * Math.max(0.65, speed);
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setBuild(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [map, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // The board reads seat colors from PLAYER_COLORS.
  const playerInfo = useMemo<Record<string, PlayerInfo>>(() => {
    const out: Record<string, PlayerInfo> = {};
    for (const p of map?.players ?? []) {
      PLAYER_COLORS[p.id] = cssHexToNumber(p.color);
      out[p.id] = { name: p.name, archetype: p.archetype };
    }
    return out;
  }, [map]);

  const counts = useMemo(() => {
    const tiles = Object.values(map?.tiles ?? {});
    return {
      tiles: tiles.length,
      towns: tiles.filter(t => t.is_vp).length,
      walls: tiles.filter(t => !t.is_vp && !t.is_base && t.base_defense > 0).length,
      mountains: tiles.filter(t => t.is_blocked && !t.is_scorched && !t.is_water).length,
      water: tiles.filter(t => t.is_water).length,
      scorched: tiles.filter(t => t.is_scorched).length,
    };
  }, [map]);

  return (
    <div onClick={(e) => { e.stopPropagation(); onClose(); }} className="cc-scr-modal-backdrop" style={{ zIndex: 6000 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="cc-panel cc-scr-modal cc-scr-map"
        role="dialog"
        aria-label={`Map of ${level.title}`}
      >
        <div className="cc-scr-modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="cc-scr-modal-title">
              {level.map.name === level.title ? level.title : `${level.title} · ${level.map.name}`}
            </div>
            {map && (
              <div className="cc-scr-modal-sub">
                {counts.tiles} tiles · you start at the bottom
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
              gridRotation={baseRotation(map.tiles, map.seats[0])}
            />
          ) : (
            <div className="cc-scr-map-status">{error ?? 'Loading the map…'}</div>
          )}
        </div>
        <div className="cc-scr-map-key">
          <div className="cc-scr-map-seats">
            {(map?.players ?? []).map(p => (
              <span key={p.id} className="cc-scr-map-seat">
                <i style={{ background: p.color }} />
                {p.id === map?.seats[0] ? 'You' : p.name}
              </span>
            ))}
          </div>
          {map && (
            <div className="cc-scr-map-facts">
              {counts.towns > 0 && (
                <span className="cc-scr-map-fact">{counts.towns} × <Icon name="vp" size={11} decorative /> towns</span>
              )}
              {counts.walls > 0 && <span>{counts.walls} defended tiles</span>}
              <span>{counts.mountains} mountains</span>
              {counts.water > 0 && <span>{counts.water} water</span>}
              {counts.scorched > 0 && <span>{counts.scorched} scorched</span>}
              <span className="cc-scr-map-hint">Hover a tile for its defense</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
