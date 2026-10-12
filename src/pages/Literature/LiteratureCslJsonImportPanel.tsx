import { useRef, useState, type ChangeEvent } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  CSL_JSON_IMPORT_MAX_BYTES,
  preflightLiteratureCslJson,
  type CslImportPreflight
} from "../../services/literatureCslJsonImport";
import {
  executeLiteratureCslJsonImport,
  type CslImportExecutionResult
} from "../../services/literatureCslJsonImportExecution";

type Props = {
  onCommitted: (createdIds: string[]) => Promise<void>;
};

export function LiteratureCslJsonImportPanel({ onCommitted }: Props) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const picker = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<CslImportPreflight | null>(null);
  const [outcome, setOutcome] = useState<CslImportExecutionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || submitting.current) return;
    setFileName(file.name);
    setPreflight(null);
    setOutcome(null);
    setError(null);
    setRefreshError(null);
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError(zh ? "请选择 .json 文件。" : "Select a .json file.");
      return;
    }
    if (file.size > CSL_JSON_IMPORT_MAX_BYTES) {
      setError(zh ? "文件超过 2 MiB 上限。" : "The file exceeds the 2 MiB limit.");
      return;
    }
    setBusy(true);
    try {
      setPreflight(preflightLiteratureCslJson(await file.text()));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
    } finally {
      setBusy(false);
    }
  }

  function cancelPreview() {
    if (submitting.current || busy) return;
    setPreflight(null);
    setOutcome(null);
    setFileName(null);
    setError(null);
    setRefreshError(null);
  }

  async function confirm() {
    if (!preflight?.ok || outcome || submitting.current || busy) return;
    submitting.current = true;
    setBusy(true);
    try {
      const result = await executeLiteratureCslJsonImport(preflight.entries);
      setOutcome(result);
      if (result.createdIds.length) {
        try {
          await onCommitted(result.createdIds);
        } catch (cause) {
          setRefreshError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    } catch (cause) {
      // An unexpected submit error cannot prove that no CREATE committed.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const ready = preflight?.ok
    ? preflight.entries.filter((entry) => entry.input).length
    : 0;

  return (
    <>
        <button
          className="literature-primary-action-button primary-page-action"
          disabled={busy}
          onClick={() => picker.current?.click()}
          type="button"
        >{zh ? "导入…" : "Import…"}</button>
        <input
          accept="application/json,.json"
          aria-label={zh ? "选择 CSL JSON 文件" : "Select CSL JSON file"}
          className="project-import-v1__native-file-input"
          onChange={(event) => void chooseFile(event)}
          ref={picker}
          type="file"
        />
      {fileName ? <div className="literature-editor-backdrop">
        <section className="literature-editor-shell literature-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="literature-csl-import-title">
          <header className="literature-editor-header">
            <h2 id="literature-csl-import-title">{zh ? "导入 CSL JSON" : "Import CSL JSON"}</h2>
            <button className="literature-editor-close-button" disabled={busy} onClick={cancelPreview} type="button" aria-label={zh ? "关闭" : "Close"}>×</button>
          </header>
      {fileName ? <p>{zh ? "已选文件：" : "Selected file: "}<strong>{fileName}</strong></p> : null}
      {busy ? <p role="status">{zh ? "正在处理…" : "Processing…"}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {refreshError ? <p role="alert">{zh ? "已创建对象，但列表刷新失败：" : "Items were created, but list refresh failed: "}{refreshError}</p> : null}
      {preflight && !preflight.ok ? <p role="alert">{preflight.message}</p> : null}
      {preflight?.ok ? (
        <div className="literature-csl-import__preview" data-testid="literature-csl-preview">
          <h3>{zh ? "导入预览" : "Import preview"}</h3>
          <p>{zh
            ? `将创建 ${ready} 条；不可导入 ${preflight.entries.length - ready} 条。不合并、不查重。`
            : `${ready} to create; ${preflight.entries.length - ready} invalid. No merging or deduplication.`}</p>
          <ol>
            {preflight.entries.map((entry) => (
              <li key={entry.index}>
                <strong>{entry.index + 1}. {entry.title}</strong>
                <span> — {entry.status === "invalid"
                  ? (zh ? "不可导入" : "Invalid")
                  : entry.status === "warning"
                    ? (zh ? "有提示，可导入" : "Importable with warnings")
                    : (zh ? "可导入" : "Ready")}</span>
                {entry.input ? (
                  <p>{[
                    entry.input.authors?.map((author) => author.name).join("、"),
                    entry.input.year,
                    entry.input.publicationType,
                    entry.input.venue,
                    entry.input.doi,
                    entry.input.url
                  ].filter(Boolean).join(" · ")}</p>
                ) : null}
                {[...entry.errors, ...entry.warnings].length ? (
                  <ul>{[...entry.errors, ...entry.warnings].map((message, index) => (
                    <li key={index}>{message}</li>
                  ))}</ul>
                ) : null}
              </li>
            ))}
          </ol>
          {!outcome ? (
            <div className="literature-csl-import__actions">
              <button disabled={busy} onClick={cancelPreview} type="button">{zh ? "取消" : "Cancel"}</button>
              <button className="literature-primary-action-button primary-page-action primary-page-action--primary"
                disabled={busy || ready === 0} onClick={() => void confirm()} type="button"
              >{zh ? `确认创建 ${ready} 条文献` : `Confirm creation of ${ready} items`}</button>
            </div>
          ) : (
            <div data-testid="literature-csl-result">
              <h3>{zh ? "实际创建结果" : "Creation result"}</h3>
              <ul>{outcome.items.map((item) => (
                <li key={item.index}>
                  {item.index + 1}. {item.title} — {item.status}
                  {item.literatureId ? ` · ID: ${item.literatureId}` : ""}
                  {item.message ? ` · ${item.message}` : ""}
                </li>
              ))}</ul>
              <p>{zh
                ? "待核对项请先查看正式记录，勿重复导入。"
                : "Check pending-review items against saved records before importing again."}</p>
            </div>
          )}
        </div>
      ) : null}
        </section>
      </div> : null}
    </>
  );
}
