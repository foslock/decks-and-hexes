import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings, type AnimationMode, type VisualQuality } from './SettingsContext';
import { KEYWORDS } from './Keywords';
import { downloadGameLog } from '../utils/downloadGameLog';
import Icon from '../icons/Icon';

interface SettingsPanelProps {
  isMultiplayer?: boolean;
  isHost?: boolean;
  mapSeed?: string;
  gameId?: string;
  playerId?: string;
  onLeaveGame?: () => void;
  onEndGame?: () => void;
  onRotateGrid?: () => void;
}

export default function SettingsPanel({ isMultiplayer, isHost, mapSeed, gameId, playerId, onLeaveGame, onEndGame, onRotateGrid }: SettingsPanelProps) {
  const { settings, setAnimationMode, setTooltips, setSoundEnabled, setSoundVolume, setVisualQuality } = useSettings();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [glossarySearch, setGlossarySearch] = useState('');
  const [downloading, setDownloading] = useState(false);

  const keywordEntries = Object.entries(KEYWORDS);
  const filteredKeywords = keywordEntries.filter(([keyword, definition]) => {
    if (!glossarySearch) return true;
    const q = glossarySearch.toLowerCase();
    return keyword.toLowerCase().includes(q) || definition.toLowerCase().includes(q);
  });
  const closeGlossary = () => { setShowGlossary(false); setGlossarySearch(''); };
  const animClass = settings.animationMode !== 'off' ? ' cc-ov-anim' : '';

  return (
    <div className="cc-ov-set" style={{ padding: 0 }}>
      <div className="cc-ov-set-heading">SETTINGS</div>
      <div className="cc-ov-set-list">
        <div className="cc-ov-set-row">
          <span className="cc-ov-set-label">Animations:</span>
          <div className="cc-ov-seg">
            {(['normal', 'fast', 'off'] as AnimationMode[]).map((mode) => (
              <button
                key={mode}
                className={`cc-ov-seg-btn${settings.animationMode === mode ? ' is-active' : ''}`}
                onClick={() => setAnimationMode(mode)}
              >
                {mode === 'normal' ? 'Normal' : mode === 'fast' ? 'Fast' : 'Off'}
              </button>
            ))}
          </div>
        </div>
        <div className="cc-ov-set-row" title="Low turns off antialiasing for a smoother frame rate on large or high-resolution screens.">
          <span className="cc-ov-set-label">Visual Quality:</span>
          <div className="cc-ov-seg">
            {(['low', 'high'] as VisualQuality[]).map((q) => (
              <button
                key={q}
                className={`cc-ov-seg-btn${settings.visualQuality === q ? ' is-active' : ''}`}
                onClick={() => setVisualQuality(q)}
              >
                {q === 'low' ? 'Low' : 'High'}
              </button>
            ))}
          </div>
        </div>
        <div className="cc-ov-set-row">
          <span className="cc-ov-set-label">Tooltips:</span>
          <div className="cc-ov-seg">
            {([true, false] as const).map((on) => (
              <button
                key={String(on)}
                className={`cc-ov-seg-btn${settings.tooltips === on ? ' is-active' : ''}`}
                onClick={() => setTooltips(on)}
              >
                {on ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </div>
        <div className="cc-ov-set-row">
          <span className="cc-ov-set-label">Sound:</span>
          <div className="cc-ov-seg">
            {([true, false] as const).map((on) => (
              <button
                key={String(on)}
                className={`cc-ov-seg-btn${settings.soundEnabled === on ? ' is-active' : ''}`}
                onClick={() => setSoundEnabled(on)}
              >
                {on ? 'On' : 'Off'}
              </button>
            ))}
          </div>
          {settings.soundEnabled && (
            <input
              type="range"
              className="cc-ov-range"
              min={0}
              max={1}
              step={0.05}
              value={settings.soundVolume}
              onChange={(e) => setSoundVolume(parseFloat(e.target.value))}
              style={{ width: 64, ['--pct' as string]: `${Math.round(settings.soundVolume * 100)}%` }}
            />
          )}
        </div>

        {/* Rotate grid */}
        {onRotateGrid && (
          <div className="cc-ov-set-row">
            <span className="cc-ov-set-label">Grid:</span>
            <button
              className="cc-btn-secondary cc-ov-btn-sm"
              onClick={onRotateGrid}
              style={{ padding: '4px 10px' }}
            >
              Rotate 30°
            </button>
            <span className="cc-ov-kbd">R</span>
          </div>
        )}

        {/* Map seed (read-only) */}
        {mapSeed && (
          <>
            <div className="cc-ov-set-sep" />
            <div className="cc-ov-set-row">
              <span className="cc-ov-set-label">Map Seed:</span>
              <span
                className="cc-ov-mono"
                title="Click to copy"
                onClick={() => navigator.clipboard.writeText(mapSeed)}
              >
                {mapSeed}
              </span>
            </div>
          </>
        )}
        {/* Keyword Glossary */}
        <div className="cc-ov-set-sep" />
        <div>
          <button
            className="cc-btn-secondary cc-ov-btn-sm"
            onClick={() => setShowGlossary(true)}
            style={{ width: '100%' }}
          >
            Keyword Glossary
          </button>
        </div>

        {/* Download game log */}
        {gameId && (
          <div>
            <button
              className="cc-btn-secondary cc-ov-btn-sm"
              onClick={async () => {
                if (downloading) return;
                setDownloading(true);
                try {
                  await downloadGameLog(gameId, playerId);
                } catch (e) {
                  console.warn('downloadGameLog failed:', e);
                } finally {
                  setDownloading(false);
                }
              }}
              disabled={downloading}
              style={{
                width: '100%',
                color: 'var(--cc-text-dim)',
                cursor: downloading ? 'default' : 'pointer',
              }}
              title="Download the full structured game log as JSON"
            >
              {downloading ? 'Preparing…' : 'Download Game Log (JSON)'}
            </button>
          </div>
        )}
        {showGlossary && createPortal(
          <div
            className={`cc-ov-backdrop${animClass}`}
            onClick={closeGlossary}
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
              className={`cc-ov-modal${animClass}`}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '90%',
                maxWidth: 480,
                maxHeight: '80vh',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* Header */}
              <div className="cc-ov-header">
                <h3 className="cc-ov-title" style={{ flex: 1 }}>Keyword Glossary</h3>
                <button
                  className="cc-ov-close"
                  onClick={closeGlossary}
                  aria-label="Close"
                >
                  <Icon name="close" size={14} decorative />
                </button>
              </div>
              {/* Search bar */}
              <div style={{ padding: '12px 16px 4px' }}>
                <input
                  type="text"
                  className="cc-ov-input"
                  placeholder="Search keywords..."
                  value={glossarySearch}
                  onChange={(e) => setGlossarySearch(e.target.value)}
                  autoFocus
                />
              </div>
              {/* Keywords list */}
              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px 16px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}>
                {filteredKeywords.map(([keyword, definition]) => (
                  <div key={keyword} className="cc-ov-kw">
                    <span className="cc-ov-kw-name">{keyword}</span>
                    <span style={{ color: 'var(--cc-text-faint)' }}> — </span>
                    <span className="cc-ov-kw-def">{definition}</span>
                  </div>
                ))}
                {filteredKeywords.length === 0 && (
                  <div style={{ color: 'var(--cc-text-faint)', textAlign: 'center', padding: 16, fontSize: 13 }}>
                    No keywords match “{glossarySearch}”.
                  </div>
                )}
              </div>
              {/* Footer */}
              <div className="cc-ov-footer">
                {glossarySearch
                  ? `${filteredKeywords.length} of ${keywordEntries.length} keywords`
                  : `${keywordEntries.length} keywords`
                } · Click outside or press close to dismiss
              </div>
            </div>
          </div>,
          document.body,
        )}

        {/* Multiplayer game controls */}
        {isMultiplayer && (
          <>
          <div className="cc-ov-set-sep" />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {onLeaveGame && (
              confirmLeave ? (
                <div className="cc-ov-confirm">
                  <span className="cc-ov-confirm-text">Leave? Tiles go neutral.</span>
                  <button
                    className="cc-ov-btn-danger is-solid cc-ov-btn-sm"
                    onClick={() => { onLeaveGame(); setConfirmLeave(false); }}
                    style={{ padding: '3px 10px' }}
                  >
                    Yes
                  </button>
                  <button
                    className="cc-btn-secondary cc-ov-btn-sm"
                    onClick={() => setConfirmLeave(false)}
                    style={{ padding: '3px 10px' }}
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  className="cc-ov-btn-danger cc-ov-btn-sm"
                  onClick={() => setConfirmLeave(true)}
                  style={{ flex: 1 }}
                >
                  Leave Game
                </button>
              )
            )}
            {isHost && onEndGame && (
              confirmEnd ? (
                <div className="cc-ov-confirm">
                  <span className="cc-ov-confirm-text">End for everyone?</span>
                  <button
                    className="cc-ov-btn-danger is-solid cc-ov-btn-sm"
                    onClick={() => { onEndGame(); setConfirmEnd(false); }}
                    style={{ padding: '3px 10px' }}
                  >
                    Yes
                  </button>
                  <button
                    className="cc-btn-secondary cc-ov-btn-sm"
                    onClick={() => setConfirmEnd(false)}
                    style={{ padding: '3px 10px' }}
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  className="cc-ov-btn-danger cc-ov-btn-sm"
                  onClick={() => setConfirmEnd(true)}
                  style={{ flex: 1 }}
                >
                  End Game
                </button>
              )
            )}
          </div>
          </>
        )}
      </div>
    </div>
  );
}
