import { invoke } from "@tauri-apps/api/core";
import { getDataSourceModeSnapshot } from "../repositories/dataSourceMode";
import { entityLinkService } from "./entityLinkService";
import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { fileRefService } from "./fileRefService";
import {
  createFirstLaunchDemoProvisioner,
  type BundledDemoResource,
  type WorkspaceBusinessInventory
} from "./firstLaunchWorkspaceDemoCore";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";
import { preflightProjectImportV1 } from "./projectImportV1Authority";
import { executeProjectImportV1 } from "./projectImportV1Service";
import { recycleBinService } from "./recycleBinService";
import { resultMetricService } from "./resultMetricService";
import { writeSharedCurrentProjectSelection } from "./sharedCurrentProjectSelection";

async function readWorkspaceInventory(): Promise<WorkspaceBusinessInventory> {
  const [
    projects,
    routes,
    tasks,
    reviews,
    experiments,
    runs,
    literature,
    resultItems,
    findings,
    outputCandidates,
    outputGaps,
    researchOutputs,
    relations,
    routeCheckpoints,
    taskCheckpoints,
    routines,
    routineCheckIns,
    resultMetrics,
    fileRefs,
    recentlyDeleted
  ] = await Promise.all([
    planningService.queryProjects({ includeDeleted: true, includeArchived: true }),
    planningService.queryRouteNodes({ includeDeleted: true, includeArchived: true }),
    planningService.queryTasks({ includeDeleted: true, includeArchived: true }),
    planningService.queryReviewFirstLayerIdentities({
      includeDeleted: true,
      includeArchived: true
    }),
    experimentService.list(),
    experimentRunService.list(),
    literatureService.queryLiteratures(),
    outputConversionService.listResultItems(),
    outputConversionService.listFindings(),
    outputConversionService.listOutputCandidates(),
    outputConversionService.listOutputGaps(),
    outputService.list(),
    entityLinkService.queryEntityLinks(),
    planningService.queryRouteCheckpoints({ includeDeleted: true }),
    planningService.queryTaskCheckpoints({ includeDeleted: true }),
    planningService.queryResearchRoutines({ includeDeleted: true }),
    planningService.queryRoutineCheckIns({ includeDeleted: true }),
    resultMetricService.list(),
    fileRefService.list(),
    recycleBinService.listRecentlyDeleted()
  ]);

  return {
    projects,
    objectCounts: {
      project: projects.length,
      route: routes.length,
      task: tasks.length,
      experiment: experiments.length,
      experimentRun: runs.length,
      literature: literature.length,
      review: reviews.length,
      resultItem: resultItems.length,
      finding: findings.length,
      outputCandidate: outputCandidates.length,
      outputGap: outputGaps.length,
      researchOutput: researchOutputs.length
    },
    relationCount: relations.length,
    auxiliaryObjectCount:
      routeCheckpoints.length +
      taskCheckpoints.length +
      routines.length +
      routineCheckIns.length +
      resultMetrics.length +
      fileRefs.length,
    deletedBusinessObjectCount: recentlyDeleted.length
  };
}

async function readBundledDemoResource() {
  return invoke<BundledDemoResource>("read_bundled_demo_project_import");
}

export const firstLaunchWorkspaceDemoService = createFirstLaunchDemoProvisioner({
  readWorkspaceInventory,
  readBundledDemoResource,
  getDataSourceSnapshot: getDataSourceModeSnapshot,
  preflight: preflightProjectImportV1,
  execute: executeProjectImportV1,
  selectProject: writeSharedCurrentProjectSelection
});
