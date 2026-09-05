import type { OutputEntityLayer } from "../types/outputSelector";

export const RESEARCH_OUTPUT_MANUSCRIPT_OWNER_TYPE = "researchOutput" as const;

export type ResearchOutputBusinessAlias = "output" | "formalOutput" | "researchOutput";

export function normalizeResearchOutputOwnerAlias(
  value: ResearchOutputBusinessAlias | string
): typeof RESEARCH_OUTPUT_MANUSCRIPT_OWNER_TYPE {
  if (value !== "researchOutput" && value !== "output" && value !== "formalOutput") {
    throw new Error(`OUTPUT_MANUSCRIPT_OWNER_ALIAS_INVALID: ${value}.`);
  }
  return RESEARCH_OUTPUT_MANUSCRIPT_OWNER_TYPE;
}

export function outputLayerFromBusinessAlias(value: string): OutputEntityLayer | undefined {
  return value === "output" || value === "formalOutput" || value === "researchOutput"
    ? normalizeResearchOutputOwnerAlias(value)
    : undefined;
}
