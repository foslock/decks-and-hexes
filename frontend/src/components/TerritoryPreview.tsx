import { useCallback, useMemo, useRef, useState } from 'react';
import type { HexTile } from '../types/game';
import GameBoard, { PLAYER_COLORS, type BoardControls, type VpPath } from './GameBoard';
import type { PlayerInfo } from '../board3d/boardTypes';
import { HEX_DIRS } from '../utils/hexGeometry';

/**
 * Themed territory preview (?preview=territory): a live board where three
 * seats hold land, so every archetype's occupied-tile look — camps, outline
 * markers, walls at each strength, roads — can be compared in any color.
 * Click a tile to hand it to the next seat; shift-click to raise its walls.
 */

const RADIUS = 5;
const SEATS = ['player_0', 'player_1', 'player_2'];
const BASES = ['5,0', '0,-5', '-5,5'];
const TERRITORY = 14;
const MOUNTAINS = ['2,1', '-2,-1', '-1,3', '3,-3'];
const PREMIUM = '0,0';
const ARCHETYPES = [
  { id: 'vanguard', name: 'Vanguard' },
  { id: 'swarm', name: 'Swarm' },
  { id: 'fortress', name: 'Fortress' },
];
const COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
];
type WallMode = 'none' | 'mixed' | 1 | 2 | 3 | 4 | 5;
const WALL_MODES: WallMode[] = ['none', 'mixed', 1, 2, 3, 4, 5];

const key = (q: number, r: number) => `${q},${r}`;
const parse = (k: string) => k.split(',').map(Number) as [number, number];
const neighbours = (k: string) => { const [q, r] = parse(k); return HEX_DIRS.map(([dq, dr]) => key(q + dq, r + dr)); };

function blank(q: number, r: number): HexTile {
  return {
    q, r, is_blocked: false, is_vp: false, vp_value: 1, owner: null, defense_power: 0, base_defense: 0,
    permanent_defense_bonus: 0, held_since_turn: null, is_base: false, base_owner: null,
  };
}

interface Seat { territory: string[]; town: string; forts: string[] }

/** The map: three bases on alternate corners, each holding the 14 tiles
 *  nearest it (a town among them), a premium VP town in the middle ringed
 *  by its palisaded neighbours, a few mountains. */
function buildMap(): { tiles: Record<string, HexTile>; seats: Seat[] } {
  const tiles: Record<string, HexTile> = {};
  for (let q = -RADIUS; q <= RADIUS; q++) {
    for (let r = -RADIUS; r <= RADIUS; r++) {
      if (Math.abs(q + r) <= RADIUS) tiles[key(q, r)] = blank(q, r);
    }
  }
  for (const m of MOUNTAINS) tiles[m].is_blocked = true;
  Object.assign(tiles[PREMIUM], { is_vp: true, vp_value: 2, base_defense: 3, defense_power: 3 });
  for (const n of neighbours(PREMIUM)) if (tiles[n]) Object.assign(tiles[n], { base_defense: 1, defense_power: 1 });
  const seats = BASES.map((base, i) => {
    const pid = SEATS[i];
    const seen = new Set([base]);
    const order = [base];
    for (let j = 0; j < order.length && order.length < TERRITORY; j++) {
      for (const n of neighbours(order[j])) {
        const t = tiles[n];
        if (!t || seen.has(n) || t.is_blocked || n === PREMIUM || t.base_defense > 0) continue;
        seen.add(n);
        order.push(n);
        if (order.length >= TERRITORY) break;
      }
    }
    for (const k of order) tiles[k].owner = pid;
    Object.assign(tiles[base], { is_base: true, base_owner: pid, base_defense: 3, defense_power: 3 });
    const town = order[6];
    Object.assign(tiles[town], { is_vp: true, vp_value: 1, base_defense: 2, defense_power: 2 });
    return { territory: order, town, forts: [order[1], order[2], order[TERRITORY - 2]] };
  });
  return { tiles, seats };
}

/** Wall strength of each fortified tile for a mode (Mixed: 1, 3 and 5). */
function fortLevels(mode: WallMode): number[] {
  if (mode === 'none') return [0, 0, 0];
  if (mode === 'mixed') return [1, 3, 5];
  return [mode, mode, mode];
}

function withWalls(tiles: Record<string, HexTile>, seats: Seat[], mode: WallMode): Record<string, HexTile> {
  const next = { ...tiles };
  const levels = fortLevels(mode);
  for (const s of seats) {
    s.forts.forEach((k, i) => {
      next[k] = { ...next[k], permanent_defense_bonus: levels[i], defense_power: next[k].base_defense + levels[i] };
    });
  }
  return next;
}

/** A town's way home: the owner's tiles from it to their base. */
function pathHome(tiles: Record<string, HexTile>, pid: string, from: string): [number, number][] | null {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const k = queue.shift()!;
    if (tiles[k].is_base && tiles[k].base_owner === pid) {
      const out: [number, number][] = [];
      for (let c: string | null = k; c; c = prev.get(c) ?? null) out.push(parse(c));
      return out.reverse();
    }
    for (const n of neighbours(k)) {
      if (!prev.has(n) && tiles[n]?.owner === pid) { prev.set(n, k); queue.push(n); }
    }
  }
  return null;
}

const INITIAL = buildMap();

export default function TerritoryPreview() {
  const [arch, setArch] = useState(['vanguard', 'swarm', 'fortress']);
  const [colors, setColors] = useState(['#e6194b', '#4363d8', '#3cb44b']);
  const [walls, setWalls] = useState<WallMode>('mixed');
  const [roads, setRoads] = useState(true);
  const [tiles, setTiles] = useState(() => withWalls(INITIAL.tiles, INITIAL.seats, 'mixed'));
  const controlsRef = useRef<BoardControls | null>(null);

  // The board reads seat colors from PLAYER_COLORS; a new playerInfo object
  // makes it rebuild everything in the new looks.
  const playerInfo = useMemo<Record<string, PlayerInfo>>(() => {
    SEATS.forEach((pid, i) => { PLAYER_COLORS[pid] = parseInt(colors[i].slice(1), 16); });
    return Object.fromEntries(SEATS.map((pid, i) => [pid, { name: `Seat ${i + 1}`, archetype: arch[i] }]));
  }, [arch, colors]);

  const { vpPaths, connected } = useMemo(() => {
    const paths: VpPath[] = [];
    const conn = new Set<string>();
    for (const [k, t] of Object.entries(tiles)) {
      if (!t.is_vp || !t.owner) continue;
      const points = pathHome(tiles, t.owner, k);
      if (!points) continue;
      conn.add(k);
      if (roads) paths.push({ points, color: PLAYER_COLORS[t.owner] ?? 0xffffff, alpha: 1, playerId: t.owner, noPulse: true });
    }
    return { vpPaths: paths, connected: conn };
  // Colors are part of the look (playerInfo changes with them).
  }, [tiles, roads, playerInfo]);

  const setWallMode = (m: WallMode) => {
    setWalls(m);
    setTiles(t => withWalls(t, INITIAL.seats, m));
  };

  const onTileClick = useCallback((q: number, r: number, shift?: boolean) => {
    const k = key(q, r);
    setTiles(prev => {
      const t = prev[k];
      if (!t || t.is_blocked || t.is_base) return prev;
      if (shift) {
        const lvl = ((t.permanent_defense_bonus ?? 0) + 1) % 6;
        return { ...prev, [k]: { ...t, permanent_defense_bonus: lvl, defense_power: t.base_defense + lvl } };
      }
      const i = t.owner ? SEATS.indexOf(t.owner) : -1;
      const owner = i + 1 < SEATS.length ? SEATS[i + 1] : null;
      return { ...prev, [k]: { ...t, owner } };
    });
  }, []);

  /** Each seat takes one tile beside its land (anyone's but its own). */
  const grow = (only?: number) => {
    setTiles(prev => {
      const next = { ...prev };
      SEATS.forEach((pid, i) => {
        if (only != null && only !== i) return;
        const options = Object.keys(next).filter(k => {
          const t = next[k];
          return !t.is_blocked && !t.is_base && t.owner !== pid && neighbours(k).some(n => next[n]?.owner === pid);
        });
        if (!options.length) return;
        const k = options[Math.floor(Math.random() * options.length)];
        next[k] = { ...next[k], owner: pid };
      });
      return next;
    });
  };

  const reset = () => {
    setTiles(withWalls(INITIAL.tiles, INITIAL.seats, walls));
  };

  const look = (seat: number | null, close = false) => {
    const c = controlsRef.current;
    if (!c) return;
    if (seat == null) { c.resetView(); return; }
    const s = INITIAL.seats[seat];
    if (close) c.flyTo({ keys: [s.forts[0], s.territory[3]], zoom: 4.2, tilt: 0.74, seconds: 1.4, arc: 0.15 });
    else c.flyTo({ keys: s.territory, zoom: 2.1, tilt: 0.66, seconds: 1.4, arc: 0.15 });
  };

  const btn = (on: boolean): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
    border: `1px solid ${on ? '#d8b25a' : '#3a3a55'}`, background: on ? '#3a3220' : '#23233a', color: on ? '#f3e3b5' : '#c9c9d9',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: '#1a1a2e', color: '#fff' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Territory Preview</h2>
          <span style={{ fontSize: 12, color: '#9a9ab0' }}>
            Click a tile to hand it to the next seat · shift-click to raise its walls · drag to pan, right-drag to turn, scroll to zoom
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {SEATS.map((pid, i) => (
            <div key={pid} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 10px', borderRadius: 8, background: '#22223a', border: `1px solid ${colors[i]}66` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: colors[i] }} />
                <b style={{ fontSize: 12, marginRight: 4 }}>Seat {i + 1}</b>
                {ARCHETYPES.map(a => (
                  <button key={a.id} style={btn(arch[i] === a.id)} onClick={() => setArch(v => v.map((x, j) => (j === i ? a.id : x)))}>{a.name}</button>
                ))}
                <button style={btn(false)} onClick={() => look(i)}>View</button>
                <button style={btn(false)} onClick={() => look(i, true)}>Close-up</button>
                <button style={btn(false)} onClick={() => grow(i)}>Expand</button>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {COLORS.map(c => (
                  <button
                    key={c}
                    aria-label={`Seat ${i + 1} color ${c}`}
                    onClick={() => setColors(v => v.map((x, j) => (j === i ? c : x)))}
                    style={{
                      width: 18, height: 18, borderRadius: 9, background: c, cursor: 'pointer', padding: 0,
                      border: colors[i] === c ? '2px solid #fff' : '2px solid transparent',
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
          <span style={{ color: '#9a9ab0' }}>Walls</span>
          {WALL_MODES.map(m => (
            <button key={String(m)} style={btn(walls === m)} onClick={() => setWallMode(m)}>
              {m === 'none' ? 'None' : m === 'mixed' ? 'Mixed (1·3·5)' : `Level ${m}`}
            </button>
          ))}
          <span style={{ width: 12 }} />
          <button style={btn(roads)} onClick={() => setRoads(v => !v)}>Roads</button>
          <span style={{ width: 12 }} />
          <span style={{ color: '#9a9ab0' }}>Same look</span>
          {ARCHETYPES.map(a => (
            <button key={a.id} style={btn(arch.every(x => x === a.id))} onClick={() => setArch(SEATS.map(() => a.id))}>All {a.name}</button>
          ))}
          <span style={{ width: 12 }} />
          <button style={btn(false)} onClick={() => grow()}>Everyone expands</button>
          <button style={btn(false)} onClick={reset}>Reset map</button>
          <button style={btn(false)} onClick={() => look(null)}>Whole board</button>
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <GameBoard
          tiles={tiles}
          onTileClick={onTileClick}
          playerInfo={playerInfo}
          vpPaths={vpPaths}
          connectedVpTiles={connected}
          controlsRef={controlsRef}
          showCameraControls
        />
      </div>
    </div>
  );
}
