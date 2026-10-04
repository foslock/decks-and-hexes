import { useState, useEffect, useRef } from 'react';
import * as api from '../api/client';
import { useAnimationMode } from './SettingsContext';
import type { LogEntry } from '../api/client';
import Icon from '../icons/Icon';
import { renderUpgradedNames } from './CardName';
import { useCardCatalog } from '../cardCatalog';

interface FullGameLogProps {
  gameId: string;
  playerId?: string;
  mapSeed?: string;
  onClose: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  start_of_turn: 'Start',
  play: 'Play',
  reveal: 'Resolve',
  buy: 'Buy',
  end_of_turn: 'End',
  setup: 'Setup',
  game_over: 'Game Over',
};

export default function FullGameLog({ gameId, playerId, mapSeed, onClose }: FullGameLogProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterRound, setFilterRound] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const animClass = useAnimationMode() !== 'off' ? ' cc-ov-anim' : '';
  const catalog = useCardCatalog();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getGameLog(gameId, playerId).then((data) => {
      if (!cancelled) {
        setEntries(data.entries);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [gameId, playerId]);

  useEffect(() => {
    if (bottomRef.current && typeof bottomRef.current.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries.length]);

  const rounds = [...new Set(entries.map((e) => e.round))].sort((a, b) => a - b);
  const filtered = filterRound !== null
    ? entries.filter((e) => e.round === filterRound)
    : entries;

  const handleDownload = () => {
    const lines = entries.map((e) => {
      const phase = PHASE_LABELS[e.phase] || e.phase;
      return `R${e.round} [${phase}] ${e.message}`;
    });
    const text = lines.join('\n');
    const date = new Date().toISOString().slice(0, 10);
    const seed = mapSeed || 'unknown';
    const filename = `game-log_seed-${seed}_${date}.txt`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className={`cc-ov-backdrop${animClass}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}
    >
      <div
        className={`cc-ov-modal cc-ov-log-modal${animClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="cc-ov-header">
          <h3 className="cc-ov-title" style={{ flex: 1 }}>Game Log</h3>

          <button
            className="cc-btn-secondary cc-ov-btn-sm"
            onClick={handleDownload}
            disabled={entries.length === 0}
            style={{ cursor: entries.length > 0 ? 'pointer' : 'not-allowed' }}
          >
            Download
          </button>
          <button
            className="cc-ov-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" size={14} decorative />
          </button>
        </div>

        {/* Round filter */}
        <div className="cc-ov-log-filter">
          <span className="cc-ov-log-filter-label">Round:</span>
          <button
            className={`cc-ov-chip${filterRound === null ? ' is-active' : ''}`}
            onClick={() => setFilterRound(null)}
          >
            All
          </button>
          {rounds.map((r) => (
            <button
              key={r}
              className={`cc-ov-chip${filterRound === r ? ' is-active' : ''}`}
              onClick={() => setFilterRound(r)}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Log entries */}
        <div className="cc-ov-inset cc-ov-log-list">
          {loading ? (
            <div className="cc-ov-log-empty">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="cc-ov-log-empty">No log entries</div>
          ) : (
            filtered.map((entry, i) => (
              <div
                key={i}
                className={`cc-ov-log-row${entry.message.startsWith('===') ? ' is-header' : ''}`}
              >
                <span className="cc-ov-log-round">
                  R{entry.round}
                </span>
                <span className="cc-ov-log-phase" data-phase={entry.phase}>
                  {PHASE_LABELS[entry.phase] || entry.phase}
                </span>
                <span className="cc-ov-log-msg">
                  {renderUpgradedNames(entry.message, catalog.upgradedNamePattern)}
                </span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div className="cc-ov-footer">
          {filtered.length} entries · Click outside or press close to dismiss
        </div>
      </div>
    </div>
  );
}
