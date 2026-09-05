import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailableManuscriptItem } from "../../types/manuscriptSwitch";
import type {
  ReviewManuscriptDocument,
  ReviewManuscriptWarning
} from "../../types/reviewManuscript";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../../types/sharedManuscriptSession";
import { manuscriptRequestTokenController } from "../../services/manuscriptRequestTokenController";
import {
  extractReviewManuscriptBlocks,
  replaceReviewManuscriptSections
} from "../../services/reviewManuscriptAdapterService";
import {
  reviewManuscriptSaveAsAdapter
} from "../../services/reviewManuscriptSaveAsAdapter";
import {
  createReviewManuscriptFormalSwitchService,
  type ReviewManuscriptFormalSwitchService
} from "../../services/reviewManuscriptFormalSwitchService";
import type { ReviewManuscriptPageState } from "../../services/reviewManuscriptPageStateService";
import { reviewRawManuscriptService } from "../../services/reviewRawManuscriptService";
import {
  independentManuscriptOpenProtocol,
  type IndependentOpenActivationResult,
  type IndependentOpenProductAdapter,
  type IndependentManuscriptOpenProtocol,
  resolveIndependentOpenConsumerCleanup
} from "../../services/independentManuscriptOpenProtocol";
import { createIndependentOpenPreviewProvider } from "../../services/independentManuscriptOpenPreviewProvider";
import { resolveReviewWorkspaceFolder } from "../../services/reviewManuscriptSelectionService";
import { fileRefService } from "../../services/fileRefService";
import { compareSaveAsRecoveryOrder } from "../../services/manuscriptSaveAsOperationPort";
import { windowPContainmentFeedbackMessage } from "../../services/manuscriptSaveAsWindowPContainment";
import { ensureReviewManuscriptProvisioning } from "../../services/reviewManuscriptProvisioningService";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";
import { ordinarySavePresentation } from "../../services/ordinaryOperationPresentation";
import { buildFormalSwitchConfirmationCopy, projectFormalSwitchFailure } from "../../services/manuscriptFormalSwitchPresentation";
import type { ManuscriptSegmentDraftSnapshot } from "../../types/manuscriptSegmentProjection";

type FeedbackSeverity = "success" | "warning" | "error" | "info";
type ChoiceValue = "save" | "discard" | "cancel" | "confirm";

export interface ReviewManuscriptChoiceDialog {
  kind?: "formal-switch";
  title: string;
  message: string;
  options: Array<{
    value: ChoiceValue;
    label: string;
    emphasis?: "primary" | "danger";
  }>;
}

function resultMessage(result: unknown, fallback: string) {
  if (!result || typeof result !== "object") return fallback;
  const record = result as {
    error?: { message?: unknown; code?: unknown };
    message?: unknown;
  };
  return typeof record.error?.message === "string"
    ? record.error.message
    : typeof record.message === "string"
      ? record.message
      : typeof record.error?.code === "string"
        ? record.error.code
        : fallback;
}

function documentView(
  session: SharedManuscriptSession,
  raw = session.draftRawText
): ReviewManuscriptDocument | null {
  if (session.file.kind !== "durable") return null;
  const extracted = extractReviewManuscriptBlocks(raw);
  if (extracted.status === "error") return null;
  const scope = session.windowRole === "current" ? "current" : "target";
  const warnings: ReviewManuscriptWarning[] =
    extracted.parsed.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: `文稿标准区块提示：${diagnostic.code}`
    }));
  return {
    ownerType: "review",
    reviewId: session.owner.ownerId,
    manuscriptChannel: "primary",
    fileRefId: session.file.fileRefId,
    filename: session.file.fileName,
    rawMarkdown: raw,
    metaSnapshot: extracted.metaSnapshot,
    outline: extracted.outline,
    body: extracted.body,
    parseStatus: extracted.parsed.status,
    diagnostics: extracted.parsed.diagnostics,
    warnings,
    updatedAt: session.updatedAt,
    request: {
      scope,
      requestToken: session.requestGeneration,
      refreshIdentity: `${session.key}:${session.sessionGeneration}`
    }
  };
}

let reviewOwnerEpochSequence = 0;

function nextReviewOwnerEpoch() {
  reviewOwnerEpochSequence += 1;
  return reviewOwnerEpochSequence;
}

function compareRecoveryOperations(
  left: { operationId: string; updatedAt?: string },
  right: { operationId: string; updatedAt?: string }
) {
  return compareSaveAsRecoveryOrder(
    { operationId: left.operationId, updatedAt: left.updatedAt ?? "" },
    { operationId: right.operationId, updatedAt: right.updatedAt ?? "" }
  );
}

export function useReviewManuscriptEditor(input: {
  reviewId?: string;
  reviewType?: import("../../types/planning").ReviewType;
  refreshSignal?: string;
  ui(source: string): string;
  onFeedback(
    severity: FeedbackSeverity,
    title: string,
    operation: string
  ): void;
  onRefreshDetail(): Promise<void>;
  independentOpenProtocol?: IndependentManuscriptOpenProtocol;
  independentOpenPreviewProvider?: ReturnType<
    typeof createIndependentOpenPreviewProvider
  >;
  saveAsService?: typeof reviewManuscriptSaveAsAdapter;
}) {
  const openProtocol =
    input.independentOpenProtocol ?? independentManuscriptOpenProtocol;
  const saveAsService =
    input.saveAsService ?? reviewManuscriptSaveAsAdapter;
  const [workflow, setWorkflow] =
    useState<ReviewManuscriptFormalSwitchService | null>(null);
  const [pageState, setPageState] =
    useState<ReviewManuscriptPageState | null>(null);
  const provisioningRetryRef = useRef(false);
  const [available, setAvailable] = useState<AvailableManuscriptItem[]>([]);
  const [currentHandle, setCurrentHandle] =
    useState<SharedManuscriptSessionHandle>();
  const [targetHandle, setTargetHandle] =
    useState<SharedManuscriptSessionHandle>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [currentPresentationRevision, setCurrentPresentationRevision] =
    useState(0);
  const [targetPresentationRevision, setTargetPresentationRevision] =
    useState(0);
  const [contextInsert, setContextInsert] = useState("");
  const [choiceDialog, setChoiceDialog] =
    useState<ReviewManuscriptChoiceDialog | null>(null);
  const choiceResolver =
    useRef<((value: ChoiceValue | null) => void) | null>(null);
  const currentHandleRef = useRef(currentHandle);
  const activeIndependentHandleRef =
    useRef<SharedManuscriptSessionHandle>();
  const ownerEpochRef = useRef(0);
  const openCurrentRequestGenerationRef = useRef(0);
  const replacementGenerationRef = useRef(0);
  const recoverySweepGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const currentReviewIdRef = useRef<string>();
  currentHandleRef.current = currentHandle;

  const currentSession = useMemo(
    () =>
      currentHandle
        ? reviewRawManuscriptService.getSession(currentHandle)
        : undefined,
    [currentHandle, sessionRevision]
  );
  const targetSession = useMemo(
    () =>
      targetHandle
        ? reviewRawManuscriptService.getSession(targetHandle)
        : undefined,
    [targetHandle, sessionRevision]
  );
  const document = useMemo(
    () => (currentSession ? documentView(currentSession) : null),
    [currentSession]
  );
  const targetDocument = useMemo(
    () => (targetSession ? documentView(targetSession) : null),
    [targetSession]
  );
  const isActive = (candidate: ReviewManuscriptFormalSwitchService) =>
    mountedRef.current &&
    currentReviewIdRef.current === candidate.ownerId &&
    candidate.manuscriptChannel === "primary";

  function isCurrentOwner(input: {
    reviewId: string;
    ownerEpoch: number;
    replacementGeneration?: number;
    recoverySweepGeneration?: number;
  }) {
    return (
      mountedRef.current &&
      currentReviewIdRef.current === input.reviewId &&
      ownerEpochRef.current === input.ownerEpoch &&
      (input.replacementGeneration === undefined ||
        replacementGenerationRef.current === input.replacementGeneration) &&
      (input.recoverySweepGeneration === undefined ||
        recoverySweepGenerationRef.current === input.recoverySweepGeneration)
    );
  }

  async function closeExactIndependentHandle(
    handle: SharedManuscriptSessionHandle,
    context: {
      reviewId: string;
      ownerEpoch: number;
      operation: string;
    }
  ) {
    if (!reviewRawManuscriptService.getSession(handle)) {
      return { status: "closed" as const };
    }
    let lastResult: Awaited<
      ReturnType<typeof reviewRawManuscriptService.close>
    > | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastResult = await reviewRawManuscriptService.close(handle, "discard");
      if (
        lastResult.status === "success" ||
        !reviewRawManuscriptService.getSession(handle)
      ) {
        return { status: "closed" as const, result: lastResult };
      }
    }
    input.onFeedback(
      "error",
      input.ui(
        `复盘文稿句柄清理未完成：${resultMessage(
          lastResult,
          "REVIEW_SAVE_AS_HANDLE_CLEANUP_UNRESOLVED"
        )}`
      ),
      "review.manuscript.lifecycle.cleanupBlocked"
    );
    return {
      status: "cleanup-unresolved" as const,
      handle,
      reviewId: context.reviewId,
      ownerEpoch: context.ownerEpoch,
      operation: context.operation,
      result: lastResult
    };
  }

  async function replaceActiveIndependentHandle(input: {
    nextHandle?: SharedManuscriptSessionHandle;
    clear?: boolean;
    expectedReviewId: string;
    expectedOwnerEpoch: number;
    expectedReplacementGeneration: number;
    expectedRecoverySweepGeneration?: number;
    operation: string;
  }) {
    const nextSession = input.nextHandle
      ? reviewRawManuscriptService.getSession(input.nextHandle)
      : undefined;
    const ownerCurrent = isCurrentOwner({
      reviewId: input.expectedReviewId,
      ownerEpoch: input.expectedOwnerEpoch,
      replacementGeneration: input.expectedReplacementGeneration,
      recoverySweepGeneration: input.expectedRecoverySweepGeneration
    });
    const nextValid =
      !input.nextHandle ||
      Boolean(
        nextSession &&
          nextSession.owner.ownerType === "review" &&
          nextSession.owner.ownerId === input.expectedReviewId &&
          nextSession.owner.channel === "primary" &&
          nextSession.windowRole === "independent"
      );
    if (!ownerCurrent || !nextValid) {
      const cleanup = input.nextHandle
        ? await closeExactIndependentHandle(input.nextHandle, {
            reviewId: input.expectedReviewId,
            ownerEpoch: input.expectedOwnerEpoch,
            operation: input.operation
          })
        : { status: "closed" as const };
      return {
        status: cleanup.status === "closed"
          ? "stale-cleaned"
          : "cleanup-unresolved",
        cleanup
      } as const;
    }
    if (!input.nextHandle && !input.clear) {
      return { status: "no-change" as const };
    }
    const displaced = activeIndependentHandleRef.current;
    if (input.nextHandle && displaced === input.nextHandle) {
      return { status: "retained" as const };
    }
    activeIndependentHandleRef.current = input.nextHandle;
    setTargetHandle(input.nextHandle);
    setTargetPresentationRevision((current) => current + 1);
    refreshSessions();
    if (!displaced) {
      return {
        status: input.nextHandle ? "installed" as const : "cleared" as const
      };
    }
    const cleanup = await closeExactIndependentHandle(displaced, {
      reviewId: input.expectedReviewId,
      ownerEpoch: input.expectedOwnerEpoch,
      operation: input.operation
    });
    return {
      status:
        cleanup.status === "closed"
          ? input.nextHandle
            ? "installed"
            : "cleared"
          : "cleanup-unresolved",
      cleanup
    } as const;
  }

  function refreshSessions() {
    setSessionRevision((current) => current + 1);
  }

  function requestChoice(
    dialog: ReviewManuscriptChoiceDialog
  ): Promise<ChoiceValue | null> {
    choiceResolver.current?.(null);
    setChoiceDialog(dialog);
    return new Promise((resolve) => {
      choiceResolver.current = resolve;
    });
  }

  function resolveChoice(value: ChoiceValue | null) {
    const resolve = choiceResolver.current;
    choiceResolver.current = null;
    setChoiceDialog(null);
    resolve?.(value);
  }

  async function refresh(activeWorkflow: ReviewManuscriptFormalSwitchService) {
    const [nextState, nextAvailable] = await Promise.all([
      activeWorkflow.getPageState(),
      activeWorkflow.getAvailable()
    ]);
    if (!isActive(activeWorkflow)) return;
    setPageState(nextState);
    setAvailable(nextAvailable);
  }

  useEffect(() => {
    openCurrentRequestGenerationRef.current += 1;
    resolveChoice(null);
    setWorkflow(null);
    setPageState(null);
    setAvailable([]);
    setCurrentHandle(undefined);
    setOpen(false);
    setBusy(false);
    setContextInsert("");
    if (!input.reviewId) {
      mountedRef.current = false;
      currentReviewIdRef.current = undefined;
      ownerEpochRef.current = nextReviewOwnerEpoch();
      replacementGenerationRef.current += 1;
      recoverySweepGenerationRef.current += 1;
      return undefined;
    }
    const reviewId = input.reviewId;
    const ownerEpoch = nextReviewOwnerEpoch();
    ownerEpochRef.current = ownerEpoch;
    currentReviewIdRef.current = reviewId;
    mountedRef.current = true;
    replacementGenerationRef.current += 1;
    recoverySweepGenerationRef.current += 1;
    const owner = { ownerType: "review", ownerId: reviewId, channel: "primary" } as const;
    const nextWorkflow = createReviewManuscriptFormalSwitchService(reviewId);
    setWorkflow(nextWorkflow);
    return () => {
      openCurrentRequestGenerationRef.current += 1;
      openProtocol.cancelOwner(owner);
      choiceResolver.current?.(null);
      choiceResolver.current = null;
      const current = currentHandleRef.current;
      const replacementGeneration =
        replacementGenerationRef.current + 1;
      replacementGenerationRef.current = replacementGeneration;
      recoverySweepGenerationRef.current += 1;
      void replaceActiveIndependentHandle({
        clear: true,
        expectedReviewId: reviewId,
        expectedOwnerEpoch: ownerEpoch,
        expectedReplacementGeneration: replacementGeneration,
        operation: "owner-transition"
      });
      if (current) void reviewRawManuscriptService.close(current, "discard");
      currentHandleRef.current = undefined;
      mountedRef.current = false;
      currentReviewIdRef.current = undefined;
      ownerEpochRef.current = nextReviewOwnerEpoch();
      replacementGenerationRef.current += 1;
      recoverySweepGenerationRef.current += 1;
      nextWorkflow.dispose();
    };
  }, [input.reviewId]);

  useEffect(() => {
    if (!workflow || !isActive(workflow)) return;
    void refresh(workflow).catch((error) => {
      if (isActive(workflow)) {
        input.onFeedback(
          "warning",
          error instanceof Error ? error.message : String(error),
          "review.manuscript.refresh"
        );
      }
    });
  }, [workflow, input.refreshSignal]);

  useEffect(() => {
    const reviewId = input.reviewId;
    if (
      !reviewId ||
      !mountedRef.current ||
      currentReviewIdRef.current !== reviewId
    ) {
      return undefined;
    }
    const ownerEpoch = ownerEpochRef.current;
    recoverySweepGenerationRef.current += 1;
    const recoverySweepGeneration =
      recoverySweepGenerationRef.current;
    replacementGenerationRef.current += 1;
    const replacementGeneration =
      replacementGenerationRef.current;
    void saveAsService.listUnresolved(reviewId).then(async (operations) => {
      let successfulRecoveryCount = 0;
      const orderedOperations = [...operations].sort(
        compareRecoveryOperations
      );
      for (const operation of orderedOperations) {
        if (
          !isCurrentOwner({
            reviewId,
            ownerEpoch,
            replacementGeneration,
            recoverySweepGeneration
          })
        ) {
          return;
        }
        const recovered = await saveAsService.recover(
          operation.operationId,
          reviewId
        );
        if (recovered.status === "success") {
          const replacement = await replaceActiveIndependentHandle({
            nextHandle: recovered.independentSessionKey,
            expectedReviewId: reviewId,
            expectedOwnerEpoch: ownerEpoch,
            expectedReplacementGeneration: replacementGeneration,
            expectedRecoverySweepGeneration: recoverySweepGeneration,
            operation: `recovery:${operation.operationId}`
          });
          if (
            replacement.status === "stale-cleaned" ||
            replacement.status === "cleanup-unresolved"
          ) {
            return;
          }
          successfulRecoveryCount += 1;
          continue;
        }
        if (
          !isCurrentOwner({
            reviewId,
            ownerEpoch,
            replacementGeneration,
            recoverySweepGeneration
          })
        ) {
          return;
        }
        if (recovered.status === "contained") {
          input.onFeedback(
            "warning",
            input.ui(
              windowPContainmentFeedbackMessage(recovered.blockingCode)
            ),
            "review.manuscript.saveAsRecovery"
          );
          continue;
        }
        input.onFeedback(
          "warning",
          input.ui(
            `另存为恢复未完成：${recovered.error.code}`
          ),
          "review.manuscript.saveAsRecovery"
        );
      }
      if (
        successfulRecoveryCount > 0 &&
        isCurrentOwner({
          reviewId,
          ownerEpoch,
          replacementGeneration,
          recoverySweepGeneration
        })
      ) {
        input.onFeedback(
          "success",
          input.ui("未完成的另存为操作已恢复，副本已在独立编辑器中打开。"),
          "review.manuscript.saveAsRecovery"
        );
      }
    }).catch((error) => {
      if (
        !isCurrentOwner({
          reviewId,
          ownerEpoch,
          replacementGeneration,
          recoverySweepGeneration
        })
      ) {
        return;
      }
      input.onFeedback(
        "warning",
        error instanceof Error ? error.message : String(error),
        "review.manuscript.saveAsRecovery"
      );
    });
    return () => {
      if (
        recoverySweepGenerationRef.current ===
        recoverySweepGeneration
      ) {
        recoverySweepGenerationRef.current += 1;
      }
      if (
        replacementGenerationRef.current === replacementGeneration
      ) {
        replacementGenerationRef.current += 1;
      }
    };
  }, [input.reviewId, saveAsService]);

  useEffect(() => {
    if (!choiceDialog) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") resolveChoice(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [choiceDialog]);

  function updateSessionSections(
    handle: SharedManuscriptSessionHandle | undefined,
    sections: {
      metaSnapshot?: string;
      outline?: string;
      body?: string;
    }
  ) {
    if (!handle) return false;
    const session = reviewRawManuscriptService.getSession(handle);
    if (!session) return false;
    const replaced = replaceReviewManuscriptSections({
      existingMarkdown: session.draftRawText,
      ...sections
    });
    if (replaced.status === "error") {
      input.onFeedback(
        "error",
        replaced.error.message,
        "review.manuscript.updateDraft"
      );
      return false;
    }
    const updated = reviewRawManuscriptService.updateDraft(
      handle,
      replaced.markdown
    );
    if (updated.status !== "success") return false;
    refreshSessions();
    return true;
  }

  async function openCurrent() {
    const activeWorkflow = workflow;
    const reviewId = input.reviewId;
    if (!activeWorkflow || !isActive(activeWorkflow) || !reviewId) {
      return false;
    }
    if (open && currentSession) return true;
    const ownerEpoch = ownerEpochRef.current;
    openCurrentRequestGenerationRef.current += 1;
    const requestGeneration = openCurrentRequestGenerationRef.current;
    const isCurrentRequest = () =>
      isCurrentOwner({ reviewId, ownerEpoch }) &&
      openCurrentRequestGenerationRef.current === requestGeneration;
    setBusy(true);
    try {
      const [result, insert] = await Promise.all([
        reviewRawManuscriptService.openCurrent(reviewId),
        activeWorkflow.getContextInsert()
      ]);
      if (!isCurrentRequest()) return false;
      if (result.status !== "success" || !("sessionKey" in result)) {
        const message = resultMessage(
          result,
          input.ui("复盘文稿无法打开。")
        );
        input.onFeedback(
          "error",
          message,
          "review.manuscript.openCurrent"
        );
        return false;
      }
      if (!documentView(result.session)) {
        await reviewRawManuscriptService.close(result.sessionKey, "discard");
        if (!isCurrentRequest()) return false;
        input.onFeedback(
          "error",
          input.ui("复盘文稿标准区块无效，无法安全编辑。"),
          "review.manuscript.openCurrent"
        );
        return false;
      }
      setCurrentHandle(result.sessionKey);
      setContextInsert(insert);
      setOpen(true);
      refreshSessions();
      if (!isCurrentRequest()) return false;
      input.onFeedback(
        "success",
        input.ui("复盘文稿已打开。"),
        "review.manuscript.openCurrent"
      );
      return true;
    } catch (error) {
      if (isCurrentRequest()) {
        input.onFeedback(
          "error",
          error instanceof Error ? error.message : String(error),
          "review.manuscript.openCurrent"
        );
      }
      return false;
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  }

  async function retryProvisioning() {
    const activeWorkflow = workflow;
    const reviewId = input.reviewId;
    if (
      !activeWorkflow ||
      !reviewId ||
      !isActive(activeWorkflow) ||
      provisioningRetryRef.current ||
      !pageState?.issue?.retryable
    ) {
      return false;
    }
    provisioningRetryRef.current = true;
    setBusy(true);
    try {
      const result = await ensureReviewManuscriptProvisioning(reviewId, {
        reviewRecordState: "reused"
      });
      if (!isActive(activeWorkflow)) return false;
      await refresh(activeWorkflow);
      await input.onRefreshDetail();
      if (result.completionState === "complete") {
        input.onFeedback(
          "success",
          input.ui("复盘文稿准备已恢复，可以打开编辑器。"),
          "review.provisioning.retry"
        );
        return true;
      }
      const issue = result.errors[0];
      input.onFeedback(
        result.retryable ? "warning" : "error",
        issue
          ? `${issue.code}: ${issue.message}`
          : input.ui("复盘文稿准备尚未完成。"),
        "review.provisioning.retry"
      );
      return false;
    } catch (error) {
      if (isActive(activeWorkflow)) {
        input.onFeedback(
          "error",
          error instanceof Error ? error.message : String(error),
          "review.provisioning.retry"
        );
      }
      return false;
    } finally {
      provisioningRetryRef.current = false;
      if (isActive(activeWorkflow)) setBusy(false);
    }
  }

  async function saveCurrent(markdown = document?.body ?? "") {
    if (!currentHandle) {
      throw new Error(input.ui("复盘文稿尚未加载。"));
    }
    updateSessionSections(currentHandle, { body: markdown });
    const result = await reviewRawManuscriptService.save(currentHandle);
    if (result.status === "success" || result.status === "no-op") {
      refreshSessions();
      if (workflow) await refresh(workflow);
    }
    return ordinarySavePresentation(
      result,
      { ownerType: "review", channel: "primary", ownerLabel: input.ui("复盘") }
    );
  }

  function updateTargetRawMarkdown(markdown: string) {
    if (!targetHandle) return false;
    const updated = reviewRawManuscriptService.updateDraft(
      targetHandle,
      markdown
    );
    if (updated.status !== "success") return false;
    refreshSessions();
    return true;
  }

  async function saveTarget(markdown = targetDocument?.rawMarkdown ?? "") {
    if (!targetHandle || !targetSession) {
      throw new Error(input.ui("目标文稿尚未加载。"));
    }
    if (!updateTargetRawMarkdown(markdown)) {
      throw new Error(input.ui("目标文稿更新失败。"));
    }
    let result = await reviewRawManuscriptService.save(targetHandle);
    if (
      result.status !== "success" &&
      result.status !== "no-op" &&
      resultMessage(result, "").includes(
        "REVIEW_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
      )
    ) {
      const confirmed = await requestChoice({
        title: input.ui("确认保存外部文稿"),
        message: input.ui(
          "该操作将更新原外部 Markdown 文件；不会改变当前稿。是否继续？"
        ),
        options: [
          {
            value: "confirm",
            label: input.ui("确认保存"),
            emphasis: "primary"
          },
          { value: "cancel", label: input.ui("取消") }
        ]
      });
      if (confirmed !== "confirm") {
        throw new Error(input.ui("已取消保存外部文稿。"));
      }
      result = await reviewRawManuscriptService.save(targetHandle, {
        confirmedExternalWrite: true
      });
    }
    if (result.status !== "success" && result.status !== "no-op") {
      throw new Error(
        resultMessage(result, input.ui("目标文稿保存失败。"))
      );
    }
    refreshSessions();
    if (workflow) await refresh(workflow);
    input.onFeedback(
      "success",
      input.ui("目标文稿已保存；当前稿未改变。"),
      "review.manuscript.saveTarget"
    );
    const next = reviewRawManuscriptService.getSession(targetHandle);
    return next ? documentView(next)?.rawMarkdown ?? markdown : markdown;
  }

  async function reloadTarget(markdown: string, lifecycleSettled = false) {
    if (!targetHandle) return false;
    if (!lifecycleSettled) {
      if (!updateTargetRawMarkdown(markdown)) return false;
      const requested = await sharedEditorLifecycleController.requestParticipant({
        participantId: `review-independent:${targetHandle}`,
        trigger: "reload",
        continuationIntent: "RELOAD",
        surface: "application",
        continuation: async () => {
          await reloadTarget(markdown, true);
        }
      });
      return requested.status === "continued";
    }
    const result = await reviewRawManuscriptService.reload(targetHandle);
    if (result.status !== "success") {
      input.onFeedback(
        "error",
        resultMessage(result, input.ui("目标文稿重新加载失败。")),
        "review.manuscript.targetReload"
      );
      return false;
    }
    setTargetPresentationRevision((current) => current + 1);
    refreshSessions();
    input.onFeedback(
      "success",
      input.ui("目标文稿已重新加载。"),
      "review.manuscript.targetReload"
    );
    return true;
  }

  function saveAsFailureMessage(result: {
    error?: {
      code?: string;
      selectionFailure?: "CAPABILITY_DENIED" | "DIALOG_FAILED" | "PATH_INVALID";
    };
  }) {
    const code = result.error?.code;
    if (result.error?.selectionFailure === "CAPABILITY_DENIED") {
      return input.ui("另存为对话框权限被拒绝，未产生持久化副作用。");
    }
    if (result.error?.selectionFailure === "DIALOG_FAILED") {
      return input.ui("无法打开另存为对话框，未产生持久化副作用。");
    }
    if (result.error?.selectionFailure === "PATH_INVALID") {
      return input.ui("所选另存为路径无效，未产生持久化副作用。");
    }
    if (
      code === "SAVE_AS_TARGET_ALREADY_EXISTS" ||
      code === "SAVE_AS_TARGET_CANDIDATE_INVALID" ||
      code === "SAVE_AS_SOURCE_TARGET_SAME_PATH" ||
      code === "SAVE_AS_SOURCE_TARGET_SAME_PHYSICAL"
    ) {
      return input.ui("所选目标已存在或与源文稿身份冲突；未覆盖任何文件。");
    }
    if (
      code === "SAVE_AS_SOURCE_SNAPSHOT_INVALID" ||
      code === "SAVE_AS_OPERATION_STALE"
    ) {
      return input.ui("复盘或源文稿状态已变化，当前另存为已安全阻断。");
    }
    return input.ui(
      `另存为未完成：${code ?? "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN"}`
    );
  }

  async function saveAs(
    sourceWindowRole: "current" | "independent",
    value: string | ManuscriptSegmentDraftSnapshot = ""
  ) {
    const reviewId = input.reviewId;
    const sourceHandle =
      sourceWindowRole === "current" ? currentHandle : targetHandle;
    if (!reviewId || !sourceHandle) return false;
    const sourceSession =
      reviewRawManuscriptService.getSession(sourceHandle);
    if (
      !sourceSession ||
      sourceSession.file.kind !== "durable" ||
      sourceSession.windowRole !== sourceWindowRole
    ) {
      return false;
    }
    const ownerEpoch = ownerEpochRef.current;
    replacementGenerationRef.current += 1;
    const replacementGeneration =
      replacementGenerationRef.current;
    if (
      !isCurrentOwner({
        reviewId,
        ownerEpoch,
        replacementGeneration
      })
    ) {
      return false;
    }
    setBusy(true);
    try {
      const committed = await saveAsService.saveAs({
        reviewId,
        sourceSessionKey: sourceHandle,
        sourceWindowRole,
        frozenDraftSnapshot: typeof value === "string" ? undefined : value,
        pickerTitle: input.ui("另存为")
      });
      if (committed.status === "success") {
        const replacement = await replaceActiveIndependentHandle({
          nextHandle: committed.independentSessionKey,
          expectedReviewId: reviewId,
          expectedOwnerEpoch: ownerEpoch,
          expectedReplacementGeneration: replacementGeneration,
          operation: `save-as:${committed.operationId}`
        });
        if (
          replacement.status === "stale-cleaned" ||
          replacement.status === "cleanup-unresolved"
        ) {
          return false;
        }
        input.onFeedback(
          "success",
          input.ui(
            `副本“${committed.targetFileName}”已创建并在独立编辑器中打开；原文稿未改变。`
          ),
          "review.manuscript.saveAs.success"
        );
        return true;
      }
      if (
        !isCurrentOwner({
          reviewId,
          ownerEpoch,
          replacementGeneration
        })
      ) {
        return false;
      }
      if (committed.status === "canceled") {
        input.onFeedback(
          "info",
          input.ui("已取消另存为，未产生持久化副作用。"),
          "review.manuscript.saveAs.canceled"
        );
        return false;
      }
      input.onFeedback(
        committed.status === "recovery-required" ||
          committed.status === "blocked"
          ? "warning"
          : "error",
        saveAsFailureMessage(committed),
        "review.manuscript.saveAs.commit"
      );
      return false;
    } finally {
      if (
        isCurrentOwner({
          reviewId,
          ownerEpoch,
          replacementGeneration
        })
      ) {
        setBusy(false);
      }
    }
  }

  async function reloadCurrent(lifecycleSettled = false) {
    if (!currentHandle) return;
    if (!lifecycleSettled) {
      await sharedEditorLifecycleController.requestParticipant({
        participantId: `review-current:${currentHandle}`,
        trigger: "reload",
        continuationIntent: "RELOAD",
        surface: "application",
        continuation: () => reloadCurrent(true)
      });
      return;
    }
    const result = await reviewRawManuscriptService.reload(currentHandle);
    if (result.status !== "success") {
      input.onFeedback(
        "error",
        resultMessage(result, input.ui("重新加载失败。")),
        "review.manuscript.reload"
      );
      return;
    }
    setCurrentPresentationRevision((current) => current + 1);
    refreshSessions();
    input.onFeedback(
      "success",
      input.ui("复盘文稿已重新加载。"),
      "review.manuscript.reload"
    );
  }

  async function selectSwitchTarget() {
    const activeWorkflow = workflow;
    if (!activeWorkflow || !isActive(activeWorkflow)) return null;
    const requestToken = manuscriptRequestTokenController.begin();
    const selected = await activeWorkflow.selectManuscript(
      requestToken,
      input.ui("切换 Markdown 文稿")
    );
    const selectedRequestToken =
      selected.status === "success"
        ? selected.selection.requestToken
        : selected.requestToken;
    if (
      !isActive(activeWorkflow) ||
      selectedRequestToken !== requestToken
    ) {
      return null;
    }
    if (selected.status === "canceled") return null;
    if (selected.status === "error") {
      input.onFeedback(
        "error",
        projectFormalSwitchFailure(selected, input.ui).summary,
        `review.manuscript.switch.${selected.code}`
      );
      return null;
    }
    const ensured = await activeWorkflow.ensureSelectedManuscript(
      selected.selection
    );
    if (
      !isActive(activeWorkflow) ||
      ensured.requestToken !== requestToken
    ) {
      return null;
    }
    if (ensured.status === "error") {
      input.onFeedback(
        "error",
        projectFormalSwitchFailure(ensured, input.ui).summary,
        `review.manuscript.switch.${ensured.code}`
      );
      return null;
    }
    await refresh(activeWorkflow);
    return {
      fileRefId: ensured.fileRefId,
      locationMode: ensured.locationMode,
      displayName: selected.selection.displayName,
      formalSwitchPresentation: ensured.formalSwitchPresentation
    };
  }

  async function openTargetManuscript(fileRefId?: string) {
    const reviewId = input.reviewId;
    if (!workflow || !reviewId || currentReviewIdRef.current !== reviewId) {
      return;
    }
    const ownerEpoch = ownerEpochRef.current;
    replacementGenerationRef.current += 1;
    const replacementGeneration =
      replacementGenerationRef.current;
    if (
      !isCurrentOwner({
        reviewId,
        ownerEpoch,
        replacementGeneration
      })
    ) {
      return;
    }
    setBusy(true);
    try {
      const preview = input.independentOpenPreviewProvider ??
        createIndependentOpenPreviewProvider({
        pickerTitle: input.ui("打开 Markdown 文稿"),
        async resolveWorkspace() {
          const workspace = await resolveReviewWorkspaceFolder(reviewId);
          const normalizedWorkspace = workspace.path
            .replace(/\//gu, "\\")
            .toLocaleLowerCase();
          return {
            initialDirectory: workspace.path,
            configuredRoot: workspace.managedRoot,
            classify: (path) => {
              const normalized = path
                .replace(/\//gu, "\\")
                .toLocaleLowerCase();
              return normalized.startsWith(`${normalizedWorkspace}\\`)
                ? "managed"
                : "external";
            }
          };
        },
        validateRaw({ rawText }) {
          const parsed = extractReviewManuscriptBlocks(rawText);
          return parsed.status === "error"
            ? {
                status: "error" as const,
                errorCode: parsed.error.code
              }
            : {
                status: "success" as const,
                summary: parsed.parsed.status
              };
        }
      });
      const normalize = (result: {
        status: string;
        sessionKey?: string;
        session?: SharedManuscriptSession;
        fileName?: string;
        fileRefId?: string;
        error?: { code?: string };
      }): IndependentOpenActivationResult =>
        result.status === "success" &&
        result.sessionKey &&
        result.session &&
        result.fileName &&
        result.fileRefId
          ? {
              status: "success",
              handle: result.sessionKey,
              session: result.session,
              fileName: result.fileName,
              fileRefId: result.fileRefId
            }
          : {
              status: result.status === "conflict" ? "conflict" : "error",
              errorCode: result.error?.code
            };
      const consumerId = `review:${reviewId}:independent-editor`;
      const adapter: IndependentOpenProductAdapter = {
        owner: { ownerType: "review", ownerId: reviewId, channel: "primary" },
        presentationScope: consumerId,
        consumerId,
        selectAndPreview: fileRefId
          ? async () => {
              const fileRef = await fileRefService.getById(fileRefId);
              return fileRef
                ? preview.previewPath(fileRef.path)
                : {
                    status: "invalid-target" as const,
                    errorCode: "INDEPENDENT_OPEN_FILE_REF_NOT_FOUND"
                  };
            }
          : preview.selectAndPreview,
        revalidatePreview: preview.revalidatePreview,
        listIndependentConsumers: () => {
          const handle = activeIndependentHandleRef.current;
          const session = handle
            ? reviewRawManuscriptService.getSession(handle)
            : undefined;
          return handle && session
            ? [{ handle, consumerId, session }]
            : [];
        },
        getCurrentConsumer: () =>
          currentHandle && currentSession
            ? {
                handle: currentHandle,
                consumerId: `review:${reviewId}:current-editor`,
                session: currentSession
              }
            : undefined,
        async activateCurrent(id) {
          return normalize(
            await reviewRawManuscriptService.openCurrent(reviewId, id)
          );
        },
        async activateIndependent(fileRefId, id) {
          return normalize(
            await reviewRawManuscriptService.openIndependent(
              reviewId,
              fileRefId,
              id
            )
          );
        },
        async closeConsumer(handle, decision) {
          if (decision === "save") {
            let saved = await reviewRawManuscriptService.save(handle);
            if (
              saved.status !== "success" &&
              saved.status !== "no-op" &&
              resultMessage(saved, "").includes(
                "REVIEW_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
              )
            ) {
              const confirmed = await requestChoice({
                title: input.ui("确认保存外部文稿"),
                message: input.ui("先保存旧外部文稿，再打开新目标吗？"),
                options: [
                  {
                    value: "confirm",
                    label: input.ui("确认保存"),
                    emphasis: "primary"
                  },
                  { value: "cancel", label: input.ui("取消") }
                ]
              });
              if (confirmed !== "confirm") {
                return {
                  status: "error",
                  consumerCleanupState: "unresolved",
                  sessionCleanupState: "unresolved",
                  admissionCleanupState: "unresolved",
                  errorCode: "EXTERNAL_WRITE_DECLINED"
                } as const;
              }
              saved = await reviewRawManuscriptService.save(handle, {
                confirmedExternalWrite: true
              });
            }
            if (saved.status !== "success" && saved.status !== "no-op") {
              return {
                status: "error",
                consumerCleanupState: "unresolved",
                sessionCleanupState: "unresolved",
                admissionCleanupState: "unresolved",
                errorCode: resultMessage(saved, "REVIEW_SAVE_FAILED")
              } as const;
            }
          }
          const replacement = await replaceActiveIndependentHandle({
            clear: true,
            expectedReviewId: reviewId,
            expectedOwnerEpoch: ownerEpoch,
            expectedReplacementGeneration: replacementGeneration,
            operation: "independent-open:replace-current"
          });
          const closed =
            "cleanup" in replacement && replacement.cleanup
              ? replacement.cleanup.result
              : undefined;
          return resolveIndependentOpenConsumerCleanup({
            closeStatus:
              replacement.status === "cleanup-unresolved"
                ? closed?.status ?? "error"
                : "success",
            runtimeCleanup:
              closed && "cleanup" in closed
                ? closed.cleanup
                : {
                    consumerCleanupState: "released",
                    sessionCleanupState: "released",
                    admissionCleanupState: "released"
                  },
            errorCode: resultMessage(closed, "REVIEW_CLOSE_FAILED")
          });
        },
        async presentCurrent(activation, permit) {
          if (activation.status !== "success" || !permit.isCurrent()) return false;
          setCurrentHandle(activation.handle);
          setOpen(true);
          setCurrentPresentationRevision((value) => value + 1);
          refreshSessions();
          return true;
        },
        async presentIndependent(activation, permit) {
          if (
            activation.status !== "success" ||
            !permit.isCurrent() ||
            !documentView(activation.session)
          ) {
            return false;
          }
          const replacement = await replaceActiveIndependentHandle({
            nextHandle: activation.handle,
            expectedReviewId: reviewId,
            expectedOwnerEpoch: ownerEpoch,
            expectedReplacementGeneration: replacementGeneration,
            operation: "independent-open:present"
          });
          return (
            replacement.status === "installed" ||
            replacement.status === "retained"
          );
        },
        async focusCurrent(consumer, permit) {
          if (!permit.isCurrent()) return false;
          setCurrentHandle(consumer.handle);
          setOpen(true);
          setCurrentPresentationRevision((value) => value + 1);
          return true;
        },
        async focusIndependent(consumer, permit) {
          if (!permit.isCurrent()) return false;
          const replacement = await replaceActiveIndependentHandle({
            nextHandle: consumer.handle,
            expectedReviewId: reviewId,
            expectedOwnerEpoch: ownerEpoch,
            expectedReplacementGeneration: replacementGeneration,
            operation: "independent-open:focus"
          });
          return (
            replacement.status === "installed" ||
            replacement.status === "retained"
          );
        },
        async decideDirty(consumer) {
          return new Promise<"save" | "discard" | "cancel">((resolve) => {
            void sharedEditorLifecycleController.requestParticipant({
              participantId: `review-independent:${consumer.handle}`,
              trigger: "open-independent",
              continuationIntent: "OPEN_INDEPENDENT",
              surface: "application",
              continuation: (decision) => resolve(decision ?? "discard")
            }).then((requested) => {
              if (
                requested.status === "unavailable" ||
                requested.status === "failed" ||
                requested.status === "stale" ||
                requested.status === "busy"
              ) {
                resolve("cancel");
              }
            });
          });
        },
        async confirmRegistration(candidate) {
          return window.confirm(
            input.ui(
              `是否登记并打开“${candidate.fileName}”？该操作只创建 FileRef 元数据，不改变当前稿或文件内容。`
            )
          )
            ? "confirm"
            : "cancel";
        },
        async confirmActivationRetry({ fileName }) {
          return window.confirm(
            input.ui(`“${fileName}”的登记已保留。是否重新尝试打开？`)
          );
        }
      };
      const outcome = await openProtocol.execute(adapter);
      const success = [
        "current-session-reused",
        "current-session-activated",
        "independent-session-reused",
        "activation-succeeded"
      ].includes(outcome.status);
      const canceled =
        outcome.status === "registration-declined" ||
        outcome.status === "picker-cancelled";
      input.onFeedback(
        success ? "success" : canceled ? "info" : "error",
        success
          ? input.ui("复盘文稿已打开。")
          : canceled
            ? input.ui("已取消打开，未产生持久化副作用。")
            : input.ui(
                `独立文稿打开未完成：${outcome.errorCode ?? outcome.status}`
              ),
        `review.manuscript.independentOpen.${outcome.status}`
      );
      await refresh(workflow);
    } finally {
      if (
        workflow &&
        isActive(workflow) &&
        isCurrentOwner({
          reviewId,
          ownerEpoch,
          replacementGeneration
        })
      ) {
        setBusy(false);
      }
    }
  }

  async function switchCurrent() {
    if (!workflow || !currentSession) return;
    setBusy(true);
    try {
      const selected = await selectSwitchTarget();
      if (selected) {
        await setCurrent(
          selected.fileRefId,
          selected.displayName,
          selected.locationMode,
          false,
          selected.formalSwitchPresentation
        );
      }
    } finally {
      if (workflow && isActive(workflow)) setBusy(false);
    }
  }

  async function setCurrent(
    fileRefId: string,
    selectedDisplayName?: string,
    selectedLocationMode?: "managed" | "external",
    lifecycleSettled = false,
    formalSwitchPresentation?: Readonly<{
      reviewType: import("../../types/planning").ReviewType;
      fieldActions: readonly Readonly<{
        key: string;
        action: "set" | "clear";
      }>[];
    }>
  ) {
    const activeWorkflow = workflow;
    if (!activeWorkflow || !isActive(activeWorkflow)) return;
    if (!currentSession && !(await openCurrent())) return;
    const session =
      currentHandle
        ? reviewRawManuscriptService.getSession(currentHandle)
        : undefined;
    if (!session) return;
    const availableTarget = available.find(
      (item) => item.fileRefId === fileRefId
    );
    if (availableTarget?.isCurrent) return;
    const targetDisplayName =
      availableTarget?.displayName ?? selectedDisplayName;
    const targetLocationMode =
      availableTarget?.locationMode ?? selectedLocationMode;
    if (!targetDisplayName) return;
    if (!lifecycleSettled) {
      const reviewType = formalSwitchPresentation?.reviewType ??
        input.reviewType;
      if (!reviewType) return;
      const switchCopy = buildFormalSwitchConfirmationCopy({
        targetFileName: targetDisplayName,
        ownerDisplayName: input.ui("复盘文稿"),
        descriptorLookupIdentity: {
          ownerType: "review",
          channel: "primary",
          reviewType
        },
        translate: input.ui,
        resolveLabel: (field) => input.ui(field.displayLabel),
        fieldActions: formalSwitchPresentation?.fieldActions ?? []
      });
      const confirmed = await requestChoice({
        kind: "formal-switch",
        title: input.ui("设为当前稿"),
        message: switchCopy.message,
        options: [
          {
            value: "confirm",
            label: input.ui("设为当前稿"),
            emphasis: "primary"
          },
          { value: "cancel", label: input.ui("取消") }
        ]
      });
      if (confirmed !== "confirm") return;
      await sharedEditorLifecycleController.requestParticipant({
        participantId: `review-current:${currentHandle ?? "closed"}`,
        trigger: "switch-manuscript",
        continuationIntent: "SWITCH_MANUSCRIPT",
        surface: "application",
        continuation: () => setCurrent(
          fileRefId,
          selectedDisplayName,
          selectedLocationMode,
          true,
          formalSwitchPresentation
        )
      });
      return;
    }
    const latest =
      currentHandle
        ? reviewRawManuscriptService.getSession(currentHandle)
        : undefined;
    if (!latest) return;
    const result = await activeWorkflow.setCurrent({
      currentSessionHandle: currentHandle!,
      targetFileRefId: fileRefId
    });
    if (!result || !isActive(activeWorkflow)) return;
    if (result.status === "error") {
      input.onFeedback(
        "error",
        projectFormalSwitchFailure(result, input.ui, { reload: true }).summary,
        "review.manuscript.setCurrent"
      );
      return;
    }
    if (result.status !== "success") return;
    const activeIndependentHandle =
      activeIndependentHandleRef.current;
    const activeIndependentSession = activeIndependentHandle
      ? reviewRawManuscriptService.getSession(activeIndependentHandle)
      : undefined;
    if (
      activeIndependentSession?.file.kind === "durable" &&
      activeIndependentSession.file.fileRefId === fileRefId
    ) {
      replacementGenerationRef.current += 1;
      await replaceActiveIndependentHandle({
        clear: true,
        expectedReviewId: activeWorkflow.ownerId,
        expectedOwnerEpoch: ownerEpochRef.current,
        expectedReplacementGeneration:
          replacementGenerationRef.current,
        operation: "formal-switch:target-became-current"
      });
    }
    if (!result.sessionKey) {
      input.onFeedback(
        "error",
        projectFormalSwitchFailure({ error: { sideEffectSummary: { databaseCommitted: true } } }, input.ui).summary,
        "review.manuscript.setCurrent.reload"
      );
      return;
    }
    setCurrentHandle(result.sessionKey);
    setCurrentPresentationRevision((current) => current + 1);
    try {
      await refresh(activeWorkflow);
      await input.onRefreshDetail();
      refreshSessions();
    } catch {
      input.onFeedback("error", projectFormalSwitchFailure(
        { error: { sideEffectSummary: { databaseCommitted: true } } }, input.ui
      ).summary, "review.manuscript.setCurrent");
      return;
    }
    input.onFeedback(
      "success",
      input.ui("当前复盘文稿已切换。"),
      "review.manuscript.setCurrent"
    );
  }

  async function repairCurrent(fileRefId: string) {
    const activeWorkflow = workflow;
    const target = available.find((item) => item.fileRefId === fileRefId);
    if (
      !activeWorkflow ||
      !target ||
      target.isCurrent ||
      !isActive(activeWorkflow)
    ) {
      return;
    }
    const confirmed = await requestChoice({
      title: input.ui("重新选择当前稿"),
      message: input.ui(
        `当前稿身份无效。确认将“${target.displayName}”设为当前复盘文稿吗？`
      ),
      options: [
        {
          value: "confirm",
          label: input.ui("确认修复"),
          emphasis: "primary"
        },
        { value: "cancel", label: input.ui("取消") }
      ]
    });
    if (confirmed !== "confirm") return;
    try {
      const result = await activeWorkflow.repairCurrent(fileRefId);
      if (!result || !isActive(activeWorkflow)) return;
      if (result.status === "error") {
        input.onFeedback(
          "error",
          result.error.message,
          "review.manuscript.repairCurrent"
        );
        return;
      }
      const opened = await reviewRawManuscriptService.openCurrent(
        activeWorkflow.ownerId
      );
      if (opened.status !== "success" || !("sessionKey" in opened)) {
        input.onFeedback(
          "error",
          resultMessage(opened, input.ui("修复后的当前文稿无法打开。")),
          "review.manuscript.repairCurrent.reload"
        );
        return;
      }
      setCurrentHandle(opened.sessionKey);
      setOpen(true);
      await refresh(activeWorkflow);
      await input.onRefreshDetail();
      refreshSessions();
      input.onFeedback(
        "success",
        input.ui("当前复盘文稿已修复。"),
        "review.manuscript.repairCurrent"
      );
    } catch (error) {
      input.onFeedback(
        "error",
        error instanceof Error ? error.message : String(error),
        "review.manuscript.repairCurrent"
      );
    }
  }

  async function discardLifecycleSession(kind: "current" | "target") {
    const handle = kind === "current" ? currentHandle : targetHandle;
    if (!handle) throw new Error("MANUSCRIPT_LIFECYCLE_SESSION_UNAVAILABLE");
    const result = await reviewRawManuscriptService.reload(handle, "discard");
    refreshSessions();
    if (result.status !== "success") {
      throw new Error(resultMessage(result, input.ui("放弃文稿更改失败。")));
    }
  }

  async function closeCurrent() {
    if (currentHandle) {
      const result = await reviewRawManuscriptService.close(currentHandle);
      if (result.status !== "success") return;
    }
    setCurrentHandle(undefined);
    setOpen(false);
    refreshSessions();
  }

  async function closeTarget() {
    const reviewId = currentReviewIdRef.current;
    if (reviewId && mountedRef.current) {
      replacementGenerationRef.current += 1;
      await replaceActiveIndependentHandle({
        clear: true,
        expectedReviewId: reviewId,
        expectedOwnerEpoch: ownerEpochRef.current,
        expectedReplacementGeneration:
          replacementGenerationRef.current,
        operation: "independent-editor:close"
      });
    }
  }

  return {
    workflowReady: Boolean(workflow),
    pageState,
    available,
    document,
    currentHandle,
    currentSession,
    currentDirty: currentSession?.dirty ?? false,
    draftBody: document?.body ?? "",
    currentPresentationRevision,
    open,
    targetDocument,
    targetHandle,
    targetSession,
    targetDirty: targetSession?.dirty ?? false,
    targetRawMarkdown: targetDocument?.rawMarkdown ?? "",
    targetMetaSnapshot: targetDocument?.metaSnapshot ?? "",
    setTargetMetaSnapshot(value: string) {
      updateSessionSections(targetHandle, { metaSnapshot: value });
    },
    targetOutline: targetDocument?.outline ?? "",
    setTargetOutline(value: string) {
      updateSessionSections(targetHandle, { outline: value });
    },
    targetDraftBody: targetDocument?.body ?? "",
    targetPresentationRevision,
    contextInsert,
    busy,
    choiceDialog,
    resolveChoice,
    retryProvisioning,
    openCurrent,
    saveCurrent,
    saveCurrentAs(value: string | ManuscriptSegmentDraftSnapshot = "") {
      return saveAs("current", value);
    },
    saveCurrentAsCurrentSession(snapshot?: ManuscriptSegmentDraftSnapshot) {
      return saveAs("current", snapshot ?? "");
    },
    updateDraft(markdown: string) {
      updateSessionSections(currentHandle, { body: markdown });
    },
    readCurrentSession: () => currentHandle
      ? reviewRawManuscriptService.getSession(currentHandle)
      : undefined,
    discardCurrent: () => discardLifecycleSession("current"),
    closeCurrent: () => void closeCurrent(),
    reloadCurrent,
    openTarget: (fileRefId: string) =>
      void openTargetManuscript(fileRefId),
    openTargetManuscript,
    saveTarget,
    reloadTarget,
    saveTargetAs(value: string | ManuscriptSegmentDraftSnapshot = "") {
      return saveAs("independent", value);
    },
    saveTargetAsCurrentSession(snapshot?: ManuscriptSegmentDraftSnapshot) {
      return saveAs("independent", snapshot ?? "");
    },
    updateTargetRawMarkdown,
    updateTargetDraft(markdown: string) {
      updateSessionSections(targetHandle, { body: markdown });
    },
    readTargetSession: () => targetHandle
      ? reviewRawManuscriptService.getSession(targetHandle)
      : undefined,
    discardTarget: () => discardLifecycleSession("target"),
    closeTarget: () => void closeTarget(),
    setCurrent,
    switchCurrent,
    repairCurrent,
    refresh: () =>
      workflow ? refresh(workflow) : Promise.resolve()
  };
}
