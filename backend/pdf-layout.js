import {validateLayoutDocument,validateBlockTranslations,OCR_LIMITS} from '../frontend/pdf-box-layout.js';
import {recognizePdfBlocks} from './pdf-block-ocr.js';
import {applyOcrReadings} from './pdf-layout-apply.js';
import {isStudyModel} from './gemini-models.js';
import {fileDisposition} from './download-filename.js';
import {keepSource,sourceKey} from './study-books.js';
import {storedSource} from './book-jobs.js';
import {UserError} from './http.js';
import {Buffer} from 'node:buffer';
import {rateLimit,dailyMax,takeLease} from './rate-limit.js';
import {keepWritten} from './account.js';

const base='/api/my/study/pdf-layout';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const assetKey=(reader,id,file)=>`study/${reader.id}/pdf-layout/${id}/${file}`;
// The service returns PDFs as base64 inside JSON; Buffer decodes in one pass, without atob's binary string copy.
const decodeBytes=value=>{if(typeof value!=='string'||!value)throw new Error('Dịch vụ PDF trả dữ liệu không hợp lệ.');return Buffer.from(value,'base64');};
// 3: renderer rework (inline formula alignment, indents); older exports are re-rendered from saved translations, no Gemini call.
export const RENDER_VERSION=3;
const sha256Hex=async file=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
const localService=env=>{try{return ['127.0.0.1','localhost'].includes(new URL(env.PDF_LAYOUT_SERVICE_URL).hostname);}catch{return false;}};
function serviceUrl(env){
 if(!env.PDF_LAYOUT_SERVICE_URL||!env.PDF_LAYOUT_SERVICE_TOKEN)return null;
 const url=new URL(env.PDF_LAYOUT_SERVICE_URL);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','pdf-layout'].includes(url.hostname)))throw new Error('Dịch vụ PDF cần HTTPS.');return url;
}
// Older service builds returned MuPDF/Tesseract's whole stderr as the error, with the real cause at the very end.
const SERVICE_NOISE=/Warning: Parameter not found: \S+|Error opening data file [^\n]*?\.traineddata|Please make sure the TESSDATA_PREFIX environment variable is set to your "tessdata" directory\.|Failed loading language '[^'\n]*'|Image too small to scale!! \([^)\n]*\)|Line cannot be recognized!!/gu;
export function serviceErrorMessage(value,status){
 const text=String(value||'').replace(SERVICE_NOISE,' ').replace(/\s+/gu,' ').trim();
 if(!text)return `Không xử lý được PDF (dịch vụ trả mã ${status}).`;
 return text.length>400?`${text.slice(0,399)}…`:text;
}
async function service(env,operation,body,{file,pages}={}){
 const url=serviceUrl(env);if(!url)throw new Error('Chưa cấu hình dịch vụ PDF giữ bố cục.');url.pathname=url.pathname.replace(/\/$/u,'')+'/'+operation;
 // The developer command only helps on the machine running the service; elsewhere students just need to wait.
 let response;
 try{response=await fetch(url,{method:operation==='font'?'GET':'POST',headers:{'Content-Type':file?'application/pdf':'application/json',Authorization:`Bearer ${env.PDF_LAYOUT_SERVICE_TOKEN}`,...(file?{'X-PDF-Pages':encodeURIComponent(pages||'')}:{})},...(operation==='font'?{}:{body:file?file.stream():JSON.stringify(body)}),signal:AbortSignal.timeout(280000),...(file?{duplex:'half'}:{})});}
 catch(error){throw new Error(['TimeoutError','AbortError'].includes(error?.name)?'Dịch vụ PDF xử lý quá lâu. Hãy chọn ít trang hơn cho mỗi lượt.':localService(env)?'Không kết nối được dịch vụ PDF giữ bố cục. Hãy kiểm tra dịch vụ (npm run dev:pdf-layout) rồi thử lại.':'Dịch vụ PDF đang tạm ngừng. Hãy thử lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.');}
 let result;
 try{result=await response.json();}catch{throw new Error(response.ok?'Dịch vụ PDF trả dữ liệu không hợp lệ.':`Dịch vụ PDF tạm thời không phản hồi đúng (mã ${response.status}). Hãy thử lại sau.`);}
 if(!response.ok)throw new Error(serviceErrorMessage(result?.error,response.status));return result;
}
// Each extraction or export holds one of the service's few slots (an export starts a browser), so a student has a daily
// number of each, and one call at a time: a second one, from another tab or device, waits until the first is done.
// The lease outlasts the longest call (280 s at the service, then storage); one left by a Worker that stopped mid-call
// frees itself after that.
const extractionCap=(env,reader)=>rateLimit(env,[{daily:`pdf-extract:${reader.id}`,max:dailyMax(env,'DAILY_PDF_EXTRACTS_PER_USER',100),label:'tách PDF'}]);
const renderCap=(env,reader)=>rateLimit(env,[{daily:`pdf-render:${reader.id}`,max:dailyMax(env,'DAILY_PDF_RENDERS_PER_USER',100),label:'xuất PDF tiếng Việt'}]);
const LEASE_MS=330000,BUSY_SECONDS=30;
const busy=()=>Response.json({error:'Tài khoản của bạn đang có một lượt xử lý PDF khác (tách trang hoặc xuất PDF) chưa xong. Hãy đợi lượt đó xong rồi thử lại.',code:'pdf_busy',retryAfter:BUSY_SECONDS},{status:429,headers:{'Cache-Control':'no-store','Retry-After':String(BUSY_SECONDS)}});
// The daily cap is counted inside the lease, so waiting for the lease never uses up the day's calls.
async function oneAtATime(env,reader,cap,work){
 const lease=await takeLease(env,`pdf:${reader.id}`,LEASE_MS);if(!lease)return busy();
 try{const capped=await cap(env,reader);return capped||await work();}
 finally{await lease.release();}
}
function validAsset(id){if(!/^[a-f\d-]{36}$/iu.test(id||''))throw new Error('Mã PDF không hợp lệ.');return id;}
// A re-extracted selection keeps the stored page numbers; block, sheet and strip IDs follow them.
function renumberPage(page,number){
 const id=value=>value.replace(/^p\d+-/u,`p${number}-`);page.number=number;
 for(const block of page.blocks){block.id=id(block.id);if(typeof block.ocrSheet==='string')block.ocrSheet=id(block.ocrSheet);}
 for(const sheet of page.ocrSheets||[]){sheet.id=id(String(sheet.id));for(const strip of sheet.strips||[])strip.blockId=id(String(strip.blockId));}
}
async function storedDocument(env,reader,id){const object=await env.FILES.get(assetKey(reader,validAsset(id),'manifest.json'));return object?object.json():null;}
// The last page a page list names, in the service's syntax ("1-5,7"), or 0 when the list is not valid.
function lastPage(spec){
 let last=0;
 for(const part of spec.split(',')){const match=/^(\d{1,5})(?:[-–](\d{1,5}))?$/u.exec(part);if(!match)return 0;const start=Number(match[1]),end=Number(match[2]||match[1]);if(start<1||end<start)return 0;last=Math.max(last,end);}
 return last;
}
// Service messages count pages of the file it was sent ("Trang 3: …", "(trang 1–5, 7)"); the student reads page numbers
// of the original, where a chunk's page N is page offset+N.
const shiftPageNumbers=(text,offset)=>String(text).replace(/([Tt]rang\s+)(\d+(?:\s*[–-]\s*\d+)?(?:\s*,\s*\d+(?:\s*[–-]\s*\d+)?)*)/gu,(match,word,list)=>word+list.replace(/\d+/gu,number=>String(Number(number)+offset)));
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
  let result;try{result=await service(env,'extract',null,{file,pages});}catch(error){if(error?.constructor===Error)error.message=shift(error.message);throw error;}
  const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
  for(const page of document.pages)renumberPage(page,offset+page.number);
  // Pages with nothing to translate are answered with their numbers, so a run can mark exactly those pages blank (the
  // service may stop before the last requested page when a chunk is too heavy).
  if(!document.pages.some(p=>p.blocks.length))return reply({error:'Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.',code:'no_text',pages:document.pages.map(p=>p.number)},422);
  document.totalPages=source.pages;document.sourceSha256=sha256;
  if(Array.isArray(document.warnings))document.warnings=document.warnings.map(warning=>typeof warning==='string'?shift(warning):warning);
  const written=[assetKey(reader,id,'manifest.json'),assetKey(reader,id,'original.pdf')];
  await env.FILES.put(written[0],JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
  await env.FILES.put(written[1],decodeBytes(result.originalPdfBase64),{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:source.filename||file.name}});
  return await keepWritten(env,reader.id,written)||reply({assetId:id,document,originalUrl:`${base}/assets/${id}/original`},201);
 });
}
export async function pdfLayoutRoute(request,env,path,reader){
 if(!path.startsWith(base))return null;
 if(path===base+'/config'&&request.method==='GET')return reply({configured:Boolean(serviceUrl(env)),maxBytes:25*1024*1024,maxPages:20});
 if(path===base+'/font'&&request.method==='GET')return reply(await service(env,'font'));
 if(!env.FILES?.get||!env.FILES?.put)return reply({error:'Thiếu lưu trữ PDF.'},503);
 const asset=path.match(/^\/api\/my\/study\/pdf-layout\/assets\/([a-f\d-]{36})\/(manifest|original|translated)$/iu);
 if(asset&&request.method==='GET'){
  const [,id,kind]=asset;
  const object=await env.FILES.get(assetKey(reader,id,kind==='manifest'?'manifest.json':`${kind}.pdf`));if(!object)return reply({error:'Không tìm thấy PDF trong tài khoản của bạn.'},404);
  if(kind==='manifest')return reply(await object.json());
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
   const result=await service(env,'extract',null,{file,pages:String(form.get('pages')||'')}),document=validateLayoutDocument(result.document),id=crypto.randomUUID();
   if(!document.pages.some(p=>p.blocks.length))throw new Error('Không tìm thấy block tiếng Trung cần dịch trong các trang đã chọn.');
   document.sourceSha256=sha256;
   // The whole file is kept once per student and file: the whole-book PDF takes the cover and every untranslated page
   // from it. Failing to keep it (storage, or the account's room for originals) never blocks translating; the book
   // download then asks for the file on the device.
   try{await keepSource(env,reader.id,sha256,file,{filename:file.name,pages:document.totalPages});}
   catch(error){document.warnings=[...(document.warnings||[]),error instanceof UserError?error.message:'Chưa lưu được bản PDF gốc đầy đủ; khi tải cả quyển, Hoa Trí sẽ nhờ bạn chọn lại tệp gốc.'];}
   const written=[sourceKey(reader.id,sha256),assetKey(reader,id,'manifest.json'),assetKey(reader,id,'original.pdf')];
   await env.FILES.put(written[1],JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
   await env.FILES.put(written[2],decodeBytes(result.originalPdfBase64),{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:file.name}});
   return await keepWritten(env,reader.id,written)||reply({assetId:id,document,originalUrl:`${base}/assets/${id}/original`},201);
  });
 }
 if(path===base+'/refresh'&&request.method==='POST'){
  const {assetId,forceClone}=await request.json(),prior=await storedDocument(env,reader,assetId);if(!prior)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  if(prior.extractionVersion>=2&&!forceClone)return reply({assetId,document:prior,originalUrl:`${base}/assets/${assetId}/original`});
  const original=await env.FILES.get(assetKey(reader,assetId,'original.pdf'));if(!original)return reply({error:'Không còn PDF gốc để cập nhật bố cục.'},410);
  return oneAtATime(env,reader,extractionCap,async()=>{
   const file=new File([await new Response(original.body).arrayBuffer()],'selected-pages.pdf',{type:'application/pdf'}),result=await service(env,'extract',null,{file,pages:`1-${prior.pages.length}`});
   if(result.document.pages.length!==prior.pages.length)throw new Error('Không khớp số trang khi cập nhật bố cục.');
   for(const [i,page] of result.document.pages.entries())renumberPage(page,prior.pages[i].number);result.document.totalPages=prior.totalPages;if(prior.sourceSha256)result.document.sourceSha256=prior.sourceSha256;
   const document=validateLayoutDocument(result.document),id=crypto.randomUUID();
   if(!document.pages.some(p=>p.blocks.length))throw new Error('Không lấy được nội dung tiếng Trung khi cập nhật bố cục.');
   const written=[assetKey(reader,id,'manifest.json'),assetKey(reader,id,'original.pdf')];
   await env.FILES.put(written[0],JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
   await env.FILES.put(written[1],decodeBytes(result.originalPdfBase64),{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:original.customMetadata?.filename||'nguyen-tac.pdf'}});
   return await keepWritten(env,reader.id,written)||reply({assetId:id,document,originalUrl:`${base}/assets/${id}/original`},201);
  });
 }
 if(path===base+'/ocr-blocks'&&request.method==='POST'){
  const body=await request.json(),document=await storedDocument(env,reader,body.assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const apiKey=String(body.apiKey||'').trim();if(apiKey.length<20||apiKey.length>500||/[\r\n\0]/u.test(apiKey)||!isStudyModel(body.model))throw new Error('Khóa hoặc model Gemini OCR không hợp lệ.');
  if(!Array.isArray(body.blockIds)||!body.blockIds.length||body.blockIds.length>OCR_LIMITS.sheetBlocks||new Set(body.blockIds).size!==body.blockIds.length)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
  const pages=document.pages.filter(p=>p.ocr),all=pages.flatMap(p=>p.blocks),blocks=body.blockIds.map(id=>all.find(b=>b.id===id));if(blocks.some(b=>!b))throw new Error('Đoạn OCR không thuộc PDF đã chọn.');
  // Blocks packed into stored sheets are read a whole sheet at a time: the request names every block of each sheet it
  // touches and nothing else. Older manifests (no sheets) keep one image per block, at most 6 per call.
  const stored=new Map(pages.flatMap(p=>p.ocrSheets||[]).map(s=>[s.id,s])),sheets=[...new Set(blocks.map(b=>b.ocrSheet).filter(Boolean))].map(id=>stored.get(id));
  if(sheets.length?sheets.some(s=>!s)||blocks.some(b=>!b.ocrSheet)||sheets.reduce((n,s)=>n+s.strips.length,0)!==blocks.length||sheets.some(s=>s.strips.some(strip=>!body.blockIds.includes(strip.blockId))):blocks.length>OCR_LIMITS.images)throw new Error('Danh sách đoạn đọc ảnh không hợp lệ.');
  const result=await recognizePdfBlocks({GEMINI_API_KEY:apiKey,GEMINI_MODEL:body.model,GEMINI_THINKING:'minimal',GEMINI_MODEL_RECOVERY:true,GEMINI_PREFERRED_MODEL:env.GEMINI_MODEL||body.model},blocks,sheets);
  const manifest=assetKey(reader,body.assetId,'manifest.json');applyOcrReadings(document,result);await env.FILES.put(manifest,JSON.stringify(document),{httpMetadata:{contentType:'application/json'}});
  return await keepWritten(env,reader.id,[manifest],{usage:result.usage})||reply({document,usage:result.usage,warnings:result.warnings,model:result.model});
 }
 if(path===base+'/render'&&request.method==='POST'){
  const {assetId,historyId}=await request.json(),document=await storedDocument(env,reader,assetId);if(!document)return reply({error:'Không tìm thấy PDF trong tài khoản.'},404);
  const row=await env.DB.prepare('SELECT * FROM study_sessions WHERE id=? AND user_id=?').bind(String(historyId||''),reader.id).first();if(!row)return reply({error:'Không tìm thấy lịch sử trong tài khoản.'},404);
  const savedState=await env.FILES.get(row.state_key);if(!savedState)return reply({error:'Nội dung lịch sử không còn tồn tại.'},410);
  const state=await savedState.json();if(state.pdfLayout?.assetId!==assetId||!state.complete||!row.library_chapter_id)return reply({error:'Hãy dịch và lưu đủ các block trước khi xuất PDF.'},409);
  const blocks=document.pages.flatMap(p=>p.blocks),translations=blocks.map((b,i)=>({id:b.id,translation:state.translationParts[i]}));validateBlockTranslations(blocks,translations);
  return oneAtATime(env,reader,renderCap,async()=>{
   const title=String(row.title||'Bản dịch Hoa Trí'),result=await service(env,'render',{document,translations,title}),pdf=decodeBytes(result.pdfBase64);if(new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-')throw new Error('Engine không trả PDF hợp lệ.');
   const key=assetKey(reader,assetId,'translated.pdf');await env.FILES.put(key,pdf,{httpMetadata:{contentType:'application/pdf'},customMetadata:{filename:`${title}.vi.pdf`,renderVersion:String(RENDER_VERSION)}});
   // Only this range's chapter: other ranges of the same book keep their own PDFs.
   await env.DB.prepare('UPDATE chapters SET file_key=?,mime=? WHERE id=? AND story_id IN (SELECT id FROM stories WHERE owner_user_id=?)').bind(key,'application/pdf',row.library_chapter_id,reader.id).run();
   state.pdfLayout.exported=true;state.pdfLayout.renderVersion=RENDER_VERSION;await env.FILES.put(row.state_key,JSON.stringify(state),{httpMetadata:{contentType:'application/json'}});
   return await keepWritten(env,reader.id,[key,row.state_key])||reply({url:`${base}/assets/${assetId}/translated`,report:result.report,renderVersion:RENDER_VERSION});
  });
 }
 return reply({error:'Không tìm thấy thao tác PDF.'},404);
}
