import type {
  ImportV1ObjectType,
  ProjectImportV1PreflightPlan,
  ProjectImportV1PreflightResult
} from "./projectImportV1Authority";
import type { ProjectImportV1ExecutionOutcome } from "./projectImportV1Service";
import type { ManagedRootConfigurationSnapshot } from "./managedRootConfigService";

export const BUNDLED_DEMO_RELATIVE_PATH =
  "demo/west-lake-vinegar-fish/project-import.json" as const;
export const BUNDLED_DEMO_SHA256 =
  "C9E5D5E5465E87DD9907BD081E1C6BCCFCD6283BA8AAC2E1D4019CD59AC7AE69" as const;
export const BUNDLED_DEMO_PROJECT_TITLE =
  "西湖醋鱼关键工艺参数与品质稳定性优化研究" as const;
export const BUNDLED_DEMO_IDENTITY_TAGS = ["SciLoom Demo", "合成示例"] as const;

export const BUNDLED_DEMO_EXPECTED_OBJECT_COUNTS: Readonly<
  Record<ImportV1ObjectType, number>
> = Object.freeze({
  project: 1,
  route: 8,
  task: 11,
  experiment: 5,
  experimentRun: 6,
  literature: 4,
  review: 3,
  resultItem: 4,
  finding: 4,
  outputCandidate: 2,
  outputGap: 3,
  researchOutput: 1
});
export const BUNDLED_DEMO_EXPECTED_RELATION_COUNT = 30;

export type WorkspaceBusinessDataState =
  | "EMPTY"
  | "EXACT_DEMO_PRESENT"
  | "NONEMPTY_OTHER"
  | "UNKNOWN";

export interface WorkspaceInventoryProject {
  id: string;
  title: string;
  source?: string;
  tags?: readonly string[];
  deletedAt?: string | null;
}

export interface WorkspaceBusinessInventory {
  projects: readonly WorkspaceInventoryProject[];
  objectCounts: Readonly<Record<ImportV1ObjectType, number>>;
  relationCount: number;
  auxiliaryObjectCount: number;
  deletedBusinessObjectCount: number;
}

export interface BundledDemoResource {
  content: string;
  byteLength: number;
  sha256: string;
  relativePath: string;
  readMode: "tauri-resource" | "development-source-fallback";
}

export interface DemoDataSourceSnapshot {
  selectedMode: "auto" | "sqlite" | "localStorage";
  effectiveMode: "sqlite" | "localStorage";
}

export type FirstLaunchDemoProvisioningStatus =
  | "IMPORTED"
  | "EXISTING_DEMO_SELECTED"
  | "SKIPPED_NONEMPTY"
  | "SKIPPED_UNKNOWN"
  | "FAILED";

export interface FirstLaunchDemoProvisioningResult {
  status: FirstLaunchDemoProvisioningStatus;
  businessDataState: WorkspaceBusinessDataState;
  importAttemptCount: number;
  projectId?: string;
  technicalCode?: string;
  resource?: Omit<BundledDemoResource, "content">;
  preflightAcceptedCounts?: Readonly<Record<ImportV1ObjectType, number>>;
  executeAcceptedCounts?: Readonly<Record<ImportV1ObjectType, number>>;
  relationCount?: number;
  canContinue: true;
}

export interface FirstLaunchDemoProvisioningDependencies {
  readWorkspaceInventory(): Promise<WorkspaceBusinessInventory>;
  readBundledDemoResource(): Promise<BundledDemoResource>;
  getDataSourceSnapshot(): DemoDataSourceSnapshot;
  preflight(
    content: string,
    context: DemoDataSourceSnapshot
  ): ProjectImportV1PreflightResult;
  execute(
    plan: ProjectImportV1PreflightPlan,
    options: {
      confirmed: true;
      selectedMode: DemoDataSourceSnapshot["selectedMode"];
      effectiveMode: DemoDataSourceSnapshot["effectiveMode"];
    }
  ): Promise<ProjectImportV1ExecutionOutcome>;
  selectProject(projectId: string): void;
}

export function decideFirstLaunchWorkspaceAction(
  snapshot: ManagedRootConfigurationSnapshot
): "PROCEED" | "SELECT" | "RETRY" {
  if (
    snapshot.durableState === "CONFIGURED" &&
    snapshot.readinessState === "READY"
  ) {
    return "PROCEED";
  }
  return snapshot.durableState === "NOT_CONFIGURED" ? "SELECT" : "RETRY";
}

function stableTechnicalCode(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.trim().slice(0, 240) || "LP15_B2_UNKNOWN_FAILURE";
}

function countsMatch(
  actual: Readonly<Record<ImportV1ObjectType, number>>,
  expected: Readonly<Record<ImportV1ObjectType, number>> =
    BUNDLED_DEMO_EXPECTED_OBJECT_COUNTS
) {
  return (Object.keys(expected) as ImportV1ObjectType[]).every(
    (type) => actual[type] === expected[type]
  );
}

function isExactDemoProject(project: WorkspaceInventoryProject) {
  const tags = new Set(project.tags ?? []);
  return (
    !project.deletedAt &&
    project.source === "imported" &&
    project.title === BUNDLED_DEMO_PROJECT_TITLE &&
    BUNDLED_DEMO_IDENTITY_TAGS.every((tag) => tags.has(tag))
  );
}

export function classifyWorkspaceBusinessData(
  inventory: WorkspaceBusinessInventory
): {
  state: Exclude<WorkspaceBusinessDataState, "UNKNOWN">;
  exactDemoProjectId?: string;
} {
  const objectTotal = Object.values(inventory.objectCounts).reduce(
    (sum, count) => sum + count,
    0
  );
  const total =
    objectTotal +
    inventory.relationCount +
    inventory.auxiliaryObjectCount +
    inventory.deletedBusinessObjectCount;
  if (total === 0) return { state: "EMPTY" };

  const exactMatches = inventory.projects.filter(isExactDemoProject);
  if (
    exactMatches.length === 1 &&
    inventory.projects.length === 1 &&
    countsMatch(inventory.objectCounts) &&
    inventory.relationCount === BUNDLED_DEMO_EXPECTED_RELATION_COUNT &&
    inventory.auxiliaryObjectCount === 0 &&
    inventory.deletedBusinessObjectCount === 0
  ) {
    return {
      state: "EXACT_DEMO_PRESENT",
      exactDemoProjectId: exactMatches[0].id
    };
  }

  return { state: "NONEMPTY_OTHER" };
}

function validateResource(resource: BundledDemoResource) {
  const byteLength = new TextEncoder().encode(resource.content).byteLength;
  if (resource.relativePath !== BUNDLED_DEMO_RELATIVE_PATH) {
    throw new Error("LP15_B2_DEMO_RESOURCE_PATH_MISMATCH");
  }
  if (resource.sha256.toUpperCase() !== BUNDLED_DEMO_SHA256) {
    throw new Error("LP15_B2_DEMO_RESOURCE_HASH_MISMATCH");
  }
  if (resource.byteLength !== byteLength || resource.byteLength <= 0) {
    throw new Error("LP15_B2_DEMO_RESOURCE_LENGTH_MISMATCH");
  }
}

function validatePreflight(plan: ProjectImportV1PreflightPlan) {
  if (
    !countsMatch(plan.preview.objectCounts) ||
    plan.preview.relationCount !== BUNDLED_DEMO_EXPECTED_RELATION_COUNT ||
    plan.preview.skippedCounts.fields !== 0 ||
    plan.preview.skippedCounts.objects !== 0 ||
    plan.preview.skippedCounts.relations !== 0
  ) {
    throw new Error("LP15_B2_DEMO_PREFLIGHT_COUNT_MISMATCH");
  }
}

function validateExecution(outcome: ProjectImportV1ExecutionOutcome) {
  if (
    outcome.status !== "success" ||
    !outcome.project ||
    !countsMatch(outcome.createdCounts) ||
    outcome.createdRelationCount !== BUNDLED_DEMO_EXPECTED_RELATION_COUNT
  ) {
    throw new Error(
      outcome.failedAt?.message ?? "LP15_B2_DEMO_EXECUTE_COUNT_MISMATCH"
    );
  }
}

export function createFirstLaunchDemoProvisioner(
  dependencies: FirstLaunchDemoProvisioningDependencies
) {
  let settled: FirstLaunchDemoProvisioningResult | undefined;
  let inFlight: Promise<FirstLaunchDemoProvisioningResult> | undefined;
  let importAttemptCount = 0;

  async function executeOnce(): Promise<FirstLaunchDemoProvisioningResult> {
    let classified: ReturnType<typeof classifyWorkspaceBusinessData>;
    try {
      classified = classifyWorkspaceBusinessData(
        await dependencies.readWorkspaceInventory()
      );
    } catch (error) {
      return {
        status: "SKIPPED_UNKNOWN",
        businessDataState: "UNKNOWN",
        importAttemptCount,
        technicalCode: stableTechnicalCode(error),
        canContinue: true
      };
    }

    if (classified.state === "EXACT_DEMO_PRESENT") {
      dependencies.selectProject(classified.exactDemoProjectId!);
      return {
        status: "EXISTING_DEMO_SELECTED",
        businessDataState: classified.state,
        importAttemptCount,
        projectId: classified.exactDemoProjectId,
        canContinue: true
      };
    }
    if (classified.state === "NONEMPTY_OTHER") {
      return {
        status: "SKIPPED_NONEMPTY",
        businessDataState: classified.state,
        importAttemptCount,
        canContinue: true
      };
    }

    try {
      const resource = await dependencies.readBundledDemoResource();
      validateResource(resource);
      const dataSource = dependencies.getDataSourceSnapshot();
      const preflight = dependencies.preflight(resource.content, dataSource);
      if (!preflight.ok) {
        throw new Error(
          preflight.issues[0]?.code ?? "LP15_B2_DEMO_PREFLIGHT_FAILED"
        );
      }
      validatePreflight(preflight);
      importAttemptCount += 1;
      const outcome = await dependencies.execute(preflight, {
        confirmed: true,
        selectedMode: dataSource.selectedMode,
        effectiveMode: dataSource.effectiveMode
      });
      validateExecution(outcome);
      dependencies.selectProject(outcome.project!.id);
      return {
        status: "IMPORTED",
        businessDataState: "EMPTY",
        importAttemptCount,
        projectId: outcome.project!.id,
        resource: {
          byteLength: resource.byteLength,
          sha256: resource.sha256,
          relativePath: resource.relativePath,
          readMode: resource.readMode
        },
        preflightAcceptedCounts: { ...preflight.preview.objectCounts },
        executeAcceptedCounts: { ...outcome.createdCounts },
        relationCount: outcome.createdRelationCount,
        canContinue: true
      };
    } catch (error) {
      return {
        status: "FAILED",
        businessDataState: "EMPTY",
        importAttemptCount,
        technicalCode: stableTechnicalCode(error),
        canContinue: true
      };
    }
  }

  return {
    run() {
      if (settled) return Promise.resolve(settled);
      if (inFlight) return inFlight;
      inFlight = executeOnce().then((result) => {
        settled = result;
        return result;
      });
      return inFlight;
    }
  };
}
