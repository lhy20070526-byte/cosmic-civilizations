/** Explicit offline fixed-decision QA fixture. All events/transits come from the engine. */
import {writeFile} from 'node:fs/promises';
import {createRun,save,runs,step} from '../src/server/runtime.js';
import {prepareTick,viewFor,decisionCost,validateDecision} from '../src/engine/index.js';
import {exportArchive,importSnapshot} from '../src/server/snapshot.js';
import {ENGINE_VERSION,SNAPSHOT_VERSION,type Decision,type ActionType} from '../src/shared/types.js';
const r=await createRun({seed:'QA-alert-actions-20261017',civilizationCount:12,segmentTicks:12,mode:'offline'});
for(const [i,c] of r.world.civilizations.entries()){c.position={x:10+i%4*8,y:10+Math.floor(i/4)*8};c.resources=220;c.recon=80;c.technology=70;}
r.world.sites[0].position={x:18,y:20};
const initial=r.world.events.find(e=>e.eventId==='commit-0')!;for(const c of r.world.civilizations){initial.facts[c.id+'.resources']=c.resources;initial.facts[c.id+'.technology']=c.technology;}
r.history[0].world=structuredClone({...r.world,events:[]});
const prepare=(actions:ActionType[])=>{
const p={...prepareTick(r.world),stage:'decisions' as const,generation:r.generation,baselineCommitId:r.committedIds.at(-1),engineVersion:ENGINE_VERSION,schemaVersion:SNAPSHOT_VERSION,phaseCursor:'decisions'};
for(const [i,c] of p.physicalWorld.civilizations.entries()){
 const view=viewFor(p.physicalWorld,c.id),action=actions[i];
 const wanted=action==='strike'?(i===0?'civ-2':'civ-12'):action==='cooperate'?'civ-6':'civ-5';
 const contact=c.contacts.find(x=>c.contactMap[x.contactId]===wanted)??c.contacts[0];
 const d:Decision={action,target:['strike','contact','cooperate'].includes(action)?contact?.contactId??null:action==='salvage'?c.sites[0]?.siteId??null:null,intensity:action==='wait'?0:0.6,budget:0,message:action==='cooperate'?{kind:'proposal',replyTo:null,text:'固定动作验收：提议有限研究合作。'}:['contact','broadcast'].includes(action)?{kind:'information',replyTo:null,text:'固定动作验收：发送可验证的观测信息。'}:null,reason:'离线固定决策验收，检验真实规则结算对应的动作表现，不代表模型策略。'};
 d.budget=decisionCost(d);if(!validateDecision(view,d))throw new Error('Illegal fixture '+action);
 const id=r.id+':fixed-action:'+p.tick+':'+c.id;
 p.decisions[c.id]={civilizationId:c.id,view,decision:d,source:'rules',reservedCost:d.budget,requestId:id};
 r.requestLog.push({id,kind:'decision',civilizationId:c.id,tick:p.tick,attempts:0,status:'success',source:'rules',result:d});
}
return p;};
r.pendingTick=prepare(Array(12).fill('explore'));await step(r);
const actions:ActionType[]=['strike','defend','broadcast','explore','cooperate','contact','develop','salvage','hide','wait','strike','develop'];
r.pendingTick=prepare(actions);r.status='paused';r.phase='固定动作验收：第2轮已准备，单步后观察真实引擎结算';
await save(r);const archive=exportArchive(r);importSnapshot(archive);
await writeFile('output/alert-action-fixture.json',JSON.stringify(archive));await writeFile('output/alert-action-fixture-info.json',JSON.stringify({runId:r.id,mode:'offline',kind:'fixed-decisions-QA',actions,generatedEvents:'engine only',requests:0},null,2));
console.log({runId:r.id,actions,bytes:JSON.stringify(archive).length});
