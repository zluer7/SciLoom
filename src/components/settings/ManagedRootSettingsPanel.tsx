import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  managedRootConfigService,
  type ManagedRootConfigurationSnapshot
} from "../../services/managedRootConfigService";
import { managedRootSelectionService } from "../../services/managedRootSelectionService";
import type { WriteFeedbackResult } from "../../types/writeFeedback";

interface ManagedRootSettingsPanelProps {
  onWriteFeedback(feedback: WriteFeedbackResult): void;
  onWriteError(error: unknown, operation: string): void;
}

function emptyReadFailure(): ManagedRootConfigurationSnapshot {
  return {
    durableState: "READ_FAILED",
    readinessState: "READ_FAILED",
    configuredPath: null,
    normalizedPath: null,
    pathIdentityKey: null,
    physicalIdentityHash: null,
    errorCode: "MANAGED_ROOT_DURABLE_READ_FAILED",
    checkedAt: new Date().toISOString()
  };
}

export function ManagedRootSettingsPanel({
  onWriteFeedback,
  onWriteError
}: ManagedRootSettingsPanelProps) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [snapshot, setSnapshot] = useState<ManagedRootConfigurationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await managedRootConfigService.getConfigurationSnapshot());
    } catch (error) {
      setSnapshot(emptyReadFailure());
      onWriteError(error, "settings.managedRoot.read");
    } finally {
      setLoading(false);
    }
  }, [onWriteError]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  async function selectManagedRoot() {
    setSubmitting(true);
    try {
      const result = await managedRootSelectionService.selectAndConfigure({
        title: zh ? "选择本地工作目录" : "Select the local working directory"
      });
      // Folder-picker cancel remains a deterministic no-op: no configuration,
      // feedback, readiness invalidation, or OperationLog write.
      if (result.status === "canceled") return;
      if (result.feedback) onWriteFeedback(result.feedback);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
      } else if (result.status === "failed") {
        onWriteError(new Error(result.errorCode), "settings.managedRoot.pick");
        await loadSnapshot();
      }
    } catch (error) {
      onWriteError(error, "settings.managedRoot.configure");
      await loadSnapshot();
    } finally {
      setSubmitting(false);
    }
  }

  async function retryReadiness() {
    await loadSnapshot();
  }

  const configured = snapshot?.durableState === "CONFIGURED";
  const ready = snapshot?.readinessState === "READY";

  return (
    <section className="settings-panel managed-root-settings" aria-labelledby="managed-root-settings-title">
      <div className="managed-root-settings__heading">
        <h3 id="managed-root-settings-title">{zh ? "本地工作目录" : "Local working directory"}</h3>
        <span className={ready ? "managed-root-status managed-root-status--ready" : "managed-root-status managed-root-status--warning"}>
          {ready ? (zh ? "可用" : "Ready") : (zh ? "需要处理" : "Action needed")}
        </span>
      </div>

      {configured && snapshot.configuredPath ? (
        <div className="managed-root-settings__path">
          <span>{zh ? "已配置路径" : "Configured path"}</span>
          <code data-testid="managed-root-configured-path">{snapshot.configuredPath}</code>
        </div>
      ) : null}

      {snapshot?.errorCode ? (
        <p className="managed-root-settings__notice" role={snapshot.durableState === "READ_FAILED" ? "alert" : undefined}>
          {snapshot.durableState === "NOT_CONFIGURED"
            ? (zh
                ? "尚未配置本地工作目录。配置后才能创建和打开由 SciLoom 管理的文稿。"
                : "No local working directory is configured. Configure one before creating or opening SciLoom-managed manuscripts.")
            : snapshot.durableState === "CONFIGURED"
              ? (zh
                  ? "当前本地工作目录暂不可用，请重新检查"
                  : "The local working directory is currently unavailable. Check it again.")
              : (zh
                  ? "无法读取持久配置。请重试；SciLoom 不会回退到其他目录。"
                  : "The durable configuration could not be read. Retry; SciLoom will not fall back to another directory.")}
        </p>
      ) : null}

      {snapshot?.durableState === "NOT_CONFIGURED" || (snapshot?.durableState === "CONFIGURED" && !ready) ? (
        <div className="managed-root-settings__actions">
          {snapshot?.durableState === "NOT_CONFIGURED" ? (
            <button
              type="button"
              className="primary-button"
              data-testid="managed-root-select"
              onClick={() => void selectManagedRoot()}
              disabled={loading || submitting}
            >
              {submitting
                ? (zh ? "保存中…" : "Saving…")
                : (zh ? "选择目录" : "Select directory")}
            </button>
          ) : null}
          {snapshot?.durableState === "CONFIGURED" && !ready ? (
            <button
              type="button"
              className="secondary-button"
              data-testid="managed-root-retry"
              onClick={() => void retryReadiness()}
              disabled={loading || submitting}
            >
              {loading ? (zh ? "检查中…" : "Checking…") : (zh ? "重新检查" : "Check again")}
            </button>
          ) : null}
        </div>
      ) : null}

      <details className="settings-technical-details">
        <summary>{zh ? "详细信息" : "Details"}</summary>
        <div className="settings-technical-details__body">
          <p className="managed-root-settings__responsibility">
            {zh
              ? "SciLoom 将课题、任务、实验、文献等结构化信息保存在数据库中，便于快速查看、编辑和关联；需要长期保存和持续完善的文稿内容则存放在本地工作目录中，方便随时打开并继续编辑"
              : "SciLoom stores structured project, task, experiment, and literature information in the database for quick viewing, editing, and linking; manuscript content that needs long-term preservation and continued refinement is stored in the local working directory so it can be opened and edited at any time"}
          </p>
        </div>
      </details>

      <p className="settings-section-explanation">
        {zh
          ? "结构化数据用于日常科研管理，本地工作目录用于保存和持续编辑文稿内容"
          : "Structured data supports daily research management, while the local working directory stores manuscripts for continued editing"}
      </p>
    </section>
  );
}
