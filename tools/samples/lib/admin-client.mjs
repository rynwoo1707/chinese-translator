// The Hoa Trí admin HTTP API as the /admin page uses it (Bearer ADMIN_TOKEN). The token goes to the target origin and
// nowhere else: no redirect is followed, and it is never printed or written to a file.
import {isPaidHost} from './guard.mjs';

export const LOCAL_TARGET='http://127.0.0.1:8787';
const LOCAL_HOSTS=new Set(['127.0.0.1','localhost','[::1]']);
const PLACEHOLDER='replace-with-a-long-random-secret';
export function resolveTarget(value='local'){
 const raw=value==='local'?LOCAL_TARGET:String(value||'');let url;
 try{url=new URL(raw);}catch{throw new Error(`Địa chỉ đăng "${raw.slice(0,80)}" không hợp lệ (dùng local, http://127.0.0.1:<cổng> hoặc https://<tên miền>).`);}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Địa chỉ đăng chỉ gồm giao thức, tên miền và cổng (không đường dẫn, không tên đăng nhập).');
 if(isPaidHost(url.hostname))throw new Error('Không đăng lên máy chủ của dịch vụ AI.');
 const local=LOCAL_HOSTS.has(url.hostname);
 if(!local&&url.protocol!=='https:')throw new Error('Máy chủ ngoài máy này phải dùng HTTPS để mã quản trị không bị lộ.');
 return {origin:url.origin,local};
}
// This machine's server: ADMIN_TOKEN of .dev.vars. Any other server: HOATRI_ADMIN_TOKEN or a hidden prompt, never
// .dev.vars, so a local token is never sent away.
export async function targetToken(target,{env=process.env,readDevToken,prompt}={}){
 let token;
 if(target.local){token=String(readDevToken?.()||'');if(!token||token===PLACEHOLDER||token.length<16)throw new Error('Chưa có ADMIN_TOKEN hợp lệ trong .dev.vars (chạy "npm run setup").');}
 else{token=String(env.HOATRI_ADMIN_TOKEN||'').trim()||(prompt?String(await prompt(`Mã quản trị (ADMIN_TOKEN) của ${target.origin}: `)).trim():'');if(!token)throw new Error(`Cần mã quản trị của ${target.origin}: đặt biến môi trường HOATRI_ADMIN_TOKEN hoặc nhập khi được hỏi.`);}
 if(/[\r\n\0]/u.test(token))throw new Error('Mã quản trị không hợp lệ.');
 return token;
}
export class AdminError extends Error{constructor(message,status){super(message);this.name='AdminError';this.status=status;}}
export function adminClient({origin,token,fetch:fetchImpl=(...args)=>globalThis.fetch(...args),timeout=180000}){
 // body and headers: a raw upload (the original PDF); json and form set their own content type.
 async function call(method,path,{json,form,body,headers:extra={},admin=true,bytes=false}={}){
  const url=new URL(path,origin);if(url.origin!==origin)throw new Error('Đường dẫn API không hợp lệ.');
  const headers={...extra,...(admin?{Authorization:`Bearer ${token}`}:{}),...(json!==undefined?{'Content-Type':'application/json'}:{})};
  let response;
  try{response=await fetchImpl(url.href,{method,headers,body:json!==undefined?JSON.stringify(json):form??body,redirect:'manual',signal:AbortSignal.timeout(timeout)});}
  catch(error){throw new AdminError(error?.name==='TimeoutError'?`${method} ${url.pathname}: ${origin} không trả lời sau ${timeout/1000} giây.`:`Không kết nối được ${origin} (${error.message}). Máy chủ đã chạy chưa?`,0);}
  if(response.status>=300&&response.status<400)throw new AdminError(`${origin} chuyển hướng yêu cầu (mã ${response.status}); hãy dùng đúng địa chỉ gốc của trang.`,response.status);
  if(bytes){if(!response.ok)throw new AdminError(`${method} ${url.pathname}: mã ${response.status}.`,response.status);return {type:response.headers.get('Content-Type')||'',data:new Uint8Array(await response.arrayBuffer())};}
  const text=await response.text();let data=null;try{data=text?JSON.parse(text):null;}catch{}
  if(!response.ok)throw new AdminError(`${method} ${url.pathname}: ${typeof data?.error==='string'?data.error:`mã ${response.status}`}`,response.status);
  if(data===null)throw new AdminError(`${method} ${url.pathname}: máy chủ không trả JSON (có đúng là Hoa Trí không?).`,response.status);
  return data;
 }
 return {origin,call};
}
