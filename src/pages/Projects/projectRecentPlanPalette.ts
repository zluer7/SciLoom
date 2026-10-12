// Calendar presentation only: assign distinct muted hues to the first six Routes.
// Sorting IDs keeps a given Route set stable across input order and view refreshes.
const routePalette = ["#6f93b5", "#739b85", "#9b8db2", "#b29b68", "#b58891", "#6a9b9d"];
const neutralRouteColor = "#829ab1";

export function buildRecentPlanRouteColors(routeIds: readonly string[]) {
  return new Map([...new Set(routeIds)].sort().map((id, index) =>
    [id, routePalette[index % routePalette.length]]));
}

export function recentPlanRouteColor(colors: ReadonlyMap<string, string>, routeId?: string) {
  return colors.get(routeId ?? "") ?? neutralRouteColor;
}
