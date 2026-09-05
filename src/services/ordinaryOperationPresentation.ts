export type OrdinaryOperationTerminalClass =
  | "SUCCESS_CHANGED"
  | "SUCCESS_NO_OP"
  | "FAILURE_EXPECTED"
  | "FAILURE_UNEXPECTED";

export interface OrdinaryOperationTerminal {
  operationType: "save" | "reload" | "discard" | "close";
  terminalClass: OrdinaryOperationTerminalClass;
  rawStatus: string;
  failureCode?: string;
  technicalDetails?: Readonly<{
    operationId?: string;
    causeCode?: string;
    retryable?: boolean;
    recoveryRequired?: boolean;
    writeApplied?: true | false | "unknown";
  }>;
}

export type OrdinaryOperationUserMessageKey =
  | "ordinary.save.changed"
  | "ordinary.save.noOp"
  | "ordinary.save.stale"
  | "ordinary.save.readOnly"
  | "ordinary.save.unavailable"
  | "ordinary.save.activeOperation"
  | "ordinary.save.failed";

export interface OrdinaryOperationOwnerContext {
  ownerType: string;
  channel: string;
  ownerLabel?: string;
}

export interface OrdinaryOperationPresentationResult {
  terminal: OrdinaryOperationTerminal;
  handled: true;
  primaryFeedbackOwner: "shared-editor-operation-controller" | "none";
  userMessageKey: OrdinaryOperationUserMessageKey;
  ownerContext: OrdinaryOperationOwnerContext;
  nextAction: "none" | "retry" | "reload" | "reopen" | "wait";
}

type CanonicalOrdinaryResult = {
  status: string;
  operationId?: string;
  error?: {
    code?: string;
    causeCode?: string;
    retryable?: boolean;
    recoveryRequired?: boolean;
    writeApplied?: true | false | "unknown";
  };
};

const STALE_CODES = new Set([
  "MANUSCRIPT_REVISION_CONFLICT",
  "MANUSCRIPT_CURRENT_CHANGED",
  "MANUSCRIPT_TARGET_CHANGED",
  "MANUSCRIPT_REQUEST_STALE"
]);

const READ_ONLY_CODES = new Set([
  "MANUSCRIPT_SESSION_READ_ONLY",
  "RUN_RAW_SAVE_PERMISSION_DENIED"
]);

const UNAVAILABLE_CODES = new Set([
  "MANUSCRIPT_SESSION_NOT_FOUND",
  "MANUSCRIPT_STALE_SESSION_HANDLE",
  "MANUSCRIPT_SESSION_IDENTITY_MISMATCH"
]);

const ACTIVE_OPERATION_CODES = new Set([
  "MANUSCRIPT_OPERATION_IN_PROGRESS"
]);

const NORMALIZED_UNEXPECTED_CODES = new Set([
  "MANUSCRIPT_UNEXPECTED_FAILURE",
  "MANUSCRIPT_INTERNAL_FAILURE"
]);

export function canonicalOrdinarySaveTerminal(
  result: CanonicalOrdinaryResult
): OrdinaryOperationTerminal {
  const failureCode = result.error?.code;
  const normalizedUnexpected = result.status === "unexpected-error" ||
    Boolean(failureCode && NORMALIZED_UNEXPECTED_CODES.has(failureCode));
  return Object.freeze({
    operationType: "save" as const,
    terminalClass: result.status === "success"
      ? "SUCCESS_CHANGED" as const
      : result.status === "no-op"
        ? "SUCCESS_NO_OP" as const
        : normalizedUnexpected
          ? "FAILURE_UNEXPECTED" as const
          : "FAILURE_EXPECTED" as const,
    rawStatus: result.status,
    ...(failureCode ? { failureCode } : {}),
    technicalDetails: Object.freeze({
      ...(result.operationId ? { operationId: result.operationId } : {}),
      ...(result.error?.causeCode ? { causeCode: result.error.causeCode } : {}),
      ...(typeof result.error?.retryable === "boolean"
        ? { retryable: result.error.retryable }
        : {}),
      ...(typeof result.error?.recoveryRequired === "boolean"
        ? { recoveryRequired: result.error.recoveryRequired }
        : {}),
      ...(result.error?.writeApplied !== undefined
        ? { writeApplied: result.error.writeApplied }
        : {})
    })
  });
}

function failurePresentation(terminal: OrdinaryOperationTerminal) {
  const code = terminal.failureCode ?? terminal.rawStatus;
  if (STALE_CODES.has(code) || terminal.rawStatus === "conflict" || terminal.rawStatus === "stale") {
    return {
      userMessageKey: "ordinary.save.stale" as const,
      nextAction: "reload" as const
    };
  }
  if (READ_ONLY_CODES.has(code) || terminal.rawStatus === "permission-denied") {
    return {
      userMessageKey: "ordinary.save.readOnly" as const,
      nextAction: "none" as const
    };
  }
  if (UNAVAILABLE_CODES.has(code) || terminal.rawStatus === "missing-session") {
    return {
      userMessageKey: "ordinary.save.unavailable" as const,
      nextAction: "reopen" as const
    };
  }
  if (ACTIVE_OPERATION_CODES.has(code)) {
    return {
      userMessageKey: "ordinary.save.activeOperation" as const,
      nextAction: "wait" as const
    };
  }
  return {
    userMessageKey: "ordinary.save.failed" as const,
    nextAction: "retry" as const
  };
}

export function presentOrdinarySaveTerminal(
  terminal: OrdinaryOperationTerminal,
  ownerContext: OrdinaryOperationOwnerContext,
  _trigger: "explicit" | "implicit" = "explicit"
): OrdinaryOperationPresentationResult {
  const feedback = terminal.terminalClass === "SUCCESS_CHANGED"
    ? {
        userMessageKey: "ordinary.save.changed" as const,
        nextAction: "none" as const
      }
    : terminal.terminalClass === "SUCCESS_NO_OP"
      ? {
          userMessageKey: "ordinary.save.noOp" as const,
          nextAction: "none" as const
        }
      : failurePresentation(terminal);
  return Object.freeze({
    terminal,
    handled: true as const,
    primaryFeedbackOwner:
      terminal.terminalClass === "SUCCESS_CHANGED" || terminal.terminalClass === "SUCCESS_NO_OP"
        ? "none" as const
        : "shared-editor-operation-controller" as const,
    userMessageKey: feedback.userMessageKey,
    ownerContext: Object.freeze({ ...ownerContext }),
    nextAction: feedback.nextAction
  });
}

export function ordinarySavePresentation(
  result: CanonicalOrdinaryResult,
  ownerContext: OrdinaryOperationOwnerContext,
  trigger: "explicit" | "implicit" = "explicit"
) {
  return presentOrdinarySaveTerminal(
    canonicalOrdinarySaveTerminal(result),
    ownerContext,
    trigger
  );
}

export function isOrdinaryOperationPresentationResult(
  value: unknown
): value is OrdinaryOperationPresentationResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OrdinaryOperationPresentationResult>;
  return candidate.handled === true &&
    Boolean(candidate.terminal) &&
    typeof candidate.terminal?.terminalClass === "string" &&
    typeof candidate.userMessageKey === "string" &&
    (candidate.primaryFeedbackOwner === "shared-editor-operation-controller" ||
      candidate.primaryFeedbackOwner === "none");
}
