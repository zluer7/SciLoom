import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { OutputSourceCard } from "../../types";
import { outputEvidenceExportPresentationService as service, type OutputEvidenceIdentity, type OutputEvidenceView } from "../../services/outputEvidenceExportPresentationService";

export function OutputEvidenceExportPanel({ identity, revision, presentedSourceCards, sourceDetails, children }: { identity: OutputEvidenceIdentity; revision: string; presentedSourceCards?: readonly OutputSourceCard[]; sourceDetails?: ReactNode; children?: (evidence: ReactNode, action: ReactNode) => ReactNode }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const copy = (cn: string, en: string) => zh ? cn : en;
  const token = `${identity.layer}:${identity.id}:${identity.projectId}:${revision}`;
  const current = useRef(token); current.current = token;
  const generation = useRef(0);
  const busyRef = useRef(false);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<{ token: string; data: OutputEvidenceView } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const request = ++generation.current;
    setView(null); setMessage(""); setBusy(false); busyRef.current = false;
    service.read(identity).then(data => {
      if (generation.current === request && current.current === token) setView({ token, data });
    }).catch(() => {
      if (generation.current === request && current.current === token) setMessage(copy("依据读取失败，请重新读取。", "Evidence could not be read. Retry reading."));
    });
    return () => { generation.current++; };
  }, [token, reload, language]);
  const data = view?.token === token ? view.data : null;
  // Deduplicate only the identical projection. A newer/different source read
  // retains its own details instead of silently disappearing behind an old card.
  const additionalCards = data?.cards.filter(card => !presentedSourceCards?.some(presented =>
    JSON.stringify(presented) === JSON.stringify(card))) ?? [];
  async function save() {
    if (!data?.exportAllowed || busyRef.current || !service.isDesktop()) return;
    const request = generation.current;
    const selected = token;
    busyRef.current = true; setBusy(true); setMessage("");
    try {
      const prepared = await service.prepare(identity);
      if (generation.current !== request || current.current !== selected) return;
      const result = await service.save(prepared);
      if (generation.current === request && current.current === selected) {
        setMessage(result.saved && result.filePath ? copy("Markdown 已保存。", "Markdown saved.") :
          result.saved ? copy("保存结果未确认。", "Save result unconfirmed.") : copy("已取消保存。", "Save cancelled."));
      }
    } catch {
      if (generation.current === request && current.current === selected) setMessage(copy("未能完成导出；请重新读取后再试。", "Export could not be completed. Read again before retrying."));
    } finally {
      if (generation.current === request && current.current === selected) {
        busyRef.current = false; setBusy(false);
      }
    }
  }
  const available = (value: string) => value === "available" ? copy("可用", "Available") : value === "unavailable" ? copy("读取失败", "Could not be read") : copy("缺失或已删除", "Missing or deleted");
  const action = <button type="button" className="outputs-formal-edit-button secondary-button primary-page-action primary-page-action--secondary" title={copy("Markdown · 当前对象摘要，不含正文", "Markdown · Current object summaries, no bodies")} data-testid="output-export-markdown" disabled={busy || !data?.exportAllowed || !service.isDesktop()} onClick={() => { void save(); }}>{busy ? copy("正在导出…", "Exporting…") : copy("导出", "Export")}</button>;
  const evidence = <div className="evidence-convergence" data-testid="output-evidence-export" aria-label={copy("成果依据与导出", "Output evidence and export")}>
    {message ? <p role={data ? "status" : "alert"}>{message}</p> : null}
    {data && (data.relationsUnavailable || data.relations.some(r => r.availability !== "available") || data.cards.some(card => card.sourceStatus === "missing" || card.warning)) ? <p role="alert">{copy("关联或来源存在缺失 / 读取提示，请展开核对。", "Relations or sources have missing/read notices. Expand to inspect.")}</p> : null}
    {data && !data.exportAllowed ? <p className="evidence-notice">{copy("当前生命周期或读取状态不支持导出。", "Export unavailable for the current lifecycle or read state.")}</p> : null}
    <details data-testid="output-evidence-disclosure"><summary>{copy("查看来源详情", "View source details")}</summary>
    {sourceDetails}
    <p>{copy("来源与直接转换分别记录，不代表完整历史。", "Sources and direct conversions are separate records, not a complete history.")}</p>
    {data ? <>
      <h4>{copy("转换关系", "Conversion relations")}</h4>
      {data.relationsUnavailable ? <p>{copy("关系读取失败，数量未知。", "Relations could not be read; count is unknown.")}</p> : data.relations.length ? <ul>{data.relations.map(r => <li key={`${r.id}:${r.direction}`}>
        {r.direction === "incoming" ? copy("入向", "Incoming") : copy("出向", "Outgoing")} · {r.relationType} · {r.counterpartType} · {r.targetTitle || copy("无可用标题", "Title unavailable")} · {available(r.availability)}
      </li>)}</ul> : <p>{copy("没有已记录转换关系。", "No conversion relations recorded.")}</p>}
      {presentedSourceCards && !additionalCards.length ? null : <>      <h4>{copy("来源关系", "Source relations")}</h4>
      {additionalCards.length ? <ul>{additionalCards.map(card => <li key={card.id}>
        {copy("来源 → 当前对象", "Source → current object")} · {card.sourceType} · {card.relationType} · {card.sourceTitle === `${card.sourceType}:${card.sourceId ?? "manual"}` ? copy("无可用标题", "Title unavailable") : card.sourceTitle} · {available(card.warning?.includes("failed to resolve") ? "unavailable" : card.sourceStatus === "missing" ? "missing" : "available")}
        {card.sourceStatus === "missing" || card.sourceType === "other" ? copy("（已存标题）", " (saved title)") : ""}
        {card.sourceNote ? <p>{card.sourceNote}</p> : null}
        {card.sourceSummarySnapshot ? <p>{card.sourceSummarySnapshot}</p> : null}
      </li>)}</ul> : <p>{copy("没有已记录来源关系。", "No source relations recorded.")}</p>}
</>}
    </> : <p role="status">{message ? copy("依据不可用。", "Evidence unavailable.") : copy("正在读取依据…", "Reading evidence…")}</p>}
    <h4>{copy("Markdown 导出范围", "Markdown export scope")}</h4>
    <p>{copy("当前单个对象的元数据、结构化摘要、直接转换关系及文件路径摘要。沿用现有文本长度与格式规则；不含来源卡片、递归证据链、正文、附件二进制、完整系统路径或完整备份。", "One current object: metadata, structured summary, direct conversion relations and file path summaries. Existing text length and formatting rules apply. Source cards, recursive chains, bodies, attachment binaries, full system paths and a complete backup are excluded.")}</p>
    <p>{copy("保存前重新读取并固定本次内容；保存对话框期间不会重新生成内容。", "Content is re-read and fixed before Save As; it is not regenerated during the dialog.")}</p>
    {data && !data.exportAllowed ? <p>{copy("当前生命周期或读取状态不支持导出；已正式化候选和归档成果不导出。", "The current lifecycle or read state does not support export. Converted candidates and archived outputs are excluded.")}</p> : null}
    {!service.isDesktop() ? <p>{copy("请在桌面应用使用另存为。", "Use Save As in the desktop app.")}</p> : null}
    <button type="button" className="outputs-formal-edit-button secondary-button" disabled={busy} onClick={() => setReload(v => v + 1)}>{copy("重新读取", "Read again")}</button>{" "}

    </details>
  </div>;
  return children ? children(evidence, action) : <>{action}{evidence}</>;
}
