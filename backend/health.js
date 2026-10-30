// GET|HEAD /api/health for uptime checks and the deploy script: is the database reachable, which version is live.
// It never needs a login and never shows a secret, a URL or an error text.
// ?deep=1 also asks the PDF layout service (its /health, with the token, at most 5 s): does it answer, is it busy, and
// does it check documents with the same layout code as this Worker (npm run deploy sets PDF_LAYOUT_VERSION to that
// code's hash). A deep answer is 503 when the service is set up but not usable, so an uptime monitor can watch it. Each
// Worker instance asks the service at most once per DEEP_TTL_MS, whoever polls. It also lists the migrations this code
// needs that the database lacks (every history list and save fails then with schema_outdated), and is 503 while any is.
import {json,logEvent} from './http.js';
import {serviceUrl,expectedLayout} from './pdf-layout.js';

const DEEP_TTL_MS=30000,DEEP_TIMEOUT_MS=5000;
// database/migrations as this code knows it: a new migration is added here too (backend/health.test.mjs compares).
export const MIGRATIONS=Object.freeze(['0001_initial.sql','0002_story_covers.sql','0003_job_progress.sql','0004_reader_uploads.sql','0005_large_text.sql','0006_web_sources.sql','0007_chapter_position.sql','0008_reader_accounts.sql','0009_local_reader_login.sql','0010_translation_audit.sql','0011_study_history.sql','0012_source_fingerprint.sql','0013_study_books.sql','0014_ops.sql','0015_public_book_pages.sql','0016_book_jobs.sql','0017_session_subject.sql','0018_service_leases.sql','0019_book_job_runner.sql','0020_password_reset.sql','0022_auth_failures.sql','0023_session_revision.sql','0024_reader_email_index.sql','0025_admin_accounts.sql','0026_study_engine.sql','0027_layout_refresh.sql']);
// {status:'ok'} or {status:'pending', pending:[names]} from what `wrangler d1 migrations apply` recorded; 'error' when
// that table cannot be read. A database never migrated has no such table: everything is pending.
async function migrations(env){
 try{
  const {results=[]}=await env.DB.prepare('SELECT name FROM d1_migrations').all(),applied=new Set(results.map(row=>row?.name));
  const pending=MIGRATIONS.filter(name=>!applied.has(name));return pending.length?{status:'pending',pending}:{status:'ok'};
 }catch(error){
  if(/no such table/iu.test(String(error?.message)))return {status:'pending',pending:[...MIGRATIONS]};
  logEvent('health_migrations_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});return {status:'error'};
 }
}
let deepCache=null;
// {status:'off'|'ok'|'mismatch'|'unauthorized'|'error'|'timeout'|'unreachable', …}
async function pdfService(env,now=Date.now()){
 let url;try{url=serviceUrl(env);}catch{return {status:'error'};}
 if(!url)return {status:'off'};
 const source=url.href;if(deepCache?.source===source&&deepCache.expires>now)return deepCache.state;
 url.pathname=url.pathname.replace(/\/$/u,'')+'/health';
 const expected=expectedLayout(env),started=Date.now();let state;
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
 const [pdf,schema]=deep?await Promise.all([pdfService(env),database==='ok'?migrations(env):null]):[null,null];
 const ok=database==='ok'&&(!pdf||USABLE.has(pdf.status))&&(!schema||schema.status==='ok'),status=ok?200:503;
 const body={ok,service:'hoa-tri',version:meta.tag||meta.id||'dev',deployedAt:meta.timestamp||null,database,pdfLayout:env.PDF_LAYOUT_SERVICE_URL&&env.PDF_LAYOUT_SERVICE_TOKEN?'configured':'off',...(pdf?{pdfService:pdf}:{}),...(schema?{migrations:schema}:{}),time:new Date().toISOString()};
 return request.method==='HEAD'?new Response(null,{status,headers:{'Cache-Control':'no-store'}}):json(body,status);
}
