import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningUi } from "../../i18n/nonPlanningI18n";
import {
  copyBuiltInMarkdownTemplate,
  deleteUserMarkdownTemplate,
  resetUserMarkdownTemplates,
  saveUserMarkdownTemplate,
  updateUserMarkdownTemplate
} from "../../services/markdownTemplateService";
import type {
  MarkdownTemplate,
  MarkdownTemplateDraft,
  MarkdownTemplateScope
} from "../../types/markdownTemplate";

type MarkdownTemplateManagerProps = {
  scope: MarkdownTemplateScope;
  templates: MarkdownTemplate[];
  onTemplatesChanged: () => void;
};

type TemplateFormState = {
  id?: string;
  name: string;
  description: string;
  body: string;
};

type TemplateConfirmation =
  | Readonly<{ kind: "delete"; template: MarkdownTemplate }>
  | Readonly<{ kind: "reset" }>;

const emptyForm: TemplateFormState = {
  name: "",
  description: "",
  body: ""
};

export function MarkdownTemplateManager({
  scope,
  templates,
  onTemplatesChanged
}: MarkdownTemplateManagerProps) {
  const { language } = useI18n();
  const ui = (source: string) => nonPlanningUi(language, source);
  const [form, setForm] = useState<TemplateFormState>(emptyForm);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<TemplateConfirmation>();

  useEffect(() => {
    setForm(emptyForm);
    setNotice("");
    setError("");
    setConfirmation(undefined);
  }, [scope]);

  function startEdit(template: MarkdownTemplate) {
    setForm({
      id: template.id,
      name: template.name,
      description: template.description ?? "",
      body: template.body
    });
    setError("");
    setNotice("");
  }

  function resetForm() {
    setForm(emptyForm);
    setError("");
  }

  function buildDraft(): MarkdownTemplateDraft {
    return {
      scope,
      name: form.name,
      description: form.description,
      body: form.body
    };
  }

  function handleSave() {
    if (!form.name.trim() || !form.body.trim()) {
      setError(ui("模板名称和正文不能为空。"));
      return;
    }

    try {
      if (form.id) {
        updateUserMarkdownTemplate(form.id, buildDraft());
      } else {
        saveUserMarkdownTemplate(buildDraft());
      }
      resetForm();
      setNotice(ui("模板已保存。"));
      onTemplatesChanged();
    } catch {
      setError(ui("模板操作失败。"));
    }
  }

  function handleDelete(template: MarkdownTemplate) {
    if (template.source !== "user") return;
    setConfirmation({ kind: "delete", template });
    setError("");
    setNotice("");
  }

  function confirmDelete(template: MarkdownTemplate) {
    try {
      deleteUserMarkdownTemplate(template.id, scope);
      if (form.id === template.id) resetForm();
      setNotice(ui("模板已删除。"));
      setConfirmation(undefined);
      onTemplatesChanged();
    } catch {
      setError(ui("模板操作失败。"));
    }
  }

  function handleCopy(template: MarkdownTemplate) {
    try {
      copyBuiltInMarkdownTemplate(template, scope, ui("副本"));
      setNotice(ui("已复制为用户模板。"));
      onTemplatesChanged();
    } catch {
      setError(ui("模板操作失败。"));
    }
  }

  function handleResetScope() {
    setConfirmation({ kind: "reset" });
    setError("");
    setNotice("");
  }

  function confirmResetScope() {
    try {
      resetUserMarkdownTemplates(scope);
      resetForm();
      setNotice(ui("用户模板已重置。"));
      setConfirmation(undefined);
      onTemplatesChanged();
    } catch {
      setError(ui("模板操作失败。"));
    }
  }

  return (
    <section className="markdown-template-manager" aria-label={ui("管理模板")}>
      <div className="markdown-template-manager-header">
        <strong>{ui("管理模板")}</strong>
        <button type="button" onClick={handleResetScope}>
          {ui("重置模板")}
        </button>
      </div>

      {confirmation ? (
        <section className="markdown-template-confirmation" role="alertdialog" aria-modal="false">
          <span>
            {confirmation.kind === "delete"
              ? ui("确认删除该用户模板？")
              : ui("确认重置当前范围的用户模板？")}
          </span>
          <div className="markdown-template-row-actions">
            <button
              type="button"
              onClick={() => confirmation.kind === "delete"
                ? confirmDelete(confirmation.template)
                : confirmResetScope()}
            >
              {ui("确认")}
            </button>
            <button type="button" onClick={() => setConfirmation(undefined)}>{ui("取消")}</button>
          </div>
        </section>
      ) : null}

      <div className="markdown-template-manager-grid">
        <div className="markdown-template-manager-list">
          {templates.map((template) => (
            <article className="markdown-template-manager-row" key={template.id}>
              <div>
                <strong>{template.name}</strong>
                <span className="markdown-template-meta">
                  {template.source === "builtIn" ? ui("内置模板") : ui("用户模板")}
                  {template.scope === "common" ? ` · ${ui("通用模板")}` : ""}
                </span>
              </div>
              <div className="markdown-template-row-actions">
                {template.source === "builtIn" ? (
                  <button type="button" onClick={() => handleCopy(template)}>
                    {ui("复制为用户模板")}
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={() => startEdit(template)}>
                      {ui("编辑模板")}
                    </button>
                    <button type="button" onClick={() => handleDelete(template)}>
                      {ui("删除模板")}
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>

        <div className="markdown-template-form">
          <strong>{form.id ? ui("编辑模板") : ui("新建模板")}</strong>
          <label>
            {ui("模板名称")}
            <input
              type="text"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label>
            {ui("模板说明")}
            <input
              type="text"
              value={form.description}
              onChange={(event) =>
                setForm((current) => ({ ...current, description: event.target.value }))
              }
            />
          </label>
          <label>
            {ui("模板正文")}
            <textarea
              value={form.body}
              onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
            />
          </label>
          {error ? <p className="markdown-template-error">{error}</p> : null}
          {notice ? <p className="markdown-template-notice">{notice}</p> : null}
          <div className="markdown-template-form-actions">
            <button type="button" onClick={handleSave}>
              {ui("保存模板")}
            </button>
            <button type="button" onClick={resetForm}>
              {ui("取消")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
