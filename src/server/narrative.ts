import {z} from 'zod';
import type {FactCard,Narrative,RunState,RequestRecord} from '../shared/types.js';
import {modelJSON,ModelError,safeError} from './llm.js';
import {evaluateEnd} from '../engine/index.js';
/** Version 1 cards are kept byte-for-byte compatible with existing snapshots. */
export function legacyFactCards(run:RunState):FactCard[]{
 const events=run.world.events;
 if(!events.length)throw new Error('No evidence events');
 const first=events[0],last=events.at(-1)!;
 const cards:FactCard[]=[{id:'overview',eventIds:[first.eventId,last.eventId],layer:'universe',text:`观察区间为第 0–${run.world.tick} 轮。已记录 ${events.length} 条世界事件。`},
 {id:'ending',eventIds:[last.eventId],layer:'reflection',text:`截至第 ${run.world.tick} 轮，${run.world.civilizations.filter(c=>c.alive).length} 个文明存活，${run.world.transits.length} 个行动仍在途。${run.terminalReason||'观察仍可继续'}。`}];
 for(const c of run.world.civilizations){
  const refs=events.filter(e=>e.participants.includes(c.id));const initial=run.history[0]?.world.civilizations.find(x=>x.id===c.id);const actionEvents=refs.filter(e=>e.kind==='decision-applied');
  cards.push({id:'civ-'+c.id,eventIds:[...new Set([events.find(e=>e.eventId==='commit-0')?.eventId||first.eventId,(refs.at(-1)||first).eventId,...actionEvents.map(e=>e.eventId)])],layer:'civilization',text:`${c.name}：从健康 ${initial?.health??100}、技术 ${initial?.technology??10} 起步，累计记录 ${actionEvents.length} 次主行动；截至观察截止时${c.alive?'存活':'已灭亡'}，健康 ${Number(c.health.toFixed(2))}，资源 ${Number(c.resources.toFixed(2))}，技术 ${Number(c.technology.toFixed(2))}。`});
 }
 const significant=events.filter(e=>!/^(decision|income|develop|wait|explore|defend|hide)$/.test(e.kind));
 const selected=significant.length>60?significant.filter((_,i)=>i%Math.ceil(significant.length/60)===0).slice(-60):significant;
 for(const e of selected)cards.push({id:e.eventId,eventIds:[e.eventId],layer:'relation',text:`第 ${e.occurredTick} 轮：${e.summary}`});
 if(!cards.some(c=>c.layer==='relation'))cards.push({id:'quiet',eventIds:[first.eventId,last.eventId],layer:'relation',text:'所选关键事件中未记录关系转折；这段观察仍有完整的行动与状态记录。'});
 return cards;
}
export const factCards = legacyFactCards;

const actionLabels: Record<string,string> = {
 develop:'发展', explore:'探索', hide:'隐匿', defend:'防御', contact:'联络', broadcast:'广播',
 cooperate:'合作', strike:'攻击', salvage:'回收', wait:'等待',
};
const roundText = (from:number,to:number) => from === to ? `第 ${from} 轮` : `第 ${from}—${to} 轮`;
const fixed = (value:number) => Number(Number.isFinite(value) ? value.toFixed(1) : 0);
const unique = (ids:string[]) => [...new Set(ids)];
const endingLabel = (run:RunState, _aliveCount:number) => {
 const end=evaluateEnd(run.world,run.segmentEnd);
 return end.reason==='all-dead'?'所有文明已灭亡':end.reason==='last-civilization'?'本轮仅余一个文明':end.reason==='limit'?'阶段观察达到轮数上限':'当前观察可继续';
};
const eventIdsFor = (events:RunState['world']['events'], predicate:(event:RunState['world']['events'][number])=>boolean) => events.filter(predicate).map(event=>event.eventId);
function hasCausalKind(event:RunState['world']['events'][number], kind:string, byId:Map<string,RunState['world']['events'][number]>, seen=new Set<string>()):boolean {
 if(event.kind===kind)return true;
 if(seen.has(event.eventId))return false;
 seen.add(event.eventId);
 return event.causalEventIds.some(id=>{const parent=byId.get(id);return parent?hasCausalKind(parent,kind,byId,seen):false;});
}

type DecisionAtTick = { tick:number; record:RunState['history'][number]['decisions'][number]; frame:RunState['history'][number] };
type TransitEvidence = { id:string; kind:RunState['world']['transits'][number]['kind']; fromId:string; toId:string; launchedAt:number; arrivesAt:number; launchEventId?:string; proposalId?:string };

function decisionRecords(run:RunState):DecisionAtTick[] {
 return run.history.flatMap(frame=>frame.decisions.map(record=>({tick:frame.tick,record,frame})));
}

function historicalTransits(run:RunState):TransitEvidence[] {
 const all=[...run.history.flatMap(frame=>frame.world.transits),...run.world.transits];
 const seen=new Set<string>();
 return all.filter(transit=>{if(seen.has(transit.id))return false;seen.add(transit.id);return true;}).map(transit=>({
  id:transit.id,kind:transit.kind,fromId:transit.fromId,toId:transit.toId,launchedAt:transit.launchedAt,arrivesAt:transit.arrivesAt,
  ...(transit.payload.launchEventId?{launchEventId:transit.payload.launchEventId}:{}),
  ...(transit.payload.proposalId?{proposalId:transit.payload.proposalId}:{}),
 }));
}

function civName(run:RunState,id:string|undefined):string {
 return run.world.civilizations.find(civ=>civ.id===id)?.name ?? id ?? '未知文明';
}

function targetIdAt(frame:RunState['history'][number],civilizationId:string,target:string|null):string|undefined {
 if(!target)return undefined;
 return frame.world.civilizations.find(civ=>civ.id===civilizationId)?.contactMap[target];
}

function decisionEvent(run:RunState,item:DecisionAtTick):RunState['world']['events'][number]|undefined {
 return run.world.events.find(event=>event.kind==='decision-applied'&&event.occurredTick===item.tick&&event.participants.includes(item.record.civilizationId)&&event.facts.action===item.record.decision.action);
}

function cooperationRecords(run:RunState) {
 const byId=new Map<string,RunState['world']['cooperations'][number]>();
 for(const frame of run.history)for(const cooperation of frame.world.cooperations)if(!byId.has(cooperation.id))byId.set(cooperation.id,structuredClone(cooperation));
 for(const cooperation of run.world.cooperations)byId.set(cooperation.id,structuredClone(cooperation));
 return [...byId.values()];
}

/** Version 2 cards are Chinese observer facts with explicit intervals and bounded evidence. */
export function factCardsV2(run:RunState):FactCard[]{
 const events=run.world.events;
 if(!events.length)throw new Error('No evidence events');
 const firstTick=0,lastTick=run.world.tick;
 const firstEvent=events[0].eventId,lastEvent=events.at(-1)!.eventId;
 const cards:FactCard[]=[];
 const add=(card:FactCard)=>cards.push({...card,fromTick:card.fromTick??firstTick,toTick:card.toTick??lastTick,eventIds:unique(card.eventIds.length?card.eventIds:[firstEvent,lastEvent])});
 const alive=run.world.civilizations.filter(civ=>civ.alive);
 const eventById=new Map(events.map(event=>[event.eventId,event]));
 const attackLaunches=events.filter(event=>event.kind==='attack-launched');
 const allImpactEvents=events.filter(event=>event.kind==='attack-impact');
 const attackImpacts=allImpactEvents.filter(event=>hasCausalKind(event,'attack-launched',eventById)&&!hasCausalKind(event,'environment',eventById));
 const environmentImpacts=allImpactEvents.filter(event=>hasCausalKind(event,'environment',eventById)&&!hasCausalKind(event,'attack-launched',eventById));
 const mixedImpacts=allImpactEvents.filter(event=>hasCausalKind(event,'environment',eventById)&&hasCausalKind(event,'attack-launched',eventById));
 const allDestroyed=events.filter(event=>event.kind==='civilization-destroyed');
 const destroyed=allDestroyed.filter(event=>hasCausalKind(event,'attack-launched',eventById)&&!hasCausalKind(event,'environment',eventById));
 const environmentDestroyed=allDestroyed.filter(event=>hasCausalKind(event,'environment',eventById)&&!hasCausalKind(event,'attack-launched',eventById));
 const mixedDestroyed=allDestroyed.filter(event=>hasCausalKind(event,'environment',eventById)&&hasCausalKind(event,'attack-launched',eventById));
 const environment=events.filter(event=>event.kind==='environment');
 const decisions=decisionRecords(run);
 const actionEvents=events.filter(event=>event.kind==='decision-applied');
 const actionCounts=Object.fromEntries(Object.keys(actionLabels).map(action=>[action,actionEvents.filter(event=>event.facts.action===action).length])) as Record<string,number>;

 add({id:'v2-overview',layer:'universe',eventIds:[firstEvent,lastEvent],text:`${roundText(firstTick,lastTick)}，观察跨越 ${lastTick} 轮，记录 ${events.length} 条引擎事件和 ${actionEvents.length} 次已提交主行动。文明的行动、往来与结算都只按已发生事件整理。`});
 add({id:'v2-pace',layer:'universe',eventIds:events.filter(event=>event.kind==='commit'||event.kind==='genesis').slice(0,80).map(event=>event.eventId),text:`从第 0 轮到第 ${lastTick} 轮，阶段提交记录保持连续；本阶段的结局叙事以第 ${lastTick} 轮为截止，不把仍在途的任务写成已经完成。`});

 for(const civ of run.world.civilizations){
  const ownActions=actionEvents.filter(event=>event.participants.includes(civ.id));
  const counts=Object.entries(actionLabels).map(([action,label])=>[label,ownActions.filter(event=>event.facts.action===action).length] as const).filter(([,count])=>count>0);
  const actionSummary=counts.length?counts.map(([label,count])=>`${label} ${count} 次`).join('、'):'没有已提交主行动';
  const refs=unique([events.find(event=>event.kind==='genesis')?.eventId??firstEvent,...ownActions.map(event=>event.eventId),lastEvent]);
  add({id:`v2-civ-${civ.id}`,layer:'civilization',eventIds:refs,text:`${roundText(firstTick,lastTick)}，${civ.name}已提交 ${ownActions.length} 次主行动（${actionSummary}）；截至第 ${lastTick} 轮${civ.alive?'仍存活':'已退出观察'}，健康 ${fixed(civ.health)}，储备 ${fixed(civ.resources)}，研究 ${fixed(civ.technology)}。这些是行为与状态记录，不推断它的动机。`});
 }

 const transits=historicalTransits(run);
 const pairGroups=new Map<string,{fromId:string;toId:string;contact:number;proposal:number;accepted:number;rejected:number;broadcast:number;ticks:number[];eventIds:string[]}>();
 const group=(fromId:string,toId:string)=>{const key=`${fromId}->${toId}`;let value=pairGroups.get(key);if(!value){value={fromId,toId,contact:0,proposal:0,accepted:0,rejected:0,broadcast:0,ticks:[],eventIds:[]};pairGroups.set(key,value);}return value;};
 for(const item of decisions){
  const action=item.record.decision.action;
  if(!['contact','cooperate'].includes(action)||!item.record.decision.target)continue;
  const targetId=targetIdAt(item.frame,item.record.civilizationId,item.record.decision.target);if(!targetId)continue;
  const pair=group(item.record.civilizationId,targetId);pair.ticks.push(item.tick);const event=decisionEvent(run,item);if(event)pair.eventIds.push(event.eventId);
  if(action==='contact')pair.contact+=1;
  else if(item.record.decision.message?.kind==='proposal')pair.proposal+=1;
  else if(item.record.decision.message?.kind==='accept')pair.accepted+=1;
  else if(item.record.decision.message?.kind==='reject')pair.rejected+=1;
 }
 for(const item of transits){
  if(item.kind!=='broadcast')continue;
  const pair=group(item.fromId,item.toId);pair.broadcast+=1;pair.ticks.push(item.launchedAt);
  const source=item.launchEventId?eventById.get(item.launchEventId):events.find(event=>event.kind==='decision-applied'&&event.occurredTick===item.launchedAt&&event.participants.includes(item.fromId)&&event.facts.action==='broadcast');
  if(source)pair.eventIds.push(source.eventId);
 }
 const allCooperations=cooperationRecords(run);
 const cooperationByPair=new Map<string,ReturnType<typeof cooperationRecords>>();
 for(const cooperation of allCooperations){const key=`${cooperation.fromId}->${cooperation.toId}`;const list=cooperationByPair.get(key)??[];list.push(cooperation);cooperationByPair.set(key,list);const pair=group(cooperation.fromId,cooperation.toId);pair.ticks.push(cooperation.createdAt);if(cooperation.acceptedAt!==undefined)pair.ticks.push(cooperation.acceptedAt);}
 const resultEvents=events.filter(event=>event.kind==='cooperation-result-dispatched');
 for(const event of resultEvents){const proposalId=typeof event.facts.proposalId==='string'?event.facts.proposalId:undefined;const cooperation=proposalId?allCooperations.find(item=>item.id===proposalId):undefined;if(cooperation){const pair=group(cooperation.fromId,cooperation.toId);pair.eventIds.push(event.eventId);pair.ticks.push(event.occurredTick);}}
 for(const pair of pairGroups.values()){
  const coops=cooperationByPair.get(`${pair.fromId}->${pair.toId}`)??[];
  if(pair.contact===0&&pair.proposal===0&&pair.accepted===0&&pair.rejected===0&&pair.broadcast===0&&coops.length===0)continue;
  const statuses={settled:coops.filter(item=>item.status==='settled').length,rejected:coops.filter(item=>item.status==='rejected').length,pending:coops.filter(item=>item.status==='pending').length,accepted:coops.filter(item=>item.status==='accepted').length,expired:coops.filter(item=>item.status==='expired').length};
  const pairResultEvents=resultEvents.filter(event=>{const proposalId=typeof event.facts.proposalId==='string'?event.facts.proposalId:undefined;return proposalId!==undefined&&coops.some(item=>item.id===proposalId);});
  const receivedResults=pairResultEvents.filter(event=>event.observations.some(observation=>observation.summary.startsWith('Research result received:'))).length;
  const details:string[]=[];
  const subject=`${civName(run,pair.fromId)}→${civName(run,pair.toId)}`;
  if(pair.contact)details.push(`${subject}发出 ${pair.contact} 次联络`);
  if(pair.broadcast)details.push(`${subject}转发广播 ${pair.broadcast} 次`);
  if(pair.proposal)details.push(`${subject}提出合作提案 ${pair.proposal} 次`);
  if(pair.accepted)details.push(`${subject}同意收到的提案 ${pair.accepted} 次`);
  if(pair.rejected)details.push(`${subject}拒绝收到的提案 ${pair.rejected} 次`);
  if(coops.length)details.push(`${subject}的合作记录中已结算 ${statuses.settled} 次、被拒绝 ${statuses.rejected} 次、仍待处理 ${statuses.pending} 次${statuses.accepted?`、已同意待结算 ${statuses.accepted} 次`:''}${statuses.expired?`、到期 ${statuses.expired} 次`:''}`);
  if(pairResultEvents.length)details.push(`${subject}的合作结果已发出 ${pairResultEvents.length} 次${receivedResults?`，其中 ${receivedResults} 次有接收记录`:''}`);
  const ticks=pair.ticks.length?pair.ticks:[firstTick];
  add({id:`v2-relation-${pair.fromId}-${pair.toId}`,layer:'relation',fromTick:Math.min(...ticks),toTick:Math.min(lastTick,Math.max(...ticks)),eventIds:unique(pair.eventIds),text:`${roundText(Math.min(...ticks),Math.min(lastTick,Math.max(...ticks)))}，${details.join('；')}。记录只说明发出、收到、同意、拒绝和结算状态，不把未抵达信号写成已达成结果。`});
 }

 const attackRefs=unique([...attackLaunches,...attackImpacts,...mixedImpacts,...destroyed,...mixedDestroyed].map(event=>event.eventId));
 if(attackLaunches.length||attackImpacts.length||destroyed.length){
  const damage=[...attackImpacts,...mixedImpacts].reduce((sum,event)=>sum+Number(event.facts.damage??0),0);
  const damagingImpacts=[...attackImpacts,...mixedImpacts].filter(event=>Number(event.facts.damage??0)>0);
  const affected=new Set(damagingImpacts.flatMap(event=>event.participants));
  const environmentNote=environmentImpacts.length?`另有 ${environmentImpacts.length} 次环境影响结算。`:'';
  const mixedNote=mixedImpacts.length?`其中 ${mixedImpacts.length} 次同时含攻击与环境来源，伤害不能按来源拆分。`:'';
  const destroyedNote=destroyed.length?`其中 ${destroyed.length} 个文明因攻击退出观察。`:mixedDestroyed.length?`${mixedDestroyed.length} 个文明的退出同时含攻击与环境来源，不能单独归因。`:'没有文明因攻击退出观察。';
  add({id:'v2-conflict',layer:'relation',eventIds:attackRefs,text:`${roundText(Math.min(...[...attackLaunches,...attackImpacts,...mixedImpacts,...destroyed,...mixedDestroyed].map(event=>event.occurredTick)),lastTick)}，记录 ${attackLaunches.length} 次攻击发射和 ${attackImpacts.length+mixedImpacts.length} 次攻击结果，实际造成伤害 ${fixed(damage)}，影响 ${affected.size} 个文明；${destroyedNote}${mixedNote}${environmentNote}`});
 } else {
  const outcome=allDestroyed.length?`${allDestroyed.length} 个文明已退出观察（其中环境影响 ${environmentDestroyed.length} 个${mixedDestroyed.length?`，混合来源 ${mixedDestroyed.length} 个`:''}）`: '所有文明仍存活';
  add({id:'v2-no-conflict',layer:'relation',eventIds:unique([events.find(event=>event.kind==='genesis')?.eventId??firstEvent,...environment.map(event=>event.eventId),...environmentImpacts.map(event=>event.eventId),...environmentDestroyed.map(event=>event.eventId),lastEvent]),text:`${roundText(firstTick,lastTick)}，没有记录攻击发射；期间有 ${environment.length} 次环境扰动，${environmentImpacts.length} 次环境影响有结算记录，实际参与环境影响的文明数为 ${new Set(environmentImpacts.flatMap(event=>event.participants)).size}。${outcome}，这个结果来自已记录的行动与伤害统计，不代表永久和平。`});
 }

 const pendingTransit=run.world.transits.length;
 const pendingCooperation=run.world.cooperations.filter(item=>item.status==='pending').length;
 const acceptedCooperation=run.world.cooperations.filter(item=>item.status==='accepted').length;
 const endingRefs=unique([lastEvent,...events.filter(event=>event.kind==='commit').slice(-3).map(event=>event.eventId),...resultEvents.map(event=>event.eventId),...attackLaunches.map(event=>event.eventId),...allImpactEvents.map(event=>event.eventId),...allDestroyed.map(event=>event.eventId),...environment.map(event=>event.eventId)]);
 const attackDamage=attackImpacts.reduce((sum,event)=>sum+Number(event.facts.damage??0),0);
 const environmentDamage=environmentImpacts.reduce((sum,event)=>sum+Number(event.facts.damage??0),0);
 const mixedDamage=mixedImpacts.reduce((sum,event)=>sum+Number(event.facts.damage??0),0);
 const impactText=`攻击发射 ${attackLaunches.length} 次，攻击相关损伤 ${fixed(attackDamage)}`+(environmentImpacts.length?`；环境影响结算 ${environmentImpacts.length} 次，环境损伤 ${fixed(environmentDamage)}`:'')+(mixedImpacts.length?`；另有 ${mixedImpacts.length} 次攻击与环境混合冲击，合计损伤 ${fixed(mixedDamage)}，来源不能拆分`:'');
 const continuation=endingLabel(run,alive.length)==='阶段观察达到轮数上限'?'若需要知道仍在途任务的抵达与结算结果，可延长观察。':'观察已在当前状态结束，未把未来结果写入结局。';
 add({id:'v2-ending',layer:'reflection',eventIds:endingRefs,text:`截至第 ${lastTick} 轮，${alive.length}/${run.world.civilizations.length} 个文明存活，${impactText}；${pendingTransit} 个行动仍在途，${pendingCooperation} 个合作提案仍待处理${acceptedCooperation?`，另有 ${acceptedCooperation} 个已同意待结算`:''}。${endingLabel(run,alive.length)}。${continuation}`});
 return cards;
}
const responseSchema=z.object({title:z.enum(['星海观察纪事','有限视野中的文明','共同时间，不同判断','一段尚未结束的观察']),sections:z.array(z.object({layer:z.enum(['universe','civilization','relation','reflection']),factIds:z.array(z.string()).min(1).max(6),text:z.string().max(8000).optional()}).strict()).length(4),inferences:z.array(z.enum(['后续走向仍存在不确定性。','现有观测不足以证明某种策略必然占优。','文明判断可能随着新证据改变。'])).max(3)}).strict();
function isLegacyNarrativeResult(value:unknown):boolean {
 if(!value||typeof value!=='object'||!Array.isArray((value as {sections?:unknown}).sections))return false;
 const ids=(value as {sections:unknown[]}).sections.flatMap(section=>section&&typeof section==='object'&&Array.isArray((section as {factIds?:unknown}).factIds)?(section as {factIds:unknown[]}).factIds:[]).filter((id):id is string=>typeof id==='string');
 return ids.some(id=>id==='overview'||id==='ending'||id.startsWith('civ-'));
}
export function validateNarrative(raw:unknown,cards:FactCard[]){
 const v=responseSchema.parse(raw);const layers=new Set(v.sections.map(s=>s.layer));if(layers.size!==4)throw new Error('four layers required');
 for(const s of v.sections){const selected=s.factIds.map(id=>cards.find(c=>c.id===id));if(selected.some(c=>!c||c.layer!==s.layer))throw new Error('Invalid factIds for '+s.layer+': '+JSON.stringify(s.factIds)+'. Allowed ids: '+cards.filter(c=>c.layer===s.layer).map(c=>c.id).join(','));
 const exact=selected.map(c=>c!.text).join('\n');if(s.text!==undefined&&s.text!==exact)throw new Error('Fact wording must exactly match engine evidence');s.text=exact;}
 return {...v,sections:v.sections.map(s=>({...s,text:s.text!}))};
}
export function templateNarrative(run:RunState,reason:string|null=null):Narrative{
 const cards=factCardsV2(run); const layers=['universe','civilization','relation','reflection'] as const;
 return {id:`narrative-${run.world.tick}-${run.narratives.length}`,runId:run.id,title:'星海观察纪事',mode:run.config.mode,source:'template',sourceEventIds:[...new Set(cards.flatMap(c=>c.eventIds))],facts:cards,inferences:[],generatedBy:'确定性事实模板',fallbackReason:reason||'用户选择离线规则或模板摘要',fromTick:0,toTick:run.world.tick,cards,sections:layers.map(layer=>{const cs=cards.filter(c=>c.layer===layer).slice(0,layer==='civilization'?50:12);return {layer,text:cs.map(c=>c.text).join('\n'),factIds:cs.map(c=>c.id),eventIds:[...new Set(cs.flatMap(c=>c.eventIds))]};}),createdAt:new Date().toISOString(),factVersion:2};
}
export async function generateNarrative(run:RunState,record:RequestRecord,isCurrent:()=>boolean):Promise<Narrative>{
 const legacyResult=record.status==='success'&&isLegacyNarrativeResult(record.result);
 const cards=legacyResult?factCards(run):factCardsV2(run);
 const response=record.status==='success'?validateNarrative(record.result,cards):await modelJSON(run,record,'你是结局叙事编辑。仅按提供的中文事实卡组织四段观察记录；不得新增事实、动机、因果、对白、心理或隐含事件。保留事实卡中的时间跨度、文明名称、交互状态、攻击与实际伤害、存活状态和仍在途任务。合作提案、收到提案后的同意或拒绝、合作结果发出和实际收益必须按事实卡原文区分；不能把广播、发出信号或未抵达任务写成已完成。若所有文明存活，只能依据事实卡说明是否有攻击发射、实际伤害和环境实际参与者，不能自动称为永久和平，也不能强迫结局冲突。返回 JSON 对象，title 只能为 星海观察纪事/有限视野中的文明/共同时间，不同判断/一段尚未结束的观察。sections 必须恰好4段，layer分别universe(这段时代),civilization(各文明的经历),relation(关键时刻),reflection(目前的结局)。每段选择该层1–6个factIds，按时间和证据适合的顺序排列。每段只返回layer和factIds，不返回text字段，服务端会按事实卡原文组成段落。inferences只能从给定允许推测中选择，可为空。返回纯 JSON，无代码围栏。', {cards,allowedFactIdsByLayer:Object.fromEntries(['universe','civilization','relation','reflection'].map(layer=>[layer,cards.filter(c=>c.layer===layer).map(c=>c.id)])),allowedInferences:['后续走向仍存在不确定性。','现有观测不足以证明某种策略必然占优。','文明判断可能随着新证据改变。'],schema:{title:'enum',sections:[{layer:'universe|civilization|relation|reflection',factIds:['id']}],inferences:[]}},v=>validateNarrative(v,cards),isCurrent);
 const sections=response.sections.map(s=>({...s,eventIds:[...new Set(s.factIds.flatMap(id=>cards.find(c=>c.id===id)!.eventIds))]}));
 return {id:`narrative-${run.world.tick}-${run.narratives.length}`,runId:run.id,title:response.title,mode:run.config.mode,source:'llm',sourceEventIds:[...new Set(sections.flatMap(s=>s.eventIds))],facts:cards,inferences:response.inferences,generatedBy:`${run.llmParameters.provider}/${run.llmParameters.model}`,fallbackReason:null,fromTick:0,toTick:run.world.tick,cards,sections,createdAt:new Date().toISOString(),...(legacyResult?{factVersion:1 as const}:{factVersion:2 as const})};
}
export function markdown(run:RunState){
 const escape=(s:string)=>s.replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;').replace(/([\\`*_[\]#])/g,'\\$1');
 return `# 宇宙文明推演记录\n\nSeed: ${escape(run.config.seed)} · Tick: ${run.world.tick} · 模式: ${run.config.mode}\n\n存活 ${run.world.civilizations.filter(c=>c.alive).length}，在途 ${run.world.transits.length}，外部请求 ${run.usedRequests}/${run.config.requestLimit}\n\n`+run.narratives.map(n=>`## ${escape(n.title)} · 截止 ${n.toTick} · 来源 ${n.source}\n\n${n.sections.map(s=>`### ${s.layer}\n\n事实：${escape(s.text)}\n\n事件引用：${s.eventIds.join(', ')}`).join('\n\n')}\n\n${n.inferences.map(x=>'推测：'+escape(x)).join('\n')}`).join('\n\n')+'\n\n## 事件轨迹\n\n'+run.world.events.map(e=>`- ${e.eventId} · 第 ${e.occurredTick} 轮 · ${escape(e.summary)}`).join('\n');
}
