import type { FileRefLocationMode } from "./experiment";
import type {
  ExperimentOutlineDiagnostic,
  ExperimentOutlineReplacement
} from "./experimentManuscriptAdapter";
import type { SharedManuscriptSessionHandle } from "./sharedManuscriptSession";

export const EXPERIMENT_MANUSCRIPT_SWITCH_ERROR_CODES = {
  ownerUnavailable: "EXPERIMENT_FORMAL_SWITCH_OWNER_UNAVAILABLE",
  ownerChanged: "EXPERIMENT_FORMAL_SWITCH_OWNER_CHANGED",
  bindingInvalid: "EXPERIMENT_FORMAL_SWITCH_BINDING_INVALID",
  currentChanged: "EXPERIMENT_FORMAL_SWITCH_CURRENT_CHANGED",
  defaultChanged: "EXPERIMENT_FORMAL_SWITCH_DEFAULT_CHANGED",
  targetInvalid: "EXPERIMENT_FORMAL_SWITCH_TARGET_INVALID",
  targetChanged: "EXPERIMENT_FORMAL_SWITCH_TARGET_CHANGED",
  targetDirty: "EXPERIMENT_FORMAL_SWITCH_TARGET_DIRTY",
  currentDirty: "EXPERIMENT_FORMAL_SWITCH_CURRENT_DIRTY",
  operationInProgress: "EXPERIMENT_FORMAL_SWITCH_IN_PROGRESS",
  tokenInvalid: "EXPERIMENT_FORMAL_SWITCH_TOKEN_INVALID",
  tokenExpired: "EXPERIMENT_FORMAL_SWITCH_TOKEN_EXPIRED",
  tokenUsed: "EXPERIMENT_FORMAL_SWITCH_TOKEN_USED",
  writebackConflict: "EXPERIMENT_FORMAL_SWITCH_OLD_CURRENT_CONFLICT",
  writebackFailed: "EXPERIMENT_FORMAL_SWITCH_OLD_CURRENT_WRITEBACK_FAILED",
  contextSummaryFailed: "EXPERIMENT_FORMAL_SWITCH_CONTEXT_SUMMARY_FAILED",
  recoveryLogFailed: "EXPERIMENT_FORMAL_SWITCH_RECOVERY_LOG_FAILED",
  transactionFailed: "EXPERIMENT_FORMAL_SWITCH_TRANSACTION_FAILED",
  postVerifyFailed: "EXPERIMENT_FORMAL_SWITCH_POST_VERIFY_FAILED",
  sessionActivationFailed: "EXPERIMENT_FORMAL_SWITCH_SESSION_ACTIVATION_FAILED",
  pageRefreshFailed: "EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED",
  recoveryRequired: "EXPERIMENT_FORMAL_SWITCH_RECOVERY_REQUIRED",
  recoveryNotFound: "EXPERIMENT_FORMAL_SWITCH_RECOVERY_NOT_FOUND",
  recoveryStale: "EXPERIMENT_FORMAL_SWITCH_RECOVERY_STALE",
  replacementChanged: "EXPERIMENT_FORMAL_SWITCH_REPLACEMENT_CHANGED"
} as const;

export type ExperimentManuscriptSwitchErrorCode =
  (typeof EXPERIMENT_MANUSCRIPT_SWITCH_ERROR_CODES)[keyof typeof EXPERIMENT_MANUSCRIPT_SWITCH_ERROR_CODES];

export type ExperimentFormalSwitchRecoveryPhase =
  | "prepared"
  | "writeback_unknown"
  | "writeback_applied"
  | "db_commit_unknown"
  | "db_committed"
  | "activation_pending"
  | "resolved"
  | "blocked"
  | "cancelled_safe";

export type ExperimentManuscriptSwitchStage =
  | "preflight"
  | "confirm-revalidate"
  | "context-summary"
  | "old-current-writeback"
  | "recovery-log"
  | "database-transaction"
  | "post-verify"
  | "session-activation"
  | "page-refresh";

export type ExperimentManuscriptSwitchRecoverability =
  | "none"
  | "retry"
  | "reselect"
  | "resolve-conflict"
  | "recovery-required";

export interface ExperimentManuscriptSwitchSafeState {
  experimentId?: string;
  bindingId?: string;
  oldCurrentFileRefId?: string;
  targetFileRefId?: string;
  defaultFileRefId?: string;
  recoveryPhase?: ExperimentFormalSwitchRecoveryPhase;
  oldCurrentRevision?: string;
  targetRevision?: string;
  oldCurrentHash?: string;
  targetHash?: string;
  bindingCurrentExpected?: string;
  bindingCurrentActual?: string | null;
  bindingDefaultBefore?: string;
  bindingDefaultActual?: string | null;
  outlineExpected?: string;
  outlineActual?: string;
  operationLogExpectedPhase?: "db_committed";
  operationLogActualPhase?: string | null;
  transactionOperationId?: string;
  databaseReadSource?: "sqlite-direct-post-commit";
}

export interface ExperimentFormalSwitchRecoveryPayload {
  contract: "labpod.experiment.formal-switch.v1";
  phase: ExperimentFormalSwitchRecoveryPhase;
  operationId: string;
  correlationId: string;
  experimentId: string;
  projectId: string;
  bindingId: string;
  oldCurrentFileRefId: string;
  targetFileRefId: string;
  defaultFileRefId: string;
  expectedOwnerUpdatedAt: string;
  expectedBindingUpdatedAt: string;
  expectedDefaultFileRefUpdatedAt: string;
  expectedDefaultPathIdentity: string;
  oldCurrentFileRefUpdatedAt: string;
  oldCurrentPathIdentity: string;
  oldCurrentLocationMode: FileRefLocationMode;
  oldCurrentPreRevision: string;
  oldCurrentPreHash: string;
  oldCurrentExpectedPostHash: string;
  oldCurrentPostRevision?: string;
  deterministicWritebackVersion: string;
  writebackDigest: string;
  writebackByteLength: number;
  writebackVerificationResult?: "exact-post" | "pre-write" | "conflict";
  targetFileRefUpdatedAt: string;
  targetPathIdentity: string;
  targetLocationMode: FileRefLocationMode;
  targetRevision: string;
  targetHash: string;
  targetByteLength: number;
  outlineDigest: string;
  occurredAt: string;
  errorCode?: ExperimentManuscriptSwitchErrorCode;
}

export interface ExperimentManuscriptSwitchError {
  code: ExperimentManuscriptSwitchErrorCode;
  errorCode: ExperimentManuscriptSwitchErrorCode;
  message: string;
  stage: ExperimentManuscriptSwitchStage;
  causeCode: string;
  recoverability: ExperimentManuscriptSwitchRecoverability;
  recoveryRequired: boolean;
  operationId: string;
  safeState?: ExperimentManuscriptSwitchSafeState;
}

export type ExperimentManuscriptSwitchPreflightResult =
  | {
      status: "ready";
      preflightToken: string;
      expiresAt: string;
      experimentId: string;
      currentFileRefId: string;
      defaultFileRefId: string;
      targetFileRefId: string;
  targetSessionKey: SharedManuscriptSessionHandle;
      targetFileName: string;
      outlineReplacements: readonly ExperimentOutlineReplacement[];
      diagnostics: readonly ExperimentOutlineDiagnostic[];
      warnings: string[];
      requiresConfirmation: true;
    }
  | {
      status: "no-op";
      experimentId: string;
      currentFileRefId: string;
    }
  | {
      status: "error";
      error: ExperimentManuscriptSwitchError;
    };

export type ExperimentManuscriptSwitchConfirmResult =
  | {
      status: "success";
      experimentId: string;
      currentFileRefId: string;
      defaultManuscriptFileRefId: string;
      operationLogId: string;
  sessionKey: SharedManuscriptSessionHandle;
    }
  | {
      status: "recovery-required";
      operationId: string;
      error: ExperimentManuscriptSwitchError;
    }
  | { status: "canceled" }
  | { status: "error"; error: ExperimentManuscriptSwitchError };

export interface ExperimentFormalSwitchRecoverySummary {
  operationKind: "formal-switch";
  operationId: string;
  provenance?: {
    frontendProvenance: string;
    rustProvenance: string;
    schemaProvenance: string;
  };
  experimentId: string;
  oldCurrentFileRefId: string;
  targetFileRefId: string;
  phase: ExperimentFormalSwitchRecoveryPhase;
  occurredAt: string;
  operationIdentityVerified: boolean;
  writebackVerified: boolean;
  errorCode?: ExperimentManuscriptSwitchErrorCode;
}

export interface ExperimentSwitchRecoveryPrepareInput {
  operationId: string;
  experimentId: string;
  projectId: string;
  bindingId: string;
  expectedOwnerUpdatedAt: string;
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
  beforePurposeAndQuestion?: string;
  beforeConditionSummary?: string;
  beforeMethodSummary?: string;
  beforeResultSummary?: string;
  beforeConclusionAndNextSteps?: string;
  beforeOther?: string;
  outlineReplacementsJson: string;
  experimentTitleSnapshot: string;
  projectTitleSnapshot: string;
  ratingSnapshot?: string;
  tagsJson: string;
  deterministicWritebackVersion: 1;
  recordedAt: string;
  writebackDigest: string;
  writebackByteLength: number;
  oldCurrentPreRevision: string;
  oldCurrentPreDigest: string;
  oldCurrentExpectedPostDigest: string;
  targetPhysicalRevision: string;
  targetDigest: string;
  targetByteLength: number;
  oldCurrentFileName: string;
  targetFileName: string;
  defaultFileName: string;
  correlationId: string;
  createdAt: string;
}

export interface ExperimentSwitchRecoveryRecord {
  operationId: string;
  experimentId: string;
  projectId: string;
  phase: ExperimentFormalSwitchRecoveryPhase;
  oldCurrentFileRefId: string;
  targetFileRefId: string;
  defaultFileRefId: string;
  oldCurrentFileName: string;
  targetFileName: string;
  defaultFileName: string;
  oldCurrentPreRevision: string;
  oldCurrentPostRevision?: string;
  writebackDigest: string;
  writebackByteLength: number;
  writebackVerificationResult?: "exact-post" | "pre-write" | "conflict";
  activationStatus: string;
  lastErrorCode?: string;
  recordedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentSwitchRecoveryDetail {
  input: ExperimentSwitchRecoveryPrepareInput;
  phase: ExperimentFormalSwitchRecoveryPhase;
  oldCurrentPostRevision?: string;
  writebackVerificationResult?: "exact-post" | "pre-write" | "conflict";
}

export interface ExperimentSwitchRecoveryPhaseInput {
  operationId: string;
  expectedPhase: ExperimentFormalSwitchRecoveryPhase;
  nextPhase: ExperimentFormalSwitchRecoveryPhase;
  occurredAt: string;
  oldCurrentPostRevision?: string;
  writebackVerificationResult?: "exact-post" | "pre-write" | "conflict";
  lastErrorCode?: string;
  lastDiagnosticSummary?: string;
}

export interface ExperimentSwitchRecoveryPostVerifyResult {
  status: "not_committed" | "committed_exact" | "committed_mismatch" | "identity_missing" | "duplicate_operation_log";
  operationId: string;
  phase: ExperimentFormalSwitchRecoveryPhase;
  currentFileRefId?: string;
  defaultFileRefId?: string;
  operationLogCount: number;
  databaseReadSource: "sqlite-direct";
  safeDiagnosticCode: string;
}

export type ExperimentFormalSwitchRecoveryResult =
  | ExperimentManuscriptSwitchConfirmResult
  | {
      status: "canceled";
      operationId: string;
      oldCurrentWritebackRetained: boolean;
    };
