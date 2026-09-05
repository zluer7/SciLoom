import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/translations";
import type {
  AIActionDraftPayload,
  AIActionDraftUnion,
  DraftInstanceId
} from "../../types/aiDraft";
import {
  canShowAIActionDraftApply,
  getAIActionDraftUIStatus,
  getAIActionDraftUISupport,
  parseAIActionDraftPayloadJson,
  type AIActionDraftUIStatus,
  type AIActionDraftUISupport
} from "./aiActionDraftUIModel";

type AIActionDraftCardProps = {
  draft: AIActionDraftUnion;
  isApplying: boolean;
  onEdit: (draftInstanceId: DraftInstanceId, payload: AIActionDraftPayload) => void;
  onAccept: (draftInstanceId: DraftInstanceId) => void;
  onReject: (draftInstanceId: DraftInstanceId) => void;
  onApply: (draftInstanceId: DraftInstanceId) => void;
};

const supportKeys: Record<AIActionDraftUISupport, TranslationKey> = {
  enabled: "aiDraftSupportEnabled",
  postponed: "aiDraftSupportPostponed",
  forbidden: "aiDraftSupportForbidden"
};

const statusKeys: Record<AIActionDraftUIStatus, TranslationKey> = {
  parsed: "aiDraftStatusParsed",
  edited: "aiDraftStatusEdited",
  accepted: "aiDraftStatusAccepted",
  previewed: "aiDraftStatusPreviewed",
  applying: "aiDraftStatusApplying",
  written: "aiDraftStatusWritten",
  failed: "aiDraftStatusFailed",
  rejected: "aiDraftStatusRejected"
};

export function AIActionDraftCard({
  draft,
  isApplying,
  onEdit,
  onAccept,
  onReject,
  onApply
}: AIActionDraftCardProps) {
  const { t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [payloadText, setPayloadText] = useState(() =>
    JSON.stringify(draft.proposedPayload, null, 2)
  );
  const [editError, setEditError] = useState("");
  const support = getAIActionDraftUISupport(draft);
  const status = getAIActionDraftUIStatus(draft, isApplying);
  const canMutateLocalDraft = !isApplying && status !== "written" && status !== "rejected";
  const canAccept = canMutateLocalDraft && support === "enabled" &&
    draft.result.reviewStatus !== "accepted";
  const canApply = !isApplying && canShowAIActionDraftApply(draft);
  const applyResult = draft.result.applyResult;
  const affectedEntity = applyResult?.createdEntity ?? applyResult?.updatedEntity;

  useEffect(() => {
    setPayloadText(JSON.stringify(draft.proposedPayload, null, 2));
    setEditError("");
  }, [draft.proposedPayload]);

  function handleSaveEdit() {
    const parsed = parseAIActionDraftPayloadJson(payloadText);
    if (!parsed.success) {
      setEditError(t("aiDraftInvalidJson"));
      return;
    }
    onEdit(draft.draftInstanceId, parsed.payload);
    setEditError("");
    setIsEditing(false);
  }

  return (
    <article className={`ai-action-draft-card ai-action-draft-card--${support}`}>
      <header className="ai-action-draft-card__header">
        <div>
          <strong>{draft.title}</strong>
          <code>{draft.draftType}</code>
        </div>
        <div className="ai-action-draft-card__badges">
          <span>{t(supportKeys[support])}</span>
          <span>{t(statusKeys[status])}</span>
        </div>
      </header>

      {draft.summary ? <p>{draft.summary}</p> : null}
      {status === "accepted" && !draft.writePreview ? (
        <p className="ai-action-draft-card__warning" role="status">
          {t("aiDraftPreviewRequired")}
        </p>
      ) : null}
      {!applyResult && draft.result.message ? (
        <p className="ai-action-draft-card__state-message">{draft.result.message}</p>
      ) : null}
      <dl className="ai-action-draft-card__meta">
        <div><dt>{t("aiDraftTarget")}</dt><dd>{draft.targetModule} / {draft.targetEntityType}</dd></div>
        <div><dt>{t("aiDraftSources")}</dt><dd>{draft.sourceRefs.length}</dd></div>
      </dl>

      {isEditing ? (
        <div className="ai-action-draft-card__editor">
          <label htmlFor={`ai-draft-payload-${draft.draftInstanceId}`}>{t("aiDraftPayload")}</label>
          <textarea
            id={`ai-draft-payload-${draft.draftInstanceId}`}
            value={payloadText}
            onChange={(event) => {
              setPayloadText(event.target.value);
              setEditError("");
            }}
          />
          {editError ? <p className="ai-action-draft-card__error" role="alert">{editError}</p> : null}
          <div className="ai-action-draft-card__actions">
            <button type="button" onClick={handleSaveEdit}>{t("aiDraftSaveEdit")}</button>
            <button type="button" onClick={() => setIsEditing(false)}>{t("aiDraftCancelEdit")}</button>
          </div>
        </div>
      ) : null}

      {draft.writePreview ? (
        <details className="ai-action-draft-card__preview" open>
          <summary>{t("aiDraftPreview")}</summary>
          <p>{draft.writePreview.impactSummary || draft.writePreview.actionLabel}</p>
          <dl>
            <div><dt>{t("aiDraftWillCreate")}</dt><dd>{draft.writePreview.willCreate.map((item) => item.entityType).join(", ") || t("aiDraftNoItems")}</dd></div>
            <div><dt>{t("aiDraftWillUpdate")}</dt><dd>{draft.writePreview.willUpdate.map((item) => item.entityType).join(", ") || t("aiDraftNoItems")}</dd></div>
          </dl>
          {draft.writePreview.fieldChanges.length ? (
            <ul>
              {draft.writePreview.fieldChanges.map((change) => (
                <li key={`${change.field}-${change.operation}`}>
                  <strong>{change.label || change.field}</strong>: {change.proposedValueSummary || change.operation}
                </li>
              ))}
            </ul>
          ) : null}
          <strong>{t("aiDraftWillNotModify")}</strong>
          <ul>
            {draft.writePreview.willNotModify.map((item) => <li key={item}>{item}</li>)}
          </ul>
          {draft.writePreview.warnings.length ? (
            <div className="ai-action-draft-card__warning">
              <strong>{t("aiDraftWarnings")}</strong>
              <ul>{draft.writePreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          ) : null}
        </details>
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
        {canMutateLocalDraft ? (
          <button type="button" onClick={() => setIsEditing(true)}>{t("aiDraftEdit")}</button>
        ) : null}
        {canAccept ? (
          <button type="button" onClick={() => onAccept(draft.draftInstanceId)}>{t("aiDraftAccept")}</button>
        ) : null}
        {canMutateLocalDraft ? (
          <button type="button" onClick={() => onReject(draft.draftInstanceId)}>{t("aiDraftReject")}</button>
        ) : null}
        {canApply ? (
          <button className="ai-action-draft-card__apply" type="button" onClick={() => onApply(draft.draftInstanceId)}>
            {t("aiDraftConfirmApply")}
          </button>
        ) : null}
      </div>
    </article>
  );
}
