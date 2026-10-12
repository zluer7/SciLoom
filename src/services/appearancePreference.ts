export type AppearancePreference = "SYSTEM" | "LIGHT" | "DARK";
export type EffectiveTheme = "light" | "dark";

// Same browser/WebView UI-preference substrate as researchpilot.language.
export const APPEARANCE_PREFERENCE_KEY = "researchpilot.appearance";

export function normalizeAppearancePreference(value: unknown): AppearancePreference {
  return value === "LIGHT" || value === "DARK" ? value : "SYSTEM";
}

export function readAppearancePreference(): AppearancePreference {
  try {
    return normalizeAppearancePreference(window.localStorage.getItem(APPEARANCE_PREFERENCE_KEY));
  } catch {
    return "SYSTEM";
  }
}

export function writeAppearancePreference(preference: AppearancePreference): void {
  // One synchronous settlement: later selections cannot be overwritten by an
  // initialization promise, old save result, or delayed failure rollback.
  const storage = window.localStorage;
  storage.setItem(APPEARANCE_PREFERENCE_KEY, preference);
  if (storage.getItem(APPEARANCE_PREFERENCE_KEY) !== preference) {
    throw new Error("Appearance preference persistence could not be verified.");
  }
}

export function getSystemSchemeQuery(): MediaQueryList | undefined {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return undefined;
  }
}

export function readSystemScheme(): EffectiveTheme {
  return getSystemSchemeQuery()?.matches ? "dark" : "light";
}

export function resolveEffectiveTheme(preference: AppearancePreference, system: EffectiveTheme): EffectiveTheme {
  return preference === "SYSTEM" ? system : preference === "DARK" ? "dark" : "light";
}

export function applyAppearance(preference: AppearancePreference, system: EffectiveTheme): EffectiveTheme {
  const effective = resolveEffectiveTheme(preference, system);
  document.documentElement.dataset.appearance = preference;
  document.documentElement.dataset.theme = effective;
  return effective;
}

export function initializeAppearance(): void {
  applyAppearance(readAppearancePreference(), readSystemScheme());
}
