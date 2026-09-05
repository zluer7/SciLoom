import type { EntityId, ISODateString } from "./common";
import type {
  FileRefLocationMode,
  FileRefResourceKind,
  FileRefRole
} from "./experiment";
import type { MissingEntityReference } from "./entityReference";
import type {
  Literature,
  LiteratureEvidenceRole,
  LiteratureLink,
  LiteratureLinkTargetType,
  LiteratureReadingStatus,
  LiteratureRelationType
} from "./literature";
import type { ManuscriptChannel } from "./manuscriptChannel";
import type { LiteratureProvisioningReadinessInspection } from "./manuscriptProvisioning";

export interface LiteratureFileRefSummary {
  id: EntityId;
  title: string;
  fileType: string;
  description?: string;
  path: string;
  pathSummary: string;
  resourceKind: FileRefResourceKind;
  fileRole: FileRefRole;
  locationMode: FileRefLocationMode;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deleted: boolean;
}

export interface LiteratureLinkedTargetSummary {
  targetType: LiteratureLinkTargetType;
  targetId: EntityId;
  title?: string;
  subtitle?: string;
  status?: string;
  projectId?: EntityId | null;
  routeId?: EntityId | null;
  taskId?: EntityId | null;
  sourceAvailable: boolean;
  missingReason?: string;
  missingReference?: MissingEntityReference;
}

export interface LiteratureLinkSummary {
  linkId: EntityId;
  literatureId: EntityId;
  literatureTitle?: string;
  targetType: LiteratureLinkTargetType;
  targetId: EntityId;
  relationType: LiteratureRelationType;
  role?: LiteratureEvidenceRole;
  strength?: LiteratureLink["strength"];
  confidence?: LiteratureLink["confidence"];
  description?: string;
  note?: string;
  target: LiteratureLinkedTargetSummary;
}

export interface LiteratureIntroSummary {
  title: string;
  authors: Literature["authors"];
  year?: Literature["year"];
  venue?: Literature["venue"];
  publicationType?: Literature["publicationType"];
  doi?: Literature["doi"];
  url?: Literature["url"];
  importance?: Literature["importance"];
  keywords: string[];
  venueRank?: string;
  venueNote?: string;
}

export interface LiteratureStructuredOutlineSummary {
  abstract?: string;
  researchProblem?: string;
  applicationObject?: string;
  methodOverview?: string;
  mainConclusion?: string;
  limitations?: string;
  other?: string;
}

export interface LiteratureKnowledgeDepositSummary {
  projectSummary?: string;
  projectRelevance?: string;
  relatedObjectNotes?: string;
  reusableMethods?: string;
  comparableConclusions?: string;
  other?: string;
  linkCount: number;
  importantLinks: LiteratureLinkSummary[];
}

export interface LiteratureMarkdownReadonlyContextItem {
  label: string;
  value: string;
  source:
    | "intro"
    | "structuredOutline"
    | "knowledgeDeposit"
    | "fileRef"
    | "link";
  sourceId?: EntityId;
}

export interface LiteratureMarkdownFileRefSummary {
  id: EntityId;
  title: string;
  fileType: string;
  description?: string;
  pathSummary: string;
}

export interface LiteratureMarkdownLinkSummary {
  linkId: EntityId;
  targetType: LiteratureLinkTargetType;
  targetId: EntityId;
  targetTitle?: string;
  relationType: LiteratureRelationType;
  role?: LiteratureEvidenceRole;
  strength?: LiteratureLink["strength"];
  confidence?: LiteratureLink["confidence"];
  description?: string;
  note?: string;
}

export interface LiteratureMarkdownContextSummary {
  intro: LiteratureIntroSummary;
  structuredOutline: LiteratureStructuredOutlineSummary;
  knowledgeDeposit: LiteratureKnowledgeDepositSummary;
  fileRefs: LiteratureMarkdownFileRefSummary[];
  linkSummaries: LiteratureMarkdownLinkSummary[];
  readonlyContextItems: LiteratureMarkdownReadonlyContextItem[];
  manuscriptStatus: LiteratureManuscriptStatusSummary;
}

export type LiteratureContextStatus =
  | "implemented"
  | "partial"
  | "missing"
  | "warning"
  | "not_available"
  | "requires_user_confirmation";

export interface LiteratureContextFieldState {
  field: string;
  status: LiteratureContextStatus;
  hasValue: boolean;
  futureAiSuggestionTarget?: string;
  requiresUserConfirmation: boolean;
  warning?: string;
}

export interface LiteratureContextProvenance {
  section:
    | "intro"
    | "structuredOutline"
    | "knowledgeDeposit"
    | "manuscriptBinding"
    | "literatureLink"
    | "fileRef"
    | "projectContext";
  sourceType:
    | "literature"
    | "customField"
    | "manuscriptBinding"
    | "literatureLink"
    | "fileRef"
    | "planningSelector";
  sourceId: EntityId;
  fields: string[];
  userConfirmed?: boolean;
}

export interface LiteratureFilePathItemSummary {
  id: EntityId;
  displayName: string;
  fileType: string;
  description?: string;
  pathSummary: string;
  canOpen: boolean;
  canCopyPath: boolean;
  canRevealInFolder: boolean;
}

export interface LiteratureFilePathContextSummary {
  hasPdf: boolean;
  hasSupplement: boolean;
  hasExternalNote: boolean;
  hasImageOrScreenshot: boolean;
  hasCodeOrDataReference: boolean;
  fileCount: number;
  fileTypeDistribution: Partial<Record<string, number>>;
  items: LiteratureFilePathItemSummary[];
  fullPathsExcludedFromAiReadyContext: true;
  fileBodiesIncluded: false;
}

export interface LiteratureManuscriptStatusSummary {
  hasBinding: boolean;
  currentFileRefId?: EntityId;
  currentFileName?: string;
  currentLocationMode?: FileRefLocationMode;
  manuscriptStatus: "ready" | "uninitialized" | "missing-current" | "invalid-current";
}

export interface LiteratureCurrentFilenameDto {
  literatureId: EntityId;
  manuscriptChannel: Extract<ManuscriptChannel, "literature_outline" | "dedicated_notes">;
  bindingId?: EntityId;
  currentFileRefId?: EntityId;
  currentFilename?: string;
  currentLocationMode?: FileRefLocationMode;
  status:
    | "ready"
    | "uninitialized"
    | "missing-current"
    | "invalid-current"
    | "invalid-filename";
}

export interface LiteratureCurrentFilenamesByChannel {
  literature_outline: LiteratureCurrentFilenameDto;
  dedicated_notes: LiteratureCurrentFilenameDto;
}

export interface LiteratureLinkedObjectItemSummary {
  linkId: EntityId;
  targetType: LiteratureLinkTargetType;
  targetId: EntityId;
  targetTitle?: string;
  status?: string;
  relationType: LiteratureRelationType;
  role?: LiteratureEvidenceRole;
  description?: string;
  confidence?: LiteratureLink["confidence"];
  isMissing: boolean;
  warning?: string;
}

export interface LiteratureLinkedObjectContextSummary {
  all: LiteratureLinkedObjectItemSummary[];
  linkedProjects: LiteratureLinkedObjectItemSummary[];
  linkedRoutes: LiteratureLinkedObjectItemSummary[];
  linkedTasks: LiteratureLinkedObjectItemSummary[];
  linkedExperiments: LiteratureLinkedObjectItemSummary[];
  linkedExperimentRuns: LiteratureLinkedObjectItemSummary[];
  linkedResultMetrics: LiteratureLinkedObjectItemSummary[];
  linkedFindings: LiteratureLinkedObjectItemSummary[];
  linkedOutputCandidates: LiteratureLinkedObjectItemSummary[];
  linkedOutputGaps: LiteratureLinkedObjectItemSummary[];
  linkedOutputs: LiteratureLinkedObjectItemSummary[];
  linkedReviews: LiteratureLinkedObjectItemSummary[];
  warnings: string[];
  partial: boolean;
}

export interface LiteratureKnowledgeDepositContextSummary {
  projectSummary?: string;
  projectRelevance?: string;
  relatedObjectNotes?: string;
  reusableMethods?: string;
  comparableConclusions?: string;
  other?: string;
  linkedObjects: LiteratureLinkedObjectContextSummary;
}

export interface LiteratureReadContext {
  literatureId: EntityId;
  readingStatus: LiteratureReadingStatus;
  intro: LiteratureIntroSummary;
  structuredOutline: LiteratureStructuredOutlineSummary;
  knowledgeDeposit: LiteratureKnowledgeDepositContextSummary;
  filePaths: LiteratureFilePathContextSummary;
  manuscriptStatus: LiteratureManuscriptStatusSummary;
  fieldStates: LiteratureContextFieldState[];
  provenance: LiteratureContextProvenance[];
  warnings: string[];
  missingFields: string[];
  partial: boolean;
  limitations: string[];
}

export interface LiteratureProjectContextItem {
  id: EntityId;
  title: string;
  status?: string;
  summary?: string;
}

export interface ProjectOrientedLiteratureContext {
  literatureId: EntityId;
  projectId?: EntityId;
  currentProjectGoal?: string;
  researchDirection?: string;
  routeSummary: LiteratureProjectContextItem[];
  taskProgressSummary: LiteratureProjectContextItem[];
  experimentProgressSummary: LiteratureProjectContextItem[];
  outputGapSummary: LiteratureProjectContextItem[];
  currentLiteratureIntro: LiteratureIntroSummary;
  currentLiteratureStructuredOutline: LiteratureStructuredOutlineSummary;
  currentLiteratureManuscriptStatus: LiteratureManuscriptStatusSummary;
  currentLiteratureKnowledgeDeposit: LiteratureKnowledgeDepositContextSummary;
  provenance: LiteratureContextProvenance[];
  warnings: string[];
  missing: string[];
  partial: boolean;
}

export interface LiteratureAiFieldSchemaItem {
  field: string;
  futureWriteTarget: string;
  valueType: "string" | "number" | "string_array" | "author_array";
  required: boolean;
  description: string;
}

export interface LiteratureObjectiveOutlineAiInput {
  adapterVersion: "lp6-5";
  stage: "objective_outline";
  literatureId: EntityId;
  currentLiteratureSnapshot: {
    readingStatus: LiteratureReadingStatus;
    intro: LiteratureIntroSummary;
    structuredOutline: LiteratureStructuredOutlineSummary;
    manuscriptStatus: LiteratureManuscriptStatusSummary;
  } | null;
  missingFieldHints: string[];
  introFieldSchema: LiteratureAiFieldSchemaItem[];
  structuredOutlineFieldSchema: LiteratureAiFieldSchemaItem[];
  filePathSummary: LiteratureFilePathContextSummary | null;
  allowedUserInputTypes: string[];
  constraintDocumentHint: string;
  futureWriteTargets: string[];
  provenance: LiteratureContextProvenance[];
  warnings: string[];
  missing: string[];
  partial: boolean;
  requiresUserConfirmation: true;
}

export interface LiteratureProjectAdaptationAiInput {
  adapterVersion: "lp6-5";
  stage: "project_adaptation";
  literatureId: EntityId;
  objectiveOutlineReportSummaryOrReference?: string;
  currentLiteratureIntro: LiteratureIntroSummary | null;
  currentLiteratureStructuredOutline: LiteratureStructuredOutlineSummary | null;
  currentLiteratureManuscriptStatus: LiteratureManuscriptStatusSummary | null;
  currentLiteratureKnowledgeDeposit: LiteratureKnowledgeDepositContextSummary | null;
  existingLinkedObjectSummary: LiteratureLinkedObjectContextSummary | null;
  projectContext: ProjectOrientedLiteratureContext | null;
  knowledgeDepositFieldSchema: LiteratureAiFieldSchemaItem[];
  futureWriteTargets: string[];
  provenance: LiteratureContextProvenance[];
  warnings: string[];
  missing: string[];
  partial: boolean;
  requiresUserConfirmation: true;
}

export interface LiteratureReadingStats {
  literatureId?: EntityId;
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
  activityCount: number;
  totalDurationMinutes: number;
  averageDurationMinutes: number;
  readingStatusDistribution: Partial<Record<LiteratureReadingStatus, number>>;
  intensiveReadCount: number;
  summarizedCount: number;
  reusedCount: number;
  discardedCount: number;
  lastReadingDate?: ISODateString;
}

export interface LiteratureAiReadingStatsSummary {
  totalActivities: number;
  totalDurationMinutes: number;
  averageDurationMinutes: number;
  lastReadingDate?: ISODateString;
  statusDistribution: Record<string, number>;
  warnings: string[];
  limitations: string[];
}

export interface LiteratureDetailContext {
  literature: Literature;
  fileRefs: LiteratureFileRefSummary[];
  manuscriptStatus: LiteratureManuscriptStatusSummary;
  currentFilenames: LiteratureCurrentFilenamesByChannel;
  provisioningReadiness: LiteratureProvisioningReadinessInspection;
  introSummary: LiteratureIntroSummary;
  structuredOutlineSummary: LiteratureStructuredOutlineSummary;
  knowledgeDepositSummary: LiteratureKnowledgeDepositSummary;
  markdownContextSummary: LiteratureMarkdownContextSummary;
  readContext: LiteratureReadContext;
  links: LiteratureLink[];
  linkSummaries: LiteratureLinkSummary[];
  readingStats: LiteratureReadingStats;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface ProjectLiteratureContext {
  projectId: EntityId;
  literatures: Literature[];
  primaryProjectLiteratures: Literature[];
  links: LiteratureLink[];
  linkSummaries: LiteratureLinkSummary[];
  readingStats: LiteratureReadingStats;
  groupedByRelationType: Partial<Record<LiteratureRelationType, Literature[]>>;
  groupedByReadingStatus: Partial<Record<LiteratureReadingStatus, Literature[]>>;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface RouteLiteratureContext {
  routeId: EntityId;
  literatures: Literature[];
  links: LiteratureLink[];
  linkSummaries: LiteratureLinkSummary[];
  readingStats: LiteratureReadingStats;
  groupedByRelationType: Partial<Record<LiteratureRelationType, Literature[]>>;
  groupedByReadingStatus: Partial<Record<LiteratureReadingStatus, Literature[]>>;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface TaskLiteratureContext {
  taskId: EntityId;
  literatures: Literature[];
  links: LiteratureLink[];
  linkSummaries: LiteratureLinkSummary[];
  readingStats: LiteratureReadingStats;
  groupedByRelationType: Partial<Record<LiteratureRelationType, Literature[]>>;
  groupedByReadingStatus: Partial<Record<LiteratureReadingStatus, Literature[]>>;
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface ExperimentLiteratureContext {
  experimentId: EntityId;
  literatures: Literature[];
  links: LiteratureLink[];
  linkSummaries: LiteratureLinkSummary[];
  readingStats: LiteratureReadingStats;
  groupedByRelationType: Partial<Record<LiteratureRelationType, Literature[]>>;
  baseline: Literature[];
  methodReferences: Literature[];
  parameterReferences: Literature[];
  dataProcessingReferences: Literature[];
  evaluationMetricReferences: Literature[];
  experimentComparisons: Literature[];
  resultInterpretations: Literature[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export type LiteratureSupportGapType =
  | "missing_related_work"
  | "missing_method_reference"
  | "missing_experiment_evidence"
  | "missing_discussion_support"
  | "low_reading_context";

export interface LiteratureSupportGap {
  id: EntityId;
  targetType: LiteratureLinkTargetType;
  targetId: EntityId;
  gapType: LiteratureSupportGapType;
  severity: "high" | "medium" | "low";
  message: string;
  suggestedAction?: string;
}

export interface OutputCandidateLiteratureContext {
  outputCandidateId: EntityId;
  literatures: Literature[];
  links: LiteratureLink[];
  linkSummaries: LiteratureLinkSummary[];
  readingStats: LiteratureReadingStats;
  groupedByRole: Partial<Record<LiteratureEvidenceRole, Literature[]>>;
  introductionSupport: Literature[];
  relatedWorkSupport: Literature[];
  methodSupport: Literature[];
  experimentSupport: Literature[];
  discussionSupport: Literature[];
  patentBackgroundSupport: Literature[];
  reportSupport: Literature[];
  supportGaps: LiteratureSupportGap[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
}

export interface LiteratureWorkloadQuery {
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
  dateFrom?: ISODateString;
  dateTo?: ISODateString;
  includeArchived?: boolean;
  recentLimit?: number;
}

export interface LiteratureWorkloadOverview {
  query: LiteratureWorkloadQuery;
  literatureCount: number;
  readLiteratureCount: number;
  totalReadingActivityCount: number;
  totalDurationMinutes: number;
  readingStatusDistribution: Partial<Record<LiteratureReadingStatus, number>>;
  intensiveReadCount: number;
  summarizedCount: number;
  reusedCount: number;
  discardedCount: number;
  readingStatsByLiterature: LiteratureReadingStats[];
}

export interface AiLiteratureContextOptions {
  literatureId?: EntityId;
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
  experimentId?: EntityId;
  outputCandidateId?: EntityId;
  includeArchived?: boolean;
  includeUnconfirmed?: boolean;
  limit?: number;
}

export interface AiLiteratureContext {
  options: AiLiteratureContextOptions;
  literatures: LiteratureReadContext[];
  links: LiteratureLinkedObjectItemSummary[];
  linkSummaries: LiteratureLinkedObjectItemSummary[];
  readingStats: LiteratureAiReadingStatsSummary;
  contextSummary: string;
  provenance: LiteratureContextProvenance[];
  warnings: string[];
  missingReferences: MissingEntityReference[];
  partial: boolean;
  limitations: string[];
}
