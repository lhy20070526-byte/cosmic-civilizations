/** Offline QA only: long-distance communication produced by actual engine actions. */
import {writeFile} from 'node:fs/promises';
import {createRun,save,step} from '../src/server/runtime.js';
import {prepareTick,viewFor,decisionCost,validateDecision} from '../src/engine/index.js';
import {exportArchive,importSnapshot} from '../src/server/snapshot.js';
import {ENGINE_VERSION,SNAPSHOT_VERSION,type Decision} from '../src/shared/types.js';
const run=await createRun({seed:'continuous-main-flow-20261017',civilizationCount:12,segmentTicks:20,mode:'offline'});
for(const [i,c]of run.world.civilizations.entries()){
 c.position={x:8+i%4*27,y:8+Math.floor(i/4)*35};c.recon=95;c.resources=220;
}
const initial=run.world.events.find(e=>e.eventId==='commit-0')!;
for(const c of run.world.civilizations)initial.facts[c.id+'.resources']=c.resources;
run.history[0].world=structuredClone({...run.world,events:[]});
for(const tick of [1,2]){
 const pending={...prepareTick(run.world),stage:'decisions' as const,generation:run.generation,baselineCommitId:run.committedIds.at(-1),engineVersion:ENGINE_VERSION,schemaVersion:SNAPSHOT_VERSION,phaseCursor:'decisions'};
 for(const[i,c]of pending.physicalWorld.civilizations.entries()){
  const view=viewFor(pending.physicalWorld,c.id);
  const action=tick===1?'explore':i===0?'contact':i===3?'broadcast':'wait';
  const contact=c.contacts.find(x=>c.contactMap[x.contactId]==='civ-4');
  const decision:Decision={action,target:action==='contact'?contact?.contactId??null:null,intensity:0,budget:0,message:['contact','broadcast'].includes(action)?{kind:'information',replyTo:null,text:'离线验收：真实长距离传播，流动粒子仅表示在途状态。'}:null,reason:'固定离线决策，用于验证持续信号、暂停冻结和模型多样性。'};
  decision.budget=decisionCost(decision);
  if(!validateDecision(view,decision))throw Error(`Invalid fixture ${tick} ${c.id}`);
  const id=`${run.id}:qa-signal:${tick}:${c.id}`;
  pending.decisions[c.id]={civilizationId:c.id,view,decision,source:'rules',reservedCost:decision.budget,requestId:id};
  run.requestLog.push({id,kind:'decision',civilizationId:c.id,tick,attempts:0,status:'success',source:'rules',result:decision});
 }
 run.pendingTick=pending;await step(run);
}
run.status='paused';run.phase='离线连续信号验收：T2已提交，有真实延迟通信';await save(run);
const archive=exportArchive(run);importSnapshot(archive);
await writeFile('output/main-flow-fixture.json',JSON.stringify(archive));
const info={runId:run.id,tick:run.world.tick,mode:run.config.mode,externalRequests:run.usedRequests,transits:run.world.transits.map(t=>({id:t.id,kind:t.kind,from:t.fromId,to:t.toId,launch:t.launchedAt,arrival:t.arrivesAt})),testOnly:true};
await writeFile('output/main-flow-fixture-info.json',JSON.stringify(info,null,2));console.log(info);
