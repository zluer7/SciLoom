import type {
  ActionDraftSourceTuple,
  CanonicalTargetScope,
  MountedSelectionSnapshot
} from "../types/aiDraft";

function requiredIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

function encodeIdentity(value: string): string {
  return `${value.length}:${value}`;
}

export function isExactCanonicalTargetScope(
  left: CanonicalTargetScope,
  right: CanonicalTargetScope
): boolean {
  return left.scopeKind === right.scopeKind && left.scopeId === right.scopeId;
}

export function canonicalTargetScopeKey(scope: CanonicalTargetScope): string {
  return ["project-scope-v1", scope.scopeKind, scope.scopeId]
    .map(encodeIdentity)
    .join("|");
}

export function assertCompleteActionDraftSourceTuple(
  value: ActionDraftSourceTuple
): ActionDraftSourceTuple {
  const scope = value?.canonicalBusinessScopeIdentity;
  if (
    !requiredIdentity(value?.conversationId) ||
    scope?.scopeKind !== "project" ||
    !requiredIdentity(scope.scopeId) ||
    !requiredIdentity(value?.effectiveSourceAssistantMessageId) ||
    !requiredIdentity(value?.sourceOrdinaryChatCallAttemptId) ||
    !requiredIdentity(value?.actionDraftGenerationCallAttemptId)
  ) {
    throw new Error("Action Draft canonical source context is unavailable.");
  }
  return value;
}

export function actionDraftSourceTupleKey(tuple: ActionDraftSourceTuple): string {
  const source = assertCompleteActionDraftSourceTuple(tuple);
  return [
    "action-draft-source-v1",
    source.conversationId,
    source.canonicalBusinessScopeIdentity.scopeKind,
    source.canonicalBusinessScopeIdentity.scopeId,
    source.effectiveSourceAssistantMessageId,
    source.sourceOrdinaryChatCallAttemptId,
    source.actionDraftGenerationCallAttemptId
  ].map(encodeIdentity).join("|");
}

export function isExactMountedSelectionSnapshot(
  left: MountedSelectionSnapshot,
  right: MountedSelectionSnapshot
): boolean {
  return (
    left.conversationId === right.conversationId &&
    isExactCanonicalTargetScope(left.scopeIdentity, right.scopeIdentity) &&
    left.tupleKey === right.tupleKey &&
    left.uiGeneration === right.uiGeneration
  );
}

export function mountedSelectionMatchesTuple(
  snapshot: MountedSelectionSnapshot,
  tuple: ActionDraftSourceTuple
): boolean {
  return (
    snapshot.conversationId === tuple.conversationId &&
    isExactCanonicalTargetScope(
      snapshot.scopeIdentity,
      tuple.canonicalBusinessScopeIdentity
    ) &&
    snapshot.tupleKey === actionDraftSourceTupleKey(tuple)
  );
}
