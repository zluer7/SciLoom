import { invoke } from "@tauri-apps/api/core";
import {
  PlanningRepositoryEnvelopeError,
  type PlanningRepositoryEnvelope,
  type PlanningRepositoryWriterSession,
  type PlanningSnapshotCommitRequest,
  type PlanningSnapshotCommitResult
} from "./planningRepositoryEnvelope";

type Dependencies<T> = {
  storageKey: string;
  readSource(): string | null;
  createInitialSnapshot(): Promise<T>;
  createRepositoryEpoch(): string;
  normalizeSnapshot(snapshot: T): T;
  prepareSource(snapshot: T): Promise<T>;
};

/** Desktop canonical persistence. localStorage is read once, only if the target
 * has no completed import. No local writer or read fallback exists here. */
export function createPlanningSQLitePersistence<T>(dependencies: Dependencies<T>) {
  let writer: PlanningRepositoryWriterSession | undefined;
  let activated = false;
  function session() {
    if (!writer) throw new PlanningRepositoryEnvelopeError("PLANNING_REPOSITORY_WRITER_NOT_ACTIVE");
    return writer;
  }
  function requireSession(expected?: PlanningRepositoryWriterSession) {
    const current = session();
    if (expected && JSON.stringify(expected) !== JSON.stringify(current)) {
      throw new PlanningRepositoryEnvelopeError("PLANNING_REPOSITORY_WRITER_STALE");
    }
    if (!activated) throw new PlanningRepositoryEnvelopeError("PLANNING_REPOSITORY_WRITER_NOT_ACTIVE");
    return current;
  }
  async function readTarget() {
    return invoke<PlanningRepositoryEnvelope<T> | null>("planning_repository_read", { session: session() });
  }
  return {
    activateWriter(next: PlanningRepositoryWriterSession) { writer = Object.freeze({ ...next }); activated = false; },
    revokeWriter(expected: PlanningRepositoryWriterSession) {
      if (writer && JSON.stringify(writer) === JSON.stringify(expected)) { writer = undefined; activated = false; }
    },
    async bootstrap() {
      // Crucially no old-source access on the completed-target path, including
      // when storage is missing, corrupt, inaccessible or stale after new writes.
      if (await readTarget()) { activated = true; return; }
      let raw: string | null;
      try { raw = dependencies.readSource(); }
      catch (error) { throw new PlanningRepositoryEnvelopeError("PLANNING_REPOSITORY_STORAGE_UNAVAILABLE", error); }
      let envelope: PlanningRepositoryEnvelope<T>;
      if (raw === null) {
        envelope = { envelopeVersion: 1, repositoryEpoch: dependencies.createRepositoryEpoch(), revision: "0", snapshot: await dependencies.createInitialSnapshot() };
      } else {
        try { envelope = JSON.parse(raw); }
        catch (error) { throw new PlanningRepositoryEnvelopeError("PLANNING_REPOSITORY_ENVELOPE_MALFORMED", error); }
        if (!envelope || envelope.envelopeVersion !== 1 || !envelope.snapshot) {
          throw new PlanningRepositoryEnvelopeError("PLANNING_REPOSITORY_ENVELOPE_MALFORMED");
        }
        envelope = { ...envelope, snapshot: await dependencies.prepareSource(envelope.snapshot) };
      }
      // Stable source check after asynchronous Review preparation. No writer in
      // this build is enabled until the target is durably confirmed.
      if (dependencies.readSource() !== raw) throw new Error("PLANNING_MIGRATION_SOURCE_CHANGED");
      try {
        await invoke("planning_repository_import", { session: session(), envelope, sourceRaw: raw });
      } catch (error) {
        // Unknown IPC completion is never treated as uncommitted. Native import
        // itself is idempotent; target-first readback decides activation.
        if (!(await readTarget())) throw error;
      }
      if (!(await readTarget())) throw new Error("PLANNING_IMPORT_READBACK_MISSING");
      activated = true;
    },
    async readEnvelope(): Promise<PlanningRepositoryEnvelope<T>> {
      requireSession();
      const envelope = await readTarget();
      if (!envelope) throw new Error("PLANNING_CANONICAL_TARGET_UNAVAILABLE");
      return envelope;
    },
    async commitSnapshot(request: PlanningSnapshotCommitRequest<T>, expected?: PlanningRepositoryWriterSession): Promise<PlanningSnapshotCommitResult<T>> {
      return invoke("planning_repository_commit", {
        session: requireSession(expected),
        request: { ...request, nextSnapshot: dependencies.normalizeSnapshot(request.nextSnapshot) }
      });
    }
  };
}
