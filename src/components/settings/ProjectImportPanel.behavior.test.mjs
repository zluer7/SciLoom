import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
const bundle=await build({entryPoints:[resolve('src/components/settings/ProjectImportPanel.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'import-ports',setup(api){
 api.onResolve({filter:/(I18nProvider|ModalPortal|dataSourceMode|projectImportV1Service)$/},args=>({path:args.path.split('/').at(-1),namespace:'port'}));
 api.onLoad({filter:/.*/,namespace:'port'},args=>({loader:'js',contents:{I18nProvider:'export const useI18n=()=>({language:globalThis.__import.language});',ModalPortal:'export const ModalPortal=({children})=>children;',dataSourceMode:'export const getDataSourceModeSnapshot=()=>({selectedMode:"auto",effectiveMode:"sqlite"});',projectImportV1Service:'export const executeProjectImportV1=(...a)=>globalThis.__import.execute(...a);'}[args.path]}));
}}]});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);const Panel=module.exports.ProjectImportPanel;
const document={schema:'sciloom.project-import',version:1,project:{ref:'p',title:'Visible Project'},objects:{tasks:[{ref:'t',title:'Task',taskType:'analysis'}]}};
const json=JSON.stringify(document);const content=r=>JSON.stringify(r.toJSON());const find=(r,id)=>r.root.findByProps({'data-testid':id});
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
async function mount(execute=async()=>({status:'success',project:{id:'new-id',title:'Visible Project'},created:[{},{}],createdRelationCount:0,warnings:[],skippedCounts:{fields:0,objects:0,relations:0}})){
 globalThis.window={addEventListener(){},removeEventListener(){}};globalThis.__import={language:'en',execute};let r;await act(async()=>{r=TestRenderer.create(React.createElement(Panel));});return r;
}
async function choose(r,name,text=json){const target={value:name,files:[{name,size:100,text:typeof text==='function'?text:async()=>text}]};await act(async()=>find(r,'project-import-file').props.onChange({target}));assert.equal(target.value,'');}
async function dispose(r){await act(async()=>r.unmount());delete globalThis.window;}

test('JSON auto-detection uses real canonical preflight; modal cancellation and same-file reselect remain readonly until confirmation',async()=>{
 let calls=0;const r=await mount(async(plan,options)=>{calls++;assert.equal(plan.ok,true);assert.equal(options.confirmed,true);return {status:'success',created:[{},{}],createdRelationCount:0,warnings:[]};});
 assert.equal(r.root.findAllByType('select').length,0);assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);
 await choose(r,'project.JSON');assert.match(content(r),/JSON/);assert.match(content(r),/Visible Project/);assert.ok(find(r,'project-import-preview'));assert.equal(calls,0);
 await act(async()=>find(r,'project-import-cancel').props.onClick());assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);assert.equal(calls,0);
 await choose(r,'project.JSON');await act(async()=>{find(r,'project-import-confirm').props.onClick();find(r,'project-import-confirm').props.onClick();});assert.equal(calls,1);assert.ok(find(r,'project-import-outcome'));assert.equal(r.root.findAllByProps({'data-testid':'project-import-confirm'}).length,0);await dispose(r);
});

test('actual existing demo Markdown is recognized but never passed to JSON or a fabricated business writer',async()=>{
 let writes=0;const r=await mount(()=>{writes++;});const demo=readFileSync(resolve('demo/west-lake-vinegar-fish/README.md'),'utf8');
 await choose(r,'README.md',demo);assert.match(content(r),/Markdown recognized/);assert.equal(r.root.findAllByProps({'data-testid':'project-import-preview'}).length,0);assert.equal(r.root.findAllByProps({'data-testid':'project-import-confirm'}).length,0);assert.equal(writes,0);await dispose(r);
});

test('extension alone cannot authorize JSON writes; unknown carrier, malformed JSON and incorrect signature are blocked',async()=>{
 for(const [name,text] of [['unknown.txt',json],['wrong.json','# Markdown'],['wrong.json','{}']]){
  let writes=0;const r=await mount(()=>{writes++;});await choose(r,name,text);assert.equal(r.root.findAllByProps({'data-testid':'project-import-confirm'}).length,0);assert.equal(writes,0);await dispose(r);
 }
});

test('closing an asynchronous read invalidates its late preview, and unexpected commit failure blocks replay',async()=>{
 const wait=deferred();let calls=0;const r=await mount(async()=>{calls++;throw Error('synthetic-secret');});
 await choose(r,'old.json',()=>wait.promise);await act(async()=>find(r,'project-import-cancel').props.onClick());await choose(r,'new.json');await act(async()=>wait.resolve('{invalid'));
 assert.ok(find(r,'project-import-preview'));assert.doesNotMatch(content(r),/old.json/);
 await act(async()=>find(r,'project-import-confirm').props.onClick());assert.equal(calls,1);assert.match(content(r),/outcome needs review/);assert.doesNotMatch(content(r),/synthetic-secret/);assert.equal(r.root.findAllByProps({'data-testid':'project-import-confirm'}).length,0);await dispose(r);
});
