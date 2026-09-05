import encodingRegistryJson from "../contracts/formalSwitchCanonicalEnvelopeEncodingV1.json";
import stateMatrixJson from "../contracts/formalSwitchRecoveryStateMatrixV1.json";
import {
  FORMAL_SWITCH_OWNER_TYPES,
  FORMAL_SWITCH_REVIEW_TYPES,
  type FormalSwitchImmutableEnvelopeV1,
  type FormalSwitchOwnerType,
  type FormalSwitchReviewType
} from "../types/formalSwitchFoundation";

const VERSION = "CanonicalEnvelopeEncodingV1" as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const TAG = Object.freeze({
  absent: 0x00,
  null: 0x01,
  false: 0x02,
  true: 0x03,
  string: 0x10,
  i64: 0x11,
  u64: 0x12,
  bytes: 0x20,
  array: 0x30,
  object: 0x31,
  map: 0x32
});

export type CanonicalValue =
  | { readonly kind: "absent" }
  | null
  | boolean
  | string
  | { readonly kind: "i64"; readonly value: bigint }
  | { readonly kind: "u64"; readonly value: bigint }
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly kind: "object"; readonly fields: readonly (readonly [string, CanonicalValue])[] }
  | { readonly kind: "map"; readonly entries: Readonly<Record<string, CanonicalValue>> };

function fail(code: string): never {
  throw new Error(code);
}

function assertScalarString(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("CANONICAL_LONE_UTF16_SURROGATE");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("CANONICAL_LONE_UTF16_SURROGATE");
    }
  }
}

function u64Bytes(value: bigint) {
  if (value < 0n || value > U64_MAX) fail("CANONICAL_U64_RANGE");
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function i64Bytes(value: bigint) {
  if (value < I64_MIN || value > I64_MAX) fail("CANONICAL_I64_RANGE");
  return u64Bytes(value < 0n ? (1n << 64n) + value : value);
}

function concat(parts: readonly Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function withTag(tag: number, payload: Uint8Array = new Uint8Array()) {
  return concat([Uint8Array.of(tag), payload]);
}

function encodeString(value: string) {
  assertScalarString(value);
  const bytes = encoder.encode(value);
  return withTag(TAG.string, concat([u64Bytes(BigInt(bytes.length)), bytes]));
}

function compareUnsignedBytes(left: Uint8Array, right: Uint8Array) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export function encodeCanonicalValue(value: CanonicalValue): Uint8Array {
  if (value === null) return withTag(TAG.null);
  if (typeof value === "boolean") return withTag(value ? TAG.true : TAG.false);
  if (typeof value === "string") return encodeString(value);
  if (value instanceof Uint8Array) {
    return withTag(TAG.bytes, concat([u64Bytes(BigInt(value.length)), value]));
  }
  if (Array.isArray(value)) {
    return withTag(TAG.array, concat([
      u64Bytes(BigInt(value.length)),
      ...value.map((entry) => encodeCanonicalValue(entry))
    ]));
  }
  if (typeof value === "object" && "kind" in value) {
    if (value.kind === "absent") return withTag(TAG.absent);
    if (value.kind === "i64") return withTag(TAG.i64, i64Bytes(value.value));
    if (value.kind === "u64") return withTag(TAG.u64, u64Bytes(value.value));
    if (value.kind === "object") {
      const seen = new Set<string>();
      const encoded: Uint8Array[] = [u64Bytes(BigInt(value.fields.length))];
      for (const [name, fieldValue] of value.fields) {
        if (seen.has(name)) fail("CANONICAL_DUPLICATE_FIELD");
        seen.add(name);
        encoded.push(encodeString(name), encodeCanonicalValue(fieldValue));
      }
      return withTag(TAG.object, concat(encoded));
    }
    if (value.kind === "map") {
      const entries = Object.entries(value.entries).map(([key, entry]) => ({
        key,
        keyBytes: encoder.encode(key),
        entry
      }));
      entries.sort((left, right) => compareUnsignedBytes(left.keyBytes, right.keyBytes));
      return withTag(TAG.map, concat([
        u64Bytes(BigInt(entries.length)),
        ...entries.flatMap(({ key, entry }) => [encodeString(key), encodeCanonicalValue(entry)])
      ]));
    }
  }
  return fail("CANONICAL_UNSUPPORTED_VALUE");
}

function object(fields: readonly (readonly [string, CanonicalValue])[]): CanonicalValue {
  return { kind: "object", fields };
}

function u64(value: bigint): CanonicalValue {
  return { kind: "u64", value };
}

function i64(value: bigint): CanonicalValue {
  return { kind: "i64", value };
}

function absent(): CanonicalValue {
  return { kind: "absent" };
}

function assertBytes32(value: Uint8Array, field: string) {
  if (value.length !== 32) fail(`CANONICAL_BYTES32_REQUIRED:${field}`);
}

function validateIdentity(envelope: FormalSwitchImmutableEnvelopeV1) {
  if (!envelope.operationId || envelope.formalSwitchOperationId !== envelope.operationId) {
    fail("CANONICAL_OPERATION_IDENTITY_MISMATCH");
  }
  if (!FORMAL_SWITCH_OWNER_TYPES.includes(envelope.ownerType)) fail("CANONICAL_OWNER_TYPE_UNKNOWN");
  if (!(envelope.entryKind === "USER_CONFIRMED_SWITCH" || envelope.entryKind === "REPAIR_CONFIRMED_SWITCH")) {
    fail("CANONICAL_ENTRY_KIND_UNKNOWN");
  }
  if (envelope.payloadVersion !== 1n
    || envelope.canonicalEncodingVersion !== VERSION
    || envelope.engineContractVersion !== 1n
    || envelope.candidateContractVersion !== 1n
    || envelope.settlementPlanVersion !== 1n
    || envelope.transactionPayloadVersion !== 1n
    || envelope.recoveryPayloadVersion !== 1n) {
    fail("CANONICAL_CONTRACT_VERSION_UNKNOWN");
  }
  const reviewTypes: readonly string[] = FORMAL_SWITCH_REVIEW_TYPES;
  if (envelope.ownerType === "literature") {
    if (!(["literature_outline", "dedicated_notes"] as const).includes(envelope.manuscriptChannel as never)) {
      fail("CANONICAL_OWNER_CHANNEL_MISMATCH");
    }
  } else if (envelope.manuscriptChannel !== "primary") {
    fail("CANONICAL_OWNER_CHANNEL_MISMATCH");
  }
  if (envelope.ownerType === "review") {
    if (!envelope.ownerSubtype || !reviewTypes.includes(envelope.ownerSubtype)) {
      fail("CANONICAL_REVIEW_TYPE_REQUIRED");
    }
  } else if (envelope.ownerSubtype !== undefined) {
    fail("CANONICAL_REVIEW_TYPE_FORBIDDEN");
  }
  if (envelope.settlementPlan.writeOnceOperationId !== envelope.operationId) {
    fail("CANONICAL_SETTLEMENT_OPERATION_MISMATCH");
  }
  if (envelope.settlementPlan.byteStart > envelope.settlementPlan.byteEnd) {
    fail("CANONICAL_SETTLEMENT_RANGE_INVALID");
  }
  if (!envelope.descriptorIdentity || envelope.descriptorVersion < 1n
    || !envelope.ownerId || !envelope.oldCurrentFileRefIdentity
    || !envelope.defaultFileRefIdentity || !envelope.targetFileRefIdentity
    || !envelope.oldCurrentLogicalSessionIdentity || !envelope.targetLogicalSessionIdentity
    || !envelope.candidate.fileRefIdentity || !envelope.candidate.physicalRevision
    || !envelope.candidate.encoding || !envelope.oldCurrentExpectedPhysicalRevision
    || !envelope.successOperationLogId || !envelope.activationLogicalIdentity
    || !envelope.finalizationIdentity || !envelope.operationCustodyIdentity
    || envelope.replacementDto.some((item) => !item.stableKey)) {
    fail("CANONICAL_REQUIRED_IDENTITY_MISSING");
  }
  if (!(envelope.settlementPlan.bomState === "ABSENT" || envelope.settlementPlan.bomState === "UTF8_BOM")
    || envelope.settlementPlan.lineEndingPolicy !== "PRESERVE_SNAPSHOT_EXACT"
    || !(envelope.settlementPlan.boundaryNewlineOwnership === "NONE"
      || envelope.settlementPlan.boundaryNewlineOwnership === "LEADING"
      || envelope.settlementPlan.boundaryNewlineOwnership === "TRAILING"
      || envelope.settlementPlan.boundaryNewlineOwnership === "BOTH")) {
    fail("CANONICAL_SETTLEMENT_CONTRACT_INVALID");
  }
  for (const [field, value] of [
    ["descriptorHash", envelope.descriptorHash],
    ["candidate.sha256", envelope.candidate.sha256],
    ["ownerProtectedRowDigest", envelope.ownerProtectedRowDigest],
    ["bindingDigest", envelope.bindingDigest],
    ["lifecycleCoverageDigest", envelope.lifecycleCoverageDigest],
    ["settlement.expectedWholeFileHash", envelope.settlementPlan.expectedWholeFileHash],
    ["settlement.expectedControlledRegionPreimageHash", envelope.settlementPlan.expectedControlledRegionPreimageHash],
    ["settlement.expectedWholeFilePostHash", envelope.settlementPlan.expectedWholeFilePostHash]
  ] as const) assertBytes32(value, field);
}

function envelopeValue(envelope: FormalSwitchImmutableEnvelopeV1): CanonicalValue {
  validateIdentity(envelope);
  return object([
    ["operationId", envelope.operationId],
    ["payloadVersion", u64(envelope.payloadVersion)],
    ["canonicalEncodingVersion", envelope.canonicalEncodingVersion],
    ["engineContractVersion", u64(envelope.engineContractVersion)],
    ["descriptorIdentity", envelope.descriptorIdentity],
    ["descriptorVersion", u64(envelope.descriptorVersion)],
    ["descriptorHash", envelope.descriptorHash],
    ["candidateContractVersion", u64(envelope.candidateContractVersion)],
    ["settlementPlanVersion", u64(envelope.settlementPlanVersion)],
    ["transactionPayloadVersion", u64(envelope.transactionPayloadVersion)],
    ["recoveryPayloadVersion", u64(envelope.recoveryPayloadVersion)],
    ["ownerType", envelope.ownerType],
    ["ownerId", envelope.ownerId],
    ["manuscriptChannel", envelope.manuscriptChannel],
    ["entryKind", envelope.entryKind],
    ["ownerSubtype", envelope.ownerSubtype ?? absent()],
    ["oldCurrentFileRefIdentity", envelope.oldCurrentFileRefIdentity],
    ["defaultFileRefIdentity", envelope.defaultFileRefIdentity],
    ["targetFileRefIdentity", envelope.targetFileRefIdentity],
    ["oldCurrentLogicalSessionIdentity", envelope.oldCurrentLogicalSessionIdentity],
    ["targetLogicalSessionIdentity", envelope.targetLogicalSessionIdentity],
    ["candidate", object([
      ["fileRefIdentity", envelope.candidate.fileRefIdentity],
      ["physicalRevision", envelope.candidate.physicalRevision],
      ["sha256", envelope.candidate.sha256],
      ["byteLength", u64(envelope.candidate.byteLength)],
      ["encoding", envelope.candidate.encoding]
    ])],
    ["replacementDto", envelope.replacementDto.map((item) => object([
      ["stableKey", item.stableKey],
      ["value", item.value]
    ]))],
    ["ownerProtectedRowDigest", envelope.ownerProtectedRowDigest],
    ["bindingDigest", envelope.bindingDigest],
    ["lifecycleCoverageDigest", envelope.lifecycleCoverageDigest],
    ["oldCurrentExpectedPhysicalRevision", envelope.oldCurrentExpectedPhysicalRevision],
    ["settlementPlan", object([
      ["byteStart", u64(envelope.settlementPlan.byteStart)],
      ["byteEnd", u64(envelope.settlementPlan.byteEnd)],
      ["expectedWholeFileHash", envelope.settlementPlan.expectedWholeFileHash],
      ["expectedControlledRegionPreimageHash", envelope.settlementPlan.expectedControlledRegionPreimageHash],
      ["replacementBytes", envelope.settlementPlan.replacementBytes],
      ["expectedWholeFilePostHash", envelope.settlementPlan.expectedWholeFilePostHash],
      ["bomState", envelope.settlementPlan.bomState],
      ["lineEndingPolicy", envelope.settlementPlan.lineEndingPolicy],
      ["boundaryNewlineOwnership", envelope.settlementPlan.boundaryNewlineOwnership],
      ["writeOnceOperationId", envelope.settlementPlan.writeOnceOperationId]
    ])],
    ["transactionPayload", envelope.transactionPayload],
    ["successOperationLogId", envelope.successOperationLogId],
    ["formalSwitchOperationId", envelope.formalSwitchOperationId],
    ["activationLogicalIdentity", envelope.activationLogicalIdentity],
    ["finalizationIdentity", envelope.finalizationIdentity],
    ["operationCustodyIdentity", envelope.operationCustodyIdentity],
    ["createdAtEpochMs", i64(envelope.createdAtEpochMs)]
  ]);
}

export function encodeFormalSwitchImmutableEnvelopeV1(envelope: FormalSwitchImmutableEnvelopeV1) {
  return concat([encodeString(VERSION), encodeCanonicalValue(envelopeValue(envelope))]);
}

class Cursor {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining() { return this.bytes.length - this.offset; }
  byte() { if (this.remaining < 1) fail("CANONICAL_TRUNCATED"); return this.bytes[this.offset++]; }
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining < length) fail("CANONICAL_TRUNCATED");
    const value = this.bytes.slice(this.offset, this.offset + length); this.offset += length; return value;
  }
  u64() { let value = 0n; for (const byte of this.take(8)) value = (value << 8n) | BigInt(byte); return value; }
  i64() { const value = this.u64(); return value > I64_MAX ? value - (1n << 64n) : value; }
  done() { if (this.remaining !== 0) fail("CANONICAL_TRAILING_BYTES"); }
}

function expectTag(cursor: Cursor, tag: number) {
  const actual = cursor.byte();
  if (actual !== tag) fail(`CANONICAL_TAG_MISMATCH:${tag}:${actual}`);
}

function readString(cursor: Cursor) {
  expectTag(cursor, TAG.string);
  const length = cursor.u64();
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail("CANONICAL_LENGTH_RANGE");
  try { return decoder.decode(cursor.take(Number(length))); } catch { return fail("CANONICAL_UTF8_INVALID"); }
}

function readBytes(cursor: Cursor) {
  expectTag(cursor, TAG.bytes);
  const length = cursor.u64();
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail("CANONICAL_LENGTH_RANGE");
  return cursor.take(Number(length));
}

function beginObject(cursor: Cursor, names: readonly string[]) {
  expectTag(cursor, TAG.object);
  const count = cursor.u64();
  if (count !== BigInt(names.length)) fail("CANONICAL_OBJECT_FIELD_COUNT");
  let index = 0;
  return () => {
    if (index >= names.length) fail("CANONICAL_OBJECT_FIELD_OVERFLOW");
    const actual = readString(cursor);
    const expected = names[index++];
    if (actual !== expected) fail(`CANONICAL_OBJECT_FIELD_ORDER:${expected}:${actual}`);
  };
}

const ROOT_FIELDS = (encodingRegistryJson.root.fields as readonly { name: string }[]).map((field) => field.name);
const CANDIDATE_FIELDS = ["fileRefIdentity", "physicalRevision", "sha256", "byteLength", "encoding"] as const;
const REPLACEMENT_FIELDS = ["stableKey", "value"] as const;
const SETTLEMENT_FIELDS = ["byteStart", "byteEnd", "expectedWholeFileHash", "expectedControlledRegionPreimageHash", "replacementBytes", "expectedWholeFilePostHash", "bomState", "lineEndingPolicy", "boundaryNewlineOwnership", "writeOnceOperationId"] as const;

export function decodeFormalSwitchImmutableEnvelopeV1(bytes: Uint8Array): FormalSwitchImmutableEnvelopeV1 {
  const cursor = new Cursor(bytes);
  if (readString(cursor) !== VERSION) fail("CANONICAL_ENCODING_VERSION_UNKNOWN");
  const field = beginObject(cursor, ROOT_FIELDS);
  field(); const operationId = readString(cursor);
  field(); expectTag(cursor, TAG.u64); const payloadVersion = cursor.u64();
  field(); const canonicalEncodingVersion = readString(cursor);
  field(); expectTag(cursor, TAG.u64); const engineContractVersion = cursor.u64();
  field(); const descriptorIdentity = readString(cursor);
  field(); expectTag(cursor, TAG.u64); const descriptorVersion = cursor.u64();
  field(); const descriptorHash = readBytes(cursor);
  field(); expectTag(cursor, TAG.u64); const candidateContractVersion = cursor.u64();
  field(); expectTag(cursor, TAG.u64); const settlementPlanVersion = cursor.u64();
  field(); expectTag(cursor, TAG.u64); const transactionPayloadVersion = cursor.u64();
  field(); expectTag(cursor, TAG.u64); const recoveryPayloadVersion = cursor.u64();
  field(); const ownerType = readString(cursor) as FormalSwitchOwnerType;
  field(); const ownerId = readString(cursor);
  field(); const manuscriptChannel = readString(cursor) as FormalSwitchImmutableEnvelopeV1["manuscriptChannel"];
  field(); const entryKind = readString(cursor) as FormalSwitchImmutableEnvelopeV1["entryKind"];
  field(); const subtypeTag = cursor.byte();
  let ownerSubtype: FormalSwitchReviewType | undefined;
  if (subtypeTag === TAG.string) {
    const length = cursor.u64();
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail("CANONICAL_LENGTH_RANGE");
    ownerSubtype = decoder.decode(cursor.take(Number(length))) as FormalSwitchReviewType;
  } else if (subtypeTag !== TAG.absent) fail("CANONICAL_OWNER_SUBTYPE_TAG");
  field(); const oldCurrentFileRefIdentity = readString(cursor);
  field(); const defaultFileRefIdentity = readString(cursor);
  field(); const targetFileRefIdentity = readString(cursor);
  field(); const oldCurrentLogicalSessionIdentity = readString(cursor);
  field(); const targetLogicalSessionIdentity = readString(cursor);
  field(); const candidateField = beginObject(cursor, CANDIDATE_FIELDS);
  candidateField(); const candidateFileRefIdentity = readString(cursor);
  candidateField(); const physicalRevision = readString(cursor);
  candidateField(); const candidateSha256 = readBytes(cursor);
  candidateField(); expectTag(cursor, TAG.u64); const candidateByteLength = cursor.u64();
  candidateField(); const candidateEncoding = readString(cursor);
  field(); expectTag(cursor, TAG.array); const replacementCount = cursor.u64();
  if (replacementCount > BigInt(Number.MAX_SAFE_INTEGER)) fail("CANONICAL_LENGTH_RANGE");
  const replacementDto = [];
  for (let index = 0; index < Number(replacementCount); index += 1) {
    const replacementField = beginObject(cursor, REPLACEMENT_FIELDS);
    replacementField(); const stableKey = readString(cursor);
    replacementField(); const valueTag = cursor.byte();
    let value: string | null;
    if (valueTag === TAG.null) value = null;
    else if (valueTag === TAG.string) {
      const length = cursor.u64();
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail("CANONICAL_LENGTH_RANGE");
      value = decoder.decode(cursor.take(Number(length)));
    } else fail("CANONICAL_REPLACEMENT_VALUE_TAG");
    replacementDto.push({ stableKey, value });
  }
  field(); const ownerProtectedRowDigest = readBytes(cursor);
  field(); const bindingDigest = readBytes(cursor);
  field(); const lifecycleCoverageDigest = readBytes(cursor);
  field(); const oldCurrentExpectedPhysicalRevision = readString(cursor);
  field(); const settlementField = beginObject(cursor, SETTLEMENT_FIELDS);
  settlementField(); expectTag(cursor, TAG.u64); const byteStart = cursor.u64();
  settlementField(); expectTag(cursor, TAG.u64); const byteEnd = cursor.u64();
  settlementField(); const expectedWholeFileHash = readBytes(cursor);
  settlementField(); const expectedControlledRegionPreimageHash = readBytes(cursor);
  settlementField(); const replacementBytes = readBytes(cursor);
  settlementField(); const expectedWholeFilePostHash = readBytes(cursor);
  settlementField(); const bomState = readString(cursor) as FormalSwitchImmutableEnvelopeV1["settlementPlan"]["bomState"];
  settlementField(); const lineEndingPolicy = readString(cursor) as "PRESERVE_SNAPSHOT_EXACT";
  settlementField(); const boundaryNewlineOwnership = readString(cursor) as FormalSwitchImmutableEnvelopeV1["settlementPlan"]["boundaryNewlineOwnership"];
  settlementField(); const writeOnceOperationId = readString(cursor);
  field(); const transactionPayload = readBytes(cursor);
  field(); const successOperationLogId = readString(cursor);
  field(); const formalSwitchOperationId = readString(cursor);
  field(); const activationLogicalIdentity = readString(cursor);
  field(); const finalizationIdentity = readString(cursor);
  field(); const operationCustodyIdentity = readString(cursor);
  field(); expectTag(cursor, TAG.i64); const createdAtEpochMs = cursor.i64();
  cursor.done();
  if (payloadVersion !== 1n || engineContractVersion !== 1n || candidateContractVersion !== 1n || settlementPlanVersion !== 1n || transactionPayloadVersion !== 1n || recoveryPayloadVersion !== 1n || canonicalEncodingVersion !== VERSION) {
    fail("CANONICAL_CONTRACT_VERSION_UNKNOWN");
  }
  const envelope = {
    operationId, payloadVersion: 1n, canonicalEncodingVersion: VERSION, engineContractVersion: 1n,
    descriptorIdentity, descriptorVersion, descriptorHash, candidateContractVersion: 1n,
    settlementPlanVersion: 1n, transactionPayloadVersion: 1n, recoveryPayloadVersion: 1n,
    ownerType, ownerId, manuscriptChannel, entryKind, ...(ownerSubtype ? { ownerSubtype } : {}),
    oldCurrentFileRefIdentity, defaultFileRefIdentity, targetFileRefIdentity,
    oldCurrentLogicalSessionIdentity, targetLogicalSessionIdentity,
    candidate: { fileRefIdentity: candidateFileRefIdentity, physicalRevision, sha256: candidateSha256, byteLength: candidateByteLength, encoding: candidateEncoding },
    replacementDto, ownerProtectedRowDigest, bindingDigest, lifecycleCoverageDigest,
    oldCurrentExpectedPhysicalRevision,
    settlementPlan: { byteStart, byteEnd, expectedWholeFileHash, expectedControlledRegionPreimageHash, replacementBytes, expectedWholeFilePostHash, bomState, lineEndingPolicy, boundaryNewlineOwnership, writeOnceOperationId },
    transactionPayload, successOperationLogId, formalSwitchOperationId, activationLogicalIdentity,
    finalizationIdentity, operationCustodyIdentity, createdAtEpochMs
  } as FormalSwitchImmutableEnvelopeV1;
  validateIdentity(envelope);
  return envelope;
}

export function verifyCanonicalEnvelopeBytes(bytes: Uint8Array) {
  const envelope = decodeFormalSwitchImmutableEnvelopeV1(bytes);
  const reencoded = encodeFormalSwitchImmutableEnvelopeV1(envelope);
  if (reencoded.length !== bytes.length || reencoded.some((byte, index) => byte !== bytes[index])) {
    fail("CANONICAL_REENCODE_MISMATCH");
  }
  return envelope;
}

export async function sha256CanonicalBytes(bytes: Uint8Array) {
  const owned = Uint8Array.from(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", owned.buffer));
}

export function validateCanonicalEnvelopeRegistry() {
  const tags = encodingRegistryJson.tags as Record<string, number>;
  for (const [name, value] of Object.entries(TAG)) if (tags[name] !== value) fail(`CANONICAL_REGISTRY_TAG_MISMATCH:${name}`);
  if (new Set(Object.values(tags)).size !== Object.values(tags).length) fail("CANONICAL_REGISTRY_DUPLICATE_TAG");
  if (encodingRegistryJson.root.versionPrefix !== VERSION || ROOT_FIELDS.length !== 35 || new Set(ROOT_FIELDS).size !== ROOT_FIELDS.length) {
    fail("CANONICAL_REGISTRY_ROOT_MISMATCH");
  }
  const expectedEnums = {
    ownerType: [...FORMAL_SWITCH_OWNER_TYPES],
    manuscriptChannel: ["primary", "literature_outline", "dedicated_notes"],
    entryKind: ["USER_CONFIRMED_SWITCH", "REPAIR_CONFIRMED_SWITCH"],
    reviewType: [...FORMAL_SWITCH_REVIEW_TYPES]
  } as const;
  for (const [name, expected] of Object.entries(expectedEnums)) {
    const actual = encodingRegistryJson.enums[name as keyof typeof expectedEnums];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`CANONICAL_REGISTRY_ENUM_MISMATCH:${name}`);
  }
  const nestedFields = {
    CandidateIdentityV1: CANDIDATE_FIELDS,
    ReplacementItemV1: REPLACEMENT_FIELDS,
    SettlementPlanV1: SETTLEMENT_FIELDS
  } as const;
  for (const [name, expected] of Object.entries(nestedFields)) {
    const actual = encodingRegistryJson.objects[name as keyof typeof nestedFields].map((field) => field.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`CANONICAL_REGISTRY_OBJECT_MISMATCH:${name}`);
  }
  if (encodingRegistryJson.byteOrder !== "big-endian"
    || encodingRegistryJson.stringEncoding !== "utf-8-no-normalization"
    || encodingRegistryJson.mapKeyOrder !== "unsigned-utf8-byte-ascending"
    || encodingRegistryJson.timestampUnit !== "unix-epoch-milliseconds-utc") {
    fail("CANONICAL_REGISTRY_SCALAR_RULE_MISMATCH");
  }
  const matrix = stateMatrixJson as { matrixId: string; phases: readonly { name: string }[]; transitions: readonly unknown[] };
  if (matrix.matrixId !== "FormalSwitchRecoveryStateMatrixV1" || matrix.phases.length !== 10 || matrix.transitions.length === 0) {
    fail("FORMAL_SWITCH_STATE_MATRIX_INVALID");
  }
  return true;
}
