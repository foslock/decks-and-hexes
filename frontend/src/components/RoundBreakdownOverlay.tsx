import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GameState } from '../types/game';
import { getGameLog, type LogEntry } from '../api/client';
import Icon from '../icons/Icon';
import type { IconName } from '../icons/glyphs';
import { cursor } from '../utils/cursors';

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
  icon: IconName;
}

const METRICS: MetricDef[] = [
  { key: 'vp',                                label: 'VP Total',                short: 'VP',            icon: 'vp' },
  { key: 'tiles_occupied',                    label: 'Tiles Occupied',          short: 'Tiles',         icon: 'tile' },
  { key: 'cumulative_resources_gained',       label: 'Resources Gained',        short: 'Resources',     icon: 'resource' },
  { key: 'cumulative_bonus_actions_gained',   label: 'Bonus Actions Gained',    short: 'Bonus Actions', icon: 'action' },
  { key: 'deck_size',                         label: 'Deck Size',               short: 'Deck',          icon: 'drawPile' },
  { key: 'cumulative_claim_power_resolved',   label: 'Claim Power Played',      short: 'Claim Pwr',     icon: 'power' },
];

/** Gilded line-chart glyph for the header (matches the shop's chest). */
function ChartIcon() {
  return (
    <svg className="cc-ov-shop-head-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 3.5v17h17" />
      <path d="M6.5 16l4-5 3.5 3 5.5-7" />
      <circle cx="10.5" cy="11" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="14" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

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
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / exp;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * exp;
}

/** Y-axis scale for whole-number stats: about four even steps of a "nice"
 *  whole size (1, 2, 5, 10…) — every tick lands on an integer, none repeat. */
export function yScale(max: number): { yMax: number; step: number } {
  const step = Math.max(1, niceCeil(max / 4));
  return { yMax: Math.max(step * 2, Math.ceil(max / step) * step), step };
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
          isCpu: !!p.is_cpu,
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
  const { yMax, yStep, xMin, xMax } = useMemo(() => {
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
    const { yMax: top, step } = yScale(max);
    return { yMax: top, yStep: step, xMin: xLo, xMax: xHi };
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

  // Y-axis ticks: whole-number steps from 0 to yMax
  const yTicks = useMemo(() => {
    const out: number[] = [];
    for (let v = 0; v <= yMax; v += yStep) out.push(v);
    return out;
  }, [yMax, yStep]);

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
      className="cc-ov-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 45000,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.2s ease',
      }}
    >
      <div
        className="cc-ov-modal cc-ov-rb"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'none' : 'translateY(10px) scale(0.965)',
          transition: 'opacity 0.3s var(--cc-ease-out), transform 0.3s var(--cc-ease-out)',
        }}
      >
        {/* Header */}
        <div className="cc-ov-header">
          <ChartIcon />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="cc-ov-title">Round Breakdown</div>
            <div className="cc-ov-subtitle">
              End-of-round stats for each player. Click a metric to switch the view.
            </div>
          </div>
          <button
            className="cc-ov-close"
            onClick={onClose}
            aria-label="Close"
          ><Icon name="close" size={14} decorative /></button>
        </div>

        <div className="cc-ov-rb-body">
        {/* Metric selector — auto-fit grid stacks to 2 cols on phones, 1 col on tiny screens */}
        <div className="cc-ov-rb-metrics">
          {METRICS.map(m => {
            const selected = m.key === metric;
            return (
              <button
                key={m.key}
                className={`cc-ov-chip${selected ? ' is-active' : ''}`}
                onClick={() => setMetric(m.key)}
              >
                <Icon name={m.icon} size={13} decorative style={{ flexShrink: 0 }} />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>

        {/* Body — chart + legend */}
        {loading ? (
          <div className="cc-ov-rb-empty">Loading round data…</div>
        ) : error ? (
          <div className="cc-ov-rb-empty" style={{ color: '#ff8b97' }}>Failed to load: {error}</div>
        ) : rounds.length === 0 ? (
          <div className="cc-ov-rb-empty">No completed rounds yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Chart */}
            <div className="cc-ov-inset cc-ov-rb-chart">
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ display: 'block', width: '100%', height: 'auto' }}
              >
                {/* Soft fills under each player's line, fading to the axis */}
                <defs>
                  {series.map(s => (
                    <linearGradient key={s.pid} id={`rb-fill-${s.pid}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={s.color} stopOpacity={0.24} />
                      <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                    </linearGradient>
                  ))}
                  <radialGradient id="rb-dot-gloss" cx="35%" cy="30%" r="65%">
                    <stop offset="0%" stopColor="#fff" stopOpacity={0.7} />
                    <stop offset="45%" stopColor="#fff" stopOpacity={0} />
                  </radialGradient>
                </defs>
                {/* Y-axis grid + labels */}
                {yTicks.map(v => (
                  <g key={`y-${v}`}>
                    <line
                      x1={PAD_LEFT}
                      x2={CHART_W - PAD_RIGHT}
                      y1={yToPx(v)}
                      y2={yToPx(v)}
                      stroke={v === 0 ? 'rgba(232,196,106,0.35)' : 'rgba(232,196,106,0.1)'}
                      strokeDasharray={v === 0 ? undefined : '2 6'}
                      strokeWidth={1}
                    />
                    <text x={PAD_LEFT - 10} y={yToPx(v) + 4} textAnchor="end" className="cc-ov-rb-axis">{v}</text>
                  </g>
                ))}
                {/* Y-axis title (current metric) */}
                <text
                  x={14}
                  y={PAD_TOP + (CHART_H - PAD_TOP - PAD_BOTTOM) / 2}
                  textAnchor="middle"
                  transform={`rotate(-90 14 ${PAD_TOP + (CHART_H - PAD_TOP - PAD_BOTTOM) / 2})`}
                  className="cc-ov-rb-axis-title"
                >
                  {activeMetric.short}
                </text>
                {/* X-axis labels */}
                {xTicks.map(r => (
                  <text key={`x-${r}`} x={xToPx(r)} y={CHART_H - 14} textAnchor="middle" className="cc-ov-rb-axis cc-ov-rb-round">R{r}</text>
                ))}
                {/* Axis line */}
                <line x1={PAD_LEFT} x2={CHART_W - PAD_RIGHT} y1={CHART_H - PAD_BOTTOM} y2={CHART_H - PAD_BOTTOM} stroke="rgba(232,196,106,0.35)" strokeWidth={1} />
                <line x1={PAD_LEFT} x2={PAD_LEFT} y1={PAD_TOP} y2={CHART_H - PAD_BOTTOM} stroke="rgba(232,196,106,0.35)" strokeWidth={1} />

                {/* Player lines */}
                {series.map(s => {
                  if (s.points.length === 0) return null;
                  const polyPoints = s.points.map(p => `${xToPx(p.round)},${yToPx(p.value)}`).join(' ');
                  const lastPoint = s.points[s.points.length - 1];
                  const endsAtLeave = s.leftRound !== null && lastPoint.round === s.leftRound;
                  const opacity = s.leftRound !== null ? 0.65 : 1;
                  return (
                    <g key={s.pid} className="cc-ov-rb-line" style={{ opacity }}>
                      {s.points.length > 1 && (
                        <polygon
                          points={`${xToPx(s.points[0].round)},${yToPx(0)} ${polyPoints} ${xToPx(lastPoint.round)},${yToPx(0)}`}
                          fill={`url(#rb-fill-${s.pid})`}
                        />
                      )}
                      {/* Soft under-glow (a wide, faint stroke — no SVG filters) */}
                      <polyline
                        points={polyPoints}
                        fill="none"
                        stroke={s.color}
                        strokeOpacity={0.18}
                        strokeWidth={8}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
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
                              style={{ cursor: cursor('inspect') }}
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
                            style={{ cursor: cursor('inspect') }}
                          >
                            <circle
                              cx={cx}
                              cy={cy}
                              r={isEnd ? 6.5 : 5}
                              fill={s.color}
                              stroke="#0d0c22"
                              strokeWidth={2}
                            />
                            <circle cx={cx} cy={cy} r={isEnd ? 6.5 : 5} fill="url(#rb-dot-gloss)" pointerEvents="none" />
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
                    className="cc-ov-tooltip"
                    style={{
                      position: 'fixed',
                      left,
                      top,
                      zIndex: 50001,
                    }}
                  >
                    <div className="cc-ov-tooltip-title">Round {hover.round} · {activeMetric.short}</div>
                    {hover.entries.map(({ pid, value }) => {
                      const info = playerInfo.find(p => p.pid === pid);
                      if (!info) return null;
                      return (
                        <div key={pid} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: info.color }} />
                          <span style={{ color: info.color, fontWeight: 'bold' }}>{info.name}</span>
                          <span style={{ color: 'var(--cc-text)', marginLeft: 'auto', fontWeight: 'bold' }}>{value}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })(), document.body)}
            </div>

            {/* Legend */}
            {/* Legend: a plate per player with their latest value for the metric */}
            <div className="cc-ov-rb-legend">
              {series.map(info => {
                const latest = info.points.length > 0 ? info.points[info.points.length - 1].value : null;
                return (
                  <div
                    key={info.pid}
                    className="cc-ov-rb-legend-item"
                    style={{ opacity: info.leftRound !== null ? 0.55 : 1, ['--cc-player' as string]: info.color }}
                  >
                    <span className="cc-ov-rb-dot" style={{ background: info.color, color: info.color }} />
                    <span className="cc-ov-rb-legend-name">{info.name}</span>
                    {info.isCpu && <span className="cc-ov-rb-cpu">BOT</span>}
                    {info.leftRound !== null && (
                      <span style={{ color: 'var(--cc-text-faint)', fontSize: 11 }}>(left round {info.leftRound})</span>
                    )}
                    {latest !== null && (
                      <span className="cc-ov-rb-legend-value" title={`${activeMetric.label} after round ${info.points[info.points.length - 1].round}`}>
                        <Icon name={activeMetric.icon} size={12} decorative />
                        {latest}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
