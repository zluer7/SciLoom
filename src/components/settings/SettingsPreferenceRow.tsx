import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { Language } from "../../i18n/translations";
import { AppearanceSettingsPanel } from "../../components/settings/AppearanceSettingsPanel";

export function SettingsPreferenceRow() {
  const { language, setLanguage, t } = useI18n();
  const [languageSaveFailed, setLanguageSaveFailed] = useState(false);
  return (
    <div className="settings-preference-row" data-settings-top-level="preferences">
      <AppearanceSettingsPanel />
      <section className="settings-panel settings-primary-section settings-language" aria-labelledby="settings-language-label">
        <div className="settings-primary-section__body appearance-settings">
          <label id="settings-language-label" htmlFor="settings-language-preference">{t("language")}</label>
          <select id="settings-language-preference" value={language} onChange={event => {
            try { setLanguage(event.target.value as Language); setLanguageSaveFailed(false); }
            catch { setLanguageSaveFailed(true); }
          }}>
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
          {languageSaveFailed ? <p role="alert">{language === "zh-CN" ? "无法确认语言偏好已保存，请重试。" : "Language preference could not be saved. Please retry."}</p> : null}
        </div>
      </section>
      <div className="settings-preference-row__reserved" aria-hidden="true" />
    </div>
  );
}
