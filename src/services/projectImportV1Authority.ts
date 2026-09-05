/**
 * SciLoom Project Import v1 machine authority.
 *
 * This module is the sole code-level authority for the accepted JSON shape,
 * manifest, field admission, temporary references, and dependency graph. It
 * deliberately contains no persistence or UI behavior.
 */

export const PROJECT_IMPORT_V1_SCHEMA = "sciloom.project-import" as const;
export const PROJECT_IMPORT_V1_VERSION = 1 as const;
export const PROJECT_IMPORT_V1_MAX_BYTES = 2 * 1024 * 1024;

export const IMPORT_V1_OBJECT_TYPES = [
  "project",
  "route",
  "task",
  "experiment",
  "experimentRun",
  "literature",
  "review",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
] as const;

export type ImportV1ObjectType = (typeof IMPORT_V1_OBJECT_TYPES)[number];

export const IMPORT_V1_OBJECT_COLLECTIONS = [
  "routes",
  "tasks",
  "experiments",
  "experimentRuns",
  "literature",
  "reviews",
  "resultItems",
  "findings",
  "outputCandidates",
  "outputGaps",
  "researchOutputs"
] as const;

export type ImportV1ObjectCollection = (typeof IMPORT_V1_OBJECT_COLLECTIONS)[number];

export interface ImportV1ManifestDefinition {
  type: ImportV1ObjectType;
  collection: "project" | ImportV1ObjectCollection;
  requiredFields: readonly string[];
  optionalFields: readonly string[];
  serviceOwnedFields: readonly string[];
  forbiddenSystemFields: readonly string[];
  dependencyTypes: readonly ImportV1ObjectType[];
  canonicalCreateOwner: string;
  authoritativeReadbackOwner: string;
  structuredOwner: string | null;
  provisioningOwner: string | null;
}

export const IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS = [
  "id",
  "projectId",
  "parentNodeId",
  "routeId",
  "routeNodeId",
  "taskId",
  "experimentId",
  "experimentRunId",
  "runId",
  "sourceId",
  "targetId",
  "outputCandidateId",
  "relatedTaskId",
  "relatedRouteNodeId",
  "fileRefId",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "archivedAt",
  "completedAt",
  "resolvedAt",
  "schemaVersion",
  "source",
  "aiMetadata",
  "customFields",
  "workspaceTitleIdentity",
  "createdLocalDate",
  "createdLocalTime",
  "orderIndex",
  "directionId",
  "externalIds",
  "pdfPath",
  "localFilePath",
  "dataPath",
  "path",
  "pathIdentityKey",
  "fileRefs",
  "attachments",
  "manuscriptBody",
  "body",
  "archiveBlocks",
  "bindingId",
  "defaultFileRefId",
  "currentFileRefId",
  "operationId",
  "importId"
] as const;

const SERVICE_IDENTITY_FIELDS = [
  "id",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "schemaVersion",
  "source"
] as const;

const MANAGED_OWNER_FIELDS = [
  ...SERVICE_IDENTITY_FIELDS,
  "workspaceTitleIdentity",
  "createdLocalDate",
  "createdLocalTime",
  "FileRef",
  "Binding",
  "manuscript body"
] as const;

export const IMPORT_V1_SUPPORTED_OBJECT_MANIFEST: readonly ImportV1ManifestDefinition[] = [
  {
    type: "project",
    collection: "project",
    requiredFields: ["ref", "title"],
    optionalFields: [
      "description", "background", "objective", "scope", "researchQuestion", "status",
      "priority", "startDate", "targetDate", "tags"
    ],
    serviceOwnedFields: [...SERVICE_IDENTITY_FIELDS, "directionId", "orderIndex", "progress"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: [],
    canonicalCreateOwner: "planningService.createProject",
    authoritativeReadbackOwner: "planningService.getProjectById",
    structuredOwner: null,
    provisioningOwner: null
  },
  {
    type: "route",
    collection: "routes",
    requiredFields: ["ref", "title"],
    optionalFields: [
      "parentRef", "description", "objective", "expectedOutput", "nodeType", "status",
      "startDate", "endDate", "timeLabel", "timePrecision", "showInGantt", "captureState",
      "resultNote", "tags"
    ],
    serviceOwnedFields: [...SERVICE_IDENTITY_FIELDS, "projectId", "parentNodeId", "orderIndex"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "route"],
    canonicalCreateOwner: "planningService.createRouteNode",
    authoritativeReadbackOwner: "planningService.getRouteNodeById",
    structuredOwner: null,
    provisioningOwner: null
  },
  {
    type: "task",
    collection: "tasks",
    requiredFields: ["ref", "title"],
    optionalFields: [
      "routeRef", "description", "taskType", "status", "priority", "dueDate", "scheduledDate",
      "timeLabel", "timeBucket", "timePrecision", "captureState", "acceptanceCriteria",
      "resultNote", "blockedReason", "tags"
    ],
    serviceOwnedFields: [...SERVICE_IDENTITY_FIELDS, "projectId", "routeNodeId", "orderIndex", "completedAt"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "route"],
    canonicalCreateOwner: "planningService.createTask",
    authoritativeReadbackOwner: "planningService.getTaskById",
    structuredOwner: null,
    provisioningOwner: null
  },
  {
    type: "experiment",
    collection: "experiments",
    requiredFields: ["ref", "title"],
    optionalFields: [
      "purposeAndQuestion", "conditionSummary", "methodSummary",
      "resultSummary", "conclusionAndNextSteps", "other", "status", "rating", "usableForPaper",
      "usableForReport", "usableForPatent", "tags"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "projectId", "routeId", "taskId"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project"],
    canonicalCreateOwner: "experimentService.createExperiment",
    authoritativeReadbackOwner: "experimentService.getExperimentById",
    structuredOwner: "Experiment structured business fields",
    provisioningOwner: "experimentService create-time canonical manuscript Provisioning"
  },
  {
    type: "experimentRun",
    collection: "experimentRuns",
    requiredFields: ["ref", "experimentRef", "title"],
    optionalFields: [
      "runLabel", "status", "startedAt", "completedAt", "conditionSummary",
      "variableParameterSummary", "methodSummary", "resultSummary", "conclusion", "summaryOther",
      "rating", "tags"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "experimentId", "projectId", "routeId", "taskId"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["experiment"],
    canonicalCreateOwner: "experimentRunService.createExperimentRun",
    authoritativeReadbackOwner: "experimentRunService.getRunById",
    structuredOwner: "ExperimentRun structured business fields",
    provisioningOwner: "experimentRunService create-time canonical manuscript Provisioning"
  },
  {
    type: "literature",
    collection: "literature",
    requiredFields: ["ref", "title"],
    optionalFields: [
      "authors", "year", "venue", "publicationType", "abstract", "keywords", "doi", "url",
      "readingStatus", "importance", "tags"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "primaryProjectId", "isArchived", "archivedAt"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project"],
    canonicalCreateOwner: "literatureService.createLiterature",
    authoritativeReadbackOwner: "literatureService.getLiteratureById",
    structuredOwner: "Literature metadata owner",
    provisioningOwner: "literatureService canonical dual-channel manuscript Provisioning"
  },
  {
    type: "review",
    collection: "reviews",
    requiredFields: ["ref", "title"],
    optionalFields: [
      "description", "reviewType", "periodStart", "periodEnd", "periodLabel", "outlineSections",
      "targets", "tags"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "projectId", "structuredRevision", "descriptorIdentity"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "route", "task", "experiment", "experimentRun", "literature"],
    canonicalCreateOwner: "planningService.createReviewWithTargets",
    authoritativeReadbackOwner: "planningService.getReviewById",
    structuredOwner: "reviewStructuredStateService via planningService.createReviewWithTargets",
    provisioningOwner: "reviewManuscriptProvisioningService via canonical Review CREATE"
  },
  {
    type: "resultItem",
    collection: "resultItems",
    requiredFields: ["ref", "title", "resultType", "source"],
    optionalFields: [
      "experimentRef", "experimentRunRef", "status", "structuredSummary",
      "summary", "value", "unit", "tags", "isAsset", "assetReason", "assetQuality", "usableFor"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "projectId", "sourceId", "fileRefId", "assetMarkedAt"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "experiment", "experimentRun", "literature", "review"],
    canonicalCreateOwner: "outputConversionService.createResultItem",
    authoritativeReadbackOwner: "outputConversionService.getResultItemById",
    structuredOwner: "outputFiveLayerContractService ResultItem structuredSummary",
    provisioningOwner: "outputManuscriptProvisioningService via canonical ResultItem CREATE"
  },
  {
    type: "finding",
    collection: "findings",
    requiredFields: ["ref", "title"],
    optionalFields: [
      "experimentRef", "summary", "status", "structuredSummary",
      "findingType", "confidence", "maturity", "tags", "resultItemRefs"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "projectId", "resultItemIds"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "experiment", "resultItem"],
    canonicalCreateOwner: "outputConversionService.createFinding",
    authoritativeReadbackOwner: "outputConversionService.getFindingById",
    structuredOwner: "outputFiveLayerContractService Finding structuredSummary",
    provisioningOwner: "outputManuscriptProvisioningService via canonical Finding CREATE"
  },
  {
    type: "outputCandidate",
    collection: "outputCandidates",
    requiredFields: ["ref", "title", "candidateType"],
    optionalFields: [
      "description", "status", "structuredSummary", "maturity", "priority",
      "tags", "findingRefs", "resultItemRefs"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "projectId", "findingIds", "resultItemIds"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "finding", "resultItem"],
    canonicalCreateOwner: "outputConversionService.createOutputCandidate",
    authoritativeReadbackOwner: "outputConversionService.getOutputCandidateById",
    structuredOwner: "outputFiveLayerContractService OutputCandidate structuredSummary",
    provisioningOwner: "outputManuscriptProvisioningService via canonical OutputCandidate CREATE"
  },
  {
    type: "outputGap",
    collection: "outputGaps",
    requiredFields: ["ref", "title", "gapType", "outputCandidateRef"],
    optionalFields: [
      "description", "status", "structuredSummary", "priority"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "projectId", "outputCandidateId", "relatedTaskId", "relatedRouteNodeId", "resolvedAt"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "outputCandidate"],
    canonicalCreateOwner: "outputConversionService.createOutputGap",
    authoritativeReadbackOwner: "outputConversionService.getOutputGapById",
    structuredOwner: "outputFiveLayerContractService OutputGap structuredSummary",
    provisioningOwner: "outputManuscriptProvisioningService via canonical OutputGap CREATE"
  },
  {
    type: "researchOutput",
    collection: "researchOutputs",
    requiredFields: ["ref", "outputName", "outputType"],
    optionalFields: [
      "status", "structuredSummary", "usableForPaper", "description", "experimentRef"
    ],
    serviceOwnedFields: [...MANAGED_OWNER_FIELDS, "projectId", "taskId", "experimentId", "provenance"],
    forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
    dependencyTypes: ["project", "experiment"],
    canonicalCreateOwner: "outputService.create",
    authoritativeReadbackOwner: "outputService.getById",
    structuredOwner: "outputFiveLayerContractService ResearchOutput structuredSummary",
    provisioningOwner: "outputManuscriptProvisioningService via canonical ResearchOutput CREATE"
  }
] as const;

export const IMPORT_V1_SUPPORTED_OBJECT_TYPE_COUNT = IMPORT_V1_SUPPORTED_OBJECT_MANIFEST.length;

const DEFINITION_BY_TYPE = new Map(
  IMPORT_V1_SUPPORTED_OBJECT_MANIFEST.map((definition) => [definition.type, definition])
);
const DEFINITION_BY_COLLECTION = new Map(
  IMPORT_V1_SUPPORTED_OBJECT_MANIFEST
    .filter((definition) => definition.collection !== "project")
    .map((definition) => [definition.collection, definition])
);

export type ImportV1TemporaryRef = string;

export interface ImportV1ProjectRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  description?: string;
  background?: string;
  objective?: string;
  scope?: string;
  researchQuestion?: string;
  status?: "planning" | "active" | "paused" | "completed" | "archived";
  priority?: "high" | "medium" | "low";
  startDate?: string;
  targetDate?: string;
  tags?: string[];
}

export interface ImportV1RouteRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  parentRef?: ImportV1TemporaryRef;
  description?: string;
  objective?: string;
  expectedOutput?: string;
  nodeType?: "literature" | "experiment" | "algorithm" | "analysis" | "writing" | "output" | "review" | "other";
  status?: "planned" | "active" | "completed" | "paused" | "adjusted" | "archived";
  startDate?: string;
  endDate?: string;
  timeLabel?: string;
  timePrecision?: "day" | "week" | "month" | "quarter" | "phase" | "free";
  showInGantt?: boolean;
  captureState?: "scheduled" | "unscheduled" | "idea" | "pending" | "someday" | "archived";
  resultNote?: string;
  tags?: string[];
}

export interface ImportV1TaskRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  routeRef?: ImportV1TemporaryRef;
  description?: string;
  taskType?: "reading" | "experiment" | "coding" | "writing" | "analysis" | "meeting" | "idea" | "review" | "other";
  status?: "todo" | "doing" | "done" | "delayed" | "blocked" | "cancelled" | "archived";
  priority?: "high" | "medium" | "low";
  dueDate?: string;
  scheduledDate?: string;
  timeLabel?: string;
  timeBucket?: "today" | "this_week" | "this_month" | "long_term" | "none";
  timePrecision?: "day" | "week" | "month" | "free";
  captureState?: "scheduled" | "unscheduled" | "idea" | "pending" | "someday" | "archived";
  acceptanceCriteria?: string;
  resultNote?: string;
  blockedReason?: string;
  tags?: string[];
}

export interface ImportV1ExperimentRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  purposeAndQuestion?: string;
  conditionSummary?: string;
  methodSummary?: string;
  resultSummary?: string;
  conclusionAndNextSteps?: string;
  other?: string;
  status?: "planned" | "running" | "completed" | "paused" | "failed" | "archived";
  rating?: "excellent" | "good" | "usable" | "inconclusive" | "failed";
  usableForPaper?: boolean;
  usableForReport?: boolean;
  usableForPatent?: boolean;
  tags?: string[];
}

export interface ImportV1ExperimentRunRecord {
  ref: ImportV1TemporaryRef;
  experimentRef: ImportV1TemporaryRef;
  title: string;
  runLabel?: string;
  status?: "planned" | "running" | "completed" | "paused" | "failed" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  conditionSummary?: string;
  variableParameterSummary?: string;
  methodSummary?: string;
  resultSummary?: string;
  conclusion?: string;
  summaryOther?: string;
  rating?: "excellent" | "good" | "usable" | "inconclusive" | "failed";
  tags?: string[];
}

export interface ImportV1LiteratureAuthor {
  name: string;
  affiliation?: string;
  orcid?: string;
}

export interface ImportV1LiteratureRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  authors?: ImportV1LiteratureAuthor[];
  year?: number;
  venue?: string;
  publicationType?: "journal_article" | "conference_paper" | "review" | "book" | "book_chapter" | "thesis" | "patent" | "standard" | "technical_report" | "preprint" | "dataset" | "software" | "webpage" | "other";
  abstract?: string;
  keywords?: string[];
  doi?: string;
  url?: string;
  readingStatus?: "unread" | "skimmed" | "reading" | "intensive_read" | "summarized" | "reused" | "discarded" | "archived";
  importance?: "core" | "important" | "useful" | "background" | "low" | "uncertain";
  tags?: string[];
}

export type ImportV1ReviewTargetType = "route" | "task" | "experiment" | "experimentRun" | "literature";
export interface ImportV1ReviewTarget {
  type: ImportV1ReviewTargetType;
  ref: ImportV1TemporaryRef;
  description?: string;
}

export interface ImportV1ReviewOutlineSection {
  key: string;
  content: string;
}

export interface ImportV1ReviewRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  description?: string;
  reviewType?: "stage" | "periodic" | "experiment_comparison" | "literature_comparison" | "custom";
  periodStart?: string;
  periodEnd?: string;
  periodLabel?: string;
  outlineSections?: ImportV1ReviewOutlineSection[];
  targets?: ImportV1ReviewTarget[];
  tags?: string[];
}

export type ImportV1StructuredSummary = Record<string, string>;

export interface ImportV1ResultItemRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  resultType: "data" | "figure" | "table" | "metric" | "code" | "model" | "log" | "text" | "sample" | "case" | "document" | "other";
  source: { type: "experiment" | "experimentRun" | "review" | "literature"; ref: ImportV1TemporaryRef };
  experimentRef?: ImportV1TemporaryRef;
  experimentRunRef?: ImportV1TemporaryRef;
  status?: "pending_review" | "marked" | "ignored";
  structuredSummary?: ImportV1StructuredSummary;
  summary?: string;
  value?: string | number | boolean;
  unit?: string;
  tags?: string[];
  isAsset?: boolean;
  assetReason?: string;
  assetQuality?: "high" | "medium" | "low" | "uncertain";
  usableFor?: Array<"paper" | "patent" | "report" | "dataset" | "software" | "presentation" | "futureProject" | "other">;
}

export interface ImportV1FindingRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  experimentRef?: ImportV1TemporaryRef;
  summary?: string;
  status?: "pending_confirmation" | "confirmed" | "needs_evidence" | "abandoned";
  structuredSummary?: ImportV1StructuredSummary;
  findingType?: "phenomenon" | "comparison" | "method" | "limitation" | "evidence" | "hypothesis" | "negative_result" | "other";
  confidence?: "high" | "medium" | "low" | "uncertain";
  maturity?: "high" | "medium" | "low" | "uncertain";
  tags?: string[];
  resultItemRefs?: ImportV1TemporaryRef[];
}

export interface ImportV1OutputCandidateRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  candidateType: "paper" | "patent" | "report" | "dataset" | "software" | "method" | "model" | "caseStudy" | "presentation" | "futureProject" | "other";
  description?: string;
  status?: "pending_evaluation" | "needs_gap_resolution" | "ready_for_formal" | "converted";
  structuredSummary?: ImportV1StructuredSummary;
  maturity?: "low" | "medium" | "high";
  priority?: "high" | "medium" | "low";
  tags?: string[];
  findingRefs?: ImportV1TemporaryRef[];
  resultItemRefs?: ImportV1TemporaryRef[];
}

export interface ImportV1OutputGapRecord {
  ref: ImportV1TemporaryRef;
  title: string;
  gapType: "data" | "analysis" | "validation" | "figure" | "theory" | "literature" | "writing" | "experiment" | "code" | "other";
  outputCandidateRef: ImportV1TemporaryRef;
  description?: string;
  status?: "pending" | "task_created" | "route_feedback_created" | "resolved" | "abandoned";
  structuredSummary?: ImportV1StructuredSummary;
  priority?: "high" | "medium" | "low";
}

export interface ImportV1ResearchOutputRecord {
  ref: ImportV1TemporaryRef;
  outputName: string;
  outputType: "figure" | "table" | "dataset" | "result" | "note" | "report" | "paper_draft" | "presentation" | "code" | "other";
  status?: "draft" | "organizing" | "archived";
  structuredSummary?: ImportV1StructuredSummary;
  usableForPaper?: boolean;
  description?: string;
  experimentRef?: ImportV1TemporaryRef;
}

export interface ImportV1RelationEndpoint {
  type: ImportV1ObjectType;
  ref: ImportV1TemporaryRef;
}

export interface ImportV1RelationRecord {
  source: ImportV1RelationEndpoint;
  target: ImportV1RelationEndpoint;
  relationType: "belongs_to" | "depends_on" | "blocks" | "supports" | "supported_by" | "produces" | "references" | "cites" | "derived_from" | "evidence_for" | "contradicts" | "uses" | "requires" | "supplements" | "extends" | "converted_to" | "generates_finding" | "supports_output" | "needs_followup_task" | "adjusts" | "summarizes" | "related_to";
  description?: string;
}

export interface ValidatedProjectImportV1Document {
  schema: typeof PROJECT_IMPORT_V1_SCHEMA;
  version: typeof PROJECT_IMPORT_V1_VERSION;
  project: ImportV1ProjectRecord;
  objects: {
    routes: ImportV1RouteRecord[];
    tasks: ImportV1TaskRecord[];
    experiments: ImportV1ExperimentRecord[];
    experimentRuns: ImportV1ExperimentRunRecord[];
    literature: ImportV1LiteratureRecord[];
    reviews: ImportV1ReviewRecord[];
    resultItems: ImportV1ResultItemRecord[];
    findings: ImportV1FindingRecord[];
    outputCandidates: ImportV1OutputCandidateRecord[];
    outputGaps: ImportV1OutputGapRecord[];
    researchOutputs: ImportV1ResearchOutputRecord[];
  };
  relations: ImportV1RelationRecord[];
}

export interface ProjectImportV1Issue {
  code:
    | "INVALID_JSON"
    | "INVALID_ROOT"
    | "UNSUPPORTED_SCHEMA"
    | "UNSUPPORTED_VERSION"
    | "UNKNOWN_FIELD"
    | "FORBIDDEN_SYSTEM_FIELD"
    | "MISSING_REQUIRED_FIELD"
    | "INVALID_FIELD_TYPE"
    | "INVALID_FIELD_VALUE"
    | "DUPLICATE_TEMP_REF"
    | "UNRESOLVED_TEMP_REF"
    | "WRONG_TEMP_REF_TYPE"
    | "DUPLICATE_RELATION"
    | "INVALID_RELATION"
    | "DEPENDENCY_CYCLE";
  path: string;
  message: string;
}

export interface ProjectImportV1Warning {
  code: "OPTIONAL_FIELD_SKIPPED";
  path: string;
  message: string;
}

export interface ProjectImportV1SkippedCounts {
  fields: number;
  objects: number;
  relations: number;
}

export interface ProjectImportV1InputIdentity {
  byteLength: number;
  contentHash: string;
  selectedMode: "auto" | "sqlite" | "localStorage" | "unspecified";
  effectiveMode: "sqlite" | "localStorage" | "unspecified";
  schema: typeof PROJECT_IMPORT_V1_SCHEMA;
  version: typeof PROJECT_IMPORT_V1_VERSION;
  targetIdentity: string;
}

export interface ProjectImportV1PreflightContext {
  selectedMode?: "auto" | "sqlite" | "localStorage";
  effectiveMode?: "sqlite" | "localStorage";
}

export interface ProjectImportV1Preview {
  projectCount: 1;
  projectTitle: string;
  objectCounts: Record<ImportV1ObjectType, number>;
  relationCount: number;
  totalObjectCount: number;
  skippedCounts: ProjectImportV1SkippedCounts;
  warnings: string[];
}

export interface ProjectImportV1PreflightPlan {
  ok: true;
  document: ValidatedProjectImportV1Document;
  preview: ProjectImportV1Preview;
  inputIdentity: ProjectImportV1InputIdentity;
  warnings: ProjectImportV1Warning[];
  issues: [];
}

export type ProjectImportV1PreflightResult =
  | ProjectImportV1PreflightPlan
  | {
      ok: false;
      issues: ProjectImportV1Issue[];
    };

const FORBIDDEN_FIELD_SET = new Set<string>(IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS);
const OBJECT_TYPE_SET = new Set<string>(IMPORT_V1_OBJECT_TYPES);
const TEMP_REF_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "project.status": ["planning", "active", "paused", "completed", "archived"],
  "project.priority": ["high", "medium", "low"],
  "route.nodeType": ["literature", "experiment", "algorithm", "analysis", "writing", "output", "review", "other"],
  "route.status": ["planned", "active", "completed", "paused", "adjusted", "archived"],
  "route.timePrecision": ["day", "week", "month", "quarter", "phase", "free"],
  "route.captureState": ["scheduled", "unscheduled", "idea", "pending", "someday", "archived"],
  "task.taskType": ["reading", "experiment", "coding", "writing", "analysis", "meeting", "idea", "review", "other"],
  "task.status": ["todo", "doing", "done", "delayed", "blocked", "cancelled", "archived"],
  "task.priority": ["high", "medium", "low"],
  "task.timeBucket": ["today", "this_week", "this_month", "long_term", "none"],
  "task.timePrecision": ["day", "week", "month", "free"],
  "task.captureState": ["scheduled", "unscheduled", "idea", "pending", "someday", "archived"],
  "experiment.status": ["planned", "running", "completed", "paused", "failed", "archived"],
  "experiment.rating": ["excellent", "good", "usable", "inconclusive", "failed"],
  "experimentRun.status": ["planned", "running", "completed", "paused", "failed", "cancelled"],
  "experimentRun.rating": ["excellent", "good", "usable", "inconclusive", "failed"],
  "literature.publicationType": ["journal_article", "conference_paper", "review", "book", "book_chapter", "thesis", "patent", "standard", "technical_report", "preprint", "dataset", "software", "webpage", "other"],
  "literature.readingStatus": ["unread", "skimmed", "reading", "intensive_read", "summarized", "reused", "discarded", "archived"],
  "literature.importance": ["core", "important", "useful", "background", "low", "uncertain"],
  "review.reviewType": ["stage", "periodic", "experiment_comparison", "literature_comparison", "custom"],
  "resultItem.resultType": ["data", "figure", "table", "metric", "code", "model", "log", "text", "sample", "case", "document", "other"],
  "resultItem.status": ["pending_review", "marked", "ignored"],
  "resultItem.assetQuality": ["high", "medium", "low", "uncertain"],
  "finding.status": ["pending_confirmation", "confirmed", "needs_evidence", "abandoned"],
  "finding.findingType": ["phenomenon", "comparison", "method", "limitation", "evidence", "hypothesis", "negative_result", "other"],
  "finding.confidence": ["high", "medium", "low", "uncertain"],
  "finding.maturity": ["high", "medium", "low", "uncertain"],
  "outputCandidate.candidateType": ["paper", "patent", "report", "dataset", "software", "method", "model", "caseStudy", "presentation", "futureProject", "other"],
  "outputCandidate.status": ["pending_evaluation", "needs_gap_resolution", "ready_for_formal", "converted"],
  "outputCandidate.maturity": ["low", "medium", "high"],
  "outputCandidate.priority": ["high", "medium", "low"],
  "outputGap.gapType": ["data", "analysis", "validation", "figure", "theory", "literature", "writing", "experiment", "code", "other"],
  "outputGap.status": ["pending", "task_created", "route_feedback_created", "resolved", "abandoned"],
  "outputGap.priority": ["high", "medium", "low"],
  "researchOutput.outputType": ["figure", "table", "dataset", "result", "note", "report", "paper_draft", "presentation", "code", "other"],
  "researchOutput.status": ["draft", "organizing", "archived"]
};

const STRUCTURED_SUMMARY_KEYS: Readonly<Record<"resultItem" | "finding" | "outputCandidate" | "outputGap" | "researchOutput", readonly string[]>> = {
  resultItem: ["keyPhenomenon", "conditionBrief", "initialJudgement", "conversionValue", "other"],
  finding: ["supportingEvidence", "noveltyDifference", "reliabilityJudgement", "boundaryOrMissingEvidence", "other"],
  outputCandidate: ["outputType", "innovationContribution", "evidenceSummary", "risksAndGaps", "other"],
  outputGap: ["gapType", "affectedObject", "strengtheningPlan", "completionCriteria", "other"],
  researchOutput: ["outputType", "coreContribution", "sourceChainSummary", "archiveUsage", "other"]
};

const REVIEW_OUTLINE_KEYS = new Set([
  "stage_summary", "key_progress", "completed_items", "major_problems", "cause_analysis", "next_plan", "other",
  "period_summary", "period_completed", "period_pending", "next_period_plan", "comparison_summary", "comparison_targets",
  "key_differences", "main_conclusions", "anomalies_and_problems", "next_experiment_plan", "literature_overview",
  "literature_scope", "method_differences", "consensus_and_divergence", "research_gaps_and_references",
  "next_reading_or_research_plan", "custom_summary"
]);

const REVIEW_OUTLINE_KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  stage: ["stage_summary", "key_progress", "completed_items", "major_problems", "cause_analysis", "next_plan", "other"],
  periodic: ["period_summary", "period_completed", "period_pending", "major_problems", "cause_analysis", "next_period_plan", "other"],
  experiment_comparison: ["comparison_summary", "comparison_targets", "key_differences", "main_conclusions", "anomalies_and_problems", "next_experiment_plan", "other"],
  literature_comparison: ["literature_overview", "literature_scope", "method_differences", "consensus_and_divergence", "research_gaps_and_references", "next_reading_or_research_plan", "other"],
  custom: ["custom_summary", "completed_items", "major_problems", "cause_analysis", "next_plan", "other"]
};

const RELATION_TYPES = new Set([
  "belongs_to", "depends_on", "blocks", "supports", "supported_by", "produces", "references", "cites",
  "derived_from", "evidence_for", "contradicts", "uses", "requires", "supplements", "extends", "converted_to",
  "generates_finding", "supports_output", "needs_followup_task", "adjusts", "summarizes", "related_to"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function importInputBytes(input: string | unknown): Uint8Array {
  const serialized = typeof input === "string"
    ? input
    : JSON.stringify(input) ?? String(input);
  return new TextEncoder().encode(serialized);
}

function hashImportInput(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function normalizeLocalizedOptionalFields(
  value: unknown,
  warnings: ProjectImportV1Warning[]
): unknown {
  if (!isRecord(value) || !isRecord(value.objects) || !Array.isArray(value.objects.reviews)) {
    return value;
  }
  let changed = false;
  const reviews = value.objects.reviews.map((entry, index) => {
    if (
      !isRecord(entry) || entry.periodLabel === undefined ||
      entry.periodStart !== undefined || entry.periodEnd !== undefined
    ) {
      return entry;
    }
    const normalized = { ...entry };
    delete normalized.periodLabel;
    changed = true;
    warnings.push({
      code: "OPTIONAL_FIELD_SKIPPED",
      path: `$.objects.reviews[${index}].periodLabel`,
      message: "Optional periodLabel was omitted because the Review has no periodStart/periodEnd; the remaining Review was accepted."
    });
    return normalized;
  });
  return changed
    ? { ...value, objects: { ...value.objects, reviews } }
    : value;
}

function issue(
  issues: ProjectImportV1Issue[],
  code: ProjectImportV1Issue["code"],
  path: string,
  message: string
) {
  issues.push({ code, path, message });
}

function inspectObject(
  value: unknown,
  path: string,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  issues: ProjectImportV1Issue[]
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issue(issues, "INVALID_FIELD_TYPE", path, `${path} must be one JSON object.`);
    return undefined;
  }
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issue(
        issues,
        FORBIDDEN_FIELD_SET.has(key) ? "FORBIDDEN_SYSTEM_FIELD" : "UNKNOWN_FIELD",
        `${path}.${key}`,
        FORBIDDEN_FIELD_SET.has(key)
          ? `${path}.${key} is service-owned or outside Import v1.`
          : `${path}.${key} is not defined by the Import v1 machine authority.`
      );
    }
  }
  for (const key of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issue(issues, "MISSING_REQUIRED_FIELD", `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
  return value;
}

function requireNonBlankString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProjectImportV1Issue[]
) {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    issue(issues, "INVALID_FIELD_TYPE", `${path}.${key}`, `${path}.${key} must be a non-empty string.`);
  }
}

function optionalString(record: Record<string, unknown>, key: string, path: string, issues: ProjectImportV1Issue[]) {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    issue(issues, "INVALID_FIELD_TYPE", `${path}.${key}`, `${path}.${key} must be a string.`);
  }
}

function optionalBoolean(record: Record<string, unknown>, key: string, path: string, issues: ProjectImportV1Issue[]) {
  if (record[key] !== undefined && typeof record[key] !== "boolean") {
    issue(issues, "INVALID_FIELD_TYPE", `${path}.${key}`, `${path}.${key} must be a boolean.`);
  }
}

function validateTempRefValue(value: unknown, path: string, issues: ProjectImportV1Issue[]) {
  if (typeof value !== "string" || !TEMP_REF_PATTERN.test(value)) {
    issue(
      issues,
      "INVALID_FIELD_VALUE",
      path,
      `${path} must be a temporary ref matching ${TEMP_REF_PATTERN.source}.`
    );
  }
}

function optionalTempRef(record: Record<string, unknown>, key: string, path: string, issues: ProjectImportV1Issue[]) {
  if (record[key] !== undefined) validateTempRefValue(record[key], `${path}.${key}`, issues);
}

function optionalTags(record: Record<string, unknown>, key: string, path: string, issues: ProjectImportV1Issue[]) {
  const value = record[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    issue(issues, "INVALID_FIELD_TYPE", `${path}.${key}`, `${path}.${key} must be an array of non-empty strings.`);
  }
}

function optionalDate(record: Record<string, unknown>, key: string, path: string, issues: ProjectImportV1Issue[]) {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    issue(issues, "INVALID_FIELD_VALUE", `${path}.${key}`, `${path}.${key} must be a YYYY-MM-DD date.`);
  }
}

function optionalIsoDateTime(record: Record<string, unknown>, key: string, path: string, issues: ProjectImportV1Issue[]) {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issue(issues, "INVALID_FIELD_VALUE", `${path}.${key}`, `${path}.${key} must be an ISO-compatible date-time.`);
  }
}

function validateEnumFields(
  type: ImportV1ObjectType,
  record: Record<string, unknown>,
  path: string,
  issues: ProjectImportV1Issue[]
) {
  for (const [descriptor, values] of Object.entries(ENUM_FIELDS)) {
    const [descriptorType, field] = descriptor.split(".");
    if (descriptorType !== type || record[field] === undefined) continue;
    if (typeof record[field] !== "string" || !values.includes(record[field] as string)) {
      issue(
        issues,
        "INVALID_FIELD_VALUE",
        `${path}.${field}`,
        `${path}.${field} must be one of: ${values.join(", ")}.`
      );
    }
  }
}

function validateStructuredSummary(
  type: keyof typeof STRUCTURED_SUMMARY_KEYS,
  value: unknown,
  path: string,
  issues: ProjectImportV1Issue[]
) {
  if (value === undefined) return;
  const record = inspectObject(value, path, STRUCTURED_SUMMARY_KEYS[type], [], issues);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      issue(issues, "INVALID_FIELD_TYPE", `${path}.${key}`, `${path}.${key} must be a string.`);
    }
  }
}

function validateRefArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProjectImportV1Issue[]
) {
  const value = record[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issue(issues, "INVALID_FIELD_TYPE", `${path}.${key}`, `${path}.${key} must be an array.`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    validateTempRefValue(entry, `${path}.${key}[${index}]`, issues);
    if (typeof entry === "string") {
      if (seen.has(entry)) {
        issue(issues, "INVALID_FIELD_VALUE", `${path}.${key}[${index}]`, `${path}.${key} contains duplicate ref ${entry}.`);
      }
      seen.add(entry);
    }
  });
}

function validateReviewOutline(
  value: unknown,
  reviewType: string,
  path: string,
  issues: ProjectImportV1Issue[]
) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issue(issues, "INVALID_FIELD_TYPE", path, `${path} must be an array.`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = inspectObject(entry, entryPath, ["key", "content"], ["key", "content"], issues);
    if (!record) return;
    requireNonBlankString(record, "key", entryPath, issues);
    if (typeof record.key === "string" && !REVIEW_OUTLINE_KEYS.has(record.key)) {
      issue(issues, "INVALID_FIELD_VALUE", `${entryPath}.key`, `${entryPath}.key is not a supported Review outline key.`);
    }
    if (
      typeof record.key === "string" &&
      REVIEW_OUTLINE_KEYS.has(record.key) &&
      !(REVIEW_OUTLINE_KEYS_BY_TYPE[reviewType] ?? []).includes(record.key)
    ) {
      issue(
        issues,
        "INVALID_FIELD_VALUE",
        `${entryPath}.key`,
        `${entryPath}.key does not belong to the ${reviewType} Review structured outline.`
      );
    }
    if (typeof record.key === "string" && seen.has(record.key)) {
      issue(issues, "INVALID_FIELD_VALUE", `${entryPath}.key`, `${entryPath}.key is duplicated.`);
    }
    if (typeof record.key === "string") seen.add(record.key);
    if (typeof record.content !== "string") {
      issue(issues, "INVALID_FIELD_TYPE", `${entryPath}.content`, `${entryPath}.content must be a string.`);
    }
  });
}

function validateReviewTargets(value: unknown, path: string, issues: ProjectImportV1Issue[]) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issue(issues, "INVALID_FIELD_TYPE", path, `${path} must be an array.`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = inspectObject(entry, entryPath, ["type", "ref", "description"], ["type", "ref"], issues);
    if (!record) return;
    const supported = ["route", "task", "experiment", "experimentRun", "literature"];
    if (typeof record.type !== "string" || !supported.includes(record.type)) {
      issue(issues, "INVALID_FIELD_VALUE", `${entryPath}.type`, `${entryPath}.type is not a supported Review target type.`);
    }
    validateTempRefValue(record.ref, `${entryPath}.ref`, issues);
    optionalString(record, "description", entryPath, issues);
    const key = `${String(record.type)}:${String(record.ref)}`;
    if (seen.has(key)) issue(issues, "INVALID_FIELD_VALUE", entryPath, `${entryPath} duplicates Review target ${key}.`);
    seen.add(key);
  });
}

function validateLiteratureAuthors(value: unknown, path: string, issues: ProjectImportV1Issue[]) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issue(issues, "INVALID_FIELD_TYPE", path, `${path} must be an array.`);
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = inspectObject(entry, entryPath, ["name", "affiliation", "orcid"], ["name"], issues);
    if (!record) return;
    requireNonBlankString(record, "name", entryPath, issues);
    optionalString(record, "affiliation", entryPath, issues);
    optionalString(record, "orcid", entryPath, issues);
  });
}

function validateSource(value: unknown, path: string, issues: ProjectImportV1Issue[]) {
  const record = inspectObject(value, path, ["type", "ref"], ["type", "ref"], issues);
  if (!record) return;
  const supported = ["experiment", "experimentRun", "review", "literature"];
  if (typeof record.type !== "string" || !supported.includes(record.type)) {
    issue(issues, "INVALID_FIELD_VALUE", `${path}.type`, `${path}.type is not a supported ResultItem source type.`);
  }
  validateTempRefValue(record.ref, `${path}.ref`, issues);
}

function validateObjectRecord(
  type: ImportV1ObjectType,
  value: unknown,
  path: string,
  issues: ProjectImportV1Issue[]
) {
  const definition = DEFINITION_BY_TYPE.get(type)!;
  const allowed = [...definition.requiredFields, ...definition.optionalFields];
  const record = inspectObject(value, path, allowed, definition.requiredFields, issues);
  if (!record) return;

  if (definition.requiredFields.includes("ref")) validateTempRefValue(record.ref, `${path}.ref`, issues);
  for (const field of ["title", "outputName"]) {
    if (definition.requiredFields.includes(field)) requireNonBlankString(record, field, path, issues);
  }
  for (const field of [
    "description", "background", "objective", "scope", "researchQuestion", "parentRef", "routeRef", "taskRef",
    "experimentRef", "experimentRunRef", "purposeAndQuestion", "conditionSummary", "methodSummary", "resultSummary",
    "conclusionAndNextSteps", "other", "runLabel", "variableParameterSummary", "conclusion", "summaryOther", "venue",
    "abstract", "doi", "url", "periodLabel", "summary", "unit", "assetReason", "relatedTaskRef", "relatedRouteRef",
    "outputCandidateRef"
  ]) optionalString(record, field, path, issues);
  for (const field of ["parentRef", "routeRef", "taskRef", "experimentRef", "experimentRunRef", "outputCandidateRef", "relatedTaskRef", "relatedRouteRef"]) {
    optionalTempRef(record, field, path, issues);
  }
  for (const field of ["showInGantt", "usableForPaper", "usableForReport", "usableForPatent", "isAsset"]) {
    optionalBoolean(record, field, path, issues);
  }
  for (const field of ["startDate", "targetDate", "endDate", "dueDate", "scheduledDate", "periodStart", "periodEnd"]) {
    optionalDate(record, field, path, issues);
  }
  for (const field of ["startedAt", "completedAt"]) optionalIsoDateTime(record, field, path, issues);
  optionalTags(record, "tags", path, issues);
  optionalTags(record, "keywords", path, issues);
  validateEnumFields(type, record, path, issues);

  if (type === "literature") {
    validateLiteratureAuthors(record.authors, `${path}.authors`, issues);
    if (record.year !== undefined && (!Number.isInteger(record.year) || (record.year as number) < 0 || (record.year as number) > 9999)) {
      issue(issues, "INVALID_FIELD_VALUE", `${path}.year`, `${path}.year must be an integer from 0 to 9999.`);
    }
  }
  if (type === "review") {
    const reviewType = typeof record.reviewType === "string" && ENUM_FIELDS["review.reviewType"].includes(record.reviewType)
      ? record.reviewType
      : "stage";
    validateReviewOutline(record.outlineSections, reviewType, `${path}.outlineSections`, issues);
    validateReviewTargets(record.targets, `${path}.targets`, issues);
    const hasStart = record.periodStart !== undefined;
    const hasEnd = record.periodEnd !== undefined;
    if (hasStart !== hasEnd) {
      issue(issues, "INVALID_FIELD_VALUE", path, `${path}.periodStart and periodEnd must be supplied together.`);
    }
    if (typeof record.periodStart === "string" && typeof record.periodEnd === "string" && record.periodStart > record.periodEnd) {
      issue(issues, "INVALID_FIELD_VALUE", `${path}.periodEnd`, `${path}.periodEnd must not precede periodStart.`);
    }
    if (record.periodLabel !== undefined && !hasStart) {
      issue(issues, "INVALID_FIELD_VALUE", `${path}.periodLabel`, `${path}.periodLabel requires periodStart and periodEnd.`);
    }
  }
  if (type === "resultItem") {
    validateSource(record.source, `${path}.source`, issues);
    validateStructuredSummary(type, record.structuredSummary, `${path}.structuredSummary`, issues);
    if (record.value !== undefined && !["string", "number", "boolean"].includes(typeof record.value)) {
      issue(issues, "INVALID_FIELD_TYPE", `${path}.value`, `${path}.value must be a string, number, or boolean.`);
    }
    if (record.usableFor !== undefined) {
      const allowedUses = new Set(["paper", "patent", "report", "dataset", "software", "presentation", "futureProject", "other"]);
      if (!Array.isArray(record.usableFor) || record.usableFor.some((entry) => typeof entry !== "string" || !allowedUses.has(entry))) {
        issue(issues, "INVALID_FIELD_VALUE", `${path}.usableFor`, `${path}.usableFor contains an unsupported value.`);
      }
    }
  }
  if (type === "finding" || type === "outputCandidate" || type === "outputGap" || type === "researchOutput") {
    validateStructuredSummary(type, record.structuredSummary, `${path}.structuredSummary`, issues);
  }
  if (type === "finding") validateRefArray(record, "resultItemRefs", path, issues);
  if (type === "outputCandidate") {
    validateRefArray(record, "findingRefs", path, issues);
    validateRefArray(record, "resultItemRefs", path, issues);
  }
  if (type === "experimentRun") validateTempRefValue(record.experimentRef, `${path}.experimentRef`, issues);

  if (type === "project" && typeof record.startDate === "string" && typeof record.targetDate === "string" && record.startDate > record.targetDate) {
    issue(issues, "INVALID_FIELD_VALUE", `${path}.targetDate`, `${path}.targetDate must not precede startDate.`);
  }
  if (type === "route" && typeof record.startDate === "string" && typeof record.endDate === "string" && record.startDate > record.endDate) {
    issue(issues, "INVALID_FIELD_VALUE", `${path}.endDate`, `${path}.endDate must not precede startDate.`);
  }
}

function emptyObjects(): ValidatedProjectImportV1Document["objects"] {
  return {
    routes: [],
    tasks: [],
    experiments: [],
    experimentRuns: [],
    literature: [],
    reviews: [],
    resultItems: [],
    findings: [],
    outputCandidates: [],
    outputGaps: [],
    researchOutputs: []
  };
}

function parseObjects(
  value: unknown,
  issues: ProjectImportV1Issue[]
): ValidatedProjectImportV1Document["objects"] {
  const output = emptyObjects();
  const record = inspectObject(value, "$.objects", IMPORT_V1_OBJECT_COLLECTIONS, [], issues);
  if (!record) return output;

  for (const collection of IMPORT_V1_OBJECT_COLLECTIONS) {
    const entries = record[collection];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      issue(issues, "INVALID_FIELD_TYPE", `$.objects.${collection}`, `$.objects.${collection} must be an array.`);
      continue;
    }
    const definition = DEFINITION_BY_COLLECTION.get(collection)!;
    entries.forEach((entry, index) => validateObjectRecord(definition.type, entry, `$.objects.${collection}[${index}]`, issues));
    (output[collection] as unknown[]) = entries;
  }
  return output;
}

function validateEndpoint(value: unknown, path: string, issues: ProjectImportV1Issue[]) {
  const record = inspectObject(value, path, ["type", "ref"], ["type", "ref"], issues);
  if (!record) return;
  if (typeof record.type !== "string" || !OBJECT_TYPE_SET.has(record.type)) {
    issue(issues, "INVALID_FIELD_VALUE", `${path}.type`, `${path}.type is not in the supported manifest.`);
  }
  validateTempRefValue(record.ref, `${path}.ref`, issues);
}

function parseRelations(value: unknown, issues: ProjectImportV1Issue[]): ImportV1RelationRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, "INVALID_FIELD_TYPE", "$.relations", "$.relations must be an array.");
    return [];
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const path = `$.relations[${index}]`;
    const record = inspectObject(entry, path, ["source", "target", "relationType", "description"], ["source", "target", "relationType"], issues);
    if (!record) return;
    validateEndpoint(record.source, `${path}.source`, issues);
    validateEndpoint(record.target, `${path}.target`, issues);
    if (typeof record.relationType !== "string" || !RELATION_TYPES.has(record.relationType)) {
      issue(issues, "INVALID_RELATION", `${path}.relationType`, `${path}.relationType is unsupported.`);
    }
    optionalString(record, "description", path, issues);
    if (isRecord(record.source) && isRecord(record.target)) {
      const key = `${String(record.source.type)}:${String(record.source.ref)}>${String(record.relationType)}>${String(record.target.type)}:${String(record.target.ref)}`;
      if (seen.has(key)) issue(issues, "DUPLICATE_RELATION", path, `${path} duplicates relation ${key}.`);
      seen.add(key);
      if (record.source.type === "review" && record.relationType === "summarizes") {
        issue(issues, "INVALID_RELATION", path, "Review summarizes relations must use review.targets, not the generic relations array.");
      }
    }
  });
  return value as ImportV1RelationRecord[];
}

interface RefDescriptor {
  type: ImportV1ObjectType;
  path: string;
}

function buildRefMap(document: ValidatedProjectImportV1Document, issues: ProjectImportV1Issue[]) {
  const refs = new Map<string, RefDescriptor>();
  function add(type: ImportV1ObjectType, ref: string, path: string) {
    const existing = refs.get(ref);
    if (existing) {
      issue(issues, "DUPLICATE_TEMP_REF", path, `${path} duplicates ${existing.path}; temporary refs are file-local and unique.`);
      return;
    }
    refs.set(ref, { type, path });
  }
  add("project", document.project.ref, "$.project.ref");
  for (const definition of IMPORT_V1_SUPPORTED_OBJECT_MANIFEST) {
    if (definition.collection === "project") continue;
    const entries = document.objects[definition.collection] as Array<{ ref: string }>;
    entries.forEach((entry, index) => {
      if (typeof entry.ref === "string") add(definition.type, entry.ref, `$.objects.${definition.collection}[${index}].ref`);
    });
  }
  return refs;
}

function validateResolvedRef(
  refs: Map<string, RefDescriptor>,
  ref: unknown,
  expectedTypes: readonly ImportV1ObjectType[],
  path: string,
  issues: ProjectImportV1Issue[]
) {
  if (typeof ref !== "string" || !TEMP_REF_PATTERN.test(ref)) return;
  const descriptor = refs.get(ref);
  if (!descriptor) {
    issue(issues, "UNRESOLVED_TEMP_REF", path, `${path} does not resolve within this import file.`);
    return;
  }
  if (!expectedTypes.includes(descriptor.type)) {
    issue(
      issues,
      "WRONG_TEMP_REF_TYPE",
      path,
      `${path} resolves to ${descriptor.type}, expected ${expectedTypes.join(" or ")}.`
    );
  }
}

function validateAllDependencies(
  document: ValidatedProjectImportV1Document,
  refs: Map<string, RefDescriptor>,
  issues: ProjectImportV1Issue[]
) {
  document.objects.routes.forEach((entry, index) => {
    if (entry.parentRef) validateResolvedRef(refs, entry.parentRef, ["route"], `$.objects.routes[${index}].parentRef`, issues);
  });
  document.objects.tasks.forEach((entry, index) => {
    if (entry.routeRef) validateResolvedRef(refs, entry.routeRef, ["route"], `$.objects.tasks[${index}].routeRef`, issues);
  });
  document.objects.experimentRuns.forEach((entry, index) => {
    validateResolvedRef(refs, entry.experimentRef, ["experiment"], `$.objects.experimentRuns[${index}].experimentRef`, issues);
  });
  document.objects.reviews.forEach((entry, index) => {
    entry.targets?.forEach((target, targetIndex) => {
      validateResolvedRef(refs, target.ref, [target.type], `$.objects.reviews[${index}].targets[${targetIndex}].ref`, issues);
    });
  });
  document.objects.resultItems.forEach((entry, index) => {
    validateResolvedRef(refs, entry.source.ref, [entry.source.type], `$.objects.resultItems[${index}].source.ref`, issues);
    const optional: Array<[keyof ImportV1ResultItemRecord, ImportV1ObjectType]> = [
      ["experimentRef", "experiment"], ["experimentRunRef", "experimentRun"]
    ];
    optional.forEach(([field, type]) => {
      const ref = entry[field];
      if (typeof ref === "string") validateResolvedRef(refs, ref, [type], `$.objects.resultItems[${index}].${field}`, issues);
    });
  });
  document.objects.findings.forEach((entry, index) => {
    if (entry.experimentRef) validateResolvedRef(refs, entry.experimentRef, ["experiment"], `$.objects.findings[${index}].experimentRef`, issues);
    entry.resultItemRefs?.forEach((ref, refIndex) => validateResolvedRef(refs, ref, ["resultItem"], `$.objects.findings[${index}].resultItemRefs[${refIndex}]`, issues));
  });
  document.objects.outputCandidates.forEach((entry, index) => {
    entry.findingRefs?.forEach((ref, refIndex) => validateResolvedRef(refs, ref, ["finding"], `$.objects.outputCandidates[${index}].findingRefs[${refIndex}]`, issues));
    entry.resultItemRefs?.forEach((ref, refIndex) => validateResolvedRef(refs, ref, ["resultItem"], `$.objects.outputCandidates[${index}].resultItemRefs[${refIndex}]`, issues));
  });
  document.objects.outputGaps.forEach((entry, index) => {
    validateResolvedRef(refs, entry.outputCandidateRef, ["outputCandidate"], `$.objects.outputGaps[${index}].outputCandidateRef`, issues);
  });
  document.objects.researchOutputs.forEach((entry, index) => {
    if (entry.experimentRef) validateResolvedRef(refs, entry.experimentRef, ["experiment"], `$.objects.researchOutputs[${index}].experimentRef`, issues);
  });
  document.relations.forEach((relation, index) => {
    validateResolvedRef(refs, relation.source.ref, [relation.source.type], `$.relations[${index}].source.ref`, issues);
    validateResolvedRef(refs, relation.target.ref, [relation.target.type], `$.relations[${index}].target.ref`, issues);
    if (relation.source.ref === relation.target.ref) {
      issue(issues, "INVALID_RELATION", `$.relations[${index}]`, "A relation cannot target the same temporary object ref.");
    }
  });
}

export function orderImportV1Routes(
  routes: readonly ImportV1RouteRecord[]
): ImportV1RouteRecord[] | undefined {
  const pending = [...routes];
  const ordered: ImportV1RouteRecord[] = [];
  const created = new Set<string>();
  while (pending.length > 0) {
    const index = pending.findIndex((route) => !route.parentRef || created.has(route.parentRef));
    if (index < 0) return undefined;
    const [next] = pending.splice(index, 1);
    ordered.push(next);
    created.add(next.ref);
  }
  return ordered;
}

function preview(
  document: ValidatedProjectImportV1Document,
  warnings: readonly ProjectImportV1Warning[]
): ProjectImportV1Preview {
  const objectCounts = Object.fromEntries(IMPORT_V1_OBJECT_TYPES.map((type) => [type, 0])) as Record<ImportV1ObjectType, number>;
  objectCounts.project = 1;
  for (const definition of IMPORT_V1_SUPPORTED_OBJECT_MANIFEST) {
    if (definition.collection === "project") continue;
    objectCounts[definition.type] = document.objects[definition.collection].length;
  }
  return {
    projectCount: 1,
    projectTitle: document.project.title,
    objectCounts,
    relationCount: document.relations.length,
    totalObjectCount: Object.values(objectCounts).reduce((sum, count) => sum + count, 0),
    skippedCounts: {
      fields: warnings.filter((warning) => warning.code === "OPTIONAL_FIELD_SKIPPED").length,
      objects: 0,
      relations: 0
    },
    warnings: warnings.map((warning) => `${warning.path}: ${warning.message}`)
  };
}

export function preflightProjectImportV1(
  input: string | unknown,
  context: ProjectImportV1PreflightContext = {}
): ProjectImportV1PreflightResult {
  const issues: ProjectImportV1Issue[] = [];
  const warnings: ProjectImportV1Warning[] = [];
  const inputBytes = importInputBytes(input);
  let decoded: unknown = input;
  if (typeof input === "string") {
    if (inputBytes.byteLength > PROJECT_IMPORT_V1_MAX_BYTES) {
      return {
        ok: false,
        issues: [{
          code: "INVALID_FIELD_VALUE",
          path: "$",
          message: `Import v1 JSON exceeds ${PROJECT_IMPORT_V1_MAX_BYTES} bytes.`
        }]
      };
    }
    try {
      decoded = JSON.parse(input);
    } catch {
      return {
        ok: false,
        issues: [{ code: "INVALID_JSON", path: "$", message: "The selected file is not valid JSON." }]
      };
    }
  }

  decoded = normalizeLocalizedOptionalFields(decoded, warnings);

  const root = inspectObject(decoded, "$", ["schema", "version", "project", "objects", "relations"], ["schema", "version", "project", "objects"], issues);
  if (!root) {
    return { ok: false, issues: issues.length ? issues : [{ code: "INVALID_ROOT", path: "$", message: "Import v1 root must be one JSON object." }] };
  }
  if (root.schema !== PROJECT_IMPORT_V1_SCHEMA) {
    issue(issues, "UNSUPPORTED_SCHEMA", "$.schema", `$.schema must equal ${PROJECT_IMPORT_V1_SCHEMA}.`);
  }
  if (root.version !== PROJECT_IMPORT_V1_VERSION) {
    issue(issues, "UNSUPPORTED_VERSION", "$.version", `$.version must equal ${PROJECT_IMPORT_V1_VERSION}.`);
  }

  validateObjectRecord("project", root.project, "$.project", issues);
  const objects = parseObjects(root.objects, issues);
  const relations = parseRelations(root.relations, issues);
  if (!isRecord(root.project)) return { ok: false, issues };

  const document = {
    schema: PROJECT_IMPORT_V1_SCHEMA,
    version: PROJECT_IMPORT_V1_VERSION,
    project: root.project as unknown as ImportV1ProjectRecord,
    objects,
    relations
  } satisfies ValidatedProjectImportV1Document;

  const refs = buildRefMap(document, issues);
  validateAllDependencies(document, refs, issues);
  if (!orderImportV1Routes(document.objects.routes)) {
    issue(issues, "DEPENDENCY_CYCLE", "$.objects.routes", "Route parentRef dependencies contain a cycle.");
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    document,
    preview: preview(document, warnings),
    inputIdentity: {
      byteLength: inputBytes.byteLength,
      contentHash: hashImportInput(inputBytes),
      selectedMode: context.selectedMode ?? "unspecified",
      effectiveMode: context.effectiveMode ?? "unspecified",
      schema: PROJECT_IMPORT_V1_SCHEMA,
      version: PROJECT_IMPORT_V1_VERSION,
      targetIdentity: `new-project:${document.project.ref}`
    },
    warnings,
    issues: []
  };
}

export function importV1ManifestDefinition(type: ImportV1ObjectType) {
  return DEFINITION_BY_TYPE.get(type)!;
}

export const projectImportV1Authority = {
  schema: PROJECT_IMPORT_V1_SCHEMA,
  version: PROJECT_IMPORT_V1_VERSION,
  supportedManifest: IMPORT_V1_SUPPORTED_OBJECT_MANIFEST,
  supportedObjectTypes: IMPORT_V1_OBJECT_TYPES,
  forbiddenSystemFields: IMPORT_V1_FORBIDDEN_SYSTEM_FIELDS,
  structuredSummaryKeys: STRUCTURED_SUMMARY_KEYS,
  preflight: preflightProjectImportV1,
  orderRoutes: orderImportV1Routes
} as const;
