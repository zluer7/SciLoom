import { useEffect, useMemo, useRef, useState } from "react";
import type { AIContextPackage, AIPromptPackage } from "../../types/aiContext";
import type {
  AIParseDraftSourceSnapshot,
  AIStandardResult,
  AIStandardResultManuscriptEffect
} from "../../types/aiStandardResult";
import {
  friendlyAIStandardOperationError,
  friendlyAIStandardOperationValidationMessage,
  interpretAIStandardOperationDraft,
  projectAIStandardOperationDraft
} from "../../services/aiStandardOperationDraftService";
import {
  attachAIStandardResultManuscriptEffects,
  readAIStandardResultBlockingValidationIssues,
  readAIStandardResultManuscriptEffects,
  readAIStandardResultProposalMetadata,
  stripAIStandardResultManuscriptEffects
} from "../../services/aiStandardResultService";
import {
  currentStandardResultCardAction,
  orderAIStandardResultsForReview,
  projectAIStandardResultTerminalReceipt,
  reconcileAIStandardResultEntryOrder,
  type AIStandardResultReviewMode
} from "./aiStandardResultUXModel";

export type AIParseDraftScopeReview = {
  contextPackage: AIContextPackage;
  promptPackage: AIPromptPackage;
  source: AIParseDraftSourceSnapshot;
};

export type AIParseDraftTerminal =
  | { kind: "succeeded"; callAttemptId: string; resultCount: number }
  | { kind: "empty"; callAttemptId: string; message: string }
  | { kind: "no-new-content"; message: string }
  | { kind: "failed"; callAttemptId?: string; message: string };

type AIStandardResultCardCallbacks = {
  onSave: (
    result: AIStandardResult,
    payload: Record<string, unknown>,
    fallbackSections: readonly string[]
  ) => Promise<AIStandardResult>;
  onConfirm: (result: AIStandardResult) => Promise<void>;
  onContinue: (result: AIStandardResult) => Promise<void>;
  onDismiss: (result: AIStandardResult) => Promise<void>;
};

type CardReviewMode = AIStandardResultReviewMode;

type CardReviewState = {
  resultId: string;
  persistedPayloadFingerprint: string;
  editorBuffer: string;
  lastSavedDraft: string;
  mode: CardReviewMode;
  everConfirmed: boolean;
  confirmedSnapshot?: string;
  confirmedResultSnapshot?: AIStandardResult;
  confirmedFingerprint?: string;
  localError?: string;
  localNotice?: string;
  isWorking: boolean;
};

function actionLabel(result: AIStandardResult): string {
  if (result.action === "CREATE") return "新建";
  if (result.action === "UPDATE") return "修改";
  if (result.action === "DELETE_SUGGESTION") return "删除";
  return "操作";
}

function targetLabel(result: AIStandardResult): string {
  const labels: Record<string, string> = {
    route: "路线",
    task: "任务",
    review: "复盘",
    experiment: "实验",
    experimentRun: "实验运行",
    literature: "文献",
    finding: "关键发现",
    resultItem: "结果资产",
    outputCandidate: "候选成果",
    outputGap: "成果缺口",
    researchOutput: "正式成果"
  };
  return labels[result.target.module] ?? "研究对象";
}

function payloadIdentity(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function completedEffect(result: AIStandardResult): boolean {
  return result.disposition === "CONFIRMED" && Boolean(result.effectReceipt);
}

function readManuscriptEffects(result: AIStandardResult): AIStandardResultManuscriptEffect[] {
  if (result.action === "NEW_MANUSCRIPT") return [];
  return readAIStandardResultManuscriptEffects(result.visiblePayload, {
    action: result.action,
    target: result.target
  });
}

function businessResultView(result: AIStandardResult): AIStandardResult {
  return {
    ...result,
    visiblePayload: stripAIStandardResultManuscriptEffects(result.visiblePayload)
  };
}

function initialState(result: AIStandardResult): CardReviewState {
  const projection = projectAIStandardOperationDraft(businessResultView(result));
  const executed = completedEffect(result);
  const partial = !executed && result.disposition === "PENDING" && Boolean(result.confirmationStartedAt);
  const abandoned = result.disposition === "DISMISSED";
  return {
    resultId: result.id,
    persistedPayloadFingerprint: result.visiblePayloadFingerprint,
    editorBuffer: projection.text,
    lastSavedDraft: projection.text,
    mode: executed ? "EXECUTED" : partial ? "EXECUTION_PENDING" : abandoned ? "ABANDONED" : "UNDECIDED",
    everConfirmed: executed || partial,
    ...(partial ? {
      localNotice: "正式父动作已开始；继续操作只会读回或完成尚未结算的既有效果。"
    } : {}),
    isWorking: false
  };
}

function reconcileState(
  result: AIStandardResult,
  current: CardReviewState
): CardReviewState {
  const executed = completedEffect(result);
  const partial = !executed && result.disposition === "PENDING" && Boolean(result.confirmationStartedAt);
  if (executed) {
    return {
      ...current,
      mode: "EXECUTED",
      everConfirmed: true,
      confirmedSnapshot: undefined,
      confirmedResultSnapshot: undefined,
      confirmedFingerprint: undefined,
      isWorking: false,
      localError: undefined,
      localNotice: undefined
    };
  }
  if (partial) {
    return {
      ...current,
      mode: "EXECUTION_PENDING",
      everConfirmed: true,
      confirmedSnapshot: undefined,
      confirmedResultSnapshot: undefined,
      confirmedFingerprint: undefined,
      isWorking: false,
      localError: undefined,
      localNotice: "正式父动作已开始；继续操作只会读回或完成尚未结算的既有效果。"
    };
  }
  if (result.disposition === "DISMISSED") {
    return {
      ...current,
      mode: "ABANDONED",
      isWorking: false,
      localError: undefined,
      localNotice: undefined
    };
  }
  if (result.disposition !== "PENDING") return { ...current, isWorking: false };
  if (current.persistedPayloadFingerprint === result.visiblePayloadFingerprint) return current;
  const projection = projectAIStandardOperationDraft(businessResultView(result));
  return {
    ...current,
    persistedPayloadFingerprint: result.visiblePayloadFingerprint,
    editorBuffer: projection.text,
    lastSavedDraft: projection.text,
    mode: current.everConfirmed
      ? "EDITING_AFTER_CONFIRM"
      : current.mode === "EDITING" ? "EDITING" : "UNDECIDED",
    confirmedSnapshot: undefined,
    confirmedResultSnapshot: undefined,
    confirmedFingerprint: undefined,
    localError: undefined,
    localNotice: undefined,
    isWorking: false
  };
}

function uniqueFriendlyIssues(result: AIStandardResult): string[] {
  return [...new Set(result.validationIssues.map(friendlyAIStandardOperationValidationMessage))];
}

function resultWithFingerprint(result: AIStandardResult, fingerprint: string): AIStandardResult {
  return result.visiblePayloadFingerprint === fingerprint
    ? result
    : { ...result, visiblePayloadFingerprint: fingerprint };
}

function userVisibleTargetName(
  result: AIStandardResult,
  objectNameByKey: Readonly<Record<string, string | undefined>>
): string {
  const payloadTitle = typeof result.visiblePayload.title === "string"
    ? result.visiblePayload.title.trim()
    : "";
  if (payloadTitle) return payloadTitle;
  return result.target.entityId
    ? objectNameByKey[`${result.target.entityType}:${result.target.entityId}`]?.trim() || ""
    : "";
}

function executionResultText(result: AIStandardResult, state: CardReviewState): string {
  const terminalReceipt = projectAIStandardResultTerminalReceipt(result);
  if (terminalReceipt) return terminalReceipt.lines.join("；");
  if (result.disposition === "DISMISSED" || state.mode === "ABANDONED") return "已放弃";
  if (result.disposition === "STALE") return "已失效";
  if (result.disposition === "FAILED") return result.failureMessage?.trim() || "执行失败";
  if (state.isWorking) return state.mode === "EXECUTION_PENDING" ? "正在读取执行结果…" : "处理中…";
  if (state.mode === "EXECUTION_PENDING" || result.confirmationStartedAt) return "执行已开始，待继续";
  if (state.mode === "CONFIRMED_READY_TO_EXECUTE") return "已确认，待执行";
  if (state.mode === "EDITING" || state.mode === "EDITING_AFTER_CONFIRM") return "编辑中，待确认";
  return "待确认";
}

function siblingParentName(result: AIStandardResult, results: readonly AIStandardResult[]): string {
  if (result.action !== "CREATE" || result.target.module !== "experimentRun") return "";
  if (result.target.parentExperimentLabel?.trim()) return result.target.parentExperimentLabel.trim();
  const metadata = readAIStandardResultProposalMetadata(result.originalPayload);
  if (!metadata?.parentProposalRef) return "";
  const sibling = results.find((candidate) =>
    candidate.batchId === result.batchId && candidate.ordinal < result.ordinal &&
    readAIStandardResultProposalMetadata(candidate.originalPayload)?.proposalRef === metadata.parentProposalRef);
  return typeof sibling?.visiblePayload.title === "string" ? sibling.visiblePayload.title.trim() : "";
}

export function AIParseDraftPanel({
  terminal,
  results,
  disabled,
  activeMutationResultId,
  projectNameById,
  objectNameByKey,
  scopeGateNotice,
  isPreparing,
  isRunning,
  onRetry,
  onSaveResult,
  onConfirmResult,
  onContinueResult,
  onDismissResult
}: {
  terminal?: AIParseDraftTerminal;
  results: AIStandardResult[];
  disabled: boolean;
  activeMutationResultId?: string;
  projectNameById: Readonly<Record<string, string | undefined>>;
  objectNameByKey: Readonly<Record<string, string | undefined>>;
  scopeGateNotice?: string;
  isPreparing: boolean;
  isRunning: boolean;
  onRetry: () => void;
  onSaveResult: AIStandardResultCardCallbacks["onSave"];
  onConfirmResult: AIStandardResultCardCallbacks["onConfirm"];
  onContinueResult: AIStandardResultCardCallbacks["onContinue"];
  onDismissResult: AIStandardResultCardCallbacks["onDismiss"];
}) {
  const logicalResults = useMemo(
    () => results.filter((result) => result.action !== "NEW_MANUSCRIPT"),
    [results]
  );
  const [entryOrderIds, setEntryOrderIds] = useState<string[]>(() => orderAIStandardResultsForReview(
    logicalResults,
    Object.fromEntries(logicalResults.map((result) => [
      result.id,
      initialState(result).mode
    ]))
  ).map((result) => result.id));
  const [selectedResultId, setSelectedResultId] = useState<string>();
  const [cardStates, setCardStates] = useState<Record<string, CardReviewState>>({});
  const activeCardActionResultIdRef = useRef<string>();

  useEffect(() => {
    setSelectedResultId((current) => (
      current && logicalResults.some((result) => result.id === current)
        ? current
        : entryOrderIds[0] ?? logicalResults[0]?.id
    ));
    setEntryOrderIds((current) => reconcileAIStandardResultEntryOrder(
      current,
      logicalResults,
      Object.fromEntries(logicalResults.map((result) => [
        result.id,
        initialState(result).mode
      ]))
    ));
    setCardStates((current) => {
      const next = { ...current };
      for (const result of logicalResults) {
        next[result.id] = next[result.id]
          ? reconcileState(result, next[result.id])
          : initialState(result);
      }
      return next;
    });
  }, [logicalResults]);

  const orderedResults = useMemo(() => {
    // A terminal Parse publishes the complete new batch in one results update.
    // Project that update through the existing entry-order reconciler during
    // the same render so new cards never appear appended for an intermediate
    // user-visible frame before the effect persists the identical order.
    const projectedEntryOrderIds = reconcileAIStandardResultEntryOrder(
      entryOrderIds,
      logicalResults,
      Object.fromEntries(logicalResults.map((result) => [
        result.id,
        cardStates[result.id]?.mode ?? initialState(result).mode
      ]))
    );
    const resultById = new Map(logicalResults.map((result) => [result.id, result]));
    const ordered = projectedEntryOrderIds
      .map((resultId) => resultById.get(resultId))
      .filter((result): result is AIStandardResult => Boolean(result));
    const orderedIds = new Set(ordered.map((result) => result.id));
    return [...ordered, ...logicalResults.filter((result) => !orderedIds.has(result.id))];
  }, [cardStates, entryOrderIds, logicalResults]);

  const selectedResult = logicalResults.find((result) => result.id === selectedResultId);
  const selectedState = selectedResult
    ? cardStates[selectedResult.id] ?? initialState(selectedResult)
    : undefined;
  const selectedProjectName = selectedResult
    ? projectNameById[selectedResult.target.projectId]?.trim() || "未能确认课题名称"
    : "";
  const selectedObjectName = selectedResult
    ? userVisibleTargetName(selectedResult, objectNameByKey) || "未能确认对象名称"
    : "";
  const selectedParentName = selectedResult ? siblingParentName(selectedResult, results) : "";
  const selectedProjection = useMemo(
    () => selectedResult ? projectAIStandardOperationDraft(businessResultView(selectedResult), {
      projectName: selectedProjectName,
      targetName: selectedObjectName,
      parentName: selectedParentName
    }) : undefined,
    [selectedObjectName, selectedParentName, selectedProjectName, selectedResult]
  );
  const selectedExecutionResult = selectedResult && selectedState
    ? executionResultText(selectedResult, selectedState)
    : "";
  const busy = isPreparing || isRunning;
  const interactionDisabled = disabled || Boolean(activeMutationResultId);
  const terminalFailure = !busy && (terminal?.kind === "failed" || terminal?.kind === "empty");

  function changeCardState(
    resultId: string,
    update: (current: CardReviewState) => CardReviewState
  ) {
    setCardStates((current) => {
      const result = logicalResults.find((candidate) => candidate.id === resultId);
      if (!result) return current;
      const existing = current[resultId] ?? initialState(result);
      return { ...current, [resultId]: update(existing) };
    });
  }

  async function runCardAction(result: AIStandardResult, action: () => Promise<void>) {
    const state = cardStates[result.id] ?? initialState(result);
    if (state.isWorking || activeCardActionResultIdRef.current) return;
    activeCardActionResultIdRef.current = result.id;
    changeCardState(result.id, (current) => ({
      ...current,
      isWorking: true,
      localError: undefined,
      localNotice: undefined
    }));
    try {
      await action();
    } catch (error) {
      changeCardState(result.id, (current) => ({
        ...current,
        localError: friendlyAIStandardOperationError(error),
        localNotice: undefined
      }));
    } finally {
      if (activeCardActionResultIdRef.current === result.id) {
        activeCardActionResultIdRef.current = undefined;
      }
      changeCardState(result.id, (current) => ({ ...current, isWorking: false }));
    }
  }

  function beginEdit(result: AIStandardResult) {
    setSelectedResultId(result.id);
    changeCardState(result.id, (current) => {
      if (
        current.mode === "ABANDONED" || current.mode === "EXECUTED" ||
        current.mode === "EXECUTION_PENDING"
      ) return current;
      return {
        ...current,
        editorBuffer: current.lastSavedDraft,
        mode: current.everConfirmed ? "EDITING_AFTER_CONFIRM" : "EDITING",
        confirmedSnapshot: undefined,
        confirmedResultSnapshot: undefined,
        confirmedFingerprint: undefined,
        localError: undefined,
        localNotice: undefined
      };
    });
  }

  async function saveReviewedPayload(
    result: AIStandardResult,
    state: CardReviewState,
    showSavedNotice: boolean
  ): Promise<{ result: AIStandardResult; saved: boolean }> {
    // The subordinate effect snapshot remains body-custodied by Parse/backend.
    // Review can update only the structured business payload.
    const reviewedEffects = readManuscriptEffects(result).map((effect) => structuredClone(effect));
    const interpreted = interpretAIStandardOperationDraft(
      businessResultView(result),
      state.editorBuffer,
      { allowEmptyUpdate: result.action === "UPDATE" && reviewedEffects.length > 0 }
    );
    const reviewedPayload = attachAIStandardResultManuscriptEffects(
      interpreted.payload,
      reviewedEffects
    );
    let updated = resultWithFingerprint(result, state.persistedPayloadFingerprint);
    let saved = false;
    if (
      payloadIdentity(reviewedPayload) !== payloadIdentity(result.visiblePayload) ||
      interpreted.unknownSafeSections.length > 0 ||
      readAIStandardResultBlockingValidationIssues(result.validationIssues).length > 0 ||
      state.persistedPayloadFingerprint !== result.visiblePayloadFingerprint
    ) {
      updated = await onSaveResult(
        updated,
        reviewedPayload,
        interpreted.unknownSafeSections
      );
      saved = true;
    }
    if (readAIStandardResultBlockingValidationIssues(updated.validationIssues).length > 0) {
      throw new Error(uniqueFriendlyIssues(updated).join(" "));
    }
    const persistedDraft = projectAIStandardOperationDraft(businessResultView(updated)).text;
    changeCardState(result.id, (current) => ({
      ...current,
      persistedPayloadFingerprint: updated.visiblePayloadFingerprint,
      editorBuffer: persistedDraft,
      lastSavedDraft: persistedDraft,
      localError: undefined,
      localNotice: showSavedNotice ? "修改已保存" : undefined
    }));
    return { result: updated, saved };
  }

  function saveEditor(result: AIStandardResult) {
    const state = cardStates[result.id] ?? initialState(result);
    void runCardAction(result, () => saveReviewedPayload(result, state, true).then(() => undefined));
  }

  function abandon(result: AIStandardResult) {
    setSelectedResultId(result.id);
    const state = cardStates[result.id] ?? initialState(result);
    if (
      result.confirmationStartedAt || state.mode === "EXECUTION_PENDING" ||
      state.everConfirmed || state.mode === "ABANDONED" || state.mode === "EXECUTED"
    ) return;
    void runCardAction(result, async () => {
      await onDismissResult(resultWithFingerprint(result, state.persistedPayloadFingerprint));
      changeCardState(result.id, (current) => ({ ...current, mode: "ABANDONED" }));
    });
  }

  function ignoreDeleteSuggestion(result: AIStandardResult) {
    setSelectedResultId(result.id);
    const state = cardStates[result.id] ?? initialState(result);
    if (state.mode === "ABANDONED") return;
    void runCardAction(result, async () => {
      await onDismissResult(resultWithFingerprint(result, state.persistedPayloadFingerprint));
      changeCardState(result.id, (current) => ({ ...current, mode: "ABANDONED" }));
    });
  }

  function cardConfirm(result: AIStandardResult) {
    setSelectedResultId(result.id);
    const state = cardStates[result.id] ?? initialState(result);
    if (
      result.disposition !== "PENDING" || result.confirmationStartedAt ||
      state.mode === "ABANDONED" || state.mode === "EXECUTED" ||
      state.mode === "EXECUTION_PENDING" || state.mode === "CONFIRMED_READY_TO_EXECUTE"
    ) return;
    // Stage 1 persists and freezes the latest reviewed business payload only.
    // It never invokes the formal application/authorization/dispatch callback.
    void runCardAction(result, async () => {
      const reviewed = await saveReviewedPayload(result, state, false);
      const reviewedSnapshot = structuredClone(reviewed.result);
      const persistedDraft = projectAIStandardOperationDraft(businessResultView(reviewedSnapshot)).text;
      changeCardState(result.id, (current) => ({
        ...current,
        editorBuffer: persistedDraft,
        lastSavedDraft: persistedDraft,
        mode: "CONFIRMED_READY_TO_EXECUTE",
        everConfirmed: true,
        confirmedSnapshot: persistedDraft,
        confirmedResultSnapshot: structuredClone(reviewedSnapshot),
        confirmedFingerprint: reviewedSnapshot.visiblePayloadFingerprint,
        localError: undefined,
        localNotice: "当前业务建议已确认，可以执行。"
      }));
    });
  }

  function confirmExecute(result: AIStandardResult) {
    setSelectedResultId(result.id);
    const state = cardStates[result.id] ?? initialState(result);
    if (
      result.disposition !== "PENDING" || result.confirmationStartedAt ||
      state.mode !== "CONFIRMED_READY_TO_EXECUTE" ||
      !state.confirmedSnapshot || !state.confirmedResultSnapshot || !state.confirmedFingerprint ||
      state.confirmedSnapshot !== state.editorBuffer ||
      state.confirmedFingerprint !== state.persistedPayloadFingerprint ||
      state.confirmedResultSnapshot.visiblePayloadFingerprint !== state.confirmedFingerprint
    ) return;
    const exactConfirmedSnapshot = structuredClone(state.confirmedResultSnapshot);
    void runCardAction(result, () => onConfirmResult(resultWithFingerprint(
      exactConfirmedSnapshot,
      state.confirmedFingerprint!
    )));
  }

  return (
    <section className="global-ai-chat-panel__parse-draft" aria-label="AI操作建议">
      {scopeGateNotice ? (
        <p className="global-ai-chat-panel__parse-gate-notice" role="status">{scopeGateNotice}</p>
      ) : null}
      {!busy && terminal?.kind === "no-new-content" ? (
        <p className="global-ai-chat-panel__parse-gate-notice" data-parse-terminal="no-new-content" role="status">
          {terminal.message}
        </p>
      ) : null}
      {terminalFailure ? (
        <section
          className="global-ai-chat-panel__parse-terminal"
          data-parse-terminal={terminal?.kind}
          role={terminal?.kind === "failed" ? "alert" : "status"}
        >
          <strong>{terminal?.kind === "failed" ? "解析未完成" : "本次未产生有效建议"}</strong>
          <p>{terminal?.message}</p>
          <button disabled={interactionDisabled} onClick={onRetry} type="button">重试解析</button>
        </section>
      ) : null}
      {!busy && !terminalFailure && logicalResults.length === 0 ? (
        <p className="global-ai-chat-panel__parse-gate-notice" data-parse-terminal="idle">
          当前还没有操作建议。在聊天中形成草稿后，点击“解析草稿”即可开始解析。
        </p>
      ) : null}
      {logicalResults.length > 0 ? (
        <div className="global-ai-chat-panel__standard-result-workspace">
          <aside className="global-ai-chat-panel__standard-result-list" aria-label="操作建议列表">
            <h4 className="global-ai-chat-panel__standard-result-column-title">操作建议列表</h4>
            <div className="global-ai-chat-panel__standard-result-list-items">
              {orderedResults.map((result) => {
                const state = cardStates[result.id] ?? initialState(result);
                const pending = result.disposition === "PENDING" && !result.confirmationStartedAt;
                const deleteSuggestion = result.action === "DELETE_SUGGESTION";
                const cardDisabled = interactionDisabled || state.isWorking || !pending;
                const currentAction = currentStandardResultCardAction(result, state.mode);
                return (
                  <article
                    aria-current={result.id === selectedResultId ? "true" : undefined}
                    className="global-ai-chat-panel__standard-result-list-card"
                    data-active-action={currentAction}
                    data-review-state={state.mode}
                    data-standard-result-id={result.id}
                    data-manuscript-effect-count={readManuscriptEffects(result).length || undefined}
                    key={result.id}
                  >
                    <button
                      className="global-ai-chat-panel__standard-result-card-select"
                      onClick={() => setSelectedResultId(result.id)}
                      type="button"
                    >
                      <span className="global-ai-chat-panel__standard-result-action-badge">[{actionLabel(result)}]</span>
                      <strong className="global-ai-chat-panel__standard-result-type-badge">{targetLabel(result)}</strong>
                      <small className="global-ai-chat-panel__standard-result-object-name">
                        {userVisibleTargetName(result, objectNameByKey) || "名称待确认"}
                      </small>
                    </button>
                    {deleteSuggestion ? (
                      <div className="global-ai-chat-panel__standard-result-card-delete-row">
                        <button
                          aria-pressed={currentAction === "ignore"}
                          className={currentAction === "ignore" ? "is-current-action" : undefined}
                          disabled={cardDisabled || state.mode === "ABANDONED"}
                          onClick={() => ignoreDeleteSuggestion(result)}
                          type="button"
                        >忽略</button>
                        <small>请到该条目下执行操作</small>
                      </div>
                    ) : (
                      <div className="global-ai-chat-panel__standard-result-card-actions">
                        <button
                          aria-pressed={currentAction === "confirm"}
                          className={currentAction === "confirm" ? "is-current-action" : undefined}
                          disabled={
                            cardDisabled || state.mode === "CONFIRMED_READY_TO_EXECUTE" ||
                            state.mode === "EXECUTION_PENDING" || state.mode === "ABANDONED" ||
                            state.mode === "EXECUTED"
                          }
                          onClick={() => cardConfirm(result)}
                          type="button"
                        >确认</button>
                        <button
                          aria-pressed={currentAction === "edit"}
                          className={currentAction === "edit" ? "is-current-action" : undefined}
                          disabled={cardDisabled || state.mode === "ABANDONED" || state.mode === "EXECUTED"}
                          onClick={() => beginEdit(result)}
                          type="button"
                        >编辑</button>
                        <button
                          aria-pressed={currentAction === "abandon"}
                          className={currentAction === "abandon" ? "is-current-action" : undefined}
                          disabled={
                            cardDisabled || Boolean(result.confirmationStartedAt) || state.everConfirmed ||
                            state.mode === "ABANDONED" || state.mode === "EXECUTED"
                          }
                          onClick={() => abandon(result)}
                          type="button"
                        >放弃</button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </aside>
          <section className="global-ai-chat-panel__standard-result-detail" aria-label="详情">
            <h4 className="global-ai-chat-panel__standard-result-column-title">详情</h4>
            <div className="global-ai-chat-panel__standard-result-detail-content">
              {selectedResult && selectedState && selectedProjection ? (
                <article
                  className="global-ai-chat-panel__standard-result"
                  data-result-action={selectedResult.action}
                  data-result-disposition={selectedResult.disposition}
                  data-review-state={selectedState.mode}
                  data-standard-result-id={selectedResult.id}
                  data-reviewed-payload-fingerprint={selectedResult.visiblePayloadFingerprint}
                  data-confirmed-payload-fingerprint={selectedResult.confirmedPayloadFingerprint}
                >
                  <dl className="global-ai-chat-panel__standard-result-identity">
                    <div>
                      <dt>课题</dt>
                      <dd>{selectedProjectName}</dd>
                    </div>
                    <div>
                      <dt>对象</dt>
                      <dd>{selectedObjectName}</dd>
                    </div>
                    {selectedParentName ? (
                      <div>
                        <dt>所属实验</dt>
                        <dd>{selectedParentName}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <label className="global-ai-chat-panel__standard-result-natural-editor">
                    <textarea
                      aria-label={`${targetLabel(selectedResult)}结构化业务详情`}
                      disabled={interactionDisabled || selectedState.isWorking || selectedState.mode === "ABANDONED" || selectedState.mode === "EXECUTED"}
                      onChange={(event) => changeCardState(selectedResult.id, (current) => ({
                        ...current,
                        editorBuffer: event.target.value,
                        mode: current.everConfirmed ? "EDITING_AFTER_CONFIRM" : "EDITING",
                        confirmedSnapshot: undefined,
                        confirmedResultSnapshot: undefined,
                        confirmedFingerprint: undefined,
                        localError: undefined,
                        localNotice: undefined
                      }))}
                      readOnly={selectedState.mode !== "EDITING" && selectedState.mode !== "EDITING_AFTER_CONFIRM"}
                      spellCheck
                      value={selectedState.editorBuffer}
                    />
                  </label>
                  <section
                    aria-label="执行结果信息"
                    className="global-ai-chat-panel__standard-result-information"
                    data-result-information="true"
                  >
                    <div
                      aria-label="执行结果"
                      className="global-ai-chat-panel__standard-result-execution"
                      data-result-state-source={selectedResult.effectReceipt ? "effect-receipt" : "review-state"}
                      data-terminal-truth-result-id={selectedResult.effectReceipt ? selectedResult.id : undefined}
                    >
                      <span>执行结果</span>
                      <strong title={selectedExecutionResult}>{selectedExecutionResult}</strong>
                    </div>
                    {selectedResult.validationIssues.length > 0 && !completedEffect(selectedResult) && selectedState.mode !== "CONFIRMED_READY_TO_EXECUTE" ? (
                      <ul className="global-ai-chat-panel__standard-result-issues">
                        {uniqueFriendlyIssues(selectedResult).map((message) => <li key={message}>{message}</li>)}
                      </ul>
                    ) : null}
                    {selectedState.localNotice?.trim() && selectedState.localNotice.trim() !== selectedExecutionResult.trim() ? (
                      <p
                        className="global-ai-chat-panel__standard-result-notice"
                        data-result-message-kind="notice"
                        role="status"
                      >{selectedState.localNotice}</p>
                    ) : null}
                    {selectedState.localError?.trim() && selectedState.localError.trim() !== selectedExecutionResult.trim() ? (
                      <p
                        className="global-ai-chat-panel__standard-result-error"
                        data-result-message-kind="error"
                        role="alert"
                      >{selectedState.localError}</p>
                    ) : null}
                  </section>
                  {selectedResult.confirmationStartedAt && selectedResult.disposition === "PENDING" ? (
                    <button disabled={interactionDisabled || selectedState.isWorking} onClick={() => void runCardAction(selectedResult, () => onContinueResult(selectedResult))} type="button">
                      {selectedState.isWorking ? "读取中…" : "继续当前操作"}
                    </button>
                  ) : null}
                  {selectedResult.action !== "DELETE_SUGGESTION" ? (
                    <footer className="global-ai-chat-panel__standard-result-actions">
                      {selectedResult.disposition === "PENDING" && !selectedResult.confirmationStartedAt ? (
                        <button
                          className="is-primary"
                          disabled={
                            interactionDisabled || selectedState.isWorking ||
                            selectedState.mode !== "CONFIRMED_READY_TO_EXECUTE" ||
                            !selectedState.confirmedSnapshot || !selectedState.confirmedResultSnapshot ||
                            selectedState.confirmedSnapshot !== selectedState.editorBuffer ||
                            selectedState.confirmedFingerprint !== selectedState.persistedPayloadFingerprint ||
                            readAIStandardResultBlockingValidationIssues(selectedResult.validationIssues).length > 0
                          }
                          onClick={() => confirmExecute(selectedResult)}
                          type="button"
                        >{selectedState.isWorking ? "执行中…" : "确认执行"}</button>
                      ) : null}
                      <button
                        disabled={
                          interactionDisabled || selectedState.isWorking ||
                          (selectedState.mode !== "EDITING" && selectedState.mode !== "EDITING_AFTER_CONFIRM")
                        }
                        onClick={() => saveEditor(selectedResult)}
                        type="button"
                      >保存编辑</button>
                      <button
                        disabled={
                          interactionDisabled || selectedState.isWorking ||
                          (selectedState.mode !== "EDITING" && selectedState.mode !== "EDITING_AFTER_CONFIRM")
                        }
                        onClick={() => changeCardState(selectedResult.id, (current) => ({
                          ...current,
                          editorBuffer: current.lastSavedDraft,
                          localError: undefined,
                          localNotice: current.everConfirmed
                            ? "已恢复到上次保存内容，仍需重新确认后才能执行。"
                            : "已恢复到上次保存内容"
                        }))}
                        type="button"
                      >取消修改</button>
                    </footer>
                  ) : null}
                </article>
              ) : <p>从左侧选择一条建议查看详情。</p>}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
