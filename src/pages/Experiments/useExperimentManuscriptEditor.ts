import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimentManuscriptSwitchService
} from "../../services/experimentManuscriptSwitchService";
import {
  experimentCurrentRawManuscriptService
} from "../../services/experimentCurrentRawManuscriptService";
import {
  experimentIndependentRawManuscriptService
} from "../../services/experimentIndependentRawManuscriptService";
import {
  independentManuscriptOpenProtocol,
  type IndependentOpenActivationResult,
  type IndependentOpenProductAdapter,
  type IndependentManuscriptOpenProtocol,
  resolveIndependentOpenConsumerCleanup
} from "../../services/independentManuscriptOpenProtocol";
import {
  createIndependentOpenPreviewProvider
} from "../../services/independentManuscriptOpenPreviewProvider";
import {
  experimentManuscriptSelectionService
} from "../../services/experimentManuscriptSelectionService";
import { isPathWithinDirectory } from "../../services/managedPathService";
import {
  experimentEditorContextSummaryService,
  serializeExperimentEditorContextSummary
} from "../../services/experimentEditorContextSummaryService";
import {
  experimentManuscriptSaveAsAdapter
} from "../../services/experimentManuscriptSaveAsAdapter";
import type { SaveAsPresentationPermit } from "../../services/manuscriptSaveAsPresentationProtocol";
import { windowPContainmentFeedbackMessage } from "../../services/manuscriptSaveAsWindowPContainment";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";
import { ordinarySavePresentation } from "../../services/ordinaryOperationPresentation";
import { buildFormalSwitchConfirmationCopy, isOrdinaryFormalSwitchFeedback, isSilentFormalSwitchFeedback, projectFormalSwitchFailure } from "../../services/manuscriptFormalSwitchPresentation";
import type { ExperimentRating } from "../../types/experiment";
import type {
  ExperimentFormalSwitchRecoverySummary,
  ExperimentManuscriptSwitchError
} from "../../types/experimentManuscriptSwitch";
import type {
  ManuscriptPipelineFailure
} from "../../types/manuscriptOperation";
import type {
  SharedManuscriptSessionHandle
} from "../../types/sharedManuscriptSession";
import type { ManuscriptSegmentDraftSnapshot } from "../../types/manuscriptSegmentProjection";

type FeedbackSeverity = "success" | "warning" | "error" | "info";
type ChoiceValue = "save" | "discard" | "cancel" | "confirm";
type EditorWindowRole = "current" | "independent";

export interface ExperimentManuscriptActionResult {
  severity: FeedbackSeverity;
  action: "open" | "switch" | "save" | "reload" | "session";
  message: string;
  targetFileName?: string;
  dismissible: true;
  scope: {
    ownerType: "experiment";
    ownerId?: string;
    manuscriptChannel: "primary";
    windowRole: EditorWindowRole;
    sessionIdentity?: SharedManuscriptSessionHandle;
    operationKind: string;
    requestGeneration: number;
  };
}

export interface ExperimentManuscriptChoiceDialog {
  kind:
    | "external-registration"
    | "external-write"
    | "formal-switch";
  title: string;
  message: string;
  options: Array<{
    value: ChoiceValue;
    label: string;
    emphasis?: "primary" | "danger";
  }>;
}

export interface UseExperimentManuscriptEditorInput {
  experimentId?: string;
  ui(source: string): string;
  ratingLabel?(rating: ExperimentRating): string | null;
  onFeedback?(
    severity: FeedbackSeverity,
    message: string,
    operation: string
  ): void;
  service?: typeof experimentManuscriptSwitchService;
  currentService?: typeof experimentCurrentRawManuscriptService;
  independentService?: typeof experimentIndependentRawManuscriptService;
  editorContextSummaryService?: typeof experimentEditorContextSummaryService;
  saveAsService?: typeof experimentManuscriptSaveAsAdapter;
  independentOpenProtocol?: IndependentManuscriptOpenProtocol;
  independentOpenPreviewProvider?: ReturnType<
    typeof createIndependentOpenPreviewProvider
  >;
}

function resultMessage(result: unknown, fallback: string) {
  if (result && typeof result === "object") {
    const record = result as {
      message?: unknown;
      error?: {
        message?: unknown;
      };
    };
    const candidates = [record.message, record.error?.message];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && isSafeUserMessage(candidate)) {
        return candidate;
      }
    }
  }
  return fallback;
}

function isSafeUserMessage(message: string) {
  const normalized = message.trim();
  return Boolean(normalized) &&
    !/[A-Z][A-Z0-9_]{3,}/u.test(normalized) &&
    !/(?:[A-Za-z]:[\\/]|\\\\|operationId|reason\s*code|stack|SQL|SELECT\s|INSERT\s|UPDATE\s|DELETE\s|阶段\s*:|错误码|原因码|操作号|恢复建议|restart-required)/iu.test(normalized);
}

function resultCode(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const record = result as {
    code?: unknown;
    errorCode?: unknown;
    error?: { code?: unknown; errorCode?: unknown };
  };
  if (typeof record.code === "string") return record.code;
  if (typeof record.errorCode === "string") return record.errorCode;
  if (typeof record.error?.code === "string") return record.error.code;
  if (typeof record.error?.errorCode === "string") {
    return record.error.errorCode;
  }
  return "";
}

function pipelineFailureFromResult(
  result: unknown
): ManuscriptPipelineFailure | undefined {
  if (!result || typeof result !== "object") return undefined;
  const error = (result as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const record = error as Partial<ManuscriptPipelineFailure>;
  return typeof record.operation === "string" &&
    typeof record.stage === "string" &&
    typeof record.errorCode === "string" &&
    typeof record.recoverability === "string" &&
    typeof record.operationId === "string"
    ? (record as ManuscriptPipelineFailure)
    : undefined;
}

function formalSwitchFailureFromResult(
  result: unknown
): ExperimentManuscriptSwitchError | undefined {
  if (!result || typeof result !== "object") return undefined;
  const error = (result as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const record = error as Partial<ExperimentManuscriptSwitchError>;
  return typeof record.stage === "string" &&
    typeof record.errorCode === "string" &&
    typeof record.causeCode === "string" &&
    typeof record.recoverability === "string" &&
    typeof record.operationId === "string"
    ? (record as ExperimentManuscriptSwitchError)
    : undefined;
}

function isInvalidManuscriptCode(code: string) {
  return /(?:INVALID|FORMAT|PARSE|BLOCK|META|OWNER_MISMATCH|DOCUMENT)/u.test(code);
}

function recoveryMatchesCurrentWindow(input: {
  recovery?: ExperimentFormalSwitchRecoverySummary;
  experimentId?: string;
  currentFileRefId?: string;
}) {
  const { recovery, experimentId, currentFileRefId } = input;
  if (
    !recovery ||
    recovery.operationKind !== "formal-switch" ||
    recovery.experimentId !== experimentId ||
    !currentFileRefId
  ) return false;
  const phase = String(recovery.phase);
  if (["prepared", "writeback_unknown", "writeback_applied", "db_commit_unknown", "blocked"].includes(phase)) {
    return recovery.oldCurrentFileRefId === currentFileRefId;
  }
  if (["db_committed", "activation_pending"].includes(phase)) {
    return recovery.targetFileRefId === currentFileRefId;
  }
  return recovery.oldCurrentFileRefId === currentFileRefId ||
    recovery.targetFileRefId === currentFileRefId;
}

export function useExperimentManuscriptEditor(
  input: UseExperimentManuscriptEditorInput
) {
  const service = input.service ?? experimentManuscriptSwitchService;
  const currentService =
    input.currentService ?? experimentCurrentRawManuscriptService;
  const independentService =
    input.independentService ?? experimentIndependentRawManuscriptService;
  const editorContextSummaryService =
    input.editorContextSummaryService ?? experimentEditorContextSummaryService;
  const saveAsService =
    input.saveAsService ?? experimentManuscriptSaveAsAdapter;
  const openProtocol =
    input.independentOpenProtocol ?? independentManuscriptOpenProtocol;
  const [mainSessionKey, setMainSessionKey] =
    useState<SharedManuscriptSessionHandle>();
  const [independentSessionKey, setIndependentSessionKey] =
    useState<SharedManuscriptSessionHandle>();
  const [mainOpen, setMainOpen] = useState(false);
  const [independentOpen, setIndependentOpen] = useState(false);
  const [currentBusy, setCurrentBusy] = useState(false);
  const [independentBusy, setIndependentBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessionRevision, setSessionRevision] = useState(0);
  const [mainPresentationEpoch, setMainPresentationEpoch] = useState(0);
  const [independentPresentationEpoch, setIndependentPresentationEpoch] = useState(0);
  const [choiceDialog, setChoiceDialog] = useState<ExperimentManuscriptChoiceDialog | null>(null);
  const [currentActionResult, setCurrentActionResult] =
    useState<ExperimentManuscriptActionResult | null>(null);
  const [independentActionResult, setIndependentActionResult] =
    useState<ExperimentManuscriptActionResult | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string>();
  const [currentFileRefId, setCurrentFileRefId] = useState<string>();
  const [currentDescriptorError, setCurrentDescriptorError] = useState("");
  const [switchRecovery, setSwitchRecovery] =
    useState<ExperimentFormalSwitchRecoverySummary>();
  const choiceResolver = useRef<((choice: ChoiceValue | null) => void) | null>(null);
  const requestCounter = useRef(0);
  const currentActionRequestCounter = useRef(0);
  const independentActionRequestCounter = useRef(0);
  const currentBusyRef = useRef(false);
  const independentBusyRef = useRef(false);
  const descriptorRequestCounter = useRef(0);
  const ownerIdRef = useRef(input.experimentId);
  const saveAsPresentedSessionKeyRef = useRef<SharedManuscriptSessionHandle>();

  const mainSession = useMemo(
    () => (mainSessionKey ? currentService.getSession(mainSessionKey) : undefined),
    [mainSessionKey, currentService, sessionRevision]
  );
  const independentSession = useMemo(
    () =>
      independentSessionKey
        ? independentService.getSession(independentSessionKey)
        : undefined,
    [independentSessionKey, independentService, sessionRevision]
  );
  const currentSwitchRecovery = useMemo(
    () => recoveryMatchesCurrentWindow({
      recovery: switchRecovery,
      experimentId: input.experimentId,
      currentFileRefId
    }) ? switchRecovery : undefined,
    [currentFileRefId, input.experimentId, switchRecovery]
  );

  function refreshSessions() {
    setSessionRevision((current) => current + 1);
  }

  function acknowledgeSaveAsPresentation(
    permit: SaveAsPresentationPermit,
    experimentId: string,
    isFresh: () => boolean
  ) {
    const session = independentService.getSession(permit.runtime.handle);
    if (
      !isFresh() ||
      !session ||
      session.logicalIdentity.ownerType !== "experiment" ||
      session.logicalIdentity.ownerId !== experimentId ||
      session.logicalIdentity.channel !== "primary" ||
      session.logicalIdentity.windowRole !== "independent" ||
      session.logicalIdentity.fileRefId !== permit.targetFileRefId ||
      session.file.kind !== "durable" ||
      session.file.fileRefId !== permit.targetFileRefId
    ) {
      return false;
    }
    saveAsPresentedSessionKeyRef.current = permit.runtime.handle;
    setIndependentSessionKey(permit.runtime.handle);
    setIndependentOpen(true);
    setIndependentPresentationEpoch((current) => current + 1);
    clearActionResult("independent");
    refreshSessions();
    return true;
  }

  function feedback(
    severity: FeedbackSeverity,
    message: string,
    operation: string
  ) {
    input.onFeedback?.(severity, message, operation);
  }

  function showActionResult(
    severity: FeedbackSeverity,
    action: ExperimentManuscriptActionResult["action"],
    message: string,
    operation: string,
    targetFileName?: string,
    windowRole: EditorWindowRole = "current"
  ) {
    if (isSilentFormalSwitchFeedback(operation, severity)) {
      clearActionResult(windowRole);
      feedback(severity, message, operation);
      return;
    }
    const ordinarySwitch = isOrdinaryFormalSwitchFeedback(operation);
    if (ordinarySwitch && !(windowRole === "current" ? mainOpen : independentOpen)) {
      clearActionResult(windowRole);
      feedback(severity, message, operation);
      return;
    }
    const result = {
      severity,
      action,
      message,
      ...(targetFileName ? { targetFileName } : {}),
      dismissible: true as const,
      scope: {
        ownerType: "experiment" as const,
        ownerId: input.experimentId,
        manuscriptChannel: "primary" as const,
        windowRole,
        sessionIdentity:
          windowRole === "current" ? mainSessionKey : independentSessionKey,
        operationKind: operation,
        requestGeneration:
          windowRole === "current"
            ? currentActionRequestCounter.current
            : independentActionRequestCounter.current
      }
    };
    if (windowRole === "current") setCurrentActionResult(result);
    else setIndependentActionResult(result);
    if (!ordinarySwitch) feedback(severity, message, operation);
  }

  function clearActionResult(windowRole: EditorWindowRole = "current") {
    if (windowRole === "current") setCurrentActionResult(null);
    else setIndependentActionResult(null);
  }

  async function resolveContextSummaryMarkdown() {
    if (!input.experimentId) {
      throw new Error(input.ui("当前实验不可用，无法插入上下文摘要。"));
    }
    const summaryResult = await editorContextSummaryService.read(
      input.experimentId,
      input.ratingLabel ?? (() => null)
    );
    if (summaryResult.status !== "success") {
      throw new Error(input.ui("实验上下文摘要生成失败。"));
    }
    return serializeExperimentEditorContextSummary(summaryResult.dto);
  }

  function actionErrorMessage(
    result: unknown,
    fallback: string,
    invalidFallback = input.ui(
      "所选文件不是有效的 Experiment 文稿，未执行打开或切换。"
    )
  ) {
    const code = resultCode(result);
    if (code === "EXPERIMENT_MANUSCRIPT_TARGET_IS_CURRENT") {
      return input.ui("所选文件已是当前文稿。");
    }
    if (isInvalidManuscriptCode(code)) {
      return invalidFallback;
    }
    return fallback;
  }

  function pipelineErrorMessage(result: unknown, fallback: string) {
    const pipeline = pipelineFailureFromResult(result);
    if (!pipeline) return actionErrorMessage(result, fallback);
    const stageMessage: Record<ManuscriptPipelineFailure["stage"], string> = {
      selection: input.ui("无法选择所需的 Markdown 文稿。"),
      workspace: input.ui("实验文稿工作区无法安全使用。"),
      read: input.ui("无法读取所选 Markdown 文稿。"),
      lookup: input.ui("无法查询所选文稿的登记信息。"),
      registration: input.ui("实验文稿登记失败。"),
      "durable-identity": input.ui("实验文稿身份校验失败。"),
      rekey: input.ui("实验文稿会话迁移失败。"),
      activation: input.ui("实验文稿会话无法激活。"),
      preflight: input.ui("实验文稿切换预检失败。")
    };
    return stageMessage[pipeline.stage] ?? fallback;
  }

  function baseFormalSwitchErrorMessage(result: unknown, fallback: string) {
    const failure = formalSwitchFailureFromResult(result);
    if (!failure) return actionErrorMessage(result, fallback);
    if (/SESSION_(?:MISSING|UNAVAILABLE|REPLACED)|RUNTIME_IDENTITY/u.test(failure.causeCode)) {
      return input.ui("文稿运行会话已不可用或已被替换，请重新打开当前稿和目标稿后再试。");
    }
    if (/DIRTY/u.test(failure.causeCode)) {
      return input.ui("当前稿或目标稿仍有未保存修改，请先保存或放弃修改后再试。");
    }
    if (/ACTIVE_OPERATION|OPERATION_IN_PROGRESS|RESOURCE_BUSY/u.test(failure.causeCode)) {
      return input.ui("另一项文稿操作仍在进行，请等待完成后再试。");
    }
    if (/BASELINE_MISSING/u.test(failure.causeCode)) {
      return input.ui("无法确认当前稿或目标稿的文件基线，请重新加载后再试。");
    }
    if (/REVISION|PHYSICAL/u.test(failure.causeCode)) {
      return input.ui("当前稿或目标稿的文件状态已变化，请重新加载并确认后再试。");
    }
    if (
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_IN_PROGRESS" ||
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_RECOVERY_REQUIRED"
    ) {
      return input.ui("当前存在尚未完成的文稿切换，请先完成恢复处理。");
    }
    if (
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_OWNER_CHANGED" ||
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_CURRENT_CHANGED" ||
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_DEFAULT_CHANGED" ||
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_TARGET_CHANGED" ||
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_TOKEN_EXPIRED" ||
      failure.errorCode === "EXPERIMENT_FORMAL_SWITCH_TOKEN_USED"
    ) {
      return input.ui("当前文稿状态已变化，请重新加载后再试。");
    }
    return fallback;
  }

  function formalSwitchErrorMessage(result: unknown, fallback: string) {
    return baseFormalSwitchErrorMessage(result, fallback);
  }

  function beginBusyAction(windowRole: EditorWindowRole = "current") {
    const busyRef = windowRole === "current" ? currentBusyRef : independentBusyRef;
    if (busyRef.current) return null;
    busyRef.current = true;
    if (windowRole === "current") setCurrentBusy(true);
    else setIndependentBusy(true);
    const counter = windowRole === "current"
      ? currentActionRequestCounter
      : independentActionRequestCounter;
    const actionRequestId = ++counter.current;
    return {
      actionRequestId,
      ownerId: input.experimentId,
      windowRole,
      sessionIdentity:
        windowRole === "current" ? mainSessionKey : independentSessionKey
    };
  }

  function isCurrentAction(action: {
    actionRequestId: number;
    ownerId?: string;
    windowRole: EditorWindowRole;
    sessionIdentity?: SharedManuscriptSessionHandle;
  }) {
    const counter = action.windowRole === "current"
      ? currentActionRequestCounter
      : independentActionRequestCounter;
    return (
      action.actionRequestId === counter.current &&
      action.ownerId === input.experimentId
    );
  }

  function finishBusyAction(action: {
    actionRequestId: number;
    ownerId?: string;
    windowRole: EditorWindowRole;
    sessionIdentity?: SharedManuscriptSessionHandle;
  }) {
    if (!isCurrentAction(action)) return;
    if (action.windowRole === "current") {
      currentBusyRef.current = false;
      setCurrentBusy(false);
    } else {
      independentBusyRef.current = false;
      setIndependentBusy(false);
    }
  }

  function invalidateBusyAction(windowRole?: EditorWindowRole) {
    if (!windowRole || windowRole === "current") {
      currentActionRequestCounter.current += 1;
      currentBusyRef.current = false;
      setCurrentBusy(false);
    }
    if (!windowRole || windowRole === "independent") {
      independentActionRequestCounter.current += 1;
      independentBusyRef.current = false;
      setIndependentBusy(false);
    }
  }

  function requestChoice(dialog: ExperimentManuscriptChoiceDialog) {
    choiceResolver.current?.(null);
    setChoiceDialog(dialog);
    return new Promise<ChoiceValue | null>((resolve) => {
      choiceResolver.current = resolve;
    });
  }

  function resolveChoice(choice: ChoiceValue | null) {
    const resolve = choiceResolver.current;
    choiceResolver.current = null;
    setChoiceDialog(null);
    resolve?.(choice);
  }

  async function loadCurrentDescriptor(experimentId = input.experimentId) {
    const requestId = ++descriptorRequestCounter.current;
    setCurrentFileName(undefined);
    setCurrentFileRefId(undefined);
    setCurrentDescriptorError("");
    if (!experimentId) return false;
    const result = await currentService.resolveCurrentDescriptor(experimentId);
    if (requestId !== descriptorRequestCounter.current) return false;
    if (result.status !== "success") {
      setCurrentDescriptorError(
        resultMessage(result, input.ui("当前实验文稿信息无法读取。"))
      );
      return false;
    }
    setCurrentFileName(result.fileName);
    setCurrentFileRefId(result.currentFileRefId);
    return true;
  }

  useEffect(() => {
    let disposed = false;
    void loadCurrentDescriptor();
    if (input.experimentId && service.listRecoveries) {
      const experimentId = input.experimentId;
      void service.listRecoveries(experimentId).then((recoveries) => {
        if (disposed || ownerIdRef.current !== experimentId) return;
        setSwitchRecovery(recoveries[0]);
      }).catch(() => {
        if (disposed || ownerIdRef.current !== experimentId) return;
        setSwitchRecovery(undefined);
      });
    } else {
      setSwitchRecovery(undefined);
    }
    if (input.experimentId && saveAsService.listUnresolved) {
      const experimentId = input.experimentId;
      void saveAsService.listUnresolved(experimentId).then(async (operations) => {
        for (const operation of operations) {
          if (disposed) return;
          saveAsPresentedSessionKeyRef.current = undefined;
          const recovered = await saveAsService.recover(
            operation.operationId,
            experimentId,
            (permit) =>
              acknowledgeSaveAsPresentation(
                permit,
                experimentId,
                () => !disposed && ownerIdRef.current === experimentId
              )
          );
          if (disposed) return;
          if (recovered.status === "contained") {
            const message = input.ui(
              windowPContainmentFeedbackMessage(recovered.blockingCode)
            );
            setError(message);
            showActionResult(
              "warning",
              "save",
              message,
              "experiment.manuscript.saveAsRecovery",
              undefined,
              "current"
            );
            continue;
          }
          if (recovered.status === "success") {
            showActionResult(
              "success",
              "save",
              input.ui("未完成的另存为操作已恢复，副本已在独立编辑器中打开。"),
              "experiment.manuscript.saveAsRecovery",
              recovered.targetFileName,
              "independent"
            );
          } else {
            const message = saveAsFailureMessage(recovered);
            setError(message);
            showActionResult(
              "warning",
              "save",
              message,
              "experiment.manuscript.saveAsRecovery",
              undefined,
              "current"
            );
            return;
          }
        }
      }).catch(() => {
        if (disposed) return;
        const message = input.ui("另存为恢复状态读取失败；新的另存为与正式切换将保持阻断。 ");
        setError(message);
        feedback("warning", message, "experiment.manuscript.saveAsRecovery");
      });
    }
    return () => {
      disposed = true;
      descriptorRequestCounter.current += 1;
    };
  }, [currentService, input.experimentId]);

  useEffect(() => {
    if (ownerIdRef.current === input.experimentId) return;
    const previousOwnerId = ownerIdRef.current;
    if (previousOwnerId) {
      openProtocol.cancelOwner({
        ownerType: "experiment",
        ownerId: previousOwnerId,
        channel: "primary"
      });
    }
    ownerIdRef.current = input.experimentId;
    saveAsPresentedSessionKeyRef.current = undefined;
    if (mainSessionKey) currentService.cancel(mainSessionKey);
    if (independentSessionKey) {
      void independentService.requestClose(independentSessionKey, "discard");
    }
    choiceResolver.current?.(null);
    choiceResolver.current = null;
    setChoiceDialog(null);
    setMainOpen(false);
    setIndependentOpen(false);
    setMainSessionKey(undefined);
    setIndependentSessionKey(undefined);
    setError("");
    setCurrentActionResult(null);
    setIndependentActionResult(null);
    setSwitchRecovery(undefined);
    invalidateBusyAction();
  }, [currentService, independentService, input.experimentId]);

  useEffect(() => {
    if (!choiceDialog) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") resolveChoice(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [choiceDialog]);

  useEffect(
    () => () => {
      choiceResolver.current?.(null);
      choiceResolver.current = null;
      currentActionRequestCounter.current += 1;
      independentActionRequestCounter.current += 1;
      if (ownerIdRef.current) {
        openProtocol.cancelOwner({
          ownerType: "experiment",
          ownerId: ownerIdRef.current,
          channel: "primary"
        });
      }
      currentBusyRef.current = false;
      independentBusyRef.current = false;
    },
    [independentService]
  );

  async function openCurrent() {
    if (!input.experimentId) return false;
    const action = beginBusyAction();
    if (!action) return false;
    setError("");
    try {
      const result = await currentService.openCurrent(input.experimentId);
      if (!isCurrentAction(action)) return false;
      if (result.status !== "success" || !("sessionKey" in result)) {
        const message = resultMessage(result, input.ui("实验文稿无法打开。"));
        setError(message);
        feedback("error", message, "experiment.manuscript.openCurrent");
        return false;
      }
      setMainSessionKey(result.sessionKey);
      setMainOpen(true);
      setMainPresentationEpoch((current) => current + 1);
      refreshSessions();
      await loadCurrentDescriptor(input.experimentId);
      return true;
    } finally {
      finishBusyAction(action);
    }
  }

  function updateIndependentDraft(
    sessionKey: SharedManuscriptSessionHandle | undefined,
    rawText: string
  ) {
    if (!sessionKey) return;
    const result = independentService.updateDraft(sessionKey, rawText);
    if (result.status === "success") {
      refreshSessions();
      return;
    }
    const message = resultMessage(result, input.ui("文稿草稿无法更新。"));
    setError(message);
    feedback("error", message, "experiment.manuscript.patchDraft");
  }

  function updateCurrentDraft(rawText: string) {
    if (!mainSessionKey) return;
    const result = currentService.updateDraft(mainSessionKey, rawText);
    if (result.status === "success") {
      refreshSessions();
      return;
    }
    const message = resultMessage(result, input.ui("文稿草稿无法更新。"));
    setError(message);
    feedback("error", message, "experiment.manuscript.patchRawDraft");
  }

  async function executeIndependentSave(
    sessionKey: SharedManuscriptSessionHandle,
  ) {
    let result = await independentService.save(sessionKey);
    if (result.status === "confirmation-required" && result.reason === "external-write") {
      const confirmed = await requestChoice({
        kind: "external-write",
        title: input.ui("确认保存外部文稿"),
        message: input.ui("该操作将直接更新原位置的外部 Markdown 文件，不创建副本，也不会改变当前稿或默认稿。是否继续？"),
        options: [
          { value: "confirm", label: input.ui("确认保存"), emphasis: "primary" },
          { value: "cancel", label: input.ui("取消") }
        ]
      });
      if (confirmed !== "confirm") return undefined;
      result = await independentService.save(sessionKey, {
        confirmedExternalWrite: true
      });
    }
    return result;
  }

  async function saveIndependentSession(
    sessionKey: SharedManuscriptSessionHandle
  ) {
    const result = await executeIndependentSave(sessionKey);
    if (!result) return false;
    const accepted = result.status === "success" || result.status === "no-op";
    if (accepted) refreshSessions();
    return accepted;
  }

  async function saveCurrent(markdown: string) {
    if (!mainSessionKey) throw new Error(input.ui("当前实验文稿尚未打开。"));
    clearActionResult("current");
    setError("");
    updateCurrentDraft(markdown);
    const result = await currentService.save(mainSessionKey);
    if (result.status === "success" || result.status === "no-op") {
      setError("");
      refreshSessions();
    }
    return ordinarySavePresentation(
      result,
      { ownerType: "experiment", channel: "primary", ownerLabel: input.ui("实验") }
    );
  }

  function saveAsFailureMessage(result: unknown) {
    const record = result && typeof result === "object"
      ? (result as {
          status?: unknown;
          error?: {
            stage?: unknown;
            code?: unknown;
            errorCode?: unknown;
            causeCode?: unknown;
          };
        })
      : undefined;
    const errorCode = typeof record?.error?.code === "string"
      ? record.error.code
      : typeof record?.error?.errorCode === "string"
        ? record.error.errorCode
      : "EXPERIMENT_SAVE_AS_FAILED";
    return errorCode === "EXPERIMENT_SAVE_AS_SOURCE_TARGET_SAME"
      ? input.ui("请选择不同的保存位置；保存原文件请使用“保存文稿”。")
      : errorCode === "EXPERIMENT_SAVE_AS_TARGET_EXISTS"
        ? input.ui("目标文件已存在，请选择新的文件名或路径。")
      : errorCode === "EXPERIMENT_SAVE_AS_TARGET_REVISION_CONFLICT"
        ? input.ui("目标文件在确认后发生变化，请重新选择保存位置。")
      : errorCode === "EXPERIMENT_SAVE_AS_OWNER_UNAVAILABLE"
        ? input.ui("当前实验不可用或已删除，无法另存文稿副本。")
      : errorCode === "EXPERIMENT_SAVE_AS_OPERATION_IN_PROGRESS" ||
          errorCode === "EXPERIMENT_SAVE_AS_WRITE_BLOCKED"
        ? input.ui("当前实验有未完成的文稿操作，请先完成恢复或处理冲突后重试。")
      : errorCode === "EXPERIMENT_SAVE_AS_SOURCE_SESSION_INVALID"
        ? input.ui("当前文稿会话已失效，请重新打开文稿后再试。")
      : errorCode === "EXPERIMENT_SAVE_AS_PATH_INVALID" ||
          errorCode === "EXPERIMENT_SAVE_AS_PICKER_FAILED"
        ? input.ui("所选保存位置不可用，请重新选择文件名或路径。")
        : input.ui("文稿副本保存失败，原文稿和编辑状态未改变；请重试或按提示恢复。");
  }

  async function saveAs(
    sourceSessionKey: string | undefined,
    sourceFileName: string | undefined,
    sourceWindow: "current" | "independent",
    frozenDraftSnapshot?: ManuscriptSegmentDraftSnapshot
  ) {
    if (!sourceSessionKey || !input.experimentId) return false;
    const action = beginBusyAction();
    if (!action) return false;
    saveAsPresentedSessionKeyRef.current = undefined;
    setError("");
    clearActionResult(sourceWindow);
    try {
      const sourceSession =
        sourceWindow === "current"
          ? currentService.getSession(sourceSessionKey)
          : independentService.getSession(sourceSessionKey);
      const sourceEncoding = sourceSession?.baseline?.encoding ?? sourceSession?.encoding;
      const resolvedSourceFileName =
        sourceFileName ?? sourceSession?.file?.fileName;
      if (!sourceSession || !sourceEncoding || !resolvedSourceFileName) {
        const message = input.ui("当前所选实验文稿会话不可用于另存为。");
        setError(message);
        showActionResult(
          "error",
          "save",
          message,
          "experiment.manuscript.saveRawCopy",
          undefined,
          sourceWindow
        );
        return false;
      }
      const committed = await saveAsService.saveAs({
        experimentId: input.experimentId,
        sourceSessionKey,
        sourceWindowRole: sourceWindow,
        pickerTitle: input.ui("另存为"),
        acknowledgePresentation: (permit) =>
          acknowledgeSaveAsPresentation(
            permit,
            action.ownerId!,
            () => isCurrentAction(action)
          ),
        frozenDraftSnapshot
      });
      if (committed.status === "canceled") return false;
      if (committed.status !== "success") {
        if (!isCurrentAction(action)) return false;
        const message = saveAsFailureMessage(committed);
        setError(message);
        showActionResult(
          committed.status === "conflict" || committed.status === "recovery-required"
            ? "warning"
            : "error",
          "save",
          message,
          "experiment.manuscript.saveRawCopy",
          undefined,
          sourceWindow
        );
        return false;
      }
      if (!isCurrentAction(action)) return false;
      if (
        saveAsPresentedSessionKeyRef.current !==
        committed.independentSessionKey
      ) {
        const message = input.ui("文稿副本已创建，但独立编辑器尚未完成接管；请按提示恢复。");
        setError(message);
        showActionResult(
          "warning",
          "save",
          message,
          "experiment.manuscript.saveAsRecovery",
          committed.targetFileName,
          sourceWindow
        );
        return false;
      }
      showActionResult(
        "success",
        "save",
        input.ui("文稿副本已创建，并在独立编辑器中打开。"),
        "experiment.manuscript.saveRawCopy"
      );
      return true;
    } finally {
      finishBusyAction(action);
    }
  }

  function saveCurrentAs(value: string | ManuscriptSegmentDraftSnapshot = "") {
    return saveAs(
      mainSessionKey,
      currentFileName,
      "current",
      typeof value === "string" ? undefined : value
    );
  }

  function saveIndependentAs(value: string | ManuscriptSegmentDraftSnapshot = "") {
    return saveAs(
      independentSessionKey,
      independentSession?.file.fileName,
      "independent",
      typeof value === "string" ? undefined : value
    );
  }

  async function saveIndependent(markdown: string) {
    if (!independentSessionKey) throw new Error(input.ui("独立实验文稿尚未打开。"));
    clearActionResult("independent");
    setError("");
    updateIndependentDraft(independentSessionKey, markdown);
    const result = await executeIndependentSave(independentSessionKey);
    if (!result) return;
    if (result.status === "success" || result.status === "no-op") {
      setError("");
      refreshSessions();
    }
    return ordinarySavePresentation(
      result,
      { ownerType: "experiment", channel: "primary", ownerLabel: input.ui("实验") }
    );
  }

  async function reloadCurrent(markdown: string, lifecycleSettled = false) {
    if (!mainSessionKey) return false;
    if (!lifecycleSettled) {
      updateCurrentDraft(markdown);
      const requested = await sharedEditorLifecycleController.requestParticipant({
        participantId: `experiment-current:${mainSessionKey}`,
        trigger: "reload",
        continuationIntent: "RELOAD",
        surface: "application",
        continuation: async () => {
          await reloadCurrent(markdown, true);
        }
      });
      return requested.status === "continued";
    }
    const action = beginBusyAction();
    if (!action) return false;
    try {
      const result = await currentService.reload(mainSessionKey);
      if (!isCurrentAction(action)) return false;
      if (result.status !== "success") {
        const message = resultMessage(result, input.ui("实验文稿重新加载失败。"));
        setError(message);
        showActionResult(
          "error",
          "reload",
          message,
          "experiment.manuscript.reloadRawCurrent"
        );
        return false;
      }
      setMainPresentationEpoch((current) => current + 1);
      refreshSessions();
      showActionResult(
        "success",
        "reload",
        input.ui("实验文稿已重新加载。"),
        "experiment.manuscript.reloadRawCurrent"
      );
      return true;
    } finally {
      finishBusyAction(action);
    }
  }

  async function reloadIndependent(markdown: string, lifecycleSettled = false) {
    if (!independentSessionKey) return false;
    if (!lifecycleSettled) {
      updateIndependentDraft(independentSessionKey, markdown);
      const requested = await sharedEditorLifecycleController.requestParticipant({
        participantId: `experiment-independent:${independentSessionKey}`,
        trigger: "reload",
        continuationIntent: "RELOAD",
        surface: "application",
        continuation: async () => {
          await reloadIndependent(markdown, true);
        }
      });
      return requested.status === "continued";
    }
    const action = beginBusyAction("independent");
    if (!action) return false;
    try {
      const result = await independentService.reload(independentSessionKey);
      if (!isCurrentAction(action)) return false;
      if (result.status !== "success") {
        const message = resultMessage(
          result,
          input.ui("独立实验文稿重新加载失败。")
        );
        setError(message);
        showActionResult(
          "error",
          "reload",
          message,
          "experiment.manuscript.reloadRawIndependent",
          undefined,
          "independent"
        );
        return false;
      }
      setIndependentPresentationEpoch((current) => current + 1);
      refreshSessions();
      showActionResult(
        "success",
        "reload",
        input.ui("独立实验文稿已从磁盘重新加载。"),
        "experiment.manuscript.reloadRawIndependent",
        undefined,
        "independent"
      );
      return true;
    } finally {
      finishBusyAction(action);
    }
  }

  async function openDocument() {
    if (!input.experimentId) return false;
    const action = beginBusyAction("independent");
    if (!action) return false;
    clearActionResult();
    setError("");
    try {
      const experimentId = input.experimentId;
      const preview = input.independentOpenPreviewProvider ??
        createIndependentOpenPreviewProvider({
        pickerTitle: input.ui("打开实验 Markdown 文稿"),
        async resolveWorkspace() {
          const workspace =
            await experimentManuscriptSelectionService.resolveWorkspace(experimentId);
          return {
            initialDirectory: workspace.path,
            configuredRoot: workspace.path,
            classify: (path: string) =>
              isPathWithinDirectory(workspace.path, path)
                ? "managed"
                : "external"
          };
        }
      });
      const normalize = (result: Awaited<
        ReturnType<typeof independentService.openRegistered>
      > | Awaited<ReturnType<typeof currentService.openCurrent>>):
        IndependentOpenActivationResult =>
        result.status === "success" &&
        "sessionKey" in result &&
        "session" in result &&
        "fileName" in result &&
        "fileRefId" in result
          ? {
              status: "success",
              handle: result.sessionKey,
              session: result.session,
              fileName: result.fileName,
              fileRefId: result.fileRefId
            }
          : {
              status: result.status === "conflict" ? "conflict" : "error",
              errorCode: resultCode(result)
            };
      const consumerId = `experiment:${experimentId}:independent-editor`;
      const adapter: IndependentOpenProductAdapter = {
        owner: {
          ownerType: "experiment",
          ownerId: experimentId,
          channel: "primary"
        },
        presentationScope: consumerId,
        consumerId,
        selectAndPreview: preview.selectAndPreview,
        revalidatePreview: preview.revalidatePreview,
        listIndependentConsumers: () =>
          independentSessionKey && independentSession
            ? [{
                handle: independentSessionKey,
                consumerId,
                session: independentSession
              }]
            : [],
        getCurrentConsumer: () =>
          mainSessionKey && mainSession
            ? {
                handle: mainSessionKey,
                consumerId: `experiment:${experimentId}:current-editor`,
                session: mainSession
              }
            : undefined,
        async activateCurrent(id) {
          return normalize(await currentService.openCurrent(experimentId, id));
        },
        async activateIndependent(fileRefId, id) {
          return normalize(
            await independentService.openRegistered(experimentId, fileRefId, id)
          );
        },
        async closeConsumer(handle, decision) {
          const currentBefore = currentService.getSession(handle);
          if (decision === "save" && !(await saveIndependentSession(handle))) {
            return {
              status: "error",
              consumerCleanupState: "unresolved",
              sessionCleanupState: "unresolved",
              admissionCleanupState: "unresolved",
              errorCode: "EXPERIMENT_SAVE_FAILED"
            } as const;
          }
          const closed = currentBefore
            ? await currentService.requestClose(
                handle,
                decision === "discard" ? "discard" : undefined
              )
            : await independentService.requestClose(
                handle,
                decision === "discard" ? "discard" : undefined
              );
          return resolveIndependentOpenConsumerCleanup({
            closeStatus: closed.status,
            runtimeCleanup: "cleanup" in closed ? closed.cleanup : undefined,
            errorCode: resultCode(closed) || "EXPERIMENT_CLOSE_FAILED"
          });
        },
        presentCurrent(activation, permit) {
          if (
            activation.status !== "success" ||
            !permit.isCurrent() ||
            !isCurrentAction(action)
          ) {
            return false;
          }
          setMainSessionKey(activation.handle);
          setMainOpen(true);
          setMainPresentationEpoch((current) => current + 1);
          refreshSessions();
          return true;
        },
        presentIndependent(activation, permit) {
          if (
            activation.status !== "success" ||
            !permit.isCurrent() ||
            !isCurrentAction(action)
          ) {
            return false;
          }
          setIndependentSessionKey(activation.handle);
          setIndependentOpen(true);
          setIndependentPresentationEpoch((current) => current + 1);
          refreshSessions();
          return true;
        },
        focusCurrent(_consumer, permit) {
          if (!permit.isCurrent() || !isCurrentAction(action)) return false;
          setMainOpen(true);
          setMainPresentationEpoch((current) => current + 1);
          return true;
        },
        focusIndependent(_consumer, permit) {
          if (!permit.isCurrent() || !isCurrentAction(action)) return false;
          setIndependentOpen(true);
          setIndependentPresentationEpoch((current) => current + 1);
          return true;
        },
        async decideDirty(consumer) {
          return new Promise<"save" | "discard" | "cancel">((resolve) => {
            void sharedEditorLifecycleController.requestParticipant({
              participantId: `experiment-independent:${consumer.handle}`,
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
          const message = selected.locationMode === "external"
            ? input.ui("文稿已只读预览。是否登记其原始位置并打开？不会复制、移动、改名或写入文件。")
            : input.ui("文稿已只读预览。是否登记为工作区文稿并打开？不会修改当前稿或默认稿。");
          return window.confirm(message) ? "confirm" : "cancel";
        },
        async confirmActivationRetry({ fileName }) {
          return window.confirm(
            input.ui(`“${fileName}”的登记已保留。是否重试打开？`)
          );
        }
      };
      const outcome = await openProtocol.execute(adapter);
      if (!isCurrentAction(action)) return false;
      const success = [
        "current-session-reused",
        "current-session-activated",
        "independent-session-reused",
        "activation-succeeded"
      ].includes(outcome.status);
      const canceled = outcome.status === "picker-cancelled" ||
        outcome.status === "registration-declined" ||
        outcome.status === "operation-cancelled";
      const message = success
        ? input.ui("实验文稿已打开。")
        : canceled
          ? input.ui("已取消打开，未产生新的持久化副作用。")
          : input.ui(`实验文稿打开未完成：${outcome.errorCode ?? outcome.status}`);
      if (!success) setError(canceled ? "" : message);
      showActionResult(
        success ? "success" : canceled ? "info" : "error",
        "open",
        message,
        `experiment.manuscript.independentOpen.${outcome.status}`,
        outcome.fileName,
        outcome.status.startsWith("current-") ? "current" : "independent"
      );
      return success;
    } finally {
      finishBusyAction(action);
    }
  }

  async function switchDocument(lifecycleSettled = false) {
    if (!input.experimentId) return false;
    if (!lifecycleSettled) {
      let completed = false;
      const requested = await sharedEditorLifecycleController.requestSequence({
        trigger: "switch-manuscript",
        continuationIntent: "SWITCH_MANUSCRIPT",
        surface: "application",
        continuation: async () => {
          completed = await switchDocument(true);
        }
      });
      return requested.status === "continued" && completed;
    }
    const action = beginBusyAction();
    if (!action) return false;
    clearActionResult();
    setError("");
    try {
      let selected = await service.selectTarget(
        input.experimentId,
        ++requestCounter.current
      );
      if (!isCurrentAction(action)) {
        if (selected.status === "registration-required") {
          service.cancelTargetRegistration(selected.pendingId);
        }
        return false;
      }
      if (selected.status === "canceled") {
        showActionResult(
          "info",
          "switch",
          input.ui("已取消切换文稿，当前稿和默认稿未改变。"),
          "experiment.manuscript.switchCanceled"
        );
        return false;
      }
      if (selected.status === "no-op" && selected.reason === "current-file") {
        showActionResult(
          "info",
          "switch",
          input.ui("所选文件已是当前文稿。"),
          "experiment.manuscript.switchNoOp",
          selected.fileName
        );
        return true;
      }
      if (selected.status === "registration-required") {
        const confirmed = await requestChoice({
          kind: "external-registration",
          title: input.ui("登记所选实验文稿"),
          message:
            selected.locationMode === "external"
              ? input.ui("文件已安全读取。正式切换前需将其原位登记为外部文稿；不会复制、移动、改名、写入文件或修改当前稿/默认稿。")
              : input.ui("文件已安全读取。正式切换前需登记为工作区文稿；不会写入文件或修改当前稿/默认稿。"),
          options: [
            { value: "confirm", label: input.ui("登记并继续"), emphasis: "primary" },
            { value: "cancel", label: input.ui("取消") }
          ]
        });
        if (!isCurrentAction(action)) {
          service.cancelTargetRegistration(selected.pendingId);
          return false;
        }
        if (confirmed !== "confirm") {
          service.cancelTargetRegistration(selected.pendingId);
          showActionResult(
            "info",
            "switch",
            input.ui("已取消登记所选文稿，当前稿、默认稿和文件内容均未改变。"),
            "experiment.manuscript.externalRegistrationCanceled",
            selected.fileName
          );
          return false;
        }
        selected = await service.confirmTargetRegistration(selected.pendingId);
        if (!isCurrentAction(action)) return false;
      }
      if (selected.status !== "success") {
        const message = pipelineErrorMessage(
          selected,
          input.ui("目标 Markdown 无法打开，未执行切换。")
        );
        setError(message);
        showActionResult(
          "error",
          "switch",
          message,
          "experiment.manuscript.selectSwitch"
        );
        return false;
      }
      const preflight = await service.preflight(
        input.experimentId,
        selected.sessionKey
      );
      if (!isCurrentAction(action)) return false;
      if (
        preflight.status === "error" &&
        (preflight.error.code === "EXPERIMENT_FORMAL_SWITCH_CURRENT_DIRTY" ||
          preflight.error.code === "EXPERIMENT_FORMAL_SWITCH_TARGET_DIRTY")
      ) {
        const message = projectFormalSwitchFailure(preflight, input.ui).summary;
        setError(message);
        showActionResult("error", "switch", message, "experiment.manuscript.switchPreflight");
        return false;
      }
      if (preflight.status === "no-op") {
        await loadCurrentDescriptor(input.experimentId);
        if (!isCurrentAction(action)) return false;
        showActionResult(
          "info",
          "switch",
          input.ui("所选文件已是当前文稿。"),
          "experiment.manuscript.switchNoOp",
          selected.fileName
        );
        return true;
      }
      if (preflight.status !== "ready") {
        const message = projectFormalSwitchFailure(
          preflight, input.ui, { reload: true, reopen: true, wait: true }
        ).summary;
        setError(message);
        showActionResult(
          preflight.error.recoveryRequired
            ? "warning"
            : "error",
          "switch",
          message,
          "experiment.manuscript.switchPreflight",
          selected.fileName
        );
        return false;
      }
      const switchCopy = buildFormalSwitchConfirmationCopy({
        targetFileName: selected.fileName,
        ownerDisplayName: input.ui("实验文稿"),
        descriptorLookupIdentity: { ownerType: "experiment", channel: "primary" },
        translate: input.ui,
        resolveLabel: (field) => input.ui(field.displayLabel),
        fieldActions: (preflight.outlineReplacements ?? []).map((replacement) => ({
          key: replacement.key,
          action: replacement.action
        }))
      });
      const confirmed = await requestChoice({
        kind: "formal-switch",
        title: input.ui("设为当前稿"),
        message: switchCopy.message,
        options: [
          { value: "confirm", label: input.ui("设为当前稿"), emphasis: "primary" },
          { value: "cancel", label: input.ui("取消") }
        ]
      });
      if (!isCurrentAction(action)) return false;
      if (confirmed !== "confirm") {
        showActionResult(
          "info",
          "switch",
          input.ui("已取消切换文稿，当前稿和默认稿未改变。"),
          "experiment.manuscript.switchConfirmCanceled",
          selected.fileName
        );
        return false;
      }
      const switched = await service.confirm(preflight.preflightToken);
      if (!isCurrentAction(action)) return false;
      if (switched.status !== "success") {
        if (switched.status === "canceled") {
          showActionResult(
            "info",
            "switch",
            input.ui("已取消切换文稿，当前稿和默认稿未改变。"),
            "experiment.manuscript.switchCanceled",
            selected.fileName
          );
          return false;
        }
        if (switched.status === "recovery-required") {
          const recoveries = await service.listRecoveries(input.experimentId);
          setSwitchRecovery(
            recoveries.find(
              (item) => item.operationId === switched.operationId
            )
          );
        }
        const message = projectFormalSwitchFailure(
          switched, input.ui, { reload: true, reopen: true, wait: true }
        ).summary;
        setError(message);
        showActionResult(
          switched.status === "recovery-required" ||
            switched.error.recoveryRequired
            ? "warning"
            : "error",
          "switch",
          message,
          "experiment.manuscript.switchConfirm",
          selected.fileName
        );
        return false;
      }
      setMainSessionKey(switched.sessionKey);
      setMainOpen(true);
      setMainPresentationEpoch((current) => current + 1);
      setSwitchRecovery(undefined);
      refreshSessions();
      const descriptorRefreshed = await loadCurrentDescriptor(input.experimentId);
      if (!isCurrentAction(action)) return false;
      if (!descriptorRefreshed) {
        const refreshFailure = {
          status: "error",
          error: {
            code: "EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED",
            errorCode: "EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED",
            message: "EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED",
            stage: "page-refresh",
            causeCode: "CURRENT_DESCRIPTOR_REFRESH_FAILED",
            recoverability: "retry",
            recoveryRequired: false,
            operationId: switched.operationLogId
          }
        };
        const message = projectFormalSwitchFailure(refreshFailure, input.ui).summary;
        setError(message);
        showActionResult(
          "warning",
          "switch",
          message,
          "experiment.manuscript.switchRefresh",
          selected.fileName
        );
        return false;
      }
      showActionResult(
        "success",
        "switch",
        input.ui("当前实验文稿已切换；默认稿保持不变。"),
        "experiment.manuscript.switch",
        selected.fileName
      );
      return true;
    } finally {
      finishBusyAction(action);
    }
  }

  async function discardSession(kind: "main" | "independent") {
    const sessionKey = kind === "main" ? mainSessionKey : independentSessionKey;
    if (!sessionKey) throw new Error("MANUSCRIPT_LIFECYCLE_SESSION_UNAVAILABLE");
    const result = await (kind === "main"
      ? currentService.reload(sessionKey, "discard")
      : independentService.reload(sessionKey, "discard"));
    refreshSessions();
    if (result.status !== "success") {
      throw new Error(resultMessage(result, input.ui("放弃文稿更改失败。")));
    }
  }

  async function closeSession(kind: "main" | "independent") {
    if (kind === "main" && input.experimentId) {
      openProtocol.cancelOwner({
        ownerType: "experiment",
        ownerId: input.experimentId,
        channel: "primary"
      });
      invalidateBusyAction("independent");
    }
    if (currentBusyRef.current || independentBusyRef.current) {
      invalidateBusyAction(kind === "main" ? "current" : "independent");
    }
    const sessionKey = kind === "main" ? mainSessionKey : independentSessionKey;
    if (!sessionKey) return true;
    const result = await (kind === "main"
      ? currentService.requestClose(sessionKey)
      : independentService.requestClose(sessionKey));
    if (result.status !== "success") {
      const message = resultMessage(result, input.ui("当前文稿暂时不能关闭。"));
      setError(message);
      feedback("warning", message, "experiment.manuscript.close");
      return false;
    }
    if (kind === "main") {
      setMainOpen(false);
      setMainSessionKey(undefined);
      setCurrentActionResult(null);
    } else {
      setIndependentOpen(false);
      setIndependentSessionKey(undefined);
      saveAsPresentedSessionKeyRef.current = undefined;
      setIndependentActionResult(null);
    }
    refreshSessions();
    return true;
  }

  async function retrySwitchRecovery() {
    if (!switchRecovery) return false;
    const action = beginBusyAction();
    if (!action) return false;
    try {
      const result = await service.retryRecovery(switchRecovery.operationId);
      if (!isCurrentAction(action)) return false;
      if (result.status !== "success") {
        showActionResult(
          "warning",
          "switch",
          resultMessage(
            result,
            input.ui("恢复提交失败；已准确落盘的顶部上下文不会重复回写。")
          ),
          "experiment.manuscript.switchRecoveryRetry"
        );
        return false;
      }
      setMainSessionKey(result.sessionKey);
      setMainOpen(true);
      setMainPresentationEpoch((current) => current + 1);
      setSwitchRecovery(undefined);
      refreshSessions();
      const descriptorRefreshed = await loadCurrentDescriptor(result.experimentId);
      if (!descriptorRefreshed) {
        showActionResult(
          "warning",
          "switch",
          formalSwitchErrorMessage(
            {
              status: "error",
              error: {
                code: "EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED",
                errorCode: "EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED",
                message: "EXPERIMENT_FORMAL_SWITCH_PAGE_REFRESH_FAILED",
                stage: "page-refresh",
                causeCode: "CURRENT_DESCRIPTOR_REFRESH_FAILED",
                recoverability: "retry",
                recoveryRequired: false,
                operationId: result.operationLogId
              }
            },
            input.ui("数据库恢复已完成且会话已激活，但页面信息刷新失败。")
          ),
          "experiment.manuscript.switchRecoveryRetry"
        );
        return false;
      }
      showActionResult(
        "success",
        "switch",
        input.ui("正式切换恢复已完成；旧当前稿顶部上下文未重复回写。"),
        "experiment.manuscript.switchRecoveryRetry"
      );
      return true;
    } finally {
      finishBusyAction(action);
    }
  }

  async function cancelSwitchRecovery() {
    if (!switchRecovery) return false;
    const result = await service.cancelRecovery(switchRecovery.operationId);
    if (result.status !== "canceled") return false;
    setSwitchRecovery(undefined);
    showActionResult(
      "warning",
      "switch",
      input.ui("已安全取消尚未写入的恢复任务；数据库当前稿、默认稿、纲要和旧当前稿均未改变。"),
      "experiment.manuscript.switchRecoveryCancel"
    );
    return true;
  }

  return {
    mainOpen,
    independentOpen,
    mainSession,
    independentSession,
    mainSessionKey,
    independentSessionKey,
    mainPresentationEpoch,
    independentPresentationEpoch,
    mainInitialRawText: mainSession?.draftRawText ?? "",
    independentInitialRawText: independentSession?.draftRawText ?? "",
    mainCurrentFileName: currentFileName,
    currentFileName,
    currentFileRefId,
    currentDescriptorError,
    independentFileName: independentSession?.file.fileName,
    mainContentIdentity: mainSessionKey
      ? `${mainSessionKey}:${mainPresentationEpoch}`
      : undefined,
    independentContentIdentity: independentSessionKey
      ? `${independentSessionKey}:${independentPresentationEpoch}`
      : undefined,
    mainReadOnly: Boolean(
      mainSession?.recoveryRequired || mainSession?.accessMode === "read-only"
    ),
    independentReadOnly: Boolean(
      independentSession?.recoveryRequired ||
        independentSession?.accessMode === "read-only"
    ),
    busy: currentBusy || independentBusy,
    currentBusy,
    independentBusy,
    error,
    currentActionResult,
    independentActionResult,
    switchRecovery: currentSwitchRecovery,
    choiceDialog,
    resolveChoice,
    dismissCurrentActionResult: () => clearActionResult("current"),
    dismissIndependentActionResult: () => clearActionResult("independent"),
    resolveContextSummaryMarkdown,
    openCurrent,
    openDocument,
    switchDocument,
    retrySwitchRecovery,
    cancelSwitchRecovery,
    updateCurrentDraft,
    updateIndependentDraft: (markdown: string) =>
      updateIndependentDraft(independentSessionKey, markdown),
    saveCurrent,
    saveCurrentAs,
    saveIndependentAs,
    saveIndependent,
    reloadCurrent,
    reloadIndependent,
    readCurrentSession: () => mainSessionKey
      ? currentService.getSession(mainSessionKey)
      : undefined,
    readIndependentSession: () => independentSessionKey
      ? independentService.getSession(independentSessionKey)
      : undefined,
    discardCurrent: () => discardSession("main"),
    discardIndependent: () => discardSession("independent"),
    closeCurrent: () => closeSession("main"),
    closeIndependent: () => closeSession("independent"),
    refreshCurrentDescriptor: loadCurrentDescriptor,
    refreshSessions
  };
}
