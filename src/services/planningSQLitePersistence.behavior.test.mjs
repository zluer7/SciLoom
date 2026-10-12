import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundle = await build({entryPoints:[new URL('./planningSQLitePersistence.ts',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],bundle:true,write:false,format:'esm',platform:'node',target:'es2022',plugins:[{name:'ipc-boundary',setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'ipc',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const invoke=(command,args)=>globalThis.__planningIPC(command,args);',loader:'js'}));}}]});
const {createPlanningSQLitePersistence}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const session={processGeneration:'p',producerSessionGeneration:1,transportGeneration:1,producerCapability:'cap'};
const initial={envelopeVersion:1,repositoryEpoch:'11111111-1111-4111-8111-111111111111',revision:'9',snapshot:{value:'source'}};
function fixture(options={}) {
 let target=options.target, raw=JSON.stringify(initial), reads=0, imports=0;
 globalThis.__planningIPC=async(command,args)=>{
   if(command==='planning_repository_read')return structuredClone(target??null);
   if(command==='planning_repository_import'){imports++;target=structuredClone(args.envelope);if(options.unknown)throw Error('lost IPC acknowledgement');return target;}
   if(command==='planning_repository_commit')return {status:'revision_stale'};
   throw Error(command);
 };
 const store=createPlanningSQLitePersistence({storageKey:'labpod.planning.v1',readSource(){reads++;if(options.unreadable)throw Error('blocked storage');return options.corrupt?'bad json':options.missing?null:raw;},createRepositoryEpoch:()=>initial.repositoryEpoch,createInitialSnapshot:async()=>({value:'fresh'}),normalizeSnapshot:x=>x,prepareSource:async x=>{if(options.mutateSource)raw='changed';return x;}});
 store.activateWriter(session);
 return {store,get reads(){return reads;},get imports(){return imports;}};
}
test('completed target never reads missing/unreadable/stale source; historical import is not current revision',async()=>{
 for(const options of [{missing:true},{unreadable:true},{corrupt:true},{}]){
  const f=fixture({...options,target:{...initial,revision:'12',snapshot:{value:'new SQLite fact'}}});await f.store.bootstrap();assert.equal((await f.store.readEnvelope()).revision,'12');assert.equal(f.reads,0);assert.equal(f.imports,0);
 }
});
test('unknown import outcome is read back before activation, never blindly replayed',async()=>{
 const f=fixture({unknown:true});await f.store.bootstrap();assert.deepEqual(await f.store.readEnvelope(),initial);assert.equal(f.imports,1);
});
test('uncommitted unreadable/corrupt/changed source fails closed without import',async()=>{
 for(const options of [{unreadable:true},{corrupt:true},{mutateSource:true}]){
  const f=fixture(options);await assert.rejects(()=>f.store.bootstrap());assert.equal(f.imports,0);await assert.rejects(()=>f.store.readEnvelope());
 }
});
test('inactive and replaced local writer cannot submit snapshots; backend owns actual CAS',async()=>{
 const f=fixture({target:initial});await assert.rejects(()=>f.store.readEnvelope());await f.store.bootstrap();
 await assert.rejects(()=>f.store.commitSnapshot({}, {...session,transportGeneration:0}),/WRITER_STALE/);
 assert.equal((await f.store.commitSnapshot({expectedEpoch:initial.repositoryEpoch,expectedRevision:'0',nextSnapshot:{}})).status,'revision_stale');
 f.store.revokeWriter(session);await assert.rejects(()=>f.store.readEnvelope());
});
