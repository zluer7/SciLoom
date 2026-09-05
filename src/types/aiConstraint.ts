export type AIConstraintCategory =
  | "NORMAL_QA"
  | "PARSE_DRAFT"
  | "QUICK_ANALYSIS";

export type AIConstraintCategoryLifecycle = "ACTIVE";

export type AIConstraintLegacySourceMarker = "PRE_A3_ORDINARY_CHAT_SOURCE";

export interface AIExecutableBoundedPolicyIdentity {
  documentId: string;
  semanticVersion: number;
}

export interface AIActiveConstraintDescriptor {
  category: "NORMAL_QA" | "PARSE_DRAFT" | "QUICK_ANALYSIS";
  lifecycle: "ACTIVE";
  constraintRef: string;
  constraintVersion: number;
  sharedInvariantRef: string;
  sharedInvariantVersion: number;
  boundedPolicyRefs?: string[];
  executableBoundedPolicies?: AIExecutableBoundedPolicyIdentity[];
}

export type AIConstraintDescriptor = AIActiveConstraintDescriptor;

export interface AISharedInvariantSemanticSegment {
  kind: "shared_invariant";
  ref: string;
  version: number;
  text: string;
}

export interface AICategoryPolicySemanticSegment {
  kind: "category_policy";
  category: "NORMAL_QA" | "PARSE_DRAFT" | "QUICK_ANALYSIS";
  ref: string;
  version: number;
  boundedPolicyRefs?: string[];
  text: string;
}

export interface AIBoundedPolicySemanticSegment {
  kind: "bounded_policy";
  ref: string;
  version: number;
  text: string;
}

/** A3-owned order: shared invariant, category policy, then at most one eligible bounded policy. */
export type AIConstraintSemanticSegments =
  | [AISharedInvariantSemanticSegment, AICategoryPolicySemanticSegment]
  | [AISharedInvariantSemanticSegment, AICategoryPolicySemanticSegment, AIBoundedPolicySemanticSegment];

export type AIConstraintResolutionRequest =
  | {
      kind: "current";
      category: AIConstraintCategory;
    }
  | {
      kind: "frozen";
      descriptor: AIActiveConstraintDescriptor;
      legacySourceMarker?: AIConstraintLegacySourceMarker;
    };
