import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,step,extend} from '../src/server/runtime.js';
import {exportSnapshot,importSnapshot} from '../src/server/snapshot.js';
import {factCardsV2,generateNarrative,legacyFactCards} from '../src/server/narrative.js';
import type {RequestRecord,RunState,WorldEvent} from '../src/shared/types.js';

async function completed(seed:string,ticks=1){
 const run=await createRun({mode:'offline',civilizationCount:3,segmentTicks:ticks,seed});
 while(run.world.tick<ticks)await step(run);
 assert.equal(run.status,'completed');return run;
}
function event(run:RunState,id:string,kind:string,causes:string[]=[],damage?:number):WorldEvent {
 return {eventId:id,kind,occurredTick:run.world.tick,source:'engine',participants:[run.world.civilizations[0].id],summary:kind,facts:damage===undefined?{}:{damage},causalEventIds:causes,observations:[]};
}

test('completed stage narrative survives extending and restoring a later completed stage',async()=>{
 const run=await completed('astra-v2-extend-regression',3);
 const first=structuredClone(run.narratives[0]);
 extend(run,3);while(run.world.tick<6)await step(run);
 const recovered=importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(run))));
 assert.equal(recovered.world.tick,6);
 assert.equal(recovered.narratives.length,2);
 assert.deepEqual(recovered.narratives[0],first);
 assert.equal(recovered.usedRequests,0);
});

test('already successful legacy narrative response recovers without another model call',async()=>{
 const run=await completed('astra-legacy-result-regression');
 const cards=legacyFactCards(run);
 const sections=(['universe','civilization','relation','reflection'] as const).map(layer=>{const card=cards.find(c=>c.layer===layer)!;return{layer,factIds:[card.id],text:card.text};});
 const record:RequestRecord={id:'already-successful',kind:'narrative',tick:run.world.tick,attempts:1,status:'success',source:'llm',result:{title:'星海观察纪事',sections,inferences:[]}};
 const before=run.usedRequests;const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=(async()=>{calls++;throw new Error('successful recovery must not request a model');}) as typeof fetch;
 try{const narrative=await generateNarrative(run,record,()=>true);assert.equal(narrative.factVersion,1);assert.equal(narrative.sections.length,4);assert.equal(run.usedRequests,before);assert.equal(calls,0);}finally{globalThis.fetch=originalFetch;}
});

test('environment-only death is not described as universal survival or an attack death',async()=>{
 const run=await completed('astra-environment-facts');const victim=run.world.civilizations[0];victim.alive=false;victim.health=0;
 run.world.events.push(event(run,'audit-environment','environment'),event(run,'audit-impact','attack-impact',['audit-environment'],100),event(run,'audit-death','civilization-destroyed',['audit-impact']));
 const cards=factCardsV2(run);const quiet=cards.find(c=>c.id==='v2-no-conflict')!.text;const ending=cards.find(c=>c.id==='v2-ending')!.text;
 assert.match(quiet,/1 个文明已退出观察/);assert.doesNotMatch(quiet,/所有文明仍存活/);
 assert.match(ending,/环境损伤 100/);assert.doesNotMatch(ending,/实际受伤 0/);
});

test('simultaneous attack and environment loss remains a mixed cause without fabricated allocation',async()=>{
 const run=await completed('astra-mixed-facts');const victim=run.world.civilizations[0];victim.alive=false;victim.health=0;
 run.world.events.push(event(run,'audit-attack','attack-launched'),event(run,'audit-environment','environment'),event(run,'audit-impact','attack-impact',['audit-attack','audit-environment'],100),event(run,'audit-death','civilization-destroyed',['audit-impact']));
 const cards=factCardsV2(run);const conflict=cards.find(c=>c.id==='v2-conflict')!.text;const ending=cards.find(c=>c.id==='v2-ending')!.text;
 assert.match(conflict,/不能单独归因/);assert.match(conflict,/伤害不能按来源拆分/);assert.doesNotMatch(conflict,/1 个文明因攻击退出观察/);
 assert.match(ending,/合计损伤 100，来源不能拆分/);assert.doesNotMatch(ending,/攻击相关损伤 100/);
 const refs=cards.find(c=>c.id==='v2-ending')!.eventIds;
 for(const id of ['audit-attack','audit-environment','audit-impact','audit-death'])assert.ok(refs.includes(id),'ending aggregates must cite their direct evidence: '+id);
});
