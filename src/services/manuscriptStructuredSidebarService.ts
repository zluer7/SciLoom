import { experimentService } from "./experimentService";
import { experimentRunService } from "./experimentRunService";
import { literatureService } from "./literatureService";
import { planningService } from "./planningService";
import { outputConversionService } from "./outputConversionService";
import { outputService } from "./outputService";
import { resolveMountedManuscriptLifecycleDecision } from "./fileRefOwnerValidator";
import { mergeLiteratureCustomFields, type LiteratureCustomFieldPatch } from "./literatureFieldMappingService";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";
import type { ManuscriptOutlineDescriptorLookupIdentity } from "./manuscriptOutlineParser";
import type { ReviewOutlineSection } from "../types/planning";
import type { StructuredSummary } from "../types/outputStructuredSummary";

export type StructuredSidebarIdentity = ManuscriptOutlineDescriptorLookupIdentity & { ownerId: string };
export type StructuredSidebarValues = Record<string, string>;
export interface StructuredSidebarSnapshot {
  identity: StructuredSidebarIdentity;
  values: StructuredSidebarValues;
  readOnly: boolean;
}

async function readOwner(identity: StructuredSidebarIdentity) {
  switch (identity.ownerType) {
    case "experiment": return experimentService.getExperimentById(identity.ownerId);
    case "experimentRun": return experimentRunService.getRunById(identity.ownerId);
    case "literature": return literatureService.getLiteratureById(identity.ownerId);
    case "review": return planningService.getReviewById(identity.ownerId);
    case "resultItem": return outputConversionService.getResultItemById(identity.ownerId);
    case "finding": return outputConversionService.getFindingById(identity.ownerId);
    case "outputCandidate": return outputConversionService.getOutputCandidateById(identity.ownerId);
    case "outputGap": return outputConversionService.getOutputGapById(identity.ownerId);
    case "researchOutput": return outputService.getById(identity.ownerId);
  }
}

export function projectStructuredSidebarValues(identity: StructuredSidebarIdentity, owner: object): StructuredSidebarValues {
  const record = owner as Record<string, unknown>;
  if (identity.ownerType === "review" && record.reviewType !== identity.reviewType) {
    throw new Error("复盘类型已变化，请关闭并重新打开编辑器。");
  }
  return Object.fromEntries(getManuscriptOutlineDescriptor(identity).fields.map((field) => {
    const path = field.persistenceProjectorIdentity.split(".").slice(1);
    let value: unknown = record[path[0]];
    if (path.length === 2 && Array.isArray(value)) {
      const entries = value as Record<string, unknown>[];
      const entry = entries.find((item) => item.key === path[1] || item.id === path[1] || item.name === path[1]);
      value = path[0] === "outlineSections" ? entry?.content : entry?.value;
    }
    return [field.stableKey, typeof value === "string" ? value : ""];
  }));
}

export async function readStructuredSidebar(identity: StructuredSidebarIdentity): Promise<StructuredSidebarSnapshot> {
  const decision = await resolveMountedManuscriptLifecycleDecision({
    ownerType: identity.ownerType, ownerId: identity.ownerId, manuscriptChannel: identity.channel
  });
  const owner = await readOwner(identity);
  if (!owner || !decision.canRead) throw new Error("结构化内容不可读取。");
  const record = owner as unknown as Record<string, unknown>;
  return { identity, values: projectStructuredSidebarValues(identity, owner), readOnly: !decision.canWrite || Boolean(
    record.archivedAt || record.isArchived || record.deletedAt || record.status === "archived" || record.captureState === "archived"
  ) };
}

/** Ordinary structured edits only. No Raw file, Binding, Switch or Archive operations. */
export async function saveStructuredSidebar(baseline: StructuredSidebarSnapshot, draft: StructuredSidebarValues) {
  const identity = baseline.identity;
  const current = await readStructuredSidebar(identity);
  if (current.readOnly) throw new Error("当前对象为只读，结构化草稿未保存。");
  if (JSON.stringify(current.values) !== JSON.stringify(baseline.values)) {
    throw new Error("结构化内容已在其它入口变化。草稿保留；请取消草稿并重新打开后核对。");
  }
  const fields = getManuscriptOutlineDescriptor(identity).fields;
  if (Object.keys(draft).length !== fields.length || fields.some((field) => typeof draft[field.stableKey] !== "string")) {
    throw new Error("结构化草稿字段不完整。");
  }
  const normalized = Object.fromEntries(fields.map((field) => [field.stableKey, draft[field.stableKey].trim()]));
  if (JSON.stringify(normalized) === JSON.stringify(current.values)) return current;
  const direct = Object.fromEntries(fields.filter((field) => field.persistenceProjectorIdentity.split(".").length === 2)
    .map((field) => [field.persistenceProjectorIdentity.split(".")[1], normalized[field.stableKey] || null]));
  let saved: unknown;
  switch (identity.ownerType) {
    case "experiment":
      saved = await experimentService.updateExperiment(identity.ownerId, {
        purposeAndQuestion: normalized.purposeAndQuestion || undefined,
        conditionSummary: normalized.conditionSummary || undefined, methodSummary: normalized.methodSummary || undefined,
        resultSummary: normalized.resultSummary || undefined, conclusionAndNextSteps: normalized.conclusionAndNextSteps || undefined,
        other: normalized.other || undefined
      });
      break;
    case "experimentRun":
      saved = await experimentRunService.updateExperimentRun(identity.ownerId, {
        conditionSummary: normalized.conditionSummary || undefined, variableParameterSummary: normalized.variableParameterSummary || undefined,
        methodSummary: normalized.methodSummary || undefined, resultSummary: normalized.resultSummary || undefined,
        conclusion: normalized.conclusionNotes || undefined, summaryOther: normalized.other || undefined
      });
      break;
    case "literature": {
      const owner = await literatureService.getLiteratureById(identity.ownerId);
      if (!owner) throw new Error("文献不可读取。");
      const customPatch = Object.fromEntries(fields.filter((field) => field.persistenceProjectorIdentity.includes(".customFields."))
        .map((field) => [field.persistenceProjectorIdentity.split(".")[2], normalized[field.stableKey] || null])) as LiteratureCustomFieldPatch;
      saved = await literatureService.updateLiterature(identity.ownerId, {
        ...(identity.channel === "literature_outline" ? { abstract: normalized.summary || undefined } : {}),
        customFields: mergeLiteratureCustomFields(owner, customPatch)
      });
      break;
    }
    case "review":
      saved = await planningService.updateReview(identity.ownerId, {
        outlineSections: fields.map((field) => ({ key: field.stableKey, content: normalized[field.stableKey], order: field.order })) as ReviewOutlineSection[]
      });
      break;
    default: {
      const structuredSummary: StructuredSummary = fields.filter((field) => field.persistenceProjectorIdentity.includes(".structuredSummary."))
        .map((field) => ({ key: field.stableKey, value: normalized[field.stableKey], order: field.order }));
      const patch = { structuredSummary, summary: String(direct.summary ?? ""), description: String(direct.description ?? "") };
      switch (identity.ownerType) {
        case "resultItem": saved = await outputConversionService.updateResultItem(identity.ownerId, { summary: patch.summary, structuredSummary }); break;
        case "finding": saved = await outputConversionService.updateFinding(identity.ownerId, { summary: patch.summary, structuredSummary }); break;
        case "outputCandidate": saved = await outputConversionService.updateOutputCandidate(identity.ownerId, { description: patch.description, structuredSummary }); break;
        case "outputGap": saved = await outputConversionService.updateOutputGap(identity.ownerId, { description: patch.description, structuredSummary }); break;
        case "researchOutput": saved = await outputService.update(identity.ownerId, { description: patch.description, structuredSummary }); break;
      }
    }
  }
  if (!saved) throw new Error("结构化保存未确认。草稿保留，请核对正式内容后重试。");
  const readback = await readStructuredSidebar(identity);
  if (JSON.stringify(readback.values) !== JSON.stringify(normalized)) {
    throw new Error("结构化保存后的读回与草稿不同。草稿保留；请核对已提交内容，勿盲目重复保存。");
  }
  return readback;
}
