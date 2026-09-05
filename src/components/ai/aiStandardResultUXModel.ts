import type { AIStandardResult } from "../../types/aiStandardResult";

export type AIStandardResultTerminalReceiptProjection = {
  outcomeClass: "LEGACY_FULL_SUCCESS" | "FULL_SUCCESS" | "PROVEN_PARTIAL";
  lines: string[];
};

function manuscriptOutcomeLabel(channel: string, multiple: boolean) {
  if (channel === "literature_outline") return "literature_outline";
  if (channel === "dedicated_notes") return "dedicated_notes";
  return multiple ? channel : "文稿新迭代稿";
}

/** Minimal truthful terminal projection over the existing durable receipt. */
export function projectAIStandardResultTerminalReceipt(
  result: Pick<AIStandardResult, "effectReceipt">
): AIStandardResultTerminalReceiptProjection | undefined {
  const receipt = result.effectReceipt;
  if (!receipt) return undefined;
  const settlement = receipt.standardResultParentSettlement;
  if (!settlement) {
    return {
      outcomeClass: "LEGACY_FULL_SUCCESS",
      lines: ["写入已完成，并通过业务服务回读确认。"]
    };
  }
  const rawOutcomes = Array.isArray(settlement.manuscriptOutcomes)
    ? settlement.manuscriptOutcomes
    : settlement.manuscriptReceipts.map(({ channel, receipt: manuscriptReceipt }) => ({
        channel,
        outcome: "PROVEN_SUCCESS" as const,
        receipt: manuscriptReceipt
      }));
  const lines = [
    settlement.requestedBusinessEffect
      ? "数据库操作已完成"
      : "未请求数据库字段修改"
  ];
  const multiple = rawOutcomes.length > 1;
  for (const outcome of rawOutcomes) {
    const label = manuscriptOutcomeLabel(outcome.channel, multiple);
    if (outcome.outcome === "PROVEN_SUCCESS") lines.push(`${label}：已保存`);
    else if (outcome.outcome === "PROVEN_NO_EFFECT_FAILURE") lines.push(`${label}：保存失败`);
    else lines.push(`${label}：未执行`);
  }
  return {
    outcomeClass: settlement.outcomeClass === "PROVEN_PARTIAL"
      ? "PROVEN_PARTIAL"
      : "FULL_SUCCESS",
    lines
  };
}

export type AIStandardResultReviewMode =
  | "UNDECIDED"
  | "EDITING"
  | "EDITING_AFTER_CONFIRM"
  | "CONFIRMED_READY_TO_EXECUTE"
  | "EXECUTION_PENDING"
  | "ABANDONED"
  | "EXECUTED";

export type AIStandardResultCardAction = "confirm" | "edit" | "abandon" | "ignore";

export type AIStandardResultWorkspaceMutation = {
  resultId: string;
  token: number;
};

export function createAIStandardResultWorkspaceMutation(
  resultId: string,
  token: number
): AIStandardResultWorkspaceMutation {
  return { resultId, token };
}

export function releaseAIStandardResultWorkspaceMutation(
  current: AIStandardResultWorkspaceMutation | undefined,
  token: number
): AIStandardResultWorkspaceMutation | undefined {
  return current?.token === token ? undefined : current;
}

export function standardResultReviewGroup(
  result: Pick<
    AIStandardResult,
    "action" | "confirmationStartedAt" | "disposition" | "effectReceipt"
  >,
  mode: AIStandardResultReviewMode
): 1 | 2 | 3 | 4 | 5 | 6 {
  if (result.disposition === "DISMISSED" || mode === "ABANDONED") {
    return result.action === "DELETE_SUGGESTION" ? 5 : 6;
  }
  if (mode === "EDITING" || mode === "EDITING_AFTER_CONFIRM") return 2;
  if (
    mode === "CONFIRMED_READY_TO_EXECUTE" ||
    mode === "EXECUTION_PENDING" ||
    (result.disposition === "PENDING" && Boolean(result.confirmationStartedAt))
  ) {
    return 3;
  }
  if (
    mode === "EXECUTED" ||
    result.disposition === "CONFIRMED" ||
    Boolean(result.effectReceipt)
  ) {
    return 4;
  }
  return result.disposition === "PENDING" ? 1 : 6;
}

export function currentStandardResultCardAction(
  result: Pick<AIStandardResult, "action">,
  mode: AIStandardResultReviewMode
): AIStandardResultCardAction | undefined {
  if (mode === "ABANDONED") return result.action === "DELETE_SUGGESTION" ? "ignore" : "abandon";
  if (mode === "EDITING" || mode === "EDITING_AFTER_CONFIRM") return "edit";
  if (mode === "CONFIRMED_READY_TO_EXECUTE" || mode === "EXECUTED") {
    return "confirm";
  }
  return undefined;
}

export function orderAIStandardResultsForReview(
  results: readonly AIStandardResult[],
  modeByResultId: Readonly<Record<string, AIStandardResultReviewMode | undefined>>
): AIStandardResult[] {
  return [...results].sort((left, right) => compareAIStandardResultsForReview(
    left,
    right,
    modeByResultId
  ));
}

function compareAIStandardResultsForReview(
  left: AIStandardResult,
  right: AIStandardResult,
  modeByResultId: Readonly<Record<string, AIStandardResultReviewMode | undefined>>
): number {
    const leftMode = modeByResultId[left.id] ?? "UNDECIDED";
    const rightMode = modeByResultId[right.id] ?? "UNDECIDED";
    const leftGroup = standardResultReviewGroup(left, leftMode);
    const rightGroup = standardResultReviewGroup(right, rightMode);
    const groupDifference = leftGroup - rightGroup;
    if (groupDifference !== 0) return groupDifference;
    if (left.batchId === right.batchId && left.ordinal !== right.ordinal) {
      return left.ordinal - right.ordinal;
    }
    // Batch recency is authoritative only inside the unhandled tier. For all
    // other tiers createdAt is merely the deterministic stable fallback.
    const createdDifference = right.createdAt.localeCompare(left.createdAt);
    if (createdDifference !== 0) return createdDifference;
    return left.id.localeCompare(right.id);
}

/**
 * Freezes the relative order established for existing cards. A terminal Parse
 * readback contributes its whole new batch at once; those new cards are
 * stably inserted by the same six-tier comparator without re-sorting cards
 * already present in the open workspace.
 */
export function reconcileAIStandardResultEntryOrder(
  entryOrderIds: readonly string[],
  results: readonly AIStandardResult[],
  modeByResultId: Readonly<Record<string, AIStandardResultReviewMode | undefined>>
): string[] {
  const resultIds = new Set(results.map((result) => result.id));
  const retainedIds = entryOrderIds.filter((resultId) => resultIds.has(resultId));
  const retainedIdSet = new Set(retainedIds);
  const newResults = orderAIStandardResultsForReview(
    results.filter((result) => !retainedIdSet.has(result.id)),
    modeByResultId
  );
  const resultById = new Map(results.map((result) => [result.id, result]));
  const reconciledIds = [...retainedIds];
  for (const result of newResults) {
    const insertionIndex = reconciledIds.findIndex((existingId) => {
      const existing = resultById.get(existingId);
      return existing
        ? compareAIStandardResultsForReview(result, existing, modeByResultId) < 0
        : false;
    });
    if (insertionIndex < 0) reconciledIds.push(result.id);
    else reconciledIds.splice(insertionIndex, 0, result.id);
  }
  return reconciledIds;
}
