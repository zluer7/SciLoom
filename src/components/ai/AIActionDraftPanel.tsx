import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  applyAIActionDraftFromExplicitClick,
  canShowAIActionDraftApply,
  getAIActionDraftDisplayModel,
  getAIActionDraftUIStatus,
  getAIActionDraftUISupport,
  markAIActionDraftAcceptedLocally,
  parseAIActionDraftPayloadJson,
  resetAIActionDraftReviewState,
  type AIActionDraftUIStatus
} from "./aiActionDraftUIModel";
import { isActionDraftContextGuardErrorCode } from "../../services/actionDraftConfirmApplicationService";
import {
  actionDraftSourceTupleKey,
  canonicalTargetScopeKey,
  isExactMountedSelectionSnapshot
} from "../../services/actionDraftSourceTupleService";
import { parseAIActionDraftsFromText } from "../../services/aiDraftParserService";
import { createAIActionDraftManager } from "../../services/aiDraftManagerService";
import type { TranslationKey } from "../../i18n/translations";
import type {
  ActionDraftGenerationReadback,
  ActionDraftSourceTuple,
  AIActionDraftUnion,
  CanonicalTargetScope,
  DraftInstanceId,
  MountedSelectionSnapshot
} from "../../types/aiDraft";
import type { AIContextSourceRef } from "../../types/aiContext";

type AIActionDraftPanelProps = {
  responseText?: string;
  mountedConversationId?: string;
  mountedScopeIdentity?: CanonicalTargetScope;
  effectiveSourceAssistantMessageId?: string;
  effectiveSourceCallAttemptId?: string;
  userQuestion?: string;
  canGenerateDrafts?: boolean;
  onGenerateDraftText?: () => Promise<ActionDraftGenerationReadback>;
  sourceRefs?: AIContextSourceRef[];
  embedded?: boolean;
};

const statusKeys: Record<AIActionDraftUIStatus, TranslationKey> = {
  parsed: "aiDraftStatusPending",
  edited: "aiDraftStatusPending",
  accepted: "aiDraftStatusAccepted",
  previewed: "aiDraftStatusAccepted",
  applying: "aiDraftStatusApplying",
  written: "aiDraftStatusWritten",
  failed: "aiDraftStatusFailed",
  rejected: "aiDraftStatusRejected"
};

function payloadReason(draft: AIActionDraftUnion): string | undefined {
  const reason = (draft.proposedPayload as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
}

function targetDescription(draft: AIActionDraftUnion, fallback: string): string {
  return draft.target?.label || draft.writePreview?.targetLabel || fallback;
}

export function AIActionDraftPanel({
  responseText = "",
  mountedConversationId,
  mountedScopeIdentity,
  effectiveSourceAssistantMessageId,
  effectiveSourceCallAttemptId,
  userQuestion,
  canGenerateDrafts = false,
  onGenerateDraftText,
  sourceRefs = [],
  embedded = false
}: AIActionDraftPanelProps) {
  const { t } = useI18n();
  const managerRef = useRef(createAIActionDraftManager());
  const [drafts, setDrafts] = useState<AIActionDraftUnion[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<DraftInstanceId>();
  const [editingDraftId, setEditingDraftId] = useState<DraftInstanceId>();
  const [payloadText, setPayloadText] = useState("");
  const [editError, setEditError] = useState("");
  const [showTechnicalFields, setShowTechnicalFields] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [hasParsed, setHasParsed] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [parseError, setParseError] = useState("");
  const [applyingDraftId, setApplyingDraftId] = useState<DraftInstanceId>();
  const [activeSourceTuple, setActiveSourceTuple] = useState<ActionDraftSourceTuple>();
  const uiGenerationRef = useRef(0);
  const asyncGenerationRef = useRef(0);
  const mountedContextKey = [
    mountedConversationId ?? "",
    mountedScopeIdentity ? canonicalTargetScopeKey(mountedScopeIdentity) : "",
    effectiveSourceAssistantMessageId ?? "",
    effectiveSourceCallAttemptId ?? ""
  ].map((value) => `${value.length}:${value}`).join("|");
  const mountedContextKeyRef = useRef(mountedContextKey);
  if (mountedContextKeyRef.current !== mountedContextKey) {
    mountedContextKeyRef.current = mountedContextKey;
    uiGenerationRef.current += 1;
    asyncGenerationRef.current += 1;
  }

  const activeTupleKey = activeSourceTuple
    ? actionDraftSourceTupleKey(activeSourceTuple)
    : undefined;
  const tupleMatchesMountedSource = Boolean(
    activeSourceTuple &&
    mountedConversationId === activeSourceTuple.conversationId &&
    mountedScopeIdentity?.scopeKind ===
      activeSourceTuple.canonicalBusinessScopeIdentity.scopeKind &&
    mountedScopeIdentity?.scopeId ===
      activeSourceTuple.canonicalBusinessScopeIdentity.scopeId &&
    effectiveSourceAssistantMessageId ===
      activeSourceTuple.effectiveSourceAssistantMessageId &&
    effectiveSourceCallAttemptId ===
      activeSourceTuple.sourceOrdinaryChatCallAttemptId
  );
  const currentMountedSelectionRef = useRef<MountedSelectionSnapshot>();
  currentMountedSelectionRef.current = activeSourceTuple && activeTupleKey &&
    mountedConversationId && mountedScopeIdentity
    ? {
        conversationId: mountedConversationId,
        scopeIdentity: mountedScopeIdentity,
        tupleKey: activeTupleKey,
        uiGeneration: uiGenerationRef.current
      }
    : undefined;

  const selectedDraft = useMemo(
    () => drafts.find((draft) => draft.draftInstanceId === selectedDraftId),
    [drafts, selectedDraftId]
  );

  function refreshDrafts() {
    const nextDrafts = managerRef.current.snapshot().drafts;
    setDrafts(nextDrafts);
    setSelectedDraftId((current) => (
      current && nextDrafts.some((draft) => draft.draftInstanceId === current)
        ? current
        : undefined
    ));
  }

  useEffect(() => {
    managerRef.current.clear();
    setDrafts([]);
    setSelectedDraftId(undefined);
    setEditingDraftId(undefined);
    setPayloadText("");
    setEditError("");
    setShowTechnicalFields(false);
    setWarnings([]);
    setHasParsed(false);
    setIsGenerating(false);
    setGenerationError("");
    setParseError("");
    setApplyingDraftId(undefined);
    setActiveSourceTuple(undefined);
  }, [mountedContextKey]);

  useEffect(() => {
    if (!selectedDraft || editingDraftId !== selectedDraft.draftInstanceId) return;
    setPayloadText(JSON.stringify(selectedDraft.proposedPayload, null, 2));
    setEditError("");
  }, [editingDraftId, selectedDraft]);

  async function handleGenerateAndParse() {
    if (!onGenerateDraftText) return;
    const requestGeneration = asyncGenerationRef.current + 1;
    asyncGenerationRef.current = requestGeneration;
    uiGenerationRef.current += 1;
    currentMountedSelectionRef.current = undefined;
    const requestedMountedContextKey = mountedContextKey;
    setIsGenerating(true);
    setGenerationError("");
    setParseError("");
    setHasParsed(false);
    setSelectedDraftId(undefined);
    setEditingDraftId(undefined);
    setShowTechnicalFields(false);
    managerRef.current.clear();
    setDrafts([]);
    setWarnings([]);
    setActiveSourceTuple(undefined);
    try {
      const generation = await onGenerateDraftText();
      if (
        asyncGenerationRef.current !== requestGeneration ||
        mountedContextKeyRef.current !== requestedMountedContextKey ||
        generation.sourceTuple.conversationId !== mountedConversationId ||
        generation.sourceTuple.canonicalBusinessScopeIdentity.scopeKind !==
          mountedScopeIdentity?.scopeKind ||
        generation.sourceTuple.canonicalBusinessScopeIdentity.scopeId !==
          mountedScopeIdentity?.scopeId ||
        generation.sourceTuple.effectiveSourceAssistantMessageId !==
          effectiveSourceAssistantMessageId ||
        generation.sourceTuple.sourceOrdinaryChatCallAttemptId !==
          effectiveSourceCallAttemptId
      ) {
        return;
      }
      let batch;
      try {
        batch = parseAIActionDraftsFromText(generation.generatedText, {
          sourceTuple: generation.sourceTuple,
          question: userQuestion?.trim() || undefined,
          sourceRefs: sourceRefs.map((sourceRef) => ({
            sourceType: "aiContext",
            module: sourceRef.module,
            entityType: sourceRef.entityType,
            entityId: sourceRef.entityId,
            label: sourceRef.label,
            field: sourceRef.field,
            aiContextSourceRef: sourceRef
          }))
        });
      } catch (error) {
        const message = error instanceof Error && error.message.trim()
          ? error.message.trim()
          : t("aiDraftParseFailedFallback");
        setParseError(Array.from(message).slice(0, 120).join(""));
        return;
      }
      if (batch.warnings.some((warning) => warning.code === "parse_failed")) {
        setParseError(t("aiDraftParseFailedFallback"));
        return;
      }
      managerRef.current.addBatch(batch);
      setActiveSourceTuple(batch.sourceTuple);
      setWarnings(batch.drafts.length ? batch.warnings.map((warning) => warning.message) : []);
      setHasParsed(true);
      refreshDrafts();
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : t("aiDraftGenerationFailedFallback");
      setGenerationError(Array.from(message).slice(0, 120).join(""));
    } finally {
      if (asyncGenerationRef.current === requestGeneration) {
        setIsGenerating(false);
      }
    }
  }

  function handleStartEdit(draft: AIActionDraftUnion) {
    setSelectedDraftId(draft.draftInstanceId);
    setEditingDraftId(draft.draftInstanceId);
    setPayloadText(JSON.stringify(draft.proposedPayload, null, 2));
    setEditError("");
  }

  function handleSaveEdit(draftInstanceId: DraftInstanceId) {
    const parsed = parseAIActionDraftPayloadJson(payloadText);
    if (!parsed.success) {
      setEditError(t("aiDraftInvalidJson"));
      return;
    }
    managerRef.current.editDraft(draftInstanceId, { proposedPayload: parsed.payload });
    setEditingDraftId(undefined);
    setEditError("");
    refreshDrafts();
  }

  function handleAccept(draftInstanceId: DraftInstanceId) {
    const draft = managerRef.current.getDraft(draftInstanceId);
    if (!draft) return;
    managerRef.current.updateDraft(markAIActionDraftAcceptedLocally(draft));
    setSelectedDraftId(draftInstanceId);
    setEditingDraftId(undefined);
    refreshDrafts();
  }

  function handleReject(draftInstanceId: DraftInstanceId) {
    managerRef.current.rejectDraft(draftInstanceId, t("aiDraftRejectedMessage"));
    setSelectedDraftId(draftInstanceId);
    setEditingDraftId(undefined);
    refreshDrafts();
  }

  function handleUndo(draftInstanceId: DraftInstanceId) {
    const draft = managerRef.current.getDraft(draftInstanceId);
    if (!draft) return;
    managerRef.current.updateDraft(resetAIActionDraftReviewState(draft));
    setSelectedDraftId(draftInstanceId);
    setEditingDraftId(undefined);
    refreshDrafts();
  }

  function handlePreview(draftInstanceId: DraftInstanceId) {
    managerRef.current.acceptDraft(draftInstanceId);
    setSelectedDraftId(draftInstanceId);
    refreshDrafts();
  }

  async function handleApply(draftInstanceId: DraftInstanceId) {
    const draft = managerRef.current.getDraft(draftInstanceId);
    const sourceTuple = activeSourceTuple;
    const mountedSelectionSnapshot = currentMountedSelectionRef.current;
    if (
      !draft || !sourceTuple || !mountedSelectionSnapshot ||
      !tupleMatchesMountedSource
    ) return;

    const operationTupleKey = actionDraftSourceTupleKey(sourceTuple);
    setApplyingDraftId(draftInstanceId);
    try {
      const result = await applyAIActionDraftFromExplicitClick({
        draft,
        sourceTuple,
        mountedSelectionSnapshot,
        readCurrentMountedSelection: () => {
          const current = currentMountedSelectionRef.current;
          if (!current) throw new Error("Mounted Action Draft context is unavailable.");
          return current;
        }
      });
      const current = currentMountedSelectionRef.current;
      const mayPresentResult = Boolean(
        current &&
        isExactMountedSelectionSnapshot(mountedSelectionSnapshot, current) &&
        current.tupleKey === operationTupleKey
      );
      if (!mayPresentResult) return;
      if (isActionDraftContextGuardErrorCode(result.errorCode)) {
        managerRef.current.clear();
        setDrafts([]);
        setSelectedDraftId(undefined);
        setEditingDraftId(undefined);
        setActiveSourceTuple(undefined);
        setGenerationError(result.errorMessage ?? result.message ?? "Action Draft context changed.");
        return;
      }
      managerRef.current.markDraftWritten(draftInstanceId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("aiDraftUnexpectedError");
      const current = currentMountedSelectionRef.current;
      if (
        current &&
        isExactMountedSelectionSnapshot(mountedSelectionSnapshot, current)
      ) {
        managerRef.current.markDraftFailed(draftInstanceId, message);
      }
    } finally {
      const current = currentMountedSelectionRef.current;
      if (
        current &&
        isExactMountedSelectionSnapshot(mountedSelectionSnapshot, current)
      ) {
        setApplyingDraftId(undefined);
        refreshDrafts();
      }
    }
  }

  function renderDraftList() {
    if (!drafts.length) {
      return <p className="ai-action-draft-panel__feedback">{t("aiDraftSelectDraft")}</p>;
    }

    return (
      <div className="ai-action-draft-panel__list" role="list">
        {drafts.map((draft) => {
          const display = getAIActionDraftDisplayModel(draft, t("aiDraftUntitled"));
          const status = getAIActionDraftUIStatus(
            draft,
            applyingDraftId === draft.draftInstanceId
          );
          const isSelected = selectedDraftId === draft.draftInstanceId;
          const isHandled = status === "accepted" || status === "previewed" || status === "rejected";
          const canMutate = status !== "applying" && status !== "written" && status !== "failed";
          const canAccept = canMutate && getAIActionDraftUISupport(draft) === "enabled" && !isHandled;

          return (
            <article
              className={`ai-action-draft-list-card${isSelected ? " ai-action-draft-list-card--selected" : ""}`}
              key={draft.draftInstanceId}
              role="listitem"
            >
              <button
                className="ai-action-draft-list-card__summary"
                type="button"
                onClick={() => {
                  setSelectedDraftId(draft.draftInstanceId);
                  setEditingDraftId(undefined);
                }}
              >
                <span className="ai-operation-classification">待执行操作</span>
                <span className="ai-action-draft-list-card__type">
                  <span>{t(display.actionKey)}</span>
                  <strong>{t(display.entityKey)}</strong>
                </span>
                <span className="ai-action-draft-list-card__title">{display.title}</span>
              </button>
              <div className="ai-action-draft-list-card__actions">
                {status === "accepted" || status === "previewed" ? (
                  <>
                    <span>{t("aiDraftStatusAccepted")}</span>
                    <button type="button" onClick={() => handleUndo(draft.draftInstanceId)}>{t("aiDraftUndo")}</button>
                  </>
                ) : status === "rejected" ? (
                  <>
                    <span>{t("aiDraftStatusRejected")}</span>
                    <button type="button" onClick={() => handleUndo(draft.draftInstanceId)}>{t("aiDraftUndo")}</button>
                  </>
                ) : status === "written" || status === "failed" || status === "applying" ? (
                  <span>{t(statusKeys[status])}</span>
                ) : (
                  <>
                    <button type="button" onClick={() => handleStartEdit(draft)}>{t("aiDraftEditShort")}</button>
                    {canAccept ? <button type="button" onClick={() => handleAccept(draft.draftInstanceId)}>{t("aiDraftAcceptShort")}</button> : null}
                    {canMutate ? <button type="button" onClick={() => handleReject(draft.draftInstanceId)}>{t("aiDraftRejectShort")}</button> : null}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  function renderDraftDetails() {
    if (!selectedDraft) {
      return (
        <div className="ai-action-draft-detail ai-action-draft-detail--empty">
          {t("aiDraftSelectDraft")}
        </div>
      );
    }

    const display = getAIActionDraftDisplayModel(selectedDraft, t("aiDraftUntitled"));
    const status = getAIActionDraftUIStatus(
      selectedDraft,
      applyingDraftId === selectedDraft.draftInstanceId
    );
    const isEditing = editingDraftId === selectedDraft.draftInstanceId;
    const canPreview = status === "accepted" && !selectedDraft.writePreview;
    const canApply = !applyingDraftId && tupleMatchesMountedSource &&
      canShowAIActionDraftApply(selectedDraft);
    const applyResult = selectedDraft.result.applyResult;
    const affectedEntity = applyResult?.createdEntity ?? applyResult?.updatedEntity;

    return (
      <article className="ai-action-draft-detail">
        <header className="ai-action-draft-detail__header">
          <span className="ai-operation-classification">待执行操作</span>
          <span className="ai-action-draft-list-card__type">
            <span>{t(display.actionKey)}</span>
            <strong>{t(display.entityKey)}</strong>
          </span>
          <h4>{display.title}</h4>
        </header>

        {selectedDraft.summary ? (
          <section className="ai-action-draft-detail__section">
            <strong>{t("aiDraftSummary")}</strong>
            <p>{selectedDraft.summary}</p>
          </section>
        ) : null}
        {selectedDraft.detail ? (
          <section className="ai-action-draft-detail__section">
            <strong>{t("aiDraftDetail")}</strong>
            <p>{selectedDraft.detail}</p>
          </section>
        ) : null}

        <dl className="ai-action-draft-detail__meta">
          <div><dt>{t("aiDraftTarget")}</dt><dd>{targetDescription(selectedDraft, t(display.entityKey))}</dd></div>
          <div><dt>{t("aiDraftSources")}</dt><dd>{selectedDraft.sourceRefs.length}</dd></div>
          <div><dt>{t("aiDraftReason")}</dt><dd>{payloadReason(selectedDraft) ?? t("notProvided")}</dd></div>
          <div><dt>{t("aiDraftCurrentStatus")}</dt><dd>{t(statusKeys[status])}</dd></div>
        </dl>

        {isEditing ? (
          <div className="ai-action-draft-card__editor">
            <label htmlFor={`ai-draft-payload-${selectedDraft.draftInstanceId}`}>{t("aiDraftPayload")}</label>
            <textarea
              id={`ai-draft-payload-${selectedDraft.draftInstanceId}`}
              value={payloadText}
              onChange={(event) => {
                setPayloadText(event.target.value);
                setEditError("");
              }}
            />
            {editError ? <p className="ai-action-draft-card__error" role="alert">{editError}</p> : null}
            <div className="ai-action-draft-card__actions">
              <button type="button" onClick={() => setEditingDraftId(undefined)}>{t("aiDraftCancelEditShort")}</button>
              <button type="button" onClick={() => handleSaveEdit(selectedDraft.draftInstanceId)}>{t("aiDraftSaveEditShort")}</button>
            </div>
          </div>
        ) : null}

        {selectedDraft.writePreview ? (
          <section className="ai-action-draft-card__preview">
            <strong>{t("aiDraftPreview")}</strong>
            <p>{selectedDraft.writePreview.impactSummary || selectedDraft.writePreview.actionLabel}</p>
            <dl>
              <div><dt>{t("aiDraftWillCreate")}</dt><dd>{selectedDraft.writePreview.willCreate.map((item) => item.label || item.entityType).join(", ") || t("aiDraftNoItems")}</dd></div>
              <div><dt>{t("aiDraftWillUpdate")}</dt><dd>{selectedDraft.writePreview.willUpdate.map((item) => item.label || item.entityType).join(", ") || t("aiDraftNoItems")}</dd></div>
            </dl>
            {selectedDraft.writePreview.fieldChanges.length ? (
              <ul>
                {selectedDraft.writePreview.fieldChanges.map((change) => (
                  <li key={`${change.field}-${change.operation}`}>
                    <strong>{change.label || change.field}</strong>: {change.proposedValueSummary || change.operation}
                  </li>
                ))}
              </ul>
            ) : null}
            <strong>{t("aiDraftWillNotModify")}</strong>
            <ul>
              {selectedDraft.writePreview.willNotModify.map((item) => <li key={item}>{item}</li>)}
            </ul>
            {selectedDraft.writePreview.warnings.length ? (
              <div className="ai-action-draft-card__warning">
                <strong>{t("aiDraftWarnings")}</strong>
                <ul>{selectedDraft.writePreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            ) : null}
          </section>
        ) : null}

        {applyResult ? (
          <div
            className={`ai-action-draft-card__result ai-action-draft-card__result--${applyResult.success ? "success" : "failed"}`}
            role="status"
          >
            <strong>{applyResult.success ? t("aiDraftApplySuccess") : t("aiDraftApplyFailed")}</strong>
            {affectedEntity ? <p>{t("aiDraftEntity")}: {affectedEntity.entityType} / {affectedEntity.entityId}</p> : null}
            {!applyResult.success && applyResult.errorCode ? <p>{t("aiDraftErrorCode")}: {applyResult.errorCode}</p> : null}
            {!applyResult.success && applyResult.errorMessage ? <p>{applyResult.errorMessage}</p> : null}
            {applyResult.message ? <p>{applyResult.message}</p> : null}
            {applyResult.appliedAt ? <p>{t("aiDraftAppliedAt")}: {applyResult.appliedAt}</p> : null}
          </div>
        ) : null}

        <div className="ai-action-draft-card__actions">
          {!isEditing && status !== "written" && status !== "failed" && status !== "rejected" ? (
            <button type="button" onClick={() => handleStartEdit(selectedDraft)}>{t("aiDraftEditShort")}</button>
          ) : null}
          {canPreview ? (
            <button type="button" onClick={() => handlePreview(selectedDraft.draftInstanceId)}>{t("aiDraftPreviewAction")}</button>
          ) : null}
          {canApply ? (
            <button className="ai-action-draft-card__apply" type="button" onClick={() => handleApply(selectedDraft.draftInstanceId)}>
              {applyingDraftId === selectedDraft.draftInstanceId ? t("aiDraftStatusApplying") : t("aiDraftConfirmApply")}
            </button>
          ) : null}
        </div>

        {!embedded ? (
          <details
            className="ai-action-draft-detail__technical"
            open={showTechnicalFields}
            onToggle={(event) => setShowTechnicalFields(event.currentTarget.open)}
          >
            <summary>{showTechnicalFields ? t("aiDraftHideTechnicalFields") : t("aiDraftShowTechnicalFields")}</summary>
            <dl>
              <div><dt>draftInstanceId</dt><dd>{selectedDraft.draftInstanceId}</dd></div>
              <div><dt>draftType</dt><dd>{selectedDraft.draftType}</dd></div>
              <div><dt>targetType</dt><dd>{selectedDraft.targetModule} / {selectedDraft.targetEntityType}</dd></div>
              <div><dt>targetId</dt><dd>{selectedDraft.targetEntityId ?? selectedDraft.target?.entityId ?? t("notProvided")}</dd></div>
              <div><dt>sourceRefs</dt><dd>{selectedDraft.sourceRefs.length}</dd></div>
            </dl>
            <pre>{JSON.stringify(selectedDraft.proposedPayload, null, 2)}</pre>
          </details>
        ) : null}
      </article>
    );
  }

  return (
    <section
      className={`ai-action-draft-panel${embedded ? " ai-action-draft-panel--embedded" : ""}`}
      aria-labelledby="ai-action-draft-panel-title"
    >
      {!embedded ? (
        <>
          <div className="global-ai-chat-panel__section-heading">
            <h3 id="ai-action-draft-panel-title">{t("aiDraftPanelTitle")}</h3>
            <span>{t("aiDraftPanelBadge")}</span>
          </div>
          <p>{t("aiDraftPanelNotice")}</p>
        </>
      ) : <h3 className="global-ai-chat-panel__sr-only" id="ai-action-draft-panel-title">AI操作建议</h3>}

      <button
        className="ai-action-draft-panel__parse"
        type="button"
        disabled={
          !responseText.trim() ||
          !mountedConversationId?.trim() ||
          !mountedScopeIdentity?.scopeId.trim() ||
          !effectiveSourceAssistantMessageId?.trim() ||
          !effectiveSourceCallAttemptId?.trim() ||
          !canGenerateDrafts ||
          !onGenerateDraftText ||
          isGenerating ||
          Boolean(applyingDraftId)
        }
        onClick={handleGenerateAndParse}
      >
        {isGenerating
          ? (embedded ? "正在整理…" : t("aiDraftGeneratingAndParsing"))
          : (embedded ? "整理当前回答中的操作建议" : t("aiDraftGenerateAndParse"))}
      </button>

      {!responseText.trim() ? <p className="ai-action-draft-panel__feedback">{t("aiDraftWaitForGeneration")}</p> : null}
      {responseText.trim() && (!mountedScopeIdentity?.scopeId.trim() || !canGenerateDrafts) ? <p className="ai-action-draft-panel__feedback">{t("aiDraftSelectProject")}</p> : null}
      {hasParsed && drafts.length === 0 ? <p className="ai-action-draft-panel__feedback" aria-live="polite">{t("aiDraftNone")}</p> : null}
      {generationError ? <p className="ai-action-draft-panel__feedback ai-action-draft-panel__feedback--error" role="alert">{t("aiDraftGenerationFailed")}: {generationError}</p> : null}
      {parseError ? <p className="ai-action-draft-panel__feedback ai-action-draft-panel__feedback--error" role="alert">{t("aiDraftParseFailed")}: {parseError}</p> : null}

      {warnings.length ? (
        <details className="ai-action-draft-panel__warnings">
          <summary>{t("aiDraftWarnings")} ({warnings.length})</summary>
          <ul>{warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
        </details>
      ) : null}

      <div className="ai-action-draft-panel__workspace">
        <section className="ai-action-draft-panel__list-section" aria-label={t("aiDraftListTitle")}>
          <strong>{t("aiDraftListTitle")}</strong>
          {renderDraftList()}
        </section>
        <section className="ai-action-draft-panel__detail-section" aria-label={t("aiDraftDetailTitle")}>
          <strong>{t("aiDraftDetailTitle")}</strong>
          {renderDraftDetails()}
        </section>
      </div>
    </section>
  );
}
