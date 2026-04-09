import { useState, useEffect, useRef } from 'react';
import * as api from '../api/client';
import type { LogEntry } from '../api/client';

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
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '90%',
          maxWidth: 640,
          maxHeight: '80vh',
          background: '#1a1a2e',
          border: '2px solid #333',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <h3 style={{ margin: 0, flex: 1, color: '#fff' }}>Game Log</h3>

          {/* Round filter */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#888' }}>Round:</span>
            <button
              onClick={() => setFilterRound(null)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                background: filterRound === null ? '#4a9eff' : '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 4,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              All
            </button>
            {rounds.map((r) => (
              <button
                key={r}
                onClick={() => setFilterRound(r)}
                style={{
                  padding: '2px 8px',
                  fontSize: 11,
                  background: filterRound === r ? '#4a9eff' : '#2a2a3e',
                  border: '1px solid #555',
                  borderRadius: 4,
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {r}
              </button>
            ))}
          </div>

          <button
            onClick={handleDownload}
            disabled={entries.length === 0}
            style={{
              padding: '4px 12px',
              background: entries.length > 0 ? '#2a5a2e' : '#333',
              border: '1px solid #555',
              borderRadius: 4,
              color: entries.length > 0 ? '#fff' : '#555',
              cursor: entries.length > 0 ? 'pointer' : 'not-allowed',
              fontSize: 12,
            }}
          >
            Download
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '4px 12px',
              background: '#333',
              border: 'none',
              borderRadius: 4,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>

        {/* Log entries */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: 12,
          fontFamily: 'monospace',
          fontSize: 13,
        }}>
          {loading ? (
            <div style={{ color: '#888', textAlign: 'center', padding: 20 }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ color: '#888', textAlign: 'center', padding: 20 }}>No log entries</div>
          ) : (
            filtered.map((entry, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 8,
                  marginBottom: 4,
                  padding: '3px 0',
                  borderBottom: '1px solid #1e1e30',
                }}
              >
                <span style={{
                  minWidth: 24,
                  color: '#555',
                  fontSize: 11,
                  textAlign: 'right',
                }}>
                  R{entry.round}
                </span>
                <span style={{
                  minWidth: 48,
                  color: '#666',
                  fontSize: 11,
                }}>
                  {PHASE_LABELS[entry.phase] || entry.phase}
                </span>
                <span style={{
                  color: entry.message.startsWith('===') ? '#4a9eff' : '#ccc',
                  fontWeight: entry.message.startsWith('===') ? 'bold' : 'normal',
                }}>
                  {entry.message}
                </span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div style={{
          padding: '8px 16px',
          borderTop: '1px solid #333',
          fontSize: 12,
          color: '#666',
          textAlign: 'center',
        }}>
          {filtered.length} entries · Click outside or ✕ to close
        </div>
      </div>
    </div>
  );
}
