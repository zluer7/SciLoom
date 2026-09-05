import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableManuscriptItem,
  ManuscriptChannel
} from "../../types";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../../types/sharedManuscriptSession";
import {
  buildLiteratureManuscriptView,
  literatureManuscriptAdapterService,
  type LiteratureManuscriptBlocks
} from "../../services/literatureManuscriptAdapterService";
import {
  createLiteratureManuscriptFormalSwitchService,
  type LiteratureManuscriptFormalSwitchService
} from "../../services/literatureManuscriptFormalSwitchService";
import {
  literatureManuscriptService,
  resolveLiteratureWorkspaceFolder,
  type LiteratureTargetManuscriptDocument
} from "../../services/literatureManuscriptService";
import {
  literatureRawManuscriptService,
  type LiteratureManuscriptChannel
} from "../../services/literatureRawManuscriptService";
import {
  literatureManuscriptSaveAsAdapter
} from "../../services/literatureManuscriptSaveAsAdapter";
import type {
  LiteratureManuscriptCandidateCustodyReceipt,
  LiteratureManuscriptCandidateCustodyRequest,
  LiteratureManuscriptChannelLease,
  LiteratureManuscriptHandleProtectionRegistry
} from "../../services/literatureManuscriptHandleProtectionRegistry";
import { manuscriptRequestTokenController } from "../../services/manuscriptRequestTokenController";
import {
  independentManuscriptOpenProtocol,
  type IndependentOpenActivationResult,
  type IndependentOpenProductAdapter,
  type IndependentManuscriptOpenProtocol,
  resolveIndependentOpenConsumerCleanup
} from "../../services/independentManuscriptOpenProtocol";
import { createIndependentOpenPreviewProvider } from "../../services/independentManuscriptOpenPreviewProvider";
import { compareSaveAsRecoveryOrder } from "../../services/manuscriptSaveAsOperationPort";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";
import { windowPContainmentFeedbackMessage } from "../../services/manuscriptSaveAsWindowPContainment";
import { ordinarySavePresentation } from "../../services/ordinaryOperationPresentation";
import { buildCanonicalFormalSwitchArchiveCandidate } from "../../services/canonicalFormalSwitchArchiveConvergence";
import { buildFormalSwitchConfirmationCopy, projectFormalSwitchFailure } from "../../services/manuscriptFormalSwitchPresentation";
import type { ManuscriptSegmentDraftSnapshot } from "../../types/manuscriptSegmentProjection";

type FeedbackSeverity = "success" | "warning" | "error" | "info";
type LiteratureChoiceValue = "confirm" | "cancel";

export interface LiteratureManuscriptChoiceDialog {
  title: string;
  message: string;
  options: ReadonlyArray<{
    value: LiteratureChoiceValue;
    label: string;
    emphasis?: "primary";
  }>;
}

function resultMessage(result: unknown, fallback: string) {
  if (!result || typeof result !== "object") return fallback;
  const record = result as {
    error?: { message?: unknown; code?: unknown };
    message?: unknown;
  };
  return typeof record.error?.message === "string"
    ? record.error.message
    : typeof record.message === "string"
      ? record.message
      : typeof record.error?.code === "string"
        ? record.error.code
        : fallback;
}

function extractedView(
  session: SharedManuscriptSession,
  channel: LiteratureManuscriptChannel
) {
  return literatureManuscriptAdapterService.extract(
    session.draftRawText,
    channel
  );
}

function currentDocumentView(
  session: SharedManuscriptSession,
  channel: LiteratureManuscriptChannel
) {
  if (session.file.kind !== "durable") return null;
  const extracted = extractedView(session, channel);
  if (extracted.status === "error") return null;
  return {
    fileRefId: session.file.fileRefId,
    loadedContent: session.draftRawText,
    requestToken: session.requestGeneration,
    parseStatus: extracted.blocks.parseStatus,
    isDirty: session.dirty
  };
}

function targetDocumentView(
  session: SharedManuscriptSession,
  channel: LiteratureManuscriptChannel,
  missingFallback?: LiteratureManuscriptBlocks
): LiteratureTargetManuscriptDocument | null {
  if (session.file.kind !== "durable") return null;
  const extracted = extractedView(session, channel);
  if (extracted.status === "error") return null;
  const blocks =
    extracted.blocks.parseStatus === "missing" && missingFallback
      ? missingFallback
      : extracted.blocks;
  const baseline = session.baseline
    ? literatureManuscriptAdapterService.extract(
        session.baseline.rawText,
        channel
      )
    : extracted;
  const loaded =
    baseline.status === "success" &&
    baseline.blocks.parseStatus !== "missing"
      ? baseline.blocks
      : blocks;
  return {
    literatureId: session.owner.ownerId,
    manuscriptChannel: channel,
    fileRefId: session.file.fileRefId,
    displayName: session.file.fileName,
    locationMode: session.file.locationMode,
    rawMarkdown: session.draftRawText,
    metaSnapshot: blocks.metaSnapshot,
    outline: blocks.outline,
    body: blocks.body,
    loadedOutline: loaded.outline,
    loadedBody: loaded.body,
    parseStatus: blocks.parseStatus,
    diagnostics: blocks.diagnostics,
    createdAt: session.createdAt,
    requestToken: session.requestGeneration
  };
}

let literatureLifecycleEpochSequence = 0;

function nextLiteratureLifecycleEpoch() {
  literatureLifecycleEpochSequence += 1;
  return literatureLifecycleEpochSequence;
}

function compareRecoveryOperations(
  left: { operationId: string; updatedAt?: string },
  right: { operationId: string; updatedAt?: string }
) {
  return compareSaveAsRecoveryOrder(
    { operationId: left.operationId, updatedAt: left.updatedAt ?? "" },
    { operationId: right.operationId, updatedAt: right.updatedAt ?? "" }
  );
}

type LiteratureReplacementLifecycleFacts = {
  expectedLiteratureId: string;
  expectedChannel: LiteratureManuscriptChannel;
  expectedOwnerMountEpoch: number;
  expectedChannelLifecycleEpoch: number;
  expectedReplacementGeneration: number;
  expectedRecoverySweepGeneration?: number;
  operation: string;
};

type LiteratureIndependentReplacementInput =
  | (LiteratureReplacementLifecycleFacts & {
      kind: "install";
      nextHandle: SharedManuscriptSessionHandle;
      expectedFileRefId: string;
      custody: {
        request:
          LiteratureManuscriptCandidateCustodyRequest;
        receipt:
          LiteratureManuscriptCandidateCustodyReceipt;
      };
    })
  | (LiteratureReplacementLifecycleFacts & {
      kind: "clear";
    });

function isDurableExpectedFileRefId(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function isCandidateFileRefIdentityValid(
  candidateSession: SharedManuscriptSession,
  expectedFileRefId: string
) {
  return (
    candidateSession.file.kind === "durable" &&
    candidateSession.file.fileRefId === expectedFileRefId &&
    candidateSession.logicalIdentity.fileRefId ===
      expectedFileRefId
  );
}

export function useLiteratureManuscriptEditor(input: {
  literatureId?: string;
  manuscriptChannel: ManuscriptChannel;
  ui(source: string): string;
  onFeedback(
    severity: FeedbackSeverity,
    title: string,
    operation: string
  ): void;
  onReloadDetail(literatureId: string): Promise<void>;
  independentOpenProtocol?: IndependentManuscriptOpenProtocol;
  independentOpenPreviewProvider?: ReturnType<
    typeof createIndependentOpenPreviewProvider
  >;
  saveAsService?: typeof literatureManuscriptSaveAsAdapter;
  handleProtectionRegistry:
    LiteratureManuscriptHandleProtectionRegistry;
}) {
  const openProtocol =
    input.independentOpenProtocol ?? independentManuscriptOpenProtocol;
  const saveAsService =
    input.saveAsService ?? literatureManuscriptSaveAsAdapter;
  const handleProtectionRegistry =
    input.handleProtectionRegistry;
  const { onFeedback, ui } = input;
  if (
    input.manuscriptChannel !== "literature_outline" &&
    input.manuscriptChannel !== "dedicated_notes"
  ) {
    throw new Error("LITERATURE_MANUSCRIPT_CHANNEL_INVALID");
  }
  const channel: LiteratureManuscriptChannel = input.manuscriptChannel;
  const [workflow, setWorkflow] =
    useState<LiteratureManuscriptFormalSwitchService | null>(null);
  const [available, setAvailable] = useState<AvailableManuscriptItem[]>([]);
  const [currentHandle, setCurrentHandle] =
    useState<SharedManuscriptSessionHandle>();
  const [targetHandle, setTargetHandle] =
    useState<SharedManuscriptSessionHandle>();
  const [targetMissingFallback, setTargetMissingFallback] =
    useState<LiteratureManuscriptBlocks>();
  const [busy, setBusy] = useState(false);
  const [targetPresentationRevision, setTargetPresentationRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [choiceDialog, setChoiceDialog] =
    useState<LiteratureManuscriptChoiceDialog | null>(null);
  const choiceResolver =
    useRef<((choice: LiteratureChoiceValue | null) => void) | null>(null);
  const activeLiteratureId = useRef(input.literatureId);
  const targetRequestSequence = useRef(0);
  const currentHandleRef = useRef(currentHandle);
  const activeIndependentHandleRef =
    useRef<SharedManuscriptSessionHandle>();
  const ownerMountEpochRef = useRef(0);
  const channelLifecycleEpochRef = useRef(0);
  const replacementGenerationRef = useRef(0);
  const recoverySweepGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const currentLiteratureIdRef = useRef<string>();
  const currentChannelRef = useRef<LiteratureManuscriptChannel>();
  const channelLeaseRef =
    useRef<LiteratureManuscriptChannelLease>();
  activeLiteratureId.current = input.literatureId;
  currentHandleRef.current = currentHandle;

  const currentSession = useMemo(
    () =>
      currentHandle
        ? literatureRawManuscriptService.getSession(
            currentHandle,
            channel,
            "current"
          )
        : undefined,
    [currentHandle, channel, sessionRevision]
  );
  const targetSession = useMemo(
    () =>
      targetHandle
        ? literatureRawManuscriptService.getSession(
            targetHandle,
            channel,
            "independent"
          )
        : undefined,
    [targetHandle, channel, sessionRevision]
  );
  const document = useMemo(
    () =>
      currentSession ? currentDocumentView(currentSession, channel) : null,
    [currentSession, channel]
  );
  const targetDocument = useMemo(
    () =>
      targetSession
        ? targetDocumentView(
            targetSession,
            channel,
            targetMissingFallback
          )
        : null,
    [targetSession, channel, targetMissingFallback]
  );

  function active(
    candidate: LiteratureManuscriptFormalSwitchService
  ) {
    return (
      mountedRef.current &&
      activeLiteratureId.current === candidate.ownerId &&
      candidate.manuscriptChannel === channel
    );
  }

  function isCurrentLifecycle(expected: {
    literatureId: string;
    channel: LiteratureManuscriptChannel;
    ownerMountEpoch: number;
    channelLifecycleEpoch: number;
    replacementGeneration?: number;
    recoverySweepGeneration?: number;
  }) {
    const lease = channelLeaseRef.current;
    return (
      mountedRef.current &&
      Boolean(
        lease &&
          lease.literatureId === expected.literatureId &&
          lease.channel === expected.channel &&
          handleProtectionRegistry.isCurrentLease(
            lease
          )
      ) &&
      currentLiteratureIdRef.current === expected.literatureId &&
      currentChannelRef.current === expected.channel &&
      ownerMountEpochRef.current === expected.ownerMountEpoch &&
      channelLifecycleEpochRef.current ===
        expected.channelLifecycleEpoch &&
      (expected.replacementGeneration === undefined ||
        replacementGenerationRef.current ===
          expected.replacementGeneration) &&
      (expected.recoverySweepGeneration === undefined ||
        recoverySweepGenerationRef.current ===
          expected.recoverySweepGeneration)
    );
  }

  async function closeExactIndependentHandle(
    handle: SharedManuscriptSessionHandle,
    context: {
      literatureId: string;
      channel: LiteratureManuscriptChannel;
      ownerMountEpoch: number;
      channelLifecycleEpoch: number;
      operation: string;
    }
  ) {
    let lastResult: Awaited<
      ReturnType<
        typeof literatureRawManuscriptService.closeExact
      >
    > | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastResult =
        await literatureRawManuscriptService.closeExact(
        handle,
        "discard"
      );
      if (lastResult.status === "closed") {
        handleProtectionRegistry.clearCleanupBlockedResidual(
          handle
        );
        return {
          status: "closed" as const,
          result: lastResult
        };
      }
      if (
        lastResult.status === "already_absent"
      ) {
        handleProtectionRegistry.clearCleanupBlockedResidual(
          handle
        );
        return {
          status: "already-absent" as const,
          result: lastResult
        };
      }
    }
    handleProtectionRegistry.preserveCleanupBlockedResidual(
      handle
    );
    input.onFeedback(
      "error",
      input.ui(
        `文献独立文稿句柄清理未完成：${resultMessage(
          lastResult?.runtimeResult,
          "LITERATURE_SAVE_AS_HANDLE_CLEANUP_UNRESOLVED"
        )}`
      ),
      "literature.manuscript.lifecycle.cleanupBlocked"
    );
    return {
      status: "cleanup-blocked" as const,
      handle,
      literatureId: context.literatureId,
      channel: context.channel,
      ownerMountEpoch: context.ownerMountEpoch,
      channelLifecycleEpoch: context.channelLifecycleEpoch,
      operation: context.operation,
      result: lastResult
    };
  }

  async function replaceActiveIndependentHandle(
    input: LiteratureIndependentReplacementInput
  ) {
    const rawInput =
      input as unknown as Record<string, unknown>;
    const nextHandle =
      rawInput.nextHandle as
        | SharedManuscriptSessionHandle
        | undefined;
    const expectedFileRefId =
      rawInput.expectedFileRefId;
    const custody =
      rawInput.custody as
        | {
            request:
              LiteratureManuscriptCandidateCustodyRequest;
            receipt:
              LiteratureManuscriptCandidateCustodyReceipt;
          }
        | undefined;
    const installing =
      input.kind === "install" ||
      nextHandle !== undefined;
    const custodyVerified = Boolean(
      installing &&
        nextHandle &&
        custody &&
        custody.receipt.handle === nextHandle &&
        handleProtectionRegistry.verifyReceipt(
          custody.request,
          custody.receipt
        )
    );
    if (installing && (!nextHandle || !custodyVerified)) {
      if (custody) {
        handleProtectionRegistry.completeCandidate(
          custody.request,
          "protocol_violation"
        );
      }
      onFeedback(
        "error",
        ui(
          "Literature manuscript candidate custody could not be verified; no Runtime handle was closed."
        ),
        "literature.manuscript.lifecycle.protocolViolation"
      );
      return {
        status: "protocol-violation" as const
      };
    }

    const nextSession =
      installing && nextHandle
        ? literatureRawManuscriptService.getSession(
            nextHandle,
            input.expectedChannel,
            "independent"
          )
        : undefined;
    const lifecycleCurrent = isCurrentLifecycle({
      literatureId: input.expectedLiteratureId,
      channel: input.expectedChannel,
      ownerMountEpoch: input.expectedOwnerMountEpoch,
      channelLifecycleEpoch:
        input.expectedChannelLifecycleEpoch,
      replacementGeneration:
        input.expectedReplacementGeneration,
      recoverySweepGeneration:
        input.expectedRecoverySweepGeneration
    });
    const channelLease = channelLeaseRef.current;
    const leaseCurrent = Boolean(
      channelLease &&
        handleProtectionRegistry.isCurrentLease(
          channelLease
        )
    );
    const expectedIdentityValid =
      isDurableExpectedFileRefId(
        expectedFileRefId
      );
    const nextValid = Boolean(
      installing &&
        nextSession &&
        nextSession.owner.ownerType === "literature" &&
        nextSession.owner.ownerId ===
          input.expectedLiteratureId &&
        nextSession.owner.channel ===
          input.expectedChannel &&
        nextSession.windowRole === "independent" &&
        expectedIdentityValid &&
        isCandidateFileRefIdentityValid(
          nextSession,
          expectedFileRefId
        )
    );
    const protectedAlias = Boolean(
      nextHandle &&
        handleProtectionRegistry.isProtected(
          nextHandle
        )
    );
    if (
      installing &&
      nextHandle &&
      (!lifecycleCurrent ||
        !leaseCurrent ||
        !nextValid)
    ) {
      if (protectedAlias) {
        if (!custody) {
          return {
            status: "protocol-violation" as const
          };
        }
        handleProtectionRegistry.completeCandidate(
          custody.request,
          "released_as_protected_alias"
        );
        return {
          status: "protected-alias-released" as const
        };
      }
      const cleanup = await closeExactIndependentHandle(
        nextHandle,
        {
          literatureId:
            input.expectedLiteratureId,
          channel: input.expectedChannel,
          ownerMountEpoch:
            input.expectedOwnerMountEpoch,
          channelLifecycleEpoch:
            input.expectedChannelLifecycleEpoch,
          operation: input.operation
        }
      );
      if (!custody) {
        return {
          status: "protocol-violation" as const
        };
      }
      handleProtectionRegistry.completeCandidate(
        custody.request,
        cleanup.status === "closed"
          ? "closed"
          : cleanup.status === "already-absent"
            ? "already_absent"
            : "cleanup_blocked"
      );
      return {
        status:
          cleanup.status === "closed" ||
          cleanup.status === "already-absent"
            ? "stale-cleaned"
            : "cleanup-blocked",
        cleanup
      } as const;
    }
    if (
      installing &&
      nextHandle &&
      activeIndependentHandleRef.current ===
        nextHandle
    ) {
      if (!custody) {
        return {
          status: "protocol-violation" as const
        };
      }
      handleProtectionRegistry.completeCandidate(
        custody.request,
        "released_as_protected_alias"
      );
      return { status: "retained" as const };
    }
    if (
      !installing &&
      (!lifecycleCurrent || !leaseCurrent)
    ) {
      return { status: "stale-lease" as const };
    }
    const displaced =
      activeIndependentHandleRef.current;
    if (!channelLease || !leaseCurrent) {
      return { status: "stale-lease" as const };
    }
    const displacedCleanup = displaced
      ? await closeExactIndependentHandle(
          displaced,
          {
            literatureId:
              input.expectedLiteratureId,
            channel: input.expectedChannel,
            ownerMountEpoch:
              input.expectedOwnerMountEpoch,
            channelLifecycleEpoch:
              input.expectedChannelLifecycleEpoch,
            operation: input.operation
          }
        )
      : undefined;
    if (
      displacedCleanup?.status ===
      "cleanup-blocked"
    ) {
      if (nextHandle && custodyVerified) {
        handleProtectionRegistry.preserveCleanupBlockedResidual(
          nextHandle
        );
      }
      if (custody) {
        handleProtectionRegistry.completeCandidate(
          custody.request,
          "cleanup_blocked"
        );
      }
      return {
        status: "cleanup-blocked" as const,
        cleanup: displacedCleanup,
        candidateCleanup:
          nextHandle && custodyVerified
            ? {
                status: "cleanup-blocked" as const,
                handle: nextHandle,
                literatureId:
                  input.expectedLiteratureId,
                channel: input.expectedChannel,
                ownerMountEpoch:
                  input.expectedOwnerMountEpoch,
                channelLifecycleEpoch:
                  input.expectedChannelLifecycleEpoch,
                operation:
                  `${input.operation}:candidate`
              }
            : undefined
      };
    }
    const slotReplacement =
      handleProtectionRegistry.replaceIndependent(
        channelLease,
        input.expectedReplacementGeneration,
        nextHandle
      );
    if (
      slotReplacement.status === "protected_alias"
    ) {
      if (custody) {
        handleProtectionRegistry.completeCandidate(
          custody.request,
          "released_as_protected_alias"
        );
      }
      return {
        status: "protected-alias-released" as const
      };
    }
    if (
      slotReplacement.status ===
        "rejected_stale_owner_lease" ||
      slotReplacement.status ===
        "rejected_stale_channel_lease" ||
      slotReplacement.status ===
        "rejected_stale_generation"
    ) {
      const becameProtected = Boolean(
        nextHandle &&
          handleProtectionRegistry.isProtected(
            nextHandle
          )
      );
      const staleCandidateCleanup =
        nextHandle &&
        custodyVerified &&
        !becameProtected
          ? await closeExactIndependentHandle(
              nextHandle,
              {
                literatureId:
                  input.expectedLiteratureId,
                channel: input.expectedChannel,
                ownerMountEpoch:
                  input.expectedOwnerMountEpoch,
                channelLifecycleEpoch:
                  input.expectedChannelLifecycleEpoch,
                operation: `${input.operation}:stale-lease`
              }
            )
          : undefined;
      if (custody) {
        handleProtectionRegistry.completeCandidate(
          custody.request,
          becameProtected
            ? "released_as_protected_alias"
            : staleCandidateCleanup?.status === "closed"
            ? "closed"
            : staleCandidateCleanup?.status ===
                "already-absent"
              ? "already_absent"
              : staleCandidateCleanup
                ? "cleanup_blocked"
                : "protocol_violation"
        );
      }
      return {
        status: "stale-lease" as const,
        cleanup: staleCandidateCleanup
      };
    }
    activeIndependentHandleRef.current =
      nextHandle;
    setTargetHandle(nextHandle);
    setTargetMissingFallback(undefined);
    refreshSessions();
    if (custody) {
      handleProtectionRegistry.completeCandidate(
        custody.request,
        nextHandle
          ? "transferred"
          : "released_as_protected_alias"
      );
    }
    return {
      status: nextHandle
        ? "installed" as const
        : "cleared" as const,
      cleanup: displacedCleanup
    } as const;
  }

  function refreshSessions() {
    setSessionRevision((current) => current + 1);
  }

  function replaceCurrentHandle(
    nextHandle?: SharedManuscriptSessionHandle
  ) {
    const lease = channelLeaseRef.current;
    const previous = currentHandleRef.current;
    if (lease && previous) {
      handleProtectionRegistry.releaseCurrent(
        lease,
        previous
      );
    }
    if (lease && nextHandle) {
      handleProtectionRegistry.protectCurrent(
        lease,
        nextHandle
      );
    }
    currentHandleRef.current = nextHandle;
    setCurrentHandle(nextHandle);
  }

  function manuscriptSelectionMessage(code: string, fallback: string) {
    const messages: Record<string, string> = {
      WORKSPACE_FOLDER_NOT_FOUND: input.ui("工作目录不存在，请重试初始化或检查托管根目录。"),
      WORKSPACE_FOLDER_INVALID: input.ui("工作目录配置无效，请重试初始化。"),
      WORKSPACE_FOLDER_FILE_REF_MISSING: input.ui("工作目录尚未初始化，请先重试初始化文稿。"),
      WORKSPACE_FOLDER_OWNER_MISMATCH: input.ui("工作目录与当前文献不匹配。"),
      WORKSPACE_FOLDER_OUTSIDE_ROOT: input.ui("工作目录不在当前托管根目录内。"),
      MANUSCRIPT_PICKER_INVALID_SELECTION: input.ui("所选文稿无效，请选择 Markdown 文件。"),
      MANUSCRIPT_PICKER_UNSUPPORTED_EXTENSION: input.ui("请选择 .md 或 .markdown 文件。"),
      MANUSCRIPT_PICKER_TARGET_IS_DIRECTORY: input.ui("不能将文件夹作为文稿。"),
      MANUSCRIPT_PICKER_TARGET_NOT_FOUND: input.ui("所选文稿不存在。"),
      MANUSCRIPT_FILE_NOT_FOUND: input.ui("所选文稿不存在。"),
      MANUSCRIPT_PATH_IS_DIRECTORY: input.ui("不能将文件夹作为文稿。"),
      MANUSCRIPT_EXTENSION_UNSUPPORTED: input.ui("请选择 .md 或 .markdown 文件。"),
      MANUSCRIPT_FILE_TOO_LARGE: input.ui("Markdown 文件超过 1 MiB 大小限制。"),
      MANUSCRIPT_ENCODING_INVALID: input.ui("Markdown 文件不是有效的 UTF-8 文本。"),
      MANUSCRIPT_SYMLINK_NOT_ALLOWED: input.ui("不能选择符号链接文稿。")
    };
    return messages[code] ?? fallback;
  }

  async function refreshAvailable(
    candidate: LiteratureManuscriptFormalSwitchService
  ) {
    const next = await candidate.getAvailable();
    if (active(candidate)) setAvailable(next);
  }

  function requestChoice(dialog: LiteratureManuscriptChoiceDialog) {
    choiceResolver.current?.(null);
    setChoiceDialog(dialog);
    return new Promise<LiteratureChoiceValue | null>((resolve) => {
      choiceResolver.current = resolve;
    });
  }

  function resolveChoice(choice: LiteratureChoiceValue | null) {
    const resolve = choiceResolver.current;
    choiceResolver.current = null;
    setChoiceDialog(null);
    resolve?.(choice);
  }

  useEffect(() => {
    targetRequestSequence.current += 1;
    choiceResolver.current?.(null);
    choiceResolver.current = null;
    setChoiceDialog(null);
    setWorkflow(null);
    setAvailable([]);
    replaceCurrentHandle(undefined);
    setTargetMissingFallback(undefined);
    setBusy(false);
    setOpen(false);
    if (!input.literatureId) {
      mountedRef.current = false;
      currentLiteratureIdRef.current = undefined;
      currentChannelRef.current = undefined;
      ownerMountEpochRef.current =
        nextLiteratureLifecycleEpoch();
      channelLifecycleEpochRef.current =
        nextLiteratureLifecycleEpoch();
      replacementGenerationRef.current += 1;
      recoverySweepGenerationRef.current += 1;
      return undefined;
    }
    const literatureId = input.literatureId;
    const ownerMountEpoch =
      nextLiteratureLifecycleEpoch();
    const channelLifecycleEpoch =
      nextLiteratureLifecycleEpoch();
    ownerMountEpochRef.current = ownerMountEpoch;
    channelLifecycleEpochRef.current =
      channelLifecycleEpoch;
    currentLiteratureIdRef.current = literatureId;
    currentChannelRef.current = channel;
    const channelLease =
      handleProtectionRegistry.mountChannel(
        literatureId,
        channel
      );
    channelLeaseRef.current = channelLease;
    mountedRef.current = true;
    replacementGenerationRef.current += 1;
    recoverySweepGenerationRef.current += 1;
    const owner = { ownerType: "literature", ownerId: literatureId, channel } as const;
    const next = createLiteratureManuscriptFormalSwitchService(
      literatureId,
      channel
    );
    setWorkflow(next);
    void refreshAvailable(next);
    return () => {
      openProtocol.cancelOwner(owner);
      const current = currentHandleRef.current;
      const replacementGeneration =
        replacementGenerationRef.current + 1;
      replacementGenerationRef.current =
        replacementGeneration;
      recoverySweepGenerationRef.current += 1;
      void replaceActiveIndependentHandle({
        kind: "clear",
        expectedLiteratureId: literatureId,
        expectedChannel: channel,
        expectedOwnerMountEpoch: ownerMountEpoch,
        expectedChannelLifecycleEpoch:
          channelLifecycleEpoch,
        expectedReplacementGeneration:
          replacementGeneration,
        operation: "owner-channel-transition"
      });
      if (current) {
        handleProtectionRegistry.releaseCurrent(
          channelLease,
          current
        );
        void literatureRawManuscriptService.close(
          current,
          channel,
          "current",
          "discard"
        );
      }
      currentHandleRef.current = undefined;
      handleProtectionRegistry.unmountChannel(
        channelLease
      );
      if (channelLeaseRef.current === channelLease) {
        channelLeaseRef.current = undefined;
      }
      choiceResolver.current?.(null);
      choiceResolver.current = null;
      mountedRef.current = false;
      currentLiteratureIdRef.current = undefined;
      currentChannelRef.current = undefined;
      ownerMountEpochRef.current =
        nextLiteratureLifecycleEpoch();
      channelLifecycleEpochRef.current =
        nextLiteratureLifecycleEpoch();
      replacementGenerationRef.current += 1;
      recoverySweepGenerationRef.current += 1;
      next.dispose();
    };
  }, [
    input.literatureId,
    channel,
    handleProtectionRegistry
  ]);

  useEffect(() => {
    const literatureId = input.literatureId;
    if (
      !literatureId ||
      !mountedRef.current ||
      currentLiteratureIdRef.current !== literatureId ||
      currentChannelRef.current !== channel
    ) {
      return undefined;
    }
    const ownerMountEpoch =
      ownerMountEpochRef.current;
    const channelLifecycleEpoch =
      channelLifecycleEpochRef.current;
    recoverySweepGenerationRef.current += 1;
    const recoverySweepGeneration =
      recoverySweepGenerationRef.current;
    replacementGenerationRef.current += 1;
    const replacementGeneration =
      replacementGenerationRef.current;
    void saveAsService.listUnresolved(literatureId, channel)
      .then(async (operations) => {
        let successfulRecoveryCount = 0;
        const orderedOperations = [...operations].sort(
          compareRecoveryOperations
        );
        for (const operation of orderedOperations) {
          if (
            !isCurrentLifecycle({
              literatureId,
              channel,
              ownerMountEpoch,
              channelLifecycleEpoch,
              replacementGeneration,
              recoverySweepGeneration
            })
          ) {
            return;
          }
          if (
            !isDurableExpectedFileRefId(
              operation.targetFileRefId
            )
          ) {
            input.onFeedback(
              "warning",
              input.ui(
                "另存为恢复未完成：目标文稿身份无效。"
              ),
              "literature.manuscript.saveAsRecovery"
            );
            continue;
          }
          const channelLease = channelLeaseRef.current;
          const candidateCustody =
            channelLease
              ? handleProtectionRegistry.beginCandidate(
                  channelLease,
                  "recovery",
                  replacementGeneration
                )
              : undefined;
          if (!candidateCustody) return;
          const recovered = await saveAsService.recover(
            operation.operationId,
            literatureId,
            channel,
            candidateCustody
          );
          if (recovered.status === "success") {
            if (!recovered.candidateCustody) {
              handleProtectionRegistry.completeCandidate(
                candidateCustody,
                "protocol_violation"
              );
              input.onFeedback(
                "warning",
                input.ui(
                  "另存为恢复未完成：候选文稿移交无效。"
                ),
                "literature.manuscript.saveAsRecovery"
              );
              return;
            }
            const replacement =
              await replaceActiveIndependentHandle({
                kind: "install",
                nextHandle:
                  recovered.independentSessionKey,
                expectedLiteratureId: literatureId,
                expectedChannel: channel,
                expectedOwnerMountEpoch:
                  ownerMountEpoch,
                expectedChannelLifecycleEpoch:
                  channelLifecycleEpoch,
                expectedReplacementGeneration:
                  replacementGeneration,
                expectedRecoverySweepGeneration:
                  recoverySweepGeneration,
                expectedFileRefId:
                  operation.targetFileRefId,
                custody: {
                  request: candidateCustody,
                  receipt:
                    recovered.candidateCustody
                },
                operation: `recovery:${operation.operationId}`
              });
            if (
              replacement.status ===
                "stale-cleaned" ||
              replacement.status ===
                "cleanup-blocked" ||
              replacement.status ===
                "protected-alias-released" ||
              replacement.status ===
                "protocol-violation" ||
              replacement.status ===
                "stale-lease"
            ) {
              return;
            }
            successfulRecoveryCount += 1;
            continue;
          }
          handleProtectionRegistry.completeCandidate(
            candidateCustody,
            "already_absent"
          );
          if (recovered.status === "contained") {
            if (
              !isCurrentLifecycle({
                literatureId,
                channel,
                ownerMountEpoch,
                channelLifecycleEpoch,
                replacementGeneration,
                recoverySweepGeneration
              })
            ) {
              return;
            }
            input.onFeedback(
              "warning",
              input.ui(
                windowPContainmentFeedbackMessage(recovered.blockingCode)
              ),
              "literature.manuscript.saveAsRecovery"
            );
            continue;
          }
          if (
            !isCurrentLifecycle({
              literatureId,
              channel,
              ownerMountEpoch,
              channelLifecycleEpoch,
              replacementGeneration,
              recoverySweepGeneration
            })
          ) {
            return;
          }
          input.onFeedback(
            "warning",
            input.ui(`另存为恢复未完成：${recovered.error.code}`),
            "literature.manuscript.saveAsRecovery"
          );
        }
        if (
          successfulRecoveryCount > 0 &&
          isCurrentLifecycle({
            literatureId,
            channel,
            ownerMountEpoch,
            channelLifecycleEpoch,
            replacementGeneration,
            recoverySweepGeneration
          })
        ) {
          input.onFeedback(
            "success",
            input.ui(
              "未完成的另存为操作已恢复，副本已在对应通道的独立编辑器中打开。"
            ),
            "literature.manuscript.saveAsRecovery"
          );
        }
      })
      .catch((error) => {
        if (
          !isCurrentLifecycle({
            literatureId,
            channel,
            ownerMountEpoch,
            channelLifecycleEpoch,
            replacementGeneration,
            recoverySweepGeneration
          })
        ) {
          return;
        }
        input.onFeedback(
          "warning",
          error instanceof Error
            ? error.message
            : String(error),
          "literature.manuscript.saveAsRecovery"
        );
      });
    return () => {
      if (
        recoverySweepGenerationRef.current ===
        recoverySweepGeneration
      ) {
        recoverySweepGenerationRef.current += 1;
      }
      if (
        replacementGenerationRef.current ===
        replacementGeneration
      ) {
        replacementGenerationRef.current += 1;
      }
    };
  }, [input.literatureId, channel, saveAsService]);

  async function loadCurrent(openEditor: boolean) {
    const literatureId = input.literatureId;
    if (!literatureId) return false;
    if (currentSession) {
      if (openEditor) setOpen(true);
      return true;
    }
    setBusy(true);
    try {
      const result = await literatureRawManuscriptService.openCurrent(
        literatureId,
        channel
      );
      if (activeLiteratureId.current !== literatureId) return false;
      if (result.status !== "success" || !("sessionKey" in result)) {
        input.onFeedback(
          "error",
          resultMessage(result, input.ui("当前文稿加载失败。")),
          "literature.manuscript.load"
        );
        return false;
      }
      if (!currentDocumentView(result.session, channel)) {
        await literatureRawManuscriptService.close(
          result.sessionKey,
          channel,
          "current",
          "discard"
        );
        input.onFeedback(
          "error",
          input.ui("当前文稿标准区块无效，无法安全编辑。"),
          "literature.manuscript.load"
        );
        return false;
      }
      replaceCurrentHandle(result.sessionKey);
      refreshSessions();
      if (openEditor) setOpen(true);
      return true;
    } finally {
      if (activeLiteratureId.current === literatureId) setBusy(false);
    }
  }

  function updateCurrentRawMarkdown(markdown: string) {
    if (!currentHandle || !currentSession) return;
    const updated = literatureRawManuscriptService.updateDraft(
      currentHandle,
      channel,
      "current",
      markdown
    );
    if (updated.status === "success") refreshSessions();
  }

  async function saveCurrent(markdown?: string) {
    if (!currentHandle || !currentSession || !input.literatureId) {
      throw new Error(input.ui("文稿编辑器尚未就绪。"));
    }
    const rawMarkdown = markdown ?? currentSession.draftRawText;
    const updated = literatureRawManuscriptService.updateDraft(
      currentHandle,
      channel,
      "current",
      rawMarkdown
    );
    if (updated.status !== "success") {
      return ordinarySavePresentation(
        updated,
        { ownerType: "literature", channel, ownerLabel: input.ui("文献") }
      );
    }
    const result = await literatureRawManuscriptService.save(
      currentHandle,
      channel,
      "current"
    );
    if (result.status === "success" || result.status === "no-op") {
      refreshSessions();
    }
    return ordinarySavePresentation(
      result,
      { ownerType: "literature", channel, ownerLabel: input.ui("文献") }
    );
  }

  function saveAsFailureMessage(result: {
    error?: { code?: string };
  }) {
    const code = result.error?.code;
    if (
      code === "SAVE_AS_TARGET_ALREADY_EXISTS" ||
      code === "SAVE_AS_TARGET_CANDIDATE_INVALID" ||
      code === "SAVE_AS_SOURCE_TARGET_SAME_PATH" ||
      code === "SAVE_AS_SOURCE_TARGET_SAME_PHYSICAL"
    ) {
      return input.ui(
        "所选目标已存在或与源文稿身份冲突；未覆盖任何文件。"
      );
    }
    if (
      code === "SAVE_AS_SOURCE_SNAPSHOT_INVALID" ||
      code === "SAVE_AS_OPERATION_STALE"
    ) {
      return input.ui(
        "文献或源文稿状态已变化，当前另存为已安全阻断。"
      );
    }
    return input.ui(
      `另存为未完成：${code ?? "SAVE_AS_PHYSICAL_EFFECT_UNKNOWN"}`
    );
  }

  async function saveAs(
    sourceWindowRole: "current" | "independent",
    value: string | ManuscriptSegmentDraftSnapshot = ""
  ) {
    const literatureId = input.literatureId;
    const sourceHandle =
      sourceWindowRole === "current"
        ? currentHandleRef.current
        : activeIndependentHandleRef.current;
    if (!literatureId || !sourceHandle) return false;
    const sourceSession =
      literatureRawManuscriptService.getSession(
        sourceHandle,
        channel,
        sourceWindowRole
      );
    if (
      !sourceSession ||
      sourceSession.file.kind !== "durable" ||
      sourceSession.owner.ownerType !== "literature" ||
      sourceSession.owner.ownerId !== literatureId ||
      sourceSession.owner.channel !== channel ||
      sourceSession.windowRole !== sourceWindowRole
    ) {
      return false;
    }
    const canonicalSource =
      literatureRawManuscriptService.getSession(
        sourceHandle,
        channel,
        sourceWindowRole
      );
    if (
      !canonicalSource ||
      canonicalSource.file.kind !== "durable"
    ) {
      return false;
    }
    const ownerMountEpoch =
      ownerMountEpochRef.current;
    const channelLifecycleEpoch =
      channelLifecycleEpochRef.current;
    replacementGenerationRef.current += 1;
    const replacementGeneration =
      replacementGenerationRef.current;
    if (
      !isCurrentLifecycle({
        literatureId,
        channel,
        ownerMountEpoch,
        channelLifecycleEpoch,
        replacementGeneration
      })
    ) {
      return false;
    }
    setBusy(true);
    try {
      const channelLease = channelLeaseRef.current;
      const candidateCustody =
        channelLease
          ? handleProtectionRegistry.beginCandidate(
              channelLease,
              "save-as",
              replacementGeneration
            )
          : undefined;
      if (!candidateCustody) return false;
      const committed = await saveAsService.saveAs({
        literatureId,
        manuscriptChannel: channel,
        sourceSessionKey: sourceHandle,
        sourceWindowRole,
        frozenDraftSnapshot: typeof value === "string" ? undefined : value,
        candidateCustody,
        pickerTitle: input.ui("另存为")
      });
      if (committed.status === "success") {
        if (!committed.candidateCustody) {
          handleProtectionRegistry.completeCandidate(
            candidateCustody,
            "protocol_violation"
          );
          input.onFeedback(
            "error",
            input.ui(
              "另存为未完成：候选文稿移交无效。"
            ),
            "literature.manuscript.lifecycle.protocolViolation"
          );
          return false;
        }
        const replacement =
          await replaceActiveIndependentHandle({
            kind: "install",
            nextHandle:
              committed.independentSessionKey,
            expectedLiteratureId: literatureId,
            expectedChannel: channel,
            expectedOwnerMountEpoch:
              ownerMountEpoch,
            expectedChannelLifecycleEpoch:
              channelLifecycleEpoch,
            expectedReplacementGeneration:
              replacementGeneration,
            expectedFileRefId:
              committed.fileRefId,
            custody: {
              request: candidateCustody,
              receipt:
                committed.candidateCustody
            },
            operation: `save-as:${committed.operationId}`
          });
        if (
          replacement.status === "stale-cleaned" ||
          replacement.status ===
            "cleanup-blocked" ||
          replacement.status ===
            "protected-alias-released" ||
          replacement.status ===
            "protocol-violation" ||
          replacement.status ===
            "stale-lease"
        ) {
          return false;
        }
        input.onFeedback(
          "success",
          input.ui(
            `副本“${committed.targetFileName}”已创建并在对应通道的独立编辑器中打开；原文稿未改变。`
          ),
          "literature.manuscript.saveAs.success"
        );
        return true;
      }
      handleProtectionRegistry.completeCandidate(
        candidateCustody,
        "already_absent"
      );
      if (
        !isCurrentLifecycle({
          literatureId,
          channel,
          ownerMountEpoch,
          channelLifecycleEpoch,
          replacementGeneration
        })
      ) {
        return false;
      }
      if (committed.status === "canceled") {
        input.onFeedback(
          "info",
          input.ui(
            "已取消另存为，未产生持久化副作用。"
          ),
          "literature.manuscript.saveAs.canceled"
        );
        return false;
      }
      input.onFeedback(
        committed.status === "recovery-required" ||
          committed.status === "blocked"
          ? "warning"
          : "error",
        saveAsFailureMessage(committed),
        "literature.manuscript.saveAs.commit"
      );
      return false;
    } finally {
      if (
        isCurrentLifecycle({
          literatureId,
          channel,
          ownerMountEpoch,
          channelLifecycleEpoch,
          replacementGeneration
        })
      ) {
        setBusy(false);
      }
    }
  }

  async function discardLifecycleSession(kind: "current" | "target") {
    const handle = kind === "current" ? currentHandle : targetHandle;
    if (!handle) throw new Error("MANUSCRIPT_LIFECYCLE_SESSION_UNAVAILABLE");
    const result = await literatureRawManuscriptService.reload(
      handle,
      channel,
      kind === "current" ? "current" : "independent",
      "discard"
    );
    refreshSessions();
    if (result.status !== "success" && result.status !== "no-op") {
      throw new Error(resultMessage(result, input.ui("放弃文稿更改失败。")));
    }
  }

  async function closeEditor() {
    if (currentHandle) {
      const result = await literatureRawManuscriptService.close(
        currentHandle,
        channel,
        "current"
      );
      if (result.status !== "success") return;
      replaceCurrentHandle(undefined);
    }
    setOpen(false);
    refreshSessions();
  }

  async function selectTarget(
    candidate: LiteratureManuscriptFormalSwitchService,
    requestToken: number
  ): Promise<{
    fileRefId: string;
    locationMode: "managed" | "external";
  } | null> {
    const selected = await candidate.selectManuscript(
      requestToken,
      input.ui("切换 Markdown 文稿")
    );
    if (
      requestToken !== targetRequestSequence.current ||
      !active(candidate)
    ) {
      return null;
    }
    if (selected.status === "canceled") return null;
    if (selected.status === "error") {
      input.onFeedback(
        "error",
        projectFormalSwitchFailure(selected, input.ui).summary,
        `literature.manuscript.switch.${selected.code}`
      );
      return null;
    }
    if (selected.selection.locationMode === "external") {
      const confirmed = window.confirm(
        input.ui("该文稿位于工作目录之外。继续切换会创建内部托管副本，原文件不会被覆盖。是否继续？")
      );
      if (!confirmed) return null;
    }
    const ensured = await candidate.ensureSelectedManuscript(
      selected.selection
    );
    if (
      requestToken !== targetRequestSequence.current ||
      !active(candidate)
    ) {
      return null;
    }
    if (ensured.status === "error") {
      input.onFeedback(
        "error",
        projectFormalSwitchFailure(ensured, input.ui).summary,
        `literature.manuscript.switch.${ensured.code}`
      );
      return null;
    }
    await refreshAvailable(candidate);
    return {
      fileRefId: ensured.fileRefId,
      locationMode: ensured.locationMode
    };
  }

  async function openIndependentHandle(
    literatureId: string,
    fileRefId: string
  ) {
    const result = await literatureRawManuscriptService.openIndependent(
      literatureId,
      channel,
      fileRefId
    );
    if (result.status !== "success" || !("sessionKey" in result)) {
      return { result, view: null, handle: undefined };
    }
    const view = await buildLiteratureManuscriptView(
      literatureId,
      channel,
      result.session.draftRawText
    );
    if (view.status === "error") {
      await literatureRawManuscriptService.close(
        result.sessionKey,
        channel,
        "independent",
        "discard"
      );
      return { result: view, view: null, handle: undefined };
    }
    return {
      result,
      view: view.blocks,
      handle: result.sessionKey
    };
  }

  async function openTargetManuscript() {
    const candidate = workflow;
    const literatureId = input.literatureId;
    if (!candidate || !literatureId || !active(candidate)) return;
    const ownerMountEpoch =
      ownerMountEpochRef.current;
    const channelLifecycleEpoch =
      channelLifecycleEpochRef.current;
    replacementGenerationRef.current += 1;
    const replacementGeneration =
      replacementGenerationRef.current;
    const channelLease = channelLeaseRef.current;
    const candidateCustody =
      channelLease
        ? handleProtectionRegistry.beginCandidate(
            channelLease,
            "independent-open",
            replacementGeneration
          )
        : undefined;
    if (!candidateCustody) return;
    targetRequestSequence.current += 1;
    choiceResolver.current?.(null);
    choiceResolver.current = null;
    setBusy(true);
    try {
      const preview = input.independentOpenPreviewProvider ??
        createIndependentOpenPreviewProvider({
        pickerTitle: input.ui("打开 Markdown 文稿"),
        async resolveWorkspace() {
          const workspace = await resolveLiteratureWorkspaceFolder(
            literatureId
          );
          const normalizedWorkspace = workspace.path
            .replace(/\//gu, "\\")
            .toLocaleLowerCase();
          return {
            initialDirectory: workspace.path,
            configuredRoot: workspace.managedRoot,
            classify: (path) =>
              path
                .replace(/\//gu, "\\")
                .toLocaleLowerCase()
                .startsWith(`${normalizedWorkspace}\\`)
                ? "managed"
                : "external"
          };
        },
        async validateRaw({ rawText }) {
          const view = await buildLiteratureManuscriptView(
            literatureId,
            channel,
            rawText
          );
          return view.status === "error"
            ? {
                status: "error" as const,
                errorCode: view.error.code
              }
            : {
                status: "success" as const,
                summary: channel
              };
        }
      });
      const normalize = (result: {
        status: string;
        sessionKey?: string;
        session?: SharedManuscriptSession;
        fileName?: string;
        fileRefId?: string;
        error?: { code?: string };
      }): IndependentOpenActivationResult =>
        result.status === "success" &&
        result.sessionKey &&
        result.session &&
        result.fileName &&
        result.fileRefId
          ? {
              status: "success",
              handle: result.sessionKey,
              session: result.session,
              fileName: result.fileName,
              fileRefId: result.fileRefId
            }
          : {
              status: result.status === "conflict" ? "conflict" : "error",
              errorCode: result.error?.code
            };
      const consumerId =
        `literature:${literatureId}:${channel}:${handleProtectionRegistry.consumerScopeId}:independent-editor`;
      const adapter: IndependentOpenProductAdapter = {
        owner: {
          ownerType: "literature",
          ownerId: literatureId,
          channel
        },
        presentationScope: consumerId,
        consumerId,
        selectAndPreview: preview.selectAndPreview,
        revalidatePreview: preview.revalidatePreview,
        listIndependentConsumers: () => {
          const handle =
            activeIndependentHandleRef.current;
          const session = handle
            ? literatureRawManuscriptService.getSession(
                handle,
                channel,
                "independent"
              )
            : undefined;
          return handle && session
            ? [{ handle, consumerId, session }]
            : [];
        },
        getCurrentConsumer: () =>
          currentHandle && currentSession
            ? {
                handle: currentHandle,
                consumerId:
                  `literature:${literatureId}:${channel}:current-editor`,
                session: currentSession
              }
            : undefined,
        async activateCurrent(id) {
          return normalize(
            await literatureRawManuscriptService.openCurrent(
              literatureId,
              channel,
              id
            )
          );
        },
        async activateIndependent(fileRefId, id) {
          return normalize(
            await literatureRawManuscriptService.openIndependent(
              literatureId,
              channel,
              fileRefId,
              id
            )
          );
        },
        async closeConsumer(handle, decision) {
          const before =
            literatureRawManuscriptService.getSession(
              handle,
              channel,
              "current"
            ) ??
            literatureRawManuscriptService.getSession(
              handle,
              channel,
              "independent"
            );
          if (decision === "save") {
            let saved = await literatureRawManuscriptService.save(
              handle,
              channel,
              "independent"
            );
            if (
              saved.status !== "success" &&
              saved.status !== "no-op" &&
              resultMessage(saved, "").includes(
                "LITERATURE_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
              )
            ) {
              if (
                !window.confirm(
                  input.ui("先保存旧外部文稿，再打开新目标吗？")
                )
              ) {
                return {
                  status: "error",
                  consumerCleanupState: "unresolved",
                  sessionCleanupState: "unresolved",
                  admissionCleanupState: "unresolved",
                  errorCode: "EXTERNAL_WRITE_DECLINED"
                } as const;
              }
              saved = await literatureRawManuscriptService.save(
                handle,
                channel,
                "independent",
                { confirmedExternalWrite: true }
              );
            }
            if (saved.status !== "success" && saved.status !== "no-op") {
              return {
                status: "error",
                consumerCleanupState: "unresolved",
                sessionCleanupState: "unresolved",
                admissionCleanupState: "unresolved",
                errorCode: resultMessage(saved, "LITERATURE_SAVE_FAILED")
                } as const;
            }
          }
          if (before?.windowRole === "current") {
            const closed =
              await literatureRawManuscriptService.close(
                handle,
                channel,
                "current",
                "discard"
              );
            return resolveIndependentOpenConsumerCleanup({
              closeStatus: closed.status,
              runtimeCleanup:
                "cleanup" in closed
                  ? closed.cleanup
                  : undefined,
              errorCode: resultMessage(
                closed,
                "LITERATURE_CLOSE_FAILED"
              )
            });
          }
          const replacement =
            await replaceActiveIndependentHandle({
              kind: "clear",
              expectedLiteratureId: literatureId,
              expectedChannel: channel,
              expectedOwnerMountEpoch:
                ownerMountEpoch,
              expectedChannelLifecycleEpoch:
                channelLifecycleEpoch,
              expectedReplacementGeneration:
                replacementGeneration,
              operation:
                "independent-open:replace-current"
            });
          const closed =
            "cleanup" in replacement &&
            replacement.cleanup
              ? replacement.cleanup.result
                  ?.runtimeResult
              : undefined;
          return resolveIndependentOpenConsumerCleanup({
            closeStatus:
              replacement.status ===
              "cleanup-blocked"
                ? closed?.status ?? "error"
                : "success",
            runtimeCleanup:
              closed && "cleanup" in closed
                ? closed.cleanup
                : {
                    consumerCleanupState: "released",
                    sessionCleanupState: "released",
                    admissionCleanupState: "released"
                  },
            errorCode: resultMessage(closed, "LITERATURE_CLOSE_FAILED")
          });
        },
        async presentCurrent(activation, permit) {
          if (
            activation.status !== "success" ||
            !permit.isCurrent() ||
            !isCurrentLifecycle({
              literatureId,
              channel,
              ownerMountEpoch,
              channelLifecycleEpoch,
              replacementGeneration
            })
          ) {
            return false;
          }
          replaceCurrentHandle(activation.handle);
          setOpen(true);
          refreshSessions();
          return true;
        },
        async presentIndependent(activation, permit) {
          if (activation.status !== "success" || !permit.isCurrent()) return false;
          const view = await buildLiteratureManuscriptView(
            literatureId,
            channel,
            activation.session.draftRawText
          );
          if (view.status === "error" || !permit.isCurrent()) return false;
          const replacement =
            await replaceActiveIndependentHandle({
              kind: "install",
              nextHandle: activation.handle,
              expectedLiteratureId: literatureId,
              expectedChannel: channel,
              expectedOwnerMountEpoch:
                ownerMountEpoch,
              expectedChannelLifecycleEpoch:
                channelLifecycleEpoch,
              expectedReplacementGeneration:
                replacementGeneration,
              expectedFileRefId:
                activation.fileRefId,
              custody: {
                request: candidateCustody,
                receipt: {
                  request: candidateCustody,
                  handle: activation.handle,
                  literatureId,
                  channel,
                  producer: "independent-open",
                  operationId:
                    `independent-open:${consumerId}`,
                  consumerId,
                  fileRefId:
                    activation.fileRefId
                }
              },
              operation: "independent-open:present"
            });
          if (
            replacement.status === "installed" ||
            replacement.status === "retained"
          ) {
            setTargetMissingFallback(view.blocks);
            refreshSessions();
            return true;
          }
          return false;
        },
        async focusCurrent(consumer, permit) {
          if (
            !permit.isCurrent() ||
            !isCurrentLifecycle({
              literatureId,
              channel,
              ownerMountEpoch,
              channelLifecycleEpoch,
              replacementGeneration
            })
          ) {
            return false;
          }
          replaceCurrentHandle(consumer.handle);
          setOpen(true);
          refreshSessions();
          return true;
        },
        async focusIndependent(consumer, permit) {
          const channelLease = channelLeaseRef.current;
          const activeHandle =
            activeIndependentHandleRef.current;
          const canRetain =
            permit.isCurrent() &&
            activeHandle === consumer.handle &&
            consumer.session.owner.ownerType ===
              "literature" &&
            consumer.session.owner.ownerId ===
              literatureId &&
            consumer.session.owner.channel === channel &&
            consumer.session.windowRole ===
              "independent" &&
            Boolean(
              channelLease &&
                handleProtectionRegistry.isCurrentLease(
                  channelLease
                ) &&
                handleProtectionRegistry.isProtected(
                  consumer.handle
                )
            ) &&
            isCurrentLifecycle({
              literatureId,
              channel,
              ownerMountEpoch,
              channelLifecycleEpoch,
              replacementGeneration
            });
          handleProtectionRegistry.completeCandidate(
            candidateCustody,
            canRetain
              ? "released_as_protected_alias"
              : "protocol_violation"
          );
          if (canRetain) {
            refreshSessions();
          }
          return canRetain;
        },
        async decideDirty(consumer) {
          return new Promise<"save" | "discard" | "cancel">((resolve) => {
            void sharedEditorLifecycleController.requestParticipant({
              participantId: `literature-independent:${consumer.handle}`,
              trigger: "open-independent",
              continuationIntent: "OPEN_INDEPENDENT",
              surface: "application",
              continuation: (decision) => resolve(decision ?? "discard")
            }).then((requested) => {
              if (
                requested.status === "unavailable" ||
                requested.status === "failed" ||
                requested.status === "stale" ||
                requested.status === "busy"
              ) {
                resolve("cancel");
              }
            });
          });
        },
        async confirmRegistration(selected) {
          return window.confirm(
            input.ui(
              `是否登记并打开“${selected.fileName}”？只创建 FileRef 元数据，不改变当前稿或文件内容。`
            )
          )
            ? "confirm"
            : "cancel";
        },
        async confirmActivationRetry({ fileName }) {
          return window.confirm(
            input.ui(`“${fileName}”已登记但打开失败。是否重试？`)
          );
        }
      };
      const outcome = await openProtocol.execute(adapter);
      if (
        handleProtectionRegistry.getCandidateTerminal(
          candidateCustody
        ) === undefined
      ) {
        handleProtectionRegistry.completeCandidate(
          candidateCustody,
          "already_absent"
        );
      }
      const success = [
        "current-session-reused",
        "current-session-activated",
        "independent-session-reused",
        "activation-succeeded"
      ].includes(outcome.status);
      const canceled =
        outcome.status === "registration-declined" ||
        outcome.status === "picker-cancelled";
      input.onFeedback(
        success ? "success" : canceled ? "info" : "error",
        success
          ? input.ui("文献独立文稿已打开。")
          : canceled
            ? input.ui("已取消打开，未产生持久化副作用。")
            : input.ui(
                `独立文稿打开未完成：${outcome.errorCode ?? outcome.status}`
              ),
        `literature.manuscript.independentOpen.${outcome.status}`
      );
      await refreshAvailable(candidate);
    } finally {
      if (
        isCurrentLifecycle({
          literatureId,
          channel,
          ownerMountEpoch,
          channelLifecycleEpoch,
          replacementGeneration
        })
      ) {
        setBusy(false);
      }
    }
  }

  function updateTargetSections(
    sections: Partial<
      Pick<LiteratureManuscriptBlocks, "metaSnapshot" | "outline" | "body">
    >
  ) {
    if (!targetHandle || !targetSession || !targetDocument) return;
    const replaced = literatureManuscriptAdapterService.replaceSections({
      existingMarkdown: targetSession.draftRawText,
      channel,
      metaSnapshot:
        sections.metaSnapshot ?? targetDocument.metaSnapshot,
      outline: sections.outline ?? targetDocument.outline,
      body: sections.body ?? targetDocument.body
    });
    if (replaced.status !== "success" || !replaced.markdown) {
      input.onFeedback(
        "error",
        replaced.status === "error"
          ? replaced.error.message
          : input.ui("独立文稿更新失败。"),
        "literature.manuscript.targetUpdate"
      );
      return;
    }
    const updated = literatureRawManuscriptService.updateDraft(
      targetHandle,
      channel,
      "independent",
      replaced.markdown
    );
    if (updated.status === "success") {
      setTargetMissingFallback(undefined);
      refreshSessions();
    }
  }

  function updateTargetRawMarkdown(markdown: string) {
    if (!targetHandle || !targetSession) return false;
    const updated = literatureRawManuscriptService.updateDraft(
      targetHandle,
      channel,
      "independent",
      markdown
    );
    if (updated.status !== "success") return false;
    setTargetMissingFallback(undefined);
    refreshSessions();
    return true;
  }

  async function saveTargetManuscript(markdown?: string) {
    if (!targetHandle || !targetSession || !targetDocument) {
      throw new Error(input.ui("独立编辑器尚未就绪。"));
    }
    if (markdown !== undefined && !updateTargetRawMarkdown(markdown)) {
      throw new Error(input.ui("独立文稿更新失败。"));
    }
    let result = await literatureRawManuscriptService.save(
      targetHandle,
      channel,
      "independent"
    );
    if (
      result.status !== "success" &&
      result.status !== "no-op" &&
      resultMessage(result, "").includes(
        "LITERATURE_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
      )
    ) {
      if (
        !window.confirm(
          input.ui("确认将修改保存回原外部文件吗？原文件内容会被更新。")
        )
      ) {
        throw new Error(input.ui("已取消保存外部文稿。"));
      }
      result = await literatureRawManuscriptService.save(
        targetHandle,
        channel,
        "independent",
        { confirmedExternalWrite: true }
      );
    }
    if (result.status !== "success" && result.status !== "no-op") {
      throw new Error(
        resultMessage(result, input.ui("独立文稿保存失败。"))
      );
    }
    refreshSessions();
    input.onFeedback(
      "success",
      input.ui("独立编辑文稿已保存；当前文稿与 Literature 正式字段未改变。"),
      "literature.manuscript.targetSave"
    );
    const savedRaw = literatureRawManuscriptService.getSession(
      targetHandle,
      channel,
      "independent"
    )?.draftRawText;
    return savedRaw ?? targetSession.draftRawText;
  }

  async function reloadTarget(markdown: string, lifecycleSettled = false) {
    if (!targetHandle) return false;
    if (!lifecycleSettled) {
      if (!updateTargetRawMarkdown(markdown)) return false;
      const requested = await sharedEditorLifecycleController.requestParticipant({
        participantId: `literature-independent:${targetHandle}`,
        trigger: "reload",
        continuationIntent: "RELOAD",
        surface: "application",
        continuation: async () => {
          await reloadTarget(markdown, true);
        }
      });
      return requested.status === "continued";
    }
    const result = await literatureRawManuscriptService.reload(
      targetHandle,
      channel,
      "independent"
    );
    if (result.status !== "success" && result.status !== "no-op") {
      input.onFeedback(
        "error",
        resultMessage(result, input.ui("独立文稿重新加载失败。")),
        "literature.manuscript.targetReload"
      );
      return false;
    }
    setTargetPresentationRevision((current) => current + 1);
    refreshSessions();
    input.onFeedback(
      "success",
      input.ui("独立文稿已重新加载。"),
      "literature.manuscript.targetReload"
    );
    return true;
  }

  async function closeTargetEditor() {
    targetRequestSequence.current += 1;
    const literatureId =
      currentLiteratureIdRef.current;
    if (literatureId && mountedRef.current) {
      replacementGenerationRef.current += 1;
      await replaceActiveIndependentHandle({
        kind: "clear",
        expectedLiteratureId: literatureId,
        expectedChannel: channel,
        expectedOwnerMountEpoch:
          ownerMountEpochRef.current,
        expectedChannelLifecycleEpoch:
          channelLifecycleEpochRef.current,
        expectedReplacementGeneration:
          replacementGenerationRef.current,
        operation: "independent-editor:close"
      });
    }
  }

  async function switchCurrent(lifecycleSettled = false) {
    const candidate = workflow;
    const literatureId = input.literatureId;
    if (!candidate || !literatureId || !active(candidate)) return;
    if (!currentSession && !(await loadCurrent(false))) return;
    if (!lifecycleSettled) {
      await sharedEditorLifecycleController.requestParticipant({
        participantId: `literature-current:${currentHandle ?? "closed"}`,
        trigger: "switch-manuscript",
        continuationIntent: "SWITCH_MANUSCRIPT",
        surface: "application",
        continuation: () => switchCurrent(true)
      });
      return;
    }
    const sessionAtStart = currentHandle
      ? literatureRawManuscriptService.getSession(
          currentHandle,
          channel,
          "current"
        )
      : undefined;
    if (!sessionAtStart) return;
    const requestToken = ++targetRequestSequence.current;
    setBusy(true);
    let switchTargetHandle: SharedManuscriptSessionHandle | undefined;
    try {
      const selected = await selectTarget(
        candidate,
        requestToken
      );
      if (!selected || requestToken !== targetRequestSequence.current) return;
      let opened = await openIndependentHandle(
        literatureId,
        selected.fileRefId
      );
      switchTargetHandle = opened.handle;
      if (!opened.handle || !opened.view) {
        input.onFeedback(
          "error",
          projectFormalSwitchFailure(opened.result, input.ui).summary,
          "literature.manuscript.switch.read"
        );
        return;
      }
      let switchTargetSession =
        literatureRawManuscriptService.getSession(
          opened.handle,
          channel,
          "independent"
        );
      if (!switchTargetSession) return;
      let target = targetDocumentView(
        switchTargetSession,
        channel,
        opened.view
      );
      if (!target) return;
      const descriptorLookupIdentity = {
        ownerType: "literature" as const,
        channel
      };
      const presentationCandidate = buildCanonicalFormalSwitchArchiveCandidate({
        rawMarkdown: switchTargetSession.draftRawText,
        descriptorLookupIdentity
      });
      const switchCopy = buildFormalSwitchConfirmationCopy({
        targetFileName: target.displayName,
        ownerDisplayName: channel === "literature_outline"
          ? input.ui("文献纲要")
          : input.ui("课题专属笔记"),
        descriptorLookupIdentity,
        translate: input.ui,
        resolveLabel: (field) => input.ui(field.displayLabel),
        fieldActions: presentationCandidate.ok
          ? presentationCandidate.orderedReplacementDto.orderedReplacements.map(
              (replacement) => ({
                key: replacement.stableKey,
                action: replacement.action
              })
            )
          : []
      });
      const confirmed = await requestChoice({
        title: input.ui("设为当前稿"),
        message: switchCopy.message,
        options: [
          {
            value: "confirm",
            label: input.ui("设为当前稿"),
            emphasis: "primary"
          },
          { value: "cancel", label: input.ui("取消") }
        ]
      });
      if (confirmed !== "confirm") {
        return;
      }
      let targetFileRefId = selected.fileRefId;
      if (selected.locationMode === "external") {
        const copyToken = manuscriptRequestTokenController.begin();
        const copied = await candidate.createManagedCopy(
          target,
          copyToken
        );
        if (
          (copied.status !== "success" &&
            copied.status !== "skipped") ||
          !copied.fileRefId
        ) {
          input.onFeedback(
            "error",
            projectFormalSwitchFailure(copied, input.ui).summary,
            "literature.manuscript.externalManagedCopy"
          );
          return;
        }
        if (switchTargetHandle) {
          await literatureRawManuscriptService.close(
            switchTargetHandle,
            channel,
            "independent",
            "discard"
          );
        }
        targetFileRefId = copied.fileRefId;
        opened = await openIndependentHandle(
          literatureId,
          targetFileRefId
        );
        switchTargetHandle = opened.handle;
        if (!opened.handle || !opened.view) return;
        switchTargetSession =
          literatureRawManuscriptService.getSession(
            opened.handle,
            channel,
            "independent"
          );
        if (!switchTargetSession) return;
        target = targetDocumentView(
          switchTargetSession,
          channel,
          opened.view
        );
        if (!target) return;
        await refreshAvailable(candidate);
      }
      const latestCurrent = currentHandle
        ? literatureRawManuscriptService.getSession(
            currentHandle,
            channel,
            "current"
          )
        : undefined;
      if (!latestCurrent || !currentHandle || !switchTargetHandle) return;
      const result = await candidate.setCurrent({
        currentSession: latestCurrent,
        currentSessionHandle: currentHandle,
        targetSessionHandle: switchTargetHandle,
        targetFileRefId
      });
      if (!result) return;
      if (result.status === "error") {
        input.onFeedback(
          "error",
          projectFormalSwitchFailure(result, input.ui, { reload: true }).summary,
          "literature.manuscript.switch"
        );
        return;
      }
      if (result.status === "success") {
        const activeIndependentHandle =
          activeIndependentHandleRef.current;
        const activeIndependentSession =
          activeIndependentHandle
            ? literatureRawManuscriptService.getSession(
                activeIndependentHandle,
                channel,
                "independent"
              )
            : undefined;
        if (
          activeIndependentSession?.file.kind ===
            "durable" &&
          activeIndependentSession.file.fileRefId ===
            targetFileRefId
        ) {
          replacementGenerationRef.current += 1;
          await replaceActiveIndependentHandle({
            kind: "clear",
            expectedLiteratureId: literatureId,
            expectedChannel: channel,
            expectedOwnerMountEpoch:
              ownerMountEpochRef.current,
            expectedChannelLifecycleEpoch:
              channelLifecycleEpochRef.current,
            expectedReplacementGeneration:
              replacementGenerationRef.current,
            operation:
              "formal-switch:target-became-current"
          });
        }
      }
      if (result.status === "success") {
        replaceCurrentHandle(result.sessionKey);
      }
      try {
        await refreshAvailable(candidate);
        await input.onReloadDetail(literatureId);
        refreshSessions();
      } catch {
        input.onFeedback("error", projectFormalSwitchFailure(
          result.status === "success"
            ? { error: { sideEffectSummary: { databaseCommitted: true } } }
            : result,
          input.ui
        ).summary, "literature.manuscript.switch");
        return;
      }
      input.onFeedback(
        result.status === "skipped" ? "info" : "success",
        result.status === "skipped"
          ? input.ui("所选文稿已是当前文稿。")
          : input.ui("当前文稿已切换。"),
        "literature.manuscript.switch"
      );
    } finally {
      if (switchTargetHandle) {
        await literatureRawManuscriptService.close(
          switchTargetHandle,
          channel,
          "independent",
          "discard"
        );
      }
      if (active(candidate)) setBusy(false);
    }
  }

  async function reloadCurrent(lifecycleSettled = false) {
    const literatureId = input.literatureId;
    if (!literatureId) return;
    if (!currentHandle || !currentSession) {
      if (await loadCurrent(false)) {
        await input.onReloadDetail(literatureId);
      }
      return;
    }
    if (!lifecycleSettled) {
      await sharedEditorLifecycleController.requestParticipant({
        participantId: `literature-current:${currentHandle}`,
        trigger: "reload",
        continuationIntent: "RELOAD",
        surface: "application",
        continuation: () => reloadCurrent(true)
      });
      return;
    }
    const result = await literatureRawManuscriptService.reload(
      currentHandle,
      channel,
      "current"
    );
    if (result.status === "success" || result.status === "no-op") {
      refreshSessions();
      await input.onReloadDetail(literatureId);
      input.onFeedback(
        "success",
        input.ui("当前文稿已重新加载。"),
        "literature.manuscript.reload"
      );
    } else if (result.status !== "canceled") {
      input.onFeedback(
        "error",
        resultMessage(result, input.ui("当前文稿重新加载失败。")),
        "literature.manuscript.reload"
      );
    }
  }

  async function retryProvisioning() {
    const literatureId = input.literatureId;
    if (!literatureId || activeLiteratureId.current !== literatureId) return;
    setBusy(true);
    try {
      const result =
        await literatureManuscriptService.ensureProvisioned(literatureId);
      if (activeLiteratureId.current !== literatureId) return;
      await input.onReloadDetail(literatureId);
      input.onFeedback(
        result.status === "success" || result.status === "skipped"
          ? "success"
          : "warning",
        result.status === "success" || result.status === "skipped"
          ? input.ui("文稿初始化已完成。")
          : result.errors.map((item) => item.message).join("；") ||
              input.ui("文稿初始化仍未完成。"),
        "literature.manuscript.provisionRetry"
      );
    } catch (error) {
      input.onFeedback(
        "error",
        error instanceof Error ? error.message : String(error),
        "literature.manuscript.provisionRetry"
      );
    } finally {
      if (activeLiteratureId.current === literatureId) setBusy(false);
    }
  }

  return {
    ready: Boolean(workflow),
    document,
    currentHandle,
    currentSession,
    currentDirty: currentSession?.dirty ?? false,
    currentPresentationRevision: currentSession?.requestGeneration ?? 0,
    available,
    busy,
    open,
    targetDocument,
    targetHandle,
    targetSession,
    targetDirty: targetSession?.dirty ?? false,
    targetRawMarkdown: targetDocument?.rawMarkdown ?? "",
    targetPresentationRevision,
    targetIntro: targetDocument?.metaSnapshot ?? "",
    setTargetIntro(value: string) {
      updateTargetSections({ metaSnapshot: value });
    },
    targetOutline: targetDocument?.outline ?? "",
    setTargetOutline(value: string) {
      updateTargetSections({ outline: value });
    },
    targetBody: targetDocument?.body ?? "",
    openCurrent: () => loadCurrent(true),
    closeEditor,
    saveCurrent,
    saveCurrentAs(value: string | ManuscriptSegmentDraftSnapshot = "") {
      return saveAs("current", value);
    },
    saveCurrentAsCurrentSession(snapshot?: ManuscriptSegmentDraftSnapshot) {
      return saveAs("current", snapshot ?? "");
    },
    updateDraft: updateCurrentRawMarkdown,
    readCurrentSession: () => currentHandle
      ? literatureRawManuscriptService.getSession(currentHandle, channel, "current")
      : undefined,
    discardCurrent: () => discardLifecycleSession("current"),
    openTargetManuscript,
    saveTargetManuscript,
    reloadTarget,
    saveTargetAs(value: string | ManuscriptSegmentDraftSnapshot = "") {
      return saveAs("independent", value);
    },
    saveTargetAsCurrentSession(snapshot?: ManuscriptSegmentDraftSnapshot) {
      return saveAs("independent", snapshot ?? "");
    },
    updateTargetRawMarkdown,
    updateTargetBody(markdown: string) {
      updateTargetSections({ body: markdown });
    },
    readTargetSession: () => targetHandle
      ? literatureRawManuscriptService.getSession(targetHandle, channel, "independent")
      : undefined,
    discardTarget: () => discardLifecycleSession("target"),
    closeTargetEditor,
    switchCurrent,
    reloadCurrent,
    retryProvisioning,
    choiceDialog,
    resolveChoice
  };
}
