import type {
  ManuscriptProvisioningRecoveryInspectionAdapter,
  ManuscriptProvisioningRecoveryInspectionSnapshot,
  ManuscriptProvisioningRecoverySnapshotSource
} from "../types/manuscriptProvisioningRuntime";

const FIXED_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_IDENTITY = /^[A-Za-z0-9._-]{1,256}$/u;
const SOURCE_KEYS = new Set([
  "snapshotSchemaVersion",
  "inspectedAt",
  "inspectorVersion",
  "ownerType",
  "ownerId",
  "manuscriptChannel",
  "scopeKind",
  "bindingIdentity",
  "fileRefIdentity",
  "pathIdentityKey",
  "resourceType",
  "controlledMetadataIdentity",
  "containmentSafety",
  "readReady",
  "writeReady",
  "defaultResourceReady",
  "currentResourceReady",
  "lifecycleEligibility",
  "blockerCodes",
  "provenance",
  "markdownBytesRead",
  "observedOperationId",
  "observedOperationRevision",
  "observedClaimId",
  "observedClaimRevision",
  "observedClaimHolder",
  "literatureChildStateIdentity",
  "snapshotHash"
]);
const READINESS_STATES = new Set(["ready", "not-ready", "not-verified"]);

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function requireSafeIdentity(value: string): string {
  if (!SAFE_IDENTITY.test(value)) {
    throw new Error("PROVISIONING_RECOVERY_SNAPSHOT_INVALID");
  }
  return value;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map(requireSafeIdentity))].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    )
  );
}

function validateSource(
  source: ManuscriptProvisioningRecoverySnapshotSource
): ManuscriptProvisioningRecoverySnapshotSource {
  if (
    Object.keys(source).some((key) => !SOURCE_KEYS.has(key)) ||
    source.snapshotSchemaVersion !== 1 ||
    source.markdownBytesRead !== 0 ||
    !FIXED_UTC_TIMESTAMP.test(source.inspectedAt) ||
    !["file", "directory"].includes(source.resourceType) ||
    ![
      source.containmentSafety,
      source.readReady,
      source.writeReady,
      source.defaultResourceReady,
      source.currentResourceReady
    ].every((state) => READINESS_STATES.has(state)) ||
    !["eligible", "not-eligible", "not-verified"].includes(
      source.lifecycleEligibility
    ) ||
    !["current-instance", "other-instance", "none"].includes(
      source.observedClaimHolder
    ) ||
    !Array.isArray(source.blockerCodes) ||
    !Array.isArray(source.provenance) ||
    !Number.isSafeInteger(source.observedOperationRevision) ||
    source.observedOperationRevision < 0 ||
    (source.observedClaimRevision !== null &&
      (!Number.isSafeInteger(source.observedClaimRevision) ||
        source.observedClaimRevision < 0)) ||
    (source.observedClaimId === null) !==
      (source.observedClaimRevision === null)
  ) {
    throw new Error("PROVISIONING_RECOVERY_SNAPSHOT_INVALID");
  }
  for (const value of [
    source.inspectorVersion,
    source.ownerType,
    source.ownerId,
    source.manuscriptChannel,
    source.scopeKind,
    source.bindingIdentity,
    source.fileRefIdentity,
    source.pathIdentityKey,
    source.controlledMetadataIdentity,
    source.observedOperationId,
    ...(source.observedClaimId === null ? [] : [source.observedClaimId]),
    ...(source.literatureChildStateIdentity === null
      ? []
      : [source.literatureChildStateIdentity])
  ]) {
    requireSafeIdentity(value);
  }
  return Object.freeze({
    ...source,
    blockerCodes: sortedUnique(source.blockerCodes),
    provenance: sortedUnique(source.provenance)
  });
}

export function canonicalize(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("PROVISIONING_SNAPSHOT_CANONICALIZATION_FAILED");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const object = value as { readonly [key: string]: CanonicalValue };
  return `{${Object.keys(object)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function canonicalizeRecoverySnapshotIdentity(
  snapshot: ManuscriptProvisioningRecoverySnapshotSource
): string {
  const source = validateSource(snapshot);
  return canonicalize({
    bindingIdentity: source.bindingIdentity,
    blockerCodes: source.blockerCodes,
    containmentSafety: source.containmentSafety,
    controlledMetadataIdentity: source.controlledMetadataIdentity,
    currentResourceReady: source.currentResourceReady,
    defaultResourceReady: source.defaultResourceReady,
    fileRefIdentity: source.fileRefIdentity,
    inspectorVersion: source.inspectorVersion,
    lifecycleEligibility: source.lifecycleEligibility,
    literatureChildStateIdentity: source.literatureChildStateIdentity,
    manuscriptChannel: source.manuscriptChannel,
    markdownBytesRead: source.markdownBytesRead,
    observedClaimHolder: source.observedClaimHolder,
    observedClaimId: source.observedClaimId,
    observedClaimRevision: source.observedClaimRevision,
    observedOperationId: source.observedOperationId,
    observedOperationRevision: source.observedOperationRevision,
    ownerId: source.ownerId,
    ownerType: source.ownerType,
    pathIdentityKey: source.pathIdentityKey,
    provenance: source.provenance,
    readReady: source.readReady,
    resourceType: source.resourceType,
    scopeKind: source.scopeKind,
    snapshotSchemaVersion: source.snapshotSchemaVersion,
    writeReady: source.writeReady
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sealRecoverySnapshot(
  source: ManuscriptProvisioningRecoverySnapshotSource
): Promise<ManuscriptProvisioningRecoveryInspectionSnapshot> {
  const validated = validateSource(source);
  return Object.freeze({
    ...validated,
    snapshotHash: await sha256(
      canonicalizeRecoverySnapshotIdentity(validated)
    )
  });
}

export async function captureRecoveryInspectionSnapshot<TInput>(
  adapter: ManuscriptProvisioningRecoveryInspectionAdapter<TInput>,
  input: TInput
): Promise<ManuscriptProvisioningRecoveryInspectionSnapshot> {
  return sealRecoverySnapshot(await adapter.inspectReadiness(input));
}

export async function refreshRecoveryInspectionSnapshot<TInput>(
  adapter: ManuscriptProvisioningRecoveryInspectionAdapter<TInput>,
  input: TInput,
  userConfirmed: boolean
): Promise<ManuscriptProvisioningRecoveryInspectionSnapshot> {
  if (!userConfirmed) {
    throw new Error("PROVISIONING_RECOVERY_CONFIRMATION_REQUIRED");
  }
  return captureRecoveryInspectionSnapshot(adapter, input);
}
