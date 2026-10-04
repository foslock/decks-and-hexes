import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type AnimationMode = 'normal' | 'fast' | 'off';
/** Board rendering quality. Low turns off antialiasing and renders at a 1x
 *  pixel ratio, for a faster frame rate. */
export type VisualQuality = 'high' | 'low';

interface Settings {
  animationMode: AnimationMode;
  tooltips: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  visualQuality: VisualQuality;
}

interface SettingsContextValue {
  settings: Settings;
  setAnimationMode: (mode: AnimationMode) => void;
  setTooltips: (on: boolean) => void;
  setSoundEnabled: (on: boolean) => void;
  setSoundVolume: (v: number) => void;
  setVisualQuality: (q: VisualQuality) => void;
}

const STORAGE_KEY = 'cardclash_settings';

const DEFAULT_SETTINGS: Settings = {
  animationMode: 'normal', tooltips: true, soundEnabled: true, soundVolume: 0.5, visualQuality: 'high',
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        animationMode: parsed.animationMode || 'normal',
        tooltips: parsed.tooltips !== false,  // default true
        soundEnabled: parsed.soundEnabled !== false,  // default true
        soundVolume: typeof parsed.soundVolume === 'number' ? parsed.soundVolume : 0.5,
        visualQuality: parsed.visualQuality === 'low' ? 'low' : 'high',
      };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  setAnimationMode: () => {},
  setTooltips: () => {},
  setSoundEnabled: () => {},
  setSoundVolume: () => {},
  setVisualQuality: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const setAnimationMode = useCallback((mode: AnimationMode) => {
    setSettings((prev) => {
      const next = { ...prev, animationMode: mode };
      saveSettings(next);
      return next;
    });
  }, []);

  const setTooltips = useCallback((on: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, tooltips: on };
      saveSettings(next);
      return next;
    });
  }, []);

  const setSoundEnabled = useCallback((on: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, soundEnabled: on };
      saveSettings(next);
      return next;
    });
  }, []);

  const setSoundVolume = useCallback((v: number) => {
    setSettings((prev) => {
      const next = { ...prev, soundVolume: v };
      saveSettings(next);
      return next;
    });
  }, []);

  const setVisualQuality = useCallback((q: VisualQuality) => {
    setSettings((prev) => {
      const next = { ...prev, visualQuality: q };
      saveSettings(next);
      return next;
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, setAnimationMode, setTooltips, setSoundEnabled, setSoundVolume, setVisualQuality }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}

export function useAnimated() {
  const { settings } = useSettings();
  return settings.animationMode !== 'off';
}

/** Returns duration multiplier: 1.0 for normal, 0.5 for fast, 0 for off */
export function useAnimationSpeed() {
  const { settings } = useSettings();
  return settings.animationMode === 'fast' ? 0.5 : settings.animationMode === 'off' ? 0 : 1;
}

/** Duration multiplier for the resolution sequence (the reveal, each tile
 *  resolving, played cards going home). On Normal it runs a touch slower than
 *  the rest of the UI so each step can be followed; Fast and Off are as usual. */
export const RESOLVE_NORMAL_PACE = 1.2;
export function useResolveSpeed() {
  const speed = useAnimationSpeed();
  return speed === 1 ? RESOLVE_NORMAL_PACE : speed;
}

export function useAnimationOff() {
  const { settings } = useSettings();
  return settings.animationMode === 'off';
}

export function useAnimationMode() {
  const { settings } = useSettings();
  return settings.animationMode;
}

export function useTooltips() {
  const { settings } = useSettings();
  return settings.tooltips;
}

export function useVisualQuality() {
  const { settings } = useSettings();
  return settings.visualQuality;
}
