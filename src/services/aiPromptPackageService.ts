import { buildProjectAIContext } from "./aiContextBuilderService";
import {
  AI_AUTO_PULL_CONTEXT_DEFAULT_CHARS,
  AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS
} from "./aiPromptBudgetService";
import {
  AI_CONTEXT_REQUEST_BOUNDED_POLICY,
  buildAIConstraintSemanticSegments,
  createAIConstraintSourceRef,
  validateAIActiveConstraintDescriptor
} from "./aiConstraintService";
import { measureAIParseDynamicContextBudget } from "./aiParseDynamicContextBudgetService";
import type {
  AIContextBudgetSummary,
  AIContextExcludedItem,
  AIContextPackage,
  AIContextPriority,
  AIContextRequestFollowupState,
  AIContextSourceRef,
  AIContextWarning,
  AICurrentCallAuthorizedMaterialRef,
  AIOutputDetailPreference,
  AIParseDynamicContextBudgetReceipt,
  AIProviderInputClassLedgerEntry,
  AIProviderPromptEnvelope,
  AIPromptPackage,
  AIProviderPromptHistoryMessage,
  AIQuickAnalysisContextCapability
} from "../types/aiContext";
import type {
  AIActiveConstraintDescriptor,
  AIConstraintLegacySourceMarker,
  AIConstraintSemanticSegments
} from "../types/aiConstraint";
import type { AIContextRequestResponseContract } from "../types/aiContextRequest";
import type { AIStandardResultResponseContract } from "../types/aiStandardResult";

export interface AIPromptPackageBuildOptions {
  constraintDescriptor: AIActiveConstraintDescriptor;
  legacySourceMarker?: AIConstraintLegacySourceMarker;
  technicalCapacityChars: number;
  includeSourceRefs: boolean;
  includeWarnings: boolean;
  contextMarkdownOverride?: string;
  conversationMessages: readonly AICanonicalHistoryMessage[];
  maxConversationHistoryChars: number;
  maxConversationHistoryMessages: number;
  contextRequestResponseContract?: AIContextRequestResponseContract;
  standardResultResponseContract?: AIStandardResultResponseContract;
  /** A6-only immutable orchestration directive, rendered through the canonical sanitizer/budget. */
  runScopedDirective?: string;
  /** Parse-only software-owned delta/owner metadata, counted by the canonical dynamic-context budget. */
  parseDynamicRunScopedSegments?: readonly string[];
  /** Durable provenance refs appended to the same canonical PromptPackage/CallAttempt trace. */
  additionalSourceRefs?: readonly AIContextSourceRef[];
  /** D1-A9 run-local narrowing of the existing Context Request capability. */
  quickAnalysisContextCapability?: AIQuickAnalysisContextCapability;
  /** D1-A14 exact one-round receipt for a same-Conversation approved follow-up. */
  contextRequestFollowupState?: AIContextRequestFollowupState;
  /** Semantic preference only; an explicit current user instruction always wins. */
  outputDetailPreference: AIOutputDetailPreference;
}

export type AIPromptPackageBuildInput =
  Pick<AIPromptPackageBuildOptions, "constraintDescriptor"> &
  Partial<Omit<AIPromptPackageBuildOptions, "constraintDescriptor">>;

export interface AICanonicalHistoryMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
}

export interface AIContextMarkdownRenderOptions {
  includeSourceRefs: boolean;
  includeWarnings: boolean;
  includeExcluded: boolean;
}

const DEFAULT_TECHNICAL_CAPACITY_CHARS = AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS;
export const AI_OUTPUT_DETAIL_PREFERENCE_VALUES: readonly AIOutputDetailPreference[] = Object.freeze([
  "CONCISE",
  "STANDARD",
  "DETAILED",
  "UNRESTRICTED"
]);
export const AI_CONVERSATION_HISTORY_MAX_CHARS = 4_000;
export const AI_CONVERSATION_HISTORY_MAX_MESSAGES = 12;
export const CURRENT_CALL_AUTHORIZED_MATERIAL_CONTRACT_HEADING =
  "## Current-call Authorized Material Contract";

const PRIORITY_RANK: Record<AIContextPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  background: 4
};

type SanitizedText = { text: string; redacted: boolean };
type RenderResult = { markdown: string; redacted: boolean };

function createPromptId(): string {
  return `ai-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function countChars(value: string): number {
  return Array.from(value).length;
}

export function buildCurrentCallAuthorizedMaterialContract(
  authorizedFileRefIds: readonly string[],
  options: { machineContextRequestEnabled?: boolean } = {}
): string {
  const canonicalIds = [...new Set(authorizedFileRefIds)].sort((left, right) => left.localeCompare(right));
  if (
    canonicalIds.length === 0 || canonicalIds.length !== authorizedFileRefIds.length ||
    canonicalIds.some((refId) => !refId.trim() || refId !== refId.trim() || refId.includes("\0"))
  ) {
    throw new Error("authorizedFileRefIds must contain unique canonical identities.");
  }
  const materials: AICurrentCallAuthorizedMaterialRef[] = canonicalIds.map((refId, index) => ({
    ordinal: index + 1,
    refId
  }));
  const machineContextRequestEnabled = options.machineContextRequestEnabled !== false;
  return [
    CURRENT_CALL_AUTHORIZED_MATERIAL_CONTRACT_HEADING,
    `Durable per-call authorization is committed for ${materials.length} selected FileRef ${materials.length === 1 ? "body" : "bodies"} on this exact CallAttempt.`,
    "The canonical backend appends an `Authorized Research Material` section immediately after this contract only after its bounded material read succeeds; Provider execution does not start if that read fails.",
    `Exact current-call inclusion receipt: ${JSON.stringify({
      authorizationScope: "CURRENT_CALL",
      authorizationState: "COMMITTED",
      inclusionState: "INCLUDED_IN_FOLLOWING_AUTHORIZED_RESEARCH_MATERIAL",
      materials
    })}`,
    machineContextRequestEnabled
      ? "Each receipt ordinal maps the exact canonical FileRef identity to the material with the same ordinal in the following section. Those bodies are supplied for this call; use them when they answer the user question and do not request those same FileRefs again."
      : "Each receipt ordinal maps the exact canonical FileRef identity to the material with the same ordinal in the following section. Use those bodies only as research material for this single body-generation call.",
    ...(machineContextRequestEnabled ? [
      "A Context Request is permitted only for a genuinely missing exact ref in the remaining typed requestable index; do not request unrelated refs merely because they are listed.",
      "If a Context Request is necessary, its wrapper must be the entire response with no Markdown fence, prefix, suffix, or second outcome."
    ] : [
      "Machine Context Request is disabled for this call. Return the requested body directly; any legacy wrapper-shaped text is ordinary body text and grants no application control."
    ])
  ].join("\n");
}

function mandatoryLateMaterialTechnicalEstimate(
  contextPackage: AIContextPackage,
  machineContextRequestEnabled: boolean
): {
  characters: number;
  materialCharacters: number;
  contractCharacters: number;
  materialCount: number;
  invalidLabels: string[];
} {
  const decisions = [...new Map((contextPackage.materialDecisions ?? []).map((decision) => [
    decision.fileRefId,
    decision
  ])).values()];
  if (decisions.length === 0) {
    return {
      characters: 0,
      materialCharacters: 0,
      contractCharacters: 0,
      materialCount: 0,
      invalidLabels: []
    };
  }
  const invalidLabels = decisions
    .filter((decision) => (
      !Number.isSafeInteger(decision.materialPromptReservationCharacters) ||
      decision.materialPromptReservationCharacters <= 0 ||
      !decision.materialFreshnessReceipt ||
      decision.materialFreshnessReceipt.fileRefId !== decision.fileRefId ||
      decision.materialFreshnessReceipt.receiptVersion !== "material-source-v1" ||
      !/^[a-f0-9]{64}$/.test(decision.materialFreshnessReceipt.sourceToken)
    ))
    .map((decision) => decision.displayName);
  const materialCharacters = decisions.reduce(
    (total, decision) => total + (
      Number.isSafeInteger(decision.materialPromptReservationCharacters) &&
      decision.materialPromptReservationCharacters > 0
        ? decision.materialPromptReservationCharacters
        : 0
    ),
    0
  );
  // Two characters reserve the section delimiter before the late current-call
  // contract. Each Rust-produced material bound already includes its delimiter.
  const contractCharacters = countChars(buildCurrentCallAuthorizedMaterialContract(
    decisions.map((decision) => decision.fileRefId),
    { machineContextRequestEnabled }
  )) + 2;
  return {
    characters: contractCharacters + materialCharacters,
    materialCharacters,
    contractCharacters,
    materialCount: decisions.length,
    invalidLabels
  };
}

function sanitizeText(value: string): SanitizedText {
  const patterns = [
    /[A-Za-z]:[\\/](?:[^\\/\s|]+[\\/]?)+/g,
    /\\\\[^\s|]+/g,
    /file:\/\/[^\s|]+/gi,
    /\/(?:Users|home|mnt|tmp|var)\/[^\s|]+/g,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bBearer\s+[A-Za-z0-9._-]+\b/gi,
    /\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s|]+/gi,
    /^\s*at\s+.+(?:\(.+:\d+:\d+\)|.+:\d+:\d+)\s*$/gm
  ];
  let text = value.replace(/\0/g, "");
  for (const pattern of patterns) {
    text = text.replace(pattern, "[sensitive content omitted]");
  }
  return { text, redacted: text !== value };
}

function singleLine(value: string): SanitizedText {
  const sanitized = sanitizeText(value);
  return {
    text: sanitized.text.replace(/\s+/g, " ").trim(),
    redacted: sanitized.redacted
  };
}

function sourceRefKey(sourceRef: AIContextSourceRef): string {
  return [sourceRef.module, sourceRef.entityType, sourceRef.entityId, sourceRef.field ?? ""].join(":");
}

function uniqueSourceRefs(sourceRefs: AIContextSourceRef[]): AIContextSourceRef[] {
  const unique = new Map<string, AIContextSourceRef>();
  for (const sourceRef of sourceRefs) unique.set(sourceRefKey(sourceRef), sourceRef);
  return [...unique.values()];
}

function uniqueWarnings(warnings: AIContextWarning[]): AIContextWarning[] {
  const unique = new Map<string, AIContextWarning>();
  for (const warning of warnings) unique.set(`${warning.code}:${warning.message}`, warning);
  return [...unique.values()];
}

function sanitizeSourceRef(sourceRef: AIContextSourceRef): {
  sourceRef: AIContextSourceRef;
  redacted: boolean;
} {
  const entityId = singleLine(sourceRef.entityId);
  const label = sourceRef.label ? singleLine(sourceRef.label) : undefined;
  const field = sourceRef.field ? singleLine(sourceRef.field) : undefined;
  const confidenceNote = sourceRef.confidenceNote
    ? singleLine(sourceRef.confidenceNote)
    : undefined;
  return {
    sourceRef: {
      ...sourceRef,
      entityId: entityId.text,
      label: label?.text,
      field: field?.text,
      confidenceNote: confidenceNote?.text
    },
    redacted:
      entityId.redacted ||
      Boolean(label?.redacted) ||
      Boolean(field?.redacted) ||
      Boolean(confidenceNote?.redacted)
  };
}

function sanitizeSourceRefs(sourceRefs: AIContextSourceRef[]): {
  sourceRefs: AIContextSourceRef[];
  redacted: boolean;
} {
  let redacted = false;
  const sanitized = uniqueSourceRefs(sourceRefs).map((sourceRef) => {
    const result = sanitizeSourceRef(sourceRef);
    redacted ||= result.redacted;
    return result.sourceRef;
  });
  return { sourceRefs: sanitized, redacted };
}

function sourceRefLine(sourceRef: AIContextSourceRef): SanitizedText {
  const entityId = singleLine(sourceRef.entityId);
  const label = singleLine(sourceRef.label ?? "unlabeled source");
  const field = singleLine(sourceRef.field ?? "summary");
  return {
    text: `- [${sourceRef.module}/${sourceRef.entityType}/${entityId.text}] ${label.text} - ${field.text}`,
    redacted: entityId.redacted || label.redacted || field.redacted
  };
}

function warningLine(warning: AIContextWarning): SanitizedText {
  const message = singleLine(warning.message);
  return { text: `- [${warning.severity}/${warning.code}] ${message.text}`, redacted: message.redacted };
}

function excludedLine(excluded: AIContextExcludedItem): SanitizedText {
  const label = singleLine(excluded.label ?? `${excluded.module}/${excluded.entityType}`);
  return { text: `- [${excluded.reason}] ${label.text}`, redacted: label.redacted };
}

/**
 * Provider-only physical serialization of existing frozen owner identities.
 * This does not select, resolve, admit, or grant a capability: it only makes
 * the already-reviewed canonical id mechanically distinguishable from its
 * display title when the human-readable Context override hides internal ids.
 */
export function renderAIProviderOwnerEntityRefs(
  contextPackage: AIContextPackage
): string {
  const serialized: string[] = [];
  const seen = new Set<string>();
  for (const object of contextPackage.researchObjects ?? []) {
    const descriptorSource = object.sourceRef;
    const sourceRef = contextPackage.sourceRefs.find((candidate) => (
      candidate.module === descriptorSource.module &&
      candidate.entityType === descriptorSource.entityType &&
      candidate.entityId === object.objectId &&
      candidate.entityId === descriptorSource.entityId &&
      candidate.contextRole === "primary" &&
      candidate.contextDisposition === "included"
    ));
    if (!sourceRef) continue;
    const key = `${sourceRef.module}\u0000${sourceRef.entityType}\u0000${sourceRef.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entityType = singleLine(sourceRef.entityType);
    const exactCanonicalEntityId = singleLine(sourceRef.entityId);
    const displayTitle = singleLine(object.label);
    const projectId = singleLine(object.projectId);
    serialized.push(`- OwnerEntityRef ${JSON.stringify({
      entityType: entityType.text,
      exactCanonicalEntityId: exactCanonicalEntityId.text,
      displayTitle: displayTitle.text,
      projectId: projectId.text,
      contextMode: sourceRef.contextMode ?? contextPackage.contextMode,
      contextRole: sourceRef.contextRole,
      contextDisposition: sourceRef.contextDisposition
    })}`);
  }
  if (serialized.length === 0) return "";
  return [
    "## Provider-visible OwnerEntityRefs",
    "These are identity-only projections of the exact selected existing objects; capability remains governed by the typed capability contract.",
    "For an existing supported formal manuscript carrier, ownerId must copy OwnerEntityRef.exactCanonicalEntityId exactly. displayTitle is presentation only and must never be used as ownerId.",
    ...serialized
  ].join("\n");
}

function renderContext(
  contextPackage: AIContextPackage,
  options: AIContextMarkdownRenderOptions
): RenderResult {
  let redacted = false;
  const scopeLabel = singleLine(contextPackage.scope.label ?? "Unlabeled scope");
  redacted ||= scopeLabel.redacted;
  const budget = contextPackage.budgetSummary;
  const lines = [
    "# SciLoom Research Context",
    "",
    "## Context Scope",
    `- Type: ${contextPackage.scope.type}`,
    `- Label: ${scopeLabel.text}`,
    "",
    "## Budget Summary",
    `- Used chars: ${budget?.usedChars ?? "Unknown"}`,
    `- Remaining chars: ${budget?.remainingChars ?? "Unknown"}`,
    `- Truncated sections: ${budget?.truncatedSections ?? 0}`,
    `- Excluded items: ${budget?.excludedItems ?? contextPackage.excluded?.length ?? 0}`,
    "",
    "## Sections"
  ];

  const sections = [...contextPackage.sections].sort(
    (left, right) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
  );
  if (sections.length === 0) lines.push("", "No context sections are available.");
  sections.forEach((section, sectionIndex) => {
    const title = singleLine(section.title);
    redacted ||= title.redacted;
    lines.push("", `### ${sectionIndex + 1}. ${title.text}`);
    for (const item of section.items) {
      if (!item.sendable) continue;
      const itemId = singleLine(item.id);
      const itemTitle = singleLine(item.title);
      const summary = singleLine(item.summary);
      redacted ||= itemId.redacted || itemTitle.redacted || summary.redacted;
      lines.push(
        `- [${item.module}/${item.entityType}/${itemId.text}] ${itemTitle.text}: ${summary.text}`
      );
    }
  });

  if (options.includeSourceRefs) {
    lines.push("", "## Source References");
    const sourceRefs = uniqueSourceRefs(contextPackage.sourceRefs);
    if (sourceRefs.length === 0) lines.push("- No source references available.");
    sourceRefs.forEach((sourceRef) => {
      const rendered = sourceRefLine(sourceRef);
      redacted ||= rendered.redacted;
      lines.push(rendered.text);
    });
  }

  if (options.includeWarnings) {
    lines.push("", "## Warnings");
    const warnings = contextPackage.warnings ?? [];
    if (warnings.length === 0) lines.push("- None.");
    warnings.forEach((warning) => {
      const rendered = warningLine(warning);
      redacted ||= rendered.redacted;
      lines.push(rendered.text);
    });
  }

  if (options.includeExcluded) {
    lines.push("", "## Excluded");
    // C3 Level-4 exclusion/degradation reasons are local Review/Receipt metadata,
    // not Provider-visible context. Other established exclusion semantics remain unchanged.
    const excluded = (contextPackage.excluded ?? []).filter((item) => !item.level4ObjectType);
    if (excluded.length === 0) lines.push("- None.");
    excluded.forEach((item) => {
      const rendered = excludedLine(item);
      redacted ||= rendered.redacted;
      lines.push(rendered.text);
    });
  }

  return { markdown: lines.join("\n").trim(), redacted };
}

function normalizeOutputDetailPreference(
  value: AIOutputDetailPreference | undefined
): AIOutputDetailPreference {
  const preference = value ?? "STANDARD";
  if (!AI_OUTPUT_DETAIL_PREFERENCE_VALUES.includes(preference)) {
    throw new Error(`[AI-A23] Unsupported output detail preference: ${String(value)}`);
  }
  return preference;
}

function outputDetailPreferenceMarkdown(preference: AIOutputDetailPreference): string {
  if (preference === "UNRESTRICTED") return "";
  const directive = preference === "CONCISE"
    ? "Prefer a concise, complete answer focused on the user's facts, keywords, and core conclusions; avoid repetition and unsupported expansion."
    : preference === "DETAILED"
      ? "Within the supplied facts and material, provide a fuller treatment including useful background, reasoning, limitations, alternatives, and validation suggestions without inventing evidence."
      : "Provide a structurally complete, coherent, moderately detailed answer with necessary context, transitions, explanation, and limitations without inventing research facts.";
  return [
    "## Output Detail Preference",
    `Preference: ${preference}`,
    "This is a semantic preference, not a hard length limit. Any explicit instruction in the current user question takes precedence.",
    directive
  ].join("\n");
}

function terminalResponseCarrierGuard(
  category: AIActiveConstraintDescriptor["category"],
  hasContextRequestContract: boolean,
  hasStandardResultContract: boolean
): string {
  if (category === "NORMAL_QA" && hasContextRequestContract) {
    return [
      "## Final carrier adherence gate",
      "This gate only enforces the sole active Typed Response Contract above; it does not define a second protocol.",
      "If and only if the Context Request branch is selected, emit the exact wrapperStart literal, then the direct canonical payload JSON, then the exact wrapperEnd literal, and emit no other character.",
      "A bare payload, Markdown-fenced payload, contract descriptor, prefix, or suffix is invalid. Otherwise emit only the ordinary answer with no Context Request syntax."
    ].join("\n");
  }
  if (category === "PARSE_DRAFT" && hasStandardResultContract) {
    return [
      "## Final carrier adherence gate",
      "This gate only enforces the sole active Typed Parse Draft Outcome Contract above; it does not define a second protocol.",
      "Emit exactly one raw JSON object matching exactly one permitted top-level outcome from that contract.",
      "For STANDARD_RESULT_BATCH, mechanically recheck before emission that results contains 1-8 items and every Result has exactly category, action, target, and payload.",
      "For every payload.manuscriptEffects child, form the exact child-effect tuple as [action, target.entityType, target.entityType, channel] joined with dots; it must appear verbatim in resultItemContract.manuscriptEffects.allowedCapabilityTuples, otherwise omit that child.",
      "Route uses target.entityType routeNode and Task uses target.entityType task; both have zero child-effect capability, so their payload must omit manuscriptEffects entirely.",
      "A successful batch must never use an empty results array as a fallback when a candidate violates the contract.",
      "A Markdown fence, prose, contract descriptor, bare nested payload, null alternate, or second outcome is invalid."
    ].join("\n");
  }
  return "";
}

function composeFinalPrompt(
  constraintSegments: AIConstraintSemanticSegments,
  responseContract: string,
  runScopedDirective: string,
  outputDetailPreference: string,
  contextMarkdown: string,
  conversationHistory: string,
  userQuestion: string
): string {
  const [sharedInvariant, categoryPolicy, boundedPolicy] = constraintSegments;
  return [
    `## Shared Invariant · ${sharedInvariant.ref}@${sharedInvariant.version}`,
    sharedInvariant.text,
    "",
    `## Constraint Category · ${categoryPolicy.category} · ${categoryPolicy.ref}@${categoryPolicy.version}`,
    categoryPolicy.text,
    "",
    ...(boundedPolicy ? [
      `## Bounded Policy · ${boundedPolicy.ref}@${boundedPolicy.version}`,
      boundedPolicy.text,
      ""
    ] : []),
    ...(runScopedDirective ? [runScopedDirective, ""] : []),
    ...(outputDetailPreference ? [outputDetailPreference, ""] : []),
    contextMarkdown,
    "",
    ...(conversationHistory ? [conversationHistory, ""] : []),
    "## User Question",
    userQuestion,
    ...(responseContract ? ["", responseContract] : [])
  ].join("\n");
}

function normalizeQuickAnalysisContextCapability(
  capability: AIQuickAnalysisContextCapability | undefined,
  category: AIActiveConstraintDescriptor["category"],
  _contextRequestContract: AIContextRequestResponseContract | undefined
): AIQuickAnalysisContextCapability | undefined {
  if (!capability) return undefined;
  const runId = capability.runId.trim();
  const stateMatchesRemaining =
    (capability.remaining === 1 && capability.state === "CONTEXT_ALLOWED") ||
    (capability.remaining === 0 && capability.state === "CONTEXT_EXHAUSTED");
  if (
    (category !== "QUICK_ANALYSIS" && category !== "PARSE_DRAFT") ||
    !runId || runId !== capability.runId ||
    runId.includes("\0") || Array.from(runId).length > 200 ||
    capability.wholeRunBudgetLimit !== 1 || !stateMatchesRemaining
  ) {
    throw new Error("[LP13-D1-A9] Invalid run-scoped Quick Analysis Context capability.");
  }
  return {
    runId,
    wholeRunBudgetLimit: 1,
    remaining: capability.remaining,
    state: capability.state
  };
}

function normalizeContextRequestFollowupState(
  state: AIContextRequestFollowupState | undefined
): AIContextRequestFollowupState | undefined {
  if (!state) return undefined;
  if (
    (
      state.scope !== "SAME_CONVERSATION_APPROVED_FOLLOWUP" &&
      state.scope !== "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP"
    ) ||
    state.limit !== 1 || state.remaining !== 0 || state.state !== "CONTEXT_EXHAUSTED"
  ) {
    throw new Error("[LP13-D1-A14] Invalid Context Request follow-up state.");
  }
  return { ...state };
}

function quickAnalysisContextCapabilityMarkdown(
  capability: AIQuickAnalysisContextCapability | undefined,
  contextRequestEligible: boolean
): string {
  if (!capability) return "";
  if (capability.state === "CONTEXT_ALLOWED" && contextRequestEligible) {
    return [
      "## Quick Analysis Context Capability",
      "ContextCapability: CONTEXT_ALLOWED.",
      "Whole-run automatic Context Request budget limit: 1; remaining before this call: 1.",
      "At most one canonical Context Request may be returned if the existing bounded policy and typed contract permit it."
    ].join("\n");
  }
  if (capability.state === "CONTEXT_ALLOWED") {
    return [
      "## Quick Analysis Context Capability",
      "ContextCapability: CONTEXT_UNAVAILABLE_NO_REQUESTABLE_REFS.",
      "Whole-run automatic Context Request budget limit: 1; remaining before this call: 1.",
      "This call has no legal typed requestable ref, so no Context Request capability or invitation is available.",
      "Complete from the current evidence and state limitations, unknowns, and remaining gaps instead of requesting context or inventing facts."
    ].join("\n");
  }
  return [
    "## Quick Analysis Context Capability",
    "ContextCapability: CONTEXT_EXHAUSTED.",
    "Whole-run automatic Context Request budget limit: 1; remaining before this call: 0.",
    "The single automatic Context Request allowance for this whole run has already been consumed; no additional material will be provided.",
    "Do not output another Context Request, its wrapper, or an AI_CONTEXT_REQUEST outcome.",
    "Complete from the current evidence. If evidence is insufficient, state the limitations, unknowns, and remaining gaps in the answer or canonical Standard/Manuscript Result; do not invent facts."
  ].join("\n");
}

function contextRequestFollowupStateMarkdown(
  state: AIContextRequestFollowupState | undefined
): string {
  if (!state) return "";
  const automaticParse = state.scope === "SAME_PARSE_ATTEMPT_AUTOMATIC_FOLLOWUP";
  return [
    "## Context Request Follow-up State",
    "ContextCapability: CONTEXT_EXHAUSTED.",
    automaticParse
      ? "Same-Parse-Attempt automatic follow-up limit: 1; remaining before this call: 0. No user approval was requested or implied."
      : "Same-Conversation approved follow-up limit: 1; remaining before this call: 0.",
    "The permitted Context Request round for this semantic flow has been consumed; no further Context Request, wrapper, or AI_CONTEXT_REQUEST outcome is allowed.",
    automaticParse
      ? "Complete with a final machine-parseable Standard Result from the supplied and explicitly unavailable/missing projections; never wait for interaction or invent facts."
      : "Complete from the current supplied evidence. If it is insufficient, state limitations, unknowns, and remaining gaps instead of requesting more context or inventing facts."
  ].join("\n");
}

function assertQuickAnalysisCapabilitySourceRef(
  capability: AIQuickAnalysisContextCapability | undefined,
  sourceRefs: readonly AIContextSourceRef[]
) {
  const receipts = sourceRefs.filter((sourceRef) =>
    sourceRef.field === "quickAnalysisRunAuthorization" &&
    sourceRef.quickAnalysisContextCapabilityState !== undefined
  );
  if (!capability) {
    if (receipts.length > 0) {
      throw new Error("[LP13-D1-A9] Quick Analysis capability provenance cannot execute without its typed capability.");
    }
    return;
  }
  if (receipts.length !== 1) {
    throw new Error("[LP13-D1-A9] Quick Analysis capability requires one exact run receipt.");
  }
  const receipt = receipts[0];
  if (
    receipt.entityId !== capability.runId ||
    receipt.quickAnalysisRunId !== capability.runId ||
    receipt.quickAnalysisAutoContextBudgetLimit !== capability.wholeRunBudgetLimit ||
    receipt.quickAnalysisAutoContextBudgetRemaining !== capability.remaining ||
    receipt.quickAnalysisContextCapabilityState !== capability.state
  ) {
    throw new Error("[LP13-D1-A9] Quick Analysis capability and durable run receipt do not match.");
  }
}

function sanitizeContextRequestResponseContract(
  contract: AIContextRequestResponseContract | undefined,
  capability?: AIQuickAnalysisContextCapability,
  followupState?: AIContextRequestFollowupState
): { contract?: AIContextRequestResponseContract; markdown: string; redacted: boolean } {
  const contextRequestEligible = Boolean(contract) && capability?.state !== "CONTEXT_EXHAUSTED" && !followupState;
  const stateMarkdown = [
    quickAnalysisContextCapabilityMarkdown(capability, contextRequestEligible),
    contextRequestFollowupStateMarkdown(followupState)
  ].filter(Boolean).join("\n\n");
  if (!contract) return { markdown: stateMarkdown, redacted: false };
  if (!contextRequestEligible) {
    throw new Error("[LP13-D1-A14] An exhausted Context Request scope cannot carry an active response contract.");
  }
  let redacted = false;
  const requestableRefs = contract.requestableRefs.map((ref) => {
    const refId = singleLine(ref.refId);
    const projectId = singleLine(ref.projectId);
    const label = singleLine(ref.label);
    redacted ||= refId.redacted || projectId.redacted || label.redacted;
    return {
      ...ref,
      refId: refId.text,
      projectId: projectId.text,
      label: label.text,
      allowedContributionKinds: [...ref.allowedContributionKinds]
    };
  });
  const alreadySuppliedRefs = contract.alreadySuppliedRefs.map((ref) => {
    const refId = singleLine(ref.refId);
    const projectId = singleLine(ref.projectId);
    redacted ||= refId.redacted || projectId.redacted;
    return {
      ...ref,
      refId: refId.text,
      projectId: projectId.text
    };
  });
  const sanitized: AIContextRequestResponseContract = {
    ...contract,
    requestableRefs,
    alreadySuppliedRefs,
    contributionKinds: ["IDENTITY_METADATA", "BODY_CONTENT"]
  };
  const serialization = JSON.stringify({
    contract: sanitized.contract,
    wrapperStart: sanitized.wrapperStart,
    wrapperEnd: sanitized.wrapperEnd,
    payloadShape: {
      version: 1,
      assistantText: "string",
      reason: "string",
      requestedRefs: [{
        refKind: "AI_RESEARCH_OBJECT | FILE_REF",
        refId: "exact requestable refId",
        contributionKind: "IDENTITY_METADATA | BODY_CONTENT"
      }]
    },
    requestableRefs: sanitized.requestableRefs,
    alreadySuppliedRefs: sanitized.alreadySuppliedRefs
  });
  const invitation = `## Typed Response Contract\n${serialization}`;
  return {
    contract: sanitized,
    markdown: [
      stateMarkdown,
      invitation
    ].filter(Boolean).join("\n\n"),
    redacted
  };
}

function sanitizeStandardResultResponseContract(
  contract: AIStandardResultResponseContract | undefined,
  contextRequestContract: AIContextRequestResponseContract | undefined,
  capability?: AIQuickAnalysisContextCapability,
  followupState?: AIContextRequestFollowupState
): { contract?: AIStandardResultResponseContract; markdown: string; redacted: boolean } {
  if (!contract) return { markdown: "", redacted: false };
  if (contextRequestContract && contextRequestContract.contract !== contract.contextRequestContract) {
    throw new Error("[AI-A6] Parse Draft Context Request capability requires the exact paired A5 contract.");
  }
  const sanitizedContext = sanitizeContextRequestResponseContract(
    contextRequestContract,
    capability,
    followupState
  );
  const standardResultOutcome = {
    outcome: "STANDARD_RESULT_BATCH",
    batch: {
      version: 1,
      results: [{
        category: "DATA_OPERATION",
        action: "CREATE",
        target: {
          projectId: "<exact frozen Project id>",
          entityType: "resultItem"
        },
        payload: {
          title: "<business identity>",
          _labpod: {
            protocol: "labpod-standard-result-proposal-v1",
            originalOrdinal: 1,
            proposalRef: "proposal-1"
          }
        }
      }]
    }
  };
  const contextRequestOutcome = {
    outcome: "AI_CONTEXT_REQUEST",
    contextRequest: {
      version: 1,
      assistantText: "string",
      reason: "string",
      requestedRefs: [{
        refKind: "AI_RESEARCH_OBJECT | FILE_REF",
        refId: "exact requestable refId",
        contributionKind: "IDENTITY_METADATA | BODY_CONTENT"
      }]
    }
  };
  const contextRequestEligible = Boolean(sanitizedContext.contract);
  const serialization = JSON.stringify({
    contract: contract.contract,
    outputSerialization: contract.outputSerialization,
    exactTopLevelOutcomes: {
      STANDARD_RESULT_BATCH: standardResultOutcome,
      ...(contextRequestEligible ? { AI_CONTEXT_REQUEST: contextRequestOutcome } : {})
    },
    exactTopLevelOutcomeExampleRule: "The STANDARD_RESULT_BATCH item above is one legal ResultItem CREATE shape example only. Preserve the exact outcome/batch/version/results wrapper and exact four-key Result shape, then select each real whole capability tuple and object-specific payload from the contracts below.",
    resultItemContract: contract.resultItemContract,
    allowedCapabilityTuples: contract.allowedCapabilityTuples,
    minResults: contract.minResults,
    maxResults: contract.maxResults,
    ...(contextRequestEligible
      ? {
          requestableRefs: sanitizedContext.contract?.requestableRefs ?? [],
          alreadySuppliedRefs: sanitizedContext.contract?.alreadySuppliedRefs ?? []
        }
      : {})
  });
  return {
    contract: { ...contract },
    markdown: [
      quickAnalysisContextCapabilityMarkdown(capability, contextRequestEligible),
      contextRequestFollowupStateMarkdown(followupState),
      `## Typed Parse Draft Outcome Contract\n${serialization}`
    ].filter(Boolean).join("\n\n"),
    redacted: sanitizedContext.redacted
  };
}

function renderBoundedConversationHistory(
  messages: readonly AICanonicalHistoryMessage[],
  maxChars: number,
  maxMessages: number
): {
  markdown: string;
  messages: AIProviderPromptHistoryMessage[];
  redacted: boolean;
  omitted: number;
} {
  const ordered = [...messages]
    .filter((message) => message.content.trim())
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const capped = maxMessages > 0 ? ordered.slice(-maxMessages) : [];
  let redacted = false;
  const rendered = capped.map((message) => {
    const content = sanitizeText(message.content.trim());
    redacted ||= content.redacted;
    return {
      markdown: `### ${message.role === "user" ? "User" : "Assistant"}\n${content.text}`,
      message: { role: message.role, content: content.text }
    };
  });
  const heading = "## Prior Canonical Conversation";
  while (rendered.length > 0) {
    const markdown = [heading, ...rendered.map((item) => item.markdown)].join("\n\n");
    if (countChars(markdown) <= Math.max(0, maxChars)) {
      return {
        markdown,
        messages: rendered.map((item) => item.message),
        redacted,
        omitted: ordered.length - rendered.length
      };
    }
    rendered.shift();
  }
  return { markdown: "", messages: [], redacted, omitted: ordered.length };
}

function promptBudgetSummary(
  contextPackage: AIContextPackage,
  inputClassLedger: AIProviderInputClassLedgerEntry[],
  technicalCapacityChars: number,
  estimatedProviderCharacters: number,
  outputDetailPreference: AIOutputDetailPreference,
  parseDynamicContextBudget?: AIParseDynamicContextBudgetReceipt
): AIContextBudgetSummary {
  const original = contextPackage.budgetSummary;
  const autoPullMaxChars = contextPackage.budget?.maxChars ?? original?.maxChars ??
    AI_AUTO_PULL_CONTEXT_DEFAULT_CHARS;
  const usedChars = original?.usedChars ?? contextPackage.sections
    .flatMap((section) => section.items)
    .reduce((total, item) => total + item.charCount, 0);
  return {
    maxChars: autoPullMaxChars,
    usedChars,
    remainingChars: Math.max(0, autoPullMaxChars - usedChars),
    truncatedSections: original?.truncatedSections ?? 0,
    truncatedItems: original?.truncatedItems ?? 0,
    excludedItems: original?.excludedItems ?? contextPackage.excluded?.length ?? 0,
    budgetScope: "AUTO_PULLED_RESEARCH_CONTEXT",
    inputClassLedger,
    technicalCapacity: {
      classification: parseDynamicContextBudget
        ? "PARSE_DYNAMIC_CONTEXT_BUDGET"
        : "TECHNICAL_CAPACITY_OR_SAFETY_GUARD",
      sourceOwner: parseDynamicContextBudget
        ? "frontend-and-rust-parse-dynamic-context-budget"
        : "frontend-and-rust-absolute-payload-safety-guard",
      maxCharacters: technicalCapacityChars,
      estimatedCharacters: parseDynamicContextBudget?.estimatedCharacters ?? estimatedProviderCharacters,
      status: (parseDynamicContextBudget?.estimatedCharacters ?? estimatedProviderCharacters) <= technicalCapacityChars
        ? "WITHIN_GUARD"
        : "TECHNICAL_CAPACITY_OR_SAFETY_ERROR"
    },
    ...(parseDynamicContextBudget ? { parseDynamicContextBudget } : {}),
    outputDetailPreference,
    notes: [
      ...(original?.notes ?? []),
      parseDynamicContextBudget
        ? `Parse software dynamic context: ${parseDynamicContextBudget.estimatedCharacters} characters under the ${technicalCapacityChars}-character PARSE_DYNAMIC_CONTEXT_BUDGET; the complete Provider prompt remains ${estimatedProviderCharacters} characters.`
        : `Estimated complete Provider payload: ${estimatedProviderCharacters} characters under the independent ${technicalCapacityChars}-character technical safety guard.`,
      "Excluded input classes were preserved independently and were never removed to satisfy the Auto-Pull Research Context budget."
    ]
  };
}

export function renderAIContextMarkdown(
  contextPackage: AIContextPackage,
  options: Partial<AIContextMarkdownRenderOptions> = {}
): string {
  return renderContext(contextPackage, {
    includeSourceRefs: options.includeSourceRefs ?? true,
    includeWarnings: options.includeWarnings ?? true,
    includeExcluded: options.includeExcluded ?? true
  }).markdown;
}

export function buildAIPromptPackage(
  contextPackage: AIContextPackage,
  userQuestion: string,
  options: AIPromptPackageBuildInput
): AIPromptPackage {
  if (!userQuestion.trim()) {
    throw new Error("[AI-C3] userQuestion is required to build an AI prompt package.");
  }

  const technicalCapacityChars = options.technicalCapacityChars ?? DEFAULT_TECHNICAL_CAPACITY_CHARS;
  if (
    !Number.isFinite(technicalCapacityChars) || technicalCapacityChars <= 0 ||
    technicalCapacityChars > AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS
  ) {
    throw new Error("[AI-A23] technicalCapacityChars is outside the absolute implementation guard.");
  }
  const outputDetailPreference = normalizeOutputDetailPreference(options.outputDetailPreference);
  const includeSourceRefs = options.includeSourceRefs ?? true;
  const includeWarnings = options.includeWarnings ?? true;
  const constraintDescriptor = validateAIActiveConstraintDescriptor(
    options.constraintDescriptor
  );
  const quickAnalysisContextCapability = normalizeQuickAnalysisContextCapability(
    options.quickAnalysisContextCapability,
    constraintDescriptor.category,
    options.contextRequestResponseContract
  );
  const contextRequestFollowupState = normalizeContextRequestFollowupState(
    options.contextRequestFollowupState
  );
  const contextRequestCapabilityEligible = Boolean(options.contextRequestResponseContract) &&
    quickAnalysisContextCapability?.state !== "CONTEXT_EXHAUSTED" &&
    !contextRequestFollowupState;
  const contextRequestPolicySelected = constraintDescriptor.executableBoundedPolicies?.some(
    (policy) => policy.documentId === AI_CONTEXT_REQUEST_BOUNDED_POLICY.documentId &&
      policy.semanticVersion === AI_CONTEXT_REQUEST_BOUNDED_POLICY.semanticVersion
  ) ?? false;
  if (contextRequestPolicySelected !== contextRequestCapabilityEligible) {
    throw new Error("[LP13-D1-A14] Context Request capability state and frozen policy selection do not match.");
  }
  const rawConstraintSegments = buildAIConstraintSemanticSegments(constraintDescriptor);
  const sharedInvariant = sanitizeText(rawConstraintSegments[0].text);
  const categoryPolicy = sanitizeText(rawConstraintSegments[1].text);
  const boundedPolicy = rawConstraintSegments[2]
    ? sanitizeText(rawConstraintSegments[2].text)
    : undefined;
  const constraintSegments: AIConstraintSemanticSegments = rawConstraintSegments[2] && boundedPolicy
    ? [
        { ...rawConstraintSegments[0], text: sharedInvariant.text },
        { ...rawConstraintSegments[1], text: categoryPolicy.text },
        { ...rawConstraintSegments[2], text: boundedPolicy.text }
      ]
    : [
      { ...rawConstraintSegments[0], text: sharedInvariant.text },
      { ...rawConstraintSegments[1], text: categoryPolicy.text }
      ];
  const responseContract = sanitizeContextRequestResponseContract(
    options.contextRequestResponseContract,
    quickAnalysisContextCapability,
    contextRequestFollowupState
  );
  const standardResultContract = sanitizeStandardResultResponseContract(
    options.standardResultResponseContract,
    options.contextRequestResponseContract,
    quickAnalysisContextCapability,
    contextRequestFollowupState
  );
  const responseContractMarkdownBase = standardResultContract.contract
    ? standardResultContract.markdown
    : responseContract.markdown;
  const responseContractMarkdown = [
    responseContractMarkdownBase,
    terminalResponseCarrierGuard(
      constraintDescriptor.category,
      Boolean(responseContract.contract),
      Boolean(standardResultContract.contract)
    )
  ].filter(Boolean).join("\n\n");
  const question = sanitizeText(userQuestion.trim());
  const providerOwnerEntityRefs = constraintDescriptor.category === "NORMAL_QA" ||
    constraintDescriptor.category === "PARSE_DRAFT"
    ? renderAIProviderOwnerEntityRefs(contextPackage)
    : "";
  const isParseDraft = constraintDescriptor.category === "PARSE_DRAFT";
  const requestedParseDynamicRunScopedSegments = options.parseDynamicRunScopedSegments ?? [];
  if (!isParseDraft && requestedParseDynamicRunScopedSegments.length > 0) {
    throw new Error("Parse dynamic run-scoped metadata is restricted to PARSE_DRAFT.");
  }
  if (requestedParseDynamicRunScopedSegments.some((segment) => !segment.trim())) {
    throw new Error("Parse dynamic run-scoped metadata cannot contain an empty segment.");
  }
  const fixedRunScopedDirective = sanitizeText(options.runScopedDirective?.trim() ?? "");
  const parseDynamicRunScopedSegments = isParseDraft
    ? [
        ...requestedParseDynamicRunScopedSegments,
        ...(providerOwnerEntityRefs ? [providerOwnerEntityRefs] : [])
      ].map((segment) => sanitizeText(segment.trim()))
    : [];
  const runScopedDirective = sanitizeText([
    fixedRunScopedDirective.text,
    ...(isParseDraft
      ? parseDynamicRunScopedSegments.map((segment) => segment.text)
      : providerOwnerEntityRefs ? [providerOwnerEntityRefs] : [])
  ].filter(Boolean).join("\n\n"));
  const runScopedMarkdown = runScopedDirective.text
    ? `## Run-scoped directive\n${runScopedDirective.text}`
    : "";
  const outputPreferenceMarkdown = outputDetailPreferenceMarkdown(outputDetailPreference);
  const warnings: AIContextWarning[] = [...(contextPackage.warnings ?? [])];
  const lateMaterialEstimate = mandatoryLateMaterialTechnicalEstimate(
    contextPackage,
    !(
      constraintDescriptor.category === "QUICK_ANALYSIS" &&
      (constraintDescriptor.constraintVersion === 3 || constraintDescriptor.constraintVersion === 4)
    )
  );
  if (lateMaterialEstimate.invalidLabels.length > 0) {
    warnings.push({
      code: "authorized_material_budget_reservation_unavailable",
      message: "The canonical authorized-material technical-capacity estimate is unavailable for one or more selected FileRefs.",
      severity: "error",
      sourceRefs: contextPackage.sourceRefs.filter((sourceRef) => (
        sourceRef.entityType === "fileRef" &&
        lateMaterialEstimate.invalidLabels.includes(sourceRef.label ?? "")
      ))
    });
  }
  const sanitizedSourceRefs = sanitizeSourceRefs([
    ...contextPackage.sourceRefs,
    ...(options.additionalSourceRefs ?? []),
    createAIConstraintSourceRef(constraintDescriptor, options.legacySourceMarker)
  ]);
  assertQuickAnalysisCapabilitySourceRef(
    quickAnalysisContextCapability,
    sanitizedSourceRefs.sourceRefs
  );
  const hasContextMarkdownOverride = options.contextMarkdownOverride !== undefined;
  if (contextPackage.sections.length === 0) {
    warnings.push({
      code: "empty_context_sections",
      message: "The context package contains no sections.",
      severity: "warning",
      sourceRefs: []
    });
  }
  if (contextPackage.sourceRefs.length === 0) {
    warnings.push({
      code: "missing_source_refs",
      message: "The context package contains no source references.",
      severity: "warning",
      sourceRefs: []
    });
  }

  const sanitizedContextOverride = hasContextMarkdownOverride
    ? sanitizeText(options.contextMarkdownOverride ?? "")
    : undefined;
  const rendered: RenderResult = sanitizedContextOverride
    ? { markdown: sanitizedContextOverride.text, redacted: sanitizedContextOverride.redacted }
    : renderContext(contextPackage, {
        includeSourceRefs,
        includeWarnings,
        includeExcluded: true
      });
  const requestedHistory = options.conversationMessages ?? [];
  const history = renderBoundedConversationHistory(
    requestedHistory,
    options.maxConversationHistoryChars ?? AI_CONVERSATION_HISTORY_MAX_CHARS,
    options.maxConversationHistoryMessages ?? AI_CONVERSATION_HISTORY_MAX_MESSAGES
  );
  const finalPrompt = composeFinalPrompt(
    constraintSegments,
    responseContractMarkdown,
    runScopedMarkdown,
    outputPreferenceMarkdown,
    rendered.markdown,
    history.markdown,
    question.text
  );
  if (history.omitted > 0) {
    warnings.push({
      code: "conversation_history_bounded",
      message: `${history.omitted} older canonical conversation messages were omitted by the deterministic history budget.`,
      severity: "warning",
      sourceRefs: []
    });
  }
  if (
    sharedInvariant.redacted ||
    categoryPolicy.redacted ||
    Boolean(boundedPolicy?.redacted) ||
    responseContract.redacted ||
    standardResultContract.redacted ||
    question.redacted ||
    rendered.redacted ||
    history.redacted ||
    fixedRunScopedDirective.redacted ||
    parseDynamicRunScopedSegments.some((segment) => segment.redacted) ||
    runScopedDirective.redacted ||
    sanitizedSourceRefs.redacted
  ) {
    warnings.push({
      code: "sensitive_content_redacted",
      message: "Local path, secret-like value, or stack trace content was removed before prompt assembly.",
      severity: "warning",
      sourceRefs: []
    });
  }
  const estimatedProviderCharacters = countChars(finalPrompt) + lateMaterialEstimate.characters;
  const providerPromptEnvelope: AIProviderPromptEnvelope = {
    constraintDescriptor,
    constraintSegments,
    researchContext: rendered.markdown,
    ...((isParseDraft ? fixedRunScopedDirective.text : runScopedDirective.text)
      ? {
          runScopedDirective: isParseDraft
            ? fixedRunScopedDirective.text
            : runScopedDirective.text
        }
      : {}),
    conversationHistory: history.messages,
    userQuestion: question.text,
    outputDetailPreference,
    ...(quickAnalysisContextCapability
      ? { quickAnalysisContextCapability }
      : {}),
    ...(contextRequestFollowupState
      ? { contextRequestFollowupState }
      : {}),
    ...(responseContract.contract
      ? { contextRequestResponseContract: responseContract.contract }
      : {}),
    ...(standardResultContract.contract
      ? { standardResultResponseContract: standardResultContract.contract }
      : {}),
    ...(isParseDraft
      ? {
          parseDynamicContextBudget: {
            classification: "PARSE_DYNAMIC_CONTEXT_BUDGET" as const,
            maxCharacters: technicalCapacityChars,
            runScopedDynamicSegments: parseDynamicRunScopedSegments.map((segment) => segment.text)
          }
        }
      : {}),
    finalPromptHardBudget: technicalCapacityChars
  };
  const parseDynamicContextBudget = isParseDraft
    ? measureAIParseDynamicContextBudget(providerPromptEnvelope)
    : undefined;
  const inputClassLedger: AIProviderInputClassLedgerEntry[] = [
    {
      inputClass: "AUTO_PULLED_RESEARCH_CONTEXT",
      characters: hasContextMarkdownOverride
        ? 0
        : contextPackage.budgetSummary?.usedChars ?? contextPackage.sections
            .flatMap((section) => section.items)
            .reduce((total, item) => total + item.charCount, 0),
      autoPullBudgetTreatment: "COUNTED",
      presence: contextPackage.sections.length > 0 && !hasContextMarkdownOverride ? "PRESENT" : "ABSENT",
      droppedForAutoPullBudget: false,
      components: hasContextMarkdownOverride
        ? []
        : ["allowlisted ContextPackage research fields and relations"]
    },
    {
      inputClass: "USER_EXPLICIT_TASK_OR_INPUT_CONTENT",
      characters: countChars(question.text) + lateMaterialEstimate.materialCharacters +
        (hasContextMarkdownOverride ? countChars(rendered.markdown) : 0),
      autoPullBudgetTreatment: "EXCLUDED",
      presence: "PRESENT",
      droppedForAutoPullBudget: false,
      components: [
        "current user question",
        ...(hasContextMarkdownOverride ? ["user-reviewed context override"] : []),
        ...(lateMaterialEstimate.materialCount > 0
          ? ["explicitly selected/authorized material body"]
          : [])
      ]
    },
    {
      inputClass: "CONVERSATION_CONTINUITY_INPUT",
      characters: history.messages.reduce((total, message) => total + countChars(message.content), 0),
      autoPullBudgetTreatment: "EXCLUDED",
      presence: history.messages.length > 0 ? "PRESENT" : "ABSENT",
      droppedForAutoPullBudget: false,
      components: history.messages.length > 0 ? ["canonical bounded conversation history"] : []
    },
    {
      inputClass: "SYSTEM_CONSTRAINT_AND_PROTOCOL",
      characters: constraintSegments.reduce((total, segment) => total + countChars(segment.text), 0) +
        countChars(responseContractMarkdown) + countChars(runScopedMarkdown) +
        countChars(outputPreferenceMarkdown) + lateMaterialEstimate.contractCharacters,
      autoPullBudgetTreatment: "EXCLUDED",
      presence: "PRESENT",
      droppedForAutoPullBudget: false,
      components: [
        "constraint segments",
        ...(responseContractMarkdown ? ["machine response protocol"] : []),
        ...(runScopedMarkdown ? ["run-scoped directive"] : []),
        ...(outputPreferenceMarkdown ? ["output detail preference"] : []),
        ...(lateMaterialEstimate.contractCharacters > 0 ? ["authorized-material contract"] : [])
      ]
    },
    {
      inputClass: "TECHNICAL_CAPACITY_OR_SAFETY_GUARD",
      characters: 0,
      autoPullBudgetTreatment: "EXCLUDED",
      presence: "PRESENT",
      droppedForAutoPullBudget: false,
      components: ["absolute frontend/Rust provider-payload safety guard"]
    }
  ];
  const guardedCharacters = parseDynamicContextBudget?.estimatedCharacters ??
    estimatedProviderCharacters;
  if (guardedCharacters > technicalCapacityChars) {
    warnings.push({
      code: "technical_capacity_or_safety_error",
      message: parseDynamicContextBudget
        ? `The Parse software dynamic context is ${guardedCharacters} characters and exceeds the ${technicalCapacityChars}-character PARSE_DYNAMIC_CONTEXT_BUDGET. Fixed system content and user-explicit content remain present and were not counted, removed, or trimmed by this budget.`
        : `The complete request is estimated at ${estimatedProviderCharacters} characters and exceeds the independent ${technicalCapacityChars}-character technical safety guard. No user input, material, history, constraint, protocol, or research context was silently removed.`,
      severity: "error",
      sourceRefs: []
    });
  }

  const mergedWarnings = uniqueWarnings(warnings).map((warning) => ({
    ...warning,
    sourceRefs: sanitizeSourceRefs(warning.sourceRefs).sourceRefs
  }));
  return {
    id: createPromptId(),
    createdAt: new Date().toISOString(),
    contextPackageId: contextPackage.id,
    contextPackageVersion: contextPackage.version,
    contextReviewFingerprint: contextPackage.reviewFingerprint,
    constraintDescriptor,
    constraintSegments,
    userQuestion: question.text,
    outputDetailPreference,
    contextMarkdown: rendered.markdown,
    sourceRefs: sanitizedSourceRefs.sourceRefs,
    finalPrompt,
    providerPromptEnvelope,
    budgetSummary: promptBudgetSummary(
      contextPackage,
      inputClassLedger,
      technicalCapacityChars,
      estimatedProviderCharacters,
      outputDetailPreference,
      parseDynamicContextBudget
    ),
    warnings: mergedWarnings
  };
}

export async function buildProjectAIPromptPackage(
  projectId: string,
  userQuestion: string,
  options: AIPromptPackageBuildInput
): Promise<AIPromptPackage> {
  const contextPackage = await buildProjectAIContext(projectId);
  return buildAIPromptPackage(contextPackage, userQuestion, options);
}
