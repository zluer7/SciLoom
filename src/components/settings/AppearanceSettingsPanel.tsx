import { useAppearance } from "../layout/AppearanceProvider";
import { useI18n } from "../../i18n/I18nProvider";
import type { AppearancePreference } from "../../services/appearancePreference";

export function AppearanceSettingsPanel() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const { preference, setPreference, saveFailed } = useAppearance();
  return (
    <section className="settings-panel settings-primary-section" data-settings-top-level="appearance" aria-labelledby="settings-appearance-title">
      <div className="settings-primary-section__body appearance-settings">
        <label id="settings-appearance-title" htmlFor="appearance-preference">{zh ? "主题" : "Theme"}</label>
        <select id="appearance-preference" value={preference} onChange={event => setPreference(event.target.value as AppearancePreference)}>
          <option value="SYSTEM">{zh ? "跟随系统" : "Follow system"}</option>
          <option value="LIGHT">{zh ? "浅色" : "Light"}</option>
          <option value="DARK">{zh ? "深色" : "Dark"}</option>
        </select>
        {saveFailed ? <p className="appearance-settings__error" role="alert">{zh
          ? "无法确认外观偏好已保存。当前显示保留上次确认的选择；重新打开时将读取实际保存值。请重新选择后再试。"
          : "Your appearance choice could not be confirmed as saved. The display keeps the last confirmed choice; reopening will read the stored value. Select again to retry."}</p> : null}
      </div>
    </section>
  );
}
