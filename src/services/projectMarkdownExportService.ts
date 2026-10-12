import { buildProjectAIContext } from "./aiContextBuilderService";
import { buildAIContextHumanReadablePreview } from "./aiContextPreviewDisplayService";
import { sanitizeFileName, saveTextFile } from "./exportService";
import type { Language } from "../i18n/translations";

export type PreparedProjectMarkdown = Readonly<{
  title: string;
  fileName: string;
  markdown: string;
}>;

/** Read-only projection of the existing Project context, not an import protocol. */
export const projectMarkdownExportService = {
  async prepare(projectId: string, language: Language): Promise<PreparedProjectMarkdown> {
    const contextPackage = await buildProjectAIContext(projectId, {
      contextMode: "STANDARD",
      researchObjects: [],
      selectedMaterials: [],
      approvedContextRequestContributions: []
    });
    if (contextPackage.warnings?.some(warning => warning.severity === "error")) {
      throw new Error("Project context is unavailable.");
    }
    const title = contextPackage.scope.label || "Project";
    const { markdown } = buildAIContextHumanReadablePreview({ contextPackage, language });
    const boundary = language === "zh-CN"
      ? "> 科研上下文快照；不是 Project JSON 交换文件或完整备份。不含文件正文。"
      : "> Research context snapshot; not a Project JSON exchange file or complete backup. File bodies are excluded.";
    return Object.freeze({ title, fileName: `${sanitizeFileName(title)}-context.md`, markdown: `${boundary}\n\n${markdown}\n` });
  },
  savePrepared(prepared: PreparedProjectMarkdown) {
    return saveTextFile(prepared.fileName, prepared.markdown, "text/markdown;charset=utf-8");
  }
};
