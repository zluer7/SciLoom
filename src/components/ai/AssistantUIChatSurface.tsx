import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessageNotSentError,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type TextMessagePartComponent
} from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AIAuthorizedFileRefSnapshot,
  AICallAttempt,
  AIConversationReadback
} from "../../types/aiConversation";
import type { AIContextRequest } from "../../types/aiContextRequest";
import type { AIChatRetryRegenerateActionIntent } from "../../services/aiConversationApplicationService";
import {
  buildAIContextReceipt,
  type AIContextReceipt
} from "../../services/aiContextReceiptService";
import { selectInteractiveAIContextRequests } from "../../services/aiParseSupplementalContextService";
import {
  extractComposerText,
  mapCanonicalMessage,
  orderCanonicalMessages
} from "./assistantUIExternalStateAdapter";
import { SafeAssistantMarkdown } from "./SafeAssistantMarkdown";
import { AIContextRequestCard } from "./AIContextRequestCard";

export type AssistantUIComposerOutcome = {
  restoreDraft: boolean;
  safeErrorMessage?: string;
};

type AssistantUIChatSurfaceProps = {
  readback: AIConversationReadback;
  initialDraft?: string;
  partialText: string;
  isRunning: boolean;
  isStopping: boolean;
  composerDisabled: boolean;
  sendDisabled: boolean;
  sendGateCode?: string;
  sendGateNotice?: string;
  providerBoundaryCode?: string;
  canStop: boolean;
  actionsDisabled: boolean;
  contextRequestActionsDisabled: boolean;
  activeActionIntent: AIChatRetryRegenerateActionIntent | null;
  attachmentComposer: ReactNode;
  parseDraftAction: ReactNode;
  emptyStateGreeting: string;
  onDraftChange: (value: string) => void;
  onRegenerate: () => void;
  onRetry: () => void;
  reviewingContextRequestId?: string;
  reviewedContextRequestId?: string;
  decidingContextRequestId?: string;
  onApproveContextRequest: (request: AIContextRequest) => void;
  onRejectContextRequest: (request: AIContextRequest) => void;
  onSubmit: (text: string) => Promise<AssistantUIComposerOutcome>;
  onStop: () => void;
};

const UserPlainTextPart: TextMessagePartComponent = () => (
  <MessagePartPrimitive.Text
    className="global-ai-chat-panel__message-text"
    component="p"
    smooth={false}
  />
);

type MaterialRequestProvenance =
  | "authorization-only"
  | "gate-failed"
  | "request-included-incomplete"
  | "request-included-completed";

const PROVIDER_LIFECYCLE_FAILURES = new Set([
  "network_error",
  "timeout",
  "auth_error",
  "quota_error",
  "rate_limited",
  "invalid_request",
  "provider_error",
  "invalid_response",
  "empty_choices",
  "empty_content",
  "stream_protocol_error",
  "stream_ended_early",
  "call_attempt_execution_orphaned",
  "cancelled"
]);

function materialRequestProvenance(attempt: AICallAttempt): {
  kind: MaterialRequestProvenance;
  label: string;
} {
  if (attempt.status === "succeeded") {
    return {
      kind: "request-included-completed",
      label: "所选材料已用于这次已完成的回复。"
    };
  }
  if (attempt.errorCode?.startsWith("material_")) {
    return {
      kind: "gate-failed",
      label: "材料已获本次授权，但在发送前未通过安全检查。"
    };
  }
  if (attempt.errorCode && PROVIDER_LIFECYCLE_FAILURES.has(attempt.errorCode)) {
    return {
      kind: "request-included-incomplete",
      label: "所选材料已用于这次请求，但回复未完成。"
    };
  }
  return {
    kind: "authorization-only",
    label: "材料已获本次授权，但无法确认是否实际用于请求。"
  };
}

function contextModeLabel(mode: string): string {
  if (mode === "MINIMAL") return "精简";
  if (mode === "STANDARD") return "标准";
  if (mode === "DETAILED") return "详细";
  if (mode === "FULL") return "充分";
  return "自定义";
}

function contextObjectTypeLabel(objectType: string): string {
  const labels: Record<string, string> = {
    route: "研究路线",
    routeNode: "研究路线",
    task: "研究任务",
    review: "复盘",
    experiment: "实验",
    experimentRun: "实验运行",
    literature: "文献",
    resultItem: "结果资产",
    finding: "关键发现",
    outputCandidate: "候选成果",
    outputGap: "成果缺口",
    researchOutput: "正式成果"
  };
  return labels[objectType] ?? "研究对象";
}

function HistoricalAttachmentEvidence({ attempt }: { attempt?: AICallAttempt }) {
  if (!attempt || attempt.authorizedFileRefs.length === 0) return null;
  const snapshots: AIAuthorizedFileRefSnapshot[] = attempt.authorizedFileRefs;
  const provenance = materialRequestProvenance(attempt);
  return (
    <div
      aria-label="历史调用中已授权的材料"
      className="global-ai-chat-panel__historical-attachments"
      data-attachment-evidence-only="true"
      data-material-request-provenance={provenance.kind}
    >
      {snapshots.map((snapshot) => (
        <span
          className={snapshot.availabilityStatus === "available" ? "" : "is-unavailable"}
          key={snapshot.fileRefId}
          title="仅展示历史授权记录，不会授权新的调用。"
        >
          {snapshot.displayName}
          {snapshot.availabilityStatus === "available" ? "" : " · 当前不可用"}
        </span>
      ))}
      <small>{provenance.label}</small>
    </div>
  );
}

function ContextReceiptEvidence({ attempts }: { attempts: AICallAttempt[] }) {
  const receipts = attempts
    .map(buildAIContextReceipt)
    .filter((receipt): receipt is AIContextReceipt => Boolean(receipt));
  if (receipts.length === 0) return null;
  const compactItems = (
    label: string,
    items: Array<{ label?: string }>
  ): string | undefined => {
    if (items.length === 0) return undefined;
    const names = items.flatMap((item) => item.label?.trim() ? [item.label.trim()] : []).slice(0, 2);
    if (items.length === 1 && names.length === 1) return `${label}：${names[0]}`;
    if (names.length === 0) return `${label}：${items.length} 项`;
    return `${label}：${items.length} 项（${names.join("、")}${items.length > names.length ? "等" : ""}）`;
  };
  return (
    <div className="global-ai-chat-panel__context-receipts" aria-label="历史上下文记录">
      {receipts.map((receipt) => {
        const lines = [
          compactItems("路线", receipt.primaryRoutes),
          compactItems("任务", receipt.primaryTasks),
          compactItems("复盘", receipt.primaryReviews),
          compactItems("实验", receipt.primaryExperiments),
          compactItems("实验运行", receipt.primaryExperimentRuns),
          compactItems("文献", receipt.primaryLiterature),
          compactItems("关键发现", receipt.primaryFindings),
          compactItems("成果对象", receipt.primaryOutputObjects.map((item) => ({
            label: item.label ? `${contextObjectTypeLabel(item.objectType)}：${item.label}` : contextObjectTypeLabel(item.objectType)
          }))),
          compactItems("材料", receipt.authorizedMaterials.map((item) => ({ label: item.displayName })))
        ].filter((line): line is string => Boolean(line));
        return (
          <section data-context-receipt-attempt-id={receipt.attemptId} key={receipt.attemptId}>
            <strong>上下文内容（{contextModeLabel(receipt.contextMode)}）</strong>
            <span>课题：{receipt.project.label?.trim() || "当前课题"}</span>
            {lines.map((line) => <span key={line}>{line}</span>)}
          </section>
        );
      })}
    </div>
  );
}

function UserMessage({ attempts = [] }: { attempts?: AICallAttempt[] }) {
  const attachmentAttempt = [...attempts].reverse().find((attempt) => attempt.authorizedFileRefs.length > 0);
  return (
    <MessagePrimitive.Root
      className="global-ai-chat-panel__message global-ai-chat-panel__message--user"
      data-message-role="user"
    >
      <span className="global-ai-chat-panel__message-label">研究者</span>
      <MessagePrimitive.Parts components={{ Text: UserPlainTextPart }} />
      <ContextReceiptEvidence attempts={attempts} />
      <HistoricalAttachmentEvidence attempt={attachmentAttempt} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({
  canRegenerate,
  disabled,
  isRegenerating,
  onRegenerate,
  contextRequest,
  contextRequestDisabled,
  contextRequestReviewReady,
  contextRequestReviewing,
  contextRequestDeciding,
  onApproveContextRequest,
  onRejectContextRequest
}: {
  canRegenerate: boolean;
  disabled: boolean;
  isRegenerating: boolean;
  onRegenerate: () => void;
  contextRequest?: AIContextRequest;
  contextRequestDisabled: boolean;
  contextRequestReviewReady: boolean;
  contextRequestReviewing: boolean;
  contextRequestDeciding: boolean;
  onApproveContextRequest: (request: AIContextRequest) => void;
  onRejectContextRequest: (request: AIContextRequest) => void;
}) {
  const OrdinaryAssistantText: TextMessagePartComponent = ({ text }) => (
    <SafeAssistantMarkdown text={text} />
  );
  return (
    <MessagePrimitive.Root
      className="global-ai-chat-panel__message global-ai-chat-panel__message--assistant"
      data-message-role="assistant"
    >
      <span className="global-ai-chat-panel__message-label">AI辅助</span>
      <MessagePrimitive.Parts components={{ Text: OrdinaryAssistantText }} />
      {contextRequest ? (
        <AIContextRequestCard
          request={contextRequest}
          disabled={contextRequestDisabled}
          reviewReady={contextRequestReviewReady}
          isReviewing={contextRequestReviewing}
          isDeciding={contextRequestDeciding}
          onApprove={() => onApproveContextRequest(contextRequest)}
          onReject={() => onRejectContextRequest(contextRequest)}
        />
      ) : null}
      {canRegenerate ? (
        <div className="global-ai-chat-panel__turn-actions" data-effective-result-action="regenerate">
          <button disabled={disabled} onClick={onRegenerate} type="button">
          {isRegenerating ? "正在重新生成…" : "重新生成"}
          </button>
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}

export function AssistantUIChatSurface({
  readback,
  initialDraft,
  partialText,
  isRunning,
  isStopping,
  composerDisabled,
  sendDisabled,
  sendGateCode,
  sendGateNotice,
  providerBoundaryCode,
  canStop,
  actionsDisabled,
  contextRequestActionsDisabled,
  activeActionIntent,
  attachmentComposer,
  parseDraftAction,
  emptyStateGreeting,
  onDraftChange,
  onRegenerate,
  onRetry,
  reviewingContextRequestId,
  reviewedContextRequestId,
  decidingContextRequestId,
  onApproveContextRequest,
  onRejectContextRequest,
  onSubmit,
  onStop
}: AssistantUIChatSurfaceProps) {
  const submissionInFlight = useRef(false);
  const initialDraftAppliedRef = useRef(false);
  const projectedIds = new Set(readback.projectedMessages.map((message) => message.id));
  const interactiveContextRequests = selectInteractiveAIContextRequests(readback);
  const unprojectedContextRequestMessages = interactiveContextRequests
    .filter((request) => !projectedIds.has(request.sourceMessageId))
    .map((request) => readback.messages.find((message) => (
      message.id === request.sourceMessageId && message.role === "assistant" && message.messageKind === "text"
    )))
    .filter((message): message is NonNullable<typeof message> => Boolean(message));
  const messages = orderCanonicalMessages([
    ...readback.projectedMessages,
    ...unprojectedContextRequestMessages
  ]);
  const attemptsByMessageId = new Map<string, AICallAttempt[]>();
  [...readback.callAttempts]
    .filter((attempt) => (
      attempt.purpose === "chat_response" && attempt.triggerMessageId
    ))
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .forEach((attempt) => {
      const messageId = attempt.triggerMessageId!;
      attemptsByMessageId.set(messageId, [...(attemptsByMessageId.get(messageId) ?? []), attempt]);
    });
  const actionProjection = readback.retryRegenerate;
  const contextRequestBySourceMessageId = new Map(
    interactiveContextRequests.map((request) => [request.sourceMessageId, request])
  );
  const latestAttempt = actionProjection.latestAttemptId
    ? readback.callAttempts.find((attempt) => attempt.id === actionProjection.latestAttemptId)
    : undefined;
  const actionInFlight = isRunning || Boolean(activeActionIntent);
  const showRetry = !actionProjection.effectiveAssistantMessageId &&
    !actionProjection.attachmentReauthorizationRequired && (
    actionProjection.retryEligible || activeActionIntent === "retry"
  );

  const handleNew = useCallback(async (message: AppendMessage) => {
    const text = extractComposerText(message);
    if (!text) {
      throw new MessageNotSentError("请输入问题后再发送。");
    }
    if (submissionInFlight.current) {
      throw new MessageNotSentError("当前消息正在发送，请稍候。");
    }
    submissionInFlight.current = true;
    try {
      const outcome = await onSubmit(text);
      if (outcome.restoreDraft) {
      throw new MessageNotSentError(outcome.safeErrorMessage ?? "消息未发送。");
      }
      onDraftChange("");
    } finally {
      submissionInFlight.current = false;
    }
  }, [onDraftChange, onSubmit]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: mapCanonicalMessage,
    onNew: handleNew,
    isRunning
  });

  useEffect(() => {
    if (initialDraftAppliedRef.current || !initialDraft?.trim()) return;
    runtime.thread.composer.setText(initialDraft);
    initialDraftAppliedRef.current = true;
  }, [initialDraft, runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root
        className="global-ai-chat-panel__assistant-ui-thread"
        data-ai-external-state="canonical-sqlite"
        data-provider-boundary-code={providerBoundaryCode ?? "unknown"}
        data-send-gate-code={sendGateCode ?? "unknown"}
      >
        <ThreadPrimitive.Viewport
          autoScroll
          className="global-ai-chat-panel__assistant-ui-viewport"
        >
          {messages.length === 0 && !partialText ? (
            <div className="global-ai-chat-panel__assistant-ui-empty">
              <strong>{emptyStateGreeting}</strong>
            </div>
          ) : (
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === "user"
                ? <UserMessage attempts={attemptsByMessageId.get(message.id)} />
                : (
                    <AssistantMessage
                      canRegenerate={
                        message.id === actionProjection.effectiveAssistantMessageId &&
                        !actionProjection.attachmentReauthorizationRequired &&
                        (actionProjection.regenerateEligible || activeActionIntent === "regenerate")
                      }
                      disabled={actionsDisabled || actionInFlight}
                      isRegenerating={activeActionIntent === "regenerate"}
                      onRegenerate={onRegenerate}
                      contextRequest={contextRequestBySourceMessageId.get(message.id)}
                      contextRequestDisabled={contextRequestActionsDisabled || actionInFlight}
                      contextRequestReviewReady={reviewedContextRequestId === contextRequestBySourceMessageId.get(message.id)?.id}
                      contextRequestReviewing={reviewingContextRequestId === contextRequestBySourceMessageId.get(message.id)?.id}
                      contextRequestDeciding={decidingContextRequestId === contextRequestBySourceMessageId.get(message.id)?.id}
                      onApproveContextRequest={onApproveContextRequest}
                      onRejectContextRequest={onRejectContextRequest}
                    />
                  )}
            </ThreadPrimitive.Messages>
          )}
          {isRunning && partialText ? (
            <article
              className="global-ai-chat-panel__message global-ai-chat-panel__message--assistant global-ai-chat-panel__message--partial"
              data-ai-streaming-partial="true"
            >
              <span className="global-ai-chat-panel__message-label">AI辅助 · 回复中</span>
              <SafeAssistantMarkdown text={partialText} />
            </article>
          ) : null}
          {actionProjection.attachmentReauthorizationRequired ? (
            <aside
              className="global-ai-chat-panel__retry-regenerate-notice"
              data-retry-regenerate-block="attachment-reauthorization-required"
              role="note"
            >
              该请求使用过本地材料。附件授权仅对原调用有效；请重新选择材料并重新发送。
            </aside>
          ) : showRetry ? (
            <aside
              className="global-ai-chat-panel__retry-regenerate-notice"
              data-retry-source-attempt-id={latestAttempt?.id ?? "active"}
              role="status"
            >
              <span>
                {activeActionIntent === "retry"
                  ? "正在重试上一轮未完成的回复。"
                  : "上一轮回复未完成，可重试。"}
              </span>
              <button
                disabled={actionsDisabled || actionInFlight}
                onClick={onRetry}
                type="button"
              >
                {activeActionIntent === "retry" ? "正在重试…" : "重试"}
              </button>
            </aside>
          ) : null}
          <ThreadPrimitive.ScrollToBottom className="global-ai-chat-panel__scroll-bottom">
            最新消息
          </ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.Viewport>

        <ComposerPrimitive.Root className="global-ai-chat-panel__assistant-ui-composer">
          <div className="global-ai-chat-panel__parse-entry-row">
            {parseDraftAction}
          </div>
          <div className="global-ai-chat-panel__composer-row">
            {attachmentComposer}
            <ComposerPrimitive.Input
              addAttachmentOnPaste={false}
              aria-label="输入问题"
              className="global-ai-chat-panel__assistant-ui-input"
              disabled={composerDisabled}
              onChange={(event) => onDraftChange(event.currentTarget.value)}
              placeholder="输入问题，按 Enter 发送…"
              rows={1}
              submitMode="enter"
            />
            <div className="global-ai-chat-panel__composer-actions">
              {isRunning ? (
              <button
                aria-label={canStop ? (isStopping ? "正在停止" : "停止生成") : "正在发送"}
                className="global-ai-chat-panel__send global-ai-chat-panel__send--running"
                data-send-state={isStopping ? "stopping" : "running"}
                disabled={!canStop || isStopping}
                onClick={onStop}
                title={canStop ? (isStopping ? "正在停止" : "停止生成") : "正在发送"}
                type="button"
              >
                <span aria-hidden="true">{isStopping ? "…" : "■"}</span>
                <span className="global-ai-chat-panel__sr-only">
                  {canStop ? (isStopping ? "正在停止" : "停止生成") : "正在发送"}
                </span>
              </button>
              ) : (
                <ComposerPrimitive.Send
                  aria-label="确认并发送"
                  className="global-ai-chat-panel__send"
                  data-send-state="idle"
                  disabled={sendDisabled || composerDisabled}
                  title="确认并发送"
                >
                  <span aria-hidden="true">↑</span>
                  <span className="global-ai-chat-panel__sr-only">确认并发送</span>
                </ComposerPrimitive.Send>
              )}
            </div>
          </div>
          {sendGateNotice ? (
            <p
              className="global-ai-chat-panel__send-gate-notice"
              data-provider-boundary-code={providerBoundaryCode ?? "unknown"}
              data-send-gate-code={sendGateCode ?? "unknown"}
              role="status"
            >
              {sendGateNotice}
            </p>
          ) : null}
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
