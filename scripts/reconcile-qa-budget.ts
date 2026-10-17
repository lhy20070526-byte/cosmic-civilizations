// One-off reconciliation of a stale-snapshot regression discovered during QA.
// Does not make model calls or restore missing decision output.
import {readFile,writeFile} from 'node:fs/promises';
const id='16b5e8e4-1b94-4ada-bdc6-9338b83206c9';
const base='http://127.0.0.1:4321/api';
const snapshot=await fetch(`${base}/runs/${id}/export`).then(r=>r.json());
const rows=(await readFile('.local/requests.jsonl','utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.runId===id);
const run=snapshot.engineState;
const missing=rows.filter(x=>!run.requestLog.some((r:any)=>r.id===x.requestId));
for(const row of missing)run.requestLog.push({id:row.requestId,kind:row.kind,tick:row.tick,attempts:row.attempt,status:row.status,source:'llm',durationMs:row.durationMs,error:'验收时旧浏览器快照覆盖了第7轮；仅恢复已付费调用元数据，原响应正文未留存。'});
run.usedRequests=rows.length;
const {checksum}=await import('../src/server/snapshot.js');
const {checksum:old,...payload}=snapshot;snapshot.checksum=checksum(payload);
const response=await fetch(`${base}/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
if(!response.ok)throw new Error(`reconciliation ${response.status}`);
await writeFile('output/qa-recovery-incident.json',JSON.stringify({runId:id,staleSnapshotTick:6,discardedTick:7,actualUsedRequests:rows.length,restoredAuditRecords:missing.length,missingDecisionOutputs:12,resolved:'refresh now loads server state first; API rejects older commits or budget rollback',budgetLimit:500},null,2));
console.log({reconciled:true,usedRequests:rows.length,restoredAuditRecords:missing.length});
