import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimentRunRawManuscriptService,
  type ExperimentRunRawManuscriptService
} from "../../services/experimentRunRawManuscriptService";
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
  experimentRunPickerWorkspaceResolver
} from "../../services/experimentRunPickerWorkspaceResolver";
import { prepareExperimentRunManuscriptOpen } from "../../services/experimentRunManuscriptProvisioningService";
import {
  experimentRunManuscriptSwitchService,
  type ExperimentRunManuscriptSwitchService
} from "../../services/experimentRunManuscriptSwitchService";
import { formatFormalSwitchDiagnostic } from "../../services/formalSwitchEngine";
import { EXPERIMENT_RUN_RAW_ERROR_CODES } from "../../types/experimentRunRawManuscript";
import type { ExperimentRunManuscriptProvisioningResult } from "../../types/experimentRunProvisioning";
import type { ExperimentRunSwitchRecoveryRecord } from "../../types/experimentRunManuscriptSwitch";
import type { ExperimentRunCanonicalSaveAsRecovery } from "../../services/experimentRunManuscriptSaveAsAdapter";
import {
  buildExperimentRunContextSummaryMarkdown,
  experimentRunContextSummaryService,
} from "../../services/experimentRunContextSummaryService";
import {
  experimentRunManuscriptSaveAsAdapter
} from "../../services/experimentRunManuscriptSaveAsAdapter";
import type { SaveAsPresentationPermit } from "../../services/manuscriptSaveAsPresentationProtocol";
import { windowPContainmentFeedbackMessage } from "../../services/manuscriptSaveAsWindowPContainment";
import { sharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController";
import { ordinarySavePresentation } from "../../services/ordinaryOperationPresentation";
import { buildFormalSwitchConfirmationCopy, isOrdinaryFormalSwitchFeedback, isSilentFormalSwitchFeedback, projectFormalSwitchFailure } from "../../services/manuscriptFormalSwitchPresentation";
import type { ManuscriptSegmentDraftSnapshot } from "../../types/manuscriptSegmentProjection";

type FeedbackSeverity = "success" | "warning" | "error" | "info";
type EditorMode = "current" | "independent";
type ChoiceValue = "save" | "discard" | "cancel" | "confirm";

export interface ExperimentRunManuscriptActionResult {
  severity: FeedbackSeverity;
  action: "open" | "save" | "reload" | "close" | "switch" | "context" | "template" | "save-as";
  message: string;
  dismissible: true;
}

export interface ExperimentRunManuscriptChoiceDialog {
  kind:
    | "registration-confirm"
    | "external-write"
    | "formal-switch-confirm"
    | "save-as-confirm";
  title: string;
  message: string;
  options: Array<{
    value: ChoiceValue;
    label: string;
    emphasis?: "primary" | "danger";
  }>;
}

export interface UseExperimentRunManuscriptEditorInput {
  runId?: string;
  ui(source: string): string;
  onFeedback?(severity: FeedbackSeverity, message: string, operation: string): void;
  rawService?: ExperimentRunRawManuscriptService;
  switchService?: ExperimentRunManuscriptSwitchService;
  contextService?: typeof experimentRunContextSummaryService;
  saveAsService?: typeof experimentRunManuscriptSaveAsAdapter;
  prepareOpen?(runId: string): Promise<ExperimentRunManuscriptProvisioningResult>;
  onSwitched?(runId: string): void | Promise<void>;
  independentOpenProtocol?: IndependentManuscriptOpenProtocol;
  independentOpenPreviewProvider?: ReturnType<
    typeof createIndependentOpenPreviewProvider
  >;
}

function resultCode(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const error = (result as { error?: unknown }).error;
  return error && typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
}

function isProvisionableIdentityGap(result: { error?: { code?: string } }) {
  const code = resultCode(result);
  return code === EXPERIMENT_RUN_RAW_ERROR_CODES.bindingMissing ||
    code === EXPERIMENT_RUN_RAW_ERROR_CODES.currentMissing;
}

export function useExperimentRunManuscriptEditor(
  input: UseExperimentRunManuscriptEditorInput
) {
  const rawService = input.rawService ?? experimentRunRawManuscriptService;
  const provisionForOpen = input.prepareOpen ?? prepareExperimentRunManuscriptOpen;
  const formalSwitchService = input.switchService ?? experimentRunManuscriptSwitchService;
  const contextService = input.contextService ?? experimentRunContextSummaryService;
  const saveAsService = input.saveAsService ?? experimentRunManuscriptSaveAsAdapter;
  const openProtocol =
    input.independentOpenProtocol ?? independentManuscriptOpenProtocol;
  const [mainSessionKey, setMainSessionKey] = useState<string>();
  const [independentSessionKey, setIndependentSessionKey] = useState<string>();
  const [mainOpen, setMainOpen] = useState(false);
  const [independentOpen, setIndependentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [mainPresentationEpoch, setMainPresentationEpoch] = useState(0);
  const [independentPresentationEpoch, setIndependentPresentationEpoch] = useState(0);
  const [choiceDialog, setChoiceDialog] = useState<ExperimentRunManuscriptChoiceDialog | null>(null);
  const [currentActionResult, setCurrentActionResult] = useState<ExperimentRunManuscriptActionResult | null>(null);
  const [independentActionResult, setIndependentActionResult] = useState<ExperimentRunManuscriptActionResult | null>(null);
  const [switchRecovery, setSwitchRecovery] = useState<ExperimentRunSwitchRecoveryRecord>();
  const [saveAsRecovery, setSaveAsRecovery] = useState<ExperimentRunCanonicalSaveAsRecovery>();
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const ownerRef = useRef(input.runId);
  const requestCounter = useRef(0);
  const saveAsPresentedSessionKeyRef = useRef<string>();
  const lastOpenedIndependentSessionKeyRef = useRef<string>();
  const choiceResolverRef = useRef<((choice: ChoiceValue | null) => void) | null>(null);

  const mainSession = useMemo(
    () => mainSessionKey ? rawService.getSession(mainSessionKey) : undefined,
    [mainSessionKey, rawService, sessionRevision]
  );
  const independentSession = useMemo(
    () => independentSessionKey ? rawService.getSession(independentSessionKey) : undefined,
    [independentSessionKey, rawService, sessionRevision]
  );

  function refreshSessions() {
    setSessionRevision((current) => current + 1);
  }

  function acknowledgeSaveAsPresentation(
    permit: SaveAsPresentationPermit,
    runId: string,
    isFresh: () => boolean
  ) {
    const session = rawService.getSession(permit.runtime.handle);
    if (
      !isFresh() ||
      !session ||
      session.logicalIdentity.ownerType !== "experimentRun" ||
      session.logicalIdentity.ownerId !== runId ||
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
    setIndependentPresentationEpoch((current) => current + 1);
    setIndependentOpen(true);
    refreshSessions();
    return true;
  }

  function showResult(
    severity: FeedbackSeverity,
    action: ExperimentRunManuscriptActionResult["action"],
    message: string,
    operation: string,
    mode: EditorMode = "current"
  ) {
    if (isSilentFormalSwitchFeedback(operation, severity)) {
      clearActionResults();
      input.onFeedback?.(severity, message, operation);
      return;
    }
    const ordinarySwitch = isOrdinaryFormalSwitchFeedback(operation);
    if (ordinarySwitch && !(mode === "current" ? mainOpen : independentOpen)) {
      clearActionResults();
      input.onFeedback?.(severity, message, operation);
      return;
    }
    const result = { severity, action, message, dismissible: true } as const;
    if (mode === "current") setCurrentActionResult(result);
    else setIndependentActionResult(result);
    if (!ordinarySwitch) input.onFeedback?.(severity, message, operation);
  }

  function clearActionResults() {
    setCurrentActionResult(null);
    setIndependentActionResult(null);
  }

  function safeFailureMessage(
    result: { status: string; error?: { code?: string } },
    fallback: string
  ) {
    const code = result.error?.code;
    if (code === EXPERIMENT_RUN_RAW_ERROR_CODES.crossOwnerManagedPathConflict) {
      return input.ui(
        "所选文件属于其他业务条目的托管文稿，当前 Run 不能将其登记为托管文稿；未修改任何文件、当前稿或默认稿。"
      );
    }
    return fallback;
  }

  function formalSwitchFailureMessage(result: unknown, fallback: string) {
    if (!result || typeof result !== "object") return fallback;
    const error = (result as { error?: unknown }).error;
    if (!error || typeof error !== "object") return fallback;
    const record = error as { stage?: unknown; causeCode?: unknown; operationId?: unknown };
    return typeof record.stage === "string" && typeof record.causeCode === "string" && typeof record.operationId === "string"
      ? `${fallback}\n${formatFormalSwitchDiagnostic(error as never)}`
      : fallback;
  }

  function isCurrentRequest(requestId: number, runId: string) {
    return requestId === requestCounter.current && ownerRef.current === runId;
  }

  useEffect(() => {
    const previousOwner = ownerRef.current;
    if (previousOwner) {
      openProtocol.cancelOwner({
        ownerType: "experimentRun",
        ownerId: previousOwner,
        channel: "primary"
      });
    }
    choiceResolverRef.current?.(null);
    choiceResolverRef.current = null;
    ownerRef.current = input.runId;
    saveAsPresentedSessionKeyRef.current = undefined;
    requestCounter.current += 1;
    setMainOpen(false);
    setIndependentOpen(false);
    setMainSessionKey(undefined);
    setIndependentSessionKey(undefined);
    setChoiceDialog(null);
    clearActionResults();
    setSwitchRecovery(undefined);
    setSaveAsRecovery(undefined);
    setRecoveryDismissed(false);
    setBusy(false);
    const runId = input.runId;
    if (runId && typeof formalSwitchService.listRecoveries === "function") {
      void formalSwitchService.listRecoveries(runId).then((records) => {
        if (ownerRef.current === runId) setSwitchRecovery(records[0]);
      }).catch(() => {
        if (ownerRef.current === runId) {
          showResult("error", "switch", input.ui("无法读取文稿切换恢复状态。"), "experimentRun.manuscript.recoveryDiscovery");
        }
      });
    }
    if (runId) {
      void saveAsService.listUnresolved(runId).then((records) => {
        if (ownerRef.current === runId) setSaveAsRecovery(records[0]);
      }).catch(() => {
        if (ownerRef.current === runId) {
          showResult("error", "save-as", input.ui("无法读取另存为恢复状态。"), "experimentRun.manuscript.saveAsRecoveryDiscovery");
        }
      });
    }
    return () => {
      requestCounter.current += 1;
      if (input.runId) {
        openProtocol.cancelOwner({
          ownerType: "experimentRun",
          ownerId: input.runId,
          channel: "primary"
        });
      }
      choiceResolverRef.current?.(null);
      choiceResolverRef.current = null;
    };
  }, [formalSwitchService, input.runId]);

  async function refreshRecovery() {
    const runId = input.runId;
    if (!runId || typeof formalSwitchService.listRecoveries !== "function") return undefined;
    const records = await formalSwitchService.listRecoveries(runId);
    const recovery = records[0];
    if (ownerRef.current === runId) setSwitchRecovery(recovery);
    return recovery;
  }

  async function continueSwitchRecovery() {
    const recovery = switchRecovery;
    if (!recovery || busy) return false;
    setBusy(true);
    try {
      const result = await formalSwitchService.continueRecovery(recovery.operationId);
      await refreshRecovery();
      refreshSessions();
      if (result.status === "success") {
        if (result.sessionKey) {
          setMainSessionKey(result.sessionKey);
          setMainOpen(true);
          setIndependentSessionKey(undefined);
          setIndependentOpen(false);
          setMainPresentationEpoch((current) => current + 1);
        }
        await input.onSwitched?.(recovery.runId);
        showResult("success", "switch", input.ui("文稿切换恢复已完成。"), "experimentRun.manuscript.recoveryCompleted");
        return true;
      }
      showResult("error", "switch", formalSwitchFailureMessage(result, input.ui("文稿切换仍需处理，请检查恢复状态。")), "experimentRun.manuscript.recoveryBlocked");
      return false;
    } catch {
      await refreshRecovery().catch(() => undefined);
      showResult("error", "switch", input.ui("文稿切换恢复失败。"), "experimentRun.manuscript.recoveryFailed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function safeCancelSwitchRecovery() {
    const recovery = switchRecovery;
    if (!recovery || recovery.phase !== "prepared" || busy) return false;
    setBusy(true);
    try {
      const result = await formalSwitchService.safeCancelRecovery(recovery.operationId);
      if ("status" in result && result.status === "error") {
        showResult("error", "switch", input.ui("当前恢复状态不能安全取消。"), "experimentRun.manuscript.recoveryCancelBlocked");
        return false;
      }
      await refreshRecovery();
      showResult("info", "switch", input.ui("未发生文件追加或数据库提交，切换已安全取消。"), "experimentRun.manuscript.recoveryCancelled");
      return true;
    } catch {
      showResult("error", "switch", input.ui("当前恢复状态不能安全取消。"), "experimentRun.manuscript.recoveryCancelBlocked");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function requestChoice(dialog: ExperimentRunManuscriptChoiceDialog) {
    choiceResolverRef.current?.(null);
    setChoiceDialog(dialog);
    return new Promise<ChoiceValue | null>((resolve) => {
      choiceResolverRef.current = resolve;
    });
  }

  async function openCurrent() {
    const runId = input.runId;
    if (!runId) {
      showResult("warning", "open", input.ui("请先选择 Run。"), "experimentRun.manuscript.open");
      return false;
    }
    const requestId = ++requestCounter.current;
    setBusy(true);
    setCurrentActionResult(null);
    try {
      await refreshRecovery();
      if (!isCurrentRequest(requestId, runId)) return false;
      let result = await rawService.openCurrent(runId);
      if (!isCurrentRequest(requestId, runId)) return false;
      if (result.status !== "success" && isProvisionableIdentityGap(result)) {
        const provisioned = await provisionForOpen(runId);
        if (!isCurrentRequest(requestId, runId)) return false;
        if (provisioned.completionState !== "complete") {
          showResult(
            provisioned.retryable ? "warning" : "error",
            "open",
            input.ui("Run 文稿身份准备失败，未打开编辑器。"),
            "experimentRun.manuscript.provision"
          );
          return false;
        }
        result = await rawService.openCurrent(runId);
        if (!isCurrentRequest(requestId, runId)) return false;
      }
      if (result.status !== "success" || !result.sessionKey) {
        showResult(
          "error",
          "open",
          safeFailureMessage(result, input.ui("Run 文稿打开失败。")),
          "experimentRun.manuscript.open"
        );
        return false;
      }
      setMainSessionKey(result.sessionKey);
      setMainPresentationEpoch((current) => current + 1);
      setMainOpen(true);
      refreshSessions();
      return true;
    } catch {
      if (isCurrentRequest(requestId, runId)) {
        showResult(
          "error",
          "open",
          input.ui("Run 文稿打开失败。"),
          "experimentRun.manuscript.open"
        );
      }
      return false;
    } finally {
      if (isCurrentRequest(requestId, runId)) setBusy(false);
    }
  }

  async function openIndependent(fileRefId: string) {
    const runId = input.runId;
    if (!runId || !fileRefId) return false;
    const requestId = ++requestCounter.current;
    setBusy(true);
    setIndependentActionResult(null);
    try {
      const result = await rawService.openIndependent(runId, fileRefId);
      if (!isCurrentRequest(requestId, runId)) return false;
      if (result.status !== "success" || !result.sessionKey) {
        showResult(
          "error",
          "open",
          safeFailureMessage(result, input.ui("所选 Run 文稿打开失败。")),
          "experimentRun.manuscript.openIndependent",
          "independent"
        );
        return false;
      }
      setIndependentSessionKey(result.sessionKey);
      setIndependentPresentationEpoch((current) => current + 1);
      setIndependentOpen(true);
      refreshSessions();
      return true;
    } finally {
      if (isCurrentRequest(requestId, runId)) setBusy(false);
    }
  }

  async function openDocument(forFormalSwitch = false) {
    const runId = input.runId;
    if (!runId) return false;
    const requestId = ++requestCounter.current;
    setBusy(true);
    setCurrentActionResult(null);
    try {
      const preview = input.independentOpenPreviewProvider ??
        createIndependentOpenPreviewProvider({
        pickerTitle: input.ui("打开 Run Markdown 文稿"),
        async resolveWorkspace() {
          const workspace =
            await experimentRunPickerWorkspaceResolver.resolve(runId);
          return {
            initialDirectory: workspace.initialDirectory,
            configuredRoot: workspace.runWorkspace?.path,
            classify: workspace.classify
          };
        }
      });
      const normalize = (
        result: Awaited<ReturnType<typeof rawService.openCurrent>>
      ): IndependentOpenActivationResult => {
        if (
          result.status === "success" &&
          "sessionKey" in result &&
          result.sessionKey &&
          "session" in result &&
          result.session.file.kind === "durable"
        ) {
          return {
            status: "success",
            handle: result.sessionKey,
            session: result.session,
            fileName: result.session.file.fileName,
            fileRefId: result.session.file.fileRefId
          };
        }
        return {
          status: result.status === "conflict" ? "conflict" : "error",
          errorCode: resultCode(result)
        };
      };
      const consumerId = `experimentRun:${runId}:independent-editor`;
      const adapter: IndependentOpenProductAdapter = {
        owner: {
          ownerType: "experimentRun",
          ownerId: runId,
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
                consumerId: `experimentRun:${runId}:current-editor`,
                session: mainSession
              }
            : undefined,
        async activateCurrent(id) {
          return normalize(await rawService.openCurrent(runId, id));
        },
        async activateIndependent(fileRefId, id) {
          return normalize(await rawService.openIndependent(runId, fileRefId, id));
        },
        async closeConsumer(handle, decision) {
          if (decision === "save") {
            const saved = await saveSessionWithExternalConfirmation(handle);
            if (saved.status !== "success" && saved.status !== "no-op") {
              return {
                status: "error",
                consumerCleanupState: "unresolved",
                sessionCleanupState: "unresolved",
                admissionCleanupState: "unresolved",
                errorCode: resultCode(saved)
              } as const;
            }
          }
          const closed = await rawService.close(
            handle,
            decision === "discard" ? "discard" : undefined
          );
          return resolveIndependentOpenConsumerCleanup({
            closeStatus: closed.status,
            runtimeCleanup: "cleanup" in closed ? closed.cleanup : undefined,
            errorCode: resultCode(closed) || "RUN_OPEN_CLOSE_FAILED"
          });
        },
        presentCurrent(activation, permit) {
          if (
            activation.status !== "success" ||
            !permit.isCurrent() ||
            !isCurrentRequest(requestId, runId)
          ) return false;
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
            !isCurrentRequest(requestId, runId)
          ) return false;
          setIndependentSessionKey(activation.handle);
          lastOpenedIndependentSessionKeyRef.current = activation.handle;
          setIndependentOpen(true);
          setIndependentPresentationEpoch((current) => current + 1);
          refreshSessions();
          return true;
        },
        focusCurrent(_consumer, permit) {
          if (!permit.isCurrent() || !isCurrentRequest(requestId, runId)) {
            return false;
          }
          setMainOpen(true);
          setMainPresentationEpoch((current) => current + 1);
          return true;
        },
        focusIndependent(consumer, permit) {
          if (!permit.isCurrent() || !isCurrentRequest(requestId, runId)) {
            return false;
          }
          lastOpenedIndependentSessionKeyRef.current = consumer.handle;
          setIndependentOpen(true);
          setIndependentPresentationEpoch((current) => current + 1);
          return true;
        },
        async decideDirty(consumer) {
          return new Promise<"save" | "discard" | "cancel">((resolve) => {
            void sharedEditorLifecycleController.requestParticipant({
              participantId: `experiment-run-independent:${consumer.handle}`,
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
            [
              input.ui(`文件：${selected.fileName}`),
              input.ui(`位置：${selected.locationMode}`),
              input.ui(`大小：${selected.byteLength} bytes`),
              input.ui(`编码：${selected.encoding}`),
              input.ui("确认只登记 FileRef 元数据；不会设为当前稿或默认稿，也不会写入文件。")
            ].join("\n")
          )
            ? "confirm"
            : "cancel";
        },
        async confirmActivationRetry({ fileName }) {
          return window.confirm(
            input.ui(`“${fileName}”的登记已保留。是否重试打开？`)
          );
        }
      };
      const outcome = await openProtocol.execute(adapter);
      if (!isCurrentRequest(requestId, runId)) return false;
      const success = [
        "current-session-reused",
        "current-session-activated",
        "independent-session-reused",
        "activation-succeeded"
      ].includes(outcome.status);
      const canceled = outcome.status === "picker-cancelled" ||
        outcome.status === "registration-declined" ||
        outcome.status === "operation-cancelled";
      if (!forFormalSwitch || !success) showResult(
        success ? "success" : canceled ? "info" : "error",
        "open",
        success
          ? input.ui("Run 文稿已打开。")
          : canceled
            ? input.ui("已取消打开，未产生新的持久化副作用。")
            : input.ui(
                `Run 文稿打开未完成：${outcome.errorCode ?? outcome.status}`
              ),
        `experimentRun.manuscript.independentOpen.${outcome.status}`,
        outcome.status.startsWith("current-") ? "current" : "independent"
      );
      return success;
    } catch {
      if (isCurrentRequest(requestId, runId)) {
        showResult(
          "error",
          "open",
          input.ui("所选 Run 文稿无法打开。"),
          "experimentRun.manuscript.openDocument"
        );
      }
      return false;
    } finally {
      if (isCurrentRequest(requestId, runId)) setBusy(false);
    }
  }

  async function requestFormalSwitch(markdown?: string, explicitTargetSessionKey?: string) {
    const runId = input.runId;
    const targetSessionKey = explicitTargetSessionKey ?? independentSessionKey;
    if (!runId || !targetSessionKey) return false;
    if (markdown !== undefined) updateDraft("independent", markdown);
    const requestId = ++requestCounter.current;
    setBusy(true);
    clearActionResults();
    try {
      for (let decisionCount = 0; decisionCount < 3; decisionCount += 1) {
        const preflight = await formalSwitchService.preflight(runId, targetSessionKey);
        if (!isCurrentRequest(requestId, runId)) return false;
        if (preflight.status === "already-current") {
          showResult("info", "switch", input.ui("所选文稿已经是当前文稿。"), "experimentRun.manuscript.formalSwitchNoop");
          return true;
        }
        if (preflight.status === "decision-required") {
          const target = preflight.scope === "target";
          await sharedEditorLifecycleController.requestParticipant({
            participantId: target
              ? `experiment-run-independent:${preflight.sessionKey}`
              : `experiment-run-current:${preflight.sessionKey}`,
            trigger: "switch-manuscript",
            continuationIntent: "SWITCH_MANUSCRIPT",
            surface: "application",
            continuation: async () => {
              await requestFormalSwitch(undefined, targetSessionKey);
            }
          });
          return false;
        }
        if (preflight.status === "error") {
          showResult("error", "switch", projectFormalSwitchFailure(preflight, input.ui, { reload: true, reopen: true, wait: true }).summary, "experimentRun.manuscript.formalSwitchPreflight");
          return false;
        }
        const switchCopy = buildFormalSwitchConfirmationCopy({
          targetFileName: preflight.targetFileName,
          ownerDisplayName: input.ui("Run 文稿"),
          descriptorLookupIdentity: {
            ownerType: "experimentRun",
            channel: "primary"
          },
          translate: input.ui,
          resolveLabel: (field) => input.ui(field.displayLabel),
          fieldActions: (preflight.outlineReplacements ?? []).map((replacement) => ({
            key: replacement.key,
            action: replacement.action
          }))
        });
        const confirmed = await requestChoice({
          kind: "formal-switch-confirm",
          title: input.ui("切换当前文稿"),
          message: switchCopy.message,
          options: [
            { value: "confirm", label: input.ui("确认切换"), emphasis: "primary" },
            { value: "cancel", label: input.ui("取消") }
          ]
        });
        if (!isCurrentRequest(requestId, runId) || confirmed !== "confirm") return false;
        const result = await formalSwitchService.confirm(preflight.preflightToken);
        if (!isCurrentRequest(requestId, runId)) return false;
        refreshSessions();
        if (result.status === "success") {
          setMainSessionKey(result.sessionKey);
          setMainPresentationEpoch((current) => current + 1);
          setMainOpen(true);
          setIndependentSessionKey(undefined);
          setIndependentOpen(false);
          setIndependentPresentationEpoch((current) => current + 1);
          try {
            await input.onSwitched?.(runId);
          } catch {
            if (isCurrentRequest(requestId, runId)) {
              showResult("error", "switch", projectFormalSwitchFailure(
                { error: { sideEffectSummary: { databaseCommitted: true } } }, input.ui
              ).summary, "experimentRun.manuscript.formalSwitchFailed");
            }
            return false;
          }
          if (!isCurrentRequest(requestId, runId)) return false;
          showResult("success", "switch", input.ui("Run 当前文稿已切换。"), "experimentRun.manuscript.formalSwitch");
          return true;
        }
        if (result.status === "recovery-required") {
          showResult("error", "switch", projectFormalSwitchFailure(result, input.ui).summary, "experimentRun.manuscript.formalSwitchRecovery");
          return false;
        }
        if (result.status === "canceled") return false;
        showResult("error", "switch", projectFormalSwitchFailure(result, input.ui, { reload: true, reopen: true, wait: true }).summary, "experimentRun.manuscript.formalSwitchFailed");
        return false;
      }
      showResult("warning", "switch", input.ui("文稿状态连续变化，请重新发起切换。"), "experimentRun.manuscript.formalSwitchStale");
      return false;
    } catch {
      if (isCurrentRequest(requestId, runId)) {
        showResult("error", "switch", input.ui("正式文稿切换失败。"), "experimentRun.manuscript.formalSwitchFailed");
      }
      return false;
    } finally {
      if (isCurrentRequest(requestId, runId)) setBusy(false);
    }
  }

  function updateDraft(mode: EditorMode, markdown: string) {
    const sessionKey = mode === "current" ? mainSessionKey : independentSessionKey;
    const session = sessionKey ? rawService.getSession(sessionKey) : undefined;
    if (!sessionKey || session?.accessMode === "read-only") return false;
    const result = rawService.updateDraft(sessionKey, markdown);
    refreshSessions();
    return result.status === "success";
  }

  async function readContext() {
    const runId = input.runId;
    if (!runId) return undefined;
    const result = await contextService.read(runId);
    if (ownerRef.current !== runId) return undefined;
    if (result.status !== "success") {
      showResult("error", "context", input.ui("Run 上下文摘要读取失败。"), "experimentRun.manuscript.contextSummary");
      return undefined;
    }
    return result.dto;
  }

  async function resolveContextSummaryMarkdown() {
    const session = mainSessionKey ? rawService.getSession(mainSessionKey) : undefined;
    if (
      !session || session.accessMode === "read-only" || session.recoveryRequired ||
      switchRecovery || saveAsRecovery
    ) {
      throw new Error(input.ui("当前 Run 文稿为只读或处于恢复状态，不能插入上下文摘要。"));
    }
    const dto = await readContext();
    if (!dto || dto.manuscript.readOnly || dto.manuscript.recoveryPending) {
      throw new Error(input.ui("Run 上下文摘要当前不可插入。"));
    }
    return buildExperimentRunContextSummaryMarkdown(dto);
  }

  async function switchDocument() {
    lastOpenedIndependentSessionKeyRef.current = undefined;
    const opened = await openDocument(true);
    if (!opened) return false;
    return requestFormalSwitch(
      undefined,
      lastOpenedIndependentSessionKeyRef.current
    );
  }

  async function saveAs(
    mode: EditorMode,
    value: string | ManuscriptSegmentDraftSnapshot = ""
  ) {
    const runId = input.runId;
    const sessionKey = mode === "current" ? mainSessionKey : independentSessionKey;
    if (!runId || !sessionKey || busy) return false;
    const requestId = ++requestCounter.current;
    saveAsPresentedSessionKeyRef.current = undefined;
    setBusy(true);
    try {
      const sourceSession = rawService.getSession(sessionKey);
      if (
        !sourceSession ||
        sourceSession.file.kind !== "durable"
      ) {
        showResult("error", "save-as", input.ui("Run 文稿另存为准备失败。"), "experimentRun.manuscript.saveAsPreflight");
        return false;
      }
      const result = await saveAsService.saveAs({
        runId,
        sourceSessionKey: sessionKey,
        sourceMode: mode,
        acknowledgePresentation: (permit) =>
          acknowledgeSaveAsPresentation(
            permit,
            runId,
            () => isCurrentRequest(requestId, runId)
          ),
        frozenDraftSnapshot: typeof value === "string" ? undefined : value
      });
      if (result.status === "canceled") {
        if (!isCurrentRequest(requestId, runId)) return false;
        showResult("info", "save-as", input.ui("已取消另存为；未创建文件或元数据。"), "experimentRun.manuscript.saveAsCanceled");
        return false;
      }
      if (result.status === "success" && "sessionKey" in result && result.sessionKey) {
        if (!isCurrentRequest(requestId, runId)) return false;
        if (saveAsPresentedSessionKeyRef.current !== result.sessionKey) {
          const records = await saveAsService.listUnresolved(runId);
          if (isCurrentRequest(requestId, runId)) setSaveAsRecovery(records[0]);
          showResult("error", "save-as", input.ui("另存为目标尚未完成独立编辑器接管，需要恢复处理。"), "experimentRun.manuscript.saveAsRecovery");
          return false;
        }
        setSaveAsRecovery(undefined);
        showResult("success", "save-as", input.ui("Run 文稿已另存为新文件，并在独立窗口打开。"), "experimentRun.manuscript.saveAs");
        return true;
      }
      if (!isCurrentRequest(requestId, runId)) return false;
      const records = await saveAsService.listUnresolved(runId);
      if (isCurrentRequest(requestId, runId)) setSaveAsRecovery(records[0]);
      showResult("error", "save-as", input.ui("另存为尚未安全完成，需要恢复处理。"), "experimentRun.manuscript.saveAsRecovery");
      return false;
    } finally {
      if (isCurrentRequest(requestId, runId)) setBusy(false);
    }
  }

  async function continueSaveAsRecovery() {
    const recovery = saveAsRecovery;
    const runId = input.runId;
    if (!recovery || !runId || busy) return false;
    setBusy(true);
    try {
      saveAsPresentedSessionKeyRef.current = undefined;
      const result = await saveAsService.recover(
        recovery.operationId,
        runId,
        (permit) =>
          acknowledgeSaveAsPresentation(
            permit,
            runId,
            () => ownerRef.current === runId
          )
      );
      if (result.status === "contained") {
        setSaveAsRecovery(undefined);
        showResult(
          "error",
          "save-as",
          input.ui(windowPContainmentFeedbackMessage(result.blockingCode)),
          "experimentRun.manuscript.saveAsRecoveryBlocked"
        );
        return false;
      }
      if (result.status === "success" && "sessionKey" in result && result.sessionKey) {
        if (saveAsPresentedSessionKeyRef.current !== result.sessionKey) {
          const records = await saveAsService.listUnresolved(runId);
          setSaveAsRecovery(records[0]);
          showResult("error", "save-as", input.ui("另存为恢复尚未完成独立编辑器接管。"), "experimentRun.manuscript.saveAsRecoveryBlocked");
          return false;
        }
        setSaveAsRecovery(undefined);
        showResult("success", "save-as", input.ui("另存为恢复已完成。"), "experimentRun.manuscript.saveAsRecovered");
        return true;
      }
      const records = await saveAsService.listUnresolved(runId);
      setSaveAsRecovery(records[0]);
      showResult(
        "error",
        "save-as",
        input.ui("另存为恢复仍需处理。"),
        "experimentRun.manuscript.saveAsRecoveryBlocked"
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function safeCancelSaveAsRecovery() {
    const recovery = saveAsRecovery;
    if (!recovery || recovery.phase !== "prepared" || busy) return false;
    setBusy(true);
    try {
      const result = await saveAsService.safeCancelRecovery(recovery.operationId);
      if (result.status !== "canceled") {
        showResult("error", "save-as", input.ui("该另存为操作不能安全取消。"), "experimentRun.manuscript.saveAsSafeCancelBlocked");
        return false;
      }
      setSaveAsRecovery(undefined);
      showResult("info", "save-as", input.ui("另存为操作已安全取消；未创建目标文件或元数据。"), "experimentRun.manuscript.saveAsSafeCanceled");
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function saveSessionWithExternalConfirmation(sessionKey: string) {
    let result = await rawService.save(sessionKey);
    if (result.status === "confirmation-required" && result.reason === "external-write") {
      const confirmed = await requestChoice({
        kind: "external-write",
        title: input.ui("确认保存外部 Run 文稿"),
        message: input.ui("该操作将直接更新原位置的外部 Markdown 文件，不创建副本，也不会改变当前稿或默认稿。是否继续？"),
        options: [
          { value: "confirm", label: input.ui("确认保存"), emphasis: "primary" },
          { value: "cancel", label: input.ui("取消") }
        ]
      });
      if (confirmed !== "confirm") return { status: "canceled" as const };
      result = await rawService.save(sessionKey, { confirmedExternalWrite: true });
    }
    return result;
  }

  async function save(mode: EditorMode, markdown: string) {
    const sessionKey = mode === "current" ? mainSessionKey : independentSessionKey;
    const session = sessionKey ? rawService.getSession(sessionKey) : undefined;
    if (!sessionKey || !session || session.accessMode === "read-only") {
      throw new Error(input.ui("当前 Run 文稿为只读，不能保存。"));
    }
    if (mode === "current") setCurrentActionResult(null);
    else setIndependentActionResult(null);
    const recovery = await refreshRecovery();
    if (recovery) {
      throw new Error(input.ui("正式文稿切换尚未恢复完成，当前 Run 文稿暂时不能保存。"));
    }
    rawService.updateDraft(sessionKey, markdown);
    refreshSessions();
    setBusy(true);
    try {
      const result = await saveSessionWithExternalConfirmation(sessionKey);
      refreshSessions();
      if (result.status === "canceled") return;
      return ordinarySavePresentation(
        result,
        { ownerType: "experiment_run", channel: "primary", ownerLabel: input.ui("Run") }
      );
    } finally {
      setBusy(false);
    }
  }

  async function reload(
    mode: EditorMode,
    markdown: string,
    lifecycleSettled = false
  ) {
    const sessionKey = mode === "current" ? mainSessionKey : independentSessionKey;
    if (!sessionKey) return false;
    if (!lifecycleSettled) {
      updateDraft(mode, markdown);
      const requested = await sharedEditorLifecycleController.requestParticipant({
        participantId: mode === "current"
          ? `experiment-run-current:${sessionKey}`
          : `experiment-run-independent:${sessionKey}`,
        trigger: "reload",
        continuationIntent: "RELOAD",
        surface: "application",
        continuation: async () => {
          await reload(mode, markdown, true);
        }
      });
      return requested.status === "continued";
    }
    const result = await rawService.reload(sessionKey);
    refreshSessions();
    if (result.status !== "success") {
      showResult("error", "reload", safeFailureMessage(result, input.ui("Run 文稿重新加载失败。")), "experimentRun.manuscript.reload", mode);
      return false;
    }
    if (mode === "current") setMainPresentationEpoch((current) => current + 1);
    else setIndependentPresentationEpoch((current) => current + 1);
    showResult("success", "reload", input.ui("Run 文稿已重新加载。"), "experimentRun.manuscript.reload", mode);
    return true;
  }

  function finishClosed(mode: EditorMode) {
    if (mode === "current") {
      setMainOpen(false);
      setCurrentActionResult(null);
    } else {
      setIndependentOpen(false);
      setIndependentSessionKey(undefined);
      saveAsPresentedSessionKeyRef.current = undefined;
      setIndependentActionResult(null);
    }
    refreshSessions();
  }

  async function discard(mode: EditorMode) {
    const sessionKey = mode === "current" ? mainSessionKey : independentSessionKey;
    if (!sessionKey) throw new Error("MANUSCRIPT_LIFECYCLE_SESSION_UNAVAILABLE");
    const result = await rawService.reload(sessionKey, "discard-and-reload");
    refreshSessions();
    if (result.status !== "success") {
      throw new Error(safeFailureMessage(result, input.ui("放弃 Run 文稿更改失败。")));
    }
  }

  async function close(mode: EditorMode) {
    if (mode === "current" && input.runId) {
      requestCounter.current += 1;
      openProtocol.cancelOwner({
        ownerType: "experimentRun",
        ownerId: input.runId,
        channel: "primary"
      });
    }
    const sessionKey = mode === "current" ? mainSessionKey : independentSessionKey;
    if (!sessionKey) return true;
    const result = await rawService.close(sessionKey);
    refreshSessions();
    if (result.status === "success") {
      finishClosed(mode);
      return true;
    }
    return false;
  }

  async function resolveChoice(value: ChoiceValue) {
    if (choiceResolverRef.current) {
      const resolve = choiceResolverRef.current;
      choiceResolverRef.current = null;
      setChoiceDialog(null);
      clearActionResults();
      resolve(value);
      return value === "confirm";
    }
    return false;
  }

  return {
    mainSessionKey,
    independentSessionKey,
    mainSession,
    independentSession,
    mainOpen,
    independentOpen,
    mainPresentationEpoch,
    independentPresentationEpoch,
    mainContentIdentity: mainSessionKey ? `${mainSessionKey}:${mainPresentationEpoch}` : undefined,
    independentContentIdentity: independentSessionKey ? `${independentSessionKey}:${independentPresentationEpoch}` : undefined,
    busy,
    choiceDialog,
    currentActionResult,
    independentActionResult,
    switchRecovery: recoveryDismissed ? undefined : switchRecovery,
    saveAsRecovery,
    openCurrent,
    openIndependent,
    openDocument,
    switchDocument,
    continueSwitchRecovery,
    safeCancelSwitchRecovery,
    continueSaveAsRecovery,
    safeCancelSaveAsRecovery,
    resolveContextSummaryMarkdown,
    saveCurrentAs: (value: string | ManuscriptSegmentDraftSnapshot = "") => saveAs("current", value),
    saveIndependentAs: (value: string | ManuscriptSegmentDraftSnapshot = "") => saveAs("independent", value),
    dismissSwitchRecovery: () => setRecoveryDismissed(true),
    updateCurrentDraft: (markdown: string) => updateDraft("current", markdown),
    updateIndependentDraft: (markdown: string) => updateDraft("independent", markdown),
    saveCurrent: (markdown: string) => save("current", markdown),
    saveIndependent: (markdown: string) => save("independent", markdown),
    reloadCurrent: (markdown: string) => reload("current", markdown),
    reloadIndependent: (markdown: string) => reload("independent", markdown),
    readCurrentSession: () => mainSessionKey
      ? rawService.getSession(mainSessionKey)
      : undefined,
    readIndependentSession: () => independentSessionKey
      ? rawService.getSession(independentSessionKey)
      : undefined,
    discardCurrent: () => discard("current"),
    discardIndependent: () => discard("independent"),
    closeCurrent: () => close("current"),
    closeIndependent: () => close("independent"),
    resolveChoice,
    dismissCurrentActionResult: () => setCurrentActionResult(null),
    dismissIndependentActionResult: () => setIndependentActionResult(null)
  };
}
