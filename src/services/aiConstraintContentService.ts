import contextRequestBoundedPolicyV1 from "../resources/ai-constraints/context-request-bounded-policy.v1.md?raw";
import contextRequestBoundedPolicyV2 from "../resources/ai-constraints/context-request-bounded-policy.v2.md?raw";
import contextRequestBoundedPolicyV3 from "../resources/ai-constraints/context-request-bounded-policy.v3.md?raw";
import contextRequestBoundedPolicyV4 from "../resources/ai-constraints/context-request-bounded-policy.v4.md?raw";
import contextRequestBoundedPolicyV5 from "../resources/ai-constraints/context-request-bounded-policy.v5.md?raw";
import literatureObjectiveOutlineBoundedPolicyV1 from "../resources/ai-constraints/literature-objective-outline-bounded-policy.v1.md?raw";
import parseSemanticCorrectionBoundedPolicyV1 from "../resources/ai-constraints/parse-semantic-correction-bounded-policy.v1.md?raw";
import normalQaCategoryPolicyV1 from "../resources/ai-constraints/normal-qa-category-policy.v1.md?raw";
import normalQaCategoryPolicyV2 from "../resources/ai-constraints/normal-qa-category-policy.v2.md?raw";
import normalQaCategoryPolicyV3 from "../resources/ai-constraints/normal-qa-category-policy.v3.md?raw";
import normalQaCategoryPolicyV4 from "../resources/ai-constraints/normal-qa-category-policy.v4.md?raw";
import normalQaCategoryPolicyV5 from "../resources/ai-constraints/normal-qa-category-policy.v5.md?raw";
import normalQaCategoryPolicyV6 from "../resources/ai-constraints/normal-qa-category-policy.v6.md?raw";
import normalQaCategoryPolicyV7 from "../resources/ai-constraints/normal-qa-category-policy.v7.md?raw";
import normalQaCategoryPolicyV8 from "../resources/ai-constraints/normal-qa-category-policy.v8.md?raw";
import normalQaCategoryPolicyV9 from "../resources/ai-constraints/normal-qa-category-policy.v9.md?raw";
import normalQaCategoryPolicyV10 from "../resources/ai-constraints/normal-qa-category-policy.v10.md?raw";
import normalQaCategoryPolicyV11 from "../resources/ai-constraints/normal-qa-category-policy.v11.md?raw";
import normalQaCategoryPolicyV12 from "../resources/ai-constraints/normal-qa-category-policy.v12.md?raw";
import normalQaCategoryPolicyV13 from "../resources/ai-constraints/normal-qa-category-policy.v13.md?raw";
import normalQaCategoryPolicyV14 from "../resources/ai-constraints/normal-qa-category-policy.v14.md?raw";
import normalQaCategoryPolicyV15 from "../resources/ai-constraints/normal-qa-category-policy.v15.md?raw";
import normalQaCategoryPolicyV16 from "../resources/ai-constraints/normal-qa-category-policy.v16.md?raw";
import parseDraftCategoryPolicyV1 from "../resources/ai-constraints/parse-draft-category-policy.v1.md?raw";
import parseDraftCategoryPolicyV2 from "../resources/ai-constraints/parse-draft-category-policy.v2.md?raw";
import parseDraftCategoryPolicyV3 from "../resources/ai-constraints/parse-draft-category-policy.v3.md?raw";
import parseDraftCategoryPolicyV4 from "../resources/ai-constraints/parse-draft-category-policy.v4.md?raw";
import parseDraftCategoryPolicyV5 from "../resources/ai-constraints/parse-draft-category-policy.v5.md?raw";
import parseDraftCategoryPolicyV6 from "../resources/ai-constraints/parse-draft-category-policy.v6.md?raw";
import parseDraftCategoryPolicyV7 from "../resources/ai-constraints/parse-draft-category-policy.v7.md?raw";
import parseDraftCategoryPolicyV8 from "../resources/ai-constraints/parse-draft-category-policy.v8.md?raw";
import parseDraftCategoryPolicyV9 from "../resources/ai-constraints/parse-draft-category-policy.v9.md?raw";
import parseDraftCategoryPolicyV10 from "../resources/ai-constraints/parse-draft-category-policy.v10.md?raw";
import parseDraftCategoryPolicyV11 from "../resources/ai-constraints/parse-draft-category-policy.v11.md?raw";
import parseDraftCategoryPolicyV12 from "../resources/ai-constraints/parse-draft-category-policy.v12.md?raw";
import parseDraftCategoryPolicyV13 from "../resources/ai-constraints/parse-draft-category-policy.v13.md?raw";
import parseDraftCategoryPolicyV14 from "../resources/ai-constraints/parse-draft-category-policy.v14.md?raw";
import parseDraftCategoryPolicyV15 from "../resources/ai-constraints/parse-draft-category-policy.v15.md?raw";
import parseDraftCategoryPolicyV16 from "../resources/ai-constraints/parse-draft-category-policy.v16.md?raw";
import parseDraftCategoryPolicyV17 from "../resources/ai-constraints/parse-draft-category-policy.v17.md?raw";
import parseDraftCategoryPolicyV18 from "../resources/ai-constraints/parse-draft-category-policy.v18.md?raw";
import parseDraftCategoryPolicyV19 from "../resources/ai-constraints/parse-draft-category-policy.v19.md?raw";
import parseDraftCategoryPolicyV20 from "../resources/ai-constraints/parse-draft-category-policy.v20.md?raw";
import parseDraftCategoryPolicyV21 from "../resources/ai-constraints/parse-draft-category-policy.v21.md?raw";
import parseDraftCategoryPolicyV22 from "../resources/ai-constraints/parse-draft-category-policy.v22.md?raw";
import parseDraftCategoryPolicyV23 from "../resources/ai-constraints/parse-draft-category-policy.v23.md?raw";
import parseDraftCategoryPolicyV24 from "../resources/ai-constraints/parse-draft-category-policy.v24.md?raw";
import parseDraftCategoryPolicyV25 from "../resources/ai-constraints/parse-draft-category-policy.v25.md?raw";
import parseDraftCategoryPolicyV26 from "../resources/ai-constraints/parse-draft-category-policy.v26.md?raw";
import quickAnalysisCategoryPolicyV1 from "../resources/ai-constraints/quick-analysis-category-policy.v1.md?raw";
import quickAnalysisCategoryPolicyV2 from "../resources/ai-constraints/quick-analysis-category-policy.v2.md?raw";
import quickAnalysisCategoryPolicyV3 from "../resources/ai-constraints/quick-analysis-category-policy.v3.md?raw";
import quickAnalysisCategoryPolicyV4 from "../resources/ai-constraints/quick-analysis-category-policy.v4.md?raw";
import sharedInvariantV1 from "../resources/ai-constraints/shared-invariant.v1.md?raw";
import sharedInvariantV2 from "../resources/ai-constraints/shared-invariant.v2.md?raw";
import type {
  AIConstraintContentRegistryEntry,
  AIConstraintContentRequest,
  AIResolvedConstraintContent
} from "../types/aiConstraintContent";

type AIConstraintContentRuntimeEntry = AIConstraintContentRegistryEntry & {
  packagedContent: unknown;
};

const CONSTRAINT_CONTENT_REGISTRY: readonly AIConstraintContentRuntimeEntry[] = Object.freeze([
  Object.freeze({
    documentId: "labpod.ai.constraint.shared_invariant",
    semanticVersion: 1,
    role: "SHARED_INVARIANT",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/shared-invariant.v1.md",
    packagedContent: sharedInvariantV1
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.shared_invariant",
    semanticVersion: 2,
    role: "SHARED_INVARIANT",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/shared-invariant.v2.md",
    packagedContent: sharedInvariantV2
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 1,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v1.md",
    packagedContent: normalQaCategoryPolicyV1
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 2,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v2.md",
    packagedContent: normalQaCategoryPolicyV2
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 3,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v3.md",
    packagedContent: normalQaCategoryPolicyV3
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 4,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v4.md",
    packagedContent: normalQaCategoryPolicyV4
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 5,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v5.md",
    packagedContent: normalQaCategoryPolicyV5
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 6,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v6.md",
    packagedContent: normalQaCategoryPolicyV6
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 7,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v7.md",
    packagedContent: normalQaCategoryPolicyV7
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 8,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v8.md",
    packagedContent: normalQaCategoryPolicyV8
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 9,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v9.md",
    packagedContent: normalQaCategoryPolicyV9
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 10,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v10.md",
    packagedContent: normalQaCategoryPolicyV10
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 11,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v11.md",
    packagedContent: normalQaCategoryPolicyV11
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 12,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v12.md",
    packagedContent: normalQaCategoryPolicyV12
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 13,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v13.md",
    packagedContent: normalQaCategoryPolicyV13
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 14,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v14.md",
    packagedContent: normalQaCategoryPolicyV14
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 15,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v15.md",
    packagedContent: normalQaCategoryPolicyV15
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.normal_qa",
    semanticVersion: 16,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/normal-qa-category-policy.v16.md",
    packagedContent: normalQaCategoryPolicyV16
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 1,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v1.md",
    packagedContent: parseDraftCategoryPolicyV1
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 2,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v2.md",
    packagedContent: parseDraftCategoryPolicyV2
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 3,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v3.md",
    packagedContent: parseDraftCategoryPolicyV3
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 4,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v4.md",
    packagedContent: parseDraftCategoryPolicyV4
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 5,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v5.md",
    packagedContent: parseDraftCategoryPolicyV5
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 6,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v6.md",
    packagedContent: parseDraftCategoryPolicyV6
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 7,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v7.md",
    packagedContent: parseDraftCategoryPolicyV7
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 8,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v8.md",
    packagedContent: parseDraftCategoryPolicyV8
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 9,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v9.md",
    packagedContent: parseDraftCategoryPolicyV9
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 10,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v10.md",
    packagedContent: parseDraftCategoryPolicyV10
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 11,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v11.md",
    packagedContent: parseDraftCategoryPolicyV11
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 12,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v12.md",
    packagedContent: parseDraftCategoryPolicyV12
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 13,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v13.md",
    packagedContent: parseDraftCategoryPolicyV13
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 14,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v14.md",
    packagedContent: parseDraftCategoryPolicyV14
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 15,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v15.md",
    packagedContent: parseDraftCategoryPolicyV15
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 16,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v16.md",
    packagedContent: parseDraftCategoryPolicyV16
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 17,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v17.md",
    packagedContent: parseDraftCategoryPolicyV17
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 18,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v18.md",
    packagedContent: parseDraftCategoryPolicyV18
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 19,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v19.md",
    packagedContent: parseDraftCategoryPolicyV19
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 20,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v20.md",
    packagedContent: parseDraftCategoryPolicyV20
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 21,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v21.md",
    packagedContent: parseDraftCategoryPolicyV21
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 22,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v22.md",
    packagedContent: parseDraftCategoryPolicyV22
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 23,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v23.md",
    packagedContent: parseDraftCategoryPolicyV23
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 24,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v24.md",
    packagedContent: parseDraftCategoryPolicyV24
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 25,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v25.md",
    packagedContent: parseDraftCategoryPolicyV25
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.parse_draft",
    semanticVersion: 26,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-draft-category-policy.v26.md",
    packagedContent: parseDraftCategoryPolicyV26
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.quick_analysis",
    semanticVersion: 1,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/quick-analysis-category-policy.v1.md",
    packagedContent: quickAnalysisCategoryPolicyV1
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.quick_analysis",
    semanticVersion: 2,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/quick-analysis-category-policy.v2.md",
    packagedContent: quickAnalysisCategoryPolicyV2
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.quick_analysis",
    semanticVersion: 3,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/quick-analysis-category-policy.v3.md",
    packagedContent: quickAnalysisCategoryPolicyV3
  }),
  Object.freeze({
    documentId: "labpod.ai.constraint.quick_analysis",
    semanticVersion: 4,
    role: "CATEGORY_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/quick-analysis-category-policy.v4.md",
    packagedContent: quickAnalysisCategoryPolicyV4
  }),
  Object.freeze({
    documentId: "labpod.ai.policy.context_request",
    semanticVersion: 1,
    role: "BOUNDED_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/context-request-bounded-policy.v1.md",
    packagedContent: contextRequestBoundedPolicyV1
  }),
  Object.freeze({
    documentId: "labpod.ai.policy.context_request",
    semanticVersion: 2,
    role: "BOUNDED_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/context-request-bounded-policy.v2.md",
    packagedContent: contextRequestBoundedPolicyV2
  }),
  Object.freeze({
    documentId: "labpod.ai.policy.context_request",
    semanticVersion: 3,
    role: "BOUNDED_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/context-request-bounded-policy.v3.md",
    packagedContent: contextRequestBoundedPolicyV3
  }),
  Object.freeze({
    documentId: "labpod.ai.policy.context_request",
    semanticVersion: 4,
    role: "BOUNDED_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/context-request-bounded-policy.v4.md",
    packagedContent: contextRequestBoundedPolicyV4
  }),
  Object.freeze({
    documentId: "labpod.ai.policy.context_request",
    semanticVersion: 5,
    role: "BOUNDED_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/context-request-bounded-policy.v5.md",
    packagedContent: contextRequestBoundedPolicyV5
  }),
  Object.freeze({
    documentId: "labpod.ai.policy.literature_objective_outline",
    semanticVersion: 1,
    role: "BOUNDED_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/literature-objective-outline-bounded-policy.v1.md",
    packagedContent: literatureObjectiveOutlineBoundedPolicyV1
  }),
  Object.freeze({
    documentId: "labpod.ai.policy.parse_semantic_correction",
    semanticVersion: 1,
    role: "BOUNDED_POLICY",
    lifecycle: "ACTIVE",
    resourceLocator: "vite-raw:ai-constraints/parse-semantic-correction-bounded-policy.v1.md",
    packagedContent: parseSemanticCorrectionBoundedPolicyV1
  })
]);

export const AI_CONSTRAINT_CONTENT_REGISTRY_ENTRIES: readonly AIConstraintContentRegistryEntry[] =
  Object.freeze(CONSTRAINT_CONTENT_REGISTRY.map(({ packagedContent: _packagedContent, ...entry }) =>
    Object.freeze(entry)));

export type AIConstraintContentErrorCode =
  | "constraint_content_request_invalid"
  | "constraint_content_document_unknown"
  | "constraint_content_version_unsupported"
  | "constraint_content_role_mismatch"
  | "constraint_content_lifecycle_mismatch"
  | "constraint_content_reserved"
  | "constraint_content_registry_ambiguous"
  | "constraint_content_registry_resource_mismatch"
  | "constraint_content_resource_empty";

export class AIConstraintContentError extends Error {
  constructor(
    readonly code: AIConstraintContentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AIConstraintContentError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isContentRole(value: unknown): value is AIConstraintContentRequest["role"] {
  return value === "SHARED_INVARIANT" ||
    value === "CATEGORY_POLICY" ||
    value === "BOUNDED_POLICY";
}

function validateRequest(input: unknown): AIConstraintContentRequest {
  const value = asRecord(input);
  if (
    !value ||
    typeof value.documentId !== "string" ||
    !value.documentId.trim() ||
    !Number.isInteger(value.semanticVersion) ||
    (value.semanticVersion as number) <= 0
  ) {
    throw new AIConstraintContentError(
      "constraint_content_request_invalid",
      "A complete exact constraint content identity, version, role, and lifecycle is required."
    );
  }
  if (!isContentRole(value.role)) {
    throw new AIConstraintContentError(
      "constraint_content_role_mismatch",
      "The requested constraint content role is unknown or unsupported."
    );
  }
  if (value.lifecycle !== "ACTIVE" && value.lifecycle !== "RESERVED") {
    throw new AIConstraintContentError(
      "constraint_content_lifecycle_mismatch",
      "The requested constraint content lifecycle is unknown or unsupported."
    );
  }
  return {
    documentId: value.documentId,
    semanticVersion: value.semanticVersion as number,
    role: value.role,
    lifecycle: value.lifecycle
  };
}

/** Allowed source-migration normalization only; it is not a version selector. */
export function normalizeAIConstraintDocumentContent(content: string): string {
  return content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\n+$/u, "");
}

/** Browser-safe deterministic content identity; versioned so the algorithm is explicit. */
export function hashAIConstraintDocumentContent(content: string): string {
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b1;
  for (const byte of new TextEncoder().encode(normalizeAIConstraintDocumentContent(content))) {
    hashA ^= byte;
    hashA = Math.imul(hashA, 0x01000193) >>> 0;
    hashB ^= byte;
    hashB = Math.imul(hashB, 0x01000193) >>> 0;
  }
  return `fnv1a64:${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
}

export function validateAIConstraintContentRegistry(
  entries: readonly AIConstraintContentRegistryEntry[]
): void {
  const activeIdentityKeys = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.documentId.trim() ||
      !Number.isInteger(entry.semanticVersion) ||
      entry.semanticVersion <= 0 ||
      !entry.resourceLocator.trim() ||
      entry.lifecycle !== "ACTIVE" ||
      (
        entry.role !== "SHARED_INVARIANT" &&
        entry.role !== "CATEGORY_POLICY" &&
        entry.role !== "BOUNDED_POLICY"
      )
    ) {
      throw new AIConstraintContentError(
        "constraint_content_request_invalid",
        "Constraint content registry metadata is invalid."
      );
    }
    const identityKey = `${entry.documentId}\u0000${entry.semanticVersion}`;
    if (activeIdentityKeys.has(identityKey)) {
      throw new AIConstraintContentError(
        "constraint_content_registry_ambiguous",
        `More than one ACTIVE constraint document is registered for ${entry.documentId}@${entry.semanticVersion}.`
      );
    }
    activeIdentityKeys.add(identityKey);
  }
}

validateAIConstraintContentRegistry(AI_CONSTRAINT_CONTENT_REGISTRY_ENTRIES);

/** The sole exact packaged-content resolver. */
export function resolveAIConstraintContent(input: unknown): AIResolvedConstraintContent {
  const request = validateRequest(input);
  if (request.lifecycle === "RESERVED") {
    throw new AIConstraintContentError(
      "constraint_content_reserved",
      "RESERVED constraint documents are not executable."
    );
  }

  const documentMatches = CONSTRAINT_CONTENT_REGISTRY.filter(
    (entry) => entry.documentId === request.documentId
  );
  if (documentMatches.length === 0) {
    throw new AIConstraintContentError(
      "constraint_content_document_unknown",
      `Unknown ACTIVE constraint document: ${request.documentId}.`
    );
  }
  const versionMatches = documentMatches.filter(
    (entry) => entry.semanticVersion === request.semanticVersion
  );
  if (versionMatches.length === 0) {
    throw new AIConstraintContentError(
      "constraint_content_version_unsupported",
      `Unsupported constraint document version: ${request.documentId}@${request.semanticVersion}.`
    );
  }
  if (versionMatches.length !== 1) {
    throw new AIConstraintContentError(
      "constraint_content_registry_ambiguous",
      `Ambiguous ACTIVE constraint document: ${request.documentId}@${request.semanticVersion}.`
    );
  }
  const entry = versionMatches[0];
  if (entry.role !== request.role) {
    throw new AIConstraintContentError(
      "constraint_content_role_mismatch",
      `Constraint document ${request.documentId}@${request.semanticVersion} is not ${request.role}.`
    );
  }
  if (entry.lifecycle !== request.lifecycle) {
    throw new AIConstraintContentError(
      "constraint_content_lifecycle_mismatch",
      `Constraint document ${request.documentId}@${request.semanticVersion} lifecycle is not ${request.lifecycle}.`
    );
  }
  if (typeof entry.packagedContent !== "string") {
    throw new AIConstraintContentError(
      "constraint_content_registry_resource_mismatch",
      `Packaged constraint resource binding is invalid for ${entry.resourceLocator}.`
    );
  }
  const content = normalizeAIConstraintDocumentContent(entry.packagedContent);
  if (!content.trim() || content.includes("\0")) {
    throw new AIConstraintContentError(
      "constraint_content_resource_empty",
      `Packaged constraint resource is empty or unusable for ${entry.resourceLocator}.`
    );
  }
  return {
    documentId: entry.documentId,
    semanticVersion: entry.semanticVersion,
    role: entry.role,
    lifecycle: entry.lifecycle,
    resourceLocator: entry.resourceLocator,
    content,
    contentHash: hashAIConstraintDocumentContent(content)
  };
}
