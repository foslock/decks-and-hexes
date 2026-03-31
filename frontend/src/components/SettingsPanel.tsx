import { useSettings, type AnimationMode } from './SettingsContext';

export default function SettingsPanel() {
  const { settings, setAnimationMode } = useSettings();

  return (
    <div style={{ padding: 8, borderTop: '1px solid #333' }}>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>SETTINGS</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: '#aaa' }}>Animations:</span>
        {(['normal', 'simplified'] as AnimationMode[]).map((mode) => (
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
            {mode === 'normal' ? 'Normal' : 'Simplified'}
          </button>
        ))}
      </div>
    </div>
  );
}
