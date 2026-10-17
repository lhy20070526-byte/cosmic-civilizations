import test from 'node:test';
import assert from 'node:assert/strict';
import {busy,createRun,pause,step} from '../src/server/runtime.js';
import type {RunState} from '../src/shared/types.js';

test('pause during post-commit persistence stops without a second click or another tick',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:4,seed:'pause-tail'});
 let status=run.status;
 let pausePromise:Promise<RunState>|undefined;
 let observedPersistenceWindow=false;
 let scheduled=false;
 // Observe the actual commit boundary and send the user action at the next
 // microtask, while the real filesystem save still holds the step lock.
 Object.defineProperty(run,'status',{enumerable:true,configurable:true,get:()=>status,set(next:RunState['status']){
  status=next;
  if(next==='running'&&run.world.tick===1&&!scheduled){
   scheduled=true;
   queueMicrotask(()=>{
    observedPersistenceWindow=busy(run.id)&&run.pendingTick===null;
    pausePromise=pause(run);
   });
  }
 }});
 await step(run);await pausePromise;
 assert.equal(observedPersistenceWindow,true,'test must exercise the locked post-commit window');
 assert.equal(run.status,'paused');
 assert.equal(run.world.tick,1);
 assert.equal(run.pendingTick,null);
 assert.equal(busy(run.id),false);
 assert.equal(run.phase,'已暂停');
 assert.equal(run.committedIds.length,2);
});
