export const PLANNING_REPOSITORY_ENVELOPE_VERSION = 1 as const;
const MAX_PLANNING_REPOSITORY_REVISION = (1n << 128n) - 1n;

export interface PlanningRepositoryIdentity {
  repositoryEpoch: string;
  revision: string;
}

export interface PlanningRepositoryEnvelope<T> extends PlanningRepositoryIdentity {
  envelopeVersion: typeof PLANNING_REPOSITORY_ENVELOPE_VERSION;
  snapshot: T;
}

export interface PlanningSnapshotCommitRequest<T> {
  expectedEpoch: string;
  expectedRevision: string;
  nextSnapshot: T;
}

export type PlanningSnapshotCommitResult<T> =
  | {
      status: "committed" | "unchanged";
      expectedIdentity: PlanningRepositoryIdentity;
      envelope: PlanningRepositoryEnvelope<T>;
    }
  | {
      status: "epoch_mismatch" | "revision_stale";
      expectedIdentity: PlanningRepositoryIdentity;
      currentIdentity: PlanningRepositoryIdentity;
    };

export type PlanningRepositoryEnvelopeFailureCode =
  | "PLANNING_REPOSITORY_STORAGE_UNAVAILABLE"
  | "PLANNING_REPOSITORY_WRITER_NOT_ACTIVE"
  | "PLANNING_REPOSITORY_WRITER_STALE"
  | "PLANNING_REPOSITORY_EPOCH_SOURCE_UNAVAILABLE"
  | "PLANNING_REPOSITORY_ENVELOPE_MALFORMED"
  | "PLANNING_REPOSITORY_WRITE_FAILED"
  | "PLANNING_REPOSITORY_READ_BACK_MISMATCH"
  | "PLANNING_REPOSITORY_REVISION_EXHAUSTED";

export class PlanningRepositoryEnvelopeError extends Error {
  readonly code: PlanningRepositoryEnvelopeFailureCode;

  constructor(code: PlanningRepositoryEnvelopeFailureCode, cause?: unknown) {
    super(code);
    this.name = "PlanningRepositoryEnvelopeError";
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: cause
      });
    }
  }
}

export interface PlanningRepositoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PlanningRepositoryWriterSession {
  readonly processGeneration: string;
  readonly producerSessionGeneration: number;
  readonly transportGeneration: number;
}

interface PlanningRepositoryEnvelopeStoreDependencies<T> {
  storageKey: string;
  getStorage(): PlanningRepositoryStorage | undefined;
  createInitialSnapshot(): Promise<T>;
  normalizeSnapshot(snapshot: T): T;
  isSnapshot(value: unknown): value is T;
  createRepositoryEpoch(): string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isUuidV4(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isUnsignedDecimal(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return false;
  }
  try {
    return BigInt(value) <= MAX_PLANNING_REPOSITORY_REVISION;
  } catch {
    return false;
  }
}

export function createWebCryptoRepositoryEpoch(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.randomUUID !== "function") {
    throw new PlanningRepositoryEnvelopeError(
      "PLANNING_REPOSITORY_EPOCH_SOURCE_UNAVAILABLE"
    );
  }
  const epoch = cryptoApi.randomUUID();
  if (!isUuidV4(epoch)) {
    throw new PlanningRepositoryEnvelopeError(
      "PLANNING_REPOSITORY_EPOCH_SOURCE_UNAVAILABLE"
    );
  }
  return epoch;
}

export function createPlanningRepositoryEnvelopeStore<T>(
  dependencies: PlanningRepositoryEnvelopeStoreDependencies<T>
) {
  let activeWriter: PlanningRepositoryWriterSession | undefined;
  let disposableCache: PlanningRepositoryEnvelope<T> | undefined;
  let writeTail: Promise<void> = Promise.resolve();

  function storage(): PlanningRepositoryStorage {
    const resolved = dependencies.getStorage();
    if (!resolved) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_STORAGE_UNAVAILABLE"
      );
    }
    return resolved;
  }

  function requireWriter(session?: PlanningRepositoryWriterSession) {
    if (!activeWriter) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_WRITER_NOT_ACTIVE"
      );
    }
    if (
      session &&
      (session.processGeneration !== activeWriter.processGeneration ||
        session.producerSessionGeneration !== activeWriter.producerSessionGeneration ||
        session.transportGeneration !== activeWriter.transportGeneration)
    ) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_WRITER_STALE"
      );
    }
  }

  function parsePersisted(raw: string): PlanningRepositoryEnvelope<T> | "legacy" {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_ENVELOPE_MALFORMED",
        error
      );
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Object.prototype.hasOwnProperty.call(parsed, "envelopeVersion")
    ) {
      return "legacy";
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { envelopeVersion?: unknown }).envelopeVersion !==
        PLANNING_REPOSITORY_ENVELOPE_VERSION ||
      !isUuidV4((parsed as { repositoryEpoch?: unknown }).repositoryEpoch) ||
      !isUnsignedDecimal((parsed as { revision?: unknown }).revision) ||
      !dependencies.isSnapshot((parsed as { snapshot?: unknown }).snapshot)
    ) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_ENVELOPE_MALFORMED"
      );
    }
    const envelope = parsed as PlanningRepositoryEnvelope<T>;
    return {
      envelopeVersion: PLANNING_REPOSITORY_ENVELOPE_VERSION,
      repositoryEpoch: envelope.repositoryEpoch,
      revision: envelope.revision,
      snapshot: clone(envelope.snapshot)
    };
  }

  function persist(envelope: PlanningRepositoryEnvelope<T>) {
    const target = storage();
    const raw = JSON.stringify(envelope);
    try {
      target.setItem(dependencies.storageKey, raw);
    } catch (error) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_WRITE_FAILED",
        error
      );
    }
    let readBack: string | null;
    try {
      readBack = target.getItem(dependencies.storageKey);
    } catch (error) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_READ_BACK_MISMATCH",
        error
      );
    }
    if (readBack !== raw) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_READ_BACK_MISMATCH"
      );
    }
    disposableCache = clone(envelope);
    return clone(envelope);
  }

  function serializeWrite<R>(operation: () => Promise<R>): Promise<R> {
    const run = writeTail.then(operation, operation);
    writeTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function createFreshEnvelopeUnserialized(snapshot?: T) {
    requireWriter();
    const initial = dependencies.normalizeSnapshot(
      snapshot ?? (await dependencies.createInitialSnapshot())
    );
    return persist({
      envelopeVersion: PLANNING_REPOSITORY_ENVELOPE_VERSION,
      repositoryEpoch: dependencies.createRepositoryEpoch(),
      revision: "0",
      snapshot: initial
    });
  }

  function readPersistedEnvelope():
    | PlanningRepositoryEnvelope<T>
    | "missing"
    | "legacy" {
    const target = storage();
    let raw: string | null;
    try {
      raw = target.getItem(dependencies.storageKey);
    } catch (error) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_STORAGE_UNAVAILABLE",
        error
      );
    }
    if (raw === null) {
      return "missing";
    }
    const parsed = parsePersisted(raw);
    if (parsed === "legacy") return "legacy";
    disposableCache = clone(parsed);
    return parsed;
  }

  async function readEnvelope(): Promise<PlanningRepositoryEnvelope<T>> {
    const persisted = readPersistedEnvelope();
    if (persisted !== "missing" && persisted !== "legacy") {
      return clone(persisted);
    }
    return serializeWrite(async () => {
      const current = readPersistedEnvelope();
      if (current !== "missing" && current !== "legacy") {
        return clone(current);
      }
      return createFreshEnvelopeUnserialized();
    });
  }

  async function commitSnapshot(
    request: PlanningSnapshotCommitRequest<T>,
    session?: PlanningRepositoryWriterSession
  ): Promise<PlanningSnapshotCommitResult<T>> {
    requireWriter(session);
    return serializeWrite(async () => {
      requireWriter(session);
      const persisted = readPersistedEnvelope();
      const current =
        persisted === "missing" || persisted === "legacy"
          ? await createFreshEnvelopeUnserialized()
          : persisted;
      const expectedIdentity = {
        repositoryEpoch: request.expectedEpoch,
        revision: request.expectedRevision
      };
      const currentIdentity = {
        repositoryEpoch: current.repositoryEpoch,
        revision: current.revision
      };
      if (request.expectedEpoch !== current.repositoryEpoch) {
        return {
          status: "epoch_mismatch",
          expectedIdentity,
          currentIdentity
        };
      }
      if (request.expectedRevision !== current.revision) {
        return {
          status: "revision_stale",
          expectedIdentity,
          currentIdentity
        };
      }
      const normalized = dependencies.normalizeSnapshot(request.nextSnapshot);
      if (JSON.stringify(normalized) === JSON.stringify(current.snapshot)) {
        return {
          status: "unchanged",
          expectedIdentity,
          envelope: clone(current)
        };
      }
      let nextRevision: bigint;
      try {
        nextRevision = BigInt(current.revision) + 1n;
      } catch (error) {
        throw new PlanningRepositoryEnvelopeError(
          "PLANNING_REPOSITORY_REVISION_EXHAUSTED",
          error
        );
      }
      if (nextRevision > MAX_PLANNING_REPOSITORY_REVISION) {
        throw new PlanningRepositoryEnvelopeError(
          "PLANNING_REPOSITORY_REVISION_EXHAUSTED"
        );
      }
      const envelope = persist({
        envelopeVersion: PLANNING_REPOSITORY_ENVELOPE_VERSION,
        repositoryEpoch: current.repositoryEpoch,
        revision: nextRevision.toString(10),
        snapshot: normalized
      });
      return {
        status: "committed",
        expectedIdentity,
        envelope
      };
    });
  }

  function activateWriter(session: PlanningRepositoryWriterSession) {
    if (
      !session.processGeneration.trim() ||
      !Number.isSafeInteger(session.producerSessionGeneration) ||
      session.producerSessionGeneration < 1 ||
      !Number.isSafeInteger(session.transportGeneration) ||
      session.transportGeneration < 1
    ) {
      throw new PlanningRepositoryEnvelopeError(
        "PLANNING_REPOSITORY_WRITER_STALE"
      );
    }
    activeWriter = Object.freeze({ ...session });
  }

  function revokeWriter(session: PlanningRepositoryWriterSession) {
    if (
      activeWriter?.processGeneration === session.processGeneration &&
      activeWriter.producerSessionGeneration === session.producerSessionGeneration &&
      activeWriter.transportGeneration === session.transportGeneration
    ) {
      activeWriter = undefined;
      disposableCache = undefined;
    }
  }

  return {
    activateWriter,
    revokeWriter,
    readEnvelope,
    commitSnapshot
  };
}
