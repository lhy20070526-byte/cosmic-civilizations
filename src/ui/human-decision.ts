import { decisionCost, validateDecision } from '../engine/index';
import { ACTION_TYPES, type ActionType, type Decision, type HumanTurn, type VisibleView } from '../shared/types';

export interface HumanReply { target: string; contactId: string; replyTo: string; kind: string; cost: number; affordable: boolean }
export interface HumanAffordability { action: ActionType; messageKind: string | null; minimumCost: number; affordable: boolean; legal: boolean; maxAffordableIntensity: number | null; legalTargets: string[] | null; replyOptions?: HumanReply[] }
export interface HumanGuidance { affordability?: HumanAffordability[]; legalExamples?: Decision[]; legalTargets?: {contacts: string[]; sites: string[]}; disabledReason?: string; objective?: string; message?: string }
export type HumanSnapshot = Omit<HumanTurn, 'guidance'> & { guidance: HumanGuidance | null };
export type HumanDecisionPayload = Decision;
export type HumanDraft = {action: ActionType; intensity: number; target: string; messageKind: string | null; replyTo: string; text: string; reason: string};
export const actionLabels: Record<ActionType,string> = {develop:'发展',explore:'探索',hide:'隐匿',defend:'防御',contact:'联络',broadcast:'广播',cooperate:'合作',strike:'攻击',salvage:'回收',wait:'观望'};
export const messageLabels: Record<string,string> = {proposal:'提出合作',accept:'同意提案',reject:'拒绝提案',information:'信息'};
export function actionOptions(guidance:HumanGuidance|null){return ACTION_TYPES.map(action=>({action,label:actionLabels[action],enabled:Boolean(guidance?.affordability?.some(row=>row.action===action&&row.legal&&row.affordable))}));}
export function actionRows(guidance:HumanGuidance|null,action:ActionType){return guidance?.affordability?.filter(row=>row.action===action)??[];}
export function draftRow(guidance:HumanGuidance|null,draft:HumanDraft){return actionRows(guidance,draft.action).find(row=>row.messageKind===draft.messageKind);}
export function targetOptions(view:VisibleView|null,row:HumanAffordability|undefined){
 return (row?.legalTargets??[]).flatMap(id=>{
  if(row?.action==='salvage'){const site=view?.sites.find(s=>s.siteId===id);return site?[{id,label:`${site.kind==='debris'?'残骸':'资源点'} ${id}`,detail:`估计储备 ${Math.round(site.estimatedResources)}`}]:[];}
  const contact=view?.contacts.find(c=>c.contactId===id);return contact?[{id,label:contact.label,detail:contact.estimatedPosition?`定位误差 ±${contact.uncertainty.toFixed(1)}`:'尚无定位'}]:[];
 });
}
export function replyOptions(view:VisibleView|null,row:HumanAffordability|undefined){
 return (row?.replyOptions??[]).filter(reply=>reply.affordable&&view?.proposals.some(p=>p.proposalId===reply.replyTo&&p.contactId===reply.contactId&&p.direction==='incoming'&&p.status==='pending'&&p.expiresAt>view.tick));
}
export function chooseAction(view:VisibleView|null,guidance:HumanGuidance|null,action:ActionType,prior?:HumanDraft,messageKind?:string|null):HumanDraft {
 const rows=actionRows(guidance,action);const row=(messageKind===undefined?rows.find(r=>r.legal&&r.affordable):rows.find(r=>r.messageKind===messageKind))??rows[0];
 const reply=replyOptions(view,row)[0];const target=reply?.contactId??targetOptions(view,row)[0]?.id??'';
 return {action,intensity:0,target,messageKind:row?.messageKind??null,replyTo:reply?.replyTo??'',text:prior?.text??'',reason:prior?.reason??''};
}
export function initialDraft(view:VisibleView|null,guidance:HumanGuidance|null):HumanDraft {return chooseAction(view,guidance,actionOptions(guidance).find(a=>a.enabled)?.action??'wait');}
export function draftDecision(draft:HumanDraft):Decision {
 const decision:Decision={action:draft.action,target:['contact','cooperate','strike','salvage'].includes(draft.action)?draft.target||null:null,intensity:draft.intensity,budget:0,message:draft.messageKind?{kind:draft.messageKind,replyTo:draft.replyTo||null,text:draft.text.trim()}:null,reason:draft.reason.trim()||'我根据当前冻结视图选择本轮行动。'};
 decision.budget=decisionCost(decision);return decision;
}
export function draftProblems(view:VisibleView|null,guidance:HumanGuidance|null,draft:HumanDraft):string[] {
 if(!view)return ['等待服务端提供冻结视图'];const row=draftRow(guidance,draft);const problems:string[]=[];
 if(!row?.legal||!row.affordable)problems.push('此动作在当前资源或目标条件下不可用');
 if(!Number.isFinite(draft.intensity)||draft.intensity<0||draft.intensity>Math.min(1,row?.maxAffordableIntensity??0))problems.push('强度超出当前可负担范围');
 if(['contact','cooperate','strike','salvage'].includes(draft.action)&&!targetOptions(view,row).some(t=>t.id===draft.target))problems.push('请选择当前可见的合法目标');
 if(draft.messageKind&&!draft.text.trim())problems.push('请填写要发送的消息');
 if(draft.messageKind&&draft.text.trim().length>600)problems.push('消息最多 600 字');
 if(draft.action==='cooperate'&&['accept','reject'].includes(draft.messageKind??'')&&!replyOptions(view,row).some(p=>p.replyTo===draft.replyTo&&p.contactId===draft.target))problems.push('请选择一份已收到、待回复且未到期的提案');
 const decision=draftDecision(draft);if(decision.budget>view.self.resources)problems.push('本次支出超过可用储备');
 if(!problems.length&&!validateDecision(view,decision))problems.push('当前参数未通过动作规则校验，请检查消息、强度与目标');
 return problems;
}
