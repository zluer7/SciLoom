import type {
  AIParseDraftOutcome,
  AIStandardResult,
  AIStandardResultBatchWirePayload,
  AIStandardResultManuscriptEffect,
  AIStandardResultProposalMetadata,
  AIStandardResultResponseContract,
  AIStandardResultTarget,
  AIStandardResultWireProposal
} from "../types/aiStandardResult";
import {
  AI_STANDARD_RESULT_ALLOWED_CAPABILITY_TUPLES
} from "../types/aiStandardResult";
import { validateAIContextRequestDecodedObject } from "./aiContextRequestService";
import { projectStandardOperationManuscriptEffectCapabilities } from "./manuscriptSegmentProductActivation";

export const AI_STANDARD_RESULT_MAX_RESULTS = 8;
export const AI_STANDARD_RESULT_MAX_WIRE_CHARS = 30_000;
// A former two-row Literature result could carry two independently bounded
// 6k manuscript bodies. The one-parent shape keeps the same bounded capacity.
export const AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS = 20_000;
export const AI_STANDARD_RESULT_PROPOSAL_METADATA_KEY = "_labpod" as const;
export const AI_STANDARD_RESULT_MANUSCRIPT_EFFECTS_KEY = "manuscriptEffects" as const;

export type AIStandardResultContractErrorCode =
  | "PARSE_OUTCOME_TOO_LARGE"
  | "PARSE_OUTCOME_INVALID_JSON"
  | "PARSE_OUTCOME_DISCRIMINATOR_INVALID"
  | "PARSE_OUTCOME_MIXED"
  | "STANDARD_RESULT_BATCH_INVALID"
  | "STANDARD_RESULT_COUNT_INVALID"
  | "STANDARD_RESULT_PAIR_UNSUPPORTED"
  | "STANDARD_RESULT_PEER_MANUSCRIPT_FORBIDDEN"
  | "STANDARD_RESULT_TARGET_INVALID"
  | "STANDARD_RESULT_PAYLOAD_INVALID"
  | "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID"
  | "STANDARD_RESULT_CROSS_RESULT_REFERENCE_FORBIDDEN"
  | "PARSE_CONTEXT_REQUEST_INVALID";

export class AIStandardResultContractError extends Error {
  constructor(readonly code: AIStandardResultContractErrorCode, message: string) {
    super(message);
    this.name = "AIStandardResultContractError";
  }
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value !== value.trim() || !value ||
    charCount(value) > 200 || /[\0-\x1F\x7F]/u.test(value)
  ) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_TARGET_INVALID",
      `${field} requires one exact bounded canonical identity.`
    );
  }
  return value;
}

function optionalProposalRef(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredIdentity(value, field);
}

export function readAIStandardResultProposalMetadata(
  payload: unknown
): AIStandardResultProposalMetadata | undefined {
  const record = asRecord(payload);
  const metadata = record ? asRecord(record[AI_STANDARD_RESULT_PROPOSAL_METADATA_KEY]) : null;
  if (!metadata) return undefined;
  const allowed = new Set([
    "protocol",
    "originalOrdinal",
    "proposalRef",
    "parentProposalRef"
  ]);
  if (Object.keys(metadata).some((key) => !allowed.has(key))) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_PAYLOAD_INVALID",
      "The _labpod proposal metadata contains an unsupported field."
    );
  }
  if (
    metadata.protocol !== "labpod-standard-result-proposal-v1" ||
    !Number.isSafeInteger(metadata.originalOrdinal) ||
    (metadata.originalOrdinal as number) < 1 ||
    (metadata.originalOrdinal as number) > AI_STANDARD_RESULT_MAX_RESULTS
  ) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_PAYLOAD_INVALID",
      "The _labpod proposal metadata protocol or original ordinal is invalid."
    );
  }
  const proposalRef = requiredIdentity(metadata.proposalRef, "payload._labpod.proposalRef");
  const parentProposalRef = optionalProposalRef(
    metadata.parentProposalRef,
    "payload._labpod.parentProposalRef"
  );
  return {
    protocol: "labpod-standard-result-proposal-v1",
    originalOrdinal: metadata.originalOrdinal as number,
    proposalRef,
    ...(parentProposalRef ? { parentProposalRef } : {})
  };
}

export function stripAIStandardResultProposalMetadata(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const clone = structuredClone(payload);
  delete clone[AI_STANDARD_RESULT_PROPOSAL_METADATA_KEY];
  return clone;
}

const ALLOWED_MANUSCRIPT_EFFECT_TUPLE_SET = new Set<string>(
  projectStandardOperationManuscriptEffectCapabilities()
);

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Reads the one-parent child-effect collection. Owner identity is deliberately
 * absent: UPDATE uses the exact parent target and CREATE obtains it only from
 * the canonical business receipt.
 */
export function readAIStandardResultManuscriptEffects(
  payload: unknown,
  parent?: {
    action: string;
    target: Pick<AIStandardResultTarget, "module" | "entityType">;
  }
): AIStandardResultManuscriptEffect[] {
  const record = asRecord(payload);
  const raw = record?.[AI_STANDARD_RESULT_MANUSCRIPT_EFFECTS_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
      "manuscriptEffects requires one or two explicit child effects."
    );
  }
  if (parent && parent.action !== "CREATE" && parent.action !== "UPDATE") {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
      "Only CREATE or UPDATE may contain manuscriptEffects."
    );
  }
  const effects = raw.map((candidate, index): AIStandardResultManuscriptEffect => {
    const effect = asRecord(candidate);
    if (!effect || !exactKeys(effect, ["channel", "body"])) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
        `manuscriptEffects[${index}] requires exactly channel and body.`
      );
    }
    const channel = requiredIdentity(
      effect.channel,
      `payload.manuscriptEffects[${index}].channel`
    );
    if (channel !== "primary" && channel !== "literature_outline" && channel !== "dedicated_notes") {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
        `manuscriptEffects[${index}] has an unsupported explicit channel.`
      );
    }
    if (typeof effect.body !== "string") {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
        `manuscriptEffects[${index}].body must be a Markdown string.`
      );
    }
    const body = effect.body.replace(/\r\n/gu, "\n");
    if (
      !body.trim() || body.includes("\0") || body.includes("\r") ||
      /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/u.test(body) ||
      /LABPOD_(?:META_SNAPSHOT|OUTLINE|BODY)_(?:START|END)/iu.test(body) ||
      !hasWellFormedUnicode(body) || charCount(body) > 6_000
    ) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
        `manuscriptEffects[${index}].body violates the bounded canonical Markdown carrier contract.`
      );
    }
    if (parent) {
      const tuple = [
        parent.action,
        parent.target.module,
        parent.target.entityType,
        channel
      ].join(".");
      if (!ALLOWED_MANUSCRIPT_EFFECT_TUPLE_SET.has(tuple)) {
        throw new AIStandardResultContractError(
          "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
          "The parent action/object/channel manuscript effect tuple is unsupported."
        );
      }
    }
    return { channel, body };
  });
  if (new Set(effects.map((effect) => effect.channel)).size !== effects.length) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_MANUSCRIPT_EFFECT_INVALID",
      "One parent cannot request the same manuscript channel more than once."
    );
  }
  return effects;
}

export function stripAIStandardResultManuscriptEffects(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const clone = structuredClone(payload);
  delete clone[AI_STANDARD_RESULT_MANUSCRIPT_EFFECTS_KEY];
  return clone;
}

export function attachAIStandardResultManuscriptEffects(
  payload: Record<string, unknown>,
  effects: readonly AIStandardResultManuscriptEffect[]
): Record<string, unknown> {
  return {
    ...structuredClone(payload),
    ...(effects.length > 0
      ? { [AI_STANDARD_RESULT_MANUSCRIPT_EFFECTS_KEY]: effects.map((effect) => ({ ...effect })) }
      : {})
  };
}

/** Stable adapter-only identity; it never becomes a peer durable Result id. */
export function internalAIStandardResultManuscriptEffectId(
  parentResultId: string,
  channel: AIStandardResultManuscriptEffect["channel"]
): string {
  return `${parentResultId}:manuscript:${channel}`;
}

const CANONICAL_TARGET_MODULE_BY_ENTITY_TYPE: Readonly<Record<string, string>> = {
  routeNode: "route",
  task: "task",
  review: "review",
  experiment: "experiment",
  experimentRun: "experimentRun",
  literature: "literature",
  resultItem: "resultItem",
  finding: "finding",
  outputCandidate: "outputCandidate",
  outputGap: "outputGap",
  researchOutput: "researchOutput"
};

function canonicalTargetModuleFromEntityType(
  target: Record<string, unknown>
): Record<string, unknown> {
  if (typeof target.entityType !== "string") return target;
  // "route" is the unambiguous user/business object name emitted by the
  // Provider for supported Route operations. The persisted planning entity
  // remains RouteNode; software owns this deterministic vocabulary map.
  const canonicalEntityType = target.entityType === "route"
    ? "routeNode"
    : target.entityType;
  const canonicalModule = CANONICAL_TARGET_MODULE_BY_ENTITY_TYPE[canonicalEntityType];
  return canonicalModule
    ? { ...target, module: canonicalModule, entityType: canonicalEntityType }
    : target;
}

function validateTarget(value: unknown, action: string): AIStandardResultTarget {
  const decodedTarget = asRecord(value);
  if (!decodedTarget) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_TARGET_INVALID",
      "A Standard Result requires one exact canonical target descriptor."
    );
  }
  const target = canonicalTargetModuleFromEntityType(decodedTarget);
  if (target.module === "route" && target.entityType === "routeNode") {
    const expectedKeys = action === "CREATE"
      ? ["module", "projectId", "entityType"]
      : action === "UPDATE" || action === "DELETE_SUGGESTION"
        ? ["module", "projectId", "entityType", "entityId"]
        : undefined;
    if (!expectedKeys || !exactKeys(target, expectedKeys)) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "A Route Standard Result requires the exact current-Project CREATE scope or existing UPDATE/DELETE target descriptor."
      );
    }
    return {
      module: "route",
      projectId: requiredIdentity(target.projectId, "target.projectId"),
      entityType: "routeNode",
      ...(action === "UPDATE" || action === "DELETE_SUGGESTION"
        ? { entityId: requiredIdentity(target.entityId, "target.entityId") }
        : {})
    };
  }
  if (target.module === "task" && target.entityType === "task") {
    const expectedKeys = action === "CREATE"
      ? ["module", "projectId", "entityType"]
      : ["module", "projectId", "entityType", "entityId"];
    if (!exactKeys(target, expectedKeys)) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "A Task Standard Result requires the exact canonical creation scope or existing target descriptor."
      );
    }
    return {
      module: "task",
      projectId: requiredIdentity(target.projectId, "target.projectId"),
      entityType: "task",
      ...(action === "CREATE"
        ? {}
        : { entityId: requiredIdentity(target.entityId, "target.entityId") })
    };
  }
  if (target.module === "review" && target.entityType === "review") {
    const expectedKeys = action === "CREATE"
      ? ["module", "projectId", "entityType"]
      : action === "NEW_MANUSCRIPT"
        ? ["module", "projectId", "entityType", "entityId", "manuscriptChannel"]
        : ["module", "projectId", "entityType", "entityId"];
    if (!exactKeys(target, expectedKeys)) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "A Review Standard Result requires the exact Project creation scope or existing Review target descriptor."
      );
    }
    return {
      module: "review",
      projectId: requiredIdentity(target.projectId, "target.projectId"),
      entityType: "review",
      ...(action === "CREATE"
        ? {}
        : { entityId: requiredIdentity(target.entityId, "target.entityId") }),
      ...(action === "NEW_MANUSCRIPT"
        ? { manuscriptChannel: requiredIdentity(target.manuscriptChannel, "target.manuscriptChannel") }
        : {})
    };
  }
  if (target.module === "experiment" && target.entityType === "experiment") {
    const expectedKeys = action === "CREATE"
      ? ["module", "projectId", "entityType"]
      : action === "NEW_MANUSCRIPT"
        ? ["module", "projectId", "entityType", "entityId", "manuscriptChannel"]
        : ["module", "projectId", "entityType", "entityId"];
    if (!exactKeys(target, expectedKeys)) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "An Experiment Standard Result requires the exact existing-Experiment creation scope or existing target descriptor."
      );
    }
    return {
      module: "experiment",
      projectId: requiredIdentity(target.projectId, "target.projectId"),
      entityType: "experiment",
      ...(action === "CREATE"
        ? {}
        : { entityId: requiredIdentity(target.entityId, "target.entityId") }),
      ...(action === "NEW_MANUSCRIPT"
        ? { manuscriptChannel: requiredIdentity(target.manuscriptChannel, "target.manuscriptChannel") }
        : {})
    };
  }
  if (target.module === "experimentRun" && target.entityType === "experimentRun") {
    const expectedKeys = action === "CREATE"
      ? ["module", "projectId", "entityType"]
      : action === "NEW_MANUSCRIPT"
        ? ["module", "projectId", "entityType", "entityId", "manuscriptChannel"]
        : ["module", "projectId", "entityType", "entityId"];
    if (!exactKeys(target, expectedKeys)) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "An ExperimentRun Standard Result requires the exact Project creation scope or frozen existing Run target descriptor."
      );
    }
    return {
      module: "experimentRun",
      projectId: requiredIdentity(target.projectId, "target.projectId"),
      entityType: "experimentRun",
      ...(action === "CREATE"
        ? {}
        : { entityId: requiredIdentity(target.entityId, "target.entityId") }),
      ...(action === "NEW_MANUSCRIPT"
        ? { manuscriptChannel: requiredIdentity(target.manuscriptChannel, "target.manuscriptChannel") }
        : {})
    };
  }
  if (target.module === "literature" && target.entityType === "literature") {
    const expectedKeys = action === "CREATE"
      ? ["module", "projectId", "entityType"]
      : action === "NEW_MANUSCRIPT"
        ? ["module", "projectId", "entityType", "entityId", "manuscriptChannel"]
        : ["module", "projectId", "entityType", "entityId"];
    if (!exactKeys(target, expectedKeys)) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "A Literature Standard Result requires the exact Conversation Project creation scope or selected canonical Literature target."
      );
    }
    const manuscriptChannel = action === "NEW_MANUSCRIPT"
      ? requiredIdentity(target.manuscriptChannel, "target.manuscriptChannel")
      : undefined;
    if (
      manuscriptChannel !== undefined &&
      manuscriptChannel !== "literature_outline" &&
      manuscriptChannel !== "dedicated_notes"
    ) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "Literature NEW_MANUSCRIPT requires exactly literature_outline or dedicated_notes."
      );
    }
    return {
      module: "literature",
      projectId: requiredIdentity(target.projectId, "target.projectId"),
      entityType: "literature",
      ...(action === "CREATE"
        ? {}
        : { entityId: requiredIdentity(target.entityId, "target.entityId") }),
      ...(action === "NEW_MANUSCRIPT"
        ? { manuscriptChannel }
        : {})
    };
  }
  if (
    (target.module === "resultItem" && target.entityType === "resultItem") ||
    (target.module === "finding" && target.entityType === "finding") ||
    (target.module === "outputCandidate" && target.entityType === "outputCandidate") ||
    (target.module === "outputGap" && target.entityType === "outputGap") ||
    (target.module === "researchOutput" && target.entityType === "researchOutput")
  ) {
    const expectedKeys = action === "CREATE"
      ? ["module", "projectId", "entityType"]
      : action === "NEW_MANUSCRIPT"
        ? ["module", "projectId", "entityType", "entityId", "manuscriptChannel"]
        : ["module", "projectId", "entityType", "entityId"];
    if (!exactKeys(target, expectedKeys)) {
      throw new AIStandardResultContractError(
        "STANDARD_RESULT_TARGET_INVALID",
        "An Outputs Standard Result requires the exact Project creation scope or existing target descriptor."
      );
    }
    return {
      module: target.module,
      projectId: requiredIdentity(target.projectId, "target.projectId"),
      entityType: target.entityType,
      ...(action === "CREATE"
        ? {}
        : { entityId: requiredIdentity(target.entityId, "target.entityId") }),
      ...(action === "NEW_MANUSCRIPT"
        ? { manuscriptChannel: requiredIdentity(target.manuscriptChannel, "target.manuscriptChannel") }
        : {})
    } as AIStandardResultTarget;
  }
  throw new AIStandardResultContractError(
    "STANDARD_RESULT_TARGET_INVALID",
    "The Standard Result target module/entity pair is unsupported."
  );
}

const NON_BLOCKING_VALIDATION_CODES = new Set([
  "DELETE_SUGGESTION_INFORMATIONAL_ONLY",
  "EXPERIMENT_RUN_SIBLING_PARENT_PENDING",
  "P1_MAJOR_UNREADABLE_NONBLOCKING",
  "P2_UNREADABLE_NONBLOCKING",
  // P1/P2 content and formatting issues are review guidance, never write-safety
  // authority. Owner adapters omit or preserve these fields in an existing
  // natural-language sink before this shared classification is consulted.
  "ROUTE_DATE_INVALID",
  "ROUTE_DATE_ORDER_INVALID",
  "ROUTE_ENUM_INVALID",
  "ROUTE_TAGS_INVALID",
  "TASK_BLOCK_REASON_REQUIRED",
  "TASK_DATE_INVALID",
  "TASK_DATE_ORDER_INVALID",
  "TASK_ENUM_INVALID",
  "TASK_TAGS_INVALID",
  "REVIEW_DATE_INVALID",
  "REVIEW_DESCRIPTION_OVERFLOW",
  "REVIEW_OUTLINE_CONTENT_INVALID",
  "REVIEW_OUTLINE_INVALID",
  "REVIEW_OUTLINE_KEY_INVALID",
  "REVIEW_PERIOD_ORDER_INVALID",
  "REVIEW_PERIOD_REQUIRED",
  "REVIEW_TAGS_INVALID",
  "REVIEW_TARGET_DUPLICATE",
  "REVIEW_TARGET_TYPE_INVALID",
  "REVIEW_TARGETS_INVALID",
  "EXPERIMENT_BOOLEAN_INVALID",
  "EXPERIMENT_RATING_INVALID",
  "EXPERIMENT_STATUS_INVALID",
  "EXPERIMENT_TAGS_INVALID",
  "EXPERIMENT_RUN_CONDITION_ITEMS_INVALID",
  "EXPERIMENT_RUN_CONDITION_ROLE_INVALID",
  "EXPERIMENT_RUN_CONDITION_VALUE_INVALID",
  "EXPERIMENT_RUN_CUSTOM_FIELDS_INVALID",
  "EXPERIMENT_RUN_CUSTOM_VALUE_INVALID",
  "EXPERIMENT_RUN_CUSTOM_VALUE_TYPE_INVALID",
  "EXPERIMENT_RUN_INSTANT_INVALID",
  "EXPERIMENT_RUN_MATERIAL_AMOUNT_INVALID",
  "EXPERIMENT_RUN_MATERIALS_INVALID",
  "EXPERIMENT_RUN_METHOD_ORDER_INVALID",
  "EXPERIMENT_RUN_METHOD_PARAMETERS_INVALID",
  "EXPERIMENT_RUN_METHOD_STEPS_INVALID",
  "EXPERIMENT_RUN_RATING_INVALID",
  "EXPERIMENT_RUN_STATUS_INVALID",
  "EXPERIMENT_RUN_TAGS_INVALID",
  "EXPERIMENT_RUN_VARIABLE_ROLE_INVALID",
  "EXPERIMENT_RUN_VARIABLE_VALUE_INVALID",
  "EXPERIMENT_RUN_VARIABLES_INVALID",
  "LITERATURE_AUTHORS_INVALID",
  "LITERATURE_IMPORTANCE_INVALID",
  "LITERATURE_LIST_INVALID",
  "LITERATURE_PUBLICATION_TYPE_INVALID",
  "LITERATURE_READING_STATUS_INVALID",
  "LITERATURE_YEAR_INVALID"
]);

// Unknown fields, reserved machine keys, identity values, source/target scope,
// authorization, stale/revision and lifecycle issues intentionally stay out of
// this set. Those are mechanical safety boundaries even when adjacent content
// fields are tolerated or omitted.

const FIELD_SENSITIVE_CONTENT_CODES = new Set([
  "ROUTE_FIELD_INVALID",
  "TASK_FIELD_INVALID",
  "REVIEW_FIELD_INVALID",
  "EXPERIMENT_FIELD_INVALID",
  "EXPERIMENT_RUN_FIELD_INVALID",
  "LITERATURE_FIELD_INVALID"
]);

export function isAIStandardResultBlockingValidationIssue(
  issue: { code: string; field?: string }
): boolean {
  if (NON_BLOCKING_VALIDATION_CODES.has(issue.code)) return false;
  if (FIELD_SENSITIVE_CONTENT_CODES.has(issue.code) && issue.field !== "title") return false;
  if (issue.code === "REVIEW_TARGET_INVALID" && issue.field?.startsWith("targets.")) return false;
  return true;
}

export function readAIStandardResultBlockingValidationIssues<
  T extends { code: string }
>(issues: readonly T[]): T[] {
  return issues.filter(isAIStandardResultBlockingValidationIssue);
}

const ALLOWED_CAPABILITY_TUPLE_SET = new Set<string>(AI_STANDARD_RESULT_ALLOWED_CAPABILITY_TUPLES);

function validateCapabilityTuple(
  category: string,
  action: string,
  target: AIStandardResultTarget
): void {
  const manuscriptChannel = "manuscriptChannel" in target
    ? target.manuscriptChannel
    : undefined;
  const tuple = [
    category,
    action,
    target.module,
    target.entityType,
    ...(manuscriptChannel ? [manuscriptChannel] : [])
  ].join(".");
  if (!ALLOWED_CAPABILITY_TUPLE_SET.has(tuple)) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_PAIR_UNSUPPORTED",
      "The Standard Result category/action/target/channel tuple is not an active Parse Draft capability."
    );
  }
}

const CROSS_RESULT_KEYS = new Set([
  "dependsOnResultId",
  "sourceResultId",
  "temporaryEntityId",
  "createdByResultId"
]);

function containsCrossResultReference(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsCrossResultReference(item, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    CROSS_RESULT_KEYS.has(key) || containsCrossResultReference(child, depth + 1));
}

function validatePair(category: unknown, action: unknown): {
  category: AIStandardResultWireProposal["category"];
  action: AIStandardResultWireProposal["action"];
} {
  if (action === "NEW_MANUSCRIPT") {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_PEER_MANUSCRIPT_FORBIDDEN",
      "NEW_MANUSCRIPT is an internal child-effect discriminator and is forbidden as a fresh Provider action."
    );
  }
  const internalAction = action === "DELETE" ? "DELETE_SUGGESTION" : action;
  const supported = category === "DATA_OPERATION" &&
    (internalAction === "CREATE" || internalAction === "UPDATE" || internalAction === "DELETE_SUGGESTION");
  if (!supported) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_PAIR_UNSUPPORTED",
      "The Standard Result category/action pair is unknown or unsupported."
    );
  }
  return {
    category: category as AIStandardResultWireProposal["category"],
    action: internalAction as AIStandardResultWireProposal["action"]
  };
}

function parseProposal(value: unknown, expectedOrdinal: number): AIStandardResultWireProposal {
  const proposal = asRecord(value);
  if (!proposal || !exactKeys(proposal, ["category", "action", "target", "payload"])) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_BATCH_INVALID",
      "Each Standard Result requires exactly category, action, target, and payload."
    );
  }
  const pair = validatePair(proposal.category, proposal.action);
  const payload = asRecord(proposal.payload);
  let serialized = "";
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // The typed boundary below converts this to one safe contract error.
  }
  if (!payload || !serialized || charCount(serialized) > AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_PAYLOAD_INVALID",
      "Each Standard Result payload must be one bounded JSON object without truncation."
    );
  }
  if (containsCrossResultReference(payload)) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_CROSS_RESULT_REFERENCE_FORBIDDEN",
      "Cross-Result temporary references and execution dependencies are not supported."
    );
  }
  const metadata = readAIStandardResultProposalMetadata(payload);
  if (metadata && metadata.originalOrdinal !== expectedOrdinal) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_BATCH_INVALID",
      "The typed original ordinal must exactly match the proposal's array position."
    );
  }
  const target = validateTarget(proposal.target, pair.action);
  validateCapabilityTuple(pair.category, pair.action, target);
  readAIStandardResultManuscriptEffects(payload, {
    action: pair.action,
    target
  });
  return {
    ...pair,
    target,
    payload: structuredClone(payload)
  };
}

/** Sole shared Standard Result parser; top-level outcome routing is deliberately outside this owner. */
export function parseAIStandardResultBatchDecodedObject(
  value: unknown
): AIStandardResultBatchWirePayload {
  const batch = asRecord(value);
  if (!batch || !exactKeys(batch, ["version", "results"]) || batch.version !== 1 || !Array.isArray(batch.results)) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_BATCH_INVALID",
      "The Standard Result batch envelope or version is invalid."
    );
  }
  if (batch.results.length < 1 || batch.results.length > AI_STANDARD_RESULT_MAX_RESULTS) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_COUNT_INVALID",
      `A Standard Result batch requires 1-${AI_STANDARD_RESULT_MAX_RESULTS} results without truncation.`
    );
  }
  const parsed = batch.results.map((proposal, index) => parseProposal(proposal, index + 1));
  const metadata = parsed.map((proposal) => readAIStandardResultProposalMetadata(proposal.payload));
  const refs = metadata.flatMap((candidate) => candidate ? [candidate.proposalRef] : []);
  if (new Set(refs).size !== refs.length) {
    throw new AIStandardResultContractError(
      "STANDARD_RESULT_BATCH_INVALID",
      "Typed proposal references must be unique within one ParseAttempt batch."
    );
  }
  return { version: 1, results: parsed };
}

/**
 * Sole PARSE_DRAFT top-level outcome router. It performs exactly one bounded JSON decode,
 * then delegates the already-decoded semantic payload to A5 or the Standard Result parser.
 */
export function parseAIParseDraftOutcome(text: string): AIParseDraftOutcome {
  const normalized = text.trim();
  if (!normalized || charCount(normalized) > AI_STANDARD_RESULT_MAX_WIRE_CHARS) {
    throw new AIStandardResultContractError(
      "PARSE_OUTCOME_TOO_LARGE",
      `The Parse Draft terminal outcome must fit within ${AI_STANDARD_RESULT_MAX_WIRE_CHARS} characters without truncation.`
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized);
  } catch {
    throw new AIStandardResultContractError(
      "PARSE_OUTCOME_INVALID_JSON",
      "The Parse Draft terminal outcome is not one complete JSON object."
    );
  }
  const outcome = asRecord(decoded);
  if (!outcome || typeof outcome.outcome !== "string") {
    throw new AIStandardResultContractError(
      "PARSE_OUTCOME_DISCRIMINATOR_INVALID",
      "The exact Parse Draft outcome discriminator is missing."
    );
  }
  if (outcome.outcome === "STANDARD_RESULT_BATCH") {
    if (!exactKeys(outcome, ["outcome", "batch"]) || hasOwn(outcome, "contextRequest")) {
      throw new AIStandardResultContractError(
        "PARSE_OUTCOME_MIXED",
        "A Parse Draft terminal response must contain exactly one outcome payload."
      );
    }
    return {
      kind: "standard_result_batch",
      payload: parseAIStandardResultBatchDecodedObject(outcome.batch)
    };
  }
  if (outcome.outcome === "AI_CONTEXT_REQUEST") {
    if (!exactKeys(outcome, ["outcome", "contextRequest"]) || hasOwn(outcome, "batch")) {
      throw new AIStandardResultContractError(
        "PARSE_OUTCOME_MIXED",
        "A Parse Draft terminal response must contain exactly one outcome payload."
      );
    }
    try {
      const payload = validateAIContextRequestDecodedObject(outcome.contextRequest);
      return { kind: "context_request", assistantText: payload.assistantText, payload };
    } catch (error) {
      throw new AIStandardResultContractError(
        "PARSE_CONTEXT_REQUEST_INVALID",
        error instanceof Error ? error.message : "The nested A5 Context Request payload is invalid."
      );
    }
  }
  throw new AIStandardResultContractError(
    "PARSE_OUTCOME_DISCRIMINATOR_INVALID",
    "The Parse Draft outcome discriminator is unknown."
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

export function canonicalAIStandardResultFingerprint(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value));
  let hash = 0x811c9dc5;
  for (const character of canonical) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `lp13-a6-${hash.toString(16).padStart(8, "0")}`;
}

export function createAIStandardResultResponseContract(): AIStandardResultResponseContract {
  const providerCapabilityTuples = AI_STANDARD_RESULT_ALLOWED_CAPABILITY_TUPLES.map((tuple) =>
    tuple.replace("DATA_OPERATION.DELETE_SUGGESTION.", "DATA_OPERATION.DELETE."));
  const manuscriptEffectCapabilities = projectStandardOperationManuscriptEffectCapabilities();
  return {
    contract: "LABPOD_STANDARD_RESULT_OUTCOME_V2",
    outputSerialization: {
      responseType: "ONE_COMPLETE_JSON_OBJECT",
      markdownFences: "FORBIDDEN",
      prosePrefixOrSuffix: "FORBIDDEN",
      multipleTopLevelObjects: "FORBIDDEN",
      partialOrTruncatedJson: "FORBIDDEN"
    },
    resultItemContract: {
      exactKeys: ["category", "action", "target", "payload"],
      capabilitySelectionRule: "COPY_ONE_WHOLE_ALLOWED_CAPABILITY_TUPLE_WITHOUT_SUBSTITUTION",
      targetExactKeysByAction: {
        CREATE: ["projectId", "entityType"],
        UPDATE: ["projectId", "entityType", "entityId"],
        DELETE: ["projectId", "entityType", "entityId"]
      },
      manuscriptEffects: {
        payloadKey: "manuscriptEffects",
        allowedParentActions: ["CREATE", "UPDATE"],
        exactEffectKeys: ["channel", "body"],
        maximumEffectsPerParent: 2,
        allowedCapabilityTuples: manuscriptEffectCapabilities,
        presentation: "SUBORDINATE_TO_ONE_PARENT_CARD_AND_ONE_USER_DECISION"
      },
      payloadRules: [
        "ONE_BOUNDED_MODULE_LOCAL_JSON_OBJECT",
        "TARGET_IDENTITY_FIELDS_FORBIDDEN_IN_PAYLOAD",
        "ONLY_TYPED_LABPOD_BATCH_LOCAL_REFERENCES_ALLOWED"
      ]
    },
    allowedCapabilityTuples: providerCapabilityTuples,
    minResults: 1,
    maxResults: AI_STANDARD_RESULT_MAX_RESULTS,
    contextRequestContract: "LABPOD_CONTEXT_REQUEST_V1"
  };
}
