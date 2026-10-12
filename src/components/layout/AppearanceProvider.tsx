import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyAppearance, getSystemSchemeQuery, readAppearancePreference, readSystemScheme,
  resolveEffectiveTheme, writeAppearancePreference, type AppearancePreference, type EffectiveTheme
} from "../../services/appearancePreference";

interface AppearanceState {
  preference: AppearancePreference;
  effectiveTheme: EffectiveTheme;
  saveFailed: boolean;
  setPreference: (preference: AppearancePreference) => void;
}

const AppearanceContext = createContext<AppearanceState | undefined>(undefined);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readAppearancePreference);
  const [system, setSystem] = useState(readSystemScheme);
  const [saveFailed, setSaveFailed] = useState(false);

  useLayoutEffect(() => {
    const query = getSystemSchemeQuery();
    if (!query) return;
    const update = () => setSystem(query.matches ? "dark" : "light");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    applyAppearance(preference, system);
  }, [preference, system]);

  const setPreference = useCallback((next: AppearancePreference) => {
    try {
      writeAppearancePreference(next);
      setPreferenceState(next);
      setSystem(readSystemScheme());
      setSaveFailed(false);
    } catch {
      // Retain the last settled presentation. A committed write whose readback
      // failed is also unconfirmed; never report persistence success for it.
      setSaveFailed(true);
    }
  }, []);

  const value = useMemo(() => ({
    preference, effectiveTheme: resolveEffectiveTheme(preference, system), saveFailed, setPreference
  }), [preference, system, saveFailed, setPreference]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceState {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("AppearanceProvider is required.");
  return value;
}
