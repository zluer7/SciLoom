export type ReviewEditorModalMode = "create" | "edit";
export type ReviewEditorTargetSectionKey =
  | "routeNode"
  | "task"
  | "experiment"
  | "experimentRun"
  | "literature";

export type ReviewEditorTargetSectionState = Record<ReviewEditorTargetSectionKey, boolean>;

export const REVIEW_EDITOR_TARGET_SECTION_KEYS: ReviewEditorTargetSectionKey[] = [
  "routeNode",
  "task",
  "experiment",
  "experimentRun",
  "literature"
];

export function createCollapsedReviewTargetSections(): ReviewEditorTargetSectionState {
  return {
    routeNode: false,
    task: false,
    experiment: false,
    experimentRun: false,
    literature: false
  };
}

export function toggleReviewTargetSection(
  state: ReviewEditorTargetSectionState,
  section: ReviewEditorTargetSectionKey
): ReviewEditorTargetSectionState {
  return { ...state, [section]: !state[section] };
}

export function expandReviewComparisonTargetSections(
  state: ReviewEditorTargetSectionState,
  reviewType: string
): ReviewEditorTargetSectionState {
  if (reviewType === "experiment_comparison") {
    return { ...state, experiment: true, experimentRun: true };
  }
  if (reviewType === "literature_comparison") {
    return { ...state, literature: true };
  }
  return state;
}

export function buildReviewEditorModalLayoutModel() {
  return {
    basicFields: [
      "title",
      "reviewType",
      "periodLabel",
      "periodStart",
      "periodEnd",
      "projectId"
    ],
    targetSections: [...REVIEW_EDITOR_TARGET_SECTION_KEYS],
    outlineColumns: 2,
    footerActions: ["cancel", "save"]
  } as const;
}

export type ReviewEditorModalSession<Form> = {
  isOpen: boolean;
  mode: ReviewEditorModalMode | null;
  editingReviewId: string | null;
  form: Form;
  saveError: string;
};

export type ReviewEditorModalTransition<Form> = {
  selectedReviewId: string | null;
  editor: ReviewEditorModalSession<Form>;
};

export function openCreateReviewEditorModal<Form>(
  selectedReviewId: string | null,
  createForm: Form
): ReviewEditorModalTransition<Form> {
  return {
    selectedReviewId,
    editor: {
      isOpen: true,
      mode: "create",
      editingReviewId: null,
      form: createForm,
      saveError: ""
    }
  };
}

export function canOpenReviewEditModal(
  review: { id: string; deletedAt?: string | null } | null | undefined,
  isTargetLinksLoading: boolean
) {
  return Boolean(review && !review.deletedAt && !isTargetLinksLoading);
}

export function openEditReviewEditorModal<Form>(
  selectedReviewId: string | null,
  reviewId: string,
  editForm: Form
): ReviewEditorModalTransition<Form> {
  return {
    selectedReviewId,
    editor: {
      isOpen: true,
      mode: "edit",
      editingReviewId: reviewId,
      form: editForm,
      saveError: ""
    }
  };
}

export function closeReviewEditorModal<Form>(
  selectedReviewId: string | null,
  emptyForm: Form
): ReviewEditorModalTransition<Form> {
  return {
    selectedReviewId,
    editor: {
      isOpen: false,
      mode: null,
      editingReviewId: null,
      form: emptyForm,
      saveError: ""
    }
  };
}

export function completeReviewEditorModalSave<Form>(
  savedReviewId: string,
  emptyForm: Form
): ReviewEditorModalTransition<Form> {
  return closeReviewEditorModal(savedReviewId, emptyForm);
}

export function getReviewEditorModalTitle(
  mode: ReviewEditorModalMode | null,
  labels: { create: string; edit: string }
) {
  return mode === "edit" ? labels.edit : labels.create;
}
