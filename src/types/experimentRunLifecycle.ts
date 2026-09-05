import type { EntityId, ISODateString } from "./common";
import type { ExperimentManuscriptOwnerType } from "./experimentManuscript";

export const EXPERIMENT_RUN_LIFECYCLE_ERROR_CODES = {
  ownerNotFound: "LIFECYCLE_OWNER_NOT_FOUND",
  ownerAlreadyDeleted: "LIFECYCLE_OWNER_ALREADY_DELETED",
  ownerNotDeleted: "LIFECYCLE_OWNER_NOT_DELETED",
  ownerChanged: "LIFECYCLE_OWNER_CHANGED",
  parentDeleted: "LIFECYCLE_PARENT_DELETED",
  runsExist: "LIFECYCLE_RUNS_EXIST",
  metricsExist: "LIFECYCLE_METRICS_EXIST",
  sourceDependenciesExist: "LIFECYCLE_SOURCE_DEPENDENCIES_EXIST",
  businessDependenciesExist: "LIFECYCLE_BUSINESS_DEPENDENCIES_EXIST",
  bindingInvalid: "LIFECYCLE_BINDING_INVALID",
  fileRefInvalid: "LIFECYCLE_FILE_REF_INVALID",
  sessionDirty: "LIFECYCLE_SESSION_DIRTY",
  sessionSaving: "LIFECYCLE_SESSION_SAVING",
  sessionConflict: "LIFECYCLE_SESSION_CONFLICT",
  sessionRecoveryRequired: "LIFECYCLE_SESSION_RECOVERY_REQUIRED",
  sessionActive: "LIFECYCLE_SESSION_ACTIVE",
  preflightExpired: "LIFECYCLE_PREFLIGHT_EXPIRED",
  preflightConsumed: "LIFECYCLE_PREFLIGHT_CONSUMED",
  transactionFailed: "LIFECYCLE_TRANSACTION_FAILED",
  postCommitVerifyFailed: "LIFECYCLE_POST_COMMIT_VERIFY_FAILED",
  physicalFileOperationForbidden: "LIFECYCLE_PHYSICAL_FILE_OPERATION_FORBIDDEN"
} as const;

export type ExperimentRunLifecycleErrorCode =
  (typeof EXPERIMENT_RUN_LIFECYCLE_ERROR_CODES)[keyof typeof EXPERIMENT_RUN_LIFECYCLE_ERROR_CODES];

export interface LifecycleDependencyCount { kind: string; count: number }

export interface ExperimentRunLifecycleDatabasePreflight {
  ownerType: ExperimentManuscriptOwnerType;
  ownerId: EntityId;
  deleted: boolean;
  ownerRevision: ISODateString;
  deletedAt?: ISODateString;
  blockingDependencies: LifecycleDependencyCount[];
  cleanableRelations: LifecycleDependencyCount[];
  bindingIds: EntityId[];
  fileRefIds: EntityId[];
  representativeRelationIds: EntityId[];
  bindingCount: number;
  fileRefCount: number;
  metricCount: number;
  representativeRelationCount: number;
  physicalFileActionCount: 0;
  stateDigest: string;
}

export interface ExperimentRunLifecycleSessionSummary {
  sessionKey: string;
  fileRefId?: EntityId;
  mode?: "current" | "independent";
  dirty: boolean;
  loadStatus: string;
  saveStatus: string;
  conflict: boolean;
  writeAppliedUnverified: boolean;
  recovery: boolean;
  closed: boolean;
  disposed: boolean;
  ownerDeleted: boolean;
  parentDeleted: boolean;
  revalidationRequired: boolean;
}

export type ExperimentRunLifecyclePreflightResult =
  | (ExperimentRunLifecycleDatabasePreflight & {
      status: "ready";
      requiresConfirmation: true;
      preflightToken: string;
      expiresAt: ISODateString;
      sessionDigest: string;
      sessions: ExperimentRunLifecycleSessionSummary[];
    })
  | { status: "blocked"; error: { code: ExperimentRunLifecycleErrorCode; message: string }; preflight?: ExperimentRunLifecycleDatabasePreflight }
  | { status: "error"; error: { code: ExperimentRunLifecycleErrorCode; message: string } };

export type ExperimentRunLifecycleMutationResult =
  | {
      status: "success";
      ownerType: ExperimentManuscriptOwnerType;
      ownerId: EntityId;
      changed: boolean;
      operationLogId?: EntityId;
      physicalFileActionCount: 0;
      partial?: boolean;
      warnings?: string[];
      occurredAt?: ISODateString;
      authoritativeState?: "active" | "deleted" | "permanently_deleted";
    }
  | { status: "error"; error: { code: ExperimentRunLifecycleErrorCode; message: string } };

export interface ExperimentRunLifecycleMutationInput {
  ownerType: ExperimentManuscriptOwnerType;
  ownerId: EntityId;
  occurredAt: ISODateString;
  operationId: EntityId;
}

export interface ExperimentRunLifecycleTokenIssueInput {
  ownerType: ExperimentManuscriptOwnerType;
  ownerId: EntityId;
  expectedStateDigest: string;
  sessionDigest: string;
  externalDependencyDigest: string;
}

export interface ExperimentRunLifecycleIssuedToken {
  preflightToken: string;
  expiresAtUnixMs: number;
}

export interface ExperimentRunLifecycleHardDeleteInput {
  preflightToken: string;
  occurredAt: ISODateString;
  operationId: EntityId;
}
