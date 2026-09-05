import type {
  ManuscriptOutlineClearReason,
  ManuscriptOutlineDescriptorLookupIdentity,
  ManuscriptOutlineOrderedReplacement,
  ManuscriptOutlineReplacementDto
} from "./manuscriptOutlineParser";
import {
  getManuscriptOutlineDescriptor,
  type ManuscriptOutlineDescriptor,
  type ManuscriptOutlineFieldDescriptor,
  type ManuscriptOutlineOwnerType
} from "./manuscriptOutlineDescriptorRegistry";

export type ManuscriptOutlineClearRepresentation =
  | Readonly<{ kind: "null"; value: null }>
  | Readonly<{ kind: "empty-string"; value: "" }>
  | Readonly<{ kind: "remove-key" }>;

export type ManuscriptOutlineFieldApplication =
  | Readonly<{
    stableKey: string;
    order: number;
    targetPersistenceIdentity: string;
    action: "set";
    value: string;
  }>
  | Readonly<{
    stableKey: string;
    order: number;
    targetPersistenceIdentity: string;
    action: "clear";
    clearRepresentation: ManuscriptOutlineClearRepresentation;
    sourceClearReason: ManuscriptOutlineClearReason;
  }>;

export type ManuscriptOutlineOwnerApplicationPayload =
  | Readonly<{
    kind: "direct-fields";
    values: Readonly<Record<string, string | null>>;
  }>
  | Readonly<{
    kind: "literature-fields";
    directFields: Readonly<Record<string, string | null>>;
    customFieldOperations: readonly Readonly<{
      key: string;
      action: "set" | "remove";
      value?: string;
    }>[];
  }>
  | Readonly<{
    kind: "review-outline-sections";
    outlineSections: readonly Readonly<{
      key: string;
      content: string;
      order: number;
    }>[];
  }>
  | Readonly<{
    kind: "outputs-fields";
    brief: Readonly<{
      stableKey: string;
      entityField: "summary" | "description";
      value: string;
    }>;
    structuredSummary: readonly Readonly<{
      key: string;
      value: string;
      order: number;
    }>[];
  }>;

export interface ManuscriptOutlineOwnerApplicationMapping {
  readonly ownerType: ManuscriptOutlineDescriptorLookupIdentity["ownerType"];
  readonly channel: ManuscriptOutlineDescriptorLookupIdentity["channel"];
  readonly reviewType?: ManuscriptOutlineDescriptorLookupIdentity["reviewType"];
  readonly descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  readonly orderedFieldApplications: readonly ManuscriptOutlineFieldApplication[];
  readonly mappingDiagnostics: readonly never[];
  readonly applicationStatus: "READY";
  readonly ownerPayload: ManuscriptOutlineOwnerApplicationPayload;
}

export type ManuscriptOutlineOwnerProjectorFailureCode =
  | "UNSUPPORTED_OWNER_CHANNEL"
  | "UNSUPPORTED_REVIEW_TYPE"
  | "DESCRIPTOR_LOOKUP_FAILED"
  | "DTO_IDENTITY_MISMATCH"
  | "REPLACEMENT_COUNT_MISMATCH"
  | "REPLACEMENT_ORDER_MISMATCH"
  | "DUPLICATE_REPLACEMENT"
  | "UNKNOWN_REPLACEMENT_STABLE_KEY"
  | "MISSING_REPLACEMENT"
  | "INVALID_SET_APPLICATION"
  | "INVALID_CLEAR_APPLICATION"
  | "MISSING_PERSISTENCE_MAPPING"
  | "INVALID_CLEAR_REPRESENTATION"
  | "PROJECTOR_INVARIANT_FAILURE"
  | "INTERNAL_PROJECTOR_FAILURE";

export interface ManuscriptOutlineOwnerProjectorFailure {
  readonly code: ManuscriptOutlineOwnerProjectorFailureCode;
  readonly message: string;
  readonly descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  readonly stableKey?: string;
}

export type ManuscriptOutlineOwnerProjectorResult =
  | Readonly<{ ok: true; mapping: ManuscriptOutlineOwnerApplicationMapping }>
  | Readonly<{ ok: false; error: ManuscriptOutlineOwnerProjectorFailure }>;

const CLEAR_REASONS = new Set<ManuscriptOutlineClearReason>([
  "NO_OUTLINE",
  "MALFORMED_OUTLINE",
  "MISSING",
  "EMPTY",
  "DUPLICATE"
]);

const OUTPUT_OWNER_TYPES = new Set<ManuscriptOutlineOwnerType>([
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
]);

function freezeIdentity(
  identity: ManuscriptOutlineDescriptorLookupIdentity
): ManuscriptOutlineDescriptorLookupIdentity {
  return Object.freeze({
    ownerType: identity.ownerType,
    channel: identity.channel,
    ...(identity.reviewType ? { reviewType: identity.reviewType } : {})
  });
}

function failure(
  code: ManuscriptOutlineOwnerProjectorFailureCode,
  message: string,
  identity: ManuscriptOutlineDescriptorLookupIdentity,
  stableKey?: string
): ManuscriptOutlineOwnerProjectorResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message,
      descriptorLookupIdentity: freezeIdentity(identity),
      ...(stableKey ? { stableKey } : {})
    })
  });
}

function identitiesEqual(
  left: ManuscriptOutlineDescriptorLookupIdentity,
  right: ManuscriptOutlineDescriptorLookupIdentity
) {
  return left.ownerType === right.ownerType &&
    left.channel === right.channel &&
    left.reviewType === right.reviewType;
}

function dtoIdentityMatches(
  dto: ManuscriptOutlineReplacementDto,
  identity: ManuscriptOutlineDescriptorLookupIdentity
) {
  return dto.ownerType === identity.ownerType &&
    dto.channel === identity.channel &&
    dto.reviewType === identity.reviewType &&
    identitiesEqual(dto.descriptorLookupIdentity, identity);
}

function descriptorInvariantValid(
  descriptor: ManuscriptOutlineDescriptor,
  identity: ManuscriptOutlineDescriptorLookupIdentity
) {
  if (
    descriptor.ownerType !== identity.ownerType ||
    descriptor.channel !== identity.channel ||
    descriptor.reviewType !== identity.reviewType ||
    descriptor.fields.length === 0
  ) return false;
  const keys = new Set<string>();
  return descriptor.fields.every((field, index) => {
    if (
      field.ownerType !== descriptor.ownerType ||
      field.channel !== descriptor.channel ||
      field.order !== index ||
      !/^[A-Za-z0-9_-]+$/u.test(field.stableKey) ||
      keys.has(field.stableKey)
    ) return false;
    keys.add(field.stableKey);
    return true;
  });
}

function clearRepresentationFor(
  descriptor: ManuscriptOutlineDescriptor,
  field: ManuscriptOutlineFieldDescriptor
): ManuscriptOutlineClearRepresentation | undefined {
  const target = field.persistenceProjectorIdentity;
  if (descriptor.ownerType === "experiment" || descriptor.ownerType === "experimentRun") {
    return Object.freeze({ kind: "null", value: null });
  }
  if (descriptor.ownerType === "literature") {
    return target.startsWith("literature.customFields.")
      ? Object.freeze({ kind: "remove-key" })
      : target === "literature.abstract"
        ? Object.freeze({ kind: "null", value: null })
        : undefined;
  }
  if (descriptor.ownerType === "review" || OUTPUT_OWNER_TYPES.has(descriptor.ownerType)) {
    return Object.freeze({ kind: "empty-string", value: "" });
  }
  return undefined;
}

function applicationValue(application: ManuscriptOutlineFieldApplication): string | null {
  if (application.action === "set") return application.value;
  switch (application.clearRepresentation.kind) {
    case "null": return null;
    case "empty-string": return "";
    case "remove-key": return null;
  }
}

function buildDirectPayload(
  applications: readonly ManuscriptOutlineFieldApplication[]
): ManuscriptOutlineOwnerApplicationPayload {
  return Object.freeze({
    kind: "direct-fields",
    values: Object.freeze(Object.fromEntries(applications.map((application) => [
      application.targetPersistenceIdentity,
      applicationValue(application)
    ])))
  });
}

function buildLiteraturePayload(
  applications: readonly ManuscriptOutlineFieldApplication[]
): ManuscriptOutlineOwnerApplicationPayload {
  const directFields: Record<string, string | null> = {};
  const customFieldOperations: Array<{
    key: string;
    action: "set" | "remove";
    value?: string;
  }> = [];
  for (const application of applications) {
    const prefix = "literature.customFields.";
    if (application.targetPersistenceIdentity.startsWith(prefix)) {
      const key = application.targetPersistenceIdentity.slice(prefix.length);
      customFieldOperations.push(application.action === "set"
        ? { key, action: "set", value: application.value }
        : { key, action: "remove" });
    } else {
      directFields[application.targetPersistenceIdentity] = applicationValue(application);
    }
  }
  return Object.freeze({
    kind: "literature-fields",
    directFields: Object.freeze(directFields),
    customFieldOperations: Object.freeze(customFieldOperations.map((item) => Object.freeze(item)))
  });
}

function buildReviewPayload(
  applications: readonly ManuscriptOutlineFieldApplication[]
): ManuscriptOutlineOwnerApplicationPayload {
  return Object.freeze({
    kind: "review-outline-sections",
    outlineSections: Object.freeze(applications.map((application) => Object.freeze({
      key: application.stableKey,
      content: application.action === "set" ? application.value : "",
      order: application.order
    })))
  });
}

function buildOutputsPayload(
  applications: readonly ManuscriptOutlineFieldApplication[]
): ManuscriptOutlineOwnerApplicationPayload | undefined {
  const brief = applications.find((application) =>
    !application.targetPersistenceIdentity.includes(".structuredSummary.")
  );
  const structured = applications.filter((application) =>
    application.targetPersistenceIdentity.includes(".structuredSummary.")
  );
  if (!brief || structured.length !== applications.length - 1) return undefined;
  const targetSegments = brief.targetPersistenceIdentity.split(".");
  const entityField = targetSegments[targetSegments.length - 1];
  if (entityField !== "summary" && entityField !== "description") return undefined;
  return Object.freeze({
    kind: "outputs-fields",
    brief: Object.freeze({
      stableKey: brief.stableKey,
      entityField,
      value: applicationValue(brief) ?? ""
    }),
    structuredSummary: Object.freeze(structured.map((application) => Object.freeze({
      key: application.stableKey,
      value: applicationValue(application) ?? "",
      order: application.order
    })))
  });
}

function buildOwnerPayload(
  descriptor: ManuscriptOutlineDescriptor,
  applications: readonly ManuscriptOutlineFieldApplication[]
) {
  if (descriptor.ownerType === "literature") return buildLiteraturePayload(applications);
  if (descriptor.ownerType === "review") return buildReviewPayload(applications);
  if (OUTPUT_OWNER_TYPES.has(descriptor.ownerType)) return buildOutputsPayload(applications);
  return buildDirectPayload(applications);
}

function projectWithDescriptor(
  dto: ManuscriptOutlineReplacementDto,
  identity: ManuscriptOutlineDescriptorLookupIdentity,
  descriptor: ManuscriptOutlineDescriptor
): ManuscriptOutlineOwnerProjectorResult {
  const replacements = dto.orderedReplacements as readonly ManuscriptOutlineOrderedReplacement[];
  if (!Array.isArray(replacements)) {
    return failure("REPLACEMENT_COUNT_MISMATCH", "Ordered replacements must be an array.", identity);
  }
  const expectedKeys = descriptor.fields.map((field) => field.stableKey);
  const expectedKeySet = new Set(expectedKeys);
  const observedKeys = replacements.flatMap((item) =>
    item && typeof item === "object" && typeof item.stableKey === "string"
      ? [item.stableKey]
      : []
  );
  const seen = new Set<string>();
  for (const stableKey of observedKeys) {
    if (seen.has(stableKey)) {
      return failure("DUPLICATE_REPLACEMENT", "Replacement stable key is duplicated.", identity, stableKey);
    }
    seen.add(stableKey);
    if (!expectedKeySet.has(stableKey)) {
      return failure("UNKNOWN_REPLACEMENT_STABLE_KEY", "Replacement stable key is unknown.", identity, stableKey);
    }
  }
  if (replacements.length !== descriptor.fields.length || observedKeys.length !== replacements.length) {
    const missing = expectedKeys.find((stableKey) => !seen.has(stableKey));
    return missing && observedKeys.length === replacements.length
      ? failure("MISSING_REPLACEMENT", "Descriptor field replacement is missing.", identity, missing)
      : failure("REPLACEMENT_COUNT_MISMATCH", "Replacement count does not match descriptor fields.", identity);
  }
  const missing = expectedKeys.find((stableKey) => !seen.has(stableKey));
  if (missing) return failure("MISSING_REPLACEMENT", "Descriptor field replacement is missing.", identity, missing);

  for (let index = 0; index < descriptor.fields.length; index += 1) {
    const field = descriptor.fields[index];
    const replacement = replacements[index];
    if (replacement.stableKey !== field.stableKey || replacement.order !== field.order) {
      return failure(
        "REPLACEMENT_ORDER_MISMATCH",
        "Replacement order does not match descriptor order.",
        identity,
        replacement.stableKey
      );
    }
    if (!field.persistenceProjectorIdentity.trim()) {
      return failure("MISSING_PERSISTENCE_MAPPING", "Descriptor persistence mapping is missing.", identity, field.stableKey);
    }
    if (replacement.action === "set") {
      if (
        typeof replacement.value !== "string" ||
        "clearReason" in replacement ||
        "clearRepresentation" in replacement
      ) return failure("INVALID_SET_APPLICATION", "SET replacement shape is invalid.", identity, field.stableKey);
    } else if (replacement.action === "clear") {
      if (
        !CLEAR_REASONS.has(replacement.clearReason) ||
        "value" in replacement ||
        "clearRepresentation" in replacement
      ) return failure("INVALID_CLEAR_APPLICATION", "CLEAR replacement shape is invalid.", identity, field.stableKey);
    } else {
      return failure("PROJECTOR_INVARIANT_FAILURE", "Replacement action is unsupported.", identity, field.stableKey);
    }
  }

  const applications: ManuscriptOutlineFieldApplication[] = [];
  for (let index = 0; index < descriptor.fields.length; index += 1) {
    const field = descriptor.fields[index];
    const replacement = replacements[index];
    if (replacement.action === "set") {
      applications.push(Object.freeze({
        stableKey: field.stableKey,
        order: field.order,
        targetPersistenceIdentity: field.persistenceProjectorIdentity,
        action: "set",
        value: replacement.value
      }));
      continue;
    }
    const clearRepresentation = clearRepresentationFor(descriptor, field);
    if (!clearRepresentation) {
      return failure(
        "INVALID_CLEAR_REPRESENTATION",
        "Owner field clear representation is invalid.",
        identity,
        field.stableKey
      );
    }
    applications.push(Object.freeze({
      stableKey: field.stableKey,
      order: field.order,
      targetPersistenceIdentity: field.persistenceProjectorIdentity,
      action: "clear",
      clearRepresentation,
      sourceClearReason: replacement.clearReason
    }));
  }

  const ownerPayload = buildOwnerPayload(descriptor, applications);
  if (!ownerPayload) {
    return failure("PROJECTOR_INVARIANT_FAILURE", "Owner payload mapping is incomplete.", identity);
  }
  return Object.freeze({
    ok: true,
    mapping: Object.freeze({
      ownerType: identity.ownerType,
      channel: identity.channel,
      ...(identity.reviewType ? { reviewType: identity.reviewType } : {}),
      descriptorLookupIdentity: freezeIdentity(identity),
      orderedFieldApplications: Object.freeze(applications),
      mappingDiagnostics: Object.freeze([]),
      applicationStatus: "READY",
      ownerPayload
    })
  });
}

export function projectManuscriptOutlineReplacements(input: Readonly<{
  orderedReplacementDto: ManuscriptOutlineReplacementDto;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
}>): ManuscriptOutlineOwnerProjectorResult {
  const identity = input?.descriptorLookupIdentity ?? ({} as ManuscriptOutlineDescriptorLookupIdentity);
  const dto = input?.orderedReplacementDto;
  if (!dto || !dtoIdentityMatches(dto, identity)) {
    return failure("DTO_IDENTITY_MISMATCH", "Replacement DTO identity does not match projector identity.", identity);
  }
  if (
    (identity.ownerType === "review" && !identity.reviewType) ||
    (identity.ownerType !== "review" && identity.reviewType !== undefined)
  ) {
    return failure(
      identity.ownerType === "review" ? "UNSUPPORTED_REVIEW_TYPE" : "UNSUPPORTED_OWNER_CHANNEL",
      "Owner projector identity is unsupported.",
      identity
    );
  }

  let descriptor: ManuscriptOutlineDescriptor;
  try {
    descriptor = getManuscriptOutlineDescriptor(identity);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("MANUSCRIPT_OUTLINE_DESCRIPTOR_NOT_FOUND:")) {
      return failure(
        identity.ownerType === "review" ? "UNSUPPORTED_REVIEW_TYPE" : "UNSUPPORTED_OWNER_CHANNEL",
        "Owner projector identity is unsupported.",
        identity
      );
    }
    return failure("DESCRIPTOR_LOOKUP_FAILED", "Owner projector descriptor lookup failed.", identity);
  }

  try {
    if (!descriptorInvariantValid(descriptor, identity)) {
      return failure("PROJECTOR_INVARIANT_FAILURE", "Owner projector descriptor invariant is invalid.", identity);
    }
    return projectWithDescriptor(dto, identity, descriptor);
  } catch {
    return failure("INTERNAL_PROJECTOR_FAILURE", "Owner projector failed.", identity);
  }
}

export const manuscriptOutlineOwnerProjector = Object.freeze({
  project: projectManuscriptOutlineReplacements
});
