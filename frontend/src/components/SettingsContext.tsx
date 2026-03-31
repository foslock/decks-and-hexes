import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type AnimationMode = 'normal' | 'simplified';

interface Settings {
  animationMode: AnimationMode;
}

interface SettingsContextValue {
  settings: Settings;
  setAnimationMode: (mode: AnimationMode) => void;
}

const STORAGE_KEY = 'hexdraft_settings';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { animationMode: parsed.animationMode || 'normal' };
    }
  } catch { /* ignore */ }
  return { animationMode: 'normal' };
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: { animationMode: 'normal' },
  setAnimationMode: () => {},
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

  return (
    <SettingsContext.Provider value={{ settings, setAnimationMode }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}

export function useAnimated() {
  const { settings } = useSettings();
  return settings.animationMode === 'normal';
}
