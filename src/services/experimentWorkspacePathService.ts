import { createPathIdentityKey } from "./fileRefIdentity";
import {
  MANAGED_PATH_ERROR_CODES,
  ManagedPathError
} from "../types/managedPath";
import type {
  ExperimentRunWorkspacePathDescriptor,
  ExperimentRunWorkspacePathInput,
  ExperimentWorkspaceOwnerType,
  ExperimentWorkspacePathDescriptor,
  ExperimentWorkspacePathInput,
  ProjectWorkspaceIdentity
} from "../types/experimentWorkspacePath";
import {
  MANAGED_PATH_LIMITS,
  buildDateSegments,
  createPathSlug,
  createSafePathSegment,
  createStableShortId,
  isPathWithinDirectory,
  isPathWithinRoot,
  normalizeManagedRoot
} from "./managedPathService";

export const EXPERIMENT_WORKSPACE_OWNER_TYPES = Object.freeze([
  "experiment",
  "experimentRun"
] as const);

export const EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES = Object.freeze({
  experiment: "experiment.md",
  experimentRun: "experiment-run.md"
} as const);

export const EXPERIMENT_WORKSPACE_PATH_LIMITS = Object.freeze({
  maximumAbsolutePath: MANAGED_PATH_LIMITS.maximumAbsolutePath,
  maximumFrozenTitleIdentity: MANAGED_PATH_LIMITS.safeSegment,
  minimumWorkspaceTitle: 3,
  windowsSafetyMargin: 20
});

function joinIdentity(...segments: string[]) {
  const [head, ...tail] = segments;
  return createPathIdentityKey(
    `${head.replace(/\/+$/u, "")}/${tail
      .map((segment) => segment.replace(/^\/+|\/+$/gu, ""))
      .filter(Boolean)
      .join("/")}`
  );
}

function fail(code: keyof typeof MANAGED_PATH_ERROR_CODES, message: string): never {
  throw new ManagedPathError(MANAGED_PATH_ERROR_CODES[code], message);
}

export function isExperimentWorkspaceOwnerType(
  value: string
): value is ExperimentWorkspaceOwnerType {
  return EXPERIMENT_WORKSPACE_OWNER_TYPES.includes(value as ExperimentWorkspaceOwnerType);
}

export function getExperimentWorkspaceDefaultFilename(ownerType: string) {
  if (!isExperimentWorkspaceOwnerType(ownerType)) {
    fail("unsupportedOwnerType", `Unsupported Experiment workspace owner type: ${ownerType}.`);
  }
  return EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES[ownerType];
}

export function freezeWorkspaceTitleIdentity(
  title: string,
  ownerType: ExperimentWorkspaceOwnerType
) {
  if (!isExperimentWorkspaceOwnerType(ownerType)) {
    fail("unsupportedOwnerType", `Unsupported Experiment workspace owner type: ${ownerType}.`);
  }
  return createPathSlug(
    title,
    ownerType === "experiment" ? "experiment" : "run",
    EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumFrozenTitleIdentity
  );
}

export function assertWorkspaceTitleIdentityNotPatched(
  patch: Record<string, unknown>,
  entityLabel: string
) {
  if (Object.prototype.hasOwnProperty.call(patch, "workspaceTitleIdentity")) {
    fail(
      "workspaceTitleIdentityImmutable",
      `${entityLabel} workspace-title identity is immutable after creation.`
    );
  }
}

export function assertFrozenWorkspaceTitleIdentity(
  value: unknown,
  ownerType: ExperimentWorkspaceOwnerType
) {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalidPathSegment", `${ownerType} creation-title identity must already be frozen and safe.`);
  }
  const fallback = ownerType === "experiment" ? "experiment" : "run";
  const canonical = createPathSlug(
    value,
    fallback,
    EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumFrozenTitleIdentity
  );
  if (canonical !== value) {
    fail("invalidPathSegment", `${ownerType} creation-title identity must already be frozen and safe.`);
  }
  return value;
}

function validateFrozenLocalTime(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    fail("invalidDate", "Workspace date must be the frozen YYYY-MM-DD creation-local date.");
  }
  const dateSegments = buildDateSegments(date);
  if (!/^\d{4}$/u.test(time)) {
    fail("invalidDate", "Workspace time must be the frozen HHmm creation-local time.");
  }
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(2, 4));
  if (hours > 23 || minutes > 59) {
    fail("invalidDate", "Workspace creation-local time is outside the HHmm range.");
  }
  return dateSegments;
}

function normalizeProjectWorkspace(
  managedRoot: string,
  input: ProjectWorkspaceIdentity
): ProjectWorkspaceIdentity {
  const root = normalizeManagedRoot(managedRoot);
  const absolutePath = createPathIdentityKey(input.absolutePath);
  const identity = createPathIdentityKey(input.pathIdentityKey);
  if (!isPathWithinRoot(root, absolutePath)) {
    fail("projectWorkspaceOutsideRoot", "Project workspace is outside the managed root.");
  }
  if (absolutePath !== identity) {
    fail("projectWorkspaceIdentityInvalid", "Project workspace path identity does not match its absolute path.");
  }
  const folderName = absolutePath.split("/").pop() ?? "";
  const expectedPath = joinIdentity(root, "projects", input.folderName);
  if (
    !input.projectId?.trim() ||
    absolutePath !== expectedPath ||
    folderName !== expectedPath.split("/").pop() ||
    !folderName.endsWith(`_${createStableShortId(input.projectId)}`)
  ) {
    fail("projectWorkspaceIdentityInvalid", "Project workspace must reuse the formal Project identity.");
  }
  const safeFolderName = createSafePathSegment(folderName, {
    fallback: "project",
    maximumLength: MANAGED_PATH_LIMITS.projectFolder
  });
  if (safeFolderName !== folderName) {
    fail("projectWorkspaceIdentityInvalid", "Project workspace folder is not a safe direct segment.");
  }
  return {
    projectId: input.projectId,
    folderName,
    absolutePath,
    pathIdentityKey: identity
  };
}

export function windowsPathBudgetCost(value: string) {
  return value.length;
}

function truncateFrozenIdentity(value: string, maximumCost: number, fallback: string) {
  if (maximumCost < EXPERIMENT_WORKSPACE_PATH_LIMITS.minimumWorkspaceTitle) {
    fail("pathTooLong", "The fixed workspace identity leaves no safe-title budget.");
  }
  let result = "";
  for (const character of Array.from(value)) {
    if (windowsPathBudgetCost(`${result}${character}`) > maximumCost) break;
    result += character;
  }
  if (!result) {
    if (windowsPathBudgetCost(fallback) > maximumCost) {
      fail("pathTooLong", "The fixed workspace identity leaves no fallback title budget.");
    }
    return fallback;
  }
  return result.replace(/-+$/u, "") || fallback;
}

function assertPathBudget(path: string, label: string) {
  if (windowsPathBudgetCost(path) > EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumAbsolutePath) {
    fail("pathTooLong", `${label} exceeds the conservative absolute path budget.`);
  }
}

function validateParentExperimentDescriptor(
  input: ExperimentRunWorkspacePathInput,
  managedRoot: string,
  projectWorkspace: ProjectWorkspaceIdentity
) {
  const parent = input.parentExperimentWorkspace;
  if (parent.ownerType !== "experiment" || parent.ownerId !== input.parentExperimentId) {
    fail("parentExperimentIdentityMismatch", "Run parent Experiment identity does not match.");
  }
  if (
    parent.managedRoot !== managedRoot ||
    parent.projectId !== projectWorkspace.projectId ||
    parent.projectWorkspace.pathIdentityKey !== projectWorkspace.pathIdentityKey ||
    parent.defaultFileName !== EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experiment
  ) {
    fail("parentExperimentIdentityMismatch", "Run parent Project or managed-root identity does not match.");
  }
  const expectedPath = joinIdentity(
    projectWorkspace.absolutePath,
    parent.createdLocalDate.slice(0, 7),
    parent.createdLocalDate.slice(8, 10),
    "experiment",
    parent.workspaceFolderName
  );
  const parentPath = createPathIdentityKey(parent.absolutePath);
  if (
    parentPath !== expectedPath ||
    parent.pathIdentityKey !== parentPath ||
    parent.defaultFilePath !== joinIdentity(parentPath, EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experiment) ||
    !isPathWithinDirectory(projectWorkspace.absolutePath, parentPath)
  ) {
    fail("parentExperimentPathInvalid", "Run parent must be the exact formal Experiment workspace.");
  }
  return parentPath;
}

export function buildExperimentWorkspacePath(
  input: ExperimentWorkspacePathInput
): ExperimentWorkspacePathDescriptor {
  const managedRoot = normalizeManagedRoot(input.managedRoot);
  const projectWorkspace = normalizeProjectWorkspace(managedRoot, input.projectWorkspace);
  const date = validateFrozenLocalTime(input.createdLocalDate, input.createdLocalTime);
  const creationTitleIdentity = assertFrozenWorkspaceTitleIdentity(input.creationTitleIdentity, "experiment");
  const stableCode = createStableShortId(input.experimentId);
  const prefix = `${date.calendarDate}_${input.createdLocalTime}_exp_${stableCode}_`;
  const basePath = joinIdentity(projectWorkspace.absolutePath, date.yearMonth, date.day, "experiment");
  const deepestRunSuffix =
    `/runs/9999-12/31/9999-12-31_2359_run_${"0".repeat(MANAGED_PATH_LIMITS.shortId)}_run/` +
    EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experimentRun;
  const directFileReserve = 1 + EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experiment.length;
  const maximumWorkspaceLength = Math.min(
    MANAGED_PATH_LIMITS.entryFolder,
    EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumAbsolutePath - windowsPathBudgetCost(basePath) - directFileReserve,
    EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumAbsolutePath - windowsPathBudgetCost(basePath) - windowsPathBudgetCost(deepestRunSuffix) - 1
  );
  const workspaceTitleSegment = truncateFrozenIdentity(
    creationTitleIdentity,
    maximumWorkspaceLength - prefix.length,
    "experiment"
  );
  const workspaceFolderName = `${prefix}${workspaceTitleSegment}`;
  const absolutePath = joinIdentity(basePath, workspaceFolderName);
  const defaultFilePath = joinIdentity(
    absolutePath,
    EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experiment
  );
  const deepestReservedFilePathLength = windowsPathBudgetCost(`${absolutePath}${deepestRunSuffix}`);
  assertPathBudget(defaultFilePath, "Experiment default manuscript path");
  if (deepestReservedFilePathLength > EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumAbsolutePath) {
    fail("pathTooLong", "Experiment workspace leaves no complete nested Run path budget.");
  }
  if (!isPathWithinRoot(managedRoot, absolutePath)) {
    fail("pathOutsideRoot", "Experiment workspace is outside the managed root.");
  }
  return {
    ownerType: "experiment",
    ownerId: input.experimentId,
    managedRoot,
    projectId: projectWorkspace.projectId,
    projectWorkspace,
    createdLocalDate: date.calendarDate,
    createdLocalTime: input.createdLocalTime,
    stableCode,
    creationTitleIdentity,
    workspaceTitleSegment,
    workspaceFolderName,
    absolutePath,
    pathIdentityKey: createPathIdentityKey(absolutePath),
    defaultFileName: EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experiment,
    defaultFilePath,
    deepestReservedFilePathLength,
    pathBudget: {
      unit: "windowsUtf16CodeUnit",
      rootCost: windowsPathBudgetCost(managedRoot),
      projectFolderCost: windowsPathBudgetCost(projectWorkspace.folderName),
      experimentBaseCost: windowsPathBudgetCost(basePath),
      deepestRunSuffixReserve: windowsPathBudgetCost(deepestRunSuffix),
      titleBudget: maximumWorkspaceLength - prefix.length,
      finalAbsolutePathCost: windowsPathBudgetCost(defaultFilePath),
      maximumAbsolutePath: EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumAbsolutePath
    }
  };
}

export function buildExperimentRunWorkspacePath(
  input: ExperimentRunWorkspacePathInput
): ExperimentRunWorkspacePathDescriptor {
  const managedRoot = normalizeManagedRoot(input.managedRoot);
  const projectWorkspace = normalizeProjectWorkspace(managedRoot, input.projectWorkspace);
  const parentExperimentPath = validateParentExperimentDescriptor(input, managedRoot, projectWorkspace);
  const date = validateFrozenLocalTime(input.createdLocalDate, input.createdLocalTime);
  const creationTitleIdentity = assertFrozenWorkspaceTitleIdentity(input.creationTitleIdentity, "experimentRun");
  const stableCode = createStableShortId(input.runId);
  const prefix = `${date.calendarDate}_${input.createdLocalTime}_run_${stableCode}_`;
  const runsRoot = joinIdentity(parentExperimentPath, "runs");
  const basePath = joinIdentity(runsRoot, date.yearMonth, date.day);
  const fileReserve = 1 + EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experimentRun.length;
  const maximumWorkspaceLength = Math.min(
    MANAGED_PATH_LIMITS.entryFolder,
    EXPERIMENT_WORKSPACE_PATH_LIMITS.maximumAbsolutePath - windowsPathBudgetCost(basePath) - fileReserve - 1
  );
  const workspaceTitleSegment = truncateFrozenIdentity(
    creationTitleIdentity,
    maximumWorkspaceLength - prefix.length,
    "run"
  );
  const workspaceFolderName = `${prefix}${workspaceTitleSegment}`;
  const absolutePath = joinIdentity(basePath, workspaceFolderName);
  const defaultFilePath = joinIdentity(
    absolutePath,
    EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experimentRun
  );
  assertPathBudget(defaultFilePath, "ExperimentRun default manuscript path");
  if (!isPathWithinRoot(managedRoot, absolutePath) || !isPathWithinDirectory(runsRoot, absolutePath)) {
    fail("parentExperimentPathInvalid", "ExperimentRun workspace is outside its parent Experiment runs directory.");
  }
  return {
    ownerType: "experimentRun",
    ownerId: input.runId,
    managedRoot,
    projectId: projectWorkspace.projectId,
    projectWorkspace,
    parentExperimentId: input.parentExperimentId,
    parentExperimentWorkspaceIdentity: input.parentExperimentWorkspace.pathIdentityKey,
    parentDefaultFolderIdentity: input.parentExperimentWorkspace.pathIdentityKey,
    createdLocalDate: date.calendarDate,
    createdLocalTime: input.createdLocalTime,
    stableCode,
    creationTitleIdentity,
    workspaceTitleSegment,
    workspaceFolderName,
    absolutePath,
    pathIdentityKey: createPathIdentityKey(absolutePath),
    defaultFileName: EXPERIMENT_WORKSPACE_DEFAULT_FILENAMES.experimentRun,
    defaultFilePath,
    deepestFinalFilePathLength: windowsPathBudgetCost(defaultFilePath)
  };
}

export const experimentWorkspacePathService = {
  freezeWorkspaceTitleIdentity,
  assertFrozenWorkspaceTitleIdentity,
  assertWorkspaceTitleIdentityNotPatched,
  isExperimentWorkspaceOwnerType,
  getExperimentWorkspaceDefaultFilename,
  windowsPathBudgetCost,
  buildExperimentWorkspacePath,
  buildExperimentRunWorkspacePath
};
