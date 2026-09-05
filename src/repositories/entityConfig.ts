import type {
  Experiment,
  ExperimentRun,
  FileRef,
  Finding,
  Literature,
  LiteratureLink,
  OperationLogEntry,
  Milestone,
  OutputCandidate,
  OutputConversionRelation,
  OutputGapFeedbackCard,
  OutputGap,
  OutputSourceLink,
  ResearchOutput,
  ResearchTask,
  RecycleEntry,
  ResultItem,
  ResultMetric
} from "../types";
import type { EntityRepositoryConfig } from "./types";

export const milestoneRepositoryConfig: EntityRepositoryConfig<Milestone> = {
  entityName: "milestone",
  idPrefix: "milestone",
  storageKey: "researchpilot.milestones",
  tableName: "milestones",
  seedData: []
};

export const taskRepositoryConfig: EntityRepositoryConfig<ResearchTask> = {
  entityName: "task",
  idPrefix: "task",
  storageKey: "researchpilot.tasks",
  tableName: "tasks",
  seedData: []
};

export const experimentRepositoryConfig: EntityRepositoryConfig<Experiment> = {
  entityName: "experiment",
  idPrefix: "experiment",
  storageKey: "researchpilot.experiments",
  tableName: "experiments",
  seedData: []
};

export const experimentRunRepositoryConfig: EntityRepositoryConfig<ExperimentRun> = {
  entityName: "experimentRun",
  idPrefix: "experiment-run",
  storageKey: "researchpilot.experimentRuns",
  tableName: "experiment_runs",
  seedData: []
};

export const resultMetricRepositoryConfig: EntityRepositoryConfig<ResultMetric> = {
  entityName: "resultMetric",
  idPrefix: "result-metric",
  storageKey: "researchpilot.resultMetrics",
  tableName: "result_metrics",
  seedData: []
};

export const fileRefRepositoryConfig: EntityRepositoryConfig<FileRef> = {
  entityName: "fileRef",
  idPrefix: "file-ref",
  storageKey: "researchpilot.fileRefs",
  tableName: "file_refs",
  seedData: []
};

export const outputRepositoryConfig: EntityRepositoryConfig<ResearchOutput> = {
  entityName: "output",
  idPrefix: "output",
  storageKey: "researchpilot.outputs",
  tableName: "outputs",
  seedData: []
};

export const resultItemRepositoryConfig: EntityRepositoryConfig<ResultItem> = {
  entityName: "resultItem",
  idPrefix: "result-item",
  storageKey: "researchpilot.resultItems",
  tableName: "result_items",
  seedData: []
};

export const findingRepositoryConfig: EntityRepositoryConfig<Finding> = {
  entityName: "finding",
  idPrefix: "finding",
  storageKey: "researchpilot.findings",
  tableName: "findings",
  seedData: []
};

export const outputCandidateRepositoryConfig: EntityRepositoryConfig<OutputCandidate> = {
  entityName: "outputCandidate",
  idPrefix: "output-candidate",
  storageKey: "researchpilot.outputCandidates",
  tableName: "output_candidates",
  seedData: []
};

export const outputGapRepositoryConfig: EntityRepositoryConfig<OutputGap> = {
  entityName: "outputGap",
  idPrefix: "output-gap",
  storageKey: "researchpilot.outputGaps",
  tableName: "output_gaps",
  seedData: []
};

export const outputGapFeedbackCardRepositoryConfig: EntityRepositoryConfig<OutputGapFeedbackCard> = {
  entityName: "outputGapFeedbackCard",
  idPrefix: "output-gap-feedback-card",
  storageKey: "researchpilot.outputGapFeedbackCards",
  tableName: "output_gap_feedback_cards",
  seedData: []
};

export const outputConversionRelationRepositoryConfig: EntityRepositoryConfig<OutputConversionRelation> = {
  entityName: "outputConversionRelation",
  idPrefix: "output-relation",
  storageKey: "researchpilot.outputConversionRelations",
  tableName: "output_conversion_relations",
  seedData: []
};

export const outputSourceLinkRepositoryConfig: EntityRepositoryConfig<OutputSourceLink> = {
  entityName: "outputSourceLink",
  idPrefix: "output-source-link",
  storageKey: "researchpilot.outputSourceLinks",
  tableName: "output_source_links",
  seedData: []
};

export const literatureRepositoryConfig: EntityRepositoryConfig<Literature> = {
  entityName: "literature",
  idPrefix: "literature",
  storageKey: "researchpilot.literatures",
  tableName: "literatures",
  seedData: []
};

export const literatureLinkRepositoryConfig: EntityRepositoryConfig<LiteratureLink> = {
  entityName: "literatureLink",
  idPrefix: "literature-link",
  storageKey: "researchpilot.literatureLinks",
  tableName: "literature_links",
  seedData: []
};

export const operationLogRepositoryConfig: EntityRepositoryConfig<OperationLogEntry> = {
  entityName: "operationLog",
  idPrefix: "operation-log",
  storageKey: "researchpilot.operationLogs",
  tableName: "operation_logs",
  seedData: []
};

export const recycleEntryRepositoryConfig: EntityRepositoryConfig<RecycleEntry> = {
  entityName: "recycleEntry",
  idPrefix: "recycle-entry",
  storageKey: "researchpilot.recycleEntries",
  tableName: "recycle_entries",
  seedData: []
};
