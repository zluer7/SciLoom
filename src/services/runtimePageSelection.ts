// IDs only, scoped to this JavaScript runtime. Never persist facts or selection.
const selections = new Map<string, string>();

function key(page: "reviews" | "outputs", projectId: string, layer = "") {
  return JSON.stringify([page, projectId, layer]);
}

export const runtimePageSelection = {
  read(page: "reviews" | "outputs", projectId: string, layer = "") {
    return selections.get(key(page, projectId, layer)) ?? null;
  },
  remember(page: "reviews" | "outputs", projectId: string, id: string | null, layer = "") {
    if (!projectId) return;
    const scope = key(page, projectId, layer);
    if (id) selections.set(scope, id);
    else selections.delete(scope);
  }
};
