import { outputGapFeedbackCardRepositoryConfig } from "../repositories/entityConfig";
import { createRepository } from "../repositories/repositoryFactory";
import type {
  CreateOutputGapFeedbackCardInput,
  EntityId,
  OutputGapFeedbackCard,
  OutputGapFeedbackCardPriority,
  OutputGapFeedbackCardStatus,
  OutputGapFeedbackCardType,
  QueryOutputGapFeedbackCardsOptions,
  UpdateOutputGapFeedbackCardInput
} from "../types";
import type { RefreshKey } from "../types/writeFeedback";
import { outputConversionService } from "./outputConversionService";
import { publishWriteFeedbackRefresh } from "./refreshEventService";
import { createSuccessWriteFeedback } from "./writeFeedbackService";

const outputGapFeedbackCardRepository = createRepository<OutputGapFeedbackCard>(
  outputGapFeedbackCardRepositoryConfig
);

const CARD_TYPES = ["route", "task"] as const satisfies readonly OutputGapFeedbackCardType[];
const CARD_STATUSES = ["pending", "resolved"] as const satisfies readonly OutputGapFeedbackCardStatus[];
const CARD_PRIORITIES = ["high", "medium", "low"] as const satisfies readonly OutputGapFeedbackCardPriority[];
const FEEDBACK_CARD_REFRESH_KEYS = ["output.gap.changed"] as const satisfies readonly RefreshKey[];

function nowIso() {
  return new Date().toISOString();
}

function normalizeRequiredText(value: string, fieldName: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }
  return trimmed;
}

function normalizeOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertCardType(type: OutputGapFeedbackCardType) {
  if (!CARD_TYPES.includes(type)) {
    throw new Error(`Unsupported OutputGapFeedbackCard type: ${type}.`);
  }
}

function assertCardStatus(status: OutputGapFeedbackCardStatus) {
  if (!CARD_STATUSES.includes(status)) {
    throw new Error(`Unsupported OutputGapFeedbackCard status: ${status}.`);
  }
}

function assertCardPriority(priority: OutputGapFeedbackCardPriority) {
  if (!CARD_PRIORITIES.includes(priority)) {
    throw new Error(`Unsupported OutputGapFeedbackCard priority: ${priority}.`);
  }
}

function cardMatchesOptions(
  card: OutputGapFeedbackCard,
  options: QueryOutputGapFeedbackCardsOptions
) {
  if (!options.includeArchived && card.archivedAt) {
    return false;
  }
  if (options.type && card.type !== options.type) {
    return false;
  }
  if (options.status && card.status !== options.status) {
    return false;
  }
  return true;
}

function sortCards(cards: OutputGapFeedbackCard[]) {
  return [...cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function publishOutputGapFeedbackCardRefresh(
  card: OutputGapFeedbackCard,
  operation: string,
  relation: string,
  reason: string
) {
  const feedback = createSuccessWriteFeedback({
    operation,
    data: card,
    affectedEntities: [
      {
        type: "outputGapFeedbackCard",
        id: card.id,
        label: card.title,
        relation
      },
      {
        type: "outputGap",
        id: card.outputGapId,
        relation: "updated"
      }
    ],
    affectedScopes: [
      {
        module: "outputConversion",
        projectId: card.projectId,
        outputGapId: card.outputGapId,
        reason
      }
    ],
    refreshKeys: [...FEEDBACK_CARD_REFRESH_KEYS]
  });
  publishWriteFeedbackRefresh(feedback, {
    reason
  });
}

export async function createOutputGapFeedbackCard(
  input: CreateOutputGapFeedbackCardInput
): Promise<OutputGapFeedbackCard> {
  assertCardType(input.type);
  const status = input.status ?? "pending";
  const priority = input.priority ?? "medium";
  assertCardStatus(status);
  assertCardPriority(priority);

  const outputGap = await outputConversionService.getOutputGapById(input.outputGapId);
  if (!outputGap) {
    throw new Error(`OutputGap not found: ${input.outputGapId}.`);
  }

  const created = await outputGapFeedbackCardRepository.create({
    projectId: outputGap.projectId,
    outputGapId: outputGap.id,
    type: input.type,
    title: normalizeRequiredText(input.title, "title"),
    description: input.description ?? `来源成果缺口：${outputGap.title}`,
    status,
    priority,
    archivedAt: null
  });
  const persisted = await outputGapFeedbackCardRepository.getById(created.id);
  if (!persisted) {
    throw new Error("OutputGapFeedbackCard was created but could not be read back.");
  }
  publishOutputGapFeedbackCardRefresh(
    persisted,
    "outputGapFeedbackCard.create",
    "created",
    "OutputGap feedback card created."
  );
  return persisted;
}

async function applyOutputGapFeedbackCardPatch(
  id: EntityId,
  patch: UpdateOutputGapFeedbackCardInput,
  operation: string,
  reason: string
) {
  const current = await outputGapFeedbackCardRepository.getById(id);
  if (!current) {
    return undefined;
  }
  const nextType = patch.type ?? current.type;
  const nextStatus = patch.status ?? current.status;
  const nextPriority = patch.priority ?? current.priority;
  assertCardType(nextType);
  assertCardStatus(nextStatus);
  assertCardPriority(nextPriority);

  const updated = await outputGapFeedbackCardRepository.update(id, {
    type: nextType,
    title:
      patch.title !== undefined
        ? normalizeRequiredText(patch.title, "title")
        : current.title,
    description:
      patch.description !== undefined
        ? normalizeOptionalText(patch.description)
        : current.description ?? null,
    status: nextStatus,
    priority: nextPriority
  });
  if (!updated) {
    throw new Error("OutputGapFeedbackCard update failed.");
  }
  const persisted = await outputGapFeedbackCardRepository.getById(updated.id);
  if (persisted) {
    publishOutputGapFeedbackCardRefresh(persisted, operation, "updated", reason);
  }
  return persisted;
}

export async function updateOutputGapFeedbackCard(
  id: EntityId,
  patch: UpdateOutputGapFeedbackCardInput
) {
  return applyOutputGapFeedbackCardPatch(
    id,
    patch,
    "outputGapFeedbackCard.update",
    "OutputGap feedback card updated."
  );
}

export async function setOutputGapFeedbackCardStatus(
  id: EntityId,
  status: OutputGapFeedbackCardStatus
) {
  return applyOutputGapFeedbackCardPatch(
    id,
    { status },
    "outputGapFeedbackCard.status.update",
    "OutputGap feedback card status changed."
  );
}

export async function archiveOutputGapFeedbackCard(id: EntityId) {
  const current = await outputGapFeedbackCardRepository.getById(id);
  if (!current) {
    return undefined;
  }
  const updated = await outputGapFeedbackCardRepository.update(id, { archivedAt: nowIso() });
  if (updated) {
    publishOutputGapFeedbackCardRefresh(
      updated,
      "outputGapFeedbackCard.archive",
      "updated",
      "OutputGap feedback card archived."
    );
  }
  return updated;
}

export async function restoreOutputGapFeedbackCard(id: EntityId) {
  const current = await outputGapFeedbackCardRepository.getById(id);
  if (!current) {
    return undefined;
  }
  const updated = await outputGapFeedbackCardRepository.update(id, { archivedAt: null });
  if (updated) {
    publishOutputGapFeedbackCardRefresh(
      updated,
      "outputGapFeedbackCard.restore",
      "updated",
      "OutputGap feedback card restored."
    );
  }
  return updated;
}

export async function deleteOutputGapFeedbackCard(id: EntityId) {
  const current = await outputGapFeedbackCardRepository.getById(id);
  await outputGapFeedbackCardRepository.softDelete(id);
  const deleted = await outputGapFeedbackCardRepository.hardDelete(id);
  if (deleted && current) {
    publishOutputGapFeedbackCardRefresh(
      current,
      "outputGapFeedbackCard.delete",
      "deleted",
      "OutputGap feedback card deleted."
    );
  }
  return deleted;
}

export async function getOutputGapFeedbackCard(id: EntityId) {
  return outputGapFeedbackCardRepository.getById(id);
}

export async function queryOutputGapFeedbackCardsByGap(
  outputGapId: EntityId,
  options: QueryOutputGapFeedbackCardsOptions = {}
) {
  const activeCards = await outputGapFeedbackCardRepository.list();
  const deletedCards = options.includeDeleted
    ? await outputGapFeedbackCardRepository.listDeleted()
    : [];
  return sortCards([...activeCards, ...deletedCards])
    .filter((card) => card.outputGapId === outputGapId)
    .filter((card) => cardMatchesOptions(card, options));
}

export async function queryOutputGapFeedbackCardsByProject(
  projectId: EntityId,
  options: QueryOutputGapFeedbackCardsOptions = {}
) {
  const activeCards = await outputGapFeedbackCardRepository.list();
  const deletedCards = options.includeDeleted
    ? await outputGapFeedbackCardRepository.listDeleted()
    : [];
  return sortCards([...activeCards, ...deletedCards])
    .filter((card) => card.projectId === projectId)
    .filter((card) => cardMatchesOptions(card, options));
}

export async function queryOutputGapFeedbackCardsForPlanning(
  type: OutputGapFeedbackCardType,
  projectId: EntityId,
  options: Omit<QueryOutputGapFeedbackCardsOptions, "type"> = {}
) {
  assertCardType(type);
  return queryOutputGapFeedbackCardsByProject(projectId, { ...options, type });
}

export const outputGapFeedbackCardService = {
  createOutputGapFeedbackCard,
  updateOutputGapFeedbackCard,
  setOutputGapFeedbackCardStatus,
  archiveOutputGapFeedbackCard,
  restoreOutputGapFeedbackCard,
  deleteOutputGapFeedbackCard,
  getOutputGapFeedbackCard,
  queryOutputGapFeedbackCardsByGap,
  queryOutputGapFeedbackCardsByProject,
  queryOutputGapFeedbackCardsForPlanning
};

export type OutputGapFeedbackCardService = typeof outputGapFeedbackCardService;
