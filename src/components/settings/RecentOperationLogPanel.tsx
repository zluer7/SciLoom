import { useCallback, useEffect, useState } from "react";
import { useRefreshEventReload } from "../../hooks/useRefreshEventReload";
import { useI18n } from "../../i18n/I18nProvider";
import { listOperationLogs } from "../../services/operationLogService";
import type { OperationLogEntry } from "../../types/operationLog";

const RECENT_OPERATION_LOG_REFRESH_KEYS = ["operationLog.changed"];
const RECENT_OPERATION_LOG_LIMIT = 12;

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function summarizeOperationLogMessage(entry: OperationLogEntry) {
  if (entry.feedback?.message) return entry.feedback.message;
  if (entry.errors.length > 0) return entry.errors[0];
  if (entry.warnings.length > 0) return entry.warnings[0];
  if (entry.skipped.length > 0) return entry.skipped[0];
  return entry.summary;
}

export function RecentOperationLogPanel() {
  const { t } = useI18n();
  const [logs, setLogs] = useState<OperationLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setLogs(await listOperationLogs({ limit: RECENT_OPERATION_LOG_LIMIT }));
    } catch (error) {
      setLogs([]);
      setLoadError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  useRefreshEventReload({
    pageName: "Settings Recent Operation Log",
    watchedKeys: RECENT_OPERATION_LOG_REFRESH_KEYS,
    reload
  });

  function statusLabel(status: OperationLogEntry["status"]) {
    switch (status) {
      case "success":
        return t("operationLogStatusSuccess");
      case "partial":
        return t("operationLogStatusPartial");
      case "skipped":
        return t("operationLogStatusSkipped");
      case "error":
        return t("operationLogStatusError");
      default:
        return status;
    }
  }

  function riskLabel(risk: OperationLogEntry["riskLevel"]) {
    switch (risk) {
      case "low":
        return t("operationRiskLow");
      case "medium":
        return t("operationRiskMedium");
      case "high":
        return t("operationRiskHigh");
      case "critical":
        return t("operationRiskCritical");
      default:
        return risk;
    }
  }

  return (
    <details
      className="settings-panel recent-operation-log"
      data-recent-operation-log="true"
      data-settings-top-level="operation-log"
    >
      <summary>操作日志</summary>
      <div className="recent-operation-log__body">
        {isLoading ? <p className="operation-center-empty">{t("operationCenterLoading")}</p> : null}
        {!isLoading && loadError ? (
          <p className="operation-center-error">
            {t("operationCenterLoadFailed")} {loadError}
          </p>
        ) : null}
        {!isLoading && !loadError && logs.length === 0 ? (
          <p className="operation-center-empty">{t("operationCenterNoLogs")}</p>
        ) : null}
        {!isLoading && !loadError && logs.length > 0 ? (
          <div className="operation-center-list">
            {logs.map((entry) => (
              <article className="operation-log-item" key={entry.id}>
                <div className="operation-center-item-head">
                  <strong>{entry.summary}</strong>
                  <span className={`operation-status-badge operation-status-${entry.status}`}>
                    {statusLabel(entry.status)}
                  </span>
                </div>
                <p>{summarizeOperationLogMessage(entry)}</p>
                <div className="operation-center-meta">
                  <span>{formatDate(entry.createdAt)}</span>
                  <span>{entry.operationType}</span>
                  <span>{entry.source}</span>
                  <span>{riskLabel(entry.riskLevel)}</span>
                  <span>
                    {t("operationCenterTarget")} {entry.target.title ?? entry.target.entityId}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
