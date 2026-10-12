import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import React from "react";
import Renderer, { act } from "react-test-renderer";

const ports = {
  planningService: 'export const planningService = {queryReviewCatalog: async () => globalThis.__reviewPage.catalog};',
  planningPageAdapterService: 'export const planningPageAdapterService = {getPlanningReviewTargetsModel: async () => ({projects:[{id:"p",title:"Project",status:"active"},{id:"q",title:"Other",status:"active"}],routeNodes:[],tasks:[]})};',
  reviewSelectorService: 'export const loadReviewSelectedDetail = id => globalThis.__reviewPage.load(id);',
  useReviewManuscriptEditor: 'export const useReviewManuscriptEditor = () => ({available:[], pageState:null, open:false, busy:false, contextInsert:""});',
  useWriteFeedbackCenter: 'const push = (...args) => globalThis.__reviewPage.feedback.push(args); const center = {entries:[],pushPageFeedback:push,pushRefreshEventFeedback:push,pushReloadErrorFeedback:push}; export const useWriteFeedbackCenter = () => center;',
  useRefreshEventReload: 'export const useRefreshEventReload = options => {globalThis.__reviewPage.reload=options.reload;};',
  sharedEditorLifecycleController: 'export const sharedEditorLifecycleController = {requestSequence: async input => { if (!globalThis.__reviewPage.cancel) return input.continuation(); }};',
  I18nProvider: 'export const useI18n = () => ({language:"en-US",t:key=>key});',
  ReviewEvidenceExportPanel: 'export const ReviewEvidenceExportPanel = ({children}) => children(null,null);',
  ReviewQuickAnalysisButton: 'export const ReviewQuickAnalysisButton = () => null;',
  LazyManuscriptSegmentEditorWindow: 'export const LazyManuscriptSegmentEditorWindow = () => null;'
};
const bundle = await build({
  stdin: {contents:'export {ReviewsPage} from "./ReviewsPage"; export {runtimePageSelection} from "../../services/runtimePageSelection";',resolveDir:import.meta.dirname},
  bundle:true,write:false,format:"cjs",platform:"node",target:"es2022",jsx:"automatic",
  external:["react","react/jsx-runtime"],logLevel:"silent",
  plugins:[{name:"page-loading-test-ports",setup(api){
    api.onResolve({filter:/./},args=>{
      const name=args.path.split("/").at(-1);
      if (ports[name] && (args.importer.endsWith("ReviewsPage.tsx") || name==="I18nProvider"))
        return {path:name,namespace:"page-port"};
    });
    api.onLoad({filter:/./,namespace:"page-port"},args=>({contents:ports[args.path]}));
  }}]
});
const module={exports:{}};
new Function("require","module","exports",bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {ReviewsPage,runtimePageSelection:memory}=module.exports;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function review(id){return{id,projectId:"p",title:`Review ${id}`,reviewType:"custom",structuredStateStatus:"available",structuredRevision:1,
  outlineSections:[{key:"custom_summary",content:`Summary ${id}`}],tags:[],createdAt:"2026-10-09",updatedAt:"2026-10-09"};}
function result(id){const r=review(id);return[[],[],[],{review:r,directTargets:[],pathMaterialSummaries:[],derivedEvidence:[],warnings:[],missing:[],partial:false,
  manuscriptSummary:{manuscriptFileCount:0,attachmentCount:0,hasManagedWorkspace:false,outlineSectionCount:1}}];}
function setup(load){memory.remember("reviews","p",null);memory.remember("reviews","q",null);globalThis.window={};globalThis.__reviewPage={catalog:[review("a"),review("b")],load,feedback:[]};}
async function mount(){let node;await act(async()=>{node=Renderer.create(React.createElement(ReviewsPage));});return node;}
const cards=node=>node.root.findAll(x=>x.type==="button"&&String(x.props.className).includes("reviews-record-card"));
const heading=node=>node.root.findAll(x=>x.type==="div"&&x.props.className==="reviews-detail-heading").map(x=>JSON.stringify(x.findByType("h2").props.children)).join();

test("actual page selection ignores late old-owner success and re-reads on refresh",async()=>{
  const a=deferred(), calls=[];setup(id=>{calls.push(id);return id==="a"?a.promise:Promise.resolve(result(id));});
  const node=await mount();
  await act(async()=>{cards(node)[0].props.onClick();});
  await act(async()=>{await cards(node)[1].props.onClick();});
  assert.ok(heading(node).includes("Review b"));
  await act(async()=>{a.resolve(result("a"));});
  assert.ok(heading(node).includes("Review b"));
  await act(async()=>{await globalThis.__reviewPage.reload();});
  assert.equal(calls.filter(x=>x==="b").length,2);assert.ok(heading(node).includes("Review b"));
  await act(async()=>{node.unmount();});
});
test("actual page keeps selected-detail failure distinct from successful empty targets",async()=>{
  setup(async()=>{throw Error("TARGET_READ_FAILED");});const node=await mount();await act(async()=>{cards(node)[0].props.onClick();});
  assert.equal(heading(node),"");
  assert.ok(globalThis.__reviewPage.feedback.some(args=>args[0].operation==="reviewTargets.load"));
  globalThis.__reviewPage.load=async id=>result(id);
  await act(async()=>{await globalThis.__reviewPage.reload();});
  assert.ok(heading(node).includes("Review a"));await act(async()=>{node.unmount();});
});
test("late failed request after selection/unmount cannot publish obsolete feedback",async()=>{
  const a=deferred();setup(id=>id==="a"?a.promise:Promise.resolve(result(id)));const node=await mount();
  await act(async()=>{cards(node)[0].props.onClick();});
  await act(async()=>{await cards(node)[1].props.onClick();});
  await act(async()=>{node.unmount();a.reject(Error("STALE_FAILURE"));});
  assert.equal(globalThis.__reviewPage.feedback.length,0);
});
test("A to B to A keeps the newest A request when the first A completes last",async()=>{
  const old=deferred();let aReads=0;
  setup(id=>{if(id==="a"&&++aReads===1)return old.promise;const value=result(id);value[3].review.title=`Latest ${id}`;return Promise.resolve(value);});
  const node=await mount();
  await act(async()=>{cards(node)[0].props.onClick();});
  await act(async()=>{await cards(node)[1].props.onClick();});
  await act(async()=>{await cards(node)[0].props.onClick();});
  assert.ok(heading(node).includes("Latest a"));
  await act(async()=>{old.resolve(result("a"));});
  assert.ok(heading(node).includes("Latest a"));await act(async()=>{node.unmount();});
});

test("first entry is catalog-only; returning restores ID and fresh reads, cancelled selection preserves memory",async()=>{
  const calls=[];setup(async id=>{calls.push(id);return result(id);});let node=await mount();
  assert.deepEqual(calls,[]);assert.equal(heading(node),"");
  await act(async()=>{cards(node)[0].props.onClick();});assert.equal(calls.length,1);
  __reviewPage.cancel=true;await act(async()=>{cards(node)[1].props.onClick();});
  assert.equal(memory.read("reviews","p"),"a");assert.ok(heading(node).includes("Review a"));
  await act(async()=>node.unmount());__reviewPage.cancel=false;node=await mount();assert.equal(calls.length,2);assert.ok(heading(node).includes("Review a"));
  await act(async()=>node.unmount());__reviewPage.catalog=[];node=await mount();assert.equal(heading(node),"");assert.equal(memory.read("reviews","p"),null);await act(async()=>node.unmount());
});
test("Project A to B to A restores only that scope and makes a new canonical read",async()=>{
  const calls=[];setup(async id=>{calls.push(id);const r=result(id);if(id==='q-review')r[3].review.projectId='q';return r;});
  __reviewPage.catalog.push({...review('q-review'),projectId:'q'});const node=await mount();
  const project=()=>node.root.findAllByType('select')[0];
  await act(async()=>cards(node)[0].props.onClick());
  await act(async()=>project().props.onChange({target:{value:'q'}}));assert.equal(heading(node),'');assert.equal(calls.length,1);
  await act(async()=>cards(node)[0].props.onClick());assert.ok(heading(node).includes('q-review'));
  await act(async()=>project().props.onChange({target:{value:'p'}}));assert.ok(heading(node).includes('Review a'));assert.deepEqual(calls,['a','q-review','a']);
  await act(async()=>node.unmount());
});

test("formal five target groups and necessary missing warning remain without secondary aggregation; loading is immediate",async()=>{
 const pending=deferred();setup(()=>pending.promise);const n=await mount();await act(async()=>cards(n)[0].props.onClick());assert.ok(JSON.stringify(n.toJSON()).includes('Loading'));
 const r=result('a');r[3].directTargets=['routeNode','task','experiment','experimentRun','literature'].map(targetType=>({targetType,targetId:targetType,title:`Formal ${targetType}`,missing:targetType==='task'}));r[3].directTargets.push({targetType:'project',targetId:'p',title:'Anchor excluded'});r[3].warnings=[{code:'missing_formal_target',message:'Formal task missing'}];r[3].missing=[{message:'Task reference unavailable'}];r[3].partial=true;
 await act(async()=>pending.resolve(r));const text=JSON.stringify(n.toJSON());for(const type of ['routeNode','task','experiment','experimentRun','literature'])assert.ok(text.includes(`Formal ${type}`));assert.ok(!text.includes('Anchor excluded'));assert.ok(text.includes('Formal task missing'));assert.equal(n.root.findAllByProps({className:'review-object-group'}).length,5);await act(async()=>n.unmount());
});
test("cancelled project and filter changes preserve current owner and scoped ID",async()=>{
 setup(async id=>result(id));const n=await mount();await act(async()=>cards(n)[0].props.onClick());__reviewPage.cancel=true;
 await act(async()=>n.root.findAllByType('select')[0].props.onChange({target:{value:'q'}}));await act(async()=>n.root.findAllByType('select')[1].props.onChange({target:{value:'stage'}}));assert.ok(heading(n).includes('Review a'));assert.equal(memory.read('reviews','p'),'a');assert.equal(n.root.findAllByType('select')[0].props.value,'p');assert.equal(n.root.findAllByType('select')[1].props.value,'all');await act(async()=>n.unmount());
});

test("rapid unmount and reenter of the same owner fresh reads and discards old mount success",async()=>{
 const old=deferred();let reads=0;setup(id=>++reads===1?old.promise:Promise.resolve(result(id)));let n=await mount();await act(async()=>cards(n)[0].props.onClick());await act(async()=>n.unmount());n=await mount();assert.ok(heading(n).includes('Review a'));const stale=result('a');stale[3].review.title='STALE_OLD_MOUNT';await act(async()=>old.resolve(stale));assert.ok(!heading(n).includes('STALE_OLD_MOUNT'));assert.equal(reads,2);await act(async()=>n.unmount());
});
