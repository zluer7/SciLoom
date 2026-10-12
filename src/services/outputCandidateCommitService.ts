import { invoke } from "@tauri-apps/api/core";
import { createRepositoryEntityId } from "../repositories/entityId";
import { fromSQLiteRecord, toSQLiteRecord } from "../repositories/sqliteRepository";
import type { ResearchOutput } from "../types/output";
import type { OutputCandidate, OutputConversionRelation } from "../types/outputConversion";
import type { CreateResearchOutputInput } from "./outputService";
import { normalizeFiveLayerEntity } from "./outputFiveLayerContractService";
import { outputConversionRelationService } from "./outputConversionRelationService";
import { outputService } from "./outputService";

/** One DB transaction commits output + candidate + converted_to. Manuscript
 * provisioning remains a separate, idempotently resumable effect. */
export async function commitOutputCandidateConversion(
  candidate: OutputCandidate,
  input: CreateResearchOutputInput,
  allowUnresolvedGaps?: boolean
) {
  const timestamp = new Date().toISOString();
  const output = normalizeFiveLayerEntity("researchOutput", {
    ...input, id: createRepositoryEntityId("output"), status: input.status ?? "draft",
    structuredSummary: input.structuredSummary ?? [], createdAt: timestamp, updatedAt: timestamp
  }) as ResearchOutput;
  const relation: OutputConversionRelation = {
    id: createRepositoryEntityId("output-relation"), projectId: candidate.projectId,
    sourceType: "outputCandidate", sourceId: candidate.id,
    targetType: "researchOutput", targetId: output.id, relationType: "converted_to",
    note: "OutputCandidate converted to ResearchOutput", schemaVersion: 1,
    createdAt: timestamp, updatedAt: timestamp
  };
  try {
    const result = await invoke<{ created: boolean; output: Record<string, unknown> }>("db_convert_output_candidate", {
      input: { candidateId: candidate.id, expectedCandidateUpdatedAt: candidate.updatedAt,
        confirmedByUser: true, allowUnresolvedGaps,
        outputRecord: toSQLiteRecord<ResearchOutput>("outputs", { ...output, taskId: candidate.taskId ?? undefined }),
        relationRecord: toSQLiteRecord<OutputConversionRelation>("output_conversion_relations", relation) }
    });
    return { created: result.created, output: fromSQLiteRecord<ResearchOutput>("outputs", result.output) };
  } catch (error) {
    // Unknown IPC outcome: consult the durable relation before any retry.
    const links = await outputConversionRelationService.queryOutputConversionRelations({
      sourceType: "outputCandidate", sourceId: candidate.id,
      targetType: "researchOutput", relationType: "converted_to"
    });
    const existing = links[0] ? await outputService.getById(links[0].targetId) : undefined;
    if (existing) return { created: false, output: existing };
    throw error;
  }
}
