import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings, type AnimationMode } from './SettingsContext';
import { KEYWORDS } from './Keywords';

interface SettingsPanelProps {
  isMultiplayer?: boolean;
  isHost?: boolean;
  mapSeed?: string;
  onLeaveGame?: () => void;
  onEndGame?: () => void;
  onRotateGrid?: () => void;
}

export default function SettingsPanel({ isMultiplayer, isHost, mapSeed, onLeaveGame, onEndGame, onRotateGrid }: SettingsPanelProps) {
  const { settings, setAnimationMode, setTooltips, setSoundEnabled, setSoundVolume } = useSettings();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [glossarySearch, setGlossarySearch] = useState('');

  return (
    <div style={{ padding: 0 }}>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>SETTINGS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#aaa' }}>Animations:</span>
          {(['normal', 'fast', 'off'] as AnimationMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setAnimationMode(mode)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                background: settings.animationMode === mode ? '#4a9eff' : '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 4,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {mode === 'normal' ? 'Normal' : mode === 'fast' ? 'Fast' : 'Off'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#aaa' }}>Tooltips:</span>
          {([true, false] as const).map((on) => (
            <button
              key={String(on)}
              onClick={() => setTooltips(on)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                background: settings.tooltips === on ? '#4a9eff' : '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 4,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {on ? 'On' : 'Off'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#aaa' }}>Sound:</span>
          {([true, false] as const).map((on) => (
            <button
              key={String(on)}
              onClick={() => setSoundEnabled(on)}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                background: settings.soundEnabled === on ? '#4a9eff' : '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 4,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {on ? 'On' : 'Off'}
            </button>
          ))}
          {settings.soundEnabled && (
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.soundVolume}
              onChange={(e) => setSoundVolume(parseFloat(e.target.value))}
              style={{ width: 60, accentColor: '#4a9eff' }}
            />
          )}
        </div>

        {/* Rotate grid */}
        {onRotateGrid && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#aaa' }}>Grid:</span>
            <button
              onClick={onRotateGrid}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                background: '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 4,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Rotate 30°
            </button>
            <span style={{ fontSize: 10, color: '#555' }}>R</span>
          </div>
        )}

        {/* Map seed (read-only) */}
        {mapSeed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderTop: '1px solid #333', paddingTop: 6 }}>
            <span style={{ fontSize: 12, color: '#aaa' }}>Map Seed:</span>
            <span
              style={{
                fontSize: 12,
                color: '#fff',
                fontFamily: 'monospace',
                letterSpacing: 1,
                background: '#2a2a3e',
                padding: '2px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                userSelect: 'all',
              }}
              title="Click to copy"
              onClick={() => navigator.clipboard.writeText(mapSeed)}
            >
              {mapSeed}
            </span>
          </div>
        )}
        {/* Keyword Glossary */}
        <div style={{ borderTop: '1px solid #333', paddingTop: 6 }}>
          <button
            onClick={() => setShowGlossary(true)}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              background: '#2a2a3e',
              border: '1px solid #555',
              borderRadius: 4,
              color: '#fff',
              cursor: 'pointer',
              width: '100%',
            }}
          >
            Keyword Glossary
          </button>
        </div>
        {showGlossary && createPortal(
          <div
            onClick={() => { setShowGlossary(false); setGlossarySearch(''); }}
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
                maxWidth: 480,
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
              }}>
                <h3 style={{ margin: 0, flex: 1, color: '#fff' }}>Keyword Glossary</h3>
                <button
                  onClick={() => { setShowGlossary(false); setGlossarySearch(''); }}
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
              {/* Search bar */}
              <div style={{ padding: '8px 16px 0' }}>
                <input
                  type="text"
                  placeholder="Search keywords..."
                  value={glossarySearch}
                  onChange={(e) => setGlossarySearch(e.target.value)}
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: 13,
                    background: '#1e1e3a',
                    border: '1px solid #555',
                    borderRadius: 6,
                    color: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              {/* Keywords list */}
              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}>
                {Object.entries(KEYWORDS)
                  .filter(([keyword, definition]) => {
                    if (!glossarySearch) return true;
                    const q = glossarySearch.toLowerCase();
                    return keyword.toLowerCase().includes(q) || definition.toLowerCase().includes(q);
                  })
                  .map(([keyword, definition]) => (
                  <div key={keyword} style={{
                    fontSize: 13,
                    lineHeight: 1.5,
                    padding: '6px 10px',
                    background: '#1e1e3a',
                    borderRadius: 6,
                    border: '1px solid #2a2a4e',
                  }}>
                    <span style={{ color: '#fff', fontWeight: 'bold' }}>{keyword}</span>
                    <span style={{ color: '#555' }}> — </span>
                    <span style={{ color: '#aaa' }}>{definition}</span>
                  </div>
                ))}
              </div>
              {/* Footer */}
              <div style={{
                padding: '8px 16px',
                borderTop: '1px solid #333',
                fontSize: 12,
                color: '#666',
                textAlign: 'center',
              }}>
                {glossarySearch
                  ? `${Object.entries(KEYWORDS).filter(([k, d]) => { const q = glossarySearch.toLowerCase(); return k.toLowerCase().includes(q) || d.toLowerCase().includes(q); }).length} of ${Object.keys(KEYWORDS).length} keywords`
                  : `${Object.keys(KEYWORDS).length} keywords`
                } · Click outside or ✕ to close
              </div>
            </div>
          </div>,
          document.body,
        )}

        {/* Multiplayer game controls */}
        {isMultiplayer && (
          <div style={{ display: 'flex', gap: 6, marginTop: 4, borderTop: '1px solid #333', paddingTop: 6 }}>
            {onLeaveGame && (
              confirmLeave ? (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#ff6666' }}>Leave? Tiles go neutral.</span>
                  <button
                    onClick={() => { onLeaveGame(); setConfirmLeave(false); }}
                    style={{
                      padding: '2px 8px', fontSize: 11,
                      background: '#cc2a2a', border: 'none',
                      borderRadius: 4, color: '#fff', cursor: 'pointer',
                    }}
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmLeave(false)}
                    style={{
                      padding: '2px 8px', fontSize: 11,
                      background: '#2a2a3e', border: '1px solid #555',
                      borderRadius: 4, color: '#fff', cursor: 'pointer',
                    }}
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmLeave(true)}
                  style={{
                    padding: '4px 10px', fontSize: 11,
                    background: '#2a2a3e', border: '1px solid #555',
                    borderRadius: 4, color: '#ff6666', cursor: 'pointer',
                    flex: 1,
                  }}
                >
                  Leave Game
                </button>
              )
            )}
            {isHost && onEndGame && (
              confirmEnd ? (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#ff6666' }}>End for everyone?</span>
                  <button
                    onClick={() => { onEndGame(); setConfirmEnd(false); }}
                    style={{
                      padding: '2px 8px', fontSize: 11,
                      background: '#cc2a2a', border: 'none',
                      borderRadius: 4, color: '#fff', cursor: 'pointer',
                    }}
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmEnd(false)}
                    style={{
                      padding: '2px 8px', fontSize: 11,
                      background: '#2a2a3e', border: '1px solid #555',
                      borderRadius: 4, color: '#fff', cursor: 'pointer',
                    }}
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmEnd(true)}
                  style={{
                    padding: '4px 10px', fontSize: 11,
                    background: '#2a2a3e', border: '1px solid #555',
                    borderRadius: 4, color: '#ff6666', cursor: 'pointer',
                    flex: 1,
                  }}
                >
                  End Game
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
