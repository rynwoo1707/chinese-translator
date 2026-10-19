// Students' own books beyond their parts: the original PDF each range came from, the book cover, and what the browser
// needs to rebuild the whole book like the original (every page, the cover and untranslated pages from the original).
import {saveCover} from './covers.js';
import {fileDisposition} from './download-filename.js';
import {ownedBook,listBooks,storedRange,rangeStatement,publicPart,removeFile,removeKeys,sourceKey,sourceInUse} from './study-history.js';
import {bookJobRoute,storedSource,MAX_BOOK_PAGES} from './book-jobs.js';
import {SOURCE_MAX,tooLarge,UserError} from './http.js';
import {rangedPdfResponse} from './library-books.js';
import {rateLimit,dailyMax} from './rate-limit.js';
import {keepWritten} from './account.js';

const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const SHA=/^[a-f\d]{64}$/u,MB=1024*1024,GB=1024*MB;
// The key of a kept original lives with the history code, which also removes it once no item uses that file.
export {sourceKey};
const stat=async(env,key)=>env.FILES.head?env.FILES.head(key):env.FILES.get(key),exists=async(env,key)=>Boolean(await stat(env,key));

// Room for the originals an account keeps: accounts cost nothing to make, so neither the number of kept files nor their
// size may grow without bound. MAX_SOURCES_PER_USER (default 30 files) and MAX_SOURCE_MB_PER_USER (default 2048 MiB)
// set it; 0 turns a limit off. A file that does not fit makes room by removing originals nothing uses any more (no
// part, book cover or whole-book run), oldest first and only as many as needed, but only those kept over a day: a
// newer one may still be waiting for the run or the history save it was uploaded for. They go once the new file is
// stored; a refused or failed upload removes nothing.
const UNUSED_AFTER=24*3600000;
const ROOM_ADVICE='Hãy xóa trong Lịch sử dịch những bản dịch hoặc lượt dịch cả quyển không cần nữa (tệp gốc không còn phần nào dùng sẽ được xóa theo) rồi thử lại.';
const sizeLabel=bytes=>bytes>=GB?`${(bytes/GB).toFixed(1).replace('.',',')} GB`:bytes>=10*MB?`${Math.round(bytes/MB)} MB`:`${(bytes/MB).toFixed(1).replace('.',',')} MB`;
async function keptOriginals(env,userId){
 const prefix=sourceKey(userId,'').replace(/\.pdf$/u,''),items=[];let cursor;
 do{
  const page=await env.FILES.list({prefix,...(cursor?{cursor}:{})});
  for(const object of page.objects||[])items.push({key:object.key,sha256:object.key.slice(prefix.length).replace(/\.pdf$/u,''),size:Number(object.size)||0,uploaded:object.uploaded?new Date(object.uploaded).getTime()||0:0});
  cursor=page.truncated?page.cursor:undefined;
 }while(cursor);
 return items;
}
// What storing a new original of `bytes` takes: {free}, the unused originals to remove once it is stored (often none),
// or {status,reason} when it does not fit.
async function sourceRoom(env,userId,bytes,now=Date.now()){
 const maxCount=dailyMax(env,'MAX_SOURCES_PER_USER',30),maxBytes=dailyMax(env,'MAX_SOURCE_MB_PER_USER',2048)*MB;
 if(!maxCount&&!maxBytes||typeof env.FILES?.list!=='function')return {free:[]};
 const kept=await keptOriginals(env,userId),used=kept.reduce((sum,item)=>sum+item.size,0),free=[];
 const fits=()=>(!maxCount||kept.length-free.length<maxCount)&&(!maxBytes||used-free.reduce((sum,item)=>sum+item.size,0)+bytes<=maxBytes);
 for(const item of [...kept].sort((a,b)=>a.uploaded-b.uploaded)){
  if(fits())break;
  if(now-item.uploaded>=UNUSED_AFTER&&SHA.test(item.sha256)&&!await sourceInUse(env,userId,item.sha256))free.push(item);
 }
 if(fits())return {free};
 if(maxCount&&kept.length-free.length>=maxCount)return {status:429,reason:`tài khoản đã lưu ${maxCount} tệp PDF gốc, mức tối đa cho mỗi tài khoản`};
 return {status:413,reason:`các tệp PDF gốc của tài khoản đã chiếm ${sizeLabel(used)}, thêm tệp này (${sizeLabel(bytes)}) sẽ vượt mức ${sizeLabel(maxBytes)} cho mỗi tài khoản`};
}
// After the new original is stored; one that came into use meanwhile (a run started over it) stays.
async function freeRoom(env,userId,free){for(const item of free)if(!await sourceInUse(env,userId,item.sha256))await removeKeys(env,[item.key]);}
const roomRefused=room=>reply({error:`${room.reason[0].toUpperCase()}${room.reason.slice(1)}. ${ROOM_ADVICE}`,code:'sources_full'},room.status);
export async function keepSource(env,userId,sha256,file,{filename='',pages=null}={}){
 if(!SHA.test(sha256||''))return false;const key=sourceKey(userId,sha256);if(await exists(env,key))return false;
 const room=await sourceRoom(env,userId,Number(file?.size)||0);
 if(room.reason)throw new UserError(`Chưa lưu được bản PDF gốc đầy đủ vì ${room.reason}; khi tải cả quyển, Hoa Trí sẽ nhờ bạn chọn lại tệp gốc. ${ROOM_ADVICE}`,room.status,'sources_full');
 await env.FILES.put(key,file,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:String(filename||'').slice(0,240),pages:String(pages||'')}});
 await freeRoom(env,userId,room.free);return true;
}
// '' or missing: no page; 0: the student chose no cover; 1..: a page of the uploaded file.
function coverPage(value){
 if(value===null||value===undefined||value==='')return null;const page=Number(value);
 return Number.isInteger(page)&&page>=0&&page<=100000?page:undefined;
}

// Checks the first bytes before anything is stored, then hands storage those same bytes as a stream of the declared
// length (R2 takes a stream only when its length is known), so even 100 MiB never sits in the Worker's memory.
async function pdfStream(body,length){
 const reader=body.getReader(),head=[];let size=0;
 while(size<5){const {done,value}=await reader.read();if(done)break;head.push(value);size+=value.byteLength;}
 const first=new Uint8Array(size);let offset=0;for(const chunk of head){first.set(chunk,offset);offset+=chunk.byteLength;}
 if(new TextDecoder().decode(first.subarray(0,5))!=='%PDF-'){await reader.cancel().catch(()=>{});return null;}
 const stream=new ReadableStream({start(controller){controller.enqueue(first);},async pull(controller){const {done,value}=await reader.read();if(done)controller.close();else controller.enqueue(value);},cancel(reason){return reader.cancel(reason);}});
 if(typeof FixedLengthStream!=='function')return stream;
 const fixed=new FixedLengthStream(length);stream.pipeTo(fixed.writable).catch(()=>{});return fixed.readable;
}
const pageCount=value=>{const pages=/^\d{1,6}$/u.test(String(value||'').trim())?Number(value):0;return pages>=1&&pages<=MAX_BOOK_PAGES?pages:0;};
// The whole original of a book, for whole-book runs: streamed from the browser to the student's own folder, where R2
// checks the bytes against the hash the browser computed, so the key always names exactly this file. A file kept
// before (a range extraction, another device) is not uploaded again.
async function uploadSource(request,env,reader,sha256){
 const pages=pageCount(request.headers.get('X-PDF-Pages'));if(!pages)return reply({error:`Thiếu số trang của PDF hoặc số trang không hợp lệ (tối đa ${MAX_BOOK_PAGES}).`,code:'bad_pages'},400);
 let filename=null;try{filename=decodeURIComponent(request.headers.get('X-Source-Filename')||'').normalize('NFC').trim();}catch{}
 if(filename===null||/[\u0000-\u001f\u007f]/u.test(filename))return reply({error:'Tên tệp không hợp lệ.',code:'bad_filename'},400);
 filename=filename.slice(0,240);
 const key=sourceKey(reader.id,sha256),existing=await storedSource(env,reader.id,sha256);
 if(existing){
  // A copy kept without its page count gets it now, so later chunks can be checked against it.
  if(!existing.pages){const object=await env.FILES.get(key);if(object){await env.FILES.put(key,object.body,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:existing.filename||filename,pages:String(pages)}});const gone=await keepWritten(env,reader.id,[key]);if(gone)return gone;}}
  return reply({sha256,pages:existing.pages||pages,filename:existing.filename||filename,stored:false});
 }
 const declared=request.headers.get('Content-Length');
 if(!/^\d{1,12}$/u.test(declared||''))return reply({error:'Hãy gửi tệp PDF kèm độ dài tệp (Content-Length).',code:'length_required'},411);
 const length=Number(declared);if(length>SOURCE_MAX)return tooLarge(SOURCE_MAX);
 const body=length>=5&&request.body?await pdfStream(request.body,length):null;if(!body)return reply({error:'Tệp không phải PDF.',code:'not_pdf'},400);
 // Counted once the file is a PDF and fits the account's room for originals; a stored 100 MiB costs storage for as
 // long as the student keeps it.
 const fast=await rateLimit(env,[{binding:'HEAVY_LIMITER',key:`upload:${reader.id}`}]),room=fast?null:await sourceRoom(env,reader.id,length);
 const limited=fast||(room.reason?roomRefused(room):await rateLimit(env,[{daily:`pdf-source:${reader.id}`,max:dailyMax(env,'DAILY_SOURCE_UPLOADS_PER_USER',30),label:'tải tệp PDF gốc'}]));
 if(limited){await body.cancel().catch(()=>{});return limited;}
 try{await env.FILES.put(key,body,{sha256,httpMetadata:{contentType:'application/pdf'},customMetadata:{filename,pages:String(pages)}});}
 catch(error){if(error?.code===10037||/checksum|digest|10037/iu.test(String(error?.message||'')))return reply({error:'Nội dung tệp không khớp mã kiểm tra. Hãy chọn lại tệp rồi tải lên lại.',code:'checksum_mismatch'},400);throw error;}
 // A 100 MiB upload can outlast the deletion of its account, which has cleared the folder by then.
 const gone=await keepWritten(env,reader.id,[key]);if(gone)return gone;
 await freeRoom(env,reader.id,room.free);
 return reply({sha256,pages,filename,stored:true},201);
}

export async function studyBookRoute(request,env,path,reader){
 const jobResponse=await bookJobRoute(request,env,path,reader);if(jobResponse)return jobResponse;
 const source=path.match(/^\/api\/my\/study\/sources\/([^/]*)$/u);
 if(source){
  if(!['GET','HEAD','PUT'].includes(request.method))return reply({error:'Phương thức không được hỗ trợ.'},405);
  if(!SHA.test(source[1]))return reply({error:'Mã tệp không hợp lệ.',code:'bad_hash'},400);
  if(request.method==='PUT')return uploadSource(request,env,reader,source[1]);
  // HEAD: whether this original is kept, and with how many pages; a copy without a page count needs one PUT.
  if(request.method==='HEAD'){const stored=await storedSource(env,reader.id,source[1]);return new Response(null,{status:stored?.pages?200:404,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(stored?.pages?{'X-PDF-Pages':String(stored.pages)}:{})}});}
  return rangedPdfResponse(request,env,sourceKey(reader.id,source[1]),'Tài khoản chưa lưu PDF gốc này.');
 }
 const match=path.match(/^\/api\/my\/study\/books\/([^/]+)\/(cover|assembly)$/u);if(!match)return null;
 const book=await ownedBook(env,reader.id,match[1]);if(!book)return reply({error:'Không tìm thấy sách trong Thư viện riêng.'},404);
 if(match[2]==='assembly'&&request.method==='GET')return reply(await assembly(env,reader,book));
 if(match[2]==='cover'&&request.method==='POST')return uploadCover(request,env,reader,book);
 if(match[2]==='cover'&&request.method==='PATCH')return chooseCover(request,env,reader,book);
 return reply({error:'Phương thức không được hỗ trợ.'},405);
}

async function uploadCover(request,env,reader,book){
 const form=await request.formData(),page=coverPage(form.get('page')),sha256=String(form.get('sha256')||'').toLowerCase();
 if(page===undefined||page===0||sha256&&!SHA.test(sha256))return reply({error:'Trang bìa hoặc mã tệp không hợp lệ.'},400);
 const current=await env.DB.prepare('SELECT cover_key FROM stories WHERE id=? AND owner_user_id=?').bind(book.id,reader.id).first();
 // A cover the book already has is replaced only when the student confirmed it.
 if(current?.cover_key&&form.get('replace')!=='1')return reply({error:'Sách đã có ảnh bìa; ảnh hiện tại được giữ nguyên.',hasCover:true},409);
 const key=await saveCover(form.get('cover'),book.id,env);
 // Compare-and-set on the old key: two tabs saving at once cannot both win, and the loser's image is removed. So is the
 // image of a write that failed, or every retry after a database error would leave one more image nothing points to.
 let updated;
 try{updated=await env.DB.prepare('UPDATE stories SET cover_key=?,cover_page=?,cover_source_sha256=? WHERE id=? AND owner_user_id=? AND cover_key IS ?').bind(key,page,sha256||null,book.id,reader.id,current?.cover_key??null).run();}
 catch(error){await removeFile(env,key);throw error;}
 if(!updated?.meta?.changes){await removeFile(env,key);return reply({error:'Ảnh bìa vừa được đổi ở nơi khác. Hãy tải lại trang rồi thử lại.'},409);}
 // The new cover is saved; an old image that cannot be removed now must not report the replacement as failed.
 if(current?.cover_key?.startsWith('covers/'))await removeFile(env,current.cover_key);
 return reply({id:book.id,cover:{image:true,page,sha256:sha256||null}});
}
// Remembers which page of a file is the cover (or that it has none) without touching the cover image.
async function chooseCover(request,env,reader,book){
 const body=await request.json().catch(()=>({})),page=coverPage(body?.page),sha256=String(body?.sha256||'').toLowerCase();
 if(page===undefined||page===null||sha256&&!SHA.test(sha256))return reply({error:'Trang bìa hoặc mã tệp không hợp lệ.'},400);
 await env.DB.prepare('UPDATE stories SET cover_page=?,cover_source_sha256=? WHERE id=? AND owner_user_id=?').bind(page,sha256||null,book.id,reader.id).run();
 const row=await env.DB.prepare('SELECT cover_key FROM stories WHERE id=? AND owner_user_id=?').bind(book.id,reader.id).first();
 return reply({id:book.id,cover:{image:Boolean(row?.cover_key),page,sha256:sha256||null}});
}

async function assembly(env,reader,book){
 const [listed]=await listBooks(env,reader.id,book.id),parts=listed?.parts||[],statements=[];let budget=12;
 // Ranges saved before page lists existed read theirs back from the saved manifest once; a few per request bound the cost.
 // A text part with pages but no page list was read in the browser (no manifest), and a DOCX or EPUB part never has one.
 for(const part of parts){
  const older=part.mime==='application/pdf'||!part.pageStart&&/\.pdf$/iu.test(part.filename||'');
  if(part.pages||!older||!part.sessionId||!part.stateKey||budget<=0)continue;budget--;
  const range=await storedRange(env,reader.id,part.stateKey).catch(()=>null);if(!range)continue;
  Object.assign(part,{pageStart:range.start,pageEnd:range.end,totalPages:part.totalPages??range.total,sha256:part.sha256||range.sha256,pages:range.pages});statements.push(rangeStatement(env,reader.id,part.sessionId,range));
 }
 if(statements.length)await env.DB.batch(statements);
 const storedSources=[];
 for(const sha256 of new Set(parts.map(part=>part.sha256).filter(Boolean))){const object=await stat(env,sourceKey(reader.id,sha256));if(object)storedSources.push({sha256,pages:Number(object.customMetadata?.pages)||null,url:`/api/my/study/sources/${sha256}`});}
 // layout: translated with "Giữ bố cục PDF", so the part has (or can export) Vietnamese PDF pages; a text translation
 // (a PDF range read in the browser, a DOCX chapter…) has none, and only redoing the range in layout mode adds them.
 return {id:book.id,title:listed?.title||book.title,cover:listed?.cover||{image:false,page:null,sha256:null},parts:parts.map(part=>({...publicPart(part),layout:Boolean(part.pages)||part.mime==='application/pdf',file:part.mime==='application/pdf'?`/api/chapter-file/${encodeURIComponent(part.id)}`:null})),storedSources};
}
