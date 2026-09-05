import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/translations";
import { RESEARCH_TRACE_DISPLAY_DENSITY_OPTIONS } from "../../services/projectResearchTraceDisplayRules";
import type { ProjectResearchTraceData } from "../../types/projectResearchTrace";
import type { ResearchTraceDisplayDensity } from "../../types/projectResearchTrace";
import type { ProjectRouteGanttData } from "../../types/projectRouteGantt";
import { ProjectResearchTracePanel } from "./ProjectResearchTracePanel";
import { ProjectRouteGanttPanel } from "./ProjectRouteGanttPanel";

type ProjectVisualizationView = "gantt" | "researchTrace";

const researchTraceDisplayDensityLabels: Record<ResearchTraceDisplayDensity, TranslationKey> = {
  compact: "projectResearchTraceDisplayDensityCompact",
  standard: "projectResearchTraceDisplayDensityStandard",
  relaxed: "projectResearchTraceDisplayDensityRelaxed"
};

type ProjectVisualizationPanelProps = {
  projectId: string;
  ganttData: ProjectRouteGanttData | null;
  isGanttLoading: boolean;
  ganttErrorMessage?: string;
  researchTraceData: ProjectResearchTraceData | null;
  isResearchTraceLoading: boolean;
  researchTraceErrorMessage?: string;
};

function getLocalTodayIso() {
  const now = new Date();
  const localMidnight = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return localMidnight.toISOString().slice(0, 10);
}

function formatRange(
  rangeStart: string | undefined,
  rangeEnd: string | undefined,
  separator: string,
  emptyLabel: string
) {
  return rangeStart && rangeEnd ? `${rangeStart} ${separator} ${rangeEnd}` : emptyLabel;
}

export function ProjectVisualizationPanel({
  projectId,
  ganttData,
  isGanttLoading,
  ganttErrorMessage,
  researchTraceData,
  isResearchTraceLoading,
  researchTraceErrorMessage
}: ProjectVisualizationPanelProps) {
  const { t } = useI18n();
  const [view, setView] = useState<ProjectVisualizationView>("gantt");
  const [researchTraceDisplayDensity, setResearchTraceDisplayDensity] =
    useState<ResearchTraceDisplayDensity>("standard");
  const todayDateText = getLocalTodayIso();
  const rangeText =
    view === "gantt"
      ? formatRange(
          ganttData?.rangeStart,
          ganttData?.rangeEnd,
          t("projectRouteGanttRangeSeparator"),
          t("projectRouteGanttRangeUnavailable")
        )
      : formatRange(
          researchTraceData?.rangeStart,
          researchTraceData?.rangeEnd,
          t("projectResearchTraceRangeSeparator"),
          t("projectResearchTraceNoDateRange")
        );
  const metaText =
    view === "gantt"
      ? `${t("projectRouteGanttToday")}: ${todayDateText}`
      : "";

  return (
    <section className="project-visualization-panel" aria-live="polite">
      <div className="project-visualization-header">
        <div className="project-visualization-switch" aria-label={t("projectVisualizationSwitchLabel")}>
          <button
            type="button"
            className={`project-visualization-switch-button${
              view === "gantt" ? " project-visualization-switch-button-active" : ""
            }`}
            aria-pressed={view === "gantt"}
            onClick={() => setView("gantt")}
          >
            {t("projectVisualizationViewGantt")}
          </button>
          <button
            type="button"
            className={`project-visualization-switch-button${
              view === "researchTrace" ? " project-visualization-switch-button-active" : ""
            }`}
            aria-pressed={view === "researchTrace"}
            onClick={() => setView("researchTrace")}
          >
            {t("projectVisualizationViewTrace")}
          </button>
        </div>
        <div className="project-visualization-date-summary">
          {view === "researchTrace" ? (
            <label className="project-visualization-display-density">
              <span>{t("projectResearchTraceDisplayDensity")}</span>
              <select
                value={researchTraceDisplayDensity}
                onChange={(event) =>
                  setResearchTraceDisplayDensity(event.target.value as ResearchTraceDisplayDensity)
                }
              >
                {RESEARCH_TRACE_DISPLAY_DENSITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {t(researchTraceDisplayDensityLabels[option])}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <strong>{rangeText}</strong>
          {metaText ? <span>{metaText}</span> : null}
        </div>
      </div>

      <div className="project-visualization-body">
        {view === "gantt" ? (
          <ProjectRouteGanttPanel
            projectId={projectId}
            data={ganttData}
            isLoading={isGanttLoading}
            today={todayDateText}
            errorMessage={ganttErrorMessage}
          />
        ) : (
          <ProjectResearchTracePanel
            data={researchTraceData}
            displayDensity={researchTraceDisplayDensity}
            isLoading={isResearchTraceLoading}
            errorMessage={researchTraceErrorMessage}
          />
        )}
      </div>
    </section>
  );
}
