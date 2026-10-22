// Errors a page meets in a visitor's browser (a beacon in the pages): one log line each, so the operator learns that a
// page stopped working on some browser before anyone writes in. POST /api/client-error takes a small JSON body
//   {message, source?, page, browser?}
// message: the error text (cut at 300 characters); source: "<same-origin script path>:<line>[:<column>]" (a full
// address of this site is accepted and shortened to its path); page: location.pathname; browser: a family from
// BROWSER_FAMILIES, optionally with its major version ("safari 15"). No session is needed and none is read.
// The answer is always 204, whatever was sent: nothing tells a sender whether a report was kept. Kept reports are
// counted per network on API_LIMITER (key client-error:<network>) and logged as {event:'client_error',message,source,
// page,browser}, never with a cookie, an account, an address, a query string or a hash. A report that is not this shape,
// over 2 KB, sent by another site or for a script of another site (an extension, another domain) is dropped.
import {clientIp,logEvent} from './http.js';
import {limited} from './rate-limit.js';

export const CLIENT_ERROR_PATH='/api/client-error';
export const CLIENT_ERROR_LIMITS=Object.freeze({bytes:2048,message:300,path:200});
export const BROWSER_FAMILIES=Object.freeze(['chrome','edge','firefox','safari','samsung','opera','coccoc','zalo','facebook','other']);
const nothing=()=>new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});

// The body as text, or null past the byte limit (declared or counted while read) or when it is not UTF-8.
async function smallBody(request){
 const declared=request.headers.get('Content-Length');
 if(!request.body||declared!==null&&!(Number(declared)<=CLIENT_ERROR_LIMITS.bytes)){await request.body?.cancel().catch(()=>{});return null;}
 const reader=request.body.getReader(),chunks=[];let size=0;
 for(;;){
  const {done,value}=await reader.read();if(done)break;
  size+=value.byteLength;if(size>CLIENT_ERROR_LIMITS.bytes){await reader.cancel().catch(()=>{});return null;}
  chunks.push(value);
 }
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}
}
// What could name someone is taken out of the text before it is logged: the query and hash of any address (a reset
// link's token travels in a hash), e-mail addresses, and long tokens (keys, ids, hashes: 32 characters or more).
function scrub(text){
 return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu,' ')
  .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s?#'"<>()]*)[?#][^\s'"<>()]*/giu,'$1')
  .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu,'[email]')
  .replace(/[A-Za-z\d_-]{32,}/gu,'[…]')
  .replace(/\s+/gu,' ').trim();
}
const PATH=/^\/[A-Za-z\d._~%/-]*$/u;
// A same-origin path without its query and hash, or null.
function sitePath(value,origin){
 let path=String(value);if(path.startsWith(origin+'/'))path=path.slice(origin.length);
 path=path.replace(/[?#].*$/su,'');
 return path.length<=CLIENT_ERROR_LIMITS.path&&PATH.test(path)?path:null;
}
// "<path>:<line>[:<column>]" of a script of this site, or null (also for another site's script).
function scriptPlace(value,origin){
 const match=/^(.+?):(\d{1,7})(?::(\d{1,7}))?$/su.exec(String(value).trim());if(!match)return null;
 const path=sitePath(match[1],origin);return path?`${path}:${match[2]}${match[3]?`:${match[3]}`:''}`:null;
}
function browserOf(value){
 const match=/^([a-z]+)(?: (\d{1,3}))?$/u.exec(String(value??'').trim().toLowerCase());
 return match&&BROWSER_FAMILIES.includes(match[1])?match[0]:'other';
}
// The fields to log, or null when the report is to be dropped.
export function clientErrorReport(body,origin){
 if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.message!=='string'||typeof body.page!=='string')return null;
 const message=scrub(body.message).slice(0,CLIENT_ERROR_LIMITS.message).trim(),page=sitePath(body.page.trim(),origin);
 if(!message||!page)return null;
 let source=null;
 if(body.source!==undefined&&body.source!==null&&body.source!==''){source=typeof body.source==='string'?scriptPlace(body.source,origin):null;if(!source)return null;}
 // What a script of another site reports in place of its error: nothing to act on.
 else if(/^Script error\.?$/iu.test(message))return null;
 return {message,source,page,browser:browserOf(body.browser)};
}
export async function clientErrorRoute(request,env,url){
 try{
  const origin=request.headers.get('Origin');if(origin&&origin!==url.origin){await request.body?.cancel().catch(()=>{});return nothing();}
  const text=await smallBody(request);if(text===null)return nothing();
  let body;try{body=JSON.parse(text);}catch{return nothing();}
  const report=clientErrorReport(body,url.origin);if(!report)return nothing();
  if(await limited(env,'API_LIMITER',`client-error:${clientIp(request)}`))return nothing();
  logEvent('client_error',report);
 }catch{/* A report never fails the page that sent it. */}
 return nothing();
}
