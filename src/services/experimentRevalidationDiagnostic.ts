export const EXPERIMENT_REVALIDATION_DIAGNOSTIC_VERSION =
  "experiment-revalidation-diagnostic-v1" as const;

export const EXPERIMENT_REVALIDATION_DIRECT_TERMINALS = [
  "RELOAD_FAILED",
  "BASELINE_MISSING",
  "CURRENT_DIRTY",
  "PHYSICAL_REVISION_CHANGED",
  "CLEAN_SAME_REVISION",
  "UNKNOWN_UNCLASSIFIED"
] as const;

export type ExperimentRevalidationDirectTerminal =
  (typeof EXPERIMENT_REVALIDATION_DIRECT_TERMINALS)[number];

export const EXPERIMENT_REVALIDATION_HIGHER_LEVEL_CLASSIFICATIONS = [
  "ACTIVE_OPERATION_CONFLICT",
  "LEGITIMATE_STALE_CONFIRMATION",
  "SELF_INVALIDATION_BY_PREVIEW_OR_UI_EFFECT",
  "WRONG_REVISION_SOURCE",
  "DUPLICATE_CONFIRM",
  "STALE_DIAGNOSTIC_LABEL",
  "NONE",
  "UNKNOWN_UNCLASSIFIED"
] as const;

export type ExperimentRevalidationHigherLevelClassification =
  (typeof EXPERIMENT_REVALIDATION_HIGHER_LEVEL_CLASSIFICATIONS)[number];

export interface ExperimentRevalidationDiagnosticInput {
  operationId: string;
  ownerId: string;
  currentFileRefId: string;
  targetFileRefId: string;
  snapshotCurrentRevision: string;
  currentReloadStatus: string;
  currentReloadCauseCode?: string;
  observedCurrentRevision?: string;
  baselinePresent: boolean;
  currentDirty?: boolean;
  activeOperation?: string;
  confirmInvocationCount: number;
  revalidationInvocationCount: number;
  confirmTimestamp: string;
  revalidationTimestamp: string;
  snapshotCurrentLogicalIdentity?: string;
  observedCurrentLogicalIdentity?: string;
  comparisonRevisionSource?:
    | "current-physical-baseline"
    | "target"
    | "owner"
    | "database"
    | "binding"
    | "file-ref"
    | "unknown";
  userChangedCurrentAfterPreview?: boolean;
  previewOrUiEffectChangedRevision?: boolean;
  staleDiagnosticLabelObserved?: boolean;
  sessionKey?: string;
  runtimeHandle?: string;
  reloadArgument?: string;
  reloadArgumentMatchesRuntimeHandle?: boolean;
  runtimeGeneration?: number;
  runtimeConsumerId?: string;
  currentPathIdentity?: string;
  physicalFileIdentity?: string;
  bindingRevision?: string;
  fileRefRevision?: string;
  previewSnapshotId?: string;
  currentSnapshotId?: string;
}

export interface ExperimentRevalidationDiagnosticEvidence {
  diagnosticVersion: typeof EXPERIMENT_REVALIDATION_DIAGNOSTIC_VERSION;
  operationId: string;
  ownerType: "experiment";
  ownerId: string;
  currentFileRefId: string;
  targetFileRefId: string;
  snapshotCurrentRevision: string;
  observedCurrentRevision: string | null;
  currentReloadStatus: string;
  currentReloadCauseCode: string | null;
  baselinePresent: boolean;
  currentDirty: boolean | null;
  activeOperation: string | null;
  confirmInvocationCount: number;
  revalidationInvocationCount: number;
  classificationCount: 1;
  confirmTimestamp: string;
  revalidationTimestamp: string;
  directTerminal: ExperimentRevalidationDirectTerminal;
  higherLevelClassification: ExperimentRevalidationHigherLevelClassification;
  wrongRevisionSourceThresholdSatisfied: boolean;
  businessOutcome: "blocked-existing-flow" | "continue-existing-flow";
  stageReached: "confirm-revalidate";
  sessionKey?: string;
  runtimeHandle?: string;
  reloadArgument?: string;
  reloadArgumentMatchesRuntimeHandle?: boolean;
  runtimeGeneration?: number;
  runtimeConsumerId?: string;
  currentPathIdentity?: string;
  physicalFileIdentity?: string;
  bindingRevision?: string;
  fileRefRevision?: string;
  previewSnapshotId?: string;
  currentSnapshotId?: string;
}

function classifyDirectTerminal(
  input: ExperimentRevalidationDiagnosticInput
): ExperimentRevalidationDirectTerminal {
  if (!input.operationId || !input.ownerId || !input.snapshotCurrentRevision) {
    return "UNKNOWN_UNCLASSIFIED";
  }
  if (input.currentReloadStatus !== "success") return "RELOAD_FAILED";
  if (!input.baselinePresent || !input.observedCurrentRevision) {
    return "BASELINE_MISSING";
  }
  if (input.currentDirty === true) return "CURRENT_DIRTY";
  if (input.currentDirty !== false) return "UNKNOWN_UNCLASSIFIED";
  return input.observedCurrentRevision === input.snapshotCurrentRevision
    ? "CLEAN_SAME_REVISION"
    : "PHYSICAL_REVISION_CHANGED";
}

function wrongRevisionSourceThresholdSatisfied(
  input: ExperimentRevalidationDiagnosticInput
) {
  if (!input.snapshotCurrentRevision || !input.observedCurrentRevision) {
    return false;
  }
  const logicalIdentityMismatch = Boolean(
    input.snapshotCurrentLogicalIdentity &&
    input.observedCurrentLogicalIdentity &&
    input.snapshotCurrentLogicalIdentity !== input.observedCurrentLogicalIdentity
  );
  const wrongComparisonSource = Boolean(
    input.comparisonRevisionSource &&
    input.comparisonRevisionSource !== "current-physical-baseline" &&
    input.comparisonRevisionSource !== "unknown"
  );
  return logicalIdentityMismatch || wrongComparisonSource;
}

function classifyHigherLevel(
  input: ExperimentRevalidationDiagnosticInput,
  directTerminal: ExperimentRevalidationDirectTerminal,
  wrongRevisionSource: boolean
): ExperimentRevalidationHigherLevelClassification {
  if (
    input.confirmInvocationCount > 1 ||
    input.revalidationInvocationCount > 1
  ) {
    return "DUPLICATE_CONFIRM";
  }
  if (
    input.activeOperation ||
    input.currentReloadCauseCode === "MANUSCRIPT_OPERATION_IN_PROGRESS"
  ) {
    return "ACTIVE_OPERATION_CONFLICT";
  }
  if (input.previewOrUiEffectChangedRevision) {
    return "SELF_INVALIDATION_BY_PREVIEW_OR_UI_EFFECT";
  }
  if (wrongRevisionSource) return "WRONG_REVISION_SOURCE";
  if (
    directTerminal === "PHYSICAL_REVISION_CHANGED" &&
    input.userChangedCurrentAfterPreview
  ) {
    return "LEGITIMATE_STALE_CONFIRMATION";
  }
  if (input.staleDiagnosticLabelObserved) return "STALE_DIAGNOSTIC_LABEL";
  if (directTerminal === "CLEAN_SAME_REVISION") return "NONE";
  return "UNKNOWN_UNCLASSIFIED";
}

export function buildExperimentRevalidationDiagnostic(
  input: ExperimentRevalidationDiagnosticInput
): Readonly<ExperimentRevalidationDiagnosticEvidence> {
  const directTerminal = classifyDirectTerminal(input);
  const wrongRevisionSource = wrongRevisionSourceThresholdSatisfied(input);
  const higherLevelClassification = classifyHigherLevel(
    input,
    directTerminal,
    wrongRevisionSource
  );
  return Object.freeze({
    diagnosticVersion: EXPERIMENT_REVALIDATION_DIAGNOSTIC_VERSION,
    operationId: input.operationId,
    ownerType: "experiment",
    ownerId: input.ownerId,
    currentFileRefId: input.currentFileRefId,
    targetFileRefId: input.targetFileRefId,
    snapshotCurrentRevision: input.snapshotCurrentRevision,
    observedCurrentRevision: input.observedCurrentRevision ?? null,
    currentReloadStatus: input.currentReloadStatus,
    currentReloadCauseCode: input.currentReloadCauseCode ?? null,
    baselinePresent: input.baselinePresent,
    currentDirty:
      typeof input.currentDirty === "boolean" ? input.currentDirty : null,
    activeOperation: input.activeOperation ?? null,
    confirmInvocationCount: input.confirmInvocationCount,
    revalidationInvocationCount: input.revalidationInvocationCount,
    classificationCount: 1,
    confirmTimestamp: input.confirmTimestamp,
    revalidationTimestamp: input.revalidationTimestamp,
    directTerminal,
    higherLevelClassification,
    wrongRevisionSourceThresholdSatisfied: wrongRevisionSource,
    businessOutcome:
      directTerminal === "CLEAN_SAME_REVISION"
        ? "continue-existing-flow"
        : "blocked-existing-flow",
    stageReached: "confirm-revalidate",
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.runtimeHandle ? { runtimeHandle: input.runtimeHandle } : {}),
    ...(input.reloadArgument ? { reloadArgument: input.reloadArgument } : {}),
    ...(typeof input.reloadArgumentMatchesRuntimeHandle === "boolean"
      ? {
          reloadArgumentMatchesRuntimeHandle:
            input.reloadArgumentMatchesRuntimeHandle
        }
      : {}),
    ...(typeof input.runtimeGeneration === "number"
      ? { runtimeGeneration: input.runtimeGeneration }
      : {}),
    ...(input.runtimeConsumerId
      ? { runtimeConsumerId: input.runtimeConsumerId }
      : {}),
    ...(input.currentPathIdentity
      ? { currentPathIdentity: input.currentPathIdentity }
      : {}),
    ...(input.physicalFileIdentity
      ? { physicalFileIdentity: input.physicalFileIdentity }
      : {}),
    ...(input.bindingRevision
      ? { bindingRevision: input.bindingRevision }
      : {}),
    ...(input.fileRefRevision
      ? { fileRefRevision: input.fileRefRevision }
      : {}),
    ...(input.previewSnapshotId
      ? { previewSnapshotId: input.previewSnapshotId }
      : {}),
    ...(input.currentSnapshotId
      ? { currentSnapshotId: input.currentSnapshotId }
      : {})
  });
}
