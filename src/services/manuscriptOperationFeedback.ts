import type {
  ManuscriptOperationFeedback,
  ManuscriptOperationResult
} from "../types/manuscriptOperation";

export function createManuscriptOperationFeedback(
  result: ManuscriptOperationResult<unknown>
): ManuscriptOperationFeedback {
  const status = result.status;
  const severity = status === "success"
    ? "success"
    : status === "error" ||
        status === "recovery-required" ||
        status === "write-applied-readback-failed"
      ? "error"
      : status === "warning" || status === "conflict"
        ? "warning"
        : "info";
  return {
    severity,
    titleKey: `manuscript.operation.${result.operation}.${status}.title`,
    messageKey: result.error
      ? `manuscript.error.${result.error.code}`
      : `manuscript.operation.${result.operation}.${status}.message`,
    retryable: result.error?.retryable ?? false,
    recoveryRequired: result.error?.recoveryRequired ?? false
  };
}
