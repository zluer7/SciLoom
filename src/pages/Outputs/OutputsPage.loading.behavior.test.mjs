import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
const ports={
 planningService:'export const planningService={queryProjects:async()=>[{id:"p",title:"P"},{id:"q",title:"Q"}]};',
 outputFiveLayerSelectorService:'export const outputFiveLayerSelectorService={listOutputEntities:async q=>globalThis.o.rows(q),getOutputEntityDetail:q=>globalThis.o.read(q)};',
 outputFileRefService:'export const outputFileRefService={listOutputFileRefs:async()=>[]};',
 outputSourceSelectorService:'export const getOutputSourceSummary=async()=>globalThis.o.unknownSources?null:({ownerId:"a",total:0,countsBySourceType:{},cards:[]});',
 outputGapFeedbackCardSelectorService:'export const outputGapFeedbackCardSelectorService={getOutputGapFeedbackCardSummary:async()=>({activeCards:[],archivedCards:[]})};',
 useOutputsManuscriptEditor:'export const useOutputsManuscriptEditor=()=>({state:{status:"closed",session:globalThis.o.owner?{owner:globalThis.o.owner,actualEditTarget:{fileRefId:"test-file"},document:{snapshot:{ownerType:globalThis.o.owner.ownerType,structuredSummary:[],briefDescription:""}}}:undefined},requestProjectSwitch:async(p,commit)=>{if(!globalThis.o.cancel)await commit();},requestSelectionChange:async(p,commit)=>{if(!globalThis.o.cancel)await commit();return{status:globalThis.o.cancel?"cancelled":"success"};}});',
 useWriteFeedbackCenter:'const center={entries:[],pushPageFeedback:()=>{},pushRefreshEventFeedback:()=>{},pushReloadErrorFeedback:()=>{}};export const useWriteFeedbackCenter=()=>center;',
 useRefreshEventReload:'export const useRefreshEventReload=q=>{globalThis.o.reload=q.reload;};',
 I18nProvider:'export const useI18n=()=>({language:"en-US",t:k=>k});',
 OutputQuickAnalysisButton:'export const OutputQuickAnalysisButton=()=>null;',
 OutputEvidenceExportPanel:'export const OutputEvidenceExportPanel=({children,sourceDetails})=>children(sourceDetails,null);',
 LazyManuscriptSegmentEditorWindow:'export const LazyManuscriptSegmentEditorWindow=()=>null;'
};
const b=await build({stdin:{contents:'export {OutputsPage} from "./OutputsPage";export {runtimePageSelection} from "../../services/runtimePageSelection";',resolveDir:import.meta.dirname},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],logLevel:'silent',plugins:[{name:'bounded-page-ports',setup(api){api.onResolve({filter:/./},a=>{const name=a.path.split('/').at(-1);if(ports[name]&&(a.importer.endsWith('OutputsPage.tsx')||name==='I18nProvider'))return{path:name,namespace:'port'};});api.onLoad({filter:/./,namespace:'port'},a=>({contents:ports[a.path]}));}}]});
const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);
const {OutputsPage,runtimePageSelection:memory}=m.exports;
const layers=['resultItem','finding','outputCandidate','outputGap','researchOutput'];
const row=(layer,id='a',projectId='p')=>({layer,id,projectId,title:`${projectId} ${layer} ${id}`,status:layer==='outputGap'?'open':'draft',updatedAt:'1',createdAt:'1',structuredSummaryPreview:''});
const detail=q=>({...q,entity:{...row(q.layer,q.id,q.projectId??'p')},structuredSummary:[],fileRefs:[],relationSummary:[],boundary:{warnings:[],missing:false}});
function setup(){globalThis.window={};for(const p of ['p','q'])for(const l of layers)memory.remember('outputs',p,null,l);globalThis.o={calls:[],rows:async q=>[row(q.layer,'a',q.projectId),row(q.layer,'b',q.projectId)],read:async q=>{o.calls.push(q);return detail(q);}};}
async function mount(){let n;await act(async()=>{n=Renderer.create(React.createElement(OutputsPage));});return n;}
const section=(n,l)=>n.root.findByProps({id:`outputs-layer-${l}`});
const cards=(n,l)=>section(n,l).findAll(x=>x.type==='button'&&String(x.props.className).includes('outputs-formal-list-card'));
const heading=(n,l)=>section(n,l).findAllByType('h3').map(x=>x.children.join()).join();
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}

test('all five scopes start empty, explicit selection loads fresh and return restores IDs only',async()=>{
 setup();let n=await mount();assert.equal(o.calls.length,0);
 for(const l of layers){assert.equal(heading(n,l),'');await act(async()=>cards(n,l)[0].props.onClick());assert.ok(heading(n,l).includes(l));}
 assert.equal(o.calls.length,5);await act(async()=>n.unmount());n=await mount();assert.equal(o.calls.length,10);for(const l of layers)assert.ok(heading(n,l).includes(l));await act(async()=>n.unmount());
});
test('late old success/failure, A to B to A and unmount cannot replace current detail',async()=>{
 setup();const old=deferred();let reads=0;o.read=q=>{o.calls.push(q);if(q.id==='a'&&++reads===1)return old.promise;return Promise.resolve(detail(q));};const n=await mount();
 await act(async()=>{cards(n,'finding')[0].props.onClick();});assert.ok(JSON.stringify(section(n,'finding').toJSON?.()??n.toJSON()).includes('Loading'));
 await act(async()=>cards(n,'finding')[1].props.onClick());await act(async()=>cards(n,'finding')[0].props.onClick());assert.ok(heading(n,'finding').includes('finding a'));
 await act(async()=>old.resolve({...detail({layer:'finding',id:'a'}),entity:{...row('finding'),title:'OBSOLETE'}}));assert.ok(!heading(n,'finding').includes('OBSOLETE'));
 const failure=deferred();o.read=()=>failure.promise;await act(async()=>{cards(n,'finding')[1].props.onClick();});await act(async()=>n.unmount());await act(async()=>failure.reject(Error('LATE_FAILURE')));
});
test('projects are independent, cancelled change keeps selection, excluded filter clears without fallback',async()=>{
 setup();const n=await mount();const project=()=>n.root.findAllByType('select').find(x=>x.props.value==='p'||x.props.value==='q');
 o.owner={ownerType:'finding',ownerId:'a'};await act(async()=>cards(n,'finding')[0].props.onClick());o.cancel=true;await act(async()=>cards(n,'finding')[1].props.onClick());assert.equal(memory.read('outputs','p','finding'),'a');assert.ok(heading(n,'finding').includes('p finding a'));await act(async()=>project().props.onChange({target:{value:'q'}}));assert.ok(heading(n,'finding').includes('p finding'));assert.equal(memory.read('outputs','p','finding'),'a');
 o.cancel=false;await act(async()=>project().props.onChange({target:{value:'q'}}));assert.equal(heading(n,'finding'),'');await act(async()=>cards(n,'finding')[1].props.onClick());
 await act(async()=>project().props.onChange({target:{value:'p'}}));assert.ok(heading(n,'finding').includes('p finding a'));
 await act(async()=>section(n,'finding').findByType('input').props.onChange({target:{value:'absent'}}));assert.equal(heading(n,'finding'),'');assert.equal(memory.read('outputs','p','finding'),null);await act(async()=>n.unmount());
});

test('unknown source summary and failed detail do not masquerade as confirmed empty; retry re-reads',async()=>{
 setup();o.unknownSources=true;const n=await mount();await act(async()=>cards(n,'finding')[0].props.onClick());assert.ok(JSON.stringify(n.toJSON()).includes('Source state unknown'));o.read=async()=>{throw Error('READ_FAILURE');};await act(async()=>cards(n,'finding')[1].props.onClick());assert.equal(heading(n,'finding'),'');assert.ok(JSON.stringify(n.toJSON()).includes('READ_FAILURE'));o.read=async q=>detail(q);await act(async()=>section(n,'finding').findAllByType('button').find(x=>x.children.includes('Retry')).props.onClick());assert.ok(heading(n,'finding').includes('finding b'));await act(async()=>n.unmount());
});

test('catalog refresh drops an unavailable selected ID without selecting the remaining first record',async()=>{
 setup();const n=await mount();await act(async()=>cards(n,'finding')[0].props.onClick());o.rows=async q=>[row(q.layer,'b',q.projectId)];await act(async()=>o.reload());assert.equal(memory.read('outputs','p','finding'),null);assert.equal(heading(n,'finding'),'');assert.equal(cards(n,'finding').length,1);await act(async()=>n.unmount());
});
test('late failed old owner does not replace a newer successful owner',async()=>{
 setup();const old=deferred();o.read=q=>q.id==='a'?old.promise:Promise.resolve(detail(q));const n=await mount();await act(async()=>{cards(n,'finding')[0].props.onClick();});await act(async()=>cards(n,'finding')[1].props.onClick());await act(async()=>old.reject(Error('STALE_ERROR')));assert.ok(heading(n,'finding').includes('finding b'));assert.ok(!JSON.stringify(n.toJSON()).includes('STALE_ERROR'));await act(async()=>n.unmount());
});
