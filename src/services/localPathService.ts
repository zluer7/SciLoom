function removeFileUrlPrefix(value: string) {
  if (!/^file:\/\//i.test(value)) {
    return value;
  }

  const withoutScheme = value.slice("file://".length);
  if (/^\/[A-Za-z]:[\\/]/.test(withoutScheme)) {
    return withoutScheme.slice(1);
  }
  if (/^[A-Za-z]:[\\/]/.test(withoutScheme) || withoutScheme.startsWith("/")) {
    return withoutScheme;
  }
  return `//${withoutScheme}`;
}

export function normalizePathInput(path: string) {
  return removeFileUrlPrefix(path.trim());
}

function pathSegments(path: string) {
  return normalizePathInput(path)
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .filter(Boolean);
}

function preferredSeparator(path: string) {
  const normalized = normalizePathInput(path);
  return normalized.includes("\\") && !normalized.includes("/") ? "\\" : "/";
}

export function getPathDisplayName(path: string) {
  const normalized = normalizePathInput(path);
  const segments = pathSegments(normalized);
  return segments[segments.length - 1] ?? normalized;
}

export function summarizePath(path: string) {
  const normalized = normalizePathInput(path);
  if (!normalized) {
    return "";
  }

  const segments = pathSegments(normalized);
  if (segments.length === 0) {
    return "";
  }
  if (segments.length === 1) {
    return segments[0];
  }

  const separator = preferredSeparator(normalized);
  return `…${separator}${segments.slice(-2).join(separator)}`;
}

export function isLikelyAbsoluteLocalPath(path: string) {
  const normalized = normalizePathInput(path);
  return (
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    /^\\\\[^\\]/.test(normalized) ||
    /^\/\/[^/]/.test(normalized) ||
    normalized.startsWith("/")
  );
}

export function isWindowsAbsoluteLocalPath(path: string) {
  const normalized = normalizePathInput(path);
  return (
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    /^\\\\[^\\]/.test(normalized) ||
    /^\/\/[^/]/.test(normalized)
  );
}

export const localPathService = {
  normalizePathInput,
  summarizePath,
  getPathDisplayName,
  isLikelyAbsoluteLocalPath,
  isWindowsAbsoluteLocalPath
};
