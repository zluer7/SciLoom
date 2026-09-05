import type {
  ReviewDetailContext,
  ReviewObjectSummary,
  ReviewObjectSummaryType
} from "../../services/reviewSelectorService";
import type { ReviewFileRefPathMaterialSummary } from "../../services/reviewFileRefPathMaterialModel";
import type { Review, ReviewOutlineSection, ReviewOutlineSectionKey } from "../../types";

export type ReviewFormalObjectType = Exclude<ReviewObjectSummaryType, "project">;

export type ReviewFormalObjectItem = {
  id: string;
  targetType: ReviewFormalObjectType;
  title: string;
};

export type ReviewFormalObjectGroups = Record<ReviewFormalObjectType, ReviewFormalObjectItem[]>;

export type ReviewFormalObjectCounts = Record<ReviewFormalObjectType, number>;

export type ReviewFormalOutlineDisplaySection = {
  key: ReviewOutlineSectionKey;
  label: string;
  content: string;
};

export type ReviewFormalObjectCardModel = {
  kind: "objectCard";
  countItems: ReviewFormalObjectType[];
  counts: ReviewFormalObjectCounts;
};

export type ReviewFormalSummaryAction = {
  id: "aiAnalysis" | "openEditor";
  label: string;
};

export type ReviewFormalSummaryCardModel = {
  kind: "summaryCard";
  sections: ReviewFormalOutlineDisplaySection[];
  actions: ReviewFormalSummaryAction[];
  actionPlacement: "summaryActionsRight";
};

export type ReviewFormalPathRecordView = {
  fileRefId: string;
  title: string;
  pathSummary: string;
  notes?: string;
  actions: Array<{
    id: "open" | "reveal" | "copy" | "edit" | "delete";
    label: string;
    danger?: true;
  }>;
};

export type ReviewFormalPathSectionModel = {
  title: string;
  states: ["collapsed", "expanded"];
  collapsedByDefault: true;
  addAction: { id: "addPathRecord"; label: string };
};

export type ReviewFormalPathFormModel = {
  fields: Array<{ id: "title" | "path" | "notes"; label: string }>;
  actions: Array<{ id: "addPathRecord" | "cancel"; label: string }>;
};

export const REVIEW_FORMAL_OBJECT_TYPES: ReviewFormalObjectType[] = [
  "routeNode",
  "task",
  "experiment",
  "experimentRun",
  "literature"
];

export const REVIEW_FORMAL_DETAIL_SECTION_ORDER = [
  "objects",
  "summary",
  "pathRecords"
] as const;

function emptyFormalObjectGroups(): ReviewFormalObjectGroups {
  return {
    routeNode: [],
    task: [],
    experiment: [],
    experimentRun: [],
    literature: []
  };
}

function isFormalObjectType(targetType: ReviewObjectSummaryType): targetType is ReviewFormalObjectType {
  return REVIEW_FORMAL_OBJECT_TYPES.includes(targetType as ReviewFormalObjectType);
}

function toFormalObjectItem(target: ReviewObjectSummary): ReviewFormalObjectItem | null {
  if (!isFormalObjectType(target.targetType)) {
    return null;
  }
  return {
    id: target.targetId,
    targetType: target.targetType,
    title: target.title || target.targetId
  };
}

export function isReviewFormalDetailBlocked(review?: Review | null) {
  return !review || Boolean(review.deletedAt);
}

export function buildReviewFormalObjectGroups(
  context?: ReviewDetailContext
): ReviewFormalObjectGroups {
  const groups = emptyFormalObjectGroups();
  for (const target of context?.directTargets ?? []) {
    const item = toFormalObjectItem(target);
    if (item) {
      groups[item.targetType].push(item);
    }
  }
  return groups;
}

export function buildReviewFormalObjectCounts(
  groups: ReviewFormalObjectGroups
): ReviewFormalObjectCounts {
  return {
    routeNode: groups.routeNode.length,
    task: groups.task.length,
    experiment: groups.experiment.length,
    experimentRun: groups.experimentRun.length,
    literature: groups.literature.length
  };
}

export function buildReviewFormalObjectCardModel(
  groups: ReviewFormalObjectGroups
): ReviewFormalObjectCardModel {
  return {
    kind: "objectCard",
    countItems: [...REVIEW_FORMAL_OBJECT_TYPES],
    counts: buildReviewFormalObjectCounts(groups)
  };
}

export function hasReviewFormalObjectIntegrityNotice(context?: ReviewDetailContext) {
  if (!context) {
    return false;
  }
  return context.partial || context.missing.length > 0 || context.warnings.length > 0;
}

export function buildReviewFormalOutlineDisplaySections(
  review: Pick<Review, "outlineSections">,
  labels: Record<ReviewOutlineSectionKey, string>
): ReviewFormalOutlineDisplaySection[] {
  return review.outlineSections.map((section: ReviewOutlineSection) => ({
    key: section.key,
    label: labels[section.key],
    content: section.content.trim()
  }));
}

export function buildReviewFormalSummaryCardModel(
  sections: ReviewFormalOutlineDisplaySection[],
  labels: {
    emptyContent: string;
    aiAnalysis: string;
    openEditor: string;
  }
): ReviewFormalSummaryCardModel {
  return {
    kind: "summaryCard",
    sections: sections.map((section) => ({
      ...section,
      content: section.content || labels.emptyContent
    })),
    actions: [
      { id: "aiAnalysis", label: labels.aiAnalysis },
      { id: "openEditor", label: labels.openEditor }
    ],
    actionPlacement: "summaryActionsRight"
  };
}

export function buildReviewFormalPathRecordView(
  summary: ReviewFileRefPathMaterialSummary,
  labels: {
    open: string;
    reveal: string;
    copy: string;
    edit: string;
    delete: string;
  }
): ReviewFormalPathRecordView {
  return {
    fileRefId: summary.fileRefId,
    title: summary.title || summary.displayName,
    pathSummary: summary.pathSummary,
    notes: summary.notes?.trim() || undefined,
    actions: [
      { id: "open", label: labels.open },
      { id: "reveal", label: labels.reveal },
      { id: "copy", label: labels.copy },
      { id: "edit", label: labels.edit },
      { id: "delete", label: labels.delete, danger: true }
    ]
  };
}

export function buildReviewFormalPathSectionModel(labels: {
  title: string;
  addPathRecord: string;
}): ReviewFormalPathSectionModel {
  return {
    title: labels.title,
    states: ["collapsed", "expanded"],
    collapsedByDefault: true,
    addAction: { id: "addPathRecord", label: labels.addPathRecord }
  };
}

export function buildReviewFormalPathFormModel(labels: {
  title: string;
  path: string;
  notes: string;
  addPathRecord: string;
  cancel: string;
}): ReviewFormalPathFormModel {
  return {
    fields: [
      { id: "title", label: labels.title },
      { id: "path", label: labels.path },
      { id: "notes", label: labels.notes }
    ],
    actions: [
      { id: "addPathRecord", label: labels.addPathRecord },
      { id: "cancel", label: labels.cancel }
    ]
  };
}

export function getReviewFormalDetailHeaderActions() {
  return ["edit"] as const;
}

export function getReviewFormalSummaryActions() {
  return ["aiAnalysis", "openEditor"] as const;
}
