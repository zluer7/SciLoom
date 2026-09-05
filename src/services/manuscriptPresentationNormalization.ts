import type { ManuscriptOutlineFieldDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";

export const MANUSCRIPT_STRUCTURED_OUTLINE_PRESENTATION_HEADING = "###" as const;

export type ManuscriptPresentationLabelResolver = (
  field: ManuscriptOutlineFieldDescriptor
) => string;

function normalizePresentationValue(
  value: unknown,
  emptyValue: string,
  sanitize?: (value: string) => string
) {
  const normalized = value === undefined || value === null
    ? ""
    : String(value).trim();
  if (!normalized) return emptyValue;
  return sanitize ? sanitize(normalized) : normalized;
}

export function formatDescriptorStructuredOutlineMarkdown(input: Readonly<{
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  values: Readonly<Record<string, unknown>>;
  emptyValue?: string;
  newline?: string;
  resolveLabel?: ManuscriptPresentationLabelResolver;
  sanitizeValue?: (value: string) => string;
}>) {
  const descriptor = getManuscriptOutlineDescriptor(
    input.descriptorLookupIdentity
  );
  const newline = input.newline ?? "\n";
  const emptyValue = input.emptyValue ?? "未填写";
  return descriptor.fields.flatMap((field, index) => {
    const label = input.resolveLabel?.(field) ?? field.displayLabel;
    const value = normalizePresentationValue(
      input.values[field.stableKey],
      emptyValue,
      input.sanitizeValue
    ).replace(/\r\n|\r|\n/gu, newline);
    return [
      `${MANUSCRIPT_STRUCTURED_OUTLINE_PRESENTATION_HEADING} ${label}`,
      "",
      value,
      ...(index < descriptor.fields.length - 1 ? [""] : [])
    ];
  });
}

/**
 * Shared BODY presentation for future context-summary insertions. Attribute
 * and relationship facts stay ordinary list text; descriptor-owned outline
 * fields alone become level-three child headings.
 */
export function formatManuscriptContextSummaryMarkdown(input: Readonly<{
  heading: string;
  bodyGroups?: readonly (readonly string[])[];
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  structuredValues: Readonly<Record<string, unknown>>;
  emptyValue?: string;
  newline?: string;
  resolveLabel?: ManuscriptPresentationLabelResolver;
  sanitizeValue?: (value: string) => string;
}>) {
  const newline = input.newline ?? "\n";
  const bodyGroups = (input.bodyGroups ?? [])
    .map((group) => group.filter((line) => line.trim().length > 0))
    .filter((group) => group.length > 0);
  const lines: string[] = [`## ${input.heading}`, ""];
  bodyGroups.forEach((group, index) => {
    lines.push(...group);
    if (index < bodyGroups.length - 1) lines.push("");
  });
  if (bodyGroups.length > 0) lines.push("");
  lines.push(...formatDescriptorStructuredOutlineMarkdown({
    descriptorLookupIdentity: input.descriptorLookupIdentity,
    values: input.structuredValues,
    emptyValue: input.emptyValue,
    newline,
    resolveLabel: input.resolveLabel,
    sanitizeValue: input.sanitizeValue
  }));
  return lines.join(newline).trim();
}

export const manuscriptPresentationNormalization = Object.freeze({
  formatContextSummary: formatManuscriptContextSummaryMarkdown,
  formatStructuredOutline: formatDescriptorStructuredOutlineMarkdown
});
