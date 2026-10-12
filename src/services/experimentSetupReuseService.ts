import type { Experiment, ExperimentRun } from "../types";

/** Only dedicated, already editable setup text. No identity, results or mixed metadata. */
export function experimentSetupDraft(source: Pick<Experiment, "purposeAndQuestion" | "conditionSummary" | "methodSummary">) {
  return {
    purposeAndQuestion: source.purposeAndQuestion ?? "",
    conditionSummary: source.conditionSummary ?? "",
    methodSummary: source.methodSummary ?? ""
  };
}

export function experimentRunSetupDraft(source: Pick<ExperimentRun, "conditionSummary" | "variableParameterSummary" | "methodSummary">) {
  return {
    conditionSummary: source.conditionSummary ?? "",
    variableParameterSummary: source.variableParameterSummary ?? "",
    methodSummary: source.methodSummary ?? ""
  };
}
