export const MANUSCRIPT_PROVISIONING_RUNTIME_ERROR_CODES = Object.freeze({
  BUSY: "PROVISIONING_RUNTIME_BUSY",
  SHUTTING_DOWN: "PROVISIONING_RUNTIME_SHUTTING_DOWN",
  INVALID_RESOURCE_KEY: "PROVISIONING_RUNTIME_INVALID_RESOURCE_KEY",
  ENTRY_NOT_FOUND: "PROVISIONING_RUNTIME_ENTRY_NOT_FOUND",
  ENTRY_GENERATION_CONFLICT: "PROVISIONING_RUNTIME_ENTRY_GENERATION_CONFLICT",
  HEARTBEAT_FAILED: "PROVISIONING_RUNTIME_HEARTBEAT_FAILED",
  OPERATION_STATE_UNAVAILABLE: "PROVISIONING_OPERATION_STATE_UNAVAILABLE",
  INVALID_LIFECYCLE_TRANSITION:
    "PROVISIONING_RUNTIME_INVALID_LIFECYCLE_TRANSITION",
  ACTIVE_CLAIM_CONFLICT: "PROVISIONING_ACTIVE_CLAIM_CONFLICT",
  INTERNAL_FAILURE: "PROVISIONING_RUNTIME_INTERNAL_FAILURE",
  STARTUP_SCAN_FAILED: "PROVISIONING_STARTUP_SCAN_FAILED",
  STARTUP_SCAN_ALREADY_RUNNING: "PROVISIONING_STARTUP_SCAN_ALREADY_RUNNING",
  STARTUP_SCAN_RETRY_EXHAUSTED: "PROVISIONING_STARTUP_SCAN_RETRY_EXHAUSTED",
  RUNTIME_ISSUE_INVALID: "PROVISIONING_RUNTIME_ISSUE_INVALID",
  AUDIT_BATCH_FAILED: "PROVISIONING_AUDIT_BATCH_FAILED",
  AUDIT_RETRY_FAILED: "PROVISIONING_AUDIT_RETRY_FAILED",
  RECOVERY_SNAPSHOT_INVALID: "PROVISIONING_RECOVERY_SNAPSHOT_INVALID",
  RECOVERY_PRECONDITION_CHANGED: "PROVISIONING_RECOVERY_PRECONDITION_CHANGED",
  RECOVERY_DECISION_BLOCKED: "PROVISIONING_RECOVERY_DECISION_BLOCKED",
  RECOVERY_DECISION_BUSY: "PROVISIONING_RECOVERY_DECISION_BUSY",
  SCHEMA_CAPABILITY_READ_FAILED: "PROVISIONING_SCHEMA_CAPABILITY_READ_FAILED",
  SNAPSHOT_CANONICALIZATION_FAILED:
    "PROVISIONING_SNAPSHOT_CANONICALIZATION_FAILED",
  ALREADY_INITIALIZED: "PROVISIONING_RUNTIME_ALREADY_INITIALIZED",
  ACTIVATION_FAILED: "PROVISIONING_RUNTIME_ACTIVATION_FAILED",
  MAIN_WINDOW_NOT_READY: "PROVISIONING_RUNTIME_MAIN_WINDOW_NOT_READY",
  INVALID_READY_WINDOW: "PROVISIONING_RUNTIME_INVALID_READY_WINDOW",
  CAPABILITY_UNAVAILABLE: "PROVISIONING_RUNTIME_CAPABILITY_UNAVAILABLE",
  ADAPTER_UNAVAILABLE: "PROVISIONING_RUNTIME_ADAPTER_UNAVAILABLE",
  SHUTDOWN_IN_PROGRESS: "PROVISIONING_RUNTIME_SHUTDOWN_IN_PROGRESS",
  STARTUP_TASK_FAILED: "PROVISIONING_RUNTIME_STARTUP_TASK_FAILED",
  ISOLATION_REQUIRED: "PROVISIONING_RUNTIME_ISOLATION_REQUIRED",
  DATABASE_PROVIDER_FAILED: "PROVISIONING_RUNTIME_DATABASE_PROVIDER_FAILED"
} as const);

export type ManuscriptProvisioningRuntimeErrorCode =
  (typeof MANUSCRIPT_PROVISIONING_RUNTIME_ERROR_CODES)[keyof typeof MANUSCRIPT_PROVISIONING_RUNTIME_ERROR_CODES];

export type ManuscriptProvisioningRuntimeAuthority =
  | "runtime-local"
  | "durable-operation-state"
  | "none";

export type ManuscriptProvisioningRuntimeNextAction =
  | "stop"
  | "wait-for-activation"
  | "inspect-active-operation"
  | "continue-execution"
  | "detach"
  | "retry-startup-scan"
  | "inspect-runtime-issues"
  | "retry-audit"
  | "reinspect-and-confirm"
  | "proceed-to-recovery"
  | "none";

export type ManuscriptProvisioningRuntimeIssueKind =
  | "active-operation"
  | "stale-candidate"
  | "crash-candidate"
  | "retryable"
  | "repair-required"
  | "recovery-required"
  | "lifecycle-decision-required"
  | "blocked"
  | "audit-pending"
  | "audit-failed"
  | "unresolved-retained"
  | "startup-scan-failed"
  | "operation-state-unavailable";

export interface ManuscriptProvisioningRuntimeIssueSummary {
  issues: readonly {
    key: string;
    kind: ManuscriptProvisioningRuntimeIssueKind;
    ownerType: string;
    ownerId: string;
    manuscriptChannel?: string;
    scopeKind: string;
    operationId?: string;
    updatedAt: string;
  }[];
  businessIssueCount: number;
  auditIssueCount: number;
}

export interface ManuscriptProvisioningRuntimeAuditSummary {
  selected: number;
  delivered: number;
  alreadyDelivered: number;
  conflicted: number;
  failed: number;
  remaining: number;
  items: readonly {
    operationId: string;
    selectedStatus: string;
    finalStatus: "delivered" | "already-delivered" | "conflicted" | "failed";
    safeErrorCode: ManuscriptProvisioningRuntimeErrorCode | null;
    operationLogProduced: boolean;
    explicitRetryRequired: boolean;
  }[];
  safeErrorCode: ManuscriptProvisioningRuntimeErrorCode | null;
}

export type ManuscriptProvisioningRuntimeActivationStatus =
  | "uninitialized"
  | "waiting-for-main-window"
  | "activating"
  | "active"
  | "inactive";

export type ManuscriptProvisioningRuntimeCapabilityStatus =
  | "unchecked"
  | "available"
  | "unavailable-not-migrated"
  | "unavailable-invalid-schema"
  | "read-failed";

export type ManuscriptProvisioningRuntimeStartupScanStatus =
  | "not-started"
  | "running"
  | "completed"
  | "failed-retry-available"
  | "running-retry"
  | "failed-retry-exhausted";

export type ManuscriptProvisioningRuntimeAuditStatus =
  | "not-started"
  | "running"
  | "completed"
  | "partial"
  | "failed";

export type ManuscriptProvisioningRuntimeShutdownStatus =
  | "running"
  | "shutting-down"
  | "stopped";

export interface ManuscriptProvisioningProductionRuntimeSnapshot {
  activationStatus: ManuscriptProvisioningRuntimeActivationStatus;
  capabilityStatus: ManuscriptProvisioningRuntimeCapabilityStatus;
  startupScanStatus: ManuscriptProvisioningRuntimeStartupScanStatus;
  auditStatus: ManuscriptProvisioningRuntimeAuditStatus;
  shutdownStatus: ManuscriptProvisioningRuntimeShutdownStatus;
  mainWindowReady: boolean;
  startupTaskGeneration: number;
  startupRetryConsumed: boolean;
  issueSummary: ManuscriptProvisioningRuntimeIssueSummary;
  auditSummary: ManuscriptProvisioningRuntimeAuditSummary | null;
  heartbeatRegistryCount: number;
  abandonedExecutionCount: number;
  safeTimestamps: {
    initializedAtMs: number;
    updatedAtMs: number;
  };
  safeErrorCode: ManuscriptProvisioningRuntimeErrorCode | null;
  markdownBytesRead: 0;
  revision: number;
}

export interface ManuscriptProvisioningRuntimeAuditActivationSummary {
  status: ManuscriptProvisioningRuntimeAuditStatus;
  summary: ManuscriptProvisioningRuntimeAuditSummary | null;
}

export interface ManuscriptProvisioningRuntimeStateNotification {
  revision: number;
  generation: number;
  kind: string;
}

export interface ManuscriptProvisioningRuntimeRecoveryDecisionSummary {
  kind: "recovery-ready" | "precondition-changed" | "blocked" | "busy";
  operationId?: string;
  safeErrorCode?: ManuscriptProvisioningRuntimeErrorCode;
}

export type ManuscriptProvisioningRecoveryReadinessState =
  | "ready"
  | "not-ready"
  | "not-verified";

export interface ManuscriptProvisioningRecoverySnapshotSource {
  snapshotSchemaVersion: 1;
  inspectedAt: string;
  inspectorVersion: string;
  ownerType: string;
  ownerId: string;
  manuscriptChannel: string;
  scopeKind: string;
  bindingIdentity: string;
  fileRefIdentity: string;
  pathIdentityKey: string;
  resourceType: "file" | "directory";
  controlledMetadataIdentity: string;
  containmentSafety: ManuscriptProvisioningRecoveryReadinessState;
  readReady: ManuscriptProvisioningRecoveryReadinessState;
  writeReady: ManuscriptProvisioningRecoveryReadinessState;
  defaultResourceReady: ManuscriptProvisioningRecoveryReadinessState;
  currentResourceReady: ManuscriptProvisioningRecoveryReadinessState;
  lifecycleEligibility: "eligible" | "not-eligible" | "not-verified";
  blockerCodes: readonly string[];
  provenance: readonly string[];
  markdownBytesRead: 0;
  observedOperationId: string;
  observedOperationRevision: number;
  observedClaimId: string | null;
  observedClaimRevision: number | null;
  observedClaimHolder: "current-instance" | "other-instance" | "none";
  literatureChildStateIdentity: string | null;
}

export interface ManuscriptProvisioningRecoveryInspectionSnapshot
  extends ManuscriptProvisioningRecoverySnapshotSource {
  blockerCodes: readonly string[];
  provenance: readonly string[];
  snapshotHash: string;
}

export interface ManuscriptProvisioningRecoveryInspectionAdapter<TInput> {
  inspectReadiness(
    input: TInput
  ): Promise<ManuscriptProvisioningRecoverySnapshotSource>;
}

export interface ManuscriptProvisioningRuntimeResourceKey {
  ownerType: string;
  ownerId: string;
  manuscriptChannel: string;
}

export interface ManuscriptProvisioningRuntimeLocalPendingSummary {
  state: "local-pending";
  authority: "runtime-local";
  resource: ManuscriptProvisioningRuntimeResourceKey;
  intent: string;
  generation: number;
  startedAtMs: number;
  operationId?: never;
}

export interface ManuscriptProvisioningRuntimeClaimedActiveSummary {
  state: "claimed-active";
  authority: "durable-operation-state";
  resource: ManuscriptProvisioningRuntimeResourceKey;
  intent: string;
  generation: number;
  startedAtMs: number;
  operationId: string;
  phase: string;
  classification: string;
}

export type ManuscriptProvisioningRuntimeActiveSummary =
  | ManuscriptProvisioningRuntimeLocalPendingSummary
  | ManuscriptProvisioningRuntimeClaimedActiveSummary;

export type ManuscriptProvisioningRuntimeFeedback =
  | {
      kind: "operation-state-unavailable";
      authority: "none";
      nextAction: "wait-for-activation";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
      capability:
        | "unavailable-not-migrated"
        | "unavailable-invalid-schema"
        | "read-failed";
      operationSummary?: never;
    }
  | {
      kind: "local-pending";
      authority: "runtime-local";
      nextAction: "continue-execution";
      operationSummary: ManuscriptProvisioningRuntimeLocalPendingSummary;
    }
  | {
      kind: "busy";
      authority: "runtime-local" | "durable-operation-state";
      nextAction: "inspect-active-operation";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
      operationSummary: ManuscriptProvisioningRuntimeActiveSummary;
    }
  | {
      kind: "active-operation";
      authority: "durable-operation-state";
      nextAction: "inspect-active-operation";
      operationSummary: ManuscriptProvisioningRuntimeClaimedActiveSummary;
    }
  | {
      kind: "active-claim-conflict";
      authority: "durable-operation-state";
      nextAction: "inspect-active-operation";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
      operationSummary?: ManuscriptProvisioningRuntimeClaimedActiveSummary;
    }
  | {
      kind: "caller-cancelled";
      authority: "runtime-local";
      nextAction: "stop";
      safeErrorCode?: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "caller-detached";
      authority: "durable-operation-state";
      nextAction: "detach";
      operationSummary: ManuscriptProvisioningRuntimeClaimedActiveSummary;
    }
  | {
      kind: "cas-conflict";
      authority: "runtime-local" | "durable-operation-state";
      nextAction: "inspect-active-operation";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
      operationId: string;
    }
  | {
      kind: "completed";
      authority: "durable-operation-state";
      nextAction: "none";
      operationId: string;
      phase: string;
    }
  | {
      kind: "heartbeat-failed";
      authority: "durable-operation-state";
      nextAction: "continue-execution";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
      operationId: string;
    }
  | {
      kind: "shutting-down";
      authority: "runtime-local" | "durable-operation-state";
      nextAction: "stop";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "invalid-resource-key";
      authority: "none";
      nextAction: "stop";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "internal-failure";
      authority: ManuscriptProvisioningRuntimeAuthority;
      nextAction: "stop";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "startup-scan-running";
      authority: "runtime-local";
      nextAction: "inspect-runtime-issues";
      safeErrorCode?: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "startup-scan-completed";
      authority: "runtime-local";
      nextAction: "inspect-runtime-issues";
      issueSummary: ManuscriptProvisioningRuntimeIssueSummary;
      auditSummary?: ManuscriptProvisioningRuntimeAuditSummary;
    }
  | {
      kind: "startup-scan-failed";
      authority: "runtime-local";
      nextAction: "retry-startup-scan";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "startup-scan-retry-exhausted";
      authority: "runtime-local";
      nextAction: "stop";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "runtime-issues-ready";
      authority: "runtime-local";
      nextAction: "inspect-runtime-issues";
      issueSummary: ManuscriptProvisioningRuntimeIssueSummary;
    }
  | {
      kind: "audit-batch-completed";
      authority: "durable-operation-state";
      nextAction: "none";
      auditSummary: ManuscriptProvisioningRuntimeAuditSummary;
    }
  | {
      kind: "audit-batch-partial";
      authority: "durable-operation-state";
      nextAction: "retry-audit";
      auditSummary: ManuscriptProvisioningRuntimeAuditSummary;
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "audit-delivery-failed";
      authority: "durable-operation-state";
      nextAction: "retry-audit";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "recovery-ready";
      authority: "durable-operation-state";
      nextAction: "proceed-to-recovery";
      recoveryDecisionSummary: ManuscriptProvisioningRuntimeRecoveryDecisionSummary;
    }
  | {
      kind: "precondition-changed";
      authority: "durable-operation-state";
      nextAction: "reinspect-and-confirm";
      recoveryDecisionSummary: ManuscriptProvisioningRuntimeRecoveryDecisionSummary;
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "recovery-decision-blocked";
      authority: "durable-operation-state" | "none";
      nextAction: "stop";
      recoveryDecisionSummary: ManuscriptProvisioningRuntimeRecoveryDecisionSummary;
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    }
  | {
      kind: "recovery-decision-busy";
      authority: "runtime-local";
      nextAction: "inspect-active-operation";
      safeErrorCode: ManuscriptProvisioningRuntimeErrorCode;
    };
