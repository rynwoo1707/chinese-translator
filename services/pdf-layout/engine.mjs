import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import puppeteer from 'puppeteer-core';
import {validateLayoutDocument,validateBlockTranslations,pageHtml,prepareLayout,fitTextBoxes,pageVersion} from '../../frontend/pdf-box-layout.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const STDOUT_LIMIT=100*1024*1024,STDERR_TAIL=16*1024,TIMEOUT_MS=240000;
// MuPDF's embedded Tesseract prints these on every OCR call; they never explain a failure.
const TESSERACT_NOISE=[/^Warning: Parameter not found:/u,/^Error opening data file .*\.traineddata$/u,/^Please make sure the TESSDATA_PREFIX environment variable is set/u,/^Failed loading language '/u,/^Image too small to scale!!/u,/^Line cannot be recognized!!/u,/^Empty page!!/u,/^Estimating resolution as \d+/u];
export const withoutTesseractNoise=text=>String(text||'').split(/\r?\n/u).map(line=>line.trimEnd()).filter(line=>line.trim()&&!TESSERACT_NOISE.some(pattern=>pattern.test(line.trim()))).join('\n');
export const PYTHON_SHORTCUT_MESSAGE='Máy chạy dịch vụ PDF chưa có Python thật: lệnh "python" đang mở lối tắt Microsoft Store. Cài Python 3 từ python.org (tích "Add python.exe to PATH"), mở cửa sổ terminal mới, chạy "npm run setup" rồi khởi động lại "npm run dev:pdf-layout".';
const WINDOWS_CRASHES={0xC0000005:'lỗi truy cập bộ nhớ',0xC00000FD:'tràn ngăn xếp',0xC0000409:'thư viện dừng khẩn cấp',0xC0000017:'hết bộ nhớ',0xC000013A:'bị ngắt'};

// One short sentence for the student, whatever way the Python process ended.
export function pythonFailureMessage({code=null,signal=null,stdout='',stderr='',killedForSize=false,timedOut=false}={}){
 if(timedOut)return 'Tách PDF vượt thời gian cho phép. Hãy chọn ít trang hơn cho mỗi lượt.';
 if(killedForSize)return 'Kết quả tách PDF vượt giới hạn dung lượng của dịch vụ. Hãy chọn ít trang hơn cho mỗi lượt.';
 try{const parsed=JSON.parse(String(stdout).trim());if(parsed&&typeof parsed.error==='string'&&parsed.error.trim())return parsed.error.trim().slice(0,500);}catch{}
 // 9009: Windows ran the Microsoft Store "python" shortcut (no real Python); its localized text is not UTF-8.
 if(code===9009)return PYTHON_SHORTCUT_MESSAGE;
 const crash=typeof code==='number'?WINDOWS_CRASHES[code>>>0]:null;
 if(crash||signal)return `Dịch vụ PDF dừng đột ngột khi xử lý các trang đã chọn (${crash?`mã 0x${(code>>>0).toString(16).toUpperCase()}: ${crash}`:`tín hiệu ${signal}${signal==='SIGKILL'?', có thể do hết bộ nhớ':''}`}). Hãy thử lại với ít trang hơn; nếu vẫn lỗi, hãy kiểm tra tệp PDF.`;
 const last=withoutTesseractNoise(stderr).split('\n').filter(Boolean).at(-1);
 return last?`Dịch vụ PDF gặp lỗi: ${last.slice(0,300)}`:`Không chạy được PyMuPDF (mã thoát ${code}).`;
}

export function pythonOperation(payload){
 return new Promise((resolve,reject)=>{
  const python=process.env.PDF_PYTHON||'python';
  const child=spawn(python,[fileURLToPath(new URL('./extract.py',import.meta.url))],{windowsHide:true,env:{...process.env,PYTHONPATH:[`${root}.runtime/pdf-python`,process.env.PYTHONPATH].filter(Boolean).join(process.platform==='win32'?';':':'),PYTHONUTF8:'1',...(process.env.TESSDATA_PREFIX?{}:existsSync(`${root}.runtime/tessdata`)?{TESSDATA_PREFIX:`${root}.runtime/tessdata`}:{})},stdio:['pipe','pipe','pipe']});
  const chunks=[];let size=0,stderr='',killedForSize=false,timedOut=false,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{timedOut=true;child.kill();finish(new Error(pythonFailureMessage({timedOut})));},TIMEOUT_MS);
  child.stdout.on('data',chunk=>{if(killedForSize)return;size+=chunk.length;if(size>STDOUT_LIMIT){killedForSize=true;chunks.length=0;child.kill();return;}chunks.push(chunk);});
  // Only a bounded tail is kept: a 20-page scan used to accumulate hundreds of KB of OCR warnings here.
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-STDERR_TAIL);});
  child.on('error',error=>finish(new Error(error.code==='ENOENT'?`Không tìm thấy Python để chạy dịch vụ PDF (${python}). Hãy cài Python hoặc đặt PDF_PYTHON.`:`Không khởi động được PyMuPDF: ${error.message}`)));
  child.on('close',(code,signal)=>{
   if(settled)return;
   const stdout=Buffer.concat(chunks).toString('utf8');
   if(code===0&&!killedForSize){try{return finish(null,JSON.parse(stdout));}catch{return finish(new Error('PyMuPDF trả dữ liệu không hợp lệ.'));}}
   const message=pythonFailureMessage({code,signal,stdout:killedForSize?'':stdout,stderr,killedForSize});
   console.error(`[pdf-layout] ${payload?.operation||'extract'} failed (code ${code}${signal?`, ${signal}`:''}): ${message}\n${withoutTesseractNoise(stderr).slice(-4000)}`);
   finish(new Error(message));
  });
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
 });
}
export function chromiumPath(){
 if(process.env.CHROMIUM_EXECUTABLE_PATH)return process.env.CHROMIUM_EXECUTABLE_PATH;
 for(const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/chromium-browser'])if(existsSync(path))return path;
 throw new Error('Thiếu Chromium. Đặt CHROMIUM_EXECUTABLE_PATH hoặc dùng Docker.');
}
export async function fontCss(){
 const path=process.env.PDF_FONT_PATH||(process.platform==='win32'?'C:/Windows/Fonts/times.ttf':'/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf');
 const font=await readFile(path);return `@font-face{font-family:HoaTriPDF;src:url(data:font/ttf;base64,${font.toString('base64')}) format('truetype');font-weight:400;font-display:block}`;
}
// allowOverflow only serves previews (tools/samples render --preview-overflow): every page is drawn and the report
// still flags the boxes that do not fit. The service never passes it, so an export with overflow keeps failing.
export async function renderDocument(document,translations,{title='Hoa Trí - Bản dịch tiếng Việt',allowOverflow=false}={}){
 validateLayoutDocument(document);const translated=validateBlockTranslations(document.pages.flatMap(p=>p.blocks),translations),css=await fontCss();
 const browser=await puppeteer.launch({executablePath:chromiumPath(),headless:true,args:process.env.PDF_CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[]});
 try{
  const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',req=>req.url().startsWith('data:')||req.url()==='about:blank'?req.continue():req.abort());
  const rendered=[],reports=[];
  for(const entry of document.pages){
   await page.setContent(pageHtml({...entry,extractionVersion:pageVersion(entry,document)},translated,css),{waitUntil:'load',timeout:30000});await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;})));});
   // Aligns older formula crops and measures free room around each box; fitting then grows boxes before shrinking.
   await page.evaluate(`(${prepareLayout.toString()})(document)`);
   const fit=await page.evaluate(`(${fitTextBoxes.toString()})(document)`);
   if(!allowOverflow&&fit.some(b=>b.overflow))throw new Error(`Trang ${entry.number}: chữ Việt không vừa box (${fit.filter(b=>b.overflow).map(b=>b.id).join(', ')}). Hãy rút gọn bản dịch hoặc điều chỉnh block trước khi xuất.`);
   reports.push({page:entry.number,blocks:fit});rendered.push(Buffer.from(await page.pdf({preferCSSPageSize:true,printBackground:true,margin:{top:0,bottom:0,left:0,right:0}})).toString('base64'));
  }
  const result=await pythonOperation({operation:'merge',pages:rendered,title:String(title).trim().slice(0,200)||'Hoa Trí - Bản dịch tiếng Việt'});return {...result,report:reports};
 }finally{await browser.close();}
}
