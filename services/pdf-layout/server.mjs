import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pythonOperation,renderDocument,fontCss,fontPath,overflowMessage,RENDER_DEADLINE_MS} from './engine.mjs';
import {validateLayoutDocument} from '../../frontend/pdf-box-layout.js';
import {asciiJsonBytes} from './ascii-json.mjs';
import {buildVersion} from './version.mjs';

// Jobs at once (PDF_LAYOUT_JOBS, default 2): each extraction runs one Python process, each export one Chromium. The
// Worker shares the same number out (its PDF_LAYOUT_SLOTS), so this limit only answers callers it does not know about.
export function jobLimit(value=process.env.PDF_LAYOUT_JOBS){const text=String(value??'').trim();return /^\d{1,2}$/u.test(text)&&Number(text)>=1?Number(text):2;}
export const BUSY_SECONDS=20;
// Bodies the service takes: a PDF of up to 25 MB (/extract) or JSON of up to 40 MB (a manifest of 20 scanned pages with
// its translations). A larger body is still read to its end, and dropped, before the 413: a service that stops reading
// mid-upload (or closes the connection) leaves the caller with a reset connection instead of the answer. Only a caller
// that keeps sending DRAIN_MB past the limit has its connection closed.
const MB=1024*1024;
export const BODY_LIMITS=Object.freeze({pdf:25*MB,json:40*MB}),DRAIN_MB=64;
// A request the service cannot read: 400, or 413 with code too_large (the Worker's pdf_too_large: fewer pages help).
const refused=(message,status=400,code)=>Object.assign(new Error(message),{status,...(code?{code}:{})});
async function readBody(req,limit){
 const declared=Number(req.headers['content-length']),chunks=[];let size=0,over=Number.isFinite(declared)&&declared>limit;
 for await(const chunk of req){
  size+=chunk.length;
  // Leaving the loop would keep the socket open (Node detaches it from the request), so it is closed here.
  if(size>limit+DRAIN_MB*MB){req.socket?.destroy();throw refused('Dữ liệu gửi tới dịch vụ PDF quá giới hạn và vẫn tiếp tục gửi.',413,'too_large');}
  if(over||size>limit){over=true;chunks.length=0;continue;}
  chunks.push(chunk);
 }
 if(over)throw refused(`Dữ liệu gửi tới dịch vụ PDF lớn hơn ${limit/MB} MB, vượt giới hạn dung lượng của dịch vụ. Hãy chọn ít trang hơn cho mỗi lượt.`,413,'too_large');
 return Buffer.concat(chunks);
}
const UNREADABLE='Dịch vụ PDF nhận được dữ liệu hỏng hoặc bị cắt giữa chừng. Hãy thử lại; nếu lỗi lặp lại, hãy báo quản trị viên.';
// The request as the job takes it: a raw PDF with its page range in X-PDF-Pages (URI-encoded), or a JSON object.
// X-PDF-All-Pages: 1 (a refresh) asks for every page or none: the job may then use its whole time limit (engine.mjs).
async function readPayload(req){
 const rawPdf=req.headers['content-type']==='application/pdf',bytes=await readBody(req,rawPdf?BODY_LIMITS.pdf:BODY_LIMITS.json);
 if(rawPdf){
  let pages;try{pages=decodeURIComponent(req.headers['x-pdf-pages']||'');}catch{throw refused('Phạm vi trang gửi tới dịch vụ PDF không hợp lệ. Hãy chọn lại phạm vi trang, ví dụ 1-5.');}
  return {pdfBase64:bytes.toString('base64'),pages};
 }
 let payload;try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw refused(UNREADABLE);}
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw refused(UNREADABLE);
 return payload;
}
// What a failed job answers (the Worker reads code; an older Worker only shows the message):
//  422 {error, code?}            the job failed: a code engine.mjs gave the error (timeout, memory, too_large, crash), or
//                                none for a problem of the file itself ("Trang 3: …");
//  422 {error, code:'overflow', blocks:[{page,id}]}   a translation longer than its box: the message says which "Đoạn k"
//                                to shorten in Xưởng dịch, blocks lets the browser open them;
//  500 {error, code:'browser'|'font'}   the export's browser did not start, or its font is missing: a problem of the
//                                service, not of the document (the Worker answers 503 pdf_unavailable);
//  400 {error} / 413 {error, code:'too_large'}   a request the service could not read.
const SERVICE_FAULTS=new Set(['browser','font']);
export function failureAnswer(error){
 if(error?.code==='overflow'&&Array.isArray(error.blocks)&&error.blocks.length)return {status:422,body:{error:overflowMessage(error.blocks),code:'overflow',blocks:error.blocks.map(({page,id})=>({page,id}))}};
 if(SERVICE_FAULTS.has(error?.code))return {status:500,body:{error:String(error.message),code:error.code}};
 if([400,413].includes(error?.status))return {status:error.status,body:{error:String(error.message),...(error.code?{code:error.code}:{})}};
 const code=['timeout','memory','too_large','crash'].includes(error?.code)?error.code:null;
 return {status:422,body:{error:String(error?.message||error),...(code?{code}:{})}};
}
// The service's log keeps the original error behind a translated one (a browser that did not start, Puppeteer's text).
const logged=error=>`${error?.message||error}${error?.cause?` (${String(error.cause?.message||error.cause).slice(0,2000)})`:''}`;

// The export font /health names: null when the file is not there (engine.mjs fontPath).
const fontName=()=>{const path=fontPath();return path?basename(path):null;};
// The request handler. operations replaces the engine and version the build's hashes (tests).
export function serviceHandler({token,jobs=jobLimit(),operations={pythonOperation,renderDocument,fontCss},version=buildVersion(),font=fontName,log=console.error}={}){
 if(!token||token.length<24)throw new Error('Đặt PDF_LAYOUT_SERVICE_TOKEN tối thiểu 24 ký tự.');
 const expected=Buffer.from(`Bearer ${token}`);
 const authorized=req=>{const actual=Buffer.from(req.headers.authorization||'');return actual.length===expected.length&&timingSafeEqual(actual,expected);};
 let active=0;
 const handler=async(req,res)=>{
  // ASCII only (non-ASCII as \u escapes): a manifest is mostly base64, and one Chinese character would make the whole
  // text two bytes per character in V8, here and in the Worker that parses it.
  const json=(body,status=200,headers={})=>{if(res.headersSent||res.destroyed)return;const bytes=asciiJsonBytes(body);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Length':bytes.length,...headers});res.end(bytes);};
  if(!authorized(req))return json({error:'Unauthorized'},401);
  if(req.url==='/health'&&req.method==='GET')return json({ok:true,engine:'pymupdf-puppeteer',busy:active>0,active,jobs,version,font:font()});
  if(req.url==='/font'&&req.method==='GET'){try{return json({css:await operations.fontCss()});}catch(error){log(`[pdf-layout] /font ${logged(error)}`);return json({error:String(error?.message||error),...(error?.code?{code:error.code}:{})},500);}}
  if(req.method!=='POST'||!['/extract','/render'].includes(req.url))return json({error:'Not found'},404);
  if(active>=jobs){req.resume();return json({error:'Dịch vụ PDF đang bận. Hãy thử lại sau.',code:'busy',retryAfter:BUSY_SECONDS},503,{'Retry-After':String(BUSY_SECONDS)});}
  active++;
  // The caller hung up before the answer (a closed tab, the Worker's own time limit): the job stops and frees its place.
  const controller=new AbortController();res.on('close',()=>{if(!res.writableFinished)controller.abort();});
  try{
   const payload=await readPayload(req);
   if(req.url==='/extract'){const result=await operations.pythonOperation(payload,{signal:controller.signal,allPages:req.headers['x-pdf-all-pages']==='1'});validateLayoutDocument(result.document);json(result);}
   else json(await operations.renderDocument(payload.document,payload.translations,{title:payload.title,signal:controller.signal,deadlineMs:RENDER_DEADLINE_MS}));
  }catch(error){
   if(controller.signal.aborted){log(`[pdf-layout] ${req.url} stopped: the caller left before the answer`);return;}
   log(`[pdf-layout] ${req.url} ${logged(error)}`);const answer=failureAnswer(error);json(answer.body,answer.status);
  }finally{active--;}
 };
 return {handler,get active(){return active;},jobs};
}

export function startService({token=process.env.PDF_LAYOUT_SERVICE_TOKEN,port=Number(process.env.PORT)||8091,host=process.env.PDF_LAYOUT_HOST||'127.0.0.1'}={}){
 const service=serviceHandler({token}),server=createServer(service.handler);
 server.requestTimeout=300000;server.listen(port,host,()=>console.log(`PDF layout service ready (PyMuPDF + Puppeteer, ${service.jobs} jobs at once).`));
 return server;
}
// `node services/pdf-layout/server.mjs` (the image's CMD) starts it, also through a symlinked or junction folder (a
// release folder such as /srv/app/current): Node runs a module from its real path, while argv[1] keeps the path it was
// given, so both are compared as real paths. local.mjs imports it and starts it itself.
const realPath=path=>{const real=realpathSync(path);return process.platform==='win32'?real.toLowerCase():real;};
const started=()=>{try{return Boolean(process.argv[1])&&realPath(process.argv[1])===realPath(fileURLToPath(import.meta.url));}catch{return false;}};
if(started())startService();
