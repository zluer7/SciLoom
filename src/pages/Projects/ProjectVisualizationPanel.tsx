import { useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/translations";
import { RESEARCH_TRACE_DISPLAY_DENSITY_OPTIONS } from "../../services/projectResearchTraceDisplayRules";
import type { ProjectResearchTraceData } from "../../types/projectResearchTrace";
import type { ResearchTraceDisplayDensity } from "../../types/projectResearchTrace";
import type { ProjectRouteGanttData } from "../../types/projectRouteGantt";
import { ProjectResearchTracePanel } from "./ProjectResearchTracePanel";
import { ProjectRouteGanttPanel } from "./ProjectRouteGanttPanel";
import { ProjectRecentPlanPanel, type RecentPlanMode } from "./ProjectRecentPlanPanel";
import type { RecentPlanRoute, RecentPlanTask } from "./projectRecentPlanModel";
import type { ResearchRoutine, RoutineCheckIn } from "../../types/planning";

type ProjectVisualizationView = "gantt" | "researchTrace" | "recentPlan";

type VisualizationChoice = { view: ProjectVisualizationView; recentPlanMode: RecentPlanMode };
// Presentation only: survives route unmounts, scoped by Project, discarded with
// this application runtime. Never persists business facts or preferences.
const sessionChoices = new Map<string, VisualizationChoice>();
const defaultChoice: VisualizationChoice = { view: "gantt", recentPlanMode: "list" };

const researchTraceDisplayDensityLabels: Record<ResearchTraceDisplayDensity, TranslationKey> = {
  compact: "projectResearchTraceDisplayDensityCompact",
  standard: "projectResearchTraceDisplayDensityStandard",
  relaxed: "projectResearchTraceDisplayDensityRelaxed"
};

type ProjectVisualizationPanelProps = {
  projectId: string;
  tasks: readonly RecentPlanTask[];
  routes: readonly RecentPlanRoute[];
  routines?: readonly ResearchRoutine[];
  checkIns?: readonly RoutineCheckIn[];
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
  tasks,
  routes,
  routines,
  checkIns,
  ganttData,
  isGanttLoading,
  ganttErrorMessage,
  researchTraceData,
  isResearchTraceLoading,
  researchTraceErrorMessage
}: ProjectVisualizationPanelProps) {
  const { language, t } = useI18n();
  const [selection, setSelection] = useState(() => ({
    projectId, choice: sessionChoices.get(projectId) ?? defaultChoice
  }));
  const { view, recentPlanMode } = selection.projectId === projectId
    ? selection.choice : sessionChoices.get(projectId) ?? defaultChoice;
  const choose = (update: Partial<VisualizationChoice>) => {
    const choice = { view, recentPlanMode, ...update };
    sessionChoices.set(projectId, choice);
    setSelection({ projectId, choice });
  };
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
            onClick={() => choose({ view: "gantt" })}
          >
            {t("projectVisualizationViewGantt")}
          </button>
          <button
            type="button"
            className={`project-visualization-switch-button${
              view === "recentPlan" ? " project-visualization-switch-button-active" : ""
            }`}
            aria-pressed={view === "recentPlan"}
            onClick={() => choose({ view: "recentPlan" })}
          >
            {language === "zh-CN" ? "近期计划" : "Recent plan"}
          </button>
          <button
            type="button"
            className={`project-visualization-switch-button${
              view === "researchTrace" ? " project-visualization-switch-button-active" : ""
            }`}
            aria-pressed={view === "researchTrace"}
            onClick={() => choose({ view: "researchTrace" })}
          >
            {t("projectVisualizationViewTrace")}
          </button>
        </div>
        {view === "recentPlan" ? (
          <div className="project-visualization-date-summary">
            <div className="project-recent-plan-modes project-visualization-switch"
              aria-label={language === "zh-CN" ? "近期计划展示模式" : "Recent plan display mode"}>
              {(["list", "calendar"] as const).map(mode => (
                <button key={mode} type="button" aria-pressed={recentPlanMode === mode}
                  className={`project-visualization-switch-button${recentPlanMode === mode ? " project-visualization-switch-button-active" : ""}`}
                  onClick={() => choose({ recentPlanMode: mode })}>
                  {mode === "list" ? (language === "zh-CN" ? "任务清单" : "Task list")
                    : (language === "zh-CN" ? "滚动周历" : "Rolling weeks")}
                </button>
              ))}
            </div>
          </div>
        ) : <div className="project-visualization-date-summary">
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
        </div>}
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
        ) : view === "researchTrace" ? (
          <ProjectResearchTracePanel
            data={researchTraceData}
            displayDensity={researchTraceDisplayDensity}
            isLoading={isResearchTraceLoading}
            errorMessage={researchTraceErrorMessage}
          />
        ) : (
          <ProjectRecentPlanPanel key={projectId} projectId={projectId}
            tasks={tasks} routes={routes} today={todayDateText} mode={recentPlanMode}
            routines={routines} checkIns={checkIns} />
        )}
      </div>
    </section>
  );
}
