import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/translations";
import type { ResearchRoutine, RoutineCheckIn } from "../../types/planning";
import { routineCalendarPalette } from "../../components/routineCalendarPalette";
import { buildRecentPlanRouteColors, recentPlanRouteColor } from "./projectRecentPlanPalette";
import {
  buildRecentPlan, extendRecentPlanWindow, recentPlanTimeLabel, RECENT_PLAN_GROUPS,
  type RecentPlanWeekWindow,
  type RecentPlanGroup, type RecentPlanRoute, type RecentPlanTask
} from "./projectRecentPlanModel";
import "./projectRecentPlan.css";

export type RecentPlanMode = "list" | "calendar";

export type ProjectRecentPlanPanelProps = {
  projectId: string;
  tasks: readonly RecentPlanTask[];
  routes: readonly RecentPlanRoute[];
  today: string;
  mode: RecentPlanMode;
  routines?: readonly ResearchRoutine[];
  checkIns?: readonly RoutineCheckIn[];
};

const statusKeys: Record<RecentPlanTask["planningStatus"], TranslationKey> = {
  todo: "planned", doing: "in_progress", done: "completed", delayed: "taskDelayed",
  blocked: "blocked", cancelled: "taskCancelled", archived: "archived"
};
const statusMarkers: Record<RecentPlanTask["planningStatus"], string> = {
  todo: "○", doing: "◐", done: "✓", delayed: "◷",
  blocked: "!", cancelled: "×", archived: "▣"
};

// Preserve the task list's existing presentation. Calendar colors are assigned
// separately below, without changing Route facts or status semantics.
const routePalette = [
  "color-mix(in srgb, #b9d9ff 50%, #153e75)",
  "color-mix(in srgb, #c7f0d2 50%, #14532d)",
  "color-mix(in srgb, #f7e7a3 50%, #5f480c)",
  "color-mix(in srgb, #cdeafe 50%, #164e63)"
];

function routeDisplayColor(routeId: string) {
  let hash = 0;
  for (let index = 0; index < routeId.length; index++) {
    hash = (Math.imul(hash, 31) + routeId.charCodeAt(index)) >>> 0;
  }
  return routePalette[hash % routePalette.length];
}

export function ProjectRecentPlanPanel({ projectId, tasks, routes, today, mode, routines, checkIns }: ProjectRecentPlanPanelProps) {
  const { language, t } = useI18n();
  const zh = language === "zh-CN";
  const [weekWindow, setWeekWindow] = useState<RecentPlanWeekWindow>({ offset: -1, count: 4 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ date: string; top: number; scrollTop: number } | null>(null);
  const pendingWindow = useRef(false);
  const lastScrollTop = useRef(0);
  const resetScroll = useRef(true);
  // Only a real view entry resets position; refreshing facts/theme leaves it alone.
  useLayoutEffect(() => {
    anchor.current = null; resetScroll.current = true;
    setWeekWindow({ offset: -1, count: 4 });
  }, [projectId, mode]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) {
      if (resetScroll.current) {
        const current = element.querySelector<HTMLElement>('[data-current-week="true"]');
        element.scrollTop = Math.min(Math.max(0, (current ? current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop : 0) - 28),
          Math.max(0, (element.scrollHeight - element.clientHeight) / 2));
        resetScroll.current = false;
      } else if (anchor.current) {
        const row = element.querySelector<HTMLElement>(`[data-week-start="${anchor.current.date}"]`);
        if (row) element.scrollTop = anchor.current.scrollTop + row.offsetTop - anchor.current.top;
      }
      lastScrollTop.current = element.scrollTop;
    }
    anchor.current = null; pendingWindow.current = false;
  }, [weekWindow, mode]);
  function scrollWeeks() {
    const element = scrollRef.current;
    if (!element || pendingWindow.current) return;
    const delta = element.scrollTop - lastScrollTop.current;
    lastScrollTop.current = element.scrollTop;
    const direction = delta < 0 && element.scrollTop < 56 ? -1
      : delta > 0 && element.scrollHeight - element.clientHeight - element.scrollTop < 56 ? 1 : 0;
    if (!direction) return;
    const visible = Array.from(element.querySelectorAll<HTMLElement>('[data-week-start]'))
      .find(row => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top + 28);
    if (!visible) return;
    anchor.current = { date: visible.dataset.weekStart!, top: visible.offsetTop, scrollTop: element.scrollTop };
    pendingWindow.current = true;
    setWeekWindow(current => extendRecentPlanWindow(current, direction));
  }
  const [expanded, setExpanded] = useState<Record<RecentPlanGroup, boolean>>({
    ideas: false, today: true, thisWeek: true, nextWeek: false
  });
  const model = useMemo(() => buildRecentPlan(projectId, tasks, today, routines, checkIns, weekWindow),
    [projectId, tasks, today, routines, checkIns, weekWindow]);
  const routePresentation = useMemo(() => new Map(routes.filter(route => route.projectId === projectId)
    .map(route => [route.id, { title: route.title, color: routeDisplayColor(route.id) }])), [projectId, routes]);
  const routeStyle = (routeId: string | undefined): CSSProperties => ({
    "--recent-plan-route-color": routePresentation.get(routeId ?? "")?.color ?? "#829ab1"
  } as CSSProperties);
  const calendarRouteColors = useMemo(() => buildRecentPlanRouteColors(
    routes.filter(route => route.projectId === projectId).map(route => route.id)), [projectId, routes]);
  const calendarRouteStyle = (routeId: string | undefined): CSSProperties => ({
    "--recent-plan-route-color": recentPlanRouteColor(calendarRouteColors, routeId)
  } as CSSProperties);
  const groupLabels: Record<RecentPlanGroup, string> = {
    ideas: zh ? "想法" : "Ideas", today: zh ? "今天" : "Today",
    thisWeek: zh ? "本周" : "This week", nextWeek: zh ? "下周" : "Next week"
  };
  const weekDays = zh ? ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <section className="project-recent-plan" aria-label={zh ? "近期计划" : "Recent plan"}>
      {mode === "list" ? (
        <>
          <div className="project-recent-plan-list-scroll">
            <table className="project-recent-plan-table">
              <colgroup><col /><col /><col /><col /></colgroup>
              <thead><tr>{(zh ? ["任务", "所属路线", "时间", "优先级"]
                : ["Task", "Route", "Time", "Priority"]).map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
              {RECENT_PLAN_GROUPS.map(group => (
                <tbody key={group}>
                  <tr className="project-recent-plan-group"><th colSpan={4} scope="rowgroup">
                    <button type="button" aria-expanded={expanded[group]}
                      onClick={() => setExpanded(current => ({ ...current, [group]: !current[group] }))}>
                      <span aria-hidden="true">{expanded[group] ? "▾" : "▸"}</span>
                      {groupLabels[group]} <span className="project-recent-plan-group-count">{model.groups[group].length}</span>
                    </button>
                  </th></tr>
                  {expanded[group] && model.groups[group].map(task => (
                    <tr key={task.id} data-recent-task-id={task.id}>
                      <td><div className="project-recent-plan-task-label">
                        <span className="status-pill">{t(statusKeys[task.planningStatus])}</span>
                        <span className="project-recent-plan-title">{task.title}</span>
                      </div></td>
                      <td><span className={`project-recent-plan-route${routePresentation.has(task.routeNodeId ?? "") ? " project-recent-plan-route-colored" : ""}`}
                        style={routeStyle(task.routeNodeId)}>{routePresentation.get(task.routeNodeId ?? "")?.title || "—"}</span></td>
                      <td className="project-recent-plan-time">{recentPlanTimeLabel(task, language)}</td>
                      <td>{task.priority ? <span className={`project-recent-plan-priority priority-${task.priority}`}>{t(task.priority)}</span> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <div className="project-recent-plan-counts">
            {RECENT_PLAN_GROUPS.map(group => <span key={group}>{groupLabels[group]} {model.groups[group].length}</span>)}
          </div>
        </>
      ) : (
        <div className="project-recent-plan-calendar-scroll" ref={scrollRef} onScroll={scrollWeeks} tabIndex={0}
          aria-label={zh ? "双向滚动周历" : "Scroll weeks in both directions"}>
          <div className="project-recent-plan-weekdays">{weekDays.map(day => <span key={day}>{day}</span>)}</div>
          {model.weeks.map(week => (
            <div key={week.start} className={`project-recent-plan-week${week.isCurrent ? " project-recent-plan-week-current" : ""}`}
              data-week-start={week.start} data-current-week={week.isCurrent}>
              {week.cells.map(cell => (
                <div key={cell.date} className="project-recent-plan-day" data-date={cell.date}>
                  <div className="project-recent-plan-day-header">
                    <time dateTime={cell.date} className={cell.date === today ? "project-recent-plan-today" : undefined}>{cell.date.slice(5)}</time>
                    <div className="project-recent-plan-routines">
                      {cell.routines.map(({ routine, isCompleted }) => (
                        <span key={routine.id} data-routine-id={routine.id} data-completed={isCompleted}
                          className={`project-recent-plan-routine${isCompleted ? " project-recent-plan-routine-completed" : ""}`}
                          role="img" aria-label={`${routine.title}: ${isCompleted ? (zh ? "已完成" : "Completed") : (zh ? "未完成" : "Not completed")}`}
                          style={{ color: (routineCalendarPalette[routine.rollingWeekColor ?? "sage"] ?? routineCalendarPalette.sage).color }} />
                      ))}
                    </div>
                  </div>
                  <div className="project-recent-plan-day-tasks">
                    {cell.tasks.map(({ task, kind }) => (
                      <div key={task.id} className="project-recent-plan-task" data-recent-task-id={task.id}
                        data-marker-kind={kind} data-status={task.planningStatus}
                        title={`${task.title} · ${t(statusKeys[task.planningStatus])}`} style={calendarRouteStyle(task.routeNodeId)}>
                        <span className={`project-recent-plan-marker project-recent-plan-marker-${kind}`} role="img"
                          aria-label={kind === "due" ? (zh ? "截止" : "Due") : (zh ? "开始" : "Start")} />
                        <span className="project-recent-plan-task-title">{task.title}</span>
                        <span className="project-recent-plan-task-status" role="img"
                          aria-label={t(statusKeys[task.planningStatus])}>{statusMarkers[task.planningStatus]}</span>
                      </div>
                    ))}
                    {cell.hiddenCount > 0 && <span className="project-recent-plan-overflow">+{cell.hiddenCount}</span>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
