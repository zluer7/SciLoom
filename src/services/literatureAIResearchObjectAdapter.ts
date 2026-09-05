import type {
  AIContextExcludedItem,
  AIContextItem,
  AIContextLevel,
  AIContextMode,
  AIContextRequestableRef,
  AIContextSection,
  AIContextSourceRef,
  AILiteratureAssociationTuple,
  AILiteratureConversationProjectEligibilityDisposition,
  AILiteratureProjectAssociationKind,
  AILiteratureSafeProjection,
  AIResearchObjectDescriptor
} from "../types/aiContext";
import type { Literature } from "../types/literature";
import { literatureService } from "./literatureService";
import { getProjectById } from "./planningService";

export type LiteratureResearchObjectResolutionErrorCode =
  | "LITERATURE_ID_REQUIRED"
  | "LITERATURE_NOT_FOUND"
  | "LITERATURE_UNAVAILABLE"
  | "LITERATURE_CONVERSATION_PROJECT_UNAVAILABLE"
  | "LITERATURE_PROJECT_MISMATCH";

export class LiteratureResearchObjectResolutionError extends Error {
  constructor(
    readonly code: LiteratureResearchObjectResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LiteratureResearchObjectResolutionError";
  }
}

const LITERATURE_AUTHOR_LIMIT = 8;
const LITERATURE_KEYWORD_LIMIT = 8;
const LITERATURE_TAG_LIMIT = 8;
const LITERATURE_TITLE_MAX_CHARS = 180;
const LITERATURE_SHORT_FIELD_MAX_CHARS = 160;
const LITERATURE_ABSTRACT_MAX_CHARS = 600;

function bounded(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  let normalized = value.replace(/[\0-\x1F\x7F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  const forbidden = [
    /[A-Za-z]:[\\/](?:[^\\/\s|]+[\\/]?)+/gu,
    /\\\\[^\s|]+/gu,
    /file:\/\/[^\s|]+/giu,
    /\/(?:Users|home|mnt|tmp|var)\/[^\s|]+/gu,
    /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
    /\bBearer\s+[A-Za-z0-9._-]+\b/giu
  ];
  for (const pattern of forbidden) normalized = normalized.replace(pattern, "[local or secret value omitted]");
  const characters = Array.from(normalized);
  return characters.length <= maxChars
    ? normalized
    : `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function safeTitle(value: string | undefined, fallback: string): string {
  const normalized = bounded(value, LITERATURE_TITLE_MAX_CHARS) ?? fallback;
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  return bounded(parts[parts.length - 1], LITERATURE_TITLE_MAX_CHARS) ?? fallback;
}

function boundedList(values: readonly string[] | undefined, limit: number): string[] {
  return [...new Set((values ?? [])
    .flatMap((value) => {
      const safe = bounded(value, LITERATURE_SHORT_FIELD_MAX_CHARS);
      return safe ? [safe] : [];
    }))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function fingerprint(prefix: string, value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  let hash = 0x811c9dc5;
  for (const character of serialized) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, "0")}`;
}

/** Builds a new object from the explicit allowlist; the repository row is never serialized. */
export function buildLiteratureSafeProjection(literature: Literature): AILiteratureSafeProjection {
  return {
    literatureId: literature.id,
    title: safeTitle(literature.title, literature.id),
    authorNames: boundedList(
      literature.authors.map((author) => author.name),
      LITERATURE_AUTHOR_LIMIT
    ),
    year: Number.isSafeInteger(literature.year) ? literature.year ?? null : null,
    venue: bounded(literature.venue, LITERATURE_SHORT_FIELD_MAX_CHARS) ?? null,
    publicationType: bounded(literature.publicationType, LITERATURE_SHORT_FIELD_MAX_CHARS) ?? null,
    abstract: bounded(literature.abstract, LITERATURE_ABSTRACT_MAX_CHARS) ?? null,
    keywords: boundedList(literature.keywords, LITERATURE_KEYWORD_LIMIT),
    doi: bounded(literature.doi, LITERATURE_SHORT_FIELD_MAX_CHARS) ?? null,
    readingStatus: literature.readingStatus,
    importance: literature.importance ?? null,
    tags: boundedList(literature.tags, LITERATURE_TAG_LIMIT),
    canonicalProjectId: literature.primaryProjectId?.trim() || null,
    schemaVersion: literature.schemaVersion
  };
}

export function literatureSafeProjectionFingerprint(projection: AILiteratureSafeProjection): string {
  return fingerprint("lp13-a15-literature-projection", projection);
}

function associationFacts(literature: Literature, expectedProjectId: string): {
  projectAssociationKind: AILiteratureProjectAssociationKind;
  canonicalProjectId: string | null;
  conversationProjectEligibilityDisposition: AILiteratureConversationProjectEligibilityDisposition;
} {
  const canonicalProjectId = literature.primaryProjectId?.trim() || null;
  if (canonicalProjectId && canonicalProjectId !== expectedProjectId) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_PROJECT_MISMATCH",
      `Selected Literature ${literature.id} belongs to Project ${canonicalProjectId}, not Conversation Project ${expectedProjectId}.`
    );
  }
  return canonicalProjectId
    ? {
        projectAssociationKind: "assigned",
        canonicalProjectId,
        conversationProjectEligibilityDisposition: "allowed_same_project"
      }
    : {
        projectAssociationKind: "projectless",
        canonicalProjectId: null,
        conversationProjectEligibilityDisposition: "allowed_global_projectless"
      };
}

function buildLiteratureDescriptor(
  literature: Literature,
  projectId: string,
  association: ReturnType<typeof associationFacts>
): AIResearchObjectDescriptor {
  const projection = buildLiteratureSafeProjection(literature);
  const projectionFingerprint = literatureSafeProjectionFingerprint(projection);
  return {
    objectType: "literature",
    objectId: literature.id,
    // Objective-outline Quick may have no Project scope. An empty value here is
    // the existing descriptor's explicit no-Project representation; canonical
    // association truth remains the nullable safeMetadata value below.
    projectId,
    label: projection.title,
    description: projection.abstract ?? undefined,
    sourceRef: {
      module: "literature",
      entityType: "literature",
      entityId: literature.id,
      label: projection.title,
      field: "identity",
      sourceKind: "userAuthored",
      isUserAuthored: true,
      isAiGenerated: false,
      isVerified: true
    },
    safeMetadata: {
      projectAssociationKind: association.projectAssociationKind,
      canonicalProjectId: association.canonicalProjectId,
      conversationProjectEligibilityDisposition: association.conversationProjectEligibilityDisposition,
      lifecycleEligibility: "eligible",
      normalizedProjectionFingerprint: projectionFingerprint,
      schemaVersion: projection.schemaVersion
    },
    literatureSafeProjection: projection,
    ownerModule: "literature",
    channel: "global_chat"
  };
}

export async function resolveLiteratureResearchObjectDescriptor(
  literatureId: string,
  expectedProjectId: string
): Promise<AIResearchObjectDescriptor> {
  const normalizedId = literatureId.trim();
  const normalizedProjectId = expectedProjectId.trim();
  if (!normalizedId) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_ID_REQUIRED",
      "A canonical Literature identity is required."
    );
  }
  const conversationProject = normalizedProjectId ? await getProjectById(normalizedProjectId) : undefined;
  if (!conversationProject || conversationProject.deletedAt || conversationProject.status === "archived") {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_CONVERSATION_PROJECT_UNAVAILABLE",
      `Conversation Project is missing or unavailable: ${normalizedProjectId || "<empty>"}.`
    );
  }
  const literature = await literatureService.getLiteratureById(normalizedId);
  if (!literature) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_NOT_FOUND",
      `Selected Literature is missing: ${normalizedId}.`
    );
  }
  if (literature.deletedAt || literature.isArchived) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_UNAVAILABLE",
      `Selected Literature is archived, deleted, or otherwise unavailable: ${normalizedId}.`
    );
  }
  const association = associationFacts(literature, normalizedProjectId);
  return buildLiteratureDescriptor(literature, normalizedProjectId, association);
}

/**
 * Objective-outline Quick is Literature-scoped and must not require or read a
 * Project merely to resolve the one canonical Literature metadata projection.
 */
export async function resolveLiteratureObjectiveOutlineResearchObjectDescriptor(
  literatureId: string
): Promise<AIResearchObjectDescriptor> {
  const normalizedId = literatureId.trim();
  if (!normalizedId) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_ID_REQUIRED",
      "A canonical Literature identity is required."
    );
  }
  const literature = await literatureService.getLiteratureById(normalizedId);
  if (!literature) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_NOT_FOUND",
      `Selected Literature is missing: ${normalizedId}.`
    );
  }
  if (literature.deletedAt || literature.isArchived) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_UNAVAILABLE",
      `Selected Literature is archived, deleted, or otherwise unavailable: ${normalizedId}.`
    );
  }
  const canonicalProjectId = literature.primaryProjectId?.trim() || null;
  return buildLiteratureDescriptor(
    literature,
    canonicalProjectId ?? "",
    canonicalProjectId
      ? {
          projectAssociationKind: "assigned",
          canonicalProjectId,
          conversationProjectEligibilityDisposition: "allowed_same_project"
        }
      : {
          projectAssociationKind: "projectless",
          canonicalProjectId: null,
          conversationProjectEligibilityDisposition: "allowed_global_projectless"
        }
  );
}

export async function listLiteratureResearchObjectDescriptors(
  conversationProjectId: string,
  limit?: number
): Promise<AIResearchObjectDescriptor[]> {
  const eligible = (await literatureService.queryLiteratures({ archiveStatus: "active" }))
    .filter((item) => !item.deletedAt && !item.isArchived)
    .filter((item) => !item.primaryProjectId || item.primaryProjectId === conversationProjectId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const literature = limit === undefined ? eligible : eligible.slice(0, limit);
  return Promise.all(literature.map((item) =>
    resolveLiteratureResearchObjectDescriptor(item.id, conversationProjectId)));
}

function metadataString(descriptor: AIResearchObjectDescriptor, key: string): string {
  const value = descriptor.safeMetadata?.[key];
  return typeof value === "string" ? value : "";
}

function associationSourceRef(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number
): AIContextSourceRef {
  const kind = metadataString(descriptor, "projectAssociationKind") as AILiteratureProjectAssociationKind;
  const canonicalProjectIdValue = descriptor.safeMetadata?.canonicalProjectId;
  const canonicalProjectId = typeof canonicalProjectIdValue === "string" ? canonicalProjectIdValue : null;
  const disposition = metadataString(
    descriptor,
    "conversationProjectEligibilityDisposition"
  ) as AILiteratureConversationProjectEligibilityDisposition;
  return {
    module: "literature",
    entityType: "literature",
    entityId: descriptor.objectId,
    label: descriptor.label,
    field: "canonical Literature Project association",
    sourceKind: "linkedReference",
    isUserAuthored: true,
    isAiGenerated: false,
    isVerified: true,
    contextMode: mode,
    contextLevel: 1,
    contextRole: "related",
    contextDisposition: "included",
    relationHint: canonicalProjectId
      ? `literature_project:literature=${descriptor.objectId};project=${canonicalProjectId};order=${selectionOrder}`
      : `literature_projectless:literature=${descriptor.objectId};project=null;order=${selectionOrder}`,
    literatureProjectAssociationKind: kind,
    literatureCanonicalProjectId: canonicalProjectId,
    literatureLifecycleEligibility: "eligible",
    literatureConversationProjectEligibilityDisposition: disposition,
    literatureSelectionOrder: selectionOrder,
    literatureNormalizedProjectionFingerprint: metadataString(descriptor, "normalizedProjectionFingerprint"),
    literatureSelectionAggregateEligibility: "ALLOWED"
  };
}

function promptSummary(
  projection: AILiteratureSafeProjection,
  mode: AIContextMode,
  includeProjectAssociation: boolean
): string {
  const identity = [
    `Reading status: ${projection.readingStatus}`,
    projection.authorNames.length ? `Authors: ${projection.authorNames.join(", ")}` : undefined,
    projection.year ? `Year: ${projection.year}` : undefined,
    ...(includeProjectAssociation
      ? [projection.canonicalProjectId
          ? `Project association: assigned (${projection.canonicalProjectId})`
          : "Project association: projectless (global unassigned reference)"]
      : [])
  ].filter(Boolean);
  if (mode === "MINIMAL") return identity.join(" | ");
  return [
    ...identity,
    projection.venue ? `Venue: ${projection.venue}` : undefined,
    projection.publicationType ? `Type: ${projection.publicationType}` : undefined,
    projection.doi ? `DOI: ${projection.doi}` : undefined,
    projection.importance ? `Importance: ${projection.importance}` : undefined,
    projection.keywords.length ? `Keywords: ${projection.keywords.join(", ")}` : undefined,
    projection.tags.length ? `Tags: ${projection.tags.join(", ")}` : undefined,
    projection.abstract ? `Abstract metadata: ${projection.abstract}` : undefined
  ].filter(Boolean).join(" | ");
}

export type LiteratureResearchObjectContextCandidates = {
  primary: AIContextItem;
  excluded: AIContextExcludedItem[];
  warnings: string[];
  requestableRefs: AIContextRequestableRef[];
};

export function buildLiteratureResearchObjectContextCandidates(
  descriptor: AIResearchObjectDescriptor,
  mode: AIContextMode,
  selectionOrder: number,
  options: { includeProjectAssociationInPrompt?: boolean } = {}
): LiteratureResearchObjectContextCandidates {
  const projection = descriptor.literatureSafeProjection;
  if (!projection || projection.literatureId !== descriptor.objectId) {
    throw new LiteratureResearchObjectResolutionError(
      "LITERATURE_UNAVAILABLE",
      `Literature safe projection is unavailable: ${descriptor.objectId}.`
    );
  }
  const associationRef = associationSourceRef(descriptor, mode, selectionOrder);
  const identityRef: AIContextSourceRef = {
    ...descriptor.sourceRef,
    field: options.includeProjectAssociationInPrompt === false
      ? "allowlisted bounded Literature metadata; Project association retained only as internal scope-safety provenance"
      : mode !== "MINIMAL"
        ? "allowlisted bounded Literature metadata"
        : "identity, reading status, and optional Project association",
    contextMode: mode,
    contextLevel: 1,
    contextRole: "primary",
    contextDisposition: "included"
  };
  const summary = promptSummary(
    projection,
    mode,
    options.includeProjectAssociationInPrompt !== false
  );
  return {
    primary: {
      id: `primary-literature:${descriptor.objectId}`,
      title: projection.title,
      summary,
      module: "literature",
      entityType: "literature",
      sourceRefs: [identityRef, associationRef],
      priority: "critical",
      contextLevel: 1,
      protectedFromContextBudget: true,
      stableOrder: selectionOrder,
      charCount: projection.title.length + summary.length,
      sendable: true,
      truncated: false,
      metadata: {
        readingStatus: projection.readingStatus,
        projectAssociationKind: associationRef.literatureProjectAssociationKind ?? "projectless",
        canonicalProjectId: associationRef.literatureCanonicalProjectId ?? null,
        selectionOrder
      }
    },
    excluded: [],
    warnings: [],
    requestableRefs: [{
      refKind: "AI_RESEARCH_OBJECT",
      refId: descriptor.objectId,
      projectId: descriptor.projectId,
      label: descriptor.label,
      entityType: "literature",
      allowedContributionKinds: ["IDENTITY_METADATA"]
    }]
  };
}

/** Stamps the exact post-redaction/truncation prompt-visible projection fingerprint. */
export function finalizeLiteraturePromptVisibleProjectionFingerprints(
  sections: readonly AIContextSection[]
): AIContextSection[] {
  return sections.map((section) => {
    const items = section.items.map((item) => {
      if (item.entityType !== "literature") return item;
      const promptVisibleFingerprint = fingerprint("lp13-a15-literature-prompt", {
        id: item.id,
        title: item.title,
        summary: item.summary,
        metadata: item.metadata ?? null,
        disposition: "included"
      });
      return {
        ...item,
        sourceRefs: item.sourceRefs.map((sourceRef) => sourceRef.entityType === "literature"
          ? { ...sourceRef, literatureNormalizedProjectionFingerprint: promptVisibleFingerprint }
          : sourceRef)
      };
    });
    const sourceRefs = items.flatMap((item) => item.sourceRefs);
    const unique = new Map<string, AIContextSourceRef>();
    for (const sourceRef of sourceRefs) {
      const key = `${sourceRef.module}:${sourceRef.entityType}:${sourceRef.entityId}:${sourceRef.field ?? ""}:${sourceRef.contextRole ?? ""}`;
      if (!unique.has(key)) unique.set(key, sourceRef);
    }
    return { ...section, items, sourceRefs: [...unique.values()] };
  });
}

export function readLiteratureAssociationTuples(
  sourceRefs: readonly AIContextSourceRef[]
): AILiteratureAssociationTuple[] {
  const tuples = sourceRefs.flatMap((sourceRef) => {
    if (sourceRef.field !== "canonical Literature Project association") return [];
    if (
      sourceRef.entityType !== "literature" || !sourceRef.entityId.trim() ||
      (sourceRef.literatureProjectAssociationKind !== "assigned" &&
        sourceRef.literatureProjectAssociationKind !== "projectless") ||
      !("literatureCanonicalProjectId" in sourceRef) ||
      sourceRef.literatureLifecycleEligibility !== "eligible" ||
      (sourceRef.literatureConversationProjectEligibilityDisposition !== "allowed_same_project" &&
        sourceRef.literatureConversationProjectEligibilityDisposition !== "allowed_global_projectless") ||
      !Number.isSafeInteger(sourceRef.literatureSelectionOrder) ||
      (sourceRef.literatureSelectionOrder ?? -1) < 0 ||
      !sourceRef.literatureNormalizedProjectionFingerprint?.trim() ||
      sourceRef.literatureSelectionAggregateEligibility !== "ALLOWED"
    ) {
      throw new Error("The canonical Literature association tuple is malformed.");
    }
    const canonicalProjectId = sourceRef.literatureCanonicalProjectId ?? null;
    if (
      (sourceRef.literatureProjectAssociationKind === "assigned" &&
        (!canonicalProjectId || sourceRef.literatureConversationProjectEligibilityDisposition !== "allowed_same_project")) ||
      (sourceRef.literatureProjectAssociationKind === "projectless" &&
        (canonicalProjectId !== null || sourceRef.literatureConversationProjectEligibilityDisposition !== "allowed_global_projectless"))
    ) {
      throw new Error("Literature Project association and eligibility dispositions contradict each other.");
    }
    return [{
      literatureId: sourceRef.entityId,
      projectAssociationKind: sourceRef.literatureProjectAssociationKind,
      canonicalProjectId,
      lifecycleEligibility: sourceRef.literatureLifecycleEligibility,
      conversationProjectEligibilityDisposition: sourceRef.literatureConversationProjectEligibilityDisposition,
      selectionOrder: sourceRef.literatureSelectionOrder as number,
      normalizedProjectionFingerprint: sourceRef.literatureNormalizedProjectionFingerprint
    }];
  }).sort((left, right) => left.selectionOrder - right.selectionOrder ||
    left.literatureId.localeCompare(right.literatureId));
  const unique = new Map<string, AILiteratureAssociationTuple>();
  for (const tuple of tuples) {
    const prior = unique.get(tuple.literatureId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(tuple)) {
      throw new Error(`Literature ${tuple.literatureId} has contradictory association tuples.`);
    }
    if (!prior) unique.set(tuple.literatureId, tuple);
  }
  if (new Set([...unique.values()].map((tuple) => tuple.selectionOrder)).size !== unique.size) {
    throw new Error("Selected Literature refs require unique deterministic selection order values.");
  }
  return [...unique.values()];
}
