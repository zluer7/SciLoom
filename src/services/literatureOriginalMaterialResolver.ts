import type { AISelectableFileRef, AISelectableFileRefCatalog } from "../types/aiConversation";
import type {
  AIContextMaterialSelection,
  AILiteratureOriginalMaterialResolutionDisposition
} from "../types/aiContext";
import type { FileRef } from "../types";

export type LiteratureOriginalMaterialResolution = {
  disposition: AILiteratureOriginalMaterialResolutionDisposition;
  candidateCount: number;
  resolvedFileRefId?: string;
  bodyUsable: boolean;
  autoAttachDisposition: "ATTACHED" | "DEFERRED_NONBLOCKING" | "SKIPPED_NONBLOCKING";
  selection?: AIContextMaterialSelection;
};

function leaf(value: string): string {
  const parts = value.replace(/\\/gu, "/").split("/").filter(Boolean);
  return parts[parts.length - 1]?.trim() ?? "";
}

const ORIGINAL_MATERIAL_EXTENSION = /\.(?:pdf|md|markdown|txt)$/iu;

function originalMaterialIdentity(fileRef: FileRef): string | undefined {
  const display = leaf(fileRef.title || fileRef.path);
  const pathLeaf = leaf(fileRef.path);
  const candidate = ORIGINAL_MATERIAL_EXTENSION.test(display)
    ? display
    : ORIGINAL_MATERIAL_EXTENSION.test(pathLeaf) ? pathLeaf : undefined;
  return candidate?.replace(ORIGINAL_MATERIAL_EXTENSION, "").trim().toLocaleLowerCase();
}

function exactMetadataKeys(title: string, doi?: string | null): Set<string> {
  const keys = new Set<string>();
  const titleKey = leaf(title).replace(ORIGINAL_MATERIAL_EXTENSION, "").trim().toLocaleLowerCase();
  if (titleKey) keys.add(titleKey);
  const doiKey = doi?.trim().toLocaleLowerCase();
  if (doiKey) {
    keys.add(doiKey);
    keys.add(doiKey.replace(/[\\/]/gu, "_"));
    keys.add(doiKey.replace(/[\\/]/gu, "-"));
  }
  return keys;
}

function selection(entry: AISelectableFileRef): AIContextMaterialSelection | undefined {
  if (
    entry.resourceKind !== "file" ||
    entry.availabilityStatus !== "available" ||
    entry.materialReadStatus !== "supported" ||
    !entry.materialFreshnessReceipt ||
    entry.materialFreshnessReceipt.fileRefId !== entry.fileRefId ||
    !Number.isSafeInteger(entry.materialPromptReservationCharacters) ||
    (entry.materialPromptReservationCharacters ?? 0) <= 0
  ) {
    return undefined;
  }
  return {
    fileRefId: entry.fileRefId,
    displayName: entry.displayName,
    availabilityStatus: entry.availabilityStatus,
    materialReadStatus: entry.materialReadStatus,
    materialPromptReservationCharacters: entry.materialPromptReservationCharacters!,
    materialFreshnessReceipt: { ...entry.materialFreshnessReceipt }
  };
}

/**
 * Resolves only existing exact-owner canonical PDF or Provider-readable text FileRefs. The current product has
 * no bounded first-level directory-list command, so absence of a formal reference is
 * a truthful nonblocking defer rather than a new filesystem authority.
 */
export function resolveLiteratureOriginalMaterial(input: {
  ownerId: string;
  title: string;
  doi?: string | null;
  ownerFileRefs: readonly FileRef[];
  materialCatalog: AISelectableFileRefCatalog;
}): LiteratureOriginalMaterialResolution {
  const candidates = input.ownerFileRefs
    .filter((fileRef) =>
      !fileRef.deletedAt &&
      fileRef.ownerType === "literature" &&
      fileRef.ownerId === input.ownerId &&
      fileRef.fileRole === "attachment" &&
      fileRef.resourceKind === "file" &&
      Boolean(originalMaterialIdentity(fileRef))
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (candidates.length === 0) {
    return {
      disposition: "NOT_FOUND",
      candidateCount: 0,
      bodyUsable: false,
      autoAttachDisposition: "SKIPPED_NONBLOCKING"
    };
  }

  let resolved: FileRef | undefined;
  if (candidates.length === 1) {
    resolved = candidates[0];
  } else {
    const keys = exactMetadataKeys(input.title, input.doi);
    const exact = candidates.filter((candidate) => keys.has(originalMaterialIdentity(candidate) ?? ""));
    if (exact.length === 1) resolved = exact[0];
  }
  if (!resolved) {
    return {
      disposition: "AMBIGUOUS",
      candidateCount: candidates.length,
      bodyUsable: false,
      autoAttachDisposition: "SKIPPED_NONBLOCKING"
    };
  }

  const catalogEntry = input.materialCatalog.fileRefs.find((entry) => entry.fileRefId === resolved?.id);
  if (!catalogEntry) {
    return {
      disposition: "RESOLVED_IDENTITY_NOT_ATTACHABLE",
      candidateCount: candidates.length,
      resolvedFileRefId: resolved.id,
      bodyUsable: false,
      autoAttachDisposition: "DEFERRED_NONBLOCKING"
    };
  }
  const selected = selection(catalogEntry);
  if (selected) {
    return {
      disposition: "RESOLVED_SAFE_ATTACHABLE",
      candidateCount: candidates.length,
      resolvedFileRefId: resolved.id,
      bodyUsable: true,
      autoAttachDisposition: "ATTACHED",
      selection: selected
    };
  }
  return {
    disposition: catalogEntry.materialReadStatus === "unsupported_type"
      ? "RESOLVED_IDENTITY_BODY_UNSUPPORTED"
      : "RESOLVED_IDENTITY_NOT_ATTACHABLE",
    candidateCount: candidates.length,
    resolvedFileRefId: resolved.id,
    bodyUsable: false,
    autoAttachDisposition: "DEFERRED_NONBLOCKING"
  };
}
