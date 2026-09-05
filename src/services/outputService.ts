import type { ResearchOutput } from "../types/output";
import { outputRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type { CreateEntityInput, EntityId, UpdateEntityInput } from "../types/common";
import {
  normalizeFiveLayerEntity,
  normalizeStatus,
  normalizeStructuredSummary
} from "./outputFiveLayerContractService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createWriteFeedbackResult } from "./writeFeedbackService";
import { ensureOutputManuscript } from "./outputManuscriptProvisioningService";

export type CreateResearchOutputInput = Omit<
  CreateEntityInput<ResearchOutput>,
  "status" | "structuredSummary"
> &
  Partial<Pick<ResearchOutput, "status" | "structuredSummary">>;

export type UpdateResearchOutputInput = UpdateEntityInput<ResearchOutput>;

export type OutputService = {
  listOutputs: () => Promise<ResearchOutput[]>;
  listDeletedOutputs: () => Promise<ResearchOutput[]>;
  list: () => Promise<ResearchOutput[]>;
  getById: (id: EntityId) => Promise<ResearchOutput | undefined>;
  getDeletedById: (id: EntityId) => Promise<ResearchOutput | undefined>;
  create: (input: CreateResearchOutputInput) => Promise<ResearchOutput>;
  update: (id: EntityId, input: UpdateResearchOutputInput) => Promise<ResearchOutput | undefined>;
  updateResearchOutputStatus: (
    id: EntityId,
    status: ResearchOutput["status"]
  ) => Promise<ResearchOutput | undefined>;
};

const repository = createRepository<ResearchOutput>(outputRepositoryConfig);
const DEFAULT_RESEARCH_OUTPUT_STATUS: ResearchOutput["status"] = "draft";

function normalizeResearchOutput(output: ResearchOutput): ResearchOutput {
  return normalizeFiveLayerEntity("researchOutput", output) as ResearchOutput;
}

function toResearchOutputCreateInput(
  input: CreateResearchOutputInput
): CreateEntityInput<ResearchOutput> {
  return {
    ...input,
    status: normalizeStatus(
      "researchOutput",
      input.status ?? DEFAULT_RESEARCH_OUTPUT_STATUS
    ) as ResearchOutput["status"],
    structuredSummary: normalizeStructuredSummary("researchOutput", input.structuredSummary)
  };
}

function publishResearchOutputRefresh(
  operation: string,
  output: ResearchOutput,
  relation: "created" | "updated"
) {
  publishWriteFeedbackRefresh(
    createWriteFeedbackResult({
      status: "success",
      operation,
      affectedEntities: [
        {
          type: "researchOutput",
          id: output.id,
          relation,
          label: output.outputName
        }
      ],
      affectedScopes: [
        {
          module: "output",
          projectId: output.projectId,
          researchOutputId: output.id
        }
      ],
      refreshKeys: ["output.researchOutput.changed", "reviewContext.changed", "aiContext.changed"]
    }),
    {
      source: "service.write",
      reason: operation
    }
  );
}

export const outputService: OutputService = {
  async list() {
    return (await repository.list()).map(normalizeResearchOutput);
  },
  async getById(id) {
    const output = await repository.getById(id);
    return output ? normalizeResearchOutput(output) : undefined;
  },
  async getDeletedById(id) {
    const output = await repository.getDeletedById(id);
    return output ? normalizeResearchOutput(output) : undefined;
  },
  async create(input) {
    const created = normalizeResearchOutput(await repository.create(toResearchOutputCreateInput(input)));
    publishResearchOutputRefresh("output.createResearchOutput", created, "created");
    // Publish the committed business entity first. Provisioning then publishes
    // the authoritative READY/partial outcome last, so a known durable partial
    // cannot be masked by a later generic create-success notice.
    await ensureOutputManuscript("researchOutput", created.id, "primary");
    return created;
  },
  async update(id, input) {
    const existing = await repository.getById(id);
    if (!existing) {
      return undefined;
    }
    const updated = await repository.update(id, {
      ...input,
      status: normalizeStatus("researchOutput", input.status ?? existing.status) as ResearchOutput["status"],
      structuredSummary: normalizeStructuredSummary(
        "researchOutput",
        input.structuredSummary ?? existing.structuredSummary
      )
    });
    if (!updated) {
      return undefined;
    }
    const normalized = normalizeResearchOutput(updated);
    publishResearchOutputRefresh("output.updateResearchOutput", normalized, "updated");
    return normalized;
  },
  async updateResearchOutputStatus(id, status) {
    return outputService.update(id, { status });
  },
  async listOutputs() {
    return outputService.list();
  },
  async listDeletedOutputs() {
    return (await repository.listDeleted()).map(normalizeResearchOutput);
  }
};
