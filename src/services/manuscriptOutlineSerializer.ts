import type { ManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";

/** A caller-owned typed DTO; descriptor fields select the string values. */
export type ManuscriptOutlineTypedValues = Readonly<object>;

export const MANUSCRIPT_OUTLINE_START_MARKER = "<!-- labpod:outline:start -->" as const;
export const MANUSCRIPT_OUTLINE_END_MARKER = "<!-- labpod:outline:end -->" as const;
export const MANUSCRIPT_OUTLINE_FIELD_MARKER_PREFIX = "<!-- labpod:field=" as const;

export function manuscriptOutlineFieldMarker(stableKey: string) {
  return `${MANUSCRIPT_OUTLINE_FIELD_MARKER_PREFIX}${stableKey} -->`;
}

export function serializeCanonicalManuscriptOutline(
  descriptor: ManuscriptOutlineDescriptor,
  values: ManuscriptOutlineTypedValues
) {
  const source = values as Readonly<Record<string, unknown>>;
  const lines = [MANUSCRIPT_OUTLINE_START_MARKER, `## ${descriptor.outlineHeading}`, ""];
  for (const field of descriptor.fields) {
    const value = typeof source[field.stableKey] === "string" ? source[field.stableKey] as string : "";
    lines.push(manuscriptOutlineFieldMarker(field.stableKey), `### ${field.displayLabel}`, "");
    if (value) lines.push(value, "");
  }
  lines.push(MANUSCRIPT_OUTLINE_END_MARKER);
  return lines.join("\n");
}

export const manuscriptOutlineSerializer = Object.freeze({
  serialize: serializeCanonicalManuscriptOutline,
  fieldMarker: manuscriptOutlineFieldMarker
});
