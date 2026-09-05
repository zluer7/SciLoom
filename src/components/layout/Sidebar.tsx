import type { MouseEvent as ReactMouseEvent } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n/I18nProvider";
import type { Language } from "../../i18n/translations";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";

const navigationItems = [
  { labelKey: "projects", path: "/projects" },
  { labelKey: "routes", path: "/routes" },
  { labelKey: "tasks", path: "/tasks" },
  { labelKey: "experiments", path: "/experiments" },
  { labelKey: "literature", path: "/literature" },
  { labelKey: "reviews", path: "/reviews" },
  { labelKey: "outputs", path: "/outputs" }
] as const;

type SidebarProps = {
  isAIChatOpen: boolean;
  onToggleAIChat: () => void;
};

export function Sidebar({ isAIChatOpen, onToggleAIChat }: SidebarProps) {
  const { language, setLanguage, t } = useI18n();
  const navigate = useNavigate();

  function requestNavigation(event: ReactMouseEvent<HTMLAnchorElement>, path: string) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    void sharedEditorLifecycleController.requestSequence({
      trigger: "route-change",
      continuationIntent: "ROUTE_CHANGE",
      surface: "application",
      continuation: () => navigate(path)
    });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="app-title">SciLoom</div>
        <div className="app-subtitle">{t("appSubtitle")}</div>
      </div>

      <nav className="sidebar-nav" aria-label={t("primaryNavigation")}>
        {navigationItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            onClick={(event) => requestNavigation(event, item.path)}
            className={({ isActive }) =>
              isActive ? "nav-link nav-link-active" : "nav-link"
            }
          >
            {t(item.labelKey)}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <label className="sidebar-language-preference">
          <span>{t("language")}</span>
          <select
            data-testid="sidebar-language-select"
            value={language}
            onChange={(event) => setLanguage(event.target.value as Language)}
          >
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
        <NavLink
          to="/settings"
          onClick={(event) => requestNavigation(event, "/settings")}
          className={({ isActive }) =>
            isActive
              ? "sidebar-footer-link sidebar-footer-link-active"
              : "sidebar-footer-link"
          }
        >
          {t("settings")}
        </NavLink>
        <button
          type="button"
          className={isAIChatOpen ? "sidebar-ai-button sidebar-ai-button-active" : "sidebar-ai-button"}
          aria-controls="global-ai-chat-panel"
          aria-expanded={isAIChatOpen}
          onClick={onToggleAIChat}
        >
          {t("aiChat")}
        </button>
      </div>
    </aside>
  );
}
