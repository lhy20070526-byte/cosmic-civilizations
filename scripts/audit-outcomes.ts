import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {decodeArchive} from '../src/shared/archive.js';
import {applyDecisions,prepareTick,initWorld,viewFor,offlineDecision,toDecisionRecord,evaluateEnd} from '../src/engine/index.js';
import type {World,Snapshot} from '../src/shared/types.js';
const stats=(w:World)=>({tick:w.tick,alive:w.civilizations.filter(c=>c.alive).length,attacks:w.events.filter(e=>e.kind==='attack-launched').length,damage:w.events.filter(e=>e.kind==='attack-impact').reduce((n,e)=>n+Number(e.facts.damage||0),0),deaths:w.events.filter(e=>e.kind==='civilization-destroyed').length,inFlight:w.transits.length,health:w.civilizations.map(c=>Number(c.health.toFixed(2))),actions:Object.fromEntries([...new Set(w.events.filter(e=>e.kind==='decision-applied').map(e=>String(e.facts.action)))].map(a=>[a,w.events.filter(e=>e.kind==='decision-applied'&&e.facts.action===a).length]))});
const real=decodeArchive<Snapshot>(JSON.parse(await readFile('output/feedback-browser-snapshot.json','utf8')));
const results=[];const start=performance.now();
for(let i=0;i<12;i++){
 const seed=`outcome-audit-${i}`;let world=initWorld({seed,civilizationCount:12,maxTicks:100});const segments=[];
 for(let t=1;t<=100;t++){
  const p=prepareTick(world);const records=p.physicalWorld.civilizations.filter(c=>c.alive).map(c=>{const v=viewFor(p.physicalWorld,c.id);return toDecisionRecord(c.id,v,offlineDecision(v,seed),'rules');});
  world=applyDecisions(p,records);
  if(t===30||t===50||t===100||evaluateEnd(world,100).ended)segments.push(stats(world));
  if(evaluateEnd(world,100).ended)break;
 }
 results.push({seed,segments});console.log(seed,segments.map(s=>({tick:s.tick,alive:s.alive,attacks:s.attacks,deaths:s.deaths})));
}
const result={real:{runId:real.runId,...stats(real.engineState.world)},offline:results,elapsedMs:Math.round(performance.now()-start),note:'12 fixed offline seeds; no model requests, no changed physics, no guarantee of distribution. T100 represents continued observation.'};
await writeFile('output/outcome-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result.real));
