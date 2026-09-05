export interface ExperimentRunContextSummaryDto {
  basicInfo: Readonly<{
    entrySummary: string | null;
    projectName: string | null;
    experimentName: string | null;
    runName: string | null;
    rating: string | null;
    tags: readonly string[];
  }>;
  structuredSummary: Readonly<{
    conditionSummary: string | null;
    variableParameterSummary: string | null;
    methodSummary: string | null;
    resultSummary: string | null;
    conclusion: string | null;
    summaryOther: string | null;
  }>;
  manuscript: Readonly<{
    currentFileName: string | null;
    defaultFileName: string | null;
    currentIsDefault: boolean | null;
    currentLocationMode: "managed" | "external" | null;
    readOnly: boolean;
    recoveryPending: boolean;
  }>;
}
