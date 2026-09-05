export type DataSourceMode = "auto" | "sqlite" | "localStorage";
export type EffectiveDataSourceMode = Exclude<DataSourceMode, "auto">;
export type DataSourceResolutionState =
  | "RESOLVED_AUTO"
  | "MATCHED_EXPLICIT"
  | "NON_TAURI_FALLBACK";

export interface DataSourceModeSnapshot {
  selectedMode: DataSourceMode;
  effectiveMode: EffectiveDataSourceMode;
  resolutionState: DataSourceResolutionState;
}

const DATA_SOURCE_MODE_KEY = "researchpilot.dataSourceMode";
export const DATA_SOURCE_MODE_CHANGE_EVENT = "researchpilot:data-source-mode-change";

export function isDataSourceMode(value: unknown): value is DataSourceMode {
  return value === "auto" || value === "sqlite" || value === "localStorage";
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getDataSourceMode(): DataSourceMode {
  if (typeof window === "undefined" || !window.localStorage) {
    return "auto";
  }

  const stored = window.localStorage.getItem(DATA_SOURCE_MODE_KEY);
  return isDataSourceMode(stored) ? stored : "auto";
}

export function setDataSourceMode(mode: DataSourceMode): DataSourceMode {
  if (typeof window === "undefined" || !window.localStorage) {
    return getDataSourceMode();
  }

  window.localStorage.setItem(DATA_SOURCE_MODE_KEY, mode);
  const canonicalReadback = getDataSourceMode();
  window.dispatchEvent(new CustomEvent(DATA_SOURCE_MODE_CHANGE_EVENT, {
    detail: { mode: canonicalReadback }
  }));
  return canonicalReadback;
}

export function projectDataSourceMode(
  mode: DataSourceMode,
  tauriRuntime: boolean
): DataSourceModeSnapshot {
  if (mode === "localStorage") {
    return {
      selectedMode: mode,
      effectiveMode: "localStorage",
      resolutionState: "MATCHED_EXPLICIT"
    };
  }

  if (mode === "sqlite") {
    return {
      selectedMode: mode,
      effectiveMode: tauriRuntime ? "sqlite" : "localStorage",
      resolutionState: tauriRuntime ? "MATCHED_EXPLICIT" : "NON_TAURI_FALLBACK"
    };
  }

  return {
    selectedMode: mode,
    effectiveMode: tauriRuntime ? "sqlite" : "localStorage",
    resolutionState: "RESOLVED_AUTO"
  };
}

export function getDataSourceModeSnapshot(): DataSourceModeSnapshot {
  return projectDataSourceMode(getDataSourceMode(), isTauriRuntime());
}

export function resolveDataSourceMode(): EffectiveDataSourceMode {
  return getDataSourceModeSnapshot().effectiveMode;
}
