import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Actual mounted panel, projection, key-result formatter and setup whitelist.
// Canonical read I/O is controlled here; native durable/zero-write evidence is separate.
const bundle = await build({
  stdin: { contents: `export { ExperimentRunComparisonPanel, ComparisonValue } from './src/pages/Experiments/ExperimentRunComparisonPanel.tsx';
    export * from './src/services/experimentRunComparisonService.ts';
    export * from './src/pages/Experiments/ExperimentRunComparisonPresentation.ts';
    export * from './src/services/experimentSetupReuseService.ts';`, resolveDir: resolve('.'), sourcefile: 'b6-mounted.tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react','react/jsx-runtime'],
  plugins: [{name:'bounded-read-ports',setup(api){
    // Portal/focus geometry is exercised separately in native WebView.
    api.onResolve({filter:/^@radix-ui\/react-dialog$/},()=>({path:'dialog',namespace:'dialog'}));
    api.onLoad({filter:/.*/,namespace:'dialog'},()=>({loader:'js',contents:`import React from 'react';
      const C=React.createContext(null);export const Root=({open,onOpenChange,children})=>React.createElement(C.Provider,{value:{open,onOpenChange}},children);
      export const Portal=({children})=>React.useContext(C).open?children:null;
      export const Overlay=()=>null;export const Content=({children,...props})=>React.createElement('section',{...props,role:'dialog'},children);
      export const Title=({children})=>React.createElement('h2',null,children);export const Description=({children})=>React.createElement('p',null,children);
      export const Close=({children})=>{const c=React.useContext(C);return React.cloneElement(children,{onClick:()=>c.onOpenChange(false)});};`}));
    api.onResolve({filter:/experimentSelectorService$/},()=>({path:'selector',namespace:'ports'}));
    api.onResolve({filter:/experimentOutputGenerationService$/},()=>({path:'promotion',namespace:'ports'}));
    api.onResolve({filter:/fileRefService$/},()=>({path:'files',namespace:'ports'}));
    api.onResolve({filter:/repositories\/repositoryFactory$/},()=>({path:'repo',namespace:'ports'}));
    api.onResolve({filter:/experimentRunGuardService$/},()=>({path:'guard',namespace:'ports'}));
    api.onLoad({filter:/.*/,namespace:'ports'},({path})=>({loader:'js',contents:
      path==='selector' ? `export const getExperimentRunContext = id => globalThis.__b6.read(id);` :
      path==='promotion' ? `export const experimentOutputGenerationService={getGeneratedResultItemsByMetricIds:async ids=>Object.fromEntries(ids.filter(id=>id==='promoted').map(id=>[id,{id:'result-item'}]))};` :
      path==='files' ? `export const getFileRefPathName=path=>path.split(/[\\\\/]/).at(-1);` :
      path==='guard' ? `export const assertExperimentRunWritable=()=>{throw Error('mutation forbidden')};` :
      `export const createRepository=()=>new Proxy({}, {get:()=>()=>{throw Error('mutation forbidden')}});`
    }));
  }}]
});
const module={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const s=module.exports;
const context=(id,patch={})=>({
  run:{id,experimentId:'exp',title:id,status:'planned',tags:[],conditionItems:[],variables:[],materials:[],methodSteps:[],customFields:[],...patch},
  experiment:{id:'exp',title:'Parent'},project:{title:'Project'},route:null,task:null,metrics:[],fileRefs:[],parentExperimentFileRefs:[]
});
const flatten=node=>typeof node==='string'?node:Array.isArray(node)?node.map(flatten).join(' '):flatten(node?.children??[]);
const text=renderer=>flatten(renderer.toJSON());
function ports(contexts){globalThis.__b6={reads:[],async read(id){this.reads.push(id);const value=contexts[id];if(value instanceof Error)throw value;return typeof value==='function'?value():structuredClone(value??null);}};return globalThis.__b6;}
const checkbox=(r,id)=>r.root.findByProps({'data-comparison-run':id});
async function choose(r,id,checked=true){await act(async()=>checkbox(r,id).props.onChange({target:{checked}}));}
async function click(r,label){await act(async()=>r.root.findAllByType('button').find(b=>flatten(b.props.children).startsWith(label)).props.onClick());}
async function mount(runs){let r;await act(async()=>{r=TestRenderer.create(React.createElement(s.ExperimentRunComparisonPanel,{experimentId:'exp',runs,language:'en-US'}));});await click(r,'Read-only compare');return r;}

test('both setup whitelists exclude identity/results/mixed metadata and preserve editable values',()=>{
  const source={id:'old',title:'old',status:'completed',createdAt:'old',experimentId:'old-parent',resultSummary:'actual result',conclusion:'actual conclusion',customFields:[{name:'mixed',value:99}],fileRefs:['old-file'],purposeAndQuestion:'Question Ω',conditionSummary:'Condition Ω',variableParameterSummary:'Parameter Ω',methodSummary:'Method Ω'};
  const before=JSON.stringify(source);
  assert.deepEqual(s.experimentSetupDraft(source),{purposeAndQuestion:'Question Ω',conditionSummary:'Condition Ω',methodSummary:'Method Ω'});
  assert.deepEqual(s.experimentRunSetupDraft(source),{conditionSummary:'Condition Ω',variableParameterSummary:'Parameter Ω',methodSummary:'Method Ω'});
  assert.equal(JSON.stringify(source),before);
  assert.deepEqual(s.experimentRunSetupDraft({}),{conditionSummary:'',variableParameterSummary:'',methodSummary:''});
});

test('exact heterogeneous keys, duplicate observations, units, zero/false/empty and promotion remain facts',()=>{
  const a=context('a',{conditionItems:[{id:'c1',name:'pressure',value:0,unit:'kPa'},{id:'c2',name:'pressure',value:false,unit:'bar'}],customFields:[{id:'x',name:'flag',group:'setup',value:false,valueType:'boolean'},{id:'y',name:'long',value:'Ω'.repeat(300)},{id:'z',name:'blank',value:''}],resultSummary:'existing summary'});
  a.metrics=[{id:'promoted',name:'yield',value:0,valueType:'number',unit:'mg',baselineValue:0,targetValue:2,customFields:[{name:'isKeyResult',value:true}]}];
  a.fileRefs=[{path:'C:\\fixture\\file Ω.md',title:'Recorded file',fileType:'other',fileRole:'manuscript'}];
  const before=JSON.stringify(a);const col=s.projectRunComparison(a,new Set(['promoted']));
  assert.match(col.facts['["Condition","pressure",""]'].text,/"value":0.*"unit":"kPa".*\n.*"value":false.*"unit":"bar"/);
  assert.match(col.facts['["Custom","flag","setup"]'].text,/"value":false/);
  assert.equal(col.facts.Route.kind,'not_applicable');assert.equal(col.facts.Started.kind,'missing');
  assert.match(col.facts['["Metric","yield",""]'].text,/"promotedToResultItem":true/);
  assert.match(col.facts['["Metric","yield",""]'].text,/"keyResult":true/);
  assert.match(col.facts['File metadata'].text,/file Ω.md/);assert.equal(col.facts['File count'].text,'1');
  const rows=s.runComparisonRows([col,s.projectRunComparison(context('b'),new Set())]);
  assert.equal(rows.find(r=>r.label==='Custom: flag (setup)').cells[1].kind,'missing');
  assert.equal(rows.find(r=>r.label==='Recorded result summary').differs,true);assert.equal(JSON.stringify(a),before);
});

test('canonical read failure/unavailable/cross-parent are separate from missing facts; selection guards',async()=>{
  const cross=context('cross');cross.run.experimentId='other';ports({a:context('a'),bad:new Error('native error'),cross});
  const cols=await s.readRunComparison('exp',['a','bad','gone','cross']);
  assert.deepEqual(cols.map(c=>c.error),[undefined,'read_failed','unavailable','unavailable']);
  for(const ids of [[],['a'],['a','a'],['1','2','3','4','5','6']])await assert.rejects(s.readRunComparison('exp',ids));
});

test('mounted selection max five, compare, expand, refresh, reorder, close and invalidation only read',async()=>{
  const contexts=Object.fromEntries(['a','b','c','d','e','f'].map(id=>[id,context(id)]));contexts.a.run.customFields=[{id:'long',name:'long',value:'Ω'.repeat(300)}];
  const p=ports(contexts);const runs=Object.values(contexts).map(c=>c.run);const before=JSON.stringify(contexts);const r=await mount(runs);
  assert.equal(r.root.findByProps({'data-testid':'compare-runs'}).props.disabled,true);
  for(const id of ['a','b','c','d','e'])await choose(r,id);
  assert.equal(checkbox(r,'f').props.disabled,true);
  await choose(r,'f');assert.equal(checkbox(r,'f').props.checked,false);
  await click(r,'Compare');assert.equal(r.root.findAllByType('table').length,1);assert.equal(r.root.findAllByType('details').length,0);
  assert.match(text(r),/Not recorded/);assert.doesNotMatch(text(r),/File metadata|Status planned|Tags \[\]/);
  const reads=p.reads.length;await click(r,'Refresh facts');assert.ok(p.reads.length>reads);
  await click(r,'Reverse order');assert.equal(r.root.findAllByType('thead')[0].findAllByType('th')[1].props.children[0],'e');
  assert.equal(r.root.findByType('table').parent.props.className,'run-comparison__scroll');
  assert.equal(r.root.findByProps({role:'dialog'}).findAllByType('table').length,1);
  await click(r,'Close');assert.equal(r.root.findAllByType('table').length,0);
  assert.equal(r.root.findAllByType('input').length,0);await click(r,'Read-only compare');assert.equal(checkbox(r,'a').props.checked,true);
  await act(async()=>r.update(React.createElement(s.ExperimentRunComparisonPanel,{experimentId:'other',runs:[],language:'en-US'})));
  assert.equal(r.root.findAllByType('input').length,0);assert.equal(r.root.findAllByProps({'data-testid':'compare-runs'}).length,0);
  assert.equal(JSON.stringify(contexts),before);await act(async()=>r.unmount());
});

test('secondary comparison returns with two valid selections and removes deleted identities without rebinding',async()=>{
  ports({a:context('a'),b:context('b'),c:context('c')});
  const runs=['a','b','c'].map(id=>context(id).run);const r=await mount(runs);
  await choose(r,'a');await choose(r,'b');await click(r,'Compare');
  assert.equal(r.root.findByType('thead').findAllByType('th').length,3);
  await click(r,'Close');await click(r,'Read-only compare');assert.equal(checkbox(r,'a').props.checked,true);await click(r,'Compare');
  await act(async()=>r.update(React.createElement(s.ExperimentRunComparisonPanel,{experimentId:'exp',runs:runs.filter(run=>run.id!=='a'),language:'en-US'})));
  assert.equal(r.root.findAllByType('table').length,0);assert.match(text(r),/Fewer than two valid/);
  await click(r,'Close');await click(r,'Read-only compare');assert.equal(checkbox(r,'b').props.checked,true);assert.equal(checkbox(r,'c').props.checked,false);
  await act(async()=>r.unmount());
});

test('mounted read errors and late replies never become successful empty facts or overwrite new selection',async()=>{
  let release;const deferred=new Promise(resolve=>{release=resolve;});
  ports({a:()=>deferred,b:new Error('read failure')});const r=await mount([context('a').run,context('b').run]);
  await choose(r,'a');await choose(r,'b');await act(async()=>r.root.findByProps({'data-testid':'compare-runs'}).props.onClick());
  assert.match(text(r),/Reading facts/);
  await act(async()=>r.update(React.createElement(s.ExperimentRunComparisonPanel,{experimentId:'other',runs:[],language:'en-US'})));
  await act(async()=>release(context('a')));assert.equal(r.root.findAllByType('table').length,0);
  await act(async()=>r.unmount());
  ports({a:context('a'),b:new Error('read failure')});const e=await mount([context('a').run,context('b').run]);await choose(e,'a');await choose(e,'b');await click(e,'Compare');
  assert.match(text(e),/Read failed/);assert.match(text(e),/not been replaced by empty values/);await act(async()=>e.unmount());
});

test('failed or unavailable comparison columns retain the selected visible name without exposing internal IDs',async()=>{
  const failedId='run-internal-uuid-failed',missingId='run-internal-uuid-missing';
  const runs=[context('ok',{title:'Visible good run'}).run,context(failedId,{title:'Visible failed run'}).run,context(missingId,{title:'Visible missing run'}).run];
  ports({ok:context('ok',{title:'Visible good run'}),[failedId]:new Error('controlled canonical read failure'),[missingId]:null});
  const r=await mount(runs);
  for(const run of runs)await choose(r,run.id);
  await click(r,'Compare');
  assert.match(text(r),/Visible failed run/);assert.match(text(r),/Visible missing run/);
  const header=flatten(r.root.findByType('thead').findAllByType('th').map(th=>th.props.children));
  assert.doesNotMatch(header,/run-internal-uuid/);
  await act(async()=>r.unmount());
});


test('entry is the only closed UI, modal selection does not read until Compare, cancel is read-only',async()=>{
 const p=ports({a:context('a'),b:context('b')});let r;
 await act(async()=>{r=TestRenderer.create(React.createElement(s.ExperimentRunComparisonPanel,{experimentId:'exp',runs:[context('a').run,context('b').run],language:'en-US'}));});
 assert.equal(r.root.findAllByType('button').length,1);assert.equal(r.root.findAllByType('input').length,0);assert.equal(p.reads.length,0);
 await click(r,'Read-only compare');await choose(r,'a');await choose(r,'b');assert.equal(p.reads.length,0);
 await click(r,'Close');assert.equal(p.reads.length,0);assert.equal(r.root.findAllByType('input').length,0);
 await click(r,'Read-only compare');assert.equal(checkbox(r,'a').props.checked,true);await click(r,'Compare');assert.deepEqual(p.reads,['a','b']);
 assert.ok(r.root.findAllByType('button').every(b=>b.props.className?.includes('primary-page-action')));
 await click(r,'Change Runs');assert.equal(r.root.findAllByType('table').length,0);assert.equal(checkbox(r,'b').props.checked,true);await act(async()=>r.unmount());
});
test('research presentation preserves duplicate values/types/units/results but hides DTO metadata and formats JSON',()=>{
 const a=context('a',{conditionSummary:'Known condition',variableParameterSummary:'Known variable',methodSummary:'Known method',resultSummary:'Actual result',conclusion:'Recorded conclusion',conditionItems:[{id:'secret-c',name:'Pressure',value:0,unit:'kPa'},{id:'secret-d',name:'Pressure',value:false,unit:'bar'}],variables:[{id:'v',name:'Cooling',value:false,role:'control_variable'}],materials:[{id:'m',name:'Powder',amount:0,unit:'mg'}],methodSteps:[{id:'s',title:'Heat',order:0,parameters:{temperature:0,enabled:false,resourceKey:'secret-key'}}],customFields:[{id:'c',name:'Extra',value:{observations:[0,false],resourceKey:'hidden-key'},valueType:'json'}]});
 a.metrics=[{id:'promoted',name:'Yield',value:0,valueType:'number',unit:'mg',baselineValue:0,targetValue:2},{id:'json',name:'Measurements',value:'{"x":0,"flag":false}',valueType:'json'}];
 a.fileRefs=[{path:'C:\\secret\\file.md',title:'Private',resourceKey:'hidden'}];
 const before=JSON.stringify(a);const columns=[s.projectRunComparison(a,new Set(['promoted'])),s.projectRunComparison(context('b'),new Set())];
 for(const language of ['en-US','zh-CN']){
  const rows=s.presentRunComparison(columns,language);const shown=rows.map(r=>r.label+' '+r.cells.map(c=>c.text).join(' ')).join(' ');
  assert.match(shown,/0 kPa/);assert.match(shown,/bar/);assert.match(shown,/0 mg/);assert.match(shown,/Actual result/);assert.match(shown,/Recorded conclusion/);
  assert.match(shown,/x: 0/);assert.match(shown,/observations: 0/);assert.doesNotMatch(shown,/secret-key|hidden-key|File metadata|Run label|Status|Tags|Created|Updated|"value"|\{"x"/);
  assert.ok(rows.find(r=>r.key==='["Condition","Pressure",""]' ).differs);assert.equal(rows.find(r=>r.key==='["Condition","Pressure",""]' ).cells[1].kind,'missing');
  assert.match(shown,language==='en-US'?/No/:/否/);
 }
 assert.equal(JSON.stringify(a),before);
});

test('clipped values expand/collapse with keyboard-accessible button; short values have no control',async()=>{
 let r;const long='A long scientific result '.repeat(30);
 await act(async()=>{r=TestRenderer.create(React.createElement(s.ComparisonValue,{text:long,zh:false}),{createNodeMock:node=>node.props.className?.startsWith('run-comparison__value')?{scrollHeight:300,clientHeight:54}:null});});
 assert.equal(r.root.findByType('button').props['aria-expanded'],false);assert.match(text(r),/Expand/);
 await click(r,'Expand');assert.equal(r.root.findByType('button').props['aria-expanded'],true);assert.match(r.root.findAllByType('div')[1].props.className,/is-expanded/);assert.match(text(r),/Collapse/);
 await click(r,'Collapse');assert.equal(r.root.findByType('button').props['aria-expanded'],false);
 await act(async()=>r.unmount());
 await act(async()=>{r=TestRenderer.create(React.createElement(s.ComparisonValue,{text:'0 mg',zh:true}),{createNodeMock:node=>node.props.className?.startsWith('run-comparison__value')?{scrollHeight:18,clientHeight:18}:null});});
 assert.equal(r.root.findAllByType('button').length,0);assert.match(text(r),/0 mg/);await act(async()=>r.unmount());
});
test('close is in header; flat rows retain category identity without separate group headings',async()=>{
 ports({a:context('a',{conditionItems:[{name:'Pressure',value:0,unit:'kPa'}]}),b:context('b')});const r=await mount([context('a').run,context('b').run]);
 const close=r.root.findAllByType('button').find(b=>flatten(b.props.children)==='Close');assert.equal(close.props['aria-label'],'Close');assert.ok(r.root.findByProps({className:'run-comparison__header'}).findAllByType('button').includes(close));
 await choose(r,'a');await choose(r,'b');await click(r,'Compare');assert.equal(r.root.findAllByProps({className:'run-comparison__group'}).length,0);assert.match(text(r),/Conditions · Pressure/);assert.doesNotMatch(text(r),/Back to Runs/);await act(async()=>r.unmount());
});
