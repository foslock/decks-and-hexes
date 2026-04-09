import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { HexTile } from '../types/game';
import HexGrid, { PLAYER_COLORS, type VpPath } from './HexGrid';
import type { GridTransform } from './HexGrid';

const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

const PLAYER_IDS = ['player_0', 'player_1', 'player_2'];

/** Cycle order for clicking: neutral → player_0 → player_1 → player_2 → neutral */
const OWNER_CYCLE: (string | null)[] = [null, 'player_0', 'player_1', 'player_2'];

/** BFS from each VP tile owned by a player to their base, through owned territory.
 *  Deduplicates: if a VP tile is already a waypoint on a longer path, its standalone path is omitted. */
function computePlayerVpPaths(
  tiles: Record<string, HexTile>,
  playerId: string,
  color: number,
): VpPath[] {
  const baseKeys = new Set<string>();
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_base && tile.owner === playerId) baseKeys.add(key);
  }
  if (baseKeys.size === 0) return [];

  const vpTiles: { q: number; r: number; key: string }[] = [];
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_vp && tile.owner === playerId) {
      vpTiles.push({ q: tile.q, r: tile.r, key });
    }
  }
  if (vpTiles.length === 0) return [];

  const allPaths: { vpKey: string; points: [number, number][] }[] = [];
  for (const vp of vpTiles) {
    const queue: { key: string; q: number; r: number; path: [number, number][] }[] = [
      { key: vp.key, q: vp.q, r: vp.r, path: [[vp.q, vp.r]] },
    ];
    const visited = new Set<string>([vp.key]);
    let foundPath: [number, number][] | null = null;

    while (queue.length > 0 && !foundPath) {
      const current = queue.shift()!;
      for (const [dq, dr] of HEX_DIRS) {
        const nq = current.q + dq;
        const nr = current.r + dr;
        const nk = `${nq},${nr}`;
        if (visited.has(nk)) continue;
        const neighbor = tiles[nk];
        if (!neighbor || neighbor.owner !== playerId) continue;
        visited.add(nk);
        const newPath: [number, number][] = [...current.path, [nq, nr]];
        if (baseKeys.has(nk)) {
          foundPath = newPath;
          break;
        }
        queue.push({ key: nk, q: nq, r: nr, path: newPath });
      }
    }
    if (foundPath) {
      allPaths.push({ vpKey: vp.key, points: foundPath });
    }
  }

  // Sort longest first, then remove paths whose VP tile is already a waypoint on a longer path
  allPaths.sort((a, b) => b.points.length - a.points.length);
  const coveredVpKeys = new Set<string>();
  const vpKeySet = new Set(vpTiles.map(v => v.key));
  const result: VpPath[] = [];

  for (const p of allPaths) {
    if (coveredVpKeys.has(p.vpKey)) continue;
    result.push({ points: p.points, color, alpha: 1, playerId });
    for (let i = 1; i < p.points.length; i++) {
      const wk = `${p.points[i][0]},${p.points[i][1]}`;
      if (vpKeySet.has(wk)) coveredVpKeys.add(wk);
    }
  }
  return result;
}

/** Compute connected VP tiles (owned + reachable from base). */
function computeConnectedVp(tiles: Record<string, HexTile>, playerIds: string[]): Set<string> {
  const connected = new Set<string>();
  for (const pid of playerIds) {
    const baseKeys: string[] = [];
    for (const [key, tile] of Object.entries(tiles)) {
      if (tile.is_base && tile.owner === pid) baseKeys.push(key);
    }
    if (baseKeys.length === 0) continue;
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
        if (!neighbor || neighbor.owner !== pid) continue;
        reachable.add(nk);
        queue.push(nk);
      }
    }
    for (const [key, tile] of Object.entries(tiles)) {
      if (tile.is_vp && tile.owner === pid && reachable.has(key)) {
        connected.add(key);
      }
    }
  }
  return connected;
}

/** Build a demo hex grid (radius 4) with three players, VP tiles, and territory. */
function buildDemoTiles(): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  const radius = 4;
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) > radius) continue;
      const key = `${q},${r}`;
      tiles[key] = {
        q, r,
        is_blocked: false,
        is_vp: false,
        vp_value: 1,
        owner: null,
        defense_power: 0,
        base_defense: 0,
        permanent_defense_bonus: 0,
        held_since_turn: null,
        is_base: false,
        base_owner: null,
      };
    }
  }

  // Player 0 (blue) — base at (4,-2), territory reaching toward center
  for (const k of ['4,-2', '4,-3', '3,-2', '3,-1', '3,-3', '2,-1', '2,-2', '1,-1', '1,0']) {
    tiles[k].owner = 'player_0';
  }
  tiles['4,-2'].is_base = true;
  tiles['4,-2'].base_owner = 'player_0';
  tiles['1,0'].is_vp = true;

  // Player 1 (red) — base at (-4,2), territory reaching toward center
  for (const k of ['-4,2', '-4,3', '-3,2', '-3,1', '-3,3', '-2,1', '-2,2', '-1,1', '-1,0']) {
    tiles[k].owner = 'player_1';
  }
  tiles['-4,2'].is_base = true;
  tiles['-4,2'].base_owner = 'player_1';
  tiles['-1,0'].is_vp = true;

  // Player 2 (green) — base at (0,-4), territory reaching down
  for (const k of ['0,-4', '1,-4', '-1,-3', '0,-3', '0,-2', '0,-1', '1,-3']) {
    tiles[k].owner = 'player_2';
  }
  tiles['0,-4'].is_base = true;
  tiles['0,-4'].base_owner = 'player_2';
  tiles['0,-1'].is_vp = true;

  // Unowned VP tiles
  tiles['0,2'].is_vp = true;
  tiles['2,2'].is_vp = true;
  tiles['-2,-2'].is_vp = true;

  // Blocked tiles
  tiles['0,0'].is_blocked = true;
  tiles['1,2'].is_blocked = true;
  tiles['-1,-1'].is_blocked = true;

  return tiles;
}

export default function VpPathPreview() {
  const [tiles, setTiles] = useState(buildDemoTiles);
  const [vpPaths, setVpPaths] = useState<VpPath[]>([]);
  const [fadePhase, setFadePhase] = useState<'off' | 'fading_in' | 'visible' | 'fading_out'>('off');
  const fadeStartRef = useRef(0);
  const transformRef = useRef<GridTransform | null>(null);

  const connectedVpTiles = useMemo(() => computeConnectedVp(tiles, PLAYER_IDS), [tiles]);

  const recomputePaths = useCallback((currentTiles: Record<string, HexTile>, alpha: number) => {
    const allPaths: VpPath[] = [];
    for (const pid of PLAYER_IDS) {
      const color = PLAYER_COLORS[pid] ?? 0xffffff;
      allPaths.push(...computePlayerVpPaths(currentTiles, pid, color).map(p => ({ ...p, alpha })));
    }
    return allPaths;
  }, []);

  // Auto-start fade-in on mount
  useEffect(() => {
    const paths = recomputePaths(tiles, 0);
    setVpPaths(paths);
    setFadePhase('fading_in');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fade-in animation
  useEffect(() => {
    if (fadePhase !== 'fading_in') return;
    fadeStartRef.current = performance.now();
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - fadeStartRef.current) / 800, 1);
      const eased = 1 - Math.pow(1 - progress, 2);
      setVpPaths(prev => prev.map(p => p.breaking ? p : { ...p, alpha: eased }));
      if (progress >= 1) {
        clearInterval(id);
        setFadePhase('visible');
      }
    }, 50);
    return () => clearInterval(id);
  }, [fadePhase]);

  // Fade-out animation
  useEffect(() => {
    if (fadePhase !== 'fading_out') return;
    fadeStartRef.current = performance.now();
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - fadeStartRef.current) / 500, 1);
      setVpPaths(prev => {
        if (progress >= 1) return [];
        return prev.map(p => ({ ...p, alpha: (1 - progress) }));
      });
      if (progress >= 1) {
        clearInterval(id);
        setFadePhase('off');
      }
    }, 50);
    return () => clearInterval(id);
  }, [fadePhase]);

  // Breaking path animation
  const breakingCount = vpPaths.filter(p => p.breaking && p.alpha > 0).length;
  useEffect(() => {
    if (breakingCount === 0) return;
    const startTime = performance.now();
    const startAlphas = vpPaths.map(p => p.alpha);
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - startTime) / 300, 1);
      setVpPaths(prev => prev.map((p, i) => {
        if (!p.breaking) return p;
        return { ...p, alpha: Math.max(0, startAlphas[i] * (1 - progress)) };
      }));
      if (progress >= 1) clearInterval(id);
    }, 30);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakingCount]);

  /** Click a tile to cycle its owner: neutral → p0 → p1 → p2 → neutral. */
  const handleTileClick = useCallback((q: number, r: number) => {
    const key = `${q},${r}`;
    setTiles(prev => {
      const tile = prev[key];
      if (!tile || tile.is_blocked || tile.is_base) return prev;

      const currentIdx = OWNER_CYCLE.indexOf(tile.owner);
      const nextOwner = OWNER_CYCLE[(currentIdx + 1) % OWNER_CYCLE.length];
      const next = { ...prev, [key]: { ...tile, owner: nextOwner } };

      // Recompute all VP paths with new ownership
      const newPaths = recomputePaths(next, fadePhase === 'visible' || fadePhase === 'fading_in' ? 1 : 0);
      setVpPaths(newPaths);

      return next;
    });
  }, [fadePhase, recomputePaths]);

  const handleTogglePaths = useCallback(() => {
    if (fadePhase === 'visible' || fadePhase === 'fading_in') {
      setFadePhase('fading_out');
    } else {
      const paths = recomputePaths(tiles, 0);
      setVpPaths(paths);
      setFadePhase('fading_in');
    }
  }, [fadePhase, tiles, recomputePaths]);

  const handleReset = useCallback(() => {
    const freshTiles = buildDemoTiles();
    setTiles(freshTiles);
    const paths = recomputePaths(freshTiles, 0);
    setVpPaths(paths);
    setFadePhase('fading_in');
  }, [recomputePaths]);

  const connectedCount = connectedVpTiles.size;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1a1a2e', color: '#fff' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>VP Path Animation Preview</h2>
        <button onClick={handleTogglePaths} style={btnStyle}>
          {fadePhase === 'visible' || fadePhase === 'fading_in' ? 'Fade Out' : 'Fade In'}
        </button>
        <button onClick={handleReset} style={{ ...btnStyle, background: '#555' }}>
          Reset
        </button>
        <span style={{ fontSize: 12, color: '#888', marginLeft: 'auto' }}>
          VP Paths: {vpPaths.filter(p => !p.breaking).length} | Connected ★: {connectedCount} | Phase: {fadePhase}
        </span>
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        <HexGrid
          tiles={tiles}
          onTileClick={handleTileClick}
          transformRef={transformRef}
          vpPaths={vpPaths.length > 0 ? vpPaths : undefined}
          connectedVpTiles={connectedVpTiles}
        />
      </div>
      <div style={{ padding: '12px 24px', borderTop: '1px solid #333', fontSize: 13, color: '#aaa', lineHeight: 1.6 }}>
        <strong style={{ color: '#fff' }}>How it works:</strong>{' '}
        Click any tile to cycle its owner (<span style={{ color: '#5599ff' }}>Blue</span> → <span style={{ color: '#ff5555' }}>Red</span> → <span style={{ color: '#55cc66' }}>Green</span> → Neutral).
        Bezier lines connect each player's ★ VP tiles to their base via the shortest owned-territory path.
        Stars are <span style={{ color: '#ffd700' }}>★ gold</span> when connected, <span style={{ color: '#888' }}>☆ grey</span> when disconnected.
        Base and blocked tiles cannot be changed.
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: '#4a9eff',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
};
