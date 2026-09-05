import type { OutputManuscriptStructuredSnapshot } from "../types";
import {
  parseLabPodMarkdownDocument,
  serializeLabPodMarkdownDocument,
  upsertLabPodStandardBlocks
} from "./labPodMarkdownDocumentService";
import {
  buildOutputManuscriptMetaSnapshot,
  buildOutputManuscriptOutline
} from "./outputManuscriptCanonicalProducerService";
export {
  buildOutputManuscriptMetaSnapshot,
  buildOutputManuscriptOutline
} from "./outputManuscriptCanonicalProducerService";
import { getOutputManuscriptStaticDescriptor } from "./outputManuscriptDescriptorService";

export function getOutputManuscriptOutlineLabel(
  ownerType: OutputManuscriptStructuredSnapshot["ownerType"],
  key: string,
  fallback?: string
) {
  return getOutputManuscriptStaticDescriptor(ownerType).structuredFields
    .find((field) => field.key === key)?.displayLabel ?? fallback ?? key;
}

export function replaceOutputManuscriptStandardBlocks(
  rawMarkdown: string,
  blocks: { metaSnapshot: string; outline: string; body: string }
) {
  const parsed = parseLabPodMarkdownDocument(rawMarkdown);
  if (parsed.status === "invalid" || parsed.status === "ambiguous") {
    return { status: "error" as const, parsed };
  }
  const replaced = upsertLabPodStandardBlocks(rawMarkdown, blocks, {
    mode: parsed.status === "missing" ? "normalize" : "strict",
    preserveOutsideContent: parsed.status !== "missing",
    preserveBom: parsed.hasBom,
    newlineStyle: parsed.preferredNewline === "\r\n" ? "crlf" : "lf"
  });
  return replaced.status === "success"
    ? { status: "success" as const, markdown: replaced.markdown, parsed: replaced.source }
    : { status: "error" as const, parsed: replaced.source };
}

export function createOutputManuscriptMarkdown(
  snapshot: OutputManuscriptStructuredSnapshot,
  body: string,
  filename?: string
) {
  return serializeLabPodMarkdownDocument({
    metaSnapshot: buildOutputManuscriptMetaSnapshot(snapshot, filename),
    outline: buildOutputManuscriptOutline(snapshot),
    body
  });
}

export function refreshOutputManuscriptStandardBlocks(
  rawMarkdown: string,
  snapshot: OutputManuscriptStructuredSnapshot,
  body: string,
  filename?: string
) {
  const parsed = parseLabPodMarkdownDocument(rawMarkdown);
  if (parsed.status === "invalid" || parsed.status === "ambiguous") {
    return { status: "error" as const, parsed };
  }
  const refreshed = upsertLabPodStandardBlocks(
    rawMarkdown,
    {
      metaSnapshot: buildOutputManuscriptMetaSnapshot(snapshot, filename),
      outline: buildOutputManuscriptOutline(snapshot),
      body
    },
    {
      mode: parsed.status === "missing" ? "normalize" : "strict",
      preserveOutsideContent: parsed.status !== "missing",
      preserveBom: parsed.hasBom,
      newlineStyle: parsed.preferredNewline === "\r\n" ? "crlf" : "lf"
    }
  );
  return refreshed.status === "success"
    ? { status: "success" as const, markdown: refreshed.markdown, parsed: refreshed.source }
    : { status: "error" as const, parsed: refreshed.source };
}

export const outputManuscriptBlockAdapterService = {
  buildMetaSnapshot: buildOutputManuscriptMetaSnapshot,
  buildOutline: buildOutputManuscriptOutline,
  replaceStandardBlocks: replaceOutputManuscriptStandardBlocks,
  createMarkdown: createOutputManuscriptMarkdown,
  refreshStandardBlocks: refreshOutputManuscriptStandardBlocks,
  parse: parseLabPodMarkdownDocument
};
