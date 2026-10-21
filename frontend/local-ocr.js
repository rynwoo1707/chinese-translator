import {assessLocalOcr} from './ocr-policy.js';
import {normalizeOcrLayout,tesseractLayout} from './document-layout.js';
import {recognizePaddle,terminatePaddle} from './paddle-client.js';

let workerPromise=null;
let progressListener=()=>{};
let paddleUnavailable=false;
let lastActivity=0,importFailures=0,downloading=false;
// Tesseract says nothing while it downloads its core (3.9 MB) or the Chinese and English data (4.6 MB): during those
// phases the page waits up to DOWNLOAD_STALL_MS, so a slow but working download is not cut off. Any other silence of
// STALL_MS means its wasm never started, and the page gives up instead of waiting for ever.
export const STALL_MS=45_000,DOWNLOAD_STALL_MS=300_000;
// The first local OCR downloads PaddleOCR (engine and models, about 29 MB over the network); the browser keeps them.
export const DOWNLOAD_MB=29;
const PADDLE_CACHE='hoa-tri-paddle-v5-0.4.2';

// Rejects when `promise` has not settled and nothing reported progress for `ms`.
export function stallGuard(promise,ms=STALL_MS,message='Tesseract cục bộ không phản hồi.'){
 lastActivity=Date.now();downloading=false;
 return new Promise((resolve,reject)=>{
  const timer=setInterval(()=>{if(Date.now()-lastActivity>(downloading?Math.max(ms,DOWNLOAD_STALL_MS):ms)){clearInterval(timer);reject(Object.assign(new Error(message),{code:'ocr_stalled'}));}},Math.min(1000,ms));
  promise.then(value=>{clearInterval(timer);resolve(value);},error=>{clearInterval(timer);reject(error);});
 });
}

async function worker(){
 if(!workerPromise){
  // The browser remembers a module that failed to load; a retry asks for it under a new URL.
  const created=import(`/vendor/tesseract.esm.min.js${importFailures?`?retry=${importFailures}`:''}`).catch(()=>{importFailures++;throw new Error('Không tải được bộ nhận dạng chữ Tesseract. Hãy kiểm tra mạng rồi bấm Bắt đầu dịch lại.');}).then(module=>(module.createWorker||module.default.createWorker)(['chi_sim','eng'],1,{
   workerPath:'/vendor/tesseract.worker.min.js',
   corePath:'/vendor/tesseract-core',
   langPath:'/vendor/tessdata',
   logger:message=>{lastActivity=Date.now();downloading=/^loading /u.test(String(message?.status||''))&&Number(message?.progress)<1;progressListener(message);}
  }));
  // A worker that arrives after the page gave up is closed at once.
  workerPromise=stallGuard(created,STALL_MS,'Không khởi động được bộ nhận dạng chữ Tesseract trên thiết bị (quá lâu không phản hồi).').catch(error=>{workerPromise=null;created.then(late=>late?.terminate(),()=>{});throw error;});
 }
 return workerPromise;
}

// Whether the PaddleOCR models are already in this browser (nothing large to download). Unknown counts as not cached.
export async function localOcrCached(){
 try{const cache=await caches.open(PADDLE_CACHE);return Boolean(await cache.match(new URL('/vendor/paddle/models/rec.tar',location.href).href));}catch{return false;}
}

export async function recognizeChinesePage(blob,onProgress=()=>{}){
 progressListener=onProgress;
 let fallbackReason='';
 if(!paddleUnavailable){
  try{
   const layout=normalizeOcrLayout(await recognizePaddle(blob,onProgress));
   return {...assessLocalOcr(layout,{preserveNumbers:true}),layout,engine:'paddle',metrics:layout.metrics};
  }catch(error){paddleUnavailable=true;terminatePaddle();fallbackReason=error.message;onProgress({status:'fallback',engine:'tesseract',reason:fallbackReason});}
 }
 return {...await recognizeTesseractPage(blob,onProgress),fallbackReason};
}

export async function recognizeTesseractPage(blob,onProgress=()=>{}){
 progressListener=onProgress;
 const active=await worker();
 const started=performance.now();
 const result=await stallGuard(active.recognize(blob,{
  preserve_interword_spaces:'1',
  tessedit_pageseg_mode:'3'
 },{blocks:true,text:true}),STALL_MS*2,'Bộ nhận dạng chữ Tesseract không phản hồi khi đọc trang này.');
 const bitmap=await createImageBitmap(blob),layout=tesseractLayout(result.data,bitmap.width,bitmap.height);bitmap.close();
 if(!layout.blocks.length)layout.text=result.data.text;
 layout.confidence=result.data.confidence;layout.metrics={totalMs:performance.now()-started};
 return {...assessLocalOcr(layout,{preserveNumbers:true}),layout,engine:'tesseract',metrics:layout.metrics};
}

// Never waits more than a few seconds: a worker still starting (or one whose wasm hung) is closed whenever it arrives,
// so the form is given back at once.
export async function terminateLocalOcr(){
 terminatePaddle();
 const pending=workerPromise;workerPromise=null;progressListener=()=>{};
 if(!pending)return;
 const settled=Symbol('waiting'),active=await Promise.race([pending.catch(()=>null),new Promise(resolve=>setTimeout(resolve,2000,settled))]);
 if(active===settled){pending.then(late=>late?.terminate(),()=>{});return;}
 if(active)await Promise.race([active.terminate(),new Promise(resolve=>setTimeout(resolve,2000))]).catch(()=>{});
}
