import {assessLocalOcr} from './ocr-policy.js';
import {normalizeOcrLayout,tesseractLayout,glyphRows,glyphRegions} from './document-layout.js';
import {recognizePaddle,terminatePaddle} from './paddle-client.js';

let workerPromise=null;
let progressListener=()=>{};
// paddleUnavailable: why PaddleOCR failed to run in this tab ('' until it does), so Tesseract reads the scans from then
// on; a page it could not finish in time (paddle-client.js's backstop) is read by Tesseract and the next page tries
// PaddleOCR again, until two pages in a row run out of time (paddleTimeouts). installCheck: whether this install serves
// PaddleOCR at all, asked once per tab. announced: the reason the status line already gave for the document being read
// (terminateLocalOcr ends a document).
let paddleUnavailable='',paddleTimeouts=0,installCheck=null,announced='';
const PADDLE_TIMEOUT='PaddleOCR quá thời gian xử lý trang.';
let lastActivity=0,importFailures=0,downloading=false;
// Tesseract says nothing while it downloads its core (3.9 MB) or the Chinese and English data (4.7 MB): during those
// phases the page waits up to DOWNLOAD_STALL_MS, so a slow but working download is not cut off. Any other silence of
// STALL_MS means its wasm never started, and the page gives up instead of waiting for ever.
export const STALL_MS=45_000,DOWNLOAD_STALL_MS=300_000;
// What the first local OCR downloads over the network (the browser keeps it): PaddleOCR's engine and models, about 29 MB,
// or, in an install without PaddleOCR, Tesseract's core, Chinese and English data and scripts, about 8.8 MB.
export const OCR_DOWNLOAD={paddle:{engine:'PaddleOCR',mb:29},tesseract:{engine:'Tesseract',mb:9}};
const PADDLE_CACHE='hoa-tri-paddle-v5-0.4.2',NOT_INSTALLED='Bản cài Hoa Trí này chưa có PaddleOCR.';
// Tesseract's first download comes in two phases, the core then the language data: [share before it, share of it].
const TESSERACT_PHASES={'loading tesseract core':[0,.45],'loading language traineddata':[.45,.55]};

// Rejects when `promise` has not settled and nothing reported progress for `ms`.
export function stallGuard(promise,ms=STALL_MS,message='Tesseract cục bộ không phản hồi.'){
 lastActivity=Date.now();downloading=false;
 return new Promise((resolve,reject)=>{
  const timer=setInterval(()=>{if(Date.now()-lastActivity>(downloading?Math.max(ms,DOWNLOAD_STALL_MS):ms)){clearInterval(timer);reject(Object.assign(new Error(message),{code:'ocr_stalled'}));}},Math.min(1000,ms));
  promise.then(value=>{clearInterval(timer);resolve(value);},error=>{clearInterval(timer);reject(error);});
 });
}

// tesseract.js 7 keeps each language's data in IndexedDB through idb-keyval: database "keyval-store", store "keyval",
// key "./<lang>.traineddata" (no cachePath is set). Read only when that database exists; unknown counts as not kept.
function tesseractCached(){
 const result=(target,resolve,reject)=>{target.onsuccess=()=>resolve(target.result);target.onerror=()=>reject(target.error);};
 const check=async()=>{
  if(!(await indexedDB.databases()).some(database=>database.name==='keyval-store'))return false;
  // Created only if it was deleted since the line above, and then as idb-keyval creates it.
  const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('keyval-store');open.onupgradeneeded=()=>open.result.createObjectStore('keyval');result(open,resolve,reject);});
  try{const store=db.transaction('keyval','readonly').objectStore('keyval');return (await Promise.all(['chi_sim','eng'].map(lang=>new Promise((resolve,reject)=>result(store.count(`./${lang}.traineddata`),resolve,reject))))).every(Boolean);}
  finally{db.close();}
 };
 let timer;return Promise.race([check().catch(()=>false),new Promise(resolve=>{timer=setTimeout(resolve,3000,false);})]).finally(()=>clearTimeout(timer));
}
// PaddleOCR's models, which paddle-worker.js keeps in Cache Storage (never a page kept in place of one).
async function paddleCached(){
 try{return (await Promise.all(['det.tar','rec.tar'].map(file=>caches.match(new URL(`/vendor/paddle/models/${file}`,location.href).href,{cacheName:PADDLE_CACHE})))).every(hit=>hit&&!/^text\/html/iu.test(hit.headers.get('Content-Type')||''));}catch{return false;}
}
// Tesseract's own progress, plus `download`: the share of its first download done (0-1), and `cached`: its language
// data was already in this browser, so nothing large is fetched.
function tesseractProgress(message,cached){
 const phase=TESSERACT_PHASES[message?.status];
 return phase?{...message,engine:'tesseract',cached,download:phase[0]+phase[1]*Math.min(1,Math.max(0,Number(message.progress)||0))}:message;
}

async function worker(){
 if(!workerPromise){
  // The browser remembers a module that failed to load; a retry asks for it under a new URL.
  const created=Promise.all([import(`/vendor/tesseract.esm.min.js${importFailures?`?retry=${importFailures}`:''}`).catch(()=>{importFailures++;throw new Error('Không tải được bộ nhận dạng chữ Tesseract. Hãy kiểm tra mạng rồi bấm Bắt đầu dịch lại.');}),tesseractCached()]).then(([module,cached])=>(module.createWorker||module.default.createWorker)(['chi_sim','eng'],1,{
   workerPath:'/vendor/tesseract.worker.min.js',
   corePath:'/vendor/tesseract-core',
   langPath:'/vendor/tessdata',
   logger:message=>{lastActivity=Date.now();downloading=/^loading /u.test(String(message?.status||''))&&Number(message?.progress)<1;progressListener(tesseractProgress(message,cached));}
  }));
  // A worker that arrives after the page gave up is closed at once.
  workerPromise=stallGuard(created,STALL_MS,'Không khởi động được bộ nhận dạng chữ Tesseract trên thiết bị (quá lâu không phản hồi).').catch(error=>{workerPromise=null;created.then(late=>late?.terminate(),()=>{});throw error;});
 }
 return workerPromise;
}

// A signal that aborts after `ms`. AbortSignal.timeout needs Safari 16 and the site runs from iOS/Safari 15.4, where an
// AbortController and a timer give the same signal; done() drops that timer once the request has settled.
export function timeoutSignal(ms){
 if(typeof AbortSignal.timeout==='function')return {signal:AbortSignal.timeout(ms),done(){}};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('Quá thời gian chờ máy chủ trả lời.','TimeoutError')),ms);
 return {signal:controller.signal,done:()=>clearTimeout(timer)};
}
// '' when this install serves PaddleOCR, else why not. An install without its models has no worker.js: the server
// answers 404 (a host that falls back to a page answers HTML), and that answer holds for the tab. A check without a
// clear answer (no connection, a server error, no answer within 15 s) counts for this page only and is asked again next time.
function paddleProblem(){
 installCheck??=Promise.resolve().then(()=>{const {signal,done}=timeoutSignal(15_000);return fetch(new URL('/vendor/paddle/worker.js',location.href),{method:'HEAD',cache:'no-store',signal}).finally(done);}).then(response=>{
  if(response.ok&&!/^text\/html/iu.test(response.headers.get('Content-Type')||''))return '';
  if(response.ok||[404,410].includes(response.status))return NOT_INSTALLED;
  installCheck=null;return `Máy chủ báo lỗi khi kiểm tra PaddleOCR (HTTP ${response.status}).`;
 },()=>{installCheck=null;return 'Không kiểm tra được PaddleOCR vì chưa kết nối được máy chủ.';});
 return installCheck;
}
export async function paddleInstalled(){return !await paddleProblem();}
// What the first local OCR of this tab downloads ({engine, mb}), and `cached`: this browser already keeps it, so nothing
// large is fetched (unknown counts as not kept).
export async function ocrDownload(){
 const paddle=!paddleUnavailable&&await paddleInstalled();
 return {...OCR_DOWNLOAD[paddle?'paddle':'tesseract'],cached:await (paddle?paddleCached():tesseractCached())};
}
// The line each document shows while Tesseract reads its scans in place of PaddleOCR.
export function fallbackNotice(reason){
 const text=String(reason||'').trim();
 return `Nhận dạng chữ trên thiết bị dùng Tesseract thay cho PaddleOCR.${text?` ${text}${/[.!?…]$/u.test(text)?'':'.'}`:''}`;
}

// An install without PaddleOCR goes straight to Tesseract, without starting a worker. Every Tesseract result carries
// the reason (fallbackReason) while PaddleOCR is unavailable, so each document can say why; the status line hears it
// (status 'fallback') once per document.
export async function recognizeChinesePage(blob,onProgress=()=>{}){
 progressListener=onProgress;
 let reason=paddleUnavailable||await paddleProblem();
 if(!reason){
  try{
   const layout=normalizeOcrLayout(await recognizePaddle(blob,onProgress));paddleTimeouts=0;
   return {...assessLocalOcr(layout,{preserveNumbers:true}),layout,engine:'paddle',metrics:layout.metrics};
  }catch(error){
   terminatePaddle();reason=String(error?.message||'').trim()||'PaddleOCR không chạy được.';
   if(reason!==PADDLE_TIMEOUT||++paddleTimeouts>=2)paddleUnavailable=reason;
  }
 }
 if(reason!==announced){announced=reason;onProgress({status:'fallback',engine:'tesseract',reason});}
 return {...await recognizeTesseractPage(blob,onProgress),fallbackReason:reason};
}

// Tesseract reads a page in one pass and may leave out a whole region (a white title on a band, a ruled table) or read
// it as a few Latin letters while still scoring 84-90%. The page's own ink says where Han glyphs stand (glyphRows): each
// region its lines do not read (unreadRegions) is read again on its own (light text on a dark band inverted first, a
// single row as one line) and replaces the lines in it when it reads more Han. The Han of a region still unread
// (missedCells) sends the page to Gemini where the Cách dịch allows (needsGemini) and is named in a note.
export async function recognizeTesseractPage(blob,onProgress=()=>{}){
 progressListener=onProgress;
 const active=await worker();
 const started=performance.now();
 const result=await stallGuard(active.recognize(blob,{
  preserve_interword_spaces:'1',
  tessedit_pageseg_mode:'3'
 },{blocks:true,text:true}),STALL_MS*2,'Bộ nhận dạng chữ Tesseract không phản hồi khi đọc trang này.');
 const bitmap=await createImageBitmap(blob);let layout=tesseractLayout(result.data,bitmap.width,bitmap.height),missedCells=0;
 try{
  if(!layout.blocks.length)layout.text=result.data.text;
  const regions=await unreadRegions(bitmap,layout).catch(()=>[]),readings=[];
  for(const region of regions){
   // A reading counts when Tesseract trusts it, it holds Han for at least a third of the region's glyph cells (a
   // photograph read as text gives neither) and more than the lines in the region; the cells the better of the two
   // still lacks under three fifths of them count as missed.
   const {text,confidence}=await readRegion(active,bitmap,region).catch(()=>({text:'',confidence:0})),han=confidence>=50?hanCount(text):0,before=region.inside.reduce((sum,index)=>sum+hanCount(layout.blocks[index].text),0);
   if(han>before&&han>=Math.max(2,region.cells/3))readings.push({text,region});
   if(Math.max(han,before)<region.cells*.6)missedCells+=region.cells-Math.max(han,before);
  }
  if(readings.length)layout=withReadings(layout,readings);
 }finally{bitmap.close();}
 layout.confidence=result.data.confidence;layout.metrics={totalMs:performance.now()-started};
 const assessment=assessLocalOcr(layout,{preserveNumbers:true});
 return {...assessment,needsGemini:assessment.needsGemini||missedCells>0,missedCells,layout,engine:'tesseract',metrics:layout.metrics};
}
// What a note says of a page whose Han Tesseract could not read in places (missedCells), before what was done about it.
export const missedNotice=cells=>`nhận dạng chữ trên thiết bị (Tesseract) bỏ sót khoảng ${cells} chữ ở dải màu, bảng hoặc tiêu đề lớn`;
const surface=(width,height)=>typeof OffscreenCanvas==='function'?new OffscreenCanvas(width,height):Object.assign(document.createElement('canvas'),{width,height});
const hanCount=text=>(String(text||'').match(/\p{Script=Han}/gu)||[]).length;
// The regions of Han glyphs in a page image its layout does not read, at about 1000 px wide (about 1.7 px/pt for an A4
// page drawn by uploadOptimizedScan): rows of glyph cells (glyphRows) over which its lines hold Han for under half the
// cells (no line, a heading read as Latin letters, a few characters of a table row), grouped as OCR reads them, each
// with the lines whose middle stands in it (inside: their indices).
async function unreadRegions(bitmap,layout){
 const ratio=Math.min(1,1000/bitmap.width),width=Math.max(1,Math.round(bitmap.width*ratio)),height=Math.max(1,Math.round(bitmap.height*ratio));
 const canvas=surface(width,height),context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0,width,height);
 const {data}=context.getImageData(0,0,width,height),gray=new Uint8Array(width*height);
 for(let i=0,p=0;p<gray.length;i+=4,p++)gray[p]=(299*data[i]+587*data[i+1]+114*data[i+2])/1000|0;
 const lines=layout.blocks.map(({box,text})=>({x0:box.x*width,x1:(box.x+box.width)*width,y0:box.y*height,y1:(box.y+box.height)*height,han:hanCount(text)}));
 const read=row=>lines.filter(line=>line.x0<row.x1&&line.x1>row.x0&&Math.min(line.y1,row.y1)-Math.max(line.y0,row.y0)>=.5*Math.min(row.y1-row.y0,line.y1-line.y0)).reduce((sum,line)=>sum+line.han,0);
 return glyphRegions(glyphRows(gray,width,height,{scale:width/600}).filter(row=>read(row)<row.cells/2),width,height).map(region=>{
  const {x,y,width:w,height:h}=region.box;
  return {...region,inside:lines.flatMap((line,index)=>{const cx=(line.x0+line.x1)/2/width,cy=(line.y0+line.y1)/2/height;return cx>=x&&cx<=x+w&&cy>=y&&cy<=y+h?[index]:[];})};
 });
}
// One region read again by Tesseract from the full-size page: a single row as one line (PSM 7), several as a block.
async function readRegion(active,bitmap,{box,light,em}){
 const x=Math.floor(box.x*bitmap.width),y=Math.floor(box.y*bitmap.height),width=Math.max(1,Math.ceil(box.width*bitmap.width)),height=Math.max(1,Math.ceil(box.height*bitmap.height));
 const canvas=surface(width,height),context=canvas.getContext('2d',{willReadFrequently:true});
 context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,x,y,width,height,0,0,width,height);
 if(light){const pixels=context.getImageData(0,0,width,height);for(let i=0;i<pixels.data.length;i+=4)for(let k=0;k<3;k++)pixels.data[i+k]=255-pixels.data[i+k];context.putImageData(pixels,0,0);}
 const crop=canvas.convertToBlob?await canvas.convertToBlob({type:'image/png'}):await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
 const result=await stallGuard(active.recognize(crop,{preserve_interword_spaces:'1',tessedit_pageseg_mode:box.height>em*2.6?'6':'7'},{text:true}),STALL_MS,'Bộ nhận dạng chữ Tesseract không phản hồi khi đọc trang này.');
 return {text:String(result.data.text||'').trim(),confidence:Number(result.data.confidence)||0};
}
// The layout with the regions read again set in as lines of their own, each row in its share of its region, in place
// of the lines that stood in them.
function withReadings(layout,readings){
 const corners=({x,y,width,height})=>[[x,y],[x+width,y],[x+width,y+height],[x,y+height]],replaced=new Set(readings.flatMap(({region})=>region.inside));
 const items=layout.blocks.filter((block,index)=>!replaced.has(index)).map(block=>({text:block.text,score:block.confidence/100,poly:corners(block.box),...(block.sourceParagraph!==undefined?{sourceParagraph:block.sourceParagraph}:{})}));
 readings.forEach(({text,region},index)=>{
  const rows=text.split(/\r?\n/u).map(line=>line.trim()).filter(Boolean),step=region.box.height/rows.length;
  rows.forEach((row,k)=>items.push({text:row,score:.7,sourceParagraph:`again-${index}`,poly:corners({...region.box,y:region.box.y+k*step,height:step})}));
 });
 return normalizeOcrLayout({image:{width:1,height:1},items},'tesseract');
}

// Never waits more than a few seconds: a worker still starting (or one whose wasm hung) is closed whenever it arrives,
// so the form is given back at once.
export async function terminateLocalOcr(){
 terminatePaddle();
 const pending=workerPromise;workerPromise=null;progressListener=()=>{};announced='';
 if(!pending)return;
 const settled=Symbol('waiting'),active=await Promise.race([pending.catch(()=>null),new Promise(resolve=>setTimeout(resolve,2000,settled))]);
 if(active===settled){pending.then(late=>late?.terminate(),()=>{});return;}
 if(active)await Promise.race([active.terminate(),new Promise(resolve=>setTimeout(resolve,2000))]).catch(()=>{});
}
