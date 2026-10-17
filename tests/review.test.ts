import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDecisions,decisionCost,initWorld,prepareTick,toDecisionRecord,viewFor} from '../src/engine/index.js';
import {createRun,save,step} from '../src/server/runtime.js';
import {exportSnapshot,importSnapshot} from '../src/server/snapshot.js';
import {modelJSON,setCheckpointWriter,StaleError} from '../src/server/llm.js';
import type {Decision,RequestRecord} from '../src/shared/types.js';

test('review: cooperation must reserve every debit within the declared budget',()=>{
 const w=initWorld({seed:'review-budget',civilizationCount:2});
 w.civilizations[0].position={x:2,y:2};w.civilizations[1].position={x:95,y:95};
 const a=w.civilizations[0],b=w.civilizations[1];
 a.contactMap['contact-review']=b.id;
 a.contacts.push({contactId:'contact-review',label:'unknown',estimatedPosition:{x:93,y:93},uncertainty:5,observedAt:0,receivedAt:0,sourceEventId:w.events[0].eventId,estimatedPower:null,status:'active'});
 const p=prepareTick(w),before=p.physicalWorld.civilizations[0].resources;
 const d:Decision={action:'cooperate',target:'contact-review',intensity:0.5,budget:0,message:{kind:'proposal',replyTo:null,text:'bounded proposal'},reason:'review'};
 d.budget=decisionCost(d);
 const result=applyDecisions(p,[toDecisionRecord(a.id,viewFor(p.physicalWorld,a.id),d)]);
 assert.ok(before-result.civilizations[0].resources<=d.budget,`declared ${d.budget}, debited ${before-result.civilizations[0].resources}`);
});

test('review: import rejects an observation with no authorized event receipt',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:2});
 const e=r.world.events.find(e=>e.kind==='genesis')!;
 assert.equal(e.observations.length,0);
 r.world.civilizations[0].observations.push({sourceEventId:e.eventId,occurredTick:0,observedTick:0,kind:'secret',summary:'A global fact that was never received.'});
 assert.throws(()=>importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(r)))));
});

test('review: import rejects a fabricated narrative even with a recomputed checksum',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1});await step(r);
 r.narratives[0].sections[0].text='A secret empire destroyed all civilizations at tick 999.';
 assert.throws(()=>importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(r)))));
});

test('review: import rejects an invalid event allocator that would corrupt future commits',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:2});
 (r.world as unknown as {nextId:unknown}).nextId='not-a-number';
 assert.throws(()=>importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(r)))));
});

test('review: cancellation during pre-request checkpoint must prevent a paid request',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:2});
 const keys=['LLM_API_KEY','LLM_MODEL','LLM_PROTOCOL'] as const;
 const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.LLM_API_KEY='review-fake-key';process.env.LLM_MODEL='review-fake-model';process.env.LLM_PROTOCOL='openai-chat';
 let current=true,calls=0;
 const record:RequestRecord={id:'review-cancel',kind:'decision',tick:1,attempts:0,status:'pending',source:'llm'};
 setCheckpointWriter(async()=>{current=false;});
 try{
  await assert.rejects(modelJSON(r,record,'JSON',{},x=>x,()=>current,async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));}),StaleError);
  assert.equal(calls,0,'canceled request was still sent after checkpoint wait');
 }finally{setCheckpointWriter(save);for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}}
});
