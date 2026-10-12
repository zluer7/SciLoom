import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ModalPortal } from "../common/ModalPortal";
import { useI18n } from "../../i18n/I18nProvider";
import { getDataSourceModeSnapshot } from "../../repositories/dataSourceMode";
import { IMPORT_V1_OBJECT_TYPES, PROJECT_IMPORT_V1_MAX_BYTES, preflightProjectImportV1, type ProjectImportV1PreflightResult } from "../../services/projectImportV1Authority";
import { executeProjectImportV1, type ProjectImportV1ExecutionOutcome } from "../../services/projectImportV1Service";

export function ProjectImportTechnicalDetails() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  return <>
    <p>{zh ? "JSON 创建新课题，不合并或覆盖。部分导入不回滚；结果不明时先核对，勿重复导入。" : "JSON creates a new Project without merging or overwriting. Partial imports are not rolled back; check uncertain results before importing again."}</p>
    <a href="/sciloom-project-import-v1-external-ai-data-organization-constraint.md" download="SciLoom-Project-Import-v1-External-AI-Data-Organization-Constraint.md" data-testid="project-import-constraint-download">{zh ? "JSON 整理说明" : "JSON preparation guide"}</a>
  </>;
}

export function ProjectImportPanel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [format, setFormat] = useState<"JSON" | "Markdown" | null>(null);
  const [preflight, setPreflight] = useState<ProjectImportV1PreflightResult | null>(null);
  const [reading, setReading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [outcome, setOutcome] = useState<ProjectImportV1ExecutionOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canceled, setCanceled] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const sequence = useRef(0);
  const submitting = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; };
  }, []);

  function closePreview() {
    if (submitting.current) return;
    sequence.current += 1;
    if (fileInputRef.current) fileInputRef.current.value = "";
    setOpen(false);
    setReading(false);
    setPreflight(null);
    setOutcome(null);
    setFileName("");
    setFormat(null);
    setError(null);
    setCanceled(true);
  }

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closePreview();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || submitting.current) return;
    const request = ++sequence.current;
    const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
    const detected = extension === "json" ? "JSON" : extension === "md" ? "Markdown" : null;
    setFileName(file.name);
    setFormat(detected);
    setOpen(true);
    setReading(false);
    setPreflight(null);
    setOutcome(null);
    setError(null);
    setCanceled(false);
    if (!detected) { setError(zh ? "无法识别此文件。请选择 Project JSON 文件。" : "Unrecognized file. Choose a Project JSON file."); return; }
    if (file.size > PROJECT_IMPORT_V1_MAX_BYTES) { setError(zh ? "文件超过导入大小上限。" : "The file exceeds the import size limit."); return; }
    setReading(true);
    try {
      const text = await file.text();
      if (!mounted.current || request !== sequence.current) return;
      if (detected === "Markdown") {
        // The existing Demo is a research dossier, not a canonical Project data protocol.
        // Recognize the carrier without routing it to the JSON parser or inventing a writer.
        setError(zh ? "已识别 Markdown；当前没有已确认的 Project Markdown 导入格式。请使用 Project Import v1 JSON。" : "Markdown recognized; no confirmed Project Markdown import format is available. Use Project Import v1 JSON.");
        return;
      }
      const mode = getDataSourceModeSnapshot();
      setPreflight(preflightProjectImportV1(text, { selectedMode: mode.selectedMode, effectiveMode: mode.effectiveMode }));
    } catch {
      if (mounted.current && request === sequence.current) setError(zh ? "文件读取失败，未写入数据。请重试。" : "File could not be read; no data was written. Try again.");
    } finally {
      if (mounted.current && request === sequence.current) setReading(false);
    }
  }

  async function confirmImport() {
    if (!preflight?.ok || outcome || submitting.current || reading) return;
    const request = sequence.current;
    submitting.current = true;
    setExecuting(true);
    try {
      const mode = getDataSourceModeSnapshot();
      const result = await executeProjectImportV1(preflight, { confirmed: true, selectedMode: mode.selectedMode, effectiveMode: mode.effectiveMode });
      if (mounted.current && request === sequence.current) setOutcome(result);
    } catch {
      if (mounted.current && request === sequence.current) {
        setError(zh ? "导入结果待核对；请查看正式记录，勿重复导入。" : "Import outcome needs review. Check saved records before importing again.");
        // An unexpected failure cannot establish that no CREATE committed. Block replay.
        setPreflight(null);
      }
    } finally {
      submitting.current = false;
      if (mounted.current && request === sequence.current) setExecuting(false);
    }
  }

  return <section className="settings-data-row project-import-v1" data-project-import-v1="true" aria-label={zh ? "导入 Project" : "Import Project"}>
    <span className="settings-data-row__label" id="project-import-file-label">{zh ? "导入 Project" : "Import Project"}</span>
    <div className="settings-data-row__controls">
      <button className="secondary-button" data-testid="project-import-choose-file" type="button" disabled={reading || executing}
        aria-describedby="project-import-file-label" onClick={() => fileInputRef.current?.click()}>{zh ? "选择文件" : "Choose file"}</button>
      <span className="project-import-v1__help">
        <button className="project-import-v1__help-button" type="button" aria-describedby="project-import-help-tooltip" aria-label={zh ? "导入提示" : "Import guidance"}>?</button>
        <span className="project-import-v1__help-tooltip" id="project-import-help-tooltip" role="tooltip"><ProjectImportTechnicalDetails /></span>
      </span>
    </div>
    <input className="project-import-v1__native-file-input" data-testid="project-import-file" ref={fileInputRef} type="file" accept="application/json,.json,text/markdown,.md" tabIndex={-1}
      aria-label={zh ? "选择 Project 文件" : "Select Project file"} disabled={reading || executing} onChange={event => void selectFile(event)} />
    {canceled ? <p className="settings-data-row__message" role="status" data-testid="project-import-canceled">{zh ? "已关闭导入。" : "Import closed."}</p> : null}
    {open ? <ModalPortal>
      <div className="modal-backdrop operation-confirm-backdrop">
        <section ref={dialogRef} className="operation-confirm-dialog project-import-dialog" role="dialog" aria-modal="true" aria-labelledby="project-import-preview-title" tabIndex={-1}>
          <header className="operation-confirm-header"><h2 id="project-import-preview-title">{zh ? "导入 Project" : "Import Project"}</h2></header>
          <p>{zh ? "格式：" : "Format: "}{format ?? (zh ? "未知" : "Unknown")} · {fileName}</p>
          {reading ? <p role="status">{zh ? "正在读取…" : "Reading…"}</p> : null}
          {error ? <p role="alert" data-testid="project-import-selection-error">{error}</p> : null}
          {preflight && !preflight.ok ? <div role="alert" data-testid="project-import-preflight-errors">
            <p>{zh ? "文件内容无法导入，未写入数据。" : "File contents cannot be imported; no data was written."}</p>
            <ul>{preflight.issues.slice(0, 5).map((entry, index) => <li key={index}>{entry.path}: {entry.message}</li>)}</ul>
          </div> : null}
          {preflight?.ok && !outcome ? <div data-testid="project-import-preview">
            <p>{zh ? "课题：" : "Project: "}<strong>{preflight.preview.projectTitle}</strong></p>
            <p>{zh ? "将创建：" : "Will create: "}{IMPORT_V1_OBJECT_TYPES.filter(type => preflight.preview.objectCounts[type] > 0).map(type => `${preflight.preview.objectCounts[type]} ${type[0].toUpperCase()}${type.slice(1)}`).join(" / ")}</p>
            <p>{zh ? "创建新课题，不合并或覆盖。" : "Create a new Project without merging or overwriting."}</p>
            {preflight.warnings.length ? <details data-testid="project-import-preflight-warnings"><summary>{zh ? `跳过 ${preflight.preview.skippedCounts.fields} 字段 / ${preflight.preview.skippedCounts.objects} 对象 / ${preflight.preview.skippedCounts.relations} 关系` : `Omitted: ${preflight.preview.skippedCounts.fields} fields / ${preflight.preview.skippedCounts.objects} objects / ${preflight.preview.skippedCounts.relations} relations`}</summary>
              <ul>{preflight.warnings.map((warning, index) => <li key={index}>{warning.path}: {warning.message}</li>)}</ul>
            </details> : null}
          </div> : null}
          {outcome ? <div aria-live="polite" data-testid="project-import-outcome">
            <p><strong>{outcome.status.toUpperCase()}</strong>{outcome.project ? ` · ${outcome.project.title}` : ""}</p>
            <p>{zh ? `已确认创建 ${outcome.created.length} 个对象、${outcome.createdRelationCount} 条关系。` : `${outcome.created.length} objects and ${outcome.createdRelationCount} relations read back.`}</p>
            {outcome.status !== "success" ? <p>{zh ? "请核对已创建记录；部分导入不回滚，勿直接重复导入。" : "Check saved records; partial imports are not rolled back. Do not immediately import again."}</p> : null}
            {outcome.failedAt ? <p role="alert">{outcome.failedAt.type}{outcome.failedAt.ref ? `/${outcome.failedAt.ref}` : ""}: {outcome.failedAt.message}</p> : null}
            {outcome.warnings.length ? <details><summary>{zh ? "导入提示" : "Import notices"}</summary>{outcome.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details> : null}
          </div> : null}
          <footer className="operation-confirm-actions">
            <button className="secondary-button" data-testid="project-import-cancel" type="button" onClick={closePreview} disabled={executing}>{outcome ? (zh ? "关闭" : "Close") : (zh ? "取消" : "Cancel")}</button>
            {preflight?.ok && !outcome && !error ? <button className="primary-button" data-testid="project-import-confirm" type="button" onClick={() => void confirmImport()} disabled={reading || executing}>{executing ? (zh ? "导入中…" : "Importing…") : (zh ? "确认导入" : "Confirm import")}</button> : null}
          </footer>
        </section>
      </div>
    </ModalPortal> : null}
  </section>;
}
