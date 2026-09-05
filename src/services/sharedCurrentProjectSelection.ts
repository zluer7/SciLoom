export const SHARED_CURRENT_PROJECT_SELECTION_KEY =
  "researchpilot.sharedCurrentProjectSelection";

export type SharedCurrentProjectSelectionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

type ProjectIdentity = {
  id: string;
};

function getBrowserStorage(): SharedCurrentProjectSelectionStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(
  storage?: SharedCurrentProjectSelectionStorage | null
): SharedCurrentProjectSelectionStorage | null {
  return storage === undefined ? getBrowserStorage() : storage;
}

export function readSharedCurrentProjectSelection(
  storage?: SharedCurrentProjectSelectionStorage | null
): string | null {
  try {
    return resolveStorage(storage)
      ?.getItem(SHARED_CURRENT_PROJECT_SELECTION_KEY)
      ?.trim() || null;
  } catch {
    return null;
  }
}

export function writeSharedCurrentProjectSelection(
  projectId: string,
  storage?: SharedCurrentProjectSelectionStorage | null
): string | null {
  const concreteProjectId = projectId.trim();
  if (!concreteProjectId) {
    return readSharedCurrentProjectSelection(storage);
  }

  try {
    resolveStorage(storage)?.setItem(
      SHARED_CURRENT_PROJECT_SELECTION_KEY,
      concreteProjectId
    );
  } catch {
    // UI context continuity must not block the page when storage is unavailable.
  }
  return concreteProjectId;
}

export function clearSharedCurrentProjectSelection(
  storage?: SharedCurrentProjectSelectionStorage | null
) {
  try {
    resolveStorage(storage)?.removeItem(SHARED_CURRENT_PROJECT_SELECTION_KEY);
  } catch {
    // A missing storage surface already represents an empty UI preference.
  }
}

export function resolveSharedCurrentProjectSelection(
  projects: readonly ProjectIdentity[],
  storage?: SharedCurrentProjectSelectionStorage | null
): string {
  const sharedProjectId = readSharedCurrentProjectSelection(storage);
  if (
    sharedProjectId &&
    projects.some((project) => project.id === sharedProjectId)
  ) {
    return sharedProjectId;
  }

  const firstValidProjectId = projects[0]?.id.trim() || "";
  if (firstValidProjectId) {
    writeSharedCurrentProjectSelection(firstValidProjectId, storage);
    return firstValidProjectId;
  }

  clearSharedCurrentProjectSelection(storage);
  return "";
}
