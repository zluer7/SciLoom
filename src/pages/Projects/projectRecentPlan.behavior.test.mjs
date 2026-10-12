import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const bundle = await build({
  stdin: { contents: `
    export * from './src/pages/Projects/projectRecentPlanModel';
    export * from './src/pages/Projects/projectRecentPlanPalette';
    export * from './src/pages/Projects/ProjectRecentPlanPanel';
    export * from './src/pages/Projects/ProjectVisualizationPanel';
    export * from './src/i18n/I18nProvider';
  `, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "cjs", target: "es2022",
  jsx: "automatic", external: ["react", "react/jsx-runtime"], loader: { ".css": "empty" }
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports
);
const { buildRecentPlan, extendRecentPlanWindow, recentPlanTimeLabel, buildRecentPlanRouteColors, recentPlanRouteColor, ProjectRecentPlanPanel,
  ProjectVisualizationPanel, I18nProvider } = module.exports;
const TODAY = "2026-09-27"; // Sunday; the following day belongs to next week.

test('dynamic week windows remain contiguous and bounded across repeated extension and recycling in both directions',()=>{
 let window={offset:-1,count:4};
 const tasks=[{id:'past',title:'Past',projectId:'p',planningStatus:'todo',startDate:'2026-08-10',endDate:''},
  {id:'future',title:'Future',projectId:'p',planningStatus:'done',startDate:'',endDate:'2026-12-07'}];
 const before=JSON.stringify(tasks);
 for(const direction of [-1,-1,-1,-1,1,1,1,1,1,1,1,1,1,1,1]){
  const old=buildRecentPlan('p',tasks,TODAY,[],[],window);window=extendRecentPlanWindow(window,direction);
  const next=buildRecentPlan('p',tasks,TODAY,[],[],window);
  assert.ok(next.weeks.length<=12);assert.equal(new Set(next.weeks.map(w=>w.start)).size,next.weeks.length);
  for(let i=1;i<next.weeks.length;i++) assert.equal(Date.parse(next.weeks[i].start)-Date.parse(next.weeks[i-1].start),7*86400000);
  assert.ok(next.weeks.some(w=>old.weeks.some(o=>o.start===w.start)));
 }
 assert.equal(JSON.stringify(tasks),before);
});

test('mounted scroll preserves an anchor on prepend/trim and resets only on true calendar entries',async()=>{
 let renderer;const dom={scrollTop:0,clientHeight:400,offsetTop:0};
 const rows=()=>renderer.root.findAll(node=>node.type==='div'&&node.props['data-week-start']).map((node,i)=>({
  dataset:{weekStart:node.props['data-week-start']},offsetTop:28+i*124,getBoundingClientRect:()=>({top:28+i*124-dom.scrollTop,bottom:28+(i+1)*124-dom.scrollTop})}));
 Object.defineProperty(dom,'scrollHeight',{get:()=>28+rows().length*124});
 dom.getBoundingClientRect=()=>({top:0});dom.querySelectorAll=()=>rows();
 dom.querySelector=selector=>rows().find(row=>selector.includes(row.dataset.weekStart))??(selector.includes('data-current-week')?rows()[1]:null);
 const props={projectId:'p',tasks:[],routes:[],today:TODAY,mode:'list'};
 await act(async()=>{renderer=TestRenderer.create(wrapped(ProjectRecentPlanPanel,props),{createNodeMock:node=>node.props.className==='project-recent-plan-calendar-scroll'?dom:null});});
 await act(async()=>renderer.update(wrapped(ProjectRecentPlanPanel,{...props,mode:'calendar'})));
 const scroll=()=>renderer.root.findByProps({className:'project-recent-plan-calendar-scroll'});
 async function move(top){dom.scrollTop=top;await act(async()=>scroll().props.onScroll());}
 await move(0);assert.equal(rows().length,8);assert.equal(dom.scrollTop,496);
 await move(dom.scrollHeight-dom.clientHeight);assert.equal(rows().length,12);
 dom.scrollTop=dom.scrollHeight-dom.clientHeight;
 const anchorBefore=rows().find(r=>r.getBoundingClientRect().bottom>28);const topBefore=anchorBefore.offsetTop-dom.scrollTop;
 await move(dom.scrollTop+1);assert.equal(rows().length,12);
 const anchorAfter=rows().find(r=>r.dataset.weekStart===anchorBefore.dataset.weekStart);
 assert.equal(anchorAfter.offsetTop-dom.scrollTop,topBefore-1);
 const previous=dom.scrollTop;await act(async()=>renderer.update(wrapped(ProjectRecentPlanPanel,{...props,mode:'calendar',tasks:[task('fresh')]})));
 assert.equal(dom.scrollTop,previous);
 await act(async()=>renderer.update(wrapped(ProjectRecentPlanPanel,props)));
 await act(async()=>renderer.update(wrapped(ProjectRecentPlanPanel,{...props,mode:'calendar'})));
 assert.equal(rows().length,4);assert.ok(dom.scrollTop<124);
 await act(async()=>renderer.update(wrapped(ProjectRecentPlanPanel,{...props,projectId:'q',mode:'calendar'})));
 assert.equal(rows().length,4);await act(async()=>renderer.unmount());
});

test("calendar Route colors are stable, deterministic and neutral for missing Routes", () => {
  const routes = Object.freeze(["r3", "r1", "r6", "r2", "r5", "r4"]);
  const colors = buildRecentPlanRouteColors(routes);
  assert.deepEqual([...colors], [...buildRecentPlanRouteColors([...routes].reverse())]);
  assert.equal(recentPlanRouteColor(colors, "r1"), "#6f93b5");
  assert.equal(new Set(colors.values()).size, 6);
  assert.equal(buildRecentPlanRouteColors([...routes, "r1", "r7"]).get("r7"), colors.get("r1"));
  assert.equal(recentPlanRouteColor(colors), "#829ab1");
  assert.equal(recentPlanRouteColor(colors, "missing"), "#829ab1");
});
const task = (id, startDate = "", endDate = "", extra = {}) => Object.freeze({
  id, title: id, projectId: "p", planningStatus: "todo", priority: "medium",
  startDate, endDate, ...extra
});
const ids = items => items.map(item => item.id);
const entries = model => model.weeks.flatMap(week => week.cells.flatMap(cell => cell.tasks));
const cell = (model, date) => model.weeks.flatMap(week => week.cells).find(cell => cell.date === date);
const routine = (id, extra = {}) => ({ id, title: id, projectId: "p", frequency: "daily",
  targetType: "count", targetCount: 1, isActive: true, showInRollingWeek: true,
  rollingWeekColor: "sage", orderIndex: 0, ...extra });
const checkIn = (id, routineId, periodKey, count = 1) => ({ id, routineId, periodKey, count,
  checkedAt: `${TODAY}T12:00:00`, updatedAt: `${TODAY}T12:00:00`, createdAt: `${TODAY}T12:00:00` });
const button = (root, label) => root.findAllByType("button")
  .find(node => node.children.join("") === label);
const wrapped = (Component, props) => React.createElement(I18nProvider, null,
  React.createElement(Component, props));

test("list uses current Project facts once, stable order, inclusive intervals and four groups", () => {
  const tasks = Object.freeze([
    task("idea"), task("spans", "2026-09-20", "2026-10-05"),
    task("today", "2026-09-27"), task("thisWeek", "", "2026-09-21"),
    task("nextWeek", "2026-09-28"), task("previous", "2026-09-16"),
    task("following", "2026-10-07"), task("far", "2026-10-21"),
    task("invalid", "2026-02-30"), task("reverse", "2026-09-30", "2026-09-20"),
    task("foreign", "2026-09-27", "", { projectId: "q" })
  ]);
  const before = JSON.stringify(tasks);
  const model = buildRecentPlan("p", tasks, TODAY);
  assert.deepEqual(Object.fromEntries(Object.entries(model.groups).map(([key, value]) => [key, ids(value)])), {
    ideas: ["idea"], today: ["spans", "today"], thisWeek: ["thisWeek"], nextWeek: ["nextWeek"]
  });
  assert.equal(new Set(Object.values(model.groups).flat().map(t => t.id)).size, 5);
  assert.equal(JSON.stringify(tasks), before);
  assert.deepEqual(model.weeks.map(w => w.start), ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]);
  assert.deepEqual(model.weeks.map(w => w.isCurrent), [false, true, false, false]);
  assert.deepEqual(model.weeks.map(w => w.days.length), [7, 7, 7, 7]);
  assert.equal(model.windowEnd, "2026-10-11");
  assert.ok(entries(model).some(s => s.task.id === "previous"));
  assert.ok(entries(model).some(s => s.task.id === "following"));
  for (const id of ["idea", "far", "invalid", "reverse", "foreign"]) {
    assert.ok(!entries(model).some(s => s.task.id === id));
  }
});

test("date labels preserve range, points, same-day and absence without synthesizing facts", () => {
  assert.equal(recentPlanTimeLabel(task("start", TODAY), "zh-CN"), "计划 09-27");
  assert.equal(recentPlanTimeLabel(task("end", "", "2026-09-30"), "zh-CN"), "截止 09-30");
  assert.equal(recentPlanTimeLabel(task("range", TODAY, "2026-09-30"), "zh-CN"), "09-27 → 09-30");
  assert.equal(recentPlanTimeLabel(task("same", TODAY, TODAY), "zh-CN"), "09-27");
  assert.equal(recentPlanTimeLabel(task("idea"), "zh-CN"), "—");
});

test("calendar exposes canonical status and full title while retaining opt-in Routine and noninteractive date markers", async () => {
  const statuses=['todo','doing','done','delayed','blocked','cancelled','archived'];
  const tasks=statuses.map((status,i)=>task(`long-${status}`,`2026-09-${21+i}`,`2026-09-${21+i}`,{planningStatus:status,title:`Title ${status} `.repeat(12)}));
  const selected=routine('selected');const checks=[checkIn('complete','selected',TODAY)];
  const source=JSON.stringify([tasks,selected,checks]);
  for(const language of ['zh-CN','en-US']) {
    globalThis.window={localStorage:{getItem:()=>language}};
    let renderer;await act(async()=>{renderer=TestRenderer.create(wrapped(ProjectRecentPlanPanel,{projectId:'p',tasks,routes:[],today:TODAY,mode:'calendar',routines:[selected,routine('opted-out',{showInRollingWeek:false}),routine('missing-choice',{showInRollingWeek:undefined})],checkIns:checks}));});
    const root=renderer.root;
    for(const status of statuses) {
      const bar=root.findByProps({'data-recent-task-id':`long-${status}`});
      assert.equal(bar.props['data-status'],status);assert.ok(bar.props.title.startsWith(`Title ${status}`));
      const icon=bar.findByProps({className:'project-recent-plan-task-status'});
      assert.equal(icon.props.role,'img');assert.ok(icon.props['aria-label'].length>0);
      assert.equal(icon.children.join('').length,1);assert.ok(bar.props.title.endsWith(icon.props['aria-label']));
      assert.equal(bar.props.onClick,undefined);assert.equal(bar.type,'div');
    }
    const today=root.findByProps({'data-date':TODAY});assert.equal(today.findByProps({'data-routine-id':'selected'}).props['data-completed'],true);
    assert.equal(root.findAllByProps({'data-routine-id':'opted-out'}).length,0);assert.equal(root.findAllByProps({'data-routine-id':'missing-choice'}).length,0);
    await act(async()=>renderer.unmount());
  }
  delete globalThis.window;assert.equal(JSON.stringify([tasks,selected,checks]),source);
});

test("range Tasks render only real start/deadline dates, never middle days or clipped endpoints", () => {
  const model = buildRecentPlan("p", [task("whole", "2026-09-01", "2026-11-01"),
    task("cross", "2026-09-19", "2026-09-29")], TODAY);
  assert.ok(!entries(model).some(s => s.task.id === "whole"));
  assert.deepEqual(model.weeks.flatMap(week => week.cells.flatMap(cell =>
    cell.tasks.map(entry => [cell.date, entry.task.id, entry.kind]))), [
    ["2026-09-19", "cross", "start"], ["2026-09-29", "cross", "due"]
  ]);
  assert.equal(cell(model, TODAY).tasks.length, 0);
});

test("scheduled-only is start, due-only is deadline, same-day is a single deadline; outside dates stay outside", () => {
  for (const [item, kind] of [[task("start", TODAY), "start"], [task("due", "", TODAY), "due"],
    [task("same", TODAY, TODAY), "due"]]) {
    const rendered = entries(buildRecentPlan("p", [item], TODAY));
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].kind, kind);
  }
  const edges = entries(buildRecentPlan("p", [task("outsideBefore", "2026-09-13"),
    task("outsideAfter", "", "2026-10-12"), task("first", "", "2026-09-14"),
    task("last", "2026-10-11")], TODAY));
  assert.deepEqual(edges.map(s => s.task.id), ["first", "last"]);
});

test("per-day capacity is three: stable deadlines first, starts fill remaining slots, +N counts Tasks once", () => {
  const tasks = Object.freeze([task("startA", TODAY), task("dueB", "", TODAY),
    task("sameC", TODAY, TODAY), task("startD", TODAY), task("startE", TODAY)]);
  const before = JSON.stringify(tasks);
  const first = cell(buildRecentPlan("p", tasks, TODAY), TODAY);
  assert.deepEqual(first.tasks.map(e => [e.task.id, e.kind]), [["dueB", "due"], ["sameC", "due"], ["startA", "start"]]);
  assert.equal(first.hiddenCount, 2);
  const moreDue = cell(buildRecentPlan("p", [...tasks, task("dueF", "", TODAY), task("dueG", "", TODAY)], TODAY), TODAY);
  assert.deepEqual(moreDue.tasks.map(e => e.task.id), ["dueB", "sameC", "dueF"]);
  assert.equal(moreDue.hiddenCount, 4);
  assert.equal(JSON.stringify(tasks), before);
});

test("Routine opt-in, active dates, existing Project/global scope and stable maximum three per day", () => {
  const routines = [routine("old", { showInRollingWeek: undefined }), routine("hidden", { showInRollingWeek: false }),
    routine("inactive", { isActive: false }), routine("foreign", { projectId: "q" }),
    routine("expired", { endDate: "2026-09-26" }), routine("future", { startDate: "2026-09-28" }),
    routine("one"), routine("global", { projectId: undefined }), routine("three"), routine("four")];
  const result = cell(buildRecentPlan("p", [], TODAY, routines), TODAY);
  assert.deepEqual(result.routines.map(m => m.routine.id), ["one", "global", "three"]);
  assert.ok(result.routines.every(m => !m.isCompleted));
  assert.equal(result.hiddenCount, 0);
});

test("Routine markers reuse daily/weekly/monthly target completion, including incomplete and deleted check-ins", () => {
  const routines = [routine("daily", { targetCount: 2 }), routine("weekly", { frequency: "weekly", targetCount: 2 }),
    routine("monthly", { frequency: "monthly", targetType: "description" })];
  const checks = [checkIn("d1", "daily", TODAY), checkIn("w1", "weekly", "2026-W39", 2),
    checkIn("m1", "monthly", "2026-09"), { ...checkIn("deleted", "daily", TODAY), deletedAt: "deleted" }];
  const before = JSON.stringify([routines, checks]);
  const model = buildRecentPlan("p", [], TODAY, routines, checks);
  assert.deepEqual(cell(model, TODAY).routines.map(m => m.isCompleted), [false, true, true]);
  assert.deepEqual(cell(model, "2026-09-21").routines.map(m => m.isCompleted), [false, true, true]);
  assert.deepEqual(cell(model, "2026-10-01").routines.map(m => m.isCompleted), [false, false, false]);
  const completed = buildRecentPlan("p", [], TODAY, routines, [...checks, checkIn("d2", "daily", TODAY)]);
  assert.equal(cell(completed, TODAY).routines[0].isCompleted, true);
  assert.equal(JSON.stringify([routines, checks]), before);
});

test("mounted component defaults, four columns/status in Task, counts, empty priority and readonly calendar", async () => {
  const tasks = [task("idea"), task("noPriority", TODAY, "", { priority: undefined, routeNodeId: "foreignRoute" }),
    task("thisWeek", "2026-09-23"), task("nextWeek", "2026-09-29"),
    ...Array.from({ length: 4 }, (_, i) => task(`dense${i}`, TODAY, TODAY))];
  const props = { projectId: "p", tasks, today: TODAY,
    routes: [{ id: "foreignRoute", title: "Foreign", projectId: "q" }],
    routines: [routine("checked", { rollingWeekColor: "rose" }), routine("unchecked")],
    checkIns: [checkIn("done", "checked", TODAY)] };
  let renderer;
  await act(async () => { renderer = TestRenderer.create(wrapped(ProjectRecentPlanPanel, { ...props, mode: "list" })); });
  const root = renderer.root;
  const groups = root.findAllByType("button").filter(node => "aria-expanded" in node.props);
  assert.deepEqual(groups.map(n => n.props["aria-expanded"]), [false, true, true, false]);
  assert.deepEqual(root.findAllByType("th").filter(n => n.props.scope === "col").map(n => n.children.join("")),
    ["任务", "所属路线", "时间", "优先级"]);
  const row = root.findByProps({ "data-recent-task-id": "noPriority" });
  assert.equal(row.findAllByType("td")[3].children.join(""), "—");
  assert.equal(row.findAllByType("td")[0].findByProps({ className: "status-pill" }).children.join(""), "计划中");
  assert.equal(row.findAllByType("td")[1].findByType("span").children.join(""), "—");
  assert.equal(row.findAllByType("button").length, 0);
  const counts = root.findByProps({ className: "project-recent-plan-counts" }).findAllByType("span");
  assert.deepEqual(counts.map(n => n.children.join("")), ["想法 1", "今天 5", "本周 1", "下周 1"]);
  await act(async () => groups[0].props.onClick());
  assert.equal(root.findByProps({ "data-recent-task-id": "idea" }).type, "tr");
  await act(async () => renderer.update(wrapped(ProjectRecentPlanPanel, { ...props, mode: "calendar" })));
  const weeks = root.findAll(n => n.props["data-week-start"] !== undefined);
  assert.equal(weeks.length, 4);
  assert.equal(weeks[1].props["data-current-week"], true);
  const todayCell = root.findByProps({ "data-date": TODAY });
  const markers = todayCell.findAll(n => n.props["data-routine-id"] !== undefined);
  assert.deepEqual(markers.map(n => n.props["data-completed"]), [true, false]);
  assert.equal(todayCell.findByProps({ className: "project-recent-plan-day-header" }).findAll(n => n.props["data-routine-id"] !== undefined).length, 2);
  assert.equal(root.findAllByProps({ className: "project-recent-plan-task-line" }).length, 0);
  const overflow = root.findByProps({ className: "project-recent-plan-overflow" });
  assert.equal(overflow.type, "span");
  assert.equal(overflow.children.join(""), "+2");
  const displayNodes = root.findAll(n => typeof n.type === "string" &&
    (n.props["data-recent-task-id"] !== undefined || n.props.className?.includes("project-recent-plan-task") || n === overflow));
  for (const node of displayNodes) {
    assert.ok(!["a", "button"].includes(node.type));
    for (const prop of ["onClick", "onKeyDown", "onKeyUp", "tabIndex", "href"]) {
      assert.equal(node.props[prop], undefined);
    }
  }
  for (const node of markers) {
    assert.equal(node.props.onClick, undefined);
    assert.equal(node.props.tabIndex, undefined);
    assert.equal(node.props.title, undefined);
  }
  await act(async () => renderer.unmount());
});

test("actual parent refreshes facts and isolates each Project session choice", async () => {
  const props = { projectId: "p", tasks: [task("old")], routes: [], ganttData: null,
    isGanttLoading: false, researchTraceData: null, isResearchTraceLoading: false };
  let renderer;
  await act(async () => { renderer = TestRenderer.create(wrapped(ProjectVisualizationPanel, props)); });
  const root = renderer.root;
  assert.equal(button(root, "甘特图").props["aria-pressed"], true);
  await act(async () => button(root, "研究脉络").props.onClick());
  assert.equal(root.findAll(n => n.props.className === "project-research-trace-panel").length, 1);
  await act(async () => button(root, "近期计划").props.onClick());
  assert.equal(button(root, "任务清单").props["aria-pressed"], true);
  assert.ok(button(root.findByProps({ className: "project-visualization-header" }), "任务清单"));
  assert.equal(button(root.findByProps({ className: "project-visualization-body" }), "任务清单"), undefined);
  await act(async () => root.findAllByType("button").find(n => "aria-expanded" in n.props).props.onClick());
  await act(async () => renderer.update(wrapped(ProjectVisualizationPanel, { ...props, tasks: [task("refreshed")] })));
  assert.equal(root.findAllByProps({ "data-recent-task-id": "old" }).length, 0);
  assert.equal(root.findAllByProps({ "data-recent-task-id": "refreshed" }).length, 1);
  await act(async () => button(root, "滚动周历").props.onClick());
  await act(async () => renderer.update(wrapped(ProjectVisualizationPanel, { ...props, projectId: "q", tasks: [task("other", "", "", { projectId: "q" })] })));
  assert.equal(button(root, "甘特图").props["aria-pressed"], true);
  await act(async () => button(root, "近期计划").props.onClick());
  assert.equal(button(root, "任务清单").props["aria-pressed"], true);
  assert.equal(root.findAllByProps({ "data-recent-task-id": "refreshed" }).length, 0);
  assert.deepEqual(root.findAllByType("button").filter(n => "aria-expanded" in n.props).map(n => n.props["aria-expanded"]), [false, true, true, false]);
  await act(async () => renderer.update(wrapped(ProjectVisualizationPanel, props)));
  assert.equal(button(root, "滚动周历").props["aria-pressed"], true);
  await act(async () => renderer.update(wrapped(ProjectVisualizationPanel, { ...props, projectId: "q" })));
  assert.equal(button(root, "任务清单").props["aria-pressed"], true);
  await act(async () => renderer.unmount());
});


test("four choices survive actual unmount/remount, inner tab changes, and a fresh application defaults to Gantt", async () => {
  const props={projectId:"session-only",tasks:[],routes:[],ganttData:null,isGanttLoading:false,researchTraceData:null,isResearchTraceLoading:false};
  let renderer;
  for(const [view,mode] of [["甘特图",null],["近期计划","任务清单"],["近期计划","滚动周历"],["研究脉络",null]]) {
    await act(async()=>{renderer=TestRenderer.create(wrapped(ProjectVisualizationPanel,props));});
    await act(async()=>button(renderer.root,view).props.onClick());
    if(mode)await act(async()=>button(renderer.root,mode).props.onClick());
    await act(async()=>renderer.unmount());
    await act(async()=>{renderer=TestRenderer.create(wrapped(ProjectVisualizationPanel,props));});
    assert.equal(button(renderer.root,view).props["aria-pressed"],true);
    if(mode)assert.equal(button(renderer.root,mode).props["aria-pressed"],true);
    if(view==="研究脉络") {
      await act(async()=>button(renderer.root,"近期计划").props.onClick());
      assert.equal(button(renderer.root,"滚动周历").props["aria-pressed"],true);
    }
    await act(async()=>renderer.unmount());
  }
  const fresh={exports:{}};
  new Function("require","module","exports",bundle.outputFiles[0].text)(createRequire(import.meta.url),fresh,fresh.exports);
  await act(async()=>{renderer=TestRenderer.create(React.createElement(fresh.exports.I18nProvider,null,React.createElement(fresh.exports.ProjectVisualizationPanel,props)));});
  assert.equal(button(renderer.root,"甘特图").props["aria-pressed"],true);
  await act(async()=>renderer.unmount());
});
