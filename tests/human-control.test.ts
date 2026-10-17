import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,defaults,step,pause,resume,cancel,extend,runs,controlHuman,humanTurn,submitHumanDecision} from '../src/server/runtime.js';
import {exportArchive,exportSnapshot,importSnapshot,checksum} from '../src/server/snapshot.js';
import type {Decision} from '../src/shared/types.js';
const wait:Decision={action:'wait',target:null,intensity:0,budget:0,message:null,reason:'Human chooses to wait.'};
const response=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(wait)},finish_reason:'stop'}]}));
process.env.LLM_PROVIDER='deepseek';process.env.LLM_MODEL='test-model';process.env.LLM_API_KEY='test-only-not-a-real-key';

test('long observation defaults and caps preserve old 30-tick snapshots',async()=>{
 assert.equal(defaults().segmentTicks,100);assert.equal(defaults().maxTicks,100);
 const long=await createRun({mode:'offline',civilizationCount:2,segmentTicks:500});assert.equal(long.segmentEnd,500);assert.equal(long.usedRequests,0);
 await assert.rejects(createRun({mode:'offline',segmentTicks:501}));
 const old=await createRun({mode:'offline',civilizationCount:2,segmentTicks:30});delete old.humanCivilizationId;
 assert.equal(importSnapshot(exportArchive(old)).config.segmentTicks,30);
 const completed=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1});await step(completed);
 controlHuman(completed,{civilizationId:'civ-1'});assert.equal(completed.status,'completed');extend(completed,500);assert.equal(completed.segmentEnd,501);await step(completed);assert.equal(humanTurn(completed).waiting,true);assert.equal(completed.world.tick,1);
});

test('human action waits without fabricated wait, uses local frozen view, and commits exactly once',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:3,segmentTicks:3,humanCivilizationId:'civ-1'});await step(r);
 assert.equal(r.world.tick,0);assert.equal(r.status,'paused');assert.equal(Object.keys(r.pendingTick!.decisions).length,2);assert.equal(r.requestLog.filter(q=>q.civilizationId==='civ-1').length,0);
 const t=humanTurn(r);assert.equal(t.waiting,true);assert.equal(t.busy,false);assert.equal(t.view!.tick,1);assert.ok(!('position' in t.view!.self));assert.ok(t.view!.contacts.every(c=>/^contact-\d+$/.test(c.contactId)));assert.ok(!JSON.stringify(t.view).includes('contactMap'));
 const before=checksum(r.pendingTick!.physicalWorld);const ids=r.requestLog.map(q=>q.id);
 await assert.rejects(submitHumanDecision(r,{turnId:t.turnId,decision:{...wait,action:'strike',target:'civ-2',budget:100}}),/校验失败/);
 assert.equal(checksum(r.pendingTick!.physicalWorld),before);assert.deepEqual(r.requestLog.map(q=>q.id),ids);
 await submitHumanDecision(r,{turnId:t.turnId,decision:wait});await submitHumanDecision(r,{turnId:t.turnId,decision:wait});
 assert.equal(r.requestLog.filter(q=>q.source==='human').length,1);assert.equal(r.usedRequests,0);
 await assert.rejects(submitHumanDecision(r,{turnId:t.turnId,decision:{...wait,reason:'Replace'}}),/不能覆盖/);
 resume(r);await step(r);assert.equal(r.world.tick,1);assert.equal(r.history[1].decisions.filter(d=>d.source==='human').length,1);assert.ok(r.world.events.some(e=>e.kind==='decision-applied'&&e.source==='human'));
 await assert.rejects(submitHumanDecision(r,{turnId:t.turnId,decision:wait}),/过期/);
});

test('pending waiting and submitted input survive archive import without repeating successful AI work',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:3,segmentTicks:3,humanCivilizationId:'civ-1'});await step(r);const success=r.requestLog.map(q=>checksum(q));
 const restored=importSnapshot(exportArchive(r));runs.set(restored.id,restored);const t=humanTurn(restored);assert.equal(t.waiting,true);
 await submitHumanDecision(restored,{turnId:t.turnId,decision:wait});const submitted=importSnapshot(exportArchive(restored));runs.set(submitted.id,submitted);
 assert.equal(humanTurn(submitted).submitted,true);controlHuman(submitted,{civilizationId:null});resume(submitted);await step(submitted);
 assert.equal(submitted.world.tick,1);assert.deepEqual(submitted.requestLog.slice(0,success.length).map(q=>checksum(q)),success);assert.equal(submitted.history[1].decisions.find(d=>d.civilizationId==='civ-1')?.source,'human');assert.equal(submitted.usedRequests,0);assert.doesNotThrow(()=>importSnapshot(exportArchive(submitted)));
});

test('pause and cancel invalidate stale forms; control changes never overwrite a saved human decision',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:3,humanCivilizationId:'civ-1'});await step(r);const old=humanTurn(r);await pause(r);
 await assert.rejects(submitHumanDecision(r,{turnId:old.turnId,decision:wait}),/过期/);const current=humanTurn(r);await submitHumanDecision(r,{turnId:current.turnId,decision:wait});const saved=checksum(r.pendingTick!.decisions['civ-1']);
 controlHuman(r,{civilizationId:'civ-2'});assert.equal(checksum(r.pendingTick!.decisions['civ-1']),saved);assert.equal(humanTurn(r).submitted,true);await step(r);assert.equal(r.world.tick,1);
 controlHuman(r,{civilizationId:'civ-1'});await step(r);const stale=humanTurn(r);cancel(r);await assert.rejects(submitHumanDecision(r,{turnId:stale.turnId,decision:wait}),/过期/);
});

test('busy view cannot submit; one paid-equivalent AI success is retained while waiting for the human',async()=>{
 const original=globalThis.fetch;let release!:()=>void;let entered!:()=>void;let calls=0;const gate=new Promise<void>(r=>release=r);const seen=new Promise<void>(r=>entered=r);
 globalThis.fetch=async()=>{calls++;entered();await gate;return response();};
 try{const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:3,humanCivilizationId:'civ-1'});r.config.mode='llm';const active=step(r);await seen;
  assert.equal(humanTurn(r).busy,true);assert.equal(humanTurn(r).waiting,false);assert.throws(()=>controlHuman(r,{civilizationId:null}),/处理中/);await assert.rejects(submitHumanDecision(r,{turnId:humanTurn(r).turnId,decision:wait}),/处理中/);
  release();await active;assert.equal(humanTurn(r).waiting,true);assert.equal(calls,1);assert.equal(r.usedRequests,1);
  await step(r);assert.equal(calls,1);const t=humanTurn(r);await submitHumanDecision(r,{turnId:t.turnId,decision:wait});resume(r);await step(r);assert.equal(calls,1);assert.equal(r.usedRequests,1);assert.equal(r.world.tick,1);
 }finally{globalThis.fetch=original;release?.();}
});

test('a saved successful request without a decision record is restored before newly assigned human control',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:3,humanCivilizationId:'civ-1'});await step(r);const paid=r.pendingTick!.requests['decision:civ-2'];paid.source='llm';paid.attempts=1;r.usedRequests=1;delete r.pendingTick!.decisions['civ-2'];
 controlHuman(r,{civilizationId:'civ-2'});assert.equal(humanTurn(r).submitted,true);assert.equal(humanTurn(r).waiting,false);assert.equal(humanTurn(r).decisionSource,'llm');
 const restored=importSnapshot(exportArchive(r));runs.set(restored.id,restored);await step(restored);assert.equal(restored.world.tick,1);assert.equal(restored.history[1].decisions.find(d=>d.civilizationId==='civ-2')?.source,'llm');assert.equal(restored.usedRequests,1);assert.equal(restored.requestLog.filter(q=>q.civilizationId==='civ-2').length,1);
});

test('snapshot rejects forged human source, charged human requests, and unknown controlled civilization',async()=>{
 const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:2,humanCivilizationId:'civ-1'});await step(r);await submitHumanDecision(r,{turnId:humanTurn(r).turnId,decision:wait});
 for(const edit of [(s:any)=>{s.engineState.humanCivilizationId='civ-999';},(s:any)=>{s.engineState.requestLog.find((q:any)=>q.source==='human').attempts=1;},(s:any)=>{s.engineState.pendingTick.decisions['civ-1'].requestId='missing';}]){const snapshot=exportSnapshot(r);edit(snapshot);const{checksum:_digest,...body}=snapshot;snapshot.checksum=checksum(body);assert.throws(()=>importSnapshot(snapshot),/导入错误/);}
});
