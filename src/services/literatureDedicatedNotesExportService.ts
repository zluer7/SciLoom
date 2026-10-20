import type { Language } from "../i18n/translations";
import { nonPlanningUi } from "../i18n/nonPlanningI18n";
import { saveTextFile, sanitizeFileName } from "./exportService";
import { literatureService } from "./literatureService";
import { planningService } from "./planningService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import { projectStructuredSidebarValues } from "./manuscriptStructuredSidebarService";

export type DedicatedNotesExportIdentity = Readonly<{
  literatureId: string;
  projectId: string | null;
}>;

export type PreparedDedicatedNotesExport = Readonly<{
  identity: DedicatedNotesExportIdentity;
  title: string;
  fileName: string;
  markdown: string;
  byteLength: number;
  sha256: string;
}>;

async function readSource(identity: DedicatedNotesExportIdentity) {
  const decision = await resolveMountedManuscriptLifecycleDecision({
    ownerType: "literature", ownerId: identity.literatureId, manuscriptChannel: "dedicated_notes"
  });
  const literature = await literatureService.getLiteratureById(identity.literatureId);
  if (!decision.canRead || !literature || literature.deletedAt ||
    literature.id !== identity.literatureId || (literature.primaryProjectId || null) !== identity.projectId) {
    throw new Error("DEDICATED_NOTES_EXPORT_SOURCE_UNAVAILABLE");
  }
  if (identity.projectId) {
    const project = await planningService.getProjectById(identity.projectId);
    if (!project || project.deletedAt) throw new Error("DEDICATED_NOTES_EXPORT_PROJECT_UNAVAILABLE");
  }
  return literature;
}

function heading(text: string) {
  return text.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>#+!|])/g, "\\$1");
}

// Fenced plain text preserves the same literal multiline content as the card,
// including Markdown punctuation, without interpreting it as export structure.
function fieldText(value: string, empty: string) {
  if (!value) return empty;
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${value}\n${fence}`;
}

export const literatureDedicatedNotesExportService = {
  async prepare(identity: DedicatedNotesExportIdentity, language: Language): Promise<PreparedDedicatedNotesExport> {
    const admitted = Object.freeze({ ...identity });
    const source = await readSource(admitted);
    const lookup = { ownerType: "literature", ownerId: source.id, channel: "dedicated_notes" } as const;
    const descriptor = getManuscriptOutlineDescriptor(lookup);
    const values = projectStructuredSidebarValues(lookup, source);
    const ui = (text: string) => nonPlanningUi(language, text);
    const markdown = [
      `# ${heading(source.title)} — ${ui("专属课题笔记")}`, "",
      `> ${ui("已保存的结构笔记；不含文稿正文。")}`, "",
      ...descriptor.fields.flatMap(field => [
        `## ${ui(field.displayLabel)}`, "", fieldText(values[field.stableKey], ui("未设置")), ""
      ])
    ].join("\n");
    const bytes = new TextEncoder().encode(markdown);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Object.freeze({
      identity: admitted, title: source.title,
      fileName: `${sanitizeFileName(source.title.replace(/[\x00-\x1f\x7f]/g, " ")) || "literature"}-dedicated-notes.md`, markdown,
      byteLength: bytes.byteLength,
      sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
    });
  },

  async savePrepared(snapshot: PreparedDedicatedNotesExport, isCurrent: () => boolean) {
    // Revalidate identity/lifecycle before opening the dialog; never replace the
    // frozen text while the native writer is in flight, even if selection changes.
    await readSource(snapshot.identity);
    if (!isCurrent()) return { snapshot, status: "stale" as const };
    const result = await saveTextFile(snapshot.fileName, snapshot.markdown, "text/markdown;charset=utf-8");
    return { snapshot, status: result.saved ? "saved" as const : "canceled" as const, result };
  }
};
