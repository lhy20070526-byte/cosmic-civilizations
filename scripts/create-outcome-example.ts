/** A genuine extended offline run. No forced decisions, damage or outcome. */
import {writeFile} from 'node:fs/promises';
import {createRun,step,extend} from '../src/server/runtime.js';
import {exportArchive,importSnapshot} from '../src/server/snapshot.js';
const run=await createRun({mode:'offline',seed:'outcome-audit-0',civilizationCount:12,segmentTicks:50});
while(run.status==='running')await step(run);
if(run.terminalReason==='阶段结局')extend(run,50);
while(run.status==='running')await step(run);
const archive=exportArchive(run);importSnapshot(archive);
await writeFile('output/outcome-example-snapshot.json',JSON.stringify(archive));
const summary={id:run.id,mode:run.config.mode,tick:run.world.tick,alive:run.world.civilizations.filter(c=>c.alive).length,externalRequests:run.usedRequests,narratives:run.narratives.map(n=>({toTick:n.toTick,source:n.source,factVersion:n.factVersion})),deaths:run.world.events.filter(e=>e.kind==='civilization-destroyed').map(e=>({eventId:e.eventId,tick:e.occurredTick,participants:e.participants,causes:e.causalEventIds})),note:'Actual deterministic offline policy, continued observation; not a model outcome, not a forced conflict demonstration.'};
await writeFile('output/outcome-example.json',JSON.stringify(summary,null,2));console.log(summary);
