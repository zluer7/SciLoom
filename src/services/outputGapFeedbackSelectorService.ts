import type { EntityId } from "../types/common";
import type { EntitySummary } from "../types/entityContext";
import type { OutputGap } from "../types/outputConversion";
import type {
  OutputGapRouteNodeSummary,
  OutputGapTaskSummary,
  RouteNodeOutputGapSummary
} from "../types/planningContext";
import { outputConversionService } from "./outputConversionService";
import { getOutputGapFeedbackCardSummary } from "./outputGapFeedbackCardSelectorService";
import { planningSelectorService } from "./planningSelectorService";

export type OutputGapFeedbackTargetType = "task" | "routeNode";

export type OutputGapFeedbackRelationSource =
  | "entityLink"
  | "relatedTaskIdFallback"
  | "relatedRouteNodeIdFallback"
  | "mixed"
  | "none";

export type OutputGapFeedbackTargetSummary = {
  targetType: OutputGapFeedbackTargetType;
  targetId: EntityId;
  title: string;
  status?: string;
  relationType?: string;
  linkedAt?: string;
  relationSource: OutputGapFeedbackRelationSource;
  sourceAvailable: boolean;
  pendingFeedbackCardCount: number;
  warning?: string;
};

export type OutputGapFeedbackGapSummary = {
  outputGapId: EntityId;
  title: string;
  status?: OutputGap["status"] | string;
  priority?: OutputGap["priority"] | string;
  gapType?: OutputGap["gapType"] | string;
  relationSource: OutputGapFeedbackRelationSource;
  linkedAt?: string;
  outputGap: EntitySummary;
  pendingFeedbackCardCount: number;
  warning?: string;
};

export type OutputGapFeedbackSummary = {
  outputGapId: EntityId;
  outputGap?: OutputGap;
  tasks: OutputGapFeedbackTargetSummary[];
  routeNodes: OutputGapFeedbackTargetSummary[];
  counts: {
    total: number;
    tasks: number;
    routeNodes: number;
    entityLinks: number;
    fallbackFields: number;
    missingTargets: number;
    pendingFeedbackCards: number;
  };
  warnings: string[];
  hasFeedback: boolean;
};

export type PlanningOutputGapFeedbackSummary = {
  targetType: OutputGapFeedbackTargetType;
  targetId: EntityId;
  outputGaps: OutputGapFeedbackGapSummary[];
  counts: {
    total: number;
    open: number;
    resolved: number;
    missingTargets: number;
    pendingFeedbackCards: number;
  };
  warnings: string[];
};

function isOpenGap(status?: string) {
  return status !== "resolved" && status !== "abandoned";
}

function sourceFromRouteRelation(relationType?: string): OutputGapFeedbackRelationSource {
  return relationType === "relatedRouteNodeIdFallback"
    ? "relatedRouteNodeIdFallback"
    : relationType
      ? "entityLink"
      : "none";
}

function relationSourceCount(
  values: OutputGapFeedbackRelationSource[],
  predicate: (value: OutputGapFeedbackRelationSource) => boolean
) {
  return values.filter(predicate).length;
}

function targetFromTaskSummary(
  task: EntitySummary,
  summary: OutputGapTaskSummary,
  pendingFeedbackCardCount = 0
): OutputGapFeedbackTargetSummary {
  return {
    targetType: "task",
    targetId: task.entityId,
    title: task.title,
    status: task.status,
    relationType: summary.relationSummaries[0]?.relationType
      ? String(summary.relationSummaries[0].relationType)
      : undefined,
    linkedAt: summary.relationSummaries[0]?.createdAt ?? task.updatedAt,
    relationSource: summary.relationSource,
    sourceAvailable: task.sourceAvailable,
    pendingFeedbackCardCount,
    warning: summary.warning
  };
}

function targetFromRouteSummary(
  routeNode: OutputGapRouteNodeSummary,
  pendingFeedbackCardCount = 0
): OutputGapFeedbackTargetSummary {
  return {
    targetType: "routeNode",
    targetId: routeNode.routeNodeId,
    title: routeNode.title,
    status: routeNode.status,
    relationType: routeNode.relationType,
    linkedAt: routeNode.linkedAt,
    relationSource: sourceFromRouteRelation(routeNode.relationType),
    sourceAvailable: routeNode.routeNode.sourceAvailable,
    pendingFeedbackCardCount,
    warning: routeNode.routeNode.sourceAvailable
      ? undefined
      : routeNode.routeNode.missingReason ?? "Planning target is unavailable."
  };
}

async function gapFromTaskSummary(summary: OutputGapTaskSummary): Promise<OutputGapFeedbackGapSummary> {
  const cardSummary = await getOutputGapFeedbackCardSummary(summary.outputGap.entityId);
  return {
    outputGapId: summary.outputGap.entityId,
    title: summary.outputGap.title,
    status: summary.status ?? summary.outputGap.status,
    priority: summary.priority,
    relationSource: summary.relationSource,
    linkedAt: summary.relationSummaries[0]?.createdAt ?? summary.outputGap.updatedAt,
    outputGap: summary.outputGap,
    pendingFeedbackCardCount: cardSummary.counts.pending,
    warning: summary.warning
  };
}

async function gapFromRouteSummary(summary: RouteNodeOutputGapSummary): Promise<OutputGapFeedbackGapSummary> {
  const cardSummary = await getOutputGapFeedbackCardSummary(summary.outputGapId);
  return {
    outputGapId: summary.outputGapId,
    title: summary.title,
    status: summary.status,
    priority: summary.priority,
    gapType: summary.gapType,
    relationSource: sourceFromRouteRelation(summary.relationType),
    linkedAt: summary.linkedAt,
    outputGap: summary.outputGap,
    pendingFeedbackCardCount: cardSummary.counts.pending,
    warning: summary.outputGap.sourceAvailable
      ? undefined
      : summary.outputGap.missingReason ?? "OutputGap is unavailable."
  };
}

function uniqueTargets(targets: OutputGapFeedbackTargetSummary[]) {
  const byKey = new Map<string, OutputGapFeedbackTargetSummary>();
  for (const target of targets) {
    const key = `${target.targetType}:${target.targetId}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      ...target,
      relationSource:
        existing && existing.relationSource !== target.relationSource
          ? "mixed"
          : target.relationSource,
      warning: [existing?.warning, target.warning].filter(Boolean).join(" ") || undefined
    });
  }
  return [...byKey.values()];
}

function uniqueGaps(gaps: OutputGapFeedbackGapSummary[]) {
  const byKey = new Map<string, OutputGapFeedbackGapSummary>();
  for (const gap of gaps) {
    const existing = byKey.get(gap.outputGapId);
    byKey.set(gap.outputGapId, {
      ...gap,
      relationSource:
        existing && existing.relationSource !== gap.relationSource
          ? "mixed"
          : gap.relationSource,
      warning: [existing?.warning, gap.warning].filter(Boolean).join(" ") || undefined
    });
  }
  return [...byKey.values()];
}

export async function getOutputGapFeedbackSummary(
  outputGapId: EntityId
): Promise<OutputGapFeedbackSummary | null> {
  const [outputGap, taskSummary, routeSummary, cardSummary] = await Promise.all([
    outputConversionService.getOutputGapById(outputGapId),
    planningSelectorService.getOutputGapTaskSummary(outputGapId),
    planningSelectorService.getOutputGapRouteNodeSummaries(outputGapId),
    getOutputGapFeedbackCardSummary(outputGapId)
  ]);

  if (!outputGap) {
    return null;
  }

  const tasks = uniqueTargets(
    taskSummary?.tasks.map((task) =>
      targetFromTaskSummary(
        task,
        taskSummary,
        0
      )
    ) ?? []
  );
  const routeNodes = uniqueTargets(
    routeSummary?.routeNodes.map((routeNode) =>
      targetFromRouteSummary(
        routeNode,
        0
      )
    ) ?? []
  );
  const relationSources = [...tasks, ...routeNodes].map((target) => target.relationSource);
  const warnings = uniqueStrings([
    taskSummary?.warning,
    ...tasks.map((target) => target.warning),
    ...routeNodes.map((target) => target.warning)
  ]);

  return {
    outputGapId,
    outputGap,
    tasks,
    routeNodes,
    counts: {
      total: tasks.length + routeNodes.length,
      tasks: tasks.length,
      routeNodes: routeNodes.length,
      entityLinks: relationSourceCount(
        relationSources,
        (source) => source === "entityLink" || source === "mixed"
      ),
      fallbackFields: relationSourceCount(
        relationSources,
        (source) =>
          source === "relatedTaskIdFallback" ||
          source === "relatedRouteNodeIdFallback" ||
          source === "mixed"
      ),
      missingTargets: [...tasks, ...routeNodes].filter((target) => !target.sourceAvailable)
        .length,
      pendingFeedbackCards: cardSummary.counts.pending
    },
    warnings,
    hasFeedback: tasks.length + routeNodes.length > 0
  };
}

export async function getPlanningOutputGapFeedbackSummary(
  targetType: OutputGapFeedbackTargetType,
  targetId: EntityId
): Promise<PlanningOutputGapFeedbackSummary> {
  const rawOutputGaps =
    targetType === "task"
      ? await Promise.all(
          (await planningSelectorService.getTaskOutputGapSummaries(targetId)).outputGaps.map(
            gapFromTaskSummary
          )
        )
      : await Promise.all(
          (await planningSelectorService.getRouteNodeOutputGapSummaries(targetId)).outputGaps.map(
            gapFromRouteSummary
          )
        );
  const outputGaps = uniqueGaps(rawOutputGaps);
  return {
    targetType,
    targetId,
    outputGaps,
    counts: {
      total: outputGaps.length,
      open: outputGaps.filter((gap) => isOpenGap(gap.status)).length,
      resolved: outputGaps.filter((gap) => gap.status === "resolved").length,
      missingTargets: outputGaps.filter((gap) => !gap.outputGap.sourceAvailable).length,
      pendingFeedbackCards: outputGaps.reduce(
        (sum, gap) => sum + gap.pendingFeedbackCardCount,
        0
      )
    },
    warnings: uniqueStrings(outputGaps.map((gap) => gap.warning))
  };
}

export async function getTaskOutputGapFeedbackSummary(taskId: EntityId) {
  return getPlanningOutputGapFeedbackSummary("task", taskId);
}

export async function getRouteNodeOutputGapFeedbackSummary(routeNodeId: EntityId) {
  return getPlanningOutputGapFeedbackSummary("routeNode", routeNodeId);
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export const outputGapFeedbackSelectorService = {
  getOutputGapFeedbackSummary,
  getPlanningOutputGapFeedbackSummary,
  getTaskOutputGapFeedbackSummary,
  getRouteNodeOutputGapFeedbackSummary
};

export type OutputGapFeedbackSelectorService = typeof outputGapFeedbackSelectorService;
