export type AIContextModule =
  | "project"
  | "route"
  | "task"
  | "review"
  | "experiment"
  | "literature"
  | "output"
  | "outputConversion"
  | "entityLink"
  | "ai"
  | "system";

export type AIContextEntityType =
  | "project"
  | "routeNode"
  | "task"
  | "review"
  | "outputGap"
  | "experiment"
  | "experimentRun"
  | "resultMetric"
  | "fileRef"
  | "literature"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "evidenceChain"
  | "formalOutput"
  | "researchOutput"
  | "entityLink"
  | "aiRun"
  | "system";

export type AIContextSourceKind =
  | "userAuthored"
  | "systemGenerated"
  | "aiGenerated"
  | "imported"
  | "derivedSummary"
  | "linkedReference";

export type AIContextPriority = "critical" | "high" | "medium" | "low" | "background";

export type AIContextMode =
  | "MINIMAL"
  | "BRIEF"
  | "STANDARD"
  | "DETAILED";

/** One bounded composition policy inside the single canonical Context Builder. */
export type AIContextCompositionPolicy = "LITERATURE_OBJECTIVE_OUTLINE";

export type AILiteratureOriginalMaterialResolutionDisposition =
  | "NOT_APPLICABLE"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "RESOLVED_SAFE_ATTACHABLE"
  | "RESOLVED_IDENTITY_BODY_UNSUPPORTED"
  | "RESOLVED_IDENTITY_NOT_ATTACHABLE";

/** Historical transport values remain read-compatible but are never active UI modes. */
export type AILegacyContextMode =
  | "MINIMUM_BACKGROUND"
  | "PROJECT_BACKGROUND"
  | "LIGHT"
  | "STANDARD_CONTEXT";

export type AIOutputDetailPreference =
  | "CONCISE"
  | "STANDARD"
  | "DETAILED"
  | "UNRESTRICTED";

export type AIProviderInputClass =
  | "AUTO_PULLED_RESEARCH_CONTEXT"
  | "USER_EXPLICIT_TASK_OR_INPUT_CONTENT"
  | "CONVERSATION_CONTINUITY_INPUT"
  | "SYSTEM_CONSTRAINT_AND_PROTOCOL"
  | "TECHNICAL_CAPACITY_OR_SAFETY_GUARD";

export interface AIProviderInputClassLedgerEntry {
  inputClass: AIProviderInputClass;
  characters: number;
  autoPullBudgetTreatment: "COUNTED" | "EXCLUDED";
  presence: "PRESENT" | "ABSENT";
  droppedForAutoPullBudget: false;
  components: string[];
}

export interface AITechnicalCapacityReceipt {
  classification: "TECHNICAL_CAPACITY_OR_SAFETY_GUARD" | "PARSE_DYNAMIC_CONTEXT_BUDGET";
  sourceOwner:
    | "frontend-and-rust-absolute-payload-safety-guard"
    | "frontend-and-rust-parse-dynamic-context-budget";
  maxCharacters: number;
  estimatedCharacters: number;
  status: "WITHIN_GUARD" | "TECHNICAL_CAPACITY_OR_SAFETY_ERROR";
}

export interface AIParseDynamicContextBudgetReceipt {
  classification: "PARSE_DYNAMIC_CONTEXT_BUDGET";
  includedInputClass: "SOFTWARE_DYNAMIC_CONTEXT";
  excludedInputClasses: readonly ["FIXED_SYSTEM_CONTENT", "USER_EXPLICIT_CONTENT"];
  maxCharacters: number;
  estimatedCharacters: number;
  status: "WITHIN_GUARD" | "TECHNICAL_CAPACITY_OR_SAFETY_ERROR";
  components: {
    researchContextCharacters: number;
    conversationContinuityCharacters: number;
    requestableRefsCharacters: number;
    alreadySuppliedRefsCharacters: number;
    quickAnalysisCapabilityCharacters: number;
    contextRequestFollowupCharacters: number;
    runScopedMetadataCharacters: number;
  };
}

export type AIContextLevel = 1 | 2 | 3 | 4;

export type AIResearchObjectType =
  | "route"
  | "task"
  | "review"
  | "experiment"
  | "experimentRun"
  | "literature"
  | "finding"
  | "resultItem"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type AILevel4ObjectType =
  | "route"
  | "task"
  | "review"
  | "experiment"
  | "experimentRun"
  | "literature"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export interface AILevel4RelationKey {
  relationType: string;
  targetType: AILevel4ObjectType;
  targetId: string;
}

export type AILevel4MembershipSource =
  | "direct_project_id"
  | "experiment_parent_and_run_project_id"
  | "primary_project_id";

export interface AILevel4IncludedItem {
  objectType: AILevel4ObjectType;
  canonicalId: string;
  safeLabel: string;
  safeSummary?: string;
  status?: string;
  relationKeys: AILevel4RelationKey[];
  membershipSource: AILevel4MembershipSource;
  relationSource: "canonical_direct_fields" | "none";
  inclusionReason: "confirmed_current_project_member";
}

export interface AILevel4ExclusionSummary {
  objectType: AILevel4ObjectType;
  reason: string;
  count: number;
  disposition: "excluded" | "degraded";
  sampleLabels?: string[];
}

export type AILevel4SnapshotDecision = "included" | "degraded" | "excluded";

export interface AILevel4Snapshot {
  policyVersion: "lp13-b1-c3-level4-v1";
  decision: AILevel4SnapshotDecision;
  fingerprint: string;
  includedItems: AILevel4IncludedItem[];
  exclusionSummary: AILevel4ExclusionSummary[];
}

/** Canonical Run-parent provenance frozen inside the existing source-ref JSON authority. */
export interface AIExperimentRunParentRelation {
  runId: string;
  parentExperimentId: string;
  projectId: string;
  selectionOrder: number;
}

export type AILiteratureProjectAssociationKind = "assigned" | "projectless";
export type AILiteratureLifecycleEligibility = "eligible";
export type AILiteratureConversationProjectEligibilityDisposition =
  | "allowed_same_project"
  | "allowed_global_projectless";
export type AILiteratureSelectionAggregateEligibility = "ALLOWED";

/** Canonical optional-Project and reviewed safe-projection truth for one selected Literature ref. */
export interface AILiteratureAssociationTuple {
  literatureId: string;
  projectAssociationKind: AILiteratureProjectAssociationKind;
  canonicalProjectId: string | null;
  lifecycleEligibility: AILiteratureLifecycleEligibility;
  conversationProjectEligibilityDisposition: AILiteratureConversationProjectEligibilityDisposition;
  selectionOrder: number;
  normalizedProjectionFingerprint: string;
}

/** Exact allowlisted application-owned metadata; path/body fields cannot be represented. */
export interface AILiteratureSafeProjection {
  literatureId: string;
  title: string;
  authorNames: string[];
  year: number | null;
  venue: string | null;
  publicationType: string | null;
  abstract: string | null;
  keywords: string[];
  doi: string | null;
  readingStatus: string;
  importance: string | null;
  tags: string[];
  canonicalProjectId: string | null;
  schemaVersion: number;
}

export type AIContextSourceRole = "scope" | "primary" | "related" | "background" | "explicitMaterial";

export type AIContextSourceDisposition = "included" | "excluded";

export type AIContextScopeType =
  | "project"
  | "route"
  | "task"
  | "review"
  | "outputGap"
  | "experiment"
  | "literature"
  | "outputCandidate"
  | "global"
  | "custom";

export type AIContextBudgetStrategy = "balanced" | "recentFirst" | "priorityFirst" | "minimal";

export type AIContextWarningSeverity = "info" | "warning" | "error";

export type AIContextExclusionReason =
  | "privacy"
  | "budget"
  | "forbiddenData"
  | "unsupported"
  | "notSelected"
  | "notSendable";

export type AIContextMetadataValue = string | number | boolean | null;

/** Identifies where a context fragment came from; it does not prove the source is factual. */
export interface AIContextSourceRef {
  module: AIContextModule;
  entityType: AIContextEntityType;
  entityId: string;
  label?: string;
  field?: string;
  sourceKind: AIContextSourceKind;
  isUserAuthored?: boolean;
  isAiGenerated?: boolean;
  isVerified?: boolean;
  confidenceNote?: string;
  /** Frozen call-context metadata. These fields remain projections of the canonical source. */
  contextMode?: AIContextMode;
  contextLevel?: AIContextLevel;
  contextRole?: AIContextSourceRole;
  contextDisposition?: AIContextSourceDisposition;
  relationHint?: string;
  /** LP13-D1-A6 frozen orchestration provenance. These fields grant no authority by themselves. */
  quickAnalysisRunId?: string;
  quickAnalysisAuthorizationSource?: "USER_CLICKED_AI_ANALYSIS" | "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION";
  quickAnalysisOwnerType?: import("./experiment").FileRefOwnerType;
  quickAnalysisOwnerId?: string;
  quickAnalysisChannel?: import("./manuscriptChannel").ManuscriptChannel;
  quickAnalysisProjectId?: string;
  quickAnalysisSourceFileRefId?: string;
  quickAnalysisSourceDirectoryFileRefId?: string;
  quickAnalysisWhitelistFingerprint?: string;
  quickAnalysisAutoContextBudgetLimit?: 1;
  quickAnalysisAutoContextBudgetRemaining?: 0 | 1;
  quickAnalysisContextCapabilityState?: AIQuickAnalysisContextCapabilityState;
  /** LP13-E1-A7 best-effort exact Literature original-material provenance. */
  literatureOriginalMaterialResolutionDisposition?: AILiteratureOriginalMaterialResolutionDisposition;
  literatureOriginalMaterialFileRefId?: string;
  literatureOriginalMaterialBodyUsable?: boolean;
  literatureOriginalMaterialAutoAttachDisposition?: "ATTACHED" | "DEFERRED_NONBLOCKING" | "SKIPPED_NONBLOCKING";
  /** LP13-E1-A4 typed Quick Context follow-up authorization provenance. */
  quickAnalysisFollowupContextRequestId?: string;
  quickAnalysisFollowupBodyAuthorizationEntries?: AIQuickFollowupBodyAuthorizationEntry[];
  quickAnalysisFollowupMetadataReferenceEntries?: AIQuickFollowupMetadataReferenceEntry[];
  /** LP13-B1-A12 canonical ExperimentRun-parent relation tuple. */
  runParentExperimentId?: string;
  runInheritedProjectId?: string;
  runSelectionOrder?: number;
  /** LP13-B1-A15 canonical Literature optional-Project/projection tuple. */
  literatureProjectAssociationKind?: AILiteratureProjectAssociationKind;
  literatureCanonicalProjectId?: string | null;
  literatureLifecycleEligibility?: AILiteratureLifecycleEligibility;
  literatureConversationProjectEligibilityDisposition?: AILiteratureConversationProjectEligibilityDisposition;
  literatureSelectionOrder?: number;
  literatureNormalizedProjectionFingerprint?: string;
  literatureSelectionAggregateEligibility?: AILiteratureSelectionAggregateEligibility;
  /** LP13-B1-C3 frozen internal metadata; prompt serialization never renders these fields. */
  level4ObjectType?: AILevel4ObjectType;
  level4CanonicalProjectId?: string;
  level4SafeSummary?: string;
  level4Status?: string;
  level4MembershipSource?: AILevel4MembershipSource;
  level4RelationSource?: "canonical_direct_fields" | "none";
  level4RelationKeys?: AILevel4RelationKey[];
  level4InclusionReason?: "confirmed_current_project_member";
  level4SummaryDisposition?: "included" | "omitted_for_budget";
  level4SnapshotPolicyVersion?: AILevel4Snapshot["policyVersion"];
  level4SnapshotDecision?: AILevel4SnapshotDecision;
  level4SnapshotFingerprint?: string;
  level4IncludedItemCount?: number;
  level4ExclusionSummary?: AILevel4ExclusionSummary[];
  /** LP13-B1-A3 durable constraint provenance; absent for legacy and Action Draft attempts. */
  constraintCategory?: import("./aiConstraint").AIConstraintCategory;
  constraintLifecycle?: import("./aiConstraint").AIConstraintCategoryLifecycle;
  constraintRef?: string;
  constraintVersion?: number;
  constraintContentHash?: string;
  sharedInvariantRef?: string;
  sharedInvariantVersion?: number;
  sharedInvariantContentHash?: string;
  boundedPolicyRefs?: string[];
  boundedPolicyDocuments?: import("./aiConstraint").AIExecutableBoundedPolicyIdentity[];
  boundedPolicyContentHash?: string;
  /**
   * LP14-A1-C5 Parse-only supplemental-context orchestration provenance.
   * These fields record a mechanical, attempt-scoped projection and never
   * grant Context, material, or business-write authority.
   */
  parseSupplementalContextWorkflowKind?: "PARSE_DRAFT";
  parseSupplementalContextPhase?: "PHASE_A_ELIGIBLE" | "PHASE_B_AUTOMATIC";
  parseSupplementalContextLogicalAttemptId?: string;
  parseSupplementalContextSourceCallAttemptId?: string;
  parseSupplementalContextRequestLimit?: 1;
  parseSupplementalContextRequestRemaining?: 0 | 1;
  parseSupplementalContextAutomaticContinuationCount?: 0 | 1;
  parseSupplementalContextProjectionFingerprint?: string;
  parseSupplementalContextProjections?: import("./aiContextRequest").AIParseSupplementalContextProjection[];
  legacySourceMarker?: import("./aiConstraint").AIConstraintLegacySourceMarker;
  /** LP13-F1-A1 start-time source receipt; it grants no read authority. */
  quickAnalysisSourceSnapshotSemantics?: "START_TIME_SNAPSHOT";
  quickAnalysisSourceContentReceipt?: AIMaterialFreshnessReceipt;
  quickAnalysisSourceContentHash?: string;
  /** LP13-B1-A6 application-owned Parse Draft scope provenance. */
  parseDiscussionFingerprint?: string;
  parseDiscussionMessageIds?: string[];
  parseProjectId?: string;
  parseRouteIds?: string[];
  parseTaskIds?: string[];
  parseReviewIds?: string[];
  parseExperimentIds?: string[];
  parseExperimentRunIds?: string[];
  parseExperimentRunParentRelations?: AIExperimentRunParentRelation[];
  parseLiteratureIds?: string[];
  parseFindingIds?: string[];
  parseLiteratureAssociationTuples?: AILiteratureAssociationTuple[];
  parseLiteratureSelectionAggregateEligibility?: AILiteratureSelectionAggregateEligibility;
  parseContextReviewFingerprint?: string;
  parseContextMode?: AIContextMode;
}

export type AIContextRequestableRefKind = "AI_RESEARCH_OBJECT" | "FILE_REF";
export type AIRequestedContributionKind = "IDENTITY_METADATA" | "BODY_CONTENT";

/** Bounded canonical identities exposed to an eligible Task-scoped NORMAL_QA call. */
export interface AIContextRequestableRef {
  refKind: AIContextRequestableRefKind;
  refId: string;
  projectId: string;
  label: string;
  entityType:
    | "task"
    | "review"
    | "experiment"
    | "experimentRun"
    | "literature"
    | "finding"
    | "resultItem"
    | "outputCandidate"
    | "outputGap"
    | "researchOutput"
    | "fileRef";
  allowedContributionKinds: AIRequestedContributionKind[];
}

/** Fresh canonical request contribution passed through the single A2 finalizer. */
export interface AIApprovedContextRequestContribution {
  refKind: AIContextRequestableRefKind;
  refId: string;
  projectId: string;
  label: string;
  contributionKind: AIRequestedContributionKind;
  availability: "available";
  fileBodyAuthorizationRequired: boolean;
}

export interface AIResearchObjectSelection {
  objectType: AIResearchObjectType;
  objectId: string;
}

/** Live-derived, safe identity for a selected research object. It is never a second persisted owner. */
export interface AIResearchObjectDescriptor {
  objectType: AIResearchObjectType;
  objectId: string;
  projectId: string;
  label: string;
  description?: string;
  sourceRef: AIContextSourceRef;
  safeMetadata?: Record<string, AIContextMetadataValue>;
  literatureSafeProjection?: AILiteratureSafeProjection;
  ownerModule: "route" | "task" | "review" | "experiment" | "literature" | "output" | "outputConversion";
  channel: "global_chat";
}

/**
 * Opaque, local-only proof produced by the canonical Rust FileRef metadata reader.
 * It is frozen into the reviewed Context correlation and never rendered to a Provider.
 */
export interface AIMaterialFreshnessReceipt {
  fileRefId: string;
  receiptVersion: "material-source-v1";
  sourceToken: string;
}

export type AIQuickFollowupBodyAuthorizationOrigin =
  | "RUN_SCOPED_FROZEN_SOURCE"
  | "CONTEXT_REQUEST_APPROVAL";

/**
 * Durable provenance for one canonical BODY entry in a Quick Analysis
 * Context Request follow-up. The FileRef id is only a summary identity: the
 * scope, freshness and lineage fields are part of the equality contract.
 */
export interface AIQuickFollowupBodyAuthorizationEntry {
  fileRefId: string;
  materialUse: "BODY_CONTENT";
  authorizationOrigins: AIQuickFollowupBodyAuthorizationOrigin[];
  projectId: string;
  ownerType: import("./experiment").FileRefOwnerType;
  ownerId: string;
  channel: import("./manuscriptChannel").ManuscriptChannel;
  sourceFreshnessIdentity: AIMaterialFreshnessReceipt;
  contextRequestIds: string[];
}

/** Metadata stays in a separate ledger and never grants BODY access. */
export interface AIQuickFollowupMetadataReferenceEntry {
  refKind: "AI_RESEARCH_OBJECT" | "FILE_REF";
  refId: string;
  contributionKind: "IDENTITY_METADATA";
  projectId: string;
  contextRequestId: string;
}

export interface AIContextMaterialSelection {
  fileRefId: string;
  displayName: string;
  availabilityStatus: string;
  materialReadStatus: string;
  /** Canonical Rust-produced upper bound; body content is not read by the frontend. */
  materialPromptReservationCharacters: number;
  /** Canonical Rust-produced metadata-only reviewed baseline. */
  materialFreshnessReceipt?: AIMaterialFreshnessReceipt;
}

export interface AIContextMaterialDecision extends AIContextMaterialSelection {
  selected: true;
  authorizationStatus: "pending_per_call_authorization";
  contextRole: "explicitMaterial";
  contextLevel: 1;
}

export interface AIContextItem {
  id: string;
  title: string;
  summary: string;
  content?: string;
  module: AIContextModule;
  entityType: AIContextEntityType;
  sourceRefs: AIContextSourceRef[];
  priority: AIContextPriority;
  contextLevel?: AIContextLevel;
  protectedFromContextBudget?: boolean;
  stableOrder?: number;
  charCount: number;
  sendable: boolean;
  redactionNote?: string;
  truncated: boolean;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, AIContextMetadataValue>;
}

export interface AIContextSection {
  id: string;
  title: string;
  description?: string;
  module: AIContextModule;
  items: AIContextItem[];
  priority: AIContextPriority;
  charCount: number;
  budgetUsed: number;
  truncated: boolean;
  sourceRefs: AIContextSourceRef[];
}

export interface AIContextBudget {
  maxChars: number;
  /** @deprecated User content is outside the Auto-Pull Research Context budget; must be zero. */
  reservedForUserQuestion: number;
  /** @deprecated Constraint/protocol content is outside the Auto-Pull Research Context budget; must be zero. */
  reservedForSystemInstruction: number;
  maxSectionChars?: number;
  maxItemChars?: number;
  strategy: AIContextBudgetStrategy;
}

export interface AIContextBudgetSummary {
  maxChars: number;
  usedChars: number;
  remainingChars: number;
  truncatedSections: number;
  truncatedItems: number;
  excludedItems: number;
  notes: string[];
  budgetScope?: "AUTO_PULLED_RESEARCH_CONTEXT";
  inputClassLedger?: AIProviderInputClassLedgerEntry[];
  technicalCapacity?: AITechnicalCapacityReceipt;
  parseDynamicContextBudget?: AIParseDynamicContextBudgetReceipt;
  outputDetailPreference?: AIOutputDetailPreference;
}

export interface AIContextCompressionPolicy {
  strategy: AIContextBudgetStrategy;
  preserveSourceRefs: boolean;
  preserveRecentReviews: boolean;
  preserveOpenGaps: boolean;
  preserveActiveTasks: boolean;
  allowLowPriorityDrop: boolean;
}

export interface AIContextBuildOptions {
  scopeType: AIContextScopeType;
  scopeId?: string;
  includeModules?: AIContextModule[];
  excludeModules?: AIContextModule[];
  budget?: AIContextBudget;
  compressionPolicy?: AIContextCompressionPolicy;
  includeSourceRefs?: boolean;
  includeMetadata?: boolean;
  previewOnly?: boolean;
  contextMode?: AIContextMode;
  researchObjects?: AIResearchObjectSelection[];
  selectedMaterials?: AIContextMaterialSelection[];
  approvedContextRequestContributions?: AIApprovedContextRequestContribution[];
  /** LP13-E1-A7 channel-specific composition; it does not create a second builder. */
  compositionPolicy?: AIContextCompositionPolicy;
}

export interface AIContextScope {
  type: AIContextScopeType;
  id?: string;
  label?: string;
  description?: string;
}

export interface AIContextWarning {
  code: string;
  message: string;
  severity: AIContextWarningSeverity;
  sourceRefs: AIContextSourceRef[];
}

export interface AIContextExcludedItem {
  reason: AIContextExclusionReason;
  module: AIContextModule;
  entityType: AIContextEntityType;
  entityId?: string;
  label?: string;
  sourceRefs: AIContextSourceRef[];
  level4ObjectType?: AILevel4ObjectType;
  level4Reason?: string;
  level4Disposition?: "excluded" | "degraded";
  aggregateCount?: number;
  sampleLabels?: string[];
}

export interface AIContextPreview {
  sections: AIContextSection[];
  sourceRefs: AIContextSourceRef[];
  budgetSummary?: AIContextBudgetSummary;
  excluded: AIContextExcludedItem[];
  warnings: AIContextWarning[];
  estimatedChars: number;
}

export interface AIContextPackage {
  id: string;
  version: string;
  createdAt: string;
  scope: AIContextScope;
  sections: AIContextSection[];
  sourceRefs: AIContextSourceRef[];
  budget?: AIContextBudget;
  budgetSummary?: AIContextBudgetSummary;
  warnings?: AIContextWarning[];
  excluded?: AIContextExcludedItem[];
  preview?: AIContextPreview;
  contextMode?: AIContextMode;
  compositionPolicy?: AIContextCompositionPolicy;
  researchObjects?: AIResearchObjectDescriptor[];
  materialDecisions?: AIContextMaterialDecision[];
  requestableRefs?: AIContextRequestableRef[];
  approvedContextRequestContributions?: AIApprovedContextRequestContribution[];
  /** Internal review/receipt projection. Provider payload remains section/item allowlist only. */
  level4Snapshot?: AILevel4Snapshot;
  /** Deterministic review identity; excludes package ids and timestamps. */
  reviewFingerprint?: string;
}

export interface AIProviderPromptHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * LP13-D1-A9 run-local capability metadata. It narrows the existing canonical
 * Context Request protocol for one Quick Analysis run and is not durable authority.
 */
export type AIQuickAnalysisContextCapabilityState =
  | "CONTEXT_ALLOWED"
  | "CONTEXT_EXHAUSTED";

export interface AIQuickAnalysisContextCapability {
  runId: string;
  wholeRunBudgetLimit: 1;
  remaining: 0 | 1;
  state: AIQuickAnalysisContextCapabilityState;
}

/**
 * Exact same-Conversation approval/follow-up receipt. The one permitted request
 * for this semantic flow has been consumed, so the follow-up must complete from
 * the now-supplied context without opening another request round.
 */
export interface AIContextRequestFollowupState {
  scope:
    | "SAME_CONVERSATION_APPROVED_FOLLOWUP"
    | "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP";
  limit: 1;
  remaining: 0;
  state: "CONTEXT_EXHAUSTED";
}

export interface AICurrentCallAuthorizedMaterialRef {
  ordinal: number;
  refId: string;
}

/**
 * Parse-only transport metadata. Rust composes these software-owned dynamic
 * segments after the fixed run directive and applies the 45k budget to the
 * same canonical components measured by the frontend.
 */
export interface AIParseDynamicContextBudget {
  classification: "PARSE_DYNAMIC_CONTEXT_BUDGET";
  maxCharacters: number;
  runScopedDynamicSegments: string[];
}

/**
 * Provider-visible non-material prompt fields. Authorized file bodies are never
 * present here; Rust derives and reads them from the committed CallAttempt relation.
 */
export interface AIProviderPromptEnvelope {
  constraintDescriptor: import("./aiConstraint").AIActiveConstraintDescriptor;
  constraintSegments: import("./aiConstraint").AIConstraintSemanticSegments;
  researchContext: string;
  runScopedDirective?: string;
  conversationHistory: AIProviderPromptHistoryMessage[];
  userQuestion: string;
  outputDetailPreference: AIOutputDetailPreference;
  quickAnalysisContextCapability?: AIQuickAnalysisContextCapability;
  contextRequestFollowupState?: AIContextRequestFollowupState;
  currentCallAuthorizedMaterialRefs?: AICurrentCallAuthorizedMaterialRef[];
  /**
   * User-selected text transported for this outbound call only. This is not a
   * FileRef, Binding, managed-material relation, or reusable Conversation input.
   */
  oneShotLocalAttachment?: AIOneShotLocalAttachment;
  contextRequestResponseContract?: import("./aiContextRequest").AIContextRequestResponseContract;
  standardResultResponseContract?: import("./aiStandardResult").AIStandardResultResponseContract;
  parseDynamicContextBudget?: AIParseDynamicContextBudget;
  /**
   * Legacy transport field name. For PARSE_DRAFT it is the dynamic-context
   * ceiling and is not a total final-prompt character limit.
   */
  finalPromptHardBudget: number;
}

export interface AIOneShotLocalAttachment {
  safeLeafName: string;
  mediaType: "text/plain" | "text/markdown";
  sizeBytes: number;
  contentCharacters: number;
  content: string;
}

export interface AIPromptPackage {
  id: string;
  createdAt: string;
  /** Run-local custody trace back to the exact ContextPackage used for this prompt. */
  contextPackageId?: string;
  contextPackageVersion?: string;
  contextReviewFingerprint?: string;
  constraintDescriptor: import("./aiConstraint").AIActiveConstraintDescriptor;
  constraintSegments: import("./aiConstraint").AIConstraintSemanticSegments;
  userQuestion: string;
  outputDetailPreference: AIOutputDetailPreference;
  contextMarkdown: string;
  sourceRefs: AIContextSourceRef[];
  finalPrompt: string;
  providerPromptEnvelope: AIProviderPromptEnvelope;
  budgetSummary?: AIContextBudgetSummary;
  warnings?: AIContextWarning[];
}

/** Type-only contract for AI-C2 adapters. AI-C1 does not provide implementations. */
export interface AIContextModuleAdapter {
  module: AIContextModule;
  buildContext(options: AIContextBuildOptions): AIContextSection[] | Promise<AIContextSection[]>;
}
