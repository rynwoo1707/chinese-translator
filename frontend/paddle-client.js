// Isolate expensive inference from the UI; failure frees the worker before fallback.
let active=null,requestId=0;
const pending=new Map();
function dispose(error=new Error('Đã đóng OCR cục bộ.')){active?.terminate();active=null;for(const job of pending.values()){clearTimeout(job.timer);job.reject(error);}pending.clear();}
function worker(){
 if(!active){
  active=new Worker('/vendor/paddle/worker.js',{type:'module'});
  active.onmessage=({data})=>{const job=pending.get(data.id);if(!job)return;if(data.status){job.progress(data);return;}clearTimeout(job.timer);pending.delete(data.id);if(data.error)job.reject(new Error(data.error));else job.resolve(data.result);};
  active.onerror=()=>dispose(new Error('Trình duyệt không khởi chạy được PaddleOCR.'));
  active.onmessageerror=()=>dispose(new Error('Không đọc được kết quả PaddleOCR.'));
 }
 return active;
}
export function recognizePaddle(blob,progress=()=>{}){
 return new Promise((resolve,reject)=>{const id=++requestId;try{const target=worker();const timer=setTimeout(()=>dispose(new Error('PaddleOCR quá thời gian xử lý trang.')),180_000);pending.set(id,{resolve,reject,progress,timer});target.postMessage({id,blob});}catch(error){pending.delete(id);reject(error);}});
}
export function terminatePaddle(){dispose();}
