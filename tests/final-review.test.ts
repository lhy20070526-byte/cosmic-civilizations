import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun} from '../src/server/runtime.js';
import {exportSnapshot,importSnapshot} from '../src/server/snapshot.js';
import {prepareTick,viewFor,validateDecision} from '../src/engine/index.js';

// These are adversarial semantic-import checks, with a fresh valid checksum.
// No external provider is called: every fixture uses offline mode.
async function fixture(){return createRun({mode:'offline',civilizationCount:2,segmentTicks:3,seed:'independent-review'});}

test('final review: negative finite-site supply is rejected on import',async()=>{
 const r=await fixture();r.world.sites[0].resources=-500;
 assert.throws(()=>importSnapshot(exportSnapshot(r)),/导入错误/);
});
test('final review: transit with a nonexistent participant is rejected on import',async()=>{
 const r=await fixture();r.world.transits.push({id:'transit-invalid',kind:'attack',fromId:'nonexistent',toId:r.world.civilizations[0].id,launchedAt:0,arrivesAt:1,payload:{damage:90,launchEventId:'nonexistent-event'}});
 assert.throws(()=>importSnapshot(exportSnapshot(r)),/导入错误/);
});
test('final review: forged local target with initialization as evidence is rejected',async()=>{
 const r=await fixture(),a=r.world.civilizations[0],b=r.world.civilizations[1];
 a.contactMap['contact-forged']=b.id;
 a.contacts.push({contactId:'contact-forged',label:b.name,estimatedPosition:{x:b.position.x-a.position.x,y:b.position.y-a.position.y},uncertainty:0,estimatedPower:b.technology+b.defense,status:'active',observedAt:0,receivedAt:0,sourceEventId:r.world.events[0].eventId});
 assert.throws(()=>importSnapshot(exportSnapshot(r)),/导入错误/);
});
test('final review: reused positive allocator that will duplicate existing event IDs is rejected',async()=>{
 const r=await fixture();r.world.nextId=1;
 assert.throws(()=>importSnapshot(exportSnapshot(r)),/导入错误/);
});
test('final review: cooperation escrow cannot use a nonexistent civilization',async()=>{
 const r=await fixture();r.world.cooperations.push({id:'proposal-invalid',fromId:'missing',toId:r.world.civilizations[0].id,createdAt:0,expiresAt:1,contribution:6,reward:2,status:'pending',escrow:{missing:6}});
 assert.throws(()=>importSnapshot(exportSnapshot(r)),/导入错误/);
});

test('final review: normal offline 12x30 snapshots remain importable at every committed tick',async()=>{
 const {step}=await import('../src/server/runtime.js');
 const r=await createRun({mode:'offline',civilizationCount:12,segmentTicks:30,seed:'compatibility-12x30'});
 while(r.status==='running'){
  await step(r);
  assert.doesNotThrow(()=>importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(r)))),`normal snapshot failed at tick ${r.world.tick}`);
 }
 assert.equal(r.world.tick,30);
});

test('final review: genuine cooperation snapshots roundtrip across proposal acceptance and settlement',async()=>{
 const {applyDecisions,toDecisionRecord,decisionCost}=await import('../src/engine/index.js');
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:10,seed:'cooperation-compatibility'});
 r.world.civilizations[0].position={x:5,y:5};r.world.civilizations[1].position={x:7,y:5};
 r.history[0].world=structuredClone({...r.world,events:[]});
 for(let tick=1;tick<=7;tick++){
  const p=prepareTick(r.world),records=p.physicalWorld.civilizations.map((c,i)=>{
   const view=viewFor(p.physicalWorld,c.id);
   let d:import('../src/shared/types.js').Decision={action:'wait',target:null,intensity:0,budget:0,message:null,reason:'wait'};
   if(tick===1&&i===0)d={action:'cooperate',target:view.contacts[0].contactId,intensity:0.5,budget:18,message:{kind:'proposal',replyTo:null,text:'research'},reason:'propose'};
   if(tick===2&&i===1){const proposal=view.proposals.find(p=>p.direction==='incoming')!;d={action:'cooperate',target:proposal.contactId,intensity:0.5,budget:18,message:{kind:'accept',replyTo:proposal.proposalId,text:'accept'},reason:'accept'};}
   d.budget=decisionCost(d);assert.ok(validateDecision(view,d));return toDecisionRecord(c.id,view,d);
  });
  r.world=applyDecisions(p,records);r.rngState=structuredClone(r.world.rngState);
  r.history.push({tick,world:structuredClone({...r.world,events:[]}),decisions:records,rngState:structuredClone(r.rngState)});
  assert.doesNotThrow(()=>importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(r)))),`cooperation snapshot at tick ${tick}`);
 }
 assert.equal(r.world.cooperations[0].status,'settled');assert.ok(r.world.civilizations.every(c=>c.technology===12));
});

test('final review: an initialization event cannot serve as attack-launch evidence',async()=>{
 const r=await fixture();r.world.transits.push({id:'transit-2',kind:'attack',fromId:r.world.civilizations[0].id,toId:r.world.civilizations[1].id,launchedAt:0,arrivesAt:1,payload:{damage:90,launchEventId:r.world.events[0].eventId}});r.world.nextId=3;
 assert.throws(()=>importSnapshot(exportSnapshot(r)),/导入错误/);
});

test('final review: restoring initial and repeated successful narrative checkpoints does not repay requests',async()=>{
 const {step,narrate,save,runs}=await import('../src/server/runtime.js');
 const {setCheckpointWriter}=await import('../src/server/llm.js');
 const {factCardsV2}=await import('../src/server/narrative.js');
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1,seed:'narrative-success-recovery'});await step(r);r.narratives=[];r.config.mode='llm';
 const cards=factCardsV2(r),result={title:'星海观察纪事',sections:['universe','civilization','relation','reflection'].map(layer=>({layer,factIds:[cards.find(c=>c.layer===layer)!.id]})),inferences:[]};
 const previousFetch=globalThis.fetch,previousEnv={key:process.env.LLM_API_KEY,model:process.env.LLM_MODEL,protocol:process.env.LLM_PROTOCOL};
 let calls=0;let checkpoint:unknown;let targetCount=0;
 process.env.LLM_API_KEY='independent-review-fake-key';process.env.LLM_MODEL='independent-review-fake-model';process.env.LLM_PROTOCOL='openai-chat';
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}]}));};
 setCheckpointWriter(async(run)=>{if(run.requestLog.filter(q=>q.kind==='narrative'&&q.status==='success').length===targetCount+1&&run.narratives.length===targetCount)checkpoint=JSON.parse(JSON.stringify(exportSnapshot(run)));});
 try{
  await narrate(r);assert.ok(checkpoint);assert.equal(calls,1);
  const restored=importSnapshot(checkpoint);runs.set(restored.id,restored);await narrate(restored);
  assert.equal(calls,1,'a successful paid narrative result was present in the checkpoint but was sent again');
  assert.equal(restored.narratives[0].source,'llm');
  targetCount=1;checkpoint=undefined;await narrate(restored);assert.ok(checkpoint);assert.equal(calls,2);
  const restoredAgain=importSnapshot(checkpoint);runs.set(restoredAgain.id,restoredAgain);await narrate(restoredAgain);
  assert.equal(calls,2,'a second successful narrative request must also be recovered without repayment');
  assert.equal(restoredAgain.narratives.length,2);
 }finally{
  globalThis.fetch=previousFetch;setCheckpointWriter(save);
  for(const [k,v]of [['LLM_API_KEY',previousEnv.key],['LLM_MODEL',previousEnv.model],['LLM_PROTOCOL',previousEnv.protocol]] as const){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
