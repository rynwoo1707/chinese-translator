import {PaddleOCR} from '@paddleocr/paddleocr-js';
import cvModule from '@techstark/opencv-js';

let engine;
const MODELS=new URL('/vendor/paddle/models/',self.location.href).href,MODEL_FILES=['det.tar','rec.tar'];
const modelCache=()=>typeof caches==='undefined'?Promise.resolve(null):caches.open('hoa-tri-paddle-v5-0.4.2').catch(()=>null);
// Messages of our own (Vietnamese) pass through as they are; the SDK's are wrapped in one.
const failure=message=>Object.assign(new Error(message),{own:true});
// A model is a tar file: a page sent in its place (an HTML 404 or a host's fallback page) is never kept as one.
const isTar=bytes=>bytes.length>262&&String.fromCharCode(...bytes.subarray(257,262))==='ustar';
const isPage=response=>/^text\/html/iu.test(response.headers.get('Content-Type')||'');
// All assets are served by Hoa Trí. No image or key is sent to a model host. A model is kept in Cache Storage only once
// it is known to be one; a kept page (an older version kept any 200) is dropped and fetched again.
async function cachedAssetFetch(input,options){
 const request=new Request(input,options);
 if(!request.url.startsWith(MODELS))return fetch(request);
 const name=request.url.slice(MODELS.length),cache=await modelCache();
 const hit=await cache?.match(request).catch(()=>null);if(hit&&!isPage(hit))return hit;if(hit)await cache.delete(request).catch(()=>{});
 const response=await fetch(request).catch(()=>{throw failure(`Không tải được mô hình PaddleOCR ${name} (lỗi kết nối).`);});
 if([404,410].includes(response.status))throw failure(`Bản cài Hoa Trí này thiếu mô hình PaddleOCR (${name}: HTTP ${response.status}).`);
 if(!response.ok)throw failure(`Máy chủ chưa gửi được mô hình PaddleOCR ${name} (HTTP ${response.status}).`);
 const bytes=new Uint8Array(await response.arrayBuffer());
 if(isPage(response)||!isTar(bytes))throw failure(`Bản cài Hoa Trí này thiếu mô hình PaddleOCR (${name} không phải tệp mô hình).`);
 const model=()=>new Response(bytes,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/x-tar'}});
 await cache?.put(request,model()).catch(()=>{});return model();
}
// Whether both models are already in this browser, so starting PaddleOCR downloads nothing large.
async function modelsCached(){
 const cache=await modelCache();if(!cache)return false;
 return (await Promise.all(MODEL_FILES.map(file=>cache.match(MODELS+file).catch(()=>null)))).every(hit=>hit&&!isPage(hit));
}
self.onmessage=async({data:{id,blob}})=>{
 let bitmap,mat,stage='create';
 try{
  if(!engine){
   self.postMessage({id,status:'loading model',progress:0,cached:await modelsCached()});
   engine=await PaddleOCR.create({
    worker:false,
    textDetectionModelName:'PP-OCRv5_mobile_det',textRecognitionModelName:'PP-OCRv5_mobile_rec',
    textDetectionModelAsset:{url:MODELS+'det.tar'},
    textRecognitionModelAsset:{url:MODELS+'rec.tar'},
    textRecognitionBatchSize:6,
    ortOptions:{backend:'wasm',wasmPaths:new URL('/vendor/paddle/',self.location.href).href,numThreads:1,proxy:false},
    fetch:cachedAssetFetch
   });
  }
  stage='read';
  self.postMessage({id,status:'recognizing text',progress:0});
  bitmap=await createImageBitmap(blob);
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(bitmap,0,0);
  const cv=cvModule instanceof Promise?await cvModule:cvModule;
  mat=cv.matFromImageData(context.getImageData(0,0,bitmap.width,bitmap.height));
  // cv.Mat is a supported SDK input and avoids DOM-only canvas APIs in a Worker.
  const [result]=await engine.predict(mat,{textDetLimitSideLen:1600,textDetLimitType:'max',textRecScoreThresh:0});
  self.postMessage({id,result});
 }catch(error){
  const detail=String(error?.message||error||'').split('\n')[0].slice(0,300);
  self.postMessage({id,error:error?.own?error.message:stage==='create'?`Không khởi tạo được PaddleOCR${detail?` (${detail})`:''}.`:`PaddleOCR chưa đọc được trang này${detail?` (${detail})`:''}.`});
 }
 finally{mat?.delete();bitmap?.close();}
};
