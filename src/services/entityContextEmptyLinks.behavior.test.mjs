import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// Production projection with controlled canonical read boundaries; not a latency benchmark.
const bundle = await build({
  stdin: {contents:'export * from "./entityContextService";',resolveDir:import.meta.dirname,sourcefile:"entity-context-empty-links.ts"},
  bundle:true,write:false,format:"esm",platform:"node",target:"es2022",logLevel:"silent",
  plugins:[{name:"canonical-read-fixture",setup(api){
    api.onResolve({filter:/^\.\//},args=>{
      if(args.importer.endsWith("entityContextService.ts") && args.path.endsWith("Service")) return {path:args.path.slice(2),namespace:"fixture"};
      if(args.importer.endsWith("entityContextService.ts") && args.path==="./planningRepository") return {path:"planningRepository",namespace:"fixture"};
    });
    api.onLoad({filter:/.*/,namespace:"fixture"},args=>({contents:args.path==="planningRepository"
      ? 'export const getPlanningData=(...args)=>globalThis.__b17ContextReads("getPlanningData",args);'
      : `export const ${args.path}=new Proxy({}, {get:(_,name)=>(...args)=>globalThis.__b17ContextReads(${JSON.stringify(args.path)}+"."+name,args)});`}));
  }}]
});
const service=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
function fixture({incoming=[],outgoing=[],missingTask=false,fail}={}) {
  const calls=[];
  globalThis.__b17ContextReads=async(name,args)=>{
    calls.push({name,args});
    if(fail===name) throw new Error("CANONICAL_READ_FAILED");
    if(name.startsWith("entityLinkService.queryLinksBy")) return [];
    if(name==="literatureService.queryLiteratureLinks") return outgoing;
    if(name==="literatureService.getLinksByTarget") return incoming;
    if(name==="planningService.getTaskById") return missingTask ? undefined : {id:args[0],title:"Current task",status:"doing",tags:[],updatedAt:"current"};
    if(name==="literatureService.getLiteratureById") return {id:args[0],title:"Current literature",tags:[],updatedAt:"current-lit"};
    throw new Error(`Unexpected read ${name}`);
  };
  return calls;
}
const link=(id,literatureId="lit")=>({id,literatureId,targetType:"task",targetId:"task",relationType:"method_reference",description:"Existing relation",note:"Existing note",confidence:0.8,role:"method_reference",createdAt:"created",updatedAt:"updated"});
test("empty canonical incoming and outgoing links return empty without unused endpoint reads",async()=>{
  const calls=fixture();
  assert.deepEqual(await service.getBackReferenceSummaries("task","task"),[]);
  assert.deepEqual(await service.getLinkedEntitySummaries("literature","lit"),[]);
  assert.equal(calls.filter(x=>x.name==="literatureService.getLinksByTarget").length,1);
  assert.equal(calls.filter(x=>x.name==="literatureService.queryLiteratureLinks").length,1);
  assert.equal(calls.filter(x=>x.name.includes("getTaskById")||x.name.includes("getLiteratureById")).length,0);
});
test("populated incoming links retain order, current endpoint hydration and all link metadata",async()=>{
  const calls=fixture({incoming:[link("a","lit-a"),link("b","lit-b")]});
  const rows=await service.getBackReferenceSummaries("task","task");
  assert.deepEqual(rows.map(x=>x.linkId),["a","b"]);
  assert.equal(calls.filter(x=>x.name==="planningService.getTaskById").length,1);
  for(const row of rows) {
    assert.equal(row.target.title,"Current task");assert.equal(row.target.sourceAvailable,true);
    assert.equal(row.linkSource,"literatureLink");assert.equal(row.relationType,"method_reference");
    assert.equal(row.description,"Existing relation");assert.equal(row.note,"Existing note");
    assert.equal(row.confidence,0.8);assert.equal(row.evidenceRole,"method_reference");
    assert.equal(row.createdAt,"created");assert.equal(row.updatedAt,"updated");
  }
});
test("populated outgoing links and missing targets keep the existing missing-reference projection",async()=>{
  fixture({outgoing:[link("out")],missingTask:true});
  const [row]=await service.getLinkedEntitySummaries("literature","lit");
  assert.equal(row.source.sourceAvailable,true);assert.equal(row.source.title,"Current literature");
  assert.equal(row.target.entityId,"task");assert.equal(row.target.sourceAvailable,false);
  assert.ok(row.target.missingReason);assert.equal(row.linkId,"out");
});
test("canonical link-read and populated endpoint-read failures still reject",async()=>{
  fixture({fail:"literatureService.getLinksByTarget"});
  await assert.rejects(service.getBackReferenceSummaries("task","task"),/CANONICAL_READ_FAILED/);
  fixture({incoming:[link("in")],fail:"planningService.getTaskById"});
  await assert.rejects(service.getBackReferenceSummaries("task","task"),/CANONICAL_READ_FAILED/);
});

test("cross-module context reuses current links for evidence without losing metadata or public freshness",async()=>{
  const calls=fixture({incoming:[link("a","lit-a"),link("b","lit-b")]});
  const context=await service.getEntityCrossModuleContext("task","task");
  assert.equal(context.partial,false);assert.deepEqual(context.missingReferences,[]);
  assert.equal(context.linkedEntities,context.outgoingLinks);assert.equal(context.backReferences,context.incomingLinks);
  assert.deepEqual(context.evidenceSummaries.map(x=>[x.evidenceId,x.evidenceRole,x.confidence]),[["lit-a","method_reference",0.8],["lit-b","method_reference",0.8]]);
  for(const name of ["entityLinkService.queryLinksBySource","entityLinkService.queryLinksByTarget","literatureService.getLinksByTarget"])
    assert.equal(calls.filter(x=>x.name===name).length,1,name);
  assert.deepEqual(await service.getEvidenceSummariesForEntity("task","task"),context.evidenceSummaries);
  assert.equal(calls.filter(x=>x.name==="literatureService.getLinksByTarget").length,2);
  await service.getEntityCrossModuleContext("task","task");
  assert.equal(calls.filter(x=>x.name==="literatureService.getLinksByTarget").length,3);
});

test("cross-module missing owner/endpoint remains partial and evidence preserves unavailable identity",async()=>{
  fixture({incoming:[link("missing")],missingTask:true});
  const context=await service.getEntityCrossModuleContext("task","task");
  assert.equal(context.partial,true);assert.equal(context.entity.sourceAvailable,false);
  assert.ok(context.warnings.length);assert.ok(context.missingReferences.length);
  assert.equal(context.incomingLinks[0].target.sourceAvailable,false);
  assert.equal(context.evidenceSummaries[0].source.entityId,"lit");
});

test("cross-module required link and endpoint failures reject rather than become empty evidence",async()=>{
  for(const fail of ["entityLinkService.queryLinksBySource","entityLinkService.queryLinksByTarget","literatureService.getLinksByTarget","literatureService.getLiteratureById","planningService.getTaskById"]){
    fixture({incoming:[link("in")],fail});
    await assert.rejects(service.getEntityCrossModuleContext("task","task"),/CANONICAL_READ_FAILED/);
  }
});

test("concurrent contexts and subsequent refresh have independent owner facts and promises",async()=>{
  const calls=fixture();
  const [a,b]=await Promise.all([service.getEntityCrossModuleContext("task","a"),service.getEntityCrossModuleContext("task","b")]);
  assert.equal(a.entity.entityId,"a");assert.equal(b.entity.entityId,"b");
  assert.notEqual(a.outgoingLinks,b.outgoingLinks);
  fixture({missingTask:true});const fresh=await service.getEntityCrossModuleContext("task","a");
  assert.equal(fresh.partial,true);assert.equal(fresh.entity.sourceAvailable,false);
  assert.equal(calls.filter(x=>x.name==="entityLinkService.queryLinksBySource").length,2);
});
