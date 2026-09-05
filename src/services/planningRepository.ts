import type {
  BaseEntity,
  CaptureState,
  ChangeAction,
  ChangeLog,
  CreateEntityInput,
  EntityId,
  EntityLink,
  EntitySource,
  EntityType,
  ISODateString,
  PlanningData,
  Priority,
  Project,
  ResearchDirection,
  ResearchRoutine,
  Review,
  RouteNode,
  RouteCheckpoint,
  RoutineCheckIn,
  Task,
  TaskCheckpoint,
  TaskType,
  TimeBucket,
  UpdateEntityInput
} from "../types/planning";
import {
  migrateLegacyReviewStructuredStates,
  readReviewStructuredStates,
  type ReviewStructuredStateSeed
} from "./reviewStructuredStateService";
import {
  normalizeReviewType,
  reconcileReviewOutlineSections,
  REVIEW_CORE_SCHEMA_VERSION
} from "./reviewCoreContractService";
import {
  replaceReviewTargetLinksInSnapshot,
  type ReviewTargetInput
} from "./reviewTargetEntityLinkService";
import type { ExperimentManuscriptOwnerType } from "../types/experimentManuscript";
import { tryAcquireExperimentManuscriptOwnerOperation } from "./experimentManuscriptOwnerOperationGate";
import { authorityWriterGuard } from "./authorityWriterGuard";
import {
  validatePlanningAuthorityCommitPermit,
  type PlanningAuthorityEnvelopeView,
  type PlanningOwnerAuthorityRequest,
  type ValidatedPlanningAuthorityHandle
} from "./planningOwnerAuthorityPort";
import {
  createPlanningRepositoryEnvelopeStore,
  createWebCryptoRepositoryEpoch,
  PlanningRepositoryEnvelopeError,
  type PlanningRepositoryEnvelope,
  type PlanningRepositoryIdentity,
  type PlanningRepositoryWriterSession
} from "./planningRepositoryEnvelope";
import type {
  PersistedReviewPermanentDeleteTarget,
  ReviewPermanentDeleteActionRecord
} from "./reviewPermanentDeleteFoundation";

export const PLANNING_SCHEMA_VERSION = 1;

export const PLANNING_STORAGE_KEY = "labpod.planning.v1";
const DEFAULT_DIRECTION_ID = "direction-default-research-planning";

export type PlanningPersistedReview = Omit<
  Review,
  | "reviewType"
  | "outlineSections"
  | "structuredRevision"
  | "descriptorIdentity"
  | "structuredLifecycleEvidence"
  | "structuredLifecycleStatus"
>;

export type PlanningPersistenceData = Omit<PlanningData, "reviews"> & {
  reviews: PlanningPersistedReview[];
};

const REVIEW_SECOND_LAYER_KEYS = Object.freeze([
  "reviewType",
  "outlineSections",
  "structuredRevision",
  "descriptorIdentity",
  "structuredLifecycleEvidence",
  "structuredLifecycleStatus"
] as const);

type CreateInputWithDefaults<T extends BaseEntity, K extends keyof T> = Omit<
  CreateEntityInput<T>,
  K
> &
  Partial<Pick<T, K>>;

type ProjectCreateInput = CreateInputWithDefaults<Project, "status" | "priority" | "orderIndex">;

type RouteNodeCreateInput = CreateInputWithDefaults<
  RouteNode,
  "nodeType" | "status" | "showInGantt" | "captureState" | "orderIndex"
>;

type RouteCheckpointCreateInput = CreateInputWithDefaults<
  RouteCheckpoint,
  "status" | "orderIndex"
>;

type TaskCheckpointCreateInput = CreateInputWithDefaults<
  TaskCheckpoint,
  "status" | "orderIndex"
>;

type ResearchRoutineCreateInput = CreateInputWithDefaults<
  ResearchRoutine,
  "frequency" | "targetType" | "isActive" | "orderIndex"
>;

type RoutineCheckInCreateInput = CreateInputWithDefaults<
  RoutineCheckIn,
  "title" | "checkedAt" | "periodKey" | "count"
>;

type TaskCreateInput = CreateInputWithDefaults<
  Task,
  "taskType" | "status" | "priority" | "timeBucket" | "captureState" | "orderIndex"
>;

type ReviewCreateInput = CreateInputWithDefaults<
  Review,
  | "reviewType"
  | "outlineSections"
>;

type EntityLinkCreateInput = Omit<
  EntityLink,
  "id" | "createdAt" | "updatedAt" | "schemaVersion" | "relationType"
> &
  Partial<Pick<EntityLink, "id" | "createdAt" | "updatedAt" | "schemaVersion" | "relationType">>;

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toTags(value?: string[]): string[] {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

export function normalizeRouteDate(value: unknown): ISODateString | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return undefined;
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString().slice(0, 10) === trimmed ? trimmed : undefined;
}

function normalizeRouteNodeFields<T extends Partial<RouteNode>>(routeNode: T): T {
  return {
    ...routeNode,
    startDate: normalizeRouteDate(routeNode.startDate),
    endDate: normalizeRouteDate(routeNode.endDate),
    showInGantt: routeNode.showInGantt !== false
  } as T;
}

function normalizeRouteNodePatch(
  patch: UpdateEntityInput<RouteNode>
): UpdateEntityInput<RouteNode> {
  const normalized: UpdateEntityInput<RouteNode> = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "startDate")) {
    normalized.startDate = normalizeRouteDate(patch.startDate);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "endDate")) {
    normalized.endDate = normalizeRouteDate(patch.endDate);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "showInGantt")) {
    normalized.showInGantt = patch.showInGantt !== false;
  }
  return normalized;
}

function createDefaultDirection(timestamp = now()): ResearchDirection {
  return {
    id: DEFAULT_DIRECTION_ID,
    title: "科研规划",
    description: "默认研究方向，用于兼容缺少 directionId 的旧课题。",
    tags: [],
    status: "active",
    orderIndex: 0,
    source: "system",
    schemaVersion: PLANNING_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createEmptyPlanningData(timestamp = now()): PlanningData {
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    app: "LabPod",
    exportedAt: timestamp,
    researchDirections: [createDefaultDirection(timestamp)],
    projects: [],
    routeNodes: [],
    routeCheckpoints: [],
    taskCheckpoints: [],
    researchRoutines: [],
    routineCheckIns: [],
    tasks: [],
    reviews: [],
    experimentSummaries: [],
    entityLinks: [],
    changeLogs: []
  };
}

function normalizeBase<T extends BaseEntity>(
  entity: T,
  title: string,
  source: EntitySource = "user"
): T {
  const timestamp = now();
  return {
    ...entity,
    title,
    tags: toTags(entity.tags),
    createdAt: entity.createdAt ?? timestamp,
    updatedAt: entity.updatedAt ?? timestamp,
    deletedAt: entity.deletedAt ?? undefined,
    source: entity.source ?? source,
    schemaVersion: entity.schemaVersion ?? PLANNING_SCHEMA_VERSION
  };
}

function addSystemFields<T extends BaseEntity>(
  input: CreateEntityInput<T>,
  idPrefix: string,
  title: string
): T {
  const timestamp = now();
  const source = input.source ?? "user";
  return {
    ...input,
    id: input.id ?? createId(idPrefix),
    title,
    tags: toTags(input.tags),
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    deletedAt: input.deletedAt ?? undefined,
    source,
    schemaVersion: input.schemaVersion ?? PLANNING_SCHEMA_VERSION,
    aiMetadata:
      source === "ai"
        ? {
            needsReview: true,
            ...input.aiMetadata
          }
        : input.aiMetadata
  } as T;
}

function updateEntity<T extends BaseEntity>(
  items: T[],
  id: EntityId,
  patch: UpdateEntityInput<T>
): [T[], T | undefined] {
  let updated: T | undefined;
  const updatedItems = items.map((item) => {
    if (item.id !== id || item.deletedAt) {
      return item;
    }

    updated = {
      ...item,
      ...patch,
      id: item.id,
      createdAt: item.createdAt,
      updatedAt: now(),
      schemaVersion: item.schemaVersion
    };
    return updated;
  });

  return [updatedItems, updated];
}

function softDeleteEntity<T extends BaseEntity>(items: T[], id: EntityId): [T[], boolean] {
  let deleted = false;
  const timestamp = now();
  const updatedItems = items.map((item) => {
    if (item.id !== id || item.deletedAt) {
      return item;
    }

    deleted = true;
    return {
      ...item,
      deletedAt: timestamp,
      updatedAt: timestamp
    };
  });

  return [updatedItems, deleted];
}

function appendChangeLog(
  data: PlanningData,
  entityType: EntityType,
  entityId: EntityId,
  action: ChangeAction,
  note?: string
): PlanningData {
  const timestamp = now();
  const changeLog: ChangeLog = {
    id: createId("change"),
    entityType,
    entityId,
    action,
    note,
    createdBy: "system",
    createdAt: timestamp,
    schemaVersion: PLANNING_SCHEMA_VERSION
  };

  return {
    ...data,
    changeLogs: [...data.changeLogs, changeLog],
    exportedAt: timestamp
  };
}

export function normalizePlanningData(input: Partial<PlanningData>): PlanningData {
  const timestamp = now();
  const empty = createEmptyPlanningData(timestamp);
  const researchDirections =
    input.researchDirections && input.researchDirections.length > 0
      ? input.researchDirections
      : empty.researchDirections;

  return {
    schemaVersion: input.schemaVersion ?? PLANNING_SCHEMA_VERSION,
    app: "LabPod",
    exportedAt: input.exportedAt ?? timestamp,
    researchDirections: researchDirections.map((direction, index) =>
      normalizeBase(
        {
          ...direction,
          tags: toTags(direction.tags),
          status: direction.status ?? "active",
          orderIndex: direction.orderIndex ?? index
        },
        direction.title,
        direction.source ?? "user"
      )
    ),
    projects: (input.projects ?? []).map((project, index) =>
      normalizeBase(
        {
          ...project,
          tags: toTags(project.tags),
          directionId: project.directionId ?? DEFAULT_DIRECTION_ID,
          status: project.status ?? "planning",
          priority: project.priority ?? "medium",
          orderIndex: project.orderIndex ?? index
        },
        project.title,
        project.source ?? "user"
      )
    ),
    routeNodes: (input.routeNodes ?? []).map((routeNode, index) =>
      normalizeBase(
        normalizeRouteNodeFields({
          ...routeNode,
          tags: toTags(routeNode.tags),
          nodeType: routeNode.nodeType ?? "other",
          status: routeNode.status ?? "planned",
          captureState: routeNode.captureState ?? "unscheduled",
          orderIndex: routeNode.orderIndex ?? index
        }),
        routeNode.title,
        routeNode.source ?? "user"
      )
    ),
    routeCheckpoints: (input.routeCheckpoints ?? []).map((checkpoint, index) =>
      normalizeBase(
        {
          ...checkpoint,
          tags: toTags(checkpoint.tags),
          status: checkpoint.status ?? "planned",
          orderIndex: checkpoint.orderIndex ?? index
        },
        checkpoint.title,
        checkpoint.source ?? "user"
      )
    ),
    taskCheckpoints: (input.taskCheckpoints ?? []).map((checkpoint, index) =>
      normalizeBase(
        {
          ...checkpoint,
          tags: toTags(checkpoint.tags),
          status: checkpoint.status ?? "planned",
          orderIndex: checkpoint.orderIndex ?? index
        },
        checkpoint.title,
        checkpoint.source ?? "user"
      )
    ),
    researchRoutines: (input.researchRoutines ?? []).map((routine, index) =>
      normalizeBase(
        {
          ...routine,
          tags: toTags(routine.tags),
          frequency: routine.frequency ?? "daily",
          targetType: routine.targetType ?? "count",
          isActive: routine.isActive ?? true,
          orderIndex: routine.orderIndex ?? index
        },
        routine.title,
        routine.source ?? "user"
      )
    ),
    routineCheckIns: (input.routineCheckIns ?? []).map((checkIn) =>
      normalizeBase(
        {
          ...checkIn,
          tags: toTags(checkIn.tags),
          title: checkIn.title ?? "Routine check-in",
          checkedAt: checkIn.checkedAt ?? timestamp,
          periodKey: checkIn.periodKey ?? "",
          count: checkIn.count ?? 1
        },
        checkIn.title ?? "Routine check-in",
        checkIn.source ?? "user"
      )
    ),
    tasks: (input.tasks ?? []).map((task, index) =>
      normalizeBase(
        {
          ...task,
          tags: toTags(task.tags),
          taskType: task.taskType ?? "other",
          status: task.status ?? "todo",
          priority: task.priority ?? "medium",
          timeBucket: task.timeBucket ?? "none",
          captureState: task.captureState ?? "unscheduled",
          orderIndex: task.orderIndex ?? index
        },
        task.title,
        task.source ?? "user"
      )
    ),
    reviews: (input.reviews ?? []).map((review) => {
      const reviewType = normalizeReviewType(review.reviewType);
      return normalizeBase(
        {
          id: review.id,
          title: review.title,
          description: review.description,
          projectId: review.projectId,
          periodStart: review.periodStart,
          periodEnd: review.periodEnd,
          periodLabel: review.periodLabel,
          customFields: review.customFields,
          aiMetadata: review.aiMetadata,
          archivedAt: review.archivedAt,
          deletedAt: review.deletedAt,
          source: review.source,
          createdAt: review.createdAt,
          updatedAt: review.updatedAt,
          reviewType,
          outlineSections: reconcileReviewOutlineSections(
            reviewType,
            review.outlineSections
          ),
          tags: toTags(review.tags),
          schemaVersion: REVIEW_CORE_SCHEMA_VERSION
        },
        review.title,
        review.source ?? "user"
      );
    }),
    experimentSummaries: (input.experimentSummaries ?? []).map((experiment) =>
      normalizeBase(
        {
          ...experiment,
          tags: toTags(experiment.tags),
          fileRefs: experiment.fileRefs ?? []
        },
        experiment.title,
        experiment.source ?? "user"
      )
    ),
    entityLinks: (input.entityLinks ?? []).map((link) => ({
      ...link,
      relationType: link.relationType ?? "related_to",
      createdAt: link.createdAt ?? timestamp,
      updatedAt: link.updatedAt ?? timestamp,
      schemaVersion: link.schemaVersion ?? PLANNING_SCHEMA_VERSION
    })),
    changeLogs: (input.changeLogs ?? []).map((changeLog) => ({
      ...changeLog,
      createdBy: changeLog.createdBy ?? "system",
      createdAt: changeLog.createdAt ?? timestamp,
      schemaVersion: changeLog.schemaVersion ?? PLANNING_SCHEMA_VERSION
    }))
  };
}

export function stripReviewSecondLayerFields(
  review: Review | PlanningPersistedReview
): PlanningPersistedReview {
  const firstLayer = { ...review } as Record<string, unknown>;
  for (const key of REVIEW_SECOND_LAYER_KEYS) {
    delete firstLayer[key];
  }
  return firstLayer as unknown as PlanningPersistedReview;
}

export function stripReviewSecondLayerPatch(
  patch: UpdateEntityInput<Review>
): UpdateEntityInput<PlanningPersistedReview> {
  const firstLayer = { ...patch } as Record<string, unknown>;
  for (const key of REVIEW_SECOND_LAYER_KEYS) {
    delete firstLayer[key];
  }
  return firstLayer as UpdateEntityInput<PlanningPersistedReview>;
}

export function normalizePlanningPersistenceData(
  input: Partial<PlanningData> | Partial<PlanningPersistenceData>
): PlanningPersistenceData {
  const normalized = normalizePlanningData(input as Partial<PlanningData>);
  return {
    ...normalized,
    reviews: normalized.reviews.map(stripReviewSecondLayerFields)
  };
}

export async function initializeEmptyPlanningData(): Promise<PlanningData> {
  const timestamp = now();
  const initialized = createEmptyPlanningData(timestamp);
  return appendChangeLog(
    initialized,
    "project",
    "planning-empty",
    "created",
    "Initialized empty planning data without legacy Project fallback."
  );
}

function isPlanningDataSnapshot(value: unknown): value is PlanningPersistenceData {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PlanningData, unknown>>;
  return (
    candidate.app === "LabPod" &&
    typeof candidate.schemaVersion === "number" &&
    typeof candidate.exportedAt === "string" &&
    Array.isArray(candidate.researchDirections) &&
    Array.isArray(candidate.projects) &&
    Array.isArray(candidate.routeNodes) &&
    Array.isArray(candidate.routeCheckpoints) &&
    Array.isArray(candidate.taskCheckpoints) &&
    Array.isArray(candidate.researchRoutines) &&
    Array.isArray(candidate.routineCheckIns) &&
    Array.isArray(candidate.tasks) &&
    Array.isArray(candidate.reviews) &&
    Array.isArray(candidate.experimentSummaries) &&
    Array.isArray(candidate.entityLinks) &&
    Array.isArray(candidate.changeLogs)
  );
}

const planningRepositoryEnvelopeStore =
  createPlanningRepositoryEnvelopeStore<PlanningPersistenceData>({
    storageKey: PLANNING_STORAGE_KEY,
    getStorage() {
      if (
        typeof window === "undefined" ||
        typeof window.localStorage === "undefined"
      ) {
        return undefined;
      }
      return window.localStorage;
    },
    async createInitialSnapshot() {
      return normalizePlanningPersistenceData(await initializeEmptyPlanningData());
    },
    normalizeSnapshot: normalizePlanningPersistenceData,
    isSnapshot: isPlanningDataSnapshot,
    createRepositoryEpoch: createWebCryptoRepositoryEpoch
  });

export function activatePlanningRepositoryProducerWriter(
  session: PlanningRepositoryWriterSession
) {
  planningRepositoryEnvelopeStore.activateWriter(session);
}

export function revokePlanningRepositoryProducerWriter(
  session: PlanningRepositoryWriterSession
) {
  planningRepositoryEnvelopeStore.revokeWriter(session);
}

type LegacyReviewPersistenceRecord = PlanningPersistedReview &
  Partial<
    Pick<
      Review,
      | "reviewType"
      | "outlineSections"
      | "structuredRevision"
      | "descriptorIdentity"
      | "structuredLifecycleEvidence"
      | "structuredLifecycleStatus"
    >
  >;

let reviewPersistenceConvergenceTail: Promise<void> = Promise.resolve();

function serializeReviewPersistenceConvergence<T>(operation: () => Promise<T>) {
  const run = reviewPersistenceConvergenceTail.then(operation, operation);
  reviewPersistenceConvergenceTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function legacyReviewStructuredSeeds(
  snapshot: PlanningPersistenceData
): ReviewStructuredStateSeed[] {
  return (snapshot.reviews as LegacyReviewPersistenceRecord[]).flatMap((review) => {
    const hasLegacySecondLayer = REVIEW_SECOND_LAYER_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(review, key)
    );
    if (!hasLegacySecondLayer) return [];
    const reviewType = normalizeReviewType(review.reviewType);
    return [{
      reviewId: review.id,
      reviewType,
      outlineSections: reconcileReviewOutlineSections(
        reviewType,
        review.outlineSections
      )
    }];
  });
}

async function readConvergedPlanningPersistenceEnvelope(): Promise<
  PlanningRepositoryEnvelope<PlanningPersistenceData>
> {
  return serializeReviewPersistenceConvergence(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const envelope = await planningRepositoryEnvelopeStore.readEnvelope();
      const legacySeeds = legacyReviewStructuredSeeds(envelope.snapshot);
      if (legacySeeds.length === 0) return envelope;

      // Legacy fields are migration input only. The SQLite insert is idempotent
      // and authoritative before the Planning envelope is physically scrubbed.
      await migrateLegacyReviewStructuredStates(legacySeeds);
      const result = await planningRepositoryEnvelopeStore.commitSnapshot({
        expectedEpoch: envelope.repositoryEpoch,
        expectedRevision: envelope.revision,
        nextSnapshot: envelope.snapshot
      });
      if (result.status === "committed" || result.status === "unchanged") {
        return result.envelope;
      }
    }
    throw new PlanningRepositoryEnvelopeError(
      "PLANNING_REPOSITORY_READ_BACK_MISMATCH"
    );
  });
}

async function composePlanningData(
  snapshot: PlanningPersistenceData
): Promise<PlanningData> {
  if (snapshot.reviews.length === 0) {
    return { ...snapshot, reviews: [] };
  }
  const states = await readReviewStructuredStates(
    snapshot.reviews.map((review) => review.id)
  );
  const stateById = new Map(states.map((state) => [state.reviewId, state]));
  if (stateById.size !== snapshot.reviews.length) {
    throw new Error("SECOND_LAYER_NOT_PROVISIONED");
  }
  const reviews = snapshot.reviews.map((review) => {
    const state = stateById.get(review.id);
    if (!state) throw new Error("SECOND_LAYER_NOT_PROVISIONED");
    return {
      ...review,
      reviewType: state.reviewType,
      outlineSections: state.outlineSections,
      structuredRevision: state.structuredRevision,
      descriptorIdentity: state.descriptorIdentity,
      structuredLifecycleEvidence: state.lifecycleEvidence,
      structuredLifecycleStatus: state.lifecycleStatus
    } satisfies Review;
  });
  return { ...snapshot, reviews };
}

export async function getPlanningRepositoryEnvelope(): Promise<
  PlanningRepositoryEnvelope<PlanningData>
> {
  const envelope = await readConvergedPlanningPersistenceEnvelope();
  return {
    ...envelope,
    snapshot: await composePlanningData(envelope.snapshot)
  };
}

/**
 * Returns the canonical Planning envelope without composing Review-owned
 * second-layer fields. This projection is only for first-layer owner identity,
 * lifecycle and non-Review reads. Review consumers must continue to use
 * getPlanningRepositoryEnvelope() so a missing SQLite second layer fails
 * closed instead of being synthesized from Planning bytes.
 */
export async function getPlanningFirstLayerRepositoryEnvelope(): Promise<
  PlanningRepositoryEnvelope<PlanningPersistenceData>
> {
  return readConvergedPlanningPersistenceEnvelope();
}

export async function getPlanningFirstLayerData(): Promise<PlanningPersistenceData> {
  return (await getPlanningFirstLayerRepositoryEnvelope()).snapshot;
}

export async function getPlanningData(): Promise<PlanningData> {
  return (await getPlanningRepositoryEnvelope()).snapshot;
}

export type PlanningSnapshotCommitFailureStatus =
  | "epoch_mismatch"
  | "revision_stale"
  | "candidate_invalid"
  | "permit_invalid"
  | "identity_mismatch"
  | "lease_mismatch"
  | "repository_unavailable";

export class PlanningSnapshotCommitError extends Error {
  constructor(
    readonly status: PlanningSnapshotCommitFailureStatus,
    readonly expectedIdentity: PlanningRepositoryIdentity,
    readonly currentIdentity: PlanningRepositoryIdentity,
    readonly code: string
  ) {
    super(code);
    this.name = "PlanningSnapshotCommitError";
  }
}

function experimentLifecycleOwner(type: EntityType, id: EntityId) {
  return type === "experiment" || type === "experimentRun"
    ? { ownerType: type as ExperimentManuscriptOwnerType, ownerId: id }
    : undefined;
}

function acquirePlanningEntityLinkLifecycleGates(previous: EntityLink[], next: EntityLink[]) {
  const previousById = new Map(previous.map((link) => [link.id, link]));
  const nextById = new Map(next.map((link) => [link.id, link]));
  const changed = [...new Set([...previousById.keys(), ...nextById.keys()])].flatMap((id) => {
    const before = previousById.get(id);
    const after = nextById.get(id);
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [before, after].filter(Boolean) as EntityLink[];
  });
  const owners = changed.flatMap((link) => [
    experimentLifecycleOwner(link.sourceType, link.sourceId),
    experimentLifecycleOwner(link.targetType, link.targetId)
  ]).filter((owner): owner is { ownerType: ExperimentManuscriptOwnerType; ownerId: string } => Boolean(owner));
  const unique = [...new Map(owners.map((owner) => [`${owner.ownerType}\u0000${owner.ownerId}`, owner])).values()]
    .sort((a, b) => `${a.ownerType}:${a.ownerId}`.localeCompare(`${b.ownerType}:${b.ownerId}`));
  const releases: Array<() => void> = [];
  for (const owner of unique) {
    const release = tryAcquireExperimentManuscriptOwnerOperation(
      owner.ownerType,
      owner.ownerId,
      "businessDependencyWrite"
    );
    if (!release) {
      releases.reverse().forEach((item) => item());
      throw new Error("LIFECYCLE_SESSION_SAVING: Planning EntityLink owner hard delete is active.");
    }
    releases.push(release);
  }
  return () => releases.reverse().forEach((release) => release());
}

async function commitPlanningSnapshot(
  context: PlanningAuthorityEnvelopeView,
  buildCandidate: (snapshot: PlanningData) => PlanningData
): Promise<PlanningData> {
  if (
    !context?.repositoryEpoch ||
    !context.revision ||
    !isPlanningDataSnapshot(context.snapshot)
  ) {
    const unknownIdentity = {
      repositoryEpoch: context?.repositoryEpoch ?? "",
      revision: context?.revision ?? ""
    };
    throw new PlanningSnapshotCommitError(
      "candidate_invalid",
      unknownIdentity,
      unknownIdentity,
      "PLANNING_SNAPSHOT_CONTEXT_INVALID"
    );
  }
  const previous = clone(context.snapshot);
  const rawCandidate = buildCandidate(clone(context.snapshot));
  const candidateWithStableExport = normalizePlanningData({
    ...rawCandidate,
    exportedAt: previous.exportedAt
  });
  const changed = JSON.stringify(previous) !== JSON.stringify(candidateWithStableExport);
  const normalized = normalizePlanningData({
    ...candidateWithStableExport,
    exportedAt: changed ? now() : previous.exportedAt
  });
  const release = acquirePlanningEntityLinkLifecycleGates(
    previous.entityLinks,
    normalized.entityLinks
  );
  try {
    const result = await planningRepositoryEnvelopeStore.commitSnapshot({
      expectedEpoch: context.repositoryEpoch,
      expectedRevision: context.revision,
      nextSnapshot: normalized
    });
    if (result.status === "committed" || result.status === "unchanged") {
      return normalized;
    }
    const currentIdentity = "currentIdentity" in result
      ? result.currentIdentity
      : result.expectedIdentity;
    throw new PlanningSnapshotCommitError(
      result.status,
      result.expectedIdentity,
      currentIdentity,
      result.status === "epoch_mismatch"
        ? "PLANNING_SNAPSHOT_EPOCH_MISMATCH"
        : "PLANNING_SNAPSHOT_REVISION_STALE"
    );
  } catch (error) {
    if (error instanceof PlanningRepositoryEnvelopeError) {
      const expectedIdentity = {
        repositoryEpoch: context.repositoryEpoch,
        revision: context.revision
      };
      throw new PlanningSnapshotCommitError(
        "repository_unavailable",
        expectedIdentity,
        expectedIdentity,
        error.code
      );
    }
    throw error;
  } finally {
    release();
  }
}

function reviewLifecycleAuthorityRequest(
  input: ReviewLifecyclePlanningSnapshotCommitInput
): PlanningOwnerAuthorityRequest {
  return {
    intent: input.action === "soft_delete" ? "reviewSoftDelete" : "reviewRestore",
    requestId: input.action === "soft_delete"
      ? `review-soft-delete-${input.reviewId}`
      : `review-restore-${input.reviewId}`,
    projectId: input.projectId,
    ownerType: "review",
    ownerId: input.reviewId,
    scope: "primary"
  };
}

function assertReviewLifecycleCandidate(input: ReviewLifecyclePlanningSnapshotCommitInput) {
  const { context, reviewId, projectId, action, nextSnapshot } = input;
  const expectedIdentity = {
    repositoryEpoch: context.repositoryEpoch,
    revision: context.revision
  };
  const currentReview = context.snapshot.reviews.find((review) => review.id === reviewId);
  const nextReview = nextSnapshot.reviews.find((review) => review.id === reviewId);
  const stableCollections: Array<keyof PlanningData> = [
    "researchDirections",
    "projects",
    "routeNodes",
    "routeCheckpoints",
    "taskCheckpoints",
    "researchRoutines",
    "routineCheckIns",
    "tasks",
    "experimentSummaries",
    "entityLinks"
  ];
  const otherReviewsStable = JSON.stringify(
    context.snapshot.reviews.filter((review) => review.id !== reviewId)
  ) === JSON.stringify(nextSnapshot.reviews.filter((review) => review.id !== reviewId));
  const currentReviewComparable = currentReview
    ? JSON.stringify(currentReview)
    : undefined;
  const nextReviewComparable = nextReview
    ? JSON.stringify({
        ...nextReview,
        deletedAt: currentReview?.deletedAt,
        updatedAt: currentReview?.updatedAt
      })
    : undefined;
  const changeLogPrefixStable = JSON.stringify(
    nextSnapshot.changeLogs.slice(0, context.snapshot.changeLogs.length)
  ) === JSON.stringify(context.snapshot.changeLogs);
  const appendedChangeLogs = nextSnapshot.changeLogs.slice(context.snapshot.changeLogs.length);
  const expectedAction = action === "soft_delete" ? "deleted" : "restored";
  const changeLogValid =
    appendedChangeLogs.length === 1 &&
    appendedChangeLogs[0].id === input.planningEffectId &&
    appendedChangeLogs[0].entityType === "review" &&
    appendedChangeLogs[0].entityId === reviewId &&
    appendedChangeLogs[0].action === expectedAction &&
    appendedChangeLogs[0].note ===
      `Review lifecycle ${expectedAction}; lifecycleActionId=${input.lifecycleActionId}`;
  const lifecycleValid = action === "soft_delete"
    ? Boolean(
        !currentReview?.deletedAt &&
        nextReview?.deletedAt &&
        nextReview.updatedAt !== currentReview?.updatedAt
      )
    : Boolean(
        currentReview?.deletedAt &&
        !nextReview?.deletedAt &&
        nextReview?.updatedAt !== currentReview?.updatedAt
      );
  const candidateValid =
    context.snapshot.app === nextSnapshot.app &&
    context.snapshot.schemaVersion === nextSnapshot.schemaVersion &&
    currentReview?.projectId === projectId &&
    nextReview?.projectId === projectId &&
    context.snapshot.reviews.length === nextSnapshot.reviews.length &&
    otherReviewsStable &&
    currentReviewComparable === nextReviewComparable &&
    changeLogPrefixStable &&
    changeLogValid &&
    lifecycleValid &&
    stableCollections.every(
      (key) => JSON.stringify(context.snapshot[key]) === JSON.stringify(nextSnapshot[key])
    );
  if (!candidateValid) {
    throw new PlanningSnapshotCommitError(
      "candidate_invalid",
      expectedIdentity,
      expectedIdentity,
      "PLANNING_REVIEW_LIFECYCLE_CANDIDATE_INVALID"
    );
  }
}

export interface ReviewLifecyclePlanningSnapshotCommitInput {
  context: PlanningAuthorityEnvelopeView;
  authorityPermit: ValidatedPlanningAuthorityHandle;
  reviewId: EntityId;
  projectId: EntityId;
  action: "soft_delete" | "restore";
  lifecycleActionId: string;
  planningEffectId: string;
  nextSnapshot: PlanningData;
}

export interface ReviewLifecyclePlanningSnapshotCommitResult {
  committedPlanningEpoch: string;
  committedPlanningRevision: string;
  snapshot: PlanningData;
  planningEffectId: string;
}

export async function commitReviewLifecyclePlanningSnapshot(
  input: ReviewLifecyclePlanningSnapshotCommitInput
): Promise<ReviewLifecyclePlanningSnapshotCommitResult> {
  const permit = validatePlanningAuthorityCommitPermit(
    input.authorityPermit,
    reviewLifecycleAuthorityRequest(input),
    input.context
  );
  if (permit.status !== "Validated") {
    const identityFailure = permit.code.includes("IDENTITY") || permit.code.includes("CONTEXT");
    const leaseFailure = permit.code.includes("LEASE") || permit.code.includes("SCOPE");
    throw new PlanningSnapshotCommitError(
      identityFailure ? "identity_mismatch" : leaseFailure ? "lease_mismatch" : "permit_invalid",
      {
        repositoryEpoch: input.context.repositoryEpoch,
        revision: input.context.revision
      },
      {
        repositoryEpoch: input.context.repositoryEpoch,
        revision: input.context.revision
      },
      permit.code
    );
  }
  assertReviewLifecycleCandidate(input);
  const snapshot = await commitPlanningSnapshot(input.context, () => input.nextSnapshot);
  const committed = await getPlanningRepositoryEnvelope();
  const exactEffect = committed.snapshot.changeLogs.find(
    (entry) => entry.id === input.planningEffectId
  );
  if (
    !exactEffect
    || exactEffect.entityType !== "review"
    || exactEffect.entityId !== input.reviewId
    || exactEffect.action !== (input.action === "soft_delete" ? "deleted" : "restored")
  ) {
    throw new PlanningSnapshotCommitError(
      "candidate_invalid",
      { repositoryEpoch: input.context.repositoryEpoch, revision: input.context.revision },
      { repositoryEpoch: committed.repositoryEpoch, revision: committed.revision },
      "PLANNING_REVIEW_LIFECYCLE_EFFECT_READBACK_INVALID"
    );
  }
  return {
    committedPlanningEpoch: committed.repositoryEpoch,
    committedPlanningRevision: committed.revision,
    snapshot,
    planningEffectId: input.planningEffectId
  };
}

export interface ReviewPermanentDeletePlanningSnapshotCommitInput {
  context: PlanningAuthorityEnvelopeView;
  authorityPermit: ValidatedPlanningAuthorityHandle;
  action: ReviewPermanentDeleteActionRecord;
  targets: PersistedReviewPermanentDeleteTarget[];
}

export interface ReviewPermanentDeletePlanningCommitResult {
  committedPlanningEpoch: string;
  committedPlanningRevision: string;
  snapshot: PlanningData;
  planningEffectId: string;
}

export type ReviewPermanentDeletePlanningCorrelation =
  | { status: "Proven"; result: ReviewPermanentDeletePlanningCommitResult }
  | { status: "NeedsCommit" }
  | { status: "Conflict"; code: string };

function reviewPermanentDeleteAuthorityRequest(
  action: ReviewPermanentDeleteActionRecord
): PlanningOwnerAuthorityRequest {
  return {
    intent: "reviewPermanentDelete",
    requestId: `review-permanent-delete-${action.lifecycleActionId}`,
    projectId: action.projectId,
    ownerType: "review",
    ownerId: action.reviewId,
    scope: "primary",
    lifecycleActionId: action.lifecycleActionId,
    exactRecycleEntryId: action.exactRecycleEntryId,
    sourceDeleteActionId: action.sourceDeleteActionId,
    impactPlanVersion: action.impactPlanVersion,
    impactDigest: action.impactDigest,
    expectedPlanningEpoch: action.expectedPlanningEpoch,
    expectedPlanningRevision: action.expectedPlanningRevision
  };
}

function reviewPermanentDeleteCandidateError(
  context: PlanningAuthorityEnvelopeView,
  code: string
) {
  const identity = {
    repositoryEpoch: context.repositoryEpoch,
    revision: context.revision
  };
  return new PlanningSnapshotCommitError("candidate_invalid", identity, identity, code);
}

function targetsForKind(
  targets: PersistedReviewPermanentDeleteTarget[],
  targetKind: PersistedReviewPermanentDeleteTarget["targetKind"]
) {
  return targets
    .filter((target) => target.targetKind === targetKind)
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
}

function isContentFreeReviewAuditLog(log: ChangeLog) {
  return log.before === undefined
    && log.after === undefined
    && (
      log.note === undefined
      || /^Review lifecycle (?:deleted|restored); lifecycleActionId=[A-Za-z0-9:_-]+$/.test(log.note)
    );
}

function permanentDeleteEffectLog(action: ReviewPermanentDeleteActionRecord): ChangeLog {
  return {
    id: action.planningEffectId,
    entityType: "review",
    entityId: action.reviewId,
    action: "permanently_deleted",
    note: `lifecycleActionId=${action.lifecycleActionId};projectId=${action.projectId}`,
    createdBy: "system",
    createdAt: action.confirmedAt,
    schemaVersion: PLANNING_SCHEMA_VERSION
  };
}

export function buildReviewPermanentDeletePlanningCandidate(input: {
  context: PlanningAuthorityEnvelopeView;
  action: ReviewPermanentDeleteActionRecord;
  targets: PersistedReviewPermanentDeleteTarget[];
}): PlanningData {
  const { context, action, targets } = input;
  const source = context.snapshot;
  const review = source.reviews.find((item) => item.id === action.reviewId);
  if (
    !review
    || review.projectId !== action.projectId
    || review.updatedAt !== action.expectedReviewUpdatedAt
    || review.deletedAt !== action.expectedReviewDeletedAt
    || context.repositoryEpoch !== action.expectedPlanningEpoch
    || context.revision !== action.expectedPlanningRevision
    || source.changeLogs.some((log) => log.id === action.planningEffectId)
  ) {
    throw reviewPermanentDeleteCandidateError(
      context,
      "PLANNING_REVIEW_PERMANENT_DELETE_SOURCE_INVALID"
    );
  }

  const entityTargets = targetsForKind(targets, "entity_link");
  const currentEntityLinks = source.entityLinks
    .filter((link) =>
      (link.sourceType === "review" && link.sourceId === action.reviewId)
      || (link.targetType === "review" && link.targetId === action.reviewId)
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const entityTargetsExact = entityTargets.length === currentEntityLinks.length
    && entityTargets.every((target, index) => {
      const link = currentEntityLinks[index];
      return target.disposition === "DELETE"
        && target.targetId === link.id
        && target.expectedRevision === link.updatedAt
        && target.ownerType === null
        && target.ownerId === null
        && target.manuscriptChannel === null;
    });

  const changeTargets = targetsForKind(targets, "change_log");
  const currentChangeLogs = source.changeLogs
    .filter((log) => log.entityType === "review" && log.entityId === action.reviewId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const changeTargetsExact = changeTargets.length === currentChangeLogs.length
    && changeTargets.every((target, index) => {
      const log = currentChangeLogs[index];
      const validDisposition = target.disposition === "DELETE"
        || target.disposition === "SANITIZE"
        || target.disposition === "KEEP_AUDIT_ONLY";
      return validDisposition
        && target.targetId === log.id
        && target.expectedRevision === log.createdAt
        && target.ownerType === null
        && target.ownerId === null
        && target.manuscriptChannel === null
        && (target.disposition !== "KEEP_AUDIT_ONLY" || isContentFreeReviewAuditLog(log));
    });

  const targetKeys = targets.map((target) => `${target.targetKind}\u0000${target.targetId}`);
  if (
    new Set(targetKeys).size !== targetKeys.length
    || targets.some((target) => target.targetKind === "binding" || target.targetKind === "file_ref")
      && targets.some((target) =>
        (target.targetKind === "binding" || target.targetKind === "file_ref")
        && (
          target.ownerType !== "review"
          || target.ownerId !== action.reviewId
          || !target.manuscriptChannel
        )
      )
    || !entityTargetsExact
    || !changeTargetsExact
  ) {
    throw reviewPermanentDeleteCandidateError(
      context,
      "PLANNING_REVIEW_PERMANENT_DELETE_TARGET_SCOPE_INVALID"
    );
  }

  const entityTargetIds = new Set(entityTargets.map((target) => target.targetId));
  const changeTargetsById = new Map(changeTargets.map((target) => [target.targetId, target]));
  const changeLogs = source.changeLogs.flatMap((log): ChangeLog[] => {
    const target = changeTargetsById.get(log.id);
    if (!target) return [log];
    if (target.disposition === "DELETE") return [];
    if (target.disposition === "SANITIZE") {
      const { before: _before, after: _after, note: _note, ...auditShell } = log;
      return [auditShell];
    }
    return [log];
  });

  return {
    ...source,
    reviews: source.reviews.filter((item) => item.id !== action.reviewId),
    entityLinks: source.entityLinks.filter((link) => !entityTargetIds.has(link.id)),
    changeLogs: [...changeLogs, permanentDeleteEffectLog(action)]
  };
}

export function correlateReviewPermanentDeletePlanningEffect(input: {
  envelope: PlanningAuthorityEnvelopeView;
  action: ReviewPermanentDeleteActionRecord;
  targets: PersistedReviewPermanentDeleteTarget[];
}): ReviewPermanentDeletePlanningCorrelation {
  const { envelope, action, targets } = input;
  if (envelope.repositoryEpoch !== action.expectedPlanningEpoch) {
    return { status: "Conflict", code: "review_permanent_delete_planning_conflict" };
  }
  const exactEffect = envelope.snapshot.changeLogs.find(
    (log) => log.id === action.planningEffectId
  );
  if (exactEffect) {
    const expectedEffect = permanentDeleteEffectLog(action);
    if (JSON.stringify(exactEffect) !== JSON.stringify(expectedEffect)) {
      return { status: "Conflict", code: "review_permanent_delete_planning_effect_identity_conflict" };
    }
    let currentRevision: bigint;
    let plannedRevision: bigint;
    try {
      currentRevision = BigInt(envelope.revision);
      plannedRevision = BigInt(action.plannedCommittedPlanningRevision);
    } catch {
      return { status: "Conflict", code: "review_permanent_delete_planning_identity_invalid" };
    }
    const entityTargets = targetsForKind(targets, "entity_link");
    const changeTargets = targetsForKind(targets, "change_log");
    const exactEntityState = entityTargets.every((target) =>
      !envelope.snapshot.entityLinks.some((link) => link.id === target.targetId)
    ) && !envelope.snapshot.entityLinks.some((link) =>
      (link.sourceType === "review" && link.sourceId === action.reviewId)
      || (link.targetType === "review" && link.targetId === action.reviewId)
    );
    const exactChangeState = changeTargets.every((target) => {
      const log = envelope.snapshot.changeLogs.find((item) => item.id === target.targetId);
      if (target.disposition === "DELETE") return !log;
      if (!log || log.createdAt !== target.expectedRevision) return false;
      if (target.disposition === "SANITIZE") {
        return log.before === undefined && log.after === undefined && log.note === undefined;
      }
      return isContentFreeReviewAuditLog(log);
    });
    const allowedReviewLogIds = new Set([
      ...changeTargets.map((target) => target.targetId),
      action.planningEffectId
    ]);
    const noUnplannedReviewHistory = envelope.snapshot.changeLogs.every((log) =>
      log.entityType !== "review"
      || log.entityId !== action.reviewId
      || allowedReviewLogIds.has(log.id)
    );
    if (
      currentRevision >= plannedRevision
      && !envelope.snapshot.reviews.some((review) => review.id === action.reviewId)
      && exactEntityState
      && exactChangeState
      && noUnplannedReviewHistory
    ) {
      return {
        status: "Proven",
        result: {
          committedPlanningEpoch: action.expectedPlanningEpoch,
          committedPlanningRevision: action.plannedCommittedPlanningRevision,
          snapshot: envelope.snapshot,
          planningEffectId: action.planningEffectId
        }
      };
    }
    return { status: "Conflict", code: "review_permanent_delete_planning_effect_state_conflict" };
  }

  if (
    envelope.revision === action.expectedPlanningRevision
    && envelope.snapshot.reviews.some((review) =>
      review.id === action.reviewId
      && review.projectId === action.projectId
      && review.updatedAt === action.expectedReviewUpdatedAt
      && review.deletedAt === action.expectedReviewDeletedAt
    )
  ) {
    try {
      buildReviewPermanentDeletePlanningCandidate({
        context: envelope,
        action,
        targets
      });
      return { status: "NeedsCommit" };
    } catch {
      return { status: "Conflict", code: "review_permanent_delete_planning_target_conflict" };
    }
  }
  if (!envelope.snapshot.reviews.some((review) => review.id === action.reviewId)) {
    return { status: "Conflict", code: "review_permanent_delete_target_without_exact_effect" };
  }
  return { status: "Conflict", code: "review_permanent_delete_planning_conflict" };
}

export async function commitReviewPermanentDeletePlanningSnapshot(
  input: ReviewPermanentDeletePlanningSnapshotCommitInput
): Promise<ReviewPermanentDeletePlanningCommitResult> {
  const permit = validatePlanningAuthorityCommitPermit(
    input.authorityPermit,
    reviewPermanentDeleteAuthorityRequest(input.action),
    input.context
  );
  if (permit.status !== "Validated") {
    const identityFailure = permit.code.includes("IDENTITY") || permit.code.includes("CONTEXT");
    const leaseFailure = permit.code.includes("LEASE") || permit.code.includes("SCOPE");
    throw new PlanningSnapshotCommitError(
      identityFailure ? "identity_mismatch" : leaseFailure ? "lease_mismatch" : "permit_invalid",
      { repositoryEpoch: input.context.repositoryEpoch, revision: input.context.revision },
      { repositoryEpoch: input.context.repositoryEpoch, revision: input.context.revision },
      permit.code
    );
  }
  const candidate = buildReviewPermanentDeletePlanningCandidate({
    context: input.context,
    action: input.action,
    targets: input.targets
  });
  await commitPlanningSnapshot(input.context, () => candidate);
  const committed = await getPlanningRepositoryEnvelope();
  const correlation = correlateReviewPermanentDeletePlanningEffect({
    envelope: committed,
    action: input.action,
    targets: input.targets
  });
  if (correlation.status !== "Proven") {
    throw reviewPermanentDeleteCandidateError(
      committed,
      correlation.status === "Conflict"
        ? correlation.code
        : "PLANNING_REVIEW_PERMANENT_DELETE_EFFECT_READBACK_INVALID"
    );
  }
  return correlation.result;
}

export async function createProject(input: ProjectCreateInput): Promise<Project> {
  const project = addSystemFields<Project>(
    {
      ...input,
      directionId: input.directionId ?? DEFAULT_DIRECTION_ID,
      status: input.status ?? "planning",
      priority: input.priority ?? "medium",
      orderIndex: input.orderIndex ?? 0,
      tags: input.tags ?? []
    },
    "project",
    input.title
  );

  await authorityWriterGuard.run({
    request: {
      intent: "projectCreate",
      requestId: `planning-project-create-${project.id}`,
      projectId: project.id
    },
    invalidation: { domain: "planning", projectId: project.id },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) =>
      appendChangeLog(
        {
          ...data,
          projects: [...data.projects, project]
        },
        "project",
        project.id,
        "created"
      ))
  });

  return project;
}

export async function updateProject(
  projectId: EntityId,
  patch: UpdateEntityInput<Project>,
  authorityPermit?: ValidatedPlanningAuthorityHandle
): Promise<Project | undefined> {
  let updated: Project | undefined;
  await authorityWriterGuard.run({
    request: {
      intent: "projectWrite",
      requestId: `planning-project-update-${projectId}`,
      projectId
    },
    permit: authorityPermit,
    invalidation: { domain: "planning", projectId },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [projects, item] = updateEntity(data.projects, projectId, patch);
      updated = item;
      return item
        ? appendChangeLog({ ...data, projects }, "project", projectId, "updated")
        : data;
    })
  });
  return updated;
}

export interface DeletePlanningProjectOptions {
  note?: string;
  authorityPermit?: ValidatedPlanningAuthorityHandle;
}

export async function deleteProject(
  projectId: EntityId,
  options: DeletePlanningProjectOptions = {}
): Promise<boolean> {
  let deleted = false;
  await authorityWriterGuard.run({
    request: {
      intent: "projectWrite",
      requestId: `planning-project-delete-${projectId}`,
      projectId
    },
    permit: options.authorityPermit,
    invalidation: { domain: "planning", projectId },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [projects, result] = softDeleteEntity(data.projects, projectId);
      deleted = result;
      return result
        ? appendChangeLog(
            { ...data, projects },
            "project",
            projectId,
            "deleted",
            options.note
          )
        : data;
    })
  });
  return deleted;
}

export async function createRouteNode(input: RouteNodeCreateInput): Promise<RouteNode> {
  const routeNode = addSystemFields<RouteNode>(
    normalizeRouteNodeFields({
      ...input,
      nodeType: input.nodeType ?? "other",
      status: input.status ?? "planned",
      showInGantt: input.showInGantt !== false,
      captureState: input.captureState ?? "unscheduled",
      orderIndex: input.orderIndex ?? 0,
      tags: input.tags ?? []
    }),
    "route",
    input.title
  );

  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-route-node-create-${routeNode.id}`,
      projectId: routeNode.projectId,
      ownerType: "routeNode",
      ownerId: routeNode.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId: routeNode.projectId,
      ownerType: "routeNode",
      ownerId: routeNode.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) =>
      appendChangeLog(
        {
          ...data,
          routeNodes: [...data.routeNodes, routeNode]
        },
        "routeNode",
        routeNode.id,
        "created"
      ))
  });

  return routeNode;
}

export async function updateRouteNode(
  routeNodeId: EntityId,
  patch: UpdateEntityInput<RouteNode>
): Promise<RouteNode | undefined> {
  let updated: RouteNode | undefined;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-route-node-update-${routeNodeId}`,
      ownerType: "routeNode",
      ownerId: routeNodeId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "routeNode",
      ownerId: routeNodeId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [routeNodes, item] = updateEntity(
        data.routeNodes,
        routeNodeId,
        normalizeRouteNodePatch(patch)
      );
      updated = item;
      return item
        ? appendChangeLog({ ...data, routeNodes }, "routeNode", routeNodeId, "updated")
        : data;
    })
  });
  return updated;
}

export async function createRouteCheckpoint(
  input: RouteCheckpointCreateInput
): Promise<RouteCheckpoint> {
  const checkpoint = addSystemFields<RouteCheckpoint>(
    {
      ...input,
      status: input.status ?? "planned",
      orderIndex: input.orderIndex ?? 0,
      tags: input.tags ?? []
    },
    "route-checkpoint",
    input.title
  );

  const route = (await getPlanningData()).routeNodes.find(
    (candidate) => candidate.id === checkpoint.routeNodeId && !candidate.deletedAt
  );
  if (!route) {
    throw new Error(`RouteNode not found: ${checkpoint.routeNodeId}.`);
  }
  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-route-checkpoint-create-${checkpoint.id}`,
      projectId: route.projectId,
      ownerType: "routeCheckpoint",
      ownerId: checkpoint.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId: route.projectId,
      ownerType: "routeCheckpoint",
      ownerId: checkpoint.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const currentRoute = data.routeNodes.find(
        (candidate) =>
          candidate.id === checkpoint.routeNodeId &&
          candidate.projectId === route.projectId &&
          !candidate.deletedAt
      );
      if (!currentRoute) {
        throw new PlanningSnapshotCommitError(
          "candidate_invalid",
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          "PLANNING_ROUTE_CHECKPOINT_PARENT_INVALID"
        );
      }
      return appendChangeLog(
        {
          ...data,
          routeCheckpoints: [...data.routeCheckpoints, checkpoint]
        },
        "routeCheckpoint",
        checkpoint.id,
        "created"
      );
    })
  });

  return checkpoint;
}

export async function updateRouteCheckpoint(
  checkpointId: EntityId,
  patch: UpdateEntityInput<RouteCheckpoint>
): Promise<RouteCheckpoint | undefined> {
  let updated: RouteCheckpoint | undefined;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-route-checkpoint-update-${checkpointId}`,
      ownerType: "routeCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "routeCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [routeCheckpoints, item] = updateEntity(data.routeCheckpoints, checkpointId, patch);
      updated = item;
      return item
        ? appendChangeLog({ ...data, routeCheckpoints }, "routeCheckpoint", checkpointId, "updated")
        : data;
    })
  });
  return updated;
}

export async function deleteRouteCheckpoint(checkpointId: EntityId): Promise<boolean> {
  let deleted = false;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-route-checkpoint-delete-${checkpointId}`,
      ownerType: "routeCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "routeCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [routeCheckpoints, result] = softDeleteEntity(data.routeCheckpoints, checkpointId);
      deleted = result;
      return result
        ? appendChangeLog({ ...data, routeCheckpoints }, "routeCheckpoint", checkpointId, "deleted")
        : data;
    })
  });
  return deleted;
}

export async function createTaskCheckpoint(
  input: TaskCheckpointCreateInput
): Promise<TaskCheckpoint> {
  const checkpoint = addSystemFields<TaskCheckpoint>(
    {
      ...input,
      status: input.status ?? "planned",
      orderIndex: input.orderIndex ?? 0,
      tags: input.tags ?? []
    },
    "task-checkpoint",
    input.title
  );

  const task = (await getPlanningData()).tasks.find(
    (candidate) => candidate.id === checkpoint.taskId && !candidate.deletedAt
  );
  if (!task) {
    throw new Error(`Task not found: ${checkpoint.taskId}.`);
  }
  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-task-checkpoint-create-${checkpoint.id}`,
      projectId: task.projectId,
      ownerType: "taskCheckpoint",
      ownerId: checkpoint.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId: task.projectId,
      ownerType: "taskCheckpoint",
      ownerId: checkpoint.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const currentTask = data.tasks.find(
        (candidate) =>
          candidate.id === checkpoint.taskId &&
          candidate.projectId === task.projectId &&
          !candidate.deletedAt
      );
      if (!currentTask) {
        throw new PlanningSnapshotCommitError(
          "candidate_invalid",
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          "PLANNING_TASK_CHECKPOINT_PARENT_INVALID"
        );
      }
      return appendChangeLog(
        {
          ...data,
          taskCheckpoints: [...data.taskCheckpoints, checkpoint]
        },
        "taskCheckpoint",
        checkpoint.id,
        "created"
      );
    })
  });

  return checkpoint;
}

export async function updateTaskCheckpoint(
  checkpointId: EntityId,
  patch: UpdateEntityInput<TaskCheckpoint>
): Promise<TaskCheckpoint | undefined> {
  let updated: TaskCheckpoint | undefined;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-task-checkpoint-update-${checkpointId}`,
      ownerType: "taskCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "taskCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [taskCheckpoints, item] = updateEntity(data.taskCheckpoints, checkpointId, patch);
      updated = item;
      return item
        ? appendChangeLog({ ...data, taskCheckpoints }, "taskCheckpoint", checkpointId, "updated")
        : data;
    })
  });
  return updated;
}

export async function deleteTaskCheckpoint(checkpointId: EntityId): Promise<boolean> {
  let deleted = false;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-task-checkpoint-delete-${checkpointId}`,
      ownerType: "taskCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "taskCheckpoint",
      ownerId: checkpointId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [taskCheckpoints, result] = softDeleteEntity(data.taskCheckpoints, checkpointId);
      deleted = result;
      return result
        ? appendChangeLog({ ...data, taskCheckpoints }, "taskCheckpoint", checkpointId, "deleted")
        : data;
    })
  });
  return deleted;
}

export async function createResearchRoutine(
  input: ResearchRoutineCreateInput
): Promise<ResearchRoutine> {
  const routine = addSystemFields<ResearchRoutine>(
    {
      ...input,
      frequency: input.frequency ?? "daily",
      targetType: input.targetType ?? "count",
      isActive: input.isActive ?? true,
      orderIndex: input.orderIndex ?? 0,
      tags: input.tags ?? []
    },
    "research-routine",
    input.title
  );

  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-research-routine-create-${routine.id}`,
      projectId: routine.projectId,
      ownerType: "researchRoutine",
      ownerId: routine.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId: routine.projectId,
      ownerType: "researchRoutine",
      ownerId: routine.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) =>
      appendChangeLog(
        {
          ...data,
          researchRoutines: [...data.researchRoutines, routine]
        },
        "researchRoutine",
        routine.id,
        "created"
      ))
  });

  return routine;
}

export async function updateResearchRoutine(
  routineId: EntityId,
  patch: UpdateEntityInput<ResearchRoutine>
): Promise<ResearchRoutine | undefined> {
  let updated: ResearchRoutine | undefined;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-research-routine-update-${routineId}`,
      ownerType: "researchRoutine",
      ownerId: routineId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "researchRoutine",
      ownerId: routineId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [researchRoutines, item] = updateEntity(data.researchRoutines, routineId, patch);
      updated = item;
      return item
        ? appendChangeLog({ ...data, researchRoutines }, "researchRoutine", routineId, "updated")
        : data;
    })
  });
  return updated;
}

export async function deleteResearchRoutine(routineId: EntityId): Promise<boolean> {
  let deleted = false;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-research-routine-delete-${routineId}`,
      ownerType: "researchRoutine",
      ownerId: routineId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "researchRoutine",
      ownerId: routineId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [researchRoutines, result] = softDeleteEntity(data.researchRoutines, routineId);
      deleted = result;
      return result
        ? appendChangeLog({ ...data, researchRoutines }, "researchRoutine", routineId, "deleted")
        : data;
    })
  });
  return deleted;
}

export async function createRoutineCheckIn(
  input: RoutineCheckInCreateInput
): Promise<RoutineCheckIn> {
  const checkIn = addSystemFields<RoutineCheckIn>(
    {
      ...input,
      title: input.title ?? "Routine check-in",
      checkedAt: input.checkedAt ?? now(),
      periodKey: input.periodKey ?? "",
      count: input.count ?? 1,
      tags: input.tags ?? []
    },
    "routine-check-in",
    input.title ?? "Routine check-in"
  );

  const routine = (await getPlanningData()).researchRoutines.find(
    (candidate) => candidate.id === checkIn.routineId && !candidate.deletedAt
  );
  if (!routine) {
    throw new Error(`ResearchRoutine not found: ${checkIn.routineId}.`);
  }
  const projectId = checkIn.projectId ?? routine.projectId;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-routine-check-in-create-${checkIn.id}`,
      projectId,
      ownerType: "routineCheckIn",
      ownerId: checkIn.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId,
      ownerType: "routineCheckIn",
      ownerId: checkIn.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const currentRoutine = data.researchRoutines.find(
        (candidate) =>
          candidate.id === checkIn.routineId &&
          !candidate.deletedAt &&
          (checkIn.projectId ?? candidate.projectId) === projectId
      );
      if (!currentRoutine) {
        throw new PlanningSnapshotCommitError(
          "candidate_invalid",
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          "PLANNING_ROUTINE_CHECK_IN_PARENT_INVALID"
        );
      }
      return appendChangeLog(
        {
          ...data,
          routineCheckIns: [...data.routineCheckIns, checkIn]
        },
        "routineCheckIn",
        checkIn.id,
        "created"
      );
    })
  });

  return checkIn;
}

export async function deleteRouteNode(routeNodeId: EntityId): Promise<boolean> {
  let deleted = false;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-route-node-delete-${routeNodeId}`,
      ownerType: "routeNode",
      ownerId: routeNodeId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "routeNode",
      ownerId: routeNodeId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [routeNodes, result] = softDeleteEntity(data.routeNodes, routeNodeId);
      deleted = result;
      return result
        ? appendChangeLog({ ...data, routeNodes }, "routeNode", routeNodeId, "deleted")
        : data;
    })
  });
  return deleted;
}

export async function createTask(input: TaskCreateInput): Promise<Task> {
  const task = addSystemFields<Task>(
    {
      ...input,
      taskType: input.taskType ?? "other",
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      timeBucket: input.timeBucket ?? "none",
      captureState: input.captureState ?? "unscheduled",
      orderIndex: input.orderIndex ?? 0,
      tags: input.tags ?? []
    },
    "task",
    input.title
  );

  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-task-create-${task.id}`,
      projectId: task.projectId,
      ownerType: "task",
      ownerId: task.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId: task.projectId,
      ownerType: "task",
      ownerId: task.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) =>
      appendChangeLog(
        {
          ...data,
          tasks: [...data.tasks, task]
        },
        "task",
        task.id,
        "created"
      ))
  });

  return task;
}

export async function updateTask(
  taskId: EntityId,
  patch: UpdateEntityInput<Task>
): Promise<Task | undefined> {
  let updated: Task | undefined;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-task-update-${taskId}`,
      ownerType: "task",
      ownerId: taskId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "task",
      ownerId: taskId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [tasks, item] = updateEntity(data.tasks, taskId, patch);
      updated = item;
      return item ? appendChangeLog({ ...data, tasks }, "task", taskId, "updated") : data;
    })
  });
  return updated;
}

export async function completeTask(taskId: EntityId): Promise<Task | undefined> {
  return updateTask(taskId, {
    status: "done",
    completedAt: now()
  });
}

export async function archiveTask(taskId: EntityId): Promise<Task | undefined> {
  return updateTask(taskId, {
    status: "archived",
    archivedAt: now()
  });
}

export async function deleteTask(taskId: EntityId): Promise<boolean> {
  let deleted = false;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-task-delete-${taskId}`,
      ownerType: "task",
      ownerId: taskId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "task",
      ownerId: taskId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const [tasks, result] = softDeleteEntity(data.tasks, taskId);
      deleted = result;
      return result ? appendChangeLog({ ...data, tasks }, "task", taskId, "deleted") : data;
    })
  });
  return deleted;
}

export async function createReview(input: ReviewCreateInput) {
  const reviewType = normalizeReviewType(input.reviewType);
  const review = {
    ...addSystemFields<Review>(
      {
        ...input,
        reviewType,
        outlineSections: reconcileReviewOutlineSections(
          reviewType,
          input.outlineSections
        ),
        tags: input.tags ?? []
      },
      "review",
      input.title
    ),
    schemaVersion: REVIEW_CORE_SCHEMA_VERSION
  };

  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-review-create-${review.id}`,
      projectId: review.projectId,
      ownerType: "review",
      ownerId: review.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId: review.projectId,
      ownerType: "review",
      ownerId: review.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) =>
      appendChangeLog(
        {
          ...data,
          reviews: [...data.reviews, review]
        },
        "review",
        review.id,
        "created"
      ))
  });

  return review;
}

export async function updateReview(
  reviewId: EntityId,
  patch: UpdateEntityInput<Review>,
  authorityPermit?: ValidatedPlanningAuthorityHandle
): Promise<Review | undefined> {
  let updated: Review | undefined;
  const current = (await getPlanningFirstLayerData()).reviews.find(
    (review) => review.id === reviewId
  );
  const projectId = patch.projectId ?? current?.projectId;
  if (!projectId) return undefined;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-review-update-${reviewId}`,
      projectId,
      ownerType: "review",
      ownerId: reviewId,
      scope: "primary"
    },
    permit: authorityPermit,
    invalidation: {
      domain: "planning",
      projectId,
      ownerType: "review",
      ownerId: reviewId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const existing = data.reviews.find((review) => review.id === reviewId && !review.deletedAt);
      if (!existing) {
        return data;
      }
      const firstLayerPatch = stripReviewSecondLayerPatch(patch);
      const [reviews, item] = updateEntity(
        data.reviews,
        reviewId,
        firstLayerPatch as UpdateEntityInput<Review>
      );
      updated = item;
      return item ? appendChangeLog({ ...data, reviews }, "review", reviewId, "updated") : data;
    })
  });
  return updated;
}

export async function replaceReviewSummarizesTargetLinks(
  reviewId: EntityId,
  targets: ReviewTargetInput[]
): Promise<EntityLink[]> {
  let nextReviewLinks: EntityLink[] = [];
  const current = (await getPlanningFirstLayerData()).reviews.find(
    (review) => review.id === reviewId && !review.deletedAt
  );
  if (!current) return nextReviewLinks;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-review-target-links-replace-${reviewId}`,
      projectId: current.projectId,
      ownerType: "review",
      ownerId: reviewId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      projectId: current.projectId,
      ownerType: "review",
      ownerId: reviewId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const review = data.reviews.find(
        (item) => item.id === reviewId && item.projectId === current.projectId && !item.deletedAt
      );
      if (!review) {
        throw new PlanningSnapshotCommitError(
          "candidate_invalid",
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          { repositoryEpoch: context.repositoryEpoch, revision: context.revision },
          "PLANNING_REVIEW_TARGET_LINK_OWNER_INVALID"
        );
      }
      const timestamp = now();
      const entityLinks = replaceReviewTargetLinksInSnapshot(
        data.entityLinks,
        reviewId,
        targets,
        timestamp
      );
      nextReviewLinks = entityLinks.filter(
        (link) =>
          link.sourceType === "review" &&
          link.sourceId === reviewId &&
          link.relationType === "summarizes"
      );
      return appendChangeLog(
        {
          ...data,
          entityLinks
        },
        "review",
        reviewId,
        "updated",
        "Replaced Review formal target EntityLinks."
      );
    })
  });
  return nextReviewLinks;
}

export async function createEntityLink(input: EntityLinkCreateInput): Promise<EntityLink> {
  const timestamp = now();
  const entityLink: EntityLink = {
    ...input,
    id: input.id ?? createId("link"),
    relationType: input.relationType ?? "related_to",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    schemaVersion: input.schemaVersion ?? PLANNING_SCHEMA_VERSION
  };

  await authorityWriterGuard.run({
    request: {
      intent: "ownerCreate",
      requestId: `planning-entity-link-create-${entityLink.id}`,
      ownerType: "entityLink",
      ownerId: entityLink.id,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "entityLink",
      ownerId: entityLink.id,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => ({
      ...data,
      entityLinks: [...data.entityLinks, entityLink]
    }))
  });

  return entityLink;
}

export async function deleteEntityLink(entityLinkId: EntityId): Promise<boolean> {
  let deleted = false;
  await authorityWriterGuard.run({
    request: {
      intent: "ownerWrite",
      requestId: `planning-entity-link-delete-${entityLinkId}`,
      ownerType: "entityLink",
      ownerId: entityLinkId,
      scope: "primary"
    },
    invalidation: {
      domain: "planning",
      ownerType: "entityLink",
      ownerId: entityLinkId,
      scope: "primary"
    },
    write: (_permit, context) => commitPlanningSnapshot(context, (data) => {
      const entityLinks = data.entityLinks.filter((link) => link.id !== entityLinkId);
      deleted = entityLinks.length !== data.entityLinks.length;
      return deleted ? { ...data, entityLinks } : data;
    })
  });
  return deleted;
}
