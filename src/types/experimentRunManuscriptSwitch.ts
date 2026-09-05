import type { FileRefLocationMode } from "./experiment";

export const EXPERIMENT_RUN_SWITCH_OUTLINE_KEYS = [
  "conditionSummary",
  "variableParameterSummary",
  "methodSummary",
  "resultSummary",
  "conclusion",
  "summaryOther"
] as const;

export type ExperimentRunSwitchOutlineKey =
  (typeof EXPERIMENT_RUN_SWITCH_OUTLINE_KEYS)[number];

export type ExperimentRunSwitchOutlineReplacement =
  | { key: ExperimentRunSwitchOutlineKey; action: "clear" }
  | { key: ExperimentRunSwitchOutlineKey; action: "set"; value: string };

export interface ExperimentRunSwitchOutlineDiagnostic {
  code:
    | "heading-missing"
    | "heading-duplicated"
    | "field-empty"
    | "field-invalid"
    | "field-duplicated"
    | "field-unknown";
  fieldKey?: ExperimentRunSwitchOutlineKey;
  sourceLabel?: string;
  line?: number;
}

export const EXPERIMENT_RUN_SWITCH_ERROR_CODES = {
  canceled: "RUN_SWITCH_CANCELED",
  alreadyCurrent: "RUN_SWITCH_ALREADY_CURRENT",
  ownerMissing: "RUN_SWITCH_OWNER_MISSING",
  parentMissing: "RUN_SWITCH_PARENT_MISSING",
  ownerDeleted: "RUN_SWITCH_OWNER_DELETED",
  parentDeleted: "RUN_SWITCH_PARENT_DELETED",
  bindingMissing: "RUN_SWITCH_BINDING_MISSING",
  currentMismatch: "RUN_SWITCH_CURRENT_MISMATCH",
  defaultMismatch: "RUN_SWITCH_DEFAULT_MISMATCH",
  targetInvalid: "RUN_SWITCH_TARGET_INVALID",
  targetOwnerMismatch: "RUN_SWITCH_TARGET_OWNER_MISMATCH",
  targetConflict: "RUN_SWITCH_TARGET_CONFLICT",
  oldCurrentConflict: "RUN_SWITCH_OLD_CURRENT_CONFLICT",
  oldCurrentDirty: "RUN_SWITCH_OLD_CURRENT_DIRTY",
  targetDirty: "RUN_SWITCH_TARGET_DIRTY",
  writebackFailed: "RUN_SWITCH_WRITEBACK_FAILED",
  transactionFailed: "RUN_SWITCH_TRANSACTION_FAILED",
  recoveryRequired: "RUN_SWITCH_RECOVERY_REQUIRED",
  activationFailed: "RUN_SWITCH_ACTIVATION_FAILED",
  staleRequest: "RUN_SWITCH_STALE_REQUEST",
  inProgress: "RUN_SWITCH_IN_PROGRESS"
} as const;

export type ExperimentRunSwitchErrorCode =
  (typeof EXPERIMENT_RUN_SWITCH_ERROR_CODES)[keyof typeof EXPERIMENT_RUN_SWITCH_ERROR_CODES];

export type ExperimentRunSwitchStage =
  | "preflight"
  | "confirm-revalidate"
  | "context-summary"
  | "recovery-log"
  | "old-current-writeback"
  | "database-transaction"
  | "post-verify"
  | "session-activation"
  | "page-refresh";

export type ExperimentRunSwitchRecoverability =
  | "none"
  | "retry"
  | "reselect"
  | "resolve-conflict"
  | "recovery-required";

export interface ExperimentRunSwitchError {
  code: ExperimentRunSwitchErrorCode;
  stage: ExperimentRunSwitchStage;
  causeCode: string;
  recoverability: ExperimentRunSwitchRecoverability;
  recoveryRequired: boolean;
  operationId?: string;
  provenance?: {
    frontendProvenance: string;
    rustProvenance: string;
    schemaProvenance: string;
  };
}

export type ExperimentRunSwitchPreflightResult =
  | {
      status: "ready";
      preflightToken: string;
      expiresAt: string;
      operationId: string;
      targetFileName: string;
      currentFileName: string;
      defaultFileName: string;
      targetLocationMode: FileRefLocationMode;
      targetIsDefault: boolean;
      outlineReplacements: readonly ExperimentRunSwitchOutlineReplacement[];
      diagnostics: readonly ExperimentRunSwitchOutlineDiagnostic[];
      warnings: readonly string[];
    }
  | { status: "already-current"; code: "RUN_SWITCH_ALREADY_CURRENT" }
  | {
      status: "decision-required";
      scope: "old-current" | "target";
      sessionKey: string;
      code: "RUN_SWITCH_OLD_CURRENT_DIRTY" | "RUN_SWITCH_TARGET_DIRTY";
    }
  | { status: "error"; error: ExperimentRunSwitchError };

export type ExperimentRunSwitchConfirmResult =
  | {
      status: "success";
      operationId: string;
      stage: "page-refresh";
      runId: string;
      sessionKey: string;
      currentFileRefId: string;
      defaultManuscriptFileRefId: string;
      operationLogId: string;
      oldCurrentWrittenBack: true;
      databaseCommitted: true;
      currentChanged: true;
      defaultChanged: false;
      targetWritten: false;
      activationRequired: false;
      pageRefreshRequired: true;
    }
  | {
      status: "recovery-required";
      operationId: string;
      stage: ExperimentRunSwitchStage;
      error: ExperimentRunSwitchError;
      oldCurrentWrittenBack: boolean;
      databaseCommitted: boolean;
      currentChanged: boolean;
      defaultChanged: false;
      targetWritten: false;
      activationRequired: boolean;
      pageRefreshRequired: boolean;
    }
  | { status: "error"; error: ExperimentRunSwitchError }
  | { status: "canceled"; code: "RUN_SWITCH_CANCELED" };

export interface ExperimentRunSwitchAudit {
  actorId: string;
  actorLabel: string;
  source: "user";
}

export interface ExperimentRunSwitchTransactionInput {
  operationId: string;
  ownerType: "experimentRun";
  runId: string;
  experimentId: string;
  projectId: string;
  manuscriptChannel: "primary";
  bindingId: string;
  expectedBindingUpdatedAt: string;
  expectedCurrentFileRefId: string;
  expectedCurrentPathIdentity: string;
  expectedDefaultManuscriptFileRefId: string;
  expectedDefaultPathIdentity: string;
  targetFileRefId: string;
  targetPathIdentity: string;
  targetLocationMode: FileRefLocationMode;
  outlineReplacements: readonly ExperimentRunSwitchOutlineReplacement[];
  oldCurrentWritebackCompleted: true;
  oldCurrentPostRevision: string;
  targetPhysicalRevision: string;
  occurredAt: string;
  logSummary: string;
  audit: ExperimentRunSwitchAudit;
}

export interface ExperimentRunSwitchTransactionResult {
  runId: string;
  bindingId: string;
  previousCurrentFileRefId: string;
  currentFileRefId: string;
  defaultManuscriptFileRefId: string;
  operationLogId: string;
  runUpdatedAt: string;
  bindingUpdatedAt: string;
}

export type ExperimentRunSwitchRecoveryPhase =
  | "prepared"
  | "writeback_unknown"
  | "writeback_applied"
  | "db_commit_unknown"
  | "db_committed"
  | "activation_pending"
  | "resolved"
  | "blocked"
  | "cancelled_safe";

export interface ExperimentRunSwitchRecoveryPrepareInput {
  recoveryId: string;
  operationId: string;
  runId: string;
  experimentId: string;
  projectId: string;
  bindingId: string;
  expectedRunUpdatedAt: string;
  expectedParentUpdatedAt: string;
  expectedBindingUpdatedAt: string;
  oldCurrentFileRefId: string;
  oldCurrentFileRefUpdatedAt: string;
  oldCurrentPathIdentity: string;
  oldCurrentLocationMode: FileRefLocationMode;
  defaultFileRefId: string;
  defaultFileRefUpdatedAt: string;
  defaultPathIdentity: string;
  defaultLocationMode: FileRefLocationMode;
  targetFileRefId: string;
  targetFileRefUpdatedAt: string;
  targetPathIdentity: string;
  targetLocationMode: FileRefLocationMode;
  beforeConditionSummary?: string;
  beforeVariableParameterSummary?: string;
  beforeMethodSummary?: string;
  beforeResultSummary?: string;
  beforeConclusion?: string;
  beforeSummaryOther?: string;
  outlineReplacementsJson: string;
  runTitleSnapshot: string;
  parentTitleSnapshot: string;
  projectTitleSnapshot: string;
  ratingSnapshot?: string;
  tagsJson: string;
  runDateSnapshot: string;
  runTimeSnapshot: string;
  deterministicWritebackVersion: 1;
  recordedAt: string;
  writebackDigest: string;
  writebackByteLength: number;
  oldCurrentPreRevision: string;
  targetPhysicalRevision: string;
  targetDigest: string;
  targetByteLength: number;
  oldCurrentPreDigest: string;
  oldCurrentExpectedPostDigest: string;
  oldCurrentFileName: string;
  targetFileName: string;
  defaultFileName: string;
  createdAt: string;
}

export interface ExperimentRunSwitchRecoveryRecord {
  recoveryId: string;
  operationId: string;
  runId: string;
  experimentId: string;
  projectId: string;
  phase: ExperimentRunSwitchRecoveryPhase;
  targetFileRefId: string;
  oldCurrentFileRefId: string;
  defaultFileRefId: string;
  oldCurrentFileName: string;
  targetFileName: string;
  defaultFileName: string;
  oldCurrentPreRevision: string;
  oldCurrentPostRevision?: string;
  writebackDigest: string;
  writebackByteLength: number;
  recordedAt: string;
  activationStatus: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentRunSwitchRecoveryDetail {
  input: ExperimentRunSwitchRecoveryPrepareInput;
  phase: ExperimentRunSwitchRecoveryPhase;
  oldCurrentPostRevision?: string;
}

export type ExperimentRunSwitchPostVerifyStatus =
  | "not_committed"
  | "committed_exact"
  | "committed_mismatch"
  | "ambiguous"
  | "identity_missing"
  | "duplicate_operation_log";

export interface ExperimentRunSwitchPostVerifyResult {
  status: ExperimentRunSwitchPostVerifyStatus;
  operationId: string;
  recoveryId: string;
  phase: ExperimentRunSwitchRecoveryPhase;
  currentFileRefId?: string;
  defaultFileRefId?: string;
  operationLogCount: number;
  databaseReadSource: "sqlite-direct";
  safeDiagnosticCode: string;
}

export interface ExperimentRunSwitchRecoveryPhaseInput {
  operationId: string;
  expectedPhase: ExperimentRunSwitchRecoveryPhase;
  nextPhase: ExperimentRunSwitchRecoveryPhase;
  occurredAt: string;
  oldCurrentPostRevision?: string;
  writebackVerificationResult?: string;
  lastErrorCode?: string;
  lastDiagnosticSummary?: string;
}
