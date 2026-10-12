import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Production Settings/page/client/parser. Only unrelated panels and runtime I/O are controlled.
const bundle = await build({
  stdin: { contents: `export { SettingsPage } from './src/pages/Settings/SettingsPage.tsx';
    export * from './src/services/aiClient.ts';
    export * from './src/services/aiStandardResultService.ts';`, resolveDir: resolve('.'), sourcefile: 'b5-mounted-provider.ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'b5-runtime-ports', setup(api) {
    const ports = {
      core: `export class Channel { constructor(onmessage){this.onmessage=onmessage;} }
        export const invoke=(command,args)=>globalThis.__b5.invoke(command,args);`,
      I18nProvider: `const t=key=>key; export const useI18n=()=>({language:'en-US',t});`,
      SettingsPanel: `export const SettingsPanel=({renderSections})=>renderSections({dataSourceSettings:null});`,
      useWriteFeedbackCenter: `export const useWriteFeedbackCenter=()=>({entries:[],dismissFeedback(){},consumeWriteError(){},consumeWriteResult(){},pushWriteFeedback(){}});`
    };
    api.onResolve({filter:/^@tauri-apps\/api\/core$/u},()=>({path:'core',namespace:'b5'}));
    api.onResolve({filter:/\/(I18nProvider|SettingsPanel|useWriteFeedbackCenter)$/u},args=>({path:args.path.split('/').at(-1),namespace:'b5'}));
    api.onResolve({filter:/components\/(feedback\/WriteFeedbackPanel|settings\/(ManagedRootSettingsPanel|AppearanceSettingsPanel|ProjectImportPanel|ProjectExportV1Panel|BusinessOperationHistoryPanel|RecentOperationLogPanel|SupportedRecycleRestorePanel))$/u},args=>({path:args.path.split('/').at(-1),namespace:'b5'}));
    api.onLoad({filter:/.*/u,namespace:'b5'},({path})=>({loader:'js',contents:ports[path]??`export const ${path}=()=>null;`}));
  }}]
});
const module={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const subject=module.exports;
const models={qwen:'qwen3.7-plus',gemini:'gemini-3.8-flash'};
const presets=Object.entries(models).map(([provider,model])=>({provider,model,displayName:provider==='qwen'?'Qwen (Singapore)':'Gemini',endpoint:provider==='qwen'?'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions':'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'}));
const safeStatus=(provider='qwen')=>({provider,model:models[provider],activeProvider:provider,activeModel:models[provider],availablePresets:presets,effectiveConfigured:false,appOverrideConfigured:false,configurationRevision:1});
const selector=renderer=>renderer.root.findByProps({'data-testid':'ai-provider-selector'});
const modelSelector=renderer=>renderer.root.findByProps({'data-testid':'ai-model-selector'});
const keyInput=renderer=>renderer.root.findByProps({id:'ai-provider-api-key'});
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(' '):text(node?.children??[]);
const nativePending=new Set();
async function flushNative(){while(nativePending.size)await Promise.allSettled([...nativePending]);}
async function mount(){let renderer;await act(async()=>{renderer=TestRenderer.create(React.createElement(subject.SettingsPage));});await act(flushNative);return renderer;}
async function select(renderer,provider){await act(async()=>{selector(renderer).props.onChange({target:{value:provider}});});await act(flushNative);}
async function submit(renderer){await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));}
async function unmount(renderer){await act(async()=>renderer.unmount());}

test('mounted production Settings shows curated choices, unconfigured truth, and no call on browsing',async()=>{
  const calls=[];globalThis.__b5={invoke:async(command,args)=>{calls.push(command);assert.equal(command,'get_ai_provider_configuration_status');return safeStatus(args.provider??'qwen');}};
  const renderer=await mount();assert.ok(renderer.root.findByProps({'data-settings-top-level':'basic-ai'}));
  assert.deepEqual(selector(renderer).findAllByType('option').map(option=>option.props.value),['qwen','gemini']);
  await select(renderer,'gemini');assert.equal(modelSelector(renderer).props.value,models.gemini);
  assert.equal(renderer.root.findByProps({'data-provider-credential-status':'unconfigured'}).type,'p');
  assert.match(text(renderer.toJSON()),/one active Provider/);assert.equal(calls.length,2);
  await unmount(renderer);
});

test('explicit save clears ephemeral input; failed native save cannot report success or replace active tuple',async()=>{
  let current='qwen';const writes=[];
  globalThis.__b5={invoke:async(command,args)=>{
    if(command==='get_ai_provider_configuration_status')return {...safeStatus(args.provider??current),activeProvider:current,activeModel:models[current]};
    if(command==='set_ai_provider_api_key'){writes.push(command);return safeStatus(args.provider);}
    if(command==='save_ai_provider_active_tuple')throw JSON.stringify({code:'secret_store_error',message:'Native secure store unavailable',retryable:false});
    throw Error('unexpected command');
  }};
  const renderer=await mount();await select(renderer,'gemini');
  await act(async()=>keyInput(renderer).props.onChange({target:{value:'synthetic-b5-ephemeral-only'}}));
  await submit(renderer);assert.equal(keyInput(renderer).props.value,'');assert.equal(current,'qwen');
  assert.equal(renderer.root.findByProps({role:'alert'}).type,'p');
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()),/synthetic-b5-ephemeral-only|were saved/);assert.deepEqual(writes,['set_ai_provider_api_key']);
  await unmount(renderer);
});

function startBridge(){
  const child=spawn(process.env.SCILOOM_B5_TEST_EXE,['b5_settings_persistence_bridge','--ignored','--nocapture','--test-threads=1'],{env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let sequence=0;let stderr='';
  child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  createInterface({input:child.stdout}).on('line',line=>{const offset=line.indexOf('B5_RESPONSE ');if(offset<0)return;const response=JSON.parse(line.slice(offset+12));const slot=pending.get(response.id);if(!slot)return;pending.delete(response.id);clearTimeout(slot.timer);if('Ok'in response.result)slot.resolve(response.result.Ok);else slot.reject(response.result.Err);});
  const completion=new Promise((yes,no)=>{child.on('error',no);child.on('exit',code=>{for(const slot of pending.values()){clearTimeout(slot.timer);slot.reject(Error('native bridge exited'));}if(code===0)yes();else no(Error(`native bridge failed ${code}: ${stderr}`));});});
  return {completion,call(command,args={}){return new Promise((yes,no)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);no(Error('native bridge timeout'));},20000);pending.set(id,{resolve:yes,reject:no,timer});child.stdin.write(JSON.stringify({id,command,args})+'\n');});},finish(){child.stdin.end(JSON.stringify({id:++sequence,command:'__finish',args:{}})+'\n');}};
}
const outcome=JSON.stringify({outcome:'STANDARD_RESULT_BATCH',batch:{version:1,results:[{category:'DATA_OPERATION',action:'CREATE',target:{projectId:'TEST_ONLY_PROJECT',entityType:'task'},payload:{title:'TEST_ONLY synthetic draft',taskType:'analysis'}}]}});
const bodyFor=content=>({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:5,total_tokens:8}});
function streamRequest(revision,provider){const id=`B5_TEST_ONLY_${provider}`;const descriptor={category:'PARSE_DRAFT',lifecycle:'ACTIVE',constraintRef:'labpod.ai.constraint.parse_draft',constraintVersion:1,sharedInvariantRef:'labpod.ai.constraint.shared_invariant',sharedInvariantVersion:2,boundedPolicyRefs:[]};return {promptEnvelope:{constraintDescriptor:descriptor,constraintSegments:[{kind:'shared_invariant',ref:descriptor.sharedInvariantRef,version:2,text:'Synthetic JSON only'},{kind:'category_policy',category:'PARSE_DRAFT',ref:descriptor.constraintRef,version:1,boundedPolicyRefs:[],text:'One Standard Result batch'}],researchContext:'TEST_ONLY empty context',conversationHistory:[],userQuestion:'Return synthetic JSON draft only',finalPromptHardBudget:15000},expectedConfigurationRevision:revision,requestId:id,callAttemptId:id,conversationId:'TEST_ONLY_CONVERSATION',triggerMessageId:'TEST_ONLY_MESSAGE',responseFormat:{type:'json_object'}};}

test('mounted Settings saves through real Tauri commands and fresh Windows secure tuple readback; both canonical controlled response contracts validate', {skip:!process.env.SCILOOM_B5_TEST_EXE},async()=>{
  const bridge=startBridge();const root=process.env.SCILOOM_B5_BRIDGE_ROOT;const evidence=[];const wires=[];let renderer;
  try{
    const production=await bridge.call('__production_status');
    // No key export, ordinary tuple mutation, or provider inference. Native slots checked status-only.
    assert.equal(production.secretValuesExported,false);
    const invoke=async(command,args)=>{
      if(command==='run_ai_text'){
        const wire=await bridge.call('__offline_wire',{revision:args.expectedConfigurationRevision,prompt:args.prompt,responseBody:bodyFor('TEST_ONLY normal response'),constrained:false});wires.push(wire);return wire.response;
      }
      if(command==='stream_ai_text'){
        assert.deepEqual(args.request.responseFormat,{type:'json_object'});
        const wire=await bridge.call('__offline_wire',{revision:args.request.expectedConfigurationRevision,prompt:'TEST_ONLY JSON draft; no business apply',responseBody:bodyFor(outcome),constrained:true});wires.push(wire);
        const identity=Object.fromEntries(['requestId','callAttemptId','conversationId','triggerMessageId'].map(key=>[key,args.request[key]]));
        const emit=(eventKind,eventSequence,fields)=>args.onEvent.onmessage({...identity,eventKind,eventSequence,...fields});
        emit('started',0,{provider:wire.response.provider,model:wire.response.model});emit('delta',1,{text:wire.response.text});emit('completed',2,wire.response);return;
      }
      return bridge.call(command,args??{});
    };
    globalThis.__b5={invoke(...args){const pending=invoke(...args);nativePending.add(pending);pending.then(()=>nativePending.delete(pending),()=>nativePending.delete(pending));return pending;}};
    renderer=await mount();
    for(const [provider,model]of Object.entries(models)){
      assert.ok(selector(renderer).findAllByType('option').some(option=>option.props.value===provider));
      await select(renderer,provider);assert.equal(modelSelector(renderer).props.value,model);
      await submit(renderer);assert.equal(keyInput(renderer).props.value,'');
      const fresh=await bridge.call('__restart');assert.equal(fresh.activeProvider,provider);assert.equal(fresh.activeModel,model);assert.equal(fresh.effectiveConfigured,false);
      await unmount(renderer);renderer=await mount();assert.equal(selector(renderer).props.value,provider);assert.equal(modelSelector(renderer).props.value,model);
      const statusBefore=await bridge.call('get_ai_provider_configuration_status');
      await assert.rejects(bridge.call('save_ai_provider_active_tuple',{provider,model:models[provider==='qwen'?'gemini':'qwen']}));
      assert.deepEqual(await bridge.call('get_ai_provider_configuration_status'),statusBefore);
      evidence.push({provider,model,freshReadback:fresh,mountedTree:renderer.toJSON(),invalidPairRejected:true});
      // Synthetic key uses native MemoryCredentialStore only; never the production OS slot.
      await act(async()=>keyInput(renderer).props.onChange({target:{value:`synthetic-b5-${provider}-memory-only`}}));
      await submit(renderer);assert.equal(keyInput(renderer).props.value,'');
      const configured=await bridge.call('get_ai_provider_configuration_status');assert.equal(configured.effectiveConfigured,true);
      const normal=await subject.runAIText('TEST_ONLY normal prompt',configured.configurationRevision);assert.equal(normal.provider,provider);assert.equal(normal.model,model);
      const terminal=await subject.startAITextStream(streamRequest(configured.configurationRevision,provider)).completion;
      assert.equal(terminal.eventKind,'completed');assert.equal(terminal.provider,provider);assert.equal(terminal.model,model);
      const validated=subject.parseAIParseDraftOutcome(terminal.text);assert.equal(validated.kind,'standard_result_batch');assert.equal(validated.payload.results.length,1);
      const failures=[];
      for(const content of ['not JSON','{"outcome":"STANDARD_RESULT_BATCH","batch":{"version":1,"results":[]}}','{"outcome":"STANDARD_RESULT_BATCH","batch":{"version":1,"results":[{"category":"UNKNOWN"}]}}']){
        const received=await bridge.call('__offline_wire',{revision:configured.configurationRevision,prompt:'TEST_ONLY JSON',responseBody:bodyFor(content),constrained:true});
        assert.throws(()=>subject.parseAIParseDraftOutcome(received.response.text),error=>{failures.push(error.code);return true;});
      }
      await assert.rejects(bridge.call('__offline_wire',{revision:configured.configurationRevision,prompt:'TEST_ONLY JSON',responseBody:{choices:[{message:{content:null,refusal:'Synthetic refusal'},finish_reason:'stop'}]},constrained:true}),error=>JSON.parse(error).code==='empty_content');
      assert.equal(wires.at(-1).request.response_format.type,'json_object');
      assert.equal(wires.at(-1).request.enable_thinking,provider==='qwen'?false:undefined);
      assert.equal(wires.at(-1).request.thinking,undefined);
      await bridge.call('clear_ai_provider_api_key',{provider});
      evidence.at(-1).offline={normalProvenance:true,constrainedParsedAndValidated:true,validationFailures:failures,refusalRejected:true,businessApplyCount:0,live:false};
    }
    assert.doesNotMatch(JSON.stringify({evidence,wires}),/synthetic-b5-.*memory-only/);
    writeFileSync(resolve(root,'mounted-settings-persistence.json'),JSON.stringify({boundary:'Production React Settings/page/client -> real Tauri mock IPC commands -> production native WindowsCredentialStore on fresh TEST_ONLY active tuple; no WebView launch',productionStatusOnly:production,evidence},null,2)+'\n');
    writeFileSync(resolve(root,'representative-ai-path.json'),JSON.stringify({boundary:'Production aiClient + native production builder/normalizer at controlled HTTP/Channel boundary + existing Standard Result parser; existing native SSE/cancellation regression run separately',wires,constrainedAcceptanceRequiresParsedAndValidated:true,live:false,businessApplyCount:0},null,2)+'\n');
  }finally{if(renderer)await unmount(renderer);bridge.finish();await bridge.completion;}
});
