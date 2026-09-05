import type { QuickAnalysisRunSnapshot } from "./quickAnalysisCoordinator";

type QuickAnalysisFailureSnapshot = Pick<
  QuickAnalysisRunSnapshot,
  "errorCode" | "errorMessage"
>;

/**
 * Projects durable Quick Analysis diagnostics into concise primary-page copy.
 * The coordinator snapshot remains the technical source of truth; this helper
 * deliberately never interpolates provider codes or raw transport messages.
 */
export function projectQuickAnalysisFailureSummary(
  snapshot: QuickAnalysisFailureSnapshot
) {
  if (snapshot.errorCode === "QUICK_ANALYSIS_SCOPE_UNAVAILABLE") {
    return "AI生成未开始：当前对象没有可用于本次分析的课题，请先确认课题关联。";
  }
  if (snapshot.errorCode === "QUICK_ANALYSIS_PROJECT_UNAVAILABLE") {
    return "AI生成未开始：所选课题当前不可用，请重新选择课题后再试。";
  }
  if (snapshot.errorCode === "QUICK_ANALYSIS_SCOPE_MISMATCH") {
    return "AI生成未开始：当前课题与对象的正式关联不一致，请确认关联后再试。";
  }
  if (
    snapshot.errorCode === "QUICK_ANALYSIS_TERMINAL_CANDIDATE_READBACK_REQUIRED"
  ) {
    return "AI分析已停止：候选文稿的写入结果未能安全确认，请先检查本页状态。";
  }
  if (snapshot.errorCode === "TERMINAL_EFFECT_OUTCOME_UNKNOWN") {
    return "AI分析结果暂时无法确认，系统已停止自动重试；请先检查本页状态。";
  }

  const technicalText = `${snapshot.errorCode ?? ""} ${snapshot.errorMessage ?? ""}`;
  if (
    /auth|credential|api.?key|permission|unauthorized|forbidden|invalid_request_error|\b40[13]\b|deepseek/iu.test(
      technicalText
    )
  ) {
    return "AI 服务暂时无法使用，请检查当前模型配置或稍后重试。";
  }
  if (/timeout|timed out|network|connection|fetch|离线|网络|连接/iu.test(technicalText)) {
    return "AI 服务连接未完成，请检查网络后重试。";
  }
  return "AI 分析未完成，请稍后重试；如持续失败，请检查 AI 设置。";
}
