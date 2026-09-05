import { getPathDisplayName } from "./localPathService";

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function getSafeManuscriptBasename(path: string) {
  if (!path || path !== path.trim()) return undefined;
  const basename = getPathDisplayName(path);
  if (
    !basename ||
    basename === "." ||
    basename === ".." ||
    basename !== basename.trim() ||
    /[. ]$/u.test(basename) ||
    /[\\/]/u.test(basename) ||
    /[<>:"|?*\u0000-\u001f\u007f]/u.test(basename) ||
    WINDOWS_RESERVED_BASENAME.test(basename)
  ) {
    return undefined;
  }
  return basename;
}
