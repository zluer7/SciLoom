import type { Experiment } from "../types/experiment";
import type {
  ExperimentStructuredSummaryDto
} from "../types/experimentEditorContextSummary";
import { getManuscriptOutlineDescriptor } from "./manuscriptOutlineDescriptorRegistry";

export const EXPERIMENT_STRUCTURED_SUMMARY_FIELDS = Object.freeze(
  getManuscriptOutlineDescriptor({ ownerType: "experiment", channel: "primary" }).fields.map((field) => ({
    key: field.stableKey as keyof ExperimentStructuredSummaryDto,
    label: field.displayLabel
  }))
) satisfies ReadonlyArray<{
  key: keyof ExperimentStructuredSummaryDto;
  label: string;
}>;

export function normalizeExperimentContextDisplayValue(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized
    .replace(/[\r\n]+/gu, " ")
    .replace(/(?:file:\/\/\/?|\\\\)[^\s)]+/giu, "[local path]")
    .replace(/[A-Za-z]:[\\/][^\s)]+/gu, "[local path]")
    .replace(/(^|[\s(])\/(?:[^/\s)]+\/)*[^/\s)]+/gu, "$1[local path]");
}

export function createExperimentStructuredSummaryDto(
  experiment: Pick<
    Experiment,
    | "purposeAndQuestion"
    | "conditionSummary"
    | "methodSummary"
    | "resultSummary"
    | "conclusionAndNextSteps"
    | "other"
  >
): ExperimentStructuredSummaryDto {
  return Object.freeze({
    purposeAndQuestion: normalizeExperimentContextDisplayValue(experiment.purposeAndQuestion),
    conditionSummary: normalizeExperimentContextDisplayValue(
      experiment.conditionSummary
    ),
    methodSummary: normalizeExperimentContextDisplayValue(experiment.methodSummary),
    resultSummary: normalizeExperimentContextDisplayValue(experiment.resultSummary),
    conclusionAndNextSteps: normalizeExperimentContextDisplayValue(experiment.conclusionAndNextSteps),
    other: normalizeExperimentContextDisplayValue(experiment.other)
  });
}

export function createExperimentStructuredSummaryItems(
  summary: ExperimentStructuredSummaryDto,
  ui: (source: string) => string
) {
  const emptyText = ui("未填写");
  return EXPERIMENT_STRUCTURED_SUMMARY_FIELDS.map((field) => ({
    key: field.key,
    label: ui(field.label),
    value: summary[field.key] ?? emptyText
  }));
}
