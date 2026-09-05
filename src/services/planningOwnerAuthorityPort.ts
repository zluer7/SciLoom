import type { PlanningData } from "../types/planning";
import {
  tauriOwnerAuthorityLeaseClient,
  type AuthorityLeaseRequest,
  type OwnerAuthorityLeaseClient
} from "./ownerAuthorityLeaseClient";

export type PlanningAuthorityIntent =
  | "provisioningRead"
  | "provisioningWrite"
  | "projectCreate"
  | "projectWrite"
  | "projectRestore"
  | "ownerCreate"
  | "ownerWrite"
  | "ownerRestore"
  | "reviewSoftDelete"
  | "reviewRestore"
  | "reviewPermanentDelete"
  | "metadataWrite"
  | "managedRootWrite";

export const PLANNING_OWNER_ALLOWED_PROVISIONING_INTENTS = Object.freeze([
  "create-default",
  "retry",
  "repair",
  "recover"
] as const);

export interface PlanningOwnerAuthorityRequest {
  intent: PlanningAuthorityIntent;
  requestId: string;
  projectId?: string;
  ownerType?: string;
  ownerId?: string;
  scope?: string;
  lifecycleActionId?: string;
  exactRecycleEntryId?: string;
  sourceDeleteActionId?: string;
  impactPlanVersion?: 1;
  impactDigest?: string;
  expectedPlanningEpoch?: string;
  expectedPlanningRevision?: string;
}

export interface ValidatedPlanningAuthority {
  authorityDomain: "planning-owner";
  authorityVersion: 1;
  projectId?: string;
  projectTitle?: string;
  ownerType?: string;
  ownerId?: string;
  ownerTitle?: string;
  ownerCreatedAt?: string;
  scope?: string;
  projectLifecycle:
    | "active"
    | "archived"
    | "deleted"
    | "missing"
    | "missing-for-create"
    | "not-applicable";
  ownerLifecycle?: "active" | "deleted";
  projectWriteability: "writable";
  ownerWriteability?: "writable";
  ownerProjectRelationship?: "matched" | "unassigned";
  derivedEligibility: "eligible";
  repositoryEpoch?: string;
  repositoryRevision?: string;
  evidenceDigest: string;
  validatedAtMonotonic: number;
}

export interface ValidatedPlanningAuthorityHandle {
  readonly requests: readonly AuthorityLeaseRequest[];
}

export interface ValidatedPlanningAuthorityCommandPermit {
  token: string;
  requests: AuthorityLeaseRequest[];
}

export type PlanningAuthorityFailureStatus =
  | "NotFound"
  | "Deleted"
  | "NotWritable"
  | "ProjectUnavailable"
  | "OwnerProjectMismatch"
  | "AuthorityChanged"
  | "LeaseUnavailable"
  | "LeaseStale"
  | "DataSourceUnsupported"
  | "InternalFailure";

export interface PlanningAuthorityFailure {
  status: PlanningAuthorityFailureStatus;
  code: string;
}

export type PlanningAuthorityResult =
  | {
      status: "Validated";
      handle: ValidatedPlanningAuthorityHandle;
      authority: ValidatedPlanningAuthority;
      context: PlanningAuthorityEnvelopeView;
    }
  | PlanningAuthorityFailure;

type PlanningOwnerRecord = {
  id: string;
  projectId?: string | null;
  primaryProjectId?: string | null;
  deletedAt?: string | null;
  archivedAt?: string | null;
  status?: string | null;
  title?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type PlanningOwnerAuthorityDomain =
  | "planning"
  | "external"
  | "unsupported";

const PLANNING_OWNER_TYPES = new Set([
  "project",
  "review",
  "routeNode",
  "routeCheckpoint",
  "task",
  "taskCheckpoint",
  "researchRoutine",
  "routineCheckIn",
  "entityLink"
]);

const PLANNING_OWNER_CREATE_TYPES = new Set([
  "review",
  "routeNode",
  "routeCheckpoint",
  "task",
  "taskCheckpoint",
  "researchRoutine",
  "routineCheckIn",
  "entityLink"
]);

const PROJECTLESS_PLANNING_OWNER_TYPES = new Set([
  "researchRoutine",
  "routineCheckIn",
  "entityLink"
]);

const EXTERNAL_OWNER_TYPES = new Set([
  "experiment",
  "experimentRun",
  "literature",
  "resultItem",
  "finding",
  "outputCandidate",
  "outputGap",
  "researchOutput"
]);

function resolvePlanningOwnerAuthorityDomain(
  ownerType: string
): PlanningOwnerAuthorityDomain {
  if (PLANNING_OWNER_TYPES.has(ownerType)) return "planning";
  if (EXTERNAL_OWNER_TYPES.has(ownerType)) return "external";
  return "unsupported";
}

export interface PlanningOwnerAuthorityPortDependencies {
  leaseClient: OwnerAuthorityLeaseClient;
  readPlanningEnvelope(
    request?: PlanningOwnerAuthorityRequest
  ): Promise<PlanningAuthorityEnvelopeView>;
  readNonPlanningOwner(
    ownerType: string,
    ownerId: string
  ): Promise<PlanningOwnerRecord | undefined>;
  monotonicNow(): number;
}

export interface PlanningAuthorityEnvelopeView {
  repositoryEpoch: string;
  revision: string;
  snapshot: PlanningData;
}

type HandleState = {
  token: string;
  requests: AuthorityLeaseRequest[];
  request: PlanningOwnerAuthorityRequest;
  authority: ValidatedPlanningAuthority;
  context: PlanningAuthorityEnvelopeView;
};

const handleStates = new WeakMap<object, HandleState>();
const liveHandles = new WeakSet<object>();

export function readValidatedPlanningAuthorityCommandPermit(
  handle: ValidatedPlanningAuthorityHandle
): ValidatedPlanningAuthorityCommandPermit {
  const state = handleStates.get(handle as object);
  if (!state || !liveHandles.has(handle as object)) {
    throw new Error("PLANNING_AUTHORITY_COMMIT_PERMIT_INVALID");
  }
  return {
    token: state.token,
    requests: clone(state.requests)
  };
}

function frozenHandle(requests: AuthorityLeaseRequest[]): ValidatedPlanningAuthorityHandle {
  const handle = Object.freeze({
    requests: Object.freeze(requests.map((request) => Object.freeze({
      ...request,
      key: Object.freeze({ ...request.key })
    })))
  });
  liveHandles.add(handle);
  return handle;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function frozenContext(envelope: PlanningAuthorityEnvelopeView): PlanningAuthorityEnvelopeView {
  return deepFreeze(clone(envelope));
}

function failure(status: PlanningAuthorityFailureStatus, code: string): PlanningAuthorityFailure {
  return { status, code };
}

function sameAuthorityRequest(
  actual: PlanningOwnerAuthorityRequest,
  expected: PlanningOwnerAuthorityRequest
) {
  return actual.intent === expected.intent &&
    actual.requestId === expected.requestId &&
    actual.projectId === expected.projectId &&
    actual.ownerType === expected.ownerType &&
    actual.ownerId === expected.ownerId &&
    actual.scope === expected.scope &&
    actual.lifecycleActionId === expected.lifecycleActionId &&
    actual.exactRecycleEntryId === expected.exactRecycleEntryId &&
    actual.sourceDeleteActionId === expected.sourceDeleteActionId &&
    actual.impactPlanVersion === expected.impactPlanVersion &&
    actual.impactDigest === expected.impactDigest &&
    actual.expectedPlanningEpoch === expected.expectedPlanningEpoch &&
    actual.expectedPlanningRevision === expected.expectedPlanningRevision;
}

export function validatePlanningAuthorityCommitPermit(
  handle: ValidatedPlanningAuthorityHandle,
  expectedRequest: PlanningOwnerAuthorityRequest,
  expectedContext: PlanningAuthorityEnvelopeView
): PlanningAuthorityResult {
  const state = handleStates.get(handle as object);
  if (!state || !liveHandles.has(handle as object)) {
    return failure("LeaseStale", "PLANNING_AUTHORITY_COMMIT_PERMIT_INVALID");
  }
  if (!sameAuthorityRequest(state.request, expectedRequest)) {
    return failure("LeaseStale", "PLANNING_AUTHORITY_COMMIT_REQUEST_MISMATCH");
  }
  if (
    state.context !== expectedContext ||
    state.context.repositoryEpoch !== expectedContext.repositoryEpoch ||
    state.context.revision !== expectedContext.revision ||
    state.authority.repositoryEpoch !== expectedContext.repositoryEpoch ||
    state.authority.repositoryRevision !== expectedContext.revision
  ) {
    return failure("AuthorityChanged", "PLANNING_AUTHORITY_COMMIT_CONTEXT_MISMATCH");
  }
  return {
    status: "Validated",
    handle,
    authority: state.authority,
    context: state.context
  };
}

function stableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function leaseFailure(error: unknown): PlanningAuthorityResult {
  const code = stableError(error);
  if (code.includes("BUSY") || code.includes("CONFLICT")) {
    return failure("LeaseUnavailable", code);
  }
  if (code.includes("STALE") || code.includes("NOT_OWNED")) {
    return failure("LeaseStale", code);
  }
  if (code.includes("DATA_SOURCE") || code.includes("DESKTOP_RUNTIME")) {
    return failure("DataSourceUnsupported", code);
  }
  return failure("InternalFailure", code);
}

function requestsFor(request: PlanningOwnerAuthorityRequest): AuthorityLeaseRequest[] {
  const project = (): AuthorityLeaseRequest => ({
    key: { kind: "project", projectId: request.projectId! },
    mode: "read"
  });
  const owner = (): AuthorityLeaseRequest => ({
    key: {
      kind: "owner",
      ownerType: request.ownerType!,
      ownerId: request.ownerId!
    },
    mode: "read"
  });
  const channel = (scope = request.scope!): AuthorityLeaseRequest => ({
    key: {
      kind: "channelScope",
      ownerType: request.ownerType!,
      ownerId: request.ownerId!,
      scope
    },
    mode: "write"
  });
  const projectRead = () => request.projectId ? [project()] : [];
  switch (request.intent) {
    case "managedRootWrite":
      return [{ key: { kind: "managedRoot" }, mode: "write" }];
    case "projectCreate":
    case "projectWrite":
    case "projectRestore":
      return [{
        key: { kind: "project", projectId: request.projectId! },
        mode: "write"
      }];
    case "ownerCreate":
    case "ownerWrite":
    case "ownerRestore":
    case "reviewSoftDelete":
    case "reviewRestore":
    case "reviewPermanentDelete":
      return [
        ...projectRead(),
        { ...owner(), mode: "write" }
      ];
    case "metadataWrite":
      return [...projectRead(), owner(), channel()];
    case "provisioningRead":
      return [
        { key: { kind: "managedRoot" }, mode: "read" },
        ...projectRead(),
        owner(),
        channel()
      ];
    case "provisioningWrite":
      return [
        { key: { kind: "managedRoot" }, mode: "read" },
        ...projectRead(),
        owner(),
        ...(request.ownerType === "literature" && request.scope === "literature-aggregate"
          ? [
              channel("primary"),
              channel("literature_outline"),
              channel("dedicated_notes")
            ]
          : request.scope === "primary"
            ? []
            : [channel("primary")]),
        channel()
      ];
  }
}

function invalidRequest(request: PlanningOwnerAuthorityRequest) {
  if (!request.requestId.trim()) return true;
  if (request.intent === "reviewPermanentDelete") {
    return request.ownerType !== "review"
      || !request.ownerId?.trim()
      || !request.projectId?.trim()
      || request.scope !== "primary"
      || !/^[A-Za-z0-9:_-]+$/.test(request.lifecycleActionId ?? "")
      || !/^[A-Za-z0-9:_-]+$/.test(request.exactRecycleEntryId ?? "")
      || !/^[A-Za-z0-9:_-]+$/.test(request.sourceDeleteActionId ?? "")
      || request.impactPlanVersion !== 1
      || !/^[0-9a-f]{64}$/.test(request.impactDigest ?? "")
      || !request.expectedPlanningEpoch?.trim()
      || !/^\d+$/.test(request.expectedPlanningRevision ?? "");
  }
  if (request.intent === "managedRootWrite") return false;
  if (
    !request.projectId?.trim() &&
    !(
      request.ownerType?.trim() &&
      request.ownerId?.trim() &&
      (
        request.intent !== "ownerCreate" ||
        PROJECTLESS_PLANNING_OWNER_TYPES.has(request.ownerType)
      )
    )
  ) return true;
  if (
    request.intent === "projectCreate" ||
    request.intent === "projectWrite" ||
    request.intent === "projectRestore"
  ) return false;
  return !request.ownerType?.trim() || !request.ownerId?.trim() || !request.scope?.trim();
}

function findPlanningOwner(
  planning: PlanningData,
  ownerType: string,
  ownerId: string
): PlanningOwnerRecord | undefined {
  const direct = (() => {
    switch (ownerType) {
      case "project":
        return planning.projects.find((candidate) => candidate.id === ownerId);
      case "review":
        return planning.reviews.find((candidate) => candidate.id === ownerId);
      case "routeNode":
        return planning.routeNodes.find((candidate) => candidate.id === ownerId);
      case "routeCheckpoint":
        return planning.routeCheckpoints.find((candidate) => candidate.id === ownerId);
      case "task":
        return planning.tasks.find((candidate) => candidate.id === ownerId);
      case "taskCheckpoint":
        return planning.taskCheckpoints.find((candidate) => candidate.id === ownerId);
      case "researchRoutine":
        return planning.researchRoutines.find((candidate) => candidate.id === ownerId);
      case "routineCheckIn":
        return planning.routineCheckIns.find((candidate) => candidate.id === ownerId);
      case "entityLink":
        return planning.entityLinks.find((candidate) => candidate.id === ownerId);
      default:
        return undefined;
    }
  })() as PlanningOwnerRecord | undefined;
  if (!direct) return undefined;
  if (ownerType === "routeCheckpoint") {
    const checkpoint = direct as PlanningData["routeCheckpoints"][number];
    const route = planning.routeNodes.find((candidate) => candidate.id === checkpoint.routeNodeId);
    return { ...direct, projectId: route?.projectId };
  }
  if (ownerType === "taskCheckpoint") {
    const checkpoint = direct as PlanningData["taskCheckpoints"][number];
    const task = planning.tasks.find((candidate) => candidate.id === checkpoint.taskId);
    return { ...direct, projectId: task?.projectId };
  }
  if (ownerType === "routineCheckIn") {
    const checkIn = direct as PlanningData["routineCheckIns"][number];
    const routine = planning.researchRoutines.find(
      (candidate) => candidate.id === checkIn.routineId
    );
    return { ...direct, projectId: checkIn.projectId ?? routine?.projectId };
  }
  if (ownerType === "entityLink") {
    return { id: direct.id };
  }
  return direct;
}

async function lookupAuthorityOwner(
  dependencies: PlanningOwnerAuthorityPortDependencies,
  planning: PlanningData,
  ownerType: string,
  ownerId: string
): Promise<{
  domain: PlanningOwnerAuthorityDomain;
  owner: PlanningOwnerRecord | undefined;
}> {
  const domain = resolvePlanningOwnerAuthorityDomain(ownerType);
  if (domain === "planning") {
    return {
      domain,
      owner: findPlanningOwner(planning, ownerType, ownerId)
    };
  }
  if (domain === "external") {
    return {
      domain,
      owner: await dependencies.readNonPlanningOwner(ownerType, ownerId)
    };
  }
  return { domain, owner: undefined };
}

async function resolveProjectKey(
  dependencies: PlanningOwnerAuthorityPortDependencies,
  request: PlanningOwnerAuthorityRequest,
  planningOverride?: PlanningData
): Promise<
  | { status: "Resolved"; request: PlanningOwnerAuthorityRequest }
  | Exclude<PlanningAuthorityResult, { status: "Validated" }>
> {
  if (request.projectId || request.intent === "managedRootWrite") {
    return { status: "Resolved", request };
  }
  if (!request.ownerType || !request.ownerId) {
    return failure("InternalFailure", "PLANNING_AUTHORITY_PROJECT_KEY_REQUIRED");
  }
  const planning = planningOverride ?? (await dependencies.readPlanningEnvelope()).snapshot;
  const lookup = await lookupAuthorityOwner(
    dependencies,
    planning,
    request.ownerType,
    request.ownerId
  );
  if (lookup.domain === "unsupported") {
    return failure("InternalFailure", "PLANNING_AUTHORITY_OWNER_TYPE_UNSUPPORTED");
  }
  const owner = lookup.owner;
  if (!owner) {
    if (
      request.intent === "ownerCreate" &&
      lookup.domain === "planning" &&
      PLANNING_OWNER_CREATE_TYPES.has(request.ownerType) &&
      PROJECTLESS_PLANNING_OWNER_TYPES.has(request.ownerType)
    ) {
      return { status: "Resolved", request };
    }
    return failure("NotFound", "PLANNING_AUTHORITY_OWNER_NOT_FOUND");
  }
  if (request.intent === "ownerCreate") {
    if (
      lookup.domain !== "planning" ||
      !PLANNING_OWNER_CREATE_TYPES.has(request.ownerType)
    ) {
      return failure(
        "InternalFailure",
        "PLANNING_AUTHORITY_OWNER_CREATE_DOMAIN_UNSUPPORTED"
      );
    }
    return failure("NotWritable", "PLANNING_AUTHORITY_OWNER_ALREADY_EXISTS");
  }
  const ownerRecord = owner as PlanningOwnerRecord;
  const projectId = ownerRecord.projectId ?? ownerRecord.primaryProjectId;
  if (!projectId) {
    if (
      lookup.domain === "planning" &&
      PROJECTLESS_PLANNING_OWNER_TYPES.has(request.ownerType)
    ) {
      return { status: "Resolved", request };
    }
    if (
      lookup.domain === "external" &&
      request.ownerType === "literature" &&
      ["provisioningRead", "provisioningWrite", "metadataWrite"].includes(request.intent)
    ) {
      return { status: "Resolved", request };
    }
    return failure("ProjectUnavailable", "PLANNING_AUTHORITY_PROJECT_NOT_FOUND");
  }
  return {
    status: "Resolved",
    request: { ...request, projectId }
  };
}

function isProjectWritable(project: PlanningData["projects"][number]) {
  return !project.deletedAt && !project.archivedAt && project.status !== "archived";
}

function digest(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 0xcbf29ce4;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function leaseCovers(
  held: readonly AuthorityLeaseRequest[],
  required: readonly AuthorityLeaseRequest[]
) {
  return required.every((request) => held.some((candidate) =>
    JSON.stringify(candidate.key) === JSON.stringify(request.key) &&
    (candidate.mode === "write" || candidate.mode === request.mode)
  ));
}

async function deriveAuthority(
  dependencies: PlanningOwnerAuthorityPortDependencies,
  request: PlanningOwnerAuthorityRequest,
  planningOverride?: PlanningData,
  repositoryIdentity?: Pick<PlanningAuthorityEnvelopeView, "repositoryEpoch" | "revision">
): Promise<
  | { status: "Validated"; authority: ValidatedPlanningAuthority }
  | Exclude<PlanningAuthorityResult, { status: "Validated" }>
> {
  if (request.intent === "managedRootWrite") {
    return {
      status: "Validated",
      authority: Object.freeze({
        authorityDomain: "planning-owner",
        authorityVersion: 1,
        projectLifecycle: "missing-for-create",
        projectWriteability: "writable",
        derivedEligibility: "eligible",
        repositoryEpoch: repositoryIdentity?.repositoryEpoch,
        repositoryRevision: repositoryIdentity?.revision,
        evidenceDigest: digest({ intent: request.intent }),
        validatedAtMonotonic: dependencies.monotonicNow()
      })
    };
  }
  const planning = planningOverride ?? (await dependencies.readPlanningEnvelope()).snapshot;
  if (!request.projectId) {
    const ownerType = request.ownerType ?? "";
    const domain = resolvePlanningOwnerAuthorityDomain(ownerType);
    if (domain === "unsupported") {
      return failure("InternalFailure", "PLANNING_AUTHORITY_OWNER_TYPE_UNSUPPORTED");
    }
    const planningProjectless =
      domain === "planning" && PROJECTLESS_PLANNING_OWNER_TYPES.has(ownerType);
    const externalProjectless =
      domain === "external" &&
      ownerType === "literature" &&
      ["provisioningRead", "provisioningWrite", "metadataWrite"].includes(request.intent);
    if (!planningProjectless && !externalProjectless) {
      return failure("ProjectUnavailable", "PLANNING_AUTHORITY_PROJECT_NOT_FOUND");
    }
    const lookup = await lookupAuthorityOwner(
      dependencies,
      planning,
      ownerType,
      request.ownerId!
    );
    const owner = lookup.owner;
    if (!owner && request.intent !== "ownerCreate") {
      return failure("NotFound", "PLANNING_AUTHORITY_OWNER_NOT_FOUND");
    }
    if (!owner && (
      lookup.domain !== "planning" ||
      !PLANNING_OWNER_CREATE_TYPES.has(ownerType) ||
      !PROJECTLESS_PLANNING_OWNER_TYPES.has(ownerType)
    )) {
      return failure(
        "InternalFailure",
        "PLANNING_AUTHORITY_OWNER_CREATE_DOMAIN_UNSUPPORTED"
      );
    }
    if (owner && request.intent === "ownerCreate") {
      return failure("NotWritable", "PLANNING_AUTHORITY_OWNER_ALREADY_EXISTS");
    }
    if (owner?.deletedAt) {
      return failure("Deleted", "PLANNING_AUTHORITY_OWNER_DELETED");
    }
    if (owner?.archivedAt || owner?.status === "archived") {
      return failure("NotWritable", "PLANNING_AUTHORITY_OWNER_NOT_WRITABLE");
    }
    if (owner && (owner.projectId ?? owner.primaryProjectId)) {
      return failure("OwnerProjectMismatch", "PLANNING_AUTHORITY_OWNER_PROJECT_MISMATCH");
    }
    return {
      status: "Validated",
      authority: Object.freeze({
        authorityDomain: "planning-owner" as const,
        authorityVersion: 1 as const,
        ownerType: request.ownerType,
        ownerId: owner?.id ?? request.ownerId,
        ownerTitle: owner?.title ?? undefined,
        ownerCreatedAt: owner?.createdAt ?? undefined,
        scope: request.scope,
        projectLifecycle: "not-applicable" as const,
        ownerLifecycle: "active" as const,
        projectWriteability: "writable" as const,
        ownerWriteability: "writable" as const,
        ownerProjectRelationship: "unassigned" as const,
        derivedEligibility: "eligible" as const,
        repositoryEpoch: repositoryIdentity?.repositoryEpoch,
        repositoryRevision: repositoryIdentity?.revision,
        evidenceDigest: digest({ owner: owner ?? null, ownerId: request.ownerId, projectId: null }),
        validatedAtMonotonic: dependencies.monotonicNow()
      })
    };
  }
  const project = planning.projects.find((candidate) => candidate.id === request.projectId);
  if (request.intent === "reviewSoftDelete" || request.intent === "reviewRestore" || request.intent === "reviewPermanentDelete") {
    if (request.ownerType !== "review" || request.scope !== "primary") {
      return failure("InternalFailure", "PLANNING_AUTHORITY_REVIEW_LIFECYCLE_SCOPE_INVALID");
    }
    const owner = planning.reviews.find((candidate) => candidate.id === request.ownerId);
    if (!owner) {
      return failure("NotFound", "PLANNING_AUTHORITY_OWNER_NOT_FOUND");
    }
    const ownerRecord = owner as PlanningOwnerRecord;
    if (ownerRecord.projectId !== request.projectId) {
      return failure("OwnerProjectMismatch", "PLANNING_AUTHORITY_OWNER_PROJECT_MISMATCH");
    }
    if (request.intent === "reviewPermanentDelete") {
      if (!ownerRecord.deletedAt) {
        return failure("NotWritable", "PLANNING_AUTHORITY_PERMANENT_DELETE_REQUIRES_DELETED_OWNER");
      }
      if (request.expectedPlanningEpoch !== repositoryIdentity?.repositoryEpoch
        || request.expectedPlanningRevision !== repositoryIdentity?.revision) {
        return failure("AuthorityChanged", "PLANNING_AUTHORITY_PERMANENT_DELETE_ENVELOPE_STALE");
      }
    } else if (request.intent === "reviewRestore") {
      if (!ownerRecord.deletedAt) {
        return failure(
          "NotWritable",
          "PLANNING_AUTHORITY_RESTORE_REQUIRES_DELETED_OWNER"
        );
      }
      if (!project || !isProjectWritable(project)) {
        return failure("ProjectUnavailable", "PLANNING_AUTHORITY_PROJECT_UNAVAILABLE");
      }
    } else {
      if (ownerRecord.deletedAt) {
        return failure("Deleted", "PLANNING_AUTHORITY_OWNER_DELETED");
      }
      if (ownerRecord.archivedAt || ownerRecord.status === "archived") {
        return failure("NotWritable", "PLANNING_AUTHORITY_OWNER_NOT_WRITABLE");
      }
    }
    const projectLifecycle = !project
      ? "missing" as const
      : project.deletedAt
        ? "deleted" as const
        : project.archivedAt || project.status === "archived"
          ? "archived" as const
          : "active" as const;
    const authority = {
      authorityDomain: "planning-owner" as const,
      authorityVersion: 1 as const,
      projectId: request.projectId,
      projectTitle: project?.title,
      ownerType: "review",
      ownerId: owner.id,
      ownerTitle: owner.title,
      ownerCreatedAt: owner.createdAt,
      scope: "primary",
      projectLifecycle,
      ownerLifecycle: ownerRecord.deletedAt ? "deleted" as const : "active" as const,
      projectWriteability: "writable" as const,
      ownerWriteability: "writable" as const,
      ownerProjectRelationship: "matched" as const,
      derivedEligibility: "eligible" as const,
      repositoryEpoch: repositoryIdentity?.repositoryEpoch,
      repositoryRevision: repositoryIdentity?.revision,
      evidenceDigest: digest({
        intent: request.intent,
        project: project ?? null,
        owner,
        lifecycleActionId: request.lifecycleActionId ?? null,
        exactRecycleEntryId: request.exactRecycleEntryId ?? null,
        sourceDeleteActionId: request.sourceDeleteActionId ?? null,
        impactPlanVersion: request.impactPlanVersion ?? null,
        impactDigest: request.impactDigest ?? null
      }),
      validatedAtMonotonic: dependencies.monotonicNow()
    };
    return { status: "Validated", authority: Object.freeze(authority) };
  }
  if (!project) {
    if (request.intent !== "projectCreate") {
      return failure("ProjectUnavailable", "PLANNING_AUTHORITY_PROJECT_NOT_FOUND");
    }
    return {
      status: "Validated",
      authority: Object.freeze({
        authorityDomain: "planning-owner",
        authorityVersion: 1,
        projectId: request.projectId,
        projectLifecycle: "missing-for-create",
        projectWriteability: "writable",
        derivedEligibility: "eligible",
        repositoryEpoch: repositoryIdentity?.repositoryEpoch,
        repositoryRevision: repositoryIdentity?.revision,
        evidenceDigest: digest({ projectId: request.projectId, missing: true }),
        validatedAtMonotonic: dependencies.monotonicNow()
      })
    };
  }
  if (request.intent === "projectCreate") {
    return failure("NotWritable", "PLANNING_AUTHORITY_PROJECT_ALREADY_EXISTS");
  }
  const restoringArchivedProject =
    request.intent === "projectRestore" &&
    !project.deletedAt &&
    (Boolean(project.archivedAt) || project.status === "archived");
  if (!isProjectWritable(project) && !restoringArchivedProject) {
    return failure("ProjectUnavailable", "PLANNING_AUTHORITY_PROJECT_UNAVAILABLE");
  }
  if (request.intent === "projectWrite" || request.intent === "projectRestore") {
    const authority = {
      authorityDomain: "planning-owner" as const,
      authorityVersion: 1 as const,
      projectId: project.id,
      projectTitle: project.title,
      projectLifecycle: restoringArchivedProject ? "archived" as const : "active" as const,
      projectWriteability: "writable" as const,
      derivedEligibility: "eligible" as const,
      repositoryEpoch: repositoryIdentity?.repositoryEpoch,
      repositoryRevision: repositoryIdentity?.revision,
      evidenceDigest: digest(project),
      validatedAtMonotonic: dependencies.monotonicNow()
    };
    return { status: "Validated", authority: Object.freeze(authority) };
  }

  if (!request.ownerType || !request.ownerId) {
    return failure("InternalFailure", "PLANNING_AUTHORITY_OWNER_IDENTITY_REQUIRED");
  }
  const lookup = await lookupAuthorityOwner(
    dependencies,
    planning,
    request.ownerType,
    request.ownerId
  );
  if (lookup.domain === "unsupported") {
    return failure("InternalFailure", "PLANNING_AUTHORITY_OWNER_TYPE_UNSUPPORTED");
  }
  const owner = lookup.owner;
  if (!owner) {
    if (request.intent !== "ownerCreate") {
      return failure("NotFound", "PLANNING_AUTHORITY_OWNER_NOT_FOUND");
    }
    if (
      lookup.domain !== "planning" ||
      !PLANNING_OWNER_CREATE_TYPES.has(request.ownerType)
    ) {
      return failure(
        "InternalFailure",
        "PLANNING_AUTHORITY_OWNER_CREATE_DOMAIN_UNSUPPORTED"
      );
    }
    const authority = {
      authorityDomain: "planning-owner" as const,
      authorityVersion: 1 as const,
      projectId: project.id,
      projectTitle: project.title,
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      scope: request.scope,
      projectLifecycle: "active" as const,
      ownerLifecycle: "active" as const,
      projectWriteability: "writable" as const,
      ownerWriteability: "writable" as const,
      ownerProjectRelationship: "matched" as const,
      derivedEligibility: "eligible" as const,
      repositoryEpoch: repositoryIdentity?.repositoryEpoch,
      repositoryRevision: repositoryIdentity?.revision,
      evidenceDigest: digest({ project, ownerId: request.ownerId, missing: true }),
      validatedAtMonotonic: dependencies.monotonicNow()
    };
    return { status: "Validated", authority: Object.freeze(authority) };
  }
  if (request.intent === "ownerCreate") {
    if (
      lookup.domain !== "planning" ||
      !PLANNING_OWNER_CREATE_TYPES.has(request.ownerType)
    ) {
      return failure(
        "InternalFailure",
        "PLANNING_AUTHORITY_OWNER_CREATE_DOMAIN_UNSUPPORTED"
      );
    }
    return failure("NotWritable", "PLANNING_AUTHORITY_OWNER_ALREADY_EXISTS");
  }
  if (owner.deletedAt && request.intent !== "ownerRestore") {
    return failure("Deleted", "PLANNING_AUTHORITY_OWNER_DELETED");
  }
  if (
    request.intent !== "ownerRestore" &&
    (owner.archivedAt || owner.status === "archived")
  ) {
    return failure("NotWritable", "PLANNING_AUTHORITY_OWNER_NOT_WRITABLE");
  }
  const assignedProjectId = owner.projectId ?? owner.primaryProjectId;
  if (assignedProjectId !== project.id) {
    return failure("OwnerProjectMismatch", "PLANNING_AUTHORITY_OWNER_PROJECT_MISMATCH");
  }
  const authority = {
    authorityDomain: "planning-owner" as const,
    authorityVersion: 1 as const,
    projectId: project.id,
    projectTitle: project.title,
    ownerType: request.ownerType,
    ownerId: owner.id,
    ownerTitle: owner.title ?? undefined,
    ownerCreatedAt: owner.createdAt ?? undefined,
    scope: request.scope,
    projectLifecycle: "active" as const,
    ownerLifecycle: owner.deletedAt ? "deleted" as const : "active" as const,
    projectWriteability: "writable" as const,
    ownerWriteability: "writable" as const,
    ownerProjectRelationship: "matched" as const,
    derivedEligibility: "eligible" as const,
    repositoryEpoch: repositoryIdentity?.repositoryEpoch,
    repositoryRevision: repositoryIdentity?.revision,
    evidenceDigest: digest({ project, owner }),
    validatedAtMonotonic: dependencies.monotonicNow()
  };
  return { status: "Validated", authority: Object.freeze(authority) };
}

export function createPlanningOwnerAuthorityPort(
  dependencies: PlanningOwnerAuthorityPortDependencies
) {
  async function acquire(
    request: PlanningOwnerAuthorityRequest,
    envelope?: PlanningAuthorityEnvelopeView
  ): Promise<PlanningAuthorityResult> {
    if (invalidRequest(request)) {
      return failure("InternalFailure", "PLANNING_AUTHORITY_INVALID_REQUEST");
    }
    let context: PlanningAuthorityEnvelopeView;
    let resolved;
    try {
      context = frozenContext(envelope ?? await dependencies.readPlanningEnvelope(request));
      resolved = await resolveProjectKey(dependencies, request, context.snapshot);
    } catch (error) {
      return failure("InternalFailure", stableError(error));
    }
    if (resolved.status !== "Resolved") return resolved;
    const resolvedRequest = resolved.request;
    if (invalidRequest(resolvedRequest)) {
      return failure("InternalFailure", "PLANNING_AUTHORITY_INVALID_REQUEST");
    }
    const requests = requestsFor(resolvedRequest);
    let grant;
    try {
      grant = await dependencies.leaseClient.tryAcquireMany(request.requestId, requests);
    } catch (error) {
      return leaseFailure(error);
    }
    let derived;
    try {
      derived = await deriveAuthority(
        dependencies,
        resolvedRequest,
        context.snapshot,
        context
      );
    } catch (error) {
      await dependencies.leaseClient.release(grant.token).catch(() => undefined);
      return failure("InternalFailure", stableError(error));
    }
    if (derived.status !== "Validated") {
      await dependencies.leaseClient.release(grant.token).catch(() => undefined);
      return derived;
    }
    const handle = frozenHandle(grant.requests);
    handleStates.set(handle, {
      token: grant.token,
      requests: grant.requests,
      request: { ...resolvedRequest },
      authority: derived.authority,
      context
    });
    return { status: "Validated", handle, authority: derived.authority, context };
  }

  async function acquirePlanningOwnerAuthority(
    request: PlanningOwnerAuthorityRequest
  ): Promise<PlanningAuthorityResult> {
    return acquire(request);
  }

  async function acquirePlanningOwnerAuthorityForAttestation(
    request: PlanningOwnerAuthorityRequest,
    envelope: PlanningAuthorityEnvelopeView
  ): Promise<PlanningAuthorityResult> {
    return acquire(request, envelope);
  }

  async function readValidatedPlanningAuthority(
    handle: ValidatedPlanningAuthorityHandle
  ): Promise<PlanningAuthorityResult> {
    const state = handleStates.get(handle as object);
    if (!state || !liveHandles.has(handle as object)) {
      return failure("LeaseStale", "PLANNING_AUTHORITY_HANDLE_STALE");
    }
    try {
      await dependencies.leaseClient.validate(state.token, state.requests);
      return {
        status: "Validated",
        handle,
        authority: state.authority,
        context: state.context
      };
    } catch (error) {
      liveHandles.delete(handle as object);
      return leaseFailure(error);
    }
  }

  async function revalidatePlanningAuthority(
    handle: ValidatedPlanningAuthorityHandle,
    expectedRequest?: PlanningOwnerAuthorityRequest
  ): Promise<PlanningAuthorityResult> {
    const live = await readValidatedPlanningAuthority(handle);
    if (live.status !== "Validated") return live;
    const state = handleStates.get(handle as object)!;
    if (
      expectedRequest &&
      !leaseCovers(
        state.requests,
        requestsFor({
          ...expectedRequest,
          projectId: expectedRequest.projectId ?? state.request.projectId
        })
      )
    ) {
      return failure("LeaseStale", "PLANNING_AUTHORITY_PERMIT_SCOPE_MISMATCH");
    }
    let currentContext: PlanningAuthorityEnvelopeView;
    try {
      currentContext = frozenContext(await dependencies.readPlanningEnvelope(state.request));
    } catch (error) {
      liveHandles.delete(handle as object);
      await dependencies.leaseClient.release(state.token).catch(() => undefined);
      return failure("InternalFailure", stableError(error));
    }
    if (currentContext.repositoryEpoch !== state.context.repositoryEpoch) {
      liveHandles.delete(handle as object);
      await dependencies.leaseClient.release(state.token).catch(() => undefined);
      return failure("AuthorityChanged", "PLANNING_AUTHORITY_REPOSITORY_EPOCH_MISMATCH");
    }
    if (currentContext.revision !== state.context.revision) {
      liveHandles.delete(handle as object);
      await dependencies.leaseClient.release(state.token).catch(() => undefined);
      return failure("AuthorityChanged", "PLANNING_AUTHORITY_REPOSITORY_REVISION_STALE");
    }
    const current = await deriveAuthority(
      dependencies,
      state.request,
      currentContext.snapshot,
      currentContext
    );
    if (
      current.status !== "Validated" ||
      current.authority.evidenceDigest !== state.authority.evidenceDigest
    ) {
      liveHandles.delete(handle as object);
      await dependencies.leaseClient.release(state.token).catch(() => undefined);
      return failure("AuthorityChanged", "PLANNING_AUTHORITY_CHANGED");
    }
    state.authority = current.authority;
    state.context = currentContext;
    return {
      status: "Validated",
      handle,
      authority: current.authority,
      context: currentContext
    };
  }

  async function releasePlanningOwnerAuthority(
    handle: ValidatedPlanningAuthorityHandle
  ): Promise<{ status: "Released" | "LeaseStale"; code?: string }> {
    const state = handleStates.get(handle as object);
    liveHandles.delete(handle as object);
    if (!state) return { status: "LeaseStale", code: "PLANNING_AUTHORITY_HANDLE_STALE" };
    try {
      await dependencies.leaseClient.release(state.token);
      return { status: "Released" };
    } catch (error) {
      return { status: "LeaseStale", code: stableError(error) };
    }
  }

  return {
    acquirePlanningOwnerAuthority,
    acquirePlanningOwnerAuthorityForAttestation,
    readValidatedPlanningAuthority,
    revalidatePlanningAuthority,
    releasePlanningOwnerAuthority
  };
}

export const planningOwnerAuthorityPort = createPlanningOwnerAuthorityPort({
  leaseClient: tauriOwnerAuthorityLeaseClient,
  async readPlanningEnvelope(request) {
    const {
      getPlanningFirstLayerRepositoryEnvelope,
      getPlanningRepositoryEnvelope
    } = await import("./planningRepository");
    if (
      request?.intent === "projectCreate" ||
      request?.intent === "projectWrite" ||
      request?.intent === "projectRestore" ||
      request?.intent === "ownerCreate" ||
      request?.intent === "ownerWrite" ||
      request?.intent === "provisioningRead" ||
      request?.intent === "provisioningWrite" ||
      request?.intent === "metadataWrite"
    ) {
      // Project/owner writers, provisioning, and FileRef/Binding metadata
      // authority need only first-layer Project/owner identity and lifecycle.
      // Keeping Review composition out prevents unrelated missing Review
      // structure from becoming a writer-admission prerequisite; exact Review
      // consumers remain on the full seam.
      return getPlanningFirstLayerRepositoryEnvelope() as unknown as Promise<
        PlanningAuthorityEnvelopeView
      >;
    }
    return getPlanningRepositoryEnvelope();
  },
  async readNonPlanningOwner(ownerType, ownerId) {
    const { getReadableFileRefOwnerContext } = await import("./fileRefOwnerValidator");
    const context = await getReadableFileRefOwnerContext(ownerType, ownerId);
    return context.entity as PlanningOwnerRecord;
  },
  monotonicNow: () => typeof performance === "undefined" ? Date.now() : performance.now()
});
