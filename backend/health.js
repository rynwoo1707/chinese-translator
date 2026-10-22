// GET|HEAD /api/health for uptime checks and the deploy script: is the database reachable, which version is live.
// It never needs a login and never shows a secret, a URL or an error text.
// ?deep=1 also asks the PDF layout service (its /health, with the token, at most 5 s): does it answer, is it busy, and
// does it check documents with the same layout code as this Worker (npm run deploy sets PDF_LAYOUT_VERSION to that
// code's hash). A deep answer is 503 when the service is set up but not usable, so an uptime monitor can watch it. Each
// Worker instance asks the service at most once per DEEP_TTL_MS, whoever polls.
import {json,logEvent} from './http.js';
import {serviceUrl} from './pdf-layout.js';

const DEEP_TTL_MS=30000,DEEP_TIMEOUT_MS=5000;
let deepCache=null;
// {status:'off'|'ok'|'mismatch'|'unauthorized'|'error'|'timeout'|'unreachable', …}
async function pdfService(env,now=Date.now()){
 let url;try{url=serviceUrl(env);}catch{return {status:'error'};}
 if(!url)return {status:'off'};
 const source=url.href;if(deepCache?.source===source&&deepCache.expires>now)return deepCache.state;
 url.pathname=url.pathname.replace(/\/$/u,'')+'/health';
 const expected=/^[a-f\d]{8,64}$/u.test(String(env.PDF_LAYOUT_VERSION||'').trim())?String(env.PDF_LAYOUT_VERSION).trim():null,started=Date.now();let state;
 try{
  const response=await fetch(url,{headers:{Authorization:`Bearer ${env.PDF_LAYOUT_SERVICE_TOKEN}`},signal:AbortSignal.timeout(DEEP_TIMEOUT_MS)}),body=await response.json().catch(()=>null),ms=Date.now()-started;
  if(response.status===401)state={status:'unauthorized',ms};
  else if(!response.ok||body?.ok!==true)state={status:'error',code:response.status,ms};
  else{
   const version=body.version&&typeof body.version==='object'?{layout:String(body.version.layout||'')||null,service:String(body.version.service||'')||null}:null;
   const layoutMatch=expected&&version?.layout?expected===version.layout:null;
   state={status:layoutMatch===false?'mismatch':'ok',ms,busy:Boolean(body.busy),active:Number(body.active)||0,jobs:Number(body.jobs)||null,version,expectedLayout:expected,layoutMatch,font:typeof body.font==='string'?body.font.slice(0,100):null};
  }
 }catch(error){
  state={status:error?.name==='TimeoutError'?'timeout':'unreachable'};
  logEvent('health_pdf_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});
 }
 deepCache={source,expires:now+DEEP_TTL_MS,state};
 return state;
}
const USABLE=new Set(['off','ok']);

export async function healthRoute(request,env,path){
 if(path!=='/api/health')return null;
 if(!['GET','HEAD'].includes(request.method))return json({error:'Phương thức không được hỗ trợ.'},405,{Allow:'GET, HEAD'});
 let database='ok';
 try{if(typeof env.DB?.prepare!=='function'||!await env.DB.prepare('SELECT 1 AS ok').first())database='error';}
 catch(error){database='error';logEvent('health_db_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});}
 // Set by the version_metadata binding: tag is what the deploy script passes (the commit), id the Cloudflare version.
 const meta=env.CF_VERSION_METADATA||{},deep=new URL(request.url).searchParams.get('deep')==='1';
 const pdf=deep?await pdfService(env):null,ok=database==='ok'&&(!pdf||USABLE.has(pdf.status)),status=ok?200:503;
 const body={ok,service:'hoa-tri',version:meta.tag||meta.id||'dev',deployedAt:meta.timestamp||null,database,pdfLayout:env.PDF_LAYOUT_SERVICE_URL&&env.PDF_LAYOUT_SERVICE_TOKEN?'configured':'off',...(pdf?{pdfService:pdf}:{}),time:new Date().toISOString()};
 return request.method==='HEAD'?new Response(null,{status,headers:{'Cache-Control':'no-store'}}):json(body,status);
}
