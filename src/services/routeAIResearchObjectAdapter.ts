import type {
  AIContextExcludedItem,
  AIContextItem,
  AIContextMode,
  AIContextRequestableRef,
  AIContextSourceRef,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import { planningService } from "./planningService";

export class RouteResearchObjectResolutionError extends Error {
  constructor(
    public readonly code:
      | "ROUTE_NOT_FOUND"
      | "ROUTE_UNAVAILABLE"
      | "ROUTE_PROJECT_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "RouteResearchObjectResolutionError";
  }
}

export async function resolveRouteResearchObjectDescriptor(
  routeNodeId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const routeNode = await planningService.getRouteNodeById(routeNodeId);
  if (!routeNode) {
    throw new RouteResearchObjectResolutionError(
      "ROUTE_NOT_FOUND",
      `Selected Route is missing or no longer active: ${routeNodeId}`
    );
  }
  if (routeNode.status === "archived" || routeNode.captureState === "archived" || Boolean(routeNode.archivedAt)) {
    throw new RouteResearchObjectResolutionError(
      "ROUTE_UNAVAILABLE",
      `Selected Route is archived and unavailable for new AI context: ${routeNodeId}`
    );
  }
  if (routeNode.projectId !== expectedProjectId) {
    throw new RouteResearchObjectResolutionError(
      "ROUTE_PROJECT_MISMATCH",
      `Selected Route ${routeNodeId} does not belong to Project ${expectedProjectId}.`
    );
  }

  return {
    objectType: "route",
    objectId: routeNode.id,
    projectId: routeNode.projectId,
    label: routeNode.title,
    description: routeNode.description,
    sourceRef: {
      module: "route",
      entityType: "routeNode",
      entityId: routeNode.id,
      label: routeNode.title,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      status: routeNode.status,
      nodeType: routeNode.nodeType,
      expectedOutput: routeNode.expectedOutput ?? null,
      timePrecision: routeNode.timePrecision ?? null,
      parentNodeId: routeNode.parentNodeId ?? null,
      startDate: routeNode.startDate ?? null,
      endDate: routeNode.endDate ?? null,
      updatedAt: routeNode.updatedAt
    },
    ownerModule: "route",
    channel: "global_chat"
  };
}

export async function listRouteResearchObjectDescriptors(
  projectId: string
): Promise<AIResearchObjectDescriptor[]> {
  const routeNodes = await planningService.queryRouteNodes({ projectId });
  return Promise.all(routeNodes.map((routeNode) => (
    resolveRouteResearchObjectDescriptor(routeNode.id, projectId)
  )));
}

export type RouteResearchObjectContextCandidates = {
  primary: AIContextItem;
  related: AIContextItem[];
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

function routeSourceRef(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode
): AIContextSourceRef {
  return {
    ...descriptor.sourceRef,
    contextMode: mode,
    contextLevel: 1,
    contextRole: "primary",
    contextDisposition: "included"
  };
}

export async function buildRouteResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  stableOrder: number
): Promise<RouteResearchObjectContextCandidates> {
  const current = await resolveRouteResearchObjectDescriptor(
    descriptor.objectId,
    descriptor.projectId
  );
  const status = typeof current.safeMetadata?.status === "string"
    ? current.safeMetadata.status
    : "unknown";
  const expectedOutput = typeof current.safeMetadata?.expectedOutput === "string"
    ? current.safeMetadata.expectedOutput.trim()
    : "";
  const nodeType = typeof current.safeMetadata?.nodeType === "string"
    ? current.safeMetadata.nodeType.trim()
    : "";
  const timePrecision = typeof current.safeMetadata?.timePrecision === "string"
    ? current.safeMetadata.timePrecision.trim()
    : "";
  const time = [current.safeMetadata?.startDate, current.safeMetadata?.endDate]
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .join(" → ");
  const summary = mode === "MINIMAL"
    ? "Selected Route identity."
    : [
        current.description,
        `Status: ${status}`,
        expectedOutput ? `Expected output: ${expectedOutput}` : undefined,
        nodeType ? `Node type: ${nodeType}` : undefined,
        timePrecision ? `Time precision: ${timePrecision}` : undefined,
        time ? `Time: ${time}` : undefined
      ].filter(Boolean).join(" | ");
  const sourceRef = routeSourceRef(current, mode);
  return {
    primary: {
      id: `route:${current.objectId}:primary`,
      title: current.label,
      summary: summary || current.label,
      module: "route",
      entityType: "routeNode",
      sourceRefs: [sourceRef],
      priority: "critical",
      contextLevel: 1,
      protectedFromContextBudget: true,
      stableOrder,
      charCount: current.label.length + summary.length,
      sendable: true,
      truncated: false,
      metadata: {
        status,
        ...(expectedOutput ? { expectedOutput } : {}),
        ...(nodeType ? { nodeType } : {}),
        ...(timePrecision ? { timePrecision } : {})
      }
    },
    related: [],
    excluded: [],
    warnings: [],
    requestableRefs: []
  };
}
