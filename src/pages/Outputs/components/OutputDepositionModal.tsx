import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import { getOutputSourceSummary } from "../../../services/outputSourceSelectorService";
import type {
  OutputDepositionInput,
  OutputDepositionSourceLayer,
  OutputDepositionTargetLayer
} from "../../../services/outputDepositionService";
import type { StructuredSummary } from "../../../types/outputStructuredSummary";
import {
  createDefaultStructuredSummary,
  normalizeStructuredSummary
} from "../../../types/outputStructuredSummary";
import type {
  OutputEntityLayer,
  OutputEntityListItemDto
} from "../../../types/outputSelector";

type OutputDepositionModalProps = {
  projectId: string;
  sourceLayer: OutputDepositionSourceLayer;
  sourceId: string;
  sourceTitle: string;
  sourceDescription: string;
  sourceStructuredSummary: StructuredSummary;
  fixedTargetLayer?: OutputDepositionTargetLayer;
  actionTitle?: string;
  confirmCreateLabel?: string;
  confirmAddLabel?: string;
  outputLists: Record<OutputEntityLayer, OutputEntityListItemDto[]>;
  saving: boolean;
  error: string;
  onSubmit: (input: OutputDepositionInput) => Promise<void> | void;
  onClose: () => void;
};

type Option = { value: string; label: string };

const TARGETS_BY_SOURCE: Record<
  OutputDepositionSourceLayer,
  readonly OutputDepositionTargetLayer[]
> = {
  resultItem: ["finding", "outputCandidate"],
  finding: ["outputCandidate", "outputGap"],
  outputCandidate: ["outputGap", "researchOutput"]
};

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/\/?)[^\s"'<>|]+/gi;

function safeText(value: string) {
  return value.replace(LOCAL_PATH_PATTERN, "[local path]").trim();
}

function seededSummary(targetLayer: OutputDepositionTargetLayer, sourceValue: string) {
  const summary = createDefaultStructuredSummary(targetLayer);
  if (!sourceValue || summary.length === 0) return summary;
  const sourceFieldByTarget: Record<OutputDepositionTargetLayer, string> = {
    finding: "supportingEvidence",
    outputCandidate: "evidenceSummary",
    outputGap: "other",
    researchOutput: "sourceChainSummary"
  };
  return summary.map((section) =>
    section.key === sourceFieldByTarget[targetLayer]
      ? { ...section, value: sourceValue }
      : section
  );
}

export function OutputDepositionModal({
  projectId,
  sourceLayer,
  sourceId,
  sourceTitle,
  sourceDescription,
  sourceStructuredSummary,
  fixedTargetLayer,
  actionTitle,
  confirmCreateLabel,
  confirmAddLabel,
  outputLists,
  saving,
  error,
  onSubmit,
  onClose
}: OutputDepositionModalProps) {
  const { t } = useI18n();
  const targets = fixedTargetLayer ? [fixedTargetLayer] : TARGETS_BY_SOURCE[sourceLayer];
  const [targetLayer, setTargetLayer] = useState<OutputDepositionTargetLayer>(targets[0]);
  const [mode, setMode] = useState<"createNew" | "addExisting">("createNew");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [entityType, setEntityType] = useState("");
  const [structuredSummary, setStructuredSummary] = useState<StructuredSummary>([]);
  const [sourceNote, setSourceNote] = useState("");
  const [targetId, setTargetId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);

  const targetLabels: Record<OutputDepositionTargetLayer, string> = {
    finding: t("outputDepositionTargetFinding"),
    outputCandidate: t("outputDepositionTargetCandidate"),
    outputGap: t("outputDepositionTargetGap"),
    researchOutput: t("outputDepositionTargetResearchOutput")
  };

  const typeOptions: Record<OutputDepositionTargetLayer, Option[]> = {
    finding: [
      { value: "phenomenon", label: t("outputDepositionTypePhenomenon") },
      { value: "method", label: t("outputDepositionTypeMethod") },
      { value: "evidence", label: t("outputDepositionTypeEvidence") },
      { value: "other", label: t("outputDepositionTypeOther") }
    ],
    outputCandidate: [
      { value: "paper", label: t("outputDepositionTypePaper") },
      { value: "patent", label: t("outputDepositionTypePatent") },
      { value: "report", label: t("outputDepositionTypeReport") },
      { value: "dataset", label: t("outputDepositionTypeDataset") },
      { value: "software", label: t("outputDepositionTypeSoftware") },
      { value: "other", label: t("outputDepositionTypeOther") }
    ],
    outputGap: [
      { value: "analysis", label: t("outputDepositionTypeAnalysis") },
      { value: "validation", label: t("outputDepositionTypeValidation") },
      { value: "data", label: t("outputDepositionTypeData") },
      { value: "literature", label: t("outputDepositionTypeLiterature") },
      { value: "other", label: t("outputDepositionTypeOther") }
    ],
    researchOutput: [
      { value: "paper_draft", label: t("outputDepositionTypePaperDraft") },
      { value: "report", label: t("outputDepositionTypeReport") },
      { value: "dataset", label: t("outputDepositionTypeDataset") },
      { value: "presentation", label: t("outputDepositionTypePresentation") },
      { value: "other", label: t("outputDepositionTypeOther") }
    ]
  };

  const sourceSummaryValue = useMemo(() => {
    const firstStructuredValue =
      sourceStructuredSummary.find((section) => section.value.trim())?.value ?? "";
    return safeText(sourceDescription || firstStructuredValue);
  }, [sourceDescription, sourceStructuredSummary]);

  useEffect(() => {
    if (fixedTargetLayer) {
      setTargetLayer(fixedTargetLayer);
    }
  }, [fixedTargetLayer]);

  useEffect(() => {
    const firstType = typeOptions[targetLayer][0]?.value ?? "other";
    const inheritSourceContent = targetLayer !== "researchOutput";
    setTitle(`${targetLabels[targetLayer]}: ${safeText(sourceTitle)}`);
    setDescription(inheritSourceContent ? sourceSummaryValue : "");
    setEntityType(firstType);
    setStructuredSummary(
      inheritSourceContent
        ? seededSummary(targetLayer, sourceSummaryValue)
        : createDefaultStructuredSummary(targetLayer)
    );
    setTargetId("");
    setKeyword("");
    setDuplicate(false);
  }, [sourceId, sourceSummaryValue, sourceTitle, targetLayer]);

  useEffect(() => {
    if (mode !== "addExisting" || !targetId) {
      setDuplicate(false);
      return;
    }
    let cancelled = false;
    setCheckingDuplicate(true);
    void getOutputSourceSummary(targetLayer, targetId)
      .then((summary) => {
        if (!cancelled) {
          setDuplicate(
            summary.cards.some(
              (card) => card.sourceType === sourceLayer && card.sourceId === sourceId
            )
          );
        }
      })
      .catch(() => {
        if (!cancelled) setDuplicate(false);
      })
      .finally(() => {
        if (!cancelled) setCheckingDuplicate(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, sourceId, sourceLayer, targetId, targetLayer]);

  const existingTargets = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase();
    return outputLists[targetLayer].filter(
      (item) =>
        item.projectId === projectId &&
        (!query || item.title.toLocaleLowerCase().includes(query))
    );
  }, [keyword, outputLists, projectId, targetLayer]);

  function changeTarget(nextTarget: OutputDepositionTargetLayer) {
    setTargetLayer(nextTarget);
    setSourceNote("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "createNew") {
      void onSubmit({
        mode,
        projectId,
        sourceLayer,
        sourceId,
        targetLayer,
        title,
        description,
        entityType,
        structuredSummary: normalizeStructuredSummary(targetLayer, structuredSummary),
        sourceNote,
        confirmedByUser: true
      });
      return;
    }
    if (!targetId || duplicate) return;
    void onSubmit({
      mode,
      projectId,
      sourceLayer,
      sourceId,
      targetLayer,
      targetId,
      sourceNote,
      confirmedByUser: true
    });
  }

  return (
    <div className="modal-backdrop outputs-deposition-backdrop" role="presentation">
      <section
        className="outputs-deposition-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="outputs-deposition-title"
      >
        <form onSubmit={submit}>
          <header className="outputs-deposition-header">
            <div>
              <h2 id="outputs-deposition-title">
                {actionTitle ?? t("outputDeposition")}
              </h2>
            </div>
            <button type="button" onClick={onClose} disabled={saving}>
              {t("outputSourceCancel")}
            </button>
          </header>

          <div className="outputs-deposition-body">
            {fixedTargetLayer ? (
              <div className="outputs-deposition-field outputs-deposition-fixed-target">
                <span>{t("outputDepositionTarget")}</span>
                <strong>{targetLabels[targetLayer]}</strong>
              </div>
            ) : (
              <label className="outputs-deposition-field">
                <span>{t("outputDepositionTarget")}</span>
                <select
                  value={targetLayer}
                  onChange={(event) =>
                    changeTarget(event.target.value as OutputDepositionTargetLayer)
                  }
                >
                  {targets.map((target) => (
                    <option key={target} value={target}>
                      {targetLabels[target]}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="outputs-deposition-mode" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "createNew"}
                className={mode === "createNew" ? "is-active" : ""}
                onClick={() => {
                  setMode("createNew");
                  setDuplicate(false);
                }}
              >
                {t("outputDepositionCreateNew")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "addExisting"}
                className={mode === "addExisting" ? "is-active" : ""}
                onClick={() => setMode("addExisting")}
              >
                {t("outputDepositionAddExisting")}
              </button>
            </div>

            {mode === "createNew" ? (
              <div className="outputs-deposition-panel">
                <div className="outputs-deposition-grid">
                  <label className="outputs-deposition-field is-wide">
                    <span>{t("outputDepositionNewTitle")}</span>
                    <input
                      required
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <label className="outputs-deposition-field">
                    <span>{t("outputDepositionObjectType")}</span>
                    <select
                      value={entityType}
                      onChange={(event) => setEntityType(event.target.value)}
                    >
                      {typeOptions[targetLayer].map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="outputs-deposition-field is-wide">
                    <span>{t("outputDepositionDescription")}</span>
                    <textarea
                      rows={3}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div className="outputs-deposition-panel">
                <label className="outputs-deposition-field">
                  <span>{t("outputDepositionSearchExisting")}</span>
                  <input
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                  />
                </label>
                <label className="outputs-deposition-field">
                  <span>{t("outputDepositionSelectExisting")}</span>
                  <select
                    required
                    value={targetId}
                    onChange={(event) => setTargetId(event.target.value)}
                  >
                    <option value="">{t("outputDepositionSelectExistingPlaceholder")}</option>
                    {existingTargets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {safeText(target.title)}
                      </option>
                    ))}
                  </select>
                  {existingTargets.length === 0 ? (
                    <small>{t("outputDepositionNoExisting")}</small>
                  ) : null}
                </label>
                {duplicate ? (
                  <div className="outputs-deposition-warning" role="alert">
                    {t("outputDepositionDuplicate")}
                  </div>
                ) : null}
              </div>
            )}

            <label className="outputs-deposition-field">
              <span>{t("outputDepositionSourceNote")}</span>
              <textarea
                rows={3}
                value={sourceNote}
                onChange={(event) => setSourceNote(event.target.value)}
              />
              <small>{t("outputDepositionSourceNoteBoundary")}</small>
            </label>

            {error ? (
              <div className="outputs-deposition-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>

          <footer className="outputs-deposition-footer">
            <button
              type="submit"
              className="is-primary"
              disabled={
                saving ||
                checkingDuplicate ||
                duplicate ||
                (mode === "addExisting" && !targetId)
              }
            >
              {saving
                ? t("outputDepositionSaving")
                : mode === "createNew"
                  ? confirmCreateLabel ?? t("outputDepositionConfirmCreate")
                  : confirmAddLabel ?? t("outputDepositionConfirmAdd")}
            </button>
            <button type="button" disabled={saving} onClick={onClose}>
              {t("outputSourceCancel")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
