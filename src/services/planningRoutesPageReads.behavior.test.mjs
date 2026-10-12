import assert from "node:assert/strict";
import test from "node:test";
import {build} from "esbuild";
const bundle=await build({stdin:{contents:'export * from "./planningPageAdapterService";',resolveDir:import.meta.dirname},bundle:true,write:false,format:"esm",platform:"node",target:"es2022",logLevel:"silent",
 plugins:[{name:"canonical-ports",setup(api){api.onResolve({filter:/^\.\/.*Service$/},args=>args.importer.endsWith("planningPageAdapterService.ts")?{path:args.path.slice(2),namespace:"port"}:undefined);
 api.onLoad({filter:/.*/,namespace:"port"},args=>({contents:`export const ${args.path}=new Proxy({}, {get:(_,name)=>(...args)=>globalThis.__routeRead(${JSON.stringify(args.path)}+"."+name,args)});`}));}}]});
const service=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
function fixture({fail,title="Current route",owner="p",missing=false,counts=[2,3,4]}={}){
 const calls=[];globalThis.__routeRead=async(name,args)=>{
  calls.push({name,args});if(name===fail)throw Error("CURRENT_READ_FAILED");
  if(name==="planningService.queryProjects")return[{id:"p",title:"Project",status:"active",priority:"medium"}];
  if(name==="planningService.queryRouteNodes")return[{id:"r",projectId:owner,title,status:"active",nodeType:"work",orderIndex:0}];
  if(name==="planningService.queryTasks")return[];
  if(name==="planningService.getRouteNodeById")return missing?undefined:{id:args[0],projectId:owner};
  if(name==="planningSelectorService.getRouteCheckpointProgressSummaries")return{r:{routeNodeId:"r",total:counts[0],completionRate:50}};
  if(name==="planningSelectorService.getRouteNodeTaskSummaries")return{r:{routeNodeId:"r",total:counts[1]}};
  if(name==="outputGapFeedbackSelectorService.getRouteNodeOutputGapFeedbackSummary")return{outputGaps:Array.from({length:counts[2]},(_,i)=>({outputGapId:`g${i}`}))};
  throw Error(`Unexpected ${name}`);
 };return calls;
}
test("display projection retains current Route facts and checkpoint progress, omits only deletion impacts",async()=>{
 const calls=fixture({fail:"outputGapFeedbackSelectorService.getRouteNodeOutputGapFeedbackSummary"});
 const model=await service.getPlanningRoutesPageDisplayModel();
 assert.equal(model.routeNodes[0].title,"Current route");assert.equal(model.checkpointSummariesByRouteNodeId.r.completionRate,50);
 assert.equal("outputGapSummariesByRouteNodeId" in model,false);assert.equal("taskSummariesByRouteNodeId" in model,false);
 assert.equal(calls.some(c=>/TaskSummaries|OutputGap/.test(c.name)),false);
 fixture({title:"Refreshed route"});assert.equal((await service.getPlanningRoutesPageDisplayModel()).routeNodes[0].title,"Refreshed route");
});
test("existing complete model still reads all impacts and propagates their failures",async()=>{
 const calls=fixture();const model=await service.getPlanningRoutesPageModel();
 assert.equal(model.outputGapSummariesByRouteNodeId.r.length,4);assert.equal(model.taskSummariesByRouteNodeId.r.total,3);
 assert.ok(calls.some(c=>c.name.includes("getRouteNodeTaskSummaries")));
 for(const fail of ["outputGapFeedbackSelectorService.getRouteNodeOutputGapFeedbackSummary","planningSelectorService.getRouteNodeTaskSummaries"]){fixture({fail});await assert.rejects(service.getPlanningRoutesPageModel(),/CURRENT_READ_FAILED/);}
});
test("display does not hide required reads failing",async()=>{
 for(const fail of ["planningService.queryProjects","planningService.queryRouteNodes","planningService.queryTasks","planningSelectorService.getRouteCheckpointProgressSummaries"]){fixture({fail});await assert.rejects(service.getPlanningRoutesPageDisplayModel(),/CURRENT_READ_FAILED/);}
});
test("delete intent freshly reads all three counts and refuses missing or changed Project owner",async()=>{
 const calls=fixture();assert.deepEqual(await service.readRouteDeleteImpactCounts("r","p"),{checkpointCount:2,taskCount:3,gapCount:4});
 assert.equal(calls[0].name,"planningService.getRouteNodeById");
 fixture({counts:[0,1,2]});assert.deepEqual(await service.readRouteDeleteImpactCounts("r","p"),{checkpointCount:0,taskCount:1,gapCount:2});
 for(const options of [{missing:true},{owner:"other"}]){const calls=fixture(options);await assert.rejects(service.readRouteDeleteImpactCounts("r","p"),/owner_unavailable/);assert.equal(calls.length,1);}
});
test("delete impact read failures cannot be treated as zero",async()=>{
 for(const fail of ["planningService.getRouteNodeById","planningSelectorService.getRouteCheckpointProgressSummaries","planningSelectorService.getRouteNodeTaskSummaries","outputGapFeedbackSelectorService.getRouteNodeOutputGapFeedbackSummary"]){fixture({fail});await assert.rejects(service.readRouteDeleteImpactCounts("r","p"),/CURRENT_READ_FAILED/);}
});
