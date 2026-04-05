import { useState } from 'react';
import { useSettings, type AnimationMode } from './SettingsContext';

interface SettingsPanelProps {
  isMultiplayer?: boolean;
  isHost?: boolean;
  onLeaveGame?: () => void;
  onEndGame?: () => void;
}

export default function SettingsPanel({ isMultiplayer, isHost, onLeaveGame, onEndGame }: SettingsPanelProps) {
  const { settings, setAnimationMode, setTooltips, setSoundEnabled, setSoundVolume } = useSettings();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

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
