import test from 'node:test';
import assert from 'node:assert/strict';
import {cancel,createRun,extend,pause,step} from '../src/server/runtime.js';
import {checksum,exportSnapshot,importSnapshot} from '../src/server/snapshot.js';

test('browser cancellation preserves a completed world while invalidating late responses',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1,seed:'completed-cancel-regression'});
 await step(run);
 assert.equal(run.status,'completed');
 const generation=run.generation;
 const evidence=()=>checksum({world:run.world,history:run.history,narratives:run.narratives,requestLog:run.requestLog,usedRequests:run.usedRequests,terminalReason:run.terminalReason,committedIds:run.committedIds});
 const before=evidence();
 cancel(run);
 assert.equal(run.generation,generation+1,'late narrative work must become stale');
 assert.equal(run.status,'completed');
 assert.match(run.phase,/推演已完成/);
 await pause(run);
 await step(run);
 assert.equal(run.status,'completed');
 assert.equal(run.world.tick,1,'cancel, pause and step must not start a new terminal tick');
 assert.equal(evidence(),before,'completed evidence and request budget must be unchanged');
 assert.equal(importSnapshot(exportSnapshot(run)).status,'completed');
 extend(run,2);
 await step(run);
 assert.equal(run.world.tick,2);
 assert.equal(run.status,'running','a completed cancellation must not pause the newly extended stage');
});

test('cancelling an unfinished world still pauses it without fabricating completion',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:3,seed:'unfinished-cancel-regression'});
 const generation=run.generation;
 cancel(run);
 assert.equal(run.status,'paused');
 assert.equal(run.generation,generation+1);
 assert.equal(run.world.tick,0);
 assert.equal(run.pendingTick,null);
 assert.equal(run.terminalReason,undefined);
});
