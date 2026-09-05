import type { EntityId, ISODateString } from "./common";

export const RESEARCHER_PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_RESEARCHER_PROFILE_ID = "researcher-profile-default";

export type ResearcherRole =
  | "master"
  | "phd"
  | "engineer"
  | "teacher"
  | "industry_researcher"
  | "other";

export type ResearcherStage =
  | "exploration"
  | "experiment_validation"
  | "method_refinement"
  | "paper_writing"
  | "patent_preparation"
  | "project_review"
  | "paused"
  | "other";

export type AIVisibility = "private" | "summary_only" | "allow_context";

export interface ResearcherProfile {
  id: EntityId;
  nickname?: string;
  role?: ResearcherRole;
  discipline?: string;
  researchDirections: string[];
  researchKeywords: string[];
  researchSummary?: string;
  currentFocus?: string;
  methodPreferences?: string;
  outputPreferences?: string;
  currentStage?: ResearcherStage;
  aiCommunicationPreference?: string;
  aiGlobalConstraints?: string;
  aiVisibility: AIVisibility;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  schemaVersion: number;
}

export interface SaveResearcherProfileInput {
  nickname?: string;
  role?: ResearcherRole;
  discipline?: string;
  researchDirections?: string[];
  researchKeywords?: string[];
  researchSummary?: string;
  currentFocus?: string;
  methodPreferences?: string;
  outputPreferences?: string;
  currentStage?: ResearcherStage;
  aiCommunicationPreference?: string;
  aiGlobalConstraints?: string;
  aiVisibility?: AIVisibility;
}

export type UpdateResearcherProfileInput = Partial<SaveResearcherProfileInput>;

export interface ResearcherProfileSummary {
  nickname?: string;
  role?: ResearcherRole;
  discipline?: string;
  researchDirections: string[];
  researchKeywords: string[];
  researchSummary?: string;
  currentFocus?: string;
  methodPreferences?: string;
  outputPreferences?: string;
  currentStage?: ResearcherStage;
  aiCommunicationPreference?: string;
  aiGlobalConstraints?: string;
  aiVisibility: AIVisibility;
  summaryText: string;
  updatedAt: ISODateString;
}
