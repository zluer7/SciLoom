import { useCallback, useEffect, useRef, useState } from "react";
import { OperationConfirmDialog } from "../safety/OperationConfirmDialog";
import { useOperationConfirm } from "../../hooks/useOperationConfirm";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useI18n } from "../../i18n/I18nProvider";
import { supportedRestoreService, type SupportedRestoreItem, type SupportedRestoreType } from "../../services/supportedRestoreService";

const REFRESH_KEYS = ["recycleBin.changed", "planning.changed", "task.changed", "route.changed", "review.changed", "experiment.changed", "experimentRun.changed", "literature.changed", "output.*"];
const TYPE_LABELS: Record<SupportedRestoreType, [string, string]> = {
  task: ["任务", "Task"], routeNode: ["路线", "Route"], review: ["复盘", "Review"], experiment: ["实验", "Experiment"], experimentRun: ["实验运行", "Experiment run"], literature: ["文献", "Literature"], resultItem: ["结果资产", "Result asset"], finding: ["关键发现", "Finding"], outputCandidate: ["候选成果", "Output candidate"], outputGap: ["成果缺口", "Output gap"], output: ["正式成果", "Research output"]
};

export function SupportedRecycleRestorePanel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const confirm = useOperationConfirm();
  const [items, setItems] = useState<SupportedRestoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; status: "success" | "partial" | "skipped" | "error" | "unknown" } | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const actionInFlight = useRef(false);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setReadFailed(false);
    try {
      const rows = await supportedRestoreService.list();
      if (!mounted.current || request !== generation.current) return;
      setItems(rows);
    } catch {
      if (!mounted.current || request !== generation.current) return;
      setItems([]);
      setReadFailed(true);
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; generation.current += 1; };
  }, [reload]);
  useRefreshEventReload({ pageName: "Settings Supported Restore", watchedKeys: REFRESH_KEYS, reload });

  const titleFor = (item: SupportedRestoreItem) => item.title ?? (zh ? "对象名称不可用" : "Object name unavailable");
  const effectFor = (item: SupportedRestoreItem) => item.intent === "archive_reactivation"
    ? item.entityType === "task"
      ? zh ? "取消此任务的归档，状态设为待办。保留原身份、内容和既有关联。" : "Reactivate this archived task with status To do. Keep its identity, content and existing links."
      : zh ? "取消此路线的归档，状态设为计划中。保留原身份、内容和既有关联。" : "Reactivate this archived route with status Planned. Keep its identity, content and existing links."
    : zh ? "恢复此对象的软删除元数据。保留原身份；不重建已丢失的关联，不恢复其他对象或本地文件。已有归档或父对象限制仍适用。" : "Restore this object's soft-deleted metadata with its existing identity. Missing links, other objects and local files are not restored. Existing archive or parent restrictions still apply.";

  async function handleRestore(item: SupportedRestoreItem) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setResult(null);
    const title = titleFor(item);
    try {
      const prepared = await supportedRestoreService.prepare(item);
      if (!mounted.current) return;
      const accepted = await confirm.requestConfirmation(supportedRestoreService.confirmationPreview(prepared, {
        title, summary: effectFor(item), warning: zh ? "仅恢复此对象的已支持状态；不读取、移动或改写本地文件。" : "Restore only this object's supported state. Local files are not read, moved or rewritten.",
        confirmLabel: zh ? "确认恢复" : "Confirm restore", cancelLabel: zh ? "取消" : "Cancel"
      }));
      if (!accepted || !mounted.current) return;
      const outcome = await supportedRestoreService.execute(prepared, true);
      if (!mounted.current) return;
      setResult({ title, status: outcome.status });
      // A later read failure has its own state and cannot overwrite this result.
      await reload();
    } catch (error) {
      if (!mounted.current) return;
      setResult({ title, status: error instanceof Error && error.message === "SUPPORTED_RESTORE_STATE_CHANGED" ? "skipped" : "unknown" });
      await reload();
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const resultText = result?.status === "success" ? zh ? "恢复已确认成功。" : "Restore confirmed successful."
    : result?.status === "partial" ? zh ? "恢复返回部分成功；请核对当前状态，后续事项未全部完成。" : "Restore returned partial success. Check the current state; follow-up work is incomplete."
    : result?.status === "skipped" ? zh ? "当前状态已变化或恢复未执行，请刷新后核对。" : "The state changed or restore was skipped. Refresh and check the current state."
    : result?.status === "error" ? zh ? "恢复返回错误，请先核对当前状态。" : "Restore returned an error. Check the current state first."
    : zh ? "恢复结果尚未确认，请先刷新核对当前状态；不会自动重试恢复。" : "Restore outcome is unconfirmed. Refresh to check the current state; restore will not retry automatically.";

  return (
    <section className="settings-panel settings-primary-section settings-supported-restore" data-settings-top-level="supported-restore" aria-labelledby="supported-restore-title">
      <div className="settings-primary-section__title operation-center-heading">
        <h2 id="supported-restore-title">{zh ? "最近删除 / 可恢复" : "Recently deleted / Restorable"}</h2>
        <button type="button" className="secondary-button" onClick={() => void reload()} disabled={loading || busy}>{zh ? "刷新列表" : "Refresh list"}</button>
      </div>
      <div className="settings-primary-section__body">
      <p>{zh ? "最多 50 个受支持对象；不恢复永久删除或本地文件。" : "Up to 50 supported objects; permanent deletions and local files cannot be restored."}</p>
      {result ? <p role="status" data-testid="supported-restore-result">{result.title} · {resultText}</p> : null}
      {loading ? <p aria-live="polite">{zh ? "正在读取可恢复对象…" : "Loading restorable objects…"}</p> : null}
      {!loading && readFailed ? <p role="alert">{zh ? "列表暂时无法读取，请刷新列表。这是读取失败，不会重试恢复或改变已确认的恢复结果。" : "The list could not be read. Refresh the list. This read failure does not retry restore or change a confirmed restore result."}</p> : null}
      {!loading && !readFailed && !items.length ? <p>{zh ? "当前支持范围内暂无可恢复对象。" : "No restorable objects are available in the supported scope."}</p> : null}
      {!loading && !readFailed ? <div className="operation-center-list">
        {items.map(item => (
          <article className="operation-deleted-item" key={item.key} data-restore-row={item.key}>
            <div className="operation-center-item-head"><strong>{titleFor(item)}</strong><span>{TYPE_LABELS[item.entityType][zh ? 0 : 1]}</span></div>
            <p>{item.intent === "archive_reactivation" ? zh ? "已归档" : "Archived" : zh ? "已软删除" : "Soft-deleted"} · {item.occurredAt && !Number.isNaN(Date.parse(item.occurredAt)) ? <time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time> : zh ? "时间不可用" : "Time unavailable"}</p>
            <p>{effectFor(item)}</p>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void handleRestore(item)}>{zh ? "恢复" : "Restore"}</button>
          </article>
        ))}
      </div> : null}
      <OperationConfirmDialog preview={confirm.preview} onConfirm={confirm.confirm} onCancel={confirm.cancel} />
      </div>
    </section>
  );
}
