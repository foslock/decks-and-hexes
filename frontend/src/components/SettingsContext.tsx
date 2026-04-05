import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type AnimationMode = 'normal' | 'fast' | 'off';

interface Settings {
  animationMode: AnimationMode;
  tooltips: boolean;
}

interface SettingsContextValue {
  settings: Settings;
  setAnimationMode: (mode: AnimationMode) => void;
  setTooltips: (on: boolean) => void;
}

const STORAGE_KEY = 'cardclash_settings';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        animationMode: parsed.animationMode || 'normal',
        tooltips: parsed.tooltips !== false,  // default true
      };
    }
  } catch { /* ignore */ }
  return { animationMode: 'normal', tooltips: true };
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: { animationMode: 'normal', tooltips: true },
  setAnimationMode: () => {},
  setTooltips: () => {},
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

  return (
    <SettingsContext.Provider value={{ settings, setAnimationMode, setTooltips }}>
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
