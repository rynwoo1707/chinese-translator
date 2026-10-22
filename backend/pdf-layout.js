import {validateLayoutDocument,validateBlockTranslations,OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {recognizePdfBlocks} from './pdf-block-ocr.js';
import {applyOcrReadings} from './pdf-layout-apply.js';
import {isStudyModel} from './gemini-models.js';
import {fileDisposition} from './download-filename.js';
import {keepSource,sourceKey} from './study-books.js';
import {storedSource} from './book-jobs.js';
import {UserError} from './http.js';
import {Buffer} from 'node:buffer';
import {rateLimit,dailyMax} from './rate-limit.js';
import {keepWritten} from './account.js';
import {holdLease,takeSlot,keepRenewed} from './pdf-slots.js';
import {asciiJsonBytes} from '../services/pdf-layout/ascii-json.mjs';

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
// Older service builds returned MuPDF/Tesseract's whole stderr as the error, with the real cause at the very end.
const SERVICE_NOISE=/Warning: Parameter not found: \S+|Error opening data file [^\n]*?\.traineddata|Please make sure the TESSDATA_PREFIX environment variable is set to your "tessdata" directory\.|Failed loading language '[^'\n]*'|Image too small to scale!! \([^)\n]*\)|Line cannot be recognized!!|Tesseract couldn't load any languages!|Could not initiali[sz]e tesseract\.?/giu;
// limit: 400 characters, more for an overflow answer, whose list of "Đoạn k" the service already keeps short.
export function serviceErrorMessage(value,status,limit=400){
 const text=String(value||'').replace(SERVICE_NOISE,' ').replace(/\s+/gu,' ').trim();
 if(!text)return `Không xử lý được PDF (dịch vụ trả mã ${status}).`;
 return text.length>limit?`${text.slice(0,limit-1)}…`:text;
}
// What a PDF service failure tells the student's browser (whole-book.js classifyError), besides the message:
//  503 pdf_service_busy + Retry-After   every place of the service is taken: the same call works a little later;
//  503 pdf_unavailable + Retry-After    the service cannot be reached, answers garbage (restarting, network) or could
//                                       not start the browser of an export;
//  413 pdf_timeout | pdf_memory | pdf_too_large | pdf_crash   this selection is too heavy for one job: fewer pages work;
//  422 pdf_overflow + blocks            a translation is longer than its box (render): the message names each "Đoạn k"
//                                       and how to shorten it in Xưởng dịch; blocks [{page,id}] lets the browser open them;
//  400 (no code)                        a problem of the file itself, e.g. "Trang 3: …".
// An older service sends no code; its known messages are recognised instead.
export const SERVICE_BUSY_SECONDS=20,SERVICE_DOWN_SECONDS=30;
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
 if(code==='browser')return unavailable(message);
 const heavy=HEAVY.find(([name,,pattern])=>code?code===name:pattern.test(message));
 return heavy?new UserError(message,413,heavy[1]):new Error(message);
}
const unavailable=message=>new UserError(message,503,'pdf_unavailable',{retryAfter:SERVICE_DOWN_SECONDS});
// body: an object sent as JSON, or a stream (stream: a JSON body built from stored bytes); file: a PDF streamed as is.
async function service(env,operation,body,{file,pages,stream}={}){
 const url=serviceUrl(env);if(!url)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');url.pathname=url.pathname.replace(/\/$/u,'')+'/'+operation;
 // The developer command only helps on the machine running the service; elsewhere students just need to wait.
 let response;
 try{response=await fetch(url,{method:operation==='font'?'GET':'POST',headers:{'Content-Type':file?'application/pdf':'application/json',Authorization:`Bearer ${env.PDF_LAYOUT_SERVICE_TOKEN}`,...(file?{'X-PDF-Pages':encodeURIComponent(pages||'')}:{})},...(operation==='font'?{}:{body:file?file.stream():stream||JSON.stringify(body)}),signal:AbortSignal.timeout(280000),...(file||stream?{duplex:'half'}:{})});}
 catch(error){
  if(['TimeoutError','AbortError'].includes(error?.name))throw new UserError(operation==='render'?'Dịch vụ PDF xuất quá lâu. Hãy thử xuất lại sau ít phút.':'Dịch vụ PDF xử lý quá lâu. Hãy chọn ít trang hơn cho mỗi lượt.',413,'pdf_timeout');
  throw unavailable(localService(env)?'Không kết nối được dịch vụ PDF giữ bố cục. Hãy kiểm tra dịch vụ (npm run dev:pdf-layout) rồi thử lại.':'Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.');
 }
 let result;
 try{result=await response.json();}catch{if(response.ok)throw new Error('Dịch vụ PDF trả dữ liệu không hợp lệ.');throw response.status===503?serviceFailure(503,null,response.headers.get('Retry-After')):unavailable(`Dịch vụ PDF tạm thời không phản hồi đúng (mã ${response.status}). Hãy thử lại sau.`);}
 if(!response.ok)throw serviceFailure(response.status,result,response.headers.get('Retry-After'));return result;
}
// Each extraction or export holds one of the service's few slots (an export starts a browser), so a student has a daily
// number of each, and one call at a time: a second one, from another tab or device, waits until the first is done.
// The leases (pdf-slots.js) are renewed while a call runs; one left by a Worker that stopped mid-call frees itself.
const extractionCap=(env,reader)=>rateLimit(env,[{daily:`pdf-extract:${reader.id}`,max:dailyMax(env,'DAILY_PDF_EXTRACTS_PER_USER',100),label:'tách PDF'}]);
const renderCap=(env,reader)=>rateLimit(env,[{daily:`pdf-render:${reader.id}`,max:dailyMax(env,'DAILY_PDF_RENDERS_PER_USER',100),label:'xuất PDF tiếng Việt'}]);
const BUSY_SECONDS=30;
const busy=()=>Response.json({error:'Tài khoản của bạn đang có một lượt xử lý PDF khác (tách trang hoặc xuất PDF) chưa xong. Hãy đợi lượt đó xong rồi thử lại.',code:'pdf_busy',retryAfter:BUSY_SECONDS},{status:429,headers:{'Cache-Control':'no-store','Retry-After':String(BUSY_SECONDS)}});
const serviceBusy=()=>Response.json({error:SERVICE_BUSY,code:'pdf_service_busy',retryAfter:SERVICE_BUSY_SECONDS},{status:503,headers:{'Cache-Control':'no-store','Retry-After':String(SERVICE_BUSY_SECONDS)}});
// The daily cap is counted once both leases are held, so waiting for either never uses up the day's calls.
async function oneAtATime(env,reader,cap,work){
 const account=await holdLease(env,`pdf:${reader.id}`);if(!account)return busy();
 const leases=[account];
 try{
  const slot=await takeSlot(env);if(!slot)return serviceBusy();leases.push(slot);
  return await keepRenewed(leases,async()=>await cap(env,reader)||await work());
 }finally{await Promise.all(leases.map(lease=>lease.release()));}
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
// A chunk the browser cut from an original stored for a whole-book run (sourceSha256), starting after page pageOffset.
// The manifest numbers pages, block IDs and warnings as pages of the original and names that file, so the part joins its
// book like a range of the whole file. The chunk itself is not kept: the original already is.
async function extractChunk(env,reader,form,file){
 const sha256=String(form.get('sourceSha256')||''),offsetValue=String(form.get('pageOffset')||'').trim()||'0',pages=String(form.get('pages')||'').replace(/\s/gu,'');
 if(!/^[a-f\d]{64}$/u.test(sha256))throw new UserError('Mã tệp gốc không hợp lệ.',400,'bad_hash');
 if(!/^\d{1,5}$/u.test(offsetValue))throw new UserError('Vị trí của phần cắt trong tệp gốc không hợp lệ.',400,'bad_offset');
 const offset=Number(offsetValue),last=lastPage(pages);if(!last)throw new UserError('Phạm vi trang không hợp lệ.',400,'bad_pages');
 const source=await storedSource(env,reader.id,sha256);
 if(!source)return reply({error:'Tài khoản chưa lưu tệp gốc này. Hãy tải tệp gốc lên trước.',code:'source_missing'},404);
 if(!source.pages)throw new UserError('Chưa rõ số trang của tệp gốc đã lưu. Hãy tải tệp gốc lên lại.',409,'source_pages');
 if(offset+last>source.pages)throw new UserError(`Trang ${offset+last} vượt quá ${source.pages} trang của tệp gốc.`,400,'bad_pages');
 return oneAtATime(env,reader,extractionCap,async()=>{
  const shift=text=>offset?shiftPageNumbers(text,offset):text;
  let result;try{result=await service(env,'extract',null,{file,pages});}catch(error){if(error?.constructor===Error||error instanceof UserError)error.message=shift(error.message);throw error;}
  const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
  for(const page of document.pages)renumberPage(page,offset+page.number);
  // Pages with nothing to translate are answered with their numbers, so a run can mark exactly those pages blank (the
  // service may stop before the last requested page when a chunk is too heavy).
  if(!document.pages.some(p=>p.blocks.length))return reply({error:'Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.',code:'no_text',pages:document.pages.map(p=>p.number)},422);
  const original=decodeBytes(result.originalPdfBase64);result=null;
  document.totalPages=source.pages;document.sourceSha256=sha256;
  if(Array.isArray(document.warnings))document.warnings=document.warnings.map(warning=>typeof warning==='string'?shift(warning):warning);
  return keepExtraction(env,reader,id,document,original,{filename:source.filename||file.name});
 });
}
// The blocks an OCR call reads and the stored sheets they sit on, checked against the manifest.
function ocrSelection(document,blockIds){
 if(!Array.isArray(blockIds)||!blockIds.length||blockIds.length>OCR_LIMITS.sheetBlocks||new Set(blockIds).size!==blockIds.length)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
 const pages=document.pages.filter(p=>p.ocr),all=pages.flatMap(p=>p.blocks),blocks=blockIds.map(id=>all.find(b=>b.id===id));if(blocks.some(b=>!b))throw new Error('Đoạn OCR không thuộc PDF đã chọn.');
 // Blocks packed into stored sheets are read a whole sheet at a time: the request names every block of each sheet it
 // touches and nothing else. Older manifests (no sheets) keep one image per block, at most 6 per call.
 const stored=new Map(pages.flatMap(p=>p.ocrSheets||[]).map(s=>[s.id,s])),sheets=[...new Set(blocks.map(b=>b.ocrSheet).filter(Boolean))].map(id=>stored.get(id));
 if(sheets.length?sheets.some(s=>!s)||blocks.some(b=>!b.ocrSheet)||sheets.reduce((n,s)=>n+s.strips.length,0)!==blocks.length||sheets.some(s=>s.strips.some(strip=>!blockIds.includes(strip.blockId))):blocks.length>OCR_LIMITS.images)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
 return {blocks,sheets};
}
// The slim answer of /ocr-blocks: the requested blocks as stored after the reading (the fields applyOcrReadings sets).
export function ocrBlockFields(document,blockIds){
 const wanted=new Set(blockIds),fields=[];
 for(const page of document.pages)for(const b of page.blocks)if(wanted.has(b.id))fields.push({id:b.id,source:b.source,text:b.text,ocrCorrected:b.ocrCorrected===true,...(typeof b.ocrKept==='string'?{ocrKept:b.ocrKept}:{}),...(b.kind!==undefined?{kind:b.kind}:{}),...(b.bold!==undefined?{bold:b.bold}:{})});
 return fields;
}
export async function pdfLayoutRoute(request,env,path,reader){
 if(!path.startsWith(base))return null;
 if(path===base+'/config'&&request.method==='GET')return reply({configured:Boolean(serviceUrl(env)),maxBytes:25*1024*1024,maxPages:20});
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
 if(path===base+'/extract'&&request.method==='POST'){
  const form=await request.formData(),file=form.get('file');if(!file||typeof file==='string'||!file.size||file.size>25*1024*1024)throw new Error('PDF giữ bố cục tối đa 25 MB.');
  if(new TextDecoder().decode(await file.slice(0,5).arrayBuffer())!=='%PDF-')throw new Error('Tệp không phải PDF.');
  if(form.get('sourceSha256')||form.get('pageOffset'))return extractChunk(env,reader,form,file);
  return oneAtATime(env,reader,extractionCap,async()=>{
   // Groups ranges of one uploaded file into a book and names the stored original, so the Worker hashes the bytes
   // itself instead of trusting the browser's value.
   const sha256=await sha256Hex(file);
   let result=await service(env,'extract',null,{file,pages:String(form.get('pages')||'')});
   const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
   if(!document.pages.some(p=>p.blocks.length))throw new Error('Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.');
   const original=decodeBytes(result.originalPdfBase64);result=null;
   document.sourceSha256=sha256;
   // The whole file is kept once per student and file: the whole-book PDF takes the cover and every untranslated page
   // from it. Failing to keep it (storage, or the account's room for originals) never blocks translating; the book
   // download then asks for the file on the device.
   try{await keepSource(env,reader.id,sha256,file,{filename:file.name,pages:document.totalPages});}
   catch(error){document.warnings=[...(document.warnings||[]),error instanceof UserError?error.message:'Chưa lưu được bản PDF gốc đầy đủ; khi tải cả quyển, Hoa Trí sẽ nhờ bạn chọn lại tệp gốc.'];}
   return keepExtraction(env,reader,id,document,original,{filename:file.name,also:[sourceKey(reader.id,sha256)]});
  });
 }
 if(path===base+'/refresh'&&request.method==='POST'){
  const {assetId,forceClone}=await request.json(),prior=await storedDocument(env,reader,assetId);if(!prior)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  if(prior.extractionVersion>=2&&!forceClone)return reply({assetId,document:prior,originalUrl:`${base}/assets/${assetId}/original`});
  const original=await env.FILES.get(assetKey(reader,assetId,'original.pdf'));if(!original)return reply({error:'Không còn PDF gốc để cập nhật bố cục.'},410);
  // Only what the new manifest takes from the old one is kept while the service works; the stored PDF goes to the
  // service as a stream.
  const priorPages=prior.pages.map(page=>page.number),{totalPages,sourceSha256}=prior,filename=original.customMetadata?.filename||'nguyen-tac.pdf';
  return oneAtATime(env,reader,extractionCap,async()=>{
   let result=await service(env,'extract',null,{file:{stream:()=>original.body},pages:`1-${priorPages.length}`});
   if(result.document.pages.length!==priorPages.length)throw new Error('Không khớp số trang khi cập nhật bố cục.');
   for(const [i,page] of result.document.pages.entries())renumberPage(page,priorPages[i]);result.document.totalPages=totalPages;if(sourceSha256)result.document.sourceSha256=sourceSha256;
   const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
   if(!document.pages.some(p=>p.blocks.length))throw new Error('Không lấy được nội dung tiếng Trung khi cập nhật bố cục.');
   const pdf=decodeBytes(result.originalPdfBase64);result=null;
   return keepExtraction(env,reader,id,document,pdf,{filename});
  });
 }
 if(path===base+'/ocr-blocks'&&request.method==='POST'){
  const body=await request.json();let document=await storedDocument(env,reader,body.assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const apiKey=String(body.apiKey||'').trim();if(apiKey.length<20||apiKey.length>500||/[\r\n\0]/u.test(apiKey)||!isStudyModel(body.model))throw new Error('Khóa hoặc model Gemini OCR không hợp lệ.');
  // During the Gemini call only the blocks and sheets it reads are held, not the whole manifest; the manifest is read
  // again for the update, which then also keeps a reading another tab stored meanwhile.
  const {blocks,sheets}=ocrSelection(document,body.blockIds);document=null;
  const result=await recognizePdfBlocks({GEMINI_API_KEY:apiKey,GEMINI_MODEL:body.model,GEMINI_THINKING:'minimal',GEMINI_MODEL_RECOVERY:true,GEMINI_PREFERRED_MODEL:env.GEMINI_MODEL||body.model},blocks,sheets);
  const key=assetKey(reader,body.assetId,'manifest.json');document=await storedDocument(env,reader,body.assetId);
  // Removed meanwhile (the session or the account was deleted): the tokens Gemini billed are still reported.
  if(!document)return await keepWritten(env,reader.id,[],{usage:result.usage})||reply({error:'Không tìm thấy PDF trong tài khoản.',usage:result.usage},404);
  // slim: only what changed (the browser applies it to its own copy) instead of the whole manifest with its images.
  // Both answers are made before storing, so nothing but the bytes is held while storage writes them.
  applyOcrReadings(document,result);let bytes=manifestBytes(document);
  const slim=body.slim===true?{blocks:ocrBlockFields(document,body.blockIds),ocrCorrectedVersion:document.ocrCorrectedVersion,ocrWarnings:document.ocrWarnings}:null;document=null;
  await putManifest(env,key,bytes);if(slim)bytes=null;
  const deleted=await keepWritten(env,reader.id,[key],{usage:result.usage});if(deleted)return deleted;
  const answer={usage:result.usage,warnings:result.warnings,model:result.model};
  return slim?reply({...slim,...answer}):replyWith(answer,'document',bytes);
 }
 if(path===base+'/render'&&request.method==='POST'){
  const {assetId,historyId}=await request.json(),manifest=assetKey(reader,validAsset(assetId),'manifest.json');let document=await storedDocument(env,reader,assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const row=await env.DB.prepare('SELECT * FROM study_sessions WHERE id=? AND user_id=?').bind(String(historyId||''),reader.id).first();if(!row)return reply({error:'Không tìm thấy lịch sử trong tài khoản.'},404);
  const savedState=await env.FILES.get(row.state_key);if(!savedState)return reply({error:'Nội dung lịch sử không còn tồn tại.'},410);
  const state=await savedState.json();if(state.pdfLayout?.assetId!==assetId||!state.complete||!row.library_chapter_id)return reply({error:'Hãy dịch và lưu đủ các block trước khi xuất PDF.'},409);
  const blocks=document.pages.flatMap(p=>p.blocks),translations=blocks.map((b,i)=>({id:b.id,translation:state.translationParts[i]}));validateBlockTranslations(blocks,translations);document=null;
  return oneAtATime(env,reader,renderCap,async()=>{
   // The parsed copy only served the checks above: the service gets the stored manifest as storage streams it, so the
   // Worker holds none of it while the export runs (the service checks the translations against what it receives).
   const stored=await env.FILES.get(manifest);if(!stored)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
   const title=String(row.title||'Bản dịch Hoa Trí');let result;
   try{result=await service(env,'render',null,{stream:jsonStream({translations,title},'document',stored.body)});}
   catch(error){if(error?.code==='pdf_overflow')return reply({error:error.message,code:error.code,blocks:error.blocks||[]},422);throw error;}
   const pdf=decodeBytes(result.pdfBase64);if(new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-')throw new Error('Engine không trả PDF hợp lệ.');
   const key=assetKey(reader,assetId,'translated.pdf');await env.FILES.put(key,pdf,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:`${title}.vi.pdf`,renderVersion:String(RENDER_VERSION)}});
   // Only this range's chapter: other ranges of the same book keep their own PDFs.
   await env.DB.prepare('UPDATE chapters SET file_key=?,mime=? WHERE id=? AND story_id IN (SELECT id FROM stories WHERE owner_user_id=?)').bind(key,'application/pdf',row.library_chapter_id,reader.id).run();
   state.pdfLayout.exported=true;state.pdfLayout.renderVersion=RENDER_VERSION;await env.FILES.put(row.state_key,JSON.stringify(state),{httpMetadata:{contentType:'application/json'}});
   return await keepWritten(env,reader.id,[key,row.state_key])||reply({url:`${base}/assets/${assetId}/translated`,report:result.report,renderVersion:RENDER_VERSION});
  });
 }
 return reply({error:'Không tìm thấy thao tác PDF.'},404);
}
