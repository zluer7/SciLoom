import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useI18n } from "../../i18n/I18nProvider";
import {
  businessOperationPresentation,
  projectBusinessOperationLogEntry,
  type BusinessOperationHistoryEntry
} from "../../services/businessOperationFeedbackService";
import { listOperationLogs } from "../../services/operationLogService";

const BUSINESS_OPERATION_HISTORY_REFRESH_KEYS = ["operationLog.changed"];
const BUSINESS_OPERATION_HISTORY_READ_LIMIT = 50;
const BUSINESS_OPERATION_HISTORY_DISPLAY_LIMIT = 20;

function formatDate(value: string, unavailable: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? unavailable : date.toLocaleString();
}

export function BusinessOperationHistoryPanel() {
  const { language } = useI18n();
  const [entries, setEntries] = useState<BusinessOperationHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setIsLoading(true);
    setLoadFailed(false);
    try {
      const logs = await listOperationLogs({ limit: BUSINESS_OPERATION_HISTORY_READ_LIMIT });
      if (!mounted.current || request !== generation.current) return;
      setEntries(
        logs
          .map(projectBusinessOperationLogEntry)
          .filter((entry): entry is BusinessOperationHistoryEntry => Boolean(entry))
          .slice(0, BUSINESS_OPERATION_HISTORY_DISPLAY_LIMIT)
      );
    } catch {
      if (!mounted.current || request !== generation.current) return;
      setEntries([]);
      setLoadFailed(true);
    } finally {
      if (mounted.current && request === generation.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [reload]);

  useRefreshEventReload({
    pageName: "Settings Business Operation History",
    watchedKeys: BUSINESS_OPERATION_HISTORY_REFRESH_KEYS,
    reload
  });

  const copy = useMemo(() => language === "zh-CN"
    ? {
        title: "用户操作记录",
        loading: "正在读取用户操作记录…",
        scope: "最近 50 条日志中的用户操作 · 最多显示 20 条",
        empty: "暂无用户操作记录。",
        failed: "用户操作记录暂时无法读取，请刷新记录。",
        refresh: "刷新记录",
        missingTitle: "对象名称不可用",
        missingTime: "时间不可用"
      }
    : {
        title: "User operation history",
        loading: "Loading user operation history…",
        scope: "User operations from the latest 50 logs · up to 20 shown",
        empty: "No recent user operations.",
        failed: "User operation history is temporarily unavailable. Refresh the records to try reading again.",
        refresh: "Refresh records",
        missingTitle: "Object name unavailable",
        missingTime: "Time unavailable"
      }, [language]);

  return (
    <section className="settings-panel settings-primary-section business-operation-history" data-settings-top-level="business-history" aria-labelledby="business-operation-history-title">
      <header className="settings-primary-section__title business-operation-history__header">
        <h2 id="business-operation-history-title">{copy.title}</h2>
        <span className="business-operation-history__count">{entries.length}</span>
        <button className="secondary-button" type="button" onClick={() => void reload()} disabled={isLoading}>{copy.refresh}</button>
      </header>
      <div className="settings-primary-section__body business-operation-history__body" aria-busy={isLoading} aria-live="polite">
        <p className="business-operation-history__scope">{copy.scope}</p>
        {isLoading ? <p className="operation-center-empty">{copy.loading}</p> : null}
        {!isLoading && loadFailed ? (
          <p className="operation-center-error">{copy.failed}</p>
        ) : null}
        {!isLoading && !loadFailed && entries.length === 0 ? (
          <p className="operation-center-empty">{copy.empty}</p>
        ) : null}
        {!isLoading && !loadFailed && entries.length > 0 ? (
          <div className="business-operation-history__list">
            {entries.map((entry) => {
              const presentation = businessOperationPresentation(entry, language);
              return (
                <article className="business-operation-history__item" key={entry.id}>
                  <time dateTime={entry.createdAt}>{formatDate(entry.createdAt, copy.missingTime)}</time>
                  <span>{presentation.objectLabel} · {entry.objectTitle ?? copy.missingTitle}</span>
                  <span>{presentation.actionLabel}</span>
                  <span className={`operation-status-badge operation-status-${entry.result === "failure" ? "error" : entry.result}`}>
                    {presentation.resultLabel}
                  </span>
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
