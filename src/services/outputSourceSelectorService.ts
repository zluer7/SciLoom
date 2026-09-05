import { experimentRunService } from "./experimentRunService";
import { experimentService } from "./experimentService";
import { literatureService } from "./literatureService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { planningService } from "./planningService";
import { queryOutputSourceLinks, queryOutputSourceLinksByOwner } from "./outputSourceLinkService";
import type {
  EntityId,
  OutputSourceCard,
  OutputSourceContextForAi,
  OutputSourceLink,
  OutputSourceOwnerType,
  OutputSourceSummary,
  OutputSourceType
} from "../types";

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/?)[^\s"'<>|]+/gi;

function redactPathLikeText(value: string | null | undefined) {
  return (value ?? "").replace(LOCAL_PATH_PATTERN, "[local path]").replace(/\s+/g, " ").trim();
}

function fallbackTitle(link: OutputSourceLink) {
  return redactPathLikeText(link.sourceTitleSnapshot) || `${link.sourceType}:${link.sourceId ?? "manual"}`;
}

function toWarning(link: OutputSourceLink, detail: string) {
  return `Output source ${link.sourceType}:${link.sourceId ?? link.sourceTitleSnapshot} ${detail}.`;
}

async function resolveSourceTitle(link: OutputSourceLink): Promise<{
  sourceTitle: string;
  sourceStatus: OutputSourceCard["sourceStatus"];
  warning?: string;
}> {
  if (link.sourceType === "other") {
    return {
      sourceTitle: fallbackTitle(link),
      sourceStatus: "active"
    };
  }

  if (!link.sourceId) {
    return {
      sourceTitle: fallbackTitle(link),
      sourceStatus: "missing",
      warning: toWarning(link, "is missing sourceId")
    };
  }

  try {
    switch (link.sourceType) {
      case "experiment": {
        const experiment = await experimentService.getExperimentById(link.sourceId);
        if (!experiment) break;
        return { sourceTitle: redactPathLikeText(experiment.title), sourceStatus: "active" };
      }
      case "experimentRun": {
        const run = await experimentRunService.getRunById(link.sourceId);
        if (!run) break;
        return {
          sourceTitle: redactPathLikeText(run.title || run.runLabel || link.sourceTitleSnapshot),
          sourceStatus: "active"
        };
      }
      case "literature": {
        const literature = await literatureService.getLiteratureById(link.sourceId);
        if (!literature) break;
        return { sourceTitle: redactPathLikeText(literature.title), sourceStatus: "active" };
      }
      case "review": {
        const review = await planningService.getReviewById(link.sourceId);
        if (!review) break;
        return { sourceTitle: redactPathLikeText(review.title), sourceStatus: "active" };
      }
      case "resultItem": {
        const resultItem = await outputConversionService.getResultItemById(link.sourceId);
        if (!resultItem) break;
        return { sourceTitle: redactPathLikeText(resultItem.title), sourceStatus: "active" };
      }
      case "finding": {
        const finding = await outputConversionService.getFindingById(link.sourceId);
        if (!finding) break;
        return { sourceTitle: redactPathLikeText(finding.title), sourceStatus: "active" };
      }
      case "outputCandidate": {
        const candidate = await outputConversionService.getOutputCandidateById(link.sourceId);
        if (!candidate) break;
        return { sourceTitle: redactPathLikeText(candidate.title), sourceStatus: "active" };
      }
      default:
        link.sourceType satisfies never;
    }
  } catch (error) {
    return {
      sourceTitle: fallbackTitle(link),
      sourceStatus: "missing",
      warning: toWarning(link, `failed to resolve: ${error instanceof Error ? error.message : "unknown error"}`)
    };
  }

  return {
    sourceTitle: fallbackTitle(link),
    sourceStatus: "missing",
    warning: toWarning(link, "could not be resolved")
  };
}

async function resolveOwnerTitle(ownerType: OutputSourceOwnerType, ownerId: EntityId) {
  switch (ownerType) {
    case "resultItem":
      return outputConversionService.getResultItemById(ownerId);
    case "finding":
      return outputConversionService.getFindingById(ownerId);
    case "outputCandidate":
      return outputConversionService.getOutputCandidateById(ownerId);
    case "outputGap":
      return outputConversionService.getOutputGapById(ownerId);
    case "researchOutput":
      return outputService.getById(ownerId);
    default:
      ownerType satisfies never;
      return undefined;
  }
}

export async function queryActiveResultItemSourceLinksBySource(
  sourceType: OutputSourceType,
  sourceId: EntityId
) {
  const links = await queryOutputSourceLinks({
    ownerType: "resultItem",
    sourceType,
    sourceId,
    includeDeleted: false
  });
  const activeLinks: OutputSourceLink[] = [];
  for (const link of links) {
    const owner = await outputConversionService.getResultItemById(link.ownerId);
    if (owner) {
      activeLinks.push(link);
    }
  }
  return activeLinks;
}

export async function countActiveResultItemsByOutputSource(
  sourceType: OutputSourceType,
  sourceId: EntityId
) {
  const links = await queryActiveResultItemSourceLinksBySource(sourceType, sourceId);
  return new Set(links.map((link) => link.ownerId)).size;
}

export function sortOutputSourceCards(cards: OutputSourceCard[]) {
  return [...cards].sort(
    (a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}

async function toOutputSourceCard(link: OutputSourceLink): Promise<OutputSourceCard> {
  const resolved = await resolveSourceTitle(link);
  return {
    id: link.id,
    ownerType: link.ownerType,
    ownerId: link.ownerId,
    sourceType: link.sourceType,
    sourceId: link.sourceId,
    sourceTitle: resolved.sourceTitle,
    sourceTitleSnapshot: fallbackTitle(link),
    sourceSummarySnapshot: redactPathLikeText(link.sourceSummarySnapshot),
    sourceNote: redactPathLikeText(link.sourceNote),
    relationType: link.relationType,
    orderIndex: link.orderIndex,
    sourceStatus: resolved.sourceStatus,
    warning: resolved.warning,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function countCardsBySourceType(cards: OutputSourceCard[]) {
  return cards.reduce<OutputSourceSummary["countsBySourceType"]>((counts, card) => {
    counts[card.sourceType] = (counts[card.sourceType] ?? 0) + 1;
    return counts;
  }, {});
}

export async function getOutputSourceCards(
  ownerType: OutputSourceOwnerType,
  ownerId: EntityId
) {
  await resolveOwnerTitle(ownerType, ownerId);
  await queryOutputSourceLinksByOwner(ownerType, ownerId);
  const links = await queryOutputSourceLinks({ ownerType, ownerId, includeDeleted: false });
  const cards = await Promise.all(links.map(toOutputSourceCard));
  return sortOutputSourceCards(cards);
}

export async function getOutputSourcesForOwner(
  ownerType: OutputSourceOwnerType,
  ownerId: EntityId
) {
  return getOutputSourceCards(ownerType, ownerId);
}

export async function getOutputSourceSummary(
  ownerType: OutputSourceOwnerType,
  ownerId: EntityId
): Promise<OutputSourceSummary> {
  const cards = await getOutputSourceCards(ownerType, ownerId);
  return {
    ownerType,
    ownerId,
    countsBySourceType: countCardsBySourceType(cards),
    total: cards.length,
    hasMissingSources: cards.some((card) => card.sourceStatus === "missing"),
    cards
  };
}

export async function getOutputSourceContextForAi(
  ownerType: OutputSourceOwnerType,
  ownerId: EntityId
): Promise<OutputSourceContextForAi> {
  const summary = await getOutputSourceSummary(ownerType, ownerId);
  const warnings = summary.cards.flatMap((card) => (card.warning ? [card.warning] : []));
  return {
    ownerType,
    ownerId,
    total: summary.total,
    hasMissingSources: summary.hasMissingSources,
    sources: summary.cards.map((card) => ({
      id: card.id,
      sourceType: card.sourceType,
      sourceId: card.sourceId,
      sourceTitle: card.sourceTitle,
      sourceSummarySnapshot: card.sourceSummarySnapshot,
      sourceNote: card.sourceNote,
      relationType: card.relationType,
      sourceStatus: card.sourceStatus,
      warning: card.warning
    })),
    warnings,
    safetyPolicy: {
      fileBodiesRead: false,
      fullLocalPathsExcluded: true,
      aiInvoked: false
    }
  };
}

export type { OutputSourceType };
