import test from 'node:test';
import assert from 'node:assert/strict';
import {modelJSON,ModelError,StaleError} from '../src/server/llm.js';
import {createRun,step,pause,cancel,runs,resume} from '../src/server/runtime.js';
import {exportSnapshot,importSnapshot,checksum} from '../src/server/snapshot.js';
import {factCards,templateNarrative,validateNarrative,factCardsV2} from '../src/server/narrative.js';
const response=(content:string)=>new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}),{status:200});
const record=()=>({id:'test',kind:'decision' as const,tick:1,attempts:0,status:'pending' as const,source:'llm' as const});
const json=(v:unknown)=>{assert.equal((v as any).ok,true);return v;};
process.env.LLM_PROVIDER='deepseek';process.env.LLM_MODEL='test-model';process.env.LLM_API_KEY='test-only-not-a-real-key';
test('schema failure and network retry share one repair; cap strictly counts attempts',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1});let calls=0;const r=record();
 await assert.rejects(modelJSON(run,r,'JSON',{},json,()=>true,async()=>{calls++;return response('{bad');}),ModelError);assert.equal(calls,2);assert.equal(run.usedRequests,2);
 run.config.requestLimit=3;const r2=record();await assert.rejects(modelJSON(run,r2,'JSON',{},json,()=>true,async()=>{calls++;return response('null');}),/上限/);assert.equal(run.usedRequests,3);assert.equal(r2.attempts,1);
});
test('timeout is bounded to two requests and never silently changes mode',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1});run.config.timeoutMs=20;let calls=0;const r=record();
 await assert.rejects(modelJSON(run,r,'JSON',{},json,()=>true,async(_u,options)=>{calls++;await new Promise<void>((_,reject)=>{const timer=setTimeout(()=>reject(new DOMException('timeout','TimeoutError')),21);options?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('timeout','TimeoutError'));});});return response('{}');}),ModelError);assert.equal(calls,2);assert.equal(run.config.mode,'offline');
});
test('late response after cancellation cannot become success',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1});let current=true;const r=record();await assert.rejects(modelJSON(run,r,'JSON',{},json,()=>current,async()=>{current=false;return response('{"ok":true}');}),StaleError);assert.notEqual(r.status,'success');
});
test('real JSON roundtrip checksum, continuation determinism, and invalid imports',async()=>{
 const a=await createRun({mode:'offline',civilizationCount:4,segmentTicks:8,seed:'resume-proof'});await step(a);await step(a);await pause(a);
 const wire=JSON.parse(JSON.stringify(exportSnapshot(a)));const b=importSnapshot(wire);assert.equal(b.status,'paused');
 runs.set(b.id,b);resume(b);while((b.status as string)==='running')await step(b);
 const c=await createRun({mode:'offline',civilizationCount:4,segmentTicks:8,seed:'resume-proof'});while(c.status==='running')await step(c);
 assert.deepEqual(b.world,c.world);assert.deepEqual(b.rngState,c.rngState);assert.equal(b.usedRequests,0);assert.equal(c.usedRequests,0);
 wire.engineState.world.civilizations[0].resources=-1;const {checksum:_c,...body}=wire;wire.checksum=checksum(body);assert.throws(()=>importSnapshot(wire),/负值/);
 const bad=exportSnapshot(c);bad.runId='../escape';bad.engineState.id='../escape';const{checksum:_d,...rest}=bad;bad.checksum=checksum(rest);assert.throws(()=>importSnapshot(bad),/ID/);
});
test('narrative facts and references reject fabricated prose',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1});await step(run);const n=templateNarrative(run);const cards=factCardsV2(run);const raw={title:n.title,sections:n.sections.map(s=>({layer:s.layer,factIds:s.factIds,text:s.text})),inferences:[]};assert.doesNotThrow(()=>validateNarrative(raw,cards));raw.sections[0].text+=' A secret war happened.';assert.throws(()=>validateNarrative(raw,cards));
});
test('explicit automatic fallback preserves successful personas and charges no repeated successes',async()=>{
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>response('not-json');
 try{const run=await createRun({mode:'llm',civilizationCount:2,segmentTicks:1,failurePolicy:'auto-fallback'});await step(run);assert.equal(run.status,'completed');assert.equal(run.config.mode,'mixed');assert.ok(run.requestLog.some(r=>r.status==='fallback'));assert.equal(run.usedRequests,10);assert.equal(run.narratives[0].source,'template');}
 finally{globalThis.fetch=oldFetch;}
});
test('fault checkpoint roundtrip preserves successful requests and physics phase',async()=>{
 const oldFetch=globalThis.fetch;let fail=true;let personas=0,decisions=0;
 globalThis.fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));const sys=body.messages[0].content;
 if(sys.includes('简短人格')){personas++;return response(JSON.stringify({name:'P'+personas,values:['knowledge'],tendencies:['patient']}));}
 if(sys.includes('轨迹叙事'))return response('{}');
 decisions++;if(fail&&JSON.parse(body.messages[1].content).data.self.name==='P2')return response('{}');
 return response(JSON.stringify({action:'wait',target:null,intensity:0,budget:0,message:null,reason:'wait'}));};
 try{const run=await createRun({mode:'llm',civilizationCount:2,segmentTicks:3});await step(run);assert.equal(run.status,'paused');assert.equal(run.world.tick,0);assert.equal(run.pendingTick!.physicalWorld.tick,1);assert.equal(Object.keys(run.pendingTick!.decisions).length,1);assert.equal(personas,2);assert.equal(decisions,3);
 const resumed=importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(run))));runs.set(resumed.id,resumed);fail=false;resume(resumed);await step(resumed);assert.equal(resumed.world.tick,1);assert.equal(personas,2);assert.equal(decisions,4);assert.equal(resumed.usedRequests,6);assert.equal(resumed.history.filter(h=>h.tick===1).length,1);
 }finally{globalThis.fetch=oldFetch;}
});
test('pause during a request completes only current atomic tick; cancelled run cannot commit',async()=>{
 const oldFetch=globalThis.fetch;let release:()=>void=()=>{};let entered:()=>void=()=>{};const seen=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
 globalThis.fetch=async()=>{entered();await gate;return response(JSON.stringify({action:'wait',target:null,intensity:0,budget:0,message:null,reason:'wait'}));};
 try{const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:4});r.config.mode='llm';const active=step(r);await seen;await pause(r);assert.equal(r.world.tick,0);release();await active;assert.equal(r.world.tick,1);assert.equal(r.status,'paused');const tick=r.world.tick;await new Promise(r=>setTimeout(r,25));assert.equal(r.world.tick,tick);
 let release2:()=>void=()=>{};let entered2:()=>void=()=>{};const seen2=new Promise<void>(r=>entered2=r);const gate2=new Promise<void>(r=>release2=r);globalThis.fetch=async()=>{entered2();await gate2;return response(JSON.stringify({action:'wait',target:null,intensity:0,budget:0,message:null,reason:'wait'}));};resume(r);const active2=step(r);await seen2;cancel(r);release2();await active2;assert.equal(r.world.tick,1);assert.equal(r.pendingTick,null);
 }finally{globalThis.fetch=oldFetch;}
});
