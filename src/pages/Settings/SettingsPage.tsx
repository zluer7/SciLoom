import { WriteFeedbackPanel } from "../../components/feedback/WriteFeedbackPanel";
import { SettingsPanel } from "../../components/layout/SettingsPanel";
import { ManagedRootSettingsPanel } from "../../components/settings/ManagedRootSettingsPanel";
import { AIProviderSettingsPanel } from "../../components/settings/AIProviderSettingsPanel";
import { RecentOperationLogPanel } from "../../components/settings/RecentOperationLogPanel";
import { ProjectImportPanel } from "../../components/settings/ProjectImportPanel";
import { useWriteFeedbackCenter } from "../../hooks/useWriteFeedbackCenter";
import { useI18n } from "../../i18n/I18nProvider";

export function shouldProjectSettingsSuccessFeedback(operation: string) {
  return operation !== "settings.language.update";
}

export function SettingsPage() {
  const { t } = useI18n();
  const feedbackCenter = useWriteFeedbackCenter({ page: "settings" });

  function handleSettingChanged(operation: string) {
    // Settings update their controlled state synchronously, so no refresh key is needed.
    if (!shouldProjectSettingsSuccessFeedback(operation)) return;
    feedbackCenter.consumeWriteResult(undefined, { operation });
  }

  return (
    <section className="page-section settings-page">
      <header className="page-header settings-page__header">
        <h1>{t("settings")}</h1>
      </header>
      <WriteFeedbackPanel
        entries={feedbackCenter.entries}
        onDismiss={feedbackCenter.dismissFeedback}
      />

      <SettingsPanel
        onSettingChanged={handleSettingChanged}
        onSettingChangeError={feedbackCenter.consumeWriteError}
        renderSections={({
          dataSourceSettings
        }) => (
          <>
            <section
              aria-labelledby="settings-basic-ai-title"
              className="settings-panel settings-primary-section"
              data-settings-top-level="basic-ai"
              id="ai-provider-settings"
            >
              <h2 className="settings-primary-section__title" id="settings-basic-ai-title">
                AI 功能
              </h2>
              <div className="settings-primary-section__body">
                <AIProviderSettingsPanel />
              </div>
            </section>

            <section
              aria-labelledby="settings-data-storage-title"
              className="settings-panel settings-primary-section"
              data-settings-top-level="data-storage"
            >
              <h2 className="settings-primary-section__title" id="settings-data-storage-title">
                数据与存储
              </h2>
              <div className="settings-primary-section__body">
                <div className="settings-data-storage__primary-row">
                  <ProjectImportPanel />
                  {dataSourceSettings}
                </div>
                <ManagedRootSettingsPanel
                  onWriteFeedback={feedbackCenter.pushWriteFeedback}
                  onWriteError={feedbackCenter.consumeWriteError}
                />
              </div>
            </section>

            <RecentOperationLogPanel />

            <footer
              aria-label="帮助与支持"
              className="settings-help-support"
              data-settings-top-level="help-support"
            >
              <p>欢迎认同 SciLoom 理念、愿意一起开发和维护的伙伴加入共创</p>
              <p>反馈、联系我们以及更多 SciLoom 动态，请关注公众号「争流儿的科研舱」</p>
            </footer>
          </>
        )}
      />
    </section>
  );
}
