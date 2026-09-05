import type {
  AffectedEntity,
  AffectedScope,
  RefreshKey,
  WriteFeedbackMessage,
  WriteFeedbackResult,
  WriteFeedbackResultInput,
  WriteFeedbackSeverity,
  WriteFeedbackStatus
} from "../types/writeFeedback";

export interface NormalizeWriteFeedbackOptions<T = unknown> {
  operation: string;
  successMessage?: string;
  skippedMessage?: string;
  data?: T;
  affectedEntities?: AffectedEntity[];
  affectedScopes?: AffectedScope[];
  refreshKeys?: RefreshKey[];
  warnings?: string[];
  errors?: string[];
  skipped?: string[];
  voidIsSuccess?: boolean;
}

function now() {
  return new Date().toISOString();
}

function entityKey(entity: AffectedEntity) {
  return [entity.type, entity.id, entity.relation ?? ""].join(":");
}

function scopeKey(scope: AffectedScope) {
  return [
    scope.module,
    scope.projectId ?? "",
    scope.routeNodeId ?? "",
    scope.taskId ?? "",
    scope.reviewId ?? "",
    scope.experimentId ?? "",
    scope.literatureId ?? "",
    scope.outputGapId ?? "",
    scope.outputCandidateId ?? "",
    scope.researchOutputId ?? "",
    scope.reason ?? ""
  ].join(":");
}

export function dedupeRefreshKeys(keys: RefreshKey[] = []): RefreshKey[] {
  return [...new Set(keys.filter(Boolean))];
}

export function dedupeAffectedEntities(entities: AffectedEntity[] = []): AffectedEntity[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    if (!entity.id) return false;
    const key = entityKey(entity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dedupeAffectedScopes(scopes: AffectedScope[] = []): AffectedScope[] {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = scopeKey(scope);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toWriteFeedbackMessage(
  message: string,
  severity: WriteFeedbackSeverity = "info",
  code?: string
): WriteFeedbackMessage {
  return {
    severity,
    message,
    code
  };
}

export function createWriteFeedbackResult<T = unknown>(
  input: WriteFeedbackResultInput<T>
): WriteFeedbackResult<T> {
  const warnings = [...(input.warnings ?? [])];
  const errors = [...(input.errors ?? [])];
  const skipped = [...(input.skipped ?? [])];
  const missingReferences = [...(input.missingReferences ?? [])];
  let status = input.status ?? "success";
  if (errors.length > 0) {
    status = "error";
  } else if (
    status === "success" &&
    (input.partial || warnings.length > 0 || missingReferences.length > 0)
  ) {
    status = "partial";
  } else if (status === "success" && skipped.length > 0) {
    status =
      input.data !== undefined || (input.affectedEntities?.length ?? 0) > 0
        ? "partial"
        : "skipped";
  }
  return {
    status,
    operation: input.operation,
    data: input.data,
    affectedEntities: dedupeAffectedEntities(input.affectedEntities),
    affectedScopes: dedupeAffectedScopes(input.affectedScopes),
    refreshKeys: dedupeRefreshKeys(input.refreshKeys),
    messages: [...(input.messages ?? [])],
    warnings,
    errors,
    skipped,
    partial: status === "partial" || input.partial === true,
    missingReferences,
    createdAt: input.createdAt ?? now()
  };
}

export function createSuccessWriteFeedback<T = unknown>(
  input: Omit<WriteFeedbackResultInput<T>, "status">
) {
  return createWriteFeedbackResult({ ...input, status: "success" });
}

export function createSkippedWriteFeedback<T = unknown>(
  input: Omit<WriteFeedbackResultInput<T>, "status">
) {
  return createWriteFeedbackResult({ ...input, status: "skipped" });
}

export function createPartialWriteFeedback<T = unknown>(
  input: Omit<WriteFeedbackResultInput<T>, "status">
) {
  return createWriteFeedbackResult({ ...input, status: "partial", partial: true });
}

export function createErrorWriteFeedback<T = unknown>(
  input: Omit<WriteFeedbackResultInput<T>, "status">
) {
  return createWriteFeedbackResult({ ...input, status: "error" });
}

function mergeStatus(results: WriteFeedbackResult[]): WriteFeedbackStatus {
  const statuses = results.map((result) => result.status);
  if (statuses.includes("error")) return "error";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("skipped") && statuses.includes("success")) return "partial";
  if (statuses.includes("skipped")) return "skipped";
  return "success";
}

export function mergeWriteFeedbackResults<T = unknown>(
  operation: string,
  results: WriteFeedbackResult[],
  data?: T
): WriteFeedbackResult<T> {
  const status = mergeStatus(results);
  return createWriteFeedbackResult({
    status,
    operation,
    data,
    affectedEntities: results.flatMap((result) => result.affectedEntities),
    affectedScopes: results.flatMap((result) => result.affectedScopes),
    refreshKeys: results.flatMap((result) => result.refreshKeys),
    messages: results.flatMap((result) => result.messages),
    warnings: results.flatMap((result) => result.warnings),
    errors: results.flatMap((result) => result.errors),
    skipped: results.flatMap((result) => result.skipped),
    partial: status === "partial" || results.some((result) => result.partial),
    missingReferences: results.flatMap((result) => result.missingReferences ?? [])
  });
}

export function addWriteFeedbackWarning<T>(
  feedback: WriteFeedbackResult<T>,
  message: string,
  code?: string
): WriteFeedbackResult<T> {
  return createWriteFeedbackResult({
    ...feedback,
    status: feedback.status === "success" ? "partial" : feedback.status,
    partial: true,
    warnings: [...feedback.warnings, message],
    messages: [...feedback.messages, toWriteFeedbackMessage(message, "warning", code)]
  });
}

export function addWriteFeedbackError<T>(
  feedback: WriteFeedbackResult<T>,
  message: string,
  code?: string
): WriteFeedbackResult<T> {
  return createWriteFeedbackResult({
    ...feedback,
    status: "error",
    errors: [...feedback.errors, message],
    messages: [...feedback.messages, toWriteFeedbackMessage(message, "error", code)]
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hasDomainProgress(value: Record<string, unknown>) {
  const diagnosticKeys = new Set([
    "status",
    "operation",
    "warnings",
    "errors",
    "skipped",
    "messages",
    "missingReferences",
    "partial"
  ]);
  return Object.entries(value).some(([key, item]) => {
    if (diagnosticKeys.has(key) || item === null || item === undefined || item === false) {
      return false;
    }
    if (item === true) return true;
    if (Array.isArray(item)) return item.length > 0;
    return typeof item === "object" && /^(created|resolved)/i.test(key);
  });
}

export function isWriteFeedbackResult(value: unknown): value is WriteFeedbackResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.operation === "string" &&
    (value.status === "success" ||
      value.status === "skipped" ||
      value.status === "partial" ||
      value.status === "error") &&
    Array.isArray(value.affectedEntities) &&
    Array.isArray(value.affectedScopes) &&
    Array.isArray(value.refreshKeys) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.warnings) &&
    Array.isArray(value.errors) &&
    Array.isArray(value.skipped)
  );
}

export function normalizeWriteFeedbackResult<T = unknown>(
  result: T | WriteFeedbackResult<T>,
  options: NormalizeWriteFeedbackOptions<T>
): WriteFeedbackResult<T> {
  if (isWriteFeedbackResult(result)) {
    const normalized = createWriteFeedbackResult({
      ...result,
      operation: result.operation || options.operation,
      affectedEntities: [...result.affectedEntities, ...(options.affectedEntities ?? [])],
      affectedScopes: [...result.affectedScopes, ...(options.affectedScopes ?? [])],
      refreshKeys: [...result.refreshKeys, ...(options.refreshKeys ?? [])],
      warnings: [...result.warnings, ...(options.warnings ?? [])],
      errors: [...result.errors, ...(options.errors ?? [])],
      skipped: [...result.skipped, ...(options.skipped ?? [])],
      messages: result.messages
    });
    return normalized.status === "success" && options.successMessage
      ? createWriteFeedbackResult({
          ...normalized,
          messages: [
            ...normalized.messages,
            toWriteFeedbackMessage(options.successMessage, "success")
          ]
        })
      : normalized;
  }

  const domainResult = isRecord(result) ? result : undefined;
  if (domainResult && isWriteFeedbackResult(domainResult.feedback)) {
    return normalizeWriteFeedbackResult(domainResult.feedback as WriteFeedbackResult<T>, {
      ...options,
      data: options.data ?? (result as T)
    });
  }
  const domainAffectedEntities = Array.isArray(domainResult?.affectedEntities)
    ? (domainResult.affectedEntities as AffectedEntity[])
    : [];
  const domainAffectedScopes = Array.isArray(domainResult?.affectedScopes)
    ? (domainResult.affectedScopes as AffectedScope[])
    : [];
  const domainRefreshKeys = Array.isArray(domainResult?.refreshKeys)
    ? (domainResult.refreshKeys as RefreshKey[])
    : [];
  const domainMissingReferences = Array.isArray(domainResult?.missingReferences)
    ? (domainResult.missingReferences as NonNullable<
        WriteFeedbackResult["missingReferences"]
      >)
    : [];
  const warnings = [
    ...stringArray(domainResult?.warnings),
    ...(options.warnings ?? [])
  ];
  const errors = [...stringArray(domainResult?.errors), ...(options.errors ?? [])];
  const skipped = [...stringArray(domainResult?.skipped), ...(options.skipped ?? [])];
  const domainPartial = domainResult?.partial === true;
  const madeProgress = domainResult ? hasDomainProgress(domainResult) : result !== false;
  const declaredStatus = domainResult?.status;
  let status: WriteFeedbackStatus =
    declaredStatus === "success" ||
    declaredStatus === "skipped" ||
    declaredStatus === "partial" ||
    declaredStatus === "error"
      ? declaredStatus
      : "success";

  if (errors.length > 0) {
    status = "error";
  } else if (
    skipped.length > 0 &&
    !madeProgress &&
    !domainPartial &&
    declaredStatus !== "partial"
  ) {
    status = "skipped";
  } else if (domainPartial || warnings.length > 0 || (skipped.length > 0 && madeProgress)) {
    status = "partial";
  } else if (
    result === false ||
    skipped.length > 0 ||
    (result === undefined && options.voidIsSuccess === false)
  ) {
    status = "skipped";
  }

  const statusMessage =
    status === "success"
      ? options.successMessage
      : status === "skipped"
        ? options.skippedMessage
        : undefined;

  return createWriteFeedbackResult({
    status,
    operation: options.operation,
    data: options.data ?? (result as T),
    affectedEntities: [...domainAffectedEntities, ...(options.affectedEntities ?? [])],
    affectedScopes: [...domainAffectedScopes, ...(options.affectedScopes ?? [])],
    refreshKeys: [...domainRefreshKeys, ...(options.refreshKeys ?? [])],
    warnings,
    errors,
    skipped:
      status === "skipped" && skipped.length === 0
        ? [options.skippedMessage ?? `${options.operation} did not write data.`]
        : skipped,
    partial: domainPartial || status === "partial",
    missingReferences: domainMissingReferences,
    messages: statusMessage
      ? [
          toWriteFeedbackMessage(
            statusMessage,
            status === "success" ? "success" : "warning"
          )
        ]
      : []
  });
}

export function normalizeWriteFeedbackError(
  error: unknown,
  operation: string
): WriteFeedbackResult {
  const message = error instanceof Error ? error.message : String(error);
  return createErrorWriteFeedback({
    operation,
    errors: [message],
    messages: [toWriteFeedbackMessage(message, "error")]
  });
}
