import {decodeArchive} from '../src/shared/archive.js';
import {writeFile} from 'node:fs/promises';
import type {RunState} from '../src/shared/types.js';
const id='877d1071-faaf-462c-a0ad-f319ec0431e8';
const r=decodeArchive<RunState>(await fetch(`http://127.0.0.1:4321/api/runs/${id}`).then(x=>x.json()));
const report={runId:id,seed:r.config.seed,civilizations:r.config.civilizationCount,end:r.segmentEnd,tick:r.world.tick,used:r.usedRequests,budget:r.config.requestLimit,policy:r.config.failurePolicy,status:r.status,failedRequests:r.requestLog.filter(q=>q.status==='failed').map(({id,tick,error,attempts})=>({id,tick,error,attempts})),pendingSuccessfulIds:Object.values(r.pendingTick?.requests??{}).filter(q=>q.status==='success').map(q=>q.id),pendingDecisionIds:Object.keys(r.pendingTick?.decisions??{})};
await writeFile('output/current-run-before-fix.json',JSON.stringify(report,null,2));console.log(report);
