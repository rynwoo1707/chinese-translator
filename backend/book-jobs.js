// Whole-book translation ("Dịch cả quyển"). The browser does the work, chunk by chunk with the student's own Gemini key;
// a job records what became of every page of the stored original, the tokens spent and the terms kept for the whole
// book, so a run can pause (a quota, a closed tab) and resume on any device. Only the owner sees or changes a job.
import {UserError} from './http.js';
import {isStudyModel} from './gemini-models.js';
import {normalizeVietnameseText} from './vietnamese-text.js';
import {isSubject} from './subject-glossaries.js';
import {ownedBook,sourceKey,sourceInUse,removeKeys} from './study-history.js';
// The modes of "Cách dịch" (book_jobs.mode has no CHECK, so a run stores its mode as it is, premium included). The
// student may change a job's mode while no other device's run holds it (PATCH mode).
import {isMode,learnedTerm} from '../frontend/translation-modes.js';

const base='/api/my/study/book-jobs';
const reply=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const SHA=/^[a-f\d]{64}$/u,UUID=/^[a-f\d-]{36}$/iu,CONTROL=/[\u0000-\u001f\u007f]/u;
// One character per page of the original; requests may also name the states in words. untranslated ('u'): a page with no
// block to translate that still shows Chinese outside every block (in a figure, a rotated watermark…: the extractor's
// page.untranslated), kept as printed and named, never called blank.
const STATES={pending:'.',done:'d',blank:'b',untranslated:'u',cover:'c',skipped:'s',failed:'f'},CODES=new Set(Object.values(STATES));
const STATUSES=new Set(['ready','running','paused','done']);
export const MAX_BOOK_PAGES=10000;
// A chunk is one layout extraction, which takes at most 20 pages. The glossary goes with every chunk's request, so it is
// bounded in terms and bytes; an encyclopedia stops learning new terms rather than growing every request.
const MAX_CHUNK=20,MAX_JOBS=50,MAX_TERMS=2000,MAX_GLOSSARY_BYTES=256*1024,MAX_USAGE=1_000_000_000;
const USAGE=[['prompt','prompt_tokens'],['output','output_tokens'],['thinking','thinking_tokens'],['total','total_tokens'],['requests','ai_requests']];
// A run holds its job for LEASE_MS after each report it sends (every chunk, and at least once a minute inside a long
// one): another device's run is refused meanwhile. A run that stops reporting (a closed tab) frees the job at the end.
export const LEASE_MS=10*60*1000;
// Token reports one request may carry, and the report ids a job remembers: more than a device can still be holding.
const MAX_REPORTS=20,KEPT_REPORTS=100,RUN_ID=/^[A-Za-z\d-]{8,64}$/u;
const bad=(message,code)=>new UserError(message,400,code);
const within=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const leased=(row,now)=>Boolean(row.runner_id)&&Number(row.lease_until)>now;

// The original kept for whole-book runs (and for the whole-book PDF): page count and name as stored with it.
export async function storedSource(env,userId,sha256){
 if(!SHA.test(sha256||''))return null;
 const key=sourceKey(userId,sha256),object=await (env.FILES.head?env.FILES.head(key):env.FILES.get(key));if(!object)return null;
 const pages=Number(object.customMetadata?.pages);
 return {pages:within(pages,1,MAX_BOOK_PAGES)?pages:null,filename:String(object.customMetadata?.filename||'')};
}
function parseGlossary(value){try{const parsed=JSON.parse(value||'{}');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}}
function countedReports(value){try{const ids=JSON.parse(value||'[]');return Array.isArray(ids)?ids.filter(id=>typeof id==='string'):[];}catch{return [];}}
// runner and leaseSeconds: the run holding the job now, if any, and how long its lease still lasts.
function jobFromRow(row,now=Date.now()){
 const held=leased(row,now);
 return {id:row.id,sourceSha256:row.source_sha256,filename:row.filename,title:row.title,storyId:row.story_id||null,totalPages:row.total_pages,pageStates:row.page_states,chunkSize:row.chunk_size,domain:row.domain,mode:row.mode,model:row.model||null,status:row.status,pauseReason:row.pause_reason||null,usage:Object.fromEntries(USAGE.map(([key,column])=>[key,Number(row[column])||0])),glossary:parseGlossary(row.glossary),createdAt:row.created_at,updatedAt:row.updated_at,runner:held?row.runner_id:null,leaseSeconds:held?Math.ceil((Number(row.lease_until)-now)/1000):0};
}
function cleanFilename(value){
 if(value!==undefined&&value!==null&&typeof value!=='string')throw bad('Tên tệp không hợp lệ.','bad_filename');
 const filename=String(value||'').normalize('NFC').trim();if(filename.length>240||CONTROL.test(filename))throw bad('Tên tệp không hợp lệ.','bad_filename');return filename;
}
function cleanTitle(value,filename){
 if(value!==undefined&&value!==null&&typeof value!=='string')throw bad('Tên sách không hợp lệ.','bad_title');
 const title=(String(value||'').trim()||filename.replace(/\.[^.]+$/u,'').trim()||'Sách chưa đặt tên').normalize('NFC');
 if(title.length>200||CONTROL.test(title))throw bad('Tên sách phải có từ 1 đến 200 ký tự.','bad_title');return title;
}
function cleanReason(value){
 if(value===null)return null;if(typeof value!=='string')throw bad('Lý do tạm dừng không hợp lệ.','bad_reason');
 const reason=value.trim();if(reason.length>200||CONTROL.test(reason))throw bad('Lý do tạm dừng không hợp lệ.','bad_reason');return reason||null;
}
// The glossary in the form translate-blocks takes: Chinese term -> Vietnamese, each at most 100 characters. Invalid
// entries are left out, as the history save does. learned: terms a chunk learned (a run's PATCH), which count only as
// Vietnamese renderings, the Chinese in parentheses after a reading at most (translation-modes.js learnedTerm, the rule
// of text mode and of every batch): one keeping Chinese bare, or repeating its term, would keep that Chinese for the
// rest of the book.
function glossaryEntries(value,{learned=false}={}){
 if(value===undefined)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw bad('Bảng thuật ngữ phải là các cặp tiếng Trung – tiếng Việt.','bad_glossary');
 const entries=[];
 for(const [rawKey,rawValue] of Object.entries(value).slice(0,MAX_TERMS)){
  if(typeof rawValue!=='string')continue;
  const key=rawKey.normalize('NFC').trim(),translation=normalizeVietnameseText(rawValue.trim()).trim();
  if(learned&&!learnedTerm(key,translation))continue;
  if(key&&translation&&key.length<=100&&translation.length<=100&&!['__proto__','constructor','prototype'].includes(key)&&!CONTROL.test(key+translation))entries.push([key,translation]);
 }
 return entries;
}
// A later value for a term replaces the earlier one (the student's correction, or a chunk's). Once the book holds
// MAX_TERMS terms or MAX_GLOSSARY_BYTES, new terms are left out and the ones already in use stay.
const encoder=new TextEncoder(),size=(key,value)=>encoder.encode(JSON.stringify(key)).length+encoder.encode(JSON.stringify(value)).length+2;
function mergeGlossary(current,entries){
 const merged=new Map(Object.entries(current).filter(([,value])=>typeof value==='string'));let bytes=2;for(const [key,value] of merged)bytes+=size(key,value);
 for(const [key,value] of entries){
  const prior=merged.get(key),delta=size(key,value)-(prior===undefined?0:size(key,prior));
  if(prior===undefined&&merged.size>=MAX_TERMS||bytes+delta>MAX_GLOSSARY_BYTES)continue;
  merged.set(key,value);bytes+=delta;
 }
 return Object.fromEntries(merged);
}
// {"12":"done","13":"b"}: page numbers of the original. A translated page stays translated: a stale tab or a failed
// retry never sends it back to the queue or marks it failed.
function mergePages(current,changes,total){
 if(!changes||typeof changes!=='object'||Array.isArray(changes))throw bad('Danh sách trạng thái trang không hợp lệ.','bad_pages');
 const entries=Object.entries(changes);if(entries.length>total)throw bad('Danh sách trạng thái trang không hợp lệ.','bad_pages');
 const pages=current.split('');
 for(const [key,value] of entries){
  const page=/^\d{1,5}$/u.test(key)?Number(key):0,code=typeof value!=='string'?null:Object.hasOwn(STATES,value)?STATES[value]:CODES.has(value)?value:null;
  if(page<1||page>total||!code)throw bad(`Trạng thái trang ${key.slice(0,12)} không hợp lệ.`,'bad_pages');
  if(pages[page-1]==='d'&&(code==='.'||code==='f'))continue;
  pages[page-1]=code;
 }
 return pages.join('');
}
function usageToAdd(value){
 if(value===undefined)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw bad('Số token cần cộng thêm không hợp lệ.','bad_usage');
 return USAGE.map(([key])=>{const count=value[key]??0;if(!Number.isSafeInteger(count)||count<0||count>MAX_USAGE)throw bad('Số token cần cộng thêm không hợp lệ.','bad_usage');return count;});
}
// [{id,usage}]: the tokens a run spent, in batches with an id each. A batch sent again (its answer was lost) is counted
// once, so a device may resend whatever the server did not confirm.
function usageReports(value){
 if(value===undefined)return null;
 const invalid=()=>bad('Số token cần cộng thêm không hợp lệ.','bad_usage'),ids=new Set();
 if(!Array.isArray(value)||value.length>MAX_REPORTS)throw invalid();
 return value.map(report=>{if(!report||typeof report!=='object'||typeof report.id!=='string'||!RUN_ID.test(report.id)||ids.has(report.id)||report.usage===undefined)throw invalid();ids.add(report.id);return {id:report.id,usage:usageToAdd(report.usage)};});
}
function runnerOf(value){
 if(value===undefined)return undefined;
 if(typeof value!=='string'||!RUN_ID.test(value))throw bad('Mã phiên dịch không hợp lệ.','bad_runner');return value;
}
async function bookOf(env,reader,value){
 if(value===null)return {id:null};
 const book=typeof value==='string'?await ownedBook(env,reader.id,value):null;
 return book?{id:book.id}:null;
}
const missingBook=()=>reply({error:'Không tìm thấy sách đã chọn trong Thư viện riêng.',code:'book_missing'},404);
const missingJob=()=>reply({error:'Không tìm thấy lượt dịch cả quyển.',code:'not_found'},404);
// Another device's run holds the job: nothing changes. The answer says how long the lease lasts at most and carries the
// job, so the other device shows the progress being made.
function busy(row,now){
 const seconds=Math.max(1,Math.ceil((Number(row.lease_until)-now)/1000));
 return reply({error:'Quyển này đang được dịch ở một thiết bị khác (hoặc một trình duyệt khác). Dịch cùng lúc ở hai nơi sẽ trả token hai lần cho cùng trang; hãy đợi thiết bị đó dịch xong hoặc tạm dừng.',code:'job_busy',retryAfter:seconds,job:jobFromRow(row,now)},409,{'Retry-After':String(seconds)});
}

async function createJob(request,env,reader){
 const body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body))throw bad('Dữ liệu lượt dịch không hợp lệ.','invalid_body');
 const sha256=body.sourceSha256,totalPages=body.totalPages,chunkSize=body.chunkSize,cover=body.coverPage??null;
 if(!SHA.test(typeof sha256==='string'?sha256:''))throw bad('Mã tệp gốc không hợp lệ.','bad_hash');
 if(!within(totalPages,1,MAX_BOOK_PAGES))throw bad(`Số trang phải từ 1 đến ${MAX_BOOK_PAGES}.`,'bad_pages');
 if(!within(chunkSize,1,MAX_CHUNK))throw bad(`Mỗi phần dịch có từ 1 đến ${MAX_CHUNK} trang.`,'bad_chunk');
 if(!isSubject(body.domain))throw bad('Lĩnh vực không hợp lệ.','bad_domain');
 if(!isMode(body.mode))throw bad('Chế độ dịch không hợp lệ.','bad_mode');
 if(cover!==null&&!within(cover,0,totalPages))throw bad('Trang bìa không thuộc tệp gốc.','bad_cover');
 const filename=cleanFilename(body.filename),entries=glossaryEntries(body.glossary)||[];
 const book=body.storyId===undefined?{id:null}:await bookOf(env,reader,body.storyId);if(!book)return missingBook();
 // Every chunk is cut from the stored original, on whichever device the run resumes, so it must be there first.
 const source=await storedSource(env,reader.id,sha256);
 if(!source)return reply({error:'Tài khoản chưa lưu tệp gốc này. Hãy tải tệp lên trước khi dịch cả quyển.',code:'source_missing'},404);
 if(source.pages&&source.pages!==totalPages)throw bad(`Tệp gốc đã lưu có ${source.pages} trang, không phải ${totalPages}.`,'pages_mismatch');
 const name=filename||source.filename,title=cleanTitle(body.title,name),pages='.'.repeat(totalPages).split('');if(cover)pages[cover-1]='c';
 const id=crypto.randomUUID(),now=new Date().toISOString();
 // One unfinished run per original: a second tab or a double click must not pay for the same pages twice. The checks
 // and the insert are one statement, so two requests at once cannot both pass.
 const row=await env.DB.prepare(`INSERT INTO book_jobs(id,user_id,source_sha256,filename,title,story_id,total_pages,page_states,chunk_size,domain,mode,glossary,created_at,updated_at)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13 WHERE NOT EXISTS (SELECT 1 FROM book_jobs WHERE user_id=?2 AND source_sha256=?3 AND status<>'done') AND (SELECT COUNT(*) FROM book_jobs WHERE user_id=?2)<?14 RETURNING *`)
  .bind(id,reader.id,sha256,name,title,book.id,totalPages,pages.join(''),chunkSize,body.domain,body.mode,JSON.stringify(mergeGlossary({},entries)),now,MAX_JOBS).first();
 if(row)return reply({job:jobFromRow(row)},201);
 const open=await env.DB.prepare("SELECT * FROM book_jobs WHERE user_id=? AND source_sha256=? AND status<>'done' ORDER BY updated_at DESC LIMIT 1").bind(reader.id,sha256).first();
 if(open)return reply({error:'Tệp này đang có một lượt dịch cả quyển chưa xong. Hãy tiếp tục lượt đó hoặc xóa nó trước.',code:'job_exists',job:jobFromRow(open)},409);
 return reply({error:`Bạn đã có ${MAX_JOBS} lượt dịch cả quyển. Hãy xóa bớt lượt cũ rồi thử lại.`,code:'too_many_jobs'},409);
}

async function updateJob(request,env,reader,id){
 const body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body))throw bad('Dữ liệu cập nhật không hợp lệ.','invalid_body');
 const has=key=>body[key]!==undefined;
 if(has('status')&&!STATUSES.has(body.status))throw bad('Trạng thái lượt dịch không hợp lệ.','bad_status');
 if(has('model')&&body.model!==null&&!isStudyModel(body.model))throw bad('Model Gemini không hợp lệ.','bad_model');
 if(has('mode')&&!isMode(body.mode))throw bad('Chế độ dịch không hợp lệ.','bad_mode');
 const reason=has('pauseReason')?cleanReason(body.pauseReason):undefined,usage=usageToAdd(body.addUsage),reports=usageReports(body.reports),runner=runnerOf(body.runner),entries=glossaryEntries(body.glossary,{learned:true});
 const book=has('storyId')?await bookOf(env,reader,body.storyId):undefined;if(book===null)return missingBook();
 // Tokens are counted whoever reports them; every other change belongs to the run holding the job (runner), if any.
 const changes=['pages','status','pauseReason','model','storyId','glossary','mode'].some(has);
 if(!changes&&!usage&&!reports&&runner===undefined)throw bad('Không có thay đổi nào cho lượt dịch.','no_change');
 // Two tabs may report at once: each update applies to the version it read and is retried on a newer one, so page
 // states, token counts and terms from both are kept.
 for(let attempt=0;attempt<5;attempt++){
  const row=await env.DB.prepare('SELECT * FROM book_jobs WHERE id=? AND user_id=?').bind(id,reader.id).first();if(!row)return missingJob();
  const now=Date.now(),held=leased(row,now),mine=held&&row.runner_id===runner;
  if(held&&!mine&&changes)return busy(row,now);
  const status=has('status')?body.status:row.status;
  // Leaving the paused state clears its reason unless the request gives one.
  const pauseReason=reason!==undefined?reason:has('status')&&status!=='paused'?null:row.pause_reason;
  const pages=has('pages')?mergePages(row.page_states,body.pages,row.total_pages):row.page_states;
  const glossary=entries?JSON.stringify(mergeGlossary(parseGlossary(row.glossary),entries)):row.glossary;
  const counted=countedReports(row.usage_reports),fresh=(reports||[]).filter(report=>!counted.includes(report.id));
  const add=USAGE.map((_,i)=>(usage?.[i]||0)+fresh.reduce((sum,report)=>sum+report.usage[i],0));
  const kept=fresh.length?JSON.stringify([...counted,...fresh.map(report=>report.id)].slice(-KEPT_REPORTS)):row.usage_reports;
  // A reporting run takes or renews the lease while the job runs and lets it go when it pauses or finishes.
  const [runnerId,leaseUntil]=runner!==undefined&&(!held||mine)?status==='running'?[runner,now+LEASE_MS]:[null,0]:[row.runner_id,row.lease_until];
  const updated=await env.DB.prepare(`UPDATE book_jobs SET page_states=?,status=?,pause_reason=?,model=?,story_id=?,glossary=?,mode=?,prompt_tokens=prompt_tokens+?,output_tokens=output_tokens+?,thinking_tokens=thinking_tokens+?,total_tokens=total_tokens+?,ai_requests=ai_requests+?,usage_reports=?,runner_id=?,lease_until=?,version=version+1,updated_at=?
   WHERE id=? AND user_id=? AND version=? RETURNING *`).bind(pages,status,pauseReason,has('model')?body.model:row.model,book?book.id:row.story_id,glossary,has('mode')?body.mode:row.mode,...add,kept,runnerId,leaseUntil,new Date(now).toISOString(),id,reader.id,row.version).first();
  if(updated)return reply({job:jobFromRow(updated,now)});
 }
 return reply({error:'Lượt dịch vừa được cập nhật ở nơi khác. Hãy tải lại trang rồi thử lại.',code:'conflict'},409);
}

// Removing a run also removes the stored original when nothing else uses it (no translated part, no cover, no other
// run), unless ?keepSource=1: a student starting the same book over keeps the upload.
async function deleteJob(request,env,reader,id){
 const row=await env.DB.prepare('DELETE FROM book_jobs WHERE id=? AND user_id=? RETURNING source_sha256').bind(id,reader.id).first();if(!row)return missingJob();
 const keep=new URL(request.url).searchParams.get('keepSource')==='1',removable=!keep&&SHA.test(row.source_sha256||'')&&!await sourceInUse(env,reader.id,row.source_sha256);
 if(removable)await removeKeys(env,[sourceKey(reader.id,row.source_sha256)]);
 return reply({ok:true,removedSource:removable});
}

export async function bookJobRoute(request,env,path,reader){
 if(path!==base&&!path.startsWith(base+'/'))return null;
 const method=request.method,id=path.slice(base.length+1);
 if(path===base){
  if(method==='GET')return reply({jobs:(await env.DB.prepare('SELECT * FROM book_jobs WHERE user_id=? ORDER BY updated_at DESC,id LIMIT ?').bind(reader.id,MAX_JOBS).all()).results.map(jobFromRow)});
  if(method==='POST')return createJob(request,env,reader);
  return reply({error:'Phương thức không được hỗ trợ.'},405);
 }
 if(!UUID.test(id))return reply({error:'Mã lượt dịch không hợp lệ.',code:'bad_id'},400);
 if(method==='GET'){const row=await env.DB.prepare('SELECT * FROM book_jobs WHERE id=? AND user_id=?').bind(id,reader.id).first();return row?reply({job:jobFromRow(row)}):missingJob();}
 if(method==='PATCH')return updateJob(request,env,reader,id);
 if(method==='DELETE')return deleteJob(request,env,reader,id);
 return reply({error:'Phương thức không được hỗ trợ.'},405);
}
