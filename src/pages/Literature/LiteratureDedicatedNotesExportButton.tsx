import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { literatureDedicatedNotesExportService, type DedicatedNotesExportIdentity } from "../../services/literatureDedicatedNotesExportService";

export function LiteratureDedicatedNotesExportButton({ identity, scopeId, sourceRevision, disabled, hasUnsavedEdits }: {
  identity: DedicatedNotesExportIdentity;
  scopeId: string;
  sourceRevision: string;
  disabled: boolean;
  hasUnsavedEdits: boolean;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const key = JSON.stringify([identity, scopeId, sourceRevision, disabled, hasUnsavedEdits]);
  const admission = useRef({ key, generation: 0 });
  if (admission.current.key !== key) admission.current = { key, generation: admission.current.generation + 1 };
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ generation: number; error: boolean; text: string }>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; admission.current.generation += 1; };
  }, []);

  async function exportNotes() {
    if (inFlight.current || disabled || hasUnsavedEdits) return;
    const generation = admission.current.generation;
    const isCurrent = () => mounted.current && admission.current.generation === generation;
    inFlight.current = true;
    setBusy(true);
    setFeedback(undefined);
    try {
      const snapshot = await literatureDedicatedNotesExportService.prepare(identity, language);
      if (!isCurrent()) return;
      const receipt = await literatureDedicatedNotesExportService.savePrepared(snapshot, isCurrent);
      // A completed native write still belongs to receipt.snapshot. Suppress an
      // obsolete card's feedback, without relabelling that write as a cancel.
      if (!isCurrent() || receipt.status === "stale") return;
      setFeedback({ generation, error: false, text: receipt.status === "saved"
        ? (zh ? "已导出已保存的专属笔记。" : "Saved notes exported.")
        : (zh ? "已取消导出。" : "Export canceled.") });
    } catch {
      if (isCurrent()) setFeedback({ generation, error: true,
        text: zh ? "导出失败，未确认文件已保存。" : "Export failed; no saved file was confirmed." });
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <>
    <button type="button" data-testid="dedicated-notes-export" disabled={disabled || hasUnsavedEdits || busy}
      aria-busy={busy} title={hasUnsavedEdits
        ? (zh ? "请先保存或取消专属笔记修改。" : "Save or cancel note edits first.")
        : (zh ? "导出已保存的结构笔记，不含文稿正文。" : "Export saved structured notes; manuscript text is excluded.")}
      onClick={() => void exportNotes()}>{zh ? "导出" : "Export"}</button>
    {feedback && feedback.generation === admission.current.generation ?
      <span className="literature-notes-export-feedback" role={feedback.error ? "alert" : "status"}>{feedback.text}</span> : null}
  </>;
}
