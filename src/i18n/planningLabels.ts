import type { TranslationKey } from "./translations";

type Translate = (key: TranslationKey) => string;

const outputGapStatusKeys: Record<string, TranslationKey> = {
  pending: "outputGapOpen",
  task_created: "outputGapInProgress",
  route_feedback_created: "outputGapInProgress",
  abandoned: "outputGapIgnored",
  open: "outputGapOpen",
  in_progress: "outputGapInProgress",
  partiallyResolved: "outputGapPartiallyResolved",
  partially_resolved: "outputGapPartiallyResolved",
  resolved: "outputGapResolved",
  ignored: "outputGapIgnored"
};

const outputGapTypeKeys: Record<string, TranslationKey> = {
  data: "outputGapTypeData",
  analysis: "outputGapTypeAnalysis",
  validation: "outputGapTypeValidation",
  figure: "outputGapTypeFigure",
  theory: "outputGapTypeTheory",
  literature: "outputGapTypeLiterature",
  writing: "outputGapTypeWriting",
  experiment: "outputGapTypeExperiment",
  code: "outputGapTypeCode",
  other: "outputGapTypeOther"
};

const relationSourceKeys: Record<string, TranslationKey> = {
  entityLink: "relationSourceEntityLink",
  relatedTaskIdFallback: "relationSourceTaskFallback",
  relatedRouteNodeIdFallback: "relationSourceRouteFallback",
  mixed: "relationSourceMixed",
  none: "relationSourceNone"
};

function translatedValue(value: string | undefined, keys: Record<string, TranslationKey>, t: Translate) {
  if (!value) {
    return t("notProvided");
  }

  const key = keys[value];
  return key ? t(key) : value;
}

export function outputGapStatusLabel(value: string | undefined, t: Translate) {
  return translatedValue(value, outputGapStatusKeys, t);
}

export function outputGapTypeLabel(value: string | undefined, t: Translate) {
  return translatedValue(value, outputGapTypeKeys, t);
}

export function relationSourceLabel(value: string | undefined, t: Translate) {
  return translatedValue(value, relationSourceKeys, t);
}

export function priorityLabel(value: string | undefined, t: Translate) {
  if (value === "high" || value === "medium" || value === "low") {
    return t(value);
  }

  return value || t("notProvided");
}
