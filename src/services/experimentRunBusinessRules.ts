type RelationId = string;

type ParentRunRelations = {
  projectId: RelationId;
  routeId?: RelationId | null;
  taskId?: RelationId | null;
};

type StoredRunRelations = {
  projectId: RelationId;
  routeId?: RelationId | null;
  taskId?: RelationId | null;
};

type RunRelationPatch = {
  routeId?: RelationId | null;
  taskId?: RelationId | null;
};

type RouteRelation = { id: RelationId; projectId: RelationId };
type TaskRelation = { id: RelationId; projectId: RelationId; routeNodeId?: RelationId | null };

export function assertExperimentRunCreateIdentity(input: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(input, "projectId")) {
    throw new Error("ExperimentRun project is determined by the parent experiment at creation.");
  }
}

export function assertExperimentRunUpdateIdentity(patch: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(patch, "experimentId")) {
    throw new Error("ExperimentRun parent experiment cannot be changed by ordinary update.");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "projectId")) {
    throw new Error("ExperimentRun project is fixed by the parent experiment.");
  }
}

export function assertExperimentRunRelationOwnership(
  parentProjectId: RelationId,
  route: RouteRelation | undefined,
  task: TaskRelation | undefined
) {
  if (task && task.projectId !== parentProjectId) {
    throw new Error("ExperimentRun linked task must belong to the parent experiment project.");
  }
  if (route && route.projectId !== parentProjectId) {
    throw new Error("ExperimentRun linked route must belong to the parent experiment project.");
  }
  if (task?.routeNodeId && route && task.routeNodeId !== route.id) {
    throw new Error("ExperimentRun linked task route conflicts with the selected route.");
  }
}

export function resolveExperimentRunCreateRelations(
  parent: ParentRunRelations,
  input: RunRelationPatch
) {
  return {
    projectId: parent.projectId,
    routeId: input.routeId !== undefined ? input.routeId : parent.routeId ?? null,
    taskId: input.taskId !== undefined ? input.taskId : parent.taskId ?? null
  };
}

export function resolveExperimentRunUpdateRelations(
  existing: StoredRunRelations,
  patch: RunRelationPatch,
  parent: ParentRunRelations
) {
  assertExperimentRunUpdateIdentity(patch as Record<string, unknown>);
  if (existing.projectId !== parent.projectId) {
    throw new Error("ExperimentRun project does not match the parent experiment project.");
  }
  return {
    projectId: parent.projectId,
    routeId: patch.routeId !== undefined ? patch.routeId : existing.routeId ?? null,
    taskId: patch.taskId !== undefined ? patch.taskId : existing.taskId ?? null
  };
}
