import { getOutputCanonicalValueDescriptor } from "./outputCanonicalValue";

export type StructuredSummaryEntityType =
  | "resultItem"
  | "finding"
  | "outputCandidate"
  | "outputGap"
  | "researchOutput";

export type StructuredSummarySection = {
  key: string;
  label?: string;
  value: string;
  order: number;
};

export type StructuredSummary = StructuredSummarySection[];

export type StructuredSummaryDefinition = {
  entityType: StructuredSummaryEntityType;
  sections: Array<{
    key: string;
    label: string;
    order: number;
  }>;
};

const definitions: Record<StructuredSummaryEntityType, StructuredSummaryDefinition> = {
  resultItem: {
    entityType: "resultItem",
    sections: [
      { key: "keyPhenomenon", label: "Key metric or phenomenon", order: 2 },
      { key: "conditionBrief", label: "Condition brief", order: 3 },
      { key: "initialJudgement", label: "Initial judgement", order: 4 },
      { key: "conversionValue", label: "Conversion value", order: 5 },
      { key: "other", label: "Other", order: 6 }
    ]
  },
  finding: {
    entityType: "finding",
    sections: [
      { key: "supportingEvidence", label: "Supporting evidence", order: 2 },
      { key: "noveltyDifference", label: "Novelty or difference", order: 3 },
      { key: "reliabilityJudgement", label: "Reliability judgement", order: 4 },
      { key: "boundaryOrMissingEvidence", label: "Boundary or missing evidence", order: 5 },
      { key: "other", label: "Other", order: 6 }
    ]
  },
  outputCandidate: {
    entityType: "outputCandidate",
    sections: [
      { key: "outputType", label: "Output type", order: 2 },
      { key: "innovationContribution", label: "Innovation contribution", order: 3 },
      { key: "evidenceSummary", label: "Evidence summary", order: 4 },
      { key: "risksAndGaps", label: "Risks and gaps", order: 5 },
      { key: "other", label: "Other", order: 6 }
    ]
  },
  outputGap: {
    entityType: "outputGap",
    sections: [
      { key: "gapType", label: "Gap type", order: 2 },
      { key: "affectedObject", label: "Affected object", order: 3 },
      { key: "strengtheningPlan", label: "Strengthening plan", order: 4 },
      { key: "completionCriteria", label: "Completion criteria", order: 5 },
      { key: "other", label: "Other", order: 6 }
    ]
  },
  researchOutput: {
    entityType: "researchOutput",
    sections: [
      { key: "outputType", label: "Output type", order: 2 },
      { key: "coreContribution", label: "Core contribution", order: 3 },
      { key: "sourceChainSummary", label: "Source chain summary", order: 4 },
      { key: "archiveUsage", label: "Archive usage", order: 5 },
      { key: "other", label: "Other", order: 6 }
    ]
  }
};

export function getStructuredSummaryDefinition(
  entityType: StructuredSummaryEntityType
): StructuredSummaryDefinition {
  return definitions[entityType];
}

export function createDefaultStructuredSummary(
  entityType: StructuredSummaryEntityType
): StructuredSummary {
  return definitions[entityType].sections.map((section) => ({
    ...section,
    value: ""
  }));
}

export function normalizeStructuredSummary(
  entityType: StructuredSummaryEntityType,
  input: unknown
): StructuredSummary {
  const retiredDuplicateKey = getOutputCanonicalValueDescriptor(entityType).nestedDuplicateKey;
  const byKey = new Map<string, StructuredSummarySection>();
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const section = item as Partial<StructuredSummarySection>;
      if (typeof section.key !== "string") {
        continue;
      }
      if (section.key === retiredDuplicateKey) {
        continue;
      }
      byKey.set(section.key, {
        key: section.key,
        label: typeof section.label === "string" ? section.label : undefined,
        value: section.value === undefined || section.value === null ? "" : String(section.value),
        order: typeof section.order === "number" ? section.order : 0
      });
    }
  }

  return definitions[entityType].sections.map((definition) => {
    const existing = byKey.get(definition.key);
    return {
      key: definition.key,
      label: definition.label,
      value: existing?.value ?? "",
      order: definition.order
    };
  });
}

export function validateStructuredSummary(
  entityType: StructuredSummaryEntityType,
  input: unknown
): boolean {
  const normalized = normalizeStructuredSummary(entityType, input);
  const expectedKeys = definitions[entityType].sections.map((section) => section.key);
  return (
    normalized.length === expectedKeys.length &&
    expectedKeys.every((key, index) => normalized[index]?.key === key)
  );
}
