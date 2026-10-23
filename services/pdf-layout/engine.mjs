import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import puppeteer from 'puppeteer-core';
import {validateLayoutDocument,validateBlockTranslations,pageHtml,prepareLayout,fitTextBoxes,pageVersion} from '../../frontend/pdf-box-layout.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const STDOUT_LIMIT=100*1024*1024,STDERR_TAIL=16*1024,TIMEOUT_MS=240000;
// A failed job says what kind of failure it was (error.code), so the service can answer with it and the Worker can tell
// the student's browser whether waiting, fewer pages or nothing will help:
//  timeout    the job ran past its time;          memory  the process ran out of memory (or was killed for it);
//  too_large  its result was over the size limit;  crash   the process died for another reason;
//  aborted    the caller left (or the job was stopped), so nobody waits for an answer.
//  browser    the export's browser did not start (the service, not the document, needs looking at);
//  font       the export font is missing or unreadable (the service again);
//  overflow   a translation is longer than its box (error.blocks names the boxes; see overflowError).
// Other failures (a damaged PDF, "Trang 3: …") carry no code. cause keeps the original error for the service's log.
const failure=(message,code,cause)=>Object.assign(new Error(message,cause?{cause}:undefined),code?{code}:{});
// A job stopped by its signal: by a deadline (AbortSignal.timeout) or by the caller.
export function stopError(signal,message='Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.'){
 return signal?.reason?.name==='TimeoutError'?failure(message,'timeout'):failure('Dịch vụ PDF đã dừng việc này vì yêu cầu bị hủy.','aborted');
}
// MuPDF's embedded Tesseract prints these on every OCR call; they never explain a failure. Not anchored, so the
// fragment left at the start of a trimmed stderr tail is recognised too.
const TESSERACT_NOISE=[/Warning: Parameter not found:/u,/Error opening data file .*\.traineddata/u,/Please make sure the TESSDATA_PREFIX environment variable is set/u,/Failed loading language '/u,/Image too small to scale!!/u,/Line cannot be recognized!!/u,/Empty page!!/u,/Estimating resolution as \d+/u,/Tesseract couldn't load any languages!/u,/Could not initiali[sz]e tesseract/iu];
export const withoutTesseractNoise=text=>String(text||'').split(/\r?\n/u).map(line=>line.trimEnd()).filter(line=>line.trim()&&!TESSERACT_NOISE.some(pattern=>pattern.test(line))).join('\n');
// Keeps the last `limit` characters of stderr, starting at a line boundary so no half line is kept.
export function stderrTail(text,limit=STDERR_TAIL){
 if(text.length<=limit)return text;
 const tail=text.slice(-limit),newline=tail.indexOf('\n');
 return newline>=0?tail.slice(newline+1):tail;
}
export const PYTHON_SHORTCUT_MESSAGE='Máy chạy dịch vụ PDF chưa có Python thật: lệnh "python" đang mở lối tắt Microsoft Store. Cài Python 3 từ python.org (tích "Add python.exe to PATH"), mở cửa sổ terminal mới, chạy "npm run setup" rồi khởi động lại Hoa Trí ("npm start", hoặc bấm đúp start.cmd).';
const WINDOWS_CRASHES={0xC0000005:'lỗi truy cập bộ nhớ',0xC00000FD:'tràn ngăn xếp',0xC0000409:'thư viện dừng khẩn cấp',0xC0000374:'hỏng vùng nhớ heap',0xC0000017:'hết bộ nhớ',0xC000013A:'bị ngắt'};
// Any NTSTATUS error code (0xC0000000 and above) means the process crashed, even when the code is not in the list.
const windowsCrash=code=>typeof code==='number'&&(code>>>0)>=0xC0000000?WINDOWS_CRASHES[code>>>0]||'lỗi hệ thống':null;

// extract.py's answer to a MemoryError (user_message), and what Python prints last when it dies of one.
const OUT_OF_MEMORY=/Không đủ bộ nhớ|(?:^|\s)MemoryError\b/u;
// One short sentence for the student, whatever way the Python process ended, and the kind of failure (see failure()).
export function pythonFailure({code=null,signal=null,stdout='',stderr='',killedForSize=false,timedOut=false}={}){
 if(timedOut)return {message:'Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.',code:'timeout'};
 if(killedForSize)return {message:'Kết quả tách PDF vượt giới hạn dung lượng của dịch vụ. Hãy chọn ít trang hơn cho mỗi lượt.',code:'too_large'};
 try{const parsed=JSON.parse(String(stdout).trim());if(parsed&&typeof parsed.error==='string'&&parsed.error.trim()){const message=parsed.error.trim().slice(0,500);return {message,code:OUT_OF_MEMORY.test(message)?'memory':null};}}catch{}
 // 9009: Windows ran the Microsoft Store "python" shortcut (no real Python); its localized text is not UTF-8.
 if(code===9009)return {message:PYTHON_SHORTCUT_MESSAGE,code:null};
 const crash=windowsCrash(code);
 // A container's memory limit ends a process with SIGKILL; Windows reports 0xC0000017.
 if(crash||signal)return {message:`Dịch vụ PDF dừng đột ngột khi xử lý các trang đã chọn (${crash?`mã 0x${(code>>>0).toString(16).toUpperCase()}: ${crash}`:`tín hiệu ${signal}${signal==='SIGKILL'?', có thể do hết bộ nhớ':''}`}). Hãy thử lại với ít trang hơn; nếu vẫn lỗi, hãy kiểm tra tệp PDF.`,code:signal==='SIGKILL'||(code>>>0)===0xC0000017?'memory':'crash'};
 const last=withoutTesseractNoise(stderr).split('\n').filter(Boolean).at(-1);
 return last?{message:`Dịch vụ PDF gặp lỗi: ${last.slice(0,300)}`,code:OUT_OF_MEMORY.test(last)?'memory':null}:{message:`Không chạy được PyMuPDF (mã thoát ${code}).`,code:null};
}
export const pythonFailureMessage=outcome=>pythonFailure(outcome).message;

// allPages: the caller wants every page or none (a refresh replaces a stored range whole), so extract.py may use the whole
// time limit instead of stopping at its own budget (PDF_EXTRACT_SECONDS) with the pages done so far; the margin is left
// for writing the answer.
const ALL_PAGES_MARGIN_S=15;
const extractSeconds=(allPages,timeoutMs)=>allPages?{PDF_EXTRACT_SECONDS:String(Math.max(1,Math.floor(timeoutMs/1000)-ALL_PAGES_MARGIN_S))}:{};
// Runs extract.py with payload as JSON on stdin and returns its JSON answer. signal stops it at once: the caller left,
// or a deadline of the whole job passed (renderDocument). command and args replace Python and extract.py (tests).
export function pythonOperation(payload,{signal,timeoutMs=TIMEOUT_MS,command,args,allPages=false}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(stopError(signal));
  const python=command||process.env.PDF_PYTHON||'python';
  let child;
  // PYMUPDF_MESSAGE=fd:2 keeps MuPDF messages (also those printed while PyMuPDF imports) off the JSON stdout.
  // Some misconfigured PDF_PYTHON values make spawn() throw instead of emitting 'error'.
  try{child=spawn(python,args||[fileURLToPath(new URL('./extract.py',import.meta.url))],{windowsHide:true,env:{...process.env,PYTHONPATH:[`${root}.runtime/pdf-python`,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',PYMUPDF_MESSAGE:'fd:2',...(process.env.TESSDATA_PREFIX?{}:existsSync(`${root}.runtime/tessdata`)?{TESSDATA_PREFIX:`${root}.runtime/tessdata`}:{}),...extractSeconds(allPages,timeoutMs)},stdio:['pipe','pipe','pipe']});}
  catch(error){reject(new Error(`Không khởi động được PyMuPDF (${python}): ${error.message}. Hãy kiểm tra PDF_PYTHON hoặc chạy npm run setup.`));return;}
  const chunks=[];let size=0,stderr='',killedForSize=false,timedOut=false,settled=false;
  // Python never handles SIGTERM, so the kill ends it even inside MuPDF or Tesseract.
  const stop=()=>{child.kill();finish(stopError(signal));};
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{timedOut=true;child.kill();const outcome=pythonFailure({timedOut});finish(failure(outcome.message,outcome.code));},timeoutMs);
  signal?.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',chunk=>{if(killedForSize)return;size+=chunk.length;if(size>STDOUT_LIMIT){killedForSize=true;chunks.length=0;child.kill();return;}chunks.push(chunk);});
  // Only a bounded tail is kept: a 20-page scan used to accumulate hundreds of KB of OCR warnings here.
  child.stderr.on('data',chunk=>{stderr=stderrTail(stderr+chunk.toString('utf8'));});
  child.on('error',error=>finish(new Error(error.code==='ENOENT'?`Không tìm thấy Python để chạy dịch vụ PDF (${python}). Hãy cài Python hoặc đặt PDF_PYTHON.`:`Không khởi động được PyMuPDF: ${error.message}`)));
  child.on('close',(code,exitSignal)=>{
   if(settled)return;
   const stdout=Buffer.concat(chunks).toString('utf8');chunks.length=0;
   if(code===0&&!killedForSize){try{return finish(null,JSON.parse(stdout));}catch{return finish(new Error('PyMuPDF trả dữ liệu không hợp lệ.'));}}
   const outcome=pythonFailure({code,signal:exitSignal,stdout:killedForSize?'':stdout,stderr,killedForSize});
   console.error(`[pdf-layout] ${payload?.operation||'extract'} failed (code ${code}${exitSignal?`, ${exitSignal}`:''}): ${outcome.message}\n${withoutTesseractNoise(stderr).slice(-4000)}`);
   finish(failure(outcome.message,outcome.code));
  });
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
 });
}
export function chromiumPath(){
 if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;
 for(const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'])if(existsSync(path))return path;
 throw new Error('Thiếu Chromium. Đặt CHROMIUM_EXECUTABLE_PATH hoặc dùng Docker.');
}
// Every fit was tuned and checked with Times New Roman (Windows). Liberation Serif has the same advance widths and every
// Vietnamese letter (Debian fonts-liberation2, or fonts-liberation 1.x); DejaVu Serif, the old Linux default, sets the
// same text about 26% wider, so boxes shrink far more often. PDF_FONT_PATH (npm run setup writes it) always wins.
export const LINUX_FONTS=Object.freeze(['/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf','/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf']);
const fontsWanted=()=>process.env.PDF_FONT_PATH?[process.env.PDF_FONT_PATH]:process.platform==='win32'?['C:/Windows/Fonts/times.ttf']:LINUX_FONTS;
// null when the file is not there, so /health, the image build and CI never name a font the service cannot read.
export function fontPath(){return fontsWanted().find(path=>existsSync(path))||null;}
const FONT_MISSING='Dịch vụ PDF đang thiếu phông chữ để dựng bản PDF tiếng Việt, nên chưa xuất được PDF. Hãy báo quản trị viên; bản dịch vẫn được lưu trong Lịch sử dịch.';
// The same face for the export and for the browser preview (/font); built once per font file. A missing or unreadable
// file is the service's own problem (code font): the student is told so, the service's log names the files looked for.
let fontCache=null;
export async function fontCss(){
 const path=fontPath();if(path&&fontCache?.path===path)return fontCache.css;
 let font;
 try{if(!path)throw new Error(`no font file: ${fontsWanted().join(', ')}`);font=await readFile(path);}
 catch(error){throw failure(FONT_MISSING,'font',error);}
 const css=`@font-face{font-family:HoaTriPDF;src:url(data:font/ttf;base64,${font.toString('base64')}) format('truetype');font-weight:400;font-display:block}`;
 fontCache={path,css};return css;
}
// Edge on Windows (seen with 155, October 2026) restarts itself under its compatibility layer and the started process
// exits with code 0, which Puppeteer reports as "Failed to launch the browser process" while the real browser keeps
// running in the background. Playwright passes the same switch for Edge; Chrome and Chromium ignore it.
export const browserArgs=()=>['--edge-skip-compat-layer-relaunch',...(process.env.PDF_CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[])];
// The service's limit for a whole export, below the Worker's 280 s wait: past it the browser and the merge stop and the
// answer says so, instead of the job running on after the Worker has given up.
export const RENDER_DEADLINE_MS=250000;
const RENDER_TIMEOUT='Xuất PDF tiếng Việt vượt thời gian cho phép của dịch vụ. Hãy thử xuất lại sau ít phút; nếu vẫn lỗi, hãy báo quản trị viên.';
const BROWSER_DOWN='Dịch vụ PDF chưa mở được trình duyệt để dựng bản PDF tiếng Việt. Hãy thử xuất lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.';

// A box whose translation does not fit even at the smallest size (pdf-box-layout.js fitTextBoxes): the export is
// refused, since clipped or overlapping text is never exported. blocks: [{page,id,label}] for every such box of the
// document, label as the block editor of Xưởng dịch lists the blocks of a page (frontend/pdf-dual-viewer.js: the page's
// first block is "Đoạn 1"). The message names the ids, which the samples tool (texts.json) and the service's log use;
// the student reads overflowMessage(blocks) instead (server.mjs failureAnswer).
export const blockLabel=(entry,id)=>{const index=(entry?.blocks||[]).findIndex(b=>b.id===id);return index>=0?`Đoạn ${index+1}`:String(id);};
const byPage=blocks=>{const pages=new Map();for(const block of blocks)pages.set(block.page,[...(pages.get(block.page)||[]),block]);return pages;};
export function overflowError(blocks){
 const where=[...byPage(blocks)].map(([page,items])=>`Trang ${page}: chữ Việt không vừa box (${items.map(b=>b.id).join(', ')})`).join('; ');
 return Object.assign(new Error(`${where}, kể cả ở cỡ chữ nhỏ nhất. Hãy rút gọn bản dịch của các block này rồi xuất lại.`),{code:'overflow',blocks});
}
// What the student is told: which blocks, named in a sentence as everywhere in Xưởng dịch ("Trang 3 · đoạn 2", as the
// PDF view and the warnings write them), and the controls that fix them (study.html "Đối chiếu kết quả",
// pdf-dual-viewer.js "Chỉnh bản dịch từng đoạn" / "Lưu đoạn đã sửa", the "Xuất PDF tiếng Việt" button); a block's label
// ("Đoạn 2") only where it names the editor's option to pick. At most OVERFLOW_NAMED blocks are listed, so the text stays
// under the 600 characters the Worker passes on.
const OVERFLOW_NAMED=5;
const listVi=items=>items.length>1?`${items.slice(0,-1).join(', ')} và ${items.at(-1)}`:items[0];
const inSentence=({page,label})=>{const text=String(label);return `Trang ${page} · ${text.charAt(0).toLowerCase()}${text.slice(1)}`;};
export function overflowMessage(blocks){
 const pages=[...byPage(blocks)],shown=blocks.slice(0,OVERFLOW_NAMED),names=shown.map(inSentence),more=blocks.length-shown.length,others=more?` và ${more} đoạn khác`:'';
 const steps=(where,which)=>`Ở phần “Đối chiếu kết quả”, chuyển tới ${where}, mở “Chỉnh bản dịch từng đoạn”, chọn ${which}, viết ngắn lại, bấm “Lưu đoạn đã sửa” rồi bấm lại “Xuất PDF tiếng Việt”.`;
 if(pages.length===1){
  const [[page]]=pages;
  return `Bản dịch của ${more?`${names.join(', ')}${others}`:listVi(names)} dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức, nên chưa xuất được PDF tiếng Việt. ${steps(`Trang ${page}`,blocks.length===1?shown[0].label:'từng đoạn đó')}`;
 }
 return `Bản dịch của ${blocks.length} đoạn dài hơn khung chữ, kể cả khi đã thu nhỏ chữ hết mức, nên chưa xuất được PDF tiếng Việt: ${names.join(', ')}${others}. ${steps('từng trang đó','đoạn cần sửa')}`;
}
// Puppeteer's own failures in the middle of an export (the page's browser died, or one page took longer than its 30 s),
// told apart from the engine's errors, which already speak to the student and carry a code in words (a ProtocolError's
// code is a number).
const BROWSER_ERRORS=new Set(['ProtocolError','TargetCloseError','ConnectionClosedError']);
const browserBroke=error=>BROWSER_ERRORS.has(error?.name)||/\b(?:Target closed|Session closed|Protocol error|Page crashed|Connection closed|browser has disconnected)\b/iu.test(String(error?.message||''));
export function browserFailure(error,page){
 if(typeof error?.code==='string')return error;
 if(error?.name==='TimeoutError')return failure(RENDER_TIMEOUT,'timeout',error);
 if(browserBroke(error))return failure(`Trình duyệt của dịch vụ PDF dừng giữa chừng khi dựng trang ${page}. Hãy thử xuất lại sau ít phút; nếu lỗi kéo dài, hãy báo quản trị viên.`,'crash',error);
 return error;
}
// allowOverflow only serves previews (tools/samples render --preview-overflow): every page is drawn and the report
// still flags the boxes that do not fit. The service never passes it, so an export with overflow keeps failing; the
// remaining pages are still measured (not printed), so one answer names every box to shorten.
// signal (the caller left) and deadlineMs (0: none) stop the job: the browser is closed and the merge killed.
export async function renderDocument(document,translations,{title='Hoa Trí - Bản dịch tiếng Việt',allowOverflow=false,signal,deadlineMs=0}={}){
 validateLayoutDocument(document);const translated=validateBlockTranslations(document.pages.flatMap(p=>p.blocks),translations),css=await fontCss();
 const limits=[signal,deadlineMs>0?AbortSignal.timeout(deadlineMs):null].filter(Boolean),stop=limits.length>1?AbortSignal.any(limits):limits[0];
 const halted=()=>stopError(stop,RENDER_TIMEOUT);
 if(stop?.aborted)throw halted();
 // Puppeteer's launch error is English and names its troubleshooting page: the student gets one Vietnamese sentence,
 // the service's log the original (error.cause). A browser file that is not there is caught first: Puppeteer would
 // leave an empty profile folder in the temp directory behind on every such export.
 let browser;
 try{
  const executablePath=chromiumPath();if(!existsSync(executablePath))throw new Error(`Không có trình duyệt ở ${executablePath} (CHROMIUM_EXECUTABLE_PATH).`);
  browser=await puppeteer.launch({executablePath,headless:true,args:browserArgs()});
 }catch(error){if(stop?.aborted)throw halted();throw failure(BROWSER_DOWN,'browser',error);}
 // Closing the browser makes whatever the page is doing fail at once; it is closed once, whoever asks first.
 let closing=null,current=document.pages[0].number;const close=()=>closing??=browser.close().catch(()=>{});
 stop?.addEventListener('abort',close,{once:true});
 try{
  if(stop?.aborted)throw halted();
  const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',req=>req.url().startsWith('data:')||req.url()==='about:blank'?req.continue():req.abort());
  const rendered=[],reports=[],overflow=[];
  for(const entry of document.pages){
   current=entry.number;
   await page.setContent(pageHtml({...entry,extractionVersion:pageVersion(entry,document)},translated,css),{waitUntil:'load',timeout:30000});await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;})));});
   // Aligns older formula crops and measures free room around each box; fitting then grows boxes before shrinking.
   await page.evaluate(`(${prepareLayout.toString()})(document)`);
   const fit=await page.evaluate(`(${fitTextBoxes.toString()})(document)`);
   if(!allowOverflow)for(const box of fit)if(box.overflow)overflow.push({page:entry.number,id:box.id,label:blockLabel(entry,box.id)});
   if(overflow.length)continue;
   reports.push({page:entry.number,blocks:fit});rendered.push(Buffer.from(await page.pdf({preferCSSPageSize:true,printBackground:true,margin:{top:0,bottom:0,left:0,right:0}})).toString('base64'));
  }
  if(overflow.length)throw overflowError(overflow);
  const result=await pythonOperation({operation:'merge',pages:rendered,title:String(title).trim().slice(0,200)||'Hoa Trí - Bản dịch tiếng Việt'},{signal:stop});return {...result,report:reports};
 }catch(error){if(stop?.aborted)throw halted();throw browserFailure(error,current);}
 finally{stop?.removeEventListener('abort',close);await close();}
}
