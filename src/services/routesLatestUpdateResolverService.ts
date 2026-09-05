export type RoutesLatestUpdateRoute = {
  projectId: string;
  updatedAt?: string;
  status?: string;
  captureState?: string;
  archivedAt?: string;
  deletedAt?: string | null;
};

export type RoutesLatestUpdateResult = {
  updatedAt?: string;
  displayText: string;
};

type ResolveRoutesLatestUpdatedAtInput = {
  projectId: string;
  routes: readonly RoutesLatestUpdateRoute[];
  projectUpdatedAt?: string;
  formatDate: (updatedAt: string) => string;
};

function parseValidTimestamp(value?: string) {
  if (!value?.trim()) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isCurrentProjectVisibleRoute(route: RoutesLatestUpdateRoute, projectId: string) {
  return (
    route.projectId === projectId &&
    !route.deletedAt &&
    !route.archivedAt &&
    route.status !== "archived" &&
    route.captureState !== "archived"
  );
}

export function resolveRoutesLatestUpdatedAt({
  projectId,
  routes,
  projectUpdatedAt,
  formatDate
}: ResolveRoutesLatestUpdatedAtInput): RoutesLatestUpdateResult {
  let latestRouteUpdatedAt: string | undefined;
  let latestRouteTimestamp = Number.NEGATIVE_INFINITY;

  for (const route of routes) {
    if (!isCurrentProjectVisibleRoute(route, projectId)) {
      continue;
    }

    const timestamp = parseValidTimestamp(route.updatedAt);
    if (timestamp !== undefined && timestamp > latestRouteTimestamp) {
      latestRouteUpdatedAt = route.updatedAt;
      latestRouteTimestamp = timestamp;
    }
  }

  const resolvedUpdatedAt =
    latestRouteUpdatedAt ??
    (parseValidTimestamp(projectUpdatedAt) !== undefined ? projectUpdatedAt : undefined);

  return {
    updatedAt: resolvedUpdatedAt,
    displayText: resolvedUpdatedAt ? formatDate(resolvedUpdatedAt) : "—"
  };
}
