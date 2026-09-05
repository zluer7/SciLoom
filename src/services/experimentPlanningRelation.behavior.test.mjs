import assert from "node:assert/strict";
import test from "node:test";
import { build, transform } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = import.meta.dirname;
const stubs = {
  repositoryFactory: `export function createRepository(config) {
    const table=()=>globalThis.__d4.tables[config.tableName]??=(new Map());
    const get=async id=>structuredClone(table().get(id));
    const update=async(id,patch)=>{globalThis.__d4.writes++;const row={...table().get(id),...patch,updatedAt:'v'+globalThis.__d4.writes};table().set(id,row);return structuredClone(row)};
    return {list:async()=>[...table().values()].filter(x=>!x.deletedAt).map(x=>structuredClone(x)),getById:get,getDeletedById:async()=>undefined,
      create:async(input,options={})=>{const id=options.id??config.idPrefix+'-'+(++globalThis.__d4.sequence);globalThis.__d4.writes++; const row={...input,id,createdAt:options.createdAt??'created',updatedAt:'v'+globalThis.__d4.writes,deletedAt:null};table().set(id,row);return structuredClone(row)},
      update,updateWithExpectedUpdatedAt:async(id,patch,guard)=>table().get(id)?.updatedAt===guard.expectedUpdatedAt?update(id,patch):undefined};
  }`,
  planningService: `const query=key=>async()=>{globalThis.__d4.lookups++;if(globalThis.__d4.unavailable)throw new Error('Planning unavailable');return globalThis.__d4[key].filter(x=>!x.deletedAt&&!x.archivedAt&&x.status!=='archived'&&x.captureState!=='archived')};
    export async function getProjectById(id){return globalThis.__d4.projects.find(x=>x.id===id)};
    export const planningService={getProjectById,queryProjects:query('projects'),queryRouteNodes:query('routeNodes'),queryTasks:query('tasks')};`,
  planningRepository: `export async function getPlanningData(){return globalThis.__d4}; export const getPlanningFirstLayerData=getPlanningData; export function createEntityLink(){throw Error('outside test')}; export const deleteEntityLink=createEntityLink;`,
  experimentManuscriptProvisioningService: `export async function preflightExperimentManuscriptProvisioningCandidate(){return {status:'ready',descriptor:{}}}; export async function ensureExperimentManuscriptProvisioned(){return {completionState:'complete'}}`,
  experimentRunManuscriptProvisioningService: `export async function ensureExperimentRunManuscriptProvisioned(id){return {completionState:'complete',ownerType:'experimentRun',ownerId:id,channel:'primary',workspacePathIdentity:'fixture',defaultFilePath:'fixture',defaultFolderFileRefId:'folder',defaultManuscriptFileRefId:'file',bindingId:'binding',defaultFileRefId:'file',currentFileRefId:'file',physicalDirectoryState:'existing',physicalFileState:'existing',writable:true,readOnly:false,deleted:false,errors:[]}}`,
  crossModuleWriteFeedbackService: `export const createCrossModuleWriteFeedback=x=>x;export function publishCrossModuleWriteFeedback(){}`,
  experimentRunLifecycleService: `export async function softDeleteExperimentMetadata(){throw Error('outside test')};export const softDeleteExperimentRunMetadata=softDeleteExperimentMetadata;export const restoreExperimentMetadata=softDeleteExperimentMetadata;export const restoreExperimentRunMetadata=softDeleteExperimentMetadata;`,
  milestoneService: `export const milestoneService=new Proxy({}, {get:()=>()=>{throw Error('legacy lookup forbidden')}});`,
  taskService: `export const taskService=new Proxy({}, {get:()=>()=>{throw Error('legacy lookup forbidden')}});`,
  manuscriptBindingService: `export const manuscriptBindingService={resolveIdentity:async()=>({})};`,
  fileRefService: `export const fileRefService={getFileRefsByOwner:async()=>[]}; export const getFileRefPathName=x=>x; export const summarizeFileRefPath=x=>x; export const getSafeManuscriptBasename=x=>x;`,
  resultMetricService: `export const resultMetricService={getMetricsByRun:async()=>[]};`,
  outputService: `export const outputService={listOutputs:async()=>[],getById:async()=>undefined};`
};
const bundle = await build({
  stdin: {contents: `
    export {experimentService} from './experimentService.ts';
    export {experimentRunService} from './experimentRunService.ts';
    export {getExperimentDetailContext,getExperimentRunContext,queryExperiments} from './experimentSelectorService.ts';
    export {resolveExperimentResearchObjectDescriptor,buildExperimentResearchObjectContextCandidates} from './experimentAIResearchObjectAdapter.ts';
    export {resolveExperimentRunResearchObjectDescriptor,buildExperimentRunResearchObjectContextCandidates} from './experimentRunAIResearchObjectAdapter.ts';
    export {buildExperimentRunMarkdown} from './experimentExportService.ts';
    export {d4Summary} from './literatureSelectorService.ts';
  `,resolveDir:directory,sourcefile:'d4-canonical-harness.ts'},
  bundle:true,write:false,platform:'node',format:'esm',target:'es2022',logLevel:'error',logLimit:0,
  plugins:[{name:'isolated-repository-and-side-effects',setup(api){
    api.onResolve({filter:/.*/},args=>{
      const name=args.path.split('/').at(-1).replace(/\.ts$/,'');
      return stubs[name]?{path:name,namespace:'d4-stub'}:undefined;
    });
    api.onLoad({filter:/.*/,namespace:'d4-stub'},args=>({contents:stubs[args.path]}));
    api.onLoad({filter:/literatureSelectorService\.ts$/},args=>({contents:readFileSync(args.path,'utf8')+'\nexport {resolveTargetSummaryFromServices as d4Summary};',loader:'ts',resolveDir:directory}));
  }}]
});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function fixture(){
  globalThis.__d4={sequence:0,writes:0,lookups:0,tables:{},unavailable:false,
    projects:[{id:'p',title:'Project',status:'active'},{id:'other',title:'Other',status:'active'}],
    routeNodes:[{id:'r',projectId:'p',title:'Current route',status:'active'},{id:'r2',projectId:'p',title:'Second route',status:'active'},{id:'rx',projectId:'other',title:'Other route'}],
    tasks:[{id:'t',projectId:'p',routeNodeId:'r',title:'Current task',status:'todo'},{id:'free',projectId:'p',routeNodeId:null,title:'Route-less task',status:'todo'},{id:'tx',projectId:'other',routeNodeId:'rx',title:'Other task'}]};
  return globalThis.__d4;
}
const create=(relation={})=>api.experimentService.createExperiment({projectId:'p',title:'D4 fixture',...relation});
const update=(id,patch)=>api.experimentService.updateExperiment(id,patch);
const run=(id,relation={})=>api.experimentRunService.createExperimentRun({experimentId:id,title:'D4 Run',...relation});
const ids=x=>[x.routeId??null,x.taskId??null];

for(const [label,relation] of Object.entries({empty:{},routeOnly:{routeId:'r'},taskOnly:{taskId:'t'},pair:{routeId:'r',taskId:'t'},routeLessTask:{routeId:'r',taskId:'free'}})){
  test('canonical Experiment create and Run explicit relation: '+label,async()=>{
    fixture();const exp=await create(relation);assert.deepEqual(ids(exp),ids(relation));
    const child=await run(exp.id,relation);assert.deepEqual(ids(child),ids(relation));
  });
}
for(const [label,relation] of Object.entries({conflict:{routeId:'r2',taskId:'t'},crossRoute:{routeId:'rx'},crossTask:{taskId:'tx'},wrongRouteType:{routeId:'t'},wrongTaskType:{taskId:'r'},missing:{taskId:'missing'}})){
  test('reject before any Experiment/Run write: '+label,async()=>{
    const f=fixture();const exp=await create();const child=await run(exp.id);const count=f.writes;
    await assert.rejects(create(relation));await assert.rejects(update(exp.id,relation));
    await assert.rejects(run(exp.id,relation));await assert.rejects(api.experimentRunService.updateExperimentRun(child.id,relation));
    assert.equal(f.writes,count);
  });
}
test('metadata full payload, both single clears, double clear and reset preserve exact intent',async()=>{
  const f=fixture();const exp=await create({routeId:'r',taskId:'t'});const child=await run(exp.id);
  for(const [service,id] of [[update,exp.id],[api.experimentRunService.updateExperimentRun,child.id]]){
    assert.deepEqual(ids(await service(id,{routeId:'r',taskId:'t',title:'Metadata'})),['r','t']);
    f.unavailable=true;
    assert.deepEqual(ids(await service(id,{title:'Unavailable metadata',routeId:'r',taskId:'t'})),['r','t']);
    assert.deepEqual(ids(await service(id,{routeId:null})),[null,'t']);
    assert.deepEqual(ids(await service(id,{taskId:null})),[null,null]);
    f.unavailable=false;
    await service(id,{routeId:'r',taskId:'t'});
    assert.deepEqual(ids(await service(id,{taskId:null})),['r',null]);
    assert.deepEqual(ids(await service(id,{routeId:null,taskId:null})),[null,null]);
    assert.deepEqual(ids(await service(id,{routeId:'r',taskId:'free'})),['r','free']);
  }
});
test('deleted/archived stored IDs retained, new setting with unresolved counterpart rejected',async()=>{
  const f=fixture();const exp=await create({routeId:'r',taskId:'t'});const child=await run(exp.id);
  f.routeNodes[0].archivedAt='archived';f.tasks[0].deletedAt='deleted';
  for(const [service,id] of [[update,exp.id],[api.experimentRunService.updateExperimentRun,child.id]]){
    assert.deepEqual(ids(await service(id,{title:'Still editable',routeId:'r',taskId:'t'})),['r','t']);
    const before=f.writes;await assert.rejects(service(id,{routeId:'r2'}));assert.equal(f.writes,before);
    assert.deepEqual(ids(await service(id,{routeId:null})),[null,'t']);
  }
  await assert.rejects(create({routeId:'r'}));await assert.rejects(create({taskId:'t'}));
});
test('Run inheritance is validated; explicit null overrides; independent updates and immutable parents',async()=>{
  const f=fixture();const exp=await create({routeId:'r',taskId:'t'});
  const inherited=await run(exp.id);assert.deepEqual(ids(inherited),['r','t']);
  assert.deepEqual(ids(await run(exp.id,{routeId:null,taskId:null})),[null,null]);
  assert.deepEqual(ids(await run(exp.id,{routeId:null})),[null,'t']);
  await update(exp.id,{routeId:'r2',taskId:'free'});
  assert.deepEqual(ids(await api.experimentRunService.getRunById(inherited.id)),['r','t']);
  f.tasks.find(x=>x.id==='free').deletedAt='deleted';const before=f.writes;
  await assert.rejects(run(exp.id));assert.equal(f.writes,before);
  await assert.rejects(update(exp.id,{projectId:'other'}),/project cannot/);
  await assert.rejects(api.experimentRunService.updateExperimentRun(inherited.id,{experimentId:exp.id}),/parent/);
  await assert.rejects(api.experimentRunService.updateExperimentRun(inherited.id,{projectId:'p'}),/project/i);
});
test('task-only readback/filter and current C05/C06/C07 projections do not derive a Route',async()=>{
  fixture();const exp=await create({routeId:'r',taskId:'t'});const child=await run(exp.id);
  const ed=await api.resolveExperimentResearchObjectDescriptor(exp.id,'p');
  const ec=await api.buildExperimentResearchObjectContextCandidates(ed,'STANDARD',0);
  assert.ok(JSON.stringify(ec.related).includes('Current route'));assert.ok(JSON.stringify(ec.related).includes('routeNode'));
  const rd=await api.resolveExperimentRunResearchObjectDescriptor(child.id,'p');
  const rc=await api.buildExperimentRunResearchObjectContextCandidates(rd,'STANDARD',0);assert.ok(JSON.stringify(rc).includes('Current task'));
  assert.match(await api.buildExperimentRunMarkdown(child.id),/所属路线: Current route/);
  await update(exp.id,{routeId:null});await api.experimentRunService.updateExperimentRun(child.id,{routeId:null});
  assert.equal((await api.getExperimentDetailContext(exp.id)).route,null);
  assert.equal((await api.getExperimentRunContext(child.id)).route,null);
  assert.deepEqual(await api.queryExperiments({routeId:'r'}),[]);
  assert.equal((await api.queryExperiments({taskId:'t'})).length,1);
  assert.match(await api.buildExperimentRunMarkdown(child.id),/所属路线: 未填写/);
  await api.resolveExperimentRunResearchObjectDescriptor(child.id,'p');
  await api.experimentRunService.updateExperimentRun(child.id,{routeId:'r2',taskId:'free'});
  await api.resolveExperimentRunResearchObjectDescriptor(child.id,'p');
});
test('C10 current route/task summary never queries a colliding or failing legacy owner',async()=>{
  fixture();assert.equal((await api.d4Summary('route','r')).title,'Current route');
  const task=await api.d4Summary('task','t');assert.equal(task.title,'Current task');assert.equal(task.routeId,'r');
});
test('actual page reference refresh cannot clear original or edited IDs when options disappear',async()=>{
  const source=readFileSync(resolve(directory,'../pages/Experiments/ExperimentsPage.tsx'),'utf8');
  const fn=source.slice(source.indexOf('  function applyReferenceData('),source.indexOf('  async function loadExperiments('));
  const {code}=await transform(fn,{loader:'ts',target:'es2022'});
  const form={routeId:'retained-route',taskId:'edited-task'};const before=structuredClone(form);
  const refresh=Function('setProjects','setRoutes','setTasks','setExperimentForm',code+';return applyReferenceData')(()=>{},()=>{},()=>{},change=>Object.assign(form,change(form)));
  refresh({projects:[],routes:[],tasks:[]});assert.deepEqual(form,before);
});
test('actual selection event autofills Route once; explicit Route clear keeps Task',()=>{
  const f=fixture();const source=readFileSync(resolve(directory,'../pages/Experiments/ExperimentsPage.tsx'),'utf8');
  function eventBody(marker){const start=source.indexOf(marker);const end=source.indexOf('\n                          })',start);return source.slice(start,end)}
  const selectTask=Function('current','event','tasks','routes','routeBelongsToProject',eventBody('                            const taskId = event.target.value;'));
  let form=selectTask({projectId:'p',routeId:'',taskId:''},{target:{value:'t'}},f.tasks,f.routeNodes,(route,project)=>route?.projectId===project);
  assert.deepEqual([form.routeId,form.taskId],['r','t']);
  const clearRoute=Function('current','event',eventBody('                            const routeId = event.target.value;'));
  form=clearRoute(form,{target:{value:''}});assert.deepEqual([form.routeId,form.taskId],['','t']);
});
test('Task single-clear preserves an unavailable Route on both canonical owners',async()=>{
  const f=fixture();const exp=await create({routeId:'r',taskId:'t'});const child=await run(exp.id);
  f.unavailable=true;
  assert.deepEqual(ids(await update(exp.id,{taskId:null})),['r',null]);
  assert.deepEqual(ids(await api.experimentRunService.updateExperimentRun(child.id,{taskId:null})),['r',null]);
});
test('actual detail refresh preserves the form while editing the same owner or creating',()=>{
  const source=readFileSync(resolve(directory,'../pages/Experiments/ExperimentsPage.tsx'),'utf8');
  const code=source.match(/setExperimentForm\(\(current\) =>\s+experimentPanelMode[\s\S]*?\n\s+\);/)[0];
  const apply=Function('setExperimentForm','experimentPanelMode','editingExperimentId','context','experimentToForm','researchTraceDisplayChecked',code);
  for(const mode of ['edit','create']){
    let form={routeId:'edited',taskId:'kept',title:'Unsaved'};const original=structuredClone(form);
    apply(change=>{form=change(form)},mode,'e',{experiment:{id:'e'}},()=>({routeId:'',taskId:''}),false);
    assert.deepEqual(form,original);
  }
});
