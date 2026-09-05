export type AIConstraintContentRole =
  | "SHARED_INVARIANT"
  | "CATEGORY_POLICY"
  | "BOUNDED_POLICY";

export type AIExecutableConstraintContentRole =
  | "SHARED_INVARIANT"
  | "CATEGORY_POLICY"
  | "BOUNDED_POLICY";

export type AIConstraintContentLifecycle = "ACTIVE" | "RESERVED";

export interface AIConstraintContentRequest {
  documentId: string;
  semanticVersion: number;
  role: AIConstraintContentRole;
  lifecycle: AIConstraintContentLifecycle;
}

export interface AIConstraintContentRegistryEntry {
  documentId: string;
  semanticVersion: number;
  role: AIExecutableConstraintContentRole;
  lifecycle: "ACTIVE";
  resourceLocator: string;
}

export interface AIResolvedConstraintContent
  extends AIConstraintContentRegistryEntry {
  content: string;
  /** Stable packaged-content identity recorded in PromptPackage/CallAttempt provenance. */
  contentHash: string;
}
