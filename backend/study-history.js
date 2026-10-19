import {normalizeVietnameseText} from './vietnamese-text.js';
import {validateBlockTranslations} from '../frontend/pdf-box-layout.js';
import {logEvent,routeLabel} from './http.js';
// account.js imports this module too; its helpers are read when called, never while the modules load.
import * as account from './account.js';

import {SUBJECT_LABELS as DOMAINS} from './subject-glossaries.js';
// study_sessions.domain still has the CHECK of migration 0011; newer subjects live in the subject column (0017).
const CHECKED_DOMAINS=new Set(['general','math','history']);
const MODES=new Set(['economy','balanced','quality']);
const MAX_SOURCE=2_000_000,MAX_TRANSLATION=3_000_000,PREVIEW=1200;
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const stateKey=(userId,id)=>`study/${userId}/${id}/state.json`;
const translationKey=(userId,id)=>`study/${userId}/${id}/translation.txt`;
const assetFolder=(userId,assetId)=>`study/${userId}/pdf-layout/${assetId}/`;
// One copy of each uploaded original per student and file. The key is built from the reader's own id, so a hash can
// only ever name a file in that reader's folder.
export const sourceKey=(userId,sha256)=>`study/${userId}/sources/${sha256}.pdf`;
const UUID=/^[a-f\d-]{36}$/iu;
// Books a student may add to, reorder or delete: their own study stories, never admin, request or web books.
const STUDY_BOOK="(source_url LIKE 'study:%' OR source_url LIKE 'study-book:%')";
// Reader glossaries are edited by hand elsewhere; a malformed value must not make json_patch fail a save.
const jsonObject=column=>`CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column})='object' THEN ${column} ELSE '{}' END ELSE '{}' END`;
const validSha=value=>typeof value==='string'&&/^[a-f\d]{64}$/u.test(value)?value:null;

function cleanObject(value,limit=500){
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 return Object.fromEntries(Object.entries(value).filter(([key,item])=>!['__proto__','constructor','prototype'].includes(key)&&key.length<=100&&typeof item==='string'&&item.length<=100).slice(0,limit));
}
function validTextArray(value,maxItems=1000,maxTotal=MAX_TRANSLATION){
 if(!Array.isArray(value)||value.length>maxItems)return [];
 let total=0;const result=[];for(const item of value){const text=typeof item==='string'?item:'';total+=text.length;if(total>maxTotal)throw new Error('Lịch sử bản dịch vượt giới hạn lưu trữ.');result.push(text);}return result;
}
function normalizeState(body){
 const source=String(body.source||'');if(!source.trim()||source.length>MAX_SOURCE)throw new Error('Nguyên tác trong lịch sử phải từ 1 đến 2 triệu ký tự.');
 const parts=validTextArray(body.parts,1000,MAX_SOURCE),compact=value=>value.replace(/\s/gu,'');
 if(!parts.length||compact(parts.join(''))!==compact(source))throw new Error('Các phần dịch không khớp nguyên tác.');
 const translationParts=validTextArray(body.translationParts,parts.length,MAX_TRANSLATION),done=Math.max(0,Math.min(parts.length,Number.isInteger(body.done)?body.done:0));
 while(translationParts.length<parts.length)translationParts.push('');
 const translation=normalizeVietnameseText(translationParts.filter(Boolean).join('\n\n')).trim();
 const complete=done===parts.length&&parts.length>0&&translationParts.every(item=>item.trim());
 const pdfLayout=body.pdfLayout&&/^[a-f\d-]{36}$/iu.test(body.pdfLayout.assetId||'')?{assetId:body.pdfLayout.assetId}:null;
 return {version:1,source,parts,translationParts:translationParts.map(normalizeVietnameseText),done,context:String(body.context||'').slice(-1200),glossary:cleanObject(body.glossary),manualGlossary:cleanObject(body.manualGlossary),previousSource:String(body.previousSource||'').slice(-350),previousTranslation:normalizeVietnameseText(String(body.previousTranslation||'')).slice(-500),translation,complete,...(pdfLayout?{pdfLayout}:{})};
}
function cleanTitle(value,filename){
 const title=(String(value||'').trim()||String(filename||'').replace(/\.[^.]+$/u,'').trim()||'Bản dịch chưa đặt tên').normalize('NFC');
 if(title.length>200||/[\u0000-\u001f\u007f]/u.test(title))throw new Error('Tên lịch sử không hợp lệ.');return title;
}
const cleanFilename=value=>{const filename=String(value||'').trim();if(filename.length>260||/[\r\n\0]/u.test(filename))throw new Error('Tên tệp không hợp lệ.');return filename;};
async function existingSession(env,id,userId){return env.DB.prepare('SELECT * FROM study_sessions WHERE id=? AND user_id=?').bind(id,userId).first();}

// Page numbers count pages of the uploaded file; a range can be a list (12-14, 37), so start/end bound it and pages lists
// it in manifest order, which is also the page order of the rendered PDF.
function manifestRange(manifest){
 const numbers=(manifest?.pages||[]).map(page=>page.number).filter(Number.isInteger);if(!numbers.length)return null;
 return {start:Math.min(...numbers),end:Math.max(...numbers),total:Number.isInteger(manifest.totalPages)?manifest.totalPages:null,sha256:validSha(manifest.sourceSha256),pages:[...new Set(numbers)]};
}
const pageList=value=>{try{const pages=JSON.parse(value||'null');return Array.isArray(pages)&&pages.length&&pages.every(page=>Number.isInteger(page)&&page>0)?pages:null;}catch{return null;}};
// PDFs read in the browser have no manifest; their range only orders the student's own book, so the client's word is enough.
function bodyRange(value){
 if(!value||typeof value!=='object')return null;const {start,end}=value,total=value.total??null;
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>100000||total!==null&&(!Number.isInteger(total)||total<end||total>100000))return null;
 return {start,end,total};
}
const pageLabel=range=>range?.start?(range.start===range.end?`Trang ${range.start}`:`Trang ${range.start}–${range.end}`):'';
// A range keeping the book's own name is labelled by its pages, so the table of contents reads Trang 1–20, Trang 21–40…
const partTitle=(title,bookTitle,range)=>title===bookTitle&&pageLabel(range)||title;
const sameSource=(a,b)=>a.sha256&&b.sha256?a.sha256===b.sha256:Boolean(a.filename)&&a.filename===b.filename&&(a.totalPages||null)===(b.totalPages||null);
// Same-file ranges keep page order. Pages restart at 1 in every split file, so a range from another file goes to the
// end of the book, where the student can move it; its later siblings then follow it.
export function placeBookPart(parts,part){
 const list=parts.filter(item=>item.id!==part.id);let index=list.length;
 if(part.pageStart){
  const siblings=list.map((item,i)=>({item,i})).filter(({item})=>item.pageStart&&sameSource(item,part));
  const lower=siblings.filter(({item})=>item.pageStart<=part.pageStart).sort((a,b)=>b.item.pageStart-a.item.pageStart||b.i-a.i)[0];
  if(lower)index=lower.i+1;else if(siblings.length)index=Math.min(...siblings.map(({i})=>i));
 }
 return [...list.slice(0,index),part,...list.slice(index)];
}
// translatedAt: when the part's translation last changed; renaming or moving it changes only updatedAt.
const partFromRow=row=>({id:row.id,title:row.title,position:row.position??null,mime:row.mime||'text/plain',sessionId:row.session_id||null,stateKey:row.state_key||null,filename:row.filename||'',pageStart:row.page_start??null,pageEnd:row.page_end??null,totalPages:row.source_total_pages??null,sha256:row.source_sha256||null,pages:pageList(row.source_pages),updatedAt:row.updated_at||null,translatedAt:row.translated_at||row.updated_at||null});
export const publicPart=({stateKey,...part})=>part;
export async function ownedBook(env,userId,id){
 if(typeof id!=='string'||!UUID.test(id))return null;
 return env.DB.prepare(`SELECT id,title FROM stories WHERE id=? AND owner_user_id=? AND ${STUDY_BOOK}`).bind(id,userId).first();
}
export async function listBooks(env,userId,bookId=null){
 const rows=(await env.DB.prepare(`SELECT s.id AS book_id,s.title AS book_title,s.cover_key,s.cover_page,s.cover_source_sha256,c.id,c.title,c.position,c.mime,ss.id AS session_id,ss.state_key,ss.filename,ss.page_start,ss.page_end,ss.source_total_pages,ss.source_sha256,ss.source_pages,ss.updated_at,ss.translated_at
  FROM stories s LEFT JOIN chapters c ON c.story_id=s.id LEFT JOIN study_sessions ss ON ss.library_chapter_id=c.id AND ss.user_id=s.owner_user_id
  WHERE s.owner_user_id=? AND ${STUDY_BOOK.replaceAll('source_url','s.source_url')}${bookId?' AND s.id=?':''}
  ORDER BY s.created_at DESC,s.id,CASE WHEN c.position IS NULL THEN 1 ELSE 0 END,c.position,c.created_at,c.id LIMIT 2000`).bind(...(bookId?[userId,bookId]:[userId])).all()).results;
 const books=new Map();
 for(const row of rows){
  // cover.page: the page of file cover.sha256 kept as the cover (0 = the student chose none); image: a cover is set.
  if(!books.has(row.book_id))books.set(row.book_id,{id:row.book_id,title:row.book_title,cover:{image:Boolean(row.cover_key),page:row.cover_page??null,sha256:row.cover_source_sha256||null},parts:[]});
  const parts=books.get(row.book_id).parts;if(row.id&&!parts.some(part=>part.id===row.id))parts.push(partFromRow(row));
 }
 return [...books.values()];
}
// Ranges were not recorded before migration 0013; the saved manifest still has them. Only placing a range pays for this read.
export async function storedRange(env,userId,key){
 const stored=key?await env.FILES.get(key):null,state=stored?await stored.json():null,assetId=state?.pdfLayout?.assetId;if(!assetId||!UUID.test(assetId))return null;
 const asset=await env.FILES.get(`study/${userId}/pdf-layout/${assetId}/manifest.json`);return asset?manifestRange(await asset.json()):null;
}
export const rangeStatement=(env,userId,sessionId,range)=>env.DB.prepare('UPDATE study_sessions SET page_start=?,page_end=?,source_total_pages=?,source_sha256=COALESCE(source_sha256,?),source_pages=COALESCE(source_pages,?) WHERE id=? AND user_id=?').bind(range.start,range.end,range.total,range.sha256,range.pages?JSON.stringify(range.pages):null,sessionId,userId);
async function backfillRanges(env,userId,parts,limit=12){
 const statements=[];
 for(const part of parts){
  if(part.pageStart||!part.sessionId||!part.stateKey||limit<=0)continue;limit--;
  const range=await storedRange(env,userId,part.stateKey).catch(()=>null);if(!range)continue;
  Object.assign(part,{pageStart:range.start,pageEnd:range.end,totalPages:part.totalPages??range.total,sha256:part.sha256||range.sha256,pages:part.pages||range.pages});statements.push(rangeStatement(env,userId,part.sessionId,range));
 }
 return statements;
}
const pageRangeOf=part=>part.pageStart?{start:part.pageStart,end:part.pageEnd||part.pageStart}:null;
// Writes a new book order: positions 1..n, plus page labels for parts still named after the book once a page-labelled range joins.
function arrangeStatements(env,book,order,incoming){
 const statements=[],incomingLabel=pageLabel(pageRangeOf(incoming)),relabel=Boolean(incomingLabel)&&incoming.title===incomingLabel;
 for(const [index,part] of order.entries()){
  if(part===incoming)continue;
  if(part.position!==index+1)statements.push(env.DB.prepare('UPDATE chapters SET position=? WHERE id=? AND story_id=?').bind(index+1,part.id,book.id));
  const label=pageLabel(pageRangeOf(part));
  if(relabel&&label&&part.title===book.title)statements.push(env.DB.prepare('UPDATE chapters SET title=? WHERE id=? AND story_id=?').bind(label,part.id,book.id));
 }
 return statements;
}
const ownedChapter="story_id IN (SELECT id FROM stories WHERE owner_user_id=?)";
// A one-part book is the session itself and follows its name; inside a larger book only the session's own part is renamed.
async function renameStatements(env,userId,session,title){
 if(!session.library_story_id||!session.library_chapter_id)return [];
 const book=await env.DB.prepare('SELECT s.title,(SELECT COUNT(*) FROM chapters c WHERE c.story_id=s.id) AS parts FROM stories s WHERE s.id=? AND s.owner_user_id=?').bind(session.library_story_id,userId).first();if(!book)return [];
 const single=Number(book.parts)<=1,chapterTitle=single?title:partTitle(title,book.title,session.page_start?{start:session.page_start,end:session.page_end||session.page_start}:null);
 return [...(single?[env.DB.prepare('UPDATE stories SET title=? WHERE id=? AND owner_user_id=?').bind(title,session.library_story_id,userId)]:[]),env.DB.prepare(`UPDATE chapters SET title=? WHERE id=? AND ${ownedChapter}`).bind(chapterTitle,session.library_chapter_id,userId)];
}

async function moveSession(env,reader,existing,bookId){
 const target=await ownedBook(env,reader.id,bookId);if(!target)return reply({error:'Không tìm thấy sách đã chọn trong Thư viện riêng.'},404);
 if(!existing.library_chapter_id)return reply({error:'Chỉ gộp được bản dịch đã hoàn tất và có trong Thư viện riêng.'},409);
 const done=extra=>reply({id:existing.id,status:existing.status,libraryStoryId:target.id,libraryChapterId:existing.library_chapter_id,updatedAt:new Date().toISOString(),...extra});
 if(existing.library_story_id===target.id)return done({removedBookId:null});
 const source=existing.library_story_id?await ownedBook(env,reader.id,existing.library_story_id):null;if(!source)return reply({error:'Bản dịch này không nằm trong sách học tập của bạn.'},409);
 const chapter=await env.DB.prepare('SELECT id,title,position FROM chapters WHERE id=? AND story_id=?').bind(existing.library_chapter_id,source.id).first();if(!chapter)return reply({error:'Không tìm thấy phần sách của bản dịch này.'},409);
 const moving={id:chapter.id,title:chapter.title,position:null,sessionId:existing.id,stateKey:existing.state_key,filename:existing.filename||'',pageStart:existing.page_start??null,pageEnd:existing.page_end??null,totalPages:existing.source_total_pages??null,sha256:existing.source_sha256||null};
 const parts=(await listBooks(env,reader.id,target.id))[0]?.parts||[],backfill=await backfillRanges(env,reader.id,[moving,...parts]);
 // A part named after its old one-part book takes the new book's naming; a title the student chose is kept.
 moving.title=chapter.title===source.title?partTitle(existing.title,target.title,pageRangeOf(moving)):chapter.title;
 const order=placeBookPart(parts,moving),position=order.indexOf(moving)+1;
 const covers=(await env.DB.prepare('SELECT id,cover_key,cover_page,cover_source_sha256 FROM stories WHERE id IN (?,?) AND owner_user_id=?').bind(source.id,target.id,reader.id).all()).results,sourceCover=covers.find(row=>row.id===source.id),targetCover=covers.find(row=>row.id===target.id);
 const results=await env.DB.batch([
  ...backfill,
  env.DB.prepare(`UPDATE stories SET glossary=json_patch(${jsonObject('glossary')},COALESCE((SELECT ${jsonObject('old.glossary')} FROM stories old WHERE old.id=? AND old.owner_user_id=?),'{}')) WHERE id=? AND owner_user_id=?`).bind(source.id,reader.id,target.id,reader.id),
  env.DB.prepare('UPDATE chapters SET story_id=?,title=?,position=? WHERE id=? AND story_id=?').bind(target.id,moving.title,position,chapter.id,source.id),
  ...arrangeStatements(env,target,order,moving),
  // A whole-book run adding to the emptied book adds its next chunks to the book it was merged into.
  env.DB.prepare('UPDATE book_jobs SET story_id=? WHERE user_id=? AND story_id=? AND NOT EXISTS (SELECT 1 FROM chapters WHERE story_id=?)').bind(target.id,reader.id,source.id,source.id),
  env.DB.prepare('UPDATE study_sessions SET library_story_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').bind(target.id,existing.id,reader.id),
  // Only the empty study story goes; its files belong to the moved chapter and stay in storage.
  env.DB.prepare(`DELETE FROM stories WHERE id=? AND owner_user_id=? AND ${STUDY_BOOK} AND NOT EXISTS (SELECT 1 FROM chapters WHERE story_id=stories.id) AND NOT EXISTS (SELECT 1 FROM jobs WHERE story_id=stories.id)`).bind(source.id,reader.id)
 ]);
 const removed=Boolean(results.at(-1)?.meta?.changes);
 if(removed&&sourceCover?.cover_key)await handOverCover(env,reader.id,sourceCover,target.id,!targetCover?.cover_key);
 return done({removedBookId:removed?source.id:null});
}
// Removing an object nothing points to any more is best effort: a storage error must not fail a change already saved.
export const removeFile=(env,key)=>Promise.resolve().then(()=>env.FILES.delete(key)).catch(()=>{});
// A kept original stays while anything still needs it: a part translated from it, a book cover taken from it, or a
// whole-book run over it (every later chunk is cut from it).
export async function sourceInUse(env,userId,sha256){
 return Boolean(await env.DB.prepare('SELECT 1 AS used WHERE EXISTS (SELECT 1 FROM study_sessions WHERE user_id=?1 AND source_sha256=?2) OR EXISTS (SELECT 1 FROM stories WHERE owner_user_id=?1 AND cover_source_sha256=?2) OR EXISTS (SELECT 1 FROM book_jobs WHERE user_id=?1 AND source_sha256=?2)').bind(userId,sha256).first());
}
// The same for many objects (R2 deletes up to 1,000 keys per call) and for whole folders; failures are logged by route
// shape only, since keys hold account ids.
export async function removeKeys(env,keys){
 const unique=[...new Set(keys.filter(key=>typeof key==='string'&&key))];
 for(let i=0;i<unique.length;i+=1000){try{await env.FILES.delete(unique.slice(i,i+1000));}catch(error){logEvent('cleanup_error',{keys:unique.slice(i,i+1000).length,message:String(error?.message||'').slice(0,200)});}}
}
export async function removePrefix(env,prefix){
 if(typeof env.FILES?.list!=='function')return;
 let cursor;
 try{do{const page=await env.FILES.list({prefix,...(cursor?{cursor}:{})}),keys=page.objects.map(object=>object.key);if(keys.length)await env.FILES.delete(keys);cursor=page.truncated?page.cursor:undefined;}while(cursor);}
 catch(error){logEvent('cleanup_error',{prefix:routeLabel(prefix),message:String(error?.message||'').slice(0,200)});}
}
// The whole-book runs over a session's original, with the book each one adds its chunks to. Read before a delete: the
// delete may empty that book, which also clears the run's book.
async function jobBooks(env,userId,session){
 const sha256=validSha(session.source_sha256);if(!sha256||!pageList(session.source_pages))return [];
 return (await env.DB.prepare('SELECT id,story_id FROM book_jobs WHERE user_id=? AND source_sha256=?').bind(userId,sha256).all()).results||[];
}
// A whole-book run gets the pages of a deleted range back as pending (the job API itself never turns a done page back),
// unless a translation in the run's own book still holds them: a finished part of that book, never a draft, an
// unfinished range or a range of another book. A finished run becomes paused so it can resume.
async function releaseJobPages(env,userId,session,jobs){
 const sha256=validSha(session.source_sha256),pages=pageList(session.source_pages)||[];if(!sha256||!pages.length||!jobs.length)return;
 const parts=(await env.DB.prepare("SELECT library_story_id,source_pages FROM study_sessions WHERE user_id=? AND source_sha256=? AND status='complete' AND library_chapter_id IS NOT NULL").bind(userId,sha256).all()).results||[];
 for(const job of jobs){
  const covered=new Set(parts.filter(part=>job.story_id&&part.library_story_id===job.story_id).flatMap(part=>pageList(part.source_pages)||[]));
  // As a progress report does: written over the version read and redone on a newer one, so a report from the device
  // running the book at that moment is kept.
  for(let attempt=0;attempt<5;attempt++){
   const row=await env.DB.prepare('SELECT page_states,version FROM book_jobs WHERE id=? AND user_id=?').bind(job.id,userId).first();if(!row)break;
   const states=String(row.page_states||'').split(''),freed=pages.filter(page=>page>=1&&page<=states.length&&states[page-1]==='d'&&!covered.has(page));if(!freed.length)break;
   for(const page of freed)states[page-1]='.';
   const updated=await env.DB.prepare("UPDATE book_jobs SET page_states=?,status=CASE WHEN status='done' THEN 'paused' ELSE status END,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?").bind(states.join(''),new Date().toISOString(),job.id,userId,row.version).run();
   if(updated?.meta?.changes)break;
  }
 }
}
// A request that wrote files while its account was being deleted removes them again: the deletion has already cleared,
// or is clearing, the account's folders. Without account.js's check (an older build) only a missing account counts.
async function accountKept(env,userId,keys){
 let active=true;
 try{active=typeof account.accountActive==='function'?await account.accountActive(env,userId)!==false:Boolean(await env.DB.prepare('SELECT 1 AS active FROM reader_users WHERE id=?').bind(userId).first());}catch{}
 if(!active)await removeKeys(env,keys);
 return active;
}
const accountGone=()=>typeof account.accountDeleted==='function'?account.accountDeleted():reply({error:'Tài khoản này vừa bị xóa nên kết quả của thao tác không được lưu.',code:'account_deleted'},410);
// Deleting a history item takes its range out of the student's book (and the book itself once empty) and removes every
// file only that item used. A file another item still names stays: the same PDF asset, the same original upload, or
// the original a book's cover page comes from.
async function deleteSession(env,userId,session){
 let assetId=UUID.test(session.pdf_asset_id||'')?session.pdf_asset_id:null;
 // Saved before migration 0014: the saved state names the asset.
 if(!assetId){const state=await Promise.resolve().then(()=>env.FILES.get(session.state_key)).then(object=>object?object.json():null).catch(()=>null);assetId=UUID.test(state?.pdfLayout?.assetId||'')?state.pdfLayout.assetId:null;}
 const chapter=session.library_chapter_id?await env.DB.prepare(`SELECT c.id,c.story_id,c.file_key,c.text_key FROM chapters c JOIN stories s ON s.id=c.story_id WHERE c.id=? AND s.owner_user_id=? AND ${STUDY_BOOK.replaceAll('source_url','s.source_url')}`).bind(session.library_chapter_id,userId).first():null;
 const jobs=await jobBooks(env,userId,session);
 const results=await env.DB.batch([
  env.DB.prepare('DELETE FROM study_sessions WHERE id=? AND user_id=?').bind(session.id,userId),
  ...(chapter?[
   env.DB.prepare(`DELETE FROM chapters WHERE id=? AND ${ownedChapter}`).bind(chapter.id,userId),
   env.DB.prepare(`DELETE FROM stories WHERE id=? AND owner_user_id=? AND ${STUDY_BOOK} AND NOT EXISTS (SELECT 1 FROM chapters WHERE story_id=stories.id) AND NOT EXISTS (SELECT 1 FROM jobs WHERE story_id=stories.id)`).bind(chapter.story_id,userId),
   // A whole-book run whose book is gone starts a new book with its next chunk (the foreign key does the same).
   env.DB.prepare('UPDATE book_jobs SET story_id=NULL WHERE user_id=? AND story_id=? AND NOT EXISTS (SELECT 1 FROM stories WHERE id=?)').bind(userId,chapter.story_id,chapter.story_id)
  ]:[])
 ]);
 await releaseJobPages(env,userId,session,jobs);
 const removedBookId=chapter&&results[2]?.meta?.changes?chapter.story_id:null,own=`study/${userId}/`,folders=[`${own}${session.id}/`];
 let keys=[chapter?.file_key,chapter?.text_key].filter(key=>typeof key==='string'&&key.startsWith(own));
 if(assetId){
  const folder=assetFolder(userId,assetId),used=await env.DB.prepare(`SELECT 1 AS used WHERE EXISTS (SELECT 1 FROM study_sessions WHERE user_id=?1 AND pdf_asset_id=?2) OR EXISTS (SELECT 1 FROM chapters WHERE instr(file_key,?3)=1 AND story_id IN (SELECT id FROM stories WHERE owner_user_id=?1))`).bind(userId,assetId,folder).first();
  if(used)keys=keys.filter(key=>!key.startsWith(folder));else folders.push(folder);
 }
 const sha256=validSha(session.source_sha256);
 if(sha256&&!await sourceInUse(env,userId,sha256))keys.push(sourceKey(userId,sha256));
 if(removedBookId)folders.push(`covers/${removedBookId}/`);
 await removeKeys(env,keys);for(const folder of folders)await removePrefix(env,folder);
 return {ok:true,removedBookId};
}
// A book's cover image lives under covers/<its id>/, the folder cleared when that book is deleted. The emptied book's
// cover is stored again under the target's id when the target has none, and its old image is removed either way. The
// move is already saved: a storage error here costs the cover at most, never the move.
async function handOverCover(env,userId,from,targetId,adopt){
 if(!from.cover_key.startsWith('covers/'))return;
 const image=adopt?await Promise.resolve().then(()=>env.FILES.get(from.cover_key)).catch(()=>null):null;
 if(image){
  const key=`covers/${targetId}/${crypto.randomUUID()}`;let adopted=false;
  try{await env.FILES.put(key,await image.arrayBuffer(),{httpMetadata:image.httpMetadata});adopted=Boolean((await env.DB.prepare('UPDATE stories SET cover_key=?,cover_page=?,cover_source_sha256=? WHERE id=? AND owner_user_id=? AND cover_key IS NULL').bind(key,from.cover_page,from.cover_source_sha256,targetId,userId).run())?.meta?.changes);}catch{}
  if(!adopted)await removeFile(env,key);
 }
 await removeFile(env,from.cover_key);
}

async function studyBooksRoute(request,env,path,reader){
 const id=path.slice('/api/my/study/books'.length).replace(/^\//u,'');
 if(request.method==='GET'&&!id)return reply((await listBooks(env,reader.id)).map(book=>({...book,parts:book.parts.map(publicPart)})));
 if(request.method!=='PATCH'||!id)return reply({error:'Phương thức không được hỗ trợ.'},405);
 const book=await ownedBook(env,reader.id,id);if(!book)return reply({error:'Không tìm thấy sách trong Thư viện riêng.'},404);
 const body=await request.json(),statements=[];
 if(body.title!==undefined){if(typeof body.title!=='string'||!body.title.trim())return reply({error:'Hãy nhập tên sách.'},400);statements.push(env.DB.prepare('UPDATE stories SET title=? WHERE id=? AND owner_user_id=?').bind(cleanTitle(body.title),book.id,reader.id));}
 if(body.order!==undefined){
  // Page numbers restart in every split file, so the student's order is the authority; it must name each part once.
  const ids=((await listBooks(env,reader.id,book.id))[0]?.parts||[]).map(part=>part.id);
  if(!Array.isArray(body.order)||body.order.length!==ids.length||new Set(body.order).size!==ids.length||body.order.some(item=>!ids.includes(item)))return reply({error:'Thứ tự các phần không khớp với sách.'},400);
  statements.push(...body.order.map((chapterId,index)=>env.DB.prepare('UPDATE chapters SET position=? WHERE id=? AND story_id=?').bind(index+1,chapterId,book.id)));
 }
 if(!statements.length)return reply({error:'Không có thay đổi nào cho sách.'},400);
 await env.DB.batch(statements);
 const [updated]=await listBooks(env,reader.id,book.id);return reply({...updated,parts:updated.parts.map(publicPart)});
}

export async function studyHistoryRoute(request,env,path,reader){
 if(path==='/api/my/study/books'||path.startsWith('/api/my/study/books/'))return studyBooksRoute(request,env,path,reader);
 if(!path.startsWith('/api/my/study/history'))return null;
 if(!env.FILES?.get||!env.FILES?.put)return reply({error:'Lưu lịch sử chưa được cấu hình.'},503);
 const suffix=path.slice('/api/my/study/history'.length),id=suffix.startsWith('/')?suffix.slice(1):'';
 if(suffix&&(!id||id.includes('/')||id.length>100))return reply({error:'Mã lịch sử không hợp lệ.'},400);
 if(request.method==='GET'&&!id){
  const rows=(await env.DB.prepare(`SELECT id,title,filename,COALESCE(subject,domain) AS domain,mode,status,translated_parts,total_parts,source_characters,translation_characters,library_story_id,library_chapter_id,page_start,page_end,source_total_pages,source_sha256,created_at,updated_at
   FROM study_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`).bind(reader.id).all()).results;
  return reply(rows);
 }
 if(request.method==='GET'&&id){
  const row=await existingSession(env,id,reader.id);if(!row)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
  const stored=await env.FILES.get(row.state_key);if(!stored)return reply({error:'Nội dung lịch sử không còn tồn tại.'},410);
  return reply({...row,domain:row.subject||row.domain,state:await stored.json()});
 }
 if(request.method==='DELETE'){
  if(!id)return reply({error:'Hãy chọn bản dịch cần xóa.'},400);
  const existing=await existingSession(env,id,reader.id);if(!existing)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
  return reply(await deleteSession(env,reader.id,existing));
 }
 if(request.method==='PATCH'){
  if(!id)return reply({error:'Hãy chọn bản dịch cần đổi tên.'},400);
  const existing=await existingSession(env,id,reader.id);if(!existing)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
  const body=await request.json();if(Object.hasOwn(body,'bookId'))return moveSession(env,reader,existing,body.bookId);
  if(typeof body.title!=='string'||!body.title.trim())return reply({error:'Hãy nhập tên nội dung.'},400);
  const title=cleanTitle(body.title);
  await env.DB.batch([env.DB.prepare('UPDATE study_sessions SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').bind(title,id,reader.id),...await renameStatements(env,reader.id,existing,title)]);
  return reply({id,status:existing.status,libraryStoryId:existing.library_story_id,libraryChapterId:existing.library_chapter_id||null,updatedAt:new Date().toISOString()});
 }
 if(!['POST','PUT'].includes(request.method))return reply({error:'Phương thức không được hỗ trợ.'},405);
 if(request.method==='POST'&&id||request.method==='PUT'&&!id)return reply({error:'Đường dẫn lưu lịch sử không hợp lệ.'},400);
 const saved=id?await existingSession(env,id,reader.id):null;if(id&&!saved)return reply({error:'Không tìm thấy lịch sử dịch.'},404);
 const body=await request.json(),named=!id&&body?.id!==undefined?body.id:null;
 // A first save may name its session (a whole-book chunk does): sent again after its answer was lost, it saves that
 // session again instead of leaving a second one. An id another account's session has is refused.
 if(named!==null&&(typeof named!=='string'||!UUID.test(named)))return reply({error:'Mã lịch sử không hợp lệ.'},400);
 const existing=saved||(named?await existingSession(env,named,reader.id):null);
 if(named&&!existing&&await env.DB.prepare('SELECT 1 AS taken FROM study_sessions WHERE id=?').bind(named).first())return reply({error:'Mã lịch sử này đã được dùng.'},409);
 const sessionId=id||named||crypto.randomUUID(),filename=cleanFilename(body.filename),title=cleanTitle(body.title,filename),domain=Object.hasOwn(DOMAINS,body.domain)?body.domain:'general',checkedDomain=CHECKED_DOMAINS.has(domain)?domain:'general',mode=MODES.has(body.mode)?body.mode:'economy',state=normalizeState(body.state||{});
 // Of two parts translating the same page, the whole-book PDF uses the newer translation, so that time is kept apart
 // from renames and moves. A PDF range compares with its saved state; any other save counts as a change.
 let range=bodyRange(body.pageRange),sameTranslation=false;
 if(state.pdfLayout){
  const asset=await env.FILES.get(`study/${reader.id}/pdf-layout/${state.pdfLayout.assetId}/manifest.json`);if(!asset)return reply({error:'Không tìm thấy PDF trong tài khoản của bạn.'},404);
  const manifest=await asset.json(),blocks=manifest.pages.flatMap(p=>p.blocks);range=manifestRange(manifest);
  if(blocks.length!==state.parts.length||blocks.some((b,i)=>b.source!==state.parts[i]))throw new Error('Lịch sử block không khớp PDF gốc.');
  validateBlockTranslations(blocks,state.translationParts.map((translation,i)=>({id:blocks[i].id,translation})).filter(b=>b.translation.trim()),{complete:state.complete});
  state.translation=blocks.map((b,i)=>{let value=state.translationParts[i];for(const inline of b.inlines||[])value=value.replace(inline.token,inline.text);return value;}).filter(Boolean).join('\n\n');
  if(existing){const priorObject=await env.FILES.get(existing.state_key),prior=priorObject?await priorObject.json():null;sameTranslation=prior?.pdfLayout?.assetId===state.pdfLayout.assetId&&JSON.stringify(prior.translationParts)===JSON.stringify(state.translationParts);if(sameTranslation&&prior.pdfLayout.exported){state.pdfLayout.exported=true;state.pdfLayout.renderVersion=Number(prior.pdfLayout.renderVersion)||0;}}
 }
 const pages={start:range?.start??existing?.page_start??null,end:range?.end??existing?.page_end??null,total:range?.total??existing?.source_total_pages??null,sha256:range?.sha256||validSha(body.sha256)||existing?.source_sha256||null,list:range?(range.pages?JSON.stringify(range.pages):null):existing?.source_pages??null};
 // A session joins its book once: after it owns a chapter, only an explicit move (PATCH bookId) changes its book.
 let libraryStoryId=existing?.library_story_id||null,chapterId=existing?.library_chapter_id||null,book=null;
 if(!chapterId&&Object.hasOwn(body,'bookId')){
  if(body.bookId){book=await ownedBook(env,reader.id,body.bookId);if(!book)return reply({error:'Không tìm thấy sách đã chọn trong Thư viện riêng.'},404);}
  libraryStoryId=book?.id||null;
 }
 const key=stateKey(reader.id,sessionId),translatedKey=translationKey(reader.id,sessionId),status=state.complete?'complete':state.done?'translating':'draft';
 const statements=[],content=state.translation.slice(0,20000);let newChapter=false;
 // The private library copy keeps the student's terms so the reader can show the Chinese original on tap; every range adds to the book's terms.
 const glossaryStatement=storyId=>env.DB.prepare(`UPDATE stories SET glossary=json_patch(${jsonObject('glossary')},?),genre=CASE WHEN (SELECT COUNT(*) FROM chapters WHERE chapters.story_id=stories.id)<=1 THEN ? ELSE genre END WHERE id=? AND owner_user_id=?`).bind(JSON.stringify({...state.glossary,...state.manualGlossary}),DOMAINS[domain],storyId,reader.id);
 if(state.complete&&!chapterId){
  if(libraryStoryId&&!book)book=await ownedBook(env,reader.id,libraryStoryId);
  const part={id:crypto.randomUUID(),title,position:null,sessionId,filename,pageStart:pages.start,pageEnd:pages.end,totalPages:pages.total,sha256:pages.sha256};
  if(book){
   const parts=(await listBooks(env,reader.id,book.id))[0]?.parts||[],replaced=body.replaceChapterId?parts.find(item=>item.id===body.replaceChapterId):null;
   if(body.replaceChapterId&&!replaced)return reply({error:'Phần cần thay không thuộc sách đã chọn.'},400);
   part.title=partTitle(title,book.title,pages.start?pages:null);
   if(replaced){
    // A redone range takes over the old part (same place in the book); the superseded session leaves the library.
    chapterId=replaced.id;
    statements.push(env.DB.prepare(`UPDATE chapters SET title=?,content=?,text_key=?,file_key=NULL,mime=? WHERE id=? AND ${ownedChapter}`).bind(part.title,content,translatedKey,'text/plain',chapterId,reader.id));
    statements.push(env.DB.prepare('UPDATE study_sessions SET library_chapter_id=NULL,library_story_id=NULL WHERE library_chapter_id=? AND user_id=? AND id<>?').bind(chapterId,reader.id,sessionId));
   }else{
    statements.push(...await backfillRanges(env,reader.id,parts));
    const order=placeBookPart(parts,part);chapterId=part.id;newChapter=true;
    statements.push(env.DB.prepare('INSERT INTO chapters(id,story_id,title,content,text_key,mime,position) VALUES(?,?,?,?,?,?,?)').bind(chapterId,book.id,part.title,content,translatedKey,'text/plain',order.indexOf(part)+1),...arrangeStatements(env,book,order,part));
   }
   libraryStoryId=book.id;statements.push(glossaryStatement(book.id));
  }else{
   // A new book: later ranges can join it, so it is not tied to this session's id.
   libraryStoryId=crypto.randomUUID();chapterId=part.id;newChapter=true;
   statements.push(env.DB.prepare("INSERT INTO stories(id,title,author,genre,source_url,owner_user_id,visibility,glossary) VALUES(?,?,?,?,?,?, 'private',?)").bind(libraryStoryId,title,'Bản dịch cá nhân',DOMAINS[domain],`study-book:${libraryStoryId}`,reader.id,JSON.stringify({...state.glossary,...state.manualGlossary})));
   statements.push(env.DB.prepare('INSERT INTO chapters(id,story_id,title,content,text_key,mime,position) VALUES(?,?,?,?,?,?,?)').bind(chapterId,libraryStoryId,title,content,translatedKey,'text/plain',1));
  }
 }else if(state.complete&&chapterId){
  statements.push(env.DB.prepare(`UPDATE chapters SET content=?,text_key=? WHERE id=? AND ${ownedChapter}`).bind(content,translatedKey,chapterId,reader.id));
  if(libraryStoryId)statements.push(glossaryStatement(libraryStoryId));
  if(existing.title!==title)statements.push(...await renameStatements(env,reader.id,existing,title));
 }
 if(state.pdfLayout&&!state.pdfLayout.exported&&chapterId&&!newChapter){
  statements.push(env.DB.prepare(`UPDATE chapters SET file_key=NULL,mime=? WHERE id=? AND ${ownedChapter}`).bind('text/plain',chapterId,reader.id));
 }
 // The session references its book and chapter, so it is written after them in the transaction. A concurrent move changes
 // only the book of an existing chapter; keeping the stored book then avoids pointing back at a deleted story.
 statements.push(env.DB.prepare(`INSERT INTO study_sessions(id,user_id,title,filename,domain,subject,mode,status,state_key,source_preview,translation_preview,translated_parts,total_parts,source_characters,translation_characters,library_story_id,library_chapter_id,page_start,page_end,source_total_pages,source_sha256,source_pages,pdf_asset_id,translated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP END) ON CONFLICT(id) DO UPDATE SET translated_at=COALESCE(excluded.translated_at,study_sessions.translated_at,CURRENT_TIMESTAMP), title=excluded.title,filename=excluded.filename,domain=excluded.domain,subject=excluded.subject,mode=excluded.mode,status=excluded.status,state_key=excluded.state_key,source_preview=excluded.source_preview,translation_preview=excluded.translation_preview,translated_parts=excluded.translated_parts,total_parts=excluded.total_parts,source_characters=excluded.source_characters,translation_characters=excluded.translation_characters,library_story_id=CASE WHEN study_sessions.library_chapter_id IS NOT NULL AND study_sessions.library_chapter_id=excluded.library_chapter_id THEN study_sessions.library_story_id ELSE excluded.library_story_id END,library_chapter_id=excluded.library_chapter_id,page_start=excluded.page_start,page_end=excluded.page_end,source_total_pages=excluded.source_total_pages,source_sha256=excluded.source_sha256,source_pages=excluded.source_pages,pdf_asset_id=excluded.pdf_asset_id,updated_at=CURRENT_TIMESTAMP WHERE user_id=excluded.user_id`).bind(sessionId,reader.id,title,filename,checkedDomain,domain,mode,status,key,state.source.slice(0,PREVIEW),state.translation.slice(0,PREVIEW),state.done,state.parts.length,state.source.length,state.translation.length,libraryStoryId,chapterId,pages.start,pages.end,pages.total,pages.sha256,pages.list,state.pdfLayout?.assetId||null,sameTranslation?1:0));
 const written=[key,...(state.complete?[translatedKey]:[])];
 await env.FILES.put(key,JSON.stringify(state),{httpMetadata:{contentType:'application/json; charset=utf-8'}});
 if(state.complete)await env.FILES.put(translatedKey,state.translation,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
 // An account deleted meanwhile keeps none of this: its rows cannot be written (or went with it), its files go here.
 try{await env.DB.batch(statements);}catch(error){if(!await accountKept(env,reader.id,written))return accountGone();throw error;}
 if(!await accountKept(env,reader.id,written))return accountGone();
 // The save is done: an export that no longer matches is only removed on a best-effort basis, never failing the save.
 if(state.pdfLayout&&!state.pdfLayout.exported)await removeFile(env,`study/${reader.id}/pdf-layout/${state.pdfLayout.assetId}/translated.pdf`);
 return reply({id:sessionId,status,libraryStoryId,libraryChapterId:chapterId,updatedAt:new Date().toISOString()},existing?200:201);
}
