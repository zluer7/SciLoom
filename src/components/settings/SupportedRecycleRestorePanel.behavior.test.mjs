import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const bundle = await build({
  stdin: { contents: `export { SettingsPage } from './src/pages/Settings/SettingsPage.tsx';
    export { SupportedRecycleRestorePanel } from './src/components/settings/SupportedRecycleRestorePanel.tsx';
    export * from './src/services/supportedRestoreService.ts';`, resolveDir: resolve('.'), sourcefile: 'b4-mounted-restore-harness.ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'b4-current-service-ports', setup(api) {
    const ports = {
      'planningRepository': `export const getPlanningFirstLayerData=()=>globalThis.__b4.readPlanning();`,
      'planningService': `export const planningService={restoreTask:id=>globalThis.__b4.restore('task',id),restoreRouteNode:id=>globalThis.__b4.restore('routeNode',id)};`,
      'recycleBinService': `export const listRecentlyDeleted=()=>globalThis.__b4.readDeleted(); export const restoreDeletedEntity=input=>globalThis.__b4.restore(input.entityType,input.entityId,input);`,
      'reviewDeleteSafetyService': `export const queryReviewRecycleEntries=()=>globalThis.__b4.reviews; export const resolveExactReviewRestoreCapability=(id,entry)=>globalThis.__b4.reviewCapability(id,entry); export const restoreDeletedReview=(id,input)=>globalThis.__b4.restore('review',id,input);`,
      'reviewLifecycleActionService': `export const reviewLifecycleActionPort={listPending:async()=>globalThis.__b4.pending};`,
      'fileRefOwnerValidator': `export const resolveMountedManuscriptLifecycleDecision=async input=>globalThis.__b4.lifecycle(input);`,
      'outputDeleteSafetyService': `export const getOutputDeleteImpactPreview=async input=>globalThis.__b4.outputPreview(input); export const confirmOutputDeleteImpactPreview=preview=>({...preview,confirmedByUser:true}); export const restoreOutputEntity=({confirmation})=>globalThis.__b4.restore('output:'+confirmation.layer,confirmation.id,confirmation);`,
      'useWriteFeedbackCenter': `export const useWriteFeedbackCenter=()=>({entries:[],dismissFeedback(){},consumeWriteError(){},consumeWriteResult(){},pushWriteFeedback(){}});`,
      'I18nProvider': `export const useI18n=()=>({language:globalThis.__b4.language,t:key=>({operationConfirmTitle:'Confirm operation',operationKnownImpact:'Known impact',operationTarget:'Target',operationWarnings:'Warnings',operationRiskReviewNotice:'Review the effect'}[key]??key)});`,
      'ModalPortal': `export const ModalPortal=({children})=>children;`,
      'SettingsPanel': `export const SettingsPanel=({renderSections})=>renderSections({dataSourceSettings:null});`
    };
    api.onResolve({ filter: /\/(planningRepository|planningService|recycleBinService|reviewDeleteSafetyService|reviewLifecycleActionService|fileRefOwnerValidator|outputDeleteSafetyService|useWriteFeedbackCenter|I18nProvider|ModalPortal|SettingsPanel)$/u }, args=>({path:args.path.split('/').at(-1),namespace:'b4-port'}));
    api.onResolve({ filter: /components\/(feedback\/WriteFeedbackPanel|settings\/(ManagedRootSettingsPanel|AIProviderSettingsPanel|AppearanceSettingsPanel|ProjectImportPanel|ProjectExportV1Panel|BusinessOperationHistoryPanel|RecentOperationLogPanel))$/u }, args=>({path:args.path.split('/').at(-1),namespace:'b4-port'}));
    api.onLoad({filter:/.*/u,namespace:'b4-port'},({path})=>({loader:'js',contents:ports[path]??`export const ${path}=()=>null;`}));
  }}]
});
const module = { exports: {} };
new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const subject=module.exports;
const time='2026-10-03T12:00:00Z';
const summary=(type,id=type)=>({entityType:type,entityId:id,title:`Name ${type} Ω`,deletedAt:time,canRestore:true,restoreStatus:'not_started',recycleEntryId:`entry-${id}`,createdByLifecycleActionId:`delete-${id}`,revision:1,refreshKeys:[]});
const archived=(type,id=type)=>({id,title:`Name ${type} Ω`,projectId:'p',updatedAt:time,status:'archived',archivedAt:time,captureState:'archived'});
function fixture() {
  const f={language:'en-US',planning:{projects:[{id:'p',status:'active'}],tasks:[archived('task')],routeNodes:[archived('routeNode')],reviews:[{id:'review',projectId:'p',title:'Review Ω',deletedAt:time,updatedAt:time}]},deleted:['experiment','experimentRun','literature','resultItem','finding','outputCandidate','outputGap','output'].map(type=>summary(type)),reviews:[summary('review')],pending:[],writes:[],reads:0,readFault:false,readDelay:null,resultStatus:'success',restoreDelay:null,throwAfterCommit:false};
  f.readPlanning=async()=>{f.reads++;if(f.readFault)throw Error('SQL revision raw-secret');return f.readDelay?f.readDelay():structuredClone(f.planning);};
  f.readDeleted=async()=>structuredClone(f.deleted);
  f.reviewCapability=async(id,entry)=>({canRestore:f.reviews.some(row=>row.entityId===id&&row.recycleEntryId===entry&&row.canRestore)&&f.planning.projects[0].status==='active',reasonCode:'ready'});
  f.lifecycle=input=>({canRestore:f.deleted.some(row=>row.entityId===input.ownerId&&row.canRestore),entity:{id:input.ownerId,updatedAt:time,deletedAt:time}});
  f.outputPreview=input=>({...input,title:'Output Ω',canDelete:f.deleted.some(row=>row.entityId===input.id&&row.canRestore),previewHash:'frozen-hash',warnings:[],affectedItems:[]});
  f.restore=async(type,id,input)=>{
    f.writes.push({type,id,input});
    if(f.restoreDelay)await f.restoreDelay;
    if(f.resultStatus==='success'||f.resultStatus==='partial'||f.throwAfterCommit){
      if(type==='task'||type==='routeNode'){const row=f.planning[type==='task'?'tasks':'routeNodes'].find(row=>row.id===id);row.status=type==='task'?'todo':'planned';row.captureState='pending';delete row.archivedAt;}
      else if(type==='review'){delete f.planning.reviews.find(row=>row.id===id).deletedAt;f.reviews=[];}
      else f.deleted=f.deleted.filter(row=>row.entityId!==id);
    }
    if(f.throwAfterCommit)throw Error('readback outcome unknown');
    return type==='task'||type==='routeNode'?{id,status:type==='task'?'todo':'planned'}:{status:f.resultStatus};
  };
  globalThis.__b4=f;
  globalThis.window={addEventListener(){},removeEventListener(){}};
  return f;
}
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(' '):text(node?.children??[]);
const panel=renderer=>renderer.root.findByProps({'data-settings-top-level':'supported-restore'});
const rows=renderer=>panel(renderer).findAllByType('article');
const rowFor=(renderer,type)=>rows(renderer).find(row=>row.props['data-restore-row'].includes(`:${type}:`));
const dialog=renderer=>renderer.root.findByProps({role:'alertdialog'});
const confirmButton=renderer=>dialog(renderer).findAllByType('button')[0];
const cancelButton=renderer=>dialog(renderer).findAllByType('button')[1];
const refreshButton=renderer=>panel(renderer).findByProps({className:'settings-primary-section__title operation-center-heading'}).findByType('button');
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};
async function mount(component=subject.SupportedRecycleRestorePanel){let renderer;await act(async()=>{renderer=TestRenderer.create(React.createElement(component));});return renderer;}
async function clickRestore(renderer,type){await act(async()=>rowFor(renderer,type).findByType('button').props.onClick());}
async function unmount(renderer){await act(async()=>renderer.unmount());}

test('production Settings mounts the restricted entry with every declared supported type and no other write actions',async()=>{
  const f=fixture();const renderer=await mount(subject.SettingsPage);
  assert.equal(rows(renderer).length,11);
  assert.match(text(panel(renderer)),/Recently deleted \/ Restorable/);
  assert.match(text(rowFor(renderer,'task')),/Archived/);
  assert.match(text(rowFor(renderer,'review')),/Soft-deleted/);
  assert.doesNotMatch(text(panel(renderer)),/raw-secret|private-id|repair|Continue|Delete permanently/);
  assert.deepEqual(f.writes,[]);
  console.log('B4_MOUNTED_ENTRY',JSON.stringify({tree:renderer.toJSON(),supportedRows:rows(renderer).length,mutationBeforeConfirmation:f.writes.length}));
  await unmount(renderer);
});

test('all declared types dispatch to existing typed intents only after explicit confirmation',async()=>{
  for(const type of subject.SUPPORTED_RESTORE_TYPES){
    const f=fixture();const item=(await subject.listSupportedRestores()).find(row=>row.entityType===type);const prepared=await subject.prepareSupportedRestore(item);
    assert.equal((await subject.executeSupportedRestore(prepared,false)).status,'skipped');assert.deepEqual(f.writes,[]);
    assert.equal((await subject.executeSupportedRestore(prepared,true)).status,'success');assert.equal(f.writes.length,1);
    assert.equal(f.writes[0].id,type);
    if(type==='review'){assert.equal(f.writes[0].input.recycleEntryId,'entry-review');assert.equal(f.writes[0].input.sourceDeleteActionId,'delete-review');assert.equal(f.writes[0].input.confirmedByUser,true);}
    if(['resultItem','finding','outputCandidate','outputGap','output'].includes(type)){assert.equal(f.writes[0].input.previewHash,'frozen-hash');assert.equal(f.writes[0].input.mode,'restore');assert.equal(f.writes[0].input.confirmedByUser,true);assert.equal(f.writes[0].input.layer,type==='output'?'researchOutput':type);}
  }
});

test('confirmation shows exact object/effect, cancel and refresh are readonly, and duplicate clicks are fenced',async()=>{
  const f=fixture();const renderer=await mount();
  await act(async()=>refreshButton(renderer).props.onClick());assert.deepEqual(f.writes,[]);
  await clickRestore(renderer,'task');assert.match(text(dialog(renderer)),/Name task Ω/);assert.match(text(dialog(renderer)),/status To do/);assert.deepEqual(f.writes,[]);
  await act(async()=>rowFor(renderer,'review').findByType('button').props.onClick());assert.match(text(dialog(renderer)),/Name task Ω/);
  await act(async()=>cancelButton(renderer).props.onClick());assert.deepEqual(f.writes,[]);
  await clickRestore(renderer,'review');assert.match(text(dialog(renderer)),/soft-deleted metadata/);
  const pending=deferred();f.restoreDelay=pending.promise;
  await act(async()=>confirmButton(renderer).props.onClick());assert.equal(f.writes.length,1);assert.equal(f.writes[0].type,'review');
  assert.ok(rows(renderer).every(row=>row.findByType('button').props.disabled));
  await act(async()=>rowFor(renderer,'task').findByType('button').props.onClick());assert.equal(f.writes.length,1);
  await act(async()=>pending.resolve());assert.match(text(panel(renderer)),/Restore confirmed successful/);
  assert.equal(rowFor(renderer,'review'),undefined);await unmount(renderer);
});

test('unsupported/permanent/deleted/archive-only/unbound/pending and parent or Route mismatch are omitted before action',async()=>{
  const f=fixture();f.deleted.push(...['fileRef','literatureLink','resultMetric','unknown','task','routeNode'].map(type=>summary(type)));
  f.deleted.find(row=>row.entityType==='outputGap').restoreStatus='permanently_deleted';
  f.deleted.find(row=>row.entityType==='finding').recycleEntryId=undefined;
  f.planning.tasks[0].deletedAt=time;f.planning.reviews[0].status='archived';
  let items=await subject.listSupportedRestores();assert.ok(!items.some(row=>['task','review','outputGap','finding','fileRef','unknown'].includes(row.entityType)));
  delete f.planning.tasks[0].deletedAt;f.planning.tasks[0].routeNodeId='missing';f.planning.reviews[0].status='active';f.pending=[{reviewId:'review',operationType:'review_soft_delete'}];
  items=await subject.listSupportedRestores();assert.ok(!items.some(row=>['task','review'].includes(row.entityType)));
  f.planning.projects[0].status='archived';items=await subject.listSupportedRestores();assert.ok(!items.some(row=>['task','routeNode','review'].includes(row.entityType)));
  assert.deepEqual(f.writes,[]);
});

test('state changed after preview or object selection cannot retarget the confirmed restore',async()=>{
  const f=fixture();const renderer=await mount();await clickRestore(renderer,'task');
  f.planning.tasks[0].updatedAt='2026-10-03T16:00:00Z';
  await act(async()=>confirmButton(renderer).props.onClick());assert.deepEqual(f.writes,[]);assert.match(text(panel(renderer)),/state changed/);
  await clickRestore(renderer,'routeNode');await unmount(renderer);assert.deepEqual(f.writes,[]);
});

test('known restore success followed by list failure stays success; reading recovery never retries restore',async()=>{
  const f=fixture();const original=f.restore;f.restore=async(...args)=>{const result=await original(...args);f.readFault=true;return result;};
  const renderer=await mount();await clickRestore(renderer,'task');await act(async()=>confirmButton(renderer).props.onClick());
  assert.match(text(panel(renderer)),/Restore confirmed successful/);assert.match(text(panel(renderer)),/list could not be read/);assert.equal(f.writes.length,1);
  f.readFault=false;await act(async()=>refreshButton(renderer).props.onClick());assert.equal(f.writes.length,1);assert.match(text(panel(renderer)),/Restore confirmed successful/);assert.equal(rowFor(renderer,'task'),undefined);
  await unmount(renderer);
});

test('partial/skipped/error and uncertain commit stay truthful without automatic retry or invented rollback',async()=>{
  for(const status of ['partial','skipped','error','unknown']){
    const f=fixture();f.resultStatus=status==='unknown'?'success':status;f.throwAfterCommit=status==='unknown';
    const renderer=await mount();await clickRestore(renderer,'review');await act(async()=>confirmButton(renderer).props.onClick());
    assert.equal(f.writes.length,1);assert.doesNotMatch(text(panel(renderer)),/Restore confirmed successful/);
    assert.match(text(panel(renderer)),new RegExp({partial:'partial success',skipped:'restore was skipped',error:'returned an error',unknown:'outcome is unconfirmed'}[status]));
    await act(async()=>refreshButton(renderer).props.onClick());assert.equal(f.writes.length,1);
    await unmount(renderer);
  }
});

test('loading, read failure, supported empty state and missing title/time are distinct, with bilingual product copy',async()=>{
  const f=fixture();const wait=deferred();f.readDelay=()=>wait.promise;const renderer=await mount();assert.match(text(panel(renderer)),/Loading restorable objects/);
  await act(async()=>wait.resolve(f.planning));f.readDelay=null;f.readFault=true;await act(async()=>refreshButton(renderer).props.onClick());assert.match(text(panel(renderer)),/list could not be read/);assert.doesNotMatch(text(panel(renderer)),/No restorable objects|raw-secret/);
  f.readFault=false;f.planning.tasks=[];f.planning.routeNodes=[];f.planning.reviews=[];f.reviews=[];f.deleted=[];
  await act(async()=>refreshButton(renderer).props.onClick());assert.match(text(panel(renderer)),/No restorable objects/);
  f.planning.tasks=[{...archived('task'),title:'task',archivedAt:undefined}];await act(async()=>refreshButton(renderer).props.onClick());assert.match(text(rowFor(renderer,'task')),/Object name unavailable/);assert.match(text(rowFor(renderer,'task')),/Time unavailable/);
  await act(async()=>{f.language='zh-CN';renderer.update(React.createElement(subject.SupportedRecycleRestorePanel));});assert.match(text(panel(renderer)),/最近删除 \/ 可恢复/);
  await clickRestore(renderer,'task');assert.match(text(dialog(renderer)),/状态设为待办/);await act(async()=>cancelButton(renderer).props.onClick());assert.deepEqual(f.writes,[]);await unmount(renderer);
});
