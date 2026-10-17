import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionCost,explainDecision,initWorld,validateDecision,viewFor} from '../src/engine/index.js';
import {createRun,decisionInput,decisionSystem,resume,runs,step,validateModelDecision} from '../src/server/runtime.js';
import {modelJSON,ModelError} from '../src/server/llm.js';
import {exportArchive,importSnapshot} from '../src/server/snapshot.js';
import type {Decision,RequestRecord,VisibleView} from '../src/shared/types.js';

process.env.LLM_PROVIDER='deepseek';process.env.LLM_PROTOCOL='openai-chat';
process.env.LLM_MODEL='test-model';process.env.LLM_API_KEY='test-only-not-a-real-key';
const wire=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const response=(value:unknown)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]}));
const wait:Decision={action:'wait',target:null,intensity:0,budget:0,message:null,reason:'等待更多信息。'};
function visible(resources=30):VisibleView {
 const view=viewFor(initWorld({seed:'decision-guidance',civilizationCount:2,maxTicks:5}),'civ-1');
 view.tick=7;view.self.resources=resources;
 view.contacts=[{contactId:'contact-local',label:'观测对象',estimatedPosition:{x:4,y:5},uncertainty:2,observedAt:6,receivedAt:7,sourceEventId:'seen',estimatedPower:null,status:'unknown'}];
 view.sites=[{siteId:'site-local',position:{x:2,y:3},uncertainty:1,observedAt:6,receivedAt:7,sourceEventId:'site-seen',estimatedResources:20,kind:'resource'}];
 view.proposals=[{proposalId:'proposal-local',contactId:'contact-local',direction:'incoming',expiresAt:9,contribution:6,reward:2,status:'pending'}];
 return view;
}
function request():RequestRecord{return {id:'guidance-mock',tick:7,kind:'decision',attempts:0,status:'pending',source:'llm'};}

test('all offered examples survive JSON transport, current target validation and exact budget boundaries',()=>{
 for(const resources of [0,1.999999999,2,4.999999999,5,7.9888,8,8.999999999,9,13.99999999,14,21.99999999,22,1000.4]){
  const view=visible(resources),before=JSON.stringify(view),input=wire(decisionInput(view));
  assert.ok(input.legalExamples.length>0);
  for(const example of input.legalExamples){
   assert.equal(validateDecision(view,example),true,JSON.stringify({resources,example}));
   assert.equal(example.budget,decisionCost(example));
   assert.ok(example.budget<=resources);
  }
  for(const row of input.affordability)if(row.legal)assert.ok(input.legalExamples.some(d=>d.action===row.action&&(d.message?.kind??null)===row.messageKind));
  assert.equal(JSON.stringify(view),before,'guidance never mutates the frozen view');
 }
 const input=decisionInput(visible(7.9888));
 assert.equal(input.affordability.find(r=>r.action==='develop')?.affordable,false);
 assert.ok(new Set(input.legalExamples.map(d=>d.action)).size>=5,'model has multiple legal actions, not a forced wait');
 assert.match(decisionSystem,/affordable=false.*禁止选择/);
});

test('cooperation principal, rejection and target requirements are separate constraints',()=>{
 const view=visible(8),input=decisionInput(view);
 assert.equal(input.affordability.find(r=>r.messageKind==='proposal')?.affordable,false);
 assert.equal(input.affordability.find(r=>r.messageKind==='accept')?.affordable,false);
 assert.equal(input.affordability.find(r=>r.messageKind==='reject')?.legal,true);
 assert.ok(input.legalExamples.some(d=>d.message?.kind==='reject'&&d.budget===8));
 view.self.resources=100;view.contacts[0].estimatedPosition=null;view.proposals[0].expiresAt=view.tick;
 const constrained=decisionInput(view);
 assert.equal(constrained.affordability.find(r=>r.action==='strike')?.legal,false);
 assert.equal(constrained.affordability.find(r=>r.messageKind==='accept')?.legal,false);
 assert.equal(constrained.affordability.find(r=>r.messageKind==='reject')?.legal,false);
 assert.equal(constrained.affordability.find(r=>r.messageKind==='proposal')?.legal,true);
});

test('belief evidence includes the entire allowed observation window and excludes stale copied beliefs',()=>{
 const view=visible();view.observations=Array.from({length:60},(_,i)=>({sourceEventId:'observed-'+i,occurredTick:5,observedTick:6,kind:'signal',summary:'收到信号'}));
 view.observations.push(view.observations[0]);
 view.beliefs=[{subject:'contact-local',claim:'旧判断',confidence:0.5,updatedTick:1,sourceEventIds:['stale-not-in-window']}];
 const input=decisionInput(view);
 assert.equal(input.observations.length,30);assert.equal(input.allowedBeliefSourceEventIds.length,60);
 assert.ok(input.allowedBeliefSourceEventIds.includes('observed-0'));
 assert.ok(!input.allowedBeliefSourceEventIds.includes('stale-not-in-window'));
 const copied={...wait,beliefUpdates:view.beliefs};
 assert.equal(explainDecision(view,copied).valid,false);
 assert.match(explainDecision(view,copied).errors.join(' '),/allowedBeliefSourceEventIds/);
 assert.equal(validateDecision(view,{...wait,beliefUpdates:[{...view.beliefs[0],updatedTick:view.tick,sourceEventIds:['observed-0']}]}),true);
});

test('diagnostics explain total cost, overspent budget and impossible minimum without throwing on malformed beliefs',()=>{
 const view=visible(7.9888),bad={...wait,action:'develop',intensity:0.1,budget:9};
 const detail=explainDecision(view,bad);
 assert.deepEqual(detail.candidate,{action:'develop',intensity:0.1,budget:9,computedCost:9,resources:7.9888});
 assert.match(detail.errors.join(' '),/no intensity/);
 const excess={...wait,action:'hide',budget:8};
 assert.match(explainDecision(view,excess).errors.join(' '),/budget 8 > resources 7.9888/);
 const cases:unknown[]=[null,[],{},bad,excess,{...wait,budget:'0'},{...wait,intensity:'0'},{...wait,beliefUpdates:[null]},{...wait,beliefUpdates:[{}]},{...wait,beliefUpdates:[{sourceEventIds:1}]},{...wait,message:{kind:'bogus'}},wait];
 for(const value of cases){const result=explainDecision(view,value);assert.equal(result.valid,validateDecision(view,value));if(!result.valid)assert.ok(result.errors.length);}
 assert.throws(()=>validateModelDecision(view,bad),/"resources":7.9888/);
});

test('one repair receives exact rejected numbers; valid model choice is returned unchanged',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:3});
 const view=visible(30),record=request();const chosen={...wait,action:'explore',intensity:0.4,budget:7,reason:'主动改善侦察。'} as Decision;
 let calls=0;
 const result=await modelJSON(run,record,decisionSystem,decisionInput(view),v=>validateModelDecision(view,v),()=>true,async(_url,options)=>{
  const body=JSON.parse(String(options?.body));const payload=JSON.parse(body.messages[1].content);calls++;
  if(calls===1)return response({action:'cooperate',target:'contact-local',intensity:1,budget:16,message:{kind:'proposal',replyTo:null,text:'共同研究'},reason:'研究'});
  assert.match(payload.validationError,/"computedCost":22/);assert.match(payload.validationError,/"budget":16/);assert.match(payload.validationError,/"resources":30/);
  assert.match(payload.repair,/自行重新选择/);
  return response(chosen);
 });
 assert.deepEqual(result,chosen);assert.equal(calls,2);assert.equal(record.attempts,2);assert.equal(run.usedRequests,2);assert.equal(record.source,'llm');
});

test('restored first-attempt errors are included without allocating an extra repair or relaxing cap',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:3});
 run.usedRequests=499;run.config.requestLimit=500;
 const record=request();record.attempts=1;record.status='failed';record.error='budget 8 > resources 7.9888';let calls=0;
 await assert.rejects(modelJSON(run,record,decisionSystem,decisionInput(visible(7.9888)),v=>validateModelDecision(visible(7.9888),v),()=>true,async(_url,options)=>{
  calls++;const payload=JSON.parse(JSON.parse(String(options?.body)).messages[1].content);
  assert.equal(payload.validationError,record.error);return response({...wait,action:'develop',budget:8});
 }),ModelError);
 assert.equal(calls,1);assert.equal(run.usedRequests,500);assert.equal(record.attempts,2);assert.equal(run.config.mode,'offline');
 await assert.rejects(modelJSON(run,request(),decisionSystem,{},v=>v,()=>true,async()=>{throw new Error('must not call');}),/上限/);
});

test('fault recovery retains successful request results before aggregation and never silently replaces model actions',async()=>{
 const oldFetch=globalThis.fetch;let failing=true;const requestedNames:string[]=[];
 globalThis.fetch=async(_url,options)=>{
  const payload=JSON.parse(JSON.parse(String(options?.body)).messages[1].content);requestedNames.push(payload.data.self.name);
  if(failing&&payload.data.self.name==='Second')return response({...wait,action:'develop',intensity:1,budget:8});
  return response(wait);
 };
 try{
  const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:3});
  run.world.civilizations[0].name='First';run.world.civilizations[1].name='Second';run.config.mode='llm';
  await step(run);assert.equal(run.status,'paused');assert.equal(run.world.tick,0);assert.equal(run.usedRequests,3);assert.equal(run.config.mode,'llm');
  assert.equal(run.pendingTick!.requests['decision:civ-1'].status,'success');
  // Simulate recovery after successful-result checkpoint but before p.decisions aggregation.
  delete run.pendingTick!.decisions['civ-1'];
  const restored=importSnapshot(wire(exportArchive(run)));runs.set(restored.id,restored);failing=false;resume(restored);await step(restored);
  assert.equal(restored.world.tick,1);assert.equal(restored.usedRequests,4);assert.equal(requestedNames.filter(n=>n==='First').length,1);
  assert.equal(restored.history[1].decisions.length,2);assert.ok(restored.history[1].decisions.every(d=>d.source==='llm'&&d.decision.action==='wait'));
  assert.equal(restored.config.mode,'llm');
 }finally{globalThis.fetch=oldFetch;}
});

test('cooperation reply repair lists exact incoming pairs, message kind and principal-aware cost',()=>{
 const view=visible(30);
 view.contacts.push({...view.contacts[0],contactId:'contact-other'});
 view.proposals.push({...view.proposals[0],proposalId:'my-outgoing',direction:'outgoing'});
 const input=decisionInput(view);
 const accept=input.affordability.find(r=>r.messageKind==='accept')!;
 assert.deepEqual(accept.replyOptions,[{target:'contact-local',contactId:'contact-local',replyTo:'proposal-local',kind:'accept',intensity:0,cost:14,budget:14,affordable:true}]);
 const bad:Decision={action:'cooperate',target:'contact-other',intensity:1,budget:22,message:{kind:'accept',replyTo:'my-outgoing',text:'接受'},reason:'判断'};
 const details=explainDecision(view,bad);assert.equal(details.valid,false);
 assert.match(details.errors.join(' '),/"replyTo":"proposal-local","contactId":"contact-local","kind":"accept","intensity":0,"cost":14/);
 assert.match(details.errors.join(' '),/outgoing proposals cannot be replied to/);
 assert.ok(!accept.replyOptions?.some(r=>r.replyTo==='my-outgoing'));
 const chosen={...bad,target:'contact-local',message:{...bad.message!,replyTo:'proposal-local'}};
 assert.equal(validateDecision(view,chosen),true);
});
