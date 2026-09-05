export function resolveLiteratureMountedQuickAnalysisScope(input: {
  ownerPrimaryProjectId?: string | null;
  explicitlySelectedProjectId?: string | null;
  availableProjectIds: readonly string[];
}) {
  const canonicalOwnerProjectId = input.ownerPrimaryProjectId?.trim();
  if (canonicalOwnerProjectId) return canonicalOwnerProjectId;

  const selectedProjectId = input.explicitlySelectedProjectId?.trim();
  if (!selectedProjectId) return undefined;
  return input.availableProjectIds.some((projectId) => projectId === selectedProjectId)
    ? selectedProjectId
    : undefined;
}

export function preserveProjectlessPreferredLiteratureForMountedQuickScope<
  T extends { id: string; primaryProjectId?: string | null }
>(input: {
  scopedRows: readonly T[];
  unscopedMatchingRows: readonly T[];
  preferredLiteratureId?: string | null;
  explicitlySelectedProjectId?: string | null;
  availableProjectIds: readonly string[];
}) {
  const preferredLiteratureId = input.preferredLiteratureId?.trim();
  const validatedScopeId = resolveLiteratureMountedQuickAnalysisScope({
    explicitlySelectedProjectId: input.explicitlySelectedProjectId,
    availableProjectIds: input.availableProjectIds
  });
  if (!preferredLiteratureId || !validatedScopeId) return [...input.scopedRows];

  const preferred = input.unscopedMatchingRows.find((row) =>
    row.id === preferredLiteratureId && !row.primaryProjectId?.trim()
  );
  if (!preferred || input.scopedRows.some((row) => row.id === preferred.id)) {
    return [...input.scopedRows];
  }
  return [preferred, ...input.scopedRows];
}
