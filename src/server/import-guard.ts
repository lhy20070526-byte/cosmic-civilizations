import type {RunState} from '../shared/types.js';

/** Import may advance a run but must never erase already saved work. */
export function assertImportPreservesProgress(previous:RunState|undefined,incoming:RunState,hash:(value:unknown)=>string):void{
 if(!previous)return;
 const reject=(detail:string):never=>{throw new Error('导入错误：本机已有更新或不同的运行，'+detail+'。请恢复本机运行并使用只读回放。');};
 if(previous.usedRequests>incoming.usedRequests||previous.world.tick>incoming.world.tick)reject('旧快照不能退回轮次或调用额度');
 if(previous.world.tick===incoming.world.tick&&hash(previous.world)!==hash(incoming.world))reject('同一已提交轮次的世界状态不一致');
 if(previous.committedIds.some((id,i)=>incoming.committedIds[i]!==id))reject('不能删除或更改已提交轮次');
 for(const old of previous.requestLog){
  if(old.status!=='success'&&old.status!=='fallback')continue;
  const next=incoming.requestLog.find(r=>r.id===old.id);
  if(!next||hash(next)!==hash(old))reject('不能丢弃或修改已成功及已回退请求');
 }
 for(const old of previous.narratives){
  const next=incoming.narratives.find(n=>n.id===old.id);
  if(!next||hash(next)!==hash(old))reject('不能丢弃或修改已生成叙事');
 }
 if(previous.pendingTick){
  for(const [civId,old]of Object.entries(previous.pendingTick.decisions)){
   const next=incoming.pendingTick?.tick===previous.pendingTick.tick
    ?incoming.pendingTick.decisions[civId]
    :incoming.history.find(h=>h.tick===previous.pendingTick!.tick)?.decisions.find(d=>d.civilizationId===civId);
   if(!next||hash(next)!==hash(old))reject('不能丢弃或修改已保存的本轮决策');
  }
 }
}
