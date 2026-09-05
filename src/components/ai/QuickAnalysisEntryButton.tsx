import { Fragment, useEffect, useId, useState } from "react";
import {
  quickAnalysisCoordinator,
  type QuickAnalysisRunSnapshot,
  type QuickAnalysisStartResult
} from "../../services/quickAnalysisCoordinator";
import type { QuickAnalysisStartInput } from "../../services/quickAnalysisCapabilityBinding";
import { projectQuickAnalysisFailureSummary } from "../../services/quickAnalysisFeedbackPresentation";

export type QuickAnalysisEntryIdentity = Pick<
  QuickAnalysisStartInput,
  "ownerType" | "ownerId" | "channel"
>;

export interface QuickAnalysisEntryCoordinatorPort {
  start(input: QuickAnalysisStartInput): QuickAnalysisStartResult;
  getSnapshot(input: QuickAnalysisEntryIdentity): QuickAnalysisRunSnapshot | undefined;
  subscribe(listener: (snapshot: QuickAnalysisRunSnapshot) => void): () => void;
}

export interface QuickAnalysisEntryButtonProps {
  ownerRef: QuickAnalysisEntryIdentity;
  expectedProjectOrScopeId?: string;
  ownerLabel: string;
  className?: string;
  disabled?: boolean;
  coordinator?: QuickAnalysisEntryCoordinatorPort;
}

export interface QuickAnalysisEntryLocalFeedback {
  tone: "error" | "warning" | "success";
  message: string;
}

/**
 * Entry-local projection for the bounded Literature/dedicated_notes closure.
 * It consumes only the exact coordinator terminal record already correlated by
 * owner/channel; callers cannot inject a presentation-only terminal message.
 */
export function projectLiteratureDedicatedNotesQuickTerminalFeedback(
  snapshot: QuickAnalysisRunSnapshot | undefined
): QuickAnalysisEntryLocalFeedback | undefined {
  if (!snapshot || snapshot.phase !== "TERMINAL") return undefined;
  if (
    snapshot.terminalState === "SUCCEEDED" &&
    snapshot.candidateFileRefId &&
    snapshot.candidateTerminalCommitState === "POST_PUBLISH_READBACK_CONFIRMED"
  ) {
    return snapshot.outputIncompleteNotice
      ? {
          tone: "warning",
          message: "AI分析已创建候选文稿，但 Provider 报告输出可能不完整；请先检查候选内容。"
        }
      : {
          tone: "success",
          message: "AI分析完成：已创建新的候选文稿。"
        };
  }
  if (snapshot.terminalState === "TERMINAL_EFFECT_OUTCOME_UNKNOWN") {
    return {
      tone: "warning",
      message: "AI分析的候选发布结果尚不确定，系统已停止自动重试；请查看本页反馈详情后再处理。"
    };
  }
  if (snapshot.errorCode === "QUICK_ANALYSIS_SCOPE_UNAVAILABLE") {
    return {
      tone: "error",
      message: "AI生成未开始：此文献没有可用于本次运行的课题。请先在上方“关联课题”中明确选择一个现有课题，再点击“AI分析”。"
    };
  }
  if (snapshot.errorCode === "QUICK_ANALYSIS_PROJECT_UNAVAILABLE") {
    return {
      tone: "error",
      message: "AI生成未开始：所选课题不存在、已归档或当前不可用。请在上方“关联课题”中重新选择一个现有课题。"
    };
  }
  if (snapshot.errorCode === "QUICK_ANALYSIS_SCOPE_MISMATCH") {
    return {
      tone: "error",
      message: "AI生成未开始：当前选择的课题与文献的正式关联不一致。请切换到文献的正式关联课题后再试。"
    };
  }
  return {
    tone: "error",
    message: projectQuickAnalysisFailureSummary(snapshot)
  };
}

/**
 * UI-only facade over the one application-scoped Quick Analysis coordinator.
 * Project/source/Binding/candidate semantics remain owned by the A19 foundation.
 */
export function QuickAnalysisEntryButton({
  ownerRef,
  expectedProjectOrScopeId,
  ownerLabel,
  className,
  disabled = false,
  coordinator = quickAnalysisCoordinator
}: QuickAnalysisEntryButtonProps) {
  const { ownerType, ownerId, channel } = ownerRef;
  const [snapshot, setSnapshot] = useState<QuickAnalysisRunSnapshot | undefined>();
  const localFeedbackId = useId();

  useEffect(() => {
    const identity: QuickAnalysisEntryIdentity = { ownerType, ownerId, channel };
    const acceptSnapshot = (candidate: QuickAnalysisRunSnapshot | undefined) => {
      setSnapshot(candidate);
    };
    acceptSnapshot(coordinator.getSnapshot(identity));
    return coordinator.subscribe((candidate) => {
      if (
        candidate.ownerType !== ownerType ||
        candidate.ownerId !== ownerId ||
        candidate.channel !== channel
      ) return;
      acceptSnapshot(candidate);
    });
  }, [channel, coordinator, ownerId, ownerType]);

  const running = Boolean(
    snapshot?.ownerType === ownerType &&
    snapshot.ownerId === ownerId &&
    snapshot.channel === channel &&
    (snapshot.terminalState === "START_RESERVED" || snapshot.terminalState === "RUNNING")
  );
  const localFeedback = ownerType === "literature" && channel === "dedicated_notes"
    ? projectLiteratureDedicatedNotesQuickTerminalFeedback(snapshot)
    : undefined;

  return (
    <Fragment>
      <button
        aria-label={`AI分析: ${ownerLabel || ownerId}`}
        aria-busy={running}
        aria-describedby={localFeedback ? localFeedbackId : undefined}
        className={className}
        data-quick-analysis-channel={channel}
        data-quick-analysis-owner-id={ownerId}
        data-quick-analysis-owner-type={ownerType}
        disabled={disabled || running}
        type="button"
        onClick={() => {
          coordinator.start({
            ownerType,
            ownerId,
            channel,
            ...(expectedProjectOrScopeId?.trim()
              ? { expectedProjectOrScopeId: expectedProjectOrScopeId.trim() }
              : {})
          });
        }}
      >
        AI分析
      </button>
      {localFeedback ? (
        <span
          className={`quick-analysis-entry-local-feedback quick-analysis-entry-local-feedback-${localFeedback.tone}`}
          data-quick-analysis-feedback-channel={channel}
          data-quick-analysis-feedback-owner-id={ownerId}
          data-quick-analysis-feedback-run-id={snapshot?.runId}
          id={localFeedbackId}
          role={localFeedback.tone === "error" ? "alert" : "status"}
        >
          {localFeedback.message}
        </span>
      ) : null}
    </Fragment>
  );
}
