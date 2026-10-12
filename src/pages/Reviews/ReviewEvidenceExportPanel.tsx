import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Review } from "../../types";
import type { ReviewAiContext, ReviewAiEvidenceLine } from "../../types/planningContext";
import { useI18n } from "../../i18n/I18nProvider";
import { reviewEvidenceExportPresentationService as service } from "../../services/reviewEvidenceExportPresentationService";

export function ReviewEvidenceExportPanel({ review, refreshKey = 0, children }: { review: Review; refreshKey?: number; children?: (evidence: ReactNode, action: ReactNode) => ReactNode }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const label = (cn: string, en: string) => zh ? cn : en;
  const [context, setContext] = useState<ReviewAiContext>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [requested, setRequested] = useState(false);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const [retry, setRetry] = useState(0);

  function errorText(cause: unknown) {
    const code = cause instanceof Error ? cause.message : "";
    if (code === "review_changed") return label("Review 已变化，请刷新详情后重试。", "Review changed. Refresh the detail and try again.");
    if (code === "review_unavailable") return label("Review 已不存在或不可用。", "Review no longer exists or is unavailable.");
    return label("读取或保存失败；未报告成功。请检查来源或保存位置后重试。", "Read or save failed; no success was reported. Check the sources or save location before retrying.");
  }

  useEffect(() => {
    const token = ++generation.current;
    setContext(undefined);
    setError("");
    setMessage("");
    setLoading(requested);
    setSaving(false); busyRef.current = false;
    if (!requested) return () => { ++generation.current; };
    service.read(review).then((value) => {
      if (generation.current === token) setContext(value);
    }).catch((cause) => {
      if (generation.current === token) setError(errorText(cause));
    }).finally(() => {
      if (generation.current === token) setLoading(false);
    });
    return () => { ++generation.current; };
  }, [review, refreshKey, retry, language, requested]);

  async function exportMarkdown() {
    if (busyRef.current || saving || review.deletedAt) return;
    busyRef.current = true;
    const token = generation.current;
    setSaving(true);
    setMessage("");
    try {
      const prepared = await service.prepare(review);
      if (generation.current !== token) return;
      const result = await service.save(prepared);
      if (generation.current !== token) return;
      setMessage(result.saved
        ? result.filePath
          ? label(`已保存「${prepared.reviewTitle}」：${result.filePath}`, `Saved “${prepared.reviewTitle}”: ${result.filePath}`)
          : label("保存结果未确认。", "Save result unconfirmed.")
        : label("已取消导出，未保存文件。", "Export cancelled; no file was saved."));
    } catch (cause) {
      if (generation.current === token) setMessage(errorText(cause));
    } finally {
      if (generation.current === token) { busyRef.current = false; setSaving(false); }
    }
  }

  const typeLabels: Record<string, string> = {
    project: label("课题", "Project"), route: label("路线", "Route"), routeNode: label("路线", "Route"),
    task: label("任务", "Task"), experiment: label("实验", "Experiment"), experimentSummary: label("实验摘要", "Experiment summary"),
    experimentRun: label("实验 Run", "Experiment run"), literature: label("文献", "Literature"),
    resultItem: label("结果条目", "Result item"), finding: label("发现", "Finding"), outputCandidate: label("成果候选", "Output candidate"),
    outputGap: label("成果缺口", "Output gap"), output: label("科研成果", "Research output"), researchOutput: label("科研成果", "Research output"),
    review: "Review"
  };
  const limitationLabels: Record<string, string> = {
    missing_reference: label("部分关联来源缺失或不受支持。", "Some linked sources are missing or unsupported."),
    period_membership_not_finalized: label("时间范围仅筛选推定任务；并未完整覆盖期间所有依据。显式关联任务仍保留。", "The period filters inferred tasks only; it does not cover all evidence in the period. Explicit task targets remain included."),
    indirect_evidence_not_expanded: label("课题上下文可能包含未直接关联此 Review 的摘要。", "Project context can include summaries that are not direct targets of this Review."),
    derived_chain_not_expanded: label("成果依据只展示链条阶段摘要，不展开完整来源链。", "Output evidence contains chain-stage summaries, without the full provenance chain."),
    aggregation_wiring_deferred: label("该范围的依据汇总尚不可用。", "Evidence aggregation for this scope is not available."),
    warning_only: label("依据来源信息不可用，仅有范围提示。", "Evidence source information is unavailable; only boundary notices are available."),
    scope_boundary_unclear: label("当前来源的范围边界尚不明确。", "The current source boundary is unclear.")
  };
  const reasonLabels: Record<string, string> = {
    target_not_found: label("来源已不存在", "Source no longer exists"), unsupported_target_type: label("来源类型不受支持", "Source type is unsupported"),
    invalid_target_id: label("来源引用无效", "Source reference is invalid"), resolver_error: label("来源读取失败", "Source could not be read"),
    type_mismatch: label("来源类型不匹配", "Source type does not match")
  };
  const groups: Array<[string, ReviewAiEvidenceLine[]]> = context ? [
    [label("直接关联与课题范围", "Direct targets and project anchor"), context.directTargetEvidence],
    [label("时间范围", "Period boundary"), context.periodEvidence],
    [label("间接支持上下文", "Indirect supporting context"), context.indirectCrossModuleEvidence],
    [label("成果阶段摘要", "Output-stage summaries"), context.derivedOutputEvidence],
    [label("已有 Review 内容摘要", "Existing Review content summary"), context.existingReviewContentEvidence],
    [label("任务依据", "Task evidence"), context.taskEvidence],
    [label("实验依据", "Experiment evidence"), context.experimentEvidence],
    [label("文献依据", "Literature evidence"), context.literatureEvidence],
    [label("成果依据", "Output evidence"), context.outputEvidence]
  ] : [];

  const action = <button type="button" className="secondary-button primary-page-action primary-page-action--secondary" title={label("Markdown · 当前依据摘要，不含正文", "Markdown · Current evidence summaries, no bodies")} data-testid="review-export-markdown" disabled={saving || Boolean(review.deletedAt)} onClick={() => void exportMarkdown()}>{saving ? label("正在保存…", "Saving…") : label("导出", "Export")}</button>;
  const evidence = <div className="evidence-convergence" data-testid="review-evidence-export-panel" aria-label={label("依据范围与导出", "Evidence scope and export")}>
    {error ? <div role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>{label("重试读取", "Retry reading")}</button></div> : null}
    {context?.sourceContextMissing ? <p role="alert">{label("依据汇总不可用，数量未知。", "Evidence aggregation is unavailable; counts are unknown.")}</p>
      : context?.partial || context?.missingReferences.length || context?.warnings.length ? <p className="evidence-notice">{label("当前依据有范围或来源提示", "Current evidence has scope or source notices")} · {label("缺失", "Missing")} {context?.missingReferences.length ?? 0} · {label("提示", "Notices")} {context?.warnings.length ?? 0}</p> : null}
    {message ? <p role="status" data-testid="review-export-message">{message}</p> : null}
    <details data-testid="review-evidence-disclosure" onToggle={(event) => { if (event.currentTarget.open) setRequested(true); }}><summary>{label("查看依据详情", "View context details")}</summary>
    <p>{label("以下是当前关联与上下文，不代表生成 Review 时实际使用的历史材料。各分类可能重叠，数量不可相加。", "These are current links and context, not a record of materials used when this Review was generated. Categories may overlap; their counts cannot be added.")}</p>
    {!requested ? <p>{label("尚未读取；展开后按需读取当前上下文。", "Not requested; opening reads the current context on demand.")}</p> : null}
    {loading ? <p role="status">{label("正在读取依据…", "Loading evidence…")}</p> : error ? null : context ? <>
      {context.sourceContextMissing ? <p role="alert">{label("依据汇总不可用，数量未知。", "Evidence aggregation is unavailable; counts are unknown.")}</p> : <div data-testid="review-evidence-groups">
        {groups.map(([title, lines]) => <details key={title}>
          <summary>{title} · {lines.length}</summary>
          {lines.length ? <ul>{lines.map((line, index) => <li key={index}>
            {typeLabels[line.entityType ?? ""] ?? label("上下文来源", "Context source")} · {line.role === "missing" ? label("不可用来源", "Unavailable source") : line.sourceKind === "period_evidence" ? label("已记录的时间边界", "Recorded period boundary") : line.title}
            {line.partial ? label("（范围不完整）", " (partial scope)") : ""}
          </li>)}</ul> : <p>{label("此分类未关联或未记录依据。", "No evidence is linked or recorded in this category.")}</p>}
        </details>)}
      </div>}
      <ul data-testid="review-evidence-limitations">
        <li>{label("不读取本地文件正文、PDF 全文或实验原始数据。", "Local file bodies, PDF full text and experiment raw data are not read.")}</li>
        {context.limitations.map((item, index) => <li key={`limit-${index}`}>{limitationLabels[item.code] ?? label("当前来源存在已知范围限制。", "The current source has a known scope limitation.")}</li>)}
        {context.partialReasons.includes("inferred_task_scope") ? <li>{label("未直接关联任务，任务依据按当前课题或路线范围汇总。", "No explicit task targets; task evidence is aggregated from the current project or route scope.")}</li> : null}
        {context.partial ? <li>{label("当前汇总存在范围限制或来源提示，不代表科研质量判断。", "This aggregation has scope limitations or source notices; this is not an assessment of research quality.")}</li> : null}
        {context.warnings.length ? <li>{label(`来源服务报告 ${context.warnings.length} 项读取或范围提示；导出包含原提示。`, `Source services reported ${context.warnings.length} read or scope notices; the export includes the original notices.`)}</li> : null}
        {context.missingReferences.map((item, index) => <li key={`missing-${index}`}>{typeLabels[item.targetType] ?? label("来源", "Source")} · {reasonLabels[item.reason]}</li>)}
      </ul>
    </> : null}
    <p data-testid="review-markdown-export-scope">{label("导出当前 Review 的范围、分类依据摘要、已有内容摘要及警告/缺失，供外部阅读、AI 或写作。不会包含完整文稿、附件、PDF 全文或原始数据；不是完整项目备份。不修改 Review，也不自动上传。", "Export the current Review scope, classified evidence summaries, existing content summary, warnings and gaps for external reading, AI or writing. Full manuscripts, attachments, PDF full text and raw data are excluded. This is not a complete project backup. It does not modify the Review or upload automatically.")}</p>

    </details>
  </div>;
  return children ? children(evidence, action) : <>{action}{evidence}</>;
}
