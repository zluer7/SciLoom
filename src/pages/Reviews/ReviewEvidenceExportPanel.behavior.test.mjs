import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const bundle = await build({
  stdin: { contents: `export * from "./src/pages/Reviews/ReviewEvidenceExportPanel";
    export * from "./src/services/reviewEvidenceExportPresentationService";
    export * from "./src/services/reviewEvidenceContextService";
    export * from "./src/services/reviewExportService";`, resolveDir: resolve(".") },
  bundle: true, write: false, platform: "node", format: "cjs", target: "es2022", jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "canonical-and-native-test-ports", setup(api) {
    const ports = {
      planningService: `export const planningService = {getReviewById: (...a) => globalThis.__b2.readReview(...a)};`,
      planningSelectorService: `export const planningSelectorService = {getReviewAggregationContext: (...a) => globalThis.__b2.readAggregation(...a)};`,
      experimentService: "export const experimentService = {};", outputService: "export const outputService = {};",
      I18nProvider: `export const useI18n = () => ({language: globalThis.__b2.language ?? 'en'});`,
      core: `export const invoke = (...a) => globalThis.__b2.invoke(...a);`
    };
    api.onResolve({filter: /(?:planningService|planningSelectorService|experimentService|outputService|I18nProvider)$|^@tauri-apps\/api\/core$/}, (args) => ({path: args.path.split('/').at(-1), namespace: 'b2-port'}));
    api.onLoad({filter: /.*/, namespace: 'b2-port'}, (args) => ({loader:'js', contents: ports[args.path]}));
  }}]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const {ReviewEvidenceExportPanel: Panel, reviewEvidenceExportPresentationService: service,
  createReviewEvidenceContext, buildReviewScopeSummary, classifyReviewTargetEvidence,
  formatReviewAiContextMarkdown} = module.exports;

function fixture(id = 'review-a', rich = true) {
  const review = {id, projectId:'project-a', title:`Review ${id} Ω`, updatedAt:'2026-10-03', reviewType:'custom',
    outlineSections:[{key:'custom_summary', content:'User **Markdown** C:\\research\\text Ω'}], structuredRevision:1,
    descriptorIdentity:'review/primary/custom/v1', structuredLifecycleEvidence:'review-lifecycle/v1:none'};
  const target = {entityType:'task', entityId:'private-row-id', title:'Recorded task Ω', sourceAvailable:true};
  const line = {sourceKind:'indirect_cross_module_evidence', role:'supporting', scopeSensitivity:['link_bound'],
    sourceBoundary:'Current metadata only', evidence:{evidenceType:'literature', evidenceId:'private-paper-id', title:'Recorded paper'},
    warnings:[], missingReferences:[], partial:false};
  const evidence = createReviewEvidenceContext({
    scopeSummary:buildReviewScopeSummary(review, rich ? [target] : []),
    directTargetEvidence:classifyReviewTargetEvidence(rich ? [target, {...target,entityId:'deleted-row-id',sourceAvailable:false}] : []),
    indirectEvidence:rich ? [line] : [], taskEvidence:rich ? [{...line,category:'task'}] : [],
    experimentEvidence:rich ? [{...line,category:'experiment'}] : [], literatureEvidence:rich ? [{...line,category:'literature'}] : [],
    derivedOutputEvidence:rich ? [{...line,sourceKind:'derived_output_evidence',role:'derived',partial:true}] : [],
    outputEvidence:rich ? [{...line,category:'output'}] : [],
    periodEvidence:rich ? [{...line,sourceKind:'period_evidence',period:{start:'2026-10-01',end:'2026-10-03'}}] : [],
    existingReviewContentEvidence:rich ? [{...line,sourceKind:'existing_review_content',evidence:{...line.evidence,title:'User **Markdown** C:\\research\\text Ω'}}] : [],
    missingReferences:rich ? [{targetType:'task',targetId:'deleted-row-id',reason:'target_not_found'}, {targetType:'other',targetId:'unknown-row-id',reason:'unsupported_target_type'}, {targetType:'literature',targetId:'failed-row-id',reason:'resolver_error'}] : [],
    limitations:rich ? [{code:'missing_reference',message:'Missing sources'}, {code:'period_membership_not_finalized',message:'Period only filters tasks'}, {code:'derived_chain_not_expanded',message:'Stage summaries'}] : [],
    warnings:rich ? ['upstream notice private-row-id'] : [], partial:rich,
    partialReasons:rich ? ['inferred_task_scope','missing_reference'] : []
  });
  return {review, aggregation:{review:{entityId:id,title:review.title}, scope:'project', period:{}, targets:[], routeNodes:[],
    evidenceContext:evidence,missingReferences:evidence.missingReferences,warnings:evidence.warnings}};
}
function setup(data=fixture()) {
  const calls=[];
  globalThis.window={__TAURI_INTERNALS__:{}};
  globalThis.__b2={readReview:async () => structuredClone(data.review), readAggregation:async () => structuredClone(data.aggregation),
    invoke:async (...args) => {calls.push(args); return 'N:\\B2\\review.md';}};
  return calls;
}
function content(renderer) { return JSON.stringify(renderer.toJSON()); }
function entry(renderer,id) {return renderer.root.findByProps({'data-testid':id});}
async function mount(review) {let renderer; await act(async()=> {renderer=TestRenderer.create(React.createElement(Panel,{review}));});return renderer;}
async function clickExport(renderer) {await act(async()=>{await entry(renderer,'review-export-markdown').props.onClick();});}
async function openContext(r) { await act(async () => { entry(r, "review-evidence-disclosure").props.onToggle({currentTarget:{open:true}}); }); }
function deferred() {let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('header slot uses the same controller once and errors remain outside collapsed scope; duplicate clicks save once',async()=>{
  const data=fixture();const calls=setup(data);let reads=0;
  globalThis.__b2.readAggregation=async()=>{reads++;return data.aggregation;};
  let r;await act(async()=>{r=TestRenderer.create(React.createElement(Panel,{review:data.review},(evidence,action)=>React.createElement('article',null,React.createElement('header',null,action),React.createElement('aside',null,evidence))));});
  assert.equal(r.root.findByProps({'data-testid':'review-export-markdown'}).props.children,'Export');assert.equal(reads,0); await openContext(r); assert.equal(reads,1);assert.equal(r.root.findByType('header').findAllByType('button').length,1);
  assert.equal(entry(r,'review-evidence-disclosure').props.open,undefined);
  assert.ok(r.root.findAllByProps({className:'evidence-notice'}).length);
  await act(async()=>{entry(r,'review-export-markdown').props.onClick();entry(r,'review-export-markdown').props.onClick();});
  assert.equal(calls.length,1);await act(async()=>r.unmount());
  setup(data);globalThis.__b2.readAggregation=async()=>{throw Error('read unavailable');};r=await mount(data.review);await openContext(r);
  const alert=r.root.findByProps({role:'alert'});assert.equal(alert.parent.props['data-testid'],'review-evidence-export-panel');await act(async()=>r.unmount());
});

test('mounted entry displays all current classified sources, neutral limitations and distinct missing reasons without internal IDs', async()=>{
  const data=fixture();setup(data); const renderer=await mount(data.review);await openContext(renderer);
  assert.equal(entry(renderer,'review-evidence-groups').findAllByType('details').length,9);
  const text=content(renderer);
  for(const expected of ['Recorded task Ω','Recorded paper','Source no longer exists','Source type is unsupported','Source could not be read','Categories may overlap','not a record of materials used','full provenance chain','Local file bodies']) assert.ok(text.includes(expected),expected);
  assert.ok(!text.includes('private-row-id') && !text.includes('deleted-row-id') && !text.includes('resolver_error'));
  renderer.unmount();
});
test('unassociated empty categories differ from unavailable evidence and failed loads; retry re-reads production path', async()=>{
  const data=fixture('empty',false);setup(data);let renderer=await mount(data.review);await openContext(renderer);
  assert.ok(content(renderer).includes('No evidence is linked or recorded'));renderer.unmount();
  globalThis.__b2.readAggregation=async()=>({...data.aggregation,evidenceContext:undefined});renderer=await mount(data.review);await openContext(renderer);
  assert.ok(content(renderer).includes('counts are unknown'));assert.equal(renderer.root.findAllByProps({'data-testid':'review-evidence-groups'}).length,0);renderer.unmount();
  globalThis.__b2.readAggregation=async()=>{throw new Error('read failure');};renderer=await mount(data.review);await openContext(renderer);
  assert.equal(entry(renderer,'review-export-markdown').props.disabled,false);assert.ok(!content(renderer).includes('No evidence is linked'));
  globalThis.__b2.readAggregation=async()=>data.aggregation;
  await act(async()=>{renderer.root.findAllByType('button').find(b=>b.children.includes('Retry reading')).props.onClick();});
  assert.equal(entry(renderer,'review-export-markdown').props.disabled,false);renderer.unmount();
});
test('explicit mounted export uses real production serializer and exact single-generated save result without mutating Review',async()=>{
  const data=fixture();const before=structuredClone(data.review);const calls=setup(data);let aggregationReads=0;
  globalThis.__b2.readAggregation=async()=>{aggregationReads++;return data.aggregation;};
  const renderer=await mount(data.review);await clickExport(renderer);
  assert.equal(calls.length,1);assert.equal(calls[0][0],'save_text_file');
  const context=await service.read(data.review);assert.equal(calls[0][1].contents,formatReviewAiContextMarkdown(context));
  assert.match(calls[0][1].contents,/## Direct Target Evidence/);assert.match(calls[0][1].contents,/User \*\*Markdown\*\* C:\\research\\text Ω/);
  assert.equal(aggregationReads,2);assert.deepEqual(data.review,before);
  assert.match(content(renderer),/Saved “Review review-a Ω”/);renderer.unmount();
});
test('cancel and filesystem failure never report success, with no automatic retry',async()=>{
  for(const outcome of ['cancel','failure']) {
    const data=fixture();const calls=setup(data);globalThis.__b2.invoke=async(...args)=>{calls.push(args);if(outcome==='failure')throw new Error('write failed');return null;};
    const renderer=await mount(data.review);await clickExport(renderer);
    assert.equal(calls.length,1);assert.ok(!content(renderer).includes('Saved “'));
    assert.ok(content(renderer).includes(outcome==='cancel'?'no file was saved':'no success was reported'));renderer.unmount();
  }
});
test('invalid, deleted, replaced and changed-during-generation Reviews fail before native save; archived reads retain current policy',async()=>{
  const data=fixture();const calls=setup(data);
  for(const expected of [undefined,{...data.review,id:''},{...data.review,deletedAt:'now'},{...data.review,title:'old'}]) await assert.rejects(service.prepare(expected));
  globalThis.__b2.readReview=async()=>undefined;await assert.rejects(service.prepare(data.review),/review_unavailable/);
  globalThis.__b2.readReview=async()=>data.review;globalThis.__b2.readAggregation=async()=>{data.review={...data.review,structuredRevision:2};return data.aggregation;};
  await assert.rejects(service.prepare({...data.review}),/review_changed/);assert.equal(calls.length,0);
  const archived={...data.review,archivedAt:'now'};globalThis.__b2.readReview=async()=>archived;globalThis.__b2.readAggregation=async()=>data.aggregation;
  assert.equal((await service.prepare(archived)).reviewId,data.review.id);
});
test('switching selection drops late context and stops an export still generating',async()=>{
  const a=fixture();const b=fixture('review-b',false);const calls=setup(a);const load=deferred();
  globalThis.__b2.readReview=async(id)=>id===a.review.id?a.review:b.review;
  globalThis.__b2.readAggregation=async(id)=>id===a.review.id?load.promise:b.aggregation;
  const renderer=await mount(a.review);await openContext(renderer);
  await act(async()=>renderer.update(React.createElement(Panel,{review:b.review})));
  await act(async()=>load.resolve(a.aggregation));assert.ok(!content(renderer).includes('Recorded task Ω'));
  const generation=deferred();globalThis.__b2.readAggregation=async(id)=>id===b.review.id?generation.promise:a.aggregation;
  await act(async()=>entry(renderer,'review-export-markdown').props.onClick());
  await act(async()=>renderer.update(React.createElement(Panel,{review:a.review})));
  await act(async()=>generation.resolve(b.aggregation));assert.equal(calls.length,0);renderer.unmount();
});
test('selection changes during native save retain frozen bytes and suppress success on the other Review',async()=>{
  const a=fixture();const b=fixture('review-b',false);const calls=setup(a);const saving=deferred();
  globalThis.__b2.readReview=async(id)=>id===a.review.id?a.review:b.review;
  globalThis.__b2.readAggregation=async(id)=>id===a.review.id?a.aggregation:b.aggregation;
  globalThis.__b2.invoke=async(...args)=>{calls.push(args);return saving.promise;};
  const renderer=await mount(a.review);await clickExport(renderer);
  const frozen=calls[0][1].contents;
  await act(async()=>renderer.update(React.createElement(Panel,{review:b.review})));
  await act(async()=>saving.resolve('N:\\B2\\review-a.md'));
  assert.equal(calls[0][1].contents,frozen);assert.ok(!content(renderer).includes('Saved “'));renderer.unmount();
});

test('default detail performs zero aggregation reads; explicit export performs one complete read',async()=>{
  const data=fixture();setup(data);let reads=0;__b2.readAggregation=async()=>{reads++;return data.aggregation;};
  const r=await mount(data.review);assert.equal(reads,0);assert.equal(r.root.findAllByProps({'data-testid':'review-evidence-groups'}).length,0);
  assert.ok(!content(r).includes('No evidence is linked'));await clickExport(r);assert.equal(reads,1);r.unmount();
});
