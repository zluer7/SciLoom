import { useEffect } from "react";
import { useRoutes } from "react-router-dom";
import { I18nProvider } from "../i18n/I18nProvider";
import { routes } from "./routes";
import { discoverReferenceOwnerFormalSwitchRecoveries } from "../services/referenceOwnerFormalSwitchProductionBridge";
import { manuscriptProvisioningRuntimeAdapter } from "../services/manuscriptProvisioningRuntimeAdapter";
import { SharedAppLifecycleHost } from "../components/layout/SharedAppLifecycleHost";
import { manuscriptSaveAsInterruptedStateService } from "../services/manuscriptSaveAsInterruptedStateService";
import { isTauriRuntime } from "../repositories/dataSourceMode";
import { SaveAsD2ContainmentNotice } from "../components/common/SaveAsD2ContainmentNotice";
import { installQuickAnalysisFeedbackOwner } from "../services/quickAnalysisFeedbackService";
import { BusinessOperationToastHost } from "../components/feedback/BusinessOperationToastHost";
import { FirstLaunchWorkspaceGate } from "../components/FirstLaunchWorkspaceGate";

function ReadyApp() {
  const routeElements = useRoutes(routes);
  useEffect(() => {
    const uninstallQuickAnalysisFeedbackOwner = installQuickAnalysisFeedbackOwner();
    void manuscriptProvisioningRuntimeAdapter.markMainWindowReady().catch(() => {
      // Runtime state remains queryable when activation is unavailable.
    });
    void discoverReferenceOwnerFormalSwitchRecoveries().catch(() => {
      // Run detail/editor discovery surfaces the safe user-facing recovery error.
    });
    if (!isTauriRuntime()) return uninstallQuickAnalysisFeedbackOwner;
    void manuscriptSaveAsInterruptedStateService.scan("startup").catch(() => {
      // Owner-local surfaces expose the fail-closed scan state when available.
    });
    return uninstallQuickAnalysisFeedbackOwner;
  }, []);
  return (
    <>
      {routeElements}
      <BusinessOperationToastHost />
      <SaveAsD2ContainmentNotice />
      <SharedAppLifecycleHost />
    </>
  );
}

export function App() {
  return (
    <I18nProvider>
      <FirstLaunchWorkspaceGate>
        <ReadyApp />
      </FirstLaunchWorkspaceGate>
    </I18nProvider>
  );
}
