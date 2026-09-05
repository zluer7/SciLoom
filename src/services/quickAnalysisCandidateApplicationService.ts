import type { FileRef, ManuscriptBinding } from "../types";
import type { AIMaterialFreshnessReceipt } from "../types/aiContext";
import { fileRefService } from "./fileRefService";
import { assertLiteratureDocumentV2 } from "./literatureMarkdownCodecService";
import {
  parseLabPodMarkdownDocument,
  serializeLabPodMarkdownDocument
} from "./labPodMarkdownDocumentService";
import { manuscriptBindingService } from "./manuscriptBindingService";
import { manuscriptIoService } from "./manuscriptIoService";
import {
  resolveQuickAnalysisCapabilityBinding,
  type QuickAnalysisChannel,
  type QuickAnalysisOwnerType
} from "./quickAnalysisCapabilityBinding";
import { saveQuickAnalysisCandidateThroughLocalPort } from "./quickAnalysisCandidateApplicationPorts";

export const QUICK_ANALYSIS_CANDIDATE_APPLICATION_SEAM =
  "applyCanonicalQuickAnalysisCandidateIntent" as const;

export type QuickAnalysisSourceSnapshot = {
  sourceFileRefId: string;
  sourceContentHash: string;
  rawContent: string;
  contentState: "READABLE_EMPTY" | "READABLE_NONEMPTY_RAW";
};

export type QuickAnalysisCandidateDocumentScaffold = {
  metaSnapshot: string;
  outline: string;
};

export type QuickAnalysisCandidateIntent = {
  category: "MANUSCRIPT_RESULT";
  action: "NEW_MANUSCRIPT";
  target: {
    ownerType: QuickAnalysisOwnerType;
    ownerId: string;
    channel: QuickAnalysisChannel;
    projectId?: string;
  };
  payload: { body: string };
  provenance: {
    sourceSemantics: "START_TIME_SNAPSHOT";
    runId: string;
    conversationId: string;
    bodyCallAttemptId: string;
    sourceFileRefId: string;
    sourceDirectoryFileRefId: string;
    sourceDirectoryPathIdentityKey: string;
    sourceFreshnessReceipt: AIMaterialFreshnessReceipt;
    sourceContentHash: string;
  };
  candidateDocumentScaffold: QuickAnalysisCandidateDocumentScaffold;
  occurredAt: string;
};

export type QuickAnalysisCandidateApplicationOutcome =
  | { kind: "settled"; candidateFileRefId: string }
  | { kind: "no_effect_failure"; code: string; message: string }
  | {
      kind: "terminal_effect_outcome_unknown";
      code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN";
      message: string;
      candidateFileRefId?: string;
    };

function hashText(value: string) {
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b1;
  for (const byte of new TextEncoder().encode(value)) {
    hashA ^= byte;
    hashA = Math.imul(hashA, 0x01000193) >>> 0;
    hashB ^= byte;
    hashB = Math.imul(hashB, 0x01000193) >>> 0;
  }
  return `fnv1a64:${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
}

export function validateQuickAnalysisCandidateBody(body: unknown): string {
  if (typeof body !== "string" || !body.trim() || body.includes("\0")) {
    throw new Error("QUICK_ANALYSIS_BODY_NOT_SAVEABLE");
  }
  return body;
}

export async function captureQuickAnalysisSourceSnapshot(input: {
  ownerType: QuickAnalysisOwnerType;
  ownerId: string;
  channel: QuickAnalysisChannel;
  sourceFileRefId: string;
}): Promise<QuickAnalysisSourceSnapshot> {
  const source = await manuscriptIoService.readManuscriptByFileRef(
    input.ownerType,
    input.ownerId,
    input.sourceFileRefId,
    { manuscriptChannel: input.channel }
  );
  if (source.status !== "success") {
    throw new Error("QUICK_ANALYSIS_SOURCE_CONTENT_UNREADABLE");
  }
  if (source.fileRefId !== input.sourceFileRefId || source.encoding !== "utf-8") {
    throw new Error("QUICK_ANALYSIS_SOURCE_CONTENT_UNREADABLE");
  }
  return {
    sourceFileRefId: input.sourceFileRefId,
    sourceContentHash: hashText(source.content),
    rawContent: source.content,
    contentState: source.content.length === 0 ? "READABLE_EMPTY" : "READABLE_NONEMPTY_RAW"
  };
}

export function createQuickAnalysisCandidateIntent(input: {
  ownerType: QuickAnalysisOwnerType;
  ownerId: string;
  channel: QuickAnalysisChannel;
  projectId?: string;
  body: string;
  runId: string;
  conversationId: string;
  bodyCallAttemptId: string;
  sourceFileRefId: string;
  sourceDirectoryFileRefId: string;
  sourceDirectoryPathIdentityKey: string;
  sourceFreshnessReceipt: AIMaterialFreshnessReceipt;
  sourceSnapshot: QuickAnalysisSourceSnapshot;
  candidateDocumentScaffold: QuickAnalysisCandidateDocumentScaffold;
  occurredAt: string;
}): QuickAnalysisCandidateIntent {
  const binding = resolveQuickAnalysisCapabilityBinding({
    ownerType: input.ownerType,
    channel: input.channel
  });
  const body = validateQuickAnalysisCandidateBody(input.body);
  const projectRequired = !(
    input.ownerType === "literature" && input.channel === "literature_outline"
  );
  if (
    !input.ownerId.trim() || (projectRequired && !input.projectId?.trim()) || !input.runId.trim() ||
    !input.conversationId.trim() || !input.bodyCallAttemptId.trim() ||
    input.sourceSnapshot.sourceFileRefId !== input.sourceFileRefId ||
    input.sourceSnapshot.sourceContentHash.length === 0 ||
    input.sourceFreshnessReceipt.fileRefId !== input.sourceFileRefId ||
    binding.ownerType !== input.ownerType || binding.channel !== input.channel
  ) {
    throw new Error("QUICK_ANALYSIS_CANDIDATE_INTENT_INVALID");
  }
  if (input.ownerType === "literature") {
    assertLiteratureDocumentV2({
      metaSnapshot: input.candidateDocumentScaffold.metaSnapshot,
      outline: input.candidateDocumentScaffold.outline,
      channel: input.channel
    });
  }
  const serialized = serializeLabPodMarkdownDocument({
    metaSnapshot: input.candidateDocumentScaffold.metaSnapshot,
    outline: input.candidateDocumentScaffold.outline,
    body
  });
  const parse = parseLabPodMarkdownDocument(serialized);
  if (
    (parse.status !== "valid" && parse.status !== "valid-empty") ||
    parse.body !== body
  ) {
    throw new Error("QUICK_ANALYSIS_BODY_NOT_SAVEABLE");
  }
  return {
    category: "MANUSCRIPT_RESULT",
    action: "NEW_MANUSCRIPT",
    target: {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      channel: input.channel,
      ...(input.projectId?.trim() ? { projectId: input.projectId.trim() } : {})
    },
    payload: { body },
    provenance: {
      sourceSemantics: "START_TIME_SNAPSHOT",
      runId: input.runId,
      conversationId: input.conversationId,
      bodyCallAttemptId: input.bodyCallAttemptId,
      sourceFileRefId: input.sourceFileRefId,
      sourceDirectoryFileRefId: input.sourceDirectoryFileRefId,
      sourceDirectoryPathIdentityKey: input.sourceDirectoryPathIdentityKey,
      sourceFreshnessReceipt: { ...input.sourceFreshnessReceipt },
      sourceContentHash: input.sourceSnapshot.sourceContentHash
    },
    candidateDocumentScaffold: { ...input.candidateDocumentScaffold },
    occurredAt: input.occurredAt
  };
}

type ApplicationDependencies = {
  save: typeof saveQuickAnalysisCandidateThroughLocalPort;
  candidates: typeof fileRefService.getCandidateFileRefsByRequestId;
  read: typeof manuscriptIoService.readManuscriptByFileRef;
  binding: typeof manuscriptBindingService.getBindingByOwner;
};

const defaultDependencies: ApplicationDependencies = {
  save: saveQuickAnalysisCandidateThroughLocalPort,
  candidates: fileRefService.getCandidateFileRefsByRequestId,
  read: manuscriptIoService.readManuscriptByFileRef,
  binding: manuscriptBindingService.getBindingByOwner
};

function bindingProjection(binding: ManuscriptBinding | undefined) {
  return binding ? {
    id: binding.id,
    schemaVersion: binding.schemaVersion,
    ownerType: binding.ownerType,
    ownerId: binding.ownerId,
    manuscriptChannel: binding.manuscriptChannel,
    defaultFolderFileRefId: binding.defaultFolderFileRefId ?? null,
    defaultManuscriptFileRefId: binding.defaultManuscriptFileRefId ?? null,
    currentFileRefId: binding.currentFileRefId ?? null,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    deletedAt: binding.deletedAt ?? null
  } : null;
}

function exactBinding(left: ManuscriptBinding | undefined, right: ManuscriptBinding) {
  return JSON.stringify(bindingProjection(left)) === JSON.stringify(bindingProjection(right));
}

function activeCandidateRefs(refs: readonly FileRef[]) {
  return refs.filter((ref) => !ref.deletedAt);
}

function customFieldValue(fileRef: FileRef, name: string) {
  return fileRef.customFields.find((field) => field.name === name)?.value;
}

export function createQuickAnalysisCandidateApplicationService(
  overrides: Partial<ApplicationDependencies> = {}
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return Object.freeze({
    async apply(input: {
      intent: QuickAnalysisCandidateIntent;
      bindingBaseline: ManuscriptBinding;
    }): Promise<QuickAnalysisCandidateApplicationOutcome> {
      const { intent } = input;
      const capability = resolveQuickAnalysisCapabilityBinding({
        ownerType: intent.target.ownerType,
        channel: intent.target.channel
      });
      const requestId = `qa-candidate:${intent.provenance.runId}`;
      let saved;
      try {
        saved = await dependencies.save(capability.domainCandidateApplicationPort, {
          ownerType: intent.target.ownerType,
          ownerId: intent.target.ownerId,
          manuscriptChannel: intent.target.channel,
          requestId,
          occurredAt: intent.occurredAt,
          candidateTitle: "Quick Analysis candidate",
          source: "ai",
          authorization: {
            source: "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION",
            runId: intent.provenance.runId,
            conversationId: intent.provenance.conversationId,
            bodyCallAttemptId: intent.provenance.bodyCallAttemptId,
            sourceFileRefId: intent.provenance.sourceFileRefId,
            sourceDirectoryFileRefId: intent.provenance.sourceDirectoryFileRefId
          },
          frozenWorkspace: {
            folderFileRefId: intent.provenance.sourceDirectoryFileRefId,
            directoryPathIdentityKey: intent.provenance.sourceDirectoryPathIdentityKey
          },
          metaSnapshot: intent.candidateDocumentScaffold.metaSnapshot,
          outline: intent.candidateDocumentScaffold.outline,
          body: intent.payload.body,
          requestToken: 0
        });
      } catch {
        const refs = await dependencies.candidates(
          intent.target.ownerType,
          intent.target.ownerId,
          requestId
        ).then(activeCandidateRefs, () => undefined);
        return {
          kind: "terminal_effect_outcome_unknown",
          code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
          message: "Candidate writer completion is uncertain; automatic create retry is forbidden.",
          ...(refs?.length === 1 ? { candidateFileRefId: refs[0].id } : {})
        };
      }
      const refs = await dependencies.candidates(
        intent.target.ownerType,
        intent.target.ownerId,
        requestId
      ).then(activeCandidateRefs, () => undefined);
      if (!refs) {
        return {
          kind: "terminal_effect_outcome_unknown",
          code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
          message: "Candidate FileRef readback is unavailable; automatic create retry is forbidden."
        };
      }
      const provenNoEffect = refs.length === 0 && !saved.createdFile && !saved.reusedFile &&
        !saved.completedSteps.includes("candidate-file") &&
        !saved.completedSteps.includes("filesystem-outcome-unknown") &&
        (saved.status === "error" || saved.status === "conflict");
      if (provenNoEffect) {
        return {
          kind: "no_effect_failure",
          code: "QUICK_ANALYSIS_CANDIDATE_CREATE_FAILED",
          message: saved.errors.map((error) => error.message).join(" ") ||
            "The candidate writer proved that no candidate was created."
        };
      }
      const candidate = refs.length === 1 ? refs[0] : undefined;
      if (!candidate || (saved.status !== "success" && saved.status !== "skipped")) {
        return {
          kind: "terminal_effect_outcome_unknown",
          code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
          message: "Candidate creation may have crossed the effect boundary; automatic create retry is forbidden.",
          ...(candidate ? { candidateFileRefId: candidate.id } : {})
        };
      }
      const [physical, afterBinding] = await Promise.all([
        dependencies.read(intent.target.ownerType, intent.target.ownerId, candidate.id, {
          manuscriptChannel: intent.target.channel
        }),
        dependencies.binding(intent.target.ownerType, intent.target.ownerId, intent.target.channel)
      ]).catch(() => [undefined, undefined] as const);
      const parsed = physical?.status === "success"
        ? parseLabPodMarkdownDocument(physical.content)
        : undefined;
      const candidateParent = candidate.pathIdentityKey.replace(/[\\/][^\\/]+$/u, "");
      const provenanceConfirmed =
        customFieldValue(candidate, "candidateAuthorizationSource") ===
          "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION" &&
        customFieldValue(candidate, "quickAnalysisRunId") === intent.provenance.runId &&
        customFieldValue(candidate, "quickAnalysisConversationId") === intent.provenance.conversationId &&
        customFieldValue(candidate, "quickAnalysisBodyCallAttemptId") ===
          intent.provenance.bodyCallAttemptId &&
        customFieldValue(candidate, "quickAnalysisParseCallAttemptId") === undefined &&
        customFieldValue(candidate, "quickAnalysisSourceFileRefId") ===
          intent.provenance.sourceFileRefId &&
        customFieldValue(candidate, "quickAnalysisSourceDirectoryFileRefId") ===
          intent.provenance.sourceDirectoryFileRefId;
      const confirmed = saved.fileRefId === candidate.id &&
        candidate.ownerType === intent.target.ownerType &&
        candidate.ownerId === intent.target.ownerId &&
        candidate.manuscriptChannel === intent.target.channel &&
        candidate.resourceKind === "file" && candidate.fileRole === "manuscript" &&
        candidate.locationMode === "managed" && candidate.candidateRequestId === requestId &&
        candidateParent === intent.provenance.sourceDirectoryPathIdentityKey &&
        provenanceConfirmed &&
        physical?.status === "success" && physical.encoding === "utf-8" &&
        parsed && (parsed.status === "valid" || parsed.status === "valid-empty") &&
        parsed.body === intent.payload.body && exactBinding(afterBinding, input.bindingBaseline);
      if (!confirmed) {
        return {
          kind: "terminal_effect_outcome_unknown",
          code: "TERMINAL_EFFECT_OUTCOME_UNKNOWN",
          message: "Candidate physical/FileRef/Binding authoritative readback is incomplete.",
          candidateFileRefId: candidate.id
        };
      }
      return { kind: "settled", candidateFileRefId: candidate.id };
    }
  });
}

export const quickAnalysisCandidateApplicationService =
  createQuickAnalysisCandidateApplicationService();

/** The sole production Quick candidate application seam. */
export async function applyCanonicalQuickAnalysisCandidateIntent(input: {
  intent: QuickAnalysisCandidateIntent;
  bindingBaseline: ManuscriptBinding;
}) {
  return quickAnalysisCandidateApplicationService.apply(input);
}
