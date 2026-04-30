import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GameState } from '../types/game';
import { getGameLog, type LogEntry } from '../api/client';

interface RoundBreakdownOverlayProps {
  gameId: string;
  gameState: GameState;
  onClose: () => void;
}

type MetricKey =
  | 'vp'
  | 'tiles_occupied'
  | 'cumulative_resources_gained'
  | 'cumulative_bonus_actions_gained'
  | 'deck_size'
  | 'cumulative_claim_power_resolved';

interface MetricDef {
  key: MetricKey;
  label: string;
  short: string;
}

const METRICS: MetricDef[] = [
  { key: 'vp',                                label: 'VP Total',                short: 'VP' },
  { key: 'tiles_occupied',                    label: 'Tiles Occupied',          short: 'Tiles' },
  { key: 'cumulative_resources_gained',       label: 'Resources Gained',        short: 'Resources' },
  { key: 'cumulative_bonus_actions_gained',   label: 'Bonus Actions Gained',    short: 'Bonus Actions' },
  { key: 'deck_size',                         label: 'Deck Size',               short: 'Deck' },
  { key: 'cumulative_claim_power_resolved',   label: 'Claim Power Played',      short: 'Claim Pwr' },
];

interface PlayerMetricsRow {
  vp: number;
  tiles_occupied: number;
  cumulative_resources_gained: number;
  cumulative_bonus_actions_gained: number;
  deck_size: number;
  cumulative_claim_power_resolved: number;
  has_left: boolean;
}

interface RoundSnapshot {
  round: number;
  players: Record<string, PlayerMetricsRow>;
}

// Layout constants for the SVG chart. CHART_W/H define the viewBox coordinate
// space — the rendered SVG stretches to fill the container width via
// preserveAspectRatio="none" on width, while keeping its own height proportional
// to its content via height: auto on the element. PAD_LEFT reserves room for
// y-axis tick labels; PAD_RIGHT keeps the last x-tick label from clipping.
const CHART_W = 760;
const CHART_H = 320;
const PAD_LEFT = 56;
const PAD_RIGHT = 24;
const PAD_TOP = 20;
const PAD_BOTTOM = 36;

function niceCeil(value: number): number {
  if (value <= 0) return 4;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / exp;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * exp;
}

export default function RoundBreakdownOverlay({
  gameId,
  gameState,
  onClose,
}: RoundBreakdownOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rounds, setRounds] = useState<RoundSnapshot[]>([]);
  const [metric, setMetric] = useState<MetricKey>('vp');
  const [hover, setHover] = useState<{ x: number; y: number; round: number; entries: { pid: string; value: number }[] } | null>(null);
  const [tooltipSize, setTooltipSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Fade-in on mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Fetch the game log and extract round_ended snapshots
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const log = await getGameLog(gameId);
        if (cancelled) return;
        const snapshots: RoundSnapshot[] = [];
        for (const entry of log.entries as LogEntry[]) {
          if (entry.event_type !== 'round_ended') continue;
          const data = entry.data as { round?: number; player_stats?: Record<string, PlayerMetricsRow> } | undefined;
          if (!data || typeof data.round !== 'number' || !data.player_stats) continue;
          snapshots.push({ round: data.round, players: data.player_stats });
        }
        snapshots.sort((a, b) => a.round - b.round);
        setRounds(snapshots);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [gameId]);

  // Player display info — drawn from current GameState (colors, names, archetypes)
  const playerInfo = useMemo(() => {
    return gameState.player_order
      .filter(pid => gameState.players[pid])
      .map(pid => {
        const p = gameState.players[pid];
        // Find the round at which this player left, if any
        let leftRound: number | null = null;
        for (const snap of rounds) {
          const row = snap.players[pid];
          if (row?.has_left) { leftRound = snap.round; break; }
        }
        return {
          pid,
          name: p.name,
          color: p.color || '#888',
          leftRound,
        };
      });
  }, [gameState, rounds]);

  // Build chart series — one polyline per player, truncated at leave round
  const series = useMemo(() => {
    return playerInfo.map(info => {
      const points: { round: number; value: number }[] = [];
      for (const snap of rounds) {
        const row = snap.players[info.pid];
        if (!row) continue;
        points.push({ round: snap.round, value: row[metric] });
        if (info.leftRound !== null && snap.round >= info.leftRound) break;
      }
      return { ...info, points };
    });
  }, [playerInfo, rounds, metric]);

  // Y-axis scale: max across all players for the current metric
  const { yMax, xMin, xMax } = useMemo(() => {
    let max = 0;
    let xLo = Infinity;
    let xHi = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.value > max) max = p.value;
        if (p.round < xLo) xLo = p.round;
        if (p.round > xHi) xHi = p.round;
      }
    }
    if (xLo === Infinity) { xLo = 1; xHi = 1; }
    return { yMax: niceCeil(max), xMin: xLo, xMax: xHi };
  }, [series]);

  const xToPx = useCallback((round: number) => {
    if (xMax === xMin) return PAD_LEFT + (CHART_W - PAD_LEFT - PAD_RIGHT) / 2;
    return PAD_LEFT + ((round - xMin) / (xMax - xMin)) * (CHART_W - PAD_LEFT - PAD_RIGHT);
  }, [xMin, xMax]);

  const yToPx = useCallback((value: number) => {
    if (yMax === 0) return CHART_H - PAD_BOTTOM;
    return PAD_TOP + (1 - value / yMax) * (CHART_H - PAD_TOP - PAD_BOTTOM);
  }, [yMax]);

  // X-axis tick rounds
  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let r = xMin; r <= xMax; r++) ticks.push(r);
    return ticks;
  }, [xMin, xMax]);

  // Y-axis ticks (5 evenly-spaced)
  const yTicks = useMemo(() => {
    const out: number[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) out.push(Math.round((yMax / steps) * i));
    return out;
  }, [yMax]);

  const activeMetric = METRICS.find(m => m.key === metric)!;

  // Build a hover descriptor that gathers ALL players sharing the same (round, value)
  // so overlapping markers expand into a multi-player tooltip. x/y are viewport
  // coords from the pointer event so the fixed-position tooltip can clamp correctly.
  const hoverAt = useCallback((e: ReactMouseEvent, round: number, value: number) => {
    const entries = series
      .map(s => {
        const pt = s.points.find(p => p.round === round);
        return pt && pt.value === value ? { pid: s.pid, value: pt.value } : null;
      })
      .filter((entry): entry is { pid: string; value: number } => entry !== null);
    if (entries.length === 0) return;
    setHover({ x: e.clientX, y: e.clientY, round, entries });
  }, [series]);

  // Measure the tooltip after render so we can clamp its position to the viewport
  useLayoutEffect(() => {
    if (!hover || !tooltipRef.current) return;
    const r = tooltipRef.current.getBoundingClientRect();
    if (r.width !== tooltipSize.w || r.height !== tooltipSize.h) {
      setTooltipSize({ w: r.width, h: r.height });
    }
  }, [hover, tooltipSize.w, tooltipSize.h]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 45000,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.2s ease',
      }}
    >
      <style>{`
        .rb-modal { padding: 24px; gap: 16px; }
        .rb-header-title { font-size: 22px; }
        .rb-header-sub { font-size: 13px; }
        .rb-metrics {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 6px;
        }
        .rb-metric-btn {
          width: 100%;
          padding: 5px 10px;
          font-size: 12px;
          line-height: 1.15;
          border-radius: 6px;
          cursor: pointer;
          text-align: center;
          /* Reserve enough height for a wrapped 2-line label so single-line and
             wrapped-line buttons all render at the same height regardless of which
             one is selected (bold weight) and which wraps. */
          min-height: 38px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background 0.15s ease, box-shadow 0.15s ease, color 0.15s ease;
        }
        .rb-metric-btn:hover { background: #2a2a4e !important; }
        .rb-chart-card { padding: 10px; }
        .rb-legend { gap: 14px; padding: 8px 4px; }
        .rb-legend-item { font-size: 13px; }
        .rb-line { transition: opacity 0.25s ease; }
        .rb-marker { transition: r 0.2s ease; }
        .rb-axis-text { font-family: 'Inter', system-ui, sans-serif; font-size: 11px; fill: #888; }

        @media (max-width: 640px) {
          .rb-modal { padding: 14px; gap: 12px; border-radius: 10px; }
          .rb-header-title { font-size: 18px; }
          .rb-header-sub { font-size: 12px; }
          .rb-metrics {
            grid-template-columns: repeat(2, 1fr);
            gap: 6px;
          }
          .rb-metric-btn { padding: 5px 6px; font-size: 11px; min-height: 34px; }
          .rb-chart-card { padding: 6px; }
          .rb-legend { gap: 10px 12px; padding: 4px 2px; }
          .rb-legend-item { font-size: 12px; }
        }
        @media (max-width: 380px) {
          .rb-metrics { grid-template-columns: 1fr; }
        }
      `}</style>
      <div
        className="rb-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(96vw, 920px)',
          maxHeight: '92vh',
          background: '#12122a',
          border: '2px solid #4a4a6a',
          borderRadius: 14,
          color: '#fff',
          boxShadow: '0 10px 50px rgba(0,0,0,0.6)',
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1)' : 'scale(0.96)',
          transition: 'opacity 0.25s ease, transform 0.25s ease',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div className="rb-header-title" style={{ fontWeight: 'bold', letterSpacing: 0.5 }}>Round Breakdown</div>
            <div className="rb-header-sub" style={{ color: '#888', marginTop: 3 }}>
              End-of-round stats for each player. Click a metric to switch the view.
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              flex: '0 0 auto',
              width: 32,
              height: 32,
              borderRadius: 8,
              border: '1px solid #3a3a5a',
              background: '#1a1a3a',
              color: '#aaa',
              fontSize: 18,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >×</button>
        </div>

        {/* Metric selector — auto-fit grid stacks to 2 cols on phones, 1 col on tiny screens */}
        <div className="rb-metrics">
          {METRICS.map(m => {
            const selected = m.key === metric;
            return (
              <button
                key={m.key}
                className="rb-metric-btn"
                onClick={() => setMetric(m.key)}
                style={{
                  fontWeight: selected ? 'bold' : 'normal',
                  background: selected ? '#3a4a8a' : '#1f2a44',
                  border: `1px solid ${selected ? '#7a8acc' : '#3a4a6a'}`,
                  color: selected ? '#fff' : '#cfd8ea',
                  boxShadow: selected ? '0 0 12px rgba(160,170,255,0.35)' : 'none',
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>

        {/* Body — chart + legend */}
        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#888' }}>Loading round data…</div>
        ) : error ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#ff6666' }}>Failed to load: {error}</div>
        ) : rounds.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#888' }}>No completed rounds yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Chart */}
            <div className="rb-chart-card" style={{ position: 'relative', background: '#0c0c1e', border: '1px solid #2a2a4a', borderRadius: 10 }}>
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ display: 'block', width: '100%', height: 'auto' }}
              >
                {/* Y-axis grid + labels */}
                {yTicks.map(v => (
                  <g key={`y-${v}`}>
                    <line
                      x1={PAD_LEFT}
                      x2={CHART_W - PAD_RIGHT}
                      y1={yToPx(v)}
                      y2={yToPx(v)}
                      stroke="#1f1f3a"
                      strokeWidth={1}
                    />
                    <text x={PAD_LEFT - 8} y={yToPx(v) + 4} textAnchor="end" className="rb-axis-text">{v}</text>
                  </g>
                ))}
                {/* X-axis labels */}
                {xTicks.map(r => (
                  <text key={`x-${r}`} x={xToPx(r)} y={CHART_H - 14} textAnchor="middle" className="rb-axis-text">R{r}</text>
                ))}
                {/* Axis line */}
                <line x1={PAD_LEFT} x2={CHART_W - PAD_RIGHT} y1={CHART_H - PAD_BOTTOM} y2={CHART_H - PAD_BOTTOM} stroke="#3a3a5a" strokeWidth={1} />
                <line x1={PAD_LEFT} x2={PAD_LEFT} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} stroke="#3a3a5a" strokeWidth={1} />

                {/* Player lines */}
                {series.map(s => {
                  if (s.points.length === 0) return null;
                  const polyPoints = s.points.map(p => `${xToPx(p.round)},${yToPx(p.value)}`).join(' ');
                  const lastPoint = s.points[s.points.length - 1];
                  const endsAtLeave = s.leftRound !== null && lastPoint.round === s.leftRound;
                  const opacity = s.leftRound !== null ? 0.65 : 1;
                  return (
                    <g key={s.pid} className="rb-line" style={{ opacity }}>
                      <polyline
                        points={polyPoints}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={2.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                      {s.points.map((p, idx) => {
                        const isEnd = idx === s.points.length - 1;
                        const cx = xToPx(p.round);
                        const cy = yToPx(p.value);
                        if (isEnd && endsAtLeave) {
                          // X marker for leaver endpoint
                          const sz = 8;
                          return (
                            <g
                              key={`m-${p.round}`}
                              onMouseEnter={(e) => hoverAt(e, p.round, p.value)}
                              onMouseLeave={() => setHover(null)}
                              style={{ cursor: 'help' }}
                            >
                              <line x1={cx - sz} y1={cy - sz} x2={cx + sz} y2={cy + sz} stroke={s.color} strokeWidth={3} strokeLinecap="round" />
                              <line x1={cx - sz} y1={cy + sz} x2={cx + sz} y2={cy - sz} stroke={s.color} strokeWidth={3} strokeLinecap="round" />
                              <circle cx={cx} cy={cy} r={14} fill="transparent" />
                            </g>
                          );
                        }
                        return (
                          <g
                            key={`m-${p.round}`}
                            onMouseEnter={(e) => hoverAt(e, p.round, p.value)}
                            onMouseLeave={() => setHover(null)}
                            style={{ cursor: 'help' }}
                          >
                            <circle
                              className="rb-marker"
                              cx={cx}
                              cy={cy}
                              r={5}
                              fill={s.color}
                              stroke="#0c0c1e"
                              strokeWidth={1.5}
                            />
                            <circle cx={cx} cy={cy} r={12} fill="transparent" />
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </svg>
              {/* Hover tooltip — portalled to body so position: fixed escapes the
                  modal's transform context and resolves against the viewport.
                  Clamped to viewport edges; lists every player at (round, value). */}
              {hover && createPortal((() => {
                const margin = 8;
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const ttW = tooltipSize.w || 180;
                const ttH = tooltipSize.h || 60;
                let left = hover.x + 14;
                let top = hover.y - 10;
                if (left + ttW + margin > vw) left = hover.x - ttW - 14;
                if (left < margin) left = margin;
                if (top + ttH + margin > vh) top = vh - ttH - margin;
                if (top < margin) top = margin;
                return (
                  <div
                    ref={tooltipRef}
                    style={{
                      position: 'fixed',
                      left,
                      top,
                      background: '#1a1a3a',
                      border: '1px solid #4a4a6a',
                      borderRadius: 6,
                      padding: '8px 12px',
                      fontSize: 12,
                      color: '#ccc',
                      pointerEvents: 'none',
                      whiteSpace: 'nowrap',
                      zIndex: 50001,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                    }}
                  >
                    <div style={{ color: '#888', marginBottom: 4 }}>Round {hover.round} · {activeMetric.short}</div>
                    {hover.entries.map(({ pid, value }) => {
                      const info = playerInfo.find(p => p.pid === pid);
                      if (!info) return null;
                      return (
                        <div key={pid} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: info.color }} />
                          <span style={{ color: info.color, fontWeight: 'bold' }}>{info.name}</span>
                          <span style={{ color: '#fff' }}>{value}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })(), document.body)}
            </div>

            {/* Legend */}
            <div className="rb-legend" style={{ display: 'flex', flexWrap: 'wrap' }}>
              {playerInfo.map(info => (
                <div
                  key={info.pid}
                  className="rb-legend-item"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    opacity: info.leftRound !== null ? 0.55 : 1,
                  }}
                >
                  <span style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: info.color,
                    boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                  }} />
                  <span style={{ color: '#fff' }}>{info.name}</span>
                  {info.leftRound !== null && (
                    <span style={{ color: '#888', fontSize: 11 }}>(left round {info.leftRound})</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
