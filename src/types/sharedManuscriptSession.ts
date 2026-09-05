import type {
  DurableFileIdentity,
  FileIdentity,
  ManuscriptOperationError,
  ManuscriptPhysicalRevision,
  ManuscriptRecoveryState,
  OwnerIdentity,
  RawManuscriptSnapshot
} from "./manuscriptOperation";

export type ManuscriptWindowRole = "current" | "independent";
export type SharedManuscriptSessionKey = string;
export type SharedManuscriptSessionHandle = string;
export type SharedManuscriptAccessMode = "writable" | "read-only";
export type SharedManuscriptOperationKind =
  | "load"
  | "save"
  | "reload"
  | "discard"
  | "close";

export interface SharedLogicalSessionIdentity {
  ownerType: string;
  ownerId: string;
  channel: string;
  windowRole: ManuscriptWindowRole;
  fileRefId: string;
}

export interface SharedTargetSnapshot {
  file: FileIdentity;
  expectedCurrentFileRefId?: string;
  bindingRevision?: string;
  lifecycleRevision?: string;
  readOnly: boolean;
  physicalRevision?: ManuscriptPhysicalRevision;
}

export interface SharedOperationToken {
  sessionKey: SharedManuscriptSessionKey;
  sessionGeneration: number;
  operationGeneration: number;
  operationToken: string;
  kind: SharedManuscriptOperationKind;
  draftVersion: number;
  savedRaw: string;
  expectedPhysicalRevision?: ManuscriptPhysicalRevision;
}

export interface SharedManuscriptSession {
  key: SharedManuscriptSessionKey;
  sessionKey: SharedManuscriptSessionKey;
  logicalIdentity: SharedLogicalSessionIdentity;
  owner: OwnerIdentity;
  windowRole: ManuscriptWindowRole;
  file: FileIdentity;
  targetSnapshot: SharedTargetSnapshot;
  accessMode: SharedManuscriptAccessMode;
  baseline?: RawManuscriptSnapshot;
  openedRawText?: string;
  draftRawText: string;
  openedRevision?: ManuscriptPhysicalRevision;
  currentRevision?: ManuscriptPhysicalRevision;
  encoding?: "utf-8" | "utf-8-bom";
  newline?: "lf" | "crlf" | "mixed" | "none";
  dominantNewline?: "lf" | "crlf";
  sessionGeneration: number;
  operationGeneration: number;
  requestGeneration: number;
  draftVersion: number;
  dirty: boolean;
  loadStatus: "idle" | "loading" | "ready" | "error";
  saveStatus:
    | "idle"
    | "saving"
    | "saved"
    | "conflict"
    | "error"
    | "recovery-required";
  activeOperation?: SharedOperationToken;
  stale: boolean;
  externalChangeObserved: boolean;
  closing: boolean;
  error?: ManuscriptOperationError;
  recoveryRequired: boolean;
  recovery?: ManuscriptRecoveryState;
  consumerCount: number;
  consumerHandle?: SharedManuscriptSessionHandle;
  externalWriteConfirmedGeneration?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SharedWritableTargetRequest {
  fileRefId: string;
  filePath: string;
  expectedPathIdentity: string;
  expectedFileName: string;
  locationMode: "managed" | "external";
  configuredRoot?: string;
}

export interface SharedWritableAdmissionGrant {
  proof: string;
  generation: string;
  logicalSessionKey: string;
  fileRefId: string;
  canonicalPathIdentity: string;
  referenceCount: number;
  renewSequence: number;
}

export interface SharedWritableAdmissionValidation {
  valid: true;
  generation: string;
  referenceCount: number;
  renewSequence: number;
}

export interface SharedWritableAdmissionRelease {
  released: boolean;
  finalRelease: boolean;
  referenceCount: number;
}

export interface SharedWritableAdmissionPort {
  acquire(input: {
    requestId: string;
    logicalSessionKey: string;
    target: SharedWritableTargetRequest;
  }): Promise<SharedWritableAdmissionGrant>;
  retain(proof: string): Promise<SharedWritableAdmissionGrant>;
  validate(
    proof: string,
    target: SharedWritableTargetRequest
  ): Promise<SharedWritableAdmissionValidation>;
  renew(
    proof: string,
    target: SharedWritableTargetRequest,
    expectedRevision?: ManuscriptPhysicalRevision
  ): Promise<SharedWritableAdmissionValidation>;
  release(proof: string): Promise<SharedWritableAdmissionRelease>;
  detachWindow(): Promise<{ releasedCount: number }>;
}

export interface SharedSessionOpenInput {
  owner: OwnerIdentity;
  target: SharedTargetSnapshot;
  windowRole: ManuscriptWindowRole;
  accessMode: SharedManuscriptAccessMode;
  consumerId?: string;
}

export type SharedSessionRevalidation =
  | { status: "valid"; target: SharedTargetSnapshot }
  | {
      status: "current-changed" | "target-changed" | "read-only";
      causeCode?: string;
    };

export interface SharedSessionHandleResult {
  handle: SharedManuscriptSessionHandle;
  session: SharedManuscriptSession;
}

export type SharedCloseDecision = "save" | "discard" | "cancel";

export interface SharedConsumerReleaseOutcome {
  consumerCleanupState: "released";
  sessionCleanupState: "released" | "retained-by-other-consumer";
  admissionCleanupState: "released" | "legitimately-retained";
}

export type DurableSharedTargetSnapshot = SharedTargetSnapshot & {
  file: DurableFileIdentity;
};

export interface SharedSaveAsTargetActivationInput {
  operationId: string;
  operationGeneration: number;
  processGeneration: string;
  receiptId: string;
  sourceRuntimeGeneration: number;
  expectedSourceRuntimeGeneration: number;
  owner: OwnerIdentity;
  target: DurableSharedTargetSnapshot;
  acceptedSnapshot: RawManuscriptSnapshot;
  consumerId: string;
  expectedCandidateBinding?: SharedSaveAsCandidateRuntimeBinding;
}

export interface SharedSaveAsCandidateRuntimeBinding {
  receiptId: string;
  operationId: string;
  processGeneration: string;
  owner: OwnerIdentity;
  candidateFileRefId: string;
  runtimeHandle: SharedManuscriptSessionHandle;
  runtimeConsumerId: string;
  runtimeGeneration: number;
}

export type SharedSaveAsCandidateCloseResult =
  | { status: "closed"; binding: SharedSaveAsCandidateRuntimeBinding }
  | { status: "already-absent"; receiptId: string }
  | {
      status: "identity-mismatch" | "generation-mismatch";
      receiptId: string;
    }
  | {
      status: "retryable-failure" | "cleanup-blocked";
      receiptId: string;
      errorCode?: string;
    };
