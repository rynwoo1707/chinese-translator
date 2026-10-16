import {PaddleOCR} from '@paddleocr/paddleocr-js';
import cvModule from '@techstark/opencv-js';

let engine;
// All assets are served by Hoa Trí. No image or key is sent to a model host.
async function cachedAssetFetch(input,options){
 const request=new Request(input,options);
 if(!request.url.startsWith(new URL('/vendor/paddle/models/',self.location.href).href))return fetch(request);
 const cache=typeof caches==='undefined'?null:await caches.open('hoa-tri-paddle-v5-0.4.2').catch(()=>null);
 const hit=await cache?.match(request).catch(()=>null);if(hit)return hit;
 const response=await fetch(request);if(response.ok)await cache?.put(request,response.clone()).catch(()=>{});return response;
}
self.onmessage=async({data:{id,blob}})=>{
 let bitmap,mat;
 try{
  if(!engine){
   self.postMessage({id,status:'loading model',progress:0});
   engine=await PaddleOCR.create({
    worker:false,
    textDetectionModelName:'PP-OCRv5_mobile_det',textRecognitionModelName:'PP-OCRv5_mobile_rec',
    textDetectionModelAsset:{url:new URL('/vendor/paddle/models/det.tar',self.location.href).href},
    textRecognitionModelAsset:{url:new URL('/vendor/paddle/models/rec.tar',self.location.href).href},
    textRecognitionBatchSize:6,
    ortOptions:{backend:'wasm',wasmPaths:new URL('/vendor/paddle/',self.location.href).href,numThreads:1,proxy:false},
    fetch:cachedAssetFetch
   });
  }
  self.postMessage({id,status:'recognizing text',progress:0});
  bitmap=await createImageBitmap(blob);
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(bitmap,0,0);
  const cv=cvModule instanceof Promise?await cvModule:cvModule;
  mat=cv.matFromImageData(context.getImageData(0,0,bitmap.width,bitmap.height));
  // cv.Mat is a supported SDK input and avoids DOM-only canvas APIs in a Worker.
  const [result]=await engine.predict(mat,{textDetLimitSideLen:1600,textDetLimitType:'max',textRecScoreThresh:0});
  self.postMessage({id,result});
 }catch(error){self.postMessage({id,error:error?.message||'Không khởi tạo được PaddleOCR.'});}
 finally{mat?.delete();bitmap?.close();}
};
