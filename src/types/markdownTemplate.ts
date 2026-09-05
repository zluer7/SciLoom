export type MarkdownTemplateScope =
  | "experimentRecord"
  | "experimentRunRecord"
  | "literatureRecord"
  | "literatureOutline"
  | "literatureProjectNotes"
  | "reviewRecord"
  | "outputRecord"
  | "common";

export type MarkdownTemplateSource = "builtIn" | "user";

export type MarkdownTemplateStatus = "active" | "archived";

export type MarkdownTemplate = {
  id: string;
  scope: MarkdownTemplateScope;
  name: string;
  description?: string;
  body: string;
  source: MarkdownTemplateSource;
  status: MarkdownTemplateStatus;
  createdAt?: string;
  updatedAt?: string;
};

export type MarkdownTemplateDraft = {
  scope: MarkdownTemplateScope;
  name: string;
  description?: string;
  body: string;
};

export type MarkdownTemplateStoragePayload = {
  version: 1;
  templates: MarkdownTemplate[];
};
