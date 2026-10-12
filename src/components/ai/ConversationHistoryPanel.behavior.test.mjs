import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// Mounted component state/command contracts. Primitives are host adapters here;
// actual Radix DOM focus, portal placement and browser keyboard behavior need local UI acceptance.
const bundle = await build({
  stdin: { contents: `export { ConversationHistoryPanel } from './src/components/ai/ConversationHistoryPanel.tsx'; export { I18nProvider } from './src/i18n/I18nProvider.tsx';`, resolveDir: resolve(".") },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "primitive-hosts", setup(b) {
    b.onResolve({ filter: /^@radix-ui\/react-(dropdown-menu|alert-dialog|dialog)$/ }, args => ({ path: args.path, namespace: "hosts" }));
    b.onLoad({ filter: /.*/, namespace: "hosts" }, args => ({ contents: `const React=require('react'); ${["Root","Trigger","Portal","Content","Overlay","Item","Title","Description","Cancel","Action","Close"].map(name => `exports.${name}=(props)=>React.createElement('${args.path.includes('dropdown') ? 'menu' : args.path.includes('alert') ? 'alert' : 'dialog'}-${name}',props,props.children);`).join('\n')}` }));
  }}]
});
const mod = { exports: {} }; new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { ConversationHistoryPanel, I18nProvider } = mod.exports;
const row = (id, extra={}) => ({ id, stableKey:`key-${id}`,createdAt:"2026-10-07",updatedAt:"2026-10-07T12:00:00Z",firstUserMessage:`Question ${id}`,latestMessage:"Details",messageCount:2,revision:0,...extra });
let mounted, props, calls;
function mount(extra={}) {
  calls=[];props={summaries:[row('a'),row('b',{archivedAt:'date'}),row('c',{trashedAt:'date'})],selectedId:'a',view:'ACTIVE',busy:false,loading:false,onSelect:id=>calls.push(['select',id]),onViewChange:()=>{},onManage:async (r,action,options)=>calls.push([action,r.id,options]),...extra};
  act(()=>{mounted=TestRenderer.create(React.createElement(I18nProvider,null,React.createElement(ConversationHistoryPanel,props)));});
}
function update(extra) {props={...props,...extra};act(()=>mounted.update(React.createElement(I18nProvider,null,React.createElement(ConversationHistoryPanel,props))));}
function text(node) {return node.children.map(c=>typeof c==='string'?c:text(c)).join('');}
function item(label) {return mounted.root.findAllByType('menu-Item').find(n=>text(n)===label);}
function rows() {return mounted.root.findAll(n=>n.type==='div'&&n.props['data-conversation-row']).map(n=>n.props['data-conversation-row']);}
test.afterEach(()=>{if(mounted)act(()=>mounted.unmount());mounted=null;});
test('views hide other lifecycle rows, search matches title/message, selection preserves canonical identity',async()=>{
  mount();assert.deepEqual(rows(),['a']);act(()=>mounted.root.findByProps({'data-conversation-id':'a'}).props.onClick());assert.deepEqual(calls,[['select','a']]);
  update({view:'ARCHIVED'});assert.deepEqual(rows(),['b']);assert.ok(item('取消归档'));
  update({view:'TRASHED'});assert.deepEqual(rows(),['c']);assert.equal(mounted.root.findByProps({'data-conversation-id':'c'}).props.disabled,true);
  act(()=>mounted.root.findByProps({type:'search'}).props.onChange({target:{value:'no match'}}));assert.deepEqual(rows(),[]);
  act(()=>mounted.root.findByProps({type:'search'}).props.onChange({target:{value:'Details'}}));assert.deepEqual(rows(),['c']);
});
test('archive, unarchive, trash and restore dispatch the displayed row with no purge confirmation',async()=>{
  mount();await act(async()=>item('归档').props.onSelect());assert.equal(calls[0][0],'archive');
  await act(async()=>item('移到回收站').props.onSelect());assert.equal(calls[1][0],'trash');
  update({view:'ARCHIVED'});await act(async()=>item('取消归档').props.onSelect());assert.equal(calls[2][0],'unarchive');
  update({view:'TRASHED'});await act(async()=>item('恢复').props.onSelect());assert.equal(calls[3][0],'restore');
  assert.ok(calls.every(c=>c[2].confirmed===undefined));
});
test('permanent delete does nothing on menu open or cancel; explicit confirm binds the trashed identity',async()=>{
  mount({view:'TRASHED'});act(()=>item('永久删除').props.onSelect());assert.equal(calls.length,0);
  let dialog=mounted.root.findByType('alert-Root');assert.equal(dialog.props.open,true);act(()=>dialog.props.onOpenChange(false));assert.equal(calls.length,0);
  act(()=>item('永久删除').props.onSelect());await act(async()=>mounted.root.findByType('alert-Action').props.onClick({preventDefault(){}}));
  assert.deepEqual(calls,[['permanentDelete','c',{confirmed:true}]]);assert.equal(mounted.root.findByType('alert-Root').props.open,false);
});
test('failed purge leaves confirmation open and all rows; busy operations disable actions and selection',async()=>{
  mount({view:'TRASHED',onManage:async()=>{throw Error('rejected');}});act(()=>item('永久删除').props.onSelect());
  await act(async()=>mounted.root.findByType('alert-Action').props.onClick({preventDefault(){}}));assert.equal(mounted.root.findByType('alert-Root').props.open,true);assert.deepEqual(rows(),['c']);assert.ok(mounted.root.findAll(n=>n.props.role==='alert').length);
  update({view:'ACTIVE',busy:true});assert.equal(item('归档').props.disabled,true);assert.equal(mounted.root.findByProps({'data-conversation-id':'a'}).props.disabled,true);
});
test('an in-flight purge prevents close and repeated confirmation',async()=>{
  let done;mount({view:'TRASHED',onManage:()=>new Promise(r=>done=r)});act(()=>item('永久删除').props.onSelect());
  act(()=>mounted.root.findByType('alert-Action').props.onClick({preventDefault(){}}));assert.equal(mounted.root.findByType('alert-Action').props.disabled,true);
  act(()=>mounted.root.findByType('alert-Root').props.onOpenChange(false));assert.equal(mounted.root.findByType('alert-Root').props.open,true);
  await act(async()=>done());assert.equal(mounted.root.findByType('alert-Root').props.open,false);
});
test('rename cancel is inert; trims title, bounds Unicode length and never switches conversation',async()=>{
  mount();act(()=>item('重命名').props.onSelect());assert.equal(calls.length,0);act(()=>mounted.root.findByType('dialog-Root').props.onOpenChange(false));assert.equal(calls.length,0);
  act(()=>item('重命名').props.onSelect());const input=()=>mounted.root.findByProps({'aria-label':'对话名称'});
  act(()=>input().props.onChange({target:{value:' '}}));assert.equal(mounted.root.findAllByType('button').find(n=>n.props.type==='submit').props.disabled,true);
  act(()=>input().props.onChange({target:{value:'Ω'.repeat(201)}}));assert.equal(mounted.root.findAllByType('button').find(n=>n.props.type==='submit').props.disabled,true);
  act(()=>input().props.onChange({target:{value:'  new title Ω  '}}));await act(async()=>mounted.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(calls,[['rename','a',{title:'new title Ω'}]]);assert.equal(mounted.root.findByType('dialog-Root').props.open,false);
});
test('stale rename remains open; explicit refresh failures are visible and do not fabricate success',async()=>{
  let refreshes=0;mount({onManage:async()=>{throw Error('AI_CONVERSATION_STATE_CHANGED')},onRefresh:async()=>{refreshes++;throw Error('unavailable')}});
  act(()=>item('重命名').props.onSelect());await act(async()=>mounted.root.findByType('form').props.onSubmit({preventDefault(){}}));assert.equal(mounted.root.findByType('dialog-Root').props.open,true);
  assert.ok(mounted.root.findAll(n=>n.props.role==='alert').some(n=>text(n).includes('状态已变化')));
  act(()=>mounted.root.findByType('dialog-Root').props.onOpenChange(false));await act(async()=>mounted.root.findByProps({'aria-label':'刷新历史'}).props.onClick());assert.equal(refreshes,1);
  assert.ok(mounted.root.findAll(n=>n.props.role==='alert').some(n=>text(n).includes('刷新失败')));assert.deepEqual(rows(),['a']);
});
test('same-tick repeated submit dispatches exactly once',async()=>{
  let done, count=0;mount({onManage:()=>{count++;return new Promise(r=>done=r)}});act(()=>item('重命名').props.onSelect());
  const submit=mounted.root.findByType('form').props.onSubmit;act(()=>{submit({preventDefault(){}});submit({preventDefault(){}})});assert.equal(count,1);
  await act(async()=>done());
});
test('long history keeps search/refresh and lifecycle navigation outside list; action remains separate from title selection',()=>{
  mount({summaries:Array.from({length:80},(_,i)=>row(`long-${i}`,{title:'长标题 '.repeat(20)})),onRefresh:async()=>{}});
  const panel=mounted.root.findByProps({className:'global-ai-chat-panel__history'});
  const list=mounted.root.findByType('nav');const views=mounted.root.findByProps({className:'conversation-history-views'});
  const toolbar=mounted.root.findByProps({className:'conversation-history-toolbar'});
  assert.ok(panel.children.indexOf(list) >= 0 && panel.children.indexOf(views) > panel.children.indexOf(list));
  assert.equal(list.findAllByProps({className:'conversation-history-views'}).length,0);
  assert.equal(toolbar.findAllByProps({type:'search'}).length,1);assert.equal(toolbar.findAllByProps({'aria-label':'刷新历史'}).length,1);
  const card=mounted.root.findByProps({'data-conversation-row':'long-0'});
  const select=card.findByProps({'data-conversation-id':'long-0'});assert.ok(select.findByType('strong'));assert.ok(select.findByType('time'));
  assert.equal(select.findAllByType('menu-Trigger').length,0);assert.equal(card.findAllByType('menu-Trigger').length,1);
});
