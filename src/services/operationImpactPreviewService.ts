import type {
  CreateOperationImpactPreviewInput,
  OperationImpactItem,
  OperationImpactPreview
} from "../types/operationSafety";
import { createSkippedWriteFeedback } from "./writeFeedbackService";

function itemKey(item: OperationImpactItem) {
  return [item.entityType, item.entityId ?? "", item.title, item.severity].join(":");
}

function dedupeImpactItems(items: OperationImpactItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueText(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function createOperationImpactPreview(
  input: CreateOperationImpactPreviewInput
): OperationImpactPreview {
  const affectedItems = dedupeImpactItems(input.affectedItems ?? []);
  const blockingReasons = uniqueText(input.blockingReasons ?? []);
  return {
    ...input,
    canProceed: input.canProceed && blockingReasons.length === 0,
    affectedEntityCount: affectedItems.length,
    affectedItems,
    warnings: uniqueText(input.warnings ?? []),
    blockingReasons
  };
}

export function createOperationCancelledFeedback(
  preview: OperationImpactPreview,
  message = "The operation was cancelled by the user."
) {
  return createSkippedWriteFeedback({
    operation: preview.operationId,
    affectedEntities: preview.target.id
      ? [
          {
            type: preview.target.type,
            id: preview.target.id,
            relation: "skipped",
            label: preview.target.title
          }
        ]
      : [],
    skipped: [message],
    messages: [
      {
        severity: "info",
        code: "user_cancelled",
        message
      }
    ]
  });
}

export const operationImpactPreviewService = {
  createOperationImpactPreview,
  createOperationCancelledFeedback
};
