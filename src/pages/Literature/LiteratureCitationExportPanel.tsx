import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  CitationExportPreflightError,
  literatureCitationExportService,
  type CitationExportIssue,
  type PreparedCitationExport
} from "../../services/literatureCitationExportService";
import type { Literature } from "../../types/literature";

type Props = { literature: Pick<Literature, "id" | "title"> };

export function LiteratureCitationExportPanel({ literature }: Props) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [open, setOpen] = useState(false);
  const [prepared, setPrepared] = useState<PreparedCitationExport | null>(null);
  const [issues, setIssues] = useState<CitationExportIssue[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    requestSequence.current += 1;
    inFlight.current = false;
    setOpen(false);
    setPrepared(null);
    setIssues([]);
    setMessage("");
    setBusy(false);
    return () => { requestSequence.current += 1; };
  }, [literature.id]);

  async function prepare() {
    if (inFlight.current) return;
    const sequence = ++requestSequence.current;
    inFlight.current = true;
    setOpen(true);
    setBusy(true);
    setPrepared(null);
    setIssues([]);
    setMessage("");
    try {
      const result = await literatureCitationExportService.prepare([literature.id]);
      if (sequence !== requestSequence.current) return;
      setPrepared(result);
      setIssues(result.issues);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      if (error instanceof CitationExportPreflightError) setIssues(error.issues);
      setMessage(zh ? "导出预检失败，未准备保存文件。" : "Export preflight failed; no file was prepared.");
    } finally {
      if (sequence === requestSequence.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function save() {
    if (inFlight.current || !prepared) return;
    const frozen = prepared;
    const sequence = ++requestSequence.current;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await literatureCitationExportService.save(frozen);
      if (sequence !== requestSequence.current) return;
      setMessage(result.saved
        ? (zh ? `已保存 CSL JSON 文件：${result.filePath}` : `CSL JSON file saved: ${result.filePath}`)
        : (zh ? "已取消保存；没有导出文件。" : "Save cancelled; no citation file was exported."));
    } catch {
      if (sequence === requestSequence.current) setMessage(zh ? "保存失败，未报告文件已保存。请检查保存位置后重试。" : "Save failed; no saved file was reported. Check the save location and try again.");
    } finally {
      if (sequence === requestSequence.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  const missing = [...new Set(issues.filter(issue => issue.kind === "missing").map(issue => issue.field))];
  const omitted = [...new Set(issues.filter(issue => issue.kind === "unsupported").map(issue => issue.field))];

  return <>
    <button className="primary-page-action primary-page-action--secondary" type="button" disabled={busy} onClick={() => void prepare()}>
      {zh ? "导出引用…" : "Export citation…"}
    </button>
    {open ? <div className="literature-editor-backdrop">
      <section className="literature-editor-shell literature-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="literature-citation-export-title">
        <header className="literature-editor-header">
          <h2 id="literature-citation-export-title">{zh ? "导出引用" : "Export citation"}</h2>
          <button className="literature-editor-close-button" type="button" disabled={busy} onClick={() => setOpen(false)} aria-label={zh ? "关闭" : "Close"}>×</button>
        </header>
        <strong>{literature.title}</strong>
        <p>{zh ? "CSL JSON · 仅书目信息，不含 PDF 或笔记正文。" : "CSL JSON · Bibliographic metadata only; no PDF or note bodies."}</p>
        {busy ? <p role="status">{zh ? "正在处理…" : "Working…"}</p> : null}
        {prepared ? <p role="status">{zh ? "预检通过；保存本次固定内容。" : "Preflight passed; save this prepared content."}</p> : null}
        {missing.length ? <p>{zh ? "缺失字段：" : "Missing fields: "}{missing.join(", ")}</p> : null}
        {omitted.length ? <p>{zh ? "已省略：" : "Omitted: "}{omitted.join(", ")}</p> : null}
        {issues.some(issue => issue.kind === "invalid") ? <p role="alert">{zh ? "书目字段无效，请核对后重试。" : "Invalid bibliographic fields; check and try again."}</p> : null}
        <button className="primary-page-action primary-page-action--primary" data-testid="citation-export-save" type="button" disabled={busy || !prepared} onClick={() => void save()}>
          {zh ? "另存为 CSL JSON…" : "Save CSL JSON as…"}
        </button>
        {message ? <p role="status">{message}</p> : null}
      </section>
    </div> : null}
  </>;
}
