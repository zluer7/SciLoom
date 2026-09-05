import type { Experiment, ExperimentRating, ExperimentRun, FileRef, ManuscriptBindingIdentityResult, Project } from "../types";
import type { ExperimentRunContextSummaryDto } from "../types/experimentRunContextSummary";
import { getProjectById } from "./planningService";
import { getSafeManuscriptBasename, fileRefService } from "./fileRefService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { experimentRunManuscriptPermissionService } from "./experimentRunManuscriptPermissionService";
import { listReferenceOwnerFormalSwitchRecoveries } from "./referenceOwnerFormalSwitchProductionBridge";
import { manuscriptSaveAsOperationPort } from "./manuscriptSaveAsOperationPort";
import { formatManuscriptContextSummaryMarkdown } from "./manuscriptPresentationNormalization";

type PermissionResult = Awaited<ReturnType<typeof experimentRunManuscriptPermissionService.evaluate>>;

export interface ExperimentRunContextSummaryDependencies {
  evaluatePermission(runId: string): Promise<PermissionResult>;
  loadProject(projectId: string): Promise<Project | undefined | null>;
  resolveIdentity(input: {
    ownerType: "experimentRun";
    ownerId: string;
    manuscriptChannel: "primary";
  }): Promise<ManuscriptBindingIdentityResult>;
  loadFileRefs(ownerType: "experimentRun", ownerId: string): Promise<FileRef[]>;
  listSwitchRecoveries(runId: string): Promise<Array<{ phase: string }>>;
  listSaveAsOperations?(runId: string): Promise<Array<{ phase: string }>>;
}

const defaultDependencies: ExperimentRunContextSummaryDependencies = {
  evaluatePermission: (runId) => experimentRunManuscriptPermissionService.evaluate(runId, "read-current"),
  loadProject: getProjectById,
  resolveIdentity: manuscriptBindingService.resolveIdentity,
  loadFileRefs: fileRefService.getFileRefsByOwner,
  listSwitchRecoveries: (runId) =>
    listReferenceOwnerFormalSwitchRecoveries("experimentRun", runId, "primary"),
  async listSaveAsOperations(runId) {
    return (await manuscriptSaveAsOperationPort.listReconcilable())
      .filter((record) =>
        record.ownerType === "experimentRun" &&
        record.ownerId === runId &&
        record.channel === "primary"
      )
      .map((record) => ({ phase: record.stage }));
  }
};

function safeText(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\r\n]+/gu, " ").trim();
  return normalized || null;
}

function safeTags(tags: readonly string[] | undefined) {
  return Object.freeze((tags ?? []).flatMap((tag) => {
    const value = safeText(tag);
    return value ? [value] : [];
  }));
}

const RATING_LABELS: Readonly<Record<ExperimentRating, string>> = Object.freeze({
  excellent: "优秀",
  good: "良好",
  usable: "可用",
  inconclusive: "结论不明确",
  failed: "失败"
});

function ratingLabel(rating: ExperimentRating | undefined) {
  return rating ? RATING_LABELS[rating] : null;
}

export function createExperimentRunContextSummaryDto(input: {
  run: ExperimentRun;
  parent: Experiment;
  projectName: string | null | undefined;
  currentFileName: string | null;
  defaultFileName: string | null;
  currentLocationMode: "managed" | "external" | null;
  currentIsDefault: boolean | null;
  readOnly: boolean;
  recoveryPending: boolean;
}): ExperimentRunContextSummaryDto {
  const rating = safeText(ratingLabel(input.run.rating));
  return Object.freeze({
    basicInfo: Object.freeze({
      entrySummary: safeText(input.run.title),
      projectName: safeText(input.projectName),
      experimentName: safeText(input.parent.title),
      runName: safeText(input.run.title),
      rating,
      tags: safeTags(input.run.tags)
    }),
    structuredSummary: Object.freeze({
      conditionSummary: safeText(input.run.conditionSummary),
      variableParameterSummary: safeText(input.run.variableParameterSummary),
      methodSummary: safeText(input.run.methodSummary),
      resultSummary: safeText(input.run.resultSummary),
      conclusion: safeText(input.run.conclusion),
      summaryOther: safeText(input.run.summaryOther)
    }),
    manuscript: Object.freeze({
      currentFileName: safeText(input.currentFileName),
      defaultFileName: safeText(input.defaultFileName),
      currentIsDefault: input.currentIsDefault,
      currentLocationMode: input.currentLocationMode,
      readOnly: input.readOnly,
      recoveryPending: input.recoveryPending
    })
  });
}

function display(value: string | null) {
  return value ?? "未填写";
}

export function buildExperimentRunContextSummaryMarkdown(
  dto: ExperimentRunContextSummaryDto,
  options: { heading?: string; newline?: string } = {}
) {
  const newline = options.newline ?? "\n";
  return formatManuscriptContextSummaryMarkdown({
    heading: options.heading ?? "Experiment Run 上下文摘要",
    bodyGroups: [[
      `- 条目简介：${display(dto.basicInfo.entrySummary)}`,
      `- 课题：${display(dto.basicInfo.projectName)}`,
      `- 实验：${display(dto.basicInfo.experimentName)}`,
      `- 运行：${display(dto.basicInfo.runName)}`,
      `- 评级：${display(dto.basicInfo.rating)}`,
      `- 标签：${dto.basicInfo.tags.length ? dto.basicInfo.tags.join("、") : "未填写"}`
    ]],
    descriptorLookupIdentity: { ownerType: "experimentRun", channel: "primary" },
    structuredValues: {
      conditionSummary: dto.structuredSummary.conditionSummary,
      variableParameterSummary: dto.structuredSummary.variableParameterSummary,
      methodSummary: dto.structuredSummary.methodSummary,
      resultSummary: dto.structuredSummary.resultSummary,
      conclusionNotes: dto.structuredSummary.conclusion,
      other: dto.structuredSummary.summaryOther
    },
    emptyValue: "未填写",
    newline
  });
}

function activeFile(refs: readonly FileRef[], id?: string | null) {
  return id ? refs.find((ref) => ref.id === id && !ref.deletedAt) : undefined;
}

export function createExperimentRunContextSummaryService(
  dependencies: ExperimentRunContextSummaryDependencies = defaultDependencies
) {
  return Object.freeze({
    async read(runId: string) {
      const permission = await dependencies.evaluatePermission(runId);
      if (permission.status !== "allowed") {
        return { status: "error" as const, code: permission.error.code };
      }
      const { run, parent } = permission;
      if (run.experimentId !== parent.id || run.projectId !== parent.projectId) {
        return { status: "error" as const, code: "RUN_CONTEXT_OWNER_MISMATCH" as const };
      }
      const [project, identity, refs, recoveries, saveAsOperations] = await Promise.all([
        dependencies.loadProject(run.projectId),
        dependencies.resolveIdentity({
          ownerType: "experimentRun",
          ownerId: run.id,
          manuscriptChannel: "primary"
        }),
        dependencies.loadFileRefs("experimentRun", run.id),
        dependencies.listSwitchRecoveries(run.id),
        dependencies.listSaveAsOperations?.(run.id) ?? Promise.resolve([])
      ]);
      if (!project || project.id !== run.projectId) {
        return { status: "error" as const, code: "RUN_CONTEXT_PROJECT_MISSING" as const };
      }
      const current = identity.identityResolved
        ? activeFile(refs, identity.slots.currentFileRefId.fileRefId)
        : undefined;
      const defaultFile = identity.identityResolved
        ? activeFile(refs, identity.slots.defaultManuscriptFileRefId.fileRefId)
        : undefined;
      const recoveryPending = [...recoveries, ...saveAsOperations]
        .some(({ phase }) =>
          !["resolved", "cancelled_safe", "completed", "pre_d1_closed"].includes(phase)
        );
      return {
        status: "success" as const,
        dto: createExperimentRunContextSummaryDto({
          run,
          parent,
          projectName: project.title,
          currentFileName: current ? getSafeManuscriptBasename(current.path) ?? null : null,
          defaultFileName: defaultFile ? getSafeManuscriptBasename(defaultFile.path) ?? null : null,
          currentLocationMode: current?.locationMode ?? null,
          currentIsDefault: current && defaultFile ? current.id === defaultFile.id : null,
          readOnly: permission.readOnly,
          recoveryPending
        })
      };
    }
  });
}

export const experimentRunContextSummaryService = createExperimentRunContextSummaryService();
