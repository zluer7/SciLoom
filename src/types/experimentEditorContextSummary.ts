export interface ExperimentStructuredSummaryDto {
  purposeAndQuestion: string | null;
  conditionSummary: string | null;
  methodSummary: string | null;
  resultSummary: string | null;
  conclusionAndNextSteps: string | null;
  other: string | null;
}

export interface ExperimentContextSummaryDto {
  basicInfo: {
    experimentName: string | null;
    projectName: string | null;
    rating: string | null;
    tags: readonly string[];
  };
  structuredSummary: ExperimentStructuredSummaryDto;
}
