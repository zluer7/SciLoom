import { createPathIdentityKey } from "./fileRefIdentity";
import {
  MANAGED_PATH_ERROR_CODES,
  ManagedPathError,
  type DateSegments,
  type ManagedEntryPathDescriptor,
  type ManagedEntryPathInput,
  type ManagedPathOwnerType
} from "../types/managedPath";

export const MANAGED_PATH_LIMITS = Object.freeze({
  maximumAbsolutePath: 240,
  maximumConfiguredRoot: 160,
  projectFolder: 64,
  entryFolder: 96,
  safeSegment: 120,
  shortId: 12
});

const OWNER_TYPE_FOLDERS: Readonly<Record<ManagedPathOwnerType, string>> = Object.freeze({
  literature: "literature",
  review: "review",
  resultItem: "result-item",
  finding: "finding",
  outputCandidate: "output-candidate",
  outputGap: "output-gap",
  researchOutput: "research-output"
});

const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function codePointSlice(value: string, maximumLength: number) {
  return Array.from(value).slice(0, maximumLength).join("");
}

function finishSafeSegment(value: string, fallback: string) {
  let result = value.replace(/[.\s]+$/gu, "");
  if (!result || /^\.+$/u.test(result)) result = fallback;
  if (RESERVED_WINDOWS_NAME.test(result)) result = `_${result}`;
  return result;
}

export function createSafePathSegment(
  input: string,
  options: { fallback: string; maximumLength?: number } = { fallback: "item" }
) {
  const maximumLength = options.maximumLength ?? MANAGED_PATH_LIMITS.safeSegment;
  if (!Number.isInteger(maximumLength) || maximumLength < 1) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidPathSegment, "Invalid segment length budget.");
  }
  const normalized = String(input ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu, "-")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const fallback = String(options.fallback || "item").normalize("NFC");
  return finishSafeSegment(codePointSlice(normalized, maximumLength), fallback);
}

export function createPathSlug(input: string, fallback = "item", maximumLength = 56) {
  const safe = createSafePathSegment(input, { fallback, maximumLength: Math.max(maximumLength, 1) })
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLocaleLowerCase("en-US");
  return finishSafeSegment(codePointSlice(safe, maximumLength), fallback);
}

function fnv1a(value: string, seed: number) {
  let hash = seed >>> 0;
  for (const byte of new TextEncoder().encode(value.normalize("NFC"))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function createStableShortId(id: string) {
  const value = String(id ?? "").trim().normalize("NFC");
  if (!value) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidOwnerId, "Stable ID is required.");
  }
  return `${fnv1a(value, 0x811c9dc5)}${fnv1a(value, 0x9e3779b1)}`.slice(
    0,
    MANAGED_PATH_LIMITS.shortId
  );
}

export function buildDateSegments(value: string): DateSegments {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidDate, "Expected an ISO date or datetime.");
  }
  const [, year, month, day] = match;
  const candidate = `${year}-${month}-${day}`;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidDate, `Invalid calendar date: ${candidate}.`);
  }
  return { calendarDate: candidate, yearMonth: `${year}-${month}`, day };
}

export function buildOwnerTypeFolderName(ownerType: ManagedPathOwnerType | string) {
  const folder = OWNER_TYPE_FOLDERS[ownerType as ManagedPathOwnerType];
  if (!folder) {
    throw new ManagedPathError(
      MANAGED_PATH_ERROR_CODES.unsupportedOwnerType,
      `Unsupported managed path owner type: ${ownerType}.`
    );
  }
  return folder;
}

export function buildProjectFolderName(projectId: string, projectTitle: string) {
  if (!String(projectId ?? "").trim()) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidProjectId, "Project ID is required.");
  }
  const shortId = createStableShortId(projectId);
  const titleBudget = MANAGED_PATH_LIMITS.projectFolder - shortId.length - 1;
  const safeTitle = createSafePathSegment(projectTitle, { fallback: "project", maximumLength: titleBudget });
  return `${safeTitle}_${shortId}`;
}

export function buildEntryFolderName(input: {
  ownerType: ManagedPathOwnerType;
  ownerId: string;
  ownerTitle: string;
  createdAt: string;
  maximumLength?: number;
}) {
  if (!String(input.ownerId ?? "").trim()) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidOwnerId, "Owner ID is required.");
  }
  const { calendarDate } = buildDateSegments(input.createdAt);
  const type = buildOwnerTypeFolderName(input.ownerType);
  const shortId = createStableShortId(input.ownerId);
  const prefix = `${calendarDate}_${type}_${shortId}_`;
  const maximumLength = input.maximumLength ?? MANAGED_PATH_LIMITS.entryFolder;
  const slugBudget = maximumLength - prefix.length;
  if (slugBudget < 1) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.pathTooLong, "Entry path has no slug budget.");
  }
  return `${prefix}${createPathSlug(input.ownerTitle, "item", slugBudget)}`;
}

function absoluteKind(path: string) {
  if (/^[a-zA-Z]:\//.test(path)) return "windows" as const;
  if (path.startsWith("//")) return "unc" as const;
  if (path.startsWith("/")) return "posix" as const;
  return "relative" as const;
}

export function normalizeManagedRoot(root: string) {
  if (!String(root ?? "").trim()) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.rootMissing, "Managed root is not configured.");
  }
  let normalized: string;
  try {
    normalized = createPathIdentityKey(root);
  } catch {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.rootInvalid, "Managed root is invalid.");
  }
  if (absoluteKind(normalized) === "relative") {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.rootNotAbsolute, "Managed root must be absolute.");
  }
  if (normalized.length > MANAGED_PATH_LIMITS.maximumConfiguredRoot) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.rootTooLong, "Managed root exceeds the path budget.");
  }
  if (normalized === "/" || /^[a-z]:\/$/.test(normalized) || /^\/\/[^/]+\/[^/]+$/u.test(normalized)) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.rootInvalid, "A filesystem or share root cannot be the managed root.");
  }
  return normalized;
}

function joinCanonical(...segments: string[]) {
  const [head, ...tail] = segments;
  return `${head.replace(/\/+$/u, "")}/${tail
    .map((part) => part.replace(/^\/+|\/+$/gu, ""))
    .filter(Boolean)
    .join("/")}`;
}

function identityRoot(identity: string) {
  if (/^[a-z]:\//.test(identity)) return identity.slice(0, 2);
  if (identity.startsWith("//")) return identity.split("/").slice(0, 4).join("/");
  return identity.startsWith("/") ? "/" : "";
}

export function isPathWithinRoot(root: string, target: string) {
  let rootIdentity: string;
  let targetIdentity: string;
  try {
    rootIdentity = normalizeManagedRoot(root);
    targetIdentity = createPathIdentityKey(target);
  } catch {
    return false;
  }
  if (absoluteKind(targetIdentity) === "relative" || absoluteKind(rootIdentity) !== absoluteKind(targetIdentity)) {
    return false;
  }
  if (identityRoot(rootIdentity) !== identityRoot(targetIdentity)) return false;
  const rootSegments = rootIdentity.split("/").filter(Boolean);
  const targetSegments = targetIdentity.split("/").filter(Boolean);
  return rootSegments.length <= targetSegments.length && rootSegments.every((segment, index) => segment === targetSegments[index]);
}

export function isPathWithinDirectory(directory: string, target: string) {
  let directoryIdentity: string;
  let targetIdentity: string;
  try {
    directoryIdentity = createPathIdentityKey(directory);
    targetIdentity = createPathIdentityKey(target);
  } catch {
    return false;
  }
  if (
    absoluteKind(directoryIdentity) === "relative" ||
    absoluteKind(directoryIdentity) !== absoluteKind(targetIdentity) ||
    identityRoot(directoryIdentity) !== identityRoot(targetIdentity)
  ) {
    return false;
  }
  const directorySegments = directoryIdentity.split("/").filter(Boolean);
  const targetSegments = targetIdentity.split("/").filter(Boolean);
  return (
    directorySegments.length < targetSegments.length &&
    directorySegments.every((segment, index) => segment === targetSegments[index])
  );
}

export function classifyPathLocation(root: string, target: string): "managed" | "external" {
  return isPathWithinRoot(root, target) ? "managed" : "external";
}

export function buildManagedManuscriptPath(folderPath: string, fileName: string) {
  const rawFolder = String(folderPath ?? "").trim();
  if (!rawFolder) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidPathSegment, "Managed folder path is empty.");
  }
  const isUnc = /^(?:\\\\|\/\/)/u.test(rawFolder);
  let folder = rawFolder.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  if (isUnc) folder = `//${folder.replace(/^\/+/, "")}`;
  const normalizedFileName = fileName.trim();
  if (!/^[^\\/]+\.(?:md|markdown)$/iu.test(normalizedFileName) || normalizedFileName === ".md") {
    throw new ManagedPathError(
      MANAGED_PATH_ERROR_CODES.invalidPathSegment,
      "Managed manuscript filename must be a direct Markdown filename."
    );
  }
  return `${folder.replace(/\/+$/u, "")}/${normalizedFileName}`;
}

export function getManagedPathParent(targetPath: string) {
  const target = createPathIdentityKey(targetPath);
  const separator = target.lastIndexOf("/");
  if (separator <= 0 || (/^[a-z]:\//.test(target) && separator === 2)) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.invalidPathSegment, "Managed path has no parent.");
  }
  return target.slice(0, separator);
}

export function getManagedRelativePath(root: string, target: string) {
  const rootIdentity = normalizeManagedRoot(root);
  const targetIdentity = createPathIdentityKey(target);
  if (!isPathWithinRoot(rootIdentity, targetIdentity)) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.pathOutsideRoot, "Target is outside managed root.");
  }
  const rootSegments = rootIdentity.split("/").filter(Boolean);
  const targetSegments = targetIdentity.split("/").filter(Boolean);
  return targetSegments.slice(rootSegments.length).join("/");
}

export function buildManagedEntryPath(input: ManagedEntryPathInput): ManagedEntryPathDescriptor {
  const rootPath = normalizeManagedRoot(input.root);
  const date = buildDateSegments(input.createdAt);
  const ownerType = input.ownerType as ManagedPathOwnerType;
  const ownerTypeFolder = buildOwnerTypeFolderName(ownerType);
  const ownerScoped = input.projectId === null;
  if (ownerScoped && ownerType !== "literature") {
    throw new ManagedPathError(
      MANAGED_PATH_ERROR_CODES.invalidProjectId,
      `Owner-scoped managed placement is not supported for ${ownerType}.`
    );
  }
  const projectFolderName = ownerScoped
    ? undefined
    : buildProjectFolderName(input.projectId, input.projectTitle ?? "");
  let collectionFolder: string | undefined;
  if (input.collectionFolder !== undefined) {
    collectionFolder = createSafePathSegment(input.collectionFolder, {
      fallback: "collection",
      maximumLength: 32
    });
    if (collectionFolder !== input.collectionFolder) {
      throw new ManagedPathError(
        MANAGED_PATH_ERROR_CODES.invalidPathSegment,
        "Managed collection folder must already be a safe direct path segment."
      );
    }
  }
  const baseSegments = projectFolderName
    ? [
        "projects",
        projectFolderName,
        date.yearMonth,
        date.day,
        ...(collectionFolder ? [collectionFolder] : []),
        ownerTypeFolder
      ]
    : [
        "owners",
        ownerTypeFolder,
        date.yearMonth,
        date.day,
        ...(collectionFolder ? [collectionFolder] : [])
      ];
  const fixedAbsolute = joinCanonical(rootPath, ...baseSegments);
  const availableEntryLength = MANAGED_PATH_LIMITS.maximumAbsolutePath - fixedAbsolute.length - 1;
  const entryFolderName = buildEntryFolderName({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    ownerTitle: input.ownerTitle,
    createdAt: input.createdAt,
    maximumLength: Math.min(MANAGED_PATH_LIMITS.entryFolder, availableEntryLength)
  });
  const relativePath = [...baseSegments, entryFolderName].join("/");
  const absolutePath = joinCanonical(rootPath, relativePath);
  if (absolutePath.length > MANAGED_PATH_LIMITS.maximumAbsolutePath || !isPathWithinRoot(rootPath, absolutePath)) {
    throw new ManagedPathError(MANAGED_PATH_ERROR_CODES.pathTooLong, "Managed entry exceeds the path budget.");
  }
  return {
    rootPath,
    ...(projectFolderName ? { projectFolderName } : {}),
    ...date,
    ownerTypeFolder,
    collectionFolder,
    entryFolderName,
    relativePath,
    absolutePath,
    pathIdentityKey: createPathIdentityKey(absolutePath),
    warnings: []
  };
}

export const managedPathService = {
  createSafePathSegment,
  createPathSlug,
  createStableShortId,
  buildDateSegments,
  buildOwnerTypeFolderName,
  buildProjectFolderName,
  buildEntryFolderName,
  normalizeManagedRoot,
  isPathWithinRoot,
  isPathWithinDirectory,
  classifyPathLocation,
  buildManagedManuscriptPath,
  getManagedPathParent,
  getManagedRelativePath,
  buildManagedEntryPath
};
