export type EntitySource = "user" | "ai" | "imported" | "system";

export type EntityId = string;

export type ISODateString = string;

export type Priority = "high" | "medium" | "low";

export type EntityType =
  | "researchDirection"
  | "project"
  | "route"
  | "routeNode"
  | "routeCheckpoint"
  | "taskCheckpoint"
  | "researchRoutine"
  | "routineCheckIn"
  | "task"
  | "review"
  | "experiment"
  | "experimentSummary"
  | "experimentRun"
  | "resultMetric"
  | "fileRef"
  | "output"
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "literature"
  | "literatureLink"
  | "aiContext"
  | "other";

export interface AIMetadata {
  generatedBy?: string;
  promptId?: string;
  sourceEntityIds?: string[];
  confidence?: number;
  needsReview?: boolean;
  lastAiAction?: string;
  lastAiUpdatedAt?: ISODateString;
}

export interface BaseEntity {
  id: EntityId;
  title: string;
  description?: string;
  tags: string[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
  archivedAt?: ISODateString;
  deletedAt?: ISODateString | null;
  source: EntitySource;
  schemaVersion: number;
  customFields?: Record<string, unknown>;
  aiMetadata?: AIMetadata;
}

export type ResearchDirectionStatus = "active" | "archived";

export interface ResearchDirection extends BaseEntity {
  status: ResearchDirectionStatus;
  orderIndex: number;
}

export type ProjectStatus = "planning" | "active" | "paused" | "completed" | "archived";

export interface Project extends BaseEntity {
  directionId?: EntityId;
  background?: string;
  objective?: string;
  scope?: string;
  researchQuestion?: string;
  status: ProjectStatus;
  priority: Priority;
  startDate?: ISODateString;
  targetDate?: ISODateString;
  completedAt?: ISODateString;
  progress?: number;
  orderIndex: number;
}

export type RouteNodeType =
  | "literature"
  | "experiment"
  | "algorithm"
  | "analysis"
  | "writing"
  | "output"
  | "review"
  | "other";

export type RouteNodeStatus =
  | "planned"
  | "active"
  | "completed"
  | "paused"
  | "adjusted"
  | "archived";

export type TimePrecision = "day" | "week" | "month" | "quarter" | "phase" | "free";

export type CaptureState =
  | "scheduled"
  | "unscheduled"
  | "idea"
  | "pending"
  | "someday"
  | "archived";

export interface RouteNode extends BaseEntity {
  projectId: EntityId;
  parentNodeId?: EntityId;
  objective?: string;
  expectedOutput?: string;
  nodeType: RouteNodeType;
  status: RouteNodeStatus;
  startDate?: ISODateString;
  endDate?: ISODateString;
  timeLabel?: string;
  timePrecision?: TimePrecision;
  showInGantt?: boolean;
  captureState: CaptureState;
  orderIndex: number;
  resultNote?: string;
  completedAt?: ISODateString;
}

export type RouteCheckpointStatus =
  | "completed"
  | "active"
  | "blocked"
  | "abandoned"
  | "planned";

export interface RouteCheckpoint extends BaseEntity {
  routeNodeId: EntityId;
  status: RouteCheckpointStatus;
  acceptanceCriteria?: string;
  dueDate?: ISODateString;
  feedback?: string;
  orderIndex: number;
}

export type TaskCheckpointStatus =
  | "completed"
  | "active"
  | "blocked"
  | "abandoned"
  | "planned";

export interface TaskCheckpoint extends BaseEntity {
  taskId: EntityId;
  status: TaskCheckpointStatus;
  acceptanceCriteria?: string;
  dueDate?: ISODateString;
  feedback?: string;
  orderIndex: number;
}

export type RoutineFrequency = "daily" | "weekly" | "monthly";

export type RoutineTargetType = "count" | "description";

export interface ResearchRoutine extends BaseEntity {
  projectId?: EntityId;
  frequency: RoutineFrequency;
  targetType: RoutineTargetType;
  targetCount?: number;
  targetDescription?: string;
  isActive: boolean;
  startDate?: ISODateString;
  endDate?: ISODateString;
  orderIndex: number;
}

export interface RoutineCheckIn extends BaseEntity {
  routineId: EntityId;
  projectId?: EntityId;
  checkedAt: ISODateString;
  periodKey: string;
  count: number;
  note?: string;
}

export type TaskType =
  | "reading"
  | "experiment"
  | "coding"
  | "writing"
  | "analysis"
  | "meeting"
  | "idea"
  | "review"
  | "other";

export type TaskStatus =
  | "todo"
  | "doing"
  | "done"
  | "delayed"
  | "blocked"
  | "cancelled"
  | "archived";

export type TimeBucket = "today" | "this_week" | "this_month" | "long_term" | "none";

export interface Task extends BaseEntity {
  projectId: EntityId;
  routeNodeId?: EntityId;
  taskType: TaskType;
  status: TaskStatus;
  priority: Priority;
  dueDate?: ISODateString;
  scheduledDate?: ISODateString;
  completedAt?: ISODateString;
  timeLabel?: string;
  timeBucket: TimeBucket;
  timePrecision?: "day" | "week" | "month" | "free";
  captureState: CaptureState;
  acceptanceCriteria?: string;
  resultNote?: string;
  blockedReason?: string;
  orderIndex: number;
}

export type ReviewType =
  | "stage"
  | "periodic"
  | "experiment_comparison"
  | "literature_comparison"
  | "custom";

export type ReviewOutlineSectionKey =
  | "stage_summary"
  | "key_progress"
  | "completed_items"
  | "major_problems"
  | "cause_analysis"
  | "next_plan"
  | "other"
  | "period_summary"
  | "period_completed"
  | "period_pending"
  | "next_period_plan"
  | "comparison_summary"
  | "comparison_targets"
  | "key_differences"
  | "main_conclusions"
  | "anomalies_and_problems"
  | "next_experiment_plan"
  | "literature_overview"
  | "literature_scope"
  | "method_differences"
  | "consensus_and_divergence"
  | "research_gaps_and_references"
  | "next_reading_or_research_plan"
  | "custom_summary";

export interface ReviewOutlineSection {
  key: ReviewOutlineSectionKey;
  content: string;
}

export interface Review extends BaseEntity {
  projectId: EntityId;
  reviewType: ReviewType;
  periodStart?: ISODateString;
  periodEnd?: ISODateString;
  periodLabel?: string;
  outlineSections: ReviewOutlineSection[];
  /** Read-only SQLite second-layer CAS evidence; never persisted by Planning. */
  structuredRevision?: number;
  /** Read-only canonical descriptor identity; never persisted by Planning. */
  descriptorIdentity?: string;
  /** Read-only SQLite lifecycle evidence; never persisted by Planning. */
  structuredLifecycleEvidence?: string;
  /** Read-only SQLite lifecycle projection; never persisted by Planning. */
  structuredLifecycleStatus?:
    | "active"
    | "deleted"
    | "permanently_deleted"
    | "transition_pending";
}

export type FaultType =
  | "healthy"
  | "unbalance"
  | "misalignment"
  | "bearing_fault"
  | "unknown";

export interface ExperimentSummary extends BaseEntity {
  projectId: EntityId;
  routeNodeId?: EntityId | null;
  taskId?: EntityId | null;
  purpose?: string;
  condition?: string;
  method?: string;
  result?: string;
  conclusion?: string;
  dataPath?: string;
  fileRefs: string[];
  experimentDate?: ISODateString;
}

export type RelationType =
  | "belongs_to"
  | "depends_on"
  | "blocks"
  | "supports"
  | "supported_by"
  | "produces"
  | "references"
  | "cites"
  | "derived_from"
  | "evidence_for"
  | "contradicts"
  | "uses"
  | "requires"
  | "supplements"
  | "extends"
  | "converted_to"
  | "generates_finding"
  | "supports_output"
  | "needs_followup_task"
  | "adjusts"
  | "summarizes"
  | "related_to";

export interface EntityLink {
  id: EntityId;
  sourceType: EntityType;
  sourceId: EntityId;
  targetType: EntityType;
  targetId: EntityId;
  relationType: RelationType;
  description?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  schemaVersion: number;
}

export type ChangeAction =
  | "created"
  | "updated"
  | "deleted"
  | "permanently_deleted"
  | "archived"
  | "restored"
  | "status_changed"
  | "ai_suggested"
  | "ai_modified";

export type ActorType = "user" | "ai" | "system";

export interface ChangeLog {
  id: EntityId;
  entityType: EntityType;
  entityId: EntityId;
  action: ChangeAction;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
  createdBy: ActorType;
  createdAt: ISODateString;
  schemaVersion: number;
}

export interface PlanningExportPackage {
  schemaVersion: number;
  app: "LabPod";
  exportedAt: ISODateString;
  researchDirections: ResearchDirection[];
  projects: Project[];
  routeNodes: RouteNode[];
  routeCheckpoints: RouteCheckpoint[];
  taskCheckpoints: TaskCheckpoint[];
  researchRoutines: ResearchRoutine[];
  routineCheckIns: RoutineCheckIn[];
  tasks: Task[];
  reviews: Review[];
  experimentSummaries: ExperimentSummary[];
  entityLinks: EntityLink[];
}

export interface PlanningData extends PlanningExportPackage {
  changeLogs: ChangeLog[];
}

export interface ProjectExportContext {
  project: Project;
  direction?: ResearchDirection;
  routeNodes: RouteNode[];
  researchRoutines?: ResearchRoutine[];
  routineCheckIns?: RoutineCheckIn[];
  tasks: Task[];
  reviews: Review[];
  experimentSummaries: ExperimentSummary[];
  entityLinks: EntityLink[];
}

export type CreateEntityInput<T extends BaseEntity> = Omit<
  T,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
  | "archivedAt"
  | "schemaVersion"
  | "source"
  | "tags"
> &
  Partial<
    Pick<
      T,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "deletedAt"
      | "archivedAt"
      | "schemaVersion"
      | "source"
      | "tags"
    >
  >;

export type UpdateEntityInput<T extends BaseEntity> = Partial<
  Omit<T, "id" | "createdAt" | "schemaVersion">
>;
