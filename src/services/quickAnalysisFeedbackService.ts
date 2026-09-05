import type { PushPageFeedbackInput } from "./writeFeedbackDisplayService";
import { pushPageFeedback } from "./writeFeedbackDisplayService";
import {
  quickAnalysisCoordinator,
  type QuickAnalysisRunSnapshot
} from "./quickAnalysisCoordinator";
import { projectQuickAnalysisFailureSummary } from "./quickAnalysisFeedbackPresentation";

export interface QuickAnalysisFeedbackCoordinatorPort {
  subscribe(listener: (snapshot: QuickAnalysisRunSnapshot) => void): () => void;
}

export interface QuickAnalysisFeedbackOwner {
  start(): void;
  stop(): void;
}

function projectionFingerprint(feedback: PushPageFeedbackInput) {
  return JSON.stringify({
    severity: feedback.severity,
    title: feedback.title,
    summary: feedback.summary ?? null,
    reason: feedback.reason ?? null
  });
}

function primaryPageForOwner(ownerType: QuickAnalysisRunSnapshot["ownerType"]) {
  if (ownerType === "experiment" || ownerType === "experimentRun") return "experiments";
  if (ownerType === "literature") return "literature";
  if (ownerType === "review") return "reviews";
  return "outputs";
}

function feedbackForSnapshot(
  snapshot: QuickAnalysisRunSnapshot
): PushPageFeedbackInput | null {
  if (snapshot.phase !== "TERMINAL") {
    return null;
  }
  const identity = `${snapshot.ownerType}:${snapshot.ownerId}/${snapshot.channel}`;
  const scope = {
    classification: "owner" as const,
    page: primaryPageForOwner(snapshot.ownerType),
    ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
    ownerType: snapshot.ownerType,
    ownerId: snapshot.ownerId,
    channel: snapshot.channel
  };
  const shared = {
    dedupeKey: `quick-analysis:${snapshot.runId}`,
    operation: "quickAnalysis.run",
    operationLabel: "Quick Analysis",
    scope,
    details: [
      `Owner/channel: ${identity}`,
      `Run: ${snapshot.runId}`,
      `Phase: ${snapshot.phase}`,
      ...(snapshot.conversationId ? [`Conversation: ${snapshot.conversationId}`] : []),
      ...(snapshot.quickAnalysisCallAttemptIds.length > 0
        ? [`Quick CallAttempts: ${snapshot.quickAnalysisCallAttemptIds.join(", ")}`]
        : []),
      ...(snapshot.candidateFileRefId
        ? [`Candidate FileRef: ${snapshot.candidateFileRefId}`]
        : []),
      ...(snapshot.outputIncompleteNotice
        ? ["Provider reported a truncated response; the nonempty body was preserved as a candidate for review."]
        : [])
    ]
  };
  if (
    snapshot.terminalState === "SUCCEEDED" &&
    snapshot.candidateFileRefId &&
    snapshot.candidateTerminalCommitState === "POST_PUBLISH_READBACK_CONFIRMED"
  ) {
    return {
      ...shared,
      severity: "success",
      title: "AI分析完成，已创建候选文稿。",
      details: []
    };
  }
  if (snapshot.terminalState === "TERMINAL_EFFECT_OUTCOME_UNKNOWN") {
    return {
      ...shared,
      severity: "warning",
      title: "AI分析候选发布结果不确定，已停止自动重试。",
      summary: projectQuickAnalysisFailureSummary(snapshot),
      reason: snapshot.errorCode
    };
  }
  return {
    ...shared,
    severity: "error",
    title: "AI分析未完成，未确认候选文稿闭环。",
    summary: projectQuickAnalysisFailureSummary({
      ...snapshot,
      errorCode: snapshot.errorCode ?? (
        snapshot.terminalState === "SUCCEEDED"
          ? "QUICK_ANALYSIS_TERMINAL_CANDIDATE_READBACK_REQUIRED"
          : undefined
      )
    }),
    reason: snapshot.errorCode ?? (
      snapshot.terminalState === "SUCCEEDED"
        ? "QUICK_ANALYSIS_TERMINAL_CANDIDATE_READBACK_REQUIRED"
        : undefined
    )
  };
}

/**
 * Sole presentation owner for canonical Quick Analysis run state. The owner is
 * application-scoped; page components only dispatch and render exact-owner feedback.
 */
export function createQuickAnalysisFeedbackOwner(input: {
  coordinator?: QuickAnalysisFeedbackCoordinatorPort;
  push?: (feedback: PushPageFeedbackInput) => void;
} = {}): QuickAnalysisFeedbackOwner {
  const coordinator = input.coordinator ?? quickAnalysisCoordinator;
  const push = input.push ?? pushPageFeedback;
  const lastFingerprintByRunId = new Map<string, string>();
  let unsubscribe: (() => void) | undefined;
  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = coordinator.subscribe((snapshot) => {
        const feedback = feedbackForSnapshot(snapshot);
        if (!feedback) return;
        const fingerprint = projectionFingerprint(feedback);
        if (lastFingerprintByRunId.get(snapshot.runId) === fingerprint) return;
        lastFingerprintByRunId.set(snapshot.runId, fingerprint);
        push(feedback);
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}

const applicationQuickAnalysisFeedbackOwner = createQuickAnalysisFeedbackOwner();
let applicationInstallCount = 0;

export function installQuickAnalysisFeedbackOwner() {
  applicationInstallCount += 1;
  if (applicationInstallCount === 1) {
    applicationQuickAnalysisFeedbackOwner.start();
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    applicationInstallCount = Math.max(0, applicationInstallCount - 1);
    if (applicationInstallCount === 0) {
      applicationQuickAnalysisFeedbackOwner.stop();
    }
  };
}
