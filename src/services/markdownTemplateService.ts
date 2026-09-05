import { nonPlanningUi } from "../i18n/nonPlanningI18n";
import type { Language } from "../i18n/translations";
import type {
  MarkdownTemplate,
  MarkdownTemplateDraft,
  MarkdownTemplateScope,
  MarkdownTemplateStoragePayload
} from "../types/markdownTemplate";

export const MARKDOWN_TEMPLATE_STORAGE_KEY = "labpod.markdownTemplates.v1";

function ui(language: Language, source: string) {
  return nonPlanningUi(language, source);
}

function getStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createUserTemplateId() {
  return `user-md-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function experimentRecordTemplate(language: Language) {
  if (language === "en-US") {
    return [
      "## Purpose",
      "",
      "## Conditions",
      "",
      "## Methods",
      "",
      "## Process",
      "",
      "## Issues",
      "",
      "## Results",
      "",
      "## Conclusions",
      "",
      "## Notes"
    ].join("\n");
  }

  return [
    "## 目的",
    "",
    "## 条件",
    "",
    "## 方法",
    "",
    "## 过程",
    "",
    "## 异常",
    "",
    "## 结果",
    "",
    "## 结论",
    "",
    "## 备注"
  ].join("\n");
}

function experimentRunRecordTemplate(language: Language) {
  if (language === "en-US") {
    return [
      "## Run conditions",
      "",
      "## Variables and parameters",
      "",
      "## Execution process",
      "",
      "## Issues",
      "",
      "## Results",
      "",
      "## Conclusions",
      "",
      "## Notes"
    ].join("\n");
  }

  return [
    "## 运行条件",
    "",
    "## 变量与参数",
    "",
    "## 执行过程",
    "",
    "## 异常记录",
    "",
    "## 结果",
    "",
    "## 结论",
    "",
    "## 补充说明"
  ].join("\n");
}

function commonRecordTemplate(language: Language) {
  if (language === "en-US") {
    return [
      "## Background",
      "",
      "## Key points",
      "",
      "## Evidence",
      "",
      "## Conclusions",
      "",
      "## Next steps"
    ].join("\n");
  }

  return [
    "## 背景",
    "",
    "## 要点",
    "",
    "## 证据",
    "",
    "## 结论",
    "",
    "## 下一步"
  ].join("\n");
}

function normalizeUserTemplate(template: unknown): MarkdownTemplate | null {
  if (!template || typeof template !== "object") return null;
  const candidate = template as Partial<MarkdownTemplate>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.scope !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.body !== "string" ||
    candidate.source !== "user"
  ) {
    return null;
  }

  const allowedScopes: MarkdownTemplateScope[] = [
    "experimentRecord",
    "experimentRunRecord",
    "literatureRecord",
    "literatureOutline",
    "literatureProjectNotes",
    "reviewRecord",
    "outputRecord",
    "common"
  ];
  if (!allowedScopes.includes(candidate.scope as MarkdownTemplateScope)) return null;

  return {
    id: candidate.id,
    scope: candidate.scope as MarkdownTemplateScope,
    name: candidate.name,
    description: typeof candidate.description === "string" ? candidate.description : undefined,
    body: candidate.body,
    source: "user",
    status: candidate.status === "archived" ? "archived" : "active",
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : undefined,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : undefined
  };
}

function readPayload(): MarkdownTemplateStoragePayload {
  const storage = getStorage();
  if (!storage) return { version: 1, templates: [] };

  try {
    const raw = storage.getItem(MARKDOWN_TEMPLATE_STORAGE_KEY);
    if (!raw) return { version: 1, templates: [] };
    const parsed = JSON.parse(raw) as Partial<MarkdownTemplateStoragePayload>;
    const templates = Array.isArray(parsed.templates)
      ? parsed.templates.map(normalizeUserTemplate).filter((item): item is MarkdownTemplate => Boolean(item))
      : [];
    return { version: 1, templates };
  } catch {
    return { version: 1, templates: [] };
  }
}

function writePayload(payload: MarkdownTemplateStoragePayload) {
  const storage = getStorage();
  if (!storage) {
    throw new Error("Markdown template storage is unavailable.");
  }
  storage.setItem(MARKDOWN_TEMPLATE_STORAGE_KEY, JSON.stringify(payload));
}

function isTemplateVisibleForScope(template: MarkdownTemplate, scope: MarkdownTemplateScope) {
  const includesCommonTemplates =
    scope !== "literatureOutline" && scope !== "literatureProjectNotes";
  return (
    template.status === "active" &&
    (template.scope === scope || (includesCommonTemplates && template.scope === "common"))
  );
}

export function getBuiltInMarkdownTemplates(
  scope?: MarkdownTemplateScope,
  language: Language = "zh-CN"
): MarkdownTemplate[] {
  const templates: MarkdownTemplate[] = [
    {
      id: "built-in-experiment-record",
      scope: "experimentRecord",
      name: ui(language, "实验记录模板"),
      description: ui(language, "用于记录实验目的、条件、方法、过程和结论。"),
      body: experimentRecordTemplate(language),
      source: "builtIn",
      status: "active"
    },
    {
      id: "built-in-experiment-run-record",
      scope: "experimentRunRecord",
      name: ui(language, "Run 记录模板"),
      description: ui(language, "用于记录 Run 条件、变量、执行过程和结果。"),
      body: experimentRunRecordTemplate(language),
      source: "builtIn",
      status: "active"
    },
    {
      id: "built-in-common-record",
      scope: "common",
      name: ui(language, "通用记录模板"),
      description: ui(language, "用于记录通用背景、过程、结论和下一步。"),
      body: commonRecordTemplate(language),
      source: "builtIn",
      status: "active"
    }
  ];

  if (!scope) return templates;
  return templates.filter((template) => isTemplateVisibleForScope(template, scope));
}

export function getUserMarkdownTemplates(): MarkdownTemplate[] {
  return readPayload().templates;
}

export function queryMarkdownTemplates(
  scope: MarkdownTemplateScope,
  language: Language = "zh-CN",
  hostTemplates: MarkdownTemplate[] = []
): MarkdownTemplate[] {
  const byId = new Map<string, MarkdownTemplate>();
  [...getBuiltInMarkdownTemplates(scope, language), ...hostTemplates, ...getUserMarkdownTemplates()]
    .filter((template) => isTemplateVisibleForScope(template, scope))
    .forEach((template) => {
      if (!byId.has(template.id)) {
        byId.set(template.id, template);
      }
    });
  return Array.from(byId.values());
}

export function saveUserMarkdownTemplate(draft: MarkdownTemplateDraft): MarkdownTemplate {
  const name = draft.name.trim();
  const body = draft.body.trim();
  if (!name || !body) {
    throw new Error("Markdown template name and body are required.");
  }

  const payload = readPayload();
  const timestamp = nowIso();
  const template: MarkdownTemplate = {
    id: createUserTemplateId(),
    scope: draft.scope,
    name,
    description: draft.description?.trim() || undefined,
    body,
    source: "user",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  writePayload({ version: 1, templates: [...payload.templates, template] });
  return template;
}

export function updateUserMarkdownTemplate(
  id: string,
  patch: Partial<MarkdownTemplateDraft & { status: MarkdownTemplate["status"] }>
): MarkdownTemplate {
  const payload = readPayload();
  const index = payload.templates.findIndex((template) => template.id === id);
  if (index < 0) {
    throw new Error("Markdown template not found.");
  }

  const current = payload.templates[index];
  const next: MarkdownTemplate = {
    ...current,
    scope: patch.scope ?? current.scope,
    name: patch.name?.trim() || current.name,
    description:
      patch.description === undefined ? current.description : patch.description.trim() || undefined,
    body: patch.body?.trim() || current.body,
    status: patch.status ?? current.status,
    updatedAt: nowIso()
  };
  payload.templates[index] = next;
  writePayload(payload);
  return next;
}

export function deleteUserMarkdownTemplate(id: string, scope?: MarkdownTemplateScope) {
  const payload = readPayload();
  writePayload({
    version: 1,
    templates: payload.templates.filter(
      (template) => template.id !== id || (scope !== undefined && template.scope !== scope)
    )
  });
}

export function resetUserMarkdownTemplates(scope?: MarkdownTemplateScope) {
  if (!scope) {
    writePayload({ version: 1, templates: [] });
    return;
  }

  const payload = readPayload();
  writePayload({
    version: 1,
    templates: payload.templates.filter((template) => template.scope !== scope)
  });
}

export function copyBuiltInMarkdownTemplate(
  template: MarkdownTemplate,
  targetScope: MarkdownTemplateScope = template.scope,
  copySuffix = "Copy"
) {
  return saveUserMarkdownTemplate({
    scope: targetScope,
    name: `${template.name} ${copySuffix}`,
    description: template.description,
    body: template.body
  });
}
