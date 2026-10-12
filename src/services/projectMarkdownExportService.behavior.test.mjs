import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const bundle = await build({entryPoints:[resolve('src/services/projectMarkdownExportService.ts')],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'markdown-ports',setup(api){
  api.onResolve({filter:/(aiContextBuilderService|exportService)$/},args=>({path:args.path.split('/').at(-1),namespace:'port'}));
  api.onLoad({filter:/.*/,namespace:'port'},args=>({loader:'js',contents:args.path==='aiContextBuilderService'
    ? 'export const buildProjectAIContext=(...args)=>globalThis.__md.build(...args);'
    : 'export const sanitizeFileName=x=>x; export const saveTextFile=(...args)=>globalThis.__md.save(...args);'}));
}}]});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const service=module.exports.projectMarkdownExportService;

test('Markdown uses the existing human projection, requests no materials, and saves frozen bytes without rereading',async()=>{
  const calls=[];
  globalThis.__md={build:async(...args)=>{calls.push(['build',...args]);return {scope:{label:'Visible Project Ω',description:'Scientific question'},sourceRefs:[],sections:[{id:'project_overview',title:'Overview',items:[{id:'i',title:'Research aim',content:'Compare reproducibility Ω',summary:'Compare reproducibility Ω',sendable:true,sourceRefs:[]}]}],warnings:[]};},save:async(...args)=>{calls.push(['save',...args]);return {saved:true,filePath:'isolated.md'};}};
  const prepared=await service.prepare('project-owner','en');
  assert.ok(Object.isFrozen(prepared));assert.match(prepared.markdown,/Visible Project Ω/);assert.match(prepared.markdown,/Scientific question/);
  assert.match(prepared.markdown,/not a Project JSON exchange file or complete backup/);
  assert.deepEqual(calls[0],['build','project-owner',{contextMode:'STANDARD',researchObjects:[],selectedMaterials:[],approvedContextRequestContributions:[]}]);
  globalThis.__md.build=()=>{throw Error('must not reread');};
  await service.savePrepared(prepared);
  assert.deepEqual(calls[1],['save',prepared.fileName,prepared.markdown,'text/markdown;charset=utf-8']);
  globalThis.__md.save=async()=>({saved:false});assert.equal((await service.savePrepared(prepared)).saved,false);
  globalThis.__md.save=async()=>{throw Error('native failed');};await assert.rejects(service.savePrepared(prepared),/native failed/);
});

test('missing or unreadable Project fails before preparing or saving misleading Markdown',async()=>{
  let saves=0;globalThis.__md={build:async()=>({warnings:[{severity:'error',code:'project_not_found'}]}),save:()=>{saves++;}};
  await assert.rejects(service.prepare('missing','zh-CN'),/unavailable/);assert.equal(saves,0);
  globalThis.__md.build=async()=>{throw Error('canonical read failed');};await assert.rejects(service.prepare('missing','zh-CN'),/canonical read failed/);assert.equal(saves,0);
});
