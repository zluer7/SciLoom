import { useCallback, useEffect, useMemo, useState } from "react";
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

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function BusinessOperationHistoryPanel() {
  const { language } = useI18n();
  const [entries, setEntries] = useState<BusinessOperationHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    setLoadFailed(false);
    const logs = await listOperationLogs({ limit: BUSINESS_OPERATION_HISTORY_READ_LIMIT });
    setEntries(
      logs
        .map(projectBusinessOperationLogEntry)
        .filter((entry): entry is BusinessOperationHistoryEntry => Boolean(entry))
        .slice(0, BUSINESS_OPERATION_HISTORY_DISPLAY_LIMIT)
    );
  }, []);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    void reload()
      .catch(() => {
        if (active) {
          setEntries([]);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);

  useRefreshEventReload({
    pageName: "Settings Business Operation History",
    watchedKeys: BUSINESS_OPERATION_HISTORY_REFRESH_KEYS,
    reload,
    onReloadError: () => {
      setEntries([]);
      setLoadFailed(true);
    }
  });

  const copy = useMemo(() => language === "zh-CN"
    ? {
        title: "用户操作记录",
        loading: "正在读取用户操作记录…",
        empty: "暂无可显示的用户业务操作记录。",
        failed: "用户操作记录暂时无法读取。"
      }
    : {
        title: "User operation history",
        loading: "Loading user operation history…",
        empty: "No user business operations are available.",
        failed: "User operation history is temporarily unavailable."
      }, [language]);

  return (
    <details className="settings-panel business-operation-history">
      <summary>
        <span>{copy.title}</span>
        <span className="business-operation-history__count">{entries.length}</span>
      </summary>
      <div className="business-operation-history__body">
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
                  <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                  <span>{presentation.objectLabel}</span>
                  <span>{presentation.actionLabel}</span>
                  <span className={`operation-status-badge operation-status-${entry.result === "failure" ? "error" : "success"}`}>
                    {presentation.resultLabel}
                  </span>
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
    </details>
  );
}
