import type {
  Finding,
  OutputCandidate,
  OutputGap,
  ResearchOutput,
  ResultItem,
  StructuredSummary
} from "../types";
import {
  getOutputCanonicalValueDescriptor,
  type OutputCanonicalValueOwnerType
} from "../types/outputCanonicalValue";
import { normalizeStructuredSummary } from "../types/outputStructuredSummary";
import { getOutputOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";

export type OutputCanonicalValueEntity =
  | ResultItem
  | Finding
  | OutputCandidate
  | OutputGap
  | ResearchOutput;

export function readOutputDirectCanonicalValue(
  ownerType: OutputCanonicalValueOwnerType,
  entity: OutputCanonicalValueEntity
): string {
  const descriptor = getOutputCanonicalValueDescriptor(ownerType);
  const value = (entity as unknown as Record<string, unknown>)[descriptor.directEntityField];
  return value === undefined || value === null ? descriptor.clearValue : String(value);
}

/**
 * Builds the six-field visible outline without reading the retired nested brief duplicate.
 * The first stable key always comes from the owner's direct canonical field.
 */
export function buildOutputCanonicalPresentationSummary(
  ownerType: OutputCanonicalValueOwnerType,
  directCanonicalValue: string,
  persistedStructuredSummary: unknown
): StructuredSummary {
  const canonical = getOutputCanonicalValueDescriptor(ownerType);
  const nestedByKey = new Map(
    normalizeStructuredSummary(ownerType, persistedStructuredSummary)
      .map((section) => [section.key, section] as const)
  );
  return getOutputOutlineDescriptor(ownerType).fields.map((field) => ({
    key: field.stableKey,
    label: field.displayLabel,
    value: field.stableKey === canonical.stableKey
      ? directCanonicalValue
      : nestedByKey.get(field.stableKey)?.value ?? "",
    order: field.order + 1
  }));
}

export function outputNestedDuplicateIsAbsent(
  ownerType: OutputCanonicalValueOwnerType,
  structuredSummary: unknown
) {
  if (!Array.isArray(structuredSummary)) return true;
  const duplicateKey = getOutputCanonicalValueDescriptor(ownerType).nestedDuplicateKey;
  return !structuredSummary.some((section) =>
    section &&
    typeof section === "object" &&
    (section as { key?: unknown }).key === duplicateKey
  );
}

export const outputCanonicalValueCoherenceService = Object.freeze({
  readDirect: readOutputDirectCanonicalValue,
  buildPresentationSummary: buildOutputCanonicalPresentationSummary,
  nestedDuplicateIsAbsent: outputNestedDuplicateIsAbsent
});
