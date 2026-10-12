import assert from "node:assert/strict";
import test from "node:test";
import {build} from "esbuild";
import {createRequire} from "node:module";
import React from "react";
import Renderer,{act} from "react-test-renderer";

// Mount the production page and its real request coordinator/confirmation hook.
// Canonical transport and presentation ports are controlled; no timing claims.
const ports={
 planningService:'export const planningService=new Proxy({}, {get:(_,name)=>(...args)=>globalThis.__routesPage.read(name,args)});',
 planningPageAdapterService:'export const planningPageAdapterService={getPlanningRoutesPageDisplayModel:(...args)=>globalThis.__routesPage.model(...args),readRouteDeleteImpactCounts:(...args)=>globalThis.__routesPage.impact(...args)};',
 useWriteFeedbackCenter:'const push=(...args)=>globalThis.__routesPage.feedback.push(args);const center={entries:[],pushWriteFeedback:push,consumeWriteError:push,pushRefreshEventFeedback:push,pushReloadErrorFeedback:push};export const useWriteFeedbackCenter=()=>center;',
 useRefreshEventReload:'export const useRefreshEventReload=options=>{globalThis.__routesPage.reload=options.reload;};',
 I18nProvider:'export const useI18n=()=>({language:"en-US",t:key=>key});',
 OperationConfirmDialog:'import React from "react";export const OperationConfirmDialog=props=>React.createElement("test-confirm",props);',
 WriteFeedbackPanel:'export const WriteFeedbackPanel=()=>null;',
 outputGapFeedbackCardSelectorService:'export const outputGapFeedbackCardSelectorService={getPlanningFeedbackCardSummary:async()=>null};',
 projectResearchTracePreferenceUiService:'export const getResearchTraceDisplayChecked=async()=>false;export const isRouteResearchTraceDefaultDisplayed=()=>false;export const saveResearchTraceDisplayPreference=async()=>{};'
};
const bundle=await build({stdin:{contents:'export {RoutesPage} from "./RoutesPage";',resolveDir:import.meta.dirname},bundle:true,write:false,format:"cjs",platform:"node",target:"es2022",jsx:"automatic",external:["react","react/jsx-runtime"],logLevel:"silent",
 plugins:[{name:"page-ports",setup(api){api.onResolve({filter:/./},args=>{
  if(args.path==="react-router-dom")return{path:"router",namespace:"port"};
  const name=args.path.split("/").at(-1);if(ports[name]&&(args.importer.endsWith("RoutesPage.tsx")||name==="I18nProvider"))return{path:name,namespace:"port"};
 });api.onLoad({filter:/.*/,namespace:"port"},args=>({contents:args.path==="router"?'const params=new URLSearchParams();export const useSearchParams=()=>[params];':ports[args.path]}));}}]});
const mod={exports:{}};new Function("require","module","exports",bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);const {RoutesPage}=mod.exports;
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const route=(id="a",title=`Current ${id}`)=>({id,projectId:id==="a"?"p":"q",title,description:"Canonical description",status:"in_progress",planningStatus:"active",captureState:"scheduled",nodeType:"work",orderIndex:0,timeLabel:"October",timeScale:"month",showInGantt:true,expectedOutput:"",startDate:"2026-10-01",endDate:"2026-10-10",customFields:{},createdAt:"2026-10-09",updatedAt:"2026-10-09"});
const model=(title="Current a")=>({projects:[{id:"p",name:"P",title:"P"},{id:"q",name:"Q",title:"Q"}],routeNodes:[route("a",title),route("b")],checkpointSummariesByRouteNodeId:{a:{total:2,completionRate:50},b:{total:0,completionRate:0}}});
function setup(){globalThis.window={localStorage:{getItem:()=>"p",setItem:()=>{}}};const state={feedback:[],writes:[],reads:[],modelCalls:[],impactCalls:[],model:async()=>model(),impact:async()=>({checkpointCount:2,taskCount:3,gapCount:4})};
 state.read=async(name,args)=>{state.reads.push({name,args});if(name==="queryRouteNodes")return[route("a"),route("b")];if(name==="queryRouteCheckpointsByRouteNode")return[];if(name==="deleteRouteNode"){state.writes.push(args[0]);return false;}throw Error(`Unexpected ${name}`);};globalThis.__routesPage=state;return state;}
async function mount(){let node;await act(async()=>{node=Renderer.create(React.createElement(RoutesPage));});return node;}
const cards=node=>node.root.findAll(x=>x.type==="button"&&String(x.props.className).includes("route-detail-card"));
const select=node=>node.root.findAllByType("select").find(x=>x.props["aria-label"]==="project");
const confirm=node=>node.root.findByType("test-confirm").props;
const footer=node=>node.root.findAll(x=>typeof x.type==="function"&&x.props.className==="route-editor-modal__footer")[0];
const close=node=>node.root.findAll(x=>x.type==="div"&&String(x.props.className).includes("route-editor-modal-backdrop"))[0];
const text=node=>JSON.stringify(node.toJSON());

test("normal page uses display projection, preserves checkpoint facts and refresh reads fresh",async()=>{
 const s=setup();let count=0;s.model=async()=>{count++;return model(count===1?"Initial":"Refreshed");};const node=await mount();
 assert.ok(text(node).includes("Initial"));assert.ok(text(node).includes("50"));
 await act(async()=>{await s.reload();});assert.ok(text(node).includes("Refreshed"));assert.equal(count,2);assert.equal(s.writes.length,0);await act(async()=>node.unmount());
});
test("required read failure is shown and retry can restore current content",async()=>{
 const s=setup();s.model=async()=>{throw Error("PAGE_READ_FAILED");};const node=await mount();assert.ok(text(node).includes("PAGE_READ_FAILED"));assert.equal(cards(node).length,0);
 s.model=async()=>model();await act(async()=>{await s.reload();});assert.equal(cards(node).length,1);await act(async()=>node.unmount());
});
test("actual A to B to A uses newest request, ignores late old owner success and unmounted failure",async()=>{
 const s=setup(),old=defer();let n=0;s.model=()=>++n===1?old.promise:Promise.resolve(model(`Latest ${n}`));const node=await mount();
 await act(async()=>select(node).props.onChange({target:{value:"q"}}));assert.ok(text(node).includes("Current b"));
 await act(async()=>select(node).props.onChange({target:{value:"p"}}));assert.ok(text(node).includes("Latest 3"));
 await act(async()=>old.resolve(model("Obsolete")));assert.ok(text(node).includes("Latest 3"));assert.equal(text(node).includes("Obsolete"),false);
 const late=defer();s.model=()=>late.promise;await act(async()=>select(node).props.onChange({target:{value:"q"}}));await act(async()=>{node.unmount();late.reject(Error("UNMOUNTED"));});assert.equal(s.feedback.length,0);
});
test("delete intent uses freshly read counts, cancellation writes nothing and repeat intent rereads",async()=>{
 const s=setup();let n=0;s.impact=async()=>{n++;return{checkpointCount:n,taskCount:n+1,gapCount:n+2};};const node=await mount();await act(async()=>cards(node)[0].props.onClick());
 await act(async()=>footer(node).props.onDelete());assert.ok(confirm(node).preview.affectedItems.some(x=>x.title==="routeDeleteImpactGaps: 3"));
 await act(async()=>confirm(node).onCancel());assert.equal(s.writes.length,0);
 await act(async()=>footer(node).props.onDelete());assert.ok(confirm(node).preview.affectedItems.some(x=>x.title==="routeDeleteImpactGaps: 4"));
 await act(async()=>confirm(node).onCancel());assert.equal(n,2);assert.equal(s.writes.length,0);await act(async()=>node.unmount());
});
test("delete-impact failure cannot open confirmation or invoke writer and can be retried",async()=>{
 const s=setup();s.impact=async()=>{throw Error("IMPACT_READ_FAILED");};const node=await mount();await act(async()=>cards(node)[0].props.onClick());
 await act(async()=>footer(node).props.onDelete());assert.equal(confirm(node).preview,null);assert.equal(s.writes.length,0);assert.ok(s.feedback.some(x=>String(x[0]).includes("IMPACT_READ_FAILED")));
 s.impact=async()=>({checkpointCount:0,taskCount:0,gapCount:0});await act(async()=>footer(node).props.onDelete());assert.ok(confirm(node).preview);await act(async()=>confirm(node).onCancel());await act(async()=>node.unmount());
});
test("late impact after close/reopen of same owner and unmount is ignored",async()=>{
 const s=setup(),old=defer();let n=0;s.impact=()=>++n===1?old.promise:Promise.resolve({checkpointCount:0,taskCount:0,gapCount:9});const node=await mount();await act(async()=>cards(node)[0].props.onClick());await act(async()=>footer(node).props.onDelete());
 await act(async()=>close(node).props.onClick());await act(async()=>cards(node)[0].props.onClick());await act(async()=>footer(node).props.onDelete());assert.ok(confirm(node).preview.affectedItems.some(x=>x.title==="routeDeleteImpactGaps: 9"));
 await act(async()=>old.resolve({checkpointCount:88,taskCount:88,gapCount:88}));assert.equal(text(node).includes("88"),false);await act(async()=>confirm(node).onCancel());
 const late=defer();s.impact=()=>late.promise;await act(async()=>footer(node).props.onDelete());await act(async()=>{node.unmount();late.reject(Error("OLD_IMPACT"));});assert.equal(s.writes.length,0);assert.equal(s.feedback.some(x=>String(x[0]).includes("OLD_IMPACT")),false);
});
test("duplicate delete intents are bounded until confirmation; only confirmed current intent invokes writer",async()=>{
 const s=setup(),pending=defer();let n=0;s.impact=()=>{n++;return pending.promise;};const node=await mount();await act(async()=>cards(node)[0].props.onClick());await act(async()=>{footer(node).props.onDelete();footer(node).props.onDelete();});assert.equal(n,1);assert.equal(footer(node).props.deleteDisabled,true);
 await act(async()=>pending.resolve({checkpointCount:0,taskCount:0,gapCount:0}));await act(async()=>confirm(node).onConfirm());assert.deepEqual(s.writes,["a"]);await act(async()=>node.unmount());
});

test("pending delete impact from an earlier A cannot commit after Project A to B to A",async()=>{
 const s=setup(),old=defer();s.impact=()=>old.promise;const node=await mount();await act(async()=>cards(node)[0].props.onClick());await act(async()=>footer(node).props.onDelete());
 await act(async()=>select(node).props.onChange({target:{value:"q"}}));await act(async()=>select(node).props.onChange({target:{value:"p"}}));
 await act(async()=>old.resolve({checkpointCount:88,taskCount:88,gapCount:88}));assert.equal(confirm(node).preview,null);assert.equal(s.writes.length,0);assert.equal(footer(node).props.deleteDisabled,false);await act(async()=>node.unmount());
});
