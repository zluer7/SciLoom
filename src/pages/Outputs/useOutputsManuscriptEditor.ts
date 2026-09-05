import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OutputManuscriptDocument,
  OutputManuscriptOwnerType,
  OutputManuscriptStructuredSnapshot
} from "../../types";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../../types/sharedManuscriptSession";
import type { ManuscriptSegmentDraftSnapshot } from "../../types/manuscriptSegmentProjection";
import { createPathIdentityKey } from "../../services/fileRefIdentity";
import { fileRefService } from "../../services/fileRefService";
import { summarizePath } from "../../services/localPathService";
import { localMarkdownFileService } from "../../services/localMarkdownFileService";
import { getManagedPathParent } from "../../services/managedPathService";
import { manuscriptBindingService } from "../../services/manuscriptBindingService";
import { projectFormalSwitchFailure } from "../../services/manuscriptFormalSwitchPresentation";
import {
  createOutputManuscriptFormalSwitchService,
  type OutputManuscriptFormalSwitchService
} from "../../services/outputManuscriptFormalSwitchService";
import {
  getOutputManuscriptStaticDescriptor
} from "../../services/outputManuscriptDescriptorService";
import {
  outputManuscriptSaveAsAdapter,
  type OutputCanonicalRecoveryResult,
  type OutputCanonicalSaveAsResult,
  type OutputManuscriptSaveAsAdapter,
  type OutputManuscriptSaveAsInvocationContext
} from "../../services/outputManuscriptSaveAsAdapter";
import {
  createManuscriptSaveAsLifecycleRegistry,
  type ManuscriptCandidateCustodyRequest,
  type ManuscriptOwnerMountLease,
  type ManuscriptSaveAsLifecycleRegistry
} from "../../services/manuscriptSaveAsLifecycleRegistry";
import {
  manuscriptSaveAsFinalizationCoordinator,
  type ManuscriptSaveAsFinalizationCoordinator
} from "../../services/manuscriptSaveAsFinalizationCoordinator";
import {
  outputManuscriptStructuredSnapshotService
} from "../../services/outputManuscriptStructuredSnapshotService";
import { ensureOutputManuscript } from "../../services/outputManuscriptProvisioningService";
import {
  replaceOutputManuscriptStandardBlocks
} from "../../services/outputManuscriptBlockAdapterService";
import { outputFiveLayerSelectorService } from "../../services/outputFiveLayerSelectorService";
import { outputRawManuscriptService } from "../../services/outputRawManuscriptService";
import { parseLabPodMarkdownDocument } from "../../services/labPodMarkdownDocumentService";
import { managedRootConfigService } from "../../services/managedRootConfigService";
import {
  independentManuscriptOpenProtocol,
  type IndependentOpenActivationResult,
  type IndependentOpenProductAdapter,
  type IndependentManuscriptOpenProtocol,
  resolveIndependentOpenConsumerCleanup
} from "../../services/independentManuscriptOpenProtocol";
import { createIndependentOpenPreviewProvider } from "../../services/independentManuscriptOpenPreviewProvider";
import {
  sharedEditorLifecycleController,
  type SharedEditorLifecycleContinuationIntent,
  type SharedEditorLifecycleTrigger
} from "../../services/sharedEditorLifecycleController";
import { windowPContainmentFeedbackMessage } from "../../services/manuscriptSaveAsWindowPContainment";
import { ordinarySavePresentation } from "../../services/ordinaryOperationPresentation";

type Owner = {
  ownerType: OutputManuscriptOwnerType;
  ownerId: string;
};

type WorkspaceIdentity = {
  path: string;
  pathIdentityKey: string;
  pathSummary: string;
  bindingIdentity: {
    bindingId: string;
    currentFileRefId: string | null;
    defaultManuscriptFileRefId: string | null;
    defaultFolderFileRefId: string | null;
  };
};

type PresentationSession = {
  owner: Owner;
  title: string;
  currentIdentity: { fileRefId: string; filename: string };
  actualEditTarget: {
    kind: "current";
    fileRefId: string;
    filename: string;
  };
  document: OutputManuscriptDocument;
  openedBody: string;
  draftBody: string;
  draftRawMarkdown: string;
  dirty: boolean;
  workspaceSummary?: string;
  intro: { briefDescription: string; projectTitle: string };
  warnings: string[];
  accessMode: "writable" | "read-only";
};

type IndependentPresentation = {
  owner: Owner;
  document: OutputManuscriptDocument;
  openedMetaSnapshot: string;
  draftMetaSnapshot: string;
  openedOutline: string;
  draftOutline: string;
  openedBody: string;
  draftBody: string;
  rawMarkdown: string;
  dirty: boolean;
  accessMode: "writable" | "read-only";
};

type EditorState = {
  status:
    | "closed"
    | "opening"
    | "open-clean"
    | "open-dirty"
    | "saving"
    | "reloading"
    | "save-as"
    | "switching"
    | "closing"
    | "error";
  session?: PresentationSession;
  independentSession?: IndependentPresentation;
  error: string | null;
};

type CommandResult =
  | {
      status: "success" | "skipped";
      selection?: {
        fileRefId: string;
        fileName: string;
        locationMode: "managed" | "external";
        preview?: {
          currentFilename: string;
          targetFilename: string;
          importedFieldCount: number;
          missingFieldCount: number;
          missingFieldKeys: string[];
          warnings: string[];
        };
      };
    }
  | { status: "decision-required" }
  | { status: "error"; error: string };

type InstallableOutputSaveAsCandidate = Extract<
  OutputCanonicalSaveAsResult | OutputCanonicalRecoveryResult,
  { status: "presented" }
>;

function resultMessage(result: unknown, fallback: string) {
  if (result && typeof result === "object" && "error" in result) {
    const error = result.error;
    if (error && typeof error === "object" && "message" in error) {
      return String(error.message);
    }
  }
  return fallback;
}

function displayTitle(
  detail: Awaited<
    ReturnType<typeof outputFiveLayerSelectorService.getOutputEntityDetail>
  >,
  owner: Owner
) {
  const entity = detail.entity;
  if (
    entity &&
    "outputName" in entity &&
    typeof entity.outputName === "string"
  ) {
    return entity.outputName;
  }
  if (entity && "title" in entity && typeof entity.title === "string") {
    return entity.title;
  }
  return `${owner.ownerType} ${owner.ownerId}`;
}

function documentView(
  owner: Owner,
  handle: SharedManuscriptSessionHandle,
  role: "current" | "independent",
  snapshot: OutputManuscriptStructuredSnapshot
): OutputManuscriptDocument | undefined {
  const session = outputRawManuscriptService.getSession(
    handle,
    owner.ownerType,
    owner.ownerId,
    role
  );
  if (!session || session.file.kind !== "durable") return undefined;
  const parsed = parseLabPodMarkdownDocument(session.draftRawText);
  if (parsed.status === "invalid" || parsed.status === "ambiguous") {
    return undefined;
  }
  return {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    channel: "primary",
    fileRefId: session.file.fileRefId,
    filename: session.file.fileName,
    locationMode: session.file.locationMode,
    rawMarkdown: session.draftRawText,
    body: parsed.status === "missing"
      ? session.draftRawText
      : parsed.body ?? "",
    parsed,
    snapshot,
    warnings: [...snapshot.warnings],
    requestToken: session.requestGeneration
  };
}

async function resolveWorkspace(owner: Owner) {
  const identity = await manuscriptBindingService.resolveIdentity({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    manuscriptChannel: "primary"
  });
  const folderId = identity.slots.defaultFolderFileRefId.fileRefId;
  const folder =
    identity.identityResolved && folderId
      ? await fileRefService.getById(folderId)
      : undefined;
  return folder
    ? {
        path: folder.path,
        pathIdentityKey: folder.pathIdentityKey,
        pathSummary: summarizePath(folder.path),
        bindingIdentity: {
          bindingId: identity.binding?.id ?? "",
          currentFileRefId:
            identity.binding?.currentFileRefId ?? null,
          defaultManuscriptFileRefId:
            identity.binding?.defaultManuscriptFileRefId ?? null,
          defaultFolderFileRefId:
            identity.binding?.defaultFolderFileRefId ?? null
        }
      }
    : undefined;
}

export function useOutputsManuscriptEditor(input: {
  independentOpenProtocol?: IndependentManuscriptOpenProtocol;
  independentOpenPreviewProvider?: ReturnType<
    typeof createIndependentOpenPreviewProvider
  >;
  saveAsService?: OutputManuscriptSaveAsAdapter;
  saveAsLifecycleRegistry?: ManuscriptSaveAsLifecycleRegistry;
  saveAsFinalizationCoordinator?: ManuscriptSaveAsFinalizationCoordinator;
} = {}) {
  const openProtocol =
    input.independentOpenProtocol ?? independentManuscriptOpenProtocol;
  const saveAsService =
    input.saveAsService ?? outputManuscriptSaveAsAdapter;
  const saveAsFinalization =
    input.saveAsFinalizationCoordinator ??
    manuscriptSaveAsFinalizationCoordinator;
  const saveAsLifecycleRegistryRef =
    useRef<ManuscriptSaveAsLifecycleRegistry | null>(null);
  if (!saveAsLifecycleRegistryRef.current) {
    saveAsLifecycleRegistryRef.current =
      input.saveAsLifecycleRegistry ??
      createManuscriptSaveAsLifecycleRegistry();
  }
  const saveAsLifecycle =
    saveAsLifecycleRegistryRef.current;
  const [currentHandle, setCurrentHandle] =
    useState<SharedManuscriptSessionHandle>();
  const [independentHandle, setIndependentHandle] =
    useState<SharedManuscriptSessionHandle>();
  const [owner, setOwner] = useState<Owner>();
  const [currentSnapshot, setCurrentSnapshot] =
    useState<OutputManuscriptStructuredSnapshot>();
  const [independentSnapshot, setIndependentSnapshot] =
    useState<OutputManuscriptStructuredSnapshot>();
  const [title, setTitle] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceIdentity>();
  const [status, setStatus] = useState<EditorState["status"]>("closed");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [currentPresentationRevision, setCurrentPresentationRevision] =
    useState(0);
  const [independentPresentationRevision, setIndependentPresentationRevision] = useState(0);
  const requestGeneration = useRef(0);
  const currentHandleRef = useRef(currentHandle);
  const independentHandleRef = useRef(independentHandle);
  const ownerRef = useRef(owner);
  const workspaceRef = useRef(workspace);
  const ownerLeaseRef =
    useRef<ManuscriptOwnerMountLease>();
  const mountedRef = useRef(true);
  const recoverySweepGenerationRef = useRef(0);
  currentHandleRef.current = currentHandle;
  independentHandleRef.current = independentHandle;
  ownerRef.current = owner;
  workspaceRef.current = workspace;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGeneration.current += 1;
      recoverySweepGenerationRef.current += 1;
      const activeOwner = ownerRef.current;
      const current = currentHandleRef.current;
      const independent = independentHandleRef.current;
      const currentIsDirty = Boolean(
        activeOwner &&
          current &&
          outputRawManuscriptService.getSession(
            current,
            activeOwner.ownerType,
            activeOwner.ownerId,
            "current"
          )?.dirty
      );
      const independentIsDirty = Boolean(
        activeOwner &&
          independent &&
          outputRawManuscriptService.getSession(
            independent,
            activeOwner.ownerType,
            activeOwner.ownerId,
            "independent"
          )?.dirty
      );
      const lease = ownerLeaseRef.current;
      if (lease) {
        saveAsLifecycle.unmountOwner(lease);
        ownerLeaseRef.current = undefined;
      }
      if (activeOwner) {
        openProtocol.cancelOwner({
          ownerType: activeOwner.ownerType,
          ownerId: activeOwner.ownerId,
          channel: "primary"
        });
      }
      if (
        activeOwner &&
        current &&
        !currentIsDirty &&
        !saveAsLifecycle.isProtected(current)
      ) {
        void outputRawManuscriptService.close(
          current,
          activeOwner.ownerType,
          activeOwner.ownerId,
          "current",
          "discard"
        );
      }
      if (
        activeOwner &&
        independent &&
        !independentIsDirty &&
        !saveAsLifecycle.isProtected(independent)
      ) {
        void outputRawManuscriptService.close(
          independent,
          activeOwner.ownerType,
          activeOwner.ownerId,
          "independent",
          "discard"
        );
      }
    };
  }, []);

  useEffect(() => {
    if (!owner || !currentHandle) return;
    const generation =
      ++recoverySweepGenerationRef.current;
    void recoverSaveAsOperations(generation);
    return () => {
      if (
        recoverySweepGenerationRef.current === generation
      ) {
        recoverySweepGenerationRef.current += 1;
      }
    };
  }, [owner?.ownerType, owner?.ownerId, currentHandle]);

  const currentDocument = useMemo(
    () =>
      owner && currentHandle && currentSnapshot
        ? documentView(owner, currentHandle, "current", currentSnapshot)
        : undefined,
    [owner, currentHandle, currentSnapshot, revision]
  );
  const independentDocument = useMemo(
    () =>
      owner && independentHandle && independentSnapshot
        ? documentView(
            owner,
            independentHandle,
            "independent",
            independentSnapshot
          )
        : undefined,
    [owner, independentHandle, independentSnapshot, revision]
  );
  const currentRuntimeSession =
    owner && currentHandle
      ? outputRawManuscriptService.getSession(
          currentHandle,
          owner.ownerType,
          owner.ownerId,
          "current"
        )
      : undefined;
  const independentRuntimeSession =
    owner && independentHandle
      ? outputRawManuscriptService.getSession(
          independentHandle,
          owner.ownerType,
          owner.ownerId,
          "independent"
        )
      : undefined;

  const session: PresentationSession | undefined =
    owner && currentDocument && currentRuntimeSession
      ? {
          owner,
          title,
          currentIdentity: {
            fileRefId: currentDocument.fileRefId,
            filename: currentDocument.filename
          },
          actualEditTarget: {
            kind: "current",
            fileRefId: currentDocument.fileRefId,
            filename: currentDocument.filename
          },
          document: currentDocument,
          openedBody: currentRuntimeSession.baseline
            ? (
                parseLabPodMarkdownDocument(
                  currentRuntimeSession.baseline.rawText
                ).body ?? currentDocument.body
              )
            : currentDocument.body,
          draftBody: currentDocument.body,
          draftRawMarkdown: currentRuntimeSession.draftRawText,
          dirty: currentRuntimeSession.dirty,
          workspaceSummary: workspace?.pathSummary,
          intro: {
            briefDescription: currentSnapshot?.briefDescription ?? "",
            projectTitle: currentSnapshot?.projectTitle ?? ""
          },
          warnings: currentDocument.warnings,
          accessMode: currentRuntimeSession.accessMode
        }
      : undefined;
  const independentSession: IndependentPresentation | undefined =
    owner && independentDocument && independentRuntimeSession
      ? {
          owner,
          document: independentDocument,
          openedMetaSnapshot:
            independentRuntimeSession.baseline
              ? parseLabPodMarkdownDocument(
                  independentRuntimeSession.baseline.rawText
                ).metaSnapshot ?? ""
              : independentDocument.parsed.metaSnapshot ?? "",
          draftMetaSnapshot:
            independentDocument.parsed.metaSnapshot ?? "",
          openedOutline:
            independentRuntimeSession.baseline
              ? parseLabPodMarkdownDocument(
                  independentRuntimeSession.baseline.rawText
                ).outline ?? ""
              : independentDocument.parsed.outline ?? "",
          draftOutline: independentDocument.parsed.outline ?? "",
          openedBody:
            independentRuntimeSession.baseline
              ? parseLabPodMarkdownDocument(
                  independentRuntimeSession.baseline.rawText
                ).body ?? independentDocument.body
              : independentDocument.body,
          draftBody: independentDocument.body,
          rawMarkdown: independentRuntimeSession.draftRawText,
          dirty: independentRuntimeSession.dirty,
          accessMode: independentRuntimeSession.accessMode
        }
      : undefined;

  const state: EditorState = {
    status,
    session,
    independentSession,
    error
  };

  function refresh() {
    setRevision((value) => value + 1);
  }

  function nextRequest() {
    requestGeneration.current += 1;
    return requestGeneration.current;
  }

  function requestCurrent() {
    return requestGeneration.current;
  }

  function independentConsumersFor(
    targetOwner: Owner | undefined = ownerRef.current
  ) {
    if (!targetOwner) return [];
    return outputRawManuscriptService.listSessions().filter(
      ({ session }) =>
        session.owner.ownerType === targetOwner.ownerType &&
        session.owner.ownerId === targetOwner.ownerId &&
        session.owner.channel === "primary" &&
        session.windowRole === "independent"
    );
  }

  function ownedIndependentConsumersFor(
    targetOwner: Owner | undefined = ownerRef.current
  ) {
    const lease = ownerLeaseRef.current;
    if (
      !targetOwner ||
      !lease ||
      lease.ownerType !== targetOwner.ownerType ||
      lease.ownerId !== targetOwner.ownerId
    ) {
      return [];
    }
    const ownedHandles = new Set(
      saveAsLifecycle.listIndependentHandles(lease)
    );
    return independentConsumersFor(targetOwner).filter(
      ({ handle }) => ownedHandles.has(handle)
    );
  }

  function hasDirtySessionFor(
    targetOwner: Owner | undefined = ownerRef.current
  ) {
    if (!targetOwner) return false;
    const activeCurrent = currentHandleRef.current
      ? outputRawManuscriptService.getSession(
          currentHandleRef.current,
          targetOwner.ownerType,
          targetOwner.ownerId,
          "current"
        )
      : undefined;
    return Boolean(
      activeCurrent?.dirty ||
      ownedIndependentConsumersFor(targetOwner).some(
        ({ session: candidate }) => candidate.dirty
      )
    );
  }

  function syncStatus() {
    setStatus(
      hasDirtySessionFor()
        ? "open-dirty"
        : "open-clean"
    );
  }

  async function closeHandles(decision: "discard" | "cancel" = "discard") {
    const activeOwner = ownerRef.current;
    const current = currentHandleRef.current;
    const lease = ownerLeaseRef.current;
    const independentHandles = lease
      ? saveAsLifecycle.listIndependentHandles(lease)
      : [];
    if (lease) {
      saveAsLifecycle.unmountOwner(lease);
      ownerLeaseRef.current = undefined;
    }
    if (
      activeOwner &&
      current &&
      !saveAsLifecycle.isProtected(current)
    ) {
      await outputRawManuscriptService.close(
        current,
        activeOwner.ownerType,
        activeOwner.ownerId,
        "current",
        decision
      );
    }
    if (activeOwner) {
      for (const handle of independentHandles) {
        if (saveAsLifecycle.isProtected(handle)) continue;
        await outputRawManuscriptService.close(
          handle,
          activeOwner.ownerType,
          activeOwner.ownerId,
          "independent",
          decision
        );
      }
    }
    setCurrentHandle(undefined);
    setIndependentHandle(undefined);
    setCurrentSnapshot(undefined);
    setIndependentSnapshot(undefined);
  }

  async function performOpen(nextOwner: Owner): Promise<CommandResult> {
    const token = nextRequest();
    let openedCurrentHandle: SharedManuscriptSessionHandle | undefined;
    setStatus("opening");
    setError(null);
    try {
      const detail =
        await outputFiveLayerSelectorService.getOutputEntityDetail({
          layer: nextOwner.ownerType,
          id: nextOwner.ownerId,
          includeDeleted: false
        });
      if (token !== requestCurrent()) return { status: "skipped" };
      if (!detail.entity || detail.boundary.missing) {
        throw new Error("The selected Outputs owner is unavailable.");
      }
      getOutputManuscriptStaticDescriptor(nextOwner.ownerType);
      const provisioned = await ensureOutputManuscript(
        nextOwner.ownerType,
        nextOwner.ownerId,
        "primary"
      );
      if (token !== requestCurrent()) return { status: "skipped" };
      if (provisioned.completionState !== "complete") {
        throw new Error(
          provisioned.errors.map((item) => item.message).join(" ") ||
            "Outputs manuscript provisioning is incomplete."
        );
      }
      await closeHandles();
      const opened = await outputRawManuscriptService.openCurrent(
        nextOwner.ownerType,
        nextOwner.ownerId
      );
      if (token !== requestCurrent()) return { status: "skipped" };
      if (opened.status !== "success" || !("sessionKey" in opened)) {
        throw new Error(
          resultMessage(opened, "Current Outputs manuscript is unavailable.")
        );
      }
      openedCurrentHandle = opened.sessionKey;
      const [snapshot, nextWorkspace] = await Promise.all([
        outputManuscriptStructuredSnapshotService.get(
          nextOwner.ownerType,
          nextOwner.ownerId,
          opened.fileName
        ),
        resolveWorkspace(nextOwner)
      ]);
      if (token !== requestCurrent()) {
        await outputRawManuscriptService.close(
          opened.sessionKey,
          nextOwner.ownerType,
          nextOwner.ownerId,
          "current",
          "discard"
        );
        openedCurrentHandle = undefined;
        return { status: "skipped" };
      }
      setOwner(nextOwner);
      const ownerLease = saveAsLifecycle.mountOwner(
        nextOwner.ownerType,
        nextOwner.ownerId,
        "primary"
      );
      saveAsLifecycle.protectHandle(
        ownerLease,
        "current",
        opened.sessionKey
      );
      ownerLeaseRef.current = ownerLease;
      setTitle(displayTitle(detail, nextOwner));
      setWorkspace(nextWorkspace);
      setCurrentSnapshot(snapshot);
      setCurrentHandle(opened.sessionKey);
      setCurrentPresentationRevision((current) => current + 1);
      setIndependentHandle(undefined);
      setIndependentSnapshot(undefined);
      setStatus("open-clean");
      refresh();
      openedCurrentHandle = undefined;
      return { status: "success" };
    } catch (cause) {
      if (openedCurrentHandle) {
        await outputRawManuscriptService.close(
          openedCurrentHandle,
          nextOwner.ownerType,
          nextOwner.ownerId,
          "current",
          "discard"
        );
      }
      const nextError =
        cause instanceof Error ? cause.message : String(cause);
      setError(nextError);
      setStatus(session ? "error" : "closed");
      return { status: "error", error: nextError };
    }
  }

  function hasDirtySession() {
    return hasDirtySessionFor(owner);
  }

  async function requestLifecycleSequence(
    trigger: SharedEditorLifecycleTrigger,
    continuationIntent: SharedEditorLifecycleContinuationIntent,
    run: () => Promise<CommandResult>
  ): Promise<CommandResult> {
    let completed: CommandResult | undefined;
    const requested = await sharedEditorLifecycleController.requestSequence({
      trigger,
      continuationIntent,
      surface: "application",
      continuation: async () => {
        completed = await run();
      }
    });
    if (requested.status === "continued") {
      return completed ?? { status: "success" };
    }
    if (requested.status === "decision-required" || requested.status === "busy") {
      return { status: "decision-required" };
    }
    return {
      status: "error",
      error: continuationIntent === "SWITCH_MANUSCRIPT"
        ? projectFormalSwitchFailure(requested).summary
        : requested.error ?? "Shared editor lifecycle request failed."
    };
  }

  async function requestLifecycleParticipant(
    participantId: string,
    trigger: SharedEditorLifecycleTrigger,
    continuationIntent: SharedEditorLifecycleContinuationIntent,
    run: () => Promise<CommandResult>
  ): Promise<CommandResult> {
    let completed: CommandResult | undefined;
    const requested = await sharedEditorLifecycleController.requestParticipant({
      participantId,
      trigger,
      continuationIntent,
      surface: "application",
      continuation: async () => {
        completed = await run();
      }
    });
    if (requested.status === "continued") {
      return completed ?? { status: "success" };
    }
    if (requested.status === "decision-required" || requested.status === "busy") {
      return { status: "decision-required" };
    }
    return {
      status: "error",
      error: requested.error ?? "Shared editor lifecycle request failed."
    };
  }

  function updateCurrentRawMarkdown(markdown: string) {
    if (!owner || !currentHandle || !currentDocument) return;
    const updated = outputRawManuscriptService.updateDraft(
      currentHandle,
      owner.ownerType,
      owner.ownerId,
      "current",
      markdown
    );
    if (updated.status === "success") {
      setStatus(updated.session.dirty ? "open-dirty" : "open-clean");
      refresh();
    }
  }

  function updateIndependent(input: {
    body?: string;
    metaSnapshot?: string;
    outline?: string;
  }) {
    if (!owner || !independentHandle || !independentDocument) return;
    const replaced = replaceOutputManuscriptStandardBlocks(
      independentDocument.rawMarkdown,
      {
        metaSnapshot:
          input.metaSnapshot ??
          independentDocument.parsed.metaSnapshot ??
          "",
        outline:
          input.outline ?? independentDocument.parsed.outline ?? "",
        body: input.body ?? independentDocument.body
      }
    );
    if (replaced.status !== "success") return;
    const updated = outputRawManuscriptService.updateDraft(
      independentHandle,
      owner.ownerType,
      owner.ownerId,
      "independent",
      replaced.markdown
    );
    if (updated.status === "success") {
      setStatus(updated.session.dirty ? "open-dirty" : "open-clean");
      refresh();
    }
  }

  function updateIndependentRawMarkdown(markdown: string) {
    if (!owner || !independentHandle || !independentRuntimeSession) return false;
    const updated = outputRawManuscriptService.updateDraft(
      independentHandle,
      owner.ownerType,
      owner.ownerId,
      "independent",
      markdown
    );
    if (updated.status !== "success") return false;
    setStatus(updated.session.dirty ? "open-dirty" : "open-clean");
    refresh();
    return true;
  }

  async function saveCurrent() {
    if (!owner || !currentHandle) {
      return ordinarySavePresentation(
        {
          status: "missing-session",
          error: { code: "MANUSCRIPT_SESSION_NOT_FOUND" }
        },
        { ownerType: owner?.ownerType ?? "output", channel: "primary" }
      );
    }
    if (currentRuntimeSession?.accessMode === "read-only") {
      return ordinarySavePresentation(
        {
          status: "error",
          error: { code: "MANUSCRIPT_SESSION_READ_ONLY" }
        },
        { ownerType: owner.ownerType, channel: "primary" }
      );
    }
    setStatus("saving");
    const saved = await outputRawManuscriptService.save(
      currentHandle,
      owner.ownerType,
      owner.ownerId,
      "current"
    );
    if (saved.status !== "success" && saved.status !== "no-op") {
      setError(null);
      setStatus("open-dirty");
      return ordinarySavePresentation(
        saved,
        { ownerType: owner.ownerType, channel: "primary" }
      );
    }
    setError(null);
    setStatus("open-clean");
    refresh();
    return ordinarySavePresentation(
      saved,
      { ownerType: owner.ownerType, channel: "primary" }
    );
  }

  async function saveIndependent() {
    if (!owner || !independentHandle || !independentRuntimeSession) {
      return ordinarySavePresentation(
        {
          status: "missing-session",
          error: { code: "MANUSCRIPT_SESSION_NOT_FOUND" }
        },
        { ownerType: owner?.ownerType ?? "output", channel: "primary" }
      );
    }
    if (independentRuntimeSession.accessMode === "read-only") {
      return ordinarySavePresentation(
        {
          status: "error",
          error: { code: "MANUSCRIPT_SESSION_READ_ONLY" }
        },
        { ownerType: owner.ownerType, channel: "primary" }
      );
    }
    setStatus("saving");
    let saved = await outputRawManuscriptService.save(
      independentHandle,
      owner.ownerType,
      owner.ownerId,
      "independent"
    );
    if (
      saved.status !== "success" &&
      saved.status !== "no-op" &&
      resultMessage(saved, "").includes(
        "OUTPUT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
      )
    ) {
      if (
        !window.confirm(
          "This will write to an external manuscript file. Continue?"
        )
      ) {
        setStatus(independentRuntimeSession.dirty ? "open-dirty" : "open-clean");
        return;
      }
      saved = await outputRawManuscriptService.save(
        independentHandle,
        owner.ownerType,
        owner.ownerId,
        "independent",
        { confirmedExternalWrite: true }
      );
    }
    if (saved.status !== "success" && saved.status !== "no-op") {
      setError(null);
      setStatus("open-dirty");
      return ordinarySavePresentation(
        saved,
        { ownerType: owner.ownerType, channel: "primary" }
      );
    }
    setError(null);
    setStatus("open-clean");
    refresh();
    return ordinarySavePresentation(
      saved,
      { ownerType: owner.ownerType, channel: "primary" }
    );
  }

  async function selectSwitchAndRegister(): Promise<CommandResult> {
    if (!owner || !workspace || !currentDocument) {
      return {
        status: "error",
        error: "Outputs manuscript workspace is unavailable."
      };
    }
    const token = nextRequest();
    const selected = await localMarkdownFileService.selectMarkdownFile(
      "Switch Markdown manuscript",
      workspace.path
    );
    if (token !== requestCurrent()) return { status: "skipped" };
    if (!selected.ok) {
      return selected.errorCode === "canceled"
        ? { status: "skipped" }
        : {
            status: "error",
            error: `Markdown selection failed: ${selected.errorCode}.`
          };
    }
    const preview = await localMarkdownFileService.readMarkdownFile(
      selected.path
    );
    if (token !== requestCurrent()) return { status: "skipped" };
    if (!preview.ok) {
      return {
        status: "error",
        error: `Markdown validation failed: ${preview.errorCode}.`
      };
    }
    const locationMode =
      createPathIdentityKey(getManagedPathParent(selected.path)) ===
      workspace.pathIdentityKey
        ? "managed" as const
        : "external" as const;
    const ensured = await fileRefService.registerFileRef({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      manuscriptChannel: "primary",
      resourceKind: "file",
      fileRole: "manuscript",
      locationMode,
      fileType: "markdown",
      path: selected.path,
      title: selected.fileName,
      source: "user"
    });
    if (token !== requestCurrent()) return { status: "skipped" };
    const formal = createOutputManuscriptFormalSwitchService(
      owner.ownerType,
      owner.ownerId
    );
    const preflight = await formal.preflight(
      currentDocument,
      ensured.fileRef.id,
      token
    );
    if (preflight.status !== "success") {
      return {
        status: "error",
        error: resultMessage(
          preflight,
          "Target manuscript preflight failed."
        )
      };
    }
    return {
      status: "success",
      selection: {
        fileRefId: ensured.fileRef.id,
        fileName: selected.fileName,
        locationMode,
        preview: preflight.preview
      }
    };
  }

  async function openIndependent(): Promise<CommandResult> {
    if (!owner || !workspace) {
      return { status: "error", error: "No Outputs manuscript is open." };
    }
    const activeOwner = owner;
    const root = await managedRootConfigService.getStatus();
    if (root.status !== "configured" || !root.managedRoot) {
      return {
        status: "error",
        error: "Managed manuscript root is unavailable."
      };
    }
    const preview = input.independentOpenPreviewProvider ??
      createIndependentOpenPreviewProvider({
      pickerTitle: "Open Markdown manuscript",
      resolveWorkspace: async () => ({
        initialDirectory: workspace.path,
        configuredRoot: root.managedRoot,
        classify: (path) =>
          createPathIdentityKey(getManagedPathParent(path)) ===
          workspace.pathIdentityKey
            ? "managed"
            : "external"
      }),
      validateRaw({ rawText }) {
        const parsed = parseLabPodMarkdownDocument(rawText);
        return parsed.status === "invalid" || parsed.status === "ambiguous"
          ? {
              status: "error" as const,
              errorCode: "OUTPUT_MANUSCRIPT_STRUCTURE_INVALID"
            }
          : {
              status: "success" as const,
              summary: parsed.status
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
      `${activeOwner.ownerType}:${activeOwner.ownerId}:independent-editor`;
    const adapter: IndependentOpenProductAdapter = {
      owner: {
        ownerType: activeOwner.ownerType,
        ownerId: activeOwner.ownerId,
        channel: "primary"
      },
      presentationScope: consumerId,
      consumerId,
      selectAndPreview: preview.selectAndPreview,
      revalidatePreview: preview.revalidatePreview,
      listIndependentConsumers: () =>
        outputRawManuscriptService.listSessions().filter(
          ({ session }) =>
            session.owner.ownerType === activeOwner.ownerType &&
            session.owner.ownerId === activeOwner.ownerId &&
            session.owner.channel === "primary" &&
            session.windowRole === "independent"
        ),
      getCurrentConsumer: () =>
        currentHandle && currentRuntimeSession
          ? {
              handle: currentHandle,
              consumerId:
                `${activeOwner.ownerType}:${activeOwner.ownerId}:current-editor`,
              session: currentRuntimeSession
            }
          : undefined,
      async activateCurrent(id) {
        return normalize(
          await outputRawManuscriptService.openCurrent(
            activeOwner.ownerType,
            activeOwner.ownerId,
            id
          )
        );
      },
      async activateIndependent(fileRefId, id) {
        return normalize(
          await outputRawManuscriptService.openIndependent(
            activeOwner.ownerType,
            activeOwner.ownerId,
            fileRefId,
            id
          )
        );
      },
      async closeConsumer(handle, decision) {
        const before =
          outputRawManuscriptService.getSession(
            handle,
            activeOwner.ownerType,
            activeOwner.ownerId,
            "current"
          ) ??
          outputRawManuscriptService.getSession(
            handle,
            activeOwner.ownerType,
            activeOwner.ownerId,
            "independent"
          );
        if (decision === "save") {
          let saved = await outputRawManuscriptService.save(
            handle,
            activeOwner.ownerType,
            activeOwner.ownerId,
            "independent"
          );
          if (
            saved.status !== "success" &&
            saved.status !== "no-op" &&
            resultMessage(saved, "").includes(
              "OUTPUT_EXTERNAL_WRITE_CONFIRMATION_REQUIRED"
            )
          ) {
            if (
              !window.confirm(
                "Save the previous external manuscript before opening the new target?"
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
            saved = await outputRawManuscriptService.save(
              handle,
              activeOwner.ownerType,
              activeOwner.ownerId,
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
              errorCode: resultMessage(saved, "OUTPUT_SAVE_FAILED")
            } as const;
          }
        }
        const role = before?.windowRole === "current"
          ? "current"
          : "independent";
        const closed = await outputRawManuscriptService.close(
          handle,
          activeOwner.ownerType,
          activeOwner.ownerId,
          role,
          "discard"
        );
        return resolveIndependentOpenConsumerCleanup({
          closeStatus: closed.status,
          runtimeCleanup: "cleanup" in closed ? closed.cleanup : undefined,
          errorCode: resultMessage(closed, "OUTPUT_CLOSE_FAILED")
        });
      },
      async presentCurrent(activation, permit) {
        if (activation.status !== "success" || !permit.isCurrent()) return false;
        const snapshot =
          await outputManuscriptStructuredSnapshotService.get(
            activeOwner.ownerType,
            activeOwner.ownerId,
            activation.fileName
          );
        if (!permit.isCurrent()) return false;
        const lease = ownerLeaseRef.current;
        if (
          !lease ||
          lease.ownerType !== activeOwner.ownerType ||
          lease.ownerId !== activeOwner.ownerId ||
          !saveAsLifecycle.protectHandle(
            lease,
            "current",
            activation.handle
          )
        ) {
          return false;
        }
        setCurrentSnapshot(snapshot);
        setCurrentHandle(activation.handle);
        setCurrentPresentationRevision((current) => current + 1);
        setStatus("open-clean");
        refresh();
        return true;
      },
      async presentIndependent(activation, permit) {
        if (
          activation.status !== "success" ||
          !permit.isCurrent() ||
          ["invalid", "ambiguous"].includes(
            parseLabPodMarkdownDocument(
              activation.status === "success"
                ? activation.session.draftRawText
                : ""
            ).status
          )
        ) {
          return false;
        }
        const snapshot =
          await outputManuscriptStructuredSnapshotService.get(
            activeOwner.ownerType,
            activeOwner.ownerId,
            activation.fileName
          );
        if (!permit.isCurrent()) return false;
        const lease = ownerLeaseRef.current;
        if (
          !lease ||
          lease.ownerType !== activeOwner.ownerType ||
          lease.ownerId !== activeOwner.ownerId ||
          !saveAsLifecycle.protectHandle(
            lease,
            "independent",
            activation.handle
          )
        ) {
          return false;
        }
        setIndependentSnapshot(snapshot);
        setIndependentHandle(activation.handle);
        setStatus("open-clean");
        refresh();
        return true;
      },
      async focusCurrent(consumer, permit) {
        if (!permit.isCurrent()) return false;
        const lease = ownerLeaseRef.current;
        if (
          !lease ||
          !saveAsLifecycle.protectHandle(
            lease,
            "current",
            consumer.handle
          )
        ) {
          return false;
        }
        setCurrentHandle(consumer.handle);
        setCurrentPresentationRevision((current) => current + 1);
        refresh();
        return true;
      },
      async focusIndependent(consumer, permit) {
        if (!permit.isCurrent()) return false;
        const snapshot =
          await outputManuscriptStructuredSnapshotService.get(
            activeOwner.ownerType,
            activeOwner.ownerId,
            consumer.session.file.fileName
          );
        if (!permit.isCurrent()) return false;
        const lease = ownerLeaseRef.current;
        if (
          !lease ||
          !saveAsLifecycle.focusIndependent(
            lease,
            consumer.handle
          )
        ) {
          return false;
        }
        setIndependentSnapshot(snapshot);
        setIndependentHandle(consumer.handle);
        setStatus(
          consumer.session.dirty
            ? "open-dirty"
            : "open-clean"
        );
        refresh();
        return true;
      },
      async decideDirty() {
        return new Promise<"save" | "discard" | "cancel">((resolve) => {
          void sharedEditorLifecycleController.requestParticipant({
            participantId: `outputs-independent:${independentHandleRef.current ?? "closed"}`,
            trigger: "open-independent",
            continuationIntent: "OPEN_INDEPENDENT",
            surface: "application",
            continuation: (decision) => resolve(decision ?? "discard")
          }).then((requested) => {
            if (
              requested.status === "unavailable" ||
              requested.status === "failed" ||
              requested.status === "stale"
            ) {
              resolve("cancel");
            }
          });
        });
      },
      async confirmRegistration(selected) {
        return window.confirm(
          `Register and open "${selected.fileName}"? This creates FileRef metadata only and does not change the current manuscript or file bytes.`
        )
          ? "confirm"
          : "cancel";
      },
      async confirmActivationRetry({ fileName }) {
        return window.confirm(
          `"${fileName}" was registered but could not be activated. Retry now?`
        );
      }
    };
    const outcome = await openProtocol.execute(adapter);
    if (
      [
        "current-session-reused",
        "current-session-activated",
        "independent-session-reused",
        "activation-succeeded"
      ].includes(outcome.status)
    ) {
      return { status: "success" };
    }
    if (
      outcome.status === "picker-cancelled" ||
      outcome.status === "registration-declined"
    ) {
      return { status: "skipped" };
    }
    const nextError =
      outcome.errorCode ?? `Independent Open failed: ${outcome.status}.`;
    setError(nextError);
    syncStatus();
    return { status: "error", error: nextError };
  }

  async function executeFormalSwitch(
    targetFileRefId: string
  ): Promise<CommandResult> {
    if (!owner || !currentDocument || !currentHandle) {
      return { status: "error", error: "No Outputs manuscript is open." };
    }
    setStatus("switching");
    const formal: OutputManuscriptFormalSwitchService =
      createOutputManuscriptFormalSwitchService(
        owner.ownerType,
        owner.ownerId
      );
    const committed = await formal.commit({
      current: currentDocument,
      currentSessionHandle: currentHandle,
      targetFileRefId,
      switchReason: "user",
      requestToken: nextRequest()
    });
    if (committed.status === "canceled") {
      syncStatus();
      return { status: "skipped" };
    }
    if (committed.status === "error" &&
        committed.error.causeCode === "OUTPUT_MANUSCRIPT_FORMAL_SWITCH_TARGET_ALREADY_CURRENT" &&
        currentDocument.fileRefId === targetFileRefId) {
      syncStatus();
      return { status: "skipped" };
    }
    if (committed.status !== "success") {
      const nextError = projectFormalSwitchFailure(committed).summary;
      setError(nextError);
      syncStatus();
      return { status: "error", error: nextError };
    }
    const activated = outputRawManuscriptService.getSession(
      committed.sessionKey,
      owner.ownerType,
      owner.ownerId,
      "current"
    );
    if (
      !activated ||
      activated.file.kind !== "durable" ||
      activated.file.fileRefId !== targetFileRefId
    ) {
      const lease = ownerLeaseRef.current;
      if (lease) {
        saveAsLifecycle.protectHandle(
          lease,
          "current",
          undefined
        );
      }
      setCurrentHandle(undefined);
      setCurrentSnapshot(undefined);
      setStatus("closed");
      return {
        status: "error",
        error: projectFormalSwitchFailure({ error: { sideEffectSummary: { databaseCommitted: true } } }).summary
      };
    }
    try {
      setCurrentSnapshot(
        await outputManuscriptStructuredSnapshotService.get(
          owner.ownerType,
          owner.ownerId,
          activated.file.fileName
        )
      );
    } catch {
      const nextError = projectFormalSwitchFailure({ error: { sideEffectSummary: { databaseCommitted: true } } }).summary;
      setError(nextError);
      syncStatus();
      return { status: "error", error: nextError };
    }
    const lease = ownerLeaseRef.current;
    if (lease) {
      saveAsLifecycle.protectHandle(
        lease,
        "current",
        committed.sessionKey
      );
    }
    setCurrentHandle(committed.sessionKey);
    setCurrentPresentationRevision((current) => current + 1);
    setError(null);
    setStatus("open-clean");
    refresh();
    return { status: "success" };
  }

  function createSaveAsInvocationContext(
      request: ManuscriptCandidateCustodyRequest,
      frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot
  ): OutputManuscriptSaveAsInvocationContext | undefined {
    const frozenOwner = request.ownerLease;
    const frozenOwnerType =
      frozenOwner.ownerType as OutputManuscriptOwnerType;
    const sourceRole = request.sourceWindowRole;
    const sourceHandle = request.sourceRuntimeHandle;
    const frozenWorkspace = workspaceRef.current;
    if (
      !sourceRole ||
      !sourceHandle ||
      !frozenWorkspace ||
      !saveAsLifecycle.isCandidateCurrent(request)
    ) {
      return undefined;
    }
    const sourceSession =
      outputRawManuscriptService.getSession(
        sourceHandle,
        frozenOwnerType,
        frozenOwner.ownerId,
        sourceRole
      );
    if (
      !sourceSession ||
      sourceSession.file.kind !== "durable" ||
      !frozenWorkspace.bindingIdentity.bindingId
    ) {
      return undefined;
    }
    const descriptor = getOutputManuscriptStaticDescriptor(
      frozenOwnerType
    );
    return Object.freeze({
      owner: Object.freeze({
        ownerType: frozenOwnerType,
        ownerId: frozenOwner.ownerId,
        channel: "primary" as const
      }),
      descriptor,
      source: Object.freeze({
        windowRole: sourceRole,
        runtimeHandle: sourceHandle,
        fileRefId: sourceSession.file.fileRefId
      }),
      bindingIdentity: Object.freeze({
        ...frozenWorkspace.bindingIdentity
      }),
      lifecycle: Object.freeze({
        ownerInstanceToken:
          frozenOwner.ownerInstanceToken,
        mountToken: frozenOwner.mountToken,
        leaseToken: frozenOwner.leaseToken,
        mountGeneration: frozenOwner.mountGeneration,
        replacementGeneration:
          request.replacementGeneration
      }),
      draftDirtyOwnership: Object.freeze({
        dirty: sourceSession.dirty,
        authority: "shared-runtime" as const
      }),
      rawSnapshotAuthority:
        frozenDraftSnapshot
          ? "shared-segment-sidecar-f1" as const
          : "shared-runtime-s0" as const,
      frozenDraftSnapshot,
      pickerTitle: descriptor.presentationLabel,
      candidateCustody: request,
      presentationAllowed: async () =>
        mountedRef.current &&
        saveAsLifecycle.isCandidateCurrent(request)
    });
  }

  async function closeDisplacedHandle(
    context: OutputManuscriptSaveAsInvocationContext,
    displacedHandle: SharedManuscriptSessionHandle | undefined
  ) {
    if (
      !displacedHandle ||
      saveAsLifecycle.isProtected(displacedHandle)
    ) {
      return true;
    }
    const closed = await outputRawManuscriptService.close(
      displacedHandle,
      context.owner.ownerType,
      context.owner.ownerId,
      "independent",
      "discard"
    );
    return (
      closed.status === "success" ||
      (
        closed.status === "error" &&
        resultMessage(closed, "").includes(
          "OUTPUT_MANUSCRIPT_SESSION_MISSING"
        )
      )
    );
  }

  async function cleanupReleasedSource(
    context: OutputManuscriptSaveAsInvocationContext
  ) {
    const activeLease = ownerLeaseRef.current;
    const sourceHandle = context.source.runtimeHandle;
    const remainsPresented =
      activeLease &&
      saveAsLifecycle.isCurrentLease(activeLease) &&
      activeLease.ownerType === context.owner.ownerType &&
      activeLease.ownerId === context.owner.ownerId &&
      (
        currentHandleRef.current === sourceHandle ||
        independentHandleRef.current === sourceHandle
      );
    if (
      remainsPresented ||
      saveAsLifecycle.isProtected(sourceHandle)
    ) {
      return true;
    }
    const closed = await outputRawManuscriptService.close(
      sourceHandle,
      context.owner.ownerType,
      context.owner.ownerId,
      context.source.windowRole,
      "discard"
    );
    return (
      closed.status === "success" ||
      (
        closed.status === "error" &&
        resultMessage(closed, "").includes(
          "OUTPUT_MANUSCRIPT_SESSION_MISSING"
        )
      )
    );
  }

  function classifyPostFreezeSource(
    context: OutputManuscriptSaveAsInvocationContext,
    candidate: InstallableOutputSaveAsCandidate,
    sourceFileRefAvailable: boolean
  ): "retain" | "release" | "stale" {
    if (!("frozenSource" in candidate)) return "release";
    const frozen = candidate.frozenSource;
    const live = outputRawManuscriptService.getSession(
      context.source.runtimeHandle,
      context.owner.ownerType,
      context.owner.ownerId,
      context.source.windowRole
    );
    if (
      !live ||
      !sourceFileRefAvailable ||
      live.stale ||
      live.closing ||
      live.owner.ownerType !== frozen.owner.ownerType ||
      live.owner.ownerId !== frozen.owner.ownerId ||
      live.owner.channel !== frozen.owner.channel ||
      live.windowRole !== context.source.windowRole ||
      frozen.sourceRuntimeHandle !==
        context.source.runtimeHandle ||
      live.sessionKey !== frozen.sourceSessionKey ||
      `${live.sessionKey}@${live.sessionGeneration}` !==
        frozen.stableSessionInstanceId ||
      live.sessionGeneration !==
        frozen.sourceRuntimeGeneration ||
      live.file.kind !== "durable" ||
      live.file.fileRefId !== frozen.sourceFileRefId ||
      live.file.fileRefId !== context.source.fileRefId ||
      live.file.pathIdentity !==
        frozen.sourcePathIdentityKey
    ) {
      return "stale";
    }
    const changed =
      live.draftVersion !== frozen.frozenDraftRevision ||
      live.dirty !== frozen.frozenDirty ||
      (live.currentRevision ??
        live.openedRevision ??
        live.baseline?.revision ??
        "") !== frozen.sourceRevision;
    return (
      context.source.windowRole === "independent" &&
      changed
    )
      ? "retain"
      : "release";
  }

  async function installSaveAsCandidate(
    context: OutputManuscriptSaveAsInvocationContext,
    candidate: InstallableOutputSaveAsCandidate
  ) {
    const request = context.candidateCustody;
    const receipt = candidate.candidateCustody;
    if (
      !saveAsLifecycle.verifyReceipt(receipt) ||
      receipt.request !== request ||
      receipt.fileRefId !== candidate.fileRefId ||
      !saveAsLifecycle.isCandidateCurrent(request)
    ) {
      const rejected = await saveAsFinalization.reject({
        trigger: "IMMEDIATE_RECEIPT",
        presented: candidate,
        lifecycle: saveAsLifecycle,
        decision: "stale"
      });
      return rejected.status === "blocked"
        ? { status: "cleanup-blocked" as const }
        : { status: "stale" as const };
    }
    let snapshot: OutputManuscriptStructuredSnapshot;
    try {
      snapshot =
        await outputManuscriptStructuredSnapshotService.get(
          context.owner.ownerType,
          context.owner.ownerId,
          candidate.targetFileName
        );
    } catch {
      const rejected = await saveAsFinalization.reject({
        trigger: "IMMEDIATE_RECEIPT",
        presented: candidate,
        lifecycle: saveAsLifecycle,
        decision: "install_failed"
      });
      return rejected.status === "blocked"
        ? { status: "cleanup-blocked" as const }
        : { status: "stale" as const };
    }
    let sourceFileRefAvailable = true;
    if ("frozenSource" in candidate) {
      try {
        const sourceFileRef =
          await fileRefService.getById(
            candidate.frozenSource.sourceFileRefId
          );
        sourceFileRefAvailable = Boolean(
          sourceFileRef &&
          !sourceFileRef.deletedAt
        );
      } catch {
        sourceFileRefAvailable = false;
      }
    }
    const sourceDisposition =
      classifyPostFreezeSource(
        context,
        candidate,
        sourceFileRefAvailable
      );
    if (sourceDisposition === "stale") {
      const rejected = await saveAsFinalization.reject({
        trigger: "IMMEDIATE_RECEIPT",
        presented: candidate,
        lifecycle: saveAsLifecycle,
        decision: "stale"
      });
      return rejected.status === "blocked"
        ? { status: "cleanup-blocked" as const }
        : { status: "stale" as const };
    }
      const replacement = await saveAsFinalization.finalize({
        trigger: "IMMEDIATE_RECEIPT",
      presented: candidate,
      lifecycle: saveAsLifecycle,
      sourceDisposition
    });
    if (replacement.status !== "finalized") {
      return replacement.status === "blocked"
        ? { status: "cleanup-blocked" as const }
        : { status: "stale" as const };
    }
    if (
      !mountedRef.current ||
      ownerLeaseRef.current !==
        request.ownerLease
    ) {
      return { status: "installed" as const };
    }
    const displacedClosed = await closeDisplacedHandle(
      context,
      replacement.displacedSessionKey
    );
    if (!displacedClosed) {
      return { status: "cleanup-blocked" as const };
    }
    setIndependentSnapshot(snapshot);
    setIndependentHandle(replacement.installedSessionKey);
    setError(null);
    setStatus(
      hasDirtySessionFor(context.owner)
        ? "open-dirty"
        : "open-clean"
    );
    refresh();
    return { status: "installed" as const };
  }

  async function performCanonicalSaveAs(
    sourceWindowRole: "current" | "independent",
    frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot
  ): Promise<CommandResult> {
    const lease = ownerLeaseRef.current;
    const sourceRuntimeHandle =
      sourceWindowRole === "current"
        ? currentHandleRef.current
        : independentHandleRef.current;
    if (
      !lease ||
      !sourceRuntimeHandle ||
      !saveAsLifecycle.isCurrentLease(lease)
    ) {
      return {
        status: "error",
        error:
          sourceWindowRole === "current"
            ? "No Outputs manuscript is open."
            : "No independent Outputs manuscript is open."
      };
    }
    const request = saveAsLifecycle.beginCandidate({
      ownerLease: lease,
      producer: "save-as",
      sourceWindowRole,
      sourceRuntimeHandle
    });
    if (!request) {
      return {
        status: "error",
        error: "Outputs Save As lifecycle is stale."
      };
    }
    const context =
      createSaveAsInvocationContext(request, frozenDraftSnapshot);
    if (!context) {
      saveAsLifecycle.completeCandidate(
        request,
        "rejected"
      );
      return {
        status: "error",
        error: "Outputs Save As source is unavailable."
      };
    }
    if (mountedRef.current) setStatus("save-as");
    const committed = await saveAsService.saveAs(context);
    if (committed.status === "canceled") {
      saveAsLifecycle.completeCandidate(
        request,
        "rejected"
      );
      await cleanupReleasedSource(context);
      if (
        mountedRef.current &&
        ownerLeaseRef.current === lease
      ) {
        syncStatus();
      }
      return { status: "skipped" };
    }
    if (committed.status !== "presented") {
      saveAsLifecycle.completeCandidate(
        request,
        committed.cleanup?.status === "cleanup-blocked"
          ? "cleanup-blocked"
          : "rejected"
      );
      await cleanupReleasedSource(context);
      const nextError =
        `Outputs Save As failed: ${committed.errorCode}.`;
      if (
        mountedRef.current &&
        ownerLeaseRef.current === lease
      ) {
        setError(nextError);
        syncStatus();
      }
      return { status: "error", error: nextError };
    }
    const installed = await installSaveAsCandidate(
      context,
      committed
    );
    await cleanupReleasedSource(context);
    return installed.status === "installed"
      ? { status: "success" }
      : {
          status: "error",
          error:
            installed.status === "cleanup-blocked"
              ? "Outputs Save As cleanup is blocked."
              : "Outputs Save As result is stale."
        };
  }

  async function recoverSaveAsOperations(
    sweepGeneration: number
  ) {
    const lease = ownerLeaseRef.current;
    const sourceRuntimeHandle =
      currentHandleRef.current ??
      independentHandleRef.current;
    const sourceWindowRole =
      currentHandleRef.current
        ? "current" as const
        : "independent" as const;
    if (
      !lease ||
      !sourceRuntimeHandle ||
      !saveAsLifecycle.isCurrentLease(lease)
    ) {
      return;
    }
    const operations = await saveAsService.listUnresolved(
      lease.ownerType as OutputManuscriptOwnerType,
      lease.ownerId
    );
    for (const operation of operations) {
      if (
        recoverySweepGenerationRef.current !==
          sweepGeneration ||
        !saveAsLifecycle.isCurrentLease(lease)
      ) {
        return;
      }
      const request = saveAsLifecycle.beginCandidate({
        ownerLease: lease,
        producer: "recovery",
        sourceWindowRole,
        sourceRuntimeHandle
      });
      if (!request) return;
      const context =
        createSaveAsInvocationContext(request);
      if (!context) {
        saveAsLifecycle.completeCandidate(
          request,
          "rejected"
        );
        return;
      }
      const recovered = await saveAsService.recover({
        operationId: operation.operationId,
        context
      });
      if (recovered.status === "contained") {
        saveAsLifecycle.completeCandidate(
          request,
          "rejected"
        );
        if (
          mountedRef.current &&
          recoverySweepGenerationRef.current === sweepGeneration &&
          saveAsLifecycle.isCurrentLease(lease)
        ) {
          setError(
            windowPContainmentFeedbackMessage(recovered.blockingCode)
          );
          syncStatus();
        }
        continue;
      }
      if (recovered.status !== "presented") {
        saveAsLifecycle.completeCandidate(
          request,
          recovered.cleanup?.status === "cleanup-blocked"
            ? "cleanup-blocked"
            : "rejected"
        );
        continue;
      }
      const installed = await installSaveAsCandidate(
        context,
        recovered
      );
      if (installed.status === "cleanup-blocked") {
        if (mountedRef.current) {
          setError(
            "Outputs Save As recovery cleanup is blocked."
          );
        }
        return;
      }
    }
  }

  function readCurrentLifecycleSession() {
    const activeOwner = ownerRef.current;
    const handle = currentHandleRef.current;
    return activeOwner && handle
      ? outputRawManuscriptService.getSession(
          handle,
          activeOwner.ownerType,
          activeOwner.ownerId,
          "current"
        )
      : undefined;
  }

  function readIndependentLifecycleSession() {
    const activeOwner = ownerRef.current;
    const handle = independentHandleRef.current;
    return activeOwner && handle
      ? outputRawManuscriptService.getSession(
          handle,
          activeOwner.ownerType,
          activeOwner.ownerId,
          "independent"
        )
      : undefined;
  }

  async function discardLifecycleSession(role: "current" | "independent") {
    const activeOwner = ownerRef.current;
    const handle = role === "current"
      ? currentHandleRef.current
      : independentHandleRef.current;
    if (!activeOwner || !handle) {
      throw new Error("MANUSCRIPT_LIFECYCLE_SESSION_UNAVAILABLE");
    }
    const result = await outputRawManuscriptService.reload(
      handle,
      activeOwner.ownerType,
      activeOwner.ownerId,
      role,
      "discard"
    );
    refresh();
    if (result.status !== "success") {
      throw new Error(resultMessage(result, "Outputs manuscript discard failed."));
    }
  }

  return {
    state,
    currentHandle,
    independentHandle,
    currentRuntimeSession,
    independentRuntimeSession,
    currentPresentationRevision,
    independentPresentationRevision,
    readCurrentSession: readCurrentLifecycleSession,
    readIndependentSession: readIndependentLifecycleSession,
    discardCurrent: () => discardLifecycleSession("current"),
    discardIndependent: () => discardLifecycleSession("independent"),
    openOutputManuscript(
      ownerType: OutputManuscriptOwnerType,
      ownerId: string
    ) {
      const nextOwner = { ownerType, ownerId };
      if (
        owner?.ownerType === ownerType &&
        owner.ownerId === ownerId &&
        currentHandle
      ) {
        return Promise.resolve({
          status: "skipped" as const
        });
      }
      return requestLifecycleSequence(
        "owner-change",
        "OWNER_CHANGE",
        () => performOpen(nextOwner)
      );
    },
    updateDraft: updateCurrentRawMarkdown,
    save: saveCurrent,
    requestReload() {
      return requestLifecycleParticipant(
        `outputs-current:${currentHandle ?? "closed"}`,
        "reload",
        "RELOAD",
        async () => {
        if (!owner || !currentHandle) {
          return {
            status: "error",
            error: "No Outputs manuscript is open."
          };
        }
        setStatus("reloading");
        const reloaded = await outputRawManuscriptService.reload(
          currentHandle,
          owner.ownerType,
          owner.ownerId,
          "current"
        );
        if (reloaded.status !== "success") {
          const nextError = resultMessage(
            reloaded,
            "Outputs manuscript reload failed."
          );
          setError(nextError);
          syncStatus();
          return { status: "error", error: nextError };
        }
        setStatus("open-clean");
        refresh();
        return { status: "success" };
        }
      );
    },
    requestIndependentReload() {
      return requestLifecycleParticipant(
        `outputs-independent:${independentHandle ?? "closed"}`,
        "reload",
        "RELOAD",
        async (): Promise<CommandResult> => {
        if (!owner || !independentHandle) {
          return {
            status: "error" as const,
            error: "No independent Outputs manuscript is open."
          };
        }
        setStatus("reloading");
        const reloaded = await outputRawManuscriptService.reload(
          independentHandle,
          owner.ownerType,
          owner.ownerId,
          "independent"
        );
        if (reloaded.status !== "success") {
          const nextError = resultMessage(
            reloaded,
            "Independent Outputs manuscript reload failed."
          );
          setError(nextError);
          syncStatus();
          return { status: "error" as const, error: nextError };
        }
        setIndependentPresentationRevision((current) => current + 1);
        setStatus("open-clean");
        refresh();
        return { status: "success" as const };
        }
      );
    },
    openIndependentManuscript() {
      return openIndependent();
    },
    updateIndependentDraft: updateIndependentRawMarkdown,
    updateIndependentSections(input: {
      metaSnapshot?: string;
      outline?: string;
    }) {
      updateIndependent(input);
    },
    saveIndependent,
    async closeIndependent() {
      if (owner && independentHandle) {
        const closed = await outputRawManuscriptService.close(
          independentHandle,
          owner.ownerType,
          owner.ownerId,
          "independent"
        );
        if (closed.status !== "success") {
          return {
            status: "error" as const,
            error: resultMessage(closed, "Independent Outputs manuscript close failed.")
          };
        }
      }
      setIndependentHandle(undefined);
      const lease = ownerLeaseRef.current;
      if (lease) {
        saveAsLifecycle.protectHandle(
          lease,
          "independent",
          undefined
        );
      }
      setIndependentSnapshot(undefined);
      refresh();
      return { status: "success" as const };
    },
    requestSelectForFormalSwitch() {
      return selectSwitchAndRegister();
    },
    requestFormalSwitch(targetFileRefId: string) {
      return requestLifecycleSequence(
        "switch-manuscript",
        "SWITCH_MANUSCRIPT",
        () => executeFormalSwitch(targetFileRefId)
      );
    },
    requestClose() {
      return requestLifecycleSequence("top-close", "CLOSE_EDITOR", async () => {
        await closeHandles();
        setOwner(undefined);
        setWorkspace(undefined);
        setStatus("closed");
        setError(null);
        return { status: "success" };
      });
    },
    requestProjectSwitch(
      nextProjectId: string,
      commit: () => Promise<void> | void
    ) {
      return requestLifecycleSequence(
        "project-change",
        "PROJECT_CHANGE",
        async () => {
          await closeHandles();
          setOwner(undefined);
          setWorkspace(undefined);
          setStatus("closed");
          await commit();
          return { status: "success" };
        }
      );
    },
    requestSelectionChange(
      nextOwner: Owner,
      commit: () => Promise<void> | void
    ) {
      return requestLifecycleSequence(
        "owner-change",
        "OWNER_CHANGE",
        async () => {
          await closeHandles();
          setOwner(undefined);
          setWorkspace(undefined);
          setStatus("closed");
          await commit();
          return { status: "success" };
        }
      );
    },
    requestPageLeave(
      destination: string,
      commit: () => Promise<void> | void
    ) {
      return requestLifecycleSequence(
        "route-change",
        "ROUTE_CHANGE",
        async () => {
          await closeHandles();
          setOwner(undefined);
          setWorkspace(undefined);
          setStatus("closed");
          await commit();
          return { status: "success" };
        }
      );
    },
    requestDeleteOwner(
      ownerType: OutputManuscriptOwnerType,
      ownerId: string,
      execute: () => Promise<boolean>
    ) {
      if (
        owner?.ownerType !== ownerType ||
        owner.ownerId !== ownerId
      ) {
        return execute().then((deleted) => ({
          status: deleted ? "success" as const : "skipped" as const
        }));
      }
      return requestLifecycleSequence(
        "owner-change",
        "OWNER_CHANGE",
        async () => {
          const deleted = await execute();
          if (deleted) {
            const lease = ownerLeaseRef.current;
            if (lease) {
              saveAsLifecycle.unmountOwner(lease);
              ownerLeaseRef.current = undefined;
            }
            recoverySweepGenerationRef.current += 1;
            refresh();
            setStatus("open-clean");
          }
          return {
            status: deleted ? "success" as const : "skipped" as const
          };
        }
      );
    },
    saveCurrentAs(snapshot?: ManuscriptSegmentDraftSnapshot): Promise<CommandResult> {
      return performCanonicalSaveAs("current", snapshot);
    },
    saveIndependentAs(snapshot?: ManuscriptSegmentDraftSnapshot): Promise<CommandResult> {
      return performCanonicalSaveAs("independent", snapshot);
    },
    canDispose: () => !hasDirtySession(),
    async dispose() {
      if (hasDirtySession()) return;
      nextRequest();
      await closeHandles();
      setOwner(undefined);
      setWorkspace(undefined);
      setStatus("closed");
      setError(null);
    }
  };
}
