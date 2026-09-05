import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import { experimentRunService } from "../../../services/experimentRunService";
import { experimentService } from "../../../services/experimentService";
import { literatureService } from "../../../services/literatureService";
import {
  createOutputSourceLink,
  OUTPUT_SOURCE_ALLOWED_MATRIX,
  softDeleteOutputSourceLink,
  updateOutputSourceLink
} from "../../../services/outputSourceLinkService";
import { planningService } from "../../../services/planningService";
import type {
  OutputSourceCard,
  OutputSourceSummary,
  OutputSourceType
} from "../../../types/outputConversion";
import type {
  OutputEntityLayer,
  OutputEntityListItemDto
} from "../../../types/outputSelector";

type SourceCandidate = {
  id: string;
  title: string;
  summary?: string;
};

type CandidateMap = Record<OutputSourceType, SourceCandidate[]>;

type OutputSourceManagerProps = {
  ownerType: OutputEntityLayer;
  ownerId?: string;
  projectId: string;
  outputLists: Record<OutputEntityLayer, OutputEntityListItemDto[]>;
  summary: OutputSourceSummary | null;
  onSourcesChanged: () => Promise<void>;
};

const EMPTY_CANDIDATES: CandidateMap = {
  experiment: [],
  experimentRun: [],
  literature: [],
  review: [],
  other: [],
  resultItem: [],
  finding: [],
  outputCandidate: []
};

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/?)[^\s"'<>|]+/gi;

function safeDisplayText(value: string) {
  return value.replace(LOCAL_PATH_PATTERN, "[local path]").replace(/\s+/g, " ").trim();
}

function textValue(value: unknown, ...keys: string[]) {
  const row = value as Record<string, unknown>;
  for (const key of keys) {
    const field = row?.[key];
    if (typeof field === "string" && field.trim()) {
      return safeDisplayText(field);
    }
  }
  return "";
}

function normalizeDuplicateTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function OutputSourceManager({
  ownerType,
  ownerId,
  projectId,
  outputLists,
  summary,
  onSourcesChanged
}: OutputSourceManagerProps) {
  const { t } = useI18n();
  const allowedSourceTypes = OUTPUT_SOURCE_ALLOWED_MATRIX[ownerType] as readonly OutputSourceType[];
  const [candidateMap, setCandidateMap] = useState<CandidateMap>(EMPTY_CANDIDATES);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [sourceType, setSourceType] = useState<OutputSourceType>(allowedSourceTypes[0]);
  const [sourceId, setSourceId] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [editingCard, setEditingCard] = useState<OutputSourceCard | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [editingManualTitle, setEditingManualTitle] = useState("");
  const [removingCard, setRemovingCard] = useState<OutputSourceCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const sourceTypeLabels: Record<OutputSourceType, string> = {
    experiment: t("outputSourceTypeExperiment"),
    experimentRun: t("outputSourceTypeExperimentRun"),
    literature: t("outputSourceTypeLiterature"),
    review: t("outputSourceTypeReview"),
    other: t("outputSourceTypeOther"),
    resultItem: t("outputSourceTypeResultItem"),
    finding: t("outputSourceTypeFinding"),
    outputCandidate: t("outputSourceTypeOutputCandidate")
  };

  useEffect(() => {
    if (!allowedSourceTypes.includes(sourceType)) {
      setSourceType(allowedSourceTypes[0]);
      setSourceId("");
    }
  }, [allowedSourceTypes, sourceType]);

  useEffect(() => {
    if (!ownerId) {
      setCandidateMap(EMPTY_CANDIDATES);
      return;
    }
    let cancelled = false;
    setLoadingCandidates(true);
    void Promise.all([
      experimentService.getExperimentsByProject(projectId),
      experimentRunService.list(),
      literatureService.queryLiteratures({ primaryProjectId: projectId }),
      planningService.queryReviews({ projectId })
    ])
      .then(([experiments, runs, literatures, reviews]) => {
        if (cancelled) return;
        const experimentIds = new Set(experiments.map((item) => item.id));
        const externalCandidates: CandidateMap = {
          ...EMPTY_CANDIDATES,
          experiment: experiments.map((item) => ({
            id: item.id,
            title: safeDisplayText(item.title),
            summary: textValue(item, "description", "objective")
          })),
          experimentRun: runs
            .filter(
              (item) =>
                textValue(item, "projectId") === projectId ||
                experimentIds.has(textValue(item, "experimentId"))
            )
            .map((item) => ({
            id: item.id,
            title: textValue(item, "title", "runLabel") || t("outputSourceUntitled"),
              summary: textValue(item, "resultSummary", "conclusion")
            })),
          literature: literatures.map((item) => ({
            id: item.id,
            title: safeDisplayText(item.title),
            summary: textValue(item, "abstract")
          })),
          review: reviews.map((item) => ({
            id: item.id,
            title: safeDisplayText(item.title),
            summary: textValue(item, "summary", "content")
          })),
          resultItem: outputLists.resultItem.map((item) => ({
            id: item.id,
            title: safeDisplayText(item.title),
            summary: textValue(item, "summary", "structuredSummaryPreview")
          })),
          finding: outputLists.finding.map((item) => ({
            id: item.id,
            title: safeDisplayText(item.title),
            summary: textValue(item, "summary", "structuredSummaryPreview")
          })),
          outputCandidate: outputLists.outputCandidate.map((item) => ({
            id: item.id,
            title: safeDisplayText(item.title),
            summary: textValue(item, "summary", "structuredSummaryPreview")
          }))
        };
        setCandidateMap(externalCandidates);
      })
      .catch(() => {
        if (!cancelled) {
          setError(t("outputSourceCandidatesFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, outputLists, projectId, t]);

  const selectableCandidates = useMemo(
    () =>
      candidateMap[sourceType].filter(
        (candidate) => !(sourceType === ownerType && candidate.id === ownerId)
      ),
    [candidateMap, ownerId, ownerType, sourceType]
  );

  function resetAddDraft() {
    setSourceId("");
    setManualTitle("");
    setSourceNote("");
    setError("");
  }

  function readableError(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("already exists")) return t("outputSourceDuplicate");
    if (message.includes("cannot point to itself")) return t("outputSourceSelfInvalid");
    if (message.includes("cannot use") || message.includes("Unsupported")) {
      return t("outputSourceInvalid");
    }
    if (message.includes("required")) return t("outputSourceRequired");
    return t("outputSourceWriteFailed");
  }

  async function refreshAfterWrite(successMessage: string) {
    await onSourcesChanged();
    setNotice(successMessage);
  }

  async function addSource() {
    if (!ownerId) return;
    setError("");
    setNotice("");
    const selected = selectableCandidates.find((candidate) => candidate.id === sourceId);
    const title = sourceType === "other" ? manualTitle.trim() : selected?.title ?? "";
    if (sourceType === "other" && !title) {
      setError(t("outputSourceManualTitleRequired"));
      return;
    }
    if (sourceType !== "other" && !selected) {
      setError(t("outputSourceObjectRequired"));
      return;
    }
    const duplicate = summary?.cards.some((card) =>
      sourceType === "other"
        ? card.sourceType === "other" &&
          normalizeDuplicateTitle(card.sourceTitleSnapshot) === normalizeDuplicateTitle(title)
        : card.sourceType === sourceType && card.sourceId === sourceId
    );
    if (duplicate) {
      setError(t("outputSourceDuplicate"));
      return;
    }
    if (sourceType === ownerType && sourceId === ownerId) {
      setError(t("outputSourceSelfInvalid"));
      return;
    }

    setBusy(true);
    try {
      await createOutputSourceLink({
        projectId,
        ownerType,
        ownerId,
        sourceType,
        sourceId: sourceType === "other" ? null : sourceId,
        sourceTitleSnapshot: title,
        sourceSummarySnapshot: sourceType === "other" ? null : selected?.summary,
        sourceNote,
        relationType: sourceType === "other" ? "manual" : "supporting"
      });
      await refreshAfterWrite(t("outputSourceAdded"));
      resetAddDraft();
      setShowAdd(false);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }

  function startEditing(card: OutputSourceCard) {
    setEditingCard(card);
    setEditingNote(card.sourceNote ?? "");
    setEditingManualTitle(card.sourceType === "other" ? card.sourceTitleSnapshot : "");
    setRemovingCard(null);
    setError("");
    setNotice("");
  }

  async function saveSourceEdit() {
    if (!editingCard) return;
    if (editingCard.sourceType === "other" && !editingManualTitle.trim()) {
      setError(t("outputSourceManualTitleRequired"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await updateOutputSourceLink(editingCard.id, {
        sourceNote: editingNote,
        ...(editingCard.sourceType === "other"
          ? { sourceTitleSnapshot: editingManualTitle.trim() }
          : {})
      });
      await refreshAfterWrite(t("outputSourceUpdated"));
      setEditingCard(null);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeSource() {
    if (!removingCard) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const removed = await softDeleteOutputSourceLink(removingCard.id);
      if (!removed) throw new Error("Source relation could not be removed.");
      await refreshAfterWrite(t("outputSourceRemoved"));
      setRemovingCard(null);
      if (editingCard?.id === removingCard.id) setEditingCard(null);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="outputs-entity-form-card outputs-source-manager">
      <div className="outputs-source-manager-heading">
        <div>
          <h3>{t("outputSourceManage")}</h3>
          <p>{t("outputSourceManageBoundary")}</p>
        </div>
        {ownerId ? (
          <button
            type="button"
            className="outputs-source-manager-add"
            disabled={busy}
            onClick={() => {
              setShowAdd((current) => !current);
              setEditingCard(null);
              setRemovingCard(null);
              setError("");
              setNotice("");
            }}
          >
            {t("outputSourceAdd")}
          </button>
        ) : null}
      </div>

      {!ownerId ? (
        <p className="outputs-source-manager-empty">{t("outputSourceSaveOwnerFirst")}</p>
      ) : (
        <>
          {summary?.cards.length ? (
            <div className="outputs-source-manager-list">
              {summary.cards.map((card) => (
                <article
                  key={card.id}
                  className={`outputs-source-manager-item${card.sourceStatus === "missing" ? " is-missing" : ""}`}
                >
                  <div className="outputs-source-manager-item-main">
                    <strong>{card.sourceTitle}</strong>
                    <span>{sourceTypeLabels[card.sourceType]}</span>
                    {card.sourceNote ? <p>{card.sourceNote}</p> : null}
                    {card.sourceStatus === "missing" ? (
                      <small>{t("outputSourceMissing")}</small>
                    ) : null}
                  </div>
                  <div className="outputs-source-manager-actions">
                    <button type="button" disabled={busy} onClick={() => startEditing(card)}>
                      {t("outputSourceEditNote")}
                    </button>
                    <button
                      type="button"
                      className="is-remove"
                      disabled={busy}
                      onClick={() => {
                        setRemovingCard(card);
                        setEditingCard(null);
                        setShowAdd(false);
                        setError("");
                        setNotice("");
                      }}
                    >
                      {t("outputSourceRemove")}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="outputs-source-manager-empty">{t("outputSourceEmpty")}</p>
          )}

          {showAdd ? (
            <div className="outputs-source-manager-editor">
              <label className="outputs-entity-form-field">
                <span>{t("outputSourceType")}</span>
                <select
                  value={sourceType}
                  onChange={(event) => {
                    setSourceType(event.target.value as OutputSourceType);
                    setSourceId("");
                    setManualTitle("");
                    setError("");
                  }}
                >
                  {allowedSourceTypes.map((type) => (
                    <option key={type} value={type}>
                      {sourceTypeLabels[type]}
                    </option>
                  ))}
                </select>
              </label>
              {sourceType === "other" ? (
                <label className="outputs-entity-form-field">
                  <span>{t("outputSourceManualTitle")}</span>
                  <input
                    value={manualTitle}
                    onChange={(event) => setManualTitle(event.target.value)}
                  />
                </label>
              ) : (
                <label className="outputs-entity-form-field">
                  <span>{t("outputSourceObject")}</span>
                  <select
                    value={sourceId}
                    disabled={loadingCandidates}
                    onChange={(event) => setSourceId(event.target.value)}
                  >
                    <option value="">
                      {loadingCandidates
                        ? t("outputSourceCandidatesLoading")
                        : t("outputSourceObjectPlaceholder")}
                    </option>
                    {selectableCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                  </select>
                  {!loadingCandidates && selectableCandidates.length === 0 ? (
                    <small>{t("outputSourceNoCandidates")}</small>
                  ) : null}
                </label>
              )}
              <label className="outputs-entity-form-field is-wide">
                <span>{t("outputSourceNote")}</span>
                <textarea
                  rows={3}
                  value={sourceNote}
                  onChange={(event) => setSourceNote(event.target.value)}
                />
              </label>
              <div className="outputs-source-manager-editor-actions">
                <button type="button" disabled={busy} onClick={() => void addSource()}>
                  {t("outputSourceSave")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    resetAddDraft();
                    setShowAdd(false);
                  }}
                >
                  {t("outputSourceCancel")}
                </button>
              </div>
            </div>
          ) : null}

          {editingCard ? (
            <div className="outputs-source-manager-editor">
              <strong>{editingCard.sourceTitle}</strong>
              {editingCard.sourceType === "other" ? (
                <label className="outputs-entity-form-field">
                  <span>{t("outputSourceManualTitle")}</span>
                  <input
                    value={editingManualTitle}
                    onChange={(event) => setEditingManualTitle(event.target.value)}
                  />
                </label>
              ) : null}
              <label className="outputs-entity-form-field is-wide">
                <span>{t("outputSourceNote")}</span>
                <textarea
                  rows={3}
                  value={editingNote}
                  onChange={(event) => setEditingNote(event.target.value)}
                />
              </label>
              <div className="outputs-source-manager-editor-actions">
                <button type="button" disabled={busy} onClick={() => void saveSourceEdit()}>
                  {t("outputSourceSave")}
                </button>
                <button type="button" disabled={busy} onClick={() => setEditingCard(null)}>
                  {t("outputSourceCancel")}
                </button>
              </div>
            </div>
          ) : null}

          {removingCard ? (
            <div className="outputs-source-manager-remove-confirm" role="alert">
              <p>{t("outputSourceRemoveConfirm")}</p>
              <strong>{removingCard.sourceTitle}</strong>
              <div className="outputs-source-manager-editor-actions">
                <button type="button" className="is-remove" disabled={busy} onClick={() => void removeSource()}>
                  {t("outputSourceRemove")}
                </button>
                <button type="button" disabled={busy} onClick={() => setRemovingCard(null)}>
                  {t("outputSourceCancel")}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {error ? <div className="outputs-source-manager-message is-error" role="alert">{error}</div> : null}
      {notice ? <div className="outputs-source-manager-message is-success">{notice}</div> : null}
    </section>
  );
}
