import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const b=await build({entryPoints:['src/services/runtimePageSelection.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
const freshRuntime=()=>{const m={exports:{}};new Function('require','module','exports',b.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);return m.exports.runtimePageSelection;};
test('selection IDs are independent by page/project/layer and clearing never selects another owner',()=>{
 const m=freshRuntime();assert.equal(m.read('reviews','a'),null);m.remember('reviews','a','review-a');m.remember('reviews','b','review-b');m.remember('outputs','a','finding-a','finding');m.remember('outputs','a','gap-a','outputGap');
 assert.equal(m.read('reviews','a'),'review-a');assert.equal(m.read('reviews','b'),'review-b');assert.equal(m.read('outputs','a','finding'),'finding-a');assert.equal(m.read('outputs','a','outputGap'),'gap-a');assert.equal(m.read('outputs','b','finding'),null);m.remember('outputs','a',null,'finding');assert.equal(m.read('outputs','a','finding'),null);assert.equal(m.read('outputs','a','outputGap'),'gap-a');
});
test('new module runtime starts empty even with the same browser storage and project preference',()=>{
 globalThis.window={localStorage:{getItem(){throw Error('selection storage read forbidden');},setItem(){throw Error('selection storage write forbidden');}}};const old=freshRuntime();old.remember('reviews','p','r');old.remember('outputs','p','f','finding');const next=freshRuntime();assert.equal(next.read('reviews','p'),null);assert.equal(next.read('outputs','p','finding'),null);assert.equal(old.read('reviews','p'),'r');delete globalThis.window;
});
