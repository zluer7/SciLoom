import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider";
import { isTauriRuntime } from "../repositories/dataSourceMode";
import { decideFirstLaunchWorkspaceAction } from "../services/firstLaunchWorkspaceDemoCore";
import { firstLaunchWorkspaceDemoService } from "../services/firstLaunchWorkspaceDemoService";
import { managedRootConfigService } from "../services/managedRootConfigService";
import { managedRootSelectionService } from "../services/managedRootSelectionService";

type GatePhase =
  | "checking"
  | "select"
  | "retry"
  | "selecting"
  | "provisioning"
  | "demo-failed"
  | "ready";

export function FirstLaunchWorkspaceGate({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const navigate = useNavigate();
  const [phase, setPhase] = useState<GatePhase>("checking");
  const [message, setMessage] = useState<string>();

  const refreshWorkspace = useCallback(async () => {
    if (!isTauriRuntime()) {
      setPhase("ready");
      return;
    }
    setPhase("checking");
    setMessage(undefined);
    try {
      const snapshot = await managedRootConfigService.getConfigurationSnapshot();
      const action = decideFirstLaunchWorkspaceAction(snapshot);
      setPhase(
        action === "PROCEED" ? "ready" : action === "SELECT" ? "select" : "retry"
      );
    } catch {
      setPhase("retry");
      setMessage(
        zh
          ? "无法读取本地工作目录配置，请重试。"
          : "The local working-directory configuration could not be read. Try again."
      );
    }
  }, [zh]);

  useEffect(() => {
    // First-launch admission is a one-shot startup read. Language changes must
    // not re-enter the gate after the application is already usable.
    void refreshWorkspace();
  }, []);

  async function selectWorkspace() {
    setPhase("selecting");
    setMessage(undefined);
    const selection = await managedRootSelectionService.selectAndConfigure({
      title: zh ? "选择本地工作目录" : "Select the local working directory"
    });
    if (selection.status === "canceled") {
      setMessage(
        zh
          ? "已取消选择；SciLoom 没有保存目录或写入示例数据。你可以再次选择。"
          : "Selection was canceled. SciLoom saved no directory or Demo data; you can choose again."
      );
      setPhase("select");
      return;
    }
    if (selection.status !== "ready") {
      console.error("First-launch workspace configuration failed.", selection.errorCode);
      setMessage(
        zh
          ? "本地工作目录尚未准备好，请重新选择或检查后再试。"
          : "The local working directory is not ready. Choose again or check it and retry."
      );
      setPhase(
        selection.snapshot?.durableState === "NOT_CONFIGURED" ? "select" : "retry"
      );
      return;
    }

    setPhase("provisioning");
    const result = await firstLaunchWorkspaceDemoService.run();
    if (result.status === "FAILED") {
      console.error("Automatic Demo provisioning failed.", result.technicalCode);
      setMessage(
        zh
          ? "示例课题未能自动准备，但本地工作目录已保存。你仍可继续使用 SciLoom，或稍后通过现有导入入口手动导入。"
          : "The Demo project could not be prepared automatically, but the local working directory was saved. You can continue using SciLoom or import it later through the existing Import action."
      );
      setPhase("demo-failed");
      return;
    }
    if (result.projectId) {
      navigate("/projects", { replace: true });
    }
    if (result.status === "SKIPPED_UNKNOWN") {
      console.warn(
        "Automatic Demo provisioning was skipped because business-data state was unknown.",
        result.technicalCode
      );
    }
    setPhase("ready");
  }

  if (phase === "ready") return <>{children}</>;

  const busy = phase === "checking" || phase === "selecting" || phase === "provisioning";
  return (
    <div className="modal-backdrop operation-confirm-backdrop" role="presentation">
      <section
        className="operation-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-launch-workspace-title"
        data-testid="first-launch-workspace-gate"
      >
        <header className="operation-confirm-header">
          <h2 id="first-launch-workspace-title">
            {zh ? "准备 SciLoom 工作区" : "Prepare the SciLoom workspace"}
          </h2>
        </header>
        <p>
          {phase === "provisioning"
            ? zh
              ? "正在从随软件提供的示例资源准备课题…"
              : "Preparing the project from the Demo resource bundled with SciLoom…"
            : phase === "checking"
              ? zh
                ? "正在检查本地工作目录…"
                : "Checking the local working directory…"
              : zh
                ? "请选择一个本地目录，用于保存和持续编辑 SciLoom 管理的文稿。"
                : "Choose a local directory for manuscripts managed and edited through SciLoom."}
        </p>
        {message ? <p role="status">{message}</p> : null}
        <div className="button-row operation-confirm-actions">
          {phase === "select" ? (
            <button type="button" onClick={() => void selectWorkspace()}>
              {zh ? "选择目录" : "Select directory"}
            </button>
          ) : null}
          {phase === "retry" ? (
            <button type="button" onClick={() => void refreshWorkspace()}>
              {zh ? "重新检查" : "Check again"}
            </button>
          ) : null}
          {phase === "demo-failed" ? (
            <button type="button" onClick={() => setPhase("ready")}>
              {zh ? "继续使用" : "Continue"}
            </button>
          ) : null}
          {busy ? <span role="status">{zh ? "请稍候" : "Please wait"}</span> : null}
        </div>
      </section>
    </div>
  );
}
