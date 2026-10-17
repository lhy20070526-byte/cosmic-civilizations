import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRun,step,pause,resume,runs,extend} from '../src/server/runtime.js';
import {exportArchive,importSnapshot,checksum} from '../src/server/snapshot.js';
import type {RunState} from '../src/shared/types.js';
const start=performance.now();let peakHeapBytes=0;
const sample=()=>{peakHeapBytes=Math.max(peakHeapBytes,process.memoryUsage().heapUsed);};
let a:RunState|null=await createRun({mode:'offline',civilizationCount:50,segmentTicks:50,seed:'stress-50x50'});
for(let i=0;i<25;i++){await step(a);sample();if((i+1)%5===0)console.log(`halfway tick ${i+1}, heap ${Math.round(process.memoryUsage().heapUsed/1048576)} MiB`);}
await pause(a);const before=a.usedRequests;
// Only the serialized checkpoint survives the handoff; keep no second expanded run.
let wire=JSON.stringify(exportArchive(a));const checkpointId=a.id;runs.delete(checkpointId);a=null;
a=importSnapshot(JSON.parse(wire));wire='';runs.set(a.id,a);resume(a);
while(a.status==='running'){await step(a);sample();if(a.world.tick%5===0)console.log(`continued tick ${a.world.tick}, heap ${Math.round(process.memoryUsage().heapUsed/1048576)} MiB`);}
wire=JSON.stringify(exportArchive(a));const snapshotBytes=Buffer.byteLength(wire);
let restored:RunState|null=importSnapshot(JSON.parse(wire));wire='';sample();assert.equal(checksum(restored.world),checksum(a.world));assert.equal(restored.usedRequests,before);assert.equal(a.world.tick,50);assert.equal(a.usedRequests,0);
const restoredStatus=restored.status;restored=null;
const expectedWorld=a.world,expectedRng=a.rngState,firstId=a.id;const duration=performance.now()-start;runs.delete(firstId);a=null;
// Reference run retains only the first run's final physical world, not its history.
const b=await createRun({mode:'offline',civilizationCount:50,segmentTicks:50,seed:'stress-50x50'});
while(b.status==='running'){await step(b);sample();if(b.world.tick%10===0)console.log(`reference tick ${b.world.tick}`);}
assert.equal(checksum(expectedWorld),checksum(b.world));assert.deepEqual(expectedRng,b.rngState);
const base=await createRun({mode:'offline',civilizationCount:2,segmentTicks:2,seed:'extend-proof'});while(base.status==='running')await step(base);extend(base,50);const ext=importSnapshot(JSON.parse(JSON.stringify(exportArchive(base))));assert.equal(ext.segmentEnd,52);
await mkdir('output',{recursive:true});
const result={status:'passed',archiveFormat:'cosmic-dag-v1',peakHeapBytes,tick:b.world.tick,civilizations:50,events:b.world.events.length,snapshotBytes,elapsedMs:Math.round(duration),comparisonTotalMs:Math.round(performance.now()-start),continuationEquivalent:true,prngEquivalent:true,restoredStatus,requests:b.usedRequests,worldChecksum:checksum(b.world),extensionBeyond50:ext.segmentEnd};
await writeFile('output/stress-50x50.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
