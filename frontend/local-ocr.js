import {assessLocalOcr} from './ocr-policy.js';
import {normalizeOcrLayout,tesseractLayout} from './document-layout.js';
import {recognizePaddle,terminatePaddle} from './paddle-client.js';

let workerPromise=null;
let progressListener=()=>{};
let paddleUnavailable=false;

async function worker(){
 if(!workerPromise){
  workerPromise=import('/vendor/tesseract.esm.min.js').then(module=>(module.createWorker||module.default.createWorker)(['chi_sim','eng'],1,{
   workerPath:'/vendor/tesseract.worker.min.js',
   corePath:'/vendor/tesseract-core',
   langPath:'/vendor/tessdata',
   logger:message=>progressListener(message)
  })).catch(error=>{workerPromise=null;throw error;});
 }
 return workerPromise;
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
 const result=await active.recognize(blob,{
  preserve_interword_spaces:'1',
  tessedit_pageseg_mode:'3'
 },{blocks:true,text:true});
 const bitmap=await createImageBitmap(blob),layout=tesseractLayout(result.data,bitmap.width,bitmap.height);bitmap.close();
 if(!layout.blocks.length)layout.text=result.data.text;
 layout.confidence=result.data.confidence;layout.metrics={totalMs:performance.now()-started};
 return {...assessLocalOcr(layout,{preserveNumbers:true}),layout,engine:'tesseract',metrics:layout.metrics};
}

export async function terminateLocalOcr(){
 terminatePaddle();
 if(!workerPromise)return;
 const active=await workerPromise.catch(()=>null);
 workerPromise=null;
 progressListener=()=>{};
 if(active)await active.terminate();
}
