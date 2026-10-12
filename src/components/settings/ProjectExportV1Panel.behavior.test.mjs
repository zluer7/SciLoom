import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
const bundle=await build({entryPoints:[resolve("src/components/settings/ProjectExportV1Panel.tsx")],bundle:true,write:false,platform:"node",format:"cjs",jsx:"automatic",external:["react","react/jsx-runtime"],plugins:[{name:"export-ports",setup(api){
 const names=/hooks\/useRefreshEventReload$|i18n\/I18nProvider$|services\/(planningService|projectExportV1Service|projectMarkdownExportService)$/;
 api.onResolve({filter:names},args=>({path:args.path.split('/').at(-1),namespace:'port'}));
 api.onLoad({filter:/.*/,namespace:'port'},args=>({loader:'js',contents:args.path==='useRefreshEventReload'?'import {useEffect} from "react"; export function useRefreshEventReload({reload}){useEffect(()=>{globalThis.__export.reload=reload;return ()=>{delete globalThis.__export.reload;};},[reload]);}':args.path==='I18nProvider'?'export const useI18n=()=>({language:globalThis.__export.language});':args.path==='planningService'?'export const planningService={queryProjects:()=>globalThis.__export.list()};':args.path==='projectExportV1Service'?'export const projectExportV1Service={prepare:(...a)=>globalThis.__export.prepare("json",...a),savePrepared:(...a)=>globalThis.__export.save("json",...a)};':'export const projectMarkdownExportService={prepare:(...a)=>globalThis.__export.prepare("markdown",...a),savePrepared:(...a)=>globalThis.__export.save("markdown",...a)};'}));
}}]});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);const Panel=module.exports.ProjectExportV1Panel;
const find=(r,id)=>r.root.findByProps({'data-testid':id});const content=r=>JSON.stringify(r.toJSON());
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
async function mount(overrides={}) {globalThis.__export={language:'en',list:async()=>[{id:'source',title:'Visible Project'}],prepare:async format=>Object.freeze({format,contents:'Frozen Ω'}),save:async()=>({saved:false}),...overrides};let r;await act(async()=>{r=TestRenderer.create(React.createElement(Panel));});return r;}

test('two ordinary actions prepare then save exact frozen content, with no format selector or preview',async()=>{
 for(const format of ['json','markdown']){
  const calls=[];const frozen=Object.freeze({format,contents:'Frozen Ω'});
  const r=await mount({prepare:async(...a)=>{calls.push(['prepare',...a]);return frozen;},save:async(...a)=>{calls.push(['save',...a]);return {saved:true,filePath:'isolated.'+(format==='json'?'json':'md')};}});
  assert.equal(r.root.findAllByType('select').length,1);assert.doesNotMatch(content(r),/project-export-format|Preflight and preview|project-export-v1-preview/);
  await act(async()=>find(r,'project-export-'+format).props.onClick());assert.equal(calls[0][1],format);assert.equal(calls[0][2],'source');assert.deepEqual(calls[1],['save',format,frozen]);assert.match(content(r),/Saved/);await act(async()=>r.unmount());
 }
});

test('list/preparation/save failures and native cancellation never expose internal details or invent success',async()=>{
 for(const language of ['zh-CN','en'])for(const format of ['json','markdown'])for(const phase of ['list','prepare','save','cancel']){
  let saves=0;const r=await mount({language,list:async()=>{if(phase==='list')throw Error('synthetic-secret owner-id');return [{id:'source',title:'Visible Project'}];},prepare:async()=>{if(phase==='prepare')throw Error('synthetic-secret owner-id');return {};},save:async()=>{saves++;if(phase==='save')throw Error('synthetic-secret owner-id');return {saved:false};}});
  if(phase!=='list')await act(async()=>find(r,'project-export-'+format).props.onClick());
  assert.equal(saves,['save','cancel'].includes(phase)?1:0);assert.doesNotMatch(content(r),/synthetic-secret|owner-id/);if(phase!=="cancel")assert.equal(r.root.findAllByProps({"data-testid":"project-export-v1-message"}).length,0);assert.match(content(r),phase==='cancel'?/canceled|取消/:/could not be read|failed|失败/);await act(async()=>r.unmount());
 }
});

test('synchronous duplicate clicks are fenced; unmount during preparation cannot open Save As',async()=>{
 let saves=0;const wait=deferred();const r=await mount({prepare:()=>wait.promise,save:async()=>{saves++;return {saved:false};}});
 await act(async()=>{find(r,'project-export-json').props.onClick();find(r,'project-export-markdown').props.onClick();});assert.equal(find(r,'project-export-v1-project').props.disabled,true);
 await act(async()=>r.unmount());await act(async()=>wait.resolve({}));assert.equal(saves,0);
});


test('canonical project refresh adds newly imported Project without changing the selected export source; stale lists are ignored',async()=>{
 let items=[{id:'source',title:'Visible Project'}];const r=await mount({list:async()=>items});
 items=[...items,{id:'new-copy',title:'Visible Project'}];await act(async()=>globalThis.__export.reload());
 assert.equal(find(r,'project-export-v1-project').props.value,'source');assert.equal(r.root.findAllByType('option').length,2);
 const older=deferred();globalThis.__export.list=()=>older.promise;let first;await act(async()=>{first=globalThis.__export.reload();});
 globalThis.__export.list=async()=>[{id:'latest',title:'Latest'}];await act(async()=>globalThis.__export.reload());
 await act(async()=>{older.resolve(items);await first;});assert.equal(find(r,'project-export-v1-project').props.value,'latest');
 await act(async()=>r.unmount());
});


test('language refresh during preparation does not leave export busy or change the frozen request',async()=>{
 const waiting=deferred();const calls=[];const r=await mount({prepare:(...a)=>{calls.push(['prepare',...a]);return waiting.promise;},save:async(...a)=>{calls.push(['save',...a]);return {saved:false};}});
 await act(async()=>find(r,'project-export-markdown').props.onClick());
 globalThis.__export.language='zh-CN';await act(async()=>r.update(React.createElement(Panel)));
 const frozen={contents:'Captured original language'};await act(async()=>waiting.resolve(frozen));
 assert.deepEqual(calls[0],['prepare','markdown','source','en']);assert.deepEqual(calls[1],['save','markdown',frozen]);assert.equal(find(r,'project-export-markdown').props.disabled,false);
 await act(async()=>r.unmount());
});
