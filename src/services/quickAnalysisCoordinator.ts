import { createRepositoryEntityId } from "../repositories/entityId";
import type { DurableAIInvocationResult } from "../types/aiConversation";
import type { AIContextPackage, AIContextSourceRef, AIPromptPackage } from "../types/aiContext";
import {
  buildAIContext,
  resolveAIContextCompositionPolicyForQuickTarget
} from "./aiContextBuilderService";
import {
  buildConversationPromptPackage,
  buildDurableAIInvocationTrace,
  createCanonicalAIConversation,
  createDurableAIInvocationRequestId,
  startDurableAIStreamingInvocation
} from "./aiConversationApplicationService";
import {
  AI_AUTO_PULL_CONTEXT_DEFAULT_CHARS,
  AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS
} from "./aiPromptBudgetService";
import {
  applyCanonicalQuickAnalysisCandidateIntent,
  captureQuickAnalysisSourceSnapshot,
  createQuickAnalysisCandidateIntent
} from "./quickAnalysisCandidateApplicationService";
import {
  quickAnalysisCanonicalSourcePort,
  type QuickAnalysisCanonicalPreflight
} from "./quickAnalysisCanonicalSourcePort";
import {
  resolveLiteratureOriginalMaterial,
  type LiteratureOriginalMaterialResolution
} from "./literatureOriginalMaterialResolver";
import type {
  QuickAnalysisChannel,
  QuickAnalysisOwnerType,
  QuickAnalysisStartInput
} from "./quickAnalysisCapabilityBinding";
import { buildQuickAnalysisGenerationInput } from "./quickAnalysisStructuredManuscriptGenerationContract";
export type { QuickAnalysisStartInput } from "./quickAnalysisCapabilityBinding";
export {
  buildQuickAnalysisGenerationInput,
  buildQuickAnalysisStructuredManuscriptGenerationContract,
  QUICK_ANALYSIS_USER_INSTRUCTION
} from "./quickAnalysisStructuredManuscriptGenerationContract";

export type RepresentativeRunTerminalState =
  | "START_RESERVED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TERMINAL_EFFECT_OUTCOME_UNKNOWN";

export type QuickAnalysisRunPhase =
  | "START_RESERVED"
  | "PREFLIGHT"
  | "CONTEXT_FREEZE"
  | "BODY_GENERATION"
  | "CANDIDATE_PUBLISH"
  | "POST_PUBLISH_READBACK"
  | "TERMINAL";

export interface QuickAnalysisRunSnapshot {
  key: string;
  runId: string;
  ownerType: QuickAnalysisOwnerType;
  ownerId: string;
  channel: QuickAnalysisChannel;
  projectId?: string;
  phase: QuickAnalysisRunPhase;
  terminalState: RepresentativeRunTerminalState;
  startedAt: string;
  updatedAt: string;
  conversationId?: string;
  quickAnalysisCallAttemptIds: string[];
  whitelistFingerprint?: string;
  sourceContentHash?: string;
  candidateFileRefId?: string;
  candidateTerminalCommitState?: "POST_PUBLISH_READBACK_CONFIRMED";
  outputIncompleteNotice?: "PROVIDER_REPORTED_TRUNCATION";
  errorCode?: string;
  errorMessage?: string;
  acquiredKeyReleaseCount: 0 | 1;
}

export type QuickAnalysisStartResult =
  | { kind: "started"; runId: string; completion: Promise<QuickAnalysisRunSnapshot> }
  | { kind: "already_running"; runId: string; completion: Promise<QuickAnalysisRunSnapshot> };

type CanonicalExecutionOutcome =
  | {
      terminalState: "SUCCEEDED";
      projectId?: string;
      conversationId: string;
      quickAnalysisCallAttemptIds: string[];
      whitelistFingerprint: string;
      sourceContentHash: string;
      candidateFileRefId: string;
      candidateTerminalCommitState: "POST_PUBLISH_READBACK_CONFIRMED";
      outputIncompleteNotice?: "PROVIDER_REPORTED_TRUNCATION";
    }
  | {
      terminalState: "TERMINAL_EFFECT_OUTCOME_UNKNOWN";
      projectId?: string;
      conversationId: string;
      quickAnalysisCallAttemptIds: string[];
      whitelistFingerprint: string;
      sourceContentHash: string;
      candidateFileRefId?: string;
      errorCode: "TERMINAL_EFFECT_OUTCOME_UNKNOWN";
      errorMessage: string;
    };

function canonicalIds(ids: readonly string[]) {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function boundedFingerprint(prefix: string, values: readonly string[]) {
  let hash = 0x811c9dc5;
  for (const character of canonicalIds(values).join("\u0000")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, "0")}`;
}

function runKey(input: Pick<QuickAnalysisStartInput, "ownerType" | "ownerId" | "channel">) {
  return `${input.ownerType}\u0000${input.ownerId}\u0000${input.channel}`;
}

function cloneSnapshot(snapshot: QuickAnalysisRunSnapshot): QuickAnalysisRunSnapshot {
  return { ...snapshot, quickAnalysisCallAttemptIds: [...snapshot.quickAnalysisCallAttemptIds] };
}

function normalizeRunFailure(error: unknown) {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : null;
  const structuredCode = typeof record?.code === "string" && record.code.trim()
    ? record.code.trim()
    : undefined;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof record?.message === "string" && record.message.trim()
      ? record.message.trim()
      : typeof error === "string" && error.trim()
        ? error.trim()
        : "Quick Analysis failed.";
  const message = Array.from(rawMessage).slice(0, 300).join("");
  return {
    errorCode: structuredCode ?? message.match(/[A-Z][A-Z0-9_]+/u)?.[0] ?? "QUICK_ANALYSIS_FAILED",
    errorMessage: message
  };
}

function requireCompletedVisibleBody(result: DurableAIInvocationResult) {
  if (
    result.callAttempt.status !== "succeeded" ||
    result.callAttempt.purpose !== "chat_response" ||
    !result.resultMessage || result.resultMessage.role !== "assistant" ||
    result.resultMessage.messageKind !== "text" || !result.resultMessage.content.trim()
  ) {
    throw new Error("QUICK_ANALYSIS_COMPLETED_NONEMPTY_BODY_REQUIRED");
  }
  return result.resultMessage.content;
}

export function assertQuickAnalysisPromptWithinTechnicalCapacity(promptPackage: AIPromptPackage) {
  if (
    promptPackage.budgetSummary?.technicalCapacity?.status === "TECHNICAL_CAPACITY_OR_SAFETY_ERROR" ||
    promptPackage.warnings?.some((warning) => warning.severity === "error")
  ) {
    throw new Error("QUICK_ANALYSIS_TECHNICAL_CAPACITY_REJECTED");
  }
}

function originalMaterialResolution(
  preflight: QuickAnalysisCanonicalPreflight
): LiteratureOriginalMaterialResolution {
  if (preflight.ownerType !== "literature") {
    return {
      disposition: "NOT_APPLICABLE",
      candidateCount: 0,
      bodyUsable: false,
      autoAttachDisposition: "SKIPPED_NONBLOCKING"
    };
  }
  return resolveLiteratureOriginalMaterial({
    ownerId: preflight.ownerId,
    title: preflight.ownerLabel,
    doi: preflight.ownerDoi,
    ownerFileRefs: preflight.ownerFileRefs,
    materialCatalog: preflight.materialCatalog
  });
}

function sourceProvenance(input: {
  runId: string;
  preflight: QuickAnalysisCanonicalPreflight;
  whitelistFingerprint: string;
  sourceContentHash: string;
  originalMaterial: LiteratureOriginalMaterialResolution;
}): AIContextSourceRef {
  const receipt = input.preflight.sourceCatalogEntry.materialFreshnessReceipt;
  if (!receipt) throw new Error("QUICK_ANALYSIS_SOURCE_RECEIPT_REQUIRED");
  return {
    module: "ai",
    entityType: "system",
    entityId: input.runId,
    label: "Quick Analysis start-time source authorization",
    field: "quickAnalysisRunAuthorization",
    sourceKind: "systemGenerated",
    isUserAuthored: false,
    isAiGenerated: false,
    isVerified: true,
    quickAnalysisRunId: input.runId,
    quickAnalysisAuthorizationSource: "USER_CLICKED_AI_ANALYSIS",
    quickAnalysisOwnerType: input.preflight.ownerType,
    quickAnalysisOwnerId: input.preflight.ownerId,
    quickAnalysisChannel: input.preflight.channel,
    ...(input.preflight.projectId
      ? { quickAnalysisProjectId: input.preflight.projectId }
      : {}),
    quickAnalysisSourceFileRefId: input.preflight.sourceFileRef.id,
    quickAnalysisSourceDirectoryFileRefId: input.preflight.sourceDirectory.folderFileRefId,
    quickAnalysisWhitelistFingerprint: input.whitelistFingerprint,
    quickAnalysisSourceSnapshotSemantics: "START_TIME_SNAPSHOT",
    quickAnalysisSourceContentReceipt: { ...receipt },
    quickAnalysisSourceContentHash: input.sourceContentHash,
    literatureOriginalMaterialResolutionDisposition: input.originalMaterial.disposition,
    ...(input.originalMaterial.resolvedFileRefId
      ? { literatureOriginalMaterialFileRefId: input.originalMaterial.resolvedFileRefId }
      : {}),
    literatureOriginalMaterialBodyUsable: input.originalMaterial.bodyUsable,
    literatureOriginalMaterialAutoAttachDisposition: input.originalMaterial.autoAttachDisposition
  };
}

export function buildQuickAnalysisRunDirective(_legacyInput?: unknown) {
  return [
    "Source semantics: START_TIME_SNAPSHOT. Use only the context and material admitted to this call.",
    "Within admitted context only, current canonical structured/database facts take precedence over conflicting manuscript or material statements.",
    "Generate one candidate body directly. Machine Context Request, Standard Result, Parse Draft, format repair, and semantic correction are not part of this run."
  ].join(" ");
}

export async function executeCanonicalQuickAnalysisRun(input: {
  runId: string;
  occurredAt: string;
  start: QuickAnalysisStartInput;
  onPhase?: (phase: QuickAnalysisRunPhase, conversationId?: string) => void;
  onCallAttemptPrepared?: (purpose: "chat_response", callAttemptId: string) => void;
}): Promise<CanonicalExecutionOutcome> {
  input.onPhase?.("PREFLIGHT");
  const preflight = await quickAnalysisCanonicalSourcePort.resolve(input.start);
  const sourceSnapshot = await captureQuickAnalysisSourceSnapshot({
    ownerType: preflight.ownerType,
    ownerId: preflight.ownerId,
    channel: preflight.channel,
    sourceFileRefId: preflight.sourceFileRef.id
  });
  const originalMaterial = originalMaterialResolution(preflight);
  const selectedMaterials = originalMaterial.selection ? [originalMaterial.selection] : [];
  const authorizedMaterialIds = canonicalIds(selectedMaterials.map((selection) => selection.fileRefId));
  const whitelistFingerprint = boundedFingerprint("quick-whitelist", [
    preflight.sourceFileRef.id,
    ...authorizedMaterialIds
  ]);
  const objectiveOutline = preflight.ownerType === "literature" &&
    preflight.channel === "literature_outline";
  if (!objectiveOutline && !preflight.projectId) {
    throw new Error("QUICK_ANALYSIS_SCOPE_UNAVAILABLE");
  }
  const contextPackage: AIContextPackage = await buildAIContext({
    scopeType: objectiveOutline ? "literature" : "project",
    scopeId: objectiveOutline ? preflight.ownerId : preflight.projectId,
    contextMode: "STANDARD",
    researchObjects: [{
      objectType: preflight.bindingCapability.researchObjectType,
      objectId: preflight.ownerId
    }],
    selectedMaterials,
    ...(resolveAIContextCompositionPolicyForQuickTarget(preflight)
      ? { compositionPolicy: resolveAIContextCompositionPolicyForQuickTarget(preflight) }
      : {}),
    budget: {
      maxChars: AI_AUTO_PULL_CONTEXT_DEFAULT_CHARS,
      reservedForUserQuestion: 0,
      reservedForSystemInstruction: 0,
      maxSectionChars: 4_000,
      maxItemChars: 1_200,
      strategy: "priorityFirst"
    }
  });
  input.onPhase?.("CONTEXT_FREEZE");
  const conversation = await createCanonicalAIConversation();
  input.onPhase?.("CONTEXT_FREEZE", conversation.id);
  const prompt = await buildConversationPromptPackage({
    conversationId: conversation.id,
    contextPackage,
    userQuestion: buildQuickAnalysisGenerationInput(
      sourceSnapshot.rawContent,
      preflight.manuscriptOutlineDescriptor
    ),
    constraintRequest: { kind: "current", category: "QUICK_ANALYSIS" },
    quickAnalysisTarget: { ownerType: preflight.ownerType, channel: preflight.channel },
    machineContextRequestMode: "disabled",
    options: {
      technicalCapacityChars: AI_PROVIDER_PROMPT_TECHNICAL_MAX_CHARS,
      outputDetailPreference: "STANDARD",
      includeSourceRefs: preflight.ownerType !== "literature" ||
        preflight.channel !== "literature_outline",
      runScopedDirective: buildQuickAnalysisRunDirective(),
      additionalSourceRefs: [sourceProvenance({
        runId: input.runId,
        preflight,
        whitelistFingerprint,
        sourceContentHash: sourceSnapshot.sourceContentHash,
        originalMaterial
      })]
    }
  });
  assertQuickAnalysisPromptWithinTechnicalCapacity(prompt.promptPackage);
  input.onPhase?.("BODY_GENERATION", conversation.id);
  const requestId = createDurableAIInvocationRequestId();
  const handle = await startDurableAIStreamingInvocation({
    conversationId: conversation.id,
    purpose: "chat_response",
    requestId,
    promptText: prompt.promptPackage.finalPrompt,
    promptEnvelope: prompt.promptPackage.providerPromptEnvelope,
    // Rust requires the committed canonical user message and the typed
    // provider-envelope question to be byte-identical. Commit the already
    // sanitized PromptPackage value so frozen Raw input remains truthful while
    // path/secret redaction cannot create transport drift.
    userMessageContent: prompt.promptPackage.userQuestion,
    authorizedFileRefIds: authorizedMaterialIds,
    validateAuthorizedFileRefSelection: () => {
      const actual = canonicalIds(authorizedMaterialIds);
      if (actual.length !== authorizedMaterialIds.length || actual.some((id, index) => id !== authorizedMaterialIds[index])) {
        throw new Error("QUICK_ANALYSIS_AUTHORIZED_MATERIAL_SET_INVALID");
      }
    },
    trace: buildDurableAIInvocationTrace(
      contextPackage,
      { id: prompt.promptPackage.id, createdAt: prompt.promptPackage.createdAt },
      {
        sourceRefs: prompt.promptPackage.sourceRefs,
        warnings: prompt.promptPackage.warnings,
        budgetSummary: prompt.promptPackage.budgetSummary
      }
    )
  });
  input.onCallAttemptPrepared?.("chat_response", handle.callAttemptId);
  const generated = await handle.completion;
  const body = requireCompletedVisibleBody(generated);
  const intent = createQuickAnalysisCandidateIntent({
    ownerType: preflight.ownerType,
    ownerId: preflight.ownerId,
    channel: preflight.channel,
    projectId: preflight.projectId,
    body,
    runId: input.runId,
    conversationId: conversation.id,
    bodyCallAttemptId: generated.callAttempt.id,
    sourceFileRefId: preflight.sourceFileRef.id,
    sourceDirectoryFileRefId: preflight.sourceDirectory.folderFileRefId,
    sourceDirectoryPathIdentityKey: preflight.sourceDirectory.pathIdentityKey,
    sourceFreshnessReceipt: { ...preflight.sourceCatalogEntry.materialFreshnessReceipt! },
    sourceSnapshot,
    candidateDocumentScaffold: preflight.candidateDocumentScaffold,
    occurredAt: input.occurredAt
  });
  input.onPhase?.("CANDIDATE_PUBLISH", conversation.id);
  const applied = await applyCanonicalQuickAnalysisCandidateIntent({
    intent,
    bindingBaseline: { ...preflight.binding }
  });
  input.onPhase?.("POST_PUBLISH_READBACK", conversation.id);
  if (applied.kind === "settled") {
    return {
      terminalState: "SUCCEEDED",
      ...(preflight.projectId ? { projectId: preflight.projectId } : {}),
      conversationId: conversation.id,
      quickAnalysisCallAttemptIds: [generated.callAttempt.id],
      whitelistFingerprint,
      sourceContentHash: sourceSnapshot.sourceContentHash,
      candidateFileRefId: applied.candidateFileRefId,
      candidateTerminalCommitState: "POST_PUBLISH_READBACK_CONFIRMED",
      ...(generated.callAttempt.responseTruncated
        ? { outputIncompleteNotice: "PROVIDER_REPORTED_TRUNCATION" as const }
        : {})
    };
  }
  if (applied.kind === "terminal_effect_outcome_unknown") {
    return {
      terminalState: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
      ...(preflight.projectId ? { projectId: preflight.projectId } : {}),
      conversationId: conversation.id,
      quickAnalysisCallAttemptIds: [generated.callAttempt.id],
      whitelistFingerprint,
      sourceContentHash: sourceSnapshot.sourceContentHash,
      ...(applied.candidateFileRefId ? { candidateFileRefId: applied.candidateFileRefId } : {}),
      errorCode: applied.code,
      errorMessage: applied.message
    };
  }
  throw new Error(`${applied.code}: ${applied.message}`);
}

export interface QuickAnalysisCoordinatorDependencies {
  createRunId(): string;
  now(): string;
  execute(input: {
    runId: string;
    occurredAt: string;
    start: QuickAnalysisStartInput;
    onPhase?: (phase: QuickAnalysisRunPhase, conversationId?: string) => void;
    onCallAttemptPrepared?: (purpose: "chat_response", callAttemptId: string) => void;
  }): Promise<CanonicalExecutionOutcome>;
}

const defaultCoordinatorDependencies: QuickAnalysisCoordinatorDependencies = {
  createRunId: () => createRepositoryEntityId("quick-analysis-run"),
  now: () => new Date().toISOString(),
  execute: executeCanonicalQuickAnalysisRun
};

export function createQuickAnalysisCoordinator(
  overrides: Partial<QuickAnalysisCoordinatorDependencies> = {}
) {
  const dependencies = { ...defaultCoordinatorDependencies, ...overrides };
  const active = new Map<string, { runId: string; completion: Promise<QuickAnalysisRunSnapshot> }>();
  const snapshots = new Map<string, QuickAnalysisRunSnapshot>();
  const listeners = new Set<(snapshot: QuickAnalysisRunSnapshot) => void>();
  const publish = (snapshot: QuickAnalysisRunSnapshot) => {
    const frozen = cloneSnapshot(snapshot);
    snapshots.set(snapshot.key, frozen);
    for (const listener of listeners) listener(cloneSnapshot(frozen));
  };
  return Object.freeze({
    start(start: QuickAnalysisStartInput): QuickAnalysisStartResult {
      const key = runKey(start);
      const existing = active.get(key);
      if (existing) {
        return { kind: "already_running", runId: existing.runId, completion: existing.completion };
      }
      const runId = dependencies.createRunId();
      const startedAt = dependencies.now();
      let snapshot: QuickAnalysisRunSnapshot = {
        key,
        runId,
        ownerType: start.ownerType,
        ownerId: start.ownerId,
        channel: start.channel,
        phase: "START_RESERVED",
        terminalState: "START_RESERVED",
        startedAt,
        updatedAt: startedAt,
        quickAnalysisCallAttemptIds: [],
        acquiredKeyReleaseCount: 0
      };
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (active.get(key)?.runId === runId) active.delete(key);
        snapshot = { ...snapshot, acquiredKeyReleaseCount: 1, updatedAt: dependencies.now() };
        publish(snapshot);
      };
      const completion = Promise.resolve().then(async () => {
        snapshot = { ...snapshot, phase: "PREFLIGHT", terminalState: "RUNNING", updatedAt: dependencies.now() };
        publish(snapshot);
        try {
          const outcome = await dependencies.execute({
            runId,
            occurredAt: startedAt,
            start,
            onPhase: (phase, conversationId) => {
              snapshot = {
                ...snapshot,
                phase,
                ...(conversationId ? { conversationId } : {}),
                updatedAt: dependencies.now()
              };
              publish(snapshot);
            },
            onCallAttemptPrepared: (_purpose, callAttemptId) => {
              if (snapshot.quickAnalysisCallAttemptIds.includes(callAttemptId)) return;
              snapshot = {
                ...snapshot,
                quickAnalysisCallAttemptIds: [...snapshot.quickAnalysisCallAttemptIds, callAttemptId],
                updatedAt: dependencies.now()
              };
              publish(snapshot);
            }
          });
          snapshot = { ...snapshot, ...outcome, phase: "TERMINAL", updatedAt: dependencies.now() };
        } catch (error) {
          snapshot = {
            ...snapshot,
            phase: "TERMINAL",
            terminalState: "FAILED",
            ...normalizeRunFailure(error),
            updatedAt: dependencies.now()
          };
        } finally {
          publish(snapshot);
          release();
        }
        return cloneSnapshot(snapshot);
      });
      active.set(key, { runId, completion });
      publish(snapshot);
      return { kind: "started", runId, completion };
    },
    getSnapshot(input: Pick<QuickAnalysisStartInput, "ownerType" | "ownerId" | "channel">) {
      const snapshot = snapshots.get(runKey(input));
      return snapshot ? cloneSnapshot(snapshot) : undefined;
    },
    subscribe(listener: (snapshot: QuickAnalysisRunSnapshot) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isRunning(input: Pick<QuickAnalysisStartInput, "ownerType" | "ownerId" | "channel">) {
      return active.has(runKey(input));
    }
  });
}

/** Application-scoped singleton: navigation/component unmount never owns run lifetime. */
export const quickAnalysisCoordinator = createQuickAnalysisCoordinator();
