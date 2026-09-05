import type { OutputManuscriptStructuredSnapshot } from "../types";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { serializeCanonicalManuscriptOutline } from "./manuscriptOutlineSerializer";

export const OUTPUT_MANUSCRIPT_DOCUMENT_SCHEMA = "outputs-manuscript@1";
const SCHEMA_MARKER = `<!-- LABPOD_DOCUMENT_SCHEMA:${OUTPUT_MANUSCRIPT_DOCUMENT_SCHEMA} -->`;

function visibleValue(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || "未填写";
}

export function buildOutputManuscriptMetaSnapshot(
  snapshot: OutputManuscriptStructuredSnapshot,
  _filename?: string
) {
  return [
    SCHEMA_MARKER,
    `<!-- LABPOD_PROJECT_ID:${snapshot.projectId} -->`,
    "## 简介",
    "",
    "### 内容简介",
    visibleValue(snapshot.briefDescription),
    "",
    "### 所属课题",
    visibleValue(snapshot.projectTitle)
  ].join("\n");
}

export function buildOutputManuscriptOutline(
  snapshot: OutputManuscriptStructuredSnapshot,
  _filename?: string
) {
  const descriptor = getManuscriptOutlineDescriptor({
    ownerType: snapshot.ownerType,
    channel: "primary"
  });
  const structuredValues = new Map(
    snapshot.structuredSummary.map((section) => [section.key, section.value])
  );
  const firstStableKey = descriptor.fields[0]?.stableKey;
  const values = Object.fromEntries(descriptor.fields.map((field) => [
    field.stableKey,
    field.stableKey === firstStableKey
      ? snapshot.briefDescription
      : structuredValues.get(field.stableKey) ?? ""
  ]));
  return serializeCanonicalManuscriptOutline(descriptor, values);
}

export const outputManuscriptCanonicalProducerService = Object.freeze({
  schemaVersion: OUTPUT_MANUSCRIPT_DOCUMENT_SCHEMA,
  buildMetaSnapshot: buildOutputManuscriptMetaSnapshot,
  buildOutline: buildOutputManuscriptOutline
});
