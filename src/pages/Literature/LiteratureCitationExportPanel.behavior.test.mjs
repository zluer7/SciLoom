import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const bundle=await build({
  stdin:{contents:`export { LiteratureCitationExportPanel } from './src/pages/Literature/LiteratureCitationExportPanel';`,resolveDir:resolve('.')},
  bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],
  plugins:[{name:'citation-io-ports',setup(api){
    const ports={
      I18nProvider:`export const useI18n=()=>({language:globalThis.__citation.language});`,
      literatureService:`export const literatureService={getLiteratureById:(...args)=>globalThis.__citation.read(...args)};`,
      exportService:`export const exportService={isDesktopRuntime:()=>true};export const sanitizeFileName=x=>x;export const saveTextFile=(...args)=>globalThis.__citation.save(...args);`
    };
    api.onResolve({filter:/(?:I18nProvider|literatureService|exportService)$/},args=>({path:args.path.split('/').at(-1),namespace:'citation-port'}));
    api.onLoad({filter:/.*/,namespace:'citation-port'},args=>({loader:'js',contents:ports[args.path]}));
  }}]
});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const Panel=module.exports.LiteratureCitationExportPanel;
const content=r=>JSON.stringify(r.toJSON());
const privateError='private-native-owner-id synthetic-secret';
async function mount(language){
  globalThis.__citation={language,reads:0,saves:0,read:async()=>{globalThis.__citation.reads++;return{id:'selected-owner',title:'Selected visible title',type:'journal_article',authors:[],year:2024};},save:async()=>{globalThis.__citation.saves++;throw Error(privateError);}};
  let r;await act(async()=>{r=TestRenderer.create(React.createElement(Panel,{literature:{id:'selected-owner',title:'Selected visible title'}}));});
  return r;
}
async function click(r,position){await act(async()=>r.root.findAllByType('button')[position].props.onClick());}

test('mounted save rejection is honest, does not retry and hides native error details in both languages',async()=>{
  for(const language of ['zh-CN','en-US']){
    const r=await mount(language);await click(r,0);await act(async()=>r.root.findByProps({'data-testid':'citation-export-save'}).props.onClick());
    assert.equal(globalThis.__citation.saves,1);assert.equal(globalThis.__citation.reads,1);
    assert.doesNotMatch(content(r),/private-native-owner-id|synthetic-secret/);
    assert.match(content(r),language==='zh-CN'?/保存失败/:/Save failed/);
    assert.doesNotMatch(content(r),/已保存 CSL JSON 文件|CSL JSON file saved/);await act(async()=>r.unmount());
  }
});

test('canonical preflight read rejection keeps selection invalid, blocks save and hides internal details in both languages',async()=>{
  for(const language of ['zh-CN','en-US']){
    const r=await mount(language);globalThis.__citation.read=async()=>{throw Error(privateError);};await click(r,0);
    assert.equal(r.root.findByProps({'data-testid':'citation-export-save'}).props.disabled,true);assert.equal(globalThis.__citation.saves,0);
    assert.doesNotMatch(content(r),/private-native-owner-id|synthetic-secret/);
    assert.match(content(r),language==='zh-CN'?/导出预检失败/:/Export preflight failed/);await act(async()=>r.unmount());
  }
});

test('switching the detail owner invalidates a pending canonical read and cannot retarget its frozen export',async()=>{
  const r=await mount('en-US');
  let release; const saves=[];
  globalThis.__citation.read=id=>new Promise(resolve=>{release=()=>resolve({id,title:'Old owner',publicationType:'journal_article',authors:[]});});
  await act(async()=>r.root.findAllByType('button')[0].props.onClick());
  await act(async()=>r.update(React.createElement(Panel,{literature:{id:'new-owner',title:'New owner'}})));
  await act(async()=>release());assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);
  globalThis.__citation.read=async id=>({id,title:'New canonical title',publicationType:'journal_article',authors:[]});
  globalThis.__citation.save=async(...args)=>{saves.push(args);return {saved:false};};
  await click(r,0);await act(async()=>r.root.findByProps({'data-testid':'citation-export-save'}).props.onClick());
  assert.equal(saves.length,1);assert.match(saves[0][1],/New canonical title/);assert.doesNotMatch(saves[0][1],/Old owner/);
  assert.match(content(r),/Save cancelled/);await act(async()=>r.unmount());
});
