import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DATA_SOURCE_MODE_CHANGE_EVENT,
  getDataSourceModeSnapshot,
  isDataSourceMode,
  isTauriRuntime,
  projectDataSourceMode,
  setDataSourceMode,
  type DataSourceMode,
  type DataSourceModeSnapshot
} from "../../repositories/dataSourceMode";
import { useI18n } from "../../i18n/I18nProvider";

interface SettingsPanelProps {
  onSettingChanged?: (operation: string) => void;
  onSettingChangeError?: (error: unknown, operation: string) => void;
  renderSections(surfaces: SettingsPanelPresentationSurfaces): ReactNode;
}

interface SettingsPanelPresentationSurfaces {
  basicSettings: ReactNode;
  dataSourceSettings: ReactNode;
  dataSourceTechnicalDetails: ReactNode;
}

interface SQLiteRuntimeIdentity {
  source: "sqlite";
  databasePath: string;
  databaseFileName: string;
}

type SQLiteIdentityReadState = "NOT_APPLICABLE" | "READING" | "READY" | "READ_FAILED";

function modeLabel(mode: DataSourceMode, zh: boolean) {
  if (mode === "auto") return zh ? "自动" : "Auto";
  if (mode === "sqlite") return "SQLite";
  return "localStorage";
}

function resolutionLabel(snapshot: DataSourceModeSnapshot, zh: boolean) {
  if (snapshot.resolutionState === "RESOLVED_AUTO") {
    return zh
      ? `自动已正常解析为 ${modeLabel(snapshot.effectiveMode, zh)}`
      : `Auto resolved normally to ${modeLabel(snapshot.effectiveMode, zh)}`;
  }
  if (snapshot.resolutionState === "NON_TAURI_FALLBACK") {
    return zh
      ? "当前不是桌面运行时，SQLite 选择暂时回退为 localStorage"
      : "SQLite selection currently falls back to localStorage outside the desktop runtime";
  }
  return zh ? "显式选择已生效" : "Explicit selection is effective";
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

export function SettingsPanel({
  onSettingChanged,
  onSettingChangeError,
  renderSections
}: SettingsPanelProps) {
  const { language, t } = useI18n();
  const zh = language === "zh-CN";
  const [sourceSnapshot, setSourceSnapshot] = useState(getDataSourceModeSnapshot);
  const [sqliteIdentity, setSQLiteIdentity] = useState<SQLiteRuntimeIdentity | null>(null);
  const [identityReadState, setIdentityReadState] = useState<SQLiteIdentityReadState>(
    sourceSnapshot.effectiveMode === "sqlite" ? "READING" : "NOT_APPLICABLE"
  );
  const [pendingMode, setPendingMode] = useState<DataSourceMode | null>(null);
  const [applyingMode, setApplyingMode] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchInFlightRef = useRef(false);

  useEffect(() => {
    function handleModeChange(event: Event) {
      const eventMode = (event as CustomEvent<{ mode?: unknown }>).detail?.mode;
      setSourceSnapshot(
        isDataSourceMode(eventMode)
          ? projectDataSourceMode(eventMode, isTauriRuntime())
          : getDataSourceModeSnapshot()
      );
    }

    window.addEventListener(DATA_SOURCE_MODE_CHANGE_EVENT, handleModeChange);
    return () => {
      window.removeEventListener(DATA_SOURCE_MODE_CHANGE_EVENT, handleModeChange);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (sourceSnapshot.effectiveMode !== "sqlite") {
      setSQLiteIdentity(null);
      setIdentityReadState("NOT_APPLICABLE");
      return () => {
        active = false;
      };
    }

    setSQLiteIdentity(null);
    setIdentityReadState("READING");
    void invoke<SQLiteRuntimeIdentity>("db_get_runtime_identity")
      .then((identity) => {
        if (!active) return;
        setSQLiteIdentity(identity);
        setIdentityReadState("READY");
      })
      .catch(() => {
        if (!active) return;
        setSQLiteIdentity(null);
        setIdentityReadState("READ_FAILED");
      });
    return () => {
      active = false;
    };
  }, [sourceSnapshot.effectiveMode]);

  useEffect(() => {
    if (!pendingMode) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !switchInFlightRef.current) {
        setPendingMode(null);
        setSwitchError(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingMode]);

  function requestModeChange(nextMode: DataSourceMode) {
    setSwitchError(null);
    if (nextMode === sourceSnapshot.selectedMode) return;
    setPendingMode(nextMode);
  }

  function cancelModeChange() {
    if (switchInFlightRef.current) return;
    setPendingMode(null);
    setSwitchError(null);
  }

  async function confirmModeChange() {
    if (!pendingMode || switchInFlightRef.current) return;
    switchInFlightRef.current = true;
    setApplyingMode(true);
    setSwitchError(null);
    try {
      const canonicalReadback = setDataSourceMode(pendingMode);
      if (canonicalReadback !== pendingMode) {
        throw new Error("DATA_SOURCE_MODE_READBACK_MISMATCH");
      }
      setSourceSnapshot(projectDataSourceMode(canonicalReadback, isTauriRuntime()));
      setPendingMode(null);
      onSettingChanged?.("settings.dataSource.update");
    } catch (error) {
      const normalized = normalizeError(error);
      setSwitchError(
        zh
          ? "切换未完成：持久选择未通过规范读回。当前界面不会报告成功。"
          : "The switch did not complete: the persisted selection failed canonical readback. No success is reported."
      );
      onSettingChangeError?.(normalized, "settings.dataSource.update");
    } finally {
      switchInFlightRef.current = false;
      setApplyingMode(false);
    }
  }

  const pendingSnapshot = pendingMode
    ? projectDataSourceMode(pendingMode, isTauriRuntime())
    : null;

  const basicSettings = null;

  const dataSourceSettings = (
    <div className="settings-controls settings-data-source-controls">
      <section className="data-source-settings" aria-labelledby="data-source-settings-title">
        <label className="settings-action-row">
          <span id="data-source-settings-title">{zh ? "选择模式" : "Selected mode"}</span>
          <select
            data-testid="data-source-mode-select"
            value={sourceSnapshot.selectedMode}
            onChange={(event) => requestModeChange(event.target.value as DataSourceMode)}
            disabled={applyingMode}
          >
            <option value="auto">{t("auto")}</option>
            <option value="sqlite">{t("sqlite")}</option>
            <option value="localStorage">{t("localStorage")}</option>
          </select>
        </label>
      </section>
    </div>
  );

  const dataSourceTechnicalDetails = (
    <div className="data-source-settings__technical">
      <div className="data-source-settings__heading">
        <div>
          <h3>{zh ? "业务元数据仓库来源" : "Business metadata repository source"}</h3>
          <p>
            {zh
              ? "选择通用实体仓库后续读写所使用的来源；这不是全部 SciLoom 数据的总开关。"
              : "Select the source used by subsequent reads and writes through the generic entity repository. This is not a master switch for all SciLoom data."}
          </p>
        </div>
        <span
          className={`data-source-resolution is-${sourceSnapshot.resolutionState.toLowerCase()}`}
          data-resolution-state={sourceSnapshot.resolutionState}
          role="status"
        >
          {resolutionLabel(sourceSnapshot, zh)}
        </span>
      </div>

      <div className="data-source-settings__scope">
        <p>
          <strong>{zh ? "控制范围：" : "Controlled scope: "}</strong>
          {zh
            ? "通用实体仓库中的里程碑/任务记录，以及实验、Run、指标、文件引用、文献、成果转化、正式成果、操作日志和回收站元数据。"
            : "Milestone/task records in the generic entity repository, plus experiment, run, metric, file-reference, literature, output-conversion, formal-output, operation-log, and recycle-bin metadata."}
        </p>
        <p>
          <strong>{zh ? "不控制：" : "Not controlled: "}</strong>
          {zh
            ? "Planning 主数据（课题、路线、当前任务、复盘及其节点/关联）、研究者档案、AI 持久历史、托管根配置或文稿文件。"
            : "Planning primary data (projects, routes, current tasks, reviews, and their nodes/links), the researcher profile, durable AI history, managed-root configuration, or manuscript files."}
        </p>
      </div>

      <p className="data-source-settings__switch-note">
        {zh
          ? "确认后立即用于后续受控读写，但不会迁移、复制或合并记录。另一来源可能显示不同或空的数据集；已打开的业务页面需重新进入或刷新后再核对。"
          : "After confirmation, the source is used immediately for subsequent controlled reads and writes, but no records are migrated, copied, or merged. The other source may show a different or empty dataset; revisit or refresh an open business page before checking it."}
      </p>

      <dl className="data-source-settings__identity">
        <div>
          <dt>{zh ? "已选模式" : "Selected mode"}</dt>
          <dd data-testid="data-source-selected-mode">
            {modeLabel(sourceSnapshot.selectedMode, zh)}
          </dd>
        </div>
        <div>
          <dt>{zh ? "当前有效来源" : "Effective source"}</dt>
          <dd data-testid="data-source-effective-mode">
            {modeLabel(sourceSnapshot.effectiveMode, zh)}
          </dd>
        </div>
        <div className="data-source-settings__runtime-identity">
          <dt>{zh ? "运行时身份" : "Runtime identity"}</dt>
          <dd data-testid="data-source-runtime-identity" data-read-state={identityReadState}>
            {sourceSnapshot.effectiveMode === "localStorage"
              ? (zh
                  ? "当前 WebView localStorage（researchpilot.* 通用实体键）"
                  : "Current WebView localStorage (researchpilot.* generic-entity keys)")
              : identityReadState === "READY" && sqliteIdentity
                ? <code>{sqliteIdentity.databasePath}</code>
                : identityReadState === "READ_FAILED"
                  ? (zh ? "SQLite 身份读取失败" : "SQLite identity read failed")
                  : (zh ? "正在读取 SQLite 身份…" : "Reading SQLite identity…")}
          </dd>
        </div>
      </dl>

      {sourceSnapshot.effectiveMode === "localStorage" ? (
        <p className="data-source-settings__sqlite-role" data-testid="data-source-sqlite-independent-role">
          {zh
            ? "SQLite 仍由独立 owner 用于托管根配置、AI 持久会话/调用、复盘结构化附属状态、文稿绑定及运行时操作；这些数据不随本模式切换。"
            : "Independent owners still use SQLite for managed-root configuration, durable AI conversations/calls, structured review state, manuscript bindings, and runtime operations. This mode does not switch those data."}
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      {renderSections({
        basicSettings,
        dataSourceSettings,
        dataSourceTechnicalDetails
      })}

      {pendingMode && pendingSnapshot ? (
        <div className="modal-backdrop data-source-confirm-backdrop" role="presentation">
          <section
            className="data-source-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="data-source-confirm-title"
            aria-describedby="data-source-confirm-summary"
          >
            <header>
              <h2 id="data-source-confirm-title">
                {zh ? "确认切换业务元数据来源" : "Confirm metadata source switch"}
              </h2>
            </header>
            <dl className="data-source-confirm-dialog__comparison">
              <div>
                <dt>{zh ? "当前" : "Current"}</dt>
                <dd>
                  {modeLabel(sourceSnapshot.selectedMode, zh)} → {modeLabel(sourceSnapshot.effectiveMode, zh)}
                </dd>
              </div>
              <div>
                <dt>{zh ? "切换后" : "After switch"}</dt>
                <dd>
                  {modeLabel(pendingSnapshot.selectedMode, zh)} → {modeLabel(pendingSnapshot.effectiveMode, zh)}
                </dd>
              </div>
            </dl>
            <p id="data-source-confirm-summary">
              {zh
                ? "此操作只切换后续受控仓库读写，不会迁移、复制或合并任何记录。目标来源可能包含不同数据，也可能为空。"
                : "This only changes the source for subsequent controlled repository reads and writes. It does not migrate, copy, or merge records. The target source may contain different data or be empty."}
            </p>
            {switchError ? <p className="data-source-confirm-dialog__error" role="alert">{switchError}</p> : null}
            <footer>
              <button
                type="button"
                className="secondary-button"
                data-testid="data-source-switch-cancel"
                onClick={cancelModeChange}
                disabled={applyingMode}
              >
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                type="button"
                className="primary-button"
                data-testid="data-source-switch-confirm"
                onClick={() => void confirmModeChange()}
                disabled={applyingMode}
              >
                {applyingMode
                  ? (zh ? "正在读回…" : "Reading back…")
                  : (zh ? "确认切换" : "Confirm switch")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
