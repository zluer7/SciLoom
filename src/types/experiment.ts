import type { AuditableEntity, EntityId, ISODateString } from "./common";
import type { EntitySource } from "./planning";
import type { ManuscriptChannel } from "./manuscriptChannel";

export const EXPERIMENT_SCHEMA_VERSION = 2;

export type FaultType =
  | "healthy"
  | "unbalance"
  | "misalignment"
  | "bearing_fault"
  | "unknown";

export type ExperimentStatus =
  | "planned"
  | "running"
  | "completed"
  | "paused"
  | "failed"
  | "archived";

export type ExperimentRunStatus =
  | "planned"
  | "running"
  | "completed"
  | "paused"
  | "failed"
  | "cancelled";

export type ExperimentRating =
  | "excellent"
  | "good"
  | "usable"
  | "inconclusive"
  | "failed";

export type CustomFieldValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | Record<string, unknown>;

export type CustomFieldValueType =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "multi_select"
  | "date"
  | "json";

export type ConditionItemRole =
  | "independent_variable"
  | "dependent_variable"
  | "control_variable"
  | "environment"
  | "sample"
  | "parameter"
  | "other";

export type ResultMetricValueType =
  | "number"
  | "text"
  | "percentage"
  | "boolean"
  | "json";

export type FileRefOwnerType =
  | "experiment"
  | "experimentRun"
  | "literature"
  | "review"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type FileRefType =
  | "raw_data"
  | "processed_data"
  | "code"
  | "config"
  | "model"
  | "figure"
  | "table"
  | "log"
  | "report"
  | "paper_material"
  | "pdf"
  | "supplement"
  | "external_note"
  | "image"
  | "screenshot"
  | "code_or_data"
  | "attachment"
  | "other";

export type FileRefResourceKind = "file" | "folder";
export type FileRefRole = "manuscript" | "defaultFolder" | "attachment";
export type FileRefLocationMode = "managed" | "external";
export type FileRefAvailabilityStatus =
  | "available"
  | "missing"
  | "unavailable"
  | "wrong_type"
  | "managed_placement_invalid"
  | "not_verified"
  | "metadata_deleted"
  | "metadata_not_found";

export interface FileRefAvailabilityResult {
  status: FileRefAvailabilityStatus;
  path: string;
  expectedResourceKind: FileRefResourceKind;
  actualResourceKind?: FileRefResourceKind;
  canonicalPath?: string;
  symlinkDetected?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface CustomField {
  id: EntityId;
  name: string;
  value: CustomFieldValue;
  valueType?: CustomFieldValueType;
  unit?: string;
  group?: string;
  description?: string;
}

export interface ConditionItem {
  id: EntityId;
  name: string;
  value: string | number | boolean;
  unit?: string;
  role?: ConditionItemRole;
  description?: string;
}

export interface MethodStep {
  id: EntityId;
  order: number;
  title: string;
  description?: string;
  toolOrMethod?: string;
  parameters?: Record<string, unknown>;
}

export interface ResearchVariable {
  id: EntityId;
  name: string;
  value?: string | number | boolean;
  unit?: string;
  role?: ConditionItemRole;
  description?: string;
}

export interface ResearchMaterial {
  id: EntityId;
  name: string;
  materialType?: string;
  amount?: string | number;
  unit?: string;
  description?: string;
}

export type Experiment = AuditableEntity & {
  schemaVersion: number;
  source: EntitySource;
  tags: string[];
  createdLocalDate: string;
  createdLocalTime: string;
  workspaceTitleIdentity: string;

  projectId: EntityId;
  routeId?: EntityId | null;
  taskId?: EntityId | null;

  title: string;
  purposeAndQuestion?: string;
  conditionSummary?: string;
  methodSummary?: string;
  resultSummary: string;
  conclusionAndNextSteps?: string;
  other?: string;

  status: ExperimentStatus;
  rating?: ExperimentRating;

  usableForPaper: boolean;
  usableForReport: boolean;
  usableForPatent: boolean;

  conditionItems: ConditionItem[];
  methodSteps: MethodStep[];
  variables: ResearchVariable[];
  materials: ResearchMaterial[];
  customFields: CustomField[];
  legacy?: Record<string, unknown>;
  migratedFromLegacy?: boolean;

  // Legacy compatibility fields used by the current lightweight experiment page.
  experimentName: string;
  machineObject: string;
  faultType: FaultType;
  speed?: number;
  load?: number;
  sensorConfig: string;
  dataPath: string;
  samplingRate?: number;
  duration?: number;
  problemNotes?: string;
  nextAction?: string;
};

export type ExperimentRun = AuditableEntity & {
  schemaVersion: number;
  source: EntitySource;
  tags: string[];
  createdLocalDate: string;
  createdLocalTime: string;
  workspaceTitleIdentity: string;

  experimentId: EntityId;
  projectId: EntityId;
  routeId?: EntityId | null;
  taskId?: EntityId | null;

  title: string;
  runLabel?: string;
  status: ExperimentRunStatus;
  startedAt?: ISODateString;
  completedAt?: ISODateString;

  conditionSummary?: string;
  variableParameterSummary?: string;
  methodSummary?: string;
  resultSummary?: string;
  conclusion?: string;
  summaryOther?: string;
  rating?: ExperimentRating;

  conditionItems: ConditionItem[];
  methodSteps: MethodStep[];
  variables: ResearchVariable[];
  materials: ResearchMaterial[];
  customFields: CustomField[];
  legacy?: Record<string, unknown>;
};

export type ResultMetric = AuditableEntity & {
  schemaVersion: number;
  source: EntitySource;
  tags: string[];

  runId: EntityId;
  experimentId?: EntityId | null;
  name: string;
  value: number | string;
  unit?: string;
  description?: string;
  metricGroup?: string;
  higherIsBetter?: boolean;
  valueType?: ResultMetricValueType;
  baselineValue?: number | string;
  targetValue?: number | string;
  orderIndex?: number;
  customFields: CustomField[];
};

export type FileRef = AuditableEntity & {
  revision?: number;
  permanentDeleteStatus?: "permanently_deleted" | null;
  permanentDeleteLifecycleActionId?: string | null;
  permanentlyDeletedAt?: ISODateString | null;
  schemaVersion: number;
  source: EntitySource;

  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  manuscriptChannel: ManuscriptChannel;
  resourceKind: FileRefResourceKind;
  fileRole: FileRefRole;
  locationMode: FileRefLocationMode;
  fileType: FileRefType | string;
  path: string;
  pathIdentityKey: string;
  title: string;
  description?: string;
  candidateRequestId?: string;
  candidateOccurredAt?: ISODateString;
  customFields: CustomField[];
};

export interface FileRefPathSummary {
  id: EntityId;
  ownerType: FileRefOwnerType;
  ownerId: EntityId;
  fileName: string;
  extension?: string;
  fileKind?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  pathSummary: string;
  availabilityStatus: "not_verified";
}

type DefaultCreateKeys =
  | "id"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
  | "createdLocalDate"
  | "createdLocalTime"
  | "workspaceTitleIdentity"
  | "schemaVersion";

export type CreateExperimentInput = Pick<Experiment, "projectId"> &
  Partial<Omit<Experiment, DefaultCreateKeys | "projectId">>;

export type UpdateExperimentInput = Partial<
  Omit<
    Experiment,
    "id" | "createdAt" | "updatedAt" | "createdLocalDate" | "createdLocalTime" | "workspaceTitleIdentity"
  >
>;

export type CreateExperimentRunInput = Pick<ExperimentRun, "experimentId"> &
  Partial<Omit<ExperimentRun, DefaultCreateKeys | "experimentId" | "projectId">>;

export type UpdateExperimentRunInput = Partial<
  Omit<
    ExperimentRun,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "createdLocalDate"
    | "createdLocalTime"
    | "workspaceTitleIdentity"
    | "experimentId"
    | "projectId"
  >
>;

export type CreateResultMetricInput = Pick<ResultMetric, "runId" | "name" | "value"> &
  Partial<Omit<ResultMetric, DefaultCreateKeys | "runId" | "name" | "value">>;

export type UpdateResultMetricInput = Partial<
  Omit<ResultMetric, "id" | "createdAt" | "updatedAt">
>;

export type CreateFileRefInput = Pick<FileRef, "ownerType" | "ownerId" | "path"> &
  Partial<Omit<FileRef, DefaultCreateKeys | "ownerType" | "ownerId" | "path">>;

export type UpdateFileRefInput = Partial<
  Pick<FileRef, "fileType" | "title" | "description" | "source" | "customFields">
>;
