export type OutputCanonicalValueOwnerType =
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type OutputCanonicalDirectEntityField = "summary" | "description";

export interface OutputCanonicalValueDescriptor {
  readonly ownerType: OutputCanonicalValueOwnerType;
  readonly stableKey: string;
  readonly directEntityField: OutputCanonicalDirectEntityField;
  readonly directPersistenceIdentity: string;
  readonly directDatabaseColumn: "summary" | "description";
  readonly nestedDuplicateKey: string;
  readonly clearValue: "";
}

function descriptor(
  ownerType: OutputCanonicalValueOwnerType,
  stableKey: string,
  directEntityField: OutputCanonicalDirectEntityField
): OutputCanonicalValueDescriptor {
  return Object.freeze({
    ownerType,
    stableKey,
    directEntityField,
    directPersistenceIdentity: `${ownerType}.${directEntityField}`,
    directDatabaseColumn: directEntityField,
    nestedDuplicateKey: stableKey,
    clearValue: ""
  });
}

/**
 * E3 authority for the one duplicated Outputs stable key per owner.
 * The direct entity field is canonical; the same-key structured_summary entry is retired.
 */
export const OUTPUT_CANONICAL_VALUE_DESCRIPTORS = Object.freeze({
  resultItem: descriptor("resultItem", "summary", "summary"),
  finding: descriptor("finding", "content", "summary"),
  outputCandidate: descriptor("outputCandidate", "coreClaim", "description"),
  outputGap: descriptor("outputGap", "gapDescription", "description"),
  researchOutput: descriptor("researchOutput", "summary", "description")
} satisfies Record<OutputCanonicalValueOwnerType, OutputCanonicalValueDescriptor>);

export function getOutputCanonicalValueDescriptor(
  ownerType: OutputCanonicalValueOwnerType
): OutputCanonicalValueDescriptor {
  return OUTPUT_CANONICAL_VALUE_DESCRIPTORS[ownerType];
}
