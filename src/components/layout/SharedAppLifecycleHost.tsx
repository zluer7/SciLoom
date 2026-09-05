import { useEffect, useSyncExternalStore } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningUi } from "../../i18n/nonPlanningI18n";
import { isTauriRuntime } from "../../repositories/dataSourceMode";
import {
  sharedEditorLifecycleController,
  type SharedEditorLifecycleController
} from "../../services/sharedEditorLifecycleController";
import { SharedEditorLifecycleDecisionDialog } from "../common/SharedEditorLifecycleDecisionDialog";

export type NativeCloseRequestedEvent = {
  preventDefault(): void;
};

export type NativeLifecycleWindow = {
  onCloseRequested(
    handler: (event: NativeCloseRequestedEvent) => void | Promise<void>
  ): Promise<() => void>;
  destroy(): Promise<void>;
};

export async function installNativeSharedEditorLifecycleCloseGuard(
  nativeWindow: NativeLifecycleWindow,
  controller: SharedEditorLifecycleController = sharedEditorLifecycleController
) {
  return nativeWindow.onCloseRequested(async (event) => {
    if (controller.consumeFinalClosePermit()) return;
    event.preventDefault();
    await controller.requestSequence({
      trigger: "native-window-close",
      continuationIntent: "APP_EXIT",
      surface: "application",
      continuation: () => {
        controller.armFinalClosePermit();
        setTimeout(() => {
          if (!controller.consumeFinalClosePermit()) return;
          void nativeWindow.destroy().catch((cause) => {
            console.error("SciLoom native window destroy failed.", cause);
          });
        }, 0);
      }
    });
  });
}

export function SharedAppLifecycleHost() {
  const { language } = useI18n();
  const ui = (source: string) => nonPlanningUi(language, source);
  const snapshot = useSyncExternalStore(
    sharedEditorLifecycleController.subscribe,
    sharedEditorLifecycleController.getSnapshot,
    sharedEditorLifecycleController.getSnapshot
  );
  const request = snapshot.request?.surface === "application"
    ? snapshot.request
    : undefined;

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        installNativeSharedEditorLifecycleCloseGuard(getCurrentWindow())
      )
      .then((removeListener) => {
        if (disposed) removeListener();
        else unlisten = removeListener;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const protectDirtyFallback = (event: BeforeUnloadEvent) => {
      if (!sharedEditorLifecycleController.hasDirtySessions()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDirtyFallback);
    return () => window.removeEventListener("beforeunload", protectDirtyFallback);
  }, []);

  if (!request) return null;
  const closing = request.continuationIntent === "APP_EXIT" ||
    request.continuationIntent === "CLOSE_WINDOW";
  return (
    <SharedEditorLifecycleDecisionDialog
      request={request}
      title={ui("当前文稿有未保存更改")}
      message={ui(
        closing
          ? "关闭前，请选择保存更改、放弃更改或取消关闭。"
          : "切换前，请选择保存更改、放弃更改或取消操作。"
      )}
      saveLabel={ui("保存并继续")}
      discardLabel={ui("放弃更改")}
      cancelLabel={ui("取消")}
      savingLabel={ui("正在保存...")}
      onSave={() => void sharedEditorLifecycleController.resolve(
        request.requestToken,
        "save"
      )}
      onDiscard={() => void sharedEditorLifecycleController.resolve(
        request.requestToken,
        "discard"
      )}
      onCancel={() => void sharedEditorLifecycleController.resolve(
        request.requestToken,
        "cancel"
      )}
    />
  );
}
