import type {
  Experiment,
  ExperimentRating
} from "../types/experiment";
import type {
  ExperimentContextSummaryDto
} from "../types/experimentEditorContextSummary";
import { getExperimentDetailContext } from "./experimentSelectorService";
import {
  createExperimentStructuredSummaryDto,
  normalizeExperimentContextDisplayValue
} from "./experimentStructuredSummaryProjection";
import { formatManuscriptContextSummaryMarkdown } from "./manuscriptPresentationNormalization";

export type ExperimentRatingLabelResolver = (
  rating: ExperimentRating
) => string | null;

export interface ExperimentEditorContextSummaryDependencies {
  readContext(experimentId: string): Promise<{
    experiment: Experiment;
    project: { title: string } | null;
  } | null>;
}

export type ExperimentEditorContextSummaryReadResult =
  | { status: "success"; dto: Readonly<ExperimentContextSummaryDto> }
  | {
      status: "error";
      code:
        | "EXPERIMENT_CONTEXT_SUMMARY_NOT_FOUND"
        | "EXPERIMENT_CONTEXT_SUMMARY_PROJECT_MISSING";
    };

function sanitizeContextText(value: unknown) {
  return normalizeExperimentContextDisplayValue(value);
}

function normalizeTags(tags: readonly string[]) {
  return Object.freeze(tags.flatMap((tag) => {
    const normalized = sanitizeContextText(tag);
    return normalized ? [normalized] : [];
  }));
}

export function createExperimentEditorContextSummaryDto(input: {
  experiment: Experiment;
  projectName: string | null | undefined;
  ratingLabel: ExperimentRatingLabelResolver;
}): ExperimentContextSummaryDto {
  const rating = input.experiment.rating
    ? sanitizeContextText(input.ratingLabel(input.experiment.rating))
    : null;
  return Object.freeze({
    basicInfo: Object.freeze({
      experimentName: sanitizeContextText(input.experiment.title),
      projectName: sanitizeContextText(input.projectName),
      rating:
        rating && rating !== input.experiment.rating
          ? rating
          : null,
      tags: normalizeTags(input.experiment.tags)
    }),
    structuredSummary: createExperimentStructuredSummaryDto(input.experiment)
  });
}

function display(value: string | null) {
  return value ?? "未填写";
}

export function serializeExperimentEditorContextSummary(
  dto: Readonly<ExperimentContextSummaryDto>
) {
  return formatManuscriptContextSummaryMarkdown({
    heading: "实验上下文摘要",
    bodyGroups: [[
      `- 实验：${display(dto.basicInfo.experimentName)}`,
      `- 课题：${display(dto.basicInfo.projectName)}`,
      `- 评级：${display(dto.basicInfo.rating)}`,
      `- 标签：${dto.basicInfo.tags.length > 0
        ? dto.basicInfo.tags.join("、")
        : "未填写"}`
    ]],
    descriptorLookupIdentity: { ownerType: "experiment", channel: "primary" },
    structuredValues: { ...dto.structuredSummary },
    emptyValue: "未填写"
  });
}

export function createExperimentEditorContextSummaryService(
  dependencies: ExperimentEditorContextSummaryDependencies = {
    readContext: getExperimentDetailContext
  }
) {
  return Object.freeze({
    async read(
      experimentId: string,
      ratingLabel: ExperimentRatingLabelResolver
    ): Promise<ExperimentEditorContextSummaryReadResult> {
      const context = await dependencies.readContext(experimentId);
      if (!context) {
        return {
          status: "error",
          code: "EXPERIMENT_CONTEXT_SUMMARY_NOT_FOUND"
        };
      }
      if (!context.project) {
        return {
          status: "error",
          code: "EXPERIMENT_CONTEXT_SUMMARY_PROJECT_MISSING"
        };
      }
      return {
        status: "success",
        dto: createExperimentEditorContextSummaryDto({
          experiment: context.experiment,
          projectName: context.project.title,
          ratingLabel
        })
      };
    }
  });
}

export const experimentEditorContextSummaryService =
  createExperimentEditorContextSummaryService();
