import {writeFile,readFile} from 'node:fs/promises';
import {decodeArchive} from '../src/shared/archive.js';
import type {RunState} from '../src/shared/types.js';
const id='16b5e8e4-1b94-4ada-bdc6-9338b83206c9';
const r=decodeArchive<RunState>(await fetch(`http://127.0.0.1:4321/api/runs/${id}`).then(r=>r.json()));
const rows=(await readFile('.local/requests.jsonl','utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.runId===id);
const decisions=r.history.flatMap(h=>h.decisions);
const evidence={recordedAt:new Date().toISOString(),runId:id,provider:r.llmParameters.provider,model:r.llmParameters.model,seed:r.config.seed,civilizations:r.config.civilizationCount,tick:r.world.tick,limit:r.segmentEnd,status:r.status,mode:r.config.mode,usedRequests:r.usedRequests,auditActualAttempts:rows.length,requestLimit:r.config.requestLimit,successfulAttempts:rows.filter(x=>x.status==='success').length,failedAttempts:rows.filter(x=>x.status==='failed').length,decisionSources:decisions.reduce((out,d)=>({...out,[d.source]:(out[d.source]||0)+1}),{} as Record<string,number>),fallbacks:r.requestLog.filter(x=>x.status==='fallback').length,narratives:r.narratives.map(n=>({source:n.source,toTick:n.toTick,sections:n.sections.length,eventRefsValid:n.sections.every(s=>s.eventIds.every(id=>r.world.events.some(e=>e.eventId===id)))})),alive:r.world.civilizations.filter(c=>c.alive).length,inFlight:r.world.transits.length,events:r.world.events.length,terminalReason:r.terminalReason,error:r.error,narrativeError:r.narrativeError,qaIncident:'output/qa-recovery-incident.json'};
await writeFile('output/real-default-validation.json',JSON.stringify(evidence,null,2));console.log(evidence);
