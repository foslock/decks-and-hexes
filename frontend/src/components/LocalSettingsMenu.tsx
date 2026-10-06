import { useEffect, useRef, useState } from 'react';
import { useSettings, type AnimationMode, type VisualQuality } from './SettingsContext';
import Icon from '../icons/Icon';
import { soundEngine } from '../audio/SoundEngine';

/** Let go of the Sounds slider: play a card being laid down at the new level. */
export function previewSoundLevel(v: number): void {
  soundEngine.setVolume(v);
  soundEngine.cardPlay();
}

/** On / Off plus a volume slider (dimmed while off). */
export function VolumeControl({ on, volume, onToggle, onVolume, onRelease, label, segClass, segBtnClass }: {
  on: boolean;
  volume: number;
  onToggle: (on: boolean) => void;
  onVolume: (v: number) => void;
  /** The slider was let go (pointer up, or a key released) at this level. */
  onRelease?: (v: number) => void;
  label: string;
  /** The segmented control's classes (screens and in-game overlays differ). */
  segClass: string;
  segBtnClass: string;
}) {
  return (
    // Never wider than its row: the slider gives way first.
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flex: '0 1 auto', minWidth: 0 }}>
      <div className={segClass}>
        {([true, false] as const).map((v) => (
          <button
            key={String(v)}
            onClick={() => onToggle(v)}
            className={`${segBtnClass}${on === v ? ' is-active' : ''}`}
          >
            {v ? 'On' : 'Off'}
          </button>
        ))}
      </div>
      <input
        type="range"
        className="cc-ov-range"
        aria-label={`${label} volume`}
        min={0}
        max={1}
        step={0.05}
        value={volume}
        disabled={!on}
        onChange={(e) => onVolume(parseFloat(e.target.value))}
        onPointerUp={(e) => onRelease?.(parseFloat(e.currentTarget.value))}
        onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) onRelease?.(parseFloat(e.currentTarget.value)); }}
        style={{ width: 72, flex: '0 1 72px', minWidth: 40, opacity: on ? 1 : 0.35, ['--pct' as string]: `${Math.round(volume * 100)}%` }}
      />
    </div>
  );
}

/**
 * The settings gear for the home and lobby screens (top right): this
 * device's animations, visual quality, tooltips, music and sounds.
 */
export default function LocalSettingsMenu() {
  const {
    settings, setAnimationMode, setTooltips, setVisualQuality,
    setMusicEnabled, setMusicVolume, setSoundEnabled, setSoundVolume,
  } = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="cc-scr-gear-wrap">
      <button
        onClick={() => setOpen(p => !p)}
        className={`cc-btn-secondary cc-scr-gear${open ? ' is-open' : ''}`}
        title="Settings"
        aria-label="Settings"
        aria-expanded={open}
      >
        <Icon name="settings" size={20} decorative />
      </button>
      {open && (
        <div className="cc-panel cc-scr-gear-pop">
          <div className="cc-scr-eyebrow">Local Settings</div>
          <div className="cc-scr-gear-row">
            <span>Animations</span>
            <div className="cc-scr-seg cc-scr-seg-sm">
              {(['normal', 'fast'] as AnimationMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setAnimationMode(mode)}
                  className={`cc-scr-seg-btn${settings.animationMode === mode ? ' is-active' : ''}`}
                >
                  {mode === 'normal' ? 'Normal' : 'Fast'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-scr-gear-row" title="Low renders the board at standard resolution without antialiasing, for a smoother frame rate on large or high-resolution screens.">
            <span>Visual Quality</span>
            <div className="cc-scr-seg cc-scr-seg-sm">
              {(['low', 'high'] as VisualQuality[]).map((q) => (
                <button
                  key={q}
                  onClick={() => setVisualQuality(q)}
                  className={`cc-scr-seg-btn${settings.visualQuality === q ? ' is-active' : ''}`}
                >
                  {q === 'low' ? 'Low' : 'High'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-scr-gear-row">
            <span>Tooltips</span>
            <div className="cc-scr-seg cc-scr-seg-sm">
              {([true, false] as const).map((on) => (
                <button
                  key={String(on)}
                  onClick={() => setTooltips(on)}
                  className={`cc-scr-seg-btn${settings.tooltips === on ? ' is-active' : ''}`}
                >
                  {on ? 'On' : 'Off'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-scr-gear-row">
            <span>Music</span>
            <VolumeControl
              label="Music"
              on={settings.musicEnabled}
              volume={settings.musicVolume}
              onToggle={setMusicEnabled}
              onVolume={setMusicVolume}
              segClass="cc-scr-seg cc-scr-seg-sm"
              segBtnClass="cc-scr-seg-btn"
            />
          </div>
          <div className="cc-scr-gear-row">
            <span>Sounds</span>
            <VolumeControl
              label="Sounds"
              on={settings.soundEnabled}
              volume={settings.soundVolume}
              onToggle={setSoundEnabled}
              onVolume={setSoundVolume}
              onRelease={previewSoundLevel}
              segClass="cc-scr-seg cc-scr-seg-sm"
              segBtnClass="cc-scr-seg-btn"
            />
          </div>
        </div>
      )}
    </div>
  );
}
