import {validateLayoutDocument,validateBlockTranslations,OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {recognizePdfBlocks,OCR_DOUBT_CODES} from './pdf-block-ocr.js';
import {applyOcrReadings} from './pdf-layout-apply.js';
import {isStudyModel} from './gemini-models.js';
import {fileDisposition} from './download-filename.js';
import {keepSource,sourceKey} from './study-books.js';
import {storedSource} from './book-jobs.js';
import {UserError,logEvent,bodyLimit,errorResponse} from './http.js';
import {Buffer} from 'node:buffer';
import {rateLimit,dailyMax,vietnamDay} from './rate-limit.js';
import {keepWritten} from './account.js';
import {holdLease,takeSlot,keepRenewed,leaseUse,slotCount} from './pdf-slots.js';
import {asciiJsonBytes} from '../services/pdf-layout/ascii-json.mjs';
import {readJsonShape} from './json-shape.js';
import {isMode,modeProfile,rereads,LAYOUT_VERSION,layoutStamp,untranslatedHan} from '../frontend/translation-modes.js';

const base='/api/my/study/pdf-layout';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const assetKey=(reader,id,file)=>`study/${reader.id}/pdf-layout/${id}/${file}`;
// The service returns PDFs as base64 inside JSON; Buffer decodes in one pass, without atob's binary string copy.
const decodeBytes=value=>{if(typeof value!=='string'||!value)throw new Error('Dịch vụ PDF trả dữ liệu không hợp lệ.');return Buffer.from(value,'base64');};
// 3: renderer rework (inline formula alignment, indents); older exports are re-rendered from saved translations, no Gemini call.
export const RENDER_VERSION=3;
const hex=digest=>[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
// Workers hash the upload as a stream (crypto.DigestStream), without another copy of up to 25 MB in memory.
async function sha256Hex(file){
 if(typeof crypto.DigestStream!=='function')return hex(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
 const digest=new crypto.DigestStream('SHA-256');await file.stream().pipeTo(digest);return hex(await digest.digest);
}
const localService=env=>{try{return ['127.0.0.1','localhost'].includes(new URL(env.PDF_LAYOUT_SERVICE_URL).hostname);}catch{return false;}};
export function serviceUrl(env){
 if(!env.PDF_LAYOUT_SERVICE_URL||!env.PDF_LAYOUT_SERVICE_TOKEN)return null;
 const url=new URL(env.PDF_LAYOUT_SERVICE_URL);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','pdf-layout'].includes(url.hostname)))throw new Error('Dịch vụ PDF cần HTTPS.');return url;
}
// The hash of the layout code this Worker checks pages with (npm run deploy sets PDF_LAYOUT_VERSION), or null when unset.
export const expectedLayout=env=>{const value=String(env?.PDF_LAYOUT_VERSION||'').trim();return /^[a-f\d]{8,64}$/u.test(value)?value:null;};
// Older service builds returned MuPDF/Tesseract's whole stderr as the error, with the real cause at the very end.
const SERVICE_NOISE=/Warning: Parameter not found: \S+|Error opening data file [^\n]*?\.traineddata|Please make sure the TESSDATA_PREFIX environment variable is set to your "tessdata" directory\.|Failed loading language '[^'\n]*'|Image too small to scale!! \([^)\n]*\)|Line cannot be recognized!!|Tesseract couldn't load any languages!|Could not initiali[sz]e tesseract\.?/giu;
// limit: 400 characters, more for an overflow answer, whose list of blocks the service already keeps short.
export function serviceErrorMessage(value,status,limit=400){
 const text=String(value||'').replace(SERVICE_NOISE,' ').replace(/\s+/gu,' ').trim();
 if(!text)return `Không xử lý được PDF (dịch vụ trả mã ${status}).`;
 return text.length>limit?`${text.slice(0,limit-1)}…`:text;
}
// What a PDF service failure tells the student's browser (whole-book.js classifyError), besides the message:
//  503 pdf_service_busy + Retry-After   every place of the service is taken: the same call works a little later;
//  503 pdf_unavailable + Retry-After    the service cannot be reached, answers garbage (restarting, network), refuses
//                                       the Worker (401/403/404: another token or URL, logged for the operator), or
//                                       could not start the browser of an export or read its font;
//  503 pdf_local_off + Retry-After      the service on this machine (a loopback URL) does not answer: still starting,
//                                       or never started (npm run dev starts only the web app), so the message names
//                                       start.cmd after a few short waits;
//  413 pdf_timeout | pdf_memory | pdf_too_large | pdf_crash   this selection is too heavy for one job: fewer pages work;
//  422 pdf_overflow + blocks            a translation is longer than its box (render): the message names each block
//                                       ("Trang N · đoạn k") and how to shorten it in Xưởng dịch; blocks [{page,id}] lets
//                                       the browser open them;
//  400 (no code)                        a problem of the file itself, e.g. "Trang 3: …".
// An older service sends no code; its known messages are recognised instead.
export const SERVICE_BUSY_SECONDS=20,SERVICE_DOWN_SECONDS=30,LOCAL_OFF_SECONDS=10;
const SERVICE_BUSY='Dịch vụ PDF đang bận vì nhiều người dùng cùng lúc. Hãy thử lại sau khoảng 20 giây.';
const HEAVY=[['timeout','pdf_timeout',/vượt thời gian cho phép/u],['memory','pdf_memory',/hết bộ nhớ|Không đủ bộ nhớ|MemoryError/u],['too_large','pdf_too_large',/vượt giới hạn dung lượng của dịch vụ/u],['crash','pdf_crash',/dừng đột ngột/u]];
const retrySeconds=(header,fallback)=>{const value=Number(String(header??'').trim());return Number.isInteger(value)&&value>=1&&value<=300?value:fallback;};
// The boxes an overflow answer names, as the service sent them (ids of the stored manifest, its page numbers).
const MAX_OVERFLOW_BLOCKS=3000;
const overflowBlocks=value=>(Array.isArray(value)?value:[]).slice(0,MAX_OVERFLOW_BLOCKS).filter(b=>Number.isInteger(b?.page)&&b.page>0&&typeof b.id==='string'&&/^p\d{1,5}-b\d{1,5}$/u.test(b.id)).map(({page,id})=>({page,id}));
export function serviceFailure(status,result,retryAfter=null){
 const code=String(result?.code||''),message=serviceErrorMessage(result?.error,status,code==='overflow'?600:400);
 if(status===503||code==='busy')return new UserError(SERVICE_BUSY,503,'pdf_service_busy',{retryAfter:retrySeconds(retryAfter,SERVICE_BUSY_SECONDS)});
 if(code==='overflow')return Object.assign(new UserError(message,422,'pdf_overflow'),{blocks:overflowBlocks(result?.blocks)});
 if(code==='browser'||code==='font')return unavailable(message);
 const heavy=HEAVY.find(([name,,pattern])=>code?code===name:pattern.test(message));
 return heavy?new UserError(message,413,heavy[1]):new Error(message);
}
const unavailable=message=>new UserError(message,503,'pdf_unavailable',{retryAfter:SERVICE_DOWN_SECONDS});
const SERVICE_DOWN='Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.';
const LOCAL_REFUSED='Dịch vụ PDF trên máy này không nhận yêu cầu của trang web: PDF_LAYOUT_SERVICE_TOKEN hoặc PDF_LAYOUT_SERVICE_URL trong .dev.vars khác với dịch vụ đang chạy. Hãy tắt Hoa Trí rồi chạy lại npm start.';
const LOCAL_OFF='Dịch vụ PDF trên máy này chưa chạy: hãy tắt Hoa Trí rồi khởi động lại bằng start.cmd (hoặc npm start). Nếu đã khởi động như vậy, xem các dòng [PDF] trong cửa sổ đó.';
// body: an object sent as JSON, or a stream (stream: a JSON body built from stored bytes); file: a PDF streamed as is.
// allPages: the pages are wanted all or not at all (a refresh), so the service lets the job use its whole time limit.
// quality 'fine' (a mode whose profile has sheets:'fine'): the service cuts scanned pages into smaller OCR sheets and
// sharper crops (manifest sheetQuality); an older service ignores the header and makes standard ones. Both headers go
// with a JSON body too (a refresh's, which carries the saved blocks), as the service reads them whatever the body.
async function service(env,operation,body,{file,pages,stream,allPages=false,quality}={}){
 const url=serviceUrl(env);if(!url)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');url.pathname=url.pathname.replace(/\/$/u,'')+'/'+operation;
 // The developer command only helps on the machine running the service; elsewhere students just need to wait.
 let response;
 try{response=await fetch(url,{method:operation==='font'?'GET':'POST',headers:{'Content-Type':file?'application/pdf':'application/json',Authorization:`Bearer ${env.PDF_LAYOUT_SERVICE_TOKEN}`,...(file?{'X-PDF-Pages':encodeURIComponent(pages||'')}:{}),...(allPages?{'X-PDF-All-Pages':'1'}:{}),...(quality==='fine'?{'X-PDF-Quality':'fine'}:{})},...(operation==='font'?{}:{body:file?file.stream():stream||JSON.stringify(body)}),signal:AbortSignal.timeout(280000),...(file||stream?{duplex:'half'}:{})});}
 catch(error){
  if(['TimeoutError','AbortError'].includes(error?.name))throw new UserError(operation==='render'?'Dịch vụ PDF xuất quá lâu. Hãy thử xuất lại sau ít phút.':'Dịch vụ PDF xử lý quá lâu. Hãy chọn ít trang hơn cho mỗi lượt.',413,'pdf_timeout');
  throw localService(env)?new UserError(LOCAL_OFF,503,'pdf_local_off',{retryAfter:LOCAL_OFF_SECONDS}):unavailable(SERVICE_DOWN);
 }
 // The service refused the Worker (another token: one side of "Đổi token" done, deploy/pdf-layout/README.md A.5) or has no
 // such route (PDF_LAYOUT_SERVICE_URL with a path): the operator's problem, which the log names; students only wait.
 if([401,403,404].includes(response.status)){await response.body?.cancel().catch(()=>{});logEvent('pdf_service_refused',{operation,status:response.status});throw unavailable(localService(env)?LOCAL_REFUSED:SERVICE_DOWN);}
 let result;
 try{result=await response.json();}catch{if(response.ok)throw new Error('Dịch vụ PDF trả dữ liệu không hợp lệ.');throw response.status===503?serviceFailure(503,null,response.headers.get('Retry-After')):unavailable(`Dịch vụ PDF tạm thời không phản hồi đúng (mã ${response.status}). Hãy thử lại sau.`);}
 if(!response.ok)throw serviceFailure(response.status,result,response.headers.get('Retry-After'));return result;
}
// Each extraction or export holds one of the service's few slots (an export starts a browser), so a student has one call
// at a time (a second one, from another tab or device, waits until the first is done) and a daily number of each.
// The leases (pdf-slots.js) are renewed while a call runs; one left by a Worker that stopped mid-call frees itself.
const BUSY_SECONDS=30;
const busy=()=>Response.json({error:'Tài khoản của bạn đang có một lượt xử lý PDF khác (tách trang hoặc xuất PDF) chưa xong. Hãy đợi lượt đó xong rồi thử lại.',code:'pdf_busy',retryAfter:BUSY_SECONDS},{status:429,headers:{'Cache-Control':'no-store','Retry-After':String(BUSY_SECONDS)}});
const serviceBusy=()=>Response.json({error:SERVICE_BUSY,code:'pdf_service_busy',retryAfter:SERVICE_BUSY_SECONDS},{status:503,headers:{'Cache-Control':'no-store','Retry-After':String(SERVICE_BUSY_SECONDS)}});
// Before the request body is read, the account's lease is taken and the site's slots are counted: a busy answer (429
// pdf_busy, 503 pdf_service_busy) never makes the Worker take in an upload of up to 25 MB. The browser then waits, asks
// /capacity, and sends the upload again once a slot looks free. read() takes the body in within its time limit
// (readWithin) while only the account's lease is renewed; a slot is taken once the body is in (503 pdf_service_busy when
// the last one went meanwhile), so an upload, however slow, never keeps the service from other students.
async function withLeases(env,reader,read,work){
 const account=await holdLease(env,`pdf:${reader.id}`);if(!account)return busy();
 const leases=[account];
 try{
  const use=await leaseUse(env,reader.id);if(use&&use.taken>=slotCount(env))return serviceBusy();
  const body=await keepRenewed(leases,read);
  const slot=await takeSlot(env);if(!slot)return serviceBusy();leases.push(slot);
  return await keepRenewed(leases,()=>work(body));
 }finally{await Promise.all(leases.map(lease=>lease.release()));}
}
// How long a request body may take to arrive: two minutes, or longer for a large upload on a slow connection (UPLOAD_RATE
// bytes a second over the length the browser declared, or over the route's limit when it declared none). Past it the
// upload is stopped and the call answers 408 upload_timeout with its lease released and no daily call used, so a body
// trickled in a byte at a time holds nothing for long.
const BODY_SECONDS=120,UPLOAD_RATE=16*1024;
export function bodyDeadline(request,path){
 const declared=Number(request.headers.get('Content-Length')),limit=bodyLimit(path,request.method);
 return Math.max(BODY_SECONDS,Math.ceil((declared>0?Math.min(declared,limit):limit)/UPLOAD_RATE))*1000;
}
const UPLOAD_TOO_SLOW='Kết nối mạng quá chậm nên máy chủ chưa nhận hết dữ liệu gửi lên và đã dừng lượt xử lý PDF này. Hãy kiểm tra mạng (ví dụ chuyển sang Wi-Fi) rồi thử lại.';
const LATE=Symbol('late');
// The body read with parse (formData or json) through a stream this call can stop: the bytes are passed on as they
// arrive, and past bodyDeadline the upload is cancelled instead of waited for (the parser's own reader of the request
// body could not be cancelled).
async function readWithin(request,path,parse){
 const source=request.body?.getReader();if(!source)return parse(request);
 const body=new ReadableStream({async pull(controller){const {done,value}=await source.read();if(done)controller.close();else controller.enqueue(value);},cancel:reason=>source.cancel(reason)});
 const type=request.headers.get('Content-Type'),parsing=parse(new Response(body,{headers:type?{'Content-Type':type}:{}}));
 let timer;const late=new Promise(resolve=>{timer=setTimeout(resolve,bodyDeadline(request,path),LATE);});
 try{
  const result=await Promise.race([parsing,late]);if(result!==LATE)return result;
  parsing.catch(()=>{});await source.cancel(new Error('upload too slow')).catch(()=>{});
  throw new UserError(UPLOAD_TOO_SLOW,408,'upload_timeout');
 }finally{clearTimeout(timer);}
}
// GET /capacity: a hint for a browser waiting out pdf_busy or pdf_service_busy, from one read of D1. It takes no lease and
// counts toward no cap; the call itself still takes both leases, so a slot that looked free may be gone by then.
async function capacity(env,reader){
 const slots=slotCount(env),use=await leaseUse(env,reader.id),free=Math.max(0,slots-(use?.taken||0));
 const retryAfter=use?.mine?BUSY_SECONDS:free?null:SERVICE_BUSY_SECONDS;
 return reply({busy:retryAfter!==null,free,slots,retryAfter});
}
// The daily cap is counted once the request is valid, so neither waiting for a lease nor a refused request uses up the
// day's calls. A call the service did not do (out of reach, refusing the Worker, busy) gives its count back, and so does
// an error marked giveBack (a refresh too heavy for one job keeps nothing, and the student needs the count to extract
// those pages again) or an answer marked notKept (an export a save from another tab overtook is not kept).
const extractionCap=(env,reader)=>({daily:`pdf-extract:${reader.id}`,max:dailyMax(env,'DAILY_PDF_EXTRACTS_PER_USER',100),label:'tách PDF'});
const renderCap=(env,reader)=>({daily:`pdf-render:${reader.id}`,max:dailyMax(env,'DAILY_PDF_RENDERS_PER_USER',100),label:'xuất PDF tiếng Việt'});
const NOT_DONE=new Set(['pdf_unavailable','pdf_local_off','pdf_service_busy']);
const notKept=new WeakSet(),refused=response=>{notKept.add(response);return response;};
async function counted(env,cap,work){
 const day=vietnamDay(),capped=await rateLimit(env,[cap]);if(capped)return capped;
 let answer;
 try{answer=await work();}
 catch(error){if(NOT_DONE.has(error?.code)||error?.giveBack)await giveBack(env,cap.daily,day);throw error;}
 if(notKept.has(answer))await giveBack(env,cap.daily,day);
 return answer;
}
async function giveBack(env,key,day){
 if(typeof env?.DB?.prepare!=='function')return;
 try{await env.DB.prepare('UPDATE rate_limits SET count=count-1 WHERE key=? AND window_start=? AND count>0').bind(key,day).run();}
 catch(error){logEvent('rate_limit_error',{table:'rate_limits',name:error?.name,message:String(error?.message||'').slice(0,200)});}
}
// The preview font (~800 KB of base64 CSS) is the same for every student: the browser keeps it a day, then asks again
// with its ETag and gets a 304 when nothing changed. The Worker keeps it a few minutes, so a class opening the viewer
// at once does not fetch it from the service once per student.
const FONT_TTL_MS=10*60*1000;
let fontCache=null;
async function previewFont(env){
 const source=serviceUrl(env)?.href||'';
 if(fontCache?.source===source&&fontCache.expires>Date.now())return fontCache;
 const result=await service(env,'font');if(typeof result?.css!=='string'||!result.css.includes('@font-face'))throw new Error('Dịch vụ PDF trả phông chữ không hợp lệ.');
 const body=JSON.stringify({css:result.css}),digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)));
 fontCache={source,body,etag:`"${[...digest.subarray(0,16)].map(x=>x.toString(16).padStart(2,'0')).join('')}"`,expires:Date.now()+FONT_TTL_MS};
 return fontCache;
}
// If-None-Match lists tags; a CDN that compressed the body may have made ours weak (W/"…"), which still names it.
const etagMatches=(header,etag)=>String(header||'').split(',').map(tag=>tag.trim().replace(/^W\//u,'')).some(tag=>tag==='*'||tag===etag);
async function fontResponse(request,env){
 const font=await previewFont(env),headers={'Cache-Control':'private, max-age=86400','ETag':font.etag};
 if(etagMatches(request.headers.get('If-None-Match'),font.etag))return new Response(null,{status:304,headers});
 return new Response(font.body,{headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
}
function validAsset(id){if(!/^[a-f\d-]{36}$/iu.test(id||''))throw new Error('Mã PDF không hợp lệ.');return id;}
// A re-extracted selection keeps the stored page numbers; block, sheet and strip IDs follow them.
function renumberPage(page,number){
 const id=value=>value.replace(/^p\d+-/u,`p${number}-`);page.number=number;
 for(const block of page.blocks){block.id=id(block.id);if(typeof block.ocrSheet==='string')block.ocrSheet=id(block.ocrSheet);}
 for(const sheet of page.ocrSheets||[]){sheet.id=id(String(sheet.id));for(const strip of sheet.strips||[])strip.blockId=id(String(strip.blockId));}
}
// Memory: a scanned chunk's manifest is mostly page images (base64), up to about 18 MB, and the Worker has 128 MB for
// every request it runs at once. So a manifest is written as ASCII-only JSON (ascii-json.mjs: one byte per character in
// V8, where one Chinese character would make the whole text two), encoded once, stored, and sent on as those same bytes
// (replyWith, the render request) instead of being serialised again; GET streams it from storage.
const encoder=new TextEncoder(),manifestBytes=document=>asciiJsonBytes(document);
const putManifest=(env,key,bytes)=>env.FILES.put(key,bytes,{httpMetadata:{contentType:'application/json'}});
async function storedDocument(env,reader,id){const object=await env.FILES.get(assetKey(reader,validAsset(id),'manifest.json'));return object?object.json():null;}
// {fields…, [key]: <stored JSON bytes>} as a streamed answer: the bytes are neither parsed nor copied.
// value: the bytes, or a stream of them (a stored object's body, read as it is sent).
function jsonStream(fields,key,value){
 const head=JSON.stringify(fields),parts=[encoder.encode(`${head.slice(0,-1)}${head.length>2?',':''}${JSON.stringify(key)}:`),value,encoder.encode('}')];let reader=null;
 return new ReadableStream({
  async pull(controller){
   for(;;){
    if(reader){const {done,value:chunk}=await reader.read();if(!done)return controller.enqueue(chunk);reader=null;continue;}
    const part=parts.shift();if(!part)return controller.close();
    if(part instanceof Uint8Array)return controller.enqueue(part);reader=part.getReader();
   }
  },
  cancel(reason){return reader?.cancel(reason);}
 });
}
const replyWith=(fields,key,bytes,status=200)=>new Response(jsonStream(fields,key,bytes),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
// A stored file (its body: a stream, or bytes) as a JSON string of its base64, encoded as it is read: whole 3-byte groups
// of each chunk, the rest carried to the next. A refresh sends a PDF of up to 25 MB this way, never holding it or its
// base64 whole.
export function base64Value(body){
 const reader=(typeof body?.getReader==='function'?body:new Response(body).body).getReader();let carry=new Uint8Array(0),state='start';
 return new ReadableStream({
  async pull(controller){
   if(state==='start'){state='body';return controller.enqueue(encoder.encode('"'));}
   if(state==='end')return controller.close();
   // A pull that enqueues nothing is not called again, so a chunk shorter than a group reads on.
   for(;;){
    const {done,value}=await reader.read();
    if(done){state='end';return controller.enqueue(encoder.encode(`${Buffer.from(carry).toString('base64')}"`));}
    let bytes=value;if(carry.length){bytes=new Uint8Array(carry.length+value.length);bytes.set(carry);bytes.set(value,carry.length);}
    const whole=bytes.length-bytes.length%3;carry=bytes.slice(whole);
    if(whole)return controller.enqueue(encoder.encode(Buffer.from(bytes.buffer,bytes.byteOffset,whole).toString('base64')));
   }
  },
  cancel(reason){return reader.cancel(reason);}
 });
}
// The last page a page list names, in the service's syntax ("1-5,7"), or 0 when the list is not valid.
function lastPage(spec){
 let last=0;
 for(const part of spec.split(',')){const match=/^(\d{1,5})(?:[-–](\d{1,5}))?$/u.exec(part);if(!match)return 0;const start=Number(match[1]),end=Number(match[2]||match[1]);if(start<1||end<start)return 0;last=Math.max(last,end);}
 return last;
}
// Service messages count pages of the file it was sent ("Trang 3: …", "(trang 1–5, 7)"); the student reads page numbers
// of the original, where a chunk's page N is page offset+N.
const shiftPageNumbers=(text,offset)=>String(text).replace(/([Tt]rang\s+)(\d+(?:\s*[–-]\s*\d+)?(?:\s*,\s*\d+(?:\s*[–-]\s*\d+)?)*)/gu,(match,word,list)=>word+list.replace(/\d+/gu,number=>String(Number(number)+offset)));
// Stores an extraction (manifest and the selected pages' PDF) under a new asset and answers 201 with it.
async function keepExtraction(env,reader,id,document,original,{filename,also=[]}){
 const written=[...also,assetKey(reader,id,'manifest.json'),assetKey(reader,id,'original.pdf')],bytes=manifestBytes(document);
 await putManifest(env,written.at(-2),bytes);
 await env.FILES.put(written.at(-1),original,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename}});
 return await keepWritten(env,reader.id,written)||replyWith({assetId:id,originalUrl:`${base}/assets/${id}/original`},'document',bytes,201);
}
// The OCR sheets an extraction asks for: the request's "Cách dịch" (form field mode; none or an unknown one is economy)
// decides. The manifest records what the service made (sheetQuality), and a refresh asks for that again.
const sheetQuality=mode=>modeProfile(mode).sheets;
// A chunk the browser cut from an original stored for a whole-book run (sourceSha256), starting after page pageOffset.
// The manifest numbers pages, block IDs and warnings as pages of the original and names that file, so the part joins its
// book like a range of the whole file. The chunk itself is not kept: the original already is. Runs inside withLeases.
async function extractChunk(env,reader,form,file){
 const sha256=String(form.get('sourceSha256')||''),offsetValue=String(form.get('pageOffset')||'').trim()||'0',pages=String(form.get('pages')||'').replace(/\s/gu,'');
 if(!/^[a-f\d]{64}$/u.test(sha256))throw new UserError('Mã tệp gốc không hợp lệ.',400,'bad_hash');
 if(!/^\d{1,5}$/u.test(offsetValue))throw new UserError('Vị trí của phần cắt trong tệp gốc không hợp lệ.',400,'bad_offset');
 const offset=Number(offsetValue),last=lastPage(pages);if(!last)throw new UserError('Phạm vi trang không hợp lệ.',400,'bad_pages');
 const source=await storedSource(env,reader.id,sha256);
 if(!source)return reply({error:'Tài khoản chưa lưu tệp gốc này. Hãy tải tệp gốc lên trước.',code:'source_missing'},404);
 if(!source.pages)throw new UserError('Chưa rõ số trang của tệp gốc đã lưu. Hãy tải tệp gốc lên lại.',409,'source_pages');
 if(offset+last>source.pages)throw new UserError(`Trang ${offset+last} vượt quá ${source.pages} trang của tệp gốc.`,400,'bad_pages');
 return counted(env,extractionCap(env,reader),async()=>{
  const shift=text=>offset?shiftPageNumbers(text,offset):text;
  let result;try{result=await service(env,'extract',null,{file,pages,quality:sheetQuality(form.get('mode'))});}catch(error){if(error?.constructor===Error||error instanceof UserError)error.message=shift(error.message);throw error;}
  const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
  for(const page of document.pages)renumberPage(page,offset+page.number);
  if(Array.isArray(document.warnings))document.warnings=document.warnings.map(warning=>typeof warning==='string'?shift(warning):warning);
  // Pages with nothing to translate are answered with their numbers, so a run can mark exactly those pages (the service
  // may stop before the last requested page when a chunk is too heavy): blank, or, when Chinese stays printed on them
  // outside every block (page.untranslated: in a figure, a rotated watermark…), untranslated, with the extractor's notes.
  if(!document.pages.some(p=>p.blocks.length))return reply({error:'Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.',code:'no_text',pages:document.pages.map(p=>p.number),untranslated:document.pages.filter(p=>untranslatedHan(p)>0).map(p=>p.number),warnings:(document.warnings||[]).filter(note=>typeof note==='string').slice(0,40)},422);
  const original=decodeBytes(result.originalPdfBase64);result=null;
  document.totalPages=source.pages;document.sourceSha256=sha256;
  return keepExtraction(env,reader,id,document,original,{filename:source.filename||file.name});
 });
}
// The blocks an OCR call reads and the stored sheets they sit on, checked against the manifest. most: the blocks one call
// may name (a re-read: the mode's ocrBatch.blocks).
function ocrSelection(document,blockIds,most=OCR_LIMITS.sheetBlocks){
 if(!Array.isArray(blockIds)||!blockIds.length||blockIds.length>Math.min(most,OCR_LIMITS.sheetBlocks)||new Set(blockIds).size!==blockIds.length)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
 const pages=document.pages.filter(p=>p.ocr),all=pages.flatMap(p=>p.blocks),blocks=blockIds.map(id=>all.find(b=>b.id===id));if(blocks.some(b=>!b))throw new Error('Đoạn OCR không thuộc PDF đã chọn.');
 // Blocks packed into stored sheets are read a whole sheet at a time: the request names every block of each sheet it
 // touches and nothing else. Older manifests (no sheets) keep one image per block, at most 6 per call.
 const stored=new Map(pages.flatMap(p=>p.ocrSheets||[]).map(s=>[s.id,s])),sheets=[...new Set(blocks.map(b=>b.ocrSheet).filter(Boolean))].map(id=>stored.get(id));
 if(sheets.length?sheets.some(s=>!s)||blocks.some(b=>!b.ocrSheet)||sheets.reduce((n,s)=>n+s.strips.length,0)!==blocks.length||sheets.some(s=>s.strips.some(strip=>!blockIds.includes(strip.blockId))):blocks.length>OCR_LIMITS.images)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
 return {blocks,sheets};
}
// The blocks a re-read was asked for (rereadIds), each once, among those the call names.
function rereadSelection(ids,blockIds){
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!blockIds.includes(id)))throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
 return ids;
}
// Page numbers as the page range field takes them: [12,13,14,37] → "12-14, 37" (extract.py page_ranges).
const pageList=numbers=>numbers.reduce((parts,n,i)=>{if(i&&n===numbers[i-1]+1)parts.at(-1)[1]=n;else parts.push([n,n]);return parts;},[]).map(([a,b])=>a===b?String(a):`${a}-${b}`).join(', ');
// A refresh replaces a stored range only whole, so a range too heavy for one job of the service (out of time, memory or
// room, or answered with fewer pages) keeps the old copy, which stays usable, and says how to go on.
const HEAVY_CODES=new Set(['pdf_timeout','pdf_memory','pdf_too_large','pdf_crash']);
// What a refresh reads of the stored manifest: its stamps, the pages' kind, the blocks' boxes, formula crops, sources and
// readings; never its images (json-shape.js).
const PRIOR_SHAPE={extractionVersion:true,totalPages:true,sourceSha256:true,sheetQuality:true,pages:[{number:true,ocr:true,extractionVersion:true,blocks:[{id:true,box:true,source:true,ocrCorrected:true,ocrHint:true,ocrKept:true,ocrDoubt:true,ocrRereads:true,keepPixels:true,kind:true,bold:true,inlines:[{token:true,box:true}]}]}]};
// A scanned block whose saved reading is final: Gemini's, keeping neither the machine text (ocrKept) nor the page's pixels
// (keepPixels), with no doubt left for its reading again. Found again it gets no OCR crop (extract.py known), so a block
// still to be read, or read again, is never named.
const finalReading=b=>b.ocrCorrected===true&&typeof b.ocrKept!=='string'&&b.keepPixels!==true&&!(typeof b.ocrDoubt==='string'&&!(b.ocrRereads>0));
// The saved blocks a refresh names (extract.py payload known), by the page's place in the stored original (1 = its first
// page, not the book page): on a scan those with a final reading, with their formula crops in token order; on a text
// layer every block, with its source (only an equal source matches there).
export function knownBlocks(document){
 return document.pages.map((page,i)=>{const scan=page.ocr===true;return {page:i+1,ocr:scan,blocks:(page.blocks||[]).filter(b=>!scan||finalReading(b)).map(b=>({id:b.id,box:b.box,...(scan?{inlines:(b.inlines||[]).map(inline=>inline?.box??null)}:{source:b.source})}))};});
}
// A refreshed scan block found again takes its saved reading over the new machine text: the source with its formula tokens
// renamed in order (the crops are the same, by the service's rule), the text with the new crops' machine text, and the
// reading's marks. The machine text it had becomes the hint a reading again is checked with, unless one was kept.
function carryReading(block,saved){
 const from=(saved.inlines||[]).map(inline=>inline?.token),to=(block.inlines||[]).map(inline=>inline.token),hint=typeof saved.ocrHint==='string'?saved.ocrHint:block.source;let source=String(saved.source??'');
 if(from.length===to.length&&from.some((token,k)=>token!==to[k])){from.forEach((token,k)=>{source=source.split(token).join(`\u0000${k}\u0000`);});to.forEach((token,k)=>{source=source.split(`\u0000${k}\u0000`).join(token);});}
 let text=source;for(const inline of block.inlines||[])text=text.replace(inline.token,()=>inline.text);
 Object.assign(block,{source,text,ocrCorrected:true,ocrHint:hint});
 if(typeof saved.ocrDoubt==='string')block.ocrDoubt=saved.ocrDoubt;else delete block.ocrDoubt;
 if(Number.isInteger(saved.ocrRereads)&&saved.ocrRereads>0)block.ocrRereads=saved.ocrRereads;
 for(const field of ['kind','bold'])if(saved[field]!==undefined)block[field]=saved[field];
}
const refreshTooHeavy=(pages,code)=>Object.assign(new UserError(`Chưa cập nhật được bố cục của bản dịch này: ${pages.length} trang của nó (trang ${pageList(pages)}) quá nặng để dịch vụ PDF xử lý hết trong một lượt. Bản dịch cũ vẫn còn nguyên trong Lịch sử dịch. Hãy chọn lại PDF gốc rồi dịch lại các trang đó thành nhiều lượt nhỏ hơn, ví dụ 3–5 trang mỗi lượt.`,413,code),{giveBack:true});
// An export made while another tab or device saved its session is kept when the session, as stored now, still holds what
// the PDF was made from (madeFrom: the same asset, finished, with the same blocks and the same translation of each),
// whatever else that save changed: the same text saved again leaves the PDF true. Otherwise it is not kept, the day's
// export is given back, and the answer is the one a save from an older copy gets (409 history_conflict with the revision
// stored now), so the browser reloads the session before it exports again.
const madeFrom=state=>JSON.stringify([state?.pdfLayout?.assetId??null,state?.complete===true,state?.parts??null,state?.translationParts??null]);
const parsedState=text=>{try{return JSON.parse(text);}catch{return null;}};
const EXPORT_CONFLICT='Bản dịch này vừa được lưu từ một tab hoặc thiết bị khác trong lúc xuất PDF, nên PDF vừa dựng không khớp bản mới nhất và chưa được lưu. Hãy mở lại bản dịch từ Lịch sử dịch rồi bấm Xuất PDF tiếng Việt.';
const SERVICE_OUTDATED='Dịch vụ PDF chưa được cập nhật cùng phiên bản với trang web, nên PDF vừa dựng chưa được lưu và lượt xuất này không bị tính. Hãy thử xuất lại sau ít phút.';
const REFRESH_OUTDATED='Dịch vụ PDF vẫn dùng bộ tách trang cũ nên chưa cập nhật được bố cục: không có gì thay đổi, không tốn token và lượt tách này không bị tính. Hãy thử lại sau khi dịch vụ PDF được cập nhật (trên máy này: tắt Hoa Trí rồi khởi động lại bằng start.cmd).';
const stat=(env,key)=>env.FILES.head?env.FILES.head(key):env.FILES.get(key);
// Writes key only over the stored object whose etag was read (R2 onlyIf; storage without etags writes as before): false
// when another write landed in between.
async function putIfUnchanged(env,key,value,etag,options){
 try{return await env.FILES.put(key,value,{...options,...(etag?{onlyIf:{etagMatches:etag}}:{})})!==null;}
 catch(error){if(/precondition/iu.test(String(error?.message||'')))return false;throw error;}
}
// The slim answer of /ocr-blocks: the requested blocks as stored after the reading (the fields applyOcrReadings sets,
// but not ocrHint, the machine text only the server reads again).
export function ocrBlockFields(document,blockIds){
 const wanted=new Set(blockIds),fields=[];
 for(const page of document.pages)for(const b of page.blocks)if(wanted.has(b.id))fields.push({id:b.id,source:b.source,text:b.text,ocrCorrected:b.ocrCorrected===true,...(typeof b.ocrKept==='string'?{ocrKept:b.ocrKept}:{}),...(typeof b.ocrDoubt==='string'?{ocrDoubt:b.ocrDoubt}:{}),...(Number.isInteger(b.ocrRereads)&&b.ocrRereads>0?{ocrRereads:b.ocrRereads}:{}),...(b.keepPixels===true?{keepPixels:true}:{}),...(b.kind!==undefined?{kind:b.kind}:{}),...(b.bold!==undefined?{bold:b.bold}:{})});
 return fields;
}
export async function pdfLayoutRoute(request,env,path,reader){
 if(!path.startsWith(base))return null;
 if(path===base+'/config'&&request.method==='GET')return reply({configured:Boolean(serviceUrl(env)),maxBytes:25*1024*1024,maxPages:20});
 if(path===base+'/capacity'&&request.method==='GET')return capacity(env,reader);
 if(path===base+'/font'&&request.method==='GET')return fontResponse(request,env);
 if(!env.FILES?.get||!env.FILES?.put)return reply({error:'Thiếu lưu trữ PDF.'},503);
 const asset=path.match(/^\/api\/my\/study\/pdf-layout\/assets\/([a-f\d-]{36})\/(manifest|original|translated)$/iu);
 if(asset&&request.method==='GET'){
  const [,id,kind]=asset;
  const object=await env.FILES.get(assetKey(reader,id,kind==='manifest'?'manifest.json':`${kind}.pdf`));if(!object)return reply({error:'Không tìm thấy PDF trong tài khoản của bạn.'},404);
  if(kind==='manifest')return new Response(object.body,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  const name=object.customMetadata?.filename||`hoa-tri-${kind}.pdf`;
  return new Response(object.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':fileDisposition(name,{fallback:`hoa-tri-${kind}.pdf`}),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(path===base+'/extract'&&request.method==='POST')return withLeases(env,reader,()=>readWithin(request,path,body=>body.formData()),async form=>{
  const file=form.get('file');if(!file||typeof file==='string'||!file.size||file.size>25*1024*1024)throw new Error('PDF giữ bố cục tối đa 25 MB.');
  if(new TextDecoder().decode(await file.slice(0,5).arrayBuffer())!=='%PDF-')throw new Error('Tệp không phải PDF.');
  if(form.get('sourceSha256')||form.get('pageOffset'))return extractChunk(env,reader,form,file);
  return counted(env,extractionCap(env,reader),async()=>{
   // Groups ranges of one uploaded file into a book and names the stored original, so the Worker hashes the bytes
   // itself instead of trusting the browser's value.
   const sha256=await sha256Hex(file);
   let result=await service(env,'extract',null,{file,pages:String(form.get('pages')||''),quality:sheetQuality(form.get('mode'))});
   const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
   // Chinese the extractor keeps printed outside every block (in a figure, a rotated watermark…) is named by its notes.
   if(!document.pages.some(p=>p.blocks.length))throw new Error(['Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.',...(document.pages.some(p=>untranslatedHan(p)>0)?(document.warnings||[]).filter(note=>typeof note==='string').slice(0,10):[])].join(' '));
   const original=decodeBytes(result.originalPdfBase64);result=null;
   document.sourceSha256=sha256;
   // The whole file is kept once per student and file: the whole-book PDF takes the cover and every untranslated page
   // from it. Failing to keep it (storage, or the account's room for originals) never blocks translating; the book
   // download then asks for the file on the device.
   try{await keepSource(env,reader.id,sha256,file,{filename:file.name,pages:document.totalPages});}
   catch(error){document.warnings=[...(document.warnings||[]),error instanceof UserError?error.message:'Chưa lưu được bản PDF gốc đầy đủ; khi tải cả quyển, Hoa Trí sẽ nhờ bạn chọn lại tệp gốc.'];}
   return keepExtraction(env,reader,id,document,original,{filename:file.name,also:[sourceKey(reader.id,sha256)]});
  });
 });
 // "Cập nhật bố cục" (frontend/study.js): the stored part is read again by this site's extractor, which is told the blocks
 // it holds (knownBlocks). Those found again keep their reading (carryReading) and, in the browser, their translation; only
 // new or grown blocks go on OCR sheets and are translated. No Gemini here: one extraction of the day.
 if(path===base+'/refresh'&&request.method==='POST')return withLeases(env,reader,()=>readWithin(request,path,body=>body.json()),async({assetId,forceClone,mode})=>{
  const manifest=assetKey(reader,validAsset(assetId),'manifest.json'),stored=await env.FILES.get(manifest);if(!stored)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  let prior=await readJsonShape(stored.body,PRIOR_SHAPE);
  // Read by this site's extractor already: the stored copy is the answer, as storage streams it.
  if(layoutStamp(prior)>=LAYOUT_VERSION&&!forceClone){const again=await env.FILES.get(manifest);return again?replyWith({assetId,originalUrl:`${base}/assets/${assetId}/original`},'document',again.body):reply({error:'Không tìm thấy PDF trong tài khoản.'},404);}
  const original=await env.FILES.get(assetKey(reader,assetId,'original.pdf'));if(!original)return reply({error:'Không còn PDF gốc để cập nhật bố cục.'},410);
  // Only what the new manifest takes from the old one is kept while the service works (no image). The stored PDF goes as
  // the base64 of a JSON body beside the saved blocks, encoded as storage streams it. Its sheets are as fine as the stored
  // ones, unless the request names a mode.
  const priorPages=prior.pages.map(page=>page.number),{totalPages,sourceSha256}=prior,filename=original.customMetadata?.filename||'nguyen-tac.pdf',quality=isMode(mode)?sheetQuality(mode):prior.sheetQuality==='fine'?'fine':'standard';
  const known=knownBlocks(prior),sent=new Set(known.flatMap(page=>page.blocks.map(b=>b.id))),saved=new Map(prior.pages.filter(page=>page.ocr===true).flatMap(page=>page.blocks).filter(b=>sent.has(b.id)).map(b=>[b.id,b]));prior=null;
  return counted(env,extractionCap(env,reader),async()=>{
   // All pages or none (allPages): the service gives the job its whole time limit instead of stopping early with the
   // pages done so far, which could not replace the stored range.
   let result;try{result=await service(env,'extract',null,{stream:jsonStream({pages:`1-${priorPages.length}`,quality,known},'pdfBase64',base64Value(original.body)),allPages:true,quality});}
   catch(error){throw HEAVY_CODES.has(error?.code)?refreshTooHeavy(priorPages,error.code):error;}
   if(result.document?.pages?.length<priorPages.length)throw refreshTooHeavy(priorPages,'pdf_too_large');
   if(result.document?.pages?.length!==priorPages.length)throw new Error('Không khớp số trang khi cập nhật bố cục.');
   for(const [i,page] of result.document.pages.entries())renumberPage(page,priorPages[i]);result.document.totalPages=totalPages;if(sourceSha256)result.document.sourceSha256=sourceSha256;
   const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
   // A PDF service older than this Worker (the Worker deployed first) tells no saved block apart and stamps its pages
   // older: storing that copy would offer every block as new and pay for the whole part again. Nothing is kept and the
   // day's extraction is given back.
   if(!document.pages.some(p=>p.blocks.length))throw new Error('Không lấy được nội dung tiếng Trung khi cập nhật bố cục.');
   if(layoutStamp(document)<LAYOUT_VERSION)throw Object.assign(new UserError(REFRESH_OUTDATED,503,'pdf_service_outdated'),{giveBack:true});
   // known names the saved block (its id as stored; the browser carries its translation over by it). A scan's block takes
   // the saved reading; a mark naming no block sent is dropped, so nothing is carried over a block that was not there.
   for(const page of document.pages)for(const block of page.blocks){
    if(block.known===undefined)continue;
    const reading=page.ocr===true?saved.get(block.known):null;
    if(!sent.has(block.known)||page.ocr===true&&!reading)delete block.known;else if(reading)carryReading(block,reading);
   }
   // With readings carried over, the copy says whether blocks are left to read (study.js resumes them, as a stopped OCR).
   const scanned=document.pages.filter(page=>page.ocr).flatMap(page=>page.blocks);if(scanned.some(b=>b.known!==undefined))document.ocrCorrectedVersion=scanned.every(b=>b.ocrCorrected===true)?1:0;
   // The copy names the layout it was made from: once complete it takes over that layout's part (study-history.js), also
   // where older rows and manifests recorded no file hash.
   document.refreshedFrom=assetId;
   const pdf=decodeBytes(result.originalPdfBase64);result=null;
   return keepExtraction(env,reader,id,document,pdf,{filename});
  });
 });
 if(path===base+'/ocr-blocks'&&request.method==='POST'){
  // mode: the session's "Cách dịch" (none or an unknown one is economy). reread: its second, more careful look at blocks
  // kept with their machine text or read doubtfully (every mode has one; a mode without one would refuse it).
  const body=await request.json(),profile=modeProfile(body.mode),reread=body.reread===true;
  if(reread&&!profile.reread)throw new UserError('Cách dịch này không đọc lại các đoạn chữ trong ảnh. Hãy tải lại trang rồi thử lại.',400,'bad_mode');
  let document=await storedDocument(env,reader,body.assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const apiKey=String(body.apiKey||'').trim();if(apiKey.length<20||apiKey.length>500||/[\r\n\0]/u.test(apiKey)||!isStudyModel(body.model))throw new Error('Khóa hoặc model Gemini OCR không hợp lệ.');
  // During the Gemini call only the blocks and sheets it reads are held, not the whole manifest; the manifest is read
  // again for the update, which then also keeps a reading another tab stored meanwhile.
  const {blocks,sheets}=ocrSelection(document,body.blockIds,reread?profile.ocrBatch.blocks:undefined);document=null;
  // rereadIds: the blocks the browser chose to read again; the others of their sheets come along (a sheet is read whole)
  // and neither count a re-read nor are named in the warnings. Without it (an older page) every block named counts.
  const chosen=reread&&body.rereadIds!==undefined?rereadSelection(body.rereadIds,body.blockIds):null;
  // The mode sets how much Gemini reasons; a doubt it reads again is named in the warnings only after that reading.
  const noteDoubts=reread||OCR_DOUBT_CODES.filter(code=>!rereads(profile.reread?.doubt,code));
  const result=await recognizePdfBlocks({GEMINI_API_KEY:apiKey,GEMINI_MODEL:body.model,GEMINI_THINKING:reread?profile.reread.thinking:profile.ocrThinking,GEMINI_MODEL_RECOVERY:true,GEMINI_PREFERRED_MODEL:env.GEMINI_MODEL||body.model},blocks,sheets,{noteDoubts,noted:chosen});
  const key=assetKey(reader,body.assetId,'manifest.json');document=await storedDocument(env,reader,body.assetId);
  // Removed meanwhile (the session or the account was deleted): the tokens Gemini billed are still reported.
  if(!document)return await keepWritten(env,reader.id,[],{usage:result.usage})||reply({error:'Không tìm thấy PDF trong tài khoản.',usage:result.usage},404);
  // slim: only what changed (the browser applies it to its own copy) instead of the whole manifest with its images; a
  // call stopped part-way (result.stop) answers slim whatever was asked, with only the blocks it decided.
  // Both answers are made before storing, so nothing but the bytes is held while storage writes them.
  applyOcrReadings(document,result,{reread,chosen});let bytes=manifestBytes(document);
  const slim=body.slim===true||result.stop?{blocks:ocrBlockFields(document,result.stop?result.blocks.map(b=>b.id):body.blockIds),ocrCorrectedVersion:document.ocrCorrectedVersion,ocrWarnings:document.ocrWarnings}:null;document=null;
  await putManifest(env,key,bytes);if(slim)bytes=null;
  const deleted=await keepWritten(env,reader.id,[key],{usage:result.usage});if(deleted)return deleted;
  const answer={usage:result.usage,warnings:result.warnings,model:result.model};
  // Stopped part-way (a quota, Gemini overloaded…): the answer is that error as every route gives it, carrying the blocks
  // read before it and stored, what was spent and the IDs still to read (pending); the browser keeps those blocks, so a
  // try again (by hand, or a whole-book run's own) asks only for the rest.
  if(result.stop){const failed=errorResponse(result.stop,{request,path});return Response.json({...await failed.json(),...slim,...answer,pending:result.pending},{status:failed.status,headers:failed.headers});}
  return slim?reply({...slim,...answer}):replyWith(answer,'document',bytes);
 }
 if(path===base+'/render'&&request.method==='POST')return withLeases(env,reader,()=>readWithin(request,path,body=>body.json()),async({assetId,historyId})=>{
  const manifest=assetKey(reader,validAsset(assetId),'manifest.json');let document=await storedDocument(env,reader,assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const session=()=>env.DB.prepare('SELECT * FROM study_sessions WHERE id=? AND user_id=?').bind(String(historyId||''),reader.id).first();
  const row=await session();if(!row)return reply({error:'Không tìm thấy lịch sử trong tài khoản.'},404);
  const savedState=await env.FILES.get(row.state_key);if(!savedState)return reply({error:'Nội dung lịch sử không còn tồn tại.'},410);
  const state=JSON.parse(await savedState.text());if(state.pdfLayout?.assetId!==assetId||!state.complete||!row.library_chapter_id)return reply({error:'Hãy dịch và lưu đủ các block trước khi xuất PDF.'},409);
  const blocks=document.pages.flatMap(p=>p.blocks),translations=blocks.map((b,i)=>({id:b.id,translation:state.translationParts[i]})),exported=madeFrom(state),stamp=layoutStamp(document);validateBlockTranslations(blocks,translations);document=null;
  return counted(env,renderCap(env,reader),async()=>{
   // The parsed copy only served the checks above: the service gets the stored manifest as storage streams it, so the
   // Worker holds none of it while the export runs (the service checks the translations against what it receives).
   const stored=await env.FILES.get(manifest);if(!stored)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
   const title=String(row.title||'Bản dịch Hoa Trí');let result;
   try{result=await service(env,'render',null,{stream:jsonStream({translations,title},'document',stored.body)});}
   catch(error){if(error?.code==='pdf_overflow')return reply({error:error.message,code:error.code,blocks:error.blocks||[]},422);throw error;}
   // A service on other layout code than this Worker (its image not rebuilt yet after a deploy, or rolled back alone)
   // draws formulas by rules these pages were not checked with, often as raw TeX: its PDF is not kept and the day's
   // export is given back. An image older than this check names no layout and is refused too.
   const expected=expectedLayout(env);
   if(expected&&result.layoutVersion!==expected){logEvent('pdf_service_outdated',{expected,drawn:typeof result.layoutVersion==='string'?result.layoutVersion.slice(0,64):null});return refused(reply({error:SERVICE_OUTDATED,code:'pdf_service_outdated'},503));}
   const pdf=decodeBytes(result.pdfBase64),report=result.report;result=null;if(new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-')throw new Error('Engine không trả PDF hợp lệ.');
   // The export took seconds to minutes, and another tab or device may have saved this session meanwhile. The PDF is kept
   // only while the session, as stored now, still holds what it was made from (madeFrom) in the same chapter; a save of
   // the same text is linked at its own revision. The chapter link checks the revision read here in the same statement,
   // and state.json (the copy read here, marked exported) is written only over that copy (its etag), so a save landing
   // after this check is never undone and its chapter never points at an older text.
   const conflict=async(now)=>{now??=await session();return refused(reply({error:EXPORT_CONFLICT,code:'history_conflict',...(now?{revision:Number(now.revision)||0,updatedAt:now.updated_at}:{})},409));};
   // A session gone meanwhile was deleted, often with its account (410 account_deleted, as every route answers then).
   const current=await session();if(!current)return await keepWritten(env,reader.id,[])||reply({error:'Không tìm thấy lịch sử trong tài khoản.'},404);
   const currentState=current.state_key===row.state_key?await env.FILES.get(row.state_key):null,latest=currentState?parsedState(await currentState.text()):null;
   if(current.library_chapter_id!==row.library_chapter_id||madeFrom(latest)!==exported)return conflict(current);
   const revision=Number(current.revision)||0,key=assetKey(reader,assetId,'translated.pdf'),file={httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:`${title}.vi.pdf`,renderVersion:String(RENDER_VERSION)}};
   await env.FILES.put(key,pdf,file);
   // Only this range's chapter: other ranges of the same book keep their own PDFs.
   const linked=await env.DB.prepare('UPDATE chapters SET file_key=?1,mime=?2 WHERE id=?3 AND story_id IN (SELECT id FROM stories WHERE owner_user_id=?4) AND EXISTS (SELECT 1 FROM study_sessions WHERE id=?5 AND user_id=?4 AND revision=?6 AND library_chapter_id=?3)').bind(key,'application/pdf',row.library_chapter_id,reader.id,row.id,revision).run();
   if(Number(linked?.meta?.changes??1)<1)return await keepWritten(env,reader.id,[key])||conflict();
   // The part's pages now come from this layout: its extractor stamp, which Thư viện riêng compares (a session saved
   // before migration 0027 has none until it is exported or saved again). Best effort: the export stands either way.
   try{await env.DB.prepare('UPDATE study_sessions SET layout_version=?1 WHERE id=?2 AND user_id=?3 AND layout_version IS NOT ?1').bind(stamp,row.id,reader.id).run();}
   catch(error){logEvent('layout_stamp_error',{name:error?.name,message:String(error?.message||'').slice(0,200)});}
   latest.pdfLayout.exported=true;latest.pdfLayout.renderVersion=RENDER_VERSION;
   if(!await putIfUnchanged(env,row.state_key,JSON.stringify(latest),currentState.etag,{httpMetadata:{contentType:'application/json'}}))return await keepWritten(env,reader.id,[key])||conflict();
   // A save of the same text that landed during the export may still be finishing: its last step removes the PDF of a
   // copy it did not see exported (study-history.js), which would leave the chapter linked to nothing, so the PDF is
   // stored again when it went meanwhile.
   if(revision!==(Number(row.revision)||0)&&!await stat(env,key))await env.FILES.put(key,pdf,file);
   return await keepWritten(env,reader.id,[key,row.state_key])||reply({url:`${base}/assets/${assetId}/translated`,report,renderVersion:RENDER_VERSION});
  });
 });
 return reply({error:'Không tìm thấy thao tác PDF.'},404);
}
