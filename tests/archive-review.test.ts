import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,step,resume,runs} from '../src/server/runtime.js';
import {exportArchive,importSnapshot,checksum} from '../src/server/snapshot.js';
import {encodeArchive,decodeArchive} from '../src/shared/archive.js';
import {assertImportPreservesProgress} from '../src/server/import-guard.js';
import {prepareTick,toDecisionRecord,viewFor} from '../src/engine/index.js';

async function fixture(){return createRun({mode:'offline',civilizationCount:2,segmentTicks:3,seed:'dag-isolation'});}

test('DAG import detaches mutable civilizations and historical frames',async()=>{
 const a=await fixture(),restored=importSnapshot(JSON.parse(JSON.stringify(exportArchive(a))));
 const [c1,c2]=restored.world.civilizations,historical=restored.history[0].world.civilizations[0];
 assert.notStrictEqual(c1.observations,c2.observations);assert.notStrictEqual(c1.contacts,c2.contacts);assert.notStrictEqual(c1.beliefs,c2.beliefs);
 const historyBefore=checksum(restored.history),otherBefore=checksum(c2);
 c1.beliefs.push({subject:'self',claim:'local only',confidence:0.5,updatedTick:0,sourceEventIds:[]});c1.resources--;
 assert.equal(checksum(c2),otherBefore);assert.equal(checksum(restored.history),historyBefore);assert.equal(historical.resources,a.history[0].world.civilizations[0].resources);
});
test('DAG restoration continuation preserves frozen history and deterministic next world',async()=>{
 const a=await fixture();await step(a);const oldHistory=checksum(a.history);
 const b=importSnapshot(JSON.parse(JSON.stringify(exportArchive(a))));runs.set(b.id,b);resume(b);await step(b);
 assert.equal(checksum(b.history.slice(0,-1)),oldHistory);assert.equal(a.world.tick,1);
 runs.set(a.id,a);await step(a);assert.equal(checksum(b.world),checksum(a.world));
});
test('DAG decoder rejects cycles, duplicate object keys, and expansion bombs',()=>{
 assert.throws(()=>decodeArchive({format:'cosmic-dag-v1',root:0,nodes:[['a',[0]]]}));
 assert.throws(()=>decodeArchive({format:'cosmic-dag-v1',root:1,nodes:[['p',1],['o',[['x',0],['x',0]]]]}));
 const nodes:unknown[]=[['p',0]];for(let i=1;i<35;i++)nodes.push(['a',[i-1,i-1]]);
 assert.throws(()=>decodeArchive({format:'cosmic-dag-v1',root:34,nodes}));
 assert.deepEqual(decodeArchive(encodeArchive({a:[1,2],b:[1,2]})),{a:[1,2],b:[1,2]});
});
test('import guard rejects dropping success, fallback, narratives, pending decisions and committed truth',async()=>{
 const a=await fixture();a.requestLog.push({id:'saved-success',kind:'decision',tick:1,attempts:1,status:'success',source:'llm',result:{ok:true}},{id:'saved-fallback',kind:'decision',tick:1,attempts:2,status:'fallback',source:'rules',result:{ok:true}});
 assert.doesNotThrow(()=>assertImportPreservesProgress(a,structuredClone(a),checksum));
 for(const requestId of ['saved-success','saved-fallback']){const b=structuredClone(a);b.requestLog=b.requestLog.filter(r=>r.id!==requestId);assert.throws(()=>assertImportPreservesProgress(a,b,checksum),/已成功及已回退请求/);}
 const changed=structuredClone(a);changed.world.civilizations[0].resources--;assert.throws(()=>assertImportPreservesProgress(a,changed,checksum),/世界状态不一致/);
 const p=prepareTick(a.world),c=p.physicalWorld.civilizations[0];p.decisions[c.id]=toDecisionRecord(c.id,viewFor(p.physicalWorld,c.id),{action:'wait',target:null,intensity:0,budget:0,message:null,reason:'wait'});
 a.pendingTick={...p,stage:'decisions'};const dropped=structuredClone(a);dropped.pendingTick!.decisions={};assert.throws(()=>assertImportPreservesProgress(a,dropped,checksum),/本轮决策/);
 const completed=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1,seed:'guard-narrative'});await step(completed);const omitted=structuredClone(completed);omitted.narratives=[];assert.throws(()=>assertImportPreservesProgress(completed,omitted,checksum),/已生成叙事/);
});

test('DAG pending checkpoint detaches decision maps while relinking saved request identities',async()=>{
 const {ENGINE_VERSION,SNAPSHOT_VERSION}=await import('../src/shared/types.js');
 const r=await fixture(),p=prepareTick(r.world),c=p.physicalWorld.civilizations[0];
 const d={action:'wait' as const,target:null,intensity:0,budget:0,message:null,reason:'saved result'};
 const req={id:'saved-pending-response',kind:'decision' as const,civilizationId:c.id,tick:p.tick,attempts:1,status:'success' as const,source:'llm' as const,result:d};
 r.requestLog.push(req);r.pendingTick={...p,stage:'decisions',baselineCommitId:r.committedIds.at(-1),engineVersion:ENGINE_VERSION,schemaVersion:SNAPSHOT_VERSION};
 r.pendingTick.requests['decision:'+c.id]=req;r.pendingTick.decisions[c.id]={...toDecisionRecord(c.id,viewFor(p.physicalWorld,c.id),d,'llm'),requestId:req.id};
 const restored=importSnapshot(JSON.parse(JSON.stringify(exportArchive(r))));
 assert.strictEqual(restored.pendingTick!.requests['decision:'+c.id],restored.requestLog[0]);
 assert.notStrictEqual(restored.pendingTick!.decisions,restored.pendingTick!.requests);
 const beforeWorld=checksum(restored.world),beforeHistory=checksum(restored.history);
 restored.pendingTick!.physicalWorld.civilizations[0].beliefs.push({subject:'local',claim:'only pending',confidence:0.5,updatedTick:1,sourceEventIds:[]});
 assert.equal(checksum(restored.world),beforeWorld);assert.equal(checksum(restored.history),beforeHistory);assert.equal(restored.pendingTick!.physicalWorld.civilizations[1].beliefs.length,0);
});
