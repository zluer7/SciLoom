import type { RoutesResearchProgressData } from "../types/routesResearchProgress";

export type RoutesResearchProgressRequestToken = {
  readonly requestId: number;
  requestedProjectId: string;
};

export type RoutesResearchProgressRequestCoordinator = {
  begin: (requestedProjectId: string) => RoutesResearchProgressRequestToken;
  retarget: (token: RoutesResearchProgressRequestToken, projectId: string) => boolean;
  isCurrent: (token: RoutesResearchProgressRequestToken) => boolean;
  canCommitData: (
    token: RoutesResearchProgressRequestToken,
    data: RoutesResearchProgressData
  ) => boolean;
  getCurrentProjectId: () => string;
  activate: () => void;
  dispose: () => void;
};

export function isRoutesResearchProgressDataForProject(
  data: RoutesResearchProgressData,
  projectId: string
) {
  return (
    data.projectId === projectId &&
    data.items.every((item) => item.projectId === projectId)
  );
}

export function createRoutesResearchProgressRequestCoordinator(): RoutesResearchProgressRequestCoordinator {
  let requestVersion = 0;
  let currentProjectId = "";
  let disposed = false;

  function begin(requestedProjectId: string): RoutesResearchProgressRequestToken {
    currentProjectId = requestedProjectId;
    return {
      requestId: ++requestVersion,
      requestedProjectId
    };
  }

  function isCurrent(token: RoutesResearchProgressRequestToken) {
    return (
      !disposed &&
      token.requestId === requestVersion &&
      token.requestedProjectId === currentProjectId
    );
  }

  function retarget(token: RoutesResearchProgressRequestToken, projectId: string) {
    if (!isCurrent(token)) {
      return false;
    }
    token.requestedProjectId = projectId;
    currentProjectId = projectId;
    return true;
  }

  function canCommitData(
    token: RoutesResearchProgressRequestToken,
    data: RoutesResearchProgressData
  ) {
    return (
      isCurrent(token) &&
      isRoutesResearchProgressDataForProject(data, token.requestedProjectId)
    );
  }

  function getCurrentProjectId() {
    return currentProjectId;
  }

  function activate() {
    disposed = false;
  }

  function dispose() {
    disposed = true;
    requestVersion += 1;
    currentProjectId = "";
  }

  return {
    begin,
    retarget,
    isCurrent,
    canCommitData,
    getCurrentProjectId,
    activate,
    dispose
  };
}
