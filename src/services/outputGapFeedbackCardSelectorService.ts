import type {
  EntityId,
  OutputGapFeedbackCard,
  OutputGapFeedbackCardType
} from "../types";
import { outputGapFeedbackCardService } from "./outputGapFeedbackCardService";

export type OutputGapFeedbackCardSummary = {
  outputGapId: EntityId;
  cards: OutputGapFeedbackCard[];
  activeCards: OutputGapFeedbackCard[];
  archivedCards: OutputGapFeedbackCard[];
  routeCards: OutputGapFeedbackCard[];
  taskCards: OutputGapFeedbackCard[];
  counts: {
    total: number;
    active: number;
    archived: number;
    pending: number;
    resolved: number;
    route: number;
    task: number;
  };
};

export type PlanningFeedbackCardSummary = {
  projectId: EntityId;
  type: OutputGapFeedbackCardType;
  cards: OutputGapFeedbackCard[];
  counts: {
    total: number;
    pending: number;
    resolved: number;
    archived: number;
  };
};

function buildOutputGapSummary(
  outputGapId: EntityId,
  cards: OutputGapFeedbackCard[]
): OutputGapFeedbackCardSummary {
  const activeCards = cards.filter((card) => !card.archivedAt);
  const archivedCards = cards.filter((card) => Boolean(card.archivedAt));
  const routeCards = cards.filter((card) => card.type === "route");
  const taskCards = cards.filter((card) => card.type === "task");
  return {
    outputGapId,
    cards,
    activeCards,
    archivedCards,
    routeCards,
    taskCards,
    counts: {
      total: cards.length,
      active: activeCards.length,
      archived: archivedCards.length,
      pending: cards.filter((card) => card.status === "pending").length,
      resolved: cards.filter((card) => card.status === "resolved").length,
      route: routeCards.length,
      task: taskCards.length
    }
  };
}

function buildPlanningSummary(
  projectId: EntityId,
  type: OutputGapFeedbackCardType,
  cards: OutputGapFeedbackCard[]
): PlanningFeedbackCardSummary {
  return {
    projectId,
    type,
    cards,
    counts: {
      total: cards.length,
      pending: cards.filter((card) => card.status === "pending").length,
      resolved: cards.filter((card) => card.status === "resolved").length,
      archived: cards.filter((card) => Boolean(card.archivedAt)).length
    }
  };
}

export async function getOutputGapFeedbackCardSummary(outputGapId: EntityId) {
  const cards = await outputGapFeedbackCardService.queryOutputGapFeedbackCardsByGap(
    outputGapId,
    { includeArchived: true }
  );
  return buildOutputGapSummary(outputGapId, cards);
}

export async function queryOutputGapFeedbackCardsForOutputGap(outputGapId: EntityId) {
  return outputGapFeedbackCardService.queryOutputGapFeedbackCardsByGap(outputGapId);
}

export async function queryActiveOutputGapFeedbackCardsForProject(
  projectId: EntityId,
  type: OutputGapFeedbackCardType
) {
  return outputGapFeedbackCardService.queryOutputGapFeedbackCardsForPlanning(type, projectId, {
    includeArchived: false
  });
}

export async function queryArchivedOutputGapFeedbackCardsForOutputGap(outputGapId: EntityId) {
  return outputGapFeedbackCardService.queryOutputGapFeedbackCardsByGap(outputGapId, {
    includeArchived: true
  }).then((cards) => cards.filter((card) => Boolean(card.archivedAt)));
}

export async function getPlanningFeedbackCardSummary(
  projectId: EntityId,
  type: OutputGapFeedbackCardType
) {
  const cards = await outputGapFeedbackCardService.queryOutputGapFeedbackCardsForPlanning(
    type,
    projectId,
    { includeArchived: false }
  );
  return buildPlanningSummary(projectId, type, cards);
}

export const outputGapFeedbackCardSelectorService = {
  getOutputGapFeedbackCardSummary,
  queryOutputGapFeedbackCardsForOutputGap,
  queryActiveOutputGapFeedbackCardsForProject,
  queryArchivedOutputGapFeedbackCardsForOutputGap,
  getPlanningFeedbackCardSummary
};

export type OutputGapFeedbackCardSelectorService =
  typeof outputGapFeedbackCardSelectorService;
