import type { AIErrorCode } from "../types";

export const AI_DURABLE_SETTLEMENT_ERROR_CODE =
  "ai_durable_settlement_validation_failed" as const satisfies AIErrorCode;

export type AIDurableSettlementStage =
  | "STANDARD_RESULT_VALIDATION"
  | "CONTEXT_REQUEST_VALIDATION"
  | "CALL_ATTEMPT_SUCCESS_VALIDATION"
  | "CALL_ATTEMPT_SUCCESS_TERMINALIZATION"
  | "SQLITE_SUCCESS_TRANSACTION"
  | "AUTHORITATIVE_READBACK"
  | "SUCCESS_SETTLEMENT";

export type AIDurableSettlementCauseClass =
  | "VALIDATOR_REJECTION"
  | "TERMINAL_CONFLICT"
  | "SQLITE_CONSTRAINT_OR_TRANSACTION"
  | "SQLITE_READ"
  | "AUTHORITATIVE_READBACK_FAILURE"
  | "UNCLASSIFIED_SAFE_REJECTION";

export interface SanitizedAIDurableSettlementCause {
  errorCode: typeof AI_DURABLE_SETTLEMENT_ERROR_CODE;
  causeCode: string;
  stage: AIDurableSettlementStage;
  causeClass: AIDurableSettlementCauseClass;
  detail: string;
  durableMessage: string;
}

const STRUCTURED_CAUSE_PATTERN = /^code=([A-Z][A-Z0-9_]{1,119})\s+message=([\s\S]*)$/u;

const SAFE_CAUSE_OWNERS = new Map<string, {
  stage: AIDurableSettlementStage;
  causeClass: AIDurableSettlementCauseClass;
}>([
  ["AI_STANDARD_RESULT_INVALID", {
    stage: "STANDARD_RESULT_VALIDATION",
    causeClass: "VALIDATOR_REJECTION"
  }],
  ["AI_CONTEXT_REQUEST_INVALID", {
    stage: "CONTEXT_REQUEST_VALIDATION",
    causeClass: "VALIDATOR_REJECTION"
  }],
  ["AI_DURABLE_INPUT_INVALID", {
    stage: "CALL_ATTEMPT_SUCCESS_VALIDATION",
    causeClass: "VALIDATOR_REJECTION"
  }],
  ["AI_DURABLE_TRIGGER_INVALID", {
    stage: "CALL_ATTEMPT_SUCCESS_VALIDATION",
    causeClass: "VALIDATOR_REJECTION"
  }],
  ["AI_PARSE_DRAFT_SOURCE_INVALID", {
    stage: "STANDARD_RESULT_VALIDATION",
    causeClass: "VALIDATOR_REJECTION"
  }],
  ["AI_PARSE_DRAFT_TRIGGER_INVALID", {
    stage: "STANDARD_RESULT_VALIDATION",
    causeClass: "VALIDATOR_REJECTION"
  }],
  ["AI_DURABLE_TERMINAL_CONFLICT", {
    stage: "CALL_ATTEMPT_SUCCESS_TERMINALIZATION",
    causeClass: "TERMINAL_CONFLICT"
  }],
  ["AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED", {
    stage: "SQLITE_SUCCESS_TRANSACTION",
    causeClass: "SQLITE_CONSTRAINT_OR_TRANSACTION"
  }],
  ["AI_DURABLE_WRITE_FAILED", {
    stage: "SQLITE_SUCCESS_TRANSACTION",
    causeClass: "SQLITE_CONSTRAINT_OR_TRANSACTION"
  }],
  ["AI_STANDARD_RESULT_WRITE_FAILED", {
    stage: "SQLITE_SUCCESS_TRANSACTION",
    causeClass: "SQLITE_CONSTRAINT_OR_TRANSACTION"
  }],
  ["AI_DURABLE_READ_FAILED", {
    stage: "AUTHORITATIVE_READBACK",
    causeClass: "SQLITE_READ"
  }],
  ["AI_CALL_ATTEMPT_TERMINAL_READBACK_FAILED", {
    stage: "AUTHORITATIVE_READBACK",
    causeClass: "AUTHORITATIVE_READBACK_FAILURE"
  }]
]);

const SAFE_VALIDATOR_DETAILS = new Map<string, string>([
  [
    "A Standard Result batch must contain between one and eight results",
    "STANDARD_RESULT_BATCH_CARDINALITY_MISMATCH"
  ],
  [
    "Standard Result identities and ordinals must be unique and contiguous",
    "STANDARD_RESULT_IDENTITY_OR_ORDINAL_MISMATCH"
  ],
  [
    "Standard Result category/action pair is outside the shared contract",
    "STANDARD_RESULT_CATEGORY_ACTION_MISMATCH"
  ],
  [
    "Standard Results must use an exact canonical Task, Finding, Review, Experiment, ExperimentRun, Literature, or Outputs target",
    "STANDARD_RESULT_TARGET_TUPLE_MISMATCH"
  ],
  [
    "Quick Analysis Standard Results require one exact canonical owner/channel/source target",
    "QUICK_ANALYSIS_SOURCE_TARGET_MISMATCH"
  ],
  [
    "Standard Result source provenance is incomplete or mismatched",
    "STANDARD_RESULT_SOURCE_PROVENANCE_MISMATCH"
  ],
  [
    "Standard Result payloads and validation issues have invalid shapes",
    "STANDARD_RESULT_PAYLOAD_SHAPE_MISMATCH"
  ],
  [
    "Only a successful parse_draft CallAttempt may create Standard Results",
    "STANDARD_RESULT_PARSE_ATTEMPT_PURPOSE_MISMATCH"
  ],
  [
    "success output children do not match the canonical CallAttempt purpose",
    "CALL_ATTEMPT_SUCCESS_CHILD_PURPOSE_MISMATCH"
  ]
]);

function rawCause(error: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) {
    const nested = error as Error & { terminalizationCause?: unknown; cause?: unknown };
    const nestedRaw = rawCause(nested.terminalizationCause ?? nested.cause, depth + 1);
    return nestedRaw || error.message.trim();
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const nestedRaw = rawCause(record.terminalizationCause ?? record.cause, depth + 1);
    if (nestedRaw) return nestedRaw;
    if (
      typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,119}$/u.test(record.code) &&
      typeof record.message === "string"
    ) {
      return `code=${record.code} message=${record.message}`;
    }
    return typeof record.message === "string" ? record.message.trim() : "";
  }
  return "";
}

function sqliteDetail(message: string): string {
  if (/FOREIGN KEY constraint failed/iu.test(message)) return "SQLITE_FOREIGN_KEY_CONSTRAINT";
  if (/UNIQUE constraint failed/iu.test(message)) return "SQLITE_UNIQUE_CONSTRAINT";
  if (/CHECK constraint failed/iu.test(message)) return "SQLITE_CHECK_CONSTRAINT";
  if (/NOT NULL constraint failed/iu.test(message)) return "SQLITE_NOT_NULL_CONSTRAINT";
  if (/database is locked|database is busy/iu.test(message)) return "SQLITE_BUSY_OR_LOCKED";
  if (/database or disk is full/iu.test(message)) return "SQLITE_FULL";
  if (/disk I\/O error/iu.test(message)) return "SQLITE_IO_FAILURE";
  if (/database disk image is malformed/iu.test(message)) return "SQLITE_CORRUPTION_CLASS";
  return "SQLITE_TRANSACTION_FAILURE_REDACTED";
}

function validatorDetail(message: string): string {
  const exact = SAFE_VALIDATOR_DETAILS.get(message.trim());
  if (exact) return exact;
  const required = /^Standard Result ([A-Za-z][A-Za-z0-9.]{0,79}) is required$/u.exec(message.trim());
  if (required) {
    return `STANDARD_RESULT_REQUIRED_FIELD_${required[1]
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .replace(/\./gu, "_")
      .toUpperCase()}`;
  }
  return "CANONICAL_VALIDATOR_REJECTION_REDACTED";
}

function boundedToken(value: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_]{1,119}$/u.test(value) ? value : fallback;
}

export function sanitizeAIDurableSettlementCause(
  error: unknown
): SanitizedAIDurableSettlementCause {
  const raw = rawCause(error);
  const structured = STRUCTURED_CAUSE_PATTERN.exec(raw);
  const parsedCode = structured?.[1] ?? "AI_DURABLE_SETTLEMENT_UNCLASSIFIED";
  const causeCode = boundedToken(parsedCode, "AI_DURABLE_SETTLEMENT_UNCLASSIFIED");
  const owner = SAFE_CAUSE_OWNERS.get(causeCode) ?? {
    stage: "SUCCESS_SETTLEMENT" as const,
    causeClass: "UNCLASSIFIED_SAFE_REJECTION" as const
  };
  const rawMessage = structured?.[2] ?? "";
  const detail = owner.causeClass === "SQLITE_CONSTRAINT_OR_TRANSACTION" ||
    owner.causeClass === "SQLITE_READ"
    ? sqliteDetail(rawMessage)
    : owner.causeClass === "VALIDATOR_REJECTION"
      ? validatorDetail(rawMessage)
      : owner.causeClass === "TERMINAL_CONFLICT"
        ? "FIRST_TERMINAL_OUTCOME_PRESERVED"
        : owner.causeClass === "AUTHORITATIVE_READBACK_FAILURE"
          ? "TERMINAL_READBACK_NOT_VERIFIED"
          : "UNCLASSIFIED_CAUSE_REDACTED";
  const durableMessage = [
    "Durable AI success settlement rejected.",
    `stage=${owner.stage}`,
    `class=${owner.causeClass}`,
    `cause=${causeCode}`,
    `detail=${detail}`
  ].join(" ");
  return {
    errorCode: AI_DURABLE_SETTLEMENT_ERROR_CODE,
    causeCode,
    stage: owner.stage,
    causeClass: owner.causeClass,
    detail,
    durableMessage
  };
}

