import { invoke } from "@tauri-apps/api/core";
import type { OutputManuscriptOwnerType, StructuredSummary } from "../types";
import type { EntityId } from "../types/common";
import type { ManuscriptOutlineOwnerApplicationMapping } from "./manuscriptOutlineOwnerProjector";
import { publishRefreshEvent } from "./refreshEventService";
import { getOutputCanonicalValueDescriptor } from "../types/outputCanonicalValue";

export type CommitOutputManuscriptSwitchInput = {
  ownerType: OutputManuscriptOwnerType;
  ownerId: EntityId;
  projectId: EntityId;
  expectedCurrentFileRefId: EntityId;
  nextCurrentFileRefId: EntityId;
  structuredPatch: {
    briefDescription: string;
    structuredSummary: StructuredSummary;
  };
  sourceSchemaVersion: string;
  occurredAt: string;
  operationId: EntityId;
};

export type CommitOutputManuscriptSwitchResult = {
  ownerType: OutputManuscriptOwnerType;
  ownerId: EntityId;
  projectId: EntityId;
  currentFileRefId: EntityId;
  defaultManuscriptFileRefId?: EntityId;
  briefDescription: string;
  structuredSummary: StructuredSummary;
  operationLogId: EntityId;
  operationStatus: "success";
  nestedDuplicateRetired: true;
  durableReadbackConfirmed: true;
};

export function buildOutputManuscriptStructuredPatch(
  expectedOwnerType: OutputManuscriptOwnerType,
  mapping: ManuscriptOutlineOwnerApplicationMapping
): CommitOutputManuscriptSwitchInput["structuredPatch"] {
  if (
    mapping.ownerType !== expectedOwnerType ||
    mapping.channel !== "primary" ||
    mapping.ownerPayload.kind !== "outputs-fields"
  ) {
    throw new Error("OUTPUT_MANUSCRIPT_APPLICATION_IDENTITY_INVALID");
  }
  const canonical = getOutputCanonicalValueDescriptor(expectedOwnerType);
  if (
    mapping.ownerPayload.brief.stableKey !== canonical.stableKey ||
    mapping.ownerPayload.brief.entityField !== canonical.directEntityField
  ) {
    throw new Error("OUTPUT_MANUSCRIPT_CANONICAL_BRIEF_MAPPING_INVALID");
  }
  const structuredSummary = mapping.ownerPayload.structuredSummary.map((section) => ({
    key: section.key,
    value: section.value,
    order: section.order + 1
  }));
  if (structuredSummary.some((section) => section.key === canonical.nestedDuplicateKey)) {
    throw new Error("OUTPUT_MANUSCRIPT_NESTED_DUPLICATE_NOT_RETIRED");
  }
  return {
    briefDescription: mapping.ownerPayload.brief.value,
    structuredSummary
  };
}

function refreshKey(ownerType: OutputManuscriptOwnerType) {
  switch (ownerType) {
    case "resultItem": return "output.resultItem.changed" as const;
    case "finding": return "output.finding.changed" as const;
    case "outputCandidate": return "output.candidate.changed" as const;
    case "outputGap": return "output.gap.changed" as const;
    case "researchOutput": return "output.researchOutput.changed" as const;
  }
}

export async function commitOutputManuscriptSwitch(
  input: CommitOutputManuscriptSwitchInput
): Promise<CommitOutputManuscriptSwitchResult> {
  const result = await invoke<CommitOutputManuscriptSwitchResult>(
    "commit_output_manuscript_switch",
    { input }
  );
  publishRefreshEvent({
    id: `output-manuscript-switch-${input.operationId}`,
    keys: [refreshKey(input.ownerType), "operationLog.changed"],
    affectedEntities: [{ type: input.ownerType, id: input.ownerId, relation: "updated" }],
    affectedScopes: [{ module: "output", projectId: input.projectId, reason: "Current Outputs manuscript switched." }],
    source: "service.write",
    operation: "output.manuscript.switch",
    reason: "Outputs structured working copy and current binding committed atomically.",
    writeFeedbackStatus: "success",
    createdAt: input.occurredAt
  });
  return result;
}

export const outputManuscriptSwitchTransactionService = {
  commitOutputManuscriptSwitch
};
