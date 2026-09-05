import type { EntityId } from "./common";
import type {
  Experiment,
  ExperimentRating,
  ExperimentRun,
  ExperimentStatus,
  FileRef,
  ResultMetric
} from "./experiment";
import type { ResearchOutput } from "./output";
import type { Project, RouteNode, Task } from "./planning";
import type { ManuscriptBinding } from "./manuscriptBinding";

export type ExperimentTagMatchMode = "any" | "all";

export type ExperimentQueryOptions = {
  projectId?: EntityId;
  routeId?: EntityId;
  taskId?: EntityId;
  outputId?: EntityId;
  status?: ExperimentStatus | ExperimentStatus[];
  rating?: ExperimentRating | ExperimentRating[];
  tags?: string[];
  tagMatch?: ExperimentTagMatchMode;
  keyword?: string;
  usableForPaper?: boolean;
  usableForReport?: boolean;
  usableForPatent?: boolean;
};

export type ExperimentSummaryInfo = {
  title: string;
  purposeAndQuestion?: string;
  status: ExperimentStatus;
  rating?: ExperimentRating;
  runCount: number;
  metricCount: number;
  fileRefCount: number;
  outputCount: number;
  tags: string[];
  usableForPaper: boolean;
  usableForReport: boolean;
  usableForPatent: boolean;
};

export type ExperimentDetailContext = {
  experiment: Experiment;
  project: Project | null;
  route: RouteNode | null;
  task: Task | null;
  outputs: ResearchOutput[];
  runs: ExperimentRun[];
  metricsByRunId: Record<EntityId, ResultMetric[]>;
  fileRefsByRunId: Record<EntityId, FileRef[]>;
  experimentFileRefs: FileRef[];
  manuscriptBinding?: ManuscriptBinding;
  relatedFileRefs: FileRef[];
  summaryInfo: ExperimentSummaryInfo;
};

export type ExperimentRunContext = {
  run: ExperimentRun;
  experiment: Experiment;
  project: Project | null;
  route: RouteNode | null;
  task: Task | null;
  metrics: ResultMetric[];
  fileRefs: FileRef[];
  parentExperimentFileRefs: FileRef[];
};

export type ExperimentOutputContext = {
  experimentBasicInfo: {
    id: EntityId;
    title: string;
    purposeAndQuestion?: string;
    status: ExperimentStatus;
    rating?: ExperimentRating;
    tags: string[];
  };
  relatedProject: Project | null;
  relatedRoute: RouteNode | null;
  relatedTask: Task | null;
  conditions: {
    summary?: string;
    items: Experiment["conditionItems"];
    variables: Experiment["variables"];
    materials: Experiment["materials"];
  };
  methodSummary?: string;
  runs: Array<{
    run: ExperimentRun;
    metrics: ResultMetric[];
    fileRefs: FileRef[];
  }>;
  metrics: ResultMetric[];
  fileRefs: FileRef[];
  keyFindings: string[];
  issues: string[];
  nextActions: string[];
  usableForPaper: boolean;
  usableForReport: boolean;
  usableForPatent: boolean;
  outputs: ResearchOutput[];
};
