import dotenv from 'dotenv';
import {appendFile, mkdir} from 'node:fs/promises';
import type {RequestRecord, RunState} from '../shared/types.js';
dotenv.config({path:'.env',quiet:true} as dotenv.DotenvConfigOptions);
export function serverConfig() {
 const provider=process.env.LLM_PROVIDER||'deepseek';
 const protocol=process.env.LLM_PROTOCOL|| (provider==='anthropic'?'anthropic':'openai-chat');
 const baseUrl=process.env.LLM_BASE_URL||process.env.OPENAI_BASE_URL|| (provider==='deepseek'?'https://api.deepseek.com':provider==='anthropic'?'https://api.anthropic.com/v1':'https://api.openai.com/v1');
 const model=process.env.LLM_MODEL||process.env.OPENAI_MODEL||'';
 const apiKey=process.env.LLM_API_KEY||process.env.DEEPSEEK_API_KEY||process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||'';
 return {provider,protocol,baseUrl,model,apiKey,temperature:Number(process.env.LLM_TEMPERATURE||0.7),timeoutMs:Number(process.env.LLM_TIMEOUT_MS||20000),concurrency:Number(process.env.LLM_CONCURRENCY||4),requestLimit:Number(process.env.LLM_REQUEST_LIMIT||500)};
}
export const verification={verified:false,provider:'',model:'',successes:0,failures:0};
export class ModelError extends Error { code='LLM_ERROR'; }
export class StaleError extends Error { code='CANCELLED'; }
export function parameters() {const c=serverConfig();return {provider:c.provider,model:c.model,protocol:c.protocol,temperature:c.temperature,timeout:c.timeoutMs,concurrency:c.concurrency};}
export function configured(){const c=serverConfig();return Boolean(c.apiKey&&c.model&&c.baseUrl&&['openai-chat','openai-responses','anthropic'].includes(c.protocol));}
export function safeError(e:unknown):string {
 if(e instanceof ModelError||e instanceof StaleError)return e.message;
 if(e instanceof Error&&e.name==='TimeoutError')return '外部模型请求超过时限';
 return '模型请求或 JSON 校验失败';
}
async function log(data:unknown){try{await mkdir('.local',{recursive:true});await appendFile('.local/requests.jsonl',JSON.stringify(data)+'\n');}catch{/* Storage failure must never retry a successful paid request. */}}
let checkpointWriter:(run:RunState)=>Promise<void>=async()=>{};
export function setCheckpointWriter(writer:(run:RunState)=>Promise<void>){checkpointWriter=writer;}
export type Fetcher=typeof fetch;
export async function modelJSON<T>(run:RunState,record:RequestRecord,system:string,input:unknown,validate:(v:unknown)=>T,isCurrent:()=>boolean,fetcher:Fetcher=fetch):Promise<T>{
 const c=serverConfig();
 if(!configured())throw new ModelError('LLM 未配置：请在本地 .env 设置提供商、模型和密钥');
 // An interrupted logical request keeps its first-attempt diagnostic on disk.
 let last=record.error||'';
 // Network retries and schema repairs share the same second attempt.
 while(record.attempts<2){
  if(!isCurrent())throw new StaleError('旧运行已取消');
  if(run.usedRequests>=run.config.requestLimit)throw new ModelError('本次运行请求上限已用尽；可导出或显式继续为混合运行');
  record.attempts++; run.usedRequests++; record.status='pending';await checkpointWriter(run);if(!isCurrent()){record.attempts--;run.usedRequests--;throw new StaleError('旧运行已取消');}
  const start=Date.now();
  const user=JSON.stringify({data:input,...(last?{repair:'上次请求或输出未通过。若为校验错误，先核对 validationError 中的候选值与 data 硬约束，再重新给出完整、相同 schema 的 JSON。不得输出 Markdown、解释或 JSON Schema。'+(record.kind==='decision'?'自行重新选择合法动作与参数，不能重复已拒绝的预算或不可用证据。动作成本包含强度与适用的合作本金，必须 computedCost <= budget <= resources。beliefUpdates 没有新证据时省略或 []。':''),validationError:last}:{})});
  let endpoint:string;let body:Record<string,unknown>;let headers:Record<string,string>={'Content-Type':'application/json'};
  if(c.protocol==='anthropic'){
   endpoint=c.baseUrl.replace(/\/$/,'')+'/messages';headers['x-api-key']=c.apiKey;headers['anthropic-version']='2023-06-01';
   body={model:c.model,max_tokens:run.config.maxOutputTokens,temperature:c.temperature,system,messages:[{role:'user',content:user}]};
  }else if(c.protocol==='openai-responses'){
   endpoint=c.baseUrl.replace(/\/$/,'')+'/responses';headers.Authorization='Bearer '+c.apiKey;
   body={model:c.model,instructions:system,input:user,max_output_tokens:run.config.maxOutputTokens,text:{format:{type:'json_object'}}};
  }else{
   endpoint=c.baseUrl.replace(/\/$/,'')+'/chat/completions';headers.Authorization='Bearer '+c.apiKey;
   body={model:c.model,messages:[{role:'system',content:system},{role:'user',content:user}],response_format:{type:'json_object'},temperature:c.temperature,max_tokens:run.config.maxOutputTokens,stream:false,...(c.provider==='deepseek'?{thinking:{type:'disabled'}}:{})};
  }
  try{
   const r=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(run.config.timeoutMs)});
   if(!r.ok)throw new ModelError(`模型服务返回 HTTP ${r.status}`); // Do not echo provider body, headers, or credentials.
   const raw=await r.json() as any;
   const content=c.protocol==='anthropic'?raw.content?.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join(''):c.protocol==='openai-responses'?raw.output?.flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join(''):raw.choices?.[0]?.message?.content;
   if(typeof content!=='string'||!content.trim()||content.length>120000)throw new ModelError('模型返回空值或超长内容');
   if(raw.choices?.[0]?.finish_reason==='length'||raw.stop_reason==='max_tokens'||raw.status==='incomplete')throw new ModelError('模型输出被截断');
   let value:T;
   try{value=validate(JSON.parse(content));}catch(e){if(e instanceof ModelError)throw e;const issue=e as {issues?:Array<{path:unknown[];message:string}>};const details=issue.issues?.slice(0,5).map(x=>x.path.join('.')+': '+x.message).join('; ')||(e instanceof Error?e.message:'invalid JSON');throw new ModelError('输出校验失败：'+details.slice(0,1000).split(c.apiKey).join('[REDACTED]'));}
   if(!isCurrent())throw new StaleError('旧运行已取消');
   record.status='success';record.source='llm';record.result=value;record.durationMs=(record.durationMs||0)+Date.now()-start;delete record.error;
   verification.verified=true;verification.provider=c.provider;verification.model=c.model;verification.successes++;await checkpointWriter(run);
   await log({runId:run.id,requestId:record.id,kind:record.kind,tick:record.tick,attempt:record.attempts,provider:c.provider,model:c.model,status:'success',validation:'passed',responseSummary:{characters:content.length},durationMs:Date.now()-start,usedRequests:run.usedRequests});
   return value;
  }catch(e){
   if(e instanceof StaleError)throw e;
   last=safeError(e);record.error=last;record.status='failed';record.durationMs=(record.durationMs||0)+Date.now()-start;verification.failures++;
   await log({runId:run.id,requestId:record.id,kind:record.kind,tick:record.tick,attempt:record.attempts,provider:c.provider,model:c.model,status:'failed',error:last,durationMs:Date.now()-start,usedRequests:run.usedRequests});
  }
 }
 throw new ModelError(last||record.error||'此逻辑请求已用完一次修复机会；可显式重试失败请求');
}
export async function parallelLimit<T>(items:T[],limit:number,fn:(item:T)=>Promise<void>){let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const item=items[cursor++];await fn(item);}}));}
