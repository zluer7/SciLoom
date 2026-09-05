import { useEffect, useSyncExternalStore } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  businessOperationPresentation,
  dismissBusinessOperationToast,
  getBusinessOperationToast,
  installBusinessOperationFeedbackOwner,
  subscribeBusinessOperationToast
} from "../../services/businessOperationFeedbackService";

export const BUSINESS_OPERATION_SUCCESS_TOAST_DURATION_MS = 5000;

export function BusinessOperationToastHost() {
  const { language } = useI18n();
  const toast = useSyncExternalStore(
    subscribeBusinessOperationToast,
    getBusinessOperationToast,
    getBusinessOperationToast
  );

  useEffect(() => installBusinessOperationFeedbackOwner(), []);

  useEffect(() => {
    if (!toast || toast.result !== "success") return undefined;
    const toastId = toast.id;
    const timer = window.setTimeout(() => {
      dismissBusinessOperationToast(toastId);
    }, BUSINESS_OPERATION_SUCCESS_TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  const presentation = businessOperationPresentation(toast, language);
  return (
    <div className="business-operation-toast-host" aria-live="polite">
      <div
        className={`business-operation-toast business-operation-toast--${toast.result}`}
        role={toast.result === "failure" ? "alert" : "status"}
      >
        <span>{presentation.text}</span>
        <button
          type="button"
          className="business-operation-toast__dismiss"
          aria-label={language === "zh-CN" ? "关闭" : "Dismiss"}
          onClick={() => dismissBusinessOperationToast(toast.id)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
