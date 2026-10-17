import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,step} from '../src/server/runtime.js';
import {factCardsV2} from '../src/server/narrative.js';

test('one surviving civilization with a scheduled threat retains stage continuation in narrative',async()=>{
 const run=await createRun({mode:'offline',civilizationCount:2,segmentTicks:1,seed:'narrative-pending-threat'});
 await step(run);
 run.world.civilizations[1].alive=false;run.world.civilizations[1].health=0;
 run.world.transits.push({id:'test-threat',kind:'attack',fromId:run.world.civilizations[1].id,toId:run.world.civilizations[0].id,launchedAt:0,arrivesAt:2,payload:{damage:40}});
 const ending=factCardsV2(run).find(c=>c.id==='v2-ending')!;
 assert.match(ending.text,/阶段观察达到轮数上限/);
 assert.match(ending.text,/可延长观察/);
 run.world.transits=[];
 const resolved=factCardsV2(run).find(c=>c.id==='v2-ending')!;
 assert.match(resolved.text,/本轮仅余一个文明/);
 assert.doesNotMatch(resolved.text,/可延长观察/);
});
