import {writeFile} from 'node:fs/promises';
import {decodeArchive,isArchive} from '../src/shared/archive.js';
import type {RunState,HumanTurn} from '../src/shared/types.js';
const base='http://127.0.0.1:4321';
async function api<T>(path:string,body?:unknown):Promise<T>{const r=await fetch(base+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error??`HTTP ${r.status}`);return (isArchive(data)?decodeArchive(data):data) as T;}
let run=await api<RunState>('/api/runs',{seed:'human-real-smoke-20261017',civilizationCount:2,segmentTicks:1,mode:'llm',humanCivilizationId:'civ-1',requestLimit:20});
run=await api<RunState>(`/api/runs/${run.id}/step`,{});
const turn=await api<HumanTurn>(`/api/runs/${run.id}/human`);
if(!turn.waiting||!turn.turnId||run.error)throw new Error('Real setup did not reach human turn; inspect saved run '+run.id);
run=await api<RunState>(`/api/runs/${run.id}/human`,{turnId:turn.turnId,decision:{action:'wait',target:null,intensity:0,budget:0,message:null,reason:'本轮由用户指令接口选择观望，保留资源。'}});
run=await api<RunState>(`/api/runs/${run.id}/step`,{});
if(run.status!=='completed'||run.narratives.at(-1)?.source!=='llm')throw new Error('Real mixed-control narrative incomplete: '+run.id);
const records=run.history.at(-1)!.decisions;
if(records.find(d=>d.civilizationId==='civ-1')?.source!=='human'||records.find(d=>d.civilizationId==='civ-2')?.source!=='llm')throw new Error('Decision source mismatch');
const snapshot=await (await fetch(`${base}/api/runs/${run.id}/export`)).json();
await writeFile('output/human-real-snapshot.json',JSON.stringify(snapshot));
await writeFile('output/human-real-validation.json',JSON.stringify({runId:run.id,tick:run.world.tick,status:run.status,provider:run.llmParameters.provider,model:run.llmParameters.model,usedRequests:run.usedRequests,requestLimit:run.config.requestLimit,requests:run.requestLog.map(({id,kind,civilizationId,tick,attempts,status,source})=>({id,kind,civilizationId,tick,attempts,status,source})),decisionSources:records.map(d=>({civilization:d.civilizationId,source:d.source,action:d.decision.action})),narrativeSource:run.narratives.at(-1)?.source},null,2));
console.log('Human + real LLM decisions and narrative verified: '+run.id+' requests='+run.usedRequests);
