import type { RefreshEvent } from "../types/refresh";
import type { OperationLogEntry } from "../types/operationLog";
import { subscribeRefreshEvents } from "./refreshEventService";

export type BusinessOperationObjectType =
  | "project"
  | "researcherProfile"
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

export type BusinessOperationAction = "create" | "update" | "delete";
export type BusinessOperationResult = "success" | "failure";
export type BusinessOperationLanguage = "zh-CN" | "en-US";

export interface BusinessOperationTerminal {
  objectType: BusinessOperationObjectType;
  action: BusinessOperationAction;
  result: BusinessOperationResult;
}

export interface BusinessOperationToastEntry extends BusinessOperationTerminal {
  id: string;
  createdAt: string;
}

export interface BusinessOperationHistoryEntry extends BusinessOperationTerminal {
  id: string;
  createdAt: string;
}

type ObjectMetadata = {
  rawEntityTypes: readonly string[];
  applicableActions: readonly BusinessOperationAction[];
  labels: Record<BusinessOperationLanguage, string>;
};

const CRUD_ACTIONS = ["create", "update", "delete"] as const;

export const BUSINESS_OPERATION_OBJECT_METADATA: Record<
  BusinessOperationObjectType,
  ObjectMetadata
> = {
  project: {
    rawEntityTypes: ["project"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "课题", "en-US": "Project" }
  },
  researcherProfile: {
    rawEntityTypes: ["researcherProfile"],
    applicableActions: ["update"],
    labels: { "zh-CN": "研究者档案", "en-US": "Researcher profile" }
  },
  route: {
    rawEntityTypes: ["routeNode", "route"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "路线", "en-US": "Route" }
  },
  task: {
    rawEntityTypes: ["task"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "任务", "en-US": "Task" }
  },
  review: {
    rawEntityTypes: ["review"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "复盘", "en-US": "Review" }
  },
  experiment: {
    rawEntityTypes: ["experiment"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "实验", "en-US": "Experiment" }
  },
  experimentRun: {
    rawEntityTypes: ["experimentRun"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "实验运行", "en-US": "Experiment run" }
  },
  literature: {
    rawEntityTypes: ["literature"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "文献", "en-US": "Literature" }
  },
  resultItem: {
    rawEntityTypes: ["resultItem"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "结果资产", "en-US": "Result asset" }
  },
  finding: {
    rawEntityTypes: ["finding"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "关键发现", "en-US": "Finding" }
  },
  outputCandidate: {
    rawEntityTypes: ["outputCandidate"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "候选成果", "en-US": "Output candidate" }
  },
  outputGap: {
    rawEntityTypes: ["outputGap"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "成果缺口", "en-US": "Output gap" }
  },
  researchOutput: {
    rawEntityTypes: ["researchOutput", "output"],
    applicableActions: CRUD_ACTIONS,
    labels: { "zh-CN": "正式成果", "en-US": "Research output" }
  }
};

export const BUSINESS_OPERATION_APPLICABLE_PAIRS = (
  Object.entries(BUSINESS_OPERATION_OBJECT_METADATA) as Array<
    [BusinessOperationObjectType, ObjectMetadata]
  >
).flatMap(([objectType, metadata]) =>
  metadata.applicableActions.map((action) => ({ objectType, action }))
);

type OperationAdmission = {
  action: BusinessOperationAction;
  objectTypes: readonly BusinessOperationObjectType[];
};

const OPERATION_ADMISSION_BY_ID: Readonly<Record<string, OperationAdmission>> = {
  "planning.createProject": { action: "create", objectTypes: ["project"] },
  "planning.updateProject": { action: "update", objectTypes: ["project"] },
  "planning.deleteProject": { action: "delete", objectTypes: ["project"] },
  "planning.createRouteNode": { action: "create", objectTypes: ["route"] },
  "planning.updateRouteNode": { action: "update", objectTypes: ["route"] },
  "planning.deleteRouteNode": { action: "delete", objectTypes: ["route"] },
  "planning.createTask": { action: "create", objectTypes: ["task"] },
  "planning.updateTask": { action: "update", objectTypes: ["task"] },
  "planning.completeTask": { action: "update", objectTypes: ["task"] },
  "planning.reopenTask": { action: "update", objectTypes: ["task"] },
  "planning.postponeTask": { action: "update", objectTypes: ["task"] },
  "planning.deleteTask": { action: "delete", objectTypes: ["task"] },
  "planning.createReview": { action: "create", objectTypes: ["review"] },
  "planning.createReviewWithTargets": { action: "create", objectTypes: ["review"] },
  "planning.updateReview": { action: "update", objectTypes: ["review"] },
  "review.softDelete": { action: "delete", objectTypes: ["review"] },
  "researcherProfile.updateResearcherProfile": {
    action: "update",
    objectTypes: ["researcherProfile"]
  },
  "researcherProfile.update": { action: "update", objectTypes: ["researcherProfile"] },
  "experiment.createExperiment": { action: "create", objectTypes: ["experiment"] },
  "experiment.updateExperiment": { action: "update", objectTypes: ["experiment"] },
  "experiment.deleteExperiment.safe": { action: "delete", objectTypes: ["experiment"] },
  "experimentRun.createExperimentRun": {
    action: "create",
    objectTypes: ["experimentRun"]
  },
  "experimentRun.updateExperimentRun": {
    action: "update",
    objectTypes: ["experimentRun"]
  },
  "experimentRun.deleteExperimentRun.safe": {
    action: "delete",
    objectTypes: ["experimentRun"]
  },
  "literature.createLiterature": { action: "create", objectTypes: ["literature"] },
  "literature.updateLiterature": { action: "update", objectTypes: ["literature"] },
  "literature.deleteLiterature": { action: "delete", objectTypes: ["literature"] },
  "literature.delete": { action: "delete", objectTypes: ["literature"] },
  "outputConversion.createResultItem": { action: "create", objectTypes: ["resultItem"] },
  "outputConversion.updateResultItem": { action: "update", objectTypes: ["resultItem"] },
  "outputConversion.createFinding": { action: "create", objectTypes: ["finding"] },
  "outputConversion.updateFinding": { action: "update", objectTypes: ["finding"] },
  "outputConversion.createOutputCandidate": {
    action: "create",
    objectTypes: ["outputCandidate"]
  },
  "outputConversion.updateOutputCandidate": {
    action: "update",
    objectTypes: ["outputCandidate"]
  },
  "outputConversion.createOutputGap": { action: "create", objectTypes: ["outputGap"] },
  "outputConversion.createOutputGapForDeposition": {
    action: "create",
    objectTypes: ["outputGap"]
  },
  "outputConversion.updateOutputGap": { action: "update", objectTypes: ["outputGap"] },
  "output.createResearchOutput": { action: "create", objectTypes: ["researchOutput"] },
  "output.updateResearchOutput": { action: "update", objectTypes: ["researchOutput"] },
  "output.lifecycle.softDelete": {
    action: "delete",
    objectTypes: [
      "resultItem",
      "finding",
      "outputCandidate",
      "outputGap",
      "researchOutput"
    ]
  },
  "output.resultItem.create": { action: "create", objectTypes: ["resultItem"] },
  "output.resultItem.edit": { action: "update", objectTypes: ["resultItem"] },
  "output.resultItem.softDelete": { action: "delete", objectTypes: ["resultItem"] },
  "output.finding.create": { action: "create", objectTypes: ["finding"] },
  "output.finding.edit": { action: "update", objectTypes: ["finding"] },
  "output.finding.softDelete": { action: "delete", objectTypes: ["finding"] },
  "output.outputCandidate.create": {
    action: "create",
    objectTypes: ["outputCandidate"]
  },
  "output.outputCandidate.edit": {
    action: "update",
    objectTypes: ["outputCandidate"]
  },
  "output.outputCandidate.softDelete": {
    action: "delete",
    objectTypes: ["outputCandidate"]
  },
  "output.outputGap.create": { action: "create", objectTypes: ["outputGap"] },
  "output.outputGap.edit": { action: "update", objectTypes: ["outputGap"] },
  "output.outputGap.softDelete": { action: "delete", objectTypes: ["outputGap"] },
  "output.researchOutput.create": {
    action: "create",
    objectTypes: ["researchOutput"]
  },
  "output.researchOutput.edit": {
    action: "update",
    objectTypes: ["researchOutput"]
  },
  "output.researchOutput.softDelete": {
    action: "delete",
    objectTypes: ["researchOutput"]
  }
};

// Frozen projection eligibility, independent of business admission. Each family
// rereads its list/detail on the published refresh keys; new operations opt in
// only after their visible state path has been checked.
export const ROUTINE_SUCCESS_OPERATIONS: Readonly<Record<BusinessOperationObjectType, readonly string[]>> = {
  project: ["planning.createProject", "planning.updateProject", "planning.deleteProject"],
  route: ["planning.createRouteNode", "planning.updateRouteNode", "planning.deleteRouteNode"],
  task: ["planning.createTask", "planning.updateTask", "planning.completeTask", "planning.reopenTask", "planning.postponeTask", "planning.deleteTask"],
  review: ["planning.createReview", "planning.createReviewWithTargets", "planning.updateReview", "review.softDelete"],
  researcherProfile: ["researcherProfile.updateResearcherProfile"],
  experiment: ["experiment.createExperiment", "experiment.updateExperiment", "experiment.deleteExperiment.safe"],
  experimentRun: ["experimentRun.createExperimentRun", "experimentRun.updateExperimentRun", "experimentRun.deleteExperimentRun.safe"],
  literature: ["literature.createLiterature", "literature.updateLiterature", "literature.deleteLiterature", "literature.delete"],
  resultItem: ["outputConversion.createResultItem", "outputConversion.updateResultItem", "output.lifecycle.softDelete", "output.resultItem.create", "output.resultItem.edit", "output.resultItem.softDelete"],
  finding: ["outputConversion.createFinding", "outputConversion.updateFinding", "output.lifecycle.softDelete", "output.finding.create", "output.finding.edit", "output.finding.softDelete"],
  outputCandidate: ["outputConversion.createOutputCandidate", "outputConversion.updateOutputCandidate", "output.lifecycle.softDelete", "output.outputCandidate.create", "output.outputCandidate.edit", "output.outputCandidate.softDelete"],
  outputGap: ["outputConversion.createOutputGap", "outputConversion.createOutputGapForDeposition", "outputConversion.updateOutputGap", "output.lifecycle.softDelete", "output.outputGap.create", "output.outputGap.edit", "output.outputGap.softDelete"],
  researchOutput: ["output.createResearchOutput", "output.updateResearchOutput", "output.lifecycle.softDelete", "output.researchOutput.create", "output.researchOutput.edit", "output.researchOutput.softDelete"]
};

export function isRoutineBusinessOperationSuccess(
  operation: string | undefined,
  terminal: BusinessOperationTerminal | undefined
) {
  return Boolean(operation && terminal?.result === "success" &&
    ROUTINE_SUCCESS_OPERATIONS[terminal.objectType]?.includes(operation));
}

const ACTION_LABELS: Record<
  BusinessOperationAction,
  Record<BusinessOperationLanguage, string>
> = {
  create: { "zh-CN": "创建", "en-US": "Create" },
  update: { "zh-CN": "修改", "en-US": "Update" },
  delete: { "zh-CN": "删除", "en-US": "Delete" }
};

const RESULT_LABELS: Record<
  BusinessOperationResult,
  Record<BusinessOperationLanguage, string>
> = {
  success: { "zh-CN": "成功", "en-US": "Succeeded" },
  failure: { "zh-CN": "失败", "en-US": "Failed" }
};

export function businessOperationPresentation(
  terminal: BusinessOperationTerminal,
  language: BusinessOperationLanguage
) {
  const objectLabel = BUSINESS_OPERATION_OBJECT_METADATA[terminal.objectType].labels[language];
  const actionLabel = ACTION_LABELS[terminal.action][language];
  const resultLabel = RESULT_LABELS[terminal.result][language];
  return {
    objectLabel,
    actionLabel,
    resultLabel,
    text: `${objectLabel} · ${actionLabel} · ${resultLabel}`
  };
}

function objectTypeForRawEntityType(
  rawEntityType: string,
  admittedObjectTypes: readonly BusinessOperationObjectType[]
) {
  const matches = admittedObjectTypes.filter((objectType) =>
    BUSINESS_OPERATION_OBJECT_METADATA[objectType].rawEntityTypes.includes(rawEntityType)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function expectedRelation(action: BusinessOperationAction) {
  if (action === "create") return "created";
  if (action === "update") return "updated";
  return "deleted";
}

export function projectBusinessOperationRefreshEvent(
  event: RefreshEvent
): BusinessOperationTerminal | undefined {
  if (event.source !== "service.write" || !event.operation) return undefined;
  if (
    event.writeFeedbackStatus !== "success" &&
    event.writeFeedbackStatus !== "partial" &&
    event.writeFeedbackStatus !== "error"
  ) {
    return undefined;
  }
  const admission = OPERATION_ADMISSION_BY_ID[event.operation];
  if (!admission) return undefined;

  if (event.writeFeedbackStatus !== "success") {
    const matchingRawTypes = [
      ...new Set(
        event.affectedEntities
          .map((entity) => entity.type)
          .filter((type) => Boolean(objectTypeForRawEntityType(type, admission.objectTypes)))
      )
    ];
    return projectFormalBusinessAttemptFailure(
      event.operation,
      matchingRawTypes.length === 1 ? matchingRawTypes[0] : undefined
    );
  }

  const matchingEntities = event.affectedEntities.filter((entity) =>
    entity.relation === expectedRelation(admission.action) &&
    Boolean(objectTypeForRawEntityType(entity.type, admission.objectTypes))
  );
  if (matchingEntities.length !== 1) return undefined;
  const objectType = objectTypeForRawEntityType(
    matchingEntities[0].type,
    admission.objectTypes
  );
  if (!objectType) return undefined;
  return { objectType, action: admission.action, result: "success" };
}

export function projectBusinessOperationLogEntry(
  entry: OperationLogEntry
): BusinessOperationHistoryEntry | undefined {
  if (entry.source !== "user") return undefined;
  if (
    entry.operationType !== "create" &&
    entry.operationType !== "update" &&
    entry.operationType !== "delete"
  ) return undefined;
  if (entry.status !== "success" && entry.status !== "error") return undefined;
  if (!entry.target.entityId?.trim() || !entry.createdAt?.trim()) return undefined;

  const objectTypes = (
    Object.keys(BUSINESS_OPERATION_OBJECT_METADATA) as BusinessOperationObjectType[]
  ).filter((objectType) =>
    BUSINESS_OPERATION_OBJECT_METADATA[objectType].rawEntityTypes.includes(
      entry.target.entityType
    )
  );
  if (objectTypes.length !== 1) return undefined;
  const objectType = objectTypes[0];
  const action = entry.operationType;
  if (!BUSINESS_OPERATION_OBJECT_METADATA[objectType].applicableActions.includes(action)) {
    return undefined;
  }
  return {
    id: entry.id,
    objectType,
    action,
    result: entry.status === "success" ? "success" : "failure",
    createdAt: entry.createdAt
  };
}

type ToastListener = () => void;

let currentToast: BusinessOperationToastEntry | null = null;
let toastSequence = 0;
const toastListeners = new Set<ToastListener>();

function notifyToastListeners() {
  toastListeners.forEach((listener) => listener());
}

export function getBusinessOperationToast() {
  return currentToast;
}

export function subscribeBusinessOperationToast(listener: ToastListener) {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}

export function admitBusinessOperationTerminal(
  terminal: BusinessOperationTerminal
): BusinessOperationTerminal | undefined {
  const metadata = BUSINESS_OPERATION_OBJECT_METADATA[terminal.objectType];
  if (
    !metadata ||
    !metadata.applicableActions.includes(terminal.action) ||
    (terminal.result !== "success" && terminal.result !== "failure")
  ) {
    return undefined;
  }
  return { ...terminal };
}

export function projectFormalBusinessAttemptFailure(
  operation: string,
  rawEntityType?: string
): BusinessOperationTerminal | undefined {
  const admission = OPERATION_ADMISSION_BY_ID[operation];
  if (!admission) return undefined;
  const objectType = admission.objectTypes.length === 1
    ? admission.objectTypes[0]
    : rawEntityType
      ? objectTypeForRawEntityType(rawEntityType, admission.objectTypes)
      : undefined;
  if (!objectType) return undefined;
  return admitBusinessOperationTerminal({
    objectType,
    action: admission.action,
    result: "failure"
  });
}

export function publishFormalBusinessAttemptFailure(
  operation: string,
  rawEntityType?: string
) {
  const terminal = projectFormalBusinessAttemptFailure(operation, rawEntityType);
  return terminal ? publishBusinessOperationTerminal(terminal) : undefined;
}

export function publishBusinessOperationTerminal(
  terminal: BusinessOperationTerminal
): BusinessOperationToastEntry | undefined {
  const admitted = admitBusinessOperationTerminal(terminal);
  if (!admitted) return undefined;
  // A failure is intentionally session-sticky. Concurrent notification
  // completeness is outside A3; a later event must not dismiss it implicitly.
  if (currentToast?.result === "failure") return currentToast;
  toastSequence += 1;
  currentToast = {
    ...admitted,
    id: `business-operation-toast-${toastSequence}`,
    createdAt: new Date().toISOString()
  };
  notifyToastListeners();
  return currentToast;
}

export function dismissBusinessOperationToast(id: string) {
  if (currentToast?.id !== id) return;
  currentToast = null;
  notifyToastListeners();
}

export interface BusinessOperationFeedbackOwner {
  start(): void;
  stop(): void;
}

export interface BusinessOperationRefreshPort {
  subscribe(listener: (event: RefreshEvent) => void): { unsubscribe(): void };
}

export function createBusinessOperationFeedbackOwner(input: {
  refreshPort?: BusinessOperationRefreshPort;
  publish?: (terminal: BusinessOperationTerminal) => void;
} = {}): BusinessOperationFeedbackOwner {
  const refreshPort = input.refreshPort ?? { subscribe: subscribeRefreshEvents };
  const publish = input.publish ?? publishBusinessOperationTerminal;
  let subscription: { unsubscribe(): void } | undefined;
  return {
    start() {
      if (subscription) return;
      subscription = refreshPort.subscribe((event) => {
        const terminal = projectBusinessOperationRefreshEvent(event);
        if (
          isRoutineBusinessOperationSuccess(event.operation, terminal) &&
          !(event.errors?.length || event.warnings?.length || event.skipped?.length)
        ) return;
        if (terminal) publish(terminal);
      });
    },
    stop() {
      subscription?.unsubscribe();
      subscription = undefined;
    }
  };
}

const applicationBusinessOperationFeedbackOwner = createBusinessOperationFeedbackOwner();
let applicationInstallCount = 0;

export function installBusinessOperationFeedbackOwner() {
  applicationInstallCount += 1;
  if (applicationInstallCount === 1) {
    applicationBusinessOperationFeedbackOwner.start();
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    applicationInstallCount = Math.max(0, applicationInstallCount - 1);
    if (applicationInstallCount === 0) {
      applicationBusinessOperationFeedbackOwner.stop();
    }
  };
}
