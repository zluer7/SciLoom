import type { PlanningProjectPlanTaskEntry } from "../../services/planningPageAdapterService";
import { resolveProjectRouteGanttTodayState } from "../../services/projectRouteGanttGeometry";
import { buildRoutineCurrentPeriodSummary, routineAppliesOn } from "../../services/planningSelectorService";
import type { ResearchRoutine, RoutineCheckIn } from "../../types/planning";

// UI projection only. The existing page adapter maps scheduledDate/dueDate
// directly to startDate/endDate and already applies canonical lifecycle rules.
export type RecentPlanTask = Pick<PlanningProjectPlanTaskEntry,
  "id" | "projectId" | "routeNodeId" | "title" | "planningStatus" | "startDate" | "endDate"
> & { priority?: PlanningProjectPlanTaskEntry["priority"] | null };
export type RecentPlanRoute = { id: string; projectId: string; title: string };
export type RecentPlanGroup = "ideas" | "today" | "thisWeek" | "nextWeek";
export const RECENT_PLAN_GROUPS: RecentPlanGroup[] = ["ideas", "today", "thisWeek", "nextWeek"];
export const RECENT_PLAN_TASKS_PER_DAY = 3;
export const RECENT_PLAN_MAX_WEEKS = 12;
export type RecentPlanWeekWindow = { offset: number; count: number };
export function extendRecentPlanWindow(window: RecentPlanWeekWindow, direction: -1 | 1): RecentPlanWeekWindow {
  const count = Math.min(RECENT_PLAN_MAX_WEEKS, window.count + 4);
  return { offset: direction === -1 ? window.offset - 4 : window.offset + window.count + 4 - count, count };
}
const DAY_MS = 24 * 60 * 60 * 1000;

type TaskDates = { kind: "range" | "startOnly" | "dueOnly" | "sameDay"; start: number; end: number };
export type RecentPlanCalendarTask = {
  task: RecentPlanTask;
  kind: "start" | "due";
};

function dateDay(value: string): number | null {
  // Reuse the Gantt's strict date-only validation, without local timezone shifts.
  const date = resolveProjectRouteGanttTodayState({ today: value, rangeStart: value, rangeEnd: value }).today;
  return date ? Date.parse(`${date}T00:00:00.000Z`) / DAY_MS : null;
}

function dateText(day: number) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function taskDates(task: RecentPlanTask): TaskDates | null {
  const start = task.startDate ? dateDay(task.startDate) : null;
  const end = task.endDate ? dateDay(task.endDate) : null;
  if ((task.startDate && start === null) || (task.endDate && end === null)) return null;
  if (start !== null && end !== null) {
    if (start > end) return null; // Do not swap dates or turn invalid ranges into ideas.
    return { kind: start === end ? "sameDay" : "range", start, end };
  }
  if (start !== null) return { kind: "startOnly", start, end: start };
  if (end !== null) return { kind: "dueOnly", start: end, end };
  return null;
}

export function recentPlanTimeLabel(task: RecentPlanTask, language: string) {
  const dates = taskDates(task);
  if (!dates) return "—";
  const start = task.startDate.slice(5);
  const end = task.endDate.slice(5);
  if (dates.kind === "startOnly") return `${language === "zh-CN" ? "计划" : "Planned"} ${start}`;
  if (dates.kind === "dueOnly") return `${language === "zh-CN" ? "截止" : "Due"} ${end}`;
  return dates.kind === "sameDay" ? start : `${start} → ${end}`;
}

export function buildRecentPlan(projectId: string, tasks: readonly RecentPlanTask[], today: string,
  routines: readonly ResearchRoutine[] = [], checkIns: readonly RoutineCheckIn[] = [],
  weekWindow: RecentPlanWeekWindow = { offset: -1, count: 4 }) {
  const todayDay = dateDay(today);
  if (todayDay === null) throw new Error("Recent plan requires a valid local today date.");
  const weekday = new Date(todayDay * DAY_MS).getUTCDay();
  const monday = todayDay - ((weekday + 6) % 7);
  const weekCount = Math.max(4, Math.min(RECENT_PLAN_MAX_WEEKS, weekWindow.count));
  const windowStart = monday + weekWindow.offset * 7;
  const windowEnd = windowStart + weekCount * 7;
  const groups: Record<RecentPlanGroup, RecentPlanTask[]> = { ideas: [], today: [], thisWeek: [], nextWeek: [] };
  const dated: Array<{ task: RecentPlanTask; dates: TaskDates }> = [];
  for (const task of tasks) {
    if (task.projectId !== projectId) continue;
    if (!task.startDate && !task.endDate) {
      groups.ideas.push(task);
      continue;
    }
    const dates = taskDates(task);
    if (!dates) continue;
    // Calendar receives all valid dated facts, independently of the list window.
    dated.push({ task, dates });
    const hits = (start: number, end: number) => dates.start <= end && dates.end >= start;
    if (hits(todayDay, todayDay)) groups.today.push(task);
    else if (hits(monday, monday + 6)) groups.thisWeek.push(task);
    else if (hits(monday + 7, monday + 13)) groups.nextWeek.push(task);
  }

  // Match the existing Project Routine scope (Project + global) and stable query order.
  const visibleRoutines = routines.filter(routine => routine.showInRollingWeek === true &&
    routine.isActive && !routine.deletedAt && (!routine.projectId || routine.projectId === projectId));
  const routineCheckIns = new Map(visibleRoutines.map(routine => [routine.id,
    checkIns.filter(checkIn => checkIn.routineId === routine.id && !checkIn.deletedAt)]));

  const weeks = Array.from({ length: weekCount }, (_, index) => {
    const weekStart = windowStart + index * 7;
    const days = Array.from({ length: 7 }, (_, day) => dateText(weekStart + day));
    const cells = days.map((date, dayIndex) => {
      const day = weekStart + dayIndex;
      const due = dated.filter(({ task, dates }) => task.endDate && dates.end === day);
      const starts = dated.filter(({ task, dates }) => task.startDate && dates.start === day && dates.kind !== "sameDay");
      // Stable partition only: deadlines first, then starts, with no new business sort.
      const entries: RecentPlanCalendarTask[] = [
        ...due.map(({ task }) => ({ task, kind: "due" as const })),
        ...starts.map(({ task }) => ({ task, kind: "start" as const }))
      ];
      // A local date avoids interpreting a calendar date as the previous UTC day.
      const referenceDate = new Date(`${date}T12:00:00`);
      return { date, tasks: entries.slice(0, RECENT_PLAN_TASKS_PER_DAY),
        hiddenCount: Math.max(0, entries.length - RECENT_PLAN_TASKS_PER_DAY),
        routines: visibleRoutines.filter(routine => routineAppliesOn(routine, date)).slice(0, 3)
          .map(routine => ({ routine, isCompleted: buildRoutineCurrentPeriodSummary(
            routine, routineCheckIns.get(routine.id) ?? [], referenceDate).isCompleted })) };
    });
    return { start: dateText(weekStart), isCurrent: weekStart === monday, days, cells };
  });
  return { groups, weeks, windowStart: dateText(windowStart), windowEnd: dateText(windowEnd - 1) };
}
