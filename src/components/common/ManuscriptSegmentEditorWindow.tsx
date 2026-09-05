import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode
} from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { nonPlanningUi } from "../../i18n/nonPlanningI18n";
import type { ManuscriptOutlineDescriptorLookupIdentity } from "../../services/manuscriptOutlineParser";
import type { ManuscriptSegmentSessionAdapter } from "../../services/manuscriptSegmentSessionAdapter";
import { isManuscriptSegmentProductIdentity } from "../../services/manuscriptSegmentProductActivation";
import {
  resolveManuscriptSegmentProductCapability,
  type ManuscriptSegmentEntryKind
} from "../../services/manuscriptSegmentProductCapability";
import {
  executeManuscriptSegmentExplicitInsertion,
  type ManuscriptSegmentFocusedTarget
} from "../../services/manuscriptSegmentExplicitInsertion";
import { queryMarkdownTemplates } from "../../services/markdownTemplateService";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";
import { sharedManuscriptSegmentSessionAdapter } from "../../services/sharedManuscriptSessionComposition";
import {
  F3_MANUSCRIPT_EDITOR_LAYOUT_CSS_VARIABLES,
  F3_MANUSCRIPT_EDITOR_UI_FREEZE,
  F3_MANUSCRIPT_EDITOR_VARIANT_REGISTRY,
  classifyF3FooterActionSlot,
  resolveF3ManuscriptEditorWindowTitle,
  resolveF3RightManuscriptTitle,
  resolveF3StructuredSummaryValue,
  type ManuscriptEditorFooterActionSlot
} from "../../services/manuscriptEditorUiFreeze";
import {
  captureManuscriptTemplateInsertionTarget,
  revalidateManuscriptTemplateInsertionTarget,
  type ManuscriptTemplateInsertionTarget
} from "../../services/manuscriptTemplateInsertionTarget";
import type { OrdinaryOperationPresentationResult } from "../../services/ordinaryOperationPresentation";
import type {
  ManuscriptSegmentDraftSnapshot,
  ManuscriptSegmentProjectionSessionState
} from "../../types/manuscriptSegmentProjection";
import type { MarkdownTemplate, MarkdownTemplateScope } from "../../types/markdownTemplate";
import type {
  SharedManuscriptSession,
  SharedManuscriptSessionHandle
} from "../../types/sharedManuscriptSession";
import type { MarkdownEditorContextItem } from "../../types/markdownEditor";
import { ManuscriptSegmentEditor } from "./ManuscriptSegmentEditor";
import { ManuscriptSegmentPreview } from "./ManuscriptSegmentPreview";
import { ManuscriptTemplateWorkspacePanel } from "./ManuscriptTemplateWorkspacePanel";
import { SharedEditorLifecycleDecisionDialog } from "./SharedEditorLifecycleDecisionDialog";

export type ManuscriptSegmentEditorLifecycleBinding = {
  participantId: string;
  handle: SharedManuscriptSessionHandle;
  presentationEpoch: number;
  readSession(): SharedManuscriptSession | undefined;
};

export type ManuscriptSegmentEditorWindowAction = {
  key: string;
  label: string;
  disabled?: boolean;
  intent?: "save-as";
  onClick(snapshot?: ManuscriptSegmentDraftSnapshot): Promise<unknown> | unknown;
};

export type ManuscriptSegmentContextInsertion = Readonly<{
  label?: string;
  isAvailable: boolean;
  unavailableReason?: string;
  resolveMarkdown(): Promise<string> | string;
}>;

export type ManuscriptSegmentEditorWindowProps = {
  isOpen: boolean;
  descriptorLookupIdentity: ManuscriptOutlineDescriptorLookupIdentity;
  entryKind: ManuscriptSegmentEntryKind;
  lifecycle: ManuscriptSegmentEditorLifecycleBinding;
  contentIdentity?: string;
  entityTitle?: string | null;
  readonlyContextItems?: MarkdownEditorContextItem[];
  leftPanelTitle?: string;
  disabled?: boolean;
  draftReadOnly?: boolean;
  saveDisabled?: boolean;
  loading?: boolean;
  headerNotice?: string;
  saveLabel?: string;
  cancelLabel?: string;
  closeLabel?: string;
  dirtyLabel?: string;
  unsavedChangesTitle?: string;
  unsavedChangesLabel?: string;
  saveChangesLabel?: string;
  discardChangesLabel?: string;
  continueEditingLabel?: string;
  savingLabel?: string;
  saveFailedLabel?: string;
  recoveryRailContent?: ReactNode;
  floatingFeedbackContent?: ReactNode;
  footerLeadingActions?: ManuscriptSegmentEditorWindowAction[];
  contextInsertion?: ManuscriptSegmentContextInsertion;
  onCancel(): Promise<unknown> | unknown;
  onClose?: () => Promise<unknown> | unknown;
  sessionAdapter?: ManuscriptSegmentSessionAdapter;
};

type LocalFeedback = {
  severity: "success" | "error";
  message: string;
};

type TemplateWorkspaceState = Readonly<{
  scope: MarkdownTemplateScope;
  templates: readonly MarkdownTemplate[];
  target: ManuscriptTemplateInsertionTarget;
  managing: boolean;
  targetInvalidMessage?: string;
}>;

function descriptorKey(identity: ManuscriptOutlineDescriptorLookupIdentity) {
  return `${identity.ownerType}:${identity.channel}:${identity.reviewType ?? ""}`;
}

function productStateKey(props: ManuscriptSegmentEditorWindowProps) {
  return [
    props.lifecycle.handle,
    String(props.lifecycle.presentationEpoch),
    props.contentIdentity ?? "",
    descriptorKey(props.descriptorLookupIdentity)
  ].join("|");
}

function feedbackMessage(
  result: OrdinaryOperationPresentationResult,
  ui: (source: string) => string,
  saveFailedLabel: string
) {
  switch (result.userMessageKey) {
    case "ordinary.save.changed": return ui("已保存");
    case "ordinary.save.noOp": return ui("内容未变化");
    case "ordinary.save.stale":
      return ui("文稿已在磁盘上发生变化；当前草稿已保留，未覆盖外部修改。");
    case "ordinary.save.readOnly": return ui("当前文稿为只读，无法保存。");
    case "ordinary.save.unavailable": return ui("文稿会话已失效，请重新打开后再保存。");
    case "ordinary.save.activeOperation": return ui("文稿正在执行其他操作，请稍后重试。");
    default: return saveFailedLabel;
  }
}

function sameDescriptor(
  left: ManuscriptOutlineDescriptorLookupIdentity,
  right: ManuscriptOutlineDescriptorLookupIdentity
) {
  return left.ownerType === right.ownerType &&
    left.channel === right.channel &&
    left.reviewType === right.reviewType;
}

export function ManuscriptSegmentEditorWindow(props: ManuscriptSegmentEditorWindowProps) {
  const {
    isOpen,
    lifecycle,
    descriptorLookupIdentity,
    readonlyContextItems = [],
    footerLeadingActions = [],
    sessionAdapter = sharedManuscriptSegmentSessionAdapter
  } = props;
  const { language } = useI18n();
  const ui = (source: string) => nonPlanningUi(language, source);
  const adapterRef = useRef(sessionAdapter);
  const lifecycleRef = useRef(lifecycle);
  const descriptorRef = useRef(descriptorLookupIdentity);
  const propsRef = useRef(props);
  const stateKey = productStateKey(props);
  const [attached, setAttached] = useState<{
    key: string;
    state: ManuscriptSegmentProjectionSessionState;
  }>();
  const [attachError, setAttachError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");
  const [ordinaryFeedback, setOrdinaryFeedback] = useState<LocalFeedback>();
  const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
  const [previewSnapshot, setPreviewSnapshot] = useState<ManuscriptSegmentDraftSnapshot>();
  const [focusedTarget, setFocusedTarget] = useState<ManuscriptSegmentFocusedTarget>();
  const [templateWorkspace, setTemplateWorkspace] = useState<TemplateWorkspaceState>();
  const [focusRestoreRequest, setFocusRestoreRequest] = useState<Readonly<{
    requestId: string;
    target: ManuscriptSegmentFocusedTarget;
  }>>();
  const [operationLock, setOperationLock] = useState<"preview" | "save-as" | "insertion">();
  const operationLockRef = useRef<typeof operationLock>();

  adapterRef.current = sessionAdapter;
  lifecycleRef.current = lifecycle;
  descriptorRef.current = descriptorLookupIdentity;
  propsRef.current = props;

  function setLockedOperation(next: typeof operationLock) {
    operationLockRef.current = next;
    setOperationLock(next);
  }

  const lifecycleSnapshot = useSyncExternalStore(
    sharedEditorLifecycleController.subscribe,
    sharedEditorLifecycleController.getSnapshot,
    sharedEditorLifecycleController.getSnapshot
  );
  const lifecycleRequest = lifecycleSnapshot.request?.surface === "editor" &&
    lifecycleSnapshot.request.participantId === lifecycle.participantId
      ? lifecycleSnapshot.request
      : undefined;

  function readProjectionState() {
    return adapterRef.current.read(lifecycleRef.current.handle);
  }

  function readLifecycleSession() {
    const session = lifecycleRef.current.readSession();
    if (!session) return undefined;
    const projectionState = readProjectionState();
    return {
      ...session,
      dirty: projectionState?.dirty ?? session.dirty
    };
  }

  function setCurrentProjection(state: ManuscriptSegmentProjectionSessionState) {
    setAttached({ key: productStateKey(propsRef.current), state });
  }

  async function runSave() {
    const state = readProjectionState();
    const currentProps = propsRef.current;
    if (
      !state || operationLockRef.current ||
      currentProps.disabled || currentProps.draftReadOnly || currentProps.saveDisabled
    ) {
      return false;
    }
    setLocalError("");
    setOrdinaryFeedback(undefined);
    setSaving(true);
    try {
      const saved = await adapterRef.current.save({
        runtimeHandle: lifecycleRef.current.handle,
        expectedProjectionGeneration: state.projectionGeneration
      });
      if (saved.projectionState) setCurrentProjection(saved.projectionState);
      const presentation = adapterRef.current.presentSaveResult(saved, {
        ownerType: descriptorRef.current.ownerType,
        channel: descriptorRef.current.channel
      });
      if (presentation.primaryFeedbackOwner === "shared-editor-operation-controller") {
        setOrdinaryFeedback({
          severity:
            presentation.terminal.terminalClass === "FAILURE_EXPECTED" ||
            presentation.terminal.terminalClass === "FAILURE_UNEXPECTED"
              ? "error"
              : "success",
          message: feedbackMessage(
            presentation,
            ui,
            currentProps.saveFailedLabel ?? ui("文稿保存失败。")
          )
        });
      }
      return presentation.terminal.terminalClass === "SUCCESS_CHANGED" ||
        presentation.terminal.terminalClass === "SUCCESS_NO_OP";
    } catch {
      setOrdinaryFeedback(undefined);
      setLocalError(currentProps.saveFailedLabel ?? ui("文稿保存失败。"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function runDiscard() {
    if (operationLockRef.current) {
      throw new Error("MANUSCRIPT_SEGMENT_OPERATION_ACTIVE");
    }
    const result = await adapterRef.current.discard(lifecycleRef.current.handle);
    if (result.status !== "success") throw new Error("MANUSCRIPT_SEGMENT_DISCARD_FAILED");
    if ("projectionState" in result && result.projectionState) {
      setCurrentProjection(result.projectionState);
    }
    setLocalError("");
    setOrdinaryFeedback(undefined);
  }

  async function buildCurrentDraftSnapshot() {
    const state = readProjectionState();
    if (!state) throw new Error("MANUSCRIPT_SEGMENT_DRAFT_SNAPSHOT_UNAVAILABLE");
    return adapterRef.current.buildDraftSnapshot({
      runtimeHandle: lifecycleRef.current.handle,
      expectedProjectionGeneration: state.projectionGeneration
    });
  }

  function presentInsertionResult(
    result: ReturnType<typeof executeManuscriptSegmentExplicitInsertion>
  ) {
    if (result.status === "SUCCESS_DIRTY") {
      setOrdinaryFeedback({ severity: "success", message: ui("已插入，尚未保存。") });
      setLocalError("");
      setFocusedTarget(undefined);
      return true;
    }
    setOrdinaryFeedback(undefined);
    setLocalError(result.status === "FAILURE_CONTROL_LINE_REJECTED"
      ? ui("插入内容包含保留的 Archive 控制行，未修改草稿。")
      : ui("当前文稿无法完成插入，草稿未修改。"));
    return false;
  }

  function insertMarkdown(
    markdown: string,
    explicitTargetId?: string,
    focusedTargetOverride?: ManuscriptSegmentFocusedTarget
  ) {
    const state = readProjectionState();
    if (!state || operationLockRef.current || editorMode !== "edit") return false;
    let appliedProjectionState: ManuscriptSegmentProjectionSessionState | undefined;
    const result = executeManuscriptSegmentExplicitInsertion({
      state,
      markdown,
      focusedTarget: focusedTargetOverride ?? focusedTarget,
      explicitTargetId,
      applyNextText: (request) => {
        const applied = adapterRef.current.applyNextText({
          runtimeHandle: lifecycleRef.current.handle,
          ...request
        });
        if ("projectionState" in applied && applied.projectionState) {
          appliedProjectionState = applied.projectionState;
          setCurrentProjection(applied.projectionState);
        }
        return applied;
      }
    });
    const succeeded = presentInsertionResult(result);
    if (succeeded && focusedTargetOverride && appliedProjectionState) {
      const caretOffset = result.status === "SUCCESS_DIRTY"
        ? result.caretAfter
        : focusedTargetOverride.selectionStart;
      setFocusRestoreRequest({
        requestId: `template-insert-${Date.now()}-${appliedProjectionState.projectionGeneration}`,
        target: {
          targetId: focusedTargetOverride.targetId,
          projectionGeneration: appliedProjectionState.projectionGeneration,
          selectionStart: caretOffset,
          selectionEnd: caretOffset
        }
      });
    }
    return succeeded;
  }

  async function openTemplateChooser() {
    if (
      propsRef.current.entryKind !== "current" ||
      operationLockRef.current ||
      editorMode !== "edit"
    ) return;
    const capability = resolveManuscriptSegmentProductCapability(
      descriptorRef.current,
      propsRef.current.entryKind
    );
    if (capability.template.applicability !== "SUPPORTED" || !capability.template.scope) {
      setLocalError(ui("此窗口不适用模板插入。"));
      return;
    }
    const state = readProjectionState();
    const session = lifecycleRef.current.readSession();
    const target = state && session
      ? captureManuscriptTemplateInsertionTarget({
          state,
          session,
          descriptorLookupIdentity: descriptorRef.current,
          entryKind: propsRef.current.entryKind,
          focusedTarget
        })
      : undefined;
    if (!target) {
      setOrdinaryFeedback(undefined);
      setLocalError(ui("请先在原文中定位插入位置。"));
      return;
    }
    setLocalError("");
    setOrdinaryFeedback(undefined);
    setTemplateWorkspace({
      scope: capability.template.scope,
      templates: queryMarkdownTemplates(capability.template.scope, language),
      target,
      managing: false
    });
  }

  function validateTemplateTarget(target: ManuscriptTemplateInsertionTarget) {
    const state = readProjectionState();
    const session = lifecycleRef.current.readSession();
    if (!state || !session) return undefined;
    return revalidateManuscriptTemplateInsertionTarget({
      target,
      state,
      session,
      descriptorLookupIdentity: descriptorRef.current,
      entryKind: propsRef.current.entryKind
    });
  }

  function closeTemplateWorkspace() {
    const workspace = templateWorkspace;
    setTemplateWorkspace(undefined);
    if (!workspace) return;
    const validation = validateTemplateTarget(workspace.target);
    if (!validation?.valid) return;
    setFocusRestoreRequest({
      requestId: `template-close-${Date.now()}-${workspace.target.capturedAtOperationId}`,
      target: validation.focusedTarget
    });
  }

  function insertTemplate(template: MarkdownTemplate) {
    const workspace = templateWorkspace;
    if (!workspace) return;
    const validation = validateTemplateTarget(workspace.target);
    if (!validation?.valid) {
      setTemplateWorkspace({
        ...workspace,
        targetInvalidMessage: ui("文稿或插入位置已变化，请关闭模板面板并重新定位。")
      });
      return;
    }
    if (insertMarkdown(template.body, undefined, validation.focusedTarget)) {
      setTemplateWorkspace(undefined);
    }
  }

  async function insertContextStructure() {
    const source = propsRef.current.contextInsertion;
    if (!source?.isAvailable || operationLockRef.current || editorMode !== "edit") return;
    setLockedOperation("insertion");
    setLocalError("");
    setOrdinaryFeedback(undefined);
    try {
      const markdown = await source.resolveMarkdown();
      setLockedOperation(undefined);
      insertMarkdown(markdown);
    } catch {
      setLocalError(ui("上下文摘要当前不可用，草稿未修改。"));
    } finally {
      setLockedOperation(undefined);
    }
  }

  async function enterPreview() {
    if (operationLockRef.current) return;
    setLockedOperation("preview");
    setLocalError("");
    setOrdinaryFeedback(undefined);
    setTemplateWorkspace(undefined);
    setFocusRestoreRequest(undefined);
    try {
      const snapshot = await buildCurrentDraftSnapshot();
      setPreviewSnapshot(snapshot);
      setEditorMode("preview");
      setFocusedTarget(undefined);
    } catch {
      setLocalError(ui("无法生成当前文稿预览，文稿内容未受影响。"));
    } finally {
      setLockedOperation(undefined);
    }
  }

  async function runFooterAction(action: ManuscriptSegmentEditorWindowAction) {
    if (operationLockRef.current) return;
    if (action.intent !== "save-as") {
      await action.onClick();
      return;
    }
    setLockedOperation("save-as");
    setLocalError("");
    try {
      const snapshot = await buildCurrentDraftSnapshot();
      await action.onClick(snapshot);
    } catch {
      setLocalError(ui("另存为未启动：无法冻结当前分段草稿。"));
    } finally {
      setLockedOperation(undefined);
    }
  }

  useEffect(() => {
    if (!isOpen || props.loading) return;
    setAttachError(false);
    setLocalError("");
    setOrdinaryFeedback(undefined);
    setEditorMode("edit");
    setPreviewSnapshot(undefined);
    setFocusedTarget(undefined);
    setTemplateWorkspace(undefined);
    setFocusRestoreRequest(undefined);
    try {
      const session = lifecycle.readSession();
      if (
        !session ||
        !isManuscriptSegmentProductIdentity(descriptorLookupIdentity) ||
        session.owner.ownerType !== descriptorLookupIdentity.ownerType ||
        session.owner.channel !== descriptorLookupIdentity.channel
      ) {
        throw new Error("MANUSCRIPT_SEGMENT_PRODUCT_IDENTITY_MISMATCH");
      }
      const existing = sessionAdapter.read(lifecycle.handle);
      const next = existing &&
        existing.sessionGeneration === session.sessionGeneration &&
        sameDescriptor(existing.descriptorLookupIdentity, descriptorLookupIdentity)
          ? existing
          : sessionAdapter.attach(lifecycle.handle, descriptorLookupIdentity);
      setAttached({ key: stateKey, state: next });
    } catch {
      setAttached(undefined);
      setAttachError(true);
    }
  }, [
    descriptorLookupIdentity.channel,
    descriptorLookupIdentity.ownerType,
    descriptorLookupIdentity.reviewType,
    isOpen,
    lifecycle.handle,
    lifecycle.presentationEpoch,
    props.contentIdentity,
    props.loading,
    sessionAdapter,
    stateKey
  ]);

  useEffect(() => {
    if (!isOpen || props.loading || attachError || !readProjectionState()) return undefined;
    const participant = {
      participantId: lifecycle.participantId,
      handle: lifecycle.handle,
      presentationEpoch: lifecycle.presentationEpoch,
      operationBlocked: () => Boolean(operationLockRef.current),
      readSession: readLifecycleSession,
      save: runSave,
      discard: runDiscard
    };
    let unregister: (() => void) | undefined;
    try {
      unregister = sharedEditorLifecycleController.register(participant);
      sharedEditorLifecycleController.markActive(lifecycle.participantId);
    } catch {
      setAttachError(true);
    }
    return unregister;
  }, [
    attached?.key,
    attachError,
    isOpen,
    lifecycle.handle,
    lifecycle.participantId,
    lifecycle.presentationEpoch,
    props.loading,
    stateKey
  ]);

  useEffect(() => () => {
    adapterRef.current.detach(lifecycleRef.current.handle);
  }, [lifecycle.handle, sessionAdapter]);

  if (!isOpen) return null;

  const session = lifecycle.readSession();
  const visibleTitle = resolveF3ManuscriptEditorWindowTitle(
    descriptorLookupIdentity,
    props.entryKind,
    ui
  );
  const entityLabel = resolveF3RightManuscriptTitle(props.entityTitle, ui);
  const currentFileName = session?.file.fileName?.trim() || ui("未选择");
  const footerActionsBySlot = new Map<ManuscriptEditorFooterActionSlot, ManuscriptSegmentEditorWindowAction>();
  for (const action of footerLeadingActions) {
    const slot = classifyF3FooterActionSlot(action, ui);
    if (slot && !footerActionsBySlot.has(slot)) footerActionsBySlot.set(slot, action);
  }
  const editorVariant = F3_MANUSCRIPT_EDITOR_VARIANT_REGISTRY[props.entryKind];
  const projectionState = attached?.key === stateKey ? attached.state : undefined;
  const capability = resolveManuscriptSegmentProductCapability(
    descriptorLookupIdentity,
    props.entryKind
  );
  const readOnly = Boolean(
    props.disabled ||
    props.draftReadOnly ||
    session?.accessMode === "read-only"
  );
  const visibleProjectionState = projectionState
    ? {
        ...projectionState,
        saveDisabled: projectionState.saveDisabled || readOnly
      }
    : undefined;
  const interactionDisabled = Boolean(
    props.disabled || props.loading || attachError || !visibleProjectionState || lifecycleRequest || operationLock
  );
  const finishClose = async (kind: "cancel" | "close") => {
    const callback = kind === "close" && propsRef.current.onClose
      ? propsRef.current.onClose
      : propsRef.current.onCancel;
    const result = await callback();
    if (result !== false) {
      adapterRef.current.detach(lifecycleRef.current.handle);
      setAttached(undefined);
    }
  };
  const requestClose = async (kind: "cancel" | "close", trigger: "top-close" | "footer-cancel" | "backdrop") => {
    if (saving || operationLockRef.current) return;
    const result = await sharedEditorLifecycleController.requestParticipant({
      participantId: lifecycle.participantId,
      trigger,
      continuationIntent: "CLOSE_EDITOR",
      surface: "editor",
      continuation: () => finishClose(kind)
    });
    if (result.status === "unavailable") await finishClose(kind);
  };
  const currentFooterSlots = [
    { slot: "open", label: ui("打开文稿") },
    { slot: "switch", label: ui("切换文稿") },
    { slot: "reload", label: ui("重新加载") },
    { slot: "save-as", label: ui("另存为") }
  ] as const;
  const independentFooterSlots = [
    { slot: "reload", label: ui("重新加载") },
    { slot: "save-as", label: ui("另存为") }
  ] as const;
  const fixedFooterSlots = props.entryKind === "current"
    ? currentFooterSlots
    : independentFooterSlots;

  return (
    <div
      className="markdown-editor-backdrop"
      role="presentation"
      data-manuscript-product-host="shared-segment"
      onPointerDownCapture={() => sharedEditorLifecycleController.markActive(lifecycle.participantId)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void requestClose("close", "backdrop");
      }}
    >
      <section
        className={`markdown-editor-window markdown-editor-modal manuscript-segment-editor-window manuscript-segment-editor-window--${props.entryKind}`}
        role="dialog"
        aria-modal="true"
        aria-label={visibleTitle}
        data-f3-ui-freeze-id={F3_MANUSCRIPT_EDITOR_UI_FREEZE.id}
        data-f3-ui-freeze-status={F3_MANUSCRIPT_EDITOR_UI_FREEZE.status}
        data-entry-kind={props.entryKind}
        data-editor-variant={editorVariant.id}
        style={F3_MANUSCRIPT_EDITOR_LAYOUT_CSS_VARIABLES as CSSProperties}
      >
        <header className="markdown-editor-header">
          <h2>{visibleTitle}</h2>
          <button
            type="button"
            className="markdown-editor-close"
            aria-label={ui("关闭")}
            disabled={saving || Boolean(operationLock)}
            onClick={() => void requestClose("close", "top-close")}
          >
            ×
          </button>
        </header>

        {props.recoveryRailContent || props.floatingFeedbackContent || ordinaryFeedback || localError ? (
          <div className="markdown-editor-floating-feedback" aria-live="polite">
            {props.recoveryRailContent}
            {props.floatingFeedbackContent}
            {ordinaryFeedback ? (
              <section
                className={`markdown-editor-local-feedback markdown-editor-local-feedback--${ordinaryFeedback.severity}`}
                role={ordinaryFeedback.severity === "error" ? "alert" : "status"}
              >
                <span>{ordinaryFeedback.message}</span>
                <button type="button" aria-label={ui("关闭")} onClick={() => setOrdinaryFeedback(undefined)}>×</button>
              </section>
            ) : null}
            {localError ? (
              <section className="markdown-editor-local-feedback markdown-editor-local-feedback--error" role="alert">
                <span>{localError}</span>
                <button type="button" aria-label={ui("关闭")} onClick={() => setLocalError("")}>×</button>
              </section>
            ) : null}
          </div>
        ) : null}

        <div className="markdown-editor-body" data-main-column-count={editorVariant.columnCount}>
          {editorVariant.showStructuredSummary ? (
            <aside className="markdown-editor-sidebar" aria-label={ui("结构化纲要")}>
              <h3>{ui("结构化纲要")}</h3>
              <dl>
                {readonlyContextItems.map((item) => (
                  <div key={`${item.label}:${item.value}`}>
                    <dt>{item.label}</dt>
                    <dd>{resolveF3StructuredSummaryValue(item.value, ui)}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          ) : null}
          <div className="markdown-editor-main">
            <div className="manuscript-segment-product-toolbar">
              <div className="manuscript-segment-product-toolbar__title-row">
                <strong className="markdown-editor-entity-title">{entityLabel}</strong>
                <div className="markdown-editor-mode-toggle" aria-label={ui("原文与预览")}>
                  <button
                    aria-pressed={editorMode === "edit"}
                    className={editorMode === "edit" ? "active" : undefined}
                    disabled={Boolean(operationLock)}
                    onClick={() => setEditorMode("edit")}
                    type="button"
                  >
                    {ui("原文")}
                  </button>
                  <button
                    aria-pressed={editorMode === "preview"}
                    className={editorMode === "preview" ? "active" : undefined}
                    disabled={interactionDisabled || editorMode === "preview"}
                    onClick={() => void enterPreview()}
                    type="button"
                  >
                    {operationLock === "preview" ? ui("正在生成预览…") : ui("预览")}
                  </button>
                </div>
              </div>
              {props.entryKind === "current" ? (
              <div className="manuscript-segment-product-toolbar__action-row">
                <button
                  disabled={
                    capability.template.applicability !== "SUPPORTED" ||
                    interactionDisabled || readOnly || editorMode === "preview"
                  }
                  onClick={() => void openTemplateChooser()}
                   title={capability.template.applicability === "SUPPORTED"
                    ? undefined
                    : ui("此窗口不适用模板插入。")}
                  type="button"
                >
                  {ui("插入模板")}
                </button>
                <button
                  disabled={
                    capability.contextStructure.applicability !== "SUPPORTED" ||
                    interactionDisabled || readOnly || editorMode === "preview" ||
                    !props.contextInsertion?.isAvailable
                  }
                  onClick={() => void insertContextStructure()}
                  title={capability.contextStructure.applicability !== "SUPPORTED"
                    ? ui("此窗口不适用上下文摘要。")
                    : props.contextInsertion?.isAvailable
                      ? undefined
                      : props.contextInsertion?.unavailableReason ?? ui("当前上下文摘要不可用")}
                  type="button"
                >
                  {ui("插入上下文摘要")}
                </button>
              </div>
              ) : null}
            </div>
            {props.loading || !projectionState ? (
              <section role={attachError ? "alert" : "status"} className="manuscript-segment-product-state">
                {attachError
                  ? ui("当前文稿暂时不可用，草稿未被覆盖。")
                  : ui("正在加载文稿…")}
              </section>
            ) : editorMode === "preview" ? (
              <ManuscriptSegmentPreview
                descriptorLookupIdentity={descriptorLookupIdentity}
                markdown={previewSnapshot?.markerFreePreviewMarkdown ?? ""}
                labels={{
                  empty: ui("当前文稿没有可预览的正文。"),
                  ariaLabel: ui("当前文稿预览"),
                  image: ui("图片"),
                  structuredOutline: ui("结构化纲要"),
                  archiveHint: ui("此区域作为文稿切换的可读区域，请勿修改格式。"),
                  emptyValue: ui("未填写")
                }}
              />
            ) : (
              <ManuscriptSegmentEditor
                focusRestoreRequest={focusRestoreRequest}
                interactionDisabled={interactionDisabled || readOnly}
                labels={{
                  projectionUnavailable: ui("文稿投影视图不可用。"),
                  structuredOutline: ui("结构化纲要"),
                  startWriting: ui("开始撰写文稿"),
                  ariaLabel: ui("文稿原文")
                }}
                projectionState={visibleProjectionState!}
                onEdit={(request) => {
                  if (readOnly || operationLockRef.current) {
                    return { accepted: false, reason: "PROJECTION_NOT_WRITABLE" };
                  }
                  const result = adapterRef.current.applyNextText({
                    runtimeHandle: lifecycleRef.current.handle,
                    ...request
                  });
                  if ("projectionState" in result && result.projectionState) {
                    setCurrentProjection(result.projectionState);
                  }
                  setLocalError("");
                  setOrdinaryFeedback(undefined);
                  return result;
                }}
                onFocusTarget={setFocusedTarget}
                onRejectedEvent={() => setLocalError(ui("当前操作无法安全完成，草稿未修改。"))}
              />
            )}
            {templateWorkspace && props.entryKind === "current" ? (
              <ManuscriptTemplateWorkspacePanel
                managing={templateWorkspace.managing}
                onClose={closeTemplateWorkspace}
                onInsert={insertTemplate}
                onManagingChange={(managing) => setTemplateWorkspace((current) => current
                  ? { ...current, managing }
                  : current)}
                onTemplatesChanged={() => setTemplateWorkspace((current) => current
                  ? {
                      ...current,
                      templates: queryMarkdownTemplates(current.scope, language)
                    }
                  : current)}
                scope={templateWorkspace.scope}
                targetInvalidMessage={templateWorkspace.targetInvalidMessage}
                templates={templateWorkspace.templates}
              />
            ) : null}
          </div>
        </div>

        {lifecycleRequest ? (
          <SharedEditorLifecycleDecisionDialog
            request={lifecycleRequest}
            title={props.unsavedChangesTitle ?? ui("当前文稿有未保存更改")}
            message={props.unsavedChangesLabel ?? ui("关闭前，请选择保存更改、放弃更改或取消关闭。")}
            saveLabel={props.saveChangesLabel ?? ui("保存并关闭")}
            discardLabel={props.discardChangesLabel ?? ui("放弃更改")}
            cancelLabel={props.continueEditingLabel ?? ui("取消")}
            savingLabel={props.savingLabel ?? ui("正在保存…")}
            onSave={() => void sharedEditorLifecycleController.resolve(lifecycleRequest.requestToken, "save")}
            onDiscard={() => void sharedEditorLifecycleController.resolve(lifecycleRequest.requestToken, "discard")}
            onCancel={() => void sharedEditorLifecycleController.resolve(lifecycleRequest.requestToken, "cancel")}
          />
        ) : null}

        <footer className="markdown-editor-footer">
          {editorVariant.showCurrentManuscript ? (
            <div className="markdown-editor-current-manuscript">
              <span>{ui("当前文稿：")}</span>
              <strong title={currentFileName}>{currentFileName}</strong>
            </div>
          ) : null}
          <div className="markdown-editor-footer-actions">
            {fixedFooterSlots.map(({ slot, label }) => {
              const action = footerActionsBySlot.get(slot);
              return (
                <button
                  data-footer-slot={slot}
                  disabled={!action || interactionDisabled || action.disabled}
                  key={slot}
                  onClick={() => action ? void runFooterAction(action) : undefined}
                  title={!action
                      ? ui("此操作当前不可用")
                      : undefined}
                  type="button"
                >
                  {label}
                </button>
              );
            })}
            <button
              type="button"
              className="markdown-editor-save-record"
              data-footer-slot="save"
              disabled={interactionDisabled || readOnly || props.saveDisabled || visibleProjectionState?.saveDisabled}
              onClick={() => void runSave()}
            >
              {saving ? ui("正在保存…") : ui("保存文稿")}
            </button>
            <button
              type="button"
              data-footer-slot="cancel"
              disabled={saving || Boolean(operationLock)}
              onClick={() => void requestClose("cancel", "footer-cancel")}
            >
              {ui("取消")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export default ManuscriptSegmentEditorWindow;
