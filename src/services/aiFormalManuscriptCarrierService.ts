import type { AIContextSourceRef } from "../types/aiContext";
import {
  AI_STANDARD_RESULT_ALLOWED_CAPABILITY_TUPLES
} from "../types/aiStandardResult";
import { projectStandardOperationManuscriptEffectCapabilities } from "./manuscriptSegmentProductActivation";

export const AI_FORMAL_MANUSCRIPT_CARRIER_PROTOCOL =
  "labpod:formal-manuscript-carrier:v1" as const;

export type AIFormalManuscriptCarrierMetadata = {
  ownerType: string;
  ownerId: string;
  channel: string;
  intentRef: string;
};

export type AIFormalManuscriptCarrierEnvelope = {
  metadata: AIFormalManuscriptCarrierMetadata;
  body: string;
  sourceText: string;
  sourceStart: number;
  sourceEnd: number;
};

export type AIFormalManuscriptAdmissionContext = {
  sourceRefs?: readonly Pick<AIContextSourceRef, "entityType" | "entityId">[];
};

export type AIFormalManuscriptAdmissionReason =
  | "ADMITTED"
  | "OWNER_TYPE_UNKNOWN"
  | "CHANNEL_UNKNOWN"
  | "OWNER_CHANNEL_CAPABILITY_UNSUPPORTED"
  | "TARGET_OR_CORRELATION_IDENTITY_INVALID";

export type AIFormalManuscriptCarrierClassification = {
  envelope: AIFormalManuscriptCarrierEnvelope;
  carrierEnvelopeSyntaxDetected: true;
  carrierEnvelopeSyntaxValid: true;
  carrierPayloadExtracted: true;
  ownerTypeKnown: boolean;
  channelKnown: boolean;
  ownerChannelCapabilitySupported: boolean;
  targetOrCorrelationIdentityValid: boolean;
  formalCarrierAdmitted: boolean;
  admissionReason: AIFormalManuscriptAdmissionReason;
};

export type AIFormalManuscriptCarrierProjection = {
  visibleText: string;
  classifications: AIFormalManuscriptCarrierClassification[];
  admitted: AIFormalManuscriptCarrierClassification[];
  nonAdmitted: AIFormalManuscriptCarrierClassification[];
};

type CanonicalEffectCapability = {
  action: string;
  module: string;
  entityType: string;
  channel: string;
};

const CANONICAL_EFFECT_CAPABILITIES: readonly CanonicalEffectCapability[] =
  projectStandardOperationManuscriptEffectCapabilities().map((tuple) => {
    const [action, module, entityType, channel] = tuple.split(".");
    return { action, module, entityType, channel };
  });

const CANONICAL_OWNER_TYPES = new Set<string>([
  ...AI_STANDARD_RESULT_ALLOWED_CAPABILITY_TUPLES.map((tuple) => tuple.split(".")[3]),
  ...CANONICAL_EFFECT_CAPABILITIES.map((capability) => capability.entityType)
]);

const FORMAL_MANUSCRIPT_CARRIER = new RegExp(
  String.raw`^[ \t]*<!--\s*${AI_FORMAL_MANUSCRIPT_CARRIER_PROTOCOL}\s+(\{[^\r\n]*\})\s*-->[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<!--\s*\/${AI_FORMAL_MANUSCRIPT_CARRIER_PROTOCOL}\s*-->[ \t]*(?:\r?\n|$)`,
  "gmu"
);

const RESIDUAL_FORMAL_MANUSCRIPT_WRAPPER_LINE = new RegExp(
  String.raw`^[ \t]*<!--\s*\/?${AI_FORMAL_MANUSCRIPT_CARRIER_PROTOCOL}(?:\s+[^\r\n]*)?\s*-->[ \t]*(?:\r?\n|$)`,
  "gmu"
);

function scrubResidualFormalManuscriptProtocol(text: string): string {
  return text
    .replace(RESIDUAL_FORMAL_MANUSCRIPT_WRAPPER_LINE, "")
    .split(AI_FORMAL_MANUSCRIPT_CARRIER_PROTOCOL)
    .join("formal manuscript carrier marker");
}

function exactBoundedIdentity(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Array.from(value).length <= 200 &&
    !/[\0-\x1F\x7F]/u.test(value);
}

function exactCarrierMetadata(value: string): AIFormalManuscriptCarrierMetadata | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join("|") !== "channel|intentRef|ownerId|ownerType") return undefined;
    if (
      !exactBoundedIdentity(record.ownerType) ||
      !exactBoundedIdentity(record.ownerId) ||
      !exactBoundedIdentity(record.channel) ||
      !exactBoundedIdentity(record.intentRef)
    ) return undefined;
    return {
      ownerType: record.ownerType,
      ownerId: record.ownerId,
      channel: record.channel,
      intentRef: record.intentRef
    };
  } catch {
    return undefined;
  }
}

export function parseAIFormalManuscriptCarrierEnvelopes(
  text: string
): AIFormalManuscriptCarrierEnvelope[] {
  const envelopes: AIFormalManuscriptCarrierEnvelope[] = [];
  for (const match of text.matchAll(FORMAL_MANUSCRIPT_CARRIER)) {
    const metadata = exactCarrierMetadata(match[1]);
    const body = match[2];
    const sourceStart = match.index ?? -1;
    if (!metadata || sourceStart < 0 || !body.trim()) continue;
    envelopes.push({
      metadata,
      body,
      sourceText: match[0],
      sourceStart,
      sourceEnd: sourceStart + match[0].length
    });
  }
  return envelopes;
}

export function isAIFormalManuscriptEffectCapabilitySupported(
  ownerType: string,
  channel: string
): boolean {
  return CANONICAL_EFFECT_CAPABILITIES.some((capability) =>
    capability.entityType === ownerType &&
    capability.channel === channel
  );
}

function targetOrCorrelationIdentityValid(
  metadata: AIFormalManuscriptCarrierMetadata,
  context: AIFormalManuscriptAdmissionContext
): boolean {
  if (metadata.ownerId === "pending-create:" + metadata.intentRef) return true;
  return (context.sourceRefs ?? []).some((sourceRef) =>
    sourceRef.entityType === metadata.ownerType &&
    sourceRef.entityId === metadata.ownerId
  );
}

export function classifyAIFormalManuscriptCarrier(
  envelope: AIFormalManuscriptCarrierEnvelope,
  context: AIFormalManuscriptAdmissionContext = {}
): AIFormalManuscriptCarrierClassification {
  const ownerTypeKnown = CANONICAL_OWNER_TYPES.has(envelope.metadata.ownerType);
  const channelKnown = CANONICAL_EFFECT_CAPABILITIES.some((capability) =>
    capability.channel === envelope.metadata.channel
  );
  const ownerChannelCapabilitySupported = isAIFormalManuscriptEffectCapabilitySupported(
    envelope.metadata.ownerType,
    envelope.metadata.channel
  );
  const identityValid = targetOrCorrelationIdentityValid(envelope.metadata, context);
  const formalCarrierAdmitted =
    ownerTypeKnown &&
    channelKnown &&
    ownerChannelCapabilitySupported &&
    identityValid;
  const admissionReason: AIFormalManuscriptAdmissionReason = formalCarrierAdmitted
    ? "ADMITTED"
    : !ownerTypeKnown
      ? "OWNER_TYPE_UNKNOWN"
      : !channelKnown
        ? "CHANNEL_UNKNOWN"
        : !ownerChannelCapabilitySupported
          ? "OWNER_CHANNEL_CAPABILITY_UNSUPPORTED"
          : "TARGET_OR_CORRELATION_IDENTITY_INVALID";
  return {
    envelope,
    carrierEnvelopeSyntaxDetected: true,
    carrierEnvelopeSyntaxValid: true,
    carrierPayloadExtracted: true,
    ownerTypeKnown,
    channelKnown,
    ownerChannelCapabilitySupported,
    targetOrCorrelationIdentityValid: identityValid,
    formalCarrierAdmitted,
    admissionReason
  };
}

function transformCarrierEnvelopes(
  text: string,
  classifications: readonly AIFormalManuscriptCarrierClassification[],
  mode: "presentation" | "parse_handoff"
): string {
  if (classifications.length === 0) return scrubResidualFormalManuscriptProtocol(text);
  let cursor = 0;
  const parts: string[] = [];
  for (const classification of classifications) {
    const { envelope } = classification;
    parts.push(scrubResidualFormalManuscriptProtocol(text.slice(cursor, envelope.sourceStart)));
    if (mode === "parse_handoff" && classification.formalCarrierAdmitted) {
      parts.push(envelope.sourceText);
    } else if (!classification.formalCarrierAdmitted) {
      parts.push(scrubResidualFormalManuscriptProtocol(envelope.body));
      if (envelope.sourceText.endsWith("\n")) parts.push("\n");
    }
    cursor = envelope.sourceEnd;
  }
  parts.push(scrubResidualFormalManuscriptProtocol(text.slice(cursor)));
  return parts.join("");
}

export function projectAIFormalManuscriptCarriers(
  text: string,
  context: AIFormalManuscriptAdmissionContext = {}
): AIFormalManuscriptCarrierProjection {
  const classifications = parseAIFormalManuscriptCarrierEnvelopes(text)
    .map((envelope) => classifyAIFormalManuscriptCarrier(envelope, context));
  return {
    visibleText: transformCarrierEnvelopes(text, classifications, "presentation"),
    classifications,
    admitted: classifications.filter((item) => item.formalCarrierAdmitted),
    nonAdmitted: classifications.filter((item) => !item.formalCarrierAdmitted)
  };
}

export function buildAIFormalManuscriptParseHandoffText(
  text: string,
  context: AIFormalManuscriptAdmissionContext = {}
): string {
  const classifications = parseAIFormalManuscriptCarrierEnvelopes(text)
    .map((envelope) => classifyAIFormalManuscriptCarrier(envelope, context));
  return transformCarrierEnvelopes(text, classifications, "parse_handoff");
}
