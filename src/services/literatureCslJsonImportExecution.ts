import type { LiteratureCreateResult, CreateLiteratureInput } from "./literatureService";
import { literatureService } from "./literatureService";
import type { CslImportEntry } from "./literatureCslJsonImport";

export type CslImportItemResult = {
  index: number;
  title: string;
  status: "created" | "created_partial" | "skipped_invalid" | "rejected" | "pending_review" | "unprocessed";
  literatureId?: string;
  message?: string;
};

export type CslImportExecutionResult = {
  items: CslImportItemResult[];
  createdIds: string[];
};

type CreateLiterature = (input: CreateLiteratureInput) => Promise<LiteratureCreateResult>;

export async function executeLiteratureCslJsonImport(
  entries: CslImportEntry[],
  create: CreateLiterature = literatureService.createLiterature
): Promise<CslImportExecutionResult> {
  const items: CslImportItemResult[] = [];
  const createdIds: string[] = [];
  let uncertain = false;
  for (const entry of entries) {
    const base = { index: entry.index, title: entry.title };
    if (!entry.input) {
      items.push({ ...base, status: "skipped_invalid", message: entry.errors.join("；") });
      continue;
    }
    if (uncertain) {
      items.push({ ...base, status: "unprocessed", message: "前一条提交结果待核对，本条未提交。" });
      continue;
    }
    try {
      const result = await create(entry.input);
      const id = result.literatureId ?? result.literature?.id;
      if (id) {
        createdIds.push(id);
        items.push({
          ...base,
          status: result.status === "partial" ? "created_partial" : "created",
          literatureId: id,
          message: [...result.warnings, ...result.errors].join("；") || undefined
        });
      } else if (result.failedStep === "project-validation") {
        items.push({ ...base, status: "rejected", message: result.errors.join("；") });
      } else {
        uncertain = true;
        items.push({
          ...base,
          status: "pending_review",
          message: result.errors.join("；") || "正式创建结果无法确认；不得直接重试。"
        });
      }
    } catch (error) {
      uncertain = true;
      items.push({
        ...base,
        status: "pending_review",
        message: error instanceof Error ? error.message : "正式创建结果无法确认；不得直接重试。"
      });
    }
  }
  return { items, createdIds };
}
