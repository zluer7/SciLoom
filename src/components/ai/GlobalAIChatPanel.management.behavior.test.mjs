import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
const source=readFileSync(resolve('src/components/ai/GlobalAIChatPanel.tsx'),'utf8');
const mockedServices=['aiConversationApplicationService','planningService','researcherProfileService','aiProviderConfigurationClient'];
const childNames=['AssistantUIChatSurface','AIActionDraftPanel','AIContextPreviewPanel','AIParseDraftPanel','AIContextDiscardDialog'];
const bundle=await build({
 stdin:{contents:`export { GlobalAIChatPanel } from './src/components/ai/GlobalAIChatPanel.tsx'; export { ConversationHistoryPanel } from './src/components/ai/ConversationHistoryPanel.tsx'; export { I18nProvider } from './src/i18n/I18nProvider.tsx';`,resolveDir:resolve('.')},
 bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],loader:{'.css':'empty','.md':'text'},
 plugins:[{name:'mounted-parent-boundaries',setup(b){
  b.onResolve({filter:/./},args=>{
   const name=basename(args.path);
   if(mockedServices.includes(name))return {path:name,namespace:'services'};
   if(childNames.includes(name))return {path:name,namespace:'children'};
   if(name==='useFloatingAIPanel')return {path:name,namespace:'floating'};
   if(args.path.startsWith('@radix-ui/'))return {path:args.path,namespace:'primitives'};
  });
  b.onLoad({filter:/.*/,namespace:'services'},args=>{
   const match=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)].find(m=>basename(m[2])===args.path);
   const names=match[1].split(',').map(s=>s.trim()).filter(s=>s&&!s.startsWith('type '));
   if(args.path==='planningService') names.push('getProjectById');
   return {contents:names.map(name=>`export const ${name}=globalThis.__SC3_PARENT['${name}'] ?? (()=>undefined);`).join('\n')};
  });
  b.onLoad({filter:/.*/,namespace:'children'},args=>({contents:`import React from 'react'; export function ${args.path}(props){return React.createElement('${args.path}',props);}`}));
  b.onLoad({filter:/.*/,namespace:'floating'},()=>({contents:`export function useFloatingAIPanel(){return {style:{},rect:{},dragHandleProps:{},resizeHandleProps:{}}}`}));
  b.onLoad({filter:/.*/,namespace:'primitives'},args=>({contents:`import React from 'react'; ${['Root','Trigger','Portal','Content','Overlay','Item','Title','Description','Cancel','Action','Close'].map(name=>`export function ${name}(props){return React.createElement('${args.path.includes('dropdown')?'menu':args.path.includes('alert')?'alert':'dialog'}-${name}',props,props.children)}`).join('\n')}`}));
 }}]
});
let rows,reads,manager,failRefresh=false;
const base=id=>({id,stableKey:`key-${id}`,createdAt:'2026-10-07',updatedAt:'2026-10-07',messageCount:0,revision:0});
const readback=r=>({conversation:r,messages:[],callAttempts:[],projectedMessages:[],contextRequests:[],standardResults:[]});
const fixture={
 aiConversationApplicationService:{
  listConversations:async()=>{if(failRefresh)throw Error('read unavailable');return rows.map(r=>({...r}))},
  readConversation:async id=>{reads.push(id);return readback({...rows.find(r=>r.id===id)})},
  listAttachmentFileRefs:async()=>({fileRefs:[],effectiveReadableSelectionLimit:0,supportedExtensions:[]})
 },
 planningService:{queryProjects:async()=>[]},getResearcherProfile:async()=>null,
 getAIProviderConfigurationStatus:async()=>({eligibility:'blocked',effectiveConfigured:false,configuredSource:'none'}),
 effectiveDurableResultFromReadback:()=>undefined
};
globalThis.__SC3_PARENT=fixture;
const mod={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {GlobalAIChatPanel,ConversationHistoryPanel,I18nProvider}=mod.exports;
let mounted;
async function mount(seed,language='zh-CN'){rows=seed;reads=[];failRefresh=false;globalThis.window={localStorage:{getItem:key=>key==='researchpilot.language'?language:null,setItem(){}},__TAURI_INTERNALS__:{invoke:async(cmd,args)=>{assert.equal(cmd,'db_manage_ai_conversation');return manager(args.input)}}};
 await act(async()=>{mounted=TestRenderer.create(React.createElement(I18nProvider,null,React.createElement(GlobalAIChatPanel,{onClose(){}})));});
}
function history(){return mounted.root.findByType(ConversationHistoryPanel)}
function chat(){return mounted.root.findAllByType('AssistantUIChatSurface')[0]}
async function manage(id,action,extra={}){await act(async()=>history().props.onManage(rows.find(r=>r.id===id),action,extra));}
test.afterEach(()=>{if(mounted)act(()=>mounted.unmount());mounted=null;});
test('initial selection skips archived/trash; current trash chooses active fallback and clears old readback',async()=>{
 manager=async i=>{const r=rows.find(r=>r.id===i.conversationId);r.trashedAt='now';r.revision++;return {title:r.title,archivedAt:r.archivedAt,trashedAt:r.trashedAt,revision:r.revision}};
 await mount([base('trash'),base('archive'),base('active'),base('fallback')].map(r=>r.id==='trash'?{...r,trashedAt:'date'}:r.id==='archive'?{...r,archivedAt:'date'}:r));
 assert.equal(history().props.selectedId,'active');await manage('active','trash');assert.equal(history().props.selectedId,'fallback');assert.equal(chat().props.readback.conversation.id,'fallback');assert.deepEqual(reads,['active','fallback']);
});
test('moving the last active conversation leaves empty workspace; archive read is disabled for composition',async()=>{
 manager=async()=>{rows[0]={...rows[0],archivedAt:'date',trashedAt:null,revision:1};return rows[0]};await mount([base('only')]);await manage('only','archive');assert.equal(history().props.selectedId,null);assert.equal(chat(),undefined);
 await act(async()=>history().props.onSelect('only'));assert.equal(chat().props.composerDisabled,true);assert.equal(chat().props.sendDisabled,true);
});
test('failed IPC keeps current selection and rows; unsaved draft prevents destructive lifecycle IPC',async()=>{
 let count=0;manager=async()=>{count++;throw Error('AI_CONVERSATION_STATE_CHANGED')};await mount([base('a')]);
 await act(async()=>{await assert.rejects(history().props.onManage(rows[0],'trash'));});assert.equal(history().props.selectedId,'a');assert.equal(chat().props.readback.conversation.id,'a');assert.equal(count,1);
 act(()=>chat().props.onDraftChange('unsaved'));await act(async()=>{await assert.rejects(history().props.onManage(rows[0],'trash'),/UNSAVED_DRAFT/)});assert.equal(count,1);
});
test('native acknowledgment remains successful when post-write history refresh fails',async()=>{
 manager=async()=>{failRefresh=true;return {title:'renamed',archivedAt:null,trashedAt:null,revision:1}};await mount([base('a')]);await manage('a','rename',{title:'renamed'});
 assert.equal(history().props.summaries[0].title,'renamed');assert.equal(chat().props.readback.conversation.title,'renamed');assert.ok(history().props.error);
});
test('menu callback never selects its row; pending management blocks concurrent selection',async()=>{
 let done;manager=()=>new Promise(r=>done=r);await mount([base('a'),base('b')]);let promise;
 act(()=>{promise=history().props.onManage(rows[1],'rename',{title:'new'});history().props.onSelect('b')});assert.equal(history().props.selectedId,'a');assert.equal(history().props.busy,true);
 await act(async()=>{done({title:'new',revision:1});await promise});assert.equal(history().props.selectedId,'a');assert.deepEqual(reads,['a']);
});
test('refresh reconciles an externally trashed current owner without reopening Trash',async()=>{
 await mount([base('a'),base('b')]);rows[0]={...rows[0],trashedAt:'external',revision:1};
 await act(async()=>history().props.onRefresh());assert.equal(history().props.selectedId,'b');assert.equal(chat().props.readback.conversation.id,'b');assert.deepEqual(reads,['a','b']);
});
test('failed refresh preserves known selection and displays retryable history error',async()=>{
 await mount([base('a')]);failRefresh=true;await act(async()=>{await assert.rejects(history().props.onRefresh())});
 assert.equal(history().props.selectedId,'a');assert.equal(chat().props.readback.conversation.id,'a');assert.ok(history().props.error);assert.equal(history().props.busy,false);
});
test('late management acknowledgment after panel closes performs no fallback read or history refresh',async()=>{
 let done,count=0;manager=()=>new Promise(r=>done=r);await mount([base('a'),base('b')]);
 const originalList=fixture.aiConversationApplicationService.listConversations;fixture.aiConversationApplicationService.listConversations=async()=>{count++;return originalList()};
 let promise;act(()=>{promise=history().props.onManage(rows[0],'trash')});act(()=>mounted.unmount());mounted=null;
 await act(async()=>{done({trashedAt:'now',revision:1});await promise});assert.deepEqual(reads,['a']);assert.equal(count,0);
 fixture.aiConversationApplicationService.listConversations=originalList;
});


test('actual parent sidebar removes model/settings and orders project, detail, New then history in both languages',async()=>{
 for(const language of ['zh-CN','en-US']){
  await mount([base('a'),base('b')],language);
  const sidebar=mounted.root.findByProps({className:'global-ai-chat-panel__sidebar'});
  const controls=sidebar.findByProps({className:'global-ai-chat-panel__core-controls'});
  const children=controls.children.filter(c=>typeof c!=='string');
  assert.equal(children[0].props.htmlFor,'global-ai-project-scope');assert.equal(children[1].props.htmlFor,'global-ai-output-detail');assert.equal(children[2].props['data-first-use-action'],'create-conversation');
  assert.equal(sidebar.findAllByProps({'data-testid':'compact-model-status'}).length,0);assert.equal(sidebar.findAllByProps({className:'global-ai-chat-panel__settings-link'}).length,0);
  assert.equal(sidebar.children[0],controls);assert.equal(sidebar.children[1].type,ConversationHistoryPanel);
  assert.equal(children[2].props.disabled,false);assert.ok(children[2].children.filter(c=>typeof c==='string').join('').includes(language==='zh-CN'?'新建对话':'New conversation'));
  act(()=>mounted.unmount());mounted=null;
 }
});
