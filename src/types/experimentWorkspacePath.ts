export type ExperimentWorkspaceOwnerType = "experiment" | "experimentRun";

export interface ProjectWorkspaceIdentity {
  projectId: string;
  folderName: string;
  absolutePath: string;
  pathIdentityKey: string;
}

export interface ExperimentWorkspacePathInput {
  managedRoot: string;
  projectWorkspace: ProjectWorkspaceIdentity;
  experimentId: string;
  createdLocalDate: string;
  createdLocalTime: string;
  creationTitleIdentity: string;
}

export interface ExperimentWorkspacePathBudget {
  unit: "windowsUtf16CodeUnit";
  rootCost: number;
  projectFolderCost: number;
  experimentBaseCost: number;
  deepestRunSuffixReserve: number;
  titleBudget: number;
  finalAbsolutePathCost: number;
  maximumAbsolutePath: number;
}

export interface ExperimentWorkspacePathDescriptor {
  ownerType: "experiment";
  ownerId: string;
  managedRoot: string;
  projectId: string;
  projectWorkspace: ProjectWorkspaceIdentity;
  createdLocalDate: string;
  createdLocalTime: string;
  stableCode: string;
  creationTitleIdentity: string;
  workspaceTitleSegment: string;
  workspaceFolderName: string;
  absolutePath: string;
  pathIdentityKey: string;
  defaultFileName: "experiment.md";
  defaultFilePath: string;
  deepestReservedFilePathLength: number;
  pathBudget: ExperimentWorkspacePathBudget;
}

export interface ExperimentRunWorkspacePathInput {
  managedRoot: string;
  projectWorkspace: ProjectWorkspaceIdentity;
  parentExperimentId: string;
  parentExperimentWorkspace: ExperimentWorkspacePathDescriptor;
  runId: string;
  createdLocalDate: string;
  createdLocalTime: string;
  creationTitleIdentity: string;
}

export interface ExperimentRunWorkspacePathDescriptor {
  ownerType: "experimentRun";
  ownerId: string;
  managedRoot: string;
  projectId: string;
  projectWorkspace: ProjectWorkspaceIdentity;
  parentExperimentId: string;
  parentExperimentWorkspaceIdentity: string;
  parentDefaultFolderIdentity: string;
  createdLocalDate: string;
  createdLocalTime: string;
  stableCode: string;
  creationTitleIdentity: string;
  workspaceTitleSegment: string;
  workspaceFolderName: string;
  absolutePath: string;
  pathIdentityKey: string;
  defaultFileName: "experiment-run.md";
  defaultFilePath: string;
  deepestFinalFilePathLength: number;
}
