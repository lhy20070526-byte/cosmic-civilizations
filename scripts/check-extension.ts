import {createRun,step,extend} from '../src/server/runtime.js';
import {writeFile} from 'node:fs/promises';
const r=await createRun({mode:'offline',civilizationCount:2,segmentTicks:50,seed:'extend-proof'});
while(r.status==='running')await step(r);
if(r.terminalReason!=='阶段结局')throw new Error('fixture ended before observation limit');
extend(r,2);while(r.status==='running')await step(r);
if(r.world.tick!==52)throw new Error('extension did not reach tick 52');
await writeFile('output/extension-52.json',JSON.stringify({status:r.status,tick:r.world.tick,segmentEnd:r.segmentEnd,requests:r.usedRequests,alive:r.world.civilizations.filter(c=>c.alive).length},null,2));
console.log({tick:r.world.tick,status:r.status,requests:r.usedRequests});
