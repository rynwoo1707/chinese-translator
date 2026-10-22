// What every API response shares: JSON replies, security headers, request size and origin checks, and the one place
// that turns an exception into an answer for the browser.
const MB=1024*1024,KB=1024;
// A message written for the user; anything else that escapes a route is an internal error and is only logged.
// retryAfter (seconds, or null when unknown) tells the browser when trying again can work, e.g. a Gemini quota.
export class UserError extends Error{constructor(message,status=400,code,{retryAfter}={}){super(message);this.name='UserError';this.status=status;if(code)this.code=code;if(retryAfter!==undefined)this.retryAfter=retryAfter;}}
export const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
export const isLoopback=hostname=>['127.0.0.1','localhost','::1','[::1]'].includes(hostname);
// Hosts reached without TLS on purpose: wrangler dev on this machine, or from a phone on the same local network.
export function localHost(hostname){
 const host=String(hostname||'').toLowerCase().replace(/^\[|\]$/gu,'');
 return isLoopback(hostname)||/^(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^192\.168\.\d{1,3}\.\d{1,3}$|^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$|^169\.254\.\d{1,3}\.\d{1,3}$/u.test(host)||/^(?:fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/u.test(host)||/(?:^|\.)localhost$|\.local$/u.test(host);
}
// Plain http to a public host (Cloudflare's "Always Use HTTPS" switched off): a GET or HEAD is sent to https, anything
// else is refused rather than redirected, since its body (a password, a session cookie) has already crossed in clear.
export function insecureRequest(request,url){
 if(url.protocol!=='http:'||localHost(url.hostname))return null;
 if(['GET','HEAD'].includes(request.method)){const target=new URL(url.href);target.protocol='https:';target.port='';return new Response(null,{status:301,headers:{Location:target.href,'Cache-Control':'no-store'}});}
 return json({error:'Hoa Trí chỉ nhận thao tác này qua kết nối an toàn. Hãy mở trang bằng địa chỉ https:// rồi thử lại.',code:'https_required'},403);
}
// The eight 16-bit groups of an IPv6 address in any of its spellings, or null.
function ipv6Groups(text){
 let value=text.toLowerCase().replace(/%.*$/su,'').replace(/^\[|\]$/gu,'');
 const last=value.lastIndexOf(':'),v4=value.slice(last+1);
 if(v4.includes('.')){const bytes=v4.split('.');if(bytes.length!==4||bytes.some(byte=>!/^\d{1,3}$/u.test(byte)||Number(byte)>255))return null;const [a,b,c,d]=bytes.map(Number);value=`${value.slice(0,last+1)}${(a<<8|b).toString(16)}:${(c<<8|d).toString(16)}`;}
 const halves=value.split('::');if(halves.length>2)return null;
 const head=halves[0]?halves[0].split(':'):[],tail=halves[1]?halves[1].split(':'):[],missing=8-head.length-tail.length;
 if(![...head,...tail].every(group=>/^[\da-f]{1,4}$/u.test(group))||(halves.length===2?missing<1:missing!==0))return null;
 return [...head,...Array(halves.length===2?missing:0).fill('0'),...tail].map(group=>parseInt(group,16));
}
// What per-address limits count: an IPv4 address as it is, an IPv6 address by its /64 prefix. A home, phone or school
// network gets a whole /64, so counting single IPv6 addresses would let one network step past every limit.
export function addressKey(value){
 const text=String(value||'').trim(),groups=text.includes(':')?ipv6Groups(text):null;if(!groups)return text;
 if(groups.slice(0,5).every(group=>group===0)&&groups[5]===0xffff)return [groups[6]>>8,groups[6]&255,groups[7]>>8,groups[7]&255].join('.');
 return `${groups.slice(0,4).map(group=>group.toString(16)).join(':')}::/64`;
}
export const clientIp=request=>addressKey(request.headers.get('CF-Connecting-IP'))||'local';
// Ids and hashes are dropped from logged paths: a log line names the route, never a user's document.
export const routeLabel=path=>String(path||'').split('/').map(part=>/^[a-f\d-]{16,}$/iu.test(part)||/^\d+$/u.test(part)||part.length>40?':id':part).join('/');
// One JSON line per event, for Workers Logs. Callers pass names and short messages only: no headers, bodies or env.
export function logEvent(event,fields={}){try{console.error(JSON.stringify({event,...fields}));}catch{}}

const HEADERS={'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer'};
// API responses are data, never pages. PDFs get no CSP: a restrictive policy breaks the browser's built-in PDF viewer,
// and the library opens them in a same-origin frame (hence SAMEORIGIN rather than DENY).
const API_CSP="default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
function secure(headers){
 for(const [name,value] of Object.entries(HEADERS))headers.set(name,value);
 if(!headers.has('Cache-Control'))headers.set('Cache-Control','no-store');
 if(!/^application\/pdf/iu.test(headers.get('Content-Type')||'')&&!headers.has('Content-Security-Policy'))headers.set('Content-Security-Policy',API_CSP);
}
export function withSecurityHeaders(response){
 // Responses built here are mutable; redirects and fetched responses are not and are copied, every Set-Cookie included.
 try{secure(response.headers);return response;}
 catch{const copy=new Response(response.body,response);secure(copy.headers);return copy;}
}

// Bytes a request body may have, chosen per route before anything parses it (a 25 MB upload plus its form fields).
// A whole book's original is the one larger upload; it is streamed to storage, never held in memory.
export const SOURCE_MAX=100*MB;
export function bodyLimit(path,method='POST'){
 if(method==='PUT'&&/^\/api\/(?:my\/study|stories\/[^/]+)\/sources\/[^/]+$/u.test(path))return SOURCE_MAX;
 if(path.startsWith('/api/my/study/history'))return 32*MB;
 if(/^\/api\/(?:my\/study\/(?:pdf-layout\/)?extract|requests|jobs|import-preview|stories\/[^/]+\/chapters)$/u.test(path))return 26*MB;
 if(path==='/api/my/study/ocr'||/^\/api\/jobs\/[^/]+\/pdf-page$/u.test(path))return 4*MB;
 if(path.endsWith('/cover'))return 6*MB;
 if(path.startsWith('/api/auth/')||path==='/api/me')return 64*KB;
 return 8*MB;
}
const sizeLabel=bytes=>bytes>=MB?`${Math.round(bytes/MB)} MB`:`${Math.round(bytes/KB)} KB`;
const tooLargeMessage=max=>`Dữ liệu gửi lên quá lớn: tối đa ${sizeLabel(max)} cho thao tác này.`;
export const tooLarge=max=>json({error:tooLargeMessage(max),code:'too_large'},413);
// Returns a 413 answer, or the request to route plus exceeded(). A declared length is checked at once; a body sent
// without one (chunked) is counted while the route reads it, so it is never buffered past the limit either.
export function limitBody(request,path){
 const max=bodyLimit(path,request.method),none={request,max,exceeded:()=>false};
 if(['GET','HEAD'].includes(request.method)||!request.body)return none;
 const declared=request.headers.get('Content-Length');
 if(declared!==null)return Number(declared)>max?tooLarge(max):none;
 let seen=0,exceeded=false;
 const counter=new TransformStream({transform(chunk,controller){seen+=chunk.byteLength;if(seen>max){exceeded=true;controller.error(new UserError(tooLargeMessage(max),413,'too_large'));}else controller.enqueue(chunk);}});
 return {request:new Request(request,{body:request.body.pipeThrough(counter),duplex:'half'}),max,exceeded:()=>exceeded};
}
// Browsers send Origin with every non-GET request; another site's page must not act with the student's cookie.
export function crossOrigin(request,url){
 if(['GET','HEAD'].includes(request.method))return false;
 const origin=request.headers.get('Origin');return Boolean(origin)&&origin!==url.origin;
}
export const originRefused=()=>json({error:'Nguồn yêu cầu không hợp lệ.',code:'origin'},403);

// D1 and SQLite failures are plain Errors too; their text names tables and columns, so it is logged, never shown.
const INTERNAL=/D1_|SQLITE|no such (?:table|column)|constraint failed|FOREIGN KEY|syntax error/iu;
// Tokens a failed Gemini call had already spent (ai.js puts them on the error): Gemini bills them, so the browser adds
// them to the student's counter, which must never read low.
function spent(error){const usage=error?.usage;return usage&&typeof usage==='object'&&Object.values(usage).some(value=>Number(value)>0)?{usage}:{};}
export function errorResponse(error,{request,url,path,body}={}){
 // The runtime may wrap the counter's error while parsing, so the counter itself says whether the body was too large.
 if(body?.exceeded?.())return tooLarge(body.max);
 if(error instanceof UserError){
  const retry=error.retryAfter!==undefined?{retryAfter:error.retryAfter}:{};
  return json({error:error.message,...(error.code?{code:error.code}:{}),...retry,...spent(error)},error.status,error.retryAfter>0?{'Retry-After':String(error.retryAfter)}:{});
 }
 if(error?.name==='SyntaxError')return json({error:'Dữ liệu gửi lên không hợp lệ. Hãy tải lại trang rồi thử lại.',code:'invalid_body'},400);
 const message=String(error?.message||'');
 if(error?.constructor===Error&&message&&!INTERNAL.test(message))return json({error:message,...spent(error)},400);
 const ray=request?.headers.get('cf-ray')||crypto.randomUUID().slice(0,8);
 logEvent('api_error',{method:request?.method,route:routeLabel(path),name:error?.name||typeof error,message:message.slice(0,300),ray});
 // A database missing the newest migration fails every query naming a new column: say that instead of a bare error.
 if(/no such (?:table|column)/iu.test(message))return json({error:`Cơ sở dữ liệu chưa được cập nhật lên phiên bản mới${url&&isLoopback(url.hostname)?' (chạy npm run db:local rồi khởi động lại)':''}. Hãy báo quản trị viên, kèm mã ${ray}.`,code:'schema_outdated',ray,...spent(error)},500);
 return json({error:`Máy chủ gặp lỗi ngoài dự kiến. Hãy thử lại sau ít phút; nếu lỗi lặp lại, hãy gửi mã ${ray} cho quản trị viên.`,code:'internal',ray,...spent(error)},500);
}
