import { planningService } from "./planningService";
import { assertExperimentRunRelationOwnership } from "./experimentRunBusinessRules";

type Relations = { projectId: string; routeId?: string | null; taskId?: string | null };

/** Validate actual new relation intent at the canonical write boundary. */
export async function assertExperimentPlanningRelations(next: Relations, existing?: Relations) {
  if (existing && next.projectId !== existing.projectId) {
    throw new Error("Experiment project cannot be changed by ordinary update.");
  }
  const settingRoute = Boolean(next.routeId && (!existing || next.routeId !== existing.routeId));
  const settingTask = Boolean(next.taskId && (!existing || next.taskId !== existing.taskId));
  // Metadata and explicit clears preserve the other stored ID without a lookup.
  // In particular, a full form payload is not evidence of new selection intent.
  if (existing && !settingRoute && !settingTask) return;

  const [projects, routes, tasks] = await Promise.all([
    planningService.queryProjects(),
    next.routeId ? planningService.queryRouteNodes() : Promise.resolve([]),
    next.taskId ? planningService.queryTasks() : Promise.resolve([])
  ]);
  if (!projects.some((project) => project.id === next.projectId)) {
    throw new Error("Experiment project does not exist or is unavailable.");
  }
  const route = routes.find((item) => item.id === next.routeId);
  const task = tasks.find((item) => item.id === next.taskId);
  if (next.routeId && !route) {
    throw new Error("Experiment linked current Planning route is unavailable; reselect or explicitly clear it.");
  }
  if (next.taskId && !task) {
    throw new Error("Experiment linked current Planning task is unavailable; reselect or explicitly clear it.");
  }
  assertExperimentRunRelationOwnership(next.projectId, route, task);
}
