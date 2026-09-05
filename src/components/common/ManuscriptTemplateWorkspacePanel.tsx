import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningUi } from "../../i18n/nonPlanningI18n";
import type { MarkdownTemplate, MarkdownTemplateScope } from "../../types/markdownTemplate";
import { MarkdownTemplateManager } from "./MarkdownTemplateManager";

export type ManuscriptTemplateWorkspacePanelProps = Readonly<{
  scope: MarkdownTemplateScope;
  templates: readonly MarkdownTemplate[];
  managing: boolean;
  targetInvalidMessage?: string;
  onClose(): void;
  onInsert(template: MarkdownTemplate): void;
  onManagingChange(managing: boolean): void;
  onTemplatesChanged(): void;
}>;

export function ManuscriptTemplateWorkspacePanel(props: ManuscriptTemplateWorkspacePanelProps) {
  const { language } = useI18n();
  const ui = (source: string) => nonPlanningUi(language, source);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      aria-label={ui("选择 Markdown 模板")}
      className="markdown-template-panel manuscript-template-workspace-panel"
      data-centered-modal-count="0"
      data-global-backdrop-count="0"
      data-template-workspace-panel="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
      ref={panelRef}
      tabIndex={-1}
    >
      <div className="markdown-template-panel-header">
        <div className="markdown-template-panel-heading">
          <strong>{ui("选择 Markdown 模板")}</strong>
          <span>{ui("选择后会插入到当前光标位置。")}</span>
        </div>
        <div className="markdown-template-panel-actions">
          <button type="button" onClick={() => props.onManagingChange(!props.managing)}>
            {ui("管理模板")}
          </button>
          <button type="button" onClick={props.onClose}>{ui("关闭")}</button>
        </div>
      </div>

      {props.targetInvalidMessage ? (
        <p className="markdown-template-error" role="alert">{props.targetInvalidMessage}</p>
      ) : null}

      <div className="markdown-template-panel-scroll">
        {props.templates.length > 0 ? (
          <div className="markdown-template-list">
            {props.templates.map((template) => (
              <article className="markdown-template-card" key={template.id}>
                <div>
                  <div className="markdown-template-card-title">
                    <strong>{template.name}</strong>
                    <span className="markdown-template-badge">
                      {template.source === "builtIn" ? ui("内置模板") : ui("用户模板")}
                    </span>
                    {template.scope === "common" ? (
                      <span className="markdown-template-badge">{ui("通用模板")}</span>
                    ) : null}
                  </div>
                  {template.description ? <p>{template.description}</p> : null}
                </div>
                <button
                  disabled={Boolean(props.targetInvalidMessage)}
                  type="button"
                  onClick={() => props.onInsert(template)}
                >
                  {ui("插入")}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="markdown-template-empty">{ui("暂无可用模板。")}</p>
        )}

        {props.managing ? (
          <MarkdownTemplateManager
            scope={props.scope}
            templates={[...props.templates]}
            onTemplatesChanged={props.onTemplatesChanged}
          />
        ) : null}
      </div>
    </section>
  );
}

export default ManuscriptTemplateWorkspacePanel;
