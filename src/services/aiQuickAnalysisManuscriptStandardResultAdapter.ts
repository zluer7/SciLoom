import type {
  AIParseDraftSourceSnapshot,
  AIStandardResultTarget,
  AIStandardResultValidationIssue
} from "../types/aiStandardResult";
import { canonicalAIStandardResultFingerprint, AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS } from "./aiStandardResultService";
import { quickAnalysisCanonicalSourcePort } from "./quickAnalysisCanonicalSourcePort";
import { resolveQuickAnalysisCapabilityBinding } from "./quickAnalysisCapabilityBinding";

export const AI_QUICK_ANALYSIS_NEW_MANUSCRIPT_BODY_MAX_CHARS = 6_000;

function issue(code: string, message: string, field?: string): AIStandardResultValidationIssue {
  return { code, message, ...(field ? { field } : {}) };
}

function normalizeBody(value: unknown, issues: AIStandardResultValidationIssue[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue("QUICK_ANALYSIS_MANUSCRIPT_PAYLOAD_INVALID", "The payload requires exactly one body field."));
    return undefined;
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || typeof payload.body !== "string") {
    issues.push(issue("QUICK_ANALYSIS_MANUSCRIPT_PAYLOAD_INVALID", "The payload requires exactly one Markdown body field.", "body"));
    return undefined;
  }
  const body = payload.body;
  const invalid = !body.trim() || body.includes("\0") || body.replace(/\r\n/gu, "").includes("\r") ||
    /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/u.test(body) ||
    /LABPOD_(?:META_SNAPSHOT|OUTLINE|BODY)_(?:START|END)/iu.test(body);
  if (invalid) {
    issues.push(issue(
      "QUICK_ANALYSIS_MANUSCRIPT_BODY_INVALID",
      "body must be non-empty Unicode Markdown without NUL, hidden controls, protocol markers, BOM, or bare CR.",
      "body"
    ));
    return undefined;
  }
  const normalized = body.replace(/\r\n/gu, "\n");
  if (
    Array.from(normalized).length > AI_QUICK_ANALYSIS_NEW_MANUSCRIPT_BODY_MAX_CHARS ||
    Array.from(JSON.stringify({ body: normalized })).length > AI_STANDARD_RESULT_MAX_PAYLOAD_CHARS
  ) {
    issues.push(issue("QUICK_ANALYSIS_MANUSCRIPT_BODY_OVERFLOW", "The manuscript body exceeds the bounded shared limit.", "body"));
    return undefined;
  }
  return normalized;
}

function exactTargetSource(
  target: AIStandardResultTarget,
  source: AIParseDraftSourceSnapshot | undefined
) {
  const quick = source?.quickAnalysisTarget;
  const manuscriptChannel = "manuscriptChannel" in target ? target.manuscriptChannel : undefined;
  return Boolean(
    quick && target.entityId && manuscriptChannel &&
    target.module === quick.ownerType && target.entityType === quick.ownerType &&
    target.entityId === quick.ownerId && manuscriptChannel === quick.channel &&
    target.projectId === quick.projectOrScopeId && source?.projectId === quick.projectOrScopeId
  );
}

export async function validateAIQuickAnalysisManuscriptStandardResultProposal(input: {
  action: string;
  target: AIStandardResultTarget;
  source?: AIParseDraftSourceSnapshot;
  payload: unknown;
  expectedProjectId: string;
  expectedTargetSnapshotFingerprint?: string;
}) {
  const issues: AIStandardResultValidationIssue[] = [];
  const manuscriptChannel = "manuscriptChannel" in input.target
    ? input.target.manuscriptChannel
    : undefined;
  if (input.action !== "NEW_MANUSCRIPT") {
    issues.push(issue("QUICK_ANALYSIS_MANUSCRIPT_ACTION_UNSUPPORTED", "This adapter supports only NEW_MANUSCRIPT."));
  }
  try {
    resolveQuickAnalysisCapabilityBinding({
      ownerType: input.target.module,
      channel: manuscriptChannel ?? ""
    });
  } catch (error) {
    issues.push(issue(
      "QUICK_ANALYSIS_MANUSCRIPT_TARGET_UNSUPPORTED",
      error instanceof Error ? error.message : "The exact owner/channel is unsupported.",
      "target"
    ));
  }
  if (!exactTargetSource(input.target, input.source) || input.target.projectId !== input.expectedProjectId) {
    issues.push(issue(
      "QUICK_ANALYSIS_MANUSCRIPT_SOURCE_TARGET_MISMATCH",
      "The existing manuscript target must equal the frozen Quick Analysis owner/channel/source scope.",
      "target"
    ));
  }
  const normalizedBody = normalizeBody(input.payload, issues);
  let targetSnapshotFingerprint: string | undefined;
  if (issues.length === 0 && input.source?.quickAnalysisTarget) {
    try {
      const quick = input.source.quickAnalysisTarget;
      const preflight = await quickAnalysisCanonicalSourcePort.resolve({
        ownerType: quick.ownerType,
        ownerId: quick.ownerId,
        channel: quick.channel,
        expectedProjectOrScopeId: quick.projectOrScopeId
      });
      if (
        preflight.sourceFileRef.id !== quick.sourceFileRefId ||
        preflight.sourceDirectory.folderFileRefId !== quick.sourceDirectoryFileRefId
      ) {
        issues.push(issue(
          "QUICK_ANALYSIS_MANUSCRIPT_SOURCE_STALE",
          "Binding.current or the canonical managed workspace changed after the Quick Analysis freeze."
        ));
      }
      targetSnapshotFingerprint = canonicalAIStandardResultFingerprint({
        ownerType: preflight.ownerType,
        ownerId: preflight.ownerId,
        channel: preflight.channel,
        projectId: preflight.projectId,
        bindingId: preflight.binding.id,
        bindingUpdatedAt: preflight.binding.updatedAt,
        currentFileRefId: preflight.binding.currentFileRefId,
        defaultFolderFileRefId: preflight.binding.defaultFolderFileRefId
      });
      if (
        input.expectedTargetSnapshotFingerprint &&
        input.expectedTargetSnapshotFingerprint !== targetSnapshotFingerprint
      ) {
        issues.push(issue(
          "QUICK_ANALYSIS_MANUSCRIPT_TARGET_STALE",
          "The exact target snapshot changed after Parse Draft."
        ));
      }
    } catch (error) {
      issues.push(issue(
        "QUICK_ANALYSIS_MANUSCRIPT_TARGET_UNAVAILABLE",
        error instanceof Error ? error.message : "The exact target is unavailable."
      ));
    }
  }
  return {
    executable: issues.length === 0 && normalizedBody !== undefined,
    normalizedPayload: normalizedBody === undefined ? {} : { body: normalizedBody },
    validationIssues: issues,
    ...(targetSnapshotFingerprint ? { targetSnapshotFingerprint } : {}),
    ...(issues.length === 0 ? { resolvedTarget: { ...input.target } } : {})
  };
}
